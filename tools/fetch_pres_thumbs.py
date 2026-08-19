#!/usr/bin/env python3
"""Build the slide thumbnails standing in front of the presentation embeds.

Every presentation in the Research panels is a Google Slides deck or a PDF in
Drive. Both expose a first-page render without an API key, so this pulls one
per talk and lands it in assets/pres/ as a uniform 16:9 AVIF.

Decks are 16:9 and posters are 4:3, so a poster dropped straight into the card
grid would either letterbox against dead space or lose a quarter of itself to a
crop. Instead each render is centred at its own aspect over a blurred, darkened
copy of itself. Every output is then exactly 16:9, the cards line up, and no
poster gets cut.

Sources are named by the panel they belong to, so the filenames stay stable as
long as the order in build_panels.PANELS does.

Usage: python3 tools/fetch_pres_thumbs.py [--refresh]
"""

import re
import sys
import urllib.request
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_panels import PANELS  # noqa: E402

V2 = Path(__file__).resolve().parent.parent
OUT = V2 / 'assets' / 'pres'

W, H = 1280, 720
INSET = 0.90          # share of the canvas the render itself occupies
BLUR = 26
BG_BRIGHTNESS = 0.40
BG_SATURATION = 0.72
QUALITY = 58

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/123.0 Safari/537.36')

SLIDES = re.compile(r'docs\.google\.com/presentation/d/([\w-]+)')
DRIVE = re.compile(r'drive\.google\.com/file/d/([\w-]+)')


def source_url(embed):
    """First-slide render for a deck, first-page render for a Drive PDF."""
    m = SLIDES.search(embed)
    if m:
        return f'https://docs.google.com/presentation/d/{m.group(1)}/export/png'
    m = DRIVE.search(embed)
    if m:
        # Drive caps this at 1024 on the long edge whatever you ask for
        return f'https://drive.google.com/thumbnail?id={m.group(1)}&sz=w1600'
    raise ValueError(f'unrecognised embed: {embed}')


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=45) as r:
        data = r.read()
    im = Image.open(BytesIO(data))
    im.load()
    return im.convert('RGB')


def stage(src):
    """Centre the render on a 16:9 canvas over a blurred copy of itself."""
    bg = ImageOps.fit(src, (W, H), Image.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(BLUR))
    bg = ImageEnhance.Color(bg).enhance(BG_SATURATION)
    bg = ImageEnhance.Brightness(bg).enhance(BG_BRIGHTNESS)

    fg = ImageOps.contain(src, (round(W * INSET), round(H * INSET)), Image.LANCZOS)
    x = (W - fg.width) // 2
    y = (H - fg.height) // 2

    # Drop the render onto the backdrop rather than butting it against it, or
    # a slide with a pale background dissolves into its own blur
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rectangle(
        [x - 3, y - 3, x + fg.width + 3, y + fg.height + 10], fill=(0, 0, 0, 165))
    canvas = Image.alpha_composite(
        bg.convert('RGBA'), shadow.filter(ImageFilter.GaussianBlur(15))).convert('RGB')

    canvas.paste(fg, (x, y))
    ImageDraw.Draw(canvas).rectangle(
        [x, y, x + fg.width - 1, y + fg.height - 1], outline=(150, 196, 214), width=1)
    return canvas


def jobs():
    for p in PANELS:
        for i, pres in enumerate(p.get('presentations') or [], start=1):
            yield f'{p["key"]}-{i}', pres[0] or pres[3], pres[2]


def main():
    refresh = '--refresh' in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)

    for name, title, embed in jobs():
        dest = OUT / f'{name}.avif'
        if dest.exists() and not refresh:
            print(f'  skip  {dest.name}  (--refresh to rebuild)')
            continue
        src = fetch(source_url(embed))
        stage(src).save(dest, format='AVIF', quality=QUALITY)
        print(f'  {dest.name:<18} {src.width}x{src.height} -> {W}x{H}  '
              f'{dest.stat().st_size / 1024:6.1f} KB   {title[:52]}')


if __name__ == '__main__':
    main()
