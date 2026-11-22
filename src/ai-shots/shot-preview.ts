import { Container } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import type { DraftSettings, DraftState } from './shot-draft';
import { trackSplines } from './shot-generator';
import type { ShotProposal } from './shot-types';
import { Events } from '../events';
import type { Scene } from '../scene';
import { formatLength, type SceneScale } from '../scene-scale';
import { i18n } from '../ui/localization';

// Viewport overlay of the shot suggestion draft (shot-draft.ts): the path,
// the camera at its start, the distance ring with a handle around the object
// and markers for the keys (shots) or waypoints (walks), which can be dragged.
// Html / svg above the canvas: never in a render or export, never clipped by
// the depth filter or the section cut.

const SVG_NS = 'http://www.w3.org/2000/svg';
const PATH_SAMPLES = 200;
const RING_SAMPLES = 96;
// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

const v = new Vec3();
const screen = new Vec3();

type Drag =
    | { kind: 'key', index: number, id: number, y: number, moved: boolean, x0: number, y0: number, el: HTMLElement }
    | { kind: 'waypoint', index: number, id: number, y: number, moved: boolean, x0: number, y0: number, el: HTMLElement }
    | { kind: 'ring', id: number, y: number, startRadius: number, startScale: number, moved: boolean, x0: number, y0: number, el: HTMLElement };

class ShotPreview {
    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const container = canvasContainer.dom;

        const overlay = document.createElement('div');
        overlay.id = 'ai-shots-preview';
        overlay.hidden = true;
        const svg = document.createElementNS(SVG_NS, 'svg');
        overlay.appendChild(svg);
        container.appendChild(overlay);

        const svgPath = (cls: string) => {
            const el = document.createElementNS(SVG_NS, 'path');
            el.setAttribute('class', cls);
            svg.appendChild(el);
            return el;
        };
        // drawing order: ground route, ring, distance line, camera path,
        // frustum
        const routePath = svgPath('aisp-route');
        const ringPath = svgPath('aisp-ring');
        const distancePath = svgPath('aisp-distance');
        const shadowPath = svgPath('aisp-path-shadow');
        const cameraPath = svgPath('aisp-path');
        const targetPath = svgPath('aisp-target');
        const frustumPath = svgPath('aisp-frustum');
        const centerPath = svgPath('aisp-center');

        const div = (cls: string, parent: HTMLElement = overlay) => {
            const el = document.createElement('div');
            el.className = cls;
            parent.appendChild(el);
            return el;
        };
        const ringHandle = div('aisp-handle');
        const ringLabel = div('aisp-label');
        const startLabel = div('aisp-label aisp-start-label');
        const hint = div('aisp-hint');

        let state: DraftState | null = null;
        let visible = false;
        let enabled = true;
        let playing = false;
        let picking = false;

        // world samples of the current draft
        let samples: Vec3[] = [];
        let targets: Vec3[] = [];
        let keyMarkers: HTMLElement[] = [];
        let waypointMarkers: HTMLElement[] = [];
        let drag: Drag | null = null;

        const scale = (): SceneScale => (events.functions.has('sceneScale.get') ? events.invoke('sceneScale.get') : { mode: 'auto', metersPerUnit: 1, known: false, source: 'unknown' });
        const settings = (): DraftSettings | null => (events.functions.has('aiShots.draftSettings') ? events.invoke('aiShots.draftSettings') : null);

        const draft = (): ShotProposal | null => state?.draft ?? null;
        const isWalk = () => draft()?.kind === 'walk' || settings()?.mode === 'walk';

        // --- geometry ----------------------------------------------------------

        const project = (world: Vec3, out: Vec3) => {
            const cam = scene.camera.mainCamera;
            v.sub2(world, cam.getPosition());
            if (v.dot(cam.forward) <= 0) return null;
            scene.camera.worldToScreen(world, out);
            out.x *= container.clientWidth;
            out.y *= container.clientHeight;
            return out;
        };

