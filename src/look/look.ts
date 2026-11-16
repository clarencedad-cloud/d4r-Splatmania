import type { RenderTarget } from 'playcanvas';

import type { AnimTrack } from '../anim-track';
import { AnimTrackEditOp } from '../edit-ops';
import { Events } from '../events';
import type { Scene } from '../scene';
import { defaultLook, lookActive, LookParams, LookRenderer } from './look-renderer';

// The look: glow, grading, lens effects and a LUT over the rendered image
// (src/look/look-renderer.ts). One global look per project, saved with it.
// It shows in the viewport and in every image, video and panorama export;
// gizmos, grid helpers drawn after it and the overdraw view stay untouched.

// the output height the effect sizes are tuned for (1080p)
const REFERENCE_HEIGHT = 1080;

type LookPatch = Partial<Omit<LookParams, 'lut'>>;

// parse an Adobe / Resolve .cube 3D LUT
const parseCube = (text: string): { size: number, data: Float32Array } => {
    let size = 0;
    let domainMin = [0, 0, 0];
    let domainMax = [1, 1, 1];
    const values: number[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s+/);
        const head = parts[0].toUpperCase();
        if (head === 'LUT_3D_SIZE') {
            size = parseInt(parts[1], 10);
        } else if (head === 'DOMAIN_MIN') {
            domainMin = parts.slice(1, 4).map(Number);
        } else if (head === 'DOMAIN_MAX') {
            domainMax = parts.slice(1, 4).map(Number);
        } else if (head === 'LUT_1D_SIZE') {
            throw new Error('1D LUTs are not supported, please use a 3D .cube LUT');
        } else if (/^[-+.\d]/.test(head)) {
            const r = Number(parts[0]);
            const g = Number(parts[1]);
            const b = Number(parts[2]);
            if ([r, g, b].some(v => !Number.isFinite(v))) continue;
            values.push(r, g, b);
        }
    }
    if (size < 2 || size > 128) throw new Error('No LUT_3D_SIZE found');
    if (values.length < size * size * size * 3) throw new Error(`Expected ${size * size * size} entries, found ${values.length / 3}`);
    const data = new Float32Array(size * size * size * 3);
    for (let i = 0; i < data.length; i++) {
        const c = i % 3;
        const range = domainMax[c] - domainMin[c] || 1;
        data[i] = (values[i] - domainMin[c]) / range;
    }
    return { size, data };
};

// what a look key stores: every value that can blend between keys (the
// on / off switch and the LUT file stay global)
const NUMBER_KEYS = [
    'bloom', 'bloomThreshold', 'bloomRadius', 'exposure', 'contrast', 'saturation', 'temperature',
    'vignette', 'vignetteSoftness', 'grain', 'aberration', 'lutStrength', 'fog', 'fogStart', 'fogEnd'
] as const;
type NumberKey = typeof NUMBER_KEYS[number];
type LookValues = Pick<LookParams, NumberKey | 'bloomTint' | 'fogColor' | 'fogMode'>;
type LookKey = { frame: number, values: LookValues };

const captureValues = (p: LookParams): LookValues => {
    const v: any = {};
    NUMBER_KEYS.forEach((k) => {
        v[k] = p[k];
    });
    v.bloomTint = [...p.bloomTint];
    v.fogColor = [...p.fogColor];
    v.fogMode = p.fogMode;
    return v as LookValues;
};

const copyValues = (v: LookValues): LookValues => ({ ...v, bloomTint: [...v.bloomTint], fogColor: [...v.fogColor] });

const sameValues = (a: LookValues, b: LookValues) => NUMBER_KEYS.every(k => Math.abs(a[k] - b[k]) < 1e-4) &&
    a.fogMode === b.fogMode &&
    a.bloomTint.every((c, i) => Math.abs(c - b.bloomTint[i]) < 1e-4) &&
    a.fogColor.every((c, i) => Math.abs(c - b.fogColor[i]) < 1e-4);

// keyframe track of the look: a key holds the whole look, frames between
// keys blend smoothly (ease in / out), the fog mode switches halfway
class LookTrack implements AnimTrack {
    private keyList: LookKey[] = [];

    constructor(private events: Events, private capture: () => LookValues) {}

    get keys() {
        return this.keyList.map(k => k.frame);
    }

    get keyData(): readonly LookKey[] {
        return this.keyList;
    }

