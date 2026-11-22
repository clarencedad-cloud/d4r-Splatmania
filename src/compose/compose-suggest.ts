import { BUFFERUSAGE_COPY_DST, BUFFERUSAGE_COPY_SRC, Mat4, Quat, StorageBuffer, Vec3 } from 'playcanvas';

import { BLUR, type BlurArea, type BlurResult } from './compose-blur';
import { keyOf } from './compose-core';
import {
    applyPaint,
    autoCell,
    cellSample,
    CellState,
    forceRegion,
    gridCell,
    KEPT,
    makeProbe,
    paintInputs,
    sceneDiagonal,
    type AutoCell,
    type CellProbe,
    type DetailOptions,
    type DetailResult,
    type PaintBatch,
    type PaintJob,
    type PaintResult,
    type Region,
    type ScanCells,
    type ScanCellsLike,
    type V3
} from './compose-detail';
import { abortAnalysis, AbortedError, runAnalysis } from '../analysis/analysis-client';
import { readLayerCompact, type CompactData } from '../analysis/splat-data';
import { HideRangesOp, MultiOp, UnhideRangesOp, type EditOp } from '../edit-ops';
import { Events } from '../events';
import { IndexRanges } from '../index-ranges';
import type { ComposeRenderParams } from '../projected-splat-renderer';
import type { Scene } from '../scene';
import type { Splat } from '../splat';
import { State } from '../splat-state';
import { i18n } from '../ui/localization';

// Scan composition, phase 2 on the main thread (steps 3 "Analyse" and 4
// "Vorschläge"): the analysis run (compact reads, the worker jobs
// 'compose-blur', 'compose-cells', 'compose-detail' and 'compose-paint', the
// pure paintInputs / applyPaint of compose-detail.ts), the suggestions
// ("cards") with their status derived from the lock bits, the per-scan
// display bytes the splat renderer reads through 'compose.renderParams'
// (map, previews, marking, hover), the probe and the API. Accepting hides the
// coarser scan's splats through undoable ops; nothing is deleted.
//
// Step 4 leads with the simple path: the large blurry areas of each scan
// (compose-blur.ts, "Unscharfe Bereiche"), one card per area with Löschen /
// Behalten / Auswählen. "Löschen" hides the area's splats with the same ops
// as an accepted suggestion (one undo step, "Zurücknehmen"); the detailed
// suggestions follow folded as "Feinvergleich".

type GridMode = 'auto' | 'fine' | 'coarse';
type PreviewMode = 'before' | 'after';
type DisplayMode = 'normal' | 'mark';
type CardStatus = 'open' | 'partly' | 'accepted';

type SuggestContext = {
    active: () => boolean,
    step: () => string,
    included: () => Splat[],
    reference: () => Splat | null,
    // a scan's name in the compose texts (compose-dom scanName)
    nameOf: (splat: Splat) => string,
    // the scan colours (hex), index = position in included() modulo 4
    colors: string[],
    // the panel must be rebuilt
    onChange: () => void,
    // the sharpness view's render params for a scan (compose-tool, all
    // steps), null when it is off or not ready; a card preview in step 4
    // wins over it
    sharpness?: (splat: Splat, hideLocked: boolean) => ComposeRenderParams | null,
    // an analysis hands the sharpness view the blurry-area detector's value
    // per instance (SharpnessView.setExternal)
    sharpSource?: (splat: Splat, value: { bytes: Uint8Array, median: number } | null) => void
};

// what makes an analysis of a scan stale: its world transform, its instance
// list (count and print, see listPrint) and a version bumped on position
// edits and data replacement
type Signature = {
    world: Float32Array,
    count: number,
    print: number,
    version: number
};

// a scan's compact read and its cell table, reused while the scan is unchanged
type ReadCache = {
    sig: Signature,
    // locked instances when it was read (the read skips them)
    locked: number,
    data: CompactData,
    cells: ScanCells | null
};

// what compose itself hid in a scan, per instance (1 = locked by an accepted
// suggestion and hidden ever since). The compose ops keep it up to date in
// their do and undo; an edit of anything else that shows marked splats again
// (Shift+H) clears their marks, and its undo puts them back (see edited()),
// so undo and redo keep it right. With the lock bits it decides a card's
// status and what "Zurücknehmen" and "Alle zurücknehmen" show again: compose
// only ever shows again what it hid itself, never splats hidden by hand or
// by another tool, also not ones it hid once and that were shown and hidden
// again by hand since. It belongs to one instance list (count and print):
// once splats are added or removed the analysis is stale, a new analysis
// starts a new record, and the old one is used again when the list comes
// back (undo)
type HiddenRecord = {
    count: number,
    print: number,
    mark: Uint8Array
};

type Card = {
    // region id; the panel shows id + 1
    id: number,
    region: Region,
    ticked: boolean,
    rejected: boolean,
    status: CardStatus,
    // instances in the hide sets of all its losers; of them the ones compose
    // hid (recorded and locked) and the ones locked otherwise (by hand or
    // another tool: they count neither for the status nor for revert)
    total: number,
    locked: number,
    others: number,
    // not accepted, but at least ACCEPTED_SHARE of the hide set is hidden
    // anyway, mostly not by compose ('Auswählen' + H, another tool): the
    // status stays compose's own, but accepting would only hide the rest
    // (perhaps left out on purpose) and 'before' would draw a hole there, so
    // both are off for it, and it is no tick for "Angehakte übernehmen"
    handHidden: boolean,
    // made with "Trotzdem übernehmen" from a cluster rejected for this
    // reason: its checklist keeps that check as failed, with the number the
    // cluster failed on (its Rejected.value: density W / L or colour-detail
    // ratio W / L, mostly the median over its cells; NaN when not forced)
    forcedReason: 'texture' | 'sparse' | null,
    forcedValue: number
};

type Analysis = {
    scans: Splat[],
    sigs: Signature[],
    // instances.count per scan at the read
    counts: number[],
    grid: GridMode,
    leadFactor: number,
    auto: AutoCell,
    cell: number,
    // the one options object every compose-detail call got
    options: DetailOptions,
    detail: DetailResult,
    cells: ScanCellsLike[],
    // per scan: the read, its cell per row and the paint per row (dropped
    // when the tool is closed)
    rows: (CompactData | null)[],
    rowCells: (Int32Array | null)[],
    paintRow: (Uint16Array | null)[],
    // per scan, per instance: global cell (-1) and paint value
    cellInst: Int32Array[],
    paintInst: Uint16Array[],
    // per scan, per region id: instances of its hide set, the ones compose
    // hid and the ones locked otherwise
    total: Uint32Array[],
    lockedBy: Uint32Array[],
    otherBy: Uint32Array[],
    // per scan: the record of what compose hid (for this instance list)
    records: HiddenRecord[],
    cards: Card[],
    probe: ((point: V3) => CellProbe) | null,
    seconds: number,
    times: Record<string, number>,
    // share of the shared cells found apart
    apartShare: number,
    sharedCells: number,
    // the map was switched off on the first visit of step 4
    visited: boolean,
    // per global cell: the instances each card hides there, per loser
    // (built on first use by hidesIn, dropped by countTotals)
    cellHides?: Map<number, CellHide[]> | null,
    // the large blurry areas (compose-blur), null when the detector failed
    areas: AreaState | null
};

// instances of scan `scan` a card hides in one cell
type CellHide = { card: number, scan: number, n: number };

// a large blurry area of one scan (compose-blur.ts): one card of step 4's
// "Unscharfe Bereiche". Its splats are the area's rows as instances (areaInst)
type AreaCard = {
    // the area's rank in the detector (BlurArea.id); the panel numbers the
    // cards in their own order (AreaState.cards)
    id: number,
    // the area without its row list (mapped to instances, see AreaState)
    area: Omit<BlurArea, 'rows'>,
    scan: number,
    // "Behalten": the user keeps it (not offered for deletion, out of the
    // bulk delete); remembered across analyses (see areaKept)
    kept: boolean,
    // as Card: instances of the area, the ones compose hid, the ones locked
    // otherwise, and hidden by hand
    status: CardStatus,
    total: number,
    locked: number,
    others: number,
    handHidden: boolean
};

// the blurry areas of an analysis
type AreaState = {
    cell: number,
    seconds: number,
    // in display order: where another scan is sharp first, then
    // free-floating islands, then the rest; larger first within each
    cards: AreaCard[],
    // per scan, per instance: area id + 1 (0: in no area)
    areaInst: Uint16Array[],
    // per scan, per instance: the detector's blur value as sharpness view
    // bytes (see SharpnessView.setExternal), or null
    sharpInst: Uint8Array[],
    // per scan, per area id: instances, hidden by compose, locked otherwise
    total: Uint32Array[],
    lockedBy: Uint32Array[],
    otherBy: Uint32Array[]
};

// an area kept with "Behalten", remembered across analyses: same scan, and
// half of a new area's box inside its box
type KeptMemory = { scan: Splat, min: V3, max: V3 };

// a rejected card, remembered across analyses
type RejectMemory = {
    winner: Splat,
    losers: Splat[],
    keys: Set<number>,
    cell: number,
    min: V3,
    max: V3
};

type Display = {
    count: number,
    bytes: Uint8Array | null,
    buffer: StorageBuffer | null,
    active: boolean,
    params: ComposeRenderParams
};

type Hover = { kind: 'card', id: number } | { kind: 'skip', index: number } | { kind: 'area', id: number };

type ProbeView = {
    // the picked point, the view direction it was picked along, and whether
    // the probe moved off its cell to the surface behind or next to it (see
    // probePoint)
    point: V3,
    dir: V3 | null,
    moved: boolean,
    probe: CellProbe
};

type AnalyseSummary = {
    seconds: number,
    cell: number,
    grid: GridMode,
    lead: number,
    auto: { cell: number, perScan: number[], forcedBy: string | null },
    suggestions: number,
    base: number,
    clear: number,
    skipped: number,
    apartShare: number,
    times: Record<string, number>,
    // blurry areas, and of them the ones another scan is sharp in
    areas: number,
    areasSharp: number
};

const GRIDS: GridMode[] = ['auto', 'fine', 'coarse'];
const LEADS = [1.4, 1.6, 2];
// progress (percent) of the reads, the blurry areas, the cell tables and the
// comparison; the cover proof gets the rest
const P_READ = 33;
const P_BLUR = 5;
const P_CELLS = 15;
const P_DETAIL = 8;
// how long a blurry area stays highlighted after a click on its card (ms)
const AREA_FLASH_MS = 2600;
// display order of the blurry areas: another scan is sharp there, then
// free-floating islands, then areas only this scan has, then those where
// the others are blurry too
const AREA_GROUP = (area: Omit<BlurArea, 'rows'>) => (area.compare === 'otherSharp' ? 0 : area.kind === 'island' ? 1 : area.compare === 'alone' ? 2 : 3);
// card status from the locked share of its hide set
const ACCEPTED_SHARE = 0.95;
const PARTLY_SHARE = 0.05;
// option changes rerun after this pause (ms)
const RERUN_DELAY = 300;
// rejected cards remembered across analyses
const MEMORY_SIZE = 200;
// records of what compose hid kept per scan (one per instance list: an edit
// that adds or removes splats, and its undo)
const RECORDS_KEPT = 4;
// display classes (projector mode 3, see projected-splat-renderer.ts)
const CLS_SCAN = 1;
const CLS_GREY = 2;
const CLS_RED = 3;
const CLS_GREEN = 4;
const CLS_HIDDEN = 7;
const PALE = 32;
// the probe at a picked point whose cell has no scan's surface: the pick
// lies on the front of the rendered splats, in front of their centres, so
// it looks up to this many cells further along the view ray, in this many
// steps per cell (an eighth of a cell skips no cell the ray crosses for
// more than that), then at the nearest of the 26 neighbouring cells with
// surface (see probePoint). Measured on the bus pair (15 cm grid, lead
// 1.4×; each of the two cards' markers seen from two sides at 3 units, 20
// degrees up, 2852 picks on a pixel grid): 1562 (55 %) landed in a cell
// without surface and read "Hier hat kein Scan Fläche"; 1505 of them now
// reach a cell with surface (675 along the ray, 830 next to it), p50 0.35
// and p90 0.77 cells from the picked point, 57 (2 % of the picks) stay
// without. Of the unresolved picks of these and of 4 poses outside the
// scene (796), 23 have surface 1-2 cells further along the ray, 753 none
// within 6 (sky, floaters): a longer reach would mostly reach another
// surface. Steinbeis had a pick 4.7 cm in front of an apart cluster's cell
// row
const PROBE_REACH = 1;
const PROBE_STEPS = 8;

const UP = new Vec3(0, 1, 0);

const hexToRgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

// a cheap print of a scan's instance list: the source rows at a few spread
// positions, the last one included. Every edit that changes the list changes
// its count; one that brings the count back with another order (delete, then
// restore the missing splats at the end) moves the last rows and so the
// print. Undoing the edits brings the print back
const PRINT_SAMPLES = 32;
const listPrint = (splat: Splat) => {
    const { count, sourceRow } = splat.instances;
    let h = 0x811c9dc5;
    if (count > 0) {
        for (let k = 0; k < PRINT_SAMPLES; k++) {
            h = Math.imul(h ^ sourceRow[Math.floor(k * (count - 1) / (PRINT_SAMPLES - 1))], 0x01000193) >>> 0;
        }
    }
    return h;
};

// the scan's instance list is still the one of count and print
const sameList = (splat: Splat, count: number, print: number) => splat.instances.count === count && listPrint(splat) === print;

const signatureOf = (splat: Splat, version: number): Signature => ({
    world: Float32Array.from(splat.entity.getWorldTransform().data),
    count: splat.instances.count,
    print: listPrint(splat),
    version
});

// the same tolerance as phase 1's stale() in compose-tool.ts
const sameSignature = (a: Signature, b: Signature) => {
    if (a.count !== b.count || a.print !== b.print || a.version !== b.version) return false;
    const size = Math.max(1, Math.abs(a.world[12]), Math.abs(a.world[13]), Math.abs(a.world[14]));
    for (let i = 0; i < 16; i++) {
        if (Math.abs(a.world[i] - b.world[i]) > (i >= 12 ? 1e-4 * size : 1e-4)) return false;
    }
    return true;
};

// the scene's up axis (free views, shape labels): the editor's world +y, as
// its camera has it. The layer's own +y is no guide: an unoriented PLY is
// loaded turned upright by 180 degrees about z, so its +y points down. Only a
// reference layer with a local frame from the orient tool says otherwise:
// that frame maps local +y to the picked plane's normal on the side facing
// the camera, so its rotation times the frame (as the section tool derives
// it), snapped to the nearest world axis (z-up scans)
const upOf = (splat: Splat | null): { upAxis: 0 | 1 | 2, upSign: 1 | -1 } => {
    if (!splat?.hasLocalFrame) return { upAxis: 1, upSign: 1 };
    const q = new Quat().mul2(splat.entity.getRotation(), splat.localFrame);
    const v = q.transformVector(UP, new Vec3());
    const c = [v.x, v.y, v.z];
    let axis = 1;
    for (let k = 0; k < 3; k++) if (Math.abs(c[k]) > Math.abs(c[axis]) + 1e-9) axis = k;
    return { upAxis: axis as 0 | 1 | 2, upSign: c[axis] < 0 ? -1 : 1 };
};

