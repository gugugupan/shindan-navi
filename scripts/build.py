import json,sys,os,urllib.parse,shutil,html,datetime,re
OFFICIAL={'遊戯王OCG':'https://www.yugioh-card.com/japan/','ヴァイスシュヴァルツ':'https://ws-tcg.com/','ヴァンガード':'https://cf-vanguard.com/tcg/',
'MTG':'https://mtg-jp.com/','バトルスピリッツ':'https://www.battlespirits.com/','デュエル・マスターズ':'https://dm.takaratomy.co.jp/','リセ':'https://lycee-tcg.com/',
'ポケモンカード':'https://www.pokemon-card.com/','FFTCG':'https://www.square-enix-shop.com/jp/ff-tcg/','Z/X':'https://www.zxtcg.com/',
'WIXOSS':'https://www.takaratomy.co.jp/products/wixoss/','バボカ!!':'https://www.takaratomy.co.jp/products/haikyuvobacabreak/','Reバース':'https://rebirth-fy.com/',
'デジモン':'https://digimoncard.com/','遊戯王ラッシュデュエル':'https://www.konami.com/yugioh/rushduel/','DIVINE CROSS':'https://divinecross.jp/',
'Shadowverse EVOLVE':'https://shadowverse-evolve.com/','ONE PIECE':'https://www.onepiece-cardgame.com/','OSICA':'https://www.osicatcg.com/',
'ヴァイスシュヴァルツブラウ':'https://ws-blau.com/','ビルディバイド':'https://tcg.build-divide.com/bright','UNION ARENA':'https://www.unionarena-tcg.com/jp/',
'Flesh and Blood':'https://fabtcg.com/jp','DBフュージョンワールド':'https://www.dbs-cardgame.com/fw/jp/','名探偵コナン':'https://www.takaratomy.co.jp/products/conan-cardgame/',
'五等分の花嫁':'https://5hanayome-cardgame.com/','ウルトラマン':'https://ultraman-cardgame.com/page/jp/top','ラブライブ！OCG':'https://llofficial-cardgame.com/',
'ロルカナ':'https://www.takaratomy.co.jp/products/disneylorcana/','ガンダム':'https://www.gundam-gcg.com/jp/','ゴジラ':'https://godzilla-cardgame.com/',
'KAMITSUBAKI':'https://tcg.kamitsubaki.jp/','Xross Stars':'https://xross-stars.com/','アニマルカードゲーム':'https://acgtcg.com/',
'ファンスターズリーグ':'https://www.fanstars-league.com/','Harry Potter':'https://tcg.movic.jp/harrypotter/','パルワールド':'https://palworld-official-cardgame.com/',
'ホロビート':'https://www.takaratomy.co.jp/products/horobeat-cardgame/'}
OFFDOM=[urllib.parse.urlparse(u).netloc.replace('www.','') for u in OFFICIAL.values()]+['ws-rose.com','magic.wizards.com','pokemon-card.com']

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GA_ID=os.environ.get('GA_ID','')
SITE_HOST='shindan-navi.app'
SITE=f'https://{SITE_HOST}'
META=json.load(open(os.path.join(ROOT,'data/meta.json')))
UPDATED=META['updated']
TODAY=os.environ.get('BUILD_TODAY') or datetime.date.today().isoformat()
DOW='月火水木金土日'

# slug, data game key, official name, common short name
GAMES=[('pokemon','ポケモンカード','ポケモンカードゲーム','ポケカ'),
       ('onepiece','ONE PIECE','ONE PIECEカードゲーム','ワンピカード'),
       ('mtg','MTG','マジック：ザ・ギャザリング','MTG'),
       ('yugioh','遊戯王OCG','遊戯王OCG デュエルモンスターズ','遊戯王'),
       ('duelmasters','デュエル・マスターズ','デュエル・マスターズ','デュエマ'),
       ('weiss','ヴァイスシュヴァルツ','ヴァイスシュヴァルツ','ヴァイス'),
       ('unionarena','UNION ARENA','UNION ARENA','ユニアリ'),
       ('gundam','ガンダム','ガンダムカードゲーム','ガンダムカード'),
       ('dragonball','DBフュージョンワールド','ドラゴンボールスーパーカードゲーム フュージョンワールド','フュージョンワールド'),
       ('digimon','デジモン','デジモンカードゲーム','デジカ')]

# Prices come as 6600円(税込) / 6,050円 / 240円 depending on the source; pages say once that prices include tax.
def price_label(s):
    s=re.sub(r'\s*[（(]税込み?\s*(?:\d+\s*[%％])?[)）]','',s or '').strip()
    return re.sub(r'(?<![\d,.])\d{4,}(?=円)',lambda m:f'{int(m.group()):,}',s)
for _a,_b in [('6600円(税込)','6,600円'),('6600円（税込）','6,600円'),('6600円(税込み)','6,600円'),('6600円(税込10%)','6,600円'),
              ('6,050円','6,050円'),('240円','240円'),('2026年版 1100円','2026年版 1,100円'),('1.5000','1.5000'),('1.5000円','1.5000円'),
              ('値段設定なし','値段設定なし'),('','')]:
    assert price_label(_a)==_b,(_a,price_label(_a))

