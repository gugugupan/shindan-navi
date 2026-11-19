"""カードラボ daily release tables (https://www.c-labo.jp/special/2028/)."""
import datetime
import html
import re

from lib.common import fetch, game_name

CLABO_URL = 'https://www.c-labo.jp/special/2028/'


def parse_clabo(today, unknown):
    s = fetch(CLABO_URL).decode('utf-8')
    a, b = s.find('id="hatsubai_daily"'), s.find('id="hatsubai_cate"')
    if a < 0 or b < 0:
        raise RuntimeError('カードラボ: daily section not found (page layout changed?)')
    out = []
    for blk in re.split(r'<h3>', s[a:b])[1:]:
        m = re.match(r'(\d+)月(\d+)日\((.)\)', blk)
        if not m:
            continue
        mo, dy, dow = int(m.group(1)), int(m.group(2)), m.group(3)
        # headings carry no year; pick the one (this year or next) whose weekday matches
        year = next((y for y in (today.year, today.year + 1, today.year - 1)
                     if _valid(y, mo, dy) and '月火水木金土日'[datetime.date(y, mo, dy).weekday()] == dow), None)
        if year is None:
            continue
        date = datetime.date(year, mo, dy).isoformat()
        for tr in re.findall(r'<tr>(.*?)</tr>', blk, re.S):
            tds = [html.unescape(re.sub(r'<[^>]+>', '', x)).strip() for x in re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S)]
            if len(tds) < 2 or not tds[1]:
                continue
            out.append(dict(date=date, game=game_name(tds[0], unknown), name=tds[1], pack=tds[2] if len(tds) > 2 else '',
                            box='', url='', img='', src='clabo'))
    return out


def _valid(y, m, d):
    try:
        datetime.date(y, m, d)
        return True
    except ValueError:
        return False
