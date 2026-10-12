"""Subset the self-hosted fonts to the characters the built pages use. Run with the project venv after build.py has written dist/."""
import glob
import os

from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
SRC = os.path.join(ROOT, 'brand/fonts')

text = ''.join(open(f, encoding='utf-8').read() for f in glob.glob(os.path.join(DIST, '**/*.html'), recursive=True))
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
for src, out, keep in FONTS:
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
