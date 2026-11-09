# synthetic stereo test scene: a grey cylinder wall (radius 10, centred on the
# origin) with four small bright markers at 1.5 units from the capture point
# (origin, y = 1.5): red in front (-z), blue behind (+z), green right (+x),
# yellow left (-x). Plus a white marker straight above (pole test).
import math
import random
import struct
import sys

out = sys.argv[1]
SH0 = 0.28209479177387814
random.seed(1)
points = []


def col(r, g, b):
    return [(c - 0.5) / SH0 for c in (r, g, b)]


def add(x, y, z, rgb, scale, alpha=0.99):
    logit = math.log(alpha / (1 - alpha))
    s = math.log(scale)
    points.append((x, y, z, 0, 0, 0, *col(*rgb), logit, s, s, s, 1, 0, 0, 0))


# wall
for i in range(60000):
    a = random.uniform(0, 2 * math.pi)
    h = random.uniform(-4, 7)
    g = 0.35 + 0.3 * random.random()
    # stripes so the wall itself has texture
    if int((a * 10) / math.pi) % 2 == 0:
        g *= 0.6
    add(10 * math.sin(a), h, -10 * math.cos(a), (g, g, g), 0.08)

# floor disc
for i in range(20000):
    r = 10 * math.sqrt(random.random())
    a = random.uniform(0, 2 * math.pi)
    add(r * math.sin(a), -0.5, -r * math.cos(a), (0.25, 0.22, 0.3), 0.08)


def marker(cx, cy, cz, rgb, radius=0.06, n=400):
    for i in range(n):
        u = random.uniform(-1, 1)
        a = random.uniform(0, 2 * math.pi)
        rr = radius * random.random() ** (1 / 3)
        s = math.sqrt(1 - u * u)
        add(cx + rr * s * math.cos(a), cy + rr * u, cz + rr * s * math.sin(a), rgb, 0.015)


y0 = 1.5
marker(0, y0, -1.5, (1, 0, 0))     # front
marker(0, y0, 1.5, (0, 0, 1))      # back
marker(1.5, y0, 0, (0, 1, 0))      # right
marker(-1.5, y0, 0, (1, 1, 0))     # left
marker(0, y0 + 1.5, -0.05, (1, 1, 1))   # (almost) straight up

header = ('ply\nformat binary_little_endian 1.0\nelement vertex %d\n' % len(points) +
          ''.join('property float %s\n' % p for p in
                  ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
                   'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) +
          'end_header\n')
with open(out, 'wb') as f:
    f.write(header.encode())
    for p in points:
        f.write(struct.pack('<17f', *p))
print(len(points))
