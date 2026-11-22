// Automatic alignment ("Auto-Ausrichten") of one splat layer onto a reference
// layer, without anchor points and from any starting pose.
//
// 1. both clouds are normalised (robust centre, median radius), so the
//    descriptors compare at matching scale even when the scans differ in size
// 2. voxel downsampling, PCA normals, FPFH descriptors (33 bins, the classic
//    local surface signature of Rusu et al.)
// 3. mutual nearest descriptor matches -> RANSAC over triples with an edge
//    length consistency check, similarity (or rigid) transform per triple
// 4. the best distinct hypotheses are least-squares refined on their inliers,
//    rated by how much of the moving cloud lands on the reference surface,
//    then polished with the robust ICP (src/align/icp.ts)
//
// Pure math on Float32Array xyz triples (world space), runs in the analysis
// worker. The result is a world-space correction: newWorld = matrix * oldWorld.

import { downsample, Grid, refineAlignment, smallestEigenvector } from './icp';
import { alignPoints } from './point-align';

type AutoAlignOptions = {
    // solve uniform scale as well (default true)
    scale?: boolean,
    // max points per cloud for the descriptors (default 4000)
    maxPoints?: number,
    // RANSAC samples (default 60000)
    samples?: number,
    // polish the hypotheses with ICP (default true)
    refine?: boolean,
    onProgress?: (fraction: number) => void,
    shouldAbort?: () => boolean
};

type AutoCandidate = {
    // column-major 4x4 world correction
    matrix: number[],
    // how well the pose fits (0..1): geometric mean of the share of the
    // moving cloud on the reference surface and of the reference covered
    fitness: number,
    // share of the moving cloud on the reference surface (0..1)
    overlap: number,
    // rms distance of those points, world units
    rmse: number,
    scale: number,
    angleDeg: number
};

type AutoAlignResult = {
    // best first; further entries are clearly different alternatives
    candidates: AutoCandidate[],
    // the runner-up fits almost as well (symmetric or repetitive scenes)
    ambiguous: boolean,
    // tolerance used for fitness, world units
    tolerance: number,
    matches: number,
    aborted: boolean
};

// ---------------------------------------------------------------- matrices (column-major 4x4)

type M4 = number[];

const mul4 = (a: M4, b: M4): M4 => {
    const r = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
            r[c * 4 + row] = s;
        }
    }
    return r;
};

// x -> (x - c) / s and its inverse
const normalizer = (c: number[], s: number): M4 => [1 / s, 0, 0, 0, 0, 1 / s, 0, 0, 0, 0, 1 / s, 0, -c[0] / s, -c[1] / s, -c[2] / s, 1];
const denormalizer = (c: number[], s: number): M4 => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, c[0], c[1], c[2], 1];

const transform = (m: M4, p: Float32Array) => {
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    return out;
};

const scaleOf = (m: M4) => Math.cbrt(
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
);

const angleOf = (m: M4) => {
    const s = scaleOf(m);
    const c = Math.max(-1, Math.min(1, ((m[0] + m[5] + m[10]) / s - 1) / 2));
    return Math.acos(c) * 180 / Math.PI;
};

// rotation angle between two transforms' linear parts
const angleBetween = (a: M4, b: M4) => {
    const sa = scaleOf(a), sb = scaleOf(b);
    // trace(Ra^T Rb)
    let tr = 0;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) tr += a[c * 4 + r] * b[c * 4 + r];
    const cos = Math.max(-1, Math.min(1, (tr / (sa * sb) - 1) / 2));
    return Math.acos(cos) * 180 / Math.PI;
};

// ---------------------------------------------------------------- helpers

// deterministic random numbers, so a run is reproducible
const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// robust centre (per-axis median) and size (median distance to it)
const frameOf = (p: Float32Array) => {
    const n = p.length / 3;
    const stride = Math.max(1, Math.floor(n / 40000));
    const axes: number[][] = [[], [], []];
    for (let i = 0; i < n; i += stride) for (let k = 0; k < 3; k++) axes[k].push(p[i * 3 + k]);
    const centre = axes.map((a) => {
        const s = a.slice().sort((x, y) => x - y);
        return s[s.length >> 1];
    });
    const d: number[] = [];
    for (let i = 0; i < axes[0].length; i++) d.push(Math.hypot(axes[0][i] - centre[0], axes[1][i] - centre[1], axes[2][i] - centre[2]));
    d.sort((x, y) => x - y);
    return { centre, size: Math.max(d[d.length >> 1], 1e-9) };
};

