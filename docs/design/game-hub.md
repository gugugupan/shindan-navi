# Game hub: one calendar page per game (design)

Status: design for owner review, 2026-11-20. Nothing here is built. Plan node `game-hub-design`
(kb plan `2026-11-20-seo-1-4-for`).

Owner's ask: "a calendar view per game showing all information related to it". Generic: every game has a code, one
template, the game in the path, and switching to another game only loads that game's data.

## 1. Summary

- One **game registry** (`data/games.json`, committed) replaces the seven hand-kept lists. build.py, the Worker, the
  event importer and every page script read it.
- The hub lives at the game's **slug**: the 10 existing title pages (`/pokemon/` …) become hubs at the same URLs
  (no new duplicate page). `/<code>/` (for example `/opcg/`) answers 301 to the slug. New games get the slug D1
  already has (`/conan/`, `/battlespirits/` …).
- Page: a month calendar for that game. Each day cell carries a release marker, the event count for the player's
  location, and a 話題 marker. A day opens that day's releases / events / topics. Below the calendar: 発売予定,
  今週のイベント, いま話題. A game without events or topics drops that layer and section.
- Releases and topics are static (embedded in the page and in `/<slug>/data.json`). Events come from the existing
  `/api/v1/events/days` and `/events` endpoints, with no new parameter. The month cells use the **unfiltered**
  `/days` key that `/events/` and `/` already use, so switching games within a month costs no extra request.
- Switching games = fetch `/<slug>/data.json` + the new game's week list, then `history.pushState`. A direct load
  gets a full static page with its own title, canonical and JSON-LD.

## 2. Today: where game lists live

| List | Where | Key | Used for |
| --- | --- | --- | --- |
| `GAMES` (10 rows) + `ALIAS`, `TITLE_ALT`, `SLUG` | `scripts/build.py` | release label (`ONE PIECE`) → slug | title pages, sitenav, item-page crumbs |
| `OFFICIAL` (36 rows) | `scripts/build.py` | release label | 公式 links |
| `GAME_ICON` (36 rows) | `scripts/build.py` → `GICON_JS` | display name | `gi()` on every page |
| `GAMES` (8 rows; 13 on `ev-bushi-int`) | `api/src/constants.ts` | `OPCG` + `bit`, `slug` | API validation, `game_mask`, meta |
| `games` table | D1, migrations 0001 / 0005 / 0006 (branch) | `code`, `slug`, `bit`, `sort_order` | `imports.game_code` FK |
| `GAMES` (palette) | `src/events.html`, `EV_GAMES` in `src/home.html` | code + `c` / `cd` | chips, dots, columns |
| `GAMES` (16 rows) | `src/voices.html`; build.py regex-parses it into `VOICE_GAMES` / `VOICE_GAME_INFO` | code + `short`, `c` / `cd` | voices pages, build checks |

They already disagree in small ways: the short name is ワンピカード on title pages and ワンピ on chips; VG is
`ヴァンガード` (release label) and `カードファイト!! ヴァンガード` (API name). The registry keeps each of these as a
named field rather than forcing one spelling.

The 16 voices codes are exactly the 10 main titles + the 6 other event games (CONAN, BS, VG, SVE, HOCG, LLOCG). That
set is the natural hub set (see Q2).

## 3. Game registry

### Where it lives

`data/games.json` (committed; pretty JSON, rows in display order), contract `contracts/games.md`, schema
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
  "colour": { "slot": 1, "light": "#be362d", "dark": "#de837c" },  // null = computed release hue
  "official_url": "https://www.onepiece-cardgame.com/",
  "sources": {
    "releases": ["ONE PIECE"],     // items.json `game` labels (normally just [label])
    "events": { "bit": 1, "sort": 1 },   // null = no events collected
    "voices": true                 // topics may use this code
  },
  "links": { "events_official": null }   // e.g. YGO: KONAMI tournament search (ev-bushi-int link-out)
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
  `gi`, `og`, `fonts`, …), nor may any lowercased code.
- Every `game` in `items.json` must map to a row through `sources.releases`: build.py warns (the data refresh must
  not break), `verify_release.py` fails. The update-data skill already has a "new title label" step; it gains "add a
  registry row".
- An `icon` file must exist in `public/gi/`.

### Consumers

