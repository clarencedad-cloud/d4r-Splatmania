import { Vec3 } from 'playcanvas';

import { SHOT_LIMITS, SHOT_STYLES, SHOT_TEMPLATES, STYLE_TEMPLATES, type AnchorPose, type CoverageField, type GeneratedKey, type ShotObject, type ShotParams, type ShotProposal, type ShotStyle, type ShotTemplate } from './shot-types';
import { CubicSpline } from '../anim/spline';

// Deterministic camera moves around an object. Every template is a path
// pose(s), s = 0..1 along the move; the timing (ease in / out) decides at
// which frames the keys sample the path. Azimuth: 0 = +Z side, 90 = +X side,
// increasing = counter-clockwise seen from above.

type GenerateOptions = {
    fps: number;
    // field of view of the shot cameras (degrees, longer image axis)
    fov: number;
    anchors: AnchorPose[];
    coverage?: CoverageField;
    requests?: ShotParams[];
    // default 6 without requests, all requests otherwise
    count?: number;
    // duration of every generated shot; default per template
    durationSec?: number;
    // multiplier on the camera distance to the object (also on Claude's
    // requests), 0.5..3; default 1
    distanceScale?: number;
    // camera height all moves keep (also Claude's); default 'auto'
    style?: ShotStyle;
    // only these moves; one move gives `count` variants of it (different
    // sides, directions and sweeps)
    templates?: ShotTemplate[];
};

const DISTANCE_SCALE: readonly [number, number] = [0.5, 3];

type PathPose = { position: Vec3, target: Vec3 };

type ShotPath = {
    pose: (s: number) => PathPose;
    // spatial key segments (orbit: one per 30 degrees)
    segments: number;
    // share of the duration spent accelerating and again decelerating
    ramp: number;
    aperture?: (s: number) => number;
};

type Anchor = { az: number, dist: number, height: number };

type Context = {
    obj: ShotObject;
    center: Vec3;
    radius: number;
    // camera distance (object radii) that frames the whole object
    fit: number;
    fov: number;
    anchors: Anchor[];
    coverage?: CoverageField;
    // longest horizontal axis of the AABB (unit vector)
    mainAxis: Vec3;
    // user multiplier on all camera distances (GenerateOptions.distanceScale)
    distanceScale: number;
    // camera height preset (GenerateOptions.style)
    style: ShotStyle;
};

const DEG = Math.PI / 180;

// keys stay a little inside the elevation limits so the spline between them does too
const MAX_ELEV = 78;
const FLYOVER_ELEV = 72;
const MAX_SCENE_DISTANCE = 8;
const CLEARANCE = 0.15;
const MAX_SLIDE_SWEEP = 120;
const MAX_REVEAL_SWEEP = 120;
// steepest view along the reveal path itself (its target wanders)
const REVEAL_ELEV = 70;
// hard limits of the finished track, checked on the spline between the keys
const TRACK_ELEV = 80;
const FLYOVER_TRACK_ELEV = 75;
// key count limits: 3-6 keys per shot, orbits about one key per 30 degrees
const MAX_KEYS = 6;
const MAX_ORBIT_KEYS = 40;

const DEFAULT_DURATION: Record<ShotTemplate, number> = {
    orbit: 10,
    reveal: 7,
    crane: 6,
    slide: 6,
    pushIn: 6,
    flyover: 8
};

// heuristic rank of the templates when nothing else is known
const PRIOR: Record<ShotTemplate, number> = {
    orbit: 0.62,
    reveal: 0.6,
    pushIn: 0.58,
    crane: 0.56,
    slide: 0.54,
    flyover: 0.5
};

const RAMP: Record<ShotTemplate, number> = {
    orbit: 0.22,
    reveal: 0.3,
    crane: 0.3,
    slide: 0.25,
    pushIn: 0.35,
    flyover: 0.25
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (t: number) => {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
};
const wrap360 = (a: number) => ((a % 360) + 360) % 360;
const angleDiff = (a: number, b: number) => Math.abs(wrap360(a - b + 180) - 180);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const limit = (v: unknown, range: readonly [number, number], fallback: number) => {
    return clamp(finite(v) ? v : fallback, range[0], range[1]);
};

// horizontal unit vector of an azimuth (degrees)
const horizontal = (az: number) => new Vec3(Math.sin(az * DEG), 0, Math.cos(az * DEG));

const azimuthOf = (from: Vec3, to: Vec3) => wrap360(Math.atan2(to.x - from.x, to.z - from.z) / DEG);

const elevationOf = (position: Vec3, target: Vec3) => {
    const h = Math.hypot(target.x - position.x, target.z - position.z);
    return Math.atan2(position.y - target.y, h) / DEG;
};

// trapezoidal velocity: accelerate for `ramp`, cruise, decelerate for `ramp`
const ease = (t: number, ramp: number) => {
    const x = clamp(t, 0, 1);
    if (ramp <= 0) return x;
    const v = 1 / (1 - ramp);
    const a = v / ramp;
    if (x < ramp) return 0.5 * a * x * x;
    if (x > 1 - ramp) return 1 - 0.5 * a * (1 - x) * (1 - x);
    return 0.5 * v * ramp + (x - ramp) * v;
};

const easeInverse = (s: number, ramp: number) => {
    const y = clamp(s, 0, 1);
    if (ramp <= 0) return y;
    const v = 1 / (1 - ramp);
    const a = v / ramp;
    const sr = 0.5 * v * ramp;
    if (y < sr) return Math.sqrt(2 * y / a);
    if (y > 1 - sr) return 1 - Math.sqrt(2 * (1 - y) / a);
    return ramp + (y - sr) / v;
};

// camera on a sphere around the centre: distance d, height h above the centre
const polar = (center: Vec3, az: number, d: number, h: number, maxElev = MAX_ELEV) => {
    const el = clamp(Math.asin(clamp(h / Math.max(d, 1e-9), -1, 1)) / DEG, -maxElev, maxElev) * DEG;
    const dir = horizontal(az).mulScalar(Math.cos(el) * d);
    return new Vec3(center.x + dir.x, center.y + Math.sin(el) * d, center.z + dir.z);
};

// horizontal half size of the AABB seen from an azimuth
const support = (ctx: Context, az: number) => {
    const { halfExtents } = ctx.obj;
    return Math.abs(Math.sin(az * DEG)) * halfExtents.x + Math.abs(Math.cos(az * DEG)) * halfExtents.z;
};

const createContext = (obj: ShotObject, fov: number, anchors: AnchorPose[], coverage?: CoverageField): Context => {
    const half = obj.halfExtents;
    const radius = Math.max(obj.radius || half.length(), 1e-3);
    const center = obj.center.clone();

    // distance that fits the object into a 16:9 frame (fov on the longer axis)
    const tanH = Math.tan(clamp(fov, 5, 150) * DEG * 0.5);
    const tanV = tanH * 9 / 16;
    const horiz = Math.hypot(half.x, half.z);
    const fitDist = Math.max(half.y / tanV, horiz / tanH) + 0.5 * horiz;
    const fit = clamp(fitDist / radius, 1.2, SHOT_LIMITS.distanceFactor[1]);

    const list: Anchor[] = [];
    for (const a of anchors ?? []) {
        if (!a?.position) continue;
        const d = a.position.distance(center);
        if (!(d > 1e-6)) continue;
        list.push({ az: azimuthOf(center, a.position), dist: d / radius, height: (a.position.y - center.y) / radius });
    }

    return {
        obj,
        center,
        radius,
        fit,
        fov,
        anchors: list.slice(0, 3),
        coverage,
        mainAxis: half.x >= half.z ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1),
        distanceScale: 1,
        style: 'auto'
    };
};

