/**
 * Scan composition, phase 1 (src/compose/compose-core.ts) on synthetic pieces
 * of a real scan, with known truth:
 *
 *   node scripts/test-composition.mjs <scan.ply> [--near N] [--free N]
 *        [--pieces 3|4] [--points N] [--seed S] [--drift min,max] [--scale]
 *        [--json out.json] [--verbose]
 *
 * The scan is cut into 3-4 overlapping pieces along its longest horizontal
 * axis, as if scanned in separate passes:
 * - every piece keeps its own random 70 % of the points, plus 3 mm noise
 * - creeping drift: every piece is bent around its own centre (heading and
 *   pitch turn by 0.1-0.5 degrees from one end to the other; --drift sets
 *   the range)
 * - one stretch per piece is thinned to 1/6 (scanned coarsely there)
 * - then every piece is moved: "near" cases a little (up to 30 cm and 2
 *   degrees, separate passes in one frame), "free" cases anywhere (any
 *   heading, up to half the scan size away)
 *
 * Then it runs the wizard's steps on them: reference suggestion, attach order,
 * alignment of every piece onto the placed ones - once as the wizard does it
 * (zone step on) and once stopping after the ICP over the whole overlap - and
 * measures at every seam how far the same physical points end up apart.
 * Units are the scan's (metres for metric scans).
 *
 * Exit code 1 when a near case misses: reference not a middle piece, a piece
 * not aligned, or a seam median above 2 cm.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules', '.cache', 'composition-test');

// transpile the cores (relative imports get the .mjs extension)
const sources = ['compose/compose-core', 'align/global-align', 'align/icp', 'align/point-align'];
for (const name of sources) {
    const code = readFileSync(join(root, 'src', `${name}.ts`), 'utf8');
    let js = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }
    }).outputText;
    js = js.replace(/from '(\.\.?\/[^']+)'/g, 'from \'$1.mjs\'');
    const file = join(out, `${name}.mjs`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, js);
}
const core = await import(pathToFileURL(join(out, 'compose', 'compose-core.mjs')).href);
const { scanOverlap, composeAlign, transformPoints, concat } = core;

// ---------------------------------------------------------------- options

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const file = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!file) {
    console.log('usage: node scripts/test-composition.mjs <scan.ply> [--near N] [--free N] [--pieces 3|4] [--points N] [--seed S] [--json out.json]');
    process.exit(2);
}
const nearCases = parseInt(option('near', '12'), 10);
const freeCases = parseInt(option('free', '4'), 10);
const pieceCount = option('pieces', null);
const maxPoints = parseInt(option('points', '400000'), 10);
const seed0 = parseInt(option('seed', '1'), 10);
const jsonOut = option('json', null);
// drift: bend of each piece from one end to the other, in degrees (min,max)
const [driftMin, driftMax] = (option('drift', '0.1,0.5')).split(',').map(Number);
const verbose = args.includes('--verbose');
// solve uniform scale as well (the wizard's default)
const useScale = args.includes('--scale');

// ---------------------------------------------------------------- scan

const buf = readFileSync(file);
const headerEnd = buf.indexOf('end_header') + 'end_header'.length + 1;
const header = buf.subarray(0, headerEnd).toString();
const count = parseInt(/element vertex (\d+)/.exec(header)[1], 10);
const props = [...header.matchAll(/property float (\w+)/g)].map(m => m[1]);
const stride = props.length * 4;
const ix = props.indexOf('x');
const io = props.indexOf('opacity');
const step = Math.max(1, Math.ceil(count / (maxPoints * 1.6)));
const pts = [];
for (let i = 0; i < count; i += step) {
    const o = headerEnd + i * stride;
    if (io >= 0 && 1 / (1 + Math.exp(-buf.readFloatLE(o + io * 4))) < 0.3) continue;
    pts.push(buf.readFloatLE(o + ix * 4), buf.readFloatLE(o + ix * 4 + 4), buf.readFloatLE(o + ix * 4 + 8));
}
const P = new Float32Array(pts);
const N = P.length / 3;

// robust extent per axis: the smallest is "up", the largest horizontal the main axis
const extent = [0, 1, 2].map((k) => {
    const v = [];
    for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 50000))) v.push(P[i * 3 + k]);
    v.sort((a, b) => a - b);
    return { lo: v[Math.floor(v.length * 0.01)], hi: v[Math.floor(v.length * 0.99)] };
});
const sizes = extent.map(e => e.hi - e.lo);
const up = sizes.indexOf(Math.min(...sizes));
const main = [0, 1, 2].filter(k => k !== up).sort((a, b) => sizes[b] - sizes[a])[0];
const trans = [0, 1, 2].find(k => k !== up && k !== main);
const L = sizes[main];
const diag = Math.hypot(...sizes);
console.log(`${file}: ${count.toLocaleString()} splats, ${N.toLocaleString()} points used, size ${sizes.map(s => s.toFixed(1)).join(' x ')} (main axis ${'xyz'[main]}, up ${'xyz'[up]})`);

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

const unit = k => [0, 1, 2].map(i => (i === k ? 1 : 0));

// rotation (row-major 3x3) about a unit axis
const rotation = (axis, angle) => {
    const [x, y, z] = axis;
    const c = Math.cos(angle), s = Math.sin(angle), v = 1 - c;
    return [c + x * x * v, x * y * v - z * s, x * z * v + y * s, y * x * v + z * s, c + y * y * v, y * z * v - x * s, z * x * v - y * s, z * y * v + x * s, c + z * z * v];
};
const rot = (R, p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
const mul3 = (a, b) => {
    const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return r;
};
const apply4 = (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
];
const quantile = (v, q) => {
    if (!v.length) return NaN;
    const s = v.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const fmt = v => (Number.isFinite(v) ? (v < 0.1 ? `${(v * 1000).toFixed(1)} mm` : `${(v * 100).toFixed(1)} cm`) : '-');

// ---------------------------------------------------------------- pieces

const makeCase = (seed, family) => {
    const random = rng(seed * 7919 + (family === 'free' ? 101 : 0));
    const n = pieceCount ? parseInt(pieceCount, 10) : (random() < 0.5 ? 3 : 4);
    const overlap = 0.25 + random() * 0.15;
    const len = L / (n - (n - 1) * overlap);
    const stepLen = len * (1 - overlap);
    const v = unit(up), t = unit(trans);
    const pieces = [];
    for (let k = 0; k < n; k++) {
        const lo = extent[main].lo + k * stepLen;
        const hi = lo + len;
        const centre = [0, 0, 0];
        centre[main] = (lo + hi) / 2;
        centre[up] = (extent[up].lo + extent[up].hi) / 2;
        centre[trans] = (extent[trans].lo + extent[trans].hi) / 2;
        // drift: heading and pitch turn along the piece
        const bend = () => (driftMin + random() * (driftMax - driftMin)) * Math.PI / 180 * (random() < 0.5 ? -1 : 1);
        const yaw = bend();
        const pitch = bend();
        // the coarse stretch
        const coarseLo = lo + random() * len * 0.75;
        const coarseHi = coarseLo + len * 0.25;
        // the move
        let R, shift;
        if (family === 'near') {
            const heading = (random() * 4 - 2) * Math.PI / 180;
            const tilt = (random() - 0.5) * Math.PI / 180;
            R = mul3(rotation(v, heading), rotation(t, tilt));
            shift = [0, 1, 2].map(() => (random() * 2 - 1) * 0.3 * Math.min(1, diag / 30));
        } else {
            const heading = random() * Math.PI * 2;
            const tilt = (random() * 6 - 3) * Math.PI / 180;
            R = mul3(rotation(v, heading), rotation(t, tilt));
            shift = [0, 1, 2].map(() => (random() * 2 - 1) * 0.5 * L);
        }
        if (k === 0 && family === 'near') {
            // one piece stays as scanned, like the first pass
            R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
            shift = [0, 0, 0];
        }
        const truth = (p) => {
            // drift around the piece centre, then the move about the centre
            const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
            const s = (d[main]) / len;
            const bent = rot(mul3(rotation(v, yaw * s), rotation(t, pitch * s)), d);
            const moved = rot(R, bent);
            return [moved[0] + centre[0] + shift[0], moved[1] + centre[1] + shift[1], moved[2] + centre[2] + shift[2]];
        };
        const idx = [];
        const xyz = [];
        for (let i = 0; i < N; i++) {
            const m = P[i * 3 + main];
            if (m < lo || m > hi) continue;
            if (random() > 0.7) continue;
            if (m > coarseLo && m < coarseHi && random() > 1 / 6) continue;
            const q = truth([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
            idx.push(i);
            xyz.push(q[0] + (random() - 0.5) * 0.006, q[1] + (random() - 0.5) * 0.006, q[2] + (random() - 0.5) * 0.006);
        }
        pieces.push({ lo, hi, idx: new Int32Array(idx), points: new Float32Array(xyz), truth });
    }
    return { family, n, overlap, pieces };
};

// ---------------------------------------------------------------- run

// the wizard's steps on the pieces; returns the corrections per piece
const compose = (pieces, zoneStep) => {
    const t0 = Date.now();
    const overlapResult = scanOverlap(pieces.map(p => p.points));
    const E = pieces.map(() => null);
    const alternatives = pieces.map(() => []);
    E[overlapResult.reference] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const steps = [];
    for (const { scan } of overlapResult.order) {
        const placed = pieces.map((p, k) => (E[k] ? transformPoints(E[k], p.points) : null)).filter(Boolean);
        const result = composeAlign(pieces[scan].points, concat(placed), {
            coarse: 'auto',
            scale: useScale,
            zoneStep,
            onNote: verbose ? text => console.log(`         ${scan + 1}: ${text}`) : undefined
        });
        E[scan] = result.matrix;
        alternatives[scan] = result.alternatives ?? [];
        steps.push({ scan, coarse: result.coarse, fitBefore: result.fitBefore, fitAfter: result.fitAfter, zones: result.zones.length, used: result.usedZone, offset: result.zones[result.usedZone]?.after?.median ?? null });
        if (verbose) {
            const z = result.zones[result.usedZone];
            console.log(`      piece ${scan + 1}: ${result.coarse}, fit ${result.fitBefore.toFixed(2)} -> ${result.fitAfter.toFixed(2)}, ${result.zones.length} zones, used ${result.usedZone}` +
                `${z ? ` (${z.voxels} voxels, offset ${fmt(z.before?.median)} -> ${fmt(z.after?.median)}, blocks ${z.after?.blocks ?? '-'})` : ''}, correction ${result.angleDeg.toFixed(2)} deg / ${fmt(result.shift)}`);
        }
    }
    return { overlap: overlapResult, E, alternatives, steps, seconds: (Date.now() - t0) / 1000 };
};

// how far the same physical points end up apart at every seam
const seams = (pieces, E) => {
    const res = [];
    for (let a = 0; a < pieces.length; a++) {
        for (let b = a + 1; b < pieces.length; b++) {
            const lo = Math.max(pieces[a].lo, pieces[b].lo);
            const hi = Math.min(pieces[a].hi, pieces[b].hi);
            if (lo >= hi) continue;
            // whole overlap, and the middle fifth of it (where a seam goes)
            const d = [];
            const band = [];
            const mid = (lo + hi) / 2;
            const half = (hi - lo) * 0.1;
            for (let i = 0; i < N; i += 5) {
                const m = P[i * 3 + main];
                if (m < lo || m > hi) continue;
                const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
                const pa = apply4(E[a], pieces[a].truth(p));
                const pb = apply4(E[b], pieces[b].truth(p));
                const e = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
                d.push(e);
                if (Math.abs(m - mid) <= half) band.push(e);
            }
            res.push({ pair: `${a + 1}-${b + 1}`, median: quantile(band, 0.5), p90: quantile(band, 0.9), overlapMedian: quantile(d, 0.5), overlapP90: quantile(d, 0.9) });
        }
    }
    return res;
};

const cases = [];
for (let s = 0; s < nearCases; s++) cases.push(['near', seed0 + s]);
for (let s = 0; s < freeCases; s++) cases.push(['free', seed0 + s]);

const rows = [];
let failures = 0;
for (const [family, seed] of cases) {
    const c = makeCase(seed, family);
    const withZone = compose(c.pieces, true);
    const overlapOnly = compose(c.pieces, false);
    const middle = withZone.overlap.reference > 0 && withZone.overlap.reference < c.n - 1;
    const sz = seams(c.pieces, withZone.E);
    const so = seams(c.pieces, overlapOnly.E);
    const aligned = withZone.steps.every(s => s.coarse !== 'failed');
    // for every piece placed by a search and off by more than 2 cm: would one
    // of its alternatives have been right? (seam to its partner below 2 cm)
    const rescued = [];
    withZone.steps.filter(st => st.coarse === 'global').forEach((st) => {
        const k = st.scan;
        const own = seams(c.pieces, withZone.E).filter(x => x.pair.split('-').map(Number).includes(k + 1));
        if (!own.length || Math.min(...own.map(x => x.median)) <= 0.02) return;
        const hit = withZone.alternatives[k].findIndex((alt) => {
            const E2 = withZone.E.slice();
            E2[k] = alt.matrix;
            const sm = seams(c.pieces, E2).filter(x => x.pair.split('-').map(Number).includes(k + 1));
            return sm.length && Math.min(...sm.map(x => x.median)) <= 0.02;
        });
        rescued.push(`${k + 1}:${hit >= 0 ? `alternative ${hit + 1}/${withZone.alternatives[k].length}` : `none of ${withZone.alternatives[k].length}`}`);
    });
    const worst = Math.max(...sz.map(s => s.median));
    const ok = middle && aligned && worst <= 0.02;
    if (family === 'near' && !ok) failures++;
    rows.push({
        family,
        seed,
        pieces: c.n,
        overlap: c.overlap,
        reference: withZone.overlap.reference + 1,
        middle,
        coarse: withZone.steps.map(s => s.coarse),
        seams: sz,
        seamsOverlapOnly: so,
        seconds: withZone.seconds,
        measured: withZone.steps.map(s => s.offset)
    });
    console.log(`${family} #${seed}: ${c.n} pieces, overlap ${(c.overlap * 100).toFixed(0)} %, reference ${withZone.overlap.reference + 1}${middle ? '' : ' (not a middle piece!)'}, ` +
        `rough pose ${withZone.steps.map(s => `${s.scan + 1}:${s.coarse}`).join(' ')}, ${withZone.seconds.toFixed(1)} s`);
    sz.forEach((s, i) => {
        console.log(`   seam ${s.pair}: ${fmt(s.median)} (90 % ${fmt(s.p90)}), whole overlap ${fmt(s.overlapMedian)} (90 % ${fmt(s.overlapP90)})   ` +
            `overlap ICP only: ${fmt(so[i].median)}, whole ${fmt(so[i].overlapMedian)}`);
    });
    console.log(`   measured offset at the used zone: ${withZone.steps.map(s => `${s.scan + 1}: ${fmt(s.offset)}`).join(', ')}${ok || family === 'free' ? '' : '   <- MISS'}`);
    if (rescued.length) console.log(`   wrong place found by the search; the right one among the alternatives: ${rescued.join(', ')}`);
}

const near = rows.filter(r => r.family === 'near');
const free = rows.filter(r => r.family === 'free');
const allSeams = rs => rs.flatMap(r => r.seams.map(s => s.median));
const allSeamsOverlap = rs => rs.flatMap(r => r.seamsOverlapOnly.map(s => s.median));
console.log('\nsummary');
if (near.length) {
    console.log(`  near: ${near.length - failures}/${near.length} ok, reference a middle piece ${near.filter(r => r.middle).length}/${near.length}, ` +
        `seam median ${fmt(quantile(allSeams(near), 0.5))} (worst ${fmt(Math.max(...allSeams(near)))}), overlap ICP only ${fmt(quantile(allSeamsOverlap(near), 0.5))} (worst ${fmt(Math.max(...allSeamsOverlap(near)))})`);
}
if (free.length) {
    const found = free.filter(r => r.coarse.every(c => c !== 'failed') && Math.max(...r.seams.map(s => s.median)) <= 0.02).length;
    const pieces = free.reduce((sum, r) => sum + r.coarse.length, 0);
    const placed = free.reduce((sum, r) => sum + r.coarse.filter(c => c !== 'failed').length, 0);
    console.log(`  free: ${found}/${free.length} cases fully found (seams <= 2 cm), ${placed}/${pieces} pieces placed, the rest left where they were and flagged`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
process.exit(failures ? 1 : 0);
