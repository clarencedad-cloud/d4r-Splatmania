import { Events } from '../events';
import { i18n } from './localization';

type ViewMode = 'free' | 'camera' | 'cut';
type FollowedCamera = { name: string, color: [number, number, number] } | null;

const NEXT: Record<ViewMode, ViewMode> = { free: 'camera', camera: 'cut', cut: 'free' };

/**
 * Which view the viewport shows, left of the view cube: the free view, the
 * camera looked through, or the cut with its current camera. A click steps
 * to the next mode. Html over the canvas, so it never shows in a render.
 */
class ViewportLabel {
    readonly dom: HTMLElement;

    constructor(events: Events) {
        const dom = document.createElement('div');
        dom.id = 'viewport-label';
        this.dom = dom;

        const swatch = document.createElement('span');
        swatch.classList.add('viewport-label-swatch');
        const text = document.createElement('span');
        text.classList.add('viewport-label-text');
        dom.append(swatch, text);

        ['pointerdown', 'pointerup', 'wheel', 'dblclick'].forEach((name) => {
            dom.addEventListener(name, e => e.stopPropagation());
        });
        dom.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!events.functions.has('camera.viewMode')) return;
            events.fire('camera.setViewMode', NEXT[events.invoke('camera.viewMode') as ViewMode] ?? 'free');
        });

        let queued = false;
        const update = () => {
            queued = false;
            if (!events.functions.has('camera.viewMode')) return;
            const mode = events.invoke('camera.viewMode') as ViewMode;
            const camera = (events.functions.has('shotCameras.followed') ? events.invoke('shotCameras.followed') : null) as FollowedCamera;
            const name = camera?.name ?? '';
            if (mode === 'camera') {
                text.textContent = name;
            } else if (mode === 'cut') {
                text.textContent = name ? `${i18n.t('sm.viewport.cut')} · ${name}` : i18n.t('sm.viewport.cut');
            } else {
                text.textContent = i18n.t('sm.viewport.free');
            }
            swatch.hidden = mode === 'free' || !camera;
            if (camera) swatch.style.backgroundColor = `rgb(${camera.color.join(', ')})`;
            dom.classList.toggle('through-camera', mode !== 'free');
            dom.title = i18n.t('sm.viewport.tip');
        };
        const queue = () => {
            if (queued) return;
            queued = true;
            queueMicrotask(update);
        };

        ['camera.viewMode', 'shotCameras.changed', 'shotCameras.select', 'cut.changed', 'timeline.frame', 'timeline.time'].forEach(name => events.on(name, queue));
        i18n.onChange(queue);
        queue();
    }
}

export { ViewportLabel };
