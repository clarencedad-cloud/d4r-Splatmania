import type { Container } from '@playcanvas/pcui';

import { Events } from '../events';
import type { Scene } from '../scene';

// Depth of field: a thin-lens blur applied per splat in the projector (the
// projected gaussian widens by the circle of confusion and keeps its energy),
// so it looks the same in the viewport and in every export.
//
// Focus distance and aperture belong to the shot cameras (channels of their
// tracks in src/camera-poses.ts, keyed like any other camera property); the
// camera rig pushes the values of the camera being looked through (else the
// selected one) here via dof.lens. On / off and the blur cap stay global.

type DofState = {
    enabled: boolean,
    // distance of the focus plane from the camera (view depth, world units)
    focus: number,
    // lens radius in world units: bigger = shallower depth of field
    aperture: number,
    // cap on the blur diameter in pixels
    maxBlur: number
};

const registerDofEvents = (events: Events, scene: Scene, canvasContainer: Container) => {
    const state: DofState = { enabled: false, focus: 5, aperture: 0.05, maxBlur: 24 };
    let picking = false;

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
    // what the projector uses; null = off
    events.function('dof.params', () => (state.enabled ? { focus: state.focus, aperture: state.aperture, maxBlur: state.maxBlur } : null));

    // global settings; focus / aperture edits go to the selected camera
    events.on('dof.set', (value: Partial<DofState>) => {
        const { focus, aperture, ...rest } = value;
        Object.assign(state, rest);
        if (focus !== undefined) events.fire('shotCameras.setValue', 'focus', Math.max(0.01, focus));
        if (aperture !== undefined) events.fire('shotCameras.setValue', 'aperture', Math.max(0, aperture));
        changed();
    });

    // the rendered lens (camera rig)
    events.on('dof.lens', (value: { focus: number, aperture: number }) => {
        if (value.focus === state.focus && value.aperture === state.aperture) return;
        state.focus = value.focus;
        state.aperture = value.aperture;
        changed();
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

    // serialization: focus and aperture are saved with the cameras. Old
    // projects had one global focus track; its keys move to the first camera
    events.function('docSerialize.dof', () => ({ enabled: state.enabled, maxBlur: state.maxBlur }));
    events.function('docDeserialize.dof', (doc: any) => {
        if (!doc) return;
        if (typeof doc.enabled === 'boolean') state.enabled = doc.enabled;
        if (typeof doc.maxBlur === 'number') state.maxBlur = doc.maxBlur;
        if (doc.keys?.length || typeof doc.focus === 'number') {
            events.fire('shotCameras.importFocus', doc.keys ?? [], doc.focus, doc.aperture);
        }
        changed();
    });

    changed();
};

export { registerDofEvents, DofState };
