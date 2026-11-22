// Scan composition: large blurry areas per scan ("unscharfe Bereiche"), the
// simple path next to the detailed suggestions of compose-detail.ts.
//
// Where a scan has no sharpness at all - only soft, flowing shapes - it is
// usually broken (floaters, a part the capture barely saw), and that is
// obvious at a glance; it needs no cell-by-cell proof. Such parts are made of
// few, large splats, so the point cloud (the splat centres) is sparse there.
// Nuremberg, bridge deck (9 x 24 m): scan A has about 1 200 centres there,
// scan B tens of thousands; 1 m voxels of A's bridge band hold a median of 16
// centres (splat-weighted footprint 45 mm, A's own median 15 mm), B's 52
// (11 mm). Every scan has a sharp core around its capture path and a coarse
// rim (far facades 10-30 cm, 3-4 octaves over its median).
//
// 1. per scan its reference footprint (median opaque footprint) - blur is
//    relative to the scan itself, so units do not matter;
// 2. one coarse voxel grid for all scans (64 x the finest reference, at most
//    1/100 of the scene diagonal, a nice value: 1 m in Nuremberg, 0.5 m in
//    the bus); per voxel and scan: rows, opacity mass, the opacity-weighted
//    geometric mean footprint, sharp opaque rows;
// 3. per scan: a voxel is blurry when its mean footprint is >= 4x the
//    scan's own reference - or, with other scans, >= 1.4x where another scan
//    is sharp and at least 2x finer there (relative blur: a 3x blurred ball
//    is not blurry by the scan's own standard, but the other scan shows it
//    sharp). Blurry voxels at most 2 voxels apart form an area (gaps of one
//    voxel close), split by the comparison: where another scan is sharp the
//    voxels form areas of their own. Small pieces join the neighbouring area
//    they touch most; small islands are gathered, the rest is dropped;
// 4. per area: its rows (the coarse ones; the few sharp splats inside
//    stay), island (touches no sharp voxel of its scan: free-floating, likely
//    floaters) or surface, what the other scans have there, a score and a
//    view hint;
// 5. per row a blur value for a colour view (0 sharp .. 255 blurry, own
//    reference) and how much coarser than the finest other scan it is.
//
// Measured (scripts/test-compose-detail.mjs --blur, node): Nuremberg A + B
// (4.1 + 1.7 M splats) 2.2-2.4 s, 11 areas: per scan the part the other scan
// has sharply (A: bridge and its north end, 70 714 splats, 78 % of A's rows
// and 74 % of their visual weight in the bridge box; B: the park, 61 034),
// the blurry rim both have (463 316 / 209 267), islands and two small
// patches. Bus + bus-blur (3x blurred ball): one 'A is sharp here' area with
// 68 % of the ball's rows and 94 other rows (0.005 %); a gross ball (1/8 of
// the rows, 8x larger) 82 %; twins: the areas of the scan alone, never
// 'other sharp'. Alone, a blurred spot touching the scan's blurry rim is part
// of the rim's area: connected blur is one area; only the comparison splits.
//
// Pure typed-array code for the analysis worker (job 'compose-blur') and
// node. Deterministic: every loop runs in ascending index order, ties are
// broken by index.

import { robustBox } from './compose-core';

type V3 = [number, number, number];

// ---------------------------------------------------------------- constants

const BLUR = {
    // opacity byte from which a splat counts as opaque (alpha 0.2, as
    // compose-detail DETAIL.opaque)
    opaque: 51,
    // reference footprint of a scan: this quantile of its opaque footprints,
    // on at most refSamples evenly picked rows (Nuremberg A 15.2 mm, B 25.5
    // mm; B's is larger because its coarse rim is larger)
    refQuantile: 0.5,
    refSamples: 200000,
    // grid edge: nice(gridScale x the smallest reference), clamped to
    // [gridMin, gridMax] x the robust scene diagonal
    gridScale: 64,
    gridMin: 1 / 600,
    gridMax: 1 / 100,
    // a scan is present in a voxel with at least this opacity mass (sum of
    // alpha) there
    presentMass: 0.5,
    // blurry voxel: opacity-weighted geometric mean footprint >= 2^blurOctaves
    // x the scan's reference
    blurOctaves: 2,
    // sharp voxel (the island test, the other scans): mean footprint below
    // the blur bound and at least sharpRows opaque rows with a footprint
    // <= 2^sharpRowOctaves x the reference
    sharpRows: 8,
    sharpRowOctaves: 1,
    // another scan is sharp where this one is blurry when it is sharp in
    // that voxel and its mean footprint is at least compareOctaves finer
    compareOctaves: 1,
    // with other scans, a voxel only relOctaves over the reference is
    // blurry too where another scan is sharp and compareOctaves finer there
    relOctaves: 0.5,
    // blurry voxels at most linkReach voxels apart (Chebyshev) are one area
    linkReach: 2,
    // passes of the majority vote that smooths 'another scan is sharp here'
    smoothPasses: 2,
    // islands with fewer rows than this share of the scan's rows (at least
    // minRows) are gathered into one area per scan and comparison group
    gatherShare: 0.003,
    // the smallest area: voxels and rows
    minVoxels: 8,
    minRows: 300,
    // rows of an area: own footprint >= 2^rowOctaves x the reference, or
    // where another scan is sharp, >= 2^rowRelOctaves x its mean footprint
    rowOctaves: 1,
    rowRelOctaves: 0.5,
    // colour view: (own + voxel) / 2 octaves over the reference, 0 at mapLo,
    // 255 at mapHi; the comparison view: 255 at coarserHi octaves coarser
    // than the finest other scan
    mapLo: 1,
    mapHi: 4,
    coarserHi: 2,
    // view hint: elevation (degrees) of the camera over the area centre, and
    // its distance as a multiple of the area's largest horizontal extent
    viewElevation: 35,
    viewDistance: 1.2
};

