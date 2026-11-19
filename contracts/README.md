# Event contracts

Release-calendar collectors and merge have their own contract: `releases.md` (run end to end by `scripts/refresh.py`).

Shared by the collectors (`tools/`), the importer and Worker (`api/`) and the `/events/` page. Change only through the lead; every consumer reads from here.

## Data files (`data/events/`, local only)

Event data is **never committed** (owner decision; `/data/events` is in `.gitignore`). Collectors write it on the
operator's machine; `api/scripts/import-events.mjs --target remote` pushes it to D1. D1 is the only shared copy.

```
data/events/<GAME>/<YYYY-MM>.json   array of events (event.schema.json), month = starts_on, sorted by starts_on, starts_at, id
data/events/<GAME>/_run.json        last accepted run (run.schema.json)
data/events/.venues/<source>.json   venue geo cache per geo source (tcgplus, ptcg, google); see "Venue geo"
```

- `<GAME>` is one of `OPCG`, `UATCG`, `CONAN`, `PTCG`, `WS`, `VG`, `SVE`, `HOCG`, `LLOCG`.
- Window for this round: `starts_on` in [2026-11-18, 2027-02-18). Collectors may fetch wider but only write this window.
- A run that fails coverage checks writes nothing under `data/events/`; diagnostics stay in the tool's ignored `out/`.
- Files are pretty-printed with 2-space indent and a trailing newline so they stay easy to inspect and diff locally.
- Never store personal data (players, accounts, organizer contact emails/phones), cookies or profile data.

## Normalization rules

- `id` = `tcgp:<event id>`, `ptcg:<event_holding_id>`, `bnavi:<Bushi Navi event id>` or `conan:<fingerprint>`. Same source record → same id across runs.
- `conan:` is provisional: the Takara Tomy event search exposes no event or store id, so the id is a hash of series option, store name, store address and start-time text. A change to any of these yields a new id. Replace it when the source offers a stable key.
- Times: `starts_at` etc. are ISO 8601 with offset (`2026-12-05T13:00:00+09:00`); `timezone` is `Asia/Tokyo` for Japanese venues. Date-only events: `time_precision: "date"`, `starts_at: null`.
- Unknown is `null` / `"unknown"`, never guessed. Hidden fee → `fee_amount: null`. Fee 0 only when the source states free / 0円. Capacity is 定員, not remaining seats.
- `registration_status: "open"` only when the source explicitly says applications are open now; otherwise `unknown`.
- `venue.geo`: see "Venue geo".
- `venue.region_code` is ISO 3166-2:JP (`JP-13` = 東京都); online events have `venue: null`, `attendance_mode: "online"`.
- `group.category`: `tournament` (大会・バトル・CS・ジムバトル), `casual` (交流会・フリー対戦), `teaching` (体験会・ティーチング), `festival` (フェス・大型イベント), else `other` / `unknown`. Keep the source's own series name in `group.name`.

## Venue geo

`venue.geo` is `null` or `{ lat, lng, source, precision, place_id, geocoded_at }` (`event.schema.json#/definitions/geo`):

| Field | Value |
| --- | --- |
| `lat`, `lng` | Numbers rounded to 6 decimals. Outside Japan bounds (lat 20–46, lng 122–154) → the whole geo is `null`. |
| `source` | `tcgplus` (TCG+ list/detail), `ptcg` (players-site event detail), `google` (Geocoding API, CONAN only), `bushinavi` (Bushi Navi list `place_geo`, x = latitude, y = longitude). |
| `precision` | The source's own accuracy label as text (e.g. Google `location_type`), else `null`. |
| `place_id` | Google place id, else `null`. |
| `geocoded_at` | `YYYY-MM-DD` (Asia/Tokyo) of the lookup; required for `google`, else may be `null`. |

- Every venue carries `geo`; collectors write `geo: null` when there is no usable coordinate, so content hashes stay
  stable. Files written before this field have no `geo`; consumers read that as `null`. Online events keep `venue: null`.
- TCG+: `event_place_geo` (fallback `place_geo`) is `{x, y}` with **x = latitude, y = longitude**.
- PTCG: the event detail field `geocoding` is the string `"lat,lng"`.
- Google: results may only be shown on a Google map. `lat`/`lng` are re-geocoded when older than 30 days. The Worker
  serves a `google` geo only while `geocoded_at` is at most 28 days before today (Asia/Tokyo): `geocoded_at` is a date,
  and answers stay up to 1 day in the edge cache plus 5 minutes in browsers, so no served copy outlives 30 days.
  `place_id` may be kept indefinitely (the cache keeps it to refresh by id).
- Never guess coordinates (no prefecture/city centroids).

### Venue cache (`data/events/.venues/<source>.json`, local only)

The dot directory is skipped by the importer (it reads only non-dot directories under `data/events/` as games).
One file per geo source, pretty JSON (2-space indent, keys sorted, trailing newline), written atomically:

```json
{
  "version": 1,
  "source": "tcgplus",
  "entries": {
    "id:1001": { "name": "…", "address": "…", "geo": { "lat": 35.690921, "lng": 139.700258, "source": "tcgplus", "precision": null, "place_id": null, "geocoded_at": null }, "checked_at": "2026-11-19" },
    "fp:3f2a9c0d1e4b5a67": { "name": "…", "address": null, "geo": null, "checked_at": "2026-11-19" }
  }
}
```

- Key: `id:<venue.source_id>` (TCG+ organizer id, PTCG shop id) when present, else `fp:` + first 16 hex of SHA-1 over
  NFKC-folded, whitespace-collapsed, lower-cased `name`, `address` and `region_code`.
- `geo: null` is a negative entry: the lookup found nothing usable on `checked_at`; it is retried after 30 days, not on
  every run. A `google` entry is looked up again once its geo is expired. Writing the file drops expired google
  lat/lng: such an entry is stored as `geo: null` plus `"place_id": "…"` (refreshed by that id on the next lookup).
- The importer stores a `google` geo whose `geocoded_at` is more than 30 days before the import day as `null` in D1
  (it hashes like no geo, so the next import after expiry rewrites the row).
- `name` / `address` are for review only. Helper: `tools/event-collectors/lib/venue-cache.mjs`
  (`node --test tools/event-collectors/lib/test/*.test.mjs`).

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
    "types": [{ "game_code", "code", "name", "count" }],
    "loc_counts": { "months": ["YYYY-MM", ...], "types": ["event_type_code", ...],
                    "rows": { "JP-13": [game_mask, type_index, month_index, weekend, weekday, ...], "online": [...] } } }
   loc_counts is absent in meta written before it existed; clients fall back to prefectures/online.

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
  prefecture. There is no nationwide query. The API accepts 1-5 locations; the page sends exactly one.

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
- `loc_counts` lets the page compute, per location, what /events/days would total for any game / type / days filter and
  month without a request: the visible events with a location inside the data window, one row per (location,
  exact game_mask, event_type_code, month) with weekend (Sat/Sun) and weekday counts, as a flat list of 5-tuples.
  `type_index` points into `loc_counts.types` (-1 = no type), `month_index` into `loc_counts.months`. A game filter
  matches rows with `game_mask & selected bits` (OPCG 1, UATCG 2, CONAN 4, PTCG 8), so a multi-game event counts once.
- `last_seen_at` in API events is the `fetched_at` of the newest import among the event's games (the collectors
  write the run time there, and storing it per event would rewrite every row on every import).
