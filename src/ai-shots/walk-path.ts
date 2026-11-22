import { Vec3 } from 'playcanvas';

import { ease, easeInverse } from './shot-generator';
import type { GeneratedKey, ShotModifier, ShotProposal } from './shot-types';
import { CubicSpline } from '../anim/spline';

// Walk-through ("Begehung"): an ego view at eye height above the ground,
// walking from waypoint to waypoint at walking pace while the view looks
// ahead along the way. Waypoints are clicked on the ground; optionally the
// way between them is found through the free space (A* on a walkability
// grid). The keys stay sparse (waypoints plus where the curve needs one), the
// gait bob and handheld shake come from the camera modifier
// (src/camera-modifier.ts), not from dense keys.
//
// Units: everything here is in scene units; metres come in through
// metersPerUnit (src/scene-scale.ts).

type WalkFieldOptions = {
    metersPerUnit: number;
};

// what a standing person needs above the ground (metres)
const HEADROOM_FROM = 0.5;
const HEADROOM_TO = 1.8;
// vertical search band around a height hint (metres)
const BAND_BELOW = 3;
const BAND_ABOVE = 0.6;
// histogram bin (metres)
const BIN = 0.1;
// steepest step between neighbouring routing cells (metres) on top of a 35
// degree slope
const MAX_STEP = 0.35;
const MAX_SLOPE = Math.tan(35 * Math.PI / 180);
// A* gives up after this many expanded cells
const MAX_EXPANSIONS = 250000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Ground = { y: number, standing: boolean };

/**
 * Splat centres bucketed on a horizontal grid for ground and headroom
 * queries: a vertical histogram of the points in a small disc around (x, z).
 */
class WalkField {
    readonly cell: number;
    readonly mpu: number;
    private minX: number;
    private minZ: number;
    private nx: number;
    private nz: number;
    private start: Int32Array;
    private order: Uint32Array;
    private points: Float32Array;
    private weights: Float32Array;
    private cache = new Map<string, Ground | null>();

    constructor(points: Float32Array, weights: Float32Array, bounds: { min: Vec3, max: Vec3 }, opts: WalkFieldOptions) {
        this.mpu = opts.metersPerUnit > 0 ? opts.metersPerUnit : 1;
        this.points = points;
        this.weights = weights;
        const ex = Math.max(1e-6, bounds.max.x - bounds.min.x);
        const ez = Math.max(1e-6, bounds.max.z - bounds.min.z);
        // about 400 cells along the longer side, 5 cm .. 1 m
        const meters = clamp(Math.max(ex, ez) * this.mpu / 400, 0.05, 1);
        this.cell = meters / this.mpu;
        this.minX = bounds.min.x;
        this.minZ = bounds.min.z;
        this.nx = Math.max(1, Math.ceil(ex / this.cell));
        this.nz = Math.max(1, Math.ceil(ez / this.cell));

        const count = Math.floor(points.length / 3);
        const cells = this.nx * this.nz;
        const start = new Int32Array(cells + 1);
        const cellOf = new Int32Array(count);
        for (let i = 0; i < count; i++) {
            const c = this.cellIndex(points[i * 3], points[i * 3 + 2]);
            cellOf[i] = c;
            if (c >= 0) start[c + 1]++;
        }
        for (let c = 0; c < cells; c++) start[c + 1] += start[c];
        const cursor = start.slice(0, cells);
        const order = new Uint32Array(start[cells]);
        for (let i = 0; i < count; i++) {
            const c = cellOf[i];
            if (c >= 0) order[cursor[c]++] = i;
        }
        this.start = start;
        this.order = order;
    }

    private cellIndex(x: number, z: number) {
        const ix = Math.floor((x - this.minX) / this.cell);
        const iz = Math.floor((z - this.minZ) / this.cell);
        if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
        return iz * this.nx + ix;
    }

