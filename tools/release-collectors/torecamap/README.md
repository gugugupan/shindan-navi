# トレカの地図 collector

Fetches the トレカの地図 release schedule (`https://torecamap.co.jp/release-schedule?year=&month=`) for TODAY's
month and the next five (`TORECAMAP_MONTHS`), parses it with `parse_torecamap` (`parse.py`, unchanged from
`scripts/update_data.py`) and writes `data/releases/torecamap/latest.json` + `_run.json`. Contract:
`contracts/releases.md`.

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

## Known issues (kept on purpose)

The image and price bugs listed in `contracts/releases.md` › Known issues are still in `parse.py`: real
`cloudfront.net` images are missed, the last item of a month can get `/images/section-title-small.png`, and `pack`
keeps `(税込)` / `値段設定なし`. `test_collect.py` › `KnownIssues` documents them as expected failures; fixing them
is a reviewed behaviour change that recaptures the golden replay.
