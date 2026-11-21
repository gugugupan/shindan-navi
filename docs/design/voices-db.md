# 話題カレンダー data in D1 (design)

Status: design for owner review, 2026-11-21. Revision 2, after GPT gpt-6.2-astra's review of 0da9014 (hold:
5 high, 7 medium). Nothing here is built. Plan `2026-11-21-voices-data-in-d1-instead-of-static-json`.

Owner's ask (2026-11-21): "the generation process can touch the database directly instead of changing the page every
time". Today every snapshot is a committed `data/voices/<date>.json` that `scripts/build.py` embeds, so a new
snapshot means a commit, a push and a deploy. After this change an importer publishes to D1 and the Worker serves
`/voices/`, the archive pages, a voices sitemap and the home block from it. No commit and no deploy.

**Base.** `main` at 9007429. It has two real snapshots: 2026-11-20 with 29 topics and 2026-11-21 with 4 (OPCG and
CONAN). The data will keep moving until cutover, so the seed is taken from the cutover revision (section 4.5).
`LIVE_HOST` is believed to be `worker` (login is live there), but M4 verifies the serving host rather than assuming it.
Migration numbers: 0006 is on unmerged `ev-bushi-int` and 0007 is reserved for event landing pages, so this design
uses **0008**.

## 1. Summary

- **Storage.** D1 holds one validated JSON document per snapshot date (the current contract shape), a single
  publication manifest row, and a deletion ledger. There are no normalized topic rows. The importer validates across
  snapshots, and on a takedown it rewrites every affected date document. A new manifest revision is published with one
  compare-and-swap statement, so readers see either the old revision or the new one, never a mix.
- **Writer.** `api/scripts/import-voices.mjs`. `--plan` writes a plan file. `--yes --plan-file` applies exactly that
  plan, or aborts if the inputs, the ledger or the manifest version changed since the plan was made.
- **Readers.**
  - The archive pages `/voices/<date>/` are rendered by the Worker into a build-time shell.
  - `/voices/` is the built page with the snapshot JSON and the server-rendered latest list injected.
  - `/sitemap-voices.xml` is a separate sitemap.
  - `GET /api/v1/voices/latest` feeds the home block and, later, the game hubs.
- **One server renderer.** The card rules live in one pure module used by the browser, the Worker and the static
  fallback build (rendered on Node). The Python renderer goes away.
- **Freshness and failure.** Voices responses are served only against a manifest verified within the last 60 s.
  Otherwise the response is an uncached 503. A 404 is returned only when a fresh manifest says the page is absent.
- **Rollout and rollback.** `VOICES_SOURCE=static|d1`. Rollback never needs D1: the static build renders from a
  sanitized local export through the same renderer.

## 2. Today (what moves)

| Piece | Now | After |
| --- | --- | --- |
| Snapshots | committed `data/voices/*.json`, checked by build.py `voices_data()` | local, git-ignored input → importer → D1 `voice_docs` |
| `/voices/` | `render_voices()` embeds every snapshot as `const V` + `<!--VLATEST-->` | Worker injects into the built shell (5.3) |
| `/voices/<date>/` | `render_voices_day()`, Python port of `card()` / `attBlock()` | Worker, shared card module (5.2) |
| Home いま話題 | `home_voices()` → `H.voices` at build | `GET /api/v1/voices/latest` (5.6) |
| Sitemap | `/voices/` + archive URLs in `sitemap.xml` | `/sitemap-voices.xml` from the manifest (5.5) |
| Fonts | per-page voices faces from the built text | shared faces + Japanese system fallback (5.7) |
| Gates | `verify_release.py` / `browser.mjs` read `data/voices` | the same checks against a fixture database (7) |

## 3. D1 storage (migration 0008)

```sql
-- One row per published document revision. body = the snapshot JSON exactly as validated (contract shape, minus
-- `note`), hash = sha256(body). Only rows named by the manifest are served; others are staged or awaiting GC.
CREATE TABLE voice_docs (
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  rev INTEGER NOT NULL CHECK (rev > 0),
  body TEXT NOT NULL CHECK (json_valid(body)),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  note TEXT,                                     -- provenance for people; never served
  PRIMARY KEY (date, rev)
) WITHOUT ROWID;

-- Deletion ledger: identifiers only (our ids / dates), never content. Exported with every backup, replayed on restore.
CREATE TABLE voice_ledger (
  kind TEXT NOT NULL CHECK (kind IN ('topic', 'snapshot')),
  key TEXT NOT NULL,
  removed_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
) WITHOUT ROWID;

-- Publication manifest: exactly one row.
CREATE TABLE voice_manifest (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value))
);
```

