# TCG+ persistent browser probe

Local investigation tool for the event data model. Opens visible Chrome, keeps a dedicated browser profile across runs, and records screenshots, visible controls and fetch/XHR observations. It does not import database records or apply for events.

## Local competition filter page

Build a self-contained HTML viewer from the saved partial competition results, without scraping or running the production build:

```bash
tools/event-collectors/tcg-plus/.cache/node22/bin/node tools/event-collectors/tcg-plus/build-viewer.mjs
```

Run from the repository root. The default input is the recovered 9,800-event snapshot under `out/stopped-partial-2026-11-17T17-09-27.967Z/`. Pass another collection directory as the first argument to inspect a different saved result. Output is `out/competition-viewer/index.html`; open that file directly in a browser. All data and assets are embedded, so no local server or internet connection is required.

The page filters by prefecture, venue/address, inclusive date range, weekday and a half-open start-time range. A first-month weekday 09:00–18:00 shortcut preserves the selected location. Known source-local timestamps are converted to Asia/Tokyo, including date rollover. Unknown times do not match a time filter. Results are paginated (50 per page) and can be exported as JSON with their filters and partial-coverage metadata. Details link to the matching public TCG+ event; opening the viewer alone makes no external requests. Start-time filtering does not establish an event's end time, open registration or eligibility.

The viewer is an isolated data-review tool. It does not change the production template, release data or deployments. The partial/full status and source-declared total are shown explicitly. Browser verification is available with `node viewer/check.mjs` from this tool directory, using an installed Chrome; it checks the default snapshot and writes ignored screenshots and a checked export under the viewer output directory.

## Event calendar data (`data/events/`)

```bash
cd tools/event-collectors/tcg-plus
node scrape-browser.mjs --game UATCG --profile <chrome-profile-dir> --page-size 100 --from 2026-11-18
node export-events.mjs out/events-<run>/ --from 2026-11-18 --until 2027-02-18 [--note "spot-check …"] [--dry-run]
```

- `--game` is `OPCG` or `UATCG`; the `game_title_id` is resolved from live `/api/masterdata` (exactly one Japanese-edition title must match) and `--game-title-id` only double-checks it. `CONAN` is accepted but fails: TCG+ masterdata has no 名探偵コナン title.
- `--profile` (or `TCG_PLUS_PROFILE`) points at an existing dedicated Chrome profile where the site's consent/region choice was already made. Only one Chrome may use it at a time, so run games one after another.
- `export-events.mjs` normalizes `competitions.json` to `contracts/event.schema.json` (`normalize.mjs`), validates every month file and `_run.json` with Ajv, and only then replaces `data/events/<GAME>/`. Incomplete runs (distinct ids ≠ source total), a query that does not cover the window, or any schema error write nothing.
- Mapping decisions: fees are always `null` (the list API omits `hidden_entry_fee`; sampled events report `0` with the fee hidden). `registration_status` follows the site's own label logic: `open`/`waitlist` only for `status_id=11` + `applicationOpen=1` + application start passed; `not_open` before the start; `closed` for status 21+. Times are kept only when the source zone is UTC+9; a fully hidden date (`start_datetime_hidden_type=2`) is skipped. Organizer phone/SNS, geo and free-text notes are never projected.

## Collect individual competitions

The separate collector targets Japanese ONE PIECE events across Japan:

```bash
bash tools/event-collectors/tcg-plus/scrape.sh
```

Run from the repository root. It reuses the local Node 22 runtime (or an existing Node 20+) and installed Chrome, opens the existing dedicated profile, then automatically exhausts the website's public event-list `limit/offset` pages. No manual clicks or page-by-page commands are needed. Close the interactive probe before running this collector because the profile can only be opened once. The collector closes Chrome when finished. There is no prefecture, weekday or open-applications filter. The default start date is today in Asia/Tokyo, matching the normal event search. This cannot recover unpublished or source-hidden historical records.

For a specific month:

```bash
bash tools/event-collectors/tcg-plus/scrape.sh --from 2026-11-01 --until 2026-11-30
```

Date-boundary semantics still need live comparison. `--page-size` accepts the website's 20/40/60/80/100 options; `--max-pages` is a safety budget (default 10000), never an instruction to publish a truncated list. Game ID 8 must match a Japanese ONE PIECE entry in current masterdata; `--game-title-id` permits correcting it without changing internal `OPCG`.

A successful run produces `out/events-*/competitions.json` (the actual array of individual matches/events), `competitions.schema.json` and `report.json` (query/coverage/diagnostics). Application periods, source date/time strings, hidden flags, fees and status codes are preserved as source values; registration remains unknown until mapping is verified. Player information, rankings and arbitrary fields are omitted. Public organizer/location fields are allowed. Source total changes, repeated IDs, malformed pages, unexpected game/country or exhausted page budgets fail the run; failed collection emits diagnostics without `competitions.json`. Data export uses a temporary `.part` file followed by rename.

