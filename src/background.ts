import { Color, Vec3 } from 'playcanvas';

import { Events } from './events';
import type { Scene } from './scene';

// Scene background: a plain colour (the existing bgClr) or a sky gradient
// that runs from the horizon upward (and, softly, into a ground colour
// below). The gradient follows the world horizon, not the screen: it is
// drawn per view direction, so tilting the camera moves it.
//
// - viewport: a css gradient behind the transparent canvas, recomputed from
//   the camera pitch and fov
// - exports: the frame is rendered with a transparent clear and the
//   gradient is composited per pixel (src/render.ts compositeBackground)

type Rgb = [number, number, number];

type BackgroundState = {
    mode: 'color' | 'gradient';
    // colour at the top of the sky, at the horizon, below the horizon
    zenith: Rgb;
    horizon: Rgb;
    ground: Rgb;
    // elevation (degrees) at which the sky reaches the zenith colour
    spread: number;
};

const defaultState = (): BackgroundState => ({
    mode: 'color',
    zenith: [0.18, 0.36, 0.66],
    horizon: [0.86, 0.89, 0.93],
    ground: [0.32, 0.31, 0.3],
    spread: 45
});

const DEG = Math.PI / 180;
// below the horizon the horizon colour fades into the ground over this angle
const GROUND_FADE = 12;

const smooth = (t: number) => {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
};

// colour (0..1) for a view direction at elevation e (degrees)
const colorAt = (s: BackgroundState, e: number, out: Rgb): Rgb => {
    if (e >= 0) {
        const t = smooth(e / Math.max(1, s.spread));
        for (let i = 0; i < 3; i++) out[i] = s.horizon[i] + (s.zenith[i] - s.horizon[i]) * t;
    } else {
        const t = smooth(-e / GROUND_FADE);
        for (let i = 0; i < 3; i++) out[i] = s.horizon[i] + (s.ground[i] - s.horizon[i]) * t;
    }
    return out;
};

// 8-bit lookup over elevation -90..90 in 0.1 degree steps
const buildLut = (s: BackgroundState) => {
    const lut = new Uint8Array(1801 * 3);
    const c: Rgb = [0, 0, 0];
    for (let i = 0; i <= 1800; i++) {
        colorAt(s, i / 10 - 90, c);
        lut[i * 3] = Math.round(Math.min(1, Math.max(0, c[0])) * 255);
        lut[i * 3 + 1] = Math.round(Math.min(1, Math.max(0, c[1])) * 255);
        lut[i * 3 + 2] = Math.round(Math.min(1, Math.max(0, c[2])) * 255);
    }
    return lut;
};

// premultiplied rgba pixels over an opaque background colour
const over = (data: Uint8Array, i: number, lut: Uint8Array, li: number) => {
    const a = data[i + 3];
    if (a === 255) return;
    const k = 255 - a;
    data[i] = Math.min(255, data[i] + ((lut[li] * k + 127) / 255 | 0));
    data[i + 1] = Math.min(255, data[i + 1] + ((lut[li + 1] * k + 127) / 255 | 0));
    data[i + 2] = Math.min(255, data[i + 2] + ((lut[li + 2] * k + 127) / 255 | 0));
    data[i + 3] = 255;
};

type PerspectiveView = {
    kind: 'perspective';
    forward: Vec3;
    right: Vec3;
    up: Vec3;
    // tangent of half the horizontal / vertical field of view
    tanX: number;
    tanY: number;
};

type PanoramaView = {
    kind: 'equirect' | 'stereo';
};

// composite the gradient under an rgba frame (rows top-down, premultiplied)
const compositeGradient = (s: BackgroundState, data: Uint8Array, width: number, height: number, view: PerspectiveView | PanoramaView) => {
    const lut = buildLut(s);
    const lutIndex = (e: number) => Math.round((Math.max(-90, Math.min(90, e)) + 90) * 10) * 3;

    if (view.kind !== 'perspective') {
        // equirect rows: elevation from +90 (top) to -90; stereo is two
        // equirect eyes stacked top-bottom
        const eyes = view.kind === 'stereo' ? 2 : 1;
        const eyeHeight = Math.floor(height / eyes);
        for (let y = 0; y < height; y++) {
            const ey = y % eyeHeight;
            const li = lutIndex(90 - (ey + 0.5) / eyeHeight * 180);
            for (let x = 0; x < width; x++) over(data, (y * width + x) * 4, lut, li);
        }
        return;
    }

    const { forward: f, right: r, up: u, tanX, tanY } = view;
    for (let y = 0; y < height; y++) {
        const ny = (1 - (y + 0.5) / height * 2) * tanY;
        for (let x = 0; x < width; x++) {
            const nx = ((x + 0.5) / width * 2 - 1) * tanX;
            const dx = f.x + r.x * nx + u.x * ny;
            const dy = f.y + r.y * nx + u.y * ny;
            const dz = f.z + r.z * nx + u.z * ny;
            const e = Math.asin(dy / Math.sqrt(dx * dx + dy * dy + dz * dz)) / DEG;
            over(data, (y * width + x) * 4, lut, lutIndex(e));
        }
    }
};

