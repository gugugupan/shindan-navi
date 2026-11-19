# 名探偵コナン カードゲーム official event collector

Collects 公認店イベント (チャレンジ戦, ファンミーティング) in Japan from the official Takara Tomy site and
writes `data/events/CONAN/<YYYY-MM>.json` + `_run.json` per `contracts/README.md`.
The game is published by **Takara Tomy** (©青山剛昌／小学館 © TOMY), not Bandai, and is not in BANDAI TCG+.
Read-only: no login, no applications, no consent clicks.

## Run

Needs Node 22. From this directory:

```bash
npm install
npm test                                        # unit tests on a trimmed recorded fixture, no network
node collect.mjs                                # window 2026-11-18 .. 2027-02-18 (half-open); stages output only
node collect.mjs --accept-fingerprint-ids       # same, and replaces data/events/CONAN/
node collect.mjs --from-raw out/run-<ts> [--accept-fingerprint-ids]   # re-normalize saved HTML offline
node spotcheck.mjs out/run-<ts>/CONAN conan:<id> ...                  # re-fetch source_url per event and compare
```

Options: `--from`, `--until`, `--delay-ms` (default 1500, minimum 1000), `--dry-run`, `--note "<text>"` (repeatable, appended to `_run.json` notes),
`--no-geocode`, `--geocode-max <n>` (cap on Google lookups this run).

Every run saves the fetched HTML and the staged files under `out/run-<ts>/` (ignored). `data/events/CONAN/` is only
written with `--accept-fingerprint-ids`, because ids are content fingerprints (see Identity), which the contract
does not allow without the lead's sign-off.

## What it fetches

Two sequential plain HTTPS GETs (no browser needed, no bot protection seen):

1. `https://www.takaratomy.co.jp/products/conan-cardgame/eventsearch?date_from=<from>&date_to=<until-1>` — the
   window. `date_to` is inclusive. The page is server-rendered and unpaginated: one `<li>` in `ul.event_table`
   per event with series (`event_type_name`), store name, address, store phone, `YYYY年M月D日 HH:MM`, `定員N名`
   and a detail table (`参加条件`, `大会形式`, `お知らせ`).
2. The same page without parameters (all currently listed events, ~2.4 MB) as a cross-check.

The `eventtype` select lists the searchable series, one per month (`チャレンジ戦【2026年11月】`). The next month's
series appears when stores' schedules are published, so later weeks of the window are empty until then.

## Coverage

The source states no total, so `complete` is always `false`. The run fails (nothing written) when: the filtered
query returns a row outside the window or of an unlisted series; two rows share a fingerprint; or the filtered
rows differ from the unfiltered list restricted to the window.

Not covered: official one-off events that exist only as article pages under `/event/` (e.g. ペア交流会 2026-11 at
カードラボ stores, 探偵サミット), which have no structured listing.

## Identity

The page carries no event id and no store id (the 店舗情報 link is the store's own X/website, optional).
`external_id = sha1(series option | store name | store address without 〒 | listed start text)[:16]` after NFKC
and whitespace removal; `id = conan:<external_id>`. Same listing → same id across runs; if a store edits its
name, address or start time the event gets a new id and the old one disappears. No collision was seen in the
2,857 rows listed on 2026-11-18. `source_url` is the eventsearch URL filtered by series, store and day, which
returned exactly that one row in the spot-checks.

## Mapping notes

- `group`: `source_id` = series option, `name` = series without `【…】`. チャレンジ戦 → `challenge` / `tournament`;
  ファンミーティング → `fan_meeting` / `casual`; any new series → `event_type_code: null`, `category: unknown`.
- `name` = series option (the page shows no other title). `attendance_mode: in_person`.
- `venue`: the store with its 〒 and address; prefecture → `region_code`; `city` null; `source_id` null.
  An `お知らせ` starting `[外部会場]での開催となります` overrides it with the stated venue: name + address lines,
  or address only (then the store name is kept). `source_status_text` records `external_venue=1|address_only|unparsed`.
- `starts_at` from the listed start; `ends_at`/`ends_on` null (not published).
- `capacity` from `定員N名`. `format_text` = `大会形式`.
- `fee_text` = `参加条件` (mostly purchase conditions). `fee_amount` 0 only for `無料`/`0円`, N for a plain `N円`,
  otherwise null. `参加条件: なし` means "no condition", not "free", so it stays null.
- `registration_*`: unknown/null. Stores describe reception (当日先着, X予約, 抽選) only in free-text notices.
- `event_status: scheduled` for every listed row (the page has no cancellation flag).
- Privacy: store phones and notices are not stored; `参加条件`/`大会形式` are dropped when they contain contact-like
  text, and the run fails if any contact-like text reaches the output.

## Venue geo (optional Google geocoding)

The page has no coordinates, so `venue.geo` comes from Google (`../lib/google-geocode.mjs`) and is cached in
`data/events/.venues/google.json` (contract: `contracts/README.md` › Venue geo). Without `GOOGLE_GEOCODING_API_KEY`
(env or the repo `.env`), or with `--dry-run` / `--no-geocode`, no request is made and venues get the cached geo or
`null`.

Per distinct venue that has no fresh cache entry: Geocoding API (`address`, `region=jp`, `language=ja`,
`components=country:JP`); a `ROOFTOP` / `RANGE_INTERPOLATED` result is used. Otherwise Places API (New) Text Search
with `store name + address` (`precision: PLACES_TEXT_SEARCH`). If that finds nothing, a non-partial `GEOMETRIC_CENTER`
result is kept; `APPROXIMATE` and area results (prefecture, city, ward, postcode) never are. Nothing found → negative
entry, retried after 30 days. Google lat/lng are re-looked-up after 30 days (by the cached `place_id` first) and
events never carry a google geo older than that. A key/quota/billing error stops the pass, keeps what was found and
writes no negative entry for the venue that hit it; the cache is saved every 50 lookups. The geocoding outcome is in
`_run.json` notes. Google results may only be shown on a Google map.

Key setup (owner): in a GCP project with billing, enable Geocoding API and Places API (New); create an API key
restricted to exactly those two APIs, with no application restriction (it runs locally, so no referrer); set a
daily quota and a budget alert. Put it in the repo `.env` as `GOOGLE_GEOCODING_API_KEY=…` (never commit it; it is
separate from the browser Maps key). The 2026-11-19 run had 417 distinct venues (2,139 events), so about that many Geocoding requests on the
first run plus Places requests for the imprecise ones; later runs only look up new or expired venues.
