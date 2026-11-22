import { Mat4, Quat, Vec3 } from 'playcanvas';

import { AnimTrackEditOp, EntityTransformOp } from '../edit-ops';
import { Events } from '../events';
import type { LayerAnimTrack } from '../layer-anim';
import type { Splat } from '../splat';
import { Transform } from '../transform';

// Undoable ops that apply a world-space correction to a layer: its transform,
// and the keys of its layer animation (so an animated layer moves as a whole).
// Shared by the align tool (src/align/align-tool.ts) and the scan composition
// (src/compose/compose-tool.ts); put the ops into one MultiOp for one undo step.

// correction m (world, may include uniform scale), its rotation r and the
// scale factor
const correctionOps = (events: Events, splat: Splat, m: Mat4, r: Quat, scaleFactor: number) => {
    const ops: any[] = [];
    const parent = splat.entity.parent;
    const parentInv = new Mat4().copy(parent.getWorldTransform()).invert();
    const parentRotInv = parent.getRotation().clone().invert();

    const entity = splat.entity;
    const oldt = new Transform(entity.getLocalPosition().clone(), entity.getLocalRotation().clone(), entity.getLocalScale().clone());
    const position = parentInv.transformPoint(m.transformPoint(entity.getPosition(), new Vec3()), new Vec3());
    const rotation = new Quat().mul2(parentRotInv, new Quat().mul2(r, entity.getRotation()));
    const scale = oldt.scale.clone().mulScalar(scaleFactor);
    ops.push(new EntityTransformOp({ splat, oldt, newt: new Transform(position, rotation, scale) }));

    const track = events.invoke('layerAnim.state', splat)?.track as LayerAnimTrack;
    if (track && track.keyData.some(k => k.position || k.rotation || k.scale)) {
        const before = track.snapshot();
        const after = track.snapshot();
        for (const key of after.keys) {
            if (key.position) {
                const world = parent.getWorldTransform().transformPoint(key.position, new Vec3());
                key.position = parentInv.transformPoint(m.transformPoint(world, new Vec3()), new Vec3());
            }
            if (key.rotation) {
                const world = new Quat().mul2(parent.getRotation(), key.rotation);
                key.rotation = new Quat().mul2(parentRotInv, new Quat().mul2(r, world));
            }
            if (key.scale) key.scale = key.scale.clone().mulScalar(scaleFactor);
        }
        ops.push(new AnimTrackEditOp('alignKeys', track, before, after));
    }
    return ops;
};

// a world correction given as column-major matrix (with uniform scale)
const matrixOps = (events: Events, splat: Splat, matrix: number[], scale: number) => {
    const m = new Mat4();
    m.data.set(matrix);
    // rotation from the 3x3 part with the scale removed
    const unscaled = new Mat4().copy(m);
    const d = unscaled.data;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) d[i * 4 + j] /= scale;
    }
    d[12] = d[13] = d[14] = 0;
    return correctionOps(events, splat, m, new Quat().setFromMat4(unscaled), scale);
};

export { correctionOps, matrixOps };
