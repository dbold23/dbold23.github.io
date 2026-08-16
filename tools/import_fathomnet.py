#!/usr/bin/env python3
"""Import the MBARI talk photo into the site's panel assets."""

import glob
import os
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'panels'
DESK = os.path.expanduser('~/Desktop')

# name -> (desktop glob, trim uniform dark border?, crop fraction off the left)
JOBS = {
    # Final internship talk: weight the frame toward the speaker and the screen
    'mbari-presentation': ('IMG_7409.JPG', False, 0.10),
    # The output of the mask work, used as the results figure in the panel
    'fathomnet-masks': ('Screenshot 2026-08-04 at 1.38.12*PM.png', True, 0.0),
}

for name, (pattern, trim, crop_left) in JOBS.items():
    matches = glob.glob(os.path.join(DESK, pattern))
    assert len(matches) == 1, (pattern, matches)
    im = Image.open(matches[0]).convert('RGB')

    if trim:
        bbox = im.convert('L').point(lambda p: 255 if p > 24 else 0).getbbox()
        if bbox:
            im = im.crop(bbox)
    if crop_left:
        im = im.crop((round(im.width * crop_left), 0, im.width, im.height))

    w = 1100
    h = round(im.height * w / im.width)
    h -= h % 2                     # even dimensions keep 4:2:0 decoders happy
    im = im.resize((w, h), Image.LANCZOS)

    # Rebuild from raw pixels so no ICC/EXIF rides along into the container
    clean = Image.frombytes('RGB', im.size, im.tobytes())
    out = OUT / f'{name}.avif'
    clean.save(out, format='AVIF', quality=60, speed=4)
    print(f'{out.name:26} {clean.size} -> {out.stat().st_size // 1024} KB')
