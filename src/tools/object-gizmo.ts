import { Entity, Quat, RotateGizmo, TranslateGizmo, Vec3 } from 'playcanvas';

import { Events } from '../events';
import type { Scene } from '../scene';

// The move and rotate tools of the bottom toolbar act on what the scene
// panel shows: a splat (src/tools/transform-tool.ts), or the picked shot
// camera or light (here). The scene panel sets the target with
// 'transform.setTarget'.
//
// - camera, move: the camera position; the look-at target moves along
// - camera, rotate: turns the view around the camera position
// - light, move: handled by the light's own gizmo (src/light/light.ts)
// - light, rotate: spot and sun direction; a lamp has none
//
// Camera edits go through shotCameras.setValue, so auto-key, pending keys
// and undo (consecutive edits merge into one step) work as in the panel.

type TransformTarget = 'splat' | 'camera' | 'cameraTarget' | 'light';

type LightLike = {
    id: number,
    type: 'sun' | 'point' | 'spot',
    position: [number, number, number],
    direction: [number, number, number],
    azimuth: number,
    elevation: number
};

const DEG = Math.PI / 180;
const FORWARD = new Vec3(0, 0, -1);

// rotation that turns -z into dir (no roll)
const lookRotation = (dir: Vec3, out: Quat) => {
    const d = dir.clone().normalize();
    const pitch = Math.asin(Math.max(-1, Math.min(1, d.y))) / DEG;
    const yaw = Math.atan2(-d.x, -d.z) / DEG;
    return out.setFromEulerAngles(pitch, yaw, 0);
};

