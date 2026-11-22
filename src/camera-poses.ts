import { Vec3 } from 'playcanvas';

import { CubicSpline } from './anim/spline';
import { AnimTrack } from './anim-track';
import { applyModifierOffset, buildModifierTables, MODIFIER_DEFAULTS, modifierOffset, removeModifierOffset, type ModifierOffset, type ModifierTables, type ModifierValues } from './camera-modifier';
import { AnimTrackEditOp } from './edit-ops';
import { Events } from './events';
import { i18n } from './ui/localization';

// a resolved camera key (export, gizmos, path editing): every channel filled
type Pose = {
    name: string,
    frame: number,
    position: Vec3,
    target: Vec3,
    fov?: number
};

// an evaluated camera pose
type PoseValue = {
    position: Vec3,
    target: Vec3,
    fov: number,
    focus?: number,
    aperture?: number
};

// the animatable properties of a shot camera. Position and target (the
// look-at point, shown as rotation) place the camera, fov is the lens, focus
// and aperture drive the depth of field. bob / stepRate / shake / shakeRate
// drive the procedural gait bob and handheld shake (src/camera-modifier.ts)
type CameraChannel = 'position' | 'target' | 'fov' | 'focus' | 'aperture' | 'bob' | 'stepRate' | 'shake' | 'shakeRate';
const CAMERA_CHANNELS: CameraChannel[] = ['position', 'target', 'fov', 'focus', 'aperture', 'bob', 'stepRate', 'shake', 'shakeRate'];
const MODIFIER_CHANNELS: CameraChannel[] = ['bob', 'stepRate', 'shake', 'shakeRate'];

// one key; like layer keys, a key only animates the channels it carries
type CameraKey = {
    frame: number,
    position?: Vec3,
    target?: Vec3,
    fov?: number,
    focus?: number,
    aperture?: number,
    bob?: number,
    stepRate?: number,
    shake?: number,
    shakeRate?: number,
    // bezier handles of the position path at this key (offsets from the key
    // position, world units): the curve leaves along handleOut and arrives
    // against handleIn. Absent = automatic tangent (timeline smoothness)
    handleIn?: Vec3,
    handleOut?: Vec3
};

// the camera's values where a channel has no keys
type CameraBase = {
    position: Vec3 | null,
    target: Vec3 | null,
    fov: number,
    focus: number,
    aperture: number,
    bob: number,
    stepRate: number,
    shake: number,
    shakeRate: number
};

// what a key button shows for a channel at a frame
type ChannelState = 'static' | 'animated' | 'keyed' | 'changed';

type ChannelValue = Vec3 | number;

type ChannelEvaluator = (frame: number, out: number[]) => void;

const cloneValue = (v: ChannelValue) => (typeof v === 'number' ? v : v.clone());

const cloneKey = (k: CameraKey): CameraKey => {
    const out: CameraKey = { frame: k.frame };
    for (const c of CAMERA_CHANNELS) {
        if (k[c] !== undefined) (out as any)[c] = cloneValue(k[c]);
    }
    if (k.handleIn && k.handleOut) {
        out.handleIn = k.handleIn.clone();
        out.handleOut = k.handleOut.clone();
    }
    return out;
};

const cloneBase = (b: CameraBase): CameraBase => ({
    position: b.position?.clone() ?? null,
    target: b.target?.clone() ?? null,
    fov: b.fov,
    focus: b.focus,
    aperture: b.aperture,
    bob: b.bob ?? MODIFIER_DEFAULTS.bob,
    stepRate: b.stepRate ?? MODIFIER_DEFAULTS.stepRate,
    shake: b.shake ?? MODIFIER_DEFAULTS.shake,
    shakeRate: b.shakeRate ?? MODIFIER_DEFAULTS.shakeRate
});

const toArray = (v: ChannelValue) => (typeof v === 'number' ? [v] : [v.x, v.y, v.z]);

/**
 * Keyframe track of one shot camera. Every channel interpolates on its own
 * cubic spline through the keys that carry it; a channel without keys holds
 * the camera's base value.
 *
 * Values edited at the current frame without a key (panel edits, navigating
 * the viewport while looking through the camera) are held as an override
 * until the frame changes or they are keyed: the key button then shows them
 * as changed.
 *
 * The track does not drive the editor camera itself - it only answers
 * getPoseAt(frame). Which camera the viewport follows is decided by the
 * camera rig below (free / look through / cut).
 */
class CameraAnimTrack implements AnimTrack {
    private keyList: CameraKey[] = [];
    base: CameraBase;
    private override: Partial<Record<CameraChannel, ChannelValue>> = {};
    private overrideFrame = -1;
    private events: Events;
    private evaluators = new Map<CameraChannel, ChannelEvaluator>();
    private handles: { off: () => void }[] = [];

    constructor(events: Events) {
        this.events = events;
        const fov = events.functions.has('camera.fov') ? events.invoke('camera.fov') : 60;
        this.base = { position: null, target: null, fov: fov ?? 60, focus: 5, aperture: 0.05, ...MODIFIER_DEFAULTS };

        // rebuild the splines when timeline parameters change
        const rebuild = () => this.rebuildSpline();
        this.handles.push(events.on('timeline.frames', rebuild));
        this.handles.push(events.on('timeline.smoothness', rebuild));
        this.handles.push(events.on('timeline.loop', rebuild));
        // the modifier's phase is integrated over seconds and metres
        const invalidate = () => {
            this.modifierTables = null;
        };
        this.handles.push(events.on('timeline.frameRate', invalidate));
        this.handles.push(events.on('sceneScale.changed', invalidate));
    }

    destroy() {
        this.handles.forEach(h => h.off());
        this.handles = [];
    }

    get keys(): readonly number[] {
        return this.keyList.map(k => k.frame);
    }

    get keyData(): readonly CameraKey[] {
        return this.keyList;
    }

    // frames of the keys carrying channel
    channelKeys(channel: CameraChannel): number[] {
        return this.keyList.filter(k => k[channel] !== undefined).map(k => k.frame);
    }

    isAnimated(channel: CameraChannel) {
        return this.keyList.some(k => k[channel] !== undefined);
    }

    // the camera has a place in the scene (keyed or set once)
    get placed() {
        return this.base.position !== null || this.isAnimated('position');
    }

    private overrideAt(channel: CameraChannel, frame: number) {
        return frame === this.overrideFrame ? this.override[channel] : undefined;
    }

    hasOverride(frame: number) {
        return frame === this.overrideFrame && Object.keys(this.override).length > 0;
    }

    channelState(channel: CameraChannel, frame: number): ChannelState {
        if (this.overrideAt(channel, frame) !== undefined) return 'changed';
        if (this.keyList.some(k => k.frame === frame && k[channel] !== undefined)) return 'keyed';
        return this.isAnimated(channel) ? 'animated' : 'static';
    }

    // keyed / interpolated value, else the base value (no override)
    private evaluated(channel: CameraChannel, frame: number): ChannelValue | null {
        const evaluator = this.evaluators.get(channel);
        if (evaluator) {
            const out: number[] = [];
            evaluator(frame, out);
            return channel === 'position' || channel === 'target' ? new Vec3(out[0], out[1], out[2]) : out[0];
        }
        const b = this.base[channel];
        return b === null ? null : cloneValue(b);
    }

    // the value the camera has at frame, including an unkeyed edit
    value(channel: CameraChannel, frame: number): ChannelValue | null {
        const o = this.overrideAt(channel, frame);
        return o !== undefined ? cloneValue(o) : this.evaluated(channel, frame);
    }