// how good a viewing azimuth is: data and free sight from there, closeness to
// the anchors, distance to the sides other shots already use
const preference = (ctx: Context, az: number, distF: number, heightF: number, used: number[], frontal = 0) => {
    let q = 0.5;
    if (ctx.coverage) {
        const eye = polar(ctx.center, az, distF * ctx.radius, heightF * ctx.radius);
        q = ctx.coverage.visibility(eye, ctx.center, ctx.radius);
    }
    for (const a of ctx.anchors) {
        q += 0.6 * Math.max(0, 1 - angleDiff(az, a.az) / 45);
    }
    for (const u of used) {
        q -= 0.35 * Math.max(0, 1 - angleDiff(az, u) / 50);
    }
    if (frontal) {
        // looking across the longest axis shows the broad side
        const view = horizontal(az);
        q += frontal * (1 - Math.abs(view.dot(ctx.mainAxis)));
    }
    return q;
};

// best azimuth in 10 degree steps, smoothed over the neighbours
const bestAzimuth = (ctx: Context, distF: number, heightF: number, used: number[], frontal = 0) => {
    const raw: number[] = [];
    for (let i = 0; i < 36; i++) raw.push(preference(ctx, i * 10, distF, heightF, used, frontal));
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < 36; i++) {
        const score = 0.5 * raw[i] + 0.25 * raw[(i + 35) % 36] + 0.25 * raw[(i + 1) % 36];
        if (score > bestScore + 1e-9) {
            bestScore = score;
            best = i * 10;
        }
    }
    return best;
};

// --- templates -------------------------------------------------------------

const orbitPath = (ctx: Context, p: ShotParams): ShotPath => {
    const { center, radius } = ctx;
    const sign = p.direction === 'cw' ? -1 : 1;
    const sweep = p.sweepDeg;
    const d = p.distanceFactor * radius;
    const h = p.heightFactor * radius;
    // a slight rise keeps a partial orbit alive; a full turn stays level to loop
    const rise = sweep < 360 ? 0.08 * radius : 0;
    return {
        segments: Math.max(2, Math.ceil(sweep / 30)),
        ramp: RAMP.orbit,
        pose: s => ({
            position: polar(center, p.startAngleDeg + sign * sweep * s, d, h + rise * (2 * s - 1)),
            target: center.clone()
        })
    };
};

// starts close beside the object, looking past its edge, low; pulls back and
// arcs round to the full view while the target settles on the centre
const revealPath = (ctx: Context, p: ShotParams): ShotPath => {
    const { center, radius } = ctx;
    const sign = p.direction === 'cw' ? -1 : 1;
    const sweep = p.sweepDeg;
    const az0 = p.startAngleDeg;
    const az1 = az0 + sign * sweep;
    const d1 = p.distanceFactor * radius;
    const h0 = Math.max(SHOT_LIMITS.heightFactor[0], Math.min(p.heightFactor, -0.15)) * radius;
    const near = support(ctx, az0) + 0.3 * radius;
    const d0 = Math.min(Math.hypot(near, h0), d1);

    const edgeAz = az0 + sign * 45;
    const edge = horizontal(edgeAz).mulScalar(0.85 * support(ctx, edgeAz)).add(center);
    edge.y = center.y - 0.05 * radius;

    const poseAt = (s: number, h1: number) => {
        const pull = smoothstep(s);
        const position = polar(center, lerp(az0, az1, s), lerp(d0, d1, pull), lerp(h0, h1, s));
        const settle = smoothstep(s / 0.85);
        const target = new Vec3().lerp(edge, center, settle);
        return { position, target };
    };

    // the target wanders while the camera climbs: close and high, the camera
    // would pass (almost) straight over it. Lower the end height until the
    // whole path stays below REVEAL_ELEV; every pose only gets flatter with a
    // lower h1 (the camera sinks and moves out on its sphere)
    const steepest = (h1: number) => {
        let max = -Infinity;
        for (let i = 0; i <= 64; i++) {
            const { position, target } = poseAt(i / 64, h1);
            max = Math.max(max, elevationOf(position, target));
        }
        return max;
    };
    let h1 = p.heightFactor * radius;
    if (steepest(h1) > REVEAL_ELEV) {
        let lo = Math.min(h0, h1);
        let hi = h1;
        if (steepest(lo) > REVEAL_ELEV) {
            h1 = lo;
        } else {
            for (let i = 0; i < 24; i++) {
                const mid = 0.5 * (lo + hi);
                if (steepest(mid) > REVEAL_ELEV) hi = mid;
                else lo = mid;
            }
            h1 = lo;
        }
    }

    return {
        segments: 3,
        ramp: RAMP.reveal,
        pose: s => poseAt(s, h1)
    };
};

