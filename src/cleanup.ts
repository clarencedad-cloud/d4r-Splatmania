import {
    Column,
    DataTable,
    MemoryFileSystem,
    decimateSourceAdaptive,
    logger,
    materializeToDataTable,
    processDataTable,
    writePly,
    type LogEvent,
    type ProcessAction
} from '@playcanvas/splat-transform';
import { Vec3 } from 'playcanvas';

import { Events } from './events';
import type { Scene } from './scene';
import type { Splat } from './splat';
import { createExportSource } from './splat-serialize';

// splat-transform cleanup on the active layer. Filters (floaters, cluster,
// NaN) don't touch the data: the gaussians they would remove are selected,
// and deleting goes through the normal, undoable editor path. Decimate makes
// new gaussians, so its result becomes a new layer and the original is hidden.

type FloaterOptions = { voxelResolution: number, opacityCutoff: number, minContribution: number };
type ClusterOptions = { voxelResolution: number, opacityCutoff: number, minContribution: number, seed: [number, number, number] };
type DecimateOptions = { percent: number | null, count: number | null, adaptive: boolean, shBands: number | null };

// a column carrying each row's editor instance index through the filters,
// which clone the table with the kept rows (all columns included)
const INDEX_COLUMN = 'editor_instance';

const registerCleanupEvents = (events: Events, scene: Scene) => {
    let running = false;
    let cancelled = false;
    // splat-transform log messages of the current run (e.g. why a filter
    // removed nothing)
    let messages: string[] = [];

    events.on('progressCancel', () => {
        cancelled = true;
    });

    const active = () => events.invoke('selection') as Splat | null;

    const fail = async (message: string) => {
        await events.invoke('showPopup', { type: 'error', header: 'Bereinigen fehlgeschlagen', message });
    };

    // the layer as a world-space DataTable, one row per live instance
    const layerTable = async (splat: Splat) => {
        const built = await createExportSource([splat], {});
        if (!built) throw new Error('Der Layer enthält keine Splats.');
        const table = await materializeToDataTable(built.source, built.pool);
        const index = new Float32Array(table.numRows);
        for (let i = 0; i < index.length; i++) index[i] = i;
        table.addColumn(new Column(INDEX_COLUMN, index));
        return table;
    };

    // run with progress, cancel and the WebGPU requirement for voxel filters
    const run = async <T>(title: string, needsGpu: boolean, fn: () => Promise<T>): Promise<T | null> => {
        if (running) return null;
        const splat = active();
        if (!splat) {
            await fail('Bitte zuerst einen Layer auswählen.');
            return null;
        }
        if (needsGpu && !scene.graphicsDevice.isWebGPU) {
            await fail('Diese Funktion braucht WebGPU (GPU-Voxelisierung). Bitte einen Browser mit WebGPU verwenden.');
            return null;
        }
        running = true;
        cancelled = false;
        messages = [];
        events.fire('progressStart', title, true);
        events.fire('progressUpdate', { text: `${title} …`, progress: 10 });
        // splat-transform reports its steps and progress bars to the logger
        logger.setRenderer({
            handle: (event: LogEvent) => {
                if (event.kind === 'message') {
                    messages.push(event.text);
                } else if (event.kind === 'barTick' && event.total > 0) {
                    events.fire('progressUpdate', { text: `${title}: ${event.name}`, progress: 10 + 80 * event.current / event.total });
                }
            }
        });
        try {
            const result = await fn();
            return cancelled ? null : result;
        } catch (error) {
            await fail(`${(error as Error).message ?? error}`);
            return null;
        } finally {
            events.fire('progressEnd');
            running = false;
        }
    };

    // select the instances a filter drops: kept rows carry their index
    const selectDropped = (splat: Splat, kept: DataTable) => {
        const count = splat.instances.count;
        const mask = new Uint8Array(count).fill(255);
        const index = kept.getColumnByName(INDEX_COLUMN).data;
        for (let i = 0; i < index.length; i++) mask[index[i]] = 0;
        let dropped = 0;
        for (let i = 0; i < count; i++) if (mask[i]) dropped++;
        events.fire('select.mask', 'set', mask);
        return { total: count, dropped, kept: count - dropped };
    };

    // splat-transform only destroys its own voxelization resources, so the
    // editor device can be shared
    const createDevice = () => Promise.resolve(scene.graphicsDevice);

    const filter = async (title: string, action: ProcessAction, needsGpu: boolean) => {
        return await run(title, needsGpu, async () => {
            const splat = active();
            const table = await layerTable(splat);
            events.fire('progressUpdate', { text: `${title}: ${table.numRows} Splats …`, progress: 40 });
            const kept = await processDataTable(table, [action], { createDevice });
            if (cancelled) return null;
            const result = { ...selectDropped(splat, kept), log: messages.slice() };
            events.fire('cleanup.result', { title, ...result });
            return result;
        });
    };

    events.function('cleanup.filterFloaters', (options: Partial<FloaterOptions> = {}) => {
        return filter('Floater entfernen', {
            kind: 'filterFloaters',
            voxelResolution: options.voxelResolution ?? 0.05,
            opacityCutoff: options.opacityCutoff ?? 0.1,
            minContribution: options.minContribution ?? 1 / 255
        }, true);
    });

    events.function('cleanup.filterCluster', (options: Partial<ClusterOptions> = {}) => {
        const seed = options.seed ?? [0, 0, 0];
        return filter('Cluster behalten', {
            kind: 'filterCluster',
            voxelResolution: options.voxelResolution ?? 1.0,
            opacityCutoff: options.opacityCutoff ?? 0.999,
            minContribution: options.minContribution ?? 0.1,
            seed: new Vec3(seed[0], seed[1], seed[2])
        }, true);
    });

    events.function('cleanup.filterNaN', () => {
        return filter('Ungültige Splats (NaN)', { kind: 'filterNaN' }, false);
    });

    // decimate (and optionally reduce SH bands) into a new layer
    events.function('cleanup.decimate', (options: Partial<DecimateOptions> = {}) => {
        return run('Decimate', false, async () => {
            const splat = active();
            const built = await createExportSource([splat], {});
            if (!built) throw new Error('Der Layer enthält keine Splats.');
            const before = splat.instances.count;
            const target = options.count ?? Math.max(1, Math.round(before * (options.percent ?? 50) / 100));
            events.fire('progressUpdate', { text: `Decimate: ${before} → ${target} Splats …`, progress: 30 });

            let table: DataTable;
            if (options.adaptive) {
                const decimated = await decimateSourceAdaptive(built.source, built.pool, { targetCount: target, createDevice });
                table = await materializeToDataTable(decimated, built.pool);
            } else {
                table = await materializeToDataTable(built.source, built.pool);
                table = await processDataTable(table, [{ kind: 'decimate', count: target, percent: null }]);
            }
            if (options.shBands !== null && options.shBands !== undefined) {
                table = await processDataTable(table, [{ kind: 'filterBands', value: options.shBands as 0 | 1 | 2 | 3 }]);
            }
            if (cancelled) return null;

            // write a PLY in memory and import it as a new layer
            events.fire('progressUpdate', { text: 'Neuen Layer anlegen …', progress: 80 });
            const fs = new MemoryFileSystem();
            const base = splat.name.replace(/\.[^.]*$/, '').replace(/^\//, '');
            const filename = `${base}_decimate_${table.numRows}.ply`;
            await writePly({ filename, plyData: { comments: [], elements: [{ name: 'vertex', dataTable: table }] } }, fs);
            const bytes = fs.results.get(filename);
            const file = new File([bytes as Uint8Array<ArrayBuffer>], filename);
            await events.invoke('import', [{ filename, contents: file }]);

            // keep the original, hidden, so the result can be compared or undone
            splat.visible = false;
            const result = { title: 'Decimate', total: before, kept: table.numRows, dropped: before - table.numRows, filename };
            events.fire('cleanup.result', result);
            return result;
        });
    });

    events.function('cleanup.running', () => running);
};

export { registerCleanupEvents };
