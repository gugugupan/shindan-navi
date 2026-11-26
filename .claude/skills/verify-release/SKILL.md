---
name: verify-release
description: Pre-merge gate for トレカカレンダー — checks a branch's data diff against main, builds dist/ with a pinned date, validates every page's JSON-LD and static list, then drives the built site in headless Chrome at desktop and mobile widths. Use before merging any branch to main (data updates, template/build changes, structured data), or when the owner asks to verify / test a change.
---

# Verify a branch before merging

Merging to `main` and pushing deploys the site, so every branch passes this gate first and the owner sees the result before anything is merged. Work happens in a worktree (`../.worktrees/<branch>`), never in the main checkout.

Production builds with `VOICES_ENABLED=1` (話題カレンダー `/voices/` and the home いま話題, data from D1), so the gate does too. For data updates `scripts/refresh.py` already runs both steps (build with `BUILD_TODAY` and `VOICES_ENABLED=1`, then `verify_release.py --base origin/main --skip-build` and `browser.mjs`, same `TODAY`) and puts the RESULT lines in its packet; run them by hand for other branches.

## Setup (once per worktree)

Needs Python 3.12 (same as CI) and Node ≥ 20; Chrome from `/Applications` (override with `CHROME=`).

```bash
uv venv -p 3.12 .venv && uv pip install -p .venv fonttools==4.66.1 brotli==1.2.0 pillow truststore
(cd tools/verify && npm ci)
```

## 1. Data, build, structured data

```bash
VOICES_ENABLED=1 .venv/bin/python -I scripts/verify_release.py --base origin/main --today YYYY-MM-DD
node tools/verify/voices-d1.mjs --today YYYY-MM-DD    # same dist/: /voices/ and the home block against the importer + Worker code (npm ci in api/ once)
```

- Rebuilds `dist/` with `BUILD_TODAY` set, so results are reproducible; use today's date unless checking how the site will look on a later day.
- Data: ids unique and unchanged for the same title + name, new ids match `item_id`, no override removed (changed / new overrides are WARN to read), no visible duplicates by name or source key, recent / upcoming items that disappeared are WARN — check they were really cancelled.
- Pages: `/releases/`, every hub (`hub` rows of `data/games.json`) and month pages exist and are in the sitemap (thin hubs: noindex,follow and out of it); `lastmod` = the newest `changed` of the page's items (item pages: their own, `/`: `meta.json`), never after `--today`; canonical is the page itself; hidden items are not in page data.
- Index: the sitemap lists exactly the built pages without noindex, each self-canonical (trailing slash, og:url = canonical); `<title>`s are unique (FAIL) and over 60 characters is a WARN (item pages summed into one line); shared descriptions WARN; robots.txt names the sitemap.
- `changed`: a date on or before `meta.json`; after merge runs every new or changed item (vs the base) carries a date from the base's `meta.json` `updated` on — a data branch may hold runs of several days (FAIL); after a hand edit of `items.json` without a merge run it is a WARN.
- Archive (`data/items-archive.json`): ids unique and not in `items.json`, released before the 30-day window, `changed` ≤ `--today`; an item that left `items.json` for its date and is not hidden must be archived (FAIL); removed entries, entries over two years old and new entries not from the base's `items.json` (backfill) are WARNs.
- Product pages: every visible item has `/item/<id>/` (hidden ones none), and so does every archived one (発売済み shown, no `/releases/#i=` link, in the sitemap with its `changed`, on no calendar page or `/`), self-canonical, h1 = name, unique title, only BreadcrumbList JSON-LD, internal links resolve, in the sitemap; every static list entry links its item page.
- Hubs (title pages): no topic text or X URL in the built HTML, the voices API and いま話題 only with `VOICES_ENABLED=1`; `dist/_redirects` has exactly the `/<code>/` → `/<slug>/` 301s; the thin-page rule (robots, sitemap; WARN for a hub with exactly 2 releases and no events), `og/<slug>.png` at 1200x630, the footer's タイトル別 row = the indexable hubs; title / description / h1 keep 新弾 発売日 and name イベント / 話題 only where the build shows them; with `LANDING_ENABLED=1` events hubs carry the 48-link 都道府県 row.
- JSON-LD: parses; only `WebSite`, `BreadcrumbList`, `ItemList`, `ListItem`; no `Product` / `Offer` / price / availability / rating / review / shipping / return policy; `ItemList` names and order equal the static list; every list entry sits in the one closed `<details>` right after the list h2, whose count equals the entries; breadcrumbs end at the page.
- Next release: `/releases/` and title-page lists show no past dates, and each title page's 次の発売 is the first upcoming date. A FAIL here usually means a main title has no upcoming items — fix the data, not the check.

## 2. Real browser

```bash
node tools/verify/browser.mjs --today YYYY-MM-DD    # same date as step 1
```

Serves `dist/` locally with the browser clock pinned to that date, opens every page at 1280px and 390px, and fails on console errors, failed or 4xx/5xx local requests, broken images, horizontal scroll, a calendar that does not open on the current month (month pages: their month), or no visible release cards while the page has upcoming items (a title with nothing this month passes if 次月 reaches its items within 3 months). Where a page has static list entries, all of them must sit in one closed disclosure after the h2 and open from its summary. On `/releases/` it also toggles a title chip and stars a card; on `/` (the today page) it checks the date, today's releases from the embedded window, the 6-day week, favourites first, the location prompt without API calls, the 2 stubbed event requests for a saved location, and that `/releases/#d=` opens that day. Item pages (a coded item with a photo, a 参考画像 one, a placeholder one; the first also in dark mode): no errors or horizontal scroll, internal links answer 200, 新弾カレンダーで見る opens the item. Archived item pages (one with a thumbnail if any, the newest): 発売済み visible, no calendar link, links answer 200; every archived page is built, in the sitemap and absent from `/` and `/releases/`. Hubs (one with topics in the latest snapshot, 1366 / 390, light and dark): 話題 markers and the day dialog match the served voices answer, いま話題, the switcher (all hubs, current marked, `?m=` carried, the month survives the switch), a 503 from the voices API leaves releases and hides 話題, and every `/<code>/` redirect (served from `dist/_redirects`; the hosts' own behaviour is checked by hand on a preview URL). Screenshots go to `.verify/` (git-ignored) — look at a few, at least `releases` and one title page per width.

## 3. Report to the owner

In Chinese: both RESULT lines, every WARN with what you checked, the data summary (added / removed / changed), and the screenshot folder. Wait for the owner's OK before merging; pushing `main` is a separate OK.

## Notes

- Step 2 serves the voices API answer itself, so it needs no Worker. Both voices gates use the made-up snapshots in `tools/verify/fixtures/voices/` (dates moved so the last one is `--today`), never real ones: those live only in D1 and the owner's local copy.
- Google's Rich Results Test has no API; for structured-data changes, offer the owner a manual paste of one built page into https://search.google.com/test/rich-results.
- Search performance (indexing, impressions, CTR per page / query) can only be judged after Google recrawls; it is not part of this gate.
- When a check is wrong rather than the site, fix the check in its own commit and say so in the report.
- Login / account changes (corner sync, マイカレンダー, LOGIN parts of `/privacy/`): run steps 1 and 2 a second time with `LOGIN_ENABLED=1` added (`VOICES_ENABLED=1 LOGIN_ENABLED=1 …verify_release.py …`, then `browser.mjs`); only a LOGIN build has the user control, so only then does `browser.mjs` run its マイカレンダー checks (`/api/v1/me` and `/me/prefs` stubbed per page). Production's flag is a repo variable: run the default build too.
