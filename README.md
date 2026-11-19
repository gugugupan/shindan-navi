# 新弾ナビ

TCG new-release calendar (static pages) and TCG event calendar (`/events/`, API + D1) for https://shindan-navi.app, served by one Cloudflare Worker (`shindan-navi`, config `wrangler.jsonc`).

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

A local, reviewed step run by hand from a worktree — GitHub Actions never touches data, and nothing refreshes it on a schedule.

```bash
.venv/bin/pip install fonttools brotli pillow   # once (+ beautifulsoup4 when the official API keys are set)
(cd tools/verify && npm ci)                     # once
python3 -I scripts/refresh.py                   # collect → merge → build → verify → review packet
python3 -I scripts/refresh.py --skip-collect    # after manual fixes: reuse today's data/releases, merge + build + verify again
python3 -I scripts/refresh.py --dry-run         # collect + report only (data/update-report.md), no build
```

`TODAY` (env, else today in Asia/Tokyo) is fixed once for every step. The collectors in `tools/release-collectors/`
(カードラボ, トレカの地図 this month + 5, official sites when `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` are in `.env`)
write `data/releases/` (git-ignored); `scripts/update_data.py` merges them into `data/items.json` starting from HEAD's
copy, so re-runs report against the committed data. The merge matches existing items by source identity, then id or
close name within 90 days (date changes and small renames keep their id, thumbnail and links), downloads トレカの地図
images for new items or to replace `approx` ones, drops items released more than 30 days ago, and keeps upcoming items
that vanished from the sources (listed in the report — hide them via overrides if cancelled). It refuses to write
anything if a source run is missing, stale, incomplete or empty, or the release count falls below 70% of what is
already known. Unknown title labels are listed so `GAME` (`tools/release-collectors/lib/common.py`) can be extended.

The command stops at the first failing step, never commits or pushes, and saves a review packet (collector counts,
report section counts, data diff, verify results) to `out/refresh-<TODAY>/packet.md`. Contract:
`contracts/releases.md`; workflow and publishing: `.claude/skills/update-data/`.

## Pages

Built by `scripts/build.py`: `/` (all titles), one page per main title (`/pokemon/`, `/onepiece/`, `/mtg/`, `/yugioh/`, `/duelmasters/`, `/weiss/`, `/unionarena/`, `/gundam/`, `/dragonball/`, `/digimon/`) and one per month (`/2026-10/` …). Each page has its own title/description/canonical, a static release list in the HTML, JSON-LD (WebSite / BreadcrumbList / ItemList as appropriate), and the calendar app pre-filtered via `PAGE`. List entries describe release names and available source URLs without Product/Offer markup or inferred stock availability. Also builds `/events/` (from `src/events.html`; data from `/api/v1/`; left out with `BUILD_EVENTS=0`) and writes `sitemap.xml` (incl. `/events/`) and `robots.txt`; `public/404.html` is served with status 404 for unknown paths (`not_found_handling: 404-page`). `data/meta.json` holds the data snapshot date shown as 更新日 and used as sitemap lastmod.

OGP images: `python3 -I scripts/og.py` (after a build) renders `public/og/*.png` with headless Chrome. Re-run it when the game list or thumbnails change.

## Fonts and icons

Fonts are self-hosted: `build.py` runs `scripts/fonts.py` in `.venv` (`python3 -m venv .venv && .venv/bin/pip install fonttools brotli`) to subset `brand/fonts/*.ttf` (OFL, from google/fonts) to the characters the built pages use, writing `dist/fonts/*.woff2`. Icons: `brand/icon/favicon.svg` (tab icon) and `brand/icon/app-icon.svg` (apple-touch / PWA); rendered PNG/ICO live in `public/`.

## Build and preview

```bash
python3 -I scripts/build.py
```

