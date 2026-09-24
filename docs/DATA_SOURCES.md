# データの出典と利用条件

「鵠沼海岸 津波シミュレーター」が使う外部データ・資料の一覧です。
URL・ズーム範囲・出典表記・配色は公式の資料で確かめ、さらに実際にデータを取得して確認しました（確認日: 2026年9月24日）。

> このサイトの計算は、公的な想定値を目標に波の大きさを調整した**説明用の簡略モデル**です。
> 公式の予測・浸水想定ではありません。実際の避難には藤沢市の津波ハザードマップ
> （https://www.city.fujisawa.kanagawa.jp/bousai/bosai/bosai/hazardmap/tsunami/h25hazardmap.html ）を使ってください。

コードでの定義: `src/data/sources.ts`（タイル・出典・配色）、`src/data/poi.ts`（地点）、
`src/data/shelters.ts`（避難場所）、`src/data/scenarios.ts`（シナリオ）。

---

## 1. 一覧

| データ | 使いみち | URL | 利用条件 | 画面に出す出典 |
| --- | --- | --- | --- | --- |
| 地理院タイル 淡色地図・標準地図 | 2D/3D の背景地図 | `https://cyberjapandata.gsi.go.jp/xyz/{pale,std}/{z}/{x}/{y}.png` | 国土地理院コンテンツ利用規約。基本測量成果だが、リアルタイムに読み込む場合は出典の明示のみで申請不要 | 「地理院タイル」＋地理院タイル一覧へのリンク |
| 地理院タイル 写真（seamlessphoto） | 背景地図（写真） | `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg` | 国土地理院コンテンツ利用規約。基本測量成果**ではなく**「出典の記載のみで利用可能なもの」 | 「地理院タイル」＋ズーム9〜13は Landsat8 の出所を併記 |
| 地理院タイル 色別標高図 | 標高の段彩表示 | `https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png` | 写真と同じ（出典の記載のみで利用可能なもの） | 「地理院タイル」＋「海域部は海上保安庁海洋情報部の資料を使用して作成」 |
| 地理院タイル 標高タイル（DEM） | 計算用の地形（陸の標高） | `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png` ほか | 出典の記載のみで利用可（加工した旨も記載） | 「地理院タイル（標高タイル（基盤地図情報数値標高モデル））を加工して作成」 |
| 国土地理院 標高API | 地点（POI）の標高の記録 | `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php` | 過度の負担をかけないこと | 地点の出典に記載 |
| 重ねるハザードマップ 津波浸水想定 | 公式の浸水想定の重ね表示・凡例 | `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png` | 公共データ利用規約（第1.0版）。商用・非商用とも可、出典の記載が必要 | 「ハザードマップポータルサイト」（津波浸水想定：神奈川県） |
| 指定緊急避難場所（津波） skhb05 | 避難場所の表示・避難経路の目的地 | `https://cyberjapandata.gsi.go.jp/xyz/skhb05/{z}/{x}/{y}.geojson` | 国土地理院コンテンツ利用規約＋「ご利用上の注意」への同意 | 「国土地理院 指定緊急避難場所データ（津波）」 |
| OpenFreeMap（OpenStreetMap） | 3D の建物 | TileJSON `https://tiles.openfreemap.org/planet` | 無料（閲覧数・リクエスト数の制限なし、登録不要）・無保証。地図データは OpenStreetMap（ODbL） | OpenFreeMap © OpenMapTiles Data from OpenStreetMap |
| OpenStreetMap（Nominatim で確認） | 地点（駅など）の位置 | https://www.openstreetmap.org/ | ODbL | © OpenStreetMap contributors |

すべてのタイル・API は、ブラウザと同じく `Origin` ヘッダーを付けた要求に対して `Access-Control-Allow-Origin: *` を返す（2026-09-24 に確認。`Origin` なしの要求では地理院タイルはこのヘッダーを返さない）ので、ブラウザから直接読み込める。

---

## 2. 地理院タイル（背景地図・色別標高図）

根拠: 地理院タイル一覧 https://maps.gsi.go.jp/development/ichiran.html

| タイル | URL | 公式のズーム範囲 | 実際に確認した結果（鵠沼付近） | アプリの設定 |
| --- | --- | --- | --- | --- |
| 淡色地図 | `.../xyz/pale/{z}/{x}/{y}.png` | 日本全国 ZL5〜18（ZL2〜8 は全球版） | z2〜z18 は 200、z19 は 404 | minzoom 9 / maxzoom 18 |
| 標準地図 | `.../xyz/std/{z}/{x}/{y}.png` | 同上 | z2〜z18 は 200、z19 は 404 | minzoom 9 / maxzoom 18 |
| 写真 | `.../xyz/seamlessphoto/{z}/{x}/{y}.jpg` | ZL14〜18 全国最新写真（シームレス）、ZL9〜13 全国ランドサットモザイク画像、ZL2〜8 世界衛星モザイク画像 | z2〜z18 は 200、z19 は 404 | minzoom 9 / maxzoom 18 |
| 色別標高図 | `.../xyz/relief/{z}/{x}/{y}.png` | ZL5〜15 | z5〜z15 は 200、z4 以下と z16 以上は 404 | minzoom 5 / maxzoom 15 |

