/**
 * Unit test of the shot generator (src/ai-shots): node scripts/test-shot-generator.mjs
 *
 * Transpiles the generator sources with the repo's TypeScript into
 * node_modules/.cache (so `playcanvas` resolves to the repo's copy) and checks
 * them on synthetic splat clouds: elevation limits, the frames formula,
 * ascending integer keys, no camera inside dense voxels, clamping of requests,
 * determinism and the character of each template.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules', '.cache', 'shot-generator-test');

const sources = ['ai-shots/shot-types', 'ai-shots/coverage', 'ai-shots/shot-generator', 'anim/spline'];
for (const name of sources) {
    const code = readFileSync(join(root, 'src', `${name}.ts`), 'utf8');
    const js = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }
    }).outputText.replace(/from '(\.{1,2}\/[^']+)'/g, 'from \'$1.mjs\'');
    const file = join(out, `${name}.mjs`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, js);
}

const load = name => import(pathToFileURL(join(out, `${name}.mjs`)).href);
const { Vec3 } = await import('playcanvas');
const { SHOT_LIMITS, SHOT_TEMPLATES } = await load('ai-shots/shot-types');
const { buildCoverageField } = await load('ai-shots/coverage');
const { generateShots, elevationOf, azimuthOf } = await load('ai-shots/shot-generator');
const { CubicSpline } = await load('anim/spline');

let failures = 0;
let checks = 0;
const check = (ok, message) => {
    checks++;
    if (!ok) {
        failures++;
        console.log(`  FAIL ${message}`);
    }
};

// deterministic pseudo random numbers
const rng = (seed) => {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

// synthetic scan: a box-like object on a ground plane, optional wall and
// floaters; `front` keeps only the +Z half of the object's surface
const makeScene = ({ size = [1, 1.6, 0.6], wall = false, front = false, floaters = 0, seed = 1 }) => {
    const rand = rng(seed);
    const pts = [];
    const [hx, hy, hz] = size.map(v => v / 2);
    const cy = hy;
    // object surface
    for (let i = 0; i < 60000; i++) {
        const face = Math.floor(rand() * 6);
        const u = rand() * 2 - 1, v = rand() * 2 - 1;
        let p;
        switch (face) {
            case 0: p = [hx, u * hy, v * hz]; break;
            case 1: p = [-hx, u * hy, v * hz]; break;
            case 2: p = [u * hx, hy, v * hz]; break;
            case 3: p = [u * hx, -hy, v * hz]; break;
            case 4: p = [u * hx, v * hy, hz]; break;
            default: p = [u * hx, v * hy, -hz]; break;
        }
        if (front && p[2] < 0) continue;
        pts.push(p[0], p[1] + cy, p[2]);
    }
    // ground 8 x 8
    for (let i = 0; i < 60000; i++) pts.push(rand() * 8 - 4, 0, rand() * 8 - 4);
    // wall at x = 1.6, 3 wide, 2.5 high
    if (wall) {
        for (let i = 0; i < 30000; i++) pts.push(1.6, rand() * 2.5, rand() * 3 - 1.5);
    }
    for (let i = 0; i < floaters; i++) pts.push(rand() * 8 - 4, rand() * 4, rand() * 8 - 4);

    const points = new Float32Array(pts);
    const weights = new Float32Array(points.length / 3).fill(0.9);
    const bounds = { min: new Vec3(-4, -0.05, -4), max: new Vec3(4, 4, 4) };
    const coverage = buildCoverageField(points, weights, bounds, 64);
    const half = new Vec3(hx, hy, hz);
    const object = {
        center: new Vec3(0, cy, 0),
        halfExtents: half,
        radius: half.length(),
        sceneCenter: new Vec3(0, 2, 0),
        sceneRadius: new Vec3(4, 2, 4).length(),
        source: 'box'
    };
    return { coverage, object };
};

const splineSamples = (keys, step = 1) => {
    const times = keys.map(k => k.frame);
    const pos = [], tgt = [];
    keys.forEach((k) => {
        pos.push(k.position.x, k.position.y, k.position.z);
        tgt.push(k.target.x, k.target.y, k.target.z);
    });
    const ps = CubicSpline.fromPoints(times, pos, 1);
    const ts2 = CubicSpline.fromPoints(times, tgt, 1);
    const last = times[times.length - 1];
    const result = [];
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let f = 0; f <= last; f += step) {
        ps.evaluate(f, a);
        ts2.evaluate(f, b);
        result.push({ frame: f, position: new Vec3(a[0], a[1], a[2]), target: new Vec3(b[0], b[1], b[2]) });
    }
    return result;
};

const serialize = list => JSON.stringify(list, (k, v) => (v instanceof Vec3 ? [v.x, v.y, v.z] : v));

// checks that hold for every proposal
const checkProposal = (p, ctx) => {
    const { fps, object, coverage } = ctx;
    const tag = `[${ctx.name}] ${p.id}`;
    const { keys } = p;
    check(p.frames === Math.round(p.params.durationSec * fps) + 1, `${tag}: frames = round(T*fps)+1 (${p.frames})`);
    check(keys[0].frame === 0, `${tag}: first key at 0`);
    check(keys[keys.length - 1].frame === p.frames - 1, `${tag}: last key at frames-1`);
    check(keys.every((k, i) => Number.isInteger(k.frame) && (i === 0 || k.frame > keys[i - 1].frame)), `${tag}: keys ascending integers`);
    check(keys.length >= 3, `${tag}: at least 3 keys (${keys.length})`);
    if (p.params.template !== 'orbit') check(keys.length <= 6, `${tag}: at most 6 keys (${keys.length})`);
    check(p.score >= 0 && p.score <= 1, `${tag}: score in 0..1`);
    check(p.title === `sm.aishots.template.${p.params.template}` || p.title === p.params.label, `${tag}: title`);
    check(p.params.durationSec >= 3 && p.params.durationSec <= 30, `${tag}: duration in range`);
    check(p.params.distanceFactor >= 0.6 && p.params.distanceFactor <= 3 * (ctx.distanceScale ?? 1), `${tag}: distance factor in range`);
    check(p.params.heightFactor >= -0.3 && p.params.heightFactor <= 1.5, `${tag}: height factor in range`);

    const maxElev = p.params.template === 'flyover' ? 75 : 80;
    for (const k of keys) {
        const e = elevationOf(k.position, k.target);
        check(Math.abs(e) <= maxElev, `${tag}: key elevation ${e.toFixed(1)} at ${k.frame}`);
        check(k.position.distance(k.target) > 1e-6, `${tag}: target != position at ${k.frame}`);
        check(k.position.distance(k.target) <= 8 * object.sceneRadius + 1e-6, `${tag}: distance <= 8 scene radii`);
        if (coverage) check(coverage.occupancy(k.position) < 0.5, `${tag}: key ${k.frame} not in a dense voxel`);
        if (p.params.focusPull) {
            check(Math.abs(k.focus - k.position.distance(k.target)) < 1e-6, `${tag}: focus = eye-target distance`);
            check(k.aperture >= 0 && k.aperture <= 0.5, `${tag}: aperture in range`);
        } else {
            check(k.focus === undefined && k.aperture === undefined, `${tag}: no focus keys without focusPull`);
        }
    }
    // the camera track's interpolation between the keys
    for (const s of splineSamples(keys)) {
        const e = elevationOf(s.position, s.target);
        if (Math.abs(e) > maxElev) {
            check(false, `${tag}: spline elevation ${e.toFixed(1)} at frame ${s.frame}`);
            break;
        }
        if (s.position.distance(s.target) < 1e-6) {
            check(false, `${tag}: spline target == position at ${s.frame}`);
            break;
        }
    }
    if (coverage && !p.warnings.includes('sm.aishots.warn.collision')) {
        const bad = splineSamples(keys, 2).find(s => coverage.occupancy(s.position) >= 0.5);
        check(!bad, `${tag}: spline through dense voxel at ${bad?.frame} without collision warning`);
    }
};

const describe = (p) => {
    const k0 = p.keys[0], k1 = p.keys[p.keys.length - 1];
    const fmt = v => v.toFixed(2);
    return `${p.id.padEnd(10)} score ${fmt(p.score)}  ${String(p.frames).padStart(4)} fr  keys ${String(p.keys.length).padStart(2)}  ` +
        `az ${azimuthOf(p.keys[0].target, k0.position).toFixed(0).padStart(3)}->${azimuthOf(k1.target, k1.position).toFixed(0).padStart(3)}  ` +
        `el ${elevationOf(k0.position, k0.target).toFixed(0).padStart(3)}->${elevationOf(k1.position, k1.target).toFixed(0).padStart(3)}  ` +
        `d ${fmt(k0.position.distance(k0.target))}->${fmt(k1.position.distance(k1.target))}  ${p.warnings.join(',')}`;
};

const run = (name, scene, opts) => {
    const fps = opts.fps ?? 30;
    const t0 = performance.now();
    const list = generateShots(scene.object, { fps, fov: 60, anchors: [], coverage: scene.coverage, ...opts });
    const ms = performance.now() - t0;
    console.log(`\n${name} (${ms.toFixed(0)} ms)`);
    list.forEach(p => console.log(`  ${describe(p)}`));
    list.forEach(p => checkProposal(p, { name, fps, object: scene.object, coverage: scene.coverage }));
    return list;
};

const byTemplate = (list, t) => list.find(p => p.params.template === t);

// --- coverage field ----------------------------------------------------------
{
    console.log('coverage field');
    const t0 = performance.now();
    const scene = makeScene({ wall: true, floaters: 3000 });
    console.log(`  built in ${(performance.now() - t0).toFixed(0)} ms`);
    const { coverage } = scene;
    check(coverage.occupancy(new Vec3(0.5, 0.8, 0)) >= 0.5, 'object surface is dense');
    check(coverage.occupancy(new Vec3(0, 0.8, 0)) < 0.5, 'object interior is empty');
    check(coverage.occupancy(new Vec3(0, 3.5, 2)) < 0.5, 'floaters are not dense');
    check(coverage.clearance(new Vec3(0.5, 0.8, 0)) === 0, 'clearance 0 on the surface');
    const c = coverage.clearance(new Vec3(-2, 2, -2));
    check(c > 1 && c < 2.2, `clearance in free space ~1.8 (${c.toFixed(2)})`);
    check(coverage.clearance(new Vec3(0, 20, 0)) > 15, 'clearance far outside the grid');
    const open = coverage.visibility(new Vec3(-3, 1.2, 0), new Vec3(0, 0.8, 0), 1);
    const walled = coverage.visibility(new Vec3(3, 1.2, 0), new Vec3(0, 0.8, 0), 1);
    console.log(`  visibility open side ${open.toFixed(2)}, behind wall ${walled.toFixed(2)}`);
    check(open > 0.6, 'open side well visible');
    check(walled < 0.25, 'wall blocks the view');

    const half = makeScene({ front: true });
    const frontVis = half.coverage.visibility(new Vec3(0, 1.2, 3), new Vec3(0, 0.8, 0), 1);
    const backVis = half.coverage.visibility(new Vec3(0, 1.2, -3), new Vec3(0, 0.8, 0), 1);
    console.log(`  half scan: front ${frontVis.toFixed(2)}, back ${backVis.toFixed(2)}`);
    check(frontVis > backVis + 0.2, 'scanned side rates better than the missing side');
}

// --- default set -------------------------------------------------------------
{
    const scene = makeScene({ wall: true, floaters: 2000 });
    const list = run('default set, wall at +X', scene, {});
    check(list.length === 6, 'six proposals by default');
    check(new Set(list.map(p => p.params.template)).size === 6, 'one per template');
    check(list.every((p, i) => i === 0 || list[i - 1].score >= p.score), 'sorted by score');

    const again = generateShots(scene.object, { fps: 30, fov: 60, anchors: [], coverage: scene.coverage });
    check(serialize(list) === serialize(again), 'deterministic');

    // the push-in avoids the wall side (+X, azimuth 90)
    const push = byTemplate(list, 'pushIn');
    const pushAz = azimuthOf(scene.object.center, push.keys[0].position);
    check(Math.abs(((pushAz - 90 + 540) % 360) - 180) > 60, `pushIn not towards the wall (az ${pushAz.toFixed(0)})`);

    // orbit: partial sweep, slightly from above, smooth ease
    const orbit = byTemplate(list, 'orbit');
    check(orbit.params.sweepDeg >= 120 && orbit.params.sweepDeg <= 180, 'orbit sweep 120..180');
    const els = orbit.keys.map(k => elevationOf(k.position, k.target));
    check(els.every(e => e > 5 && e < 35), `orbit slightly from above (${els.map(e => e.toFixed(0)).join(' ')})`);
    const sweepDone = Math.abs(((azimuthOf(orbit.keys.at(-1).target, orbit.keys.at(-1).position) - azimuthOf(orbit.keys[0].target, orbit.keys[0].position)) + 540) % 360 - 180);
    check(orbit.warnings.includes('sm.aishots.warn.collision') || Math.abs(sweepDone - Math.min(orbit.params.sweepDeg, 360 - orbit.params.sweepDeg)) < 2, `orbit covers its sweep (${sweepDone.toFixed(0)})`);

    // ease in / out: slow start and end, faster in the middle
    for (const p of list) {
        const s = splineSamples(p.keys);
        const speed = i => s[i + 1].position.distance(s[i].position);
        const mid = Math.floor(s.length / 2);
        const startRatio = speed(0) / speed(mid);
        const endRatio = speed(s.length - 2) / speed(mid);
        check(startRatio < 0.45 && endRatio < 0.45, `${p.id}: eases in/out (start ${startRatio.toFixed(2)}, end ${endRatio.toFixed(2)} of mid speed)`);
        // no surges: the peak speed stays near the cruise speed of the profile
        const speeds = s.slice(1).map((_, i) => speed(i));
        const avg = speeds.reduce((x, y) => x + y, 0) / speeds.length;
        const peak = Math.max(...speeds) / avg;
        check(peak < 1.75, `${p.id}: even speed (peak ${peak.toFixed(2)} x average)`);
        console.log(`  ${p.id.padEnd(10)} speed start ${startRatio.toFixed(2)}, end ${endRatio.toFixed(2)} of mid, peak ${peak.toFixed(2)} x average`);
    }

    // crane rises and comes a little closer
    const crane = byTemplate(list, 'crane');
    const c0 = crane.keys[0], c1 = crane.keys.at(-1);
    check(c1.position.y - c0.position.y > 0.5 * scene.object.radius, 'crane rises');
    check(c1.position.distance(c1.target) < c0.position.distance(c0.target), 'crane approaches');

    // reveal starts close and low, pulls back
    const reveal = byTemplate(list, 'reveal');
    const r0 = reveal.keys[0], r1 = reveal.keys.at(-1);
    check(r0.position.distance(scene.object.center) < r1.position.distance(scene.object.center) * 0.75, 'reveal pulls back');
    check(r0.position.y < r1.position.y, 'reveal starts lower');
    check(r0.target.distance(scene.object.center) > 0.2 * scene.object.radius && r1.target.distance(scene.object.center) < 1e-6, 'reveal target wanders from the edge to the centre');

    // slide runs parallel to the longest horizontal axis (x here)
    const slide = byTemplate(list, 'slide');
    const sd = slide.keys.at(-1).position.clone().sub(slide.keys[0].position);
    check(Math.abs(sd.x) > 5 * Math.abs(sd.z) && Math.abs(sd.y) < 1e-6, `slide parallel to the main axis (${sd.x.toFixed(2)}, ${sd.y.toFixed(2)}, ${sd.z.toFixed(2)})`);
    const st = slide.keys.at(-1).target.clone().sub(slide.keys[0].target);
    check(st.length() > 0 && st.length() < sd.length() * 0.6, 'slide target moves less than the camera (parallax)');

    // push-in approaches
    const p0 = push.keys[0], p1 = push.keys.at(-1);
    check(p1.position.distance(p1.target) < 0.85 * p0.position.distance(p0.target), 'pushIn approaches');

    // flyover: constant height, tilting down, never past 75 degrees
    const fly = byTemplate(list, 'flyover');
    check(fly.keys.every(k => Math.abs(k.position.y - fly.keys[0].position.y) < 1e-6 || fly.warnings.includes('sm.aishots.warn.collision')), 'flyover at constant height');
    const fe = fly.keys.map(k => elevationOf(k.position, k.target));
    check(fe.every((e, i) => i === 0 || e >= fe[i - 1] - 1e-6), `flyover tilts down (${fe.map(e => e.toFixed(0)).join(' ')})`);
    check(Math.max(...fe) > 60 && Math.max(...fe) <= 75, 'flyover ends steep but <= 75');
}

// --- half scan: shots look at the scanned side -------------------------------
{
    const scene = makeScene({ front: true });
    const list = run('half scan (+Z side only)', scene, {});
    const push = byTemplate(list, 'pushIn');
    const az = azimuthOf(scene.object.center, push.keys[0].position);
    check(Math.abs(((az + 540) % 360) - 180) < 60, `pushIn from the scanned side (az ${az.toFixed(0)})`);
}

// --- anchors -----------------------------------------------------------------
{
    const scene = makeScene({});
    const c = scene.object.center;
    const anchorAt = (az, d, h) => ({
        position: new Vec3(c.x + Math.sin(az * Math.PI / 180) * d, c.y + h, c.z + Math.cos(az * Math.PI / 180) * d),
        target: c.clone(),
        fov: 50
    });
    const anchors = [anchorAt(200, 2.4, 0.6), anchorAt(250, 2.0, 0.3)];
    const list = run('two anchors (az 200, 250)', scene, { anchors });
    const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

    const orbit = byTemplate(list, 'orbit');
    const orbitAz = splineSamples(orbit.keys).map(s => azimuthOf(c, s.position));
    check(anchors.every(a => orbitAz.some(az => diff(az, azimuthOf(c, a.position)) < 5)), 'orbit passes both anchors');

    // anchors go round-robin to pushIn, reveal, crane, flyover, slide
    const push = byTemplate(list, 'pushIn');
    check(diff(azimuthOf(c, push.keys[0].position), 200) < 5, 'pushIn from the first anchor');
    check(Math.abs(push.keys.at(-1).position.distance(c) - 2.4) < 0.05, 'pushIn lands at the anchor distance');

    const reveal = byTemplate(list, 'reveal');
    check(diff(azimuthOf(c, reveal.keys.at(-1).position), 250) < 5, 'reveal ends at the second anchor');
    check(Math.abs(reveal.keys.at(-1).position.distance(c) - 2.0) < 0.05, 'reveal ends at the anchor distance');

    const crane = byTemplate(list, 'crane');
    check(diff(azimuthOf(c, crane.keys.at(-1).position), 200) < 5, 'crane ends at the first anchor');

    const fly = byTemplate(list, 'flyover');
    check(diff(azimuthOf(c, fly.keys[0].position), 250) < 5, 'flyover arrives from the second anchor');
}

// --- distance setting (panel slider) ----------------------------------------------
{
    const scene = makeScene({});
    const c = scene.object.center;
    const meanDist = list => list.reduce((s, p) => s + p.keys.reduce((t, k) => t + k.position.distance(c), 0) / p.keys.length, 0) / list.length;
    const run = distanceScale => generateShots(scene.object, { fps: 30, fov: 60, anchors: [], distanceScale });
    const base = run(1);
    const far = run(2);
    const near = run(0.6);
    far.forEach(p => checkProposal(p, { fps: 30, object: scene.object, name: 'distance x2', distanceScale: 2 }));
    near.forEach(p => checkProposal(p, { fps: 30, object: scene.object, name: 'distance x0.6' }));
    check(meanDist(far) > meanDist(base) * 1.5, `distanceScale 2 moves the camera further away (${meanDist(base).toFixed(2)} -> ${meanDist(far).toFixed(2)})`);
    check(meanDist(near) < meanDist(base) * 0.9, `distanceScale 0.6 moves the camera closer (${meanDist(base).toFixed(2)} -> ${meanDist(near).toFixed(2)})`);
    const req = [{ template: 'orbit', durationSec: 6, distanceFactor: 2, heightFactor: 0.3 }];
    const r1 = generateShots(scene.object, { fps: 30, fov: 60, anchors: [], requests: req });
    const r2 = generateShots(scene.object, { fps: 30, fov: 60, anchors: [], requests: req, distanceScale: 1.5 });
    check(Math.abs(r2[0].params.distanceFactor / r1[0].params.distanceFactor - 1.5) < 0.01, 'distanceScale applies to Claude requests');
}

// --- camera height style and picked move ----------------------------------------
{
    const scene = makeScene({ size: [3, 4, 2] });
    const o = scene.object;
    const ground = o.center.y - o.halfExtents.y;
    const top = o.center.y + o.halfExtents.y;
    const run = extra => generateShots(o, { fps: 30, fov: 60, anchors: [], coverage: scene.coverage, ...extra });
    const ctx = name => ({ fps: 30, object: o, name, distanceScale: 1.5 });

    const groundShots = run({ style: 'ground' });
    groundShots.forEach(p => checkProposal(p, ctx('ground')));
    check(groundShots.every(p => !['crane', 'flyover'].includes(p.params.template)), 'ground: no crane or flyover');
    const groundYs = groundShots.flatMap(p => p.keys.map(k => k.position.y - ground));
    check(Math.max(...groundYs) < 2.5 && Math.min(...groundYs) > 0.2, `ground: camera stays near eye level (${Math.min(...groundYs).toFixed(2)}..${Math.max(...groundYs).toFixed(2)})`);

    const aerialShots = run({ style: 'aerial' });
    aerialShots.forEach(p => checkProposal(p, ctx('aerial')));
    check(aerialShots.every(p => p.keys.every(k => k.position.y > top)), 'aerial: camera always above the object');

    const lowShots = run({ style: 'low' });
    lowShots.forEach(p => checkProposal(p, ctx('low')));
    check(lowShots.every(p => p.keys.every(k => k.position.y - ground < 1)), 'low: camera close to the ground');

    const orbits = run({ templates: ['orbit'] });
    orbits.forEach(p => checkProposal(p, ctx('orbit variants')));
    check(orbits.length === 6 && orbits.every(p => p.params.template === 'orbit'), `one picked move gives 6 variants of it (${orbits.length})`);
    check(new Set(orbits.map(p => p.params.sweepDeg + p.params.direction)).size >= 4, 'variants differ in sweep and direction');

    const pushes = run({ templates: ['pushIn'], style: 'ground' });
    pushes.forEach(p => checkProposal(p, ctx('pushIn ground')));
    check(new Set(pushes.map(p => Math.round(p.params.startAngleDeg / 10))).size >= 3, 'push-in variants come from different sides');
    check(run({ templates: ['orbit', 'slide'] }).every(p => ['orbit', 'slide'].includes(p.params.template)), 'several picked moves: only those');
}

// --- requests (Claude) ---------------------------------------------------------
{
    const scene = makeScene({ wall: true });
    const requests = [
        { template: 'orbit', durationSec: 100, distanceFactor: 9, heightFactor: 4, sweepDeg: 720, direction: 'cw', easing: 'linear', focusPull: false, label: 'Big orbit' },
        { template: 'pushIn', durationSec: 1, distanceFactor: 0.1, heightFactor: -2, focusPull: true, easing: 'smooth', startAngleDeg: 270 },
        { template: 'slide', durationSec: 8, distanceFactor: 2, heightFactor: 0.3, sweepDeg: 300, startAngleDeg: 30, direction: 'ccw' },
        { template: 'flyover', durationSec: 12.5, distanceFactor: 3, heightFactor: 1.5, startAngleDeg: 0, focusPull: true },
        { template: 'reveal', durationSec: 5, distanceFactor: 2, heightFactor: 0.2, startAngleDeg: null, direction: null },
        { template: 'nonsense', durationSec: 5 }
    ];
    const list = run('requests, out of range', scene, { requests, fps: 24 });
    check(list.length === 5, 'invalid template dropped');
    check(list.map(p => p.id).join(',') === 'orbit-0,pushIn-1,slide-2,flyover-3,reveal-4', `request order and ids (${list.map(p => p.id).join(',')})`);
    const [orbit, push, slide, fly] = list;
    check(orbit.params.durationSec === 30 && orbit.frames === 721, 'duration clamped to 30 s');
    check(orbit.params.sweepDeg === 360, 'sweep clamped to 360');
    check(orbit.title === 'Big orbit', 'label used as title');
    check(orbit.keys.length >= 13, 'full orbit keyed about every 30 degrees');
    check(push.params.durationSec === 3 && push.frames === 73, 'duration clamped to 3 s');
    check(push.params.heightFactor === -0.3, 'height clamped');
    check(push.keys.every(k => k.focus > 0), 'focus pull keys');
    check(slide.params.sweepDeg <= 120, 'slide sweep limited');
    check(slide.params.startAngleDeg === 0 || slide.params.startAngleDeg === 180, `slide snapped to a side across the main axis (${slide.params.startAngleDeg})`);
    check(fly.frames === Math.round(12.5 * 24) + 1, 'fractional duration');
}

// --- no coverage, odd inputs ---------------------------------------------------
{
    const object = {
        center: new Vec3(10, 0, -5),
        halfExtents: new Vec3(3, 0.2, 0.5),
        radius: new Vec3(3, 0.2, 0.5).length(),
        sceneCenter: new Vec3(0, 0, 0),
        sceneRadius: 30,
        source: 'scene'
    };
    const list = run('no coverage, flat wide object', { object }, { fps: 60, durationSec: 4, count: 4 });
    check(list.length === 4, 'count respected');
    check(list.every(p => p.params.durationSec === 4 && p.frames === 241), 'duration option used');
    check(SHOT_TEMPLATES.length === 6 && SHOT_LIMITS.durationSec[1] === 30, 'shared limits');

    const tiny = { ...object, halfExtents: new Vec3(0, 0, 0), radius: 0, sceneRadius: 0.001 };
    const t = generateShots(tiny, { fps: 1, fov: 0, anchors: [] });
    t.forEach(p => checkProposal(p, { name: 'degenerate', fps: 1, object: tiny }));
    check(t.every(p => p.keys.every(k => [k.position.x, k.position.y, k.position.z].every(Number.isFinite))), 'degenerate object stays finite');
}

// --- reveal close and high: the wandering target must not pass under the camera
{
    const object = {
        center: new Vec3(0, 0, 0),
        halfExtents: new Vec3(1, 0.5, 1),
        radius: new Vec3(1, 0.5, 1).length(),
        sceneCenter: new Vec3(0, 0, 0),
        sceneRadius: 5,
        source: 'box'
    };
    const requests = [{ template: 'reveal', durationSec: 8, distanceFactor: 0.6, heightFactor: 1.5, startAngleDeg: 0, sweepDeg: 90, easing: 'smooth' }];
    const [p] = generateShots(object, { fps: 30, fov: 60, anchors: [], requests });
    checkProposal(p, { name: 'steep reveal', fps: 30, object });
    const steepest = Math.max(...splineSamples(p.keys).map(s => elevationOf(s.position, s.target)));
    console.log(`\nsteep reveal: steepest spline elevation ${steepest.toFixed(1)}`);
    check(steepest <= 80, `steep reveal stays <= 80 between the keys (${steepest.toFixed(1)})`);
}

// --- pushIn from an explicit side keeps its own end distance -------------------
{
    const scene = makeScene({});
    const c = scene.object.center;
    const r = scene.object.radius;
    const anchor = { position: new Vec3(c.x - 2.6 * r, c.y, c.z), target: c.clone(), fov: 50 }; // azimuth 270
    const push = (startAngleDeg) => {
        const requests = [{ template: 'pushIn', durationSec: 6, distanceFactor: 3, heightFactor: 0, startAngleDeg }];
        const [p] = generateShots(scene.object, { fps: 30, fov: 60, anchors: [anchor], coverage: scene.coverage, requests });
        const k0 = p.keys[0], k1 = p.keys.at(-1);
        return k1.position.distance(k1.target) / k0.position.distance(k0.target);
    };
    const opposite = push(90);
    const towards = push(260);
    console.log(`\npushIn with an anchor at 270: from 90 ends at ${opposite.toFixed(2)}, from 260 at ${towards.toFixed(2)} of the start distance`);
    check(opposite < 0.7, `pushIn from the other side ignores the anchor distance (${opposite.toFixed(2)})`);
    check(towards > 0.75, `pushIn next to the anchor lands at the anchor distance (${towards.toFixed(2)})`);
}

// --- fuzz: random valid requests -------------------------------------------------
{
    const rand = rng(20261114);
    const pick = list => list[Math.floor(rand() * list.length)];
    const range = (lo, hi) => lo + rand() * (hi - lo);
    const scenes = [makeScene({ seed: 7 }), makeScene({ wall: true, floaters: 1500, seed: 8 }), makeScene({ size: [2.4, 0.5, 0.4], front: true, seed: 9 })];
    const bare = [
        { center: new Vec3(0, 0, 0), halfExtents: new Vec3(1, 0.5, 1), radius: new Vec3(1, 0.5, 1).length(), sceneCenter: new Vec3(0, 0, 0), sceneRadius: 5, source: 'box' },
        { center: new Vec3(10, 0, -5), halfExtents: new Vec3(3, 0.2, 0.5), radius: new Vec3(3, 0.2, 0.5).length(), sceneCenter: new Vec3(0, 0, 0), sceneRadius: 30, source: 'scene' },
        { center: new Vec3(0, 2, 0), halfExtents: new Vec3(0.2, 2, 0.2), radius: new Vec3(0.2, 2, 0.2).length(), sceneCenter: new Vec3(0, 2, 0), sceneRadius: 2.1, source: 'box' }
    ].map(object => ({ object }));
    const all = [...scenes, ...bare];

    const randomRequest = () => {
        const req = {
            template: pick(SHOT_TEMPLATES),
            durationSec: Math.round(range(3, 30) * 10) / 10,
            distanceFactor: range(0.6, 3),
            heightFactor: range(-0.3, 1.5),
            startAngleDeg: rand() < 0.3 ? null : range(0, 360),
            sweepDeg: rand() < 0.3 ? null : range(20, 360),
            direction: pick(['cw', 'ccw', null]),
            focusPull: rand() < 0.5,
            easing: rand() < 0.75 ? 'smooth' : 'linear'
        };
        // bias towards the corners of the ranges, where the limits bite
        if (rand() < 0.3) req.distanceFactor = pick([0.6, 0.7, 3]);
        if (rand() < 0.3) req.heightFactor = pick([-0.3, 1.2, 1.5]);
        return req;
    };
    const randomAnchors = (object) => {
        const n = Math.floor(rand() * 4);
        const list = [];
        for (let i = 0; i < n; i++) {
            const az = range(0, 360) * Math.PI / 180;
            const d = range(0.8, 3) * object.radius;
            list.push({ position: new Vec3(object.center.x + Math.sin(az) * d, object.center.y + range(-0.3, 1.5) * object.radius, object.center.z + Math.cos(az) * d), target: object.center.clone(), fov: 50 });
        }
        return list;
    };

    const failuresBefore = failures;
    let requestCount = 0;
    let steepest = 0;
    const t0 = performance.now();
    for (let call = 0; call < 1000; call++) {
        const scene = all[call % all.length];
        const fps = pick([24, 25, 30, 50, 60]);
        const anchors = randomAnchors(scene.object);
        const requests = Array.from({ length: 1 + Math.floor(rand() * 5) }, randomRequest);
        requestCount += requests.length;
        const opts = { fps, fov: range(30, 90), anchors, coverage: scene.coverage, requests };
        const list = generateShots(scene.object, opts);
        check(list.length === requests.length, `fuzz ${call}: one proposal per request`);
        const name = `fuzz ${call}`;
        for (const p of list) {
            checkProposal(p, { name, fps, object: scene.object, coverage: scene.coverage });
            for (const s of splineSamples(p.keys)) steepest = Math.max(steepest, Math.abs(elevationOf(s.position, s.target)));
        }
        if (call % 10 === 0) {
            check(serialize(list) === serialize(generateShots(scene.object, opts)), `${name}: deterministic`);
        }
        if (failures - failuresBefore > 40) {
            console.log('  fuzz: too many failures, stopping');
            break;
        }
    }
    console.log(`\nfuzz: ${requestCount} requests in ${(performance.now() - t0).toFixed(0)} ms, steepest spline elevation ${steepest.toFixed(1)}`);
    check(requestCount >= 3000, `fuzz covers at least 3000 requests (${requestCount})`);
    check(steepest <= 80, `fuzz: spline elevation <= 80 at every frame (${steepest.toFixed(1)})`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
    console.log(`${failures} FAILED`);
    process.exit(1);
}
