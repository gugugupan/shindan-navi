# Bushi Navi event collector

Collects Bushiroad title events in Japan from the official event search Bushi Navi
(`https://www.bushi-navi.com/event`) and writes `data/events/<GAME>/<YYYY-MM>.json` + `_run.json` per
`contracts/README.md`. Read-only: no login, no applications.

| game_code | Title | `game_title_id` |
| --- | --- | --- |
| `WS` | ヴァイスシュヴァルツ | 2 |
| `VG` | カードファイト!! ヴァンガード | 1 |
| `SVE` | Shadowverse EVOLVE | 6 |
| `HOCG` | hololive OFFICIAL CARD GAME | 10 |
| `LLOCG` | ラブライブ！シリーズ オフィシャルカードゲーム | 11 |

Also on Bushi Navi but not collected (add to `GAMES` in `lib/normalize.mjs` plus a contract game code):
ヴァイスシュヴァルツブラウ (7), ヴァイスシュヴァルツロゼ (12), Reバース for you (5), ゴジラ カードゲーム (13),
パルワールド オフィシャルカードゲーム (14), プロ野球カードゲーム ドリームオーダー (8), 五等分の花嫁 カードゲーム (9).
Ids come from `https://api-user.bushi-navi.com/api/masterdata` (`game_title`).

## Run

Needs Node 22. From this directory:

```bash
npm install
npm test                                        # unit tests on a recorded fixture, no network
node collect.mjs                                # all five games, window 2026-11-18 .. 2027-02-18 (half-open)
node collect.mjs --games WS,VG --dry-run        # validate only, no data/ write
node collect.mjs --resume out/run-<ts>          # continue an interrupted run (same --from/--until/--games)
node collect.mjs --from-raw out/run-<ts>/raw.json   # re-normalize a saved run offline (same --from/--until/--chunk-days)
```

Options: `--from`, `--until`, `--games` (comma list), `--chunk-days` (default 7), `--delay-ms` (default 1100,
minimum 1000), `--max-requests` (default 1500), `--note "<text>"` (repeatable, appended to `_run.json` notes), `--out DIR` (where the built files go).

Requests are sequential and at least 1 s apart, with a generic UA (`shindan-navi-event-collector`), no cookies.
429 / 5xx / network errors are retried 3 times with growing waits. A full run of the five games is 5 × 14 week
chunks, about 260 requests (~5 min; 255 on 2026-11-19). Every finished chunk is saved under `out/run-<ts>/chunks/` (ignored), so a failed
run resumes where it stopped; `raw.json` there keeps the fetched rows for re-normalization.
Each run gets its own `out/run-<ts>-<pid>-<random>/`. A saved chunk is reused only when its game, dates and query
match the planned chunk exactly (otherwise it is refetched). Chunks and `raw.json` carry a coverage version:
`--resume` refuses a run holding chunks saved by an older collector (start a fresh run: refetching them would keep the
old `fetched_at`, the import id), and `--from-raw` refuses an older capture. `--dry-run` leaves the built files in the
run directory under `<GAME>/` (`--from-raw` in `out/run-<fetched_at>/`; `--out DIR` overrides either).

`www.bushi-navi.com/robots.txt` is `User-agent: * / Allow:`. The Bushi Navi terms (`/tos`, from
`/api/user/tos`) are member terms: 第7条 reserves all rights in the service's information to Bushiroad and forbids
members to copy or otherwise use it beyond the terms; 第8条(9) forbids members to use external tools Bushiroad has
not approved. The collector does not log in, but republishing event listings is not explicitly permitted.

## What it fetches

`GET https://api-user.bushi-navi.com/api/user/event/list?game_title_id[]=<id>&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&limit=100&offset=N`
with header `X-Accept-Version: v1` (the call the search page makes). Response:
`{success: {code: 200, total, organizer_event_series: [group]}}`. A group is one series at one organizer
(`event_series_id` × `organizer_id`) with its `events` inside the date range; `total` counts groups, not events.
Dates are Asia/Tokyo; `start_date` / `end_date` are inclusive; only events that have not started yet are listed.

