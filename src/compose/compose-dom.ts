import { formatLength, formatNumber, type SceneScale } from '../scene-scale';
import { i18n } from '../ui/localization';

// DOM and number helpers of the scan-composition panel (compose-tool.ts and
// compose-suggest-ui.ts): plain elements, buttons, a segmented control and
// the number formats the panel texts use.

const el = (tag: string, cls?: string | string[], text?: string) => {
    const e = document.createElement(tag);
    if (cls) {
        const list = (Array.isArray(cls) ? cls : [cls]).filter(Boolean);
        if (list.length) e.classList.add(...list);
    }
    if (text !== undefined) e.textContent = text;
    return e;
};

// key: a stable name of the control (e.g. "card:3:accept"); the panel
// focuses the control of the same key again after a rebuild
const button = (text: string, onClick: () => void, cls: string[] = [], title?: string, key?: string) => {
    const b = el('span', ['compose-button', ...cls], text);
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    if (title) b.title = title;
    if (key) b.dataset.key = key;
    b.addEventListener('click', () => {
        if (!b.classList.contains('disabled')) onClick();
    });
    b.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // a disabled button keeps the focus after a rebuild: Space on it
        // does nothing, it does not scroll the panel either
        e.preventDefault();
        if (!b.classList.contains('disabled')) onClick();
    });
    return b;
};

type SegmentOption<T> = {
    value: T,
    text: string,
    title?: string,
    disabled?: boolean
};

// a row of buttons of which one is active (like the quality tool's display
// mode); a click on an option calls onPick with its value. key: each
// option's button gets key:value (see button)
const segmented = <T>(options: SegmentOption<T>[], current: T | null, onPick: (value: T) => void, title?: string, key?: string) => {
    const wrap = el('span', 'compose-seg');
    if (title) wrap.title = title;
    for (const option of options) {
        const b = button(option.text, () => onPick(option.value), [
            'compose-seg-item',
            ...(option.value === current ? ['active'] : []),
            ...(option.disabled ? ['disabled'] : [])
        ], option.title, key ? `${key}:${String(option.value)}` : undefined);
        wrap.appendChild(b);
    }
    return wrap;
};

// scroll the panel (the element's nearest scrolling ancestor) just enough to
// show the element. scrollIntoView would also scroll every scrollable
// ancestor, the editor's canvas container among them, which the user cannot
// scroll back
const scrollIntoPanel = (target: HTMLElement) => {
    let box = target.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (!box) return;
    const outer = box.getBoundingClientRect();
    const inner = target.getBoundingClientRect();
    if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
    else if (inner.bottom > outer.bottom) box.scrollTop += Math.min(inner.bottom - outer.bottom, inner.top - outer.top);
};

// overlay labels (suggestion pills, zone markers) are centred on their
// point: one whose centre lies more than this many pixels outside the view
// is wholly outside it and is not shown (measured in the editor: a pill
// "✓ 12 · 2,9×" is 73 px wide, "✓ 100 · 12×" 76 px, both 22 px high)
const OFF_VIEW = 48;

// a projected point (pixels) whose label shows: in front of the camera and
// at most OFF_VIEW outside the w × h view
const inView = (p: { x: number, y: number, visible: boolean }, w: number, h: number) => p.visible && p.x >= -OFF_VIEW && p.x <= w + OFF_VIEW && p.y >= -OFF_VIEW && p.y <= h + OFF_VIEW;

// a small colour square (scan colour, legend)
const swatch = (color: string, cls = 'compose-swatch') => {
    const s = el('span', cls);
    s.style.backgroundColor = color;
    return s;
};

const formatCount = (n: number) => (n >= 1e6 ?
    i18n.t('sm.compose.splats-m', { value: (n / 1e6).toLocaleString(i18n.locale || 'en', { maximumFractionDigits: 1 }) }) :
    i18n.t('sm.compose.splats-k', { value: Math.round(n / 1000).toLocaleString(i18n.locale || 'en') }));

