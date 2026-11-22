import { Mat4, Vec3 } from 'playcanvas';

import type { Splat } from '../splat';

// Read a layer's gaussians in world space for the analysis cores (ICP,
// quality score, auto alignment): centres, linear scales (times the layer
// scale), linear opacity and base colour. Only live instances are read (deleted ones are not in the list);
// locked (hidden) ones are skipped. Indices map results back to instances.

type LayerData = {
    positions: Float32Array,
    scales: Float32Array,
    opacities: Float32Array,
    // base colour rgb per row (0..1)
    colors: Float32Array,
    // instance index of every row
    instances: Uint32Array
};

type ReadOptions = {
    // keep only gaussians at least this opaque (0 = all)
    minOpacity?: number,
    // keep every n-th gaussian (1 = all)
    stride?: number
};

// IEEE half -> float
const halfToFloat = (h: number) => {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
};

const readTexture = async (splat: Splat, name: string) => {
    const tex = splat.resource.getTexture(name);
    return await tex.read(0, 0, tex.width, tex.height, { immediate: true });
};

const readLayerData = async (splat: Splat, options: ReadOptions = {}): Promise<LayerData> => {
    const minOpacity = options.minOpacity ?? 0;
    const stride = Math.max(1, Math.floor(options.stride ?? 1));

    const a = await readTexture(splat, 'transformA') as Uint32Array;
    const b = await readTexture(splat, 'transformB') as Uint16Array;
    const c = await readTexture(splat, 'splatColor') as Uint16Array;
    const centers = new Float32Array(a.buffer, a.byteOffset, a.length);

    const { instances } = splat;
    const count = instances.count;

    // per-palette world matrices (layer transform x per-instance transform)
    const world = splat.entity.getWorldTransform();
    const paletteMats = new Map<number, Mat4>();
    const paletteScale = new Map<number, number>();
    const tmp = new Mat4();
    const matFor = (index: number) => {
        let m = paletteMats.get(index);
        if (!m) {
            splat.transformPalette.getTransform(index, tmp);
            m = new Mat4().mul2(world, tmp);
            paletteMats.set(index, m);
            // uniform scale estimate from the matrix axes
            const sx = m.getX(new Vec3()).length();
            const sy = m.getY(new Vec3()).length();
            const sz = m.getZ(new Vec3()).length();
            paletteScale.set(index, (sx + sy + sz) / 3);
        }
        return m;
    };

    const positions = new Float32Array(Math.ceil(count / stride) * 3);
    const scales = new Float32Array(Math.ceil(count / stride) * 3);
    const opacities = new Float32Array(Math.ceil(count / stride));
    const colors = new Float32Array(Math.ceil(count / stride) * 3);
    const index = new Uint32Array(Math.ceil(count / stride));
    const p = new Vec3();
    let n = 0;

    for (let i = 0; i < count; i += stride) {
        // locked = hidden
        if (instances.flags[i] & 2) continue;
        const row = instances.sourceRow[i];
        const opacity = halfToFloat(c[row * 4 + 3]);
        if (opacity < minOpacity) continue;
        const pal = instances.palette[i] & 0xffff;
        const m = matFor(pal);
        const s = paletteScale.get(pal);
        p.set(centers[row * 4], centers[row * 4 + 1], centers[row * 4 + 2]);
        m.transformPoint(p, p);
        positions[n * 3] = p.x;
        positions[n * 3 + 1] = p.y;
        positions[n * 3 + 2] = p.z;
        scales[n * 3] = halfToFloat(b[row * 4]) * s;
        scales[n * 3 + 1] = halfToFloat(b[row * 4 + 1]) * s;
        scales[n * 3 + 2] = halfToFloat(b[row * 4 + 2]) * s;
        opacities[n] = opacity;
        colors[n * 3] = halfToFloat(c[row * 4]);
        colors[n * 3 + 1] = halfToFloat(c[row * 4 + 1]);
        colors[n * 3 + 2] = halfToFloat(c[row * 4 + 2]);
        index[n] = i;
        n++;
    }

    return {
        positions: positions.slice(0, n * 3),
        scales: scales.slice(0, n * 3),
        opacities: opacities.slice(0, n),
        colors: colors.slice(0, n * 3),
        instances: index.slice(0, n)
    };
};

// Compact rows for the scan composition's analysis (src/compose): every
// unlocked instance whatever its opacity, at full resolution, in world space,
// with its footprint and with opacity and luminance quantised to bytes.
// Locked (hidden) instances are skipped, so areas whose suggestion was
// accepted read as winner-only.
type CompactData = {
    // world centres, xyz per row
    positions: Float32Array,
    // footprint sigma = sqrt(largest * middle linear scale) times the palette
    // scale, in world units: the size definition of quality-score.ts sizeOf
    footprint: Float32Array,
    // round(alpha * 255) of the linear opacity; opaque (alpha >= 0.2) is >= 51
    opacity: Uint8Array,
    // ln-luminance code round((ln(0.02 + Y) + 4) * 50) clamped to 0..255, with
    // Y = max(0, Rec.709 luma of the base colour); ln(0.02 + Y) = code / 50 - 4
    lum: Uint8Array,
    // instance index of every row, ascending
    instances: Uint32Array
};

