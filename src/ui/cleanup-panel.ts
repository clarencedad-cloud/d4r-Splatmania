import { BooleanInput, Container, Label, NumericInput, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { CollapsibleSection } from './collapsible';
import { helpButton } from './help';
import { i18n } from './localization';
import type { FinderView, GroupState } from '../floaters/floater-finder';

const row = (parent: Container, text: string, title?: string) => {
    const r = new Container({ class: 'layer-anim-row' });
    if (title) i18n.bindDom(r.dom, title, 'title');
    const label = new Label({ class: 'layer-anim-label' });
    i18n.bindText(label, text);
    r.append(label);
    parent.append(r);
    return r;
};

const button = (parent: Container, text: string, title: string, onClick: () => void) => {
    const b = document.createElement('span');
    b.classList.add('layer-anim-button');
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    i18n.bindDom(b, text);
    i18n.bindDom(b, title, 'title');
    b.addEventListener('click', onClick);
    b.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick();
        }
    });
    parent.dom.appendChild(b);
    return b;
};

const numeric = (parent: Container, value: number, min: number, max: number, precision: number) => {
    const n = new NumericInput({ value, min, max, precision, class: 'cleanup-number' });
    parent.append(n);
    return n;
};

const section = (parent: Container, text: string) => {
    const label = new Label({ class: 'cleanup-section' });
    i18n.bindText(label, text);
    parent.append(label);
};

const formatCount = (n: number) => n.toLocaleString(i18n.locale);

