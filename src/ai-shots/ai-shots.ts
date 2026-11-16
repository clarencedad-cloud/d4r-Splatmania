import { createChunkDataPool } from '@playcanvas/splat-transform';
import { BoundingBox, Mat4, Vec3 } from 'playcanvas';

import { aiAvailable, ClaudeError, planShots, rankShots } from './claude-client';
import { buildCoverageField } from './coverage';
import { generateShots } from './shot-generator';
import type { AnchorPose, CoverageField, GeneratedKey, ShotObject, ShotParams, ShotProposal, ShotStyle, ShotTemplate } from './shot-types';
import { BoxShape } from '../box-shape';
import { ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { SphereShape } from '../sphere-shape';
import { Splat } from '../splat';
import { State } from '../splat-state';
import { i18n } from '../ui/localization';

// Shot suggestions: object capture, preferred angles, the coverage field,
// the generate pipeline (Claude plan -> generator -> preview stills ->
// Claude ranking) and applying proposals as new shot cameras.

// waitingVisible: rendering the stills, paused while the tab is hidden (the
// browser renders no frames then); it continues once the tab shows again
type AiShotsStatus = 'idle' | 'planning' | 'generating' | 'rendering' | 'waitingVisible' | 'ranking' | 'error';

type GenerateOptions = {
    wish?: string;
    useAi: boolean;
    durationSec?: number;
    // multiplier on the camera distance to the object, 0.5..3
    distanceScale?: number;
    // camera height preset (src/ai-shots/shot-types.ts ShotStyle)
    style?: ShotStyle;
    // only these moves; one move gives variants of it
    templates?: ShotTemplate[];
};

type ApplyOptions = {
    setTimeline: boolean;
    disableLoop: boolean;
    // switch depth of field on when a proposal carries focus keys (global,
    // no undo); off unless asked for
    enableDof?: boolean;
};

const MAX_ANCHORS = 3;
const MAX_COVERAGE_POINTS = 2000000;
const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 180;
const RANK_WIDTH = 512;
const RANK_HEIGHT = 288;
const JPEG_QUALITY = 0.85;

class Cancelled extends Error {}

// longest stretch of synchronous coverage work before yielding to the event
// loop (repaints, the cancel button)
const SLICE_MS = 12;

const yieldToEventLoop = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

// a promise that rejects with Cancelled as soon as the signal aborts; the
// work behind it is not stopped by this
const abortable = <T>(promise: Promise<T>, signal: AbortSignal) => new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
        reject(new Cancelled());
        return;
    }
    const onAbort = () => reject(new Cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
});

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

const visibleSplats = (scene: Scene) => {
    return (scene.getElementsByType(ElementType.splat) as Splat[]).filter(s => s.visible && s.numSplats > 0);
};

const unionBound = (bounds: BoundingBox[]) => {
    if (bounds.length === 0) return null;
    const result = new BoundingBox();
    result.copy(bounds[0]);
    for (let i = 1; i < bounds.length; i++) result.add(bounds[i]);
    return result;
};