- 確認に使ったタイル: z15 x=29078 y=12944（鵠沼海岸）と、その親・子のタイル。
- 区分: 標準地図・淡色地図の ZL5〜18 は「1. 基本測量成果」。写真と色別標高図は「2. 基本測量成果以外で出典の記載のみで利用可能なもの」。
- 背景地図の minzoom を 9 にしているのは、ZL8 以下では「地理院タイル」の出典に加えて別の出所の明示が求められるため（一覧の各備考）。標準地図 ZL5〜8 は GEBCO Digital Atlas・海上保安庁許可番号・VMAP0、淡色地図 ZL5〜8 は VMAP0、写真 ZL2〜8（世界衛星モザイク画像）は NASA LP DAAC / USGS EROS の表記が要る。地図の最小ズームは 11 なので表示には影響しない。

### 出典の書き方

- 地理院タイル一覧の「1. 基本測量成果 ご利用について」:
  「地理院タイルをウェブサイトやソフトウェア、アプリケーション上でリアルタイムに読み込んで利用する場合、地理院タイルは出典の明示のみで申請不要でご利用いただけます。出典は、「国土地理院」または「地理院タイル」等と記載していただき、地理院タイル一覧ページ（https://maps.gsi.go.jp/development/ichiran.html）へのリンクを付けてください。」
  → `GSI_ATTRIBUTION`（「地理院タイル」＋一覧ページへのリンク）。
- 写真（ZL9〜13）: 一覧の備考で、次の出所を併記するよう求められている → `LANDSAT_CREDIT`
  「データソース：Landsat8画像（GSI,TSIC,GEO Grid/AIST）, Landsat8画像（courtesy of the U.S. Geological Survey）, 海底地形（GEBCO）」
- 色別標高図: 一覧の備考で、次の文言を併記するよう求められている → `RELIEF_EXTRA_CREDIT`
  「海域部は海上保安庁海洋情報部の資料を使用して作成」
- 標準地図・淡色地図は**基本測量成果**。リアルタイムの読み込みは申請不要だが、タイルを保存して配布（ミラー）すると
  測量法に基づく申請が必要になる場合がある（国土地理院の地図の利用手続 https://www.gsi.go.jp/LAW/2930-index.html ）。
  **背景地図のタイルはリポジトリやキャッシュに保存して配布しないこと。**
- 国土地理院コンテンツ利用規約（令和7年11月20日改正。公共データ利用規約（第1.0版）PDL1.0 を適用）:
  https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html
  「出典：国土地理院ウェブサイト（当該ページのURL）」が記載例。加工した場合は加工したことも記載し、
  国土地理院が作成したかのように見せてはいけない。

---

## 3. 標高タイル（計算用の地形）

根拠: 地理院タイル一覧「標高タイル（基盤地図情報数値標高モデル）」、標高タイルの詳細仕様 https://maps.gsi.go.jp/development/demtile.html

| 種類 | URL | 公式のズーム範囲 | 確認結果 |
| --- | --- | --- | --- |
| DEM1A（1m・航空レーザ） | `.../xyz/dem1a_png/{z}/{x}/{y}.png` | ZL1〜17 | 計算範囲の陸を含む z15 の 34 タイルすべて 200。鵠沼付近で z17 まで 200 |
| DEM5A（5m・航空レーザ） | `.../xyz/dem5a_png/{z}/{x}/{y}.png` | ZL1〜15 | 同じ 34 タイルすべて 200。z16 以上は 404 |
| DEM5B / DEM5C（5m・写真測量） | `.../xyz/dem5b_png/...`、`.../xyz/dem5c_png/...` | ZL1〜15 | （計算範囲の陸はほぼ DEM5A で覆われている。下記） |
| DEM10B（10m・等高線から） | `.../xyz/dem_png/{z}/{x}/{y}.png` | ZL1〜14 | z14 は 200、z15 は 404 |

- 計算範囲（東経139.44〜139.50°、北緯35.29〜35.345°）を覆う z15 タイルは 48 枚。そのうち 14 枚は海だけで、DEM1A・DEM5A とも 404（海域の値は標高タイルに無い）。
- 残り 34 枚の画素を比べると、DEM1A に値があって DEM5A が無効値の画素は約0.6%。両方に値がある画素の差（DEM1A − DEM5A）は中央値 0.0m、5〜95% で −0.22〜+0.23m。
- 元データは地表面の測定値で、建物・高架橋の高さは含まない。水部では値が無いか正確でない場合がある（「標高タイルの作成方法と地理院地図で表示される標高値について」 https://maps.gsi.go.jp/development/hyokochi.html ）。
- 画素値 → 標高: `x = 2^16 R + 2^8 G + B`、`x < 2^23` なら `h = 0.01x` [m]、`x = 2^23`（RGB = 128,0,0）は無効値、`x > 2^23` なら `h = 0.01(x − 2^24)`（標高タイルの詳細仕様）。
- 標高タイルは地理院タイル一覧の「2. 基本測量成果以外で出典の記載のみで利用可能なもの」に含まれる。
- アプリは標高タイルをグリッドに集約・補間し、海域には推定の水深を与えるので「加工」に当たる。
  国土地理院コンテンツ利用規約の加工時の記載例を使う（原文は「地理院タイル」と「（」の間に半角スペースがある）→ `DEM_CREDIT`。規約上、この記載は出典の記載「とは別に」書くものなので、地理院タイル一覧へのリンク（`DEM_CREDIT_HTML`）と併せて表示する
  **「地理院タイル（標高タイル（基盤地図情報数値標高モデル））を加工して作成」**