    // edit a value at frame: an animated channel holds it as an override
    // (unkeyed change), a static one changes the base value. Returns true
    // when the edit is pending (needs a key to stay)
    setValue(channel: CameraChannel, value: ChannelValue, frame: number): boolean {
        let pending = false;
        if (this.isAnimated(channel)) {
            if (this.overrideFrame !== frame) {
                this.override = {};
                this.overrideFrame = frame;
            }
            this.override[channel] = cloneValue(value);
            pending = true;
        } else {
            (this.base as any)[channel] = cloneValue(value);
            this.modifierTables = null;
        }
        this.events.fire('track.changed', this);
        this.events.fire('camera.valuesChanged', this);
        return pending;
    }

    // drop unkeyed edits (e.g. Escape / revert)
    clearOverride() {
        if (Object.keys(this.override).length === 0) return;
        this.override = {};
        this.events.fire('track.changed', this);
        this.events.fire('camera.valuesChanged', this);
    }

    private viewTransform() {
        const pose = this.events.invoke('camera.getPose');
        if (!pose) return null;
        const view = {
            position: new Vec3(pose.position.x, pose.position.y, pose.position.z),
            target: new Vec3(pose.target.x, pose.target.y, pose.target.z)
        };
        // looking through this camera, the view carries its gait bob and
        // shake: keys hold the path without them
        const followed = this.events.functions.has('shotCameras.followed') ? this.events.invoke('shotCameras.followed') : null;
        if (followed?.track === this) {
            const frame = this.events.invoke('timeline.frame') ?? 0;
            this.unmodify(frame, view.position, view.target);
        }
        return view;
    }

    // merge channels into the key at frame
    private setKey(frame: number, values: Partial<Record<CameraChannel, ChannelValue>>) {
        let key = this.keyList.find(k => k.frame === frame);
        const isNew = !key;
        if (!key) {
            key = { frame };
            this.keyList.push(key);
            this.keyList.sort((a, b) => a.frame - b.frame);
        }
        for (const c of CAMERA_CHANNELS) {
            if (values[c] !== undefined) {
                (key as any)[c] = cloneValue(values[c]);
                if (frame === this.overrideFrame) delete this.override[c];
            }
        }
        this.rebuildSpline();
        this.events.fire(isNew ? 'track.keyAdded' : 'track.keyUpdated', frame);
        this.events.fire('camera.valuesChanged', this);
    }

    // key one channel with its current value; position / target of a camera
    // that was never placed come from the viewport
    keyChannel(channel: CameraChannel, frame: number): boolean {
        let value = this.value(channel, frame);
        if (value === null) {
            const view = this.viewTransform();
            if (!view) return false;
            value = channel === 'position' ? view.position : view.target;
        }
        this.setKey(frame, { [channel]: value });
        return true;
    }

    // remove one channel from the key at frame. Removing a channel's last
    // key keeps its value as the base, so the camera does not jump
    removeChannelKey(channel: CameraChannel, frame: number): boolean {
        const key = this.keyList.find(k => k.frame === frame);
        if (!key || key[channel] === undefined) return false;
        if (this.channelKeys(channel).length === 1) {
            (this.base as any)[channel] = cloneValue(key[channel]);
        }
        delete key[channel];
        if (!CAMERA_CHANNELS.some(c => key[c] !== undefined)) {
            this.keyList.splice(this.keyList.indexOf(key), 1);
        }
        this.rebuildSpline();
        this.events.fire('track.keyRemoved', frame);
        this.events.fire('camera.valuesChanged', this);
        return true;
    }

    moveChannelKey(channel: CameraChannel, fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;
        const key = this.keyList.find(k => k.frame === fromFrame);
        if (!key || key[channel] === undefined) return false;
        const value = key[channel];
        const handles = channel === 'position' && key.handleIn && key.handleOut ? [key.handleIn, key.handleOut] : null;
        delete key[channel];
        if (channel === 'position') {
            delete key.handleIn;
            delete key.handleOut;
        }
        if (!CAMERA_CHANNELS.some(c => key[c] !== undefined)) {
            this.keyList.splice(this.keyList.indexOf(key), 1);
        }
        this.setKey(toFrame, { [channel]: value });
        if (handles) {
            const moved = this.keyList.find(k => k.frame === toFrame);
            if (moved) {
                moved.handleIn = handles[0];
                moved.handleOut = handles[1];
                this.rebuildSpline();
            }
        }
        this.events.fire('track.keyMoved', fromFrame, toFrame);
        return true;
    }

    // the timeline's key button: the view (position + target from the
    // viewport, which is the camera itself while looking through it) plus
    // every other channel that is animated or was changed
    addKey(frame: number): boolean {
        const view = this.viewTransform();
        if (!view) return false;
        const values: Partial<Record<CameraChannel, ChannelValue>> = { position: view.position, target: view.target };
        for (const c of CAMERA_CHANNELS.filter(c => c !== 'position' && c !== 'target')) {
            if (this.isAnimated(c) || this.overrideAt(c, frame) !== undefined) {
                values[c] = this.value(c, frame);
            }
        }
        this.setKey(frame, values);
        return true;
    }

    // which channels addKey keys, for the timeline label
    addKeyChannels(frame: number): CameraChannel[] {
        return CAMERA_CHANNELS.filter(c => c === 'position' || c === 'target' || this.isAnimated(c) || this.overrideAt(c, frame) !== undefined);
    }

    removeKey(frame: number): boolean {
        const index = this.keyList.findIndex(k => k.frame === frame);
        if (index === -1) return false;
        // channels losing their last key keep the value as base
        const key = this.keyList[index];
        for (const c of CAMERA_CHANNELS) {
            if (key[c] !== undefined && this.channelKeys(c).length === 1) (this.base as any)[c] = cloneValue(key[c]);
        }
        this.keyList.splice(index, 1);
        this.rebuildSpline();
        this.events.fire('track.keyRemoved', frame);
        this.events.fire('camera.valuesChanged', this);
        return true;
    }

    moveKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;
        const key = this.keyList.find(k => k.frame === fromFrame);
        if (!key) return false;
        this.keyList = this.keyList.filter(k => k.frame !== toFrame);
        key.frame = toFrame;
        this.keyList.sort((a, b) => a.frame - b.frame);
        this.rebuildSpline();
        this.events.fire('track.keyMoved', fromFrame, toFrame);
        return true;
    }

    copyKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;
        const source = this.keyList.find(k => k.frame === fromFrame);
        if (!source) return false;
        this.keyList = this.keyList.filter(k => k.frame !== toFrame);
        this.keyList.push({ ...cloneKey(source), frame: toFrame });
        this.keyList.sort((a, b) => a.frame - b.frame);
        this.rebuildSpline();
        this.events.fire('track.keyAdded', toFrame);
        return true;
    }

    // the pose at frame (fractional frames allowed), or null when the camera
    // has no place yet
    getPoseAt(frame: number, out?: PoseValue): PoseValue | null {
        const position = this.value('position', frame) as Vec3 | null;
        if (!position) return null;
        const target = (this.value('target', frame) as Vec3 | null) ?? new Vec3(position.x, position.y, position.z - 1);
        const result = out ?? { position: new Vec3(), target: new Vec3(), fov: 0 };
        result.position.copy(position);
        result.target.copy(target);
        result.fov = this.value('fov', frame) as number;
        result.focus = this.value('focus', frame) as number;
        result.aperture = this.value('aperture', frame) as number;
        return result;
    }

    clear(): void {
        this.keyList.length = 0;
        this.override = {};
        this.rebuildSpline();
        this.events.fire('track.keysCleared');
    }

    // procedural gait bob / handheld shake (src/camera-modifier.ts)

    private modifierTables: ModifierTables | null = null;

    private modifierScratch: ModifierOffset = { offset: new Vec3(), yaw: 0, pitch: 0 };

    // the camera has a gait bob or a handheld shake somewhere
    get hasModifier() {
        const on = (c: 'bob' | 'shake') => this.base[c] > 0 || this.keyList.some(k => (k[c] ?? 0) > 0) || ((this.override[c] as number) ?? 0) > 0;
        return on('bob') || on('shake');
    }

    private modifierValues(frame: number): ModifierValues {
        return {
            bob: this.value('bob', frame) as number,
            stepRate: this.value('stepRate', frame) as number,
            shake: this.value('shake', frame) as number,
            shakeRate: this.value('shakeRate', frame) as number
        };
    }

    private tables(): ModifierTables {
        const frames = Math.max(1, Math.floor(this.events.invoke('timeline.frames') ?? 1));
        if (this.modifierTables && this.modifierTables.frames === frames) return this.modifierTables;
        const fps = this.events.invoke('timeline.frameRate') ?? 30;
        const mpu = this.events.functions.has('sceneScale.metersPerUnit') ? this.events.invoke('sceneScale.metersPerUnit') : 1;
        this.modifierTables = buildModifierTables({
            value: (channel, f) => this.evaluated(channel, f) as number,
            position: (f, out) => {
                const p = this.evaluated('position', f) as Vec3 | null;
                if (!p) return false;
                out.copy(p);
                return true;
            }
        }, frames, fps, mpu);
        return this.modifierTables;
    }

    // the modifier at frame for the pose, null when it is off there
    private modifierAt(frame: number, position: Vec3, target: Vec3): ModifierOffset | null {
        const values = this.modifierValues(frame);
        if (!(values.bob > 0) && !(values.shake > 0)) return null;
        const forward = new Vec3().sub2(target, position);
        return modifierOffset(values, this.tables(), frame, forward, this.modifierScratch);
    }

    /**
     * The final pose at frame: the keyed path plus the gait bob and handheld
     * shake. Used wherever the camera is seen (viewport following, playback,
     * video and player export); getPoseAt stays the clean path for editing.
     */
    getShotPoseAt(frame: number, out?: PoseValue): PoseValue | null {
        const pose = this.getPoseAt(frame, out);
        if (!pose) return null;
        const m = this.modifierAt(frame, pose.position, pose.target);
        if (m) applyModifierOffset(pose.position, pose.target, m);
        return pose;
    }

    // take the modifier at frame back out of a view (in place)
    unmodify(frame: number, position: Vec3, target: Vec3) {
        const m = this.modifierAt(frame, position, target);
        if (m) removeModifierOffset(position, target, m);
    }

    // move the position and/or target of the key at frame (viewport path
    // editing, src/tools/camera-path-tool.ts)
    setKeyPose(frame: number, position: Vec3 | null, target: Vec3 | null): boolean {
        const key = this.keyList.find(k => k.frame === frame);
        if (!key) return false;
        if (position) key.position = position.clone();
        if (target) key.target = target.clone();
        this.rebuildSpline();
        this.events.fire('track.keyUpdated', frame);
        return true;
    }

    /**
     * The bezier handles of the position path at the key at frame: custom
     * ones, or the automatic tangents the spline uses there. Null when the
     * key has no position or the path has fewer than two position keys.
     */
    getHandles(frame: number): { handleIn: Vec3, handleOut: Vec3, custom: boolean } | null {
        const key = this.keyList.find(k => k.frame === frame);
        if (!key || !key.position) return null;
        if (key.handleIn && key.handleOut) {
            return { handleIn: key.handleIn.clone(), handleOut: key.handleOut.clone(), custom: true };
        }
        const tangents = this.positionTangents.get(frame);
        if (!tangents) return null;
        return { handleIn: tangents[0].clone(), handleOut: tangents[1].clone(), custom: false };
    }

    // set (both) or clear (null) the bezier handles of the key at frame
    setHandles(frame: number, handleIn: Vec3 | null, handleOut: Vec3 | null): boolean {
        const key = this.keyList.find(k => k.frame === frame);
        if (!key || !key.position) return false;
        if (handleIn && handleOut) {
            key.handleIn = handleIn.clone();
            key.handleOut = handleOut.clone();
        } else {
            if (!key.handleIn) return false;
            delete key.handleIn;
            delete key.handleOut;
        }
        this.rebuildSpline();
        this.events.fire('track.keyUpdated', frame);
        return true;
    }

    // does any key carry custom handles (the viewer export bakes those)
    get hasHandles() {
        return this.keyList.some(k => k.handleIn && k.handleOut);
    }

    // insert a transform key with an explicit pose (e.g. the interpolated
    // one, so the path keeps its shape)
    insertKey(frame: number, pose: PoseValue): boolean {
        if (this.keyList.some(k => k.frame === frame)) return false;
        this.setKey(frame, { position: pose.position, target: pose.target });
        return true;
    }

    snapshot() {
        return { keys: this.keyList.map(cloneKey), base: cloneBase(this.base) };
    }

    restore(snapshot: unknown): void {
        const s = snapshot as { keys: CameraKey[], base: CameraBase };
        this.keyList = s.keys.map(cloneKey);
        this.base = cloneBase(s.base);
        this.override = {};
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
        this.events.fire('camera.valuesChanged', this);
    }

    /**
     * The transform keys as full poses (viewer export, gizmos, path editing).
     */
    getPoses(): Pose[] {
        return this.keyList
        .filter(k => k.position !== undefined || k.target !== undefined)
        .map((k, i) => {
            const pose = this.getPoseAt(k.frame);
            return {
                name: `camera_${i}`,
                frame: k.frame,
                position: k.position?.clone() ?? pose.position.clone(),
                target: k.target?.clone() ?? pose.target.clone(),
                fov: pose.fov
            };
        });
    }

    /**
     * Load keys (and optionally base values) from serialized data.
     */
    loadKeys(keys: CameraKey[], base?: Partial<CameraBase>) {
        this.keyList = keys.map(cloneKey).sort((a, b) => a.frame - b.frame);
        if (base) this.base = cloneBase({ ...this.base, ...base } as CameraBase);
        this.override = {};
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
        this.events.fire('camera.valuesChanged', this);
    }

    // the old api: full poses at frames
    loadPoses(posesData: Pose[]): void {
        const defaultFov = this.events.invoke('camera.fov');
        this.loadKeys(posesData.map(p => ({ frame: p.frame, position: p.position, target: p.target, fov: p.fov ?? defaultFov })));
    }

    serialize() {
        return {
            base: {
                position: this.base.position ? toArray(this.base.position) : null,
                target: this.base.target ? toArray(this.base.target) : null,
                fov: this.base.fov,
                focus: this.base.focus,
                aperture: this.base.aperture,
                bob: this.base.bob,
                stepRate: this.base.stepRate,
                shake: this.base.shake,
                shakeRate: this.base.shakeRate
            },
            keys: this.keyList.map((k) => {
                const out: any = { frame: k.frame };
                for (const c of CAMERA_CHANNELS) {
                    if (k[c] !== undefined) out[c] = typeof k[c] === 'number' ? k[c] : toArray(k[c]);
                }
                if (k.handleIn && k.handleOut) {
                    out.handleIn = toArray(k.handleIn);
                    out.handleOut = toArray(k.handleOut);
                }
                return out;
            })
        };
    }

    // automatic position tangents per key frame, as bezier handle offsets
    // [in, out] (src/tools/camera-path-tool.ts shows them)
    private positionTangents = new Map<number, [Vec3, Vec3]>();

    private rebuildSpline(): void {
        const duration = this.events.invoke('timeline.frames');
        const smoothness = this.events.invoke('timeline.smoothness');
        const loop = this.events.invoke('timeline.loop');

        this.evaluators.clear();
        this.positionTangents.clear();
        this.modifierTables = null;
        for (const channel of CAMERA_CHANNELS) {
            const keys = this.keyList.filter(k => k[channel] !== undefined && k.frame < duration);
            if (keys.length === 0) continue;
            if (keys.length === 1) {
                const v = toArray(keys[0][channel]);
                this.evaluators.set(channel, (frame, out) => {
                    for (let i = 0; i < v.length; i++) out[i] = v[i];
                });
                continue;
            }
            const times = keys.map(k => k.frame);
            const points: number[] = [];
            keys.forEach(k => points.push(...toArray(k[channel])));
            // when not looping the spline clamps, holding the first/last value
            // beyond the outer keys instead of wrapping the end into the start
            const spline = loop ?
                CubicSpline.fromPointsLooping(duration, times, points, smoothness) :
                CubicSpline.fromPoints(times, points, smoothness);
            if (channel === 'position') this.applyHandles(spline, keys, loop);
            this.evaluators.set(channel, (frame, out) => spline.evaluate(frame, out));
        }

        this.events.fire('track.changed', this);
    }

    // bezier handles -> hermite tangents of the position spline. The knot
    // tangents are derivatives over a whole segment (t 0..1), so a bezier
    // handle h (control point = key + h) is a tangent of 3h: out = 3 * out
    // handle, in = -3 * in handle. The looping spline repeats the outer keys
    // (two before, two after), those copies get the same handles
    private applyHandles(spline: CubicSpline, keys: CameraKey[], loop: boolean) {
        const n = keys.length;
        const { knots } = spline;
        const indices = (k: number) => {
            if (!loop || n < 2) return [k];
            const list = [k + 2];
            if (k >= n - 2) list.push(k - (n - 2));
            if (k <= 1) list.push(n + 2 + k);
            return list;
        };
        keys.forEach((key, k) => {
            const knotIndex = indices(k)[0];
            const at = (j: number, slot: number) => knots[(knotIndex * 3 + j) * 3 + slot];
            if (key.handleIn && key.handleOut) {
                const hin = toArray(key.handleIn);
                const hout = toArray(key.handleOut);
                for (const index of indices(k)) {
                    for (let j = 0; j < 3; j++) {
                        knots[(index * 3 + j) * 3] = -3 * hin[j];
                        knots[(index * 3 + j) * 3 + 2] = 3 * hout[j];
                    }
                }
            }
            this.positionTangents.set(key.frame, [
                new Vec3(-at(0, 0) / 3, -at(1, 0) / 3, -at(2, 0) / 3),
                new Vec3(at(0, 2) / 3, at(1, 2) / 3, at(2, 2) / 3)
            ]);
        });
    }
}