const registerObjectGizmo = (events: Events, scene: Scene) => {
    let target: TransformTarget = 'splat';

    events.function('transform.target', () => target);
    events.on('transform.setTarget', (value: TransformTarget) => {
        if (value === target) return;
        target = value;
        events.fire('transform.target', target);
        update();
    });

    const camera = scene.camera.camera;
    const translate = new TranslateGizmo(camera, scene.gizmoLayer);
    const rotate = new RotateGizmo(camera, scene.gizmoLayer);
    rotate.rotationMode = 'orbit';
    const pivot = new Entity('objectGizmoPivot');
    scene.app.root.addChild(pivot);

    let attached: TranslateGizmo | RotateGizmo | null = null;
    let dragging = false;
    // state when a drag starts
    const startPos = new Vec3();
    const startDir = new Vec3();
    const startRot = new Quat();
    let startLen = 1;

    const tool = () => (events.functions.has('tool.active') ? events.invoke('tool.active') : null);
    const selectedCamera = () => (events.functions.has('shotCameras.selected') ? events.invoke('shotCameras.selected') : null);
    const cameraValue = (channel: 'position' | 'target'): Vec3 | null => {
        const v = events.invoke('shotCameras.value', channel);
        return v ? new Vec3(v.x, v.y, v.z) : null;
    };
    const selectedLight = (): LightLike | null => {
        const id = events.functions.has('light.selected') ? events.invoke('light.selected') : null;
        if (id === null) return null;
        return (events.invoke('light.state').lights as LightLike[]).find(l => l.id === id) ?? null;
    };
    const sunDir = (l: LightLike) => {
        const az = l.azimuth * DEG;
        const el = l.elevation * DEG;
        return new Vec3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    };
    const sunHandle = () => {
        const size = Math.max(1, scene.bound.halfExtents.length());
        return size * 1.3;
    };

    const detach = () => {
        if (attached) attached.detach();
        attached = null;
    };

    const attach = (gizmo: TranslateGizmo | RotateGizmo) => {
        if (attached !== gizmo) {
            detach();
            gizmo.attach([pivot]);
            attached = gizmo;
        }
        scene.forceRender = true;
    };

    // place the pivot on the target and pick the gizmo for the active tool
    function update() {
        if (dragging) return;
        const active = tool();
        if (target === 'camera' && (active === 'move' || active === 'rotate')) {
            const cam = selectedCamera();
            const p = cam ? cameraValue('position') : null;
            const t = cam ? cameraValue('target') : null;
            if (!p || !t || p.distance(t) < 1e-6) {
                detach();
                return;
            }
            pivot.setPosition(p);
            pivot.setRotation(lookRotation(t.clone().sub(p), new Quat()));
            attach(active === 'move' ? translate : rotate);
            return;
        }
        if (target === 'cameraTarget' && active === 'move') {
            const t = selectedCamera() ? cameraValue('target') : null;
            if (!t) {
                detach();
                return;
            }
            pivot.setPosition(t);
            pivot.setRotation(Quat.IDENTITY);
            attach(translate);
            return;
        }
        if (target === 'light' && active === 'rotate') {
            const l = selectedLight();
            if (!l || l.type === 'point') {
                detach();
                return;
            }
            if (l.type === 'sun') {
                const c = scene.bound.center;
                const d = sunDir(l);
                pivot.setPosition(c.x + d.x * sunHandle(), c.y + d.y * sunHandle(), c.z + d.z * sunHandle());
                // the handle looks from the sun toward the scene
                pivot.setRotation(lookRotation(d.clone().mulScalar(-1), new Quat()));
            } else {
                pivot.setPosition(l.position[0], l.position[1], l.position[2]);
                pivot.setRotation(lookRotation(new Vec3(l.direction[0], l.direction[1], l.direction[2]), new Quat()));
            }
            attach(rotate);
            return;
        }
        detach();
    }

    const onStart = () => {
        dragging = true;
        if (target === 'light') events.fire('light.editStart');
        if (target === 'camera' || target === 'cameraTarget') events.fire('shotCameras.gestureStart');
        startPos.copy(pivot.getPosition());
        startRot.copy(pivot.getRotation());
        if (target === 'camera') {
            const p = cameraValue('position');
            const t = cameraValue('target');
            if (p && t) {
                startDir.copy(t).sub(p);
                startLen = Math.max(0.01, startDir.length());
            }
        }
    };

    const onMove = () => {
        if (target === 'cameraTarget') {
            if (selectedCamera()) events.fire('shotCameras.setValue', 'target', pivot.getPosition().clone());
            return;
        }
        if (target === 'camera') {
            if (!selectedCamera()) return;
            if (attached === translate) {
                const p = pivot.getPosition();
                events.fire('shotCameras.setValue', 'position', p.clone());
                events.fire('shotCameras.setValue', 'target', p.clone().add(startDir));
            } else {
                const dir = new Vec3();
                pivot.getRotation().transformVector(FORWARD, dir);
                // no looking straight up or down: the view would flip
                const len = dir.length() || 1;
                const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y / len)));
                if (Math.abs(pitch) > 89 * DEG) return;
                events.fire('shotCameras.setValue', 'target', startPos.clone().add(dir.normalize().mulScalar(startLen)));
            }
            return;
        }
        if (target === 'light') {
            const l = selectedLight();
            if (!l) return;
            const dir = new Vec3();
            pivot.getRotation().transformVector(FORWARD, dir);
            dir.normalize();
            if (l.type === 'spot') {
                events.fire('light.update', l.id, { direction: [dir.x, dir.y, dir.z] });
            } else if (l.type === 'sun') {
                // the handle looks toward the scene: the sun is the other way
                const s = dir.mulScalar(-1);
                events.fire('light.update', l.id, {
                    azimuth: Math.atan2(s.x, s.z) / DEG,
                    elevation: Math.max(-89, Math.min(89, Math.asin(Math.max(-1, Math.min(1, s.y))) / DEG))
                });
            }
        }
    };

    const onEnd = () => {
        dragging = false;
        if (target === 'light') events.fire('light.editEnd', 'lightRotate');
        if (target === 'camera' || target === 'cameraTarget') events.fire('shotCameras.gestureEnd');
        update();
    };

    for (const gizmo of [translate, rotate]) {
        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });
        gizmo.on('transform:start', onStart);
        gizmo.on('transform:move', onMove);
        gizmo.on('transform:end', onEnd);
    }

    events.on('tool.coordSpace', (coordSpace: string) => {
        translate.coordSpace = coordSpace as 'local' | 'world';
        rotate.coordSpace = coordSpace as 'local' | 'world';
    });
    translate.coordSpace = events.invoke('tool.coordSpace') ?? 'world';
    rotate.coordSpace = translate.coordSpace;

    const updateSize = () => {
        const canvas = scene.canvas;
        const size = scene.camera.ortho ? 1125 / canvas.clientHeight : 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
        translate.size = size;
        rotate.size = size;
    };
    updateSize();
    events.on('camera.resize', updateSize);
    events.on('camera.ortho', updateSize);

    ['tool.activated', 'tool.deactivated', 'shotCameras.changed', 'shotCameras.select', 'camera.valuesChanged',
        'timeline.frame', 'light.changed', 'light.selected', 'edit.apply'].forEach(name => events.on(name, () => update()));
};

export { registerObjectGizmo, type TransformTarget };