// "38.412" / "38,412"
const formatInt = (n: number) => i18n.formatInteger(Number.isFinite(n) ? n : 0);

// a factor for "4× feiner", "3,1× so dicht": one decimal, none when whole;
// "< 0,1" below 0.05, which one decimal would show as 0 (a heavily thinned
// scan: "< 0,1× so dicht"); "–" when not finite
const formatFactor = (f: number) => {
    if (!Number.isFinite(f)) return '–';
    if (f > 0 && f < 0.05) return `< ${formatNumber(0.1, 1)}`;
    if (f >= 10) return formatNumber(f, 0);
    const r = Math.round(f * 10) / 10;
    return formatNumber(r, Number.isInteger(r) ? 0 : 1);
};

// a share 0..1 as a whole percentage (the texts add " %")
const percent = (share: number) => (Number.isFinite(share) ? Math.round(100 * share) : 0);

// the same for display, with "< 1" for small shares that are not zero
const percentText = (share: number) => (share > 0 && share < 0.005 ? '< 1' : `${percent(share)}`);

// a splat size: millimetres below 1 cm in metric scenes, otherwise as any
// other length (cm, m or scene units)
const splatLen = (units: number, scale: SceneScale) => {
    if (!Number.isFinite(units)) return '–';
    if (scale.known) {
        const mm = units * scale.metersPerUnit * 1000;
        if (Math.abs(mm) < 10) return `${formatNumber(mm, Math.abs(mm) < 1 ? 1 : 0)} mm`;
    }
    return formatLength(units, scale);
};

// box dimensions "1,8 × 1,2 × 1,6 m" with one unit at the end
const formatDims = (dims: number[], scale: SceneScale) => {
    if (!scale.known) {
        const big = Math.max(...dims.map(Math.abs));
        const d = big >= 100 ? 0 : big >= 10 ? 1 : 2;
        return `${dims.map(v => formatNumber(v, d)).join(' × ')} ${i18n.t('sm.scale.unit-short')}`;
    }
    const meters = dims.map(v => v * scale.metersPerUnit);
    const big = Math.max(...meters.map(Math.abs));
    if (big < 1) return `${meters.map(v => formatNumber(v * 100, 0)).join(' × ')} cm`;
    return `${meters.map(v => formatNumber(v, big >= 100 ? 0 : 1)).join(' × ')} m`;
};

// an area in world units squared: "≈ 120 m²"
const formatArea = (area: number, scale: SceneScale) => {
    if (!Number.isFinite(area)) return '–';
    if (!scale.known) return `${formatNumber(area, area >= 10 ? 0 : 1)} ${i18n.t('sm.scale.unit-short')}²`;
    const m2 = area * scale.metersPerUnit * scale.metersPerUnit;
    return `${formatNumber(m2, m2 >= 10 ? 0 : 1)} m²`;
};

// the name a scan goes by in every compose text: its layer name, numbered
// in scene order when another layer of the scene has the same name (two
// scans exported as "point_cloud.ply": "point_cloud.ply (1)" and
// "point_cloud.ply (2)", so a card does not read "point_cloud.ply replaces
// point_cloud.ply"). The number counts the layers of that name in scene
// order, the excluded ones too, so it does not change when a scan is left
// out of the composition
const scanName = (splat: { name: string }, layers: readonly { name: string }[]) => {
    const name = splat?.name ?? '';
    let index = 0, count = 0;
    for (const layer of layers) {
        if (layer.name !== name) continue;
        count++;
        if (layer === splat) index = count;
    }
    return count > 1 && index > 0 ? `${name} (${index})` : name;
};

export { el, button, segmented, swatch, scrollIntoPanel, inView, scanName, formatCount, formatInt, formatFactor, percent, percentText, splatLen, formatDims, formatArea, type SegmentOption };
