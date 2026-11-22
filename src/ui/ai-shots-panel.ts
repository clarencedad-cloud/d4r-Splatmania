import { BooleanInput, Button, Container, Label, SliderInput } from '@playcanvas/pcui';

import type { AiShotsStatus, ApplyOptions, GenerateOptions } from '../ai-shots/ai-shots';
import { aiAvailable, keyStore } from '../ai-shots/claude-client';
import { DEFAULT_SETTINGS, type DraftSettings, type DraftState } from '../ai-shots/shot-draft';
import { framingDistance, groundLevels, objectSize } from '../ai-shots/shot-generator';
import { SHOT_LIMITS, SHOT_STYLES, SHOT_TEMPLATES, type ShotObject, type ShotProposal, type ShotStyle, type ShotTemplate } from '../ai-shots/shot-types';
import { Events } from '../events';
import { formatLength, formatNumber, formatSpeed, type SceneScale, type SceneScaleMode } from '../scene-scale';
import { helpButton } from './help';
import { i18n } from './localization';
import aiShotsSvg from './svg/ai-shots.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

type Card = {
    proposal: ShotProposal;
    root: Container;
    check: BooleanInput;
    applyButton: Button;
    applied: boolean;
    markApplied: () => void;
    setPreviewed: (value: boolean) => void;
};

const MAX_ANCHORS = 3;
const [MIN_SCALE, MAX_SCALE] = [0.5, 3];

// i18next echoes unknown keys; show a generic text instead
const translate = (key: string, fallbackKey: string) => {
    const text = i18n.t(key);
    return text === key ? i18n.t(fallbackKey) : text;
};

// warnings aiShots.apply may report besides the new camera ids, as i18n keys:
// { warnings: [...] }, { warning: '...' } or { compressed: true }
const applyWarnings = (result: unknown): string[] => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const r = result as { warnings?: unknown; warning?: unknown; compressed?: unknown };
    const keys: string[] = [];
    if (Array.isArray(r.warnings)) keys.push(...r.warnings.filter((w): w is string => typeof w === 'string'));
    if (typeof r.warning === 'string') keys.push(r.warning);
    if (r.compressed === true) keys.push('sm.aishots.warn.compressed');
    return [...new Set(keys)];
};

const errorCode = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code.startsWith('sm.aishots.') ? code : 'sm.aishots.err.api';
};

const UNKNOWN_SCALE: SceneScale = { mode: 'auto', metersPerUnit: 1, known: false, source: 'unknown' };

/**
 * Shot suggestions (src/ai-shots): proposes camera moves around the marked
 * object, optionally planned and rated by Claude, and turns the chosen ones
 * into shot cameras. While open, the viewport shows the move the current
 * settings give (shot-draft.ts / shot-preview.ts), shaped by hand and tidied
 * up on request; the walk-through ("Begehung") is built from waypoints on the
 * ground.
 */
class AiShotsPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'ai-shots-panel',
            class: ['panel', 'options-panel'],
            hidden: true
        };

        super(args);

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'keydown'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const scale = (): SceneScale => (events.functions.has('sceneScale.get') ? events.invoke('sceneScale.get') : UNKNOWN_SCALE);
        const draftState = (): DraftState | null => (events.functions.has('aiShots.draft') ? events.invoke('aiShots.draft') : null);
        const fov = () => events.invoke('camera.fov') ?? 60;

        const header = new Container({ class: 'panel-header' });
        const icon = new Label({ class: 'panel-header-icon' });
        icon.dom.appendChild(createSvg(aiShotsSvg));
        const label = new Label({ class: 'panel-header-label' });
        i18n.bindText(label, 'sm.aishots.title');
        header.append(icon);
        header.append(label);
        header.dom.appendChild(helpButton(events, 'aiShots'));
        this.append(header);

        const section = (key: string) => {
            const container = new Container({ class: ['panel-header', 'options-panel-section'] });
            const sectionLabel = new Label({ class: 'panel-header-label' });
            i18n.bindText(sectionLabel, key);
            container.append(sectionLabel);
            this.append(container);
            return container;
        };

        const row = (labelKey: string, tipKey?: string) => {
            const container = new Container({ class: 'settings-panel-row' });
            const rowLabel = new Label({ class: 'settings-panel-row-label' });
            i18n.bindText(rowLabel, labelKey);
            if (tipKey) tooltips.register(rowLabel, () => i18n.t(tipKey), 'left');
            container.append(rowLabel);
            this.append(container);
            return container;
        };

        // a line of explanation under a control
        const info = (cls: string[] = []) => {
            const el = new Label({ class: ['ai-shots-line', ...cls] });
            this.append(el);
            return el;
        };

        const toggleRow = (labelKey: string, tipKey: string, value: boolean) => {
            const container = row(labelKey, tipKey);
            const toggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value });
            container.append(toggle);
            container.class.add('options-panel-row-clickable');
            container.dom.addEventListener('click', (event: MouseEvent) => {
                if (toggle.enabled && !toggle.dom.contains(event.target as Node)) {
                    toggle.value = !toggle.value;
                }
            });
            return { row: container, toggle };
        };

        const button = (key: string, cls: string | string[], parent: Container, tipKey?: string) => {
            const b = new Button({ class: cls });
            i18n.bindText(b, key);
            if (tipKey) tooltips.register(b, () => i18n.t(tipKey), 'left');
            parent.append(b);
            return b;
        };

        const slider = (labelKey: string, tipKey: string, min: number, max: number, precision: number, step: number, value: number) => {
            const container = row(labelKey, tipKey);
            const input = new SliderInput({ class: 'settings-panel-row-slider', min, max, precision, step, value });
            container.append(input);
            return { row: container, input };
        };

        // native select (its list is never clipped by the panel)
        const select = (labelKey: string, tipKey: string, options: () => [string, string][]) => {
            const container = row(labelKey, tipKey);
            const el = document.createElement('select');
            el.classList.add('ai-shots-select');
            const build = () => {
                const value = el.value;
                el.innerHTML = '';
                for (const [v, text] of options()) {
                    const option = document.createElement('option');
                    option.value = v;
                    option.textContent = text;
                    el.appendChild(option);
                }
                el.value = value || options()[0][0];
                if (!el.value) el.value = options()[0][0];
            };
            build();
            i18n.onChange(build);
            el.addEventListener('keydown', e => e.stopPropagation());
            container.dom.appendChild(el);
            return { row: container, el, build };
        };

        // run state of the suggestions, the status line and applying
        let busy = false;
        let cancelled = false;
        let aiError: string | null = null;
        let statusKey: string | null = null;
        let statusKind: 'info' | 'error' | 'warn' = 'info';
        let applying = false;

        // the settings the draft (viewport preview) is computed from
        const settings: DraftSettings = { ...DEFAULT_SETTINGS };
        const pushSettings = (next: Partial<DraftSettings>) => {
            Object.assign(settings, next);
            events.fire('aiShots.setDraftSettings', next);
        };

        // --- object ------------------------------------------------------------

        section('sm.aishots.section-object');

        const objectRow = new Container({ class: 'ai-shots-row' });
        const objectInfo = new Label({ class: 'ai-shots-info' });
        objectRow.append(objectInfo);
        const captureButton = button('sm.aishots.capture', 'ai-shots-small', objectRow, 'sm.aishots.capture-tip');
        this.append(objectRow);

        // taken with the button; until then the preview uses the current
        // box / sphere, selection or scene (shown in the info)
        let object: ShotObject | null = null;
        const shownObject = () => object ?? draftState()?.object ?? null;
        const renderObject = () => {
            const o = shownObject();
            if (!o) {
                objectInfo.text = i18n.t('sm.aishots.object-none');
                return;
            }
            const e = o.halfExtents;
            const sc = scale();
            // one unit for all three sides
            const sides = [e.x, e.y, e.z].map(v => 2 * v * (sc.known ? sc.metersPerUnit : 1));
            const largest = Math.max(...sides);
            const cm = sc.known && largest < 1;
            const unit = sc.known ? (cm ? 'cm' : 'm') : i18n.t('sm.scale.unit-short');
            const digits = cm ? 0 : largest >= 100 ? 0 : largest >= 10 ? 1 : 2;
            const size = sides.map(v => formatNumber(cm ? v * 100 : v, digits)).join(' × ');
            objectInfo.text = `${i18n.t(`sm.aishots.source.${o.source}`)}${object ? '' : ` (${i18n.t('sm.aishots.object-auto')})`} · ${size} ${unit}`;
        };
        i18n.onChange(renderObject, objectInfo);

        captureButton.on('click', () => {
            object = (events.invoke('aiShots.captureObject') as ShotObject | null) ?? null;
            renderObject();
            events.fire('aiShots.objectCaptured', object);
        });
        events.on('scene.clear', () => {
            object = null;
            renderObject();
        });

        // scale of the scene: metres or scene units

        const scaleSelect = select('sm.scale.title', 'sm.scale.tip', () => {
            const detected = scale();
            const auto = detected.mode === 'auto' && detected.source === 'lcc' ? 'sm.scale.auto-lcc' : 'sm.scale.auto-unknown';
            return [
                ['auto', i18n.t(detected.mode === 'auto' ? auto : 'sm.scale.auto')],
                ['metric', i18n.t('sm.scale.metric')],
                ['custom', i18n.t('sm.scale.custom')]
            ];
        });
        const customRow = new Container({ class: ['settings-panel-row', 'ai-shots-scale-custom'] });
        const customLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(customLabel, 'sm.scale.unit-is');
        const customInput = document.createElement('input');
        customInput.type = 'number';
        customInput.min = '0.0001';
        customInput.step = 'any';
        customInput.className = 'ai-shots-number';
        const customUnit = new Label({ class: 'ai-shots-unit', text: 'm' });
        const heightLabel = new Label({ class: ['settings-panel-row-label', 'ai-shots-or'] });
        i18n.bindText(heightLabel, 'sm.scale.object-height');
        const heightInput = document.createElement('input');
        heightInput.type = 'number';
        heightInput.min = '0.001';
        heightInput.step = 'any';
        heightInput.className = 'ai-shots-number';
        const heightUnit = new Label({ class: 'ai-shots-unit', text: 'm' });
        customRow.append(customLabel);
        customRow.dom.appendChild(customInput);
        customRow.append(customUnit);
        customRow.append(heightLabel);
        customRow.dom.appendChild(heightInput);
        customRow.append(heightUnit);
        tooltips.register(heightLabel, () => i18n.t('sm.scale.object-height-tip'), 'left');
        tooltips.register(customLabel, () => i18n.t('sm.scale.unit-is-tip'), 'left');
        this.append(customRow);
        const scaleHint = info(['ai-shots-warn-text']);

        const formatPlain = (value: number) => {
            if (!Number.isFinite(value)) return '';
            const digits = value >= 100 ? 1 : value >= 1 ? 3 : 5;
            return String(Math.round(value * 10 ** digits) / 10 ** digits);
        };

        const renderScale = () => {
            const sc = scale();
            scaleSelect.build();
            scaleSelect.el.value = sc.mode;
            customRow.hidden = sc.mode !== 'custom';
            const o = shownObject();
            if (document.activeElement !== customInput) customInput.value = formatPlain(sc.metersPerUnit);
            if (document.activeElement !== heightInput) heightInput.value = o ? formatPlain(2 * o.halfExtents.y * sc.metersPerUnit) : '';
            heightInput.disabled = !o;
            scaleHint.hidden = sc.known;
            scaleHint.text = i18n.t('sm.scale.unknown-hint');
        };
        scaleSelect.el.addEventListener('change', () => {
            const mode = scaleSelect.el.value as SceneScaleMode;
            if (mode === 'custom') {
                events.fire('sceneScale.set', 'custom', scale().metersPerUnit || 1);
            } else {
                events.fire('sceneScale.set', mode);
            }
        });
        customInput.addEventListener('change', () => {
            const value = Number(customInput.value);
            if (value > 0) events.fire('sceneScale.set', 'custom', value);
        });
        heightInput.addEventListener('change', () => {
            const value = Number(heightInput.value);
            const o = shownObject();
            if (value > 0 && o && o.halfExtents.y > 0) events.fire('sceneScale.set', 'custom', value / (2 * o.halfExtents.y));
        });
        [customInput, heightInput].forEach(el => el.addEventListener('keydown', e => e.stopPropagation()));
        events.on('sceneScale.changed', () => {
            renderScale();
            renderObject();
            renderAll();
        });
        i18n.onChange(renderScale);

        // favourite angles

        const anchorLabel = new Label({ class: 'ai-shots-info' });
        const anchorRow = new Container({ class: 'ai-shots-row' });
        anchorRow.append(anchorLabel);
        const anchorAdd = button('sm.aishots.anchor-add', 'ai-shots-small', anchorRow, 'sm.aishots.anchor-add-tip');
        const anchorClear = button('sm.aishots.anchor-clear', 'ai-shots-small', anchorRow, 'sm.aishots.anchor-clear-tip');
        this.append(anchorRow);

        let anchorCount = 0;
        const renderAnchors = () => {
            anchorLabel.text = i18n.t('sm.aishots.anchors', { n: anchorCount, max: MAX_ANCHORS });
        };
        i18n.onChange(renderAnchors, anchorLabel);

        const setAnchorCount = (count: number) => {
            anchorCount = count;
            anchorClear.enabled = count > 0;
            renderAnchors();
        };
        const syncAnchors = () => {
            const anchors = events.functions.has('aiShots.anchors') ? events.invoke('aiShots.anchors') as unknown[] : [];
            setAnchorCount(anchors?.length ?? 0);
        };
        anchorAdd.on('click', () => events.fire('aiShots.addAnchor'));
        anchorClear.on('click', () => events.fire('aiShots.clearAnchors'));
        events.on('aiShots.anchorsChanged', (count: number) => setAnchorCount(count));

        // --- the move ----------------------------------------------------------

        section('sm.aishots.section-move');

        const moveSelect = select('sm.aishots.move', 'sm.aishots.move-tip', () => [
            ['all', i18n.t('sm.aishots.move.all')],
            ...SHOT_TEMPLATES.map(t => [t, i18n.t(`sm.aishots.template.${t}`)] as [string, string]),
            ['walk', i18n.t('sm.aishots.template.walk')]
        ]);
        const moveInfo = info(['ai-shots-hint']);

        const styleSelect = select('sm.aishots.style', 'sm.aishots.style-tip', () => SHOT_STYLES.map(s => [s, i18n.t(`sm.aishots.style.${s}`)] as [string, string]));
        const styleInfo = info(['ai-shots-hint']);

        // duration, defaults to the timeline length until the user picks one
        const [minDuration, maxDuration] = SHOT_LIMITS.durationSec;
        const duration = slider('sm.aishots.duration', 'sm.aishots.duration-tip', minDuration, maxDuration, 0, 1, 10);
        const durationInfo = info(['ai-shots-hint']);

        let durationTouched = false;
        let syncingDuration = false;
        const syncDuration = () => {
            if (durationTouched) return;
            const fps = events.invoke('timeline.frameRate') ?? 30;
            const frames = events.invoke('timeline.frames') ?? 0;
            syncingDuration = true;
            // a move of T seconds takes round(T*fps)+1 frames: round down so
            // the default move fits into the current timeline
            duration.input.value = Math.min(maxDuration, Math.max(minDuration, Math.floor((frames - 1) / fps + 1e-6)));
            syncingDuration = false;
            pushSettings({ durationSec: duration.input.value });
        };
        duration.input.on('change', (value: number) => {
            if (!syncingDuration) durationTouched = true;
            pushSettings({ durationSec: value });
            renderAll();
        });
        events.on('timeline.frames', syncDuration);
        events.on('timeline.frameRate', syncDuration);

        // distance: metres (scene units without a known scale) and the share
        // of the object size. Inside it is a factor on the automatic framing
        // (0.5..3), on a log scale for the slider
        const distanceRow = row('sm.aishots.distance', 'sm.aishots.distance-tip');
        distanceRow.class.add('ai-shots-distance-row');
        const distanceBox = document.createElement('div');
        distanceBox.className = 'ai-shots-distance';
        const distanceRange = document.createElement('input');
        distanceRange.type = 'range';
        distanceRange.min = '0';
        distanceRange.max = '1000';
        distanceRange.step = '1';
        const distanceNumber = document.createElement('input');
        distanceNumber.type = 'number';
        distanceNumber.step = 'any';
        distanceNumber.min = '0';
        distanceNumber.className = 'ai-shots-number';
        const distanceUnit = document.createElement('span');
        distanceUnit.className = 'ai-shots-unit';
        distanceBox.append(distanceRange, distanceNumber, distanceUnit);
        distanceRow.dom.appendChild(distanceBox);
        const distanceInfo = info(['ai-shots-hint']);
        [distanceRange, distanceNumber].forEach(el => el.addEventListener('keydown', e => e.stopPropagation()));

        const toSlider = (s: number) => Math.round(1000 * Math.log(s / MIN_SCALE) / Math.log(MAX_SCALE / MIN_SCALE));
        const fromSlider = (t: number) => MIN_SCALE * (MAX_SCALE / MIN_SCALE) ** (t / 1000);
        const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

        // distance (scene units) at scale 1 for the move the preview shows
        const referenceDistance = () => {
            const o = shownObject();
            if (!o) return null;
            const template = (moveSelect.el.value === 'all' || moveSelect.el.value === 'walk') ?
                draftState()?.draft?.params.template :
                moveSelect.el.value as ShotTemplate;
            return framingDistance(o, fov(), template);
        };

        const setScale = (value: number) => {
            const s = clampScale(value);
            distanceRange.value = String(toSlider(s));
            pushSettings({ distanceScale: s });
            renderDistance();
        };
        distanceRange.addEventListener('input', () => setScale(fromSlider(Number(distanceRange.value))));
        distanceNumber.addEventListener('change', () => {
            const ref = referenceDistance();
            const value = Number(distanceNumber.value);
            if (!ref || !(value > 0)) return;
            const units = scale().known ? value / scale().metersPerUnit : value;
            setScale(units / ref);
        });
        // the ring handle in the viewport (shot-preview.ts)
        events.on('aiShots.requestDistanceScale', (value: number) => {
            if (value > 0) setScale(value);
        });

        function renderDistance() {
            const ref = referenceDistance();
            const o = shownObject();
            const sc = scale();
            distanceUnit.textContent = sc.known ? 'm' : i18n.t('sm.scale.unit-short');
            if (!ref || !o) {
                distanceNumber.value = '';
                distanceInfo.text = i18n.t('sm.aishots.distance-none');
                return;
            }
            const units = ref * settings.distanceScale;
            const shown = sc.known ? units * sc.metersPerUnit : units;
            if (document.activeElement !== distanceNumber) {
                const digits = shown >= 100 ? 0 : shown >= 10 ? 1 : 2;
                distanceNumber.value = String(Math.round(shown * 10 ** digits) / 10 ** digits);
            }
            const size = objectSize(o);
            let text = i18n.t('sm.aishots.distance-info', {
                distance: formatLength(units, sc),
                ratio: formatNumber(units / size, 1),
                size: formatLength(size, sc)
            });
            // the generator may need another distance (favourite angles,
            // geometry in the way, aerial style): say so
            const draft = draftState()?.draft;
            if (draft && !draft.kind && (draftState()?.source === 'settings')) {
                const actual = draft.params.distanceFactor * o.radius;
                if (Math.abs(actual - units) > 0.05 * units) {
                    text += ` ${i18n.t('sm.aishots.distance-actual', { distance: formatLength(actual, sc) })}`;
                }
            }
            distanceInfo.text = text;
        }

        // --- walk -------------------------------------------------------------

        const waypointRow = new Container({ class: 'ai-shots-row' });
        const waypointInfo = new Label({ class: 'ai-shots-info' });
        waypointRow.append(waypointInfo);
        const pickButton = button('sm.aishots.walk.pick', 'ai-shots-small', waypointRow, 'sm.aishots.walk.pick-tip');
        const autoButton = button('sm.aishots.walk.auto', 'ai-shots-small', waypointRow, 'sm.aishots.walk.auto-tip');
        const clearButton = button('sm.aishots.walk.clear', 'ai-shots-small', waypointRow, 'sm.aishots.walk.clear-tip');
        this.append(waypointRow);
        const waypointHint = info(['ai-shots-hint']);
        const autoRoute = toggleRow('sm.aishots.walk.route', 'sm.aishots.walk.route-tip', DEFAULT_SETTINGS.autoRoute);
        const eyeHeight = slider('sm.aishots.walk.eye', 'sm.aishots.walk.eye-tip', 0.5, 2.5, 2, 0.05, DEFAULT_SETTINGS.eyeHeight);
        const speed = slider('sm.aishots.walk.speed', 'sm.aishots.walk.speed-tip', 0.3, 3, 2, 0.05, DEFAULT_SETTINGS.speed);
        const lookAhead = slider('sm.aishots.walk.look', 'sm.aishots.walk.look-tip', 0.5, 10, 1, 0.1, DEFAULT_SETTINGS.lookAhead);
        const bob = slider('sm.aishots.walk.bob', 'sm.aishots.walk.bob-tip', 0, 10, 1, 0.1, DEFAULT_SETTINGS.bobMeters * 100);
        const stepRate = slider('sm.aishots.walk.step', 'sm.aishots.walk.step-tip', 0.5, 3.5, 2, 0.05, DEFAULT_SETTINGS.stepRate);
        const shake = slider('sm.aishots.walk.shake', 'sm.aishots.walk.shake-tip', 0, 3, 2, 0.05, DEFAULT_SETTINGS.shake);
        const shakeRate = slider('sm.aishots.walk.shake-rate', 'sm.aishots.walk.shake-rate-tip', 0.1, 4, 2, 0.05, DEFAULT_SETTINGS.shakeRate);
        const walkInfo = info(['ai-shots-hint']);
        const walkUnits = info(['ai-shots-warn-text']);

        autoRoute.toggle.on('change', (value: boolean) => pushSettings({ autoRoute: value }));
        eyeHeight.input.on('change', (value: number) => pushSettings({ eyeHeight: value }));
        speed.input.on('change', (value: number) => pushSettings({ speed: value }));
        lookAhead.input.on('change', (value: number) => pushSettings({ lookAhead: value }));
        bob.input.on('change', (value: number) => pushSettings({ bobMeters: value / 100 }));
        stepRate.input.on('change', (value: number) => pushSettings({ stepRate: value }));
        shake.input.on('change', (value: number) => pushSettings({ shake: value }));
        shakeRate.input.on('change', (value: number) => pushSettings({ shakeRate: value }));

        let picking = false;
        pickButton.on('click', () => events.fire('aiShots.setPicking', !picking));
        events.on('aiShots.picking', (value: boolean) => {
            picking = value;
            pickButton.class[value ? 'add' : 'remove']('active');
            renderWalk();
        });
        autoButton.on('click', async () => {
            autoButton.enabled = false;
            try {
                const n = await events.invoke('aiShots.autoWaypoints');
                if (!n) setStatus('sm.aishots.walk.auto-none', 'warn');
            } finally {
                autoButton.enabled = true;
            }
        });
        clearButton.on('click', () => events.fire('aiShots.clearWaypoints'));

        const walkRows = [waypointRow, waypointHint, autoRoute.row, eyeHeight.row, speed.row, lookAhead.row, bob.row, stepRate.row, shake.row, shakeRate.row, walkInfo, walkUnits];
        const shotRows = [styleSelect.row, styleInfo, duration.row, durationInfo, distanceRow, distanceInfo];

        function renderWalk() {
            const state = draftState();
            const points = state?.waypoints.length ?? 0;
            waypointInfo.text = i18n.t('sm.aishots.walk.points', { n: points });
            clearButton.enabled = points > 0;
            waypointHint.text = i18n.t(picking ? 'sm.aishots.walk.picking' : points < 2 ? 'sm.aishots.walk.need-points' : 'sm.aishots.walk.edit-hint');
            const sc = scale();
            const draft = state?.draft;
            if (draft?.kind === 'walk' && draft.walkLength) {
                walkInfo.text = i18n.t('sm.aishots.walk.info', {
                    length: formatLength(draft.walkLength, sc),
                    seconds: formatNumber(draft.params.durationSec, 1),
                    speed: formatSpeed(settings.speed / (sc.metersPerUnit || 1), sc),
                    keys: draft.keys.length
                });
            } else {
                walkInfo.text = '';
            }
            const walkMode = moveSelect.el.value === 'walk';
            walkInfo.hidden = !walkMode || !walkInfo.text;
            walkUnits.hidden = !walkMode || sc.known;
            walkUnits.text = i18n.t('sm.aishots.walk.unknown-scale');
        }

        // --- preview (the draft) ----------------------------------------------

        section('sm.aishots.section-preview');

        const previewToggle = toggleRow('sm.aishots.preview.show', 'sm.aishots.preview.show-tip', true);
        previewToggle.toggle.on('change', (value: boolean) => events.fire('aiShots.setPreviewEnabled', value));
        const draftInfo = info();
        const draftWarnings = info(['ai-shots-warn-text']);
        const draftRating = info(['ai-shots-ai-score']);

        const draftActions = new Container({ class: 'ai-shots-actions' });
        const playButton = button('sm.aishots.preview.play', 'ai-shots-small', draftActions, 'sm.aishots.preview.play-tip');
        const cleanupButton = button('sm.aishots.preview.cleanup', 'ai-shots-small', draftActions, 'sm.aishots.preview.cleanup-tip');
        const resetButton = button('sm.aishots.preview.reset', 'ai-shots-small', draftActions, 'sm.aishots.preview.reset-tip');
        this.append(draftActions);
        const draftActions2 = new Container({ class: 'ai-shots-actions' });
        const rateButton = button('sm.aishots.preview.rate', 'ai-shots-small', draftActions2, 'sm.aishots.preview.rate-tip');
        const applyDraftButton = button('sm.aishots.preview.apply', ['ai-shots-small', 'ai-shots-primary'], draftActions2, 'sm.aishots.preview.apply-tip');
        this.append(draftActions2);

        let playing = false;
        playButton.on('click', () => events.fire(playing ? 'aiShots.stopPlayback' : 'aiShots.playDraft'));
        events.on('aiShots.playing', (value: boolean) => {
            playing = value;
            playButton.text = i18n.t(value ? 'sm.aishots.preview.stop' : 'sm.aishots.preview.play');
        });
        cleanupButton.on('click', async () => {
            await events.invoke('aiShots.cleanupDraft');
        });
        resetButton.on('click', () => events.fire('aiShots.resetDraft'));
        rateButton.on('click', async () => {
            await events.invoke('aiShots.rateDraft', aiWish());
        });

        const titleOf = (proposal: ShotProposal) => {
            if (proposal.params.label) return proposal.params.label;
            return proposal.title.startsWith('sm.') ? translate(proposal.title, 'sm.aishots.title') : proposal.title;
        };

        const renderDraft = () => {
            const state = draftState();
            const draft = state?.draft ?? null;
            const sc = scale();
            const busy = state?.busy ?? null;
            if (!draft) {
                draftInfo.text = i18n.t(moveSelect.el.value === 'walk' ? 'sm.aishots.preview.none-walk' : 'sm.aishots.preview.none');
            } else {
                const parts = [titleOf(draft)];
                if (draft.params.sweepDeg && !draft.kind && (draft.params.template === 'orbit' || draft.params.template === 'reveal' || draft.params.template === 'slide')) parts.push(`${Math.round(draft.params.sweepDeg)}°`);
                if (!draft.kind && state.object) parts.push(formatLength(draft.params.distanceFactor * state.object.radius, sc));
                parts.push(`${formatNumber(draft.params.durationSec, 1)} s`);
                parts.push(i18n.t('sm.aishots.preview.keys', { n: draft.keys.length }));
                // walks have no coverage rating (their score is only a placeholder)
                if (!draft.kind) parts.push(i18n.t('sm.aishots.preview.coverage', { percent: Math.round(Math.max(0, Math.min(1, draft.score)) * 100) }));
                const sourceKey = state.source === 'edited' ? 'sm.aishots.preview.state-edited' :
                    state.source === 'cleaned' ? 'sm.aishots.preview.state-cleaned' :
                        state.source === 'card' ? 'sm.aishots.preview.state-card' : 'sm.aishots.preview.state-live';
                draftInfo.text = `${i18n.t(sourceKey)} · ${parts.join(' · ')}`;
            }
            const warnings = draft?.warnings ?? [];
            draftWarnings.text = warnings.map(w => translate(w, 'sm.aishots.warn.generic')).join(' · ');
            draftWarnings.hidden = warnings.length === 0;
            if (draft?.aiScore !== undefined) {
                draftRating.text = i18n.t('sm.aishots.ai-score', { score: Math.round(draft.aiScore * 10) / 10 }) + (draft.aiComment ? ` – ${draft.aiComment}` : '');
                draftRating.hidden = false;
            } else {
                draftRating.hidden = true;
            }
            const has = !!draft && draft.keys.length >= 2;
            playButton.enabled = has;
            cleanupButton.enabled = has && !busy;
            resetButton.enabled = !!state && state.source !== 'settings';
            rateButton.enabled = has && !busy && aiAvailable();
            rateButton.hidden = !aiAvailable();
            applyDraftButton.enabled = has && !applying;
            cleanupButton.text = i18n.t(busy === 'cleanup' ? 'sm.aishots.preview.cleaning' : 'sm.aishots.preview.cleanup');
            rateButton.text = i18n.t(busy === 'rating' ? 'sm.aishots.preview.rating' : 'sm.aishots.preview.rate');
            playButton.text = i18n.t(playing ? 'sm.aishots.preview.stop' : 'sm.aishots.preview.play');
        };

        // the move and height lines: what the picked move does, and where the
        // camera actually is
        const renderMove = () => {
            const value = moveSelect.el.value;
            moveInfo.text = i18n.t(`sm.aishots.move-info.${value}`);
            const state = draftState();
            const draft = state?.draft;
            const o = state?.object;
            const sc = scale();
            if (draft && o && !draft.kind && draft.keys.length) {
                const { ground } = groundLevels(o);
                const heights = draft.keys.map(k => k.position.y - ground);
                const lo = Math.min(...heights);
                const hi = Math.max(...heights);
                styleInfo.text = i18n.t('sm.aishots.style-info', {
                    height: Math.abs(hi - lo) < 0.05 * Math.max(Math.abs(hi), 1e-6) ? formatLength(hi, sc) : `${formatLength(lo, sc)} – ${formatLength(hi, sc)}`
                });
            } else {
                styleInfo.text = '';
            }
            styleInfo.hidden = !styleInfo.text;
            const fps = events.invoke('timeline.frameRate') ?? 30;
            const seconds = duration.input.value;
            const frames = Math.round(seconds * fps) + 1;
            const timeline = events.invoke('timeline.frames') ?? 0;
            durationInfo.text = i18n.t(frames > timeline ? 'sm.aishots.duration-info-long' : 'sm.aishots.duration-info', { frames, fps, timeline });
        };

        moveSelect.el.addEventListener('change', () => {
            const value = moveSelect.el.value;
            if (value === 'walk') {
                pushSettings({ mode: 'walk' });
            } else {
                if (picking) events.fire('aiShots.setPicking', false);
                pushSettings({ mode: 'shot', template: value === 'all' ? undefined : value as ShotTemplate });
            }
            renderMode();
            renderAll();
        });
        styleSelect.el.addEventListener('change', () => pushSettings({ style: styleSelect.el.value as ShotStyle }));

        // --- claude --------------------------------------------------------------

        section('sm.aishots.section-ai');

        const wish = document.createElement('textarea');
        wish.className = 'ai-shots-wish';
        wish.rows = 3;
        i18n.onChange(() => {
            wish.placeholder = i18n.t('sm.aishots.wish-placeholder');
            wish.setAttribute('aria-label', i18n.t('sm.aishots.wish'));
        });
        this.dom.appendChild(wish);

        const useAi = toggleRow('sm.aishots.use-ai', 'sm.aishots.use-ai-tip', true);

        const aiHintRow = new Container({ class: 'ai-shots-row' });
        const aiHint = new Label({ class: ['ai-shots-info', 'ai-shots-hint'] });
        aiHintRow.append(aiHint);
        const openSettings = button('sm.aishots.open-settings', 'ai-shots-small', aiHintRow);
        openSettings.on('click', () => events.fire('settingsPanel.setVisible', true));
        this.append(aiHintRow);

        // the wish goes along when Claude is on
        function aiWish() {
            return useAi.toggle.value ? wish.value.trim() || undefined : undefined;
        }

        let aiHintKey = 'sm.aishots.ai-no-key';
        i18n.onChange(() => {
            aiHint.text = i18n.t(aiHintKey);
        }, aiHint);

        let wantAi = true;
        let syncingAi = false;
        const syncAi = () => {
            const available = aiAvailable();
            syncingAi = true;
            useAi.toggle.enabled = available;
            useAi.toggle.value = available && wantAi;
            syncingAi = false;
            wish.disabled = !useAi.toggle.value;
            const noKey = !keyStore.get();
            aiHintKey = noKey ? 'sm.aishots.ai-no-key' : 'sm.aishots.ai-offline';
            aiHint.text = i18n.t(aiHintKey);
            aiHintRow.hidden = available;
            openSettings.hidden = !noKey;
            renderDraft();
        };
        useAi.toggle.on('change', (value: boolean) => {
            if (syncingAi) return;
            wantAi = value;
            syncAi();
        });
        window.addEventListener('online', syncAi);
        window.addEventListener('offline', syncAi);
        // key saved / cleared in the settings, or removed in another tab
        events.on('aiShots.keyChanged', syncAi);
        keyStore.onChange(syncAi);

        // generate

        const actionRow = new Container({ class: 'ai-shots-actions' });
        const generateButton = button('sm.aishots.generate', 'ai-shots-generate', actionRow, 'sm.aishots.generate-tip');
        const cancelButton = button('sm.aishots.cancel', 'ai-shots-cancel', actionRow);
        cancelButton.hidden = true;
        this.append(actionRow);

        const statusLine = new Container({ class: 'ai-shots-status', hidden: true });
        const spinner = document.createElement('div');
        spinner.className = 'ai-shots-spinner';
        statusLine.dom.appendChild(spinner);
        const statusLabel = new Label({ class: 'ai-shots-status-label' });
        statusLine.append(statusLabel);
        this.append(statusLine);

        // shot moves or the walk: their rows, and walks are built here, not
        // suggested in variants
        function renderMode() {
            const walk = moveSelect.el.value === 'walk';
            walkRows.forEach((r) => {
                r.hidden = !walk;
            });
            shotRows.forEach((r) => {
                r.hidden = walk;
            });
            renderWalk();
            actionRow.hidden = walk;
            statusLine.hidden = !statusKey;
        }

        const renderStatus = () => {
            statusLabel.text = !statusKey ? '' :
                statusKind === 'error' ? translate(statusKey, 'sm.aishots.err.api') :
                    statusKind === 'warn' ? translate(statusKey, 'sm.aishots.warn.generic') :
                        i18n.t(statusKey);
        };
        i18n.onChange(renderStatus, statusLabel);

        function setStatus(key: string | null, kind: 'info' | 'error' | 'warn' = 'info') {
            statusKey = key;
            statusKind = kind;
            statusLine.hidden = !key;
            statusLine.class[kind === 'error' ? 'add' : 'remove']('ai-shots-error');
            statusLine.class[kind === 'warn' ? 'add' : 'remove']('ai-shots-warn');
            spinner.hidden = !busy || kind !== 'info';
            renderStatus();
        }

        const setBusy = (value: boolean) => {
            busy = value;
            generateButton.enabled = !value;
            cancelButton.hidden = !value;
            captureButton.enabled = !value;
        };

        // statuses beyond AiShotsStatus (e.g. 'waitingVisible' while the tab is
        // in the background) map to sm.aishots.status.<status> as well
        events.on('aiShots.status', (status: AiShotsStatus | string, detail?: string) => {
            if (status === 'error') {
                aiError = detail ?? 'sm.aishots.err.api';
                setStatus(aiError, 'error');
            } else if (busy && status !== 'idle') {
                setStatus(`sm.aishots.status.${status}`);
            }
        });

        // warnings from the core as i18n keys, e.g. sm.aishots.warn.compressed
        // when a move was squeezed into the timeline length
        const showWarning = (key: string) => {
            if (typeof key !== 'string' || !key.startsWith('sm.aishots.')) return;
            if (key.startsWith('sm.aishots.status.')) {
                if (busy) setStatus(key);
            } else {
                setStatus(key, 'warn');
            }
        };
        events.on('aiShots.warning', showWarning);

        // results

        const resultsHeader = new Container({ class: ['panel-header', 'options-panel-section'] });
        const resultsLabel = new Label({ class: 'panel-header-label' });
        resultsHeader.append(resultsLabel);
        this.append(resultsHeader);

        const empty = new Label({ class: 'ai-shots-empty' });
        i18n.bindText(empty, 'sm.aishots.empty');
        this.append(empty);
        const list = new Container({ class: 'ai-shots-list' });
        this.append(list);

        let cards: Card[] = [];

        const renderResultsLabel = () => {
            resultsLabel.text = cards.length ? i18n.t('sm.aishots.result-count', { n: cards.length }) : i18n.t('sm.aishots.section-results');
        };
        i18n.onChange(renderResultsLabel, resultsLabel);

        // footer: apply the checked suggestions

        const footer = new Container({ class: 'ai-shots-footer' });
        this.append(footer);

        const footerToggle = (labelKey: string, tipKey: string) => {
            const container = new Container({ class: 'settings-panel-row' });
            const rowLabel = new Label({ class: 'settings-panel-row-label' });
            i18n.bindText(rowLabel, labelKey);
            tooltips.register(rowLabel, () => i18n.t(tipKey), 'left');
            const toggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value: true });
            container.append(rowLabel);
            container.append(toggle);
            footer.append(container);
            return { row: container, toggle };
        };
        const setTimeline = footerToggle('sm.aishots.set-timeline', 'sm.aishots.set-timeline-tip').toggle;
        const disableLoop = footerToggle('sm.aishots.disable-loop', 'sm.aishots.disable-loop-tip').toggle;
        const loopHint = new Label({ class: ['ai-shots-info', 'ai-shots-hint'] });
        i18n.bindText(loopHint, 'sm.aishots.disable-loop-tip');
        footer.append(loopHint);
        // only offered when a suggestion carries a focus pull
        const enableDof = footerToggle('sm.aishots.enable-dof', 'sm.aishots.enable-dof-tip');

        // applying a suggestion again only goes through "apply selected"
        const reapplyHint = new Label({ class: ['ai-shots-info', 'ai-shots-hint'], hidden: true });
        i18n.bindText(reapplyHint, 'sm.aishots.reapply-hint');
        footer.append(reapplyHint);

        const applySelectedButton = new Button({ class: 'ai-shots-generate' });
        footer.append(applySelectedButton);

        const syncSelection = () => {
            const checked = cards.filter(c => c.check.value);
            applySelectedButton.enabled = !applying && checked.length > 0;
            applySelectedButton.text = i18n.t('sm.aishots.apply-selected', { n: checked.length });
            applySelectedButton.hidden = cards.length === 0;
            reapplyHint.hidden = !checked.some(c => c.applied);
            cards.forEach((c) => {
                c.applyButton.enabled = !applying && !c.applied;
            });
            const draft = draftState()?.draft;
            enableDof.row.hidden = ![...cards.map(c => c.proposal), ...(draft ? [draft] : [])].some(p => p.keys.some(k => k.focus !== undefined));
        };
        i18n.onChange(syncSelection, applySelectedButton);

        const applyOptions = (): ApplyOptions => ({
            setTimeline: setTimeline.value,
            disableLoop: disableLoop.value,
            enableDof: !enableDof.row.hidden && enableDof.toggle.value
        });

        const runApply = async (run: () => Promise<unknown>, done: () => void) => {
            if (applying) return;
            // all apply buttons stay locked while a call runs (no double clicks)
            applying = true;
            syncSelection();
            renderDraft();
            if (!busy && statusKind === 'warn') setStatus(null);
            try {
                const result = await run();
                done();
                applyWarnings(result).forEach(showWarning);
            } catch (error) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('sm.aishots.apply-failed'),
                    message: `'${(error as Error)?.message ?? error}'`
                });
            } finally {
                applying = false;
                syncSelection();
                renderDraft();
            }
        };

        const apply = (proposals: ShotProposal[]) => {
            if (!proposals.length || !events.functions.has('aiShots.apply')) return;
            return runApply(
                () => events.invoke('aiShots.apply', proposals, applyOptions()),
                () => cards.filter(c => proposals.includes(c.proposal)).forEach(c => c.markApplied())
            );
        };
        applySelectedButton.on('click', () => apply(cards.filter(c => c.check.value).map(c => c.proposal)));
        applyDraftButton.on('click', () => runApply(() => events.invoke('aiShots.applyDraft', applyOptions()), () => {
            setStatus('sm.aishots.preview.applied', 'info');
        }));

        let previewedCard: Card | null = null;

        const createCard = (proposal: ShotProposal): Card => {
            const root = new Container({ class: 'ai-shots-card' });

            const thumb = document.createElement('div');
            thumb.className = 'ai-shots-thumb';
            if (proposal.thumbnail) {
                const img = document.createElement('img');
                img.src = proposal.thumbnail;
                img.alt = '';
                thumb.appendChild(img);
            }
            // a click shows the move in the viewport as the draft
            i18n.onChange(() => {
                thumb.title = i18n.t('sm.aishots.card-preview-tip');
            }, root);
            thumb.addEventListener('click', () => {
                events.fire('aiShots.useProposal', proposal);
                cards.forEach(c => c.setPreviewed(c.proposal === proposal));
            });
            root.dom.appendChild(thumb);

            const head = new Container({ class: 'ai-shots-card-head' });
            const check = new BooleanInput({ class: 'ai-shots-check' });
            tooltips.register(check, () => i18n.t('sm.aishots.card-check-tip'), 'left');
            const title = new Label({ class: 'ai-shots-card-title' });
            i18n.bindText(title, () => titleOf(proposal));
            const badge = new Label({ class: 'ai-shots-badge', hidden: true });
            i18n.bindText(badge, 'sm.aishots.applied');
            head.append(check);
            head.append(title);
            head.append(badge);
            root.append(head);
            check.on('change', syncSelection);

            const meta = new Label({ class: 'ai-shots-card-meta' });
            const o = shownObject();
            i18n.bindText(meta, () => i18n.t('sm.aishots.frames', {
                seconds: Math.round(proposal.params.durationSec * 10) / 10,
                frames: proposal.frames
            }) + (o ? ` · ${formatLength(proposal.params.distanceFactor * o.radius, scale())}` : ''));
            root.append(meta);

            const percent = Math.round(Math.min(1, Math.max(0, proposal.score)) * 100);
            const scoreRow = new Container({ class: 'ai-shots-score' });
            const scoreLabel = new Label({ class: 'ai-shots-score-label' });
            i18n.bindText(scoreLabel, 'sm.aishots.score');
            scoreRow.append(scoreLabel);
            const bar = document.createElement('div');
            bar.className = 'ai-shots-bar';
            const fill = document.createElement('div');
            fill.style.width = `${percent}%`;
            bar.appendChild(fill);
            scoreRow.dom.appendChild(bar);
            tooltips.register(scoreRow, () => i18n.t('sm.aishots.score-tip', { percent }), 'left');
            root.append(scoreRow);

            if (proposal.aiScore !== undefined) {
                const aiScore = new Label({ class: 'ai-shots-ai-score' });
                i18n.bindText(aiScore, 'sm.aishots.ai-score', { score: Math.round(proposal.aiScore * 10) / 10 });
                root.append(aiScore);
            }

            const comment = proposal.aiComment ?? proposal.params.rationale;
            if (comment) {
                root.append(new Label({ class: 'ai-shots-comment', text: comment }));
            }

            proposal.warnings.forEach((warning) => {
                const w = new Label({ class: 'ai-shots-warning' });
                i18n.bindText(w, () => translate(warning, 'sm.aishots.warn.generic'));
                root.append(w);
            });

            const applyButton = button('sm.aishots.apply', 'ai-shots-small', root, 'sm.aishots.apply-tip');
            applyButton.on('click', () => apply([proposal]));

            const card: Card = {
                proposal,
                root,
                check,
                applyButton,
                applied: false,
                markApplied: () => {
                    card.applied = true;
                    root.class.add('applied');
                    badge.hidden = false;
                    applyButton.enabled = false;
                    check.value = false;
                },
                setPreviewed: (value: boolean) => {
                    root.class[value ? 'add' : 'remove']('previewed');
                    if (value) previewedCard = card;
                    else if (previewedCard === card) previewedCard = null;
                }
            };
            return card;
        };

        const showProposals = (proposals: ShotProposal[]) => {
            cards.forEach(c => c.root.destroy());
            previewedCard = null;
            cards = proposals.map(createCard);
            cards.forEach(c => list.append(c.root));
            empty.hidden = cards.length > 0;
            loopHint.hidden = false;
            renderResultsLabel();
            syncSelection();
        };

        // run

        const generate = async () => {
            if (busy || !events.functions.has('aiShots.generate')) return;
            cancelled = false;
            aiError = null;
            setBusy(true);
            setStatus('sm.aishots.status.generating');
            showProposals([]);
            try {
                const options: GenerateOptions = {
                    wish: useAi.toggle.value ? wish.value.trim() || undefined : undefined,
                    useAi: useAi.toggle.value,
                    durationSec: duration.input.value,
                    distanceScale: settings.distanceScale,
                    style: styleSelect.el.value as ShotStyle,
                    templates: moveSelect.el.value === 'all' ? undefined : [moveSelect.el.value as ShotTemplate]
                };
                const proposals = await events.invoke('aiShots.generate', options) as ShotProposal[] | null;
                if (!cancelled) showProposals(proposals ?? []);
            } catch (error) {
                if (!cancelled) aiError = errorCode(error);
            }
            setBusy(false);
            if (cancelled) {
                setStatus('sm.aishots.status.cancelled');
            } else {
                setStatus(aiError, aiError ? 'error' : 'info');
            }
        };
        generateButton.on('click', () => generate());
        cancelButton.on('click', () => {
            cancelled = true;
            events.fire('aiShots.cancel');
        });

        // everything that depends on the draft, the object or the scale
        function renderAll() {
            renderObject();
            renderDistance();
            renderMove();
            renderWalk();
            renderDraft();
        }
        events.on('aiShots.draftChanged', (state: DraftState) => {
            // a card is no longer what the viewport shows once the draft is
            // computed from the settings again
            if (state.source === 'settings') cards.forEach(c => c.setPreviewed(false));
            renderAll();
            syncSelection();
        });
        i18n.onChange(renderAll);

        // visibility: one options panel at a time

        const others = ['appearancePanel', 'overlaysPanel', 'settingsPanel', 'lookPanel', 'titlesPanel', 'lightPanel'];
        const setVisible = (visible: boolean) => {
            if (visible !== this.hidden) return;
            if (visible) {
                syncAi();
                syncAnchors();
                syncDuration();
                renderScale();
            }
            this.hidden = !visible;
            events.fire('aiShotsPanel.visible', visible);
            if (visible) others.forEach(name => events.fire(`${name}.setVisible`, false));
        };
        events.function('aiShotsPanel.visible', () => !this.hidden);
        events.on('aiShotsPanel.setVisible', setVisible);
        events.on('aiShotsPanel.toggleVisible', () => setVisible(this.hidden));
        others.forEach((name) => {
            events.on(`${name}.visible`, (visible: boolean) => {
                if (visible) setVisible(false);
            });
        });

        distanceRange.value = String(toSlider(settings.distanceScale));
        showProposals([]);
        renderMode();
        renderAll();
    }
}

export { AiShotsPanel };
