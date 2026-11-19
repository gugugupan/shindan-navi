---
name: d1-remote-op
description: Runbook for any write to the production D1 (shindan-navi-events) — event imports, migrations, re-normalisations, restores. Use before running `npm run import:remote -- --yes`, `wrangler d1 migrations apply --remote`, `wrangler d1 execute --remote` with a write, or a time-travel restore, and when the owner asks to import / refresh events or apply a migration.
---

# Write to the production D1

D1 is on the Free plan and the event data has no copy in git, so every remote write is planned, budgeted and reviewed first. Numbers live in `api/README.md` (› D1 budget, › Import behaviour, › Remote import, › Migrations, and a migration's own runbook section such as › Migration 0005 runbook); read the sections for your op instead of trusting figures here. Shipping code that goes with the op follows the `ship-gate` skill and the "Approvals: Fable first" rule in `~/.claude/CLAUDE.md`.

## Always ask the owner first

Whatever Fable rates: overwriting or rewriting the owner's event data dir (the only copy), migrations and time-travel restores, and anything the owner said to confirm in this conversation. Imports that only add / update rows go through Fable (high → proceed).

## 0. Setup and secrets

- Work from `api/` in a worktree whose importer is the **newest on main** (`git fetch && git merge origin/main` first). An older importer drops meta fields added since (e.g. `loc_counts`) and may reject newer game directories.
- `D1_DATABASE_ID` comes from the environment; the lead keeps the real value and the owner's data dir path outside the repo (the git-ignored `wrangler.remote.json` / the lead's memory). Never print, echo, log or commit the id; never paste it into a brief.
- `node scripts/remote-config.mjs` writes `../wrangler.remote.json`. Delete it when the op is done.

## 1. Budget: quota is per UTC day

Free-plan writes and reads reset at 00:00 UTC (09:00 JST) and count everything on the database that day, including earlier imports and user traffic. Before any write:

```bash
./node_modules/.bin/wrangler d1 info shindan-navi-events --config ../wrangler.remote.json --json   # rows_written_24h
```

Compare `rows_written_24h` plus the plan's rows with the daily limit in › D1 budget. If it does not fit with a wide margin, split (`--games`) or wait for the next UTC day.

## 2. Imports: plan, compare, then apply

1. Back up the data dir before anything rewrites it (collectors, re-normalisation scripts):
   `tar czf ~/shindan-backups/events-$(date +%F-%H%M).tgz -C <owner data dir> .`
2. Plan, always with an explicit data dir. Without `--data` the importer reads the worktree's `../data/events`, which is usually empty or stale, and the plan silently writes nothing useful:
   ```bash
   npm run import:remote -- --data <owner data dir> [--games A,B] --plan
   ```
3. Write down the expected numbers before reading the plan (from the collector run, the change you made, › D1 budget). Then compare per game: inserted, updated (rewritten), unchanged, hidden, D1-now vs records, total rows written, and whether `site_meta` is rewritten. Stop on any surprise: a large `hidden` count, rewrites when nothing changed, a game shrinking, rows far above the estimate.
4. Guards — use them deliberately, never to get past a surprise:
   - `--allow-incomplete GAME`: that game's run is not complete; it adds and updates events but hides none. Only for a game whose run is known to be partial.
   - `--allow-shrink`: only after confirming the source really lists fewer events.
   - `--max-writes N`: the cap; a bigger first import is split with `--games` across UTC days, not by raising it.
5. Have Fable review the plan output (paste it, with the expectations and the budget check) and rate `CONFIDENCE`. High → `npm run import:remote -- --data <owner data dir> [--games …] --yes` with the same flags.
6. `--yes` runs `migrations apply --remote` first. If a migration is pending that is not meant to run today, do not run `--yes`.

## 3. Migrations

1. Read the migration's runbook section in `api/README.md`. Rebuild-type migrations (table copies) write roughly one row per existing row plus indexes: schedule them near the end of a UTC day (about 08:30 JST) on a day with little usage, so an overrun locks D1 for minutes, not hours.
2. No `import:remote -- --yes` earlier that day: its writes add to the migration's.
3. Record a Time Travel bookmark first and keep it in the report:
   `./node_modules/.bin/wrangler d1 time-travel info shindan-navi-events --config ../wrangler.remote.json`
4. Apply: `./node_modules/.bin/wrangler d1 migrations apply shindan-navi-events --remote --config ../wrangler.remote.json`. The auto-mode classifier may block this command; then give the owner the exact line to run themselves with `!` in the prompt, and continue once they paste the output.
5. Check the runbook's post-conditions (row counts unchanged, new tables / rows present, `/api/v1/events/meta` answers). On failure, a restore to the bookmark is an owner decision: it also undoes account / feedback writes made since.
6. Migrations go in **before** pushing code that needs them; imports that need the new code go **after** the push.

## 4. Sub-agents and the data dir

- Sub-agents never write to the owner's data dir and never run remote writes. They work on a copy: `cp -RL <owner data dir> <scratch>/events` (`-L`: the dir may contain symlinks), with their own SQLite file (`npm run import:sqlite -- --data <copy> --sqlite <file>`) or local D1.
- A collector or re-normalisation run that should become the new data goes to a separate dir; replacing the owner's dir with it is an owner OK after a backup.
- A verify step can check the owner's dir is unchanged against the latest backup tarball.

## 5. After the op

- Spot-check the live API: `/api/v1/events/meta` (new `state.version`, windows, game list), one `/api/v1/events/days` and one `/api/v1/events` call with the `pref` / month the page sends, and `/events/` in a browser. Cached answers keep serving the old version for up to 60 s.
- `rm ../wrangler.remote.json`.
- Report to the owner in Chinese: what ran, the plan numbers vs expectations, `rows_written_24h` before and after, the bookmark (migrations), Fable's rating, live checks. Record it in the kb plan when one exists.
