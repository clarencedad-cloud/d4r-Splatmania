import { Vec3 } from 'playcanvas';

import { cleanupShot } from './shot-cleanup';
import { framingDistance, generateShots, trackSplines } from './shot-generator';
import type { AnchorPose, CoverageField, GeneratedKey, ShotModifier, ShotObject, ShotProposal, ShotStyle, ShotTemplate } from './shot-types';
import { generateWalk, suggestWaypoints, WalkField } from './walk-path';
import { applyModifierOffset, buildModifierTables, modifierOffset, type ModifierOffset } from '../camera-modifier';
import { Events } from '../events';
import type { Scene } from '../scene';
import type { SceneScale } from '../scene-scale';

// The live draft of the shot suggestions: whenever a setting changes, the
// deterministic generator computes the move at once (no Claude) and the
// viewport shows it (shot-preview.ts). The draft can be shaped by hand - the
// distance ring, key markers, walk waypoints - and tidied up by the clean-up
// step instead of being generated anew. Claude only comes in on request
// (rate the draft).

type DraftSettings = {
    mode: 'shot' | 'walk';
    // shot moves
    durationSec: number;
    distanceScale: number;
    style: ShotStyle;
    // one move, or undefined for all
    template?: ShotTemplate;
    // walk (metres, metres per second, Hz, degrees)
    eyeHeight: number;
    speed: number;
    lookAhead: number;
    autoRoute: boolean;
    bobMeters: number;
    stepRate: number;
    shake: number;
    shakeRate: number;
};

type DraftState = {
    draft: ShotProposal | null;
    // where it comes from
    source: 'settings' | 'card' | 'edited' | 'cleaned';
    object: ShotObject | null;
    waypoints: Vec3[];
    // computing, cleaning or rating
    busy: 'cleanup' | 'rating' | null;
    // the distance the generator was asked for (scene units), for the ui
    requestedDistance: number | null;
};

// what shot-draft needs from ai-shots.ts
type DraftCore = {
    object: () => ShotObject | null;
    anchors: () => AnchorPose[];
    coverage: (signal: AbortSignal) => Promise<CoverageField | null>;
    coverageNow: () => CoverageField | null;
    points: (signal: AbortSignal) => Promise<{ points: Float32Array, weights: Float32Array, bounds: { min: Vec3, max: Vec3 } } | null>;
    stills: (proposal: ShotProposal, signal: AbortSignal) => Promise<{ frames: string[], thumbnail?: string }>;
    rank: (proposal: ShotProposal, frames: string[], wish: string | undefined, signal: AbortSignal) => Promise<{ id: string, score: number, comment: string }[]>;
    errorCode: (error: unknown) => string;
    isCancel: (error: unknown) => boolean;
};

const DEFAULT_SETTINGS: DraftSettings = {
    mode: 'shot',
    durationSec: 10,
    distanceScale: 1,
    style: 'auto',
    eyeHeight: 1.6,
    speed: 1.3,
    lookAhead: 3,
    autoRoute: true,
    bobMeters: 0.03,
    stepRate: 1.9,
    shake: 0.35,
    shakeRate: 1.1
};

const cloneKey = (k: GeneratedKey): GeneratedKey => ({ ...k, position: k.position.clone(), target: k.target.clone() });

const cloneProposal = (p: ShotProposal): ShotProposal => ({
    ...p,
    params: { ...p.params },
    keys: p.keys.map(cloneKey),
    warnings: p.warnings.slice(),
    route: p.route?.map(v => v.clone()),
    modifier: p.modifier ? { ...p.modifier } : undefined
});

