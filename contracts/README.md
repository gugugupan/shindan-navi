# Event contracts

Shared by the collectors (`tools/`), the importer and Worker (`api/`) and the `/events/` page. Change only through the lead; every consumer reads from here.

## Data files (`data/events/`, local only)

Event data is **never committed** (owner decision; `/data/events` is in `.gitignore`). Collectors write it on the
operator's machine; `api/scripts/import-events.mjs --target remote` pushes it to D1. D1 is the only shared copy.

```
data/events/<GAME>/<YYYY-MM>.json   array of events (event.schema.json), month = starts_on, sorted by starts_on, starts_at, id
data/events/<GAME>/_run.json        last accepted run (run.schema.json)
```

- `<GAME>` is one of `OPCG`, `UATCG`, `CONAN`, `PTCG`.
- Window for this round: `starts_on` in [2026-11-18, 2027-02-18). Collectors may fetch wider but only write this window.
- A run that fails coverage checks writes nothing under `data/events/`; diagnostics stay in the tool's ignored `out/`.
- Files are pretty-printed with 2-space indent and a trailing newline so they stay easy to inspect and diff locally.
- Never store personal data (players, accounts, organizer contact emails/phones), cookies or profile data.

## Normalization rules

- `id` = `tcgp:<event id>`, `ptcg:<event_holding_id>` or `conan:<fingerprint>`. Same source record → same id across runs.
- `conan:` is provisional: the Takara Tomy event search exposes no event or store id, so the id is a hash of series option, store name, store address and start-time text. A change to any of these yields a new id. Replace it when the source offers a stable key.
- Times: `starts_at` etc. are ISO 8601 with offset (`2026-12-05T13:00:00+09:00`); `timezone` is `Asia/Tokyo` for Japanese venues. Date-only events: `time_precision: "date"`, `starts_at: null`.
- Unknown is `null` / `"unknown"`, never guessed. Hidden fee → `fee_amount: null`. Fee 0 only when the source states free / 0円. Capacity is 定員, not remaining seats.
- `registration_status: "open"` only when the source explicitly says applications are open now; otherwise `unknown`.
- `venue.region_code` is ISO 3166-2:JP (`JP-13` = 東京都); online events have `venue: null`, `attendance_mode: "online"`.
- `group.category`: `tournament` (大会・バトル・CS・ジムバトル), `casual` (交流会・フリー対戦), `teaching` (体験会・ティーチング), `festival` (フェス・大型イベント), else `other` / `unknown`. Keep the source's own series name in `group.name`.

## API (Worker `shindan-navi`, same origin as the site)

All responses JSON with `X-Robots-Tag: noindex` and `X-Content-Type-Options: nosniff`. Sized for the D1 Free plan:
the API accepts exactly what the page sends, ranges are month-shaped, `/events/days` reads a precomputed per-day
table and filtered `/events` scans are capped. Meta is precomputed at import.

```
GET /api/v1/events
  pref=JP-13,JP-14,online   (REQUIRED, 1-5 values: JP-01..JP-47 or online)
  from=YYYY-MM-DD           (required, inclusive; any day)
  until=YYYY-MM-DD          (required, exclusive; must be the 1st of the month after from's month)
  game=OPCG,PTCG            (optional, comma list)
  type=standard_battle,...  (optional, group.event_type_code, at most 20)
  days=weekend|weekday      (optional; by starts_on in Asia/Tokyo)
  limit=50                  (optional; 50 is the only page size)
  cursor=<opaque>           (from next_cursor; must belong to these filters and lie inside from..until)
→ { "events": [Event], "next_cursor": string|null }
   Event = event.schema.json item; order starts_on, starts_at (nulls last), id.
   With game/type/days, the Worker first looks up the next matching days in day_counts and reads only those days, at
   most 200 rows per location; a page may hold fewer than 50 events (rarely none) with a next_cursor; keep following
   it. No count: totals come from /events/days (the page stops a month once that many events arrived).

GET /api/v1/events/days         from must be the 1st of a month and until the 1st of the next (a whole month);
                                pref, game, type, days as for /events
→ { "days": [{ "date": "YYYY-MM-DD", "count": n, "by_game": { "OPCG": n, ... } }] }   only days with count > 0;
   with game=…, by_game lists only the selected games

GET /api/v1/events/meta         no parameters
→ { "games": [{ "code", "name", "slug", "record_count", "fetched_at", "complete", "window": {"from","until"} }],
    "prefectures": [{ "code": "JP-01", "name": "北海道", "count": n }],
    "online": { "count": n },
    "categories": [{ "code", "count" }],
    "types": [{ "game_code", "code", "name", "count" }] }

GET /api/v1/geo                 prefecture guessed from the visitor's IP (Cloudflare request.cf), not stored
→ { "region_code": "JP-13" | null }   null outside Japan or when unknown; Cache-Control: private, no-store

Errors: 400 { "error": "<message>" } for bad or unknown parameters (missing pref, more than 5 pref values, a range
that is not month-shaped, limit other than 50, a forged cursor, any parameter not listed above such as `?_=`,
`category`, `fee`, `registration`, `mode`). 429 { "error": "too many requests" } and 503 { "error": "busy" }
(Retry-After: 60) when the uncached-request limits trip. Ranges are clamped to the data window (union of the
latest import windows); ranges wholly outside it answer empty without touching D1.
```

