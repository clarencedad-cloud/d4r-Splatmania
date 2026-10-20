import { BooleanInput, Container, Label, NumericInput, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { TRANSITION_LABELS, type LayerRenderMode, type LayerState, type PointCloudSettings, type Transition, type TransitionAxis, type TransitionEasing, type TransitionEffect } from '../layer-anim';
import type { Splat } from '../splat';

// segmented button row; returns a sync function for the current value
const segmented = (parent: Container, options: [string, string, string?][], onPick: (value: string) => void) => {
    const group = new Container({ class: 'layer-anim-segmented' });
    const buttons = options.map(([value, text, tip]) => {
        const b = document.createElement('span');
        b.classList.add('layer-anim-segment');
        b.dataset.value = value;
        b.textContent = text;
        if (tip) b.title = tip;
        b.addEventListener('click', () => onPick(value));
        group.dom.appendChild(b);
        return b;
    });
    parent.append(group);
    return (value: string) => buttons.forEach(b => b.classList.toggle('active', b.dataset.value === value));
};

const row = (parent: Container, text: string, title?: string) => {
    const r = new Container({ class: 'layer-anim-row' });
    if (title) r.dom.title = title;
    r.append(new Label({ text, class: 'layer-anim-label' }));
    parent.append(r);
    return r;
};

const header = (text: string, icon: string) => {
    const h = new Container({ class: 'panel-header' });
    h.append(new Label({ text: icon, class: 'panel-header-icon' }));
    h.append(new Label({ text, class: 'panel-header-label' }));
    return h;
};

const button = (parent: Container, text: string, title: string, onClick: () => void) => {
    const b = document.createElement('span');
    b.classList.add('layer-anim-button');
    b.textContent = text;
    b.title = title;
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

        this.append(header('LAYER-ANIMATION', ''));
        const body = new Container({ class: 'layer-anim-body' });
        this.append(body);

        const none = new Label({ text: 'Kein Layer ausgewählt', class: 'layer-anim-none' });
        body.append(none);

        const layerControls = new Container({ class: 'layer-anim-controls' });
        body.append(layerControls);

        const opacity = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: 1 });
        row(layerControls, 'Deckkraft', 'Deckkraft des Layers. Mit Keys animiert sie über die Zeit').append(opacity);
        opacity.on('change', (v: number) => {
            if (syncing || !layer()) return;
            events.fire('layerAnim.setOpacity', layer(), v);
            // a user edit (auto key listens)
            events.fire('layerAnim.opacityEdited', layer());
        });

        const renderRow = row(layerControls, 'Darstellung', 'Darstellung dieses Layers, überschreibt den globalen Modus');
        const syncRender = segmented(renderRow, [
            ['inherit', 'Global'],
            ['splats', 'Splats'],
            ['points', 'Punkte']
        ], value => layer() && events.fire('layerAnim.setRenderMode', layer(), value as LayerRenderMode));

        const mixRow = row(layerControls, 'Punkt-Mix', 'Überblendung Splat (0) ↔ Punktwolke (1), animierbar. Aus = folgt der Darstellung');
        const mixOn = new BooleanInput({ value: false });
        const mix = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: 0 });
        mixRow.append(mixOn);
        mixRow.append(mix);
        mixOn.on('change', (v: boolean) => !syncing && layer() && events.fire('layerAnim.setMix', layer(), v ? mix.value : null));
        mix.on('change', (v: number) => !syncing && layer() && mixOn.value && events.fire('layerAnim.setMix', layer(), v));

        const interpRow = row(layerControls, 'Interpolation');
        const syncInterp = segmented(interpRow, [
            ['linear', 'Linear'],
            ['smooth', 'Smooth']
        ], value => layer() && events.fire('layerAnim.setInterpolation', layer(), value));

        const keyRow = new Container({ class: 'layer-anim-buttons' });
        layerControls.append(keyRow);
        button(keyRow, '◆ Key setzen', 'Deckkraft, Punkt-Mix und Transform am aktuellen Frame speichern', () => layer() && events.fire('layerAnim.addKey', layer()));
        button(keyRow, '◇ Key löschen', 'Key am aktuellen Frame löschen', () => layer() && events.fire('layerAnim.removeKey', layer()));

        const fadeRow = new Container({ class: 'layer-anim-buttons' });
        layerControls.append(fadeRow);
        const duration = new NumericInput({ min: 1, max: 10000, precision: 0, value: 30, class: 'layer-anim-duration' });
        button(fadeRow, 'Fade in', 'Deckkraft 0 → 1 ab dem aktuellen Frame', () => layer() && events.fire('layerAnim.fadeIn', layer(), duration.value));
        button(fadeRow, 'Fade out', 'Deckkraft 1 → 0 ab dem aktuellen Frame', () => layer() && events.fire('layerAnim.fadeOut', layer(), duration.value));
        fadeRow.append(duration);
        fadeRow.append(new Label({ text: 'Frames', class: 'layer-anim-label' }));

        // transitions (per-splat build effects of the selected layer)

        this.append(header('TRANSITIONS', '\uE163'));
        const tb = new Container({ class: 'layer-anim-body' });
        this.append(tb);

        const tNone = new Label({ text: 'Kein Layer ausgewählt', class: 'layer-anim-none' });
        tb.append(tNone);
        const tControls = new Container({ class: 'layer-anim-controls' });
        tb.append(tControls);

        const addRow = new Container({ class: 'layer-anim-buttons' });
        tControls.append(addRow);
        button(addRow, '+ In', 'Aufbau-Transition ab dem aktuellen Frame (Shift+Ziehen in der Layer-Zeile geht auch)', () => layer() && events.fire('layerAnim.addTransition', layer(), 'in'));
        button(addRow, '+ Out', 'Abbau-Transition ab dem aktuellen Frame (Shift+Alt+Ziehen in der Layer-Zeile)', () => layer() && events.fire('layerAnim.addTransition', layer(), 'out'));

        const list = new Container({ class: 'layer-anim-transition-list' });
        tControls.append(list);

        const editor = new Container({ class: 'layer-anim-controls' });
        tControls.append(editor);

        const selected = () => events.invoke('layerAnim.selectedTransition') as Transition | null;
        const update = (value: Partial<Transition>, undoable = true) => {
            const t = selected();
            if (!syncing && t && layer()) events.fire('layerAnim.updateTransition', layer(), t.id, value, undoable);
        };

        const syncKind = segmented(row(editor, 'Typ'), [
            ['in', 'In (Aufbau)'],
            ['out', 'Out (Abbau)']
        ], value => update({ kind: value as 'in' | 'out' }));

        const effects = Object.keys(TRANSITION_LABELS) as TransitionEffect[];
        const effectGrid = new Container({ class: 'layer-anim-effect-grid' });
        editor.append(effectGrid);
        const effectButtons = effects.map((effect) => {
            const b = document.createElement('span');
            b.classList.add('layer-anim-segment');
            b.textContent = TRANSITION_LABELS[effect];
            b.addEventListener('click', () => update({ effect }));
            effectGrid.dom.appendChild(b);
            return { effect, b };
        });

        const timingRow = row(editor, 'Start / Dauer');
        const startInput = new NumericInput({ min: 0, max: 100000, precision: 0, value: 0, class: 'layer-anim-duration' });
        const durationInput = new NumericInput({ min: 1, max: 100000, precision: 0, value: 30, class: 'layer-anim-duration' });
        timingRow.append(startInput);
        timingRow.append(durationInput);
        startInput.on('change', (v: number) => update({ start: v }));
        durationInput.on('change', (v: number) => update({ duration: v }));

        const syncEasing = segmented(row(editor, 'Easing'), [
            ['linear', 'Linear'],
            ['in', 'In'],
            ['out', 'Out'],
            ['inOut', 'In-Out']
        ], value => update({ easing: value as TransitionEasing }));

        const syncAxis = segmented(row(editor, 'Richtung', 'Achse für Sweep und Wave sowie für den Wirbel beim Fly-in. -Y bei Wave: hebt sich von unten'), [
            ['x', 'X'], ['-x', '-X'], ['y', 'Y'], ['-y', '-Y'], ['z', 'Z'], ['-z', '-Z']
        ], value => update({ axis: value as TransitionAxis }));

        const originRow = row(editor, 'Ursprung', 'Für Radial, Grow und Fly-in (Explosion)');
        const originLabel = new Label({ text: 'Layer-Mitte', class: 'layer-anim-origin' });
        originRow.append(originLabel);
        button(originRow, 'Mitte', 'Ursprung = Layer-Mitte', () => update({ origin: null }));
        button(originRow, 'Pivot', 'Ursprung = aktuelle Pivot-Position (Transform-Gizmo)', () => {
            const pivot = events.invoke('pivot');
            const pos = pivot?.transform?.position;
            if (pos) update({ origin: [pos.x, pos.y, pos.z] });
        });

        const syncFly = segmented(row(editor, 'Fly-in', 'Startverteilung beim Fly-in'), [
            ['random', 'Zufall'],
            ['explode', 'Explosion']
        ], value => update({ flyMode: value as Transition['flyMode'] }));

        const slider = (text: string, title: string, min: number, max: number, key: 'edge' | 'glow' | 'scatter' | 'swirl') => {
            const sl = new SliderInput({ min, max, sliderMin: min, sliderMax: max, precision: 2, step: 0.01, value: 0 });
            row(editor, text, title).append(sl);
            sl.on('change', (v: number) => update({ [key]: v }, false));
            return sl;
        };
        const edgeSlider = slider('Kante', 'Breite der Aufbau-Front', 0.01, 1, 'edge');
        const glowSlider = slider('Glühkante', 'Stärke der Glühkante an der Front', 0, 2, 'glow');
        const scatterSlider = slider('Streuung', 'Flug- bzw. Fallweite relativ zur Layer-Größe', 0, 3, 'scatter');
        const swirlSlider = slider('Wirbel', 'Umdrehungen beim Fly-in', 0, 3, 'swirl');

        const glowColorRow = row(editor, 'Glühfarbe');
        const glowColor = document.createElement('input');
        glowColor.type = 'color';
        glowColor.classList.add('layer-anim-color');
        glowColorRow.dom.appendChild(glowColor);
        glowColor.addEventListener('change', () => {
            const hex = glowColor.value;
            update({ glowColor: [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number] });
        });

        const extraRow = row(editor, 'Seed');
        const seedInput = new NumericInput({ min: 0, max: 100000, precision: 0, value: 1, class: 'layer-anim-duration' });
        extraRow.append(seedInput);
        seedInput.on('change', (v: number) => update({ seed: v }));
        extraRow.append(new Label({ text: 'Punkte zuerst', class: 'layer-anim-label' }));
        const pointPhase = new BooleanInput({ value: false });
        extraRow.append(pointPhase);
        pointPhase.on('change', (v: boolean) => update({ pointPhase: v }));

        // dissolve / materialize (the main transition): threshold driver,
        // noise, particle drift and the point look
        const dissolveBox = new Container({ class: 'layer-anim-controls' });
        editor.append(dissolveBox);
        const dRow = (text: string, title?: string) => row(dissolveBox, text, title);

        const syncDissolveMode = segmented(dRow('Schwelle', 'Was die Dissolve-Front treibt: reines Rauschen, Richtung (Achse) oder Radial vom Ursprung, jeweils mit Rausch-Anteil'), [
            ['noise', 'Rauschen'],
            ['axis', 'Achse'],
            ['radial', 'Radial']
        ], value => update({ dissolveMode: value as Transition['dissolveMode'] }));

        const dSlider = (text: string, title: string, min: number, max: number, key: 'noiseFreq' | 'noiseAmount' | 'pointSize' | 'pointTint') => {
            const sl = new SliderInput({ min, max, sliderMin: min, sliderMax: max, precision: 2, step: 0.01, value: 0 });
            dRow(text, title).append(sl);
            sl.on('change', (v: number) => update({ [key]: v }, false));
            return sl;
        };
        const noiseFreq = dSlider('Rauschfrequenz', 'Feinheit der Rauschkante, relativ zur Layer-Größe', 0.2, 20, 'noiseFreq');
        const noiseAmount = dSlider('Rausch-Anteil', 'Bei Achse/Radial: wie stark das Rauschen die Front zerfasert', 0, 1, 'noiseAmount');

        const syncDrift = segmented(dRow('Drift', 'Woher die Partikel kommen: nach außen vom Ursprung, entlang der Richtung (z. B. +Y = von oben) oder zufällig'), [
            ['out', 'Außen'],
            ['axis', 'Richtung'],
            ['random', 'Zufall']
        ], value => update({ driftMode: value as Transition['driftMode'] }));

        const pointSizeSlider = dSlider('Punktgröße', 'Durchmesser der leuchtenden Punkte in Pixeln', 0.5, 16, 'pointSize');
        const pointTint = dSlider('Punkt-Tönung', '0 = Splatfarbe, 1 = Glühfarbe', 0, 1, 'pointTint');

        const deleteRow = new Container({ class: 'layer-anim-buttons' });
        editor.append(deleteRow);
        button(deleteRow, 'Transition löschen', 'Gewählte Transition entfernen', () => {
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
            if (current) {
                syncKind(current.kind);
                effectButtons.forEach(({ effect, b }) => b.classList.toggle('active', effect === current.effect));
                startInput.value = current.start;
                durationInput.value = current.duration;
                syncEasing(current.easing);
                syncAxis(current.axis);
                originLabel.text = current.origin ? current.origin.map(v => v.toFixed(2)).join(', ') : 'Layer-Mitte';
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

        this.append(header('PUNKTWOLKE', ''));
        const pc = new Container({ class: 'layer-anim-body' });
        this.append(pc);

        const points = () => events.invoke('layerAnim.points') as PointCloudSettings;
        const setPoints = (v: Partial<PointCloudSettings>) => !syncing && events.fire('layerAnim.setPoints', v);

        const syncMode = segmented(row(pc, 'Modus', 'Globaler Render-Modus, wirkt auch im Video-Export'), [
            ['splats', 'Splats'],
            ['points', 'Punktwolke']
        ], value => setPoints({ mode: value as PointCloudSettings['mode'] }));

        const size = new SliderInput({ min: 0.1, max: 1000, sliderMin: 0.5, sliderMax: 20, precision: 2, step: 0.1, value: 3 });
        row(pc, 'Größe', 'Punktdurchmesser in Pixeln bzw. Welteinheiten').append(size);
        size.on('change', (v: number) => setPoints({ size: v }));

        const syncSizeMode = segmented(row(pc, 'Größe in', 'Pixel: konstant auf dem Bildschirm. Welt: wird mit der Entfernung kleiner'), [
            ['px', 'Pixel'],
            ['world', 'Welt']
        ], value => setPoints({ sizeMode: value as PointCloudSettings['sizeMode'] }));

        const colorRow = row(pc, 'Farbe');
        const syncColorMode = segmented(colorRow, [
            ['original', 'Original'],
            ['uniform', 'Einheit']
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
        row(pc, 'Deckkraft').append(pointOpacity);
        pointOpacity.on('change', (v: number) => setPoints({ opacity: v }));

        const glow = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: 0 });
        row(pc, 'Glühen', 'Additives Glühen der Punkte').append(glow);
        glow.on('change', (v: number) => setPoints({ glow: v }));

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
            }
            syncing = false;
        };

        const syncPoints = () => {
            const p = points();
            syncing = true;
            syncMode(p.mode);
            size.value = p.size;
            syncSizeMode(p.sizeMode);
            syncColorMode(p.colorMode);
            colorInput.value = `#${p.color.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
            pointOpacity.value = p.opacity;
            glow.value = p.glow;
            syncing = false;
        };

        events.on('selection.changed', syncLayer);
        events.on('layerAnim.changed', syncLayer);
        events.on('layerAnim.trackChanged', syncLayer);
        events.on('layerAnim.points', syncPoints);
        syncLayer();
        syncPoints();
    }
}

export { LayerAnimPanel };
