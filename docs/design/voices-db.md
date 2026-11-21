# 話題カレンダー data in D1 (v1)

Status: implemented on `feat/voices-db`, dark until the owner switches it on (2026-11-21). Replaces the hardened design
of 0da9014 / 8f153d7 (manifest, CAS, revisions, ledger, Worker-rendered archive pages, offline rollback); that version
stays in git history at **8f153d7**.

Owner decision 2026-11-21: snapshots are stored in D1 and the pages render them in the browser from the API instead of
embedding them at build time. The SEO loss is accepted for now (a server-rendered setup such as Next.js may come later).

## What changes with `VOICES_SOURCE=d1`

| Piece | static (default, unchanged) | `VOICES_SOURCE=d1` |
| --- | --- | --- |
| Snapshots | `data/voices/*.json` embedded by `render_voices()` | D1 `voice_snapshots`, written by `api/scripts/import-voices.mjs` |
| `/voices/` | `const V = {snapshots, counts}` | `V = {snapshots: null, counts, api}`; the page fetches `GET /api/v1/voices`, then runs the same render code |
| `/voices/<date>/` | one static archive page per real snapshot | none; この日のまとめ links `/voices/#d=<date>` |
| `/voices/` latest list (`VLATEST`) | latest snapshot's titles, linking its archive page | none |
| Home いま話題 | `H.voices` (latest snapshot) | one `GET /api/v1/voices/latest`; the game palette is embedded as `H.voiceGames` |
| Sitemap | `/voices/` (lastmod = newest snapshot) + archive URLs | `/voices/` without lastmod; no archive URLs |
| Fonts | `/voices/` faces from the built text | the same faces from the local `data/voices/` text (later topics fall back to the system font for new glyphs) |

`VOICES_SOURCE` is a repo variable passed to the Worker build only (`.github/workflows/deploy.yml`). build.py ignores it
without `VOICES_ENABLED=1`, and a `BUILD_EVENTS=0` (Pages) build stays static because it has no Worker behind it.

Archive pages: the simplest consistent option is to drop them in d1 mode. Their content is the same cards `/voices/`
shows for a day, which `#d=<date>` opens; a Worker-rendered replacement was the expensive part of the old design. Old
archive URLs then answer 404 and leave the sitemap.

## Storage: migration `api/migrations-pending/0008_voices.sql`

```sql
voice_snapshots(date TEXT PRIMARY KEY CHECK (date GLOB 'YYYY-MM-DD shape'), body TEXT NOT NULL CHECK (json_valid(body)),
                hash TEXT NOT NULL /* sha256 of body */, updated_at TEXT NOT NULL)
voice_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)   -- 'version'
```

- `body` = one validated snapshot `{date, window, topics}` (contract shape without `version` / `note` / `sample`).
  One row per date; a date without topics has no row.
- The voices version lives in `voice_meta`, not `site_meta`: the events importer reads every `site_meta` row.
- Numbering: 0006 is on unmerged `ev-bushi-int`, 0007 is reserved for landing pages, so 0008.
- **Pending on purpose.** The file is outside `api/migrations/`, so the events importer's automatic `migrations apply`
  (and `npm run db:migrate`) cannot run it first. `CREATE TABLE IF NOT EXISTS` keeps it harmless if it is later
  applied again from `api/migrations/`. Tests and local SQLite use `SqliteD1.migratePending()`.

## Writer: `api/scripts/import-voices.mjs`

```
npm run import:voices -- [--data DIR] [--target sqlite|wrangler|local|remote] [--yes] [--prune]
npm run import:voices -- --remove-topic ID[,ID] | --remove-snapshot DATE[,DATE]  [--target …] [--yes]
npm run import:voices:sqlite -- --yes        # local SQLite of dev:node, applies migrations-pending first
```

