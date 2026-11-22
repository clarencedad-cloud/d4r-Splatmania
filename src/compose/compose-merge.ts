import type { FileSystem, Writer } from '@playcanvas/splat-transform';

import { AddSplatOp, MultiOp } from '../edit-ops';
import { Events } from '../events';
import type { Scene } from '../scene';
import type { Splat } from '../splat';
import { writeSplatFile } from '../splat-serialize';
import { State } from '../splat-state';

// Step 6 of the compose wizard, "Zusammenführen": the included scans become one
// new layer. Everything hidden in them (deleted blurry areas, accepted
// suggestions, splats hidden by hand) is left out for good, so the file gets
// thinner, and the alignment is baked in. The scans are written to one PLY in
// memory with the normal export (world transform, colour grades, SH rotation)
// and loaded back as a layer; the originals are switched off. One undo step
// takes the new layer away and shows the scans again.

// splats whose opacity is below this are left out with "fast unsichtbare
// weglassen" (on by default): they are invisible on their own
const FAINT_OPACITY = 0.01;

type MergeCount = {
    splat: Splat,
    total: number,
    // hidden (locked) instances: they do not come along
    hidden: number
};

const mergeCounts = (scans: Splat[]): MergeCount[] => scans.map((splat) => {
    const { flags, count } = splat.instances;
    let hidden = 0;
    for (let i = 0; i < count; ++i) {
        if (flags[i] & State.locked) hidden++;
    }
    return { splat, total: count, hidden };
});

// a file system that keeps the one written file as a Blob: the chunks are
// copied once and the browser may keep the Blob outside the JS heap
class BlobFileSystem implements FileSystem {
    blob: Blob | null = null;

    createWriter(_filename: string): Writer {
        const parts: Uint8Array[] = [];
        let written = 0;
        return {
            write: (data: Uint8Array) => {
                parts.push(data.slice());
                written += data.byteLength;
                return Promise.resolve();
            },
            close: () => {
                this.blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
                parts.length = 0;
                return Promise.resolve();
            },
            abort: () => {
                parts.length = 0;
                return Promise.resolve();
            },
            get bytesWritten() {
                return written;
            }
        } as Writer;
    }

    mkdir(_path: string) {
        return Promise.resolve();
    }
}

// switches layers' visibility, as one part of the merge's undo step
class LayersVisibleOp {
    name = 'composeLayersVisible';
    private splats: Splat[];
    private before: boolean[];
    private value: boolean;

    constructor(splats: Splat[], value: boolean) {
        this.splats = splats;
        this.value = value;
        this.before = splats.map(s => s.visible);
    }

    do() {
        this.splats.forEach((s) => {
            s.visible = this.value;
        });
    }

    undo() {
        this.splats.forEach((s, i) => {
            s.visible = this.before[i];
        });
    }

    destroy() {
        this.splats = null;
        this.before = null;
    }
}

type MergeResult = {
    layer: Splat,
    count: number,
    bytes: number
};

// onLoaded runs before the new layer enters the scene
const mergeScans = async (events: Events, scene: Scene, scans: Splat[], name: string, dropFaint: boolean, onLoaded?: (layer: Splat) => void): Promise<MergeResult | null> => {
    if (scans.length === 0) return null;
    const fs = new BlobFileSystem();
    const filename = `${name}.ply`;
    await writeSplatFile(scans, {
        maxSHBands: 3,
        skipLocked: true,
        removeInvalid: true,
        minOpacity: dropFaint ? FAINT_OPACITY : 0
    }, 'ply', filename, {}, fs);
    if (!fs.blob) return null;
    const bytes = fs.blob.size;
    const file = new File([fs.blob], filename);
    fs.blob = null;
    const layer = await events.invoke('import.loadSplat', file) as Splat | null;
    if (!layer) return null;
    onLoaded?.(layer);
    events.fire('edit.add', new MultiOp([
        new AddSplatOp(scene, layer),
        new LayersVisibleOp(scans, false)
    ]));
    return { layer, count: layer.instances.count, bytes };
};

export { mergeScans, mergeCounts, FAINT_OPACITY, type MergeCount, type MergeResult };
