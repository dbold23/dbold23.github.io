#!/usr/bin/env python3
"""Cap the panel figures at a sensible pixel budget.

Figures imported straight out of the analysis repos arrive at whatever size
matplotlib or the camera produced. The panel column is about 800 CSS px wide, so
a 3225x3137 plot is delivering thirty-three times the pixels it can show, and
the browser has to hold forty megabytes of RGBA to do it. The cover images are
worse than that again, because the cover carries a blur filter and the compositor
pays for the filter at the source resolution, not the displayed one.

1600px on the long edge is twice the widest box any of them lands in, which is
enough for a 2x display and nothing beyond it.

Idempotent: anything already inside the budget is left alone, so this is safe to
re-run after tools/import_figures.py brings a fresh figure in.

Usage: python3 tools/shrink_figures.py [--budget 1600] [--dry-run]
"""

import argparse
import re
from pathlib import Path

from PIL import Image

V2 = Path(__file__).resolve().parent.parent
BUDGET = 1600


def _encode(im, fmt):
    """Every encoding worth trying, as (bytes, worst channel error) pairs.

    Palette PNG is the right format for a plot — mostly flat colour, a handful
    of series — but the quantiser has to be chosen on fidelity, not on size.
    Median cut spends its palette where the pixels are, which on a plot is the
    white background, and it will happily collapse an orange threshold line onto
    the nearest red. That is not compression, that is editing the figure. Maximum
    coverage spreads the palette across the colour space instead and holds the
    series apart, so the error is checked and anything that shifts a hue is
    thrown away whatever it saves.
    """
    import io

    import numpy as np

    ref = np.asarray(im.convert('RGB'), dtype=np.int16)
    outs = []

    def dump(image, **kw):
        buf = io.BytesIO()
        image.save(buf, **kw)
        raw = buf.getvalue()
        back = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'), dtype=np.int16)
        outs.append((raw, int(np.abs(ref - back).max())))

    if fmt == 'PNG':
        dump(im, format='PNG', optimize=True)
        try:
            # No dithering: resampling already smears the flat fills into
            # gradients, and dithering scatters noise through every one of
            # them, which is exactly what PNG cannot compress
            for method in (Image.MAXCOVERAGE, Image.FASTOCTREE):
                dump(im.quantize(colors=256, method=method,
                                 dither=Image.Dither.NONE),
                     format='PNG', optimize=True)
        except ValueError:
            pass       # quantize refuses some modes; the truecolour PNG stands
    elif fmt in ('JPEG', 'MPO'):
        dump(im.convert('RGB'), format='JPEG', quality=86, optimize=True,
             progressive=True)
    else:
        dump(im, format=fmt, quality=68)

    return outs


def referenced():
    """Every image the Research panels actually use."""
    html = (V2 / 'index.html').read_text()
    panels = html[html.index('<template data-panel='):]
    return sorted(set(re.findall(r'<img[^>]*\ssrc="(assets/[^"]+)"', panels)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--budget', type=int, default=BUDGET)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    saved = 0
    for rel in referenced():
        path = V2 / rel
        if not path.exists():
            continue
        with Image.open(path) as im:
            w, h = im.size
            fmt = im.format
            if max(w, h) <= args.budget:
                continue
            scale = args.budget / max(w, h)
            new = (round(w * scale), round(h * scale))
            before = path.stat().st_size
            if args.dry_run:
                print(f'{rel}: {w}x{h} -> {new[0]}x{new[1]}')
                continue
            # matplotlib writes RGBA whether or not anything is transparent,
            # and carrying a channel of solid 255 through the re-encode costs
            # real bytes
            keep_alpha = (im.mode in ('RGBA', 'LA')
                          and im.getchannel('A').getextrema() != (255, 255))
            resized = im.convert('RGBA' if keep_alpha else 'RGB')
            resized = resized.resize(new, Image.LANCZOS)
            # Keep the format: the filenames are baked into build_panels.py, and
            # a figure that changed extension would need editing in two places
            candidates = _encode(resized, fmt)

        # A channel off by more than this is a colour a reader could name as
        # different, which on a figure with a legend is a wrong figure
        safe = [raw for raw, err in candidates if err <= 24]
        best = min(safe or [candidates[0][0]], key=len)
        if len(best) >= before:
            # Resampling a plot fills its flat regions with antialiased gradient
            # and the re-encode can come out heavier than the original. The
            # pixels are still worth losing, but not at the cost of the bytes.
            print(f'{rel}: {w}x{h} kept — every re-encode came out larger')
            continue

        path.write_bytes(best)
        after = path.stat().st_size
        saved += before - after
        print(f'{rel}: {w}x{h} -> {new[0]}x{new[1]}  '
              f'{before // 1024}KB -> {after // 1024}KB')

    if not args.dry_run:
        print(f'\n{saved // 1024}KB saved. Re-run tools/build_panels.py: the '
              f'width/height attributes in index.html are now stale.')


if __name__ == '__main__':
    main()
