# Game hub: one calendar page per game (design)

Status: M0 (registry) live as 757c623; M1 + M2 live as 8bb04a0; M3 (16 hubs, thin-page rule) M4 (landing links both ways; no week block) and M5 (retitle) on `hub-m3`. Owner answers 2026-11-25: Q1 yes (hubs replace the 10 title pages), Q2 the
16 games (M3), Q3 preselect the IP guess (M2). Revised 2026-11-25 for what changed on `main` since the first draft:
topics live only in D1 (`/api/v1/voices`, no topic text in built HTML, no `/voices/<date>/` archives), event landing
pages and the shared event rows (`src/evrow.html`) exist, `/` has one day view. Plan node `game-hub-design` (kb plan
`2026-11-20-seo-1-4-for`).

Owner's ask: "a calendar view per game showing all information related to it". Generic: every game has a code, one
template, the game in the path, and switching to another game only loads that game's data.

## 1. Summary

- One **game registry** (`data/games.json`, committed) replaces the seven hand-kept lists. build.py, the Worker, the
  event importer and every page script read it.
- The hub lives at the game's **slug**: the 10 existing title pages (`/pokemon/` …) become hubs at the same URLs
  (no new duplicate page), with their current `<title>`, description, h1, crumbs and ItemList unchanged. `/<code>/`
  (for example `/opcg/`) answers 301 to the slug. New games (M3) get the slug D1 already has (`/conan/` …).
- Page: the release calendar for that game, plus each of the game's topics as one bar over its days (M1, owner
  2026-11-25: a timeline, not per-day markers) and (M2) per-type event counts for the player's location. A day opens
  that day's releases / topics / event types. Below the calendar: いま話題, the static release list, about. A game
  without events or topics drops that layer.
- Releases are static (the page embeds them, as title pages do now). **Topics are fetched in the browser** from
  `GET /api/v1/voices`, the URL `/voices/` already uses (same version-keyed edge cache, so no new D1 read pattern);
  the built HTML has no topic text. Event counts (M2) come from one existing `/api/v1/events/days` request per shown
  month (no event rows, no new parameter). With `BUILD_EVENTS=0` (the Pages build) topics and events are left out.
- Switching games is a plain link to the other hub (full load, `?m=` carried). No `/<slug>/data.json`: every page
  already embeds all visible releases, and topics / events are API answers the browser caches.

## 2. Today: where game lists live

| List (before M0) | Where | Key | Used for |
| --- | --- | --- | --- |
| `GAMES` (10 rows) + `ALIAS`, `TITLE_ALT`, `SLUG` | `scripts/build.py` | release label (`ONE PIECE`) → slug | title pages, sitenav, item-page crumbs |
| `OFFICIAL` (38 rows) | `scripts/build.py` | release label | 公式 links |
| `GAME_ICON` (36 rows) | `scripts/build.py` → `GICON_JS` | display name | `gi()` on every page |
| `GAMES` (13 rows) | `api/src/constants.ts` | `OPCG` + `bit`, `slug` | API validation, `game_mask`, meta |
| `LANDING_GAMES` (13 rows) | `api/src/landing.ts` | code + label, short, `c` / `cd`, icon | landing pages |
| `GAME_CODES`, `GAME_BITS` | `api/scripts/lib/importer.mjs` | code + bit | events importer |
| `games` table | D1, migrations 0001 / 0005 / 0006 | `code`, `slug`, `bit`, `sort_order` | `imports.game_code` FK |
| `GAMES` (palette), `LP_GAMES` | `src/events.html` | code + `c` / `cd`, `bit`; code → slug, short | chips, dots, landing links |
| `EV_GAMES`, `SHORT` | `src/home.html` | code + chip, `c` / `cd`, `bit`; label → chip | columns, 表示中 line |
| `GAMES` (16 rows) | `src/voices.html`; build.py and `api/scripts/lib/voices.mjs` regex-parse it | code + `short`, `c` / `cd` | voices pages, home block, voices importer |
| `GAMES` | `scripts/events_dev_server.py` | code, name, slug | dev mock API |
| `gameCode` enum | `contracts/event.schema.json`, `run.schema.json` | code | collectors, importer |

