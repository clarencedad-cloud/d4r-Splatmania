import { BooleanInput, Container, Label, NumericInput, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { TRANSITION_LABELS, type LayerRenderMode, type LayerState, type PointCloudSettings, type Transition, type TransitionAxis, type TransitionEasing, type TransitionEffect } from '../layer-anim';
import type { Splat } from '../splat';
import { CollapsibleSection } from './collapsible';
import { helpButton } from './help';
import { createKeyButton, KeyState } from './key-button';
import { i18n } from './localization';

// segmented button row; returns a sync function for the current value
const segmented = (parent: Container, options: [string, string, string?][], onPick: (value: string) => void) => {
    const group = new Container({ class: 'layer-anim-segmented' });
    const buttons = options.map(([value, text, tip]) => {
        const b = document.createElement('span');
        b.classList.add('layer-anim-segment');
        b.dataset.value = value;
        i18n.bindDom(b, text);
        if (tip) i18n.bindDom(b, tip, 'title');
        b.addEventListener('click', () => onPick(value));
        group.dom.appendChild(b);
        return b;
    });
    parent.append(group);
    return (value: string) => buttons.forEach(b => b.classList.toggle('active', b.dataset.value === value));
};

const row = (parent: Container, text: string, title?: string) => {
    const r = new Container({ class: 'layer-anim-row' });
    if (title) i18n.bindDom(r.dom, title, 'title');
    const label = new Label({ class: 'layer-anim-label' });
    i18n.bindText(label, text);
    r.append(label);
    parent.append(r);
    return r;
};

const button = (parent: Container, text: string, title: string, onClick: () => void) => {
    const b = document.createElement('span');
    b.classList.add('layer-anim-button');
    i18n.bindDom(b, text);
    i18n.bindDom(b, title, 'title');
    b.addEventListener('click', onClick);
    parent.dom.appendChild(b);
    return b;
};

// layer animator (selected layer) and global point cloud settings
class LayerAnimPanel extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'layer-anim-panel'
        };

        super(args);

        const layer = () => (events.functions.has('selection') ? events.invoke('selection') : null) as Splat;
        const state = () => (layer() ? events.invoke('layerAnim.state', layer()) as LayerState : null);

        let syncing = false;

        // layer animator

        const animSection = new CollapsibleSection({ key: 'layerAnim', title: 'sm.anim.title', icon: '\uE198', bodyClass: 'layer-anim-body', actions: [helpButton(events, 'layerAnim')] });
        this.append(animSection);
        const body = animSection.body;

        const none = new Label({ class: 'layer-anim-none' });
        i18n.bindText(none, 'sm.common.no-layer');
        body.append(none);

        const layerControls = new Container({ class: 'layer-anim-controls' });
        body.append(layerControls);

        const opacity = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: 1 });
        const opacityRow = row(layerControls, 'sm.anim.opacity', 'sm.anim.opacity-tip');
        opacityRow.append(opacity);
        const channelKey = (channel: string) => createKeyButton(
            events,
            () => (layer() ? events.invoke('layerAnim.channelState', layer(), channel) as KeyState : null),
            () => layer() && events.fire('layerAnim.keyChannel', layer(), channel)
        ).dom;
        opacityRow.dom.appendChild(channelKey('opacity'));
        opacity.on('change', (v: number) => {
            if (syncing || !layer()) return;
            events.fire('layerAnim.setOpacity', layer(), v);
            // a user edit (auto key listens)
            events.fire('layerAnim.opacityEdited', layer());
        });

        const renderRow = row(layerControls, 'sm.anim.display', 'sm.anim.display-tip');
        const syncRender = segmented(renderRow, [
            ['inherit', 'sm.anim.display.global'],
            ['splats', 'sm.anim.display.splats'],
            ['points', 'sm.anim.display.points']
        ], value => layer() && events.fire('layerAnim.setRenderMode', layer(), value as LayerRenderMode));

        const mixRow = row(layerControls, 'sm.anim.mix', 'sm.anim.mix-tip');
        const mixOn = new BooleanInput({ value: false });
        const mix = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: 0 });
        mixRow.append(mixOn);
        mixRow.append(mix);
        mixRow.dom.appendChild(channelKey('mix'));
        mixOn.on('change', (v: boolean) => !syncing && layer() && events.fire('layerAnim.setMix', layer(), v ? mix.value : null));
        mix.on('change', (v: number) => {
            if (syncing || !layer() || !mixOn.value) return;
            events.fire('layerAnim.setMix', layer(), v);
            events.fire('layerAnim.mixEdited', layer());
        });

        // splat size of this layer: off = the global display setting
        const scaleRow = row(layerControls, 'sm.anim.splat-size', 'sm.anim.splat-size-tip');
        const scaleOn = new BooleanInput({ value: false });
        const scale = new SliderInput({ min: 0.05, max: 4, sliderMin: 0.2, sliderMax: 2, precision: 2, step: 0.01, value: 1 });
        scaleRow.append(scaleOn);
        scaleRow.append(scale);
        scaleOn.on('change', (v: boolean) => !syncing && layer() && events.fire('layerAnim.setSplatScale', layer(), v ? scale.value : null));
        scale.on('change', (v: number) => !syncing && layer() && scaleOn.value && events.fire('layerAnim.setSplatScale', layer(), v));

        const interpRow = row(layerControls, 'sm.anim.interpolation', 'sm.anim.interpolation-tip');
        const syncInterp = segmented(interpRow, [
            ['linear', 'Linear'],
            ['smooth', 'Smooth']
        ], value => layer() && events.fire('layerAnim.setInterpolation', layer(), value));

        const keyRow = new Container({ class: 'layer-anim-buttons' });
        layerControls.append(keyRow);
        button(keyRow, 'sm.anim.set-key', 'sm.anim.set-key-tip', () => layer() && events.fire('layerAnim.addKey', layer()));
        button(keyRow, 'sm.anim.delete-key', 'sm.anim.delete-key-tip', () => layer() && events.fire('layerAnim.removeKey', layer()));

        const fadeRow = new Container({ class: 'layer-anim-buttons' });
        layerControls.append(fadeRow);
        const duration = new NumericInput({ min: 1, max: 10000, precision: 0, value: 30, class: 'layer-anim-duration' });
        i18n.bindDom(duration.dom, 'sm.anim.fade-duration-tip', 'title');
        button(fadeRow, 'sm.anim.fade-in', 'sm.anim.fade-in-tip', () => layer() && events.fire('layerAnim.fadeIn', layer(), duration.value));
        button(fadeRow, 'sm.anim.fade-out', 'sm.anim.fade-out-tip', () => layer() && events.fire('layerAnim.fadeOut', layer(), duration.value));
        fadeRow.append(duration);
        const framesLabel = new Label({ class: 'layer-anim-label' });
        i18n.bindText(framesLabel, 'sm.common.frames');
        fadeRow.append(framesLabel);

        // transitions (per-splat build effects of the selected layer)

        const transitionSection = new CollapsibleSection({ key: 'transitions', title: 'sm.transitions.title', icon: '\uE217', bodyClass: 'layer-anim-body', actions: [helpButton(events, 'transitions')] });
        this.append(transitionSection);
        const tb = transitionSection.body;

        const tNone = new Label({ class: 'layer-anim-none' });
        i18n.bindText(tNone, 'sm.common.no-layer');
        tb.append(tNone);
        const tControls = new Container({ class: 'layer-anim-controls' });
        tb.append(tControls);

        const addRow = new Container({ class: 'layer-anim-buttons' });
        tControls.append(addRow);
        button(addRow, '+ In', 'sm.transitions.add-in-tip', () => layer() && events.fire('layerAnim.addTransition', layer(), 'in'));
        button(addRow, '+ Out', 'sm.transitions.add-out-tip', () => layer() && events.fire('layerAnim.addTransition', layer(), 'out'));

        const list = new Container({ class: 'layer-anim-transition-list' });
        tControls.append(list);

        const editor = new Container({ class: 'layer-anim-controls' });
        tControls.append(editor);

        const selected = () => events.invoke('layerAnim.selectedTransition') as Transition | null;
        const update = (value: Partial<Transition>, undoable = true) => {
            const t = selected();
            if (!syncing && t && layer()) events.fire('layerAnim.updateTransition', layer(), t.id, value, undoable);
        };

        const syncKind = segmented(row(editor, 'sm.transitions.type'), [
            ['in', 'sm.transitions.type.in'],
            ['out', 'sm.transitions.type.out']
        ], value => update({ kind: value as 'in' | 'out' }));

        const effects = Object.keys(TRANSITION_LABELS) as TransitionEffect[];
        const effectGrid = new Container({ class: 'layer-anim-effect-grid' });
        editor.append(effectGrid);
        const effectButtons = effects.map((effect) => {
            const b = document.createElement('span');
            b.classList.add('layer-anim-segment');
            b.textContent = TRANSITION_LABELS[effect];
            i18n.bindDom(b, `sm.transitions.effect.${effect}-tip`, 'title');
            b.addEventListener('click', () => update({ effect }));
            effectGrid.dom.appendChild(b);
            return { effect, b };
        });

        const timingRow = row(editor, 'sm.transitions.timing', 'sm.transitions.timing-tip');
        const startInput = new NumericInput({ min: 0, max: 100000, precision: 0, value: 0, class: 'layer-anim-duration' });
        const durationInput = new NumericInput({ min: 1, max: 100000, precision: 0, value: 30, class: 'layer-anim-duration' });
        timingRow.append(startInput);
        timingRow.append(durationInput);
        startInput.on('change', (v: number) => update({ start: v }));
        durationInput.on('change', (v: number) => update({ duration: v }));

        const syncEasing = segmented(row(editor, 'sm.transitions.easing', 'sm.transitions.easing-tip'), [
            ['linear', 'Linear'],
            ['in', 'In'],
            ['out', 'Out'],
            ['inOut', 'In-Out']
        ], value => update({ easing: value as TransitionEasing }));

        const syncAxis = segmented(row(editor, 'sm.transitions.direction', 'sm.transitions.direction-tip'), [
            ['x', 'X'], ['-x', '-X'], ['y', 'Y'], ['-y', '-Y'], ['z', 'Z'], ['-z', '-Z']
        ], value => update({ axis: value as TransitionAxis }));

        const originRow = row(editor, 'sm.transitions.origin', 'sm.transitions.origin-tip');
        const originLabel = new Label({ text: i18n.t('sm.transitions.origin.center'), class: 'layer-anim-origin' });
        originRow.append(originLabel);
        button(originRow, 'sm.transitions.center', 'sm.transitions.center-tip', () => update({ origin: null }));
        button(originRow, 'Pivot', 'sm.transitions.pivot-tip', () => {
            const pivot = events.invoke('pivot');
            const pos = pivot?.transform?.position;
            if (pos) update({ origin: [pos.x, pos.y, pos.z] });
        });

        const syncFly = segmented(row(editor, 'Fly-in', 'sm.transitions.fly-tip'), [
            ['random', 'sm.transitions.random'],
            ['explode', 'sm.transitions.explode']
        ], value => update({ flyMode: value as Transition['flyMode'] }));

        // rarely tuned look parameters (shown below the dissolve settings)
        const advSection = new CollapsibleSection({ key: 'transitions.advanced', title: 'sm.common.advanced', sub: true });
        editor.append(advSection);
        const adv = advSection.body;

        const slider = (text: string, title: string, min: number, max: number, key: 'edge' | 'glow' | 'scatter' | 'swirl') => {
            const sl = new SliderInput({ min, max, sliderMin: min, sliderMax: max, precision: 2, step: 0.01, value: 0 });
            row(adv, text, title).append(sl);
            sl.on('change', (v: number) => update({ [key]: v }, false));
            return sl;
        };
        const edgeSlider = slider('sm.transitions.edge', 'sm.transitions.edge-tip', 0.01, 1, 'edge');
        const glowSlider = slider('sm.transitions.glow', 'sm.transitions.glow-tip', 0, 2, 'glow');
        const scatterSlider = slider('sm.transitions.scatter', 'sm.transitions.scatter-tip', 0, 3, 'scatter');
        const swirlSlider = slider('sm.transitions.swirl', 'sm.transitions.swirl-tip', 0, 3, 'swirl');

        const glowColorRow = row(adv, 'sm.transitions.glow-color');
        const glowColor = document.createElement('input');
        glowColor.type = 'color';
        glowColor.classList.add('layer-anim-color');
        glowColorRow.dom.appendChild(glowColor);
        glowColor.addEventListener('change', () => {
            const hex = glowColor.value;
            update({ glowColor: [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number] });
        });

        const extraRow = row(adv, 'sm.cleanup.seed');
        const seedInput = new NumericInput({ min: 0, max: 100000, precision: 0, value: 1, class: 'layer-anim-duration' });
        i18n.bindDom(seedInput.dom, 'sm.transitions.seed-tip', 'title');
        extraRow.append(seedInput);
        seedInput.on('change', (v: number) => update({ seed: v }));
        const pointsFirstLabel = new Label({ class: 'layer-anim-label' });
        i18n.bindText(pointsFirstLabel, 'sm.transitions.points-first');
        extraRow.append(pointsFirstLabel);
        const pointPhase = new BooleanInput({ value: false });
        i18n.bindDom(pointsFirstLabel.dom, 'sm.transitions.points-first-tip', 'title');
        i18n.bindDom(pointPhase.dom, 'sm.transitions.points-first-tip', 'title');
        extraRow.append(pointPhase);
        pointPhase.on('change', (v: boolean) => update({ pointPhase: v }));

        // dissolve / materialize (the main transition): threshold driver,
        // noise, particle drift and the point look
        const dissolveBox = new Container({ class: 'layer-anim-controls' });
        editor.append(dissolveBox);
        editor.dom.insertBefore(dissolveBox.dom, advSection.dom);
        const dRow = (text: string, title?: string) => row(dissolveBox, text, title);

        const syncDissolveMode = segmented(dRow('sm.transitions.threshold', 'sm.transitions.threshold-tip'), [
            ['noise', 'sm.transitions.noise'],
            ['axis', 'sm.transitions.axis'],
            ['radial', 'Radial']
        ], value => update({ dissolveMode: value as Transition['dissolveMode'] }));

        const dSlider = (text: string, title: string, min: number, max: number, key: 'noiseFreq' | 'noiseAmount' | 'pointSize' | 'pointTint') => {
            const sl = new SliderInput({ min, max, sliderMin: min, sliderMax: max, precision: 2, step: 0.01, value: 0 });
            dRow(text, title).append(sl);
            sl.on('change', (v: number) => update({ [key]: v }, false));
            return sl;
        };
        const noiseFreq = dSlider('sm.transitions.noise-freq', 'sm.transitions.noise-freq-tip', 0.2, 20, 'noiseFreq');
        const noiseAmount = dSlider('sm.transitions.noise-amount', 'sm.transitions.noise-amount-tip', 0, 1, 'noiseAmount');

        const syncDrift = segmented(dRow('Drift', 'sm.transitions.drift-tip'), [
            ['out', 'sm.transitions.outward'],
            ['axis', 'sm.transitions.direction'],
            ['random', 'sm.transitions.random']
        ], value => update({ driftMode: value as Transition['driftMode'] }));

        const pointSizeSlider = dSlider('sm.transitions.point-size', 'sm.transitions.point-size-tip', 0.5, 16, 'pointSize');
        const pointTint = dSlider('sm.transitions.point-tint', 'sm.transitions.point-tint-tip', 0, 1, 'pointTint');

        const deleteRow = new Container({ class: 'layer-anim-buttons' });
        editor.append(deleteRow);
        button(deleteRow, 'sm.transitions.delete', 'sm.transitions.delete-tip', () => {
            const t = selected();
            if (t && layer()) events.fire('layerAnim.removeTransition', layer(), t.id);
        });

        const toHex = (c: number[]) => `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

        const syncTransitions = () => {
            const s = state();
            syncing = true;
            tNone.hidden = !!s;
            tControls.hidden = !s;
            list.dom.innerHTML = '';
            const current = selected();
            if (s) {
                for (const t of s.track.transitions.slice().sort((a, b) => a.start - b.start)) {
                    const item = document.createElement('div');
                    item.classList.add('layer-anim-transition-item', t.kind);
                    if (current?.id === t.id) item.classList.add('selected');
                    item.textContent = `${t.kind === 'in' ? '▲ In' : '▼ Out'} · ${TRANSITION_LABELS[t.effect]} · ${t.start}–${t.start + t.duration}`;
                    item.addEventListener('click', () => events.fire('layerAnim.selectTransition', t.id));
                    list.dom.appendChild(item);
                }
            }
            editor.hidden = !current;
            const count = s?.track.transitions.length ?? 0;
            transitionSection.setInfo(current ? `${TRANSITION_LABELS[current.effect]} ${current.start}–${current.start + current.duration}` : count ? `${count}×` : '');
            if (current) {
                syncKind(current.kind);
                effectButtons.forEach(({ effect, b }) => b.classList.toggle('active', effect === current.effect));
                startInput.value = current.start;
                durationInput.value = current.duration;
                syncEasing(current.easing);
                syncAxis(current.axis);
                originLabel.text = current.origin ? current.origin.map(v => v.toFixed(2)).join(', ') : i18n.t('sm.transitions.origin.center');
                syncFly(current.flyMode);
                edgeSlider.value = current.edge;
                glowSlider.value = current.glow;
                scatterSlider.value = current.scatter;
                swirlSlider.value = current.swirl;
                glowColor.value = toHex(current.glowColor);
                seedInput.value = current.seed;
                pointPhase.value = current.pointPhase;
                dissolveBox.hidden = current.effect !== 'dissolve';
                syncDissolveMode(current.dissolveMode ?? 'noise');
                noiseFreq.value = current.noiseFreq ?? 3;
                noiseAmount.value = current.noiseAmount ?? 0.5;
                syncDrift(current.driftMode ?? 'out');
                pointSizeSlider.value = current.pointSize ?? 3;
                pointTint.value = current.pointTint ?? 0.6;
            }
            syncing = false;
        };

        events.on('selection.changed', syncTransitions);
        events.on('layerAnim.trackChanged', syncTransitions);
        events.on('layerAnim.transitionSelected', syncTransitions);
        syncTransitions();

        // point cloud (global)

        const pointSection = new CollapsibleSection({ key: 'pointCloud', title: 'sm.display.title', icon: '', bodyClass: 'layer-anim-body', actions: [helpButton(events, 'pointCloud')] });
        this.append(pointSection);
        const pc = pointSection.body;
        const pAdvSection = new CollapsibleSection({ key: 'pointCloud.advanced', title: 'sm.common.advanced', sub: true });
        pc.append(pAdvSection);
        const pAdv = pAdvSection.body;

        const points = () => events.invoke('layerAnim.points') as PointCloudSettings;
        const setPoints = (v: Partial<PointCloudSettings>) => !syncing && events.fire('layerAnim.setPoints', v);

        const syncMode = segmented(row(pc, 'sm.points.mode', 'sm.points.mode-tip'), [
            ['splats', 'sm.anim.display.splats'],
            ['points', 'sm.points.title']
        ], value => setPoints({ mode: value as PointCloudSettings['mode'] }));

        // splat size: scales every gaussian (display only); the low-pass
        // filter is the fixed screen-space blur every splat gets, lower is
        // crisper
        const splatScale = new SliderInput({ min: 0.05, max: 4, sliderMin: 0.2, sliderMax: 2, precision: 2, step: 0.01, value: 1 });
        row(pc, 'sm.display.splat-size', 'sm.display.splat-size-tip').append(splatScale);
        splatScale.on('change', (v: number) => setPoints({ splatScale: v }));

        const splatFilter = new SliderInput({ min: 0, max: 2, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: 0.3 });
        row(pc, 'sm.display.softness', 'sm.display.softness-tip').append(splatFilter);
        splatFilter.on('change', (v: number) => setPoints({ splatFilter: v }));

        const size = new SliderInput({ min: 0.1, max: 1000, sliderMin: 0.5, sliderMax: 20, precision: 2, step: 0.1, value: 3 });
        row(pc, 'sm.display.point-size', 'sm.points.size-tip').append(size);
        size.on('change', (v: number) => setPoints({ size: v }));

        const syncSizeMode = segmented(row(pAdv, 'sm.points.size-in', 'sm.points.size-in-tip'), [
            ['px', 'sm.points.pixels'],
            ['world', 'sm.points.world']
        ], value => setPoints({ sizeMode: value as PointCloudSettings['sizeMode'] }));

        const colorRow = row(pc, 'sm.points.color', 'sm.points.color-tip');
        const syncColorMode = segmented(colorRow, [
            ['original', 'sm.points.original'],
            ['uniform', 'sm.points.uniform']
        ], value => setPoints({ colorMode: value as PointCloudSettings['colorMode'] }));
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.classList.add('layer-anim-color');
        colorRow.dom.appendChild(colorInput);
        colorInput.addEventListener('input', () => {
            const hex = colorInput.value;
            setPoints({ color: [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number] });
        });

        const pointOpacity = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: 1 });
        row(pc, 'sm.anim.opacity', 'sm.points.opacity-tip').append(pointOpacity);
        pointOpacity.on('change', (v: number) => setPoints({ opacity: v }));

        const glow = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: 0 });
        row(pAdv, 'sm.points.glow', 'sm.points.glow-tip').append(glow);
        glow.on('change', (v: number) => setPoints({ glow: v }));
        // the advanced group goes last
        pc.dom.appendChild(pAdvSection.dom);

        // sync

        const syncLayer = () => {
            const s = state();
            syncing = true;
            none.hidden = !!s;
            layerControls.hidden = !s;
            if (s) {
                opacity.value = s.opacity;
                syncRender(s.renderMode);
                mixOn.value = s.mixOverride !== null;
                mix.value = s.mixOverride ?? 0;
                mix.enabled = s.mixOverride !== null;
                syncInterp(s.track.interpolation);
                scaleOn.value = s.splatScale !== null;
                scale.value = s.splatScale ?? points().splatScale ?? 1;
                scale.enabled = s.splatScale !== null;
            }
            const keys = s?.track.keys.length ?? 0;
            animSection.setInfo(s ? i18n.t('sm.common.keys', { count: keys }) : '');
            syncing = false;
        };

        const syncPoints = () => {
            const p = points();
            syncing = true;
            syncMode(p.mode);
            size.value = p.size;
            splatScale.value = p.splatScale ?? 1;
            splatFilter.value = p.splatFilter ?? 0.3;
            syncSizeMode(p.sizeMode);
            syncColorMode(p.colorMode);
            colorInput.value = `#${p.color.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
            pointOpacity.value = p.opacity;
            glow.value = p.glow;
            pointSection.setInfo(i18n.t(p.mode === 'points' ? 'sm.points.title' : 'sm.anim.display.splats'));
            syncing = false;
        };

        events.on('selection.changed', syncLayer);
        events.on('layerAnim.changed', syncLayer);
        events.on('layerAnim.trackChanged', syncLayer);
        events.on('layerAnim.points', syncPoints);
        // a layer following the global size shows it
        events.on('layerAnim.points', syncLayer);
        // section infos and the transition list are composed text
        i18n.onChange(() => {
            syncLayer();
            syncPoints();
            syncTransitions();
        });
    }
}

export { LayerAnimPanel };
