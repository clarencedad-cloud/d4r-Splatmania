import type { Container } from '@playcanvas/pcui';

import type { AnimTrack } from '../anim-track';
import { AnimTrackEditOp } from '../edit-ops';
import { Events } from '../events';
import type { Scene } from '../scene';

// Depth of field: a thin-lens blur applied per splat in the projector (the
// projected gaussian widens by the circle of confusion and keeps its energy),
// so it looks the same in the viewport and in every export. Focus distance
// and aperture have their own keyframe track for focus pulls.

type DofState = {
    enabled: boolean,
    // distance of the focus plane from the camera (view depth, world units)
    focus: number,
    // lens radius in world units: bigger = shallower depth of field
    aperture: number,
    // cap on the blur diameter in pixels
    maxBlur: number
};

type DofKey = { frame: number, focus: number, aperture: number };

// keyframe track for focus pulls; smooth interpolation
class DofTrack implements AnimTrack {
    private keyList: DofKey[] = [];
    constructor(private events: Events, private capture: () => { focus: number, aperture: number }) {}

    get keys() {
        return this.keyList.map(k => k.frame);
    }

    get keyData(): readonly DofKey[] {
        return this.keyList;
    }

    addKey(frame: number) {
        const { focus, aperture } = this.capture();
        const existing = this.keyList.find(k => k.frame === frame);
        if (existing) {
            existing.focus = focus;
            existing.aperture = aperture;
        } else {
            this.keyList.push({ frame, focus, aperture });
            this.keyList.sort((a, b) => a.frame - b.frame);
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
        this.keyList.sort((a, b) => a.frame - b.frame);
        this.changed();
        return true;
    }

    copyKey(from: number, to: number) {
        const key = this.keyList.find(k => k.frame === from);
        if (!key || from === to) return false;
        this.keyList = this.keyList.filter(k => k.frame !== to);
        this.keyList.push({ ...key, frame: to });
        this.keyList.sort((a, b) => a.frame - b.frame);
        this.changed();
        return true;
    }

    clear() {
        this.keyList = [];
        this.changed();
    }

    snapshot() {
        return this.keyList.map(k => ({ ...k }));
    }

    restore(snapshot: unknown) {
        this.keyList = (snapshot as DofKey[]).map(k => ({ ...k }));
        this.changed();
    }

    evaluate(frame: number): { focus: number, aperture: number } | null {
        const keys = this.keyList;
        if (keys.length === 0) return null;
        if (frame <= keys[0].frame) return { ...keys[0] };
        const last = keys[keys.length - 1];
        if (frame >= last.frame) return { ...last };
        for (let i = 0; i < keys.length - 1; i++) {
            const a = keys[i], b = keys[i + 1];
            if (frame >= a.frame && frame <= b.frame) {
                const t = (frame - a.frame) / (b.frame - a.frame);
                const e = t * t * (3 - 2 * t);
                return { focus: a.focus + (b.focus - a.focus) * e, aperture: a.aperture + (b.aperture - a.aperture) * e };
            }
        }
        return null;
    }

    private changed() {
        this.events.fire('dof.trackChanged', this);
    }
}

const registerDofEvents = (events: Events, scene: Scene, canvasContainer: Container) => {
    const state: DofState = { enabled: false, focus: 5, aperture: 0.05, maxBlur: 24 };
    let currentFrame = 0;
    let picking = false;

    const track = new DofTrack(events, () => ({ focus: state.focus, aperture: state.aperture }));

    let wasEnabled = state.enabled;
    const changed = () => {
        events.fire('dof.changed', state);
        if (state.enabled !== wasEnabled) {
            wasEnabled = state.enabled;
            events.fire('dof.enabled', state.enabled);
        }
        scene.forceRender = true;
    };

    events.function('dof.state', () => state);
    events.function('dof.track', () => track);
    // what the projector uses; null = off
    events.function('dof.params', () => (state.enabled ? { focus: state.focus, aperture: state.aperture, maxBlur: state.maxBlur } : null));

    events.on('dof.set', (value: Partial<DofState>) => {
        Object.assign(state, value);
        state.focus = Math.max(0.01, state.focus);
        state.aperture = Math.max(0, state.aperture);
        changed();
    });

    // the animated focus follows the timeline
    const applyTrack = () => {
        const v = track.evaluate(currentFrame);
        if (v && (v.focus !== state.focus || v.aperture !== state.aperture)) {
            state.focus = v.focus;
            state.aperture = v.aperture;
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
    events.on('dof.trackChanged', () => {
        applyTrack();
        events.fire('dof.changed', state);
    });

    events.on('dof.addKey', (frame?: number) => {
        const before = track.snapshot();
        track.addKey(frame ?? events.invoke('timeline.frame'));
        events.fire('edit.add', new AnimTrackEditOp('dofKey', track, before, track.snapshot()), true);
    });

    // focus pipette: the next viewport click focuses on the surface under it
    const down = { x: 0, y: 0, active: false };
    events.on('dof.pickFocus', () => {
        picking = !picking;
        events.fire('dof.picking', picking);
    });
    canvasContainer.dom.addEventListener('pointerdown', (e: PointerEvent) => {
        if (!picking) return;
        down.x = e.offsetX;
        down.y = e.offsetY;
        down.active = true;
    });
    canvasContainer.dom.addEventListener('pointerup', async (e: PointerEvent) => {
        if (!picking || !down.active) return;
        down.active = false;
        if (Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 4) return;
        picking = false;
        events.fire('dof.picking', false);
        const hit = await scene.camera.intersect(down.x / canvasContainer.dom.clientWidth, down.y / canvasContainer.dom.clientHeight);
        if (hit) {
            events.fire('dof.set', { focus: hit.depth, enabled: true });
        }
    });

    // serialization
    events.function('docSerialize.dof', () => ({ ...state, keys: track.snapshot() }));
    events.function('docDeserialize.dof', (doc: any) => {
        if (!doc) return;
        const { keys, ...rest } = doc;
        Object.assign(state, rest);
        track.restore(keys ?? []);
        changed();
    });

    changed();
};

export { registerDofEvents, DofTrack, DofState };