`voice_manifest.value` = `{dates: {"2026-11-20": {rev, hash, n, modified}, …}, latest, updated}`.
- `n` is the topic count. A date with `n = 0` is never listed. It is dropped from the manifest, which makes it
  removed (5.4).
- `modified` is the JST day the document last changed (import, edit or takedown). It drives the sitemap `lastmod`.

Decisions:
- **Documents, not topic rows** (the reviewer's simpler route, adopted). The page and the archive renderer already
  consume whole snapshots. A cold archive read is one row. The importer already reads all history to validate, and at
  ≈ 1 document a day it can rewrite every date a takedown touches. Rejected for launch: normalized topic rows. They
  are only needed for per-topic or month queries, which wait for the later month split (5.8).
- **Per-date revisions plus a manifest switch** give atomic publication without relying on the undocumented
  transaction behaviour of `wrangler d1 execute --file`. The new rows are invisible until the manifest's single-row
  `UPDATE … WHERE version = :expected` (each statement is atomic in SQLite). The importer checks that exactly one row
  changed. Afterwards, rows not named by the manifest are garbage-collected: immediately for takedowns, otherwise
  after the next successful import (one-step undo, 4.4).
- **Separate tables from `site_meta`**, because the events importer reads every `site_meta` row in its state read.
  The events cache version is untouched by voices.
- **Size.** About 1 KB per topic. A heavy day (32 topics) is ≈ 30 KB, so a year is ≈ 1-11 MB, far below the Free
  plan's 500 MB per database.

## 4. Writer: `api/scripts/import-voices.mjs`

```
node scripts/import-voices.mjs --data DIR [--dates D,…] [--target sqlite|wrangler|remote] --plan [--plan-out FILE]
node scripts/import-voices.mjs --target remote --yes --plan-file FILE
node scripts/import-voices.mjs --remove-topic ID | --remove-snapshot DATE  --plan  (then --yes --plan-file)
node scripts/import-voices.mjs --undo --plan        node scripts/import-voices.mjs --export DIR
```

### 4.1 Validation (replaces build.py's checks and the git review)

1. Schema (ajv, `contracts/voices.schema.json`) plus every rule in `voices_data()`. Lengths count code points
   (`[...s].length`, as Python `len()` does).
2. Privacy:
   - no `posts` field and no extra fields;
   - every `x.com` URL anywhere in the file must be a topic's `reacting_to`;
   - no `@handle` in title, summary or voices;
   - `sample: true` is refused remotely (samples stay local or in fixtures).
3. Official only: the handle in `reacting_to` must be in `contracts/voices-official-x.json` (official accounts → games;
   public handles only). New URLs are checked through oEmbed unless `--offline` is passed: the post exists and its
   author matches the handle.
4. **Window rule, made explicit.** The supporting *player* posts must fall inside the window. The lead checks them
   and they never reach the importer. The official `reacting_to` post may predate the window: it is the trigger of the
   talk, and 2026-11-21's OPCG notice already does this. The contract gets that sentence.
5. Continuity, checked against the **resulting timeline** (D1 plus input plus removals), so backfills, edits and
   removals are covered as well as appends:
   - an id keeps its `game` and `first_seen`;
   - `new` requires no earlier appearance;
   - `continuing` / `cooling` require an earlier appearance;
   - an appearance removed through the ledger still counts as having existed, so a takedown of a topic's first day
     does not invalidate its later `continuing` rows;
   - ledger ids and dates are refused.
6. Date ≤ today (JST). An older date than the latest is allowed with a warning (backfill). The hard cap is
   `--max-writes 200`.

### 4.2 Plan, bound to the write

`--plan` reads the manifest, every served document and the ledger, diffs per date by `hash`, and prints the review:
- per date: new, changed, unchanged or removed;
- per topic inside changed dates: inserted, changed or dropped;
- continuing ids, handles and their oEmbed result;
- rows to write, the expected manifest version and the new manifest.

It writes `out/voices-plan-<ts>.json` with an input digest (the files plus the flags), a ledger digest, the expected
manifest version and the exact SQL with its digest. `--yes --plan-file` recomputes all of these and aborts on any
difference. The write order is fixed:
1. insert the staged `voice_docs` rows and the ledger rows;
2. compare-and-swap the manifest; on 0 changed rows, delete the staged rows and abort ("state moved; re-plan");
3. garbage-collect.

An interrupted run leaves staged rows that nothing serves, and the next plan collects them. Tests cover an interrupted
write between steps 1 and 2, a stale plan racing a takedown, and a re-run after a failed garbage collection.

### 4.3 Takedown

`--remove-topic ID` finds every date whose document contains the id and stages rewritten documents without it. A
date left with no topics drops out of the manifest. The run writes the ledger row, switches the manifest and
garbage-collects every old revision of those dates, including the undo slot. `--remove-snapshot DATE` does the same
for a whole date. A takedown always needs the owner's OK first. The removal check (section 6) is part of the procedure.

### 4.4 Recovery without whole-database Time Travel

Time Travel restores the whole database: accounts, preferences, feedback and events. It is not used for voices.
- **A bad voices import:** `--undo` switches the manifest back to the previous revisions, which are kept until the
  next import (never past a takedown), or re-imports the previous files from the backup as a new revision.
- **A lost or rebuilt database:** `--restore DIR`. It loads the export plus its ledger, **replays the ledger first**,
  then imports.

### 4.5 Where the JSON lives, seeding

- **Input** goes in a git-ignored `data/voices/` (added to `.gitignore` at M5) in the worktree. The canonical copy is
  in the owner's data dir, next to the event data.
- **Backups.** Before each import, `--export` (documents plus ledger, sanitized, so removed content is never present)
  goes to `~/shindan-backups/voices-<ts>.tgz`.
- **Evidence.** The lead's oEmbed evidence stays in `out/voices/<date>/`.
- Rejected: keeping the committed files as an audit log. The repo is public, a committed file outlives a takedown in
  history, and every commit to `main` deploys.
- **Seeding at M2.** Import from the agreed cutover revision of `main`, then compare the per-date `hash` in D1 with
  sha256 of each committed file's normalized body. The plan prints both, and a mismatch stops.
- **Dual-write from M2 to M4.** Every new snapshot is both committed and imported, and both copies are compared by
  hash before the flag flips.

## 5. Read path

### 5.1 Routing and kit

`remote-config.mjs` adds `/voices`, `/voices/*` and `/sitemap-voices.xml` to `run_worker_first`, plus the var
`VOICES_SOURCE=d1`, only when env `VOICES_SOURCE=d1`. This follows the pattern of the feedback binding. Build
artefacts are fetched from `env.ASSETS` by their **canonical** URLs. With `auto-trailing-slash`, `…/index.html` and
`….html` redirect.

| Asset (built with `d1`) | Fetched as | Content |
| --- | --- | --- |
| `dist/voices/index.html` | `/voices/` | the page with slots `/*VSNAPS*/[]`, `/*VERR*/false`, `<!--VLATEST-->`, `<!--VROBOTS-->` |
| `dist/_voices-kit/day/index.html` | `/_voices-kit/day/` | archive shell: CSS, fonts, brand, corner, sitenav, GA; slots `<!--VHEAD-->`, `<!--BODY-->` |
| `dist/_voices-kit/kit.json` | `/_voices-kit/kit.json` | game names, colours and icons for the renderer |

`/_voices-kit/*` holds no topic data. `_headers` gives it `X-Robots-Tag: noindex`, and it is not in any sitemap.
Worker HTML responses set the canonical in the markup. On `*.workers.dev` they also add `X-Robots-Tag: noindex`,
because `_headers` does not apply to Worker responses. They never copy the API's blanket noindex.

### 5.2 Archive pages `/voices/<date>/`

They are rendered from the date's document with `src/voices-card.js`: the pure card rules (largest-remainder tenths,
the < 5 small-sample phrase, badges, labels, link attributes, escaping), as markup builders over a small `h()`
helper. The browser page includes the same file through a build slot, and the Worker and Node import it. The output
keeps today's head and body: title 「YYYY年M月D日のTCG話題｜話題カレンダー｜トレカカレンダー」, description, canonical,
`og/voices.png`, BreadcrumbList only, prev / next from the manifest's listed dates, cards in GAMES order.
- `/voices/<date>` without a slash gets 307 to the slash form.
- A malformed path gets 404 without a D1 read.
- An unlisted date gets 404 (`404.html` body), but only on a fresh manifest (section 6).

