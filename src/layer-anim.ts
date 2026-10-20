import { Quat, Vec3 } from 'playcanvas';

import { AnimTrack } from './anim-track';
import { AnimTrackEditOp } from './edit-ops';
import { ElementType, Element } from './element';
import { Events } from './events';
import type { Splat } from './splat';
import { Transform } from './transform';

const pivotTransform = new Transform();

// One key of a layer track. Channels are optional: a key only animates the
// channels it carries, so a fade (opacity only) never pins the transform
type LayerKey = {
    frame: number,
    opacity?: number,
    mix?: number,
    position?: Vec3,
    rotation?: Quat,
    scale?: Vec3
};

type LayerInterpolation = 'linear' | 'smooth';

// how a layer renders: follow the global mode, or force splats / points
type LayerRenderMode = 'inherit' | 'splats' | 'points';

type PointCloudSettings = {
    mode: 'splats' | 'points',
    // point diameter: pixels, or world units (shrinks with distance)
    size: number,
    sizeMode: 'px' | 'world',
    colorMode: 'original' | 'uniform',
    color: [number, number, number],
    opacity: number,
    // 0..1 additive glow
    glow: number
};

// per-splat build transitions, evaluated on the gpu (projector shader)
type TransitionEffect = 'sweep' | 'radial' | 'dissolve' | 'grow' | 'fly' | 'wave';
type TransitionEasing = 'linear' | 'in' | 'out' | 'inOut';
type TransitionAxis = 'x' | 'y' | 'z' | '-x' | '-y' | '-z';

type Transition = {
    id: number,
    kind: 'in' | 'out',
    effect: TransitionEffect,
    start: number,
    duration: number,
    easing: TransitionEasing,
    axis: TransitionAxis,
    // world-space origin for radial / grow / fly-explode; null = layer centre
    origin: [number, number, number] | null,
    // width of the build front, as a fraction of the layer
    edge: number,
    // glow on the build front
    glow: number,
    glowColor: [number, number, number],
    // fly / wave distance, as a fraction of the layer radius
    scatter: number,
    // fly: turns of swirl
    swirl: number,
    flyMode: 'random' | 'explode',
    seed: number,
    // points first, then splats
    pointPhase: boolean,
    // dissolve: threshold driver, noise frequency (per layer size), noise
    // share when combined with a gradient, particle drift and the points
    dissolveMode: 'noise' | 'axis' | 'radial',
    noiseFreq: number,
    noiseAmount: number,
    driftMode: 'out' | 'axis' | 'random',
    pointSize: number,
    pointTint: number
};

const TRANSITION_LABELS: Record<TransitionEffect, string> = {
    sweep: 'Sweep',
    radial: 'Radial',
    dissolve: 'Dissolve',
    grow: 'Grow',
    fly: 'Fly-in',
    wave: 'Wave'
};

const EFFECT_IDS: Record<TransitionEffect, number> = { sweep: 1, radial: 2, dissolve: 3, grow: 4, fly: 5, wave: 6 };

const AXES: Record<TransitionAxis, [number, number, number]> = {
    'x': [1, 0, 0],
    'y': [0, 1, 0],
    'z': [0, 0, 1],
    '-x': [-1, 0, 0],
    '-y': [0, -1, 0],
    '-z': [0, 0, -1]
};

const easeValue = (t: number, easing: TransitionEasing) => {
    switch (easing) {
        case 'in': return t * t * t;
        case 'out': return 1 - (1 - t) ** 3;
        case 'inOut': return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
        default: return t;
    }
};

let nextTransitionId = 1;

const defaultTransition = (kind: 'in' | 'out', start: number, duration: number): Transition => ({
    id: nextTransitionId++,
    kind,
    effect: 'sweep',
    start,
    duration,
    easing: 'inOut',
    axis: 'y',
    origin: null,
    edge: 0.25,
    glow: 0.6,
    glowColor: [0.3, 0.8, 1],
    scatter: 0.6,
    swirl: 0.5,
    flyMode: 'random',
    seed: 1,
    pointPhase: false,
    dissolveMode: 'noise',
    noiseFreq: 3,
    noiseAmount: 0.5,
    driftMode: 'out',
    pointSize: 3,
    pointTint: 0.6
});

