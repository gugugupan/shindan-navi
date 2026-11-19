# Official-site collector (and pilot)

Reads release info straight from official TCG sites. `scripts/update_data.py`
reads `data/releases/official/` and imports `run.match` / `run.product_details` from this package.

```bash
.venv/bin/pip install beautifulsoup4 truststore # once (plus fonttools brotli pillow for the rest of the repo)
cp .env.example .env                           # TYPESAFE_API_KEY, OPENROUTER_API_KEY
.venv/bin/python -I tools/release-collectors/official/collect.py [--games pokemon,onepiece] [--today YYYY-MM-DD] [--root DIR]
.venv/bin/python -I tools/release-collectors/official/run.py [--games pokemon,onepiece,mtg] [--adopt-sources]   # pilot report
.venv/bin/python -I tools/release-collectors/official/test/test_collect.py   # no network, no keys
```

**`collect.py`** writes `data/releases/official/latest.json` + `_run.json` (`contracts/releases.md` › Official records):
per `sources.json` key in file order, fetch/extract → `dedupe` → `split_editions` → keep undated or `>= today` →
`classify` (Jev; `NOT_A_PRODUCT` dropped). It does not match against `items.json`; `source` is computed here with
`final_url`, which only knows redirects followed in this process. A failed page (or a failed classify of a title) is
recorded in `pages` / `errors` and the run is written with `complete: false`; zero records refuses and leaves the last
files alone (exit 1). Without both API keys it writes nothing and exits 0. `notes` carry the fetch log, `usage` the
provider ledger. bs4 is only needed for `listing` / `news` pages.

**`run.py`** is the original pilot: same extraction plus matching, writes `out/report-YYYY-MM-DD.md` and
`out/candidates-YYYY-MM-DD.json` here; `--adopt-sources` writes matched official sources into `data/items.json`.
Pages are cached in `cache/` for 6 hours (both scripts).

Division of work:
- **Jev** (TypeSafe `choice` questions): is a news title about a new product; what kind of item is this (booster / deck / set / supply / not a product); is an official entry the SAME product as an existing item.
- **Light LLM** (`OFFICIAL_LLM_MODEL`, default Gemini 3.1 Flash Lite via OpenRouter): extract name, date, price, edition, link and image from listing, set and news pages; pick set pages worth opening.
- **Rules**: dates, prices, edition splitting, de-duplication.

`sources.json` lists the pages per title and how to read them: `pokemon_api` (official JSON product DB), `listing` (product list page; `"follow": "links"` opens the set pages it names), `news` (news index; Jev picks product news, the LLM reads the articles).

## Matching

Every entry gets a `source` (`scripts/sourcekey.py`): canonical official page after redirects + official product code or normalised name. Pairs are made by identity first — product code within the title, then page + key — and only the rest go to Jev, shortlisted by shared official page, then by release date. `--adopt-sources` writes the matched official source back into `data/items.json`; after one adopting run all 15 matches of the pilot pair by identity (Jev 0).

## Pilot results (2026-10-13)

| Title | Existing | Found on official site | Date | Price | Official only |
|---|---|---|---|---|---|
| ポケモンカード | 9 | 9 (100%) | 9/9 | 9/9 | 0 |
| ONE PIECE | 2 | 2 (100%) | 2/2 | 2/2 | 3 (incl. HEROINES PRECIOUS BOX 10/31, missing from our data) |
| MTG | 13 | 4 (31%) | 4/4 | – | 12 |

About $0.016 (OpenRouter) + Jev for these three titles, ~20 s. A full collect over every title in `sources.json` costs
~$0.16 (2026-11-19: OpenRouter 74 calls, ~357k prompt + ~46k completion tokens, $0.158; Jev 29 calls) plus ~$0.0005
for the merge's matching; box-info enrich (`fill_box_info`) adds one light-LLM call per item it reads.

Findings:
- pokemon-card.com's product DB lists upcoming sets once announced; the news index adds things like series logos and figures that the LLM correctly drops.
- MTG English-only products (Bundle, Scene Box, Collector's Edition decks) have their official page on magic.wizards.com, which the pilot does not read yet; add it as a source to pair them.
- MTG misses were mostly matching, not extraction: the official article names products in katakana (スター・トレック) while the aggregators use English (Star Trek), and Jev stays at DIFFERENT (p≈0.6–0.7). Aggregators also merge variants (one 統率者デッキ entry vs four official decks) and split JP/EN where the official article lists one product.
- Two aggregator items are absent from the official article (Draft Night, ビギナー・ボックス — the latter was cancelled), i.e. the official source can catch aggregator mistakes.
