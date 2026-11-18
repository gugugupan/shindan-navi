# Events API

Cloudflare Worker + D1 that serves `GET /api/v1/events`, `/api/v1/events/days` and `/api/v1/events/meta` as specified in
[`../contracts/README.md`](../contracts/README.md), and serves the built site from `../dist` on the same origin.

The Worker config is `../wrangler.jsonc` (one Worker, `shindan-navi`, for site + API); every script here passes
`--config ../wrangler.jsonc`. Its `database_id` is a placeholder. Remote commands use `../wrangler.remote.json`, written
by `scripts/remote-config.mjs` from env `D1_DATABASE_ID` (git-ignored; the id is never printed or committed).
Deploys happen only through `.github/workflows/deploy.yml` (or `../scripts/deploy.sh`); the only remote commands here
are `npm run import:remote -- --plan` (reads) and `-- --yes` (writes).

## Setup

```bash
cd api
npm ci
python3 -I ../scripts/build.py      # optional: builds ../dist so the page is served too
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Import `../data/events/` into the local D1, then `wrangler dev --local` on http://localhost:8787 (page + API). |
| `npm run dev:node` | Same, without workerd: imports into `.local/events.sqlite3` and serves the same Worker handler on Node (see below). |
| `npm run import` | Import only (local D1 via `wrangler d1 migrations apply/execute --local`). |
| `npm run import:sqlite` | Import only, into `.local/events.sqlite3`. |
| `npm run import:remote` | Needs `D1_DATABASE_ID`. Validate and estimate a first import (no remote call); `-- --plan` reads D1 and prints the review summary and plan; `-- --yes` migrates, plans and applies to the production D1. See "Remote import". |
| `npm run db:migrate` | Apply `migrations/` to the local D1. |
| `npm run db:reset` | Delete the local D1 and SQLite file; the next import rebuilds them from `../data/events/`. Needed once for databases created before `0001_events.sql`. |
| `npm test` | Vitest: filters, pagination, validation, meta, importer. `PERF=1 npx vitest run tests/perf.test.ts` runs a 20k-event benchmark. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run bundle` | `wrangler deploy --dry-run` with the root config into `.local/bundle`: checks config, assets and bundling; uploads nothing. Build `../dist` first to check the assets. |

Importer options: `node scripts/import-events.mjs [--data DIR] [--games OPCG,PTCG] [--target sqlite|wrangler|remote] [--sqlite FILE] [--out FILE] [--dry-run] [--plan] [--yes] [--max-writes N] [--allow-incomplete GAME,...] [--allow-shrink]`.
`dev-node.mjs` takes `--port`, `--sqlite` and `--dist`.
The generated SQL is kept at `.local/import.sql`.

### workerd needs macOS 13.5+

`wrangler dev` and `wrangler d1 ... --local` run workerd, which does not start on macOS 12 (dyld error). There, use
`npm run dev:node`: it bundles `src/index.ts` with esbuild and runs the same `fetch` handler on Node with a
`node:sqlite` stand-in for D1 (`scripts/lib/sqlite-d1.mjs`) and a simple static file server for `../dist`.
Static handling approximates Workers assets with `auto-trailing-slash` (`/dir` → 307 `/dir/`, `index.html` for
directories, `.html` suffix, `404.html`); `_headers` is not applied and there is no Cache API (responses stay `no-store`).
Tests use the same stand-in.

## Import behaviour

- Reads `data/events/<GAME>/_run.json` and `<YYYY-MM>.json`, validates them against `contracts/*.schema.json`
  plus: game/source match the directory and run, `id` = `<tcgp|ptcg|conan>:<external_id>`, no duplicate ids, file
  month = `starts_on` month, `starts_on` inside the run window, `ends_on >= starts_on`, `datetime` precision has
  `starts_at`, `record_count` = events in files. In-person events whose venue has no `region_code` get a warning:
  no location filter can reach them (0 in the current data).
- A game with any error is rejected as a whole (nothing written for it); other games still import; exit code 1.
  The remote target refuses to run at all while a game is rejected.
