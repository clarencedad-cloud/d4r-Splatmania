// Floater detection for gaussian splat scans (the cleanup panel's "Find
// floaters"). Pure math on typed arrays in world space (scales linear and
// times the layer scale, opacity linear 0..1), no playcanvas dependency, so it
// runs in the analysis worker and in node tests (scripts/test-floaters.mjs).
//
// The old voxel filter (splat-transform filterFloaters) kept every splat of a
// voxel that is opaque enough, so dense floater clumps survived, and it
// rasterised the whole bounding box at 5 cm, which stalls on real scans with
// far-away splats. This core works on the splats themselves, adapts every
// distance to the local splat spacing and only touches occupied space:
//
// 1. Neighbours: exact k nearest neighbours of every splat through a sparse,
//    hierarchical grid (splats sorted along a Morton curve, cells only where
//    splats are, coarser levels for sparse regions).
// 2. Pieces: neighbouring splats that touch are joined into connected pieces.
//    A large splat only joins through its centre (the distance is measured
//    against the smaller of the two), so a big blob in front of a wall does
//    not glue itself to the wall with its own size. Faint splats join a piece
//    but never bridge two. The largest pieces are the structure (the scan).
// 3. Detached pieces: every other piece is measured against the structure:
//    isolation (the gap to the nearest structure splat against the local
//    spacing of that structure), size (small pieces are floaters, large ones
//    objects of their own) and support (nothing carrying it from below or
//    beside: "in the air"). Pieces of large splats that lie in the plane of
//    the surface next to them are part of that surface.
// 4. Fog: nebulous splats - much larger than the ordinary splat size, with no
//    ordinary splat inside their core and no surface through their centre
//    (the solid splats around them at their own scale form no plane there).
//    Smooth areas and reflections on surfaces keep their large splats.
//
// Every splat gets a floater probability (0..1); the candidates are grouped
// by place so the editor can list them for review. Nothing is deleted here.

type FloaterData = {
    // xyz triples, world space
    positions: Float32Array,
    // linear scale triples (sigma, not log), world space
    scales: Float32Array,
    // linear opacity 0..1
    opacities: Float32Array
};

type FloaterOptions = {
    // world up axis (0 = x, 1 = y, 2 = z) and its sign; default +y, the
    // editor's convention for loaded scans
    upAxis?: 0 | 1 | 2,
    upSign?: 1 | -1,
    // lowest probability that still makes a splat a candidate (default 0.15)
    minProbability?: number,
    // at most this many groups (default 40): the group cells grow until
    // the candidates fit
    maxGroups?: number,
    // also return the internals (per row) for tests
    debug?: boolean,
    onProgress?: (progress: number) => void
};

// why a splat is a candidate
const REASON = { none: 0, isolated: 1, detached: 2, fog: 3 } as const;
type FloaterKind = 'isolated' | 'detached' | 'fog';

type FloaterGroup = {
    id: number,
    // candidate splats in the group (any probability above minProbability)
    count: number,
    // highest probability of its splats (0..1)
    score: number,
    kind: FloaterKind,
    center: [number, number, number],
    min: [number, number, number],
    max: [number, number, number],
    // nothing carries it from below or beside
    airborne: boolean,
    // distance to the structure in world units (Infinity: none)
    gap: number,
    // unit vector from the nearest structure towards the group (a free
    // direction to look at it from), [0, 0, 0] when unknown
    away: [number, number, number],
    // one connected piece (could be a real object); otherwise splats of a
    // region (stray specks, fog)
    single: boolean,
    // camera views onto the group with a free line of sight, best first:
    // direction from the group centre to the camera and its distance
    views: { dir: [number, number, number], distance: number }[]
};

type FloaterStats = {
    splats: number,
    // base cell size of the grid (about the typical neighbour spacing)
    cell: number,
    // robust centre and size of the scene
    sceneCenter: [number, number, number],
    sceneSize: number,
    pieces: number,
    structurePieces: number,
    structureSplats: number,
    candidates: number,
    groups: number,
    ms: number,
    // milliseconds per phase
    phases: Record<string, number>
};

type FloaterResult = {
    // per row: floater probability 0..255
    probability: Uint8Array,
    // per row: REASON
    reason: Uint8Array,
    // per row: group id, -1 for no candidate
    group: Int32Array,
    groups: FloaterGroup[],
    stats: FloaterStats,
    debug?: Record<string, ArrayLike<number>>
};

// neighbours per splat
const K = 6;
// two splats touch when their centres are closer than LINK x (sigma_i +
// sigma_j), and closer than LINK_MIN x the smaller sigma
const LINK = 2;
const LINK_MIN = 6;
// splats at least this opaque build structure; fainter ones only join
const SOLID_OPACITY = 0.15;
// nebulous: at least this many times the ordinary splat size
const FOG_SIZE = 3;
// structure neighbours for the local plane of a detached piece
const PLANE_K = 16;
// detached pieces with at least this many splats are a group of their own
const PIECE_GROUP = 40;

// grid coordinate range per axis (cells of the finest level)
const BITS = 20;
const MAX_COORD = (1 << BITS) - 1;
const MID_COORD = 1 << (BITS - 1);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 0 at or below a, 1 at or above b, linear in between
const ramp = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));

