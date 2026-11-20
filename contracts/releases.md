# Release contracts

How the release calendar's data is refreshed: one collector per source writes normalized records, a merge-only
`scripts/update_data.py` turns them plus `data/items.json` / `data/overrides.json` into the new `items.json`. Mirrors
the event pipeline (`contracts/README.md`). Change only through the lead; collectors and the merge read from here.

```
collect   tools/release-collectors/{cardlabo,torecamap,official}/  → data/releases/<source>/latest.json + _run.json
merge     scripts/update_data.py  (pure: release files + items.json + overrides.json, Jev/LLM only for official matching)
enrich    fill_box_info: box price / packs per box / cards per pack from each item's official page (network + LLM)
then      apply overrides → sort → items.json, meta.json, update-report.md, thumbs → build → verify
```

## Data files (`data/releases/`, local only)

`/data/releases` is git-ignored: an intermediate, rebuilt by every update (like `data/events`). What gets reviewed and
committed is still `data/items.json`, `data/meta.json`, `data/update-report.md` and `public/thumbs/`.

```
data/releases/<source>/latest.json   array of records (release.schema.json), in source page order, NOT sorted
data/releases/<source>/_run.json     the run that wrote latest.json (release-run.schema.json)
```

- `<source>` is `cardlabo`, `torecamap` or `official`.
- JSON with 2-space indent, `ensure_ascii=False`, trailing newline. Write with `lib/output.py`
  (`write_release_files`): it validates the field set, writes `latest.json` then `_run.json` via temp file + rename.
- Record order is the order the parser emits (page order, then items within a day). `combine()` and the matching
  break ties by order, so sorting would change results. Never sort or dedupe in the writer.

## Aggregator records (`cardlabo`, `torecamap`)

Exactly what `parse_clabo` / `parse_torecamap` return today, field for field, so `combine()` and `merge()` run
unchanged on them (`release.schema.json` › `aggregator`):

