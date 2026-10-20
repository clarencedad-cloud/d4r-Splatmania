import { AnimTrack } from './anim-track';
import { AnimTrackEditOp } from './edit-ops';
import { Events } from './events';

/**
 * Manages the active animation track and provides undo-wrapped
 * key operations. Resolves which track the user is interacting
 * with and ensures all mutations are undoable.
 *
 * The key target follows the last pick: a splat selected in the scene
 * manager (or its timeline row) targets that layer's track, a camera picked
 * in the camera list (or its row) targets that camera's track.
 */
const registerTrackManagerEvents = (events: Events) => {
    let target: 'camera' | 'layer' | 'section' = 'camera';
    let autoKey = false;

    // the selection is registered after the ui (which already asks for the
    // key target), so it is resolved lazily
    const layerTrack = () => {
        const splat = (events.functions.has('selection') ? events.invoke('selection') : null);
        return splat ? events.invoke('layerAnim.state', splat)?.track ?? null : null;
    };

    // Get the animation track of the key target
    const getActiveTrack = (): AnimTrack | null => {
        if (target === 'section' && events.functions.has('section.track')) {
            return events.invoke('section.track');
        }
        if (target === 'layer') {
            const track = layerTrack();
            if (track) return track;
        }
        return events.invoke('camera.animTrack') ?? null;
    };

    // what a key goes to, for the timeline label and row highlight
    events.function('track.target', () => {
        if (target === 'section') {
            return { kind: 'section', name: 'Schnitt', color: [255, 102, 0] };
        }
        const splat = (events.functions.has('selection') ? events.invoke('selection') : null);
        if (target === 'layer' && splat) {
            return { kind: 'layer', name: splat.name, color: [255, 160, 60], splat };
        }
        const camera = events.invoke('shotCameras.selected');
        return { kind: 'camera', name: camera?.name ?? 'Kamera', color: camera?.color ?? [0, 220, 255], camera };
    });

    const setTarget = (value: 'camera' | 'layer' | 'section') => {
        target = value;
        events.fire('track.target', events.invoke('track.target'));
        // the ruler and the key buttons show the active track's keys
        events.fire('track.keysLoaded');
    };

    events.on('selection.changed', (splat: unknown) => setTarget(splat ? 'layer' : 'camera'));
    // picking the already selected splat again changes nothing in the
    // selection but still makes it the key target
    events.on('selection', (splat: unknown) => {
        if (splat && splat === (events.functions.has('selection') ? events.invoke('selection') : null) && target !== 'layer') setTarget('layer');
    });
    events.on('shotCameras.select', () => setTarget('camera'));
    // the section track: picked by opening the section tool or its row
    events.on('tool.activated', (toolName: string) => {
        if (toolName === 'section') setTarget('section');
    });
    events.on('section.selectTrack', () => setTarget('section'));
    events.on('section.trackChanged', () => {
        if (target === 'section') events.fire('track.keysLoaded');
    });
    events.on('shotCameras.changed', () => events.fire('track.target', events.invoke('track.target')));
    events.on('splat.name', () => events.fire('track.target', events.invoke('track.target')));

    // a layer track edit refreshes the ruler when it is the active one
    events.on('layerAnim.trackChanged', (track: AnimTrack) => {
        if (track === getActiveTrack()) events.fire('track.keysLoaded');
    });

    // auto key: transform edits (gizmo drag or transform panel, both end in
    // pivot.ended) and opacity edits of the selected layer key the current
    // frame. Playback moves layers without touching the pivot's edit cycle,
    // so it never auto-keys
    events.function('track.autoKey', () => autoKey);
    events.on('track.setAutoKey', (value: boolean) => {
        autoKey = value;
        events.fire('track.autoKey', autoKey);
    });

    let opacityTimer = -1;
    const autoKeyLayer = () => {
        if (autoKey && target === 'layer' && layerTrack()) {
            events.fire('track.addKey');
        }
    };
    events.on('pivot.ended', () => autoKeyLayer());
    events.on('layerAnim.opacityEdited', () => {
        window.clearTimeout(opacityTimer);
        opacityTimer = window.setTimeout(autoKeyLayer, 250);
    });

    // Helper: execute an edit on the active track wrapped in undo.
    // The editFn must return true if it modified the track, false if it was a no-op.
    const trackEdit = (name: string, editFn: (track: AnimTrack) => boolean) => {
        const track = getActiveTrack();
        if (!track) return;
        const before = track.snapshot();
        if (!editFn(track)) return;
        const after = track.snapshot();
        events.fire('edit.add', new AnimTrackEditOp(name, track, before, after), true);
    };

    // Get keys from active track
    events.function('track.keys', () => {
        const track = getActiveTrack();
        return track ? track.keys : [];
    });

    // Add key to active track
    events.on('track.addKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        trackEdit('addKey', track => track.addKey(keyFrame));
    });

    // Remove key from active track
    events.on('track.removeKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        trackEdit('removeKey', track => track.removeKey(keyFrame));
    });

    // Move key in active track
    events.on('track.moveKey', (fromFrame: number, toFrame: number) => {
        trackEdit('moveKey', track => track.moveKey(fromFrame, toFrame));
    });

    // cut track edits (src/camera-poses.ts CutTrack), undoable like key edits
    const cutEdit = (name: string, editFn: (cut: any) => boolean) => {
        const cut = events.invoke('cut.track');
        if (!cut) return;
        const before = cut.snapshot();
        if (!editFn(cut)) return;
        events.fire('edit.add', new AnimTrackEditOp(name, cut, before, cut.snapshot()), true);
    };

    // frames [start, end) cut to cameraId (default: the selected camera)
    events.on('cut.set', (start: number, end: number, cameraId?: number) => {
        const id = cameraId ?? events.invoke('shotCameras.selected')?.id;
        if (id === undefined) return;
        cutEdit('cutSet', cut => cut.set(start, end, id));
    });

    events.on('cut.removeAt', (frame: number) => {
        cutEdit('cutRemove', cut => cut.removeAt(frame));
    });

    // Copy key in active track
    events.on('track.copyKey', (fromFrame: number, toFrame: number) => {
        trackEdit('copyKey', track => track.copyKey(fromFrame, toFrame));
    });
};

export { registerTrackManagerEvents };