Rejected: HTML fragments stored in D1 (a re-import for every template change, stale neighbours) and client-rendered
archive pages (they would lose the indexable text).

**Parity.** Committed goldens use **synthetic fixtures only**, so no real topic text is in git. The real pages are
compared ephemerally in `.verify/` (git-ignored) at M3 and M4: today's Python output against the Worker's for the
same revision. Semantic tests run both the browser and the Worker renderers on the edge fixtures:
- share ties, totals of 4 and 5;
- one snapshot versus several (the 🆕 rule);
- with and without `reacting_to`;
- escaping in HTML text, in attributes, and in the inline JSON (`</` escaped, as build.py does).

### 5.3 `/voices/`

The Worker fetches `/voices/` from ASSETS and injects:
- the listed documents in today's `{date, window, topics, sample}` shape, so the page script is unchanged;
- the latest list, which links the latest **non-empty** date;
- the robots slot.

On failure it serves the same shell with `/*VERR*/true`, status **503**, `Retry-After: 120` and `no-store`. The page
script's `renderNotice()` then shows 「話題データを読み込めませんでした。時間をおいて再度お試しください。」 instead of clearing
`#notice`, which is a one-line change. The calendar payload is measured at M3: bytes, cold CPU and D1 bytes for the
real data and for a synthetic year. Section 5.8 starts when it reaches 250 KB raw. At 10-30 KB a day that can be
only 10-30 days, so the month split must stay ready.