overrides=json.load(open(os.path.join(ROOT,'data/overrides.json')))
it=json.load(open(os.path.join(ROOT,'data/items.json')))
keep=['id','date','game','name','pack','box','per_box','per_pack','url','thumb','approx']
data=[]
for i in it:
    ov=overrides.get(i['id'],{})
    if ov.get('hide'): continue
    d={k:i.get(k,'') for k in keep}
    d.update({k:v for k,v in ov.items() if k in keep})
    if 'url' not in ov and not any(urllib.parse.urlparse(d['url']).netloc.replace('www.','').endswith(x) for x in OFFDOM): d['url']=''
    if d['thumb'] and not d['thumb'].startswith('/'): d['thumb']='/'+d['thumb']
    for k in ('pack','box'): d[k]=price_label(d[k])
    data.append(d)
data.sort(key=lambda d:(d['date'],d['game']))
used={d['game'] for d in data}
off={k:v for k,v in OFFICIAL.items() if k in used}
template=open(os.path.join(ROOT,'src/template.html')).read()
template=template.replace('/*DATA*/',json.dumps(data,ensure_ascii=False).replace('</','<\\/')).replace('/*OFFICIAL*/',json.dumps(off,ensure_ascii=False))
months=sorted({d['date'][:7] for d in data})

esc=lambda t: html.escape(str(t),quote=True)
def jd(s):
    y,m,d=map(int,s.split('-')); return datetime.date(y,m,d)
def fmt(s,year=False):
    x=jd(s); return (f'{x.year}/' if year else '')+f'{x.month}/{x.day}({DOW[x.weekday()]})'
def mlabel(ym): y,m=ym.split('-'); return f'{int(y)}年{int(m)}月'
upd=jd(UPDATED); upd_label=f'{upd.year}年{upd.month}月{upd.day}日'

def static_list(items,heading,note,show_game=True):
    if not items: return ''
    days={}
    for d in items: days.setdefault(d['date'],[]).append(d)
    out=[f'<section class="seo" aria-labelledby="seo-h"><h2 id="seo-h">{esc(heading)}</h2><p>{esc(note)}</p><div class="seo-days">']
    for k,its in days.items():
        out.append(f'<div class="seo-day"><h3><time datetime="{k}">{fmt(k,True)}</time></h3><ul>')
        for d in its:
            name=esc(d['name'])
            g=(f'<a class="sg" href="/{SLUG[d["game"]]}/">{esc(d["game"])}</a>' if d['game'] in SLUG else f'<span class="sg">{esc(d["game"])}</span>') if show_game else ''
            a=f'<a href="{esc(d["url"])}" target="_blank" rel="noopener">{name}</a>' if d['url'] else name
            pr=f'<span class="sp">{esc(d["pack"])}</span>' if d['pack'] else ''
            out.append(f'<li>{g}{a}{pr}</li>')
        out.append('</ul></div>')
    out.append('</div></section>')
    return ''.join(out)

# extra names people search with, per main title
ALIAS={'pokemon':['ポケモンカード','ポケカ','PTCG'],'onepiece':['ワンピースカード','ワンピカード','ワンピ'],
       'mtg':['マジック','MTG','ギャザ'],'yugioh':['遊戯王','遊戯王OCG','OCG'],'duelmasters':['デュエマ','デュエル・マスターズ'],
       'weiss':['ヴァイス','ヴァイスシュヴァルツ','WS'],'unionarena':['ユニアリ','ユニオンアリーナ','UNION ARENA'],
       'gundam':['ガンダムカード','ガンダムTCG','GCG'],'dragonball':['フュージョンワールド','DBFW','ドラゴンボールカード'],
       'digimon':['デジカ','デジモンカード']}
SLUG={k:s for s,k,n,sh in GAMES}
COMMON_KW=['TCG','トレカ','トレーディングカードゲーム','新弾','発売日','発売スケジュール','カレンダー','拡張パック','ブースターパック','スターターデッキ','予約']

def about_block(heading,paras):
    body=''.join(f'<p>{x}</p>' for x in paras)
    return f'<section class="seo about"><h2>{esc(heading)}</h2>{body}</section>'

