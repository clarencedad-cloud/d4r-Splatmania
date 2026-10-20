// Fine alignment ("Präzisieren") of one splat layer onto a reference layer,
// run after the coarse anchor-point alignment (src/align/point-align.ts).
//
// Robust point-to-plane ICP on splat centres:
// - only the overlap of both layers takes part (bounding box intersection plus
//   a margin), so parts that only one scan covers do not pull
// - coarse to fine over several voxel levels; each level voxel-downsamples
//   both clouds and shrinks the correspondence distance
// - reference normals from PCA of the voxel neighbourhood
// - trimmed + Huber weighted least squares, so floaters and non-overlapping
//   surfaces are ignored
// - rigid by default, optionally with uniform scale as 7th parameter
//
// Pure math on Float32Array xyz triples, no playcanvas dependency, so it runs
// in a web worker and in node tests. Positions are world space; the result is
// a world-space correction: newWorld = matrix * oldWorld.

type IcpOptions = {
    // solve uniform scale as well (default false)
    scale?: boolean,
    // finest voxel size in world units (default: overlap diagonal / 500)
    voxel?: number,
    // largest misplacement expected after the coarse alignment, in world
    // units; bounds the correspondence search (default: overlap diagonal / 50)
    maxError?: number,
    // number of coarse-to-fine levels, each doubling the voxel size (default 4)
    levels?: number,
    // iterations per level (default 30)
    iterations?: number,
    // fraction of worst correspondences dropped each iteration (default 0.25)
    trim?: number,
    // max points per cloud per level after downsampling (default 80000)
    maxPoints?: number,
    // overlap box margin as fraction of the overlap diagonal (default 0.02)
    margin?: number,
    // progress 0..1 and abort hook (checked once per iteration)
    onProgress?: (fraction: number) => void,
    shouldAbort?: () => boolean
};

type IcpStats = {
    // root mean square / median distance of moving points to the reference
    // surface (point-to-plane), over points within the inlier distance
    rms: number,
    median: number,
    // fraction of moving overlap points that found a reference partner
    overlap: number,
    pairs: number
};

type IcpResult = {
    // column-major 4x4 correction (same layout as playcanvas Mat4.data)
    matrix: number[],
    scale: number,
    // correction magnitude, for display
    angleDeg: number,
    translation: [number, number, number],
    before: IcpStats,
    after: IcpStats,
    // false when the result was not better than before (matrix is identity then)
    improved: boolean,
    iterations: number,
    aborted: boolean
};

// ---------------------------------------------------------------- utilities

type Box = { min: number[], max: number[] };

// robust bounds: per-axis 1st..99th percentile of a subsample, so a few
// floaters far out do not blow up the box (and with it the overlap region)
const boundsOf = (p: Float32Array): Box => {
    const n = p.length / 3;
    const stride = Math.max(1, Math.floor(n / 50000));
    const axes: number[][] = [[], [], []];
    for (let i = 0; i < n; i += stride) {
        for (let k = 0; k < 3; k++) axes[k].push(p[i * 3 + k]);
    }
    const min = [0, 0, 0];
    const max = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
        const s = axes[k].sort((a, b) => a - b);
        min[k] = s[Math.floor(s.length * 0.01)];
        max[k] = s[Math.min(s.length - 1, Math.floor(s.length * 0.99))];
    }
    return { min, max };
};

const filterBox = (p: Float32Array, box: Box) => {
    const out: number[] = [];
    for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if (x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1] && z >= box.min[2] && z <= box.max[2]) {
            out.push(x, y, z);
        }
    }
    return new Float32Array(out);
};

const cellKey = (ix: number, iy: number, iz: number) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;