## Coverage proof

Per game, the window is split into 7-day chunks. Each chunk is paged until `offset >= total` and fails if `total`
changes between pages (retried twice), a group of another game appears, an event is dated (Asia/Tokyo) outside the
chunk, or distinct group keys != `total`. Event ids must be unique per game. Any failure writes nothing under
`data/events/`. `source_total` is null because the source declares no event count; `complete: true` means every chunk
passed the proof. Chunk totals and event counts are in `_run.json` `query.chunks`.

## Privacy

Rows are reduced to a field whitelist (`lib/collect.mjs`) as they arrive: `organizer_phone_number`,
`organizer_game_title_notes`, event `excerpt` / `title` and every other field never reach disk, `raw.json` included.
Organizers are shops (`organizer_type` 1 店舗) or Bushiroad (2 公式); there are no person-hosted events, so the
venue is the shop name. `buildOutputs` refuses contact-like text (mail, TEL, phone numbers) in the written fields.

## Mapping notes

- `id = bnavi:<event id>`; `source_url` = `https://www.bushi-navi.com/series/<event_series_id>/organizer/<organizer_id>`
  (the public page that lists that series at that shop, anonymous access checked; there is no public per-event page).
- `group`: `event_series_id` / `event_series_title` (e.g. `[WS] 11月度ショップ大会(2026)`); `name` = the series
  title. `category` / `event_type_code` from the series title (`classify` in `lib/normalize.mjs`, first match):
  サイン会 `signing` (other), 体験会 … `teaching`, 交流会 / 対戦会 `meetup` (casual), 発売記念 / パーティー
  `release_event` (other), WGP / グランプリ `grand_prix`, Championship `championship`, CXチャレンジ `cx_challenge`,
  ブルームカップ `bloom_cup`, 限定構築 `limited_format`, 公認店サポート `shop_support`, ショップ大会 / ショップファイト
  `shop_tournament`; else `tournament` with the `series_type` code: 1 公認イベント `shop_event`, 2 公式イベント
  `official_event`, 3 CS大会 `cs`.
- `venue`: `name` = `organizer_name`, `source_id` = `organizer_id`. Official organizers (`ヴァンガード公式` …) are
  named by the building only, i.e. what follows the street number (「東京ビッグサイト 南4ホール」; owner decision
  2026-11-19: never the street address), else by the organizer when the place has none or only a floor
  (`buildingOf`); `source_id` null. Shop events whose `place_geo` is 300 m or more from the organizer's own
  `place_geo` (rented halls, another shop; 21 events on 2026-11-19) are named by the building too, else by the
  address without postcode and prefecture; `source_id` null.
  `address` = `place` (usually without prefecture; a leading 〒 code goes to `postal_code`), `region_*` from
  `pref_code`, `geo` = the event's `place_geo` (`source: "bushinavi"`).
- Times: `start_datetime` is UTC and converted to `+09:00`. `is_start_datetime_hidden` / `is_event_info_hidden` →
  date only. There is no end time.
- `capacity` = `max_join_count` unless hidden; team events (`team_count` > 1) count teams, so `capacity` is null
  and `eligibility_text` says `3人チーム戦（定員N チーム）`.
- Fees (`requirement_type`): 1 参加費無料 → 0; 3 参加費 / 6 参加費（参加賞1パック付） with `entry_fee` > 0 → the
  amount; pack purchase, shopping amount, member prices, tickets → `fee_amount: null` with the label in `fee_text`.
- `registration_method`: `entry_method` 1 先着予約 → `first_come`, 2 / 3 抽選 → `lottery`;
  `is_no_advance_application` → `walk_in` (no platform / URL). `registration_status`: `closed` for `status_id`
  51 / 61 (running / finished), and 21 / 31 for lotteries; otherwise `unknown` (first-come events stay open in 21 /
  31 and the list has no applicant count). `event_status`: `is_canceled` → `cancelled`, 61 → `completed`, else
  `scheduled`. Raw flags in `source_status_text`.
