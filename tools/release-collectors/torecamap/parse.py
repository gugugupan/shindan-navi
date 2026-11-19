"""トレカの地図 release schedule (https://torecamap.co.jp/release-schedule), this month and the next five."""
import html
import re
import urllib.parse

from lib.common import fetch, game_name

TORECAMAP_URL = 'https://torecamap.co.jp/release-schedule?year={y}&month={m}'
TORECAMAP_MONTHS = 6


def parse_torecamap(today, unknown):
    out, seen = [], set()
    y, m = today.year, today.month
    for _ in range(TORECAMAP_MONTHS):
        s = fetch(TORECAMAP_URL.format(y=y, m=m)).decode('utf-8')
        for g in re.split(r'class="ReleaseScheduleDayGroup_release-schedule-day-group', s)[1:]:
            dm = re.search(r'ReleaseScheduleDayGroup_text__\w+">(\d+)/(\d+)/(\d+)', g)
            if not dm:
                continue
            date = '%04d-%02d-%02d' % tuple(map(int, dm.groups()))
            for it in re.split(r'ReleaseScheduleDayGroup_item__', g)[1:]:
                name = re.search(r'ProductInfo_name__\w+">(.*?)</div>', it, re.S)
                if not name:
                    continue  # RSC payload duplicate, not rendered HTML
                name = html.unescape(re.sub(r'<[^>]+>', '', name.group(1))).replace('​', '').strip()
                if (date, name) in seen:
                    continue
                seen.add((date, name))
                tag = re.search(r'Tag_tag__[^"]*">([^<]*)', it)
                href = re.search(r'<a href="([^"]*)"', it)
                img = re.search(r'src="/_next/image\?url=([^&"]*)', it)
                img = urllib.parse.unquote(img.group(1)) if img else ''
                prices = dict(re.findall(r'ProductInfo_label__\w+">([^<]*)</p><span class="ProductInfo_price__\w+">([^<]*)', it))
                out.append(dict(date=date, game=game_name(html.unescape(tag.group(1)) if tag else '', unknown), name=name,
                                pack=prices.get('1パック：', ''), box=prices.get('1BOX：', '').replace('値段設定なし', ''),
                                url=html.unescape(href.group(1)) if href else '', img='' if 'no-image' in img else img, src='torecamap'))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out