// rises (or sinks) while coming slightly closer and drifting a little round
const cranePath = (ctx: Context, p: ShotParams): ShotPath => {
    const { center, radius } = ctx;
    const sign = p.direction === 'cw' ? -1 : 1;
    const [hMin, hMax] = SHOT_LIMITS.heightFactor;
    const h1 = p.heightFactor;
    let h0 = Math.max(hMin, Math.min(-0.15, h1 - 1));
    if (h1 - h0 < 0.4) h0 = Math.min(hMax, h1 + 0.9);
    const d1 = p.distanceFactor * radius;
    const d0 = Math.min(d1 * 1.15, MAX_SCENE_DISTANCE * ctx.obj.sceneRadius);
    const az0 = p.startAngleDeg;
    const rising = h1 > h0;
    return {
        segments: 3,
        ramp: RAMP.crane,
        pose: (s) => {
            const position = polar(center, az0 + sign * 12 * s, lerp(d0, d1, s), lerp(h0, h1, s) * radius);
            const target = center.clone();
            target.y += (rising ? lerp(0.12, 0, s) : lerp(-0.08, 0, s)) * radius;
            return { position, target };
        }
    };
};

// lateral track parallel to the longest horizontal axis; the target moves
// less than the camera, so the foreground slides past the background
const slidePath = (ctx: Context, p: ShotParams): ShotPath => {
    const { center, radius, mainAxis } = ctx;
    const side = horizontal(p.startAngleDeg);
    const h = p.heightFactor * radius;
    const d = p.distanceFactor * radius;
    const dPerp = Math.sqrt(Math.max(d * d - h * h, (0.3 * d) * (0.3 * d)));
    const half = dPerp * Math.tan(p.sweepDeg * 0.5 * DEG);

    // counter-clockwise = towards increasing azimuth
    const ccw = new Vec3(side.z, 0, -side.x);
    const axisSign = mainAxis.dot(ccw) >= 0 ? 1 : -1;
    const travel = mainAxis.clone().mulScalar(axisSign * (p.direction === 'cw' ? -1 : 1));
    const axisHalf = Math.abs(mainAxis.x) > 0.5 ? ctx.obj.halfExtents.x : ctx.obj.halfExtents.z;
    const targetHalf = Math.min(0.45 * axisHalf, 0.4 * half);

    return {
        segments: 3,
        ramp: RAMP.slide,
        pose: (s) => {
            const x = lerp(-half, half, s);
            const position = center.clone().add(side.clone().mulScalar(dPerp)).add(travel.clone().mulScalar(x));
            position.y += h;
            const target = center.clone().add(travel.clone().mulScalar(lerp(-targetHalf, targetHalf, s)));
            return { position, target };
        }
    };
};

// slow frontal approach; aperture opens a little on the way in
const pushInPath = (ctx: Context, p: ShotParams, endDistance?: number): ShotPath => {
    const { center, radius } = ctx;
    const az = p.startAngleDeg;
    const d0 = p.distanceFactor * radius;
    const safe = Math.max(support(ctx, az) + 0.35 * radius, 0.6 * radius);
    let d1 = clamp(endDistance ?? 0.55 * d0, safe, 0.8 * d0);
    if (d1 >= d0) d1 = 0.85 * d0;
    const h0 = p.heightFactor * radius;
    const h1 = h0 * 0.6;
    return {
        segments: 3,
        ramp: RAMP.pushIn,
        pose: s => ({
            position: polar(center, az, lerp(d0, d1, s), lerp(h0, h1, s)),
            target: center.clone()
        }),
        aperture: s => clamp(lerp(0.012, 0.024, s) * radius, 0.001, 0.5)
    };
};

// travels at height over the object and tilts down towards a top view; the
// target always stays ahead of the camera so the view never flips
const flyoverPath = (ctx: Context, p: ShotParams): ShotPath => {
    const { center, radius } = ctx;
    const sign = p.direction === 'cw' ? -1 : 1;
    const h = Math.max(p.heightFactor, 0.6) * radius;
    const d = Math.max(p.distanceFactor * radius, h * 1.15);
    const l0 = Math.sqrt(d * d - h * h);
    const el0 = Math.min(Math.atan2(h, l0) / DEG, 60);
    const el1 = FLYOVER_ELEV;
    const back = horizontal(p.startAngleDeg);
    const travel = back.clone().mulScalar(-1);
    const lateral = new Vec3(travel.z, 0, -travel.x).mulScalar(sign);
    return {
        segments: 3,
        ramp: RAMP.flyover,
        pose: (s) => {
            const xt = lerp(0, 0.2, s) * radius;
            const lead = h / Math.tan(lerp(el0, el1, s) * DEG);
            const drift = 0.15 * radius * s;
            const target = center.clone().add(travel.clone().mulScalar(xt));
            const position = target.clone().add(travel.clone().mulScalar(-lead)).add(lateral.clone().mulScalar(drift));
            position.y = center.y + h;
            return { position, target };
        }
    };
};

// --- parameters ------------------------------------------------------------

const DEFAULT_FIT: Record<ShotTemplate, number> = {
    orbit: 0.9,
    reveal: 1,
    crane: 1,
    slide: 0.85,
    pushIn: 1.25,
    flyover: 1.3
};

const DEFAULT_HEIGHT: Record<ShotTemplate, number> = {
    orbit: 0.55,
    reveal: 0.35,
    crane: 1.1,
    slide: 0.2,
    pushIn: 0.15,
    flyover: 1.4
};

const DEFAULT_SWEEP: Partial<Record<ShotTemplate, number>> = {
    orbit: 150,
    reveal: 70,
    slide: 50
};