    /**
     * The ground near height yHint at (x, z): the top of a dense layer of
     * splats. Prefers a layer with headroom above (a person can stand there)
     * closest to the hint. Null when no layer is found.
     */
    groundAt(x: number, z: number, yHint: number, radius?: number, maxAbove = BAND_ABOVE): Ground | null {
        const key = `${Math.round(x / (0.5 * this.cell))}|${Math.round(z / (0.5 * this.cell))}|${Math.round(yHint * this.mpu / 0.25)}|${radius ?? ''}|${maxAbove}`;
        if (this.cache.has(key)) return this.cache.get(key);
        const result = this.queryGround(x, z, yHint, radius, maxAbove);
        if (this.cache.size > 200000) this.cache.clear();
        this.cache.set(key, result);
        return result;
    }

    private queryGround(x: number, z: number, yHint: number, radius: number | undefined, maxAbove: number): Ground | null {
        const u = 1 / this.mpu;
        const r = Math.max(radius ?? 0, 1.2 * this.cell, 0.2 * u);
        const lo = yHint - BAND_BELOW * u;
        const hi = yHint + BAND_ABOVE * u + HEADROOM_TO * u;
        const bin = BIN * u;
        const bins = Math.max(1, Math.ceil((hi - lo) / bin));
        const hist = new Float32Array(bins);
        const sumY = new Float32Array(bins);
        const reach = Math.ceil(r / this.cell);
        const cx = Math.floor((x - this.minX) / this.cell);
        const cz = Math.floor((z - this.minZ) / this.cell);
        const r2 = r * r;
        let total = 0;
        for (let iz = cz - reach; iz <= cz + reach; iz++) {
            if (iz < 0 || iz >= this.nz) continue;
            for (let ix = cx - reach; ix <= cx + reach; ix++) {
                if (ix < 0 || ix >= this.nx) continue;
                const c = iz * this.nx + ix;
                for (let k = this.start[c]; k < this.start[c + 1]; k++) {
                    const i = this.order[k];
                    const px = this.points[i * 3];
                    const py = this.points[i * 3 + 1];
                    const pz = this.points[i * 3 + 2];
                    if (py < lo || py >= hi) continue;
                    const dx = px - x;
                    const dz = pz - z;
                    if (dx * dx + dz * dz > r2) continue;
                    const b = Math.min(bins - 1, Math.floor((py - lo) / bin));
                    const w = this.weights[i] ?? 1;
                    hist[b] += w;
                    sumY[b] += w * py;
                    total += w;
                }
            }
        }
        if (total <= 0) return null;
        let peak = 0;
        for (let b = 0; b < bins; b++) peak = Math.max(peak, hist[b]);
        const threshold = Math.max(0.6, 0.12 * peak);
        const dense = (b: number) => b >= 0 && b < bins && hist[b] >= threshold;

        const headFrom = Math.floor(HEADROOM_FROM * u / bin);
        const headTo = Math.ceil(HEADROOM_TO * u / bin);
        // headroom is blocked by enough splats in the whole band above, not
        // only by dense bins: vertical surfaces (walls, the side of a car)
        // spread thinly over many bins. A few floaters do not block
        const prefix = new Float32Array(bins + 1);
        for (let b = 0; b < bins; b++) prefix[b + 1] = prefix[b] + hist[b];
        const blocking = Math.max(1.5, 0.15 * peak);
        let best: Ground | null = null;
        let bestCost = Infinity;
        let fallback: Ground | null = null;
        let fallbackCost = Infinity;
        // a surface to stand on is horizontal: a dense bin with much less
        // right above it (the top of a vertical wall's run is not one)
        const above = (b: number) => Math.max(b + 1 < bins ? hist[b + 1] : 0, b + 2 < bins ? hist[b + 2] : 0, b + 3 < bins ? hist[b + 3] : 0);
        for (let b = 0; b < bins; b++) {
            if (!dense(b) || hist[b] < 2 * above(b)) continue;
            const y = sumY[b] / hist[b];
            // only surfaces up to a little above the hint
            if (y > yHint + maxAbove * u) continue;
            const from = Math.min(bins, b + headFrom);
            const to = Math.min(bins, b + headTo + 1);
            const free = prefix[to] - prefix[from] < blocking;
            const cost = Math.abs(y - yHint);
            if (free && cost < bestCost) {
                bestCost = cost;
                best = { y, standing: true };
            }
            if (cost < fallbackCost) {
                fallbackCost = cost;
                fallback = { y, standing: false };
            }
        }
        return best ?? fallback;
    }