def page_def():
    pages=[]
    year=TODAY[:4]
    up=[d for d in data if d['date']>=TODAY]
    soon=[d for d in up if d['date']<=(jd(TODAY)+datetime.timedelta(days=30)).isoformat()]
    gl='・'.join(f'<a href="/{s}/">{esc(sh)}</a>' for s,k,n,sh in GAMES if k in used)
    pages.append(dict(path='/releases/',slug='releases',og='home',
        title='TCG・トレカ新弾 発売日カレンダー（ポケカ・ワンピ・MTGほか）｜トレカカレンダー',
        desc=f'TCG・トレカ新弾の発売日カレンダー。ポケカ（ポケモンカード）・ワンピカード・MTG・遊戯王・デュエマ・ヴァイス・ユニアリなど{len(used)}タイトルの拡張パック・スターターデッキの発売日と価格を一覧でチェック。お気に入り登録・Googleカレンダー追加にも対応。',
        keywords=COMMON_KW+['ポケカ','ワンピカード','MTG','遊戯王','デュエマ','ヴァイス','ユニアリ'],
        h1='TCG・トレカ新弾 発売日カレンダー',
        lead=f'{len(used)}タイトル・{len(data)}件の新弾／新商品を掲載（{upd_label}更新）',
        crumbs=[('トップ','/'),('新弾カレンダー',None)], js=None,
        list=static_list(soon,'全タイトルの直近30日の発売予定',f'{fmt(TODAY,True)}から30日以内に発売されるTCG・トレカ新弾 {len(soon)}件（上のカレンダーの絞り込みにかかわらず、全タイトルを掲載）。価格は税込。')
            +about_block('新弾カレンダーについて',[
              f'トレカカレンダーの新弾カレンダーは、TCG（トレーディングカードゲーム）の新弾・新商品の発売日をひとつのカレンダーにまとめたページです。ポケモンカード、ONE PIECEカードゲーム、マジック：ザ・ギャザリング、遊戯王OCG、デュエル・マスターズ、ヴァイスシュヴァルツ、UNION ARENA など{len(used)}タイトルの拡張パック・ブースターパック・スターターデッキの発売日と価格（税込）を掲載しています。',
              'タイトルで絞り込んで推しのTCGだけを表示したり、☆でお気に入り登録した商品をまとめて確認・予算計算したりできます。お気に入りの商品は Google カレンダーや iPhone のカレンダーに追加でき、発売日の前日に通知を受け取れます。',
              f'タイトル別の発売日一覧：{gl}']),
        ld_items=soon))
    for slug,key,name,short in GAMES:
        its=[d for d in data if d['game']==key]
        if not its: continue
        u=[d for d in its if d['date']>=TODAY]
        al=ALIAS[slug]
        names=list(dict.fromkeys([name,short]+al))
        if u:
            nxt=u[0]; lst=u
            upcoming='、'.join(f'{fmt(d["date"])}「{esc(d["name"])}」' for d in u[:3])
            desc_next=f'次の発売は{fmt(nxt["date"])}「{nxt["name"][:36]}」。'
            lead=f'発売予定 {len(u)}件・次の発売は{fmt(nxt["date"])}（{upd_label}更新）'
            list_head,list_note=f'{short} 新弾の発売予定',f'{name}の今後の発売予定 {len(u)}件。価格は税込。'
            about_next=f'次に発売されるのは{upcoming}です。'
        else:
            # only past releases are left in the data (it keeps ~30 days back); never present them as upcoming
            lst=its[::-1]; last=lst[0]
            desc_next=f'現在、発売予定の新弾は掲載していません（最近の発売は{fmt(last["date"])}「{last["name"][:36]}」）。'
            lead=f'現在、発売予定の新弾はありません・最近の発売は{fmt(last["date"])}（{upd_label}更新）'
            list_head,list_note=f'{short} 最近の発売',f'{name}の最近発売された商品 {len(lst)}件。新しい発売予定が発表され次第掲載します。価格は税込。'
            about_next=f'現在、発売予定の新弾は掲載していません。最近の発売は{fmt(last["date"])}「{esc(last["name"])}」です。'
        pages.append(dict(path=f'/{slug}/',slug=slug,og=slug,
            title=f'{short}（{al[0] if al[0]!=short else name}）新弾 発売日一覧【{year}年最新】｜トレカカレンダー',
            desc=f'{name}（{short}）の新弾・拡張パック・スターターデッキの発売日と価格を一覧でチェック。{desc_next}{year}年の発売スケジュールをカレンダーで確認、お気に入り登録やGoogleカレンダー追加もできます。',
            keywords=names+[f'{short} 新弾',f'{short} 発売日']+COMMON_KW,
            h1=f'{name} 新弾 発売日カレンダー' if short in name else f'{name}（{short}）新弾 発売日カレンダー',
            lead=lead,
            crumbs=[('トップ','/'),('新弾カレンダー','/releases/'),(f'{short} 新弾',None)], js={'game':key},
            list=static_list(lst,list_head,list_note,show_game=False)
                +about_block(f'{short}の新弾情報について',[
                  f'{"・".join(esc(x) for x in names)}の新弾（拡張パック・ブースターパック・スターターデッキなど）の発売日と価格をまとめています。{about_next}',
                  f'カレンダーでは{esc(short)}の発売予定だけを表示しています。タイトルの絞り込み（スマホでは「絞り込み」ボタンの中）で「すべて」を選ぶと、ほかのTCGの新弾もまとめて確認できます。気になる商品は☆でお気に入りに追加でき、商品を開いて「カレンダーに追加」を押すと Google カレンダーやスマホのカレンダーに登録できます。']),
            ld_items=lst))
    for ym in months:
        its=[d for d in data if d['date'].startswith(ym)]
        cnt=__import__('collections').Counter(d['game'] for d in its)
        top='・'.join([g for g,_ in cnt.most_common(5)])
        main_links='・'.join(f'<a href="/{SLUG[g]}/">{esc(g)}</a>' if g in SLUG else esc(g) for g,_ in cnt.most_common(8))
        days=sorted({d['date'] for d in its})
        pages.append(dict(path=f'/{ym}/',slug=ym,og='home',
            title=f'{mlabel(ym)} TCG・トレカ新弾 発売日一覧｜トレカカレンダー',
            desc=f'{mlabel(ym)}発売のTCG・トレカ新弾{len(its)}件（{top}ほか）の発売日と価格を一覧でチェック。拡張パック・スターターデッキの発売スケジュールをカレンダーで確認できます。',
            keywords=[f'{mlabel(ym)} 新弾',f'{int(ym[5:])}月 トレカ 発売',f'{int(ym[5:])}月 TCG 新弾']+COMMON_KW,
            h1=f'{mlabel(ym)} TCG・トレカ新弾 発売日一覧',
            lead=f'{len(its)}件・{len(cnt)}タイトル（{upd_label}更新）',
            crumbs=[('トップ','/'),('新弾カレンダー','/releases/'),(mlabel(ym),None)], js={'month':ym},
            list=static_list(its,f'{mlabel(ym)}の発売日一覧',f'{mlabel(ym)}に発売されるTCG・トレカ新弾・新商品 {len(its)}件。価格は税込。')
                +about_block(f'{mlabel(ym)}のTCG新弾について',[
                  f'{mlabel(ym)}は{len(cnt)}タイトル・{len(its)}件の新弾・新商品が発売予定です（{fmt(days[0])}〜{fmt(days[-1])}）。発売件数が多いのは {main_links} です。',
                  'タイトルで絞り込むと、推しのTCGの発売日だけを確認できます。お気に入り登録した商品は、まとめて Google カレンダーやスマホのカレンダーに追加できます。']),
            ld_items=its))
    return pages