Locations:

- `pref` is a location: a prefecture (`JP-xx`) matches in-person and hybrid events whose venue is in it; `online`
  matches events without a venue (`attendance_mode` online). A hybrid event with a venue is found under its
  prefecture. There is no nationwide query; the page always sends 1-5 locations.

Caching and limits:

- `/events`, `/events/days`, `/events/meta` (GET/HEAD, status 200): stored in the colo's Cache API for 24 hours under
  `<path>?v=<data version>&<canonical query>` (clamped range, lists sorted; meta keyed by path only). Every import
  that changes data writes a new version, so new data is served as soon as an isolate re-reads the version (at most
  60 s). Browsers get `Cache-Control: public, max-age=300` (the edge's `Age` header is dropped) and
  `X-Edge-Cache: hit|miss`.
- When D1 fails, the Worker keeps the last known data version (isolate memo, else a copy in the colo cache under
  `/api/__state`) and retries D1 for it after 5 s, so cached answers keep being served; only misses fail (500).
- Uncached requests only, per Cloudflare location: 20 per minute per client (IPv4 address or IPv6 /64) → 429;
  300 per minute for everyone together → 503 (Workers Rate Limiting bindings `API_LIMIT`, `API_BREAKER`).
- Errors (4xx/5xx) are never cached: `Cache-Control: no-store`. `/api/v1/geo` is `private, no-store`.
- Without the Cache API (Node dev server, tests) every response is `no-store`. Cloudflare documents working Cache API
  operations only for custom domains: on `*.workers.dev` preview URLs assume every request is a miss that reads D1.

Clarifications:

- `meta.games` always lists all four games; a game without data has `record_count: 0`, `fetched_at: null`, `complete: false`, `window: null`.
- `days` include cancelled/postponed events; the page marks them.
- `meta.types[].name` is a short button label maintained in the API per `event_type_code` (e.g. `standard_battle` → スタンダードバトル), not the series name.
- Meta counts are global over each game's latest window, not per current filter; computed by the importer.
- `last_seen_at` in API events is the `fetched_at` of the newest import among the event's games (the collectors
  write the run time there, and storing it per event would rewrite every row on every import).
- Shared events: the same `id` may appear in several game files (e.g. BANDAI CARD GAMES shared series listed under OPCG and UATCG). The importer stores one event with multiple games; `game=` matches any of them. API events carry `game_codes` (all games, sorted) in addition to `game_code` (first of `game_codes`).
- Team events: when the source capacity counts teams, not players, `capacity` is `null` and the source wording goes to `eligibility_text`.
- Sources: OPCG and UATCG come from TCG+ (`tcgp:`), PTCG from players.pokemon-card.com (`ptcg:`), CONAN from the Takara Tomy official event search (https://www.takaratomy.co.jp/products/conan-cardgame/eventsearch; `conan:`, `conan_official`) because the game is not a Bandai title and TCG+ does not list it.
- The page asks `/events/days` per whole month (lazily, as the list reaches each month, and skips months without
  matches), `/events` from the range start (or the 1st) to the end of each month, and cuts both to the selected range
  itself. It waits 300 ms after filter changes before requesting, and loads at most 3 requests per scroll step.

## Getting data into the production D1

Manual, from the operator's machine with the collected files in `data/events/`; CI never imports. No git step:
the guards are the importer's own checks.

```
cd api && D1_DATABASE_ID=<id> npm run import:remote               # validate + first-import estimate; no remote call
cd api && D1_DATABASE_ID=<id> npm run import:remote -- --plan     # read D1, print the per-game review summary and plan
cd api && D1_DATABASE_ID=<id> npm run import:remote -- --yes      # migrate, read, plan, apply if ≤ --max-writes (90,000)
```

Guards (remote target): every file and `_run.json` must pass the schema and consistency checks (a rejected game
blocks the import; `--games` imports the others deliberately); every run must be `complete` unless allowed per game
with `--allow-incomplete CONAN,...`; a game listing over 20% fewer events than D1 currently shows for the same
window is refused unless `--allow-shrink`. The review summary prints per game: fetched_at, source_total, records,
events in D1 now, inserted / updated / unchanged / hidden. The operator reads it in `--plan` and then runs `--yes`.

- The importer diffs against D1 and writes only new/changed events, game-membership changes, new import rows and
  site_meta (also repaired when missing or stale). Nothing is deleted; an unchanged re-import writes nothing.
- `--games` also splits a large load across UTC days. Budget figures are in `api/README.md`.

## Ownership this round

| Path | Owner |
| --- | --- |
| `contracts/` | lead |
| `tools/event-collectors/tcg-plus/`, `data/events/{OPCG,UATCG,CONAN}/` | TCG+ collector |
| `tools/event-collectors/pokemon-players/`, `data/events/PTCG/` | Pokémon collector |
| `api/` (Worker, migrations, importer, tests) | backend |
| `src/events.html`, `scripts/build.py`, `public/events/` | web |
| `docs/` | lead |
