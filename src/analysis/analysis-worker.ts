// Web worker for the analysis cores (built as dist/analysis-worker.js, see
// rollup.config.mjs). Runs the automatic and the fine alignment (ICP),
// quality scoring, the floater search and the scan composition off the main
// thread. Progress is posted back; aborting terminates the worker.

import { detectFloaters } from './floaters';
import { autoAlign } from '../align/global-align';
import { refineAlignment } from '../align/icp';
import { composeBlur } from '../compose/compose-blur';
import { composeAlign, scanOverlap } from '../compose/compose-core';
import { composeDetail, composePaint, scanCells } from '../compose/compose-detail';
import { compareLayers, scoreSplats } from '../quality/quality-score';

type Request = {
    id: number,
    type: 'icp' | 'auto' | 'score' | 'compare' | 'floaters' | 'compose-overlap' | 'compose-align' | 'compose-cells' | 'compose-detail' | 'compose-paint' | 'compose-blur',
    payload: any
};

const post = (message: any, transfer: ArrayBuffer[] = []) => {
    (self as any).postMessage(message, transfer);
};

// the buffers of every typed array in a result, once each: the scan
// composition's results go back as a transfer, not a copy
const buffersOf = (value: unknown) => {
    const out = new Set<ArrayBuffer>();
    const seen = new Set<object>();
    const walk = (v: unknown) => {
        if (!v || typeof v !== 'object' || seen.has(v as object)) return;
        seen.add(v as object);
        if (ArrayBuffer.isView(v)) {
            if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
            return;
        }
        if (Array.isArray(v)) v.forEach(walk);
        else Object.values(v).forEach(walk);
    };
    walk(value);
    return [...out];
};

self.onmessage = (event: MessageEvent<Request>) => {
    const { id, type, payload } = event.data;
    const onProgress = (progress: number) => post({ id, progress });
    try {
        if (type === 'icp') {
            const result = refineAlignment(payload.moving, payload.reference, { ...payload.options, onProgress });
            post({ id, result });
        } else if (type === 'auto') {
            const result = autoAlign(payload.moving, payload.reference, { ...payload.options, onProgress }, payload.movingColors ?? null, payload.referenceColors ?? null);
            post({ id, result });
        } else if (type === 'score') {
            const scores = scoreSplats(payload.data, payload.options);
            post({ id, result: scores }, [scores.buffer]);
        } else if (type === 'compare') {
            const result = compareLayers(payload.layers, payload.options);
            post({ id, result });
        } else if (type === 'compose-overlap') {
            const result = scanOverlap(payload.clouds, payload.options);
            post({ id, result });
        } else if (type === 'compose-align') {
            const result = composeAlign(payload.moving, payload.reference, {
                ...payload.options,
                movingColors: payload.movingColors ?? null,
                referenceColors: payload.referenceColors ?? null,
                onProgress
            });
            post({ id, result });
        } else if (type === 'floaters') {
            const result = detectFloaters(payload.data, { ...payload.options, onProgress });
            post({ id, result }, [result.probability.buffer as ArrayBuffer, result.reason.buffer as ArrayBuffer, result.group.buffer as ArrayBuffer]);
        } else if (type === 'compose-cells') {
            // one scan's cell table (src/compose/compose-detail.ts)
            const result = scanCells(payload.rows, payload.cell, payload.options);
            post({ id, result }, buffersOf(result));
        } else if (type === 'compose-detail') {
            // all scans compared, regions and rejected clusters
            const result = composeDetail(payload.scans, payload.options);
            post({ id, result }, buffersOf(result));
        } else if (type === 'compose-paint') {
            // the cover proof for the batches of one loser scan
            const result = composePaint(payload.cell, payload.batches, payload.options, onProgress);
            post({ id, result }, buffersOf(result));
        } else if (type === 'compose-blur') {
            // large blurry areas per scan, the per-row blur and comparison
            // values (src/compose/compose-blur.ts)
            const result = composeBlur(payload.scans, payload.options);
            post({ id, result }, buffersOf(result));
        }
    } catch (error) {
        post({ id, error: `${(error as Error).message ?? error}` });
    }
};
