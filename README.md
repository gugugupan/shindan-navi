# 新弾ナビ

TCG new-release calendar (static single page) for https://shindan-navi.app, hosted on Cloudflare Pages (project `shindan-navi`).

## Layout

- `src/template.html` — page markup, styles and script; `/*DATA*/` and `/*OFFICIAL*/` are filled at build time
- `data/items.json` — releases merged from カードラボ and トレカの地図 (snapshot 2026-10-12)
- `data/official-links.json` — official product page overrides by item id
- `public/` — copied as-is into `dist/` (`thumbs/`, `favicon.svg`, `_headers`)
- `brand/` — logo mark and lockup SVGs (wordmark glyphs outlined from Dela Gothic One, OFL)

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

```bash
npx wrangler@4 login
npx wrangler@4 pages project create shindan-navi --production-branch main
./scripts/deploy.sh   # GA4 measurement ID defaults to G-Q4NENX804G; override with GA_ID=...
```

Then in the Cloudflare dashboard: Workers & Pages → shindan-navi → Custom domains → add `shindan-navi.app` (and `www.shindan-navi.app`, redirected to the apex with a Redirect Rule).

## GA events

`favorite`, `filter_game`, `filter_favorites`, `switch_view`, `view_item`, `copy_favorites`, `change_theme`, `click_official`.
