# Game registry contract (`data/games.json`)

One row per title (schema: `games.schema.json`). Every game list of the site comes from it: build.py (title pages,
公式 links, `GAME_ICON`, the page scripts' game lists), the Worker (`api/src/constants.ts` `GAMES`, landing pages), the
events importer (`GAME_CODES`, `GAME_BITS`) and the voices importer (valid topic codes). Design:
`docs/design/game-hub.md` › 3.

## File

- A JSON array, one row per line, rows in registry order: the title pages first in their sitenav order, then the other
  events games in `/events/` order, then release-only titles. The order is used for title pages / sitenav and for the
  voices games after the events games; `/events/` order is `sources.events.sort`.
- Release-only titles also get a row (`slug: null`, `hub: false`, `colour: null`), so no list stays on the side. Their
  codes are internal until a title gets a hub.

## Fields

| Field | Meaning |
| --- | --- |
| `code` | `^[A-Z][A-Z0-9]{1,7}$`, never renamed: D1 `games.code`, voices topics and saved filters hold it. |
| `slug` | `/<slug>/` (title page) and `/events/<slug>/<pref>/`; null = none. |
| `hub` | build.py builds the title page `/<slug>/` (the 10 main titles; owner decision). |
| `label` | Display name = items.json `game` = `GAME_ICON` key = `/events/` chip and column name. |
| `official` | Official name: title pages; for events games D1 `games.name`. |
| `short` | Common short name: title page `<title>` / h1, event landing pages (ワンピカード, コナンカード). |
| `chip` | Tight label: `/` (イベント heading, 表示中 line; there DBフュージョンワールド reads フュージョンワールド) and `/voices/` chips (ワンピ, コナン). |
| `title_alt`, `aliases` | Title page: second name in `<title>`, extra search names. |
| `icon` | `public/gi/` file or a one-character monogram (CLAUDE.md › Game icons); null = first character of the label. |
| `colour` | `{slot, light, dark}`: CLAUDE.md › Event game palette (slots 1-14) and `contracts/voices.md` › Game codes (15 DM, 16 YGO); null = the release calendar's computed hue. |
| `official_url` | 公式 link of the title's releases. |
| `sources.releases` | items.json `game` labels of the title (normally `[label]`). |
| `sources.events` | `{bit, sort}` = D1 `games.bit` / `games.sort_order`; null = no events collected. |
| `sources.voices` | Topics may use this code. |

## Rules

build.py exits on the row rules below; `api/tests/games.test.ts` checks them too, plus the migrations and the event
schemas; `scripts/verify_release.py` fails on an unmapped items.json title; `tools/release-collectors/lib/test_output.py`
checks that every display name of the collectors' `GAME` map has a row.

- `code`, `slug`, `label`, every `sources.releases` label, `events.bit`, `events.sort` and `colour.slot` are unique.
- `events.bit` is a power of two < 2^30 and **never changes** once a migration has written it. Every row with `events`
  equals one `INSERT INTO games` row of `api/migrations/*.sql` (`code`, `official` = name, `slug`, `sort`, `bit`) and
  every such row has a registry row. Migrations stay hand-written; a new events game needs both.
- `contracts/event.schema.json` and `run.schema.json` list exactly the events codes.
- A hub needs `slug`, `short`, `title_alt`, `official`; an events game `slug`, `official`, `short`, `chip`, `colour`;
  a voices game `chip`, `colour`. `label` is in its own `sources.releases`.
- A `slug` or lowercased `code` is not a built path (`releases`, `events`, `voices`, `item`, `privacy`, `feedback`,
  `api`, `fonts`, `YYYY-MM`, the `public/` entries …), and a lowercased code is no other row's slug.
- An `icon` file exists in `public/gi/`.
- Every items.json `game` maps to a row through `sources.releases`: build.py warns (a data refresh still builds),
  `verify_release.py` fails. A new title label in a refresh = add its row.
