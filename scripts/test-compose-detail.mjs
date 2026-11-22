/**
 * Scan composition, phase 2 (src/compose/compose-detail.ts): which scan is
 * finer where and what replacing the coarser version hides - on synthetic
 * pieces of a real scan with known truth, and on real pairs.
 *
 *   node scripts/test-compose-detail.mjs <scan.ply> [--pieces 2|3|4] [--cases N=6]
 *        [--seed S] [--points N=2000000] [--coarse blur|thin|none] [--focus]
 *        [--onesided] [--holes] [--budget 0.36] [--fog N] [--floaters N]
 *        [--exposure g] [--offset d] [--scale f] [--twin] [--drift min,max]
 *        [--layers 3|4] [--layer-shift d] [--aligned truth|compose] [--json out.json] [--paint dir]
 *        [--set name=value,...] [--determinism] [--verbose]
 *        [--leads] [--apart-diag] [--flat-diag] (diagnostics)
 *   node scripts/test-compose-detail.mjs --lod <dir with point_cloud.ply, _1, _3> [--set ...]
 *   node scripts/test-compose-detail.mjs --pair <a.ply> <b.ply> [--matrix m.json | 16 numbers]
 *        [--up x|y|z] [--json out.json] [--set ...] [--force-check] [--swap-check] [--apart-diag]
 *        [--changed-truth] [--haze-diag [--haze-box x0,y0,z0,x1,y1,z1]]
 *   node scripts/test-compose-detail.mjs --unit (constructed cells: histogram
 *        saturation, partial gates, contract; the blurry-area detector)
 *   node scripts/test-compose-detail.mjs --blur <a.ply> [<b.ply> ...] [--matrix m.json | 16 numbers]
 *        [--up x|y|z] [--set name=value,...] [--changed-truth] [--twin] [--sphere]
 *        [--swap-check] [--box x0,y0,z0,x1,y1,z1] [--json out.json]
 *        large blurry areas per scan (src/compose/compose-blur.ts): the area
 *        list, timings and invariants; --changed-truth (a, b row-identical
 *        except b's changed rows, dist/bus.ply + dist/bus-blur.ply): b's
 *        changed rows must form one 'other scan sharp' area; --twin: the
 *        first scan and its copy must give areas only where the scan itself
 *        is blurry; --sphere (one file): a gross blur ball (1/8 of the rows
 *        in it, 8x larger, like the Nuremberg bridge) put into a copy, with
 *        truth, run alone (information) and as a pair; --box: per area the rows and the
 *        visual weight (opacity x footprint^2) in a world box
 *   every mode: [--core file.ts] takes compose-detail from another file
 *
 * --twin counts the suggestions between the twins (pieces 1 and 2: a region
 * with one twin as the winner and the other among its losers) and reports
 * the check for every case. Every run checks the invariants: regions
 * disjoint, no region cell in a rejected cluster, no region cell partial,
 * sparse or texture (forced regions excepted); and the paint: every hidden
 * row is a loser row of its region, in the region's cells or ring.
 * --swap-check (pairs) runs the pair again with the scans in the other order
 * and requires the same analysis with the scans swapped.
 * --changed-truth (pairs): b is a row-for-row copy of a with some rows
 * changed (dist/bus-blur.ply: a blurred sphere in dist/bus.ply, design test
 * C); accepting every suggestion must hide >= 90 % of the changed rows and
 * <= 0.1 % of the others. Every run checks the free views too: each camera
 * inside the scanned volume (the robust box of the present cells), on an
 * empty cell, and nothing but the region and its ring between it and the
 * target; pairs also check that no strong cell is left without a suggestion
 * or a listed cluster and that a sparse cluster's value is below the weak
 * density gate.
 * --haze-diag (synthetic): the hidden haze rows by truth (right / neutral /
 * wrong), the winner's state at the row's source, where they came from
 * (cell, ring, haze zone) and whether they are giant (footprint >= c), per
 * case and summed up.
 * --haze-diag (pairs): the blur haze (compose-detail DETAIL haze) - the pair
 * runs again with haze 0; per card hidden / kept / kept as 'uncovered' with
 * and without it, the haze rows and the kept candidates by origin (cell,
 * ring, haze zone) with their footprint, opacity and distance to the
 * winner's nearest opaque splat; per loser scan the rows and visual weight
 * (opacity x footprint^2) that stay visible, by where they are (hide cell,
 * other region cell, ring, haze zone, winner absent, elsewhere); with
 * --haze-box the loser rows in that box (world units) that stay visible
 * --layers K: K overlapping scans of the whole source (70 % each, drift),
 * no coarse stretch; two 1 m balls fine in layer 1 and coarse in all others
 * (one suggestion each with several losers); the second ball sits on a
 * plane across up, and there the last layer lies 6 cm off it (towards its
 * emptier side; --layer-shift d) within 45 cm of the centre: an apart
 * cluster inside a kept region with several losers. With --twin, layer 2 is
 * the twin of layer 1.
 *
 * Synthetic cases: the scan is cut into 2-4 overlapping pieces along its
 * longest horizontal axis (as test-composition.mjs does). Every piece keeps
 * its own random 70 % of the splats plus 3 mm noise and a creeping drift
 * (0.05-0.2 degrees). One stretch per piece is coarse: 'blur' keeps 1/6 of
 * the splats, sigma x sqrt 6, the mean colour of the 5 cm voxel and a scatter
 * of 0.3 sigma (at most 2 cm); 'thin' only thins; 'none' has no stretch.
 * --focus puts a 1 m ball into every overlap where one piece keeps 100 % and
 * the other is blur-coarse (--onesided: every second ball misses its -main
 * half in the focusing piece, --holes: 4 holes of 5-15 cm per ball). Then the
 * pipeline runs as the app does (autoCell -> scanCells -> composeDetail ->
 * paintInputs -> composePaint -> applyPaint) and every suggestion is
 * accepted. Truth per hidden row: right (coarse row, winner normal or fine
 * there), neutral (both normal), wrong (the winner is coarse there or lacks
 * the point). Coverage: a truth surface point is covered when a visible
 * opaque row lies within max(1.5 cm, its sigma). Units: metres.
 *
 * Exit code 1 on any missed criterion.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// one cache per process: parallel runs must not overwrite each other's files
const cache = join(root, 'node_modules', '.cache', 'compose-detail-test', String(process.pid));

// transpile the cores (relative imports get the .mjs extension); --core
// <file.ts> takes compose-detail from another file (a snapshot to compare)
const coreArg = process.argv.indexOf('--core');
const coreFile = coreArg >= 0 ? process.argv[coreArg + 1] : null;
const sources = ['compose/compose-detail', 'compose/compose-core', 'compose/compose-blur', 'align/global-align', 'align/icp', 'align/point-align'];
for (const name of sources) {
    const code = readFileSync(name === 'compose/compose-detail' && coreFile ? coreFile : join(root, 'src', `${name}.ts`), 'utf8');
    let js = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }
    }).outputText;
    js = js.replace(/from '(\.\.?\/[^']+)'/g, 'from \'$1.mjs\'');
    const file = join(cache, `${name}.mjs`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, js);
}
const D = await import(pathToFileURL(join(cache, 'compose', 'compose-detail.mjs')).href);
const core = await import(pathToFileURL(join(cache, 'compose', 'compose-core.mjs')).href);
const icp = await import(pathToFileURL(join(cache, 'align', 'icp.mjs')).href);
const BL = await import(pathToFileURL(join(cache, 'compose', 'compose-blur.mjs')).href);
const { keyOf } = core;

// ---------------------------------------------------------------- options

const args = process.argv.slice(2);
const has = name => args.includes(`--${name}`);
const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const valued = new Set(['coverage-sigma', 'pieces', 'cases', 'seed', 'points', 'coarse', 'budget', 'fog', 'floaters', 'exposure', 'offset', 'scale', 'aligned', 'json', 'paint', 'set', 'drift', 'lod', 'matrix', 'up', 'core', 'leads-variants', 'layers', 'layer-shift', 'layer-case', 'shift-radius', 'grow-diag', 'haze-box', 'box']);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && valued.has(args[i - 1].slice(2))));

const constants = {};
(option('set', '') || '').split(',').filter(Boolean).forEach((kv) => {
    const [k, v] = kv.split('=');
    constants[k] = Number(v);
});
const verbose = has('verbose');
const jsonOut = option('json', null);
// coverage radius of a row: max(1.5 cm, k sigma); the design says k = 1,
// which even an oracle cannot meet (see FORK-NOTES), 2 is the rendered extent
const COVER_SIGMA = parseFloat(option('coverage-sigma', '2'));

// ---------------------------------------------------------------- helpers

const rng = (seed) => {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6D2B79F5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
};
const gauss = (u1, u2) => Math.sqrt(-2 * Math.log(Math.max(1e-12, u1))) * Math.cos(2 * Math.PI * u2);
const quantile = (v, q) => {
    if (!v.length) return NaN;
    const s = Float64Array.from(v).sort();
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const pct = v => (Number.isFinite(v) ? `${(v * 100).toFixed(2)} %` : '-');
const len = v => (Number.isFinite(v) ? (Math.abs(v) < 0.1 ? `${(v * 1000).toFixed(1)} mm` : `${(v * 100).toFixed(1)} cm`) : '-');
const now = () => performance.now();
const sigmoid = x => 1 / (1 + Math.exp(-x));
const SH0 = 0.28209479177387814;

// ---------------------------------------------------------------- ply

const readPly = (file) => {
    const buf = readFileSync(file);
    const marker = buf.indexOf('end_header');
    const headerEnd = buf.indexOf(0x0a, marker) + 1;
    const header = buf.subarray(0, headerEnd).toString('latin1');
    const count = parseInt(/element vertex (\d+)/.exec(header)[1], 10);
    const props = [...header.matchAll(/property (\w+) (\w+)/g)].map(m => ({ type: m[1], name: m[2] }));
    if (props.some(p => p.type !== 'float')) throw new Error(`${file}: only float properties are supported`);
    const P = props.length;
    const bytes = new Uint8Array(count * P * 4);
    bytes.set(buf.subarray(headerEnd, headerEnd + count * P * 4));
    const data = new Float32Array(bytes.buffer);
    const at = Object.fromEntries(props.map((p, i) => [p.name, i]));
    return { file, count, P, data, at };
};

// splats of a ply (every stride-th): world centre, linear scales, alpha,
// base colour, rotation
const splatsOf = (ply, stride = 1) => {
    const { data, P, at } = ply;
    const n = Math.ceil(ply.count / stride);
    const pos = new Float32Array(n * 3), scale = new Float32Array(n * 3), alpha = new Float32Array(n), rgb = new Float32Array(n * 3), rot = new Float32Array(n * 4);
    const hasRot = at.rot_0 !== undefined;
    for (let j = 0, i = 0; i < ply.count; i += stride, j++) {
        const o = i * P;
        pos[j * 3] = data[o + at.x];
        pos[j * 3 + 1] = data[o + at.y];
        pos[j * 3 + 2] = data[o + at.z];
        for (let k = 0; k < 3; k++) {
            scale[j * 3 + k] = Math.exp(data[o + at[`scale_${k}`]]);
            rgb[j * 3 + k] = 0.5 + SH0 * data[o + at[`f_dc_${k}`]];
        }
        alpha[j] = sigmoid(data[o + at.opacity]);
        if (hasRot) for (let k = 0; k < 4; k++) rot[j * 4 + k] = data[o + at[`rot_${k}`]];
        else rot[j * 4] = 1;
    }
    return { n, pos, scale, alpha, rgb, rot };
};

// compact rows exactly as the app's reader builds them (footprint, opacity
// byte, luminance code from the core's helpers)
const compactOf = (pos, sigma, alpha, rgb) => {
    const n = alpha.length;
    const footprint = new Float32Array(n), opacity = new Uint8Array(n), lum = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        footprint[i] = sigma[i];
        opacity[i] = D.opacityByte(alpha[i]);
        lum[i] = D.lumCode(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    }
    return { positions: pos, footprint, opacity, lum };
};

const writePly = (file, rows) => {
    const n = rows.alpha.length;
    const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${names.map(p => `property float ${p}`).join('\n')}\nend_header\n`;
    const body = new Float32Array(n * names.length);
    for (let i = 0; i < n; i++) {
        const o = i * names.length;
        body[o] = rows.pos[i * 3];
        body[o + 1] = rows.pos[i * 3 + 1];
        body[o + 2] = rows.pos[i * 3 + 2];
        for (let k = 0; k < 3; k++) body[o + 3 + k] = (rows.rgb[i * 3 + k] - 0.5) / SH0;
        const a = Math.min(1 - 1e-6, Math.max(1e-6, rows.alpha[i]));
        body[o + 6] = Math.log(a / (1 - a));
        for (let k = 0; k < 3; k++) body[o + 7 + k] = Math.log(Math.max(1e-8, rows.scale[i * 3 + k]));
        for (let k = 0; k < 4; k++) body[o + 10 + k] = rows.rot[i * 4 + k];
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(body.buffer)]));
};

// ---------------------------------------------------------------- grid

// sorted-key CSR grid over points (radius queries up to the cell size)
class Grid {
    constructor(xyz, ids, size) {
        this.size = size;
        const n = ids.length;
        const key = new Float64Array(n);
        for (let j = 0; j < n; j++) {
            const i = ids[j];
            key[j] = keyOf(Math.floor(xyz[i * 3] / size), Math.floor(xyz[i * 3 + 1] / size), Math.floor(xyz[i * 3 + 2] / size));
        }
        const sorted = key.slice().sort();
        let K = 0;
        for (let j = 0; j < n; j++) if (K === 0 || sorted[j] !== sorted[K - 1]) sorted[K++] = sorted[j];
        this.keys = sorted.slice(0, K);
        const start = new Uint32Array(K + 1);
        const cellOf = new Int32Array(n);
        for (let j = 0; j < n; j++) {
            cellOf[j] = this.find(key[j]);
            start[cellOf[j] + 1]++;
        }
        for (let q = 0; q < K; q++) start[q + 1] += start[q];
        const fill = start.slice(0, K);
        this.ids = new Uint32Array(n);
        for (let j = 0; j < n; j++) this.ids[fill[cellOf[j]]++] = ids[j];
        this.start = start;
        this.xyz = xyz;
    }

    find(key) {
        let lo = 0, hi = this.keys.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.keys[mid] < key) lo = mid + 1;
            else hi = mid;
        }
        return lo < this.keys.length && this.keys[lo] === key ? lo : -1;
    }

    // calls fn(id, d2) for points within r; fn returns true to stop
    near(x, y, z, r, fn) {
        const s = this.size;
        const ix = Math.floor(x / s), iy = Math.floor(y / s), iz = Math.floor(z / s);
        const r2 = r * r;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const q = this.find(keyOf(ix + dx, iy + dy, iz + dz));
                    if (q < 0) continue;
                    for (let p = this.start[q]; p < this.start[q + 1]; p++) {
                        const i = this.ids[p];
                        const ex = this.xyz[i * 3] - x, ey = this.xyz[i * 3 + 1] - y, ez = this.xyz[i * 3 + 2] - z;
                        const d2 = ex * ex + ey * ey + ez * ez;
                        if (d2 <= r2 && fn(i, d2)) return true;
                    }
                }
            }
        }
        return false;
    }
}

// ---------------------------------------------------------------- pipeline

const PIPE = { ...constants };

const runPipeline = (rowsList, upAxis, sceneSize) => {
    const t0 = now();
    const samples = rowsList.map(r => D.cellSample(r, PIPE));
    const diag = sceneSize ?? D.sceneDiagonal(rowsList.map(r => r.positions));
    const auto = D.autoCell(samples, diag, PIPE);
    const cell = constants.cell ?? auto.cell;
    const t1 = now();
    const cells = rowsList.map(r => D.scanCells(r, cell, PIPE));
    const t2 = now();
    const detail = D.composeDetail(cells, { ...PIPE, upAxis, upSign: 1, sceneSize: diag });
    const t3 = now();
    const jobs = D.paintInputs(detail, rowsList, cells.map(c => c.rowCell), PIPE);
    const t4 = now();
    const results = jobs.map(j => D.composePaint(j.cell, j.batches, PIPE));
    const t5 = now();
    // the regions by their id before the paint (batch.id), with their cells
    // then (applyPaint renumbers and shrinks them)
    const byBatchId = new Map(detail.regions.map(r => [r.id, { region: r, cells: r.cells, losers: r.losers.slice() }]));
    const applied = D.applyPaint(detail, jobs, results, { ...PIPE, rowCounts: rowsList.map(r => r.footprint.length) });
    const t6 = now();
    const times = { auto: (t1 - t0) / 1000, cells: (t2 - t1) / 1000, detail: (t3 - t2) / 1000, inputs: (t4 - t3) / 1000, paint: (t5 - t4) / 1000, apply: (t6 - t5) / 1000 };
    times.total = times.cells + times.detail + times.inputs + times.paint + times.apply;
    return { auto, cell, cells, detail, jobs, results, applied, times, byBatchId };
};

// the paint batches of loser rows in cells that left a kept region (a
// listed apart cluster inside it), per loser: rows covered by the paint
// before the leave, and rows hidden after it (must be 0: the cell is
// listed as apart and no longer the region's)
const leftRows = (run) => {
    const out = run.detail.scanCount ? Array.from({ length: run.detail.scanCount }, () => ({ cells: 0, rows: 0, coveredBefore: 0, hiddenAfter: 0 })) : [];
    run.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
        const pre = run.byBatchId.get(batch.id);
        if (!pre || !run.detail.regions.includes(pre.region)) return;
        const inCells = new Set(Array.from(pre.region.cells));
        const result = run.results[ji].batches[bi];
        const paint = run.applied.paint[batch.loser];
        const seen = new Set();
        for (let q = 0; q < batch.rows.length; q++) {
            if (batch.ring[q]) continue;
            const g = batch.candidateCell[q];
            if (inCells.has(g)) continue;
            const t = out[batch.loser];
            if (!seen.has(g)) {
                seen.add(g);
                t.cells++;
            }
            t.rows++;
            if (result.state[q] === D.PaintState.hidden) t.coveredBefore++;
            const v = paint[batch.rows[q]];
            if (v && !(v & 0x8000)) t.hiddenAfter++;
        }
    }));
    return out;
};

// canonical JSON of a result (without timings) for the determinism check
const canonical = (run) => {
    const plain = (v) => {
        if (ArrayBuffer.isView(v)) return Array.from(v, x => (Number.isNaN(x) ? 'NaN' : x));
        if (Array.isArray(v)) return v.map(plain);
        if (v && typeof v === 'object') {
            const o = {};
            Object.keys(v).sort().forEach((k) => {
                if (k !== 'seconds') o[k] = plain(v[k]);
            });
            return o;
        }
        return typeof v === 'number' && !Number.isFinite(v) ? String(v) : v;
    };
    const d = run.detail;
    return JSON.stringify(plain({
        cell: run.cell,
        keys: d.keys,
        present: d.present,
        owner: d.owner,
        state: d.state,
        size: d.size,
        cover: d.cover,
        pairs: d.pairs,
        scans: d.scans,
        regions: d.regions,
        rejected: d.rejected,
        paint: run.applied.paint
    }));
};
const hashOf = run => createHash('sha256').update(canonical(run)).digest('hex');

// hidden rows per scan: region id per row (-1 none)
const hiddenOf = (run, ticked = null) => {
    const ok = new Set(run.detail.regions.filter(r => !ticked || ticked(r)).map(r => r.id));
    return run.applied.paint.map((p) => {
        const out = new Int32Array(p.length).fill(-1);
        for (let i = 0; i < p.length; i++) {
            const v = p[i];
            if (v && !(v & 0x8000) && ok.has((v & 0x7fff) - 1)) out[i] = (v & 0x7fff) - 1;
        }
        return out;
    });
};

const describeRegions = (run, max = 10) => run.detail.regions.slice(0, max).map((r) => {
    const pl = r.perLoser.map(p => `${p.scan + 1}: ${len(p.sizeW)} vs ${len(p.sizeL)} (${(p.sizeL / p.sizeW).toFixed(2)}x), dens ${p.density.toFixed(2)}, tex ${p.texture.toFixed(2)}, cover ${p.cover.toFixed(2)}, big ${pct(p.big)}, rows ${p.rows}, hides ${p.hidden} keeps ${p.kept}${p.haze ? ` haze ${p.haze} (zone ${p.hazeRing ?? 0})` : ''} (${pct(p.covered)}), sep50 ${len(p.sep50)}, rn ${len(p.rn)}, rt ${len(p.rt)}, m ${p.mSelf}, apart ${p.apartCells} uncovered ${p.uncoveredCells} of ${r.hideCells[r.losers.indexOf(p.scan)].length} hide cells`).join('; ');
    return `   #${r.id} ${r.winner + 1} replaces ${r.losers.map(l => l + 1).join('+')} ${r.scope} ${r.shape} ${r.confidence} ${r.cells.length} cells (${r.strongCells} strong), ${r.dims.map(v => v.toFixed(1)).join(' x ')} m, lead ${(2 ** r.lead).toFixed(2)}x, benefit ${r.benefit.toFixed(2)} | ${pl}`;
});

// the 'clear' gates of every card (applyPaint's rule): strong share, region
// lead, per loser lead over the general difference, cells, sep50 / c and
// covered share; blocks = the gates that fail. truth (synthetic, LOD): per
// region id { hidden, neutral, wrong }
const cardsOf = (run, truth = null) => {
    const d = run.detail, c = run.cell;
    const k = { ...D.DETAIL, ...PIPE };
    return d.regions.map((r) => {
        const losers = r.perLoser.filter(pl => pl.hidden !== undefined).map((pl) => {
            const b = D.biasOf(d, r.winner, pl.scan);
            return { scan: pl.scan, lead: pl.lead, bias: b, overBias: pl.lead - Math.max(0, b), sep50c: pl.sep50 / c, covered: pl.covered, hidden: pl.hidden, kept: pl.kept, haze: pl.haze ?? 0, hazeRing: pl.hazeRing ?? 0, sizeW: pl.sizeW, sizeL: pl.sizeL, density: pl.density };
        });
        const q = {
            id: r.id,
            winner: r.winner,
            losers: r.losers,
            scope: r.scope,
            forced: !!r.forced,
            confidence: r.confidence,
            strongShare: r.strongCells / Math.max(1, r.cells.length),
            lead: r.lead,
            cells: r.cells.length,
            overBias: losers.length ? Math.min(...losers.map(l => l.overBias)) : NaN,
            sep50c: losers.length ? Math.max(...losers.map(l => l.sep50c)) : NaN,
            covered: losers.length ? Math.min(...losers.map(l => l.covered)) : NaN,
            perLoser: losers,
            blocks: []
        };
        if (q.forced) q.blocks.push('forced');
        if (q.scope === 'base') q.blocks.push('base');
        if (!(q.strongShare >= k.clearStrong)) q.blocks.push('strong');
        if (!(q.lead >= k.clearLead)) q.blocks.push('lead');
        if (!(q.cells >= k.clearCells)) q.blocks.push('cells');
        if (losers.some(l => !(l.overBias >= k.clearOverBias))) q.blocks.push('overBias');
        if (losers.some(l => !(l.sep50c <= k.clearSep))) q.blocks.push('sep50');
        if (losers.some(l => !(l.covered >= k.clearCovered))) q.blocks.push('covered');
        if (truth) q.truth = truth.get(r.id) ?? { hidden: 0, neutral: 0, wrong: 0 };
        return q;
    });
};
const cardLine = q => `#${q.id} ${q.winner + 1}->${q.losers.map(l => l + 1).join('+')} ${q.scope} ${q.confidence}: strong ${pct(q.strongShare)}, lead ${q.lead.toFixed(2)} oct, over bias ${q.overBias.toFixed(2)}, cells ${q.cells}, sep50 ${q.sep50c.toFixed(3)} c, covered ${pct(q.covered)}; blocks ${q.blocks.join(',') || '-'}${q.truth ? `; truth hidden ${q.truth.hidden} neutral ${pct(q.truth.neutral / Math.max(1, q.truth.hidden))} wrong ${pct(q.truth.wrong / Math.max(1, q.truth.hidden))}` : ''}`;

// --apart-diag (diagnostic): the hide cells of every paint batch by their
// candidates' plane distances - Infinity share, finite median, the median
// over all (the earlier rule) - and which rule makes them apart / uncovered
const apartDiag = (run, label) => {
    const c = run.cell;
    const lim = (run.detail && PIPE.apartSep !== undefined ? PIPE.apartSep : D.DETAIL.apartSep) * c;
    const minN = PIPE.apartMin ?? D.DETAIL.apartMin;
    const cls = {};
    const add = (key, v) => {
        const t = cls[key] ?? (cls[key] = { cells: 0, cand: 0, far: [], fin: [], all: [], sigma: [], ns: [] });
        t.cells++;
        t.cand += v.n;
        t.far.push(v.far / v.n);
        t.fin.push(v.fin);
        t.all.push(v.all);
        t.sigma.push(v.sigma);
        t.ns.push(v.n);
    };
    run.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
        const r = run.results[ji].batches[bi];
        const nC = batch.candidateSize.length;
        for (let j = 0; j < nC;) {
            if (batch.ring[j]) {
                j++;
                continue;
            }
            const g = batch.candidateCell[j];
            let e = j, far = 0;
            const fin = [], all = [], sig = [];
            while (e < nC && !batch.ring[e] && batch.candidateCell[e] === g) {
                const v = r.distance[e];
                if (v === Infinity) far++;
                if (!Number.isNaN(v)) all.push(v);
                if (Number.isFinite(v)) fin.push(v);
                sig.push(batch.candidateSize[e]);
                e++;
            }
            const n = e - j;
            const v = { n, far, fin: quantile(fin, 0.5), all: quantile(all, 0.5), sigma: quantile(sig, 0.5) };
            const oldApart = all.length >= minN && v.all > lim;
            const unc = n >= minN && far > 0.5 * n;
            const newApart = !unc && fin.length >= minN && v.fin > lim;
            add(`${oldApart ? 'old-apart' : 'old-close'} -> ${unc ? 'uncovered' : newApart ? 'apart' : 'close'}`, v);
            j = e;
        }
    }));
    const q = (a, x) => (a.length ? quantile(a, x) : NaN);
    console.log(`   apart-diag ${label} (c ${len(c)}, limit ${len(lim)}):`);
    Object.entries(cls).sort().forEach(([key, t]) => console.log(`      ${key}: ${t.cells} cells, ${t.cand} candidates; Infinity share p50 ${pct(q(t.far, 0.5))} p90 ${pct(q(t.far, 0.9))}; finite median p25/p50/p75 ${len(q(t.fin, 0.25))} / ${len(q(t.fin, 0.5))} / ${len(q(t.fin, 0.75))}; all median p50 ${len(q(t.all, 0.5))}; candidate sigma p50 ${len(q(t.sigma, 0.5))}; candidates per cell p50 ${q(t.ns, 0.5)}`));
};

// --haze-diag (pairs): what the blur haze hides and what stays (see the
// header); run is the pipeline with the constants, off the same with haze 0
const hazeDiag = (run, off, rowsList, box) => {
    const d = run.detail, c = run.cell;
    const names = ['no candidate', 'hidden', 'uncovered', 'apart', 'no surface', 'held', 'haze'];
    const statesOf = (r) => {
        const out = rowsList.map(q => new Uint8Array(q.footprint.length));
        const origin = rowsList.map(q => new Uint8Array(q.footprint.length));
        r.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
            const st = r.results[ji].batches[bi].state;
            for (let q = 0; q < batch.rows.length; q++) {
                out[batch.loser][batch.rows[q]] = st[q];
                // 1 cell, 2 ring, 3 haze zone
                origin[batch.loser][batch.rows[q]] = batch.hazeFrom !== undefined && q >= batch.hazeFrom ? 3 : batch.ring[q] ? 2 : 1;
            }
        }));
        return { st: out, origin };
    };
    const on = statesOf(run);
    const q3 = (v, fmt) => [0.25, 0.5, 0.75].map((q) => {
        const x = quantile(v, q);
        return Number.isFinite(x) ? fmt(x) : '-';
    }).join(' / ');
    // the opaque rows of every scan on a grid of 2 c
    const ob = D.opacityByte(0.2);
    const grids = rowsList.map((r) => {
        const ids = [];
        for (let i = 0; i < r.footprint.length; i++) if (r.opacity[i] >= ob) ids.push(i);
        return new Grid(r.positions, ids, 2 * c);
    });
    const nearest = (s, x, y, z) => {
        let best = Infinity;
        grids[s].near(x, y, z, 2 * c, (j, d2) => {
            if (d2 < best) best = d2;
            return false;
        });
        return Math.sqrt(best);
    };
    console.log(`haze-diag: cell ${len(c)}, ${d.regions.filter(r => r.haze).length} of ${d.regions.length} suggestions with a haze zone`);
    // per card, against the run without haze (the same regions: the haze
    // does not change the analysis)
    d.regions.slice(0, 12).forEach((r) => {
        const o = off.detail.regions.find(q => q.winner === r.winner && q.cells.length === r.cells.length && q.cells[0] === r.cells[0]);
        r.perLoser.forEach((pl, li) => {
            const L = pl.scan;
            const po = o?.perLoser[li];
            const uncovered = (x, id) => {
                let n = 0;
                x.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
                    if (batch.id !== id || batch.loser !== L) return;
                    const st = x.results[ji].batches[bi].state;
                    for (let q = 0; q < st.length; q++) if (st[q] === D.PaintState.uncovered) n++;
                }));
                return n;
            };
            console.log(`   card #${r.id} ${r.winner + 1} replaces ${L + 1} (${r.cells.length} cells${r.haze ? `, haze zone ${r.haze.length} cells` : ', no haze zone'}): hides ${po?.hidden ?? '-'} -> ${pl.hidden}, keeps ${po?.kept ?? '-'} -> ${pl.kept}, kept as uncovered ${o ? uncovered(off, o.id) : '-'} -> ${uncovered(run, r.id)}; haze ${pl.haze ?? 0} (zone ${pl.hazeRing ?? 0})`);
        });
    });
    // the haze rows and the candidates still kept, by origin
    const losers = [...new Set(d.regions.filter(r => r.haze).flatMap(r => r.losers))].sort((a, b) => a - b);
    losers.forEach((L) => {
        const r = rowsList[L];
        const W = d.regions.find(q => q.losers.includes(L))?.winner ?? 0;
        const groups = {};
        for (let i = 0; i < r.footprint.length; i++) {
            const st = on.st[L][i];
            if (st !== D.PaintState.haze && st !== D.PaintState.uncovered && st !== D.PaintState.noSurface) continue;
            const key = `${names[st]} (${['', 'cell', 'ring', 'haze zone'][on.origin[L][i]]})`;
            const e = groups[key] ?? (groups[key] = { n: 0, sigma: [], alpha: [], dist: [] });
            e.n++;
            if (e.n % 11 !== 1) continue;
            e.sigma.push(r.footprint[i]);
            e.alpha.push(r.opacity[i] / 255);
            e.dist.push(nearest(W, r.positions[i * 3], r.positions[i * 3 + 1], r.positions[i * 3 + 2]));
        }
        Object.entries(groups).sort((a, b) => b[1].n - a[1].n).forEach(([k2, e]) => {
            console.log(`   scan ${L + 1} ${k2}: ${e.n} rows; footprint p25/p50/p75 ${q3(e.sigma, len)}, opacity ${q3(e.alpha, x => x.toFixed(2))}, nearest opaque splat of scan ${W + 1} ${q3(e.dist.filter(Number.isFinite), len)} (none within 2 c: ${pct(e.dist.filter(x => !Number.isFinite(x)).length / Math.max(1, e.dist.length))})`);
        });
    });
    // per loser scan: what stays visible, by where it is
    const inBox = box ? (x, y, z) => x >= box[0] && y >= box[1] && z >= box[2] && x <= box[3] && y <= box[4] && z <= box[5] : null;
    losers.forEach((L) => {
        const r = rowsList[L];
        const rc = run.cells[L].rowCell, rm = d.remap[L];
        const ringOf = new Set(), hazeOf = new Set(), hideOf = new Set();
        d.regions.forEach((q) => {
            const li = q.losers.indexOf(L);
            if (li < 0) return;
            q.ring.forEach(g => ringOf.add(g));
            (q.haze ?? []).forEach(g => hazeOf.add(g));
            q.hideCells[li].forEach(g => hideOf.add(g));
        });
        const W = d.regions.find(q => q.losers.includes(L))?.winner ?? 0;
        const tally = {};
        let n = 0, w = 0, nOff = 0, wOff = 0, nOn = 0, wOn = 0, bigOff = 0, bigOn = 0, big = 0;
        const hid = (p, i) => !!p[i] && !(p[i] & 0x8000);
        for (let i = 0; i < r.footprint.length; i++) {
            const x = r.positions[i * 3], y = r.positions[i * 3 + 1], z = r.positions[i * 3 + 2];
            if (inBox && !inBox(x, y, z)) continue;
            const g = rc[i] >= 0 ? rm[rc[i]] : -1;
            const ww = r.opacity[i] / 255 * r.footprint[i] ** 2;
            const bigRow = r.footprint[i] >= c / 10;
            n++;
            w += ww;
            if (bigRow) big++;
            if (!hid(off.applied.paint[L], i)) {
                nOff++;
                wOff += ww;
                if (bigRow) bigOff++;
            }
            if (hid(run.applied.paint[L], i)) continue;
            nOn++;
            wOn += ww;
            if (bigRow) bigOn++;
            const where = g < 0 ? 'no cell' : hideOf.has(g) ? 'hide cell' : d.regionOf[g] >= 0 ? 'other region cell' : ringOf.has(g) ? 'ring' : hazeOf.has(g) ? 'haze zone' : !((d.present[g] >> W) & 1) ? `elsewhere, scan ${W + 1} absent` : 'elsewhere';
            const t = tally[where] ?? (tally[where] = { n: 0, w: 0 });
            t.n++;
            t.w += ww;
        }
        console.log(`   scan ${L + 1}${box ? ` in the box ${box.join(',')}` : ''}: ${n} rows; visible without haze ${nOff} (${pct(nOff / Math.max(1, n))}), with haze ${nOn} (${pct(nOn / Math.max(1, n))}); footprint >= c / 10 ${bigOff} -> ${bigOn} of ${big}; visual weight (opacity x footprint^2) visible ${pct(wOff / Math.max(1e-12, w))} -> ${pct(wOn / Math.max(1e-12, w))}`);
        Object.entries(tally).sort((a, b) => b[1].w - a[1].w).forEach(([k2, t]) => console.log(`      visible in ${k2}: ${t.n} rows, ${pct(t.w / Math.max(1e-12, w))} of the weight`));
    });
};

// invariants of a finished run (every mode): regions disjoint; no region
// cell in a rejected cluster; no region cell partial, sparse or texture
// (except in a forced region: 'Trotzdem übernehmen' makes a texture or
// sparse cluster a region on purpose, and its rejected entry goes)
const invariants = (detail) => {
    const G = detail.keys.length;
    const inRegion = new Int32Array(G).fill(-1);
    let overlap = 0, both = 0, blocked = 0;
    detail.regions.forEach((r) => {
        r.cells.forEach((g) => {
            if (inRegion[g] >= 0) overlap++;
            inRegion[g] = r.id;
            const h = detail.sharedIndex[g];
            const st = h >= 0 ? detail.state[h] : -1;
            if (!r.forced && (st === D.CellState.partial || st === D.CellState.sparse || st === D.CellState.texture)) blocked++;
        });
    });
    detail.rejected.forEach(r => r.cells.forEach((g) => {
        if (inRegion[g] >= 0) both++;
    }));
    return { overlap, both, blocked, ok: !overlap && !both && !blocked, text: `regions overlap ${overlap}, region cells in a rejected cluster ${both}, region cells partial/sparse/texture ${blocked}` };
};

// the free views of every suggestion: the camera inside the scanned volume
// (the robust box of the present cells, 1st-99th percentile, grown by 2
// cells and by the region's box) and on an empty cell, and the segment from
// it to the target free - sampled every c / 4, no present cell there that
// is not the region's or its ring's (the view would look through it), and
// the first present cell it meets is the region's
const viewCheck = (run) => {
    const d = run.detail, c = run.cell;
    // the core's box (an older snapshot without presentBox: the same rule)
    const box = D.presentBox ? D.presentBox(d.keys, d.present, c) : (() => {
        const axes = [[], [], []];
        const step = Math.max(1, Math.floor(d.keys.length / 50000));
        for (let g = 0; g < d.keys.length; g += step) {
            if (!d.present[g]) continue;
            const v = core.decode(d.keys[g]);
            for (let a = 0; a < 3; a++) axes[a].push(v[a]);
        }
        const min = [0, 0, 0], max = [c, c, c];
        axes.forEach((v, a) => {
            v.sort((x, y) => x - y);
            if (!v.length) return;
            min[a] = v[Math.min(v.length - 1, Math.floor(0.01 * v.length))] * c;
            max[a] = (v[Math.min(v.length - 1, Math.floor(0.99 * v.length))] + 1) * c;
        });
        return { min, max };
    })();
    const find = (key) => {
        let lo = 0, hi = d.keys.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (d.keys[mid] < key) lo = mid + 1;
            else hi = mid;
        }
        return lo < d.keys.length && d.keys[lo] === key ? lo : -1;
    };
    const cellAt = p => find(keyOf(Math.floor(p[0] / c), Math.floor(p[1] / c), Math.floor(p[2] / c)));
    // every cell the segment from a to b passes, in order (exact traversal;
    // sampling every c / 4 skipped cells the line only clips at an edge)
    const cellsOn = (a, b) => {
        const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        const cell = [0, 1, 2].map(i => Math.floor(a[i] / c));
        const step = dir.map(v => (v > 0 ? 1 : -1));
        const delta = dir.map(v => (Math.abs(v) > 1e-12 ? c * L / Math.abs(v) : Infinity));
        const next = [0, 1, 2].map(i => (Math.abs(dir[i]) > 1e-12 ? ((cell[i] + (dir[i] > 0 ? 1 : 0)) * c - a[i]) / dir[i] * L : Infinity));
        const out = [];
        for (let t = 0; t <= L;) {
            out.push(find(keyOf(cell[0], cell[1], cell[2])));
            const i = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
            t = next[i];
            next[i] += delta[i];
            cell[i] += step[i];
        }
        return out;
    };
    let views = 0, outside = 0, occupied = 0, blocked = 0, behind = 0, none = 0;
    const lengths = [];
    // the region's cells when its views were made (before cells of apart
    // clusters left it)
    const before = new Map([...(run.byBatchId?.values() ?? [])].map(e => [e.region, e.cells]));
    d.regions.forEach((r) => {
        if (!r.views.length) none++;
        const mine = new Set(Array.from(before.get(r) ?? r.cells));
        const own = new Set([...mine, ...Array.from(r.ring)]);
        // the region's box then (the paint shrinks it when cells leave)
        const rMin = [Infinity, Infinity, Infinity], rMax = [-Infinity, -Infinity, -Infinity];
        mine.forEach((g) => {
            const v = core.decode(d.keys[g]);
            for (let a = 0; a < 3; a++) {
                rMin[a] = Math.min(rMin[a], v[a] * c);
                rMax[a] = Math.max(rMax[a], (v[a] + 1) * c);
            }
        });
        r.views.forEach((v) => {
            views++;
            const p = v.position, t = v.target;
            const out = [0, 1, 2].some(a => p[a] < Math.min(box.min[a], rMin[a]) - 2 * c || p[a] > Math.max(box.max[a], rMax[a]) + 2 * c);
            if (out) outside++;
            const g0 = cellAt(p);
            if (g0 >= 0 && (d.present[g0] || own.has(g0))) occupied++;
            const dist = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
            lengths.push(dist / c);
            const line = cellsOn(p, t);
            const through = line.find(g => g >= 0 && d.present[g] && !own.has(g));
            if (through !== undefined) blocked++;
            // from the camera, the first present cell towards the target is
            // the region's (not its ring: that would be behind a surface)
            const firstG = line.find(g => g >= 0 && d.present[g]);
            if (firstG !== undefined && !mine.has(firstG)) behind++;
            if (has('view-debug') && (through !== undefined || (firstG !== undefined && !mine.has(firstG)))) {
                const at = g => core.decode(d.keys[g]).map(x => ((x + 0.5) * c).toFixed(2)).join(',');
                console.log(`   view-debug #${r.id}: camera ${p.map(x => x.toFixed(3)).join(',')} target ${t.map(x => x.toFixed(3)).join(',')}; through ${through !== undefined ? `${at(through)} (cell ${through})` : '-'}; first ${firstG !== undefined ? `${at(firstG)} ${mine.has(firstG) ? 'region' : own.has(firstG) ? 'ring' : 'other'} (cell ${firstG}, region now ${r.cells.includes(firstG)})` : '-'}; line ${line.length} cells`);
            }
        });
    });
    return {
        ok: !outside && !occupied && !blocked && !behind,
        views,
        none,
        text: `${views} views of ${d.regions.length} suggestions (${none} without one): outside the scanned volume ${outside}, on an occupied cell ${occupied}, looking through another surface ${blocked}, first seeing another surface than the region ${behind}; distance p10/p50/p90 ${[0.1, 0.5, 0.9].map(q => quantile(lengths, q).toFixed(1)).join(' / ')} cells`
    };
};

// --view-diag: the free views as a viewer meets them, for the top suggestions
// (the card flies to views[0]). Enclosure: of the 26 directions of the 3 x 3
// x 3 neighbourhood, the share whose ray from the camera meets a present cell
// within 25 m - inside a scanned room near 1, behind a wall or above a roof
// the open side shows (Steinbeis, round-1 cameras above the roof: see the
// log). Cone: of 49 rays within 8 degrees of the view axis, the share whose
// first present cell (up to 1.5 times the target distance) is the region's,
// its ring's, another surface's, or none
const viewDiag = (run, top = 4) => {
    const d = run.detail, c = run.cell;
    const find = (key) => {
        let lo = 0, hi = d.keys.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (d.keys[mid] < key) lo = mid + 1;
            else hi = mid;
        }
        return lo < d.keys.length && d.keys[lo] === key ? lo : -1;
    };
    const firstHit = (p, dir, maxLen) => {
        for (let s = c / 4; s <= maxLen; s += c / 4) {
            const g = find(keyOf(Math.floor((p[0] + dir[0] * s) / c), Math.floor((p[1] + dir[1] * s) / c), Math.floor((p[2] + dir[2] * s) / c)));
            if (g >= 0 && d.present[g]) return g;
        }
        return -1;
    };
    const unit = (v) => {
        const l = Math.hypot(v[0], v[1], v[2]) || 1;
        return [v[0] / l, v[1] / l, v[2] / l];
    };
    const around = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) around.push(unit([x, y, z]));
    const before = new Map([...(run.byBatchId?.values() ?? [])].map(e => [e.region, e.cells]));
    const lines = [];
    const first = { views: 0, enclosure: 0, region: 0, hist: new Array(around.length + 1).fill(0) };
    d.regions.forEach((r, ri) => {
        const mine = new Set(Array.from(before.get(r) ?? r.cells));
        const ring = new Set(Array.from(r.ring));
        r.views.forEach((v, vi) => {
            const p = v.position, t = v.target;
            const dist = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
            const enclosed = around.filter(a => firstHit(p, a, 25) >= 0).length;
            const axis = unit([t[0] - p[0], t[1] - p[1], t[2] - p[2]]);
            const helper = Math.abs(axis[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
            const u = unit([axis[1] * helper[2] - axis[2] * helper[1], axis[2] * helper[0] - axis[0] * helper[2], axis[0] * helper[1] - axis[1] * helper[0]]);
            const w = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
            const tan = Math.tan(8 * Math.PI / 180);
            const kinds = { region: 0, ring: 0, other: 0, none: 0 };
            let centre = 'none';
            for (let i = -3; i <= 3; i++) {
                for (let j = -3; j <= 3; j++) {
                    const dir = unit([0, 1, 2].map(a => axis[a] + tan * (i / 3 * u[a] + j / 3 * w[a])));
                    const g = firstHit(p, dir, 1.5 * dist);
                    const kind = g < 0 ? 'none' : mine.has(g) ? 'region' : ring.has(g) ? 'ring' : 'other';
                    kinds[kind]++;
                    if (!i && !j) centre = kind;
                }
            }
            if (vi === 0) {
                first.views++;
                first.enclosure += enclosed / around.length;
                first.hist[enclosed]++;
                if (centre === 'region') first.region++;
            }
            if (ri < top) {
                lines.push(`   view-diag #${r.id} view ${vi + 1}: camera (${p.map(x => x.toFixed(2)).join(', ')}) ${dist.toFixed(2)} m off; enclosure ${enclosed}/${around.length}; centre ray meets ${centre}; cone region ${kinds.region}, ring ${kinds.ring}, other ${kinds.other}, none ${kinds.none} of 49`);
            }
        });
    });
    const bands = [[0, 12], [13, 17], [18, 20], [21, 26]].map(([lo, hi]) => `${lo}-${hi}: ${first.hist.slice(lo, hi + 1).reduce((a, b) => a + b, 0)}`);
    lines.push(`   view-diag first views of ${first.views} suggestions: mean enclosure ${(first.enclosure / Math.max(1, first.views)).toFixed(3)} (of 26 directions ${bands.join(', ')}), centre ray meets the region ${first.region}`);
    return lines;
};

// the paint of a finished run against its regions: every hidden row is a
// loser row of its region and lies in the region's cells, its ring or its
// haze zone (Region.haze, blur haze) (a cell that left its region - a listed
// apart cluster - keeps all its rows, also those of the region's other
// losers); kept rows outside the cells and ring are the candidates of cells
// that left (the 'leave' path)
const paintInvariant = (run) => {
    const d = run.detail;
    const byId = new Map(d.regions.map((r) => {
        const cells = new Set(Array.from(r.cells));
        const ring = new Set([...Array.from(r.ring), ...Array.from(r.haze ?? [])]);
        return [r.id, { r, cells, ring }];
    }));
    let hidden = 0, outside = 0, notLoser = 0, unknown = 0, keptLeft = 0;
    const keptLeftBy = run.applied.paint.map(() => 0);
    run.applied.paint.forEach((p, s) => {
        const rowCell = run.cells[s].rowCell, remap = d.remap[s];
        for (let i = 0; i < p.length; i++) {
            const v = p[i];
            if (!v) continue;
            const e = byId.get((v & 0x7fff) - 1);
            const lc = rowCell[i];
            const g = lc >= 0 ? remap[lc] : -1;
            if (!(v & 0x8000)) {
                hidden++;
                if (!e) unknown++;
                else if (!e.r.losers.includes(s)) notLoser++;
                else if (!e.cells.has(g) && !e.ring.has(g)) outside++;
            } else if (e && !e.cells.has(g) && !e.ring.has(g)) {
                keptLeft++;
                keptLeftBy[s]++;
            }
        }
    });
    return {
        ok: !outside && !notLoser && !unknown,
        keptLeft,
        keptLeftBy,
        text: `hidden rows ${hidden}: outside their region's cells, ring and haze zone ${outside}, of a scan that is not its loser ${notLoser}, of no region ${unknown}; kept candidates in cells that left their region ${keptLeft}`
    };
};

// --unit: constructed cells (no scan needed)
if (has('unit')) {
    let failed = 0;
    const report = (name, ok, value) => {
        if (!ok) failed++;
        console.log(`${ok ? 'ok  ' : 'MISS'} ${name}: ${value}`);
    };
    const rowsFrom = (pts) => {
        const n = pts.length;
        const positions = new Float32Array(n * 3), footprint = new Float32Array(n), opacity = new Uint8Array(n), lum = new Uint8Array(n);
        pts.forEach((p, i) => {
            positions[i * 3] = p[0];
            positions[i * 3 + 1] = p[1];
            positions[i * 3 + 2] = p[2];
            footprint[i] = p[3];
            opacity[i] = 255;
            lum[i] = 150 + (i % 7);
        });
        return { positions, footprint, opacity, lum };
    };
    const c = 0.25;
    const run2 = (a, b) => {
        const cells = [rowsFrom(a), rowsFrom(b)].map(r => D.scanCells(r, c, PIPE));
        return { cells, detail: D.composeDetail(cells, { ...PIPE, upAxis: 2, upSign: 1, sceneSize: 10 }) };
    };
    // the old quantile: the opaque count as the total
    const oldQuantile = (h, off, total, q) => {
        const target = total * q;
        let acc = 0;
        for (let b = 0; b < 24; b++) {
            const v = h[off + b];
            if (v > 0 && acc + v >= target) return -10 + (b + (target - acc) / v) * 0.5;
            acc += v;
        }
        return -10 + 24 * 0.5;
    };

    // B8: 150 000 opaque splats of one footprint in one cell (one bin, which
    // saturates at 65535); scan B the same one octave coarser
    {
        const rnd = rng(7);
        const pile = sigma => Array.from({ length: 150000 }, () => [0.05 + 0.15 * rnd(), 0.05 + 0.15 * rnd(), 0.05 + 0.15 * rnd(), sigma]);
        const { cells, detail } = run2(pile(0.01), pile(0.02));
        const sc = cells[0];
        const bin = Math.max(...sc.hist.subarray(0, 24));
        const h = detail.sharedIndex[0];
        const sizeA = detail.size[h * 2], sizeB = detail.size[h * 2 + 1];
        const oldA = c * 2 ** oldQuantile(sc.hist, 0, sc.n[0], 0.5), oldB = c * 2 ** oldQuantile(cells[1].hist, 0, cells[1].n[0], 0.5);
        report('B8 cell with 150 000 opaque splats in one bin: median footprint from the histogram\'s own mass', Math.abs(Math.log2(sizeA / 0.01)) < 0.3 && Math.abs(Math.log2(sizeB / sizeA) - 1) < 0.1,
            `opaque ${sc.n[0]}, fullest bin ${bin}; A ${len(sizeA)} (true 10.0 mm), B ${len(sizeB)} (true 20.0 mm), lead ${Math.log2(sizeB / sizeA).toFixed(2)} octave; with the opaque count as total (before): A ${len(oldA)}, B ${len(oldB)}, lead ${Math.log2(oldB / oldA).toFixed(2)}`);
        const probe = D.makeProbe(cells, detail, PIPE)([0.1, 0.1, 0.1]);
        const pair = probe.pairs.find(p => p.winner === 0 && p.loser === 1);
        report('B8 probe gives the same lead', pair && Math.abs(pair.lead - 1) < 0.1, pair ? `${pair.lead.toFixed(2)} octave` : 'no pair');
    }

    // B7: two 2 x 2 m patches in z cell 0 (c 25 cm). Patch 1: L on one plane
    // (z 3 cm), W finer on it and on two more planes (z 16 and 22 cm) that L
    // lacks - W covers L, but only a third of W lies on L (onsurf). Patch 2
    // the other way round - W covers only a third of L (cover)
    {
        const plane = (x0, z, step, sigma) => {
            const out = [];
            for (let x = x0 + step / 2; x < x0 + 2; x += step) for (let y = step / 2; y < 2; y += step) out.push([x, y, z, sigma]);
            return out;
        };
        const W = [...plane(0, 0.03, 0.01, 0.008), ...plane(0, 0.16, 0.01, 0.008), ...plane(0, 0.22, 0.01, 0.008), ...plane(4, 0.03, 0.01, 0.008)];
        const L = [...plane(0, 0.03, 0.02, 0.03), ...plane(4, 0.03, 0.02, 0.03), ...plane(4, 0.16, 0.02, 0.03), ...plane(4, 0.22, 0.02, 0.03)];
        const { cells, detail } = run2(W, L);
        const partial = detail.rejected.filter(r => r.reason === 'partial');
        const on = partial.find(r => r.centre[0] < 2), cov = partial.find(r => r.centre[0] > 4);
        report('B7 onsurf failure: rejected partial cluster with gate onsurf and the onsurf share', on && on.gate === 'onsurf' && Math.abs(on.value - 1 / 3) < 0.05,
            on ? `${on.cells.length} cells, gate ${on.gate}, value ${on.value.toFixed(3)} (W -> L)` : 'none');
        report('B7 cover failure: gate cover and the cover share', cov && cov.gate === 'cover' && Math.abs(cov.value - 1 / 3) < 0.05,
            cov ? `${cov.cells.length} cells, gate ${cov.gate}, value ${cov.value.toFixed(3)}` : 'none');
        const probe = D.makeProbe(cells, detail, PIPE);
        const p1 = probe([1.1, 1.1, 0.1]).pairs.find(p => p.winner === 0 && p.loser === 1);
        const p2 = probe([5.1, 1.1, 0.1]).pairs.find(p => p.winner === 0 && p.loser === 1);
        report('B7 probe pair: reason partial, gate onsurf, onsurf share', p1 && p1.reason === 'partial' && p1.gate === 'onsurf' && Math.abs(p1.onsurf - 1 / 3) < 0.05,
            p1 ? `reason ${p1.reason}, gate ${p1.gate}, cover ${p1.cover.toFixed(3)}, onsurf ${p1.onsurf.toFixed(3)}, lead ${p1.lead.toFixed(2)}` : 'none');
        report('B7 probe pair: gate cover', p2 && p2.reason === 'partial' && p2.gate === 'cover',
            p2 ? `reason ${p2.reason}, gate ${p2.gate}, cover ${p2.cover.toFixed(3)}, onsurf ${p2.onsurf.toFixed(3)}` : 'none');
        const inv = invariants(detail);
        report('invariants', inv.ok, inv.text);
    }

    // B7, mixed clusters: one connected 2 x 2 m patch, part failing cover
    // (L on three planes, z 3, 16 and 22 cm, W only on the lowest: cover
    // 1/3, onsurf 1), part failing onsurf (L on the lowest plane, W on it and
    // on three planes in the cell above, 30-47 cm: cover 1, onsurf 1/4); the
    // pooled cells between them fail one gate or both, so the cluster is one.
    // It names the gate that failed in more of its cells, with that gate's
    // median over those cells - below its weak threshold
    {
        const plane = (x0, x1, z, step, sigma) => {
            const out = [];
            for (let x = x0 + step / 2; x < x1; x += step) for (let y = step / 2; y < 2; y += step) out.push([x, y, z, sigma]);
            return out;
        };
        const mixed = (x0, split) => ({
            W: [...plane(x0, x0 + 2, 0.03, 0.01, 0.008), ...[0.3, 0.4, 0.47].flatMap(z => plane(split, x0 + 2, z, 0.01, 0.008))],
            L: [...plane(x0, x0 + 2, 0.03, 0.02, 0.03), ...[0.16, 0.22].flatMap(z => plane(x0, split, z, 0.02, 0.03))]
        });
        const m3 = mixed(8, 9.25), m4 = mixed(12, 12.75);
        const { detail } = run2([...m3.W, ...m4.W], [...m3.L, ...m4.L]);
        const partial = detail.rejected.filter(r => r.reason === 'partial');
        const p3 = partial.filter(r => r.centre[0] > 8 && r.centre[0] < 10), p4 = partial.filter(r => r.centre[0] > 12 && r.centre[0] < 14);
        const text = list => list.map(r => `${r.cells.length} cells at x ${r.min[0]}..${r.max[0]}, gate ${r.gate}, value ${r.value.toFixed(3)}`).join('; ') || 'none';
        // the value is the failing cells' median: a third where cover fails,
        // a quarter where onsurf fails (a median over all the cluster's
        // cells, the earlier rule, gave 0.433 and 0.389)
        report('B7 mixed cluster, most cells fail cover: one cluster, gate cover, value the failing cells\' median (1/3)', p3.length === 1 && p3[0].gate === 'cover' && Math.abs(p3[0].value - 1 / 3) < 0.05, text(p3));
        report('B7 mixed cluster, most cells fail onsurf: one cluster, gate onsurf, value the failing cells\' median (1/4)', p4.length === 1 && p4[0].gate === 'onsurf' && Math.abs(p4[0].value - 1 / 4) < 0.05, text(p4));
    }

    // the whole pipeline on constructed scans (fixed cell c): cells, detail,
    // paint inputs, paint, applyPaint
    const unitOptions = { ...PIPE, upAxis: 2, upSign: 1, sceneSize: 10 };
    const pipeline = (scanRows, options = unitOptions) => {
        const cells = scanRows.map(r => D.scanCells(r, c, options));
        const detail = D.composeDetail(cells, options);
        const jobs = D.paintInputs(detail, scanRows, cells.map(q => q.rowCell), options);
        const results = jobs.map(j => D.composePaint(j.cell, j.batches, options));
        // the regions before the paint (applyPaint renumbers and shrinks them)
        const pre = detail.regions.map(r => ({ region: r, id: r.id, cells: r.cells, losers: r.losers.slice() }));
        const applied = D.applyPaint(detail, jobs, results, { ...options, rowCounts: scanRows.map(r => r.footprint.length) });
        return { cells, detail, jobs, results, applied, pre };
    };
    // a plane at height z over [x0, x1] x [0, y1] (grid step, footprint),
    // lifted by dz inside the box [ax0, ax1] x [0, ay1]
    const sheet = (x0, x1, y1, z, step, sigma, lift = []) => {
        const out = [];
        for (let x = x0 + step / 2; x < x1; x += step) {
            for (let y = step / 2; y < y1; y += step) {
                const l = lift.find(q => x >= q.x0 && x < q.x1 && y < q.y1);
                out.push([x, y, z + (l ? l.dz : 0), sigma]);
            }
        }
        return out;
    };
    // the rows of every scan in the given global cells: hidden ones
    const hiddenIn = (run, cellSet) => run.applied.paint.map((p, s) => {
        let n = 0;
        const rc = run.cells[s].rowCell, rm = run.detail.remap[s];
        for (let i = 0; i < p.length; i++) if (p[i] && !(p[i] & 0x8000) && rc[i] >= 0 && cellSet.has(rm[rc[i]])) n++;
        return n;
    });
    const cellsOfBox = (detail, x0, x1, y1) => new Set(Array.from(detail.keys.keys()).filter((g) => {
        const [x, y] = core.decode(detail.keys[g]).map(v => (v + 0.5) * c);
        return x > x0 && x < x1 && y < y1;
    }));

    // C3: one region, winner W fine, two coarse losers; loser 1 lies 5.5 cm
    // off W's plane in a 2 x 2-cell patch, loser 2 6.8 cm off in the patch
    // next to it. Each loser's apart cells are a cluster of their own,
    // named after it and with its own separation (one cluster per region,
    // the earlier rule, merged them under the first loser with a pooled
    // value)
    {
        const A = { x0: 20, x1: 20.5, y1: 0.5, dz: 0.055 }, B = { x0: 20.5, x1: 21, y1: 0.5, dz: 0.068 };
        const W = sheet(18, 24, 1, 0.03, 0.01, 0.008);
        const L1 = sheet(18, 24, 1, 0.03, 0.02, 0.03, [A]);
        const L2 = sheet(18, 24, 1, 0.03, 0.02, 0.03, [B]);
        const run = pipeline([rowsFrom(W), rowsFrom(L1), rowsFrom(L2)]);
        const d = run.detail;
        const region = d.regions.find(r => r.losers.length === 2);
        const apart = d.rejected.filter(r => r.reason === 'apart');
        const cA = cellsOfBox(d, A.x0, A.x1, A.y1), cB = cellsOfBox(d, B.x0, B.x1, B.y1);
        const sameSet = (r, set) => r.cells.length === set.size && Array.from(r.cells).every(g => set.has(g));
        const a1 = apart.filter(r => r.loser === 1), a2 = apart.filter(r => r.loser === 2);
        const ok1 = a1.length === 1 && sameSet(a1[0], cA) && a1[0].winner === 0 && Math.abs(a1[0].value - A.dz) < 0.008;
        const ok2 = a2.length === 1 && sameSet(a2[0], cB) && a2[0].winner === 0 && Math.abs(a2[0].value - B.dz) < 0.008;
        const both = new Set([...cA, ...cB]);
        const left = region ? Array.from(both).every(g => !Array.from(region.cells).includes(g) && d.regionOf[g] < 0) : false;
        const hid = hiddenIn(run, both);
        const text = apart.map(r => `loser ${r.loser + 1}: ${r.cells.length} cells, value ${len(r.value)}`).join('; ') || 'none';
        report('C3 apart clusters per (region, loser): one per loser, its own cells and separation (5.5 / 6.8 cm), winner W', !!region && ok1 && ok2, `region ${region ? `#${region.id} losers ${region.losers.map(l => l + 1).join('+')}` : 'none'}; ${text}`);
        report('C3 the clusters\' cells left the region (regionOf -1) and none of their rows is hidden', left && hid.every(v => v === 0), `left ${left}, hidden rows there per scan ${hid.join(' / ')}`);
        const pin = paintInvariant(run);
        report('C3 paint invariant', pin.ok, pin.text);
    }

    // a region whose cells all leave (default constants): W fine over 4 x 3
    // cells, four coarse losers, the fourth 6 cm off W's plane everywhere.
    // Its apart cells are a quarter of the hide cells (drop share 0.3) and
    // 12 cells (a patch needs 20), so the region is kept and the loser's
    // loose apart cluster takes every cell: the region is gone (its id in
    // dropped), none of its rows hidden, every cell listed as apart
    {
        const lift = [{ x0: 40, x1: 41, y1: 0.75, dz: 0.06 }];
        const W = sheet(40, 41, 0.75, 0.03, 0.01, 0.008);
        const losers = [1, 2, 3, 4].map(k2 => sheet(40, 41, 0.75, 0.03, 0.02, 0.03, k2 === 4 ? lift : []));
        const run = pipeline([rowsFrom(W), ...losers.map(rowsFrom)]);
        const d = run.detail;
        const multi = run.pre.filter(e => e.losers.length === 4);
        const listedCells = new Set(d.rejected.filter(r => r.reason === 'apart').flatMap(r => Array.from(r.cells)));
        const hidden = run.applied.paint.reduce((sum, p) => sum + p.reduce((t, v) => t + (v && !(v & 0x8000) ? 1 : 0), 0), 0);
        const e = multi[0];
        const ok = !!e && e.region.cells.length === 0 && !d.regions.includes(e.region) && run.applied.dropped.includes(e.id) && hidden === 0 && Array.from(e.cells).every(g => listedCells.has(g));
        const cluster = d.rejected.filter(r => r.reason === 'apart');
        report('a region whose cells all leave is gone: not a suggestion, id dropped, none of its rows hidden, every cell listed as apart', ok,
            e ? `region #${e.id} losers ${e.losers.map(l => l + 1).join('+')}, ${e.cells.length} cells before the paint, ${e.region.cells.length} after; still a suggestion ${d.regions.includes(e.region)}, dropped ${run.applied.dropped.join(',') || '-'}; rows hidden ${hidden}; apart clusters ${cluster.map(r => `${r.winner + 1}->${r.loser + 1} ${r.cells.length} cells`).join(', ') || 'none'}` : `no region with 4 losers (${run.pre.length} regions)`);
        const pin = paintInvariant(run);
        report('a region whose cells all leave: paint invariant', pin.ok, pin.text);
    }

    // a region that loserCheck builds again and that is then too small
    // (default constants): W fine over 7 x 3 cells; scan 2 coarse (3 cm
    // splats, 1050 rows) in the first 5 columns and as fine as W in the last
    // 2 (8.4 against 8 mm, 3750 rows), so W beats it strongly in the 12
    // cells whose 3 x 3 x 3 pool is all coarse (of 21), but over its hide
    // cells as a whole its count median is 0.07 octave coarser (below the
    // weak lead) and loserCheck takes it out; scan 3 coarse everywhere but
    // with fewer than minRows (200) rows. The rebuilt region is listed as
    // 'small' and named after its own loser, scan 3 - before (losers[0])
    // after scan 2, which loserCheck had removed
    {
        const W = sheet(70, 71.75, 0.75, 0.03, 0.01, 0.008);
        const part = [...sheet(70, 71.25, 0.75, 0.03, 0.03, 0.03), ...sheet(71.25, 71.75, 0.75, 0.03, 0.01, 0.0084)];
        const sparse = sheet(70, 71.75, 0.75, 0.03, 0.09, 0.03);
        const run = pipeline([rowsFrom(W), rowsFrom(part), rowsFrom(sparse)]);
        const d = run.detail;
        const all = cellsOfBox(d, 70, 71.75, 0.75);
        const small = d.rejected.filter(r => r.reason === 'small' && r.winner === 0 && Array.from(r.cells).every(g => all.has(g)));
        const rebuilt = d.diag?.loserRebuilt;
        if (has('verbose')) {
            console.log(`   cells: ${Array.from(all).map((g) => {
                const h = d.sharedIndex[g];
                const [x, y] = core.decode(d.keys[g]);
                return `(${x},${y}) owner ${d.owner[h]} state ${d.state[h]} strong ${d.strong[h]} weak ${d.weak[h]} sizes ${[0, 1, 2].map(s => len(d.size[h * 3 + s])).join('/')}`;
            }).join('; ')}`);
        }
        const ok = typeof rebuilt === 'number' && rebuilt >= 1 && small.length === 1 && small[0].loser === 2 && small[0].cells.length === all.size && !d.regions.some(r => r.winner === 0);
        report('a region loserCheck builds again and finds too small: listed as \'small\', named after the rebuilt region\'s loser (scan 3, not the removed scan 2)', ok,
            `${typeof rebuilt === 'number' ? `rebuilt ${rebuilt}` : 'this core reports no diag.loserRebuilt'}; small entries ${small.map(r => `${r.winner + 1}->${r.loser + 1} ${r.cells.length} cells, ${r.value} rows`).join(', ') || 'none'} (cells ${all.size}); suggestions ${d.regions.map(r => `${r.winner + 1} replaces ${r.losers.map(l => l + 1).join('+')}`).join(', ') || 'none'}`);
    }

    // a forced paint ("Trotzdem übernehmen": options.paint set, regionOf of
    // its free cells set before the paint as compose-suggest does): W and L
    // equally fine (3 cm splats, no region of their own), L 6 cm off W's
    // plane in a 2 x 2-cell patch (within the paint's widened reach of 2 x
    // 1.2 x 3 cm; with 8 mm splats it is 5 cm and the patch is 'uncovered').
    // Its batch lists the patch as an apart cluster: named after the batch's
    // winner and loser, the cells leave region.cells and get regionOf -1,
    // the rest stays the region's
    {
        const A = { x0: 30, x1: 30.5, y1: 0.5, dz: 0.06 };
        const W = sheet(28, 34, 1, 0.03, 0.01, 0.028);
        const L = sheet(28, 34, 1, 0.03, 0.0101, 0.03, [A]);
        const scanRows = [rowsFrom(W), rowsFrom(L)];
        const cells = scanRows.map(r => D.scanCells(r, c, unitOptions));
        const d = D.composeDetail(cells, unitOptions);
        const all = Array.from(d.shared);
        const box = { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0] };
        const fake = { reason: 'texture', winner: 0, loser: 1, cells: Int32Array.from(all), ...box, value: 0.4 };
        const paint = scanRows.map(r => new Uint16Array(r.footprint.length));
        let text = 'no forced region', ok = false, okLeft = false, holdText = 'no forced region', okHold = false;
        try {
            const region = D.forceRegion(cells, d, fake, unitOptions);
            const jobs = D.paintInputs(d, scanRows, cells.map(q => q.rowCell), { ...unitOptions, regions: [region], existing: paint });
            const results = jobs.map(j => D.composePaint(j.cell, j.batches, unitOptions));
            d.regions.push(region);
            region.cells.forEach((g) => {
                if (d.regionOf[g] < 0) d.regionOf[g] = region.id;
            });
            const before = new Set(d.rejected);
            D.applyPaint(d, jobs, results, { ...unitOptions, rowCounts: scanRows.map(r => r.footprint.length), paint });
            const added = d.rejected.filter(r => r.reason === 'apart' && !before.has(r));
            const batch = jobs[0].batches[0];
            const cA = cellsOfBox(d, A.x0, A.x1, A.y1);
            const kept = d.regions.includes(region);
            const cluster = added.find(r => r.cells.length >= 4);
            ok = kept && !!cluster && added.every(r => r.winner === batch.winner && r.loser === batch.loser);
            okLeft = !!cluster && Array.from(cluster.cells).every(g => !Array.from(region.cells).includes(g) && d.regionOf[g] === -1) &&
                Array.from(region.cells).every(g => d.regionOf[g] === region.id) && Array.from(cA).every(g => cluster.cells.includes(g));
            text = `region #${region.id} ${kept ? `kept with ${region.cells.length} cells` : 'dropped'}; new apart clusters ${added.map(r => `${r.cells.length} cells ${r.winner + 1}->${r.loser + 1} value ${len(r.value)}`).join(', ') || 'none'} (batch ${batch.winner + 1}->${batch.loser + 1})`;
            // holdOwn: W and L are equally fine in every cell (own lead about
            // 0.1 octave, below the weak lead) and W wins none strongly, so
            // the covered candidates are held: none hidden, none KEPT, and
            // the covered share still counts them
            const pl = region.perLoser[0];
            const r0 = results[0].batches[0];
            const heldN = r0.state.reduce((sum, v) => sum + (v === D.PaintState.held ? 1 : 0), 0);
            let hiddenRows = 0, heldWithValue = 0;
            batch.rows.forEach((row, q) => {
                const v = paint[1][row];
                if (v && !(v & 0x8000)) hiddenRows++;
                if (r0.state[q] === D.PaintState.held && v) heldWithValue++;
            });
            okHold = kept && pl.hidden === 0 && hiddenRows === 0 && (pl.held ?? 0) > 0 && heldN === pl.held && heldWithValue === 0 && Math.abs(pl.covered - (pl.held / (pl.hidden + pl.kept + pl.held))) < 1e-9;
            holdText = `hidden ${pl.hidden} (rows ${hiddenRows}), held ${pl.held ?? '-'} (states ${heldN}, with a paint value ${heldWithValue}), kept ${pl.kept}, covered ${pct(pl.covered)}`;
        } catch (error) {
            text = `${error.message}`;
        }
        report('forced paint: its batch lists >= 4 connected apart cells, named after the batch\'s winner and loser', ok, text);
        report('forced paint: those cells leave region.cells with regionOf -1, the others keep it', okLeft, text);
        report('hold: covered rows of cells W does not win on its own are held (not hidden, no paint value), covered share unchanged', okHold, holdText);
    }

    // holdRelease: the same equally fine pair (every cell a hold cell, the
    // cell medians equal), but in a 15 x 15 cm patch of one cell the loser's
    // splats are 10 cm (the winner's 2.8 cm: 1.8 octave finer). Matched in
    // space the loser is clearly coarser there, so the patch is let go and
    // hidden; the equally fine rows more than 10 cm off the patch stay held
    // (within the reach of the patch the loser's local mean is mixed)
    {
        const patch = { x0: 61.05, x1: 61.2, y0: 0.55, y1: 0.7 };
        const inPatch = (p, m = 0) => p[0] >= patch.x0 - m && p[0] < patch.x1 + m && p[1] >= patch.y0 - m && p[1] < patch.y1 + m;
        const W = sheet(60, 64, 1, 0.03, 0.01, 0.028);
        const L = sheet(60, 64, 1, 0.03, 0.0101, 0.03).map(p => (inPatch(p) ? [p[0], p[1], p[2], 0.1] : p));
        const scanRows = [rowsFrom(W), rowsFrom(L)];
        const cells = scanRows.map(r => D.scanCells(r, c, unitOptions));
        const d = D.composeDetail(cells, unitOptions);
        const fake = { reason: 'texture', winner: 0, loser: 1, cells: Int32Array.from(d.shared), min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0], value: 0.4 };
        const paint = scanRows.map(r => new Uint16Array(r.footprint.length));
        let text = 'no forced region', okRelease = false;
        try {
            const region = D.forceRegion(cells, d, fake, unitOptions);
            const jobs = D.paintInputs(d, scanRows, cells.map(q => q.rowCell), { ...unitOptions, regions: [region], existing: paint });
            const results = jobs.map(j => D.composePaint(j.cell, j.batches, unitOptions));
            d.regions.push(region);
            region.cells.forEach((g) => {
                if (d.regionOf[g] < 0) d.regionOf[g] = region.id;
            });
            D.applyPaint(d, jobs, results, { ...unitOptions, rowCounts: scanRows.map(r => r.footprint.length), paint });
            let big = 0, bigHidden = 0, farHidden = 0, farHeld = 0;
            const st = results[0].batches[0].state, rowsB = jobs[0].batches[0].rows;
            rowsB.forEach((row, q) => {
                const v = paint[1][row];
                const hid = !!v && !(v & 0x8000);
                if (inPatch(L[row])) {
                    big++;
                    if (hid) bigHidden++;
                } else if (!inPatch(L[row], 0.1)) {
                    if (hid) farHidden++;
                    else if (st[q] === D.PaintState.held) farHeld++;
                }
            });
            okRelease = big > 0 && bigHidden >= 0.9 * big && farHidden === 0 && farHeld > 0;
            text = `patch splats hidden ${bigHidden} of ${big}; equally fine rows more than 10 cm off it hidden ${farHidden}, held ${farHeld}`;
        } catch (error) {
            text = `${error.message}`;
        }
        report('hold release: where the loser is clearly coarser than the winner matched in space (a 15 cm patch of 10 cm splats), the rows of a hold cell are hidden; the equally fine ones stay held', okRelease, text);
    }
    // blur haze (DETAIL haze): W fine (8 mm splats every cm) on a 4 x 4 m
    // floor between two walls 4 m apart, L coarse (4 cm splats every 2 cm)
    // on the same floor, reaching 1 m past W's floor (W lacks it), with a
    // hole of 15 cm in W's floor; L's blur: 10 cm splats floating 15 cm over
    // the floor. The floating splats are hidden as haze, the region's numbers
    // say so (haze, the zone's share), the strip W lacks and the rows in W's
    // hole stay, the haze lies in the region's cells, ring or haze zone
    {
        const x0 = 80, hole = { x: 82, y: 2, r: 0.075 };
        const inHole = p => Math.hypot(p[0] - hole.x, p[1] - hole.y) < hole.r;
        const wall = (x, sigma) => {
            const out = [];
            for (let y = 0.005; y < 4; y += 0.01) for (let z = 0.005; z < 1.5; z += 0.01) out.push([x, y, z, sigma]);
            return out;
        };
        const W = [...sheet(x0, x0 + 4, 4, 0.03, 0.01, 0.008).filter(p => !inHole(p)), ...wall(x0 - 0.01, 0.008), ...wall(x0 + 4.01, 0.008)];
        const floorL = sheet(x0, x0 + 5, 4, 0.03, 0.02, 0.04);
        const blur = [];
        for (let x = x0 + 0.6; x < x0 + 3.4; x += 0.3) for (let y = 0.6; y < 3.4; y += 0.3) blur.push([x, y, 0.18, 0.1]);
        const L = [...floorL, ...blur];
        const run = pipeline([rowsFrom(W), rowsFrom(L)]);
        const d = run.detail;
        const region = d.regions.find(r => r.winner === 0 && r.losers.includes(1));
        const pl = region?.perLoser[region.losers.indexOf(1)];
        const hid = i => !!run.applied.paint[1][i] && !(run.applied.paint[1][i] & 0x8000);
        let blurHidden = 0, stripHidden = 0, strip = 0, holeHidden = 0, holeN = 0;
        L.forEach((p, i) => {
            if (i >= floorL.length) {
                if (hid(i)) blurHidden++;
            } else if (p[0] > x0 + 4.05) {
                strip++;
                if (hid(i)) stripHidden++;
            } else if (inHole(p)) {
                holeN++;
                if (hid(i)) holeHidden++;
            }
        });
        const st = run.results[0]?.batches[0]?.state;
        const hazeStates = st ? st.reduce((a, v) => a + (v === D.PaintState.haze ? 1 : 0), 0) : 0;
        report('blur haze: the floating splats over the winner\'s floor are hidden as haze (>= 90 %), the region counts them (haze <= hidden)', !!pl && blurHidden >= 0.9 * blur.length && (pl.haze ?? 0) >= blurHidden && (pl.haze ?? 0) <= pl.hidden && hazeStates === pl.haze,
            pl ? `${blurHidden} of ${blur.length} hidden; card: hides ${pl.hidden}, haze ${pl.haze ?? 0} (zone ${pl.hazeRing ?? 0}), keeps ${pl.kept}; haze states ${hazeStates}; haze zone ${region.haze?.length ?? 0} cells` : 'no region');
        report('blur haze: the strip the winner lacks (1 m past its floor) and the rows in its 15 cm hole stay', stripHidden === 0 && holeN > 0 && holeHidden === 0, `strip ${stripHidden} of ${strip} hidden, hole ${holeHidden} of ${holeN} hidden`);
        const pin = paintInvariant(run);
        report('blur haze: paint invariant (haze in the region\'s cells, ring or haze zone)', pin.ok, pin.text);
        const inv = invariants(d);
        report('blur haze: invariants', inv.ok, inv.text);
    }
    // gross blur (DETAIL hazeGross), one hand-made batch of haze-zone rows
    // (c 20 cm): W a fine floor (1.6 cm splats every 2 cm, x 0..4 m) between
    // two walls; L's surroundings a floor on to x 5 m; L's rows 40 cm blobs
    // hovering 4 cm over the floor - 9 over W's floor (more than their reach
    // of 1.2 m from its walls and sides: by a wall the plane of W's voxels in
    // the reach tilts, rule 2), 5 over L's strip past W's end. With L's
    // floor of 8 cm splats (gross: 2.3 octaves coarser) the
    // blobs over W's floor are haze (off its 1.6 cm thin surface, between its
    // walls), those past its end stay; with L's floor of 4 cm splats (1.3
    // octaves, not gross) all stay (rule 3: within the paint's tolerance of
    // W's plane and no W splat at their centre)
    {
        const c = 0.2;
        const W = [];
        for (let x = 0.01; x < 4; x += 0.02) for (let y = 0.01; y < 4; y += 0.02) W.push([x, y, 0]);
        for (const xw of [-0.01, 4.01]) for (let y = 0.01; y < 4; y += 0.02) for (let z = 0.01; z < 1.5; z += 0.02) W.push([xw, y, z]);
        const winnerPoints = new Float32Array(W.flat());
        const winnerSize = new Float32Array(W.length).fill(0.016);
        const occ = new Map();
        W.forEach((p) => {
            const key = keyOf(Math.floor(p[0] / c), Math.floor(p[1] / c), Math.floor(p[2] / c));
            occ.set(key, (occ.get(key) ?? 0) + 1);
        });
        const hazeOcc = new Float64Array([...occ.entries()].filter(([, n]) => n >= 2).map(([key]) => key).sort((a, b) => a - b));
        const inner = [], past = [];
        for (let x = 1.5; x <= 2.5; x += 0.5) for (let y = 1.5; y <= 2.5; y += 0.5) inner.push([x, y, 0.04]);
        for (let y = 1; y <= 3; y += 0.5) past.push([4.6, y, 0.04]);
        const blobs = [...inner, ...past];
        const run = (floorSize) => {
            const floor = [];
            for (let x = 0.02; x < 5; x += 0.04) for (let y = 0.02; y < 4; y += 0.04) floor.push([x, y, 0]);
            const batch = {
                id: 0,
                winner: 0,
                loser: 1,
                winnerPoints,
                winnerSize,
                candidates: new Float32Array(blobs.flat()),
                candidateSize: new Float32Array(blobs.length).fill(0.4),
                candidateCell: new Int32Array(blobs.length),
                ring: new Uint8Array(blobs.length).fill(1),
                hazeFrom: 0,
                hazeW: new Float32Array(0),
                hazeWSize: new Float32Array(0),
                hazeWCount: new Float32Array(0),
                hazeL: new Float32Array(floor.flat()),
                hazeLSize: new Float32Array(floor.length).fill(floorSize),
                hazeLCount: new Float32Array(floor.length).fill(1),
                hazeOcc,
                s50W: 0.016
            };
            const st = D.composePaint(c, [batch], unitOptions).batches[0].state;
            const n = (from, to) => st.slice(from, to).reduce((a, v) => a + (v === D.PaintState.haze ? 1 : 0), 0);
            return { inner: n(0, inner.length), past: n(inner.length, blobs.length) };
        };
        try {
            const gross = run(0.08), plain = run(0.04);
            report('gross blur: 40 cm blobs hovering 4 cm over a fine floor are haze where L\'s surroundings are 4x coarser (and stay past W\'s end); with 2.5x coarser surroundings they stay',
                gross.inner === inner.length && gross.past === 0 && plain.inner === 0 && plain.past === 0,
                `L floor 8 cm: haze ${gross.inner} of ${inner.length} over W, ${gross.past} of ${past.length} past its end; L floor 4 cm: ${plain.inner} / ${plain.past}`);
        } catch (error) {
            report('gross blur: hand-made batch', false, error.message);
        }
    }
    // blurry areas (compose-blur): scan A is a 20 x 20 m floor of fine
    // splats (2.5 cm, 5 cm apart) except a 6 x 6 m patch of giant ones (25
    // cm, 25 cm apart: no sharpness at all), plus a free-floating ball of 400
    // giant splats 3 m above the floor; scan B is the fine floor everywhere.
    // Alone: the patch is one surface area, the ball an island. As a pair:
    // the patch says 'B is sharp here', the ball 'only A', B has no area.
    // Twins (A, A): areas only where A itself is blurry, never 'other sharp'
    {
        const rnd = rng(11);
        const make = (withBlur) => {
            const pts = [];
            const inPatch = (x, y) => x >= 12 && x < 18 && y >= 12 && y < 18;
            for (let x = 0.025; x < 20; x += 0.05) for (let y = 0.025; y < 20; y += 0.05) if (!withBlur || !inPatch(x, y)) pts.push([x, y, 0.004 * (rnd() - 0.5), 0.025, 0]);
            if (withBlur) {
                for (let x = 12.125; x < 18; x += 0.25) for (let y = 12.125; y < 18; y += 0.25) pts.push([x, y, 0.05 * (rnd() - 0.5), 0.25, 1]);
                for (let i = 0; i < 400; i++) {
                    let x, y, z;
                    do {
                        x = 2 * rnd() - 1; y = 2 * rnd() - 1; z = 2 * rnd() - 1;
                    } while (x * x + y * y + z * z > 1);
                    pts.push([5 + x, 5 + y, 3 + z, 0.3, 2]);
                }
            }
            const n = pts.length;
            const positions = new Float32Array(n * 3), footprint = new Float32Array(n), opacity = new Uint8Array(n), truth = new Uint8Array(n);
            pts.forEach((p, i) => {
                positions.set(p.slice(0, 3), i * 3);
                footprint[i] = p[3];
                opacity[i] = 230;
                truth[i] = p[4];
            });
            return { positions, footprint, opacity, truth };
        };
        const A = make(true), B = make(false);
        const count = (truth, kind) => truth.reduce((a, v) => a + (v === kind ? 1 : 0), 0);
        const inArea = (area, truth, kind) => {
            let c = 0;
            for (const i of area.rows) c += truth[i] === kind ? 1 : 0;
            return c;
        };
        const nPatch = count(A.truth, 1), nBall = count(A.truth, 2);
        const opts = { upAxis: 2 };
        const alone = BL.composeBlur([A], opts);
        const patchArea = alone.areas.find(a => inArea(a, A.truth, 1) > nPatch / 2);
        const ballArea = alone.areas.find(a => inArea(a, A.truth, 2) > nBall / 2);
        report('blur areas, one scan: the giant-splat patch is one surface area, the ball one island, nothing else',
            alone.areas.length === 2 && patchArea && ballArea && patchArea !== ballArea && patchArea.kind === 'surface' && ballArea.kind === 'island' &&
            inArea(patchArea, A.truth, 1) >= 0.9 * nPatch && inArea(patchArea, A.truth, 0) <= 0.01 * patchArea.splats && inArea(ballArea, A.truth, 2) >= 0.9 * nBall && patchArea.compare === 'none',
            `cell ${alone.cell} m, ${alone.areas.length} areas; patch ${patchArea ? `${inArea(patchArea, A.truth, 1)} of ${nPatch} (+${inArea(patchArea, A.truth, 0)} fine), ${patchArea.kind}` : 'none'}; ball ${ballArea ? `${inArea(ballArea, A.truth, 2)} of ${nBall}, ${ballArea.kind}` : 'none'}`);
        const pair = BL.composeBlur([A, B], opts);
        const pPatch = pair.areas.find(a => a.scan === 0 && inArea(a, A.truth, 1) > nPatch / 2);
        const pBall = pair.areas.find(a => a.scan === 0 && inArea(a, A.truth, 2) > nBall / 2);
        report('blur areas, pair: patch "B is sharp here", ball "only A", B none',
            pPatch?.compare === 'otherSharp' && pPatch.sharpBy === 1 && pPatch.lead > 2.5 && pBall?.compare === 'alone' && pBall.kind === 'island' && !pair.areas.some(a => a.scan === 1) && pPatch.score > 0.5,
            `patch ${pPatch ? `${pPatch.compare} by ${pPatch.sharpBy}, other sharp ${pct(pPatch.otherSharp)}, lead ${pPatch.lead.toFixed(2)} oct, score ${pPatch.score.toFixed(2)}` : 'none'}; ball ${pBall ? `${pBall.compare}, alone ${pct(pBall.alone)}` : 'none'}; areas of B ${pair.areas.filter(a => a.scan === 1).length}`);
        const twins = BL.composeBlur([A, A], opts);
        const rowsOf = (res, s) => res.areas.filter(a => a.scan === s).flatMap(a => Array.from(a.rows)).sort((x, y) => x - y).join(',');
        report('blur areas, twins: the areas of one scan alone, never "other sharp"',
            !twins.areas.some(a => a.otherSharp > 0 || a.compare === 'otherSharp') && rowsOf(twins, 0) === rowsOf(alone, 0) && rowsOf(twins, 1) === rowsOf(alone, 0),
            `${twins.areas.length} areas: ${twins.areas.map(a => `${a.scan}:${a.compare}`).join(', ')}`);
        // colour views: patch rows blurry, floor rows sharp; the comparison
        // view only in the pair
        let patchMin = 255, floorMax = 0, cmpPatch = 255, cmpFloor = 0;
        for (let i = 0; i < A.truth.length; i++) {
            if (A.truth[i] === 1) {
                patchMin = Math.min(patchMin, alone.blur[0][i]);
                cmpPatch = Math.min(cmpPatch, pair.coarser[0][i]);
            } else if (A.truth[i] === 0) {
                floorMax = Math.max(floorMax, alone.blur[0][i]);
                cmpFloor = Math.max(cmpFloor, pair.coarser[0][i]);
            }
        }
        const cmpB = pair.coarser[1].reduce((a, v) => Math.max(a, v), 0);
        report('blur areas: per-row blur value (patch high, floor 0) and comparison value (A\'s patch coarser than B, B never)',
            patchMin >= 160 && floorMax <= 40 && cmpPatch >= 128 && cmpFloor <= 40 && cmpB === 0,
            `blur: patch min ${patchMin}, floor max ${floorMax}; coarser than B: patch min ${cmpPatch}, floor max ${cmpFloor}, B max ${cmpB}`);
    }
    report('contract: CellState.uncovered is 10, apart 9', D.CellState.uncovered === 10 && D.CellState.apart === 9, `${D.CellState.uncovered}, ${D.CellState.apart}`);
    process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- real pairs

const upOf = (pos) => {
    const box = core.robustBox(pos);
    const ext = [0, 1, 2].map(k => box.max[k] - box.min[k]);
    return ext.indexOf(Math.min(...ext));
};

const reportReal = (name, run, scanNames) => {
    const d = run.detail;
    console.log(`${name}: cell ${len(run.cell)} (per scan ${run.auto.perScan.map(len).join(', ')}${run.auto.forcedBy >= 0 ? `, forced by ${scanNames[run.auto.forcedBy]}` : ''}), ` +
        `cells ${run.times.cells.toFixed(1)} s + detail ${run.times.detail.toFixed(1)} s + paint ${(run.times.inputs + run.times.paint + run.times.apply).toFixed(1)} s = ${run.times.total.toFixed(1)} s`);
    d.scans.forEach((s, i) => console.log(`   ${scanNames[i]}: s50 ${len(s.s50)}, finest ${pct(s.finest)}, tie ${pct(s.tie)}, coarser ${pct(s.coarser)}, alone ${pct(s.alone)}, area ${s.area.toFixed(0)} m2`));
    d.pairs.forEach((p) => {
        const lead = p.bias >= 0 ? `${scanNames[p.a]} ${(2 ** p.bias).toFixed(2)}x finer` : `${scanNames[p.b]} ${(2 ** -p.bias).toFixed(2)}x finer`;
        console.log(`   pair ${scanNames[p.a]}-${scanNames[p.b]}: shared ${p.sharedCells} cells (${p.sharedArea.toFixed(0)} m2), general difference ${lead} (raw ${p.biasRaw.toFixed(3)} oct over ${p.biasCells} cells), ` +
            `clearly finer ${scanNames[p.a]} ${pct(p.clearA)}, ${scanNames[p.b]} ${pct(p.clearB)}, exposure ${scanNames[p.b]} ${((Math.exp(p.exposure) - 1) * 100).toFixed(1)} %`);
    });
    const states = {};
    for (let h = 0; h < d.state.length; h++) states[d.state[h]] = (states[d.state[h]] ?? 0) + 1;
    const names = Object.fromEntries(Object.entries(D.CellState).map(([k, v]) => [v, k]));
    console.log(`   shared cells by state: ${Object.entries(states).map(([k, v]) => `${names[k]} ${pct(v / d.state.length)}`).join(', ')}`);
    const byReason = {};
    d.rejected.forEach((r) => {
        byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
    });
    console.log(`   suggestions ${d.regions.length} (${d.regions.filter(r => r.scope === 'base').length} base, ${d.regions.filter(r => r.confidence === 'clear').length} clear), rejected ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    // loserCheck: raw regions dropped (listed as 'equal' or 'sparse') and
    // rebuilt; cells without a per-cell lead to confirm with
    if (d.diag) {
        const eq = d.rejected.filter(r => r.reason === 'equal');
        console.log(`   diag: unconfirmed cells ${d.diag.unconfirmed}, loserCheck dropped ${d.diag.loserDropped} raw regions (equal ${eq.length}: ${eq.reduce((s, r) => s + r.cells.length, 0)} cells, values p50 ${quantile(eq.map(r => r.value), 0.5).toFixed(3)} oct; sparse ${d.diag.loserDropped - eq.length}), rebuilt ${d.diag.loserRebuilt}, raw regions without a loser listed as 'small' ${d.diag.loserless ?? '-'}`);
    }
    // cells a scan owns (strong or weak win) that are in no suggestion and
    // no listed cluster: weak ones only grow regions (by design), strong
    // ones are seeds of raw regions too small for a loser
    {
        const listed = new Uint8Array(d.keys.length);
        d.rejected.forEach(r => r.cells.forEach((g) => {
            listed[g] = 1;
        }));
        let owned = 0, orphan = 0, orphanStrong = 0;
        for (let h = 0; h < d.state.length; h++) {
            if (d.owner[h] < 0) continue;
            owned++;
            const g = d.shared[h];
            if (d.regionOf[g] >= 0 || listed[g]) continue;
            orphan++;
            if (d.strong[h]) orphanStrong++;
        }
        console.log(`   owned cells ${owned}: in no suggestion and no listed cluster ${orphan} (${orphanStrong} strong) = ${pct(orphan / Math.max(1, d.state.length))} of the shared cells`);
        run.orphanStrong = orphanStrong;
    }
    describeRegions(run, 10).forEach(l => console.log(l));
    if (verbose) {
        // the free views of the top 4 suggestions: camera, distance, height
        // over the target along the up axis
        const up = d.upAxis;
        d.regions.slice(0, 4).forEach((r) => {
            const v = r.views.map((q) => {
                const dist = Math.hypot(q.position[0] - q.target[0], q.position[1] - q.target[1], q.position[2] - q.target[2]);
                return `(${q.position.map(x => x.toFixed(2)).join(', ')}) ${dist.toFixed(2)} m, ${'xyz'[up]} ${q.position[up] >= q.target[up] ? '+' : ''}${(q.position[up] - q.target[up]).toFixed(2)} m`;
            });
            console.log(`   views #${r.id}: box ${r.min.map(x => x.toFixed(2)).join(',')} .. ${r.max.map(x => x.toFixed(2)).join(',')}; ${v.join(' | ') || 'none (marker focus)'}`);
        });
        // paint states and plane distances of the top batches
        run.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
            const b = run.results[ji].batches[bi];
            if (b.id > 4) return;
            const st = [0, 0, 0, 0, 0, 0, 0];
            const dk = [], dh = [];
            for (let q = 0; q < b.state.length; q++) {
                st[b.state[q]]++;
                if (!Number.isNaN(b.distance[q])) (b.state[q] === 1 ? dh : dk).push(b.distance[q]);
            }
            const sz = Array.from(batch.candidateSize);
            console.log(`   paint #${b.id}: hidden ${st[1]}, uncovered ${st[2]}, apart ${st[3]}, no surface ${st[4]}, held ${st[5]}, haze ${st[6]} (zone ${b.hazeRing ?? 0} of ${batch.hazeFrom !== undefined ? batch.candidateSize.length - batch.hazeFrom : 0}); plane distance hidden p50 ${len(quantile(dh, 0.5))}, kept p50 ${len(quantile(dk, 0.5))} p90 ${len(quantile(dk, 0.9))}; candidate sigma p50 ${len(quantile(sz, 0.5))}; sW ${len(b.sW)} rt ${len(b.rt)} rn ${len(b.rn)}`);
        }));
    }
    d.rejected.slice(0, 8).forEach(r => console.log(`   rejected ${r.reason} ${r.winner + 1}->${r.loser + 1}: ${r.cells.length} cells at ${r.centre.map(v => v.toFixed(1)).join(', ')}, value ${r.value?.toFixed?.(3)}`));
};

// ---------------------------------------------------------------- blurry areas

// --blur: the simple path of the scan composition (compose-blur.ts)
if (has('blur')) {
    let failed = 0;
    const check = (name, ok, value) => {
        if (!ok) failed++;
        console.log(`${ok ? 'ok  ' : 'MISS'} ${name}: ${value}`);
    };
    const files = positional;
    if (!files.length) {
        console.log('usage: --blur <a.ply> [<b.ply> ...] [--matrix m] [--changed-truth] [--twin] [--sphere] [--box ...]');
        process.exit(2);
    }
    let matrix = null;
    const m = option('matrix', null);
    if (m) matrix = m.includes(',') ? m.split(',').map(Number) : JSON.parse(readFileSync(m, 'utf8')).matrix;
    // compact rows straight from the ply (footprint, opacity byte); the
    // matrix, if any, moves the second file
    const rowsOfPly = (ply, mat) => {
        const { data, P, at, count } = ply;
        const positions = new Float32Array(count * 3), footprint = new Float32Array(count), opacity = new Uint8Array(count);
        const s = mat ? Math.cbrt(Math.abs(mat[0] * (mat[5] * mat[10] - mat[9] * mat[6]) - mat[4] * (mat[1] * mat[10] - mat[9] * mat[2]) + mat[8] * (mat[1] * mat[6] - mat[5] * mat[2]))) : 1;
        const ix = at.x, iy = at.y, iz = at.z, s0 = at.scale_0, s1 = at.scale_1, s2 = at.scale_2, io = at.opacity;
        for (let i = 0, o = 0; i < count; i++, o += P) {
            const x = data[o + ix], y = data[o + iy], z = data[o + iz];
            if (mat) {
                positions[i * 3] = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
                positions[i * 3 + 1] = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
                positions[i * 3 + 2] = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
            } else {
                positions[i * 3] = x;
                positions[i * 3 + 1] = y;
                positions[i * 3 + 2] = z;
            }
            footprint[i] = D.footprintOf(Math.exp(data[o + s0]), Math.exp(data[o + s1]), Math.exp(data[o + s2])) * s;
            opacity[i] = D.opacityByte(sigmoid(data[o + io]));
        }
        return { positions, footprint, opacity };
    };
    const tRead = now();
    const plys = files.map(f => readPly(f));
    const scans = plys.map((ply, i) => rowsOfPly(ply, i === 1 ? matrix : null));
    console.log(`read ${((now() - tRead) / 1000).toFixed(1)} s: ${scans.map(r => r.footprint.length.toLocaleString()).join(' + ')} splats`);
    const upArg = option('up', null);
    const opts = { ...constants, ...(upArg ? { upAxis: 'xyz'.indexOf(upArg) } : {}) };
    const names = files.map((f, i) => String.fromCharCode(65 + i));
    const box = option('box', null)?.split(',').map(Number) ?? null;

    const run = (list, label, nameList = names) => {
        const t0 = now();
        const res = BL.composeBlur(list, opts);
        const seconds = (now() - t0) / 1000;
        console.log(`${label}: ${seconds.toFixed(2)} s, cell ${+res.cell.toPrecision(6)}, up ${'xyz'[res.upAxis]}, ${res.areas.length} areas`);
        res.scans.forEach((sc, i) => console.log(`   ${nameList[i]}: reference ${len(sc.ref)}, voxels present ${sc.presentVoxels} / blurry ${sc.blurryVoxels} / sharp ${sc.sharpVoxels}, rows in areas ${sc.areaRows.toLocaleString()} (${pct(sc.areaRows / sc.rows)}), dropped ${sc.droppedPieces} pieces (${sc.droppedRows} rows)`));
        res.areas.forEach((a) => {
            const other = a.compare === 'none' ? '' : `, other sharp ${pct(a.otherSharp)} / blurry ${pct(a.otherBlurry)} / none ${pct(a.alone)}${a.sharpBy >= 0 ? ` (sharp: ${nameList[a.sharpBy]}, lead ${a.lead.toFixed(2)} oct)` : ''}`;
            console.log(`   #${a.id} ${nameList[a.scan]} ${a.kind} ${a.compare}: ${a.splats.toLocaleString()} splats, ${a.voxels} voxels, ${a.dims.map(v => v.toFixed(1)).join(' x ')}, centre ${a.centroid.map(v => v.toFixed(1)).join(', ')}, blur ${a.blur.toFixed(2)} oct, score ${a.score.toFixed(2)}${a.pieces > 1 ? `, ${a.pieces} pieces` : ''}${other}`);
        });
        // invariants: rows ascending, in range, in one area only; maps as long
        // as the scans; ids in rank order
        const seen = list.map(r => new Uint8Array(r.footprint.length));
        let bad = 0;
        res.areas.forEach((a, i) => {
            if (a.id !== i || a.splats !== a.rows.length || (i > 0 && res.areas[i - 1].score < a.score)) bad++;
            for (let q = 0; q < a.rows.length; q++) {
                const r = a.rows[q];
                if (r >= seen[a.scan].length || (q > 0 && a.rows[q - 1] >= r) || seen[a.scan][r]++) bad++;
            }
        });
        if (res.blur.length !== list.length || res.coarser.length !== list.length || res.blur.some((b, i) => b.length !== list[i].footprint.length)) bad++;
        check(`${label}: invariants (rows ascending, in one area, maps, rank order)`, bad === 0, `${bad} violations`);
        if (box) {
            res.areas.forEach((a) => {
                const r = list[a.scan];
                const inBox = (i) => {
                    for (let k = 0; k < 3; k++) {
                        const v = r.positions[i * 3 + k];
                        if (v < box[k] || v > box[k + 3]) return false;
                    }
                    return true;
                };
                let n = 0, w = 0;
                for (const i of a.rows) {
                    if (!inBox(i)) continue;
                    n++;
                    w += r.opacity[i] / 255 * r.footprint[i] ** 2;
                }
                if (!n) return;
                let all = 0, wAll = 0;
                for (let i = 0; i < r.footprint.length; i++) {
                    if (!inBox(i)) continue;
                    all++;
                    wAll += r.opacity[i] / 255 * r.footprint[i] ** 2;
                }
                console.log(`   box: #${a.id} has ${n} of the ${all} rows of ${nameList[a.scan]} in the box (${pct(n / all)}), visual weight ${pct(w / wAll)}`);
            });
        }
        return { res, seconds };
    };

    const main = run(scans, files.length > 1 ? 'all scans' : 'scan');
    const again = BL.composeBlur(scans, opts);
    const sig = r => r.areas.map(a => `${a.scan}:${a.kind}:${a.compare}:${a.splats}:${a.rows[0]}:${a.rows[a.rows.length - 1]}:${a.score}`).join('|');
    check('deterministic (second run identical)', sig(again) === sig(main.res), `${again.areas.length} areas`);

    // truth: the changed rows of b (--changed-truth) or the gross blur ball
    // (--sphere): one area holds them
    const truthCheck = (res, truth, s, label, minRecall, info = false) => {
        let total = 0;
        for (let i = 0; i < truth.length; i++) total += truth[i];
        const others = truth.length - total;
        let best = null, bestIn = 0, inAny = 0;
        res.areas.filter(a => a.scan === s).forEach((a) => {
            let c = 0;
            for (const i of a.rows) c += truth[i];
            inAny += c;
            if (c > bestIn) {
                best = a;
                bestIn = c;
            }
        });
        const outside = best ? best.splats - bestIn : 0;
        const text = best ? `#${best.id} ${best.kind} ${best.compare}: ${bestIn} of ${total} (${pct(bestIn / total)}), in any area ${inAny}, other rows in it ${outside} (${pct(outside / others)})` : `no area (in any area ${inAny} of ${total})`;
        if (info) console.log(`info ${label}: ${text}`);
        else {
            check(`${label}: the blurred rows form one area (>= ${pct(minRecall)} of them, >= 90 % of those in any area, <= 0.1 % of the other rows)`,
                best && bestIn >= minRecall * total && bestIn >= 0.9 * inAny && outside <= 0.001 * others, text);
        }
        return best;
    };
    if (has('changed-truth') && files.length === 2) {
        const [pa, pb] = plys;
        if (pa.count !== pb.count || pa.P !== pb.P) throw new Error('--changed-truth: the two files need the same rows');
        const truth = new Uint8Array(pb.count);
        for (let i = 0; i < pb.count; i++) {
            for (let q = i * pb.P; q < (i + 1) * pb.P; q++) {
                if (pa.data[q] !== pb.data[q]) {
                    truth[i] = 1;
                    break;
                }
            }
        }
        const best = truthCheck(main.res, truth, 1, 'changed rows, pair', 0.6);
        check('changed rows, pair: their area says "A is sharp here"', best?.compare === 'otherSharp' && best.sharpBy === 0, best ? `${best.compare}, sharp ${best.sharpBy >= 0 ? names[best.sharpBy] : '-'}` : '-');
        // B alone: information only - a 3x blur (1.6 octaves) is below the
        // absolute bound (compose-blur BLUR.blurOctaves 2)
        const single = run([scans[1]], 'B alone', ['B']);
        truthCheck(single.res, truth, 0, 'changed rows, B alone (a 3x blur is below the absolute bound)', 0, true);
    }
    if (has('swap-check') && files.length === 2) {
        const swapped = BL.composeBlur([scans[1], scans[0]], opts);
        const key = (r, map) => r.areas.map(a => `${map[a.scan]}:${a.kind}:${a.compare}:${a.splats}`).sort().join('|');
        check('swap: the same areas with the scans swapped', key(swapped, [1, 0]) === key(main.res, [0, 1]), `${swapped.areas.length} areas`);
    }
    if (has('twin')) {
        const copy = { positions: scans[0].positions.slice(), footprint: scans[0].footprint.slice(), opacity: scans[0].opacity.slice() };
        const tw = run([scans[0], copy], 'twins', ['A', 'A\'']);
        const alone = files.length === 1 ? main : run([scans[0]], 'A alone', ['A']);
        const rowsOf = (res, s) => res.areas.filter(a => a.scan === s).flatMap(a => Array.from(a.rows)).sort((x, y) => x - y).join(',');
        check('twins: areas only where the scan itself is blurry, never "other sharp"',
            !tw.res.areas.some(a => a.otherSharp > 0 || a.compare === 'otherSharp') && rowsOf(tw.res, 0) === rowsOf(alone.res, 0) && rowsOf(tw.res, 1) === rowsOf(alone.res, 0),
            `${tw.res.areas.length} areas (alone ${alone.res.areas.length}), with other sharp ${tw.res.areas.filter(a => a.otherSharp > 0).length}`);
    }
    if (has('sphere') && files.length === 1) {
        // a gross blur ball in a copy: of the rows within r of the opaque
        // centroid every 8th stays, 8x larger, moved by 0.25 of its new
        // size (like the Nuremberg bridge: few giant splats); r takes about
        // 1 % of the rows
        const A = scans[0];
        const n = A.footprint.length;
        const c = [0, 0, 0];
        let w = 0;
        for (let i = 0; i < n; i++) {
            if (A.opacity[i] < 51) continue;
            for (let k = 0; k < 3; k++) c[k] += A.positions[i * 3 + k];
            w++;
        }
        for (let k = 0; k < 3; k++) c[k] /= Math.max(1, w);
        const d2 = new Float32Array(n);
        for (let i = 0; i < n; i++) d2[i] = (A.positions[i * 3] - c[0]) ** 2 + (A.positions[i * 3 + 1] - c[1]) ** 2 + (A.positions[i * 3 + 2] - c[2]) ** 2;
        const sample = [];
        for (let i = 0; i < n; i += 7) sample.push(d2[i]);
        const r2 = quantile(sample, 0.01);
        const rnd = rng(5);
        const keep = [], truthList = [];
        let inBall = 0;
        for (let i = 0; i < n; i++) {
            if (d2[i] > r2) {
                keep.push(i);
                truthList.push(0);
                continue;
            }
            inBall++;
            if (inBall % 8 === 0) {
                keep.push(i);
                truthList.push(1);
            }
        }
        const Bn = keep.length;
        const B = { positions: new Float32Array(Bn * 3), footprint: new Float32Array(Bn), opacity: new Uint8Array(Bn) };
        keep.forEach((i, q) => {
            const blurred = truthList[q] === 1;
            const f = A.footprint[i] * (blurred ? 8 : 1);
            for (let k = 0; k < 3; k++) B.positions[q * 3 + k] = A.positions[i * 3 + k] + (blurred ? 0.25 * f * gauss(rnd(), rnd()) : 0);
            B.footprint[q] = f;
            B.opacity[q] = A.opacity[i];
        });
        const truth = Uint8Array.from(truthList);
        console.log(`sphere: centre ${c.map(v => v.toFixed(2)).join(', ')}, r ${Math.sqrt(r2).toFixed(2)}, ${inBall} rows in it, ${truth.reduce((a, v) => a + v, 0)} kept 8x larger`);
        // alone, the ball joins whatever blurry surface it touches (here the
        // scan's coarse rim): information only. As a pair it is the area
        // where A is sharp
        const single = run([B], 'ball alone', ['B']);
        truthCheck(single.res, truth, 0, 'gross blur ball, alone (connected blur is one area)', 0, true);
        const pair = run([A, B], 'ball as a pair', ['A', 'B']);
        const best = truthCheck(pair.res, truth, 1, 'gross blur ball, pair', 0.8);
        check('gross blur ball, pair: its area says "A is sharp here"', best?.compare === 'otherSharp' && best.sharpBy === 0, best ? best.compare : '-');
    }
    if (jsonOut) {
        const strip = r => ({ ...r, blur: undefined, coarser: undefined, areas: r.areas.map(a => ({ ...a, rows: undefined })) });
        writeFileSync(jsonOut, JSON.stringify({ files, result: strip(main.res), seconds: main.seconds }, null, 1));
    }
    console.log(failed ? `${failed} check(s) missed` : 'all checks passed');
    process.exit(failed ? 1 : 0);
}

if (has('pair')) {
    const [fa, fb] = positional;
    let matrix = null;
    const m = option('matrix', null);
    if (m) matrix = m.includes(',') ? m.split(',').map(Number) : JSON.parse(readFileSync(m, 'utf8')).matrix;
    const t0 = now();
    const plyA = readPly(fa), plyB = readPly(fb);
    // --changed-truth: B is a copy of A with some rows changed (dist/bus-blur
    // .ply: a blurred sphere in dist/bus.ply); the changed rows are the truth
    const changed = has('changed-truth') ? (() => {
        const same = plyA.count === plyB.count && plyA.P === plyB.P && Object.keys(plyA.at).every(k2 => plyB.at[k2] === plyA.at[k2]);
        if (!same) throw new Error('--changed-truth: the two files need the same rows and properties');
        const out = new Uint8Array(plyB.count);
        const { data: da, P } = plyA, db = plyB.data;
        for (let i = 0; i < plyB.count; i++) {
            for (let q = i * P; q < i * P + P; q++) {
                if (da[q] !== db[q]) {
                    out[i] = 1;
                    break;
                }
            }
        }
        return out;
    })() : null;
    const A = splatsOf(plyA);
    const B = splatsOf(plyB);
    if (matrix) {
        const s = Math.cbrt(Math.abs(matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6]) - matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2]) + matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2])));
        const p = B.pos;
        for (let i = 0; i < p.length; i += 3) {
            const x = p[i], y = p[i + 1], z = p[i + 2];
            p[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
            p[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
            p[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
        }
        for (let i = 0; i < B.scale.length; i++) B.scale[i] *= s;
    }
    // --align: b aligned onto a by the wizard's phase 1 (after --matrix, if
    // given); prints the matrix so later runs can pass it with --matrix
    if (has('align')) {
        const ta = now();
        const al = core.composeAlign(core.capPoints(B.pos, 400000), core.capPoints(A.pos, 400000), { coarse: 'auto' });
        B.pos = core.transformPoints(al.matrix, B.pos);
        for (let i = 0; i < B.scale.length; i++) B.scale[i] *= al.scale;
        console.log(`align: coarse ${al.coarse}, fit ${al.fitBefore.toFixed(3)} -> ${al.fitAfter.toFixed(3)}, ${al.angleDeg.toFixed(1)} deg, shift ${al.shift.toFixed(2)}, ${((now() - ta) / 1000).toFixed(1)} s`);
        console.log(`align matrix: ${al.matrix.map(v => +v.toFixed(6)).join(',')}`);
    }
    const rowsOf = (S) => {
        const sigma = new Float32Array(S.n);
        for (let i = 0; i < S.n; i++) sigma[i] = D.footprintOf(S.scale[i * 3], S.scale[i * 3 + 1], S.scale[i * 3 + 2]);
        return compactOf(S.pos, sigma, S.alpha, S.rgb);
    };
    const rows = [rowsOf(A), rowsOf(B)];
    const readSeconds = (now() - t0) / 1000;
    const upArg = option('up', null);
    const up = upArg ? 'xyz'.indexOf(upArg) : upOf(A.pos);
    const run = runPipeline(rows, up);
    console.log(`read ${readSeconds.toFixed(1)} s, ${A.n.toLocaleString()} + ${B.n.toLocaleString()} splats, up ${'xyz'[up]}`);
    reportReal('pair', run, ['A', 'B']);
    if (has('apart-diag')) apartDiag(run, 'pair');
    if (has('haze-diag')) {
        const box = option('haze-box', null)?.split(',').map(Number) ?? null;
        const keep = PIPE.haze;
        PIPE.haze = 0;
        const off = runPipeline(rows, up);
        if (keep === undefined) delete PIPE.haze;
        else PIPE.haze = keep;
        hazeDiag(run, off, rows, box);
    }
    let pairFailed = 0;
    {
        const inv = invariants(run.detail);
        if (!inv.ok) pairFailed++;
        console.log(`${inv.ok ? 'ok  ' : 'MISS'} invariants: ${inv.text}`);
        const pin = paintInvariant(run);
        if (!pin.ok) pairFailed++;
        console.log(`${pin.ok ? 'ok  ' : 'MISS'} paint invariant: ${pin.text}`);
        const vc = viewCheck(run);
        if (!vc.ok) pairFailed++;
        console.log(`${vc.ok ? 'ok  ' : 'MISS'} free views: ${vc.text}`);
        if (has('view-diag')) viewDiag(run).forEach(l => console.log(l));
    }
    // --changed-truth (design test C, dist/bus.ply + dist/bus-blur.ply):
    // accepting every suggestion hides >= 90 % of B's changed rows (the
    // blurred sphere) and <= 0.1 % of the others; the changed rows by what
    // the paint did with them, and why the others are no candidates
    if (changed) {
        const d = run.detail;
        const paintB = run.applied.paint[1];
        const stateOf = new Uint8Array(paintB.length), ringOf = new Uint8Array(paintB.length);
        run.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
            if (batch.loser !== 1) return;
            const st = run.results[ji].batches[bi].state;
            for (let q = 0; q < batch.rows.length; q++) {
                stateOf[batch.rows[q]] = st[q];
                ringOf[batch.rows[q]] = batch.ring[q];
            }
        }));
        const names = ['no candidate', 'hidden', 'uncovered', 'apart', 'no surface', 'held', 'haze'];
        const by = {};
        let inN = 0, inHidden = 0, outN = 0, outHidden = 0;
        const rc = run.cells[1].rowCell, rm = d.remap[1];
        const ringCells = new Set(d.regions.flatMap(r => Array.from(r.ring)));
        for (let i = 0; i < paintB.length; i++) {
            const v = paintB[i];
            const hiddenRow = !!v && !(v & 0x8000);
            if (!changed[i]) {
                outN++;
                if (hiddenRow) outHidden++;
                continue;
            }
            inN++;
            if (hiddenRow) inHidden++;
            let key = `${names[stateOf[i]]}${stateOf[i] ? (ringOf[i] ? ' (ring)' : ' (cell)') : ''}`;
            if (!stateOf[i]) {
                // why no candidate: outside every region and ring, a ring row
                // below the ring size, or a region cell that is not a hide
                // cell (L finer there)
                const g = rc[i] >= 0 ? rm[rc[i]] : -1;
                const h = g >= 0 ? d.sharedIndex[g] : -1;
                const where = g < 0 ? 'no cell' : d.regionOf[g] >= 0 ? 'region cell, not a hide cell' : ringCells.has(g) ? 'ring, below the ring size' : h < 0 ? `outside, ${d.present[g] ? 'not shared' : 'not present'}` : `outside, state ${Object.keys(D.CellState).find(k2 => D.CellState[k2] === d.state[h])}`;
                key += ` - ${where}`;
            }
            by[key] = (by[key] ?? 0) + 1;
        }
        const okIn = inHidden >= 0.9 * inN, okOut = outHidden <= 0.001 * outN;
        if (!okIn) pairFailed++;
        if (!okOut) pairFailed++;
        console.log(`${okIn ? 'ok  ' : 'MISS'} changed rows (the blurred sphere) hidden >= 90 %: ${inHidden} of ${inN} (${pct(inHidden / Math.max(1, inN))})`);
        console.log(`${okOut ? 'ok  ' : 'MISS'} unchanged rows hidden <= 0.1 %: ${outHidden} of ${outN} (${pct(outHidden / Math.max(1, outN))})`);
        console.log(`   changed rows by paint state: ${Object.entries(by).sort((x, y) => y[1] - x[1]).map(([k2, v]) => `${k2} ${v}`).join(', ')}`);
        // the changed rows against their source: footprint ratio and the
        // shift of the centre (the blur's position noise)
        const ratio = [], shift = [], alphaOf = [];
        for (let i = 0; i < paintB.length; i++) {
            if (!changed[i]) continue;
            ratio.push(Math.log2(rows[1].footprint[i] / rows[0].footprint[i]));
            shift.push(Math.hypot(rows[1].positions[i * 3] - rows[0].positions[i * 3], rows[1].positions[i * 3 + 1] - rows[0].positions[i * 3 + 1], rows[1].positions[i * 3 + 2] - rows[0].positions[i * 3 + 2]));
            alphaOf.push(rows[1].opacity[i] / 255);
        }
        const q3 = (v, f) => `${f(quantile(v, 0.25))} / ${f(quantile(v, 0.5))} / ${f(quantile(v, 0.75))}`;
        console.log(`   changed rows: footprint log2 ratio p25/p50/p75 ${q3(ratio, x => x.toFixed(2))}, centre shift ${q3(shift, len)}, opacity ${q3(alphaOf, x => x.toFixed(2))}`);
    }
    // --swap-check: the same pair with the scans in the other order must
    // give the same analysis with the scans swapped - general difference and
    // exposure negated exactly, the 'clearly finer' shares swapped, every
    // shared cell's state equal and its owner swapped, the same suggestions
    // (cells, numbers) with winner and loser swapped, the same rows hidden
    if (has('swap-check')) {
        const sw = runPipeline([rows[1], rows[0]], up);
        const d1 = run.detail, d2 = sw.detail;
        const p1 = d1.pairs[0], p2 = d2.pairs[0];
        const same = (x, y) => x === y || (Number.isNaN(x) && Number.isNaN(y));
        const neg = (x, y) => same(x, -y);
        const issues = [];
        if (!neg(p2.biasRaw, p1.biasRaw) || !neg(p2.bias, p1.bias)) issues.push(`general difference ${p1.biasRaw} / ${p2.biasRaw}`);
        if (!neg(p2.exposure, p1.exposure)) issues.push(`exposure ${p1.exposure} / ${p2.exposure}`);
        if (!same(p2.clearA, p1.clearB) || !same(p2.clearB, p1.clearA)) issues.push(`clearly finer ${p1.clearA}/${p1.clearB} vs ${p2.clearA}/${p2.clearB}`);
        let stateDiff = 0, ownerDiff = 0;
        if (d1.keys.length !== d2.keys.length || d1.state.length !== d2.state.length) issues.push('cell count');
        else {
            for (let h = 0; h < d1.state.length; h++) {
                if (d1.state[h] !== d2.state[h]) stateDiff++;
                const o1 = d1.owner[h], o2 = d2.owner[h];
                if ((o1 < 0 ? -1 : 1 - o1) !== o2) ownerDiff++;
            }
        }
        if (stateDiff || ownerDiff) issues.push(`cells with another state ${stateDiff}, another owner ${ownerDiff}`);
        let regionDiff = d1.regions.length === d2.regions.length ? 0 : 1;
        if (!regionDiff) {
            d1.regions.forEach((r, i) => {
                const q = d2.regions[i];
                const cellsSame = r.cells.length === q.cells.length && r.cells.every((g, j) => g === q.cells[j]);
                const numbers = r.perLoser.every((pl, j) => pl.hidden === q.perLoser[j].hidden && pl.kept === q.perLoser[j].kept);
                if (q.winner !== 1 - r.winner || !cellsSame || !numbers || r.confidence !== q.confidence) regionDiff++;
            });
        }
        if (regionDiff) issues.push(`suggestions ${d1.regions.length} / ${d2.regions.length}, different ${regionDiff}`);
        let rejectDiff = d1.rejected.length === d2.rejected.length ? 0 : 1;
        if (!rejectDiff) {
            const swapScan = s => (s < 0 ? s : 1 - s);
            d1.rejected.forEach((r, i) => {
                const q = d2.rejected[i];
                const cellsSame = r.cells.length === q.cells.length && r.cells.every((g, j) => g === q.cells[j]);
                if (q.reason !== r.reason || q.winner !== swapScan(r.winner) || q.loser !== swapScan(r.loser) || !cellsSame || !same(q.value, r.value) || q.gate !== r.gate) rejectDiff++;
            });
        }
        if (rejectDiff) issues.push(`rejected ${d1.rejected.length} / ${d2.rejected.length}, different ${rejectDiff}`);
        const paintSame = [0, 1].every(s => run.applied.paint[s].every((v, i) => v === sw.applied.paint[1 - s][i]));
        if (!paintSame) issues.push('per-row paint differs');
        const ok = !issues.length;
        if (!ok) pairFailed++;
        console.log(`${ok ? 'ok  ' : 'MISS'} swap-check (scans in the other order): general difference ${p1.biasRaw.toFixed(4)} / ${p2.biasRaw.toFixed(4)} oct, clearly finer ${pct(p1.clearA)} / ${pct(p1.clearB)} vs ${pct(p2.clearA)} / ${pct(p2.clearB)}, ` +
            `suggestions ${d1.regions.length} / ${d2.regions.length}, rejected ${d1.rejected.length} / ${d2.rejected.length}${issues.length ? `; differs: ${issues.join('; ')}` : '; states, owners, suggestions, rejected clusters and paint identical'}`);
    }
    // share of the shared area under suggestions
    const d = run.detail;
    let under = 0;
    d.regions.forEach((r) => {
        r.cells.forEach((g) => {
            if (d.sharedIndex[g] >= 0) under++;
        });
    });
    let apart = 0, uncovered = 0;
    for (let h = 0; h < d.state.length; h++) {
        if (d.state[h] === D.CellState.apart) apart++;
        if (d.state[h] === D.CellState.uncovered) uncovered++;
    }
    console.log(`   suggestions cover ${pct(under / Math.max(1, d.pairs[0].sharedCells))} of the shared cells; apart ${pct(apart / Math.max(1, d.state.length))}, uncovered ${pct(uncovered / Math.max(1, d.state.length))} of the shared cells`);
    // where the apart cells are: per axis, the sixths of the shared cells'
    // 1-99 % extent
    {
        const pos = [[], [], []];
        for (let h = 0; h < d.state.length; h++) {
            const v = core.decode(d.keys[d.shared[h]]);
            for (let a = 0; a < 3; a++) pos[a].push(v[a]);
        }
        const lines = [0, 1, 2].map((a) => {
            const lo = quantile(pos[a], 0.01), hi = quantile(pos[a], 0.99) + 1;
            const bins = [0, 0, 0, 0, 0, 0], all = [0, 0, 0, 0, 0, 0];
            for (let h = 0; h < d.state.length; h++) {
                const b = Math.max(0, Math.min(5, Math.floor((pos[a][h] - lo) / (hi - lo) * 6)));
                all[b]++;
                if (d.state[h] === D.CellState.apart) bins[b]++;
            }
            return `${'xyz'[a]} [${(lo * run.cell).toFixed(1)}, ${(hi * run.cell).toFixed(1)}] m: ${bins.join(' / ')} of ${all.join(' / ')}`;
        });
        console.log(`   apart cells per sixth along ${lines.join('; ')}`);
        // --apart-normals: along the longest horizontal axis, the apart
        // share per sixth of the cells whose surface (PCA of A's opaque rows
        // in the cell) faces along that axis and of the others. A scale
        // error moves surfaces along their normal by s (p - c0) . n: far
        // along the axis only those facing along it
        if (has('apart-normals')) {
            const ext = [0, 1, 2].map(a => quantile(pos[a], 0.99) - quantile(pos[a], 0.01));
            const axis = [0, 1, 2].filter(a => a !== up).sort((x, y) => ext[y] - ext[x])[0];
            const G = d.keys.length;
            const sums = new Float64Array(G * 10);
            const rc = run.cells[0].rowCell, rm = d.remap[0];
            const pa = rows[0].positions, op = rows[0].opacity;
            const ob = D.opacityByte(0.2);
            for (let i = 0; i < op.length; i++) {
                if (op[i] < ob || rc[i] < 0) continue;
                const g = rm[rc[i]], o = g * 10;
                const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
                sums[o]++;
                sums[o + 1] += x; sums[o + 2] += y; sums[o + 3] += z;
                sums[o + 4] += x * x; sums[o + 5] += x * y; sums[o + 6] += x * z;
                sums[o + 7] += y * y; sums[o + 8] += y * z; sums[o + 9] += z * z;
            }
            const lo = quantile(pos[axis], 0.01), hi = quantile(pos[axis], 0.99) + 1;
            const along = [0, 0, 0, 0, 0, 0], alongApart = [0, 0, 0, 0, 0, 0], across = [0, 0, 0, 0, 0, 0], acrossApart = [0, 0, 0, 0, 0, 0];
            for (let h = 0; h < d.state.length; h++) {
                const o = d.shared[h] * 10, n = sums[o];
                if (n < 10) continue;
                const m = [sums[o + 1] / n, sums[o + 2] / n, sums[o + 3] / n];
                const cv = [sums[o + 4] / n - m[0] * m[0], sums[o + 5] / n - m[0] * m[1], sums[o + 6] / n - m[0] * m[2], 0, sums[o + 7] / n - m[1] * m[1], sums[o + 8] / n - m[1] * m[2], 0, 0, sums[o + 9] / n - m[2] * m[2]];
                cv[3] = cv[1];
                cv[6] = cv[2];
                cv[7] = cv[5];
                const nrm = icp.smallestEigenvector(cv);
                const b = Math.max(0, Math.min(5, Math.floor((pos[axis][h] - lo) / (hi - lo) * 6)));
                const facing = Math.abs(nrm[axis]) >= 0.7;
                (facing ? along : across)[b]++;
                if (d.state[h] === D.CellState.apart) (facing ? alongApart : acrossApart)[b]++;
            }
            const share = (x, y) => x.map((v, i) => pct(v / Math.max(1, y[i]))).join(' / ');
            console.log(`   apart-normals along ${'xyz'[axis]}: cells facing along it ${share(alongApart, along)} (of ${along.join(' / ')}); facing across ${share(acrossApart, across)} (of ${across.join(' / ')})`);
        }
    }
    if (jsonOut) {
        writeFileSync(jsonOut, JSON.stringify({
            times: run.times,
            cell: run.cell,
            auto: run.auto,
            pairs: d.pairs,
            scans: d.scans,
            regions: d.regions.map(r => ({ ...r, cells: r.cells.length, ring: r.ring.length, hideCells: r.hideCells.map(h => h.length) })),
            rejected: d.rejected.map(r => ({ ...r, cells: r.cells.length })),
            diag: d.diag,
            cards: cardsOf(run)
        }, null, 1));
    }
    if (has('clear-diag')) cardsOf(run).forEach(q => console.log(`   clear-diag ${cardLine(q)}`));
    // the rejected clusters' values: apart = own separation (B6), partial =
    // the failed gate's share (B7)
    {
        const apartV = d.rejected.filter(r => r.reason === 'apart').map(r => r.value);
        const gates = {};
        // a partial cluster's value is its gate's share where that gate
        // failed: below the gate's weak threshold
        const limitOf = { cover: D.DETAIL.coverWeak, onsurf: D.DETAIL.onsurfWeak };
        const above = [];
        d.rejected.filter(r => r.reason === 'partial').forEach((r) => {
            gates[r.gate] = (gates[r.gate] ?? 0) + 1;
            if (!(r.value < limitOf[r.gate])) above.push(`${r.gate} ${r.value.toFixed(3)}`);
        });
        console.log(`   rejected apart values p10/p50/p90 ${len(quantile(apartV, 0.1))} / ${len(quantile(apartV, 0.5))} / ${len(quantile(apartV, 0.9))} of ${apartV.length} (apart limit ${len(D.DETAIL.apartSep * run.cell)}); partial clusters by gate ${JSON.stringify(gates)}`);
        if (above.length) pairFailed++;
        console.log(`${above.length ? 'MISS' : 'ok  '} partial clusters: value below the weak threshold of their gate (cover ${D.DETAIL.coverWeak}, onsurf ${D.DETAIL.onsurfWeak}): ${above.length ? `${above.length} not: ${above.join(', ')}` : 'all'}`);
        // a sparse cluster's value says why: W less dense than L (below the
        // weak density gate) - also for a region the loser check dropped
        // for its density (its value was the cells' pooled median, which
        // said the opposite on Steinbeis: 1.27)
        const sparseV = d.rejected.filter(r => r.reason === 'sparse');
        const dense = sparseV.filter(r => !(r.value < D.DETAIL.densityWeak)).map(r => `${r.cells.length} cells ${r.value.toFixed(3)}`);
        if (dense.length) pairFailed++;
        console.log(`${dense.length ? 'MISS' : 'ok  '} sparse clusters: value (density W / L) below ${D.DETAIL.densityWeak}: ${dense.length ? `${dense.length} of ${sparseV.length} not: ${dense.join(', ')}` : `all ${sparseV.length}`}`);
        // every strong cell is in a suggestion or a listed cluster (a raw
        // region too small for a loser is listed as 'small'), except those
        // of loserless regions below rejectMin cells, which are not listed
        const allowed = run.detail.diag?.loserlessStrong ?? 0;
        const okOrphan = run.orphanStrong === allowed;
        if (!okOrphan) pairFailed++;
        console.log(`${okOrphan ? 'ok  ' : 'MISS'} strong cells in no suggestion and no listed cluster = those of unlisted loserless regions (< rejectMin cells): ${run.orphanStrong} vs ${allowed}`);
    }
    // --force-check: 'Trotzdem übernehmen' on the largest texture / sparse
    // cluster, as compose-suggest does it (regionOf set before the paint)
    if (has('force-check')) {
        const target = d.rejected.find(r => (r.reason === 'texture' || r.reason === 'sparse') && r.winner >= 0);
        if (target) {
            const o = { ...PIPE, upAxis: up, upSign: 1, sceneSize: d.sceneSize };
            const region = D.forceRegion(run.cells, d, target, o);
            const before = new Set(d.regions.flatMap(r => Array.from(r.cells)));
            const overlap = Array.from(region.cells).filter(g => before.has(g)).length;
            d.regions.push(region);
            region.cells.forEach((g) => {
                if (d.regionOf[g] < 0) d.regionOf[g] = region.id;
            });
            const jobs = D.paintInputs(d, rows, run.cells.map(c => c.rowCell), { ...o, regions: [region], existing: run.applied.paint });
            const results = jobs.map(j => D.composePaint(j.cell, j.batches, o));
            // the apart clusters before, by identity (applyPaint sorts the
            // list by size, so new ones are not necessarily last)
            const apartBefore = new Set(d.rejected.filter(r => r.reason === 'apart'));
            D.applyPaint(d, jobs, results, { ...o, rowCounts: rows.map(r => r.footprint.length), paint: run.applied.paint });
            d.rejected = d.rejected.filter(r => r !== target);
            const added = d.rejected.filter(r => r.reason === 'apart' && !apartBefore.has(r));
            const kept = d.regions.includes(region);
            const inv = invariants(d);
            const ok = overlap === 0 && inv.ok && added.every(r => r.winner === region.winner);
            if (!ok) pairFailed++;
            console.log(`${ok ? 'ok  ' : 'MISS'} force-check: ${target.reason} cluster of ${target.cells.length} cells -> region #${region.id} with ${region.cells.length} cells (overlap with existing ${overlap}), ${kept ? `kept, hides ${region.perLoser[0].hidden} keeps ${region.perLoser[0].kept}` : 'dropped as apart'}; apart clusters from its paint ${added.length} (winner ${added.map(r => r.winner + 1).join(',') || '-'}); ${inv.text}`);
        } else {
            console.log('   force-check: no texture / sparse cluster');
        }
    }
    process.exit(pairFailed ? 1 : 0);
}

if (has('lod')) {
    const dir = option('lod');
    const t0 = now();
    const L0 = splatsOf(readPly(join(dir, 'point_cloud.ply')));
    const L1 = splatsOf(readPly(join(dir, 'point_cloud_1.ply')));
    const L3 = splatsOf(readPly(join(dir, 'point_cloud_3.ply')));
    const up = option('up', null) ? 'xyz'.indexOf(option('up')) : upOf(L0.pos);
    console.log(`LOD0 ${L0.n.toLocaleString()}, LOD1 ${L1.n.toLocaleString()}, LOD3 ${L3.n.toLocaleString()} splats, read ${((now() - t0) / 1000).toFixed(1)} s, up ${'xyz'[up]}`);
    // the two densest 2 m spots of LOD0, at least 8 m apart
    const counts = new Map();
    for (let i = 0; i < L0.n; i++) {
        if (L0.alpha[i] < 0.2) continue;
        const k = keyOf(Math.floor(L0.pos[i * 3] / 2), Math.floor(L0.pos[i * 3 + 1] / 2), Math.floor(L0.pos[i * 3 + 2] / 2));
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const centreOf = ([k]) => core.decode(k).map(v => (v + 0.5) * 2);
    const box1 = centreOf(ranked[0]);
    const box2 = centreOf(ranked.find(e => Math.hypot(...centreOf(e).map((v, a) => v - box1[a])) >= 8));
    const inBox = (p, i, b) => Math.abs(p[i * 3] - b[0]) <= 1 && Math.abs(p[i * 3 + 1] - b[1]) <= 1 && Math.abs(p[i * 3 + 2] - b[2]) <= 1;
    console.log(`box 1 at ${box1.join(', ')} (${ranked[0][1]} opaque LOD0 splats), box 2 at ${box2.join(', ')}`);
    // scans: A = LOD1 + LOD0 in box 1 + LOD3 in box 2; B the other way round,
    // then moved by 2 cm and 0.1 degrees
    const build = (fine, coarse) => {
        const pos = [], sigma = [], alpha = [], rgb = [], label = [];
        const add = (S, i, l) => {
            pos.push(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]);
            sigma.push(D.footprintOf(S.scale[i * 3], S.scale[i * 3 + 1], S.scale[i * 3 + 2]));
            alpha.push(S.alpha[i]);
            rgb.push(S.rgb[i * 3], S.rgb[i * 3 + 1], S.rgb[i * 3 + 2]);
            label.push(l);
        };
        for (let i = 0; i < L1.n; i++) if (!inBox(L1.pos, i, box1) && !inBox(L1.pos, i, box2)) add(L1, i, 0);
        for (let i = 0; i < L0.n; i++) if (inBox(L0.pos, i, fine)) add(L0, i, 1);
        for (let i = 0; i < L3.n; i++) if (inBox(L3.pos, i, coarse)) add(L3, i, 3);
        return { pos: new Float32Array(pos), sigma: new Float32Array(sigma), alpha: new Float32Array(alpha), rgb: new Float32Array(rgb), label: new Uint8Array(label) };
    };
    const A = build(box1, box2);
    const B = build(box2, box1);
    const truthB = B.pos.slice();
    {
        const angle = 0.1 * Math.PI / 180;
        const axes = [0, 1, 2].filter(a => a !== up);
        const cx = (box1[axes[0]] + box2[axes[0]]) / 2, cy = (box1[axes[1]] + box2[axes[1]]) / 2;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        for (let i = 0; i < B.alpha.length; i++) {
            const x = B.pos[i * 3 + axes[0]] - cx, y = B.pos[i * 3 + axes[1]] - cy;
            B.pos[i * 3 + axes[0]] = cx + ca * x - sa * y + 0.02 / Math.SQRT2;
            B.pos[i * 3 + axes[1]] = cy + sa * x + ca * y + 0.02 / Math.SQRT2;
        }
    }
    const rows = [compactOf(A.pos, A.sigma, A.alpha, A.rgb), compactOf(B.pos, B.sigma, B.alpha, B.rgb)];
    const run = runPipeline(rows, up);
    reportReal('LOD truth', run, ['A', 'B']);
    const hidden = hiddenOf(run);
    const c = run.cell;
    const regions = run.detail.regions;
    const scansT = [{ S: A, truth: A.pos, box: [box1, box2] }, { S: B, truth: truthB, box: [box2, box1] }];
    let hiddenTotal = 0, wrong = 0, outsideRows = 0, outsideHidden = 0;
    const boxShare = [];
    // per card: hidden rows, neutral (LOD1 rows: both scans are LOD1 there),
    // wrong
    const truthBy = new Map();
    scansT.forEach(({ S, truth }, s) => {
        const h = hidden[s];
        for (let i = 0; i < S.alpha.length; i++) {
            const inside1 = inBox(truth, i, box1), inside2 = inBox(truth, i, box2);
            // more than one cell outside both boxes
            const far = [box1, box2].every(b => [0, 1, 2].some(a => Math.abs(truth[i * 3 + a] - b[a]) > 1 + c));
            if (far) {
                outsideRows++;
                if (h[i] >= 0) outsideHidden++;
            }
            if (h[i] < 0) continue;
            hiddenTotal++;
            // wrong: the fine version hidden, or a row hidden by a winner that
            // is coarse there
            const W = regions.find(r => r.id === h[i]).winner;
            const winnerCoarse = (W === 0 && inside2) || (W === 1 && inside1);
            const t = truthBy.get(h[i]) ?? { hidden: 0, neutral: 0, wrong: 0 };
            truthBy.set(h[i], t);
            t.hidden++;
            if (S.label[i] === 1 || winnerCoarse) {
                wrong++;
                t.wrong++;
            } else if (S.label[i] === 0) t.neutral++;
        }
    });
    const lodCards = cardsOf(run, truthBy);
    if (has('clear-diag')) lodCards.forEach(q => console.log(`   clear-diag ${cardLine(q)}`));
    [[box1, 0, 1], [box2, 1, 0]].forEach(([b, W, L], bi) => {
        const S = scansT[L].S, truth = scansT[L].truth;
        let coarse = 0, hid = 0;
        const by = new Map();
        for (let i = 0; i < S.alpha.length; i++) {
            if (S.label[i] !== 3 || !inBox(truth, i, b)) continue;
            coarse++;
            const id = hidden[L][i];
            if (id >= 0) {
                hid++;
                by.set(id, (by.get(id) ?? 0) + 1);
            }
        }
        const top = [...by.entries()].sort((x, y) => y[1] - x[1])[0];
        const region = top ? regions.find(r => r.id === top[0]) : null;
        boxShare.push({ box: bi + 1, coarse, hidden: hid, share: coarse ? hid / coarse : 0, winnerOk: region?.winner === W, suggestions: by.size });
        if (verbose) {
            // the coarse rows not hidden: kept by the paint (its state) or
            // not a candidate (the state of their cell)
            const at = new Map();
            run.jobs.forEach((job, ji) => job.batches.forEach((batch, bj) => {
                if (batch.loser !== L) return;
                const r = run.results[ji].batches[bj];
                batch.rows.forEach((row, q) => at.set(row, r.state[q]));
            }));
            const why = {};
            const d = run.detail;
            for (let i = 0; i < S.alpha.length; i++) {
                if (S.label[i] !== 3 || !inBox(truth, i, b) || hidden[L][i] >= 0) continue;
                let key;
                if (at.has(i)) key = `kept ${['', 'hidden', 'uncovered', 'apart', 'no surface', 'held', 'haze'][at.get(i)]}`;
                else {
                    const lc = run.cells[L].rowCell[i];
                    const g = lc >= 0 ? d.remap[L][lc] : -1;
                    const h = g >= 0 ? d.sharedIndex[g] : -1;
                    key = `no candidate: ${h < 0 ? 'not shared' : `state ${d.state[h]}${d.regionOf[g] >= 0 ? ' in a region' : ''}`}`;
                }
                why[key] = (why[key] ?? 0) + 1;
            }
            console.log(`   box ${bi + 1} coarse rows not hidden: ${JSON.stringify(why)}`);
            // the tie cells holding such rows: their region neighbours and
            // surface neighbours (closing), the cell's own lead and counts
            const tieCells = new Map();
            for (let i = 0; i < S.alpha.length; i++) {
                if (S.label[i] !== 3 || !inBox(truth, i, b) || hidden[L][i] >= 0 || at.has(i)) continue;
                const lc = run.cells[L].rowCell[i];
                const g = lc >= 0 ? d.remap[L][lc] : -1;
                const h = g >= 0 ? d.sharedIndex[g] : -1;
                if (h < 0 || d.state[h] !== D.CellState.tie) continue;
                tieCells.set(g, (tieCells.get(g) ?? 0) + 1);
            }
            const lines = [];
            [...tieCells.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).forEach(([g, rowsHere]) => {
                const nb = [];
                const [x, y, z] = core.decode(d.keys[g]);
                let inR = 0, surf = 0;
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            if (!dx && !dy && !dz) continue;
                            const k2 = keyOf(x + dx, y + dy, z + dz);
                            let lo2 = 0, hi2 = d.keys.length;
                            while (lo2 < hi2) {
                                const mid = (lo2 + hi2) >>> 1;
                                if (d.keys[mid] < k2) lo2 = mid + 1;
                                else hi2 = mid;
                            }
                            if (lo2 < d.keys.length && d.keys[lo2] === k2 && d.present[lo2]) {
                                surf++;
                                if (d.regionOf[lo2] >= 0) inR++;
                                nb.push(lo2);
                            }
                        }
                    }
                }
                const own = [W, L].map((s) => {
                    const i2 = run.cells[s].keys.indexOf(d.keys[g]);
                    if (i2 < 0) return { n: 0, m: NaN };
                    const hist = run.cells[s].hist.subarray(i2 * 24, i2 * 24 + 24);
                    let tot = 0;
                    for (const v of hist) tot += v;
                    let acc = 0, m = NaN;
                    for (let q = 0; q < 24; q++) {
                        if (hist[q] && acc + hist[q] >= tot / 2) {
                            m = -10 + (q + (tot / 2 - acc) / hist[q]) * 0.5;
                            break;
                        }
                        acc += hist[q];
                    }
                    return { n: run.cells[s].n[i2], m };
                });
                lines.push(`${rowsHere} rows: region neighbours ${inR} of ${surf}, own lead ${(own[1].m - own[0].m).toFixed(2)} oct (n ${own[0].n} / ${own[1].n}), pooled sizes ${len(d.size[d.sharedIndex[g] * 2 + W])} / ${len(d.size[d.sharedIndex[g] * 2 + L])}`);
            });
            console.log(`   box ${bi + 1} tie cells with its coarse rows (${tieCells.size}): ${lines.join('; ')}`);
        }
    });
    // coverage of LOD0 surface points by the visible rows of both scans
    const loss = coverageLoss(
        (() => {
            const ids = [];
            const step = Math.max(1, Math.floor(L0.n / 300000));
            for (let i = 0; i < L0.n; i += step) if (L0.alpha[i] >= 0.2) ids.push(i);
            return { pos: L0.pos, ids };
        })(),
        [{ pos: A.pos, sigma: A.sigma, alpha: A.alpha, hidden: hidden[0] }, { pos: B.pos, sigma: B.sigma, alpha: B.alpha, hidden: hidden[1] }]
    );
    const checks = [
        ['box 1: one suggestion A replaces B, hides >= 70 % of its coarse rows', boxShare[0].winnerOk && boxShare[0].share >= 0.7, `${pct(boxShare[0].share)} of ${boxShare[0].coarse} (${boxShare[0].suggestions} suggestion(s))`],
        ['box 2: one suggestion B replaces A, hides >= 70 % of its coarse rows', boxShare[1].winnerOk && boxShare[1].share >= 0.7, `${pct(boxShare[1].share)} of ${boxShare[1].coarse} (${boxShare[1].suggestions} suggestion(s))`],
        ['wrong hidden rows <= 1 %', wrong <= 0.01 * hiddenTotal, `${wrong} of ${hiddenTotal} (${pct(wrong / Math.max(1, hiddenTotal))})`],
        ['hidden rows > 1 cell outside the boxes <= 0.5 % of the outside rows', outsideHidden <= 0.005 * outsideRows, `${outsideHidden} of ${outsideRows} (${pct(outsideHidden / Math.max(1, outsideRows))})`],
        ['coverage loss <= 0.2 pp', loss.loss <= 0.002, `${(loss.loss * 100).toFixed(3)} pp (before ${pct(loss.before)})`],
        ['invariants', invariants(run.detail).ok, invariants(run.detail).text],
        ['paint invariant', paintInvariant(run).ok, paintInvariant(run).text],
        ['free views', viewCheck(run).ok, viewCheck(run).text]
    ];
    let failed = 0;
    checks.forEach(([name, ok, value]) => {
        if (!ok) failed++;
        console.log(`${ok ? 'ok  ' : 'MISS'} ${name}: ${value}`);
    });
    if (has('view-diag')) viewDiag(run).forEach(l => console.log(l));
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ times: run.times, cell: run.cell, checks, boxShare, regions: run.detail.regions.map(r => ({ ...r, cells: r.cells.length, ring: r.ring.length, hideCells: r.hideCells.map(h => h.length) })), diag: run.detail.diag, cards: lodCards }, null, 1));
    process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- coverage

// share of truth points covered by visible opaque rows (within max(1.5 cm,
// the row's sigma, at most 25 cm)) before and after hiding
function coverageLoss(truth, scans, subset = null) {
    const k = COVER_SIGMA;
    const classes = [[0, 0.015, 0.015], [0.015, 0.06, 0.06], [0.06, 0.25, 0.25]];
    const grids = classes.map(([lo, hi, size]) => scans.map((s) => {
        const ids = [];
        for (let i = 0; i < s.alpha.length; i++) {
            if (s.alpha[i] < 0.2) continue;
            const r = Math.max(0.015, Math.min(0.25, k * s.sigma[i]));
            if (r > lo && r <= hi) ids.push(i);
        }
        return new Grid(s.pos, ids, size);
    }));
    let before = 0, after = 0, n = 0;
    const flags = { before: false, after: false };
    const use = subset ?? truth.ids;
    for (const i of use) {
        const x = truth.pos[i * 3], y = truth.pos[i * 3 + 1], z = truth.pos[i * 3 + 2];
        flags.before = false;
        flags.after = false;
        for (let c = 0; c < classes.length && !flags.after; c++) {
            for (let s = 0; s < scans.length && !flags.after; s++) {
                const S = scans[s];
                grids[c][s].near(x, y, z, classes[c][1], (j, d2) => {
                    const r = Math.max(0.015, Math.min(0.25, k * S.sigma[j]));
                    if (d2 > r * r) return false;
                    flags.before = true;
                    if (S.hidden[j] < 0) {
                        flags.after = true;
                        return true;
                    }
                    return false;
                });
            }
        }
        n++;
        if (flags.before) before++;
        if (flags.after) after++;
    }
    return { before: before / Math.max(1, n), after: after / Math.max(1, n), loss: (before - after) / Math.max(1, n), points: n };
}

// ---------------------------------------------------------------- synthetic

const file = positional[0];
if (!file) {
    console.log('usage: node scripts/test-compose-detail.mjs <scan.ply> [options] | --lod <dir> | --pair <a.ply> <b.ply> [--matrix m]');
    process.exit(2);
}
// --layers K: K overlapping scans of the whole source (see the header)
const layersN = option('layers', null) ? parseInt(option('layers'), 10) : 0;
const layerShift = parseFloat(option('layer-shift', '0.06'));
// --layer-case: paths of applyPaint and loserCheck the default layers case
// does not reach, each with a check that requires the path (a region whose
// cells all leave is a --unit case: in the layers scene 16 of the 81 cells
// of ball 2's region are no hide cells of the shifted layer, so some stay):
// - drop: the last layer lies off over the whole of ball 2 (and a cell
//   beyond), so that ball's region (2+ losers) is dropped as apart, named
//   after the shifted layer - not its first loser;
// - rebuild: --twin with the unconfirmed pooled lead (confirm 0), where a
//   region takes a loser that is not coarser over its hide cells and
//   loserCheck rebuilds it with the rest (with 4 layers: 1 of 3 seeds;
//   required once over the cases)
const layerCase = option('layer-case', null);
if (layerCase && !['drop', 'rebuild'].includes(layerCase)) throw new Error('--layer-case drop|rebuild');
if (layerCase === 'rebuild') Object.assign(PIPE, { confirm: 0 });
// the shifted patch of ball 2 (--layers): 45 cm, or the ball and a cell
// beyond for drop
const shiftRadius = parseFloat(option('shift-radius', layerCase === 'drop' ? '1.3' : '0.45'));
const pieceArg = option('pieces', null);
const pieceCounts = layersN ? [layersN] : pieceArg ? pieceArg.split(',').map(Number) : [2, 3, 4];
const caseCount = parseInt(option('cases', '6'), 10);
const seed0 = parseInt(option('seed', '1'), 10);
const maxPoints = parseInt(option('points', '2000000'), 10);
const coarseMode = option('coarse', layersN ? 'none' : 'blur');
const focus = has('focus') || layersN > 0;
const onesided = has('onesided');
const holes = has('holes');
const budget = option('budget', null) ? parseFloat(option('budget')) : null;
const fogN = parseInt(option('fog', '0'), 10);
const floaterN = parseInt(option('floaters', '0'), 10);
const exposure = option('exposure', null) ? parseFloat(option('exposure')) : null;
const offset = option('offset', null) ? parseFloat(option('offset')) : null;
const scaleF = option('scale', null) ? parseFloat(option('scale')) : null;
const twin = has('twin');
const aligned = option('aligned', 'truth');
const paintDir = option('paint', null);
const [driftMin, driftMax] = option('drift', '0.05,0.2').split(',').map(Number);
const variant = fogN || floaterN || exposure !== null || offset !== null || scaleF !== null;

const tRead = now();
const ply = readPly(file);
const stride = Math.max(1, Math.ceil(ply.count / maxPoints));
const SRC = splatsOf(ply, stride);
const N = SRC.n;
const srcSigma = new Float32Array(N);
for (let i = 0; i < N; i++) srcSigma[i] = D.footprintOf(SRC.scale[i * 3], SRC.scale[i * 3 + 1], SRC.scale[i * 3 + 2]);
const P = SRC.pos;
const box = core.robustBox(P);
const sizes = [0, 1, 2].map(k => box.max[k] - box.min[k]);
const up = sizes.indexOf(Math.min(...sizes));
const main = [0, 1, 2].filter(k => k !== up).sort((a, b) => sizes[b] - sizes[a])[0];
const trans = [0, 1, 2].find(k => k !== up && k !== main);
const L = sizes[main];
// mean colour of the 5 cm voxel per source splat (the blur's lost texture)
const voxelColour = (() => {
    const sums = new Map();
    const keyAt = i => keyOf(Math.floor(P[i * 3] / 0.05), Math.floor(P[i * 3 + 1] / 0.05), Math.floor(P[i * 3 + 2] / 0.05));
    const keys = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const k = keyAt(i);
        keys[i] = k;
        let s = sums.get(k);
        if (!s) {
            s = [0, 0, 0, 0];
            sums.set(k, s);
        }
        s[0] += SRC.rgb[i * 3];
        s[1] += SRC.rgb[i * 3 + 1];
        s[2] += SRC.rgb[i * 3 + 2];
        s[3]++;
    }
    const out = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const s = sums.get(keys[i]);
        out[i * 3] = s[0] / s[3];
        out[i * 3 + 1] = s[1] / s[3];
        out[i * 3 + 2] = s[2] / s[3];
    }
    return out;
})();
console.log(`${file}: ${ply.count.toLocaleString()} splats, ${N.toLocaleString()} used (stride ${stride}), size ${sizes.map(s => s.toFixed(1)).join(' x ')} m (main ${'xyz'[main]}, up ${'xyz'[up]}), read ${((now() - tRead) / 1000).toFixed(1)} s`);

const ST = { outside: 0, normal: 1, coarse: 2, focusFine: 3, focusCoarse: 4, dropped: 5, holed: 6, budget: 7, fog: 8, floater: 9 };
const RANK = [0, 3, 1, 3, 1, 0, 0, 2];
const unit = k => [0, 1, 2].map(i => (i === k ? 1 : 0));
const rotation = (axis, angle) => {
    const [x, y, z] = axis;
    const c = Math.cos(angle), s = Math.sin(angle), v = 1 - c;
    return [c + x * x * v, x * y * v - z * s, x * z * v + y * s, y * x * v + z * s, c + y * y * v, y * z * v - x * s, z * x * v - y * s, z * y * v + x * s, c + z * z * v];
};
const mul3 = (a, b) => {
    const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return r;
};

// is the surface at a source splat horizontal (normal within 37 degrees of
// up, PCA of the opaque source splats within 4 cm)? cached per splat
let flatCache = null;
const horizontalOf = () => {
    if (!flatCache) {
        const ids = [];
        for (let i = 0; i < N; i++) if (SRC.alpha[i] >= 0.2) ids.push(i);
        flatCache = { grid: new Grid(P, ids, 0.04), memo: new Int8Array(N).fill(-1) };
    }
    const { grid, memo } = flatCache;
    return (i) => {
        if (memo[i] >= 0) return memo[i] === 1;
        const pts = [];
        grid.near(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0.04, (j) => {
            pts.push(P[j * 3], P[j * 3 + 1], P[j * 3 + 2]);
            return false;
        });
        let flat = false;
        const n = pts.length / 3;
        if (n >= 5) {
            const m = [0, 0, 0];
            for (let q = 0; q < n; q++) for (let a = 0; a < 3; a++) m[a] += pts[q * 3 + a] / n;
            const c = new Array(9).fill(0);
            for (let q = 0; q < n; q++) {
                const d = [0, 1, 2].map(a => pts[q * 3 + a] - m[a]);
                for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) c[a * 3 + b] += d[a] * d[b];
            }
            const nrm = icp.smallestEigenvector(c);
            flat = Math.abs(nrm[up]) >= 0.8;
        }
        memo[i] = flat ? 1 : 0;
        return flat;
    };
};

// --layers: n scans of the whole source with their own drift and no coarse
// stretch. Ball 1 at the densest 20 cm cell, ball 2 at the densest one at
// least 4 m away on a plane across up (45 cm, see planeAt); both fine in
// layer 1 (and its twin) and blur-coarse in every other layer, so each is
// one suggestion with several losers. In ball 2 the last layer lies 6 cm
// off that plane within 45 cm of its centre: off the winner's surface, a
// few cells - an apart cluster inside a kept region
const makeLayers = (seed, n) => {
    const random = rng(seed * 7919 + n * 104729 + 17);
    const pieces = [];
    for (let k = 0; k < n; k++) {
        const centre = [0, 1, 2].map(a => (box.min[a] + box.max[a]) / 2);
        const bend = () => (driftMin + random() * (driftMax - driftMin)) * Math.PI / 180 * (random() < 0.5 ? -1 : 1);
        const yaw = bend(), pitch = bend();
        pieces.push({ k, lo: box.min[main] - 1, hi: box.max[main] + 1, centre, yaw, pitch, coarseLo: Infinity, coarseHi: -Infinity, seed: Math.floor(random() * 1e9) });
    }
    // opaque source splats per 20 cm cell (every second one)
    const byCell = new Map();
    for (let i = 0; i < N; i += 2) {
        if (SRC.alpha[i] < 0.2) continue;
        const key = keyOf(Math.floor(P[i * 3] / 0.2), Math.floor(P[i * 3 + 1] / 0.2), Math.floor(P[i * 3 + 2] / 0.2));
        let list = byCell.get(key);
        if (!list) {
            list = [];
            byCell.set(key, list);
        }
        list.push(i);
    }
    const ranked = [...byCell.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
    const centreOf = key => core.decode(key).map(v => (v + 0.5) * 0.2);
    const c1 = centreOf(ranked[0][0]);
    // a plane across up within r of a centre, with little else within 20 cm
    // of it (so the shifted layer lies off every winner surface there): of
    // the opaque source splats within r across and 30 cm along up, at least
    // 90 % within 3 cm of their median height and at most 4 % between 4 and
    // 20 cm from it (the bus roof: 95 % and 2-3 %). Returns the side (+1 /
    // -1 along up) with fewer of those, 0 when it is no such plane
    const planeAt = (c, r) => {
        const [ix, iy, iz] = c.map(v => Math.floor(v / 0.2));
        const heights = [];
        const span = Math.ceil(Math.max(r, 0.3) / 0.2);
        for (let dx = -span; dx <= span; dx++) {
            for (let dy = -span; dy <= span; dy++) {
                for (let dz = -span; dz <= span; dz++) {
                    for (const i of byCell.get(keyOf(ix + dx, iy + dy, iz + dz)) ?? []) {
                        let across = 0;
                        for (let k = 0; k < 3; k++) if (k !== up) across += (P[i * 3 + k] - c[k]) ** 2;
                        const along = P[i * 3 + up] - c[up];
                        if (across < r * r && Math.abs(along) < 0.3) heights.push(along);
                    }
                }
            }
        }
        if (heights.length < 200) return 0;
        const m = quantile(heights, 0.5);
        let close = 0, above = 0, below = 0;
        for (const v of heights) {
            const d = Math.abs(v - m);
            if (d <= 0.03) close++;
            else if (d > 0.04 && d < 0.2) {
                if (v > m) above++;
                else below++;
            }
        }
        if (close < 0.9 * heights.length || above + below > 0.04 * heights.length) return 0;
        return above <= below ? 1 : -1;
    };
    let c2 = null, side = 1;
    for (const [key] of ranked.slice(0, 20000)) {
        const c = centreOf(key);
        if (Math.hypot(c[0] - c1[0], c[1] - c1[1], c[2] - c1[2]) < 4) continue;
        side = planeAt(c, 0.45);
        if (side) {
            c2 = c;
            break;
        }
    }
    const others = [];
    for (let k = 1; k < n; k++) if (!(twin && k === 1)) others.push(k);
    const ballOf = (index, c) => ({ index, pair: [0, ...others], centre: c, r: 1, focus: 0, other: others[0], others, winners: twin ? [0, 1] : [0], onesided: false, holes: [] });
    const balls = [ballOf(0, c1)];
    if (c2) balls.push(ballOf(1, c2));
    // towards the plane's emptier side, by --layer-shift (default 6 cm:
    // beyond c / 5 at the 25 cm auto grid, and within the paint's widened
    // reach - farther the coarse layer's candidates find no winner surface
    // at all and their cells are uncovered, kept as well but not apart)
    const shift = c2 ? { layer: n - 1, centre: c2, r: shiftRadius, d: layerShift * side } : null;
    return { seed, n, overlap: 1, pieces, balls, shift };
};

// the shift of the last layer in ball 2 (--layers), flagged per row
const applyShift = (cs, rowsArr) => {
    if (!cs.shift) return;
    const { layer, centre, r, d } = cs.shift;
    const rows = rowsArr[layer];
    rows.shifted = new Uint8Array(rows.alpha.length);
    for (let j = 0; j < rows.base; j++) {
        const i = rows.src[j];
        if (Math.hypot(P[i * 3] - centre[0], P[i * 3 + 1] - centre[1], P[i * 3 + 2] - centre[2]) >= r) continue;
        rows.pos[j * 3 + up] += d;
        rows.shifted[j] = 1;
    }
};

const makeCase = (seed, n) => {
    if (layersN) return makeLayers(seed, n);
    const random = rng(seed * 7919 + n * 104729 + 13);
    const overlap = 0.25 + random() * 0.15;
    const plen = L / (n - (n - 1) * overlap);
    const stepLen = plen * (1 - overlap);
    const pieces = [];
    for (let k = 0; k < n; k++) {
        const lo = box.min[main] + k * stepLen;
        const hi = lo + plen;
        const centre = [0, 0, 0];
        centre[main] = (lo + hi) / 2;
        centre[up] = (box.min[up] + box.max[up]) / 2;
        centre[trans] = (box.min[trans] + box.max[trans]) / 2;
        const bend = () => (driftMin + random() * (driftMax - driftMin)) * Math.PI / 180 * (random() < 0.5 ? -1 : 1);
        const yaw = bend(), pitch = bend();
        const coarseLo = lo + random() * plen * 0.75;
        pieces.push({ k, lo, hi, centre, yaw, pitch, coarseLo, coarseHi: coarseLo + plen * 0.25, seed: Math.floor(random() * 1e9) });
    }
    // focus balls: in every overlap, at its densest 20 cm cell outside both
    // coarse stretches
    const balls = [];
    if (focus) {
        for (let b = 0; b + 1 < n; b++) {
            const pa = pieces[b], pb = pieces[b + 1];
            const ovLo = pb.lo, ovHi = pa.hi;
            const r = 1;
            // inside the overlap by r; outside both coarse stretches by r, else
            // with its centre outside them (the design's rule); no ball when
            // the stretches fill the overlap
            const clear = (m, margin) => [pa, pb].every(p => (coarseMode === 'none') || m + margin < p.coarseLo || m - margin > p.coarseHi);
            let best = null;
            for (const margin of [r, 0]) {
                const counts = new Map();
                for (let i = 0; i < N; i += 2) {
                    const m = P[i * 3 + main];
                    if (m < ovLo + r || m > ovHi - r || SRC.alpha[i] < 0.2 || !clear(m, margin)) continue;
                    const key = keyOf(Math.floor(P[i * 3] / 0.2), Math.floor(P[i * 3 + 1] / 0.2), Math.floor(P[i * 3 + 2] / 0.2));
                    counts.set(key, (counts.get(key) ?? 0) + 1);
                }
                let top = -1;
                for (const [key, v] of counts) {
                    if (v > top || (v === top && key < best)) {
                        top = v;
                        best = key;
                    }
                }
                if (top > 0) break;
                best = null;
            }
            if (best === null) continue;
            const c = core.decode(best).map(v => (v + 0.5) * 0.2);
            const focusPiece = b % 2 === 0 ? b : b + 1;
            const ball = { index: b, pair: [b, b + 1], centre: c, r, focus: focusPiece, other: focusPiece === b ? b + 1 : b, onesided: onesided && b % 2 === 0, holes: [] };
            if (holes) {
                const hr = rng(seed * 31 + b * 7 + 5);
                for (let tries = 0; ball.holes.length < 4 && tries < 200000; tries++) {
                    const i = Math.floor(hr() * N);
                    const d = Math.hypot(P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]);
                    if (d > 0.8 * r || SRC.alpha[i] < 0.2) continue;
                    if (ball.onesided && P[i * 3 + main] - c[main] < 0.15) continue;
                    ball.holes.push({ centre: [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], r: 0.05 + hr() * 0.1 });
                }
            }
            balls.push(ball);
        }
    }
    return { seed, n, overlap, pieces, balls };
};

// state of every source splat in every piece
const statesOf = cs => cs.pieces.map((piece, k) => {
    const out = new Uint8Array(N);
    const src = twin && k === 1 ? cs.pieces[0] : piece;
    for (let i = 0; i < N; i++) {
        const m = P[i * 3 + main];
        if (m < src.lo || m > src.hi) continue;
        let st = coarseMode !== 'none' && m >= src.coarseLo && m <= src.coarseHi ? ST.coarse : budget !== null && k === 0 ? ST.budget : ST.normal;
        for (const b of cs.balls) {
            const kk = twin && k === 1 ? 0 : k;
            if (b.focus !== kk && !(b.others ?? [b.other]).includes(kk)) continue;
            const dx = P[i * 3] - b.centre[0], dy = P[i * 3 + 1] - b.centre[1], dz = P[i * 3 + 2] - b.centre[2];
            if (dx * dx + dy * dy + dz * dz >= b.r * b.r) continue;
            if (b.focus === kk) {
                st = ST.focusFine;
                if (b.onesided && P[i * 3 + main] - b.centre[main] < 0) st = ST.dropped;
                else if (b.holes.some(h => Math.hypot(P[i * 3] - h.centre[0], P[i * 3 + 1] - h.centre[1], P[i * 3 + 2] - h.centre[2]) < h.r)) st = ST.holed;
            } else {
                st = ST.focusCoarse;
            }
        }
        out[i] = st;
    }
    return out;
});

// rows of every piece: positions, sigma, alpha, colour, scale, rotation,
// source index (-1: fog / floater), label
const piecesOf = (cs, states, extras) => cs.pieces.map((piece, k) => {
    const random = rng(twin && k === 1 ? cs.pieces[0].seed : piece.seed);
    // the twin copies piece 0 row for row, with fresh 3 mm noise
    const fresh = twin && k === 1 ? rng(piece.seed) : null;
    const st = states[k];
    const pos = [], sigma = [], alpha = [], rgb = [], factor = [], src = [], label = [];
    const v = unit(up), t = unit(trans);
    const geo = twin && k === 1 ? cs.pieces[0] : piece;
    const bendAt = (d) => {
        const s = d[main] / (geo.hi - geo.lo);
        return mul3(rotation(v, geo.yaw * s), rotation(t, geo.pitch * s));
    };
    for (let i = 0; i < N; i++) {
        const state = st[i];
        if (state === ST.outside) continue;
        const u = random(), n1 = random(), n2 = random(), n3 = random(), g1 = random(), g2 = random(), g3 = random(), g4 = random();
        let keep = state === ST.focusFine ? 1 : state === ST.dropped || state === ST.holed ? 0 : 0.7;
        const budgetHere = budget !== null && k === 0 && state !== ST.focusFine;
        if (budgetHere) keep *= budget;
        const coarse = (state === ST.coarse && coarseMode !== 'none') || state === ST.focusCoarse;
        if (coarse) keep /= 6;
        if (u >= keep) continue;
        let f = budgetHere ? 1 / Math.sqrt(budget) : 1;
        const blur = coarse && (coarseMode === 'blur' || state === ST.focusCoarse);
        const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
        let colour = [SRC.rgb[i * 3], SRC.rgb[i * 3 + 1], SRC.rgb[i * 3 + 2]];
        if (blur) {
            f *= Math.sqrt(6);
            colour = [voxelColour[i * 3], voxelColour[i * 3 + 1], voxelColour[i * 3 + 2]];
            const sd = Math.min(0.3 * srcSigma[i] * f, 0.02);
            p[0] += sd * gauss(g1, g2);
            p[1] += sd * gauss(g2, g3);
            p[2] += sd * gauss(g3, g4);
        }
        // drift about the piece centre, then 3 mm noise
        const d = [p[0] - geo.centre[0], p[1] - geo.centre[1], p[2] - geo.centre[2]];
        const R = bendAt(d);
        const q = [0, 1, 2].map(a => R[a * 3] * d[0] + R[a * 3 + 1] * d[1] + R[a * 3 + 2] * d[2] + geo.centre[a]);
        const [e1, e2, e3] = fresh ? [fresh(), fresh(), fresh()] : [n1, n2, n3];
        pos.push(q[0] + (e1 - 0.5) * 0.006, q[1] + (e2 - 0.5) * 0.006, q[2] + (e3 - 0.5) * 0.006);
        sigma.push(srcSigma[i] * f);
        alpha.push(SRC.alpha[i]);
        rgb.push(colour[0], colour[1], colour[2]);
        factor.push(f);
        src.push(i);
        label.push(state);
    }
    const base = src.length;
    // fog and floaters (own random streams, so the base rows stay the same)
    const extra = extras[k] ?? [];
    extra.forEach((e) => {
        pos.push(e.pos[0], e.pos[1], e.pos[2]);
        sigma.push(e.sigma);
        alpha.push(e.alpha);
        rgb.push(e.rgb[0], e.rgb[1], e.rgb[2]);
        factor.push(e.sigma);
        src.push(-1);
        label.push(e.label);
    });
    const out = {
        k,
        base,
        pos: new Float32Array(pos),
        sigma: new Float32Array(sigma),
        alpha: new Float32Array(alpha),
        rgb: new Float32Array(rgb),
        factor: new Float32Array(factor),
        src: new Int32Array(src),
        label: new Uint8Array(label)
    };
    return out;
});

const extrasOf = (cs, states) => cs.pieces.map((piece, k) => {
    const random = rng(piece.seed + 77);
    const list = [];
    const pickPoint = (accept) => {
        for (let tries = 0; tries < 200000; tries++) {
            const i = Math.floor(random() * N);
            if (states[k][i] !== ST.outside && SRC.alpha[i] >= 0.2 && accept(states[k][i])) return i;
        }
        return -1;
    };
    const dir = () => {
        const z = random() * 2 - 1, a = random() * 2 * Math.PI, s = Math.sqrt(1 - z * z);
        return [s * Math.cos(a), s * Math.sin(a), z];
    };
    for (let f = 0; f < fogN; f++) {
        const i = pickPoint(() => true);
        if (i < 0) break;
        const d = dir(), dist = 0.05 + random() * 0.35;
        const grey = 0.4 + random() * 0.4;
        list.push({ pos: [P[i * 3] + d[0] * dist, P[i * 3 + 1] + d[1] * dist, P[i * 3 + 2] + d[2] * dist], sigma: 0.1 + random() * 0.2, alpha: 0.05 + random() * 0.3, rgb: [grey, grey, grey], label: ST.fog });
    }
    const clumps = [];
    for (let f = 0; f < floaterN; f++) {
        const fine = f % 2 === 0;
        const i = pickPoint(s => (fine ? s === ST.normal || s === ST.focusFine : s === ST.coarse || s === ST.focusCoarse));
        if (i < 0) continue;
        const d = dir(), dist = 0.05 + random() * 0.25;
        const c = [P[i * 3] + d[0] * dist, P[i * 3 + 1] + d[1] * dist, P[i * 3 + 2] + d[2] * dist];
        clumps.push({ piece: k, centre: c, fine });
        const count = 30 + Math.floor(random() * 31);
        const colour = [random(), random(), random()];
        for (let j = 0; j < count; j++) {
            list.push({
                pos: [c[0] + 0.015 * gauss(random(), random()), c[1] + 0.015 * gauss(random(), random()), c[2] + 0.015 * gauss(random(), random())],
                sigma: 0.003 + random() * 0.005,
                alpha: 0.7 + random() * 0.3,
                rgb: colour,
                label: ST.floater
            });
        }
    }
    list.clumps = clumps;
    return list;
});

// moves after the alignment: exposure, offset, scale of piece 1
const postMoves = (rowsArr, applyVariant) => {
    if (!applyVariant || rowsArr.length < 2) return;
    const r = rowsArr[1];
    if (exposure !== null) for (let i = 0; i < r.rgb.length; i++) r.rgb[i] *= exposure;
    // along the up axis: floors and ceilings come apart by the offset, walls
    // only slide along themselves
    if (offset !== null) for (let i = up; i < r.pos.length; i += 3) r.pos[i] += offset;
    if (scaleF !== null) {
        const c = [0, 0, 0];
        const n = r.pos.length / 3;
        for (let i = 0; i < r.pos.length; i += 3) for (let a = 0; a < 3; a++) c[a] += r.pos[i + a] / n;
        for (let i = 0; i < r.pos.length; i += 3) for (let a = 0; a < 3; a++) r.pos[i + a] = c[a] + (r.pos[i + a] - c[a]) * scaleF;
        for (let i = 0; i < r.sigma.length; i++) r.sigma[i] *= scaleF;
    }
};

// alignment by the wizard's phase 1 (--aligned compose): pieces moved a
// little, then aligned as test-composition.mjs does
const alignCompose = (cs, rowsArr) => {
    const random = rng(cs.seed * 13 + 3);
    rowsArr.forEach((r, k) => {
        if (k === 0) return;
        const heading = (random() * 4 - 2) * Math.PI / 180, tilt = (random() - 0.5) * Math.PI / 180;
        const R = mul3(rotation(unit(up), heading), rotation(unit(trans), tilt));
        const shift = [0, 1, 2].map(() => (random() * 2 - 1) * 0.3);
        const c = cs.pieces[k].centre;
        for (let i = 0; i < r.pos.length; i += 3) {
            const d = [r.pos[i] - c[0], r.pos[i + 1] - c[1], r.pos[i + 2] - c[2]];
            for (let a = 0; a < 3; a++) r.pos[i + a] = R[a * 3] * d[0] + R[a * 3 + 1] * d[1] + R[a * 3 + 2] * d[2] + c[a] + shift[a];
        }
    });
    const clouds = rowsArr.map(r => core.capPoints(r.pos, 400000));
    const overlapResult = core.scanOverlap(clouds);
    const E = rowsArr.map(() => null);
    E[overlapResult.reference] = core.IDENTITY.slice();
    for (const { scan } of overlapResult.order) {
        const placed = rowsArr.map((r, k) => (E[k] ? core.transformPoints(E[k], clouds[k]) : null)).filter(Boolean);
        E[scan] = core.composeAlign(clouds[scan], core.concat(placed), { coarse: 'auto' }).matrix;
    }
    rowsArr.forEach((r, k) => {
        r.pos = core.transformPoints(E[k], r.pos);
    });
};

// ---------------------------------------------------------------- metrics

// grids of the visible opaque rows per piece
const visibleGrids = (rowsArr, hidden) => rowsArr.map((r, k) => {
    const ids = [];
    for (let j = 0; j < r.alpha.length; j++) if (r.alpha[j] >= 0.2 && hidden[k][j] < 0) ids.push(j);
    return new Grid(r.pos, ids, 0.06);
});


// --haze-diag (synthetic): the hidden haze rows by truth, origin and size
const hazeTotals = {};
const hazeTruth = (run, rowsArr, states, where) => {
    const c = run.cell;
    const regionById = new Map(run.detail.regions.map(r => [r.id, r]));
    const stNames = Object.fromEntries(Object.entries(ST).map(([k2, v]) => [v, k2]));
    const tally = {};
    run.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
        const st = run.results[ji].batches[bi].state;
        const r = rowsArr[batch.loser];
        const region = regionById.get(batch.id);
        if (!region) return;
        for (let q = 0; q < st.length; q++) {
            if (st[q] !== D.PaintState.haze) continue;
            const j = batch.rows[q];
            const v = run.applied.paint[batch.loser][j];
            if (!v || v & 0x8000) continue;
            const origin = batch.hazeFrom !== undefined && q >= batch.hazeFrom ? 'zone' : batch.ring[q] ? 'ring' : 'cell';
            let truth, ws = '-';
            if (r.label[j] === ST.fog || r.label[j] === ST.floater) truth = 'right';
            else {
                const i = r.src[j];
                const rw = RANK[states[region.winner][i]], rl = RANK[r.label[j]];
                ws = stNames[states[region.winner][i]];
                truth = rw === 0 || rw === 1 || rw < rl ? 'wrong' : rw === rl ? 'neutral' : 'right';
            }
            const key = `${truth} ${origin}${r.sigma[j] >= c ? ' giant' : ''} (winner ${ws}, row ${stNames[r.label[j]]})`;
            tally[key] = (tally[key] ?? 0) + 1;
            hazeTotals[key] = (hazeTotals[key] ?? 0) + 1;
        }
    }));
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    console.log(`   haze-diag ${where}: ${total} haze rows hidden; ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k2, v]) => `${k2} ${v}`).join(', ') || '-'}`);
};

const evaluateCase = (cs, states, rowsArr, run, extras) => {
    const c = run.cell;
    const hidden = hiddenOf(run);
    const regions = run.detail.regions;
    const regionById = new Map(regions.map(r => [r.id, r]));
    const n = rowsArr.length;
    const res = { hidden: 0, right: 0, neutral: 0, wrong: 0 };
    const wrongBy = new Map(), hiddenBy = new Map(), neutralBy = new Map();
    // hidden rows by truth
    rowsArr.forEach((r, k) => {
        const h = hidden[k];
        for (let j = 0; j < h.length; j++) {
            const id = h[j];
            if (id < 0) continue;
            res.hidden++;
            hiddenBy.set(id, (hiddenBy.get(id) ?? 0) + 1);
            if (r.label[j] === ST.fog || r.label[j] === ST.floater) {
                res.right++;
                continue;
            }
            const i = r.src[j];
            const W = regionById.get(id).winner;
            const rw = RANK[states[W][i]], rl = RANK[r.label[j]];
            // the design's definition: wrong when the winner lacks the point or
            // is coarse there (rank 1), or is coarser than the row
            if (rw === 0 || rw === 1 || rw < rl) {
                res.wrong++;
                wrongBy.set(id, (wrongBy.get(id) ?? 0) + 1);
            } else if (rw === rl) {
                res.neutral++;
                neutralBy.set(id, (neutralBy.get(id) ?? 0) + 1);
            } else {
                res.right++;
            }
        }
    });
    res.wrongWinner = [...hiddenBy.entries()].filter(([id, h]) => (wrongBy.get(id) ?? 0) > h / 2).length;
    res.perRegion = new Map([...hiddenBy.entries()].map(([id, h]) => [id, { hidden: h, wrong: wrongBy.get(id) ?? 0, neutral: neutralBy.get(id) ?? 0 }]));

    // recall of the coarse stretches inside overlaps (away from the ends)
    let elig = 0, hit = 0, eligF = 0, hitF = 0, overlapRows = 0, overlapHidden = 0, cand = 0, candF = 0;
    const missWhy = {};
    rowsArr.forEach((r, k) => {
        const piece = cs.pieces[twin && k === 1 ? 0 : k];
        for (let j = 0; j < r.base; j++) {
            const i = r.src[j];
            const m = P[i * 3 + main];
            let fineElsewhere = false, inOther = false;
            for (let o = 0; o < n; o++) {
                if (o === k) continue;
                const so = states[o][i];
                if (so !== ST.outside) inOther = true;
                if (RANK[so] === 3) {
                    const po = cs.pieces[twin && o === 1 ? 0 : o];
                    if (m - po.lo >= c && po.hi - m >= c) fineElsewhere = true;
                }
            }
            if (inOther) {
                overlapRows++;
                if (hidden[k][j] >= 0) overlapHidden++;
            }
            if (r.label[j] === ST.coarse && fineElsewhere && m - piece.coarseLo >= c && piece.coarseHi - m >= c) {
                elig++;
                if (hidden[k][j] >= 0) hit++;
                if (run.applied.paint[k][j]) cand++;
                else if (verbose) {
                    // why not a candidate: the state of its cell
                    const dd = run.detail;
                    const lc = run.cells[k].rowCell[j];
                    const g = lc >= 0 ? dd.remap[k][lc] : -1;
                    const h = g >= 0 ? dd.sharedIndex[g] : -1;
                    const why = h < 0 ? 'not shared' : dd.regionOf[g] >= 0 ? 'region (finer here or other loser)' : `state ${dd.state[h]}${dd.owner[h] >= 0 ? ` owner ${dd.owner[h]}` : ''}${dd.pooled[h] ? '' : ' single'}`;
                    missWhy[why] = (missWhy[why] ?? 0) + 1;
                }
            }
            if (r.label[j] === ST.focusCoarse) {
                const b = cs.balls.find(q => (q.others ?? [q.other]).includes(k) && Math.hypot(P[i * 3] - q.centre[0], P[i * 3 + 1] - q.centre[1], P[i * 3 + 2] - q.centre[2]) < q.r);
                if (b && states[b.focus][i] === ST.focusFine) {
                    eligF++;
                    if (hidden[k][j] >= 0) hitF++;
                    if (run.applied.paint[k][j]) candF++;
                }
            }
        }
    });
    res.recall = elig ? hit / elig : NaN;
    res.missWhy = missWhy;
    res.candRecall = elig ? cand / elig : NaN;
    res.candRecallFocus = eligF ? candF / eligF : NaN;
    res.recallCells = elig;
    res.recallFocus = eligF ? hitF / eligF : NaN;
    res.overlapHidden = overlapRows ? overlapHidden / overlapRows : 0;

    // focus balls: one suggestion with the right winner holding >= 70 %
    res.balls = cs.balls.map((b) => {
        const by = new Map();
        let total = 0;
        rowsArr.forEach((r, k) => {
            for (let j = 0; j < r.base; j++) {
                const id = hidden[k][j];
                if (id < 0) continue;
                const i = r.src[j];
                if (Math.hypot(P[i * 3] - b.centre[0], P[i * 3 + 1] - b.centre[1], P[i * 3 + 2] - b.centre[2]) >= b.r) continue;
                total++;
                by.set(id, (by.get(id) ?? 0) + 1);
            }
        });
        const top = [...by.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
        const region = top ? regionById.get(top[0]) : null;
        const others = b.others ?? [b.other];
        // per coarse scan: the share of its focus-coarse rows in the ball
        // (fine in the focus scan there) that are hidden
        const perLoser = others.map((l) => {
            const r = rowsArr[l];
            let all = 0, hid = 0;
            for (let j = 0; j < r.base; j++) {
                if (r.label[j] !== ST.focusCoarse) continue;
                const i = r.src[j];
                if (states[b.focus][i] !== ST.focusFine || Math.hypot(P[i * 3] - b.centre[0], P[i * 3 + 1] - b.centre[1], P[i * 3 + 2] - b.centre[2]) >= b.r) continue;
                all++;
                if (hidden[l][j] >= 0) hid++;
            }
            return all ? hid / all : NaN;
        });
        return {
            ball: b.index,
            total,
            share: top ? top[1] / total : 0,
            winner: region ? region.winner : -1,
            focus: b.focus,
            ok: !!region && (b.winners ?? [b.focus]).includes(region.winner) && top[1] >= 0.7 * total,
            losers: region ? region.losers : [],
            losersOk: !!region && others.every(l => region.losers.includes(l)),
            perLoser,
            shape: region?.shape,
            scope: region?.scope,
            id: region?.id
        };
    });

    // --layers: the shifted layer's rows on horizontal surfaces (hidden ones
    // lie 10 cm off the winner's surface) and the apart clusters naming it
    if (cs.shift) {
        const flat = horizontalOf();
        const r = rowsArr[cs.shift.layer];
        let all = 0, hid = 0;
        for (let j = 0; j < r.base; j++) {
            if (!r.shifted?.[j] || !flat(r.src[j])) continue;
            all++;
            if (hidden[cs.shift.layer][j] >= 0) hid++;
        }
        res.shiftFlat = all;
        res.shiftFlatHidden = hid;
        res.shiftApart = run.detail.rejected.filter(q => q.reason === 'apart' && q.loser === cs.shift.layer).length;
        if (has('flat-diag')) {
            // the shifted horizontal rows by their paint state, cell state,
            // ring flag; plane distances of the hidden ones
            const at = new Map();
            run.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
                if (batch.loser !== cs.shift.layer) return;
                const pr = run.results[ji].batches[bi];
                batch.rows.forEach((row, q) => at.set(row, { batch, pr, q }));
            }));
            const tally = {};
            const dh = [], dk = [];
            for (let j = 0; j < r.base; j++) {
                if (!r.shifted?.[j] || !flat(r.src[j])) continue;
                const a = at.get(j);
                let key;
                if (!a) key = 'no candidate';
                else {
                    const g = a.batch.candidateCell[a.q];
                    const h = run.detail.sharedIndex[g];
                    key = `${['', 'hidden', 'uncovered', 'apart', 'no surface', 'held', 'haze'][a.pr.state[a.q]]} ${a.batch.ring[a.q] ? 'ring' : 'cell'} state ${h >= 0 ? run.detail.state[h] : '-'}`;
                    (a.pr.state[a.q] === 1 ? dh : dk).push(a.pr.distance[a.q]);
                }
                tally[key] = (tally[key] ?? 0) + 1;
            }
            console.log(`   flat-diag shifted layer ${cs.shift.layer + 1}: ${JSON.stringify(tally)}; plane distance hidden p25/p50/p75 ${len(quantile(dh, 0.25))} / ${len(quantile(dh, 0.5))} / ${len(quantile(dh, 0.75))}, kept p50 ${len(quantile(dk, 0.5))}`);
            // a few hidden ones: offset to the nearest winner point (up
            // component), footprint
            let shown = 0;
            for (let j = 0; j < r.base && shown < 6; j++) {
                if (!r.shifted?.[j] || !flat(r.src[j]) || hidden[cs.shift.layer][j] < 0) continue;
                const a = at.get(j);
                if (!a) continue;
                shown++;
                const wp = a.batch.winnerPoints;
                let best = Infinity, bu = 0;
                for (let q = 0; q < wp.length; q += 3) {
                    const dx = wp[q] - r.pos[j * 3], dy = wp[q + 1] - r.pos[j * 3 + 1], dz = wp[q + 2] - r.pos[j * 3 + 2];
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 < best) {
                        best = d2;
                        bu = [dx, dy, dz][up];
                    }
                }
                console.log(`      hidden shifted row ${j}: sigma ${len(r.sigma[j])}, plane distance ${len(a.pr.distance[a.q])}, nearest winner point ${len(Math.sqrt(best))} (along up ${len(bu)}), source ${[0, 1, 2].map(k => P[r.src[j] * 3 + k].toFixed(2)).join(', ')}`);
            }
        }
    }

    // hidden rows without a visible winner point within max(2 cm, 2 s_W)
    {
        const grids = visibleGrids(rowsArr, hidden);
        // at the hidden row's true surface position (the source splat), and
        // for information at its actual (scattered) position
        let lonely = 0, lonelyActual = 0, counted = 0;
        rowsArr.forEach((r, k) => {
            for (let j = 0; j < r.base; j++) {
                const id = hidden[k][j];
                if (id < 0) continue;
                counted++;
                const region = regionById.get(id);
                const pl = region.perLoser.find(p => p.scan === k);
                const rad = Math.min(0.06, Math.max(0.02, 2 * (pl?.sW ?? 0)));
                const i = r.src[j];
                if (!grids[region.winner].near(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], rad, () => true)) lonely++;
                if (!grids[region.winner].near(r.pos[j * 3], r.pos[j * 3 + 1], r.pos[j * 3 + 2], rad, () => true)) lonelyActual++;
            }
        });
        res.lonely = counted ? lonely / counted : 0;
        res.lonelyActual = counted ? lonelyActual / counted : 0;
    }

    // coverage of truth surface points (opaque source splats in the pieces)
    {
        const ids = [];
        const inAny = (i) => {
            for (let k = 0; k < n; k++) if (states[k][i] !== ST.outside) return true;
            return false;
        };
        const step = Math.max(1, Math.floor(N / 300000));
        for (let i = 0; i < N; i += step) if (SRC.alpha[i] >= 0.2 && inAny(i)) ids.push(i);
        const scans = rowsArr.map((r, k) => ({ pos: r.pos, sigma: r.sigma, alpha: r.alpha, hidden: hidden[k] }));
        const all = coverageLoss({ pos: P, ids }, scans);
        res.coverage = all;
        const holeIds = [];
        for (let i = 0; i < N; i++) {
            if (SRC.alpha[i] < 0.2) continue;
            for (let k = 0; k < n; k++) {
                if (states[k][i] === ST.dropped || states[k][i] === ST.holed) {
                    holeIds.push(i);
                    break;
                }
            }
        }
        res.holeCoverage = holeIds.length ? coverageLoss({ pos: P, ids: holeIds }, scans) : null;
    }

    // floaters: hidden rows within 10 cm of a fine-area clump; regions in the air
    if (extras && (fogN || floaterN)) {
        const clumps = extras.flatMap(e => e.clumps ?? []).filter(cl => cl.fine);
        if (clumps.length) {
            const cg = new Grid(new Float32Array(clumps.flatMap(cl => cl.centre)), clumps.map((_, i) => i), 0.1);
            let near = 0;
            rowsArr.forEach((r, k) => {
                for (let j = 0; j < r.alpha.length; j++) if (hidden[k][j] >= 0 && cg.near(r.pos[j * 3], r.pos[j * 3 + 1], r.pos[j * 3 + 2], 0.1, () => true)) near++;
            });
            res.nearFloaters = res.hidden ? near / res.hidden : 0;
            res.nearFloaterRows = near;
        }
        // cells with source surface
        const surface = new Set();
        for (let i = 0; i < N; i++) if (SRC.alpha[i] >= 0.2) surface.add(keyOf(Math.floor(P[i * 3] / c), Math.floor(P[i * 3 + 1] / c), Math.floor(P[i * 3 + 2] / c)));
        res.airRegions = regions.filter(r => Array.from(r.cells).every(g => !surface.has(run.detail.keys[g]))).length;
    }

    // budget: hidden neutral shared rows of the high-budget pieces by ticked cards
    if (budget !== null) {
        const ticked = hiddenOf(run, r => r.confidence === 'clear' && r.scope !== 'base');
        let rowsN = 0, hid = 0;
        rowsArr.forEach((r, k) => {
            if (k === 0) return;
            for (let j = 0; j < r.base; j++) {
                if (r.label[j] !== ST.normal) continue;
                const i = r.src[j];
                let shared = false;
                for (let o = 0; o < n; o++) if (o !== k && states[o][i] !== ST.outside) shared = true;
                if (!shared) continue;
                rowsN++;
                if (ticked[k][j] >= 0) hid++;
            }
        });
        res.budgetNeutral = rowsN ? hid / rowsN : 0;
        res.baseCards = regions.filter(r => r.scope === 'base').length;
        res.baseClear = regions.filter(r => r.scope === 'base' && r.confidence === 'clear').length;
    }

    // offset / scale: hidden rows involving piece 1 (on horizontal surfaces,
    // where a vertical offset separates the scans), apart cells
    if (offset !== null || scaleF !== null) {
        let inv = 0, invFlat = 0, flatRows = 0;
        const flat = horizontalOf();
        rowsArr.forEach((r, k) => {
            for (let j = 0; j < r.base; j++) {
                const id = hidden[k][j];
                const involved = k === 1 || (id >= 0 && regionById.get(id).winner === 1);
                if (k === 1 && j % 10 === 0 && flat(r.src[j]) && states.some((st2, o) => o !== 1 && st2[r.src[j]] !== ST.outside)) flatRows += 10;
                if (id < 0 || !involved) continue;
                inv++;
                if (flat(r.src[j])) invFlat++;
            }
        });
        res.piece1Hidden = inv;
        res.piece1HiddenFlat = invFlat;
        res.piece1FlatRows = flatRows;
        if (has('flat-diag')) {
            // the hidden horizontal rows involving piece 1: their candidate's
            // plane distance, the cell's state, region scope, ring flag
            const at = new Map();
            run.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
                const r = run.results[ji].batches[bi];
                batch.rows.forEach((row, q) => at.set(`${batch.loser}:${row}`, { batch, r, q }));
            }));
            const tally = {};
            const dists = [];
            rowsArr.forEach((r, k) => {
                for (let j = 0; j < r.base; j++) {
                    const id = hidden[k][j];
                    if (id < 0 || !flat(r.src[j])) continue;
                    if (!(k === 1 || regionById.get(id).winner === 1)) continue;
                    const a = at.get(`${k}:${j}`);
                    if (!a) continue;
                    const g = a.batch.candidateCell[a.q];
                    const h = run.detail.sharedIndex[g];
                    const key2 = `piece ${k + 1} ${regionById.get(id).scope} ${a.batch.ring[a.q] ? 'ring' : 'cell'} state ${h >= 0 ? run.detail.state[h] : '-'}`;
                    tally[key2] = (tally[key2] ?? 0) + 1;
                    dists.push(a.r.distance[a.q]);
                }
            });
            console.log(`   flat-diag: hidden horizontal rows by ${JSON.stringify(tally)}; their plane distance p25/p50/p75 ${len(quantile(dists, 0.25))} / ${len(quantile(dists, 0.5))} / ${len(quantile(dists, 0.75))}`);
        }
        const d = run.detail;
        let affected = 0, apart = 0;
        for (let h = 0; h < d.state.length; h++) {
            const pm = d.present[d.shared[h]];
            if (!((pm >> 1) & 1)) continue;
            affected++;
            if (d.state[h] === D.CellState.apart) apart++;
        }
        res.piece1Cells = affected;
        res.piece1Apart = affected ? apart / affected : 0;
        res.apartClusters = d.rejected.filter(r => r.reason === 'apart').length;
    }

    res.regions = regions.length;
    // --twin: suggestions between the twins - one twin the winner, the other
    // among its losers (with 4 pieces, pieces 3 and 4 are an ordinary pair of
    // their own; with --layers, other layers can be losers too)
    res.twinRegions = regions.filter(r => (r.winner === 0 && r.losers.includes(1)) || (r.winner === 1 && r.losers.includes(0))).length;
    // and the shared cells where one twin strongly beats the other (the
    // seeds such a suggestion would grow from)
    if (twin) {
        const d = run.detail;
        let strongTwin = 0;
        for (let h = 0; h < d.state.length; h++) {
            const o = d.owner[h];
            if ((o === 0 && (d.strong[h] >> 1) & 1) || (o === 1 && d.strong[h] & 1)) strongTwin++;
        }
        res.twinStrong = strongTwin;
    }
    res.clear = regions.filter(r => r.confidence === 'clear').length;
    res.base = regions.filter(r => r.scope === 'base').length;
    res.hiddenSet = hidden;
    return res;
};

// --grow-diag <file.json> (diagnostic): every hide cell and ring cell of
// every region and loser - how it came in (its state and owner), its own
// lead (the cell alone, count medians), the pooled and the confirmed lead
// (probe), counts, and the truth of the loser's rows there (right /
// neutral / wrong, all and hidden)
const growRecords = [];
const growDiag = (run, rowsArr, states, res, where) => {
    const d = run.detail, S = d.scanCount;
    const hidden = res.hiddenSet;
    const probe = D.makeProbe(run.cells, d, PIPE);
    const localOf = run.cells.map((sc, s) => {
        const m = new Int32Array(d.keys.length).fill(-1);
        d.remap[s].forEach((g, i) => {
            m[g] = i;
        });
        return m;
    });
    const medAt = (s, g) => {
        const i = localOf[s][g];
        if (i < 0) return NaN;
        const h = run.cells[s].hist;
        let total = 0;
        for (let b = 0; b < 24; b++) total += h[i * 24 + b];
        if (!total) return NaN;
        let acc = 0;
        for (let b = 0; b < 24; b++) {
            const v = h[i * 24 + b];
            if (v && acc + v >= total / 2) return -10 + (b + (total / 2 - acc) / v) * 0.5;
            acc += v;
        }
        return NaN;
    };
    const nAt = (s, g) => (localOf[s][g] >= 0 ? run.cells[s].n[localOf[s][g]] : 0);
    d.regions.forEach((r) => {
        const W = r.winner;
        const ring = new Set(Array.from(r.ring));
        r.losers.forEach((L, li) => {
            const hide = new Set(Array.from(r.hideCells[li]));
            const tally = new Map();
            const rl = rowsArr[L], rc = run.cells[L].rowCell, rm = d.remap[L];
            for (let j = 0; j < rl.base; j++) {
                const lc = rc[j];
                if (lc < 0) continue;
                const g = rm[lc];
                const kind = hide.has(g) ? 'hide' : ring.has(g) ? 'ring' : null;
                if (!kind) continue;
                const i = rl.src[j];
                const rw = RANK[states[W][i]], rk = RANK[rl.label[j]];
                const cat = rw === 0 || rw === 1 || rw < rk ? 2 : rw === rk ? 1 : 0;
                let t = tally.get(g);
                if (!t) {
                    t = { kind, rows: [0, 0, 0], hidden: [0, 0, 0] };
                    tally.set(g, t);
                }
                t.rows[cat]++;
                if (hidden[L][j] === r.id) t.hidden[cat]++;
            }
            tally.forEach((t, g) => {
                if (t.kind === 'ring' && !(t.hidden[0] + t.hidden[1] + t.hidden[2])) return;
                const h = d.sharedIndex[g];
                const centre = core.decode(d.keys[g]).map(v => (v + 0.5) * run.cell);
                const pair = h >= 0 ? probe(centre).pairs.find(q => q.winner === W && q.loser === L) : null;
                growRecords.push({
                    where,
                    region: r.id,
                    W,
                    L,
                    g,
                    kind: t.kind,
                    state: h >= 0 ? d.state[h] : -1,
                    owner: h >= 0 ? d.owner[h] : -1,
                    strongL: h >= 0 ? (d.strong[h] >> L) & 1 : 0,
                    weakL: h >= 0 ? (d.weak[h] >> L) & 1 : 0,
                    ownLead: medAt(L, g) - medAt(W, g),
                    pooledLead: h >= 0 ? Math.log2(d.size[h * S + L] / d.size[h * S + W]) : NaN,
                    lead: pair ? pair.lead : NaN,
                    nW: nAt(W, g),
                    nL: nAt(L, g),
                    poolW: h >= 0 ? d.count[h * S + W] : 0,
                    poolL: h >= 0 ? d.count[h * S + L] : 0,
                    rows: t.rows,
                    hidden: t.hidden
                });
            });
        });
    });
};

const jaccard = (a, b, rowsArr) => {
    let inter = 0, union = 0;
    rowsArr.forEach((r, k) => {
        for (let j = 0; j < r.base; j++) {
            const x = a[k][j] >= 0, y = b[k][j] >= 0;
            if (x && y) inter++;
            if (x || y) union++;
        }
    });
    return union ? inter / union : 1;
};

// --leads (diagnostic): for the strong cells of the run, the lead of the
// (owner, beaten) pair under other pooling options (probe), split by truth:
// 'true' when the loser's rows in the cell are mostly coarse there
// (blur stretch or focus-coarse) and the owner's normal or fine
const leadsReport = (run, rowsArr, states, where) => {
    const d = run.detail;
    const S = d.scanCount;
    const variants = (option('leads-variants', 'confirm=0;confirm=1;confirm=1,confirmArea=0')).split(';').map(v => Object.fromEntries(v.split(',').map(kv => kv.split('=')).map(([k, x]) => [k, Number(x)])));
    const probes = variants.map(v => D.makeProbe(run.cells, d, { ...PIPE, ...v }));
    // loser rows per (scan, global cell): coarse / other
    const tally = rowsArr.map((r, k) => {
        const m = new Map();
        const rc = run.cells[k].rowCell;
        for (let j = 0; j < r.base; j++) {
            const lc = rc[j];
            if (lc < 0) continue;
            const g = d.remap[k][lc];
            let t = m.get(g);
            if (!t) {
                t = [0, 0];
                m.set(g, t);
            }
            t[RANK[r.label[j]] === 1 ? 0 : 1]++;
        }
        return m;
    });
    const out = { true: variants.map(() => []), false: variants.map(() => []) };
    for (let h = 0; h < d.state.length; h++) {
        if (d.state[h] !== D.CellState.strong) continue;
        const g = d.shared[h], W = d.owner[h];
        let L = -1;
        for (let s = 0; s < S; s++) if ((d.strong[h] >> s) & 1) L = s;
        const tL = tally[L].get(g) ?? [0, 0];
        const tW = tally[W].get(g) ?? [0, 0];
        const truth = tL[0] > tL[1] && tW[0] <= tW[1] ? 'true' : 'false';
        const centre = core.decode(d.keys[g]).map(v => (v + 0.5) * run.cell);
        probes.forEach((probe, vi) => {
            const p = probe(centre);
            const pair = p.pairs.find(q => q.winner === W && q.loser === L);
            if (pair) out[truth][vi].push(pair.lead);
        });
    }
    const q = v => (v.length ? [0.05, 0.1, 0.25, 0.5].map(x => quantile(v, x).toFixed(2)).join('/') : '-');
    console.log(`   leads ${where}: strong true ${out.true[0].length}, false ${out.false[0].length}; p5/p10/p25/p50 per variant: ${variants.map((v, vi) => `${JSON.stringify(v)} true ${q(out.true[vi])} false ${q(out.false[vi])}`).join(' | ')}`);
};

// ---------------------------------------------------------------- run

const rowsFor = (cs, states, withVariant) => {
    const extras = withVariant && (fogN || floaterN) ? extrasOf(cs, states) : cs.pieces.map(() => []);
    const rowsArr = piecesOf(cs, states, extras);
    applyShift(cs, rowsArr);
    if (aligned === 'compose') alignCompose(cs, rowsArr);
    postMoves(rowsArr, withVariant);
    return { rowsArr, extras };
};

const rows = [];
let failures = 0;
let rebuildTotal = 0;
const checksAll = [];
const check = (name, ok, value, where) => {
    checksAll.push({ name, ok, value, where });
    if (!ok) failures++;
    // the twin check is reported for every case, pass or fail
    if (!ok || verbose || name.startsWith('twin')) console.log(`   ${ok ? 'ok  ' : 'MISS'} ${name}: ${value}`);
};

for (const n of pieceCounts) {
    for (let s = 0; s < caseCount; s++) {
        const seed = seed0 + s;
        const cs = makeCase(seed, n);
        const states = statesOf(cs);
        const tGen = now();
        const { rowsArr, extras } = rowsFor(cs, states, true);
        const genSeconds = (now() - tGen) / 1000;
        const compact = rowsArr.map(r => compactOf(r.pos, r.sigma, r.alpha, r.rgb));
        const run = runPipeline(compact, up);
        const res = evaluateCase(cs, states, rowsArr, run, extras);
        const where = `${n} pieces #${seed}`;
        if (has('leads')) leadsReport(run, rowsArr, states, where);
        if (option('grow-diag', null)) growDiag(run, rowsArr, states, res, where);
        if (has('apart-diag')) apartDiag(run, where);
        if (has('haze-diag')) hazeTruth(run, rowsArr, states, where);
        const inv = invariants(run.detail);
        check('invariants', inv.ok, inv.text, where);
        const pin = paintInvariant(run);
        check('paint invariant', pin.ok, pin.text, where);
        const vc = viewCheck(run);
        check('free views', vc.ok, vc.text, where);
        console.log(`${where}: overlap ${(cs.overlap * 100).toFixed(0)} %, ${rowsArr.map(r => r.alpha.length.toLocaleString()).join(' / ')} rows, cell ${len(run.cell)} (own ${run.auto.perScan.map(len).join('/')}), ` +
            `${res.regions} suggestions (${res.base} base, ${res.clear} clear), hidden ${res.hidden.toLocaleString()} (right ${pct(res.right / Math.max(1, res.hidden))}, neutral ${pct(res.neutral / Math.max(1, res.hidden))}, wrong ${pct(res.wrong / Math.max(1, res.hidden))}), ` +
            `recall ${pct(res.recall)} (candidates ${pct(res.candRecall)})${focus ? `, focus ${pct(res.recallFocus)} (${pct(res.candRecallFocus)})` : ''}, lonely ${pct(res.lonely)}, coverage loss ${(res.coverage.loss * 100).toFixed(3)} pp` +
            `${res.holeCoverage ? `, holes ${(res.holeCoverage.loss * 100).toFixed(2)} pp of ${res.holeCoverage.points}` : ''}; ` +
            `cells ${run.times.cells.toFixed(1)} + detail ${run.times.detail.toFixed(1)} + paint ${(run.times.inputs + run.times.paint + run.times.apply).toFixed(1)} = ${run.times.total.toFixed(1)} s (gen ${genSeconds.toFixed(1)} s)`);
        if (verbose) {
            console.log(`   pieces ${cs.pieces.map(q => `[${q.lo.toFixed(1)}, ${q.hi.toFixed(1)}] coarse [${q.coarseLo.toFixed(1)}, ${q.coarseHi.toFixed(1)}]`).join(' ')}`);
            describeRegions(run, 12).forEach((l, i) => {
                const region = run.detail.regions[i];
                const pr = res.perRegion.get(region.id);
                // loser labels of the hidden rows, winner states there, box
                const lab = {};
                const L0 = region.losers[0];
                const r = rowsArr[L0];
                for (let j = 0; j < r.base; j++) {
                    if (res.hiddenSet[L0][j] !== region.id) continue;
                    const key2 = `${r.label[j]}/${states[region.winner][r.src[j]]}`;
                    lab[key2] = (lab[key2] ?? 0) + 1;
                }
                console.log(`${l}${pr ? ` || truth: hidden ${pr.hidden}, neutral ${pct(pr.neutral / pr.hidden)}, wrong ${pct(pr.wrong / pr.hidden)}` : ''} || box ${region.min.map(v => v.toFixed(1)).join(',')} .. ${region.max.map(v => v.toFixed(1)).join(',')}, loser/winner states ${JSON.stringify(lab)}`);
                if (has('debug-neutral') && pr && pr.neutral > 0.5 * pr.hidden) {
                    {
                        // the source splats of the first region cell and the rows of both pieces from them
                        const g0 = region.cells[4];
                        const v = core.decode(run.detail.keys[g0]);
                        const lo2 = v.map(x => x * run.cell), hi2 = v.map(x => (x + 1) * run.cell);
                        const inside = (x, y, z) => x >= lo2[0] && x < hi2[0] && y >= lo2[1] && y < hi2[1] && z >= lo2[2] && z < hi2[2];
                        let srcN = 0, srcOpaque = 0;
                        for (let i = 0; i < N; i++) {
                            if (!inside(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])) continue;
                            srcN++;
                            if (SRC.alpha[i] >= 0.2) srcOpaque++;
                        }
                        const per = rowsArr.map((rr) => {
                            let byPos = 0, bySrc = 0, opaquePos = 0;
                            for (let j = 0; j < rr.base; j++) {
                                if (inside(rr.pos[j * 3], rr.pos[j * 3 + 1], rr.pos[j * 3 + 2])) {
                                    byPos++;
                                    if (rr.alpha[j] >= 0.2) opaquePos++;
                                }
                                const i = rr.src[j];
                                if (inside(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])) bySrc++;
                            }
                            return `rows by position ${byPos} (opaque ${opaquePos}), by source ${bySrc}`;
                        });
                        console.log(`      cell ${v.join(',')}: source ${srcN} (opaque ${srcOpaque}); ${per.join(' | ')}`);
                    }
                    // per cell: own counts and median footprints of W and L,
                    // pooled values, and the source sigma there
                    const d = run.detail;
                    const W = region.winner;
                    const S2 = d.scanCount;
                    Array.from(region.cells).slice(0, 12).forEach((g) => {
                        const h = d.sharedIndex[g];
                        const own = [W, L0].map((s2) => {
                            const i2 = run.cells[s2].keys.indexOf(d.keys[g]);
                            if (i2 < 0) return '-';
                            const hist = Array.from(run.cells[s2].hist.slice(i2 * 24, i2 * 24 + 24));
                            return `n ${run.cells[s2].n[i2]} hist ${hist.map((v, b) => (v ? `${b}:${v}` : '')).filter(Boolean).join(' ')}`;
                        });
                        console.log(`      cell ${core.decode(d.keys[g]).join(',')} state ${d.state[h]} pooled ${d.pooled[h]} W size ${len(d.size[h * S2 + W])} n ${d.count[h * S2 + W]} | L size ${len(d.size[h * S2 + L0])} n ${d.count[h * S2 + L0]} | own W ${own[0]} | own L ${own[1]}`);
                    });
                }
            });
            run.jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
                const b = run.results[ji].batches[bi];
                const Lr = rowsArr[b.loser];
                const t2 = {};
                for (let q = 0; q < b.state.length; q++) {
                    if (b.state[q] !== 1) continue;
                    const j = batch.rows[q];
                    if (j >= Lr.base) continue;
                    const i = Lr.src[j];
                    const rw = RANK[states[b.winner][i]], rl = RANK[Lr.label[j]];
                    const cat = rw === 0 || rw === 1 || rw < rl ? 'wrong' : rw === rl ? 'neutral' : 'right';
                    const key2 = `${batch.ring[q] ? 'ring' : 'cell'}:${cat}`;
                    t2[key2] = (t2[key2] ?? 0) + 1;
                }
                if (bi < 2) console.log(`   hidden #${b.id} by ring flag: ${JSON.stringify(t2)}`);
                if (has('debug-neutral') && bi < 2) {
                    const pl = cs.pieces[b.loser], pw = cs.pieces[b.winner];
                    const where = {};
                    for (let q = 0; q < b.state.length; q++) {
                        if (b.state[q] !== 1) continue;
                        const j = batch.rows[q];
                        if (j >= Lr.base) continue;
                        const i = Lr.src[j];
                        const rw = RANK[states[b.winner][i]], rl = RANK[Lr.label[j]];
                        if (!(rw === rl && rw === 3)) continue;
                        const m = P[i * 3 + main];
                        const dStretch = Math.min(Math.abs(m - pl.coarseLo), Math.abs(m - pl.coarseHi));
                        const dRange = Math.min(Math.abs(m - pw.lo), Math.abs(m - pw.hi), Math.abs(m - pl.lo), Math.abs(m - pl.hi));
                        const ball = cs.balls.some(bb => Math.hypot(P[i * 3] - bb.centre[0], P[i * 3 + 1] - bb.centre[1], P[i * 3 + 2] - bb.centre[2]) < bb.r + 2 * run.cell);
                        const key2 = ball ? 'near a ball' : dStretch < 2 * run.cell ? 'within 2 cells of the stretch end' : dRange < 2 * run.cell ? 'within 2 cells of a range end' : 'elsewhere';
                        where[key2] = (where[key2] ?? 0) + 1;
                    }
                    console.log(`      neutral hidden rows: ${JSON.stringify(where)}`);
                }
                if (has('debug-wrong') && bi < 2) {
                    // wrong hide-cell rows: their cell's state, owner, pooled sizes and own counts
                    const d = run.detail;
                    const S2 = d.scanCount;
                    const tally = {};
                    for (let q = 0; q < b.state.length; q++) {
                        if (b.state[q] !== 1 || batch.ring[q]) continue;
                        const j = batch.rows[q];
                        if (j >= Lr.base) continue;
                        const i = Lr.src[j];
                        const rw = RANK[states[b.winner][i]];
                        if (rw !== 1) continue;
                        const g = batch.candidateCell[q];
                        const h = d.sharedIndex[g];
                        const key2 = h < 0 ? 'not shared' : `st${d.state[h]} own${d.owner[h]} lead ${(Math.log2(d.size[h * S2 + b.loser] / d.size[h * S2 + b.winner])).toFixed(1)} nW ${d.count[h * S2 + b.winner]} nL ${d.count[h * S2 + b.loser]}`;
                        tally[key2] = (tally[key2] ?? 0) + 1;
                    }
                    const top = Object.entries(tally).sort((x, y) => y[1] - x[1]).slice(0, 8);
                    console.log(`      wrong hide-cell rows by cell: ${JSON.stringify(top)}`);
                }
            }));
            run.results.forEach(pr => pr.batches.forEach((b) => {
                const st = [0, 0, 0, 0, 0, 0];
                b.state.forEach((v) => {
                    st[v]++;
                });
                console.log(`   paint #${b.id} ${b.winner + 1}->${b.loser + 1}: hidden ${st[1]}, uncovered ${st[2]}, apart ${st[3]} (${b.apartCells.length} cells), no surface ${st[4]}, held ${st[5]}, sW ${len(b.sW)}, rt ${len(b.rt)}, rn ${len(b.rn)}, mSelf ${b.mSelf}, sep ${len(b.sep25)} / ${len(b.sep50)} / ${len(b.sep75)}`);
            }));
            console.log(`   lonely at the actual position ${pct(res.lonelyActual)}; coverage before ${pct(res.coverage.before)} after ${pct(res.coverage.after)}`);
            {
                // kept candidates that are truly coarse under a normal winner:
                // would hiding them keep the surface covered by the winner alone
                // (a visible winner row within max(1.5 cm, 2 sigma) of the true spot)?
                const covGrids = rowsArr.map((r, k2) => {
                    const ids = [];
                    for (let j = 0; j < r.alpha.length; j++) if (r.alpha[j] >= 0.2 && res.hiddenSet[k2][j] < 0) ids.push(j);
                    return new Grid(r.pos, ids, 0.25);
                });
                run.results.forEach(pr => pr.batches.forEach((b, bi) => {
                    const job = run.jobs.find(jj => jj.loser === b.loser);
                    const batch = job.batches.find(bb => bb.id === b.id);
                    const W = b.winner, Lr = rowsArr[b.loser];
                    const tally = {};
                    for (let q = 0; q < b.state.length; q++) {
                        const j = batch.rows[q];
                        if (j >= Lr.base) continue;
                        const i = Lr.src[j];
                        if (RANK[Lr.label[j]] !== 1 || RANK[states[W][i]] !== 3) continue;
                        const Wr = rowsArr[W];
                        const ok = covGrids[W].near(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0.25, (jj, d2) => {
                            const rr = Math.max(0.015, Math.min(0.25, 2 * Wr.sigma[jj]));
                            return d2 <= rr * rr;
                        });
                        const key2 = `${['', 'hidden', 'uncovered', 'apart', 'nosurf', 'held', 'haze'][b.state[q]]}:${ok ? 'Wcovers' : 'Wgap'}`;
                        tally[key2] = (tally[key2] ?? 0) + 1;
                    }
                    if (bi < 3) console.log(`   paint #${b.id} truly coarse candidates under a normal winner: ${JSON.stringify(tally)}`);
                }));
            }
            console.log(`   eligible coarse rows not in paint, by cell state (1 strong 2 weak 3 tie 4 partial 5 sparse 6 texture 7 thin): ${JSON.stringify(res.missWhy)}`);
            if (has('oracle')) {
                // coverage loss when every candidate is hidden, and when every
                // truly coarse row under a normal / fine piece is hidden
                const ids = [];
                const step = Math.max(1, Math.floor(N / 300000));
                for (let i = 0; i < N; i += step) if (SRC.alpha[i] >= 0.2 && states.some(st2 => st2[i] !== ST.outside)) ids.push(i);
                const allCand = run.applied.paint.map(p2 => Int32Array.from(p2, v => (v ? 0 : -1)));
                const oracle = rowsArr.map((r, k) => {
                    const out = new Int32Array(r.alpha.length).fill(-1);
                    for (let j = 0; j < r.base; j++) {
                        if (RANK[r.label[j]] !== 1) continue;
                        if (states.some((st2, o) => o !== k && RANK[st2[r.src[j]]] === 3)) out[j] = 0;
                    }
                    return out;
                });
                const cov = hid => coverageLoss({ pos: P, ids }, rowsArr.map((r, k) => ({ pos: r.pos, sigma: r.sigma, alpha: r.alpha, hidden: hid[k] })));
                const a1 = cov(allCand), a2 = cov(oracle);
                const cnt = hid => hid.reduce((t, h) => t + h.reduce((u, v) => u + (v >= 0 ? 1 : 0), 0), 0);
                // oracle lonely: the fine piece there as the winner, 2 cm / 2 s_W
                const grids = visibleGrids(rowsArr, oracle);
                const sW = Math.min(...run.detail.regions.flatMap(r2 => r2.perLoser.map(p2 => p2.sW ?? Infinity)));
                const rad = Math.min(0.06, Math.max(0.02, 2 * (Number.isFinite(sW) ? sW : 0)));
                let lone = 0, tot = 0;
                rowsArr.forEach((r, k) => {
                    for (let j = 0; j < r.base; j++) {
                        if (oracle[k][j] < 0) continue;
                        const i = r.src[j];
                        const W = states.findIndex((st2, o) => o !== k && RANK[st2[i]] === 3);
                        tot++;
                        if (!grids[W].near(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], rad, () => true)) lone++;
                    }
                });
                console.log(`   oracle: all ${cnt(allCand)} candidates hidden -> loss ${(a1.loss * 100).toFixed(3)} pp; all ${cnt(oracle)} truly coarse rows under a fine piece hidden -> loss ${(a2.loss * 100).toFixed(3)} pp, lonely ${pct(lone / Math.max(1, tot))} (radius ${len(rad)})`);
            }
        }
        if (focus && verbose) {
            res.balls.forEach(b => console.log(`   ball ${b.ball}: ${b.total} hidden, top ${pct(b.share)} winner ${b.winner + 1} (focus ${b.focus + 1}) ${b.shape} ${b.scope}`));
            // cells inside each ball: states, owners, leads
            const d = run.detail;
            const names = Object.fromEntries(Object.entries(D.CellState).map(([k2, v]) => [v, k2]));
            cs.balls.forEach((b) => {
                const st = {}, own = {};
                const leads = [], covers = [];
                for (let h = 0; h < d.state.length; h++) {
                    const g = d.shared[h];
                    const v = core.decode(d.keys[g]).map(x => (x + 0.5) * run.cell);
                    if (Math.hypot(v[0] - b.centre[0], v[1] - b.centre[1], v[2] - b.centre[2]) > b.r - run.cell / 2) continue;
                    st[names[d.state[h]]] = (st[names[d.state[h]]] ?? 0) + 1;
                    own[d.owner[h]] = (own[d.owner[h]] ?? 0) + 1;
                    const S2 = d.scanCount;
                    const sf = d.size[h * S2 + b.focus], so = d.size[h * S2 + b.other];
                    if (Number.isFinite(sf) && Number.isFinite(so)) leads.push(Math.log2(so / sf));
                    if (Number.isFinite(d.cover[h * S2 + b.other])) covers.push(d.cover[h * S2 + b.other]);
                }
                console.log(`   ball ${b.index} at ${b.centre.map(x => x.toFixed(2)).join(', ')}: shared cells by state ${JSON.stringify(st)}, owners ${JSON.stringify(own)}, lead p50 ${quantile(leads, 0.5).toFixed(2)}, cover p50 ${quantile(covers, 0.5).toFixed(2)}, regions ${[...new Set(Array.from({ length: d.keys.length }, (_, g) => g).filter(g => d.regionOf[g] >= 0 && Math.hypot(...core.decode(d.keys[g]).map((x, a) => (x + 0.5) * run.cell - b.centre[a])) < b.r).map(g => d.regionOf[g]))].join(',')}`);
                const cnt = rowsArr.map((r) => {
                    const by = {};
                    for (let j = 0; j < r.base; j++) {
                        const i = r.src[j];
                        if (Math.hypot(P[i * 3] - b.centre[0], P[i * 3 + 1] - b.centre[1], P[i * 3 + 2] - b.centre[2]) < b.r) by[r.label[j]] = (by[r.label[j]] ?? 0) + 1;
                    }
                    return JSON.stringify(by);
                });
                let srcIn = 0;
                for (let i = 0; i < N; i++) if (Math.hypot(P[i * 3] - b.centre[0], P[i * 3 + 1] - b.centre[1], P[i * 3 + 2] - b.centre[2]) < b.r) srcIn++;
                console.log(`      rows in the ball per piece by label: ${cnt.join(' / ')}, source splats ${srcIn}, pieces ${cs.pieces.map(q => `[${q.lo.toFixed(1)}, ${q.hi.toFixed(1)}] coarse [${q.coarseLo.toFixed(1)}, ${q.coarseHi.toFixed(1)}]`).join(' ')}`);
            });
        }

        // criteria
        const isMain = coarseMode !== 'none' && coarseMode !== 'thin' && !twin && budget === null && !variant;
        const ref = variant ? (() => {
            const clean = rowsFor(cs, states, false);
            const cc = clean.rowsArr.map(r => compactOf(r.pos, r.sigma, r.alpha, r.rgb));
            const cr = runPipeline(cc, up);
            return { rowsArr: clean.rowsArr, run: cr, res: evaluateCase(cs, states, clean.rowsArr, cr, null) };
        })() : null;
        if (isMain) {
            check('wrong hidden rows <= 1 %', res.wrong <= 0.01 * res.hidden, pct(res.wrong / Math.max(1, res.hidden)), where);
            check('neutral hidden rows <= 10 %', res.neutral <= 0.1 * res.hidden, pct(res.neutral / Math.max(1, res.hidden)), where);
            if (res.recallCells > 0) check('recall of coarse rows inside overlaps >= 75 %', res.recall >= 0.75, `${pct(res.recall)} of ${res.recallCells}`, where);
            if (focus && Number.isFinite(res.recallFocus)) check('recall of focus-coarse rows >= 85 %', res.recallFocus >= 0.85, pct(res.recallFocus), where);
            if (focus) res.balls.forEach(b => check(`focus ball ${b.ball}: one suggestion, right winner, >= 70 % of its hidden rows`, b.ok, `${pct(b.share)} of ${b.total}, winner ${b.winner + 1} (focus ${b.focus + 1})`, where));
            check('suggestions with the wrong winner = 0', res.wrongWinner === 0, String(res.wrongWinner), where);
            check('hidden rows without a visible winner point nearby <= 0.5 %', res.lonely <= 0.005, pct(res.lonely), where);
            check('coverage loss <= 0.2 pp', res.coverage.loss <= 0.002, `${(res.coverage.loss * 100).toFixed(3)} pp`, where);
            if (res.holeCoverage) check('coverage loss in dropped halves and holes <= 2 %', res.holeCoverage.loss <= 0.02, `${(res.holeCoverage.loss * 100).toFixed(2)} pp`, where);
            if (n === 4) check('cells + detail + paint <= 10 s (4 pieces)', run.times.total <= 10, `${run.times.total.toFixed(1)} s`, where);
        }
        if (coarseMode === 'none' && !variant && budget === null && !twin && !layersN) {
            check('coarse none: 0 clear suggestions', res.clear === 0, String(res.clear), where);
            check('coarse none: hidden <= 0.2 % of the overlap rows', res.overlapHidden <= 0.002, pct(res.overlapHidden), where);
        }
        if (coarseMode === 'thin' && !variant && !focus) check('coarse thin: 0 suggestions', res.regions === 0, String(res.regions), where);
        if (twin) check('twin: 0 suggestions', res.twinRegions === 0, `${res.twinRegions}${res.regions > res.twinRegions ? ` (other suggestions: ${res.regions - res.twinRegions})` : ''}; cells where one twin strongly beats the other ${res.twinStrong}`, where);
        if (layersN) {
            const ballText = b => `${pct(b.share)} of ${b.total}, winner ${b.winner + 1}, losers ${b.losers.map(l => l + 1).join('+') || '-'}, hidden per coarse layer ${b.perLoser.map(pct).join(' / ')}`;
            // with twins the two fine layers share the ball cell by cell (one
            // owner per cell), so 'one suggestion' is reported, not required
            // (drop: ball 2 is meant to lose its suggestion)
            res.balls.forEach((b) => {
                if (twin || (layerCase === 'drop' && b.ball === 1)) console.log(`   layers: ball ${b.ball}: ${ballText(b)}`);
                else {
                    check(`layers: ball ${b.ball} one suggestion, right winner, >= 70 % of its hidden rows`, b.ok, ballText(b), where);
                    check(`layers: ball ${b.ball} every coarse layer is a loser of that suggestion`, b.losersOk, ballText(b), where);
                }
            });
            check('layers: wrong hidden rows <= 1 %', res.wrong <= 0.01 * res.hidden, pct(res.wrong / Math.max(1, res.hidden)), where);
            // neutral rows: the cells along the balls' edges are partly
            // outside them (reported, not required here)
            console.log(`   layers: neutral hidden rows ${pct(res.neutral / Math.max(1, res.hidden))} (cells along the balls' edges)`);
            check('layers: coverage loss <= 0.2 pp', res.coverage.loss <= 0.002, `${(res.coverage.loss * 100).toFixed(3)} pp`, where);
            if (cs.shift) {
                // a few hundred rows, 6 cm off: big blurred splats at the
                // patch's edge reach the winner's surface (2.6-4.5 cm off
                // after their scatter) and are covered there; 5 % catches a
                // patch the layer does not lie off (on a rough spot 40 %)
                // with twins the two fine layers own the ball cell by cell, so
                // the shifted layer's paint is split over several regions
                // (each batch measures its own separation, rn grows to 4-5 cm):
                // reported, not required
                if (twin) console.log(`   layers: shifted layer, hidden rows on its horizontal surfaces ${res.shiftFlatHidden} of ${res.shiftFlat} (twins: reported)`);
                else check('layers: shifted layer, hidden rows on its horizontal surfaces <= 5 %', res.shiftFlatHidden <= 0.05 * Math.max(1, res.shiftFlat), `${res.shiftFlatHidden} of ${res.shiftFlat}`, where);
                // the other losers' rows where the shifted layer's apart
                // cluster left a kept region: none hidden after the leave,
                // and the paint had covered some of them before it (so the
                // test sees the case it guards). With twins the ball regions
                // have the coarse layer as their only loser, nothing to keep
                // for others; with drop the region is gone as a whole
                const left = leftRows(run);
                const othersLeft = left.filter((t, s) => s !== cs.shift.layer);
                const before = othersLeft.reduce((sum, t) => sum + t.coveredBefore, 0), after = othersLeft.reduce((sum, t) => sum + t.hiddenAfter, 0);
                const leftText = `other layers in cells that left: covered before the leave ${before}, hidden after it ${after} (per layer ${left.map(t => `${t.cells} cells ${t.rows} rows ${t.coveredBefore}/${t.hiddenAfter}`).join(' | ')})`;
                if (!twin && layerCase !== 'drop') check('layers: the other losers\' rows where an apart cluster left the region are not hidden (and were covered before)', after === 0 && before > 0, leftText, where);
                else console.log(`   layers: ${leftText}`);
                check('layers: an apart cluster of the shifted layer is listed', res.shiftApart > 0, `${res.shiftApart}; kept candidates in cells that left their region ${pin.keptLeft}`, where);
            }
            const multi = Array.from(run.byBatchId.values()).filter(e => e.losers.length > 1);
            if (layerCase === 'drop') {
                // a region with 2+ losers dropped as apart: its entry names the
                // shifted layer (the loser with the most apart cells, not the
                // first loser) with that layer's own separation
                const hits = multi.filter(e => run.applied.dropped.includes(e.region.id) || !run.detail.regions.includes(e.region)).map((e) => {
                    const entry = run.detail.rejected.find(q => q.reason === 'apart' && q.cells === e.cells);
                    return { e, entry };
                }).filter(x => x.entry);
                const good = hits.filter(({ e, entry }) => entry.loser === cs.shift.layer && e.losers[0] !== cs.shift.layer && Math.abs(entry.value - Math.abs(cs.shift.d)) < 0.02);
                check('layer case drop: a region with 2+ losers dropped as apart names the shifted layer (not its first loser) with its own separation', good.length > 0,
                    hits.map(({ e, entry }) => `region losers ${e.losers.map(l => l + 1).join('+')} -> apart ${entry.winner + 1}->${entry.loser + 1}, ${entry.cells.length} cells, value ${len(entry.value)}`).join('; ') || 'no multi-loser region dropped as apart', where);
            }
            if (layerCase === 'rebuild') {
                // loserCheck took a loser that is not coarser over the hide
                // cells out of a region and built it again with the rest
                // (required once over the cases, after the loop; with 4 twin
                // layers it is a coarse layer at a ball's edge); no
                // suggestion between the twins (the twin check)
                const d = run.detail;
                // a core without the count cannot tell a missing path from a
                // missing diagnostic: stop
                if (typeof d.diag?.loserRebuilt !== 'number') throw new Error('--layer-case rebuild: this core reports no diag.loserRebuilt');
                const rebuilt = d.diag.loserRebuilt;
                rebuildTotal += rebuilt;
                const coarse = d.regions.filter(r => r.winner <= 1 && !r.losers.includes(1 - r.winner)).map(r => `${r.winner + 1} replaces ${r.losers.map(l => l + 1).join('+')}`);
                console.log(`   layer case rebuild: rebuilt ${rebuilt}, dropped ${d.diag?.loserDropped ?? '-'}, suggestions between the twins ${res.twinRegions}; twin suggestions over the coarse layers: ${coarse.join(', ') || 'none'}`);
            }
            console.log(`   layers: regions with several losers ${run.detail.regions.filter(r => r.losers.length > 1).length} of ${run.detail.regions.length} (before the paint ${multi.length}); dropped ${run.applied.dropped.length}; diag ${JSON.stringify(run.detail.diag ?? {})}; ${pin.text}`);
        }
        if (budget !== null) {
            check('budget: a base-scope card, not clear', res.baseCards >= 1 && res.baseClear === 0, `${res.baseCards} base, ${res.baseClear} clear`, where);
            if (focus) res.balls.forEach(b => check(`budget: focus ball ${b.ball} still one object card`, b.ok && b.shape === 'object' && b.scope === 'local', `${pct(b.share)}, winner ${b.winner + 1}, ${b.shape} ${b.scope}`, where));
            check('budget: ticked cards hide <= 3 % of the high-budget pieces\' neutral shared rows', res.budgetNeutral <= 0.03, pct(res.budgetNeutral), where);
        }
        if (ref) {
            const jac = jaccard(res.hiddenSet, ref.res.hiddenSet, rowsArr);
            if (exposure !== null) check(`exposure ${exposure}: Jaccard >= 0.97`, jac >= 0.97, jac.toFixed(4), where);
            if (fogN || floaterN) {
                check('fog/floaters: Jaccard >= 0.95', jac >= 0.95, jac.toFixed(4), where);
                if (res.nearFloaters !== undefined) check('floaters: hidden rows within 10 cm of a fine clump <= 0.5 %', res.nearFloaters <= 0.005, `${pct(res.nearFloaters)} (${res.nearFloaterRows} of ${res.hidden})`, where);
                check('fog/floaters: no region only in the air', res.airRegions === 0, String(res.airRegions), where);
            }
            if (offset !== null && offset < 0.05) {
                check(`offset ${offset}: wrong <= 1 %`, res.wrong <= 0.01 * res.hidden, pct(res.wrong / Math.max(1, res.hidden)), where);
                if (Number.isFinite(res.recall) && Number.isFinite(ref.res.recall)) check(`offset ${offset}: recall drop <= 10 points`, ref.res.recall - res.recall <= 0.1, `${pct(ref.res.recall)} -> ${pct(res.recall)}`, where);
            }
            if (offset !== null && offset >= 0.05) {
                check(`offset ${offset}: no rows hidden where the moved piece lies apart (horizontal surfaces; <= 0.5 % of its rows there)`, res.piece1HiddenFlat <= 0.005 * Math.max(1, res.piece1FlatRows),
                    `${res.piece1HiddenFlat} of ${res.piece1FlatRows} horizontal rows (all hidden rows involving it ${res.piece1Hidden}), apart ${pct(res.piece1Apart)} of its ${res.piece1Cells} shared cells`, where);
                // twins without a suggestion between them paint nothing
                // there, so nothing can be found apart
                if (!twin) check(`offset ${offset}: rejected apart clusters listed`, res.apartClusters > 0, String(res.apartClusters), where);
            }
            if (scaleF !== null) {
                if (res.holeCoverage) check(`scale ${scaleF}: hole metrics unchanged`, res.holeCoverage.loss <= Math.max(0.02, (ref.res.holeCoverage?.loss ?? 0) + 0.005), `${(res.holeCoverage.loss * 100).toFixed(2)} pp (clean ${((ref.res.holeCoverage?.loss ?? 0) * 100).toFixed(2)})`, where);
                check(`scale ${scaleF}: wrong <= 1 %`, res.wrong <= 0.01 * res.hidden, pct(res.wrong / Math.max(1, res.hidden)), where);
            }
            console.log(`   reference (clean): ${ref.res.regions} suggestions, hidden ${ref.res.hidden}, recall ${pct(ref.res.recall)}, Jaccard ${jac.toFixed(4)}`);
        }
        if (has('determinism') && s === 0) {
            const again = runPipeline(compact, up);
            const h1 = hashOf(run), h2 = hashOf(again);
            check('determinism: identical SHA-256 of two runs', h1 === h2, `${h1.slice(0, 16)} / ${h2.slice(0, 16)}`, where);
            console.log(`   sha256 ${h1}`);
        }
        if (paintDir) {
            rowsArr.forEach((r, k) => {
                const nR = r.alpha.length;
                const scale = new Float32Array(nR * 3), rot = new Float32Array(nR * 4);
                for (let j = 0; j < nR; j++) {
                    const i = r.src[j];
                    for (let a = 0; a < 3; a++) scale[j * 3 + a] = i >= 0 ? SRC.scale[i * 3 + a] * r.factor[j] : r.factor[j];
                    if (i >= 0) for (let a = 0; a < 4; a++) rot[j * 4 + a] = SRC.rot[i * 4 + a];
                    else rot[j * 4] = 1;
                }
                writePly(join(paintDir, `case${n}-${seed}-piece${k + 1}.ply`), { pos: r.pos, rgb: r.rgb, alpha: r.alpha, scale, rot });
                const marked = r.rgb.slice();
                const p = run.applied.paint[k];
                for (let j = 0; j < nR; j++) {
                    if (!p[j]) continue;
                    const col = p[j] & 0x8000 ? [1, 0.85, 0] : [1, 0, 0];
                    for (let a = 0; a < 3; a++) marked[j * 3 + a] = col[a];
                }
                writePly(join(paintDir, `case${n}-${seed}-piece${k + 1}-marked.ply`), { pos: r.pos, rgb: marked, alpha: r.alpha, scale, rot });
            });
        }
        const plain = { ...res };
        delete plain.hiddenSet;
        const cards = cardsOf(run, res.perRegion).map(q => ({ ...q, moved: offset !== null && (q.winner === 1 || q.losers.includes(1)), twinPair: twin && q.winner <= 1 && q.losers.includes(1 - q.winner) }));
        if (has('clear-diag')) cards.forEach(q => console.log(`   clear-diag ${cardLine(q)}${q.moved ? ' (moved piece)' : ''}`));
        rows.push({ pieces: n, seed, cell: run.cell, times: run.times, ...plain, diag: run.detail.diag, cards, coverage: res.coverage, regionsList: run.detail.regions.map(r => ({ id: r.id, winner: r.winner, losers: r.losers, scope: r.scope, shape: r.shape, confidence: r.confidence, cells: r.cells.length, strong: r.strongCells, lead: r.lead, perLoser: r.perLoser })) });
    }
}

// --layer-case rebuild: the path ran (the cases' twin checks hold too)
if (layerCase === 'rebuild') check('layer case rebuild: loserCheck rebuilt a region with fewer losers (over the cases)', rebuildTotal > 0, `rebuilt ${rebuildTotal}`, 'all cases');

// ---------------------------------------------------------------- summary

console.log('\nsummary');
const groups = new Map();
checksAll.forEach((c) => {
    const key = c.name.replace(/ball \d+/, 'ball');
    const g = groups.get(key) ?? { ok: 0, total: 0, misses: [] };
    g.total++;
    if (c.ok) g.ok++;
    else g.misses.push(`${c.where}: ${c.value}`);
    groups.set(key, g);
});
groups.forEach((g, name) => console.log(`  ${g.ok === g.total ? 'ok  ' : 'MISS'} ${name}: ${g.ok}/${g.total}${g.misses.length ? ` (${g.misses.slice(0, 4).join('; ')}${g.misses.length > 4 ? ' ...' : ''})` : ''}`));
const timesAll = rows.map(r => r.times.total);
console.log(`  times cells + detail + paint: median ${quantile(timesAll, 0.5).toFixed(1)} s, max ${Math.max(...timesAll).toFixed(1)} s`);
const sum = k => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
console.log(`  hidden ${sum('hidden').toLocaleString()}: right ${pct(sum('right') / Math.max(1, sum('hidden')))}, neutral ${pct(sum('neutral') / Math.max(1, sum('hidden')))}, wrong ${pct(sum('wrong') / Math.max(1, sum('hidden')))}`);
// loserCheck and the confirmation over all cases (see composeDetail diag)
const diagSum = k => rows.reduce((a, r) => a + (r.diag?.[k] ?? 0), 0);
if (has('haze-diag')) {
    const all = Object.entries(hazeTotals).sort((a, b) => b[1] - a[1]);
    const n = all.reduce((a, [, v]) => a + v, 0);
    const by = t => all.filter(([k2]) => k2.startsWith(t)).reduce((a, [, v]) => a + v, 0);
    console.log(`  haze-diag: ${n} haze rows hidden: right ${by('right')}, neutral ${by('neutral')}, wrong ${by('wrong')}; ${all.slice(0, 12).map(([k2, v]) => `${k2} ${v}`).join(', ')}`);
}
console.log(`  diag: unconfirmed cells ${diagSum('unconfirmed')}, loserCheck dropped ${diagSum('loserDropped')} raw regions, rebuilt ${diagSum('loserRebuilt')}, without a loser (listed as small) ${diagSum('loserless')}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ args, constants, rows, checks: checksAll }, null, 1));
if (option('grow-diag', null)) writeFileSync(option('grow-diag'), JSON.stringify(growRecords));
process.exit(failures ? 1 : 0);
