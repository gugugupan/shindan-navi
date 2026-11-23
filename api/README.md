# Events API

Cloudflare Worker + D1 that serves `GET /api/v1/events`, `/api/v1/events/days` and `/api/v1/events/meta` as specified in
[`../contracts/README.md`](../contracts/README.md), and serves the built site from `../dist` on the same origin.

The Worker config is `../wrangler.jsonc` (one Worker, `shindan-navi`, for site + API); every script here passes
`--config ../wrangler.jsonc`. Its `database_id` is a placeholder. Remote commands use `../wrangler.remote.json`, written
by `scripts/remote-config.mjs` from env `D1_DATABASE_ID` (git-ignored; the id is never printed or committed).
Deploys happen only through `.github/workflows/deploy.yml` (or `../scripts/deploy.sh`); the only remote commands here
are `npm run import:remote -- --plan` (reads) and `-- --yes` (writes).

## Setup

```bash
cd api
npm ci
python3 -I ../scripts/build.py      # optional: builds ../dist so the page is served too
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Import `../data/events/` into the local D1, then `wrangler dev --local` on http://localhost:8787 (page + API). |
| `npm run dev:node` | Same, without workerd: imports into `.local/events.sqlite3` and serves the same Worker handler on Node (see below). |
| `npm run import` | Import only (local D1 via `wrangler d1 migrations apply/execute --local`). |
| `npm run import:sqlite` | Import only, into `.local/events.sqlite3`. |
| `npm run import:remote` | Needs `D1_DATABASE_ID`. Validate and estimate a first import (no remote call); `-- --plan` reads D1 and prints the review summary and plan; `-- --yes` migrates, plans and applies to the production D1. See "Remote import". |
| `npm run db:migrate` | Apply `migrations/` to the local D1. |
| `npm run db:reset` | Delete the local D1 and SQLite file; the next import rebuilds them from `../data/events/`. Needed once for databases created before `0001_events.sql`. |
| `npm test` | Vitest: filters, pagination, validation, meta, importer, accounts (Google stubbed). `PERF=1 npx vitest run tests/perf.test.ts` runs a 20k-event benchmark. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run bundle` | `wrangler deploy --dry-run` with the root config into `.local/bundle`: checks config, assets and bundling; uploads nothing. Build `../dist` first to check the assets. |

Importer options: `node scripts/import-events.mjs [--data DIR] [--games OPCG,PTCG] [--target sqlite|wrangler|remote] [--sqlite FILE] [--out FILE] [--dry-run] [--plan] [--yes] [--max-writes N] [--allow-incomplete GAME,...] [--allow-shrink]`.
`dev-node.mjs` takes `--port`, `--sqlite`, `--dist` and `--dev-login` (see "Accounts").
The generated SQL is kept at `.local/import.sql`.

### workerd needs macOS 13.5+

`wrangler dev` and `wrangler d1 ... --local` run workerd, which does not start on macOS 12 (dyld error). There, use
`npm run dev:node`: it bundles `src/index.ts` with esbuild and runs the same `fetch` handler on Node with a
`node:sqlite` stand-in for D1 (`scripts/lib/sqlite-d1.mjs`) and a simple static file server for `../dist`.
Static handling approximates Workers assets with `auto-trailing-slash` (`/dir` → 307 `/dir/`, `index.html` for
directories, `.html` suffix, `404.html`); `_headers` is not applied and there is no Cache API (responses stay `no-store`).
Tests use the same stand-in.

## Import behaviour

- Reads `data/events/<GAME>/_run.json` and `<YYYY-MM>.json`, validates them against `contracts/*.schema.json`
  plus: game/source match the directory and run, `id` = `<tcgp|ptcg|conan|bnavi>:<external_id>`, no duplicate ids, file
  month = `starts_on` month, `starts_on` inside the run window, `ends_on >= starts_on`, `datetime` precision has
  `starts_at`, `record_count` = events in files. In-person events whose venue has no `region_code` get a warning:
  no location filter can reach them (0 in the current data).
- A game with any error is rejected as a whole (nothing written for it); other games still import; exit code 1.
  The remote target refuses to run at all while a game is rejected.