| Consumer | Change |
| --- | --- |
| `scripts/build.py` | `GAMES`, `ALIAS`, `TITLE_ALT`, `SLUG`, `OFFICIAL`, `GAME_ICON` derive from the registry. Page scripts get a `/*GAMES*/` slot with the fields they need (code, label, short, chip, slug, c, cd, bit, icon); `src/events.html`, `src/home.html`, `src/voices.html` drop their literal lists. `VOICE_GAMES` comes from `sources.voices`, no more regex over `voices.html`. |
| `api/src/constants.ts` | `GAMES = registry.filter(g => g.sources.events)` mapped to `{code, name: official, slug, bit}` in `events.sort` order. |
| `api/scripts/lib/importer.mjs` | `GAME_BITS` from the registry. |
| `tools/release-collectors/lib/common.py` | Keeps its source-label map (`ヴァンガ` → `ヴァンガード`; a scraping concern), and a test checks that every target is a registry `label`. |
| `contracts/voices.md`, CLAUDE.md palette table | Point at the registry as the list; the palette table stays as the rationale. |

## 4. URLs and redirects

| Path | What |
| --- | --- |
| `/<slug>/` | Hub. Existing: pokemon onepiece mtg yugioh duelmasters weiss unionarena gundam dragonball digimon. New (Q2): conan battlespirits vanguard shadowverse-evolve hololive lovelive (the slugs already in D1 `games`). |
| `/<slug>/data.json` | The game's static data for client switching (same object the page embeds). |
| `/<code>/` | 301 → `/<slug>/` for every hub game whose lowercased code differs from its slug (`/opcg/`, `/ptcg/`, `/ygo/`, `/dm/`, `/ws/` …). |
| `/events/<slug>/<pref>/` | Planned event landing pages (section 10). Same slug. |

Redirects: build.py writes `dist/_redirects` (Workers static assets and Pages both honour it, static, no Worker
code, no D1). Lines for `/opcg`, `/opcg/`, `/OPCG`, `/OPCG/` (matching is case-sensitive). `#hash` survives a 301 in
browsers; if a platform drops `?m=` on the redirect the hub just opens on its default month (code URLs are typed,
not shared).

Month and day state live in the query and hash so a link is shareable: `/<slug>/?m=2026-12` (month; absent = the
default month) and `#d=2026-12-05` (open day, `replaceState`, as on `/voices/`). Canonical is always `/<slug>/`
without query or hash.

## 5. Page

Template: a new `src/hub.html` (calendar with three layers, not the release app). It shares, like `/events/`
does: `SITE_CSS` and brand from `src/template.html`, `<!--CORNER-->`, `<!--LOCPICK-->`, `/*GICON*/`, `/*GAMES*/`.
Release stars and the add-to-calendar ask move from `src/template.html` into a shared include `src/stars.html`
(slot `<!--STARS-->`) used by both, so `tcg.stars` and the 前日20時 ask stay one implementation.

Top of page follows the owner rules: logo row (tool tabs, corner) and the toolbar only; crumbs, h1 and lead go
**below the calendar** (no exception asked for). No tool tab is marked current (the hub spans all three);
`/releases/`, `/events/`, `/voices/` stay the tools.

### Desktop (≥ 901px)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ [トレカカレンダー]  新弾カレンダー | イベントカレンダー | 話題カレンダー            ⚙  ログイン │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ [▣ ポケカ ▾]   ‹  2026年12月  ›  今日            📍東京都 変更        凡例: 発売 ■ イベント ● 話題 ◆ │
├────────┬────────┬────────┬────────┬────────┬────────┬────────────────────────────────────┤
│ 月      │ 火      │ 水      │ 木      │ 金      │ 土      │ 日                                  │
│ 1       │ 2       │ 3       │ 4       │ 5       │ 6       │ 7                                   │
│         │         │         │         │ ■ 拡張パック│ ● 42    │ ● 38                                │
│ ● 6     │ ● 4     │ ● 5     │ ● 7     │  「熱風の…」│ ◆ 話題 2 │                                     │
│         │         │         │         │ ● 9     │         │                                     │
├────────┼────────┼ … (quiet weekdays stay slim, today gold, as /releases/) ───────────────────┤
└──────────────────────────────────────────────────────────────────────────────────────────┘
 トップ › ポケカ
 ポケモンカードゲーム（ポケカ）新弾・イベントカレンダー            ← h1, muted, below the calendar
 発売予定 2件・次の発売は12/5(金)・東京都のイベント 今月 312件（11/20更新）

 ┌ 発売予定 ─────────────────────┐ ┌ 今週のイベント（東京都）────────┐ ┌ いま話題 ───────────────┐
 │ 12/5(金) 拡張パック「熱風の…」 ☆ │ │ 11/21(土) 13:00 ジムバトル      │ │ ◆ 新弾の当たり枠が話題 🔥3日 │
 │ 1/23(金) スタートデッキ…      ☆ │ │   カードショップ○○ 新宿店       │ │   好意的な声が多い            │
 │ （商品ページへのリンク）          │ │ 11/21(土) 18:00 シティリーグ…   │ │ → 11/20の話題まとめ           │
 │ 新弾カレンダーで見る →          │ │ … 東京都のポケカイベントをすべて → │ │ 話題カレンダーで見る →         │
 └─────────────────────────────┘ └──────────────────────────────┘ └──────────────────────────┘
 都道府県別のポケカイベント: 北海道 青森県 … 沖縄県 オンライン        (static links, section 10)
 ポケカについて (about block, as the title page has today)
 ほかのタイトル: [▣ワンピ] [▣MTG] [▣遊戯王] …                         (static links to the other hubs)
 footer
