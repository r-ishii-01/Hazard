/**
 * 地図タイル・データの取得先と出典表記、浸水深・到達時間の配色。
 *
 * ここに書いた URL・ズーム範囲・出典表記・色は、すべて公式の資料で確認し、
 * さらに実際にタイルを取得して確かめた（2026年9月24日確認）。確認方法は各定数のコメントと
 * docs/DATA_SOURCES.md を参照。
 *
 * 主な根拠資料:
 * - 地理院タイル一覧（URL・ズーム範囲・出典の書き方）: https://maps.gsi.go.jp/development/ichiran.html
 * - 国土地理院コンテンツ利用規約（令和7年11月20日改正、PDL1.0 準拠）: https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html
 * - 標高タイルの詳細仕様: https://maps.gsi.go.jp/development/demtile.html
 * - ハザードマップポータルサイト オープンデータ配信: https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html
 * - ハザードマップポータルサイト 利用規約（令和6年12月9日）: https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/copyright.html
 * - 国土交通省「水害ハザードマップ作成の手引き」（令和8年5月）p.36〜38（PDF 42〜44頁）図3-3・図3-5・表3-2:
 *   https://www.mlit.go.jp/river/basic_info/jigyo_keikaku/saigai/tisiki/hazardmap/pdf/suigai_hazardmap_tebiki.pdf
 * - OpenFreeMap: https://openfreemap.org/ （TileJSON: https://tiles.openfreemap.org/planet）
 */
import type { Basemap } from '../core/types';

export interface RasterTileSource {
  id: string;
  label: string;
  /** {z}/{x}/{y} を含む URL テンプレート */
  url: string;
  minzoom: number;
  maxzoom: number;
  tileSize: number;
  /** HTML の出典表記 */
  attribution: string;
  /** 補足（ズームによるデータソースの違い・利用上の注意など。画面表示用の日本語） */
  notes?: string;
  /** 根拠資料の URL */
  docUrl?: string;
}

// ---------------------------------------------------------------------------
// 地理院タイル
// ---------------------------------------------------------------------------

/** 地理院タイル一覧ページ（出典表記のリンク先に指定されている） */
export const GSI_TILE_LIST_URL = 'https://maps.gsi.go.jp/development/ichiran.html';

/**
 * 地理院タイルの出典表記。
 * 「出典は、「国土地理院」または「地理院タイル」等と記載していただき、地理院タイル一覧ページ
 * （https://maps.gsi.go.jp/development/ichiran.html）へのリンクを付けてください。」
 * （地理院タイル一覧「1. 基本測量成果 ご利用について」 https://maps.gsi.go.jp/development/ichiran.html ）
 * 標準地図・淡色地図は基本測量成果だが、ウェブ上でリアルタイムに読み込む場合は出典の明示のみで申請不要（同ページ）。
 * ※ タイルを保存して配布する（ミラーする）場合は測量法に基づく申請が必要になることがあるため、背景地図はミラーしない。
 */
export const GSI_ATTRIBUTION = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';

/**
 * 写真タイル（seamlessphoto）のズーム9〜13は「全国ランドサットモザイク画像」で、
 * 「国土地理院コンテンツ利用規約」で定める出所明示に加えて次の出所の明示が求められている
 * （地理院タイル一覧「写真」の備考 https://maps.gsi.go.jp/development/ichiran.html ）。
 */
export const LANDSAT_CREDIT =
  'データソース：Landsat8画像（GSI,TSIC,GEO Grid/AIST）, Landsat8画像（courtesy of the U.S. Geological Survey）, 海底地形（GEBCO）';

/**
 * 色別標高図を利用する場合に併記が求められている文言
 * （地理院タイル一覧「色別標高図」の備考 https://maps.gsi.go.jp/development/ichiran.html ）。
 */
export const RELIEF_EXTRA_CREDIT = '海域部は海上保安庁海洋情報部の資料を使用して作成';

