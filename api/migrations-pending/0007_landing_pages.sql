-- Event landing pages /events/<slug>/<pref>/ (docs/design/event-landing.md). Pending: the owner moves this file to
-- api/migrations/ when the pages go live; until then the events importer's automatic `migrations apply` cannot pick it
-- up, skips the landing rows and the Worker answers the pages with 404. IF NOT EXISTS keeps a re-run harmless.
-- One row per (game, location), written only by the events importer from that game's latest run:
--   built_on    JST day the row starts at (the import day, or the run window's first day when later)
--   days_json   {"YYYY-MM-DD": events that day} for every day with events in built_on .. built_on + 28 days
--   events_json compact events (api/scripts/lib/importer.mjs landingRows), at most 8 per day, ordered like the API
--   content_hash sha1 of the other columns, so a re-run of the same data writes nothing
CREATE TABLE IF NOT EXISTS landing_pages (
  game_code TEXT NOT NULL,
  loc TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  built_on TEXT NOT NULL CHECK (built_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  days_json TEXT NOT NULL CHECK (json_valid(days_json)),
  events_json TEXT NOT NULL CHECK (json_valid(events_json)),
  content_hash TEXT NOT NULL,
  PRIMARY KEY (game_code, loc)
) WITHOUT ROWID;
