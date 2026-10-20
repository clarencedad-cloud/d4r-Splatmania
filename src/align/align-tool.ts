import { BooleanInput, Container, Label, SliderInput } from '@playcanvas/pcui';
import { Mat4, Quat, Vec3 } from 'playcanvas';

import type { IcpResult } from './icp';
import { alignPoints, type AlignResult } from './point-align';
import { abortAnalysis, AbortedError, runAnalysis } from '../analysis/analysis-client';
import { readLayerData } from '../analysis/splat-data';
import { AnimTrackEditOp, EntityTransformOp, MultiOp } from '../edit-ops';
import { ElementType } from '../element';
import { Events } from '../events';
import type { LayerAnimTrack } from '../layer-anim';
import type { Scene } from '../scene';
import type { Splat } from '../splat';
import { Transform } from '../transform';

// Anchor-point alignment of splat layers (Splatterline style). One layer is
// the reference and stays put. On every other layer, anchor n pairs with
// anchor n of the reference; Align solves a similarity transform per layer
// (src/align/point-align.ts) and applies it to the layer transform as one
// undo step. Anchors live in layer-local coordinates, so they move with the
// layer and line up after the align.

const COLORS = ['#c20e7e', '#00dcff', '#78ff5a', '#5aa9e6', '#fff050', '#94a3b8'];