// centroid per voxel
const downsample = (p: Float32Array, voxel: number) => {
    // per cell: sum x, y, z, count, then the cell coordinates (to detect hash collisions)
    const acc = new Map<number, number[]>();
    for (let i = 0; i < p.length; i += 3) {
        const ix = Math.floor(p[i] / voxel), iy = Math.floor(p[i + 1] / voxel), iz = Math.floor(p[i + 2] / voxel);
        const key = cellKey(ix, iy, iz);
        let a = acc.get(key);
        // a colliding distinct cell is dropped; rare and harmless for a downsample
        if (a && (a[4] !== ix || a[5] !== iy || a[6] !== iz)) {
            continue;
        }
        if (!a) {
            a = [0, 0, 0, 0, ix, iy, iz];
            acc.set(key, a);
        }
        a[0] += p[i]; a[1] += p[i + 1]; a[2] += p[i + 2]; a[3]++;
    }
    const out = new Float32Array(acc.size * 3);
    let o = 0;
    acc.forEach((a) => {
        out[o++] = a[0] / a[3];
        out[o++] = a[1] / a[3];
        out[o++] = a[2] / a[3];
    });
    return out;
};

// uniform hash grid for radius neighbour queries
class Grid {
    cell: number;
    points: Float32Array;
    buckets = new Map<number, number[]>();

    constructor(points: Float32Array, cell: number) {
        this.cell = cell;
        this.points = points;
        for (let i = 0; i < points.length / 3; i++) {
            const key = cellKey(Math.floor(points[i * 3] / cell), Math.floor(points[i * 3 + 1] / cell), Math.floor(points[i * 3 + 2] / cell));
            let b = this.buckets.get(key);
            if (!b) {
                b = [];
                this.buckets.set(key, b);
            }
            b.push(i);
        }
    }

    // nearest point within radius (radius <= cell), -1 if none
    nearest(x: number, y: number, z: number, radius: number) {
        const { cell, points } = this;
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
        let best = -1;
        let bestD = radius * radius;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const b = this.buckets.get(cellKey(cx + dx, cy + dy, cz + dz));
                    if (!b) continue;
                    for (let k = 0; k < b.length; k++) {
                        const j = b[k] * 3;
                        const ex = points[j] - x, ey = points[j + 1] - y, ez = points[j + 2] - z;
                        const d = ex * ex + ey * ey + ez * ez;
                        if (d < bestD) {
                            bestD = d;
                            best = b[k];
                        }
                    }
                }
            }
        }
        return best;
    }

    // all points within radius (radius <= cell)
    within(x: number, y: number, z: number, radius: number, out: number[]) {
        out.length = 0;
        const { cell, points } = this;
        const r2 = radius * radius;
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const b = this.buckets.get(cellKey(cx + dx, cy + dy, cz + dz));
                    if (!b) continue;
                    for (let k = 0; k < b.length; k++) {
                        const j = b[k] * 3;
                        const ex = points[j] - x, ey = points[j + 1] - y, ez = points[j + 2] - z;
                        if (ex * ex + ey * ey + ez * ez <= r2) out.push(b[k]);
                    }
                }
            }
        }
        return out;
    }
}

// smallest eigenvector of a symmetric 3x3 (row-major) via Jacobi rotations
const smallestEigenvector = (m: number[]) => {
    const a = m.slice();
    const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let sweep = 0; sweep < 30; sweep++) {
        const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
        if (off < 1e-24) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            const apq = a[p * 3 + q];
            if (Math.abs(apq) < 1e-300) continue;
            const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let k = 0; k < 3; k++) {
                const akp = a[k * 3 + p], akq = a[k * 3 + q];
                a[k * 3 + p] = c * akp - s * akq;
                a[k * 3 + q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = a[p * 3 + k], aqk = a[q * 3 + k];
                a[p * 3 + k] = c * apk - s * aqk;
                a[q * 3 + k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
                v[k * 3 + p] = c * vkp - s * vkq;
                v[k * 3 + q] = s * vkp + c * vkq;
            }
        }
    }
    let best = 0;
    for (let k = 1; k < 3; k++) if (a[k * 4] < a[best * 4]) best = k;
    return [v[best], v[3 + best], v[6 + best]];
};

