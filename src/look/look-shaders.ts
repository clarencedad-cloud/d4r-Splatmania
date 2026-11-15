// Shaders of the look (src/look/look-renderer.ts): a bloom chain (prefilter,
// dual-filter down / up samples) and one composite pass doing grading,
// lens effects and the LUT. Uniform and texture names carry a 'look' prefix:
// they resolve through the device's shared scope, so they must not collide
// with other passes.

const vertexShader = /* wgsl */`
attribute vertex_position: vec2f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(input.vertex_position, 0.0, 1.0);
    return output;
}
`;

// source pixel fetch shared by the passes reading the full-res image; x wraps
// for equirect panoramas (the left and right edges meet)
const loadSrcWGSL = /* wgsl */`
fn lookLoad(p: vec2i) -> vec4f {
    let dims = vec2i(textureDimensions(lookSrc));
    var q = p;
    if (uniform.lookWrap > 0.5) {
        q.x = ((q.x % dims.x) + dims.x) % dims.x;
    }
    return textureLoad(lookSrc, clamp(q, vec2i(0), dims - vec2i(1)), 0);
}
`;

// full res -> half res, keeping only what is brighter than the threshold
// (soft knee). Works on the premultiplied splat colour without the
// background, so a bright background does not flood the frame with glow
const prefilterShader = /* wgsl */`
var lookSrc: texture_2d<f32>;
uniform lookWrap: f32;
uniform lookThreshold: vec2f;

${loadSrcWGSL}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let base = vec2i(pcPosition.xy) * 2;
    let c = (lookLoad(base) + lookLoad(base + vec2i(1, 0)) + lookLoad(base + vec2i(0, 1)) + lookLoad(base + vec2i(1, 1))) * 0.25;
    let brightness = max(c.r, max(c.g, c.b));
    let threshold = uniform.lookThreshold.x;
    let knee = max(uniform.lookThreshold.y, 1e-4);
    var soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    let contribution = max(soft, brightness - threshold) / max(brightness, 1e-4);
    output.color = vec4f(c.rgb * contribution, 1.0);
    return output;
}
`;

// dual-filter downsample: centre plus four diagonal bilinear taps
const downShader = /* wgsl */`
var lookTex: texture_2d<f32>;
var lookTex_sampler: sampler;
uniform lookTexel: vec4f;

fn s(uv: vec2f) -> vec3f {
    return textureSampleLevel(lookTex, lookTex_sampler, uv, 0.0).rgb;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let uv = pcPosition.xy * uniform.lookTexel.zw;
    let h = uniform.lookTexel.xy;
    var sum = s(uv) * 4.0;
    sum += s(uv + vec2f(-h.x, -h.y));
    sum += s(uv + vec2f(h.x, -h.y));
    sum += s(uv + vec2f(-h.x, h.y));
    sum += s(uv + vec2f(h.x, h.y));
    output.color = vec4f(sum / 8.0, 1.0);
    return output;
}
`;

// dual-filter upsample of the coarser level, added to this level: the sum
// over the levels is the glow (wide and narrow at once)
const upShader = /* wgsl */`
var lookTex: texture_2d<f32>;
var lookTex_sampler: sampler;
var lookCur: texture_2d<f32>;
uniform lookTexel: vec4f;
uniform lookSpread: f32;

fn s(uv: vec2f) -> vec3f {
    return textureSampleLevel(lookTex, lookTex_sampler, uv, 0.0).rgb;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let uv = pcPosition.xy * uniform.lookTexel.zw;
    let h = uniform.lookTexel.xy;
    var sum = s(uv + vec2f(-2.0 * h.x, 0.0));
    sum += s(uv + vec2f(-h.x, h.y)) * 2.0;
    sum += s(uv + vec2f(0.0, 2.0 * h.y));
    sum += s(uv + vec2f(h.x, h.y)) * 2.0;
    sum += s(uv + vec2f(2.0 * h.x, 0.0));
    sum += s(uv + vec2f(h.x, -h.y)) * 2.0;
    sum += s(uv + vec2f(0.0, -2.0 * h.y));
    sum += s(uv + vec2f(-h.x, -h.y)) * 2.0;
    let cur = textureLoad(lookCur, vec2i(pcPosition.xy), 0).rgb;
    output.color = vec4f(cur + sum / 12.0 * uniform.lookSpread, 1.0);
    return output;
}
`;

