import { Vec3 } from 'playcanvas';

import { azimuthOf, blocked, createContext, evaluate, makeKeys, pushClear, RAMP, trackSplines, uniform, type ShotPath } from './shot-generator';
import type { CoverageField, GeneratedKey, ShotObject, ShotProposal } from './shot-types';

// "Tidy up": a move whose keys were dragged roughly in the viewport is turned
// into a clean one without generating anew - the shape the user made stays:
//   1. the edited spline is sampled densely
//   2. positions are smoothed (ends stay put, a full orbit wraps) and pushed
//      out of the geometry (coverage field), a few rounds
//   3. the targets are turned just far enough that the object stays in the
//      frame, then smoothed
//   4. the path is re-parameterised to constant speed and re-keyed by the
//      generator itself (makeKeys: ease in / out, elevation and distance
//      limits, clearance), with only as many keys as the shape needs
//   5. the generator's own rating (coverage, collisions, occlusion)

type CleanupOptions = {
    // field of view of the shot camera (degrees, longer image axis)
    fov: number;
    coverage?: CoverageField;
};

const SAMPLES = 160;
const DEG = Math.PI / 180;
// the object's centre stays within this share of the half field of view
const FRAME_SHARE = 0.6;
// smoothing of the positions: a gaussian over a twentieth of the path, two
// passes. Kinks and wiggles go, the shape made by hand stays (an orbit loses
// about 1.5 % of its radius)
const SMOOTH_SIGMA = SAMPLES / 20;
const SMOOTH_PASSES = 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const UP = new Vec3(0, 1, 0);

// gaussian smoothing; closed paths (last == first) wrap, open ones keep
// their ends and continue past them by point reflection (2 * end - p), so
// the ends keep their direction instead of getting a kink
const smooth = (points: Vec3[], sigma: number, closed: boolean): Vec3[] => {
    const n = points.length;
    if (n < 3 || sigma <= 0) return points.map(p => p.clone());
    const reach = Math.ceil(2.5 * sigma);
    const weight = (k: number) => Math.exp(-0.5 * k * k / (sigma * sigma));
    const out = points.map(p => p.clone());
    const period = n - 1;
    const first = points[0];
    const last = points[n - 1];
    const sample = (j: number, into: Vec3) => {
        if (closed) return into.copy(points[((j % period) + period) % period]);
        if (j < 0) {
            const q = points[Math.min(n - 1, -j)];
            return into.set(2 * first.x - q.x, 2 * first.y - q.y, 2 * first.z - q.z);
        }
        if (j > n - 1) {
            const q = points[Math.max(0, 2 * (n - 1) - j)];
            return into.set(2 * last.x - q.x, 2 * last.y - q.y, 2 * last.z - q.z);
        }
        return into.copy(points[j]);
    };
    const q = new Vec3();
    for (let i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) continue;
        if (closed && i === n - 1) continue;
        let x = 0, y = 0, z = 0, w = 0;
        for (let k = -reach; k <= reach; k++) {
            sample(i + k, q);
            const wk = weight(k);
            x += q.x * wk;
            y += q.y * wk;
            z += q.z * wk;
            w += wk;
        }
        out[i].set(x / w, y / w, z / w);
    }
    if (closed) out[n - 1].copy(out[0]);
    return out;
};

// turn the target towards the centre until the centre sits inside
// FRAME_SHARE of the half field of view (horizontal and vertical)
const keepInFrame = (position: Vec3, target: Vec3, center: Vec3, halfH: number, halfV: number) => {
    const fwd = new Vec3();
    const right = new Vec3();
    const up = new Vec3();
    const c = new Vec3().sub2(center, position);
    const fits = (t: Vec3) => {
        fwd.sub2(t, position);
        if (fwd.length() < 1e-9) return false;
        fwd.normalize();
        right.cross(fwd, UP);
        if (right.length() < 1e-6) right.set(1, 0, 0);
        right.normalize();
        up.cross(right, fwd);
        const z = c.dot(fwd);
        if (z <= 1e-9) return false;
        return Math.atan2(Math.abs(c.dot(right)), z) <= FRAME_SHARE * halfH && Math.atan2(Math.abs(c.dot(up)), z) <= FRAME_SHARE * halfV;
    };
    if (fits(target)) return target.clone();
    const dist = Math.max(1e-6, target.distance(position));
    const aim = c.length() > 1e-9 ? position.clone().add(c.clone().normalize().mulScalar(dist)) : target.clone();
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 22; i++) {
        const mid = 0.5 * (lo + hi);
        if (fits(new Vec3().lerp(target, aim, mid))) hi = mid;
        else lo = mid;
    }
    return new Vec3().lerp(target, aim, hi);
};

// summed change of the azimuth around the centre (degrees)
const turning = (points: Vec3[], center: Vec3) => {
    let sum = 0;
    for (let i = 1; i < points.length; i++) {
        const d = Math.abs(((azimuthOf(center, points[i]) - azimuthOf(center, points[i - 1])) % 360 + 540) % 360 - 180);
        sum += d;
    }
    return sum;
};