// normals of a cloud from PCA of neighbours within radius; NaN when undefined
const estimateNormals = (grid: Grid, radius: number) => {
    const p = grid.points;
    const n = p.length / 3;
    const normals = new Float32Array(n * 3);
    const nb: number[] = [];
    for (let i = 0; i < n; i++) {
        grid.within(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], radius, nb);
        if (nb.length < 5) {
            normals[i * 3] = NaN;
            continue;
        }
        let mx = 0, my = 0, mz = 0;
        for (const j of nb) {
            mx += p[j * 3]; my += p[j * 3 + 1]; mz += p[j * 3 + 2];
        }
        mx /= nb.length; my /= nb.length; mz /= nb.length;
        const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (const j of nb) {
            const x = p[j * 3] - mx, y = p[j * 3 + 1] - my, z = p[j * 3 + 2] - mz;
            c[0] += x * x; c[1] += x * y; c[2] += x * z;
            c[4] += y * y; c[5] += y * z; c[8] += z * z;
        }
        c[3] = c[1]; c[6] = c[2]; c[7] = c[5];
        const e = smallestEigenvector(c);
        normals[i * 3] = e[0];
        normals[i * 3 + 1] = e[1];
        normals[i * 3 + 2] = e[2];
    }
    return normals;
};

// solve a small dense symmetric positive system in place (Gaussian elimination with pivoting)
const solve = (A: number[], b: number[], n: number) => {
    const M = A.slice();
    const x = b.slice();
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(M[r * n + col]) > Math.abs(M[piv * n + col])) piv = r;
        if (Math.abs(M[piv * n + col]) < 1e-30) return null;
        if (piv !== col) {
            for (let k = 0; k < n; k++) [M[col * n + k], M[piv * n + k]] = [M[piv * n + k], M[col * n + k]];
            [x[col], x[piv]] = [x[piv], x[col]];
        }
        for (let r = col + 1; r < n; r++) {
            const f = M[r * n + col] / M[col * n + col];
            for (let k = col; k < n; k++) M[r * n + k] -= f * M[col * n + k];
            x[r] -= f * x[col];
        }
    }
    for (let r = n - 1; r >= 0; r--) {
        let s = x[r];
        for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
        x[r] = s / M[r * n + r];
    }
    return x;
};

// rotation matrix (row-major 3x3) from a rotation vector
const rodrigues = (wx: number, wy: number, wz: number) => {
    const th = Math.hypot(wx, wy, wz);
    if (th < 1e-12) return [1, -wz, wy, wz, 1, -wx, -wy, wx, 1];
    const kx = wx / th, ky = wy / th, kz = wz / th;
    const c = Math.cos(th), s = Math.sin(th), v = 1 - c;
    return [
        c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
        ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
        kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v
    ];
};

const mul3 = (a: number[], b: number[]) => {
    const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return r;
};

// transform: x -> A x + t (A row-major 3x3, includes scale)
type Xf = { A: number[], t: number[] };

const apply = (xf: Xf, p: Float32Array) => {
    const { A, t } = xf;
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        out[i] = A[0] * x + A[1] * y + A[2] * z + t[0];
        out[i + 1] = A[3] * x + A[4] * y + A[5] * z + t[1];
        out[i + 2] = A[6] * x + A[7] * y + A[8] * z + t[2];
    }
    return out;
};

const quantile = (values: number[], q: number) => {
    if (!values.length) return 0;
    const s = values.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// point-to-plane distances of moving points to the reference surface
const measure = (src: Float32Array, grid: Grid, normals: Float32Array, radius: number): IcpStats => {
    const d: number[] = [];
    const n = src.length / 3;
    for (let i = 0; i < n; i++) {
        const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
        const j = grid.nearest(x, y, z, radius);
        if (j < 0 || Number.isNaN(normals[j * 3])) continue;
        const q = grid.points;
        d.push(Math.abs((x - q[j * 3]) * normals[j * 3] + (y - q[j * 3 + 1]) * normals[j * 3 + 1] + (z - q[j * 3 + 2]) * normals[j * 3 + 2]));
    }
    const rms = d.length ? Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length) : Infinity;
    return { rms, median: d.length ? quantile(d, 0.5) : Infinity, overlap: n ? d.length / n : 0, pairs: d.length };
};

// ---------------------------------------------------------------- refine

