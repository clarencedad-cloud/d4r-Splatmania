// Scan composition, phase 1: the math behind the wizard (src/compose/
// compose-wizard.ts). Pure Float32Array code like the align cores, so it runs
// in the analysis worker and in node tests (scripts/test-composition.mjs).
//
// - Overlap of 2-4 scans on one voxel grid: which scan becomes the reference
//   (the one sharing most surface with the others) and in which order the
//   others attach (each to the placed scans it shares most with).
// - Transition zones: connected regions where two scans both have surface.
// - Alignment of one scan onto the placed ones: keep the current pose when
//   ICP from it fits, else global registration (src/align/global-align.ts);
//   ICP over the whole overlap, then ICP restricted to one transition zone, so
//   the seam sits there even when scanner drift bends the scans and no single
//   pose fits everywhere.
// - Offset per zone: median point-to-plane distance of the moving scan to the
//   reference surface, plus its local range over blocks of the zone.
//
// Positions are world space; every matrix is column-major 4x4 (playcanvas
// Mat4.data layout) and maps old world positions to new ones.

import { autoAlign } from '../align/global-align';
import { downsample, estimateNormals, Grid, refineAlignment } from '../align/icp';

type M4 = number[];
type V3 = [number, number, number];

const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

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

const transformPoints = (m: M4, p: Float32Array) => {
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    return out;
};

const isIdentity = (m: M4) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12);

// uniform scale of a similarity matrix
const scaleOf = (m: M4) => Math.cbrt(Math.abs(
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
));

// inverse of a similarity (rotation, uniform scale, translation)
const invertRigid = (m: M4): M4 => {
    const s2 = scaleOf(m) ** 2 || 1;
    // R^T / s^2 for the 3x3 part (column-major)
    const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1].map((v, i) => (i % 4 === 3 || i >= 12 ? v : v / s2));
    const t = [m[12], m[13], m[14]];
    r[12] = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]);
    r[13] = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]);
    r[14] = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]);
    r[15] = 1;
    return r;
};

// rotation angle (degrees) and translation length of a correction
const sizeOf = (m: M4, scale: number) => {
    const trace = (m[0] + m[5] + m[10]) / scale;
    const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180 / Math.PI;
    return { angle, shift: Math.hypot(m[12], m[13], m[14]) };
};

// every n-th point so that at most `max` remain
const capPoints = (p: Float32Array, max: number) => {
    const n = p.length / 3;
    if (n <= max) return p;
    const step = n / max;
    const out = new Float32Array(max * 3);
    for (let i = 0; i < max; i++) {
        const j = Math.floor(i * step) * 3;
        out[i * 3] = p[j];
        out[i * 3 + 1] = p[j + 1];
        out[i * 3 + 2] = p[j + 2];
    }
    return out;
};

const concat = (parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
};

// ---------------------------------------------------------------- voxels

// reversible voxel keys (exact in a double): 2^17 cells per axis
const OFF = 1 << 16;
const SPAN = 1 << 17;
const clampIndex = (v: number) => Math.max(1 - OFF, Math.min(OFF - 2, v));
const keyOf = (ix: number, iy: number, iz: number) => ((clampIndex(ix) + OFF) * SPAN + (clampIndex(iy) + OFF)) * SPAN + (clampIndex(iz) + OFF);
const decode = (key: number): V3 => {
    const z = key % SPAN;
    const r = (key - z) / SPAN;
    const y = r % SPAN;
    return [(r - y) / SPAN - OFF, y - OFF, z - OFF];
};
const pointKey = (p: Float32Array, i: number, voxel: number) => keyOf(Math.floor(p[i] / voxel), Math.floor(p[i + 1] / voxel), Math.floor(p[i + 2] / voxel));

// points per voxel
const occupancy = (p: Float32Array, voxel: number) => {
    const m = new Map<number, number>();
    for (let i = 0; i < p.length; i += 3) {
        const k = pointKey(p, i, voxel);
        m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
};

const surfaceOf = (occ: Map<number, number>, minCount: number) => {
    const s = new Set<number>();
    occ.forEach((n, k) => {
        if (n >= minCount) s.add(k);
    });
    return s;
};

// the keys plus their neighbours up to `steps` voxels away
const dilate = (keys: Iterable<number>, steps: number) => {
    const out = new Set<number>();
    for (const k of keys) {
        const [x, y, z] = decode(k);
        for (let dx = -steps; dx <= steps; dx++) {
            for (let dy = -steps; dy <= steps; dy++) {
                for (let dz = -steps; dz <= steps; dz++) out.add(keyOf(x + dx, y + dy, z + dz));
            }
        }
    }
    return out;
};

// points whose voxel is in the set
const subset = (p: Float32Array, keys: Set<number>, voxel: number) => {
    const out: number[] = [];
    for (let i = 0; i < p.length; i += 3) {
        if (keys.has(pointKey(p, i, voxel))) out.push(p[i], p[i + 1], p[i + 2]);
    }
    return new Float32Array(out);
};

// per-axis 1st..99th percentile of a subsample (floaters far out do not count)
const robustBox = (p: Float32Array) => {
    const n = p.length / 3;
    const step = Math.max(1, Math.floor(n / 50000));
    const axes: number[][] = [[], [], []];
    for (let i = 0; i < n; i += step) {
        for (let k = 0; k < 3; k++) axes[k].push(p[i * 3 + k]);
    }
    const min = [0, 0, 0];
    const max = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
        const s = axes[k].sort((a, b) => a - b);
        min[k] = s[Math.floor(s.length * 0.01)] ?? 0;
        max[k] = s[Math.min(s.length - 1, Math.floor(s.length * 0.99))] ?? 0;
    }
    return { min, max };
};

