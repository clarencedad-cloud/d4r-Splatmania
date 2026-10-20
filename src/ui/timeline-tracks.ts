import { Container } from '@playcanvas/pcui';

import type { CutSegment, ShotCamera } from '../camera-poses';
import { Events } from '../events';
import { TRANSITION_LABELS, type LayerState } from '../layer-anim';
import type { Splat } from '../splat';

// must match the Ticks strip in timeline-panel.ts so frames line up
const PADDING = 20;

const rgb = (c: number[], a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

// per-camera key rows and the cut track row, below the timeline ruler
class TimelineTracks extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'timeline-tracks'
        };

        super(args);

        const numFrames = () => events.invoke('timeline.frames') as number;
        const width = () => this.dom.getBoundingClientRect().width - PADDING * 2;
        const offsetFromFrame = (frame: number) => PADDING + Math.floor(frame / Math.max(1, numFrames() - 1) * width());
        const frameFromOffset = (offset: number) => {
            return Math.max(0, Math.min(numFrames() - 1, Math.round((offset - PADDING) / width() * (numFrames() - 1))));
        };

        const cursors: HTMLElement[] = [];
        const lastLayerClick: { splat: Splat | null, time: number } = { splat: null, time: 0 };

        // a drag holds pointer capture on an element a rebuild would destroy
        // (selecting a camera rebuilds), so rebuilds wait for the drag to end
        const drag = { busy: false, pending: false };
        let rebuild: () => void = null;
        const endDrag = () => {
            drag.busy = false;
            if (drag.pending) {
                drag.pending = false;
                rebuild();
            }
        };

        const addCursor = (row: HTMLElement) => {
            const cursor = document.createElement('div');
            cursor.classList.add('track-cursor');
            cursor.style.left = `${offsetFromFrame(events.invoke('timeline.frame'))}px`;
            row.appendChild(cursor);
            cursors.push(cursor);
        };

        rebuild = () => {
            this.dom.innerHTML = '';
            cursors.length = 0;

            const cameras = events.invoke('shotCameras.list') as ShotCamera[] ?? [];
            const selected = events.invoke('shotCameras.selected') as ShotCamera;
            const keyTarget = events.invoke('track.target') as { kind: string } | undefined;
            const frames = numFrames();

            // camera rows

            for (const camera of cameras) {
                const row = document.createElement('div');
                row.classList.add('track-row', 'camera-track');
                if (camera === selected) row.classList.add('selected');
                if (keyTarget?.kind === 'camera' && camera === selected) row.classList.add('key-target');

                const label = document.createElement('div');
                label.classList.add('track-label');
                label.textContent = camera.name;
                label.style.color = rgb(camera.color);
                row.appendChild(label);

                for (const key of camera.track.keys) {
                    if (key >= frames) continue;
                    const marker = document.createElement('div');
                    marker.classList.add('track-key');
                    marker.style.left = `${offsetFromFrame(key)}px`;
                    marker.style.backgroundColor = rgb(camera.color);
                    marker.title = `${camera.name}: Key bei Frame ${key} (ziehen = verschieben)`;
                    row.appendChild(marker);

                    // drag a key to move it on this camera's track
                    let dragging = false;
                    let toFrame = key;
                    marker.addEventListener('pointerdown', (event) => {
                        if (!event.isPrimary) return;
                        event.stopPropagation();
                        dragging = true;
                        drag.busy = true;
                        toFrame = key;
                        marker.setPointerCapture(event.pointerId);
                        events.fire('shotCameras.select', camera.id);
                    });
                    marker.addEventListener('pointermove', (event) => {
                        if (!dragging) return;
                        const rowRect = row.getBoundingClientRect();
                        toFrame = frameFromOffset(event.clientX - rowRect.left);
                        marker.style.left = `${offsetFromFrame(toFrame)}px`;
                    });
                    marker.addEventListener('pointerup', (event) => {
                        if (!dragging) return;
                        dragging = false;
                        marker.releasePointerCapture(event.pointerId);
                        endDrag();
                        if (toFrame !== key) {
                            events.fire('track.moveKey', key, toFrame);
                        } else {
                            events.fire('timeline.setFrame', key);
                        }
                    });
                }

                // click on the row: select the camera and scrub there
                row.addEventListener('pointerdown', (event) => {
                    if (!event.isPrimary) return;
                    events.fire('shotCameras.select', camera.id);
                    events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
                });

                addCursor(row);
                this.dom.appendChild(row);
            }

            // cut row

            const cutRow = document.createElement('div');
            cutRow.classList.add('track-row', 'cut-track');
            cutRow.title = 'Schnittspur: ziehen = Bereich der gewählten Kamera zuweisen, Klick = Schnitt ab hier, Rechtsklick = Segment löschen';

            const cutLabel = document.createElement('div');
            cutLabel.classList.add('track-label');
            cutLabel.textContent = 'Schnitt';
            cutRow.appendChild(cutLabel);

            const segments = events.invoke('cut.segments') as CutSegment[] ?? [];
            for (const segment of segments) {
                const camera = events.invoke('shotCameras.byId', segment.cameraId) as ShotCamera;
                if (!camera) continue;
                const block = document.createElement('div');
                block.classList.add('cut-segment');
                const x0 = offsetFromFrame(segment.start);
                const x1 = offsetFromFrame(Math.min(segment.end, frames - 1));
                block.style.left = `${x0}px`;
                block.style.width = `${Math.max(2, x1 - x0)}px`;
                block.style.backgroundColor = rgb(camera.color, 0.55);
                block.style.borderColor = rgb(camera.color);
                block.textContent = camera.name;
                block.title = `Frame ${segment.start}–${segment.end - 1} → ${camera.name}`;
                cutRow.appendChild(block);
            }

            const preview = document.createElement('div');
            preview.classList.add('cut-segment', 'preview');
            preview.style.display = 'none';
            cutRow.appendChild(preview);

            let dragStart = -1;
            let dragEnd = -1;

            const localFrame = (event: PointerEvent) => frameFromOffset(event.clientX - cutRow.getBoundingClientRect().left);

            cutRow.addEventListener('pointerdown', (event) => {
                if (!event.isPrimary || event.button !== 0) return;
                dragStart = dragEnd = localFrame(event);
                drag.busy = true;
                cutRow.setPointerCapture(event.pointerId);
                const color = (events.invoke('shotCameras.selected') as ShotCamera)?.color ?? [255, 255, 255];
                preview.style.backgroundColor = rgb(color, 0.35);
                preview.style.borderColor = rgb(color);
            });

            cutRow.addEventListener('pointermove', (event) => {
                if (dragStart < 0) return;
                dragEnd = localFrame(event);
                const a = Math.min(dragStart, dragEnd);
                const b = Math.max(dragStart, dragEnd);
                preview.style.display = b > a ? '' : 'none';
                preview.style.left = `${offsetFromFrame(a)}px`;
                preview.style.width = `${offsetFromFrame(b) - offsetFromFrame(a)}px`;
            });

            cutRow.addEventListener('pointerup', (event) => {
                if (dragStart < 0) return;
                cutRow.releasePointerCapture(event.pointerId);
                const a = Math.min(dragStart, dragEnd);
                const b = Math.max(dragStart, dragEnd);
                dragStart = -1;
                preview.style.display = 'none';
                endDrag();
                if (b > a) {
                    // dragged: exactly that range (inclusive of the end frame)
                    events.fire('cut.set', a, b + 1);
                } else {
                    // click: cut to the selected camera from here up to the
                    // next cut (or the end of the timeline)
                    const current = segments.find(s => a >= s.start && a < s.end);
                    const next = segments.find(s => s.start > a);
                    const end = current ? current.end : (next ? next.start : numFrames());
                    events.fire('cut.set', a, end);
                }
            });

            cutRow.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                events.fire('cut.removeAt', frameFromOffset(event.clientX - cutRow.getBoundingClientRect().left));
            });

            addCursor(cutRow);
            this.dom.appendChild(cutRow);

            // section cut track (src/section/section-tool.ts): click selects
            // it as the key target; keys show their cut value
            const sectionTrack = events.functions.has('section.track') ? events.invoke('section.track') : null;
            if (sectionTrack) {
                const sectionRow = document.createElement('div');
                sectionRow.classList.add('track-row', 'section-track');
                if (keyTarget?.kind === 'section') sectionRow.classList.add('key-target');
                sectionRow.title = 'Schnitt-Spur: Klick = Key-Ziel, Keys im Lineal verschieben bzw. löschen';
                const sectionLabel = document.createElement('div');
                sectionLabel.classList.add('track-label');
                sectionLabel.textContent = 'Schnitt';
                sectionRow.appendChild(sectionLabel);
                for (const key of sectionTrack.keyData) {
                    if (key.frame >= frames) continue;
                    const marker = document.createElement('div');
                    marker.classList.add('track-key');
                    marker.style.left = `${offsetFromFrame(key.frame)}px`;
                    marker.style.backgroundColor = `rgba(194, 14, 126, ${0.35 + 0.65 * key.value})`;
                    marker.title = `Frame ${key.frame}: Schnitt ${Math.round(key.value * 100)} %`;
                    sectionRow.appendChild(marker);
                }
                sectionRow.addEventListener('pointerdown', (event) => {
                    if (!event.isPrimary || event.button !== 0) return;
                    events.fire('section.selectTrack');
                    events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
                });
                addCursor(sectionRow);
                this.dom.appendChild(sectionRow);
            }

            // layer rows (src/layer-anim.ts): double-click adds a key with
            // every channel, drag moves a key, right-click deletes it

            const layers = events.invoke('layerAnim.layers') as Splat[] ?? [];
            const selectedLayer = (events.functions.has('selection') ? events.invoke('selection') : null) as Splat;
            for (const splat of layers) {
                const state = events.invoke('layerAnim.state', splat) as LayerState;
                const row = document.createElement('div');
                row.classList.add('track-row', 'layer-track');
                if (splat === selectedLayer) row.classList.add('selected');
                if (keyTarget?.kind === 'layer' && splat === selectedLayer) row.classList.add('key-target');
                row.title = `${splat.name}: Doppelklick = Key setzen, Key ziehen = verschieben, Rechtsklick auf Key = löschen`;

                const label = document.createElement('div');
                label.classList.add('track-label');
                label.textContent = `▤ ${splat.name}`;
                row.appendChild(label);

                for (const key of state.track.keyData) {
                    if (key.frame >= frames) continue;
                    const marker = document.createElement('div');
                    marker.classList.add('track-key', 'layer-key');
                    // fill shows the key's opacity, so fades read at a glance
                    const o = key.opacity ?? 1;
                    marker.style.backgroundColor = `rgba(230, 230, 230, ${0.25 + 0.75 * o})`;
                    if (key.opacity === undefined) marker.classList.add('transform-only');
                    marker.style.left = `${offsetFromFrame(key.frame)}px`;
                    marker.title = `Frame ${key.frame}${key.opacity !== undefined ? `, Deckkraft ${o.toFixed(2)}` : ''}${key.mix !== undefined ? `, Punkt-Mix ${key.mix.toFixed(2)}` : ''}${key.position ? ', Transform' : ''}`;
                    row.appendChild(marker);

                    let dragging = false;
                    let toFrame = key.frame;
                    const fromFrame = key.frame;
                    marker.addEventListener('pointerdown', (event) => {
                        if (!event.isPrimary || event.button !== 0) return;
                        event.stopPropagation();
                        dragging = true;
                        drag.busy = true;
                        toFrame = fromFrame;
                        marker.setPointerCapture(event.pointerId);
                        events.fire('selection', splat);
                    });
                    marker.addEventListener('pointermove', (event) => {
                        if (!dragging) return;
                        toFrame = frameFromOffset(event.clientX - row.getBoundingClientRect().left);
                        marker.style.left = `${offsetFromFrame(toFrame)}px`;
                    });
                    marker.addEventListener('pointerup', (event) => {
                        if (!dragging) return;
                        dragging = false;
                        marker.releasePointerCapture(event.pointerId);
                        endDrag();
                        if (toFrame !== fromFrame) {
                            events.fire('layerAnim.moveKey', splat, fromFrame, toFrame);
                        } else {
                            events.fire('timeline.setFrame', fromFrame);
                        }
                    });
                    marker.addEventListener('contextmenu', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        events.fire('layerAnim.removeKey', splat, fromFrame);
                    });
                }

                // the first click may select the layer, which rebuilds the
                // rows, so a native dblclick never sees both clicks: detect
                // the double click across rebuilds instead
                // transition blocks: drag the body to move, the ends to resize,
                // right-click to delete
                const selectedTransition = events.invoke('layerAnim.selectedTransition');
                for (const tr of state.track.transitions) {
                    const block = document.createElement('div');
                    block.classList.add('transition-block', tr.kind);
                    if (selectedTransition?.id === tr.id && splat === selectedLayer) block.classList.add('selected');
                    const place = (start: number, duration: number) => {
                        const x0 = offsetFromFrame(Math.min(start, frames - 1));
                        const x1 = offsetFromFrame(Math.min(start + duration, frames - 1));
                        block.style.left = `${x0}px`;
                        block.style.width = `${Math.max(6, x1 - x0)}px`;
                    };
                    place(tr.start, tr.duration);
                    block.textContent = `${tr.kind === 'in' ? '▲' : '▼'} ${TRANSITION_LABELS[tr.effect]}`;
                    block.title = `${tr.kind === 'in' ? 'In' : 'Out'}-Transition ${TRANSITION_LABELS[tr.effect]}: Frame ${tr.start}–${tr.start + tr.duration} (ziehen = verschieben, Enden = Länge, Rechtsklick = löschen)`;
                    row.appendChild(block);

                    let mode: 'move' | 'start' | 'end' | null = null;
                    let downFrame = 0;
                    let start = tr.start;
                    let duration = tr.duration;
                    const localFrame = (e: PointerEvent) => frameFromOffset(e.clientX - row.getBoundingClientRect().left);

                    block.addEventListener('pointerdown', (event) => {
                        if (!event.isPrimary || event.button !== 0) return;
                        event.stopPropagation();
                        const width = block.getBoundingClientRect().width;
                        mode = event.offsetX < 6 ? 'start' : event.offsetX > width - 6 ? 'end' : 'move';
                        downFrame = localFrame(event);
                        start = tr.start;
                        duration = tr.duration;
                        drag.busy = true;
                        block.setPointerCapture(event.pointerId);
                        events.fire('selection', splat);
                        events.fire('layerAnim.selectTransition', tr.id);
                    });
                    block.addEventListener('pointermove', (event) => {
                        if (!mode) return;
                        const frame = localFrame(event);
                        const end = tr.start + tr.duration;
                        if (mode === 'move') {
                            start = Math.max(0, tr.start + frame - downFrame);
                            duration = tr.duration;
                        } else if (mode === 'end') {
                            start = tr.start;
                            duration = Math.max(1, frame - tr.start);
                        } else {
                            start = Math.min(frame, end - 1);
                            duration = end - start;
                        }
                        place(start, duration);
                    });
                    block.addEventListener('pointerup', (event) => {
                        if (!mode) return;
                        mode = null;
                        block.releasePointerCapture(event.pointerId);
                        endDrag();
                        if (start !== tr.start || duration !== tr.duration) {
                            events.fire('layerAnim.updateTransition', splat, tr.id, { start, duration });
                        }
                    });
                    block.addEventListener('contextmenu', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        events.fire('layerAnim.removeTransition', splat, tr.id);
                    });
                }

                // shift+drag on the row creates an In transition over the
                // dragged range (shift+alt: Out)
                let create: { from: number, to: number, kind: 'in' | 'out', preview: HTMLElement } | null = null;
                row.addEventListener('pointermove', (event) => {
                    if (!create) return;
                    create.to = frameFromOffset(event.clientX - row.getBoundingClientRect().left);
                    const a = Math.min(create.from, create.to);
                    const b = Math.max(create.from, create.to);
                    create.preview.style.left = `${offsetFromFrame(a)}px`;
                    create.preview.style.width = `${Math.max(6, offsetFromFrame(b) - offsetFromFrame(a))}px`;
                });
                row.addEventListener('pointerup', (event) => {
                    if (!create) return;
                    row.releasePointerCapture(event.pointerId);
                    const a = Math.min(create.from, create.to);
                    const b = Math.max(create.from, create.to);
                    const kind = create.kind;
                    create.preview.remove();
                    create = null;
                    endDrag();
                    events.fire('selection', splat);
                    events.fire('layerAnim.addTransition', splat, kind, a, Math.max(1, b - a));
                });

                row.addEventListener('pointerdown', (event) => {
                    if (!event.isPrimary || event.button !== 0) return;
                    if (event.shiftKey) {
                        const from = frameFromOffset(event.offsetX);
                        const preview = document.createElement('div');
                        preview.classList.add('transition-block', 'preview', event.altKey ? 'out' : 'in');
                        preview.style.left = `${offsetFromFrame(from)}px`;
                        preview.style.width = '6px';
                        row.appendChild(preview);
                        create = { from, to: from, kind: event.altKey ? 'out' : 'in', preview };
                        drag.busy = true;
                        row.setPointerCapture(event.pointerId);
                        return;
                    }
                    const frame = frameFromOffset(event.offsetX);
                    const now = performance.now();
                    if (lastLayerClick.splat === splat && now - lastLayerClick.time < 400) {
                        lastLayerClick.splat = null;
                        events.fire('layerAnim.addKey', splat, frame);
                        return;
                    }
                    lastLayerClick.splat = splat;
                    lastLayerClick.time = now;
                    events.fire('selection', splat);
                    events.fire('timeline.setFrame', frame);
                });
                row.addEventListener('contextmenu', event => event.preventDefault());

                addCursor(row);
                this.dom.appendChild(row);

                // blocks starting under the layer name get their own label
                // moved to the right of it (measured now the row is in the dom)
                const labelRight = label.offsetLeft + label.offsetWidth;
                row.querySelectorAll<HTMLElement>('.transition-block').forEach((block) => {
                    const left = block.offsetLeft;
                    if (left < labelRight) {
                        block.style.paddingLeft = `${labelRight - left + 6}px`;
                    }
                });
            }
        };

        const moveCursors = (frame: number) => {
            const x = `${offsetFromFrame(frame)}px`;
            cursors.forEach((c) => {
                c.style.left = x;
            });
        };

        const requestRebuild = () => {
            if (drag.busy) {
                drag.pending = true;
            } else {
                rebuild();
            }
        };

        new ResizeObserver(() => requestRebuild()).observe(this.dom);

        [
            'shotCameras.changed', 'cut.changed', 'timeline.frames',
            'track.keyAdded', 'track.keyRemoved', 'track.keyMoved', 'track.keyUpdated',
            'track.keysLoaded', 'track.keysCleared',
            'layerAnim.trackChanged', 'layerAnim.transitionSelected', 'track.target', 'section.trackChanged', 'scene.elementAdded', 'scene.elementRemoved', 'selection.changed', 'splat.name'
        ].forEach(name => events.on(name, requestRebuild));

        events.on('timeline.frame', moveCursors);
    }
}

export { TimelineTracks };