// quantile of a (sub-sampled) array
const quantile = (values: ArrayLike<number>, q: number, maxSamples = 100000) => {
    const n = values.length;
    if (n === 0) return 0;
    const step = Math.max(1, Math.floor(n / maxSamples));
    const s: number[] = [];
    for (let i = 0; i < n; i += step) {
        const v = values[i];
        if (Number.isFinite(v)) s.push(v);
    }
    if (s.length === 0) return 0;
    s.sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// --- sparse hierarchical grid ---------------------------------------------

const hash3 = (x: number, y: number, z: number) => {
    return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
};

// open addressing table from integer cell coordinates to a cell index
class CellTable {
    mask: number;

    keyX: Int32Array;

    keyY: Int32Array;

    keyZ: Int32Array;

    cell: Int32Array;

    size = 0;

    constructor(expected: number) {
        let capacity = 16;
        while (capacity < expected * 2) capacity *= 2;
        this.mask = capacity - 1;
        this.keyX = new Int32Array(capacity);
        this.keyY = new Int32Array(capacity);
        this.keyZ = new Int32Array(capacity);
        this.cell = new Int32Array(capacity).fill(-1);
    }

    insert(x: number, y: number, z: number) {
        let s = hash3(x, y, z) & this.mask;
        for (;;) {
            const c = this.cell[s];
            if (c < 0) {
                this.keyX[s] = x;
                this.keyY[s] = y;
                this.keyZ[s] = z;
                this.cell[s] = this.size;
                return this.size++;
            }
            if (this.keyX[s] === x && this.keyY[s] === y && this.keyZ[s] === z) return c;
            s = (s + 1) & this.mask;
        }
    }

    find(x: number, y: number, z: number) {
        let s = hash3(x, y, z) & this.mask;
        for (;;) {
            const c = this.cell[s];
            if (c < 0) return -1;
            if (this.keyX[s] === x && this.keyY[s] === y && this.keyZ[s] === z) return c;
            s = (s + 1) & this.mask;
        }
    }
}

const part1by2 = (v: number) => {
    v &= 0x3ff;
    v = (v | (v << 16)) & 0x030000ff;
    v = (v | (v << 8)) & 0x0300f00f;
    v = (v | (v << 4)) & 0x030c30c3;
    v = (v | (v << 2)) & 0x09249249;
    return v;
};

const morton30 = (x: number, y: number, z: number) => part1by2(x) | (part1by2(y) << 1) | (part1by2(z) << 2);

// stable counting sort pass of src into dst by 15 bits of key
const radixPass = (src: Int32Array, dst: Int32Array, key: Int32Array, shift: number) => {
    const count = new Int32Array((1 << 15) + 1);
    const n = src.length;
    for (let i = 0; i < n; i++) count[((key[src[i]] >>> shift) & 0x7fff) + 1]++;
    for (let b = 0; b < (1 << 15); b++) count[b + 1] += count[b];
    for (let i = 0; i < n; i++) {
        const r = src[i];
        dst[count[(key[r] >>> shift) & 0x7fff]++] = r;
    }
};

const emptyBox = (box: Float32Array, c: number) => {
    const o = c * 6;
    box[o] = box[o + 1] = box[o + 2] = Infinity;
    box[o + 3] = box[o + 4] = box[o + 5] = -Infinity;
};

const growBox = (box: Float32Array, c: number, x: number, y: number, z: number) => {
    const o = c * 6;
    if (x < box[o]) box[o] = x;
    if (y < box[o + 1]) box[o + 1] = y;
    if (z < box[o + 2]) box[o + 2] = z;
    if (x > box[o + 3]) box[o + 3] = x;
    if (y > box[o + 4]) box[o + 4] = y;
    if (z > box[o + 5]) box[o + 5] = z;
};

const boxDist2 = (box: Float32Array, c: number, x: number, y: number, z: number) => {
    const o = c * 6;
    const dx = Math.max(box[o] - x, 0, x - box[o + 3]);
    const dy = Math.max(box[o + 1] - y, 0, y - box[o + 4]);
    const dz = Math.max(box[o + 2] - z, 0, z - box[o + 5]);
    return dx * dx + dy * dy + dz * dz;
};

// one level of the grid: cells of size h0 * 4^level
type Level = {
    shift: number,
    size: number,
    table: CellTable,
    // per cell: its range of slots (numCells + 1 entries)
    start: Int32Array,
    // per cell: integer coordinates
    cx: Int32Array,
    cy: Int32Array,
    cz: Int32Array,
    // per cell: bounding box of the splat centres (min xyz, max xyz)
    box: Float32Array,
    // per cell: the cell of the next coarser level containing it
    up: Int32Array | null,
    // per reference set (setReference): per cell the flagged splats and
    // their bounding box
    refCount: Int32Array[],
    refBox: Float32Array[]
};

// Grid over splats that are already sorted along the Morton curve ("slots"):
// every cell of every level is a contiguous range of slots
class Grid {
    h0: number;

    ox: number;

    oy: number;

    oz: number;

    positions: Float32Array;

    levels: Level[] = [];

    constructor(positions: Float32Array, coords: Int32Array, h0: number, origin: [number, number, number]) {
        this.positions = positions;
        this.h0 = h0;
        this.ox = origin[0];
        this.oy = origin[1];
        this.oz = origin[2];
        // levels until a handful of cells remain; the finest from the slots,
        // every coarser one from the cells below (also contiguous)
        this.levels.push(this.buildFinest(coords));
        for (let level = 1; level < 10 && this.levels[level - 1].table.size > 8; level++) {
            this.levels.push(this.buildCoarser(this.levels[level - 1]));
        }
    }

    coord(v: number, o: number) {
        const c = Math.floor((v - o) / this.h0);
        return c < 0 ? 0 : c > MAX_COORD ? MAX_COORD : c;
    }

    private buildFinest(coords: Int32Array): Level {
        const positions = this.positions;
        const n = positions.length / 3;
        let cells = 0;
        let px = -1, py = -1, pz = -1;
        for (let s = 0; s < n; s++) {
            const x = coords[s * 3], y = coords[s * 3 + 1], z = coords[s * 3 + 2];
            if (x !== px || y !== py || z !== pz) {
                cells++;
                px = x;
                py = y;
                pz = z;
            }
        }
        const table = new CellTable(cells);
        const start = new Int32Array(cells + 1);
        const cx = new Int32Array(cells);
        const cy = new Int32Array(cells);
        const cz = new Int32Array(cells);
        const box = new Float32Array(cells * 6);
        let c = -1;
        px = -1;
        py = -1;
        pz = -1;
        for (let s = 0; s < n; s++) {
            const x = coords[s * 3], y = coords[s * 3 + 1], z = coords[s * 3 + 2];
            if (x !== px || y !== py || z !== pz) {
                c = table.insert(x, y, z);
                start[c] = s;
                cx[c] = x;
                cy[c] = y;
                cz[c] = z;
                emptyBox(box, c);
                px = x;
                py = y;
                pz = z;
            }
            growBox(box, c, positions[s * 3], positions[s * 3 + 1], positions[s * 3 + 2]);
        }
        start[cells] = n;
        return { shift: 0, size: this.h0, table, start, cx, cy, cz, box, up: null, refCount: [], refBox: [] };
    }

    private buildCoarser(fine: Level): Level {
        const shift = fine.shift + 2;
        const fineCells = fine.table.size;
        let cells = 0;
        let px = -1, py = -1, pz = -1;
        for (let f = 0; f < fineCells; f++) {
            const x = fine.cx[f] >> 2, y = fine.cy[f] >> 2, z = fine.cz[f] >> 2;
            if (x !== px || y !== py || z !== pz) {
                cells++;
                px = x;
                py = y;
                pz = z;
            }
        }
        const table = new CellTable(cells);
        const start = new Int32Array(cells + 1);
        const cx = new Int32Array(cells);
        const cy = new Int32Array(cells);
        const cz = new Int32Array(cells);
        const box = new Float32Array(cells * 6);
        fine.up = new Int32Array(fineCells);
        let c = -1;
        px = -1;
        py = -1;
        pz = -1;
        for (let f = 0; f < fineCells; f++) {
            const x = fine.cx[f] >> 2, y = fine.cy[f] >> 2, z = fine.cz[f] >> 2;
            if (x !== px || y !== py || z !== pz) {
                c = table.insert(x, y, z);
                start[c] = fine.start[f];
                cx[c] = x;
                cy[c] = y;
                cz[c] = z;
                emptyBox(box, c);
                px = x;
                py = y;
                pz = z;
            }
            fine.up[f] = c;
            const o = f * 6;
            growBox(box, c, fine.box[o], fine.box[o + 1], fine.box[o + 2]);
            growBox(box, c, fine.box[o + 3], fine.box[o + 4], fine.box[o + 5]);
        }
        start[cells] = fine.start[fineCells];
        return { shift, size: this.h0 * (1 << shift), table, start, cx, cy, cz, box, up: null, refCount: [], refBox: [] };
    }

    // per cell counts and boxes of the slots with flag[slot] set, as
    // reference set number `set` (Knn.filter / Knn.set)
    setReference(flag: Uint8Array, set: number) {
        const positions = this.positions;
        const finest = this.levels[0];
        let count = new Int32Array(finest.table.size);
        let box = new Float32Array(finest.table.size * 6);
        for (let c = 0; c < finest.table.size; c++) {
            emptyBox(box, c);
            for (let s = finest.start[c]; s < finest.start[c + 1]; s++) {
                if (!flag[s]) continue;
                count[c]++;
                growBox(box, c, positions[s * 3], positions[s * 3 + 1], positions[s * 3 + 2]);
            }
        }
        finest.refCount[set] = count;
        finest.refBox[set] = box;
        for (let li = 1; li < this.levels.length; li++) {
            const fine = this.levels[li - 1];
            const level = this.levels[li];
            const coarseCount = new Int32Array(level.table.size);
            const coarseBox = new Float32Array(level.table.size * 6);
            for (let c = 0; c < level.table.size; c++) emptyBox(coarseBox, c);
            for (let f = 0; f < fine.table.size; f++) {
                if (count[f] === 0) continue;
                const c = fine.up[f];
                coarseCount[c] += count[f];
                const o = f * 6;
                growBox(coarseBox, c, box[o], box[o + 1], box[o + 2]);
                growBox(coarseBox, c, box[o + 3], box[o + 4], box[o + 5]);
            }
            level.refCount[set] = coarseCount;
            level.refBox[set] = coarseBox;
            count = coarseCount;
            box = coarseBox;
        }
    }
}

// a spread sample of the slots whose centre lies between rMin and rMax from
// (x, y, z) and that pass the filter: at most `perCell` of every cell of a
// level about as coarse as the ring, so large rings stay cheap
const gatherRing = (grid: Grid, x: number, y: number, z: number, rMin: number, rMax: number, filter: Uint8Array, perCell: number, out: number[]) => {
    out.length = 0;
    let li = 0;
    while (li < grid.levels.length - 1 && grid.levels[li].size < rMax / 2) li++;
    const level = grid.levels[li];
    const shift = level.shift;
    const ix = grid.coord(x, grid.ox) >> shift, iy = grid.coord(y, grid.oy) >> shift, iz = grid.coord(z, grid.oz) >> shift;
    const reach = Math.min(3, Math.ceil(rMax / level.size));
    const max2 = rMax * rMax, min2 = rMin * rMin;
    const positions = grid.positions;
    for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
            for (let dz = -reach; dz <= reach; dz++) {
                const c = level.table.find(ix + dx, iy + dy, iz + dz);
                if (c < 0 || boxDist2(level.box, c, x, y, z) > max2) continue;
                const from = level.start[c], to = level.start[c + 1];
                const stride = Math.max(1, Math.floor((to - from) / perCell));
                for (let s = from; s < to; s += stride) {
                    if (!filter[s]) continue;
                    const ex = positions[s * 3] - x, ey = positions[s * 3 + 1] - y, ez = positions[s * 3 + 2] - z;
                    const d2 = ex * ex + ey * ey + ez * ez;
                    if (d2 >= min2 && d2 <= max2) out.push(s);
                }
            }
        }
    }
};