- Validation = build.py `voices_data()` rules (fields, lengths in code points, game codes from `src/voices.html`,
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
  or not (rewritten with 2-space JSON or deleted; commit them). A file it cannot clean (unparseable, or still naming
  the id, e.g. in `note`) stops the run before anything is written; a final check fails the run if any file still
  holds it. Continuity problems are warnings here.
- Targets as `import-events.mjs`: `remote` needs `D1_DATABASE_ID` (written to the git-ignored `wrangler.remote.json`
  by `remote-config.mjs`). Wrangler's output is captured on every call and shown with each UUID and the id redacted.
  The importer never migrates: if the tables are missing it stops and points at the pending migration.

## Read path: the Worker

- `GET /api/v1/voices` → `{version, snapshots: [{date, window, topics}, …]}` oldest first, built from the stored
  bodies without re-parsing. `GET /api/v1/voices/latest` → `{version, snapshot: {…} | null}`.
- No parameters (400 otherwise), GET / HEAD only. Before the first import, or while 0008 is pending (no table), both
  answer empty (`version: null`) instead of failing.
- Caching and limits reuse the events path: the edge copy is keyed by `?v=<voices version>`, the browser keeps 5
  minutes, misses are rate-limited by `API_LIMIT` / `API_BREAKER`, and the last known version is kept in the colo
  cache (`/api/__state/voices`) for D1 outages. The per-isolate memo is keyed by state kind, so an events import does
  not invalidate voices answers and vice versa.
- Budget: a miss reads one row per snapshot (`/voices`) or one row (`/latest`); see `api/README.md` › D1 budget.

## Front end

- `/voices/`: everything that depends on the snapshots moved into `boot(snapshots)`; static builds call it with the
  embedded data, d1 builds after the fetch and a shape check of the answer (dates, ids, games, enums, the
  `reacting_to` form). Loading state 「話題を読み込んでいます…」; a failed or malformed answer shows the error state with
  再読み込み (a throw inside `boot()` too, whose 再読み込み reloads the page).
- Home: いま話題 stays hidden until `/latest` answers, and on any failure (no retry: it is a teaser).

## Verification

- `cd api && npm test` (`tests/voices.test.ts`: validation, plan, takedown, API, cache keys, rate limit).
- Static: `VOICES_ENABLED=1 .venv/bin/python -I scripts/verify_release.py --today D` and
  `node tools/verify/browser.mjs --today D` (unchanged; browser.mjs refuses a d1 build).
- d1: `VOICES_ENABLED=1 VOICES_SOURCE=d1 .venv/bin/python -I scripts/verify_release.py --today D` (no embedded data,
  no archive pages or URLs, sitemap, home flags) then `node tools/verify/voices-d1.mjs --today D`: seeds
  `.verify/voices-d1.sqlite3` from `data/voices/` with the importer, serves dist/ + API with `dev-node.mjs`, and checks
  in Chrome (desktop + mobile) one API request, identical list / calendar rendering against the same data embedded,
  `#d=` / `#t=` links, loading and error states, and the home block.

## Going live (owner)

1. Merge and push with `VOICES_SOURCE` unset: nothing changes for visitors.
2. Migration: `git mv api/migrations-pending/0008_voices.sql api/migrations/` (commit), then
   `cd api && node scripts/remote-config.mjs && npx wrangler d1 migrations list shindan-navi-events --remote --config ../wrangler.remote.json`
   (expect 0008 as the only unapplied one; 0006 / 0007 must not appear unapplied unless intended), then apply with
   `! npx wrangler d1 migrations apply shindan-navi-events --remote --config ../wrangler.remote.json`.
3. Import: `D1_DATABASE_ID=… npm run import:voices -- --target remote` (read the plan), then `-- --yes`.
   Check `https://shindan-navi.app/api/v1/voices/latest`.
4. Set the repo variable `VOICES_SOURCE=d1` and push (or re-run the deploy): `/voices/` and the home block read D1;
   the archive pages disappear.
5. From then on a new snapshot is `import:voices -- --target remote --yes`; no commit or deploy is needed. Rollback:
   unset `VOICES_SOURCE` and redeploy (the committed files still build the static pages).

## Deferred (owner accepted)

- SEO of the topic text: archive pages and the latest list are gone in d1 mode; search engines see only the shell.
- Offline rollback without D1: rollback is the static build from the committed files, which only works while they are
  kept and current. Whether to keep committing `data/voices/` is the owner's decision; until then they stay.
- Concurrency hardening: no plan file bound to `--yes`, no compare-and-swap; two importers at once could interleave
  (one operator, rare imports).
- Deletion ledger: a takedown edits D1 and the local files; nothing stops an old copy of a file from re-importing a
  removed topic, and search caches may lag (as the privacy page says).
- Fonts for topics added after the build, a month-scoped payload, and server rendering.
