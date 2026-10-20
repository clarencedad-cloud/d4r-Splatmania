import { Container, Label, SliderInput } from '@playcanvas/pcui';
import { BUFFERUSAGE_COPY_DST, BUFFERUSAGE_COPY_SRC, StorageBuffer } from 'playcanvas';

import { DEFAULT_WEIGHTS, type CompareResult, type QualityWeights } from './quality-score';
import { abortAnalysis, AbortedError, runAnalysis } from '../analysis/analysis-client';
import { readLayerData, type LayerData } from '../analysis/splat-data';
import { ElementType } from '../element';
import { Events } from '../events';
import type { Scene } from '../scene';
import type { Splat } from '../splat';

// Quality tool: per-splat quality scores (0 bad .. 1 good) shown as a heatmap
// in the splat renderer (display only, the data is untouched), a threshold to
// select the bad splats through the normal, undoable selection, and a scan
// comparison that flags splats where another visible layer is sharper.
//
// The scores themselves come from the scoring core (src/quality/quality-score.ts,
// built in the main session). It plugs in via the 'quality.computeScores'
// function; until it is registered the panel says so. Scores arrive through
// 'quality.setScores' (per layer, Float32Array indexed by instance) and
// 'quality.setWorse' (per layer, Uint8Array: 1 = worse than another scan).

type QualityMode = 'off' | 'heatmap' | 'threshold' | 'compare';

type LayerQuality = {
    count: number,
    scores: Uint8Array | null,
    worse: Uint8Array | null,
    // one gpu buffer per layer, rewritten when the data or the mode changes:
    // the projector's bind group keeps the buffer it was first given, so
    // swapping buffers between modes would not reach the shader
    displayBuffer: StorageBuffer | null,
    // what the display buffer currently holds
    displays: 'scores' | 'worse' | null
};

const MODE_IDS: Record<QualityMode, number> = { off: 0, heatmap: 1, threshold: 2, compare: 2 };

class QualityTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const layers = new Map<Splat, LayerQuality>();
        let mode: QualityMode = 'heatmap';
        // 0.3: the scores are relative, 0.5 flags too much of a real scan
        let threshold = 0.3;
        // score weights (core defaults), comparison voxel (0 = automatic) and tolerance
        // the core's defaults, so the panel and the core never drift apart
        const weights: QualityWeights = { ...DEFAULT_WEIGHTS };
        let compareVoxel = 0;
        let margin = 0.15;
        let active = false;

        const device = scene.graphicsDevice;

        // bytes padded to whole u32 words, the layout the projector reads
        const upload = (bytes: Uint8Array, existing: StorageBuffer | null) => {
            const size = Math.max(4, Math.ceil(bytes.length / 4) * 4);
            let buffer = existing;
            if (!buffer || buffer.byteSize !== size) {
                buffer?.destroy();
                buffer = new StorageBuffer(device, size, BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC);
            }
            const padded = new Uint8Array(size);
            padded.set(bytes);
            buffer.write(0, padded, 0, size);
            return buffer;
        };

        const entry = (splat: Splat) => {
            let e = layers.get(splat);
            if (!e) {
                e = { count: 0, scores: null, worse: null, displayBuffer: null, displays: null };
                layers.set(splat, e);
            }
            return e;
        };

        // write what the current mode shows into the layer's display buffer
        const refreshDisplay = (e: LayerQuality) => {
            const want = mode === 'compare' ? 'worse' : 'scores';
            const source = want === 'worse' ? e.worse : e.scores;
            if (!source) return;
            if (e.displays === want && e.displayBuffer) return;
            let bytes = source;
            if (want === 'worse') {
                // stored inverted (0 = worse) so the shader's "under
                // threshold" test at 0.5 marks exactly the flagged splats
                bytes = new Uint8Array(source.length);
                for (let i = 0; i < source.length; i++) bytes[i] = source[i] ? 0 : 255;
            }
            e.displayBuffer = upload(bytes, e.displayBuffer);
            e.displays = want;
        };

        const changed = () => {
            layers.forEach(refreshDisplay);
            events.fire('quality.changed');
            scene.forceRender = true;
        };

        // api for the scoring core / worker wiring

        events.function('quality.setScores', (splat: Splat, scores: Float32Array) => {
            const e = entry(splat);
            const bytes = new Uint8Array(scores.length);
            for (let i = 0; i < scores.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, scores[i])) * 255);
            e.count = scores.length;
            e.scores = bytes;
            e.displays = null;
            changed();
        });

        events.function('quality.setWorse', (splat: Splat, worse: Uint8Array) => {
            const e = entry(splat);
            e.count = worse.length;
            e.worse = worse;
            e.displays = null;
            changed();
        });

        events.function('quality.scores', (splat: Splat) => layers.get(splat)?.scores ?? null);

        // what the renderer binds for a layer: null = no heatmap
        events.function('quality.renderParams', (splat: Splat) => {
            if (!active || mode === 'off') return null;
            const e = layers.get(splat);
            // scores are per instance; stale after the instance list changed
            if (!e || e.count !== splat.instances.count) return null;
            const want = mode === 'compare' ? 'worse' : 'scores';
            if (!e.displayBuffer || e.displays !== want) return null;
            return mode === 'compare' ?
                { buffer: e.displayBuffer, mode: MODE_IDS.compare, threshold: 0.5 } :
                { buffer: e.displayBuffer, mode: MODE_IDS[mode], threshold };
        });

        // selection through the normal, undoable path (select.mask -> SelectOp)
        const selectWhere = (splat: Splat, test: (i: number) => boolean) => {
            const count = splat.instances.count;
            const mask = new Uint8Array(count);
            let n = 0;
            for (let i = 0; i < count; i++) {
                if (test(i)) {
                    mask[i] = 255;
                    n++;
                }
            }
            if (events.invoke('selection') !== splat) events.fire('selection', splat);
            events.fire('select.mask', 'set', mask);
            return n;
        };

        events.function('quality.selectBelow', (splat: Splat) => {
            const e = layers.get(splat);
            if (!e?.scores || e.count !== splat.instances.count) return null;
            const limit = Math.round(threshold * 255);
            return selectWhere(splat, i => e.scores[i] < limit);
        });

        events.function('quality.selectWorse', (splat: Splat) => {
            const e = layers.get(splat);
            if (!e?.worse || e.count !== splat.instances.count) return null;
            return selectWhere(splat, i => e.worse[i] !== 0);
        });

        events.function('quality.mode', () => mode);
        events.on('quality.setMode', (value: QualityMode) => {
            mode = value;
            changed();
        });
        events.function('quality.threshold', () => threshold);
        events.on('quality.setThreshold', (value: number) => {
            threshold = value;
            changed();
        });

        events.on('scene.elementRemoved', (element: any) => {
            const e = layers.get(element);
            if (e) {
                e.displayBuffer?.destroy();
                layers.delete(element);
            }
        });

        // scoring through the analysis worker (src/quality/quality-score.ts)

        const visibleLayers = () => (scene.getElementsByType(ElementType.splat) as Splat[]).filter(s => s.visible);

        // per-row results back to per-instance arrays (skipped instances stay good)
        const toInstances = (splat: Splat, data: LayerData, rows: ArrayLike<number>, fill: number, Type: any) => {
            const out = new Type(splat.instances.count).fill(fill);
            for (let i = 0; i < data.instances.length; i++) out[data.instances[i]] = rows[i];
            return out;
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

        events.function('quality.computeScores', () => withProgress('Qualität: Scores', async () => {
            const layersNow = visibleLayers();
            let low = 0;
            let total = 0;
            for (let li = 0; li < layersNow.length; li++) {
                const splat = layersNow[li];
                events.fire('progressUpdate', { text: `Scores: ${splat.name}`, progress: 100 * li / layersNow.length });
                const data = await readLayerData(splat);
                const rows = await runAnalysis<Float32Array>('score', {
                    data: { positions: data.positions, scales: data.scales, opacities: data.opacities },
                    options: { weights }
                });
                const scores = toInstances(splat, data, rows, 1, Float32Array);
                events.invoke('quality.setScores', splat, scores);
                for (let i = 0; i < rows.length; i++) if (rows[i] < threshold) low++;
                total += rows.length;
            }
            if (mode === 'off' || mode === 'compare') events.fire('quality.setMode', 'heatmap');
            return { text: `${layersNow.length} Layer bewertet · ${low} von ${total} Splats unter ${threshold.toFixed(2)}` };
        }));

        events.function('quality.compareScans', () => withProgress('Qualität: Scan-Vergleich', async () => {
            const layersNow = visibleLayers();
            if (layersNow.length < 2) return { text: 'Für den Vergleich mindestens zwei sichtbare Layer.' };
            const datas: LayerData[] = [];
            for (const splat of layersNow) datas.push(await readLayerData(splat));
            events.fire('progressUpdate', { text: 'Vergleich läuft …', progress: 50 });
            const result = await runAnalysis<CompareResult>('compare', {
                layers: datas.map(d => ({ positions: d.positions, scales: d.scales, opacities: d.opacities })),
                options: { weights, margin, voxel: compareVoxel > 0 ? compareVoxel : undefined }
            });
            layersNow.forEach((splat, i) => {
                events.invoke('quality.setScores', splat, toInstances(splat, datas[i], result.scores[i], 1, Float32Array));
                events.invoke('quality.setWorse', splat, toInstances(splat, datas[i], result.marked[i], 0, Uint8Array));
            });
            events.fire('quality.setMode', 'compare');
            const parts = layersNow.map((s, i) => `${s.name}: ${result.markedCount[i]}`).join(' · ');
            events.fire('quality.compared', result.voxel);
            return { text: `Raster ${result.voxel.toFixed(3)} · ${result.overlapVoxels} überlappende Voxel · markiert ${parts}`, result };
        }));

        // panel

        const panel = new Container({ id: 'quality-panel', hidden: true });
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'keydown'].forEach((name) => {
            panel.dom.addEventListener(name, e => e.stopPropagation());
        });
        canvasContainer.append(panel);

        panel.append(new Label({ text: 'QUALITÄT', class: 'quality-title' }));

        const row = (text: string) => {
            const r = new Container({ class: 'quality-row' });
            r.append(new Label({ text, class: 'quality-label' }));
            panel.append(r);
            return r;
        };

        const buttonRow = () => {
            const r = new Container({ class: 'quality-row' });
            panel.append(r);
            return r;
        };

        const button = (parent: Container, text: string, title: string, onClick: () => void) => {
            const b = document.createElement('span');
            b.classList.add('quality-button');
            b.textContent = text;
            b.title = title;
            b.addEventListener('click', onClick);
            parent.dom.appendChild(b);
            return b;
        };

        const modeRow = row('Anzeige');
        modeRow.dom.title = 'Heatmap ist relativ: Sie zeigt die schwächsten Bereiche dieses Scans. Ob ein Scan an einer Stelle schärfer ist als ein anderer, zeigt der Vergleich.';
        const modeButtons = ([['off', 'Aus'], ['heatmap', 'Heatmap'], ['threshold', 'Unter Schwelle'], ['compare', 'Vergleich']] as [QualityMode, string][]).map(([value, text]) => {
            const b = button(modeRow, text, '', () => events.fire('quality.setMode', value));
            b.classList.add('quality-segment');
            b.dataset.value = value;
            return b;
        });

        const heatmapHint = new Label({ text: 'Heatmap ist relativ (schwächste Bereiche dieses Scans). Welcher Scan wo schärfer ist: „Scans vergleichen“.', class: 'quality-note' });
        panel.append(heatmapHint);

        const thresholdRow = row('Schwelle');
        const thresholdSlider = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: threshold });
        thresholdSlider.on('change', (v: number) => events.fire('quality.setThreshold', v));
        thresholdRow.append(thresholdSlider);

        const slider = (text: string, title: string, min: number, max: number, value: number, onChange: (v: number) => void, precision = 2) => {
            const r = row(text);
            r.dom.title = title;
            const sl = new SliderInput({ min, max, sliderMin: min, sliderMax: max, precision, step: 0.01, value });
            sl.on('change', onChange);
            r.append(sl);
            return sl;
        };
        slider('Größe', 'Gewicht: große, weiche Splats', 0, 2, weights.size, (v) => {
            weights.size = v;
        });
        slider('Deckkraft', 'Gewicht: niedrige Deckkraft', 0, 2, weights.opacity, (v) => {
            weights.opacity = v;
        });
        slider('Nadeln', 'Gewicht: starke Anisotropie', 0, 2, weights.anisotropy, (v) => {
            weights.anisotropy = v;
        });
        slider('Dichte', 'Gewicht: geringe lokale Dichte', 0, 2, weights.density, (v) => {
            weights.density = v;
        });
        // 0 = automatic (the core adapts it to the splat density); after a
        // comparison the hint shows the grid that was actually used
        const rasterHint = new Label({ text: 'auto', class: 'quality-hint' });
        let usedVoxel: number | null = null;
        const syncRasterHint = () => {
            const used = usedVoxel !== null ? usedVoxel.toFixed(3) : '';
            rasterHint.text = compareVoxel > 0 ? used && `(${used})` : used ? `auto ${used}` : 'auto';
        };
        const rasterSlider = slider('Raster', 'Vergleichsraster (Voxelgröße, Welteinheiten); 0 = automatisch nach Splat-Dichte', 0, 1, compareVoxel, (v) => {
            compareVoxel = v;
            syncRasterHint();
        }, 3);
        (rasterSlider.parent as Container).append(rasterHint);
        events.on('quality.compared', (voxel: number) => {
            usedVoxel = voxel;
            syncRasterHint();
        });
        slider('Toleranz', 'So viel schlechter muss ein Layer sein, um markiert zu werden', 0, 0.5, margin, (v) => {
            margin = v;
        });

        const actions = buttonRow();
        const message = new Label({ text: '', class: 'quality-message' });

        const run = async (fn: string, title: string) => {
            if (!events.functions.has(fn)) {
                message.text = 'Der Score-Kern ist noch nicht angebunden.';
                return;
            }
            message.text = `${title} …`;
            try {
                const result = await events.invoke(fn);
                message.text = result?.text ?? `${title}: fertig`;
            } catch (error) {
                message.text = `${title} fehlgeschlagen: ${(error as Error).message ?? error}`;
            }
        };

        button(actions, 'Scores berechnen', 'Qualitäts-Score für alle sichtbaren Layer berechnen', () => run('quality.computeScores', 'Scores'));
        button(actions, 'Scans vergleichen', 'Pro Voxel den schärfsten Layer bestimmen und schlechtere Splats markieren', () => run('quality.compareScans', 'Vergleich'));

        const selectRow = buttonRow();
        button(selectRow, 'Unter Schwelle selektieren', 'Splats des aktiven Layers unter der Schwelle auswählen (dann Entf)', () => {
            const splat = events.invoke('selection') as Splat;
            const n = splat ? events.invoke('quality.selectBelow', splat) : null;
            message.text = n === null ? 'Für den aktiven Layer gibt es noch keine Scores.' : `${n} Splats ausgewählt`;
        });
        button(selectRow, 'Schlechtere selektieren', 'Splats des aktiven Layers auswählen, die in einem anderen Scan schärfer sind', () => {
            const splat = events.invoke('selection') as Splat;
            const n = splat ? events.invoke('quality.selectWorse', splat) : null;
            message.text = n === null ? 'Für den aktiven Layer gibt es noch keinen Vergleich.' : `${n} Splats ausgewählt`;
        });

        panel.append(message);

        const sync = () => {
            modeButtons.forEach(b => b.classList.toggle('active', b.dataset.value === mode));
            thresholdSlider.value = threshold;
            thresholdRow.hidden = mode !== 'threshold' && mode !== 'heatmap';
        };
        events.on('quality.changed', sync);
        sync();

        // the score core may want the layers in play
        events.function('quality.layers', () => (scene.getElementsByType(ElementType.splat) as Splat[]).filter(s => s.visible));

        this.activate = () => {
            active = true;
            panel.hidden = false;
            changed();
        };

        this.deactivate = () => {
            active = false;
            panel.hidden = true;
            changed();
        };
    }
}

export { QualityTool, QualityMode };
