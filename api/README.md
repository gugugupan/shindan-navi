# Events API (local only)

Cloudflare Worker + D1 that serves `GET /api/v1/events` and `GET /api/v1/events/meta` as specified in
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
- Upserts by id (events), by source id or content hash (groups, venues). `updated_at` only moves when content changes
  (`last_seen_at` excluded). Re-importing the same files is a no-op apart from `imports.imported_at`.
- Nothing is deleted. When the run is `complete`, events of that game **inside its window** that the run no longer
  contains get `missing_since` and are hidden from the API; they reappear if a later run contains them. Incomplete
  runs hide nothing. Events outside the new window (e.g. past days after the window moves) are left as they are.
- One `imports` row per game run (`<GAME>:<fetched_at>`); meta reports the latest one per game.
- Groups and venues sharing a `source_id` are stored once; if two events disagree about the same group/venue, the
  last one read wins.
- Statements are chunked to < 80 KB (D1 limit 100 KB). 20k events: ~145 statements, ~11 MB of SQL.

## Schema

`migrations/0001_init.sql`: `games` (seeded), `imports`, `event_groups`, `venues`, `events`. Source identity lives on
`events` (`source_code`, `external_id`, `UNIQUE`). `events` duplicates `game_code` and the venue's `region_code` so the
main filters each use one index. `starts_sort` = Unix seconds of `starts_at`, or 253402300799 for date-only events,
which gives the "starts_at nulls last" order and the keyset `(starts_on, starts_sort, id)`.

## API notes

- Unknown query parameters are ignored; empty list values (`game=`) mean "no filter"; `from`, `until`, `limit`,
  `cursor` may appear once.
- `limit` above 200 is clamped to 200; non-integers or < 1 are 400.
- `cursor` is bound to the filters (not to `limit`); reusing it with other filters is 400.
- `count` ignores the cursor and is capped at 10000.
- `pref` matches the venue's `region_code` and excludes `attendance_mode = online`.
- `days` uses the weekday of `starts_on` (already a Tokyo date).
- All `event_status` values are returned; the client decides how to show cancelled/postponed events.
- Meta facet counts (prefectures, categories, types) cover visible events inside each game's latest window.
  Type names come from `TYPE_NAMES` in `src/constants.ts`; unknown codes use the code itself.