// k nearest slots around a point, exact: shells of cells at the finest
// level, coarser levels for sparse regions, cells pruned by their boxes
class Knn {
    grid: Grid;

    k: number;

    d2: Float64Array;

    idx: Int32Array;

    found = 0;

    // only slots with filter[slot] (and only cells of reference set `set`)
    filter: Uint8Array | null = null;

    set = 0;

    private exclude = -1;

    private qx = 0;

    private qy = 0;

    private qz = 0;

    constructor(grid: Grid, k: number) {
        this.grid = grid;
        this.k = k;
        this.d2 = new Float64Array(k);
        this.idx = new Int32Array(k);
    }

    private consider(s: number) {
        if (s === this.exclude) return;
        const p = this.grid.positions;
        const dx = p[s * 3] - this.qx, dy = p[s * 3 + 1] - this.qy, dz = p[s * 3 + 2] - this.qz;
        const d = dx * dx + dy * dy + dz * dz;
        const { k, d2, idx } = this;
        if (this.found === k && d >= d2[k - 1]) return;
        // already listed (a coarser level scans cells again)
        for (let i = 0; i < this.found; i++) if (idx[i] === s) return;
        let i = this.found < k ? this.found++ : k - 1;
        while (i > 0 && d2[i - 1] > d) {
            d2[i] = d2[i - 1];
            idx[i] = idx[i - 1];
            i--;
        }
        d2[i] = d;
        idx[i] = s;
    }

    private worst() {
        return this.found === this.k ? this.d2[this.k - 1] : Infinity;
    }

    // every slot of cell c at level li, through its children when it is large
    private scanCell(li: number, c: number) {
        const grid = this.grid;
        const level = grid.levels[li];
        const filter = this.filter;
        const from = level.start[c], to = level.start[c + 1];
        if (li === 0 || to - from <= 48) {
            if (filter) {
                for (let s = from; s < to; s++) if (filter[s]) this.consider(s);
            } else {
                for (let s = from; s < to; s++) this.consider(s);
            }
            return;
        }
        const child = grid.levels[li - 1];
        const refCount = filter ? child.refCount[this.set] : null;
        const box = filter ? child.refBox[this.set] : child.box;
        const bx = level.cx[c] << 2, by = level.cy[c] << 2, bz = level.cz[c] << 2;
        for (let a = 0; a < 4; a++) {
            for (let b = 0; b < 4; b++) {
                for (let d = 0; d < 4; d++) {
                    const cc = child.table.find(bx + a, by + b, bz + d);
                    if (cc < 0 || (refCount && refCount[cc] === 0)) continue;
                    if (boxDist2(box, cc, this.qx, this.qy, this.qz) >= this.worst()) continue;
                    this.scanCell(li - 1, cc);
                }
            }
        }
    }

    // search around (x, y, z), skipping slot `exclude`; maxDist bounds the
    // search (Infinity = unbounded)
    search(x: number, y: number, z: number, exclude: number, maxDist = Infinity) {
        this.found = 0;
        this.exclude = exclude;
        this.qx = x;
        this.qy = y;
        this.qz = z;
        const grid = this.grid;
        const filter = this.filter;
        const max2 = maxDist * maxDist;
        const bx = grid.coord(x, grid.ox), by = grid.coord(y, grid.oy), bz = grid.coord(z, grid.oz);
        for (let li = 0; li < grid.levels.length; li++) {
            const level = grid.levels[li];
            const shift = level.shift;
            const ix = bx >> shift, iy = by >> shift, iz = bz >> shift;
            const box = filter ? level.refBox[this.set] : level.box;
            const refCount = filter ? level.refCount[this.set] : null;
            const table = level.table;
            for (let r = 0; r <= 2; r++) {
                for (let dx = -r; dx <= r; dx++) {
                    const ax = dx < 0 ? -dx : dx;
                    for (let dy = -r; dy <= r; dy++) {
                        const ay = dy < 0 ? -dy : dy;
                        // only the shell of the cube
                        const onShell = ax === r || ay === r;
                        for (let dz = -r; dz <= r; dz += (onShell || r === 0 ? 1 : 2 * r)) {
                            const c = table.find(ix + dx, iy + dy, iz + dz);
                            if (c < 0 || (refCount && refCount[c] === 0)) continue;
                            const bd = boxDist2(box, c, x, y, z);
                            if (bd >= this.worst() || bd > max2) continue;
                            this.scanCell(li, c);
                        }
                    }
                }
                // every slot within r cells has been seen
                const covered = r * level.size;
                if (this.found === this.k && this.d2[this.k - 1] <= covered * covered) return;
                if (covered >= maxDist) return;
            }
        }
    }
}

// --- union find -----------------------------------------------------------

const find = (parent: Int32Array, i: number) => {
    while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    return i;
};

