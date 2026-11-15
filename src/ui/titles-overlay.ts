import { Events } from '../events';
import { drawTitles, Title } from '../titles';

/**
 * Viewport preview of the titles (src/titles.ts): a 2d canvas over the 3d
 * view, drawn with the same function the exports use, at the current frame.
 */
class TitlesOverlay {
    readonly dom: HTMLCanvasElement;

    constructor(events: Events) {
        const canvas = document.createElement('canvas');
        canvas.id = 'titles-overlay';
        this.dom = canvas;
        const ctx = canvas.getContext('2d');

        let queued = false;
        const draw = () => {
            queued = false;
            const titles = (events.functions.has('titles.list') ? events.invoke('titles.list') : []) as Title[];
            const w = Math.max(1, Math.round(canvas.clientWidth * window.devicePixelRatio));
            const h = Math.max(1, Math.round(canvas.clientHeight * window.devicePixelRatio));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            ctx.clearRect(0, 0, w, h);
            if (titles.length === 0) return;
            drawTitles(ctx, w, h, titles, events.invoke('timeline.frame') ?? 0);
        };
        const schedule = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(draw);
        };

        ['titles.changed', 'timeline.frame', 'timeline.time'].forEach(name => events.on(name, schedule));
        new ResizeObserver(schedule).observe(canvas);
    }
}

export { TitlesOverlay };