// clamp a request (or an empty one) to valid ranges
const sanitize = (template: ShotTemplate, request: Partial<ShotParams>, ctx: Context, durationSec?: number, distanceScale = 1): ShotParams => {
    const [dMin, dMax] = SHOT_LIMITS.distanceFactor;
    const distance = limit(request.distanceFactor, SHOT_LIMITS.distanceFactor, DEFAULT_FIT[template] * ctx.fit);
    const out: ShotParams = {
        template,
        durationSec: limit(request.durationSec, SHOT_LIMITS.durationSec, durationSec ?? DEFAULT_DURATION[template]),
        // the user's distance setting scales the range as well, so "further"
        // still works when the default is already near the upper limit
        distanceFactor: clamp(distance * distanceScale, dMin, dMax * Math.max(1, distanceScale)),
        heightFactor: limit(request.heightFactor, SHOT_LIMITS.heightFactor, DEFAULT_HEIGHT[template]),
        direction: request.direction === 'cw' ? 'cw' : 'ccw',
        focusPull: request.focusPull === true,
        easing: request.easing === 'linear' ? 'linear' : 'smooth'
    };
    if (finite(request.startAngleDeg)) out.startAngleDeg = wrap360(request.startAngleDeg);
    const sweepMax = template === 'slide' ? MAX_SLIDE_SWEEP : (template === 'reveal' ? MAX_REVEAL_SWEEP : SHOT_LIMITS.sweepDeg[1]);
    const sweepDefault = DEFAULT_SWEEP[template];
    if (sweepDefault !== undefined) {
        out.sweepDeg = clamp(limit(request.sweepDeg, SHOT_LIMITS.sweepDeg, sweepDefault), SHOT_LIMITS.sweepDeg[0], sweepMax);
    }
    if (typeof request.label === 'string' && request.label.trim()) out.label = request.label.trim();
    if (typeof request.rationale === 'string' && request.rationale.trim()) out.rationale = request.rationale.trim();
    return out;
};

// smallest arc (start, span) that holds all anchor azimuths
const anchorArc = (anchors: Anchor[]) => {
    const azs = anchors.map(a => a.az).sort((a, b) => a - b);
    if (azs.length === 1) return { start: azs[0], span: 0 };
    let gap = -1;
    let start = azs[0];
    for (let i = 0; i < azs.length; i++) {
        const next = i + 1 < azs.length ? azs[i + 1] : azs[0] + 360;
        if (next - azs[i] > gap) {
            gap = next - azs[i];
            start = i + 1 < azs.length ? azs[i + 1] : azs[0];
        }
    }
    return { start, span: 360 - gap };
};

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

// fill in what the request leaves open: start angle from the anchors or the
// best covered side, default framing from the anchors
const resolve = (ctx: Context, p: ShotParams, explicit: Partial<ShotParams>, anchor: Anchor | undefined, used: number[]) => {
    const { template } = p;
    const sign = p.direction === 'cw' ? -1 : 1;
    const free = (key: keyof ShotParams) => !finite(explicit[key]);
    // anchor distances follow the user's distance setting too
    const ds = ctx.distanceScale;
    const dMin = SHOT_LIMITS.distanceFactor[0];
    const dMax = SHOT_LIMITS.distanceFactor[1] * Math.max(1, ds);
    const [hMin, hMax] = SHOT_LIMITS.heightFactor;
    let endDistance: number;

    if (template === 'orbit') {
        if (ctx.anchors.length) {
            if (free('distanceFactor')) p.distanceFactor = clamp(mean(ctx.anchors.map(a => a.dist)) * ds, dMin, dMax);
            if (free('heightFactor')) p.heightFactor = clamp(mean(ctx.anchors.map(a => a.height)), hMin, hMax);
        }
        if (p.startAngleDeg === undefined) {
            if (ctx.anchors.length) {
                // the anchors sit in the middle of the sweep
                const arc = anchorArc(ctx.anchors);
                if (free('sweepDeg')) p.sweepDeg = clamp(Math.max(p.sweepDeg, arc.span + 60), SHOT_LIMITS.sweepDeg[0], 360);
                const mid = arc.start + arc.span * 0.5;
                p.startAngleDeg = wrap360(mid - sign * p.sweepDeg * 0.5);
            } else {
                // window with the best mean coverage
                let best = 0;
                let bestScore = -Infinity;
                const n = Math.max(2, Math.ceil(p.sweepDeg / 20));
                const samples: number[] = [];
                for (let i = 0; i < 36; i++) samples.push(preference(ctx, i * 10, p.distanceFactor, p.heightFactor, []));
                const at = (az: number) => {
                    const f = wrap360(az) / 10;
                    const i0 = Math.floor(f) % 36;
                    return lerp(samples[i0], samples[(i0 + 1) % 36], f - Math.floor(f));
                };
                for (let i = 0; i < 36; i++) {
                    let sum = 0;
                    for (let k = 0; k <= n; k++) sum += at(i * 10 + sign * p.sweepDeg * k / n);
                    if (sum > bestScore + 1e-9) {
                        bestScore = sum;
                        best = i * 10;
                    }
                }
                p.startAngleDeg = best;
            }
        }
        return endDistance;
    }

    if (anchor) {
        if (template === 'reveal' || template === 'crane') {
            if (free('distanceFactor')) p.distanceFactor = clamp(anchor.dist * ds, dMin, dMax);
            if (free('heightFactor')) p.heightFactor = clamp(anchor.height, hMin, hMax);
        }
        // the push lands on the favourite framing, unless the request pushes
        // in from another side than the anchor
        if (template === 'pushIn' && (p.startAngleDeg === undefined || angleDiff(anchor.az, p.startAngleDeg) < 45)) {
            if (free('distanceFactor')) p.distanceFactor = clamp(Math.max(p.distanceFactor, anchor.dist * ds * 1.5), dMin, dMax);
            endDistance = anchor.dist * ds * ctx.radius;
        }
    }

    if (template === 'slide') {
        // one of the two sides across the main axis
        const sideA = azimuthOf(Vec3.ZERO, new Vec3(-ctx.mainAxis.z, 0, ctx.mainAxis.x));
        const sideB = wrap360(sideA + 180);
        const wish = p.startAngleDeg ?? anchor?.az;
        const score = (side: number) => (wish !== undefined ? -angleDiff(side, wish) : preference(ctx, side, p.distanceFactor, p.heightFactor, used));
        p.startAngleDeg = score(sideA) >= score(sideB) ? sideA : sideB;
    }

    if (p.startAngleDeg === undefined) {
        let az: number;
        if (anchor) {
            az = anchor.az;
        } else {
            az = bestAzimuth(ctx, p.distanceFactor, p.template === 'flyover' ? 0.8 : p.heightFactor, used, template === 'pushIn' ? 0.15 : 0);
        }
        // the anchor / best side is where reveal and crane end up
        if (template === 'reveal') az -= sign * p.sweepDeg;
        if (template === 'crane') az -= sign * 12;
        p.startAngleDeg = wrap360(az);
    }
    return endDistance;
};

