import {
    PRIMITIVE_LINES,
    SEMANTIC_COLOR,
    SEMANTIC_POSITION,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import type { ShotCamera } from './camera-poses';
import { Element, ElementType } from './element';
import { vertexShader, fragmentShader } from './shaders/debug-shader';

// temp vectors for the camera icon (module-scope to avoid allocations)
const tmpForward = new Vec3();
const tmpRight = new Vec3();
const tmpUp = new Vec3();

class CameraPoseGizmos extends Element {
    entity: Entity;
    mesh: Mesh;
    material: ShaderMaterial;
    meshInstance: MeshInstance;
    dirty = true;
    // timeline frame the current-pose frustums are drawn at
    frame = 0;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const scene = this.scene;
        const device = scene.graphicsDevice;

        this.material = new ShaderMaterial({
            uniqueName: 'cameraPoseGizmoMaterial',
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                vertex_color: SEMANTIC_COLOR
            },
            vertexWGSL: vertexShader,
            fragmentWGSL: fragmentShader
        });
        this.material.depthWrite = true;
        this.material.depthTest = true;
        this.material.update();

        this.mesh = new Mesh(device);
        this.mesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_LINES,
            base: 0,
            count: 0
        };

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        this.meshInstance.cull = false;

        this.entity = new Entity('cameraPoseGizmos');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [scene.worldLayer.id]
        });

        scene.app.root.addChild(this.entity);

        // mark dirty when poses or scene bound change
        const markDirty = () => {
            this.dirty = true;
            if (scene.events.invoke('camera.showPoses')) {
                scene.forceRender = true;
            }
        };
        const { events } = scene;
        events.on('track.keyAdded', markDirty);
        events.on('track.keyRemoved', markDirty);
        events.on('track.keyMoved', markDirty);
        events.on('track.keyUpdated', markDirty);
        events.on('track.keysCleared', markDirty);
        events.on('track.keysLoaded', markDirty);
        events.on('scene.boundChanged', markDirty);
        events.on('track.changed', markDirty);
        events.on('shotCameras.changed', markDirty);
        events.on('camera.viewMode', markDirty);
        events.on('camera.showPaths', markDirty);
        events.on('camera.valuesChanged', markDirty);
        events.on('transform.target', markDirty);
        events.on('timeline.frame', (frame: number) => {
            this.frame = frame;
            markDirty();
        });
        events.on('timeline.time', (time: number) => {
            this.frame = time;
            markDirty();
        });
    }

    destroy() {
        this.entity?.destroy();
    }

    onPreRender() {
        const { scene } = this;
        const visible = scene.events.invoke('camera.showPoses') && scene.camera.renderOverlays;

        if (visible && this.dirty) {
            this.dirty = false;
            this.rebuildMesh();
        }

        // with no poses the mesh has never been given a vertex buffer, and a
        // count-0 non-instanced draw is still submitted and still validates its
        // attributes - so stay disabled until there is geometry
        this.entity.enabled = visible && this.mesh.primitive[0].count > 0;
    }

    private rebuildMesh() {
        const { events } = this.scene;
        const cameras = events.invoke('shotCameras.list') as ShotCamera[] ?? [];
        const frames = events.invoke('timeline.frames') as number;
        const showPaths = events.invoke('camera.showPaths') as boolean;
        const selected = events.invoke('shotCameras.selected') as ShotCamera;
        // the camera the viewport is looking through sits at the eye; drawing
        // it would only put lines across the screen
        const followed = events.invoke('shotCameras.followed') as ShotCamera | null;

        // gizmo size follows the scene so it reads at any scale
        const bound = this.scene.bound;
        const radius = bound ? bound.halfExtents.length() : 1;
        const size = Math.max(0.05, radius * 0.06);

        const positions: number[] = [];
        const colors: number[] = [];

        const pushLine = (a: Vec3, b: Vec3, c: number[]) => {
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            colors.push(c[0], c[1], c[2], 255, c[0], c[1], c[2], 255);
        };


        // a keyframe: a small diamond (octahedron) at the key position, not
        // a second camera
        const keyCorners = [new Vec3(), new Vec3(), new Vec3(), new Vec3(), new Vec3(), new Vec3()];
        const pushKey = (position: Vec3, r: number, c: number[]) => {
            const [px, nx, py, ny, pz, nz] = keyCorners;
            px.copy(position).x += r;
            nx.copy(position).x -= r;
            py.copy(position).y += r;
            ny.copy(position).y -= r;
            pz.copy(position).z += r;
            nz.copy(position).z -= r;
            for (const a of [px, nx]) {
                for (const b of [py, ny, pz, nz]) pushLine(a, b, c);
            }
            for (const a of [py, ny]) {
                for (const b of [pz, nz]) pushLine(a, b, c);
            }
        };

        // the path: a dashed line along the spline, dashes measured in world
        // units so they read evenly at any speed of the move
        const dashA = new Vec3();
        const dashB = new Vec3();
        const pushDashed = (points: Vec3[], dash: number, gap: number, c: number[]) => {
            let on = true;
            let left = dash;
            for (let i = 1; i < points.length; i++) {
                const a = points[i - 1];
                const b = points[i];
                const len = a.distance(b);
                if (len <= 0) continue;
                for (let t = 0; t < len;) {
                    const step = Math.min(left, len - t);
                    if (on) {
                        dashA.lerp(a, b, t / len);
                        dashB.lerp(a, b, (t + step) / len);
                        pushLine(dashA, dashB, c);
                    }
                    t += step;
                    left -= step;
                    if (left <= 1e-9) {
                        on = !on;
                        left = on ? dash : gap;
                    }
                }
            }
        };

        // a small stylised camera at the pose: body, lens hood opening toward
        // the view and two film reels on top, so the direction reads at once
        const iconP = new Vec3();
        const iconQ = new Vec3();
        const at = (out: Vec3, origin: Vec3, f: number, r: number, u: number) => out.copy(origin)
        .addScaled(tmpForward, f)
        .addScaled(tmpRight, r)
        .addScaled(tmpUp, u);
        const pushBox = (origin: Vec3, f0: number, f1: number, hr: number, hu: number, c: number[]) => {
            const corners: Vec3[] = [];
            for (const f of [f0, f1]) {
                for (const [r, u] of [[-hr, -hu], [hr, -hu], [hr, hu], [-hr, hu]]) corners.push(at(new Vec3(), origin, f, r, u));
            }
            for (let i = 0; i < 4; i++) {
                pushLine(corners[i], corners[(i + 1) % 4], c);
                pushLine(corners[4 + i], corners[4 + (i + 1) % 4], c);
                pushLine(corners[i], corners[4 + i], c);
            }
        };
        const pushCircle = (origin: Vec3, f: number, u: number, radius: number, c: number[]) => {
            const n = 12;
            for (let i = 0; i < n; i++) {
                const a0 = i / n * Math.PI * 2;
                const a1 = (i + 1) / n * Math.PI * 2;
                at(iconP, origin, f + Math.cos(a0) * radius, 0, u + Math.sin(a0) * radius);
                at(iconQ, origin, f + Math.cos(a1) * radius, 0, u + Math.sin(a1) * radius);
                pushLine(iconP, iconQ, c);
            }
        };
        const pushCameraIcon = (position: Vec3, target: Vec3, s: number, c: number[]) => {
            tmpForward.sub2(target, position);
            if (tmpForward.lengthSq() === 0) return;
            tmpForward.normalize();
            if (Math.abs(tmpForward.y) > 0.999) {
                tmpRight.cross(tmpForward, Vec3.BACK).normalize();
            } else {
                tmpRight.cross(tmpForward, Vec3.UP).normalize();
            }
            tmpUp.cross(tmpRight, tmpForward);
            // body behind the eye
            pushBox(position, -0.95 * s, -0.25 * s, 0.22 * s, 0.28 * s, c);
            // lens hood: narrow at the body, wide at the eye
            const lens: Vec3[] = [];
            for (const [f, h] of [[-0.25 * s, 0.1 * s], [0.12 * s, 0.2 * s]]) {
                for (const [r, u] of [[-h, -h], [h, -h], [h, h], [-h, h]]) lens.push(at(new Vec3(), position, f, r, u));
            }
            for (let i = 0; i < 4; i++) {
                pushLine(lens[4 + i], lens[4 + (i + 1) % 4], c);
                pushLine(lens[i], lens[4 + i], c);
            }
            // reels
            pushCircle(position, -0.4 * s, 0.28 * s + 0.16 * s, 0.16 * s, c);
            pushCircle(position, -0.78 * s, 0.28 * s + 0.16 * s, 0.16 * s, c);
        };

        // the look-at target: a small sphere of three rings
        const pushTarget = (p: Vec3, r: number, c: number[]) => {
            const n = 12;
            for (let axis = 0; axis < 3; axis++) {
                for (let i = 0; i < n; i++) {
                    const a0 = i / n * Math.PI * 2;
                    const a1 = (i + 1) / n * Math.PI * 2;
                    const set = (out: Vec3, a: number) => {
                        const x = Math.cos(a) * r;
                        const y = Math.sin(a) * r;
                        out.copy(p);
                        if (axis === 0) out.add(new Vec3(x, y, 0));
                        else if (axis === 1) out.add(new Vec3(x, 0, y));
                        else out.add(new Vec3(0, x, y));
                    };
                    set(iconP, a0);
                    set(iconQ, a1);
                    pushLine(iconP, iconQ, c);
                }
            }
        };

        const targetPicked = events.functions.has('transform.target') && events.invoke('transform.target') === 'cameraTarget';

        for (const camera of cameras) {
            const poses = camera.track.getPoses();
            // a placed camera without keys still shows where it is
            if (poses.length === 0 && !camera.track.placed) continue;

            const isSelected = camera === selected;
            const full = camera.color;
            const dim = full.map(v => Math.round(v * 0.45));

            // keyframes: small points on the path
            for (const pose of poses) {
                pushKey(pose.position, size * (isSelected ? 0.22 : 0.16), isSelected ? full : dim);
            }

            // path through the spline, dashed
            if (showPaths && frames > 1 && poses.length > 1) {
                const steps = Math.min(frames - 1, 240);
                const points: Vec3[] = [];
                for (let i = 0; i <= steps; i++) {
                    const pose = camera.track.getPoseAt(i / steps * (frames - 1));
                    if (!pose) break;
                    points.push(pose.position.clone());
                }
                pushDashed(points, size * 0.3, size * 0.2, isSelected ? full : dim);
            }

            // current pose: the camera icon; the selected camera also shows
            // where it looks: its target, a dashed line to it and, when the
            // target is animated, the target's own path and keys
            const current = camera.track.getPoseAt(this.frame);
            if (current && camera !== followed) {
                pushCameraIcon(current.position, current.target, size * (isSelected ? 2.2 : 1.6), full);
            }
            if (current && isSelected) {
                const targetColor = targetPicked ? [255, 255, 255] : full;
                pushTarget(current.target, size * (targetPicked ? 0.28 : 0.2), targetColor);
                if (camera !== followed) pushDashed([current.position, current.target], size * 0.12, size * 0.12, dim);
                if (showPaths && frames > 1 && camera.track.isAnimated('target')) {
                    const steps = Math.min(frames - 1, 240);
                    const points: Vec3[] = [];
                    for (let i = 0; i <= steps; i++) {
                        const pose = camera.track.getPoseAt(i / steps * (frames - 1));
                        if (!pose) break;
                        points.push(pose.target.clone());
                    }
                    pushDashed(points, size * 0.15, size * 0.25, dim);
                    for (const key of camera.track.keyData) {
                        if (key.target) pushKey(key.target, size * 0.12, dim);
                    }
                }
            }
        }

        if (positions.length === 0) {
            this.mesh.primitive[0].count = 0;
            return;
        }

        this.mesh.setPositions(positions);
        this.mesh.setColors32(new Uint8Array(colors));
        this.mesh.update(PRIMITIVE_LINES);
    }
}

export { CameraPoseGizmos };
