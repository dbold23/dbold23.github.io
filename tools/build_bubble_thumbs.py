#!/usr/bin/env python3
"""Generate the square AVIF thumbnails used inside the Research path bubbles.

Bubbles are circular and render at roughly 200-230 CSS px, so 440x440 covers
2x displays. Sources are the existing full-size assets; output lands in
assets/bubbles/ so the originals stay untouched.

Usage: python3 tools/build_bubble_thumbs.py [name ...]
With no arguments every thumbnail is rebuilt; naming one or more
bubbles rebuilds only those.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OUT = ASSETS / "bubbles"
SIZE = 440

# name -> (source, focus, zoom)
# focus is the normalised centre of the square crop: 0.5 = middle,
# lower y = higher up the frame. zoom < 1 crops tighter on the subject.
JOBS = {
    "shark": ("title background of Summer symposium talk about ml for dorsal mounted cameras on sharks.avif", (0.5, 0.5), 0.78),
    "aquaculture": ("bunch of purple urchins.avif", (0.5, 0.5), 1.0),
    "southafrica": ("On a boat in SA.avif", (0.5, 0.5), 1.0),
    "fieldops": ("Picture of my in south africa with dive gear and a funny construction hat on.JPEG", (0.5, 0.4), 0.9),
    "relay": ("me with a shark tag and antena.avif", (0.5, 0.42), 0.92),
}

# The biologging bubble comes from a frame of the keypoint video rather than a
# still, so it is handled separately.
VIDEO_JOB = ("anchor", "shark-yolo-keypoints.mp4", 40, (0.5, 0.52), 0.82)

# The FathomNet bubble is an explicit crop of the MBARI talk photo rather than a
# centred one: the box is chosen so the face clears the circle at the top and the
# MBARI podium logo stays readable under the bubble's label scrim.
BOX_JOBS = {
    "fathomnet": (Path.home() / "Desktop" / "IMG_7409.JPG", (640, 95, 1120, 575)),
    # The lab logo sits off centre in its own file, with black padding around it.
    # Crop to the artwork itself so it lands centred in the circle.
    "jue": (ASSETS / "jue-lab-logo.avif", (28, 23, 477, 472)),
    # The re-ID bubble used to be a zoom into the match figure — two 131x45 fin
    # crops blown up to 440, which read as an abstract dark wedge rather than an
    # animal. This is a catalogue frame instead: a harbour porpoise broadside,
    # dorsal fin clear of the water, which is the feature the matcher keys on.
    # Square crop is height-limited (2474x1252), taken right of centre so the fin
    # sits inside the circle and the label scrim lands on water, not on the back.
    "porpoise": (
        Path("/Volumes/External Dive 2TB/projects/marine-cv/porpoise-id/data"
             "/raw_images/Pirate/2021/060121D_Pirate ID_L_Burrows_2711CE.JPG"),
        (513, 0, 1765, 1252),
    ),
}


def square(im, focus, zoom=1.0):
    """Centre-weighted square crop, letterbox bars trimmed first."""
    im = im.convert("RGB")
    side = round(min(im.size) * zoom)
    fx, fy = focus
    left = round((im.width - side) * fx)
    top = round((im.height - side) * fy)
    left = max(0, min(left, im.width - side))
    top = max(0, min(top, im.height - side))
    return im.crop((left, top, left + side, top + side)).resize(
        (SIZE, SIZE), Image.LANCZOS
    )


def trim_letterbox(im, threshold=18):
    """Drop uniformly dark bars from the top and bottom of a video frame."""
    g = im.convert("L")
    w, h = g.size
    top, bottom = 0, h - 1
    while top < bottom and max(g.crop((0, top, w, top + 1)).get_flattened_data()) < threshold:
        top += 1
    while bottom > top and max(g.crop((0, bottom, w, bottom + 1)).get_flattened_data()) < threshold:
        bottom -= 1
    return im.crop((0, top, w, bottom + 1))


def save(im, name):
    path = OUT / f"{name}.avif"
    im.save(path, format="AVIF", quality=62, speed=4)
    return path


def main():
    OUT.mkdir(exist_ok=True)
    written = []

    # Named on the command line rebuilds just those. Some sources live outside
    # the repo, so rebuilding one bubble should not require every other one's
    # source to still be sitting where it was.
    only = set(sys.argv[1:])
    wanted = (lambda n: not only or n in only)

    for name, (src, focus, zoom) in JOBS.items():
        if not wanted(name):
            continue
        written.append(save(square(Image.open(ASSETS / src), focus, zoom), name))

    for name, (src, box) in BOX_JOBS.items():
        if not wanted(name):
            continue
        im = Image.open(src).convert("RGB")
        written.append(save(im.crop(box).resize((SIZE, SIZE), Image.LANCZOS), name))

    name, video, frame, focus, zoom = VIDEO_JOB
    if not wanted(name):
        for p in sorted(written):
            print(f"{p.relative_to(ROOT)}: {p.stat().st_size:,} bytes")
        return
    with tempfile.TemporaryDirectory() as tmp:
        still = Path(tmp) / "frame.png"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(ASSETS / video),
             "-vf", f"select=eq(n\\,{frame})", "-vframes", "1", "-y", str(still)],
            check=True,
        )
        written.append(save(square(trim_letterbox(Image.open(still)), focus, zoom), name))

    for p in sorted(written):
        print(f"{p.relative_to(ROOT)}: {p.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