// normals from PCA, oriented towards the cloud centre (the origin after
// normalisation); points without a usable neighbourhood are dropped
const withNormals = (points: Float32Array, colors: Float32Array | null, radius: number) => {
    const grid = new Grid(points, radius);
    const n = points.length / 3;
    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    const nb: number[] = [];
    for (let i = 0; i < n; i++) {
        const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
        grid.within(x, y, z, radius, nb);
        if (nb.length < 6) continue;
        let mx = 0, my = 0, mz = 0;
        for (const j of nb) {
            mx += points[j * 3]; my += points[j * 3 + 1]; mz += points[j * 3 + 2];
        }
        mx /= nb.length; my /= nb.length; mz /= nb.length;
        const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (const j of nb) {
            const ex = points[j * 3] - mx, ey = points[j * 3 + 1] - my, ez = points[j * 3 + 2] - mz;
            c[0] += ex * ex; c[1] += ex * ey; c[2] += ex * ez;
            c[4] += ey * ey; c[5] += ey * ez; c[8] += ez * ez;
        }
        c[3] = c[1]; c[6] = c[2]; c[7] = c[5];
        let [nx, ny, nz] = smallestEigenvector(c);
        if (nx * -x + ny * -y + nz * -z < 0) {
            nx = -nx; ny = -ny; nz = -nz;
        }
        pos.push(x, y, z);
        nor.push(nx, ny, nz);
        if (colors) col.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    }
    return { pos: new Float32Array(pos), nor: new Float32Array(nor), col: colors ? new Float32Array(col) : null };
};

const BINS = 11;
const DIM = BINS * 3;

// features in 0..1
const bin = (v: number) => Math.max(0, Math.min(BINS - 1, Math.floor(v * BINS)));

// fast point feature histograms
const fpfh = (pos: Float32Array, nor: Float32Array, radius: number) => {
    const n = pos.length / 3;
    const grid = new Grid(pos, radius);
    const spfh = new Float32Array(n * DIM);
    const neighbours: Int32Array[] = new Array(n);
    const nb: number[] = [];
    for (let i = 0; i < n; i++) {
        grid.within(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], radius, nb);
        const list = nb.filter(j => j !== i);
        neighbours[i] = Int32Array.from(list);
        if (!list.length) continue;
        const o = i * DIM;
        for (const j of list) {
            let dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
            const d = Math.hypot(dx, dy, dz);
            if (d < 1e-12) continue;
            dx /= d; dy /= d; dz /= d;
            let ux = nor[i * 3], uy = nor[i * 3 + 1], uz = nor[i * 3 + 2];
            let tx = nor[j * 3], ty = nor[j * 3 + 1], tz = nor[j * 3 + 2];
            // source = the point whose normal is closer to the connecting line
            if (Math.abs(ux * dx + uy * dy + uz * dz) < Math.abs(tx * dx + ty * dy + tz * dz)) {
                [ux, uy, uz, tx, ty, tz] = [tx, ty, tz, ux, uy, uz];
                dx = -dx; dy = -dy; dz = -dz;
            }
            // darboux frame u, v, w
            let vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
            const vl = Math.hypot(vx, vy, vz);
            if (vl < 1e-9) continue;
            vx /= vl; vy /= vl; vz /= vl;
            const wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx;
            const alpha = (vx * tx + vy * ty + vz * tz + 1) * 0.5;
            const phi = (ux * dx + uy * dy + uz * dz + 1) * 0.5;
            const theta = (Math.atan2(wx * tx + wy * ty + wz * tz, ux * tx + uy * ty + uz * tz) / Math.PI + 1) * 0.5;
            spfh[o + bin(alpha)]++;
            spfh[o + BINS + bin(phi)]++;
            spfh[o + 2 * BINS + bin(theta)]++;
        }
        const scale = 100 / list.length;
        for (let k = 0; k < DIM; k++) spfh[o + k] *= scale;
    }
    const out = new Float32Array(n * DIM);
    for (let i = 0; i < n; i++) {
        const o = i * DIM;
        for (let k = 0; k < DIM; k++) out[o + k] = spfh[o + k];
        const list = neighbours[i];
        let wsum = 0;
        const acc = new Float32Array(DIM);
        for (let q = 0; q < list.length; q++) {
            const j = list[q];
            const w = 1 / Math.max(Math.hypot(pos[j * 3] - pos[i * 3], pos[j * 3 + 1] - pos[i * 3 + 1], pos[j * 3 + 2] - pos[i * 3 + 2]), 1e-9);
            wsum += w;
            for (let k = 0; k < DIM; k++) acc[k] += w * spfh[j * DIM + k];
        }
        if (wsum > 0) for (let k = 0; k < DIM; k++) out[o + k] += acc[k] / wsum;
        // each histogram block sums to 100
        for (let b = 0; b < 3; b++) {
            let s = 0;
            for (let k = 0; k < BINS; k++) s += out[o + b * BINS + k];
            if (s > 0) for (let k = 0; k < BINS; k++) out[o + b * BINS + k] *= 100 / s;
        }
    }
    return out;
};