// world positions (sampled above MAX_COVERAGE_POINTS) and opacities of all
// visible, not hidden gaussians. Works in slices of SLICE_MS and throws
// Cancelled between them once the signal aborts
const collectPoints = async (splats: Splat[], signal: AbortSignal) => {
    let sliceStart = performance.now();
    const breathe = async () => {
        if (performance.now() - sliceStart >= SLICE_MS) {
            await yieldToEventLoop();
            sliceStart = performance.now();
        }
        if (signal.aborted) throw new Cancelled();
    };

    let total = 0;
    splats.forEach((splat) => {
        total += splat.instances.count - splat.numLocked;
    });
    const step = Math.max(1, Math.ceil(total / MAX_COVERAGE_POINTS));
    const capacity = Math.ceil(total / step) + 1;
    const points = new Float32Array(capacity * 3);
    const weights = new Float32Array(capacity);
    const p = new Vec3();
    let counter = 0;
    let n = 0;

    for (const splat of splats) {
        const { source } = splat.resource;
        const { instances } = splat;
        const { flags } = instances;
        const chunkSize = source.meta.chunkSize;
        const numChunks = source.meta.numChunks[0];

        const world = splat.worldTransform.clone();
        const mats = new Map<number, Mat4>();
        const palette = new Mat4();
        const matFor = (transformIndex: number) => {
            let mat = mats.get(transformIndex);
            if (!mat) {
                mat = world.clone();
                if (transformIndex > 0) {
                    splat.transformPalette.getTransform(transformIndex, palette);
                    mat.mul2(world, palette);
                }
                mats.set(transformIndex, mat);
            }
            return mat;
        };

        // instances per source chunk, so the source is read once in order
        const starts = new Uint32Array(numChunks + 1);
        for (let i = 0; i < instances.count; i++) starts[Math.floor(instances.sourceRow[i] / chunkSize) + 1]++;
        for (let c = 0; c < numChunks; c++) starts[c + 1] += starts[c];
        const cursors = starts.slice(0, numChunks);
        const ordered = new Uint32Array(instances.count);
        for (let i = 0; i < instances.count; i++) ordered[cursors[Math.floor(instances.sourceRow[i] / chunkSize)]++] = i;
        await breathe();

        const pool = createChunkDataPool({ chunkSize });
        try {
            for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
                if (starts[chunkIndex] === starts[chunkIndex + 1]) continue;
                await breathe();
                const count = Math.min(chunkSize, source.meta.numGaussians - chunkIndex * chunkSize);
                const position = pool.acquire('position', source.meta.layouts.position, count);
                const geometric = pool.acquire('geometric', source.meta.layouts.geometric, count);
                try {
                    await source.read({ chunkIndex, position, geometric });
                    const pos = new Float32Array(position.data);
                    const geo = new Float32Array(geometric.data);
                    const ps = position.stride / 4;
                    const gs = geometric.stride / 4;
                    const base = chunkIndex * chunkSize;
                    for (let slot = starts[chunkIndex]; slot < starts[chunkIndex + 1]; slot++) {
                        const instance = ordered[slot];
                        if (flags[instance] & State.locked) continue;
                        if (counter++ % step !== 0 || n >= capacity) continue;
                        const row = instances.sourceRow[instance] - base;
                        p.set(pos[row * ps], pos[row * ps + 1], pos[row * ps + 2]);
                        matFor(instances.transformIndex(instance)).transformPoint(p, p);
                        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
                        points[n * 3] = p.x;
                        points[n * 3 + 1] = p.y;
                        points[n * 3 + 2] = p.z;
                        weights[n] = sigmoid(geo[row * gs + 7]);
                        n++;
                    }
                } finally {
                    position.release();
                    geometric.release();
                }
            }
        } finally {
            pool.destroy();
        }
    }

    return { points: points.subarray(0, n * 3), weights: weights.subarray(0, n) };
};

const toVec3 = (v: { x: number, y: number, z: number }) => new Vec3(v.x, v.y, v.z);

