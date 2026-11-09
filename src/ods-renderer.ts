import {
    ADDRESS_CLAMP_TO_EDGE,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    FILTER_LINEAR,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA8,
    SEMANTIC_POSITION,
    drawQuadWithShader,
    BlendState,
    GraphicsDevice,
    RenderTarget,
    Shader,
    ShaderUtils,
    Texture,
    Vec4
} from 'playcanvas';

import { EquirectRenderer } from './equirect-renderer';
import { clearShader, compositeShader, vertexShader } from './shaders/ods-shader';

// half vertical fov of a strip camera: the strips cover |elevation| up to
// this; the stereo-to-mono pole fade must end below it
const STRIP_HALF_VFOV = 72;
// latest elevation the stereo part may reach (keeps the fade inside the strip)
const MAX_POLE_END = 70;

type OdsOptions = {
    // eye separation in scene units
    ipd: number;
    // number of azimuth strips per eye
    segments: number;
    // elevation (deg) where the stereo starts fading into mono
    poleStart: number;
    // width of the fade (deg)
    poleFade?: number;
};

const additive = new BlendState(true, BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE, BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE);

/**
 * Omnidirectional stereo (ODS) panorama renderer: per eye, N narrow vertical
 * strips are rendered with a perspective camera that sits tangentially on the
 * circle of radius ipd/2 around the capture point (left eye to the left of
 * the viewing direction), and are accumulated into that eye's equirect with
 * overlapping tent weights. Near the poles, where ODS produces double images,
 * the result fades into the mono cube-map panorama (zero ipd).
 *
 * The caller renders the strips (the splat renderer is camera based); this
 * class owns the targets, the strip geometry and the compositing.
 */
class OdsRenderer {
    device: GraphicsDevice;
    eyeWidth: number;
    eyeHeight: number;
    options: OdsOptions;

    // mono panorama (6 faces) used towards the poles
    mono: EquirectRenderer;
    // the strip just rendered (copied from the camera's main target)
    stripTarget: RenderTarget;
    eyeTargets: RenderTarget[];

    stripWidth: number;
    stripHeight: number;
    // tan of the strip camera's half horizontal / vertical fov
    tanH: number;
    tanV: number;
    // azimuth step between strips (rad)
    step: number;

    compositeShader: Shader;
    clearShader: Shader;

    constructor(device: GraphicsDevice, eyeWidth: number, eyeHeight: number, options: OdsOptions) {
        this.device = device;
        this.eyeWidth = eyeWidth;
        this.eyeHeight = eyeHeight;
        this.options = options;

        const segments = Math.max(8, Math.round(options.segments));
        this.step = 2 * Math.PI / segments;

        // equirect sampling density at the horizon: pixels per radian
        const density = eyeHeight / Math.PI;
        this.tanV = Math.tan(STRIP_HALF_VFOV * Math.PI / 180);
        this.stripHeight = Math.min(device.maxTextureSize, Math.ceil(2 * this.tanV * density));
        // the tent spans +-step; a little extra keeps the bilinear footprint inside
        const wantTanH = Math.tan(this.step * 1.15);
        // the splat renderer smears near objects into thin needles on very
        // narrow, tall targets (seen at ~20:1, clean at 3.3:1), so strips are
        // rendered at least height / 3.4 wide and only their middle is used
        this.stripWidth = Math.max(Math.ceil(this.stripHeight / 3.4), Math.ceil(2 * wantTanH * density * (this.stripHeight / (2 * this.tanV * density))));
        // the exact horizontal extent follows from the aspect the camera uses
        this.tanH = this.tanV * this.stripWidth / this.stripHeight;

        const createTexture = (name: string, width: number, height: number, filter: number) => new Texture(device, {
            name,
            width,
            height,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: filter,
            magFilter: filter,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });

        this.mono = new EquirectRenderer(device, Math.min(eyeHeight, device.maxTextureSize), eyeWidth, eyeHeight);

        this.stripTarget = new RenderTarget({
            colorBuffer: createTexture('odsStrip', this.stripWidth, this.stripHeight, FILTER_LINEAR),
            depth: false,
            autoResolve: false
        });

        this.eyeTargets = [0, 1].map(eye => new RenderTarget({
            colorBuffer: createTexture(`odsEye${eye}`, eyeWidth, eyeHeight, FILTER_NEAREST),
            depth: false,
            autoResolve: false
        }));

        const shader = (name: string, fragment: string) => ShaderUtils.createShader(device, {
            uniqueName: name,
            attributes: { vertex_position: SEMANTIC_POSITION },
            vertexWGSL: vertexShader,
            fragmentWGSL: fragment
        });
        this.compositeShader = shader('odsCompositeShader', compositeShader);
        this.clearShader = shader('odsClearShader', clearShader);
    }

