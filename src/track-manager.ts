import { Quat, Vec3 } from 'playcanvas';

import { AnimTrack } from './anim-track';
import { AnimTrackEditOp, MultiOp } from './edit-ops';
import { Events } from './events';
import { i18n } from './ui/localization';

// display names of the channels, for the key target label
const CHANNEL_NAMES: Record<string, string> = {
    position: 'sm.channel.position',
    target: 'sm.channel.rotation',
    rotation: 'sm.channel.rotation',
    scale: 'sm.channel.scale',
    fov: 'sm.channel.lens',
    focus: 'sm.channel.focus',
    aperture: 'sm.channel.aperture',
    opacity: 'sm.channel.opacity',
    mix: 'sm.channel.mix'
};

/**
 * Manages the key target of the timeline's key button and provides
 * undo-wrapped key operations.
 *
 * The key target is the selected object: a splat selected in the scene
 * manager (or its timeline row) targets that layer, a camera picked in the
 * camera list (or its row) targets that camera. The section track is only
 * the target after clicking its timeline row. Every property also has its
 * own key button next to its value (cameras, transform, layer animation,
 * section), which keys exactly that property.
 *
 * Auto key keys exactly the properties that changed, at the moment they
 * change.
 */
const registerTrackManagerEvents = (events: Events) => {
    let target: 'camera' | 'layer' | 'section' | 'look' | 'light' = 'camera';
    let autoKey = false;

    const selection = () => (events.functions.has('selection') ? events.invoke('selection') : null);

    // the selection is registered after the ui (which already asks for the
    // key target), so it is resolved lazily
    const layerTrack = () => {
        const splat = selection();
        return splat ? events.invoke('layerAnim.state', splat)?.track ?? null : null;
    };

    // Get the animation track of the key target
    const getActiveTrack = (): AnimTrack | null => {
        if (target === 'section' && events.functions.has('section.track')) {
            return events.invoke('section.track');
        }
        if (target === 'look' && events.functions.has('look.track')) {
            return events.invoke('look.track');
        }
        if (target === 'light' && events.functions.has('light.track')) {
            return events.invoke('light.track');
        }
        if (target === 'layer') {
            const track = layerTrack();
            if (track) return track;
        }
        return events.invoke('camera.animTrack') ?? null;
    };

    const frameNow = () => Math.round(events.invoke('timeline.frame') ?? 0);

    // which properties the key button keys on the target
    const targetChannels = (): string[] => {
        const track = getActiveTrack() as any;
        if (!track) return [];
        if (target === 'section' || target === 'look' || target === 'light') return [];
        return track.addKeyChannels ? track.addKeyChannels(frameNow()) : [];
    };

    // what a key goes to, for the timeline label and row highlight
    events.function('track.target', () => {
        const channels = targetChannels()
        // position + rotation of a camera read as one
        .map(c => i18n.t(CHANNEL_NAMES[c] ?? c))
        .filter((name, i, all) => all.indexOf(name) === i);
        if (target === 'section') {
            return { kind: 'section', name: i18n.t('sm.section.title'), color: [194, 14, 126], channels };
        }
        if (target === 'look') {
            return { kind: 'look', name: i18n.t('sm.look.title'), color: [255, 184, 64], channels };
        }
        if (target === 'light') {
            return { kind: 'light', name: i18n.t('sm.light.title'), color: [255, 226, 120], channels };
        }
        const splat = selection();
        if (target === 'layer' && splat) {
            return { kind: 'layer', name: splat.name, color: [230, 18, 138], splat, channels };
        }
        const camera = events.invoke('shotCameras.selected');
        return { kind: 'camera', name: camera?.name ?? i18n.t('sm.cameras.camera'), color: camera?.color ?? [0, 220, 255], camera, channels };
    });

    const refreshTarget = () => events.fire('track.target', events.invoke('track.target'));
    // the listed channels change with the frame and edits: only the label
    // updates (track.target rebuilds the timeline rows)
    const refreshLabel = () => events.fire('track.targetLabel', events.invoke('track.target'));

    const setTarget = (value: 'camera' | 'layer' | 'section' | 'look' | 'light') => {
        target = value;
        refreshTarget();
        // the ruler and the key buttons show the active track's keys
        events.fire('track.keysLoaded');
    };

    events.on('selection.changed', (splat: unknown) => setTarget(splat ? 'layer' : 'camera'));
    // picking the already selected splat again changes nothing in the
    // selection but still makes it the key target
    events.on('selection', (splat: unknown) => {
        if (splat && splat === selection() && target !== 'layer') setTarget('layer');
    });
    events.on('shotCameras.select', () => setTarget('camera'));
    // a new camera becomes the key target too
    events.on('shotCameras.add', () => setTarget('camera'));
    events.on('shotCameras.duplicate', () => setTarget('camera'));
    events.on('section.selectTrack', () => setTarget('section'));
    events.on('section.trackChanged', () => {
        if (target === 'section') events.fire('track.keysLoaded');
    });
    events.on('look.selectTrack', () => setTarget('look'));
    events.on('look.trackChanged', () => {
        if (target === 'look') events.fire('track.keysLoaded');
    });
    events.on('light.selectTrack', () => setTarget('light'));
    events.on('light.trackChanged', () => {
        if (target === 'light') events.fire('track.keysLoaded');
    });
    events.on('shotCameras.changed', refreshTarget);
    events.on('splat.name', refreshTarget);
    // the listed channels depend on the frame and on what changed
    events.on('timeline.frame', refreshLabel);
    events.on('camera.valuesChanged', refreshLabel);
    events.on('layerAnim.changed', refreshLabel);
    events.on('track.keyAdded', refreshLabel);
    events.on('track.keyRemoved', refreshLabel);
    events.on('pivot.ended', () => queueMicrotask(refreshLabel));

    // a layer track edit refreshes the ruler when it is the active one
    events.on('layerAnim.trackChanged', (track: AnimTrack) => {
        if (track === getActiveTrack()) events.fire('track.keysLoaded');
    });

    events.function('track.autoKey', () => autoKey);
    events.on('track.setAutoKey', (value: boolean) => {
        autoKey = value;
        events.fire('track.autoKey', autoKey);
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

    // pending edits: tracks whose value the user changed at the current
    // frame without keying it. The key button keys them together with the
    // key target, in one undo step. Moving to another frame drops them (the
    // keyed tracks re-evaluate there and the edit is gone anyway)
    const pending = new Set<AnimTrack>();
    let pendingFrame = 0;
    const markPending = (track: AnimTrack | null) => {
        if (!track) return;
        pending.add(track);
        events.fire('track.pending', pending.size);
    };
    const clearPending = () => {
        if (pending.size === 0) return;
        pending.clear();
        events.fire('track.pending', 0);
    };
    const frameMoved = (frame: number) => {
        if (frame !== pendingFrame) {
            pendingFrame = frame;
            clearPending();
        }
    };
    events.on('timeline.frame', frameMoved);
    events.on('timeline.time', frameMoved);
    events.function('track.pending', () => Array.from(pending));
    events.on('track.markPending', (track: AnimTrack) => markPending(track));

    const trackOf = (splat: unknown) => (splat ? events.invoke('layerAnim.state', splat)?.track ?? null : null);

    // layer transform edits (gizmo drag or transform panel, both a pivot
    // start / end cycle): compare before and after, so auto key keys only
    // what moved. Playback moves layers without the pivot, so it never keys
    let pivotStart: { splat: any, position: Vec3, rotation: Quat, scale: Vec3 } | null = null;
    events.on('pivot.started', () => {
        const splat = selection();
        pivotStart = splat ? {
            splat,
            position: splat.entity.getLocalPosition().clone(),
            rotation: splat.entity.getLocalRotation().clone(),
            scale: splat.entity.getLocalScale().clone()
        } : null;
    });
    events.on('pivot.ended', () => {
        const splat = selection();
        const start = pivotStart;
        pivotStart = null;
        if (!splat || !start || start.splat !== splat) return;
        const e = splat.entity;
        const channels: string[] = [];
        if (e.getLocalPosition().distance(start.position) > 1e-6) channels.push('position');
        if (Math.abs(Math.abs(e.getLocalRotation().dot(start.rotation)) - 1) > 1e-7) channels.push('rotation');
        if (e.getLocalScale().distance(start.scale) > 1e-6) channels.push('scale');
        if (channels.length === 0) return;
        if (autoKey) {
            events.fire('layerAnim.keyChannels', splat, channels);
        } else {
            markPending(trackOf(splat));
        }
    });

    // opacity / point mix edits of a layer (debounced: sliders fire often)
    const layerTimers = new Map<string, number>();
    const layerValueEdited = (splat: unknown, channel: string) => {
        if (!splat) return;
        if (!autoKey) {
            markPending(trackOf(splat));
            return;
        }
        window.clearTimeout(layerTimers.get(channel));
        layerTimers.set(channel, window.setTimeout(() => events.fire('layerAnim.keyChannels', splat, [channel]), 250));
    };
    events.on('layerAnim.opacityEdited', (splat: unknown) => layerValueEdited(splat, 'opacity'));
    events.on('layerAnim.mixEdited', (splat: unknown) => layerValueEdited(splat, 'mix'));

    // section cut height
    let sectionTimer = -1;
    events.on('section.set', (value: { value?: number }) => {
        if (value.value === undefined || !events.functions.has('section.track')) return;
        if (!autoKey) {
            markPending(events.invoke('section.track'));
            return;
        }
        window.clearTimeout(sectionTimer);
        sectionTimer = window.setTimeout(() => events.fire('section.addKey'), 250);
    });

    // look edits, once the look is animated (a static look needs no keys)
    let lookTimer = -1;
    events.on('look.set', () => {
        if (!events.functions.has('look.track')) return;
        const track = events.invoke('look.track') as AnimTrack;
        if (track.keys.length === 0) return;
        if (!autoKey) {
            markPending(track);
            return;
        }
        window.clearTimeout(lookTimer);
        lookTimer = window.setTimeout(() => events.fire('look.addKey'), 250);
    });

    // light edits, once the light rig is animated
    let lightTimer = -1;
    const lightEdited = () => {
        if (!events.functions.has('light.track')) return;
        const track = events.invoke('light.track') as AnimTrack;
        if (track.keys.length === 0) return;
        if (!autoKey) {
            markPending(track);
            return;
        }
        window.clearTimeout(lightTimer);
        lightTimer = window.setTimeout(() => events.fire('light.addKey'), 250);
    };
    ['light.set', 'light.update', 'light.remove'].forEach(name => events.on(name, lightEdited));

    // Get keys from active track
    events.function('track.keys', () => {
        const track = getActiveTrack();
        return track ? track.keys : [];
    });

    // Add key to active track, plus every track with a pending edit
    events.on('track.addKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        const tracks = new Set<AnimTrack>(pending);
        const active = getActiveTrack();
        if (active) tracks.add(active);
        const ops: AnimTrackEditOp[] = [];
        tracks.forEach((track) => {
            const before = track.snapshot();
            if (track.addKey(keyFrame)) ops.push(new AnimTrackEditOp('addKey', track, before, track.snapshot()));
        });
        clearPending();
        if (ops.length === 1) events.fire('edit.add', ops[0], true);
        else if (ops.length > 1) events.fire('edit.add', new MultiOp(ops), true);
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

    // move one edge of the segment at frame (trim / roll)
    events.on('cut.trim', (frame: number, edge: 'start' | 'end', to: number) => {
        cutEdit('cutTrim', cut => cut.trim(frame, edge, to));
    });

    // another camera for the segment at frame
    events.on('cut.setCamera', (frame: number, cameraId: number) => {
        cutEdit('cutCamera', cut => cut.setCamera(frame, cameraId));
    });

    // cut to cameraId at frame, up to the next cut
    events.on('cut.cutTo', (frame: number, cameraId: number) => {
        cutEdit('cutTo', cut => cut.cutTo(frame, cameraId, events.invoke('timeline.frames')));
    });

    // cross-fade length (frames) of the cut the segment at frame starts with
    events.on('cut.setFade', (frame: number, fade: number) => {
        cutEdit('cutFade', cut => cut.setFade(frame, fade));
    });

    // Copy key in active track
    events.on('track.copyKey', (fromFrame: number, toFrame: number) => {
        trackEdit('copyKey', track => track.copyKey(fromFrame, toFrame));
    });
};

export { registerTrackManagerEvents };
