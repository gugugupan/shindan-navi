# 話題カレンダー contract (`/voices/`)

What TCG players on X talk about, per game, as a calendar. Static (default): `scripts/build.py` reads the snapshots and
embeds them in `/voices/`; no Worker, no D1. With `VOICES_SOURCE=d1` (Worker build) the same snapshots live in D1
instead: see "D1 mode" below. The page is built only with `VOICES_ENABLED=1` (off by default: no page, no tool
tab, no privacy section, no link anywhere). The data pipeline that writes the snapshots comes later; until then the
only file is a sample.

## Files (`data/voices/`, committed)

```
data/voices/<YYYY-MM-DD>.json   one snapshot (voices.schema.json); the name is its date
```

- `date` = the snapshot date in Asia/Tokyo = `window.to` = the file name. A snapshot covers the posts of a ~3-day window
  ending on that day (`window` dates are inclusive).
- Pretty JSON, 2-space indent, trailing newline, topics in the order the page should list them (busiest first).
- `sample: true` marks hand-made sample data. The page shows it with a サンプル notice, noindex, out of the sitemap.
  As soon as one snapshot without `sample` exists, the build drops every sample snapshot and the page becomes
  indexable and listed in the sitemap.
- Never store post text, players' post URLs or handles, user names, images or any other personal data: only our own
  summaries / paraphrases and, per topic, at most the official post it reacts to (`reacting_to`).
- Owner decision 2026-11-20: the site never links a topic to the individual players who posted. The player posts the
  lead checks while writing a snapshot (X oEmbed: the post exists, falls inside the window, is on topic, is not a
  sales / video / tournament-report / shop post; 2+ distinct authors per topic) are validation evidence kept locally,
  outside git; they are never committed or published. (Git history still holds the first 2026-11-20 snapshot with
  its `posts` field; history is not rewritten.)

## Topic

| Field | Meaning |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9-]{2,63}$`, e.g. `opcg-bonney-ban-pair-speed`. **The same id in every snapshot while the topic continues**; a new topic gets a new id. |
| `game` | A game code, below. |
| `title` | Short label (≤ 40 chars), our words. |
| `summary` | 1-2 sentences in our own words (≤ 160 chars). |
| `attitude` | `positive` / `negative` / `mixed` / `neutral`: the overall tone. |
| `share` | `{positive, negative, neutral}` post counts behind the topic (counts, not weights); the page draws them as a bar. |
| `volume` | `high` / `mid` / `low` (多 / 中 / 少): how much the topic is talked about, relative to the game's usual volume. |
| `voices` | 2-3 short paraphrased opinions (≤ 80 chars each), **never verbatim post text**. May be empty (the sample's UNION ARENA topics have none). |
| `reacting_to` | URL of the official post (the game's / publisher's own X account) the topic reacts to, or `null`; checked via oEmbed like the player posts. The only X link on a card (no embeds). |
| `window` | The snapshot's window (same as the file's). |
| `first_seen` | First day (JST) the topic was seen; stays fixed across snapshots. |
| `status` | `new` (first snapshot with this id), `continuing`, `cooling` (talk is dying down). |
| `source` | `grok-app` (by hand in the Grok app), `openrouter`, `x-api`. |

## Game codes

Every code has a fixed light/dark colour pair in `GAMES`, from the `/events/` game palette (CLAUDE.md › Event game
palette, slots 1-13: `OPCG`, `UATCG`, `CONAN`, `PTCG`, `GCG`, `BS`, `DCG`, `DBFW`, `WS`, `VG`, `SVE`, `HOCG`, `LLOCG`).
The titles without events take the next slots, so `/events/` can adopt the same ones if it ever lists them:

| # | Game | Light | Dark |
| --- | --- | --- | --- |
| 14 | `MTG` | `#534077` | `#8a76b2` |
| 15 | `DM` (デュエル・マスターズ) | `#4d19e6` | `#825eed` |
| 16 | `YGO` (遊戯王OCG) | `#562d29` | `#b46b64` |

15 and 16 were picked (2026-11-20) the palette's way: greedily maximising the worst OKLab ΔE×100 against slots 1-14 in
both themes (normal ≥10.0, simulated protan / deutan ≥5.4), ≥3:1 on white (light) and on `#181b27` (dark).
The list lives in `GAMES` in `src/voices.html`; the build reads the codes from there and
refuses unknown ones. Add a code there (and here) before writing topics for a new game.

## How the page reads it

- A topic is active from `first_seen` to the date of the last snapshot that lists its id. The calendar marks each of
  those days with a chip per game (desktop; bars over the days when one game is selected) or a dot per game (phones).