type BlurConstants = typeof BLUR;

type BlurOptions = Partial<BlurConstants> & {
    // grid edge (world units); default automatic
    cell?: number,
    // reference footprints per scan; default measured
    refs?: number[],
    // up axis (0 x, 1 y, 2 z) and sign for the view hints; default: the
    // axis of the smallest robust extent, +
    upAxis?: 0 | 1 | 2,
    upSign?: 1 | -1
};

// ---------------------------------------------------------------- types

// the rows of one scan in world space (compose-detail CompactRows: the
// reader splat-data readLayerCompact; lum and instances are not needed)
type BlurRows = {
    positions: Float32Array,
    // footprint sqrt(largest * middle scale), world units
    footprint: Float32Array,
    // round(alpha * 255)
    opacity: Uint8Array
};

// what the other scans have in an area (shares of its voxels)
type BlurCompare = 'otherSharp' | 'otherBlurry' | 'alone' | 'none';

type BlurArea = {
    // rank (0 = most worth deleting)
    id: number,
    scan: number,
    // island: touches no sharp voxel of its own scan (free-floating, likely
    // floaters); surface: part of the scan's coarse surface
    kind: 'island' | 'surface',
    // rows of the scan (ascending): the coarse splats in the area's voxels
    rows: Uint32Array,
    splats: number,
    voxels: number,
    // world box of the voxels, its extent, the mean of the rows
    min: V3,
    max: V3,
    dims: V3,
    centroid: V3,
    // a camera looking at the area from the side of the scan's sharp part
    view: { position: V3, target: V3 },
    // shares of the area's voxels: another scan is sharp there (at least
    // compareOctaves finer), another scan has only blur there, no other scan
    // has anything within a voxel (deleting leaves a hole). All 0 with a
    // single scan
    otherSharp: number,
    otherBlurry: number,
    alone: number,
    // the dominant one ('none' with a single scan): otherSharp from 0.5,
    // else alone from 0.5, else otherBlurry
    compare: BlurCompare,
    // the scan that is sharp there most often (-1: none)
    sharpBy: number,
    // median octaves of the rows' footprints over the scan's reference
    blur: number,
    // mean octaves the area is coarser than the sharp other scan, over the
    // voxels where one is (NaN: none)
    lead: number,
    // 0..1: how clearly it should go (blur depth, the comparison, island)
    score: number,
    // pieces merged into it (small neighbouring pieces of the other class)
    pieces: number
};

type BlurScan = {
    ref: number,
    rows: number,
    // voxels where the scan is present, blurry, sharp
    presentVoxels: number,
    blurryVoxels: number,
    sharpVoxels: number,
    // rows in its areas; dropped small pieces and their coarse rows
    areaRows: number,
    droppedPieces: number,
    droppedRows: number
};

type BlurResult = {
    cell: number,
    upAxis: 0 | 1 | 2,
    upSign: 1 | -1,
    scans: BlurScan[],
    // sorted by score, then splats
    areas: BlurArea[],
    // per scan, per row: 0 sharp .. 255 blurry (relative to the scan's own
    // reference; see mapLo / mapHi)
    blur: Uint8Array[],
    // per scan, per row: how much coarser the row's voxel is than the finest
    // other scan present there, 0 (not coarser, or no other scan) .. 255
    // (coarserHi octaves or more); all 0 with a single scan
    coarser: Uint8Array[],
    seconds: number
};

