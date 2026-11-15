import { Color, Entity, TranslateGizmo, Vec3 } from 'playcanvas';

import type { AnimTrack } from '../anim-track';
import { AnimTrackEditOp } from '../edit-ops';
import { Events } from '../events';
import type { Scene } from '../scene';

// Relighting: extra light over the scanned colour. A gaussian splat scan has
// its light baked into the colours, so this does not remove the original
// light; it dims it (baked) and adds ambient plus up to four lights (sun,
// point, spot), shaded per splat in the projector (src/shaders/
// projected-splat-projector-shader.ts) with the splat's shortest axis as
// its normal. It shows in the viewport and every export, and is keyframed
// as a whole like the look.

type LightType = 'sun' | 'point' | 'spot';

type Light = {
    id: number,
    type: LightType,
    enabled: boolean,
    color: [number, number, number],
    intensity: number,
    // sun: direction to the sun, degrees
    azimuth: number,
    elevation: number,
    // point / spot: world position and reach (world units)
    position: [number, number, number],
    range: number,
    // spot: aim (unit vector) and half cone angle (degrees)
    direction: [number, number, number],
    cone: number
};

type LightRig = {
    enabled: boolean,
    // how much of the scanned light stays (1 = as scanned, 0 = dark)
    baked: number,
    ambient: [number, number, number],
    ambientStrength: number,
    // soft diffuse: light wraps around (helps with noisy normals)
    wrap: number,
    // spot edge softness
    softness: number,
    lights: Light[]
};

const MAX_LIGHTS = 4;

const defaultRig = (): LightRig => ({
    enabled: true,
    baked: 1,
    ambient: [0.55, 0.65, 1],
    ambientStrength: 0,
    wrap: 0.4,
    softness: 0.4,
    lights: []
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// does the rig change the image at all?
const rigActive = (r: LightRig) => r.enabled && (
    Math.abs(r.baked - 1) > 1e-4 || r.ambientStrength > 0 || r.lights.some(l => l.enabled && l.intensity > 0)
);

// blend two rigs: numbers and colours ease, everything else (types, flags,
// a different set of lights) switches halfway
const blendValue = (a: any, b: any, e: number): any => {
    if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * e;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => blendValue(v, b[i], e));
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
        const out: any = {};
        for (const key of Object.keys(a)) out[key] = key in b ? blendValue(a[key], b[key], e) : a[key];
        return out;
    }
    return e < 0.5 ? a : b;
};

const blendRigs = (a: LightRig, b: LightRig, e: number): LightRig => {
    const sameLights = a.lights.length === b.lights.length && a.lights.every((l, i) => l.id === b.lights[i].id && l.type === b.lights[i].type);
    const out = blendValue({ ...a, lights: [] }, { ...b, lights: [] }, e) as LightRig;
    out.lights = sameLights ? blendValue(a.lights, b.lights, e) : clone(e < 0.5 ? a.lights : b.lights);
    // ids are identity, not values
    out.lights.forEach((l, i) => {
        l.id = (e < 0.5 || !sameLights ? a.lights[i]?.id : b.lights[i]?.id) ?? l.id;
    });
    return out;
};

const sameRig = (a: LightRig, b: LightRig) => JSON.stringify(a) === JSON.stringify(b);

// the keyed part of the rig (the on / off switch stays global)
const keyedPart = (r: LightRig) => {
    const { enabled, ...rest } = clone(r);
    return rest;
};

type LightKey = { frame: number, rig: ReturnType<typeof keyedPart> };

// keyframe track of the whole rig, smooth (ease in / out) between keys
class LightTrack implements AnimTrack {
    private keyList: LightKey[] = [];

    constructor(private events: Events, private capture: () => LightRig) {}

    get keys() {
        return this.keyList.map(k => k.frame);
    }

    get keyData(): readonly LightKey[] {
        return this.keyList;
    }

    private sort() {
        this.keyList.sort((a, b) => a.frame - b.frame);
    }