The source route and field names were recovered from cached public TCG+ JavaScript and subsequently checked against actual browser responses. Live list fields include `event_series_title`, `entryFee` and `applicationOpen`. The normal browser search also returns shared BANDAI CARD GAMES events: these are included only when the public series directory explicitly lists ONE PIECE's ID among `event_series_game_title_ids`. Their source game ID and scope match are retained in the export.

Direct Node requests to the list returned HTTP 403 in this environment, while normal Chrome requests returned HTTP 200. The default transport therefore uses public GET requests in a normal TCG+ page, without cookies or authentication headers in the collector's requests. It only permits the game-directory, event-list and public series-membership endpoints; there is no arbitrary browser command interface. Masterdata is fetched directly to avoid a separate browser-transfer failure. `--headless` is optional and has not been live-validated. For diagnostics, `bash tools/event-collectors/tcg-plus/scrape.sh --direct` retains the Node-only transport; its date range defaults to the source behavior unless explicitly supplied. See [collector status and source evidence](../../../docs/TCG_PLUS_COLLECTOR.md). Neither collector imports release data, applies for events or deploys changes.

## Run

Requires Node.js 20+ and installed Google Chrome. The existing website does not need Node; this package is isolated.

To download a project-local Node.js 22 runtime, verify its SHA-256, install dependencies, run tests and open the browser in one command:

```bash
bash tools/event-collectors/tcg-plus/run.sh
```

Run this from the repository root. It keeps Node and npm cache under the ignored `.cache/` directory, does not change system Node or shell configuration, and reuses the existing browser profile. Node 22 is selected because Node 20 is end-of-life; the Node 22 macOS binary has a macOS 11 minimum deployment target. This does not imply that Apple or Playwright currently supports macOS 12. Chrome launch compatibility still needs a real check on this machine.

The same bootstrap accepts probe arguments, for example `bash tools/event-collectors/tcg-plus/run.sh --headless --once`. It requires network access to nodejs.org and the npm registry. If an existing Node.js 20+ is already available, use the direct commands below instead.

The bootstrap reuses an installed Playwright package when its exact version matches the manifest and lockfile. If a previous run used sudo, the profile or dependencies may be owned by root. The bootstrap reports the affected browser directory and a narrowly scoped ownership repair command; execute that once from your normal terminal, then run the bootstrap without sudo. It preserves the saved browser session. Do not run npm or Chrome as root to work around a permissions error.

```bash
cd tools/event-collectors/tcg-plus
npm install
npm run doctor
npm start
```

Chrome opens at `https://www.bandai-tcg-plus.com/home`. Choose UI language, country and game edition in the visible browser, including the site's consent checkbox if you agree. The tool does not click it automatically. Use normal site navigation to inspect events. If sign-in is needed, do it in the browser.

The `.session/chrome/` profile preserves cookies and localStorage. Restarting `npm start` reuses it. Quit with the terminal's `quit` command before starting another instance; only one process can use this profile. This is separate from your regular Chrome profile.

### Let Codex inspect the running session

`run.sh` enables `--control`. For direct npm startup use `npm start -- --control`. An already running old process must be restarted once to load this code; its existing cookies and preferences remain in the same profile.

Another terminal or Codex can then run these commands from the repository root:

```bash
node tools/event-collectors/tcg-plus/control.mjs status
node tools/event-collectors/tcg-plus/control.mjs snapshot
node tools/event-collectors/tcg-plus/control.mjs network
node tools/event-collectors/tcg-plus/control.mjs goto https://www.bandai-tcg-plus.com/series/8608
```

The channel uses ignored `.control/` files inside the workspace, does not open a network port, and only exposes status, page snapshots, network metadata, TCG+ navigation, reload and native select changes. It cannot evaluate arbitrary code, read profile cookies or submit applications. Commands are serialized, tied to a specific server instance and never automatically retried after a timeout. Close the browser or use `quit` to disable it.

Run as your normal user. If the browser process was started under another user, Codex should first run `node tools/event-collectors/tcg-plus/control.mjs --init` under your normal user before restarting the browser. This pre-creates the control files without changing profile ownership or permissions. Screenshots and profile data retain their existing protection.

If Chrome is elsewhere:

```bash
CHROME_EXECUTABLE="/absolute/path/to/chrome" npm start
```

Each run creates `out/<timestamp>/`. At `tcg+>`:

| Command | Purpose |
| --- | --- |
| `snapshot` | Save screenshot + visible text, select option labels/values, buttons and links |
| `select 2 VALUE` | Set the third currently visible native select using an exact observed option value |
| `status` | Current tab URL and response count |
| `network` | Last 15 fetch/XHR responses, statuses and JSON field shapes |
| `goto https://www.bandai-tcg-plus.com/series/8608` | Visit the observed ONE PIECE group in the same browser session |
| `reload` | Reload once |
| `jev` | Classify the current page with one optional Jev API call |
| `quit` | Save final observations and close cleanly |

`select` only handles native selects. For custom controls, use the visible browser and take another snapshot. Snapshots record what is visible immediately; after a page finishes loading, run `snapshot` again. There are no automatic navigation retries.

## Inspect network data

### Read-only API trial

From the repository root, run:

```bash
bash tools/event-collectors/tcg-plus/trial.sh
```

This standalone trial does not launch Chrome, require an interactive prompt, read the saved browser profile, or load credentials. It uses the prepared local Node 22 runtime, or an existing Node 20+. It requests the observed `/api/masterdata` endpoint, checks that game ID 8 has a ONE PIECE title, then fetches up to three pages of `/api/user/eventseries` with the observed `country_code=JP&limit=11&offset=0` parameters and increasing offsets. Set `--max-pages 1` for one page or up to `--max-pages 20` for a larger trial. Each request has a 15-second timeout; series pages are spaced 750 ms apart, with no automatic retries.

Each run writes a private, ignored `out/trial-*/report.json`. It contains selected public game/series fields and request diagnostics. Exit 0 means nonempty series samples were collected; exit 2 means a valid empty series list; exit 1 means failure. A page cap can leave coverage partial even with exit 0: check `complete_series_listing`. `multiple_pages_fetched` describes what was fetched, not independent proof of pagination correctness. Repeated IDs, changing totals, premature short pages, invalid JSON and malformed records fail the trial. No partially collected records are emitted after failure.

Each output folder also contains `report.schema.json`, copied from [`trial-report.schema.json`](trial-report.schema.json). The report references this sibling JSON Schema (Draft 4). Its separate success, empty and failure branches prevent a failed report from presenting partial series as collected data. Schema validation describes structure; cross-field count equality and source completeness still require the collector's runtime checks. No schema-validation dependency is installed in this package.

The numeric `success.code` is recorded without assuming its meaning; its success/error semantics remain unverified. Application-period strings are preserved as source values, never converted into event dates. This is a series sampling experiment, not a production importer. Individual events, venues, time filters, source game edition and anonymous access still require real-source verification. Existing release data and deployment are untouched.

Current trial evidence and limitations: [TCG+ scraper trial](../../../docs/TCG_PLUS_TRIAL.md).

`network.ndjson` records fetch/XHR method, sanitized URL, status and (for TCG+ JSON responses) field shapes. Response headers, cookies and request payloads are never logged. `errors.ndjson` records page exceptions and failed requests.

For limited sanitized JSON examples:

```bash
npm start -- --save-json
```

Only JSON from TCG+ domains is sampled, with size/depth/array limits and credential/personal field redaction. Other API hosts still appear in network metadata and require separate review before capturing payloads. Redaction also removes address fields; public venue addresses can be inspected in the visible page. Nothing is sent to Jev unless `jev` is explicitly entered.

Profile data, observations, node_modules and npm cache are gitignored. Screenshots and visible text can contain account information after sign-in; they remain local and should be reviewed before sharing. They are not fully anonymized by JSON redaction. Do not commit a profile, screenshot, token or `.env`.

## Jev (optional)

Uses the existing repository's `TYPESAFE_API_KEY` and optional `TYPESAFE_MODEL` from the environment or root `.env`. Environment values win. The key is not exposed to the browser. The `jev` command sends sanitized visible text/control information, asks a Choice question and records the returned classification, probabilities and usage. One command makes one call, without retries or automatic actions.

Possible classes: initial selection, login, group details, individual event, event search, error, other. Jev helps interpret a page; it does not replace the persistent browser or establish that anonymous access is impossible when a form fails. Sending a page for classification uses the TypeSafe service and may incur API charges.

Contract: [TypeSafe System One HTTP API](https://docs.typesafe.ai/api/system-one), [Choice](https://docs.typesafe.ai/primitives/choice).

## Verification

```bash
npm test
npm start -- --help
npm run doctor
npm start -- --headless --once
```

Tests verify URL scope, credential redaction, dotenv parsing and Jev request/error handling without network or browser dependencies. A real Chrome session is a separate integration check; a failed navigation is not evidence that TCG+ requires login.

## Next investigation

Resolve the initial selection form once, navigate a known series, then compare snapshots and JSON shapes against `docs/EVENT_DATA_MODEL.md`. Verify group IDs, individual event IDs, venues, filters and pagination before implementing an importer. Do not infer ONE PIECE's external game ID from prior automation's conflicting values.