- **Diff, not replace.** The importer first reads the database's current rows (`id, content_hash, game_mask,
  starts_on, loc, …` for every event, plus `imports`), then writes only:
  - new events (insert) and events whose `content_hash` changed (full rewrite; `created_at` kept);
  - `game_mask` changes: an event gains the bit of every game listing it, and a **complete** run clears its game's
    bit on events in its window that it no longer lists (mask 0 hides the event; rows are never deleted; it
    reappears when listed again). Incomplete runs hide nothing; events outside the window are left alone;
  - an `imports` row per new run (`<GAME>:<fetched_at>`), and the two `site_meta` rows (`meta`, `state`) when
    anything changed or when they are missing / differ from what the current rows imply (repair after a failed import). `state.version` = import time; the Worker's cache key includes it.
  An unchanged re-import writes nothing. The upsert also checks `content_hash`/`game_mask` in its `WHERE`, so a
  stale diff cannot rewrite matching rows.
- `content_hash` covers the event without `game_code` and `last_seen_at` (the API derives `last_seen_at` from the
  newest import of the event's games).
- Shared events: the same `id` under several games is stored once; `game_mask` holds every listing game. Copies
  should be identical apart from `game_code`/`last_seen_at`; if not, the importer warns and the last game read wins.
- Meta (game windows, prefecture / online / category / type counts over each game's latest window, and `loc_counts`:
  per location × game_mask × type × month weekend/weekday counts for the location picker) is computed in the importer
  from the post-import state and stored as JSON, so `/events/meta` reads one row (~40 KB with the eight games' data of
  2026-11-19, ~50 KB with all 13).
- Statements are chunked to at most 60,000 UTF-8 bytes including the INSERT head and ON CONFLICT tail (D1 limit
  100 KB). A first import of the current data (~33k events) is ~580 statements, ~34 MB of SQL (`wrangler d1
  execute --file` accepts up to 5 GiB).

## Schema

`migrations/0001_events.sql` (replaced the never-deployed `0001_init.sql`; run `npm run db:reset` for older local
databases): `games` (seeded, with the `game_mask` bit), `imports`, `events`, `site_meta`, all `WITHOUT ROWID`.
`events` is one wide row per event: group (`group_*`, `category`, `event_type_code`) and venue (`venue_json`,
`region_code`) are stored inline, because joins cost a row read per event on D1. `loc` is the location filter key
(venue prefecture, or `online` without a venue). The only secondary index is `idx_events_loc(loc, starts_on,
starts_sort)`. `starts_sort` = Unix seconds of `starts_at`, or 253402300799 for date-only events, which gives the
"starts_at nulls last" order and the keyset `(starts_on, starts_sort, id)`.

`migrations/0002_day_counts.sql`: `day_counts(loc, starts_on, game_mask, event_type_code, n)` — visible events per
location, day, game mask and type (`''` for none), maintained by the importer (diffed like the events, repaired when
stale). `/events/days` reads only this table.

`migrations/0003_users.sql`: `users`, `user_identities` (`(provider, subject)` key, the only place with an email),
`sessions` (sha256 of the session id, `expires_at` Unix seconds, index on `user_id`), `user_prefs` (`(user_id, key)`,
keys `stars` / `event_filters` / `ask_calendar`), and the unused billing placeholders `entitlements`,
`billing_customers`. Apply it remotely before pushing the code that uses it (see Migrations).

`migrations/0004_feedback.sql`: `feedback` (one row per form submission: `kind`, `message`, optional `reply_to` /
`page` / `user_id`, `email_status` `pending`/`sent`/`failed` + `email_error`), indexes on `created_at` (retention
purge) and `user_id` (account deletion). No IP address or user agent. See Feedback.

`migrations/0005_more_games.sql`: the TCG+ games GCG, DBFW, BS, DCG (`games` bits 16-128) and a one-time rebuild of
`events`, `day_counts` and `imports` (SQLite cannot change a CHECK in place) loosened so no later game or source needs
another: `game_mask` up to 2^30-1 (30 games; bits stop at 2^29 because JS bit operations are 32-bit signed), and the
source columns check only their shape (`id` = lowercase prefix `:` external id; `source_code`, `registration_platform`
lowercase snake_case). The list of sources lives in `contracts/*.schema.json`, which the importer (the only writer)
enforces before any SQL, so a new source such as ブシナビ (`bnavi:`, `bushinavi`) needs a contract change, not a
migration. A new game still needs its `games` row (`imports.game_code` references it): a one-row `INSERT` migration.
The rebuild keeps every column and row (rehearsed on a copy of the live data: tables byte-identical, `content_hash`
unchanged, integrity and foreign-key checks clean), so the code before and after it both work on the migrated
database. Runbook: [Migration 0005](#migration-0005-runbook).

`migrations/0006_bushinavi_games.sql`: the five ブシナビ games WS, VG, SVE, HOCG, LLOCG (`games` bits 256-4096). Only
the `INSERT` (5 rows written); their ids (`bnavi:<digits>`) and sources (`bushinavi`) already pass 0005's shape
checks. Runbook: [Day 3](#day-3-bushi-navi-games).

## Accounts (Google login, synced preferences)

Contract: [`../contracts/README.md`](../contracts/README.md) › Accounts API. Code: `src/auth.ts` (OAuth, sessions,
routes), `src/prefs.ts` (validation, merge). Dark until enabled: all `/api/v1/auth|me|billing` routes answer 404 unless
`SITE_ORIGIN` (wrangler.jsonc `vars`) equals the request origin and all three secrets are set.

Secrets (the lead sets them; never in git, never printed):

```bash
cd api && node scripts/remote-config.mjs        # with D1_DATABASE_ID, writes ../wrangler.remote.json
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID     --config ../wrangler.remote.json
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --config ../wrangler.remote.json
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET --config ../wrangler.remote.json
```

Google Cloud OAuth client (Web application): authorized redirect URIs `https://shindan-navi.app/api/v1/auth/google/callback`
and, for local tests, `http://localhost:8787/api/v1/auth/google/callback`; scopes `openid email profile` only.
Rotating `SESSION_SECRET` logs everyone out (all session cookies fail the HMAC).

How it works:

- Login: `/auth/google/start` puts state, PKCE verifier, nonce and the return path in a signed (HMAC, not encrypted)
  HttpOnly cookie `__Host-sn_oauth` (10 min) and redirects to Google. The callback checks the state, exchanges the
  code with the client secret and PKCE verifier, and validates the id_token claims (`iss`, `aud`, `azp`, `exp`, `iat`,
  `nonce`, `email_verified`). The signature is not checked: the token comes directly from Google's token endpoint
  over TLS, authenticated with the client secret (OIDC Core 3.1.3.7), so no JWKS fetch. Google access/refresh tokens
  are discarded (no `access_type=offline`).
- Accounts are keyed by `(google, sub)`; an email match never links accounts. Login deletes the user's expired
  sessions and keeps at most the newest `MAX_SESSIONS` (10, the new one included). Sessions are 180 days absolute; D1 keeps sha256 of the id, the cookie holds the id + HMAC.
- Session check: the HMAC is verified first (a forged cookie costs no D1 read), then one query (session ⋈ user).
- CSRF: every non-GET needs `Origin: SITE_ORIGIN` and `Content-Type: application/json`; no CORS headers.
- Account routes are dispatched before the events routes and never touch the Cache API; every answer (redirects and
  errors too) is `Cache-Control: private, no-store`.
- Rate limits (per Cloudflare location, 429 with `Retry-After: 60`): `AUTH_LIMIT` 30/min for login start and
  callback per client IP; `AUTH_WRITE_LIMIT` 5/min for PUT/merge/DELETE per user; `AUTH_READ_LIMIT` 60/min for GET
  `/me` and `/me/prefs` per session, checked after the HMAC and before the D1 read (a limited GET reads nothing).
  Keyed by session rather than user so the check costs no D1 read; with the session cap that is ≤ 600 GETs/min per user.
- `requireEntitlement(db, userId, feature)` exists for paid features; nothing calls it yet. `POST /billing/webhook` is 501.

Local: `npm run dev:node` reads the three secrets from `../.env` (`node --env-file-if-exists`; only those keys reach
the Worker env) and sets `SITE_ORIGIN=http://localhost:<port>`, so the Google redirect URI above works on port 8787.
`npm run dev:node -- --dev-login` also serves `GET /__dev/login?name=alice&return=/` (signs in a local test user
without Google; fills missing secrets with throwaway values). That route lives only in `scripts/dev-node.mjs`; a test
checks the Worker bundle has no trace of it. `__Host-` cookies with `Secure` work on `http://localhost` in Chrome, not
in Safari. `wrangler dev` keeps the account routes off (its origin is not `SITE_ORIGIN`).

## Feedback (`/feedback/`, `POST /api/v1/feedback`)

Contract: [`../contracts/README.md`](../contracts/README.md) › Feedback API. Code: `src/feedback.ts`; page
`../src/feedback.html`. Dark until enabled on both sides:

- **Page:** `/feedback/` and every link to it (footer, gear menu, avatar menu, 404) are built only with
  `FEEDBACK_ENABLED=1` (repo variable; Worker build only, like `LOGIN_ENABLED`). The build also needs
  `TURNSTILE_SITE_KEY` (repo variable) and `PRIVACY_EFFECTIVE_FEEDBACK` in `scripts/build.py` (the day it goes live;
  it dates the FEEDBACK revision of `/privacy/`), and refuses to run without them. The page is `noindex` and not in
  the sitemap: it is a form with nothing to find in search, and it only works on the Worker.
- **Worker:** the route answers 404 `{"error":"feedback disabled"}` unless `SITE_ORIGIN` equals the request origin
  and `TURNSTILE_SECRET_KEY`, `FEEDBACK_TO` (a valid address) and the `FEEDBACK_EMAIL` send_email binding all exist.
  The binding is not in `wrangler.jsonc`: `scripts/remote-config.mjs` adds it only when `FEEDBACK_ENABLED=1` is in
  its environment (the workflow passes the repo variable), so deploys keep working before Email Routing is set up.

How a submission goes: same-origin `Origin` + JSON content type → `FEEDBACK_LIMIT` (5/min per client IP, IPv6 by /64)
and `FEEDBACK_BREAKER` (30/min for everyone per location, key `all`), both 429 and before anything costs → strict
validation (`Content-Length` and body ≤ 16 KB, exact fields, `kind` in bug/request/data/other, message 1-2,000
characters without control characters, plain address ≤ 254 with the same pattern as the page, `page` a same-origin
path ≤ 512) → Turnstile siteverify (`success`,
hostname `shindan-navi.app`, action `feedback`; a siteverify outage is 503) → logged-in user id from the session cookie
if login is on → one D1 batch (insert + delete rows older than 365 days) → mail → `email_status` update → 202. A D1
failure is 500 and sends nothing (the page keeps the text). A mail failure is logged and recorded in `email_status` /
`email_error`; the answer is still 202 because the feedback is stored. Deleting an account sets `user_id` to NULL on
its feedback rows.

The mail is a hand-built RFC 5322 message (UTF-8 base64 body, RFC 2047 encoded words folded so every header line is
≤ 78 characters, `Message-ID`, `Date`, `Reply-To` when an address was given). The body has the kind, page, reply
address, receipt id/time, ログインユーザー はい/いいえ (never the account id; that stays in D1) and the text. It is
sent as `EmailMessage` from `cloudflare:email`: From `feedback-form@shindan-navi.app` (pinned by the binding's `allowed_sender_addresses`), To the `FEEDBACK_TO` secret. Email Routing only delivers to **verified
destination addresses**, so `FEEDBACK_TO` must be one. Tests alias `cloudflare:email` to `tests/stubs/`; `dev:node`
has no binding, so the route answers 404 there and the page shows its 「現在、このフォームはご利用いただけません」 state.

To read submissions: `npx wrangler d1 execute shindan-navi-events --remote --config ../wrangler.remote.json --command
"SELECT created_at, kind, email_status, page, reply_to, message FROM feedback ORDER BY created_at DESC LIMIT 20"`
(rows contain personal data: don't paste them into issues or logs). Failed mails: `WHERE email_status != 'sent'`.
Deleting one submission on request (find its id by the receipt id in the mail, or by time / reply address):
`npx wrangler d1 execute shindan-navi-events --remote --config ../wrangler.remote.json --command "DELETE FROM feedback
WHERE id = '<id>'"`, and delete the notification mail too.

### Owner setup (in this order; nothing is live until step 7)

1. **Email Routing:** Cloudflare dashboard → zone `shindan-navi.app` → Email → Email Routing → enable it (Cloudflare adds
   its MX/SPF/DKIM records; check nothing else on the zone receives mail first). No routing rule is needed for
   sending.
2. **Destination address:** Email Routing → Destination addresses → add the mailbox that should receive feedback and
   click the link in the verification mail. Only verified addresses can receive from the Worker.
3. **Turnstile:** dashboard → Turnstile → Add widget: name `shindan-navi feedback`, hostnames `shindan-navi.app`
   (add `localhost` only if you want to test locally), mode Managed, no pre-clearance. Copy the site key (public) and
   the secret key.
4. **D1 migration** (from `api/`, with `D1_DATABASE_ID` exported):
   `node scripts/remote-config.mjs && ./node_modules/.bin/wrangler d1 migrations apply shindan-navi-events --remote --config ../wrangler.remote.json`
   (applies `0004_feedback.sql`; additive, safe for the code already deployed).
5. **Worker secrets** (from `api/`, logged in with `./node_modules/.bin/wrangler login`; each prompts for the value,
   nothing is echoed):
   ```bash
   ./node_modules/.bin/wrangler secret put TURNSTILE_SECRET_KEY --name shindan-navi
   ./node_modules/.bin/wrangler secret put FEEDBACK_TO --name shindan-navi     # the verified address from step 2
   ```
6. **Privacy date:** set `PRIVACY_EFFECTIVE_FEEDBACK = 'YYYY-MM-DD'` (the go-live day) in `scripts/build.py` and
   review the FEEDBACK parts of `src/privacy.html` (retention: 1 year, notification mails deleted within that year).
   Commit it.
7. **Repo variables** (GitHub → Settings → Secrets and variables → Actions → Variables): `TURNSTILE_SITE_KEY` = the
   site key, then `FEEDBACK_ENABLED` = `1`. For the first enable, run Deploy by hand (Actions → Deploy → Run workflow,
   i.e. `workflow_dispatch`) and watch it: the build step must show `feedback True` and the Worker config step
   `feedback mail binding`. If the deploy or the page misbehaves, roll back by deleting `FEEDBACK_ENABLED` and running
   Deploy again (links, page and binding go away; secrets and stored rows can stay).
8. **Check:** send one test from `https://shindan-navi.app/feedback/`, confirm the mail arrives (send_email mails show
   as "dropped" in the Email Routing summary even when delivered; look under Email → sending logs), and that the row
   has `email_status = 'sent'`.

Turning it off: delete the `FEEDBACK_ENABLED` variable (or set it to anything but `1`) and redeploy; the links and the
page disappear and the route answers 404 without the binding. Stored feedback stays until the 1-year purge (or delete
it by hand).

## D1 budget (Free plan: 100,000 rows written, 5,000,000 rows read per UTC day)

Numbers below are on the data of 2026-11-18 (32,980 events, 9,743 day_counts rows). Read numbers for the eight games (54,215 events,
19,032 day_counts rows, local copy of 2026-11-19 plus the four Bandai games) are given where they changed.

Writes (D1 counts each table row and each index entry; `--plan` prints the exact numbers for a given state):

| Import | Rows written |
| --- | ---: |
| First import | ~75,709 (events 2 × 32,980, day_counts 9,743, imports 4, site_meta 2) |
| Re-import with nothing changed | 0 |
| Typical refresh | 2 × changed events + 1 × mask changes + changed day_counts rows + new runs + 2 |
| First import with `venue.geo` (one-time) | 2 × events whose venue gains a geo + 2; upper bound ~65,954 (all 32,976 events with a venue) |

The importer refuses to apply a plan above `--max-writes` (default 90,000); split a bigger first import with
`--games` across UTC days.

**Adding games** (2026-11-19 data: 33,491 events, 10,498 day_counts rows). Migration 0005 writes ~77,500 rows on
its own and the first import of GCG, DBFW, BS, DCG (20,736 events, window 2026-11-20..2027-02-18) ~50,000
(`--games GCG,DBFW,BS,DCG`; GCG ~18.9k, BS ~12.4k, DBFW ~10.6k, DCG ~8.0k; or two days: `--games GCG,DCG` /
`--games BS,DBFW`). They go on different UTC days: [Migration 0005](#migration-0005-runbook). Free-plan limits are per
day across everything, so check the dashboard before a large import on a day that already had one.

The first import of the five ブシナビ games (collected 2026-11-19: 20,566 events, window 2026-11-18..2027-02-18),
measured with `--dry-run` on a copy holding the eight games above (54,215 events): ~49,624 rows written (events
41,132, day_counts 8,485, imports 5, site_meta 2); reads ~102k (the state read ~73k + one lookup per written row).
Per game: HOCG ~19.4k, VG ~9.9k, SVE ~8.3k, WS ~7.4k, LLOCG ~4.6k (or two days: `--games WS,VG,SVE` ~25.6k /
`--games HOCG,LLOCG` ~24.1k). It is its own UTC day after the Bandai import: [Day 3](#day-3-bushi-navi-games). With
all 13 games (74,781 events, 27,517 day_counts rows) the state read of every later import is ~102k rows.

`venue.geo` is stored inside `venue_json` (no migration, no extra reads per request). A `geo` of `null` and a missing
`geo` give the same content hash, so rows imported before the field existed are rewritten only when their venue gains
coordinates; until then the Worker serves them with `geo: null`. Measured on a copy of the 2026-11-18 data with
SYNTHETIC geo on 90% of venues: 30,156 rewrites, ~60,314 rows written (2× per rewrite is an upper bound; the index entry
does not change). With all four games refreshed the same day (new runs, mask and day_counts changes on top), run
`--plan` first; above ~70,000 split by game across UTC days (per game ≈ 2 × its events with a venue: PTCG ~28.8k,
OPCG ~27.2k, UATCG ~8.9k, CONAN ~1.1k), e.g. `--games PTCG` on one day and `--games OPCG,UATCG,CONAN` the next.
A `google` geo with `geocoded_at` more than 28 days before today (Asia/Tokyo) is served as `null` (30-day Google
caching limit minus the date granularity of `geocoded_at` and the 1-day edge + 5-minute browser cache); the importer
warns about expired ones so CONAN is re-geocoded first.

Reads per import: the state read (every event, import, site_meta and
day_counts row, ~43k) plus one primary-key lookup per written row.

**Accounts.** Per request (rows read / written; D1 may count index entries too):

| Request | Reads | Writes |
| --- | ---: | ---: |
| `GET /me` (valid cookie; forged cookie: 0) | 2 (session + user) | 0 |
| `GET /me/prefs` | 2 + ≤ 3 prefs | 0 |
| `PUT /me/prefs`, `POST /me/prefs/merge` | 2 + ≤ 3 prefs | 1 per changed key (unchanged keys are not written) |
| Login callback | 1 identity lookup + the user's sessions | session 2 (row + index); 2 per expired or over-cap session deleted; new user +3; changed name/avatar/email +1-2 |
| Logout / `DELETE /me` | 0-2 / 2 | 1-2 / every row of the user (+ its feedback rows' `user_id`) |
| `POST /feedback` | 0 (2 with a session cookie) + rows older than 1 year | ~4 (row + 2-3 index entries), status update ~2, purged rows |

Feedback writes are bounded by `FEEDBACK_LIMIT` (5/min per client IP), `FEEDBACK_BREAKER` (30/min per location for
everyone) and a Turnstile solve per submission.

Writes are what matter: the importer's `--max-writes` default of 90,000 leaves ~10,000 rows/day for accounts on a
day with a full import (the Free limit is 100,000 for everything). A star toggle is one write, so the page batches
toggles. When D1 refuses writes (quota), the API answers 500 and the page keeps its local state.

Per-user bound: a PUT or merge writes at most 3 rows (one per pref key), and `AUTH_WRITE_LIMIT` allows 5 per minute
per user, so one user writes at most 3 × 5 × 1,440 = 21,600 rows/day through one Cloudflare location (counters are
per location, so a user spread over several locations could exceed it). `DELETE /me` shares the limit and ends the
account. Logins are limited per client IP (30/min) and need a Google round trip each. The page writes at most once
every 12 s and pauses 60 s after a 429 (`src/corner.html`); a write refused by the limit stays in the local diff and
is sent later. Reads: ≤ 60 GETs/min per session at ≤ 5 rows each.

Reads per uncached request, measured with SQLite on the current data (rows stepped; D1 may count index entries too,
so up to ~2× for the events scans). "5 largest" = JP-13/27/23/28/11. Every events query is an index seek on
`idx_events_loc` per location (checked with EXPLAIN QUERY PLAN on SQLite 3.53 and the older 3.37): with a cursor,
the cursor's day is sought by `(starts_sort, id) > cursor` and the later days separately, so no earlier row is read
again. Limits: unfiltered pages 51 rows per location and part (cursor day / later days), filtered pages
`SCAN_LIMIT` 200 rows per location (100 per part), `DAY_ROWS` 62 day_counts rows in total for the day lookup, one
month per request.

| Request | Rows |
| --- | ---: |
| `/events/days`, one month: 東京都 / 5 largest (13 games, December) | ≤ 887 / ≤ 3,846 (8 games: ≤ 636 / ≤ 2,733; 4: ≤ 290 / ≤ 1,238) |
| `/events` page, no game/type/days filter: 東京都 / 5 largest (max per request while paging Dec) | 103 / 486 |
| `/events` page with filters, scan per request: 東京都 / 5 largest (max while paging) | 154 / 984 |
| `/events` page with filters, day lookup | ≤ month's day_counts rows (13 games: ≤ 887 / ≤ 3,846) |
| `/events/meta`, data version | 1, 1 |
| `/voices` (話題カレンダー): all snapshots / `/voices/latest` / voices version | 1 per snapshot (≈ 365 a year) / 1 / 1 |
| Event landing page `/events/<slug>/<pref>/` / `/events/sitemap.xml` (only with `LANDING_ENABLED=1`) | 1 / 624 |

**Event landing pages** (docs/design/event-landing.md, pending migration `migrations-pending/0007_landing_pages.sql`):
the importer writes 48 `landing_pages` rows per imported game plus other games' rows touched by moved shared events (≤ 624 in all; 0 for a same-day re-run; one
written row each, no secondary index) and reads 624 more state rows; while the table is missing it writes none and
says so. Its state read adds the landing window's events (~23k rows with 13 games, index seeks per location). Pages cache like the API (data version + Japan date + shell, 24 h per colo); the worst case is every page
missing once a day in every colo (624 × ~300 ≈ 187k reads), crawlers in a few colos make it < 5k. Every landing
request, hit or miss, is a Worker invocation (Free: 100k/day).

**Voices** (`import-voices.mjs`, migration `migrations/0008_voices.sql`, docs/design/voices-db.md): one
`voice_snapshots` row per date, so an import writes ~2 rows per new or changed date + 1 version row (a takedown: the
dates it rewrites or deletes + 1); its plan reads every row once. `/api/v1/voices*` is cached like the events
endpoints under its own version (`voice_meta`), so a miss happens once per colo and import; each `/voices/` view and
each home view with いま話題 is still a Worker request (Workers Free: 100,000 a day).

Paging through December with all cursors: Tokyo unfiltered 1,693 events in 34 requests / 2,557 rows; 5 largest
with `days=weekend` 1,912 events in 39 requests / 12,521 rows (scan only). An uncached Tokyo list view costs ~340
rows (one month's `/days` + the first page). While every loaded event of today has already started (evening, busy
prefecture), the list loads today's next pages by itself, up to 4 more loads of the same pages 「もっと見る」 reads, and stops
at the first upcoming event or when today is complete.

**Day view** (`/events/` with one day open, the map's data): the page pages through the whole day by itself, up to 12
`/events` loads, then asks (「さらに読み込む」). Its `/events` requests use the API's month-shaped range (`from` = the day,
`until` = 1st of the next month; a single-day `until` would be a 400 and a new cache key per day) and stop once the
day's count from `/days` has arrived, so they read the same pages as the list. Busiest day so far (11/22): one
prefecture (東京都, 178 events) ≈ `/days` + 4 pages ≈ 700 rows; 5 largest (640 events) ≈ 14 requests (`/days` + 12
pages + meta, the cap) ≈ 7,100 rows. That is ~700 uncached worst-case day views per 5M reads (~350 if D1 counts
every scanned row twice). With eight games the busiest 東京都 day has 217 events (11/21): `/days` + 5 pages
≈ 1,000 rows uncached; with 13 games 271 events: `/days` + 6 pages ≈ 1,500 rows.

**Today page** (`/`, `src/home.html`): no request without a saved location. With one, 2-3 requests per visit, all
keys the `/events/` page uses too, with the saved `game`/`type` (not `days`): `/events/days` for this month (calendar
view; its `by_game` gives each game column's total and the week strip's per-game chips, `by_game_type` the column's
per-type line) and `/events` from today to
the 1st of next month with `limit=50` (first list page). `limit` is fixed at 50 and the page runs in start order across
all games, so on a busy day one game can fill it: then, and only then, the page asks for the next page with its
`next_cursor` (the list's second page, same key) — at most one extra page; a column still short after it shows its
total and a link. Uncached, one prefecture: ≤ ~290 + ~103 (+ ~103) rows (Tokyo, unfiltered; filtered ≤ ~290 + ~444
(+ ~444)). On the data of 2026-11-19 Tokyo unfiltered needs the third request (PTCG 104 of 157 events), Osaka + PTCG
and online do not. `/events/meta` (1 row, same key as `/events/`) only when the location picker is opened, for its
counts; no `/geo`. Days of the next month in its week strip link without a count.

`/events/days` answer size: `by_game_type` (2026-11-20) grows it but reads no more rows (same `day_counts` search, see
above). Measured on 大阪府 (JP-27), December 2026: 2.3 → 9.6 KB raw, 0.44 → 1.2 KB gzip. Upper bound for Tokyo (636
day_counts rows in a month, synthetic spread over 8 games): 3.6 → 17 KB raw, 0.8 → 2.5 KB gzip.

**Worst case.** A miss costs at most ~4.9k rows with 13 games (~3.8k with eight, ~2.3k with four): a filtered
`/events` page on the 5 largest prefectures reads the whole month's day_counts when matches are sparse (≤ 3,846), up
to 200 rows per location and the ≤ 50 matches in full. ~1,000 distinct uncached requests use up 5M/day (~500 if D1
counts every scanned row twice). The key space is small but not tiny
(≤4 months or ~92 start days × location sets × game/type/days), so the limits matter:

- one client (IPv4 address or IPv6 /64) gets 20 misses per minute per location: ≤ ~100k rows/min, so a single client
  that keeps hitting the limit exhausts the daily reads in under an hour;
- all clients together get 300 misses per minute per location (breaker, 503), which bounds bursts but not the daily
  total.

So the free quota is protected against accidents and casual abuse, not against a client that sustains the limit
for hours. When the quota runs out, D1 fails until 00:00 UTC: cached answers keep serving, misses return 500, the
static pages are unaffected. If that happens, the options are Workers Paid (25B reads/month) or a WAF rule that
blocks the offender.

## Migration 0005 runbook

0005 rebuilds the three event tables (~77,500 rows written, possibly more if D1 also counts the dropped tables; that is
not documented). Free plan: 100,000 rows written per UTC day for everything, and over the limit D1 refuses all queries
until 00:00 UTC (09:00 JST); cached API answers keep serving.

1. **Pick the window.** Apply at about 08:30 JST, near the end of the UTC day: if it goes over quota, D1 is down for at
   most ~30 minutes. No `import:remote -- --yes` that day before the migration: `--yes` runs `migrations apply` first
   and adds the import's writes on top.
2. **Check today's writes** in the dashboard (Workers & Pages → D1 → shindan-navi-events → Metrics, rows written
   today, UTC). Go ahead only if well under ~20,000.
3. **Record a Time Travel bookmark** (from `api/`, with `D1_DATABASE_ID` exported):
   `node scripts/remote-config.mjs && ./node_modules/.bin/wrangler d1 time-travel info shindan-navi-events --config ../wrangler.remote.json`.
   Note the bookmark it prints (Time Travel keeps 7 days on the Free plan).
4. **Apply:** `./node_modules/.bin/wrangler d1 migrations apply shindan-navi-events --remote --config ../wrangler.remote.json`.
   Then check: `wrangler d1 execute … --remote --command "SELECT COUNT(*) FROM events"` (unchanged count) and
   `"SELECT code, bit FROM games"` (8 rows); `/api/v1/events/meta` still answers.
5. **If it fails or the site misbehaves:** a failed migration is not recorded in `d1_migrations`. To roll back to the
   bookmark: `./node_modules/.bin/wrangler d1 time-travel restore shindan-navi-events --bookmark=<bookmark> --config ../wrangler.remote.json`
   (it also undoes any account / feedback writes made after the bookmark; at 08:30 JST that is minutes).
6. **Push the code** (the 8-game Worker). Before this, the old Worker would serve new-game events without a
   `game_code`, so never import the new games before the push.
7. **Day 2 (after 09:00 JST, a new UTC day):** `npm run import:remote -- --data <owner data dir> --games GCG,DBFW,BS,DCG --plan`,
   review (~50,000 rows written, 20,736 inserted), then `-- --yes`. From then on only the new importer (this
   branch or later) may write to D1: an older one rejects the new game directories and computes meta and `loc_counts`
   without bits 16-128.

## Day 3: Bushi Navi games

After day 2 (the Bandai import), on a new UTC day (after 09:00 JST), from `api/` with `D1_DATABASE_ID` exported:

1. **Check today's writes** in the dashboard (well under ~45,000 before an import of ~50,000).
2. **Apply 0006:** `node scripts/remote-config.mjs && ./node_modules/.bin/wrangler d1 migrations apply shindan-navi-events --remote --config ../wrangler.remote.json`
   (5 rows written; additive, safe for the Worker already deployed). Check `"SELECT code, bit FROM games"` (13 rows).
3. **Push the code** (the 13-game Worker). The older Worker would serve the new games' events without a `game_code`
   and answers 400 to a page cursor that ends on a `bnavi:` id, so never import them before the push.
4. **Plan:** `npm run import:remote -- --data <dir with WS, VG, SVE, HOCG, LLOCG> --games WS,VG,SVE,HOCG,LLOCG --plan`;
   review (~49,600 rows written, 20,566 inserted on the 2026-11-19 collection; a fresher collection lists more of
   the later weeks), then the same command with `--yes` instead of `--plan`.
5. **Check:** `/api/v1/events/meta` lists the five games with their counts; `/events/` in 東京都 shows ヴァイスシュヴァルツ
   … chips with numbers. From then on only this importer (or later) may write to D1: an older one rejects the new
   game directories and computes meta without bits 256-4096.

## Migrations

CI deploys code only and never migrates D1. Apply a new `migrations/*.sql` to the remote database **before** pushing
code that needs it: `npm run import:remote -- --yes` runs `wrangler d1 migrations apply --remote` first, or run that
command alone (`npx wrangler d1 migrations apply shindan-navi-events --remote --config ../wrangler.remote.json`
after `node scripts/remote-config.mjs`). Keep migrations additive so the code before and after the push both work.

## Remote import

```
D1_DATABASE_ID=<id> npm run import:remote                # validate, first-import estimate, no remote call
D1_DATABASE_ID=<id> npm run import:remote -- --plan      # read D1 (~33k rows), print the review summary and plan
D1_DATABASE_ID=<id> npm run import:remote -- --yes       # migrations apply, read, plan, execute --file
```

Event data is local only (never in git), so the importer guards it itself:

- every month file and `_run.json` passes the schema and consistency checks; a rejected game blocks the remote
  import (`--games` imports the others deliberately);
- every run is `complete`, unless allowed per game: `--allow-incomplete CONAN` (an incomplete run adds and updates
  events but hides none);
- a complete run must not list over 20% fewer events than D1 shows for its game in the same window, nor end its
  window earlier than the game's previous import, unless `--allow-shrink` (incomplete runs hide nothing and are
  exempt);
- at most `--max-writes` rows written (default 90,000).

The review summary (printed by every mode) has one line per game: fetched_at, source_total, records in the files,
events in D1 now for that window, inserted, updated, unchanged, hidden. Read it in `--plan`, then run `--yes`.

Consistency: the SQL never deletes events or empties a table (only `day_counts` rows that no longer apply are
deleted), so readers see each event in its old or new state. Whether D1
runs an uploaded file as one transaction is not documented (its import guide only says to remove `BEGIN
TRANSACTION`/`COMMIT`); a partial import is safe to re-run, and the next import rewrites site_meta if it was left
stale. D1 is single-threaded per database: while a large import runs, API misses queue and may fail with an
"overloaded" error, returned as 500 (never cached); cached responses keep serving, also when D1 fails afterwards
(the Worker falls back to the last known data version). Daily refreshes are small diffs, so this mainly concerns
the first import.

## API notes

- The API accepts exactly what the page sends: `pref`, `from`, `until`, `game`, `type`, `days` (`weekend`/`weekday`),
  plus `limit` (only 50) and `cursor` for `/events`. Anything else is 400, so it can neither bypass the cache nor add
  work. Empty list values (`game=`) mean "no filter"; `from`, `until`, `days`, `limit`, `cursor` may appear once.
- `pref` is required: 1-5 of `JP-01`..`JP-47` / `online` (the page sends one).
- Ranges are month-shaped: `/events/days` takes a whole month, `/events` any start day up to the 1st of the next
  month. Both are clamped to the data window (union of the latest import windows, kept in site_meta `state`); a
  range wholly outside answers empty without a D1 read.
- `cursor` is bound to the filters and the requested range; reusing it with other filters, a date outside the range
  or a malformed key is 400. A window change while someone scrolls does not void it.
- Filtered `/events` pages (game/type/days) first read the next matching days from `day_counts` (`DAY_ROWS` = 62
  rows in total across the locations), then scan only those days, per location the cursor's day and the later days
  capped at 100 rows each (`SCAN_LIMIT` 200 per location; with eight games the busiest location-day, 東京都 11/21,
  has 217 events, so such a day can take one more page), filter in the Worker and
  read the ≤ 50 matches in full. When a branch hits its cap, the page ends at
  that branch's last row and the cursor continues there; a page can then hold fewer than 50 events.
- `/events` has no `count`; `/events/days` gives per-day totals for the same filters.
- After an import, browsers may keep a `/events/days` answer for up to 5 minutes (`max-age=300`) while `/events`
  already serves the new version, so a month's count can briefly disagree with its list; a reload fixes it.
- Filtered lists depend on `day_counts`. If an import stopped part-way, run it again: the importer diffs and repairs
  `day_counts` and site_meta along with the events.
- `game` matches any member game; events carry `game_codes` (sorted alphabetically) and `game_code` = `game_codes[0]`.
  `/events/days` counts a shared event once in `count` and under each member game in `by_game` (only the selected
  games when `game=` is set).
- `/events/days` lists only days with matches; `by_game` has only games with matches that day. `by_game_type` splits
  each game's count by `event_type_code` (`""` = none), counted like `by_game`. It groups the same `day_counts` rows by
  type as well (the primary key's order, same index search; checked in tests/api.test.ts), so D1 reads are unchanged;
  only the answer grows.
- `days` uses the weekday of `starts_on` (already a Tokyo date).
- All `event_status` values are returned and counted; the page marks cancelled/postponed events.
- Type labels come from `TYPE_LABELS` in `src/constants.ts` (per `event_type_code`); codes without a label use the code itself.
