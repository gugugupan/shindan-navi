export const GAMES = [
  { code: 'OPCG', name: 'ONE PIECEカードゲーム', slug: 'onepiece', bit: 1 },
  { code: 'UATCG', name: 'UNION ARENA', slug: 'unionarena', bit: 2 },
  { code: 'CONAN', name: '名探偵コナン カードゲーム', slug: 'conan', bit: 4 },
  { code: 'PTCG', name: 'ポケモンカードゲーム', slug: 'pokemon', bit: 8 },
  { code: 'GCG', name: 'ガンダムカードゲーム', slug: 'gundam', bit: 16 },
  { code: 'DBFW', name: 'ドラゴンボールスーパーカードゲーム フュージョンワールド', slug: 'dragonball', bit: 32 },
  { code: 'BS', name: 'バトルスピリッツ', slug: 'battlespirits', bit: 64 },
  { code: 'DCG', name: 'デジモンカードゲーム', slug: 'digimon', bit: 128 },
] as const;
export const GAME_CODES = GAMES.map((g) => g.code);
// events.game_mask allows bits 2^0..2^29 (migrations/0005): masks stay positive 32-bit integers in JS bit operations.
export const MAX_GAMES = 30;
export const ALL_GAME_BITS = GAMES.reduce((m, g) => m | g.bit, 0);
export const MAX_PREFS = 5;
export const CATEGORIES = ['tournament', 'casual', 'teaching', 'festival', 'other', 'unknown'] as const;

export const PREFECTURES: ReadonlyArray<readonly [string, string]> = [
  ['JP-01', '北海道'], ['JP-02', '青森県'], ['JP-03', '岩手県'], ['JP-04', '宮城県'], ['JP-05', '秋田県'],
  ['JP-06', '山形県'], ['JP-07', '福島県'], ['JP-08', '茨城県'], ['JP-09', '栃木県'], ['JP-10', '群馬県'],
  ['JP-11', '埼玉県'], ['JP-12', '千葉県'], ['JP-13', '東京都'], ['JP-14', '神奈川県'], ['JP-15', '新潟県'],
  ['JP-16', '富山県'], ['JP-17', '石川県'], ['JP-18', '福井県'], ['JP-19', '山梨県'], ['JP-20', '長野県'],
  ['JP-21', '岐阜県'], ['JP-22', '静岡県'], ['JP-23', '愛知県'], ['JP-24', '三重県'], ['JP-25', '滋賀県'],
  ['JP-26', '京都府'], ['JP-27', '大阪府'], ['JP-28', '兵庫県'], ['JP-29', '奈良県'], ['JP-30', '和歌山県'],
  ['JP-31', '鳥取県'], ['JP-32', '島根県'], ['JP-33', '岡山県'], ['JP-34', '広島県'], ['JP-35', '山口県'],
  ['JP-36', '徳島県'], ['JP-37', '香川県'], ['JP-38', '愛媛県'], ['JP-39', '高知県'], ['JP-40', '福岡県'],
  ['JP-41', '佐賀県'], ['JP-42', '長崎県'], ['JP-43', '熊本県'], ['JP-44', '大分県'], ['JP-45', '宮崎県'],
  ['JP-46', '鹿児島県'], ['JP-47', '沖縄県'],
];

// Short button labels per event_type_code (shared across games); codes without a label are shown as-is.
export const TYPE_LABELS: Record<string, string> = {
  standard_battle: 'スタンダードバトル',
  meetup: '交流会',
  gym_battle: 'ジムバトル',
  city_league: 'シティリーグ',
  major_tournament: '大型大会',
  trainers_league: 'トレーナーズリーグ',
  gym_event: 'ジムイベント',
  campaign: 'キャンペーン',
  organizer_event: 'オーガナイザーイベント',
  other: 'その他',
  championship: 'チャンピオンシップ',
  crew_battle: 'クルーバトル',
  eight_pack_battle: '8パックバトル',
  extra_grand_battle: 'エクストラグランドバトル',
  flagship_battle: 'フラッグシップバトル',
  flagship_battle_ex: 'フラッグシップバトルEX',
  matching_battle: 'マッチングバトル',
  release_event: '発売記念イベント',
  teaching: 'ティーチング会',
  championship_qualifier: 'CHAMPIONSHIP予選',
  one_battle_cup: 'ONE BATTLE CUP',
  unichike_get_battle: 'ユニチケゲットバトル',
  union_rare_battle: 'ユニオンレア争奪バトル',
  challenge: 'チャレンジ戦',
  fan_meeting: 'ファンミーティング',
  shop_battle: 'ショップバトル',
  tamer_battle: 'テイマーバトル',
  battlers_cup: 'バトラーズカップ',
  evolution_cup: 'エボリューションカップ',
  ultimate_battle: 'アルティメットバトル',
  ultimate_cup: 'アルティメットカップ',
  newtype_challenge: 'ニュータイプチャレンジ',
  team_battle: 'チーム戦',
  battleski_event: 'バトルスキー主催大会',
};
