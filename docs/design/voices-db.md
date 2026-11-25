# 話題カレンダー data in D1 (v1)

Status: live in production (repo variables `VOICES_ENABLED=1`, `LIVE_HOST=worker`). The static mode that embedded
`data/voices/` at build time, with its `/voices/<date>/` archive pages, was removed the same day (owner decision
2026-11-22); D1 is the only source. The earlier hardened design (manifest, CAS, revisions, ledger, Worker-rendered
archive pages, offline rollback) stays in git history at **8f153d7**.

Owner decision 2026-11-21: snapshots are stored in D1 and the pages render them in the browser from the API instead of
embedding them at build time. The SEO loss is accepted for now (a server-rendered setup such as Next.js may come later).

Owner decision 2026-11-25: the snapshots live **only in D1**. The JSON files are no longer committed (`/data/voices` is
git-ignored, like `/data/events`); they are the importer's local input and backup. The owner's copy is
`.shindan-data/voices/` next to the repo checkouts in the workspace (pass it with `--data`); the snapshots up to
2026-11-23 stay in Git history. Builds, CI, tests and gates never read real snapshots: they use the made-up ones in
`tools/verify/fixtures/voices/`.

## Shape

| Piece | How |
| --- | --- |
| Snapshots | D1 `voice_snapshots`, written by `api/scripts/import-voices.mjs` from local files (`--data`, never committed) |
| `/voices/` | `const V = {counts, api}`; the page fetches `GET /api/v1/voices`, shape-checks it, then calls `boot(snapshots)` |
| Per-day pages | none; この日のまとめ links `/voices/#d=<date>`. Old `/voices/<date>/` URLs answer 404 |
| Home いま話題 | one `GET /api/v1/voices/latest`; the game palette is embedded as `H.voiceGames` |
| Sitemap | `/voices/` without lastmod (the data changes without a build) |
| Fonts | topic titles, summaries and voices (cards, home rows) use `--runtime`, a system font stack; the subset fonts carry only the built pages' text |
| Pages build (`BUILD_EVENTS=0`) | no Worker behind it, so no `/voices/`, tool tab, home block or privacy section, whatever `VOICES_ENABLED` says |

The local files are the importer's input and the only copy outside D1; keep the owner's copy backed up.

Fonts: the self-hosted faces are subset from the built HTML (`scripts/fonts.py`), which holds no topic text. The
subsets used to add the glyphs of the committed snapshots, but with no files in the repo (or CI) a build would cover
nothing, and even then each later topic mixed faces per glyph (measured on the 4 snapshots up to 2026-11-25: 278 of
697 distinct non-ASCII characters, ~9.5% of all characters, missing from the subsets). So the topic text is set in one
system face (`--runtime` in `src/template.html`: Hiragino / Yu Gothic / system-ui), as consistent as the page and with
no font growth; headings, chips and labels around it keep the brand faces.

## Storage: migration `api/migrations/0008_voices.sql`

```sql
voice_snapshots(date TEXT PRIMARY KEY CHECK (date GLOB 'YYYY-MM-DD shape'), body TEXT NOT NULL CHECK (json_valid(body)),
                hash TEXT NOT NULL /* sha256 of body */, updated_at TEXT NOT NULL)
voice_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)   -- 'version'
```

- `body` = one validated snapshot `{date, window, topics}` (contract shape without `version` / `note` / `sample`).
  One row per date; a date without topics has no row.
- The voices version lives in `voice_meta`, not `site_meta`: the events importer reads every `site_meta` row.
- Numbering: 0007 is reserved for landing pages, so 0008. `CREATE TABLE IF NOT EXISTS` keeps it harmless if applied
  again.

## Writer: `api/scripts/import-voices.mjs`

```
npm run import:voices -- [--data DIR] [--target sqlite|wrangler|local|remote] [--yes] [--prune]
npm run import:voices -- --data DIR --remove-topic ID[,ID] | --remove-snapshot DATE[,DATE]  [--target …] [--yes]
npm run import:voices -- --data DIR --today YYYY-MM-DD …   # local targets only: the date check's clock (gates)
npm run import:voices:sqlite -- --yes        # local SQLite of dev:node (--yes applies api/migrations/ first)
```

- `--data` defaults to the checkout's git-ignored `data/voices/` (as the events importer's `data/events/`) only for
  local imports: `--target remote` and takedowns refuse to run without an explicit `--data <owner voices dir>`, so a
  missing or stale default copy can neither feed the production D1 nor be the only files a takedown cleans. A missing
  directory stops an import or takedown.

- Validation = `contracts/voices.md` › Checks (fields, lengths in code points, game codes from `src/voices.html`,
  window / date / file name, share, voices, `reacting_to` as an x.com status URL), plus `contracts/voices.schema.json`
  (ajv), plus: no `posts`; every decoded string (by JSON path, keys and `note` included) is checked for an X /
  Twitter host, allowed only as that topic's own `reacting_to`; no date after
  today (JST), each body under 90 KB (D1 statement limit). Samples are skipped with a warning, never imported.
- Across snapshots (D1 rows not overridden + local files): an id keeps its `game` and `first_seen`; `new` only on its
  first appearance. A `continuing` / `cooling` id with no earlier snapshot is a warning (first snapshot, takedowns).
