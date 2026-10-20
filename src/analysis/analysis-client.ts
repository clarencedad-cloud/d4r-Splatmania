// Main-thread side of the analysis worker (src/analysis/analysis-worker.ts).
// One job at a time; abort terminates the worker (the cores run tight loops
// and cannot poll for messages), the next job starts a fresh one.

type Job = {
    resolve: (value: any) => void,
    reject: (reason: any) => void,
    onProgress?: (progress: number) => void
};

class AbortedError extends Error {
    constructor() {
        super('aborted');
    }
}

let worker: Worker | null = null;
let nextId = 1;
const jobs = new Map<number, Job>();

const getWorker = () => {
    if (!worker) {
        worker = new Worker(new URL('analysis-worker.js', document.baseURI), { type: 'module' });
        worker.onmessage = (event: MessageEvent) => {
            const { id, progress, result, error } = event.data;
            const job = jobs.get(id);
            if (!job) return;
            if (progress !== undefined) {
                job.onProgress?.(progress);
            } else {
                jobs.delete(id);
                if (error) {
                    job.reject(new Error(error));
                } else {
                    job.resolve(result);
                }
            }
        };
        worker.onerror = (event: ErrorEvent) => {
            const message = event.message || 'Analyse-Worker konnte nicht geladen werden';
            jobs.forEach(job => job.reject(new Error(message)));
            jobs.clear();
            worker?.terminate();
            worker = null;
        };
    }
    return worker;
};

const runAnalysis = <T>(type: 'icp' | 'score' | 'compare', payload: any, transfer: ArrayBuffer[] = [], onProgress?: (p: number) => void): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        jobs.set(id, { resolve, reject, onProgress });
        getWorker().postMessage({ id, type, payload }, transfer);
    });
};

const abortAnalysis = () => {
    if (!worker) return;
    worker.terminate();
    worker = null;
    jobs.forEach(job => job.reject(new AbortedError()));
    jobs.clear();
};

export { runAnalysis, abortAnalysis, AbortedError };
