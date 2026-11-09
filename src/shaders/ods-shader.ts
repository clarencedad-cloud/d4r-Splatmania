// omnidirectional stereo (src/ods-renderer.ts): each eye's equirect is
// accumulated from narrow vertical strips. A strip is a perspective render
// looking at azimuth uStrip.x from the eye position tangent to the IPD
// circle; this pass writes its azimuth band, tent-weighted so neighbouring
// strips cross-fade (weights sum to 1), and fades the stereo strip into the
// mono panorama towards the poles where ODS breaks down.

const vertexShader = /* wgsl */`
attribute vertex_position: vec2f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(input.vertex_position, 0.0, 1.0);
    return output;
}
`;

const compositeShader = /* wgsl */`
var uStripTex: texture_2d<f32>;
var uStripTex_sampler: sampler;
var uMonoTex: texture_2d<f32>;
var uMonoTex_sampler: sampler;
uniform uTargetSize: vec2f;
// x: strip azimuth (lon, rad), y: half band width (rad, tent radius),
// z: tan of the strip's half horizontal fov, w: tan of its half vertical fov
uniform uStrip: vec4f;
// x: pole fade start, y: pole fade end (|lat| in rad)
uniform uPole: vec4f;

const PI = 3.141592653589793;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let uv = pcPosition.xy / uniform.uTargetSize;
    let lon = (uv.x - 0.5) * 2.0 * PI;
    let lat = (0.5 - uv.y) * PI;

    // azimuth relative to the strip, wrapped to [-pi, pi]
    var phi = lon - uniform.uStrip.x;
    phi = phi - 2.0 * PI * floor((phi + PI) / (2.0 * PI));

    let w = max(0.0, 1.0 - abs(phi) / uniform.uStrip.y);
    let mono = textureSampleLevel(uMonoTex, uMonoTex_sampler, uv, 0.0);

    // stereo weight: 1 around the horizon, 0 towards the poles
    let s = 1.0 - smoothstep(uniform.uPole.x, uniform.uPole.y, abs(lat));

    var color = mono;
    if (s > 0.0 && abs(phi) < 1.5) {
        // perspective strip camera: x = tan(phi), y = tan(lat) / cos(phi)
        let p = vec2f(tan(phi), tan(lat) / cos(phi));
        let suv = vec2f(0.5 + 0.5 * p.x / uniform.uStrip.z, 0.5 - 0.5 * p.y / uniform.uStrip.w);
        if (abs(p.y) < uniform.uStrip.w) {
            let strip = textureSampleLevel(uStripTex, uStripTex_sampler, suv, 0.0);
            color = mix(mono, strip, s);
        }
    }

    output.color = color * w;
    return output;
}
`;

const clearShader = /* wgsl */`
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    output.color = vec4f(0.0);
    return output;
}
`;

export { vertexShader, compositeShader, clearShader };