// ---------------------------------------------------------------- colour

// voxel downsampling that keeps the mean colour per voxel
const downsampleColored = (p: Float32Array, c: Float32Array | null, voxel: number) => {
    if (!c) return { pos: downsample(p, voxel), col: null as Float32Array | null };
    const acc = new Map<string, number[]>();
    for (let i = 0; i < p.length; i += 3) {
        const key = `${Math.floor(p[i] / voxel)},${Math.floor(p[i + 1] / voxel)},${Math.floor(p[i + 2] / voxel)}`;
        let a = acc.get(key);
        if (!a) {
            a = [0, 0, 0, 0, 0, 0, 0];
            acc.set(key, a);
        }
        a[0] += p[i]; a[1] += p[i + 1]; a[2] += p[i + 2];
        a[3] += c[i]; a[4] += c[i + 1]; a[5] += c[i + 2]; a[6]++;
    }
    const pos = new Float32Array(acc.size * 3);
    const col = new Float32Array(acc.size * 3);
    let o = 0;
    acc.forEach((a) => {
        for (let k = 0; k < 3; k++) {
            pos[o + k] = a[k] / a[6];
            col[o + k] = a[3 + k] / a[6];
        }
        o += 3;
    });
    return { pos, col };
};

// per channel zero mean, unit spread: two scans of one place differ in
// exposure and white balance, the pattern of light and dark stays
const standardize = (c: Float32Array) => {
    const out = new Float32Array(c.length);
    const n = c.length / 3;
    for (let k = 0; k < 3; k++) {
        let mean = 0;
        let sq = 0;
        for (let i = 0; i < n; i++) mean += c[i * 3 + k];
        mean /= n;
        for (let i = 0; i < n; i++) sq += (c[i * 3 + k] - mean) ** 2;
        const sd = Math.sqrt(sq / n) || 1;
        for (let i = 0; i < n; i++) out[i * 3 + k] = (c[i * 3 + k] - mean) / sd;
    }
    return out;
};

// colour weight in the descriptor (the histogram blocks sum to 100 each) and
// the largest colour difference (standard deviations) that still counts as a hit
const COLOR_WEIGHT = 12;
const COLOR_TOLERANCE = 1.0;

// mean colour of the neighbourhood of every point, appended to its descriptor
const withColorFeature = (feat: Float32Array, pos: Float32Array, col: Float32Array | null, radius: number) => {
    if (!col) return { feat, dim: DIM };
    const n = pos.length / 3;
    const dim = DIM + 3;
    const out = new Float32Array(n * dim);
    const grid = new Grid(pos, radius);
    const nb: number[] = [];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < DIM; k++) out[i * dim + k] = feat[i * DIM + k];
        grid.within(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], radius, nb);
        const m = [0, 0, 0];
        for (const j of nb) for (let k = 0; k < 3; k++) m[k] += col[j * 3 + k];
        for (let k = 0; k < 3; k++) out[i * dim + DIM + k] = nb.length ? COLOR_WEIGHT * m[k] / nb.length : 0;
    }
    return { feat: out, dim };
};

