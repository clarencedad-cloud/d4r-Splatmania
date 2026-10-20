// Quality score per splat and a sharpness comparison between overlapping scans.
//
// Blurry regions of a gaussian splat show up as large, nearly invisible,
// needle-like or sparse splats. Real scans (Postshot, Brush, ...) are mostly
// flat disks on the surface, so size is the footprint (two largest axes),
// "needle" compares the two in-plane axes, and the terms are calibrated on a
// real 2M splat scan rather than on round synthetic splats. scoreSplats() turns those indicators into a
// score per splat (1 = good, 0 = bad) that the quality tool shows as a heat
// map and thresholds into a selection.
//
// compareLayers() answers "which scan is sharp where": it bins all visible
// layers into one voxel grid and, per voxel covered by several layers, marks
// the splats of every layer that is clearly worse than the best layer there.
// A voxel is only marked when the better layer has enough splats of its own,
// so deleting the marked splats does not leave holes.
//
// Pure math on typed arrays in world space (scale already multiplied by the
// layer scale, opacity linear 0..1), no playcanvas dependency, so it runs in
// a web worker and in node tests.

type SplatData = {
    // xyz triples, world space
    positions: Float32Array,
    // linear scale triples (not log), world space
    scales: Float32Array,
    // linear opacity 0..1
    opacities: Float32Array
};

type QualityWeights = {
    // splats larger than the reference size
    size: number,
    // low opacity
    opacity: number,
    // needle-like splats (largest / second largest axis; flat disks are normal)
    anisotropy: number,
    // sparse neighbourhood
    density: number
};

type ScoreOptions = {
    weights?: Partial<QualityWeights>,
    // footprint size up to which a splat counts as sharp; default: 75th
    // percentile of the data (pass a shared value when scores of several
    // layers must be comparable)
    referenceSize?: number,
    // neighbourhood voxel for the density term; default: 4 x median footprint
    densityVoxel?: number,
    // reference splat count per density voxel; default: median of the data
    referenceDensity?: number
};

type CompareOptions = ScoreOptions & {
    // comparison voxel size; default: adapted to the splat density so an
    // occupied voxel holds about `voxelSplats` splats of a layer
    voxel?: number,
    // target splats per occupied voxel for the automatic voxel size (default 40)
    voxelSplats?: number,
    // a layer is marked when its mean score is this much below the best layer
    margin?: number,
    // the best layer needs at least this many splats around a voxel (3x3x3) to replace another
    minSplats?: number
};

type CompareResult = {
    // per layer: 1 = splat lies where another scan is clearly sharper
    marked: Uint8Array[],
    // per layer: number of marked splats
    markedCount: number[],
    // per layer scores (computed with a shared reference size)
    scores: Float32Array[],
    voxel: number,
    // number of voxels covered by more than one layer
    overlapVoxels: number
};

const DEFAULT_WEIGHTS: QualityWeights = { size: 1, opacity: 1, anisotropy: 0.5, density: 0.25 };

const cellKey = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;

// quantile of a (sub-sampled) array
const quantile = (values: ArrayLike<number>, q: number) => {
    const n = values.length;
    const step = Math.max(1, Math.floor(n / 100000));
    const s: number[] = [];
    for (let i = 0; i < n; i += step) s.push(values[i]);
    s.sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

const median = (values: ArrayLike<number>) => quantile(values, 0.5);

// footprint size (geometric mean of the two largest axes) and in-plane
// elongation (largest / second largest axis) per splat
const sizeOf = (scales: Float32Array) => {
    const n = scales.length / 3;
    const size = new Float32Array(n);
    const aniso = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const a = Math.abs(scales[i * 3]), b = Math.abs(scales[i * 3 + 1]), c = Math.abs(scales[i * 3 + 2]);
        const hi = Math.max(a, b, c);
        const mid = a + b + c - hi - Math.min(a, b, c);
        size[i] = Math.sqrt(hi * mid);
        aniso[i] = hi / Math.max(mid, 1e-12);
    }
    return { size, aniso };
};

