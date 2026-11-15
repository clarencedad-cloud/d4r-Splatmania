import { Vec3 } from 'playcanvas';

import type { CoverageField } from './shot-types';

// Density voxel grid over the splat centres (opacity weighted) for the shot
// generator: where the data is, how far a point is from it and how well an
// eye position sees a subject.

// a voxel is dense from this share of the weighted median voxel weight on, so
// thin floaters (a few splats per voxel) never count as geometry
const DENSE_SHARE = 0.125;

// occupancy at which a voxel counts as dense
const DENSE = 0.5;

// light that passes a dense sample in front of the subject
const OCCLUDER_ABSORB = 0.6;

// rays per visibility query: the centre plus a ring around the target
const RING = 8;

const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);

class VoxelCoverage implements CoverageField {
    readonly cellSize: number;

    private min: Vec3;
    private nx: number;
    private ny: number;
    private nz: number;
    private occ: Float32Array;
    // distance of each voxel centre to the nearest dense voxel centre (scene units)
    private dist: Float32Array;
    private anyDense: boolean;

    constructor(min: Vec3, cellSize: number, nx: number, ny: number, nz: number, occ: Float32Array) {
        this.min = min.clone();
        this.cellSize = cellSize;
        this.nx = nx;
        this.ny = ny;
        this.nz = nz;
        this.occ = occ;
        this.anyDense = occ.some(v => v >= DENSE);
        this.dist = this.distanceTransform();
    }

    occupancy(p: Vec3): number {
        const i = this.index(p.x, p.y, p.z);
        return i < 0 ? 0 : this.occ[i];
    }

    clearance(p: Vec3): number {
        if (!this.anyDense) return Infinity;
        const { min, cellSize, nx, ny, nz } = this;

        // outside the grid: distance to the grid box plus the inner distance at
        // the closest point (a lower bound, the box is convex)
        const cx = Math.min(Math.max(p.x, min.x), min.x + nx * cellSize);
        const cy = Math.min(Math.max(p.y, min.y), min.y + ny * cellSize);
        const cz = Math.min(Math.max(p.z, min.z), min.z + nz * cellSize);
        const outside = Math.hypot(p.x - cx, p.y - cy, p.z - cz);

        const i = this.index(cx, cy, cz);
        if (i >= 0 && this.occ[i] >= DENSE && outside === 0) return 0;

        // trilinear between voxel centres, minus half a voxel to reach the
        // dense voxel's face instead of its centre
        const inner = Math.max(0, this.sampleDist(cx, cy, cz) - 0.5 * cellSize);
        return Math.hypot(outside, inner);
    }

    visibility(eye: Vec3, target: Vec3, radius?: number): number {
        const dx = target.x - eye.x;
        const dy = target.y - eye.y;
        const dz = target.z - eye.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-6) return 0;

        const r = radius > 0 ? radius : 0.35 * len;
        const fx = dx / len, fy = dy / len, fz = dz / len;

        // basis perpendicular to the view direction
        let ux, uy, uz;
        if (Math.abs(fy) < 0.9) {
            // up x f
            ux = fz; uy = 0; uz = -fx;
        } else {
            // right x f
            ux = 0; uy = -fz; uz = fy;
        }
        const ul = Math.hypot(ux, uy, uz);
        ux /= ul; uy /= ul; uz /= ul;
        const vx = fy * uz - fz * uy;
        const vy = fz * ux - fx * uz;
        const vz = fx * uy - fy * ux;