They already disagree in small ways: the short name is ワンピカード on title pages and ワンピ on chips; VG is
`ヴァンガード` (release label) and `カードファイト!! ヴァンガード` (API name). The registry keeps each of these as a
named field rather than forcing one spelling. The HOCG conflict this design expected (ホロライブ vs ホロカ chips) was
resolved on `main` before M0: every chip that uses a short name says ホロカ (and ラブカ), `/events/` chips and columns
use the label ホロライブ everywhere, so M0 changes no visible text. One spelling stays page-specific: the home page's
表示中 line said フュージョンワールド for DBFW while its chips said DBFW; owner 2026-11-25: フュージョンワールド everywhere (registry `chip`, M1).
The release-only label その他 (only in `items-archive.json`) has no row.

The 16 voices codes are exactly the 10 main titles + the 6 other event games (CONAN, BS, VG, SVE, HOCG, LLOCG). That
set is the natural hub set (see Q2).

## 3. Game registry

### Where it lives

`data/games.json` (committed; one row per line, rows in title-page order, then the other events games, then
release-only titles), contract `contracts/games.md`, schema
`contracts/games.schema.json`. It is data, not code, so build.py (Python), the Worker (TS, bundled JSON import via
esbuild), the importer (Node `readFileSync`) and the release collectors can all read one file without generation
steps.

### Row

```jsonc
{
  "code": "OPCG",                  // ^[A-Z][A-Z0-9]{1,7}$, unique, never renamed
  "slug": "onepiece",              // ^[a-z0-9-]+$, unique; null = no hub
  "hub": true,                     // build a hub page
  "label": "ONE PIECE",            // display name = items.json `game` = GAME_ICON key = chip name
  "official": "ONE PIECEカードゲーム",
  "short": "ワンピカード",          // common short name (titles, h1, descriptions)
  "chip": "ワンピ",                 // tight label (voices / home chips)
  "title_alt": "ワンピースカード",   // second name in <title>
  "aliases": ["ワンピースカード", "ワンピカード", "ワンピ"],
  "icon": "opcg.png",              // public/gi/ file or a 1-char monogram
  "colour": { "slot": 1, "light": "#be362d", "dark": "#de837c" },  // null = computed release hue;
                                   // slots 1-14 CLAUDE.md palette, 15 DM / 16 YGO from contracts/voices.md
  "official_url": "https://www.onepiece-cardgame.com/",
  "sources": {
    "releases": ["ONE PIECE"],     // items.json `game` labels (normally just [label])
    "events": { "bit": 1, "sort": 1 },   // null = no events collected
    "voices": true                 // topics may use this code
  },
}
```

Release-only titles (リセ, DIVINE CROSS, Flesh and Blood …) also get a row (code like `LYCEE`, `DCROSS`, `FAB`,
`slug: null`, `hub: false`, `colour: null`), so `OFFICIAL` and `GAME_ICON` fold in and no list stays on the side.
These codes are internal (not in any URL) until a title gets a hub.

### Rules (checked by build.py and a Worker test)

- `code`, `slug`, `label`, `events.bit`, `colour.slot` are unique. `events.bit` is a power of two < 2^30 and **never
  changes** once a migration has written it.
- A Worker vitest test parses `api/migrations/*.sql` `INSERT INTO games` rows and requires each to match the
  registry row's `code`, `slug`, `bit`, `sort_order`, `official` name, and every registry row with `events` to have
  one. Migrations stay hand-written; the test stops the two drifting.
- `slug` must not collide with a built path (`releases`, `events`, `voices`, `item`, `privacy`, `feedback`, `YYYY-MM`,
  `gi`, `og`, `fonts`, `api`, …), nor may any lowercased code.
- Every `game` in `items.json` must map to a row through `sources.releases`: build.py warns (the data refresh must
  not break), `verify_release.py` fails. The update-data skill already has a "new title label" step; it gains "add a
  registry row".
- An `icon` file must exist in `public/gi/`.

### Consumers

