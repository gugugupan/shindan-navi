"""Render 1200x630 OGP images into public/og/ with headless Chrome. Run after build.py (needs scripts/.pages.json)."""
import html
import re
import json
import os
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get('CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
SHORT = {'pokemon': 'ポケカ', 'onepiece': 'ワンピカード', 'mtg': 'MTG', 'yugioh': '遊戯王', 'duelmasters': 'デュエマ',
         'weiss': 'ヴァイス', 'unionarena': 'ユニアリ', 'gundam': 'ガンダムカード', 'dragonball': 'フュージョンワールド',
         'digimon': 'デジカ'}

pages = json.load(open(os.path.join(ROOT, 'scripts/.pages.json')))
items = json.load(open(os.path.join(ROOT, 'data/items.json')))
lockup = open(os.path.join(ROOT, 'brand/shindan-navi-lockup-light.svg')).read()
lockup = lockup.replace(' width="1154" height="336"', '')
font = 'file://' + os.path.join(ROOT, 'brand/fonts/DelaGothicOne-Regular.ttf')
out_dir = os.path.join(ROOT, 'public/og')
os.makedirs(out_dir, exist_ok=True)


def thumbs_for(game):
    pool = [i for i in items if i.get('thumb') and not i.get('approx') and (game is None or i['game'] == game)]
    pool.sort(key=lambda i: i['date'])
    if game is None:
        picked, seen = [], set()
        for i in pool:
            if i['date'] >= '2026-10-16' and i['game'] not in seen:
                picked.append(i); seen.add(i['game'])
            if len(picked) == 3:
                break
        pool = picked
    else:
        uniq, seen = [], set()
        for i in pool:
            if i['thumb'] not in seen:
                uniq.append(i); seen.add(i['thumb'])
        pool = uniq
    return ['file://' + os.path.join(ROOT, 'public', i['thumb']) for i in pool[:3]]


def card_html(og, big, sub, thumbs):
    def line(t):
        plain = len(t.replace('<em>', '').replace('</em>', ''))
        return f'<span style="font-size:{min(84, 548 // plain)}px">{t}</span>'
    big = ''.join(line(t) for t in big.split('\n'))
    sub_size = 26 if len(sub) <= 22 else 21
    cards = ''.join(f'<img src="{t}" style="--r:{r}deg;--x:{x}px;--y:{y}px;z-index:{z}">'
                    for t, (r, x, y, z) in zip(thumbs, [(-12, -120, 30, 1), (10, 120, 30, 2), (0, 0, -10, 3)][:len(thumbs)]))
    return f"""<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@500;700&family=JetBrains+Mono:wght@700&display=swap">
<style>
@font-face{{font-family:Dela;src:url("{font}")}}
*{{box-sizing:border-box}}
html,body{{margin:0;width:1200px;height:630px;overflow:hidden}}
body{{background:#eceef4;font-family:"Zen Kaku Gothic New",sans-serif;color:#161a2b;display:grid;grid-template-columns:640px 560px}}
.l{{padding:56px 0 48px 64px;display:flex;flex-direction:column}}
.logo svg{{height:72px;width:auto;display:block}}
h1{{font-family:Dela,sans-serif;font-weight:400;line-height:1.15;margin:auto 0 18px;letter-spacing:.01em}}
h1 span{{display:block;white-space:nowrap}}
h1 em{{font-style:normal;color:#3a43d0}}
.sub{{font-size:{sub_size}px;font-weight:700;color:#4b5068;margin:0 0 auto;padding-right:24px}}
.url{{font-family:"JetBrains Mono",monospace;font-size:24px;color:#3a43d0;display:flex;align-items:center;gap:12px}}
.url::before{{content:"";width:14px;height:14px;border-radius:50%;background:#e7a90e}}
.r{{position:relative;background:linear-gradient(150deg,#4a53e0,#2a31a8);margin:28px 28px 28px 0;border-radius:36px;overflow:hidden}}
.r::before{{content:"";position:absolute;inset:0;background:repeating-linear-gradient(135deg,rgba(255,255,255,.06) 0 2px,transparent 2px 22px)}}
.fan{{position:absolute;left:50%;top:50%}}
.fan img{{position:absolute;width:210px;aspect-ratio:3/4;object-fit:cover;border-radius:14px;border:6px solid #fff;box-shadow:0 18px 40px rgba(0,0,0,.35);
  transform:translate(calc(-50% + var(--x)),calc(-50% + var(--y))) rotate(var(--r))}}
.star{{position:absolute;right:34px;top:30px;width:92px;height:92px}}
</style></head><body>
<div class="l"><div class="logo">{lockup}</div><h1>{big}</h1><p class="sub">{html.escape(sub)}</p><div class="url">shindan-navi.app</div></div>
<div class="r"><div class="fan">{cards}</div>
<svg class="star" viewBox="0 0 64 64"><path d="M32 4L37.6 26.4 60 32 37.6 37.6 32 60 26.4 37.6 4 32 26.4 26.4z" fill="#ffd45c"/><path d="M32 4L37.6 26.4 32 32z M60 32L37.6 37.6 32 32z M32 60L26.4 37.6 32 32z M4 32L26.4 26.4 32 32z" fill="#e7a90e"/></svg></div>
</body></html>"""


def render(name, doc):
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, dir=out_dir) as f:
        f.write(doc)
        tmp = f.name
    out = os.path.join(out_dir, f'{name}.png')
    try:
        subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                        '--window-size=1200,630', '--virtual-time-budget=6000', '--allow-file-access-from-files',
                        f'--screenshot={out}', 'file://' + tmp], check=True, capture_output=True, timeout=90)
    finally:
        os.remove(tmp)
    print('og', name, os.path.getsize(out) // 1024, 'KB')


done = set()
for p in pages:
    name = p['og']
    if name in done:
        continue
    done.add(name)
    if name == 'home':
        big, sub, game = 'トレカ<em>新弾</em>\n発売日カレンダー', 'ポケカ・ワンピ・MTG・遊戯王・ヴァイスほか', None
    else:
        game = p['js']['game']
        full = re.sub(r'(（[^）]*）)?\s*新弾 発売日カレンダー$', '', p['h1'])
        big, sub = f'<em>{html.escape(SHORT[name])}</em>\n新弾 発売日カレンダー', full
    render(name, card_html(name, big, sub, thumbs_for(game)))