        // polyline through world points, broken where points are behind the view
        const polyline = (points: Vec3[], closed = false) => {
            let d = '';
            let open = false;
            let first: string | null = null;
            for (const p of points) {
                const s = project(p, screen);
                if (!s) {
                    open = false;
                    continue;
                }
                const xy = `${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
                d += `${open ? 'L' : 'M'}${xy} `;
                if (!first) first = xy;
                open = true;
            }
            if (closed && first && open) d += `L${first}`;
            return d;
        };

        // the pointer ray meets the horizontal plane y
        const onPlane = (clientX: number, clientY: number, y: number): Vec3 | null => {
            const rect = container.getBoundingClientRect();
            const x = clientX - rect.left;
            const yy = clientY - rect.top;
            const cam = scene.camera.camera;
            const a = new Vec3();
            const b = new Vec3();
            cam.screenToWorld(x, yy, 1, a);
            cam.screenToWorld(x, yy, 100, b);
            const dy = b.y - a.y;
            if (Math.abs(dy) < 1e-9) return null;
            const t = (y - a.y) / dy;
            if (t < 0) return null;
            return new Vec3().lerp(a, b, t);
        };

        // the reference point of the distance: where the generator measures
        // it (orbit / push-in / flyover: start, reveal / crane: end, slide:
        // the closest point)
        const referencePoint = (p: ShotProposal) => {
            const keys = p.keys;
            if (!keys.length || !state?.object) return null;
            const c = state.object.center;
            switch (p.params.template) {
                case 'reveal':
                case 'crane':
                    return keys[keys.length - 1].position;
                case 'slide': {
                    let best = samples[0] ?? keys[0].position;
                    samples.forEach((s) => {
                        if (s.distance(c) < best.distance(c)) best = s;
                    });
                    return best;
                }
                default:
                    return keys[0].position;
            }
        };

        const ring = () => {
            const p = draft();
            const object = state?.object;
            if (!p || !object || isWalk()) return null;
            const ref = referencePoint(p);
            if (!ref) return null;
            const c = object.center;
            const radius = Math.hypot(ref.x - c.x, ref.z - c.z);
            if (!(radius > 1e-6)) return null;
            return { center: new Vec3(c.x, ref.y, c.z), radius, distance: ref.distance(c), ref };
        };

        // --- building ------------------------------------------------------------

        const clearMarkers = (list: HTMLElement[]) => {
            list.forEach(el => el.remove());
            return [] as HTMLElement[];
        };

        const rebuild = () => {
            const p = draft();
            samples = [];
            targets = [];
            if (p && p.keys.length >= 2) {
                const at = trackSplines(p.keys);
                const last = p.keys[p.keys.length - 1].frame;
                for (let i = 0; i <= PATH_SAMPLES; i++) {
                    const pose = at(last * i / PATH_SAMPLES);
                    samples.push(pose.position);
                    targets.push(pose.target);
                }
            } else if (p && p.keys.length === 1) {
                samples = [p.keys[0].position.clone()];
                targets = [p.keys[0].target.clone()];
            }

            // markers are rebuilt only outside a drag (it holds the element)
            if (drag) return;
            keyMarkers = clearMarkers(keyMarkers);
            waypointMarkers = clearMarkers(waypointMarkers);
            if (!p) return;
            if (isWalk()) {
                (state?.waypoints ?? []).forEach((w, index) => {
                    const el = div('aisp-waypoint');
                    el.textContent = String(index + 1);
                    el.title = i18n.t('sm.aishots.preview.waypoint-tip');
                    el.addEventListener('pointerdown', e => startDrag(e, { kind: 'waypoint', index, id: e.pointerId, y: w.y, moved: false, x0: e.clientX, y0: e.clientY, el }));
                    el.addEventListener('dblclick', (e) => {
                        e.stopPropagation();
                        events.fire('aiShots.removeWaypoint', index);
                    });
                    el.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        events.fire('aiShots.removeWaypoint', index);
                    });
                    waypointMarkers.push(el);
                });
            } else {
                p.keys.forEach((k, index) => {
                    const el = div('aisp-key');
                    el.title = i18n.t('sm.aishots.preview.key-tip', { frame: k.frame });
                    el.addEventListener('pointerdown', e => startDrag(e, { kind: 'key', index, id: e.pointerId, y: k.position.y, moved: false, x0: e.clientX, y0: e.clientY, el }));
                    keyMarkers.push(el);
                });
            }
        };

        // --- drawing -------------------------------------------------------------

        const place = (el: HTMLElement, world: Vec3 | null, dx = 0, dy = 0) => {
            const s = world && project(world, screen);
            el.hidden = !s;
            if (s) el.style.transform = `translate(${(s.x + dx).toFixed(1)}px, ${(s.y + dy).toFixed(1)}px)`;
            return s;
        };

        const frustum = (position: Vec3, target: Vec3, fov: number, size: number) => {
            const fwd = new Vec3().sub2(target, position);
            if (fwd.length() < 1e-9) return '';
            fwd.normalize();
            const right = new Vec3().cross(fwd, Vec3.UP);
            if (right.length() < 1e-6) right.set(1, 0, 0);
            right.normalize();
            const up = new Vec3().cross(right, fwd).normalize();
            const halfW = size * Math.tan(Math.min(150, Math.max(5, fov)) * Math.PI / 360);
            const halfH = halfW * 9 / 16;
            const base = position.clone().add(fwd.clone().mulScalar(size));
            const corner = (sx: number, sy: number) => base.clone().add(right.clone().mulScalar(sx * halfW)).add(up.clone().mulScalar(sy * halfH));
            const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
            const tip = base.clone().add(up.clone().mulScalar(halfH * 1.6));
            let d = '';
            c.forEach((q) => {
                d += polyline([position, q]);
            });
            d += polyline([...c, c[0]]);
            d += polyline([c[3], tip, c[2]]);
            return d;
        };

        const draw = () => {
            const p = draft();
            const show = visible && enabled && !playing && !!p;
            overlay.hidden = !show && !(visible && picking);
            hint.hidden = !(visible && picking);
            if (visible && picking) {
                hint.textContent = i18n.t('sm.aishots.preview.picking-hint');
            }
            if (!show) {
                [routePath, ringPath, distancePath, shadowPath, cameraPath, targetPath, frustumPath, centerPath].forEach(el => el.setAttribute('d', ''));
                ringHandle.hidden = true;
                ringLabel.hidden = true;
                startLabel.hidden = true;
                keyMarkers.forEach((el) => {
                    el.hidden = true;
                });
                waypointMarkers.forEach((el) => {
                    el.hidden = true;
                });
                return;
            }
            const object = state?.object;
            const walk = isWalk();
            const sc = scale();

            // camera path
            const d = polyline(samples);
            cameraPath.setAttribute('d', d);
            shadowPath.setAttribute('d', d);
            cameraPath.classList.toggle('edited', !!p.edited);
            cameraPath.classList.toggle('walk', walk);

            // walk: route on the ground
            routePath.setAttribute('d', walk && p.route ? polyline(p.route) : '');

            // start camera and where it looks
            const first = p.keys[0];
            if (first) {
                const size = object ? Math.max(0.06 * object.radius, 0.02 * first.position.distance(first.target)) : 0.3;
                frustumPath.setAttribute('d', frustum(first.position, first.target, first.fov ?? events.invoke('camera.fov') ?? 60, walk ? 0.4 / (sc.metersPerUnit || 1) : size));
                targetPath.setAttribute('d', walk ? '' : polyline([first.position, first.target]));
                place(startLabel, first.position, 10, -22);
                startLabel.textContent = i18n.t('sm.aishots.preview.start');
            } else {
                frustumPath.setAttribute('d', '');
                targetPath.setAttribute('d', '');
                startLabel.hidden = true;
            }

            // distance ring with its handle
            const r = ring();
            if (r) {
                const points: Vec3[] = [];
                for (let i = 0; i < RING_SAMPLES; i++) {
                    const a = (i / RING_SAMPLES) * Math.PI * 2;
                    points.push(new Vec3(r.center.x + Math.sin(a) * r.radius, r.center.y, r.center.z + Math.cos(a) * r.radius));
                }
                ringPath.setAttribute('d', polyline(points, true));
                const c = object.center;
                distancePath.setAttribute('d', polyline([c, r.ref]));
                centerPath.setAttribute('d', polyline([new Vec3(c.x, r.center.y, c.z), c]));
                // the handle sits on the ring where it faces the viewer
                const eye = scene.camera.mainCamera.getPosition();
                let az = Math.atan2(eye.x - c.x, eye.z - c.z);
                const refAz = Math.atan2(r.ref.x - c.x, r.ref.z - c.z);
                const gap = Math.abs(((az - refAz) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
                if (gap < 0.35) az += 0.5;
                const handle = new Vec3(c.x + Math.sin(az) * r.radius, r.center.y, c.z + Math.cos(az) * r.radius);
                if (drag?.kind !== 'ring') ringHandle.dataset.az = String(az);
                const shown = drag?.kind === 'ring' ? new Vec3(c.x + Math.sin(Number(ringHandle.dataset.az)) * r.radius, r.center.y, c.z + Math.cos(Number(ringHandle.dataset.az)) * r.radius) : handle;
                place(ringHandle, shown);
                const s = place(ringLabel, shown, 12, 8);
                if (s) {
                    const size = 2 * Math.max(object.halfExtents.x, object.halfExtents.y, object.halfExtents.z, 1e-6);
                    ringLabel.textContent = i18n.t('sm.aishots.preview.ring-label', {
                        distance: formatLength(r.distance, sc),
                        ratio: (r.distance / size).toLocaleString(i18n.locale || 'en', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
                    });
                }
                ringHandle.title = i18n.t('sm.aishots.preview.ring-tip');
            } else {
                ringPath.setAttribute('d', '');
                distancePath.setAttribute('d', '');
                centerPath.setAttribute('d', '');
                ringHandle.hidden = true;
                ringLabel.hidden = true;
            }

            // markers
            keyMarkers.forEach((el, i) => {
                const k = p.keys[i];
                place(el, k ? k.position : null);
            });
            const points = state?.waypoints ?? [];
            waypointMarkers.forEach((el, i) => {
                place(el, points[i] ?? null);
            });
        };

        events.on('postrender', () => {
            if (visible) draw();
        });

        const refresh = () => {
            rebuild();
            draw();
            scene.forceRender = true;
        };

        events.on('aiShots.draftChanged', (next: DraftState) => {
            state = next;
            refresh();
        });
        events.on('aiShotsPanel.visible', (value: boolean) => {
            visible = value;
            refresh();
        });
        events.on('aiShots.setPreviewEnabled', (value: boolean) => {
            enabled = value;
            refresh();
        });
        events.function('aiShots.previewEnabled', () => enabled);
        events.on('aiShots.playing', (value: boolean) => {
            playing = value;
            refresh();
        });
        events.on('aiShots.picking', (value: boolean) => {
            picking = value;
            container.classList.toggle('ai-shots-picking', value);
            refresh();
        });
        i18n.onChange(() => refresh());

        // --- dragging -------------------------------------------------------------

        function startDrag(e: PointerEvent, d: Drag) {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            drag = d;
            d.el.classList.add('dragging');
            try {
                d.el.setPointerCapture(e.pointerId);
            } catch {
                // the pointer is gone already
            }
            d.el.addEventListener('pointermove', moveDrag);
            d.el.addEventListener('pointerup', endDrag);
            d.el.addEventListener('pointercancel', endDrag);
        }

        function moveDrag(e: PointerEvent) {
            if (!drag || e.pointerId !== drag.id) return;
            if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= CLICK_TOLERANCE) return;
            drag.moved = true;
            const p = draft();
            if (!p) return;
            if (drag.kind === 'key') {
                const key = p.keys[drag.index];
                if (!key) return;
                let next: Vec3 | null;
                if (e.shiftKey) {
                    // up / down: the plane through the key facing the view
                    const cam = scene.camera.mainCamera;
                    const depth = v.sub2(key.position, cam.getPosition()).dot(cam.forward);
                    const rect = container.getBoundingClientRect();
                    const world = new Vec3();
                    scene.camera.camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top, depth, world);
                    next = key.position.clone();
                    next.y = world.y;
                } else {
                    next = onPlane(e.clientX, e.clientY, key.position.y);
                }
                if (next) events.fire('aiShots.moveDraftKey', drag.index, next);
            } else if (drag.kind === 'waypoint') {
                const next = onPlane(e.clientX, e.clientY, drag.y);
                if (next) events.fire('aiShots.moveWaypoint', drag.index, next, true);
            } else if (drag.kind === 'ring') {
                const object = state?.object;
                if (!object) return;
                const hit = onPlane(e.clientX, e.clientY, drag.y);
                if (!hit) return;
                const radius = Math.hypot(hit.x - object.center.x, hit.z - object.center.z);
                if (!(radius > 1e-6) || !(drag.startRadius > 0)) return;
                // the distance slider (panel) owns the setting
                const factor = Math.min(3, Math.max(0.5, drag.startScale * radius / drag.startRadius));
                events.fire('aiShots.requestDistanceScale', factor);
            }
            scene.forceRender = true;
        }

        function endDrag(e: PointerEvent) {
            if (!drag || e.pointerId !== drag.id) return;
            const d = drag;
            drag = null;
            d.el.classList.remove('dragging');
            if (d.el.hasPointerCapture(e.pointerId)) d.el.releasePointerCapture(e.pointerId);
            d.el.removeEventListener('pointermove', moveDrag);
            d.el.removeEventListener('pointerup', endDrag);
            d.el.removeEventListener('pointercancel', endDrag);
            if (d.kind === 'waypoint' && d.moved) {
                // snap the dropped waypoint onto the surface under the pointer,
                // then compute the full walk (ground, way around obstacles)
                const rect = container.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width;
                const y = (e.clientY - rect.top) / rect.height;
                scene.camera.intersect(x, y).then((hit) => {
                    const fallback = onPlane(e.clientX, e.clientY, d.y);
                    const p = hit?.position ?? fallback;
                    if (p) events.fire('aiShots.moveWaypoint', d.index, p, false);
                });
            }
            refresh();
        }

        ringHandle.addEventListener('pointerdown', (e) => {
            const r = ring();
            const s = settings();
            if (!r || !s) return;
            startDrag(e, { kind: 'ring', id: e.pointerId, y: r.center.y, startRadius: r.radius, startScale: s.distanceScale, moved: false, x0: e.clientX, y0: e.clientY, el: ringHandle });
        });

        // --- clicking waypoints on the ground ------------------------------------

        const pointer = { x: 0, y: 0, down: false };
        container.addEventListener('pointerdown', (e: PointerEvent) => {
            if (!picking || e.button !== 0 || drag) return;
            pointer.x = e.clientX;
            pointer.y = e.clientY;
            pointer.down = true;
        }, true);
        window.addEventListener('pointerup', async (e: PointerEvent) => {
            if (!picking || !pointer.down) return;
            pointer.down = false;
            if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > CLICK_TOLERANCE) return;
            const rect = container.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientY < rect.top || e.clientX > rect.right || e.clientY > rect.bottom) return;
            const hit = await scene.camera.intersect((pointer.x - rect.left) / rect.width, (pointer.y - rect.top) / rect.height);
            if (hit) events.fire('aiShots.addWaypoint', hit.position);
        });
    }
}

export { ShotPreview };
