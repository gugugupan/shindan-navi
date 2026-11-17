-- Event query layer. Source of truth is data/events/ in git; this database can be rebuilt from it.

CREATE TABLE games (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL,
  official_url TEXT
);

INSERT INTO games (code, name, slug, sort_order) VALUES
  ('OPCG', 'ONE PIECEカードゲーム', 'onepiece', 1),
  ('UATCG', 'UNION ARENA', 'unionarena', 2),
  ('CONAN', '名探偵コナン カードゲーム', 'conan', 3),
  ('PTCG', 'ポケモンカードゲーム', 'pokemon', 4);

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
);

CREATE INDEX idx_imports_game ON imports(game_code, imported_at);

-- Groups and events are not tied to one game: shared series (e.g. BANDAI CARD GAMES) list the same
-- event under several games. Game membership lives in event_games.
CREATE TABLE event_groups (
  id TEXT PRIMARY KEY,
  source_code TEXT NOT NULL CHECK (source_code IN ('bandai_tcg_plus', 'pokemon_players', 'conan_official')),
  source_id TEXT,
  name TEXT NOT NULL CHECK (length(name) > 0),
  category TEXT NOT NULL CHECK (category IN ('tournament', 'casual', 'teaching', 'festival', 'other', 'unknown')),
  event_type_code TEXT CHECK (event_type_code IS NULL OR (length(event_type_code) > 0 AND event_type_code NOT GLOB '*[^a-z0-9_]*')),
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_groups_type ON event_groups(event_type_code);

CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  source_code TEXT NOT NULL CHECK (source_code IN ('bandai_tcg_plus', 'pokemon_players', 'conan_official')),
  source_id TEXT,
  name TEXT NOT NULL CHECK (length(name) > 0),
  country_code TEXT CHECK (country_code IS NULL OR country_code GLOB '[A-Z][A-Z]'),
  region_code TEXT CHECK (region_code IS NULL OR region_code GLOB 'JP-[0-4][0-9]'),
  region_name TEXT,
  city TEXT,
  address TEXT,
  postal_code TEXT,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- region_code duplicates the venue's region so the prefecture filter can use an index.
CREATE TABLE events (
  id TEXT PRIMARY KEY CHECK (id GLOB 'tcgp:?*' OR id GLOB 'ptcg:?*' OR id GLOB 'conan:?*'),
  -- Sorted, comma-separated games whose membership is not missing; NULL hides the event.
  -- Derived from event_games by the importer.
  game_codes TEXT,
  event_group_id TEXT NOT NULL REFERENCES event_groups(id),
  venue_id TEXT REFERENCES venues(id),
  region_code TEXT CHECK (region_code IS NULL OR region_code GLOB 'JP-[0-4][0-9]'),
  source_code TEXT NOT NULL CHECK (source_code IN ('bandai_tcg_plus', 'pokemon_players', 'conan_official')),
  external_id TEXT NOT NULL CHECK (length(external_id) > 0),
  source_url TEXT NOT NULL CHECK (source_url GLOB 'https://*'),
  name TEXT NOT NULL CHECK (length(name) > 0),
  attendance_mode TEXT NOT NULL CHECK (attendance_mode IN ('in_person', 'online', 'hybrid', 'unknown')),
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
  last_seen_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (time_precision = 'date' OR starts_at IS NOT NULL),
  UNIQUE (source_code, external_id)
);

CREATE INDEX idx_events_region_date ON events(region_code, starts_on, starts_sort, id);
CREATE INDEX idx_events_date ON events(starts_on, starts_sort, id);
CREATE INDEX idx_events_group ON events(event_group_id);
CREATE INDEX idx_events_venue ON events(venue_id);

CREATE TABLE event_games (
  event_id TEXT NOT NULL REFERENCES events(id),
  game_code TEXT NOT NULL REFERENCES games(code),
  last_import_id TEXT NOT NULL REFERENCES imports(id),
  -- fetched_at of the first complete run of this game that no longer contained the event.
  missing_since TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, game_code)
);

CREATE INDEX idx_event_games_game ON event_games(game_code, last_import_id);
