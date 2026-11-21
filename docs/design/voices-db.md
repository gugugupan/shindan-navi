# 話題カレンダー data in D1 (design)

Status: design for owner review, 2026-11-21. Nothing here is built. Plan `2026-11-21-voices-data-in-d1-instead-of-static-json`,
node `design`.

Owner's ask (2026-11-21): "the generation process can touch the database directly instead of changing the page every
time". Today every snapshot is a committed `data/voices/<date>.json`, embedded by `scripts/build.py`, so a new snapshot
means commit, push and a deploy. After this change the importer writes D1 and the Worker serves `/voices/`, the archive
pages, the sitemap entries and the home block from D1. No commit, no deploy.

**Base.** `main` at 1c444a8 (two real snapshots: 2026-11-20 with 29 topics, 27.7 KB; 2026-11-21 with 2 topics). The
Worker serves `shindan-navi.app` (login is live on it), so `LIVE_HOST=worker` is assumed. Migration numbers: 0006 is on
the unmerged `ev-bushi-int` branch (games rows), 0007 is reserved for the event landing pages, so this design takes
**0008**.

## 1. Summary

- Two tables, `voice_snapshots` and `voice_topics`. Each snapshot keeps its own version of each topic (key
  `(snapshot_date, topic_id)`), because a day shows a topic "as the first snapshot on or after that day saw it". A
  small `voice_removed` tombstone table stops a removed topic or snapshot coming back from a stale local file. The
  voices data version lives in its own `site_meta` key, `voices_state`. It is separate from the events version, so a
  voices import does not empty the events cache.
- Writer: `api/scripts/import-voices.mjs` works like the events importer (`--plan` / `--yes`, targets `sqlite` /
  `wrangler` / `remote`). It validates against the schema and the contract, plus checks that only make sense against
  D1: id stability, a fixed `first_seen`, tombstones, and official X accounts confirmed through oEmbed. It writes only
  the diff and bumps `voices_state`. Takedowns go through the same importer (`--remove-topic`, `--remove-snapshot`).
- Read path: one Worker module, `api/src/voices.ts`. It renders the archive pages `/voices/<date>/` in TypeScript into
  a build-time shell, so their text stays server-side and indexable. It fills `/voices/` by injecting the snapshot
  JSON and the static latest list into the built page. It serves `/sitemap-voices.xml` (listed in `robots.txt`) and
  `GET /api/v1/voices/latest`, which feeds the home いま話題 block and later the game hubs. Everything is edge-cached
  under the voices version, like `/api/v1/events*`.
- Rollout behind the build and Worker flag `VOICES_SOURCE=static|d1`. Each snapshot is written to both stores until the
  cutover has been stable for 2 weeks. After that the committed JSON and the Python renderer are removed, and local
  files plus D1 are the only copies, as with event data.

## 2. Today

| Piece | Where | Reads |
| --- | --- | --- |
| Snapshots | `data/voices/<date>.json`, committed, `contracts/voices.schema.json` | build.py `voices_data()` (checks, drops samples once a real one exists) |
| `/voices/` | `render_voices()` → `const V = {snapshots, counts}` + `<!--VLATEST-->` static list | the page script computes topics and versions |
| `/voices/<date>/` | `render_voices_day()`: Python `vcard()` / `vatt_block()` mirror the page's `card()` / `attBlock()` | none (no script) |
| Home いま話題 | `home_voices()` → `H.voices` (latest real snapshot, 7 fields per topic) | none |
| Sitemap | `/voices/` (lastmod = latest) + one entry per archive page | static `sitemap.xml` |
| Fonts | `scripts/fonts.py`: `/voices/` and the archive pages get their own faces for the glyphs their text adds | build time |
| Gates | `verify_release.py` `check_voices()` and the home check; `browser.mjs` (`OFFICIAL_X` from `data/voices`) | the files |

Two facts shape the design. **Fonts**: topic text written after a deploy would contain kanji that are missing from
the subsets (section 5.5). **The game list** lives in `GAMES` in `src/voices.html`, and build.py parses it with a regex
(section 5.6).

## 3. D1 schema (migration `0008_voices.sql`)