const union = (parent: Int32Array, size: Int32Array, a: number, b: number) => {
    a = find(parent, a);
    b = find(parent, b);
    if (a === b) return;
    if (size[a] < size[b]) {
        const t = a;
        a = b;
        b = t;
    }
    parent[b] = a;
    size[a] += size[b];
};

// --- local surface plane ----------------------------------------------------

// distance of a point from the plane through the given slots, and the
// thickness of that neighbourhood (spread along the plane normal)
const planeOffset = (positions: Float32Array, idx: ArrayLike<number>, count: number, x: number, y: number, z: number) => {
    let mx = 0, my = 0, mz = 0;
    for (let m = 0; m < count; m++) {
        const j = idx[m];
        mx += positions[j * 3];
        my += positions[j * 3 + 1];
        mz += positions[j * 3 + 2];
    }
    mx /= count;
    my /= count;
    mz /= count;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let m = 0; m < count; m++) {
        const j = idx[m];
        const dx = positions[j * 3] - mx, dy = positions[j * 3 + 1] - my, dz = positions[j * 3 + 2] - mz;
        xx += dx * dx;
        xy += dx * dy;
        xz += dx * dz;
        yy += dy * dy;
        yz += dy * dz;
        zz += dz * dz;
    }
    xx /= count;
    xy /= count;
    xz /= count;
    yy /= count;
    yz /= count;
    zz /= count;

    // smallest eigenvalue of the covariance (closed form for symmetric 3x3)
    const p1 = xy * xy + xz * xz + yz * yz;
    const q = (xx + yy + zz) / 3;
    let lambda: number;
    if (p1 < 1e-30) {
        lambda = Math.min(xx, yy, zz);
    } else {
        const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1;
        const p = Math.sqrt(p2 / 6);
        const b00 = (xx - q) / p, b11 = (yy - q) / p, b22 = (zz - q) / p;
        const b01 = xy / p, b02 = xz / p, b12 = yz / p;
        const det = b00 * (b11 * b22 - b12 * b12) - b01 * (b01 * b22 - b12 * b02) + b02 * (b01 * b12 - b11 * b02);
        const r = Math.max(-1, Math.min(1, det / 2));
        const phi = Math.acos(r) / 3;
        lambda = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
    }
    // its eigenvector: the largest cross product of two rows of (C - lambda I)
    const a0 = xx - lambda, a1 = yy - lambda, a2 = zz - lambda;
    const c0x = xy * yz - xz * a1, c0y = xz * xy - a0 * yz, c0z = a0 * a1 - xy * xy;
    const c1x = xy * a2 - xz * yz, c1y = xz * xz - a0 * a2, c1z = a0 * yz - xy * xz;
    const c2x = a1 * a2 - yz * yz, c2y = yz * xz - xy * a2, c2z = xy * yz - a1 * xz;
    const l0 = c0x * c0x + c0y * c0y + c0z * c0z;
    const l1 = c1x * c1x + c1y * c1y + c1z * c1z;
    const l2 = c2x * c2x + c2y * c2y + c2z * c2z;
    let nx = c0x, ny = c0y, nz = c0z, best = l0;
    if (l1 > best) {
        nx = c1x;
        ny = c1y;
        nz = c1z;
        best = l1;
    }
    if (l2 > best) {
        nx = c2x;
        ny = c2y;
        nz = c2z;
        best = l2;
    }
    const thickness = Math.sqrt(Math.max(lambda, 0));
    if (best < 1e-40) return { offset: 0, thickness };
    const offset = Math.abs((x - mx) * nx + (y - my) * ny + (z - mz) * nz) / Math.sqrt(best);
    return { offset, thickness };
};

// k nearest neighbours of every slot, cell by cell: the candidates of the
// 27 cells around a cell are gathered once for all its splats; splats whose
// K-th neighbour is further than one cell are tried against the 125 cells,
// the rest go through the full search. visit(i, j, distance) is called for
// the neighbours of every slot, spacing[i] gets the distance to the K-th.
// Returns the number of full searches. (A function of its own: inside the
// large detection function the engine optimises these loops poorly.)
const neighbourPass = (grid: Grid, spacing: Float32Array, visit: (i: number, j: number, d: number) => void, onProgress: (p: number) => void) => {
    const positions = grid.positions;
    const level = grid.levels[0];
    const knn = new Knn(grid, K);
    // the slot ranges of the cells around the current cell (27, then 125)
    const rangeFrom = new Int32Array(125);
    const rangeTo = new Int32Array(125);
    const bestD = new Float64Array(K);
    const bestI = new Int32Array(K);
    let pendingList = new Int32Array(256);
    const h2 = grid.h0 * grid.h0;
    let fallbacks = 0;
    const cells = level.table.size;
    const progressStep = Math.max(1, Math.floor(cells / 25));
    const gather = (ix: number, iy: number, iz: number, ring: number, nr: number) => {
        for (let dx = -ring; dx <= ring; dx++) {
            for (let dy = -ring; dy <= ring; dy++) {
                for (let dz = -ring; dz <= ring; dz++) {
                    if (ring === 2 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) < 2) continue;
                    const cc = level.table.find(ix + dx, iy + dy, iz + dz);
                    if (cc < 0) continue;
                    rangeFrom[nr] = level.start[cc];
                    rangeTo[nr] = level.start[cc + 1];
                    nr++;
                }
            }
        }
        return nr;
    };
    // nearest K of slot i among the gathered ranges, into bestD / bestI
    const nearest = (i: number, nr: number) => {
        const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        let found = 0;
        let worst = Infinity;
        for (let g = 0; g < nr; g++) {
            const to = rangeTo[g];
            for (let j = rangeFrom[g]; j < to; j++) {
                const ex = positions[j * 3] - x, ey = positions[j * 3 + 1] - y, ez = positions[j * 3 + 2] - z;
                const d = ex * ex + ey * ey + ez * ez;
                if (d >= worst || j === i) continue;
                let q = found < K ? found++ : K - 1;
                while (q > 0 && bestD[q - 1] > d) {
                    bestD[q] = bestD[q - 1];
                    bestI[q] = bestI[q - 1];
                    q--;
                }
                bestD[q] = d;
                bestI[q] = j;
                if (found === K) worst = bestD[K - 1];
            }
        }
        return found;
    };
    for (let c = 0; c < cells; c++) {
        const ix = level.cx[c], iy = level.cy[c], iz = level.cz[c];
        let nr = gather(ix, iy, iz, 1, 0);
        let pending = 0;
        for (let i = level.start[c]; i < level.start[c + 1]; i++) {
            const found = nearest(i, nr);
            if (found < K || bestD[K - 1] > h2) {
                if (pending === pendingList.length) {
                    const grown = new Int32Array(pendingList.length * 2);
                    grown.set(pendingList);
                    pendingList = grown;
                }
                pendingList[pending++] = i;
                continue;
            }
            spacing[i] = Math.sqrt(bestD[K - 1]);
            for (let t = 0; t < K; t++) visit(i, bestI[t], Math.sqrt(bestD[t]));
        }
        if (pending > 0) {
            nr = gather(ix, iy, iz, 2, nr);
            for (let t0 = 0; t0 < pending; t0++) {
                const i = pendingList[t0];
                let found = nearest(i, nr);
                let dist: Float64Array = bestD;
                let idx: Int32Array = bestI;
                if (found < K || bestD[K - 1] > 4 * h2) {
                    fallbacks++;
                    knn.search(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], i);
                    found = knn.found;
                    dist = knn.d2;
                    idx = knn.idx;
                }
                if (found > 0) spacing[i] = Math.sqrt(dist[found - 1]);
                for (let t = 0; t < found; t++) visit(i, idx[t], Math.sqrt(dist[t]));
            }
        }
        if (c % progressStep === 0) onProgress(c / cells);
    }
    return fallbacks;
};