const registerAiShotsEvents = (events: Events, scene: Scene) => {
    let anchors: AnchorPose[] = [];
    // the object taken over with captureObject; generate captures anew when
    // there is none
    let captured: ShotObject | null = null;

    // coverage field cache: dropped when splat data or visibility changes.
    // signal: the run that started the build (it stops when that run is
    // cancelled); done: built, kept for later runs whatever happens to it
    type CoverageEntry = { promise: Promise<CoverageField | null>, signal: AbortSignal, done: boolean };
    let coverage: CoverageEntry | null = null;
    const invalidateCoverage = () => {
        coverage = null;
    };
    ['splat.stateChanged', 'splat.positionsChanged', 'splat.moved', 'splat.visibility'].forEach((name) => {
        events.on(name, invalidateCoverage);
    });
    ['scene.elementAdded', 'scene.elementRemoved'].forEach((name) => {
        events.on(name, (element: { type?: ElementType }) => {
            if (element?.type === ElementType.splat) invalidateCoverage();
        });
    });

    const status = (value: AiShotsStatus, detail?: string) => {
        events.fire('aiShots.status', value, detail);
    };

    // object capture

    const sceneBound = () => unionBound(visibleSplats(scene).map(s => s.worldBound));

    const captureObject = (): ShotObject | null => {
        const sceneBox = sceneBound();
        if (!sceneBox) return null;
        const sceneCenter = sceneBox.center.clone();
        const sceneRadius = Math.max(1e-3, sceneBox.halfExtents.length());

        const make = (center: Vec3, halfExtents: Vec3, source: ShotObject['source']): ShotObject => {
            const radius = Math.max(1e-3, halfExtents.length());
            return { center: center.clone(), halfExtents: halfExtents.clone(), radius, sceneCenter, sceneRadius, source };
        };

        // an active box / sphere selection shape: its world AABB
        const tool = events.invoke('tool.active');
        if (tool === 'boxSelection' || tool === 'sphereSelection') {
            const shapes = scene.getElementsByType(ElementType.debug);
            const shape = shapes.find(e => (tool === 'boxSelection' ? e instanceof BoxShape : e instanceof SphereShape)) as BoxShape | SphereShape | undefined;
            const bound = shape?.worldBound;
            const source = tool === 'boxSelection' ? 'box' : 'sphere';
            if (bound && bound.halfExtents.length() > 0) {
                return make(bound.center, bound.halfExtents, source);
            }
            const focus = events.invoke('tool.focus') as { position: Vec3, radius: number } | null;
            if (focus && focus.radius > 0) {
                const h = focus.radius / Math.sqrt(3);
                return make(focus.position, new Vec3(h, h, h), source);
            }
        }

        // selected gaussians of all layers (bounds as of the last state change)
        const selected = visibleSplats(scene)
        .filter(s => s.numSelected > 0)
        .map((s) => {
            const box = new BoundingBox();
            box.setFromTransformedAabb(s.selectionBound, s.worldTransform);
            return box;
        });
        const selectionBox = unionBound(selected);
        if (selectionBox && selectionBox.halfExtents.length() > 0) {
            return make(selectionBox.center, selectionBox.halfExtents, 'selection');
        }

        return make(sceneBox.center, sceneBox.halfExtents, 'scene');
    };

    events.function('aiShots.captureObject', () => {
        captured = captureObject();
        return captured;
    });

    // preferred angles: the viewport pose, at most MAX_ANCHORS (the oldest
    // gives way)

    const addAnchor = () => {
        const pose = events.invoke('camera.getPose');
        if (!pose) return anchors.length;
        const position = toVec3(pose.position);
        const target = toVec3(pose.target);
        if (position.distance(target) < 1e-6) return anchors.length;
        anchors.push({ position, target, fov: pose.fov ?? events.invoke('camera.fov') ?? 60 });
        if (anchors.length > MAX_ANCHORS) anchors.shift();
        events.fire('aiShots.anchorsChanged', anchors.length);
        return anchors.length;
    };

    const clearAnchors = () => {
        anchors = [];
        events.fire('aiShots.anchorsChanged', 0);
    };

    events.function('aiShots.addAnchor', addAnchor);
    events.on('aiShots.addAnchor', addAnchor);
    events.function('aiShots.clearAnchors', clearAnchors);
    events.on('aiShots.clearAnchors', clearAnchors);
    events.function('aiShots.anchors', () => anchors.map(a => ({ position: a.position.clone(), target: a.target.clone(), fov: a.fov })));

    events.on('scene.clear', () => {
        captured = null;
        clearAnchors();
        invalidateCoverage();
    });

    // generate

    let controller: AbortController | null = null;

    const cancel = () => {
        controller?.abort();
    };
    events.function('aiShots.cancel', cancel);
    events.on('aiShots.cancel', cancel);

    // built once in slices and shared by later runs. Cancelling the run that
    // builds it stops the build (it can take seconds on large scenes and
    // would only burn time in the background); the next run starts a fresh
    // one. A failed or stopped build is not kept
    const getCoverage = (signal: AbortSignal) => {
        if (coverage && (coverage.done || !coverage.signal.aborted)) return coverage.promise;
        const splats = visibleSplats(scene);
        const bound = unionBound(splats.map(s => s.worldBound));
        const build = async (): Promise<CoverageField | null> => {
            if (!bound) return null;
            const { points, weights } = await collectPoints(splats, signal);
            if (signal.aborted) throw new Cancelled();
            if (points.length === 0) return null;
            return buildCoverageField(points, weights, { min: bound.getMin().clone(), max: bound.getMax().clone() });
        };
        const entry: CoverageEntry = { promise: null, signal, done: false };
        entry.promise = build().then((field) => {
            entry.done = true;
            return field;
        }, (error): null => {
            if (!(error instanceof Cancelled)) console.warn('shot suggestions: coverage failed', error);
            if (coverage === entry) coverage = null;
            return null;
        });
        coverage = entry;
        return entry.promise;
    };

    const displayTitle = (proposal: ShotProposal) => proposal.params.label || i18n.t(proposal.title);

    // null when busy twice or cancelled (the signal also ends a wait for a
    // hidden tab or a frame inside render.posePreview)
    const renderKey = async (key: GeneratedKey, fov: number, width: number, height: number, signal: AbortSignal) => {
        const pose = { position: key.position, target: key.target, fov: key.fov ?? fov, focus: key.focus, aperture: key.aperture };
        for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
            const canvas = await events.invoke('render.posePreview', pose, width, height, signal) as HTMLCanvasElement | null;
            if (canvas) return canvas;
        }
        return null;
    };

    const jpegBase64 = (canvas: HTMLCanvasElement) => canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1] ?? '';

    const thumbnailOf = (canvas: HTMLCanvasElement) => {
        if (canvas.width <= THUMB_WIDTH) return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        const thumb = document.createElement('canvas');
        thumb.width = THUMB_WIDTH;
        thumb.height = Math.max(1, Math.round(canvas.height * THUMB_WIDTH / canvas.width));
        thumb.getContext('2d')?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
        return thumb.toDataURL('image/jpeg', JPEG_QUALITY);
    };

    // first, middle and last key: the keys sit on the path, so no
    // interpolation is needed for the stills
    const sampleKeys = (proposal: ShotProposal) => {
        const keys = proposal.keys;
        if (keys.length === 0) return [];
        if (keys.length <= 2) return keys.slice();
        const middle = (keys[0].frame + keys[keys.length - 1].frame) / 2;
        let mid = keys[1];
        keys.forEach((k) => {
            if (Math.abs(k.frame - middle) < Math.abs(mid.frame - middle)) mid = k;
        });
        const result = [keys[0], mid, keys[keys.length - 1]];
        return result.filter((k, i) => result.indexOf(k) === i);
    };

    const errorCode = (error: unknown) => (error instanceof ClaudeError ? error.code : 'sm.aishots.err.api');

    const byScore = (a: ShotProposal, b: ShotProposal) => b.score - a.score;
    const byAiScore = (a: ShotProposal, b: ShotProposal) => {
        const sa = a.aiScore ?? -1;
        const sb = b.aiScore ?? -1;
        return sb !== sa ? sb - sa : b.score - a.score;
    };

    events.function('aiShots.generate', async (opts: GenerateOptions): Promise<ShotProposal[]> => {
        controller?.abort();
        const ctl = new AbortController();
        controller = ctl;
        const cancelled = () => ctl.signal.aborted;
        const check = () => {
            if (cancelled()) throw new Cancelled();
        };

        try {
            const object = captured ?? captureObject();
            if (!object) {
                status('error', 'sm.aishots.err.noObject');
                return [];
            }
            const fps = events.invoke('timeline.frameRate') ?? 30;
            const fov = events.invoke('camera.fov') ?? 60;
            const wish = opts?.wish?.trim() ?? '';
            const durationSec = opts?.durationSec;
            const useAi = !!opts?.useAi && aiAvailable();
            const language = i18n.locale;
            let aiError: string | null = null;

            let requests: ShotParams[] | undefined;
            if (useAi && wish) {
                status('planning');
                try {
                    const h = object.halfExtents;
                    requests = await planShots({
                        wish,
                        object: { size: [2 * h.x, 2 * h.y, 2 * h.z], source: object.source },
                        anchors: anchors.length,
                        durationHint: durationSec,
                        style: opts?.style,
                        templates: opts?.templates,
                        language
                    }, ctl.signal);
                    // a picked move is a hard limit, also for Claude
                    if (requests && opts?.templates?.length) requests = requests.filter(r => opts.templates.includes(r.template));
                    if (!requests?.length) requests = undefined;
                } catch (error) {
                    check();
                    aiError = errorCode(error);
                    requests = undefined;
                }
                check();
            }

            status('generating');
            // abortable wait: cancel ends the run at once, the build itself
            // stops at its next slice
            const field = await abortable(getCoverage(ctl.signal), ctl.signal) ?? undefined;
            check();
            // the panel's duration applies to the generator's own set; Claude's
            // requests carry their own durations
            const proposals = generateShots(object, { fps, fov, anchors: anchors.slice(), coverage: field, requests, durationSec, distanceScale: opts?.distanceScale, style: opts?.style, templates: opts?.templates });
            check();

            // a hidden tab renders no frames: the stills wait (status
            // waitingVisible) and continue once it shows again; cancel works
            // throughout
            const renderingStatus = () => status(document.hidden ? 'waitingVisible' : 'rendering');
            const stills = new Map<string, string[]>();
            renderingStatus();
            document.addEventListener('visibilitychange', renderingStatus);
            try {
                for (const proposal of proposals) {
                    check();
                    if (useAi) {
                        const frames: string[] = [];
                        for (const key of sampleKeys(proposal)) {
                            const canvas = await renderKey(key, fov, RANK_WIDTH, RANK_HEIGHT, ctl.signal);
                            check();
                            if (!canvas) continue;
                            if (!proposal.thumbnail) proposal.thumbnail = thumbnailOf(canvas);
                            frames.push(jpegBase64(canvas));
                        }
                        if (frames.length > 0) stills.set(proposal.id, frames);
                    } else if (proposal.keys.length > 0) {
                        const canvas = await renderKey(proposal.keys[0], fov, THUMB_WIDTH, THUMB_HEIGHT, ctl.signal);
                        check();
                        if (canvas) proposal.thumbnail = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
                    }
                }
            } finally {
                document.removeEventListener('visibilitychange', renderingStatus);
            }

            let ranked = false;
            if (useAi && stills.size > 0) {
                status('ranking');
                try {
                    const results = await rankShots({
                        wish: wish || undefined,
                        language,
                        candidates: proposals
                        .filter(p => stills.has(p.id))
                        .map(p => ({ id: p.id, title: displayTitle(p), jpegBase64: stills.get(p.id) }))
                    }, ctl.signal);
                    check();
                    const byId = new Map(results.map(r => [r.id, r]));
                    proposals.forEach((p) => {
                        const r = byId.get(p.id);
                        if (!r) return;
                        p.aiScore = r.score;
                        p.aiComment = r.comment;
                    });
                    ranked = results.length > 0;
                } catch (error) {
                    check();
                    aiError = errorCode(error);
                }
            }

            proposals.sort(ranked ? byAiScore : byScore);

            if (aiError) {
                status('error', aiError);
            } else {
                status('idle');
            }
            return proposals;
        } catch (error) {
            if (error instanceof Cancelled || cancelled()) {
                status('idle', 'cancelled');
                return [];
            }
            console.error('shot suggestions failed', error);
            status('error', 'sm.aishots.err.generate');
            return [];
        } finally {
            if (controller === ctl) controller = null;
        }
    });

    // apply proposals as new shot cameras: one undo step for all of them.
    // Timeline length and loop are global without undo, changed only when
    // asked for
    events.function('aiShots.apply', (proposals: ShotProposal[], opts: ApplyOptions): number[] => {
        if (!proposals?.length) return [];
        const maxFrames = Math.max(...proposals.map(p => p.frames));
        if (opts?.setTimeline && maxFrames > (events.invoke('timeline.frames') ?? 0)) {
            events.fire('timeline.setFrames', maxFrames);
        }
        if (opts?.disableLoop) {
            events.fire('timeline.setLoop', false);
        }

        const taken = new Set<string>((events.invoke('shotCameras.list') ?? []).map((c: { name: string }) => c.name));
        const uniqueName = (name: string) => {
            let result = name;
            for (let n = 2; taken.has(result); n++) result = `${name} ${n}`;
            taken.add(result);
            return result;
        };

        const items = proposals.filter(p => p.keys.length > 0).map((p) => {
            const first = p.keys[0];
            return {
                name: uniqueName(displayTitle(p)),
                keys: p.keys.map((k) => {
                    const key: { frame: number, position: Vec3, target: Vec3, fov?: number, focus?: number, aperture?: number } = {
                        frame: k.frame,
                        position: k.position.clone(),
                        target: k.target.clone()
                    };
                    if (k.fov !== undefined) key.fov = k.fov;
                    if (k.focus !== undefined) key.focus = k.focus;
                    if (k.aperture !== undefined) key.aperture = k.aperture;
                    return key;
                }),
                base: {
                    position: first.position.clone(),
                    target: first.target.clone(),
                    ...(first.fov !== undefined ? { fov: first.fov } : {})
                }
            };
        });
        if (items.length === 0) return [];

        if (opts?.enableDof && proposals.some(p => p.keys.some(k => k.focus !== undefined))) {
            events.fire('dof.set', { enabled: true });
        }

        // a move longer than the timeline (length not adapted, or the
        // timeline refused the length) is squeezed onto it by addWithKeys
        // instead of losing its end: say so (aiShots.warning, shown by the
        // panel). Return value stays the camera ids
        const timelineFrames = events.invoke('timeline.frames') ?? 0;
        const compressed = items.some(item => item.keys.some(k => Math.round(k.frame) >= timelineFrames));

        const ids = events.invoke('shotCameras.addWithKeys', items, true) ?? [];
        if (compressed && ids.length > 0) events.fire('aiShots.warning', 'sm.aishots.warn.compressed');
        return ids;
    });
};

export { registerAiShotsEvents, type AiShotsStatus, type GenerateOptions, type ApplyOptions };