| Consumer | Change |
| --- | --- |
| `scripts/build.py` | `GAMES`, `ALIAS`, `TITLE_ALT`, `SLUG`, `OFFICIAL`, `GAME_ICON` derive from the registry. Page scripts get slots with the shape they already read (`/*EV_GAMES*/[]`, `/*LP_GAMES*/{}`, `/*SHORT*/{}`, `/*VOICE_GAMES*/[]`; `name` = label, `short` = chip); `src/events.html`, `src/home.html`, `src/voices.html` drop their literal lists. Voices games come from `sources.voices` (events games in `/events/` order, then the rest), no more regex over `voices.html`. |
| `api/src/constants.ts`, `api/src/landing.ts` | `GAMES` = the events rows in `events.sort` order as `{code, name: official, slug, bit}`; `LANDING_GAMES` from the same rows (bundled JSON import). |
| `api/scripts/lib/importer.mjs`, `voices.mjs` | `GAME_CODES`, `GAME_BITS` and the voices codes from the registry (`readFileSync`). |
| `scripts/events_dev_server.py`, `scripts/verify_release.py` | Dev mock games; hub count and voices codes from the registry. |
| `contracts/event.schema.json`, `run.schema.json` | Keep their `gameCode` enums (JSON Schema cannot import); `api/tests/games.test.ts` holds them equal to the events rows. |
| `tools/release-collectors/lib/common.py` | Keeps its source-label map (`ヴァンガ` → `ヴァンガード`; a scraping concern), and a test checks that every target is a registry `label`. |
| `contracts/voices.md`, CLAUDE.md palette table | Point at the registry as the list; the palette table stays as the rationale. |

## 4. URLs and redirects

| Path | What |
| --- | --- |
| `/<slug>/` | Hub. Existing: pokemon onepiece mtg yugioh duelmasters weiss unionarena gundam dragonball digimon. New (Q2): conan battlespirits vanguard shadowverse-evolve hololive lovelive (the slugs already in D1 `games`). |
| `/<code>/` | 301 → `/<slug>/` for every hub game whose lowercased code differs from its slug (`/opcg/`, `/ptcg/`, `/ygo/`, `/dm/`, `/ws/` …). |
| `/events/<slug>/<pref>/` | Planned event landing pages (section 10). Same slug. |

Redirects: build.py writes `dist/_redirects` (static, no Worker code, no D1). Workers static assets and Pages are
both documented to read it; **to verify on a preview deploy** before relying on it: that both hosts apply it,
whether matching is case-sensitive (if so, lines for `/opcg`, `/opcg/`, `/OPCG`, `/OPCG/`), and whether the query
string survives. `#hash` survives a 301 in browsers. If `?m=` is dropped, the hub just opens on its default month
(code URLs are typed, not shared). Fallback if a host ignores `_redirects`: tiny static `/<code>/index.html` pages
with `<link rel=canonical>` + `<meta http-equiv=refresh>` (not a 301; acceptable for typed URLs).

Month and day state live in the query and hash so a link is shareable: `/<slug>/?m=2026-12` (month; absent = the
default month) and `#d=2026-12-05` (open day, `replaceState`, as on `/voices/`). Canonical is always `/<slug>/`
without query or hash.

## 5. Page

Template: the release app `src/template.html` in hub mode (`PAGE.hub`), not a new file: it already has the one-game
calendar, stars, the 前日20時 add-to-calendar ask, the detail dialog and the table view, so `tcg.stars` stays one
implementation. Hub mode replaces the title chips with the game switcher and adds the topic bars, the day dialog and
いま話題; M2 adds per-type event counts and the location (`<!--LOCPICK-->`) to the same page.

Top of page follows the owner rules: logo row (tool tabs, corner) and the toolbar only; crumbs, h1 and lead go
**below the calendar** (no exception asked for). No tool tab is marked current (the hub spans all three);
`/releases/`, `/events/`, `/voices/` stay the tools.

### Desktop / tablet (≥ 761px)

```
│ [▣ ポケカ ▾]  ‹ 2026年11月 ›  今日  [カレンダー|テーブル]   📍東京都（推定） 変更 (M2)                       │
├──────┬──────┬──────┬──────┬──────┬──────┬──────┤
│ 17    │ 18    │ 19    │ 20    │ 21 1件 │ 22    │ 23    │
│ ┃＋ 新弾の当たり枠が話題 ───────────────────────┃       │       │   one bar per topic (lanes)
│       │ ┃± 禁止改定の賛否 ──────────────────────────────┃   │
│       │       │       │       │ [release card]│       │       │
│ 大会 6 │ 大会 4 │ 大会 5 │ 大会 7 │ 大会 30 体験会 3 ほか 2 │ …   │   per-type counts (M2)
```

