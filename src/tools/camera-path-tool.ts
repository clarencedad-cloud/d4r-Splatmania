import { Container, Label } from '@playcanvas/pcui';
import { Entity, TranslateGizmo, Vec3 } from 'playcanvas';

import type { CameraAnimTrack, ShotCamera } from '../camera-poses';
import { AnimTrackEditOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { i18n } from '../ui/localization';

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;
// shift-click this close (px) to the path inserts a key
const PATH_TOLERANCE = 10;

type Part = 'position' | 'target';
type KeyRef = { cameraId: number, frame: number, part: Part };
type Marker = { el: HTMLElement, label?: HTMLElement, line?: SVGLineElement, camera: ShotCamera, frame: number, part: Part };

const v = new Vec3();
const hv = new Vec3();
const a = new Vec3();
const b = new Vec3();
const delta = new Vec3();

const rgb = (c: number[], alpha = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;

class CameraPathTransformHandler {
    activate() {}
    deactivate() {}
}

/**
 * Edit the selected shot camera's path in the viewport: a marker per key
 * (position) and per key target, drag them in the view plane or with the
 * translate gizmo (Alt moves position and target together), shift-click on
 * the path inserts a key on the curve, Delete removes the selected key, F
 * frames it. The selected position key shows its bezier handles: dragging
 * one shapes the curve (the other mirrors its direction, Alt breaks the
 * link), a double-click returns to the automatic curve.
 * Every drag, insert and delete is one undo step. The markers are
 * html above the canvas, so they are never clipped by the depth filter or the
 * section cut and never end up in an export.
 */
class CameraPathTool {
    activate: () => void;
    deactivate: () => void;
    getFocus: () => { position: Vec3, radius: number } | null;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const container = canvasContainer.dom;

        // overlay: svg for the key → target lines, divs for the markers
        const overlay = document.createElement('div');
        overlay.id = 'camera-path-overlay';
        overlay.hidden = true;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        overlay.appendChild(svg);
        container.appendChild(overlay);

        // toolbar with the hints
        const toolbar = new Container({ class: ['select-toolbar', 'select-toolbar-tool', 'camera-path-toolbar'], hidden: true });
        toolbar.dom.addEventListener('pointerdown', e => e.stopPropagation());
        const hint = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(hint, 'sm.path.hint');
        const status = new Label({ class: ['select-toolbar-label', 'camera-path-status'], text: '' });
        const handleHint = new Label({ class: ['select-toolbar-label', 'camera-path-handle-hint'] });
        i18n.bindText(handleHint, 'sm.path.handles-hint');
        toolbar.append(hint);
        toolbar.append(handleHint);
        toolbar.append(status);
        canvasContainer.append(toolbar);

        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        const pivot = new Entity('cameraPathGizmoPivot');
        const transformHandler = new CameraPathTransformHandler();

        // bezier handles of the selected position key: [in, out]
        type HandleSide = 'in' | 'out';
        const handleEls = (['in', 'out'] as HandleSide[]).map((side) => {
            const el = document.createElement('div');
            el.classList.add('camera-path-handle', `cp-handle-${side}`);
            el.hidden = true;
            overlay.appendChild(el);
            return { side, el, line: null as SVGLineElement | null };
        });
        let handleDrag: { side: HandleSide, before: unknown, depth: number, id: number, moved: boolean, x: number, y: number } | null = null;

        let active = false;
        let selected: KeyRef | null = null;
        let markers: Marker[] = [];
        let dirty = true;
        let altDown = false;
        // direct marker drag in progress
        let drag: { marker: Marker, before: unknown, depth: number, moved: boolean, id: number, x: number, y: number } | null = null;

        const cameras = () => (events.invoke('shotCameras.list') as ShotCamera[]) ?? [];
        const selectedCamera = () => events.invoke('shotCameras.selected') as ShotCamera;
        const cameraById = (id: number) => cameras().find(c => c.id === id) ?? null;
        const poseOf = (ref: KeyRef | null) => (ref ? cameraById(ref.cameraId)?.track.getPoses().find(p => p.frame === ref.frame) ?? null : null);

        const refresh = () => {
            dirty = true;
            scene.forceRender = true;
        };

        // undoable track edit: snapshot before, apply, snapshot after
        const trackEdit = (name: string, track: CameraAnimTrack, edit: () => boolean) => {
            const before = track.snapshot();
            if (!edit()) return false;
            events.fire('edit.add', new AnimTrackEditOp(name, track, before, track.snapshot()), true);
            return true;
        };

        // gizmo on the selected key part
        let attached = false;
        const placeGizmo = () => {
            const pose = poseOf(selected);
            if (!active || !pose) {
                if (attached) gizmo.detach();
                attached = false;
                return;
            }
            pivot.setLocalPosition(selected.part === 'position' ? pose.position : pose.target);
            if (!attached) gizmo.attach(pivot);
            attached = true;
        };

        const select = (ref: KeyRef | null) => {
            selected = ref;
            if (ref) {
                // jump to the key's frame; the viewport is free while the
                // tool is active, so the view stays where it is
                events.fire('timeline.setFrame', ref.frame);
            }
            status.text = ref ? `Frame ${ref.frame} · ${i18n.t(ref.part === 'position' ? 'sm.path.position' : 'sm.path.target')}` : '';
            placeGizmo();
            // highlight only: rebuilding would drop the marker being dragged
            markers.forEach((m) => {
                m.el.classList.toggle('selected', !!ref && m.camera.id === ref.cameraId && m.frame === ref.frame && m.part === ref.part);
            });
            scene.forceRender = true;
        };

        // move the selected part (or both with alt) so the dragged point is at world
        const moveTo = (track: CameraAnimTrack, ref: KeyRef, world: Vec3, both: boolean) => {
            const pose = track.getPoses().find(p => p.frame === ref.frame);
            if (!pose) return;
            const current = ref.part === 'position' ? pose.position : pose.target;
            delta.sub2(world, current);
            a.add2(pose.position, delta);
            b.add2(pose.target, delta);
            if (both) {
                track.setKeyPose(ref.frame, a, b);
            } else if (ref.part === 'position') {
                track.setKeyPose(ref.frame, a, null);
            } else {
                track.setKeyPose(ref.frame, null, b);
            }
        };

        // markers

        const rebuild = () => {
            dirty = false;
            overlay.querySelectorAll('.camera-path-marker, .camera-path-label').forEach(el => el.remove());
            svg.innerHTML = '';
            markers = [];
            handleEls.forEach((h) => {
                h.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                h.line.classList.add('camera-path-handle-line');
                h.line.style.display = 'none';
                svg.appendChild(h.line);
            });
            const current = selectedCamera();
            for (const camera of cameras()) {
                const isCurrent = camera === current;
                for (const pose of camera.track.getPoses()) {
                    const parts: Part[] = isCurrent ? ['position', 'target'] : ['position'];
                    let line: SVGLineElement | undefined;
                    if (isCurrent) {
                        line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                        line.setAttribute('stroke', rgb(camera.color, 0.7));
                        svg.appendChild(line);
                    }
                    for (const part of parts) {
                        const el = document.createElement('div');
                        el.classList.add('camera-path-marker', part === 'position' ? 'cp-position' : 'cp-target');
                        if (!isCurrent) el.classList.add('dimmed');
                        if (isCurrent && selected && selected.frame === pose.frame && selected.part === part) el.classList.add('selected');
                        el.style.setProperty('--cam', rgb(camera.color));
                        el.title = isCurrent ?
                            i18n.t('sm.path.marker-tip', { camera: camera.name, frame: pose.frame, part: i18n.t(part === 'position' ? 'sm.path.position' : 'sm.path.target') }) :
                            i18n.t('sm.path.select-camera', { camera: camera.name });
                        overlay.appendChild(el);
                        const marker: Marker = { el, camera, frame: pose.frame, part, line: part === 'position' ? line : undefined };
                        if (part === 'position') {
                            const label = document.createElement('div');
                            label.classList.add('camera-path-label');
                            if (!isCurrent) label.classList.add('dimmed');
                            label.textContent = String(pose.frame);
                            overlay.appendChild(label);
                            marker.label = label;
                        }
                        el.addEventListener('pointerdown', e => markerDown(e, marker));
                        markers.push(marker);
                    }
                }
            }
        };

        // screen position (px) of a world point, null when behind the camera
        const project = (world: Vec3, out: Vec3) => {
            const cam = scene.camera.mainCamera;
            v.sub2(world, cam.getPosition());
            if (v.dot(cam.forward) <= 0) return null;
            scene.camera.worldToScreen(world, out);
            out.x *= container.clientWidth;
            out.y *= container.clientHeight;
            return out;
        };

        const screen = new Vec3();
        const screen2 = new Vec3();
        const screen3 = new Vec3();

        // the selected key's handles (position keys only)
        const selectedHandles = () => {
            if (!selected || selected.part !== 'position') return null;
            const camera = cameraById(selected.cameraId);
            const pose = poseOf(selected);
            const handles = camera?.track.getHandles(selected.frame);
            return camera && pose && handles ? { camera, pose, ...handles } : null;
        };

        const updateHandles = () => {
            const h = selectedHandles();
            const p = h && project(h.pose.position, screen);
            handleEls.forEach(({ side, el, line }) => {
                const offset = h && (side === 'in' ? h.handleIn : h.handleOut);
                const s = p && offset && project(hv.add2(h.pose.position, offset), screen3);
                el.hidden = !s;
                if (line) line.style.display = s ? '' : 'none';
                if (!s) return;
                el.classList.toggle('custom', h.custom);
                el.style.setProperty('--cam', rgb(h.camera.color));
                el.style.transform = `translate(${s.x}px, ${s.y}px)`;
                el.title = i18n.t('sm.path.handle-tip');
                if (line) {
                    line.setAttribute('x1', String(p.x));
                    line.setAttribute('y1', String(p.y));
                    line.setAttribute('x2', String(s.x));
                    line.setAttribute('y2', String(s.y));
                    line.setAttribute('stroke', rgb(h.camera.color, 0.9));
                }
            });
        };

        const updatePositions = () => {
            updateHandles();
            const current = selectedCamera();
            for (const m of markers) {
                const pose = m.camera.track.getPoses().find(p => p.frame === m.frame);
                if (!pose) continue;
                const s = project(m.part === 'position' ? pose.position : pose.target, screen);
                m.el.hidden = !s;
                if (m.label) m.label.hidden = !s;
                if (s) {
                    // the target diamond is a square turned in the same transform
                    m.el.style.transform = `translate(${s.x}px, ${s.y}px)${m.part === 'target' ? ' rotate(45deg)' : ''}`;
                    if (m.label) m.label.style.transform = `translate(${s.x + 9}px, ${s.y - 18}px)`;
                }
                if (m.line && m.camera === current) {
                    const t = project(pose.target, screen2);
                    const p = project(pose.position, screen);
                    m.line.style.display = p && t ? '' : 'none';
                    if (p && t) {
                        m.line.setAttribute('x1', String(p.x));
                        m.line.setAttribute('y1', String(p.y));
                        m.line.setAttribute('x2', String(t.x));
                        m.line.setAttribute('y2', String(t.y));
                    }
                }
            }
        };

        events.on('postrender', () => {
            if (!active) return;
            // the dragged marker keeps its element (and pointer capture)
            if (dirty && !drag) rebuild();
            updatePositions();
        });

        // direct drag of a marker in the view plane (depth of the point)


        function markerDown(e: PointerEvent, marker: Marker) {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            if (marker.camera !== selectedCamera()) {
                events.fire('shotCameras.select', marker.camera.id);
                return;
            }
            select({ cameraId: marker.camera.id, frame: marker.frame, part: marker.part });
            const pose = poseOf(selected);
            if (!pose) return;
            const cam = scene.camera.mainCamera;
            v.sub2(marker.part === 'position' ? pose.position : pose.target, cam.getPosition());
            drag = { marker, before: marker.camera.track.snapshot(), depth: v.dot(cam.forward), moved: false, id: e.pointerId, x: e.clientX, y: e.clientY };
            marker.el.addEventListener('pointermove', markerMove);
            marker.el.addEventListener('pointerup', markerUp);
            marker.el.addEventListener('pointercancel', markerUp);
            try {
                marker.el.setPointerCapture(e.pointerId);
            } catch {
                // pointer already gone (e.g. released during the pick)
            }
        }

        function markerMove(e: PointerEvent) {
            if (!drag || e.pointerId !== drag.id) return;
            if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= CLICK_TOLERANCE) return;
            drag.moved = true;
            const rect = container.getBoundingClientRect();
            scene.camera.camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top, drag.depth, v);
            moveTo(drag.marker.camera.track, selected, v, e.altKey);
            placeGizmo();
            scene.forceRender = true;
        }

        function markerUp(e: PointerEvent) {
            if (!drag || e.pointerId !== drag.id) return;
            const { marker, before, moved } = drag;
            drag = null;
            if (marker.el.hasPointerCapture(e.pointerId)) marker.el.releasePointerCapture(e.pointerId);
            marker.el.removeEventListener('pointermove', markerMove);
            marker.el.removeEventListener('pointerup', markerUp);
            marker.el.removeEventListener('pointercancel', markerUp);
            if (moved) {
                events.fire('edit.add', new AnimTrackEditOp('cameraPathDrag', marker.camera.track, before, marker.camera.track.snapshot()), true);
            }
        }

        // handle drag: shapes the curve at the selected key

        handleEls.forEach(({ side, el }) => {
            el.addEventListener('pointerdown', (e: PointerEvent) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
                const h = selectedHandles();
                if (!h) return;
                const cam = scene.camera.mainCamera;
                v.add2(h.pose.position, side === 'in' ? h.handleIn : h.handleOut).sub(cam.getPosition());
                handleDrag = { side, before: h.camera.track.snapshot(), depth: v.dot(cam.forward), id: e.pointerId, moved: false, x: e.clientX, y: e.clientY };
                try {
                    el.setPointerCapture(e.pointerId);
                } catch {
                    // pointer already gone
                }
            });
            el.addEventListener('pointermove', (e: PointerEvent) => {
                if (!handleDrag || e.pointerId !== handleDrag.id || handleDrag.side !== side) return;
                if (!handleDrag.moved && Math.hypot(e.clientX - handleDrag.x, e.clientY - handleDrag.y) <= CLICK_TOLERANCE) return;
                handleDrag.moved = true;
                const h = selectedHandles();
                if (!h) return;
                const rect = container.getBoundingClientRect();
                scene.camera.camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top, handleDrag.depth, v);
                const dragged = new Vec3().sub2(v, h.pose.position);
                const other = side === 'in' ? h.handleOut : h.handleIn;
                // smooth key: the other handle keeps its length and points the
                // opposite way; with alt both move on their own (a corner)
                if (!e.altKey && dragged.length() > 1e-6) {
                    const length = other.length();
                    other.copy(dragged).normalize().mulScalar(-length);
                } else if (!e.altKey) {
                    other.set(0, 0, 0);
                }
                const handleIn = side === 'in' ? dragged : (e.altKey ? h.handleIn : other);
                const handleOut = side === 'out' ? dragged : (e.altKey ? h.handleOut : other);
                h.camera.track.setHandles(selected.frame, handleIn, handleOut);
                scene.forceRender = true;
            });
            const up = (e: PointerEvent) => {
                if (!handleDrag || e.pointerId !== handleDrag.id || handleDrag.side !== side) return;
                const { before, moved } = handleDrag;
                handleDrag = null;
                if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
                const camera = selected && cameraById(selected.cameraId);
                if (moved && camera) {
                    events.fire('edit.add', new AnimTrackEditOp('cameraPathHandle', camera.track, before, camera.track.snapshot()), true);
                }
            };
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
            // double-click: back to the automatic curve
            el.addEventListener('dblclick', (e: MouseEvent) => {
                e.stopPropagation();
                const camera = selected && cameraById(selected.cameraId);
                if (camera && selected) trackEdit('cameraPathHandleReset', camera.track, () => camera.track.setHandles(selected.frame, null, null));
            });
        });

        // gizmo drag: one undo step per drag

        let gizmoBefore: unknown = null;
        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });
        gizmo.on('transform:start', () => {
            const camera = selected && cameraById(selected.cameraId);
            gizmoBefore = camera ? camera.track.snapshot() : null;
        });
        gizmo.on('transform:move', () => {
            const camera = selected && cameraById(selected.cameraId);
            if (!camera) return;
            moveTo(camera.track, selected, pivot.getLocalPosition(), altDown);
            scene.forceRender = true;
        });
        gizmo.on('transform:end', () => {
            const camera = selected && cameraById(selected.cameraId);
            if (camera && gizmoBefore) {
                events.fire('edit.add', new AnimTrackEditOp('cameraPathGizmo', camera.track, gizmoBefore, camera.track.snapshot()), true);
            }
            gizmoBefore = null;
        });

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            gizmo.size = camera.ortho ? 1125 / canvas.clientHeight : 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        const keyChange = (e: KeyboardEvent) => {
            altDown = e.altKey;
        };

        // key edits elsewhere (undo, timeline) move or drop the selection
        const tracksChanged = () => {
            if (!active) return;
            if (selected && !poseOf(selected)) {
                selected = null;
                status.text = '';
            }
            if (!gizmoBefore) placeGizmo();
            refresh();
        };
        ['track.changed', 'track.keysLoaded', 'shotCameras.changed'].forEach(name => events.on(name, tracksChanged));

        // shift-click on the selected camera's path inserts a key there

        let down: { x: number, y: number } | null = null;
        const pointerdown = (e: PointerEvent) => {
            down = e.button === 0 && e.shiftKey ? { x: e.offsetX, y: e.offsetY } : null;
            if (down && nearestPathFrame(e.offsetX, e.offsetY) !== null) {
                // keep the selection tools and the camera out of it
                e.stopPropagation();
                e.preventDefault();
            }
        };
        const pointerup = (e: PointerEvent) => {
            if (!down || !e.shiftKey || Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > CLICK_TOLERANCE) {
                down = null;
                return;
            }
            down = null;
            const frame = nearestPathFrame(e.offsetX, e.offsetY);
            const camera = selectedCamera();
            if (frame === null || !camera) return;
            e.stopPropagation();
            e.preventDefault();
            const pose = camera.track.getPoseAt(frame);
            if (pose && trackEdit('cameraPathInsert', camera.track, () => camera.track.insertKey(frame, pose))) {
                select({ cameraId: camera.id, frame, part: 'position' });
            }
        };

        // the whole frame closest to (x, y) on the selected camera's path,
        // null when the path isn't within reach or a key sits there already
        function nearestPathFrame(x: number, y: number) {
            const camera = selectedCamera();
            const frames = events.invoke('timeline.frames') as number;
            if (!camera || camera.track.keys.length < 2 || frames < 2) return null;
            let best = PATH_TOLERANCE;
            let bestFrame: number | null = null;
            for (let f = 0; f < frames; f++) {
                const pose = camera.track.getPoseAt(f);
                const s = pose && project(pose.position, screen);
                if (!s) continue;
                const d = Math.hypot(s.x - x, s.y - y);
                if (d < best) {
                    best = d;
                    bestFrame = f;
                }
            }
            return bestFrame !== null && !camera.track.keys.includes(bestFrame) ? bestFrame : null;
        }

        // delete the selected key
        events.on('select.delete', () => {
            if (!active || !selected) return;
            const camera = cameraById(selected.cameraId);
            const frame = selected.frame;
            if (camera && trackEdit('cameraPathDelete', camera.track, () => camera.track.removeKey(frame))) {
                select(null);
            }
        });

        // 'f' frames the selected key
        this.getFocus = () => {
            const pose = poseOf(selected);
            if (!pose) return null;
            const bound = scene.bound;
            const radius = Math.max(0.05, (bound ? bound.halfExtents.length() : 1) * 0.15);
            return { position: (selected.part === 'position' ? pose.position : pose.target).clone(), radius };
        };

        this.activate = () => {
            active = true;
            // looking through a camera (or following the cut) would move the
            // view along with the keys being edited: switch to the free view
            if (events.invoke('camera.viewMode') !== 'free') {
                events.fire('camera.setViewMode', 'free');
                status.text = i18n.t('sm.path.forced-free');
            }
            if (!events.invoke('camera.showPaths')) events.fire('camera.setShowPaths', true);
            overlay.hidden = false;
            toolbar.hidden = false;
            container.addEventListener('pointerdown', pointerdown, true);
            container.addEventListener('pointerup', pointerup, true);
            window.addEventListener('keydown', keyChange);
            window.addEventListener('keyup', keyChange);
            events.fire('transformHandler.push', transformHandler);
            placeGizmo();
            refresh();
        };

        this.deactivate = () => {
            active = false;
            placeGizmo();
            overlay.hidden = true;
            toolbar.hidden = true;
            container.removeEventListener('pointerdown', pointerdown, true);
            container.removeEventListener('pointerup', pointerup, true);
            window.removeEventListener('keydown', keyChange);
            window.removeEventListener('keyup', keyChange);
            events.fire('transformHandler.pop');
            scene.forceRender = true;
        };

        // the camera list's "Pfad bearbeiten" button shows the state
        events.function('cameraPath.active', () => active);
    }
}

export { CameraPathTool };
