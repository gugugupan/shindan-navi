"""Set a product image by hand: download (or read) it, save a 280px JPEG in public/thumbs, record it in data/overrides.json.

  .venv/bin/python -I scripts/add_thumb.py <item id> <image url or local path> [--approx] [--note "why"]
  .venv/bin/python -I scripts/add_thumb.py <item id> --placeholder [--note "why"]

--approx marks a stand-in (key visual, other edition); the updater replaces it when a source gets a real image.
--placeholder pins the in-page placeholder so an official "NOW PRINTING"-style image is not picked up.
"""
import hashlib
import io
import json
import os
import sys
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    item_id, rest = args[0], args[1:]
    note = rest[rest.index('--note') + 1] if '--note' in rest else None
    items = {i['id']: i for i in json.load(open(os.path.join(ROOT, 'data/items.json')))}
    if item_id not in items:
        sys.exit(f'unknown item id {item_id}')
    ov_path = os.path.join(ROOT, 'data/overrides.json')
    overrides = json.load(open(ov_path))
    entry = overrides.setdefault(item_id, {'_name': items[item_id]['name']})
    if '--placeholder' in rest:
        entry.update(thumb='', approx=False)
    else:
        src = rest[0]
        if src.startswith('http'):
            req = urllib.request.Request(src, headers={'User-Agent': UA, 'Referer': src.split('/', 3)[0] + '//' + src.split('/')[2] + '/'})
            raw = urllib.request.urlopen(req, timeout=40).read()
        else:
            raw = open(src, 'rb').read()
        im = Image.open(io.BytesIO(raw))
        if im.mode in ('RGBA', 'LA', 'P'):
            im = im.convert('RGBA')
            bg = Image.new('RGB', im.size, 'white')
            bg.paste(im, mask=im.split()[-1])
            im = bg
        im = im.convert('RGB')
        im.thumbnail((280, 280))
        name = hashlib.md5(raw).hexdigest()[:12] + '.jpg'
        im.save(os.path.join(ROOT, 'public/thumbs', name), 'JPEG', quality=78)
        entry.update(thumb='thumbs/' + name, approx='--approx' in rest)
    if note:
        entry['note'] = note
    json.dump(dict(sorted(overrides.items(), key=lambda kv: kv[1].get('_name', ''))), open(ov_path, 'w'), ensure_ascii=False, indent=1)
    print(item_id, '→', entry)


if __name__ == '__main__':
    main()