- **Topic bars (M1)**, as `/voices/` draws them for one selected game: one bar per topic from `first_seen` to the last
  snapshot that lists it, cut per week (dotted left edge / square right edge where it continues), at most 4 lanes a
  week and 「ほか N件」 under the days of hidden ones; colour = the game's, label = attitude glyph (＋ － ± ・) + the
  title as of the bar's first day (`/voices/` version rule). A bar links `/voices/#t=<id>`. The release cards sit under
  the lanes. Quiet weekdays stay slim unless a bar covers them.
- **Event counts (M2)**: under the cards, the day's counts per event type for this game in the location
  (`by_game_type[G]`), at most 2 named types + 「ほか N」, names from the build-time `TYPE_LABELS` (as `/` has
  `H.types`).

### Phones (≤ 760px)

The release calendar is a day list there, so topics get a compact month timeline above it, like `/voices/`' phone
calendar keeps one mark per game and day: one row per topic active in the month (attitude glyph + title, 11/17〜11/21,
a thin track of the month with the topic's days filled), each row linking `/voices/#t=<id>`. Day sections show the
day's event total (M2); days with events but no release are listed too.

### Day dialog (both widths)

A day number opens it, labelled by its date: that day's releases (cards as today), the topics active that day (cards
with the version rule, links to `/voices/#t=`), and (M2) every event type with its count plus
「イベントカレンダーでこの日を見る」 → the `/events/` day view for this game and location. No event rows.

### Game switcher

`[▣ ポケカ ▾]` opens a dialog listing every hub game (icon + short name), each a real `<a href="/<slug>/">` (the
shown month is added as `?m=` on open). Order: registry order. No search box (owner rule). The footer's タイトル別 row
links every hub too, so crawlers and no-JS visitors reach them.

### States

| State | Behaviour |
| --- | --- |
| Built with `BUILD_EVENTS=0` (Pages host before cutover) | The hub honours `<!--EVENTS-->` like the other pages: no location control, no event counts or legend entry, no events section or dialog part, no `snLoc`, no `/api` call of any kind. |
| Built with `VOICES_ENABLED` off | No `/api/v1/voices` request, no topic bars, no いま話題 section, no link to `/voices/`. |
| No location saved (Q3) | Ask `/api/v1/geo` (no D1) and preselect the guess, shown as 「📍東京都（推定） 変更」; its counts load. Saved to `tcg.ev.filters` `pref` only when the player picks in the shared picker (`snLoc`; picking the guessed one confirms it). No guess: 「📍地域を選ぶ」 and no events request. |
| Game without events (MTG, 遊戯王, デュエマ, release-only) | No location control, no event counts, no events request. |
| Game without releases in the data window | 発売予定 shows 「現在、発売予定の新弾は掲載していません」 + the latest past release (title-page rule today); the calendar opens on the current month. |
| Releases only, nothing upcoming, no events | Still a hub (static releases + about), but see indexing (section 8). |
| Topics loading / API error / malformed answer | Releases render at once and never wait; bars and いま話題 stay hidden (no error box: topics are extra). |
| No topic for the game in the latest snapshot | いま話題 says 「最新のまとめ（M/D）に{short}の話題はありません」 + 話題カレンダーで見る; bars of past topics stay. Hidden once the latest snapshot is > 7 days old (Tokyo date), as the home block. |
| Events loading / API error / 429 / 503 / month outside the event window / no events | Cells show no counts; releases and topics unaffected; no error box (counts are extra). |

Default month: the title-page rule (today's month; if the game has no release in it, the next month with one, else its
latest), with the same note; an events hub with nothing upcoming opens on the current month (as built). A registered hub
is built even with no visible release. Only releases count: the build cannot see topics or events.

## 6. Data loading per source

### Releases (static) and topics (API)

Releases: the page embeds every visible item (`DATA`, as every calendar page does) and filters to the hub's game; the
static list and ItemList are the title page's.

Topics: `GET /api/v1/voices` (all snapshots), the request `/voices/` makes, so it shares that key in the browser and at
the edge (one `SELECT body FROM voice_snapshots` per colo per voices version; no new read pattern for the D1 budget).
The answer is shape-checked as on `/voices/`; the hub keeps the topics with its code. A topic marks days `first_seen`
.. the last snapshot listing it, as on `/voices/`; cards show our title, summary and attitude only and link
`/voices/#t=<id>` (no post text, no X URL, not even `reacting_to`). Takedowns need nothing extra: a topic removed from
D1 leaves every page with the next voices version.

