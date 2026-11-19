# トレカの地図 collector

Fetches the トレカの地図 release schedule (`https://torecamap.co.jp/release-schedule?year=&month=`) for TODAY's
month and the next five (`TORECAMAP_MONTHS`), parses it with `parse_torecamap` (`parse.py`) and writes
`data/releases/torecamap/latest.json` + `_run.json`. Contract: `contracts/releases.md`.

```bash
.venv/bin/python -I tools/release-collectors/torecamap/collect.py [--today YYYY-MM-DD] [--root DIR]
.venv/bin/python -I tools/release-collectors/torecamap/test/test_collect.py
```

- `--today` defaults to the `TODAY` env var, else the local date; `--root` to `data/releases` (git-ignored).
- Records are in parser order (month pages in order, items within a day), deduped by `(date, name)` across months.
  Never sort them: the merge breaks ties by order.
- `_run.json` `pages` has one entry per month URL; `records` is what that page added after dedupe.

## Guards

Exit 1 and leave the previous files untouched when any month page fails to fetch, any page lacks
`NewReleaseScheduleSection_days`, or all months together yield no items. A single empty month is fine.

## Images and prices

`img` is the item's own `<img>` (the one before `ProductInfo_name`), plain `src` or `/_next/image?url=`, absolute
http(s) only; the no-image placeholder and site decoration give `""`. `pack` / `box` are normalized to カードラボ's
form (`6,688円`), `値段設定なし` → `""`. Tests: `test_collect.py` › `Parse`.
