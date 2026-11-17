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

## Local API (Worker, `wrangler dev --local`)

All responses JSON, `Cache-Control: no-store` locally.

```
GET /api/v1/events
  game=OPCG,PTCG            (optional, comma list)
  pref=JP-13,JP-14          (optional; online events are excluded when pref is set)
  from=YYYY-MM-DD           (required, inclusive; starts_on >= from)
  until=YYYY-MM-DD          (required, exclusive; at most 92 days after from)
  category=tournament,...   (optional)
  type=standard_battle,...  (optional, group.event_type_code)
  days=weekend|weekday|0..6 (optional; 0 = Sunday, comma list; by starts_on in Asia/Tokyo)
  fee=free|paid|unknown     (optional, comma list)
  registration=open,...     (optional, registration_status)
  mode=in_person,online     (optional)
  limit=1..200 (default 100)
  cursor=<opaque>
→ { "events": [Event], "next_cursor": string|null, "count": number }
   Event = event.schema.json item; order starts_on, starts_at (nulls last), id.
   count = exact total matches for the filters (no cap).

GET /api/v1/events/meta
→ { "games": [{ "code", "name", "slug", "record_count", "fetched_at", "complete", "window": {"from","until"} }],
    "prefectures": [{ "code": "JP-01", "name": "北海道", "count": n }],
    "categories": [{ "code", "count" }],
    "types": [{ "game_code", "code", "name", "count" }] }

GET /api/v1/events/days         same filters as /events (no limit/cursor)
→ { "days": [{ "date": "YYYY-MM-DD", "count": n, "by_game": { "OPCG": n, ... } }] }   only days with count > 0

Errors: 400 { "error": "<message>" } for bad params.
```

Clarifications:

- `mode=in_person` and `mode=online` both match `hybrid`. With `pref`, in-person/hybrid events match by venue region; online events are excluded.
- `meta.games` always lists all four games; a game without data has `record_count: 0`, `fetched_at: null`, `complete: false`, `window: null`.
- `count` and `days` include cancelled/postponed events; the page marks them.
- `meta.types[].name` is a short button label maintained in the API per `event_type_code` (e.g. `standard_battle` → スタンダードバトル), not the series name.
- Meta counts are global, not per current filter (no facet counts this round).
- Shared events: the same `id` may appear in several game files (e.g. BANDAI CARD GAMES shared series listed under OPCG and UATCG). The importer stores one event with multiple games; `game=` matches any of them. API events carry `game_codes` (all games, sorted) in addition to `game_code` (first of `game_codes`).
- Team events: when the source capacity counts teams, not players, `capacity` is `null` and the source wording goes to `eligibility_text`.
- Sources: OPCG and UATCG come from TCG+ (`tcgp:`), PTCG from players.pokemon-card.com (`ptcg:`), CONAN from the Takara Tomy official event search (https://www.takaratomy.co.jp/products/conan-cardgame/eventsearch; `conan:`, `conan_official`) because the game is not a Bandai title and TCG+ does not list it.
- The page only sends `days=weekend|weekday`.

## Ownership this round

| Path | Owner |
| --- | --- |
| `contracts/` | lead |
| `tools/tcg-plus/`, `data/events/{OPCG,UATCG,CONAN}/` | TCG+ collector |
| `tools/pokemon-players/`, `data/events/PTCG/` | Pokémon collector |
| `api/` (Worker, migrations, importer, tests) | backend |
| `src/events.html`, `scripts/build.py`, `public/events/` | web |
| `docs/` | lead |