### Events (M2: per-type counts, one request per shown month)

Only with `BUILD_EVENTS=1`, an events game (registry `sources.events`) and a location (saved or IP-guessed):
`GET /api/v1/events/days?from=M-01&until=M+1-01&game=G&pref=P`, the exact query `/events/` sends for its calendar
with this one game selected (and `/` with that saved game filter), so it shares their browser and edge cache keys. The
page reads `by_game_type[G]` per day (answers cached before `by_game_type` existed fall back to `by_game[G]` as a
total). No `/events` row requests, no cursor pages, no `/events/meta`. Uncached cost: ≤ 887 rows (東京都, 13 games;
`api/README.md` › D1 budget), a median prefecture about a fifth; months outside the data window answer empty without
D1. Switching months asks once per month per visit (kept in memory). Crawlers outside Japan get no IP guess and send
no events request. `api/README.md` › D1 budget has a **Game hub** paragraph. Gate before shipping M2: the 7-day
maximum of D1 rows read (Cloudflare dashboard, owner) + projected hub visits × ~900 stays under 2.5M (half the limit).

## 7. Switching games

A switcher or footer link is a plain navigation to `/<slug>/` (`?m=` carries the shown month; an open dialog is not
carried). The first draft's client-side switch (`data.json`, `pushState`, re-rendering the static parts) is dropped:
every hub is a small static page already in the browser cache after a first visit, and a full load keeps the DOM equal
to what crawlers get without a second render path. Revisit only if switching proves slow in practice.

## 8. SEO

- **One page per game.** The hub replaces the title page at the same URL, so there is no second page competing for
  「ポケカ 新弾 発売日」. Month pages `/YYYY-MM/` and `/releases/` stay release-only and unchanged.
- **Title / description / h1 unchanged in M1.** The 10 existing pages keep their current `<title>`, description,
  h1, crumbs and static ItemList byte for byte; only the body (calendar, sections) changes, so ranking signals are
  not mixed with a template change. Retitling is a separate later step (M5), shipped alone and watched in Search
  Console for 2-4 weeks: 「ポケカ 新弾 発売日・イベント・話題カレンダー（ポケモンカード）｜トレカカレンダー」, h1
  「ポケモンカードゲーム（ポケカ）新弾・イベントカレンダー」 (only the parts the game has). New hubs (M3) start with
  the same pattern as the title pages. As built (M5): h1 「ポケモンカードゲーム（ポケカ）新弾 発売日・イベント・話題カレンダー」;
  イベント only for events games on builds with the Worker API, 話題 only with `VOICES_ENABLED`; a hub with neither
  (MTG / 遊戯王 / デュエマ with voices off) keeps the title-page wording. og images keep 新弾 発売日カレンダー.
- **Static HTML** (what a crawler gets): crumbs, h1, lead, the release list with item links (ItemList as now), about
  block, other hubs (footer). No topic text (owner 2026-11-21: SEO of topics given up) and no per-prefecture links
  until the landing pages exist (M4). Topics and events are client-side.
- **JSON-LD**: BreadcrumbList (トップ › ポケカ) + ItemList of releases, exactly the title page's rules (no
  Product / Offer, no Event: Event markup belongs on `/events/<slug>/<pref>/`, which has a fixed location).
- **Canonical** `/<slug>/` always; `?m=` pages are the same document (canonical without query). `/<code>/` 301s.
- **Sitemap**: every indexable hub, `lastmod` = newest `changed` of its items (the title-page rule; topics live in D1
  and never move it). Item pages' crumb and "…の新弾をすべて見る" keep pointing at `/<slug>/`.
- **Thin pages** (M3): the rule uses only inputs the build has (items.json, overrides, registry), so it cannot flap
  with D1: **index** with ≥ 3 visible releases or events collected (`sources.events`); **noindex,follow** and out of
  the sitemap with < 2 releases and no events; **in between** (exactly 2 releases, no events) the 10 former title
  pages stay indexed, other hubs noindex. `verify_release.py` warns for every hub in the band. CONAN (1 release,
  events) passes on events. Topics do not count (not in the build). M1 keeps all 10 indexed, as now.
