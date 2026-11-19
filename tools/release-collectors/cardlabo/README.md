# カードラボ collector

Reads the 日付別 tables of カードラボ's release page and writes them as release records for the merge
(`scripts/update_data.py`). Contract: `contracts/releases.md`.

## Run

From the repo root:

```bash
.venv/bin/python -I tools/release-collectors/cardlabo/collect.py                     # today = TODAY env, else local date
.venv/bin/python -I tools/release-collectors/cardlabo/collect.py --today 2026-11-19 --root /tmp/releases
```

- `--today` — the date the run parses for. Headings carry no year; the parser picks the year (today's, next,
  previous) whose weekday matches. It is also written to `_run.json` `today`, which the merge checks against its own.
- `--root` — output root (default `data/releases`).

## Reads

One page, `https://www.c-labo.jp/special/2028/` (`CLABO_URL`), fetched once. Every row between `id="hatsubai_daily"`
and `id="hatsubai_cate"` is parsed by `parse.py` (`parse_clabo`, unchanged from the updater; the golden replay in
`tools/release-collectors/golden.py` checks that).

## Output

`<root>/cardlabo/latest.json` (records in page order, `src: "clabo"`, `box`/`url`/`img` always `""`) and
`<root>/cardlabo/_run.json` (`record_count`, `complete: true`, one `pages` entry, `unknown_labels` = category labels
missing from `GAME` in `lib/common.py`, kept as-is in `game`). `data/releases/` is git-ignored.

## Failure modes

Exit 1 with `refused: …` on stderr, previous files left untouched:

- the fetch fails (network, HTTP error) or the page is not UTF-8;
- a layout marker (`hatsubai_daily` / `hatsubai_cate`) is missing;
- no records parsed (e.g. headings or table rows changed shape).

An unknown category label is not a failure: add it to `GAME` when it shows up in `unknown_labels`.

## Tests

```bash
.venv/bin/python -I -m unittest discover -s tools/release-collectors/cardlabo/test
```

Uses `test/fixtures/hatsubai-trimmed.html` and a temp output root; no network, nothing under `data/`.
