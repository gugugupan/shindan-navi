# 話題カレンダー contract (`/voices/`)

What TCG players on X talk about, per game, as a calendar. Static: `scripts/build.py` reads the snapshots and embeds
them in `/voices/`; no Worker, no D1. The page is built only with `VOICES_ENABLED=1` (off by default: no page, no tool
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
- Never store post text, user names other than the handle inside a post URL, images or any other personal data:
  only our own summaries / paraphrases and links to the posts.

## Topic

| Field | Meaning |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9-]{2,63}$`, e.g. `opcg-bonney-ban-pair-speed`. **The same id in every snapshot while the topic continues**; a new topic gets a new id. |
| `game` | A game code, below. |
| `title` | Short label (≤ 40 chars), our words. |
| `summary` | 1-2 sentences in our own words (≤ 160 chars). |
| `attitude` | `positive` / `negative` / `mixed` / `neutral`: the overall tone. |
| `share` | `{positive, negative, neutral}` post counts behind the topic (relative weights are fine); the page draws them as a bar. |
| `volume` | `high` / `mid` / `low` (多 / 中 / 少): how much the topic is talked about, relative to the game's usual volume. |
| `voices` | 2-3 short paraphrased opinions (≤ 80 chars each), **never verbatim post text**. May be empty (the sample's UNION ARENA topics have none). |
| `reacting_to` | URL of the official post the topic reacts to, or `null`. |
| `posts` | 1-3 `https://x.com/<handle>/status/<id>` URLs (the page links them; no embeds). |
| `window` | The snapshot's window (same as the file's). |
| `first_seen` | First day (JST) the topic was seen; stays fixed across snapshots. |
| `status` | `new` (first snapshot with this id), `continuing`, `cooling` (talk is dying down). |
| `source` | `grok-app` (by hand in the Grok app), `openrouter`, `x-api`. |

## Game codes

The `/events/` codes keep their colours from the event palette (CLAUDE.md › Event game palette): `OPCG`, `UATCG`,
`CONAN`, `PTCG`, `GCG`, `DBFW`, `BS`, `DCG`, `WS`, `VG`, `SVE`, `HOCG`, `LLOCG`. Titles without events use the release
calendar's title colour (`--h`, computed from `data/items.json` as on `/releases/`): `MTG` (MTG), `YGO` (遊戯王OCG),
`DM` (デュエル・マスターズ). The list lives in `GAMES` in `src/voices.html`; the build reads the codes from there and
refuses unknown ones. Add a code there (and here) before writing topics for a new game.

## How the page reads it

- A topic is active from `first_seen` to the date of the last snapshot that lists its id. The calendar draws it as a
  span over those days (desktop) or a dot per game in each day (phones).
- For a given day the page shows the topic as the first snapshot on or after that day saw it (else the latest).
- 🆕 新 = `new`; 🔥 n日連続 = `continuing`, n = days from `first_seen` to the snapshot date, inclusive; 📉 落ち着き = `cooling`.
- The list view shows every snapshot, newest first, with its topics.
- The page embeds `{snapshots, counts}` as `const V = …;` (`counts` = release counts per title, for the title colours).
  `voices_data()` in `scripts/build.py` returns the same snapshots for other pages (the home-page block comes later).

## Build checks (scripts/build.py)

Refuses: a file whose name, `date` and `window.to` differ; `window.from` > `window.to`; an unknown game code; a duplicate
id inside one snapshot; a topic whose `first_seen` is after the snapshot date; post URLs that are not x.com status URLs;
more than 3 voices or posts; `share` all zero; missing or extra fields. `verify_release.py` checks the built page.
