// Regenerates resources/icon.png. Kept in-repo so the icon can be reproduced
// rather than re-guessed: a magnifier lens containing a six-arm asterisk, the
// glyph Claude Code itself uses to denote a session.
//
// Requires Python with Pillow:  python3 -c "import PIL"
// Run:                          node scripts/make-icon.mjs
import { execFileSync } from 'node:child_process';

const PY = `
from PIL import Image, ImageDraw
import math
S = 1024                      # supersample, then downscale for smooth edges
CLAY  = (198, 108, 78)        # ground
WHITE = (255, 255, 255)       # glyph

im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d  = ImageDraw.Draw(im)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=CLAY)

cx, cy, r, stroke = S * 0.445, S * 0.425, S * 0.285, int(S * 0.070)
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=WHITE, width=stroke)

a  = math.radians(45)
hs = int(stroke * 1.2)
x0, y0 = cx + r * math.cos(a), cy + r * math.sin(a)
L = r * 0.92
x1, y1 = x0 + L * math.cos(a), y0 + L * math.sin(a)
d.line([x0, y0, x1, y1], fill=WHITE, width=hs)
for px, py in ((x0, y0), (x1, y1)):
    d.ellipse([px - hs / 2, py - hs / 2, px + hs / 2, py + hs / 2], fill=WHITE)

sr, sth = S * 0.128, int(S * 0.044)
for i in range(6):
    ang = math.radians(i * 60)
    d.line([cx - sr * math.cos(ang), cy - sr * math.sin(ang),
            cx + sr * math.cos(ang), cy + sr * math.sin(ang)], fill=WHITE, width=sth)
    for s in (-1, 1):
        px, py = cx + s * sr * math.cos(ang), cy + s * sr * math.sin(ang)
        d.ellipse([px - sth / 2, py - sth / 2, px + sth / 2, py + sth / 2], fill=WHITE)

im.resize((128, 128), Image.LANCZOS).save('resources/icon.png')
print('resources/icon.png regenerated (128x128)')
`;
execFileSync('python3', ['-c', PY], { stdio: 'inherit' });
