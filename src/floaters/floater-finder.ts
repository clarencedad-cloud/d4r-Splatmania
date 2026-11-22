import { Vec3 } from 'playcanvas';

import { renderGroupViews, reviewGroupViews } from './floater-review';
import { aiAvailable, ClaudeError, keyStore } from '../ai-shots/claude-client';
import { abortAnalysis, AbortedError, runAnalysis } from '../analysis/analysis-client';
import type { FloaterGroup, FloaterResult, FloaterStats } from '../analysis/floaters';
import { readLayerData } from '../analysis/splat-data';
import { Events } from '../events';
import type { Scene } from '../scene';
import type { Splat } from '../splat';
import { i18n } from '../ui/localization';

// "Find floaters" in the cleanup panel: the floater core (src/analysis/
// floaters.ts) runs in the analysis worker on the selected layer, its
// candidates become the selection (select.mask -> SelectOp, undoable) and a
// list of groups the user accepts or rejects. Strictness only moves the
// probability threshold, so it needs no new run. Nothing is deleted until the
// user asks; an optional Claude check sorts out real objects (cables,
// branches, lamps ...) from small rendered views of the groups.

// strictness levels, mild to strict: the probability a splat needs
const LEVELS = [0.85, 0.7, 0.5, 0.35, 0.2];
const DEFAULT_LEVEL = 2;
// groups the Claude check looks at, the largest first
const REVIEW_GROUPS = 12;

type Verdict = {
    verdict: 'floater' | 'object' | 'unsure',
    label: string,
    confidence: number
};

type GroupState = FloaterGroup & {
    accepted: boolean,
    // candidate splats at the current strictness
    countAt: number,
    verdict: Verdict | null
};

type FinderState = {
    splat: Splat,
    // the layer's instance count at the time of the search: any later change
    // (deleting, adding) makes the result stale
    instanceCount: number,
    // instance index of every data row
    instances: Uint32Array,
    probability: Uint8Array,
    reason: Uint8Array,
    group: Int32Array,
    // data rows with a probability
    candidates: Int32Array,
    groups: GroupState[],
    stats: FloaterStats
};

type FinderView = {
    running: boolean,
    reviewing: boolean,
    level: number,
    levels: number,
    // no result, or the layer changed since
    stale: boolean,
    layer: string | null,
    selected: number,
    total: number,
    groups: GroupState[],
    stats: FloaterStats | null,
    message: string,
    aiAvailable: boolean
};