// splat count of each splat's density voxel
const densityOf = (positions: Float32Array, voxel: number) => {
    const n = positions.length / 3;
    const keys: string[] = new Array(n);
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        const key = cellKey(Math.floor(positions[i * 3] / voxel), Math.floor(positions[i * 3 + 1] / voxel), Math.floor(positions[i * 3 + 2] / voxel));
        keys[i] = key;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const density = new Float32Array(n);
    for (let i = 0; i < n; i++) density[i] = counts.get(keys[i]) ?? 1;
    return density;
};

/**
 * Score every splat: 1 = sharp and solid, towards 0 = blurry, soft, stretched
 * or isolated. score = exp(-(weighted sum of badness terms)), each term 0 for
 * a typical good splat.
 */
const scoreSplats = (data: SplatData, options: ScoreOptions = {}) => {
    const w = { ...DEFAULT_WEIGHTS, ...options.weights };
    const n = data.positions.length / 3;
    const { size, aniso } = sizeOf(data.scales);
    const refSize = options.referenceSize ?? quantile(size, 0.75);
    const voxel = options.densityVoxel ?? median(size) * 4;
    const density = w.density > 0 ? densityOf(data.positions, voxel) : null;
    const refDensity = density ? (options.referenceDensity ?? median(density)) : 1;

    const score = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        // twice the reference size costs one unit
        const bSize = Math.max(0, Math.log2(size[i] / refSize));
        // semi-transparent splats are normal in real scans; only nearly
        // invisible ones cost, up to one unit at 0
        const bOpacity = Math.max(0, (0.15 - data.opacities[i]) / 0.15);
        // in-plane ratios up to 8:1 are normal; beyond, one unit per factor 4
        const bAniso = Math.max(0, Math.log2(aniso[i] / 8) / 2);
        // a quarter of the reference density costs one unit
        const bDensity = density ? Math.max(0, Math.log2(refDensity / Math.max(density[i], 1)) / 2) : 0;
        score[i] = Math.exp(-(w.size * bSize + w.opacity * bOpacity + w.anisotropy * bAniso + w.density * bDensity));
    }
    return score;
};

// indices of splats with score below threshold (for the selection)
const belowThreshold = (scores: Float32Array, threshold: number) => {
    const mask = new Uint8Array(scores.length);
    for (let i = 0; i < scores.length; i++) mask[i] = scores[i] < threshold ? 1 : 0;
    return mask;
};

/**
 * Compare overlapping scans: mark, per layer, the splats lying in voxels where
 * another layer is clearly sharper and dense enough to take over.
 */
