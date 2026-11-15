import { Events } from '../events';
import { i18n } from './localization';

type KeyState = 'static' | 'animated' | 'keyed' | 'changed';

// events after which every key button re-reads its state
const REFRESH_EVENTS = [
    'timeline.frame', 'track.changed', 'track.keyAdded', 'track.keyRemoved', 'track.keyMoved', 'track.keyUpdated',
    'track.keysLoaded', 'track.keysCleared', 'camera.valuesChanged', 'shotCameras.changed', 'layerAnim.trackChanged',
    'layerAnim.changed', 'selection.changed', 'pivot.ended', 'pivot.moved', 'section.trackChanged', 'section.changed',
    'look.trackChanged', 'look.changed', 'light.trackChanged', 'light.changed'
];

const TIPS: Record<KeyState, string> = {
    static: 'sm.key.static',
    animated: 'sm.key.animated',
    keyed: 'sm.key.keyed',
    changed: 'sm.key.changed'
};

/**
 * The key button next to a property (like After Effects / Blender):
 * - hollow grey: not animated, a click starts animating it with a key here
 * - hollow coloured: animated, no key at this frame - a click adds one
 * - filled: a key at this frame - a click removes it
 * - orange: changed but not keyed - a click keys the new value
 */
const createKeyButton = (events: Events, getState: () => KeyState | null, onClick: () => void) => {
    const button = document.createElement('span');
    button.classList.add('key-button');

    const refresh = () => {
        const state = getState();
        button.classList.toggle('disabled', state === null);
        ['static', 'animated', 'keyed', 'changed'].forEach(s => button.classList.toggle(s, s === state));
        button.textContent = state === 'keyed' || state === 'changed' ? '◆' : '◇';
        button.title = state ? i18n.t(TIPS[state]) : '';
    };

    button.addEventListener('pointerdown', e => e.stopPropagation());
    button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (getState() === null) return;
        onClick();
        refresh();
    });

    // batch a burst of events into one refresh. Buttons in rebuilt lists
    // (timeline rows) unsubscribe once they have left the document
    let queued = false;
    let mounted = false;
    const handles: { off: () => void }[] = [];
    const queue = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (button.isConnected) {
                mounted = true;
            } else if (mounted) {
                handles.forEach(h => h.off());
                handles.length = 0;
                return;
            }
            refresh();
        });
    };
    REFRESH_EVENTS.forEach(name => handles.push(events.on(name, queue)));
    handles.push({ off: i18n.onChange(queue) });
    refresh();

    return { dom: button, refresh };
};

export { createKeyButton, KeyState };
