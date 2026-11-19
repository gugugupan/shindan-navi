"""Helpers shared by the release collectors and scripts/update_data.py."""
import urllib.request

try:
    import truststore
except ImportError:  # scripts/refresh.py checks .venv for it
    pass
else:
    # Several official sites (Bandai's) serve incomplete chains; the OS verifier completes them via AIA, OpenSSL does not.
    truststore.inject_into_ssl()

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

# Source labels → one display name per title (both sites abbreviate differently).
GAME = {'MTG': 'MTG', 'ヴァイス': 'ヴァイスシュヴァルツ', 'D-CROSS': 'DIVINE CROSS', 'ポケモン': 'ポケモンカード', 'ヴァンガ': 'ヴァンガード',
        'ヴァンガード': 'ヴァンガード', 'バトスピ': 'バトルスピリッツ', 'ユニアリ': 'UNION ARENA', 'ラブカ': 'ラブライブ！OCG', '遊戯王': '遊戯王OCG',
        '遊戯王OCG': '遊戯王OCG', '遊戯王RD': '遊戯王ラッシュデュエル', 'ラッシュデュエル': '遊戯王ラッシュデュエル', 'パルワールド TCG': 'パルワールド',
        'デジモン': 'デジモン', 'X Stars': 'Xross Stars', 'クロスタ': 'Xross Stars', 'ウルトラマン': 'ウルトラマン', 'ビルディバイド': 'ビルディバイド',
        '神椿TCG': 'KAMITSUBAKI', 'ゴジラ': 'ゴジラ', 'ホロビートカードゲーム': 'ホロビート', 'ホロライブ': 'ホロライブ', 'DBS FW': 'DBフュージョンワールド',
        'DBFW': 'DBフュージョンワールド', 'シャドバ': 'Shadowverse EVOLVE', 'FF': 'FFTCG', 'Z/X': 'Z/X', 'バボカ': 'バボカ!!', 'ワンピース': 'ONE PIECE',
        'OSICA': 'OSICA', 'ファンスターズ': 'ファンスターズリーグ', 'その他': 'その他', 'Reバース': 'Reバース', 'WSブラウ': 'ヴァイスシュヴァルツブラウ',
        'ロルカナ': 'ロルカナ', 'デュエマ': 'デュエル・マスターズ', 'ACG': 'アニマルカードゲーム', 'Harry Potter': 'Harry Potter', 'Lycee': 'リセ',
        '五等分の花嫁': '五等分の花嫁', 'WIXOSS': 'WIXOSS', 'コナン': '名探偵コナン', '名探偵コナン': '名探偵コナン', 'ガンダム': 'ガンダム',
        'FaB': 'Flesh and Blood'}


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


def game_name(label, unknown):
    if label not in GAME:
        unknown.add(label)
    return GAME.get(label, label)