// nearest descriptor of every row of a among the rows of b
const nearestFeatures = (a: Float32Array, b: Float32Array, dim: number, shouldAbort?: () => boolean) => {
    const DIM = dim;
    const na = a.length / DIM, nb = b.length / DIM;
    const best = new Int32Array(na);
    for (let i = 0; i < na; i++) {
        if ((i & 255) === 0 && shouldAbort?.()) return null;
        let bi = -1;
        let bd = Infinity;
        const oa = i * DIM;
        for (let j = 0; j < nb; j++) {
            const ob = j * DIM;
            let d = 0;
            for (let k = 0; k < DIM && d < bd; k++) {
                const e = a[oa + k] - b[ob + k];
                d += e * e;
            }
            if (d < bd) {
                bd = d;
                bi = j;
            }
        }
        best[i] = bi;
    }
    return best;
};

// fraction of points within tol of the reference (and of similar colour,
// when both carry colours), and their rms
const fit = (points: Float32Array, colors: Float32Array | null, grid: Grid, gridColors: Float32Array | null, tol: number) => {
    const n = points.length / 3;
    let hits = 0;
    let sq = 0;
    const q = grid.points;
    const c2 = COLOR_TOLERANCE * COLOR_TOLERANCE * 3;
    for (let i = 0; i < n; i++) {
        const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
        const j = grid.nearest(x, y, z, tol);
        if (j < 0) continue;
        if (colors && gridColors) {
            const dr = colors[i * 3] - gridColors[j * 3], dg = colors[i * 3 + 1] - gridColors[j * 3 + 1], db = colors[i * 3 + 2] - gridColors[j * 3 + 2];
            if (dr * dr + dg * dg + db * db > c2) continue;
        }
        hits++;
        sq += (x - q[j * 3]) ** 2 + (y - q[j * 3 + 1]) ** 2 + (z - q[j * 3 + 2]) ** 2;
    }
    return { fitness: n ? hits / n : 0, rmse: hits ? Math.sqrt(sq / hits) : Infinity };
};

const pt = (p: Float32Array, i: number) => ({ x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2] });

// ---------------------------------------------------------------- global registration in normalised space

type Hypothesis = { m: M4, inliers: number };

