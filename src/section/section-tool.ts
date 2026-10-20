import { BooleanInput, Container, Label, NumericInput, SliderInput } from '@playcanvas/pcui';
import { Color, Quat, Vec3 } from 'playcanvas';

import { readLayerData } from '../analysis/splat-data';
import type { AnimTrack } from '../anim-track';
import { AnimTrackEditOp } from '../edit-ops';
import { ElementType } from '../element';
import { Events } from '../events';
import type { Scene } from '../scene';
import type { Splat } from '../splat';

// Section cut: cuts the model from the top down along an up axis, e.g. the
// roof off a building down to its floor plan. Non-destructive - the splat
// projector drops splats above the cut height (in every pass, so cut-away
// splats can't be picked or selected either). The cut value 0..1 maps
// linearly from the top of the model (0 = nothing cut) down to the floor plan
// height (1 = floor + floor plan height). It has its own keyframe track.

type SectionState = {
    // 0 = nothing cut .. 1 = down to the floor plan height
    value: number,
    axisMode: 'world' | 'layer',
    // robust extent along the axis (1st / 99th percentile), measured
    top: number,
    bottom: number,
    // floor height along the axis; null = bottom
    floor: number | null,
    // what stays of the walls at 100 %
    floorPlanHeight: number,
    // soft edge width (world units), 0 = hard
    edge: number,
    scope: 'all' | 'active',
    showPlane: boolean
};

type SectionKey = { frame: number, value: number };

// keyframe track of the cut value; smooth (ease in/out) interpolation
class SectionTrack implements AnimTrack {
    private keyList: SectionKey[] = [];
    constructor(private events: Events, private capture: () => number) {}

    get keys() {
        return this.keyList.map(k => k.frame);
    }

    get keyData(): readonly SectionKey[] {
        return this.keyList;
    }

    addKey(frame: number) {
        const value = this.capture();
        const existing = this.keyList.find(k => k.frame === frame);
        if (existing) {
            existing.value = value;
        } else {
            this.keyList.push({ frame, value });
            this.keyList.sort((a, b) => a.frame - b.frame);
        }
        this.changed();
        return true;
    }

    removeKey(frame: number) {
        const i = this.keyList.findIndex(k => k.frame === frame);
        if (i === -1) return false;
        this.keyList.splice(i, 1);
        this.changed();
        return true;
    }

    moveKey(from: number, to: number) {
        const key = this.keyList.find(k => k.frame === from);
        if (!key || from === to) return false;
        this.keyList = this.keyList.filter(k => k.frame !== to);
        key.frame = to;
        this.keyList.sort((a, b) => a.frame - b.frame);
        this.changed();
        return true;
    }

    copyKey(from: number, to: number) {
        const key = this.keyList.find(k => k.frame === from);
        if (!key || from === to) return false;
        this.keyList = this.keyList.filter(k => k.frame !== to);
        this.keyList.push({ frame: to, value: key.value });
        this.keyList.sort((a, b) => a.frame - b.frame);
        this.changed();
        return true;
    }

    clear() {
        this.keyList = [];
        this.changed();
    }

    snapshot() {
        return this.keyList.map(k => ({ ...k }));
    }

    restore(snapshot: unknown) {
        this.keyList = (snapshot as SectionKey[]).map(k => ({ ...k }));
        this.changed();
    }

    // the animated value at frame, or null without keys
    evaluate(frame: number): number | null {
        const keys = this.keyList;
        if (keys.length === 0) return null;
        if (frame <= keys[0].frame) return keys[0].value;
        const last = keys[keys.length - 1];
        if (frame >= last.frame) return last.value;
        for (let i = 0; i < keys.length - 1; i++) {
            const a = keys[i], b = keys[i + 1];
            if (frame >= a.frame && frame <= b.frame) {
                const t = (frame - a.frame) / (b.frame - a.frame);
                const e = t * t * (3 - 2 * t);
                return a.value + (b.value - a.value) * e;
            }
        }
        return null;
    }

    private changed() {
        this.events.fire('section.trackChanged', this);
    }
}

const UP = new Vec3(0, 1, 0);
const planeColor = new Color(0.761, 0.055, 0.494, 0.8);

class SectionTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const state: SectionState = {
            value: 0,
            axisMode: 'world',
            top: 1,
            bottom: 0,
            floor: null,
            floorPlanHeight: 0.4,
            edge: 0.05,
            scope: 'all',
            showPlane: true
        };
        let measured = false;
        let active = false;
        let picking = false;
        let currentFrame = 0;

        const track = new SectionTrack(events, () => state.value);

        const selected = () => (events.functions.has('selection') ? events.invoke('selection') as Splat : null);
        const visibleSplats = () => (scene.getElementsByType(ElementType.splat) as Splat[]).filter(s => s.visible);
        const targets = () => (state.scope === 'active' ? [selected()].filter(Boolean) : visibleSplats());

        // the up axis: world Y, or the active layer's up (its rotation plus
        // the local frame the orient tool sets)
        const axis = () => {
            const splat = selected();
            if (state.axisMode === 'layer' && splat) {
                const q = new Quat().mul2(splat.entity.getRotation(), splat.localFrame);
                return q.transformVector(UP, new Vec3()).normalize();
            }
            return UP.clone();
        };

        const base = () => (state.floor ?? state.bottom) + state.floorPlanHeight;
        const heightFor = (value: number) => state.top - value * (state.top - base());
        const valueFor = (height: number) => (state.top - height) / Math.max(1e-6, state.top - base());

        const changed = () => {
            events.fire('section.changed', state);
            scene.forceRender = true;
        };

        // robust extent of the visible splats along the axis
        const measure = async () => {
            const a = axis();
            const heights: number[] = [];
            for (const splat of targets()) {
                const data = await readLayerData(splat, { stride: Math.ceil(splat.instances.count / 200000) });
                const p = data.positions;
                for (let i = 0; i < p.length; i += 3) heights.push(p[i] * a.x + p[i + 1] * a.y + p[i + 2] * a.z);
            }
            if (heights.length === 0) return;
            heights.sort((x, y) => x - y);
            state.bottom = heights[Math.floor(heights.length * 0.01)];
            state.top = heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.99))];
            measured = true;
            changed();
        };

        // what the projector / intersect compute use for a layer
        events.function('section.params', (splat: Splat) => {
            if (state.value <= 0 || !measured) return null;
            if (state.scope === 'active' && splat !== selected()) return null;
            const a = axis();
            return { axis: [a.x, a.y, a.z], height: heightFor(state.value), edge: state.edge };
        });

        events.function('section.state', () => state);
        events.function('section.track', () => track);
        events.function('section.height', () => heightFor(state.value));
        events.function('section.measure', measure);

        events.on('section.set', (value: Partial<SectionState>) => {
            Object.assign(state, value);
            if (value.axisMode !== undefined || value.scope !== undefined) {
                measure();
            }
            changed();
        });

        // the animated value follows the timeline
        const applyTrack = () => {
            const v = track.evaluate(currentFrame);
            if (v !== null && v !== state.value) {
                state.value = v;
                changed();
            }
        };
        events.on('timeline.time', (t: number) => {
            currentFrame = t;
            applyTrack();
        });
        events.on('timeline.frame', (f: number) => {
            currentFrame = f;
            applyTrack();
        });
        events.on('section.trackChanged', () => {
            applyTrack();
            events.fire('section.changed', state);
        });

        // undoable key edit on the section track, also reachable via the
        // track manager when the section is the key target
        events.on('section.addKey', (frame?: number) => {
            const before = track.snapshot();
            track.addKey(frame ?? events.invoke('timeline.frame'));
            events.fire('edit.add', new AnimTrackEditOp('sectionKey', track, before, track.snapshot()), true);
        });

        // select what the cut removes on the active layer (normal, undoable
        // selection; delete afterwards for an export without the roof)
        events.function('section.selectCut', async () => {
            const splat = selected();
            if (!splat || state.value <= 0) return 0;
            const a = axis();
            const h = heightFor(state.value);
            const data = await readLayerData(splat);
            const mask = new Uint8Array(splat.instances.count);
            let n = 0;
            const p = data.positions;
            for (let i = 0; i < data.instances.length; i++) {
                if (p[i * 3] * a.x + p[i * 3 + 1] * a.y + p[i * 3 + 2] * a.z >= h) {
                    mask[data.instances[i]] = 255;
                    n++;
                }
            }
            events.fire('select.mask', 'set', mask);
            return n;
        });

        // serialization
        events.function('docSerialize.section', () => ({ ...state, keys: track.snapshot() }));
        events.function('docDeserialize.section', (doc: any) => {
            if (!doc) return;
            const { keys, ...rest } = doc;
            Object.assign(state, rest);
            measured = true;
            track.restore(keys ?? []);
            changed();
        });

        // editor-only plane: a grid at the cut height over the model's extent
        events.on('prerender', () => {
            if (!active || !state.showPlane || state.value <= 0 || !measured || !scene.camera.renderOverlays) return;
            const splats = targets();
            if (splats.length === 0) return;
            const a = axis();
            const h = heightFor(state.value);
            const center = new Vec3();
            let radius = 0;
            splats.forEach((s) => {
                center.add(s.worldBound.center);
                radius = Math.max(radius, s.worldBound.halfExtents.length());
            });
            center.mulScalar(1 / splats.length);
            center.add(a.clone().mulScalar(h - center.dot(a)));
            const u = new Vec3().cross(a, Math.abs(a.y) < 0.9 ? Vec3.UP : Vec3.RIGHT).normalize();
            const v = new Vec3().cross(a, u).normalize();
            const n = 8;
            const size = radius * 0.8;
            for (let i = -n; i <= n; i++) {
                const t = (i / n) * size;
                const p0 = center.clone().add(u.clone().mulScalar(t)).add(v.clone().mulScalar(-size));
                const p1 = center.clone().add(u.clone().mulScalar(t)).add(v.clone().mulScalar(size));
                const q0 = center.clone().add(v.clone().mulScalar(t)).add(u.clone().mulScalar(-size));
                const q1 = center.clone().add(v.clone().mulScalar(t)).add(u.clone().mulScalar(size));
                scene.app.drawLine(p0, p1, planeColor, true, scene.gizmoLayer);
                scene.app.drawLine(q0, q1, planeColor, true, scene.gizmoLayer);
            }
        });

        // floor pipette: the next viewport click sets the floor height
        const pointer = { x: 0, y: 0, down: false };
        canvasContainer.dom.addEventListener('pointerdown', (e: PointerEvent) => {
            if (!picking) return;
            pointer.x = e.offsetX;
            pointer.y = e.offsetY;
            pointer.down = true;
        });
        canvasContainer.dom.addEventListener('pointerup', async (e: PointerEvent) => {
            if (!picking || !pointer.down) return;
            pointer.down = false;
            if (Math.hypot(e.offsetX - pointer.x, e.offsetY - pointer.y) > 4) return;
            picking = false;
            const hit = await scene.camera.intersect(pointer.x / canvasContainer.dom.clientWidth, pointer.y / canvasContainer.dom.clientHeight);
            if (hit) {
                state.floor = hit.position.dot(axis());
                changed();
            }
            events.fire('section.picking', false);
        });

        // panel

        const panel = new Container({ id: 'section-panel', hidden: true });
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'keydown'].forEach((name) => {
            panel.dom.addEventListener(name, e => e.stopPropagation());
        });
        canvasContainer.append(panel);
        panel.append(new Label({ text: 'SCHNITT', class: 'section-title' }));

        const row = (text: string, title?: string) => {
            const r = new Container({ class: 'section-row' });
            if (title) r.dom.title = title;
            r.append(new Label({ text, class: 'section-label' }));
            panel.append(r);
            return r;
        };
        const button = (parent: Container, text: string, title: string, onClick: () => void) => {
            const b = document.createElement('span');
            b.classList.add('section-button');
            b.textContent = text;
            b.title = title;
            b.addEventListener('click', onClick);
            parent.dom.appendChild(b);
            return b;
        };
        const segmented = (parent: Container, options: [string, string][], pick: (v: string) => void) => {
            const buttons = options.map(([v, t]) => {
                const b = button(parent, t, '', () => pick(v));
                b.classList.add('section-segment');
                b.dataset.value = v;
                return b;
            });
            return (value: string) => buttons.forEach(b => b.classList.toggle('active', b.dataset.value === value));
        };

        let syncing = false;

        const cutRow = row('Schnitt', '0 % = nichts abgeschnitten, 100 % = bis zur Grundriss-Höhe über dem Boden');
        const cutSlider = new SliderInput({ min: 0, max: 100, sliderMin: 0, sliderMax: 100, precision: 0, step: 1, value: 0 });
        cutSlider.on('change', (v: number) => !syncing && events.fire('section.set', { value: v / 100 }));
        cutRow.append(cutSlider);

        const heightRow = row('Höhe (m)', 'Absolute Schnitthöhe entlang der Achse, gekoppelt an den Regler');
        const heightInput = new NumericInput({ precision: 2, step: 0.05, value: 0, class: 'section-number' });
        heightInput.on('change', (v: number) => !syncing && events.fire('section.set', { value: Math.max(0, valueFor(v)) }));
        heightRow.append(heightInput);
        const extentLabel = new Label({ text: '', class: 'section-hint' });
        heightRow.append(extentLabel);

        const floorRow = row('Grundriss', 'Was von den Wänden bei 100 % stehen bleibt (über dem Boden)');
        const floorPlan = new NumericInput({ min: 0, precision: 2, step: 0.05, value: state.floorPlanHeight, class: 'section-number' });
        floorPlan.on('change', (v: number) => !syncing && events.fire('section.set', { floorPlanHeight: v }));
        floorRow.append(floorPlan);
        const pickButton = button(floorRow, 'Boden picken', 'Nächster Klick in den Viewport setzt die Bodenhöhe', () => {
            picking = !picking;
            events.fire('section.picking', picking);
        });
        events.on('section.picking', (on: boolean) => pickButton.classList.toggle('active', on));

        const syncAxis = segmented(row('Achse', 'Welt-Y oder die Hochachse des aktiven Layers (folgt dem Orient-Werkzeug)'), [['world', 'Welt Y'], ['layer', 'Layer']], v => events.fire('section.set', { axisMode: v as SectionState['axisMode'] }));
        const syncScope = segmented(row('Wirkt auf'), [['all', 'Alle sichtbaren'], ['active', 'Aktiven Layer']], v => events.fire('section.set', { scope: v as SectionState['scope'] }));

        const edgeRow = row('Kante', 'Weich: die letzten cm blenden aus; hart: scharfer Schnitt');
        const syncEdge = segmented(edgeRow, [['soft', 'Weich'], ['hard', 'Hart']], v => events.fire('section.set', { edge: v === 'soft' ? 0.05 : 0 }));
        const planeRow = row('Ebene zeigen', 'Schnittebene als Gitter (nur im Editor)');
        const planeToggle = new BooleanInput({ value: true });
        planeToggle.on('change', (v: boolean) => !syncing && events.fire('section.set', { showPlane: v }));
        planeRow.append(planeToggle);

        const actions = new Container({ class: 'section-row' });
        panel.append(actions);
        button(actions, '◆ Key', 'Schnitt-Wert am aktuellen Frame als Key speichern', () => events.fire('section.addKey'));
        button(actions, 'Neu messen', 'Ober- und Unterkante aus den sichtbaren Splats neu bestimmen', () => measure());
        const message = new Label({ text: '', class: 'section-message' });
        button(actions, 'Abgeschnittenes selektieren', 'Abgeschnittene Splats des aktiven Layers auswählen (dann Entf)', async () => {
            const n = await events.invoke('section.selectCut');
            message.text = `${n} Splats ausgewählt`;
        });
        panel.append(message);

        const sync = () => {
            syncing = true;
            cutSlider.value = Math.round(state.value * 100);
            heightInput.value = heightFor(state.value);
            floorPlan.value = state.floorPlanHeight;
            extentLabel.text = measured ? `${state.bottom.toFixed(2)} … ${state.top.toFixed(2)}` : '';
            syncAxis(state.axisMode);
            syncScope(state.scope);
            syncEdge(state.edge > 0 ? 'soft' : 'hard');
            planeToggle.value = state.showPlane;
            syncing = false;
        };
        events.on('section.changed', sync);
        sync();

        this.activate = () => {
            active = true;
            panel.hidden = false;
            if (!measured) measure();
            changed();
        };

        this.deactivate = () => {
            active = false;
            picking = false;
            panel.hidden = true;
            events.fire('section.picking', false);
            scene.forceRender = true;
        };
    }
}

export { SectionTool, SectionTrack, SectionState };
