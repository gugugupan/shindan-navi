"""Local preview for /events/: serves dist/ and a mock of the events API (contracts/README.md).

Dev only — never part of the build output. Events are the contract fixture plus deterministic
synthetic 【SAMPLE】 rows so filters, paging and the calendar have something to show.

  python3 -I scripts/build.py && python3 -I scripts/events_dev_server.py [--port 5261] [--fail] [--latency 300] [--empty-game CONAN]
"""
import argparse
import base64
import datetime as dt
import http.server
import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
FIXTURE = os.path.join(ROOT, 'contracts/fixtures/sample-events.json')
WINDOW = ('2026-11-18', '2027-02-18')
# the events games of data/games.json in /events/ order: (code, official name, slug)
GAMES = [(g['code'], g['official'], g['slug']) for g in sorted((g for g in json.load(open(os.path.join(ROOT, 'data/games.json')))
                                                              if g['sources']['events']), key=lambda g: g['sources']['events']['sort'])]
# where each game's events come from (contracts/README.md › Sources)
SOURCE = {'PTCG': ('pokemon_players', 'ptcg'), 'CONAN': ('conan_official', 'conan'),
          **{g: ('bushinavi', 'bnavi') for g in ('WS', 'VG', 'SVE', 'HOCG', 'LLOCG')}}
PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
         '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
         '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
         '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
CITY = {'JP-13': ['新宿区', '豊島区', '千代田区', '立川市'], 'JP-14': ['横浜市西区', '川崎市川崎区'], 'JP-27': ['大阪市北区', '大阪市浪速区', '堺市'],
        'JP-23': ['名古屋市中区', '豊橋市'], 'JP-40': ['福岡市博多区', '北九州市'], 'JP-01': ['札幌市中央区'], 'JP-04': ['仙台市青葉区'],
        'JP-11': ['さいたま市大宮区'], 'JP-12': ['千葉市中央区', '船橋市'], 'JP-26': ['京都市下京区'], 'JP-28': ['神戸市中央区'], 'JP-34': ['広島市中区'],
        'JP-47': ['那覇市']}
TYPES = {
    'OPCG': [('standard_battle', 'スタンダードバトル', 'tournament'), ('flagship_battle', 'フラッグシップバトル', 'tournament'),
             ('teaching', 'ティーチング会', 'teaching'), ('treasure_cup', 'トレジャーカップ', 'festival')],
    'UATCG': [('union_battle', 'ユニオンバトル', 'tournament'), ('meetup', 'フリー対戦会', 'casual')],
    'CONAN': [('store_battle', '店舗大会', 'tournament')],
    'PTCG': [('gym_battle', 'ジムバトル', 'tournament'), ('city_league', 'シティリーグ', 'tournament'),
             ('trainers_league', 'トレーナーズリーグ', 'casual'), ('beginners', 'はじめてのポケカ体験会', 'teaching')],
    'GCG': [('newtype_challenge', 'ニュータイプチャレンジ', 'tournament')],
    'DBFW': [('flagship_battle', 'フラッグシップバトル', 'tournament')],
    'BS': [('shop_battle', 'ショップバトル', 'tournament')],
    'DCG': [('tamer_battle', 'テイマーバトル', 'tournament')],
    'WS': [('shop_tournament', 'ショップ大会', 'tournament'), ('cx_challenge', 'CXチャレンジ', 'tournament')],
    'VG': [('shop_tournament', 'ショップ大会', 'tournament'), ('meetup', '交流会', 'casual')],
    'SVE': [('shop_tournament', 'ショップ大会', 'tournament'), ('limited_format', '限定構築', 'tournament')],
    'HOCG': [('shop_tournament', 'ショップ大会', 'tournament'), ('meetup', '交流会', 'casual'), ('bloom_cup', 'ブルームカップ', 'tournament')],
    'LLOCG': [('shop_tournament', 'ショップ大会', 'tournament'), ('shop_support', '公認店サポート', 'tournament')],
}
SHOPS = ['カードショップ', 'ホビーショップ', 'トレカ専門店', 'ゲームセンター', '書店']


def jd(s):
    return dt.date.fromisoformat(s)