// --- detection --------------------------------------------------------------

const detectFloaters = (data: FloaterData, options: FloaterOptions = {}): FloaterResult => {
    const t0 = Date.now();
    const phases: Record<string, number> = {};
    let tPhase = t0;
    const phase = (name: string) => {
        const now = Date.now();
        phases[name] = now - tPhase;
        tPhase = now;
    };
    const n = data.opacities.length;
    const upAxis = options.upAxis ?? 1;
    const upSign = options.upSign ?? 1;
    const minProbability = options.minProbability ?? 0.15;
    const maxGroups = Math.max(1, options.maxGroups ?? 40);
    const onProgress = options.onProgress ?? ((): void => undefined);

    // per row results
    const probability = new Uint8Array(n);
    const reason = new Uint8Array(n);
    const group = new Int32Array(n).fill(-1);

    // rows with finite centres and sizes (NaN splats have their own filter)
    const rowsAll = new Int32Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
        const v = data.positions[i * 3] + data.positions[i * 3 + 1] + data.positions[i * 3 + 2] +
            data.scales[i * 3] + data.scales[i * 3 + 1] + data.scales[i * 3 + 2] + data.opacities[i];
        if (Number.isFinite(v)) rowsAll[m++] = i;
    }
    const sceneCenter: [number, number, number] = [0, 0, 0];
    const stats = (extra: Partial<FloaterStats>): FloaterStats => ({
        splats: n, cell: 0, sceneCenter, sceneSize: 0, pieces: 0, structurePieces: 0, structureSplats: 0, candidates: 0, groups: 0, ...extra, ms: Date.now() - t0, phases
    });
    if (m < 2) return { probability, reason, group, groups: [], stats: stats({}) };
    const valid = rowsAll.subarray(0, m);

    // robust centre and size of the scene
    const sampleStep = Math.max(1, Math.floor(m / 30000));
    let sceneSize = 0;
    for (let axis = 0; axis < 3; axis++) {
        const v: number[] = [];
        for (let k = 0; k < m; k += sampleStep) v.push(data.positions[valid[k] * 3 + axis]);
        sceneCenter[axis] = quantile(v, 0.5);
        sceneSize = Math.max(sceneSize, quantile(v, 0.99) - quantile(v, 0.01));
    }
    sceneSize = Math.max(sceneSize, 1e-6);

    // base cell about twice the median splat size; it only affects the speed
    const sigmaSample: number[] = [];
    for (let k = 0; k < m; k += sampleStep) {
        const r = valid[k];
        sigmaSample.push(Math.max(Math.abs(data.scales[r * 3]), Math.abs(data.scales[r * 3 + 1]), Math.abs(data.scales[r * 3 + 2])));
    }
    const medianSigma = Math.max(quantile(sigmaSample, 0.5), sceneSize * 1e-6);
    const h0 = Math.max(sceneSize * 4 / (1 << BITS), 2 * medianSigma);
    const origin: [number, number, number] = [sceneCenter[0] - MID_COORD * h0, sceneCenter[1] - MID_COORD * h0, sceneCenter[2] - MID_COORD * h0];
    const cellOf = (v: number, o: number) => {
        const c = Math.floor((v - o) / h0);
        return c < 0 ? 0 : c > MAX_COORD ? MAX_COORD : c;
    };

    // sort along the Morton curve: neighbours in space become neighbours in
    // memory, and every grid cell a contiguous range ("slots")
    let slotRow: Int32Array;
    {
        const lo = new Int32Array(m);
        const hi = new Int32Array(m);
        for (let k = 0; k < m; k++) {
            const r = valid[k];
            const x = cellOf(data.positions[r * 3], origin[0]);
            const y = cellOf(data.positions[r * 3 + 1], origin[1]);
            const z = cellOf(data.positions[r * 3 + 2], origin[2]);
            lo[k] = morton30(x & 0x3ff, y & 0x3ff, z & 0x3ff);
            hi[k] = morton30(x >> 10, y >> 10, z >> 10);
        }
        const a = new Int32Array(m);
        for (let k = 0; k < m; k++) a[k] = k;
        const b = new Int32Array(m);
        radixPass(a, b, lo, 0);
        radixPass(b, a, lo, 15);
        radixPass(a, b, hi, 0);
        radixPass(b, a, hi, 15);
        slotRow = new Int32Array(m);
        for (let s = 0; s < m; s++) slotRow[s] = valid[a[s]];
    }

    // per slot data
    const positions = new Float32Array(m * 3);
    const coords = new Int32Array(m * 3);
    const sigma = new Float32Array(m);
    const footprint = new Float32Array(m);
    const opacity = new Float32Array(m);
    for (let s = 0; s < m; s++) {
        const r = slotRow[s];
        const x = data.positions[r * 3], y = data.positions[r * 3 + 1], z = data.positions[r * 3 + 2];
        positions[s * 3] = x;
        positions[s * 3 + 1] = y;
        positions[s * 3 + 2] = z;
        coords[s * 3] = cellOf(x, origin[0]);
        coords[s * 3 + 1] = cellOf(y, origin[1]);
        coords[s * 3 + 2] = cellOf(z, origin[2]);
        const a = Math.abs(data.scales[r * 3]), b = Math.abs(data.scales[r * 3 + 1]), c = Math.abs(data.scales[r * 3 + 2]);
        const hi = Math.max(a, b, c);
        const mid = a + b + c - hi - Math.min(a, b, c);
        sigma[s] = hi;
        footprint[s] = Math.sqrt(hi * mid);
        opacity[s] = data.opacities[r];
    }
    const grid = new Grid(positions, coords, h0, origin);
    onProgress(0.08);
    phase('grid');

    // pass 1: neighbours, local spacing and the touching pieces
    const solid = new Uint8Array(m);
    for (let s = 0; s < m; s++) if (opacity[s] >= SOLID_OPACITY) solid[s] = 1;
    // distance to the K-th neighbour: the local spacing
    const spacing = new Float32Array(m).fill(Infinity);
    const parent = new Int32Array(m);
    const size = new Int32Array(m).fill(1);
    // faint splats: their own pieces, plus the solid piece they touch
    const faintParent = new Int32Array(m);
    const faintSize = new Int32Array(m).fill(1);
    const attach = new Int32Array(m).fill(-1);
    const attachDist = new Float32Array(m).fill(Infinity);
    for (let s = 0; s < m; s++) {
        parent[s] = s;
        faintParent[s] = s;
    }

    const link = (i: number, j: number, d: number) => {
        const si = sigma[i], sj = sigma[j];
        if (d > LINK * (si + sj) || d > LINK_MIN * Math.min(si, sj)) return;
        if (solid[i] && solid[j]) {
            union(parent, size, i, j);
        } else if (solid[i] || solid[j]) {
            // the faint one hangs on the solid one
            const f = solid[i] ? j : i;
            if (d < attachDist[f]) {
                attachDist[f] = d;
                attach[f] = solid[i] ? i : j;
            }
        } else {
            union(faintParent, faintSize, i, j);
        }
    };

    phases.fallbacks = neighbourPass(grid, spacing, link, p => onProgress(0.08 + 0.52 * p));
    phase('neighbours');

    // pieces: solid roots; faint splats take the largest solid piece their
    // faint piece touches, otherwise the faint piece is a piece of its own
    const piece = new Int32Array(m).fill(-1);
    const pieceOfRoot = new Map<number, number>();
    let pieces = 0;
    const pieceFor = (key: number) => {
        let p = pieceOfRoot.get(key);
        if (p === undefined) {
            p = pieces++;
            pieceOfRoot.set(key, p);
        }
        return p;
    };
    for (let s = 0; s < m; s++) if (solid[s]) piece[s] = pieceFor(find(parent, s));
    const solidPieceSize = new Int32Array(pieces);
    for (let s = 0; s < m; s++) if (solid[s]) solidPieceSize[piece[s]]++;
    const faintTarget = new Map<number, number>();
    for (let s = 0; s < m; s++) {
        if (solid[s] || attach[s] < 0) continue;
        const root = find(faintParent, s);
        const target = piece[attach[s]];
        const current = faintTarget.get(root);
        if (current === undefined || solidPieceSize[target] > solidPieceSize[current]) faintTarget.set(root, target);
    }
    for (let s = 0; s < m; s++) {
        if (solid[s]) continue;
        const root = find(faintParent, s);
        const target = faintTarget.get(root);
        // faint pieces get keys above every slot
        piece[s] = target !== undefined ? target : pieceFor(m + root);
    }

    // piece statistics
    const pCount = new Int32Array(pieces);
    const pLogSigma = new Float64Array(pieces);
    const pLogFoot = new Float64Array(pieces);
    const pSum = new Float64Array(pieces * 3);
    const pBox = new Float32Array(pieces * 6);
    for (let p = 0; p < pieces; p++) emptyBox(pBox, p);
    for (let s = 0; s < m; s++) {
        const p = piece[s];
        pCount[p]++;
        pLogSigma[p] += Math.log(Math.max(sigma[s], 1e-12));
        pLogFoot[p] += Math.log(Math.max(footprint[s], 1e-12));
        const x = positions[s * 3], y = positions[s * 3 + 1], z = positions[s * 3 + 2];
        pSum[p * 3] += x;
        pSum[p * 3 + 1] += y;
        pSum[p * 3 + 2] += z;
        growBox(pBox, p, x, y, z);
    }

    // structure: the largest pieces covering most of the scan, plus every
    // piece of a substantial size of its own
    const byCount = Array.from({ length: pieces }, (_, p) => p).sort((a, b) => pCount[b] - pCount[a]);
    const isStructure = new Uint8Array(pieces);
    const minStructure = Math.max(500, 0.02 * pCount[byCount[0]]);
    let covered = 0;
    let structurePieces = 0;
    let structureSplats = 0;
    for (const p of byCount) {
        if (covered >= 0.7 * m && pCount[p] < minStructure) break;
        isStructure[p] = 1;
        structurePieces++;
        structureSplats += pCount[p];
        covered += pCount[p];
    }
    // ordinary splat size: the median footprint of the solid splats
    const solidFoot: number[] = [];
    for (let s = 0; s < m; s += sampleStep) if (solid[s]) solidFoot.push(footprint[s]);
    const fineScale = Math.max(quantile(solidFoot, 0.5), 1e-12);
    // the reference for gaps: solid structure splats of ordinary size (large
    // blobs inside the structure are no anchor for a floater next to them)
    const isRef = new Uint8Array(m);
    for (let s = 0; s < m; s++) {
        if (isStructure[piece[s]] && solid[s] && footprint[s] <= 2 * FOG_SIZE * fineScale) isRef[s] = 1;
    }
    grid.setReference(isRef, 0);
    onProgress(0.65);
    phase('pieces');

    // the slots of every piece, for sampling
    const pieceStart = new Int32Array(pieces + 1);
    for (let p = 0; p < pieces; p++) pieceStart[p + 1] = pieceStart[p] + pCount[p];
    const pieceSlots = new Int32Array(m);
    {
        const fill = pieceStart.slice(0, pieces);
        for (let s = 0; s < m; s++) pieceSlots[fill[piece[s]]++] = s;
    }

    // detached pieces: isolation, size, support, surface
    const near = new Knn(grid, 1);
    near.filter = isRef;
    const below = new Knn(grid, 1);
    below.filter = isRef;
    const plane = new Knn(grid, PLANE_K);
    plane.filter = isRef;
    const pieceScore = new Float32Array(pieces);
    const pieceNebulous = new Uint8Array(pieces);
    const pieceGap = new Float32Array(pieces).fill(Infinity);
    const pieceAirborne = new Uint8Array(pieces);
    const pieceAway = new Float32Array(pieces * 3);
    // per piece: isolation, size term, surface flag (tests)
    const pieceIsolation = new Float32Array(pieces).fill(-1);
    const pieceSizeTerm = new Float32Array(pieces).fill(-1);
    const pieceOnSurface = new Uint8Array(pieces);
    const up = upAxis;
    const sizeLo = Math.log(Math.max(100, m * 5e-5));
    const sizeHi = Math.log(Math.max(10000, m * 1e-2));
    let evaluated = 0;
    const candidatePieces = Math.max(1, pieces - structurePieces);
    for (let p = 0; p < pieces; p++) {
        if (isStructure[p]) continue;
        evaluated++;
        if (evaluated % 1000 === 0) onProgress(0.65 + 0.15 * evaluated / candidatePieces);
        const count = pCount[p];
        const typicalSigma = Math.exp(pLogSigma[p] / count);
        const typicalFoot = Math.exp(pLogFoot[p] / count);
        const cx = pSum[p * 3] / count, cy = pSum[p * 3 + 1] / count, cz = pSum[p * 3 + 2] / count;
        const ext = Math.hypot(pBox[p * 6 + 3] - pBox[p * 6], pBox[p * 6 + 4] - pBox[p * 6 + 1], pBox[p * 6 + 5] - pBox[p * 6 + 2]);

        // nearest structure splat over (a sample of) the piece's splats
        let gap = Infinity;
        let nearest = -1;
        if (structureSplats > 0) {
            const from = pieceStart[p], to = pieceStart[p + 1];
            const stride = Math.max(1, Math.floor((to - from) / 256));
            for (let k = from; k < to; k += stride) {
                const s = pieceSlots[k];
                near.search(positions[s * 3], positions[s * 3 + 1], positions[s * 3 + 2], s, gap);
                if (near.found > 0) {
                    const d = Math.sqrt(near.d2[0]);
                    if (d < gap) {
                        gap = d;
                        nearest = near.idx[0];
                    }
                }
            }
        }
        pieceGap[p] = gap;
        if (nearest < 0) continue;

        // isolation: the gap against the spacing of the structure it is
        // closest to (the local density), at least that splat's own size
        const structureSpacing = Math.max(spacing[nearest], sigma[nearest], 1e-12);
        const isolation = gap / structureSpacing;
        // 0 up to 2x, 1 from 8x on (log scale)
        const sGap = ramp(Math.log2(Math.max(isolation, 1e-9)), 1, 3);

        // small pieces are floaters, large ones objects of their own
        const sSize = 1 - ramp(Math.log(count), sizeLo, sizeHi);

        // large splats lying in the plane of the surface next to them are
        // that surface (smooth areas are covered by a few big splats)
        let onSurface = false;
        if (typicalSigma >= 0.5 * structureSpacing) {
            plane.search(cx, cy, cz, -1);
            if (plane.found >= 4) {
                const { offset, thickness } = planeOffset(positions, plane.idx, plane.found, cx, cy, cz);
                onSurface = offset <= 2.5 * thickness + 0.5 * structureSpacing;
            }
        }
        pieceNebulous[p] = typicalFoot >= FOG_SIZE * fineScale ? 1 : 0;

        // in the air: no structure right beside it (within a few splat sizes
        // and the structure spacing) and none carrying it from below (a
        // little further: the base of an object is often reconstructed with
        // a gap)
        const support = 3 * typicalSigma + 2 * structureSpacing;
        let airborne = 1;
        if (gap <= support) {
            airborne = 0;
        } else {
            const bottom = [cx, cy, cz];
            bottom[up] = upSign > 0 ? pBox[p * 6 + up] : pBox[p * 6 + 3 + up];
            const reach = 6 * typicalSigma + 4 * structureSpacing;
            below.search(bottom[0], bottom[1], bottom[2], -1, reach);
            if (below.found > 0 && Math.sqrt(below.d2[0]) <= reach) {
                const j = below.idx[0];
                // the carrying splat lies below the piece's bottom
                if ((positions[j * 3 + up] - bottom[up]) * upSign <= 0.25 * ext) airborne = 0;
            }
        }
        pieceAirborne[p] = airborne;

        const ax = cx - positions[nearest * 3], ay = cy - positions[nearest * 3 + 1], az = cz - positions[nearest * 3 + 2];
        const al = Math.hypot(ax, ay, az);
        if (al > 1e-12) {
            pieceAway[p * 3] = ax / al;
            pieceAway[p * 3 + 1] = ay / al;
            pieceAway[p * 3 + 2] = az / al;
        }

        pieceIsolation[p] = isolation;
        pieceSizeTerm[p] = sSize;
        pieceOnSurface[p] = onSurface ? 1 : 0;
        // structure beside it lowers the score, except for nebulous pieces:
        // haze off a wall is an artefact all the same
        pieceScore[p] = onSurface ? 0 : clamp01(sGap * sSize * (airborne || pieceNebulous[p] ? 1 : 0.6));
    }
    onProgress(0.8);
    phase('detached');

    // fog: nebulous splats - large against the ordinary splat size and
    // floating free: no splat of ordinary size within their core (smooth
    // areas and reflections on surfaces always have some), and the solid
    // splats around them at their own scale form no plane through their
    // centre (at the scale of the nearest neighbours real scans are too
    // thick and noisy for that, and the splats' own orientation is
    // unreliable: many lie tilted on a flat floor)
    const fogScore = new Float32Array(m);
    {
        const isFine = new Uint8Array(m);
        for (let s = 0; s < m; s++) if (solid[s] && footprint[s] <= 2 * fineScale) isFine[s] = 1;
        grid.setReference(isFine, 1);
        const fine = new Knn(grid, 1);
        fine.filter = isFine;
        fine.set = 1;
        const ring: number[] = [];

        // inside the scene: looking outwards from the scene centre through
        // the splat, fine structure follows further out. Poorly captured far
        // walls are built from large, blurry splats as well, but nothing lies
        // beyond them; deleting them would open holes into the background.
        let rayLevel = 0;
        while (rayLevel < grid.levels.length - 1 && grid.levels[rayLevel].size < sceneSize / 200) rayLevel++;
        const ray = grid.levels[rayLevel];
        const rayFine = ray.refCount[1];
        const insideScene = (x: number, y: number, z: number, sr: number) => {
            let dx = x - sceneCenter[0], dy = y - sceneCenter[1], dz = z - sceneCenter[2];
            const len = Math.hypot(dx, dy, dz);
            if (len < 1e-9) return true;
            dx /= len;
            dy /= len;
            dz /= len;
            const step = ray.size;
            for (let t = Math.max(3 * sr, step); t <= 1.5 * sceneSize; t += step) {
                const c = ray.table.find(
                    grid.coord(x + dx * t, grid.ox) >> ray.shift,
                    grid.coord(y + dy * t, grid.oy) >> ray.shift,
                    grid.coord(z + dz * t, grid.oz) >> ray.shift
                );
                if (c >= 0 && rayFine[c] > 0) return true;
            }
            return false;
        };

        const progressStep = Math.max(1, Math.floor(m / 10));
        for (let s = 0; s < m; s++) {
            if (s % progressStep === 0) onProgress(0.8 + 0.15 * s / m);
            const big = ramp(Math.log2(footprint[s] / fineScale), Math.log2(FOG_SIZE), Math.log2(FOG_SIZE * 3));
            if (big <= 0) continue;
            // large splats look soft at any opacity, so opacity only weighs in
            const soft = 0.6 + 0.4 * ramp(0.9 - opacity[s], 0, 0.6);
            if (big * soft < minProbability) continue;
            const x = positions[s * 3], y = positions[s * 3 + 1], z = positions[s * 3 + 2];
            const sr = sigma[s];
            fine.search(x, y, z, s, 1.5 * sr);
            const gapFine = fine.found > 0 ? Math.sqrt(fine.d2[0]) : Infinity;
            const free = ramp(gapFine / sr, 0.5, 1);
            if (free <= 0) continue;
            if (!insideScene(x, y, z, sr)) continue;
            gatherRing(grid, x, y, z, 0.3 * sr, 2 * sr, solid, 4, ring);
            let off = 1;
            if (ring.length >= 6) {
                const { offset, thickness } = planeOffset(positions, ring, ring.length, x, y, z);
                off = Math.max(ramp(offset / sr, 0.3, 0.8), ramp(thickness / sr, 0.2, 0.45));
            }
            fogScore[s] = big * soft * off * free;
        }
    }
    phase('fog');

    // per splat probability and reason
    const probSlot = new Float32Array(m);
    let candidates = 0;
    for (let s = 0; s < m; s++) {
        const p = piece[s];
        const det = isStructure[p] ? 0 : pieceScore[p];
        const fog = fogScore[s];
        const prob = Math.max(det, fog);
        if (prob < minProbability) continue;
        probSlot[s] = prob;
        const r = slotRow[s];
        probability[r] = Math.max(1, Math.round(prob * 255));
        if (fog > det || pieceNebulous[p]) {
            reason[r] = REASON.fog;
        } else {
            reason[r] = pCount[p] <= 3 ? REASON.isolated : REASON.detached;
        }
        candidates++;
    }

    // groups: every larger detached piece on its own (a lamp must not share
    // its verdict with the specks around it), the rest by place, in cells of
    // a coarse grid (pieces kept whole, at the cell of their centre) that grow
    // until at most maxGroups groups remain
    const ownGroup = new Map<number, number>();
    {
        const large: number[] = [];
        for (let p = 0; p < pieces; p++) {
            if (!isStructure[p] && pCount[p] >= PIECE_GROUP && pieceScore[p] >= minProbability) large.push(p);
        }
        large.sort((a, b) => pCount[b] - pCount[a]);
        large.slice(0, Math.floor(maxGroups / 2)).forEach((p, i) => ownGroup.set(p, i));
    }
    const anchorOf = (s: number, a: number) => {
        const p = piece[s];
        return isStructure[p] ? positions[s * 3 + a] : pSum[p * 3 + a] / pCount[p];
    };
    let groupCell = Math.max(0.05 * sceneSize, 8 * h0);
    let cellTable: CellTable;
    let slotCell: Int32Array;
    for (;;) {
        cellTable = new CellTable(Math.max(16, candidates));
        slotCell = new Int32Array(m).fill(-1);
        for (let s = 0; s < m; s++) {
            if (!probSlot[s]) continue;
            const own = ownGroup.get(piece[s]);
            if (own !== undefined) {
                slotCell[s] = own;
                continue;
            }
            slotCell[s] = ownGroup.size + cellTable.insert(
                Math.floor((anchorOf(s, 0) - sceneCenter[0]) / groupCell),
                Math.floor((anchorOf(s, 1) - sceneCenter[1]) / groupCell),
                Math.floor((anchorOf(s, 2) - sceneCenter[2]) / groupCell)
            );
        }
        if (ownGroup.size + cellTable.size <= maxGroups) break;
        groupCell *= 1.5;
    }
    const groupCount = ownGroup.size + cellTable.size;
    const groups: FloaterGroup[] = [];
    const kindCount: number[][] = [];
    const gapOf: number[] = [];
    const airborneOf: number[] = [];
    const awaySum: number[][] = [];
    for (let g = 0; g < groupCount; g++) {
        groups.push({ id: g, count: 0, score: 0, kind: 'detached', center: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], airborne: false, gap: Infinity, away: [0, 0, 0], single: g < ownGroup.size, views: [] });
        kindCount.push([0, 0, 0, 0]);
        gapOf.push(Infinity);
        airborneOf.push(0);
        awaySum.push([0, 0, 0]);
    }
    for (let s = 0; s < m; s++) {
        const g = slotCell[s];
        if (g < 0) continue;
        const r = slotRow[s];
        group[r] = g;
        const info = groups[g];
        info.count++;
        info.score = Math.max(info.score, probSlot[s]);
        kindCount[g][reason[r]]++;
        for (let a = 0; a < 3; a++) {
            const v = positions[s * 3 + a];
            info.center[a] += v;
            if (v < info.min[a]) info.min[a] = v;
            if (v > info.max[a]) info.max[a] = v;
        }
        const p = piece[s];
        if (!isStructure[p]) {
            gapOf[g] = Math.min(gapOf[g], pieceGap[p]);
            airborneOf[g] = Math.max(airborneOf[g], pieceAirborne[p]);
            for (let a = 0; a < 3; a++) awaySum[g][a] += pieceAway[p * 3 + a];
        } else {
            // fog: floats free by definition
            airborneOf[g] = 1;
        }
    }
    const kinds: FloaterKind[] = ['isolated', 'isolated', 'detached', 'fog'];
    groups.forEach((info, g) => {
        for (let a = 0; a < 3; a++) info.center[a] /= Math.max(1, info.count);
        const kc = kindCount[g];
        let best = 1;
        for (let k = 2; k <= 3; k++) if (kc[k] > kc[best]) best = k;
        info.kind = kinds[best];
        info.gap = gapOf[g];
        info.airborne = airborneOf[g] > 0;
        const w = awaySum[g];
        const wl = Math.hypot(w[0], w[1], w[2]);
        info.away = wl > 1e-9 ? [w[0] / wl, w[1] / wl, w[2] / wl] : [0, 0, 0];
    });

    // views onto each group with a free line of sight (for the Claude check
    // and the camera): of 24 directions around it, a little from above and
    // below, those whose line from the group outwards stays free of splats
    // longest; the second view at least 60 degrees from the first
    {
        const dirs: [number, number, number][] = [];
        for (const elevation of [0.35, 0.75, -0.2]) {
            for (let k = 0; k < 8; k++) {
                const azimuth = k * Math.PI / 4;
                const c = Math.cos(elevation);
                const d: [number, number, number] = [Math.cos(azimuth) * c, Math.sin(elevation), Math.sin(azimuth) * c];
                // elevation along the up axis
                dirs.push(upAxis === 1 ? [d[0], d[1] * upSign, d[2]] : upAxis === 2 ? [d[0], d[2], d[1] * upSign] : [d[1] * upSign, d[0], d[2]]);
            }
        }
        groups.forEach((info) => {
            const radius = Math.max(0.5 * Math.hypot(info.max[0] - info.min[0], info.max[1] - info.min[1], info.max[2] - info.min[2]), 0.005 * sceneSize);
            const want = Math.min(Math.max(3 * radius, 0.04 * sceneSize), 0.3 * sceneSize);
            let li = 0;
            while (li < grid.levels.length - 1 && grid.levels[li].size < Math.max(radius / 2, want / 24)) li++;
            const level = grid.levels[li];
            const [cx, cy, cz] = info.center;
            const free = dirs.map((d) => {
                for (let t = 1.1 * radius + level.size; t <= want; t += 0.5 * level.size) {
                    const c = level.table.find(
                        grid.coord(cx + d[0] * t, grid.ox) >> level.shift,
                        grid.coord(cy + d[1] * t, grid.oy) >> level.shift,
                        grid.coord(cz + d[2] * t, grid.oz) >> level.shift
                    );
                    if (c >= 0) return t;
                }
                return want;
            });
            const order = dirs.map((_, i) => i).sort((a, b) => free[b] - free[a] || a - b);
            const picked: number[] = [];
            for (const i of order) {
                if (picked.length === 2) break;
                const tooClose = picked.some(j => dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1] + dirs[i][2] * dirs[j][2] > 0.5);
                if (!tooClose) picked.push(i);
            }
            info.views = picked.map(i => ({ dir: dirs[i], distance: Math.max(1.2 * radius, Math.min(want, 0.85 * free[i])) }));
        });
    }
    onProgress(1);
    phase('groups');

    let debug: Record<string, ArrayLike<number>> | undefined;
    if (options.debug) {
        // per row copies of the internals
        const toRows = (values: ArrayLike<number>, fill: number) => {
            const out = new Float32Array(n).fill(fill);
            for (let s = 0; s < m; s++) out[slotRow[s]] = values[s];
            return out;
        };
        const pieceRow = new Float32Array(m);
        const structureRow = new Float32Array(m);
        const isolationRow = new Float32Array(m);
        const sizeRow = new Float32Array(m);
        const countRow = new Float32Array(m);
        const airRow = new Float32Array(m);
        const surfaceRow = new Float32Array(m);
        const gapRow = new Float32Array(m);
        for (let s = 0; s < m; s++) {
            const p = piece[s];
            pieceRow[s] = p;
            structureRow[s] = isStructure[p];
            isolationRow[s] = pieceIsolation[p];
            sizeRow[s] = pieceSizeTerm[p];
            countRow[s] = pCount[p];
            airRow[s] = pieceAirborne[p];
            surfaceRow[s] = pieceOnSurface[p];
            gapRow[s] = pieceGap[p];
        }
        debug = {
            piece: toRows(pieceRow, -1),
            structure: toRows(structureRow, 0),
            isolation: toRows(isolationRow, -1),
            sizeTerm: toRows(sizeRow, -1),
            pieceCount: toRows(countRow, 0),
            airborne: toRows(airRow, 0),
            onSurface: toRows(surfaceRow, 0),
            gap: toRows(gapRow, 0),
            fog: toRows(fogScore, 0),
            spacing: toRows(spacing, 0),
            footprint: toRows(footprint, 0)
        };
    }

    return {
        probability,
        reason,
        group,
        groups,
        stats: stats({ cell: h0, sceneSize, pieces, structurePieces, structureSplats, candidates, groups: groups.length }),
        debug
    };
};

export { detectFloaters, REASON, FloaterData, FloaterOptions, FloaterResult, FloaterGroup, FloaterKind, FloaterStats };