const CLICK_TOLERANCE = 4;

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
        // search radius for the fine alignment (0 = automatic)
        let searchRadius = 0;
        let reference: Splat | null = null;
        let useScale = true;
        let active = false;
        let message = '';

        const splats = () => (scene.getElementsByType(ElementType.splat) as Splat[]);
        const ref = () => (reference && reference.scene ? reference : splats()[0] ?? null);
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

        panel.append(new Label({ text: 'AUSRICHTEN (Ankerpunkte)', class: 'align-title' }));
        panel.append(new Label({ text: 'Aktiven Layer im Szenen-Manager wählen und auf seine Oberfläche klicken. Punkt n gehört zu Punkt n der Referenz. Ziehen = verschieben, Rechtsklick = löschen.', class: 'align-help' }));
        const layerList = new Container({ class: 'align-layers' });
        panel.append(layerList);

        const scaleRow = new Container({ class: 'align-row' });
        scaleRow.append(new Label({ text: 'Skalierung mitrechnen', class: 'align-label' }));
        const scaleInput = new BooleanInput({ value: true });
        scaleInput.on('change', (v: boolean) => {
            useScale = v;
        });
        scaleRow.append(scaleInput);
        panel.append(scaleRow);

        const buttons = new Container({ class: 'align-row' });
        panel.append(buttons);
        const button = (text: string, title: string, onClick: () => void) => {
            const b = document.createElement('span');
            b.classList.add('align-button');
            b.textContent = text;
            b.title = title;
            b.addEventListener('click', onClick);
            buttons.dom.appendChild(b);
        };
        button('Align', 'Alle Layer mit mindestens 3 Punktpaaren auf die Referenz ausrichten', () => events.invoke('align.run'));
        button('Punkte löschen', 'Alle Ankerpunkte des aktiven Layers löschen', () => {
            const splat = events.invoke('selection') as Splat;
            if (splat && anchorsOf(splat).length) editAnchors(splat, list => list.splice(0));
        });

        // fine alignment ("Präzisieren"): robust ICP on the splat centres
        const refineRow = new Container({ class: 'align-row' });
        panel.append(refineRow);
        refineRow.append(new Label({ text: 'Suchradius', class: 'align-label' }));
        const radiusSlider = new SliderInput({ min: 0, max: 2, sliderMin: 0, sliderMax: 0.5, precision: 3, step: 0.005, value: 0 });
        radiusSlider.dom.title = 'Größte erwartete Restabweichung nach den Ankerpunkten (Welteinheiten). 0 = automatisch';
        // 0 means automatic (overlap diagonal / 50, decided by the core)
        const radiusHint = new Label({ text: 'auto', class: 'align-radius-hint' });
        radiusSlider.on('change', (v: number) => {
            searchRadius = v;
            radiusHint.text = v > 0 ? '' : 'auto';
        });
        refineRow.append(radiusSlider);
        refineRow.append(radiusHint);
        const refineButtons = new Container({ class: 'align-row' });
        panel.append(refineButtons);
        const refineButton = document.createElement('span');
        refineButton.classList.add('align-button', 'align-refine');
        refineButton.textContent = 'Präzisieren';
        refineButton.title = 'Feinausrichtung per ICP auf den Splat-Mitten (nach der Ankerpunkt-Ausrichtung)';
        refineButton.addEventListener('click', () => events.invoke('align.refine'));
        refineButtons.dom.appendChild(refineButton);

        const messageLabel = new Label({ text: '', class: 'align-message' });
        panel.append(messageLabel);

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
                radio.title = 'Referenz (bleibt fest)';
                radio.addEventListener('change', () => {
                    events.fire('align.setReference', splat);
                });
                const swatch = document.createElement('span');
                swatch.classList.add('align-swatch');
                swatch.style.backgroundColor = colorOf(splat);
                const name = document.createElement('span');
                name.classList.add('align-name');
                name.textContent = `${splat.name}${splat === reference ? ' (Referenz)' : ''}`;
                name.addEventListener('click', () => events.fire('selection', splat));
                const info = document.createElement('span');
                info.classList.add('align-info');
                const result = results.get(splat);
                const count = anchorsOf(splat).length;
                const fine = refined.get(splat);
                info.textContent = typeof fine === 'object' ?
                    `Median ${fine.before.median.toFixed(4)} → ${fine.after.median.toFixed(4)} · Überlappung ${(fine.after.overlap * 100).toFixed(0)} %` :
                    typeof result === 'object' ?
                        `${count} Pkt · RMS ${result.rms.toFixed(3)} · ${result.residuals.map(r => r.toFixed(3)).join(' / ')}` :
                        `${count} Pkt`;
                row.append(radio, swatch, name, info);
                layerList.dom.appendChild(row);
            }
            messageLabel.text = message;
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

        events.on('postrender', updateMarkers);

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
                message = 'Kein Treffer auf dem aktiven Layer.';
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
        const correctionOps = (splat: Splat, m: Mat4, r: Quat, scaleFactor: number) => {
            const ops: any[] = [];
            const parent = splat.entity.parent;
            const parentInv = new Mat4().copy(parent.getWorldTransform()).invert();
            const parentRotInv = parent.getRotation().clone().invert();

            const entity = splat.entity;
            const oldt = new Transform(entity.getLocalPosition().clone(), entity.getLocalRotation().clone(), entity.getLocalScale().clone());
            const position = parentInv.transformPoint(m.transformPoint(entity.getPosition(), new Vec3()), new Vec3());
            const rotation = new Quat().mul2(parentRotInv, new Quat().mul2(r, entity.getRotation()));
            const scale = oldt.scale.clone().mulScalar(scaleFactor);
            ops.push(new EntityTransformOp({ splat, oldt, newt: new Transform(position, rotation, scale) }));

            const track = events.invoke('layerAnim.state', splat)?.track as LayerAnimTrack;
            if (track && track.keyData.some(k => k.position || k.rotation || k.scale)) {
                const before = track.snapshot();
                const after = track.snapshot();
                for (const key of after.keys) {
                    if (key.position) {
                        const world = parent.getWorldTransform().transformPoint(key.position, new Vec3());
                        key.position = parentInv.transformPoint(m.transformPoint(world, new Vec3()), new Vec3());
                    }
                    if (key.rotation) {
                        const world = new Quat().mul2(parent.getRotation(), key.rotation);
                        key.rotation = new Quat().mul2(parentRotInv, new Quat().mul2(r, world));
                    }
                    if (key.scale) key.scale = key.scale.clone().mulScalar(scaleFactor);
                }
                ops.push(new AnimTrackEditOp('alignKeys', track, before, after));
            }
            return ops;
        };

        // align

        const run = () => {
            const reference = ref();
            message = '';
            if (!reference) {
                message = 'Kein Layer vorhanden.';
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
                    results.set(splat, `mindestens 3 Punktpaare nötig (${n})`);
                    message = `${splat.name}: mindestens 3 Punktpaare nötig (vorhanden: ${n}).`;
                    continue;
                }
                const src = anchorsOf(splat).slice(0, n).map(p => toWorld(splat, p));
                let result: AlignResult;
                try {
                    result = alignPoints(src, dst.slice(0, n), { scale: useScale });
                } catch (error) {
                    const text = `${(error as Error).message ?? error}`;
                    results.set(splat, text);
                    message = `${splat.name}: ${text.includes('triangle') ? 'Punkte liegen auf einer Linie oder aufeinander – bitte als Dreieck verteilen.' : text}`;
                    continue;
                }

                const m = new Mat4();
                m.data.set(result.matrix);
                const r = new Quat(result.rotation[0], result.rotation[1], result.rotation[2], result.rotation[3]);
                ops.push(...correctionOps(splat, m, r, result.scale));

                results.set(splat, result);
                refined.delete(splat);
                summary[splat.name] = { rms: result.rms, residuals: result.residuals, scale: result.scale, rotation: result.rotation, translation: result.translation };
            }
            if (ops.length) {
                events.fire('edit.add', new MultiOp(ops));
            } else if (!message) {
                message = 'Keine Layer mit Ankerpunkten zum Ausrichten.';
            }
            rebuildPanel();
            return summary;
        };

        // fine alignment of every visible non-reference layer onto the
        // reference, in the analysis worker
        const MAX_POINTS = 500000;
        let refining = false;

        const refine = async () => {
            const reference = ref();
            if (refining || !reference) return null;
            const moving = splats().filter(s => s !== reference && s.visible);
            if (moving.length === 0) {
                message = 'Kein weiterer sichtbarer Layer zum Präzisieren.';
                rebuildPanel();
                return null;
            }
            refining = true;
            message = '';
            const summary: Record<string, unknown> = {};
            events.fire('progressStart', 'Präzisieren', true);
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
                    const result = await runAnalysis<IcpResult>('icp', {
                        moving: data.positions,
                        reference: refData.positions,
                        options: { scale: useScale, maxError: searchRadius > 0 ? searchRadius : undefined }
                    }, [], (p) => {
                        events.fire('progressUpdate', { text: `Präzisieren: ${splat.name}`, progress: 100 * (base + p / moving.length) });
                    });
                    refined.set(splat, result);
                    summary[splat.name] = { before: result.before, after: result.after, improved: result.improved, angleDeg: result.angleDeg, scale: result.scale, translation: result.translation, iterations: result.iterations };
                    if (!result.improved) {
                        message = `${splat.name}: keine Verbesserung, nichts angewendet.`;
                        continue;
                    }
                    const m = new Mat4();
                    m.data.set(result.matrix);
                    // rotation from the correction's 3x3 part with the scale removed
                    const unscaled = new Mat4().copy(m);
                    const d = unscaled.data;
                    for (let i = 0; i < 3; i++) {
                        for (let j = 0; j < 3; j++) d[i * 4 + j] /= result.scale;
                    }
                    d[12] = d[13] = d[14] = 0;
                    const r = new Quat().setFromMat4(unscaled);
                    ops.push(...correctionOps(splat, m, r, result.scale));
                }
                if (ops.length) events.fire('edit.add', new MultiOp(ops));
            } catch (error) {
                if (error instanceof AbortedError) {
                    message = 'Präzisieren abgebrochen.';
                } else {
                    const text = `${(error as Error).message ?? error}`;
                    message = text.includes('do not overlap') ? 'Die Layer überlappen nicht – erst per Ankerpunkten grob ausrichten.' :
                        text.includes('too few points') ? 'Zu wenige Punkte im Überlappungsbereich.' : `Präzisieren fehlgeschlagen: ${text}`;
                }
            } finally {
                cancel.off();
                events.fire('progressEnd');
                refining = false;
                rebuildPanel();
            }
            return summary;
        };

        // api

        events.function('align.run', run);
        events.function('align.refine', refine);
        events.function('align.setSearchRadius', (v: number) => {
            searchRadius = v;
            radiusSlider.value = v;
        });
        events.function('align.anchors', (splat: Splat) => anchorsOf(splat).map(p => toWorld(splat, p)));
        events.function('align.reference', () => ref());
        events.on('align.setReference', (splat: Splat) => {
            reference = splat;
            results.clear();
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