    // a person fits at (x, z) on ground near yHint
    walkable(x: number, z: number, yHint: number, bodyRadius: number) {
        const g = this.groundAt(x, z, yHint, bodyRadius);
        return g && g.standing ? g : null;
    }

    // splats around a point (a ball of radius r): something solid there.
    // A few floaters do not count
    solid(x: number, y: number, z: number, r: number) {
        const reach = Math.ceil(r / this.cell);
        const cx = Math.floor((x - this.minX) / this.cell);
        const cz = Math.floor((z - this.minZ) / this.cell);
        const r2 = r * r;
        let weight = 0;
        for (let iz = cz - reach; iz <= cz + reach; iz++) {
            if (iz < 0 || iz >= this.nz) continue;
            for (let ix = cx - reach; ix <= cx + reach; ix++) {
                if (ix < 0 || ix >= this.nx) continue;
                const c = iz * this.nx + ix;
                for (let k = this.start[c]; k < this.start[c + 1]; k++) {
                    const i = this.order[k];
                    const dx = this.points[i * 3] - x;
                    const dy = this.points[i * 3 + 1] - y;
                    const dz = this.points[i * 3 + 2] - z;
                    if (dx * dx + dy * dy + dz * dz > r2) continue;
                    weight += this.weights[i] ?? 1;
                    if (weight >= 2) return true;
                }
            }
        }
        return false;
    }
}

type RouteOptions = {
    bodyRadius: number;
};