const cloneTransition = (t: Transition): Transition => ({
    ...t,
    origin: t.origin ? [...t.origin] as [number, number, number] : null,
    glowColor: [...t.glowColor] as [number, number, number]
});

const cloneKey = (k: LayerKey): LayerKey => ({
    frame: k.frame,
    opacity: k.opacity,
    mix: k.mix,
    position: k.position?.clone(),
    rotation: k.rotation?.clone(),
    scale: k.scale?.clone()
});

/**
 * Keyframe track of one splat layer: opacity, splat <-> point mix and the
 * layer transform, with linear or smooth (ease in/out) interpolation.
 */
class LayerAnimTrack implements AnimTrack {
    private events: Events;
    readonly splat: Splat;
    private keyList: LayerKey[] = [];
    interpolation: LayerInterpolation = 'smooth';
    transitions: Transition[] = [];

    constructor(events: Events, splat: Splat) {
        this.events = events;
        this.splat = splat;
    }

    get keys(): readonly number[] {
        return this.keyList.map(k => k.frame);
    }

    get keyData(): readonly LayerKey[] {
        return this.keyList;
    }

    // store a key, merging its channels into an existing key at that frame
    setKey(key: LayerKey) {
        const existing = this.keyList.find(k => k.frame === key.frame);
        if (existing) {
            for (const channel of ['opacity', 'mix', 'position', 'rotation', 'scale'] as const) {
                if (key[channel] !== undefined) (existing as any)[channel] = key[channel];
            }
        } else {
            this.keyList.push(key);
            this.keyList.sort((a, b) => a.frame - b.frame);
        }
        this.changed();
    }

    // capture all channels from the layer's current state
    addKey(frame: number): boolean {
        const state = this.events.invoke('layerAnim.state', this.splat) as LayerState;
        const entity = this.splat.entity;
        this.setKey({
            frame,
            opacity: state.opacity,
            mix: state.mixOverride ?? undefined,
            position: entity.getLocalPosition().clone(),
            rotation: entity.getLocalRotation().clone(),
            scale: entity.getLocalScale().clone()
        });
        return true;
    }

    removeKey(frame: number): boolean {
        const index = this.keyList.findIndex(k => k.frame === frame);
        if (index === -1) return false;
        this.keyList.splice(index, 1);
        this.changed();
        return true;
    }

    moveKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;
        const key = this.keyList.find(k => k.frame === fromFrame);
        if (!key) return false;
        this.keyList = this.keyList.filter(k => k.frame !== toFrame);
        key.frame = toFrame;
        this.keyList.sort((a, b) => a.frame - b.frame);
        this.changed();
        return true;
    }

    copyKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;
        const key = this.keyList.find(k => k.frame === fromFrame);
        if (!key) return false;
        this.keyList = this.keyList.filter(k => k.frame !== toFrame);
        this.keyList.push({ ...cloneKey(key), frame: toFrame });
        this.keyList.sort((a, b) => a.frame - b.frame);
        this.changed();
        return true;
    }

    clear(): void {
        this.keyList = [];
        this.changed();
    }

    snapshot() {
        return {
            interpolation: this.interpolation,
            keys: this.keyList.map(cloneKey),
            transitions: this.transitions.map(cloneTransition)
        };
    }

    restore(snapshot: unknown): void {
        const s = snapshot as { interpolation: LayerInterpolation, keys: LayerKey[], transitions?: Transition[] };
        this.interpolation = s.interpolation;
        this.keyList = s.keys.map(cloneKey);
        this.transitions = (s.transitions ?? []).map(cloneTransition);
        this.changed();
    }

    // the build state at frame: the transition governing it (the latest one
    // that has started, else the first one ahead) and its build value, 1 =
    // fully built. Before an In the layer is unbuilt; after an Out it is gone
    buildAt(frame: number): { transition: Transition, build: number } | null {
        if (this.transitions.length === 0) return null;
        const sorted = this.transitions.slice().sort((a, b) => a.start - b.start);
        let governing = sorted[0];
        for (const t of sorted) {
            if (t.start <= frame) governing = t;
        }
        const raw = Math.min(1, Math.max(0, (frame - governing.start) / Math.max(1, governing.duration)));
        const p = easeValue(raw, governing.easing);
        return { transition: governing, build: governing.kind === 'in' ? p : 1 - p };
    }

    // the eased segment parameter between two keys
    private ease(t: number) {
        return this.interpolation === 'smooth' ? t * t * (3 - 2 * t) : t;
    }

    // keys carrying channel, and the bracketing pair + weight at frame
    private bracket(channel: keyof LayerKey, frame: number): [LayerKey, LayerKey, number] | null {
        const keys = this.keyList.filter(k => k[channel] !== undefined);
        if (keys.length === 0) return null;
        if (frame <= keys[0].frame) return [keys[0], keys[0], 0];
        const last = keys[keys.length - 1];
        if (frame >= last.frame) return [last, last, 0];
        for (let i = 0; i < keys.length - 1; i++) {
            const a = keys[i], b = keys[i + 1];
            if (frame >= a.frame && frame <= b.frame) {
                return [a, b, this.ease((frame - a.frame) / (b.frame - a.frame))];
            }
        }
        return null;
    }

    evaluateNumber(channel: 'opacity' | 'mix', frame: number): number | null {
        const b = this.bracket(channel, frame);
        if (!b) return null;
        return b[0][channel] + (b[1][channel] - b[0][channel]) * b[2];
    }

    evaluateVec(channel: 'position' | 'scale', frame: number, out: Vec3): Vec3 | null {
        const b = this.bracket(channel, frame);
        if (!b) return null;
        return out.lerp(b[0][channel], b[1][channel], b[2]);
    }

    evaluateQuat(frame: number, out: Quat): Quat | null {
        const b = this.bracket('rotation', frame);
        if (!b) return null;
        return out.slerp(b[0].rotation, b[1].rotation, b[2]);
    }

    private changed() {
        this.events.fire('layerAnim.trackChanged', this);
    }
}

// per-layer animation state
type LayerState = {
    track: LayerAnimTrack,
    // current opacity (animated, or the base the panel sets)
    opacity: number,
    // explicit splat <-> point mix (0 splats, 1 points); null follows the
    // render mode
    mixOverride: number | null,
    renderMode: LayerRenderMode
};