// voxel for overlap and zones: 1/120 of the robust size of all scans together
const ZONE_VOXELS = 120;
const autoVoxel = (clouds: Float32Array[]) => {
    const boxes = clouds.filter(c => c.length >= 3).map(robustBox);
    if (!boxes.length) return 1;
    const lo = [0, 1, 2].map(k => Math.min(...boxes.map(b => b.min[k])));
    const hi = [0, 1, 2].map(k => Math.max(...boxes.map(b => b.max[k])));
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    return diag > 0 ? diag / ZONE_VOXELS : 1;
};

// ---------------------------------------------------------------- overlap

type OverlapOptions = {
    // voxel edge in world units (default: 1/120 of the size of all scans)
    voxel?: number,
    // points a voxel needs to count as surface (default 2)
    minCount?: number
};

type OverlapResult = {
    voxel: number,
    // voxels with surface per scan
    occupied: number[],
    // voxels with surface in both scans
    shared: number[][],
    // shared[i][j] / occupied[i]: how much of scan i the other one covers
    fraction: number[][],
    // suggested reference: shares the most surface with the others
    reference: number,
    // attach order after the reference: each scan with the placed scan it
    // shares most with (-1: it touches none, global registration needed)
    order: { scan: number, partner: number }[]
};

const scanOverlap = (clouds: Float32Array[], options: OverlapOptions = {}): OverlapResult => {
    const voxel = options.voxel ?? autoVoxel(clouds);
    const minCount = options.minCount ?? 2;
    const surfaces = clouds.map(c => surfaceOf(occupancy(c, voxel), minCount));
    const n = clouds.length;
    const shared = surfaces.map(() => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            let s = 0;
            const [small, large] = surfaces[i].size < surfaces[j].size ? [surfaces[i], surfaces[j]] : [surfaces[j], surfaces[i]];
            small.forEach((k) => {
                if (large.has(k)) s++;
            });
            shared[i][j] = shared[j][i] = s;
        }
    }
    const occupied = surfaces.map(s => s.size);
    const fraction = shared.map((row, i) => row.map(s => (occupied[i] ? s / occupied[i] : 0)));

    let reference = 0;
    let best = -1;
    for (let i = 0; i < n; i++) {
        const total = shared[i].reduce((a, b) => a + b, 0);
        if (total > best || (total === best && occupied[i] > occupied[reference])) {
            best = total;
            reference = i;
        }
    }

    const placed = new Set([reference]);
    const order: { scan: number, partner: number }[] = [];
    while (placed.size < n) {
        let pick = -1;
        let partner = -1;
        let most = -1;
        for (let u = 0; u < n; u++) {
            if (placed.has(u)) continue;
            for (const p of placed) {
                if (shared[u][p] > most) {
                    most = shared[u][p];
                    pick = u;
                    partner = p;
                }
            }
        }
        placed.add(pick);
        order.push({ scan: pick, partner: most > 0 ? partner : -1 });
    }

    return { voxel, occupied, shared, fraction, reference, order };
};

// ---------------------------------------------------------------- zones

type Zone = {
    // shared voxels in the zone, and their part of all shared voxels
    voxels: number,
    share: number,
    min: V3,
    max: V3,
    centre: V3,
    keys: Set<number>
};

// connected (26-neighbour) regions of voxels where both clouds have surface,
// largest first; regions under `minVoxels` are noise
const findZones = (a: Float32Array, b: Float32Array, voxel: number, minCount = 2, minVoxels = 6): Zone[] => {
    const sa = surfaceOf(occupancy(a, voxel), minCount);
    const ob = occupancy(b, voxel);
    const shared = new Set<number>();
    sa.forEach((k) => {
        if ((ob.get(k) ?? 0) >= minCount) shared.add(k);
    });

    const seen = new Set<number>();
    const groups: number[][] = [];
    shared.forEach((start) => {
        if (seen.has(start)) return;
        seen.add(start);
        const group = [start];
        for (let g = 0; g < group.length; g++) {
            const [x, y, z] = decode(group[g]);
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const k = keyOf(x + dx, y + dy, z + dz);
                        if (shared.has(k) && !seen.has(k)) {
                            seen.add(k);
                            group.push(k);
                        }
                    }
                }
            }
        }
        groups.push(group);
    });

    const total = shared.size;
    return groups.filter(g => g.length >= minVoxels).sort((p, q) => q.length - p.length).map((g) => {
        const min: V3 = [Infinity, Infinity, Infinity];
        const max: V3 = [-Infinity, -Infinity, -Infinity];
        const centre: V3 = [0, 0, 0];
        for (const k of g) {
            const c = decode(k);
            for (let i = 0; i < 3; i++) {
                min[i] = Math.min(min[i], c[i] * voxel);
                max[i] = Math.max(max[i], (c[i] + 1) * voxel);
                centre[i] += (c[i] + 0.5) * voxel / g.length;
            }
        }
        return { voxels: g.length, share: total ? g.length / total : 0, min, max, centre, keys: new Set(g) };
    });
};