- **Diff, not replace.** The importer first reads the database's current rows (`id, content_hash, game_mask,
  starts_on, loc, …` for every event, plus `imports`), then writes only:
  - new events (insert) and events whose `content_hash` changed (full rewrite; `created_at` kept);
  - `game_mask` changes: an event gains the bit of every game listing it, and a **complete** run clears its game's
    bit on events in its window that it no longer lists (mask 0 hides the event; rows are never deleted; it
    reappears when listed again). Incomplete runs hide nothing; events outside the window are left alone;
  - an `imports` row per new run (`<GAME>:<fetched_at>`), and the two `site_meta` rows (`meta`, `state`) when
    anything changed or when they are missing / differ from what the current rows imply (repair after a failed import). `state.version` = import time; the Worker's cache key includes it.
  An unchanged re-import writes nothing. The upsert also checks `content_hash`/`game_mask` in its `WHERE`, so a
  stale diff cannot rewrite matching rows.
- `content_hash` covers the event without `game_code` and `last_seen_at` (the API derives `last_seen_at` from the
  newest import of the event's games).
- Shared events: the same `id` under several games is stored once; `game_mask` holds every listing game. Copies
  should be identical apart from `game_code`/`last_seen_at`; if not, the importer warns and the last game read wins.
- Meta (game windows, prefecture / online / category / type counts over each game's latest window) is computed in
  the importer from the post-import state and stored as JSON, so `/events/meta` reads one row.
- Statements are chunked to at most 60,000 UTF-8 bytes including the INSERT head and ON CONFLICT tail (D1 limit
  100 KB). A first import of the current data (~33k events) is ~580 statements, ~34 MB of SQL (`wrangler d1
  execute --file` accepts up to 5 GiB).

## Schema

`migrations/0001_events.sql` (replaced the never-deployed `0001_init.sql`; run `npm run db:reset` for older local
databases): `games` (seeded, with the `game_mask` bit), `imports`, `events`, `site_meta`, all `WITHOUT ROWID`.
`events` is one wide row per event: group (`group_*`, `category`, `event_type_code`) and venue (`venue_json`,
`region_code`) are stored inline, because joins cost a row read per event on D1. `loc` is the location filter key
(venue prefecture, or `online` without a venue). The only secondary index is `idx_events_loc(loc, starts_on,
starts_sort)`; the API never looks events up by group or venue, so the old group/venue/membership tables and
their indexes are gone. `starts_sort` = Unix seconds of `starts_at`, or 253402300799 for date-only events, which
gives the "starts_at nulls last" order and the keyset `(starts_on, starts_sort, id)`.

## D1 budget (Free plan: 100,000 rows written, 5,000,000 rows read per UTC day)

Writes (D1 counts each table row and each index entry; `--plan` prints the exact numbers for a given state):

| Import | Rows written |
| --- | ---: |
| First import of the current data (32,980 events, 4 runs) | ~65,966 (events 2 × 32,980, imports 4, site_meta 2) |
| Re-import with nothing changed | 0 |
| Typical refresh | 2 × changed events + 1 × membership changes + new runs + 2 |

The importer refuses to apply a plan above `--max-writes` (default 90,000). If a future first import is bigger,
split it with `--games` across UTC days. Free-plan limits are per day across everything, so check the dashboard
before a large import on a day that already had one.

Reads per import: the state read (one row per existing event and import plus 2 site_meta rows, ~33k) plus one
primary-key lookup per written row.

Reads per request, measured on the current data with SQLite (rows the query steps through; D1 may also count the
index entry, so up to ~2×). Every query is a `SEARCH events USING INDEX idx_events_loc (loc=? AND starts_on>? AND
starts_on<?)`; with several locations SQLite stops each one after the page size. With a cursor, the cursor's day is
the index lower bound, so a page re-reads at most that day's earlier rows.

| Location | `/events` page | `/events/days` one month | all `/events` pages, 92 days | meta / version |
| --- | ---: | ---: | ---: | ---: |
| 東京都 (largest, 3,797 events / 92 days) | 51–229 | 1,693 (Dec) | 8,415 in 78 requests (was 72,971 without the cursor bound) | 1 + 1 |
| median prefecture (JP-47, 429 / 92 days) | ≤ 51 | ≤ 363 | — | 1 + 1 |
| 5 largest (JP-13/27/23/28/11) | ≤ 803 | 5,629 (Dec) | 79,704 in 255 requests (was 807,959) | 1 + 1 |

The page asks `/events/days` per calendar month of the range (4 requests for これから) and the first `/events` page, so
an uncached Tokyo list view costs ~3,900 rows (median ~480). Cached responses cost nothing; each isolate re-reads the
1-row data version at most once a minute.

**Worst case per request.** Ranges are at most 31 days and clamped to the data window; the limit is fixed at 50;
cursors must lie inside the range. The most expensive request is `/events/days` (or an `/events` filter matching
nothing) over 5 large prefectures for 31 days: 10,360 rows on the current data (11-18..12-18; ~20.7k if index
entries count). So ~480 distinct uncached requests (~240 at 2×) would use the whole 5M/day. Defences, in order:
the edge cache (24 h per version, per colo), the Workers Rate Limiting binding `API_LIMIT` (60 uncached requests per
minute per IP and location, fail-open when absent) and the WAF rule from the README runbook (all `/api/` requests).
A determined client with many IPs can still exhaust the free quota for the rest of the UTC day; the static pages
are unaffected, `/events/` then shows its error state.

## Remote import

```
D1_DATABASE_ID=<id> npm run import:remote                # validate, first-import estimate, no remote call
D1_DATABASE_ID=<id> npm run import:remote -- --plan      # read D1 (~33k rows), print the review summary and plan
D1_DATABASE_ID=<id> npm run import:remote -- --yes       # migrations apply, read, plan, execute --file
```

Event data is local only (never in git), so the importer guards it itself:

- every month file and `_run.json` passes the schema and consistency checks; a rejected game blocks the remote
  import (`--games` imports the others deliberately);
- every run is `complete`, unless allowed per game: `--allow-incomplete CONAN` (an incomplete run adds and updates
  events but hides none);
- no game lists over 20% fewer events than D1 shows for it in the same window, unless `--allow-shrink`;
- at most `--max-writes` rows written (default 90,000).

The review summary (printed by every mode) has one line per game: fetched_at, source_total, records in the files,
events in D1 now for that window, inserted, updated, unchanged, hidden. Read it in `--plan`, then run `--yes`.

Consistency: the SQL never deletes or empties a table, so readers see each event in its old or new state. Whether D1
runs an uploaded file as one transaction is not documented (its import guide only says to remove `BEGIN
TRANSACTION`/`COMMIT`); a partial import is safe to re-run, and the next import rewrites site_meta if it was left
stale. D1 is single-threaded per database: while a large import runs, API misses queue and may fail with an
"overloaded" error, returned as 500 (never cached); cached responses keep serving, also when D1 fails afterwards
(the Worker falls back to the last known data version). Daily refreshes are small diffs, so this mainly concerns
the first import.

## API notes

- Unknown query parameters are 400 (they would otherwise bypass the cache); empty list values (`game=`) mean "no
  filter"; `from`, `until`, `limit`, `cursor` may appear once.
- `pref` is required: 1-5 of `JP-01`..`JP-47` / `online`.
- Ranges: at most 31 days, clamped to the data window (union of the latest import windows, kept in site_meta
  `state`); a range wholly outside answers empty without a D1 read.
- `limit` may only be 50 (the page size); anything else is 400.
- `cursor` is bound to the filters; reusing it with other filters, a date outside the range or a malformed key is 400.
- `/events` has no `count`; `/events/days` gives per-day totals for the same filters.
- `game` matches any member game; events carry `game_codes` (sorted alphabetically) and `game_code` = `game_codes[0]`.
  `/events/days` counts a shared event once in `count` and under each member game in `by_game` (only the selected
  games when `game=` is set).
- `mode=in_person` and `mode=online` both also match `hybrid`.
- `/events/days` lists only days with matches; `by_game` has only games with matches that day.
- `days` uses the weekday of `starts_on` (already a Tokyo date).
- All `event_status` values are returned and counted; the page marks cancelled/postponed events.
- Type labels come from `TYPE_LABELS` in `src/constants.ts` (per `event_type_code`); codes without a label use the code itself.