    addKey(frame: number) {
        const rig = keyedPart(this.capture());
        const existing = this.keyList.find(k => k.frame === frame);
        if (existing) {
            if (JSON.stringify(existing.rig) === JSON.stringify(rig)) return false;
            existing.rig = rig;
        } else {
            this.keyList.push({ frame, rig });
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
        this.keyList.push({ frame: to, rig: clone(key.rig) });
        this.sort();
        this.changed();
        return true;
    }

    clear() {
        this.keyList = [];
        this.changed();
    }

    snapshot() {
        return clone(this.keyList);
    }

    restore(snapshot: unknown) {
        this.keyList = clone(snapshot as LightKey[]);
        this.sort();
        this.changed();
    }

    // the animated rig (without the on / off switch) at a frame, or null
    evaluate(frame: number): ReturnType<typeof keyedPart> | null {
        const keys = this.keyList;
        if (keys.length === 0) return null;
        if (frame <= keys[0].frame) return clone(keys[0].rig);
        const last = keys[keys.length - 1];
        if (frame >= last.frame) return clone(last.rig);
        let i = 0;
        while (i < keys.length - 2 && frame > keys[i + 1].frame) i++;
        const t = (frame - keys[i].frame) / (keys[i + 1].frame - keys[i].frame);
        const e = t * t * (3 - 2 * t);
        const a = { ...keys[i].rig, enabled: true } as LightRig;
        const b = { ...keys[i + 1].rig, enabled: true } as LightRig;
        return keyedPart(blendRigs(a, b, e));
    }

    private changed() {
        this.events.fire('light.trackChanged', this);
    }
}

const DEG = Math.PI / 180;

const sunDirection = (l: Light): [number, number, number] => {
    const az = l.azimuth * DEG;
    const el = l.elevation * DEG;
    return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
};

// undoable change of the whole rig (remove, move in the viewport)
class LightRigOp {
    constructor(public name: string, private apply: (rig: LightRig) => void, private before: LightRig, private after: LightRig) {}
    do() {
        this.apply(clone(this.after));
    }
    undo() {
        this.apply(clone(this.before));
    }
}

const registerLightEvents = (events: Events, scene: Scene) => {
    let rig: LightRig = defaultRig();
    let nextId = 1;
    let currentFrame = 0;
    let gizmos = false;
    // viewport click places a light: 'position' or 'target' (spot aim)
    let picking: { id: number, mode: 'position' | 'target' } | null = null;

    const track = new LightTrack(events, () => rig);

    // the light picked in the scene list (shows a move gizmo)
    let selectedId: number | null = null;

    const changed = () => {
        if (selectedId !== null && !rig.lights.some(l => l.id === selectedId)) {
            selectedId = null;
            events.fire('light.selected', null);
        }
        events.fire('light.changed', rig);
        scene.forceRender = true;
    };

    const setRig = (next: LightRig) => {
        rig = next;
        changed();
    };

    // record a rig change made since `before` as one undo step
    const recordRig = (name: string, before: LightRig) => {
        events.fire('edit.add', new LightRigOp(name, setRig, before, clone(rig)), true);
    };

    // a drag outside this file (rotate tool, src/tools/object-gizmo.ts) as
    // one undo step
    let editBefore: LightRig | null = null;
    events.on('light.editStart', () => {
        editBefore = clone(rig);
    });
    events.on('light.editEnd', (name = 'lightEdit') => {
        if (editBefore) recordRig(name, editBefore);
        editBefore = null;
    });

    events.function('light.selected', () => selectedId);
    events.on('light.select', (id: number | null) => {
        const next = id !== null && rig.lights.some(l => l.id === id) ? id : null;
        if (next === selectedId) return;
        selectedId = next;
        events.fire('light.selected', selectedId);
        scene.forceRender = true;
    });

    events.function('light.state', () => rig);
    events.function('light.active', () => rigActive(rig));

    // projector uniforms (src/projected-splat-renderer.ts)
    events.function('light.uniforms', () => {
        if (!rigActive(rig)) return null;
        const lights: number[][] = [];
        for (let i = 0; i < MAX_LIGHTS; i++) {
            const l = rig.lights[i];
            if (!l || !l.enabled || l.intensity <= 0) {
                lights.push([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
                continue;
            }
            const type = l.type === 'sun' ? 1 : (l.type === 'point' ? 2 : 3);
            const a = l.type === 'sun' ? sunDirection(l) : l.position;
            const d = new Vec3(l.direction[0], l.direction[1], l.direction[2]);
            if (d.length() < 1e-6) d.set(0, -1, 0);
            d.normalize();
            lights.push(
                [a[0], a[1], a[2], type],
                [l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity, Math.max(1e-3, l.range)],
                [d.x, d.y, d.z, Math.cos(Math.min(89.5, Math.max(0.5, l.cone)) * DEG)]
            );
        }
        return {
            params: [1, rig.baked, rig.wrap, rig.softness],
            ambient: [rig.ambient[0] * rig.ambientStrength, rig.ambient[1] * rig.ambientStrength, rig.ambient[2] * rig.ambientStrength, 0],
            lights
        };
    });

    events.on('light.set', (patch: Partial<Omit<LightRig, 'lights'>>) => {
        Object.assign(rig, patch);
        changed();
    });

    events.on('light.reset', () => {
        const enabled = rig.enabled;
        rig = { ...defaultRig(), enabled };
        changed();
    });

    // a point in front of the camera (where new point lights go)
    const inFront = (distance: number): [number, number, number] => {
        const p = scene.camera.position;
        const f = scene.camera.forward;
        return [p.x + f.x * distance, p.y + f.y * distance, p.z + f.z * distance];
    };
    const sceneSize = () => Math.max(1, scene.bound.halfExtents.length());
    // the sun's move handle sits this far from the scene centre
    const sunHandleDistance = () => sceneSize() * 1.3;

    events.function('light.add', (type: LightType) => {
        if (rig.lights.length >= MAX_LIGHTS) return null;
        const f = scene.camera.forward;
        const size = sceneSize();
        const light: Light = {
            id: nextId++,
            type,
            enabled: true,
            color: type === 'sun' ? [1, 0.93, 0.82] : [1, 0.78, 0.5],
            intensity: type === 'sun' ? 0.8 : 1.5,
            // the sun comes from over the viewer's shoulder
            azimuth: Math.round(Math.atan2(-f.x, -f.z) / DEG + 40),
            elevation: 40,
            // spot: from the camera, aimed where it looks (a headlight)
            position: type === 'spot' ? inFront(0) : inFront(Math.min(3, size * 0.3)),
            range: Math.max(1, size * 0.5),
            direction: [f.x, f.y, f.z],
            cone: 25
        };
        rig.lights = [...rig.lights, light];
        if (!rig.enabled) rig.enabled = true;
        changed();
        return light;
    });

    events.on('light.update', (id: number, patch: Partial<Light>) => {
        rig.lights = rig.lights.map(l => (l.id === id ? { ...l, ...patch } : l));
        changed();
    });

    // removing a light is one undo step
    events.on('light.remove', (id: number) => {
        if (!rig.lights.some(l => l.id === id)) return;
        const before = clone(rig);
        rig.lights = rig.lights.filter(l => l.id !== id);
        if (picking?.id === id) picking = null;
        changed();
        recordRig('lightRemove', before);
    });

    // Delete / Backspace removes the light picked in the scene list (before
    // the global shortcuts, which would delete selected splats)
    window.addEventListener('keydown', (e: KeyboardEvent) => {
        if (selectedId === null || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
        e.preventDefault();
        e.stopPropagation();
        events.fire('light.remove', selectedId);
    }, { capture: true });

    // move a point / spot light to the camera (spots aim where it looks)
    events.on('light.toCamera', (id: number) => {
        const l = rig.lights.find(x => x.id === id);
        if (!l) return;
        const f = scene.camera.forward;
        events.fire('light.update', id, l.type === 'spot' ?
            { position: inFront(0), direction: [f.x, f.y, f.z] } :
            { position: inFront(Math.min(3, sceneSize() * 0.3)) });
    });

    // place by clicking the model: 'position' puts the light a little off
    // the surface toward the camera, 'target' aims a spot at the point
    events.on('light.pick', (id: number | null, mode: 'position' | 'target' = 'position') => {
        picking = id === null ? null : { id, mode };
        events.fire('light.picking', picking);
    });
    events.function('light.picking', () => picking);

    // the camera controls capture the pointer, so the release is caught on
    // the window and measured against the canvas
    const canvas = scene.canvas;
    const pointer = { x: 0, y: 0, down: false };
    const local = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height };
    };
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
        if (!picking || e.button !== 0) return;
        const p = local(e);
        pointer.x = p.x;
        pointer.y = p.y;
        pointer.down = true;
    });
    window.addEventListener('pointerup', async (e: PointerEvent) => {
        if (!picking || !pointer.down) return;
        pointer.down = false;
        const up = local(e);
        if (Math.hypot(up.x - pointer.x, up.y - pointer.y) > 4) return;
        const { id, mode } = picking;
        picking = null;
        events.fire('light.picking', null);
        const hit = await scene.camera.intersect(pointer.x / up.w, pointer.y / up.h);
        const l = rig.lights.find(x => x.id === id);
        if (!hit || !l) return;
        const p = hit.position;
        if (mode === 'target') {
            const d = new Vec3(p.x - l.position[0], p.y - l.position[1], p.z - l.position[2]);
            if (d.length() < 1e-6) return;
            d.normalize();
            events.fire('light.update', id, { direction: [d.x, d.y, d.z] });
        } else {
            const toCam = new Vec3().sub2(scene.camera.position, p);
            const lift = Math.min(toCam.length() * 0.5, Math.max(0.15, sceneSize() * 0.04));
            toCam.normalize().mulScalar(lift);
            events.fire('light.update', id, { position: [p.x + toCam.x, p.y + toCam.y, p.z + toCam.z] });
        }
    }, true);