// ---------------------------------------------------------------- offsets

type ZoneOffset = {
    // how far the moving scan sits off the reference in the zone: the length
    // of the common shift of its blocks (3x3x3 zone voxels; the median of
    // the block shift vectors, so differences in splat placement between two
    // scans, which point every which way, cancel out)
    median: number,
    // the common shift over smaller areas (cells of 3x3x3 blocks), 10th and
    // 90th percentile: drift shows as a spread here
    localMin: number,
    localMax: number,
    // how much the two surfaces differ besides the shift (median length of
    // the block shifts around the common one): reconstruction differences
    surface: number,
    // blocks measured
    blocks: number,
    // part of the moving zone points that found reference surface nearby
    coverage: number
};

const BLOCK = 3;

// the shift that moves the points onto the reference surface (point-to-plane,
// translation only, a few rounds). Along a surface nothing can be measured:
// a damped solve leaves those directions at zero, and there a shift does not
// show either.
const blockShift = (m: number[], grid: Grid, normals: Float32Array, radius: number) => {
    const q = grid.points;
    const t = [0, 0, 0];
    const n = m.length / 3;
    const res = new Float32Array(n);
    const nrm = new Int32Array(n);
    let pairs = 0;
    for (let round = 0; round < 6; round++) {
        // associate, then drop the worst pairs: points whose counterpart the
        // other scan lacks would grab some other surface nearby
        let found = 0;
        for (let i = 0; i < n; i++) {
            const x = m[i * 3] + t[0], y = m[i * 3 + 1] + t[1], z = m[i * 3 + 2] + t[2];
            const j = grid.nearest(x, y, z, radius);
            if (j < 0 || Number.isNaN(normals[j * 3])) {
                nrm[i] = -1;
                continue;
            }
            nrm[i] = j;
            res[i] = (x - q[j * 3]) * normals[j * 3] + (y - q[j * 3 + 1]) * normals[j * 3 + 1] + (z - q[j * 3 + 2]) * normals[j * 3 + 2];
            found++;
        }
        if (found < 20) return null;
        const abs: number[] = [];
        for (let i = 0; i < n; i++) if (nrm[i] >= 0) abs.push(Math.abs(res[i]));
        abs.sort((x, y) => x - y);
        const limit = abs[Math.floor(abs.length * 0.7)] * 1.5 + 1e-9;
        const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        const b = [0, 0, 0];
        pairs = 0;
        for (let i = 0; i < n; i++) {
            const j = nrm[i];
            if (j < 0 || Math.abs(res[i]) > limit) continue;
            const nx = normals[j * 3], ny = normals[j * 3 + 1], nz = normals[j * 3 + 2];
            const r = res[i];
            A[0] += nx * nx; A[1] += nx * ny; A[2] += nx * nz;
            A[4] += ny * ny; A[5] += ny * nz; A[8] += nz * nz;
            b[0] -= r * nx; b[1] -= r * ny; b[2] -= r * nz;
            pairs++;
        }
        if (pairs < 20) return null;
        A[3] = A[1]; A[6] = A[2]; A[7] = A[5];
        const damp = 1e-2 * (A[0] + A[4] + A[8]) / 3;
        A[0] += damp; A[4] += damp; A[8] += damp;
        // 3x3 solve (Cramer)
        const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
        if (Math.abs(det) < 1e-30) return null;
        const d = [
            (b[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (b[1] * A[8] - A[5] * b[2]) + A[2] * (b[1] * A[7] - A[4] * b[2])) / det,
            (A[0] * (b[1] * A[8] - A[5] * b[2]) - b[0] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * b[2] - b[1] * A[6])) / det,
            (A[0] * (A[4] * b[2] - b[1] * A[7]) - A[1] * (A[3] * b[2] - b[1] * A[6]) + b[0] * (A[3] * A[7] - A[4] * A[6])) / det
        ];
        t[0] += d[0]; t[1] += d[1]; t[2] += d[2];
        if (Math.hypot(d[0], d[1], d[2]) < radius * 1e-4) break;
    }
    return { t, pairs };
};

// how far the moving scan sits off the reference inside the zone
// blocks measured per zone (spread evenly over it) and points per block
const MAX_BLOCKS = 400;
const BLOCK_POINTS = 400;

// component-wise median of shift vectors
const medianVector = (v: number[][]) => [0, 1, 2].map((k) => {
    const c = v.map(x => x[k]).sort((p, q) => p - q);
    return c[Math.floor(c.length / 2)];
});