/**
 * 背景地図。
 * - URL・ズーム範囲: 地理院タイル一覧（標準地図・淡色地図: 日本全国 ZL5〜18、写真: ZL2〜18。
 *   写真は ZL14〜18 が全国最新写真（シームレス）、ZL9〜13 が全国ランドサットモザイク画像、ZL2〜8 が世界衛星モザイク画像）。
 * - 実際の確認（2026-09-24）: 鵠沼付近 z15 x=29078 y=12944 系列のタイルで pale/std/seamlessphoto とも z18 まで 200、z19 は 404。
 * - 区分（地理院タイル一覧）: 標準地図・淡色地図の ZL5〜18 は「1. 基本測量成果」、写真は
 *   「2. 基本測量成果以外で出典の記載のみで利用可能なもの」。
 * - minzoom を 9 にしているのは、ZL8 以下では「地理院タイル」の出典に加えて別の出所の明示が求められるため
 *   （地理院タイル一覧の各備考）: 標準地図 ZL5〜8 は GEBCO Digital Atlas・海上保安庁許可番号・VMAP0、
 *   淡色地図 ZL5〜8 は VMAP0、写真 ZL2〜8（世界衛星モザイク画像）は NASA LP DAAC / USGS EROS。
 *   地図の最小ズームは 11 なので表示上の影響はない。
 */
export const BASEMAPS: Record<Basemap, RasterTileSource> = {
  pale: {
    id: 'gsi-pale',
    label: '淡色地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    minzoom: 9,
    maxzoom: 18,
    tileSize: 256,
    attribution: GSI_ATTRIBUTION,
    docUrl: GSI_TILE_LIST_URL,
  },
  std: {
    id: 'gsi-std',
    label: '標準地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    minzoom: 9,
    maxzoom: 18,
    tileSize: 256,
    attribution: GSI_ATTRIBUTION,
    docUrl: GSI_TILE_LIST_URL,
  },
  photo: {
    id: 'gsi-photo',
    // 地理院タイルでの名称は「写真」（全国最新写真（シームレス））。ズーム13以下は衛星画像のため「航空写真」とは呼ばない
    label: '写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    minzoom: 9,
    maxzoom: 18,
    tileSize: 256,
    attribution: `${GSI_ATTRIBUTION}（写真） ／ ズーム9〜13: ${LANDSAT_CREDIT}`,
    notes: 'ズーム14〜18は全国最新写真（シームレス。空中写真等から作成）、ズーム9〜13は全国ランドサットモザイク画像です。撮影時期は場所により異なります。',
    docUrl: GSI_TILE_LIST_URL,
  },
};

/**
 * 色別標高図。
 * - URL・ズーム範囲（ZL5〜15）: 地理院タイル一覧「色別標高図」 https://maps.gsi.go.jp/development/ichiran.html
 *   （区分は「2. 基本測量成果以外で出典の記載のみで利用可能なもの」）
 * - 実際の確認（2026-09-24）: 鵠沼付近で z5〜z15 は 200、z16 以上と z4 以下は 404。
 */
export const RELIEF_TILES: RasterTileSource = {
  id: 'gsi-relief',
  label: '色別標高図',
  url: 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png',
  minzoom: 5,
  maxzoom: 15,
  tileSize: 256,
  attribution: `${GSI_ATTRIBUTION}（色別標高図） ${RELIEF_EXTRA_CREDIT}`,
  docUrl: GSI_TILE_LIST_URL,
};

// ---------------------------------------------------------------------------
// 標高タイル（地形の計算に使う）
// ---------------------------------------------------------------------------

/**
 * 標高タイルを加工して使う場合の記載。国土地理院コンテンツ利用規約の
 * 「コンテンツを編集・加工等して利用する場合の記載例」の文言
 * （https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html 「１）出典の記載について イ」。
 *  原文は「地理院タイル （標高タイル…」と括弧の前に半角スペースがあるが、ここでは詰めている）。
 * 同規約では、この加工の記載は出典の記載「とは別に」書くものとされているので、
 * 画面では地理院タイル一覧へのリンク（DEM_CREDIT_HTML）と併せて表示する。
 * 本アプリは標高タイルをグリッドに集約・補間し、海域には推定水深を与えているので「加工」に当たる。
 * 加工したものを国土地理院が作成したかのように見せてはいけない（同規約）。
 */