- **Internal links**: `/events/` title chips' day lists, `/voices/` cards and archive sections, the home page's
  game columns, and item pages link the game name to its hub.
- OG image: the existing per-title `og/<slug>.png`; new hubs get one from `scripts/og.py` (no topic text).

## 9. Accessibility

- Each day number is a button and its own tab stop (simplified from a roving tabindex, M1). Its accessible name says
  what the day holds: 「12月6日(土) 発売1件・話題2件・イベント42件」. Topic bars are links (title, attitude and dates in
  their name); counts are text.
- Colour is never the only cue: bars carry the title and an attitude glyph, counts carry the type name.
- Game-coloured text is mixed towards black / white for ≥ 4.5:1 in both themes (as `/voices/`); icons stay
  decorative (`gi()`).
- Dialog: native `<dialog>` labelled by its date heading, Esc closes, focus returns to that day's button (also after
  the topics arrive and the calendar re-renders).
- Switcher dialog is a list of links; the current game has `aria-current="page"`. Live region for switch and for
  loading / error states of the events area.
- `prefers-reduced-motion`: no sheet animation. Touch targets ≥ 44px on phones; no horizontal scroll at 344-393px.

## 10. Relation to the event landing pages

Built, dark behind `LANDING_ENABLED` (`docs/design/event-landing.md`): Worker-rendered `/events/<game>/<pref>/` (13
games × 48 locations = 624), from precomputed `landing_pages` rows (migration **0007**, written by the importer, ≤ 624
writes per import, 1 row read per miss), Event JSON-LD, noindex when 0 events or data > 14 days old.

- **Links, M1-M3.** No static per-prefecture links (48 per hub × 16 hubs ≈ 768 parameter URLs into `/events/`, which
  crawlers render and which would read D1 on every miss). Only one script-generated link, for the visitor's own
  location: 「東京都のイベントを見る →」 → `/events/?game=G&pref=P`.
- **Links, M4.** Hub → landing: a static 都道府県別 row of `/events/<slug>/<pref>/` links (the landing pages read 1
  precomputed row per miss and are noindex when empty), built only with `LANDING_ENABLED=1` (flag-off output
  unchanged). Landing → hub: breadcrumb トップ › ポケカ › 東京都のポケカイベント, plus 「ポケカの新弾発売日・イベントカレンダー →」
  (not 話題: the Worker does not know `VOICES_ENABLED`). The hub has no week section, and reading landing rows from
  the hub (below) would add an endpoint and D1 reads, so M4 ships without it.
- **Shared data.** Both key on the registry slug; the Worker renderer imports the same `data/games.json` (names,
  colours, icon). The importer that writes `landing_pages` uses registry `bit` / `slug`.
- **Shared read.** A landing row already holds a location's upcoming events for one game. Once it exists, the hub's
  day dialog could read upcoming rows through a strict endpoint (`/api/v1/events/landing?game=G&pref=P`, exactly those two
  params, same version-keyed edge cache): **1 row per miss instead of ≈ 890-1,250**. The row must then carry ≥ 7 days of
  events (or the first 50), which the event-build node should design for.
- **Shared code.** The event row renderer is already shared: `src/evrow.html` (`<!--EVROW-->` slot, `window.snEv`) on
  `/events/` and `/`, mirrored by `api/src/evrow.ts` for the landing pages and held equal by a fixture test. The hub
  uses the same include.
- Not shared: the landing page is location-scoped and server-rendered; the hub is location-free static HTML plus
  client data. Neither replaces the other.

## 11. Gates to extend

`scripts/verify_release.py`:
- Registry: schema, unique keys, bit/slug immutability vs migrations (also in the Worker test), icon files, every
  items.json label mapped (fail), slugs and lowercased codes free of built paths.
- Hubs: one per `hub: true` row; title / description unique; canonical; BreadcrumbList + ItemList only, no Event;
  static release list = the game's visible items; no topic text or X URL in the built HTML; the voices URL only with
  `VOICES_ENABLED`; noindex hubs out of the sitemap and indexable ones in it with the lastmod rule above.
