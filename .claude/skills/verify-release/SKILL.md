---
name: verify-release
description: Pre-merge gate for 新弾ナビ — checks a branch's data diff against main, builds dist/ with a pinned date, validates every page's JSON-LD and static list, then drives the built site in headless Chrome at desktop and mobile widths. Use before merging any branch to main (data updates, template/build changes, structured data), or when the owner asks to verify / test a change.
---

# Verify a branch before merging

Merging to `main` and pushing deploys the site, so every branch passes this gate first and the owner sees the result before anything is merged. Work happens in a worktree (`../.worktrees/<branch>`), never in the main checkout.

For data updates `scripts/refresh.py` already runs both steps (build with `BUILD_TODAY`, then `verify_release.py --base origin/main --skip-build` and `browser.mjs`, same `TODAY`) and puts the RESULT lines in its packet; run them by hand for other branches.

## Setup (once per worktree)

Needs Python 3.12 (same as CI) and Node ≥ 20; Chrome from `/Applications` (override with `CHROME=`).

```bash
uv venv -p 3.12 .venv && uv pip install -p .venv fonttools==4.66.1 brotli==1.2.0 pillow truststore
(cd tools/verify && npm ci)
```

## 1. Data, build, structured data

```bash
.venv/bin/python -I scripts/verify_release.py --base main --today YYYY-MM-DD
```

- Rebuilds `dist/` with `BUILD_TODAY` set, so results are reproducible; use today's date unless checking how the site will look on a later day.
- Data: ids unique and unchanged for the same title + name, new ids match `item_id`, no override removed (changed / new overrides are WARN to read), no visible duplicates by name or source key, recent / upcoming items that disappeared are WARN — check they were really cancelled.
- Pages: `/releases/`, all 10 title pages and month pages exist and are in the sitemap with `lastmod` = `meta.json`; canonical is the page itself; hidden items are not in page data.
- JSON-LD: parses; only `WebSite`, `BreadcrumbList`, `ItemList`, `ListItem`; no `Product` / `Offer` / price / availability / rating / review / shipping / return policy; `ItemList` names and order equal the visible static list; breadcrumbs end at the page.
- Next release: `/releases/` and title-page lists show no past dates, and each title page's 次の発売 is the first upcoming date. A FAIL here usually means a main title has no upcoming items — fix the data, not the check.

## 2. Real browser

```bash
node tools/verify/browser.mjs --today YYYY-MM-DD    # same date as step 1
```

Serves `dist/` locally with the browser clock pinned to that date, opens every page at 1280px and 390px, and fails on console errors, failed or 4xx/5xx local requests, broken images, horizontal scroll, a calendar that does not open on the current month (month pages: their month), or no visible release cards while the page has upcoming items (a title with nothing this month passes if 次月 reaches its items within 3 months). On `/releases/` it also toggles a title chip and stars a card; it also checks that `/` forwards to `/releases/` with query and hash kept. Screenshots go to `.verify/` (git-ignored) — look at a few, at least `releases` and one title page per width.

## 3. Report to the owner

In Chinese: both RESULT lines, every WARN with what you checked, the data summary (added / removed / changed), and the screenshot folder. Wait for the owner's OK before merging; pushing `main` is a separate OK.

## Notes

- Google's Rich Results Test has no API; for structured-data changes, offer the owner a manual paste of one built page into https://search.google.com/test/rich-results.
- Search performance (indexing, impressions, CTR per page / query) can only be judged after Google recrawls; it is not part of this gate.
- When a check is wrong rather than the site, fix the check in its own commit and say so in the report.