    private sort() {
        this.keyList.sort((a, b) => a.frame - b.frame);
    }

    addKey(frame: number) {
        const values = this.capture();
        const existing = this.keyList.find(k => k.frame === frame);
        if (existing) {
            if (sameValues(existing.values, values)) return false;
            existing.values = values;
        } else {
            this.keyList.push({ frame, values });
            this.sort();
        }
        this.changed();
        return true;
    }

    removeKey(frame: number) {
        const i = this.keyList.findIndex(k => k.frame === frame);
        if (i === -1) return false;
        this.keyList.splice(i, 1);
        this.changed();
        return true;
    }

    moveKey(from: number, to: number) {
        const key = this.keyList.find(k => k.frame === from);
        if (!key || from === to) return false;
        this.keyList = this.keyList.filter(k => k.frame !== to);
        key.frame = to;
        this.sort();
        this.changed();
        return true;
    }

    copyKey(from: number, to: number) {
        const key = this.keyList.find(k => k.frame === from);
        if (!key || from === to) return false;
        this.keyList = this.keyList.filter(k => k.frame !== to);
        this.keyList.push({ frame: to, values: copyValues(key.values) });
        this.sort();
        this.changed();
        return true;
    }

    clear() {
        this.keyList = [];
        this.changed();
    }

    snapshot() {
        return this.keyList.map(k => ({ frame: k.frame, values: copyValues(k.values) }));
    }

    restore(snapshot: unknown) {
        this.keyList = (snapshot as LookKey[]).map(k => ({ frame: k.frame, values: copyValues(k.values) }));
        this.sort();
        this.changed();
    }

    // the animated look at a (fractional) frame, or null without keys
    evaluate(frame: number): LookValues | null {
        const keys = this.keyList;
        if (keys.length === 0) return null;
        if (frame <= keys[0].frame) return copyValues(keys[0].values);
        const last = keys[keys.length - 1];
        if (frame >= last.frame) return copyValues(last.values);
        let i = 0;
        while (i < keys.length - 2 && frame > keys[i + 1].frame) i++;
        const a = keys[i].values;
        const b = keys[i + 1].values;
        const t = (frame - keys[i].frame) / (keys[i + 1].frame - keys[i].frame);
        const e = t * t * (3 - 2 * t);
        const mix = (x: number, y: number) => x + (y - x) * e;
        const v: any = {};
        NUMBER_KEYS.forEach((k) => {
            v[k] = mix(a[k], b[k]);
        });
        v.bloomTint = a.bloomTint.map((c, j) => mix(c, b.bloomTint[j]));
        v.fogColor = a.fogColor.map((c, j) => mix(c, b.fogColor[j]));
        v.fogMode = e < 0.5 ? a.fogMode : b.fogMode;
        return v as LookValues;
    }

    private changed() {
        this.events.fire('look.trackChanged', this);
    }
}