// the array buffers of every typed array in a result, once each (the
// transfer list of a worker message)
const transferList = (value: unknown) => {
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

const findKey = (keys: Float64Array, key: number) => {
    let lo = 0, hi = keys.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keys[mid] < key) lo = mid + 1;
        else hi = mid;
    }
    return lo < keys.length && keys[lo] === key ? lo : -1;
};

// fn at the next frame, or after a short timer where frames do not come (a
// hidden tab never fires requestAnimationFrame); returns a cancel function
const nextFrame = (fn: () => void) => {
    let done = false;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> = null;
    const cancel = () => {
        done = true;
        cancelAnimationFrame(raf);
        clearTimeout(timer);
    };
    const run = () => {
        if (done) return;
        cancel();
        fn();
    };
    raf = requestAnimationFrame(run);
    timer = setTimeout(run, 100);
    return cancel;
};

// ScanCells without the per-row cells (those stay on the main thread)
const tableOf = (sc: ScanCells): ScanCellsLike => {
    const { rowCell, ...rest } = sc;
    return rest;
};

// a paint batch without its row indices (the worker does not need them)
const batchPayload = (batch: PaintBatch): PaintBatch => {
    const { rows, ...rest } = batch;
    return rest;
};

const NO_RANGES = IndexRanges.fromPredicate(0, () => false);

// a record's marks over the ranges set to value; returns the marks before
const setMarks = (record: HiddenRecord, ranges: IndexRanges, value: number) => {
    const { mark } = record;
    const before = new Uint8Array(ranges.count);
    let k = 0;
    ranges.forEachRun((start, count) => {
        before.set(mark.subarray(start, start + count), k);
        mark.fill(value, start, start + count);
        k += count;
    });
    return before;
};

const restoreMarks = (record: HiddenRecord, ranges: IndexRanges, before: Uint8Array) => {
    const { mark } = record;
    let k = 0;
    ranges.forEachRun((start, count) => {
        mark.set(before.subarray(k, k + count), start);
        k += count;
    });
};

// Accept (hide) and revert (unhide) of compose in one scan. The instances are
// picked when the op first runs, not when it is made: an op queued ahead of
// it (another accept of the same card, a hide by hand) can change the lock
// bits in between, and instances picked earlier would make undo inexact.
// Redo reuses them. The record of what compose hid follows every do and undo.
class ComposeHideOp extends HideRangesOp {
    private record: HiddenRecord;
    private pick: (() => IndexRanges) | null;
    private before: Uint8Array | null = null;

    constructor(splat: Splat, record: HiddenRecord, pick: () => IndexRanges) {
        super(splat, NO_RANGES);
        this.record = record;
        this.pick = pick;
    }

    async do() {
        if (this.pick) {
            this.ranges = this.pick();
            this.pick = null;
        }
        this.before = setMarks(this.record, this.ranges, 1);
        await super.do();
    }

    async undo() {
        if (this.before) restoreMarks(this.record, this.ranges, this.before);
        await super.undo();
    }

    destroy() {
        super.destroy();
        this.record = null;
        this.pick = null;
        this.before = null;
    }
}

class ComposeUnhideOp extends UnhideRangesOp {
    private record: HiddenRecord;
    private pick: (() => IndexRanges) | null;
    private before: Uint8Array | null = null;

    constructor(splat: Splat, record: HiddenRecord, pick: () => IndexRanges) {
        super(splat, NO_RANGES);
        this.record = record;
        this.pick = pick;
    }

    async do() {
        if (this.pick) {
            this.ranges = this.pick();
            this.pick = null;
        }
        this.before = setMarks(this.record, this.ranges, 0);
        await super.do();
    }

    async undo() {
        if (this.before) restoreMarks(this.record, this.ranges, this.before);
        await super.undo();
    }

    destroy() {
        super.destroy();
        this.record = null;
        this.pick = null;
        this.before = null;
    }
}

type ComposeKind = 'accept' | 'revert';

// the scans whose lock bits an edit may change: false when that is not known
// (then any); edits of other bits only (the selection) add none
const lockTargets = (op: EditOp, out: Set<Splat>): boolean => {
    if (op instanceof MultiOp) return op.ops.every(o => lockTargets(o, out));
    const { splat, mask } = op as unknown as { splat?: Splat, mask?: number };
    if (typeof mask === 'number' && !(mask & State.locked)) return true;
    if (!splat) return false;
    out.add(splat);
    return true;
};

// one accept or revert: one undo step over the scans it touches; settled
// runs once, when it has run the first time
class ComposeOp extends MultiOp {
    kind: ComposeKind;
    private settled: (() => void) | null;

    constructor(kind: ComposeKind, ops: (ComposeHideOp | ComposeUnhideOp)[], settled: () => void) {
        super(ops);
        this.name = kind === 'accept' ? 'composeAccept' : 'composeRevert';
        this.kind = kind;
        this.settled = settled;
    }

    async do() {
        try {
            await super.do();
        } finally {
            const settled = this.settled;
            this.settled = null;
            settled?.();
        }
    }
}

// ---------------------------------------------------------------- sharpness view

// The sharpness view ('Schärfe', all steps): every splat of every compose
// layer coloured by how blurry it is against its own scan - its footprint
// (sqrt(largest * middle scale), the size definition of compose-detail and
// readLayerCompact) relative to the median footprint of the scan's opaque
// splats (opacity >= 0.2, compose-detail DETAIL.opaque). The per-splat byte
// is log2 of that ratio in 1/BLUR_STEPS octaves (0 = the median or finer,
// 255 = 8 octaves above it); the shader maps the octaves from..to of the
// view's range to no tint..fully magenta. Blurred areas (few giant blobs
// where the other scan is sharp) show at a glance, and with the quick switch
// (PageUp/PageDown) one scan against the other. Display only.
const BLUR_STEPS = 32;
const BLUR_OPAQUE = 51;
// the default range in octaves above the scan's median footprint
const BLUR_FROM = 3;
const BLUR_TO = 6;
// after an analysis the view shows the blurry-area detector's value instead
// (ComposeSuggest.areaState): a splat's own and its voxel's octaves over the
// scan's median, averaged (blur by area, not splat by splat), at most
// BLUR.mapHi = 4. Its SHARP_PIVOT octaves sit where the range starts
// (SHARP_FROM), stretched by SHARP_STRETCH, so the default range shows its
// 2.5..4 octaves
const SHARP_PIVOT = 2.5;
const SHARP_STRETCH = 2;
const SHARP_FROM = BLUR_FROM;
// the median from a histogram of log2(footprint): 1/32 octave, 2^-30..2^20
const BLUR_BINS_PER_OCTAVE = 32;
const BLUR_LOG_MIN = -30;
const BLUR_LOG_MAX = 20;

// median footprint of the opaque splats (of all when none is opaque);
// NaN when there is no finite positive footprint
const medianFootprint = (footprint: Float32Array, opacity: Uint8Array) => {
    const bins = new Uint32Array((BLUR_LOG_MAX - BLUR_LOG_MIN) * BLUR_BINS_PER_OCTAVE + 1);
    const top = bins.length - 1;
    const fill = (opaqueOnly: boolean) => {
        let n = 0;
        for (let i = 0; i < footprint.length; i++) {
            const f = footprint[i];
            if (!(f > 0) || f === Infinity || (opaqueOnly && opacity[i] < BLUR_OPAQUE)) continue;
            const b = Math.floor((Math.log2(f) - BLUR_LOG_MIN) * BLUR_BINS_PER_OCTAVE);
            bins[b < 0 ? 0 : b > top ? top : b]++;
            n++;
        }
        return n;
    };
    let n = fill(true);
    if (!n) n = fill(false);
    if (!n) return NaN;
    let seen = 0;
    for (let b = 0; b <= top; b++) {
        seen += bins[b];
        if (seen * 2 >= n) return 2 ** (BLUR_LOG_MIN + (b + 0.5) / BLUR_BINS_PER_OCTAVE);
    }
    return NaN;
};

// per splat blur as a byte: octaves above the scan's median footprint in
// 1/BLUR_STEPS (0 = median or finer, 255 = 8 octaves or more), see above;
// footprint and opacity (round(alpha * 255)) per splat of one scan
const blurBytes = (footprint: Float32Array, opacity: Uint8Array, out = new Uint8Array(footprint.length)) => {
    const median = medianFootprint(footprint, opacity);
    if (!(median > 0)) {
        out.fill(0);
        return { bytes: out, median };
    }
    const k = BLUR_STEPS;
    for (let i = 0; i < footprint.length; i++) {
        const f = footprint[i];
        if (!(f > median)) {
            out[i] = 0;
            continue;
        }
        const v = Math.log2(f / median) * k;
        out[i] = v >= 255 ? 255 : Math.round(v);
    }
    return { bytes: out, median };
};

