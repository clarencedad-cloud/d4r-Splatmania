import { applyColorGradeWGSL, paletteGradeWGSL } from './color-grade-chunk';
import { indexToUvWGSL, paletteMatrixWGSL } from './palette-chunk';
import { compactTailWGSL, overlayEligibleWGSL } from './projected-splat-chunk';
import { stochasticWarpWGSL } from './stochastic-warp-chunk';

const shCode = (bands: number) => {
    if (bands === 0) {
        return `
fn evaluateSH(sourceUv: vec2i, direction: vec3f) -> vec3f {
    return vec3f(0.0);
}`;
    }

    const count = bands === 1 ? 3 : bands === 2 ? 8 : 15;
    const loads = [
        `let first = textureLoad(splatSH_1to3, sourceUv, 0);
    let scale = bitcast<f32>(first.x);
    coefficients[0] = unpack111011s(first.y);
    coefficients[1] = unpack111011s(first.z);
    coefficients[2] = unpack111011s(first.w);`
    ];

    if (bands > 1) {
        loads.push(`let second = textureLoad(splatSH_4to7, sourceUv, 0);
    coefficients[3] = unpack111011s(second.x);
    coefficients[4] = unpack111011s(second.y);
    coefficients[5] = unpack111011s(second.z);
    coefficients[6] = unpack111011s(second.w);
    coefficients[7] = unpack111011s(textureLoad(splatSH_8to11, sourceUv, 0).x);`);
    }

    if (bands > 2) {
        loads[loads.length - 1] = `let second = textureLoad(splatSH_4to7, sourceUv, 0);
    coefficients[3] = unpack111011s(second.x);
    coefficients[4] = unpack111011s(second.y);
    coefficients[5] = unpack111011s(second.z);
    coefficients[6] = unpack111011s(second.w);
    let third = textureLoad(splatSH_8to11, sourceUv, 0);
    coefficients[7] = unpack111011s(third.x);
    coefficients[8] = unpack111011s(third.y);
    coefficients[9] = unpack111011s(third.z);
    coefficients[10] = unpack111011s(third.w);
    let fourth = textureLoad(splatSH_12to15, sourceUv, 0);
    coefficients[11] = unpack111011s(fourth.x);
    coefficients[12] = unpack111011s(fourth.y);
    coefficients[13] = unpack111011s(fourth.z);
    coefficients[14] = unpack111011s(fourth.w);`;
    }

    const band2 = bands > 1 ? `
    let xx = direction.x * direction.x;
    let yy = direction.y * direction.y;
    let zz = direction.z * direction.z;
    let xy = direction.x * direction.y;
    let yz = direction.y * direction.z;
    let xz = direction.x * direction.z;
    result += coefficients[3] * (1.0925484305920792 * xy)
        + coefficients[4] * (-1.0925484305920792 * yz)
        + coefficients[5] * (0.31539156525252005 * (2.0 * zz - xx - yy))
        + coefficients[6] * (-1.0925484305920792 * xz)
        + coefficients[7] * (0.5462742152960396 * (xx - yy));` : '';

    const band3 = bands > 2 ? `
    result += coefficients[8] * (-0.5900435899266435 * direction.y * (3.0 * xx - yy))
        + coefficients[9] * (2.890611442640554 * xy * direction.z)
        + coefficients[10] * (-0.4570457994644658 * direction.y * (4.0 * zz - xx - yy))
        + coefficients[11] * (0.3731763325901154 * direction.z * (2.0 * zz - 3.0 * xx - 3.0 * yy))
        + coefficients[12] * (-0.4570457994644658 * direction.x * (4.0 * zz - xx - yy))
        + coefficients[13] * (1.445305721320277 * direction.z * (xx - yy))
        + coefficients[14] * (-0.5900435899266435 * direction.x * (xx - 3.0 * yy));` : '';

    return `
fn unpack111011s(bits: u32) -> vec3f {
    let value = vec3u((vec3u(bits) >> vec3u(21u, 11u, 0u)) & vec3u(0x7ffu, 0x3ffu, 0x7ffu));
    return vec3f(value) / vec3f(2047.0, 1023.0, 2047.0) * 2.0 - 1.0;
}

fn evaluateSH(sourceUv: vec2i, direction: vec3f) -> vec3f {
    var coefficients: array<vec3f, ${count}>;
    ${loads.join('\n    ')}
    var result = 0.4886025119029199 * (
        -coefficients[0] * direction.y
        + coefficients[1] * direction.z
        - coefficients[2] * direction.x
    );${band2}${band3}
    return result * scale;
}`;
};

