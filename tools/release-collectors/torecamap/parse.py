"""トレカの地図 release schedule (https://torecamap.co.jp/release-schedule), this month and the next five."""
import html
import re
import urllib.parse

from lib.common import fetch, game_name

TORECAMAP_URL = 'https://torecamap.co.jp/release-schedule?year={y}&month={m}'
TORECAMAP_MONTHS = 6


def product_image(item):
    """The item's own <img> (rendered before its name), as an absolute http(s) URL, or ''.

    Only that one tag: an item chunk runs on to the next item or the page tail, which carries site decoration
    (/_next/image?url=%2Fimages%2Fsection-title-small.png after each month's last item)."""
    name = re.search(r'ProductInfo_name__', item)
    tag = re.search(r'<img\b[^>]*>', item[:name.start()] if name else '')
    src = re.search(r'\ssrc="([^"]*)"', tag.group(0)) if tag else None
    url = html.unescape(src.group(1)) if src else ''
    if url.startswith('/_next/image?'):
        url = urllib.parse.parse_qs(url.split('?', 1)[1]).get('url', [''])[0]
    if not re.match(r'https?://', url) or 'no-image' in url:
        return ''
    return url


def price(text):
    """`418円(税込)` → `418円`, `6688円` → `6,688円` (as カードラボ / yen_text write it); `値段設定なし` → ''."""
    text = re.sub(r'[(（]\s*税込\s*[)）]', '', html.unescape(text)).replace('値段設定なし', '').strip()
    m = re.fullmatch(r'(\d[\d,]*)\s*円', text)
    return f"{int(m.group(1).replace(',', '')):,}円" if m else text


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
                prices = dict(re.findall(r'ProductInfo_label__\w+">([^<]*)</p><span class="ProductInfo_price__\w+">([^<]*)', it))
                out.append(dict(date=date, game=game_name(html.unescape(tag.group(1)) if tag else '', unknown), name=name,
                                pack=price(prices.get('1パック：', '')), box=price(prices.get('1BOX：', '')),
                                url=html.unescape(href.group(1)) if href else '', img=product_image(it), src='torecamap'))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out