type CompactOptions = {
    // share of the instances read so far (0..1), at every yield and at the end
    onProgress?: (fraction: number) => void
};

// rows read between two yields to the event loop, so a progress bar paints
const COMPACT_YIELD_ROWS = 262144;

// every half decoded once: the compact reader decodes seven per row
let halfTable: Float32Array | null = null;
const halfFloats = () => {
    if (!halfTable) {
        halfTable = new Float32Array(65536);
        for (let h = 0; h < 65536; h++) halfTable[h] = halfToFloat(h);
    }
    return halfTable;
};

// a macrotask, not requestAnimationFrame: rAF never fires in a hidden tab
const nextTask = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

const readLayerCompact = async (splat: Splat, options: CompactOptions = {}): Promise<CompactData> => {
    const { onProgress } = options;
    const a = await readTexture(splat, 'transformA') as Uint32Array;
    const b = await readTexture(splat, 'transformB') as Uint16Array;
    const c = await readTexture(splat, 'splatColor') as Uint16Array;
    const centers = new Float32Array(a.buffer, a.byteOffset, a.length);
    const half = halfFloats();
    const { instances } = splat;

    // the read yields, and the instance list is edited in place: the lock
    // bits are taken once per pass, and should the list's length change at a
    // yield (a delete or an undo meanwhile) the pass starts over
    for (;;) {
        const count = instances.count;
        const { sourceRow, palette } = instances;
        const flags = instances.flags.slice(0, count);
        let n = 0;
        for (let i = 0; i < count; i++) {
            if (!(flags[i] & 2)) n++;
        }

        // per-palette world matrices (layer transform x per-instance
        // transform) and their uniform scale estimates, as readLayerData
        const world = splat.entity.getWorldTransform().clone();
        const paletteMats = new Map<number, Float32Array>();
        const paletteScale = new Map<number, number>();
        const tmp = new Mat4();
        const axis = new Vec3();
        const matFor = (index: number) => {
            let data = paletteMats.get(index);
            if (!data) {
                splat.transformPalette.getTransform(index, tmp);
                const m = new Mat4().mul2(world, tmp);
                data = m.data;
                paletteMats.set(index, data);
                const sx = m.getX(axis).length();
                const sy = m.getY(axis).length();
                const sz = m.getZ(axis).length();
                paletteScale.set(index, (sx + sy + sz) / 3);
            }
            return data;
        };

        const positions = new Float32Array(n * 3);
        const footprint = new Float32Array(n);
        const opacity = new Uint8Array(n);
        const lum = new Uint8Array(n);
        const index = new Uint32Array(n);
        let lastPal = -1;
        let m: Float32Array = null;
        let s = 1;
        let k = 0;
        let changed = false;

        for (let i = 0; i < count; i++) {
            if (i > 0 && i % COMPACT_YIELD_ROWS === 0) {
                onProgress?.(i / count);
                await nextTask();
                if (instances.count !== count) {
                    changed = true;
                    break;
                }
            }
            // locked = hidden
            if (flags[i] & 2) continue;
            const row = sourceRow[i];
            const pal = palette[i] & 0xffff;
            if (pal !== lastPal) {
                m = matFor(pal);
                s = paletteScale.get(pal);
                lastPal = pal;
            }
            const r4 = row * 4;
            // m.transformPoint, unrolled
            const x = centers[r4], y = centers[r4 + 1], z = centers[r4 + 2];
            positions[k * 3] = x * m[0] + y * m[4] + z * m[8] + m[12];
            positions[k * 3 + 1] = x * m[1] + y * m[5] + z * m[9] + m[13];
            positions[k * 3 + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
            // footprint: geometric mean of the two largest axes (sizeOf)
            const sa = Math.abs(half[b[r4]]), sb = Math.abs(half[b[r4 + 1]]), sc = Math.abs(half[b[r4 + 2]]);
            const hi = Math.max(sa, sb, sc);
            const mid = sa + sb + sc - hi - Math.min(sa, sb, sc);
            footprint[k] = Math.sqrt(hi * mid) * s;
            // byte stores wrap instead of clamping, so clamp first (NaN -> 0)
            const alpha = half[c[r4 + 3]];
            opacity[k] = alpha >= 1 ? 255 : alpha > 0 ? Math.round(alpha * 255) : 0;
            const luma = Math.max(0, 0.2126 * half[c[r4]] + 0.7152 * half[c[r4 + 1]] + 0.0722 * half[c[r4 + 2]]);
            const code = Math.round((Math.log(0.02 + luma) + 4) * 50);
            lum[k] = code >= 255 ? 255 : code > 0 ? code : 0;
            index[k] = i;
            k++;
        }

        if (changed) continue;
        onProgress?.(1);
        return { positions, footprint, opacity, lum, instances: index };
    }
};

export { readLayerData, LayerData, readLayerCompact, CompactData };