const registerLayerAnimEvents = (events: Events) => {
    const states = new Map<Splat, LayerState>();

    const points: PointCloudSettings = {
        mode: 'splats',
        size: 3,
        sizeMode: 'px',
        colorMode: 'original',
        color: [1, 1, 1],
        opacity: 1,
        glow: 0
    };

    const stateOf = (splat: Splat): LayerState => {
        let state = states.get(splat);
        if (!state) {
            state = { track: new LayerAnimTrack(events, splat), opacity: 1, mixOverride: null, renderMode: 'inherit' };
            states.set(splat, state);
        }
        return state;
    };

    const changed = (splat?: Splat) => {
        events.fire('layerAnim.changed', splat);
    };

    let currentFrame = 0;
    const tmpPos = new Vec3();
    const tmpScale = new Vec3();
    const tmpRot = new Quat();

    // evaluate one layer's track at frame and push it to the layer
    const applyLayer = (state: LayerState, frame: number) => {
        const { track } = state;
        if (track.keys.length === 0) return;

        const opacity = track.evaluateNumber('opacity', frame);
        if (opacity !== null) state.opacity = Math.min(1, Math.max(0, opacity));

        const mix = track.evaluateNumber('mix', frame);
        if (mix !== null) state.mixOverride = Math.min(1, Math.max(0, mix));

        const entity = track.splat.entity;
        const position = track.evaluateVec('position', frame, tmpPos);
        const rotation = track.evaluateQuat(frame, tmpRot);
        const scale = track.evaluateVec('scale', frame, tmpScale);
        // only move when something changed: move() updates bounds and notifies
        const moved = (position && !position.equals(entity.getLocalPosition())) ||
            (rotation && !rotation.equals(entity.getLocalRotation())) ||
            (scale && !scale.equals(entity.getLocalScale()));
        if (moved) {
            track.splat.move(position ?? undefined, rotation ?? undefined, scale ?? undefined);
            // keep the transform panel and gizmo on the animated layer
            if ((events.functions.has('selection') ? events.invoke('selection') : null) === track.splat) {
                track.splat.getPivot(pivotTransform);
                events.invoke('pivot')?.place(pivotTransform);
            }
        }
    };

    const applyAll = () => {
        states.forEach(state => applyLayer(state, currentFrame));
        changed();
    };

    events.on('timeline.time', (time: number) => {
        currentFrame = time;
        applyAll();
    });

    events.on('timeline.frame', (frame: number) => {
        currentFrame = frame;
        applyAll();
    });

    events.on('layerAnim.trackChanged', (track: LayerAnimTrack) => {
        const state = states.get(track.splat);
        if (state) applyLayer(state, currentFrame);
        changed(track.splat);
    });

    events.on('scene.elementRemoved', (element: Element) => {
        if (element.type === ElementType.splat && states.delete(element as Splat)) {
            changed();
        }
    });

    events.on('scene.elementAdded', (element: Element) => {
        if (element.type === ElementType.splat) {
            stateOf(element as Splat);
            changed();
        }
    });

    // api

    events.function('layerAnim.state', (splat: Splat) => stateOf(splat));
    events.function('layerAnim.layers', () => Array.from(states.keys()).filter(s => s.scene));
    events.function('layerAnim.points', () => points);

    // what the renderer draws for a layer: opacity, point mix, glow
    events.function('layerAnim.renderParams', (splat: Splat) => {
        const state = states.get(splat);
        const mode = state && state.renderMode !== 'inherit' ? state.renderMode : points.mode;
        const mix = state?.mixOverride ?? (mode === 'points' ? 1 : 0);
        return { opacity: state?.opacity ?? 1, mix, glow: points.glow };
    });

    events.on('layerAnim.setPoints', (value: Partial<PointCloudSettings>) => {
        Object.assign(points, value);
        events.fire('layerAnim.points', points);
        changed();
    });

    events.on('layerAnim.setOpacity', (splat: Splat, value: number) => {
        stateOf(splat).opacity = Math.min(1, Math.max(0, value));
        changed(splat);
    });

    events.on('layerAnim.setMix', (splat: Splat, value: number | null) => {
        stateOf(splat).mixOverride = value === null ? null : Math.min(1, Math.max(0, value));
        changed(splat);
    });

    events.on('layerAnim.setRenderMode', (splat: Splat, mode: LayerRenderMode) => {
        stateOf(splat).renderMode = mode;
        changed(splat);
    });

    // undoable track edits

    const trackEdit = (splat: Splat, name: string, editFn: (track: LayerAnimTrack) => boolean) => {
        const { track } = stateOf(splat);
        const before = track.snapshot();
        if (!editFn(track)) return;
        events.fire('edit.add', new AnimTrackEditOp(name, track, before, track.snapshot()), true);
    };

    const frameOrCurrent = (frame?: number) => frame ?? events.invoke('timeline.frame');

    events.on('layerAnim.addKey', (splat: Splat, frame?: number) => {
        trackEdit(splat, 'layerAddKey', track => track.addKey(frameOrCurrent(frame)));
    });

    events.on('layerAnim.removeKey', (splat: Splat, frame?: number) => {
        trackEdit(splat, 'layerRemoveKey', track => track.removeKey(frameOrCurrent(frame)));
    });

    events.on('layerAnim.moveKey', (splat: Splat, fromFrame: number, toFrame: number) => {
        trackEdit(splat, 'layerMoveKey', track => track.moveKey(fromFrame, toFrame));
    });

    events.on('layerAnim.setInterpolation', (splat: Splat, value: LayerInterpolation) => {
        trackEdit(splat, 'layerInterpolation', (track) => {
            if (track.interpolation === value) return false;
            track.interpolation = value;
            events.fire('layerAnim.trackChanged', track);
            return true;
        });
    });

    // fade: two opacity keys from the current frame over duration frames
    const fade = (splat: Splat, from: number, to: number, duration: number) => {
        const start = events.invoke('timeline.frame') as number;
        const end = Math.min(start + Math.max(1, Math.round(duration)), events.invoke('timeline.frames') - 1);
        trackEdit(splat, 'layerFade', (track) => {
            track.setKey({ frame: start, opacity: from });
            track.setKey({ frame: end, opacity: to });
            return true;
        });
    };

    events.on('layerAnim.fadeIn', (splat: Splat, duration: number) => fade(splat, 0, 1, duration));
    events.on('layerAnim.fadeOut', (splat: Splat, duration: number) => fade(splat, 1, 0, duration));

    // serialization: per layer via Splat.docSerialize, global point settings
    // via the document

    const pack3 = (v: Vec3) => [v.x, v.y, v.z];

    events.function('layerAnim.serialize', (splat: Splat) => {
        const state = states.get(splat);
        if (!state) return undefined;
        return {
            opacity: state.opacity,
            mixOverride: state.mixOverride,
            renderMode: state.renderMode,
            interpolation: state.track.interpolation,
            transitions: state.track.transitions.map(cloneTransition),
            keys: state.track.keyData.map(k => ({
                frame: k.frame,
                opacity: k.opacity,
                mix: k.mix,
                position: k.position ? pack3(k.position) : undefined,
                rotation: k.rotation ? [k.rotation.x, k.rotation.y, k.rotation.z, k.rotation.w] : undefined,
                scale: k.scale ? pack3(k.scale) : undefined
            }))
        };
    });

    events.function('layerAnim.deserialize', (splat: Splat, doc: any) => {
        if (!doc) return;
        const state = stateOf(splat);
        state.opacity = doc.opacity ?? 1;
        state.mixOverride = doc.mixOverride ?? null;
        state.renderMode = doc.renderMode ?? 'inherit';
        state.track.restore({
            interpolation: doc.interpolation ?? 'smooth',
            transitions: (doc.transitions ?? []).map((t: Transition) => {
                nextTransitionId = Math.max(nextTransitionId, t.id + 1);
                return { ...defaultTransition(t.kind, t.start, t.duration), ...t };
            }),
            keys: (doc.keys ?? []).map((k: any) => ({
                frame: k.frame,
                opacity: k.opacity ?? undefined,
                mix: k.mix ?? undefined,
                position: k.position ? new Vec3(k.position) : undefined,
                rotation: k.rotation ? new Quat(k.rotation) : undefined,
                scale: k.scale ? new Vec3(k.scale) : undefined
            }))
        });
    });

    // transitions

    let selectedTransition: number | null = null;

    events.function('layerAnim.selectedTransition', () => {
        const splat = (events.functions.has('selection') ? events.invoke('selection') : null) as Splat;
        if (!splat || selectedTransition === null) return null;
        return stateOf(splat).track.transitions.find(t => t.id === selectedTransition) ?? null;
    });

    events.on('layerAnim.selectTransition', (id: number | null) => {
        selectedTransition = id;
        events.fire('layerAnim.transitionSelected', id);
    });

    // add a transition block (undoable); default range: current frame + 30
    events.on('layerAnim.addTransition', (splat: Splat, kind: 'in' | 'out', start?: number, duration?: number) => {
        const transition = defaultTransition(kind, start ?? events.invoke('timeline.frame'), duration ?? 30);
        trackEdit(splat, 'transitionAdd', (track) => {
            track.transitions.push(transition);
            events.fire('layerAnim.trackChanged', track);
            return true;
        });
        events.fire('layerAnim.selectTransition', transition.id);
    });

    events.on('layerAnim.removeTransition', (splat: Splat, id: number) => {
        trackEdit(splat, 'transitionRemove', (track) => {
            const index = track.transitions.findIndex(t => t.id === id);
            if (index === -1) return false;
            track.transitions.splice(index, 1);
            events.fire('layerAnim.trackChanged', track);
            return true;
        });
        if (selectedTransition === id) events.fire('layerAnim.selectTransition', null);
    });

    // move / resize / change kind or effect: undoable; continuous parameter
    // tweaks (sliders) pass undoable = false
    events.on('layerAnim.updateTransition', (splat: Splat, id: number, value: Partial<Transition>, undoable = true) => {
        const { track } = stateOf(splat);
        const transition = track.transitions.find(t => t.id === id);
        if (!transition) return;
        if (undoable) {
            trackEdit(splat, 'transitionUpdate', () => {
                Object.assign(transition, value);
                events.fire('layerAnim.trackChanged', track);
                return true;
            });
        } else {
            Object.assign(transition, value);
            events.fire('layerAnim.trackChanged', track);
        }
    });

    // shader parameters of a layer's transition at the current frame
    const NO_TRANSITION = { transA: [0, 1, 0, 0], transB: [0, 0, 0, 0], transC: [0, 1, 0, 0], transD: [0, 1, 1, 0], transE: [1, 0, 0, 0], transF: [0, 0, 0, 0], transG: [1, 0, 0, 0], transH: [0, 0, 0, 0] };

    events.function('layerAnim.transitionParams', (splat: Splat) => {
        const state = states.get(splat);
        const result = state?.track.buildAt(currentFrame);
        if (!result || result.build >= 1) return NO_TRANSITION;
        const { transition: t, build } = result;

        const bound = splat.worldBound;
        const c = bound.center;
        const e = bound.halfExtents;
        const a = AXES[t.axis];
        const reach = Math.abs(a[0]) * e.x + Math.abs(a[1]) * e.y + Math.abs(a[2]) * e.z;
        const axisCenter = a[0] * c.x + a[1] * c.y + a[2] * c.z;
        const layerRadius = Math.max(1e-4, e.length());
        const origin = t.origin ?? [c.x, c.y, c.z];
        const originRadius = Math.hypot(origin[0] - c.x, origin[1] - c.y, origin[2] - c.z) + layerRadius;

        return {
            transA: [EFFECT_IDS[t.effect], build, Math.max(0.001, t.edge), t.scatter],
            transB: [origin[0], origin[1], origin[2], t.seed],
            transC: [a[0], a[1], a[2], t.flyMode === 'explode' ? 1 : 0],
            transD: [axisCenter - reach, Math.max(1e-4, 2 * reach), originRadius, t.swirl],
            transE: [layerRadius, t.pointPhase ? 1 : 0, t.glow, 0],
            transF: [t.glowColor[0], t.glowColor[1], t.glowColor[2], 0],
            // noise frequency is per layer size so the look doesn't depend on scale
            transG: [
                (t.noiseFreq ?? 3) / layerRadius,
                { noise: 0, axis: 1, radial: 2 }[t.dissolveMode ?? 'noise'],
                t.pointSize ?? 3,
                { out: 0, axis: 1, random: 2 }[t.driftMode ?? 'out']
            ],
            transH: [t.pointTint ?? 0.6, t.noiseAmount ?? 0.5, 0, 0]
        };
    });

    events.function('docSerialize.pointCloud', () => ({ ...points }));

    events.function('docDeserialize.pointCloud', (doc: any) => {
        if (doc) events.fire('layerAnim.setPoints', doc);
    });
};

export { registerLayerAnimEvents, TRANSITION_LABELS, LayerAnimTrack, LayerState, LayerKey, LayerRenderMode, PointCloudSettings, Transition, TransitionEffect, TransitionEasing, TransitionAxis };
