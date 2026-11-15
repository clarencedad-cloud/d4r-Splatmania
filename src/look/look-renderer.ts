import {
    ADDRESS_CLAMP_TO_EDGE,
    ADDRESS_REPEAT,
    FILTER_LINEAR,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA16F,
    PIXELFORMAT_RGBA32F,
    PIXELFORMAT_RGBA8,
    SEMANTIC_POSITION,
    BlendState,
    drawQuadWithShader,
    GraphicsDevice,
    RenderTarget,
    Shader,
    ShaderUtils,
    Texture
} from 'playcanvas';

import { compositeShader, copyShader, downShader, prefilterShader, upShader, vertexShader } from './look-shaders';

// what the look does to an image (src/look/look.ts holds and stores it)
type LookParams = {
    enabled: boolean,
    // glow
    bloom: number,
    bloomThreshold: number,
    bloomRadius: number,
    bloomTint: [number, number, number],
    // grading
    exposure: number,
    contrast: number,
    saturation: number,
    temperature: number,
    // lens
    vignette: number,
    vignetteSoftness: number,
    grain: number,
    aberration: number,
    // 3d lut (.cube), null = none
    lut: { name: string, size: number, data: Float32Array } | null,
    lutStrength: number,
    // distance fog, applied per splat in the projector (not in the post
    // passes): 'fade' melts far splats into the background, 'color' tints
    // them toward fogColor
    fog: number,
    fogStart: number,
    fogEnd: number,
    fogMode: 'fade' | 'color',
    fogColor: [number, number, number]
};

const defaultLook = (): LookParams => ({
    enabled: true,
    bloom: 0,
    bloomThreshold: 0.75,
    bloomRadius: 0.6,
    bloomTint: [1, 1, 1],
    exposure: 0,
    contrast: 1,
    saturation: 1,
    temperature: 0,
    vignette: 0,
    vignetteSoftness: 0.5,
    grain: 0,
    aberration: 0,
    lut: null,
    lutStrength: 1,
    fog: 0,
    fogStart: 5,
    fogEnd: 30,
    fogMode: 'fade',
    fogColor: [0.6, 0.65, 0.7]
});

// does the look change the image at all? (skips the passes when not)
const lookActive = (p: LookParams) => p.enabled && (
    p.bloom > 0 || p.exposure !== 0 || p.contrast !== 1 || p.saturation !== 1 || p.temperature !== 0 ||
    p.vignette > 0 || p.grain > 0 || p.aberration > 0 || (!!p.lut && p.lutStrength > 0)
);

type ApplyOptions = {
    // equirect panorama: the left and right edges meet, there is no lens
    // (no vignette or aberration)
    panorama: boolean,
    // composite over this opaque background first (null keeps alpha)
    background: { r: number, g: number, b: number } | null,
    // grain seed (the timeline frame, so a video's grain moves)
    seed: number,
    // image height the effect sizes were tuned for: glow, aberration and
    // grain scale with the output so a 4K export looks like the viewport
    referenceHeight?: number
};

const MAX_LEVELS = 7;

const createShader = (device: GraphicsDevice, name: string, fragmentWGSL: string) => ShaderUtils.createShader(device, {
    uniqueName: name,
    attributes: { vertex_position: SEMANTIC_POSITION },
    vertexWGSL: vertexShader,
    fragmentWGSL
});

/**
 * Applies a look to an image on the gpu: glow (bloom), grading, lens effects
 * and a LUT. The camera runs it on every frame between the splats and the
 * gizmos (src/camera.ts); panorama exports run it once on the finished
 * equirect image instead of per cube face, so the glow has no seams.
 */
class LookRenderer {
    private readonly device: GraphicsDevice;
    private readonly prefilter: Shader;
    private readonly down: Shader;
    private readonly up: Shader;
    private readonly composite: Shader;
    private readonly copy: Shader;
    private downTargets: RenderTarget[] = [];
    private upTargets: RenderTarget[] = [];
    private chainKey = '';
    private output: RenderTarget | null = null;
    private outputKey = '';
    private lutTexture: Texture;
    private lutData: Float32Array | null = null;
    // 1x1 black stand-in when the glow is off
    private readonly black: Texture;