// how far the moving scan sits off the reference inside the zone
const zoneOffset = (moving: Float32Array, reference: Float32Array, zone: Zone, voxel: number): ZoneOffset | null => {
    const keys = dilate(zone.keys, 1);
    let fine = voxel / 8;
    const m = downsample(subset(moving, keys, voxel), fine);
    let r = downsample(subset(reference, keys, voxel), fine);
    while (r.length / 3 > 150000) {
        fine *= 1.4;
        r = downsample(subset(reference, keys, voxel), fine);
    }
    if (m.length < 60 || r.length < 60) return null;
    const radius = voxel;
    const grid = new Grid(r, radius);
    const normals = estimateNormals(grid, fine * 2.5);

    // the moving points by block; blocks sampled evenly over the zone
    const size = voxel * BLOCK;
    const byBlock = new Map<number, number[]>();
    for (let i = 0; i < m.length; i += 3) {
        const k = keyOf(Math.floor(m[i] / size), Math.floor(m[i + 1] / size), Math.floor(m[i + 2] / size));
        let list = byBlock.get(k);
        if (!list) {
            list = [];
            byBlock.set(k, list);
        }
        list.push(m[i], m[i + 1], m[i + 2]);
    }
    const full = [...byBlock.entries()].filter(([, list]) => list.length >= 60 * 3).sort((x, y) => x[0] - y[0]);
    const step = Math.max(1, full.length / MAX_BLOCKS);
    const vectors: number[][] = [];
    const where: number[] = [];
    let pairs = 0;
    let tried = 0;
    for (let f = 0; f < full.length; f += step) {
        const [key, all] = full[Math.floor(f)];
        // at most BLOCK_POINTS points, evenly picked
        const n = all.length / 3;
        const list = n <= BLOCK_POINTS ? all : Array.from({ length: BLOCK_POINTS * 3 }, (_, i) => all[Math.floor(Math.floor(i / 3) * n / BLOCK_POINTS) * 3 + (i % 3)]);
        tried += list.length / 3;
        const shift = blockShift(list, grid, normals, radius);
        // most of the block must find the other scan's surface: else it lies
        // where one scan ends
        if (!shift || shift.pairs < 0.6 * list.length / 3) continue;
        vectors.push(shift.t);
        where.push(key);
        pairs += shift.pairs;
    }
    if (!vectors.length) return null;

    const common = medianVector(vectors);
    const quantile = (v: number[], q: number) => {
        const sorted = v.slice().sort((x, y) => x - y);
        return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    };
    const surface = quantile(vectors.map(t => Math.hypot(t[0] - common[0], t[1] - common[1], t[2] - common[2])), 0.5);

    // the common shift per cell of 3x3x3 blocks (cells with 3+ blocks)
    const cells = new Map<number, number[][]>();
    vectors.forEach((t, i) => {
        const [bx, by, bz] = decode(where[i]);
        const c = keyOf(Math.floor(bx / 3), Math.floor(by / 3), Math.floor(bz / 3));
        let list = cells.get(c);
        if (!list) {
            list = [];
            cells.set(c, list);
        }
        list.push(t);
    });
    const local = [...cells.values()].filter(list => list.length >= 3).map((list) => {
        const v = medianVector(list);
        return Math.hypot(v[0], v[1], v[2]);
    });
    const median = Math.hypot(common[0], common[1], common[2]);
    return {
        median,
        localMin: local.length >= 2 ? quantile(local, 0.1) : median,
        localMax: local.length >= 2 ? quantile(local, 0.9) : median,
        surface,
        blocks: vectors.length,
        coverage: tried ? pairs / tried : 0
    };
};

// median distance of a point to its nearest neighbour in the same cloud
const spacingOf = (p: Float32Array, cell: number) => {
    const n = p.length / 3;
    if (n < 10) return cell;
    const grid = new Grid(p, cell);
    const step = Math.max(1, Math.floor(n / 2000));
    const d: number[] = [];
    const q = grid.points;
    const nb: number[] = [];
    for (let i = 0; i < n; i += step) {
        grid.within(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], cell, nb);
        let best = Infinity;
        for (const j of nb) {
            if (j === i) continue;
            const e = Math.hypot(q[j * 3] - p[i * 3], q[j * 3 + 1] - p[i * 3 + 1], q[j * 3 + 2] - p[i * 3 + 2]);
            if (e < best) best = e;
        }
        if (Number.isFinite(best)) d.push(best);
    }
    if (!d.length) return cell;
    d.sort((x, y) => x - y);
    return d[Math.floor(d.length / 2)];
};

// share of the moving scan's points in shared voxels that lie close to the
// reference: near 1 when the overlap fits, low when it is off. Close means
// 1/8 voxel, or 3 point spacings of the reference when it is sampled thinner.
const zoneFit = (moving: Float32Array, reference: Float32Array, voxel: number) => {
    const zones = findZones(moving, reference, voxel);
    if (!zones.length) return { fit: 0, zones };
    const keys = new Set<number>();
    zones.forEach(z => z.keys.forEach(k => keys.add(k)));
    const m = capPoints(subset(moving, keys, voxel), 20000);
    const r = subset(reference, dilate(keys, 1), voxel);
    if (m.length < 30 || r.length < 30) return { fit: 0, zones };
    const tol = Math.min(voxel, Math.max(voxel / 8, 3 * spacingOf(capPoints(r, 200000), voxel / 2)));
    const grid = new Grid(r, tol);
    let hits = 0;
    for (let i = 0; i < m.length; i += 3) {
        if (grid.nearest(m[i], m[i + 1], m[i + 2], tol) >= 0) hits++;
    }
    return { fit: hits / (m.length / 3), zones };
};