// ---------------------------------------------------------------- helpers

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const NICE = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
// the nice value (1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8 x 10^k) nearest to v
const niceValue = (v: number) => {
    const e = Math.floor(Math.log10(v));
    let best = v, err = Infinity;
    for (const n of NICE) {
        const c = e >= 0 ? n * 10 ** e : n / 10 ** -e;
        const d = Math.abs(Math.log(c / v));
        if (d < err) {
            err = d;
            best = c;
        }
    }
    return best;
};

// reference footprint: refQuantile of the opaque footprints (every step-th
// row; all rows when none is opaque)
const referenceOf = (rows: BlurRows, k: BlurConstants) => {
    const n = rows.footprint.length;
    const step = Math.max(1, Math.floor(n / k.refSamples));
    const pick = (opaqueOnly: boolean) => {
        const out: number[] = [];
        for (let i = 0; i < n; i += step) {
            const f = rows.footprint[i];
            if (f > 0 && Number.isFinite(f) && (!opaqueOnly || rows.opacity[i] >= k.opaque)) out.push(f);
        }
        return out;
    };
    let s = pick(true);
    if (!s.length) s = pick(false);
    if (!s.length) return NaN;
    s.sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(k.refQuantile * s.length))];
};

// open-addressing voxel index: integer voxel coordinates -> dense id
class VoxelIndex {
    count = 0;

    x: Int32Array;

    y: Int32Array;

    z: Int32Array;

    private slots: Int32Array;

    private mask: number;

    constructor(expected: number) {
        let cap = 1024;
        while (cap < expected * 2) cap *= 2;
        this.alloc(cap);
    }

    private alloc(cap: number) {
        this.slots = new Int32Array(cap).fill(-1);
        this.mask = cap - 1;
        const keep = this.count;
        const grow = (a: Int32Array) => {
            const b = new Int32Array(cap >> 1);
            if (a) b.set(a.subarray(0, keep));
            return b;
        };
        this.x = grow(this.x);
        this.y = grow(this.y);
        this.z = grow(this.z);
        for (let id = 0; id < keep; id++) {
            let h = this.hash(this.x[id], this.y[id], this.z[id]);
            while (this.slots[h] >= 0) h = (h + 1) & this.mask;
            this.slots[h] = id;
        }
    }

    private hash(ix: number, iy: number, iz: number) {
        let h = Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f);
        h ^= h >>> 15;
        h = Math.imul(h, 0x2c1b3c6d);
        h ^= h >>> 12;
        return h & this.mask;
    }

    find(ix: number, iy: number, iz: number) {
        let h = this.hash(ix, iy, iz);
        for (;;) {
            const id = this.slots[h];
            if (id < 0) return -1;
            if (this.x[id] === ix && this.y[id] === iy && this.z[id] === iz) return id;
            h = (h + 1) & this.mask;
        }
    }

    add(ix: number, iy: number, iz: number) {
        let h = this.hash(ix, iy, iz);
        for (;;) {
            const id = this.slots[h];
            if (id < 0) break;
            if (this.x[id] === ix && this.y[id] === iy && this.z[id] === iz) return id;
            h = (h + 1) & this.mask;
        }
        const id = this.count++;
        this.x[id] = ix;
        this.y[id] = iy;
        this.z[id] = iz;
        this.slots[h] = id;
        if (this.count * 2 >= this.slots.length) this.alloc(this.slots.length * 2);
        return id;
    }
}

// union-find with path halving; the root is the smallest id
const findRoot = (parent: Int32Array, a: number) => {
    while (parent[a] !== a) {
        parent[a] = parent[parent[a]];
        a = parent[a];
    }
    return a;
};
const unite = (parent: Int32Array, a: number, b: number) => {
    a = findRoot(parent, a);
    b = findRoot(parent, b);
    if (a === b) return;
    if (a < b) parent[b] = a;
    else parent[a] = b;
};

// offsets of the (2r + 1)^3 - 1 neighbours
const offsetsOf = (r: number) => {
    const out: number[] = [];
    for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dz = -r; dz <= r; dz++) {
                if (dx || dy || dz) out.push(dx, dy, dz);
            }
        }
    }
    return Int32Array.from(out);
};

// voxel flags per (voxel, scan)
const PRESENT = 1, BLURRY = 2, SHARP = 4;
// comparison class of a blurry voxel
const ALONE = 0, OTHER_BLURRY = 1, OTHER_SHARP = 2;

// ---------------------------------------------------------------- detector

