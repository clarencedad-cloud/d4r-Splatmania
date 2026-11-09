# measure horizontal disparity of the colour markers between the left (top)
# and right (bottom) eye of a top-bottom stereo equirect
import math
import sys

import numpy as np
from PIL import Image

img = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int32)
ipd = float(sys.argv[2]) if len(sys.argv) > 2 else 0.064
dist = float(sys.argv[3]) if len(sys.argv) > 3 else 1.5
H, W, _ = img.shape
eye_h = H // 2
eyes = [img[:eye_h], img[eye_h:2 * eye_h]]

markers = {
    'rot (vorne)': lambda r, g, b: (r > 180) & (g < 80) & (b < 80),
    'blau (hinten)': lambda r, g, b: (b > 180) & (r < 80) & (g < 80),
    'gruen (links)': lambda r, g, b: (g > 180) & (r < 80) & (b < 80),
    'gelb (rechts)': lambda r, g, b: (r > 180) & (g > 180) & (b < 80),
    'weiss (Pol unten)': lambda r, g, b: (r > 235) & (g > 235) & (b > 235),
}

expected = 2 * math.asin(ipd / 2 / dist) / (2 * math.pi) * W
print(f'eye {W}x{eye_h}, expected disparity at {dist} units: {expected:.2f} px (left eye further right = positive)')


def centroid(eye, test):
    r, g, b = eye[..., 0], eye[..., 1], eye[..., 2]
    mask = test(r, g, b)
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    # circular mean for x (markers may sit on the seam)
    ang = xs / W * 2 * math.pi
    cx = (math.atan2(np.sin(ang).mean(), np.cos(ang).mean()) % (2 * math.pi)) / (2 * math.pi) * W
    return cx, ys.mean(), len(xs)


for name, test in markers.items():
    left = centroid(eyes[0], test)
    right = centroid(eyes[1], test)
    if not left or not right:
        print(f'{name}: not found ({left}, {right})')
        continue
    dx = (left[0] - right[0] + W / 2) % W - W / 2
    print(f'{name}: L x={left[0]:.1f} y={left[1]:.1f} n={left[2]} | R x={right[0]:.1f} y={right[1]:.1f} n={right[2]} | disparity {dx:+.2f} px')
