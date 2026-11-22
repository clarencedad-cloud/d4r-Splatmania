"""
Test scenes with known floaters for the floater search (scripts/test-floaters.mjs).

python test-data/make-floater-tests.py [bus.ply]

1. test-data/room-floaters.ply: a room (floor, walls, ceiling) with objects that
   are thin, sparse or hang in the air - a lamp on a cable, a plant with
   branches and leaves, a railing, a table - plus floaters: stray specks,
   small clumps and fog blobs in the room, and haze in front of a wall.
   Splats are flat disks along their surface (needles along cables), sizes
   grow away from the room centre, like in real scans.
2. With a path to a real scan (e.g. dist/bus.ply): <name>-injected.ply in the
   same folder, the scan plus floaters placed in its empty space: specks
   (copies of its own splats), clumps (copies of pieces of the scan) and fog.

Each scene gets a <name>.truth.json with the row ranges of the floaters and of
every labelled part ("labels"). Positions are written in the PLY frame (the
editor rotates PLY files 180 degrees about z, so world y up = PLY -y).
"""

import json
import os
import sys

import numpy as np

rng = np.random.default_rng(7)
SH_C0 = 0.28209479177387814
here = os.path.dirname(os.path.abspath(__file__))


def quat_from_axes(u, v, n):
    # rotation matrix with columns u, v, n -> quaternion (w, x, y, z)
    m = np.stack([u, v, n], axis=-1)
    w = np.sqrt(np.maximum(0, 1 + m[:, 0, 0] + m[:, 1, 1] + m[:, 2, 2])) / 2
    x = np.sqrt(np.maximum(0, 1 + m[:, 0, 0] - m[:, 1, 1] - m[:, 2, 2])) / 2
    y = np.sqrt(np.maximum(0, 1 - m[:, 0, 0] + m[:, 1, 1] - m[:, 2, 2])) / 2
    z = np.sqrt(np.maximum(0, 1 - m[:, 0, 0] - m[:, 1, 1] + m[:, 2, 2])) / 2
    x = np.copysign(x, m[:, 2, 1] - m[:, 1, 2])
    y = np.copysign(y, m[:, 0, 2] - m[:, 2, 0])
    z = np.copysign(z, m[:, 1, 0] - m[:, 0, 1])
    q = np.stack([w, x, y, z], axis=-1)
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def orthonormal(n):
    # two tangents for each normal
    n = n / np.linalg.norm(n, axis=1, keepdims=True)
    a = np.where(np.abs(n[:, :1]) < 0.9, np.array([[1.0, 0, 0]]), np.array([[0, 1.0, 0]]))
    u = np.cross(n, a)
    u /= np.linalg.norm(u, axis=1, keepdims=True)
    v = np.cross(n, u)
    return u, v, n


class Scene:
    def __init__(self):
        self.parts = []
        self.labels = {}

    def add(self, label, pos, scales, axes, color, opacity):
        # pos, scales: (n, 3) world frame (y up); axes: (u, v, n) world frame
        n = len(pos)
        start = sum(len(p['pos']) for p in self.parts)
        self.parts.append({'pos': pos, 'scales': scales, 'axes': axes, 'color': color, 'opacity': opacity})
        self.labels.setdefault(label, []).append([start, start + n])

    def write(self, path, floater_labels):
        pos = np.concatenate([p['pos'] for p in self.parts])
        scales = np.concatenate([p['scales'] for p in self.parts])
        u = np.concatenate([p['axes'][0] for p in self.parts])
        v = np.concatenate([p['axes'][1] for p in self.parts])
        nn = np.concatenate([p['axes'][2] for p in self.parts])
        color = np.concatenate([p['color'] for p in self.parts])
        opacity = np.concatenate([p['opacity'] for p in self.parts])
        # world -> PLY frame: 180 degrees about z
        flip = np.array([-1.0, -1.0, 1.0])
        q = quat_from_axes(u * flip, v * flip, nn * flip)
        n = len(pos)
        data = np.zeros((n, 17), dtype=np.float32)
        data[:, 0:3] = pos * flip
        data[:, 6:9] = (np.clip(color, 0, 1) - 0.5) / SH_C0
        a = np.clip(opacity, 1e-4, 1 - 1e-4)
        data[:, 9] = np.log(a / (1 - a))
        data[:, 10:13] = np.log(np.maximum(scales, 1e-7))
        data[:, 13:17] = q
        props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
                 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
        header = 'ply\nformat binary_little_endian 1.0\nelement vertex %d\n' % n
        header += ''.join('property float %s\n' % p for p in props) + 'end_header\n'
        with open(path, 'wb') as f:
            f.write(header.encode('ascii'))
            f.write(data.tobytes())
        floaters = [r for l in floater_labels for r in self.labels.get(l, [])]
        truth = {'floaters': floaters, 'labels': [{'name': k, 'ranges': v} for k, v in self.labels.items()]}
        with open(path[:-4] + '.truth.json', 'w') as f:
            json.dump(truth, f, indent=1)
        print('%s: %d splats' % (path, n))
        for k, v in self.labels.items():
            print('  %-14s %7d%s' % (k, sum(b - a for a, b in v), '  (floater)' if k in floater_labels else ''))