// ---------------------------------------------------------------- align

type ComposeAlignOptions = {
    // solve uniform scale as well (default false: scans of one device share it)
    scale?: boolean,
    // rough pose: 'never' only refines the current pose (scans known to be in
    // one frame), 'always' searches anew (global registration) and takes the
    // best fit, 'auto' (default) refines the current pose and also searches
    // unless that pose is clearly right, then keeps whichever fits clearly
    // better
    coarse?: 'auto' | 'always' | 'never',
    // align at the zone nearest this world point (default: the largest zone)
    focus?: V3 | null,
    // false: stop after the ICP over the whole overlap (tests compare)
    zoneStep?: boolean,
    // zone voxel (default: 1/120 of both scans together)
    voxel?: number,
    movingColors?: Float32Array | null,
    referenceColors?: Float32Array | null,
    onProgress?: (fraction: number) => void,
    shouldAbort?: () => boolean,
    // what the steps decided, for tests and logs
    onNote?: (text: string) => void
};

type ZoneReport = {
    voxels: number,
    share: number,
    min: V3,
    max: V3,
    centre: V3,
    // offset at the start of the job and after it (null: too little data)
    before: ZoneOffset | null,
    after: ZoneOffset | null
};

type ComposeAlignResult = {
    // world correction for the moving scan and its uniform scale
    matrix: M4,
    scale: number,
    // how the rough pose came about: kept, found by global registration,
    // or nothing fitted (matrix then holds the best try, fit tells how good)
    coarse: 'kept' | 'global' | 'failed',
    // how the rough pose was found: 'never' = only from the current pose,
    // 'always' = a global search ran as well
    mode: 'never' | 'always',
    // part of the moving scan's surface that already overlapped at the start
    startShare: number,
    // share of the overlap that fits (see zoneFit) before and after
    fitBefore: number,
    fitAfter: number,
    zones: ZoneReport[],
    // the zone the final step aligned at (-1: none)
    usedZone: number,
    // other places the search found that fit as well (ICP-polished, not
    // zone-refined), best first: in a repetitive room the right one can be
    // among them ("Andere Lösung")
    alternatives: { matrix: M4, scale: number, share: number, offset: number, surface: number }[],
    // size of the correction
    angleDeg: number,
    shift: number,
    voxel: number,
    aborted: boolean
};

// a pose counts as aligned when its largest transition zone has at least
// MIN_ZONE voxels, no common shift above OFFSET_OK voxels is left and the
// surfaces differ by no more than SURFACE_OK voxels besides it. Real scans
// never match exactly: two PortalCam passes still differ by 4-6 cm at the
// right pose (0.1-0.15 voxel at 0.4 m), two L3 passes by about 3 cm in a
// 60 m hall (0.05 voxel). These only label a result; which pose wins is a
// comparison (see SWITCH_SURFACE).
const MIN_ZONE = 20;
const MIN_BLOCKS = 8;
const OFFSET_OK = 0.1;
const SURFACE_OK = 0.2;
// the pose near the start is clearly right when a fair part of the moving
// scan overlaps and the surfaces there agree closely: then no search. Floor
// and ceiling of two scans of one building coincide at any heading, so the
// overlap alone says little; how well the surfaces agree does (Steinbeis,
// turned 94 deg: 16 cm apart; at the right pose 3.6 cm).
const CLEAR_SHARE = 0.15;
const CLEAR_OFFSET = 0.05;
const CLEAR_SURFACE = 0.12;
// a pose found by a search replaces the one near the start only when its
// surfaces agree clearly better, and a far jump only when the pose near the
// start does not hold at all: in a repetitive hall a look-alike place 16 m
// away can fit as closely as the right one (museum test: it did twice)
const SWITCH_SURFACE = 0.7;
// "near": the moving scan's centre moves less than this many voxels and it
// turns less than this many degrees
const SAME_POSE_SHIFT = 2;
const SAME_POSE_ANGLE = 5;
// a far jump needs the pose near the start to be measurably wrong: hardly any
// overlap, or its surfaces further apart than a fitting pose may be
// (Steinbeis, turned 94 deg: 0.27-0.38 voxel; right poses 0.01-0.08). A pose
// that only cannot be measured yet (not fully converged, but overlapping a
// fair amount) stays and is flagged instead.
const FAR_SURFACE = SURFACE_OK;
// and it must overlap a fair amount itself
const SWITCH_SHARE = 0.1;
// a failed result moves the scan only when it fits clearly better than the
// start; else the scan stays where it was
const FAILED_GAIN = 1.2;
// the zone step may only fine-tune: larger corrections are sliding, not drift
const ZONE_MAX_SHIFT = 1.5;
const ZONE_MAX_ANGLE = 3;
// the zone core: the middle part of the zone across the seam, where the seam
// will run; the step aligns there when it holds enough of the zone
const CORE = 0.4;

const centroid = (p: Float32Array): V3 | null => {
    const n = p.length / 3;
    if (!n) return null;
    const c: V3 = [0, 0, 0];
    for (let i = 0; i < p.length; i += 3) {
        c[0] += p[i];
        c[1] += p[i + 1];
        c[2] += p[i + 2];
    }
    return [c[0] / n, c[1] / n, c[2] / n];
};