// A* on a horizontal grid from a to b (ground points); null when no way is
// found. The cost prefers the middle of free areas
const findRoute = (field: WalkField, a: Vec3, b: Vec3, opts: RouteOptions): Vec3[] | null => {
    const u = 1 / field.mpu;
    const step = Math.max(field.cell, 0.75 * opts.bodyRadius, 0.25 * u);
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    // search window: around both points, generous detours allowed
    const margin = Math.max(8 * u, 0.6 * span);
    const minX = Math.min(a.x, b.x) - margin;
    const minZ = Math.min(a.z, b.z) - margin;
    const nx = Math.max(2, Math.ceil((Math.max(a.x, b.x) + margin - minX) / step));
    const nz = Math.max(2, Math.ceil((Math.max(a.z, b.z) + margin - minZ) / step));
    if (nx * nz > 4000000) return null;
    const toCell = (p: Vec3) => [clamp(Math.round((p.x - minX) / step), 0, nx - 1), clamp(Math.round((p.z - minZ) / step), 0, nz - 1)];
    const [sx, sz] = toCell(a);
    const [tx, tz] = toCell(b);
    const index = (x: number, z: number) => z * nx + x;

    const ground = new Float32Array(nx * nz).fill(NaN);
    // 0 unknown, 1 walkable, 2 blocked
    const state = new Uint8Array(nx * nz);
    const g = new Float32Array(nx * nz).fill(Infinity);
    const parent = new Int32Array(nx * nz).fill(-1);
    const closed = new Uint8Array(nx * nz);

    const probe = (x: number, z: number, yHint: number) => {
        const i = index(x, z);
        if (state[i] === 0) {
            const hit = field.walkable(minX + x * step, minZ + z * step, yHint, opts.bodyRadius);
            state[i] = hit ? 1 : 2;
            if (hit) ground[i] = hit.y;
        }
        return state[i] === 1;
    };

    // the end points count as walkable at their own height
    state[index(sx, sz)] = 1;
    ground[index(sx, sz)] = a.y;
    state[index(tx, tz)] = 1;
    ground[index(tx, tz)] = b.y;

    // binary heap on f
    const heap: number[] = [];
    const f = new Float32Array(nx * nz).fill(Infinity);
    const push = (i: number) => {
        heap.push(i);
        let k = heap.length - 1;
        while (k > 0) {
            const p = (k - 1) >> 1;
            if (f[heap[p]] <= f[heap[k]]) break;
            [heap[p], heap[k]] = [heap[k], heap[p]];
            k = p;
        }
    };
    const pop = () => {
        const top = heap[0];
        const end = heap.pop();
        if (heap.length > 0) {
            heap[0] = end;
            let k = 0;
            for (;;) {
                const l = 2 * k + 1;
                const r = l + 1;
                let m = k;
                if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
                if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
                if (m === k) break;
                [heap[m], heap[k]] = [heap[k], heap[m]];
                k = m;
            }
        }
        return top;
    };
    const h = (x: number, z: number) => {
        const dx = Math.abs(x - tx);
        const dz = Math.abs(z - tz);
        return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * step;
    };

    const s = index(sx, sz);
    const t = index(tx, tz);
    g[s] = 0;
    f[s] = h(sx, sz);
    push(s);
    let expansions = 0;
    const maxRise = (MAX_STEP * u) + MAX_SLOPE * step;
    while (heap.length > 0 && expansions < MAX_EXPANSIONS) {
        const i = pop();
        if (closed[i]) continue;
        closed[i] = 1;
        expansions++;
        if (i === t) break;
        const x = i % nx;
        const z = (i - x) / nx;
        const y0 = ground[i];
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dz) continue;
                const X = x + dx;
                const Z = z + dz;
                if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
                const j = index(X, Z);
                if (closed[j]) continue;
                if (!probe(X, Z, y0)) continue;
                if (Math.abs(ground[j] - y0) > maxRise) continue;
                // diagonal moves must not cut a blocked corner
                if (dx && dz && (!probe(x + dx, z, y0) || !probe(x, z + dz, y0))) continue;
                // keep away from obstacles: count blocked neighbours
                let near = 0;
                for (let oz = -1; oz <= 1; oz++) {
                    for (let ox = -1; ox <= 1; ox++) {
                        const qx = X + ox;
                        const qz = Z + oz;
                        if (qx < 0 || qz < 0 || qx >= nx || qz >= nz) continue;
                        if (!probe(qx, qz, ground[j])) near++;
                    }
                }
                const length = (dx && dz ? Math.SQRT2 : 1) * step;
                const cost = g[i] + length * (1 + 0.5 * near / 8) + Math.abs(ground[j] - y0);
                if (cost < g[j]) {
                    g[j] = cost;
                    parent[j] = i;
                    f[j] = cost + h(X, Z);
                    push(j);
                }
            }
        }
    }
    if (parent[t] === -1 && t !== s) return null;

    const cells: number[] = [];
    for (let i = t; i !== -1; i = parent[i]) cells.push(i);
    cells.reverse();
    const route = cells.map((i) => {
        const x = i % nx;
        const z = (i - x) / nx;
        return new Vec3(minX + x * step, ground[i], minZ + z * step);
    });
    route[0] = a.clone();
    route[route.length - 1] = b.clone();

    // string pulling: drop points while the straight way stays walkable
    const clear = (p: Vec3, q: Vec3) => {
        const n = Math.ceil(p.distance(q) / (0.5 * step));
        for (let k = 1; k < n; k++) {
            const t2 = k / n;
            const x = p.x + (q.x - p.x) * t2;
            const z = p.z + (q.z - p.z) * t2;
            const y = p.y + (q.y - p.y) * t2;
            const hit = field.walkable(x, z, y, opts.bodyRadius);
            if (!hit || Math.abs(hit.y - y) > maxRise * 2) return false;
        }
        return true;
    };
    const pulled = [route[0]];
    let anchor = 0;
    while (anchor < route.length - 1) {
        let next = anchor + 1;
        for (let k = route.length - 1; k > anchor + 1; k--) {
            if (clear(route[anchor], route[k])) {
                next = k;
                break;
            }
        }
        pulled.push(route[next]);
        anchor = next;
    }
    return pulled;
};