const registerLookEvents = (events: Events, scene: Scene) => {
    const state: LookParams = defaultLook();
    const renderer = new LookRenderer(scene.graphicsDevice);
    // panoramas render their cube faces without the look and apply it once
    // to the finished equirect image
    let suppressed = 0;
    let currentFrame = 0;
    const track = new LookTrack(events, () => captureValues(state));

    const changed = () => {
        events.fire('look.changed', state);
        scene.forceRender = true;
    };

    events.function('look.state', () => state);
    events.function('look.active', () => lookActive(state) || (state.enabled && state.fog > 0));
    // the projector's fog; null = off
    events.function('look.fog', () => (state.enabled && state.fog > 0 ? {
        start: state.fogStart,
        end: state.fogEnd,
        strength: state.fog,
        mode: state.fogMode,
        color: state.fogColor
    } : null));

    // keyframes: the animated look follows the timeline (and the export,
    // which steps timeline.time frame by frame)
    const applyTrack = () => {
        const v = track.evaluate(currentFrame);
        if (v && !sameValues(v, captureValues(state))) {
            Object.assign(state, v);
            changed();
        }
    };
    events.on('timeline.time', (t: number) => {
        currentFrame = t;
        applyTrack();
    });
    events.on('timeline.frame', (f: number) => {
        currentFrame = f;
        applyTrack();
    });
    events.on('look.trackChanged', () => applyTrack());

    events.function('look.track', () => track);

    // key state of the whole look at the current frame (src/ui/key-button.ts)
    events.function('look.keyState', () => {
        const frame = Math.round(events.invoke('timeline.frame') ?? 0);
        if (track.keyData.length === 0) return 'static';
        const v = track.evaluate(frame);
        if (v && !sameValues(v, captureValues(state))) return 'changed';
        return track.keyData.some(k => k.frame === frame) ? 'keyed' : 'animated';
    });

    // undoable key edits; the track manager also keys the look when it is
    // the key target or has a pending edit
    events.on('look.addKey', (frame?: number) => {
        const before = track.snapshot();
        if (track.addKey(Math.round(frame ?? events.invoke('timeline.frame') ?? 0))) {
            events.fire('edit.add', new AnimTrackEditOp('lookKey', track, before, track.snapshot()), true);
        }
    });
    events.on('look.removeKey', (frame?: number) => {
        const before = track.snapshot();
        if (track.removeKey(Math.round(frame ?? events.invoke('timeline.frame') ?? 0))) {
            events.fire('edit.add', new AnimTrackEditOp('lookUnkey', track, before, track.snapshot()), true);
        }
    });

    events.on('look.set', (patch: LookPatch) => {
        Object.assign(state, patch);
        changed();
    });

    events.on('look.reset', () => {
        const enabled = state.enabled;
        Object.assign(state, defaultLook(), { enabled });
        changed();
    });

    events.on('look.loadLut', (name: string, text: string) => {
        const { size, data } = parseCube(text);
        state.lut = { name, size, data };
        if (state.lutStrength <= 0) state.lutStrength = 1;
        changed();
    });

    events.on('look.clearLut', () => {
        state.lut = null;
        changed();
    });

    events.function('look.suppress', (on: boolean) => {
        suppressed = Math.max(0, suppressed + (on ? 1 : -1));
    });

    const seed = () => Math.round(events.invoke('timeline.frame') ?? 0);

    // the camera, every frame: between the splats and the gizmos.
    // `offscreen`: an export frame (its clear colour already holds the
    // background, or it is transparent); else the viewport, whose
    // background is the page colour behind the canvas
    events.function('look.applyCamera', (target: RenderTarget, offscreen: boolean) => {
        if (suppressed > 0 || scene.overdrawRender || !lookActive(state)) return;
        renderer.apply(target, state, {
            panorama: false,
            background: offscreen || (events.functions.has('background.gradient') && events.invoke('background.gradient')) ? null : events.invoke('bgClr'),
            seed: seed(),
            referenceHeight: REFERENCE_HEIGHT
        });
    });

    // a finished equirect panorama (mono or one eye of a stereo pair)
    events.function('look.applyPanorama', (target: RenderTarget) => {
        if (!lookActive(state)) return;
        renderer.apply(target, state, {
            panorama: true,
            background: null,
            seed: seed(),
            referenceHeight: REFERENCE_HEIGHT
        });
    });

    // project file
    events.function('docSerialize.look', () => {
        const { lut, ...rest } = state;
        return {
            ...rest,
            bloomTint: [...rest.bloomTint],
            fogColor: [...rest.fogColor],
            keys: track.snapshot(),
            lut: lut ? { name: lut.name, size: lut.size, data: Array.from(lut.data, v => Math.round(v * 1e5) / 1e5) } : null
        };
    });

    events.function('docDeserialize.look', (doc: any) => {
        Object.assign(state, defaultLook());
        if (doc) {
            const { lut, keys, ...rest } = doc;
            for (const key of Object.keys(rest)) {
                if (key in state) (state as any)[key] = rest[key];
            }
            state.bloomTint = Array.isArray(rest.bloomTint) ? [rest.bloomTint[0], rest.bloomTint[1], rest.bloomTint[2]] : [1, 1, 1];
            state.fogColor = Array.isArray(rest.fogColor) ? [rest.fogColor[0], rest.fogColor[1], rest.fogColor[2]] : defaultLook().fogColor;
            state.lut = lut && Array.isArray(lut.data) ? { name: lut.name ?? 'LUT', size: lut.size, data: new Float32Array(lut.data) } : null;
        }
        const keys = Array.isArray(doc?.keys) ? doc.keys.filter((k: any) => k && Number.isFinite(k.frame) && k.values).map((k: any) => ({
            frame: k.frame,
            values: { ...captureValues(defaultLook()), ...k.values }
        })) : [];
        track.restore(keys);
        changed();
    });
};

export { registerLookEvents, parseCube, LookTrack };