// cleanup on the active layer: the floater search (src/floaters) and the
// splat-transform filters and decimation (src/cleanup.ts)
class CleanupPanel extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'cleanup-panel',
            class: 'layer-anim-like'
        };

        super(args);

        const panelSection = new CollapsibleSection({ key: 'cleanup', title: 'sm.cleanup.title', icon: '', bodyClass: 'layer-anim-body', actions: [helpButton(events, 'cleanup')] });
        this.append(panelSection);
        const body = panelSection.body;

        // floaters: strictness, search, optional Claude check, group list
        section(body, 'sm.floaters.title');
        const levelRow = row(body, 'sm.floaters.strictness', 'sm.floaters.strictness-tip');
        const levelSlider = new SliderInput({ min: 1, max: 5, sliderMin: 1, sliderMax: 5, precision: 0, step: 1, value: 3 });
        levelRow.append(levelSlider);
        const levelName = new Label({ class: 'floater-level' });
        body.append(levelName);
        const syncLevelName = () => {
            levelName.text = i18n.t(`sm.floaters.level.${Math.round(levelSlider.value)}`);
        };
        i18n.onChange(syncLevelName);
        levelSlider.on('change', (v: number) => {
            syncLevelName();
            events.fire('floaters.setLevel', Math.round(v) - 1);
        });

        const fButtons = new Container({ class: 'layer-anim-buttons' });
        body.append(fButtons);
        const findButton = button(fButtons, 'sm.floaters.find', 'sm.floaters.find-tip', async () => {
            await events.invoke('floaters.find');
        });
        const reviewButton = button(fButtons, 'sm.floaters.review', 'sm.floaters.review-tip', async () => {
            const v = events.invoke('floaters.view') as FinderView;
            if (v.reviewing) {
                events.fire('floaters.cancelReview');
            } else {
                await events.invoke('floaters.review');
            }
        });

        const floaterResult = new Label({ class: 'cleanup-result' });
        body.append(floaterResult);

        const list = document.createElement('div');
        list.classList.add('floater-list');
        body.dom.appendChild(list);

        const listButtons = new Container({ class: 'layer-anim-buttons' });
        body.append(listButtons);
        button(listButtons, 'sm.floaters.all', 'sm.floaters.all-tip', () => events.fire('floaters.acceptAll', true));
        button(listButtons, 'sm.floaters.none', 'sm.floaters.none-tip', () => events.fire('floaters.acceptAll', false));
        const deleteButton = button(listButtons, 'sm.floaters.delete', 'sm.floaters.delete-tip', () => events.invoke('floaters.delete'));

        const kindText = (g: GroupState) => {
            const parts = [i18n.t(`sm.floaters.kind.${g.kind}`)];
            if (g.airborne) parts.push(i18n.t('sm.floaters.airborne'));
            return parts.join(' · ');
        };

        const verdictText = (g: GroupState) => {
            if (!g.verdict) return '';
            const label = g.verdict.label ? ` (${g.verdict.label})` : '';
            return i18n.t(`sm.floaters.verdict.${g.verdict.verdict}`) + label;
        };

        const renderList = (v: FinderView) => {
            list.textContent = '';
            const groups = v.groups.slice().sort((a, b) => b.countAt - a.countAt);
            list.classList.toggle('pcui-hidden', groups.length === 0);
            groups.forEach((g) => {
                const item = document.createElement('div');
                item.classList.add('floater-item');
                item.classList.toggle('rejected', !g.accepted);

                const check = document.createElement('span');
                check.classList.add('floater-check');
                check.setAttribute('role', 'checkbox');
                check.setAttribute('aria-checked', String(g.accepted));
                check.textContent = g.accepted ? '✓' : '';
                check.title = i18n.t(g.accepted ? 'sm.floaters.reject-tip' : 'sm.floaters.accept-tip');
                check.addEventListener('click', () => events.fire('floaters.setAccepted', g.id, !g.accepted));

                const text = document.createElement('span');
                text.classList.add('floater-text');
                text.setAttribute('role', 'button');
                text.textContent = `${kindText(g)} · ${formatCount(g.countAt)}`;
                text.title = i18n.t('sm.floaters.item-tip');
                text.addEventListener('click', () => events.fire('floaters.focus', g.id));

                item.appendChild(check);
                item.appendChild(text);

                const verdict = verdictText(g);
                if (verdict) {
                    const badge = document.createElement('span');
                    badge.classList.add('floater-verdict', g.verdict.verdict);
                    badge.textContent = verdict;
                    item.appendChild(badge);
                }

                const focus = document.createElement('span');
                focus.classList.add('floater-focus');
                focus.setAttribute('role', 'button');
                focus.textContent = '⌖';
                focus.title = i18n.t('sm.floaters.item-tip');
                focus.addEventListener('click', () => events.fire('floaters.focus', g.id));
                item.appendChild(focus);

                list.appendChild(item);
            });
        };

        let lastView: FinderView | null = null;
        const sync = (v: FinderView = events.invoke('floaters.view')) => {
            if (!v) return;
            lastView = v;
            findButton.classList.toggle('disabled', v.running);
            reviewButton.classList.toggle('pcui-hidden', !v.aiAvailable);
            reviewButton.classList.toggle('disabled', v.running || v.stale);
            reviewButton.textContent = i18n.t(v.reviewing ? 'sm.floaters.review-cancel' : 'sm.floaters.review');
            deleteButton.classList.toggle('disabled', v.stale || v.selected === 0);
            listButtons.hidden = v.stale;
            floaterResult.text = v.message || i18n.t('sm.floaters.hint');
            renderList(v);
        };
        events.on('floaters.changed', (v: FinderView) => sync(v));
        i18n.onChange(() => {
            if (lastView) sync(lastView);
        });
        // at startup the floater events register after the ui and sync it then
        if (events.functions.has('floaters.view')) sync();

        // the remaining splat-transform tools
        const deleteRow = row(body, 'sm.cleanup.delete-now', 'sm.cleanup.delete-now-tip');
        const deleteNow = new BooleanInput({ value: false });
        deleteRow.append(deleteNow);

        // the hint until the first result, then the latest result
        const result = new Label({ class: 'cleanup-result' });
        let hasResult = false;
        i18n.onChange(() => {
            if (!hasResult) result.text = i18n.t('sm.cleanup.hint');
        });

        const finish = (r: any) => {
            if (!r) return;
            hasResult = true;
            if (r.filename) {
                result.text = i18n.t('sm.cleanup.result.decimate', { total: r.total, kept: r.kept });
                return;
            }
            const note = r.log?.length ? ` · ${r.log[r.log.length - 1]}` : '';
            result.text = `${i18n.t(deleteNow.value ? 'sm.cleanup.result.deleted' : 'sm.cleanup.result.selected', { title: r.title, dropped: r.dropped, total: r.total })}${note}`;
            if (deleteNow.value && r.dropped > 0) events.fire('select.delete');
        };

        // invalid splats
        section(body, 'sm.cleanup.nan-title');
        const nButtons = new Container({ class: 'layer-anim-buttons' });
        body.append(nButtons);
        button(nButtons, 'sm.cleanup.nan', 'sm.cleanup.nan-tip', async () => finish(await events.invoke('cleanup.filterNaN')));

        // cluster
        section(body, 'sm.cleanup.cluster');
        const cRow = row(body, 'sm.cleanup.voxel', 'sm.cleanup.cluster-voxel-tip');
        const cRes = numeric(cRow, 1.0, 0.01, 100, 2);
        const cOpacity = numeric(cRow, 0.999, 0, 1, 3);
        const cMin = numeric(cRow, 0.1, 0, 1, 3);
        i18n.bindDom(cRes.dom, 'sm.cleanup.cluster-res-tip', 'title');
        i18n.bindDom(cOpacity.dom, 'sm.cleanup.cluster-opacity-tip', 'title');
        i18n.bindDom(cMin.dom, 'sm.cleanup.cluster-min-tip', 'title');
        const seedRow = row(body, 'sm.cleanup.seed', 'sm.cleanup.seed-tip');
        const sx = numeric(seedRow, 0, -1e6, 1e6, 2);
        const sy = numeric(seedRow, 0, -1e6, 1e6, 2);
        const sz = numeric(seedRow, 0, -1e6, 1e6, 2);
        const setSeed = (v: { x: number, y: number, z: number } | undefined) => {
            if (!v) return;
            sx.value = v.x;
            sy.value = v.y;
            sz.value = v.z;
        };
        const cButtons = new Container({ class: 'layer-anim-buttons' });
        body.append(cButtons);
        button(cButtons, 'sm.cleanup.seed-pivot', 'sm.cleanup.seed-pivot-tip', () => setSeed(events.invoke('pivot')?.transform?.position));
        button(cButtons, 'sm.cleanup.seed-focus', 'sm.cleanup.seed-focus-tip', () => setSeed(events.invoke('camera.getPose')?.target));
        button(cButtons, 'sm.cleanup.find-outside', 'sm.cleanup.find-outside-tip', async () => {
            finish(await events.invoke('cleanup.filterCluster', {
                voxelResolution: cRes.value, opacityCutoff: cOpacity.value, minContribution: cMin.value, seed: [sx.value, sy.value, sz.value]
            }));
        });

        // decimate
        section(body, 'sm.cleanup.decimate');
        const dRow = row(body, 'sm.cleanup.keep', 'sm.cleanup.keep-tip');
        const dPercent = numeric(dRow, 50, 1, 100, 0);
        const countLabel = new Label({ class: 'layer-anim-label' });
        i18n.bindText(countLabel, 'sm.cleanup.or-count');
        dRow.append(countLabel);
        const dCount = numeric(dRow, 0, 0, 1e9, 0);
        i18n.bindDom(dCount.dom, 'sm.cleanup.count-tip', 'title');
        const dOpt = row(body, 'sm.cleanup.adaptive', 'sm.cleanup.adaptive-tip');
        const dAdaptive = new BooleanInput({ value: false });
        dOpt.append(dAdaptive);
        const bandsLabel = new Label({ class: 'layer-anim-label' });
        i18n.bindText(bandsLabel, 'sm.cleanup.sh-bands');
        dOpt.append(bandsLabel);
        const dBands = numeric(dOpt, -1, -1, 3, 0);
        i18n.bindDom(dBands.dom, 'sm.cleanup.sh-bands-tip', 'title');
        const dButtons = new Container({ class: 'layer-anim-buttons' });
        body.append(dButtons);
        button(dButtons, 'sm.cleanup.run-decimate', 'sm.cleanup.run-decimate-tip', async () => {
            finish(await events.invoke('cleanup.decimate', {
                percent: dPercent.value,
                count: dCount.value > 0 ? dCount.value : null,
                adaptive: dAdaptive.value,
                shBands: dBands.value >= 0 ? dBands.value : null
            }));
        });

        body.append(result);
    }
}

export { CleanupPanel };