type WalkOptions = {
    // clicked ground points (world)
    points: Vec3[];
    fps: number;
    fov: number;
    metersPerUnit: number;
    // metres / metres per second
    eyeHeight: number;
    speed: number;
    lookAhead: number;
    // find the way between the points through the free space
    autoRoute: boolean;
    field?: WalkField | null;
    modifier: ShotModifier;
};

type WalkResult = ShotProposal & {
    route: Vec3[];
    walkLength: number;
    // the waypoints on the ground the walk uses (a click on a car or a roof
    // moves to the street)
    waypoints: Vec3[];
};

// corner cutting on the route, the ends stay. A corner is only cut when the
// short cut stays clear (no rounding into a wall or a car)
const chaikin = (points: Vec3[], iterations: number, clear?: (p: Vec3, q: Vec3) => boolean) => {
    let line = points;
    for (let it = 0; it < iterations && line.length > 2; it++) {
        const next = [line[0]];
        for (let i = 1; i + 1 < line.length; i++) {
            const prev = line[i - 1];
            const corner = line[i];
            const after = line[i + 1];
            const a = new Vec3().lerp(prev, corner, 0.75);
            const b = new Vec3().lerp(corner, after, 0.25);
            if (!clear || clear(a, b)) {
                next.push(a, b);
            } else {
                next.push(corner);
            }
        }
        next.push(line[line.length - 1]);
        line = next;
    }
    return line;
};

// the ground for a clicked point: the highest place to stand at or below
// it. Nothing to stand on right there (the click hit a car or a wall): the
// nearest place around at about that level
const snapToGround = (field: WalkField, p: Vec3, bodyRadius: number, u: number, reference?: number): Vec3 => {
    // the walk's level (other clicks): a roof or a car top above it is not
    // where a pedestrian walks
    const near = (y: number) => reference === undefined || Math.abs(y - reference) < 1.2 * u;
    const below = field.groundAt(p.x, p.z, p.y + 0.15 * u, bodyRadius, 0);
    if (below?.standing && near(below.y)) return new Vec3(p.x, below.y, p.z);
    if (reference !== undefined && reference < p.y) {
        const atLevel = field.groundAt(p.x, p.z, reference + 0.3 * u, bodyRadius);
        if (atLevel?.standing && near(atLevel.y)) return new Vec3(p.x, atLevel.y, p.z);
    }
    const level = below && near(below.y) ? below.y : (reference ?? below?.y ?? p.y);
    for (let r = 0.25 * u; r <= 4 * u; r += 0.25 * u) {
        let best: Vec3 | null = null;
        for (let k = 0; k < 16; k++) {
            const a = (k / 16) * 2 * Math.PI;
            const x = p.x + Math.sin(a) * r;
            const z = p.z + Math.cos(a) * r;
            const g = field.walkable(x, z, level + 0.3 * u, bodyRadius);
            if (g && Math.abs(g.y - level) < 0.6 * u && (!best || Math.abs(g.y - level) < Math.abs(best.y - level))) best = new Vec3(x, g.y, z);
        }
        if (best) return best;
    }
    return below ? new Vec3(p.x, below.y, p.z) : p.clone();
};

// evenly resampled polyline (spacing in scene units)
const resample = (line: Vec3[], spacing: number) => {
    const out = [line[0].clone()];
    let carry = 0;
    for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i];
        const b = line[i + 1];
        const len = a.distance(b);
        let d = spacing - carry;
        while (d < len) {
            out.push(new Vec3().lerp(a, b, d / len));
            d += spacing;
        }
        carry = len - (d - spacing);
    }
    const end = line[line.length - 1];
    if (out[out.length - 1].distance(end) > 1e-6) out.push(end.clone());
    return out;
};

