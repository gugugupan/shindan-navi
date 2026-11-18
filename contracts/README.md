# Event contracts

Shared by the collectors (`tools/`), the importer and Worker (`api/`) and the `/events/` page. Change only through the lead; every consumer reads from here.

## Data files (`data/events/`)

```
data/events/<GAME>/<YYYY-MM>.json   array of events (event.schema.json), month = starts_on, sorted by starts_on, starts_at, id
data/events/<GAME>/_run.json        last accepted run (run.schema.json)
```

- `<GAME>` is one of `OPCG`, `UATCG`, `CONAN`, `PTCG`.
- Window for this round: `starts_on` in [2026-11-18, 2027-02-18). Collectors may fetch wider but only write this window.
- A run that fails coverage checks writes nothing under `data/events/`; diagnostics stay in the tool's ignored `out/`.
- Files are pretty-printed with 2-space indent and a trailing newline so git diffs are reviewable.
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
every events query is bounded by location + date range (`idx_events_loc`), and meta is precomputed at import.

```
GET /api/v1/events
  pref=JP-13,JP-14,online   (REQUIRED, 1-5 values: JP-01..JP-47 or online)
  from=YYYY-MM-DD           (required, inclusive; starts_on >= from)
  until=YYYY-MM-DD          (required, exclusive; at most 92 days after from)
  game=OPCG,PTCG            (optional, comma list)
  category=tournament,...   (optional)
  type=standard_battle,...  (optional, group.event_type_code)
  days=weekend|weekday|0..6 (optional; 0 = Sunday, comma list; by starts_on in Asia/Tokyo)
  fee=free|paid|unknown     (optional, comma list)
  registration=open,...     (optional, registration_status)
  mode=in_person,online     (optional)
  limit=1..200 (default 100)
  cursor=<opaque>
→ { "events": [Event], "next_cursor": string|null }
   Event = event.schema.json item; order starts_on, starts_at (nulls last), id.
   No count: totals come from /events/days (sum of days[].count).

GET /api/v1/events/days         same parameters as /events except limit/cursor
→ { "days": [{ "date": "YYYY-MM-DD", "count": n, "by_game": { "OPCG": n, ... } }] }   only days with count > 0

GET /api/v1/events/meta         no parameters
→ { "games": [{ "code", "name", "slug", "record_count", "fetched_at", "complete", "window": {"from","until"} }],
    "prefectures": [{ "code": "JP-01", "name": "北海道", "count": n }],
    "online": { "count": n },
    "categories": [{ "code", "count" }],
    "types": [{ "game_code", "code", "name", "count" }] }

GET /api/v1/geo                 prefecture guessed from the visitor's IP (Cloudflare request.cf), not stored
→ { "region_code": "JP-13" | null }   null outside Japan or when unknown; Cache-Control: private, no-store

Errors: 400 { "error": "<message>" } for bad or unknown parameters (missing pref, more than 5 pref values,
any parameter not listed above, e.g. a cache-busting `?_=`).
```

Locations:

- `pref` is a location: a prefecture (`JP-xx`) matches in-person and hybrid events whose venue is in it; `online`
  matches events without a venue (`attendance_mode` online). A hybrid event with a venue is found under its
  prefecture. There is no nationwide query; the page always sends 1-5 locations.
- `mode=in_person` and `mode=online` both match `hybrid` (a filter on top of the locations).

Caching:

- `/events`, `/events/days`, `/events/meta` (GET/HEAD, status 200): stored in the colo's Cache API for 24 hours under
  `<path>?v=<data version>&<canonical query>` — lists sorted, `limit` explicit, meta keyed by path only. Every
  import that changes data writes a new version, so new data is served as soon as an isolate re-reads the version
  (at most 60 s). Browsers get `Cache-Control: public, max-age=300` (the edge's `Age` header is dropped) and
  `X-Edge-Cache: hit|miss`.
- Errors (4xx/5xx) are never cached: `Cache-Control: no-store`. `/api/v1/geo` is `private, no-store`.
- Without the Cache API (Node dev server, tests) every response is `no-store`. On `*.workers.dev` (version preview
  URLs) the Cache API stores nothing, so every request is a miss that reads D1.

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
- The page only sends `days=weekend|weekday` and never `mode`.

## Getting data into the production D1

Manual, from a laptop, after the `data/events/` change is reviewed and **committed** (the importer refuses an
untracked, symlinked or dirty data directory for `--plan` / `--yes`); CI never imports.

```
cd api && D1_DATABASE_ID=<id> npm run import:remote                 # validate + first-import estimate; no remote call
cd api && D1_DATABASE_ID=<id> npm run import:remote -- --plan       # read the remote rows, print the exact plan
cd api && D1_DATABASE_ID=<id> npm run import:remote -- --yes        # migrate, read, plan, apply if ≤ --max-writes (90,000)
```

- The importer diffs against the remote rows and writes only new/changed events, game-membership changes, new
  import rows and two site_meta rows. Nothing is deleted; an unchanged re-import writes nothing.
- A game with validation errors blocks the remote import (use `--games` to import the others deliberately; also
  the way to split a large load across UTC days).
- Budget figures are in `api/README.md`.

## Ownership this round

| Path | Owner |
| --- | --- |
| `contracts/` | lead |
| `tools/event-collectors/tcg-plus/`, `data/events/{OPCG,UATCG,CONAN}/` | TCG+ collector |
| `tools/event-collectors/pokemon-players/`, `data/events/PTCG/` | Pokémon collector |
| `api/` (Worker, migrations, importer, tests) | backend |
| `src/events.html`, `scripts/build.py`, `public/events/` | web |
| `docs/` | lead |
