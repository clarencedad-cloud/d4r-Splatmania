import { Vec3 } from 'playcanvas';

// Procedural camera modifier of a shot camera: gait bob (walking) and
// handheld shake. It sits on top of the keyed path - the keys stay sparse and
// editable, the modifier is evaluated per (sub)frame wherever the camera's
// final pose is needed: the viewport following the camera, playback, video
// export, the player export and the walk preview of the shot suggestions.
//
// Parameters (camera channels, keyable):
//   bob        vertical bob amplitude, scene units (0 = off)
//   stepRate   steps per second (Hz); the bob runs one cycle per step, the
//              sideways sway one per stride (two steps)
//   shake      handheld shake, degrees of yaw / pitch (0 = off)
//   shakeRate  speed of the shake, Hz
//
// The step phase only advances while the camera moves (gate): standing still
// the bob fades out, the handheld shake keeps going.

type ModifierValues = {
    bob: number;
    stepRate: number;
    shake: number;
    shakeRate: number;
};

const MODIFIER_DEFAULTS: ModifierValues = {
    bob: 0,
    stepRate: 1.9,
    shake: 0,
    shakeRate: 1.2
};

// a walk: 3 cm bob at 1.9 steps per second (about 1.3 m/s), light shake
const WALK_DEFAULTS = {
    bobMeters: 0.03,
    stepRate: 1.9,
    shake: 0.35,
    shakeRate: 1.1
};

// sideways sway relative to the bob
const SWAY = 0.8;

// camera speeds (metres per second) between which the gait fades in
const GATE_FROM = 0.12;
const GATE_TO = 0.7;

// sub-steps per frame of the phase integration
const SUBSTEPS = 4;

const DEG = Math.PI / 180;

const smoothstep = (t: number) => {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
};

// smooth quasi-random wobble in -1..1: three sines with unrelated
// frequencies (no visible period)
const wobble = (t: number, seed: number) => {
    return 0.55 * Math.sin(2 * Math.PI * (t + 0.137 * seed)) +
        0.3 * Math.sin(2 * Math.PI * (2.137 * t + 0.611 * seed + 0.3)) +
        0.15 * Math.sin(2 * Math.PI * (3.731 * t + 0.293 * seed + 0.7));
};

// phase tables per whole frame: step phase (radians), gate (0..1) and shake
// time (cycles), integrated from frame 0
type ModifierTables = {
    frames: number;
    // metres per scene unit the tables were built with
    metersPerUnit: number;
    phase: Float64Array;
    gate: Float32Array;
    shakeTime: Float64Array;
};

type ModifierSource = {
    // channel values without unkeyed edits (stable integration)
    value: (channel: keyof ModifierValues, frame: number) => number;
    // the path's position at a (fractional) frame
    position: (frame: number, out: Vec3) => boolean;
};

const tmpA = new Vec3();
const tmpB = new Vec3();

const buildModifierTables = (source: ModifierSource, frames: number, fps: number, metersPerUnit: number): ModifierTables => {
    const n = Math.max(1, Math.floor(frames));
    const phase = new Float64Array(n + 1);
    const gate = new Float32Array(n + 1);
    const shakeTime = new Float64Array(n + 1);
    const rate = fps > 0 ? fps : 30;
    const mpu = metersPerUnit > 0 ? metersPerUnit : 1;

    const gateAt = (f: number) => {
        const h = 0.5;
        if (!source.position(f - h, tmpA) || !source.position(f + h, tmpB)) return 0;
        const speed = tmpA.distance(tmpB) / (2 * h) * rate * mpu;
        return smoothstep((speed - GATE_FROM) / (GATE_TO - GATE_FROM));
    };

    gate[0] = gateAt(0);
    for (let f = 0; f < n; f++) {
        let p = 0;
        let s = 0;
        for (let k = 0; k < SUBSTEPS; k++) {
            const t = f + (k + 0.5) / SUBSTEPS;
            const g = gateAt(t);
            p += 2 * Math.PI * Math.max(0, source.value('stepRate', t)) * g / rate / SUBSTEPS;
            s += Math.max(0, source.value('shakeRate', t)) / rate / SUBSTEPS;
        }
        phase[f + 1] = phase[f] + p;
        shakeTime[f + 1] = shakeTime[f] + s;
        gate[f + 1] = gateAt(f + 1);
    }
    return { frames: n, metersPerUnit: mpu, phase, gate, shakeTime };
};