const DEG = Math.PI / 180;

/**
 * The walk through the waypoints as a proposal: sparse keys (position and
 * target) at eye height, the walking pace, and the modifier for the camera.
 * Null with fewer than two points.
 */
const generateWalk = (opts: WalkOptions): WalkResult | null => {
    const points = opts.points.filter(p => p && Number.isFinite(p.x + p.y + p.z));
    if (points.length < 2) return null;
    const u = 1 / (opts.metersPerUnit > 0 ? opts.metersPerUnit : 1);
    const field = opts.field ?? null;
    const eye = clamp(opts.eyeHeight, 0.3, 3) * u;
    const speed = clamp(opts.speed, 0.2, 6) * u;
    const lookAhead = clamp(opts.lookAhead, 0.5, 12) * u;
    const bodyRadius = 0.3 * u;
    const warnings: string[] = [];

    // the ground below each clicked point (a click on a wall or a car finds
    // the ground next to it). The walk keeps to the level most clicks are
    // on: a click that hits a roof in front of the street goes down to the
    // street (median of the clicked heights)
    const sortedY = points.map(p => p.y).sort((a, b) => a - b);
    const reference = sortedY[Math.floor((sortedY.length - 1) / 2)];
    const ground = points.map(p => (field ? snapToGround(field, p, bodyRadius, u, reference) : p.clone()));

    // the way: straight, or around obstacles
    let route: Vec3[] = [ground[0]];
    let blockedWay = false;
    for (let i = 0; i + 1 < ground.length; i++) {
        let leg: Vec3[] | null = null;
        if (opts.autoRoute && field) leg = findRoute(field, ground[i], ground[i + 1], { bodyRadius });
        if (opts.autoRoute && field && !leg) blockedWay = true;
        route = route.concat((leg ?? [ground[i], ground[i + 1]]).slice(1));
    }
    if (blockedWay) warnings.push('sm.aishots.warn.walkNoRoute');

    // round the corners (where the short cut is clear), then follow the
    // ground
    const segmentClear = (p: Vec3, q: Vec3) => {
        if (!field) return true;
        const n = Math.max(1, Math.ceil(p.distance(q) / (0.2 * u)));
        for (let k = 0; k <= n; k++) {
            const t = k / n;
            const y = p.y + (q.y - p.y) * t;
            if (!field.walkable(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t, y + 0.3 * u, bodyRadius)) return false;
        }
        return true;
    };
    // a straight walk only rounds corners that are free anyway
    let line = chaikin(route, opts.autoRoute ? 3 : 2, field ? segmentClear : undefined);
    const spacing = Math.max(0.25 * u, 0.5 * (field?.cell ?? 0));
    line = resample(line, spacing);
    const heights = line.map((p, i) => {
        // height between the clicked points as the hint
        const hint = p.y;
        const hit = field?.groundAt(p.x, p.z, hint + 0.3 * u, bodyRadius);
        if (field && i > 0 && i < line.length - 1 && !hit?.standing) blockedWay = true;
        return hit && Math.abs(hit.y - hint) < 1.5 * u ? hit.y : hint;
    });
    // smooth the ground profile over about 1.5 m (no bumping over noise)
    const reach = Math.max(1, Math.round(0.75 * u / spacing));
    const smoothed = heights.map((_, i) => {
        let sum = 0;
        let n = 0;
        for (let k = -reach; k <= reach; k++) {
            const j = i + k;
            if (j < 0 || j >= heights.length) continue;
            sum += heights[j];
            n++;
        }
        return sum / n;
    });
    const groundLine = line.map((p, i) => new Vec3(p.x, smoothed[i], p.z));
    if (blockedWay && !warnings.includes('sm.aishots.warn.walkNoRoute')) warnings.push('sm.aishots.warn.walkBlocked');

    // arc length along the walk
    const cumulative = [0];
    for (let i = 1; i < groundLine.length; i++) cumulative.push(cumulative[i - 1] + groundLine[i].distance(groundLine[i - 1]));
    const length = cumulative[cumulative.length - 1];
    if (!(length > 1e-6)) return null;

    const pointAt = (d: number, out: Vec3) => {
        const s = clamp(d, 0, length);
        let i = 0;
        while (i < cumulative.length - 2 && cumulative[i + 1] < s) i++;
        const span = cumulative[i + 1] - cumulative[i];
        out.lerp(groundLine[i], groundLine[i + 1], span > 1e-12 ? (s - cumulative[i]) / span : 0);
        return out;
    };
    const endDir = new Vec3().sub2(groundLine[groundLine.length - 1], groundLine[Math.max(0, groundLine.length - 2)]);
    endDir.y = 0;
    if (endDir.length() < 1e-9) endDir.set(0, 0, -1);
    endDir.normalize();

    // eye and gaze at a distance d along the way: the view looks lookAhead
    // ahead (past the end: straight on), a little down like walking
    const eyeAt = (d: number) => {
        const p = pointAt(d, new Vec3());
        p.y += eye;
        return p;
    };
    // the line of sight from the eye is free of splats (sampled every 20 cm,
    // the first half metre is the walker's own space)
    const sightClear = (from: Vec3, to: Vec3) => {
        if (!field) return true;
        const len = from.distance(to);
        const n = Math.ceil(len / (0.2 * u));
        for (let k = 1; k <= n; k++) {
            const t = k / n;
            if (t * len < 0.5 * u) continue;
            if (field.solid(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t, 0.2 * u)) return false;
        }
        return true;
    };
    const gazeAt = (d: number) => {
        const from = eyeAt(d);
        // at a corner the point lookAhead ahead may be behind the wall: look
        // less far ahead until the view is free
        let reach = lookAhead;
        let p: Vec3 = null;
        for (let attempt = 0; attempt < 6; attempt++) {
            const ahead = d + reach;
            p = pointAt(ahead, new Vec3());
            if (ahead > length) p.add(endDir.clone().mulScalar(ahead - length));
            p.y += eye - Math.tan(4 * DEG) * reach;
            if (reach <= 0.8 * u || sightClear(from, p)) break;
            reach *= 0.7;
        }
        return p;
    };

    // timing: accelerate from standing over about a second, walk, stop
    const rampSeconds = Math.min(1, 0.25 * length / speed);
    const duration = length / speed + rampSeconds;
    const ramp = clamp(rampSeconds / duration, 0, 0.45);
    const fps = opts.fps > 0 ? opts.fps : 30;
    const frames = Math.max(2, Math.round(duration * fps) + 1);
    const last = frames - 1;
    const distanceAt = (frame: number) => ease(frame / last, ramp) * length;
    const frameAt = (d: number) => Math.round(easeInverse(d / length, ramp) * last);

    // keys: start, end, every waypoint, then wherever the spline strays
    const waypointDistances = ground.slice(1, -1).map((p) => {
        let best = 0;
        let bestD = Infinity;
        groundLine.forEach((q, i) => {
            const dd = Math.hypot(q.x - p.x, q.z - p.z);
            if (dd < bestD) {
                bestD = dd;
                best = cumulative[i];
            }
        });
        return best;
    });
    const keyFrames = new Set<number>([0, last]);
    waypointDistances.forEach(d => keyFrames.add(clamp(frameAt(d), 1, last - 1)));
    // one key on the speed ramps keeps the start and stop soft
    if (last > 8) {
        keyFrames.add(Math.max(1, Math.round(ramp * last)));
        keyFrames.add(Math.min(last - 1, Math.round((1 - ramp) * last)));
    }

    const makeKey = (frame: number): GeneratedKey => {
        const d = distanceAt(frame);
        return { frame, position: eyeAt(d), target: gazeAt(d) };
    };
    const buildKeys = () => [...keyFrames].sort((a, b) => a - b).map(makeKey);

    const tolerance = 0.12 * u;
    const maxKeys = Math.max(6, Math.min(80, 2 * points.length + Math.ceil(length * (opts.metersPerUnit > 0 ? opts.metersPerUnit : 1) / 3)));
    let keys = buildKeys();
    for (let iter = 0; iter < 80 && keys.length < maxKeys; iter++) {
        const times = keys.map(k => k.frame);
        const pos: number[] = [];
        const tgt: number[] = [];
        keys.forEach((k) => {
            pos.push(k.position.x, k.position.y, k.position.z);
            tgt.push(k.target.x, k.target.y, k.target.z);
        });
        const ps = CubicSpline.fromPoints(times, pos, 1);
        const ts = CubicSpline.fromPoints(times, tgt, 1);
        const a = [0, 0, 0];
        const b = [0, 0, 0];
        let worst = 0;
        let worstFrame = -1;
        for (let f = 1; f < last; f++) {
            if (keyFrames.has(f)) continue;
            ps.evaluate(f, a);
            ts.evaluate(f, b);
            const ref = makeKey(f);
            const dp = Math.hypot(a[0] - ref.position.x, a[1] - ref.position.y, a[2] - ref.position.z);
            const dt = Math.hypot(b[0] - ref.target.x, b[1] - ref.target.y, b[2] - ref.target.z);
            const err = Math.max(dp, 0.5 * dt);
            if (err > worst) {
                worst = err;
                worstFrame = f;
            }
        }
        if (worst <= tolerance || worstFrame < 0) break;
        keyFrames.add(worstFrame);
        keys = buildKeys();
    }

    keys[0].fov = opts.fov;
    const seconds = Math.round(duration * 10) / 10;
    return {
        id: 'walk',
        kind: 'walk',
        params: {
            template: 'slide',
            durationSec: seconds,
            distanceFactor: 1,
            heightFactor: 0,
            easing: 'smooth'
        },
        title: 'sm.aishots.template.walk',
        keys,
        frames,
        score: warnings.length ? 0.5 : 0.8,
        warnings,
        modifier: { ...opts.modifier },
        route: groundLine,
        walkLength: length,
        waypoints: ground.map(p => p.clone())
    };
};

