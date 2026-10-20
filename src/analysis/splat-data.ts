import { Mat4, Vec3 } from 'playcanvas';

import type { Splat } from '../splat';

// Read a layer's gaussians in world space for the analysis cores (ICP,
// quality score): centres, linear scales (times the layer scale) and linear
// opacity. Only live instances are read (deleted ones are not in the list);
// locked (hidden) ones are skipped. Indices map results back to instances.

type LayerData = {
    positions: Float32Array,
    scales: Float32Array,
    opacities: Float32Array,
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
        index[n] = i;
        n++;
    }

    return {
        positions: positions.slice(0, n * 3),
        scales: scales.slice(0, n * 3),
        opacities: opacities.slice(0, n),
        instances: index.slice(0, n)
    };
};

export { readLayerData, LayerData };