const registerFloaterEvents = (events: Events, scene: Scene) => {
    let state: FinderState | null = null;
    let level = DEFAULT_LEVEL;
    let running = false;
    let reviewing = false;
    let message = '';
    let selected = 0;
    let applyTimer: ReturnType<typeof setTimeout> | null = null;
    let reviewAbort: AbortController | null = null;

    const isStale = () => !state || !state.splat.entity || state.splat.instances.count !== state.instanceCount;

    const view = (): FinderView => ({
        running,
        reviewing,
        level,
        levels: LEVELS.length,
        stale: isStale(),
        layer: state?.splat.name ?? null,
        selected,
        total: state?.instances.length ?? 0,
        groups: state && !isStale() ? state.groups.filter(g => g.countAt > 0) : [],
        stats: state?.stats ?? null,
        message,
        aiAvailable: aiAvailable()
    });

    const changed = () => events.fire('floaters.changed', view());

    // candidate counts per group at the current strictness
    const recount = () => {
        if (!state) return;
        const limit = Math.round(LEVELS[level] * 255);
        state.groups.forEach((g) => {
            g.countAt = 0;
        });
        const { candidates, probability, group } = state;
        for (let k = 0; k < candidates.length; k++) {
            const r = candidates[k];
            if (probability[r] >= limit) state.groups[group[r]].countAt++;
        }
    };

    // the accepted groups at the current strictness become the selection,
    // through the normal, undoable path
    const applySelection = () => {
        applyTimer = null;
        if (!state) return;
        if (isStale()) {
            message = i18n.t('sm.floaters.stale');
            changed();
            return;
        }
        const { splat, instances, probability, group, candidates, groups } = state;
        const limit = Math.round(LEVELS[level] * 255);
        const mask = new Uint8Array(splat.instances.count);
        let n = 0;
        for (let k = 0; k < candidates.length; k++) {
            const r = candidates[k];
            if (probability[r] >= limit && groups[group[r]].accepted) {
                mask[instances[r]] = 255;
                n++;
            }
        }
        if (events.invoke('selection') !== splat) events.fire('selection', splat);
        events.fire('select.mask', 'set', mask);
        selected = n;
        message = i18n.t('sm.floaters.selected', { count: n, groups: groups.filter(g => g.accepted && g.countAt > 0).length, total: instances.length });
        changed();
    };

    // slider drags and quick clicks become one undo step
    const scheduleApply = () => {
        if (applyTimer) clearTimeout(applyTimer);
        applyTimer = setTimeout(applySelection, 250);
    };

    const withProgress = async <T>(title: string, fn: () => Promise<T>): Promise<T | null> => {
        events.fire('progressStart', title, true);
        const cancel = events.on('progressCancel', () => abortAnalysis());
        try {
            return await fn();
        } catch (error) {
            if (error instanceof AbortedError) return null;
            throw error;
        } finally {
            cancel.off();
            events.fire('progressEnd');
        }
    };

    events.function('floaters.find', async () => {
        if (running) return null;
        const splat = events.invoke('selection') as Splat | null;
        if (!splat) {
            message = i18n.t('sm.cleanup.no-layer');
            changed();
            return null;
        }
        running = true;
        reviewAbort?.abort();
        message = i18n.t('sm.floaters.searching');
        changed();
        try {
            const title = i18n.t('sm.floaters.title');
            const result = await withProgress(title, async () => {
                events.fire('progressUpdate', { text: i18n.t('sm.floaters.reading'), progress: 2 });
                const data = await readLayerData(splat);
                const instanceCount = splat.instances.count;
                const instances = data.instances;
                const found = await runAnalysis<FloaterResult>('floaters', {
                    data: { positions: data.positions, scales: data.scales, opacities: data.opacities },
                    options: {}
                }, [data.positions.buffer as ArrayBuffer, data.scales.buffer as ArrayBuffer, data.opacities.buffer as ArrayBuffer], (p: number) => {
                    events.fire('progressUpdate', { text: `${title} …`, progress: 5 + 95 * p });
                });
                return { found, instances, instanceCount };
            });
            if (!result) {
                message = i18n.t('sm.floaters.cancelled');
                return null;
            }
            const { found, instances, instanceCount } = result;
            const candidates: number[] = [];
            for (let r = 0; r < found.probability.length; r++) if (found.probability[r] > 0) candidates.push(r);
            state = {
                splat,
                instanceCount,
                instances,
                probability: found.probability,
                reason: found.reason,
                group: found.group,
                candidates: Int32Array.from(candidates),
                groups: found.groups.map((g): GroupState => ({ ...g, accepted: true, countAt: 0, verdict: null })),
                stats: found.stats
            };
            recount();
            applySelection();
            return view();
        } catch (error) {
            message = `${i18n.t('sm.cleanup.failed')}: ${(error as Error).message ?? error}`;
            return null;
        } finally {
            running = false;
            changed();
        }
    });

    events.function('floaters.view', view);

    events.on('floaters.setLevel', (value: number) => {
        level = Math.max(0, Math.min(LEVELS.length - 1, Math.round(value)));
        if (!state) {
            changed();
            return;
        }
        recount();
        changed();
        scheduleApply();
    });

    events.on('floaters.setAccepted', (id: number, accepted: boolean) => {
        const g = state?.groups[id];
        if (!g) return;
        g.accepted = accepted;
        changed();
        scheduleApply();
    });

    events.on('floaters.acceptAll', (accepted: boolean) => {
        if (!state) return;
        state.groups.forEach((g) => {
            g.accepted = accepted;
        });
        changed();
        scheduleApply();
    });

    // fly to a group: along its best free view (see the floater core), else
    // from the side facing away from the structure next to it or along the
    // current view direction
    events.on('floaters.focus', (id: number) => {
        const g = state?.groups[id];
        if (!g) return;
        const center = new Vec3(g.center[0], g.center[1], g.center[2]);
        const view = g.views?.[0];
        if (view) {
            const position = new Vec3(view.dir[0], view.dir[1], view.dir[2]).mulScalar(view.distance).add(center);
            events.fire('camera.setPose', { position, target: center }, 1);
            return;
        }
        const radius = 0.5 * Math.hypot(g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]);
        const size = state.stats.sceneSize || 1;
        const distance = Math.max(3 * radius, 0.06 * size);
        const dir = new Vec3(g.away[0], g.away[1], g.away[2]);
        if (dir.lengthSq() < 0.5) {
            const pose = events.invoke('camera.getPose');
            if (pose?.position && pose?.target) dir.sub2(pose.position, pose.target);
            if (dir.lengthSq() < 1e-12) dir.set(0, 0.3, 1);
        }
        dir.normalize();
        // a little from above, so the floor does not hide it
        dir.y = Math.max(dir.y, 0.25);
        dir.normalize();
        const position = new Vec3().copy(dir).mulScalar(distance).add(center);
        events.fire('camera.setPose', { position, target: center }, 1);
    });

    // delete the current selection through the normal, undoable path; the
    // result is spent then (the instance list changes)
    events.function('floaters.delete', () => {
        if (!state || isStale()) return 0;
        if (applyTimer) {
            clearTimeout(applyTimer);
            applySelection();
        }
        const n = selected;
        if (n > 0) events.fire('select.delete');
        message = i18n.t('sm.floaters.deleted', { count: n });
        state = null;
        selected = 0;
        changed();
        return n;
    });

    events.on('floaters.clear', () => {
        reviewAbort?.abort();
        state = null;
        selected = 0;
        message = '';
        changed();
    });

    // optional Claude check: views of the largest accepted single pieces
    // (only a connected piece can be a real object; regions of stray specks
    // or fog cannot be shown sensibly and are artefacts anyway); groups
    // Claude takes for real objects are rejected (the user can take them back)
    events.function('floaters.review', async () => {
        if (!state || isStale() || reviewing || !aiAvailable()) return null;
        reviewing = true;
        reviewAbort = new AbortController();
        const signal = reviewAbort.signal;
        const candidates = state.groups
        .filter(g => g.countAt > 0 && g.accepted && g.single)
        .sort((a, b) => b.countAt - a.countAt)
        .slice(0, REVIEW_GROUPS);
        message = i18n.t('sm.floaters.review-rendering', { count: candidates.length });
        changed();
        try {
            const views = await renderGroupViews(events, candidates, state.stats, signal);
            if (signal.aborted) return null;
            message = i18n.t('sm.floaters.review-asking', { count: views.length });
            changed();
            const verdicts = await reviewGroupViews(views, i18n.locale, signal);
            if (!state) return null;
            let objects = 0;
            verdicts.forEach((v) => {
                const g = state.groups[v.id];
                if (!g) return;
                g.verdict = { verdict: v.verdict, label: v.label, confidence: v.confidence };
                if (v.verdict === 'object' && v.confidence >= 0.5) {
                    g.accepted = false;
                    objects++;
                }
            });
            message = i18n.t('sm.floaters.review-done', { checked: verdicts.length, objects });
            if (objects > 0) scheduleApply();
            return verdicts;
        } catch (error) {
            const code = error instanceof ClaudeError ? error.code : 'sm.aishots.err.api';
            message = `${i18n.t('sm.floaters.review-failed')} ${i18n.t(code)}`;
            return null;
        } finally {
            reviewing = false;
            reviewAbort = null;
            changed();
        }
    });

    events.on('floaters.cancelReview', () => reviewAbort?.abort());

    // a deleted layer drops its result
    events.on('scene.elementRemoved', (element: any) => {
        if (state && element === state.splat) {
            state = null;
            selected = 0;
            changed();
        }
    });

    // the Claude button follows the key (saved / cleared in the settings or
    // in another tab) and the connection
    events.on('aiShots.keyChanged', changed);
    keyStore.onChange(changed);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);

    // a panel built before these events were registered
    changed();
};

export { registerFloaterEvents, FinderView, GroupState, LEVELS };