```

Cell content (desktop): up to 2 release names (gold `■` strip, title-coloured, the rest as `+N`), the event count
`● N` (game colour), `◆ 話題 N` when topics are active that day. Event counts never show without a location.

### Day dialog (both widths)

```
┌ 12月6日(土) ポケカ ───────────────────────── × ┐
│ 発売 (0)            ← section omitted when empty │
│ イベント 42件（東京都）  [大会] [交流会] [体験会]  │
│  13:00 ジムバトル  カードショップ○○ 新宿店   公式 → │
│  …                                              │
│  さらに読み込む   ／  この日を地図で見る (/events/) │
│ 話題 2件                                         │
│  ◆ 新弾の当たり枠が話題  → 話題カレンダーで見る    │
└────────────────────────────────────────────────┘
```

The event rows reuse `/events/`' card markup (section 10: shared include). The map stays on `/events/`
(`この日を地図で見る` → `/events/?pref=…&game=…#…` day view), so the hub never loads Google Maps.

### Mobile (≤ 760px)

```
┌──────────────────────────────┐
│ [ロゴ]                 ⚙  👤 │
│ [▣ ポケカ ▾]  ‹ 12月 ›  今日   │
│ 📍東京都 変更                  │
├──┬──┬──┬──┬──┬──┬──┤
│月│火│水│木│金│土│日│
│1 │2 │3 │4 │5 │6 │7 │
│• │• │• │• │■•│•◆│• │   ■ release  • events  ◆ topics (no numbers)
├──┴──┴──┴──┴──┴──┴──┤
│ 凡例: ■発売 •イベント ◆話題      │
│ トップ › ポケカ                 │
│ ポケモンカードゲーム（ポケカ）…    │  h1 (muted)
│ ▸ 発売予定 (2)                 │
│ ▸ 今週のイベント・東京都 (57)     │
│ ▸ いま話題 (2)                 │
│ 都道府県別のイベント ▸           │  <details>
│ ほかのタイトル ▸                │
├──────────────────────────────┤
│  新弾   │ イベント │  話題        │  bottom tool bar (unchanged)
└──────────────────────────────┘
```

A day tap opens the day dialog as a full-height sheet with 閉じる at the top and bottom (as `/releases/`). Sections
are open by default; the count is in the heading.

### Game switcher

`[▣ ポケカ ▾]` opens a dialog listing every hub game (icon + label + short), each a real `<a href="/<slug>/">`.
Order: registry order. No search box (owner rule). The same list is in the static footer row, so crawlers and
no-JS visitors reach every hub.

### States

| State | Behaviour |
| --- | --- |
| No location saved | Same as `/events/`: ask `/api/v1/geo` (no D1) and preselect the guess, else show 「地域を選ぶと…のイベント数を表示します」 + 都道府県を選ぶ (`snLoc`). No events request until a location exists. The hub writes `pref` to `tcg.ev.filters` only when the player picks (as `/` does). |
| Game without events (MTG, 遊戯王, デュエマ, release-only) | No location control, no event counts, no events section, no events request. 遊戯王 shows the KONAMI official search link-out from `ev-bushi-int` in place of the section. |
| Game without releases in the data window | 発売予定 shows 「現在、発売予定の新弾は掲載していません」 + the latest past release (title-page rule today); the calendar opens on the current month. |
| Releases only, nothing upcoming, no events | Still a hub (static releases + about), but see indexing (section 8). |
| No topics for the game / voices disabled | No ◆ markers, no いま話題 section. Hidden as the home block does once the latest snapshot is > 7 days old (markers on past days stay). |
| Month outside the event window | Cells show no counts; a muted line 「イベント情報は M/D〜M/D」 from the `/days` response being empty and the data window in meta. |
| Location with 0 events this month | Section shows 「東京都のポケカイベントは見つかりませんでした」 + オンライン を見る. |
| API error / rate limited | Releases and topics stay; events area shows 「イベント情報を読み込めませんでした」 + 再読み込み. |

