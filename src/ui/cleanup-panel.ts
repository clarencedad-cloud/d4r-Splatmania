import { BooleanInput, Container, Label, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';

const row = (parent: Container, text: string, title?: string) => {
    const r = new Container({ class: 'layer-anim-row' });
    if (title) r.dom.title = title;
    r.append(new Label({ text, class: 'layer-anim-label' }));
    parent.append(r);
    return r;
};

const button = (parent: Container, text: string, title: string, onClick: () => void) => {
    const b = document.createElement('span');
    b.classList.add('layer-anim-button');
    b.textContent = text;
    b.title = title;
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
    parent.append(new Label({ text, class: 'cleanup-section' }));
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

        const header = new Container({ class: 'panel-header' });
        header.append(new Label({ text: '', class: 'panel-header-icon' }));
        header.append(new Label({ text: 'BEREINIGEN (splat-transform)', class: 'panel-header-label' }));
        this.append(header);

        const body = new Container({ class: 'layer-anim-body' });
        this.append(body);

        const deleteRow = row(body, 'Direkt löschen', 'Aus: Betroffene Splats werden nur ausgewählt (dann Entf). An: sofort löschen (mit Undo)');
        const deleteNow = new BooleanInput({ value: false });
        deleteRow.append(deleteNow);

        const result = new Label({ text: 'Wirkt auf den ausgewählten Layer.', class: 'cleanup-result' });

        const finish = (r: any) => {
            if (!r) return;
            if (r.title === 'Decimate') {
                result.text = `Decimate: ${r.total} → ${r.kept} Splats (neuer Layer, Original ausgeblendet)`;
                return;
            }
            const note = r.log?.length ? ` · ${r.log[r.log.length - 1]}` : '';
            result.text = `${r.title}: ${r.dropped} von ${r.total} Splats betroffen${deleteNow.value ? ' und gelöscht' : ' (ausgewählt)'}${note}`;
            if (deleteNow.value && r.dropped > 0) events.fire('select.delete');
        };

        // floaters
        section(body, 'Floater entfernen');
        const fRow = row(body, 'Voxel / Deckk. / Min', 'Voxelgröße (Welteinheiten), Deckkraft-Schwelle solider Voxel, minimaler Beitrag');
        const fRes = numeric(fRow, 0.05, 0.001, 100, 3);
        const fOpacity = numeric(fRow, 0.1, 0, 1, 3);
        const fMin = numeric(fRow, 0.004, 0, 1, 4);
        const fButtons = new Container({ class: 'layer-anim-buttons' });
        body.append(fButtons);
        button(fButtons, 'Floater finden', 'Splats, die zu keinem soliden Voxel beitragen (GPU)', async () => {
            finish(await events.invoke('cleanup.filterFloaters', { voxelResolution: fRes.value, opacityCutoff: fOpacity.value, minContribution: fMin.value }));
        });
        button(fButtons, 'NaN-Splats', 'Splats mit ungültigen Werten', async () => finish(await events.invoke('cleanup.filterNaN')));

        // cluster
        section(body, 'Cluster behalten');
        const cRow = row(body, 'Voxel / Deckk. / Min', 'Grobe Voxelgröße, Deckkraft-Schwelle, minimaler Beitrag');
        const cRes = numeric(cRow, 1.0, 0.01, 100, 2);
        const cOpacity = numeric(cRow, 0.999, 0, 1, 3);
        const cMin = numeric(cRow, 0.1, 0, 1, 3);
        const seedRow = row(body, 'Seed', 'Startpunkt des Clusters in Weltkoordinaten');
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
        button(cButtons, 'Seed = Pivot', 'Seed auf die Pivot-Position (Transform-Gizmo bzw. Pick) setzen', () => setSeed(events.invoke('pivot')?.transform?.position));
        button(cButtons, 'Seed = Fokus', 'Seed auf den Fokuspunkt der Kamera setzen (z. B. nach Doppelklick in die Szene)', () => setSeed(events.invoke('camera.getPose')?.target));
        button(cButtons, 'Außerhalb finden', 'Alles außerhalb des zusammenhängenden Clusters am Seed (GPU)', async () => {
            finish(await events.invoke('cleanup.filterCluster', {
                voxelResolution: cRes.value, opacityCutoff: cOpacity.value, minContribution: cMin.value, seed: [sx.value, sy.value, sz.value]
            }));
        });

        // decimate
        section(body, 'Decimate (neuer Layer)');
        const dRow = row(body, 'Behalten %', 'Prozent der Splats, die übrig bleiben');
        const dPercent = numeric(dRow, 50, 1, 100, 0);
        dRow.append(new Label({ text: 'oder Anzahl', class: 'layer-anim-label' }));
        const dCount = numeric(dRow, 0, 0, 1e9, 0);
        const dOpt = row(body, 'Adaptiv', 'Adaptive Verteilung (mehr Detail, wo es zählt) statt gleichmäßiger Rate');
        const dAdaptive = new BooleanInput({ value: false });
        dOpt.append(dAdaptive);
        dOpt.append(new Label({ text: 'SH-Bänder', class: 'layer-anim-label' }));
        const dBands = numeric(dOpt, -1, -1, 3, 0);
        dBands.dom.title = '-1 = behalten, sonst maximale Bandzahl 0–3';
        const dButtons = new Container({ class: 'layer-anim-buttons' });
        body.append(dButtons);
        button(dButtons, 'Decimate ausführen', 'Vereinfacht den Layer zu einem neuen Layer; das Original wird ausgeblendet', async () => {
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