export const DEM_CREDIT = '地理院タイル（標高タイル（基盤地図情報数値標高モデル））を加工して作成';

/** DEM_CREDIT の HTML 版（地理院タイル一覧へのリンク付き） */
export const DEM_CREDIT_HTML =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>（標高タイル（基盤地図情報数値標高モデル））を加工して作成';

export interface DemTileSource {
  id: string;
  label: string;
  url: string;
  minzoom: number;
  maxzoom: number;
}

/**
 * 標高タイル（PNG 形式）。精度の良い順。
 * - URL・ズーム範囲: 地理院タイル一覧「標高タイル（基盤地図情報数値標高モデル）」
 *   （DEM1A: ZL1〜17、DEM5A/5B/5C: ZL1〜15、DEM10B: ZL1〜14） https://maps.gsi.go.jp/development/ichiran.html
 * - 画素値の意味: x = 2^16 R + 2^8 G + B、x < 2^23 → h = 0.01x、x = 2^23 → 無効値（RGB=128,0,0）、x > 2^23 → h = 0.01(x − 2^24)
 *   （標高タイルの詳細仕様 https://maps.gsi.go.jp/development/demtile.html ）
 * - 実際の確認（2026-09-24）: 計算範囲を覆う z15 の 48 タイルのうち陸を含む 34 タイルで dem1a_png・dem5a_png とも 200
 *   （残り 14 タイルは海のみで両方 404）。鵠沼付近で dem1a_png は z17 まで 200、dem5a_png は z16 以上 404、
 *   dem_png（DEM10B）は z14 まで 200・z15 は 404。
 *   この 34 タイルの画素を比べると、DEM1A に値があって DEM5A が無効値の画素は約0.6%、
 *   両方に値がある画素での差（DEM1A − DEM5A）は中央値 0.0m・5〜95% で −0.22〜+0.23m だった。
 * - 標高 API（getelevation.php）も鵠沼付近では「1m（レーザ）」（DEM1A）の値を返す。
 * - 元データは地表面の標高で、建物・高架橋の高さは含まない。水部（海・川）では値が無いか、
 *   正確な値が入っていない場合がある（「標高タイルの作成方法と地理院地図で表示される標高値について」
 *   https://maps.gsi.go.jp/development/hyokochi.html ）。
 */