// re-parameterise a path so that s runs at constant speed (camera travel
// plus half the target travel); the easing then shapes the real motion
const uniform = (path: ShotPath): ShotPath => {
    const n = 64;
    const length = [0];
    let prev = path.pose(0);
    for (let i = 1; i <= n; i++) {
        const next = path.pose(i / n);
        length.push(length[i - 1] + next.position.distance(prev.position) + 0.5 * next.target.distance(prev.target));
        prev = next;
    }
    const total = length[n];
    if (!(total > 1e-9)) return path;
    const toRaw = (s: number) => {
        const l = clamp(s, 0, 1) * total;
        let i = 0;
        while (i < n - 1 && length[i + 1] < l) i++;
        const span = length[i + 1] - length[i];
        return (i + (span > 1e-12 ? (l - length[i]) / span : 0)) / n;
    };
    return {
        segments: path.segments,
        ramp: path.ramp,
        pose: s => path.pose(toRaw(s)),
        aperture: path.aperture && (s => path.aperture(toRaw(s)))
    };
};

// camera heights of a style, world y: the ground is the bottom of the
// object; eye level is about 1.6 scene units (metres in a metric scan),
// kept within a sensible share of the object's height
const styleHeights = (ctx: Context) => {
    const half = ctx.obj.halfExtents;
    const height = Math.max(1e-3, 2 * half.y);
    const ground = ctx.center.y - half.y;
    const top = ctx.center.y + half.y;
    const eye = clamp(1.6, 0.12 * height, 0.45 * height);
    return { ground, top, eye, height };
};

// apply the style to a path: ground and low keep the camera at one height
// near the ground, high and aerial keep it above the object
const styled = (ctx: Context, path: ShotPath): ShotPath => {
    if (ctx.style === 'auto') return path;
    const { ground, top, eye, height } = styleHeights(ctx);
    const r = ctx.radius;
    const fix = (y: number) => {
        switch (ctx.style) {
            case 'ground': return ground + eye;
            case 'low': return ground + 0.3 * eye;
            case 'high': return Math.max(y, top + 0.25 * height);
            case 'aerial': return Math.max(y, top + 0.6 * r + 0.25 * height);
            default: return y;
        }
    };
    return {
        ...path,
        pose: (s: number) => {
            const pose = path.pose(s);
            const position = pose.position.clone();
            position.y = fix(position.y);
            const target = pose.target.clone();
            // from the ground the eye looks a little up the object, from
            // low it looks up at it
            if (ctx.style === 'low') target.y = Math.max(target.y, ground + 0.6 * height);
            return { ...pose, position, target };
        }
    };
};

const buildPath = (ctx: Context, p: ShotParams, endDistance?: number): ShotPath => {
    switch (p.template) {
        case 'orbit': return uniform(styled(ctx, orbitPath(ctx, p)));
        case 'reveal': return uniform(styled(ctx, revealPath(ctx, p)));
        case 'crane': return uniform(styled(ctx, cranePath(ctx, p)));
        case 'slide': return uniform(styled(ctx, slidePath(ctx, p)));
        case 'pushIn': return uniform(styled(ctx, pushInPath(ctx, p, endDistance)));
        case 'flyover': return uniform(styled(ctx, flyoverPath(ctx, p)));
    }
};

// default height and extra distance of a style, applied to fresh params
const applyStyle = (ctx: Context, p: ShotParams) => {
    if (ctx.style === 'auto') return;
    const { ground, top, eye } = styleHeights(ctx);
    const r = ctx.radius;
    const [hMin, hMax] = SHOT_LIMITS.heightFactor;
    switch (ctx.style) {
        case 'ground': p.heightFactor = clamp((ground + eye - ctx.center.y) / r, hMin, hMax); break;
        case 'low': p.heightFactor = hMin; break;
        case 'high': p.heightFactor = clamp(Math.max(p.heightFactor, (top - ctx.center.y) / r + 0.3), hMin, hMax); break;
        case 'aerial':
            p.heightFactor = hMax;
            p.distanceFactor = clamp(p.distanceFactor * 1.35, SHOT_LIMITS.distanceFactor[0], SHOT_LIMITS.distanceFactor[1] * Math.max(1, ctx.distanceScale) * 1.35);
            break;
    }
};

// variations of one move: other sides come from the `used` repulsion,
// direction and sweep alternate
const VARIANT_SWEEP: Partial<Record<ShotTemplate, number[]>> = {
    orbit: [150, 90, 220, 360, 120, 180],
    slide: [50, 35, 70, 45, 60, 40],
    reveal: [70, 50, 100, 60, 85, 45]
};

// --- keys ------------------------------------------------------------------

// frames of the keys and where on the path they sit. Keys are spread evenly
// along the path; with easing, extra keys close to both ends make the
// spline start and stop softly
const schedule = (path: ShotPath, frames: number, easing: 'linear' | 'smooth') => {
    const last = frames - 1;
    const ramp = easing === 'smooth' ? path.ramp : 0;
    const params: number[] = [];
    for (let i = 0; i <= path.segments; i++) params.push(i / path.segments);
    if (ramp > 0) {
        const soft = ease(0.4 * ramp, ramp);
        if (soft < 0.5 / path.segments) params.push(soft, 1 - soft);
    }
    params.sort((a, b) => a - b);

    const result: { frame: number, s: number }[] = [];
    for (const s of params) {
        const frame = Math.round(easeInverse(s, ramp) * last);
        if (result.length && frame <= result[result.length - 1].frame) continue;
        result.push({ frame, s: 0 });
    }
    if (result[result.length - 1].frame !== last) {
        if (result.length > 1) result.pop();
        result.push({ frame: last, s: 0 });
    }
    // position on the path at the exact (rounded) key time
    for (const r of result) r.s = ease(last > 0 ? r.frame / last : 0, ramp);
    return result;
};

