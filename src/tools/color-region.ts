import type { LayerData } from '../analysis/splat-data';

// "Farb-Floater": the pipette's colour hits narrowed to the clump that was
// clicked. Sky-coloured blobs caught in a building or a tree are the typical
// case: the plain pipette would select the real sky too. Here only the hits
// within `radius` of the clicked splat (0 = no limit) that hang together with
// it are kept: two hits belong together when their centres are closer than
// their sizes suggest, so the clump stops at a gap or at differently coloured
// splats (the facade, the branches).

type RegionOptions = {
    // world units around the clicked splat, 0 = no limit
    radius: number,
    // keep only the hits connected to the clicked one
    connected: boolean
};

// two hits link when their centres are closer than LINK_SIGMA times the sum of
// their sizes (the largest axis scale = one sigma): they touch, as a blob does
const LINK_SIGMA = 2;
// the largest link: LINK_CAP times the size of the larger hits (90th
// percentile), so a few giants do not tie the whole scene together
const LINK_CAP = 4;
const CAP_QUANTILE = 0.9;

const sizeOf = (scales: Float32Array, row: number) => Math.max(scales[row * 3], scales[row * 3 + 1], scales[row * 3 + 2]);

const quantile = (values: Float32Array, q: number) => {
    if (!values.length) return 0;
    const s = values.slice().sort();
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// returns the selected instances, ascending; null when the clicked splat is
// not among the rows (locked)
const colorRegion = (data: LayerData, hit: (instance: number) => boolean, seed: number, options: RegionOptions): Uint32Array | null => {
    const { positions, scales, instances } = data;
    const rows = instances.length;
    let seedRow = -1;
    for (let r = 0; r < rows; ++r) {
        if (instances[r] === seed) {
            seedRow = r;
            break;
        }
    }
    if (seedRow < 0) return null;
    const sx = positions[seedRow * 3], sy = positions[seedRow * 3 + 1], sz = positions[seedRow * 3 + 2];
    const r2 = options.radius > 0 ? options.radius * options.radius : Infinity;

    // candidates: colour hits inside the radius, and the clicked splat itself
    const cand: number[] = [];
    for (let r = 0; r < rows; ++r) {
        if (r !== seedRow && !hit(instances[r])) continue;
        const dx = positions[r * 3] - sx, dy = positions[r * 3 + 1] - sy, dz = positions[r * 3 + 2] - sz;
        if (dx * dx + dy * dy + dz * dz <= r2) cand.push(r);
    }

    if (!options.connected) {
        return Uint32Array.from(cand.map(r => instances[r])).sort();
    }

    const sizes = new Float32Array(cand.length);
    cand.forEach((r, i) => {
        sizes[i] = sizeOf(scales, r);
    });
    const cap = Math.max(quantile(sizes, CAP_QUANTILE), 1e-6) * LINK_CAP;

    // hash grid of the candidates, cell = the largest link distance
    const cell = cap;
    // numeric cell hash; a collision only merges two buckets (the distance
    // test still decides)
    const hash = (cx: number, cy: number, cz: number) => ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0);
    const key = (x: number, y: number, z: number) => hash(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
    const grid = new Map<number, number[]>();
    cand.forEach((r, i) => {
        const k = key(positions[r * 3], positions[r * 3 + 1], positions[r * 3 + 2]);
        let list = grid.get(k);
        if (!list) grid.set(k, list = []);
        list.push(i);
    });

    const seen = new Uint8Array(cand.length);
    const start = cand.indexOf(seedRow);
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
        const i = queue.pop();
        const r = cand[i];
        const px = positions[r * 3], py = positions[r * 3 + 1], pz = positions[r * 3 + 2];
        const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
        for (let ox = -1; ox <= 1; ++ox) {
            for (let oy = -1; oy <= 1; ++oy) {
                for (let oz = -1; oz <= 1; ++oz) {
                    const list = grid.get(hash(cx + ox, cy + oy, cz + oz));
                    if (!list) continue;
                    for (const j of list) {
                        if (seen[j]) continue;
                        const q = cand[j];
                        const dx = positions[q * 3] - px, dy = positions[q * 3 + 1] - py, dz = positions[q * 3 + 2] - pz;
                        const link = Math.min(cap, LINK_SIGMA * (sizes[i] + sizes[j]));
                        if (dx * dx + dy * dy + dz * dz <= link * link) {
                            seen[j] = 1;
                            queue.push(j);
                        }
                    }
                }
            }
        }
    }

    const out: number[] = [];
    for (let i = 0; i < cand.length; ++i) {
        if (seen[i]) out.push(instances[cand[i]]);
    }
    return Uint32Array.from(out).sort();
};

export { colorRegion, type RegionOptions };