        const ring = 0.45 * Math.min(r, 0.8 * len);
        let sum = this.ray(eye, target.x, target.y, target.z, target, r);
        for (let k = 0; k < RING; k++) {
            const a = (k / RING) * Math.PI * 2;
            const ox = Math.cos(a) * ring, oy = Math.sin(a) * ring;
            sum += this.ray(
                eye,
                target.x + ux * ox + vx * oy,
                target.y + uy * ox + vy * oy,
                target.z + uz * ox + vz * oy,
                target,
                r
            );
        }
        return sum / (RING + 1);
    }

    // one ray from the eye through an aim point near the target: light that
    // reaches the subject sphere, times whether it finds data on the near side
    private ray(eye: Vec3, ax: number, ay: number, az: number, target: Vec3, r: number) {
        const dx = ax - eye.x, dy = ay - eye.y, dz = az - eye.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-6) return 0;
        const fx = dx / len, fy = dy / len, fz = dz / len;

        // depth of the target along this ray and the end of the subject zone
        const tTarget = (target.x - eye.x) * fx + (target.y - eye.y) * fy + (target.z - eye.z) * fz;
        const tEnd = tTarget + r;

        // clip to the grid box
        const { min, cellSize, nx, ny, nz } = this;
        let t0 = 0, t1 = tEnd;
        const slab = (o: number, d: number, lo: number, hi: number) => {
            if (Math.abs(d) < 1e-12) {
                if (o < lo || o > hi) t1 = -1;
                return;
            }
            let a = (lo - o) / d, b = (hi - o) / d;
            if (a > b) {
                const t = a; a = b; b = t;
            }
            if (a > t0) t0 = a;
            if (b < t1) t1 = b;
        };
        slab(eye.x, fx, min.x, min.x + nx * cellSize);
        slab(eye.y, fy, min.y, min.y + ny * cellSize);
        slab(eye.z, fz, min.z, min.z + nz * cellSize);

        // no data along the ray at all
        if (t1 <= t0) return 0.2;

        const step = 0.5 * cellSize;
        const steps = Math.min(4096, Math.ceil((t1 - t0) / step));
        const r2 = r * r;
        let transmit = 1;
        for (let s = 0; s <= steps; s++) {
            const t = Math.min(t1, t0 + s * step);
            const px = eye.x + fx * t, py = eye.y + fy * t, pz = eye.z + fz * t;
            const i = this.index(px, py, pz);
            if (i < 0) continue;
            const o = this.occ[i];
            const qx = px - target.x, qy = py - target.y, qz = pz - target.z;
            if (qx * qx + qy * qy + qz * qz > r2) {
                // in front of the subject: everything dense is an occluder,
                // floaters dim the view a little
                if (o > 0) transmit *= 1 - Math.min(1, o) * OCCLUDER_ABSORB;
                if (transmit < 0.01) return 0;
            } else if (o >= DENSE) {
                // data on the side facing the eye, or only further back
                return transmit * (t <= tTarget + 0.1 * r ? 1 : 0.55);
            }
        }
        return transmit * 0.2;
    }

    private index(x: number, y: number, z: number) {
        const { min, cellSize, nx, ny, nz } = this;
        const ix = Math.floor((x - min.x) / cellSize);
        const iy = Math.floor((y - min.y) / cellSize);
        const iz = Math.floor((z - min.z) / cellSize);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return -1;
        return (iz * ny + iy) * nx + ix;
    }

    private sampleDist(x: number, y: number, z: number) {
        const { min, cellSize, nx, ny, nz, dist } = this;
        const u = Math.min(Math.max((x - min.x) / cellSize - 0.5, 0), nx - 1);
        const v = Math.min(Math.max((y - min.y) / cellSize - 0.5, 0), ny - 1);
        const w = Math.min(Math.max((z - min.z) / cellSize - 0.5, 0), nz - 1);
        const x0 = Math.floor(u), y0 = Math.floor(v), z0 = Math.floor(w);
        const x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, ny - 1), z1 = Math.min(z0 + 1, nz - 1);
        const fx = u - x0, fy = v - y0, fz = w - z0;
        const at = (ix: number, iy: number, iz: number) => dist[(iz * ny + iy) * nx + ix];
        const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
        const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
        const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
        const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
        return ((c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz);
    }

    // two-pass chamfer distance (26 neighbours, weights 1 / sqrt2 / sqrt3)
    private distanceTransform() {
        const { nx, ny, nz, occ, cellSize } = this;
        const n = nx * ny * nz;
        const d = new Float32Array(n);
        const far = (nx + ny + nz) * 2;
        for (let i = 0; i < n; i++) d[i] = occ[i] >= DENSE ? 0 : far;

        // neighbours before a voxel in raster order; the backward pass mirrors them
        const offsets: [number, number, number, number][] = [];
        for (let oz = -1; oz <= 1; oz++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    const linear = (oz * ny + oy) * nx + ox;
                    if (linear >= 0) continue;
                    const k = Math.abs(ox) + Math.abs(oy) + Math.abs(oz);
                    offsets.push([ox, oy, oz, k === 1 ? 1 : (k === 2 ? SQRT2 : SQRT3)]);
                }
            }
        }

        const pass = (sign: number) => {
            const zs = sign > 0 ? 0 : nz - 1, ze = sign > 0 ? nz : -1;
            const ys = sign > 0 ? 0 : ny - 1, ye = sign > 0 ? ny : -1;
            const xs = sign > 0 ? 0 : nx - 1, xe = sign > 0 ? nx : -1;
            for (let z = zs; z !== ze; z += sign) {
                for (let y = ys; y !== ye; y += sign) {
                    for (let x = xs; x !== xe; x += sign) {
                        const i = (z * ny + y) * nx + x;
                        let best = d[i];
                        if (best === 0) continue;
                        for (const [ox, oy, oz, w] of offsets) {
                            const X = x + ox * sign, Y = y + oy * sign, Z = z + oz * sign;
                            if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
                            const v = d[(Z * ny + Y) * nx + X] + w;
                            if (v < best) best = v;
                        }
                        d[i] = best;
                    }
                }
            }
        };
        pass(1);
        pass(-1);

        for (let i = 0; i < n; i++) d[i] *= cellSize;
        return d;
    }
}