ICO=lambda d:f'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{d}</svg>'
# path, name (two parts, joined), icon
# BUILD_EVENTS=0 leaves /events/ out entirely (page, sitemap, tool tabs): hosts without the /api/ Worker (the Pages site before cutover).
BUILD_EVENTS=os.environ.get('BUILD_EVENTS','1')!='0'
TOOLS=[('/releases/','新弾','カレンダー',ICO('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 7.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3z" fill="currentColor" stroke="none"/>')),
       ('/events/','イベント','カレンダー',ICO('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5.5a2.5 2.5 0 0 0 2.6 3.6M16 6h2.5a2.5 2.5 0 0 1-2.6 3.6M12 13v4M8.5 20h7"/>'))]
if not BUILD_EVENTS: TOOLS=[t for t in TOOLS if t[0]!='/events/']
# Login UI (user control in the corner, sync wording in the legends, LOGIN parts of /privacy/): LOGIN_ENABLED=1, a repo
# variable passed to the Worker build only; always off with BUILD_EVENTS=0 (no Worker behind that build).
LOGIN_ENABLED=BUILD_EVENTS and os.environ.get('LOGIN_ENABLED','')=='1'
# Feedback form (/feedback/, its links in the footer and both corner menus, FEEDBACK parts of /privacy/ and 404.html):
# FEEDBACK_ENABLED=1, Worker build only like LOGIN_ENABLED. TURNSTILE_SITE_KEY is the widget's public site key.
FEEDBACK_ENABLED=BUILD_EVENTS and os.environ.get('FEEDBACK_ENABLED','')=='1'
TURNSTILE_SITE_KEY=os.environ.get('TURNSTILE_SITE_KEY','').strip()
if FEEDBACK_ENABLED and not re.fullmatch(r'[0-9A-Za-z_-]{10,100}',TURNSTILE_SITE_KEY):
    sys.exit('FEEDBACK_ENABLED=1 needs TURNSTILE_SITE_KEY (the Turnstile widget site key, a repo variable)')
def flags(src):
    # STORE: parts about data kept on the server (login or feedback)
    for tag,keep in (('EVENTS',BUILD_EVENTS),('LOGIN',LOGIN_ENABLED),('NOLOGIN',not LOGIN_ENABLED),
                     ('FEEDBACK',FEEDBACK_ENABLED),('STORE',LOGIN_ENABLED or FEEDBACK_ENABLED),('NOSTORE',not (LOGIN_ENABLED or FEEDBACK_ENABLED))):
        src=re.sub(rf'<!--{tag}-->(.*?)<!--/{tag}-->\n?',(lambda m:m.group(1)) if keep else '',src,flags=re.S)
    return src
def tooltabs(tool):
    if len(TOOLS)<2: return ''
    return '<nav class="tooltabs" aria-label="ツール">'+''.join(
        f'<a href="{p}" aria-label="{a}{b}"{" aria-current=\"true\"" if p==tool else ""}>{ic}<span>{a}{b}</span></a>' for p,a,b,ic in TOOLS)+'</nav>'
CORNER_SRC=open(os.path.join(ROOT,'src/corner.html')).read()
# location picker of /events/ and / (src/locpick.html), inserted before the page script at the LOCPICK slot
LOCPICK=re.sub(r'\A<!--.*?-->\n','',open(os.path.join(ROOT,'src/locpick.html')).read(),count=1,flags=re.S).strip()
def corner(tool):
    # logo-row controls of every page: product switch after the logo, settings and user on the right (src/corner.html)
    return flags(re.sub(r'\A<!--.*?-->\n','',CORNER_SRC,count=1,flags=re.S)).replace('<!--TOOLTABS-->',tooltabs(tool)).strip()
def siterow(cur):
    cur_=lambda p:' aria-current="page"' if cur==p else ''
    fb=''
    if FEEDBACK_ENABLED:
        fb=f'<a href="/feedback/"{cur_("/feedback/")}>ご意見・ご要望</a>' if cur=='/feedback/' else f'<a href="/feedback/?from={urllib.parse.quote(cur)}">ご意見・ご要望</a>'
    brand='トレカカレンダー<small>（旧・新弾ナビ）</small>' if cur=='/' else 'トレカカレンダー'
    return f'<div><b>{brand}</b><a href="/"{cur_("/")}>トップ</a><a href="/privacy/"{cur_("/privacy/")}>プライバシーポリシー</a>{fb}</div>'
def toolrow(cur):
    if len(TOOLS)<2: return ''
    return '<div><b>ツール</b>'+''.join(f'<a href="{p}"{" aria-current=\"page\"" if cur==p else ""}>{a}{b}</a>' for p,a,b,ic in TOOLS)+'</div>'

