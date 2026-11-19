-- Four more TCG+ games (Bandai): game bits 16-128. SQLite cannot change a CHECK constraint in place, so events and
-- day_counts are rebuilt once with room for 30 games (bits 2^0..2^29; JS bit operations are 32-bit signed, so 2^30 and
-- up are left out). On D1 this copies every row (~2 rows written per event for the
-- row and its idx_events_loc entry, plus 1 per day_counts row): apply it on a day without an event import, see
-- api/README.md › D1 budget.

INSERT INTO games (code, name, slug, sort_order, bit) VALUES
  ('GCG', 'ガンダムカードゲーム', 'gundam', 5, 16),
  ('DBFW', 'ドラゴンボールスーパーカードゲーム フュージョンワールド', 'dragonball', 6, 32),
  ('BS', 'バトルスピリッツ', 'battlespirits', 7, 64),
  ('DCG', 'デジモンカードゲーム', 'digimon', 8, 128);

CREATE TABLE events_new (
  id TEXT PRIMARY KEY CHECK (id GLOB 'tcgp:?*' OR id GLOB 'ptcg:?*' OR id GLOB 'conan:?*'),
  game_mask INTEGER NOT NULL CHECK (game_mask BETWEEN 0 AND 1073741823),
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
  venue_json TEXT,
  region_code TEXT CHECK (region_code IS NULL OR region_code GLOB 'JP-[0-4][0-9]'),
  starts_on TEXT NOT NULL CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ends_on TEXT CHECK (ends_on IS NULL OR (ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ends_on >= starts_on)),
  starts_at TEXT,
  ends_at TEXT,
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
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (time_precision = 'date' OR starts_at IS NOT NULL)
) WITHOUT ROWID;

INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX idx_events_loc ON events(loc, starts_on, starts_sort);

CREATE TABLE day_counts_new (
  loc TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  game_mask INTEGER NOT NULL CHECK (game_mask BETWEEN 1 AND 1073741823),
  event_type_code TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n > 0),
  PRIMARY KEY (loc, starts_on, game_mask, event_type_code)
) WITHOUT ROWID;
INSERT INTO day_counts_new SELECT * FROM day_counts;
DROP TABLE day_counts;
ALTER TABLE day_counts_new RENAME TO day_counts;
