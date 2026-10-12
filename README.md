# 新弾ナビ

TCG new-release calendar (static single page) for https://shindan-navi.app, hosted on Cloudflare Pages (project `shindan-navi`).

Working notes for people and coding agents: `CLAUDE.md` (architecture, owner decisions, gotchas) and the skills in `.claude/skills/` — `update-data` (refresh and publish the release data) and `find-product-image` (replace placeholders with real package images, helper `scripts/add_thumb.py`).

## Layout

- `src/template.html` — page markup, styles and script; `/*DATA*/` and `/*OFFICIAL*/` are filled at build time
- `data/items.json` — releases merged from カードラボ and トレカの地図; ids are stable (`i` + hash of title + normalised name)
- `data/overrides.json` — hand-made fixes by item id (`url`, `thumb`, `name`, `date`, `approx`, `hide: true`); `_name` and `note` are labels for people. Applied by both the updater and the build, never overwritten
- `data/meta.json` — date of the last data update (shown as 更新日, used as sitemap lastmod)
- `data/update-report.md` — what the last update changed
- `public/` — copied as-is into `dist/` (`thumbs/`, `favicon.svg`, `_headers`)
- `brand/` — logo mark and lockup SVGs (wordmark glyphs outlined from Dela Gothic One, OFL)

## Updating the data

A local, reviewed step — GitHub Actions never touches data.

```bash
.venv/bin/pip install fonttools brotli pillow   # once
.venv/bin/python -I scripts/update_data.py --dry-run   # see what would change
.venv/bin/python -I scripts/update_data.py             # write items.json, meta.json, new thumbs, update-report.md
git diff data/ && git add data public/thumbs && git commit -m "Data update YYYY-MM-DD" && git push   # push = publish
```

It scrapes カードラボ (daily tables) and トレカの地図 (this month + 5), matches them to existing items by id or by close name within 90 days (so date changes and small renames keep their id, thumbnail and links), downloads トレカの地図 images for new items or to replace `approx` ones, drops items released more than 30 days ago, and keeps upcoming items that vanished from both sources (listed in the report — hide them via overrides if cancelled). It aborts without writing anything if a source returns nothing or the release count falls below 70% of what is already known. Unknown title labels are listed in the report so `GAME` can be extended.

## Pages

Built by `scripts/build.py`: `/` (all titles), one page per main title (`/pokemon/`, `/onepiece/`, `/mtg/`, `/yugioh/`, `/duelmasters/`, `/weiss/`, `/unionarena/`, `/gundam/`, `/dragonball/`, `/digimon/`) and one per month (`/2026-10/` …). Each page has its own title/description/canonical, a static release list in the HTML, JSON-LD (BreadcrumbList / ItemList of Product), and the calendar app pre-filtered via `PAGE`. Also writes `sitemap.xml` and `robots.txt`; `public/404.html` stops Pages from serving the home page for unknown paths. `data/meta.json` holds the data snapshot date shown as 更新日 and used as sitemap lastmod.

OGP images: `python3 -I scripts/og.py` (after a build) renders `public/og/*.png` with headless Chrome. Re-run it when the game list or thumbnails change.

## Fonts and icons

Fonts are self-hosted: `build.py` runs `scripts/fonts.py` in `.venv` (`python3 -m venv .venv && .venv/bin/pip install fonttools brotli`) to subset `brand/fonts/*.ttf` (OFL, from google/fonts) to the characters the built pages use, writing `dist/fonts/*.woff2`. Icons: `brand/icon/favicon.svg` (tab icon) and `brand/icon/app-icon.svg` (apple-touch / PWA); rendered PNG/ICO live in `public/`.

## Build and preview

```bash
python3 -I scripts/build.py
```

Serves from `dist/`. GA only loads on `shindan-navi.app`, so local previews are not tracked.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`: build (with GA) and `wrangler pages deploy` to the `shindan-navi` Pages project. Repo secrets `CLOUDFLARE_API_TOKEN` (Account → Cloudflare Pages → Edit) and `CLOUDFLARE_ACCOUNT_ID` are required. The workflow only publishes; it never changes data — data updates are a separate local step that ends in a reviewed commit.

Manual deploy from a laptop still works:

```bash
npx wrangler@4 login
./scripts/deploy.sh   # GA4 measurement ID defaults to G-Q4NENX804G; override with GA_ID=...
```

Custom domain (one-time, already done): Workers & Pages → shindan-navi → Custom domains → `shindan-navi.app`; `www` redirects to the apex with a Redirect Rule.

## GA events

`favorite`, `filter_game`, `filter_favorites`, `switch_view`, `view_item`, `copy_favorites`, `change_theme`, `click_official`.
