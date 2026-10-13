# 新弾ナビ (shindan-navi.app)

TCG / トレカ new-release calendar for Japanese players: every title's boosters, decks and sets on one calendar, with favourites (★), add-to-calendar and SEO landing pages. Static site on Cloudflare Pages; no backend.

## How it fits together

```
data/items.json ─┐
data/overrides.json ─┼─ scripts/build.py ─→ dist/ (15 pages, sitemap, robots, subset fonts) ─→ Cloudflare Pages
src/template.html ─┘          ↑ push to main runs .github/workflows/deploy.yml (build + wrangler deploy)
public/ (thumbs, og, icons) ──┘

scripts/update_data.py  (local, reviewed)  カードラボ + トレカの地図 → data/items.json + data/update-report.md
```

- **Publishing = pushing to `main`.** The workflow only builds and deploys; it never edits data. `scripts/deploy.sh` is a manual fallback (`npx wrangler@4 login` first).
- **Data updates are a separate local step** that ends in a reviewed commit. See `.claude/skills/update-data/`.
- `src/template.html` is the whole app (HTML + CSS + vanilla JS). The build fills `/*DATA*/`, `/*OFFICIAL*/`, `/*PAGE*/null` and the `<!--PAGEHEAD-->`, `<!--SEOLIST-->`, `<!--SITENAV-->` slots per page.
- Pages: `/` (all titles), 10 main-title pages (`/pokemon/ /onepiece/ /mtg/ /yugioh/ /duelmasters/ /weiss/ /unionarena/ /gundam/ /dragonball/ /digimon/`, list in `GAMES` in build.py), month pages `/YYYY-MM/`. Each has its own title/description/canonical/OGP, a static release list in the HTML, JSON-LD, and the calendar pre-filtered via `PAGE`.

## Commands

```bash
python3 -m venv .venv && .venv/bin/pip install fonttools brotli pillow   # once
python3 -I scripts/build.py                       # → dist/ (needs .venv for font subsetting)
.venv/bin/python -I scripts/update_data.py --dry-run
.venv/bin/python -I scripts/add_thumb.py <id> <image-url> [--approx] [--note "..."]
python3 -I scripts/og.py                          # after a build; re-render public/og/*.png (headless Chrome)
```

Local preview: serve `dist/` (launch config `tcg-calendar`, port 5260). GA only loads on `shindan-navi.app`, so previews are not tracked.

## Data model

- `items.json`: `{id, date, game, name, pack, box, url, thumb, approx, sources, source}`. `id` = `i` + sha1(`game|normalised name`)[:10] — stable across date changes; never renumber.
- `source` = where the release lives on its original site: `{url, key, site}`. `url` is the canonical official page (redirects resolved), `key` the official product code (OP-18, UA57BT, VG-DZ-BT17 … via `scripts/sourcekey.py`) or else the normalised name, `site` is `official` or `aggregator` (only seen on カードラボ / トレカの地図). **De-duplication goes by source first** — same product code within a title, or same page + key — and only falls back to name similarity / Jev when that fails. When the official pilot matches an item it can adopt the official source (`--adopt-sources`), so the next run pairs it by identity.
- `overrides.json`: hand fixes by id — `url`, `thumb` (`""` pins the placeholder), `name`, `date`, `approx`, `hide: true`. `_name` / `note` are labels for people. Applied by both the updater and the build; never overwritten.
- `approx: true` = stand-in image (key visual, other edition). Shown with 参考画像; the updater swaps in a real source image when one appears.
- Favourites are keyed by `date|name` in the viewer's localStorage (`tcg.stars`), not by id.
- Items with no image (or no price) are left out of Product JSON-LD — Google flags Product without `image` as critical. `hasMerchantReturnPolicy` / `shippingDetails` warnings are expected (we don't sell anything); don't fake them.

## Decisions the owner made (keep them)

- Top of every page is only the logo lockup, the 次の発売日 card and the toolbar. Page H1, breadcrumbs and lead text sit **below** the calendar as muted secondary text.
- No search box. Default title chips: MTG, ヴァイスシュヴァルツ, ポケモンカード, UNION ARENA, ONE PIECE; the rest behind ほか○タイトル.
- Desktop calendar shows at most 3 items per day; quiet weekdays become slim columns; today is gold. Mobile: day list collapses to starred items + the first item, with 閉じる under the date as well as at the bottom.
- Star button is the full-height right strip of each card (34px desktop, 46px mobile).
- Theme button is icon-only at the right end of the toolbar (自動 → ライト → ダーク, default follows the system).
- Starring an upcoming item asks to add it to Google Calendar / .ics (前日20時 alarm) unless 今後は確認しない was ticked.
- Thumbnails and data sources stay as they are and are **not credited** on the page (owner's choice, risk acknowledged).
- Keep this site standalone: don't cross-link it from or to other sites without asking the owner.
- Only the 10 main titles get landing pages for now. Weekly auto-refresh of data is deliberately not automated.
- Official sources win: when the official site lists variants separately (e.g. four commander decks) the calendar should list them separately too, each with its own source.

## Gotchas

- Right after a deploy, brand-new asset URLs can answer 404 / HTML for a few seconds; wait ~15 s before checking live. `public/_headers` deliberately sets no long-lived cache rules.
- カードラボ (`/special/2028/`) has no years in its headings — the updater picks the year whose weekday matches. トレカの地図 takes `?year=YYYY&month=M`; its HTML also carries an RSC copy of every item — only items with a rendered `ProductInfo_name` are real.
- yu-gi-oh.jp blocks curl for HTML (Cloudflare) but its image URLs download fine — open articles in the browser pane, copy the image URL, fetch with curl.
- Official "NOW DESIGNING / NOW PRINTING" images are placeholders — never use them as thumbnails; pin `thumb: ""` instead.
- Fonts are subset at build time from the characters on the built pages (plus kana/ASCII). Sources are OFL fonts in `brand/fonts/`.
- The logo wordmark is outlined Dela Gothic One glyphs (`brand/shindan-navi-lockup-*.svg`); the favicon is a simplified pack + star (`brand/icon/`). Don't use the full lockup at icon sizes.
- The repo is public: never commit `.wrangler/`, tokens, account ids or personal emails.
