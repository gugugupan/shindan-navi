# Pokémon Card players-site event collector

Collects ポケモンカードゲーム events in Japan from the official players site
(`https://players.pokemon-card.com/event/search`) and writes
`data/events/PTCG/<YYYY-MM>.json` + `_run.json` per `contracts/README.md`.
Read-only: no login, no applications, no consent clicks.

## Run

Needs Node 22 and an installed Google Chrome. From this directory:

```bash
npm install
npm test                                   # unit tests on recorded fixtures, no network
node collect.mjs                           # default window 2026-11-18 .. 2027-02-18 (half-open)
node collect.mjs --from 2026-12-01 --until 2027-01-01 --dry-run   # validate only, no data/ write
node collect.mjs --from-raw out/run-<ts>/raw.json                  # re-normalize a saved run offline
```

Options: `--chunk-days` (default 1), `--delay-ms` (default 1000, minimum 750),
`--max-requests` (default 1500, list), `--max-detail-requests` (default 3000, geo pass),
`--geo lookup|cache` (default `lookup`; `cache` only applies the venue cache), `--profile <dir>` (Chrome profile, default
`$PTCG_PROFILE` or `.session/chrome/`), `--headless` (not live-validated), `--note "<text>"` (repeatable, appended to `_run.json` notes).

A full 3-month list run is ~800 sequential requests (~15 min). Chrome opens visibly with a
dedicated profile (ignored). Diagnostics and raw rows go to `out/run-<ts>/` (ignored).

`players.pokemon-card.com/robots.txt` is `User-agent: * Allow: /` with a Content-Signal `ai-train=no`; this collector only
lists events and reads coordinates, no training use.

## What it fetches

- One page load of `/event/search` in Chrome. Plain HTTPS clients (curl / Node) get a Cloudflare
  403 "Sorry, you have been blocked" on every players-site HTML/API path; the normal browser page is
  served with HTTP 200 and no challenge. The collector then issues the same public GET the page itself
  uses, from inside that page: `/event_search?offset=N&order=1&start_date=YYYY/MM/DD&end_date=YYYY/MM/DD`
  (header `X-Accept-Version: v1`). Only that path is allowed by the transport.
- Response: `{code: 200, event: [20 rows], eventCount}`. Page size is fixed at 20 (the site sends no
  `limit`). A range with no events answers HTTP 404 `{code: 404, message: "イベント情報が存在しません。"}`.
- `end_date` is inclusive; `eventCount` is the total for the filters.

## Coverage proof

The window is split into one-day chunks. Each chunk is paged until `offset >= eventCount`, and fails if
`eventCount` changes between pages, a row falls outside the day, or distinct `event_holding_id` != `eventCount`.
The sum of chunk totals must equal the whole-window `eventCount` fetched after the run. Any failure
writes nothing under `data/events/`. `complete: true` therefore means distinct ids == source total.

The source only lists events organizers have already published (roughly 1–2 months ahead), so later
weeks of the window are sparse or empty; that is source state, not missing coverage.

## Venue coordinates (geo pass)

After the list, the collector requests `/event_detail_search?event_holding_id=…&trainers_flg=…&shop_id=…&event_date=…&date_id=…`
(the same call the detail page makes) for **one event per venue** and reads `event.geocoding` (`"lat,lng"`) into
`venue.geo` (`source: "ptcg"`, see `contracts/README.md` › Venue geo). Venue key: `id:<shop_id>` for shop venues,
`fp:<name+address hash>` for events with their own venue. The first full pass is ~2300 requests (≥1 s apart, ~40–60 min);
results are cached in `data/events/.venues/ptcg.json` (saved every 10 lookups and on Ctrl-C), so later runs only look
up new venues, and negative entries are retried after 30 days. An interrupted pass resumes with
`node collect.mjs --from-raw out/run-<ts>/raw.json` (no list requests). A detail 404 tries one more event of the venue;
transport errors leave the venue uncached and three in a row stop the pass (the run still writes, with `geo: null` for
the rest). `--dry-run` never requests details. Coverage is in `_run.json` `query.geo` and the notes.
For own-venue events the detail `geocoding` is assumed to describe the event address (not verified for every row).

## Identity

`id = ptcg:<event_holding_id>`. The detail route is
`/event/detail/:event_holding_id/:trainers_flg/:shop_id/:event_date/:date_id`, and the detail API
(`/event_detail_search`) returns `event.id == event_holding_id`. In the 2026-11-18 full run all 14,398 rows had distinct
`event_holding_id`s. `date_id` is null for the 9 `trainers_flg=0` rows (大型大会: チャンピオンズリーグ, スクランブルバトル),
so it cannot be the key; `trainers_flg=0` ids fall inside the same numeric range as `trainers_flg=1` ids with no collision
observed, but the site never states the two share one id space. If a collision ever appears the run fails (duplicate id check). `source_url` keeps all five segments because the site needs them to render the page.

## Mapping notes

- `group`: official `event_type` (1 大型大会 `major_tournament`, 2 シティリーグ `city_league`,
  3 トレーナーズリーグ `trainers_league`, 4 ジムイベント `gym_event`, 5 キャンペーン `campaign`,
  6 オーガナイザーイベント `organizer_event`, 7 その他 `other`). Labels come from the site bundle.
  ジムバトル is not a separate type: it is a ジムイベント with attribute 真剣勝負.
- `category`: types 1–3 → `tournament`; otherwise attribute `event_attr_id` 3 真剣勝負 → `tournament`,
  1 ルールを教わる → `teaching`, 2 初心者歓迎 / 4 リモートポケカ → `unknown`. Never from the title.
- `attendance_mode`: `in_person`, except リモートポケカ (attr 4) → `unknown`.
- `fee_amount`: `無料` / `0円` → 0; plain `N円` / `¥N` → N; anything else (パック購入, conditional prices) → null with `fee_text` kept.
- `capacity` = list `capacity` (定員). `eligibility_text` = `<オープン|ジュニア|シニア|マスター>リーグ` from `leagueName`, else null.
- `venue.name` = `venue` when set (then `source_id` null, since `shop_id` is the organizer), else the organizer shop. `city` is null (not a separate source field; not parsed from the address).
- `event_status`: `discontinuance_flg` 1 → `cancelled` (the site shows these as canceled), 0 → `scheduled`.
- `registration_*`: `unknown`/null. The list has no application state; the site computes 受付中 etc. client-side
  from per-event detail data (entry dates, lottery flags, counts). Fetching ~14k detail pages is out of scope.
- `ends_at` null when the end time is not after the start time. `ends_on` null (single-day rows).

## Known limits

- Requires a visible Chrome; `--headless` was not tried against Cloudflare.
- Registration status/method/opening times are not collected (see above).
- Only Japan (the players site is Japan-only).
- 大型大会 rows (`trainers_flg=0`) have `entry_fee: null` in the list although the detail page can state 無料; they stay `fee_amount: null`.
- オーガナイザーイベント: the list `event_title` is the organizer's own title (`orgEventTitle`), which is what the detail page shows.

`node spotcheck.mjs ptcg:<id> ...` opens detail pages and compares title/date/time/address/zip/fee/capacity/type/cancel flags.