- **海の水深は国土地理院のデータではない。** 計算用の水深は terrain モジュールで推定している（`src/terrain/bathymetry.ts` の出典を参照）。画面では推定値であることを示す。
- 標高はすべて東京湾平均海面（T.P.）基準。DEM は建物・高架・橋を除いた地面の高さ。

### 標高 API

- 仕様: https://maps.gsi.go.jp/development/elevation_s.html
- `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon={経度}&lat={緯度}&outtype=JSON`
- 戻り値 `hsrc` は「1m（レーザ）」「5m（レーザ）」「5m（写真測量）」「5m（写真測量5C）」「10m」のいずれかで、その地点で最も精度の良い値を返す。鵠沼付近の地点はすべて「1m（レーザ）」だった。
- 「サーバに過度の負担を与えないでください」とあるため、アプリからは大量に呼ばない（地点の標高は事前に調べて `poi.ts` に記録した）。

---

## 4. 重ねるハザードマップ 津波浸水想定（公式の想定）

根拠: ハザードマップポータルサイト オープンデータ配信 https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html

- URL（統合版）: `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png`
- 神奈川県だけの版: `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/14/{z}/{x}/{y}.png`
- ズームレベル: ２〜１７（公式）。確認: 鵠沼付近で z2〜z17 は 200、z18 は 404。
- 凡例画像: https://disaportal.gsi.go.jp/hazardmap/copyright/img/shinsui_legend3.png
- 出典のデータの名称／作成者等: 都道府県（同ページ）。掲載状況の一覧（https://disaportal.gsi.go.jp/hazardmap/copyright/csv/tsunami.csv ）に「16,神奈川県,都道府県データ,」とある（1列目は管理上の通し番号で、都道府県コードではない）。
- この範囲のデータは**神奈川県の津波浸水想定（平成27年3月設定）**。
  神奈川県「津波浸水想定」について（平成27年３月）: https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/index.html
  - 最大クラスの津波をもたらす9地震のうち、「津波高さ」または「浸水域」が最大となる5地震の津波浸水予測図を重ね合わせ、浸水域と浸水深が最大となるようにした図。
  - 初期水位は朔望平均満潮位（相模湾 T.P.+0.85m）。地盤は沈下のみ考慮し隆起は考慮しない（「津波浸水想定について（解説）」p.10 https://www.pref.kanagawa.jp/uploaded/attachment/774580.pdf ）。
  - 河川内は津波による水位変化を着色していない。最大の浸水は第二波以降で生じる場合がある。局所的な地盤の凹凸や建物の影響により、想定より広く・深く浸水する場合もある（同 p.2〜3）。
  - 重ねるハザードマップの津波浸水想定は「浸水深」を表示している。水害ハザードマップ作成の手引き（p.36）では、市町村の津波ハザードマップは浸水深に代えて「津波基準水位」（せき上げを加えた水位）を用いるとしているので、藤沢市のハザードマップとは値が異なる場合がある。
  - 藤沢市は 2021年（令和3年）3月22日に神奈川県から**津波災害警戒区域**に指定されている。区域は平成27年の津波浸水想定と同じで、浸水深に建物等への衝突によるせき上げを加えた「基準水位」（0.1m 単位）が公表されている（藤沢市 https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/tsunamisaigaikeikaikuikisitei.html 、神奈川県の指定市町一覧 https://www.pref.kanagawa.jp/docs/f4i/tsunami/kuiki.html → `KANAGAWA_TSUNAMI_KEIKAI_URL`）。本アプリが重ねる公式タイルは基準水位ではなく浸水深である。

### 利用条件と出典（ハザードマップポータルサイト 利用規約 令和6年12月9日）

https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/copyright.html

