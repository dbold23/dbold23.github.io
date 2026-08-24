# Species icons

One PNG per species, named after its key in `server/species.py` with
underscores as hyphens (`sea_otter` -> `sea-otter.png`).

**The artwork lives in the alpha channel.** The dashboard renders these as a
CSS `mask-image`, so the RGB channels are never read and the line art takes the
page's own text colour - which is what makes one file work in both the light
and dark themes. A greyscale PNG will NOT work: `-webkit-mask-image` masks by
alpha, not luminance, so a fully-opaque image masks as a solid rectangle.

**All icons share a 192x48 canvas** with the animal fitted inside and centred.
Same box for every species is what keeps the frequency column aligned when one
row is an otter and the next is a shark.

To add one, from the original line-art PNG (transparent background, artwork
opaque):

```bash
python3 -c "
from PIL import Image
im = Image.open('SOURCE.png').convert('RGBA')
im = im.crop(im.getchannel('A').getbbox())
s = min(192/im.width, 48/im.height)
im = im.resize((round(im.width*s), round(im.height*s)), Image.LANCZOS)
c = Image.new('RGBA', (192, 48), (0,0,0,0))
c.paste(im, ((192-im.width)//2, (48-im.height)//2), im)
f = Image.new('RGBA', (192, 48), (17,22,26,0)); f.putalpha(c.getchannel('A'))
f.save('NAME.png', optimize=True)
"
```

Then set `icon` for that species in `server/species.py`.

Note `.gitignore` excludes `*.png` globally and re-includes
`server/static/img/**/*.png`. A new subdirectory here is covered; a new image
directory elsewhere is not, and would vanish from the deploy while still
working locally.

Sources: `~/Desktop/Relay station assets/` (`seaotter.png`,
`leopardshark.png`, `elephantseal.png`).