export const DEM_TILES: readonly DemTileSource[] = [
  { id: 'dem1a_png', label: 'DEM1A（1mメッシュ・航空レーザ測量）', url: 'https://cyberjapandata.gsi.go.jp/xyz/dem1a_png/{z}/{x}/{y}.png', minzoom: 1, maxzoom: 17 },
  { id: 'dem5a_png', label: 'DEM5A（5mメッシュ・航空レーザ測量）', url: 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png', minzoom: 1, maxzoom: 15 },
  { id: 'dem5b_png', label: 'DEM5B（5mメッシュ・写真測量）', url: 'https://cyberjapandata.gsi.go.jp/xyz/dem5b_png/{z}/{x}/{y}.png', minzoom: 1, maxzoom: 15 },
  { id: 'dem5c_png', label: 'DEM5C（5mメッシュ・写真測量）', url: 'https://cyberjapandata.gsi.go.jp/xyz/dem5c_png/{z}/{x}/{y}.png', minzoom: 1, maxzoom: 15 },
  { id: 'dem_png', label: 'DEM10B（10mメッシュ・地形図の等高線から作成）', url: 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png', minzoom: 1, maxzoom: 14 },
];

/**
 * 国土地理院 標高 API（1地点の標高と、そのデータソース hsrc を返す）。
 * 仕様: https://maps.gsi.go.jp/development/elevation_s.html （「サーバに過度の負担を与えないでください」とある）
 */
export const GSI_ELEVATION_API = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon={lon}&lat={lat}&outtype=JSON';

// ---------------------------------------------------------------------------
// ハザードマップポータルサイト（重ねるハザードマップ）
// ---------------------------------------------------------------------------

/** ハザードマップポータルサイト オープンデータ配信ページ */
export const DISAPORTAL_OPENDATA_URL = 'https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html';
/** ハザードマップポータルサイト 利用規約 */
export const DISAPORTAL_TERMS_URL = 'https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/copyright.html';
/** 神奈川県「津波浸水想定」について（平成27年3月） */
export const KANAGAWA_TSUNAMI_ASSUMPTION_URL = 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/index.html';

/**
 * ハザードマップポータルサイトのデータを使うときの出典（文字列）。
 * 利用規約の出典記載例は「出典：「ハザードマップポータルサイト」」
 * （https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/copyright.html 「１）出典の記載について」）。
 * 津波浸水想定のデータの作成者は都道府県（オープンデータ配信ページの「出典のデータの名称／作成者等」欄）で、
 * この範囲は神奈川県の津波浸水想定（平成27年3月設定）なので、それを併記する。
 */
export const HAZARD_CREDIT_TEXT = '出典：「ハザードマップポータルサイト」（津波浸水想定：神奈川県）';

/**
 * ハザードマップポータルサイトのデータを加工（色の読み替え・再描画・集計など）して使う場合の記載
 * （同利用規約の「コンテンツを編集・加工等して利用する場合の記載例」）。
 */
export const HAZARD_PROCESSED_CREDIT = '「ハザードマップポータルサイト」を加工して作成';

/**
 * ハザードマップポータルサイト利用規約「利用上の注意・免責」1. の一文（原文のまま）
 * （https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/copyright.html ）。
 * 規約上の表示義務ではないが、本アプリでは公式の浸水想定を重ねて表示するときに同じ注意を出す。
 */
export const HAZARD_PORTAL_NOTICE = '最新かつ詳細な情報については各市町村が作成するハザードマップをご確認ください。';

/**
 * 藤沢市の津波災害警戒区域（イエローゾーン）の指定について。神奈川県が 2021年（令和3年）3月22日に指定。
 * 区域は平成27年の津波浸水想定と同じで、浸水深に建物等への衝突によるせき上げを加えた「基準水位」が公表されている
 * （藤沢市「津波災害警戒区域に指定されました」 https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/tsunamisaigaikeikaikuikisitei.html 、
 *  神奈川県「津波災害警戒区域の指定について」の指定市町一覧 https://www.pref.kanagawa.jp/docs/f4i/tsunami/kuiki.html ）。
 */
export const KANAGAWA_TSUNAMI_KEIKAI_URL = 'https://www.pref.kanagawa.jp/docs/f4i/tsunami/kuiki.html';

/**
 * このサイトの計算と公式の津波浸水想定の違い（画面表示用）。
 * 公式（統合）は5地震の重ね合わせだが、差はそれだけではない。docs/MODEL.md 4.13.5 の比較
 * （相模トラフ西側モデル・既定の周期20分・6波・陸の粗度0.06・解像度「標準」）では、
 * - 西側モデル単独の県の予測図（17/24・18/24 図）に対して: 予測図の浸水域のうち計算でも浸水 83.1%（鵠沼付近 87.7%）、
 *   計算の浸水域のうち予測図の中 95.4%、両方で浸水したセルの 40.8% で計算の方が浅い階級（深いのは 2.0%）。
 *   浸水面積は予測図 4.84km² に対し計算 4.22km²。
 * - 統合（5地震の重ね合わせ。西側モデル単独で統合の 93.8% を占める）に対して: 80.4%（鵠沼付近 84.6%）、precision 98.3%。
 *   （統合との比較は 2026-09-24 に現在のコードで再計算し、4.22km²・0.804・0.983 を再現した）
 * → 「重ね合わせだから広い」だけでなく、同じ地震どうしでも計算の方が1〜2割狭く浅めであることを伝える。
 */
export const SIM_VS_OFFICIAL_NOTE =
  'このサイトの計算は、公式の想定より浸水が狭く、浅めです。重ね合わせの違いだけでなく、同じ相模トラフ西側モデルの県の予測図と比べても、計算の浸水域は1〜2割狭く、浸水深も浅めでした（解像度「標準」で比較）。公式の想定の方が広く深い前提で見てください。';

/**
 * 重ねるハザードマップ 津波浸水想定（統合版）。
 * - URL・ズーム範囲（２〜１７）・凡例画像: オープンデータ配信ページ「津波浸水想定」
 *   https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html
 *   （凡例 https://disaportal.gsi.go.jp/hazardmap/copyright/img/shinsui_legend3.png ）
 * - 神奈川県だけのタイルは .../04_tsunami_newlegend_pref_data/14/{z}/{x}/{y}.png（HAZARD_TSUNAMI_KANAGAWA_URL）。
 *   掲載状況の一覧 https://disaportal.gsi.go.jp/hazardmap/copyright/csv/tsunami.csv に「16,神奈川県,都道府県データ,」とある
 *   （1列目は管理上の通し番号。掲載状況一覧ページ https://disaportal.gsi.go.jp/hazardmap/copyright/tsunami_sinsui.html の説明による）。
 * - 表示しているのは「浸水深」。津波災害警戒区域の「基準水位」（せき上げを含む）とは別の値（KANAGAWA_TSUNAMI_KEIKAI_URL 参照）。
 * - 実際の確認（2026-09-24）: 鵠沼付近で z2〜z17 は 200、z18 は 404。
 * - 利用規約: 公共データ利用規約（第1.0版）が適用され、オープンデータ配信ページに「商用非商用問わずご利用いただけます」とある。出典の記載が必要。
 * - 利用規約の「利用上の注意・免責」の注意（HAZARD_PORTAL_NOTICE）を画面にも出す（本アプリの方針）。
 */
export const HAZARD_TSUNAMI_TILES: RasterTileSource = {
  id: 'hazard-tsunami',
  label: '津波浸水想定（神奈川県・ハザードマップポータルサイト）',
  url: 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png',
  minzoom: 2,
  maxzoom: 17,
  tileSize: 256,
  attribution:
    '<a href="https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html" target="_blank" rel="noopener">ハザードマップポータルサイト</a>（津波浸水想定：<a href="https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/index.html" target="_blank" rel="noopener">神奈川県</a>）',
  // 神奈川県「津波浸水想定について（解説）」p.1〜2（5地震の重ね合わせ・河川内は着色しない）
  // https://www.pref.kanagawa.jp/uploaded/attachment/774580.pdf
  // 計算との違いは SIM_VS_OFFICIAL_NOTE（docs/MODEL.md 4.13.5）
  notes:
    '神奈川県が津波防災地域づくりに関する法律に基づき設定した津波浸水想定（平成27年3月）。最大クラスの5つの地震の計算結果を重ね合わせた最大の浸水深で、建物に当たってせり上がる分を加えた「基準水位」ではありません。河川内の水位変化は着色されていません。最新・詳細は藤沢市のハザードマップで確認してください。' +
    SIM_VS_OFFICIAL_NOTE,
  docUrl: DISAPORTAL_OPENDATA_URL,
};

/** 神奈川県分だけの津波浸水想定タイル（都道府県コード 14）。出典は HAZARD_TSUNAMI_TILES と同じ */
export const HAZARD_TSUNAMI_KANAGAWA_URL = 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_pref_data/14/{z}/{x}/{y}.png';

/** 公式の凡例画像（浸水深） */
export const HAZARD_TSUNAMI_LEGEND_IMAGE = 'https://disaportal.gsi.go.jp/hazardmap/copyright/img/shinsui_legend3.png';

// ---------------------------------------------------------------------------
// 浸水深の配色
// ---------------------------------------------------------------------------

export interface DepthClass {
  /** 下限 [m]（この値以上） */
  min: number;
  /** 上限 [m]（この値未満、最上位は Infinity） */
  max: number;
  label: string;
  /** '#rrggbb' */
  color: string;
  /** 区分の目安（画面表示用。出典つき） */
  note?: string;
}

/**
 * 浸水と見なす最小の深さ [m]。
 * - 神奈川県の津波浸水想定の浸水深凡例の最下位区分が「0.01m 以上 0.3m 未満」
 *   （「津波浸水想定について（解説）」p.4 図2 https://www.pref.kanagawa.jp/uploaded/attachment/774580.pdf ）。
 * - 津波浸水計算の「打ち切り水深」の目安も「1cm程度」
 *   （国土交通省「津波浸水想定の設定の手引き Ver.2.11」（2023年4月）p.16「③ 打ち切り水深」
 *    https://www.mlit.go.jp/river/shishin_guideline/kaigan/tsunamishinsui_manual.pdf ）。
 * SimOutput.arrival の浸水判定（深さ ≥ 0.01 m）とも一致させている。
 */
export const MIN_FLOOD_DEPTH = 0.01;

/**
 * 浸水深の凡例。国土交通省「水害ハザードマップ作成の手引き」（令和8年5月）の
 * 「浸水深等 RGB（詳細版）」（p.37 図3-5）と「配色の参考値」（p.38 表3-2）の値そのまま:
 *   20m〜 220,122,220 / 10〜20m 242,133,201 / 5〜10m 255,145,145 / 3〜5m 255,183,183 /
 *   1〜3m 255,216,192 / 0.5〜1m 248,225,166 / 0.3〜0.5m 247,245,169 / 〜0.3m 255,255,179
 *   https://www.mlit.go.jp/river/basic_info/jigyo_keikaku/saigai/tisiki/hazardmap/pdf/suigai_hazardmap_tebiki.pdf
 * 「津波浸水想定の設定の手引き Ver.2.11」（2023年4月）p.47 図-19・表-5 も同じ値
 * （https://www.mlit.go.jp/river/shishin_guideline/kaigan/tsunamishinsui_manual.pdf ）。
 * 重ねるハザードマップの津波浸水想定の凡例は「水害ハザードマップ作成の手引き」に基づく
 * （ハザードマップポータルサイト「浸水深の凡例の違いについて」 https://disaportal.gsi.go.jp/hazardmapportal/legend.pdf ）。
 * 実際のタイル（04_tsunami_newlegend_data）も同じ8色で塗られている:
 * 凡例画像 shinsui_legend3.png の画素値と一致し、計算範囲を覆う z15 の実タイル（17 枚）の画素は
 * 透明と 20m以上 を除く7色のみ、神奈川県沿岸（城ヶ島・真鶴・大磯など）の z14 では 20m以上 を含む8色を確認した（2026-09-24）。
 * 境界値ちょうどは上の階級に含める（例: 0.3 m → 0.3〜0.5m）。神奈川県の浸水深凡例が「○m 以上 △m 未満」の
 * 形であること（「津波浸水想定について（解説）」p.4 図2）に合わせた。
 */
export const DEPTH_CLASSES: DepthClass[] = [
  {
    min: MIN_FLOOD_DEPTH,
    max: 0.3,
    label: '0.3m未満',
    color: '#ffffb3',
  },
  {
    min: 0.3,
    max: 0.5,
    label: '0.3〜0.5m',
    color: '#f7f5a9',
  },
  {
    min: 0.5,
    max: 1,
    label: '0.5〜1m',
    color: '#f8e1a6',
    // 水害ハザードマップ作成の手引き（令和8年5月）p.36「1 階床高に相当する 0.5m」
    note: '0.5m: 一般的な家屋の1階床高に相当',
  },
  {
    min: 1,
    max: 3,
    label: '1〜3m',
    color: '#ffd8c0',
  },
  {
    min: 3,
    max: 5,
    label: '3〜5m',
    color: '#ffb7b7',
    // 水害ハザードマップ作成の手引き（令和8年5月）p.36「2 階床下に相当する 3m」
    note: '3m: 一般的な家屋の2階床下に相当',
  },
  {
    min: 5,
    max: 10,
    label: '5〜10m',
    color: '#ff9191',
    // 水害ハザードマップ作成の手引き（令和8年5月）p.36「一般的な家屋の 2 階が水没する 5m」
    note: '5m: 一般的な家屋の2階が水没する',
  },
  {
    min: 10,
    max: 20,
    label: '10〜20m',
    color: '#f285c9',
  },
  {
    min: 20,
    max: Infinity,
    label: '20m以上',
    color: '#dc7adc',
  },
];

/** シミュレーション結果を塗るときの不透明度（0〜255）。公式タイル自体は不透明（255）で塗られている */
export const DEPTH_ALPHA = 220;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 浸水深 [m] → 凡例の階級（0.01m 未満・NaN は null） */
export function depthClassOf(depth: number): DepthClass | null {
  if (!(depth >= MIN_FLOOD_DEPTH)) return null;
  for (const cls of DEPTH_CLASSES) {
    if (depth < cls.max) return cls;
  }
  return DEPTH_CLASSES[DEPTH_CLASSES.length - 1];
}

/** 浸水深 [m] → RGBA（0〜255）。0.01m 未満（NaN を含む）は透明 */
export function depthToRgba(depth: number, out: Uint8ClampedArray | number[] = [0, 0, 0, 0], offset = 0): Uint8ClampedArray | number[] {
  const c = depthClassOf(depth);
  if (!c) {
    out[offset] = out[offset + 1] = out[offset + 2] = out[offset + 3] = 0;
    return out;
  }
  const [r, g, b] = hexToRgb(c.color);
  out[offset] = r;
  out[offset + 1] = g;
  out[offset + 2] = b;
  out[offset + 3] = DEPTH_ALPHA;
  return out;
}

/**
 * 公式の津波浸水想定タイルの画素色 → 浸水深の階級（凡例の色と完全に一致する場合のみ。それ以外は null）。
 * タイルの画素を読んで「公式の想定ではこの地点は何m」と示すときに使う。
 */
export function depthClassFromRgb(r: number, g: number, b: number): DepthClass | null {
  for (const cls of DEPTH_CLASSES) {
    const [cr, cg, cb] = hexToRgb(cls.color);
    if (cr === r && cg === g && cb === b) return cls;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 津波到達時間の配色（シミュレーション結果用。公式の凡例ではない）
// ---------------------------------------------------------------------------

/**
 * 津波到達時間（各地点が最初に浸水した時刻）の配色。地震発生からの分。
 * - 階級の目安（相模トラフ沿いの海溝型地震（西側モデル）の場合）:
 *   藤沢市への第1波の到達 6分、藤沢海岸（茅ヶ崎市境〜片瀬漁港海岸西側。鵠沼を含む）の最大津波到達 8分、
 *   湘南港海岸（江の島）の最大津波到達 12分（藤沢市「藤沢市における想定津波の概要」
 *   https://www.city.fujisawa.kanagawa.jp/documents/30834/souteitsunamigaiyou.pdf ）。
 *   県の表では藤沢市の代表値が「最大津波高さ 11.5m・最大波到達時間 12分」
 *   （「津波浸水想定について（解説）」p.14 表1 https://www.pref.kanagawa.jp/uploaded/attachment/774580.pdf ）。
 *   10〜30分の違いが読み取れるよう5分刻みにした（区切りはこのアプリの設定で、公式の区分ではない）。
 * - 色: viridis 配色（matplotlib の _viridis_data 256色を 0, 1/6, …, 1 の位置で抜き出した7色。
 *   https://github.com/matplotlib/matplotlib/blob/main/lib/matplotlib/_cm_listed.py ）。
 *   明度が単調に変わるので、色の区別がつきにくい人でも明暗で順序が読める。早いほど暗い。
 *   最も遅い階級の黄（#fde725）は浸水深の「0.3m未満」の淡黄（#ffffb3）と似ているので、両者を同時に重ねない前提。
 */
export const ARRIVAL_CLASSES: { maxMin: number; label: string; color: string }[] = [
  { maxMin: 10, label: '10分以内', color: '#440154' },
  { maxMin: 15, label: '10〜15分', color: '#443983' },
  { maxMin: 20, label: '15〜20分', color: '#31688e' },
  { maxMin: 25, label: '20〜25分', color: '#21918c' },
  { maxMin: 30, label: '25〜30分', color: '#35b779' },
  { maxMin: 45, label: '30〜45分', color: '#90d743' },
  { maxMin: Infinity, label: '45分以降', color: '#fde725' },
];

// ---------------------------------------------------------------------------
// OpenFreeMap（3D 建物）
// ---------------------------------------------------------------------------

/**
 * OpenFreeMap（OpenStreetMap 由来のベクタータイル。OpenMapTiles スキーマ）。3D 建物に使用。
 * 確認（2026-09-24）:
 * - TileJSON https://tiles.openfreemap.org/planet は tilejson 3.0.0、minzoom 0・maxzoom 14、
 *   tiles は日付入りの URL（例 https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf）。
 *   日付部分は更新で変わるので、URL は毎回 TileJSON から取得すること（固定しない）。
 * - vector_layers の building: fields = colour, hide_3d, render_height, render_min_height、minzoom 13・maxzoom 14。
 * - 鵠沼付近 z14（x=14539, y=6472 など）のタイルを @mapbox/vector-tile で復号し、building レイヤーの
 *   render_height / render_min_height を確認。高さ・下端高さが同じ建物は1つの MultiPolygon にまとめられている
 *   （x=14539,y=6471 では 8 フィーチャーに 13,683 ポリゴン）。
 * - 高さの算出（planetiler-openmaptiles Building.java L160）: render_height = ceil(height ?? building:levels × 3.66 ?? 5)。
 *   OSM に高さ・階数の情報がない建物は一律 5m になる（鵠沼付近の z14 タイル5枚（x=14538〜14540, y=6471〜6472 のうち建物のある5枚）
 *   では建物ポリゴン 41,979 個の 99.3%（タイルごとに 98.6〜99.6%）が 5m）。実際の高さではない。
 * - 出典表記は TileJSON の attribution と同じ。OpenFreeMap のサイトでは「MapLibre 以外のクライアントでは
 *   次の出典表記を必ず表示すること」とされている（https://openfreemap.org/ Attribution の項）。
 */
export const OPENFREEMAP = {
  tilejson: 'https://tiles.openfreemap.org/planet',
  attribution:
    '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  /** 建物のレイヤー名 */
  buildingLayer: 'building',
  /** 建物の高さ [m]（地面から上端まで） */
  heightField: 'render_height',
  /** 建物の下端の高さ [m]（ピロティなど。通常 0） */
  minHeightField: 'render_min_height',
  /**
   * true なら 3D で描かない。OSM の建物リレーションで role=outline の外形に付く
   * （中の building:part が別に高さ付きで描かれるので、外形を立ち上げると二重になる。Building.java）
   */
  hide3dField: 'hide_3d',
  /** 建物の属性（高さ）が入るズーム。z13 は外形のみ、z14 で高さが付く */
  buildingZoom: 14,
  /** 高さ情報がない建物に入る値 [m] */
  defaultHeightM: 5,
  /** 階数から高さを出すときの1階あたりの高さ [m] */
  levelHeightM: 3.66,
  /** 画面表示用の注意 */
  // planetiler-openmaptiles Building.java: ceil(height ?? building:levels × 3.66 ?? 5)
  heightNote:
    '建物の高さは OpenStreetMap の情報によります（高さの記録があればその値、なければ階数×3.66m）。どちらも無い建物は一律5mで、鵠沼付近では建物の約99%がこの5mです（2026年9月時点）。実際の高さではありません。',
};
