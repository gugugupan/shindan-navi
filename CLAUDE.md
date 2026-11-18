# 新弾ナビ (shindan-navi.app)

TCG / トレカ new-release calendar for Japanese players: every title's boosters, decks and sets on one calendar, with favourites (★), add-to-calendar and SEO landing pages. Static site plus a TCG event calendar (`/events/`), both served by one Cloudflare Worker: static assets from `dist/`, `/api/*` from the Worker with D1.

## How it fits together

```
data/items.json ─┐
data/overrides.json ─┼─ scripts/build.py ─→ dist/ (pages, /events/, sitemap, robots, fonts) ─┐
src/template.html, src/events.html ─┘                                                    ├─ Worker "shindan-navi" (wrangler.jsonc)
public/ (thumbs, og, icons, _headers) ──┘                api/src/ (/api/v1/*) ─ D1 ────┘   on shindan-navi.app
                          ↑ push to main runs .github/workflows/deploy.yml (build + wrangler deploy)

scripts/update_data.py  (local, reviewed)  カードラボ + トレカの地図 → data/items.json + data/update-report.md
tools/event-collectors/ (local, reviewed)  → data/events/ ─ api/scripts/import-events.mjs --target remote (manual) → D1
```

- **Publishing = pushing to `main`.** The workflow builds and deploys code + `dist/`; it never edits data and never touches D1. Until the cutover (repo variable `LIVE_HOST` unset/`pages`) the live site is still the Pages project, built without `/events/`; the Worker only gets a preview deploy. `LIVE_HOST=worker` switches deploys to the Worker with the custom domain. Details and rollback: README.md › Deploy. `scripts/deploy.sh pages|worker [--domain]` is the manual fallback.
- **One Worker, one config.** `wrangler.jsonc` at the repo root (assets `dist/`, `run_worker_first: ["/api/*"]`, D1 binding `DB`, no routes). Its `database_id` is a placeholder: `api/scripts/remote-config.mjs [--domain]` writes the git-ignored `wrangler.remote.json` with the id from `D1_DATABASE_ID` (GitHub secret in CI, env var locally) and, with `--domain`, the `shindan-navi.app` custom domain. Never commit the real id.
- **Event data reaches D1 only by a manual import** (`cd api && D1_DATABASE_ID=… npm run import:remote -- --plan`, then `-- --yes`), after the collected JSON is reviewed and committed (the importer checks). It diffs against the database and writes only changes. D1 stays on the Free plan: see `api/README.md` › D1 budget before changing queries, indexes or the importer.
- **/events/ needs a location.** The API requires 1-5 `pref` values (prefectures or `online`); the page preselects the IP-guessed prefecture or asks. There is no nationwide view, by owner decision (keeps D1 reads bounded).
- **Data updates are a separate local step** that ends in a reviewed commit. See `.claude/skills/update-data/`.
- `src/template.html` is the whole app (HTML + CSS + vanilla JS). The build fills `/*DATA*/`, `/*OFFICIAL*/`, `/*PAGE*/null` and the `<!--PAGEHEAD-->`, `<!--SEOLIST-->`, `<!--SITENAV-->` slots per page.
- Pages: `/` (all titles), 10 main-title pages (`/pokemon/ /onepiece/ /mtg/ /yugioh/ /duelmasters/ /weiss/ /unionarena/ /gundam/ /dragonball/ /digimon/`, list in `GAMES` in build.py), month pages `/YYYY-MM/`. Each has its own title/description/canonical/OGP, a static release list in the HTML, JSON-LD, and the calendar pre-filtered via `PAGE`. `/events/` (from `src/events.html`, head/OGP from `EVENTS_PAGE` in build.py) is indexable, in the sitemap and in the tool tabs; its data comes from `/api/v1/`.

## Commands

```bash
python3 -m venv .venv && .venv/bin/pip install fonttools brotli pillow   # once
python3 -I scripts/build.py                       # → dist/ (needs .venv for font subsetting)
.venv/bin/python -I scripts/update_data.py --dry-run
.venv/bin/python -I scripts/add_thumb.py <id> <image-url> [--approx] [--note "..."]
python3 -I scripts/og.py                          # after a build; re-render public/og/*.png (headless Chrome)
cd api && npm ci && npm test && npm run typecheck && npm run bundle   # Worker checks; bundle = wrangler deploy --dry-run
cd api && npm run dev:node -- --port 8787         # site + API on Node/SQLite (macOS < 13.5 cannot run wrangler dev)
```

Local preview: `api/` `npm run dev:node` (site + API), or serve `dist/` alone (launch config `tcg-calendar`, port 5260) for the release calendar. GA only loads on `shindan-navi.app`, so previews are not tracked.

## Data model

