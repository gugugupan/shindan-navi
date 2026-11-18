# データ更新レポート 2026-11-17

- 手動の公式サイト確認による更新。既存の更新スクリプトを実行した結果ではありません。
- 対象：既存40タイトル（「その他」のMy Little Ponyを含む）。ロゼを別行に分け、計41行で確認状況を記録。
- items.json: 203件 → 207件（追加30、30日超除外26、既存変更2）
- 原因：端末のネットワークでDNS解決不可、Python 3.6/3.8と依存不足のため自動dry-run不可。Web取得/公式検索結果へ切替。
- トレカの地図もWeb取得不可。全ソース・全言語版の網羅性は保証できず、確認不能と未確定は下記に明記。
- 新規画像は未取得。新規商品は画像プレースホルダー。既存thumb/approxと人工overrideを保持。

## 公式サイトから追加（30）

- 2026-11-27 [ポケモンカード] ポケモンカードゲーム MEGA 拡張パック「ハドウシーカー」 200円 ([公式](https://www.pokemon-card.com/ex/m7/))
- 2027-01-30 [ONE PIECE] エクストラブースター EAST BLUE【EB-06】 240円 ([公式](https://www.onepiece-cardgame.com/products/eb06.html))
- 2027-02-27 [ONE PIECE] ブースターパック 応答せよ、世界【OP-19】 240円 ([公式](https://www.onepiece-cardgame.com/products/op19.html))
- 2027-04-24 [ONE PIECE] プレミアムエクストラブースター 夢の一枚【PEB-01】 440円 ([公式](https://www.onepiece-cardgame.com/products/per01.html))
- 2027-03-20 [遊戯王ラッシュデュエル] レボリューションパック －魂の探索－ 264円 ([公式](https://www.konami.com/yugioh/rushduel/products/))
- 2026-12-19 [デュエル・マスターズ] DM26-RP4 デュエル・マスターズTCG 逆札篇 第４弾 邪神vs邪神Ⅲ ～ピース・オブ・ジ・アビス～ 200円 ([公式](https://dm.takaratomy.co.jp/product/dm26rp4/))
- 2027-01-23 [デジモン] デジモンカードゲーム エクストラブースター MALEVOLENT VII【EX-14】 240円 ([公式](https://digimoncard.com/products/))
- 2027-01-22 [FFTCG] アニバーサリーコレクションセット2027  ([公式](https://www.square-enix-shop.com/jp/ff-tcg/news/fftcg_2027_schedule.html))
- 2027-02-26 [ヴァイスシュヴァルツ] ブースターパック MyGO!!!!! × Ave Mujica Vol.2 440円 ([公式](https://ws-tcg.com/products/bd_mmvol2_bp/))
- 2027-03-05 [ヴァイスシュヴァルツ] WSR ブースターパック ゆずソフト Vol.2 550円 ([公式](https://ws-rose.com/products/yuz2))
- 2027-01-29 [リセ] リセ オーバーチュア Ver.シルキーズプラス1.0 ブースターパック 363円 ([公式](https://lycee-tcg.com/product/vol50_silkysplus/))
- 2027-03-27 [バトルスピリッツ] [26RSD14]ドリームスターター 3人の馬神 2,530円 ([公式](https://www.battlespirits.com/product/starter/starter-26rsd14.php))
- 2027-03-27 [バトルスピリッツ] [26REB01]ドリームブースター パワーオブリザレクション 330円 ([公式](https://www.battlespirits.com/product/booster/booster-26reb01.php))
- 2027-03-12 [UNION ARENA] ブースターパック 涼宮ハルヒの憂鬱【UA63BT】 385円 ([公式](https://www.unionarena-tcg.com/jp/products/boosters/shs-1.php))
- 2027-01-15 [ウルトラマン] ウルトラマン カードゲーム ブースターパック10「進め銀河の果てまでも」【BP10】 242円 ([公式](https://ultraman-cardgame.com/page/jp/news/news-detail/328))
- 2026-10-30 [ホロライブ] スタートデッキ アソビ★まわり隊！ 推し 熱千めら 1,980円 ([公式](https://hololive-official-cardgame.com/products/))
- 2026-10-30 [ホロライブ] スタートデッキ アソビ★まわり隊！ 推し 百灯キョーコ 1,980円 ([公式](https://hololive-official-cardgame.com/products/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 ブースターパック  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 コレクター・ブースター  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 コマンダー・デッキ「マーフォーク連隊」  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 コマンダー・デッキ「深海底の恐怖」  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 コマンダー・デッキ「海に漂う血」  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 コマンダー・デッキ「取引上手なアザラシ」  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 Premium Edition Commander Deck「Merfolk Regiment」  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 Premium Edition Commander Deck「Terrors of the Abyss」  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 Premium Edition Commander Deck「Blood in the Water」  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 Premium Edition Commander Deck「Seal the Deal」  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 Bundle  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 Secret Lair Bundle  ([公式](https://mtg-jp.com/reading/publicity/0039869/))
- 2027-02-05 [MTG] ノークティス：深淵の水府 Draft Night  ([公式](https://mtg-jp.com/reading/publicity/0039869/))

## 既存商品の変更（2）

- [パルワールド] ブースターパック第3弾「果てなき飛翔」: 2027-01-29 → 2027-01-30 ([公式延期告知](https://palworld-official-cardgame.com/news/post-bp03postponing))
- [ホロライブ] グローリー・エコー: 8枚/パック、12パック/BOX、BOX 5,280円を補完 ([公式](https://hololive-official-cardgame.com/products/))

## 各タイトルの確認結果

| タイトル | 確認内容・制約 | 公式 |
| --- | --- | --- |
| ポケモンカード | ハドウシーカー追加。ニュースと商品ページを確認。 | [確認先](https://www.pokemon-card.com/info/) |
| ONE PIECE | EB-06、OP-19、PEB-01追加。既存ST-37/ST-38は公式価格と一致。 | [確認先](https://www.onepiece-cardgame.com/products/) |
| MTG | ノークティス商品13件追加。通常/豪華デッキ各4種を別商品として登録。言語版と価格は未確定のため推測しない。 | [確認先](https://mtg-jp.com/reading/publicity/0039869/) |
| 遊戯王OCG | 検索取得で既存発売日・価格を照合。通常一覧はJSのみ。COMPLETE FILEは3月下旬のみで未掲載。 | [確認先](https://www.yugioh-card.com/japan/products/?id=cg2076) |
| 遊戯王ラッシュデュエル | 魂の探索追加。月単位の日付しかない2商品は引き続き未掲載。 | [確認先](https://www.konami.com/yugioh/rushduel/products/) |
| デュエル・マスターズ | DM26-RP4追加。デッキ一覧のボルメテウスも照合。神アートの全件確認は未完了。 | [確認先](https://dm.takaratomy.co.jp/product/) |
| デジモン | EX-14追加。PB-26/27/28等は発送月のみ、確定日を作らない。 | [確認先](https://digimoncard.com/products/) |
| ヴァイスシュヴァルツ | 直接取得404、公式検索結果でMyGO Vol.2追加。他の掲載済み発売予定と照合。 | [確認先](https://ws-tcg.com/products/) |
| ヴァイスシュヴァルツ（ロゼ） | 公式検索結果とyuz2詳細でゆずソフトVol.2追加。 | [確認先](https://ws-rose.com/products/category/booster-pack/) |
| ヴァイスシュヴァルツブラウ | 直接一覧404。公式検索で商品展開終了告知と最終商品を確認。新規発見なし。 | [確認先](https://ws-blau.com/news/post-267) |
| ヴァンガード | 部分確認：直接一覧404、公式日本語トップ検索で11/20、12/4、12/18商品を照合。英語版の発売日を日本語版へ流用しない。 | [確認先](https://cf-vanguard.com/tcg/) |
| バトルスピリッツ | 26RSD14/26REB01追加。一覧の26RSD14は2026と誤記、詳細2か所は2027なので詳細を採用。 | [確認先](https://www.battlespirits.com/product/) |
| リセ | シルキーズプラス1.0追加。 | [確認先](https://lycee-tcg.com/product/vol50_silkysplus/) |
| UNION ARENA | 一覧取得が古い範囲に偏るため、公式トップ予定表と商品詳細でUA63BT追加。 | [確認先](https://www.unionarena-tcg.com/jp/) |
| ガンダム | 既存GD07/EB02/ST15と照合。新規発見なし。GD07価格未発表のまま。 | [確認先](https://www.gundam-gcg.com/jp/products/list.php) |
| DBフュージョンワールド | FB12/FS13/FS14の日付・価格と一致、新規発見なし。 | [確認先](https://www.dbs-cardgame.com/fw/jp/products/) |
| WIXOSS | CONFLICT SELECTOR以降の新規発見なし。 | [確認先](https://www.takaratomy.co.jp/products/wixoss/product/) |
| バボカ!! | HV-P04/HV-D04以降の新規発見なし。 | [確認先](https://www.takaratomy.co.jp/products/haikyuvobacabreak/product/) |
| ロルカナ | 商品ニュースを確認、ハイぺリアシティ以降の新規発見なし。 | [確認先](https://www.takaratomy.co.jp/products/disneylorcana/news/products/) |
| 名探偵コナン | CT-P11以降の新規カード商品発見なし。12/19分は周辺グッズ。 | [確認先](https://www.takaratomy.co.jp/products/conan-cardgame/products/) |
| ホロビート | 11/14発売のHB-BP01/SD01/SD02を照合、新規発見なし。 | [確認先](https://www.takaratomy.co.jp/products/horobeat-cardgame/product/) |
| Shadowverse EVOLVE | 直接一覧404、公式カテゴリ検索でグラブル/舞い踊る六華を照合、新規発見なし。 | [確認先](https://shadowverse-evolve.com/products/category/booster-pack/) |
| Reバース | 一覧503/キャッシュ欠落。公式ニュース検索で10/16ありがとうセット以降の新規発見なし。 | [確認先](https://rebirth-fy.com/news/) |
| DIVINE CROSS | 11/25、12/24の掲載分と照合、新規発見なし。価格は未掲載、画像取得は未完了。 | [確認先](https://divinecross.jp/products/) |
| OSICA | 12/18着せ恋Season2を照合、新規発見なし。 | [確認先](https://www.osicatcg.com/products/list/) |
| ビルディバイド | 2/26 Fate/strange Fakeまで掲載済み日付・単価・BOX価格を照合、新規発見なし。 | [確認先](https://tcg.build-divide.com/bright/products) |
| Xross Stars | 10/30 Ignition Vortex/EXデッキ以降の新規発見なし。旧1st Anniv.は公式9/18、既存10/9の相違あり；今回30日超のため除外。 | [確認先](https://xross-stars.com/product) |
| KAMITSUBAKI | 12/4ブースターvol.7とスターター2種を照合。デラックスセットは本一覧に見つからず保留・既存維持。 | [確認先](https://tcg.kamitsubaki.jp/products/) |
| ウルトラマン | 通常一覧は動的、公式ニュースでBP10を発見・追加。 | [確認先](https://ultraman-cardgame.com/page/jp/news/news-detail/328) |
| ゴジラ | 直接404、公式検索で君臨するゼロと11/6スターターを照合、新規発見なし。 | [確認先](https://godzilla-cardgame.com/products/) |
| パルワールド | 公式検索の延期告知によりBP03を1/30へ修正・override固定。 | [確認先](https://palworld-official-cardgame.com/news/post-bp03postponing) |
| ラブライブ！OCG | 一覧/API取得不可、公式発表会記事と商品詳細検索で既存予定を照合。BOX価格表記に5,005円の相違あり、未適用。 | [確認先](https://llofficial-cardgame.com/news/261028-llc/) |
| FFTCG | アニバーサリーコレクションセット2027追加、英雄の交響曲は掲載済み。 | [確認先](https://www.square-enix-shop.com/jp/ff-tcg/news/fftcg_2027_schedule.html) |
| Flesh and Blood | 未検証：公式が403/取得不可。既存予定と重複候補を維持、英語資料のみで日本語版を更新しない。 | [確認先](https://fabtcg.com/ja/coming-soon/) |
| Harry Potter | 10/24秘密の部屋Part.1以降の新規発見なし。 | [確認先](https://tcg.movic.jp/harrypotter/category/products/) |
| アニマルカードゲーム | 11/27トライアルデッキ3種を照合、新規発見なし。 | [確認先](https://acgtcg.com/products.html) |
| ファンスターズリーグ | 12/19 Vol.4両リーグと550円を照合。既存の画像プレースホルダー固定は維持。 | [確認先](https://www.fanstars-league.com/products/) |
| 五等分の花嫁 | 直接404、公式検索で10/30 vol.8以降の新規発見なし。 | [確認先](https://5hanayome-cardgame.com/products/) |
| ホロライブ | 10/30スタートデッキ2種追加、グローリー・エコーのBOX情報補完。FBKINGDOMは日付未定で未掲載。 | [確認先](https://hololive-official-cardgame.com/products/) |
| その他（My Little Pony） | 公式検索で9/4 BP3告知以降の新規カード商品発見なし。 | [確認先](https://www.mlptcg-jp.com/) |
| Z/X | 未検証：公式メンテナンス画面。将来の商品は削除せず維持。 | [確認先](https://www.zxtcg.com/product/) |

## 未掲載・要再確認

- MTGノークティスの価格・言語版別展開は未確認。ブースターと通常デッキは言語未指定で登録。プレリリース商品はイベント日と販売日を混同しないため未追加。
- 日付未確定：遊戯王 COMPLETE FILE（2027年3月下旬）、Rush Duel アナザースタイル（1月下旬）/希望のリーチェ（12月中旬）、デジモンPB商品、ホロライブ FBKINGDOM。
- Flesh and Blood「疫禍襲来」と「疫禍襲来 ブースターパック」は既存の重複候補。今回公式を取得できないので勝手に統合しない。
- Z/Xは公式メンテナンス中。将来の商品を維持。
- ホロライブの公式ドメインは既存build.pyのリンク許可リストにないため、データ中の公式URLが画面では除外される。アプリコードは今回変更していない。
- Python 3.12以上とfonttools/brotli/Pillow環境での完全ビルド、desktop/mobile目視、画像取得とOGP再生成は未完了。

## 発売から30日を過ぎて除外（26）

- 基準日2026-11-17、保持下限2026-10-18。削除理由は経過日数であり、発売中止ではありません。
- 2026-10-03 [デジモン] デジモンカードゲーム エクストラブースター CHIVALROUS XIII 【EX-13】 (i6bcebca656)
- 2026-10-03 [ラブライブ！OCG] ラブライブ！OCG プレミアムブースター ラブライブ！ DUO (i0b164e6eae)
- 2026-10-09 [FFTCG] FFTCG スターターセット ファイナルファンタジーXIV: 蒼天のイシュガルド 日本語版 (i08c65f9b52)
- 2026-10-09 [Xross Stars] Xross Stars 1st Anniv. Collection PREMIUM SET (i422c625a70)
- 2026-10-09 [ヴァンガード] VG-DZ-BT17 ブースターパック 運命星戦 (i69c197985d)
- 2026-10-10 [その他] マイリトルポニーTCG BP3 ナイトメアナイト 003-JP (ia5f12cdc9d)
- 2026-10-10 [バトルスピリッツ] バトルスピリッツ アニメスターター 深淵の怪鯨【26RSD10】 (i73fea5ad97)
- 2026-10-10 [バトルスピリッツ] バトルスピリッツ アニメスターター 覚醒の煉凰【26RSD09】 (i71f276ccdf)
- 2026-10-10 [遊戯王ラッシュデュエル] 遊戯王RD CROSS ART COLLECTION (if68235e3a5)
- 2026-10-16 [Reバース] Reバース for you ありがとうセット Reバース (i7e6eea9071)
- 2026-10-16 [UNION ARENA] UNION ARENA ブースターパック シュタインズ・ゲート【UA57BT】 (i97563f43dc)
- 2026-10-16 [ポケモンカード] ポケモンカードゲーム MEGA 30th CELEBRATION カードセット キモリ・アチャモ・ミズゴロウ (i98039c045e)
- 2026-10-16 [ポケモンカード] ポケモンカードゲーム MEGA 30th CELEBRATION カードセット サルノリ・ヒバニー・メッソン (i1a54455a55)
- 2026-10-16 [ポケモンカード] ポケモンカードゲーム MEGA 30th CELEBRATION カードセット チコリータ・ヒノアラシ・ワニノコ (ic2a22a366f)
- 2026-10-16 [ポケモンカード] ポケモンカードゲーム MEGA 30th CELEBRATION カードセット ツタージャ・ポカブ・ミジュマル (i038c758e08)
- 2026-10-16 [ポケモンカード] ポケモンカードゲーム MEGA 30th CELEBRATION カードセット ナエトル・ヒコザル・ポッチャマ (i29493cc593)
- 2026-10-16 [ポケモンカード] ポケモンカードゲーム MEGA 30th CELEBRATION カードセット ニャオハ・ホゲータ・クワッス (id2a34ea948)
- 2026-10-16 [ポケモンカード] ポケモンカードゲーム MEGA 30th CELEBRATION カードセット ハリマロン・フォッコ・ケロマツ (i6e67d5a9f6)
- 2026-10-16 [ポケモンカード] ポケモンカードゲーム MEGA 30th CELEBRATION カードセット フシギダネ・ヒトカゲ・ゼニガメ (i29ad66a326)
- 2026-10-16 [ポケモンカード] ポケモンカードゲーム MEGA 30th CELEBRATION カードセット モクロー・ニャビー・アシマリ (ia74d0b2c77)
- 2026-10-16 [ロルカナ] ディズニー・ロルカナ・TCG日本語版 ブースターパック ハイペリアシティ (ia946843f5d)
- 2026-10-16 [ヴァイスシュヴァルツ] WS トライアルデッキ ステラソラ (i9493e852c6)
- 2026-10-16 [ヴァイスシュヴァルツ] WS ブースターパック ステラソラ (if644c4eb04)
- 2026-10-16 [ヴァイスシュヴァルツブラウ] WS-B ブースターパック 少女☆歌劇 レヴュースタァライト (i6d694751ac)
- 2026-10-17 [デュエル・マスターズ] DM26-EX4 デュエル・マスターズTCG 切札不滅!! デュエキング FOREVER 2026 (id31abc5716)
- 2026-10-17 [バトルスピリッツ] バトルスピリッツ ブースターパック 絶界の覇者【26RBS03】 (i0e1d2788a1)

## 検証

- 合格：JSON、207件のid一意性・ソート・実在日付・保持期間・既存画像ファイル・正の封入数。新規30件は既存方式のSHA-1 idと公式ソースを検証。
- 合格：既存override全件が不変、既存商品の変更はパルワールドの日付とホロライブのBOX情報のみ。除外26件は全て30日超。
- 合格：更新データを注入した既存ページJavaScriptを node --check で構文検証。
- 完全ビルドは未実施：実際にbuild.pyを起動したが、Python 3.8では既存165行目のPython 3.12以降用f-stringを解析できず停止。
- 公開・commit・pushは未実施。
