---
name: update-data
description: Refresh 新弾ナビ's release data from カードラボ and トレカの地図, review the change report, fix gaps (new title labels, missing images, cancelled items) and publish by pushing to main. Use when the owner says 更新新弾ナビ / 更新数据 / update the data / refresh the calendar, or asks whether new releases are on the site.
---

# Update the release data

Publishing happens on push to `main`, so the owner reviews the data before it is pushed. Never push a data update they have not seen.

## 1. Dry run

```bash
.venv/bin/python -I scripts/update_data.py --dry-run
```

It prints `data/update-report.md`. If it aborts ("empty source" / "only N releases scraped"), a source page probably changed layout — open it in the browser pane, compare with the regexes in `parse_clabo` / `parse_torecamap`, fix the parser, rerun. Do not lower `MIN_RATIO` to get past it.

## 2. Read the report and fix what it asks for

| Section | What to do |
|---|---|
| 未対応のタイトル名 | A source used a title label `GAME` doesn't know. Add it to `GAME` in `scripts/update_data.py`, mapped to the existing display name (check `data/items.json` for spelling), so one title doesn't split into two chips. |
| 新規 | Sanity-check names and dates. |
| 発売日の変更 / 価格の変更 | Usually real (延期, price announced). If a match looks wrong (two different products merged), pin the right values with `date` / `name` in `data/overrides.json`. |
| ソースから消えた今後の商品 | Check the official site. If cancelled, add `"hide": true` for that id in `data/overrides.json`; if still on sale, leave it. |
| 画像なし | Try to find package images — follow `.claude/skills/find-product-image/`. Items pinned with `thumb: ""` in overrides are waiting for an official image; recheck them. |

## 3. Write, build, look

```bash
.venv/bin/python -I scripts/update_data.py
python3 -I scripts/build.py
git diff --stat && git diff data/meta.json
```

Serve `dist/` and spot-check the current month on desktop and mobile widths (new cards render, no broken images, counts look right). If the set of main-title pages or their lead images changed a lot, rerun `python3 -I scripts/og.py`.

## 4. Show the owner, then publish

Summarise the report for the owner in Chinese (counts per section, notable new releases, anything you hid or overrode) and wait for an OK. Then:

```bash
git add data public/thumbs public/og scripts
git commit -m "Data update YYYY-MM-DD"
git push
```

Watch the Deploy run (`gh run watch`), wait ~15 s, then check `https://shindan-navi.app/` shows the new 更新日 and `/sitemap.xml` has the new lastmod.

## Notes

- Items released more than 30 days ago are dropped automatically (and leave the sitemap).
- `update_data.py` deletes thumbnails no item references any more; images set through overrides stay referenced.
- After a big update, Search Console → Sitemaps → resubmit is optional; Google rereads the sitemap on its own.
