import { BooleanInput, Container, Label, SelectInput } from '@playcanvas/pcui';
import { Mat4, Vec3 } from 'playcanvas';

import type { ComposeAlignResult, OverlapResult, ZoneReport } from './compose-core';
import { button, el, formatCount, inView, scanName } from './compose-dom';
import { ComposeSuggest, SharpnessView } from './compose-suggest';
import { SuggestPanel } from './compose-suggest-ui';
import { matrixOps } from '../align/align-ops';
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

// Scan composition wizard ("Scan-Komposition"), phase 1: load 2-4 scans of
// one place, see them in their colours, align each at its transition zone
// with the scans already placed. The math runs in the analysis worker
// (src/compose/compose-core.ts); here are the steps, the panel, the colour per
// scan (a display-only grade the splat renderer asks for via 'compose.tint'),
// zone markers over the viewport and the undoable result (one MultiOp per
// run). Phase 2 adds step 3 "Analyse" (which scan is finer where) and step 4
// "Vorschläge" (hide the coarser version of an area, undoable): the state is
// in compose-suggest.ts, the panel in compose-suggest-ui.ts. Steps 5-6 (gap
// check, seam and result) follow in a later phase and show as such.

const COLORS = ['#c20e7e', '#00dcff', '#78ff5a', '#fff050'];
const MAX_SCANS = 4;
// points read per scan: light for the overlap, more for the alignment
const OVERLAP_POINTS = 100000;
const ALIGN_POINTS = 400000;
// zones shown per scan
const ZONES_SHOWN = 3;
// grade weight of the scan colour (the rest keeps the scan's own colours)
const TINT = 0.7;
const LUMA = [0.299, 0.587, 0.114];

const STEPS = ['load', 'align', 'analyse', 'suggest', 'gaps', 'result'] as const;
type Step = typeof STEPS[number];
const READY_STEPS = new Set<Step>(['load', 'align', 'analyse', 'suggest']);
// the steps of phase 2 (map, previews and the hide switch apply there)
const isWizardStep = (step: Step) => step === 'analyse' || step === 'suggest';
// keys the panel's buttons, checkboxes and selects handle themselves (the
// editor's own list of control keys, plus Escape that closes an open select)
const PANEL_KEYS = new Set([
    'Enter', ' ', 'Tab', 'Escape',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown'
]);

// the quick switch between the scans (all -> scan 1 -> ... -> all): Page
// Down / Arrow Right forward, Page Up / Arrow Left back. Neither moves the
// camera (fly mode is WASD/QE, src/shortcut-manager.ts); without modifiers
// only, and never while a control that uses them has the focus (see ownsKey)
const SWITCH_KEYS: Record<string, number> = { PageDown: 1, ArrowRight: 1, PageUp: -1, ArrowLeft: -1 };
// how long the on-screen label stays after switching back to all scans (ms)
const ALL_LABEL_MS = 1200;

// the focused element handles this key itself: text entry, selects,
// sliders, number fields, radio buttons, menus and modal overlays
const ownsKey = (target: EventTarget | null) => {
    if (!(target instanceof Element) || target === document.body) return false;
    if (target.closest('textarea, select, [contenteditable], .blocks-shortcuts, .pcui-select-input, .pcui-slider, .pcui-numeric-input, [role="slider"], [role="listbox"], [role="menu"], [role="radiogroup"]')) return true;
    const input = target.closest('input');
    return !!input && input.type !== 'checkbox' && input.type !== 'button';
};

type Position = 'auto' | 'never' | 'always';

type AlignEntry = {
    result: ComposeAlignResult,
    // the placed scan it shared most with (null: the reference)
    partner: Splat | null,
    // the world transform the result belongs to: when the scan moved since,
    // the zones are stale
    expected: Mat4,
    // the run that placed it (its alternatives are relative to startWorld,
    // the scan's world transform before that run) and which of its places is
    // applied: 0 the chosen one, n alternative n
    original: ComposeAlignResult,
    startWorld: Mat4,
    choice: number
};

const UNKNOWN_SCALE: SceneScale = { mode: 'auto', metersPerUnit: 1, known: false, source: 'unknown' };

const hexToRgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

// the display grade for one scan colour: mostly the colour, shaded by the
// scan's own brightness (rows as the projector reads them, see color-grade.ts)
const tintRows = (hex: string) => {
    const c = hexToRgb(hex).map(v => Math.min(1.6, v * 1.35 + 0.1));
    const rows = new Float32Array(12);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            rows[i * 4 + j] = (1 - TINT) * (i === j ? 1 : 0) + TINT * c[i] * LUMA[j];
        }
        rows[i * 4 + 3] = 0.03;
    }
    return rows;
};

const transformPoints = (m: number[], p: Float32Array) => {
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    return out;
};

const concat = (parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
};

const isIdentity = (m: number[]) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);

class ComposeTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        let active = false;
        let step: Step = 'load';
        let busy = false;
        let message = '';
        // layers the user took out of the composition
        const excluded = new Set<Splat>();
        let manualReference: Splat | null = null;
        // the first suggestion for a set of scans stays the reference: once the
        // scans moved apart, a new overlap measurement means nothing
        let keptReference: { scans: Splat[], splat: Splat } | null = null;
        let overlap: { scans: Splat[], result: OverlapResult } | null = null;
        const aligned = new Map<Splat, AlignEntry>();
        let position: Position = 'auto';
        // scale on: exports of one place can differ by 0.15-0.6 % (L3 museum),
        // and metric scans keep 1.0000 anyway (PortalCam)
        let useScale = true;
        let showColors = true;
        let showZones = true;
        // one scan at a time (display only, see 'compose.layerShown'): the
        // scan shown alone, null = all
        let solo: Splat | null = null;
        let hoverZone: { splat: Splat, index: number } | null = null;

        const sceneScale = (): SceneScale => (events.functions.has('sceneScale.get') ? events.invoke('sceneScale.get') : UNKNOWN_SCALE);
        const len = (v: number) => formatLength(v, sceneScale());

        const layers = () => (scene.getElementsByType(ElementType.splat) as Splat[]);
        const included = () => layers().filter(s => !excluded.has(s)).slice(0, MAX_SCANS);
        // a scan's name in the compose texts (numbered when two layers share it)
        const nameOf = (splat: Splat) => scanName(splat, layers());
        const colorOf = (splat: Splat) => COLORS[Math.max(0, included().indexOf(splat)) % COLORS.length];

        // the overlap measurement belongs to exactly these scans
        const overlapFor = (scans: Splat[]) => (overlap && overlap.scans.length === scans.length && overlap.scans.every((s, i) => s === scans[i]) ? overlap.result : null);

        const sameSet = (a: Splat[], b: Splat[]) => a.length === b.length && a.every(s => b.includes(s));
        const suggested = () => {
            const scans = included();
            if (keptReference && sameSet(keptReference.scans, scans)) return keptReference.splat;
            const result = overlapFor(scans);
            if (!result) return null;
            keptReference = { scans, splat: scans[result.reference] };
            return keptReference.splat;
        };
        const reference = () => {
            const scans = included();
            if (manualReference && scans.includes(manualReference)) return manualReference;
            return suggested() ?? scans[0] ?? null;
        };

        const changed = () => {
            rebuild();
            scene.forceRender = true;
        };

        // the sharpness view ('Schärfe'): every splat by its blur in its scan
        const sharpness = new SharpnessView(events, scene, () => changed());

        // phase 2: analysis and suggestions (state, display buffers, api)
        const suggest = new ComposeSuggest(events, scene, {
            active: () => active,
            step: () => step,
            included,
            reference,
            nameOf,
            colors: COLORS,
            onChange: changed,
            sharpness: (splat: Splat, hideLocked: boolean) => sharpness.params(splat, hideLocked)
        });

        const tints = new Map<string, Float32Array>();
        events.function('compose.tint', (splat: Splat) => {
            // the map, a preview or marking show their own colours
            if (!active || !showColors || sharpness.enabled || suggest.suppressTint() || !included().includes(splat)) return null;
            const color = colorOf(splat);
            let rows = tints.get(color);
            if (!rows) {
                rows = tintRows(color);
                tints.set(color, rows);
            }
            return rows;
        });

        // ------------------------------------------------------------ ui

        const overlay = document.createElement('div');
        overlay.id = 'compose-overlay';
        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.classList.add('compose-zone-box');
        const boxPath = document.createElementNS(svgNs, 'path');
        svg.appendChild(boxPath);
        overlay.appendChild(svg);
        canvasContainer.dom.appendChild(overlay);

        const panel = new Container({ id: 'compose-panel', hidden: true });
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((name) => {
            panel.dom.addEventListener(name, e => e.stopPropagation());
        });
        // the panel takes the focus only when a rebuild removed the focused
        // control (see refocus), and is focusable only while it holds it: a
        // click on its text leaves the focus where it was, as on any panel
        panel.dom.addEventListener('blur', () => panel.dom.removeAttribute('tabindex'));
        // keys the panel's own controls handle stay in the panel; every other
        // key reaches the editor's shortcuts also from a focused button or
        // checkbox: "Auswählen" on a suggestion, then H hides the selection
        panel.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            const target = e.target instanceof Element ? e.target : null;
            const typing = !!target?.closest('textarea, [contenteditable], input:not([type="checkbox"]):not([type="radio"])');
            if (typing || PANEL_KEYS.has(e.key)) e.stopPropagation();
            // the panel holds the focus in place of a control that went away:
            // Space, meant for that control, does nothing (it would scroll)
            if (e.target === panel.dom && e.key === ' ') e.preventDefault();
        });
        canvasContainer.append(panel);
        makeFloating(panel, { key: 'compose', title: 'sm.compose.title', extras: [helpButton(events, 'compose')] });

        const stepBar = document.createElement('div');
        stepBar.classList.add('compose-steps');
        panel.dom.appendChild(stepBar);
        const body = document.createElement('div');
        body.classList.add('compose-body');
        panel.dom.appendChild(body);

        // display options, shared by all steps
        const viewRow = new Container({ class: 'compose-view' });
        const colorsInput = new BooleanInput({ value: showColors });
        const colorsLabel = new Label({ class: 'compose-view-label' });
        i18n.bindText(colorsLabel, 'sm.compose.view.colors');
        colorsInput.on('change', (value: boolean) => {
            showColors = value;
            changed();
        });
        colorsLabel.dom.addEventListener('click', () => {
            colorsInput.value = !colorsInput.value;
        });
        const zonesInput = new BooleanInput({ value: showZones });
        const zonesLabel = new Label({ class: 'compose-view-label' });
        // zone markers in steps 1-2, suggestion pills in steps 3-4
        const zonesText = () => i18n.t(isWizardStep(step) ? 'sm.compose.view.markers' : 'sm.compose.view.zones');
        i18n.bindText(zonesLabel, zonesText);
        zonesInput.on('change', (value: boolean) => {
            showZones = value;
            changed();
        });
        zonesLabel.dom.addEventListener('click', () => {
            zonesInput.value = !zonesInput.value;
        });
        // steps 3-4: the map of which scan is finer, and locked splats left
        // out entirely
        const mapInput = new BooleanInput({ value: suggest.map });
        const mapLabel = new Label({ class: 'compose-view-label' });
        i18n.bindText(mapLabel, 'sm.compose.view.map');
        i18n.bindDom(mapLabel.dom, 'sm.compose.view.map-tip', 'title');
        mapInput.on('change', (value: boolean) => {
            if (value && sharpness.enabled) events.fire('compose.setSharpness', false);
            if (value !== suggest.map) events.fire('compose.setMap', value);
        });
        mapLabel.dom.addEventListener('click', () => {
            mapInput.value = !mapInput.value;
        });
        const hiddenInput = new BooleanInput({ value: suggest.hideLocked });
        const hiddenLabel = new Label({ class: 'compose-view-label' });
        i18n.bindText(hiddenLabel, 'sm.compose.view.hidden');
        i18n.bindDom(hiddenLabel.dom, 'sm.compose.view.hidden-tip', 'title');
        hiddenInput.on('change', (value: boolean) => {
            if (value !== suggest.hideLocked) events.fire('compose.setHideLocked', value);
        });
        hiddenLabel.dom.addEventListener('click', () => {
            hiddenInput.value = !hiddenInput.value;
        });
        // all steps: the sharpness view
        const sharpInput = new BooleanInput({ value: sharpness.enabled });
        const sharpLabel = new Label({ class: 'compose-view-label' });
        i18n.bindText(sharpLabel, 'sm.compose.view.sharpness');
        i18n.bindDom(sharpLabel.dom, 'sm.compose.view.sharpness-tip', 'title');
        sharpInput.on('change', (value: boolean) => {
            if (value !== sharpness.enabled) events.fire('compose.setSharpness', value);
        });
        sharpLabel.dom.addEventListener('click', () => {
            sharpInput.value = !sharpInput.value;
        });
        // the quick switch: ◀ shown scan(s) ▶, the same cycle as the keys
        const switchBox = el('span', 'compose-switch');
        i18n.bindDom(switchBox, 'sm.compose.view.solo-tip', 'title');
        const switchPrev = button('◀', () => events.fire('compose.prevSolo'), ['small', 'compose-switch-arrow']);
        const switchText = el('span', 'compose-switch-text');
        switchText.setAttribute('role', 'button');
        switchText.addEventListener('click', () => events.fire('compose.nextSolo'));
        const switchNext = button('▶', () => events.fire('compose.nextSolo'), ['small', 'compose-switch-arrow']);
        const switchKeys = el('span', 'compose-switch-keys');
        switchBox.append(switchPrev, switchText, switchNext, switchKeys);
        // each checkbox stays on one line with its label: the row wraps
        // between the pairs, never inside one
        const viewItem = (input: BooleanInput, label: Label) => {
            const item = new Container({ class: 'compose-view-item' });
            item.append(input);
            item.append(label);
            viewRow.append(item);
            return item;
        };
        viewItem(colorsInput, colorsLabel);
        viewItem(zonesInput, zonesLabel);
        const mapItem = viewItem(mapInput, mapLabel);
        const hiddenItem = viewItem(hiddenInput, hiddenLabel);
        viewItem(sharpInput, sharpLabel);
        viewRow.dom.appendChild(switchBox);
        panel.append(viewRow);
        // the sharpness view's legend (and "computing" while it reads)
        const sharpLegend = el('div', 'compose-sharp-legend');
        panel.dom.insertBefore(sharpLegend, viewRow.dom.nextSibling);

        // on-screen label of the quick switch ("Nur scan.ply (1)" / "Alle Scans")
        const switchLabel = el('div', 'compose-switch-label');
        canvasContainer.dom.appendChild(switchLabel);
        let allLabelUntil = 0;
        let allLabelTimer: ReturnType<typeof setTimeout> | null = null;

        const messageLabel = new Label({ class: 'compose-message' });
        panel.append(messageLabel);

        // pcui elements of the current step, destroyed when it is rebuilt
        // (el, button and formatCount come from compose-dom.ts)
        const transient: Container[] = [];

        // offset quality: good under 1 cm, unclear up to 3 cm (relative to the
        // zone voxel when the scale is unknown)
        const quality = (offset: number | null | undefined, voxel: number) => {
            if (offset === null || offset === undefined) return 'unknown';
            const sc = sceneScale();
            const good = sc.known ? 0.01 / sc.metersPerUnit : voxel / 60;
            const warn = sc.known ? 0.03 / sc.metersPerUnit : voxel / 20;
            return offset <= good ? 'good' : offset <= warn ? 'warn' : 'bad';
        };

        const stale = (splat: Splat) => {
            const entry = aligned.get(splat);
            if (!entry) return false;
            const now = splat.entity.getWorldTransform().data;
            const want = entry.expected.data;
            const size = Math.max(1, ...[12, 13, 14].map(i => Math.abs(want[i])));
            return now.some((v, i) => Math.abs(v - want[i]) > (i >= 12 ? 1e-4 * size : 1e-4));
        };

        // steps 3-4
        const suggestUi = new SuggestPanel({
            events,
            suggest,
            sceneScale,
            len,
            colorOf,
            nameOf,
            included,
            unaligned: () => {
                const ref = reference();
                return included().filter(s => s !== ref && (!aligned.has(s) || stale(s)));
            },
            step: () => step,
            busy: () => busy || suggest.busy,
            onChange: changed
        });
        // a new analysis starts with the card list folded
        events.on('compose.analysed', () => {
            suggestUi.reset();
            changed();
        });

        // zones worth showing for a scan: the used one and the larger others
        const shownZones = (entry: AlignEntry) => entry.result.zones
        .map((zone, index) => ({ zone, index }))
        .filter(({ zone, index }) => index === entry.result.usedZone || zone.share >= 0.05)
        .slice(0, ZONES_SHOWN);

        const offsetText = (zone: ZoneReport) => {
            const after = zone.after;
            if (!after) return '?';
            return after.localMax > after.median * 1.5 ?
                `${len(after.median)} ${i18n.t('sm.compose.align.local', { min: len(after.localMin), max: len(after.localMax) })}` :
                len(after.median);
        };

        // hovering a zone row outlines the zone in the view
        const hoverable = (row: HTMLElement, splat: Splat, index: number) => {
            row.addEventListener('pointerenter', () => {
                hoverZone = { splat, index };
                scene.forceRender = true;
            });
            row.addEventListener('pointerleave', () => {
                hoverZone = null;
                scene.forceRender = true;
            });
        };

        const rebuildSteps = () => {
            stepBar.innerHTML = '';
            STEPS.forEach((s, i) => {
                const ready = READY_STEPS.has(s);
                const b = el('span', ['compose-step', ...(s === step ? ['active'] : []), ...(ready ? [] : ['later'])], `${i + 1} ${i18n.t(`sm.compose.step.${s}`)}`);
                b.title = ready ? '' : i18n.t('sm.compose.step-later');
                if (ready) {
                    b.setAttribute('role', 'button');
                    b.addEventListener('click', () => events.fire('compose.setStep', s));
                }
                stepBar.appendChild(b);
            });
        };

        const rebuildLoad = () => {
            body.appendChild(el('div', 'compose-hint', i18n.t('sm.compose.load.hint')));
            const scans = included();
            const ref = reference();
            const list = el('div', 'compose-scans');
            for (const splat of layers()) {
                const inside = scans.includes(splat);
                const row = el('div', ['compose-scan', ...(inside ? [] : ['excluded'])]);
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.checked = inside;
                check.disabled = busy || (!inside && scans.length >= MAX_SCANS);
                check.title = i18n.t('sm.compose.include-tip');
                check.addEventListener('change', () => events.fire('compose.include', splat, check.checked));
                const swatch = el('span', 'compose-swatch');
                swatch.style.backgroundColor = inside ? colorOf(splat) : 'transparent';
                const name = el('span', 'compose-name', nameOf(splat));
                name.title = nameOf(splat);
                const info = el('span', 'compose-info', formatCount(splat.instances.count));
                row.append(check, swatch, name, info);
                if (inside) {
                    const radio = document.createElement('input');
                    radio.type = 'radio';
                    radio.name = 'compose-reference';
                    radio.checked = splat === ref;
                    radio.disabled = busy;
                    radio.title = i18n.t('sm.compose.reference-tip');
                    radio.addEventListener('change', () => events.fire('compose.setReference', splat));
                    const refLabel = el('span', 'compose-ref-label', splat === ref ?
                        `${i18n.t('sm.compose.reference')}${splat === suggested() ? ` (${i18n.t('sm.compose.suggested')})` : ''}` : '');
                    row.append(radio, refLabel);
                }
                list.appendChild(row);
            }
            body.appendChild(list);

            const actions = el('div', 'compose-row');
            actions.appendChild(button(i18n.t('sm.compose.add'), () => events.invoke('scene.import')));
            body.appendChild(actions);

            if (scans.length < 2) {
                body.appendChild(el('div', 'compose-note', i18n.t('sm.compose.need-two')));
                return;
            }
            const result = overlapFor(scans);
            const box = el('div', 'compose-overlap');
            box.appendChild(el('div', 'compose-subheading', i18n.t('sm.compose.overlap.title')));
            if (!result) {
                box.appendChild(el('div', 'compose-note', i18n.t('sm.compose.overlap.measuring')));
            } else {
                let apart = true;
                for (let i = 0; i < scans.length; i++) {
                    for (let j = i + 1; j < scans.length; j++) {
                        const shared = result.shared[i][j];
                        const smaller = Math.min(result.occupied[i], result.occupied[j]);
                        const value = smaller ? Math.round(100 * shared / smaller) : 0;
                        if (value >= 10) apart = false;
                        const line = el('div', 'compose-pair');
                        const a = el('span', 'compose-dot');
                        a.style.backgroundColor = colorOf(scans[i]);
                        const b = el('span', 'compose-dot');
                        b.style.backgroundColor = colorOf(scans[j]);
                        line.append(a, b, el('span', '', value > 0 ?
                            i18n.t('sm.compose.overlap.pair', { a: nameOf(scans[i]), b: nameOf(scans[j]), value }) :
                            i18n.t('sm.compose.overlap.none', { a: nameOf(scans[i]), b: nameOf(scans[j]) })));
                        box.appendChild(line);
                    }
                }
                const sug = suggested();
                if (sug) box.appendChild(el('div', 'compose-note', i18n.t('sm.compose.overlap.suggestion', { name: nameOf(sug) })));
                if (apart) box.appendChild(el('div', ['compose-note', 'warn'], i18n.t('sm.compose.overlap.apart')));
            }
            body.appendChild(box);

            const nav = el('div', 'compose-row');
            nav.appendChild(button(i18n.t('sm.compose.next', { step: i18n.t('sm.compose.step.align') }), () => events.fire('compose.setStep', 'align'), ['primary']));
            body.appendChild(nav);
        };

        const rebuildAlign = () => {
            body.appendChild(el('div', 'compose-hint', i18n.t('sm.compose.align.hint')));
            const scans = included();
            if (scans.length < 2) {
                body.appendChild(el('div', 'compose-note', i18n.t('sm.compose.need-two')));
                return;
            }

            // options (pcui elements, destroyed on the next rebuild)
            const options = new Container({ class: 'compose-options' });
            transient.push(options);
            const posRow = new Container({ class: 'compose-row' });
            const posLabel = new Label({ class: 'compose-label', text: i18n.t('sm.compose.align.position') });
            posLabel.dom.title = i18n.t('sm.compose.align.position-tip');
            const posInput = new SelectInput({
                class: 'compose-select',
                value: position,
                options: (['auto', 'never', 'always'] as Position[]).map(v => ({ v, t: i18n.t(`sm.compose.position.${v}`) }))
            });
            posInput.on('change', (value: Position) => {
                position = value;
            });
            posRow.append(posLabel);
            posRow.append(posInput);
            options.append(posRow);
            const scaleRow = new Container({ class: 'compose-row' });
            const scaleLabel = new Label({ class: 'compose-label', text: i18n.t('sm.compose.align.scale') });
            const scaleInput = new BooleanInput({ value: useScale });
            scaleInput.on('change', (value: boolean) => {
                useScale = value;
            });
            scaleRow.append(scaleLabel);
            scaleRow.append(scaleInput);
            options.append(scaleRow);
            body.appendChild(options.dom);

            const run = el('div', 'compose-row');
            const runButton = button(i18n.t('sm.compose.align.run'), () => events.invoke('compose.align'), ['primary', ...(busy ? ['disabled'] : [])]);
            run.appendChild(runButton);
            body.appendChild(run);

            // results per scan
            const ref = reference();
            const list = el('div', 'compose-results');
            let worst = -1;
            let check = 0;
            let anyStale = false;
            for (const splat of scans) {
                const card = el('div', 'compose-result');
                const head = el('div', 'compose-result-head');
                const swatch = el('span', 'compose-swatch');
                swatch.style.backgroundColor = colorOf(splat);
                head.append(swatch, el('span', 'compose-name', nameOf(splat)));
                card.appendChild(head);
                const entry = aligned.get(splat);
                if (splat === ref) {
                    card.appendChild(el('div', 'compose-info', i18n.t('sm.compose.align.reference-row')));
                } else if (!entry) {
                    card.appendChild(el('div', 'compose-info', '–'));
                } else {
                    const r = entry.result;
                    const isStale = stale(splat);
                    anyStale = anyStale || isStale;
                    const used = r.zones[r.usedZone];
                    const parts = [
                        entry.partner ? i18n.t('sm.compose.align.attached', { name: nameOf(entry.partner) }) : '',
                        i18n.t(`sm.compose.align.${r.coarse}`)
                    ].filter(Boolean);
                    if (used?.after) {
                        parts.push(i18n.t('sm.compose.align.seam', { value: len(used.after.median) }));
                        worst = Math.max(worst, used.after.median);
                    }
                    // a position found anew can be a wrong look-alike place
                    // (repetitive rooms): always worth a look
                    if (r.coarse !== 'kept') check++;
                    const status = el('div', ['compose-info', ...(r.coarse === 'failed' ? ['bad'] : r.coarse === 'global' ? ['warn'] : []), ...(isStale ? ['stale'] : [])], parts.join(' · '));
                    card.appendChild(status);
                    if (showZones) {
                        for (const { zone, index } of shownZones(entry)) {
                            const row = el('div', ['compose-zone', `q-${quality(zone.after?.median, r.voxel)}`]);
                            if (zone.after) row.title = i18n.t('sm.compose.zone.surface-tip', { value: len(zone.after.surface) });
                            row.appendChild(el('span', 'compose-zone-text', `${i18n.t('sm.compose.align.zone', { n: index + 1, share: Math.round(zone.share * 100) })} · ${i18n.t('sm.compose.zone.offset', { value: offsetText(zone) })}`));
                            if (index === r.usedZone) row.appendChild(el('span', 'compose-zone-used', i18n.t('sm.compose.zone.used')));
                            const fly = button('⌖', () => events.fire('compose.focusZone', splat, index), ['small'], i18n.t('sm.compose.zone.fly-tip'));
                            row.appendChild(fly);
                            if (index !== r.usedZone) {
                                row.appendChild(button(i18n.t('sm.compose.zone.here'), () => events.invoke('compose.alignZone', splat, index), ['small', ...(busy ? ['disabled'] : [])], i18n.t('sm.compose.zone.here-tip')));
                            }
                            hoverable(row, splat, index);
                            card.appendChild(row);
                        }
                    }
                    const fix = el('div', 'compose-row');
                    const places = 1 + entry.original.alternatives.length;
                    if (places > 1) {
                        fix.appendChild(button(i18n.t('sm.compose.align.other', { index: entry.choice + 1, count: places }), () => events.invoke('compose.nextAlternative', splat), ['small', ...(busy ? ['disabled'] : [])], i18n.t('sm.compose.align.other-tip')));
                    }
                    fix.appendChild(button(i18n.t('sm.compose.align.anchors'), () => events.fire('compose.anchors', splat), ['small'], i18n.t('sm.compose.align.anchors-tip')));
                    card.appendChild(fix);
                }
                list.appendChild(card);
            }
            body.appendChild(list);

            if (anyStale) body.appendChild(el('div', ['compose-note', 'warn'], i18n.t('sm.compose.align.stale')));
            if (worst >= 0) {
                body.appendChild(el('div', 'compose-note', `${i18n.t('sm.compose.align.done', { value: len(worst) })}${check ? ` ${i18n.t('sm.compose.align.done-check', { n: check })}` : ''}`));
            }

            const nav = el('div', 'compose-row');
            nav.appendChild(button(i18n.t('sm.compose.back'), () => events.fire('compose.setStep', 'load')));
            nav.appendChild(button(i18n.t('sm.compose.next', { step: i18n.t('sm.compose.step.analyse') }), () => events.fire('compose.setStep', 'analyse'), ['primary']));
            body.appendChild(nav);
        };

        // the focused control of the body, by its key (data-key, see
        // compose-dom button): a rebuild replaces it, and focus left on
        // <body> would hand the next Space to the editor (timeline playback)
        const focusedKey = () => {
            const focused = document.activeElement;
            if (!(focused instanceof HTMLElement) || !body.contains(focused)) return null;
            return focused.closest<HTMLElement>('[data-key]')?.dataset.key ?? '';
        };
        // the control of that key again; when it is gone (a step change, an
        // accepted card) or takes no focus (a disabled checkbox: the tick of
        // a card hidden by hand, "Alle anhaken" once the analysis is stale),
        // the panel itself, which keeps the keys away from the editor until
        // Tab moves on
        const refocus = (key: string | null) => {
            if (key === null) return;
            const target = key ? body.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
            if (target) {
                target.focus({ preventScroll: true });
                if (document.activeElement === target) return;
            }
            panel.dom.tabIndex = -1;
            panel.dom.focus({ preventScroll: true });
        };

        function rebuild() {
            if (!active) return;
            suggest.refreshScans();
            rebuildSteps();
            const focusKey = focusedKey();
            transient.splice(0).forEach(e => e.destroy());
            body.innerHTML = '';
            if (step === 'load') rebuildLoad();
            else if (step === 'align') rebuildAlign();
            else if (step === 'analyse') suggestUi.buildAnalyse(body, transient);
            else suggestUi.buildSuggest(body);
            refocus(focusKey);
            const wizard = isWizardStep(step);
            zonesLabel.text = zonesText();
            mapItem.hidden = !wizard;
            hiddenItem.hidden = !wizard;
            if (mapInput.value !== suggest.map) mapInput.value = suggest.map;
            if (hiddenInput.value !== suggest.hideLocked) hiddenInput.value = suggest.hideLocked;
            if (sharpInput.value !== sharpness.enabled) sharpInput.value = sharpness.enabled;
            updateSwitch();
            sharpLegend.hidden = !sharpness.enabled;
            sharpLegend.textContent = sharpness.computing() ?
                i18n.t('sm.compose.view.sharpness-computing') : i18n.t('sm.compose.view.sharpness-legend');
            const text = wizard ? suggest.message || message : message;
            messageLabel.text = text;
            messageLabel.hidden = !text;
        }

        // ------------------------------------------------------------ markers

        const markers: HTMLElement[] = [];
        const tmp = new Vec3();
        const screen = new Vec3();

        const project = (p: number[], w: number, h: number) => {
            const cam = scene.camera.mainCamera;
            tmp.set(p[0], p[1], p[2]);
            const visible = tmp.clone().sub(cam.getPosition()).dot(cam.forward) > 0;
            scene.camera.worldToScreen(tmp, screen);
            return { x: screen.x * w, y: screen.y * h, visible };
        };

        // the dashed outline of a box (a hovered zone or suggestion)
        const drawBox = (box: { min: number[], max: number[], color: string } | null, w: number, h: number) => {
            if (!box) {
                boxPath.setAttribute('d', '');
                return;
            }
            const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(c => project([
                c & 1 ? box.max[0] : box.min[0],
                c & 2 ? box.max[1] : box.min[1],
                c & 4 ? box.max[2] : box.min[2]
            ], w, h));
            const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
            boxPath.setAttribute('d', edges
            .filter(([a, b]) => corners[a].visible && corners[b].visible)
            .map(([a, b]) => `M${corners[a].x},${corners[a].y}L${corners[b].x},${corners[b].y}`)
            .join(''));
            boxPath.style.stroke = box.color;
        };

        const updateOverlay = () => {
            const wizard = isWizardStep(step);
            if (!active || (!showZones && !wizard)) {
                overlay.style.display = 'none';
                return;
            }
            overlay.style.display = '';
            const w = canvasContainer.dom.clientWidth;
            const h = canvasContainer.dom.clientHeight;
            if (wizard) {
                // steps 3-4: suggestion pills ('Marker') and the hovered box
                markers.forEach((m) => {
                    m.style.display = 'none';
                });
                suggestUi.updatePills(overlay, showZones, w, h, project);
                drawBox(suggestUi.hoverBox(), w, h);
                return;
            }
            suggestUi.updatePills(overlay, false, w, h, project);
            let i = 0;
            const scans = included();
            aligned.forEach((entry, splat) => {
                if (!scans.includes(splat) || !splat.visible || stale(splat)) return;
                for (const { zone, index } of shownZones(entry)) {
                    let marker = markers[i];
                    if (!marker) {
                        marker = document.createElement('div');
                        marker.classList.add('compose-marker');
                        marker.addEventListener('click', () => {
                            const target = marker as HTMLElement & { zoneRef?: { splat: Splat, index: number } };
                            if (target.zoneRef) events.fire('compose.focusZone', target.zoneRef.splat, target.zoneRef.index);
                        });
                        overlay.appendChild(marker);
                        markers.push(marker);
                    }
                    const p = project(zone.centre, w, h);
                    // far outside the view it would widen the container's
                    // scroll area (as the suggestion pills, see inView)
                    marker.style.display = inView(p, w, h) ? '' : 'none';
                    marker.style.left = `${p.x}px`;
                    marker.style.top = `${p.y}px`;
                    marker.style.borderColor = colorOf(splat);
                    marker.className = `compose-marker q-${quality(zone.after?.median, entry.result.voxel)}${index === entry.result.usedZone ? ' used' : ''}`;
                    marker.textContent = zone.after ? len(zone.after.median) : '?';
                    marker.title = `${nameOf(splat)} · ${i18n.t('sm.compose.align.zone', { n: index + 1, share: Math.round(zone.share * 100) })}`;
                    (marker as HTMLElement & { zoneRef?: { splat: Splat, index: number } }).zoneRef = { splat, index };
                    i++;
                }
            });
            for (; i < markers.length; i++) markers[i].style.display = 'none';

            // outline of the hovered zone
            const hz = hoverZone && aligned.get(hoverZone.splat)?.result.zones[hoverZone.index];
            drawBox(hz ? { min: hz.min, max: hz.max, color: colorOf(hoverZone.splat) } : null, w, h);
        };
        events.on('postrender', updateOverlay);

        // ------------------------------------------------------------ work

        const read = (splat: Splat, points: number) => readLayerData(splat, {
            minOpacity: 0.3,
            stride: Math.max(1, Math.ceil(splat.instances.count / points))
        });

        const measureOverlap = async () => {
            const scans = included();
            if (busy || scans.length < 2) return;
            busy = true;
            changed();
            try {
                const clouds: Float32Array[] = [];
                for (const splat of scans) clouds.push((await read(splat, OVERLAP_POINTS)).positions);
                const result = await runAnalysis<OverlapResult>('compose-overlap', { clouds, options: {} });
                overlap = { scans, result };
                message = '';
            } catch (error) {
                message = i18n.t('sm.common.failed', { title: i18n.t('sm.compose.overlap.title'), error: `${(error as Error).message ?? error}` });
            } finally {
                busy = false;
                changed();
            }
        };

        let measureTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleOverlap = () => {
            if (measureTimer) clearTimeout(measureTimer);
            measureTimer = setTimeout(() => {
                measureTimer = null;
                if (active && included().length >= 2 && !overlapFor(included())) measureOverlap();
            }, 400);
        };

        // attach order from the shared voxel counts (as in compose-core)
        const orderFrom = (shared: number[][], ref: number) => {
            const n = shared.length;
            const placed = new Set([ref]);
            const order: { scan: number, partner: number }[] = [];
            while (placed.size < n) {
                let pick = -1;
                let partner = -1;
                let most = -1;
                for (let u = 0; u < n; u++) {
                    if (placed.has(u)) continue;
                    for (const p of placed) {
                        if (shared[u][p] > most) {
                            most = shared[u][p];
                            pick = u;
                            partner = p;
                        }
                    }
                }
                placed.add(pick);
                order.push({ scan: pick, partner });
            }
            return order;
        };

        const withProgress = async <T>(title: string, fn: () => Promise<T>) => {
            events.fire('progressStart', title, true);
            const cancel = events.on('progressCancel', () => abortAnalysis());
            try {
                return await fn();
            } finally {
                cancel.off();
                events.fire('progressEnd');
            }
        };

        const alignAll = async () => {
            if (busy) return null;
            const scans = included();
            if (scans.length < 2) return null;
            if (!overlapFor(scans)) await measureOverlap();
            const result = overlapFor(scans);
            if (!result) return null;
            const ref = reference();
            const order = orderFrom(result.shared, scans.indexOf(ref));
            busy = true;
            message = '';
            changed();
            const summary: Record<string, unknown> = {};
            const title = i18n.t('sm.compose.align.run');
            try {
                await withProgress(title, async () => {
                    const data = new Map<Splat, { positions: Float32Array, colors: Float32Array }>();
                    for (let k = 0; k < scans.length; k++) {
                        events.fire('progressUpdate', { text: `${title}: ${nameOf(scans[k])}`, progress: 5 * k / scans.length });
                        const d = await read(scans[k], ALIGN_POINTS);
                        data.set(scans[k], { positions: d.positions, colors: d.colors });
                    }
                    const placed = new Map<Splat, Float32Array>([[ref, data.get(ref).positions]]);
                    const ops: any[] = [];
                    const results = new Map<Splat, AlignEntry>();
                    for (let k = 0; k < order.length; k++) {
                        const splat = scans[order[k].scan];
                        const partner = scans[order[k].partner];
                        const own = data.get(splat);
                        const others = [...placed.keys()];
                        const r = await runAnalysis<ComposeAlignResult>('compose-align', {
                            moving: own.positions,
                            reference: concat(others.map(s => placed.get(s))),
                            movingColors: own.colors,
                            referenceColors: concat(others.map(s => data.get(s).colors)),
                            options: { scale: useScale, coarse: position }
                        }, [], (p: number) => {
                            events.fire('progressUpdate', { text: `${title}: ${nameOf(splat)}`, progress: 5 + 95 * (k + p) / order.length });
                        });
                        placed.set(splat, transformPoints(r.matrix, own.positions));
                        const m = new Mat4();
                        m.data.set(r.matrix);
                        const startWorld = new Mat4().copy(splat.entity.getWorldTransform());
                        results.set(splat, { result: r, partner, expected: new Mat4().mul2(m, startWorld), original: r, startWorld, choice: 0 });
                        if (!isIdentity(r.matrix)) ops.push(...matrixOps(events, splat, r.matrix, r.scale));
                        summary[nameOf(splat)] = {
                            partner: nameOf(partner),
                            coarse: r.coarse,
                            mode: r.mode,
                            startShare: r.startShare,
                            fitBefore: r.fitBefore,
                            fitAfter: r.fitAfter,
                            angleDeg: r.angleDeg,
                            shift: r.shift,
                            usedZone: r.usedZone,
                            zones: r.zones.map(z => ({ share: z.share, voxels: z.voxels, before: z.before?.median ?? null, after: z.after?.median ?? null, localMin: z.after?.localMin ?? null, localMax: z.after?.localMax ?? null }))
                        };
                    }
                    aligned.clear();
                    results.forEach((v, k) => aligned.set(k, v));
                    if (ops.length) events.fire('edit.add', new MultiOp(ops));
                });
            } catch (error) {
                message = error instanceof AbortedError ? i18n.t('sm.compose.align.cancelled') :
                    i18n.t('sm.common.failed', { title, error: `${(error as Error).message ?? error}` });
            } finally {
                busy = false;
                changed();
            }
            return summary;
        };

        // align one scan again, at the zone the user picked
        const alignZone = async (splat: Splat, index: number) => {
            const entry = aligned.get(splat);
            const zone = entry?.result.zones[index];
            if (busy || !entry || !zone) return null;
            busy = true;
            message = '';
            changed();
            const title = i18n.t('sm.compose.zone.here');
            let summary: Record<string, unknown> = null;
            try {
                await withProgress(title, async () => {
                    const others = included().filter(s => s !== splat);
                    const own = await read(splat, ALIGN_POINTS);
                    const refs: Float32Array[] = [];
                    for (const s of others) refs.push((await read(s, ALIGN_POINTS)).positions);
                    const r = await runAnalysis<ComposeAlignResult>('compose-align', {
                        moving: own.positions,
                        reference: concat(refs),
                        options: { scale: false, coarse: 'never', focus: zone.centre, voxel: entry.result.voxel }
                    }, [], (p: number) => events.fire('progressUpdate', { text: `${title}: ${nameOf(splat)}`, progress: 100 * p }));
                    const m = new Mat4();
                    m.data.set(r.matrix);
                    aligned.set(splat, { ...entry, result: r, expected: new Mat4().mul2(m, splat.entity.getWorldTransform()) });
                    if (!isIdentity(r.matrix)) events.fire('edit.add', new MultiOp(matrixOps(events, splat, r.matrix, r.scale)));
                    summary = { usedZone: r.usedZone, after: r.zones[r.usedZone]?.after?.median ?? null, angleDeg: r.angleDeg, shift: r.shift };
                });
            } catch (error) {
                message = error instanceof AbortedError ? i18n.t('sm.compose.align.cancelled') :
                    i18n.t('sm.common.failed', { title, error: `${(error as Error).message ?? error}` });
            } finally {
                busy = false;
                changed();
            }
            return summary;
        };

        // align one scan at a world point (the analysis found the scans apart
        // there): like alignZone, at the zone nearest that point; a scan
        // without a phase-1 result gets one (one undo step)
        const alignAt = async (splat: Splat, point: number[]) => {
            const ref = reference();
            if (busy || suggest.busy || !splat || splat === ref || !included().includes(splat) || !Array.isArray(point) || point.length < 3) return null;
            const entry = aligned.get(splat);
            busy = true;
            message = '';
            changed();
            const title = i18n.t('sm.compose.zone.here');
            let summary: Record<string, unknown> = null;
            try {
                await withProgress(title, async () => {
                    const others = included().filter(s => s !== splat);
                    const own = await read(splat, ALIGN_POINTS);
                    const refs: Float32Array[] = [];
                    for (const s of others) refs.push((await read(s, ALIGN_POINTS)).positions);
                    const r = await runAnalysis<ComposeAlignResult>('compose-align', {
                        moving: own.positions,
                        reference: concat(refs),
                        options: { scale: false, coarse: 'never', focus: [point[0], point[1], point[2]], voxel: entry?.result.voxel }
                    }, [], (p: number) => events.fire('progressUpdate', { text: `${title}: ${nameOf(splat)}`, progress: 100 * p }));
                    const m = new Mat4();
                    m.data.set(r.matrix);
                    const startWorld = new Mat4().copy(splat.entity.getWorldTransform());
                    const expected = new Mat4().mul2(m, startWorld);
                    aligned.set(splat, entry ? { ...entry, result: r, expected } : { result: r, partner: ref, expected, original: r, startWorld, choice: 0 });
                    if (!isIdentity(r.matrix)) events.fire('edit.add', new MultiOp(matrixOps(events, splat, r.matrix, r.scale)));
                    summary = { usedZone: r.usedZone, after: r.zones[r.usedZone]?.after?.median ?? null, angleDeg: r.angleDeg, shift: r.shift };
                });
            } catch (error) {
                message = error instanceof AbortedError ? i18n.t('sm.compose.align.cancelled') :
                    i18n.t('sm.common.failed', { title, error: `${(error as Error).message ?? error}` });
            } finally {
                busy = false;
                changed();
            }
            return summary;
        };

        // the search found several places: switch to the next one and refine
        // it there (one undo step). In a repeating room the right place can
        // be another than the best-fitting one.
        const nextAlternative = async (splat: Splat) => {
            const entry = aligned.get(splat);
            const count = entry ? 1 + entry.original.alternatives.length : 0;
            if (busy || !entry || count < 2) return null;
            busy = true;
            message = '';
            changed();
            const title = i18n.t('sm.compose.align.other', { index: ((entry.choice + 1) % count) + 1, count });
            let summary: Record<string, unknown> = null;
            try {
                await withProgress(title, async () => {
                    const next = (entry.choice + 1) % count;
                    const target = new Mat4();
                    target.data.set(next === 0 ? entry.original.matrix : entry.original.alternatives[next - 1].matrix);
                    // from where the scan sits now to that place
                    const current = new Mat4().copy(splat.entity.getWorldTransform());
                    const jump = new Mat4().mul2(new Mat4().mul2(target, entry.startWorld), current.clone().invert());
                    const own = await read(splat, ALIGN_POINTS);
                    const refs: Float32Array[] = [];
                    for (const s of included().filter(o => o !== splat)) refs.push((await read(s, ALIGN_POINTS)).positions);
                    const r = await runAnalysis<ComposeAlignResult>('compose-align', {
                        moving: transformPoints(Array.from(jump.data), own.positions),
                        reference: concat(refs),
                        options: { scale: useScale, coarse: 'never', voxel: entry.result.voxel }
                    }, [], (p: number) => events.fire('progressUpdate', { text: `${title}: ${nameOf(splat)}`, progress: 100 * p }));
                    const refine = new Mat4();
                    refine.data.set(r.matrix);
                    const total = new Mat4().mul2(refine, jump);
                    const d = total.data;
                    const scale = Math.cbrt(Math.abs(d[0] * (d[5] * d[10] - d[9] * d[6]) - d[4] * (d[1] * d[10] - d[9] * d[2]) + d[8] * (d[1] * d[6] - d[5] * d[2]))) || 1;
                    aligned.set(splat, { ...entry, result: r, choice: next, expected: new Mat4().mul2(total, current) });
                    events.fire('edit.add', new MultiOp(matrixOps(events, splat, Array.from(total.data), scale)));
                    summary = { choice: next, count, coarse: r.coarse, after: r.zones[r.usedZone]?.after?.median ?? null };
                });
            } catch (error) {
                message = error instanceof AbortedError ? i18n.t('sm.compose.align.cancelled') :
                    i18n.t('sm.common.failed', { title, error: `${(error as Error).message ?? error}` });
            } finally {
                busy = false;
                changed();
            }
            return summary;
        };

        const focusZone = (splat: Splat, index: number) => {
            const zone = aligned.get(splat)?.result.zones[index];
            if (!zone) return;
            const radius = Math.max(0.5 * Math.hypot(zone.max[0] - zone.min[0], zone.max[1] - zone.min[1], zone.max[2] - zone.min[2]), 1e-3);
            scene.camera.focus({ focalPoint: new Vec3(zone.centre[0], zone.centre[1], zone.centre[2]), radius, speed: 1 });
            hoverZone = { splat, index };
            scene.forceRender = true;
        };

        // one scan at a time: all -> each included scan -> all. Display only
        // (the renderer asks 'compose.layerShown'): no layer's visibility
        // changes, so nothing is measured or analysed again, there is no undo
        // step, the selected layer stays, and closing the tool shows all
        // again. Scans hidden by the user are not in the cycle
        const switchable = () => included().filter(s => s.visible);
        const currentSolo = () => (solo && switchable().includes(solo) ? solo : null);

        function updateSwitch() {
            const shown = active ? currentSolo() : null;
            const scans = switchable();
            switchText.textContent = shown ? nameOf(shown) : i18n.t('sm.compose.view.solo-all');
            switchText.style.color = shown ? colorOf(shown) : '';
            switchBox.classList.toggle('active', !!shown);
            switchBox.classList.toggle('disabled', scans.length < 2);
            switchKeys.textContent = i18n.t('sm.compose.view.solo-keys');
            // the label over the view: while one scan is shown alone, and a
            // moment after switching back to all
            const flash = !shown && Date.now() < allLabelUntil;
            switchLabel.classList.toggle('shown', active && (!!shown || flash));
            switchLabel.innerHTML = '';
            if (shown) {
                const sw = el('span', 'compose-swatch');
                sw.style.backgroundColor = colorOf(shown);
                switchLabel.append(sw, el('span', '', i18n.t('sm.compose.view.solo-only', {
                    name: nameOf(shown),
                    index: scans.indexOf(shown) + 1,
                    count: scans.length
                })));
            } else {
                switchLabel.append(el('span', '', i18n.t('sm.compose.view.solo-all-label', { count: scans.length })));
            }
        }

        const setSolo = (splat: Splat | null) => {
            const next = splat && switchable().includes(splat) ? splat : null;
            const was = currentSolo();
            solo = next;
            if (!next && was) {
                allLabelUntil = Date.now() + ALL_LABEL_MS;
                if (allLabelTimer) clearTimeout(allLabelTimer);
                allLabelTimer = setTimeout(() => {
                    allLabelTimer = null;
                    updateSwitch();
                }, ALL_LABEL_MS + 20);
            }
            // no rebuild of the panel: the focused control keeps the focus
            updateSwitch();
            scene.forceRender = true;
        };

        // dir 1: all -> scan 1 -> scan 2 -> ... -> all; -1 the other way
        const cycleSolo = (dir: number) => {
            const scans = switchable();
            if (scans.length < 2) {
                setSolo(null);
                return;
            }
            const n = scans.length + 1;
            const cur = currentSolo();
            const at = cur ? scans.indexOf(cur) + 1 : 0;
            const to = (at + (dir < 0 ? -1 : 1) + n) % n;
            setSolo(to === 0 ? null : scans[to - 1]);
        };

        events.function('compose.layerShown', (splat: Splat) => {
            if (!active || !solo) return true;
            const shown = currentSolo();
            if (!shown || !included().includes(splat)) return true;
            return splat === shown;
        });

        window.addEventListener('keydown', (e: KeyboardEvent) => {
            if (!active) return;
            const dir = SWITCH_KEYS[e.key];
            if (!dir || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || ownsKey(e.target)) return;
            if (switchable().length < 2) return;
            // ahead of the panel's own key handling and the editor's
            // shortcuts; held keys do not run through the scans
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) cycleSolo(dir);
        }, true);

        // range (optional): octaves above a scan's median footprint where the
        // tint starts and where it is full
        const setSharpness = (value: boolean, range?: { from?: number, to?: number }) => {
            sharpness.enabled = !!value;
            if (range && Number.isFinite(range.from)) sharpness.range.from = Math.max(0, Math.min(7.9, range.from));
            if (range && Number.isFinite(range.to)) sharpness.range.to = Math.max(sharpness.range.from + 0.1, Math.min(8, range.to));
            // the map and the sharpness view colour the same splats
            if (sharpness.enabled && suggest.map) events.fire('compose.setMap', false);
            if (!sharpness.enabled) sharpness.release();
            scene.forceRender = true;
            changed();
        };

        // ------------------------------------------------------------ api

        events.function('compose.view', () => ({
            step,
            busy,
            message,
            scans: included().map(s => s.name),
            reference: reference()?.name ?? null,
            suggested: suggested()?.name ?? null,
            overlap: overlapFor(included()),
            aligned: [...aligned.entries()].map(([s, e]) => ({
                name: s.name,
                partner: e.partner?.name ?? null,
                coarse: e.result.coarse,
                mode: e.result.mode,
                choice: e.choice,
                options: 1 + e.original.alternatives.length,
                usedZone: e.result.usedZone,
                stale: stale(s),
                zones: e.result.zones.map(z => ({ share: z.share, centre: z.centre, before: z.before?.median ?? null, after: z.after?.median ?? null, local: z.after ? [z.after.localMin, z.after.localMax] : null, surface: z.after?.surface ?? null, blocks: z.after?.blocks ?? 0 }))
            })),
            // the quick switch (null: all scans shown) and the sharpness view
            solo: currentSolo()?.name ?? null,
            soloLabel: currentSolo() ? nameOf(currentSolo()) : null,
            sharpness: {
                on: sharpness.enabled,
                computing: sharpness.computing(),
                range: { ...sharpness.range },
                scans: included().map(s => ({ name: s.name, ...(sharpness.stats(s) ?? { median: null, blurry: null }) }))
            },
            // phase 2 (null / empty before an analysis)
            analysis: suggest.view(),
            suggestions: suggest.suggestionsView()
        }));
        events.function('compose.align', alignAll);
        events.function('compose.alignZone', alignZone);
        events.function('compose.alignAt', alignAt);
        events.function('compose.nextAlternative', nextAlternative);
        events.function('compose.measure', measureOverlap);
        events.on('compose.focusZone', focusZone);
        // detail is judged in true colours: the first visit of step 4 turns
        // 'Scans einfärben' off once
        let suggestVisited = false;
        events.on('compose.setStep', (value: Step) => {
            if (!READY_STEPS.has(value)) return;
            step = value;
            if (step === 'suggest') {
                if (!suggestVisited) {
                    suggestVisited = true;
                    if (colorsInput.value) colorsInput.value = false;
                }
                suggest.enterSuggest();
            }
            suggest.stepChanged();
            changed();
            if (step === 'load') scheduleOverlap();
        });
        events.on('compose.include', (splat: Splat, value: boolean) => {
            if (value) excluded.delete(splat);
            else excluded.add(splat);
            if (solo) solo = null;
            changed();
            scheduleOverlap();
        });
        events.on('compose.setReference', (splat: Splat) => {
            manualReference = splat;
            aligned.clear();
            changed();
        });
        // options for scripts and tests: { scale?: boolean, position?: 'auto' | 'never' | 'always' }
        events.on('compose.setOptions', (options: { scale?: boolean, position?: Position }) => {
            if (typeof options?.scale === 'boolean') useScale = options.scale;
            if (options?.position === 'auto' || options?.position === 'never' || options?.position === 'always') position = options.position;
            changed();
        });
        events.on('compose.nextSolo', () => cycleSolo(1));
        events.on('compose.prevSolo', () => cycleSolo(-1));
        // a scan (layer, or its position among the switchable scans, 0-based)
        // or null for all
        events.on('compose.setSolo', (value: Splat | number | null) => {
            setSolo(typeof value === 'number' ? switchable()[value] ?? null : value ?? null);
        });
        events.on('compose.setSharpness', (value: boolean, range?: { from?: number, to?: number }) => setSharpness(value, range));
        events.on('compose.anchors', (splat: Splat) => {
            const entry = aligned.get(splat);
            if (entry?.partner) events.fire('align.setReference', entry.partner);
            events.fire('selection', splat);
            events.fire('tool.align');
        });

        // the measurement belongs to where the scans are
        const invalidate = () => {
            overlap = null;
            if (active) {
                changed();
                if (step === 'load') scheduleOverlap();
            }
        };
        ['splat.moved', 'splat.visibility', 'splat.positionsChanged', 'splat.replaced'].forEach(name => events.on(name, () => {
            if (!busy) invalidate();
        }));
        events.on('scene.elementAdded', invalidate);
        events.on('scene.elementRemoved', (element: any) => {
            suggest.drop(element);
            excluded.delete(element);
            aligned.delete(element);
            sharpness.drop(element);
            if (solo === element) solo = null;
            if (manualReference === element) manualReference = null;
            if (keptReference?.scans.includes(element)) keptReference = null;
            invalidate();
        });
        events.on('splat.name', () => changed());
        events.on('sceneScale.changed', () => changed());
        i18n.onChange(() => rebuild());

        // ------------------------------------------------------------ lifecycle

        this.activate = () => {
            active = true;
            panel.hidden = false;
            suggest.activate();
            changed();
            if (step === 'load') scheduleOverlap();
        };

        this.deactivate = () => {
            active = false;
            panel.hidden = true;
            hoverZone = null;
            // previews and hover end; the reads and display buffers are dropped
            suggest.deactivate();
            // all scans again (the switch was display only); the sharpness
            // buffers go, the setting stays for the next visit
            solo = null;
            allLabelUntil = 0;
            sharpness.release();
            updateSwitch();
            updateOverlay();
            scene.forceRender = true;
        };
    }
}

export { ComposeTool };