def surface(scene, label, origin, du, dv, nu, nv, normal, color, center=np.zeros(3)):
    # a sampled plane: splats as flat disks along it, larger away from centre
    i, j = np.meshgrid(np.arange(nu), np.arange(nv), indexing='ij')
    s = rng.random((nu, nv, 2)) - 0.5
    pos = origin + (i[..., None] + s[..., :1]) * du + (j[..., None] + s[..., 1:]) * dv
    pos = pos.reshape(-1, 3)
    spacing = max(np.linalg.norm(du), np.linalg.norm(dv))
    grow = 1 + 0.15 * np.linalg.norm(pos - center, axis=1)
    n = np.tile(normal, (len(pos), 1)) + rng.normal(0, 0.05, (len(pos), 3))
    u, v, nn = orthonormal(n)
    sig = spacing * 0.7 * grow * rng.uniform(0.8, 1.25, len(pos))
    scales = np.stack([sig, sig * rng.uniform(0.6, 1.0, len(pos)), sig * 0.04], axis=1)
    # depth noise of real scans
    pos = pos + nn * rng.normal(0, spacing * 0.15, (len(pos), 1))
    col = np.clip(np.array(color) + rng.normal(0, 0.05, (len(pos), 3)), 0, 1)
    op = np.clip(rng.beta(5, 1.2, len(pos)), 0.05, 1)
    scene.add(label, pos, scales, (u, v, nn), col, op)


def line(scene, label, a, b, radius, step, color, opacity=0.95):
    # a thin structure (cable, branch, rail): needles along the line
    length = np.linalg.norm(b - a)
    n = max(2, int(length / step))
    t = (np.arange(n) + rng.random(n) * 0.5) / n
    d = (b - a) / length
    pos = a + t[:, None] * (b - a) + rng.normal(0, radius * 0.3, (n, 3))
    u = np.tile(d, (n, 1))
    v, w, _ = orthonormal(u)
    scales = np.stack([np.full(n, step * 0.8), np.full(n, radius), np.full(n, radius * 0.6)], axis=1)
    col = np.clip(np.array(color) + rng.normal(0, 0.03, (n, 3)), 0, 1)
    scene.add(label, pos, scales, (u, v, w), col, np.full(n, opacity))


