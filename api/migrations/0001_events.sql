-- Event query layer. Source of truth is data/events/ in git; this database can be rebuilt from it.
-- Sized for the D1 Free plan: one wide events table (no joins at query time), one secondary index and
-- precomputed meta. The importer diffs against the current rows and writes only what changed.

CREATE TABLE games (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL,
  -- Bit in events.game_mask.
  bit INTEGER NOT NULL UNIQUE
) WITHOUT ROWID;

INSERT INTO games (code, name, slug, sort_order, bit) VALUES
  ('OPCG', 'ONE PIECEカードゲーム', 'onepiece', 1, 1),
  ('UATCG', 'UNION ARENA', 'unionarena', 2, 2),
  ('CONAN', '名探偵コナン カードゲーム', 'conan', 3, 4),
  ('PTCG', 'ポケモンカードゲーム', 'pokemon', 4, 8);

-- One row per accepted run (data/events/<GAME>/_run.json) loaded into this database.
CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  game_code TEXT NOT NULL REFERENCES games(code),
  source_code TEXT NOT NULL CHECK (source_code IN ('bandai_tcg_plus', 'pokemon_players', 'conan_official')),
  fetched_at TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_until TEXT NOT NULL CHECK (window_until > window_from),
  source_total INTEGER,
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  collector_version TEXT NOT NULL,
  query_json TEXT NOT NULL,
  notes_json TEXT NOT NULL,
  run_hash TEXT NOT NULL,
  imported_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Group and venue are stored inline: joins would cost a row read per event on D1.
CREATE TABLE events (
  id TEXT PRIMARY KEY CHECK (id GLOB 'tcgp:?*' OR id GLOB 'ptcg:?*' OR id GLOB 'conan:?*'),
  -- Games currently listing the event (games.bit); 0 hides it. A complete run clears its own bit on
  -- events in its window that it no longer lists.
  game_mask INTEGER NOT NULL CHECK (game_mask BETWEEN 0 AND 15),
  -- Location filter key: the venue's region_code, or 'online' for events without a venue.
  loc TEXT CHECK (loc IS NULL OR loc = 'online' OR loc GLOB 'JP-[0-4][0-9]'),
  source_code TEXT NOT NULL CHECK (source_code IN ('bandai_tcg_plus', 'pokemon_players', 'conan_official')),
  external_id TEXT NOT NULL CHECK (length(external_id) > 0),
  source_url TEXT NOT NULL CHECK (source_url GLOB 'https://*'),
  group_source_id TEXT,
  group_name TEXT NOT NULL CHECK (length(group_name) > 0),
  category TEXT NOT NULL CHECK (category IN ('tournament', 'casual', 'teaching', 'festival', 'other', 'unknown')),
  event_type_code TEXT CHECK (event_type_code IS NULL OR (length(event_type_code) > 0 AND event_type_code NOT GLOB '*[^a-z0-9_]*')),
  name TEXT NOT NULL CHECK (length(name) > 0),
  attendance_mode TEXT NOT NULL CHECK (attendance_mode IN ('in_person', 'online', 'hybrid', 'unknown')),
  -- event.venue as JSON in contract key order, or NULL.
  venue_json TEXT,
  region_code TEXT CHECK (region_code IS NULL OR region_code GLOB 'JP-[0-4][0-9]'),
  starts_on TEXT NOT NULL CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ends_on TEXT CHECK (ends_on IS NULL OR (ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ends_on >= starts_on)),
  starts_at TEXT,
  ends_at TEXT,
  -- Unix seconds of starts_at; 253402300799 (9999-12-31T23:59:59Z) when starts_at is null so
  -- date-only events sort last within their day.
  starts_sort INTEGER NOT NULL,
  timezone TEXT NOT NULL CHECK (length(timezone) > 0),
  time_precision TEXT NOT NULL CHECK (time_precision IN ('date', 'datetime')),
  format_text TEXT,
  eligibility_text TEXT,
  capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0),
  fee_amount INTEGER CHECK (fee_amount IS NULL OR fee_amount >= 0),
  fee_currency TEXT CHECK (fee_currency IS NULL OR fee_currency GLOB '[A-Z][A-Z][A-Z]'),
  fee_text TEXT,
  registration_method TEXT NOT NULL CHECK (registration_method IN ('first_come', 'lottery', 'walk_in', 'invitation', 'other', 'unknown')),
  registration_platform TEXT CHECK (registration_platform IS NULL OR registration_platform IN ('bandai_tcg_plus', 'pokemon_players', 'conan_official', 'store', 'other')),
  registration_url TEXT CHECK (registration_url IS NULL OR registration_url GLOB 'https://*'),
  registration_opens_at TEXT,
  registration_closes_at TEXT,
  registration_status TEXT NOT NULL CHECK (registration_status IN ('not_open', 'open', 'waitlist', 'closed', 'unknown')),
  event_status TEXT NOT NULL CHECK (event_status IN ('scheduled', 'postponed', 'cancelled', 'completed', 'unknown')),
  source_status_text TEXT,
  -- sha1 of the event without game_code / last_seen_at; the row is rewritten only when it changes.
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (time_precision = 'date' OR starts_at IS NOT NULL)
) WITHOUT ROWID;

-- Every API query is "these locations, this date range", in list order.
CREATE INDEX idx_events_loc ON events(loc, starts_on, starts_sort);

-- 'meta': the /events/meta body without labels. 'state': {"version", "fetched_at": {game: iso}}.
-- Rewritten by every import that changes anything.
CREATE TABLE site_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