/**
 * Waypoints for a round walk around an object through the free space: points
 * on a circle a few metres outside the object, each moved along its ray to
 * the nearest place a person can stand. The walk closes on its first point.
 */
const suggestWaypoints = (field: WalkField, center: Vec3, halfExtents: Vec3, groundY: number, metersPerUnit: number): Vec3[] => {
    const u = 1 / (metersPerUnit > 0 ? metersPerUnit : 1);
    const radius = Math.hypot(halfExtents.x, halfExtents.z) + 2.5 * u;
    const count = 8;
    const points: Vec3[] = [];
    for (let i = 0; i < count; i++) {
        const az = (i / count) * 2 * Math.PI;
        const dir = new Vec3(Math.sin(az), 0, Math.cos(az));
        let found: Vec3 | null = null;
        // along the ray: the circle first, then alternately further out / in
        for (let k = 0; k <= 12 && !found; k++) {
            const offset = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 0.08 * radius;
            const r = radius + offset;
            if (r < 0.5 * radius) continue;
            const x = center.x + dir.x * r;
            const z = center.z + dir.z * r;
            const hit = field.walkable(x, z, groundY + 0.3 * u, 0.3 * u);
            if (hit) found = new Vec3(x, hit.y, z);
        }
        if (found) points.push(found);
    }
    if (points.length >= 3) points.push(points[0].clone());
    return points;
};

export { WalkField, generateWalk, findRoute, suggestWaypoints, type WalkOptions, type WalkResult };