| field | value |
| --- | --- |
| `date` | `YYYY-MM-DD`. カードラボ headings carry no year: the year (TODAY's, next, previous) whose weekday matches. |
| `game` | display title via `GAME` (`lib/common.py`); an unknown label is kept as-is and listed in `_run.json` `unknown_labels`. |
| `name` | product name, HTML-unescaped, tags stripped, trimmed (トレカの地図 also drops U+200B). |
| `pack` | price text, `""` if none. カードラボ as written (`440円`, `1,650円`); トレカの地図 normalized to the same form (`418円(税込)` → `418円`, `6688円` → `6,688円`, `値段設定なし` → `""`). |
| `box` | トレカの地図 `1BOX：` text, normalized like `pack`; `""` for カードラボ. |
| `url` | トレカの地図 product link (often official), `""` if none / カードラボ. |
| `img` | トレカの地図: the item's own `<img>` (rendered before its name; plain `src` or the `/_next/image?url=` form), absolute http(s) only; `""` if none, a no-image placeholder, relative, or カードラボ. |
| `src` | `"clabo"` (directory `cardlabo`) or `"torecamap"`. Keep these strings: they end up in `items.json` `sources`. |

Scope: カードラボ = every row of the 日付別 (`#hatsubai_daily`) tables on `/special/2028/`; トレカの地図 = TODAY's
month and the next 5 (`?year=&month=`), deduped by `(date, name)`, rendered items only (`ProductInfo_name`). No date
filter in the collector: the merge drops releases older than `KEEP_PAST_DAYS` (30).

Behaviour changes to a parser are separate, reviewed changes: the golden replay
(`tools/release-collectors/test_golden.py`) is expected to differ; `golden.py replay` prints the difference by item
field and report section, and `golden.py capture --rebase` rewrites `expected/` from the kept snapshot.

The merge treats a price that differs only in writing (same yen amount, e.g. `6688円(税込)` vs `6,688円`) as no
change: it takes the new text without a 価格の変更 line. A thumbnail that cannot be saved (not http(s), fetch or
decode fails) is skipped and listed under 画像を取得/差し替え as 画像の取得に失敗; the run goes on.
`save_thumb` writes via a temp file, and files it created are removed again if the run dies before `items.json`
is written. `--thumbs DIR` redirects thumbnails (default `public/thumbs`). A non-dry run with `--data DIR` other than
`data/` must also pass `--thumbs`: the run deletes every thumbnail its items.json does not reference, so another
items.json must never prune `public/thumbs`. `meta.json` is written via temp file + rename like `items.json`.

## Official records (`official`)

The collector runs, per key of `tools/release-collectors/official/sources.json` (in file order): fetch/extract
(`from_pokemon_api` / `from_records` / `from_listing` / `from_news`) → `dedupe` → `split_editions` → keep
`date is None or date >= TODAY` → `classify` (Jev; `NOT_A_PRODUCT` dropped). It does **not** match: `match`,
`fold_official`, `new_from_official`, `same_product_name` / duplicate checks and `--adopt-sources` stay in the merge,
because they need `items.json`. Records (`release.schema.json` › `official`):

| field | value |
| --- | --- |
| `source_key` | sources.json key (`pokemon`, `onepiece`, …). The merge groups by it in this order (`skip_ids` carry across keys). |
| `game` | display title (sources.json `game`). |
| `name` | product name (edition appended by `split_editions`, e.g. `… 日本語版`). |
| `date` / `date_text` | ISO date or `null` (undated → report 公式で発表済み・発売日未定) / the date as written, or `null`. |
| `source_page` | page the entry was read from. |
| `url` / `image` | product link / package image as given by the page, or `null`. Placeholder images are filtered by the merge (`PLACEHOLDER_IMG`), not here. |
| `pack_yen` / `box_yen` | integer yen or `null`. |
| `per_box` / `per_pack` | packs per box / cards per pack, integer 1-999 or `null` (always `null` for `pokemon_api`). |
| `type` | product type text from the page, or `null`. |
| `tentative` | boolean. |
| `editions` | language editions (`[]` when not stated; one element after `split_editions`). |
| `kind` / `kind_p` | Jev class `BOOSTER_PACK` / `DECK` / `PRODUCT_SET_OR_BOX` / `SUPPLY_OR_ACCESSORY` and its probability. |
| `via` | page kind that produced it: `pokemon_api`, `records`, `listing`, `news`. (Today's in-memory `source` string.) |
| `source` | `{url, key, site: "official"}` = `make_source(final_url(url or source_page), name, "official")`, computed **in the collector**: `final_url` only knows redirects followed in the fetching process. The merge's `match()` must use this value instead of recomputing it. |

## `_run.json`

`{source, today, fetched_at, record_count, complete, errors, pages, unknown_labels, notes, usage, games, collector_version}`
(`release-run.schema.json`). `today` is the date the run parsed for (`TODAY` env, else the local date);
`fetched_at` is UTC. `pages` lists every fetch: `{key, game, url, records, error}`. Official `notes` carry today's
「公式サイト取得ログ」 lines and `usage` the provider ledger (`LEDGER.rows`). Official `games` is the run's scope: the
display titles all of whose sources.json keys were read (a `collect.py --games …` run lists only those); `null` for
aggregators.

## Guards

Collectors (exit non-zero and leave the previous files untouched):

- No records, or a layout marker missing: カードラボ `id="hatsubai_daily"` / `id="hatsubai_cate"`; トレカの地図
  `NewReleaseScheduleSection_days` on every month page (a far month may legitimately have no items, so per-month
  item counts are not a guard; zero items over all months is).
- Any page fetch fails (aggregators): today the updater crashes on it; the collector refuses instead.
- `official` writes a partial run (`complete: false`, failed pages in `errors`) because today the updater logs a
  failed page and carries on. Without `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` it exits 0 and writes nothing
  (today's "official: skipped" log line comes from the merge).

Merge (refuses to write anything):

- Required sources `cardlabo` and `torecamap`: both files present, `_run.json` `today == TODAY` (else stale),
  `complete: true`, `record_count == len(latest.json)`, non-empty (today's "abort: empty source").
- `MIN_RATIO`: `len(combine(cardlabo, torecamap)) >= 0.7 ×` items already known from TODAY's month on (unchanged;
  never lowered to get past it).
- `official` is optional: missing or `today != TODAY` → skipped with a log line, as without keys today. An
  incomplete official run is used for the keys it has.
- A title counts as checked by the official step only when today's official run has it in `games` and every page of
  that title has `error: null`. For every other title — all of them when the step does not run (no keys,
  `--no-official`, missing or stale files), titles outside a `--games` run, titles with a failed page — the merge
  keeps what an item already has from the last official run: `official` in `sources` (also for items no aggregator
  lists any more). `source`, `url`, box info and `per_*` are kept by the merge anyway. For checked titles `sources`
  come from this run's matches only, and only checked titles are listed under 公式サイトで確認できなかった今後の商品.
- The official name wins: an item with `official` in `sources` whose name equals its `official_name` keeps that name
  whatever the aggregators call it, whether or not the official step runs. Other items take the aggregator name.
- Source identity first, at any date: `match()` only sees upcoming items, so an official record it leaves unpaired is
  folded into an item of the same title with the same source (page + key, or product code) even when that item's
  date is already past. The merge never creates an official item whose source an item of the title already has. A
  date change from such a fold that crosses TODAY (an item already released per the calendar moving into the future,
  or the reverse) is not applied: it is listed under 公式と既存で発売日が大きく違う for a person.
- The report keeps `unknown_labels` from both aggregator runs (未対応のタイトル名) and the counts from `record_count`.

Enrich (`fill_box_info`) runs after the merge's official step, may use network and the LLM, is skipped without
`OPENROUTER_API_KEY`, and is followed by `apply_overrides`, sort and the 画像なし list, as in today's `main()`.

## `changed` (items.json)

Each item's last-changed date (`YYYY-MM-DD`), the sitemap `lastmod` of its `/item/<id>/` page; calendar pages take the
newest of their items'. Written by `stamp_changed()` just before `items.json` (not in a dry run, so the golden replay is
unaffected):

- TODAY when the item is new or any shown field (`SHOWN`: date, game, name, pack, box, per_box, per_pack, url, thumb,
  approx, after overrides; prices compared by yen amount) or the product code the page shows (`shown_code`: the
  official `source.key` when it is a code, else a code in the name, as `item_code` in build.py) differs from the run's
  starting `items.json`; else kept. `source.url`, `sources` and `official_name` are not shown and move no date.
- Backfill, no invented dates: an item without `changed` (written before the field existed) takes the previous
  `meta.json` `updated`, the date the sitemap already gave it; the build uses `meta.json` `updated` until then.
- An override committed without a merge rerun moves no date (verify WARNs); the next run stamps the change.

## Product decisions kept

Stable ids (`item_id`, never renumbered), `overrides.json` applied but never written, de-duplication by source
identity first (`find_by_source`, official `source`) before name similarity / Jev, official variants listed
separately, releases older than 30 days dropped, upcoming items that vanished from the sources kept and reported.

## Code layout (Python, run with `.venv/bin/python -I` from the repo root)

```
tools/release-collectors/lib/common.py      UA, GAME, fetch, game_name
tools/release-collectors/lib/output.py      write_release_files, Refused, today_iso, RELEASES
tools/release-collectors/cardlabo/parse.py  CLABO_URL, parse_clabo(today, unknown)
tools/release-collectors/torecamap/parse.py TORECAMAP_URL, TORECAMAP_MONTHS, parse_torecamap(today, unknown)
tools/release-collectors/<source>/collect.py   entry point per source (--today, --root)
tools/release-collectors/official/           collect.py, run.py (pilot + match, product_details), common.py, sources.json
tools/release-collectors/golden.py          golden replay: aggregator collectors on the snapshot → merge --no-official
scripts/update_data.py                      merge (+ enrich): --dry-run --no-official --no-enrich --releases DIR --data DIR
```

`python -I` puts neither the cwd nor the script's directory on `sys.path`: every entry script inserts
`tools/release-collectors` itself and imports `lib.common`, `cardlabo.parse`, … as packages (as `update_data.py`
does). Python, not Node, because the parsers, `sourcekey.py`, the official collector and PIL are Python already.

## Known issues

- When the official step is skipped for a title, aggregator date / pack values replace official-backed ones (the
  change is reported under 発売日の変更 / 価格の変更). Planned: hold the official values and report the aggregator
  difference instead.
- No per-source shrink guard: `MIN_RATIO` checks カードラボ + トレカの地図 combined, so one aggregator losing most of
  its rows passes as long as the other makes up the count.

Fixed (reviewed behaviour change, golden rebased): トレカの地図 images from the current
`<img src="https://…cloudfront.net/…">` markup without picking up the page-tail `/images/section-title-small.png`,
and トレカの地図 prices without `(税込)` / `値段設定なし`.
