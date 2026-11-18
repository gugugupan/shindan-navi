-- Visible events per location, day, game mask and event type, maintained by the importer. /events/days reads this
-- instead of the events rows: a month of five large prefectures is ~1.4k rows here versus ~10k events.
-- event_type_code is '' for events without a type (primary-key columns of a WITHOUT ROWID table cannot be NULL).
CREATE TABLE day_counts (
  loc TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  game_mask INTEGER NOT NULL CHECK (game_mask BETWEEN 1 AND 15),
  event_type_code TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n > 0),
  PRIMARY KEY (loc, starts_on, game_mask, event_type_code)
) WITHOUT ROWID;