// one IEEE half per 16-bit code, decoded once
let halfCodes: Float32Array | null = null;
const halfTable = () => {
    if (!halfCodes) {
        halfCodes = new Float32Array(65536);
        for (let h = 0; h < 65536; h++) {
            const s = (h & 0x8000) ? -1 : 1;
            const e = (h >> 10) & 0x1f;
            const f = h & 0x3ff;
            halfCodes[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
        }
    }
    return halfCodes;
};

type SharpEntry = {
    count: number,
    print: number,
    version: number,
    // blur byte per instance, padded to whole u32 words
    bytes: Uint8Array,
    buffer: StorageBuffer,
    median: number,
    params: ComposeRenderParams,
    // the analysis' bytes it was made from (see setExternal), null: the
    // view's own measure
    source: SharpExternal | null
};

// a scan's blur bytes from the analysis (compose-blur's per-row value as
// instances), for the instance list of count and print at view version
type SharpExternal = {
    count: number,
    print: number,
    version: number,
    bytes: Uint8Array,
    median: number
};

// the per-scan blur bytes and their gpu buffers: computed when the view asks
// for a scan the first time (one texture read of its scales and opacities),
// again when its instance list or data changed
class SharpnessView {
    enabled = false;
    // octaves above the scan's median footprint: from = no tint, to = full
    range = { from: BLUR_FROM, to: BLUR_TO };

    private scene: Scene;
    private entries = new Map<Splat, SharpEntry>();
    private versions = new Map<Splat, number>();
    private pending = new Set<Splat>();
    // the analysis' bytes per scan (see setExternal)
    private external = new Map<Splat, SharpExternal>();
    private onReady: () => void;

    constructor(events: Events, scene: Scene, onReady: () => void) {
        this.scene = scene;
        this.onReady = onReady;
        const bump = (splat: Splat) => {
            this.versions.set(splat, (this.versions.get(splat) ?? 0) + 1);
        };
        events.on('splat.positionsChanged', bump);
        events.on('splat.replaced', bump);
    }

    // the analysis' blur bytes of a scan while they fit it
    private externalOf(splat: Splat) {
        const x = this.external.get(splat);
        return x && x.version === (this.versions.get(splat) ?? 0) && sameList(splat, x.count, x.print) ? x : null;
    }

    // an entry fits the scan: made from its current analysis bytes, or with
    // none, from its own measure of the current data
    private fresh(splat: Splat, e: SharpEntry | undefined) {
        if (!e) return false;
        const x = this.externalOf(splat);
        if (x) return e.source === x;
        return !e.source && e.version === (this.versions.get(splat) ?? 0) && sameList(splat, e.count, e.print);
    }

    // after an analysis: the blurry-area detector's value per instance
    // (compose-blur: a splat's own and its voxel's octaves over the scan's
    // median, averaged - blur by area, not splat by splat), encoded in the
    // view's octaves (see ComposeSuggest.areaState). It replaces the own
    // measure of the scan while it fits its instance list; null drops it
    setExternal(splat: Splat, value: { bytes: Uint8Array, median: number } | null) {
        if (!value) {
            this.external.delete(splat);
        } else {
            this.external.set(splat, {
                count: splat.instances.count,
                print: listPrint(splat),
                version: this.versions.get(splat) ?? 0,
                bytes: value.bytes,
                median: value.median
            });
        }
        this.scene.forceRender = true;
    }

    // what the renderer binds for a scan while the view is on (null while
    // its bytes are being computed: the scan draws as usual for that moment)
    params(splat: Splat, hideLocked: boolean): ComposeRenderParams | null {
        if (!this.enabled) return null;
        let e = this.entries.get(splat);
        if (!this.fresh(splat, e)) {
            const x = this.externalOf(splat);
            if (!x) {
                this.compute(splat);
                return null;
            }
            e?.buffer.destroy();
            e = this.entryOf(x.bytes, x.count, x.print, x.version, x.median, x);
            this.entries.set(splat, e);
        }
        e.params.hideLocked = hideLocked;
        e.params.threshold = this.range.from;
        e.params.range = this.range.to;
        return e.params;
    }

    // median footprint and blurry share of a scan, null before it was
    // computed; source: the analysis' value or the view's own measure
    stats(splat: Splat) {
        const e = this.entries.get(splat);
        if (!this.fresh(splat, e)) return null;
        const from = Math.round(this.range.from * BLUR_STEPS);
        let tinted = 0;
        for (let i = 0; i < e.count; i++) if (e.bytes[i] > from) tinted++;
        return { median: e.median, blurry: e.count ? tinted / e.count : 0, source: e.source ? 'analysis' : 'own' };
    }

    // an entry over count bytes (copied, padded to whole u32 words)
    private entryOf(values: Uint8Array, count: number, print: number, version: number, median: number, source: SharpExternal | null): SharpEntry {
        const size = Math.max(4, Math.ceil(count / 4) * 4);
        const bytes = new Uint8Array(size);
        bytes.set(values.subarray(0, count));
        const buffer = new StorageBuffer(this.scene.graphicsDevice, size, BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC);
        buffer.write(0, bytes, 0, size);
        return {
            count,
            print,
            version,
            bytes,
            buffer,
            median,
            params: { buffer, mode: 4, threshold: this.range.from, range: this.range.to, palette: null, hideLocked: false },
            source
        };
    }

    // a scan's bytes are being computed
    computing() {
        return this.pending.size > 0;
    }

    private compute(splat: Splat) {
        if (this.pending.has(splat)) return;
        this.pending.add(splat);
        this.read(splat).then((entry) => {
            this.pending.delete(splat);
            if (entry) {
                this.entries.get(splat)?.buffer.destroy();
                this.entries.set(splat, entry);
            }
            this.scene.forceRender = true;
            this.onReady();
        }, () => {
            this.pending.delete(splat);
        });
    }

    private async read(splat: Splat): Promise<SharpEntry | null> {
        const version = this.versions.get(splat) ?? 0;
        const resource = splat.resource;
        const texB = resource.getTexture('transformB');
        const texC = resource.getTexture('splatColor');
        const b = await texB.read(0, 0, texB.width, texB.height, { immediate: true }) as Uint16Array;
        const c = await texC.read(0, 0, texC.width, texC.height, { immediate: true }) as Uint16Array;
        // the list is taken after the reads (the scales live per source row,
        // the list only maps to them)
        const { instances } = splat;
        const count = instances.count;
        const { sourceRow, palette } = instances;
        const half = halfTable();
        const footprint = new Float32Array(count);
        const opacity = new Uint8Array(count);
        // per-instance transforms scale the footprint (uniform estimate)
        const palScale = new Map<number, number>();
        const tmp = new Mat4();
        const axis = new Vec3();
        let lastPal = -1;
        let s = 1;
        for (let i = 0; i < count; i++) {
            const pal = palette[i] & 0xffff;
            if (pal !== lastPal) {
                let v = palScale.get(pal);
                if (v === undefined) {
                    splat.transformPalette.getTransform(pal, tmp);
                    v = (tmp.getX(axis).length() + tmp.getY(axis).length() + tmp.getZ(axis).length()) / 3;
                    palScale.set(pal, v);
                }
                s = v;
                lastPal = pal;
            }
            const r4 = sourceRow[i] * 4;
            const sa = Math.abs(half[b[r4]]), sb = Math.abs(half[b[r4 + 1]]), sc = Math.abs(half[b[r4 + 2]]);
            const hi = Math.max(sa, sb, sc);
            const mid = sa + sb + sc - hi - Math.min(sa, sb, sc);
            footprint[i] = Math.sqrt(hi * mid) * s;
            const alpha = half[c[r4 + 3]];
            opacity[i] = alpha >= 1 ? 255 : alpha > 0 ? Math.round(alpha * 255) : 0;
        }
        if (splat.resource !== resource) return null;
        const { bytes, median } = blurBytes(footprint, opacity);
        return this.entryOf(bytes, count, listPrint(splat), version, median, null);
    }

    // the buffers go when the tool closes (computed again on the next use;
    // the analysis' bytes stay with it)
    release() {
        this.entries.forEach(e => e.buffer.destroy());
        this.entries.clear();
    }

    drop(splat: Splat) {
        this.entries.get(splat)?.buffer.destroy();
        this.entries.delete(splat);
        this.versions.delete(splat);
        this.external.delete(splat);
    }
}

class ComposeSuggest {
    analysis: Analysis | null = null;
    busy = false;
    message = '';
    grid: GridMode = 'auto';
    lead = 1.6;
    map = false;
    hideLocked = true;
    display: DisplayMode = 'normal';
    preview: { id: number, mode: PreviewMode } | null = null;
    // the selection stays drawn during a Vorher/Nachher preview (the user's
    // override of its automatic hiding, see selectionHidden)
    showSelection = false;
    // the card picked last (clicked, ⌖, Vorher/Nachher): marked in the panel
    picked: number | null = null;
    hover: Hover | null = null;
    probeResult: ProbeView | null = null;

    private events: Events;
    private scene: Scene;
    private ctx: SuggestContext;
    private reads = new Map<Splat, ReadCache>();
    private versions = new Map<Splat, number>();
    private displays = new Map<Splat, Display>();
    private includedSet = new Set<Splat>();
    private palette: number[][];
    // the hide switch alone, for layers without display classes
    private plain: ComposeRenderParams = { buffer: null, mode: 0, threshold: 0, palette: null, hideLocked: true };
    private autoCache: { datas: CompactData[], auto: AutoCell, diag: number } | null = null;
    // the blurry-area detector's result for these reads (grid and lead do
    // not change it)
    private blurCache: { datas: CompactData[], upAxis: number, upSign: number, result: BlurResult } | null = null;
    private memory: RejectMemory[] = [];
    // what compose hid, per scan: one record per instance list, newest first
    private records = new Map<Splat, HiddenRecord[]>();
    // per edit of anything else: the marked instances it showed again, per
    // record (their marks went with it and come back with its undo)
    private cleared = new WeakMap<EditOp, Map<HiddenRecord, { splat: Splat, shown: Uint32Array }>>();
    // per card id: its newest accept or revert still waiting in the edit
    // queue (a second click on the same then is a no-op)
    private queued = new Map<number, ComposeOp>();
    // the drawn 'before' preview's losers and their locked counts when it was
    // composed: which of its cells keep the winner depends on their lock
    // bits (see writeDisplays). An edit locks or unlocks their splats one or
    // more frames before 'splat.stateChanged' (the bound update in between
    // waits for the GPU), so renderParams compares the counts at every
    // render, and 'splat.stateChanged' once more, and both compose again
    // (redrawOnLocks): no frame draws the old cells
    private beforeLocks: { losers: Splat[], locked: Float64Array } | null = null;
    // pending frame callbacks (cancel functions)
    private displayFrame: (() => void) | null = null;
    private syncFrame: (() => void) | null = null;
    private dirty = new Set<Splat>();
    private stale = false;
    private rerunTimer: ReturnType<typeof setTimeout> | null = null;
    private rerunPending = false;

    // blurry areas (step 4's "Unscharfe Bereiche"): the Vorher/Nachher
    // preview (only one preview at a time: it and a card's exclude each
    // other), all open areas marked red, the card picked last, the short
    // highlight after a click, the waiting ops per area id, kept areas
    areaPreview: { id: number, mode: PreviewMode } | null = null;
    areaMark = false;
    pickedArea: number | null = null;
    private areaFlash: { id: number, until: number } | null = null;
    private areaFlashTimer: ReturnType<typeof setTimeout> | null = null;
    private areaQueued = new Map<number, ComposeOp>();
    private kept: KeptMemory[] = [];

    constructor(events: Events, scene: Scene, ctx: SuggestContext) {
        this.events = events;
        this.scene = scene;
        this.ctx = ctx;
        this.palette = ctx.colors.map(hex => [...hexToRgb(hex), 1]);

        events.function('compose.renderParams', (splat: Splat) => this.renderParams(splat));
        events.function('compose.analyse', () => this.analyse(true));
        events.function('compose.analysis', () => this.view());
        events.function('compose.probe', (point: number[], dir?: number[]) => this.probeView(point, dir));
        events.function('compose.accept', (ids: number[] | number | 'ticked') => this.accept(ids));
        events.function('compose.revert', (id: number | 'all') => this.revert(id));
        events.function('compose.hideSelection', () => this.selectionHidden());

        events.on('compose.setAnalysisOptions', (options: { grid?: GridMode, lead?: number }) => this.setOptions(options));
        events.on('compose.setMap', (value: boolean) => this.setMap(value));
        events.on('compose.setHideLocked', (value: boolean) => {
            this.hideLocked = !!value;
            this.ctx.onChange();
            scene.forceRender = true;
        });
        events.on('compose.preview', (id: number | null, mode: PreviewMode) => this.setPreview(id, mode));
        events.on('compose.setShowSelection', (value: boolean) => {
            this.showSelection = !!value;
            this.ctx.onChange();
            scene.forceRender = true;
        });
        events.on('compose.setDisplay', (mode: DisplayMode) => {
            this.display = mode === 'mark' ? 'mark' : 'normal';
            this.scheduleDisplay();
            this.ctx.onChange();
        });
        events.on('compose.hover', (id: number | null) => this.setHover(id === null || id === undefined || id < 0 ? null : { kind: 'card', id }));
        events.on('compose.tick', (id: number, value: boolean) => {
            const card = this.card(id);
            if (!card) return;
            card.ticked = !!value;
            if (this.display === 'mark') this.scheduleDisplay();
            this.ctx.onChange();
            events.fire('compose.suggestionsChanged');
        });
        events.on('compose.tickAll', (value: boolean) => this.tickAll(!!value));
        events.on('compose.reject', (id: number) => this.reject(id));
        events.on('compose.restore', (id: number) => this.restore(id));
        events.on('compose.focusSuggestion', (id: number) => this.focus(id));
        events.on('compose.selectSuggestion', (id: number) => this.select(id));
        events.on('compose.force', (index: number) => this.force(index));

        // blurry areas (ids: AreaCard.id, the detector's rank)
        events.function('compose.areas', () => this.areasView());
        events.function('compose.deleteAreas', (ids: number[] | number | 'sharp') => this.deleteAreas(ids));
        events.function('compose.revertAreas', (id: number | 'all') => this.revertAreas(id));
        events.function('compose.selectArea', (id: number) => this.selectArea(id));
        events.on('compose.keepArea', (id: number, value?: boolean) => this.keepArea(id, value !== false));
        events.on('compose.focusArea', (id: number) => this.focusArea(id));
        events.on('compose.previewArea', (id: number | null, mode: PreviewMode) => this.setAreaPreview(id, mode));
        events.on('compose.hoverArea', (id: number | null) => this.setHover(id === null || id === undefined || id < 0 ? null : { kind: 'area', id }));
        events.on('compose.setAreaMark', (value: boolean) => {
            this.areaMark = !!value;
            this.scheduleDisplay();
            this.ctx.onChange();
        });

        // staleness and status
        const bump = (splat: Splat) => {
            this.versions.set(splat, (this.versions.get(splat) ?? 0) + 1);
            this.markDirty(splat);
        };
        events.on('splat.positionsChanged', bump);
        events.on('splat.replaced', (splat: Splat) => {
            // another instance list: what compose hid was in the old one
            this.records.delete(splat);
            bump(splat);
        });
        events.on('splat.moved', (splat: Splat) => this.markDirty(splat));
        events.on('splat.stateChanged', (splat: Splat) => {
            this.redrawOnLocks();
            this.markDirty(splat);
        });
        // every edit done, undone or redone (the record of what compose hid)
        events.on('edit.apply', (op: EditOp) => this.edited(op));

        // the probe: a double-click picks a focal point (along the pick ray:
        // the camera has not moved to it yet)
        events.on('camera.focalPointPicked', (details: { position: Vec3 }) => {
            if (!ctx.active() || !this.inSteps() || !this.analysis || this.busy || !details?.position) return;
            const p = details.position;
            const point: V3 = [p.x, p.y, p.z];
            this.probeAt(point, this.viewDir(point));
            this.ctx.onChange();
        });
    }

    // ------------------------------------------------------------ state

    private inSteps() {
        const step = this.ctx.step();
        return step === 'analyse' || step === 'suggest';
    }

    private signature(splat: Splat) {
        return signatureOf(splat, this.versions.get(splat) ?? 0);
    }

    card(id: number) {
        return this.analysis?.cards.find(c => c.id === id) ?? null;
    }

    // the analysis no longer matches the scans (moved, splats deleted or
    // added, data replaced, another set of scans)
    isStale() {
        const a = this.analysis;
        if (!a) return false;
        const scans = this.ctx.included();
        if (scans.length !== a.scans.length || scans.some((s, i) => s !== a.scans[i])) return true;
        return a.scans.some((s, i) => !sameSignature(a.sigs[i], this.signature(s)));
    }

    // isStale() as of the last status sync (cheap, for per-frame callers)
    get staleState() {
        return this.stale;
    }

    // the instance arrays of scan s still fit its instance list
    private fits(s: number) {
        const a = this.analysis;
        return !!a && sameList(a.scans[s], a.counts[s], a.sigs[s].print);
    }

    // something compose hid there is still hidden, and the instance lists fit
    canRevert(id: number) {
        const card = this.card(id);
        return !!card && card.locked > 0 && card.region.losers.every(l => this.fits(l));
    }

    // a card "Angehakte übernehmen" and "Alle anhaken" act on: not rejected,
    // not accepted, not hidden by hand already
    tickable(card: Card) {
        return !card.rejected && card.status !== 'accepted' && !card.handHidden;
    }

    // "Alle anhaken": ticks or unticks every open local card, the folded ones
    // too; the large-area cards keep their own tick. Ticks are UI state (no
    // undo step)
    private tickAll(value: boolean) {
        const a = this.analysis;
        if (!a) return;
        let changed = false;
        a.cards.forEach((card) => {
            if (card.region.scope === 'base' || !this.tickable(card) || card.ticked === value) return;
            card.ticked = value;
            changed = true;
        });
        if (!changed) return;
        if (this.display === 'mark') this.scheduleDisplay();
        this.ctx.onChange();
        this.events.fire('compose.suggestionsChanged');
    }

    // no 'before' preview for a card whose hide set is hidden (accepted, or
    // hidden by hand): the winner's splats left out next to the loser's
    // hidden ones would draw a hole
    private beforeBlocked(card: Card) {
        return card.status === 'accepted' || card.handHidden;
    }

    // the tint ('Scans einfärben') steps back while classes are shown
    suppressTint() {
        if (!this.analysis || !this.inSteps()) return false;
        if (this.map && !this.stale) return true;
        return this.ctx.step() === 'suggest' && (!!this.preview || !!this.areaPreview || this.display === 'mark' || this.areaMark);
    }

    // compose-tool's rebuild: the included scans may have changed
    refreshScans() {
        const scans = this.ctx.included();
        const same = scans.length === this.includedSet.size && scans.every(s => this.includedSet.has(s));
        if (same) return;
        this.includedSet = new Set(scans);
        // colours follow the order of the included scans
        this.scheduleDisplay();
        this.scheduleSync();
    }

    // the first visit of step 4 after an analysis judges detail in true
    // colours: the map goes off once
    enterSuggest() {
        const a = this.analysis;
        if (a && !a.visited) {
            a.visited = true;
            this.setMap(false);
        }
        this.scheduleDisplay();
    }

    stepChanged() {
        this.scheduleDisplay();
    }

    private setMap(value: boolean) {
        this.map = !!value;
        this.scheduleDisplay();
        this.ctx.onChange();
        this.scene.forceRender = true;
    }

    private setPreview(id: number | null, mode: PreviewMode) {
        const card = id === null || id === undefined ? null : this.card(id);
        if (!card || card.rejected || (mode === 'before' && this.beforeBlocked(card))) {
            this.preview = null;
        } else {
            this.preview = { id: card.id, mode: mode === 'before' ? 'before' : 'after' };
            // one preview at a time
            this.areaPreview = null;
            this.picked = card.id;
            // a preview of a region out of sight shows nothing: fly there
            if (!this.onScreen(card)) this.focus(card.id);
        }
        this.scheduleDisplay();
        this.ctx.onChange();
        // the selection may step back or come again (selectionHidden)
        this.scene.forceRender = true;
    }

    // while a Vorher/Nachher preview is up in step 4, the selection (its
    // tint, centres, rings and outline: the splats "Auswählen" picked draw as
    // points over the region) is not drawn, so the preview shows the scene as
    // the result will look; the selection itself stays as it is and draws
    // again when the preview ends. "Auswahl zeigen" keeps it drawn
    selectionHidden() {
        return (!!this.preview || !!this.areaPreview) && !this.showSelection && this.ctx.active() && this.ctx.step() === 'suggest' && !!this.analysis;
    }

    // the region's marker lies in front of the camera and inside the view
    // (with a margin)
    private onScreen(card: Card) {
        const camera = this.scene.camera;
        const main = camera.mainCamera;
        if (!main) return true;
        const m = card.region.marker;
        const p = new Vec3(m[0], m[1], m[2]);
        const ahead = p.clone().sub(main.getPosition()).dot(main.forward) > 0;
        if (!ahead) return false;
        const screen = new Vec3();
        camera.worldToScreen(p, screen);
        const margin = 0.05;
        return screen.x >= margin && screen.x <= 1 - margin && screen.y >= margin && screen.y <= 1 - margin;
    }

    setHover(hover: Hover | null) {
        const key = (h: Hover | null) => (!h ? '' : h.kind === 'skip' ? `skip ${h.index}` : `${h.kind} ${h.id}`);
        if (key(hover) === key(this.hover)) return;
        this.hover = hover;
        this.scheduleDisplay();
        this.scene.forceRender = true;
    }

    private setOptions(options: { grid?: GridMode, lead?: number }) {
        let changed = false;
        if (GRIDS.includes(options?.grid) && options.grid !== this.grid) {
            this.grid = options.grid;
            changed = true;
        }
        const lead = Number(options?.lead);
        if (LEADS.includes(lead) && lead !== this.lead) {
            this.lead = lead;
            changed = true;
        }
        if (changed && this.analysis) this.scheduleRerun();
        this.ctx.onChange();
    }

    private scheduleRerun() {
        if (this.rerunTimer) clearTimeout(this.rerunTimer);
        this.rerunTimer = setTimeout(() => {
            this.rerunTimer = null;
            if (!this.ctx.active()) return;
            if (this.busy) {
                this.rerunPending = true;
                return;
            }
            this.analyse(false);
        }, RERUN_DELAY);
    }

    // ------------------------------------------------------------ analysis

    // fresh: the button (re-read scans whose locks changed since their read,
    // so accepted areas read as winner-only); otherwise an option change,
    // which reuses the reads of unchanged scans
    async analyse(fresh: boolean): Promise<AnalyseSummary | null> {
        const scans = this.ctx.included();
        if (this.busy || scans.length < 2) return null;
        this.busy = true;
        this.message = '';
        this.ctx.onChange();
        // the options of this run (they may change while it runs)
        const grid = this.grid;
        const lead = this.lead;
        const t0 = performance.now();
        const title = i18n.t('sm.compose.analyse.run');
        let cancelled = false;
        const check = () => {
            if (cancelled) throw new AbortedError();
        };
        const progress = (text: string | undefined, value: number) => {
            this.events.fire('progressUpdate', text === undefined ? { progress: value } : { text, progress: value });
        };
        this.events.fire('progressStart', title, true);
        const cancel = this.events.on('progressCancel', () => {
            cancelled = true;
            abortAnalysis();
        });
        let summary: AnalyseSummary | null = null;
        try {
            const S = scans.length;
            const times: Record<string, number> = {};

            // 1. compact reads (cached while a scan is unchanged)
            let t = performance.now();
            const caches: ReadCache[] = [];
            for (let k = 0; k < S; k++) {
                const splat = scans[k];
                const sig = this.signature(splat);
                let cache = this.reads.get(splat);
                const locked = splat.instances.numLocked;
                if (!cache || !sameSignature(cache.sig, sig) || (fresh && cache.locked !== locked)) {
                    progress(i18n.t('sm.compose.analyse.reading', { name: this.ctx.nameOf(splat) }), P_READ * k / S);
                    const data = await readLayerCompact(splat, {
                        onProgress: (f: number) => {
                            check();
                            progress(undefined, P_READ * (k + f) / S);
                        }
                    });
                    check();
                    cache = { sig, locked, data, cells: null };
                    this.reads.set(splat, cache);
                }
                caches.push(cache);
            }
            const datas = caches.map(c => c.data);
            times.read = (performance.now() - t) / 1000;
            const up = upOf(this.ctx.reference());

            // 1b. the large blurry areas per scan (the simple path of step
            // 4): the rows are copied to the worker, the result comes back
            // (independent of grid and lead: an option change reuses it)
            t = performance.now();
            const blurFresh = this.blurCache && this.blurCache.datas.length === S && this.blurCache.datas.every((d, i) => d === datas[i]) &&
                this.blurCache.upAxis === up.upAxis && this.blurCache.upSign === up.upSign;
            if (!blurFresh) {
                progress(i18n.t('sm.compose.analyse.blur'), P_READ);
                const result = await runAnalysis<BlurResult>('compose-blur', {
                    scans: datas.map(d => ({ positions: d.positions, footprint: d.footprint, opacity: d.opacity })),
                    options: { upAxis: up.upAxis, upSign: up.upSign }
                });
                check();
                this.blurCache = { datas, upAxis: up.upAxis, upSign: up.upSign, result };
            }
            const blur = this.blurCache.result;
            times.blur = (performance.now() - t) / 1000;

            // 2. the grid: auto from the sparsest scan, or finer / coarser
            const base: DetailOptions = { lead, upAxis: up.upAxis, upSign: up.upSign };
            if (!this.autoCache || this.autoCache.datas.length !== S || this.autoCache.datas.some((d, i) => d !== datas[i])) {
                const samples = datas.map(d => cellSample(d, base));
                const diag = sceneDiagonal(datas.map(d => d.positions));
                this.autoCache = { datas, auto: autoCell(samples, diag, base), diag };
            }
            const { auto, diag } = this.autoCache;
            const options: DetailOptions = { ...base, sceneSize: diag };
            const cell = gridCell(auto.cell, grid, options);

            // 3. cell tables in the worker, all posted at once (it runs them
            // one after the other)
            t = performance.now();
            const pending = caches.map((cache) => {
                if (cache.cells && cache.cells.cell === cell && cache.cells.rowCell) return Promise.resolve(cache.cells);
                const d = cache.data;
                const job = runAnalysis<ScanCells>('compose-cells', {
                    rows: { positions: d.positions, footprint: d.footprint, opacity: d.opacity, lum: d.lum },
                    cell,
                    options
                });
                // an abort rejects every pending job; the ones not awaited yet
                // must not surface as unhandled
                job.catch(() => {});
                return job;
            });
            const cells: ScanCells[] = [];
            for (let k = 0; k < S; k++) {
                progress(i18n.t('sm.compose.analyse.cells', { name: this.ctx.nameOf(scans[k]) }), P_READ + P_BLUR + P_CELLS * k / S);
                const sc = await pending[k];
                check();
                caches[k].cells = sc;
                cells.push(sc);
            }
            times.cells = (performance.now() - t) / 1000;

            // 4. the comparison
            t = performance.now();
            progress(i18n.t('sm.compose.analyse.comparing'), P_READ + P_BLUR + P_CELLS);
            const detail = await runAnalysis<DetailResult>('compose-detail', { scans: cells.map(tableOf), options });
            check();
            times.detail = (performance.now() - t) / 1000;

            // 5. the cover proof per loser scan
            t = performance.now();
            const rowCells = cells.map(c => c.rowCell);
            const jobs = paintInputs(detail, datas, rowCells, options);
            times.inputs = (performance.now() - t) / 1000;
            t = performance.now();
            const results = await this.paint(jobs, scans, options, check, progress, P_READ + P_BLUR + P_CELLS + P_DETAIL, 100 - P_READ - P_BLUR - P_CELLS - P_DETAIL);
            times.paint = (performance.now() - t) / 1000;
            t = performance.now();
            const applied = applyPaint(detail, jobs, results, { ...options, rowCounts: datas.map(d => d.footprint.length) });
            times.apply = (performance.now() - t) / 1000;

            // 6. commit: per-instance arrays, cards, display
            this.commit({
                scans,
                sigs: caches.map(c => c.sig),
                counts: caches.map(c => c.sig.count),
                grid,
                leadFactor: lead,
                auto,
                cell,
                options,
                detail,
                cells,
                // own arrays: the auto-grid cache holds `datas`
                rows: datas.slice(),
                rowCells,
                paintRow: applied.paint,
                cellInst: [],
                paintInst: [],
                total: [],
                lockedBy: [],
                otherBy: [],
                records: [],
                cards: [],
                probe: null,
                seconds: (performance.now() - t0) / 1000,
                times,
                apartShare: 0,
                sharedCells: detail.shared.length,
                visited: false,
                areas: null
            }, blur);
            summary = this.summary();
        } catch (error) {
            this.message = error instanceof AbortedError ? i18n.t('sm.compose.analyse.cancelled') :
                i18n.t('sm.common.failed', { title, error: `${(error as Error).message ?? error}` });
        } finally {
            cancel.off();
            this.events.fire('progressEnd');
            this.busy = false;
            // the tool was closed while it ran: deactivate() left the reads
            // and per-row tables to it, they go now
            if (!this.ctx.active()) this.dropRows();
            this.ctx.onChange();
            this.scene.forceRender = true;
        }
        if (summary) this.events.fire('compose.analysed', summary);
        if (this.rerunPending) {
            this.rerunPending = false;
            this.scheduleRerun();
        }
        return summary;
    }

    // 'compose-paint' for every job, one after the other
    private async paint(jobs: PaintJob[], scans: Splat[], options: DetailOptions, check: () => void, progress: (text: string | undefined, value: number) => void, from: number, span: number) {
        const results: PaintResult[] = [];
        for (let j = 0; j < jobs.length; j++) {
            const job = jobs[j];
            const start = from + span * j / jobs.length;
            progress(i18n.t('sm.compose.analyse.cover', { name: this.ctx.nameOf(scans[job.loser]) }), start);
            const batches = job.batches.map(batchPayload);
            // the batch arrays move to the worker; applyPaint only needs the
            // ids, losers and row indices, which stay here
            const result = await runAnalysis<PaintResult>('compose-paint', { cell: job.cell, batches, options }, transferList(batches), (f: number) => {
                progress(undefined, start + span * f / jobs.length);
            });
            check();
            results.push(result);
        }
        return results;
    }

    private commit(a: Analysis, blur: BlurResult | null) {
        const S = a.scans.length;
        const { detail } = a;
        for (let s = 0; s < S; s++) {
            const n = a.counts[s];
            const cellInst = new Int32Array(n).fill(-1);
            const paintInst = new Uint16Array(n);
            const d = a.rows[s], rowCell = a.rowCells[s], remap = detail.remap[s], paint = a.paintRow[s];
            for (let r = 0; r < d.instances.length; r++) {
                const i = d.instances[r];
                if (i >= n) continue;
                const lc = rowCell[r];
                cellInst[i] = lc >= 0 ? remap[lc] : -1;
                paintInst[i] = paint[r];
            }
            a.cellInst.push(cellInst);
            a.paintInst.push(paintInst);
            // what compose hid in this instance list stays known (an earlier
            // analysis' accepts)
            a.records.push(this.recordFor(a.scans[s], n, a.sigs[s].print));
        }
        a.apartShare = this.apartShare(detail);

        // cards: ticked when clear (never the large-area ones); rejections
        // carry over from earlier analyses
        a.cards = detail.regions.map((region): Card => ({
            id: region.id,
            region,
            ticked: region.confidence === 'clear' && region.scope !== 'base',
            rejected: false,
            status: 'open',
            total: 0,
            locked: 0,
            others: 0,
            handHidden: false,
            forcedReason: null,
            forcedValue: NaN
        }));
        a.cards.forEach((card) => {
            if (this.memory.some(m => this.remembered(m, a, card.region))) {
                card.rejected = true;
                card.ticked = false;
            }
        });

        // the blurry areas as instances; their blur values go to the
        // sharpness view
        a.areas = blur ? this.areaState(a, blur) : null;
        a.scans.forEach((splat, s) => {
            const sharp = a.areas?.sharpInst[s];
            this.ctx.sharpSource?.(splat, sharp ? { bytes: sharp, median: blur.scans[s].ref } : null);
        });

        this.analysis = a;
        // card ids start anew; ops still queued keep their own instances
        this.queued.clear();
        this.areaQueued.clear();
        this.countTotals();
        for (let s = 0; s < S; s++) this.recount(s);
        this.updateStatuses();
        this.preview = null;
        this.picked = null;
        this.areaPreview = null;
        this.pickedArea = null;
        this.endFlash();
        this.hover = null;
        this.probeResult = null;
        this.stale = false;
        // the map switches on after a run, except in step 4 (true colours)
        a.visited = this.ctx.step() === 'suggest';
        this.map = !a.visited;
        this.message = '';
        this.scheduleDisplay();
        this.events.fire('compose.suggestionsChanged');
    }

    // share of the shared cells where the scans lie apart (state apart only:
    // uncovered cells, where the winner has no surface near the loser's
    // splats, are no misalignment)
    private apartShare(detail: DetailResult) {
        let apart = 0;
        for (let h = 0; h < detail.state.length; h++) if (detail.state[h] === CellState.apart) apart++;
        return detail.state.length ? apart / detail.state.length : 0;
    }

    private summary(): AnalyseSummary {
        const a = this.analysis;
        return {
            seconds: a.seconds,
            cell: a.cell,
            grid: a.grid,
            lead: a.leadFactor,
            auto: { cell: a.auto.cell, perScan: a.auto.perScan, forcedBy: a.auto.forcedBy >= 0 ? a.scans[a.auto.forcedBy].name : null },
            suggestions: a.cards.length,
            base: a.cards.filter(c => c.region.scope === 'base').length,
            clear: a.cards.filter(c => c.region.confidence === 'clear').length,
            skipped: a.detail.rejected.length,
            apartShare: a.apartShare,
            times: a.times,
            areas: a.areas?.cards.length ?? 0,
            areasSharp: a.areas?.cards.filter(c => c.area.compare === 'otherSharp').length ?? 0
        };
    }

    // ------------------------------------------------------------ blurry areas

    // the detector's areas as cards over instances: each area's rows
    // (indices into its scan's read) become its instances, and the per-row
    // blur value becomes the sharpness view's byte per instance
    private areaState(a: Analysis, blur: BlurResult): AreaState {
        const n = blur.areas.length;
        const areaInst = a.counts.map(count => new Uint16Array(count));
        const total = a.counts.map(() => new Uint32Array(n));
        blur.areas.forEach((area) => {
            const inst = a.rows[area.scan].instances;
            const out = areaInst[area.scan];
            const v = area.id + 1;
            const rows = area.rows;
            let k = 0;
            for (let j = 0; j < rows.length; j++) {
                const i = inst[rows[j]];
                if (i < out.length) {
                    out[i] = v;
                    k++;
                }
            }
            total[area.scan][area.id] = k;
        });
        // the detector's value (0..255 = BLUR.mapLo..mapHi octaves of the
        // mean of a splat's own and its voxel's footprint over the scan's
        // median) in the view's 1/32 octaves of the own measure: its range
        // 3..6 shows the detector's 2.5..4 (e = 3 + 2 (b - 2.5)). Nuremberg:
        // tinted from the start of the range 11.7 / 12.6 % of the splats of
        // A / B (own measure 7.5 / 8.7 %), in the bridge box 98.7 % of A's
        // visual weight (own 93 %); B there 9 % (own 6 %); A's white tree
        // crowns by the bridge 77 / 85 % (59 / 50 % before the detector took
        // the visual footprint, BLUR.mapVisShift)
        const code = new Uint8Array(256);
        for (let m = 0; m < 256; m++) {
            const b = BLUR.mapLo + m / 255 * (BLUR.mapHi - BLUR.mapLo);
            const e = m === 0 ? 0 : SHARP_FROM + SHARP_STRETCH * (b - SHARP_PIVOT);
            code[m] = Math.max(0, Math.min(255, Math.round(e * BLUR_STEPS)));
        }
        const sharpInst = a.counts.map((count, s) => {
            const out = new Uint8Array(count);
            const map = blur.blur[s];
            const inst = a.rows[s].instances;
            if (!map) return null;
            for (let r = 0; r < map.length && r < inst.length; r++) {
                const i = inst[r];
                if (i < count) out[i] = code[map[r]];
            }
            return out;
        });
        const cards = blur.areas.map((area): AreaCard => {
            const { rows, ...info } = area;
            return {
                id: area.id,
                area: info,
                scan: area.scan,
                kept: this.kept.some(m => this.keptCovers(m, a.scans[area.scan], info)),
                status: 'open',
                total: total[area.scan][area.id],
                locked: 0,
                others: 0,
                handHidden: false
            };
        }).sort((x, y) => AREA_GROUP(x.area) - AREA_GROUP(y.area) || y.area.voxels - x.area.voxels || x.id - y.id);
        return {
            cell: blur.cell,
            seconds: blur.seconds,
            cards,
            areaInst,
            sharpInst,
            total,
            lockedBy: total.map(t => new Uint32Array(t.length)),
            otherBy: total.map(t => new Uint32Array(t.length))
        };
    }

    // a kept area's memory covers an area: same scan, half its box inside
    private keptCovers(m: KeptMemory, splat: Splat, area: { min: V3, max: V3 }) {
        if (m.scan !== splat) return false;
        let inter = 1, volume = 1;
        for (let k = 0; k < 3; k++) {
            inter *= Math.max(0, Math.min(m.max[k], area.max[k]) - Math.max(m.min[k], area.min[k]));
            volume *= Math.max(0, area.max[k] - area.min[k]);
        }
        return volume > 0 && inter >= 0.5 * volume;
    }

    areaCard(id: number) {
        return this.analysis?.areas?.cards.find(c => c.id === id) ?? null;
    }

    // an area still offered for deletion: not kept, not deleted, not hidden
    // by hand already
    areaOpen(card: AreaCard) {
        return !card.kept && card.status !== 'accepted' && !card.handHidden;
    }

    // no 'before' for an area that is hidden (deleted, or by hand): it would
    // show the same as 'after'
    areaBeforeBlocked(card: AreaCard) {
        return card.status === 'accepted' || card.handHidden;
    }

    canRevertArea(id: number) {
        const card = this.areaCard(id);
        return !!card && card.locked > 0 && this.fits(card.scan);
    }

    private areaWaiting(card: AreaCard, kind: ComposeKind) {
        return this.areaQueued.get(card.id)?.kind === kind;
    }

    // per scan of the cards: an op over their instances that pass `take`
    // (picked when the op runs, as opsFor does for the suggestions)
    private opsForAreas(cards: AreaCard[], take: (s: number, flags: Uint8Array) => (i: number) => boolean,
        make: (splat: Splat, record: HiddenRecord, pick: () => IndexRanges) => ComposeHideOp | ComposeUnhideOp, ahead: (card: AreaCard) => boolean) {
        const a = this.analysis;
        const ar = a.areas;
        const ops: (ComposeHideOp | ComposeUnhideOp)[] = [];
        let now = 0;
        for (let s = 0; s < a.scans.length; s++) {
            const mine = cards.filter(c => c.scan === s);
            if (!mine.length || !this.fits(s)) continue;
            const want = new Uint8Array(ar.total[s].length + 1);
            mine.forEach((c) => {
                want[c.id + 1] = 1;
            });
            const later = mine.some(ahead);
            const splat = a.scans[s];
            const count = a.counts[s];
            const print = a.sigs[s].print;
            const inst = ar.areaInst[s];
            const test = (flags: Uint8Array) => {
                const pass = take(s, flags);
                return (i: number) => want[inst[i]] === 1 && pass(i);
            };
            const hit = test(splat.instances.flags);
            let n = 0;
            for (let i = 0; i < count; i++) if (hit(i)) n++;
            if (!n && !later) continue;
            now += n;
            ops.push(make(splat, a.records[s], () => (sameList(splat, count, print) ? IndexRanges.fromPredicate(count, test(splat.instances.flags)) : NO_RANGES)));
        }
        return { ops, now };
    }

    private enqueueAreas(kind: ComposeKind, cards: AreaCard[], ops: (ComposeHideOp | ComposeUnhideOp)[]) {
        const ids = cards.map(c => c.id);
        const op = new ComposeOp(kind, ops, () => {
            ids.forEach((id) => {
                if (this.areaQueued.get(id) === op) this.areaQueued.delete(id);
            });
        });
        ids.forEach(id => this.areaQueued.set(id, op));
        this.events.fire('edit.add', op);
    }

    // "Löschen": hide the areas' splats (ids, or 'sharp': every open area
    // where another scan is sharp) - one undo step, the same ops as an
    // accepted suggestion, so "Zurücknehmen" and Ctrl+Z bring them back.
    // Only unlocked instances; `hidden` counts them as of now
    deleteAreas(ids: number[] | number | 'sharp') {
        const ar = this.analysis?.areas;
        if (!ar || this.busy) return { hidden: 0 };
        this.flushSync();
        if (this.stale) return { hidden: 0, stale: true };
        const list = (ids === 'sharp' ?
            ar.cards.filter(c => c.area.compare === 'otherSharp' && this.areaOpen(c)) :
            (Array.isArray(ids) ? ids : [ids]).map(id => this.areaCard(id)).filter(c => c && !c.handHidden))
        .filter(c => !this.areaWaiting(c, 'accept'));
        if (!list.length) return { hidden: 0 };
        // a deleted area is kept no longer, and shows no 'before'
        list.forEach((c) => {
            if (c.kept) this.keepArea(c.id, false);
        });
        if (this.areaPreview?.mode === 'before' && list.some(c => c.id === this.areaPreview.id)) {
            this.areaPreview = null;
            this.scheduleDisplay();
        }
        const { ops, now } = this.opsForAreas(list, (_s, flags) => i => !(flags[i] & State.locked),
            (splat, record, pick) => new ComposeHideOp(splat, record, pick), c => this.areaWaiting(c, 'revert'));
        if (ops.length) this.enqueueAreas('accept', list, ops);
        this.ctx.onChange();
        return { hidden: now };
    }

    // show again what compose hid of the areas and is still hidden (its own
    // undo step); splats hidden by hand or by another tool stay hidden
    revertAreas(id: number | 'all') {
        const a = this.analysis;
        const ar = a?.areas;
        if (!ar || this.busy) return { shown: 0 };
        this.flushSync();
        const list = (id === 'all' ? ar.cards : [this.areaCard(id)].filter(Boolean))
        .filter(c => !this.areaWaiting(c, 'revert') && (c.locked > 0 || this.areaWaiting(c, 'accept')));
        if (!list.length) return { shown: 0 };
        const { ops, now } = this.opsForAreas(list, (s, flags) => {
            const mark = a.records[s].mark;
            return i => mark[i] === 1 && (flags[i] & State.locked) !== 0;
        }, (splat, record, pick) => new ComposeUnhideOp(splat, record, pick), c => this.areaWaiting(c, 'accept'));
        if (ops.length) this.enqueueAreas('revert', list, ops);
        return { shown: now };
    }

    // "Behalten" (value true) or "Wieder anbieten" (false); remembered
    // across analyses. UI state, no undo step
    keepArea(id: number, value: boolean) {
        const a = this.analysis;
        const card = this.areaCard(id);
        if (!a || !card || card.kept === value) return;
        card.kept = value;
        const splat = a.scans[card.scan];
        if (value) {
            this.kept.push({ scan: splat, min: card.area.min, max: card.area.max });
            if (this.kept.length > MEMORY_SIZE) this.kept.splice(0, this.kept.length - MEMORY_SIZE);
            if (this.areaPreview?.id === id) this.areaPreview = null;
            if (this.hover?.kind === 'area' && this.hover.id === id) this.hover = null;
        } else {
            this.kept = this.kept.filter(m => !this.keptCovers(m, splat, card.area));
        }
        this.scheduleDisplay();
        this.ctx.onChange();
        this.events.fire('compose.suggestionsChanged');
    }

    // the area's splats (not hidden) into the normal, undoable selection
    private selectArea(id: number) {
        const a = this.analysis;
        const card = this.areaCard(id);
        if (!a || !card || !this.fits(card.scan)) return 0;
        const s = card.scan;
        const splat = a.scans[s];
        const count = splat.instances.count;
        const flags = splat.instances.flags;
        const inst = a.areas.areaInst[s];
        const value = card.id + 1;
        const mask = new Uint8Array(count);
        let n = 0;
        for (let i = 0; i < count; i++) {
            if (inst[i] === value && !(flags[i] & State.locked)) {
                mask[i] = 255;
                n++;
            }
        }
        this.pickedArea = id;
        if (this.events.invoke('selection') !== splat) this.events.fire('selection', splat);
        this.events.fire('select.mask', 'set', mask);
        this.ctx.onChange();
        return n;
    }

    // scattered islands gathered into one area have no single place to
    // look from: the camera shows their whole box
    private areaScattered(card: AreaCard) {
        return card.area.kind === 'island' && card.area.pieces > 1;
    }

    // fly to an area: from outside it, from the side of its scan's sharp
    // part (the detector's view), or its whole box
    private flyToArea(card: AreaCard) {
        const a = this.analysis;
        const area = card.area;
        if (!this.areaScattered(card) && area.view) {
            const { position, target } = area.view;
            this.events.fire('camera.setPose', {
                position: new Vec3(position[0], position[1], position[2]),
                target: new Vec3(target[0], target[1], target[2])
            }, 1);
            return;
        }
        const radius = Math.max(a.areas.cell, 0.5 * Math.hypot(area.dims[0], area.dims[1], area.dims[2]));
        const c = [0, 1, 2].map(k => (area.min[k] + area.max[k]) / 2);
        this.scene.camera.focus({ focalPoint: new Vec3(c[0], c[1], c[2]), radius, speed: 1 });
    }

    // a click on an area's card: fly there and light the area up briefly
    focusArea(id: number) {
        const card = this.areaCard(id);
        if (!card) return;
        this.pickedArea = id;
        this.flyToArea(card);
        this.endFlash();
        this.areaFlash = { id, until: performance.now() + AREA_FLASH_MS };
        this.areaFlashTimer = setTimeout(() => {
            this.areaFlashTimer = null;
            this.areaFlash = null;
            this.scheduleDisplay();
            this.scene.forceRender = true;
        }, AREA_FLASH_MS);
        this.scheduleDisplay();
        this.ctx.onChange();
    }

    private endFlash() {
        if (this.areaFlashTimer) clearTimeout(this.areaFlashTimer);
        this.areaFlashTimer = null;
        this.areaFlash = null;
    }

    // the area's centre lies in front of the camera and inside the view
    private areaOnScreen(card: AreaCard) {
        const camera = this.scene.camera;
        const main = camera.mainCamera;
        if (!main) return true;
        const m = card.area.centroid;
        const p = new Vec3(m[0], m[1], m[2]);
        if (p.clone().sub(main.getPosition()).dot(main.forward) <= 0) return false;
        const screen = new Vec3();
        camera.worldToScreen(p, screen);
        return screen.x >= 0.05 && screen.x <= 0.95 && screen.y >= 0.05 && screen.y <= 0.95;
    }

    // Vorher: the scene as it is, in true colours; Nachher: without the
    // area. One preview at a time (a card's ends)
    private setAreaPreview(id: number | null, mode: PreviewMode) {
        const card = id === null || id === undefined ? null : this.areaCard(id);
        if (!card || card.kept || (mode === 'before' && this.areaBeforeBlocked(card))) {
            this.areaPreview = null;
        } else {
            this.areaPreview = { id: card.id, mode: mode === 'before' ? 'before' : 'after' };
            this.preview = null;
            this.pickedArea = card.id;
            this.endFlash();
            if (!this.areaOnScreen(card)) this.flyToArea(card);
        }
        this.scheduleDisplay();
        this.ctx.onChange();
        this.scene.forceRender = true;
    }

    // a hovered or just clicked area of this scan draws red over the
    // sharpness view (allocation-free: asked per layer and pass)
    private areaLit(splat: Splat) {
        const a = this.analysis;
        if (!a?.areas || (!this.areaFlash && this.hover?.kind !== 'area') || this.ctx.step() !== 'suggest') return false;
        const flash = this.areaFlash ? this.areaFlash.id : -1;
        const hover = this.hover?.kind === 'area' ? this.hover.id : -1;
        const cards = a.areas.cards;
        for (let k = 0; k < cards.length; k++) {
            const card = cards[k];
            if ((card.id === flash || card.id === hover) && !card.kept && a.scans[card.scan] === splat) return true;
        }
        return false;
    }

    areasView() {
        const a = this.analysis;
        const ar = a?.areas;
        if (!ar) return [];
        this.flushSync();
        const name = (s: number) => (s >= 0 ? a.scans[s].name : null);
        return ar.cards.map((c, k) => ({
            id: c.id,
            number: k + 1,
            scan: name(c.scan),
            // the name the panel shows (numbered when two layers share it)
            scanLabel: this.ctx.nameOf(a.scans[c.scan]),
            kind: c.area.kind,
            compare: c.area.compare,
            sharpBy: name(c.area.sharpBy),
            scattered: this.areaScattered(c),
            splats: c.area.splats,
            voxels: c.area.voxels,
            dims: c.area.dims,
            min: c.area.min,
            max: c.area.max,
            centroid: c.area.centroid,
            view: c.area.view,
            blur: c.area.blur,
            lead: c.area.lead,
            score: c.area.score,
            pieces: c.area.pieces,
            otherSharp: c.area.otherSharp,
            otherBlurry: c.area.otherBlurry,
            alone: c.area.alone,
            kept: c.kept,
            status: c.status,
            handHidden: c.handHidden,
            // instances of the area, hidden by compose, hidden otherwise
            total: c.total,
            locked: c.locked,
            others: c.others
        }));
    }

    // ------------------------------------------------------------ status

    private maxId() {
        const a = this.analysis;
        return a.cards.reduce((m, c) => Math.max(m, c.id), -1);
    }

    // the record of what compose hid in a scan's instance list of this count
    // and print (an earlier one when the list came back, else a new one)
    private recordFor(splat: Splat, count: number, print: number) {
        let list = this.records.get(splat);
        if (!list) {
            list = [];
            this.records.set(splat, list);
        }
        let record = list.find(r => r.count === count && r.print === print);
        if (!record) {
            record = { count, print, mark: new Uint8Array(count) };
            list.unshift(record);
            if (list.length > RECORDS_KEPT) list.length = RECORDS_KEPT;
        }
        return record;
    }

    // an edit was done, undone or redone. Compose's own ops keep the record
    // themselves; after any other edit, marked instances no longer hidden
    // were shown by it (Shift+H, an undo of another tool's edit): they lose
    // their mark, so that hiding them again by hand later does not make them
    // compose's. The history is strictly last in, first out, so when that
    // edit is undone they are hidden again as compose left them and get
    // their mark back; a redo clears it again
    private edited(op: EditOp) {
        if (op instanceof ComposeOp || !this.records.size) return;
        const targets = new Set<Splat>();
        const known = lockTargets(op, targets);
        let saved = this.cleared.get(op);
        // this edit's earlier clears: marked again while it is undone
        saved?.forEach(({ splat, shown }, record) => {
            if (!sameList(splat, record.count, record.print)) return;
            const flags = splat.instances.flags;
            const { mark } = record;
            let changed = false;
            for (let j = 0; j < shown.length; j++) {
                const i = shown[j];
                const v = flags[i] & State.locked ? 1 : 0;
                if (mark[i] !== v) {
                    mark[i] = v;
                    changed = true;
                }
            }
            if (changed) this.markDirty(splat);
        });
        this.records.forEach((list, splat) => {
            if (known && !targets.has(splat)) return;
            const count = splat.instances.count;
            const print = listPrint(splat);
            const record = list.find(r => r.count === count && r.print === print);
            if (!record) return;
            const flags = splat.instances.flags;
            const { mark } = record;
            let n = 0;
            for (let i = 0; i < count; i++) if (mark[i] && !(flags[i] & State.locked)) n++;
            if (!n) return;
            // marked instances shown again by this edit
            const shown = new Uint32Array(n);
            n = 0;
            for (let i = 0; i < count; i++) {
                if (mark[i] && !(flags[i] & State.locked)) {
                    mark[i] = 0;
                    shown[n++] = i;
                }
            }
            if (!saved) {
                saved = new Map();
                this.cleared.set(op, saved);
            }
            const before = saved.get(record);
            if (before) {
                const merged = new Uint32Array(before.shown.length + shown.length);
                merged.set(before.shown);
                merged.set(shown, before.shown.length);
                before.shown = merged;
            } else {
                saved.set(record, { splat, shown });
            }
            this.markDirty(splat);
        });
    }

    // hide-set sizes per scan and id (they only change with a forced region)
    private countTotals() {
        const a = this.analysis;
        const ids = this.maxId() + 1;
        a.total = a.paintInst.map((paint) => {
            const total = new Uint32Array(ids);
            for (let i = 0; i < paint.length; i++) {
                const v = paint[i];
                if (v && !(v & KEPT) && v <= ids) total[v - 1]++;
            }
            return total;
        });
        a.lockedBy = a.paintInst.map(() => new Uint32Array(ids));
        a.otherBy = a.paintInst.map(() => new Uint32Array(ids));
        a.cellHides = null;
    }

    // what the cards hide in some cells, summed per card and loser (largest
    // first). Cards hide rows outside their own cells as well: big splats in
    // the ring and the blur haze (compose-detail DETAIL haze) up to 6 cells
    // off, in cells the probe and the skip list describe by their own state
    hidesIn(cells: ArrayLike<number>): CellHide[] {
        const a = this.analysis;
        if (!a) return [];
        if (!a.cellHides) {
            const map = new Map<number, CellHide[]>();
            a.paintInst.forEach((paint, scan) => {
                const cellInst = a.cellInst[scan];
                for (let i = 0; i < paint.length; i++) {
                    const v = paint[i];
                    const g = cellInst[i];
                    if (!v || (v & KEPT) || g < 0) continue;
                    let list = map.get(g);
                    if (!list) map.set(g, list = []);
                    const e = list.find(h => h.card === v - 1 && h.scan === scan);
                    if (e) e.n++;
                    else list.push({ card: v - 1, scan, n: 1 });
                }
            });
            a.cellHides = map;
        }
        const sum: CellHide[] = [];
        for (let j = 0; j < cells.length; j++) {
            a.cellHides.get(cells[j])?.forEach((h) => {
                const e = sum.find(q => q.card === h.card && q.scan === h.scan);
                if (e) e.n += h.n;
                else sum.push({ ...h });
            });
        }
        return sum.filter(h => this.card(h.card)).sort((x, y) => y.n - x.n || x.card - y.card || x.scan - y.scan);
    }

    // locked instances of each hide set of scan s: the ones compose hid and
    // the others; false when its instance list no longer fits the analysis
    private recount(s: number) {
        const a = this.analysis;
        if (!this.fits(s)) return false;
        const flags = a.scans[s].instances.flags;
        const paint = a.paintInst[s];
        const mark = a.records[s].mark;
        const locked = a.lockedBy[s];
        const other = a.otherBy[s];
        locked.fill(0);
        other.fill(0);
        for (let i = 0; i < paint.length; i++) {
            const v = paint[i];
            if (v && !(v & KEPT) && v <= locked.length && (flags[i] & State.locked)) {
                if (mark[i]) locked[v - 1]++;
                else other[v - 1]++;
            }
        }
        // the blurry areas of the scan, the same way
        const ar = a.areas;
        if (ar) {
            const inst = ar.areaInst[s];
            const aLocked = ar.lockedBy[s];
            const aOther = ar.otherBy[s];
            aLocked.fill(0);
            aOther.fill(0);
            for (let i = 0; i < inst.length; i++) {
                const v = inst[i];
                if (v && (flags[i] & State.locked)) {
                    if (mark[i]) aLocked[v - 1]++;
                    else aOther[v - 1]++;
                }
            }
        }
        return true;
    }

    // status: the share compose hid of the hide set's instances not hidden
    // otherwise (splats hidden by hand before an accept leave it 'accepted').
    // Hidden by hand: not accepted, but compose's and the others' locks
    // together reach the accepted share of the whole hide set
    private updateStatuses() {
        const a = this.analysis;
        let changed = false;
        a.cards.forEach((card) => {
            let total = 0, locked = 0, others = 0;
            card.region.losers.forEach((l) => {
                total += a.total[l][card.id] ?? 0;
                locked += a.lockedBy[l][card.id] ?? 0;
                others += a.otherBy[l][card.id] ?? 0;
            });
            const own = total - others;
            const share = own > 0 ? locked / own : 0;
            const status: CardStatus = share >= ACCEPTED_SHARE ? 'accepted' : share >= PARTLY_SHARE ? 'partly' : 'open';
            const handHidden = status !== 'accepted' && total > 0 && locked + others >= ACCEPTED_SHARE * total;
            if (status !== card.status || locked !== card.locked || total !== card.total || others !== card.others || handHidden !== card.handHidden) changed = true;
            card.status = status;
            card.total = total;
            card.locked = locked;
            card.others = others;
            card.handHidden = handHidden;
        });
        // a hidden card shows no 'before' preview (see beforeBlocked)
        const previewed = this.preview?.mode === 'before' ? this.card(this.preview.id) : null;
        if (previewed && this.beforeBlocked(previewed)) {
            this.preview = null;
            changed = true;
        }
        // the blurry areas: deleted (compose hid them), partly, or hidden
        // by hand, as the cards
        const ar = a.areas;
        ar?.cards.forEach((card) => {
            const total = ar.total[card.scan][card.id] ?? 0;
            const locked = ar.lockedBy[card.scan][card.id] ?? 0;
            const others = ar.otherBy[card.scan][card.id] ?? 0;
            const own = total - others;
            const share = own > 0 ? locked / own : 0;
            const status: CardStatus = share >= ACCEPTED_SHARE ? 'accepted' : share >= PARTLY_SHARE ? 'partly' : 'open';
            const handHidden = status !== 'accepted' && total > 0 && locked + others >= ACCEPTED_SHARE * total;
            if (status !== card.status || locked !== card.locked || total !== card.total || others !== card.others || handHidden !== card.handHidden) changed = true;
            card.status = status;
            card.total = total;
            card.locked = locked;
            card.others = others;
            card.handHidden = handHidden;
        });
        const areaShown = this.areaPreview?.mode === 'before' ? this.areaCard(this.areaPreview.id) : null;
        if (areaShown && this.areaBeforeBlocked(areaShown)) {
            this.areaPreview = null;
            changed = true;
        }
        return changed;
    }

    private markDirty(splat: Splat) {
        if (!this.analysis?.scans.includes(splat)) return;
        this.dirty.add(splat);
        this.scheduleSync();
    }

    private scheduleSync() {
        if (this.syncFrame) return;
        this.syncFrame = nextFrame(() => {
            this.syncFrame = null;
            this.sync();
        });
    }

    // status from the lock bits and staleness, at most once per frame
    private sync() {
        const a = this.analysis;
        if (!a) {
            this.dirty.clear();
            return;
        }
        this.dirty.forEach((splat) => {
            const s = a.scans.indexOf(splat);
            if (s >= 0) this.recount(s);
        });
        this.dirty.clear();
        let changed = this.updateStatuses();
        const stale = this.isStale();
        if (stale !== this.stale) {
            this.stale = stale;
            changed = true;
        }
        if (changed) {
            this.scheduleDisplay();
            this.ctx.onChange();
            this.events.fire('compose.suggestionsChanged');
        }
    }

    // the drawn 'before' preview's losers locked or unlocked splats since it
    // was composed (allocation-free: asked at every render)
    private locksMoved() {
        const b = this.beforeLocks;
        if (!b) return false;
        for (let k = 0; k < b.losers.length; k++) {
            if (b.losers[k].instances.numLocked !== b.locked[k]) return true;
        }
        return false;
    }

    // then compose again at once, also when no count of the card changes
    // (splats outside its hide set): renderParams asks before a frame
    // draws the new lock bits, 'splat.stateChanged' at the end of the edit
    // (when no frame drew in between)
    private redrawOnLocks() {
        if (!this.locksMoved()) return;
        this.displayFrame?.();
        this.displayFrame = null;
        this.writeDisplays();
    }

    // pending status work now (for the API)
    private flushSync() {
        if (this.syncFrame) {
            this.syncFrame();
            this.syncFrame = null;
        }
        this.sync();
    }

    // ------------------------------------------------------------ accept

    // the newest accept or revert of a card still waiting in the edit queue
    private waiting(card: Card, kind: ComposeKind) {
        return this.queued.get(card.id)?.kind === kind;
    }

    // one accept or revert into the edit queue; until it has run, the cards
    // count as waiting for it
    private enqueue(kind: ComposeKind, cards: Card[], ops: (ComposeHideOp | ComposeUnhideOp)[]) {
        const ids = cards.map(c => c.id);
        const op = new ComposeOp(kind, ops, () => {
            ids.forEach((id) => {
                if (this.queued.get(id) === op) this.queued.delete(id);
            });
        });
        ids.forEach(id => this.queued.set(id, op));
        this.events.fire('edit.add', op);
    }

    // per scan of the cards' losers: an op over the hide sets of the cards in
    // that scan whose instances pass `take` (picked when the op runs), and
    // how many pass now. A scan where none pass now gets no op unless `ahead`
    // says a waiting op of the opposite kind changes that before it runs
    private opsFor(cards: Card[], take: (s: number, flags: Uint8Array) => (i: number) => boolean,
        make: (splat: Splat, record: HiddenRecord, pick: () => IndexRanges) => ComposeHideOp | ComposeUnhideOp, ahead: (card: Card) => boolean) {
        const a = this.analysis;
        const ids1 = this.maxId() + 2;
        const ops: (ComposeHideOp | ComposeUnhideOp)[] = [];
        let now = 0;
        for (let s = 0; s < a.scans.length; s++) {
            const want = new Uint8Array(ids1);
            let any = false, later = false;
            cards.forEach((card) => {
                if (card.region.losers.includes(s)) {
                    want[card.id + 1] = 1;
                    any = true;
                    later = later || ahead(card);
                }
            });
            // nothing once the instance list changed
            if (!any || !this.fits(s)) continue;
            const splat = a.scans[s];
            const count = a.counts[s];
            const print = a.sigs[s].print;
            const paint = a.paintInst[s];
            const test = (flags: Uint8Array) => {
                const pass = take(s, flags);
                return (i: number) => {
                    const v = paint[i];
                    return v < ids1 && want[v] === 1 && pass(i);
                };
            };
            const hit = test(splat.instances.flags);
            let n = 0;
            for (let i = 0; i < count; i++) if (hit(i)) n++;
            if (!n && !later) continue;
            now += n;
            ops.push(make(splat, a.records[s], () => (sameList(splat, count, print) ? IndexRanges.fromPredicate(count, test(splat.instances.flags)) : NO_RANGES)));
        }
        return { ops, now };
    }

    // hide the hide sets of the given cards ('ticked': every ticked open
    // card): one undo step for all their losers. Only unlocked instances, so
    // undo restores exactly; `hidden` counts them as of now (the op picks
    // them when it runs). A card whose accept still waits is left out, and
    // so is one hidden by hand already (it would hide only the splats left
    // out of that, perhaps on purpose)
    accept(ids: number[] | number | 'ticked') {
        const a = this.analysis;
        if (!a || this.busy) return { hidden: 0 };
        this.flushSync();
        if (this.stale) return { hidden: 0, stale: true };
        const list = (ids === 'ticked' ?
            a.cards.filter(c => c.ticked && this.tickable(c)) :
            (Array.isArray(ids) ? ids : [ids]).map(id => this.card(id)).filter(c => c && !c.rejected && !c.handHidden))
        .filter(c => !this.waiting(c, 'accept'));
        if (!list.length) return { hidden: 0 };
        // an accepted card shows no 'before' preview (it would show a hole)
        if (this.preview?.mode === 'before' && list.some(c => c.id === this.preview.id)) {
            this.preview = null;
            this.scheduleDisplay();
            this.ctx.onChange();
        }
        const { ops, now } = this.opsFor(list, (_s, flags) => i => !(flags[i] & State.locked),
            (splat, record, pick) => new ComposeHideOp(splat, record, pick), c => this.waiting(c, 'revert'));
        if (ops.length) this.enqueue('accept', list, ops);
        return { hidden: now };
    }

    // show again what compose hid of the cards' hide sets and is still
    // hidden (its own undo step); splats hidden by hand or by another tool
    // stay hidden. A card whose revert still waits is left out
    revert(id: number | 'all') {
        const a = this.analysis;
        if (!a || this.busy) return { shown: 0 };
        this.flushSync();
        const list = (id === 'all' ? a.cards : [this.card(id)].filter(Boolean))
        .filter(c => !this.waiting(c, 'revert') && (c.locked > 0 || this.waiting(c, 'accept')));
        if (!list.length) return { shown: 0 };
        const { ops, now } = this.opsFor(list, (s, flags) => {
            const mark = a.records[s].mark;
            return i => mark[i] === 1 && (flags[i] & State.locked) !== 0;
        }, (splat, record, pick) => new ComposeUnhideOp(splat, record, pick), c => this.waiting(c, 'accept'));
        if (ops.length) this.enqueue('revert', list, ops);
        return { shown: now };
    }

    private reject(id: number) {
        const a = this.analysis;
        const card = this.card(id);
        if (!a || !card) return;
        card.rejected = true;
        card.ticked = false;
        const r = card.region;
        this.memory.push({
            winner: a.scans[r.winner],
            losers: r.losers.map(l => a.scans[l]),
            keys: new Set(Array.from(r.cells, g => a.detail.keys[g])),
            cell: a.cell,
            min: r.min,
            max: r.max
        });
        if (this.memory.length > MEMORY_SIZE) this.memory.splice(0, this.memory.length - MEMORY_SIZE);
        if (this.preview?.id === id) this.preview = null;
        if (this.hover?.kind === 'card' && this.hover.id === id) this.hover = null;
        this.scheduleDisplay();
        this.ctx.onChange();
        this.events.fire('compose.suggestionsChanged');
    }

    private restore(id: number) {
        const a = this.analysis;
        const card = this.card(id);
        if (!a || !card) return;
        card.rejected = false;
        this.memory = this.memory.filter(m => !this.remembered(m, a, card.region));
        this.ctx.onChange();
        this.events.fire('compose.suggestionsChanged');
    }

    // a remembered rejection covers a region: same winner, a shared loser
    // and half the region's cells (with another grid: half its box)
    private remembered(m: RejectMemory, a: Analysis, r: Region) {
        if (a.scans[r.winner] !== m.winner) return false;
        if (!r.losers.some(l => m.losers.includes(a.scans[l]))) return false;
        if (m.cell === a.cell) {
            let hit = 0;
            r.cells.forEach((g) => {
                if (m.keys.has(a.detail.keys[g])) hit++;
            });
            return hit >= 0.5 * r.cells.length;
        }
        let inter = 1, volume = 1;
        for (let k = 0; k < 3; k++) {
            inter *= Math.max(0, Math.min(m.max[k], r.max[k]) - Math.max(m.min[k], r.min[k]));
            volume *= Math.max(0, r.max[k] - r.min[k]);
        }
        return volume > 0 && inter >= 0.5 * volume;
    }

    // the first loser's hide set into the normal, undoable selection
    private select(id: number) {
        const a = this.analysis;
        const card = this.card(id);
        if (!a || !card) return 0;
        const L = card.region.losers[0];
        if (!this.fits(L)) return 0;
        const splat = a.scans[L];
        const count = splat.instances.count;
        const flags = splat.instances.flags;
        const paint = a.paintInst[L];
        const value = card.id + 1;
        const mask = new Uint8Array(count);
        let n = 0;
        for (let i = 0; i < count; i++) {
            if (paint[i] === value && !(flags[i] & State.locked)) {
                mask[i] = 255;
                n++;
            }
        }
        if (this.events.invoke('selection') !== splat) this.events.fire('selection', splat);
        this.events.fire('select.mask', 'set', mask);
        return n;
    }

    // a card picked in the panel (a click on its text or head): marked as
    // the current one, and the camera flies to it
    pick(id: number) {
        if (!this.card(id)) return;
        this.picked = id;
        this.focus(id);
    }

    // fly along the region's first free view, else to its marker
    private focus(id: number) {
        const a = this.analysis;
        const card = this.card(id);
        if (!a || !card) return;
        this.picked = id;
        const r = card.region;
        const view = r.views?.[0];
        if (view) {
            this.events.fire('camera.setPose', {
                position: new Vec3(view.position[0], view.position[1], view.position[2]),
                target: new Vec3(view.target[0], view.target[1], view.target[2])
            }, 1);
        } else {
            const radius = Math.max(a.cell, 0.5 * Math.hypot(r.max[0] - r.min[0], r.max[1] - r.min[1], r.max[2] - r.min[2]));
            this.scene.camera.focus({ focalPoint: new Vec3(r.marker[0], r.marker[1], r.marker[2]), radius, speed: 1 });
        }
    }

    focusRejected(index: number) {
        const a = this.analysis;
        const r = a?.detail.rejected[index];
        if (!r) return;
        const radius = Math.max(a.cell, 0.5 * Math.hypot(r.max[0] - r.min[0], r.max[1] - r.min[1], r.max[2] - r.min[2]));
        this.scene.camera.focus({ focalPoint: new Vec3(r.centre[0], r.centre[1], r.centre[2]), radius, speed: 1 });
    }

    // the scan to move for "Hier ausrichten" at rejected cluster index (an
    // 'apart' one; nothing else is a misalignment): of its scans the one
    // present in most of its cells that is not the reference
    alignTarget(index: number) {
        const a = this.analysis;
        const r = a?.detail.rejected[index];
        if (!r || r.reason !== 'apart') return null;
        const ref = this.ctx.reference();
        const votes = new Array(a.scans.length).fill(0);
        r.cells.forEach((g) => {
            const pm = a.detail.present[g];
            for (let s = 0; s < a.scans.length; s++) if ((pm >> s) & 1) votes[s]++;
        });
        let best = -1;
        for (let s = 0; s < a.scans.length; s++) {
            if (a.scans[s] === ref) continue;
            if (r.loser >= 0 && s !== r.loser && s !== r.winner) continue;
            if (best < 0 || votes[s] > votes[best]) best = s;
        }
        return best >= 0 && votes[best] > 0 ? a.scans[best] : null;
    }

    // "Trotzdem übernehmen": a texture / sparse cluster becomes a 'check'
    // card of its own (painted like the others; nothing is hidden yet)
    async force(index: number) {
        const a = this.analysis;
        const rejected = a?.detail.rejected[index];
        if (!a || !rejected || this.busy || (rejected.reason !== 'texture' && rejected.reason !== 'sparse') || rejected.winner < 0 || rejected.loser < 0) return null;
        this.flushSync();
        if (this.stale) return null;
        this.busy = true;
        this.message = '';
        this.ctx.onChange();
        const title = i18n.t('sm.compose.skip.force');
        let cancelled = false;
        const check = () => {
            if (cancelled) throw new AbortedError();
        };
        const progress = (text: string | undefined, value: number) => {
            this.events.fire('progressUpdate', text === undefined ? { progress: value } : { text, progress: value });
        };
        this.events.fire('progressStart', title, true);
        const cancel = this.events.on('progressCancel', () => {
            cancelled = true;
            abortAnalysis();
        });
        let result: { id: number } | null = null;
        try {
            await this.restoreRows(a, check, progress);
            const o = a.options;
            const region = forceRegion(a.cells, a.detail, rejected, o);
            const jobs = paintInputs(a.detail, a.rows, a.rowCells, { ...o, regions: [region], existing: a.paintRow });
            const results = await this.paint(jobs, a.scans, o, check, progress, 30, 70);
            // nothing changed before this point: a cancel leaves no state
            a.detail.regions.push(region);
            // its free cells are the region's before applyPaint, which reads
            // and clears regionOf (a dropped region, apart clusters leaving it)
            region.cells.forEach((g) => {
                if (a.detail.regionOf[g] < 0) a.detail.regionOf[g] = region.id;
            });
            applyPaint(a.detail, jobs, results, { ...o, rowCounts: a.rows.map(r => r.footprint.length), paint: a.paintRow });
            a.detail.rejected = a.detail.rejected.filter(r => r !== rejected);
            if (a.detail.regions.includes(region)) {
                jobs.forEach(job => job.batches.forEach((batch) => {
                    const L = batch.loser;
                    const instances = a.rows[L].instances;
                    const paintRow = a.paintRow[L];
                    const paintInst = a.paintInst[L];
                    batch.rows.forEach((r) => {
                        const i = instances[r];
                        if (i < paintInst.length) paintInst[i] = paintRow[r];
                    });
                }));
                a.cards.push({
                    id: region.id,
                    region,
                    ticked: false,
                    rejected: false,
                    status: 'open',
                    total: 0,
                    locked: 0,
                    others: 0,
                    handHidden: false,
                    forcedReason: rejected.reason === 'texture' ? 'texture' : 'sparse',
                    forcedValue: rejected.value
                });
                result = { id: region.id };
            } else {
                // dropped as apart: its cells are free again
                region.cells.forEach((g) => {
                    if (a.detail.regionOf[g] === region.id) a.detail.regionOf[g] = -1;
                });
                this.message = i18n.t('sm.compose.skip.force-apart');
            }
            a.apartShare = this.apartShare(a.detail);
            this.countTotals();
            for (let s = 0; s < a.scans.length; s++) this.recount(s);
            this.updateStatuses();
            this.scheduleDisplay();
            this.events.fire('compose.suggestionsChanged');
            // the panel shows the new card (also past its fold) when it
            // rebuilds below
            if (result) this.events.fire('compose.forced', result.id);
        } catch (error) {
            // a cancel changes nothing (see above)
            this.message = error instanceof AbortedError ? i18n.t('sm.compose.skip.force-cancelled') :
                i18n.t('sm.common.failed', { title, error: `${(error as Error).message ?? error}` });
        } finally {
            cancel.off();
            this.events.fire('progressEnd');
            this.busy = false;
            // closed while it ran: the rows (read again) go now
            if (!this.ctx.active()) this.dropRows();
            this.ctx.onChange();
        }
        return result;
    }

    // the reads were dropped (the tool was closed): read again and map the
    // rows onto the analysis' cells and paint (locked rows are not read;
    // they are hidden and so taken anyway)
    private async restoreRows(a: Analysis, check: () => void, progress: (text: string | undefined, value: number) => void) {
        const S = a.scans.length;
        for (let s = 0; s < S; s++) {
            if (a.rows[s] && a.rowCells[s] && a.paintRow[s]) continue;
            const splat = a.scans[s];
            const sig = this.signature(splat);
            const locked = splat.instances.numLocked;
            progress(i18n.t('sm.compose.analyse.reading', { name: this.ctx.nameOf(splat) }), 30 * s / S);
            const data = await readLayerCompact(splat, {
                onProgress: (f: number) => {
                    check();
                    progress(undefined, 30 * (s + f) / S);
                }
            });
            check();
            const keys = a.cells[s].keys;
            const c = a.cell;
            const p = data.positions;
            const n = data.footprint.length;
            const rowCell = new Int32Array(n);
            let lastKey = NaN, last = -1;
            for (let r = 0; r < n; r++) {
                const key = keyOf(Math.floor(p[r * 3] / c), Math.floor(p[r * 3 + 1] / c), Math.floor(p[r * 3 + 2] / c));
                if (key !== lastKey) {
                    lastKey = key;
                    last = Number.isNaN(key) ? -1 : findKey(keys, key);
                }
                rowCell[r] = last;
            }
            const paintRow = new Uint16Array(n);
            const paintInst = a.paintInst[s];
            for (let r = 0; r < n; r++) {
                const i = data.instances[r];
                paintRow[r] = i < paintInst.length ? paintInst[i] : 0;
            }
            a.rows[s] = data;
            a.rowCells[s] = rowCell;
            a.paintRow[s] = paintRow;
            this.reads.set(splat, { sig, locked, data, cells: null });
        }
    }

    // ------------------------------------------------------------ probe

    // the numbers at a picked point (dir: the view ray it was picked along,
    // see probePoint)
    probeAt(point: V3, dir: V3 | null = null) {
        const a = this.analysis;
        if (!a) return null;
        if (!a.probe) a.probe = makeProbe(a.cells, a.detail, a.options);
        const at = this.probePoint(point, dir);
        const probe = a.probe(at);
        this.probeResult = { point, dir, moved: at !== point, probe };
        return probe;
    }

    // the current camera's view ray through a point (perspective: from the
    // camera; ortho: its forward axis)
    private viewDir(point: V3): V3 {
        const cam = this.scene.camera;
        const main = cam.mainCamera;
        if (cam.ortho) {
            const f = main.forward;
            return [f.x, f.y, f.z];
        }
        const e = main.getPosition();
        return [point[0] - e.x, point[1] - e.y, point[2] - e.z];
    }

    // where a probe at a picked point measures: the point itself when its
    // cell has some scan's surface (2+ opaque splats); otherwise the first
    // cell with surface along the view ray behind it, within PROBE_REACH
    // cells (the pick lies on the front of the splats, their centres are
    // behind it); otherwise the centre of the neighbouring cell with surface
    // nearest to the point (box distance; ties: the first in z, y, x order);
    // otherwise the point (no surface here)
    private probePoint(point: V3, dir: V3 | null): V3 {
        const a = this.analysis;
        const { keys, present } = a.detail;
        const c = a.cell;
        const surfaceAt = (x: number, y: number, z: number) => {
            const g = findKey(keys, keyOf(Math.floor(x / c), Math.floor(y / c), Math.floor(z / c)));
            return g >= 0 && present[g] !== 0;
        };
        if (!point.every(Number.isFinite) || surfaceAt(point[0], point[1], point[2])) return point;
        const len = dir ? Math.hypot(dir[0], dir[1], dir[2]) : 0;
        if (len > 0) {
            for (let k = 1; k <= PROBE_REACH * PROBE_STEPS; k++) {
                const t = k * c / PROBE_STEPS / len;
                const q: V3 = [point[0] + dir[0] * t, point[1] + dir[1] * t, point[2] + dir[2] * t];
                if (surfaceAt(q[0], q[1], q[2])) return q;
            }
        }
        const ix = Math.floor(point[0] / c), iy = Math.floor(point[1] / c), iz = Math.floor(point[2] / c);
        // distance from the point to cell index i's span on one axis
        const gap = (v: number, i: number) => Math.max(0, i * c - v, v - (i + 1) * c);
        let best: V3 | null = null;
        let bestDist = Infinity;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy && !dz) continue;
                    const g = findKey(keys, keyOf(ix + dx, iy + dy, iz + dz));
                    if (g < 0 || !present[g]) continue;
                    const d = gap(point[0], ix + dx) ** 2 + gap(point[1], iy + dy) ** 2 + gap(point[2], iz + dz) ** 2;
                    if (d < bestDist) {
                        bestDist = d;
                        best = [(ix + dx + 0.5) * c, (iy + dy + 0.5) * c, (iz + dz + 0.5) * c];
                    }
                }
            }
        }
        return best ?? point;
    }

    closeProbe() {
        this.probeResult = null;
        this.ctx.onChange();
    }

    // compose.probe(point, dir?): dir defaults to the current camera's view
    // ray through the point (a double-click uses the pick ray)
    private probeView(point: number[], dir?: number[]) {
        const a = this.analysis;
        if (!a || !Array.isArray(point) || point.length < 3) return null;
        const at: V3 = [point[0], point[1], point[2]];
        const d: V3 = Array.isArray(dir) && dir.length >= 3 ? [dir[0], dir[1], dir[2]] : this.viewDir(at);
        const probe = this.probeAt(at, d);
        this.ctx.onChange();
        const name = (s: number) => (s >= 0 ? a.scans[s].name : null);
        return {
            ...probe,
            // the probe moved off the picked point's cell (see probePoint)
            moved: this.probeResult.moved,
            dir: d,
            ownerName: name(probe.owner),
            // what the cards hide in the probed cell (see hidesIn)
            hiddenBy: probe.cell >= 0 ? this.hidesIn([probe.cell]).map(h => ({ number: h.card + 1, scan: name(h.scan), n: h.n })) : [],
            scans: probe.scans.map(s => ({ ...s, name: name(s.scan) })),
            pairs: probe.pairs.map(p => ({ ...p, winnerName: name(p.winner), loserName: name(p.loser) }))
        };
    }

    // ------------------------------------------------------------ display

    private scheduleDisplay() {
        if (this.displayFrame) return;
        this.displayFrame = nextFrame(() => {
            this.displayFrame = null;
            this.writeDisplays();
        });
    }

    private displayOf(splat: Splat) {
        let d = this.displays.get(splat);
        if (!d) {
            d = {
                count: 0,
                bytes: null,
                buffer: null,
                active: false,
                params: { buffer: null, mode: 3, threshold: 0, palette: this.palette, hideLocked: true }
            };
            this.displays.set(splat, d);
        }
        return d;
    }

    // what each scan shows, composed in this order: map classes from the cell
    // owner, the card preview, marking, hover. One O(count) pass per scan.
    private writeDisplays() {
        const a = this.analysis;
        this.beforeLocks = null;
        const off = () => {
            this.displays.forEach((d) => {
                d.active = false;
            });
            this.scene.forceRender = true;
        };
        if (!a || !this.ctx.active() || !this.inSteps()) {
            off();
            return;
        }
        // the flag itself is sync()'s, which rebuilds the panel when it flips
        const stale = this.isStale();
        const suggestStep = this.ctx.step() === 'suggest';
        // a 'before' preview does not outlive the hiding of the card's hide
        // set (see beforeBlocked); updateStatuses drops it too
        const shown = suggestStep && this.preview ? this.card(this.preview.id) : null;
        const preview = shown && !shown.rejected && !(this.preview.mode === 'before' && this.beforeBlocked(shown)) ? shown : null;
        // the same for a blurry area's preview ('before' is the scene as it
        // is: nothing to draw but true colours)
        const ar = a.areas;
        const areaShown = suggestStep && this.areaPreview ? this.areaCard(this.areaPreview.id) : null;
        const areaPreview = areaShown && !areaShown.kept && !(this.areaPreview.mode === 'before' && this.areaBeforeBlocked(areaShown)) ? areaShown : null;
        const previewing = !!preview || !!areaPreview;
        // a preview shows the scene in its true colours, as the result will
        // look: no map, no marks, and no red of the hovered card (the pointer
        // rests on the card whose Vorher/Nachher it just clicked; its red
        // drew over the whole 'before' region). The hovered card keeps its
        // dashed box (compose-tool), the selection steps back too
        // (selectionHidden)
        const mapOn = this.map && !stale && !previewing;
        const marked = suggestStep && !previewing && this.display === 'mark' ? a.cards.filter(c => c.ticked && this.tickable(c)) : [];
        const hovered = suggestStep && !previewing && this.hover?.kind === 'card' ? this.card(this.hover.id) : null;
        // blurry areas: the hovered one and the one just clicked in red;
        // "Bereiche einfärben" all open ones, red where another scan is sharp
        // or the area floats free (the ones worth deleting), grey where the
        // others are blurry too or only this scan has something (the large
        // rims of every scan: in red they covered most of the view)
        const areaRed = new Set<number>();
        const areaGrey = new Set<number>();
        if (suggestStep && !previewing && ar) {
            if (this.areaMark) {
                ar.cards.forEach((c) => {
                    if (!this.areaOpen(c)) return;
                    if (AREA_GROUP(c.area) <= 1) areaRed.add(c.id);
                    else areaGrey.add(c.id);
                });
            }
            if (this.hover?.kind === 'area') areaRed.add(this.hover.id);
            if (this.areaFlash) areaRed.add(this.areaFlash.id);
        }
        if (!mapOn && !previewing && !marked.length && !hovered && !areaRed.size && !areaGrey.size) {
            off();
            return;
        }
        const { detail } = a;
        const S = a.scans.length;
        const G = detail.keys.length;
        const scans = this.ctx.included();
        const colour = a.scans.map((s, i) => {
            const k = scans.indexOf(s);
            return (k >= 0 ? k : i) % 4;
        });

        // map: one code per global cell; cells without a reliable comparison
        // stay uncoloured (single, thin, partial, sparse, texture, and apart
        // and uncovered - not compared)
        let cellCode: Uint8Array = null;
        if (mapOn) {
            cellCode = new Uint8Array(G);
            for (let h = 0; h < detail.shared.length; h++) {
                const st = detail.state[h];
                const owner = detail.owner[h];
                const g = detail.shared[h];
                if (st === CellState.strong && owner >= 0) cellCode[g] = CLS_SCAN | (colour[owner] << 3);
                else if (st === CellState.weak && owner >= 0) cellCode[g] = CLS_SCAN | (colour[owner] << 3) | PALE;
                else if (st === CellState.tie) cellCode[g] = CLS_GREY;
            }
        }
        // preview 'before': the winner's splats in the region cells are left
        // out (1), so the coarser version shows alone - except in cells where
        // some of the losers' splats there (as the analysis read them) are
        // hidden now, by hand, another tool or an accept (2). The coarser
        // version is no longer whole there, and leaving the winner out would
        // draw a hole that neither the scene nor 'after' has; the winner,
        // which both draw there, stays, so such a cell shows its current
        // state. Cells, not splats: the region and the map are made of them,
        // and no winner splat belongs to a particular loser splat. A hide set
        // hidden almost wholly has no 'before' at all (beforeBlocked). The
        // lock bits change with every hide and show, so the losers' counts
        // go with it (beforeLocks): a change composes it again
        let regionCells: Uint8Array = null;
        if (preview && this.preview.mode === 'before') {
            const r = preview.region;
            regionCells = new Uint8Array(G);
            r.cells.forEach((g) => {
                regionCells[g] = 1;
            });
            const losers = r.losers.map(L => a.scans[L]);
            this.beforeLocks = { losers, locked: Float64Array.from(losers, s => s.instances.numLocked) };
            r.losers.forEach((L) => {
                if (!this.fits(L)) return;
                const cells = a.cellInst[L];
                const flags = a.scans[L].instances.flags;
                for (let i = 0; i < cells.length; i++) {
                    const g = cells[i];
                    if (g >= 0 && regionCells[g] === 1 && (flags[i] & State.locked)) regionCells[g] = 2;
                }
            });
        }
        const ids1 = this.maxId() + 2;

        for (let s = 0; s < S; s++) {
            const splat = a.scans[s];
            const d = this.displayOf(splat);
            const count = splat.instances.count;
            if (!this.fits(s)) {
                d.active = false;
                continue;
            }
            const size = Math.max(4, Math.ceil(count / 4) * 4);
            if (!d.bytes || d.bytes.length !== size) d.bytes = new Uint8Array(size);
            const bytes = d.bytes;
            const cells = a.cellInst[s];
            const paint = a.paintInst[s];
            if (cellCode) {
                for (let i = 0; i < count; i++) {
                    const g = cells[i];
                    bytes[i] = g >= 0 ? cellCode[g] : 0;
                }
                bytes.fill(0, count);
            } else {
                bytes.fill(0);
            }
            if (preview) {
                const r = preview.region;
                if (regionCells && s === r.winner) {
                    for (let i = 0; i < count; i++) {
                        const g = cells[i];
                        if (g >= 0 && regionCells[g] === 1) bytes[i] = CLS_HIDDEN;
                    }
                } else if (this.preview.mode === 'after' && r.losers.includes(s)) {
                    const v = r.id + 1;
                    for (let i = 0; i < count; i++) if (paint[i] === v) bytes[i] = CLS_HIDDEN;
                }
            }
            if (marked.length) {
                // red: will be hidden; green: the winner's splats that take over
                const want = new Uint8Array(ids1);
                let wins: Uint8Array = null;
                marked.forEach((card) => {
                    const r = card.region;
                    if (r.losers.includes(s)) want[card.id + 1] = 1;
                    if (r.winner === s) {
                        wins ??= new Uint8Array(G);
                        r.cells.forEach((g) => {
                            wins[g] = 1;
                        });
                    }
                });
                for (let i = 0; i < count; i++) {
                    if (bytes[i] === CLS_HIDDEN) continue;
                    const v = paint[i];
                    if (v < ids1 && want[v]) {
                        bytes[i] = CLS_RED;
                    } else if (wins) {
                        const g = cells[i];
                        if (g >= 0 && wins[g]) bytes[i] = CLS_GREEN;
                    }
                }
            }
            if (hovered && hovered.region.losers.includes(s)) {
                const v = hovered.id + 1;
                for (let i = 0; i < count; i++) if (paint[i] === v && bytes[i] !== CLS_HIDDEN) bytes[i] = CLS_RED;
            }
            if (ar && (areaPreview || areaRed.size || areaGrey.size)) {
                const inst = ar.areaInst[s];
                if (areaPreview && areaPreview.scan === s && this.areaPreview.mode === 'after') {
                    const v = areaPreview.id + 1;
                    for (let i = 0; i < count; i++) if (inst[i] === v) bytes[i] = CLS_HIDDEN;
                }
                // class per area id + 1 (0: none); red over grey
                const cls = new Uint8Array(ar.total[s].length + 1);
                let any = false;
                ar.cards.forEach((c) => {
                    if (c.scan !== s || c.kept) return;
                    const k = areaRed.has(c.id) ? CLS_RED : areaGrey.has(c.id) ? CLS_GREY : 0;
                    if (!k) return;
                    cls[c.id + 1] = k;
                    any = true;
                });
                if (any) {
                    for (let i = 0; i < count; i++) {
                        const k = cls[inst[i]];
                        if (k && bytes[i] !== CLS_HIDDEN) bytes[i] = k;
                    }
                }
            }
            // written in place like quality-tool upload(); recreated only on a
            // size change
            if (!d.buffer || d.buffer.byteSize !== size) {
                d.buffer?.destroy();
                d.buffer = new StorageBuffer(this.scene.graphicsDevice, size, BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC);
            }
            d.buffer.write(0, bytes, 0, size);
            d.count = count;
            d.active = true;
        }
        this.scene.forceRender = true;
    }

    // what the renderer binds for a layer (asked per layer and pass, so no
    // allocation here): class bytes and/or the hide switch, or null
    private renderParams(splat: Splat): ComposeRenderParams | null {
        if (!this.ctx.active() || !this.includedSet.has(splat)) return null;
        // steps 1-2: the sharpness view alone (locked splats as usual)
        if (!this.inSteps()) return this.ctx.sharpness?.(splat, false) ?? null;
        // the 'before' cells are out of date with its losers' lock bits: this
        // frame draws the new bits, so compose before it binds anything (the
        // buffers are written in place ahead of the frame's dispatches)
        this.redrawOnLocks();
        // the sharpness view over map, marks and hover; a Vorher/Nachher
        // preview leaves splats out and shows true colours, so it wins
        // so does a hovered or just clicked blurry area of this scan (its red)
        const previewing = (!!this.preview || !!this.areaPreview) && this.ctx.step() === 'suggest' && !!this.analysis;
        const sharp = previewing || this.areaLit(splat) ? null : this.ctx.sharpness?.(splat, this.hideLocked) ?? null;
        if (sharp) return sharp;
        const d = this.displays.get(splat);
        if (d && d.active && d.buffer && d.count === splat.instances.count) {
            d.params.buffer = d.buffer;
            d.params.mode = 3;
            d.params.hideLocked = this.hideLocked;
            return d.params;
        }
        if (!this.hideLocked) return null;
        this.plain.hideLocked = true;
        return this.plain;
    }

    // ------------------------------------------------------------ lifecycle

    activate() {
        this.refreshScans();
        this.scheduleDisplay();
    }

    // the reads and per-row tables are dropped while the tool is closed (the
    // cards, per-instance arrays and cell tables stay); option changes then
    // read again
    private dropRows() {
        this.reads.clear();
        this.autoCache = null;
        this.blurCache = null;
        const a = this.analysis;
        if (a) {
            a.rows.fill(null);
            a.rowCells.fill(null);
            a.paintRow.fill(null);
            a.cells.forEach((c) => {
                c.rowCell = null;
            });
        }
    }

    deactivate() {
        if (this.rerunTimer) {
            clearTimeout(this.rerunTimer);
            this.rerunTimer = null;
        }
        this.rerunPending = false;
        // a run still going (analysis or "Trotzdem übernehmen") needs them
        // and shares the cell tables: it drops them when it ends
        if (!this.busy) this.dropRows();
        this.displays.forEach(d => d.buffer?.destroy());
        this.displays.clear();
        this.preview = null;
        this.areaPreview = null;
        this.endFlash();
        this.beforeLocks = null;
        this.hover = null;
        this.scene.forceRender = true;
    }

    // a layer left the scene
    drop(splat: Splat) {
        this.reads.delete(splat);
        this.versions.delete(splat);
        this.records.delete(splat);
        this.includedSet.delete(splat);
        const d = this.displays.get(splat);
        d?.buffer?.destroy();
        this.displays.delete(splat);
        if (this.autoCache) this.autoCache = null;
        this.blurCache = null;
        this.kept = this.kept.filter(m => m.scan !== splat);
        if (this.analysis?.scans.includes(splat)) {
            this.analysis.scans.forEach((s) => {
                const e = this.displays.get(s);
                e?.buffer?.destroy();
                this.displays.delete(s);
            });
            this.analysis = null;
            this.queued.clear();
            this.areaQueued.clear();
            this.preview = null;
            this.areaPreview = null;
            this.pickedArea = null;
            this.endFlash();
            this.picked = null;
            this.beforeLocks = null;
            this.hover = null;
            this.probeResult = null;
            this.stale = false;
        }
        this.memory = this.memory.filter(m => m.winner !== splat && !m.losers.includes(splat));
    }

    // ------------------------------------------------------------ api

    view() {
        const a = this.analysis;
        if (!a) return null;
        this.flushSync();
        const name = (s: number) => (s >= 0 ? a.scans[s].name : null);
        return {
            cell: a.cell,
            grid: a.grid,
            lead: a.leadFactor,
            auto: { cell: a.auto.cell, perScan: a.auto.perScan, counts: a.auto.counts, forcedBy: name(a.auto.forcedBy) },
            upAxis: a.detail.upAxis,
            upSign: a.detail.upSign,
            seconds: a.seconds,
            times: a.times,
            stale: this.isStale(),
            scans: a.detail.scans.map((info, s) => ({ name: name(s), ...info })),
            pairs: a.detail.pairs.map(p => ({ ...p, aName: name(p.a), bName: name(p.b) })),
            apartShare: a.apartShare,
            sharedCells: a.sharedCells,
            suggestions: this.suggestionsView(),
            rejected: a.detail.rejected.map((r, index) => ({
                index,
                reason: r.reason,
                gate: r.gate ?? null,
                winner: name(r.winner),
                loser: name(r.loser),
                cells: r.cells.length,
                min: r.min,
                max: r.max,
                centre: r.centre,
                value: r.value,
                // rows of its cells a card hides all the same (ring, haze)
                hiddenBy: this.hidesIn(r.cells).map(h => ({ number: h.card + 1, scan: name(h.scan), n: h.n }))
            })),
            map: this.map,
            hideLocked: this.hideLocked,
            display: this.display,
            preview: this.preview,
            options: { grid: this.grid, lead: this.lead },
            // the blurry areas (step 4's first section)
            areas: this.areasView(),
            areaCell: a.areas?.cell ?? null,
            areaSeconds: a.areas?.seconds ?? null,
            areaPreview: this.areaPreview,
            areaMark: this.areaMark
        };
    }

    suggestionsView() {
        const a = this.analysis;
        if (!a) return [];
        return a.cards.map((c) => {
            const r = c.region;
            return {
                id: c.id,
                number: c.id + 1,
                winner: a.scans[r.winner].name,
                losers: r.losers.map(l => a.scans[l].name),
                scope: r.scope,
                shape: r.shape,
                confidence: r.confidence ?? 'check',
                forced: !!r.forced,
                // the reason of the cluster "Trotzdem übernehmen" made it
                // from, and that cluster's value (see Card)
                forcedReason: c.forcedReason,
                forcedValue: c.forcedValue,
                status: c.status,
                // hidden by hand already (see Card)
                handHidden: c.handHidden,
                hidden: r.perLoser.reduce((sum, p) => sum + (p.hidden ?? 0), 0),
                kept: r.perLoser.reduce((sum, p) => sum + (p.kept ?? 0), 0),
                // covered, but where the winner is hardly finer on its own
                // (compose-detail holdOwn): they stay like the kept ones
                held: r.perLoser.reduce((sum, p) => sum + (p.held ?? 0), 0),
                // of hidden: the blur haze (compose-detail DETAIL haze), of
                // that the rows from the haze zone around the region
                haze: r.perLoser.reduce((sum, p) => sum + (p.haze ?? 0), 0),
                hazeRing: r.perLoser.reduce((sum, p) => sum + (p.hazeRing ?? 0), 0),
                // hidden by compose, hide-set size, hidden otherwise
                locked: c.locked,
                total: c.total,
                others: c.others,
                ticked: c.ticked,
                rejected: c.rejected,
                cells: r.cells.length,
                lead: r.lead,
                dims: r.dims,
                marker: r.marker,
                min: r.min,
                max: r.max
            };
        });
    }
}

export { ComposeSuggest, SharpnessView, blurBytes, medianFootprint, BLUR_STEPS, type Card, type AreaCard, type Analysis, type GridMode, type PreviewMode, type DisplayMode, type CardStatus, type Hover, type ProbeView, type SuggestContext, type AnalyseSummary };