    constructor(device: GraphicsDevice) {
        this.device = device;
        this.prefilter = createShader(device, 'lookPrefilter', prefilterShader);
        this.down = createShader(device, 'lookDown', downShader);
        this.up = createShader(device, 'lookUp', upShader);
        this.composite = createShader(device, 'lookComposite', compositeShader);
        this.copy = createShader(device, 'lookCopy', copyShader);
        this.black = new Texture(device, {
            name: 'lookBlack',
            width: 1,
            height: 1,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            levels: [new Uint8Array([0, 0, 0, 255])]
        });
        this.lutTexture = this.createLutTexture(2, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]));
    }

    private createLutTexture(size: number, rgb: Float32Array) {
        const data = new Float32Array(size * size * size * 4);
        for (let i = 0; i < size * size * size; i++) {
            // .cube order: red fastest, then green, then blue; the texture
            // holds blue slices side by side (x = r + b * size, y = g)
            const r = i % size;
            const g = Math.floor(i / size) % size;
            const b = Math.floor(i / (size * size));
            const o = (g * size * size + b * size + r) * 4;
            data[o] = rgb[i * 3];
            data[o + 1] = rgb[i * 3 + 1];
            data[o + 2] = rgb[i * 3 + 2];
            data[o + 3] = 1;
        }
        return new Texture(this.device, {
            name: 'lookLut',
            width: size * size,
            height: size,
            format: PIXELFORMAT_RGBA32F,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            levels: [data]
        });
    }

    private syncLut(params: LookParams) {
        const data = params.lut?.data ?? null;
        if (!data || data === this.lutData) return;
        this.lutTexture.destroy();
        this.lutTexture = this.createLutTexture(params.lut.size, data);
        this.lutData = data;
    }

    private createTarget(name: string, width: number, height: number, format: number, wrap: boolean) {
        return new RenderTarget({
            colorBuffer: new Texture(this.device, {
                name,
                width,
                height,
                format,
                mipmaps: false,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                addressU: wrap ? ADDRESS_REPEAT : ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            }),
            depth: false,
            autoResolve: false
        });
    }

    private static destroyTarget(target: RenderTarget) {
        target.colorBuffer.destroy();
        target.destroy();
    }

    private syncChain(width: number, height: number, wrap: boolean) {
        const key = `${width}x${height}${wrap ? 'w' : ''}`;
        if (key === this.chainKey) return;
        this.chainKey = key;
        [...this.downTargets, ...this.upTargets].forEach(LookRenderer.destroyTarget);
        this.downTargets = [];
        this.upTargets = [];
        let w = width;
        let h = height;
        for (let i = 0; i < MAX_LEVELS; i++) {
            w = Math.max(1, Math.ceil(w / 2));
            h = Math.max(1, Math.ceil(h / 2));
            this.downTargets.push(this.createTarget(`lookDown${i}`, w, h, PIXELFORMAT_RGBA16F, wrap));
            this.upTargets.push(this.createTarget(`lookUp${i}`, w, h, PIXELFORMAT_RGBA16F, wrap));
            if (w === 1 && h === 1) break;
        }
    }

    private syncOutput(width: number, height: number, format: number) {
        const key = `${width}x${height}:${format}`;
        if (key === this.outputKey) return this.output;
        this.outputKey = key;
        if (this.output) LookRenderer.destroyTarget(this.output);
        this.output = this.createTarget('lookOutput', width, height, format, false);
        return this.output;
    }

    // run the glow chain on source; returns the glow texture (half res)
    private bloom(source: Texture, params: LookParams, wrap: boolean, scale: number) {
        const { device } = this;
        const scope = device.scope;
        this.syncChain(source.width, source.height, wrap);

        // radius picks how many levels take part (each one twice as wide);
        // larger outputs need more levels for the same look
        const levels = Math.max(1, Math.min(this.downTargets.length, Math.round(2 + params.bloomRadius * 4 + Math.log2(Math.max(1, scale)))));

        device.setBlendState(BlendState.NOBLEND);
        scope.resolve('lookSrc').setValue(source);
        scope.resolve('lookWrap').setValue(wrap ? 1 : 0);
        scope.resolve('lookThreshold').setValue([params.bloomThreshold, Math.max(0.05, params.bloomThreshold * 0.5)]);
        drawQuadWithShader(device, this.downTargets[0], this.prefilter);

        for (let i = 1; i < levels; i++) {
            const src = this.downTargets[i - 1].colorBuffer;
            const dst = this.downTargets[i];
            scope.resolve('lookTex').setValue(src);
            scope.resolve('lookTexel').setValue([0.5 / src.width, 0.5 / src.height, 1 / dst.width, 1 / dst.height]);
            drawQuadWithShader(device, dst, this.down);
        }

        // up: start from the coarsest level, add each finer one
        let coarse = this.downTargets[levels - 1].colorBuffer;
        for (let i = levels - 2; i >= 0; i--) {
            const dst = this.upTargets[i];
            scope.resolve('lookTex').setValue(coarse);
            scope.resolve('lookCur').setValue(this.downTargets[i].colorBuffer);
            scope.resolve('lookTexel').setValue([1 / coarse.width, 1 / coarse.height, 1 / dst.width, 1 / dst.height]);
            scope.resolve('lookSpread').setValue(1);
            drawQuadWithShader(device, dst, this.up);
            coarse = dst.colorBuffer;
        }
        return { texture: coarse, levels };
    }

    /**
     * Apply the look to target's colour buffer in place (through a scratch
     * target of the same size and format).
     */
    apply(target: RenderTarget, params: LookParams, options: ApplyOptions) {
        if (!lookActive(params)) return;
        const { device } = this;
        const scope = device.scope;
        const source = target.colorBuffer;
        const { width, height } = source;
        const wrap = options.panorama;
        const scale = options.referenceHeight ? height / options.referenceHeight : 1;

        this.syncLut(params);

        let bloomTexture: Texture = this.black;
        let bloomScale = 0;
        if (params.bloom > 0) {
            const result = this.bloom(source, params, wrap, scale);
            bloomTexture = result.texture;
            // the up chain sums the levels; normalise so the strength reads
            // the same whatever the radius
            bloomScale = params.bloom / result.levels * 0.45;
        }

        const output = this.syncOutput(width, height, source.format);
        const bg = options.background;
        const lens = !options.panorama;

        device.setBlendState(BlendState.NOBLEND);
        scope.resolve('lookSrc').setValue(source);
        scope.resolve('lookWrap').setValue(wrap ? 1 : 0);
        scope.resolve('lookBloom').setValue(bloomTexture);
        scope.resolve('lookLut').setValue(this.lutTexture);
        scope.resolve('lookSize').setValue([width, height, 1 / width, 1 / height]);
        scope.resolve('lookBg').setValue(bg ? [bg.r, bg.g, bg.b, 1] : [0, 0, 0, 0]);
        scope.resolve('lookBloomTint').setValue([
            params.bloomTint[0] * bloomScale,
            params.bloomTint[1] * bloomScale,
            params.bloomTint[2] * bloomScale,
            bloomScale > 0 ? 1 : 0
        ]);
        scope.resolve('lookGrade').setValue([Math.pow(2, params.exposure), params.contrast, params.saturation, params.temperature]);
        scope.resolve('lookFx').setValue([
            lens ? params.vignette : 0,
            params.vignetteSoftness,
            params.grain,
            lens ? params.aberration * 8 * scale : 0
        ]);
        scope.resolve('lookLutParams').setValue([
            params.lut?.size ?? 2,
            params.lutStrength,
            params.lut && params.lutStrength > 0 ? 1 : 0,
            options.seed % 997
        ]);
        drawQuadWithShader(device, output, this.composite);

        scope.resolve('lookCopySrc').setValue(output.colorBuffer);
        drawQuadWithShader(device, target, this.copy);
    }

    destroy() {
        [...this.downTargets, ...this.upTargets].forEach(LookRenderer.destroyTarget);
        if (this.output) LookRenderer.destroyTarget(this.output);
        this.lutTexture.destroy();
        this.black.destroy();
        [this.prefilter, this.down, this.up, this.composite, this.copy].forEach(s => s.destroy());
    }
}

export { LookRenderer, LookParams, ApplyOptions, defaultLook, lookActive };