- 公共データ利用規約（第1.0版）が適用され、商用・非商用とも利用可（「各種データの出典と掲載数」の「オープンデータ」列が〇: https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/copyright_data.html ）。
- 出典記載例: 「出典：「ハザードマップポータルサイト」」、「出典：「ハザードマップポータルサイト」（当該ページのURL）（〇年〇月〇日に利用）」
- 編集・加工して使う場合の記載例: 「「ハザードマップポータルサイト」を加工して作成」（→ `HAZARD_PROCESSED_CREDIT`）。加工した情報を国が作成したかのように見せてはいけない。
- 本アプリの表示: `HAZARD_TSUNAMI_TILES.attribution`（「ハザードマップポータルサイト（津波浸水想定：神奈川県）」、各リンク付き）、文字だけの場合は `HAZARD_CREDIT_TEXT`「出典：「ハザードマップポータルサイト」（津波浸水想定：神奈川県）」。
- 利用規約の「利用上の注意・免責」にある「最新かつ詳細な情報については各市町村が作成するハザードマップをご確認ください。」を画面にも出す（規約上の表示義務ではなく本アプリの方針。原文のまま `HAZARD_PORTAL_NOTICE`）。

### 浸水深の凡例（配色）

国土交通省「水害ハザードマップ作成の手引き」（令和8年5月）p.36〜38（PDF 42〜44頁）の「浸水深等 RGB（詳細版）」図3-5・「配色の参考値」表3-2
（https://www.mlit.go.jp/river/basic_info/jigyo_keikaku/saigai/tisiki/hazardmap/pdf/suigai_hazardmap_tebiki.pdf ）。
「津波浸水想定の設定の手引き Ver.2.11」（2023年4月）p.47 図-19・表-5 も同じ値
（https://www.mlit.go.jp/river/shishin_guideline/kaigan/tsunamishinsui_manual.pdf ）。
重ねるハザードマップの津波浸水想定の凡例が「水害ハザードマップ作成の手引き」に基づくことは、ポータルサイトの「浸水深の凡例の違いについて」（https://disaportal.gsi.go.jp/hazardmapportal/legend.pdf ）に書かれている。

| 浸水深 | RGB | 色 | 手引きの説明（p.36） |
| --- | --- | --- | --- |
| 0.3m未満 | 255,255,179 | `#ffffb3` | |
| 0.3〜0.5m | 247,245,169 | `#f7f5a9` | |
| 0.5〜1m | 248,225,166 | `#f8e1a6` | 0.5m は1階床高に相当 |
| 1〜3m | 255,216,192 | `#ffd8c0` | |
| 3〜5m | 255,183,183 | `#ffb7b7` | 3m は2階床下に相当 |
| 5〜10m | 255,145,145 | `#ff9191` | 5m は一般的な家屋の2階が水没 |
| 10〜20m | 242,133,201 | `#f285c9` | |
| 20m以上 | 220,122,220 | `#dc7adc` | |

- 標準版（6段階）は「0.5m未満 247,245,169」「0.5〜3m 255,216,192」で、詳細版の色の一部を使う。公式の凡例画像も「〜0.5m／〜0.3m」「0.5〜3m／0.5〜1m」の入れ子になっている。
- **実タイルとの照合**（2026-09-24、PNG を zlib で展開して画素を数えた）: 凡例画像 shinsui_legend3.png の画素値は上の8色と一致。計算範囲を覆う z15 の 48 タイルのうち 17 枚が存在し（残りは 404）、画素は透明（α=0）か上の表の7色（20m以上を除く、α=255）だけで、中間色（ぼかし）は無い。神奈川県沿岸の城ヶ島・真鶴・大磯付近の z14 タイルでは 20m以上 `#dc7adc` を含む8色すべてを確認。
- 計算範囲内の公式の浸水域は、辻堂〜鵠沼〜片瀬の海岸から内陸へ広がり、引地川・境川沿いではさらに内陸まで及ぶ（z15 の実タイルで浸水画素の最北は北緯約35.333°、引地川沿い）。5〜10m の区分は海岸沿いの帯（北緯35.304〜35.321°）と江の島に、10〜20m の区分は江の島の南岸（北緯35.296〜35.300°）と、計算範囲東端の鎌倉市腰越の海岸沿い（北緯約35.306°、東経139.492〜139.50°）にある（z15 の実タイルの画素位置を経緯度に直して確認。腰越は国土地理院の逆ジオコーダーで鎌倉市）。
- 浸水とみなす最小の深さ 0.01m（`MIN_FLOOD_DEPTH`）は、神奈川県の浸水深凡例の最下位区分「0.01m 以上 0.3m 未満」（「津波浸水想定について（解説）」p.4 図2）と、「津波浸水想定の設定の手引き Ver.2.11」p.16 の「打ち切り水深については、1cm程度を目安とする」による。区分の境界値ちょうどは上の区分に入れる（県の凡例が「以上・未満」の形のため）。

### 津波到達時間の配色（このアプリの設定）

公式の凡例ではない。相模トラフ沿いの海溝型地震（西側モデル）では、藤沢市への第1波の到達が6分、藤沢海岸（茅ヶ崎市境〜片瀬漁港海岸西側。鵠沼を含む）の最大津波到達が8分、湘南港海岸（江の島）が12分（藤沢市「藤沢市における想定津波の概要」 https://www.city.fujisawa.kanagawa.jp/documents/30834/souteitsunamigaiyou.pdf 。県の表では藤沢市の代表値が 11.5m・12分: 「津波浸水想定について（解説）」p.14 表1）なので、10〜30分を5分刻みで区別できるようにした。
色は viridis 配色（matplotlib `_viridis_data` の 256 色を 0, 1/6, …, 1 の位置で抜き出した7色。明度が単調に変わり、色の区別がつきにくくても明暗で順序が読める）で、早いほど暗い。最も遅い階級の黄は浸水深の「0.3m未満」の淡黄と似ているので、両方を同時に重ねない。