- Shared events: the same `id` may appear in several game files (e.g. BANDAI CARD GAMES shared series listed under OPCG and UATCG). The importer stores one event with multiple games; `game=` matches any of them. API events carry `game_codes` (all games, sorted) in addition to `game_code` (first of `game_codes`).
- Team events: when the source capacity counts teams, not players, `capacity` is `null` and the source wording goes to `eligibility_text`.
- Sources: OPCG and UATCG come from TCG+ (`tcgp:`), PTCG from players.pokemon-card.com (`ptcg:`), CONAN from the Takara Tomy official event search (https://www.takaratomy.co.jp/products/conan-cardgame/eventsearch; `conan:`, `conan_official`) because the game is not a Bandai title and TCG+ does not list it. WS, VG, SVE, HOCG and LLOCG come from the Bushiroad event search Bushi Navi (`bnavi:`, `bushinavi`; `tools/event-collectors/bushi-navi/`).
- The page asks `/events/days` per whole month (lazily, as the list reaches each month, and skips months without
  matches), `/events` from the range start (or the 1st) to the end of each month, and cuts both to the selected range
  itself. It waits 300 ms after filter changes before requesting, and loads at most 3 requests per scroll step.

## Accounts API (Google login, synced preferences)

Same Worker and origin. Dark until enabled: every `/api/v1/auth/*`, `/api/v1/me*` and `/api/v1/billing/*` route
answers 404 `{ "error": "auth disabled" }` while any of `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`SESSION_SECRET` is unset or the request origin is not `SITE_ORIGIN` (so `*.workers.dev` previews have no login).
Every response of these routes, including redirects and errors, carries `Cache-Control: private, no-store` and is
never put in the Cache API. No CORS headers.

```
GET  /api/v1/auth/google/start?return=<path>   302 to Google (openid email profile, PKCE S256, state, nonce);
                                                sets __Host-sn_oauth (10 min). return: same-origin relative path,
                                                default and fallback "/"
GET  /api/v1/auth/google/callback              Google's redirect target. Success: sets __Host-sn_session and
                                                __Host-sn_user, 302 to the return path. Cancelled or failed: 302 to
                                                the return path (or "/") without session cookies
POST /api/v1/auth/logout                       → 204; deletes the session, clears both cookies
GET  /api/v1/me                                → 200 { "user": { "id", "display_name", "avatar_url", "plan" } }
                                                | 401 { "error": "unauthenticated" } (also clears both cookies)
GET  /api/v1/me/prefs                          → 200 Prefs
PUT  /api/v1/me/prefs                          partial: { "stars"?: { "add"?: [id], "remove"?: [id] },
                                                "event_filters"?: object|null, "ask_calendar"?: value|null }
                                                stars applied server-side; the other keys replaced; null removes
                                                → 200 Prefs (after the change)
POST /api/v1/me/prefs/merge                    once after login: { "stars": [id], "event_filters"?, "ask_calendar"? }
                                                → 200 Prefs (after the merge)
DELETE /api/v1/me                              → 204; deletes the account and everything tied to it, clears cookies
POST /api/v1/billing/webhook                   → 501 (placeholder)

Prefs = { "prefs": { "stars"?: [id], "event_filters"?: object, "ask_calendar"?: boolean|"ask"|"off" },
          "updated_at": { "<key>": "<ISO 8601>" } }      keys absent when never set
```

Values:

- `stars`: item ids `^i[0-9a-f]{10}$` (the client drops legacy `date|name` keys first), at most 2,000, no duplicates;
  order is server order (existing first, new appended).
- `event_filters`: the `/events/` saved filters (`tcg.ev.filters`): an object whose keys are among `game`, `pref`,
  `type`, `days`, `view`, each a string; at most 1 KB as JSON.
- `ask_calendar`: the 「今後は確認しない」 setting: `true`/`false` or `"ask"`/`"off"`.
- Request bodies at most 64 KB. Invalid values → 400 `{ "error": "<message>" }`; nothing is written.

Merge semantics: `stars` = server ∪ client (server order first, capped at 2,000); `event_filters` and `ask_calendar`
keep the server value when one exists, else take the client's. Only changed keys are written.

Cookies (all `Path=/; Secure; SameSite=Lax`, `__Host-` so no `Domain`):

| Cookie | HttpOnly | Lifetime | Content |
| --- | --- | --- | --- |
| `__Host-sn_session` | yes | 180 days, absolute | random session id + HMAC-SHA256 (`SESSION_SECRET`); D1 keeps only sha256 of the id |
| `__Host-sn_user` | no | same as the session | `1`: tells the page to call `/me`; the page clears it on 401 / logout |
| `__Host-sn_oauth` | yes | 10 min, cleared at the callback | signed state, PKCE verifier, nonce, return path |

Client rules:

- Call `/api/v1/me` only when `__Host-sn_user` is present; logged-out visitors make no `/api` calls on `/releases/`.
- Every non-GET request must send `Origin` equal to the site origin (browsers do for `fetch`) and
  `Content-Type: application/json` (also for bodiless logout / DELETE), else 403 `{ "error": "forbidden" }` /
  415 `{ "error": "unsupported media type" }`.
- 429 `{ "error": "too many requests" }` (Retry-After: 60): login start/callback 30/min per client IP (`AUTH_LIMIT`),
  PUT/merge/DELETE 5/min per user (`AUTH_WRITE_LIMIT`), GET `/me` and `/me/prefs` 60/min per session
  (`AUTH_READ_LIMIT`). Batch star toggles (debounce, at most one write every 12 s) rather than one PUT per click.
- A user keeps at most 10 sessions: each login deletes the oldest beyond that (they answer 401).
- On 5xx or a failed write keep local state and fall back to localStorage silently; never log out on 5xx.
- `__Host-` + `Secure` cookies work on `http://localhost` in Chrome, not in Safari.

## Feedback API (`/feedback/` form)

Same Worker and origin. Dark until enabled: answers 404 `{ "error": "feedback disabled" }` while `TURNSTILE_SECRET_KEY`,
`FEEDBACK_TO` or the `FEEDBACK_EMAIL` binding is missing or the origin is not `SITE_ORIGIN` (setup: `api/README.md` ›
Feedback). `Cache-Control: private, no-store`, never cached, no CORS headers.

```
POST /api/v1/feedback      Origin: SITE_ORIGIN, Content-Type: application/json, body ≤ 16 KB
  { "kind": "bug" | "request" | "data" | "other",
    "message": string,          1-2,000 characters after trim (code points); tab/newline allowed, other control
                                characters → 400 "message contains control characters"
    "reply_to"?: string|null,   plain address ≤ 254 ("" = none)
    "page"?: string|null,       same-origin path the visitor came from (?from=), ≤ 512 ("" = none)
    "turnstile": string }       Cloudflare Turnstile token (action "feedback")
  → 202 { "ok": true, "id": "<uuid>" }   stored; the notification mail may still have failed (recorded server-side)
  | 400 invalid body | 403 wrong Origin or Turnstile failed | 413 body too large | 415 not JSON
  | 429 rate limited per client or for everyone (Retry-After: 60) | 503 Turnstile unavailable (Retry-After: 60) | 500 not stored
```

Unknown fields are 400. A logged-in session cookie, if any, links the row to the account (server-side only).

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
| `tools/event-collectors/lib/` | lead |
| `tools/event-collectors/tcg-plus/`, `data/events/{OPCG,UATCG,CONAN}/` | TCG+ collector |
| `tools/event-collectors/pokemon-players/`, `data/events/PTCG/` | Pokémon collector |
| `api/` (Worker, migrations, importer, tests) | backend |
| `src/events.html`, `scripts/build.py`, `public/events/` | web |
| `docs/` | lead |