// a hard-cut segment: frames [start, end) are shown through camera cameraId
type CutSegment = {
    start: number,
    end: number,
    cameraId: number,
    // cross-fade from the previous camera over the first `fade` frames
    fade?: number
};

// a cross-fade in progress: mix `alpha` of camera `to` over camera `from`
type CutFade = {
    from: number,
    to: number,
    alpha: number
};

/**
 * The cut track: a list of non-overlapping segments mapping frame ranges to
 * shot cameras. Undo goes through AnimTrackEditOp (snapshot / restore).
 */
class CutTrack {
    private events: Events;
    segments: CutSegment[] = [];

    constructor(events: Events) {
        this.events = events;
    }

    // place a segment, trimming or splitting whatever it overlaps
    set(start: number, end: number, cameraId: number): boolean {
        if (end <= start) return false;
        const result: CutSegment[] = [];
        // a segment re-placed on an existing cut keeps that cut's fade
        const fade = this.segments.find(s => s.start === start)?.fade;
        for (const s of this.segments) {
            if (s.end <= start || s.start >= end) {
                result.push(s);
                continue;
            }
            if (s.start < start) result.push({ start: s.start, end: start, cameraId: s.cameraId, fade: s.fade });
            if (s.end > end) result.push({ start: end, end: s.end, cameraId: s.cameraId });
        }
        result.push({ start, end, cameraId, fade });
        this.segments = this.normalize(result);
        this.changed();
        return true;
    }

    // move one edge of the segment at frame to `to` (the edge frame: start,
    // or end exclusive). A neighbour touching that edge moves along (a roll
    // edit, the cut point shifts); otherwise the edge stops at the neighbour
    trim(frame: number, edge: 'start' | 'end', to: number): boolean {
        const segment = this.segmentAt(frame);
        if (!segment) return false;
        const sorted = this.segments.slice().sort((a, b) => a.start - b.start);
        const index = sorted.indexOf(segment);
        const prev = sorted[index - 1];
        const next = sorted[index + 1];
        let value = Math.round(to);
        if (edge === 'end') {
            const max = next ? (next.start === segment.end ? next.end - 1 : next.start) : Number.MAX_SAFE_INTEGER;
            value = Math.max(segment.start + 1, Math.min(max, value));
            if (value === segment.end) return false;
            if (next && next.start === segment.end) next.start = value;
            segment.end = value;
        } else {
            const min = prev ? (prev.end === segment.start ? prev.start + 1 : prev.end) : 0;
            value = Math.min(segment.end - 1, Math.max(min, value));
            if (value === segment.start) return false;
            if (prev && prev.end === segment.start) prev.end = value;
            segment.start = value;
            // a fade cannot be longer than its segment
            if (segment.fade) segment.fade = Math.min(segment.fade, segment.end - segment.start) || undefined;
        }
        this.segments = this.normalize(this.segments);
        this.changed();
        return true;
    }

    setCamera(frame: number, cameraId: number): boolean {
        const segment = this.segmentAt(frame);
        if (!segment || segment.cameraId === cameraId) return false;
        segment.cameraId = cameraId;
        this.segments = this.normalize(this.segments);
        this.changed();
        return true;
    }

    // cut to cameraId at frame, lasting up to the next cut (or the end)
    cutTo(frame: number, cameraId: number, frames: number): boolean {
        const segment = this.segmentAt(frame);
        if (segment) {
            if (segment.start === frame) return this.setCamera(frame, cameraId);
            if (segment.cameraId === cameraId) return false;
            return this.set(frame, segment.end, cameraId);
        }
        const next = this.segments.filter(s => s.start > frame).sort((a, b) => a.start - b.start)[0];
        return this.set(frame, next ? next.start : Math.max(frame + 1, frames), cameraId);
    }

    removeAt(frame: number): boolean {
        const index = this.segments.findIndex(s => frame >= s.start && frame < s.end);
        if (index === -1) return false;
        this.segments.splice(index, 1);
        this.changed();
        return true;
    }

    removeCamera(cameraId: number) {
        const before = this.segments.length;
        this.segments = this.segments.filter(s => s.cameraId !== cameraId);
        if (this.segments.length !== before) this.changed();
    }

