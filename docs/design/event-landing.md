# Event landing pages: `/events/<game>/<pref>/` (design)

Status: built dark. Scope approved by the owner 2026-11-20 ("624 event landing pages (new page family) + h1 above
list exception"). Nothing changes on a push until the repo variable `LANDING_ENABLED=1` is set **and** migration
0007 is applied (go-live below).

## URLs

| Path | What |
| --- | --- |
| `/events/<slug>/<pref>/` | 13 games × 48 locations = 624 pages. `<slug>` = `GAMES[].slug` in `api/src/constants.ts` (same slugs as D1 `games` and the planned game hubs). `<pref>` = romaji prefecture (`hokkaido` … `tokyo` … `okinawa`) or `online`. |
| `/events/<slug>/<pref>` | 301 → with the slash. Anything else under `/events/*/*` (unknown slug / pref, upper case, extra segments) falls through to the static 404. |
| `/events/sitemap.xml` | Worker-generated sitemap of the indexable landing pages only. |

Romaji instead of `JP-13`: readable in results and shares; the mapping is a fixed table next to `PREFECTURES`.

## Storage: `api/migrations-pending/0007_landing_pages.sql`

```sql
landing_pages(game_code TEXT, loc TEXT /* JP-01..JP-47 | online */, fetched_at TEXT /* the game's run */,
              built_on TEXT /* JST day the row starts */, days_json TEXT /* {"YYYY-MM-DD": events that day} */,
              events_json TEXT /* compact events, ≤ LANDING_PER_DAY per day */, content_hash TEXT,
              PRIMARY KEY (game_code, loc)) WITHOUT ROWID
```

- One row per (game, location), also for locations with no events (`days_json` `{}`), so the page can say so.
- `days_json` counts every event of the game's run per day for `built_on .. built_on + 28 days`; `events_json` keeps
  at most 8 events per day (same order as the API: `starts_sort`, then id), dropped from the last day backwards
  while the row is over 48 KB (D1 statements must stay under 100 KB). Rendering filters by today's date, so a
  row stays correct (only shorter) until the next import.
- `WITHOUT ROWID` + composite primary key: no secondary index, so 1 written row per row.
- Pending, not in `api/migrations/`: `import:remote -- --yes` applies `api/migrations/` automatically and the
  owner approves this one separately. wrangler applies by name, so 0007 after the live 0008 is fine
  (check with `migrations list` first).

## Importer write path and budget

`planImport` builds the 48 rows of each **accepted game** from that run's full events (the state read has no
event content), hashes them and diffs against `landing_pages(game_code, loc, content_hash)`:

- Writes: ≤ 48 per imported game, **≤ 624 per import** (all 13 games), 0 for a re-run of the same data on the
  same JST day. Reads: +624 (hash state) + ≤ 624 primary-key lookups.
- Table missing (migration not applied): the state read sees `no such table`, the plan skips landing rows and
  prints `landing_pages: table missing (migration 0007 not applied), landing rows skipped`. Events import as before.
- Only the games in the run are rebuilt; rows of other games keep their own `fetched_at` and go stale on their own.

## Worker render and caching

- Routing: only with `LANDING_ENABLED=1`, `remote-config.mjs` adds `"/events/*/*"` and `"/events/sitemap.xml"`
  to `run_worker_first` and the var `LANDING_ENABLED`. Without it the deployed config is unchanged and the Worker
  also refuses the paths (passes them to the assets → same 404 as today).
- Shell: build.py (flag on) writes `dist/_landing.html` (site CSS, brand, corner, footer, the shared
  `src/evrow.html` for the group toggles, noindex by default). The Worker fetches it once per isolate from
  `ASSETS` and fills title, meta, canonical, robots, JSON-LD, crumbs, h1 and the list.
- Rows: `api/src/evrow.ts` is a TypeScript port of `snEv.row / grp / group`; a vitest runs `src/evrow.html` in
  `node:vm` and requires byte-identical HTML for the same fixture events.
- Per miss: 1 D1 row (`SELECT … WHERE game_code = ? AND loc = ?`) plus the shared data-version memo (≤ 1 row per
  isolate per 60 s). Cached in `caches.default` under the events data version + JST date + template hash for 24 h,
  browsers 5 min (`/api/v1/events` pattern). Misses go through `API_LIMIT` / `API_BREAKER` (HTML 429 / 503 with
  `Retry-After`). D1 failure: the last data version keeps cached pages serving; a miss answers 503 noindex.
