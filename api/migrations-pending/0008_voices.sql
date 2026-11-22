-- 話題カレンダー snapshots (docs/design/voices-db.md). Pending: the owner moves this file to api/migrations/ and applies it
-- by hand; until then the events importer's automatic `migrations apply` cannot pick it up. IF NOT EXISTS keeps a
-- later `migrations apply` harmless where the file was already run with `d1 execute --file`.
-- body = one snapshot as api/scripts/import-voices.mjs validated it: {"date","window","topics"} (contract shape minus
-- version / note / sample). hash = sha256 hex of body. A date without topics has no row.
CREATE TABLE IF NOT EXISTS voice_snapshots (
  date TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  body TEXT NOT NULL CHECK (json_valid(body)),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- 'version': bumped by every import that writes, part of the /api/v1/voices* cache keys. Its own table, not site_meta,
-- so the events importer (which reads every site_meta row) never sees it.
CREATE TABLE IF NOT EXISTS voice_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
