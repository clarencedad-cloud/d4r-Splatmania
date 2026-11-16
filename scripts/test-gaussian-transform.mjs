/**
 * Checks src/gaussian-transform.ts (export of layers with a per-axis scale):
 * the covariance rebuilt from the output rotation and scales must equal
 * M · R · S² · Rᵀ · Mᵀ for random gaussians and layer transforms.
 * Run: node scripts/test-gaussian-transform.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules', '.cache', 'gaussian-transform-test');
mkdirSync(out, { recursive: true });
const code = readFileSync(join(root, 'src', 'gaussian-transform.ts'), 'utf8');
const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
writeFileSync(join(out, 'gaussian-transform.mjs'), js);
const { isUniform, transformGaussian } = await import(pathToFileURL(join(out, 'gaussian-transform.mjs')).href);
const { Mat4, Quat, Vec3 } = await import('playcanvas');

let seed = 7;
const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};
const randomQuat = () => new Quat(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
const rot = (q) => {
    const m = new Mat4().setTRS(Vec3.ZERO, q, Vec3.ONE).data;
    return [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
};
const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _v, k) => s + A[i][k] * B[k][j], 0)));
const T = A => A[0].map((_, j) => A.map(r => r[j]));
const covOf = (R, s) => mul(mul(R, [[s[0] ** 2, 0, 0], [0, s[1] ** 2, 0], [0, 0, s[2] ** 2]]), T(R));

let passed = 0;
let failed = 0;
let worst = 0;
const check = (ok, message) => {
    if (ok) passed++;
    else {
        failed++;
        console.log('  FAIL', message);
    }
};

check(isUniform(new Vec3(2, 2, 2)), 'uniform scale detected');
check(!isUniform(new Vec3(2, 1, 2)), 'per-axis scale detected');

const outBuf = new Float32Array(8);
for (let n = 0; n < 2000; n++) {
    const q = randomQuat();
    const s = [0.01 + rnd(), 0.01 + rnd() * 0.3, 0.01 + rnd() * 2];
    const layer = new Mat4().setTRS(new Vec3(rnd(), rnd(), rnd()), randomQuat(), new Vec3(0.2 + rnd() * 3, 0.2 + rnd() * 3, 0.2 + rnd() * 3));
    const M = rot(new Quat()).map((_r, i) => [0, 1, 2].map(j => layer.data[j * 4 + i]));
    const expected = mul(mul(M, covOf(rot(q), s)), T(M));

    transformGaussian(layer, q, Math.log(s[0]), Math.log(s[1]), Math.log(s[2]), outBuf, 0);
    const q2 = new Quat(outBuf[1], outBuf[2], outBuf[3], outBuf[0]);
    const s2 = [Math.exp(outBuf[4]), Math.exp(outBuf[5]), Math.exp(outBuf[6])];
    const got = covOf(rot(q2), s2);

    const scale = Math.max(...expected.flat().map(Math.abs));
    const err = Math.max(...expected.flat().map((v, i) => Math.abs(v - got.flat()[i]))) / scale;
    worst = Math.max(worst, err);
    check(err < 1e-4, `covariance matches (${err.toExponential(2)})`);
    check(Math.abs(q2.length() - 1) < 1e-5, 'rotation is normalised');
}

console.log(`worst relative error ${worst.toExponential(2)}`);
console.log(`${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
