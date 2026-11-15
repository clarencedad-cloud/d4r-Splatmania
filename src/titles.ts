import { Events } from './events';

// Titles: text shown over the image for a frame range (fading in and out),
// drawn into image and video exports and previewed over the viewport
// (src/ui/titles-overlay.ts). One list per project, saved with it.

type TitlePosition = 'top' | 'center' | 'lower-third' | 'bottom';
type TitleAlign = 'left' | 'center' | 'right';

type Title = {
    id: number,
    text: string,
    // timeline frames, inclusive
    start: number,
    end: number,
    // fade in / out, in frames
    fade: number,
    position: TitlePosition,
    align: TitleAlign,
    // text height as a share of the image height
    size: number,
    color: [number, number, number],
    // a dark box behind the text instead of a shadow
    box: boolean,
    font: 'sans' | 'serif' | 'mono',
    bold: boolean
};

const FONTS: Record<Title['font'], string> = {
    sans: '"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: '"JetBrains Mono", Consolas, "Courier New", monospace'
};

// opacity of a title at a (fractional) frame
const titleAlpha = (t: Title, frame: number) => {
    if (frame < t.start || frame > t.end + 1) return 0;
    const fade = Math.max(0, t.fade);
    if (fade === 0) return 1;
    const inA = Math.min(1, (frame - t.start) / fade);
    const outA = Math.min(1, (t.end + 1 - frame) / fade);
    return Math.max(0, Math.min(inA, outA));
};

/**
 * Draw the titles visible at frame into a 2d context of width x height.
 * Sizes are relative to the height, so the viewport preview and a 4K export
 * look the same.
 */
const drawTitles = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, width: number, height: number, titles: Title[], frame: number) => {
    for (const t of titles) {
        const alpha = titleAlpha(t, frame);
        if (alpha <= 0 || !t.text.trim()) continue;

        const px = Math.max(4, t.size * height);
        const lines = t.text.split('\n');
        const lineHeight = px * 1.2;
        const margin = height * 0.06;
        const blockHeight = lineHeight * lines.length;

        let top: number;
        switch (t.position) {
            case 'top': top = margin; break;
            case 'center': top = (height - blockHeight) / 2; break;
            case 'lower-third': top = height * 0.7 - blockHeight / 2; break;
            default: top = height - margin - blockHeight; break;
        }
        const x = t.align === 'left' ? margin * 1.4 : (t.align === 'right' ? width - margin * 1.4 : width / 2);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `${t.bold ? 700 : 400} ${px}px ${FONTS[t.font] ?? FONTS.sans}`;
        ctx.textAlign = t.align;
        ctx.textBaseline = 'top';
        const [r, g, b] = t.color.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));

        if (t.box) {
            const widths = lines.map(line => ctx.measureText(line).width);
            const w = Math.max(...widths);
            const pad = px * 0.35;
            const left = t.align === 'left' ? x : (t.align === 'right' ? x - w : x - w / 2);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
            ctx.fillRect(left - pad, top - pad * 0.6, w + 2 * pad, blockHeight + pad * 1.2 - (lineHeight - px));
        } else {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
            ctx.shadowBlur = px * 0.25;
            ctx.shadowOffsetY = px * 0.04;
        }

        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        lines.forEach((line, i) => ctx.fillText(line, x, top + i * lineHeight));
        ctx.restore();
    }
};

// scratch canvas for drawing into rendered pixels
let scratch: OffscreenCanvas | null = null;

/**
 * Draw the titles at frame over an RGBA pixel buffer (rows top-down, as the
 * renderer reads them back). Returns false when no title is visible.
 */
const drawTitlesOnPixels = (data: Uint8Array, width: number, height: number, titles: Title[], frame: number) => {
    if (!titles.some(t => titleAlpha(t, frame) > 0 && t.text.trim())) return false;
    if (!scratch || scratch.width !== width || scratch.height !== height) {
        scratch = new OffscreenCanvas(width, height);
    }
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    const image = new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, width * height * 4), width, height);
    ctx.putImageData(image, 0, 0);
    drawTitles(ctx, width, height, titles, frame);
    data.set(ctx.getImageData(0, 0, width, height).data);
    return true;
};

let nextId = 1;

const registerTitleEvents = (events: Events) => {
    let titles: Title[] = [];

    const changed = () => events.fire('titles.changed', titles);

    events.function('titles.list', () => titles);

    events.function('titles.add', () => {
        const frame = Math.round(events.invoke('timeline.frame') ?? 0);
        const fps = events.invoke('timeline.frameRate') ?? 30;
        const frames = events.invoke('timeline.frames') ?? 180;
        const title: Title = {
            id: nextId++,
            text: 'Title',
            start: frame,
            end: Math.min(frames - 1, frame + Math.round(fps * 3)),
            fade: Math.round(fps * 0.5),
            position: 'lower-third',
            align: 'center',
            size: 0.07,
            color: [1, 1, 1],
            box: false,
            font: 'sans',
            bold: true
        };
        titles = [...titles, title];
        changed();
        return title;
    });

    events.on('titles.update', (id: number, patch: Partial<Title>) => {
        titles = titles.map(t => (t.id === id ? { ...t, ...patch } : t));
        changed();
    });

    events.on('titles.remove', (id: number) => {
        titles = titles.filter(t => t.id !== id);
        changed();
    });

    // draw over rendered pixels (image and video exports)
    events.function('titles.drawOnPixels', (data: Uint8Array, width: number, height: number, frame: number) => {
        return drawTitlesOnPixels(data, width, height, titles, frame);
    });

    events.function('docSerialize.titles', () => titles.map(t => ({ ...t, color: [...t.color] })));
    events.function('docDeserialize.titles', (doc: any) => {
        titles = Array.isArray(doc) ? doc.map((t: any) => ({ ...t, id: nextId++ })) : [];
        changed();
    });
};

export { registerTitleEvents, drawTitles, titleAlpha, Title, TitlePosition, TitleAlign };
