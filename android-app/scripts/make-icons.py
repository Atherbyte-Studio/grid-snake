"""Draws the app icon (dark tile, emerald snake, amber apple) and writes every Android density.
Run: python3 scripts/make-icons.py   (needs Pillow). The results are committed, so this is only for redesigns."""
import math, os
from PIL import Image, ImageDraw
RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')
BG, SNAKE, SNAKE_HI, APPLE, LEAF = (18, 20, 19), (52, 178, 124), (96, 214, 160), (240, 168, 48), (96, 200, 120)
S = 1024

def art(scale=1.0, bg=True):
    im = Image.new('RGBA', (S, S), BG + (255,) if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    def P(x, y): return (S / 2 + (x - 512) * scale, S / 2 + (y - 512) * scale)
    w = int(120 * scale)
    pts = [(250, 700), (250, 400), (512, 400), (512, 650), (770, 650)]
    path = [P(*p) for p in pts]
    for a, b in zip(path, path[1:]):
        d.line([a, b], fill=SNAKE, width=w)
    for p in path:
        d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=SNAKE)
    hx, hy = P(250, 700)                                        # tail tip: taper
    d.ellipse([hx - w * .5, hy - w * .5, hx + w * .5, hy + w * .5], fill=SNAKE)
    hx, hy = path[-1]                                           # head with eyes, looking right
    r = w * .62
    d.ellipse([hx - r, hy - r, hx + r, hy + r], fill=SNAKE_HI)
    for dy in (-1, 1):
        ex, ey = hx + r * .25, hy + dy * r * .42
        d.ellipse([ex - r * .2, ey - r * .2, ex + r * .2, ey + r * .2], fill=BG)
    ax, ay = P(790, 330)                                        # apple
    ar = 78 * scale
    d.ellipse([ax - ar, ay - ar * .9, ax + ar, ay + ar * 1.05], fill=APPLE)
    d.ellipse([ax + ar * .05, ay - ar * 1.55, ax + ar * .75, ay - ar * .95], fill=LEAF)
    return im

def save(im, name, px, folder):
    os.makedirs(os.path.join(RES, folder), exist_ok=True)
    im.resize((px, px), Image.LANCZOS).save(os.path.join(RES, folder, name))

dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
legacy = art(1.0, True)
fg = art(0.62, False)                                           # adaptive foreground: art stays in the 66% safe zone
mask = Image.new('L', (S, S), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, S, S], radius=int(S * .22), fill=255)
circ = Image.new('L', (S, S), 0); ImageDraw.Draw(circ).ellipse([0, 0, S, S], fill=255)
for k, m in dens.items():
    f = 'mipmap-' + k
    save(Image.composite(legacy, Image.new('RGBA', (S, S), (0, 0, 0, 0)), mask), 'ic_launcher.png', int(48 * m), f)
    save(Image.composite(legacy, Image.new('RGBA', (S, S), (0, 0, 0, 0)), circ), 'ic_launcher_round.png', int(48 * m), f)
    save(fg, 'ic_launcher_foreground.png', int(108 * m), f)
# store listing icon (512x512, Play Console wants a PNG without rounded corners)
legacy.convert('RGB').resize((512, 512), Image.LANCZOS).save(os.path.join(os.path.dirname(__file__), '..', 'assets', 'play-store-icon-512.png'))
print('icons written')