const register = (
    src: { pos: Float32Array, feat: Float32Array },
    dst: { pos: Float32Array, feat: Float32Array },
    dim: number,
    voxel: number,
    useScale: boolean,
    samples: number,
    random: () => number,
    shouldAbort?: () => boolean,
    rate?: (m: M4) => number
) => {
    const fwd = nearestFeatures(src.feat, dst.feat, dim, shouldAbort);
    const bwd = fwd && nearestFeatures(dst.feat, src.feat, dim, shouldAbort);
    if (!fwd || !bwd) return null;

    // mutual matches; fall back to one-sided ones if too few survive
    let cs: number[] = [];
    let cd: number[] = [];
    for (let i = 0; i < fwd.length; i++) {
        if (bwd[fwd[i]] === i) {
            cs.push(i);
            cd.push(fwd[i]);
        }
    }
    if (cs.length < 60) {
        cs = Array.from(fwd.keys());
        cd = Array.from(fwd);
    }
    const m = cs.length;
    if (m < 3) return { hypotheses: [] as Hypothesis[], matches: m };

    const S = new Float32Array(m * 3), D = new Float32Array(m * 3);
    for (let k = 0; k < m; k++) {
        for (let a = 0; a < 3; a++) {
            S[k * 3 + a] = src.pos[cs[k] * 3 + a];
            D[k * 3 + a] = dst.pos[cd[k] * 3 + a];
        }
    }

    const thr2 = (voxel * 2) ** 2;
    const minEdge = voxel * 3;
    const countInliers = (t: M4, list?: number[]) => {
        let c = 0;
        for (let k = 0; k < m; k++) {
            const x = S[k * 3], y = S[k * 3 + 1], z = S[k * 3 + 2];
            const ex = t[0] * x + t[4] * y + t[8] * z + t[12] - D[k * 3];
            const ey = t[1] * x + t[5] * y + t[9] * z + t[13] - D[k * 3 + 1];
            const ez = t[2] * x + t[6] * y + t[10] * z + t[14] - D[k * 3 + 2];
            if (ex * ex + ey * ey + ez * ez < thr2) {
                c++;
                list?.push(k);
            }
        }
        return c;
    };

    const keep = 400;
    const top: Hypothesis[] = [];
    const edge = (P: Float32Array, a: number, b: number) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);

    for (let s = 0; s < samples; s++) {
        if ((s & 1023) === 0 && shouldAbort?.()) return null;
        const a = Math.floor(random() * m), b = Math.floor(random() * m), c = Math.floor(random() * m);
        if (a === b || b === c || a === c) continue;
        const e1 = edge(S, a, b), e2 = edge(S, b, c), e3 = edge(S, a, c);
        if (e1 < minEdge || e2 < minEdge || e3 < minEdge) continue;
        const r1 = edge(D, a, b) / e1, r2 = edge(D, b, c) / e2, r3 = edge(D, a, c) / e3;
        const lo = Math.min(r1, r2, r3), hi = Math.max(r1, r2, r3);
        if (hi > lo * 1.12) continue;
        // scale relative to the normalisation: plausible range only
        // (further guesses cover other scale ranges)
        if (useScale ? (lo < 0.65 || hi > 1.55) : (lo < 0.88 || hi > 1.12)) continue;
        let t: M4;
        try {
            t = alignPoints([pt(S, a), pt(S, b), pt(S, c)], [pt(D, a), pt(D, b), pt(D, c)], { scale: useScale }).matrix;
        } catch {
            continue;
        }
        const inliers = countInliers(t);
        if (inliers < 3 || (top.length === keep && inliers <= top[keep - 1].inliers)) continue;
        top.push({ m: t, inliers });
        top.sort((x, y) => y.inliers - x.inliers);
        if (top.length > keep) top.pop();
    }

    // the inlier count among matches is a weak signal when most matches are
    // wrong (partial overlap): rate the hypotheses on the clouds themselves,
    // on a subsample with a tight tolerance, and refine the best ones
    if (rate) {
        top.forEach((h) => {
            h.inliers = rate(h.m);
        });
        top.sort((x, y) => y.inliers - x.inliers);
        top.length = Math.min(top.length, 40);
    }

    // least squares on the inliers, twice
    const refined = top.map((h) => {
        let t = h.m;
        for (let pass = 0; pass < 2; pass++) {
            const list: number[] = [];
            countInliers(t, list);
            if (list.length < 3) break;
            try {
                t = alignPoints(list.map(k => pt(S, k)), list.map(k => pt(D, k)), { scale: useScale }).matrix;
            } catch {
                break;
            }
        }
        return { m: t, inliers: rate ? rate(t) : countInliers(t) };
    });
    return { hypotheses: refined, matches: m };
};

// ---------------------------------------------------------------- auto align

/**
 * Align `moving` onto `reference` (world-space xyz triples of splat centres)
 * from any starting pose. Colours (rgb triples, one per point) are optional;
 * with them, symmetric shapes no longer confuse the match.
 */