def synth(empty_games):
    rnd = random.Random(20261118)
    out = []
    start, end = jd(WINDOW[0]), jd(WINDOW[1])
    weights = [13] * 6 + [1] * 41
    prefs = [f'JP-{i:02d}' for i in range(1, 48)]
    busy = ['JP-13', 'JP-14', 'JP-27', 'JP-23', 'JP-40', 'JP-11', 'JP-12', 'JP-01', 'JP-04', 'JP-26', 'JP-28', 'JP-34', 'JP-47']
    n = 0
    day = start
    while day < end:
        per_day = 4 + (6 if day.weekday() >= 5 else 0) + rnd.randint(0, 3)
        for _ in range(per_day):
            game = rnd.choice(['OPCG', 'OPCG', 'PTCG', 'PTCG', 'PTCG', 'UATCG', 'CONAN', 'GCG', 'DBFW', 'BS', 'DCG',
                               'WS', 'VG', 'SVE', 'HOCG', 'HOCG', 'LLOCG'])
            if game in empty_games:
                continue
            code, tname, cat = rnd.choice(TYPES[game])
            n += 1
            online = rnd.random() < .06
            pref = rnd.choice(busy) if rnd.random() < .8 else rnd.choice(prefs)
            pi = int(pref[3:]) - 1
            city = rnd.choice(CITY.get(pref, [PREFS[pi][:-1] + '市']))
            dated = game == 'PTCG' and rnd.random() < .3
            hour = rnd.choice([10, 11, 13, 14, 15, 18])
            fee = rnd.choice([0, 300, 500, 500, 1000, None, None])
            reg = rnd.choice(['open', 'open', 'not_open', 'closed', 'waitlist', 'unknown', 'unknown'])
            status = 'cancelled' if rnd.random() < .03 else 'postponed' if rnd.random() < .02 else 'scheduled'
            src, prefix = SOURCE.get(game, ('bandai_tcg_plus', 'tcgp'))
            ext = f'synth{n:05d}'
            eid = f'{prefix}:{ext}'
            venue = None if online else {
                'name': f'SAMPLE {rnd.choice(SHOPS)} {city.replace("市", "")}{rnd.choice(["店", "本店", "駅前店"])}', 'source_id': None,
                'country_code': 'JP', 'region_code': pref, 'region_name': PREFS[pi], 'city': city, 'address': None, 'postal_code': None}
            out.append({
                'id': eid, 'game_code': game, 'source_code': src, 'external_id': ext,
                'source_url': f'https://example.com/{prefix}/{ext}',
                'group': {'source_id': None, 'name': tname, 'category': cat, 'event_type_code': code if rnd.random() < .9 else None},
                'name': f'【SAMPLE】{tname}' + (f'（{rnd.choice(["スタンダード", "エクストラ", "初心者歓迎"])}）' if rnd.random() < .5 else ''),
                'attendance_mode': 'online' if online else ('hybrid' if rnd.random() < .02 else 'in_person'), 'venue': venue,
                'starts_on': day.isoformat(), 'ends_on': None,
                'starts_at': None if dated else f'{day.isoformat()}T{hour:02d}:00:00+09:00',
                'ends_at': None if dated or rnd.random() < .5 else f'{day.isoformat()}T{hour + 3:02d}:00:00+09:00',
                'timezone': 'Asia/Tokyo', 'time_precision': 'date' if dated else 'datetime',
                'format_text': None, 'eligibility_text': None,
                'capacity': rnd.choice([8, 16, 16, 24, 32, 64, None]),
                'fee_amount': fee, 'fee_currency': 'JPY' if fee is not None else None, 'fee_text': None if fee is None else ('無料' if fee == 0 else f'{fee}円'),
                'registration_method': rnd.choice(['first_come', 'lottery', 'walk_in', 'unknown']),
                'registration_platform': None, 'registration_url': None,
                'registration_opens_at': f'{(day - dt.timedelta(days=14)).isoformat()}T12:00:00+09:00' if reg == 'not_open' else None,
                'registration_closes_at': None, 'registration_status': reg, 'event_status': status,
                'source_status_text': 'SAMPLE', 'last_seen_at': '2026-11-18T00:00:00Z'})
        day += dt.timedelta(days=1)
    return out


def sort_key(e):
    return (e['starts_on'], e['starts_at'] is None, e['starts_at'] or '', e['id'])