const css = (c: Rgb) => `rgb(${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;

const registerBackgroundEvents = (events: Events, scene: Scene) => {
    let state = defaultState();
    const container = document.getElementById('canvas-container');

    const changed = () => {
        events.fire('background.changed', state);
        updateViewport(true);
        scene.forceRender = true;
    };

    events.function('background.state', () => state);
    events.function('background.gradient', () => state.mode === 'gradient');
    events.on('background.set', (patch: Partial<BackgroundState>) => {
        state = { ...state, ...patch };
        changed();
    });

    // viewport: a css gradient behind the canvas. Screen row of a direction
    // at elevation e in the image centre column: 0.5 - tan(e - pitch) / tan(fovY / 2) / 2
    let lastKey = '';
    function updateViewport(force = false) {
        if (!container) return;
        if (state.mode !== 'gradient') {
            if (lastKey !== 'color') {
                container.style.backgroundImage = '';
                lastKey = 'color';
            }
            return;
        }
        const cam = scene.camera;
        const forward = cam.forward;
        const pitch = cam.ortho ? 0 : Math.asin(Math.max(-1, Math.min(1, forward.y))) / DEG;
        const cc = cam.camera;
        const aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
        const fov = cc.fov ?? 60;
        const tanY = cc.horizontalFov ? Math.tan(fov * DEG / 2) / aspect : Math.tan(fov * DEG / 2);
        const key = `${pitch.toFixed(2)}|${tanY.toFixed(4)}|${aspect.toFixed(3)}`;
        if (!force && key === lastKey) return;
        lastKey = key;

        const stops: [number, string][] = [];
        const c: Rgb = [0, 0, 0];
        const elevations = [-90, -30, -GROUND_FADE, -GROUND_FADE / 2, 0, 0.1, 0.25, 0.5, 0.75, 1, 1.5].map((v, i) => (i >= 5 ? v * state.spread : v));
        elevations.push(90);
        for (const e of elevations) {
            const rel = Math.max(-89, Math.min(89, e - pitch));
            const yFrac = 0.5 - 0.5 * Math.tan(rel * DEG) / tanY;
            stops.push([yFrac * 100, css(colorAt(state, e, c))]);
        }
        stops.sort((a, b) => a[0] - b[0]);
        container.style.backgroundImage = `linear-gradient(to bottom, ${stops.map(([y, col]) => `${col} ${y.toFixed(2)}%`).join(', ')})`;
    }
    events.on('prerender', () => updateViewport());
    events.on('camera.resize', () => updateViewport(true));

    // exports (src/render.ts): clear colour of an export frame and the
    // gradient composite afterwards
    events.function('background.exportClear', (): Color | null => (state.mode === 'gradient' ? new Color(0, 0, 0, 0) : null));
    events.function('background.compositeView', (data: Uint8Array, width: number, height: number) => {
        if (state.mode !== 'gradient') return;
        const entity = scene.camera.mainCamera;
        const cc = scene.camera.camera;
        const fov = cc.fov ?? 60;
        const aspect = width / height;
        const tanMain = Math.tan(fov * DEG / 2);
        const tanX = cc.horizontalFov ? tanMain : tanMain * aspect;
        const tanY = cc.horizontalFov ? tanMain / aspect : tanMain;
        compositeGradient(state, data, width, height, {
            kind: 'perspective',
            forward: entity.forward.clone(),
            right: entity.right.clone(),
            up: entity.up.clone(),
            tanX,
            tanY
        });
    });
    events.function('background.compositePanorama', (data: Uint8Array, width: number, height: number, stereo: boolean) => {
        if (state.mode !== 'gradient') return;
        compositeGradient(state, data, width, height, { kind: stereo ? 'stereo' : 'equirect' });
    });

    // project file
    events.function('docSerialize.background', () => ({ ...state }));
    events.function('docDeserialize.background', (doc: Partial<BackgroundState> | undefined) => {
        state = { ...defaultState(), ...(doc ?? {}) };
        changed();
    });
};

export { registerBackgroundEvents, type BackgroundState };