def sitenav(cur):
    g=''.join(f'<a href="/{s}/"{" aria-current=\"page\"" if cur==f"/{s}/" else ""}>{esc(short)}</a>' for s,k,n,short in GAMES if k in used)
    m=''.join(f'<a href="/{ym}/"{" aria-current=\"page\"" if cur==f"/{ym}/" else ""}>{mlabel(ym)}</a>' for ym in months)
    return f'<nav class="sitenav" aria-label="サイト内リンク">{toolrow(cur)}<div><b>タイトル別</b>{g}</div><div><b>月別</b>{m}</div>{siterow(cur)}</nav>'

GA=''
if GA_ID:
    GA=f"""<script>
(function(){{
  if(!/(^|\\.)shindan-navi\\.app$/.test(location.hostname)) return;
  var s=document.createElement('script'); s.async=true; s.src='https://www.googletagmanager.com/gtag/js?id={GA_ID}'; document.head.appendChild(s);
  window.dataLayer=window.dataLayer||[]; window.gtag=function(){{dataLayer.push(arguments);}};
  gtag('js',new Date()); gtag('config','{GA_ID}');
}})();
</script>"""

def render(pg):
    url=SITE+pg['path']
    og=f'{SITE}/og/{pg["og"]}.png'
    ld=[]
    if pg['crumbs']:
        ld.append({'@context':'https://schema.org','@type':'BreadcrumbList','itemListElement':[
            {'@type':'ListItem','position':i+1,'name':n,**({'item':SITE+h} if h else {'item':url})} for i,(n,h) in enumerate(pg['crumbs'])]})
    items=pg['ld_items']
    if items:
        ld.append({'@context':'https://schema.org','@type':'ItemList','name':pg['h1'],'numberOfItems':len(items),
            'itemListElement':[{'@type':'ListItem','position':i+1,'name':d['name'],**({'url':d['url']} if d['url'] else {})} for i,d in enumerate(items)]})
    ldjs=''.join(f'<script type="application/ld+json">{json.dumps(x,ensure_ascii=False).replace("</","<\\/")}</script>' for x in ld)
    head=f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{esc(pg['title'])}</title>
<meta name="description" content="{esc(pg['desc'])}">
<meta name="theme-color" content="#3a43d0">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/fonts/zen-kaku-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/dela-gothic-one.woff2" as="font" type="font/woff2" crossorigin>
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="トレカカレンダー">
<meta property="og:locale" content="ja_JP">
<meta property="og:title" content="{esc(pg['title'])}">
<meta property="og:description" content="{esc(pg['desc'])}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{esc(pg['h1'])}｜トレカカレンダー">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(pg['title'])}">
<meta name="twitter:description" content="{esc(pg['desc'])}">
<meta name="twitter:image" content="{og}">
<meta name="keywords" content="{esc(','.join(dict.fromkeys(pg['keywords'])))}">
{ldjs}
{GA}
<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0;font:14px system-ui}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
"""
    page=flags(template).replace('/*PAGE*/null',json.dumps(pg['js'],ensure_ascii=False) if pg['js'] else 'null')
    crumbs=''
    if pg['crumbs']:
        crumbs='<nav class="crumbs" aria-label="パンくず">'+' › '.join(f'<a href="{h}">{esc(n)}</a>' if h else f'<span aria-current="page">{esc(n)}</span>' for n,h in pg['crumbs'])+'</nav>'
    page=page.replace('<!--PAGEHEAD-->',f'{crumbs}<div class="ptitle"><h1>{esc(pg["h1"])}</h1><p>{esc(pg["lead"])}</p></div>')
    page=page.replace('<!--SEOLIST-->',pg['list']).replace('<!--SITENAV-->',sitenav(pg['path']))
    page=page.replace('<!--CORNER-->',corner('/releases/'))
    page=re.sub(r'<title>.*?</title>\n?','',page,count=1)
    split=page.index('<div class="wrap">')
    return head+page[:split]+'</head>\n<body>\n'+page[split:]+'\n</body>\n</html>\n'

EVENTS_API_BASE=os.environ.get('EVENTS_API_BASE','/api/v1')
# Browser key for the /events/ day-view map (Maps JavaScript API only, HTTP-referrer restricted; public by design). Empty = placeholder.
MAPS_BROWSER_KEY=os.environ.get('MAPS_BROWSER_KEY','').strip()
EVENTS_PAGE=dict(path='/events/',og='events',
    desc='ポケカ・ワンピ・ヴァイス・ヴァンガード・ホロカ・ガンダム・デジモンなど13タイトルの店舗大会・交流会・体験会を、開催日・都道府県・イベント形式で探せるTCGイベントカレンダー。',
    keywords=['TCG イベント','トレカ 大会','店舗大会','ジムバトル','交流会','体験会','ワンピカード 大会','ユニアリ 大会','コナンカード 大会','ポケカ 大会','ガンダムカード 大会','フュージョンワールド 大会','バトスピ 大会','デジカ 大会','ヴァイス 大会','ヴァンガード 大会','シャドバエボルヴ 大会','ホロカ 大会','ラブカ 大会','イベントカレンダー'],
    h1='TCG イベントカレンダー',lead='店舗大会・交流会・体験会を開催日・都道府県・イベント形式で探せます。',js=None)
def render_events():
    src=flags(open(os.path.join(ROOT,'src/events.html')).read())
    site_css=re.search(r'<style>\n(.*?)</style>',template,re.S).group(1)
    brand=re.search(r'<a class="brand".*?</a>',template,re.S).group(0)
    for slot,val in (('/*SITE_CSS*/',site_css),('<!--BRAND-->',brand),("/*API_BASE*/'/api/v1'",json.dumps(EVENTS_API_BASE)),("/*MAPS_KEY*/''",json.dumps(MAPS_BROWSER_KEY)),('<!--LOCPICK-->',LOCPICK)):
        assert src.count(slot)==1,slot
        src=src.replace(slot,val)
    src=src.replace('<!--CORNER-->',corner('/events/')).replace('<!--SITENAV-->',f'<nav class="sitenav" aria-label="サイト内リンク">{toolrow("/events/")}{siterow("/events/")}</nav>')
    title=html.unescape(re.search(r'<title>(.*?)</title>',src).group(1))
    src=re.sub(r'<title>.*?</title>\n?','',src,count=1)
    pg=EVENTS_PAGE
    url=SITE+pg['path']
    og=f'{SITE}/og/{pg["og"]}.png'
    head=f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{esc(title)}</title>
<meta name="description" content="{esc(pg['desc'])}">
<meta name="theme-color" content="#3a43d0">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/fonts/zen-kaku-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/dela-gothic-one.woff2" as="font" type="font/woff2" crossorigin>
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="トレカカレンダー">
<meta property="og:locale" content="ja_JP">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(pg['desc'])}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{esc(pg['h1'])}｜トレカカレンダー">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(pg['desc'])}">
<meta name="twitter:image" content="{og}">
<meta name="keywords" content="{esc(','.join(pg['keywords']))}">
{GA}
<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0;font:14px system-ui}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
"""
    split=src.index('<div class="wrap">')
    return head+src[:split]+'</head>\n<body>\n'+src[split:]+'\n</body>\n</html>\n'