const sample = (table: Float64Array | Float32Array, frame: number) => {
    const last = table.length - 1;
    if (!(frame > 0)) return table[0];
    if (frame >= last) return table[last];
    const i = Math.floor(frame);
    const f = frame - i;
    return table[i] * (1 - f) + table[i + 1] * f;
};

type ModifierOffset = {
    // translation of the camera (and its target)
    offset: Vec3;
    yaw: number;
    pitch: number;
};

// the modifier at a frame for a given forward direction
const modifierOffset = (values: ModifierValues, tables: ModifierTables, frame: number, forward: Vec3, out: ModifierOffset) => {
    out.offset.set(0, 0, 0);
    out.yaw = 0;
    out.pitch = 0;
    const bob = values.bob > 0 ? values.bob : 0;
    if (bob > 0) {
        const g = sample(tables.gate, frame);
        const phase = sample(tables.phase, frame);
        // lowest at the heel strike, one cycle per step
        const up = -Math.cos(phase) * bob * g;
        // sideways once per stride
        const side = Math.sin(0.5 * phase) * bob * SWAY * g;
        let rx = -forward.z;
        let rz = forward.x;
        const len = Math.hypot(rx, rz);
        if (len > 1e-6) {
            rx /= len;
            rz /= len;
        } else {
            rx = 1;
            rz = 0;
        }
        out.offset.set(rx * side, up, rz * side);
        // a slight nod with the step
        out.pitch += -Math.sin(phase) * 0.12 * g * Math.min(1, bob * tables.metersPerUnit / 0.03);
    }
    const shake = values.shake > 0 ? values.shake : 0;
    if (shake > 0) {
        const t = sample(tables.shakeTime, frame);
        out.yaw += shake * wobble(t, 1);
        out.pitch += shake * 0.8 * wobble(t * 1.07 + 0.41, 2);
    }
    return out;
};

// rotate dir around the world up by yaw, then around its right vector by
// pitch (degrees); the inverse runs the same with negated angles in reverse
const rotateDir = (dir: Vec3, yaw: number, pitch: number, inverse = false) => {
    const turn = (angle: number) => {
        if (!angle) return;
        const c = Math.cos(angle * DEG);
        const s = Math.sin(angle * DEG);
        const x = dir.x * c + dir.z * s;
        const z = -dir.x * s + dir.z * c;
        dir.x = x;
        dir.z = z;
    };
    const tilt = (angle: number) => {
        if (!angle) return;
        const len = dir.length();
        const h = Math.hypot(dir.x, dir.z);
        if (len < 1e-9 || h < 1e-9) return;
        const el = Math.atan2(dir.y, h) + angle * DEG;
        const limited = Math.max(-89 * DEG, Math.min(89 * DEG, el));
        const nh = Math.cos(limited) * len;
        dir.x *= nh / h;
        dir.z *= nh / h;
        dir.y = Math.sin(limited) * len;
    };
    if (inverse) {
        tilt(-pitch);
        turn(-yaw);
    } else {
        turn(yaw);
        tilt(pitch);
    }
};

const tmpDir = new Vec3();

// apply an offset to a pose in place
const applyModifierOffset = (position: Vec3, target: Vec3, m: ModifierOffset) => {
    tmpDir.sub2(target, position);
    position.add(m.offset);
    rotateDir(tmpDir, m.yaw, m.pitch);
    target.add2(position, tmpDir);
};

// undo an offset (a view taken while looking through the camera)
const removeModifierOffset = (position: Vec3, target: Vec3, m: ModifierOffset) => {
    tmpDir.sub2(target, position);
    rotateDir(tmpDir, m.yaw, m.pitch, true);
    position.sub(m.offset);
    target.add2(position, tmpDir);
};

export {
    MODIFIER_DEFAULTS,
    WALK_DEFAULTS,
    buildModifierTables,
    modifierOffset,
    applyModifierOffset,
    removeModifierOffset,
    type ModifierValues,
    type ModifierTables,
    type ModifierSource,
    type ModifierOffset
};