    // keyframes: the animated rig follows the timeline and the export
    const applyTrack = () => {
        const v = track.evaluate(currentFrame);
        if (!v) return;
        const next = { ...v, enabled: rig.enabled } as LightRig;
        if (!sameRig(next, rig)) {
            rig = next;
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
    events.on('light.trackChanged', () => applyTrack());

    events.function('light.track', () => track);
    events.function('light.keyState', () => {
        const frame = Math.round(events.invoke('timeline.frame') ?? 0);
        if (track.keyData.length === 0) return 'static';
        const v = track.evaluate(frame);
        if (v && JSON.stringify(v) !== JSON.stringify(keyedPart(rig))) return 'changed';
        return track.keyData.some(k => k.frame === frame) ? 'keyed' : 'animated';
    });
    events.on('light.addKey', (frame?: number) => {
        const before = track.snapshot();
        if (track.addKey(Math.round(frame ?? events.invoke('timeline.frame') ?? 0))) {
            events.fire('edit.add', new AnimTrackEditOp('lightKey', track, before, track.snapshot()), true);
        }
    });
    events.on('light.removeKey', (frame?: number) => {
        const before = track.snapshot();
        if (track.removeKey(Math.round(frame ?? events.invoke('timeline.frame') ?? 0))) {
            events.fire('edit.add', new AnimTrackEditOp('lightUnkey', track, before, track.snapshot()), true);
        }
    });

    // editor gizmos for point and spot lights while the panel is open
    events.on('lightPanel.visible', (visible: boolean) => {
        gizmos = visible;
        scene.forceRender = true;
    });
    const a = new Vec3();
    const b = new Vec3();
    const gizmoColor = new Color(1, 0.8, 0.3, 1);
    events.on('prerender', () => {
        if ((!gizmos && selectedId === null) || !scene.camera.renderOverlays) return;
        for (const l of rig.lights) {
            // with the panel closed only the light picked in the scene list
            if (!gizmos && l.id !== selectedId) continue;
            if (l.type === 'sun') {
                if (l.id !== selectedId) continue;
                // a line from the scene toward the sun, ending at the handle
                const d = sunDirection(l);
                const c = scene.bound.center;
                gizmoColor.set(l.color[0], l.color[1], l.color[2], l.enabled ? 1 : 0.3);
                b.set(c.x + d[0] * sunHandleDistance(), c.y + d[1] * sunHandleDistance(), c.z + d[2] * sunHandleDistance());
                scene.app.drawLine(c, b, gizmoColor, true, scene.gizmoLayer);
                continue;
            }
            const p = new Vec3(l.position[0], l.position[1], l.position[2]);
            const size = Math.max(0.02, p.distance(scene.camera.position) * 0.03);
            gizmoColor.set(l.color[0], l.color[1], l.color[2], l.enabled ? 1 : 0.3);
            for (const axis of [Vec3.RIGHT, Vec3.UP, Vec3.BACK]) {
                a.copy(axis).mulScalar(size).add(p);
                b.copy(axis).mulScalar(-size).add(p);
                scene.app.drawLine(a, b, gizmoColor, true, scene.gizmoLayer);
            }
            if (l.type === 'spot') {
                b.set(l.direction[0], l.direction[1], l.direction[2]).normalize().mulScalar(Math.min(l.range, size * 12)).add(p);
                scene.app.drawLine(p, b, gizmoColor, true, scene.gizmoLayer);
            }
        }
    });

    // move gizmo for the light picked in the scene list: lamps and spots move
    // their position, the sun moves a handle that sets its direction
    const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
    const pivot = new Entity('lightGizmoPivot');
    let attached = false;
    let dragBefore: LightRig | null = null;
    const selectedLight = () => (selectedId === null ? null : rig.lights.find(l => l.id === selectedId) ?? null);
    const handlePosition = (l: Light, out: Vec3) => {
        if (l.type === 'sun') {
            const d = sunDirection(l);
            const c = scene.bound.center;
            return out.set(c.x + d[0] * sunHandleDistance(), c.y + d[1] * sunHandleDistance(), c.z + d[2] * sunHandleDistance());
        }
        return out.set(l.position[0], l.position[1], l.position[2]);
    };
    const placeGizmo = () => {
        const l = selectedLight();
        // the rotate and scale tools bring their own gizmo
        const tool = events.functions.has('tool.active') ? events.invoke('tool.active') : null;
        const show = !!l && !picking && scene.camera.renderOverlays && tool !== 'rotate' && tool !== 'scale';
        if (!show) {
            if (attached) gizmo.detach();
            attached = false;
            return;
        }
        if (!dragBefore) pivot.setPosition(handlePosition(l, a));
        if (!attached) gizmo.attach(pivot);
        attached = true;
    };
    gizmo.on('transform:start', () => {
        dragBefore = clone(rig);
    });
    gizmo.on('transform:move', () => {
        const l = selectedLight();
        if (!l) return;
        const p = pivot.getPosition();
        if (l.type === 'sun') {
            const c = scene.bound.center;
            const d = new Vec3(p.x - c.x, p.y - c.y, p.z - c.z);
            if (d.length() < 1e-6) return;
            d.normalize();
            const elevation = Math.max(-89, Math.min(89, Math.asin(Math.max(-1, Math.min(1, d.y))) / DEG));
            const azimuth = Math.atan2(d.x, d.z) / DEG;
            rig.lights = rig.lights.map(x => (x.id === l.id ? { ...x, azimuth, elevation } : x));
        } else {
            rig.lights = rig.lights.map(x => (x.id === l.id ? { ...x, position: [p.x, p.y, p.z] as [number, number, number] } : x));
        }
        changed();
    });
    gizmo.on('transform:end', () => {
        if (dragBefore) recordRig('lightMove', dragBefore);
        dragBefore = null;
        placeGizmo();
    });
    const updateGizmoSize = () => {
        const canvasEl = scene.canvas;
        gizmo.size = scene.camera.ortho ? 1125 / canvasEl.clientHeight : 1200 / Math.max(canvasEl.clientWidth, canvasEl.clientHeight);
    };
    updateGizmoSize();
    events.on('camera.resize', updateGizmoSize);
    events.on('camera.ortho', updateGizmoSize);
    events.on('light.selected', placeGizmo);
    events.on('tool.activated', placeGizmo);
    events.on('tool.deactivated', placeGizmo);
    events.on('light.picking', placeGizmo);
    events.on('light.changed', () => {
        if (!dragBefore) placeGizmo();
    });

    // project file
    events.function('docSerialize.light', () => ({ ...clone(rig), keys: track.snapshot() }));
    events.function('docDeserialize.light', (doc: any) => {
        rig = defaultRig();
        if (doc) {
            const { keys, lights, ...rest } = doc;
            for (const key of Object.keys(rest)) {
                if (key in rig) (rig as any)[key] = rest[key];
            }
            rig.lights = Array.isArray(lights) ? lights.slice(0, MAX_LIGHTS).map((l: any) => ({ ...(l as Light) })) : [];
            nextId = Math.max(nextId, ...rig.lights.map(l => l.id + 1));
            track.restore(Array.isArray(keys) ? keys : []);
        } else {
            track.restore([]);
        }
        changed();
    });
};

export { registerLightEvents, LightTrack, Light, LightRig, LightType, MAX_LIGHTS };