const compareLayers = (layers: SplatData[], options: CompareOptions = {}): CompareResult => {
    if (layers.length < 2) throw new Error('compareLayers: at least two layers are needed');
    const margin = options.margin ?? 0.15;
    const minSplats = options.minSplats ?? 8;

    // shared references so scores are comparable across layers
    const pooledSizes: number[] = [];
    for (const layer of layers) {
        const { size } = sizeOf(layer.scales);
        const step = Math.max(1, Math.floor(size.length / 50000));
        for (let i = 0; i < size.length; i += step) pooledSizes.push(size[i]);
    }
    const referenceSize = options.referenceSize ?? quantile(pooledSizes, 0.75);
    const scores = layers.map(layer => scoreSplats(layer, { ...options, referenceSize }));

    // comparison voxel: adapted to the splat density, so an occupied voxel
    // holds about `voxelSplats` splats of a layer. A fixed fraction of the
    // scene size is far too coarse for large scans with dense detail.
    let voxel = options.voxel;
    if (!voxel) {
        const target = options.voxelSplats ?? 40;
        const densest = layers.reduce((a, b) => (b.positions.length > a.positions.length ? b : a));
        // splat count of the voxel a typical splat lies in (median over
        // splats, not over voxels: real scans have many near-empty voxels of
        // floaters and sparse background that would drag a voxel median down)
        const occupancy = (v: number) => {
            const counts = new Map<string, number>();
            const p = densest.positions;
            const step = Math.max(1, Math.floor(p.length / 3 / 300000)) * 3;
            const keys: string[] = [];
            for (let i = 0; i < p.length; i += step) {
                const key = cellKey(Math.floor(p[i] / v), Math.floor(p[i + 1] / v), Math.floor(p[i + 2] / v));
                keys.push(key);
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            return median(keys.map(k => (counts.get(k) ?? 0) * (step / 3)));
        };
        // splats lie on surfaces, so the count grows roughly with v^2
        voxel = median(pooledSizes) * 10;
        for (let iter = 0; iter < 3; iter++) {
            const count = Math.max(1, occupancy(voxel));
            if (Math.abs(count / target - 1) < 0.25) break;
            voxel *= Math.min(4, Math.max(0.25, Math.sqrt(target / count)));
        }
    }

    // per voxel and layer: sum of scores and count
    const cells = new Map<string, { ix: number, iy: number, iz: number, sum: number[], count: number[] }>();
    const keysPerLayer: string[][] = layers.map((layer) => {
        const p = layer.positions;
        const n = p.length / 3;
        return new Array(n);
    });
    layers.forEach((layer, l) => {
        const p = layer.positions;
        const keys = keysPerLayer[l];
        for (let i = 0; i < p.length / 3; i++) {
            const ix = Math.floor(p[i * 3] / voxel), iy = Math.floor(p[i * 3 + 1] / voxel), iz = Math.floor(p[i * 3 + 2] / voxel);
            const key = cellKey(ix, iy, iz);
            keys[i] = key;
            let c = cells.get(key);
            if (!c) {
                c = { ix, iy, iz, sum: new Array(layers.length).fill(0), count: new Array(layers.length).fill(0) };
                cells.set(key, c);
            }
            c.sum[l] += scores[l][i];
            c.count[l]++;
        }
    });

    // per voxel: which layers are clearly worse than the best layer. Scores
    // and counts are pooled over the 3x3x3 neighbourhood: splats spread a
    // little off the surface land in edge voxels where the sharp scan has
    // few splats, and the neighbourhood still shows it covers the area.
    const worse = new Map<string, boolean[]>();
    let overlapVoxels = 0;
    const nl = layers.length;
    cells.forEach((c, key) => {
        if (c.count.filter(v => v > 0).length < 2) return;
        overlapVoxels++;
        const sum = new Array(nl).fill(0);
        const count = new Array(nl).fill(0);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const nb = cells.get(cellKey(c.ix + dx, c.iy + dy, c.iz + dz));
                    if (!nb) continue;
                    for (let l = 0; l < nl; l++) {
                        sum[l] += nb.sum[l];
                        count[l] += nb.count[l];
                    }
                }
            }
        }
        const mean = sum.map((s, l) => (count[l] ? s / count[l] : -Infinity));
        let best = -1;
        for (let l = 0; l < nl; l++) {
            if (count[l] >= minSplats && (best < 0 || mean[l] > mean[best])) best = l;
        }
        if (best < 0) return;
        const flags = mean.map((m, l) => l !== best && c.count[l] > 0 && m < mean[best] - margin);
        if (flags.some(Boolean)) worse.set(key, flags);
    });

    const marked = layers.map((layer, l) => {
        const keys = keysPerLayer[l];
        const mask = new Uint8Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
            const flags = worse.get(keys[i]);
            if (flags && flags[l]) mask[i] = 1;
        }
        return mask;
    });

    return {
        marked,
        markedCount: marked.map(m => m.reduce((a, v) => a + v, 0)),
        scores,
        voxel,
        overlapVoxels
    };
};

export { scoreSplats, belowThreshold, compareLayers, DEFAULT_WEIGHTS, SplatData, QualityWeights, ScoreOptions, CompareOptions, CompareResult };