- Pages show the stored days from today on: day heading with the day's total, rows folded like `/events/`, and
  「この日のN件をすべて見る」 → `/events/?game=G&pref=P&range=custom&from=D&to=D` (`rel=nofollow`) when a day has more.

## SEO rules

- Indexable only when the row exists, has ≥ 1 event from today on, and its `fetched_at` is ≤ 14 days old.
  Otherwise `<meta name="robots" content="noindex">` + `X-Robots-Tag: noindex` (empty state text, status 200;
  no row / table missing → 404).
- `<title>`: `{short}の大会・イベント（{県}）｜トレカカレンダー`; h1 `{県}の{short} 大会・イベント一覧` **above the
  list** (owner-approved exception to the site's h1-in-footer pattern); canonical = the slash URL.
- JSON-LD: BreadcrumbList (トップ › イベントカレンダー › page) + one `Event` per rendered event (max 100): name,
  startDate (date or datetime), endDate, eventStatus (cancelled / postponed / scheduled), eventAttendanceMode,
  location (`Place` + `PostalAddress`, or `VirtualLocation` with the source URL), url = source URL, organizer =
  the venue. No `offers` (fees are often unknown; keeps markup to what the page shows).

## Sitemap

The static build cannot know which pages are indexable (event data is in D1 only, and freshness changes daily), so
the Worker serves `/events/sitemap.xml` from `SELECT game_code, loc, fetched_at, days_json FROM landing_pages`
(624 rows per miss, cached like the pages) with exactly the pages the rule above marks indexable (`lastmod` =
`fetched_at` date). build.py adds `Sitemap: https://shindan-navi.app/events/sitemap.xml` to `robots.txt` only with
the flag on; `dist/sitemap.xml` stays static. Submit the new sitemap in Search Console after go-live.

## Links

- Out: crumbs; 「地図・カレンダーで探す」 → `/events/?game=G&pref=P` (nofollow); the 47 other locations of the game;
  the 12 other games in the same location; the game's 新弾 page `/<slug>/` where one exists (10 of 13).
- In: the sitemap and the cross links. Hub → landing links come with game-hub M4 (`docs/design/game-hub.md` › 10).

## D1 budget (Free: 5M reads / 100k writes per UTC day)

| What | Rows |
| --- | --- |
| Import | writes ≤ 624, reads ≤ 1,248 extra |
| Page miss | 1 (+ shared version memo) |
| Sitemap miss | 624 |
| Worst case per day | 624 pages × every colo × 1 miss (24 h key) ≈ 624 × 300 = 187k reads; realistic (crawlers in a few colos) < 5k |

Every landing request (hit or miss) is a Worker invocation (Free: 100k/day), unlike static assets.

## Tests

- `api/tests/landing.test.ts` (vitest, SQLite with pending migrations): importer rows (budget, byte cap, re-run
  writes 0, missing table skips), routing with the flag off (assets passthrough) and on, 404 / 301, indexable vs
  noindex (0 events, stale), JSON-LD shape, sitemap contents, cache key by version + day, rate-limit, D1 failure.
- `api/tests/evrow.test.ts`: TS rows == `src/evrow.html` rows for fixture events; palette / icon / slug parity with
  `src/events.html` and `scripts/build.py`.
- `tools/verify/landing.mjs`: builds with the flag on, imports SYNTHETIC data into SQLite with 0007, serves through
  `dev-node.mjs`, checks pages and the sitemap over HTTP in both flag states.

## Go-live (owner)

1. Merge (no visible change). 2. After review, `git mv api/migrations-pending/0007_landing_pages.sql
api/migrations/` in a small commit and push. 3. Next import (`import:remote -- --plan`, then `--yes`) applies 0007
and writes the landing rows (plan shows `landing_pages N`). 4. Set repo variable `LANDING_ENABLED=1`, re-run Deploy.
5. Spot-check `/events/onepiece/tokyo/` and `/events/sitemap.xml`; submit the sitemap in Search Console.
Rollback: unset `LANDING_ENABLED` and re-run Deploy (the table can stay).