# Privacy policy (/privacy/). Each date is the day that variant first went live, set by hand: BASE = 制定 (the policy
# without login), LOGIN = the revision that adds login, published only with LOGIN_ENABLED=1, FEEDBACK = the revision
# that adds the feedback form, published only with FEEDBACK_ENABLED=1. Leave a date None until the day its feature
# is enabled. 最終改定日 and the sitemap lastmod are the latest date among the enabled revisions.
PRIVACY_EFFECTIVE_BASE='2026-11-19'
PRIVACY_EFFECTIVE_LOGIN='2026-11-19'
PRIVACY_EFFECTIVE_FEEDBACK='2026-11-19'
if LOGIN_ENABLED and not PRIVACY_EFFECTIVE_LOGIN:
    sys.exit('LOGIN_ENABLED=1 needs PRIVACY_EFFECTIVE_LOGIN in scripts/build.py: set it to the date login goes live (YYYY-MM-DD)')
if FEEDBACK_ENABLED and not PRIVACY_EFFECTIVE_FEEDBACK:
    sys.exit('FEEDBACK_ENABLED=1 needs PRIVACY_EFFECTIVE_FEEDBACK in scripts/build.py: set it to the date the feedback form goes live (YYYY-MM-DD)')
PRIVACY_REVISIONS=[d for d,on in ((PRIVACY_EFFECTIVE_LOGIN,LOGIN_ENABLED),(PRIVACY_EFFECTIVE_FEEDBACK,FEEDBACK_ENABLED)) if on]
PRIVACY_LASTMOD=max(PRIVACY_REVISIONS,default=PRIVACY_EFFECTIVE_BASE)
PRIVACY_PAGE=dict(path='/privacy/',og='home',h1='プライバシーポリシー',lead='',js=None,
    desc='トレカカレンダーのプライバシーポリシー。アクセス解析（Google アナリティクス）、ブラウザに保存する設定、Cookie、外部サービスへの送信などについて説明します。')
def render_privacy():
    src=open(os.path.join(ROOT,'src/privacy.html')).read()
    if (LOGIN_ENABLED or FEEDBACK_ENABLED) and 'data-owner-fill' in src:
        sys.exit('src/privacy.html still has owner placeholders (data-owner-fill): fill them before building with LOGIN_ENABLED=1 or FEEDBACK_ENABLED=1')
    src=re.sub(r'\A<!--.*?-->\n','',src,count=1,flags=re.S)
    src=flags(src)
    site_css=re.search(r'<style>\n(.*?)</style>',template,re.S).group(1)
    brand=re.search(r'<a class="brand".*?</a>',template,re.S).group(0)
    def day(d):
        e=jd(d); return f'<time datetime="{d}">{e.year}年{e.month}月{e.day}日</time>'
    for slot,val in (('/*SITE_CSS*/',site_css),('<!--BRAND-->',brand),('<!--CORNER-->',corner(None)),('<!--SITENAV-->',sitenav('/privacy/'))):
        assert src.count(slot)==1,slot
        src=src.replace(slot,val)
    src=src.replace('<!--EFFECTIVE-->',day(PRIVACY_EFFECTIVE_BASE))
    assert src.count('<!--REVISED-->')==1
    src=src.replace('<!--REVISED-->',f'（最終改定日：{day(PRIVACY_LASTMOD)}）' if PRIVACY_REVISIONS else '')
    if LOGIN_ENABLED: src=src.replace('<!--REVISED_LOGIN-->',day(PRIVACY_EFFECTIVE_LOGIN))
    if FEEDBACK_ENABLED: src=src.replace('<!--REVISED_FEEDBACK-->',day(PRIVACY_EFFECTIVE_FEEDBACK))
    assert '<!--REVISED' not in src
    assert src.count('/*PAGE_FONTS*/')==1  # filled by fonts.py
    title=html.unescape(re.search(r'<title>(.*?)</title>',src).group(1))
    src=re.sub(r'<title>.*?</title>\n?','',src,count=1)
    pg=PRIVACY_PAGE
    url=SITE+pg['path']
    og=f'{SITE}/og/{pg["og"]}.png'
    head=f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{esc(title)}</title>