def blob(scene, label, center, radius, count, size, color, opacity, flat=0.1):
    # a compact cluster of splats (lamp shade, leaves, a clump)
    d = rng.normal(0, 1, (count, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    pos = center + d * radius * rng.uniform(0.7, 1.0, (count, 1))
    u, v, nn = orthonormal(d + rng.normal(0, 0.2, (count, 3)))
    scales = np.stack([np.full(count, size), np.full(count, size) * 0.8, np.full(count, size) * flat], axis=1)
    scales *= rng.uniform(0.7, 1.3, (count, 1))
    col = np.clip(np.array(color) + rng.normal(0, 0.05, (count, 3)), 0, 1)
    op = np.full(count, opacity) if np.isscalar(opacity) else opacity
    scene.add(label, pos, scales, (u, v, nn), col, op)


def room():
    sc = Scene()
    sp = 0.04
    # floor, walls, ceiling (y up; room 10 x 3 x 10 m)
    surface(sc, 'floor', np.array([-5, 0, -5.0]), np.array([sp, 0, 0]), np.array([0, 0, sp]), 250, 250, np.array([0, 1.0, 0]), [0.55, 0.5, 0.45])
    surface(sc, 'walls', np.array([-5, 0, -5.0]), np.array([sp, 0, 0]), np.array([0, sp, 0]), 250, 75, np.array([0, 0, 1.0]), [0.8, 0.8, 0.78])
    surface(sc, 'walls', np.array([-5, 0, -5.0]), np.array([0, 0, sp]), np.array([0, sp, 0]), 250, 75, np.array([1.0, 0, 0]), [0.75, 0.78, 0.8])
    surface(sc, 'ceiling', np.array([-5, 3, -5.0]), np.array([0.06, 0, 0]), np.array([0, 0, 0.06]), 167, 167, np.array([0, -1.0, 0]), [0.9, 0.9, 0.9])
    # table: top and four legs
    surface(sc, 'table', np.array([0.5, 0.75, 0.5]), np.array([0.03, 0, 0]), np.array([0, 0, 0.03]), 40, 27, np.array([0, 1.0, 0]), [0.45, 0.3, 0.2])
    for x, z in [(0.55, 0.55), (1.65, 0.55), (0.55, 1.25), (1.65, 1.25)]:
        line(sc, 'table', np.array([x, 0, z]), np.array([x, 0.74, z]), 0.02, 0.02, [0.4, 0.28, 0.18])
    # lamp hanging from the ceiling on a thin cable
    line(sc, 'lamp+cable', np.array([-1.5, 3.0, -1.0]), np.array([-1.5, 2.05, -1.0]), 0.003, 0.006, [0.1, 0.1, 0.1])
    blob(sc, 'lamp+cable', np.array([-1.5, 1.92, -1.0]), 0.18, 900, 0.025, [0.95, 0.9, 0.7], 0.95)
    # plant: trunk, branches and leaf clusters, standing on the floor
    base = np.array([-4.2, 0.0, 2.5])
    top = base + np.array([0, 1.3, 0])
    line(sc, 'plant', base, top, 0.015, 0.012, [0.35, 0.25, 0.15])
    for k in range(14):
        h = rng.uniform(0.4, 1.25)
        start = base + np.array([0, h, 0])
        d = rng.normal(0, 1, 3)
        d[1] = abs(d[1]) * 0.6
        d /= np.linalg.norm(d)
        end = start + d * rng.uniform(0.25, 0.55)
        line(sc, 'plant', start, end, 0.004, 0.008, [0.3, 0.22, 0.12])
        blob(sc, 'plant', end, rng.uniform(0.04, 0.09), int(rng.integers(30, 90)), 0.015, [0.2, 0.55, 0.15], 0.9)
    # railing: posts on the floor and a rail
    for x in np.linspace(-3, 3, 9):
        line(sc, 'railing', np.array([x, 0, 3.5]), np.array([x, 1.0, 3.5]), 0.012, 0.012, [0.6, 0.6, 0.62])
    line(sc, 'railing', np.array([-3, 1.0, 3.5]), np.array([3, 1.0, 3.5]), 0.015, 0.012, [0.6, 0.6, 0.62])

    # floaters in the room volume (away from everything above)
    def free_point():
        while True:
            p = np.array([rng.uniform(-3.5, 4.0), rng.uniform(0.6, 2.5), rng.uniform(-3.5, 3.0)])
            if np.linalg.norm(p[[0, 2]] - np.array([-1.5, -1.0])) < 0.6:
                continue
            if 0.2 < p[0] < 2.0 and 0.2 < p[2] < 1.6 and p[1] < 1.2:
                continue
            return p
    # stray specks: single small opaque splats
    for k in range(200):
        blob(sc, 'specks', free_point(), 0.0, 1, rng.uniform(0.008, 0.03), rng.random(3), rng.uniform(0.5, 1.0), flat=0.3)
    # clumps: 5-80 splats within 2-10 cm
    for k in range(30):
        cnt = int(rng.integers(5, 81))
        blob(sc, 'clumps', free_point(), rng.uniform(0.02, 0.1), cnt, rng.uniform(0.01, 0.025), rng.random(3), rng.uniform(0.6, 1.0, cnt), flat=0.3)
    # fog: large faint blobs, alone or a few together
    for k in range(60):
        c = free_point()
        cnt = int(rng.integers(1, 5))
        blob(sc, 'fog', c, rng.uniform(0.0, 0.3), cnt, rng.uniform(0.12, 0.35), [0.85, 0.85, 0.88], rng.uniform(0.05, 0.4, cnt), flat=0.5)
    # haze in front of the back wall (15-30 cm off it)
    for k in range(80):
        p = np.array([rng.uniform(-4, 4), rng.uniform(0.3, 2.6), -5 + rng.uniform(0.15, 0.3)])
        blob(sc, 'haze', p, 0.0, 1, rng.uniform(0.15, 0.3), [0.85, 0.85, 0.85], rng.uniform(0.05, 0.3), flat=0.4)
    sc.write(os.path.join(here, 'room-floaters.ply'), ['specks', 'clumps', 'fog', 'haze'])


def read_ply(path):
    with open(path, 'rb') as f:
        header = b''
        while True:
            line_ = f.readline()
            header += line_
            if line_.strip() == b'end_header':
                break
        body = f.read()
    lines = header.decode('latin1').split('\n')
    props = [l.split()[2] for l in lines if l.startswith('property')]
    n = int([l for l in lines if l.startswith('element vertex')][0].split()[2])
    data = np.frombuffer(body, dtype='<f4', count=n * len(props)).reshape(n, len(props))
    return header.decode('latin1'), props, data


def inject(path):
    header, props, data = read_ply(path)
    P = {p: i for i, p in enumerate(props)}
    n = len(data)
    world = np.stack([-data[:, P['x']], -data[:, P['y']], data[:, P['z']]], axis=1)
    # coarse occupancy to find empty space (0.25 m voxels around the core)
    lo = np.quantile(world, 0.05, axis=0)
    hi = np.quantile(world, 0.95, axis=0)
    vox = 0.25
    keys = set(map(tuple, np.floor(world / vox).astype(np.int64)))

    def empty(p, margin):
        k = np.floor(p / vox).astype(np.int64)
        r = int(np.ceil(margin / vox))
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    if (k[0] + dx, k[1] + dy, k[2] + dz) in keys:
                        return False
        return True

    def free_point(margin):
        for _ in range(100000):
            p = lo + rng.random(3) * (hi - lo)
            if empty(p, margin):
                return p
        raise RuntimeError('no empty space found')

    rows = []
    labels = {}
    total = n

    def add(label, block):
        nonlocal total
        labels.setdefault(label, []).append([total, total + len(block)])
        rows.append(block)
        total += len(block)

    small = np.where(np.exp(data[:, [P['scale_0'], P['scale_1'], P['scale_2']]]).max(1) < 0.03)[0]
    # specks: copies of small splats of the scan
    for k in range(300):
        b = data[rng.choice(small)].copy()[None, :]
        p = free_point(0.5)
        b[0, P['x']], b[0, P['y']], b[0, P['z']] = -p[0], -p[1], p[2]
        add('specks', b)
    # clumps: copies of small pieces of the scan (its nearest splats)
    sample = rng.choice(n, 200000, replace=False)
    for k in range(40):
        c = world[rng.choice(sample)]
        cnt = int(rng.integers(10, 300))
        d = np.linalg.norm(world[sample] - c, axis=1)
        idx = sample[np.argsort(d)[:cnt]]
        b = data[idx].copy()
        p = free_point(0.75)
        shift = p - world[idx].mean(axis=0)
        b[:, P['x']] -= shift[0]
        b[:, P['y']] -= shift[1]
        b[:, P['z']] += shift[2]
        add('clumps', b)
    # fog: large faint blobs
    for k in range(80):
        c = free_point(1.0)
        cnt = int(rng.integers(1, 6))
        b = np.zeros((cnt, len(props)), dtype=np.float32)
        q = c + rng.normal(0, 0.3, (cnt, 3))
        b[:, P['x']], b[:, P['y']], b[:, P['z']] = -q[:, 0], -q[:, 1], q[:, 2]
        for ch in ['f_dc_0', 'f_dc_1', 'f_dc_2']:
            b[:, P[ch]] = (0.85 - 0.5) / SH_C0
        a = rng.uniform(0.05, 0.4, cnt)
        b[:, P['opacity']] = np.log(a / (1 - a))
        s = rng.uniform(0.15, 0.45, cnt)
        b[:, P['scale_0']] = np.log(s)
        b[:, P['scale_1']] = np.log(s * rng.uniform(0.5, 1.0, cnt))
        b[:, P['scale_2']] = np.log(s * rng.uniform(0.05, 0.5, cnt))
        qq = rng.normal(0, 1, (cnt, 4))
        qq /= np.linalg.norm(qq, axis=1, keepdims=True)
        for i, ch in enumerate(['rot_0', 'rot_1', 'rot_2', 'rot_3']):
            b[:, P[ch]] = qq[:, i]
        add('fog', b)
    out = np.concatenate([data] + rows).astype(np.float32)
    name = os.path.splitext(path)[0] + '-injected.ply'
    head = header.replace('element vertex %d' % n, 'element vertex %d' % len(out))
    with open(name, 'wb') as f:
        f.write(head.encode('latin1'))
        f.write(out.tobytes())
    floaters = [r for v in labels.values() for r in v]
    truth = {'floaters': floaters, 'partial': True, 'labels': [{'name': k, 'ranges': v} for k, v in labels.items()]}
    with open(name[:-4] + '.truth.json', 'w') as f:
        json.dump(truth, f, indent=1)
    print('%s: %d + %d injected (%s)' % (name, n, len(out) - n, ', '.join('%s %d' % (k, sum(b - a for a, b in v)) for k, v in labels.items())))


room()
for arg in sys.argv[1:]:
    inject(arg)