Serves from `dist/`. GA only loads on `shindan-navi.app`, so local previews are not tracked.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`. It never changes data and never touches D1 — data updates and event imports are separate local steps (see `api/README.md`). Who serves `shindan-navi.app` is the repository variable `LIVE_HOST`:

| `LIVE_HOST` | Pages project `shindan-navi` | Worker `shindan-navi` |
| --- | --- | --- |
| unset / `pages` (until the cutover) | built with `BUILD_EVENTS=0` (no `/events/`, no `/api/` there) and deployed: the live site keeps updating | built with `/events/` and deployed without a route, only if the `D1_DATABASE_ID` secret is set. A route-less `wrangler deploy` leaves an attached custom domain alone (wrangler 4.164 only publishes custom domains that are declared), so this is harmless after a manual cutover too |
| `worker` (after the cutover) | skipped | preview check (`api/scripts/preview-check.mjs`): fails on a broken build (`/`, `/events/`), only warns on API errors or stale data so release-calendar publishes never block on D1; then deployed with the `shindan-navi.app` custom domain. Fails if `D1_DATABASE_ID` is empty |

The committed `wrangler.jsonc` has no route: only `api/scripts/remote-config.mjs --domain` (used when `LIVE_HOST=worker`, or by hand during the cutover) adds the custom domain, so merging never moves the domain by itself. `workers_dev` is off; version preview URLs are on and answer with `X-Robots-Tag: noindex`.

Repo secrets and variables:

- `CLOUDFLARE_API_TOKEN` — Account: Cloudflare Pages Edit (until Pages is retired), Workers Scripts Edit, Account Settings Read; Zone `shindan-navi.app`: Workers Routes Edit, DNS Edit, Zone Read (custom domain). No D1 permissions: deploys only bind the database by id; imports run locally with your own login.
- `CLOUDFLARE_ACCOUNT_ID`.
- `D1_DATABASE_ID` — id of the `shindan-navi-events` D1 database. Never commit it.
- Variable `LIVE_HOST` — see above.

Manual deploys from a laptop (`npx wrangler login` first; `GA_ID` defaults to G-Q4NENX804G):

```bash
./scripts/deploy.sh pages                              # live site until the cutover
D1_DATABASE_ID=... ./scripts/deploy.sh worker          # Worker, preview URL only
D1_DATABASE_ID=... ./scripts/deploy.sh worker --domain # Worker + shindan-navi.app (cutover)
```

Cutover (once, after the first D1 import):

1. Remove `shindan-navi.app` from the Pages project's custom domains.
2. `D1_DATABASE_ID=... ./scripts/deploy.sh worker --domain`: uploads a version, runs `preview-check.mjs --strict` (the hard gate: build OK, meta lists events, Tokyo has events from today on), then deploys with the domain. Run interactively: wrangler asks before taking over existing DNS records; in CI (non-TTY) wrangler 4.164 overrides conflicting records without asking, so never let CI do the first attach.
3. Set the repository variable `LIVE_HOST=worker` in the same sitting. Until then pushes still deploy Pages (now unused) and the Worker route-less, which keeps the domain; nothing breaks, but set it so Pages stops receiving deploys and CI runs the preview check.

First check after any Worker deploy that reaches D1 (the preview before step 2, the live site after): open one filtered
list and scroll until a page loads with a cursor (e.g. `/events/?pref=JP-13&days=weekend`), then look at D1's rows read
for those queries (`npx wrangler d1 insights shindan-navi-events --config wrangler.remote.json`, or the dashboard's D1
metrics). They should match `api/README.md` › D1 budget (≤ ~600 rows per request for one prefecture); much more
means D1 picked a different plan.

Never set `LIVE_HOST=worker` before step 2. Rollback: remove the domain from the Worker (Settings → Domains & Routes), add it back to the Pages project, set `LIVE_HOST=pages` (or delete it) and run `./scripts/deploy.sh pages`. `www` redirects to the apex with a zone Redirect Rule either way.

Limits: the Worker limits uncached API requests itself (`API_LIMIT` 20/min per client, `API_BREAKER` 300/min per location; see `api/README.md` › D1 budget). Optionally add the Free plan's one WAF rate-limiting rule (Security → WAF → Rate limiting rules): *URI Path starts with `/api/`*, counted per IP, 30 requests / 10 s, Block for 10 s. It does not protect D1 (misses are already limited) but keeps one client from spending the Workers Free plan's 100,000 requests/day on cached `/api/` answers. A normal visit makes 3-4 API requests on load and about one per 50 events while scrolling.

## GA events

`favorite`, `filter_game`, `filter_favorites`, `switch_view`, `view_item`, `copy_favorites`, `change_theme`, `click_official`.
