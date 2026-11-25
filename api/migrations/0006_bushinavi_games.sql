-- Five Bushiroad games from Bushi Navi (source `bushinavi`, ids `bnavi:<event id>`): game bits 256-4096.
-- 0005 already loosened the CHECKs (game_mask up to 2^30-1, source columns shape-only), so this only adds the
-- `games` rows that imports.game_code references: 5 rows written on D1.

INSERT INTO games (code, name, slug, sort_order, bit) VALUES
  ('WS', 'ヴァイスシュヴァルツ', 'weiss', 9, 256),
  ('VG', 'カードファイト!! ヴァンガード', 'vanguard', 10, 512),
  ('SVE', 'Shadowverse EVOLVE', 'shadowverse-evolve', 11, 1024),
  ('HOCG', 'hololive OFFICIAL CARD GAME', 'hololive', 12, 2048),
  ('LLOCG', 'ラブライブ！シリーズ オフィシャルカードゲーム', 'lovelive', 13, 4096);
