#!/usr/bin/env python3
"""Regroup the Research bubbles by who the work was done with.

Every bubble carried its lab in a kicker line, which meant the FathomNet bubble
said Bioinspiration Lab twice. The affiliation now belongs to the pod, so the
bubble only has to carry the name of the project.
"""

import re
from pathlib import Path

V2 = Path(__file__).resolve().parent.parent
idx = V2 / 'index.html'
s = idx.read_text()

start = s.index('            <div class="bubble-field">')
end = s.index('</div>', s.rindex('</section>', start, s.index('<!-- Expanded bubble', start))) + len('</div>')

# name, imagealt-safe short label, bob delay/duration
BUBBLES = {
    'shark':       ('White Shark Ecology', '-0.4s', '7.1s'),
    'anchor':      ('anchor: Biologging', '-5.1s', '7.8s'),
    'relay':       ('Relay Training', '-0.9s', '6.6s'),
    'fathomnet':   ('FathomNet', '-2.6s', '6.3s'),
    'aquaculture': ('Urchin Aquaculture', '-1.5s', '6.8s'),
    'jue':         ('Microbial Bioremediation', '-3.8s', '7.4s'),
    'southafrica': ('South Africa', '-4.4s', '7.0s'),
    'fieldops':    ('Scientific Diving', '-2.0s', '7.6s'),
    'porpoise':    ('Individual Re-ID', '-3.1s', '6.9s'),
}

PODS = [
    ('Jorgensen Lab', 'Ocean Predator Ecology, CSUMB', ['shark', 'anchor', 'relay']),
    ('Bioinspiration Lab', 'MBARI', ['fathomnet']),
    ('Gardner Lab', 'Moss Landing Marine Laboratories', ['aquaculture']),
    ('Jue Lab', 'CSUMB', ['jue']),
    ('Cross-species', 'One method, several animals', ['porpoise']),
    ('Field work', 'On the water, and under it', ['southafrica', 'fieldops']),
]

out = ['            <div class="bubble-field">']

for name, where, keys in PODS:
    out.append(f'                <section class="pod" style="--members: {len(keys)}">')
    out.append('                    <header class="pod-head">')
    out.append(f'                        <h3 class="pod-name">{name}</h3>')
    out.append(f'                        <p class="pod-where">{where}</p>')
    out.append('                    </header>')
    out.append('                    <ul class="pod-bubbles">')
    for key in keys:
        label, delay, dur = BUBBLES[key]
        out.append(f'                        <li class="bubble-cell" style="--bob-delay: {delay}; --bob-dur: {dur}">')
        out.append(f'                            <button type="button" class="research-bubble" data-panel="{key}" aria-expanded="false" aria-haspopup="dialog">')
        out.append(f'                                <img class="bubble-photo" src="assets/bubbles/{key}.avif" alt="" width="440" height="440" loading="lazy" decoding="async">')
        out.append('                                <span class="bubble-gloss" aria-hidden="true"></span>')
        out.append(f'                                <span class="bubble-name">{label}</span>')
        out.append('                            </button>')
        out.append('                        </li>')
    out.append('                    </ul>')
    out.append('                </section>')

out.append('            </div>')

idx.write_text(s[:start] + '\n'.join(out) + s[end:])
print(f'{len(PODS)} pods, {sum(len(p[2]) for p in PODS)} bubbles, kickers removed')