const registerShotDraft = (events: Events, scene: Scene, core: DraftCore) => {
    let settings: DraftSettings = { ...DEFAULT_SETTINGS };
    const state: DraftState = {
        draft: null,
        source: 'settings',
        object: null,
        waypoints: [],
        busy: null,
        requestedDistance: null
    };
    // the panel is open: the draft is computed and shown
    let active = false;
    // clicking waypoints on the ground (shot-preview.ts listens)
    let picking = false;

    const scale = (): SceneScale => (events.functions.has('sceneScale.get') ? events.invoke('sceneScale.get') : { mode: 'auto', metersPerUnit: 1, known: false, source: 'unknown' });
    const fps = () => events.invoke('timeline.frameRate') ?? 30;
    const fov = () => events.invoke('camera.fov') ?? 60;

    // long-lived: the scene data for the draft is built once per scene state
    let dataController = new AbortController();
    let walkField: WalkField | null = null;
    let walkFieldPromise: Promise<WalkField | null> | null = null;

    const changed = () => {
        events.fire('aiShots.draftChanged', state);
        scene.forceRender = true;
    };

    const modifierOf = (): ShotModifier => {
        const mpu = scale().metersPerUnit;
        return {
            bob: Math.max(0, settings.bobMeters) / (mpu > 0 ? mpu : 1),
            stepRate: settings.stepRate,
            shake: Math.max(0, settings.shake),
            shakeRate: settings.shakeRate
        };
    };

    // --- computing -------------------------------------------------------

    const computeShot = () => {
        const object = core.object();
        state.object = object;
        if (!object) return null;
        const coverage = core.coverageNow() ?? undefined;
        const list = generateShots(object, {
            fps: fps(),
            fov: fov(),
            anchors: core.anchors(),
            coverage,
            durationSec: settings.durationSec,
            distanceScale: settings.distanceScale,
            style: settings.style,
            templates: settings.template ? [settings.template] : undefined,
            count: settings.template ? 1 : 6
        });
        const best = list[0] ?? null;
        state.requestedDistance = best ? framingDistance(object, fov(), best.params.template) * settings.distanceScale : null;
        return best;
    };

    const computeWalk = (fast: boolean) => {
        state.object = core.object();
        const s = scale();
        const walk = generateWalk({
            points: state.waypoints,
            fps: fps(),
            fov: fov(),
            metersPerUnit: s.metersPerUnit,
            eyeHeight: settings.eyeHeight,
            speed: settings.speed,
            lookAhead: settings.lookAhead,
            autoRoute: settings.autoRoute && !fast,
            field: walkField,
            modifier: modifierOf()
        });
        // the markers show where the walk goes: on the ground found for
        // each click
        if (walk && walkField) state.waypoints = walk.waypoints.map(p => p.clone());
        return walk;
    };

    const ensureWalkField = () => {
        if (walkField || walkFieldPromise) return;
        const signal = dataController.signal;
        walkFieldPromise = core.points(signal).then((cloud): WalkField | null => {
            if (signal.aborted || !cloud) return null;
            walkField = new WalkField(cloud.points, cloud.weights, cloud.bounds, { metersPerUnit: scale().metersPerUnit });
            return walkField;
        }, (): WalkField | null => null).then((field): WalkField | null => {
            walkFieldPromise = null;
            // waypoints snap to the ground and routes follow the free space
            if (field && active && settings.mode === 'walk') recompute();
            return field;
        });
    };

    const ensureCoverage = () => {
        if (core.coverageNow()) return;
        const signal = dataController.signal;
        core.coverage(signal).then((field) => {
            if (field && active && settings.mode === 'shot' && state.source === 'settings') recompute();
        });
    };

    // regenerate from the settings (drops hand edits)
    let fastWalk = false;
    function recompute() {
        if (!active) return;
        if (settings.mode === 'walk') {
            ensureWalkField();
            state.draft = computeWalk(fastWalk);
            state.source = 'settings';
            state.requestedDistance = null;
        } else {
            ensureCoverage();
            state.draft = computeShot();
            state.source = 'settings';
        }
        changed();
    }

    // coalesce bursts of setting changes (slider drags) into one frame; the
    // timer covers a tab that renders no frames
    let queued = false;
    const flush = () => {
        if (!queued) return;
        queued = false;
        recompute();
    };
    const queue = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(flush);
        setTimeout(flush, 50);
    };

    // an edited (or tidied) draft keeps its shape where a setting can be
    // applied to it: distance scales it about the object, duration retimes it
    const rescaleDraft = (factor: number) => {
        const draft = state.draft;
        const object = state.object;
        if (!draft || !object || !(factor > 0)) return;
        const c = object.center;
        const keepHeight = settings.style !== 'auto';
        draft.keys.forEach((k) => {
            [k.position, k.target].forEach((p) => {
                const y = p.y;
                p.sub(c).mulScalar(factor).add(c);
                if (keepHeight) p.y = y;
            });
        });
        draft.params.distanceFactor *= factor;
        draft.thumbnail = undefined;
    };

    const retimeDraft = (durationSec: number) => {
        const draft = state.draft;
        if (!draft || draft.keys.length < 2) return;
        const frames = Math.round(durationSec * fps()) + 1;
        const last = draft.keys[draft.keys.length - 1].frame;
        if (last <= 0) return;
        const scaleT = (frames - 1) / last;
        let prev = -1;
        draft.keys.forEach((k, i) => {
            const f = i === draft.keys.length - 1 ? frames - 1 : Math.round(k.frame * scaleT);
            k.frame = Math.max(prev + 1, f);
            prev = k.frame;
        });
        draft.frames = frames;
        draft.params.durationSec = durationSec;
    };

    events.on('aiShots.setDraftSettings', (next: Partial<DraftSettings>) => {
        const before = settings;
        settings = { ...settings, ...next };
        if (!active) return;
        const handEdited = state.source === 'edited' || state.source === 'cleaned' || state.source === 'card';
        const keys = (Object.keys(next) as (keyof DraftSettings)[]).filter(k => next[k] !== before[k]);
        if (keys.length === 0) return;
        // walk: everything regenerates from the waypoints (cheap)
        if (settings.mode === 'walk' || before.mode !== settings.mode) {
            queue();
            return;
        }
        if (handEdited && keys.every(k => k === 'distanceScale' || k === 'durationSec')) {
            if (keys.includes('distanceScale') && before.distanceScale > 0) {
                rescaleDraft(settings.distanceScale / before.distanceScale);
                if (state.requestedDistance) state.requestedDistance *= settings.distanceScale / before.distanceScale;
            }
            if (keys.includes('durationSec')) retimeDraft(settings.durationSec);
            if (state.source === 'card' || state.source === 'cleaned') state.source = 'edited';
            if (state.draft) state.draft.edited = true;
            changed();
            return;
        }
        queue();
    });

    events.function('aiShots.draft', () => state);
    events.function('aiShots.draftSettings', () => ({ ...settings }));

    // the panel opened / closed
    events.on('aiShotsPanel.visible', (visible: boolean) => {
        active = visible;
        if (!visible) {
            stopPlayback();
            setPicking(false);
            changed();
            return;
        }
        if (!state.draft || state.source === 'settings') queue();
        else changed();
    });

    // the object, the scene data or the scale changed
    const refreshObject = () => {
        if (!active) return;
        if (state.source === 'settings') queue();
    };
    ['aiShots.objectCaptured', 'aiShots.anchorsChanged', 'selection.changed'].forEach(name => events.on(name, refreshObject));
    // the walk field works in metres (cells, headroom): rebuilt from the
    // kept points with the new scale; a build in flight reads the scale when
    // it finishes
    events.on('sceneScale.changed', () => {
        walkField = null;
        if (!active) return;
        if (settings.mode === 'walk') queue();
        else refreshObject();
    });
    events.on('aiShots.sceneDataChanged', () => {
        dataController.abort();
        dataController = new AbortController();
        walkField = null;
        walkFieldPromise = null;
        refreshObject();
    });
    events.on('scene.clear', () => {
        state.draft = null;
        state.waypoints = [];
        state.source = 'settings';
        stopPlayback();
        changed();
    });

    // --- hand edits ----------------------------------------------------------

    // move one key (index) of the draft: its position, or its target; the
    // other part stays where it is
    events.on('aiShots.moveDraftKey', (index: number, position: Vec3, part: 'position' | 'target' = 'position') => {
        const draft = state.draft;
        const key = draft?.keys[index];
        if (!key) return;
        if (part === 'target') key.target.copy(position);
        else key.position.copy(position);
        draft.edited = true;
        draft.cleaned = false;
        draft.thumbnail = undefined;
        draft.aiScore = undefined;
        draft.aiComment = undefined;
        state.source = 'edited';
        changed();
    });

    // a proposal card shown as the draft
    events.on('aiShots.useProposal', (proposal: ShotProposal) => {
        if (!proposal) return;
        if (proposal.kind === 'walk') settings = { ...settings, mode: 'walk' };
        state.draft = cloneProposal(proposal);
        state.source = 'card';
        state.object = core.object();
        changed();
    });

    events.on('aiShots.resetDraft', () => {
        state.source = 'settings';
        recompute();
    });

    // --- clean up --------------------------------------------------------------

    events.function('aiShots.cleanupDraft', async () => {
        const draft = state.draft;
        if (!draft || state.busy) return false;
        state.busy = 'cleanup';
        changed();
        try {
            if (draft.kind === 'walk') {
                // a walk tidies itself: ground, way around obstacles, pace
                const field = walkField ?? await walkFieldPromise;
                if (field !== walkField) walkField = field;
                const before = settings.autoRoute;
                settings.autoRoute = true;
                state.draft = computeWalk(false);
                settings.autoRoute = before;
                if (state.draft) state.draft.cleaned = true;
            } else {
                const object = state.object ?? core.object();
                if (!object) return false;
                const coverage = core.coverageNow() ?? await core.coverage(dataController.signal) ?? undefined;
                state.draft = cleanupShot(object, draft, { fov: draft.keys[0]?.fov ?? fov(), coverage });
            }
            state.source = 'cleaned';
            return true;
        } finally {
            state.busy = null;
            changed();
        }
    });

    // --- Claude: rate the draft on request -------------------------------------

    let rating: AbortController | null = null;
    events.function('aiShots.rateDraft', async (wish?: string) => {
        const draft = state.draft;
        if (!draft || state.busy) return null;
        rating = new AbortController();
        const signal = rating.signal;
        state.busy = 'rating';
        changed();
        try {
            // the stills include the gait bob / shake of a walk
            const shown = withModifier(draft);
            const { frames, thumbnail } = await core.stills(shown, signal);
            if (thumbnail) draft.thumbnail = thumbnail;
            if (frames.length === 0) return null;
            const results = await core.rank(draft, frames, wish, signal);
            const r = results.find(x => x.id === draft.id) ?? results[0];
            if (r && state.draft === draft) {
                draft.aiScore = r.score;
                draft.aiComment = r.comment;
            }
            return r ?? null;
        } catch (error) {
            if (core.isCancel(error) || signal.aborted) return null;
            events.fire('aiShots.status', 'error', core.errorCode(error));
            return null;
        } finally {
            rating = null;
            state.busy = null;
            changed();
        }
    });
    events.on('aiShots.cancelRating', () => rating?.abort());

    // --- walk waypoints ---------------------------------------------------------

    const setWaypoints = (points: Vec3[], fast = false) => {
        state.waypoints = points;
        if (settings.mode !== 'walk') return;
        fastWalk = fast;
        recompute();
        fastWalk = false;
    };

    events.function('aiShots.waypoints', () => state.waypoints.map(p => p.clone()));
    events.on('aiShots.addWaypoint', (p: Vec3) => setWaypoints([...state.waypoints, p.clone()]));
    events.on('aiShots.moveWaypoint', (index: number, p: Vec3, fast?: boolean) => {
        if (!state.waypoints[index]) return;
        const points = state.waypoints.slice();
        points[index] = p.clone();
        setWaypoints(points, !!fast);
    });
    events.on('aiShots.removeWaypoint', (index: number) => {
        if (!state.waypoints[index]) return;
        setWaypoints(state.waypoints.filter((_, i) => i !== index));
    });
    events.on('aiShots.clearWaypoints', () => setWaypoints([]));
    events.function('aiShots.autoWaypoints', async () => {
        const object = core.object();
        if (!object) return 0;
        ensureWalkField();
        const field = walkField ?? await walkFieldPromise;
        if (!field) return 0;
        const ground = object.center.y - object.halfExtents.y;
        const points = suggestWaypoints(field, object.center, object.halfExtents, ground, scale().metersPerUnit);
        setWaypoints(points);
        return points.length;
    });

    // clicking waypoints on the ground: shot-preview.ts listens
    function setPicking(value: boolean) {
        if (picking === value) return;
        picking = value;
        // selection tools would take the clicks too
        if (picking) events.fire('tool.deactivate');
        events.fire('aiShots.picking', picking);
    }
    events.on('aiShots.setPicking', (value: boolean) => setPicking(!!value));
    events.function('aiShots.picking', () => picking);

    // --- test drive: the viewport flies the draft in real time ----------------

    // a walk's modifier on a copy of the draft (stills)
    function withModifier(draft: ShotProposal): ShotProposal {
        if (!draft.modifier || draft.keys.length < 2) return draft;
        const sampler = draftSampler(draft);
        const copy = cloneProposal(draft);
        copy.keys.forEach((k) => {
            const pose = sampler(k.frame);
            k.position.copy(pose.position);
            k.target.copy(pose.target);
        });
        return copy;
    }

    // pose of the draft at a (fractional) frame, with its modifier
    function draftSampler(draft: ShotProposal) {
        const at = trackSplines(draft.keys);
        const lastFrame = draft.keys[draft.keys.length - 1].frame;
        const modifier = draft.modifier;
        const tables = modifier && (modifier.bob > 0 || modifier.shake > 0) ? buildModifierTables({
            value: (channel: keyof ShotModifier) => modifier[channel],
            position: (f: number, out: Vec3) => {
                out.copy(at(Math.min(lastFrame, Math.max(0, f))).position);
                return true;
            }
        }, Math.max(1, lastFrame + 1), fps(), scale().metersPerUnit) : null;
        const scratch: ModifierOffset = { offset: new Vec3(), yaw: 0, pitch: 0 };
        return (frame: number) => {
            const pose = at(Math.min(lastFrame, Math.max(0, frame)));
            if (tables && modifier) {
                const forward = new Vec3().sub2(pose.target, pose.position);
                modifierOffset(modifier, tables, frame, forward, scratch);
                applyModifierOffset(pose.position, pose.target, scratch);
            }
            return pose;
        };
    }

    type Playback = { raf: number, restore: { position: Vec3, target: Vec3, fov: number }, viewMode: string };
    let playback: Playback | null = null;

    function stopPlayback() {
        if (!playback) return;
        const { raf, restore, viewMode } = playback;
        playback = null;
        cancelAnimationFrame(raf);
        events.fire('camera.setPose', restore, 0);
        if (viewMode !== 'free') events.fire('camera.setViewMode', viewMode);
        events.fire('aiShots.playing', false);
    }

    events.function('aiShots.playing', () => !!playback);
    events.on('aiShots.stopPlayback', stopPlayback);
    events.on('aiShots.playDraft', () => {
        const draft = state.draft;
        if (!draft || draft.keys.length < 2) return;
        stopPlayback();
        const view = events.invoke('camera.getPose');
        const viewMode = events.invoke('camera.viewMode') ?? 'free';
        // the rig must not pull the view back to a shot camera meanwhile
        if (viewMode !== 'free') events.fire('camera.setViewMode', 'free');
        const sampler = draftSampler(draft);
        const rate = fps();
        const lastFrame = draft.keys[draft.keys.length - 1].frame;
        const lens = draft.keys[0].fov ?? fov();
        const start = performance.now();
        playback = {
            raf: 0,
            restore: {
                position: new Vec3(view.position.x, view.position.y, view.position.z),
                target: new Vec3(view.target.x, view.target.y, view.target.z),
                fov: view.fov
            },
            viewMode
        };
        events.fire('aiShots.playing', true);
        const step = () => {
            if (!playback) return;
            const frame = (performance.now() - start) / 1000 * rate;
            const pose = sampler(Math.min(frame, lastFrame));
            events.fire('camera.setPose', { position: pose.position, target: pose.target, fov: lens }, 0);
            events.fire('aiShots.playFrame', frame);
            if (frame >= lastFrame) {
                // hold the last frame a moment
                if (frame >= lastFrame + rate * 0.6) {
                    stopPlayback();
                    return;
                }
            }
            playback.raf = requestAnimationFrame(step);
        };
        playback.raf = requestAnimationFrame(step);
    });
    // capture phase: the panel stops key events from bubbling (its buttons
    // keep the focus after a click)
    window.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || (!playback && !picking)) return;
        if (playback) stopPlayback();
        if (picking) setPicking(false);
        e.stopPropagation();
    }, true);

    // --- apply ------------------------------------------------------------------

    events.function('aiShots.applyDraft', (opts: unknown) => {
        const draft = state.draft;
        if (!draft) return [];
        return events.invoke('aiShots.apply', [draft], opts);
    });
};

export { registerShotDraft, DEFAULT_SETTINGS, type DraftCore, type DraftSettings, type DraftState };