    get segments() {
        return Math.round(2 * Math.PI / this.step);
    }

    // strip camera vertical fov (deg); the strip target is taller than wide,
    // so the camera's fov is the vertical one
    get stripFov() {
        return 2 * STRIP_HALF_VFOV;
    }

    // azimuth (capture space, rad, positive towards +x) of strip k
    azimuth(k: number) {
        return k * this.step;
    }

    // signed eye offset along the strip camera's right axis: the left eye
    // sits left of the viewing direction, the right eye right of it
    eyeOffset(eye: number) {
        return (eye === 0 ? -0.5 : 0.5) * this.options.ipd;
    }

    // project the six mono faces (rendered by the caller into mono.faceTargets)
    projectMono() {
        this.mono.project();
    }

    clearEyes() {
        const { device } = this;
        device.setBlendState(BlendState.NOBLEND);
        this.eyeTargets.forEach(target => drawQuadWithShader(device, target, this.clearShader));
    }

    // accumulate the strip currently in stripTarget into the eye's equirect
    compositeStrip(eye: number, k: number) {
        const { device, eyeWidth, eyeHeight, step } = this;
        const target = this.eyeTargets[eye];

        // strip azimuth as equirect longitude in [-pi, pi)
        let lon = this.azimuth(k);
        if (lon >= Math.PI) lon -= 2 * Math.PI;

        const poleStart = Math.min(this.options.poleStart, MAX_POLE_END - 1);
        const poleEnd = Math.min(poleStart + (this.options.poleFade ?? 15), MAX_POLE_END);

        device.scope.resolve('uStripTex').setValue(this.stripTarget.colorBuffer);
        device.scope.resolve('uMonoTex').setValue(this.mono.equirectTarget.colorBuffer);
        device.scope.resolve('uTargetSize').setValue([eyeWidth, eyeHeight]);
        device.scope.resolve('uStrip').setValue([lon, step, this.tanH, this.tanV]);
        device.scope.resolve('uPole').setValue([poleStart * Math.PI / 180, poleEnd * Math.PI / 180, 0, 0]);

        device.setBlendState(additive);

        // the band [lon - step, lon + step] in pixels, split at the seam
        const toX = (l: number) => (l / (2 * Math.PI) + 0.5) * eyeWidth;
        const x0 = Math.floor(toX(lon - step)) - 1;
        const x1 = Math.ceil(toX(lon + step)) + 1;
        const draw = (a: number, b: number) => {
            const from = Math.max(0, a);
            const to = Math.min(eyeWidth, b);
            if (to <= from) return;
            const rect = new Vec4(from, 0, to - from, eyeHeight);
            drawQuadWithShader(device, target, this.compositeShader, rect, rect);
        };
        draw(x0, x1);
        if (x0 < 0) draw(x0 + eyeWidth, eyeWidth);
        if (x1 > eyeWidth) draw(0, x1 - eyeWidth);

        device.setBlendState(BlendState.NOBLEND);
    }

    // read one eye back (immediate, see EquirectRenderer.read)
    read(eye: number, data: Uint8Array) {
        const target = this.eyeTargets[eye];
        return target.colorBuffer.read(0, 0, target.width, target.height, {
            renderTarget: target,
            data,
            immediate: true
        });
    }

    destroy() {
        this.mono.destroy();
        [this.stripTarget, ...this.eyeTargets].forEach((target) => {
            target.colorBuffer.destroy();
            target.destroy();
        });
        this.eyeTargets = [];
    }
}

export { OdsRenderer, OdsOptions };