### 5.4 Empty snapshots, per surface

A date with no topics left (removal) **does not exist** on every surface:
- it is not in the manifest, so it gets 404, is not in the sitemap, is not in the calendar payload, and prev / next
  skip it;
- `latest` and the latest list use the newest listed date;
- the home block keeps its 7-day rule on that date. After the newest date is emptied, home shows the previous date's
  topics if they are ≤ 7 days old. These are older topics, never removed ones.

This differs from today's `home_voices()`, which uses an empty latest snapshot as-is. Tests cover removing a middle
date, emptying the latest, deleting the only date and a backfill, checking both neighbours and the sitemap.

### 5.5 Sitemap

`robots.txt` gets a second line, `Sitemap: https://shindan-navi.app/sitemap-voices.xml`. `sitemap.xml` drops
`/voices/` and the archive URLs. The Worker builds the voices sitemap from the manifest: each date's `lastmod` is its
`modified`, and `/voices/`'s is the newest `modified`. A change to neighbour links alone does not change `lastmod`.
On a manifest that is not fresh it returns 503.

### 5.6 Home and hubs: `GET /api/v1/voices/latest`

`/` builds the block empty and fetches `latest`, which returns today's `home_voices()` shape `{date, games, topics:
[{id, game, title, summary, attitude, volume, first_seen}]}` or `null`. On error, 429 or 503 the block stays hidden.
Rejected: Worker-injecting into `/`. Every home view would pass through the Worker, and a Worker failure would break
the whole page. Game hubs read the same key later. Their static HTML links `/voices/` instead of listing topic titles,
which needs an edit to game-hub.md §6/§8.

### 5.7 Fonts

With `d1`, the voices pages use the **shared** subsets plus the Japanese system fallback (already in the font stacks)
for glyphs the subsets lack. Home is the same. The per-page voices faces in `scripts/fonts.py` are skipped. Chunked
custom faces are not planned. If the fallback looks wrong, cold mobile requests, bytes and CSS size are measured on
both fixtures first. The reviewer's estimate is 22-26 chunks of 120 kanji touched per snapshot, which is too many to
adopt unmeasured.

### 5.8 Later: month-scoped payload (not for launch)

When 5.3's limit is reached, `/voices/` carries recent months and fetches older ones. The current
`versionOn()` picks the next snapshot **that contains the topic**, so a month answer must select by **interval
overlap**: every topic whose `[first_seen, last appearance]` overlaps the month, with its version chosen per topic.
The list view needs history loading, and `#t=<id>` / `#d=` deep links to unloaded data need resolving. That requires
per-topic indexes (normalized rows or a manifest topic index) and gets its own design.

## 6. Freshness, caching, limits, removal check

- **Manifest freshness.** Each isolate memoises the manifest for at most 60 s, keyed by **database and state name**.
  Today `stateMemo` / `stateFailedAt` in `worker.ts` are keyed by database only, so they become
  `WeakMap<D1Database, Map<name, …>>`, and the events behaviour is unchanged. Voices **never** falls back to an
  unverified manifest, so there is no colo copy and no 7-day last-good state. When the memo is older than 60 s and D1
  fails, the response is an uncached 503 with `Retry-After`.