<meta name="description" content="{esc(pg['desc'])}">
<meta name="theme-color" content="#3a43d0">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="トレカカレンダー">
<meta property="og:locale" content="ja_JP">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(pg['desc'])}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{og}">
<meta name="twitter:card" content="summary_large_image">
{GA}
<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0;font:14px system-ui}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
"""
    split=src.index('<div class="wrap">')
    return head+src[:split]+'</head>\n<body>\n'+src[split:]+'\n</body>\n</html>\n'

# / is the today page (src/home.html). "Today" is computed in the browser (Asia/Tokyo); the page carries the releases
# from HOME_BEFORE days before to HOME_AFTER days after the build day and says so when a visit falls outside them.
HOME_BEFORE,HOME_AFTER=1,14
def home_page():
    t=jd(TODAY)
    lo,hi=(t-datetime.timedelta(days=HOME_BEFORE)).isoformat(),(t+datetime.timedelta(days=HOME_AFTER)).isoformat()
    ev='・TCGイベント' if BUILD_EVENTS else ''
    # 旧・新弾ナビ in the description and the footer brand (sitenav('/')) keeps the old name findable
    return dict(path='/',og='home',lo=lo,hi=hi,
        title=f'今日発売のTCG・トレカ新弾{"とイベント" if BUILD_EVENTS else ""}｜トレカカレンダー',
        desc=('トレカカレンダー（旧・新弾ナビ）で今日発売のTCG・トレカ新弾と、選んだ都道府県で今日開催の店舗大会などTCGイベントをタイトル別にチェック。ポケカ・ワンピ・MTGほか、明日・今週の予定もひと目で。'
              if BUILD_EVENTS else
              f'トレカカレンダー（旧・新弾ナビ）で今日発売のTCG・トレカ新弾をチェック。ポケカ・ワンピカード・MTG・遊戯王ほか{len(used)}タイトル、明日・今週の発売予定もひと目で確認できます。'),
        keywords=['今日発売','今日 発売 トレカ','TCG 今日','トレカ 新弾 今日','今週 発売 トレカ','新弾ナビ']+(['TCG イベント 今日','店舗大会'] if BUILD_EVENTS else [])+COMMON_KW,
        h1=f'今日発売のTCG・トレカ新弾{"とイベント" if BUILD_EVENTS else ""}',
        lead=f'{len(used)}タイトルの新弾{ev}を、日本時間の「今日」で表示しています（発売情報は{upd_label}更新）。'
             +('イベントは選んだ都道府県（またはオンライン）のものを、タイトル別に表示します。' if BUILD_EVENTS else ''))
HOME_PAGE=home_page()
def render_home():
    pg=HOME_PAGE
    src=re.sub(r'\A<!--.*?-->\n','',open(os.path.join(ROOT,'src/home.html')).read(),count=1,flags=re.S)
    src=flags(src)
    site_css=re.search(r'<style>\n(.*?)</style>',template,re.S).group(1)
    brand=re.search(r'<a class="brand".*?</a>',template,re.S).group(0)
    keep=['id','date','game','name','pack','thumb']
    home={'from':pg['lo'],'until':pg['hi'],'counts':__import__('collections').Counter(d['game'] for d in data),
          'items':[{k:d[k] for k in keep if d.get(k)} for d in data if pg['lo']<=d['date']<=pg['hi']]}
    for slot,val in (('/*SITE_CSS*/',site_css),('<!--BRAND-->',brand),('<!--CORNER-->',corner(None)),('<!--SITENAV-->',sitenav('/')),
                     ('<!--H1-->',esc(pg['h1'])),('<!--LEAD-->',esc(pg['lead'])),
                     ('/*HOME*/null',json.dumps(home,ensure_ascii=False).replace('</','<\\/')),("/*API_BASE*/'/api/v1'",json.dumps(EVENTS_API_BASE)))+((('<!--LOCPICK-->',LOCPICK),) if BUILD_EVENTS else ()):
        assert src.count(slot)==1,slot
        src=src.replace(slot,val)
    src=re.sub(r'<title>.*?</title>\n?','',src,count=1)
    url=SITE+'/'
    og=f'{SITE}/og/{pg["og"]}.png'
    ld=[{'@context':'https://schema.org','@type':'WebSite','name':'トレカカレンダー','alternateName':'新弾ナビ','url':url,'inLanguage':'ja'}]
    ldjs=''.join(f'<script type="application/ld+json">{json.dumps(x,ensure_ascii=False).replace("</","<\\/")}</script>' for x in ld)
    head=f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{esc(pg['title'])}</title>
<meta name="description" content="{esc(pg['desc'])}">
<meta name="theme-color" content="#3a43d0">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/fonts/zen-kaku-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/dela-gothic-one.woff2" as="font" type="font/woff2" crossorigin>
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="トレカカレンダー">
<meta property="og:locale" content="ja_JP">
<meta property="og:title" content="{esc(pg['title'])}">
<meta property="og:description" content="{esc(pg['desc'])}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{esc(pg['h1'])}｜トレカカレンダー">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(pg['title'])}">
<meta name="twitter:description" content="{esc(pg['desc'])}">
<meta name="twitter:image" content="{og}">
<meta name="keywords" content="{esc(','.join(dict.fromkeys(pg['keywords'])))}">
{ldjs}
{GA}
<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0;font:14px system-ui}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
"""
    split=src.index('<div class="wrap">')
    return head+src[:split]+'</head>\n<body>\n'+src[split:]+'\n</body>\n</html>\n'