    // the camera shown just before this segment, if it differs: only then is
    // the segment start a cut that can fade
    cutFrom(segment: CutSegment): number | null {
        if (segment.start <= 0) return null;
        const from = this.cameraAt(segment.start - 1);
        return from !== null && from !== segment.cameraId ? from : null;
    }

    setFade(frame: number, fade: number): boolean {
        const segment = this.segmentAt(frame);
        if (!segment || this.cutFrom(segment) === null) return false;
        const value = Math.max(0, Math.min(Math.round(fade), segment.end - segment.start));
        if ((segment.fade ?? 0) === value) return false;
        segment.fade = value || undefined;
        this.changed();
        return true;
    }

    // linear cross-fade at time: the first fade frame already shows a little
    // of the new camera, the frame after the fade shows only the new one
    fadeAt(time: number): CutFade | null {
        const segment = this.segmentAt(Math.floor(time + 1e-4));
        if (!segment?.fade) return null;
        const from = this.cutFrom(segment);
        if (from === null) return null;
        const alpha = (time - segment.start + 1) / (segment.fade + 1);
        return alpha < 1 ? { from, to: segment.cameraId, alpha } : null;
    }

    segmentAt(frame: number): CutSegment | null {
        return this.segments.find(s => frame >= s.start && frame < s.end) ?? null;
    }

    // the camera shown at frame: the containing segment, else the last
    // segment before it (holds through gaps), else the first segment
    cameraAt(time: number): number | null {
        if (this.segments.length === 0) return null;
        // render export accumulates 1/fps steps, so frame 90 can arrive as
        // 89.99999 - snap to the frame a hard cut is defined on
        const frame = Math.floor(time + 1e-4);
        let result = this.segments[0].cameraId;
        for (const s of this.segments) {
            if (s.start <= frame) result = s.cameraId;
            if (frame >= s.start && frame < s.end) return s.cameraId;
        }
        return result;
    }

    clear() {
        this.segments = [];
        this.changed();
    }

    snapshot(): CutSegment[] {
        return this.segments.map(s => ({ ...s }));
    }

    restore(snapshot: unknown) {
        this.segments = (snapshot as CutSegment[]).map(s => ({ ...s }));
        this.changed();
    }

    private normalize(segments: CutSegment[]) {
        // sort and merge touching segments of the same camera
        const sorted = segments.filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
        const merged: CutSegment[] = [];
        for (const s of sorted) {
            const last = merged[merged.length - 1];
            if (last && last.cameraId === s.cameraId && last.end === s.start) {
                last.end = s.end;
            } else {
                merged.push({ ...s });
            }
        }
        return merged;
    }

    private changed() {
        this.events.fire('cut.changed', this.segments);
    }
}

// how a camera renders: a normal lens image, a 360 panorama, or a stereo
// 360 panorama for VR headsets (top / bottom)
type CameraProjection = 'standard' | 'equirect' | 'stereo';

type ShotCamera = {
    id: number,
    name: string,
    color: [number, number, number],
    track: CameraAnimTrack,
    projection: CameraProjection,
    // stereo eye separation in scene units (6.4 cm in a metric scene)
    ipd: number
};

// what the viewport follows while the timeline moves: nothing (free editor
// camera), the selected shot camera, or the cut track
type CameraViewMode = 'free' | 'camera' | 'cut';

const PALETTE: [number, number, number][] = [
    [0, 220, 255],
    [255, 170, 0],
    [120, 255, 90],
    [255, 80, 200],
    [255, 240, 80],
    [150, 120, 255],
    [255, 90, 90],
    [80, 255, 210]
];

/**
 * Register the shot cameras, the cut track and the camera rig.
 */