- `items.json`: `{id, date, game, name, pack, box, url, thumb, approx, sources, source}`. `id` = `i` + sha1(`game|normalised name`)[:10] — stable across date changes; never renumber.
- `source` = where the release lives on its original site: `{url, key, site}`. `url` is the canonical official page (redirects resolved), `key` the official product code (OP-18, UA57BT, VG-DZ-BT17 … via `scripts/sourcekey.py`) or else the normalised name, `site` is `official` or `aggregator` (only seen on カードラボ / トレカの地図). **De-duplication goes by source first** — same product code within a title, or same page + key — and only falls back to name similarity / Jev when that fails. When the official pilot matches an item it can adopt the official source (`--adopt-sources`), so the next run pairs it by identity.
- `overrides.json`: hand fixes by id — `url`, `thumb` (`""` pins the placeholder), `name`, `date`, `approx`, `hide: true`. `_name` / `note` are labels for people. Applied by both the updater and the build; never overwritten.
- `approx: true` = stand-in image (key visual, other edition). Shown with 参考画像; the updater swaps in a real source image when one appears.
- Favourites are keyed by item id in the viewer's localStorage (`tcg.stars`); legacy `date|name` keys are migrated on load.
- Items with no image (or no price) are left out of Product JSON-LD — Google flags Product without `image` as critical. `hasMerchantReturnPolicy` / `shippingDetails` warnings are expected (we don't sell anything); don't fake them.

## Decisions the owner made (keep them)

- Top of every page is only the logo lockup, the 次の発売日 card and the toolbar. Page H1, breadcrumbs and lead text sit **below** the calendar as muted secondary text.
- No search box. Default title chips: MTG, ヴァイスシュヴァルツ, ポケモンカード, UNION ARENA, ONE PIECE; the rest behind ほか○タイトル.
- Desktop calendar shows at most 3 items per day; quiet weekdays become slim columns; today is gold. Mobile: day list collapses to starred items + the first item, with 閉じる under the date as well as at the bottom.
- Star button is the full-height right strip of each card (34px desktop, 46px mobile).
- Theme button is icon-only at the right end of the toolbar (自動 → ライト → ダーク, default follows the system).
- Tool switching (新弾カレンダー ⇄ イベントカレンダー): tabs in the toolbar just left of the theme button on desktop, a bottom tab bar on phones (≤760px); plus a ツール row in the footer nav. New tools are added to `TOOLS` in build.py.
- Starring an upcoming item asks to add it to Google Calendar / .ics (前日20時 alarm) unless 今後は確認しない was ticked.
- Thumbnails and data sources stay as they are and are **not credited** on the page (owner's choice, risk acknowledged).
- Keep this site standalone: don't cross-link it from or to other sites without asking the owner.
- Only the 10 main titles get landing pages for now. Weekly auto-refresh of data is deliberately not automated.
- Official sources win: when the official site lists variants separately (e.g. four commander decks) the calendar should list them separately too, each with its own source.

## Gotchas

- Right after a deploy, brand-new asset URLs can answer 404 / HTML for a few seconds; wait ~15 s before checking live. `public/_headers` deliberately sets no long-lived cache rules; it applies to static assets only, not to Worker (`/api/*`) responses.
- Workers static assets: `/pokemon` → 307 `/pokemon/`, `/x/index.html` → `/x/`, unknown paths → `404.html` with status 404. `*.workers.dev` (version preview URLs) answer with `X-Robots-Tag: noindex`. `public/_headers` restores the `X-Content-Type-Options` / `Referrer-Policy` headers Pages used to add.
- `/api/v1/events*` responses are cached per colo for 24 h under the data version (bumped by each import; isolates re-read it within 60 s), browsers 5 min. Unknown query parameters are 400 so they cannot bypass the cache.
- カードラボ (`/special/2028/`) has no years in its headings — the updater picks the year whose weekday matches. トレカの地図 takes `?year=YYYY&month=M`; its HTML also carries an RSC copy of every item — only items with a rendered `ProductInfo_name` are real.
- yu-gi-oh.jp blocks curl for HTML (Cloudflare) but its image URLs download fine — open articles in the browser pane, copy the image URL, fetch with curl.
- Official "NOW DESIGNING / NOW PRINTING" images are placeholders — never use them as thumbnails; pin `thumb: ""` instead.
- Fonts are subset at build time from the characters on the built pages (plus kana/ASCII). Sources are OFL fonts in `brand/fonts/`.
- The logo wordmark is outlined Dela Gothic One glyphs (`brand/shindan-navi-lockup-*.svg`); the favicon is a simplified pack + star (`brand/icon/`). Don't use the full lockup at icon sizes.
- The repo is public: never commit `.wrangler/`, `wrangler.remote.json`, the D1 database id, tokens, account ids or personal emails.