const autoAlign = (
    moving: Float32Array,
    reference: Float32Array,
    options: AutoAlignOptions = {},
    movingColors: Float32Array | null = null,
    referenceColors: Float32Array | null = null
): AutoAlignResult => {
    const useScale = options.scale ?? true;
    const maxPoints = options.maxPoints ?? 4000;
    const samples = options.samples ?? 150000;
    const progress = (f: number) => options.onProgress?.(Math.min(1, f));
    const random = rng(1234567);
    if (moving.length < 90 || reference.length < 90) throw new Error('autoAlign: too few points');

    const useColor = !!(movingColors && referenceColors && movingColors.length === moving.length && referenceColors.length === reference.length);
    const cm = useColor ? standardize(movingColors) : null;
    const cr = useColor ? standardize(referenceColors) : null;

    const fm = frameOf(moving);
    const fr = frameOf(reference);
    const toRef = denormalizer(fr.centre, fr.size);
    const nr = transform(normalizer(fr.centre, fr.size), reference);

    // one voxel size for both clouds (normalised units), grown until both fit
    const pickVoxel = (a: Float32Array, b: Float32Array) => {
        let voxel = 0.015;
        let da = downsample(a, voxel), db = downsample(b, voxel);
        while (da.length / 3 > maxPoints || db.length / 3 > maxPoints) {
            voxel *= 1.15;
            da = downsample(a, voxel);
            db = downsample(b, voxel);
        }
        return voxel;
    };

    // the scale guess: both scans normalised by their own size (scale on) or
    // the moving scan by the reference size (scale off). With partial overlap
    // the size ratio can be off, so further guesses follow if the first fails
    const guesses = useScale ? [1, 0.7, 1.4, 0.5, 2] : [1];
    let best: { candidates: { m: M4, fitness: number }[], voxel: number, fromMoving: M4, matches: number } | null = null;
    let aborted = false;

    for (let g = 0; g < guesses.length; g++) {
        const ms = (useScale ? fm.size : fr.size) * guesses[g];
        const fromMoving = normalizer(fm.centre, ms);
        const nm = transform(fromMoving, moving);
        const voxel = pickVoxel(nm, nr);
        const dmc = downsampleColored(nm, cm, voxel);
        const drc = downsampleColored(nr, cr, voxel);
        const dm = dmc.pos;
        const dr = drc.pos;
        const src = withNormals(dm, dmc.col, voxel * 2.5);
        const dst = withNormals(dr, drc.col, voxel * 2.5);
        if (src.pos.length < 30 || dst.pos.length < 30) continue;
        const base = g / guesses.length;
        const span = 0.6 / (useScale ? 2 : 1);
        progress(base * span);
        const sf = withColorFeature(fpfh(src.pos, src.nor, voxel * 6), src.pos, src.col, voxel * 3);
        const df = withColorFeature(fpfh(dst.pos, dst.nor, voxel * 6), dst.pos, dst.col, voxel * 3);
        // rating: share of a moving subsample that lands on the reference
        // surface (tight tolerance: a wrong or shrunken pose does not), and
        // the other way round, so a pose hiding inside the reference fails
        const fine = downsampleColored(nr, cr, voxel * 0.4);
        const grid = new Grid(fine.pos, voxel * 0.6);
        const subsample = (c: { pos: Float32Array, col: Float32Array | null }, count: number) => {
            const n = c.pos.length / 3;
            const step = Math.max(1, Math.floor(n / count));
            const pos: number[] = [];
            const col: number[] = [];
            for (let i = 0; i < n; i += step) {
                pos.push(c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]);
                if (c.col) col.push(c.col[i * 3], c.col[i * 3 + 1], c.col[i * 3 + 2]);
            }
            return { pos: new Float32Array(pos), col: c.col ? new Float32Array(col) : null };
        };
        const probe = subsample(dmc, 1500);
        const refProbe = subsample(drc, 1500);
        const rate = (m: M4) => {
            const ra = fit(transform(m, probe.pos), probe.col, grid, fine.col, voxel * 0.6).fitness;
            const rb = fit(refProbe.pos, refProbe.col, new Grid(transform(m, dm), voxel * 0.8), dmc.col, voxel * 0.8).fitness;
            return Math.sqrt(ra * rb);
        };
        const reg = register({ pos: src.pos, feat: sf.feat }, { pos: dst.pos, feat: df.feat }, sf.dim, voxel, useScale, samples, random, options.shouldAbort, rate);
        if (!reg) {
            aborted = true;
            break;
        }
        const rated = reg.hypotheses.map(h => ({ m: h.m, fitness: h.inliers }));
        rated.sort((a, b) => b.fitness - a.fitness);
        if (!best || (rated[0]?.fitness ?? 0) > (best.candidates[0]?.fitness ?? 0)) {
            best = { candidates: rated, voxel, fromMoving, matches: reg.matches };
        }
        // good enough: no need for further scale guesses
        if ((best.candidates[0]?.fitness ?? 0) > 0.3) break;
        if (g === 0 && !useScale) break;
    }
    progress(0.6);

    const tolerance = (best?.voxel ?? 0.02) * fr.size * 0.15;
    if (!best || aborted || !best.candidates.length) {
        return { candidates: [], ambiguous: false, tolerance, matches: best?.matches ?? 0, aborted };
    }

    // world transform of a hypothesis
    const world = (m: M4) => mul4(toRef, mul4(m, best.fromMoving));

    // distinct hypotheses (different rotation or position)
    const distinct: M4[] = [];
    const sampleCentre = [fm.centre[0], fm.centre[1], fm.centre[2]];
    const centreOf = (m: M4) => [0, 1, 2].map(r => m[r] * sampleCentre[0] + m[4 + r] * sampleCentre[1] + m[8 + r] * sampleCentre[2] + m[12 + r]);
    for (const c of best.candidates) {
        const w = world(c.m);
        const wc = centreOf(w);
        const same = distinct.some((d) => {
            const dc = centreOf(d);
            return angleBetween(d, w) < 10 && Math.hypot(dc[0] - wc[0], dc[1] - wc[1], dc[2] - wc[2]) < fr.size * 0.15;
        });
        if (!same) distinct.push(w);
        if (distinct.length === 4) break;
    }

    // world-space rating: both clouds downsampled once; a pose scores by the
    // share of the moving cloud on the reference surface and the share of
    // the reference covered by the moving cloud (geometric mean)
    const worldVoxel = best.voxel * fr.size;
    const mdc = downsampleColored(moving, cm, worldVoxel * 0.15);
    const rdc = downsampleColored(reference, cr, worldVoxel * 0.15);
    const movingDown = mdc.pos;
    const refDown = rdc.pos;
    const refGrid = new Grid(refDown, tolerance);
    const rateWorld = (m: M4) => {
        const moved = transform(m, movingDown);
        const a = fit(moved, mdc.col, refGrid, rdc.col, tolerance);
        const b = fit(refDown, rdc.col, new Grid(moved, tolerance), mdc.col, tolerance);
        return { score: Math.sqrt(a.fitness * b.fitness), overlap: a.fitness, rmse: a.rmse };
    };

    const polish = (m: M4, from: Float32Array, to: Float32Array, maxPoints: number, onProgress: (f: number) => void) => {
        try {
            const icp = refineAlignment(transform(m, from), to, {
                scale: useScale,
                maxError: worldVoxel * 4,
                // the schedule the polish was tuned with
                levels: 4,
                maxPoints,
                shouldAbort: options.shouldAbort,
                onProgress
            });
            if (icp.aborted) return null;
            return icp.improved ? mul4(icp.matrix, m) : m;
        } catch {
            // no overlap after this hypothesis: keep it unrefined
            return m;
        }
    };

    const candidates: AutoCandidate[] = [];
    for (let i = 0; i < distinct.length; i++) {
        let m: M4 | null = distinct[i];
        if (options.refine ?? true) {
            m = polish(m, movingDown, refDown, 30000, f => progress(0.6 + 0.25 * (i + f) / distinct.length));
            if (!m) {
                aborted = true;
                break;
            }
        }
        const r = rateWorld(m);
        candidates.push({ matrix: m, fitness: r.score, overlap: r.overlap, rmse: r.rmse, scale: scaleOf(m), angleDeg: angleOf(m) });
    }
    candidates.sort((a, b) => b.fitness - a.fitness);

    // the winner gets the full-resolution fine alignment
    if (!aborted && candidates.length && (options.refine ?? true)) {
        const m = polish(candidates[0].matrix, moving, reference, 80000, f => progress(0.85 + 0.15 * f));
        if (!m) {
            aborted = true;
        } else {
            const r = rateWorld(m);
            candidates[0] = { matrix: m, fitness: r.score, overlap: r.overlap, rmse: r.rmse, scale: scaleOf(m), angleDeg: angleOf(m) };
        }
    }
    progress(1);
    // hypotheses that converged to the same pose count once
    const centreOf2 = (m: M4) => [0, 1, 2].map(r => m[r] * fm.centre[0] + m[4 + r] * fm.centre[1] + m[8 + r] * fm.centre[2] + m[12 + r]);
    for (let i = candidates.length - 1; i > 0; i--) {
        const ci = centreOf2(candidates[i].matrix);
        const dup = candidates.slice(0, i).some((c) => {
            const cc = centreOf2(c.matrix);
            return angleBetween(c.matrix, candidates[i].matrix) < 3 && Math.hypot(cc[0] - ci[0], cc[1] - ci[1], cc[2] - ci[2]) < worldVoxel;
        });
        if (dup) candidates.splice(i, 1);
    }
    const ambiguous = candidates.length > 1 && candidates[1].fitness > candidates[0].fitness * 0.85;
    return { candidates, ambiguous, tolerance, matches: best.matches, aborted };
};

export { autoAlign, AutoAlignOptions, AutoAlignResult, AutoCandidate };
