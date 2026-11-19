---
name: update-data
description: Refresh 新弾ナビ's release data (カードラボ, トレカの地図, official sites) with scripts/refresh.py, review the packet, fix gaps (new title labels, missing images, cancelled items) and publish by pushing to main. Use when the owner says 更新新弾ナビ / 更新数据 / update the data / refresh the calendar, or asks whether new releases are on the site.
---

# Update the release data

Publishing happens on push to `main`, so every data update is reviewed before it is pushed. The refresh is run by hand; there is no scheduled refresh (owner decision).

## 1. Run the one command in a worktree

```bash
git -C <repo> fetch origin && git -C <repo> worktree add ../.worktrees/data-YYYY-MM-DD -b data/YYYY-MM-DD origin/main
cd ../.worktrees/data-YYYY-MM-DD   # .venv: link or create one; (cd tools/verify && npm ci) once
python3 -I scripts/refresh.py
```

It pins `TODAY` (env, else today in Asia/Tokyo) and runs: collectors (`tools/release-collectors/{cardlabo,torecamap,official}/collect.py` → `data/releases/`, git-ignored; official only with `TYPESAFE_API_KEY` + `OPENROUTER_API_KEY` in `.env`) → merge (`scripts/update_data.py`, starting from HEAD's `items.json`) → build with `BUILD_TODAY` → `scripts/verify_release.py --base origin/main` → `tools/verify/browser.mjs`. It stops at the first failing step and never commits. `--dry-run` stops after a report-only merge; `--no-official` runs the aggregators only.

If a collector refuses (layout marker missing, no records) or the merge aborts ("empty source", "stale run", "only N releases scraped"), a source page probably changed layout — open it in the browser pane, compare with `tools/release-collectors/cardlabo/parse.py` / `torecamap/parse.py`, fix the parser (a reviewed behaviour change: see `contracts/releases.md` › golden replay), rerun. Do not lower `MIN_RATIO` to get past it.

## 2. Read the packet

`out/refresh-<TODAY>/packet.md` (also printed at the end; step logs next to it): collector record counts and `complete` flags, the report's section counts, the data diff, items.json field changes vs HEAD, the verify RESULT lines, the screenshot folder (`.verify/`) and the verify base. Full report: `data/update-report.md`.

A `WARNING: … lost "official" from sources` line means the official step ran and did not match those upcoming items: they may be gone from the official site, or the match was missed (check the official page; the item keeps the aggregator name and price). A run without the official step (no keys, `--no-official`) keeps each item's `official` membership and official name, so it shows no such warning; it just brings in nothing new from the official sites.

## 3. Fix what it asks for

| Section | What to do |
|---|---|
| 未対応のタイトル名 | A source used a title label `GAME` doesn't know. Add it to `GAME` in `tools/release-collectors/lib/common.py`, mapped to the existing display name (check `data/items.json` for spelling), so one title doesn't split into two chips. Labels only change on the next collect: rerun without `--skip-collect`. |
| 新規 | Sanity-check names and dates. |
| 発売日の変更 / 価格の変更 | Usually real (延期, price announced). If a match looks wrong (two different products merged), pin the right values with `date` / `name` in `data/overrides.json`. |
| ソースから消えた今後の商品 | Check the official site. If cancelled, add `"hide": true` for that id in `data/overrides.json`; if still on sale, leave it. |
| 画像なし | Follow `.claude/skills/find-product-image/` (`scripts/add_thumb.py` writes the thumb and the override). Items pinned with `thumb: ""` are waiting for an official image; recheck them. |
| verify FAIL / WARN | Read `.claude/skills/verify-release/`; fix the data (overrides), not the check. |

Then re-run merge + build + verify on the same collector output:

```bash
python3 -I scripts/refresh.py --skip-collect    # TODAY=<the run's date> if the date has rolled over since the collect
```

If the set of main-title pages or their lead images changed a lot, rerun `python3 -I scripts/og.py` after the build and include `public/og/`.

## 4. Publish

Commit in the worktree (only these paths; never `git add -A`):

```bash
git add data/items.json data/meta.json data/update-report.md data/overrides.json public/thumbs public/og scripts tools/release-collectors/lib/common.py
git commit -m "Data update YYYY-MM-DD"
```

Then have a Fable sub-agent review `out/refresh-<TODAY>/packet.md` plus `git diff origin/main...HEAD` and rate its confidence, per the "Approvals: Fable first" rule in `~/.claude/CLAUDE.md`. High confidence → merge to main and push. Anything else → summarise for the owner in Chinese (counts per section, notable new releases, anything hidden or overridden, verify results, Fable's concerns) and wait for an OK.

After the push, watch the Deploy run (`gh run watch`), wait ~15 s, then check `https://shindan-navi.app/` shows the new 更新日 and `/sitemap.xml` has the new lastmod.

## Notes

- Items released more than 30 days ago are dropped automatically (and leave the sitemap).
- The merge deletes thumbnails no item references any more; images set through overrides stay referenced.
- After a big update, Search Console → Sitemaps → resubmit is optional; Google rereads the sitemap on its own.
