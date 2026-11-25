# 話題カレンダー contract (`/voices/`)

What TCG players on X talk about, per game, as a calendar. The snapshots are committed as files, imported into D1 by
`api/scripts/import-voices.mjs` and served by the Worker (`GET /api/v1/voices`, `/api/v1/voices/latest`;
docs/design/voices-db.md); `/voices/` and the home page's いま話題 fetch them in the browser. The page is built only with
`VOICES_ENABLED=1` on the Worker build (off by default and always off with `BUILD_EVENTS=0`: no page, no tool tab, no
privacy section, no link anywhere).

## Files (`data/voices/`, committed)

```
data/voices/<YYYY-MM-DD>.json   one snapshot (voices.schema.json); the name is its date
```

The files are the importer's input and the backup of what D1 holds; nothing reads them at build time except
`scripts/fonts.py` (glyphs for the `/voices/` font faces).

- `date` = the snapshot date in Asia/Tokyo = `window.to` = the file name. A snapshot covers the posts of a ~3-day window
  ending on that day (`window` dates are inclusive).
- Pretty JSON, 2-space indent, trailing newline, topics in the order the page should list them (busiest first).
- `sample: true` marks hand-made sample data; the importer skips it with a warning, so it never reaches the site.
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

Every code has a fixed light/dark colour pair (registry `colour`), from the `/events/` game palette (CLAUDE.md › Event game
palette, slots 1-13: `OPCG`, `UATCG`, `CONAN`, `PTCG`, `GCG`, `BS`, `DCG`, `DBFW`, `WS`, `VG`, `SVE`, `HOCG`, `LLOCG`).
The titles without events take the next slots, so `/events/` can adopt the same ones if it ever lists them:

| # | Game | Light | Dark |
| --- | --- | --- | --- |
| 14 | `MTG` | `#534077` | `#8a76b2` |
| 15 | `DM` (デュエル・マスターズ) | `#4d19e6` | `#825eed` |
| 16 | `YGO` (遊戯王OCG) | `#562d29` | `#b46b64` |

15 and 16 were picked (2026-11-20) the palette's way: greedily maximising the worst OKLab ΔE×100 against slots 1-14 in
both themes (normal ≥10.0, simulated protan / deutan ≥5.4), ≥3:1 on white (light) and on `#181b27` (dark).
The list is the rows with `sources.voices` of the game registry (`data/games.json`, `contracts/games.md`; the events
games in `/events/` order, then the others); the importer refuses other codes, build.py embeds the codes, names, chips
and colours into `/voices/` and the home block. Add or flag a row there (and the colour here) before writing topics for
a new game.

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
- The page embeds only `{counts, api}` as `const V = …;` (`counts` = release counts per title, for the title colours) and
  fetches the snapshots from `api`; the answer is shape-checked before anything renders, and a failed or malformed
  answer shows an error with 再読み込み. The home page's いま話題 block fetches `/api/v1/voices/latest` once (the game
  palette is embedded as `H.voiceGames`) and stays hidden on any failure. The block only reads the saved title filters
  (`tcg.voices`, else `tcg.ev.filters`) and never writes them.
- The list view's この日のまとめ opens that day on the calendar (`/voices/#d=<date>`). There are no per-day pages: the
  `/voices/<date>/` archive pages of the former static build were removed on 2026-11-22 and answer 404.

## Takedowns

Snapshot files are never renamed. A topic, or a whole snapshot, may be removed on a takedown / deletion request (the
privacy page promises deletion): `cd api && D1_DATABASE_ID=… npm run import:voices -- --remove-topic ID --target remote`
(or `--remove-snapshot DATE`) shows the plan, and the same command with `--yes` removes it from D1 (every date that
lists the id; a date left without topics is deleted) and from the local files, which are then committed (operations:
docs/design/voices-db.md). Search caches and archives may lag, as the privacy page says.

## Checks

`import-voices.mjs` refuses: a file whose name, `date` and `window.to` differ; `window.from` > `window.to`; an unknown game
code; a duplicate id inside one snapshot; a topic whose `first_seen` is after the snapshot date; a `reacting_to` that is
not an x.com status URL; a `posts` field (player post URLs are never committed); any other X / Twitter URL in a decoded
string; more than 3 voices; `share` all zero; missing or extra fields (also `contracts/voices.schema.json`); a date after
today (JST). Across snapshots an id keeps its `game` and `first_seen`, and `new` is only its first appearance.
`verify_release.py` checks that the built `/voices/` embeds no snapshot, topic text or X URL and is in the sitemap;
`tools/verify/voices-d1.mjs` runs the page and the home block against the importer and the Worker code, and
`tools/verify/browser.mjs` drives the page with the API answer served from `data/voices/`.
