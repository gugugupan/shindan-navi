"""Item source identity: where a release comes from on its original site, used to de-duplicate releases.

source = {"url": canonical page URL, "key": official product code or normalised name, "site": "official" | "aggregator"}
Two records are the same release when url + key match, or when they share an official product code within a title.
"""
import re
import unicodedata
import urllib.parse

# official domains per title; a product link on one of these is an official source
OFFICIAL_SITES = ['pokemon-card.com', 'onepiece-cardgame.com', 'mtg-jp.com', 'magic.wizards.com', 'yugioh-card.com', 'yu-gi-oh.jp',
                  'konami.com', 'takaratomy.co.jp', 'ws-tcg.com', 'ws-rose.com', 'ws-blau.com', 'cf-vanguard.com', 'battlespirits.com',
                  'lycee-tcg.com', 'square-enix-shop.com', 'zxtcg.com', 'rebirth-fy.com', 'digimoncard.com', 'divinecross.jp',
                  'shadowverse-evolve.com', 'osicatcg.com', 'build-divide.com', 'unionarena-tcg.com', 'fabtcg.com', 'dbs-cardgame.com',
                  '5hanayome-cardgame.com', 'ultraman-cardgame.com', 'llofficial-cardgame.com', 'gundam-gcg.com', 'godzilla-cardgame.com',
                  'kamitsubaki.jp', 'xross-stars.com', 'acgtcg.com', 'fanstars-league.com', 'movic.jp', 'palworld-official-cardgame.com',
                  'mlptcg-jp.com', 'dm.takaratomy.co.jp']
TRACKING = re.compile(r'^(utm_|fbclid|gclid|_ga)')
# bracketed codes: 【OP-18】 [GD07] 【EX-13】 [26RBS03] 【UA57BT】 【HB-BP01】
BRACKETED = re.compile(r'[【\[［(（]\s*([A-Z0-9]{2,8}(?:-[A-Z0-9]{1,8}){0,3})\s*[】\]］)）]')
# leading codes: VG-DZ-BT17 DM26-EX4 HV-D04 CT-P11 IG16 BS77
LEADING = re.compile(r'(?<![A-Za-z0-9])([A-Z]{1,4}\d{0,3}(?:-[A-Z]{0,4}\d{0,3}[A-Z]?){1,3}|(?:IG|BS|BT|ST|EB|OP|EX)\d{1,3})(?![A-Za-z0-9])')


def norm(text):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', text or '')).lower()


def canonical_url(url):
    if not url:
        return ''
    p = urllib.parse.urlsplit(url.strip())
    host = p.netloc.lower().removeprefix('www.')
    path = re.sub(r'/index\.(html?|php)$', '/', p.path or '/')
    if path != '/':
        path = path.rstrip('/')
    query = urllib.parse.urlencode([(k, v) for k, v in urllib.parse.parse_qsl(p.query) if not TRACKING.match(k)])
    return urllib.parse.urlunsplit(('https', host, path, query, p.fragment))


def is_official(url):
    host = urllib.parse.urlsplit(url or '').netloc.lower().removeprefix('www.')
    return any(host == d or host.endswith('.' + d) for d in OFFICIAL_SITES)


def product_code(name):
    """Official product code in a release name (OP-18, EB-05, UA57BT …), or ''."""
    text = unicodedata.normalize('NFKC', name or '').upper()
    for rx in (BRACKETED, LEADING):
        for m in rx.finditer(text):
            code = m.group(1)
            if re.search(r'\d', code) and re.search(r'[A-Z]', code) and not re.fullmatch(r'\d+[A-Z]?', code):
                return code
    return ''


def make_source(url, name, site=None):
    url = canonical_url(url)
    return {'url': url, 'key': product_code(name) or norm(name), 'site': site or ('official' if is_official(url) else 'aggregator')}


def same_release(a, b, game_a=None, game_b=None):
    """True when two source records point at the same release."""
    if not a or not b:
        return False
    if a.get('url') and a.get('url') == b.get('url') and a.get('key') == b.get('key'):
        return True
    ca, cb = product_code(a.get('key', '')), product_code(b.get('key', ''))
    return bool(ca) and ca == cb and (game_a is None or game_a == game_b)
