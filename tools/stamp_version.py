#!/usr/bin/env python3
"""Set the cache-busting token everywhere it is written down.

index.html stamps every stylesheet and script it loads with ?v=<token>, so a
returning visitor cannot pair new CSS with a cached script. The token also has
to appear inside the JS, because a module that imports another module carries
its own copy of it in the specifier.

Those copies drift. They had: index.html was on 20260819f while app.js was
still importing every transition module at ?v=20260819b and transition-forest.js
was pulling forest-map.js at ?v=20260816u — so changes to those files were
simply not being served to anyone who had visited before.

Dynamic imports no longer need this: app.js and transition-ocean.js read the
token off their own import.meta.url, which cannot go stale. A STATIC import
specifier has to be a literal, so those are what this rewrites.

This script rewrites files; it does not stage them. Forgetting to commit one of
them puts a stale token live, which is the very failure it exists to prevent —
it happened once already, leaving transition-forest.js importing forest-map.js
at the previous token while forest-map.js itself had changed. Run --check before
pushing; it exits non-zero if the tokens disagree.

Usage:  python3 tools/stamp_version.py            # today, plus a letter
        python3 tools/stamp_version.py 20260819h  # an exact token
        python3 tools/stamp_version.py --check    # verify, change nothing
"""

import re
import sys
from datetime import date
from pathlib import Path

V2 = Path(__file__).resolve().parent.parent
TOKEN = re.compile(r'\?v=[0-9a-z]+')

# index.html holds the token of record; the JS files carry it in static import
# specifiers, which cannot be computed.
TARGETS = ['index.html'] + [str(p.relative_to(V2)) for p in sorted((V2 / 'js').glob('*.js'))]


def next_token():
    """Today's date plus the first letter, e.g. 20260819a."""
    return date.today().strftime('%Y%m%d') + 'a'


def check():
    """Every token in the tree must agree. Exits non-zero if not."""
    found = {}
    for rel in TARGETS:
        f = V2 / rel
        if not f.exists():
            continue
        for m in TOKEN.finditer(f.read_text()):
            found.setdefault(m.group(0), []).append(rel)

    if not found:
        print('no tokens found')
        return 1
    if len(found) == 1:
        token = next(iter(found))
        print(f'ok: everything on {token}')
        return 0

    print('MISMATCH — these would ship stale:')
    for tok, files in sorted(found.items(), key=lambda kv: -len(kv[1])):
        print(f'  {tok:18} {sorted(set(files))}')
    return 1


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--check':
        sys.exit(check())

    token = sys.argv[1] if len(sys.argv) > 1 else next_token()
    if not re.fullmatch(r'[0-9a-z]+', token):
        sys.exit(f'not a usable token: {token}')

    total = 0
    for rel in TARGETS:
        f = V2 / rel
        if not f.exists():
            continue
        s = f.read_text()
        new, n = TOKEN.subn(f'?v={token}', s)
        if n:
            f.write_text(new)
            total += n
            print(f'{rel:28} {n} stamped')
    print(f'-> ?v={token}, {total} in total')


if __name__ == '__main__':
    main()