```sql
-- One row per published snapshot (samples are never imported remotely). note: provenance for people (how the
-- snapshot was made), never served. n_topics is kept by the importer so the sitemap and prev/next need no topic scan.
CREATE TABLE voice_snapshots (
  date TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  window_from TEXT NOT NULL CHECK (window_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND window_from <= date),
  sample INTEGER NOT NULL DEFAULT 0 CHECK (sample IN (0, 1)),
  n_topics INTEGER NOT NULL CHECK (n_topics >= 0),
  note TEXT,
  content_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL
) WITHOUT ROWID;

-- One row per topic per snapshot (the version that snapshot saw). Topic window = the snapshot window (contract).
CREATE TABLE voice_topics (
  snapshot_date TEXT NOT NULL REFERENCES voice_snapshots(date) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 3 AND 64 AND id GLOB '[a-z0-9]*' AND id NOT GLOB '*[^a-z0-9-]*'),
  pos INTEGER NOT NULL CHECK (pos >= 0),                       -- order in the snapshot (busiest first)
  game TEXT NOT NULL CHECK (length(game) BETWEEN 2 AND 6 AND game NOT GLOB '*[^A-Z]*'),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 40),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 160),
  attitude TEXT NOT NULL CHECK (attitude IN ('positive', 'negative', 'mixed', 'neutral')),
  share_pos INTEGER NOT NULL CHECK (share_pos >= 0),
  share_neg INTEGER NOT NULL CHECK (share_neg >= 0),
  share_neu INTEGER NOT NULL CHECK (share_neu >= 0),
  volume TEXT NOT NULL CHECK (volume IN ('high', 'mid', 'low')),
  voices_json TEXT NOT NULL CHECK (json_valid(voices_json) AND json_type(voices_json) = 'array' AND json_array_length(voices_json) <= 3),
  reacting_to TEXT CHECK (reacting_to IS NULL OR reacting_to GLOB 'https://x.com/*/status/[0-9]*'),
  first_seen TEXT NOT NULL CHECK (first_seen <= snapshot_date),
  status TEXT NOT NULL CHECK (status IN ('new', 'continuing', 'cooling')),
  source TEXT NOT NULL CHECK (source IN ('grok-app', 'openrouter', 'x-api')),
  CHECK (share_pos + share_neg + share_neu > 0),
  PRIMARY KEY (snapshot_date, id)
) WITHOUT ROWID;
CREATE INDEX idx_voice_topics_id ON voice_topics (id);        -- takedown by id, continuity checks

-- Takedowns: identifiers only (our own ids / dates, no content). The importer refuses to re-add them.
CREATE TABLE voice_removed (
  kind TEXT NOT NULL CHECK (kind IN ('topic', 'snapshot')),
  key TEXT NOT NULL,
  removed_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
) WITHOUT ROWID;
```