Default month: today's month; if the game has no release, event or topic in it and has a release later, the next
month with a release (title-page rule), with the same note the title pages show today.

## 6. Data loading per source

### Releases and topics (static)

build.py writes one object per hub game:

```jsonc
{ "code": "PTCG", "slug": "pokemon", "updated": "2026-11-20",
  "releases": [ {id, date, name, pack, box, thumb, approx, url} ],   // all of the game's visible items
  "topics": [ {id, title, summary, attitude, volume, status, first_seen, last_seen, snapshot} ],  // voices, real snapshots only
  "head": { "title": "…", "desc": "…" } }                                                         // for pushState
```

Embedded in the page as `const HUB = …;` and published as `/<slug>/data.json` (same bytes; ~2-12 KB). Topics carry
our own text only (no post text, no X URLs, not even `reacting_to`: cards link `/voices/<date>/#topic-<id>`, where
the rules for that link already live). A topic marks days `first_seen`..`last_seen` as on `/voices/`. Sample
snapshots never reach the hub.

### Events (API, unchanged endpoints and parameters)

| Request | When | Cache key shared with | Uncached D1 rows (東京都 / smallest prefs) |
| --- | --- | --- | --- |
| `/events/days?from=M-01&until=M+1-01&pref=P` (no `game`) | load, month change | `/events/` and `/` without a saved game / type filter | ≤ 636 with 8 games (≤ ~1,000 est. with 13) / tens |
| `/events?from=TODAY&until=M+1-01&game=G&pref=P&limit=50` | load (今週のイベント) | `/events/` list and `/` with exactly this one game filtered | ≤ 636 day lookup + ≤ 200 scan ≈ 840 / < 100 |
| + one `/events?from=M+1-01&…` | only when this week crosses the month end and page 1 did not reach day 7 | same | ≈ 840 |
| `/events?from=D&until=M+1-01&game=G&pref=P` (+cursor pages, stop at the day's `by_game[G]`, ≤ 4 pages then link to `/events/`) | day dialog | `/events/` day view with this game | ≤ 840 + 200 per page |
| `/events/meta` | location picker opens (picker counts), freshness line | everyone | 1 |

The cells take `by_game[G]` from the unfiltered `/days` answer. Using `game=G` would read the same day_counts rows
(the index is by location and day) but would create 13× more cache keys and lose the sharing; switching games in the
same month then needs **no** new `/days` request.

Per page view (one location, events game): 2 requests on load, 0 D1 rows when both keys are warm at that colo.
Fully uncached worst case (東京都): ≈ 1,500-1,850 rows. 5M/day allows ~2,700 such views per day even if nothing ever
hit the edge cache; in practice the cache bound applies: per colo and data version at most 48 locations × (≤ 3
months of `/days` + 13 games × 1 week key) ≈ 770 distinct keys, mostly small prefectures; the week key's `from=TODAY`
renews daily. Rough ceiling ~0.3-0.5M rows/day per colo at full key coverage, realistic far less. Section 10 replaces
the week request with 1 row once landing pages exist. Releases-only games: 0 API requests.

`api/README.md` › D1 budget gets a **Game hub** paragraph with these numbers when the events layer ships
(CLAUDE.md: a new page request pattern changes the budget).

## 7. Switching games

1. Click on a switcher / footer link (plain left click, no modifier) is intercepted; anything else navigates.
2. Fetch `/<slug>/data.json` (static, browser-cached) and, if the game has events and a location is set, its week
   list. The month `/days` answer is reused (same key, browser cache 5 min, edge 24 h).
3. Render, then `history.pushState({slug, m}, '', '/<slug>/' + (m ? '?m=' + m : ''))`; set `document.title`, the
   `<link rel=canonical>` and `meta[name=description]` from `head`; announce 「ワンピの表示に切り替えました」 in a
   polite live region; move focus to the month heading.
4. `popstate` re-renders from the cached object for that slug.
5. Any fetch failure → `location.assign('/<slug>/')` (a full load always works).

The month (`?m=`) carries over; an open day dialog closes. Static parts below the calendar (crumbs, h1, about,
都道府県 links, static release list) are re-rendered from `HUB` so the DOM matches what a direct load of that URL
would give. GA: a `page_view` with the new path.

## 8. SEO

- **One page per game.** The hub replaces the title page at the same URL, so there is no second page competing for
  「ポケカ 新弾 発売日」. Month pages `/YYYY-MM/` and `/releases/` stay release-only and unchanged.
- **Title / description** keep the release search terms first (they are what the URL ranks for today) and add the
  new content: 「ポケカ 新弾 発売日・イベント・話題カレンダー（ポケモンカード）｜トレカカレンダー」; description: next
  release + 「店舗大会・ジムバトルの開催日と、プレイヤーの話題もまとめてチェック」 (only the parts the game has).
  h1 「ポケモンカードゲーム（ポケカ）新弾・イベントカレンダー」 (no イベント for games without events).
- **Static HTML** (what a crawler gets): crumbs, h1, lead, the release list with item links (ItemList as now), the
  latest real snapshot's topic titles for the game (as `/voices/`' static list, linking archive cards), 都道府県別
  event links, about block, other hubs. Events stay client-side (location-specific, never in git or the build).