- Plan: per date `insert` / `update` / `unchanged` / `delete` by hash. A local file with `topics: []` deletes its date;
  a date in D1 without any local file is kept unless `--prune`. Without `--yes` nothing is written, and a SQLite file
  is opened read-only (never created or migrated). `--plan` with `--yes` is refused, as is an empty
  `--remove-topic` / `--remove-snapshot` value (it would otherwise fall through to an import).
- `--yes`: all statements in one `wrangler d1 execute --file` (or one SQLite transaction), last statement bumps
  `voice_meta.version` (= `Date.now()`), which is part of the API cache keys.
- Takedown: starts from the D1 rows, removes the topic from every date that lists it (a date left empty is deleted) or
  the whole date, writes D1, then applies the same removal to every file in `--data` that holds the id or date, valid
  or not, judged on the decoded JSON (raw text only for unparseable files). Files are rewritten with 2-space JSON, or
  deleted when no topic is left. A missing `--data` directory, or a file it cannot clean (unparseable, or
  still naming the id, e.g. in `note`), stops the run before anything is written; a final check fails the run if any
  file still holds it. Continuity problems are warnings here.
- Targets as `import-events.mjs`: `remote` needs `D1_DATABASE_ID` (written to the git-ignored `wrangler.remote.json`
  by `remote-config.mjs`). Wrangler's output is captured on every call and shown with each UUID and the id redacted.
  The importer never migrates: if the tables are missing it stops and points at the migration.

## Read path: the Worker

- `GET /api/v1/voices` → `{version, snapshots: [{date, window, topics}, …]}` oldest first, built from the stored
  bodies without re-parsing. `GET /api/v1/voices/latest` → `{version, snapshot: {…} | null}`.
- No parameters (400 otherwise), GET / HEAD only. Before the first import, or without the tables, both answer empty
  (`version: null`) instead of failing.
- Caching and limits reuse the events path: the edge copy is keyed by `?v=<voices version>`, the browser keeps 5
  minutes, misses are rate-limited by `API_LIMIT` / `API_BREAKER`, and the last known version is kept in the colo
  cache (`/api/__state/voices`) for D1 outages. The per-isolate memo is keyed by state kind, so an events import does
  not invalidate voices answers and vice versa.
- Budget: a miss reads one row per snapshot (`/voices`) or one row (`/latest`); see `api/README.md` › D1 budget.

## Front end

- `/voices/`: everything that depends on the snapshots runs in `boot(snapshots)` after the fetch and a shape check of
  the answer (dates, ids, games, enums, the `reacting_to` form). Loading state 「話題を読み込んでいます…」; a failed or
  malformed answer shows the error state with 再読み込み (a throw inside `boot()` too, whose 再読み込み reloads the page).
- Home: いま話題 stays hidden until `/latest` answers, and on any failure (no retry: it is a teaser).

## Verification

- `cd api && npm test` (`tests/voices.test.ts`: validation, plan, takedown, API, cache keys, rate limit).
- `VOICES_ENABLED=1 .venv/bin/python -I scripts/verify_release.py --today D` (no embedded data, no fixture topic text, sitemap,
  home flags), then `node tools/verify/voices-d1.mjs --today D`: seeds `.verify/voices-d1.sqlite3` with the importer
  (`--today D`) from the fixtures (`tools/verify/voices-fixtures.mjs`: `sample` dropped, dates moved so the last snapshot is D), serves dist/ + API with `dev-node.mjs`, and checks in Chrome (desktop + mobile) one API request,
  the list and calendar, `#d=` / `#t=` links, loading and error states, and the home block.
- `node tools/verify/browser.mjs --today D` drives the calendar, dialogs, filters and the home block with the API
  answer from the same fixtures served by its own static server.
- A `BUILD_EVENTS=0` build has no `dist/voices/`.

## Operations

- A new snapshot: write `<date>.json` into the owner's copy (`.shindan-data/voices/`), then
  `D1_DATABASE_ID=… npm run import:voices -- --data <owner voices dir> --target remote` (read the plan) and again with
  `--yes`. Nothing is committed. No deploy is needed; check `https://shindan-navi.app/api/v1/voices/latest`.
  Writes to the production D1 follow `.claude/skills/d1-remote-op`.
- Takedown: `D1_DATABASE_ID=… npm run import:voices -- --data <owner voices dir> --remove-topic ID --target remote` (or
  `--remove-snapshot DATE`; read the plan), then the same with `--yes`; it edits or deletes the files in `--data` too.
  Snapshots committed before 2026-11-25 stay in Git history (the privacy page says the repository history may keep
  them).
- Rollback of a bad import: a wrong date that was already in D1 is fixed by correcting its file and importing again
  (the plan shows `update`). A date that should not exist at all is removed with
  `D1_DATABASE_ID=… npm run import:voices -- --data <owner voices dir> --remove-snapshot DATE --target remote` (read the
  plan), then the same with `--yes`: a plain import keeps D1 dates that have no local file (only `--prune` would delete
  them), and this also deletes the local file.
- D1 outage: the edge copies and the last known version in the colo cache cover short ones; otherwise the pages show
  their error state.

## Deferred (owner accepted)

- SEO of the topic text: search engines see only the shell.
- Concurrency hardening: no plan file bound to `--yes`, no compare-and-swap; two importers at once could interleave
  (one operator, rare imports).
- Deletion ledger: a takedown edits D1 and the local files; nothing stops an old copy of a file from re-importing a
  removed topic, and search caches may lag (as the privacy page says).
- Brand fonts for topic text (it uses the system face, see Shape), a month-scoped payload, and server rendering.