- **Exposure bound.** A removed card or a missing new date can be served for at most about 60 s plus the browser TTL.
  HTML and `latest` use `max-age=60`.
- **Cache keys** (colo, 24 h edge) are `…?vv=<manifest version>&w=<Worker version id>` (`version_metadata` binding)
  for the HTML, `latest` and the sitemap. A deploy that changes the shell, the card module or the game metadata never
  serves an old body.
- **Limits** count misses only:
  - `VOICES_LIMIT`: 120 per minute per client;
  - `VOICES_BREAKER`: 600 per minute per location;
  - `VOICES_CAL_BREAKER`: 10 per minute per location for `/voices/`. Its key is identical for everyone, so a
    legitimate colo needs about 1 miss per version.

  Over a limit the HTML gets 503 with `Retry-After`, never 404, and the JSON gets 429 / 503.
- **Removal check** (scripted, `import-voices.mjs --check-removed ID|DATE`, run after every takedown and every
  restore). The id or date must be absent from:
  - `/voices/` (payload and latest list);
  - the archive bodies **and heads** (title, description);
  - `latest` and `sitemap-voices.xml`;
  - `voice_docs` (including undo slots);
  - the latest export and the backup tarballs (rewritten);
  - the local input dir;
  - until M5, the committed files and any open snapshot branch (fixed and pushed before the takedown is reported
    done);
  - accessible preview versions (a preview whose voices are served from D1 follows automatically; static previews
    with baked voices are deleted or redeployed).

  Search caches and third-party archives are outside our control, as the privacy page says. Ledger replay protects
  restores.

## 7. Budget (Free plan, account-wide)

D1 counts rows, not bytes, and the document model keeps row counts small:

| Operation | Rows written | Rows read |
| --- | ---: | ---: |
| New snapshot | 1 doc + 1 manifest (+ GC of the undo slot) ≈ 3 | plan: manifest + ≈ 1 doc per date (≈ 365 a year) + ledger; `--yes` the same again |
| Takedown touching k dates | 2k + 2 | same |
| `/voices/<date>/` miss | 0 | 1 doc (+ manifest ≤ 1 per isolate per 60 s) |
| `latest`, sitemap miss | 0 | 1 / 0 |
| `/voices/` miss | 0 | all listed docs (≈ 365 a year, rows; payload bytes are the real limit, 5.3) |

**Worker requests** are the larger cost. Workers Free allows 100,000 a day, and cache hits still invoke the Worker:
every `/voices/*` view, every home `latest` call and every crawler fetch now counts. Gate before M4:
- take the 7-day peak UTC day of Workers requests and D1 rows read / written, account-wide (dashboard);
- add the projection: home views, `/voices/` and archive views, crawler fetches after each import, imports;
- measure cold CPU (10 ms Free limit) and response bytes for the real data and a synthetic year;
- go ahead only below 50 % of each limit.

`api/README.md` › D1 budget gets the table and the gate.

## 8. Build and verify

- **`VOICES_SOURCE`** (repo variable and build env, default `static`).
  - `static`: build.py renders the voices pages by running `node api/scripts/render-voices.mjs --data <dir> --out dist/`.
    That is the same renderer as the Worker, on Node; Node already runs in CI. It replaces `render_voices_day()`.
    Until M5 `<dir>` is the committed `data/voices`.
  - `d1`: builds the shell, the kit, the `robots.txt` line and the empty home block, and the deploy passes the flag
    to `remote-config.mjs`.