| 到達 | 色 |
| --- | --- |
| 10分以内 | `#440154` |
| 10〜15分 | `#443983` |
| 15〜20分 | `#31688e` |
| 20〜25分 | `#21918c` |
| 25〜30分 | `#35b779` |
| 30〜45分 | `#90d743` |
| 45分以降 | `#fde725` |

---

## 5. 指定緊急避難場所（津波） skhb05

根拠: 地理院タイル一覧「3. 上記以外のもの」→「指定緊急避難場所・指定避難所」、国土地理院「指定緊急避難場所データ」https://www.gsi.go.jp/bousaichiri/hinanbasho.html

- URL: `https://cyberjapandata.gsi.go.jp/xyz/skhb05/{z}/{x}/{y}.geojson`（05 = 津波。01 洪水、02 崖崩れ・土石流・地滑り、03 高潮、04 地震、06 大規模な火事、07 内水氾濫、08 火山現象）
- ズームレベル: 10 のみ（地理院地図での表示は 11〜18）。確認: z10 x=908 y=404 が 200（91 件）、z11 は 404。計算範囲はこの1タイルに収まる。
- 属性: `name`（施設・場所名）、`address`（住所）、`remarks`（備考）、`disaster5`（津波の指定 = 1）。
- 計算範囲内は7か所（2026-09-24 取得）: 江の島サムエル・コッキング苑（亀ヶ岡広場含む）、高砂小学校、市営鵠沼住宅、湘南学園中学校・高等学校、湘洋中学校、片瀬山公園、片瀬小学校。`src/data/shelters.ts` の内蔵の写しと一致。
- 利用条件（地理院タイル一覧の「ご利用上の注意」。内容に同意した場合のみ利用可）:
  1. 市町村長が指定した情報を各市町村が登録したもので、最新でない場合や未掲載の場合がある。最新かつ詳細は当該市町村に確認すること。
  2. 「指定緊急避難場所」と「指定避難所」の違い、指定緊急避難場所が災害種別ごとに指定されていることを理解して使うこと。
  3. データは随時更新される。
  4. 第三者に提供する場合は、上記の注意が正確に伝わるようにすること。
  → 画面に「最新の情報は藤沢市で確認」の注意を出す。
- 藤沢市が独自に指定している「津波避難ビル」の多くはこのデータに含まれない（藤沢市 津波避難ビル一覧: https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/bosai/tunamihinanbiruichiran.html ）。

---

## 6. OpenFreeMap（3D の建物）

根拠: https://openfreemap.org/ 、利用規約 https://openfreemap.org/tos/ （2026年9月9日更新）

- TileJSON: `https://tiles.openfreemap.org/planet`（tilejson 3.0.0、minzoom 0・maxzoom 14、OpenMapTiles スキーマ）
- tiles: `https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf` のように**日付入り**。更新で変わるので毎回 TileJSON から取得する（固定しない）。
- 建物レイヤー: `building`。fields = `render_height`, `render_min_height`, `colour`, `hide_3d`（minzoom 13・maxzoom 14。高さなどの属性は z14 だけ）。
- 確認: 鵠沼付近 z14（x=14538〜14540, y=6471〜6472）の .pbf を `@mapbox/vector-tile` 3.0.0 と `pbf` 5.1.2（`PbfReader`）で復号。すべての建物に `render_height`・`render_min_height` があり、高さ・下端が同じ建物は1つの MultiPolygon にまとめられている（例: x=14539, y=6471 で 8 フィーチャー・13,683 ポリゴン）。
- 高さの算出（planetiler-openmaptiles `Building.java`）: `render_height = ceil(height ?? building:levels × 3.66 ?? 5)`、`render_min_height = floor(min_height ?? building:min_level × 3.66 ?? 0)`。
  OSM に高さ・階数がない建物は一律 **5m**。鵠沼付近の z14 タイル5枚では建物ポリゴンの約99%（98.6〜99.6%）が 5m で、**実際の高さではない**（`OPENFREEMAP.heightNote` を画面に出す）。
- 出典表記（TileJSON の attribution と同じ）: `OpenFreeMap © OpenMapTiles Data from OpenStreetMap`（各リンク付き）。
  OpenFreeMap のサイト: 「MapLibre を使う場合は自動で表示される。それ以外のクライアント（本アプリの 3D 表示など）では次の出典を必ず表示すること」。
- 利用規約の要点: 無料・保証なし、予告なく停止する場合がある、許可なく自動的にデータを収集しないこと。3D 表示に必要な範囲（計算範囲の z14 タイル十数枚）だけを取得する。
- 地図データのライセンスは OpenStreetMap（ODbL）: https://www.openstreetmap.org/copyright