- **Per-snapshot versions** (recommended) rather than storing only the latest version. Rejected: latest only (it
  breaks `versionOn()` and the archive pages, which must show what that day's snapshot said), and one JSON blob per
  snapshot (it cannot take down a topic across snapshots in one statement, and has no CHECKs).
- CHECKs mirror the contract where SQLite can express it. SQLite's `length()` counts characters, as Python's `len()`
  does; JS `.length` counts UTF-16 units, so the importer counts with `[...s].length`. The importer checks everything
  else: exact URL regex, game codes against the list, each voice ≤ 80 characters, `window.to = date`. Foreign keys
  are enforced on D1, so a snapshot delete cascades to its topics.
- **Removal is a hard delete** plus a tombstone. To take down a topic, delete it from every snapshot that has its id
  and decrement each snapshot's `n_topics`. To take down a snapshot, delete it (the cascade removes its topics). A
  snapshot with `n_topics = 0` counts as removed, as today: 404, out of the sitemap, skipped by prev / next. Rejected:
  a `removed_at` soft delete. The privacy page promises deletion, and a soft-deleted row is still stored content.
- `voices_state` (`site_meta` key): `{version, dates: [live real snapshot dates, ascending], updated}`. That is one row,
  about 11 bytes per date (≈ 4 KB a year), and it answers 404, prev / next and the whole sitemap without touching the
  topic tables.
- **Size.** A topic row is ≈ 0.9 KB on average (title, summary and 3 voices in UTF-8) and 1.5 KB at most, plus about
  80 B for the id index entry. A heavy day (16 games × 2 topics) is ≈ 30 KB, about 11 MB a year. The Free plan allows
  500 MB per database, and the events tables are far larger.

### Budget (Free plan: 100,000 rows written, 5,000,000 read per UTC day)

| Operation | Rows written | Rows read |
| --- | ---: | ---: |
| Import a new snapshot of N topics | N × 2 (row + id index) + 1 snapshot + 1 `voices_state` ≈ 2N + 2 (30 topics ≈ 62) | state read: every snapshot row + every topic's `(snapshot_date, id, game, first_seen, content hash)` ≈ all topic rows (≈ 11k after a year), then 1 lookup per written row |
| Re-import unchanged | 0 | the same state read |
| Edit one snapshot | 2 per changed topic + 2 | same |
| Take down a topic seen in k snapshots | 2k + k (`n_topics`) + 1 tombstone + 1 state | ≈ k |
| One-time migration of today's files | 31 topics → ≈ 66 | ≈ 0 |

Reads per uncached request (all cached per colo for 24 h under the voices version, browsers for 5 min):

| Request | Rows per miss |
| --- | ---: |
| `voices_state` (memoised per isolate for 60 s, like the events state) | 1 |
| `/voices/<date>/` | 1 snapshot + its topics (≤ ~32) |
| `/voices/` (all snapshots, until section 5.4's month split) | all topic rows: ~30 now, ≈ 5-11k after a year |
| `/api/v1/voices/latest` | latest snapshot's topics (≤ ~32) |
| `/sitemap-voices.xml` | 0 beyond the state |

Each import bumps the version and leaves every key cold. A full crawl of a year of archive pages after an import costs
≈ 365 × 32 ≈ 12k rows per colo (at least NRT and KIX). That is negligible next to the events budget. `/voices/` is the
only read that grows, and section 5.4 bounds it.

## 4. Writer: `api/scripts/import-voices.mjs`

```
node scripts/import-voices.mjs [--data DIR] [--dates 2026-11-21,...] [--target sqlite|wrangler|remote] [--plan] [--yes]
                               [--max-writes 5000] [--offline] [--remove-topic ID] [--remove-snapshot DATE] [--export DIR]
npm run import:voices:remote -- --data <dir> --plan      # read D1, print the review summary + plan, no write
npm run import:voices:remote -- --data <dir> --yes       # migrations check, read, plan, execute
```

It shares `remote-config.mjs`, the wrangler runner and `SqliteD1` with the events importer. The helpers move into
`api/scripts/lib/d1-cli.mjs`. Unlike `import:remote`, `--yes` **does not apply migrations**: it fails when one is
pending (the d1-remote-op rule that migrations need the owner).

**Validation**, which replaces build.py's checks and the git review:

1. Schema: ajv with `contracts/voices.schema.json` (already a dependency), then everything `voices_data()` checks now:
   file name = `date` = `window.to`, a topic window equal to the snapshot window, unique ids, `first_seen ≤ date`,
   `posts` refused, ≤ 3 voices of 1-80 characters, non-zero share, a known game code.
2. Privacy: no `posts` and no extra fields (already in the schema). Every `x.com` URL anywhere in the file must be a
   topic's `reacting_to`, which catches a URL pasted into a summary or voice. No `@handle` in title, summary or voices.
3. Official accounts only: the `reacting_to` handle must be in `contracts/voices-official-x.json`, a committed map of
   official account handles to games (public accounts, no personal data). The handle must belong to the topic's game
   or be a publisher account allowed for several games. Unless `--offline` is passed, `--plan` / `--yes` check each
   **new** `reacting_to` through `publish.twitter.com/oembed`: the post exists and its `author_url` handle matches.
   Player posts never reach the importer.
4. Continuity against D1 plus the input:
   - an id already in D1 keeps its `game` and `first_seen`;
   - `status: new` requires that no earlier snapshot has the id;
   - `continuing` / `cooling` require an earlier snapshot that has it;
   - an id that reappears after a gap is reported as a warning.
5. Dates: the date must be ≤ today (JST); an older date than the latest is allowed with a warning (backfill); a remote
   import refuses `sample: true`; tombstoned ids and dates are refused (no override flag: a restore is a manual owner
   decision).
6. A hard cap of `--max-writes` 5,000 (two orders of magnitude above a day).

**Plan output.** Per snapshot: new or updated, topics inserted / updated / unchanged / dropped (a topic missing from a
re-imported snapshot is deleted from that snapshot and listed), per game counts, continuing ids with their days, new
`reacting_to` handles with the oEmbed result, rows written, the old and new version. Writes run as one `--file`, like
the events importer, in this order: snapshot upserts, topic upserts and deletes, `n_topics`, then `voices_state` last.
A partial run is safe to re-run because the state is rewritten from the actual rows.

**Where the validated JSON lives afterwards.** In a git-ignored local directory, as with event data (recommended):
`data/voices/` in the worktree for input, with the canonical copy in the owner's data directory next to the event
data. A backup tarball goes to `~/shindan-backups/voices-<date>.tgz` before each import. `--export DIR` writes D1 back
to contract-shaped files, for a restore, for dev fixtures and for a rollback build. The lead keeps the oEmbed
evidence in `out/voices/<date>/` as today (git-ignored). Rejected: keeping the files committed as an audit log. The
repo is public, and every committed file stays in history after a takedown, which the privacy page then has to excuse
again. Committing also means pushing to `main`, which deploys, which is what the owner wants to stop. D1 Time Travel
(7 days) plus the tarballs cover recovery, and `note` in `voice_snapshots` keeps the provenance.

**One-time migration.** At M2: `import-voices.mjs --data data/voices --target remote --plan`, then `--yes` (≈ 66 rows).
From then until M5 every new snapshot is committed **and** imported (both stores), so a static rollback has the same
data. At M5 the files are removed with `git rm` (history keeps them, as it already keeps the first one with `posts`)
and `/data/voices` is added to `.gitignore`.

**Takedown.** `--remove-topic ID --plan` lists every snapshot that has the id and the rows to delete; `--yes` deletes
them, writes the tombstone and bumps the version. The runbook also deletes the topic from the local files and from the
backup tarballs. `--remove-snapshot DATE` does the same for a whole snapshot. These are deletes, so they always need
the owner's OK first (CLAUDE.md approvals).

## 5. Read path without deploys

### 5.1 Routing

`remote-config.mjs` adds `/voices`, `/voices/*` and `/sitemap-voices.xml` to `assets.run_worker_first`, and the var
`VOICES_SOURCE=d1`, only when env `VOICES_SOURCE=d1`. This follows the pattern of the feedback mail binding, so the
committed `wrangler.jsonc` and a `static` deploy behave exactly as today. Without that var the Worker passes those
paths to `ASSETS`.

Build artefacts the Worker reads through `env.ASSETS.fetch` (never served: the Worker answers 404 under `/voices/_kit/`):

| File (written by build.py with `VOICES_SOURCE=d1`) | Content |
| --- | --- |
| `dist/voices/index.html` | the current page, with slots: `/*VSNAPS*/[]` inside `const V = {counts, snapshots: …}`, `<!--VLATEST-->`, `<!--VROBOTS-->` |
| `dist/voices/_kit/day.html` | the archive shell: SITE_CSS, VOICES_CSS, fonts, brand, corner, sitenav, GA, footer; slots `<!--VHEAD-->` (title, description, canonical, OG, JSON-LD) and `<!--BODY-->` |
| `dist/voices/_kit/kit.json` | `{games: [{code, name, short, c, cd}], icons: {name: file-or-monogram}, site}`: everything `vcard()` needs that is not topic data |

### 5.2 Archive pages `/voices/<date>/`: TypeScript renderer in the Worker (recommended)

`api/src/voices-render.ts` ports `vcard()`, `vatt_block()`, `vtenths()`, `voices_day_page()` and the prev / next nav
from build.py line for line. The output is the same HTML (same classes, `約N%` / small-sample rules, `rel="nofollow
noopener noreferrer"` on `reacting_to`, カレンダーで見る → `/voices/#t=<id>`). Head: the same title 「YYYY年M月D日のTCG話題｜話題カレンダー｜トレカカレンダー」,
the same description from the top titles and game names, canonical, `og/voices.png`, BreadcrumbList only. prev / next
come from `voices_state.dates`. A date outside `dates` (unknown, removed, or left with no topics) gets `404.html` with
status 404. A malformed path gets 404 without a D1 read. `/voices/<date>` without a slash gets 307 to the slash form,
as static assets do.

Parity, so the move changes no indexed text: in M3, build.py renders the fixture snapshots and the two real snapshots
to golden HTML (`api/tests/fixtures/voices-golden/`). A vitest test requires the TS renderer to produce the same bytes
for the `<main>` element and the `<head>` metadata. The test stays after the Python renderer is removed. The page's
own `card()` / `attBlock()` remain the second copy, as today, and the CLAUDE.md "keep the two in step" note moves to
the TS file.

Rejected:
- **HTML fragments rendered by the importer and stored in D1.** A template or CSS change would need a re-import of
  every snapshot. prev / next depend on the neighbours. And the Worker would have to trust stored markup.
- **Client-rendered archive pages** (a shell plus an API fetch). Crawlers and no-JS visitors would lose the text that
  the 2026-11-20 decision made indexable.
- **Rebuilding and deploying on import.** That is what the owner wants to stop.

### 5.3 `/voices/`: injected into the built page (recommended)

The Worker fetches `dist/voices/index.html` from ASSETS and replaces three slots:
- `/*VSNAPS*/[]`: the snapshots, in exactly today's shape (`{date, window, topics, sample}`), so the page script does not
  change;
- `<!--VLATEST-->`: the static latest list, rendered by `voices-render.ts` with the same markup as `voices_latest()`;
- `<!--VROBOTS-->`: noindex while no real snapshot exists.

The composed HTML is cached under `(voices version, Worker version id)` (`version_metadata` binding). A deploy that
changes the shell therefore never serves an old composition. String replacement on about 30-300 KB stays well inside
the 10 ms CPU limit of Workers Free. Rejected: the page fetching `/api/v1/voices/…` after load. That adds a request,
an empty calendar on first paint and a layout shift, and the static list for crawlers would still need the Worker.

### 5.4 Bounding `/voices/` (M6, not needed for the cutover)

`V.snapshots` grows by about 10-30 KB a day. Once it passes about 300 KB raw (roughly 2 months), the Worker injects
only the snapshots of the current and previous month plus `{dates}`. The page fetches `GET /api/v1/voices/month?m=YYYY-MM`
when the visitor moves to an older month. A month answer covers the snapshots dated in that month plus the first
snapshot after it (for `versionOn()`), and each topic carries `last` (its last snapshot date, `MAX(snapshot_date)` by
`idx_voice_topics_id`), so bars spanning months stay correct. This is a page-script change, so it ships separately and
before the size becomes a problem.

### 5.5 Fonts

New topic text can contain kanji that no subset has. Today such characters get the page's own faces at build time.
With `VOICES_SOURCE=d1`, `scripts/fonts.py` builds the `voices-*` faces from a fixed set instead of the page text: all
JIS X 0208 level 1 and 2 kanji plus the characters of every shared page, split into `unicode-range` chunks of about
120 glyphs per weight. A browser downloads only the chunks a page uses, so a day costs a few chunks of about 15-30 KB.
The importer warns about any character outside that set (it renders in the system fallback font, which is legible).
`dist/voices/_kit/day.html` and `/voices/` carry the same `@font-face` list.

### 5.6 Game list

The Worker and the importer need the codes, names and colours. If the game-hub registry (`data/games.json`,
docs/design/game-hub.md M0) is on `main` first, everything reads `sources.voices` from it. Otherwise M1 moves the list
out of `src/voices.html` into `contracts/voices-games.json`, read by build.py (with the regex gone), the page (a
`/*VGAMES*/` slot), `kit.json` and the importer, and the registry later absorbs it. A new game code still needs a
deploy. That is rare and changes the palette anyway.

### 5.7 Sitemap

build.py keeps `sitemap.xml` as a urlset. With `d1` it drops `/voices/` and the archive entries from it and adds a
second line to `robots.txt`: `Sitemap: https://shindan-navi.app/sitemap-voices.xml`. The Worker serves that file from
`voices_state`: `/voices/` with lastmod = the latest date, then one `<url>` per date with lastmod = the date. Its
answer is empty (no `<url>`) while there is no real snapshot. Rejected: turning `sitemap.xml` into a sitemap index.
That changes the URL Search Console already reads, with no benefit. The owner can also submit `sitemap-voices.xml` in
Search Console (optional).

### 5.8 Home いま話題 and game hubs: `GET /api/v1/voices/latest`

The block is built empty (its markup stays behind `<!--VOICES-->`), and `H.voices` goes away. On load, `/` requests
`/api/v1/voices/latest`. The answer is `{date, games: [{code, name, short, c, cd}], topics: [{id, game, title, summary,
attitude, volume, first_seen}]}` (today's `home_voices()` shape), or `null` without a real snapshot. The block stays
hidden until the answer arrives, and on any error or 429. The 7-day staleness rule stays client-side. That is one
extra request per home view, the same key for everyone, so nearly all are edge hits.

Rejected: Worker-injecting into `/`. Every home view would pass through the Worker (`run_worker_first` on `/`), and a
Worker failure would break the whole home page instead of one block.

Game hubs (docs/design/game-hub.md): topics leave `HUB` / `data.json`. The hub reads the same `latest` key (and, for
the ◆ markers on past days, the month endpoint from section 5.4), filtered client-side. That means no new cache keys
per game. The hub's static HTML links `/voices/` instead of listing topic titles, which would otherwise go stale
between deploys. game-hub.md §6 and §8 need this edit before its M1.

## 6. API shape, caching, limits, failure

| Path | Params | Answer | Cache key |
| --- | --- | --- | --- |
| `GET /api/v1/voices/latest` | none (anything else is 400) | section 5.8 | `/api/v1/voices/latest?vv=<voices version>` |
| `GET /api/v1/voices/month` (M6) | `m=YYYY-MM`, exactly once, inside the data range (else an empty answer, no D1 read) | section 5.4 | `…/month?vv=<v>&m=` |
| `/voices/` (HTML) | query ignored (the page reads it client-side) | section 5.3 | `/voices/?vv=<v>&w=<worker version>` |
| `/voices/<date>/` (HTML) | none | section 5.2 | `/voices/<date>/?vv=<v>&w=<worker version>` |
| `/sitemap-voices.xml` | none | section 5.7 | `…?vv=<v>` |

- `voices_state` is read and memoised exactly as the events `dataState()` does (60 s per isolate, with a last-good copy
  in the colo cache under `/api/__voices_state`). The function takes the `site_meta` key as a parameter instead of
  being duplicated. Edge TTL 24 h; browser `max-age=300` for JSON and HTML. The HTML is not `no-store`, so the
  back/forward cache works.
- Rate limits count misses only, as today. New bindings `VOICES_LIMIT` (120 misses per minute per client) and
  `VOICES_BREAKER` (600 per minute per location) are separate from `API_LIMIT`, so a crawler walking archive pages
  after an import cannot lock a player out of `/events/`. They are generous because a miss reads at most about 32 rows
  (`/voices/` excepted). Over the limit the HTML gets 503 with `Retry-After: 60` (never 429 or 404 for crawlers) and
  the JSON gets 429 / 503 like the events API.
- When D1 fails, the last known version keeps serving every cached answer, as the events API does. On a miss:
  - archive page: 503 with `Retry-After: 300`, never 404, which could drop the page from the index;
  - `/voices/`: the shell with an empty `V.snapshots` and 「話題データを読み込めませんでした。時間をおいて再度お試しください。」 in `#notice`,
    with status 200 and `noindex`;
  - `latest`: 500, and the home block stays hidden;
  - sitemap: 503.

  No non-versioned stale copies are kept, so a takedown can never reappear from a fallback.
- Cloudflare documents working Cache API operations only on custom domains, so on `*.workers.dev` previews every voices
  request reads D1, as the events requests already do.
- **Workers Free has 100,000 requests a day.** Static assets are free, but every `/voices/*` view, every home `latest`
  call and every sitemap fetch is now a Worker invocation. The owner or lead checks the dashboard's daily request
  count before M4 (Q3).

**api/README.md › D1 budget** gets a "話題カレンダー" paragraph with the two tables in section 3, the import cap, the
Worker-request note and the rule that only `/voices/` grows with history.

## 7. Build and verify

- **`VOICES_SOURCE`** (repo variable and build env; default `static`): `static` is today's build, unchanged. `d1`
  (needs `VOICES_ENABLED=1` and `BUILD_EVENTS=1`) builds the shell, kit, `robots.txt` line and empty home block, skips
  `voices_data()`, `render_voices_day()` and the archive entries in `sitemap.xml`, and the deploy workflow passes it to
  `remote-config.mjs`. The Pages build (`BUILD_EVENTS=0`) is always `static`. Rollback: unset the variable and re-run
  the deploy. That works until M5, because both stores hold the data until then.
- **Local dev**: `npm run dev:node` imports `data/voices/` (or, if it is missing, `contracts/fixtures/voices/`, a
  committed synthetic set: 3 snapshots, a continuing and a cooling topic, a small-sample topic, a removed topic, one
  fixture official account) into the same SQLite file with `import-voices.mjs --target sqlite`, and serves the Worker
  with `VOICES_SOURCE=d1`. `import-voices.mjs --export` from remote gives a real local copy when needed.
- **`verify_release.py`**: with `d1` it builds, then runs `node api/scripts/render-voices.mjs --sqlite <fixture db>
  --out .verify/voices-d1/`. That script uses the Worker bundle on Node (the dev-node bundling, moved to
  `api/scripts/lib/local-worker.mjs`) to write `/voices/index.html`, every archive page, `sitemap-voices.xml`,
  `latest.json`, a removed date's 404 page and its status into a directory shaped like `dist/`. The existing
  `check_voices()` and home checks then run on those files against the fixture data: cards in GAMES order matching the
  data, no post text or embeds, no X URL but a topic's `reacting_to`, nofollow, canonical, BreadcrumbList only, prev /
  next skipping removed snapshots, 404 for removed and empty snapshots, sitemap lastmods. On top of that: the golden
  parity test, `robots.txt` naming both sitemaps, `/voices/` and the archive pages absent from `sitemap.xml`, and no
  topic text in `dist/`. Both `VOICES_SOURCE` values are built and checked until M5.
- **`browser.mjs`**: its static server sends `/voices*`, `/sitemap-voices.xml` and `/api/v1/voices/*` to the same
  in-process local Worker (SQLite fixtures). `OFFICIAL_X` comes from that database instead of `data/voices`. The
  `/voices/` and archive-page runs stay as they are. The home いま話題 run waits for the `latest` request, and new
  cases cover a failing `latest` (block hidden) and the D1-down `/voices/` notice.
- **Worker vitest**: importer validation, including every refusal in section 4; diff, takedown and tombstones;
  routing, including `/voices/_kit/` → 404 and `VOICES_SOURCE` off → assets; cache keys under the voices version; 503
  rather than 404 when D1 fails; rate-limit separation; the parity golden test.

## 8. Privacy page, CLAUDE.md, contracts

**`src/privacy.html` (VOICES section)**: Japanese wording for the owner to approve. This is a new revision:
`PRIVACY_EFFECTIVE_VOICES_D1` plus a 改定 line, effective at M4.
- 掲載している要約などは Cloudflare D1（米国その他の国のデータセンター）に保存し、そこから表示しています。
- 削除のご依頼は、確認のうえデータベースから削除します。公開ページへの反映は通常数分以内です。データベースの復旧用バックアップ（最長 7 日間）からも、その期間が過ぎると消去されます。
- 2026年11月X日（M5 の日付）以降の話題データは GitHub リポジトリに含めていません。それ以前の分は、削除前のデータファイルが変更履歴に残る場合があります（the existing sentence, now limited in time）。
- The rest is unchanged (no player URLs or handles, evidence kept only locally, search caches may lag).

**CLAUDE.md**:
- the `/voices/` paragraph: data in D1 written by `import-voices.mjs`; the Worker renders the archive pages and injects
  `/voices/`; `VOICES_SOURCE`; the "keep in step" note now points at `voices-render.ts` and `card()`;
- the "How it fits together" diagram gets a voices line;
- Commands get `import:voices`;
- Gotchas: voices cache under its own version; the Worker-request quota; fonts chunks.

**`contracts/voices.md`**: Files → local input directory plus D1 tables; "Build checks" → "Importer checks"
(section 4); the takedown procedure via `--remove-topic` / `--remove-snapshot`; the official-account list.

**Other docs and skills**:
- `contracts/README.md` gets one line.
- `api/README.md` gets a Voices section (import, takedown, schema), the 0008 runbook and the budget paragraph.
- The `d1-remote-op` skill covers voices imports (adding rows: a Fable review, then go ahead on high) and takedowns
  (owner first).
- A new `.claude/skills/voices-snapshot/` holds the runbook in section 9.

## 9. Milestones

| # | Ships | Live change | Needs the owner |
| --- | --- | --- | --- |
| M1 | `0008_voices.sql`, `import-voices.mjs` (sqlite / wrangler / remote, `--plan` only against remote), `contracts/voices-official-x.json`, game list file (5.6), fixtures, tests, contract and README drafts | none | design OK, Q2 |
| M2 | Remote migration 0008 (`!` line below, Time Travel bookmark first), then import today's two snapshots. Each new snapshot from now on goes to both stores (commit + import) | none (tables unused) | runs the migration; OK on the first `--yes` |
| M3 | `voices.ts` / `voices-render.ts`, `latest` API, sitemap route, shell + kit + chunked fonts behind `VOICES_SOURCE=d1`, parity goldens, verify / browser changes. Deployed with the flag off (the Worker passes voices paths to assets). The `d1` path is checked on a `wrangler versions upload` preview URL with the remote config carrying the paths (D1 read uncached, Cloudflare login needed) | none | Cloudflare login for the preview upload (or the owner runs it) |
| M4 | Cutover: privacy revision + set the repo variable `VOICES_SOURCE=d1` + push. Home block on `latest`. Watch Search Console coverage for archive URLs | `/voices/*` from D1 | sets the variable; approves the privacy text; the Q3 quota check |
| M5 | After 2 stable weeks: `git rm data/voices/*.json`, `/data/voices` in `.gitignore`, remove `voices_data()` / the Python renderer and the `static` branch; goldens stay. Rollback from here = `--export` + revert | none | OK (irreversible in practice: the git copy stops) |
| M6 | Month-scoped `/voices/` payload + `/api/v1/voices/month`; game hubs use `latest` / `month` | smaller `/voices/` | none |

Owner's remote migration (from `api/`, after `node scripts/remote-config.mjs` with `D1_DATABASE_ID` exported):

```
! ./node_modules/.bin/wrangler d1 time-travel info shindan-navi-events --config ../wrangler.remote.json
! ./node_modules/.bin/wrangler d1 migrations apply shindan-navi-events --remote --config ../wrangler.remote.json
```

Check `migrations list` first. If 0006 or 0007 is still unapplied remotely, `apply` would apply them too, so wait or
apply in number order with their own runbooks. No new secrets are needed. New bindings and vars (`VOICES_LIMIT`,
`VOICES_BREAKER`, `version_metadata`, `VOICES_SOURCE`) live in config. The repo variable `VOICES_SOURCE` is the owner's.

### Runbook: one new snapshot after the cutover (no commit, no deploy)

1. Grok (`grok-app`) answers per game, and the lead writes `data/voices/<date>.json` in the worktree, in contract shape
   with `note` for provenance.
2. The lead validates the supporting player posts and every `reacting_to` through oEmbed (exists, in the window, on
   topic, not a sales / video / report / shop post, 2+ distinct authors). Evidence goes to `out/voices/<date>/`, local
   only. `share` counts only validated posts.
3. Copy to the owner's data directory, then `tar czf ~/shindan-backups/voices-$(date +%F-%H%M).tgz -C <dir> .`.
4. Optional local look: `npm run dev:node`, then open `/voices/` and `/voices/<date>/`.
5. `D1_DATABASE_ID=… npm run import:voices:remote -- --data <dir> --dates <date> --plan`. Read the summary: topics
   new / continuing / cooling, kept `first_seen`, handles and their oEmbed result, rows (≈ 2N + 2), no unexpected
   deletes.
6. Record a Time Travel bookmark (`wrangler d1 time-travel info …`) in the report.
7. A Fable or GPT-astra review of the plan output with the D1 id masked. On high: `-- --yes` with the same flags.
   Medium or low: ask the owner.
8. Check live after about 60 s: `/api/v1/voices/latest` has the date; `/voices/<date>/` answers 200 with the cards;
   `/sitemap-voices.xml` lists it; the previous page links it as next.
9. Update the kb session note. Until M5, also commit the file on a branch and merge it with the next deploy (both
   stores).

Takedown: `--remove-topic <id> --plan` → owner OK → `--yes` → delete the topic from the local files and tarballs →
confirm a 404 or the missing card within minutes → reply to the requester.

## 10. Risks

- **Renderer drift.** There are now two renderers, the TS archive renderer and the page script's `card()`. The goldens
  pin the TS output, and `browser.mjs` compares the archive cards with the calendar's dialog text for one fixture topic.
  A later step could share one module between them.
- **Loss of the git audit trail.** After M5 the only copies are D1, the local files and the tarballs. Time Travel
  covers 7 days. `--export` into the backup directory after every import is part of the runbook.
- **SEO during the cutover.** Parity goldens plus a byte diff of the live archive pages before and after M4 (curl).
  503s, rather than 404s, when D1 fails.
- **Worker request quota and CPU** (Free: 100k/day, 10 ms). Every voices view and home `latest` call counts. Workers
  Paid ($5/month) is the escape hatch (Q3). `/voices/` composition grows with history until M6.
- **Fonts.** A JIS level 1+2 set misses rare kanji and emoji (the system fallback renders them, and the importer warns).
- **Pending migrations.** `migrations apply` applies every unapplied file (0006 and 0007 if present); check the list
  first.
- **Concurrent operators.** One lead imports. The importer re-reads the state in `--yes`, so a stale plan cannot apply.

## 11. Open questions for the owner

1. **Stop committing snapshots after M5**, keeping them only in D1, the owner's data directory and backups, as with
   events. Recommendation: yes. It is what "no page change every time" implies, and it ends new takedown leftovers in
   public git history.
2. **Official-account allowlist** committed as `contracts/voices-official-x.json` (public handles only). Recommendation:
   yes. Without git review it is the main guard that `reacting_to` only ever points at official posts. A new handle is
   a small commit (it deploys, harmlessly).
3. **Worker quota.** Is it OK that `/voices/*` and one home request per view become Worker invocations (Free:
   100k/day)? Recommendation: check the dashboard's daily requests before M4, and move to Workers Paid only if the
   7-day peak is above about 50k.
4. **Home block via API** instead of the build-time embed. Recommendation: API. Otherwise the block goes stale until
   the next deploy, which defeats the change.
5. **Game hubs** get their topics from the API and drop static topic titles from the hub HTML (an edit to game-hub.md
   §6/§8). OK?
6. **Takedown wording.** Hard delete with tombstones, and the privacy page states that D1 backups hold deleted data for
   up to 7 days. OK?
7. **Samples never go to D1** (local and fixtures only). OK?
