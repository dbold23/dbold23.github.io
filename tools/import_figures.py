#!/usr/bin/env python3
"""Import real analysis figures from the project repos into the site's assets.

These are actual outputs of the work, not illustrations: reconstructed tracks
from the anchor/AXY+ pipeline and the relay SNR comparison. Written to
assets/panels/ as AVIF, rebuilt from raw pixels because Pillow otherwise embeds
an ICC profile Chrome refuses to decode, and capped at 1100px because above that
it tiles the AVIF into a grid Chrome also rejects.

Also carries two other kinds of import:

  CLIPS   the particle-filter animation, cropped to its map panel and encoded
          as webm + mp4. The source render is a four-panel diagnostic dashboard
          at 1600x1000; three of those panels are time-series charts that are
          illegible at web size, so only the map is kept.
  PHOTOS  a catalogue frame used as a figure rather than as evidence.

Usage: python3 tools/import_figures.py
"""

import os
import subprocess
from pathlib import Path

from PIL import Image

V2 = Path(__file__).resolve().parent.parent

# These figures are outputs of the analysis repos, which live outside this one.
# Point PROJECTS_ROOT at wherever they are checked out.
PROJECTS = Path(os.environ.get('PROJECTS_ROOT', '/Volumes/External Dive 2TB/projects'))
ASSETS = V2 / 'assets'
OUT = ASSETS / 'panels'
MAXW = 1100

# name -> source figure
JOBS = {
    'anchor-track-map': PROJECTS / 'telemetry/AXY+/figures/elkhorn_BR_260318_map_bathy.png',
    'anchor-track-diagnostics': PROJECTS / 'telemetry/AXY+/figures/elkhorn_BR_260318_track.png',
    # The Jue panel's result on REAL plates. The two figures it carried before
    # both came out of synthetic_data/output/, which is the right provenance for
    # the classifier validation and the wrong one for the biology.
    'tecan-degradation-ranking': (
        PROJECTS / 'lab/tecan-growth-curves/TECAN_growth_curves/paper/figures'
                   '/fig_degradation_capacity_ranking.png'),
}

# name -> (source photograph, crop box or None)
PHOTOS = {
    # A harbour porpoise surfacing, from the photo-ID catalogue the matcher is
    # trained on: the whole animal from the fin down to the blowhole, which is
    # more than the fin crops in this catalogue usually show. Native 1.85:1, so
    # it takes no crop. Corner checked at full resolution — some frames in this
    # catalogue carry a "(c) Ciera Edison / Pacific Mammal Research" watermark
    # bottom right, and this one does not.
    'porpoise-animal': (
        PROJECTS / 'marine-cv/porpoise-id/data/raw_images/Pointer/2021'
                   '/061521C_Pointer ID_R_Burrows_3192CE.JPG',
        None,
    ),
    # The resighting: the same individual, same flank, four years later, in
    # different water. That pairing is the whole argument of the panel, so it
    # has to be two real encounters and not one photograph shown twice.
    'porpoise-resight': (
        PROJECTS / 'marine-cv/porpoise-id/data/raw_images/Pointer/2025'
                   '/040425A_Pointer ID_R_Burrows_6711CE.JPG',
        None,
    ),
}

# name -> (source render, crop filter)
#
# BR_260318_S3 is the same deployment as the static anchor-track-map figure
# above, so this is that figure moving. Note the suptitle in animate_filter.py
# is hard-coded to this deployment whatever data it is given, which is why the
# crop drops it: it cannot be trusted to name the animal in the frame.
CLIPS = {
    'anchor-track-filter': (
        PROJECTS / 'telemetry/AXY+/figures/bat_ray_particle_animation.mp4',
        # x=172..756, y=104..936 of the 1600x1000 render: the map axes, its tick
        # labels and the legend, and nothing else. Bounds measured by scanning
        # the frame for ink rather than eyeballed; there is a 49px empty gutter
        # at x=748..803 before the neighbouring chart's axis label, so the right
        # edge is safe. The running status line above the map is dropped: it is
        # 1255px wide and would either drag in the chart beside it or be cut off
        # mid-sentence. The caption carries what it said.
        'crop=584:832:172:104',
    ),
}


def encode_clip(name, src, crop):
    """Crop one panel out of a dashboard render and ship webm + mp4.

    The rates are set high for a plot because the expensive content is the
    particle cloud, which is dither: at CRF 44 the contour lines, the track and
    the axis text are indistinguishable from CRF 36 and the file is a third
    smaller. Checked frame against frame, not assumed.
    """
    common = ['-vf', crop, '-an', '-y', '-v', 'error']
    webm = ASSETS / f'{name}.webm'
    mp4 = ASSETS / f'{name}.mp4'

    subprocess.run(
        ['ffmpeg', '-i', str(src), *common,
         '-c:v', 'libvpx-vp9', '-crf', '44', '-b:v', '0', '-row-mt', '1',
         str(webm)],
        check=True)
    subprocess.run(
        ['ffmpeg', '-i', str(src), *common,
         '-c:v', 'libx264', '-crf', '30', '-pix_fmt', 'yuv420p',
         '-movflags', '+faststart', str(mp4)],
        check=True)

    for out in (webm, mp4):
        print(f'{out.name:30} {out.stat().st_size // 1024} KB')


def save_avif(im, out):
    """Rebuild from raw pixels: Pillow otherwise embeds an ICC profile Chrome
    refuses to decode."""
    if im.width > MAXW:
        h = round(im.height * MAXW / im.width)
        im = im.resize((MAXW, h - h % 2), Image.LANCZOS)
    clean = Image.frombytes('RGB', im.size, im.tobytes())
    clean.save(out, format='AVIF', quality=62, speed=4)
    print(f'{out.name:30} {clean.size} -> {out.stat().st_size // 1024} KB')


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    for name, (src, crop) in PHOTOS.items():
        if not src.exists():
            print(f'!! missing source: {src}')
            continue
        im = Image.open(src).convert('RGB')
        if crop:
            im = im.crop(crop)
        save_avif(im, OUT / f'{name}.avif')

    for name, (src, crop) in CLIPS.items():
        if not src.exists():
            print(f'!! missing source: {src}')
            continue
        encode_clip(name, src, crop)

    for name, src in JOBS.items():
        if not src.exists():
            print(f'!! missing source: {src}')
            continue
        save_avif(Image.open(src).convert('RGB'), OUT / f'{name}.avif')


if __name__ == '__main__':
    main()
