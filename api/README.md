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
| `npm run import:remote` | Needs `D1_DATABASE_ID`. Validate and estimate a first import (no remote call); `-- --plan` reads the remote rows and prints the exact plan; `-- --yes` migrates, plans and applies to the production D1. See "Remote import". |
| `npm run db:migrate` | Apply `migrations/` to the local D1. |
| `npm run db:reset` | Delete the local D1 and SQLite file; the next import rebuilds them from git. Needed once for databases created before `0001_events.sql`. |
| `npm test` | Vitest: filters, pagination, validation, meta, importer. `PERF=1 npx vitest run tests/perf.test.ts` runs a 20k-event benchmark. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run bundle` | `wrangler deploy --dry-run` with the root config into `.local/bundle`: checks config, assets and bundling; uploads nothing. Build `../dist` first to check the assets. |

Importer options: `node scripts/import-events.mjs [--data DIR] [--games OPCG,PTCG] [--target sqlite|wrangler|remote] [--sqlite FILE] [--out FILE] [--dry-run] [--plan] [--yes] [--max-writes N]`.
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
  `starts_at`, `record_count` = events in files.
- A game with any error is rejected as a whole (nothing written for it); other games still import; exit code 1.
  The remote target refuses to run at all while a game is rejected.
- **Diff, not replace.** The importer first reads the database's current rows (`id, content_hash, game_mask,
  starts_on, loc, …` for every event, plus `imports`), then writes only:
  - new events (insert) and events whose `content_hash` changed (full rewrite; `created_at` kept);
  - `game_mask` changes: an event gains the bit of every game listing it, and a **complete** run clears its game's
    bit on events in its window that it no longer lists (mask 0 hides the event; rows are never deleted; it
    reappears when listed again). Incomplete runs hide nothing; events outside the window are left alone;
  - an `imports` row per new run (`<GAME>:<fetched_at>`), and the two `site_meta` rows (`meta`, `state`) when
    anything changed. `state.version` = import time; the Worker's cache key includes it.
  An unchanged re-import writes nothing. The upsert also checks `content_hash`/`game_mask` in its `WHERE`, so a
  stale diff cannot rewrite matching rows.
- `content_hash` covers the event without `game_code` and `last_seen_at` (the API derives `last_seen_at` from the
  newest import of the event's games).
- Shared events: the same `id` under several games is stored once; `game_mask` holds every listing game. Copies
  should be identical apart from `game_code`/`last_seen_at`; if not, the importer warns and the last game read wins.
- Meta (game windows, prefecture / online / category / type counts over each game's latest window) is computed in
  the importer from the post-import state and stored as JSON, so `/events/meta` reads one row.
- Statements are chunked to < 80 KB (D1 limit 100 KB). A first import of the current data (~33k events) is ~360
  statements, ~34 MB of SQL (`wrangler d1 execute --file` accepts up to 5 GiB).

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

Reads per import: the state read (one row per existing event and import, ~33k) plus one primary-key lookup per
written row.

Reads per uncached page load, measured on the current data with SQLite (rows the query steps through; D1 may also
count the index entry, so up to ~2×). Every query is a `SEARCH events USING INDEX idx_events_loc (loc=? AND
starts_on>? AND starts_on<?)`; with several locations SQLite stops each one after `limit` rows.

| Location | `/events` first page (50) | `/events/days` month | `/events/days` 92 days | meta / version |
| --- | ---: | ---: | ---: | ---: |
| 東京都 (largest, 3,797 events / 92 days) | 51 | 1,693 | 3,797 | 1 + 1 |
| median prefecture (429 / 92 days) | ≤ 51 | 161 | 429 | 1 + 1 |
| 5 largest prefectures | 132 | 5,629 | 12,637 | 1 + 1 |

The page loads `/events/days` for the selected range (92 days in the list's default これから, one month in the
calendar) plus the first `/events` page, so an uncached Tokyo list view costs ~3,900 rows (median ~480). Cached
responses cost nothing; each isolate re-reads the 1-row data version at most once a minute.

## Remote import

```
D1_DATABASE_ID=<id> npm run import:remote                # first-import estimate, no remote call
D1_DATABASE_ID=<id> npm run import:remote -- --plan      # read remote rows, print the exact plan (reads ~33k rows)
D1_DATABASE_ID=<id> npm run import:remote -- --yes       # migrations apply, read, plan, execute --file
```

`--plan` and `--yes` need the data directory committed: tracked in git and clean. A symlinked or untracked
`data/events` (as in some worktrees) is refused — run the import from a checkout where the data is committed.

Consistency: the SQL never deletes or empties a table, so readers see each event in its old or new state. Whether D1
runs an uploaded file as one transaction is not documented (its import guide only says to remove `BEGIN
TRANSACTION`/`COMMIT`); a partial import is safe to re-run. D1 is single-threaded per database: while a large import
runs, API misses queue and may fail with an "overloaded" error, which the Worker returns as 500 (never cached);
cached responses keep serving. Daily refreshes are small diffs, so this mainly concerns the first import.

## API notes

- Unknown query parameters are 400 (they would otherwise bypass the cache); empty list values (`game=`) mean "no
  filter"; `from`, `until`, `limit`, `cursor` may appear once.
- `pref` is required: 1-5 of `JP-01`..`JP-47` / `online`.
- `limit` above 200 is clamped to 200; non-integers or < 1 are 400.
- `cursor` is bound to the filters (not to `limit`); reusing it with other filters is 400.
- `/events` has no `count`; `/events/days` gives per-day totals for the same filters.
- `game` matches any member game; events carry `game_codes` (sorted alphabetically) and `game_code` = `game_codes[0]`.
  `/events/days` counts a shared event once in `count` and under each member game in `by_game`.
- `mode=in_person` and `mode=online` both also match `hybrid`.
- `/events/days` lists only days with matches; `by_game` has only games with matches that day.
- `days` uses the weekday of `starts_on` (already a Tokyo date).
- All `event_status` values are returned and counted; the page marks cancelled/postponed events.
- Type labels come from `TYPE_LABELS` in `src/constants.ts` (per `event_type_code`); codes without a label use the code itself.