// points near the zone but outside it, so their centroids show from which
// side each scan reaches into the zone
const besideZone = (p: Float32Array, zone: Zone, voxel: number) => {
    const reach = Math.max(...[0, 1, 2].map(k => zone.max[k] - zone.min[k])) * 0.75 + voxel * 2;
    const inside = dilate(zone.keys, 1);
    const out: number[] = [];
    const [cx, cy, cz] = zone.centre;
    const step = Math.max(1, Math.floor(p.length / 3 / 400000));
    for (let i = 0; i < p.length; i += 3 * step) {
        if (Math.abs(p[i] - cx) > reach || Math.abs(p[i + 1] - cy) > reach || Math.abs(p[i + 2] - cz) > reach) continue;
        if (inside.has(pointKey(p, i, voxel))) continue;
        out.push(p[i], p[i + 1], p[i + 2]);
    }
    return new Float32Array(out);
};

// the middle of the zone across the seam (the direction from the reference's
// side of the zone to the moving scan's side); null when there is no clear
// side (one scan lies inside the other) or the core would be too small
const zoneCore = (placed: Float32Array, reference: Float32Array, zone: Zone, voxel: number) => {
    const cm = centroid(besideZone(placed, zone, voxel));
    const cr = centroid(besideZone(reference, zone, voxel));
    if (!cm || !cr) return null;
    const d = [cm[0] - cr[0], cm[1] - cr[1], cm[2] - cr[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < voxel * 2) return null;
    const dir = d.map(v => v / len);
    const along = (k: number) => {
        const c = decode(k);
        return ((c[0] + 0.5) * voxel - zone.centre[0]) * dir[0] + ((c[1] + 0.5) * voxel - zone.centre[1]) * dir[1] + ((c[2] + 0.5) * voxel - zone.centre[2]) * dir[2];
    };
    let lo = Infinity;
    let hi = -Infinity;
    zone.keys.forEach((k) => {
        const a = along(k);
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
    });
    const mid = (lo + hi) / 2;
    const half = Math.max(voxel, (hi - lo) * CORE / 2);
    const keys = new Set<number>();
    zone.keys.forEach((k) => {
        if (Math.abs(along(k) - mid) <= half) keys.add(k);
    });
    return keys.size >= Math.max(MIN_ZONE, zone.voxels * 0.25) ? keys : null;
};

const composeAlign = (moving: Float32Array, reference: Float32Array, options: ComposeAlignOptions = {}): ComposeAlignResult => {
    const voxel = options.voxel ?? autoVoxel([moving, reference]);
    const useScale = options.scale ?? false;
    const progress = options.onProgress ?? (() => {});
    const abort = options.shouldAbort ?? (() => false);
    const aborted = (): ComposeAlignResult => ({
        matrix: IDENTITY.slice(), scale: 1, coarse: 'failed', mode: 'never', startShare: 0, fitBefore: 0, fitAfter: 0, zones: [], usedZone: -1, alternatives: [], angleDeg: 0, shift: 0, voxel, aborted: true
    });

    // ICP over the overlap from pose m; returns the refined pose
    const icp = (m: M4, scale: boolean) => {
        try {
            const r = refineAlignment(transformPoints(m, moving), reference, { scale, shouldAbort: abort });
            if (r.aborted) return null;
            return r.improved ? { m: mul4(r.matrix, m), scale: r.scale } : { m, scale: 1 };
        } catch {
            // no overlap from this pose
            return { m, scale: 1 };
        }
    };

    const movingSurface = surfaceOf(occupancy(moving, voxel), 2).size;

    // how well a pose fits: its largest zone (as part of the moving scan's
    // surface) and the shift and surface difference there. More overlap and
    // smaller offsets score higher.
    // found = a place from the search: it must bring enough measured blocks
    // (a handful shows no surface difference at all, and a look-alike place
    // far away then looks perfect); the pose near the start is judged on
    // whatever it has
    const judge = (m: M4, found = false) => {
        const placed = transformPoints(m, moving);
        const zones = findZones(placed, reference, voxel);
        const z = zones[0];
        const measured = z && z.voxels >= MIN_ZONE ? zoneOffset(placed, reference, z, voxel) : null;
        const offset = measured && (!found || measured.blocks >= MIN_BLOCKS) ? measured : null;
        const share = z && movingSurface ? z.voxels / movingSurface : 0;
        const ok = !!offset && offset.median <= voxel * OFFSET_OK && offset.surface <= voxel * SURFACE_OK;
        const clear = ok && share >= CLEAR_SHARE && offset.median <= voxel * CLEAR_OFFSET && offset.surface <= voxel * CLEAR_SURFACE;
        const score = z ? z.voxels / (1 + (offset ? offset.median / (voxel * OFFSET_OK) + offset.surface / (voxel * SURFACE_OK) : 6)) : 0;
        return { ok, clear, share, score, offset };
    };
    const describe = (j: ReturnType<typeof judge>) => `overlap ${(j.share * 100).toFixed(0)} %, shift ${j.offset ? (j.offset.median * 1000).toFixed(0) : '-'} mm, surface ${j.offset ? (j.offset.surface * 1000).toFixed(0) : '-'} mm, score ${j.score.toFixed(0)}${j.ok ? ', ok' : ''}`;

    const fitBefore = zoneFit(moving, reference, voxel).fit;
    const startZones = findZones(moving, reference, voxel);
    const startShare = movingSurface ? startZones.reduce((sum, z) => sum + z.voxels, 0) / movingSurface : 0;
    const note = options.onNote ?? (() => {});
    const start = judge(IDENTITY);
    note(`start: ${describe(start)}`);
    progress(0.05);

    // 1. near the start: ICP from the current pose (kept only if it fits
    // better than the start itself)
    let near = { m: IDENTITY.slice(), scale: 1, j: start };
    if (options.coarse !== 'always' && startZones.length) {
        const r = icp(IDENTITY, useScale);
        if (!r) return aborted();
        const j = judge(r.m);
        note(`ICP from the start: ${describe(j)}`);
        if (j.score >= start.score) near = { m: r.m, scale: r.scale, j };
    }
    progress(0.2);

    // 2. a search anew (global registration on shape and colour, every
    // candidate polished by ICP), unless the pose near the start is clearly
    // right or the caller said the scans are in one frame
    const search = options.coarse === 'always' || (options.coarse !== 'never' && !near.j.clear);
    const mode: ComposeAlignResult['mode'] = search ? 'always' : 'never';
    let found: typeof near | null = null;
    const candidates: (typeof near)[] = [];
    if (search) {
        const result = autoAlign(moving, reference, {
            scale: useScale,
            shouldAbort: abort,
            onProgress: f => progress(0.2 + 0.5 * f)
        }, options.movingColors ?? null, options.referenceColors ?? null);
        if (result.aborted) return aborted();
        for (const candidate of result.candidates) {
            const r = icp(candidate.matrix, useScale);
            if (!r) return aborted();
            const j = judge(r.m, true);
            note(`search candidate: ${describe(j)}`);
            const c = { m: r.m, scale: candidate.scale * r.scale, j };
            candidates.push(c);
            if (!found || j.score > found.j.score) found = c;
        }
    }

    // 3. which pose: a found one replaces the one near the start only when
    // it fits clearly better (or there was no start to keep)
    let pose: M4;
    let scale: number;
    let coarse: ComposeAlignResult['coarse'];
    const nearSurface = near.j.offset ? near.j.offset.surface : Infinity;
    const nearWrong = !near.j.ok && (near.j.share < SWITCH_SHARE || (!!near.j.offset && near.j.offset.surface > FAR_SURFACE * voxel));
    // does the found pose put the scan about where the near one does?
    const centre = (() => {
        const c = [0, 0, 0];
        const n = moving.length / 3;
        for (let i = 0; i < moving.length; i += 3) {
            c[0] += moving[i]; c[1] += moving[i + 1]; c[2] += moving[i + 2];
        }
        return c.map(v => v / Math.max(1, n));
    })();
    const samePose = (a: M4, b: M4) => {
        const pa = transformPoints(a, new Float32Array(centre));
        const pb = transformPoints(b, new Float32Array(centre));
        const rel = mul4(a, invertRigid(b));
        return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) <= voxel * SAME_POSE_SHIFT && sizeOf(rel, scaleOf(rel)).angle <= SAME_POSE_ANGLE;
    };
    const takeFound = !!found && found.j.ok && found.j.share >= SWITCH_SHARE &&
        (options.coarse === 'always' ||
            ((nearWrong || samePose(found.m, near.m)) && found.j.offset.surface <= SWITCH_SURFACE * nearSurface));
    if (found && !takeFound && found.j.ok && near.j.ok && !samePose(found.m, near.m)) note('search found a different place, but the pose near the start holds: kept');
    if (takeFound) {
        pose = found.m;
        scale = found.scale;
        coarse = 'global';
    } else if (near.j.ok) {
        pose = near.m;
        scale = near.scale;
        coarse = 'kept';
    } else {
        // nothing holds: move only if it clearly beats the start
        const best = found && found.j.score > near.j.score ? found : near;
        const move = options.coarse !== 'always' && best === near && best.j.score >= FAILED_GAIN * Math.max(start.score, 1e-9);
        pose = move ? best.m : IDENTITY.slice();
        scale = move ? best.scale : 1;
        coarse = 'failed';
    }
    note(`result: ${coarse}${takeFound ? ' (found by the search)' : ''}`);
    progress(0.75);
    if (abort()) return aborted();

    // 3. ICP on one transition zone - on its core across the seam when it has
    // one - so the seam sits tight there even when drift bends the scans
    let placed = transformPoints(pose, moving);
    let zones = findZones(placed, reference, voxel);
    let usedZone = -1;
    // (not when the scan stays where it was after nothing held: there is no
    // pose to refine, an overlap there is only by chance)
    if (zones.length && options.zoneStep !== false && !(coarse === 'failed' && isIdentity(pose))) {
        usedZone = 0;
        if (options.focus) {
            // the zone whose voxels lie nearest to the focus (a large zone's
            // box can hold the smaller zones' centres, so boxes do not tell)
            const f = options.focus;
            let best = Infinity;
            zones.forEach((z, i) => {
                z.keys.forEach((k) => {
                    const c = decode(k);
                    const d = Math.hypot((c[0] + 0.5) * voxel - f[0], (c[1] + 0.5) * voxel - f[1], (c[2] + 0.5) * voxel - f[2]);
                    if (d < best) {
                        best = d;
                        usedZone = i;
                    }
                });
            });
        }
        const zone = zones[usedZone];
        const core = zoneCore(placed, reference, zone, voxel);
        note(`zone ${usedZone}: ${zone.voxels} voxels, core ${core ? core.size : 'none'}`);
        const target: Zone = core ? { ...zone, keys: core, voxels: core.size } : zone;
        const keys = dilate(target.keys, 1);
        const zm = subset(placed, keys, voxel);
        const zr = subset(reference, keys, voxel);
        if (zm.length >= 300 && zr.length >= 300) {
            try {
                const diag = Math.hypot(zone.max[0] - zone.min[0], zone.max[1] - zone.min[1], zone.max[2] - zone.min[2]);
                const fine = Math.max(spacingOf(capPoints(zr, 200000), voxel / 2) * 1.2, diag / 1500);
                const r = refineAlignment(zm, zr, { scale: false, maxError: voxel, voxel: fine, maxPoints: 150000, shouldAbort: abort });
                if (r.aborted) return aborted();
                const { angle, shift } = sizeOf(r.matrix, 1);
                // kept only when the zone really fits better afterwards
                const next = mul4(r.matrix, pose);
                const before = r.improved ? zoneOffset(placed, reference, target, voxel) : null;
                const after = r.improved ? zoneOffset(transformPoints(next, moving), reference, target, voxel) : null;
                const better = !!before && !!after && after.median <= before.median;
                note(`zone step: improved ${r.improved}, offset ${before?.median?.toFixed(4)} -> ${after?.median?.toFixed(4)}, shift ${shift.toFixed(4)}, angle ${angle.toFixed(3)}`);
                if (r.improved && better && shift <= voxel * ZONE_MAX_SHIFT && angle <= ZONE_MAX_ANGLE) {
                    pose = next;
                    placed = transformPoints(pose, moving);
                    const centre = zone.centre;
                    zones = findZones(placed, reference, voxel);
                    // the same zone, found again after the move
                    let best = Infinity;
                    zones.forEach((z, i) => {
                        const d = Math.hypot(centre[0] - z.centre[0], centre[1] - z.centre[1], centre[2] - z.centre[2]);
                        if (d < best) {
                            best = d;
                            usedZone = i;
                        }
                    });
                }
            } catch (error) {
                // too little in the zone: keep the overlap fit
                note(`zone step failed: ${(error as Error).message}`);
            }
        } else {
            note(`zone step skipped: ${zm.length / 3} / ${zr.length / 3} points`);
        }
    }
    progress(0.9);
    if (abort()) return aborted();

    // 4. offsets per zone (largest few), before and after, measured in the
    // zone core where the seam will run (the edges of a zone are where one
    // scan ends, and blocks there grab the wrong surface)
    const report = zones.slice(0, 8).map((z): ZoneReport => {
        const core = zoneCore(placed, reference, z, voxel);
        const target: Zone = core ? { ...z, keys: core, voxels: core.size } : z;
        return {
            voxels: z.voxels,
            share: z.share,
            min: z.min,
            max: z.max,
            centre: z.centre,
            before: zoneOffset(moving, reference, target, voxel),
            after: zoneOffset(placed, reference, target, voxel)
        };
    });
    if (usedZone >= report.length) usedZone = -1;
    const fitAfter = zoneFit(placed, reference, voxel).fit;
    progress(1);

    // the other plausible places, without the chosen one and duplicates
    const alternatives: ComposeAlignResult['alternatives'] = [];
    const taken: M4[] = [pose];
    [near, ...candidates]
    .filter(c => c.j.ok && c.j.share >= SWITCH_SHARE && c.j.offset)
    .sort((a, b) => a.j.offset.surface - b.j.offset.surface)
    .forEach((c) => {
        if (taken.some(t => samePose(t, c.m))) return;
        taken.push(c.m);
        alternatives.push({ matrix: c.m, scale: c.scale, share: c.j.share, offset: c.j.offset.median, surface: c.j.offset.surface });
    });

    const { angle, shift } = sizeOf(pose, scale);
    return {
        matrix: pose,
        scale,
        coarse,
        mode,
        startShare,
        fitBefore,
        fitAfter,
        zones: report,
        usedZone,
        alternatives: alternatives.slice(0, 4),
        angleDeg: angle,
        shift,
        voxel,
        aborted: false
    };
};

export {
    scanOverlap,
    findZones,
    zoneOffset,
    zoneFit,
    composeAlign,
    autoVoxel,
    transformPoints,
    mul4,
    concat,
    capPoints,
    keyOf,
    decode,
    dilate,
    robustBox,
    spacingOf,
    IDENTITY,
    OverlapOptions,
    OverlapResult,
    Zone,
    ZoneOffset,
    ZoneReport,
    ComposeAlignOptions,
    ComposeAlignResult
};
