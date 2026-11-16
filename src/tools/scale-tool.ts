import { ScaleGizmo } from 'playcanvas';

import { TransformTool } from './transform-tool';
import { Events } from '../events';
import { Scene } from '../scene';

class ScaleTool extends TransformTool {
    constructor(events: Events, scene: Scene) {
        const gizmo = new ScaleGizmo(scene.camera.camera, scene.gizmoLayer);

        // uniform (centre) and per-axis handles; the plane handles stay off
        // (two axes at once is rarely wanted and easy to grab by accident)
        ['yz', 'xz', 'xy'].forEach((axis) => {
            gizmo.enableShape(axis as 'yz' | 'xz' | 'xy', false);
        });

        // set lower bound on scale
        gizmo.lowerBoundScale.set(1e-6, 1e-6, 1e-6);

        super(gizmo, events, scene);
    }
}

export { ScaleTool };
