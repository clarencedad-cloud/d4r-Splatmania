// Web worker for the analysis cores (built as dist/analysis-worker.js, see
// rollup.config.mjs). Runs fine alignment (ICP) and quality scoring off the
// main thread. Progress is posted back; aborting terminates the worker.

import { refineAlignment } from '../align/icp';
import { compareLayers, scoreSplats } from '../quality/quality-score';

type Request = { id: number, type: 'icp' | 'score' | 'compare', payload: any };

const post = (message: any, transfer: ArrayBuffer[] = []) => {
    (self as any).postMessage(message, transfer);
};

self.onmessage = (event: MessageEvent<Request>) => {
    const { id, type, payload } = event.data;
    const onProgress = (progress: number) => post({ id, progress });
    try {
        if (type === 'icp') {
            const result = refineAlignment(payload.moving, payload.reference, { ...payload.options, onProgress });
            post({ id, result });
        } else if (type === 'score') {
            const scores = scoreSplats(payload.data, payload.options);
            post({ id, result: scores }, [scores.buffer]);
        } else if (type === 'compare') {
            const result = compareLayers(payload.layers, payload.options);
            post({ id, result });
        }
    } catch (error) {
        post({ id, error: `${(error as Error).message ?? error}` });
    }
};
