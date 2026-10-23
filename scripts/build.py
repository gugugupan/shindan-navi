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
def yen(s):
    m=re.search(r'\d[\d,]*',s or ''); return int(m.group().replace(',','')) if m else None
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

def product_ld(d,page_url):
    price=yen(d['pack'])
    desc=f"{d['game']}の新商品。{fmt(d['date'],True)}発売、{d['pack']}（税込）"+(f"、1BOX {d['box']}" if d['box'] else '')+'。'
    p={'@type':'Product','name':d['name'],'description':desc,'image':SITE+d['thumb'],'brand':{'@type':'Brand','name':d['game']},'releaseDate':d['date']}
    if price:
        p['offers']={'@type':'Offer','price':price,'priceCurrency':'JPY','url':d['url'] or page_url,
                     'availability':'https://schema.org/PreOrder' if d['date']>TODAY else 'https://schema.org/InStock'}
    return p

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
    pages.append(dict(path='/',slug='home',og='home',
        title='新弾ナビ｜TCG・トレカ新弾 発売日カレンダー（ポケカ・ワンピ・MTGほか）',
        desc=f'TCG・トレカ新弾の発売日カレンダー。ポケカ（ポケモンカード）・ワンピカード・MTG・遊戯王・デュエマ・ヴァイス・ユニアリなど{len(used)}タイトルの拡張パック・スターターデッキの発売日と価格を一覧でチェック。お気に入り登録・Googleカレンダー追加にも対応。',
        keywords=COMMON_KW+['ポケカ','ワンピカード','MTG','遊戯王','デュエマ','ヴァイス','ユニアリ'],
        h1='TCG・トレカ新弾 発売日カレンダー',
        lead=f'{len(used)}タイトル・{len(data)}件の新弾／新商品を掲載（{upd_label}更新）',
        crumbs=None, js=None,
        list=static_list(soon,'直近30日の発売予定',f'{fmt(TODAY,True)}から30日以内に発売されるTCG・トレカ新弾 {len(soon)}件。')
            +about_block('新弾ナビについて',[
              f'新弾ナビは、TCG（トレーディングカードゲーム）の新弾・新商品の発売日をひとつのカレンダーにまとめたサイトです。ポケモンカード、ONE PIECEカードゲーム、マジック：ザ・ギャザリング、遊戯王OCG、デュエル・マスターズ、ヴァイスシュヴァルツ、UNION ARENA など{len(used)}タイトルの拡張パック・ブースターパック・スターターデッキの発売日と価格（税込）を掲載しています。',
              'タイトルで絞り込んで推しのTCGだけを表示したり、☆でお気に入り登録した商品をまとめて確認・予算計算したりできます。お気に入りの商品は Google カレンダーや iPhone のカレンダーに追加でき、発売日の前日に通知を受け取れます。',
              f'タイトル別の発売日一覧：{gl}']),
        ld_items=soon))
    for slug,key,name,short in GAMES:
        its=[d for d in data if d['game']==key]
        if not its: continue
        u=[d for d in its if d['date']>=TODAY] or its
        nxt=u[0]; al=ALIAS[slug]
        names=list(dict.fromkeys([name,short]+al))
        upcoming='、'.join(f'{fmt(d["date"])}「{esc(d["name"])}」' for d in u[:3])
        pages.append(dict(path=f'/{slug}/',slug=slug,og=slug,
            title=f'{short}（{al[0] if al[0]!=short else name}）新弾 発売日一覧【{year}年最新】｜新弾ナビ',
            desc=f'{name}（{short}）の新弾・拡張パック・スターターデッキの発売日と価格を一覧でチェック。次の発売は{fmt(nxt["date"])}「{nxt["name"][:36]}」。{year}年の発売スケジュールをカレンダーで確認、お気に入り登録やGoogleカレンダー追加もできます。',
            keywords=names+[f'{short} 新弾',f'{short} 発売日']+COMMON_KW,
            h1=f'{name} 新弾 発売日カレンダー' if short in name else f'{name}（{short}）新弾 発売日カレンダー',
            lead=f'発売予定 {len(u)}件・次の発売は{fmt(nxt["date"])}（{upd_label}更新）',
            crumbs=[('トップ','/'),(f'{short} 新弾',None)], js={'game':key},
            list=static_list(u,f'{short} 新弾の発売予定',f'{name}の今後の発売予定 {len(u)}件。価格は税込。',show_game=False)
                +about_block(f'{short}の新弾情報について',[
                  f'{"・".join(esc(x) for x in names)}の新弾（拡張パック・ブースターパック・スターターデッキなど）の発売日と価格をまとめています。次に発売されるのは{upcoming}です。',
                  f'カレンダーでは{esc(short)}の発売予定だけを表示しています。上の「すべて」を押すと、ほかのTCGの新弾もまとめて確認できます。気になる商品は☆でお気に入りに追加すると、Google カレンダーやスマホのカレンダーにも登録できます。']),
            ld_items=u))
    for ym in months:
        its=[d for d in data if d['date'].startswith(ym)]
        cnt=__import__('collections').Counter(d['game'] for d in its)
        top='・'.join([g for g,_ in cnt.most_common(5)])
        main_links='・'.join(f'<a href="/{SLUG[g]}/">{esc(g)}</a>' if g in SLUG else esc(g) for g,_ in cnt.most_common(8))
        days=sorted({d['date'] for d in its})
        pages.append(dict(path=f'/{ym}/',slug=ym,og='home',
            title=f'{mlabel(ym)} TCG・トレカ新弾 発売日一覧｜新弾ナビ',
            desc=f'{mlabel(ym)}発売のTCG・トレカ新弾{len(its)}件（{top}ほか）の発売日と価格を一覧でチェック。拡張パック・スターターデッキの発売スケジュールをカレンダーで確認できます。',
            keywords=[f'{mlabel(ym)} 新弾',f'{int(ym[5:])}月 トレカ 発売',f'{int(ym[5:])}月 TCG 新弾']+COMMON_KW,
            h1=f'{mlabel(ym)} TCG・トレカ新弾 発売日一覧',
            lead=f'{len(its)}件・{len(cnt)}タイトル（{upd_label}更新）',
            crumbs=[('トップ','/'),(mlabel(ym),None)], js={'month':ym},
            list=static_list(its,f'{mlabel(ym)}の発売日一覧',f'{mlabel(ym)}に発売されるTCG・トレカ新弾・新商品 {len(its)}件。価格は税込。')
                +about_block(f'{mlabel(ym)}のTCG新弾について',[
                  f'{mlabel(ym)}は{len(cnt)}タイトル・{len(its)}件の新弾・新商品が発売予定です（{fmt(days[0])}〜{fmt(days[-1])}）。発売件数が多いのは {main_links} です。',
                  'タイトルで絞り込むと、推しのTCGの発売日だけを確認できます。お気に入り登録した商品は、まとめて Google カレンダーやスマホのカレンダーに追加できます。']),
            ld_items=its))
    return pages

