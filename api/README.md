# Events API (local only)

Cloudflare Worker + D1 that serves `GET /api/v1/events`, `/api/v1/events/days` and `/api/v1/events/meta` as specified in
[`../contracts/README.md`](../contracts/README.md), and serves the built site from `../dist` on the same origin.

**Local only.** No remote D1 exists: `database_id` in `wrangler.jsonc` is a placeholder. Do not run
`wrangler login`, `wrangler d1 create`, `wrangler deploy` or any `--remote` command with this config.

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
| `npm run db:migrate` | Apply `migrations/` to the local D1. |
| `npm run db:reset` | Delete the local D1 and SQLite file; the next import rebuilds them from git. |
| `npm test` | Vitest: filters, pagination, validation, meta, importer. `PERF=1 npx vitest run tests/perf.test.ts` runs a 20k-event benchmark. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run bundle` | `wrangler deploy --dry-run` into `.local/bundle`: checks config and bundling; uploads nothing. |

Importer options: `node scripts/import-events.mjs [--data DIR] [--games OPCG,PTCG] [--target wrangler|sqlite] [--sqlite FILE] [--out FILE] [--dry-run]`.
The generated SQL is kept at `.local/import.sql`.

### workerd needs macOS 13.5+

`wrangler dev` and `wrangler d1 ... --local` run workerd, which does not start on macOS 12 (dyld error). There, use
`npm run dev:node`: it bundles `src/index.ts` with esbuild and runs the same `fetch` handler on Node with a
`node:sqlite` stand-in for D1 (`scripts/lib/sqlite-d1.mjs`) and a simple static file server for `../dist`.
Static handling only approximates Workers assets (`index.html` for directories, `.html` suffix, `404.html`).
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
- Statements are chunked to < 80 KB (D1 limit 100 KB). 20k events: ~145 statements, ~11 MB of SQL.

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
