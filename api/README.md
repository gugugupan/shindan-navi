# Events API

Cloudflare Worker + D1 that serves `GET /api/v1/events`, `/api/v1/events/days` and `/api/v1/events/meta` as specified in
[`../contracts/README.md`](../contracts/README.md), and serves the built site from `../dist` on the same origin.

The Worker config is `../wrangler.jsonc` (one Worker, `shindan-navi`, for site + API); every script here passes
`--config ../wrangler.jsonc`. Its `database_id` is a placeholder. Remote commands use `../wrangler.remote.json`, written
by `scripts/remote-config.mjs` from env `D1_DATABASE_ID` (git-ignored; the id is never printed or committed).
Deploys happen only through `.github/workflows/deploy.yml` (or `../scripts/deploy.sh`); the only remote command here
is `npm run import:remote -- --yes`.

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
| `npm run import:remote` | Validate and write `.local/import.sql`, print the write estimate and the wrangler commands. Needs `D1_DATABASE_ID`. Add `-- --yes` to apply to the production D1. |
| `npm run db:migrate` | Apply `migrations/` to the local D1. |
| `npm run db:reset` | Delete the local D1 and SQLite file; the next import rebuilds them from git. |
| `npm test` | Vitest: filters, pagination, validation, meta, importer. `PERF=1 npx vitest run tests/perf.test.ts` runs a 20k-event benchmark. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run bundle` | `wrangler deploy --dry-run` with the root config into `.local/bundle`: checks config, assets and bundling; uploads nothing. Build `../dist` first to check the assets. |

Importer options: `node scripts/import-events.mjs [--data DIR] [--games OPCG,PTCG] [--target wrangler|sqlite|remote] [--sqlite FILE] [--out FILE] [--dry-run] [--yes] [--allow-over-free-limit]`.
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
  plus: game/source match the directory and run, `id` = `<tcgp|ptcg>:<external_id>`, no duplicate ids, file month =
  `starts_on` month, `starts_on` inside the run window, `ends_on >= starts_on`, `datetime` precision has `starts_at`,
  `record_count` = events in files.
- A game with any error is rejected as a whole (nothing written for it); other games still import; exit code 1.
- Shared events: the same `id` under several games (e.g. BANDAI CARD GAMES series in OPCG and UATCG) is stored
  once, with one `event_games` row per game. Copies should be identical apart from `game_code`/`last_seen_at`;
  if not, the importer warns and the last game read wins.
- Upserts events by id. Groups and venues are keyed by their full content (source_id plus every field): a source
  group can carry different categories per event, and a TCG+ venue source_id is an organizer id spanning several
  addresses, so the API returns exactly each event's own group and venue. `updated_at` only moves when content changes
  (`last_seen_at` excluded). Re-importing the same files is a no-op apart from `imports.imported_at`.
- Nothing is deleted. When the run is `complete`, that game's memberships (`event_games`) **inside its window** that
  the run no longer contains get `missing_since`; other games' memberships of a shared event are untouched. An event
  is hidden from the API only when no membership is left; it reappears if a later run lists it. Incomplete runs hide
  nothing. Events outside the new window (e.g. past days after the window moves) are left as they are.
- One `imports` row per game run (`<GAME>:<fetched_at>`); meta reports the latest one per game.
- Statements are chunked to < 80 KB (D1 limit 100 KB). 20k events: ~145 statements, ~11 MB of SQL; the full data set
  (~33k events) is ~490 statements, ~30 MB (`wrangler d1 execute --file` accepts up to 5 GiB).
- `events.game_codes` is rewritten only where it changes.

## Remote import

`D1_DATABASE_ID=<id> npm run import:remote -- --yes` runs `wrangler d1 migrations apply --remote` and
`wrangler d1 execute --remote --file .local/import.sql` with `../wrangler.remote.json`. Without `--yes` (or with
`--dry-run`) it stops after printing the summary. A rejected game blocks it.

Consistency: the SQL is upserts plus `UPDATE`s, never `DELETE`, so no reader can see an empty or truncated table. D1 appears
to run an uploaded file inside one transaction (its docs say a file with its own `BEGIN TRANSACTION` fails with "cannot
start a transaction within a transaction"; not verified against a real D1), so a failed import should roll back; even
without that, a partial import leaves
every event in its old or new state and re-running finishes it. During a large import D1 is busy and API misses may
be slow; edge-cached responses keep serving.

### Write budget

D1 bills rows written, and each index adds one row per written row. The importer prints an upper bound
(`rows × (1 + indexes)` per table, plus `game_codes`). With the current data (2026-11-18):

| Table | Rows | Indexes | Rows written |
| --- | ---: | ---: | ---: |
| events | 32,980 | 6 | 230,860 |
| event_games | 32,984 | 2 | 98,952 |
| events.game_codes | 32,980 | 0 | 32,980 (first import; later only changes) |
| venues | 4,167 | 1 | 8,334 |
| event_groups / imports | 58 / 4 | 2 / 2 | 186 |
| **Total** | | | **~371,000** |

The upserts rewrite every event and membership on every import (`last_seen_at`, `last_import_id`), so a re-import
costs about the same minus `game_codes` (~338,000). The D1 Free plan allows 100,000 rows written per day and then
rejects every query (the API included) until 00:00 UTC. Even OPCG alone (~150,000) does not fit, so a full import
needs Workers Paid, or a schema/importer change (fewer `events` indexes, skipping unchanged rows); the importer
refuses estimates over 100,000 unless `--allow-over-free-limit` is passed.

Reads: `/events/meta` and `count`/`days` scan the matching events (up to all ~33k rows, several times for meta), so one
uncached page view reads on the order of 100k–300k rows (estimate, not measured on D1). The edge cache bounds this per
distinct URL and colo, but the Free plan's 5M rows read/day still allows only a few dozen uncached page views.

## Schema

`migrations/0001_init.sql`: `games` (seeded), `imports`, `event_groups`, `venues`, `events`, `event_games`. Source
identity lives on `events` (`source_code`, `external_id`, `UNIQUE`). `events.game_codes` caches the sorted visible
member games (NULL = hidden) and `events.region_code` copies the venue's region for its index. 0001 was edited
before any release; run `npm run db:reset` if you have an older local database. `starts_sort` = Unix seconds of `starts_at`, or 253402300799 for date-only events,
which gives the "starts_at nulls last" order and the keyset `(starts_on, starts_sort, id)`.

## API notes

- Unknown query parameters are ignored; empty list values (`game=`) mean "no filter"; `from`, `until`, `limit`,
  `cursor` may appear once.
- `limit` above 200 is clamped to 200; non-integers or < 1 are 400.
- `cursor` is bound to the filters (not to `limit`); reusing it with other filters is 400.
- `count` ignores the cursor and is the exact total (no cap; the date range is limited to 92 days).
- `game` matches any member game; events carry `game_codes` (sorted alphabetically) and `game_code` = `game_codes[0]`.
  `/events/days` counts a shared event once in `count` and under each member game in `by_game`.
- `pref` matches the venue's `region_code` (in-person and hybrid) and excludes `attendance_mode = online`.
- `mode=in_person` and `mode=online` both also match `hybrid`.
- `/events/days` takes the same filters, ignores `limit`/`cursor`, and lists only days with matches;
  `by_game` has only games with matches that day.
- `days` uses the weekday of `starts_on` (already a Tokyo date).
- All `event_status` values are returned and counted (`count`, `days`); the page marks cancelled/postponed events.
- Meta counts (prefectures, categories, types) are global, not per filter, and cover visible events inside each
  game's latest window. `meta.games` always lists all four games. Type labels come from `TYPE_LABELS` in
  `src/constants.ts` (per `event_type_code`); codes without a label use the code itself.