// distance of p to a polyline
const distanceToPolyline = (p: Vec3, line: Vec3[]) => {
    let best = Infinity;
    const ab = new Vec3();
    const ap = new Vec3();
    const q = new Vec3();
    for (let i = 0; i + 1 < line.length; i++) {
        ab.sub2(line[i + 1], line[i]);
        ap.sub2(p, line[i]);
        const len2 = ab.dot(ab);
        const t = len2 > 1e-12 ? clamp(ap.dot(ab) / len2, 0, 1) : 0;
        q.copy(line[i]).add(ab.mulScalar(t));
        best = Math.min(best, q.distance(p));
    }
    return best;
};

const polylinePath = (positions: Vec3[], targets: Vec3[], segments: number, ramp: number): ShotPath => {
    const n = positions.length;
    return {
        segments,
        ramp,
        pose: (s: number) => {
            const f = clamp(s, 0, 1) * (n - 1);
            const i = Math.min(n - 2, Math.floor(f));
            const t = f - i;
            return {
                position: new Vec3().lerp(positions[i], positions[i + 1], t),
                target: new Vec3().lerp(targets[i], targets[i + 1], t)
            };
        }
    };
};

const cleanupShot = (object: ShotObject, proposal: ShotProposal, opts: CleanupOptions): ShotProposal => {
    const keys = proposal.keys;
    if (keys.length < 2) return proposal;
    const fov = opts.fov > 0 ? opts.fov : 60;
    const ctx = createContext(object, fov, [], opts.coverage);
    const params = { ...proposal.params };
    const frames = proposal.frames;
    const last = keys[keys.length - 1].frame;

    // 1. the edited path, evenly spaced along its length (not in time: the
    // speed ramps would bunch the points and smoothing would kink the ends)
    const at = trackSplines(keys);
    const dense: { position: Vec3, target: Vec3 }[] = [];
    const steps = SAMPLES * 8;
    for (let i = 0; i <= steps; i++) dense.push(at(last * i / steps));
    const length = [0];
    for (let i = 1; i <= steps; i++) {
        length.push(length[i - 1] + dense[i].position.distance(dense[i - 1].position) + 0.5 * dense[i].target.distance(dense[i - 1].target));
    }
    const total = length[steps];
    let positions: Vec3[] = [];
    let targets: Vec3[] = [];
    let j = 0;
    for (let i = 0; i <= SAMPLES; i++) {
        const l = total > 1e-9 ? total * i / SAMPLES : 0;
        while (j < steps - 1 && length[j + 1] < l) j++;
        const span = length[j + 1] - length[j];
        const t = span > 1e-12 ? clamp((l - length[j]) / span, 0, 1) : 0;
        positions.push(new Vec3().lerp(dense[j].position, dense[j + 1].position, t));
        targets.push(new Vec3().lerp(dense[j].target, dense[j + 1].target, t));
    }
    const closed = positions[0].distance(positions[SAMPLES]) < 1e-3 * ctx.radius;

    // 2. smooth and keep clear of the geometry
    const clearOf = (line: Vec3[]) => {
        let pushed = false;
        for (let i = 0; i < line.length; i++) {
            if (!blocked(ctx, line[i])) continue;
            pushClear(ctx, line[i]);
            pushed = true;
        }
        if (closed) line[SAMPLES].copy(line[0]);
        return pushed;
    };
    for (let round = 0; round < 3; round++) {
        for (let pass = 0; pass < SMOOTH_PASSES; pass++) positions = smooth(positions, SMOOTH_SIGMA, closed);
        if (!opts.coverage || !clearOf(positions)) break;
    }

    // 3. object in the frame
    const halfH = 0.5 * fov * DEG;
    const halfV = Math.atan(Math.tan(halfH) * 9 / 16);
    targets = targets.map((t, i) => keepInFrame(positions[i], t, ctx.center, halfH, halfV));
    targets = smooth(targets, SAMPLES / 30, closed);
    targets = targets.map((t, i) => keepInFrame(positions[i], t, ctx.center, halfH, halfV));

    // 4. constant speed, few keys: as many segments as the path turns (one
    // per 30 degrees around the object), more when the keys miss the shape
    const ramp = RAMP[params.template] ?? 0.25;
    if (params.template === 'orbit' && closed) params.easing = 'linear';
    let segments = clamp(Math.ceil(turning(positions, ctx.center) / 30), 3, 12);
    const keyLimit = (s: number) => (params.template === 'orbit' ? 40 : Math.max(6, s + 3));
    const tolerance = 0.05 * ctx.radius;
    let result: { keys: GeneratedKey[], moved: boolean } = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        const path = uniform(polylinePath(positions, targets, segments, ramp));
        result = makeKeys(ctx, params, path, frames, keyLimit(segments));
        // how far the new keys' spline strays from the tidied path
        const check = trackSplines(result.keys);
        const end = result.keys[result.keys.length - 1].frame;
        let worst = 0;
        for (let i = 0; i <= 48; i++) worst = Math.max(worst, distanceToPolyline(check(end * i / 48).position, positions));
        if (worst <= tolerance || segments >= 12) break;
        segments = Math.min(12, segments + 2);
    }

    // 5. rating
    const { score, warnings } = evaluate(ctx, params, result.keys, result.moved);

    return {
        ...proposal,
        params,
        keys: result.keys,
        score,
        warnings,
        thumbnail: undefined,
        aiScore: undefined,
        aiComment: undefined,
        edited: false,
        cleaned: true
    };
};

export { cleanupShot, smooth, keepInFrame, type CleanupOptions };
