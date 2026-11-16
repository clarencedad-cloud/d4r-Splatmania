import { Mat4, Quat, Vec3 } from 'playcanvas';

// Per-gaussian transform for a non-uniform layer scale (export, merge): the
// gaussian's axes no longer line up with the layer's axes, so its covariance
// is transformed and split again into a rotation and per-axis scales.

const isUniform = (s: Vec3) => {
    const m = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) || 1;
    return Math.abs(s.x - s.y) <= 1e-6 * m && Math.abs(s.x - s.z) <= 1e-6 * m;
};

// eigen decomposition of a symmetric 3x3 matrix (Jacobi rotations).
// a: row-major [a00 a01 a02 a11 a12 a22] in, eigenvalues out in `values`,
// eigenvectors as the columns of `vectors` (row-major 3x3)
const jacobiEigen = (a: Float64Array, values: Float64Array, vectors: Float64Array) => {
    const m = [a[0], a[1], a[2], a[1], a[3], a[4], a[2], a[4], a[5]];
    vectors.fill(0);
    vectors[0] = vectors[4] = vectors[8] = 1;
    for (let sweep = 0; sweep < 24; sweep++) {
        const off = Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[5]);
        if (off < 1e-30) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            const apq = m[p * 3 + q];
            if (Math.abs(apq) < 1e-30) continue;
            const app = m[p * 3 + p];
            const aqq = m[q * 3 + q];
            const theta = (aqq - app) / (2 * apq);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let k = 0; k < 3; k++) {
                const mkp = m[k * 3 + p];
                const mkq = m[k * 3 + q];
                m[k * 3 + p] = c * mkp - s * mkq;
                m[k * 3 + q] = s * mkp + c * mkq;
            }
            for (let k = 0; k < 3; k++) {
                const mpk = m[p * 3 + k];
                const mqk = m[q * 3 + k];
                m[p * 3 + k] = c * mpk - s * mqk;
                m[q * 3 + k] = s * mpk + c * mqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = vectors[k * 3 + p];
                const vkq = vectors[k * 3 + q];
                vectors[k * 3 + p] = c * vkp - s * vkq;
                vectors[k * 3 + q] = s * vkp + c * vkq;
            }
        }
    }
    values[0] = m[0];
    values[1] = m[4];
    values[2] = m[8];
};

const tmpCov = new Float64Array(6);
const tmpValues = new Float64Array(3);
const tmpVectors = new Float64Array(9);
const tmpAxes = new Float64Array(9);
const tmpRotMat = new Mat4();
const tmpQuat = new Quat();

// covariance of a gaussian (rotation q, log scales) after the linear part of
// `mat`, split again into a rotation and log scales: Σ' = M R S² Rᵀ Mᵀ
const transformGaussian = (mat: Mat4, q: Quat, ls0: number, ls1: number, ls2: number, out: Float32Array, dst: number) => {
    const d = mat.data;
    const s = [Math.exp(ls0), Math.exp(ls1), Math.exp(ls2)];
    // A = M · R · S, column j = M · (R column j) · s_j
    tmpRotMat.setTRS(Vec3.ZERO, q, Vec3.ONE);
    const r = tmpRotMat.data;
    for (let j = 0; j < 3; j++) {
        const rx = r[j * 4];
        const ry = r[j * 4 + 1];
        const rz = r[j * 4 + 2];
        tmpAxes[j * 3] = (d[0] * rx + d[4] * ry + d[8] * rz) * s[j];
        tmpAxes[j * 3 + 1] = (d[1] * rx + d[5] * ry + d[9] * rz) * s[j];
        tmpAxes[j * 3 + 2] = (d[2] * rx + d[6] * ry + d[10] * rz) * s[j];
    }
    // Σ' = A Aᵀ (upper triangle)
    const cov = (i: number, k: number) => tmpAxes[i] * tmpAxes[k] + tmpAxes[3 + i] * tmpAxes[3 + k] + tmpAxes[6 + i] * tmpAxes[6 + k];
    tmpCov[0] = cov(0, 0);
    tmpCov[1] = cov(0, 1);
    tmpCov[2] = cov(0, 2);
    tmpCov[3] = cov(1, 1);
    tmpCov[4] = cov(1, 2);
    tmpCov[5] = cov(2, 2);
    jacobiEigen(tmpCov, tmpValues, tmpVectors);
    // eigenvectors as a proper rotation (determinant +1)
    const v = tmpVectors;
    const det = v[0] * (v[4] * v[8] - v[5] * v[7]) - v[1] * (v[3] * v[8] - v[5] * v[6]) + v[2] * (v[3] * v[7] - v[4] * v[6]);
    if (det < 0) {
        v[2] = -v[2];
        v[5] = -v[5];
        v[8] = -v[8];
    }
    const m = tmpRotMat.data;
    m[0] = v[0]; m[1] = v[3]; m[2] = v[6]; m[3] = 0;
    m[4] = v[1]; m[5] = v[4]; m[6] = v[7]; m[7] = 0;
    m[8] = v[2]; m[9] = v[5]; m[10] = v[8]; m[11] = 0;
    m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
    tmpQuat.setFromMat4(tmpRotMat).normalize();
    out[dst] = tmpQuat.w;
    out[dst + 1] = tmpQuat.x;
    out[dst + 2] = tmpQuat.y;
    out[dst + 3] = tmpQuat.z;
    for (let i = 0; i < 3; i++) out[dst + 4 + i] = Math.log(Math.sqrt(Math.max(tmpValues[i], 1e-30)));
};

export { isUniform, jacobiEigen, transformGaussian };