---

## 7. 地点（POI）の座標と標高

`src/data/poi.ts`。位置の決め方:

- **駅**: OpenStreetMap の駅ノード（Nominatim で名前・運営会社を確認）。国土地理院 地名検索 API（`https://msearch.gsi.go.jp/address-search/AddressSearch?q=...`）の結果や標準地図 z17 と照合。
  地名検索が返すのは地図の注記（文字）の位置で、片瀬江ノ島駅・湘南海岸公園駅では駅から約400〜450m西にずれているため、駅の位置には使わなかった。
- **施設・公園**: 地名検索（施設）または OSM の位置を、標準地図・写真（z17）で確認。鵠沼海浜公園の所在地は藤沢市鵠沼海岸四丁目4番1号（引地川の西）。
- **河口**: 標準地図 z16〜17 で川が海に出る地点（導流堤の先端の間）を読み取った。
- **標高**: 国土地理院 標高 API（すべて hsrc =「1m（レーザ）」）。地面の高さで、高架の駅や橋の上の高さではない。水面・橋（河口・大橋）は入れていない。

| 地点 | 経度 | 緯度 | 標高 [m, T.P.] | 位置の出典 |
| --- | --- | --- | --- | --- |
| 鵠沼海岸駅（小田急） | 139.47127 | 35.32071 | 4.2 | OSM node 10108140339 |
| 片瀬江ノ島駅（小田急） | 139.48350 | 35.30887 | 4.1 | OSM node 264240233 |
| 鵠沼駅（江ノ電） | 139.48260 | 35.32142 | 5.9 | OSM node 8062865734 |
| 江ノ島駅（江ノ電） | 139.48754 | 35.31105 | 4.4 | OSM node 8062865735 |
| 湘南海岸公園駅（江ノ電） | 139.48364 | 35.31495 | 4.0 | OSM node 8063967424 |
| 藤沢駅（JR） | 139.48721 | 35.33882 | 13.0 | OSM node 4011607028 |
| 江島神社 辺津宮 | 139.47954 | 35.30049 | 46.0 | OSM way 191660159 |
| 江の島大橋（北詰） | 139.4828 | 35.3056 | — | OSM way 335334813 の北端 |
| 新江ノ島水族館 | 139.47944 | 35.31008 | 6.0 | OSM way 727347470・地名検索 |
| 鵠沼海浜公園 | 139.46619 | 35.31617 | 3.8 | 地名検索（施設） |
| 辻堂海浜公園 | 139.44817 | 35.32128 | 6.7 | OSM way 164139709・地名検索 |
| 引地川河口 | 139.4684 | 35.3149 | — | 標準地図から読み取り |
| 境川河口 | 139.48123 | 35.30537 | — | 地名検索（自然地名「境川」） |
| 藤沢市役所 | 139.49112 | 35.33887 | 12.8 | OSM node 1420832774・地名検索 |

すべて計算範囲内。位置の一部は OSM 由来なので、地点を表示するときは `POI_ATTRIBUTION`（© OpenStreetMap contributors）を表示する。

---

## 8. シナリオ（地震・津波の想定値）の根拠資料

値ごとのページ番号は `src/data/scenarios.ts` のコメントにある。主な資料:

| 略号 | 資料 | 主な用途 |
| --- | --- | --- |
| K-解説 | 神奈川県「津波浸水想定について（解説）」平成27年（同6月22日一部修正） https://www.pref.kanagawa.jp/uploaded/attachment/774580.pdf | 最大津波高さの定義（p.4）、対象5地震と規模（p.5）、初期水位 T.P.+0.85m（p.10）、粗度係数（p.13）、藤沢市 11.5m・12分（p.14 表1）、地震別の藤沢市最大（p.16 表2） |
| K-想定 | 神奈川県「津波浸水想定」について（平成27年３月） https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/index.html | 津波浸水想定の位置づけ（重ねるハザードマップの元データ） |
| K-予測図 | 神奈川県「津波浸水予測図」（9地震ごと） https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892442.html | 藤沢海岸・片瀬漁港海岸・湘南港海岸の最大津波高さ・最大津波到達時間（各地震の 17/24 図） |
| F-概要 | 藤沢市「藤沢市における想定津波の概要」 https://www.city.fujisawa.kanagawa.jp/documents/30834/souteitsunamigaiyou.pdf | 西側モデルの第1波到達6分・震度7 など |
| F-HM | 藤沢市「津波ハザードマップ（令和2年度作成）」 https://www.city.fujisawa.kanagawa.jp/bousai/bosai/bosai/hazardmap/tsunami/h25hazardmap.html | 想定地震の概要、避難の案内先 |
| K-部会8 | 神奈川県 第8回津波浸水想定検討部会 資料「最大クラスの津波に関する検討の進め方について」 https://www.pref.kanagawa.jp/uploaded/attachment/750502.pdf | 県の5地震に入らなかった地震（西相模灘・大正関東・明応・神奈川県西部）の規模（p.1〜3） |
| K-被害R7 | 神奈川県「地震被害想定調査報告書」第2章（令和7年3月） https://www.pref.kanagawa.jp/documents/16375/2syou01.pdf | 地震別の藤沢市の震度（表2.2） |
| 内閣府2012 | 南海トラフの巨大地震モデル検討会 第二次報告 市町村別一覧表 https://www.bousai.go.jp/jishin/nankai/pdf/shichouson_ichiran.pdf ・ 報告書 https://www.bousai.go.jp/jishin/nankai/model/pdf/20120829_2nd_report01.pdf | 南海トラフ巨大地震の藤沢市の津波高・到達時間・震度 |
| 内閣府2025 | 南海トラフ巨大地震モデル・被害想定手法検討会（令和7年3月）市町村別一覧表 https://www.bousai.go.jp/jishin/nankai/kento_wg/pdf/ichiran.pdf | 同上（見直し後） |
| 萬年2013 | 萬年ほか（2013）歴史地震 第28号 pp.71–84 https://www.histeq.jp/kaishi_28/HE28_071_084_Mannnen.pdf | 1923年大正関東地震の津波（藤沢・鵠沼） |
| JMA月報 | 気象庁「地震・火山月報（防災編）」令和7年7月 https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/202507/202507monthly.pdf | 遠地津波の例（2025年カムチャツカ半島付近の地震） |
| JMA津波 | 気象庁「津波警報・注意報、津波情報、津波予報について」 https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html | 警報・注意報の区分と説明用の例 |
| 手引き | 国土交通省「津波浸水想定の設定の手引き Ver.2.11」（2023年4月） https://www.mlit.go.jp/river/shishin_guideline/kaigan/tsunamishinsui_manual.pdf | 設定潮位（朔望平均満潮位）、粗度係数、打ち切り水深 |

神奈川県「津波浸水予測図」の地震ごとのページと、藤沢市を含む図（17/24 図「鎌倉市七里ガ浜から藤沢市」、18/24 図「藤沢市から茅ヶ崎市」。図の範囲の名前は各ページの一覧による）:

| 地震 | ページ | 17/24 図（PDF） | 18/24 図（PDF） |
| --- | --- | --- | --- |
| 相模トラフ沿いの海溝型地震（西側モデル） | https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892754.html | https://www.pref.kanagawa.jp/uploaded/attachment/760437.pdf | https://www.pref.kanagawa.jp/uploaded/attachment/760438.pdf |
| 相模トラフ沿いの海溝型地震（中央モデル） | https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892753.html | https://www.pref.kanagawa.jp/uploaded/attachment/760470.pdf | https://www.pref.kanagawa.jp/uploaded/attachment/760471.pdf |
| 元禄関東地震タイプ | https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892750.html | https://www.pref.kanagawa.jp/uploaded/attachment/760382.pdf | https://www.pref.kanagawa.jp/uploaded/attachment/760383.pdf |
| 元禄関東地震タイプと国府津-松田断層帯地震の連動地震 | https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892749.html | https://www.pref.kanagawa.jp/uploaded/attachment/760408.pdf | https://www.pref.kanagawa.jp/uploaded/attachment/760409.pdf |
| 慶長型地震 | https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892748.html | https://www.pref.kanagawa.jp/uploaded/attachment/760101.pdf | https://www.pref.kanagawa.jp/uploaded/attachment/760103.pdf |
| 大正関東地震タイプ | https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892751.html | https://www.pref.kanagawa.jp/uploaded/attachment/760278.pdf | https://www.pref.kanagawa.jp/uploaded/attachment/760279.pdf |
| 明応型地震 | https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892747.html | https://www.pref.kanagawa.jp/uploaded/attachment/760217.pdf | https://www.pref.kanagawa.jp/uploaded/attachment/760219.pdf |
| 神奈川県西部地震 | https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892746.html | https://www.pref.kanagawa.jp/uploaded/attachment/760321.pdf | https://www.pref.kanagawa.jp/uploaded/attachment/760322.pdf |
| 西相模灘地震 | https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892752.html | https://www.pref.kanagawa.jp/uploaded/attachment/760349.pdf | https://www.pref.kanagawa.jp/uploaded/attachment/760350.pdf |

遠地津波の例では、上の JMA月報に加えて気象庁の報道発表（令和7年7月30日） https://www.jma.go.jp/jma/press/2507/30b/202507301300.html を参照している。

- 公的資料に値が無いもの（周期・波の数・揺れの継続時間など）は**設定値（仮定）**で、各シナリオの説明にそう書いている。
- 「最大津波高さ」は海岸線から沖合約30m地点の最大水位（T.P.、潮位を含む）。気象庁の「津波の高さ」（平常潮位からの高さ）とは基準が違う（K-解説 p.4）。

## 9. その他の資料（震度・津波警報の説明）

