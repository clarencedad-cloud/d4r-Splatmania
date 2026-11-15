import { BooleanInput, Container, Label, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { CollapsibleSection } from './collapsible';
import { helpButton } from './help';
import { i18n } from './localization';

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
    i18n.bindDom(b, text);
    i18n.bindDom(b, title, 'title');
    b.addEventListener('click', onClick);
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

// splat-transform cleanup on the active layer (src/cleanup.ts)
class CleanupPanel extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'cleanup-panel',
            class: 'layer-anim-like'
        };

        super(args);

        const panelSection = new CollapsibleSection({ key: 'cleanup', title: 'sm.cleanup.title', icon: '', bodyClass: 'layer-anim-body', actions: [helpButton(events, 'cleanup')] });
        panelSection.setInfo('splat-transform');
        this.append(panelSection);
        const body = panelSection.body;

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

        // floaters
        section(body, 'sm.cleanup.floaters');
        const fRow = row(body, 'sm.cleanup.voxel', 'sm.cleanup.floaters-voxel-tip');
        const fRes = numeric(fRow, 0.05, 0.001, 100, 3);
        const fOpacity = numeric(fRow, 0.1, 0, 1, 3);
        const fMin = numeric(fRow, 0.004, 0, 1, 4);
        const fButtons = new Container({ class: 'layer-anim-buttons' });
        body.append(fButtons);
        button(fButtons, 'sm.cleanup.find-floaters', 'sm.cleanup.find-floaters-tip', async () => {
            finish(await events.invoke('cleanup.filterFloaters', { voxelResolution: fRes.value, opacityCutoff: fOpacity.value, minContribution: fMin.value }));
        });
        button(fButtons, 'sm.cleanup.nan', 'sm.cleanup.nan-tip', async () => finish(await events.invoke('cleanup.filterNaN')));

        // cluster
        section(body, 'sm.cleanup.cluster');
        const cRow = row(body, 'sm.cleanup.voxel', 'sm.cleanup.cluster-voxel-tip');
        const cRes = numeric(cRow, 1.0, 0.01, 100, 2);
        const cOpacity = numeric(cRow, 0.999, 0, 1, 3);
        const cMin = numeric(cRow, 0.1, 0, 1, 3);
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
