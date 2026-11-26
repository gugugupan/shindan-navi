-- user_prefs gains the key 'personal_calendar' (the home page's マイカレンダー). SQLite cannot change a CHECK in place:
-- rebuild the table with the same columns, key and foreign key, and copy every row (value_json, updated_at) verbatim.
PRAGMA defer_foreign_keys = true;

CREATE TABLE user_prefs_new (
  user_id TEXT NOT NULL REFERENCES users (id),
  key TEXT NOT NULL CHECK (key IN ('stars', 'event_filters', 'ask_calendar', 'personal_calendar')),
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
) WITHOUT ROWID;

INSERT INTO user_prefs_new (user_id, key, value_json, updated_at)
  SELECT user_id, key, value_json, updated_at FROM user_prefs;

DROP TABLE user_prefs;
ALTER TABLE user_prefs_new RENAME TO user_prefs;