# /feedback/: noindex and not in the sitemap (a form, nothing to find in search; it only works with the Worker setup).
FEEDBACK_PAGE=dict(path='/feedback/',desc='トレカカレンダーへのご意見・ご要望、不具合やデータの誤りのご報告はこちらから。')
def render_feedback():
    src=open(os.path.join(ROOT,'src/feedback.html')).read()
    src=re.sub(r'\A<!--.*?-->\n','',src,count=1,flags=re.S)
    src=flags(src)
    site_css=re.search(r'<style>\n(.*?)</style>',template,re.S).group(1)
    brand=re.search(r'<a class="brand".*?</a>',template,re.S).group(0)
    for slot,val in (('/*SITE_CSS*/',site_css),('<!--BRAND-->',brand),('<!--CORNER-->',corner(None)),
                     ('<!--SITENAV-->',f'<nav class="sitenav" aria-label="サイト内リンク">{toolrow("/feedback/")}{siterow("/feedback/")}</nav>'),
                     ("/*TURNSTILE_SITE_KEY*/''",json.dumps(TURNSTILE_SITE_KEY))):
        assert src.count(slot)==1,slot
        src=src.replace(slot,val)
    assert src.count('/*PAGE_FONTS*/')==1  # filled by fonts.py
    title=html.unescape(re.search(r'<title>(.*?)</title>',src).group(1))
    src=re.sub(r'<title>.*?</title>\n?','',src,count=1)
    pg=FEEDBACK_PAGE
    head=f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{esc(title)}</title>
<meta name="description" content="{esc(pg['desc'])}">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#3a43d0">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="canonical" href="{SITE}{pg['path']}">
{GA}
<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0;font:14px system-ui}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
"""
    split=src.index('<div class="wrap">')
    return head+src[:split]+'</head>\n<body>\n'+src[split:]+'\n</body>\n</html>\n'

dist=os.path.join(ROOT,'dist')
if os.path.isdir(dist): shutil.rmtree(dist)
shutil.copytree(os.path.join(ROOT,'public'),dist)
nf=os.path.join(dist,'404.html')
nf_src=flags(open(nf).read())
open(nf,'w').write(nf_src)
pages=page_def()
for pg in pages:
    d=os.path.join(dist,pg['path'].strip('/'))
    os.makedirs(d,exist_ok=True)
    open(os.path.join(d,'index.html'),'w').write(render(pg))
if BUILD_EVENTS:
    os.makedirs(os.path.join(dist,'events'),exist_ok=True)
    open(os.path.join(dist,'events/index.html'),'w').write(render_events())
open(os.path.join(dist,'index.html'),'w').write(render_home())
os.makedirs(os.path.join(dist,'privacy'),exist_ok=True)
open(os.path.join(dist,'privacy/index.html'),'w').write(render_privacy())
if FEEDBACK_ENABLED:
    os.makedirs(os.path.join(dist,'feedback'),exist_ok=True)
    open(os.path.join(dist,'feedback/index.html'),'w').write(render_feedback())
sm=['<?xml version="1.0" encoding="UTF-8"?>','<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
sm.append(f'<url><loc>{SITE}/</loc><lastmod>{UPDATED}</lastmod></url>')
for pg in pages: sm.append(f'<url><loc>{SITE}{pg["path"]}</loc><lastmod>{UPDATED}</lastmod></url>')
if BUILD_EVENTS: sm.append(f'<url><loc>{SITE}{EVENTS_PAGE["path"]}</loc></url>')
sm.append(f'<url><loc>{SITE}{PRIVACY_PAGE["path"]}</loc><lastmod>{PRIVACY_LASTMOD}</lastmod></url>')
sm.append('</urlset>')
open(os.path.join(dist,'sitemap.xml'),'w').write('\n'.join(sm)+'\n')
open(os.path.join(dist,'robots.txt'),'w').write(f'User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n')
json.dump([{'path':p['path'],'og':p['og'],'h1':p['h1'],'lead':p['lead'],'js':p['js']} for p in pages+[EVENTS_PAGE]],open(os.path.join(ROOT,'scripts/.pages.json'),'w'),ensure_ascii=False)
venv_py=os.path.join(ROOT,'.venv/bin/python')
if not os.path.exists(venv_py):
    sys.exit('missing .venv: python3 -m venv .venv && .venv/bin/pip install fonttools brotli')
import subprocess
subprocess.run([venv_py,'-I',os.path.join(ROOT,'scripts/fonts.py')],check=True)
print('pages',len(pages),'| events page',BUILD_EVENTS,'| login',LOGIN_ENABLED,'| feedback',FEEDBACK_ENABLED,'| items',len(data),'| product links',sum(1 for d in data if d['url']),'| GA',GA_ID or '(none)','| today',TODAY)