- **JSON-LD**: BreadcrumbList (トップ › ポケカ) + ItemList of releases, exactly the title page's rules (no
  Product / Offer, no Event: Event markup belongs on `/events/<slug>/<pref>/`, which has a fixed location).
- **Canonical** `/<slug>/` always; `?m=` pages are the same document (canonical without query). `/<code>/` 301s.
- **Sitemap**: every indexable hub, `lastmod` = max(newest `changed` of its items, newest real snapshot with a topic
  for the game). Item pages' crumb and "…の新弾をすべて見る" keep pointing at `/<slug>/`.
- **Thin pages**: a hub is indexable only with ≥ 3 releases in the data or a topic in the latest real snapshot or
  events collected for the game; otherwise `noindex,follow` and out of the sitemap (re-evaluated every build).
  CONAN today (1 release, events, 0 topics) passes on events; a hub with nothing but 1 release would not.
- **Internal links**: `/events/` title chips' day lists, `/voices/` cards and archive sections, the home page's
  game columns, and item pages link the game name to its hub.
- OG image: the existing per-title `og/<slug>.png`; new hubs get one from `scripts/og.py` (no topic text).

## 9. Accessibility

- The calendar is a grid with one tab stop per day (roving tabindex; markers `tabindex=-1`), arrow keys move days.
  Each day's accessible name says everything the markers show: 「12月6日(土) 発売1件・イベント42件・話題2件」.
- Markers are `aria-hidden`; colour is never the only cue (■ / ● / ◆ shapes + the legend; counts as text on desktop).
- Game-coloured text is mixed towards black / white for ≥ 4.5:1 in both themes (as `/voices/`); icons stay
  decorative (`gi()`).
- Dialog: `role=dialog`, labelled by its date heading, focus trapped, Esc closes, focus returns to the day.
- Switcher dialog is a list of links; the current game has `aria-current="page"`. Live region for switch and for
  loading / error states of the events area.
- `prefers-reduced-motion`: no sheet animation. Touch targets ≥ 44px on phones; no horizontal scroll at 344-393px.

## 10. Relation to the event landing pages

Planned (`event-design`, approved scope 2026-11-20): Worker-rendered `/events/<game>/<pref>/` (13 games × 48
locations = 624), from precomputed `landing_pages` rows (migration **0007**, written by the importer, ≤ 624 writes
per import, 1 row read per miss), Event JSON-LD, noindex when 0 events or data > 14 days old. Not built.