// elevation limit, distance limit, target != position
const constrain = (ctx: Context, position: Vec3, target: Vec3, maxElev: number, fallbackAz: number) => {
    const dx = position.x - target.x;
    const dz = position.z - target.z;
    const dy = position.y - target.y;
    let horiz = Math.hypot(dx, dz);
    const minHoriz = Math.abs(dy) / Math.tan(maxElev * DEG);
    if (horiz < minHoriz || horiz < 1e-6) {
        const dir = horiz > 1e-6 ? new Vec3(dx / horiz, 0, dz / horiz) : horizontal(fallbackAz);
        horiz = Math.max(minHoriz, 1e-3 * ctx.radius);
        position.x = target.x + dir.x * horiz;
        position.z = target.z + dir.z * horiz;
    }
    const maxDist = MAX_SCENE_DISTANCE * (ctx.obj.sceneRadius > 0 ? ctx.obj.sceneRadius : ctx.radius);
    const dist = position.distance(target);
    if (dist > maxDist) {
        const dir = position.clone().sub(target).mulScalar(maxDist / dist);
        position.copy(target).add(dir);
    }
};

// coverage too coarse to tell the object from its surroundings: the object's
// own voxels must not push the camera away
const blocked = (ctx: Context, p: Vec3) => {
    const { coverage } = ctx;
    if (!coverage) return false;
    if (coverage.clearance(p) >= CLEARANCE * ctx.radius) return false;
    const cell = coverage.cellSize ?? 0;
    if (cell > 0.75 * ctx.radius && p.distance(ctx.center) < ctx.radius + cell) return false;
    return true;
};

// move a position out of the geometry along the clearance gradient
const pushClear = (ctx: Context, p: Vec3) => {
    const { coverage, radius } = ctx;
    const need = CLEARANCE * radius;
    const h = Math.max(coverage.cellSize ?? 0, 0.05 * radius);
    for (let i = 0; i < 16 && blocked(ctx, p); i++) {
        const c = coverage.clearance(p);
        const grad = new Vec3(
            coverage.clearance(new Vec3(p.x + h, p.y, p.z)) - coverage.clearance(new Vec3(p.x - h, p.y, p.z)),
            coverage.clearance(new Vec3(p.x, p.y + h, p.z)) - coverage.clearance(new Vec3(p.x, p.y - h, p.z)),
            coverage.clearance(new Vec3(p.x, p.y, p.z + h)) - coverage.clearance(new Vec3(p.x, p.y, p.z - h))
        );
        let dir: Vec3;
        if (grad.length() > 1e-9 && Number.isFinite(grad.length())) {
            dir = grad.normalize();
        } else {
            dir = p.clone().sub(ctx.center);
            dir.y = 0;
            dir = dir.length() > 1e-9 ? dir.normalize() : new Vec3(0, 1, 0);
        }
        p.add(dir.mulScalar(Math.max(need - c, 0) + 0.5 * h));
    }
    return !blocked(ctx, p);
};

type DraftKey = { frame: number, s: number, position: Vec3, target: Vec3 };

// the camera track's own interpolation (non-looping) of position and target
const trackSplines = (keys: { frame: number, position: Vec3, target: Vec3 }[]) => {
    const times = keys.map(k => k.frame);
    const pos: number[] = [];
    const tgt: number[] = [];
    keys.forEach((k) => {
        pos.push(k.position.x, k.position.y, k.position.z);
        tgt.push(k.target.x, k.target.y, k.target.z);
    });
    const ps = CubicSpline.fromPoints(times, pos, 1);
    const ts = CubicSpline.fromPoints(times, tgt, 1);
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    return (frame: number): PathPose => {
        ps.evaluate(frame, a);
        ts.evaluate(frame, b);
        return { position: new Vec3(a[0], a[1], a[2]), target: new Vec3(b[0], b[1], b[2]) };
    };
};

// sampled between the keys
const sampleSpline = (keys: GeneratedKey[], count: number) => {
    const at = trackSplines(keys);
    const last = keys[keys.length - 1].frame;
    const out: PathPose[] = [];
    for (let i = 0; i < count; i++) out.push(at(count > 1 ? last * i / (count - 1) : 0));
    return out;
};

// hard: elevation, distance or target == position; far: the distance alone
type Violation = { frame: number, hard: boolean, far: boolean };

// worst spot of the spline between the keys, sampled every half frame: hard
// = elevation, distance or target == position; soft = clearance
const inspect = (ctx: Context, keys: DraftKey[], trackElev: number): Violation | null => {
    const at = trackSplines(keys);
    const last = keys[keys.length - 1].frame;
    const maxDist = MAX_SCENE_DISTANCE * (ctx.obj.sceneRadius > 0 ? ctx.obj.sceneRadius : ctx.radius);
    const minDist = 1e-4 * ctx.radius;
    let hard: Violation | null = null;
    let hardExcess = 0;
    let soft: Violation | null = null;
    for (let f = 0; f <= last; f += 0.5) {
        const { position, target } = at(f);
        const dist = position.distance(target);
        let excess = Math.abs(elevationOf(position, target)) - trackElev;
        const far = dist > maxDist;
        if (far) excess = Math.max(excess, 100 * (dist / maxDist - 1));
        if (!(dist > minDist)) excess = Math.max(excess, 1000);
        if (excess > hardExcess) {
            hardExcess = excess;
            hard = { frame: f, hard: true, far };
        }
        if (!soft && !hard && blocked(ctx, position)) soft = { frame: f, hard: false, far: false };
    }
    return hard ?? soft;
};

