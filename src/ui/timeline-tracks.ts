import { Container } from '@playcanvas/pcui';

import type { CameraChannel, CutSegment, CutTrack, ShotCamera } from '../camera-poses';
import { AnimTrackEditOp } from '../edit-ops';
import { Events } from '../events';
import { TRANSITION_LABELS, type LayerChannel, type LayerState } from '../layer-anim';
import type { Splat } from '../splat';
import { createKeyButton, KeyState } from './key-button';
import { i18n } from './localization';

// must match the Ticks strip in timeline-panel.ts so frames line up
const PADDING = 20;

const rgb = (c: number[], a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

// channel rows of an expanded camera / layer
const CAMERA_ROWS: [CameraChannel, string][] = [
    ['position', 'sm.channel.position'],
    ['target', 'sm.channel.rotation'],
    ['fov', 'sm.channel.lens'],
    ['focus', 'sm.channel.focus'],
    ['aperture', 'sm.channel.aperture'],
    // gait bob and handheld shake: only listed for a camera that has them
    ['bob', 'sm.channel.bob'],
    ['stepRate', 'sm.channel.stepRate'],
    ['shake', 'sm.channel.shake'],
    ['shakeRate', 'sm.channel.shakeRate']
];
const MODIFIER_ROWS = new Set<CameraChannel>(['bob', 'stepRate', 'shake', 'shakeRate']);

const LAYER_ROWS: [LayerChannel, string][] = [
    ['position', 'sm.channel.position'],
    ['rotation', 'sm.channel.rotation'],
    ['scale', 'sm.channel.scale'],
    ['opacity', 'sm.channel.opacity'],
    ['mix', 'sm.channel.mix']
];

// which cameras / layers show their channel rows (kept across rebuilds)
const expandedCameras = new Set<number>();
const expandedLayers = new WeakSet<Splat>();

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
        const frameNow = () => Math.round(events.invoke('timeline.frame') ?? 0);

        const cursors: HTMLElement[] = [];
        // camera labels that light up while their camera is live in the cut
        let liveLabels: { el: HTMLElement, id: number }[] = [];
        const lastLayerClick: { splat: Splat | null, time: number } = { splat: null, time: 0 };

        // a drag holds pointer capture on an element a rebuild would destroy
        // (selecting a camera rebuilds), so rebuilds wait for the drag to end
        const drag = { busy: false, pending: false };
        let rebuild: () => void = null;
        let requestRebuild: () => void = null;
        let updateLive: (frame: number) => void = null;
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
            cursor.style.left = `${offsetFromFrame(frameNow())}px`;
            row.appendChild(cursor);
            cursors.push(cursor);
        };

        // a draggable key diamond: drag = move, click = jump there,
        // right-click = delete
        const addKeyMarker = (row: HTMLElement, frame: number, color: string, title: string,
            onMove: (from: number, to: number) => void, onRemove: (frame: number) => void, onPick?: () => void) => {
            const marker = document.createElement('div');
            marker.classList.add('track-key');
            marker.style.left = `${offsetFromFrame(frame)}px`;
            marker.style.backgroundColor = color;
            marker.title = title;
            row.appendChild(marker);

            let dragging = false;
            let toFrame = frame;
            marker.addEventListener('pointerdown', (event) => {
                if (!event.isPrimary || event.button !== 0) return;
                event.stopPropagation();
                dragging = true;
                drag.busy = true;
                toFrame = frame;
                marker.setPointerCapture(event.pointerId);
                onPick?.();
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
                if (toFrame !== frame) {
                    onMove(frame, toFrame);
                } else {
                    events.fire('timeline.setFrame', frame);
                }
            });
            marker.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(frame);
            });
            return marker;
        };

        // the ▸ / ▾ toggle in a row label
        const addExpander = (label: HTMLElement, expanded: boolean, toggle: () => void) => {
            const exp = document.createElement('span');
            exp.classList.add('track-expand');
            exp.textContent = expanded ? '▾' : '▸';
            i18n.bindDom(exp, 'sm.timeline.expand-tip', 'title');
            exp.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                toggle();
                requestRebuild();
            });
            label.prepend(exp);
        };

        // a channel row under an expanded camera / layer
        const channelRow = (name: string, keyButton: HTMLElement, onPointerDown: (event: PointerEvent) => void) => {
            const row = document.createElement('div');
            row.classList.add('track-row', 'channel-track');
            const label = document.createElement('div');
            label.classList.add('track-label');
            const text = document.createElement('span');
            text.textContent = name;
            label.append(keyButton, text);
            row.appendChild(label);
            row.addEventListener('pointerdown', (event) => {
                if (!event.isPrimary || event.button !== 0) return;
                onPointerDown(event);
            });
            row.addEventListener('contextmenu', event => event.preventDefault());
            return row;
        };

        // small context menu (cut segments)
        let menu: HTMLElement | null = null;
        const closeMenu = () => {
            menu?.remove();
            menu = null;
        };
        const openMenu = (x: number, y: number, items: { text: string, color?: number[], action: () => void }[]) => {
            closeMenu();
            menu = document.createElement('div');
            menu.classList.add('timeline-menu');
            items.forEach((item) => {
                const entry = document.createElement('div');
                entry.classList.add('timeline-menu-item');
                if (item.color) {
                    const swatch = document.createElement('span');
                    swatch.classList.add('timeline-menu-swatch');
                    swatch.style.backgroundColor = rgb(item.color);
                    entry.appendChild(swatch);
                }
                entry.appendChild(document.createTextNode(item.text));
                entry.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                    closeMenu();
                    item.action();
                });
                menu.appendChild(entry);
            });
            document.body.appendChild(menu);
            const rect = menu.getBoundingClientRect();
            menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
            menu.style.top = `${Math.max(4, y - rect.height)}px`;
        };
        window.addEventListener('pointerdown', closeMenu);
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMenu();
        }, { capture: true });

        rebuild = () => {
            this.dom.innerHTML = '';
            cursors.length = 0;
            liveLabels = [];

            const cameras = events.invoke('shotCameras.list') as ShotCamera[] ?? [];
            const selected = events.invoke('shotCameras.selected') as ShotCamera;
            const keyTarget = events.invoke('track.target') as { kind: string } | undefined;
            const frames = numFrames();
            const segments = events.invoke('cut.segments') as CutSegment[] ?? [];
            const cutTrack = events.invoke('cut.track') as CutTrack;

            // camera rows

            for (const camera of cameras) {
                const expanded = expandedCameras.has(camera.id);
                const row = document.createElement('div');
                row.classList.add('track-row', 'camera-track');
                if (camera === selected) row.classList.add('selected');
                if (keyTarget?.kind === 'camera' && camera === selected) row.classList.add('key-target');

                const label = document.createElement('div');
                label.classList.add('track-label');
                const name = document.createElement('span');
                name.textContent = camera.name;
                name.style.color = rgb(camera.color);
                label.appendChild(name);
                addExpander(label, expanded, () => {
                    if (expanded) expandedCameras.delete(camera.id);
                    else expandedCameras.add(camera.id);
                });

                // live in the cut at the playhead
                const live = document.createElement('span');
                live.classList.add('track-live');
                live.textContent = '●';
                i18n.bindDom(live, 'sm.timeline.live-tip', 'title');
                label.appendChild(live);
                liveLabels.push({ el: label, id: camera.id });

                // cut to this camera at the playhead (like a vision mixer)
                const cutHere = document.createElement('span');
                cutHere.classList.add('track-cut-here');
                cutHere.textContent = '✂';
                i18n.bindDom(cutHere, 'sm.timeline.cut-here-tip', 'title');
                cutHere.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                    events.fire('cut.cutTo', frameNow(), camera.id);
                });
                label.appendChild(cutHere);
                row.appendChild(label);

                for (const key of camera.track.keys) {
                    if (key >= frames) continue;
                    addKeyMarker(row, key, rgb(camera.color), i18n.t('sm.timeline.camera-key', { camera: camera.name, frame: key }),
                        (from, to) => events.fire('track.moveKey', from, to),
                        (frame) => {
                            events.fire('shotCameras.select', camera.id);
                            events.fire('track.removeKey', frame);
                        },
                        () => events.fire('shotCameras.select', camera.id));
                }

                // click on the row: select the camera and scrub there
                row.addEventListener('pointerdown', (event) => {
                    if (!event.isPrimary || event.button !== 0) return;
                    events.fire('shotCameras.select', camera.id);
                    events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
                });

                addCursor(row);
                this.dom.appendChild(row);

                if (expanded) {
                    for (const [channel, text] of CAMERA_ROWS) {
                        if (MODIFIER_ROWS.has(channel) && !camera.track.hasModifier) continue;
                        const button = createKeyButton(events,
                            () => events.invoke('shotCameras.channelState', channel, camera.id) as KeyState,
                            () => events.fire('shotCameras.keyChannel', channel, camera.id));
                        const sub = channelRow(i18n.t(text), button.dom, (event) => {
                            events.fire('shotCameras.select', camera.id);
                            events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
                        });
                        for (const key of camera.track.channelKeys(channel)) {
                            if (key >= frames) continue;
                            addKeyMarker(sub, key, rgb(camera.color), `${i18n.t(text)} · Frame ${key}`,
                                (from, to) => events.fire('shotCameras.moveChannelKey', camera.id, channel, from, to),
                                frame => events.fire('shotCameras.removeChannelKey', camera.id, channel, frame),
                                () => events.fire('shotCameras.select', camera.id));
                        }
                        addCursor(sub);
                        this.dom.appendChild(sub);
                    }
                }
            }

            // cut row: blocks are shots. Click a block = go there, drag its
            // edge = trim (a touching neighbour moves along), right-click =
            // switch camera / delete; drag in an empty area = new shot of the
            // selected camera

            const cutRow = document.createElement('div');
            cutRow.classList.add('track-row', 'cut-track');
            i18n.bindDom(cutRow, 'sm.timeline.cut-tip', 'title');

            const cutLabel = document.createElement('div');
            cutLabel.classList.add('track-label');
            cutLabel.textContent = i18n.t('sm.cameras.mode.cut');
            cutRow.appendChild(cutLabel);

            const localFrame = (event: PointerEvent) => frameFromOffset(event.clientX - cutRow.getBoundingClientRect().left);
            // the edge frame under the pointer while trimming: halfway
            // between frames snaps to the nearer one
            const edgeFrame = (event: PointerEvent) => {
                const x = event.clientX - cutRow.getBoundingClientRect().left;
                return Math.max(0, Math.min(frames, Math.round((x - PADDING) / width() * (frames - 1))));
            };

            for (const segment of segments) {
                const camera = events.invoke('shotCameras.byId', segment.cameraId) as ShotCamera;
                if (!camera) continue;
                const block = document.createElement('div');
                block.classList.add('cut-segment');
                const place = (start: number, end: number) => {
                    const x0 = offsetFromFrame(start);
                    const x1 = offsetFromFrame(Math.min(end, frames - 1));
                    block.style.left = `${x0}px`;
                    block.style.width = `${Math.max(4, x1 - x0)}px`;
                };
                place(segment.start, segment.end);
                block.style.backgroundColor = rgb(camera.color, 0.55);
                block.style.borderColor = rgb(camera.color);
                block.textContent = camera.name;
                block.title = `${i18n.t('sm.timeline.shot', { start: segment.start, end: segment.end - 1, camera: camera.name })}\n${i18n.t('sm.timeline.shot-tip')}`;
                // cross-fade: the previous camera's colour fading out
                const from = segment.fade && cutTrack.cutFrom(segment);
                const fromCamera = from ? events.invoke('shotCameras.byId', from) as ShotCamera : null;
                if (fromCamera) {
                    const w = offsetFromFrame(segment.start + segment.fade) - offsetFromFrame(segment.start);
                    block.style.backgroundImage = `linear-gradient(90deg, ${rgb(fromCamera.color, 0.8)} 0, transparent ${w}px)`;
                    block.title += ` · ${i18n.t('sm.timeline.fade-from', { camera: fromCamera.name, frames: segment.fade })}`;
                }
                cutRow.appendChild(block);

                const edgeAt = (event: PointerEvent): 'start' | 'end' | null => {
                    const r = block.getBoundingClientRect();
                    const x = event.clientX - r.left;
                    if (x < 6) return 'start';
                    if (x > r.width - 6) return 'end';
                    return null;
                };

                let trim: { edge: 'start' | 'end', to: number } | null = null;
                block.addEventListener('pointermove', (event) => {
                    if (trim) {
                        trim.to = edgeFrame(event);
                        if (trim.edge === 'end') place(segment.start, Math.max(segment.start + 1, trim.to));
                        else place(Math.min(segment.end - 1, trim.to), segment.end);
                        return;
                    }
                    block.style.cursor = edgeAt(event) ? 'ew-resize' : 'pointer';
                });
                block.addEventListener('pointerdown', (event) => {
                    if (!event.isPrimary || event.button !== 0) return;
                    event.stopPropagation();
                    const edge = edgeAt(event);
                    if (edge) {
                        trim = { edge, to: edge === 'end' ? segment.end : segment.start };
                        drag.busy = true;
                        block.setPointerCapture(event.pointerId);
                        return;
                    }
                    // a click selects the shot's camera and moves there
                    events.fire('shotCameras.select', camera.id);
                    events.fire('timeline.setFrame', localFrame(event));
                });
                block.addEventListener('pointerup', (event) => {
                    if (!trim) return;
                    const t = trim;
                    trim = null;
                    block.releasePointerCapture(event.pointerId);
                    endDrag();
                    events.fire('cut.trim', segment.start, t.edge, t.to);
                });
                block.addEventListener('contextmenu', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(event.clientX, event.clientY, [
                        ...cameras.filter(c => c.id !== segment.cameraId).map(c => ({
                            text: i18n.t('sm.timeline.switch-to', { camera: c.name }),
                            color: c.color,
                            action: () => events.fire('cut.setCamera', segment.start, c.id)
                        })),
                        { text: i18n.t('sm.timeline.delete-shot'), action: () => events.fire('cut.removeAt', segment.start) }
                    ]);
                });
            }

            const preview = document.createElement('div');
            preview.classList.add('cut-segment', 'preview');
            preview.style.display = 'none';
            cutRow.appendChild(preview);

            let dragStart = -1;
            let dragEnd = -1;

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
                    // click in an empty area: the selected camera from here
                    // up to the next shot
                    const camera = events.invoke('shotCameras.selected') as ShotCamera;
                    if (camera) events.fire('cut.cutTo', a, camera.id);
                }
            });

            cutRow.addEventListener('contextmenu', event => event.preventDefault());

            addCursor(cutRow);
            this.dom.appendChild(cutRow);

            // section cut track (src/section/section-tool.ts): click selects
            // it as the key target; keys show their cut value
            const sectionTrack = events.functions.has('section.track') ? events.invoke('section.track') : null;
            if (sectionTrack && sectionTrack.keys.length > 0) {
                const sectionRow = document.createElement('div');
                sectionRow.classList.add('track-row', 'section-track');
                if (keyTarget?.kind === 'section') sectionRow.classList.add('key-target');
                sectionRow.title = i18n.t('sm.timeline.section-tip');
                const sectionLabel = document.createElement('div');
                sectionLabel.classList.add('track-label');
                sectionLabel.textContent = i18n.t('sm.section.title');
                sectionRow.appendChild(sectionLabel);
                const sectionEdit = (name: string, fn: () => boolean) => {
                    const before = sectionTrack.snapshot();
                    if (fn()) events.fire('edit.add', new AnimTrackEditOp(name, sectionTrack, before, sectionTrack.snapshot()), true);
                };
                for (const key of sectionTrack.keyData) {
                    if (key.frame >= frames) continue;
                    addKeyMarker(sectionRow, key.frame, `rgba(194, 14, 126, ${0.35 + 0.65 * key.value})`,
                        i18n.t('sm.timeline.section-key', { frame: key.frame, value: Math.round(key.value * 100) }),
                        (from, to) => sectionEdit('sectionMoveKey', () => sectionTrack.moveKey(from, to)),
                        frame => sectionEdit('sectionRemoveKey', () => sectionTrack.removeKey(frame)),
                        () => events.fire('section.selectTrack'));
                }
                sectionRow.addEventListener('pointerdown', (event) => {
                    if (!event.isPrimary || event.button !== 0) return;
                    events.fire('section.selectTrack');
                    events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
                });
                addCursor(sectionRow);
                this.dom.appendChild(sectionRow);
            }

            // look track (src/look/look.ts): like the section track
            const lookTrack = events.functions.has('look.track') ? events.invoke('look.track') : null;
            if (lookTrack && lookTrack.keys.length > 0) {
                const lookRow = document.createElement('div');
                lookRow.classList.add('track-row', 'look-track');
                if (keyTarget?.kind === 'look') lookRow.classList.add('key-target');
                lookRow.title = i18n.t('sm.timeline.look-tip');
                const lookLabel = document.createElement('div');
                lookLabel.classList.add('track-label');
                lookLabel.textContent = i18n.t('sm.look.title');
                lookRow.appendChild(lookLabel);
                const lookEdit = (name: string, fn: () => boolean) => {
                    const before = lookTrack.snapshot();
                    if (fn()) events.fire('edit.add', new AnimTrackEditOp(name, lookTrack, before, lookTrack.snapshot()), true);
                };
                for (const key of lookTrack.keyData) {
                    if (key.frame >= frames) continue;
                    addKeyMarker(lookRow, key.frame, 'rgb(255, 184, 64)',
                        i18n.t('sm.timeline.look-key', { frame: key.frame }),
                        (from, to) => lookEdit('lookMoveKey', () => lookTrack.moveKey(from, to)),
                        frame => lookEdit('lookRemoveKey', () => lookTrack.removeKey(frame)),
                        () => events.fire('look.selectTrack'));
                }
                lookRow.addEventListener('pointerdown', (event) => {
                    if (!event.isPrimary || event.button !== 0) return;
                    events.fire('look.selectTrack');
                    events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
                });
                addCursor(lookRow);
                this.dom.appendChild(lookRow);
            }

            // light track (src/light/light.ts): like the look track
            const lightTrack = events.functions.has('light.track') ? events.invoke('light.track') : null;
            if (lightTrack && lightTrack.keys.length > 0) {
                const lightRow = document.createElement('div');
                lightRow.classList.add('track-row', 'look-track', 'light-track');
                if (keyTarget?.kind === 'light') lightRow.classList.add('key-target');
                lightRow.title = i18n.t('sm.timeline.light-tip');
                const lightLabel = document.createElement('div');
                lightLabel.classList.add('track-label');
                lightLabel.textContent = i18n.t('sm.light.title');
                lightRow.appendChild(lightLabel);
                const lightEdit = (name: string, fn: () => boolean) => {
                    const before = lightTrack.snapshot();
                    if (fn()) events.fire('edit.add', new AnimTrackEditOp(name, lightTrack, before, lightTrack.snapshot()), true);
                };
                for (const key of lightTrack.keyData) {
                    if (key.frame >= frames) continue;
                    addKeyMarker(lightRow, key.frame, 'rgb(255, 226, 120)',
                        i18n.t('sm.timeline.light-key', { frame: key.frame }),
                        (from, to) => lightEdit('lightMoveKey', () => lightTrack.moveKey(from, to)),
                        frame => lightEdit('lightRemoveKey', () => lightTrack.removeKey(frame)),
                        () => events.fire('light.selectTrack'));
                }
                lightRow.addEventListener('pointerdown', (event) => {
                    if (!event.isPrimary || event.button !== 0) return;
                    events.fire('light.selectTrack');
                    events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
                });
                addCursor(lightRow);
                this.dom.appendChild(lightRow);
            }

            // layer rows (src/layer-anim.ts): double-click adds a key, drag
            // moves a key, right-click deletes it; ▸ shows one row per
            // property

            const layers = events.invoke('layerAnim.layers') as Splat[] ?? [];
            const selectedLayer = (events.functions.has('selection') ? events.invoke('selection') : null) as Splat;
            for (const splat of layers) {
                const state = events.invoke('layerAnim.state', splat) as LayerState;
                const expanded = expandedLayers.has(splat);
                const row = document.createElement('div');
                row.classList.add('track-row', 'layer-track');
                if (splat === selectedLayer) row.classList.add('selected');
                if (keyTarget?.kind === 'layer' && splat === selectedLayer) row.classList.add('key-target');
                row.title = `${splat.name}: ${i18n.t('sm.timeline.layer-tip')}`;

                const label = document.createElement('div');
                label.classList.add('track-label');
                const name = document.createElement('span');
                name.textContent = `▤ ${splat.name}`;
                label.appendChild(name);
                addExpander(label, expanded, () => {
                    if (expanded) expandedLayers.delete(splat);
                    else expandedLayers.add(splat);
                });
                row.appendChild(label);

                for (const key of state.track.keyData) {
                    if (key.frame >= frames) continue;
                    const o = key.opacity ?? 1;
                    const channels = LAYER_ROWS.filter(([c]) => key[c] !== undefined).map(([, t]) => i18n.t(t)).join(', ');
                    const marker = addKeyMarker(row, key.frame, `rgba(230, 230, 230, ${0.25 + 0.75 * o})`, `Frame ${key.frame}: ${channels}`,
                        (from, to) => events.fire('layerAnim.moveKey', splat, from, to),
                        frame => events.fire('layerAnim.removeKey', splat, frame),
                        () => events.fire('selection', splat));
                    // fill shows the key's opacity, so fades read at a glance
                    marker.classList.add('layer-key');
                    if (key.opacity === undefined) marker.classList.add('transform-only');
                }

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
                    block.title = i18n.t('sm.timeline.transition-tip', { kind: tr.kind === 'in' ? 'In' : 'Out', effect: TRANSITION_LABELS[tr.effect], start: tr.start, end: tr.start + tr.duration });
                    row.appendChild(block);

                    let mode: 'move' | 'start' | 'end' | null = null;
                    let downFrame = 0;
                    let start = tr.start;
                    let duration = tr.duration;
                    const trFrame = (e: PointerEvent) => frameFromOffset(e.clientX - row.getBoundingClientRect().left);

                    block.addEventListener('pointerdown', (event) => {
                        if (!event.isPrimary || event.button !== 0) return;
                        event.stopPropagation();
                        const w = block.getBoundingClientRect().width;
                        mode = event.offsetX < 6 ? 'start' : event.offsetX > w - 6 ? 'end' : 'move';
                        downFrame = trFrame(event);
                        start = tr.start;
                        duration = tr.duration;
                        drag.busy = true;
                        block.setPointerCapture(event.pointerId);
                        events.fire('selection', splat);
                        events.fire('layerAnim.selectTransition', tr.id);
                    });
                    block.addEventListener('pointermove', (event) => {
                        if (!mode) return;
                        const frame = trFrame(event);
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
                    // the first click may select the layer, which rebuilds the
                    // rows, so a native dblclick never sees both clicks: detect
                    // the double click across rebuilds instead
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

                if (expanded) {
                    for (const [channel, text] of LAYER_ROWS) {
                        const button = createKeyButton(events,
                            () => events.invoke('layerAnim.channelState', splat, channel) as KeyState,
                            () => events.fire('layerAnim.keyChannel', splat, channel));
                        const sub = channelRow(i18n.t(text), button.dom, (event) => {
                            events.fire('selection', splat);
                            events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
                        });
                        for (const key of state.track.channelKeys(channel)) {
                            if (key >= frames) continue;
                            addKeyMarker(sub, key, '#e6e6e6', `${i18n.t(text)} · Frame ${key}`,
                                (from, to) => events.fire('layerAnim.moveChannelKey', splat, channel, from, to),
                                frame => events.fire('layerAnim.removeChannelKey', splat, channel, frame),
                                () => events.fire('selection', splat));
                        }
                        addCursor(sub);
                        this.dom.appendChild(sub);
                    }
                }
            }

            updateLive(frameNow());
        };

        // which camera the cut shows at frame
        updateLive = (frame: number) => {
            const segments = events.invoke('cut.segments') as CutSegment[] ?? [];
            const id = segments.length > 0 ? events.invoke('cut.cameraAt', frame) : null;
            liveLabels.forEach(l => l.el.classList.toggle('live', l.id === id));
        };

        const moveCursors = (frame: number) => {
            const x = `${offsetFromFrame(frame)}px`;
            cursors.forEach((c) => {
                c.style.left = x;
            });
            updateLive(frame);
        };

        requestRebuild = () => {
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
            'layerAnim.trackChanged', 'layerAnim.transitionSelected', 'track.target', 'section.trackChanged', 'look.trackChanged', 'light.trackChanged', 'scene.elementAdded', 'scene.elementRemoved', 'selection.changed', 'splat.name'
        ].forEach(name => events.on(name, requestRebuild));
        // rows are translated at build time
        i18n.onChange(requestRebuild);

        events.on('timeline.frame', moveCursors);
    }
}

export { TimelineTracks };