// everything else in one pass, in film order: chromatic aberration on the
// lens image, background, exposure and white balance, contrast, saturation,
// LUT, glow (graded like light), vignette, grain. The image is premultiplied;
// the non-linear steps work on the straight colour
const compositeShader = /* wgsl */`
var lookSrc: texture_2d<f32>;
var lookBloom: texture_2d<f32>;
var lookBloom_sampler: sampler;
var lookLut: texture_2d<f32>;
uniform lookWrap: f32;
uniform lookSize: vec4f;
uniform lookBg: vec4f;
uniform lookBloomTint: vec4f;
uniform lookGrade: vec4f;
uniform lookFx: vec4f;
uniform lookLutParams: vec4f;

${loadSrcWGSL}

const LUMA = vec3f(0.2126, 0.7152, 0.0722);

fn lutFetch(i: vec3i, n: i32) -> vec3f {
    let c = clamp(i, vec3i(0), vec3i(n - 1));
    return textureLoad(lookLut, vec2i(c.r + c.b * n, c.g), 0).rgb;
}

// trilinear lookup in an N^3 cube laid out as N slices side by side
fn lut(rgb: vec3f) -> vec3f {
    let n = i32(uniform.lookLutParams.x);
    let p = clamp(rgb, vec3f(0.0), vec3f(1.0)) * f32(n - 1);
    let i = vec3i(floor(p));
    let f = p - floor(p);
    let c000 = lutFetch(i, n);
    let c100 = lutFetch(i + vec3i(1, 0, 0), n);
    let c010 = lutFetch(i + vec3i(0, 1, 0), n);
    let c110 = lutFetch(i + vec3i(1, 1, 0), n);
    let c001 = lutFetch(i + vec3i(0, 0, 1), n);
    let c101 = lutFetch(i + vec3i(1, 0, 1), n);
    let c011 = lutFetch(i + vec3i(0, 1, 1), n);
    let c111 = lutFetch(i + vec3i(1, 1, 1), n);
    let x00 = mix(c000, c100, f.r);
    let x10 = mix(c010, c110, f.r);
    let x01 = mix(c001, c101, f.r);
    let x11 = mix(c011, c111, f.r);
    return mix(mix(x00, x10, f.g), mix(x01, x11, f.g), f.b);
}

fn hash(p: vec2f) -> f32 {
    let q = fract(p * vec2f(0.1031, 0.1030));
    let r = q + dot(q, q.yx + 33.33);
    return fract((r.x + r.y) * r.x);
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let px = vec2i(pcPosition.xy);
    let uv = pcPosition.xy * uniform.lookSize.zw;
    let centred = uv - 0.5;

    // chromatic aberration: red and blue shift apart toward the edges
    var c = lookLoad(px);
    let ca = uniform.lookFx.w;
    if (ca > 0.0) {
        let offset = vec2i(round(centred * 2.0 * ca));
        c.r = lookLoad(px + offset).r;
        c.b = lookLoad(px - offset).b;
    }

    // opaque background (viewport and exports with a background colour)
    if (uniform.lookBg.a > 0.5) {
        c = vec4f(c.rgb + uniform.lookBg.rgb * (1.0 - c.a), 1.0);
    }

    let alpha = c.a;
    var rgb = select(vec3f(0.0), c.rgb / alpha, alpha > 1e-4);

    let exposure = uniform.lookGrade.x;
    let temperature = uniform.lookGrade.w;
    let balance = vec3f(1.0 + 0.25 * temperature, 1.0, 1.0 - 0.25 * temperature) * exposure;
    rgb *= balance;
    rgb = max((rgb - 0.5) * uniform.lookGrade.y + 0.5, vec3f(0.0));
    let l = dot(rgb, LUMA);
    rgb = max(mix(vec3f(l), rgb, uniform.lookGrade.z), vec3f(0.0));
    if (uniform.lookLutParams.z > 0.5) {
        rgb = mix(rgb, lut(rgb), uniform.lookLutParams.y);
    }

    var col = rgb * alpha;
    var a = alpha;

    // glow: light added on top, through the same exposure and white balance
    if (uniform.lookBloomTint.a > 0.5) {
        let b = textureSampleLevel(lookBloom, lookBloom_sampler, uv, 0.0).rgb * uniform.lookBloomTint.rgb * balance;
        col += b;
        a = max(a, clamp(max(b.r, max(b.g, b.b)), 0.0, 1.0));
    }

    // vignette: darkens toward the corners (corner distance = 1)
    let amount = uniform.lookFx.x;
    if (amount > 0.0) {
        let d = length(centred) * 1.41421356;
        let start = (1.0 - uniform.lookFx.y) * 0.9;
        col *= 1.0 - amount * smoothstep(start, 1.0001, d);
    }

    // grain: luminance noise, strongest in the mid tones, new every frame
    let grain = uniform.lookFx.z;
    if (grain > 0.0) {
        let n = hash(pcPosition.xy + vec2f(uniform.lookLutParams.w * 17.0, uniform.lookLutParams.w * 29.0)) - 0.5;
        let lum = clamp(dot(col, LUMA), 0.0, 1.0);
        col += vec3f(n * grain * (0.35 + 2.6 * lum * (1.0 - lum))) * a;
    }

    output.color = vec4f(max(col, vec3f(0.0)), a);
    return output;
}
`;

// plain pixel copy (the look's result back into the source target)
const copyShader = /* wgsl */`
var lookCopySrc: texture_2d<f32>;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    output.color = textureLoad(lookCopySrc, vec2i(pcPosition.xy), 0);
    return output;
}
`;

export { vertexShader, prefilterShader, downShader, upShader, compositeShader, copyShader };