const makeKeys = (ctx: Context, p: ShotParams, path: ShotPath, frames: number, keyLimit?: number) => {
    const maxElev = p.template === 'flyover' ? FLYOVER_ELEV : MAX_ELEV;
    // checked a little inside the hard limit, the track may sample anywhere
    const trackElev = (p.template === 'flyover' ? FLYOVER_TRACK_ELEV : TRACK_ELEV) - 0.5;
    const maxKeys = keyLimit ?? (p.template === 'orbit' ? MAX_ORBIT_KEYS : MAX_KEYS);
    const last = frames - 1;
    const ramp = p.easing === 'smooth' ? path.ramp : 0;
    let moved = false;

    // keep a key clear of the geometry and inside the limits
    const settle = (key: DraftKey) => {
        constrain(ctx, key.position, key.target, maxElev, p.startAngleDeg);
        if (blocked(ctx, key.position)) {
            moved = true;
            pushClear(ctx, key.position);
            constrain(ctx, key.position, key.target, maxElev, p.startAngleDeg);
        }
    };
    const draft = (frame: number, s: number): DraftKey => {
        const { position, target } = path.pose(s);
        const key = { frame, s, position, target };
        settle(key);
        return key;
    };

    const keys = schedule(path, frames, p.easing).map(({ frame, s }) => draft(frame, s));

    // the spline between the keys can leave the limits the keys keep (the
    // target wanders, the camera swings round): add keys there while the
    // shot may have more, otherwise lower the camera around that spot
    for (let iter = 0; iter < 64 && keys.length >= 2; iter++) {
        const v = inspect(ctx, keys, trackElev);
        if (!v) break;
        const seg = Math.max(0, keys.findIndex((k, i) => i + 1 < keys.length && keys[i + 1].frame > v.frame));
        const candidates = [Math.round(v.frame), Math.floor(v.frame), Math.ceil(v.frame)];
        const frame = candidates.find(f => f > 0 && f < last && !keys.some(k => k.frame === f));
        if (keys.length < maxKeys && frame !== undefined) {
            keys.push(draft(frame, ease(frame / last, ramp)));
            keys.sort((a, b) => a.frame - b.frame);
            continue;
        }
        // no room for a key; clearance alone is left to the collision warning
        if (!v.hard) break;
        // lower (and for the distance pull in) the keys that shape this segment
        for (let j = Math.max(0, seg - 1); j <= Math.min(keys.length - 1, seg + 2); j++) {
            const { position, target } = keys[j];
            const offset = position.clone().sub(target);
            offset.y *= 0.85;
            position.copy(target).add(offset.mulScalar(v.far ? 0.97 : 1));
            if (blocked(ctx, position)) settle(keys[j]);
        }
    }

    // last resort: flatten (and pull in) the whole track. The spline is linear
    // in the keys, so scaling every key's offset from its target scales the
    // offset at every point of the spline the same way
    for (let iter = 0; iter < 40 && keys.length >= 2; iter++) {
        const v = inspect(ctx, keys, trackElev);
        if (!v?.hard) break;
        for (const { position, target } of keys) {
            const offset = position.clone().sub(target);
            offset.y *= 0.8;
            position.copy(target).add(offset.mulScalar(v.far ? 0.97 : 1));
            if (blocked(ctx, position)) moved = true;
        }
    }

    const result: GeneratedKey[] = keys.map(({ frame, s, position, target }) => {
        const key: GeneratedKey = { frame, position, target };
        if (p.focusPull) {
            key.focus = Math.max(0.01, position.distance(target));
            key.aperture = path.aperture ? path.aperture(s) : clamp(0.018 * ctx.radius, 0.001, 0.5);
        }
        return key;
    });
    result[0].fov = ctx.fov;
    return { keys: result, moved };
};

const evaluate = (ctx: Context, p: ShotParams, keys: GeneratedKey[], moved: boolean) => {
    const warnings: string[] = [];
    const samples = sampleSpline(keys, 32);

    let collision = moved;
    let score = PRIOR[p.template];
    if (ctx.coverage) {
        if (samples.some(s => blocked(ctx, s.position))) collision = true;
        const vis = samples.filter((_, i) => i % 2 === 0).map(s => ctx.coverage.visibility(s.position, s.target, ctx.radius));
        const avg = mean(vis);
        const hidden = vis.filter(v => v < 0.2).length / vis.length;
        score = 0.8 * avg + 0.2 * score;
        if (avg < 0.4) warnings.push('sm.aishots.warn.lowCoverage');
        if (hidden >= 0.25) {
            warnings.push('sm.aishots.warn.occluded');
            score -= 0.1;
        }
    }
    if (collision) {
        warnings.push('sm.aishots.warn.collision');
        score -= 0.1;
    }

    // passing a favourite angle
    if (ctx.anchors.length) {
        const azs = samples.map(s => azimuthOf(ctx.center, s.position));
        const hits = ctx.anchors.filter(a => azs.some(az => angleDiff(az, a.az) < 20)).length;
        score += 0.08 * hits / ctx.anchors.length;
    }

    return { score: clamp(score, 0, 1), warnings };
};

const buildProposal = (ctx: Context, fps: number, params: ShotParams, explicit: Partial<ShotParams>, anchor: Anchor | undefined, used: number[], id: string): ShotProposal => {
    const p = params;
    const endDistance = resolve(ctx, p, explicit, anchor, used);
    const frames = Math.round(p.durationSec * fps) + 1;

    let { keys, moved } = makeKeys(ctx, p, buildPath(ctx, p, endDistance), frames);

    // collisions: rather step back as a whole (keeps the move's shape) than
    // push single keys, if that clears the path
    const distance = p.distanceFactor;
    for (let i = 1; i <= 3 && moved; i++) {
        const retreat = Math.min(SHOT_LIMITS.distanceFactor[1] * Math.max(1, ctx.distanceScale), distance * Math.pow(1.15, i));
        if (retreat <= p.distanceFactor) break;
        p.distanceFactor = retreat;
        const attempt = makeKeys(ctx, p, buildPath(ctx, p, endDistance), frames);
        if (!attempt.moved) ({ keys, moved } = attempt);
    }
    if (moved) p.distanceFactor = distance;

    const { score, warnings } = evaluate(ctx, p, keys, moved);
    p.startAngleDeg = Math.round(wrap360(p.startAngleDeg) * 10) / 10;
    p.distanceFactor = Math.round(p.distanceFactor * 1000) / 1000;
    p.heightFactor = Math.round(p.heightFactor * 1000) / 1000;

    return {
        id,
        params: p,
        title: p.label ?? `sm.aishots.template.${p.template}`,
        keys,
        frames,
        score,
        warnings
    };
};