const registerCameraPosesEvents = (events: Events) => {
    const cameras: ShotCamera[] = [];
    // every camera created since the last clear, removed ones included: undo
    // brings a removed camera back as the same object, so key edits in the
    // history still point at its track
    const pool = new Map<number, ShotCamera>();
    let nextId = 1;
    let selectedId = 0;
    // free by default: looking through a camera without keys would jump the
    // view somewhere arbitrary
    let viewMode: CameraViewMode = 'free';
    // export override: forces the rig onto one camera or the cut while
    // rendering, independent of the interactive view mode
    let override: { mode: 'camera' | 'cut', cameraId?: number } | null = null;
    let currentFrame = 0;

    const cut = new CutTrack(events);

    const byId = (id: number) => cameras.find(c => c.id === id) ?? null;
    const selected = () => byId(selectedId) ?? cameras[0] ?? null;

    const nextName = () => {
        const taken = new Set(cameras.map(c => c.name));
        let n = cameras.length + 1;
        while (taken.has(i18n.t('sm.cameras.default-name', { n }))) n++;
        return i18n.t('sm.cameras.default-name', { n });
    };

    const nextColor = (): [number, number, number] => {
        const used = new Set(cameras.map(c => c.color.join(',')));
        return PALETTE.find(c => !used.has(c.join(','))) ?? PALETTE[cameras.length % PALETTE.length];
    };

    // which camera the viewport follows right now, or null for none
    const followedCamera = (frame: number): ShotCamera | null => {
        const mode = override?.mode ?? viewMode;
        if (mode === 'camera') {
            return override?.cameraId !== undefined ? byId(override.cameraId) : selected();
        }
        if (mode === 'cut') {
            const id = cut.cameraAt(frame);
            return id !== null ? byId(id) : selected();
        }
        return null;
    };

    const tmpPose: PoseValue = { position: new Vec3(), target: new Vec3(), fov: 0 };

    // the viewport's own lens while it is free, restored when it stops
    // following a camera (a camera's lens is not a user preference)
    let freeFov: number | null = null;

    // move the viewport to the followed camera's pose at the current frame,
    // and render the depth of field of the followed (else the selected)
    // camera
    const apply = () => {
        const camera = followedCamera(currentFrame);
        // a camera that was never placed (the start camera without keys)
        // takes the current view when the viewport looks through it, instead
        // of showing nothing
        if (camera && !camera.track.placed && !override) {
            const view = events.invoke('camera.getPose');
            camera.track.base.position = new Vec3(view.position.x, view.position.y, view.position.z);
            camera.track.base.target = new Vec3(view.target.x, view.target.y, view.target.z);
            events.fire('camera.valuesChanged', camera.track);
            events.fire('shotCameras.changed', cameras);
        }
        if (camera && camera.track.getShotPoseAt(currentFrame, tmpPose)) {
            if (freeFov === null) freeFov = events.invoke('camera.fov');
            events.fire('camera.setPose', tmpPose, 0);
        } else if (!camera && freeFov !== null) {
            const view = events.invoke('camera.getPose');
            events.fire('camera.setPose', {
                position: new Vec3(view.position.x, view.position.y, view.position.z),
                target: new Vec3(view.target.x, view.target.y, view.target.z),
                fov: freeFov
            }, 0);
            freeFov = null;
        }
        const lens = camera ?? selected();
        if (lens) {
            events.fire('dof.lens', {
                focus: lens.track.value('focus', currentFrame),
                aperture: lens.track.value('aperture', currentFrame)
            });
        }
    };

    const changed = () => {
        events.fire('shotCameras.changed', cameras);
        // the active track (and so the timeline's keys) may have switched
        events.fire('track.keysLoaded');
        apply();
    };

    const create = (name?: string, color?: [number, number, number], id?: number) => {
        const camera: ShotCamera = {
            id: id ?? nextId,
            name: name ?? nextName(),
            color: color ?? nextColor(),
            track: new CameraAnimTrack(events),
            projection: 'standard',
            ipd: 0.064
        };
        nextId = Math.max(nextId, camera.id + 1);
        cameras.push(camera);
        pool.set(camera.id, camera);
        return camera;
    };

    const removeAll = () => {
        pool.forEach(c => c.track.destroy());
        pool.clear();
        cameras.length = 0;
    };

    // undo of list edits (add, duplicate, remove, rename): the snapshot holds
    // which cameras exist, their names and colors, the selection and the cut;
    // the keys stay on the tracks and have their own undo
    type RigSnapshot = {
        cameras: { id: number, name: string, color: [number, number, number], projection: CameraProjection, ipd: number }[],
        selectedId: number,
        cut: CutSegment[]
    };

    const rig = {
        snapshot: (): RigSnapshot => ({
            cameras: cameras.map(c => ({ id: c.id, name: c.name, color: c.color, projection: c.projection, ipd: c.ipd })),
            selectedId,
            cut: cut.snapshot()
        }),
        restore: (snapshot: unknown) => {
            const snap = snapshot as RigSnapshot;
            cameras.length = 0;
            snap.cameras.forEach((entry) => {
                const camera = pool.get(entry.id);
                if (!camera) return;
                camera.name = entry.name;
                camera.color = entry.color;
                camera.projection = entry.projection ?? 'standard';
                camera.ipd = entry.ipd ?? 0.064;
                cameras.push(camera);
            });
            selectedId = snap.selectedId;
            cut.restore(snap.cut);
            changed();
        }
    };

    const recordEdit = (name: string, edit: () => void) => {
        const before = rig.snapshot();
        edit();
        events.fire('edit.add', new AnimTrackEditOp(name, rig, before, rig.snapshot()), true);
    };

    events.on('timeline.time', (time: number) => {
        currentFrame = time;
        apply();
    });

    events.on('timeline.frame', (frame: number) => {
        currentFrame = frame;
        apply();
    });

    // a key edit re-evaluates the followed camera so the view updates at once
    events.on('track.changed', (track: CameraAnimTrack) => {
        if (followedCamera(currentFrame)?.track === track || selected()?.track === track) {
            apply();
        }
    });

    events.on('camera.applyView', () => apply());

    events.on('cut.changed', () => {
        if ((override?.mode ?? viewMode) === 'cut') apply();
    });

    // start with one camera; a cleared scene resets to that
    create();
    selectedId = cameras[0].id;

    events.on('scene.clear', () => {
        removeAll();
        nextId = 1;
        selectedId = create().id;
        cut.clear();
        changed();
    });

    // shot camera api

    events.function('shotCameras.list', () => cameras);
    events.function('shotCameras.selected', () => selected());
    events.function('shotCameras.byId', (id: number) => byId(id));
    events.function('shotCameras.poseAt', (id: number, frame: number) => byId(id)?.track.getPoseAt(frame) ?? null);
    events.function('shotCameras.followed', (frame?: number) => followedCamera(frame ?? currentFrame));

    // channel editing (camera panel, viewport navigation). Key edits and
    // base value edits are undoable; a run of edits to one channel (a slider
    // drag) collapses into one undo step

    const frameNow = () => Math.round(events.invoke('timeline.frame') ?? 0);
    let lastValueEdit: { track: CameraAnimTrack, channel: CameraChannel, op: AnimTrackEditOp, time: number } | null = null;

    const trackEdit = (name: string, track: CameraAnimTrack, edit: () => boolean) => {
        const before = track.snapshot();
        if (!edit()) return false;
        lastValueEdit = null;
        events.fire('edit.add', new AnimTrackEditOp(name, track, before, track.snapshot()), true);
        return true;
    };

    const sameValue = (a: ChannelValue | null, b: ChannelValue) => {
        if (a === null) return false;
        if (typeof a === 'number' || typeof b === 'number') return Math.abs((a as number) - (b as number)) < 1e-6;
        return a.distance(b) < 1e-5;
    };

    // set channel values of a camera at the current frame. With auto key on
    // the change is keyed at once, otherwise an animated channel shows it as
    // changed until it is keyed or the frame changes
    // a viewport drag (src/tools/object-gizmo.ts): the values change many
    // times, the undo history gets one step at the end
    let gesture: { track: CameraAnimTrack, before: unknown } | null = null;
    events.on('shotCameras.gestureStart', (id?: number) => {
        const camera = byId(id ?? selectedId);
        gesture = camera ? { track: camera.track, before: camera.track.snapshot() } : null;
        lastValueEdit = null;
    });
    events.on('shotCameras.gestureEnd', () => {
        if (!gesture) return;
        const { track, before } = gesture;
        gesture = null;
        const after = track.snapshot();
        if (JSON.stringify(after) !== JSON.stringify(before)) {
            events.fire('edit.add', new AnimTrackEditOp('cameraGizmo', track, before, after), true);
        }
    });

    const setValues = (camera: ShotCamera, values: Partial<Record<CameraChannel, ChannelValue>>) => {
        const frame = frameNow();
        const track = camera.track;
        const entries = (Object.keys(values) as CameraChannel[])
        .filter(c => !sameValue(track.value(c, frame), values[c]));
        if (entries.length === 0) return;
        const autoKey = events.functions.has('track.autoKey') && events.invoke('track.autoKey');

        if (gesture && gesture.track === track) {
            entries.forEach((c) => {
                track.setValue(c, values[c], frame);
                if (autoKey) track.keyChannel(c, frame);
            });
            if (!autoKey && entries.some(c => track.isAnimated(c))) events.fire('track.markPending', track);
            return;
        }

        if (autoKey) {
            trackEdit('cameraAutoKey', track, () => {
                entries.forEach((c) => {
                    track.setValue(c, values[c], frame);
                    track.keyChannel(c, frame);
                });
                return true;
            });
            return;
        }

        const animated = entries.filter(c => track.isAnimated(c));
        const statics = entries.filter(c => !track.isAnimated(c));
        animated.forEach(c => track.setValue(c, values[c], frame));
        if (animated.length > 0) events.fire('track.markPending', track);
        if (statics.length > 0) {
            const now = performance.now();
            const channel = statics[0];
            if (lastValueEdit && lastValueEdit.track === track && lastValueEdit.channel === channel && now - lastValueEdit.time < 1000) {
                statics.forEach(c => track.setValue(c, values[c], frame));
                lastValueEdit.op.after = track.snapshot();
                lastValueEdit.time = now;
            } else {
                const before = track.snapshot();
                statics.forEach(c => track.setValue(c, values[c], frame));
                const op = new AnimTrackEditOp('cameraValue', track, before, track.snapshot());
                events.fire('edit.add', op, true);
                lastValueEdit = { track, channel, op, time: now };
            }
        }
    };

    const viewValues = () => {
        const view = events.invoke('camera.getPose');
        return {
            position: new Vec3(view.position.x, view.position.y, view.position.z),
            target: new Vec3(view.target.x, view.target.y, view.target.z)
        };
    };

    // the view as a pose of this camera: looking through it, the view
    // carries its gait bob and shake, which the keys must not
    const viewValuesFor = (camera: ShotCamera) => {
        const view = viewValues();
        if (followedCamera(currentFrame) === camera) camera.track.unmodify(currentFrame, view.position, view.target);
        return view;
    };

    events.function('shotCameras.value', (channel: CameraChannel, id?: number) => {
        return byId(id ?? selectedId)?.track.value(channel, frameNow()) ?? null;
    });

    events.function('shotCameras.channelState', (channel: CameraChannel, id?: number): ChannelState => {
        return byId(id ?? selectedId)?.track.channelState(channel, frameNow()) ?? 'static';
    });

    events.on('shotCameras.setValue', (channel: CameraChannel, value: ChannelValue, id?: number) => {
        const camera = byId(id ?? selectedId);
        if (camera) setValues(camera, { [channel]: value });
    });

    // the key button of a channel: key it, or remove the key when the frame
    // already holds an unchanged one
    events.on('shotCameras.keyChannel', (channel: CameraChannel, id?: number) => {
        const camera = byId(id ?? selectedId);
        if (!camera) return;
        const frame = frameNow();
        const state = camera.track.channelState(channel, frame);
        trackEdit(state === 'keyed' ? 'cameraUnkey' : 'cameraKey', camera.track, () => (state === 'keyed' ?
            camera.track.removeChannelKey(channel, frame) :
            camera.track.keyChannel(channel, frame)));
    });

    events.on('shotCameras.removeChannelKey', (id: number, channel: CameraChannel, frame: number) => {
        const camera = byId(id);
        if (camera) trackEdit('cameraUnkey', camera.track, () => camera.track.removeChannelKey(channel, frame));
    });

    events.on('shotCameras.moveChannelKey', (id: number, channel: CameraChannel, from: number, to: number) => {
        const camera = byId(id);
        if (camera) trackEdit('cameraMoveKey', camera.track, () => camera.track.moveChannelKey(channel, from, to));
    });

    // put the camera where the viewport looks
    events.on('shotCameras.setToView', (id?: number) => {
        const camera = byId(id ?? selectedId);
        if (camera) setValues(camera, viewValuesFor(camera));
    });

    // navigating the viewport while it looks through a camera moves that
    // camera: picked up once the view settles
    let navTimer = -1;
    events.on('camera.controller', () => {
        if (override || viewMode === 'free') return;
        if (events.functions.has('timeline.playing') && events.invoke('timeline.playing')) return;
        window.clearTimeout(navTimer);
        navTimer = window.setTimeout(() => {
            if (override || viewMode === 'free') return;
            const camera = followedCamera(currentFrame);
            if (!camera || !camera.track.placed) return;
            setValues(camera, viewValuesFor(camera));
        }, 450);
    });

    events.on('shotCameras.add', () => {
        recordEdit('shotCameras.add', () => {
            const camera = create();
            // a new camera starts where the viewport looks
            const view = viewValues();
            camera.track.base.position = view.position;
            camera.track.base.target = view.target;
            camera.track.base.fov = events.invoke('camera.fov') ?? camera.track.base.fov;
            selectedId = camera.id;
            changed();
        });
    });

    // integer, ascending, unique key frames inside [0, frames - 1] (the
    // spline drops keys at or beyond timeline.frames). A track that runs past
    // the timeline end is squeezed in time onto it - every key frame scaled
    // by (frames - 1) / lastFrame - instead of losing its end; with more keys
    // than frames, evenly picked keys stay. Negative / non-finite frames are
    // dropped, equal frames: the later key wins
    const fitKeysToFrames = (keys: CameraKey[], frames: number): CameraKey[] => {
        const byFrame = new Map<number, CameraKey>();
        (keys ?? []).forEach((key) => {
            const frame = Math.round(key.frame);
            if (!Number.isFinite(frame) || frame < 0) return;
            byFrame.set(frame, { ...key, frame });
        });
        const sorted = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
        if (frames < 1 || sorted.length === 0) return [];
        const last = frames - 1;
        const end = sorted[sorted.length - 1].frame;
        if (end <= last) return sorted;

        const picked = sorted.length <= frames ? sorted :
            Array.from({ length: frames }, (_, j) => sorted[frames === 1 ? 0 : Math.round(j * (sorted.length - 1) / (frames - 1))]);
        const scale = last / end;
        const out = picked.map(key => ({ ...key, frame: Math.round(key.frame * scale) }));
        // rounding may merge neighbours: push apart forwards, then cap
        // backwards at the end (fits, as there are at most `frames` keys)
        for (let i = 1; i < out.length; i++) {
            out[i].frame = Math.max(out[i].frame, out[i - 1].frame + 1);
        }
        for (let i = out.length - 1; i >= 0; i--) {
            out[i].frame = Math.min(out[i].frame, i === out.length - 1 ? last : out[i + 1].frame - 1);
        }
        return out;
    };

    // several new cameras with their keys (generated shots) as one undo
    // step. Keys go to integer frames inside the timeline, a longer track is
    // squeezed onto it (fitKeysToFrames); returns the new camera ids
    events.function('shotCameras.addWithKeys', (items: { name: string, keys: CameraKey[], base?: Partial<CameraBase> }[], select?: boolean): number[] => {
        if (!items?.length) return [];
        const frames = events.invoke('timeline.frames') ?? 0;
        const ids: number[] = [];
        recordEdit('shotCameras.addWithKeys', () => {
            items.forEach((item) => {
                const camera = create(item.name || undefined);
                camera.track.loadKeys(fitKeysToFrames(item.keys, frames), item.base);
                ids.push(camera.id);
            });
            if (select !== false) selectedId = ids[ids.length - 1];
            changed();
        });
        return ids;
    });

    // old focus keys (depth of field had one global track): move them onto
    // the first camera
    events.on('shotCameras.importFocus', (keys: { frame: number, focus: number, aperture: number }[], focus?: number, aperture?: number) => {
        const camera = cameras[0];
        if (!camera) return;
        const track = camera.track;
        const snap = track.snapshot();
        if (focus !== undefined) snap.base.focus = focus;
        if (aperture !== undefined) snap.base.aperture = aperture;
        (keys ?? []).forEach((k) => {
            let key = snap.keys.find(x => x.frame === k.frame);
            if (!key) {
                key = { frame: k.frame };
                snap.keys.push(key);
            }
            key.focus = k.focus;
            key.aperture = k.aperture;
        });
        track.loadKeys(snap.keys, snap.base);
        apply();
    });

    events.on('shotCameras.duplicate', (id?: number) => {
        const source = byId(id ?? selectedId);
        if (!source) return;
        recordEdit('shotCameras.duplicate', () => {
            const copy = create(i18n.t('sm.cameras.copy-name', { name: source.name }));
            copy.track.restore(source.track.snapshot());
            copy.projection = source.projection;
            copy.ipd = source.ipd;
            selectedId = copy.id;
            changed();
        });
    });

    events.on('shotCameras.remove', (id?: number) => {
        const camera = byId(id ?? selectedId);
        if (!camera) return;
        // the last camera stays (the view needs one): removing it clears its
        // keys instead, undoable like a key edit
        if (cameras.length <= 1) {
            if (camera.track.keys.length === 0) return;
            const before = camera.track.snapshot();
            camera.track.clear();
            events.fire('edit.add', new AnimTrackEditOp('shotCameras.clearKeys', camera.track, before, camera.track.snapshot()), true);
            changed();
            return;
        }
        recordEdit('shotCameras.remove', () => {
            // the track stays alive in the pool for undo
            cameras.splice(cameras.indexOf(camera), 1);
            cut.removeCamera(camera.id);
            if (selectedId === camera.id) selectedId = cameras[0].id;
            changed();
        });
    });

    events.on('shotCameras.setProjection', (projection: CameraProjection, id?: number) => {
        const camera = byId(id ?? selectedId);
        if (!camera || camera.projection === projection) return;
        recordEdit('shotCameras.projection', () => {
            camera.projection = projection;
            events.fire('shotCameras.changed', cameras);
        });
    });

    events.on('shotCameras.setIpd', (ipd: number, id?: number) => {
        const camera = byId(id ?? selectedId);
        if (!camera || !(ipd > 0) || camera.ipd === ipd) return;
        recordEdit('shotCameras.ipd', () => {
            camera.ipd = ipd;
            events.fire('shotCameras.changed', cameras);
        });
    });

    events.on('shotCameras.rename', (id: number, name: string) => {
        const camera = byId(id);
        if (!camera || !name || name === camera.name) return;
        recordEdit('shotCameras.rename', () => {
            camera.name = name;
            events.fire('shotCameras.changed', cameras);
        });
    });

    events.on('shotCameras.select', (id: number) => {
        if (!byId(id) || id === selectedId) return;
        selectedId = id;
        changed();
    });

    // path lines of the camera gizmos

    let showPaths = true;
    events.function('camera.showPaths', () => showPaths);
    events.on('camera.setShowPaths', (value: boolean) => {
        if (value === showPaths) return;
        showPaths = value;
        events.fire('camera.showPaths', showPaths);
    });

    // view mode

    events.function('camera.viewMode', () => viewMode);

    events.on('camera.setViewMode', (mode: CameraViewMode) => {
        if (mode === viewMode) return;
        viewMode = mode;
        events.fire('camera.viewMode', viewMode);
        apply();
    });

    events.on('camera.toggleLookThrough', () => {
        events.fire('camera.setViewMode', viewMode === 'free' ? 'camera' : 'free');
    });

    // render export: follow one camera or the cut regardless of the view mode
    events.function('camera.setRenderOverride', (value: { mode: 'camera' | 'cut', cameraId?: number } | null) => {
        override = value;
    });

    // the selected camera's track is the active track (track-manager)
    events.function('camera.animTrack', () => selected()?.track ?? null);

    // poses of the selected camera (viewer export, publish settings)
    events.function('camera.poses', () => selected()?.track.getPoses() ?? []);

    events.on('camera.loadPoses', (poses: Pose[]) => {
        selected()?.track.loadPoses(poses);
    });

    // cut track api (undo via AnimTrackEditOp)

    events.function('cut.track', () => cut);
    events.function('cut.segments', () => cut.segments);
    events.function('cut.cameraAt', (frame: number) => cut.cameraAt(frame));
    events.function('cut.fadeAt', (time: number) => cut.fadeAt(time));

    // Serialization: one pose set per camera, plus the cut track. Cut
    // segments reference cameras by pose set index so ids need not persist

    events.function('docSerialize.poseSets', (): any[] => {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];

        // an untouched single camera saves nothing, as before
        if (cameras.length === 1 && cameras[0].track.keys.length === 0 && !cameras[0].track.placed) {
            return [];
        }

        return cameras.map(camera => ({
            name: camera.name,
            color: camera.color,
            projection: camera.projection,
            ipd: camera.ipd,
            // per channel keys and base values; poses stay for readers of the
            // old format
            channels: camera.track.serialize(),
            poses: camera.track.getPoses().map(pose => ({
                name: pose.name,
                frame: pose.frame,
                position: pack3(pose.position),
                target: pack3(pose.target),
                fov: pose.fov
            }))
        }));
    });

    events.function('docDeserialize.poseSets', (poseSets: any[], documentCameraFov?: number) => {
        if (!poseSets || poseSets.length === 0) {
            return;
        }

        const fps = events.invoke('timeline.frameRate');
        const defaultFov = documentCameraFov ?? events.invoke('camera.fov') ?? 60;

        removeAll();
        nextId = 1;

        poseSets.forEach((poseSet: any, setIndex: number) => {
            // old projects stored a single set named 'set0': migrate it to
            // "Kamera 1"
            const name = (!poseSet.name || /^set\d+$/.test(poseSet.name)) ? i18n.t('sm.cameras.default-name', { n: setIndex + 1 }) : poseSet.name;
            const camera = create(name, poseSet.color);
            if (['standard', 'equirect', 'stereo'].includes(poseSet.projection)) camera.projection = poseSet.projection;
            if (typeof poseSet.ipd === 'number') camera.ipd = poseSet.ipd;
            if (poseSet.channels) {
                const vec = (v: any) => (Array.isArray(v) ? new Vec3(v[0], v[1], v[2]) : undefined);
                const b = poseSet.channels.base ?? {};
                camera.track.loadKeys((poseSet.channels.keys ?? []).map((k: any) => {
                    const key: any = { frame: k.frame };
                    if (k.position) key.position = vec(k.position);
                    if (k.target) key.target = vec(k.target);
                    if (k.position && k.handleIn && k.handleOut) {
                        key.handleIn = vec(k.handleIn);
                        key.handleOut = vec(k.handleOut);
                    }
                    ['fov', 'focus', 'aperture', ...MODIFIER_CHANNELS].forEach((c) => {
                        if (typeof k[c] === 'number') key[c] = k[c];
                    });
                    return key;
                }), {
                    position: vec(b.position) ?? null,
                    target: vec(b.target) ?? null,
                    fov: b.fov ?? defaultFov,
                    focus: b.focus ?? 5,
                    aperture: b.aperture ?? 0.05,
                    bob: typeof b.bob === 'number' ? b.bob : MODIFIER_DEFAULTS.bob,
                    stepRate: typeof b.stepRate === 'number' ? b.stepRate : MODIFIER_DEFAULTS.stepRate,
                    shake: typeof b.shake === 'number' ? b.shake : MODIFIER_DEFAULTS.shake,
                    shakeRate: typeof b.shakeRate === 'number' ? b.shakeRate : MODIFIER_DEFAULTS.shakeRate
                });
                return;
            }
            camera.track.loadPoses((poseSet.poses ?? []).map((docPose: any, index: number) => ({
                name: docPose.name,
                frame: docPose.frame ?? (index * fps),
                position: new Vec3(docPose.position),
                target: new Vec3(docPose.target),
                fov: docPose.fov ?? defaultFov
            })));
        });

        selectedId = cameras[0].id;
        changed();
    });

    events.function('docSerialize.cuts', () => {
        return {
            viewMode,
            segments: cut.segments.map(s => ({
                start: s.start,
                end: s.end,
                camera: cameras.findIndex(c => c.id === s.cameraId),
                ...(s.fade ? { fade: s.fade } : {})
            })).filter(s => s.camera >= 0)
        };
    });

    events.function('docDeserialize.cuts', (doc: any) => {
        cut.restore((doc?.segments ?? [])
        .filter((s: any) => cameras[s.camera])
        .map((s: any) => ({ start: s.start, end: s.end, cameraId: cameras[s.camera].id, fade: s.fade || undefined })));
        if (doc?.viewMode) {
            events.fire('camera.setViewMode', doc.viewMode);
        }
    });
};

export { registerCameraPosesEvents, CameraAnimTrack, CutTrack, Pose, PoseValue, ShotCamera, CutSegment, CutFade, CameraViewMode, CameraChannel, ChannelState, CAMERA_CHANNELS, MODIFIER_CHANNELS, CameraProjection, CameraKey, CameraBase };