- **Proof before M4.** Build `static` from the committed files and render `d1` from the database seeded at the same
  revision. Diff the voices output (it must be identical apart from known slots). Check which host serves the domain
  (`curl -sI`, `LIVE_HOST`, the Worker's custom domain).
- **Rollback without D1**:
  - before M5: unset the variable and redeploy (static from the committed files, kept equal by dual-write);
  - after M5: `scripts/deploy.sh worker --domain` with `VOICES_SOURCE=static VOICES_DATA=<sanitized latest export>`.
    It builds locally and needs no D1 and no CI data.
  - M5 waits until this has been **rehearsed with D1 unreachable and after a test takedown** (ledger replayed, the
    removal check passing on the static output).
- **Pages after M5.** The Pages build has no voices input in CI, so it builds with voices off (no `/voices/`, no tab,
  no VOICES privacy part). A manual Pages fallback can use the same local export.
- **Privacy during fallback.** The static fallback still describes D1 storage, which stays true because the data is
  still there.
- **Local dev.** `npm run dev:node` imports `data/voices/`, or else `contracts/fixtures/voices/`: synthetic, with 3
  dates, continuing, cooling, small-sample and removed topics, one fixture official account, an emptied date and a
  backfill. It goes into the same SQLite file and the Worker runs with `VOICES_SOURCE=d1`.
- **`verify_release.py`.** `render-voices.mjs --sqlite <fixture db> --out .verify/voices-d1/` writes a `dist/`-shaped
  tree: `/voices/`, the archives, the sitemap, `latest.json`, and the 404 / 503 responses with their status. The
  existing `check_voices()` and home checks then run on it: GAMES order, no post text, no X URL but `reacting_to`,
  nofollow, canonical, BreadcrumbList only, prev / next, sitemap lastmods. Both flag values are checked until M5.
- **`browser.mjs`.** Its server routes the voices paths to the in-process Worker (`api/scripts/lib/local-worker.mjs`,
  shared with dev-node) and reads `OFFICIAL_X` from the fixture database. Added cases: home with `latest` failing, the
  503 `/voices/` notice, and an archive card compared with the calendar's dialog card.
- **M3 checks against the real ASSETS binding** (preview upload): status, content type, canonical, the preview
  noindex header, `/_voices-kit/` headers, both slash forms, 404 on fresh absence, 503 with D1 unreachable.
- **Vitest.** Every importer refusal; plan binding and mismatch aborts; compare-and-swap races; an interrupted write;
  ledger replay; continuity on the resulting timeline; freshness (two warmed caches, a takedown and a new date, D1
  down); state memo keyed by name; cache keys; escaping; renderer semantics.

## 9. Privacy page, CLAUDE.md, contracts

**Privacy (VOICES section).** It needs a new dated revision, **effective at M2**, when storage in D1 starts. The
Japanese wording is for the owner to approve:
- 掲載している要約などは Cloudflare D1（米国その他の国のデータセンター）に保存し、そこから表示しています。
- 削除のご依頼は、確認のうえデータベースと公開ページから削除します（反映は通常数分以内）。
- Cloudflare D1 の障害復旧機能により、削除後も一定期間（契約プランに応じて 7 日間または 30 日間）、復元用のデータが残る場合があります。
  This mirrors the existing STORE wording and is plan-dependent.
- The git-history sentence is limited to data before the M5 date.

**CLAUDE.md.**
- the `/voices/` paragraph: D1 documents, the importer, `VOICES_SOURCE`, the shared card module replacing "keep the
  two in step", the freshness rule;
- the diagram gets a voices line and Commands get `import:voices`;
- Gotchas: voices served only on a fresh manifest; the Worker request quota.

**Contracts and other docs.**
- `contracts/voices.md`: Files → local input + D1; Build checks → importer checks; the window rule (4.1-4);
  takedown, removal check and ledger; the official-account list.
- `api/README.md`: a Voices section, the 0008 runbook and the budget.
- The `d1-remote-op` skill: voices imports go to a Fable review (high → go ahead); takedowns, `--undo` and
  `--restore` need the owner first.
- A new `voices-snapshot` skill holds the section 10 runbook.

## 10. Milestones and runbook

| # | Ships | Live change | Owner |
| --- | --- | --- | --- |
| M1 | **Events runner change first**: `import:remote --yes` refuses pending migrations, which apply only with an explicit `--apply-migrations` (matching the d1-remote-op rule). Then the voices importer (sqlite / wrangler, remote `--plan` only), `voices-card.js`, the official-account list, synthetic fixtures and goldens, tests. `0008_voices.sql` stays in `api/migrations-pending/` | none | design OK, Q1-Q2 |
| M2 | Move 0008 into `api/migrations/` and merge. The owner applies it (lines below). Seed from the cutover revision with hash comparison. Privacy revision live. Dual-write starts | privacy text | runs the migration; approves the privacy text; OK on the first `--yes` |
| M3 | Worker read path, `latest`, sitemap, kit, freshness, limits, `static` via `render-voices.mjs`, verify / browser. Deployed flag-off. Checked on a `wrangler versions upload` preview with the voices routes | none | Cloudflare login for the preview (or the owner runs it) |
| M4 | Gates: section 7 budget, section 8 static-vs-d1 proof and serving-host check. Then the owner sets the repo variable `VOICES_SOURCE=d1` and pushes. Home uses `latest` | `/voices/*` from D1 | variable; Q3 |
| M5 | After 2 stable weeks **and** the rehearsal (D1 down, after a test takedown): `git rm data/voices/*.json`, gitignore the folder, Pages voices off, drop the Python remnants | none | OK (the git copy stops) |
| later | Month-scoped payload (5.8), hubs on `latest` | | |

Migration (from `api/`, `D1_DATABASE_ID` exported, after `node scripts/remote-config.mjs`). First check the target
and the pending list. 0008 must be the only pending migration, otherwise 0006 or 0007 would apply too:

```
! ./node_modules/.bin/wrangler d1 migrations list shindan-navi-events --remote --config ../wrangler.remote.json
! ./node_modules/.bin/wrangler d1 migrations apply shindan-navi-events --remote --config ../wrangler.remote.json
```

There are no secrets. The new bindings and vars (`VOICES_LIMIT`, `VOICES_BREAKER`, `VOICES_CAL_BREAKER`,
`version_metadata`) live in config.

**One new snapshot after cutover (no commit, no deploy):**
1. Grok answers. The lead writes `data/voices/<date>.json` (contract shape, `note` for provenance).
2. The lead validates the player posts through oEmbed: inside the window, on topic, not a sales / video / report /
   shop post, 2+ distinct authors. `reacting_to` is official and may predate the window. Evidence goes to
   `out/voices/<date>/`. `share` counts only validated posts.
3. Copy the file to the owner's data dir; `--export` the backup tarball.
4. `npm run import:voices:remote -- --data <dir> --dates <date> --plan`. Read the review, and note the expected rows
   (≈ 3) and the manifest version.
5. A Fable or GPT-astra review of the plan output (D1 id masked). On high, `-- --yes --plan-file <file>`. Medium or
   low: ask the owner.
6. After about 60 s: `latest` has the date, `/voices/<date>/` answers 200, the sitemap lists it, the previous page
   links it as next.
7. Update the kb note. Until M5, also commit the same file (dual-write) and compare hashes.

**Takedown:** `--remove-topic <id> --plan` → owner OK → `--yes --plan-file` → `--check-removed <id>` → fix the local
files and backups (and, until M5, the committed files) → re-run the check → reply to the requester.

## 11. Risks

- **The freshness rule turns D1 trouble into 503s** on cache misses. That is visible but honest. Cached hits under a
  fresh manifest keep serving.
- **Calendar payload growth** may hit the 250 KB limit within weeks. Section 5.8 needs its own design soon after
  cutover.
- **Loss of the git audit trail after M5.** D1, the sanitized exports, the tarballs and the ledger remain. Time Travel
  is not part of voices recovery.
- **Two renderers become one module plus a static runner on Node.** The browser still renders dialogs client-side
  from the same module, so drift is limited to the `h()` glue, which the semantic tests cover.
- **Worker request quota.** Measured before M4; Workers Paid is the escape hatch.
- **System-font fallback** for rare kanji is visually uneven. It is accepted for launch and measured before anything
  more.

## 12. Open questions for the owner

1. **Stop committing snapshots after M5** (D1, your data dir, sanitized backups and the ledger only)? Recommendation:
   yes.
2. **Commit the official X account allowlist** (`contracts/voices-official-x.json`, public handles)? Recommendation:
   yes. It is the main guard on `reacting_to` once there is no git review.
3. **Worker quota.** `/voices/*` and one home `latest` call per view become Worker invocations (Free: 100k/day).
   Accept, with the 50 % gate before M4, and move to Workers Paid if needed?
4. **Availability over staleness.** On a cache miss when D1 cannot be verified, serve a 503 (never stale content, so
   a takedown cannot reappear). OK?
5. **Fonts.** Accept the system-font fallback for new kanji on voices pages, with no custom chunked faces for now?
6. **Privacy revision at M2** with the plan-dependent 7 / 30-day backup wording. Approve the Japanese text in section 9?
7. **Home after the newest date is emptied** shows the previous date if it is ≤ 7 days old (section 5.4). OK?
8. **Game hubs** read `latest` and drop static topic titles (an edit to game-hub.md). OK?
