"""Subset the self-hosted fonts to the characters the built pages use. Run with the project venv after build.py has written dist/."""
import glob
import os

from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
SRC = os.path.join(ROOT, 'brand/fonts')

# page, slot for its extra faces, font file prefix. These pages are left out of the shared subsets so they don't grow
# the fonts every other page downloads; each gets its own small faces for the glyphs the shared subsets lack.
OWN = [(os.path.join(DIST, 'events/index.html'), '/*EVENT_FONTS*/', 'events'),
       (os.path.join(DIST, 'privacy/index.html'), '/*PAGE_FONTS*/', 'privacy'),
       (os.path.join(DIST, 'feedback/index.html'), '/*PAGE_FONTS*/', 'feedback'),
       (os.path.join(DIST, 'voices/index.html'), '/*PAGE_FONTS*/', 'voices')]
# the /voices/<date>/ archive pages share the /voices/ faces (same topic text)
SHARE = {'voices': sorted(glob.glob(os.path.join(DIST, 'voices/*/index.html')))}
own_files = [o[0] for o in OWN] + [f for fs in SHARE.values() for f in fs]
text = ''.join(open(f, encoding='utf-8').read() for f in glob.glob(os.path.join(DIST, '**/*.html'), recursive=True) if f not in own_files)
# kana, ASCII and common punctuation are always kept so text that arrives with a data refresh still renders in the same face
always = ''.join(chr(c) for c in range(0x20, 0x7f)) + ''.join(chr(c) for c in range(0x3000, 0x3100)) + \
    ''.join(chr(c) for c in range(0x30a0, 0x3100)) + ''.join(chr(c) for c in range(0xff01, 0xff5f)) + '・〜ー円年月日曜件'
chars = ''.join(sorted(set(text + always)))

FONTS = [('DelaGothicOne-Regular.ttf', 'dela-gothic-one.woff2', chars),
         ('ZenKakuGothicNew-Regular.ttf', 'zen-kaku-400.woff2', chars),
         ('ZenKakuGothicNew-Bold.ttf', 'zen-kaku-700.woff2', chars),
         ('JetBrainsMono[wght].ttf', 'jetbrains-mono.woff2', ''.join(chr(c) for c in range(0x20, 0x7f)) + '¥')]

out_dir = os.path.join(DIST, 'fonts')
os.makedirs(out_dir, exist_ok=True)


def write_subset(src, out, keep):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    font = subset.load_font(os.path.join(SRC, src), opts)
    sub = subset.Subsetter(opts)
    sub.populate(text=keep)
    sub.subset(font)
    subset.save_font(font, os.path.join(out_dir, out), opts)
    print('font', out, os.path.getsize(os.path.join(out_dir, out)) // 1024, 'KB')


for src, out, keep in FONTS:
    write_subset(src, out, keep)

for path, slot, prefix in OWN:
    if not os.path.exists(path):
        continue
    page = open(path, encoding='utf-8').read()
    shared = SHARE.get(prefix, [])
    extra = sorted(c for c in set(page).union(*(open(f, encoding='utf-8').read() for f in shared)) - set(chars) if ord(c) > 0x7f)
    faces = []
    if extra:
        rng = ','.join(f'U+{ord(c):X}' for c in extra)
        for src, out, family, weight in [('DelaGothicOne-Regular.ttf', f'{prefix}-dela-gothic-one.woff2', 'Dela Gothic One', 400),
                                         ('ZenKakuGothicNew-Regular.ttf', f'{prefix}-zen-kaku-400.woff2', 'Zen Kaku Gothic New', 400),
                                         ('ZenKakuGothicNew-Bold.ttf', f'{prefix}-zen-kaku-700.woff2', 'Zen Kaku Gothic New', 700)]:
            write_subset(src, out, ''.join(extra))
            faces.append(f'@font-face{{font-family:"{family}";src:url("/fonts/{out}") format("woff2");font-weight:{weight};font-display:swap;unicode-range:{rng}}}')
    for f in [path] + shared:
        p = page if f == path else open(f, encoding='utf-8').read()
        assert p.count(slot) == 1, f
        open(f, 'w', encoding='utf-8').write(p.replace(slot, ''.join(faces)))
    print(prefix, 'extra glyphs', len(extra))
