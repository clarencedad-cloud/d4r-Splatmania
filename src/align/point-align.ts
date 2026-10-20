// Point-pair alignment of splat layers (Splatterline-style anchor alignment).
//
// Given n >= 3 corresponding world-space points on a moving layer (src) and on
// the reference layer (dst), find the similarity transform dst ~ s * R * src + t
// that minimises the squared distance between the pairs. Rotation comes from
// Horn's closed-form quaternion method (largest eigenvector of a symmetric 4x4),
// which always yields a proper rotation (never a reflection). Scale follows
// Umeyama: s = sum(dst_i . R src_i) / sum |src_i|^2 over centred points.
//
// Pure math, no playcanvas dependency, so it can be unit tested in node.

type Vec3Like = { x: number, y: number, z: number };

type AlignResult = {
    // rotation quaternion (x, y, z, w), maps src directions to dst directions
    rotation: [number, number, number, number],
    scale: number,
    translation: [number, number, number],
    // column-major 4x4 of the similarity transform (same layout as playcanvas Mat4.data)
    matrix: number[],
    // root mean square distance between transformed src points and dst points
    rms: number,
    // per-pair residual distances, in input order
    residuals: number[]
};

type AlignOptions = {
    // solve for uniform scale (default true); false gives a rigid transform
    scale?: boolean
};

// Jacobi eigen decomposition of a symmetric n x n matrix (row-major, n*n).
// Returns eigenvalues and eigenvectors (eigenvectors[k] is the k-th vector).
const jacobiEigen = (input: number[], n: number) => {
    const a = input.slice();
    const v = new Array(n * n).fill(0);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;

    for (let sweep = 0; sweep < 100; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
        }
        if (off < 1e-30) break;

        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = a[p * n + q];
                if (Math.abs(apq) < 1e-300) continue;
                const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;

                for (let k = 0; k < n; k++) {
                    const akp = a[k * n + p];
                    const akq = a[k * n + q];
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = a[p * n + k];
                    const aqk = a[q * n + k];
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = v[k * n + p];
                    const vkq = v[k * n + q];
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }

    const values: number[] = [];
    const vectors: number[][] = [];
    for (let k = 0; k < n; k++) {
        values.push(a[k * n + k]);
        const vec: number[] = [];
        for (let i = 0; i < n; i++) vec.push(v[i * n + k]);
        vectors.push(vec);
    }
    return { values, vectors };
};

const rotate = (q: [number, number, number, number], p: number[]) => {
    const [x, y, z, w] = q;
    // v' = v + 2w(u x v) + 2u x (u x v), u = (x, y, z)
    const cx = y * p[2] - z * p[1];
    const cy = z * p[0] - x * p[2];
    const cz = x * p[1] - y * p[0];
    return [
        p[0] + 2 * (w * cx + y * cz - z * cy),
        p[1] + 2 * (w * cy + z * cx - x * cz),
        p[2] + 2 * (w * cz + x * cy - y * cx)
    ];
};

/**
 * Solve the similarity transform that maps src points onto dst points.
 * Throws if there are fewer than 3 pairs, the counts differ, or the points
 * are (nearly) collinear, since the rotation is then undetermined.
 */
const alignPoints = (src: Vec3Like[], dst: Vec3Like[], options: AlignOptions = {}): AlignResult => {
    const n = src.length;
    if (n !== dst.length) throw new Error(`alignPoints: ${n} source points but ${dst.length} target points`);
    if (n < 3) throw new Error('alignPoints: at least 3 point pairs are needed');

    const centroid = (pts: Vec3Like[]) => {
        const c = [0, 0, 0];
        pts.forEach((p) => {
            c[0] += p.x; c[1] += p.y; c[2] += p.z;
        });
        return c.map(v => v / n);
    };
    const cs = centroid(src);
    const cd = centroid(dst);
    const a = src.map(p => [p.x - cs[0], p.y - cs[1], p.z - cs[2]]);
    const b = dst.map(p => [p.x - cd[0], p.y - cd[1], p.z - cd[2]]);

    // cross-covariance M[i][j] = sum a_i * b_j
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    let srcVar = 0;
    for (let k = 0; k < n; k++) {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) m[i * 3 + j] += a[k][i] * b[k][j];
        }
        srcVar += a[k][0] * a[k][0] + a[k][1] * a[k][1] + a[k][2] * a[k][2];
    }
    if (srcVar < 1e-20) throw new Error('alignPoints: source points coincide');

    // degenerate if the source points are collinear: the second largest
    // eigenvalue of the source scatter matrix vanishes relative to the largest
    const scatter = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    a.forEach((p) => {
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) scatter[i * 3 + j] += p[i] * p[j];
    });
    const spread = jacobiEigen(scatter, 3).values.sort((x, y) => y - x);
    if (spread[1] < spread[0] * 1e-8) throw new Error('alignPoints: points are collinear, place them in a triangle');

    const [sxx, sxy, sxz, syx, syy, syz, szx, szy, szz] = m;
    const nMat = [
        sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
        syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
        szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
        sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz
    ];
    const { values, vectors } = jacobiEigen(nMat, 4);
    let best = 0;
    for (let k = 1; k < 4; k++) if (values[k] > values[best]) best = k;
    const [qw, qx, qy, qz] = vectors[best];
    const len = Math.hypot(qw, qx, qy, qz);
    // canonical sign: w >= 0
    const sign = qw < 0 ? -1 : 1;
    const rotation: [number, number, number, number] = [sign * qx / len, sign * qy / len, sign * qz / len, sign * qw / len];

    let scale = 1;
    if (options.scale ?? true) {
        let dot = 0;
        for (let k = 0; k < n; k++) {
            const ra = rotate(rotation, a[k]);
            dot += ra[0] * b[k][0] + ra[1] * b[k][1] + ra[2] * b[k][2];
        }
        scale = dot / srcVar;
        if (!(scale > 0)) throw new Error('alignPoints: could not determine a positive scale');
    }

    const rcs = rotate(rotation, cs);
    const translation: [number, number, number] = [
        cd[0] - scale * rcs[0],
        cd[1] - scale * rcs[1],
        cd[2] - scale * rcs[2]
    ];

    // column-major matrix: columns are the scaled rotated basis vectors
    const ex = rotate(rotation, [1, 0, 0]);
    const ey = rotate(rotation, [0, 1, 0]);
    const ez = rotate(rotation, [0, 0, 1]);
    const matrix = [
        scale * ex[0], scale * ex[1], scale * ex[2], 0,
        scale * ey[0], scale * ey[1], scale * ey[2], 0,
        scale * ez[0], scale * ez[1], scale * ez[2], 0,
        translation[0], translation[1], translation[2], 1
    ];

    const residuals = src.map((p, k) => {
        const r = rotate(rotation, [p.x, p.y, p.z]);
        const d = dst[k];
        return Math.hypot(scale * r[0] + translation[0] - d.x, scale * r[1] + translation[1] - d.y, scale * r[2] + translation[2] - d.z);
    });
    const rms = Math.sqrt(residuals.reduce((acc, r) => acc + r * r, 0) / n);

    return { rotation, scale, translation, matrix, rms, residuals };
};

export { alignPoints, AlignResult, AlignOptions, Vec3Like };
