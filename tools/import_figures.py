#!/usr/bin/env python3
"""Import real analysis figures from the project repos into the site's assets.

These are actual outputs of the work, not illustrations: reconstructed tracks
from the anchor/AXY+ pipeline and the relay SNR comparison. Written to
assets/panels/ as AVIF, rebuilt from raw pixels because Pillow otherwise embeds
an ICC profile Chrome refuses to decode, and capped at 1100px because above that
it tiles the AVIF into a grid Chrome also rejects.

Usage: python3 tools/import_figures.py
"""

import os
from pathlib import Path

from PIL import Image

V2 = Path(__file__).resolve().parent.parent

# These figures are outputs of the analysis repos, which live outside this one.
# Point PROJECTS_ROOT at wherever they are checked out.
PROJECTS = Path(os.environ.get('PROJECTS_ROOT', '/Volumes/External Dive 2TB/projects'))
OUT = V2 / 'assets' / 'panels'
MAXW = 1100

# name -> source figure
JOBS = {
    'anchor-track-map': PROJECTS / 'telemetry/AXY+/figures/elkhorn_BR_260318_map_bathy.png',
    'anchor-track-diagnostics': PROJECTS / 'telemetry/AXY+/figures/elkhorn_BR_260318_track.png',
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, src in JOBS.items():
        if not src.exists():
            print(f'!! missing source: {src}')
            continue
        im = Image.open(src).convert('RGB')
        if im.width > MAXW:
            h = round(im.height * MAXW / im.width)
            im = im.resize((MAXW, h - h % 2), Image.LANCZOS)
        clean = Image.frombytes('RGB', im.size, im.tobytes())
        out = OUT / f'{name}.avif'
        clean.save(out, format='AVIF', quality=62, speed=4)
        print(f'{out.name:30} {clean.size} -> {out.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