const buildCoverageField = (points: Float32Array, weights: Float32Array, bounds: { min: Vec3, max: Vec3 }, resolution = 64): CoverageField => {
    const { min, max } = bounds;
    const ex = Math.max(0, max.x - min.x);
    const ey = Math.max(0, max.y - min.y);
    const ez = Math.max(0, max.z - min.z);
    const res = Math.max(4, Math.min(256, Math.floor(resolution) || 64));
    const cellSize = Math.max(ex, ey, ez, 1e-6) / res;
    const nx = Math.max(1, Math.ceil(ex / cellSize));
    const ny = Math.max(1, Math.ceil(ey / cellSize));
    const nz = Math.max(1, Math.ceil(ez / cellSize));

    const grid = new Float32Array(nx * ny * nz);
    const count = Math.floor(points.length / 3);
    for (let i = 0; i < count; i++) {
        const w = weights && i < weights.length ? weights[i] : 1;
        if (!(w > 0)) continue;
        const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
        if (!(x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z)) continue;
        const ix = Math.min(nx - 1, Math.floor((x - min.x) / cellSize));
        const iy = Math.min(ny - 1, Math.floor((y - min.y) / cellSize));
        const iz = Math.min(nz - 1, Math.floor((z - min.z) / cellSize));
        grid[(iz * ny + iy) * nx + ix] += w;
    }

    // weighted median of the voxel weights: half the total weight sits in
    // voxels at least this heavy, independent of how many light voxels exist
    const filled = grid.filter(v => v > 0).sort();
    let total = 0;
    for (let i = 0; i < filled.length; i++) total += filled[i];
    let median = 0;
    for (let i = filled.length - 1, acc = 0; i >= 0; i--) {
        acc += filled[i];
        if (acc >= total * 0.5) {
            median = filled[i];
            break;
        }
    }

    const dense = median * DENSE_SHARE;
    const occ = new Float32Array(grid.length);
    if (dense > 0) {
        for (let i = 0; i < grid.length; i++) {
            occ[i] = Math.min(1, grid[i] / dense * DENSE);
        }
    }

    return new VoxelCoverage(min, cellSize, nx, ny, nz, occ);
};

export { buildCoverageField };
