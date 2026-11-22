/**
 * Floater detection on PLY files: node scripts/test-floaters.mjs <file.ply> [...]
 *
 * Transpiles src/analysis/floaters.ts with the repo's TypeScript into
 * node_modules/.cache and runs it on each file the way the editor does (world
 * space after the PLY load rotation, linear scales and opacity). Prints the
 * statistics and, when ground truth is known, hits and false alarms at the
 * strictness levels of the cleanup panel:
 * - <file>.truth.json next to the file: { "floaters": [[start, end), ...] }
 *   (row ranges, end exclusive), optional "labels": [{ "name", "ranges" }]
 * - wall-floaters.ply / wall-fog.ply: rows from 6400 on are the floaters.
 *
 * --json <out.json> writes the per-file numbers for the FORK-NOTES table.
 * --paint <dir> writes <dir>/<name>-floaters-<n>.ply: a copy with the
 *   candidates at the normal level painted (red detached, yellow isolated,
 *   magenta fog), and <dir>/<name>-cleaned-<n>.ply without them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules', '.cache', 'floaters-test');

const code = readFileSync(join(root, 'src', 'analysis', 'floaters.ts'), 'utf8');
const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }
}).outputText;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'floaters.mjs'), js);
const { detectFloaters } = await import(pathToFileURL(join(out, 'floaters.mjs')).href);

// the strictness levels of the panel (src/floaters/floater-finder.ts LEVELS)
const LEVELS = [
    { name: '1 mild', threshold: 0.85 },
    { name: '2', threshold: 0.7 },
    { name: '3 normal', threshold: 0.5 },
    { name: '4', threshold: 0.35 },
    { name: '5 strict', threshold: 0.2 }
];

const readPly = (file) => {
    const buf = readFileSync(file);
    const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
    const header = buf.subarray(0, headerEnd).toString('latin1').split('\n');
    let count = 0;
    const props = [];
    let inVertex = false;
    for (const line of header) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === 'element') {
            inVertex = parts[1] === 'vertex';
            if (inVertex) count = parseInt(parts[2], 10);
        } else if (parts[0] === 'property' && inVertex) {
            props.push({ type: parts[1], name: parts[2] });
        }
    }
    const sizes = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, int: 4, uint: 4, short: 2, ushort: 2 };
    let stride = 0;
    const offsets = {};
    for (const p of props) {
        offsets[p.name] = { offset: stride, type: p.type };
        stride += sizes[p.type];
    }
    const view = new DataView(buf.buffer, buf.byteOffset + headerEnd, count * stride);
    const get = (name, i) => {
        const o = offsets[name];
        const at = i * stride + o.offset;
        switch (o.type) {
            case 'double': return view.getFloat64(at, true);
            case 'uchar': case 'uint8': return view.getUint8(at);
            default: return view.getFloat32(at, true);
        }
    };
    const positions = new Float32Array(count * 3);
    const scales = new Float32Array(count * 3);
    const opacities = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        // PLY load rotation of the editor: 180 degrees about z
        positions[i * 3] = -get('x', i);
        positions[i * 3 + 1] = -get('y', i);
        positions[i * 3 + 2] = get('z', i);
        scales[i * 3] = Math.exp(get('scale_0', i));
        scales[i * 3 + 1] = Math.exp(get('scale_1', i));
        scales[i * 3 + 2] = Math.exp(get('scale_2', i));
        opacities[i] = 1 / (1 + Math.exp(-get('opacity', i)));
    }
    return { positions, scales, opacities, count };
};

const truthFor = (file, count) => {
    const sidecar = file.replace(/\.ply$/i, '.truth.json');
    if (existsSync(sidecar)) {
        const t = JSON.parse(readFileSync(sidecar, 'utf8'));
        const mask = new Uint8Array(count);
        for (const [a, b] of t.floaters) mask.fill(1, a, b);
        const labels = (t.labels ?? []).map((l) => {
            const m = new Uint8Array(count);
            for (const [a, b] of l.ranges) m.fill(1, a, b);
            return { name: l.name, mask: m };
        });
        return { mask, labels, partial: !!t.partial };
    }
    const name = basename(file);
    if (name === 'wall-floaters.ply' || name === 'wall-fog.ply') {
        const mask = new Uint8Array(count);
        mask.fill(1, 6400);
        return { mask, labels: [], partial: false };
    }
    return null;
};

const args = process.argv.slice(2);
let jsonOut = null;
let paintDir = null;
let debugBig = false;
let debugLabel = null;
const files = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') jsonOut = args[++i];
    else if (args[i] === '--paint') paintDir = args[++i];
    else if (args[i] === '--debug-big') debugBig = true;
    else if (args[i] === '--debug-label') debugLabel = args[++i];
    else files.push(args[i]);
}

// copy of the PLY with the candidates of a level painted
const paint = (file, result, threshold) => {
    const buf = Buffer.from(readFileSync(file));
    const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
    const header = buf.subarray(0, headerEnd).toString('latin1').split('\n');
    const props = [];
    let inVertex = false;
    for (const line of header) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === 'element') inVertex = parts[1] === 'vertex';
        else if (parts[0] === 'property' && inVertex) props.push(parts[2]);
    }
    const stride = props.length * 4;
    const at = name => props.indexOf(name) * 4;
    const dc = [at('f_dc_0'), at('f_dc_1'), at('f_dc_2')];
    const rest = props.map((name, k) => (name.startsWith('f_rest_') ? k * 4 : -1)).filter(o => o >= 0);
    const colors = { 1: [1, 1, 0], 2: [1, 0, 0], 3: [1, 0, 1] };
    const limit = Math.round(threshold * 255);
    const view = new DataView(buf.buffer, buf.byteOffset + headerEnd);
    for (let i = 0; i < result.probability.length; i++) {
        if (!(result.probability[i] >= limit && result.probability[i] > 0)) continue;
        const c = colors[result.reason[i]] ?? [0, 1, 1];
        for (let a = 0; a < 3; a++) view.setFloat32(i * stride + dc[a], (c[a] - 0.5) / 0.28209479, true);
        for (const o of rest) view.setFloat32(i * stride + o, 0, true);
    }
    // a new name every run: the editor's service worker caches loaded files
    const stem = basename(file).replace(/\.ply$/i, '');
    for (const old of readdirSync(paintDir)) {
        if (old.startsWith(`${stem}-floaters-`) && old.endsWith('.ply')) unlinkSync(join(paintDir, old));
    }
    const tag = Date.now() % 100000;
    const target = join(paintDir, `${stem}-floaters-${tag}.ply`);
    writeFileSync(target, buf);
    console.log(`  painted: ${target}`);
    // the scan without the candidates (original colours)
    for (const old of readdirSync(paintDir)) {
        if (old.startsWith(`${stem}-cleaned-`) && old.endsWith('.ply')) unlinkSync(join(paintDir, old));
    }
    const original = readFileSync(file);
    const body = original.subarray(headerEnd);
    const keep = [];
    for (let i = 0; i < result.probability.length; i++) {
        if (!(result.probability[i] >= limit && result.probability[i] > 0)) keep.push(i);
    }
    const kept = Buffer.alloc(keep.length * stride);
    keep.forEach((i, k) => body.copy(kept, k * stride, i * stride, (i + 1) * stride));
    const cleanHeader = original.subarray(0, headerEnd).toString('latin1').replace(/element vertex \d+/, `element vertex ${keep.length}`);
    const cleaned = join(paintDir, `${stem}-cleaned-${tag}.ply`);
    writeFileSync(cleaned, Buffer.concat([Buffer.from(cleanHeader, 'latin1'), kept]));
    console.log(`  cleaned: ${cleaned} (${result.probability.length - keep.length} removed)`);
};
if (files.length === 0) {
    files.push(join(root, 'test-data', 'wall-floaters.ply'), join(root, 'test-data', 'wall-fog.ply'));
}

const report = [];
for (const file of files) {
    const t0 = Date.now();
    const data = readPly(file);
    const readMs = Date.now() - t0;
    let lastProgress = 0;
    const result = detectFloaters(data, {
        debug: debugBig || !!debugLabel,
        onProgress: (p) => {
            lastProgress = p;
        }
    });
    const s = result.stats;
    console.log(`\n${basename(file)}: ${data.count} splats (read ${readMs} ms), detect ${s.ms} ms, cell ${s.cell.toPrecision(3)}, pieces ${s.pieces} (structure ${s.structurePieces} with ${s.structureSplats}), candidates ${s.candidates}, groups ${s.groups}, progress ${lastProgress}, phases ${JSON.stringify(s.phases)}`);
    const truth = truthFor(file, data.count);
    const entry = { file: basename(file), splats: data.count, ms: s.ms, levels: [] };
    for (const level of LEVELS) {
        const limit = Math.round(level.threshold * 255);
        let selected = 0, hits = 0, falseAlarms = 0, floaters = 0;
        const labelHits = truth ? truth.labels.map(() => 0) : [];
        const groupsAt = new Set();
        for (let i = 0; i < data.count; i++) {
            const sel = result.probability[i] >= limit && result.probability[i] > 0;
            if (sel) {
                selected++;
                groupsAt.add(result.group[i]);
            }
            if (truth) {
                if (truth.mask[i]) {
                    floaters++;
                    if (sel) hits++;
                } else if (sel) {
                    falseAlarms++;
                }
                truth.labels.forEach((l, li) => {
                    if (l.mask[i] && sel) labelHits[li]++;
                });
            }
        }
        const line = { level: level.name, selected, groups: groupsAt.size };
        if (truth) {
            const legit = data.count - floaters;
            Object.assign(line, { floaters, hits, recall: floaters ? hits / floaters : 0, falseAlarms, falseRate: legit ? falseAlarms / legit : 0 });
            truth.labels.forEach((l, li) => {
                const total = l.mask.reduce((a, v) => a + v, 0);
                line[`label:${l.name}`] = `${labelHits[li]}/${total}`;
            });
        }
        entry.levels.push(line);
        const extra = truth ? ` hits ${hits}/${floaters} (${(100 * line.recall).toFixed(1)} %), false alarms ${falseAlarms} (${(100 * line.falseRate).toFixed(3)} %)${truth.labels.length ? ' · ' + truth.labels.map((l, li) => `${l.name} ${line[`label:${l.name}`]}`).join(' · ') : ''}` : '';
        console.log(`  ${level.name.padEnd(8)} (>= ${level.threshold}): selected ${selected} in ${groupsAt.size} groups${extra}`);
    }
    const top = result.groups.slice().sort((a, b) => b.score - a.score || b.count - a.count).slice(0, 8);
    top.forEach((g) => {
        console.log(`    group ${g.id}: ${g.count} splats, score ${g.score.toFixed(2)}, ${g.kind}${g.airborne ? ', airborne' : ''}, gap ${Number.isFinite(g.gap) ? g.gap.toPrecision(3) : 'inf'}, centre ${g.center.map(v => v.toFixed(2)).join(' ')}`);
    });
    report.push(entry);
    if (debugLabel && truth) {
        // the missed splats of a label, per piece: why
        const d = result.debug;
        const label = truth.labels.find(l => l.name === debugLabel) ?? { mask: new Uint8Array(data.count) };
        const seen = new Map();
        for (let i = 0; i < data.count; i++) {
            if (!label.mask[i] || result.probability[i] >= 128) continue;
            const p = d.piece[i];
            const e = seen.get(p) ?? { rows: 0, count: d.pieceCount[i], structure: d.structure[i], isolation: d.isolation[i], size: d.sizeTerm[i], air: d.airborne[i], surface: d.onSurface[i], gap: d.gap[i], prob: result.probability[i] };
            e.rows++;
            seen.set(p, e);
        }
        const list = [...seen.values()].sort((a, b) => b.rows - a.rows).slice(0, 15);
        console.log(`  missed ${debugLabel}: ${[...seen.values()].reduce((a, e) => a + e.rows, 0)} splats in ${seen.size} pieces`);
        list.forEach(e => console.log(`    ${e.rows} missed of piece with ${e.count}: structure ${e.structure} isolation ${e.isolation.toFixed(2)} size ${e.size.toFixed(2)} airborne ${e.air} surface ${e.surface} gap ${e.gap.toPrecision(3)} prob ${(e.prob / 255).toFixed(2)}`));
    }
    if (debugBig) {
        // the large splats: how many are candidates, and where the rest are
        const d = result.debug;
        const fp = Array.from(d.footprint).filter(v => v > 0).sort((x, y) => x - y);
        const med = fp[Math.floor(fp.length / 2)];
        const bands = [[3, 6], [6, 10], [10, 1e9]];
        for (const [lo, hi] of bands) {
            let total = 0, cand = 0, inStructure = 0;
            for (let i = 0; i < data.count; i++) {
                if (d.footprint[i] < lo * med || d.footprint[i] >= hi * med) continue;
                total++;
                if (result.probability[i] >= 128) cand++;
                else if (d.structure[i]) inStructure++;
            }
            console.log(`  footprint ${lo}-${hi}x median: ${total} splats, candidates (normal) ${cand}, others in structure ${inStructure}`);
        }
    }
    if (paintDir) paint(file, result, 0.5);
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
