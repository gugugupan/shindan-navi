---
name: find-product-image
description: Find and set the package image for a 新弾ナビ release that shows the 画像準備中 placeholder or a 参考画像 stand-in. Use when the update report lists 画像なし items, when the owner sends an official product/news link with an image, or asks to replace a placeholder or stand-in thumbnail.
---

# Find a product image

Goal: the real package (pack / box / deck) image of that exact product, from an official or shop page. A wrong image is worse than the placeholder.

## Where to look, in order

1. **The item's own `url`** in `data/items.json` — usually the official product page; check `og:image` and the main product image.
2. **The title's official site** (`OFFICIAL` in `scripts/build.py`), its products and news pages. Announcements often carry the package art before the product page does.
3. **トレカの地図** (`https://torecamap.co.jp/release-schedule?year=YYYY&month=M`) — the updater already pulls these, so only useful if a run was missed.
4. **カードラボ online shop** (`https://www.c-labo-online.jp/product/<n>`), 駿河屋, Amazon.co.jp product pages.

Site notes:
- **yu-gi-oh.jp** blocks curl for HTML. Open the article in the browser pane, read image URLs with `javascript_tool` (scroll to the bottom first so lazy images load; `/media/cms/v1/<base64>` URLs decode to the original filename such as `pack_KP27.jpg`). The image URLs themselves download fine with curl.
- **fanstars-league.com / battlespirits.com** product pages put the package at `img_item.webp`-style paths; early on these are generic placeholders.

## Reject these

- "NOW PRINTING", "NOW DESIGNING", "画像準備中" and similar placeholders — pin the placeholder instead (below).
- Series logos, single cards, store banners, images of a different product (other color deck, other edition, other volume).
- If only a key visual for the set exists, it is acceptable as a stand-in **with `--approx`**.

Open the downloaded file and look at it before using it.

## Set it

```bash
.venv/bin/python -I scripts/add_thumb.py <item id> <image url or local file> [--approx] --note "where it came from"
# official image is still a placeholder: keep ours and stop the updater from picking theirs up
.venv/bin/python -I scripts/add_thumb.py <item id> --placeholder --note "official image is NOW DESIGNING as of YYYY-MM-DD"
```

This writes a 280px JPEG to `public/thumbs/` and the `thumb` / `approx` entry to `data/overrides.json`. If the image page is also a better official link than the current one, set `url` for that id in `overrides.json` too.

Then `python3 -I scripts/build.py`, check the card and the detail dialog in the preview, and commit `data/overrides.json` + the new thumbnail. An item with a thumbnail and a price goes back into the Product JSON-LD automatically.