- `_redirects` (static check): one 301 per code spelling to an existing hub, no chains, no target outside the hubs.
  The live behaviour (applied on both hosts, case, query) is checked by hand with `curl -sI` on the preview URL in
  M1, because `npm run dev:node` serves `dist/` without `_redirects` and `wrangler dev` does not run on this macOS.
- Build flags: the gate builds and checks the four combinations of `BUILD_EVENTS` × `VOICES_ENABLED`. Events off:
  no location control, no events markup, no `/api` string in the hub script path that can run. Voices off: no
  `/api/v1/voices` and no `/voices/` link in hubs.

`tools/verify/browser.mjs` (desktop 1280 and mobile 390, plus the 344-393 width sweep):
- An events game with a stubbed `/days` and a saved location: cell and day-dialog counts match the stub; exactly the
  `/events/` query; the day link opens the `/events/` day view.
- A releases-only game (MTG): no events request, no location control.
- No location: `/geo` once, 「（推定）」 label, nothing saved; no events request when it returns null.
- Switching: the switcher dialog lists every hub as a link with the shown month; following it loads that hub on that
  month. Topics: bars (lanes, dates) and the day dialog match the served `/api/v1/voices` answer; an API failure leaves
  releases intact.
- Dialog name and focus return; no horizontal overflow at 390 and 1366, light and dark.
- A `BUILD_EVENTS=0` build: no `/api` request on any hub.
- Redirects are not driven here (see above).

## 12. Rollout (each milestone shippable)

| # | Ships | Visible change | Needs |
| --- | --- | --- | --- |
| M0 | Registry: `data/games.json` (13 events games, bits / sort from 0001 / 0005 / 0006), contract, build.py / Worker / importers / page scripts read it; migration test | None (the HOCG chip was settled on `main`; section 2); the gate diffs dist against the previous build | Done on `feat/game-hub` |
| M1 | Hub mode of the release app for the 10 existing slugs: releases (static) + topic timeline bars (`/api/v1/voices`), day dialog, いま話題, switcher, `/<code>/` redirects, gates; titles / h1 / ItemList unchanged | Title pages get the hub body (no events yet) | Owner OK on Q1 (given); redirect check on the preview URL |
| M2 | Per-type event counts: location (saved or IP guess, Q3), one `/events/days` per shown month, counts in cells and the day dialog, link to the `/events/` day view; D1 budget paragraph | Counts on the event-game hubs (OPCG, UATCG, PTCG, GCG, DBFW, DCG, WS) | M2 D1 gate (section 6) |
| M3 | Hubs beyond the 10: CONAN, BS, VG, SVE, HOCG, LLOCG; og images; thin-page rule (two stateless thresholds) | New URLs in the sitemap | Explicit owner answer to Q2 and the CLAUDE.md line "Only the 10 main titles get landing pages for now" updated in the same PR; Bushi Navi games imported |
| M4 | Landing-page links both ways (static 都道府県 row); week block from the landing row | 都道府県 links to `/events/<slug>/<pref>/` | event-build (migration 0007) live |
| M5 | Retitle hubs to 発売日・イベント・話題カレンダー (title, description, h1) | Search snippets | Owner OK; Search Console watched before and after |

Each milestone is a worktree branch through the verify-release gate and the ship gate; nothing in M0-M3 writes
to D1 or needs a migration.

## 13. Open questions for the owner

1. **Replace the 10 title pages with hubs at the same URLs?** Recommendation: yes. A second per-game page next to
   `/pokemon/` would split the same searches, and the hub keeps everything the title page has (release list, item
   links, ItemList, the release-first title). The full release app with all titles stays at `/releases/`.
2. **Which games get hubs?** CLAUDE.md says "Only the 10 main titles get landing pages for now"; M3 waits for your
   answer and updates that line. Recommendation: the 16 games
   with events or topics today (10 main + CONAN, BS, VG, SVE, HOCG, LLOCG, which have events and topics), each indexable only
   past the thin-page rule. Release-only titles (DIVINE CROSS has 19 releases, more than most main titles) stay
   without a hub for now.
3. **Location without a saved choice: preselect the IP guess (as `/events/`) or ask first (as `/`)?**
   Recommendation: preselect the guess like `/events/`, shown as 「📍東京都（推定） 変更」, and save it only when the
   player confirms or picks. It costs one `/geo` call (no D1) and makes the first view useful.