- **Links.** Hub → landing: the 都道府県別 link row (48 static links, all of them since the build cannot see counts;
  the landing page's own noindex handles empty ones) and 「東京都のポケカイベントをすべて →」 in the week section.
  Landing → hub: breadcrumb トップ › ポケカ › 東京都のイベント, plus 「ポケカの新弾・話題を見る」. Until landing
  pages exist the same links go to `/events/?game=G&pref=P`.
- **Shared data.** Both key on the registry slug; the Worker renderer imports the same `data/games.json` (names,
  colours, icon). The importer that writes `landing_pages` uses registry `bit` / `slug`.
- **Shared read.** A landing row already holds a location's upcoming events for one game. Once it exists, the hub's
  今週のイベント can read it through a strict endpoint (`/api/v1/events/landing?game=G&pref=P`, exactly those two
  params, same version-keyed edge cache): **1 row per miss instead of ≈ 840**. The row must then carry ≥ 7 days of
  events (or the first 50), which the event-build node should design for.
- **Shared code.** The event card markup moves from `src/events.html` into an include (`src/evcard.html`, slot like
  `<!--LOCPICK-->`) used by `/events/`, `/`, the hub, and mirrored in the Worker renderer's TS (one fixture test that
  renders the same event both ways and compares the text).
- Not shared: the landing page is location-scoped and server-rendered; the hub is location-free static HTML plus
  client data. Neither replaces the other.

## 11. Gates to extend

`scripts/verify_release.py`:
- Registry: schema, unique keys, bit/slug immutability vs migrations (also in the Worker test), icon files, every
  items.json label mapped (fail), slugs and lowercased codes free of built paths.
- Hubs: one per `hub: true` row (replaces "expected 10 title pages"; the `/[a-z]+/` regex misses
  `shadowverse-evolve`); title / description unique; canonical; BreadcrumbList + ItemList only, no Event; static
  release list = the game's visible items; `data.json` equals the embedded `HUB`; topics only from real snapshots,
  no X URL at all on hubs; noindex hubs out of the sitemap and indexable ones in it with the lastmod rule above.
- `_redirects`: one 301 per code spelling to an existing hub, no chains, no target outside the hubs.

`tools/verify/browser.mjs` (desktop 1280 and mobile 390, plus the 344-393 width sweep):
- An events game with the dev mock API and a saved location: counts in cells match the mock `by_game`; at most 2
  `/api` requests on load; day dialog lists events and paging stops at the day count.
- A releases-only game (MTG): no `/api` request, no location control.
- No location: `/geo` once, prompt when it returns null, no events request.
- Switching: URL, `document.title`, canonical change; no new `/days` request within the month; Back restores the
  previous game; a modified click opens a new tab (no interception).
- One tab stop per day; dialog focus return; no horizontal overflow; `/opcg/` lands on `/onepiece/`.

## 12. Rollout (each milestone shippable)

| # | Ships | Visible change | Needs |
| --- | --- | --- | --- |
| M0 | Registry: `data/games.json`, contract, build.py / Worker / importer / page scripts read it; migration test | None (dist identical apart from injected lists; gate compares) | — |
| M1 | Hub template for the 10 existing slugs: releases + topics (static), calendar, day dialog, sections, switcher, `data.json`, `/<code>/` redirects, SEO + gates | Title pages become hubs (no events yet) | Owner OK on Q1 |
| M2 | Events layer: location, `/days` counts, 今週のイベント, day events, `src/evcard.html`; D1 budget paragraph | Event counts on the 7 event-game hubs | — |
| M3 | Hubs for CONAN, BS (+ VG, SVE, HOCG, LLOCG after `ev-bushi-int` is live), og images, thin-page rule live | New URLs in the sitemap | Owner OK on Q2; ev-bushi-int merged and imported |
| M4 | Landing-page links both ways; week block from the landing row | 都道府県 links resolve to landing pages | event-build (migration 0007) live |

Each milestone is a worktree branch through the verify-release gate and the ship gate; nothing in M0-M3 writes
to D1 or needs a migration.

## 13. Open questions for the owner

1. **Replace the 10 title pages with hubs at the same URLs?** Recommendation: yes. A second per-game page next to
   `/pokemon/` would split the same searches, and the hub keeps everything the title page has (release list, item
   links, ItemList, the release-first title). The full release app with all titles stays at `/releases/`.
2. **Which games get hubs?** CLAUDE.md says only the 10 main titles get landing pages. Recommendation: the 16 games
   with events or topics today (10 main + CONAN, BS, VG, SVE, HOCG, LLOCG, which have events and topics), each indexable only
   past the thin-page rule. Release-only titles (DIVINE CROSS has 19 releases, more than most main titles) stay
   without a hub for now.
3. **Location without a saved choice: preselect the IP guess (as `/events/`) or ask first (as `/`)?**
   Recommendation: preselect the guess like `/events/`, shown as 「📍東京都（推定） 変更」, and save it only when the
   player confirms or picks. It costs one `/geo` call (no D1) and makes the first view useful.