const projectedSplatProjector = (bands: number) => /* wgsl */`
struct ProjectorUniforms {
    numSplats: u32,
    entryBase: u32,
    entryCount: u32,
    instanceBase: u32,
    sourceWidth: u32,
    cacheWidth: u32,
    viewport: vec2f,
    isOrtho: u32,
    focal: vec2f,
    model: mat4x4f,
    view: mat4x4f,
    viewProj: mat4x4f,
    cameraPosition: vec3f,
    // the colour panel's uncommitted grade, previewed on the edit target only:
    // 0 = off, 1 = selected instances, 2 = every instance (an empty selection
    // means the whole layer). Locked instances are never a target, matching
    // SplatsColorOp.forEachTarget.
    previewMode: u32,
    colorAlpha: f32,
    // rows of the affine colour grade, see color-grade-chunk
    colorRow0: vec4f,
    colorRow1: vec4f,
    colorRow2: vec4f,
    lockedColor: vec4f,
    visible: u32,
    selectionEnabled: u32,
    pickOp: i32,
    minPixelSize: f32,
    // camera clip planes, used to linearly normalize view depth for the sort key
    near: f32,
    far: f32,
    // total cache entries: the culled tail of the compact list grows down from
    // here (compactTailSlot)
    capacity: u32,
    // keep culled splats projected, for the centres overlay, instead of
    // dropping them
    keepCulled: u32,
    // minimum alpha mass of a projected gaussian, in pixels; 0 = off
    minContribution: f32,
    // splats exempt from the contribution and occlusion culls because their
    // ring would draw: 0 none, 1 the selected ones, 2 the whole layer
    // (overlayEligible decides)
    keepRings: u32,
    // the previous stochastic frame, for the occlusion cull: its view and
    // view-projection, its clip-z mapping (a, b, isOrtho - the render shader's
    // clipZParams, with warp strength in w), viewport and focal length, and
    // the block grid of its max-depth map. occlusionEnabled is 0 when no
    // usable previous frame exists
    prevViewProj: mat4x4f,
    prevView: mat4x4f,
    prevClipZ: vec4f,
    prevViewport: vec2f,
    prevFocal: vec2f,
    occlusionBlocksX: u32,
    occlusionBlocksY: u32,
    occlusionBlock: f32,
    occlusionEnabled: u32,
    // depth filter (src/depth-filter.ts): x near, y far in view depth, z mode
    // (0 off, 1 cull out-of-range splats, 2 dim them)
    depthRange: vec4f,
    // layer animation (src/layer-anim.ts): x opacity, y splat->point mix,
    // z additive glow of points
    layerParams: vec4f,
    // point cloud: x size, y size mode (0 pixels, 1 world), z point opacity,
    // w colour mode (0 splat colour, 1 pointColor)
    pointParams: vec4f,
    pointColor: vec4f,
    // build transition (src/layer-anim.ts transitionParams):
    // A effect id, build (1 = built), front width, scatter
    // B origin xyz, seed;  C axis xyz, fly mode (1 = explode)
    // D axis min, axis range, origin radius, swirl
    // E layer radius, point phase, glow strength;  F glow colour
    transA: vec4f,
    transB: vec4f,
    transC: vec4f,
    transD: vec4f,
    transE: vec4f,
    transF: vec4f,
    // dissolve: G noise frequency (world), mode (0 noise, 1 axis, 2 radial),
    // point size (px), drift mode (0 outward, 1 along axis, 2 random)
    // H point tint toward the glow colour, noise share of the threshold
    transG: vec4f,
    transH: vec4f,
    // quality heatmap: x mode (0 off, 1 heatmap, 2 below threshold red,
    // 3 worse than another scan), y threshold
    quality: vec4f,
    // section cut (src/section/section-tool.ts): xyz world up axis, w cut
    // height along it; sectionEdge x enabled, y soft edge width (0 = hard)
    sectionPlane: vec4f,
    sectionEdge: vec4f,
    // depth of field (src/dof/dof.ts): x enabled, y 1 / focus distance,
    // z aperture (lens radius, world units), w max blur diameter (px)
    dofParams: vec4f
}

// compaction output: surviving splats are appended to a dense list, so the sort
// and the draw cover the visible count instead of the whole capacity. sortKeys
// and compactEntries are indexed by compact slot, not by entry; the cache stays
// indexed by entry, and the entry index rides along as the sort payload so
// gaussian ids keep their meaning downstream (picking, rings, stochastic dither).
// With the centres overlay up, splats that fail the size, contribution or
// occlusion cull are appended to a tail growing down from the end of
// compactEntries (counted in splatCounter[1], placed by compactTailSlot); only
// the centres draw reads it
@group(0) @binding(0) var<storage, read_write> sortKeys: array<u32>;
@group(0) @binding(1) var<storage, read_write> compactEntries: array<u32>;
@group(0) @binding(2) var<storage, read_write> splatCounter: array<atomic<u32>>;
@group(0) @binding(3) var cacheA: texture_storage_2d<rgba32uint, write>;
@group(0) @binding(4) var cacheB: texture_storage_2d<r32uint, write>;
@group(0) @binding(5) var<storage, read> instanceSource: array<u32>;
@group(0) @binding(6) var<storage, read> instanceFlags: array<u32>;
@group(0) @binding(7) var<storage, read> instancePalette: array<u32>;
// max depth per block of the previous stochastic frame (projected-splat-depth-reduce-shader)
@group(0) @binding(8) var<storage, read> prevDepthMax: array<f32>;
// quality score per instance (src/quality), packed 4 bytes to a word
@group(0) @binding(9) var<storage, read> instanceScore: array<u32>;
@group(0) @binding(10) var transformA: texture_2d<u32>;
@group(0) @binding(11) var transformB: texture_2d<f32>;
@group(0) @binding(12) var splatColor: texture_2d<f32>;
@group(0) @binding(13) var transformPalette: texture_2d<f32>;
@group(0) @binding(14) var colorPalette: texture_2d<f32>;
${bands > 0 ? '@group(0) @binding(15) var splatSH_1to3: texture_2d<u32>;' : ''}
${bands > 1 ? '@group(0) @binding(16) var splatSH_4to7: texture_2d<u32>;\n@group(0) @binding(17) var splatSH_8to11: texture_2d<u32>;' : ''}
${bands > 2 ? '@group(0) @binding(18) var splatSH_12to15: texture_2d<u32>;' : ''}
@group(0) @binding(${15 + (bands > 0 ? 1 : 0) + (bands > 1 ? 2 : 0) + (bands > 2 ? 1 : 0)}) var<uniform> uniforms: ProjectorUniforms;

${shCode(bands)}
${indexToUvWGSL('sourceCoord', 'uniforms.sourceWidth')}
${indexToUvWGSL('cacheCoord', 'uniforms.cacheWidth')}
${paletteMatrixWGSL}
${applyColorGradeWGSL}
${paletteGradeWGSL}
${overlayEligibleWGSL}
${compactTailWGSL}
${stochasticWarpWGSL}

// per-splat build transition: what the transition does to one splat
struct BuildResult {
    offset: vec3f,
    scale: f32,
    alpha: f32,
    glow: f32,
    mix: f32,
    // point diameter while the splat is a point (px); 0 = point cloud setting
    pointSize: f32,
    // how far the colour is pulled to the glow colour (points)
    tint: f32
}

// 3d value noise and a 3-octave fbm over it: smooth, deterministic and
// organic enough for a frayed dissolve front
fn hash31(p: vec3f) -> f32 {
    let q = fract(p * 0.1031);
    let r = q + dot(q, q.yzx + 33.33);
    return fract((r.x + r.y) * r.z);
}

fn valueNoise(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let n000 = hash31(i);
    let n100 = hash31(i + vec3f(1.0, 0.0, 0.0));
    let n010 = hash31(i + vec3f(0.0, 1.0, 0.0));
    let n110 = hash31(i + vec3f(1.0, 1.0, 0.0));
    let n001 = hash31(i + vec3f(0.0, 0.0, 1.0));
    let n101 = hash31(i + vec3f(1.0, 0.0, 1.0));
    let n011 = hash31(i + vec3f(0.0, 1.0, 1.0));
    let n111 = hash31(i + vec3f(1.0, 1.0, 1.0));
    return mix(
        mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
        mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
        u.z
    );
}

fn fbm(p: vec3f) -> f32 {
    return valueNoise(p) * 0.55 + valueNoise(p * 2.03 + 17.1) * 0.3 + valueNoise(p * 4.11 + 41.7) * 0.15;
}

// the dissolve / materialize transition of one splat. A threshold sweeps the
// layer, driven by fbm noise over the world position plus an optional axis or
// radial gradient, so every splat gets its own time in the overall progress.
// Within its window a splat goes: drifting particle -> small glowing point
// flying in -> flare at the front -> grows into the full gaussian
fn dissolveTransition(world: vec3f, id: u32, h: f32) -> BuildResult {
    var r: BuildResult;
    r.offset = vec3f(0.0);
    r.scale = 1.0;
    r.alpha = 1.0;
    r.glow = 0.0;
    r.mix = 0.0;
    r.pointSize = 0.0;
    r.tint = 0.0;

    let build = uniforms.transA.y;
    let span = clamp(uniforms.transA.z, 0.05, 1.0);
    let seed = uniforms.transB.w;
    let axis = uniforms.transC.xyz;
    let thresholdMode = i32(uniforms.transG.y + 0.5);

    // noise threshold in 0..1, stretched from fbm's narrow middle range
    let n = clamp((fbm(world * uniforms.transG.x + vec3f(seed * 7.31, seed * 3.17, seed * 5.53)) - 0.28) / 0.44, 0.0, 1.0);
    var d = n;
    if (thresholdMode == 1) {
        let g = clamp((dot(world, axis) - uniforms.transD.x) / uniforms.transD.y, 0.0, 1.0);
        d = mix(g, n, uniforms.transH.y);
    } else if (thresholdMode == 2) {
        let g = clamp(length(world - uniforms.transB.xyz) / uniforms.transD.z, 0.0, 1.0);
        d = mix(g, n, uniforms.transH.y);
    }
    // a hair of per-splat jitter frays the front at the splat scale
    d = clamp(d + (h - 0.5) * 0.03, 0.0, 1.0);

    // this splat's progress through its own window
    let t = clamp((build * (1.0 + span) - d) / span, 0.0, 1.0);
    if (t <= 0.0) {
        r.alpha = 0.0;
        return r;
    }

    // 1-2: particle -> point flying in (first 55% of the window)
    let fly = clamp(t / 0.55, 0.0, 1.0);
    let remain = (1.0 - fly) * (1.0 - fly);
    let driftMode = i32(uniforms.transG.w + 0.5);
    var dir = world - uniforms.transB.xyz;
    if (driftMode == 1) {
        dir = axis;
    } else if (driftMode == 2) {
        dir = vec3f(buildHash(id * 3u + 1u), buildHash(id * 3u + 2u), buildHash(id * 3u + 3u)) * 2.0 - 1.0;
    }
    dir = dir / max(length(dir), 1e-5);
    // each particle drifts its own distance, so the cloud doesn't move as a shell
    let reach = uniforms.transA.w * uniforms.transE.x * (0.5 + h);
    let rel = world - uniforms.transB.xyz;
    let swirled = rotateAround(rel, axis, uniforms.transD.w * 6.2831853 * remain);
    r.offset = (swirled - rel) + dir * reach * remain;

    // 4: materialize - point to full gaussian, colour and opacity to original
    let grow = smoothstep(0.55, 1.0, t);
    r.mix = 1.0 - grow;
    r.pointSize = uniforms.transG.z;
    r.tint = uniforms.transH.x * (1.0 - grow);
    r.alpha = smoothstep(0.0, 0.12, t);

    // 3: the front flares just before the splat lands
    let flare = exp(-pow((t - 0.6) / 0.12, 2.0));
    r.glow = (flare + 0.25 * (1.0 - grow)) * uniforms.transE.z;
    return r;
}

fn buildHash(v: u32) -> f32 {
    var x = v * 747796405u + 2891336453u;
    x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
    x = (x >> 22u) ^ x;
    return f32(x) / 4294967295.0;
}

// rotate v around the unit axis k by angle (Rodrigues)
fn rotateAround(v: vec3f, k: vec3f, angle: f32) -> vec3f {
    let c = cos(angle);
    let s = sin(angle);
    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}

fn buildTransition(world: vec3f, id: u32) -> BuildResult {
    var r: BuildResult;
    r.offset = vec3f(0.0);
    r.scale = 1.0;
    r.alpha = 1.0;
    r.glow = 0.0;
    r.mix = 0.0;
    r.pointSize = 0.0;
    r.tint = 0.0;

    let effect = i32(uniforms.transA.x + 0.5);
    if (effect == 0) {
        return r;
    }
    if (effect == 3) {
        return dissolveTransition(world, id, buildHash(id ^ (u32(uniforms.transB.w) * 2654435761u)));
    }
    let build = uniforms.transA.y;
    let edge = max(uniforms.transA.z, 0.001);
    let scatter = uniforms.transA.w;
    let origin = uniforms.transB.xyz;
    let seed = u32(uniforms.transB.w);
    let axis = uniforms.transC.xyz;
    let layerRadius = uniforms.transE.x;
    let h = buildHash(id ^ (seed * 2654435761u));

    // when this splat builds: 0 first .. 1 last
    var d = 0.0;
    if (effect == 1 || effect == 6) {
        // sweep / wave: along the axis
        d = clamp((dot(world, axis) - uniforms.transD.x) / uniforms.transD.y, 0.0, 1.0);
    } else if (effect == 2 || effect == 4) {
        // radial / grow: distance from the origin
        d = clamp(length(world - origin) / uniforms.transD.z, 0.0, 1.0);
    } else if (effect == 3) {
        // dissolve: per-splat noise
        d = h;
    } else {
        // fly-in: staggered at random
        d = h * 0.6;
    }
    // a little noise on the front keeps it from banding
    d = clamp(d + (h - 0.5) * 0.04, 0.0, 1.0);

    // this splat's own progress through the front
    let t = clamp((build * (1.0 + edge) - d) / edge, 0.0, 1.0);

    if (effect == 1 || effect == 2) {
        // sweep / radial: fade in behind a glowing front
        r.alpha = t;
        r.scale = mix(0.6, 1.0, t);
        r.glow = 4.0 * t * (1.0 - t);
    } else if (effect == 3) {
        r.alpha = t;
        r.glow = 4.0 * t * (1.0 - t) * 0.6;
    } else if (effect == 4) {
        // grow: each splat scales up from nothing
        r.scale = t;
        r.alpha = smoothstep(0.0, 0.15, t);
    } else if (effect == 5) {
        // fly-in: start scattered (random or exploded from the origin) and
        // swirl into place around the axis
        let remain = (1.0 - t) * (1.0 - t);
        var dir = vec3f(buildHash(id * 3u + 1u), buildHash(id * 3u + 2u), buildHash(id * 3u + 3u)) * 2.0 - 1.0;
        if (uniforms.transC.w > 0.5) {
            dir = world - origin;
        }
        dir = dir / max(length(dir), 1e-5);
        let rel = world - origin;
        let swirled = rotateAround(rel, axis, uniforms.transD.w * 6.2831853 * remain);
        r.offset = (swirled - rel) + dir * scatter * layerRadius * remain;
        r.alpha = smoothstep(0.0, 0.3, t);
    } else {
        // wave: drop in along the axis (use a negative axis to rise from
        // below) with a small bounce
        let height = scatter * layerRadius;
        r.offset = axis * height * ((1.0 - t) * (1.0 - t) + 0.08 * sin(t * 9.4247780) * (1.0 - t));
        r.alpha = smoothstep(0.0, 0.2, t);
    }

    // points first, then splats
    if (uniforms.transE.y > 0.5) {
        r.mix = 1.0 - smoothstep(0.5, 1.0, t);
        r.alpha = min(r.alpha, smoothstep(0.0, 0.5, t) + step(0.5, t));
    }
    r.glow *= uniforms.transE.z;
    return r;
}

fn rotationMatrix(qIn: vec4f) -> mat3x3f {
    let q = normalize(qIn);
    let x = q.x;
    let y = q.y;
    let z = q.z;
    let w = q.w;
    return mat3x3f(
        vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
        vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
        vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
    );
}

// per-instance editor state, packed 4 bytes to a word
fn instanceFlagByte(instance: u32) -> u32 {
    return (instanceFlags[instance >> 2u] >> ((instance & 3u) * 8u)) & 0xffu;
}

@compute @workgroup_size(256)
fn main(
    @builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u
) {
    let localIndex = gid.y * numWorkgroups.x * 256u + gid.x;
    if (localIndex >= uniforms.entryCount) {
        return;
    }

    // entries beyond the live instance count are reserved slack
    let entry = uniforms.entryBase + localIndex;
    if (localIndex >= uniforms.numSplats || uniforms.visible == 0u) {
        return;
    }

    // per-instance channels are indexed by instance; the static gaussian data
    // is reached through the instance's source row
    let instance = uniforms.instanceBase + localIndex;
    let sourceIndex = instanceSource[instance];
    let uv = sourceCoord(sourceIndex);
    let state = instanceFlagByte(instance) & 3u;
    if ((uniforms.pickOp == 0 && state != 0u)
        || (uniforms.pickOp == 1 && state != 1u)
        || (uniforms.pickOp == 2 && (state & 2u) != 0u)) {
        return;
    }

    // a fully faded-out layer draws nothing
    if (uniforms.layerParams.x <= 0.0) {
        return;
    }
    var pointMix = clamp(uniforms.layerParams.y, 0.0, 1.0);

    let a = textureLoad(transformA, uv, 0);
    let b = textureLoad(transformB, uv, 0);
    let packedRotation = unpack2x16float(a.w);
    let rotation = vec4f(packedRotation, b.w, sqrt(max(0.0, 1.0 - dot(vec3f(packedRotation, b.w), vec3f(packedRotation, b.w)))));
    let localCenter = bitcast<vec3f>(a.xyz);
    let paletteWord = instancePalette[instance];
    let model = uniforms.model * paletteMatrix(paletteWord & 0xffffu);
    var worldCenter = model * vec4f(localCenter, 1.0);

    // build transition: per-splat offset, scale, alpha and front glow
    let built = buildTransition(worldCenter.xyz, sourceIndex);
    if (built.alpha <= 0.0) {
        return;
    }
    worldCenter = vec4f(worldCenter.xyz + built.offset, 1.0);

    // section cut: splats above the cut height are dropped (also from
    // picking and selection passes), a soft edge fades the last band
    var sectionFade = 1.0;
    if (uniforms.sectionEdge.x > 0.5) {
        let below = uniforms.sectionPlane.w - dot(worldCenter.xyz, uniforms.sectionPlane.xyz);
        if (below <= 0.0) {
            return;
        }
        if (uniforms.sectionEdge.y > 0.0) {
            sectionFade = clamp(below / uniforms.sectionEdge.y, 0.0, 1.0);
        }
    }
    pointMix = max(pointMix, built.mix);
    let viewCenter = uniforms.view * worldCenter;
    let depth = -viewCenter.z;
    if (uniforms.isOrtho == 0u && depth <= 0.0) {
        return;
    }

    let depthOutside = uniforms.depthRange.z > 0.0
        && (depth < uniforms.depthRange.x || depth > uniforms.depthRange.y);
    if (depthOutside && uniforms.depthRange.z < 1.5) {
        return;
    }

    let clip = uniforms.viewProj * worldCenter;
    if (clip.w == 0.0) {
        return;
    }

    let viewport = uniforms.viewport;
    let focal = uniforms.focal;

    let modelView = uniforms.view * model;
    let linear = mat3x3f(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz);
    let gaussian = linear * rotationMatrix(rotation) * mat3x3f(
        vec3f(b.x, 0.0, 0.0),
        vec3f(0.0, b.y, 0.0),
        vec3f(0.0, 0.0, b.z)
    ) * built.scale;
    let row0 = vec3f(gaussian[0].x, gaussian[1].x, gaussian[2].x);
    let row1 = vec3f(gaussian[0].y, gaussian[1].y, gaussian[2].y);
    let row2 = vec3f(gaussian[0].z, gaussian[1].z, gaussian[2].z);
    let c00 = dot(row0, row0);
    let c01 = dot(row0, row1);
    let c02 = dot(row0, row2);
    let c11 = dot(row1, row1);
    let c12 = dot(row1, row2);
    let c22 = dot(row2, row2);

    var cov00: f32;
    var cov01: f32;
    var cov11: f32;
    if (uniforms.isOrtho != 0u) {
        cov00 = focal.x * focal.x * c00;
        cov01 = focal.x * focal.y * c01;
        cov11 = focal.y * focal.y * c11;
    } else {
        let safeDepth = max(depth, 0.001);
        let invDepth = 1.0 / safeDepth;
        let jx0 = focal.x * invDepth;
        let jx2 = focal.x * viewCenter.x * invDepth * invDepth;
        let jy1 = focal.y * invDepth;
        let jy2 = focal.y * viewCenter.y * invDepth * invDepth;
        let u00 = jx0 * c00 + jx2 * c02;
        let u01 = jx0 * c01 + jx2 * c12;
        let u02 = jx0 * c02 + jx2 * c22;
        let u11 = jy1 * c11 + jy2 * c12;
        let u12 = jy1 * c12 + jy2 * c22;
        cov00 = u00 * jx0 + u02 * jx2;
        cov01 = u01 * jy1 + u02 * jy2;
        cov11 = u11 * jy1 + u12 * jy2;
    }

    // depth of field: widen the projected gaussian by the circle of
    // confusion of a thin lens focused at dofParams.y; alpha shrinks by the
    // area ratio so each splat keeps its energy (blur, not brighten)
    var dofAlpha = 1.0;
    if (uniforms.dofParams.x > 0.5) {
        let coc = min(uniforms.dofParams.z * focal.y * abs(uniforms.dofParams.y - 1.0 / max(depth, 0.001)), uniforms.dofParams.w);
        let blurVariance = 0.25 * coc * coc;
        let detSharp = (cov00 + 0.3) * (cov11 + 0.3) - cov01 * cov01;
        cov00 += blurVariance;
        cov11 += blurVariance;
        let detBlurred = (cov00 + 0.3) * (cov11 + 0.3) - cov01 * cov01;
        dofAlpha = sqrt(max(detSharp, 1e-12) / max(detBlurred, 1e-12));
    }

    cov00 += 0.3;
    cov11 += 0.3;
    let determinant = cov00 * cov11 - cov01 * cov01;
    if (determinant <= 0.0) {
        return;
    }

    let mid = 0.5 * (cov00 + cov11);
    let radius = length(vec2f(0.5 * (cov00 - cov11), cov01));
    let lambda1 = mid + radius;
    let lambda2 = max(mid - radius, 0.1);

    // skip splats whose projected size falls below the cull threshold. With the
    // centres overlay up they are projected anyway - their centre still draws -
    // but land in the tail list below instead of among the survivors
    // points have their own size, so the size cull only applies to splats
    let sizeCulled = pointMix < 0.01 && 2.0 * sqrt(2.0 * lambda1) < uniforms.minPixelSize;
    if (sizeCulled && uniforms.keepCulled == 0u) {
        return;
    }

    // principal-axis direction. When the projected covariance is (near-)circular
    // the eigenvector is undefined and vec2f(cov01, lambda1 - cov00) collapses to
    // zero, so normalize() would yield NaN and poison the whole quad. Isotropic
    // gaussians project to exact circles under an orthographic camera (the
    // perspective Jacobian never breaks the symmetry), so this is the common case
    // for spherical skybox splats, not a corner case - fall back to an arbitrary
    // axis, which is correct for a circle.
    let eigenVec = vec2f(cov01, lambda1 - cov00);
    let eigenLen = length(eigenVec);
    let direction = select(vec2f(1.0, 0.0), eigenVec / eigenLen, eigenLen > 1e-9);
    // Cap the longest radius in screen pixels and scale both axes equally
    // to preserve the ellipse's aspect ratio.
    let maxRadius = min(1024.0, min(viewport.x, viewport.y));
    let len1 = 2.0 * sqrt(2.0 * lambda1);
    let radiusScale = min(1.0, maxRadius / len1);
    var axis1 = len1 * radiusScale * direction;
    var len2 = 2.0 * sqrt(2.0 * lambda2) * radiusScale;

    // point cloud: blend the ellipse into a round point of the configured
    // size, in pixels or world units (perspective-attenuated)
    if (pointMix > 0.0) {
        var pointRadius = 0.5 * select(uniforms.pointParams.x, built.pointSize, built.pointSize > 0.0);
        if (uniforms.pointParams.y > 0.5 && built.pointSize <= 0.0) {
            pointRadius *= focal.y / select(max(depth, 0.001), 1.0, uniforms.isOrtho != 0u);
        }
        pointRadius = clamp(pointRadius, 0.75, maxRadius);
        axis1 = mix(axis1, direction * pointRadius, pointMix);
        len2 = mix(len2, pointRadius, pointMix);
    }
    let axis2 = len2 * vec2f(direction.y, -direction.x);

    let ndc = clip.xy / clip.w;
    let extent = abs(axis1) + abs(axis2);
    let centerPixels = (ndc * 0.5 + 0.5) * viewport;
    if (centerPixels.x + extent.x < 0.0 || centerPixels.x - extent.x > viewport.x
        || centerPixels.y + extent.y < 0.0 || centerPixels.y - extent.y > viewport.y) {
        return;
    }

    // splats whose ring would draw are exempt from the motion culls below:
    // rings draw from the survivor list
    let ringKept = uniforms.keepRings != 0u && overlayEligible(state, uniforms.keepRings == 1u);

    // occlusion cull on stochastic frames. The previous stochastic frame's
    // depth buffer samples the visibility function: each pixel kept the
    // nearest fragment that passed its coverage test, so the chance a pixel's
    // depth lies beyond d is the transmittance to d, and the farthest depth
    // over the blocks around a splat bounds what could still have shown
    // behind it there. A splat whose front lies beyond that bound was
    // invisible last frame, up to sampling - a splat with transmittance T
    // escapes a block of N samples with probability (1 - T)^N - and is routed
    // like a size-culled one. Static splats reproject exactly through the
    // previous view, so only true disocclusions arrive a frame late. The
    // gather widens with the footprint - g blocks around the centre covers at
    // least g blocks from it in every direction - and splats wider than two
    // blocks skip the test. The blocks are the previous frame's, so the
    // footprint the splat had there bounds the gather as well: footprints
    // scale with focal length over depth (focal length alone in ortho)
    var occluded = false;
    if (uniforms.occlusionEnabled != 0u && !ringKept) {
        let prevClip = uniforms.prevViewProj * worldCenter;
        let prevDepth = -(uniforms.prevView * worldCenter).z;
        let prevOrtho = uniforms.prevClipZ.z != 0.0;
        let prevLen1 = len1 * (uniforms.prevFocal.x / focal.x)
            * select(depth / max(prevDepth, 0.001), 1.0, prevOrtho);
        let prevNdc = prevClip.xy / max(prevClip.w, 1e-6);
        // The depth map stays in the coordinates it was rasterized in. Match
        // the vertex shader's affine warp, bounding its footprint by the
        // largest axis scale of the local Jacobian (also handles warp toggles).
        var warpedNdc = prevNdc;
        var radius = max(len1, prevLen1);
        if (uniforms.prevClipZ.w > 0.0) {
            let warpScale = warpOffset(prevNdc, vec2f(1.0), uniforms.prevClipZ.w);
            radius *= max(warpScale.x, warpScale.y);
            warpedNdc = warpPosition(prevNdc, uniforms.prevClipZ.w);
        }
        let gather = max(i32(ceil(radius / uniforms.occlusionBlock)), 1);
        if (gather <= 2 && prevClip.w > 0.0 && (prevOrtho || prevDepth > 0.0)) {
            // texture rows run top-down
            let prevPixel = vec2f(warpedNdc.x * 0.5 + 0.5, 0.5 - warpedNdc.y * 0.5) * uniforms.prevViewport;
            let block = vec2i(floor(prevPixel / uniforms.occlusionBlock));
            let blocks = vec2i(i32(uniforms.occlusionBlocksX), i32(uniforms.occlusionBlocksY));
            if (block.x >= gather && block.y >= gather && block.x < blocks.x - gather && block.y < blocks.y - gather) {
                var farthest = 0.0;
                for (var dy = -gather; dy <= gather; dy++) {
                    for (var dx = -gather; dx <= gather; dx++) {
                        farthest = max(farthest, prevDepthMax[u32((block.y + dy) * blocks.x + block.x + dx)]);
                    }
                }
                // the splat's front along the previous view ray, at the same
                // cut-off as the quad's edge, mapped to the depth buffer's
                // clip z the way the render shader maps the centre
                let front = prevDepth - 2.8284 * sqrt(c22);
                let w = select(front, 1.0, prevOrtho);
                if (w > 0.0) {
                    let frontZ = clamp(uniforms.prevClipZ.x * front + uniforms.prevClipZ.y, 0.0, w) / w;
                    occluded = frontZ > farthest;
                }
            }
        }
    }
    if (occluded && uniforms.keepCulled == 0u) {
        return;
    }

    var color = textureLoad(splatColor, uv, 0);
    // the gaussian's committed grade, then the panel's pending one if this
    // gaussian is part of what an Apply would affect. The alpha factors are
    // resolved first, because the contribution cull below needs the opacity
    // the splat will actually draw with; the colour rows wait until after SH
    let grade = paletteGrade(paletteWord >> 16u);
    let previewed = (state & 2u) == 0u &&
        (uniforms.previewMode == 2u || (uniforms.previewMode == 1u && (state & 1u) != 0u));
    var gradedAlpha = color.a * grade.alpha;
    if (previewed) {
        gradedAlpha *= uniforms.colorAlpha;
    }
    // points take the point cloud opacity; the layer opacity (fades) scales both
    gradedAlpha = mix(gradedAlpha, uniforms.pointParams.z, pointMix) * uniforms.layerParams.x * built.alpha * sectionFade * dofAlpha;
    gradedAlpha = clamp(gradedAlpha, 0.0, 1.0);
    // stochastic frames also cull by contribution - the gaussian's alpha mass in
    // pixels, alpha * 2 pi * sqrt(det) of the dilated covariance, the engine's
    // minContribution rule - on top of the size cull. It runs ahead of the SH
    // and colour grade work, so a culled splat costs little more than a
    // size-culled one. A splat whose ring would show is exempt; otherwise it
    // is routed like a size-culled one - dropped, or kept for its centre
    let contributionCulled = !ringKept
        && gradedAlpha * 6.283185 * sqrt(determinant) < uniforms.minContribution;
    if (contributionCulled && uniforms.keepCulled == 0u) {
        return;
    }
    if (${bands}u > 0u) {
        let worldDirection = normalize(worldCenter.xyz - uniforms.cameraPosition);
        let localDirection = normalize(transpose(mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz)) * worldDirection);
        color = vec4f(color.rgb + evaluateSH(uv, localDirection), color.a);
    }
    var graded = applyColorGrade(color.rgb, grade.row0, grade.row1, grade.row2);
    if (previewed) {
        graded = applyColorGrade(graded, uniforms.colorRow0, uniforms.colorRow1, uniforms.colorRow2);
    }
    if (pointMix > 0.0 && uniforms.pointParams.w > 0.5) {
        graded = mix(graded, uniforms.pointColor.rgb, pointMix);
    }
    // quality heatmap (display only): score ramp red -> yellow -> green, or
    // red where the score is under the threshold / the splat is flagged
    // worse than another scan (score byte 0 in mode 3)
    if (uniforms.quality.x > 0.5) {
        let q = f32((instanceScore[instance >> 2u] >> ((instance & 3u) * 8u)) & 0xffu) / 255.0;
        if (uniforms.quality.x < 1.5) {
            let heat = select(mix(vec3f(1.0, 0.0, 0.0), vec3f(1.0, 0.9, 0.0), q * 2.0),
                mix(vec3f(1.0, 0.9, 0.0), vec3f(0.0, 0.9, 0.2), q * 2.0 - 1.0), q > 0.5);
            graded = mix(graded, heat, 0.85);
        } else if (q < uniforms.quality.y) {
            graded = mix(graded, vec3f(1.0, 0.05, 0.05), 0.9);
        }
    }

    // dissolve points lean to the glow colour, and the front glows additively
    graded = mix(graded, uniforms.transF.rgb, clamp(built.tint, 0.0, 1.0));
    graded += uniforms.transF.rgb * built.glow * 1.5;
    color = vec4f(graded, gradedAlpha);

    let selected = (state & 1u) != 0u && uniforms.selectionEnabled != 0u;
    let locked = (state & 2u) != 0u;
    if (locked) {
        color *= uniforms.lockedColor;
    }
    // the cache colour stays untinted: the render shader's vertex stage applies
    // the gaussian selection blends, so the ring path can blend from the
    // splat's own colour independently of them
    // zero-alpha gaussians stay in the frame: they are real, editable splats,
    // so rings mode must still draw and pick them. The render shader's vertex
    // stage skips their quads unless a ring would show, so keeping them here
    // costs only cache slots and sort keys
    color = vec4f(max(color.rgb, vec3f(0.0)), color.a);
    if (depthOutside) {
        // dimmed out-of-range splats: darker and more transparent, so the
        // in-range ones being selected stand out
        color = vec4f(color.rgb * 0.25, color.a * 0.3);
    }

    // rgb: 10/10/10 unorm with a 2-bit shared exponent (scale 1/2/4/8, range [0, 8])
    let maxChannel = max(color.r, max(color.g, color.b));
    var exponent = 0u;
    if (maxChannel > 4.0) {
        exponent = 3u;
    } else if (maxChannel > 2.0) {
        exponent = 2u;
    } else if (maxChannel > 1.0) {
        exponent = 1u;
    }
    let rgb = vec3u(clamp(color.rgb / f32(1u << exponent), vec3f(0.0), vec3f(1.0)) * 1023.0 + 0.5);

    // center: ndc as snorm16. The offscreen cull above bounds visible centers to
    // |ndc| <= 1 + 2 * extentMax / viewport with extentMax = 2 * maxRadius; the
    // render shader derives the same range from its viewport uniform
    let ndcRange = vec2f(1.0) + vec2f(4.0 * maxRadius) / viewport;

    let cacheUv = cacheCoord(entry);
    textureStore(cacheA, cacheUv, vec4u(
        pack2x16snorm(ndc / ndcRange),
        bitcast<u32>(depth),
        rgb.r | (rgb.g << 10u) | (rgb.b << 20u) | (exponent << 30u),
        pack2x16float(axis1)
    ));
    textureStore(cacheB, cacheUv, vec4u(
        pack2x16float(vec2f(len2, 0.0))
            | (u32(clamp(color.a, 0.0, 1.0) * 255.0 + 0.5) << 16u)
            | select(0u, 0x01000000u, selected)
            | select(0u, 0x02000000u, locked)
            // point mix (4 bits) and glow (2 bits) for the render shader
            | (u32(pointMix * 15.0 + 0.5) << 26u)
            | (u32(clamp(uniforms.layerParams.z, 0.0, 1.0) * 3.0 + 0.5) << 30u)
    ));
    if (sizeCulled || contributionCulled || occluded) {
        let tail = atomicAdd(&splatCounter[1], 1u);
        compactEntries[compactTailSlot(tail, uniforms.capacity)] = entry;
        return;
    }
    // survivor: claim a slot in the compact list. Only surviving threads contend,
    // which is 0.1-10% of the dispatch in practice
    let slot = atomicAdd(&splatCounter[0], 1u);
    // depth sort key, back-to-front: linearly normalize view depth to [0,1] over
    // the clip range and invert so the farthest splat gets the smallest key and
    // composites first. Linear in both projections (ortho's clip.z is this same
    // ratio; perspective's clip.z would be hyperbolic, so we normalize the raw
    // view depth instead). near may be negative in ortho (the camera sits inside
    // the bound); the subtraction handles that with no sign special-case.
    let normDepth = saturate((depth - uniforms.near) / (uniforms.far - uniforms.near));
    sortKeys[slot] = u32((1.0 - normDepth) * f32((1u << 20u) - 1u));
    compactEntries[slot] = entry;
}
`;

export { projectedSplatProjector };