- 気象庁「気象庁震度階級関連解説表」 https://www.jma.go.jp/jma/kishou/know/shindo/kaisetsu.html （`src/data/intensity.ts`）
- 気象庁「気象庁ホームページにおける気象情報の配色に関する設定指針」（平成24年5月） https://www.jma.go.jp/jma/kishou/info/colorguide/120524_hpcolorguide.pdf （震度・津波警報の表示色）
- 気象庁「津波警報・注意報、津波情報、津波予報について」 https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html （`src/data/warnings.ts`）

---

## 10. 確認の方法（再確認するとき）

```sh
# タイルの有無（鵠沼海岸 z15 x=29078 y=12944 とその親子）
curl -s -o /dev/null -w "%{http_code}\n" https://cyberjapandata.gsi.go.jp/xyz/pale/18/232631/103555.png      # 200
curl -s -o /dev/null -w "%{http_code}\n" https://cyberjapandata.gsi.go.jp/xyz/relief/16/58157/25888.png       # 404（最大 z15）
curl -s -o /dev/null -w "%{http_code}\n" https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/17/116315/51777.png  # 200
curl -s -o /dev/null -w "%{http_code}\n" https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/18/232631/103555.png # 404
# OpenFreeMap の TileJSON
curl -s https://tiles.openfreemap.org/planet | python3 -m json.tool | head -40
# 地点の標高
curl -s "https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=139.47127&lat=35.32071&outtype=JSON"
# CORS（ブラウザと同じく Origin を付ける。付けないと地理院タイルは Access-Control-Allow-Origin を返さない）
curl -s -o /dev/null -H 'Origin: https://example.com' -w "%header{access-control-allow-origin}\n" https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/15/29078/12943.png  # *
# 地点の町丁目（国土地理院 逆ジオコーダー）
curl -s "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=35.31617&lon=139.46619"  # 鵠沼海岸四丁目
```

www.gsi.go.jp（利用規約・測量成果の利用手続のページ）は古い TLS 再ネゴシエーションが必要で curl では取得できないことがある。
その場合は Python の `ssl` で `OP_LEGACY_SERVER_CONNECT` を付けて（証明書の検証は有効のまま）取得する。

浸水深タイルの色は、PNG を zlib で展開して画素ごとの色を数えれば確認できる（パレット形式・RGBA 形式のどちらも、凡例の8色と透明以外が無いことを確かめる）。

---

## 11. 独立の再確認の記録（2026-09-24）

このファイルと `src/data/sources.ts`・`src/data/poi.ts` の内容を、一次資料とデータを取り直して別途確認した。

- **確認できたもの**: 地理院タイルの URL・ズーム範囲・出典の文言（写真の Landsat8 の出所、色別標高図の海上保安庁の文言）、
  標高タイルのズーム範囲と RGB → 標高の式、国土地理院コンテンツ利用規約（令和7年11月20日改正）の加工時の記載例、
  ハザードマップポータルサイトの利用規約（令和6年12月9日）とオープンデータ配信の URL・ズーム（２〜１７）・凡例画像、
  浸水深8区分の RGB（水害ハザードマップ作成の手引き 令和8年5月 p.37〜38、津波浸水想定の設定の手引き Ver.2.11 p.47）、
  打ち切り水深 1cm（同 p.16）、神奈川県の解説資料（p.4・5・10・13・14・16）、OpenFreeMap の TileJSON・出典・建物の高さの算出式、
  viridis の7色、地点14か所の位置（標準地図・写真・OSM・国土地理院の地名検索と逆ジオコーダーで照合し、すべて50m以内）と標高 API の値。
- **直したもの**:
  - 一覧表で写真・色別標高図の利用条件を「同上（基本測量成果）」としていたのを「出典の記載のみで利用可能なもの」に訂正。
  - 背景地図の minzoom の理由（「GEBCO 等」）を、タイルごとに求められる出所（GEBCO・海上保安庁許可・VMAP0・LP DAAC）に訂正。
  - 10〜20m の区分の場所に、計算範囲東端の鎌倉市腰越の海岸を追加（江の島南岸だけではなかった）。
  - 到達時間の「藤沢市の最大波到達12分」は江の島（湘南港海岸）の値であることを明記し、鵠沼を含む藤沢海岸の8分・第1波6分を追加。
  - OpenFreeMap の「商用可」は公式に明記が無いので削除。
  - ハザードマップポータルサイトの注意文を「規約上の表示義務」としていたのを「本アプリの方針」に訂正。
  - 藤沢市が 2021年3月22日に津波災害警戒区域に指定され「基準水位」が公表されていること、公式タイルは基準水位ではなく浸水深であることを追加。
  - 地理院タイル（cyberjapandata）は `Origin` を付けた要求にだけ CORS ヘッダーを返すことを明記（disaportaldata は付けなくても返す）。
- **確かめきれなかったもの**: シナリオの根拠資料（§8）のうち、内閣府の一覧表・萬年ほか（2013）・気象庁月報は、資料の存在と題名・藤沢市の行があることまでを確認し、
  各値のページ番号は `src/data/scenarios.ts` の担当の確認に任せている。