def sitenav(cur):
    g=''.join(f'<a href="/{s}/"{" aria-current=\"page\"" if cur==f"/{s}/" else ""}>{esc(short)}</a>' for s,k,n,short in GAMES if k in used)
    m=''.join(f'<a href="/{ym}/"{" aria-current=\"page\"" if cur==f"/{ym}/" else ""}>{mlabel(ym)}</a>' for ym in months)
    return f'<nav class="sitenav" aria-label="サイト内リンク"><div><b>タイトル別</b>{g}</div><div><b>月別</b>{m}</div><div><b>新弾ナビ</b><a href="/"{" aria-current=\"page\"" if cur=="/" else ""}>トップ（全タイトル）</a></div></nav>'

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
    if pg['path']=='/':
        ld.append({'@context':'https://schema.org','@type':'WebSite','name':'新弾ナビ','url':SITE+'/','inLanguage':'ja'})
    if pg['crumbs']:
        ld.append({'@context':'https://schema.org','@type':'BreadcrumbList','itemListElement':[
            {'@type':'ListItem','position':i+1,'name':n,**({'item':SITE+h} if h else {'item':url})} for i,(n,h) in enumerate(pg['crumbs'])]})
    items=[d for d in pg['ld_items'] if d['thumb'] and yen(d['pack'])][:60]
    if items:
        ld.append({'@context':'https://schema.org','@type':'ItemList','name':pg['h1'],'numberOfItems':len(items),
            'itemListElement':[{'@type':'ListItem','position':i+1,'item':product_ld(d,url)} for i,d in enumerate(items)]})
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
<meta property="og:site_name" content="新弾ナビ">
<meta property="og:locale" content="ja_JP">
<meta property="og:title" content="{esc(pg['title'])}">
<meta property="og:description" content="{esc(pg['desc'])}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{esc(pg['h1'])}｜新弾ナビ">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(pg['title'])}">
<meta name="twitter:description" content="{esc(pg['desc'])}">
<meta name="twitter:image" content="{og}">
<meta name="keywords" content="{esc(','.join(dict.fromkeys(pg['keywords'])))}">
{ldjs}
{GA}
<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0;font:14px system-ui}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
"""
    page=template.replace('/*PAGE*/null',json.dumps(pg['js'],ensure_ascii=False) if pg['js'] else 'null')
    crumbs=''
    if pg['crumbs']:
        crumbs='<nav class="crumbs" aria-label="パンくず">'+' › '.join(f'<a href="{h}">{esc(n)}</a>' if h else f'<span aria-current="page">{esc(n)}</span>' for n,h in pg['crumbs'])+'</nav>'
    page=page.replace('<!--PAGEHEAD-->',f'{crumbs}<div class="ptitle"><h1>{esc(pg["h1"])}</h1><p>{esc(pg["lead"])}</p></div>')
    page=page.replace('<!--SEOLIST-->',pg['list']).replace('<!--SITENAV-->',sitenav(pg['path']))
    page=re.sub(r'<title>.*?</title>\n?','',page,count=1)
    split=page.index('<div class="wrap">')
    return head+page[:split]+'</head>\n<body>\n'+page[split:]+'\n</body>\n</html>\n'

dist=os.path.join(ROOT,'dist')
if os.path.isdir(dist): shutil.rmtree(dist)
shutil.copytree(os.path.join(ROOT,'public'),dist)
pages=page_def()
for pg in pages:
    d=os.path.join(dist,pg['path'].strip('/'))
    os.makedirs(d,exist_ok=True)
    open(os.path.join(d,'index.html'),'w').write(render(pg))
sm=['<?xml version="1.0" encoding="UTF-8"?>','<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
for pg in pages: sm.append(f'<url><loc>{SITE}{pg["path"]}</loc><lastmod>{UPDATED}</lastmod></url>')
sm.append('</urlset>')
open(os.path.join(dist,'sitemap.xml'),'w').write('\n'.join(sm)+'\n')
open(os.path.join(dist,'robots.txt'),'w').write(f'User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n')
json.dump([{'path':p['path'],'og':p['og'],'h1':p['h1'],'lead':p['lead'],'js':p['js']} for p in pages],open(os.path.join(ROOT,'scripts/.pages.json'),'w'),ensure_ascii=False)
venv_py=os.path.join(ROOT,'.venv/bin/python')
if not os.path.exists(venv_py):
    sys.exit('missing .venv: python3 -m venv .venv && .venv/bin/pip install fonttools brotli')
import subprocess
subprocess.run([venv_py,'-I',os.path.join(ROOT,'scripts/fonts.py')],check=True)
print('pages',len(pages),'| items',len(data),'| product links',sum(1 for d in data if d['url']),'| GA',GA_ID or '(none)','| today',TODAY)
