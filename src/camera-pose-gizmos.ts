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

// temp vectors for frustum geometry calculation (module-scope to avoid allocations)
const tmpForward = new Vec3();
const tmpRight = new Vec3();
const tmpUp = new Vec3();
const tmpBase = new Vec3();
const tmpTL = new Vec3();
const tmpTR = new Vec3();
const tmpBL = new Vec3();
const tmpBR = new Vec3();
const tmpUpTip = new Vec3();

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

        // camera pyramid with the pose's fov at a 16:9 aspect
        const pushFrustum = (position: Vec3, target: Vec3, fov: number, depth: number, c: number[]) => {
            tmpForward.sub2(target, position);
            if (tmpForward.lengthSq() === 0) return;
            tmpForward.normalize();

            // right direction (handle degenerate case when looking straight up/down)
            if (Math.abs(tmpForward.y) > 0.999) {
                tmpRight.cross(tmpForward, Vec3.BACK).normalize();
            } else {
                tmpRight.cross(tmpForward, Vec3.UP).normalize();
            }
            tmpUp.cross(tmpRight, tmpForward);

            const halfH = depth * Math.tan((fov ?? 60) * Math.PI / 360);
            const halfW = halfH * 16 / 9;

            tmpBase.copy(position).addScaled(tmpForward, depth);
            tmpTL.copy(tmpBase).addScaled(tmpUp, halfH).addScaled(tmpRight, -halfW);
            tmpTR.copy(tmpBase).addScaled(tmpUp, halfH).addScaled(tmpRight, halfW);
            tmpBL.copy(tmpBase).addScaled(tmpUp, -halfH).addScaled(tmpRight, -halfW);
            tmpBR.copy(tmpBase).addScaled(tmpUp, -halfH).addScaled(tmpRight, halfW);

            pushLine(position, tmpTL, c);
            pushLine(position, tmpTR, c);
            pushLine(position, tmpBL, c);
            pushLine(position, tmpBR, c);
            pushLine(tmpTL, tmpTR, c);
            pushLine(tmpTR, tmpBR, c);
            pushLine(tmpBR, tmpBL, c);
            pushLine(tmpBL, tmpTL, c);

            // up indicator triangle
            tmpUpTip.copy(tmpBase).addScaled(tmpUp, halfH * 1.5);
            pushLine(tmpTL, tmpUpTip, c);
            pushLine(tmpTR, tmpUpTip, c);
        };

        const pathA = new Vec3();
        const pathB = new Vec3();

        for (const camera of cameras) {
            const poses = camera.track.getPoses();
            if (poses.length === 0) continue;

            const isSelected = camera === selected;
            const full = camera.color;
            const dim = full.map(v => Math.round(v * 0.45));

            // keyframes: small pyramids
            for (const pose of poses) {
                pushFrustum(pose.position, pose.target, pose.fov, size * 0.5, isSelected ? full : dim);
            }

            // path through the spline
            if (showPaths && frames > 1) {
                const steps = Math.min(frames - 1, 240);
                let prev: Vec3 | null = null;
                for (let i = 0; i <= steps; i++) {
                    const pose = camera.track.getPoseAt(i / steps * (frames - 1));
                    if (!pose) break;
                    const point = (i % 2 === 0 ? pathA : pathB).copy(pose.position);
                    if (prev) pushLine(prev, point, isSelected ? full : dim);
                    prev = point;
                }
            }

            // current pose: a full-size frustum
            if (camera !== followed) {
                const current = camera.track.getPoseAt(this.frame);
                if (current) {
                    pushFrustum(current.position, current.target, current.fov, size * (isSelected ? 1.4 : 1), full);
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
