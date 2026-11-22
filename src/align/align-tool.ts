import { BooleanInput, Container, Label, SliderInput } from '@playcanvas/pcui';
import { Mat4, Quat, Vec3 } from 'playcanvas';

import { correctionOps as applyCorrection, matrixOps as applyMatrix } from './align-ops';
import type { AutoAlignResult } from './global-align';
import { autoMaxError, type IcpResult } from './icp';
import { alignPoints, type AlignResult } from './point-align';
import { abortAnalysis, AbortedError, runAnalysis } from '../analysis/analysis-client';
import { readLayerData } from '../analysis/splat-data';
import { MultiOp } from '../edit-ops';
import { ElementType } from '../element';
import { Events } from '../events';
import type { Scene } from '../scene';
import { formatLength, type SceneScale } from '../scene-scale';
import type { Splat } from '../splat';
import { makeFloating } from '../ui/floating-panel';
import { helpButton } from '../ui/help';
import { i18n } from '../ui/localization';

// Alignment of splat layers. One layer is the reference and stays put.
// Auto-Ausrichten finds the pose of every other visible layer on its own
// (shape + colour descriptors, src/align/global-align.ts), from any starting
// pose and scale; the anchor points below are the manual fallback (Splatterline
// style). On every other layer, anchor n pairs with
// anchor n of the reference; Align solves a similarity transform per layer
// (src/align/point-align.ts) and applies it to the layer transform as one
// undo step. Anchors live in layer-local coordinates, so they move with the
// layer and line up after the align.

const COLORS = ['#c20e7e', '#00dcff', '#78ff5a', '#5aa9e6', '#fff050', '#94a3b8'];

const CLICK_TOLERANCE = 4;

// search radius ("Max. Versatz") of the fine alignment: how far the search
// reaches at first before it narrows down (src/align/icp.ts). The automatic
// value is measured on a light sample of every layer; the slider is
// logarithmic from 1/8 (about the finest search the core does) to 6 times it
const RADIUS_SAMPLE = 50000;
const SLIDER_STEPS = 1000;
const RANGE_BELOW = 8;
const RANGE_ABOVE = 6;
// how long the size circle stays in the view after a change (ms)
const CIRCLE_LINGER = 1800;

const UNKNOWN_SCALE: SceneScale = { mode: 'auto', metersPerUnit: 1, known: false, source: 'unknown' };

// two significant digits, so the shown value is the value used
const roundSignificant = (v: number) => {
    if (!(v > 0)) return v;
    const p = 10 ** (Math.floor(Math.log10(v)) - 1);
    return Math.round(v / p) * p;
};

// undoable change of one layer's anchors
class AnchorsOp {
    name = 'alignAnchors';
    constructor(private apply: (anchors: Vec3[]) => void, private before: Vec3[], private after: Vec3[]) {}
    do() {
        this.apply(this.after.map(v => v.clone()));
    }
    undo() {
        this.apply(this.before.map(v => v.clone()));
    }
}

class AlignTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const anchors = new Map<Splat, Vec3[]>();
        const results = new Map<Splat, AlignResult | string>();
        // fine alignment (ICP) outcome per layer, for the panel
        const refined = new Map<Splat, IcpResult | string>();
        // automatic alignment per layer: the candidates (corrections relative
        // to the pose before the run) and which one is applied
        const autoResults = new Map<Splat, { result: AutoAlignResult, applied: number }>();
        // search radius for the fine alignment (0 = automatic)
        let searchRadius = 0;
        // automatic search radius per moving layer as the core would pick it
        // (null: no overlap with the reference); cleared when a layer moves
        const autoRadius = new Map<Splat, number | null>();
        let reference: Splat | null = null;
        let useScale = true;
        let active = false;
        let message = '';

        const splats = () => (scene.getElementsByType(ElementType.splat) as Splat[]);
        const ref = () => (reference && reference.scene ? reference : splats()[0] ?? null);
        const sceneScale = (): SceneScale => (events.functions.has('sceneScale.get') ? events.invoke('sceneScale.get') : UNKNOWN_SCALE);
        // a length in the scene's units: "12 cm" or "0,12 units"
        const len = (v: number) => formatLength(v, sceneScale());
        const colorOf = (splat: Splat) => COLORS[Math.max(0, splats().indexOf(splat)) % COLORS.length];
        const anchorsOf = (splat: Splat) => anchors.get(splat) ?? [];

        const toWorld = (splat: Splat, local: Vec3) => splat.entity.getWorldTransform().transformPoint(local, new Vec3());
        const toLocal = (splat: Splat, world: Vec3) => new Mat4().copy(splat.entity.getWorldTransform()).invert().transformPoint(world, new Vec3());

        const changed = () => {
            events.fire('align.changed');
            scene.forceRender = true;
        };

        const setAnchors = (splat: Splat, list: Vec3[]) => {
            anchors.set(splat, list);
            results.delete(splat);
            changed();
        };

        const editAnchors = (splat: Splat, fn: (list: Vec3[]) => void) => {
            const before = anchorsOf(splat).map(v => v.clone());
            const after = before.map(v => v.clone());
            fn(after);
            // apply now and record the op as already done: edit.add runs
            // through the async command queue, and rapid edits must each see
            // the previous one's result
            setAnchors(splat, after.map(v => v.clone()));
            events.fire('edit.add', new AnchorsOp(list => setAnchors(splat, list), before, after), true);
        };

        // ui: numbered markers over the viewport and a panel

        const overlay = document.createElement('div');
        overlay.id = 'align-overlay';
        canvasContainer.dom.appendChild(overlay);

        const panel = new Container({ id: 'align-panel', hidden: true });
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'keydown'].forEach((name) => {
            panel.dom.addEventListener(name, e => e.stopPropagation());
        });
        canvasContainer.append(panel);

        makeFloating(panel, { key: 'align', title: 'sm.align.title', extras: [helpButton(events, 'align')] });
        const help = new Label({ class: 'align-help' });
        i18n.bindText(help, 'sm.align.help');
        panel.append(help);
        const layerList = new Container({ class: 'align-layers' });
        panel.append(layerList);

        const scaleRow = new Container({ class: 'align-row' });
        const scaleLabel = new Label({ class: 'align-label' });
        i18n.bindText(scaleLabel, 'sm.align.scale');
        i18n.bindDom(scaleRow.dom, 'sm.align.scale-tip', 'title');
        scaleRow.append(scaleLabel);
        const scaleInput = new BooleanInput({ value: true });
        scaleInput.on('change', (v: boolean) => {
            useScale = v;
        });
        scaleRow.append(scaleInput);
        panel.append(scaleRow);

        // automatic alignment: one click, no anchors
        const autoRow = new Container({ class: ['align-row', 'align-auto-row'] });
        panel.append(autoRow);
        const autoButton = document.createElement('span');
        autoButton.classList.add('align-button', 'align-auto');
        i18n.bindDom(autoButton, 'sm.align.auto');
        i18n.bindDom(autoButton, 'sm.align.auto-tip', 'title');
        autoButton.addEventListener('click', () => events.invoke('align.auto'));
        autoRow.dom.appendChild(autoButton);
        const otherButton = document.createElement('span');
        otherButton.classList.add('align-button', 'align-other');
        i18n.bindDom(otherButton, 'sm.align.other');
        i18n.bindDom(otherButton, 'sm.align.other-tip', 'title');
        otherButton.addEventListener('click', () => events.invoke('align.nextCandidate'));
        autoRow.dom.appendChild(otherButton);

        const anchorsHeading = new Label({ class: 'align-subheading' });
        i18n.bindText(anchorsHeading, 'sm.align.manual');
        panel.append(anchorsHeading);

        const buttons = new Container({ class: 'align-row' });
        panel.append(buttons);
        const button = (text: string, title: string, onClick: () => void) => {
            const b = document.createElement('span');
            b.classList.add('align-button');
            i18n.bindDom(b, text);
            i18n.bindDom(b, title, 'title');
            b.addEventListener('click', onClick);
            buttons.dom.appendChild(b);
        };
        button('sm.align.align', 'sm.align.align-tip', () => events.invoke('align.run'));
        button('sm.align.clear', 'sm.align.clear-tip', () => {
            const splat = events.invoke('selection') as Splat;
            if (splat && anchorsOf(splat).length) editAnchors(splat, list => list.splice(0));
        });

        // fine alignment ("Präzisieren"): robust ICP on the splat centres. Its
        // search radius reads as a length ("Max. Versatz": how far apart the
        // layers may still be), with a circle in the view showing the size
        const fineHeading = new Label({ class: 'align-subheading' });
        i18n.bindText(fineHeading, 'sm.align.fine');
        panel.append(fineHeading);
        const radiusBox = new Container({ class: 'align-radius' });
        panel.append(radiusBox);
        const radiusRow = new Container({ class: 'align-row' });
        radiusBox.append(radiusRow);
        const radiusLabel = new Label({ class: 'align-label' });
        i18n.bindText(radiusLabel, 'sm.align.radius');
        i18n.bindDom(radiusLabel.dom, 'sm.align.radius-tip', 'title');
        radiusRow.append(radiusLabel);
        const radiusValue = new Label({ class: 'align-radius-value' });
        radiusRow.append(radiusValue);
        const radiusAuto = new BooleanInput({ value: true });
        i18n.bindDom(radiusAuto.dom, 'sm.align.radius-auto-tip', 'title');
        radiusRow.append(radiusAuto);
        const radiusAutoLabel = new Label({ class: 'align-radius-auto' });
        i18n.bindText(radiusAutoLabel, 'sm.align.radius-auto');
        i18n.bindDom(radiusAutoLabel.dom, 'sm.align.radius-auto-tip', 'title');
        radiusAutoLabel.dom.addEventListener('click', () => {
            radiusAuto.value = !radiusAuto.value;
        });
        radiusRow.append(radiusAutoLabel);
        // slider position 0..SLIDER_STEPS, logarithmic around the automatic value
        const radiusSlider = new SliderInput({
            class: 'align-radius-slider',
            min: 0,
            max: SLIDER_STEPS,
            sliderMin: 0,
            sliderMax: SLIDER_STEPS,
            precision: 0,
            step: 1,
            value: Math.round(SLIDER_STEPS * Math.log(RANGE_BELOW) / Math.log(RANGE_BELOW * RANGE_ABOVE))
        });
        i18n.bindDom(radiusSlider.dom, 'sm.align.radius-tip', 'title');
        radiusBox.append(radiusSlider);
        const radiusHint = new Label({ class: 'align-radius-hint' });
        radiusBox.append(radiusHint);
        const refineButtons = new Container({ class: 'align-row' });
        panel.append(refineButtons);
        const refineButton = document.createElement('span');
        refineButton.classList.add('align-button', 'align-refine');
        i18n.bindDom(refineButton, 'sm.align.refine');
        i18n.bindDom(refineButton, 'sm.align.refine-tip', 'title');
        refineButton.addEventListener('click', () => events.invoke('align.refine'));
        refineButtons.dom.appendChild(refineButton);

        const messageLabel = new Label({ text: '', class: 'align-message' });
        panel.append(messageLabel);

        // search radius: shown value, slider mapping, size circle

        // the layer whose radius the panel shows: the selected moving layer,
        // else the first visible one
        const shownLayer = () => {
            const reference = ref();
            const moving = splats().filter(s => s !== reference && s.visible);
            const selected = events.invoke('selection') as Splat;
            return moving.includes(selected) ? selected : moving[0] ?? null;
        };

        // the radius the next refine uses for the shown layer: the manual
        // value, else the measured automatic one (undefined: not measured
        // yet, null: no overlap or no other layer)
        const shownRadius = (): number | null | undefined => {
            if (searchRadius > 0) return searchRadius;
            const layer = shownLayer();
            return layer ? autoRadius.get(layer) : null;
        };

        // slider centre: the automatic value (before it is known: 1/20 of
        // the scene size, as the core would pick it for a full overlap)
        const sliderBase = () => {
            const layer = shownLayer();
            const a = layer ? autoRadius.get(layer) : undefined;
            if (typeof a === 'number' && a > 0) return a;
            const size = scene.bound.halfExtents.length() * 2;
            return size > 0 ? size / 20 : 0.1;
        };
        const toSlider = (r: number) => {
            const t = Math.log(r * RANGE_BELOW / sliderBase()) / Math.log(RANGE_BELOW * RANGE_ABOVE);
            return Math.round(Math.min(1, Math.max(0, t)) * SLIDER_STEPS);
        };
        const fromSlider = (t: number) => sliderBase() / RANGE_BELOW * (RANGE_BELOW * RANGE_ABOVE) ** (t / SLIDER_STEPS);

        // circle of the radius at the camera focus, while the pointer is over
        // the radius controls and shortly after a change
        const circle = document.createElement('div');
        circle.classList.add('align-radius-circle');
        const circleLabel = document.createElement('span');
        circle.appendChild(circleLabel);
        overlay.appendChild(circle);
        let circleHover = false;
        let circleUntil = 0;
        let circleTimer: ReturnType<typeof setTimeout> | null = null;
        const showCircle = () => {
            circleUntil = performance.now() + CIRCLE_LINGER;
            scene.forceRender = true;
            if (circleTimer) clearTimeout(circleTimer);
            circleTimer = setTimeout(() => {
                circleTimer = null;
                scene.forceRender = true;
            }, CIRCLE_LINGER + 50);
        };
        radiusBox.dom.addEventListener('pointerenter', () => {
            circleHover = true;
            scene.forceRender = true;
        });
        radiusBox.dom.addEventListener('pointerleave', () => {
            circleHover = false;
            showCircle();
        });

        const circleCentre = new Vec3();
        const circleEdge = new Vec3();
        const updateCircle = () => {
            const r = shownRadius();
            if (!active || typeof r !== 'number' || !(r > 0) || !(circleHover || performance.now() < circleUntil)) {
                circle.style.display = 'none';
                return;
            }
            const { camera } = scene;
            const w = canvasContainer.dom.clientWidth;
            const h = canvasContainer.dom.clientHeight;
            const focus = camera.focalPoint;
            camera.worldToScreen(focus, circleCentre);
            circleEdge.copy(camera.mainCamera.right).mulScalar(r).add(focus);
            camera.worldToScreen(circleEdge, circleEdge);
            const px = Math.min(4000, Math.max(3, Math.hypot((circleEdge.x - circleCentre.x) * w, (circleEdge.y - circleCentre.y) * h)));
            circle.style.display = '';
            circle.style.left = `${circleCentre.x * w}px`;
            circle.style.top = `${circleCentre.y * h}px`;
            circle.style.width = `${2 * px}px`;
            circle.style.height = `${2 * px}px`;
            circle.style.margin = `${-px}px 0 0 ${-px}px`;
            circleLabel.textContent = len(r);
        };

        let syncing = false;
        const updateRadiusUi = () => {
            const r = shownRadius();
            const auto = searchRadius <= 0;
            syncing = true;
            radiusAuto.value = auto;
            radiusSlider.value = toSlider(typeof r === 'number' && r > 0 ? r : sliderBase());
            syncing = false;
            radiusSlider.class[auto ? 'add' : 'remove']('auto');
            radiusValue.text = typeof r === 'number' ? len(r) : r === null ? '–' : i18n.t('sm.align.radius-pending');
            radiusHint.text = typeof r === 'number' ? i18n.t('sm.align.radius-hint', { value: len(r) }) : '';
            if (active) scene.forceRender = true;
        };

        radiusSlider.on('change', (t: number) => {
            if (syncing) return;
            searchRadius = roundSignificant(fromSlider(t));
            showCircle();
            updateRadiusUi();
        });
        radiusAuto.on('change', (value: boolean) => {
            if (syncing) return;
            if (value) {
                searchRadius = 0;
            } else {
                // the manual value starts at the automatic one
                const layer = shownLayer();
                const a = layer ? autoRadius.get(layer) : undefined;
                searchRadius = roundSignificant(typeof a === 'number' && a > 0 ? a : sliderBase());
            }
            showCircle();
            updateRadiusUi();
        });

        const rebuildPanel = () => {
            layerList.dom.innerHTML = '';
            const reference = ref();
            const selected = events.invoke('selection') as Splat;
            for (const splat of splats()) {
                const row = document.createElement('div');
                row.classList.add('align-layer');
                if (splat === selected) row.classList.add('active');
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'align-reference';
                radio.checked = splat === reference;
                radio.title = i18n.t('sm.align.reference-tip');
                radio.addEventListener('change', () => {
                    events.fire('align.setReference', splat);
                });
                const swatch = document.createElement('span');
                swatch.classList.add('align-swatch');
                swatch.style.backgroundColor = colorOf(splat);
                const name = document.createElement('span');
                name.classList.add('align-name');
                name.textContent = `${splat.name}${splat === reference ? ` (${i18n.t('sm.align.reference')})` : ''}`;
                name.title = i18n.t('sm.align.layer-pick-tip');
                name.addEventListener('click', () => events.fire('selection', splat));
                const info = document.createElement('span');
                info.classList.add('align-info');
                const result = results.get(splat);
                const count = anchorsOf(splat).length;
                const fine = refined.get(splat);
                const auto = autoResults.get(splat);
                const autoCandidate = auto?.result.candidates[auto.applied];
                info.classList.toggle('uncertain', !!autoCandidate && (auto.result.ambiguous || autoCandidate.fitness < 0.15));
                info.textContent = autoCandidate && !fine ?
                    i18n.t(auto.result.candidates.length > 1 ? 'sm.align.auto-result-n' : 'sm.align.auto-result', {
                        fit: (autoCandidate.fitness * 100).toFixed(0),
                        index: auto.applied + 1,
                        count: auto.result.candidates.length
                    }) + (auto.result.ambiguous || autoCandidate.fitness < 0.15 ? ` · ${i18n.t('sm.align.auto-check')}` : '') :
                    typeof fine === 'object' ?
                        i18n.t('sm.align.refined', { before: len(fine.before.median), after: len(fine.after.median), overlap: (fine.after.overlap * 100).toFixed(0) }) :
                        typeof result === 'object' ?
                            `${i18n.t('sm.align.points', { count })} · ± ${len(result.rms)}` :
                            i18n.t('sm.align.points', { count });
                // per anchor point: how far it ended up from its partner
                info.title = typeof result === 'object' && !fine && !autoCandidate ?
                    result.residuals.map((r, k) => `${k + 1}: ${len(r)}`).join('\n') : '';
                row.append(radio, swatch, name, info);
                layerList.dom.appendChild(row);
            }
            messageLabel.text = message;
            const switchable = [...autoResults.values()].some(a => a.result.candidates.length > 1);
            otherButton.style.display = switchable ? '' : 'none';
            updateRadiusUi();
        };

        const markers: HTMLElement[] = [];
        const tmp = new Vec3();

        // position the markers over their anchors
        const updateMarkers = () => {
            if (!active) {
                overlay.style.display = 'none';
                return;
            }
            overlay.style.display = '';
            let i = 0;
            const camPos = scene.camera.mainCamera.getPosition();
            const camFwd = scene.camera.mainCamera.forward;
            const w = canvasContainer.dom.clientWidth;
            const h = canvasContainer.dom.clientHeight;
            for (const splat of splats()) {
                if (!splat.visible) continue;
                const list = anchorsOf(splat);
                for (let index = 0; index < list.length; index++) {
                    const world = toWorld(splat, list[index]);
                    let marker = markers[i];
                    if (!marker) {
                        marker = document.createElement('div');
                        marker.classList.add('align-marker');
                        overlay.appendChild(marker);
                        markers.push(marker);
                    }
                    const visible = tmp.sub2(world, camPos).dot(camFwd) > 0;
                    scene.camera.worldToScreen(world, tmp);
                    marker.style.display = visible ? '' : 'none';
                    marker.style.left = `${tmp.x * w}px`;
                    marker.style.top = `${tmp.y * h}px`;
                    marker.style.borderColor = colorOf(splat);
                    marker.style.color = colorOf(splat);
                    marker.textContent = `${index + 1}`;
                    marker.dataset.uid = `${splat.uid}`;
                    marker.dataset.index = `${index}`;
                    i++;
                }
            }
            for (; i < markers.length; i++) markers[i].style.display = 'none';
        };

        events.on('postrender', () => {
            updateMarkers();
            updateCircle();
        });

        // pick a world point on the active layer only
        const pick = async (x: number, y: number) => {
            const splat = events.invoke('selection') as Splat;
            if (!splat) return null;
            const [hit] = await scene.camera.intersectMany([{
                x: x / canvasContainer.dom.clientWidth,
                y: y / canvasContainer.dom.clientHeight
            }], [splat]);
            return hit ? { splat, position: hit.position } : null;
        };

        const splatByUid = (uid: number) => splats().find(s => s.uid === uid);

        // viewport input: click = add anchor on the active layer, drag a
        // marker = move it, right-click a marker = delete it
        let down: { x: number, y: number, marker: HTMLElement | null } | null = null;

        const pointerdown = (e: PointerEvent) => {
            if (!active || e.button !== 0) return;
            const marker = (e.target as HTMLElement).closest?.('.align-marker') as HTMLElement | null;
            down = { x: e.offsetX, y: e.offsetY, marker };
            if (marker) {
                // keep the camera still while a marker is dragged
                e.stopPropagation();
                e.preventDefault();
            }
        };

        const pointerup = async (e: PointerEvent) => {
            if (!active || !down || e.button !== 0) return;
            const start = down;
            down = null;
            const rect = canvasContainer.dom.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const moved = Math.hypot(x - (start.marker ? x : start.x), y - (start.marker ? y : start.y)) > CLICK_TOLERANCE;
            if (start.marker) {
                // dropped a dragged marker: re-pick under the pointer
                const splat = splatByUid(parseInt(start.marker.dataset.uid, 10));
                const index = parseInt(start.marker.dataset.index, 10);
                if (splat !== events.invoke('selection')) events.fire('selection', splat);
                const hit = await pick(x, y);
                if (hit && hit.splat === splat) {
                    const local = toLocal(splat, hit.position);
                    editAnchors(splat, (list) => {
                        list[index] = local;
                    });
                }
                e.stopPropagation();
                return;
            }
            if (moved) return;
            const hit = await pick(start.x, start.y);
            if (!hit) {
                message = i18n.t('sm.align.no-hit');
                rebuildPanel();
                return;
            }
            const local = toLocal(hit.splat, hit.position);
            editAnchors(hit.splat, list => list.push(local));
            message = '';
        };

        const contextmenu = (e: MouseEvent) => {
            const marker = (e.target as HTMLElement).closest?.('.align-marker') as HTMLElement | null;
            if (!active || !marker) return;
            e.preventDefault();
            e.stopPropagation();
            const splat = splatByUid(parseInt(marker.dataset.uid, 10));
            const index = parseInt(marker.dataset.index, 10);
            if (splat) editAnchors(splat, list => list.splice(index, 1));
        };

        // markers take pointer input themselves; drags follow the pointer
        overlay.addEventListener('pointerdown', pointerdown);
        overlay.addEventListener('contextmenu', contextmenu);
        overlay.addEventListener('pointermove', (e: PointerEvent) => {
            if (down?.marker) {
                const rect = canvasContainer.dom.getBoundingClientRect();
                down.marker.style.left = `${e.clientX - rect.left}px`;
                down.marker.style.top = `${e.clientY - rect.top}px`;
            }
        });

        // a world correction M = (rotation r, uniform scale) applied on top of
        // the layer transform, plus the same correction on its animated
        // transform keys so existing layer animations survive
        // world corrections as undoable ops (src/align/align-ops.ts)
        const correctionOps = (splat: Splat, m: Mat4, r: Quat, scaleFactor: number) => applyCorrection(events, splat, m, r, scaleFactor);
        const matrixOps = (splat: Splat, matrix: number[], scale: number) => applyMatrix(events, splat, matrix, scale);

        // align

        const run = () => {
            const reference = ref();
            message = '';
            if (!reference) {
                message = i18n.t('sm.align.no-layer');
                rebuildPanel();
                return null;
            }
            const dst = anchorsOf(reference).map(p => toWorld(reference, p));
            const ops: any[] = [];
            const summary: Record<string, unknown> = {};
            for (const splat of splats()) {
                if (splat === reference || anchorsOf(splat).length === 0) continue;
                const n = Math.min(anchorsOf(splat).length, dst.length);
                if (n < 3) {
                    results.set(splat, i18n.t('sm.align.need-three-short', { n }));
                    message = `${splat.name}: ${i18n.t('sm.align.need-three', { n })}`;
                    continue;
                }
                const src = anchorsOf(splat).slice(0, n).map(p => toWorld(splat, p));
                let result: AlignResult;
                try {
                    result = alignPoints(src, dst.slice(0, n), { scale: useScale });
                } catch (error) {
                    const text = `${(error as Error).message ?? error}`;
                    results.set(splat, text);
                    message = `${splat.name}: ${text.includes('triangle') ? i18n.t('sm.align.degenerate') : text}`;
                    continue;
                }

                const m = new Mat4();
                m.data.set(result.matrix);
                const r = new Quat(result.rotation[0], result.rotation[1], result.rotation[2], result.rotation[3]);
                ops.push(...correctionOps(splat, m, r, result.scale));

                results.set(splat, result);
                refined.delete(splat);
                autoResults.delete(splat);
                summary[splat.name] = { rms: result.rms, residuals: result.residuals, scale: result.scale, rotation: result.rotation, translation: result.translation };
            }
            if (ops.length) {
                events.fire('edit.add', new MultiOp(ops));
            } else if (!message) {
                message = i18n.t('sm.align.no-anchors');
            }
            rebuildPanel();
            return summary;
        };

        // fine alignment of every visible non-reference layer onto the
        // reference, in the analysis worker
        const MAX_POINTS = 500000;
        let refining = false;

        // measure the automatic radius of every visible moving layer (one
        // light read per layer, not while an alignment runs). When something
        // moves meanwhile, wait until it settles and measure again.
        const SETTLE = 400;
        let radiusGeneration = 0;
        let lastInvalidate = 0;
        let measuring = false;
        const wait = (ms: number) => new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
        const measureRadius = async () => {
            if (measuring) return;
            measuring = true;
            try {
                for (;;) {
                    while (performance.now() - lastInvalidate < SETTLE) await wait(100);
                    const reference = ref();
                    const missing = splats().filter(s => s !== reference && s.visible && !autoRadius.has(s));
                    if (!active || refining || !reference || !missing.length) break;
                    const generation = radiusGeneration;
                    const read = (splat: Splat) => readLayerData(splat, {
                        minOpacity: 0.3,
                        stride: Math.ceil(splat.instances.count / RADIUS_SAMPLE)
                    });
                    const refData = await read(reference);
                    for (const splat of missing) {
                        if (generation !== radiusGeneration) break;
                        const data = await read(splat);
                        if (generation !== radiusGeneration) break;
                        autoRadius.set(splat, autoMaxError(data.positions, refData.positions));
                    }
                    if (generation === radiusGeneration) break;
                }
            } catch (error) {
                // the core picks its own radius then
                console.warn('align: measuring the search radius failed', error);
            } finally {
                measuring = false;
            }
            updateRadiusUi();
        };
        const scheduleMeasure = () => {
            measureRadius();
        };
        const invalidateRadius = () => {
            radiusGeneration++;
            lastInvalidate = performance.now();
            autoRadius.clear();
            if (!active) return;
            scheduleMeasure();
            updateRadiusUi();
        };

        const refine = async () => {
            const reference = ref();
            if (refining || !reference) return null;
            const moving = splats().filter(s => s !== reference && s.visible);
            if (moving.length === 0) {
                message = i18n.t('sm.align.no-other');
                rebuildPanel();
                return null;
            }
            refining = true;
            message = '';
            const summary: Record<string, unknown> = {};
            events.fire('progressStart', i18n.t('sm.align.refine'), true);
            const cancel = events.on('progressCancel', () => abortAnalysis());
            try {
                const read = (splat: Splat) => readLayerData(splat, {
                    minOpacity: 0.3,
                    stride: Math.ceil(splat.instances.count / MAX_POINTS)
                });
                const refData = await read(reference);
                const ops: any[] = [];
                for (let li = 0; li < moving.length; li++) {
                    const splat = moving[li];
                    const data = await read(splat);
                    const base = li / moving.length;
                    // the radius the panel shows (manual, or the measured
                    // automatic one); the core picks its own when unmeasured
                    const radius = searchRadius > 0 ? searchRadius : autoRadius.get(splat);
                    const result = await runAnalysis<IcpResult>('icp', {
                        moving: data.positions,
                        reference: refData.positions,
                        options: { scale: useScale, maxError: typeof radius === 'number' && radius > 0 ? radius : undefined }
                    }, [], (p) => {
                        events.fire('progressUpdate', { text: `${i18n.t('sm.align.refine')}: ${splat.name}`, progress: 100 * (base + p / moving.length) });
                    });
                    refined.set(splat, result);
                    summary[splat.name] = { before: result.before, after: result.after, improved: result.improved, angleDeg: result.angleDeg, scale: result.scale, translation: result.translation, iterations: result.iterations };
                    if (!result.improved) {
                        message = `${splat.name}: ${i18n.t('sm.align.no-improvement')}`;
                        continue;
                    }
                    ops.push(...matrixOps(splat, result.matrix, result.scale));
                }
                if (ops.length) events.fire('edit.add', new MultiOp(ops));
            } catch (error) {
                if (error instanceof AbortedError) {
                    message = i18n.t('sm.align.cancelled');
                } else {
                    const text = `${(error as Error).message ?? error}`;
                    message = text.includes('do not overlap') ? i18n.t('sm.align.no-overlap') :
                        text.includes('too few points') ? i18n.t('sm.align.too-few') : i18n.t('sm.common.failed', { title: i18n.t('sm.align.refine'), error: text });
                }
            } finally {
                cancel.off();
                events.fire('progressEnd');
                refining = false;
                rebuildPanel();
                if (active) scheduleMeasure();
            }
            return summary;
        };

        // automatic alignment of every visible non-reference layer onto the
        // reference: global registration + ICP in the worker, one undo step
        const AUTO_POINTS = 400000;

        const auto = async () => {
            const reference = ref();
            if (refining || !reference) return null;
            const moving = splats().filter(s => s !== reference && s.visible);
            if (moving.length === 0) {
                message = i18n.t('sm.align.no-other');
                rebuildPanel();
                return null;
            }
            refining = true;
            message = '';
            const summary: Record<string, unknown> = {};
            const title = i18n.t('sm.align.auto');
            events.fire('progressStart', title, true);
            const cancel = events.on('progressCancel', () => abortAnalysis());
            try {
                const read = (splat: Splat) => readLayerData(splat, {
                    minOpacity: 0.3,
                    stride: Math.ceil(splat.instances.count / AUTO_POINTS)
                });
                const refData = await read(reference);
                const ops: any[] = [];
                for (let li = 0; li < moving.length; li++) {
                    const splat = moving[li];
                    const data = await read(splat);
                    const base = li / moving.length;
                    const result = await runAnalysis<AutoAlignResult>('auto', {
                        moving: data.positions,
                        reference: refData.positions,
                        movingColors: data.colors,
                        referenceColors: refData.colors,
                        options: { scale: useScale }
                    }, [], (p) => {
                        events.fire('progressUpdate', { text: `${title}: ${splat.name}`, progress: 100 * (base + p / moving.length) });
                    });
                    summary[splat.name] = {
                        candidates: result.candidates.map(c => ({ fitness: c.fitness, overlap: c.overlap, rmse: c.rmse, scale: c.scale, angleDeg: c.angleDeg })),
                        ambiguous: result.ambiguous,
                        matches: result.matches
                    };
                    if (!result.candidates.length) {
                        message = `${splat.name}: ${i18n.t('sm.align.auto-failed')}`;
                        autoResults.delete(splat);
                        continue;
                    }
                    const best = result.candidates[0];
                    autoResults.set(splat, { result, applied: 0 });
                    results.delete(splat);
                    refined.delete(splat);
                    ops.push(...matrixOps(splat, best.matrix, best.scale));
                }
                if (ops.length) events.fire('edit.add', new MultiOp(ops));
            } catch (error) {
                if (error instanceof AbortedError) {
                    message = i18n.t('sm.align.auto-cancelled');
                } else {
                    const text = `${(error as Error).message ?? error}`;
                    message = text.includes('too few points') ? i18n.t('sm.align.too-few') : i18n.t('sm.common.failed', { title, error: text });
                }
            } finally {
                cancel.off();
                events.fire('progressEnd');
                refining = false;
                rebuildPanel();
                if (active) scheduleMeasure();
            }
            return summary;
        };

        // switch every auto-aligned layer to its next candidate: undo the
        // applied correction, apply the other one (one undo step)
        const nextCandidate = () => {
            const ops: any[] = [];
            autoResults.forEach((entry, splat) => {
                const { candidates } = entry.result;
                if (candidates.length < 2 || !splat.scene) return;
                const next = (entry.applied + 1) % candidates.length;
                const current = new Mat4();
                current.data.set(candidates[entry.applied].matrix);
                const target = new Mat4();
                target.data.set(candidates[next].matrix);
                const delta = new Mat4().mul2(target, current.clone().invert());
                ops.push(...matrixOps(splat, Array.from(delta.data), candidates[next].scale / candidates[entry.applied].scale));
                entry.applied = next;
            });
            if (ops.length) events.fire('edit.add', new MultiOp(ops));
            rebuildPanel();
            return ops.length > 0;
        };

        // api

        events.function('align.run', run);
        events.function('align.refine', refine);
        events.function('align.auto', auto);
        events.function('align.nextCandidate', nextCandidate);
        // scene units; 0 = automatic
        events.function('align.setSearchRadius', (v: number) => {
            searchRadius = v > 0 ? v : 0;
            updateRadiusUi();
        });
        // what the panel shows: manual value, measured automatic value of the
        // shown layer, the radius the next refine uses for it and its text
        events.function('align.searchRadius', () => {
            const layer = shownLayer();
            const r = shownRadius();
            return { manual: searchRadius, auto: layer ? autoRadius.get(layer) : null, used: r, text: typeof r === 'number' ? len(r) : null, layer: layer?.name ?? null };
        });
        // the automatic radius depends on where the layers are
        ['splat.moved', 'splat.positionsChanged', 'splat.visibility', 'splat.replaced', 'scene.elementAdded', 'scene.elementRemoved'].forEach((name) => {
            events.on(name, invalidateRadius);
        });
        events.on('sceneScale.changed', () => {
            if (active) rebuildPanel();
        });
        i18n.onChange(() => {
            if (active) rebuildPanel();
        });
        events.function('align.anchors', (splat: Splat) => anchorsOf(splat).map(p => toWorld(splat, p)));
        events.function('align.reference', () => ref());
        events.on('align.setReference', (splat: Splat) => {
            reference = splat;
            results.clear();
            autoResults.clear();
            invalidateRadius();
            changed();
        });
        events.on('align.addAnchorWorld', (splat: Splat, world: Vec3) => {
            editAnchors(splat, list => list.push(toLocal(splat, world)));
        });
        events.on('align.setScale', (value: boolean) => {
            useScale = value;
            scaleInput.value = value;
        });

        events.on('align.changed', rebuildPanel);
        events.on('selection.changed', rebuildPanel);
        events.on('splat.moved', () => {
            scene.forceRender = true;
        });
        events.on('scene.elementRemoved', (element: any) => {
            autoResults.delete(element);
            if (anchors.delete(element)) changed();
        });
        events.on('scene.elementAdded', rebuildPanel);

        // serialization via Splat.docSerialize (anchors are layer-local)
        events.function('align.serialize', (splat: Splat) => {
            const list = anchors.get(splat);
            // the reference may be implicit (the first layer)
            const isReference = splat === ref();
            if (!list?.length && !isReference) return undefined;
            return { anchors: (list ?? []).map(p => [p.x, p.y, p.z]), reference: isReference };
        });
        events.function('align.deserialize', (splat: Splat, doc: any) => {
            if (!doc) return;
            anchors.set(splat, (doc.anchors ?? []).map((p: number[]) => new Vec3(p[0], p[1], p[2])));
            if (doc.reference) reference = splat;
            changed();
        });

        // tool lifecycle

        this.activate = () => {
            active = true;
            panel.hidden = false;
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            rebuildPanel();
            scheduleMeasure();
            scene.forceRender = true;
        };

        this.deactivate = () => {
            active = false;
            panel.hidden = true;
            down = null;
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            updateMarkers();
            scene.forceRender = true;
        };
    }
}

export { AlignTool };