/**
 * Refine the alignment of `moving` onto `reference` (both world-space xyz
 * triples of splat centres, already coarsely aligned). Returns the world-space
 * correction to apply to the moving layer.
 */
const refineAlignment = (moving: Float32Array, reference: Float32Array, options: IcpOptions = {}): IcpResult => {
    const useScale = options.scale ?? false;
    const levels = Math.max(1, options.levels ?? 4);
    const iterations = options.iterations ?? 30;
    const trim = options.trim ?? 0.25;
    const maxPoints = options.maxPoints ?? 80000;

    // overlap region: bounding box intersection plus margin
    const bm = boundsOf(moving);
    const br = boundsOf(reference);
    const lo = [0, 1, 2].map(k => Math.max(bm.min[k], br.min[k]));
    const hi = [0, 1, 2].map(k => Math.min(bm.max[k], br.max[k]));
    if (lo.some((v, k) => v > hi[k])) {
        throw new Error('refineAlignment: the layers do not overlap');
    }
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    const margin = diag * (options.margin ?? 0.02);
    const box: Box = { min: lo.map(v => v - margin), max: hi.map(v => v + margin) };

    const src0 = filterBox(moving, box);
    const dst0 = filterBox(reference, box);
    if (src0.length < 30 || dst0.length < 30) {
        throw new Error('refineAlignment: too few points in the overlap');
    }

    const fineVoxel = options.voxel ?? diag / 500;
    const maxError = options.maxError ?? diag / 50;

    // per level: downsampled clouds, grid, normals. Coarsest first.
    type Level = { voxel: number, src: Float32Array, grid: Grid, normals: Float32Array, radius: number };
    const prepared: Level[] = [];
    for (let l = levels - 1; l >= 0; l--) {
        let voxel = fineVoxel * (1 << l);
        let src = downsample(src0, voxel);
        let dst = downsample(dst0, voxel);
        while (src.length / 3 > maxPoints || dst.length / 3 > maxPoints) {
            voxel *= 1.25;
            src = downsample(src0, voxel);
            dst = downsample(dst0, voxel);
        }
        // correspondence distance: the expected coarse error at the coarsest
        // level, then shrinking with the voxel size (never below 3 voxels)
        const radius = Math.max(voxel * 3, l === levels - 1 ? maxError : Math.min(maxError, voxel * 4));
        const grid = new Grid(dst, Math.max(radius, voxel * 2.5));
        prepared.push({ voxel, src, grid, normals: estimateNormals(grid, voxel * 2.5), radius });
    }
    const finest = prepared[prepared.length - 1];

    let xf: Xf = { A: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
    const before = measure(finest.src, finest.grid, finest.normals, finest.radius);

    const totalSteps = levels * iterations;
    let step = 0;
    let usedIterations = 0;
    let aborted = false;
    const nParams = useScale ? 7 : 6;

    for (const level of prepared) {
        const { src, grid, normals, radius } = level;
        const q = grid.points;
        for (let it = 0; it < iterations; it++, step++) {
            if (options.shouldAbort?.()) {
                aborted = true;
                break;
            }
            options.onProgress?.(step / totalSteps);
            usedIterations++;

            const cur = apply(xf, src);
            const pairs: number[] = []; // [srcIndex, dstIndex, residual]
            const res: number[] = [];
            for (let i = 0; i < cur.length / 3; i++) {
                const j = grid.nearest(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2], radius);
                if (j < 0 || Number.isNaN(normals[j * 3])) continue;
                const r = (cur[i * 3] - q[j * 3]) * normals[j * 3] + (cur[i * 3 + 1] - q[j * 3 + 1]) * normals[j * 3 + 1] + (cur[i * 3 + 2] - q[j * 3 + 2]) * normals[j * 3 + 2];
                pairs.push(i, j, r);
                res.push(Math.abs(r));
            }
            if (res.length < nParams * 4) break;

            const cut = quantile(res, 1 - trim);
            const huber = Math.max(quantile(res, 0.5) * 1.5, 1e-9);

            // centroid of the used moving points, so scale/rotation decouple from translation
            let cx = 0, cy = 0, cz = 0, cn = 0;
            for (let k = 0; k < pairs.length; k += 3) {
                if (Math.abs(pairs[k + 2]) > cut) continue;
                const i = pairs[k];
                cx += cur[i * 3]; cy += cur[i * 3 + 1]; cz += cur[i * 3 + 2]; cn++;
            }
            cx /= cn; cy /= cn; cz /= cn;

            const H = new Array(nParams * nParams).fill(0);
            const g = new Array(nParams).fill(0);
            const J = new Array(nParams);
            for (let k = 0; k < pairs.length; k += 3) {
                const r = pairs[k + 2];
                const ar = Math.abs(r);
                if (ar > cut) continue;
                const i = pairs[k], j = pairs[k + 1];
                const px = cur[i * 3] - cx, py = cur[i * 3 + 1] - cy, pz = cur[i * 3 + 2] - cz;
                const nx = normals[j * 3], ny = normals[j * 3 + 1], nz = normals[j * 3 + 2];
                // d/dω of n·(ω×p) = p×n ; d/dt = n ; d/dσ = n·p
                J[0] = py * nz - pz * ny;
                J[1] = pz * nx - px * nz;
                J[2] = px * ny - py * nx;
                J[3] = nx; J[4] = ny; J[5] = nz;
                if (useScale) J[6] = nx * px + ny * py + nz * pz;
                const w = ar <= huber ? 1 : huber / ar;
                for (let a = 0; a < nParams; a++) {
                    g[a] -= w * J[a] * r;
                    for (let b = a; b < nParams; b++) H[a * nParams + b] += w * J[a] * J[b];
                }
            }
            // symmetric fill + light damping keeps unconstrained directions (e.g. sliding along a plane) still
            let trace = 0;
            for (let a = 0; a < nParams; a++) trace += H[a * nParams + a];
            for (let a = 0; a < nParams; a++) {
                for (let b = 0; b < a; b++) H[a * nParams + b] = H[b * nParams + a];
                H[a * nParams + a] += 1e-6 * trace / nParams;
            }
            const x = solve(H, g, nParams);
            if (!x) break;

            // incremental transform D(p) = c + (1+σ) R(ω) (p - c) + t, composed onto xf
            const sigma = useScale ? x[6] : 0;
            const R = rodrigues(x[0], x[1], x[2]).map(v => v * (1 + sigma));
            const c = [cx, cy, cz];
            const A = mul3(R, xf.A);
            const tOld = xf.t;
            const t = [0, 1, 2].map((row) => {
                let s = 0;
                for (let k = 0; k < 3; k++) s += R[row * 3 + k] * (tOld[k] - c[k]);
                return s + c[row] + x[3 + row];
            });
            xf = { A, t };

            const angle = Math.hypot(x[0], x[1], x[2]);
            const move = Math.hypot(x[3], x[4], x[5]);
            if (angle < 1e-5 && move < level.voxel * 1e-3 && Math.abs(sigma) < 1e-6) break;
        }
        if (aborted) break;
    }
    options.onProgress?.(1);

    const after = measure(apply(xf, finest.src), finest.grid, finest.normals, finest.radius);

    // only report an improvement if the surface distance got smaller and the
    // overlap did not collapse (which would hint at sliding off)
    const improved = !aborted && after.median <= before.median && after.overlap >= before.overlap * 0.9;
    if (!improved) {
        xf = { A: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
    }

    const { A, t } = xf;
    const scale = Math.cbrt(A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]));
    const cosAngle = Math.max(-1, Math.min(1, ((A[0] + A[4] + A[8]) / scale - 1) / 2));

    return {
        matrix: [A[0], A[3], A[6], 0, A[1], A[4], A[7], 0, A[2], A[5], A[8], 0, t[0], t[1], t[2], 1],
        scale,
        angleDeg: Math.acos(cosAngle) * 180 / Math.PI,
        translation: [t[0], t[1], t[2]],
        before,
        after: improved ? after : before,
        improved,
        iterations: usedIterations,
        aborted
    };
};

export { refineAlignment, IcpOptions, IcpResult, IcpStats };
