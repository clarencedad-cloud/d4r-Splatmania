/**
 * Unit test of the live draft helpers of the shot suggestions:
 * node scripts/test-shot-draft.mjs
 *
 * - camera modifier (src/camera-modifier.ts): gait bob amplitude and step
 *   frequency, fade-out while standing, shake limits, apply / remove round trip
 * - clean-up step (src/ai-shots/shot-cleanup.ts): a roughly dragged orbit
 *   becomes smooth again, keeps the object in frame, stays clear of the
 *   geometry, keeps its length and has few keys
 * - walk-through (src/ai-shots/walk-path.ts): ground under clicked points,
 *   eye height, walking pace, the way around a wall, sparse keys
 *
 * Transpiles the sources like test-shot-generator.mjs (TypeScript of the repo,
 * output in node_modules/.cache).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules', '.cache', 'shot-draft-test');

const sources = ['ai-shots/shot-types', 'ai-shots/coverage', 'ai-shots/shot-generator', 'ai-shots/shot-cleanup', 'ai-shots/walk-path', 'camera-modifier', 'anim/spline'];
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
const { buildCoverageField } = await load('ai-shots/coverage');
const { generateShots, trackSplines } = await load('ai-shots/shot-generator');
const { cleanupShot } = await load('ai-shots/shot-cleanup');
const { WalkField, generateWalk } = await load('ai-shots/walk-path');
const { buildModifierTables, modifierOffset, applyModifierOffset, removeModifierOffset } = await load('camera-modifier');

let failures = 0;
let checks = 0;
const check = (ok, message) => {
    checks++;
    if (!ok) {
        failures++;
        console.log(`  FAIL ${message}`);
    }
};

const rand2 = (r, lo, hi) => lo + r() * (hi - lo);

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

// --- camera modifier ------------------------------------------------------

{
    console.log('camera modifier');
    const fps = 30;
    const frames = 600;
    const speed = 1.3;
    // walks 1.3 m/s from frame 60 to 480, stands before and after
    const position = (f, outV) => {
        const t = Math.min(480, Math.max(60, f));
        outV.set((t - 60) / fps * speed, 1.6, 0);
        return true;
    };
    const values = { bob: 0.03, stepRate: 1.9, shake: 0.5, shakeRate: 1.2 };
    const tables = buildModifierTables({ value: c => values[c], position }, frames, fps, 1);
    const m = { offset: new Vec3(), yaw: 0, pitch: 0 };
    const forward = new Vec3(1, 0, 0);

    // cruise: amplitude and step frequency
    let maxUp = 0;
    let crossings = 0;
    let prev = null;
    let maxSide = 0;
    for (let f = 120; f <= 420; f += 0.25) {
        modifierOffset(values, tables, f, forward, m);
        maxUp = Math.max(maxUp, Math.abs(m.offset.y));
        maxSide = Math.max(maxSide, Math.abs(m.offset.z));
        if (prev !== null && Math.sign(m.offset.y) !== Math.sign(prev) && m.offset.y !== 0) crossings++;
        prev = m.offset.y;
        check(Math.abs(m.offset.x) < 1e-9, `bob has no forward component (f ${f})`);
        check(Math.abs(m.yaw) <= values.shake + 1e-9, `yaw within the shake (f ${f}: ${m.yaw})`);
    }
    const seconds = 300 / fps;
    const steps = crossings / 2;
    check(Math.abs(maxUp - 0.03) < 0.002, `bob amplitude 3 cm (${maxUp.toFixed(4)})`);
    check(Math.abs(steps / seconds - 1.9) < 0.1, `step frequency 1.9 Hz (${(steps / seconds).toFixed(2)})`);
    check(maxSide > 0.015 && maxSide <= 0.03 * 0.8 + 1e-6, `sideways sway below the bob (${maxSide.toFixed(4)})`);

    // standing still: no bob (shake goes on)
    modifierOffset(values, tables, 20, forward, m);
    check(m.offset.length() < 1e-6, `no bob while standing (${m.offset.length()})`);
    check(Math.abs(m.yaw) > 0 || Math.abs(m.pitch) > 0, 'shake goes on while standing');
    modifierOffset(values, tables, 560, forward, m);
    check(m.offset.length() < 1e-6, 'no bob after stopping');

    // apply / remove round trip
    const rand = rng(7);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
        const p = new Vec3(rand() * 10, rand() * 3, rand() * 10);
        const t = new Vec3(p.x + rand() * 4 - 2, p.y + rand() * 2 - 1, p.z + rand() * 4 - 2);
        const f = rand() * frames;
        modifierOffset(values, tables, f, new Vec3().sub2(t, p), m);
        const p2 = p.clone();
        const t2 = t.clone();
        applyModifierOffset(p2, t2, m);
        removeModifierOffset(p2, t2, m);
        worst = Math.max(worst, p2.distance(p), t2.distance(t));
    }
    check(worst < 1e-6, `apply + remove restores the pose (${worst.toExponential(2)})`);

    // scale: a scene in centimetres (100 units per metre) walks the same
    const cm = (f, outV) => {
        position(f, outV);
        outV.mulScalar(100);
        return true;
    };
    const tablesCm = buildModifierTables({ value: c => values[c], position: cm }, frames, fps, 0.01);
    let same = true;
    for (let f = 0; f < frames; f += 7) {
        if (Math.abs(tablesCm.phase[f] - tables.phase[f]) > 1e-6) same = false;
    }
    check(same, 'phase independent of the scene scale');
}

// --- synthetic scene -------------------------------------------------------

const makeScene = ({ wall = false, seed = 1 } = {}) => {
    const rand = rng(seed);
    const pts = [];
    const size = [1, 1.6, 0.6];
    const [hx, hy, hz] = size.map(v => v / 2);
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
        pts.push(p[0], p[1] + hy, p[2]);
    }
    for (let i = 0; i < 60000; i++) pts.push(rand() * 8 - 4, 0, rand() * 8 - 4);
    if (wall) {
        for (let i = 0; i < 30000; i++) pts.push(1.6, rand() * 2.5, rand() * 3 - 1.5);
    }
    const points = new Float32Array(pts);
    const weights = new Float32Array(points.length / 3).fill(0.9);
    const bounds = { min: new Vec3(-4, -0.05, -4), max: new Vec3(4, 4, 4) };
    const coverage = buildCoverageField(points, weights, bounds, 64);
    const half = new Vec3(hx, hy, hz);
    const object = {
        center: new Vec3(0, hy, 0),
        halfExtents: half,
        radius: half.length(),
        sceneCenter: new Vec3(0, 2, 0),
        sceneRadius: new Vec3(4, 2, 4).length(),
        source: 'box'
    };
    return { coverage, object, points, weights, bounds };
};

// --- clean-up ---------------------------------------------------------------

{
    console.log('clean-up');
    const { coverage, object } = makeScene({ seed: 3 });
    const fps = 30;
    const fov = 60;
    const [orbit] = generateShots(object, { fps, fov, anchors: [], coverage, templates: ['orbit'], count: 1, durationSec: 10 });
    check(!!orbit, 'orbit generated');

    // drag the middle key 35 % of the radius outwards and up (rough edit)
    const draft = { ...orbit, keys: orbit.keys.map(k => ({ ...k, position: k.position.clone(), target: k.target.clone() })) };
    const mid = Math.floor(draft.keys.length / 2);
    const away = draft.keys[mid].position.clone().sub(object.center);
    away.y = 0;
    away.normalize().mulScalar(0.35 * object.radius * 3);
    draft.keys[mid].position.add(away);
    draft.keys[mid].position.y += 0.5;
    // and one key shifted in time: uneven speed
    if (draft.keys.length > 4) draft.keys[1].frame = Math.max(1, Math.round(draft.keys[1].frame * 0.4));

    const speedSpread = (keys) => {
        const at = trackSplines(keys);
        const last = keys[keys.length - 1].frame;
        const speeds = [];
        for (let f = Math.round(0.25 * last); f < Math.round(0.75 * last); f++) speeds.push(at(f + 1).position.distance(at(f).position));
        const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length);
        return sd / mean;
    };

    const before = speedSpread(draft.keys);
    const t0 = performance.now();
    const clean = cleanupShot(object, draft, { fov, coverage });
    const ms = performance.now() - t0;
    const after = speedSpread(clean.keys);
    console.log(`  speed spread ${before.toFixed(3)} -> ${after.toFixed(3)}, keys ${draft.keys.length} -> ${clean.keys.length}, ${ms.toFixed(0)} ms`);
    check(after < before, `speed more even after clean-up (${before.toFixed(3)} -> ${after.toFixed(3)})`);
    check(after < 0.12, `cruise speed nearly constant (${after.toFixed(3)})`);
    check(clean.frames === draft.frames, 'duration kept');
    check(clean.keys[0].frame === 0 && clean.keys[clean.keys.length - 1].frame === draft.frames - 1, 'keys span the move');
    check(clean.keys.every((k, i) => Number.isInteger(k.frame) && (i === 0 || k.frame > clean.keys[i - 1].frame)), 'keys ascending integers');
    check(clean.keys.length <= 40, `orbit keeps few keys (${clean.keys.length})`);
    check(clean.cleaned === true && clean.edited === false, 'marked as tidied');

    // object in frame: the centre within the frame for every frame
    const at = trackSplines(clean.keys);
    const halfH = fov / 2 * Math.PI / 180;
    const halfV = Math.atan(Math.tan(halfH) * 9 / 16);
    let worstOff = 0;
    for (let f = 0; f < clean.frames; f++) {
        const { position, target } = at(f);
        const fwd = new Vec3().sub2(target, position).normalize();
        const c = new Vec3().sub2(object.center, position);
        const z = c.dot(fwd);
        const right = new Vec3().cross(fwd, new Vec3(0, 1, 0)).normalize();
        const up = new Vec3().cross(right, fwd);
        const off = Math.max(Math.atan2(Math.abs(c.dot(right)), z) / halfH, Math.atan2(Math.abs(c.dot(up)), z) / halfV);
        worstOff = Math.max(worstOff, off);
    }
    check(worstOff < 0.75, `object centre stays well inside the frame (${worstOff.toFixed(2)} of the half field)`);

    // the dragged bump is smoothed: curvature of the tidied path stays low
    let worstTurn = 0;
    for (let f = 2; f < clean.frames - 2; f++) {
        const a = new Vec3().sub2(at(f).position, at(f - 2).position);
        const b = new Vec3().sub2(at(f + 2).position, at(f).position);
        if (a.length() < 1e-6 || b.length() < 1e-6) continue;
        worstTurn = Math.max(worstTurn, Math.acos(Math.min(1, a.dot(b) / (a.length() * b.length()))) * 180 / Math.PI);
    }
    check(worstTurn < 12, `no kinks (${worstTurn.toFixed(1)} degrees per 4 frames)`);

    // the shape the user made stays: the dragged region is still further out
    const dist = (p) => Math.hypot(p.x - object.center.x, p.z - object.center.z);
    const draftAt = trackSplines(draft.keys);
    const midFrame = draft.keys[mid].frame;
    check(dist(at(Math.round(midFrame)).position) > dist(at(0).position) * 1.05 || dist(draftAt(midFrame).position) <= dist(draftAt(0).position) * 1.05, 'the rough bump is kept as a gentle bulge');

    // with a wall in the way: nothing inside the geometry
    const scene2 = makeScene({ wall: true, seed: 5 });
    const [slide] = generateShots(scene2.object, { fps, fov, anchors: [], coverage: scene2.coverage, templates: ['slide'], count: 1, durationSec: 6 });
    const pushed = { ...slide, keys: slide.keys.map(k => ({ ...k, position: k.position.clone(), target: k.target.clone() })) };
    // drag a key right into the wall at x = 1.6
    pushed.keys[1].position.set(1.6, 1.0, 0);
    const clean2 = cleanupShot(scene2.object, pushed, { fov, coverage: scene2.coverage });
    const at2 = trackSplines(clean2.keys);
    let inside = 0;
    for (let f = 0; f < clean2.frames; f++) {
        if (scene2.coverage.clearance(at2(f).position) < 0.02) inside++;
    }
    check(inside === 0, `tidied path clear of the wall (${inside} frames inside)`);
}

// --- walk ----------------------------------------------------------------------

{
    console.log('walk-through');
    // a street 30 x 12 m with a wall across the middle (gap at z > 2)
    const rand = rng(11);
    const pts = [];
    for (let i = 0; i < 200000; i++) pts.push(rand() * 30 - 15, rand() * 0.02, rand() * 12 - 6);
    // wall at x = 0 from z = -6 to z = 2, 3 m high, 20 cm thick
    for (let i = 0; i < 80000; i++) pts.push(rand() * 0.2 - 0.1, rand() * 3, rand() * 8 - 6);
    // a car (box 4 x 1.5 x 2) at x = -8
    for (let i = 0; i < 20000; i++) pts.push(-8 + rand() * 4 - 2, 0.2 + rand() * 1.3, rand() * 2 - 1);
    const points = new Float32Array(pts);
    const weights = new Float32Array(points.length / 3).fill(0.9);
    const bounds = { min: new Vec3(-15, -0.1, -6), max: new Vec3(15, 3.2, 6) };
    const t0 = performance.now();
    const field = new WalkField(points, weights, bounds, { metersPerUnit: 1 });
    console.log(`  walk field ${(performance.now() - t0).toFixed(0)} ms, cell ${field.cell.toFixed(3)} m`);

    // ground under a point clicked on the car's side
    // a click on the car's side (no place to stand under it): the street next to it
    const onCar = generateWalk({ fps: 30, fov: 60, metersPerUnit: 1, eyeHeight: 1.6, speed: 1.3, lookAhead: 3, field, modifier: { bob: 0, stepRate: 1.9, shake: 0, shakeRate: 1 }, points: [new Vec3(-8, 1.0, -1.05), new Vec3(-8, 0, -4)], autoRoute: false });
    const start = onCar.route[0];
    check(Math.abs(start.y) < 0.1, `click on the car finds the street (${start.y.toFixed(3)})`);
    check(!(Math.abs(start.x + 8) < 2.1 && Math.abs(start.z) < 1.1), `and a place next to the car (${start.x.toFixed(2)}, ${start.z.toFixed(2)})`);
    const free = field.walkable(5, -3, 0.3, 0.3);
    check(!!free, 'open street is walkable');
    check(!field.walkable(0, -3, 0.3, 0.3), 'wall is not walkable');

    const modifier = { bob: 0.03, stepRate: 1.9, shake: 0.35, shakeRate: 1.1 };
    const common = { fps: 30, fov: 60, metersPerUnit: 1, eyeHeight: 1.6, speed: 1.3, lookAhead: 3, field, modifier };
    const a = new Vec3(-12, 1.0, -3);
    const b = new Vec3(10, 0, -3);

    const t1 = performance.now();
    const walk = generateWalk({ ...common, points: [a, b], autoRoute: true });
    const ms = performance.now() - t1;
    check(!!walk, 'walk generated');
    console.log(`  route ${walk.route.length} points, length ${walk.walkLength.toFixed(1)} m, ${walk.frames} frames, ${walk.keys.length} keys, ${ms.toFixed(0)} ms, warnings ${walk.warnings.join(',') || '-'}`);
    // the way leads through the gap (z > 2) past the wall
    const crossing = walk.route.find((p, i) => i > 0 && Math.sign(p.x) !== Math.sign(walk.route[i - 1].x));
    check(crossing && crossing.z > 2.2, `route passes the wall through the gap (z ${crossing?.z?.toFixed(2)})`);
    check(walk.route.every(p => !(Math.abs(p.x) < 0.3 && p.z < 2.15)), 'route never touches the wall');
    check(walk.route.every(p => !(Math.abs(p.x + 8) < 2.15 && Math.abs(p.z) < 1.15)), 'route keeps off the car');
    check(walk.warnings.length === 0, `no warnings (${walk.warnings.join(',')})`);
    // eye height above the ground and walking pace
    const atW = trackSplines(walk.keys);
    let worstEye = 0;
    let maxSpeed = 0;
    for (let f = 0; f < walk.frames - 1; f++) {
        const p = atW(f).position;
        worstEye = Math.max(worstEye, Math.abs(p.y - 1.6 - 0.01));
        maxSpeed = Math.max(maxSpeed, atW(f + 1).position.distance(p) * 30);
    }
    check(worstEye < 0.15, `eye height 1.6 m above the street (worst ${worstEye.toFixed(3)})`);
    check(maxSpeed < 1.3 * 1.25 && maxSpeed > 1.3 * 0.85, `walking pace about 1.3 m/s (max ${maxSpeed.toFixed(2)})`);
    const expected = walk.walkLength / 1.3;
    check(walk.params.durationSec >= expected && walk.params.durationSec < expected + 1.5, `duration follows length / pace (${walk.params.durationSec} s for ${expected.toFixed(1)} s)`);
    // sparse keys
    check(walk.keys.length <= 2 * 2 + Math.ceil(walk.walkLength / 3) && walk.keys.length < 25, `sparse keys (${walk.keys.length})`);
    check(walk.keys.every((k, i) => Number.isInteger(k.frame) && (i === 0 || k.frame > walk.keys[i - 1].frame)), 'walk keys ascending integers');
    // looks ahead along the way
    const p0 = atW(walk.frames / 2).position;
    const t0w = atW(walk.frames / 2).target;
    const ahead = atW(walk.frames / 2 + 30).position;
    const look = new Vec3().sub2(t0w, p0);
    const move = new Vec3().sub2(ahead, p0);
    look.y = 0;
    move.y = 0;
    check(look.normalize().dot(move.normalize()) > 0.7, 'view looks ahead along the way');
    check(walk.kind === 'walk' && walk.modifier.bob === 0.03, 'walk carries its modifier');
    // the view never looks through the wall at the corner (line of sight)
    let throughWall = 0;
    for (let f = 0; f < walk.frames; f += 2) {
        const { position, target } = atW(f);
        for (let k = 1; k < 20; k++) {
            const t = k / 20;
            const x = position.x + (target.x - position.x) * t;
            const y = position.y + (target.y - position.y) * t;
            const z = position.z + (target.z - position.z) * t;
            if (Math.abs(x) < 0.1 && z < 2 && y < 3) {
                throughWall++;
                break;
            }
        }
    }
    check(throughWall === 0, `the view does not look through the wall (${throughWall} frames)`);

    // a click on a roof among clicks on the street: the walk stays down
    {
        const roofPts = [];
        const r2 = rng(17);
        for (let i = 0; i < 60000; i++) roofPts.push(rand2(r2, 5, 9), 3 + r2() * 0.02, rand2(r2, -5, -1));
        for (let i = 0; i < 20000; i++) roofPts.push(rand2(r2, 5, 9), r2() * 3, -1);
        const all = new Float32Array([...points, ...roofPts]);
        const w = new Float32Array(all.length / 3).fill(0.9);
        const roofField = new WalkField(all, w, { min: new Vec3(-15, -0.1, -6), max: new Vec3(15, 3.2, 6) }, { metersPerUnit: 1 });
        const roofWalk = generateWalk({ ...common, field: roofField, points: [new Vec3(3, 0, -3), new Vec3(7, 3.0, -3), new Vec3(12, 0, -3)], autoRoute: false });
        const onRoof = roofWalk.route.filter(p => p.y > 1).length;
        check(onRoof === 0, `a roof click among street clicks stays on the street (${onRoof} route points up)`);
    }

    // automatic round walk around an object (a kiosk in the open street)
    {
        const r3 = rng(23);
        const kiosk = [];
        for (let i = 0; i < 40000; i++) {
            const side = Math.floor(r3() * 4);
            const u = r3() * 2 - 1;
            const h = r3() * 2.6;
            const p = side === 0 ? [7 + u, h, -1.5] : side === 1 ? [7 + u, h, 0.5] : side === 2 ? [6, h, -0.5 + u] : [8, h, -0.5 + u];
            kiosk.push(...p);
        }
        const all = new Float32Array([...points, ...kiosk]);
        const w = new Float32Array(all.length / 3).fill(0.9);
        const kioskField = new WalkField(all, w, { min: new Vec3(-15, -0.1, -6), max: new Vec3(15, 3.2, 6) }, { metersPerUnit: 1 });
        const { suggestWaypoints } = await load('ai-shots/walk-path');
        const auto = suggestWaypoints(kioskField, new Vec3(7, 1.3, -0.5), new Vec3(1, 1.3, 1), 0, 1);
        check(auto.length >= 4, `automatic waypoints around the kiosk (${auto.length})`);
        check(auto.every(p => kioskField.walkable(p.x, p.z, p.y + 0.3, 0.3)), 'every automatic waypoint is walkable');
        check(auto[0].distance(auto[auto.length - 1]) < 1e-6, 'the round walk closes');
        const loop = generateWalk({ ...common, field: kioskField, points: auto, autoRoute: true });
        check(loop && loop.warnings.length === 0, `round walk without warnings (${loop?.warnings.join(',')})`);
        check(loop.route.every(p => !(p.x > 5.8 && p.x < 8.2 && p.z > -1.7 && p.z < 0.7)), 'round walk keeps off the kiosk');
        console.log(`  round walk: ${auto.length} waypoints, ${loop.walkLength.toFixed(1)} m, ${loop.keys.length} keys`);
    }

    // straight through the wall without routing: warning
    const straight = generateWalk({ ...common, points: [new Vec3(-5, 0, -3), new Vec3(5, 0, -3)], autoRoute: false });
    check(straight.warnings.includes('sm.aishots.warn.walkBlocked'), `straight walk through the wall warns (${straight.warnings.join(',')})`);

    // scene in centimetres: the same walk scaled by 100
    const ptsCm = points.map(v => v * 100);
    const fieldCm = new WalkField(ptsCm, weights, { min: bounds.min.clone().mulScalar(100), max: bounds.max.clone().mulScalar(100) }, { metersPerUnit: 0.01 });
    const walkCm = generateWalk({ ...common, metersPerUnit: 0.01, field: fieldCm, points: [a.clone().mulScalar(100), b.clone().mulScalar(100)], autoRoute: true });
    check(Math.abs(walkCm.walkLength / 100 - walk.walkLength) < 0.1 * walk.walkLength, `centimetre scene walks the same way (${(walkCm.walkLength / 100).toFixed(1)} m vs ${walk.walkLength.toFixed(1)} m)`);
    check(Math.abs(walkCm.params.durationSec - walk.params.durationSec) < 0.15 * walk.params.durationSec, 'and takes about as long');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