const composeBlur = (scans: BlurRows[], options: BlurOptions = {}): BlurResult => {
    const t0 = now();
    const k: BlurConstants = { ...BLUR, ...options };
    const S = scans.length;

    // references and grid
    const refs = scans.map((rows, s) => options.refs?.[s] ?? referenceOf(rows, k));
    const boxes = scans.filter(r => r.positions.length >= 3).map(r => robustBox(r.positions));
    const lo = [0, 1, 2].map(a => Math.min(...boxes.map(b => b.min[a])));
    const hi = [0, 1, 2].map(a => Math.max(...boxes.map(b => b.max[a])));
    const ext = [0, 1, 2].map(a => (boxes.length ? Math.max(0, hi[a] - lo[a]) : 0));
    const diag = Math.hypot(ext[0], ext[1], ext[2]) || 1;
    const finest = Math.min(...refs.filter(r => r > 0 && Number.isFinite(r)), Infinity);
    let cell = options.cell;
    if (!(cell > 0)) {
        const want = Number.isFinite(finest) ? k.gridScale * finest : diag * k.gridMax;
        cell = niceValue(Math.max(diag * k.gridMin, Math.min(diag * k.gridMax, want)));
    }
    const inv = 1 / cell;
    const upAxis: 0 | 1 | 2 = options.upAxis ?? (ext.indexOf(Math.min(...ext)) as 0 | 1 | 2);
    const upSign: 1 | -1 = options.upSign ?? 1;

    // voxel of every row (-1: position not finite or out of range)
    let total = 0;
    scans.forEach((r) => {
        total += r.footprint.length;
    });
    const index = new VoxelIndex(Math.min(total, 1 << 20) / 4);
    const LIMIT = 1 << 30;
    const rowVoxel = scans.map((rows) => {
        const p = rows.positions;
        const n = rows.footprint.length;
        const out = new Int32Array(n);
        for (let i = 0; i < n; i++) {
            const fx = Math.floor(p[i * 3] * inv), fy = Math.floor(p[i * 3 + 1] * inv), fz = Math.floor(p[i * 3 + 2] * inv);
            // NaN and infinities fail the range test too
            if (!(Math.abs(fx) < LIMIT && Math.abs(fy) < LIMIT && Math.abs(fz) < LIMIT)) {
                out[i] = -1;
                continue;
            }
            out[i] = index.add(fx, fy, fz);
        }
        return out;
    });
    const V = index.count;
    const VX = index.x, VY = index.y, VZ = index.z;

    // per (voxel, scan): opacity mass, sum alpha log2 footprint, sharp opaque
    // rows
    const mass = new Float32Array(V * S);
    const logSum = new Float64Array(V * S);
    const nSharp = new Uint32Array(V * S);
    const logRef = refs.map(r => Math.log2(r > 0 ? r : 1));
    scans.forEach((rows, s) => {
        const rv = rowVoxel[s];
        const { footprint, opacity } = rows;
        const sharpBound = refs[s] * 2 ** k.sharpRowOctaves;
        for (let i = 0; i < rv.length; i++) {
            const v = rv[i];
            if (v < 0) continue;
            const j = v * S + s;
            const f = footprint[i];
            if (!(f > 0) || !Number.isFinite(f)) continue;
            const a = opacity[i] / 255;
            mass[j] += a;
            logSum[j] += a * Math.log2(f);
            if (opacity[i] >= k.opaque && f <= sharpBound) nSharp[j]++;
        }
    });

    // flags and mean footprint (log2, world units) per (voxel, scan)
    const flags = new Uint8Array(V * S);
    const meanLog = new Float32Array(V * S).fill(NaN);
    for (let v = 0; v < V; v++) {
        for (let s = 0; s < S; s++) {
            const j = v * S + s;
            if (!(mass[j] >= k.presentMass)) continue;
            const m = logSum[j] / mass[j];
            meanLog[j] = m;
            let f = PRESENT;
            if (m - logRef[s] >= k.blurOctaves) f |= BLURRY;
            else if (nSharp[j] >= k.sharpRows) f |= SHARP;
            flags[j] = f;
        }
    }
    // relative blur: a voxel at least relOctaves over the scan's reference
    // is blurry too where another scan is sharp and compareOctaves finer
    // (the two can never be that for each other, so the order is free)
    if (S > 1) {
        const relative: number[] = [];
        for (let v = 0; v < V; v++) {
            for (let s = 0; s < S; s++) {
                const j = v * S + s;
                if (!flags[j] || (flags[j] & BLURRY) || meanLog[j] - logRef[s] < k.relOctaves) continue;
                for (let t = 0; t < S; t++) {
                    const jt = v * S + t;
                    if (t !== s && (flags[jt] & SHARP) && meanLog[jt] <= meanLog[j] - k.compareOctaves) {
                        relative.push(j);
                        break;
                    }
                }
            }
        }
        for (const j of relative) flags[j] = PRESENT | BLURRY;
    }
    const counts = scans.map(() => ({ present: 0, blurry: 0, sharp: 0 }));
    for (let v = 0; v < V; v++) {
        for (let s = 0; s < S; s++) {
            const f = flags[v * S + s];
            if (!f) continue;
            counts[s].present++;
            if (f & BLURRY) counts[s].blurry++;
            if (f & SHARP) counts[s].sharp++;
        }
    }

    const near = offsetsOf(1);
    const link = offsetsOf(k.linkReach);
    const neighbour = (v: number, off: Int32Array, q: number) => index.find(VX[v] + off[q], VY[v] + off[q + 1], VZ[v] + off[q + 2]);

    // comparison class of a blurry voxel of scan s, and which scan is sharp
    const classOf = new Uint8Array(V * S);
    const sharpWho = new Int8Array(V * S).fill(-1);
    // the sharp other scan's mean footprint (log2) there
    const sharpLog = new Float32Array(V * S).fill(NaN);
    if (S > 1) {
        for (let v = 0; v < V; v++) {
            for (let s = 0; s < S; s++) {
                const j = v * S + s;
                if (!(flags[j] & BLURRY)) continue;
                let cls = ALONE, who = -1, whoLog = Infinity;
                for (let t = 0; t < S; t++) {
                    if (t === s) continue;
                    const jt = v * S + t;
                    if (!flags[jt]) continue;
                    if (cls < OTHER_BLURRY) cls = OTHER_BLURRY;
                    if ((flags[jt] & SHARP) && meanLog[jt] <= meanLog[j] - k.compareOctaves) {
                        cls = OTHER_SHARP;
                        if (meanLog[jt] < whoLog) {
                            whoLog = meanLog[jt];
                            who = t;
                        }
                    }
                }
                // alone only when no other scan is present in the 26
                // neighbours either
                if (cls === ALONE) {
                    for (let q = 0; q < near.length && cls === ALONE; q += 3) {
                        const u = neighbour(v, near, q);
                        if (u < 0) continue;
                        for (let t = 0; t < S; t++) {
                            if (t !== s && flags[u * S + t]) {
                                cls = OTHER_BLURRY;
                                break;
                            }
                        }
                    }
                }
                classOf[j] = cls;
                sharpWho[j] = who;
                if (who >= 0) sharpLog[j] = whoLog;
            }
        }
    }
    const areas: BlurArea[] = [];
    const scanInfo: BlurScan[] = [];
    const blurMaps: Uint8Array[] = [];
    const coarserMaps: Uint8Array[] = [];
    const voxCoarser = new Uint8Array(V);
    const parent = new Int32Array(V);
    const touch = new Uint8Array(V);
    const pieceOf = new Int32Array(V);
    const group = new Uint8Array(V);
    const groupNext = new Uint8Array(V);
    const span = k.mapHi - k.mapLo;

    for (let s = 0; s < S; s++) {
        const rows = scans[s];
        const rv = rowVoxel[s];
        const n = rv.length;
        // rows taken in a blurry voxel: own footprint >= 2^rowOctaves x the
        // reference, or where another scan is sharp, >= 2^rowRelOctaves x
        // that scan's mean footprint there (coarser than its version)
        const absBound = refs[s] * 2 ** k.rowOctaves;
        const rowBound = new Float32Array(V).fill(Infinity);

        const blurry: number[] = [];
        for (let v = 0; v < V; v++) {
            parent[v] = v;
            touch[v] = 0;
            pieceOf[v] = -1;
            group[v] = classOf[v * S + s] === OTHER_SHARP ? 1 : 0;
            if (flags[v * S + s] & BLURRY) {
                blurry.push(v);
                const j = v * S + s;
                rowBound[v] = classOf[j] === OTHER_SHARP ? Math.min(absBound, 2 ** (sharpLog[j] + k.rowRelOctaves)) : absBound;
            }
        }
        // group 1: another scan is sharp there. A voxel of group 0 joins
        // group 1 when most blurry voxels of its 3x3x3 block are group 1
        // (smoothPasses times), so a surface the other scan has sharply is
        // one area and not a speckle of two. Never the other way: a small
        // group-1 blob (a blurred ball in a blurry room) would erode away. A
        // voxel no other scan is near (alone) stays in group 0
        for (let pass = 0; pass < k.smoothPasses; pass++) {
            for (const v of blurry) {
                groupNext[v] = group[v];
                if (group[v] || classOf[v * S + s] === ALONE) continue;
                let yes = 0, no = 1;
                for (let q = 0; q < near.length; q += 3) {
                    const u = neighbour(v, near, q);
                    if (u < 0 || !(flags[u * S + s] & BLURRY)) continue;
                    if (group[u]) yes++;
                    else no++;
                }
                if (yes > no) groupNext[v] = 1;
            }
            for (const v of blurry) group[v] = groupNext[v];
        }

        // pieces: blurry voxels of one group within linkReach; touch: a sharp
        // voxel of the scan within linkReach
        for (const v of blurry) {
            const g = group[v];
            for (let q = 0; q < link.length; q += 3) {
                const u = neighbour(v, link, q);
                if (u < 0) continue;
                const fu = flags[u * S + s];
                if (fu & SHARP) touch[v] = 1;
                else if (u > v && (fu & BLURRY) && group[u] === g) unite(parent, v, u);
            }
        }
        // pieces in order of their smallest voxel
        const rootPiece = new Map<number, number>();
        const pieceVoxels: number[][] = [];
        for (const v of blurry) {
            const r = findRoot(parent, v);
            let p = rootPiece.get(r);
            if (p === undefined) {
                p = pieceVoxels.length;
                rootPiece.set(r, p);
                pieceVoxels.push([]);
            }
            pieceVoxels[p].push(v);
            pieceOf[v] = p;
        }
        const P = pieceVoxels.length;

        // coarse rows per piece
        const pieceRows = new Uint32Array(P);
        for (let i = 0; i < n; i++) {
            const v = rv[i];
            if (v < 0) continue;
            const p = pieceOf[v];
            if (p >= 0 && rows.footprint[i] >= rowBound[v]) pieceRows[p]++;
        }
        const pieceTouch = new Uint8Array(P);
        for (let p = 0; p < P; p++) {
            for (const v of pieceVoxels[p]) {
                if (touch[v]) {
                    pieceTouch[p] = 1;
                    break;
                }
            }
        }
        const big = (p: number) => pieceVoxels[p].length >= k.minVoxels && pieceRows[p] >= k.minRows;

        // a small piece joins the big piece of the other group it touches
        // most (within linkReach)
        const target = new Int32Array(P);
        for (let p = 0; p < P; p++) target[p] = big(p) ? p : -1;
        for (let p = 0; p < P; p++) {
            if (target[p] === p) continue;
            const contact = new Map<number, number>();
            for (const v of pieceVoxels[p]) {
                for (let q = 0; q < link.length; q += 3) {
                    const u = neighbour(v, link, q);
                    if (u < 0) continue;
                    const pu = pieceOf[u];
                    if (pu >= 0 && pu !== p && target[pu] === pu) contact.set(pu, (contact.get(pu) ?? 0) + 1);
                }
            }
            let best = -1, bestN = 0;
            contact.forEach((c, pu) => {
                if (c > bestN || (c === bestN && pu < best)) {
                    best = pu;
                    bestN = c;
                }
            });
            if (best >= 0) target[p] = best;
        }

        // islands (pieces touching no sharp voxel of the scan, alone or with
        // what they took) below gatherRows rows are gathered into one area
        // per group: scattered blurry bits, likely floaters. A gathered
        // group of a single piece is that piece. The remaining small pieces
        // are dropped
        const gatherBound = Math.max(k.minRows, k.gatherShare * n);
        const takenRows = pieceRows.slice();
        const takenTouch = pieceTouch.slice();
        for (let p = 0; p < P; p++) {
            const t = target[p];
            if (t >= 0 && t !== p) {
                takenRows[t] += pieceRows[p];
                takenTouch[t] |= pieceTouch[p];
            }
        }
        const gatherHead = [-1, -1];
        const gathered = new Uint32Array(P);
        for (let p = 0; p < P; p++) {
            const own = target[p] === p;
            if (own ? (takenTouch[p] || takenRows[p] >= gatherBound) : (target[p] >= 0 || pieceTouch[p])) continue;
            const g = group[pieceVoxels[p][0]];
            if (gatherHead[g] < 0) gatherHead[g] = p;
            // the head's own merged pieces follow it
            target[p] = gatherHead[g];
            gathered[gatherHead[g]]++;
        }
        for (let p = 0; p < P; p++) {
            const t = target[p];
            if (t >= 0 && t !== p && target[t] !== t) target[p] = target[t];
        }
        for (const head of gatherHead) {
            if (head < 0) continue;
            let sum2 = 0;
            for (let p = 0; p < P; p++) if (target[p] === head) sum2 += pieceRows[p];
            // a gathered group too small for an area is dropped
            if (sum2 < k.minRows || (gathered[head] === 1 && !big(head))) {
                for (let p = 0; p < P; p++) if (target[p] === head) target[p] = -1;
            }
        }

        // areas of this scan: the big pieces with the small ones they took,
        // and the gathered islands
        const areaOf = new Int32Array(P).fill(-1);
        const areaPieces: number[] = [];
        for (let p = 0; p < P; p++) {
            if (target[p] === p) {
                areaOf[p] = areaPieces.length;
                areaPieces.push(p);
            }
        }
        const merged = new Uint32Array(P);
        let droppedPieces = 0, droppedRows = 0;
        for (let p = 0; p < P; p++) {
            if (target[p] < 0) {
                droppedPieces++;
                droppedRows += pieceRows[p];
            } else {
                areaOf[p] = areaOf[target[p]];
                merged[target[p]]++;
            }
        }
        const areaIsland = areaPieces.map(p => !takenTouch[p] || gathered[p] > 0);
        const A = areaPieces.length;
        const voxArea = new Int32Array(V).fill(-1);
        const areaVoxels: number[][] = areaPieces.map((): number[] => []);
        for (let p = 0; p < P; p++) {
            const a = areaOf[p];
            if (a < 0) continue;
            for (const v of pieceVoxels[p]) {
                voxArea[v] = a;
                areaVoxels[a].push(v);
            }
        }

        // rows per area (coarse rows in its voxels), their sums and the
        // octave histogram (1/8 octave bins over [-2, 10))
        const counts2 = new Uint32Array(A);
        for (let i = 0; i < n; i++) {
            const v = rv[i];
            if (v >= 0 && voxArea[v] >= 0 && rows.footprint[i] >= rowBound[v]) counts2[voxArea[v]]++;
        }
        const lists = Array.from(counts2, c => new Uint32Array(c));
        const fill = new Uint32Array(A);
        const sum = new Float64Array(A * 3);
        const HB = 96;
        const hist = new Uint32Array(A * HB);
        for (let i = 0; i < n; i++) {
            const v = rv[i];
            if (v < 0) continue;
            const a = voxArea[v];
            if (a < 0 || !(rows.footprint[i] >= rowBound[v])) continue;
            lists[a][fill[a]++] = i;
            sum[a * 3] += rows.positions[i * 3];
            sum[a * 3 + 1] += rows.positions[i * 3 + 1];
            sum[a * 3 + 2] += rows.positions[i * 3 + 2];
            const b = Math.floor((Math.log2(rows.footprint[i]) - logRef[s] + 2) * 8);
            hist[a * HB + Math.max(0, Math.min(HB - 1, b))]++;
        }

        // the scan's sharp part (where it was captured from): the mean of its
        // sharp voxels, weighted by their sharp rows
        const sharpCentre: V3 = [0, 0, 0];
        {
            let w = 0;
            for (let v = 0; v < V; v++) {
                const j = v * S + s;
                if (!(flags[j] & SHARP)) continue;
                const c = nSharp[j];
                sharpCentre[0] += (VX[v] + 0.5) * cell * c;
                sharpCentre[1] += (VY[v] + 0.5) * cell * c;
                sharpCentre[2] += (VZ[v] + 0.5) * cell * c;
                w += c;
            }
            if (w > 0) {
                for (let a = 0; a < 3; a++) sharpCentre[a] /= w;
            } else {
                for (let a = 0; a < 3; a++) sharpCentre[a] = (lo[a] + hi[a]) / 2;
            }
        }

        let areaRows = 0;
        for (let a = 0; a < A; a++) {
            const vox = areaVoxels[a];
            const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
            const island = areaIsland[a];
            let nSh = 0, nBl = 0, nAl = 0, leadSum = 0;
            const who = new Uint32Array(S);
            for (const v of vox) {
                const c = [VX[v], VY[v], VZ[v]];
                for (let q = 0; q < 3; q++) {
                    min[q] = Math.min(min[q], c[q] * cell);
                    max[q] = Math.max(max[q], (c[q] + 1) * cell);
                }
                const j = v * S + s;
                if (classOf[j] === OTHER_SHARP) {
                    nSh++;
                    leadSum += meanLog[j] - sharpLog[j];
                    if (sharpWho[j] >= 0) who[sharpWho[j]]++;
                } else if (classOf[j] === OTHER_BLURRY) nBl++;
                else nAl++;
            }
            const splats = counts2[a];
            areaRows += splats;
            const centroid: V3 = splats ? [sum[a * 3] / splats, sum[a * 3 + 1] / splats, sum[a * 3 + 2] / splats] : [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
            const dims: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
            const otherSharp = S > 1 ? nSh / vox.length : 0;
            const otherBlurry = S > 1 ? nBl / vox.length : 0;
            const alone = S > 1 ? nAl / vox.length : 0;
            const compare: BlurCompare = S < 2 ? 'none' : otherSharp >= 0.5 ? 'otherSharp' : alone >= 0.5 ? 'alone' : 'otherBlurry';
            let sharpBy = -1;
            for (let t = 0; t < S; t++) {
                if (who[t] > 0 && (sharpBy < 0 || who[t] > who[sharpBy])) sharpBy = t;
            }
            // median octaves over the reference
            let blur = NaN;
            {
                let acc = 0;
                for (let b = 0; b < HB; b++) {
                    const c = hist[a * HB + b];
                    if (c && acc + c >= splats / 2) {
                        blur = (b + (splats / 2 - acc) / c) / 8 - 2;
                        break;
                    }
                    acc += c;
                }
            }
            // score: blur depth - over the scan's reference (1 octave 0 .. 4
            // octaves 1) or, where another scan is sharp, over that scan (0
            // .. 2 octaves 1) - weighted by the comparison (another scan
            // sharp there: full; only this scan there: less, deleting leaves
            // a hole), islands + 0.2
            const lead = nSh ? leadSum / nSh : NaN;
            const depth = Math.max(clamp01((blur - 1) / 3), nSh ? clamp01(lead / 2) * otherSharp : 0);
            const weight = S < 2 ? 0.7 : 0.5 + 0.5 * otherSharp - 0.2 * alone;
            const score = clamp01(depth * weight + (island ? 0.2 : 0));

            // view hint: from the side of the scan's sharp part, raised by
            // viewElevation, at viewDistance x the largest horizontal extent
            const h = [0, 1, 2].filter(q => q !== upAxis);
            const dir: V3 = [0, 0, 0];
            const dx = sharpCentre[h[0]] - centroid[h[0]], dy = sharpCentre[h[1]] - centroid[h[1]];
            const dl = Math.hypot(dx, dy);
            const el = k.viewElevation * Math.PI / 180;
            dir[h[0]] = (dl > 1e-9 ? dx / dl : 1) * Math.cos(el);
            dir[h[1]] = (dl > 1e-9 ? dy / dl : 0) * Math.cos(el);
            dir[upAxis] = upSign * Math.sin(el);
            const reach = Math.max(4 * cell, Math.min(k.viewDistance * Math.max(dims[h[0]], dims[h[1]]) + cell, 0.3 * diag));
            const position: V3 = [centroid[0] + dir[0] * reach, centroid[1] + dir[1] * reach, centroid[2] + dir[2] * reach];

            areas.push({
                id: -1,
                scan: s,
                kind: island ? 'island' : 'surface',
                rows: lists[a],
                splats,
                voxels: vox.length,
                min,
                max,
                dims,
                centroid,
                view: { position, target: centroid.slice() as V3 },
                otherSharp,
                otherBlurry,
                alone,
                compare,
                sharpBy,
                blur,
                lead,
                score,
                pieces: merged[areaPieces[a]]
            });
        }

        // colour view: the mean of the row's own and its voxel's octaves
        // over the reference
        const map = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const f = rows.footprint[i];
            if (!(f > 0)) continue;
            let b = Math.log2(f) - logRef[s];
            const v = rv[i];
            if (v >= 0) {
                const m = meanLog[v * S + s];
                if (Number.isFinite(m)) b = 0.5 * (b + m - logRef[s]);
            }
            const u = (b - k.mapLo) / span;
            map[i] = u <= 0 ? 0 : u >= 1 ? 255 : Math.round(u * 255);
        }
        blurMaps.push(map);

        // comparison view: per voxel the octaves over the finest other scan
        // present there
        for (let v = 0; v < V; v++) {
            const j = v * S + s;
            let best = Infinity;
            if (flags[j]) {
                for (let t = 0; t < S; t++) {
                    if (t !== s && flags[v * S + t] && meanLog[v * S + t] < best) best = meanLog[v * S + t];
                }
            }
            const u = (meanLog[j] - best) / k.coarserHi;
            voxCoarser[v] = u > 0 ? (u >= 1 ? 255 : Math.round(u * 255)) : 0;
        }
        const cmap = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const v = rv[i];
            if (v >= 0) cmap[i] = voxCoarser[v];
        }
        coarserMaps.push(cmap);

        scanInfo.push({
            ref: refs[s],
            rows: n,
            presentVoxels: counts[s].present,
            blurryVoxels: counts[s].blurry,
            sharpVoxels: counts[s].sharp,
            areaRows,
            droppedPieces,
            droppedRows
        });
    }

    // rank: score, then splats, then scan and first row
    areas.sort((a, b) => b.score - a.score || b.splats - a.splats || a.scan - b.scan || (a.rows[0] ?? 0) - (b.rows[0] ?? 0));
    areas.forEach((a, i) => {
        a.id = i;
    });

    return {
        cell,
        upAxis,
        upSign,
        scans: scanInfo,
        areas,
        blur: blurMaps,
        coarser: coarserMaps,
        seconds: (now() - t0) / 1000
    };
};

export {
    BLUR,
    composeBlur,
    BlurConstants,
    BlurOptions,
    BlurRows,
    BlurCompare,
    BlurArea,
    BlurScan,
    BlurResult
};