- For a given day the page shows the topic as the first snapshot on or after that day saw it (else the latest).
- 🆕 新 = `new` (hidden while there is only one snapshot, where every topic is new); 🔥 n日連続 = `continuing`, n = days
  from `first_seen` to the snapshot date, inclusive; 📉 落ち着き = `cooling`.
- Days before the earliest `window.from` / `first_seen` and after the latest snapshot are dimmed (話題データは M/D から).
- `share` is shown as 約N% in 10% steps, rounded by largest remainder so a card's labels add up to 100%.
- Small sample: when `positive + negative + neutral` < 5 (there is no author count in the data, so the post counts in
  `share` stand in for it), the card shows no bar and no percentages, only a tendency phrase from `attitude` (好意的な声が多い / 否定的な声が多い /
  賛否が分かれている / 目立った賛否はない) and 投稿が少ないため、割合は出していません.
- An open day / topic dialog is in the URL hash (`#d=YYYY-MM-DD` / `#t=<id>`, replaced, not a new history entry; cleared
  on close); each card has リンクをコピー (`/voices/#t=<id>`).
- The list view shows every snapshot, newest first, with its topics.
- The page embeds `{snapshots, counts}` as `const V = …;` (`counts` = release counts per title, for the title colours).
  `voices_data()` in `scripts/build.py` returns the same snapshots for other pages; the home page's いま話題 block embeds only the latest real snapshot's
  `{id, game, title, summary, attitude, volume, first_seen}` plus its date and games (`home_voices()`). The block only reads the
  saved title filters (`tcg.voices`, else `tcg.ev.filters`) and never writes them.

## Archive pages (`/voices/<YYYY-MM-DD>/`)

Owner decision 2026-11-20: each real snapshot (not `sample`) gets an indexable static page with our own text, built by
`render_voices_day()` (`src/voices-day.html`). It lists every topic of that snapshot, one section per game in GAMES
order (snapshot order inside a game), as the same cards `/voices/` draws: title, summary, attitude, the estimated
tendency (約N% / the small-sample phrase, rules above), the paraphrased voices and the 反応元の公式投稿 link when there is one
(`rel="nofollow noopener noreferrer"`; never links to players' posts). Never post text, quotes or embeds. Each card links `/voices/#t=<id>`; the page
links `/voices/#d=<date>`, the previous / next real snapshot and `/voices/`. Head: canonical, `og/voices.png`,
BreadcrumbList JSON-LD only; sitemap lastmod = the snapshot date. `/voices/` carries the latest real snapshot's titles as a
static list below the calendar, linking `/voices/<date>/#topic-<id>`. Title and h1 carry the year
(「YYYY年M月D日のTCG話題…」).

Snapshot dates are URLs: never rename a published snapshot file. A topic, or a whole snapshot, may still be removed on a
takedown / deletion request (the privacy page promises deletion): delete the topic from every snapshot file that lists
it (the same id runs across snapshots), or delete the whole file.
The next build drops the card or the page (a removed snapshot answers 404) and its sitemap entry; a snapshot left
without topics counts as removed, and prev / next links skip it.

## Build checks (scripts/build.py)

Refuses: a file whose name, `date` and `window.to` differ; `window.from` > `window.to`; an unknown game code; a duplicate
id inside one snapshot; a topic whose `first_seen` is after the snapshot date; a `reacting_to` that is not an x.com status URL; a `posts`
field (player post URLs are never committed); more than 3 voices; `share` all zero; missing or extra fields. `verify_release.py` checks the built page and
the archive pages (one per real snapshot, none for samples, cards in GAMES order matching the data, no post text or
embeds, no X link but the topics' `reacting_to` on `/voices/` and the archive pages, X links nofollow, canonical, BreadcrumbList only, prev / next, sitemap lastmod); `tools/verify/browser.mjs`
renders each archive page at desktop and mobile width.

## D1 mode (`VOICES_SOURCE=d1`, docs/design/voices-db.md)

Owner decision 2026-11-21. `api/scripts/import-voices.mjs` validates `data/voices/` (every build check above, the
schema, no X URL outside `reacting_to`, and across snapshots: an id keeps `game` and `first_seen`, `new` only on its
first appearance) and writes one D1 row per date (`voice_snapshots.body` = `{date, window, topics}`; samples are never
imported). `/voices/` and the home block fetch `GET /api/v1/voices` / `/api/v1/voices/latest` and render as above;
there are no archive pages in this mode (この日のまとめ opens `/voices/#d=<date>`), and the sitemap lists `/voices/`
only. Takedowns: `import-voices.mjs --remove-topic ID` / `--remove-snapshot DATE` rewrites D1 and the local files.
Data then lives in D1 and in the local files; the committed files are kept until the owner decides otherwise.