class Api:
    def __init__(self, empty_games):
        fixture = json.load(open(FIXTURE, encoding='utf-8'))
        self.events = sorted([e for e in fixture if e['game_code'] not in empty_games] + synth(empty_games), key=sort_key)
        self.empty = empty_games
        self.force_count = None
        for i, e in enumerate(self.events):
            # every 25th Bandai event is shared by OPCG and UATCG, like TCG+ shared series
            e['game_codes'] = ['OPCG', 'UATCG'] if e['game_code'] in ('OPCG', 'UATCG') and i % 25 == 0 else [e['game_code']]
            e['game_code'] = e['game_codes'][0]

    def meta(self):
        ev = self.events
        cnt = lambda f: {k: sum(1 for e in ev if f(e) == k) for k in {f(e) for e in ev}}
        games = []
        for code, name, slug in GAMES:
            n = sum(1 for e in ev if code in e['game_codes'])
            has = n > 0
            games.append({'code': code, 'name': name, 'slug': slug, 'record_count': n,
                          'fetched_at': '2026-11-18T00:12:00Z' if has else None, 'complete': has and code != 'UATCG',
                          'window': {'from': WINDOW[0], 'until': WINDOW[1]} if has else None})
        pc = cnt(lambda e: e['venue'] and e['venue']['region_code'])
        types = {}
        for e in ev:
            c = e['group']['event_type_code']
            if c:
                k = (e['game_codes'][0], c)
                types.setdefault(k, {'game_code': k[0], 'code': c, 'name': e['group']['name'], 'count': 0})['count'] += 1
        return {'games': games,
                'prefectures': [{'code': f'JP-{i + 1:02d}', 'name': p, 'count': pc.get(f'JP-{i + 1:02d}', 0)} for i, p in enumerate(PREFS)],
                'categories': [{'code': k, 'count': v} for k, v in sorted(cnt(lambda e: e['group']['category']).items())],
                'types': sorted(types.values(), key=lambda t: (t['game_code'], -t['count']))}

    def query(self, q, days_only=False):
        one = lambda k: (q.get(k) or [''])[0]
        lst = lambda k: [x for x in one(k).split(',') if x]
        f, u = one('from'), one('until')
        try:
            fd, ud = jd(f), jd(u)
        except ValueError:
            return 400, {'error': 'from and until are required (YYYY-MM-DD)'}
        if ud <= fd or (ud - fd).days > 92:
            return 400, {'error': 'until must be after from and at most 92 days later'}
        days = set()
        for d in lst('days'):
            days |= {0, 6} if d == 'weekend' else {1, 2, 3, 4, 5} if d == 'weekday' else {int(d)} if d.isdigit() else set()
        games, prefs, cats, types = set(lst('game')), set(lst('pref')), set(lst('category')), set(lst('type'))
        fees, regs, modes = set(lst('fee')), set(lst('registration')), set(lst('mode'))

        def ok(e):
            if not (f <= e['starts_on'] < u): return False
            if games and not games & set(e['game_codes']): return False
            if prefs and not (e['venue'] and e['venue']['region_code'] in prefs): return False
            if cats and e['group']['category'] not in cats: return False
            if types and e['group']['event_type_code'] not in types: return False
            if days and (jd(e['starts_on']).isoweekday() % 7) not in days: return False
            if fees:
                fa = e['fee_amount']
                if ('free' if fa == 0 else 'unknown' if fa is None else 'paid') not in fees: return False
            if regs and e['registration_status'] not in regs: return False
            if modes and e['attendance_mode'] not in (modes | ({'hybrid'} if modes & {'in_person', 'online'} else set())): return False
            return True
        hits = [e for e in self.events if ok(e)]
        if days_only:
            out = []
            for e in hits:
                if not out or out[-1]['date'] != e['starts_on']:
                    out.append({'date': e['starts_on'], 'count': 0, 'by_game': {}, 'by_game_type': {}})
                out[-1]['count'] += 1
                t = e['group']['event_type_code'] or ''
                for g in e['game_codes']:
                    out[-1]['by_game'][g] = out[-1]['by_game'].get(g, 0) + 1
                    bt = out[-1]['by_game_type'].setdefault(g, {})
                    bt[t] = bt.get(t, 0) + 1
            return 200, {'days': out}
        try:
            limit = max(1, min(200, int(one('limit') or 100)))
            off = int(base64.urlsafe_b64decode(one('cursor')).decode()) if one('cursor') else 0
        except ValueError:
            return 400, {'error': 'bad limit or cursor'}
        page = hits[off:off + limit]
        nxt = base64.urlsafe_b64encode(str(off + limit).encode()).decode() if off + limit < len(hits) else None
        return 200, {'events': page, 'next_cursor': nxt, 'count': self.force_count if self.force_count is not None else min(len(hits), 10000)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5261)
    ap.add_argument('--fail', action='store_true', help='answer every API call with 500')
    ap.add_argument('--latency', type=int, default=0, help='ms delay on API calls')
    ap.add_argument('--empty-game', action='append', default=['CONAN'], help='game code with no data (default CONAN)')
    ap.add_argument('--report-count', type=int, help='force /events count to this value (e.g. 10000 to test the capped display)')
    ap.add_argument('--api-proxy', help='forward /api/* to a running API instead of the mock, e.g. http://localhost:8787')
    ap.add_argument('--fail-days', action='store_true', help='answer /events/days with 500')
    args = ap.parse_args()
    api = Api(set(args.empty_game))
    if args.report_count is not None:
        api.force_count = args.report_count

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=DIST, **k)

        def do_GET(self):
            p = urllib.parse.urlparse(self.path)
            if not p.path.startswith('/api/'):
                return super().do_GET()
            time.sleep(args.latency / 1000)
            if args.api_proxy:
                try:
                    with urllib.request.urlopen(args.api_proxy.rstrip('/') + self.path, timeout=30) as r:
                        code, raw = r.status, r.read()
                except urllib.error.HTTPError as e:
                    code, raw = e.code, e.read()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            if args.fail:
                code, body = 500, {'error': 'mock failure'}
            elif p.path == '/api/v1/events/meta':
                code, body = 200, api.meta()
            elif p.path == '/api/v1/events/days' and args.fail_days:
                code, body = 500, {'error': 'mock failure'}
            elif p.path == '/api/v1/events/days':
                code, body = api.query(urllib.parse.parse_qs(p.query), days_only=True)
            elif p.path == '/api/v1/events':
                code, body = api.query(urllib.parse.parse_qs(p.query))
            else:
                code, body = 404, {'error': 'not found'}
            raw = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    print(f'http://localhost:{args.port}/events/  ({len(api.events)} mock events)')
    http.server.ThreadingHTTPServer(('127.0.0.1', args.port), H).serve_forever()


if __name__ == '__main__':
    main()