// the camera distance (scene units, from the object centre) a template uses
// at distanceScale 1: the template's share of the distance that frames the
// whole object. Without a template: that framing distance itself
const framingDistance = (object: ShotObject, fov: number, template?: ShotTemplate) => {
    const ctx = createContext(object, finite(fov) && fov > 0 ? fov : 60, [], undefined);
    return (template ? DEFAULT_FIT[template] : 1) * ctx.fit * ctx.radius;
};

// largest extent of the object's bounds (scene units)
const objectSize = (object: ShotObject) => {
    const h = object.halfExtents;
    return 2 * Math.max(h.x, h.y, h.z, 1e-6);
};

// ground and eye level of a style (world y), as the generator uses them
const groundLevels = (object: ShotObject) => styleHeights(createContext(object, 60, [], undefined));

const keysEndAzimuth = (ctx: Context, proposal: ShotProposal) => {
    return azimuthOf(ctx.center, proposal.keys[proposal.keys.length - 1].position);
};

const generateShots = (object: ShotObject, opts: GenerateOptions): ShotProposal[] => {
    const fps = finite(opts.fps) && opts.fps > 0 ? opts.fps : 30;
    const fov = finite(opts.fov) && opts.fov > 0 ? opts.fov : 60;
    const ctx = createContext(object, fov, opts.anchors ?? [], opts.coverage);
    const duration = finite(opts.durationSec) ? opts.durationSec : undefined;
    const scale = finite(opts.distanceScale) ? clamp(opts.distanceScale, DISTANCE_SCALE[0], DISTANCE_SCALE[1]) : 1;
    ctx.distanceScale = scale;
    ctx.style = opts.style && SHOT_STYLES.includes(opts.style) ? opts.style : 'auto';
    const used: number[] = [];
    // the style decides the height: anchors and requests do not override it
    const heightLocked = ctx.style !== 'auto';

    if (opts.requests?.length) {
        const list = opts.requests
        .filter(r => r && SHOT_TEMPLATES.includes(r.template))
        .map((r, i) => {
            const params = sanitize(r.template, r, ctx, undefined, scale);
            applyStyle(ctx, params);
            const anchor = ctx.anchors.length ? ctx.anchors[i % ctx.anchors.length] : undefined;
            const explicit = heightLocked ? { ...r, heightFactor: params.heightFactor } : r;
            const proposal = buildProposal(ctx, fps, params, explicit, anchor, used, `${r.template}-${i}`);
            if (r.template !== 'orbit') used.push(proposal.params.startAngleDeg);
            return proposal;
        });
        return finite(opts.count) ? list.slice(0, Math.max(0, opts.count)) : list;
    }

    const count = finite(opts.count) ? Math.max(0, Math.floor(opts.count)) : 6;
    const picked = (opts.templates ?? []).filter(t => SHOT_TEMPLATES.includes(t));

    // one move picked: variations of it
    if (picked.length === 1) {
        const template = picked[0];
        const list: ShotProposal[] = [];
        for (let i = 0; i < Math.max(1, count); i++) {
            const params = sanitize(template, {}, ctx, duration, scale);
            applyStyle(ctx, params);
            params.direction = i % 2 === 0 ? 'ccw' : 'cw';
            const sweeps = VARIANT_SWEEP[template];
            if (sweeps) params.sweepDeg = clamp(sweeps[i % sweeps.length], SHOT_LIMITS.sweepDeg[0], template === 'orbit' ? 360 : 120);
            if (template === 'orbit' && params.sweepDeg >= 360) params.easing = 'linear';
            const anchor = ctx.anchors.length ? ctx.anchors[i % ctx.anchors.length] : undefined;
            const explicit: Partial<ShotParams> = heightLocked ? { heightFactor: params.heightFactor } : {};
            const proposal = buildProposal(ctx, fps, params, explicit, anchor, used, `${template}-v${i}`);
            used.push(template === 'reveal' || template === 'crane' ? keysEndAzimuth(ctx, proposal) : proposal.params.startAngleDeg);
            list.push(proposal);
        }
        list.sort((a, b) => b.score - a.score);
        return list;
    }

    // one of each, most promising first; best covered sides go to the
    // templates that depend most on them
    const allowed = picked.length ? picked : STYLE_TEMPLATES[ctx.style];
    const order: ShotTemplate[] = (['pushIn', 'reveal', 'crane', 'flyover', 'slide', 'orbit'] as ShotTemplate[]).filter(t => allowed.includes(t));
    const list: ShotProposal[] = [];
    let anchorIndex = 0;
    for (const template of order) {
        const params = sanitize(template, {}, ctx, duration, scale);
        applyStyle(ctx, params);
        // a full turn should loop seamlessly
        if (template === 'orbit' && params.sweepDeg >= 360) params.easing = 'linear';
        const anchor = template !== 'orbit' && ctx.anchors.length ? ctx.anchors[anchorIndex++ % ctx.anchors.length] : undefined;
        const index = SHOT_TEMPLATES.indexOf(template);
        const explicit: Partial<ShotParams> = heightLocked ? { heightFactor: params.heightFactor } : {};
        const proposal = buildProposal(ctx, fps, params, explicit, anchor, used, `${template}-${index}`);
        if (template !== 'orbit') used.push(template === 'reveal' || template === 'crane' ? keysEndAzimuth(ctx, proposal) : proposal.params.startAngleDeg);
        list.push(proposal);
    }

    list.sort((a, b) => (b.score - a.score) || (SHOT_TEMPLATES.indexOf(a.params.template) - SHOT_TEMPLATES.indexOf(b.params.template)));
    return list.slice(0, count);
};

export {
    generateShots,
    type GenerateOptions,
    ease,
    easeInverse,
    elevationOf,
    azimuthOf,
    framingDistance,
    objectSize,
    groundLevels,
    // the clean-up step (shot-cleanup.ts) re-keys paths with these
    createContext,
    makeKeys,
    evaluate,
    trackSplines,
    blocked,
    pushClear,
    uniform,
    RAMP,
    DISTANCE_SCALE,
    type Context,
    type ShotPath,
    type PathPose
};
