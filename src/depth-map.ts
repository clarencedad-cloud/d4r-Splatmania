import { encodePngGray16 } from './png-writer';

// Greyscale depth map (16-bit PNG) from the camera depth (src/render.ts
// captureDepth, scene units, empty pixels 1e10). Unlike the EXR Z channel,
// which keeps real distances, a picture needs a range: near and far map to
// the two ends of the grey scale. 'auto' takes the range from the visible
// scan, ignoring the empty background and the outermost 1 % (floaters).

type DepthMapSettings = {
    range: 'auto' | 'manual';
    // manual range, scene units
    near: number;
    far: number;
    // near = white (ControlNet, MiDaS) or near = black (some compositors)
    nearWhite: boolean;
};

const EMPTY_LIMIT = 1e9;

// near / far of the valid pixels: 1st and 99th percentile
const autoRange = (depth: Float32Array) => {
    const valid: number[] = [];
    // a sample is enough for the percentiles of a large frame
    const step = Math.max(1, Math.floor(depth.length / 400000));
    for (let i = 0; i < depth.length; i += step) {
        const d = depth[i];
        if (d < EMPTY_LIMIT && d > 0) valid.push(d);
    }
    if (valid.length === 0) return { near: 0, far: 1 };
    valid.sort((a, b) => a - b);
    const at = (q: number) => valid[Math.min(valid.length - 1, Math.max(0, Math.floor(q * (valid.length - 1))))];
    const near = at(0.01);
    let far = at(0.99);
    if (far - near < 1e-6) far = near + 1e-3;
    return { near, far };
};

const resolveRange = (settings: DepthMapSettings, depth: Float32Array) => {
    if (settings.range === 'manual' && settings.far > settings.near) {
        return { near: Math.max(0, settings.near), far: settings.far };
    }
    return autoRange(depth);
};

// 16-bit grey values; the empty background counts as far
const depthToGray16 = (depth: Float32Array, near: number, far: number, nearWhite: boolean) => {
    const out = new Uint16Array(depth.length);
    const span = far - near;
    for (let i = 0; i < depth.length; i++) {
        const d = depth[i];
        const t = d >= EMPTY_LIMIT ? 1 : Math.min(1, Math.max(0, (d - near) / span));
        out[i] = Math.round((nearWhite ? 1 - t : t) * 65535);
    }
    return out;
};

// the whole step: range, grey values, png
const encodeDepthMap = (depth: Float32Array, width: number, height: number, settings: DepthMapSettings, range?: { near: number, far: number }) => {
    const { near, far } = range ?? resolveRange(settings, depth);
    return {
        range: { near, far },
        png: encodePngGray16(depthToGray16(depth, near, far, settings.nearWhite), width, height)
    };
};

export { encodeDepthMap, resolveRange, depthToGray16, type DepthMapSettings };
