/**
 * 地震・津波シナリオと震度別プリセット。
 *
 * 【方針】
 * - 公的な想定（神奈川県・内閣府）に基づく値は、一次資料の該当ページをコメントに明記する。
 * - 公的資料に無い値（周期・波の数・揺れの継続時間、一部の震度）は「設定値（仮定）」として
 *   画面に出る description にもそう書く。
 * - 本サイトの計算は公式の予測ではない（簡略化した説明用モデル）。
 *
 * 【主な出典】（2026-09 に取得・確認。ページ番号は資料に印刷されたページ。PDF のページと異なる場合は「PDF p.」と明記）
 * [K-解説] 神奈川県「津波浸水想定について（解説）」（平成27年3月の津波浸水想定の解説。平成27年6月22日の一部修正を反映）
 *          https://www.pref.kanagawa.jp/uploaded/attachment/774580.pdf
 *          掲載ページ: https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/index.html
 *          - p.4  最大津波高さ＝海岸線から沖合約30m地点の津波水位の最大値（標高 T.P.）。
 *                 気象庁の「津波の高さ」（平常潮位からの高さ）とは基準が異なる。
 *          - p.5  対象5地震と規模（西側・中央 Mw8.7、元禄 Mw8.5、元禄+国府津-松田 Mw8.5クラス、慶長 Mw8.5）
 *          - p.7  元禄関東地震タイプ: 発生間隔2千〜3千年、前回1703年、今後30年以内の発生確率「ほぼ０％」
 *          - p.9  慶長型地震: 再現ではなく県独自モデル。相田（1981）の1605年慶長東海地震の断層モデルが基
 *          - p.10 初期水位＝朔望平均満潮位（相模湾 T.P.+0.85m、東京湾 T.P.+0.9m）
 *          - p.13 粗度係数（住宅地（中密度）0.060 ほか）
 *          - p.14 表1 藤沢市 最大津波高さ 11.5m・最大波到達時間12分（相模トラフ西側。海岸保全区域・港湾区域・
 *                 漁港区域の代表箇所の値）。備考「注）11.6m（江の島）」＝がけ地等を含めた値
 *          - p.16 表2 地震別の藤沢市最大（がけ地等を含む）: 西側11.6m/12分、中央10.8m/21分、
 *                 元禄9.9m/6分、元禄+国府津-松田9.8m/6分、慶長8.6m/71分
 *          - p.22 藤沢市の水位変動図（西側）: 津波高さ30cm到達1分、最大 T.P.+11.5m/12分。
 *                 図を画像化して確認: 地震直後から水位が上がり（引き波の先行なし）、5〜14分に大きな山が集中、
 *                 その後も180分まで1〜5m程度の山が繰り返す（約88分に約4.8m）
 *          - p.23 茅ヶ崎市の水位変動図（中央）: 地震直後にごく小さく下がった後すぐ上昇。最大 9.6m/16分の山は
 *                 約10分続き、その後も約70〜150分に3〜6mの山が15〜20分程度の間隔で続く
 *          - p.17–26 の水位変動図はベクター図形なので、折れ線の座標を軸の目盛りで換算して数値化した
 *            （抽出した最大値・時刻は図中の表示と ±0.3m・±0.5分で一致）。周期・波形の設定に使った測定値は
 *            下の「周期・波形の設定根拠」と docs/MODEL.md「波の周期・波形の設定根拠と感度分析」を参照
 * [K-予測図] 神奈川県「津波浸水予測図」（9地震ごと、平成27年3月・6月一部修正）の 17/24 図
 *          （作図範囲: 鎌倉市・藤沢市）に記載の「藤沢海岸（藤沢地区）」（鵠沼海岸を含む区間）の
 *          最大津波高さ・最大津波到達時間（図の凡例: 「各区間の最大津波高さと、その到達時間」）。
 *          一覧: https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892442.html
 * [F-概要] 藤沢市「藤沢市における想定津波の概要」（藤沢市地域防災計画 平成28年4月改訂版より）
 *          https://www.city.fujisawa.kanagawa.jp/documents/30834/souteitsunamigaiyou.pdf
 *          - 西側モデル: 震度「神奈川県全県域で震度7」、本市への第1波の到達時間6分、
 *            最大津波高さ11.5m（到達時間12分）、40分後くらいまで繰り返し、20分後以降は2m前後。
 *          - 湘南港海岸11.5m/12分、片瀬漁港海岸7.9m/11分、藤沢海岸（茅ヶ崎市境から片瀬漁港海岸西側まで）8.8m/8分
 * [F-HM]   藤沢市「津波ハザードマップ（令和2年度作成）」ページの想定地震の概要表
 *          https://www.city.fujisawa.kanagawa.jp/bousai/bosai/bosai/hazardmap/tsunami/h25hazardmap.html
 * [K-部会8] 神奈川県 第8回津波浸水想定検討部会 資料「最大クラスの津波に関する検討の進め方について」p.1–3
 *          https://www.pref.kanagawa.jp/uploaded/attachment/750502.pdf
 *          （p.1: 平成24年3月30日公表の予測図の12地震のうち【最大クラス】明応型 M8.4、慶長型 M8.5、神奈川県西部 M7クラス ほか。
 *            p.2: 国の相模トラフ最大クラスの地震は「３地震(地震動は１ケース)」。p.3: 西相模灘 Mw7.3、大正関東 Mw8.2、元禄関東 Mw8.5）
 * [内閣府首都直下2013] 首都直下地震モデル検討会「首都のM7クラスの地震及び相模トラフ沿いのM8クラスの地震等の
 *          震源断層モデルと震度分布・津波高等に関する報告書」（平成25年12月）PDF p.30:
 *          大すべり域を浅部領域の西部・中央部・東部に置いたものを順にケース１（西側モデル）・ケース２（中央モデル）・ケース３
 *          https://www.bousai.go.jp/kaigirep/chuobou/senmon/shutochokkajishinmodel/pdf/dansoumodel_01.pdf
 * [K-被害R7] 神奈川県「地震被害想定調査報告書」（令和7年3月）第2章
 *          https://www.pref.kanagawa.jp/documents/16375/2syou01.pdf
 *          - p.21–22 各想定地震の規模（大正型関東 Mw8.2、元禄型関東 Mw8.5、相模トラフ最大クラス Mw8.7、
 *            南海トラフ巨大 Mw9.0、慶長型 Mw8.5（正断層型）、明応型 Mw8.4（逆断層型）、元禄型+国府津-松田 Mw8.3）
 *          - p.35 慶長型: 1605年慶長地震の再現ではなく想定地震。相田（1981）の相模トラフ沿いと南海トラフ沖の2断層を
 *            繋げた断層が基。p.36 明応型: 明応地震の再現モデルではなく想定地震。銭洲海嶺を震源とするプレート内地震
 *          - p.40–41 表2.2 地震別市町村別最小・最大震度（藤沢市）:
 *            都心南部直下 5強〜7、三浦半島断層群 5強〜6強、神奈川県西部 5弱〜6弱、東海 5弱〜6弱、
 *            南海トラフ巨大 5弱〜6弱、大正型関東 6強〜7、元禄型関東（参考）6強〜7、
 *            相模トラフ沿いの最大クラス（参考）6強〜7
 *            （慶長型・明応型・元禄+国府津-松田は「津波による被害のみ想定」で震度の推計なし: p.20）
 *          - p.68 津波は「津波浸水予測図（平成27年3月）」の結果を用いた
 *          - p.69 表2.6 都心南部直下地震の浸水面積（30cm以上）… 藤沢市の記載なし
 * [内閣府2012] 南海トラフの巨大地震モデル検討会 第二次報告（平成24年8月29日）市町村別一覧表
 *          https://www.bousai.go.jp/jishin/nankai/pdf/shichouson_ichiran.pdf
 *          - PDF p.3 藤沢市 最大津波高（満潮位・地殻変動考慮）: ケース①6 ②4 ③3 ④3 ⑤3 ⑥6 ⑦3 ⑧7 ⑨3 ⑩3 ⑪4、最大 7m（ケース⑧）
 *          - PDF p.10 藤沢市 平均津波高（市内全域の海岸の平均）: 最大 5m（ケース①⑥⑧）
 *          - PDF p.118/121/124（文字が埋め込まれていないため画像化して確認）藤沢市 津波到達時間（各ケースの最短）:
 *            +1m 32分（ケース①⑥）・+3m 34分（ケース①⑥⑧）・+5m 60分（ケース⑧のみ）
 *          - PDF p.139 藤沢市 最大震度 6弱（経験的手法。基本・陸側・東側・西側ケースは5強）
 *          同 第二次報告 津波断層モデル編 https://www.bousai.go.jp/jishin/nankai/model/pdf/20120829_2nd_report01.pdf
 *          - PDF p.13 津波断層モデルは Mw9.1（主部断層は Mw9.0）
 *          - PDF p.16 潮位条件は満潮位（平成24年気象庁潮位表の各地の年間最高潮位を参考に設定）。津波高は T.P. からの高さ
 *            → 神奈川県の想定（朔望平均満潮位 T.P.+0.85m）とは潮位条件が異なる
 *          - PDF p.22 海岸の津波高＝海岸線から概ね20〜30m沖合のメッシュの値。市町村の全海岸線（崖なども含む）で算出
 *          - PDF p.23 第1波が押しで始まるか引きで始まるかは断層のメカニズムや地域によって異なる。
 *            第1波だけでなく、その後も5、6時間から半日程度は繰り返し大きな津波が襲来する
 *          - PDF p.30 津波高は「メートル以下第2位を四捨五入し第1位を切り上げたメートル単位の数値」
 *            （例: 6.1〜7.0m → 「7m」）
 * [内閣府2025] 南海トラフ巨大地震モデル・被害想定手法検討会「地震モデル報告書」（令和7年3月31日公表）市町村別一覧表
 *          https://www.bousai.go.jp/jishin/nankai/kento_wg/pdf/ichiran.pdf
 *          - PDF p.3 藤沢市 最大7m（ケース⑧。前回2012も7m）、PDF p.10 平均 最大5m、
 *            PDF p.151/154/157 到達時間 +1m 32分・+3m 34分（ケース①⑥⑧）・+5m 60分（ケース⑥⑧）、
 *            PDF p.174 最大震度 6弱（経験的手法。基本ケース5強）
 * [萬年2013] 萬年一剛・五島朋子・浪川幹夫（2013）「神奈川県逗子市，鎌倉市，藤沢市における1923年大正関東地震による津波」
 *          歴史地震 第28号 pp.71–84  https://www.histeq.jp/kaishi_28/HE28_071_084_Mannnen.pdf
 *          - 表1 藤沢・引地川（鵠沼）: 海岸付近の津波高 6m以下、後背地の遡上高 4m（神奈川県(1985)は2.0–6.0m）
 *          - §5.2 鵠沼: 地震が収まり倒壊家屋から出たとき、庭の池に津波が流れ込んでいた（高木 1981 の証言）
 *          - §4.4 鎌倉: 「地震の最中少し引き、それより10-15分経て…2・3回おしよせたり」（田中館 1926）
 * [JMA月報] 気象庁「地震・火山月報（防災編）」令和7年7月
 *          https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/202507/202507monthly.pdf
 *          - p.71（PDF p.74）特集2「2025年7月30日 ロシア、カムチャツカ半島東方沖の地震」: 08時24分、Mw8.8（気象庁）、
 *            日本国内の最大震度2。08時37分 津波注意報、09時40分 北海道から近畿地方の太平洋沿岸・伊豆諸島・小笠原諸島を
 *            津波警報に切替、18時30分 一部を津波注意報に切替
 *            （発生当日の報道発表での地震名は「カムチャツカ半島付近の地震」。月報では上記の名称）
 *          - p.78（PDF p.81）表3-1 日本国内の津波観測値（第一波到達時刻・最大波の発現時刻・最大の高さ）:
 *            神奈川県 横浜 12:03・13:39・25cm、横須賀 11:40・12:10・15cm、三浦市三崎漁港 11:29・19:55・0.2m、
 *            三浦市油壺 11:24・22:08・22cm、小田原 11:24・31日01:48・14cm
 *          - p.79（PDF p.82）図3-1 津波の測り方: 最大の高さは平常潮位から測る
 *          - p.172（PDF p.175）同地震の震度観測: 震度1以上の観測点に神奈川県は含まれない
 * [JMA報道] 気象庁 報道発表「令和７年７月30日08時25分頃のカムチャツカ半島付近の地震について（第２報）」
 *          https://www.jma.go.jp/jma/press/2507/30b/202507301300.html
 *          （09時40分発表の津波警報の対象に「相模湾・三浦半島」。予想される津波の高さの数値はこの資料に記載なし）
 * [手引き] 国土交通省「津波浸水想定の設定の手引き Ver.2.11」（2023年4月）
 *          https://www.mlit.go.jp/river/shishin_guideline/kaigan/tsunamishinsui_manual.pdf
 *          - p.29 設定潮位は朔望平均満潮位を基本 / p.32 表-3 粗度係数（住宅地（中密度）0.06、小谷ほか 1998）
 *          - p.52（PDF p.55）津波痕跡高との比較を実施している断層モデルの一覧に「1498年 明応」「1605年 慶長」
 * [萬年2013 補足] §4.4 で、神奈川県（1985）の想定をまとめた梶浦（1986）が「シミュレーションで得られる鎌倉付近の
 *          波の周期が20分程度と長く」、1923年の鎌倉で最大波が約1時間遅れた記録と符合すると述べたことを紹介
 *          （萬年ほかは鎌倉の来襲時刻の記録自体には疑問を示している）。§5.2(1) 鵠沼の東屋旅館では床上2尺まで浸水し、
 *          「その後静かに引いて、午後1時半頃には…くるぶしの上1寸5分を浸す程度」（地震の約1時間半後も水が残った）
 * [蟹江2019] 蟹江康光・蟹江由紀・倉持卓司（2019）「相模湾東部，鎌倉-逗子-葉山に到達した1923年関東地震の津波と地盤隆起」
 *          日本地質学会学術大会講演要旨 https://www.jstage.jst.go.jp/article/geosocabst/2019/0/2019_50/_pdf/-char/ja
 *          - 1923年の来襲時刻（文献・証言の整理）: 腰越 地震後20–30分、稲村ヶ崎 20分、由比ガ浜 20–30分、
 *            逗子小坪 15分、葉山堀内 3–5分。鎌倉地域の来襲は「10-15分〜20-30分」
 * [K-部会10] 神奈川県 第10回津波浸水想定検討部会 参考資料2「最大クラスの津波による浸水面積」（平成27年2月）
 *          https://www.pref.kanagawa.jp/uploaded/attachment/774952.pdf
 *          - 藤沢市の最大浸水面積 4.7km²（「単独で最大浸水面積となる地震」: 相模トラフ西側）。注記に
 *            「浸水範囲を重ね合わせると、一部の範囲で他の地震が広くなる」
 *          - 同じ値は [K-解説] p.27 表3（藤沢市 4.7km²・ａ相模トラフ西側。注記「河川内の浸水面積は含まれていません」）
 * [内閣府2012 補足] 同 津波断層モデル編 PDF p.31「陸域に津波が浸水すると、陸域の地形等の形状や津波の周期等によっても異なるが、
 *          一般的には津波は減衰し、浸水深は内陸に入るにつれて小さくなる」
 */
import type { QuakeScenario, ShindoLevel, SimParams } from '../core/types';

// ---------------------------------------------------------------------------
// 共通の定数
// ---------------------------------------------------------------------------

/**
 * 神奈川県の公的想定の初期潮位（朔望平均満潮位・相模湾）[m, T.P.]。
 * （内閣府の南海トラフ想定の潮位条件はこれとは別: [内閣府2012] 津波断層モデル編 PDF p.16）
 * 出典: [K-解説] p.10「神奈川県沿岸の朔望平均満潮位（相模湾 T.P.+0.85ｍ、東京湾 T.P.+0.9ｍ）」
 */
export const OFFICIAL_TIDE_TP = 0.85;

/**
 * 陸域の粗度係数の既定値（住宅地（中密度））。
 * 出典: [手引き] p.32 表-3「住宅地（中密度）0.06」、[K-解説] p.13「住宅地（中密度）：0.060」
 */
export const DEFAULT_LAND_MANNING = 0.06;

/** 計算時間の選択肢 [分]（UI の選択肢と同じ） */
export const DURATION_OPTIONS_MIN = [30, 60, 90, 120] as const;

/** 出典リンク */
export interface SourceRef {
  label: string;
  url: string;
}

/**
 * シナリオ（型 QuakeScenario に、任意の補足項目を加えたもの）。
 * 追加項目はすべて省略可能で、既存の QuakeScenario として扱える。
 */
export interface ScenarioInfo extends QuakeScenario {
  /** 公的資料による藤沢市の震度の幅（例: 「6強〜7」）。推計が無い場合は undefined */
  shindoRange?: string;
  /** 到達時間 arrivalMin の根拠（公式のどの値をどう使ったか） */
  arrivalBasis?: string;
  /** 気象庁の定義による「津波の高さ」（平常潮位からの高さ）[m]。説明用の例で使う */
  jmaHeightM?: number;
  /** 設定値（仮定）の一覧（画面表示用の短い文） */
  assumptions?: string[];
  /** 補足の出典 */
  refs?: SourceRef[];
}

/** 出典 URL（コメントの [略号] に対応） */
export const REF_URLS = {
  kanagawaKaisetsu: 'https://www.pref.kanagawa.jp/uploaded/attachment/774580.pdf',
  kanagawaYosokuList: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892442.html',
  kanagawaSoutei: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/index.html',
  fujisawaGaiyou: 'https://www.city.fujisawa.kanagawa.jp/documents/30834/souteitsunamigaiyou.pdf',
  fujisawaHazardMap: 'https://www.city.fujisawa.kanagawa.jp/bousai/bosai/bosai/hazardmap/tsunami/h25hazardmap.html',
  kanagawaBukai8: 'https://www.pref.kanagawa.jp/uploaded/attachment/750502.pdf',
  kanagawaHigaiR7ch2: 'https://www.pref.kanagawa.jp/documents/16375/2syou01.pdf',
  cabinetNankai2012: 'https://www.bousai.go.jp/jishin/nankai/pdf/shichouson_ichiran.pdf',
  cabinetNankai2012Model: 'https://www.bousai.go.jp/jishin/nankai/model/pdf/20120829_2nd_report01.pdf',
  cabinetNankai2025: 'https://www.bousai.go.jp/jishin/nankai/kento_wg/pdf/ichiran.pdf',
  cabinetShuto2013: 'https://www.bousai.go.jp/kaigirep/chuobou/senmon/shutochokkajishinmodel/pdf/dansoumodel_01.pdf',
  mannen2013: 'https://www.histeq.jp/kaishi_28/HE28_071_084_Mannnen.pdf',
  jmaMonthly202507: 'https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/202507/202507monthly.pdf',
  jmaPress20250730: 'https://www.jma.go.jp/jma/press/2507/30b/202507301300.html',
  jmaTsunamiInfo: 'https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html',
  mlitTebiki: 'https://www.mlit.go.jp/river/shishin_guideline/kaigan/tsunamishinsui_manual.pdf',
} as const;

const REF_KANAGAWA_KAISETSU: SourceRef = { label: '神奈川県「津波浸水想定について（解説）」（平成27年）', url: REF_URLS.kanagawaKaisetsu };
const REF_FUJISAWA_GAIYOU: SourceRef = { label: '藤沢市「藤沢市における想定津波の概要」', url: REF_URLS.fujisawaGaiyou };
const REF_FUJISAWA_HM: SourceRef = { label: '藤沢市「津波ハザードマップ」', url: REF_URLS.fujisawaHazardMap };
const REF_KANAGAWA_HIGAI_R7: SourceRef = { label: '神奈川県「地震被害想定調査報告書」第2章（令和7年3月）', url: REF_URLS.kanagawaHigaiR7ch2 };
const REF_KANAGAWA_BUKAI8: SourceRef = { label: '神奈川県 第8回津波浸水想定検討部会 資料', url: REF_URLS.kanagawaBukai8 };

// ---------------------------------------------------------------------------
// 神奈川県 津波浸水予測図（平成27年）の藤沢市沿岸の値（参照表）
// ---------------------------------------------------------------------------

/** 海岸区間ごとの値 */
export interface CoastValue {
  /** 最大津波高さ [m, T.P.] */
  heightTP: number;
  /** 最大津波到達時間 [分]（最大の波が来る時刻） */
  maxArrivalMin: number;
}

export interface KanagawaModelFujisawa {
  model: string;
  /** 規模の表記（資料の表記のまま） */
  magnitude: string;
  /** 藤沢海岸（藤沢地区）: 茅ヶ崎市境〜片瀬漁港海岸西側。鵠沼海岸・辻堂海岸を含む */
  fujisawaCoast: CoastValue;
  /** 片瀬漁港海岸（片瀬地区） */
  katase: CoastValue;
  /** 湘南港海岸（藤沢地区）＝江の島 */
  shonanPort: CoastValue;
  /** 藤沢市の最大（がけ地等を含む）。[K-解説] p.16 表2 に載る5地震のみ */
  cityMax?: CoastValue;
  /** 予測図のページ */
  pageUrl: string;
  /** 17/24 図（作図範囲: 鎌倉市・藤沢市）の PDF */
  sheetUrl: string;
}

/**
 * 9地震の藤沢市沿岸の最大津波高さ・最大津波到達時間。
 * 出典: 各地震の「津波浸水予測図」17/24 図（sheetUrl）の区間表示、および [K-解説] p.16 表2（cityMax）。
 * 規模: [K-解説] p.5（5地震）、[K-部会8] p.1–3（西相模灘・大正関東・明応・神奈川県西部）。
 */
export const KANAGAWA_2015_FUJISAWA: KanagawaModelFujisawa[] = [
  {
    model: '相模トラフ沿いの海溝型地震（西側モデル）',
    magnitude: 'Mw8.7',
    fujisawaCoast: { heightTP: 8.8, maxArrivalMin: 8 },
    katase: { heightTP: 7.9, maxArrivalMin: 11 },
    shonanPort: { heightTP: 11.5, maxArrivalMin: 12 },
    cityMax: { heightTP: 11.6, maxArrivalMin: 12 },
    pageUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892754.html',
    sheetUrl: 'https://www.pref.kanagawa.jp/uploaded/attachment/760437.pdf',
  },
  {
    model: '相模トラフ沿いの海溝型地震（中央モデル）',
    magnitude: 'Mw8.7',
    fujisawaCoast: { heightTP: 9.5, maxArrivalMin: 23 },
    katase: { heightTP: 8.7, maxArrivalMin: 20 },
    shonanPort: { heightTP: 9.1, maxArrivalMin: 22 },
    cityMax: { heightTP: 10.8, maxArrivalMin: 21 },
    pageUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892753.html',
    sheetUrl: 'https://www.pref.kanagawa.jp/uploaded/attachment/760470.pdf',
  },
  {
    model: '元禄関東地震タイプ',
    magnitude: 'Mw8.5',
    fujisawaCoast: { heightTP: 8.0, maxArrivalMin: 9 },
    katase: { heightTP: 8.1, maxArrivalMin: 9 },
    shonanPort: { heightTP: 8.0, maxArrivalMin: 9 },
    cityMax: { heightTP: 9.9, maxArrivalMin: 6 },
    pageUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892750.html',
    sheetUrl: 'https://www.pref.kanagawa.jp/uploaded/attachment/760382.pdf',
  },
  {
    model: '元禄関東地震タイプと国府津-松田断層帯地震の連動地震',
    // [K-解説] p.5 は「Mw8.5 クラス」、[K-被害R7] p.22 は Mw8.3 と記載
    magnitude: 'Mw8.5クラス',
    fujisawaCoast: { heightTP: 7.9, maxArrivalMin: 9 },
    katase: { heightTP: 8.0, maxArrivalMin: 9 },
    shonanPort: { heightTP: 7.9, maxArrivalMin: 9 },
    cityMax: { heightTP: 9.8, maxArrivalMin: 6 },
    pageUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892749.html',
    sheetUrl: 'https://www.pref.kanagawa.jp/uploaded/attachment/760408.pdf',
  },
  {
    model: '慶長型地震',
    magnitude: 'Mw8.5',
    fujisawaCoast: { heightTP: 8.6, maxArrivalMin: 50 },
    katase: { heightTP: 8.6, maxArrivalMin: 71 },
    shonanPort: { heightTP: 8.1, maxArrivalMin: 51 },
    cityMax: { heightTP: 8.6, maxArrivalMin: 71 },
    pageUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892748.html',
    sheetUrl: 'https://www.pref.kanagawa.jp/uploaded/attachment/760101.pdf',
  },
  {
    model: '大正関東地震タイプ',
    magnitude: 'Mw8.2',
    fujisawaCoast: { heightTP: 6.5, maxArrivalMin: 9 },
    katase: { heightTP: 6.0, maxArrivalMin: 25 },
    shonanPort: { heightTP: 6.4, maxArrivalMin: 7 },
    pageUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892751.html',
    sheetUrl: 'https://www.pref.kanagawa.jp/uploaded/attachment/760278.pdf',
  },
  {
    model: '明応型地震',
    magnitude: 'M8.4',
    fujisawaCoast: { heightTP: 7.5, maxArrivalMin: 50 },
    katase: { heightTP: 7.4, maxArrivalMin: 50 },
    shonanPort: { heightTP: 7.5, maxArrivalMin: 52 },
    pageUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892747.html',
    sheetUrl: 'https://www.pref.kanagawa.jp/uploaded/attachment/760217.pdf',
  },
  {
    model: '神奈川県西部地震',
    magnitude: 'M7クラス',
    fujisawaCoast: { heightTP: 4.2, maxArrivalMin: 29 },
    katase: { heightTP: 5.0, maxArrivalMin: 31 },
    shonanPort: { heightTP: 3.6, maxArrivalMin: 31 },
    pageUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892746.html',
    sheetUrl: 'https://www.pref.kanagawa.jp/uploaded/attachment/760321.pdf',
  },
  {
    model: '西相模灘地震',
    magnitude: 'Mw7.3',
    fujisawaCoast: { heightTP: 1.8, maxArrivalMin: 29 },
    katase: { heightTP: 1.8, maxArrivalMin: 29 },
    shonanPort: { heightTP: 1.4, maxArrivalMin: 80 },
    pageUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892752.html',
    sheetUrl: 'https://www.pref.kanagawa.jp/uploaded/attachment/760349.pdf',
  },
];

// ---------------------------------------------------------------------------
// 画面に出す共通の注意書き
// ---------------------------------------------------------------------------

/** シナリオ全体に関わる注意（UI で一覧の上などに表示できる） */
export const SCENARIO_NOTES: string[] = [
  'このサイトの計算は、公的な想定値を目標に波の大きさを調整した簡略モデルです。公式の予測・浸水想定ではありません。実際の避難には藤沢市の津波ハザードマップを使ってください。',
  // [K-解説] p.4、[内閣府2012] 津波断層モデル編 PDF p.16・p.22、[JMA月報] p.79 図3-1
  '「最大津波高」は海岸付近の最大水位（東京湾平均海面 T.P. からの高さ・潮位を含む。神奈川県の想定は海岸線から約30m沖、内閣府の想定は約20〜30m沖の値）です。気象庁が発表する「津波の高さ」（その時の平常潮位からの高さ）とは基準が違います。',
  // [K-解説] p.10、[内閣府2012] 津波断層モデル編 PDF p.16
  '初期潮位は、神奈川県の想定では朔望平均満潮位 T.P.+0.85m（大潮の満潮ごろ）です。内閣府の南海トラフの想定は、各地の年間最高潮位を参考にした満潮位を使っています。このサイトでは比べやすいよう、どのシナリオも T.P.+0.85m から計算します。',
  // [K-解説] p.14 表1 の注記、[内閣府2012] 津波断層モデル編 PDF p.23、気象庁「津波警報・注意報と避難のポイント」
  '到達時間は原則として公的資料の「最大津波到達時間」（最大の波が来る時刻）です（南海トラフは内閣府の津波高+3m到達時刻、遠地津波の例は短縮した値。各シナリオの説明を参照）。実際にはそれより前に小さな波が来ることがあります。このモデルでは最大の波をこの時刻に合わせ、公的な想定のシナリオでは後の波を最大の波の0.4〜0.5倍で繰り返しています（慶長型・明応型は最大の波の約20分前に小さな第1波も入れています）。実際には後の波の方が高いこともあり、津波は数時間以上くり返し来ます。',
  // 周期・後続波の大きさの根拠: 下の「周期・波形の設定根拠」、docs/MODEL.md「波の周期・波形の設定根拠と感度分析」
  '周期・波の数・後の波の大きさ・揺れの長さ、および一部のシナリオの第1波の向き（押し波か引き波か）は、公的資料に値が無いための設定値（仮定）です。公的な想定のシナリオの周期と後の波の大きさは、神奈川県の計算波形（水位変動図）に近くなるよう選んでいます。',
];

// ---------------------------------------------------------------------------
// シナリオ
// ---------------------------------------------------------------------------

/** 小数第2位で丸め（T.P. 値の計算で浮動小数の誤差を避ける） */
const round2 = (v: number) => Math.round(v * 100) / 100;

/** 説明用の例: 気象庁の「津波の高さ」h [m] を初期潮位に上乗せした T.P. 値 */
const exampleCoastTP = (h: number) => round2(OFFICIAL_TIDE_TP + h);

/*
 * 周期・波形の設定根拠（詳細と感度分析は docs/MODEL.md「波の周期・波形の設定根拠と感度分析」）
 * 本サイトの入射波は沖合約2kmの境界から入れる正弦波列（src/sim/wave.ts）。公的資料に「周期」の値は無いので、
 * 次の測定値に近い波形になる値を選んだ設定値（仮定）である。
 * (1) [K-解説] p.17–26 の水位変動図（海岸保全区域等で津波高さが最大となる地震の、海岸線付近の計算水位）を数値化:
 *     - 最大の波の高まりの継続（2分移動平均の水位が、潮位＋「2分移動平均の最大上昇量」の20%を超えている時間）:
 *       西側モデル 横須賀市(相模湾側) 8.9分・葉山町 11.1分・逗子市 11.2分・鎌倉市 6.2分・藤沢市 9.8分、
 *       中央モデル 茅ヶ崎市 9.4分（中央値 約9.6分）。慶長型 横須賀市(東京湾側) 10.7分。
 *       別の手順で数値化し直すと ±1分程度違う（8.8・10.2・11.1・5.8・9.4・9.1分、中央値 約9.3分）。
 *       閾値を「生の最大上昇量」の20%にすると短くなる（藤沢市は最大の直前に約1分間水位が約1mまで下がるため約2.5分、
 *       鎌倉市 約4.4分、ほかは 5〜9分）。定義に敏感な目安の値である。
 *     - 後の波の間隔: 茅ヶ崎市（中央）の70〜150分の山は 73・92・106・127・148分（間隔 14〜21分、平均 約19分）。
 *       鎌倉市・逗子市・葉山町（西側）は45〜180分の自己相関の極大が 23〜25分。
 *     - 後の波の大きさ（最大の波の15分以上後の最大の山 ÷ 最大の波。いずれも潮位からの上昇量）:
 *       西側 藤沢市 0.38・鎌倉市 0.43・逗子市 0.42・葉山町 0.38・横須賀市(相模湾側) 0.34、中央 茅ヶ崎市 0.62
 *       （数値化の手順により ±0.04。2分移動平均では 0.5〜0.8）。180分まで山が繰り返す。慶長型（東京湾内の4地点）は 0.44〜0.82。
 *     - なお最大の値は数十秒の鋭い山で、その前後の数分間隔の山（藤沢市 西側: 5.4分 6.0m・7.6分 6.8m・12.0分 11.5m）も
 *       ひとまとまりの高まりの中にある。
 * (2) [K-予測図] 区間ごとの最大津波到達時間: 大正関東 藤沢海岸 9分（6.5m）・片瀬漁港海岸 25分（6.0m）、
 *     慶長型 藤沢海岸 50分（8.6m）・片瀬 71分（8.6m）。隣り合う区間で最大の波の時刻が 16〜21分ずれる。
 *     区間によっては最大の波の約16〜21分後にも同程度の波が来ることを示唆する（波の間隔の目安。
 *     片瀬漁港海岸では後の波が小さいとは限らない）。
 * (3) 1923年: 梶浦（1986）は計算上の鎌倉付近の周期を20分程度とした（[萬年2013] §4.4）。鎌倉では地震後10–15分に
 *     水位が上がり2・3回押し寄せ（田中館 1926）、鎌倉震災誌では2回のうち後の方が大きかった（同 §4.4）。
 *     各地の来襲は地震後15〜30分（[蟹江2019]）。
 * (4) [内閣府2012] 津波断層モデル編 PDF p.23: 大きな津波が5、6時間から半日程度くり返し来る。
 * 本サイトの計算（実地形・西側モデル）で、校正区間の平均水位が同様の定義（移動平均なし）で高まっている時間は周期 10分で 5.0分、
 * 15分で 6.8分、20分で 8.4分、25分で 10.2分（docs/MODEL.md）。周期25分では到達時間8分に間に合わない
 * （静かな海から始めると最大の波の山が約9.4分）ため、相模トラフ沿いの地震は 20分とした。
 * 後の波: 境界で最大の波の 0.4倍 とすると、海岸の平均水位では 0.5〜0.6倍（上の (1) の2分移動平均の値に近い）。
 */
/** 相模トラフ沿いの地震（西側・中央・元禄・大正）の周期 [分]（仮定） */
const PERIOD_SAGAMI_MIN = 20;
/** 相模トラフ沿いの地震の各波の相対振幅（第2波以降は最大の波の0.4倍で繰り返す。仮定） */
const AMPS_SAGAMI = [1, 0.4];
/** 南海トラフの巨大地震の各波の相対振幅（第2波以降は0.5倍。仮定） */
const AMPS_FAR = [1, 0.5];
/**
 * 慶長型・明応型の各波の相対振幅（仮定）: 最大の波の1周期前に0.3倍の第1波、最大の波の後は0.5倍で繰り返す。
 * 根拠（小さな第1波）: [K-解説] p.19 慶長型 横須賀市(東京湾側)の水位変動図で、30cm到達35分、約38分（37.5〜37.8分）に
 * 最大の波の上昇量の約0.27倍の山、最大の波は55.8分（約18分後）。
 * 根拠（周期）: [K-予測図] 慶長 17/24 図で藤沢海岸（50分）と片瀬漁港海岸（71分）の最大の波の時刻が約20分違う
 * （片瀬では50分の約20分後に同程度の波が来ることを示唆。後の波0.5倍はこれより小さめの仮定）。
 * 明応型は計算波形が非公表のため同じ形を当てはめる。
 * 周期20分では第1波の入力開始が約22分、第1波の山が海岸に届くのは約31分（実地形の粗い格子で確認）。
 */
const AMPS_KEICHO = [0.3, 1, 0.5];
/** 公的な想定のシナリオの波の数（周期20分で120分間。計算時間の上限まで波が繰り返す） */
const WAVES_OFFICIAL = 6;
const ASSUME_SAGAMI_PERIOD =
  '周期20分（仮定。公的資料に周期の値は無い。県の計算波形（西側・中央モデル）では最大の波の高まりが6〜11分続き、後の波の間隔は約19〜25分。1923年の鎌倉付近も計算上20分程度とされる）';
const ASSUME_SAGAMI_WAVES =
  '6波、第2波以降は最大の波の0.4倍（仮定。県の計算波形では最大の波の15分以上後の山は0.3〜0.6倍で、3時間後まで繰り返す）';
const ASSUME_KEICHO_PERIOD =
  '周期20分（仮定。公的資料に周期の値は無い。県の計算波形（慶長型・横須賀市東京湾側）では最大の波の高まりが約11分続き、予測図では藤沢海岸（50分）と片瀬漁港海岸（71分）で最大の波の時刻が約20分違う）';
const ASSUME_FAR_PERIOD = '周期20分（仮定。公的資料に周期の値は無い。慶長型の県の計算波形などを参考にした値）';
const ASSUME_FAR_WAVES =
  '6波、第2波以降は最大の波の0.5倍（仮定。県の慶長型の計算波形（東京湾内）では後の山は0.4〜0.8倍。内閣府は大きな津波が5、6時間から半日程度くり返し来るとしている）';
const ASSUME_KEICHO_WAVES =
  '6波。最大の波の約20分前に0.3倍の第1波、最大の波の後は0.5倍で繰り返す（仮定。県の慶長型の計算波形（横須賀市東京湾側）では最大の波の約18分前に約0.27倍の山があり、後の山は0.4〜0.8倍）';
const ASSUME_WAVES = '有意な波3波（仮定。後の波ほど小さくする簡略化）';
const ASSUME_EXAMPLE_FAR_PERIOD = '周期20分（仮定。公的資料に周期の値は無い）';

export const SCENARIOS: ScenarioInfo[] = [
  // ---- 神奈川県 津波浸水想定（平成27年）: 藤沢市の最大クラス ------------------------
  {
    id: 'sagami-west',
    name: '相模トラフ沿いの海溝型地震（西側モデル）',
    shortName: '相模トラフ西側',
    // [K-解説] p.5「Mw8.7」、[F-概要]「マグニチュード8.7」
    magnitude: 8.7,
    // [F-概要]「神奈川県全県域で震度7」。[K-被害R7] p.41 表2.2 では藤沢市 6強〜7
    shindo: '7',
    shindoRange: '6強〜7',
    // [K-予測図] 西側 17/24 図「藤沢海岸（藤沢地区）最大津波高さ：8.8m 最大津波到達時間：8分」
    // （[F-概要] でも藤沢海岸 8.8m・8分）
    coastHeight: 8.8,
    arrivalMin: 8,
    // 仮定。[K-解説] p.17–26 の西側・中央モデルの水位変動図に近い波形になる値（上の「周期・波形の設定根拠」）
    periodMin: PERIOD_SAGAMI_MIN,
    // [K-解説] p.22 藤沢市（湘南港）の水位変動図: 地震直後から水位上昇（30cm到達1分）。鵠沼の地点の波形は非公表
    firstMotion: 'rise',
    waves: WAVES_OFFICIAL, // 仮定
    waveAmplitudes: [...AMPS_SAGAMI], // 仮定（同上）
    shakingSec: 120, // 演出用の仮定
    warning: 'major',
    isOfficial: true,
    source: '神奈川県「津波浸水予測図」相模トラフ沿いの海溝型地震（西側モデル）（平成27年）ほか',
    sourceUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892754.html',
    arrivalBasis: '県の予測図の藤沢海岸「最大津波到達時間」8分（最大の波が来る時刻）',
    assumptions: [ASSUME_SAGAMI_PERIOD, ASSUME_SAGAMI_WAVES, '揺れ120秒（演出用の仮定）'],
    refs: [
      { label: '同 予測図 17/24（作図範囲: 鎌倉市・藤沢市）', url: 'https://www.pref.kanagawa.jp/uploaded/attachment/760437.pdf' },
      REF_FUJISAWA_GAIYOU,
      REF_KANAGAWA_KAISETSU,
      REF_KANAGAWA_HIGAI_R7,
    ],
    description:
      '神奈川県の津波浸水想定（平成27年）で、藤沢市の最大津波高さが最も高くなる地震（Mw8.7、発生間隔は2千〜3千年あるいはそれ以上）。' +
      '鵠沼海岸を含む「藤沢海岸」（茅ヶ崎市境〜片瀬漁港西側）の最大津波高さ T.P.+8.8m・最大津波到達時間8分（県の予測図）を目標にしています。' +
      // [K-解説] p.14 表1（11.5m・12分、注: がけ地等を含めると江の島で11.6m）、[F-概要]（第1波6分、40分後ごろまで、20分以降2m前後）
      '市内の海岸（海岸保全区域・港湾・漁港）での最大は湘南港海岸（江の島）の11.5m・12分（がけ地等を含めると江の島で11.6m）。藤沢市の資料では第1波の到達は6分、40分後ごろまで繰り返し押し寄せ、20分以降は2m前後とされています。' +
      '震度は藤沢市の資料で「神奈川県全県域で震度7」（県の令和7年被害想定では藤沢市6強〜7）。' +
      '8分に最大の波が来るよう設定しています。周期20分・6波（第2波以降は最大の波の0.4倍）は県の計算波形を参考にした設定値（仮定）、揺れ120秒は演出用の仮定です。',
  },
  {
    id: 'sagami-central',
    name: '相模トラフ沿いの海溝型地震（中央モデル）',
    shortName: '相模トラフ中央',
    magnitude: 8.7, // [K-解説] p.5
    // 震度: [K-被害R7] p.41 表2.2「相模トラフ沿いの最大クラスの地震」藤沢市 6強〜7。
    // 表2.2 はこの地震を1列のみで示し（津波は西側・中央の2モデル: 表2.1 備考）、[K-部会8] p.2 も「地震動は１ケース」
    shindo: '7',
    shindoRange: '6強〜7',
    // [K-予測図] 中央 17/24 図「藤沢海岸（藤沢地区）最大津波高さ：9.5m 最大津波到達時間：23分」
    coastHeight: 9.5,
    arrivalMin: 23,
    // 仮定。[K-解説] p.23 茅ヶ崎市（中央）の最大の波の高まりは約9分、後の波の間隔は約19分（上の「周期・波形の設定根拠」）。
    // 茅ヶ崎市の波形では地震直後から約7分間、最大の波の上昇量の約0.25倍の小さな高まりがあるが、周期20分の波では
    // 到達23分の前に入れられない（入力開始が約15分）ため省略している
    periodMin: PERIOD_SAGAMI_MIN,
    // [K-解説] p.23 茅ヶ崎市（中央モデル）の水位変動図: 地震直後にごく小さく下がった後すぐ上昇（目立った引き波の先行なし）
    firstMotion: 'rise',
    waves: WAVES_OFFICIAL, // 仮定
    waveAmplitudes: [...AMPS_SAGAMI], // 仮定（茅ヶ崎市の後の山は最大の波の0.62倍、2分移動平均で0.79倍）
    shakingSec: 120, // 演出用の仮定
    warning: 'major',
    isOfficial: true,
    source: '神奈川県「津波浸水予測図」相模トラフ沿いの海溝型地震（中央モデル）（平成27年）',
    sourceUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892753.html',
    arrivalBasis: '県の予測図の藤沢海岸「最大津波到達時間」23分',
    assumptions: [
      ASSUME_SAGAMI_PERIOD,
      ASSUME_SAGAMI_WAVES,
      '最大の波より前の小さな高まり（県の茅ヶ崎市の計算波形では地震直後から約7分間）は省略（簡略化）',
      '揺れ120秒（演出用の仮定）',
    ],
    refs: [
      { label: '同 予測図 17/24（作図範囲: 鎌倉市・藤沢市）', url: 'https://www.pref.kanagawa.jp/uploaded/attachment/760470.pdf' },
      REF_KANAGAWA_KAISETSU,
      REF_KANAGAWA_HIGAI_R7,
      REF_FUJISAWA_HM,
      { label: '内閣府 首都直下地震モデル検討会 報告書（平成25年12月）', url: REF_URLS.cabinetShuto2013 },
    ],
    // 「大きくずれる場所」＝大すべり域の位置（西部＝西側モデル、中央部＝中央モデル）: [内閣府首都直下2013] PDF p.30
    // 藤沢海岸の値は県の9地震の中でも最大（KANAGAWA_2015_FUJISAWA 参照）
    description:
      '西側モデルと同じ規模（Mw8.7）で、大きくずれる場所（大すべり域）が異なるモデル。県の予測図では、鵠沼海岸を含む藤沢海岸の最大津波高さは5つの最大クラスの地震の中で最も高い T.P.+9.5m、最大津波到達時間は23分です。' +
      '藤沢市全体（がけ地等を含む）の最大は10.8m・21分。震度は県の令和7年被害想定で藤沢市6強〜7。' +
      '周期20分・6波（第2波以降は最大の波の0.4倍）は県の計算波形を参考にした設定値（仮定）、揺れ120秒は演出用の仮定です。県の茅ヶ崎市の計算波形では、最大の波（16分）より前にも地震直後から小さな高まりがありますが、このモデルでは省略しています。',
  },
  {
    id: 'genroku',
    name: '元禄関東地震タイプ（1703年型）',
    shortName: '元禄型関東',
    magnitude: 8.5, // [K-解説] p.5 / [K-被害R7] p.21
    // [K-被害R7] p.41 表2.2「元禄型関東地震（参考）」藤沢市 6強〜7
    shindo: '6+',
    shindoRange: '6強〜7',
    // [K-予測図] 元禄 17/24 図「藤沢海岸（藤沢地区）最大津波高さ：8.0m 最大津波到達時間：9分」
    coastHeight: 8.0,
    arrivalMin: 9,
    // 仮定。この地震単独の計算波形は非公表のため、同じ相模トラフ沿いの西側・中央モデルの値を当てはめる。
    // 参考: 国府津-松田断層帯と連動する場合の平塚市の波形（[K-解説] p.23）は、最初の20分に3〜6分間隔の鋭い山が続き、
    // 後の山の間隔は約10〜13分と短め
    periodMin: PERIOD_SAGAMI_MIN,
    firstMotion: 'rise', // 仮定（県の計算波形は相模トラフ系で水位上昇が先行: [K-解説] p.22–23）
    waves: WAVES_OFFICIAL, // 仮定
    waveAmplitudes: [...AMPS_SAGAMI], // 仮定
    shakingSec: 100, // 演出用の仮定
    warning: 'major',
    isOfficial: true,
    source: '神奈川県「津波浸水予測図」元禄関東地震タイプ（平成27年）',
    sourceUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892750.html',
    arrivalBasis: '県の予測図の藤沢海岸「最大津波到達時間」9分',
    assumptions: [
      ASSUME_SAGAMI_PERIOD,
      ASSUME_SAGAMI_WAVES,
      'この地震単独の計算波形は公表されていないため、周期・後の波の大きさは西側・中央モデルの値を当てはめた（仮定）',
      '揺れ100秒（演出用の仮定）',
      '第1波は押し波から（仮定）',
    ],
    refs: [
      { label: '同 予測図 17/24（作図範囲: 鎌倉市・藤沢市）', url: 'https://www.pref.kanagawa.jp/uploaded/attachment/760382.pdf' },
      { label: '元禄関東地震タイプと国府津-松田断層帯地震の連動地震 予測図 17/24', url: 'https://www.pref.kanagawa.jp/uploaded/attachment/760408.pdf' },
      REF_KANAGAWA_KAISETSU,
      REF_KANAGAWA_HIGAI_R7,
    ],
    // [K-解説] p.7（Mw8.5、発生間隔2千〜3千年、前回1703年、30年以内ほぼ0%）、[K-被害R7] p.21（1703年の元禄関東地震を再現）
    description:
      '1703年の元禄関東地震を再現した相模トラフの地震（Mw8.5、発生間隔2千〜3千年、30年以内の発生確率ほぼ0%）。' +
      '県の予測図では藤沢海岸の最大津波高さ T.P.+8.0m・最大津波到達時間9分、藤沢市全体（がけ地等を含む）の最大は9.9m・6分。' +
      '国府津-松田断層帯と連動する場合も藤沢海岸7.9m・9分とほぼ同じです。震度は県の令和7年被害想定で藤沢市6強〜7（代表値として6強）。' +
      '周期20分・6波（第2波以降は最大の波の0.4倍）は西側・中央モデルの県の計算波形を当てはめた設定値（仮定）、押し波から・揺れ100秒も仮定です。',
  },
  {
    id: 'taisho',
    name: '大正関東地震タイプ（1923年型）',
    shortName: '大正型関東',
    // [K-部会8] p.3「大正関東地震タイプの地震(Mw8.2)」、[K-被害R7] p.21「モーメントマグニチュード8.2」
    magnitude: 8.2,
    // [K-被害R7] p.41 表2.2「大正型関東地震」藤沢市 6強〜7
    shindo: '6+',
    shindoRange: '6強〜7',
    // [K-予測図] 大正 17/24 図「藤沢海岸（藤沢地区）最大津波高さ：6.5m 最大津波到達時間：9分」
    coastHeight: 6.5,
    arrivalMin: 9,
    // 仮定。[K-予測図] 大正 17/24 図では藤沢海岸の最大が9分、隣の片瀬漁港海岸の最大が25分（片瀬では藤沢海岸の最大の約16分後に同程度の波が来ることを示唆）。
    // 1923年の鎌倉付近の計算上の周期は20分程度（梶浦 1986: [萬年2013] §4.4）、来襲は地震後15〜30分（[蟹江2019]）
    periodMin: PERIOD_SAGAMI_MIN,
    // [萬年2013] §5.2 鵠沼では揺れが収まった直後に池へ津波が流れ込んだ（押し波が早い）。
    // 一方 鎌倉・逗子では地震中〜直後に少し引いた記録がある（§2.3, §4.4）。ここでは鵠沼の証言に合わせる。
    firstMotion: 'rise',
    // 仮定（鎌倉で「2・3回おしよせたり」: [萬年2013] §4.4。計算時間内に繰り返すよう西側・中央と同じ6波）
    waves: WAVES_OFFICIAL,
    waveAmplitudes: [...AMPS_SAGAMI], // 仮定
    shakingSec: 90, // 演出用の仮定
    warning: 'major',
    isOfficial: true,
    source: '神奈川県「津波浸水予測図」大正関東地震タイプ（平成27年）／萬年ほか（2013）歴史地震28号',
    sourceUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892751.html',
    arrivalBasis: '県の予測図の藤沢海岸「最大津波到達時間」9分',
    assumptions: [
      ASSUME_SAGAMI_PERIOD,
      // [萬年2013] §4.4 が紹介する梶浦（1986）、[K-予測図] 大正 17/24、[蟹江2019]
      '1923年の津波について、鎌倉付近の計算上の周期は20分程度とされ（萬年ほか 2013 が紹介）、県の予測図でも藤沢海岸（9分）と片瀬漁港海岸（25分）で最大の波の時刻が約16分違う',
      // [萬年2013] §4.4: 田中館（1926）「2・3回おしよせたり」、鎌倉震災誌「後のものの方が、前のものより大きかった」
      '6波、第2波以降は最大の波の0.4倍（仮定。1923年の鎌倉では「2・3回おしよせた」記録があり、後の波の方が大きかったとする記録もある。ここでは県の予測図の藤沢海岸の最大（9分）に合わせて最大の波を第1波とした）',
      '揺れ90秒（演出用の仮定）',
    ],
    refs: [
      { label: '同 予測図 17/24（作図範囲: 鎌倉市・藤沢市）', url: 'https://www.pref.kanagawa.jp/uploaded/attachment/760278.pdf' },
      { label: '萬年ほか（2013）「神奈川県逗子市，鎌倉市，藤沢市における1923年大正関東地震による津波」歴史地震28号', url: REF_URLS.mannen2013 },
      REF_KANAGAWA_HIGAI_R7,
      REF_KANAGAWA_BUKAI8,
    ],
    // [K-被害R7] p.21（1923年の大正関東地震を再現、国が長期的な防災・減災対策の対象として考慮）
    // [萬年2013] 表1 藤沢・引地川: 海岸付近の津波高 ≦6m、後背地の遡上高 4m。§5.2(1) 高木（1981）の証言
    description:
      '1923年（大正12年）の大正関東地震（関東大震災）を再現した相模トラフの地震（Mw8.2）。国が長期的な防災・減災対策の対象として考慮している地震です。' +
      '県の予測図では藤沢海岸の最大津波高さ T.P.+6.5m・最大津波到達時間9分。震度は県の令和7年被害想定で藤沢市6強〜7（代表値として6強）。' +
      '1923年の記録では、鵠沼（引地川河口付近）の海岸付近の津波高は6m以下、内陸への遡上高は約4mと推定され、揺れが収まった直後に鵠沼の庭の池へ津波が流れ込んでいたという証言があります（萬年ほか 2013）。' +
      '第1波は押し波からとしました（鵠沼の証言に合わせた設定。鎌倉・逗子では最初に少し引いた記録もあります）。周期20分・6波（第2波以降は最大の波の0.4倍）は県の計算波形などを参考にした設定値（仮定）、揺れ90秒は演出用の仮定です。',
  },
  {
    id: 'keicho',
    name: '慶長型地震',
    shortName: '慶長型',
    magnitude: 8.5, // [K-解説] p.5 / [K-被害R7] p.22
    // 震度の公的推計なし（[K-被害R7] p.20「津波による被害のみ想定」）。
    // 参考: 南海トラフ沿いの東海地震・南海トラフ巨大地震の藤沢市の推計は 5弱〜6弱（[K-被害R7] p.40–41）。
    // 慶長型の断層は南海トラフ沖と相模トラフ沿いを繋ぐもので（[K-被害R7] p.22, p.35）震源域は一致しない。値は仮置き。
    shindo: '5+',
    // [K-予測図] 慶長 17/24 図「藤沢海岸（藤沢地区）最大津波高さ：8.6m 最大津波到達時間：50分」
    coastHeight: 8.6,
    arrivalMin: 50,
    periodMin: 20, // 仮定（上の「周期・波形の設定根拠」(1)(2)）
    firstMotion: 'rise', // 仮定
    waves: WAVES_OFFICIAL, // 仮定
    // 仮定: 50分の最大の波の前に小さな第1波（AMPS_KEICHO の根拠を参照）
    waveAmplitudes: [...AMPS_KEICHO],
    shakingSec: 90, // 演出用の仮定
    warning: 'major',
    isOfficial: true,
    source: '神奈川県「津波浸水予測図」慶長型地震（平成27年）',
    sourceUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892748.html',
    arrivalBasis: '県の予測図の藤沢海岸「最大津波到達時間」50分。それより前の波の時刻は公表資料に無い',
    assumptions: ['震度5強（仮置き。公的な震度推計なし）', ASSUME_KEICHO_PERIOD, ASSUME_KEICHO_WAVES, '揺れ90秒（演出用の仮定）', '第1波は押し波から（仮定）'],
    refs: [
      { label: '同 予測図 17/24（作図範囲: 鎌倉市・藤沢市）', url: 'https://www.pref.kanagawa.jp/uploaded/attachment/760101.pdf' },
      REF_KANAGAWA_KAISETSU,
      REF_KANAGAWA_HIGAI_R7,
    ],
    // [K-解説] p.9（再現ではなく県独自モデル、相田（1981）の1605年慶長東海地震の断層モデルが基、発生間隔 評価なし）
    // [K-被害R7] p.22・p.35（南海トラフ沖と相模トラフ沿いを繋ぐ断層、Mw8.5 の正断層型）
    description:
      '1605年の慶長地震の断層モデル（相田 1981）をもとに、神奈川県が再現ではなく想定地震として設定した県独自モデル（Mw8.5。南海トラフ沖と相模トラフ沿いを繋ぐ断層を想定。発生間隔の評価なし）。' +
      '県の予測図では藤沢海岸の最大津波高さ T.P.+8.6m・最大津波到達時間50分（片瀬漁港海岸は8.6m・71分）で、相模トラフの地震より最大の波が遅く来ます。それより前に小さな波が来る可能性があります。' +
      '県はこの地震の震度を推計していないため、震度5強は仮置きです（参考: 南海トラフ沿いの東海地震・南海トラフ巨大地震では藤沢市は5弱〜6弱）。' +
      'このモデルでは、最大の波（50分）の約20分前に小さな第1波（最大の波の0.3倍）が来て、その後も0.5倍の波が繰り返します（県の慶長型の計算波形を参考にした設定値＝仮定）。周期20分・押し波から・揺れ90秒も仮定です。',
  },
  {
    id: 'meio',
    name: '明応型地震',
    shortName: '明応型',
    // [K-部会8] p.1「明応型地震（Ｍ8.4）」、[K-被害R7] p.22「モーメントマグニチュード8.4」
    magnitude: 8.4,
    // 震度の公的推計なし（[K-被害R7] p.20）。慶長型と同じ理由で仮置き。
    shindo: '5+',
    // [K-予測図] 明応 17/24 図「藤沢海岸（藤沢地区）最大津波高さ：7.5m 最大津波到達時間：50分」
    coastHeight: 7.5,
    arrivalMin: 50,
    periodMin: 20, // 仮定（この地震の計算波形は非公表。同じく南海トラフ側から来る慶長型の値を当てはめる）
    firstMotion: 'rise', // 仮定
    waves: WAVES_OFFICIAL, // 仮定
    waveAmplitudes: [...AMPS_KEICHO], // 仮定（慶長型と同じ形を当てはめる）
    shakingSec: 90, // 演出用の仮定
    warning: 'major',
    isOfficial: true,
    source: '神奈川県「津波浸水予測図」明応型地震（平成27年）',
    sourceUrl: 'https://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/p892747.html',
    arrivalBasis: '県の予測図の藤沢海岸「最大津波到達時間」50分。それより前の波の時刻は公表資料に無い',
    assumptions: [
      '震度5強（仮置き。公的な震度推計なし）',
      ASSUME_FAR_PERIOD,
      ASSUME_KEICHO_WAVES,
      'この地震の計算波形は公表されていないため、周期・波の形は慶長型の値を当てはめた（仮定）',
      '揺れ90秒（演出用の仮定）',
      '第1波は押し波から（仮定）',
    ],
    refs: [
      { label: '同 予測図 17/24（作図範囲: 鎌倉市・藤沢市）', url: 'https://www.pref.kanagawa.jp/uploaded/attachment/760217.pdf' },
      REF_KANAGAWA_BUKAI8,
      REF_KANAGAWA_HIGAI_R7,
      { label: '国土交通省「津波浸水想定の設定の手引き Ver.2.11」p.52（1498年 明応）', url: REF_URLS.mlitTebiki },
    ],
    // [K-被害R7] p.22・p.36（明応地震の再現モデルではなく想定地震。南海トラフから銭洲海嶺に伸びるプレート内の断層、逆断層型）
    // [K-部会8] p.1（平成24年3月30日公表の予測図で【最大クラス】①明応型地震（Ｍ8.4））、[手引き] p.52（1498年 明応）
    description:
      '明応地震（1498年）の再現ではなく、神奈川県が想定地震として設定したモデル（M8.4。南海トラフから銭洲海嶺に伸びるフィリピン海プレート内の断層を想定）。平成24年3月の県の予測図で「最大クラス」とされた地震の一つです。' +
      '県の予測図（平成27年）では藤沢海岸の最大津波高さ T.P.+7.5m・最大津波到達時間50分です。' +
      'それより前に小さな波が来る可能性があります。県はこの地震の震度を推計していないため、震度5強は仮置きです。' +
      'このモデルでは慶長型と同じく、最大の波の約20分前に小さな第1波（0.3倍）、その後も0.5倍の波が繰り返す設定です。周期20分・押し波から・揺れ90秒も設定値（仮定）です。',
  },

  // ---- 内閣府 南海トラフ巨大地震 --------------------------------------------
  {
    id: 'nankai',
    name: '南海トラフ巨大地震（内閣府の最大クラス想定）',
    shortName: '南海トラフ',
    // [内閣府2012] 第二次報告 PDF p.13: 津波断層モデル Mw9.1（強震断層モデル Mw9.0、[K-被害R7] p.21 も Mw9.0）
    magnitude: 9.1,
    // [内閣府2012] PDF p.139: 藤沢市 最大震度 6弱（経験的手法。基本ケース5強）/ [内閣府2025] PDF p.174: 6弱
    // [K-被害R7] p.41 表2.2: 藤沢市 5弱〜6弱
    shindo: '6-',
    shindoRange: '5弱〜6弱',
    // [内閣府2012] PDF p.3 / [内閣府2025] PDF p.3: 藤沢市 最大津波高（満潮位・地殻変動考慮）7m（ケース⑧）。
    // 市内の全海岸線（崖なども含む）の最大値で、1m単位に切り上げた数値（[内閣府2012] 津波断層モデル編 PDF p.22, p.30）。
    // 鵠沼海岸の値ではない（市内の海岸の平均は5m: [内閣府2012]・[内閣府2025] PDF p.10）。安全側として最大値を使う
    coastHeight: 7,
    // [内閣府2012] PDF p.121 / [内閣府2025] PDF p.154: 津波高+3m の到達 34分（最短、ケース①⑥⑧）
    arrivalMin: 34,
    periodMin: 20, // 仮定（内閣府の資料に周期の値は無い。慶長型の県の計算波形などを参考）
    firstMotion: 'rise', // 仮定
    // 仮定。[内閣府2012] 津波断層モデル編 PDF p.23: 大きな津波が5、6時間から半日程度くり返し来る
    waves: WAVES_OFFICIAL,
    waveAmplitudes: [...AMPS_FAR],
    shakingSec: 180, // 演出用の仮定
    warning: 'major',
    isOfficial: true,
    source:
      '内閣府「南海トラフの巨大地震モデル検討会」市町村別一覧表（平成24年）／「南海トラフ巨大地震モデル・被害想定手法検討会」市町村別一覧表（令和7年）',
    sourceUrl: 'https://www.bousai.go.jp/jishin/nankai/kento_wg/pdf/ichiran.pdf',
    arrivalBasis:
      '内閣府の「津波高+3m」到達時間34分（最短）。内閣府は最大波の時刻を公表していないため、安全側に早い時刻を採用（+1mは32分、+5mは60分）',
    assumptions: [
      ASSUME_FAR_PERIOD,
      ASSUME_FAR_WAVES,
      '揺れ180秒（演出用の仮定）',
      // [内閣府2012] 津波断層モデル編 PDF p.23「いつも同じと考えてはいけない」
      '第1波は押し波から（仮定。内閣府は押し・引きは断層や地域によって異なるとしている）',
      '34分に最大の波が来る設定は安全側の簡略化',
      // [内閣府2012] 津波断層モデル編 PDF p.16
      '初期潮位 T.P.+0.85m（本サイトの設定。内閣府の潮位条件は各地の年間最高潮位を参考にした満潮位）',
    ],
    refs: [
      { label: '内閣府 市町村別一覧表（平成24年8月）', url: REF_URLS.cabinetNankai2012 },
      { label: '内閣府 第二次報告 津波断層モデル編（平成24年8月）', url: REF_URLS.cabinetNankai2012Model },
      { label: '内閣府 市町村別一覧表（令和7年3月）', url: REF_URLS.cabinetNankai2025 },
      REF_KANAGAWA_HIGAI_R7,
    ],
    description:
      '国（内閣府）が想定する南海トラフの最大クラスの地震（津波断層モデル Mw9.1）。藤沢市の最大津波高は7m（11ケースのうち最大。満潮位・地殻変動を考慮、平成24年・令和7年とも）。' +
      'この7mは市内の海岸（崖なども含む）で最も高い値を1m単位に切り上げた数値で、鵠沼海岸の値ではありません（市内の海岸の平均は5m）。本サイトは安全側としてこの最大値を目標にしています。' +
      '津波高+1mの到達は32分、+3mは34分、+5mは60分（各ケースのうち最短）です。内閣府は最大波の時刻を示していないため、本サイトでは安全側に34分に最大の波が来るよう設定しています（実際の最大波はもっと後の可能性があります）。内閣府は、大きな津波が5、6時間から半日程度くり返し来るとしています。' +
      '藤沢市の最大震度は6弱（内閣府。県の令和7年被害想定では5弱〜6弱）。周期20分・6波（第2波以降は最大の波の0.5倍）・押し波から・揺れ180秒は設定値（仮定）です。潮位は内閣府の条件（年間最高潮位を参考にした満潮位）ではなく T.P.+0.85m で計算します。',
  },

  // ---- 説明用の例（公的な想定ではない） --------------------------------------
  {
    id: 'example-farfield',
    // 地震名は [JMA月報] p.71 の「ロシア、カムチャツカ半島東方沖の地震」（当日の報道発表では「カムチャツカ半島付近の地震」）
    name: '遠地津波の例（2025年 ロシア、カムチャツカ半島東方沖の地震を参考）',
    shortName: '遠地津波の例',
    magnitude: 8.8, // [JMA月報] p.71「Mw8.8（Mw は気象庁による）」
    // [JMA月報] p.172: 震度1以上の観測点に神奈川県は含まれない（国内の最大は震度2: p.71）
    shindo: '0',
    // [JMA月報] p.78 表3-1: 横浜25cm・横須賀15cm・三浦市三崎漁港0.2m・三浦市油壺22cm・小田原14cm
    // → 約0.2m を平常潮位からの高さとして初期潮位に上乗せ（説明用の近似）
    jmaHeightM: 0.2,
    coastHeight: exampleCoastTP(0.2),
    // 実際の第一波は油壺 11:24（地震 08:24 の約3時間後）。計算時間（最大120分）に収めるため短縮した設定値
    arrivalMin: 60,
    periodMin: 20, // 仮定
    firstMotion: 'rise', // 仮定
    waves: 3, // 仮定
    shakingSec: 0, // 揺れを感じない
    // [JMA月報] p.71・[JMA報道] 第2報: 7月30日09時40分、相模湾・三浦半島を含む沿岸に津波警報
    // （発表された予想される津波の高さの数値は、確認できた一次資料に記載が無いため書かない）
    warning: 'warning',
    isOfficial: false,
    source: '気象庁「地震・火山月報（防災編）」令和7年7月（津波観測値・震度）',
    sourceUrl: REF_URLS.jmaMonthly202507,
    arrivalBasis: '実際の第1波は地震の約3時間後（油壺 11:24）。計算時間に収めるため60分に短縮した説明用の値',
    assumptions: ['到達60分（実際は約3時間後。短縮した設定値）', ASSUME_EXAMPLE_FAR_PERIOD, ASSUME_WAVES, '揺れを感じない（震度0）として揺れの演出なし'],
    refs: [{ label: '気象庁 報道発表（令和7年7月30日 第2報）', url: REF_URLS.jmaPress20250730 }],
    description:
      // [JMA月報] p.71: 08時24分 地震、08時37分 津波注意報、09時40分 津波警報へ切替
      '揺れを感じなくても津波は来る、という例です。2025年7月30日のロシア、カムチャツカ半島東方沖の地震（Mw8.8）では、神奈川県で震度1以上は観測されませんでしたが、相模湾・三浦半島に津波警報が発表されました（気象庁。地震の13分後に津波注意報、76分後に津波警報へ切替）。' +
      '県内の観測は横浜25cm、三浦市油壺22cm、小田原14cmなど（気象庁）で、警報の区分（1mを超え3m以下）より小さく済みました。この観測に近い約0.2mを潮位 T.P.+0.85m に上乗せしています。' +
      '実際の第1波は地震の約3時間後（油壺 11時24分）で、油壺の最大波は約14時間後（22時08分）でしたが、計算時間に収めるため到達を60分に短縮しています。周期・波の数も設定値です。公的な想定ではありません。',
  },
  {
    id: 'example-forecast',
    name: '若干の海面変動の例（0.2m未満）',
    shortName: '若干の海面変動',
    magnitude: null,
    shindo: '2', // 説明用の仮置き
    jmaHeightM: 0.1,
    coastHeight: exampleCoastTP(0.1),
    arrivalMin: 20,
    periodMin: 15,
    firstMotion: 'rise',
    waves: 3,
    shakingSec: 20,
    warning: 'forecast',
    isOfficial: false,
    source: '気象庁「津波警報・注意報、津波情報、津波予報について」（区分の基準）',
    sourceUrl: REF_URLS.jmaTsunamiInfo,
    assumptions: ['震度・到達時間・周期・波の数・揺れの長さはすべて説明用の設定値'],
    description:
      '気象庁の「津波予報（若干の海面変動）」にあたる例です。予想される津波の高さ0.2m未満で、被害の心配はないとされる区分です。' +
      '高さ0.1m（平常潮位からの高さ）を潮位 T.P.+0.85m に上乗せしています。震度・到達時間・周期などは説明用の設定値で、特定の地震の予測ではありません。',
  },
  {
    id: 'example-advisory',
    name: '津波注意報級の例（1m）',
    shortName: '注意報級 1m',
    magnitude: null,
    shindo: '4', // 説明用の仮置き
    jmaHeightM: 1,
    coastHeight: exampleCoastTP(1),
    arrivalMin: 20,
    periodMin: 15,
    firstMotion: 'rise',
    waves: 3,
    shakingSec: 40,
    warning: 'advisory',
    isOfficial: false,
    source: '気象庁「津波警報・注意報、津波情報、津波予報について」（区分の基準）',
    sourceUrl: REF_URLS.jmaTsunamiInfo,
    assumptions: ['震度・到達時間・周期・波の数・揺れの長さはすべて説明用の設定値'],
    description:
      '気象庁の「津波注意報」（予想される津波の高さ0.2m以上1m以下、発表される高さ「1m」）の上限にあたる例です。海の中では速い流れに巻き込まれる危険があります。' +
      '高さ1m（平常潮位からの高さ）を潮位 T.P.+0.85m に上乗せしています。震度・到達時間・周期などは説明用の設定値で、特定の地震の予測ではありません。',
  },
  {
    id: 'example-warning',
    name: '津波警報級の例（3m）',
    shortName: '警報級 3m',
    magnitude: null,
    shindo: '5-', // 説明用の仮置き
    jmaHeightM: 3,
    coastHeight: exampleCoastTP(3),
    arrivalMin: 20,
    periodMin: 15,
    firstMotion: 'rise',
    waves: 3,
    shakingSec: 60,
    warning: 'warning',
    isOfficial: false,
    source: '気象庁「津波警報・注意報、津波情報、津波予報について」（区分の基準）',
    sourceUrl: REF_URLS.jmaTsunamiInfo,
    assumptions: ['震度・到達時間・周期・波の数・揺れの長さはすべて説明用の設定値'],
    description:
      '気象庁の「津波警報」（予想される津波の高さ1mを超え3m以下、発表される高さ「3m」）の上限にあたる例です。標高の低いところでは浸水被害が発生します。' +
      '高さ3m（平常潮位からの高さ）を潮位 T.P.+0.85m に上乗せしています。震度・到達時間・周期などは説明用の設定値で、特定の地震の予測ではありません。',
  },
  {
    id: 'example-major5',
    name: '大津波警報級の例（5m）',
    shortName: '大津波警報級 5m',
    magnitude: null,
    shindo: '5+', // 説明用の仮置き
    jmaHeightM: 5,
    coastHeight: exampleCoastTP(5),
    arrivalMin: 20,
    periodMin: 15,
    firstMotion: 'rise',
    waves: 3,
    shakingSec: 80,
    warning: 'major',
    isOfficial: false,
    source: '気象庁「津波警報・注意報、津波情報、津波予報について」（区分の基準）',
    sourceUrl: REF_URLS.jmaTsunamiInfo,
    assumptions: ['震度・到達時間・周期・波の数・揺れの長さはすべて説明用の設定値'],
    description:
      '気象庁の「大津波警報」で発表される高さ「5m」（3mを超え5m以下）の上限にあたる例です。' +
      '高さ5m（平常潮位からの高さ）を潮位 T.P.+0.85m に上乗せしています。震度・到達時間・周期などは説明用の設定値で、特定の地震の予測ではありません。',
  },
  {
    id: 'example-major10',
    name: '大津波警報級の例（10m）',
    shortName: '大津波警報級 10m',
    magnitude: null,
    shindo: '6+', // 説明用の仮置き
    jmaHeightM: 10,
    coastHeight: exampleCoastTP(10),
    arrivalMin: 20,
    periodMin: 15,
    firstMotion: 'rise',
    waves: 3,
    shakingSec: 120,
    warning: 'major',
    isOfficial: false,
    source: '気象庁「津波警報・注意報、津波情報、津波予報について」（区分の基準）',
    sourceUrl: REF_URLS.jmaTsunamiInfo,
    assumptions: ['震度・到達時間・周期・波の数・揺れの長さはすべて説明用の設定値'],
    description:
      // 比較対象: [K-予測図] 西側 8.8m・中央 9.5m（藤沢海岸、T.P.）。この例は T.P.+10.85m
      '気象庁の「大津波警報」で発表される高さ「10m」（5mを超え10m以下）の上限にあたる例です。海岸での水位は T.P.+10.85m で、県の予測図の相模トラフ沿いの最大クラスの地震（西側・中央モデル）の藤沢海岸の値（T.P.+8.8〜9.5m）を上回ります。' +
      '高さ10m（平常潮位からの高さ）を潮位 T.P.+0.85m に上乗せしています。震度・到達時間・周期などは説明用の設定値で、特定の地震の予測ではありません。',
  },
];

// ---------------------------------------------------------------------------
// 震度別プリセット
// ---------------------------------------------------------------------------

/**
 * 震度ボタンを押したときに選ぶシナリオ。
 * 公的な震度推計のある地震（6弱〜7）はその推計に基づいて選び、
 * それ以外（0〜5強）は各区分の津波を体験するための説明用の例を割り当てる。
 */
export const SHINDO_PRESETS: Record<ShindoLevel, { scenarioId: string; note: string }> = {
  // 出典: [JMA月報] p.71（国内の最大震度2で津波警報）、p.78、p.172（神奈川県は震度1以上なし）
  '0': {
    scenarioId: 'example-farfield',
    note:
      '揺れを感じなくても津波は来ます。2025年のロシア、カムチャツカ半島東方沖の地震では神奈川県で震度1以上は観測されませんでしたが、相模湾・三浦半島に津波警報が発表されました（気象庁）。その観測を参考にした説明用の例です。',
  },
  '1': {
    scenarioId: 'example-forecast',
    note:
      '小さな揺れの地震の多くは津波を起こしませんが、震度だけでは判断できません。ここでは「若干の海面変動」（0.2m未満）の説明用の例を使います。遠くの巨大地震では、揺れをほとんど感じなくても津波警報が出ることがあります（震度0の例を参照）。',
  },
  '2': {
    scenarioId: 'example-forecast',
    note:
      '「若干の海面変動」（0.2m未満）の説明用の例です。2025年のロシア、カムチャツカ半島東方沖の地震では、国内で観測された最大の揺れは震度2でしたが、太平洋沿岸に津波警報が出ました（気象庁）。震度と津波の大きさは対応しません。',
  },
  '3': {
    scenarioId: 'example-advisory',
    note:
      '「津波注意報」（1m）の説明用の例です。震源が遠い地震では、揺れが弱くても津波注意報・警報が出ることがあります。この割り当ては各区分を体験するための便宜的なものです。',
  },
  '4': {
    scenarioId: 'example-advisory',
    note:
      '「津波注意報」（1m）の説明用の例です。震度と津波の大きさは対応しないため、この割り当ては各区分を体験するための便宜的なものです。',
  },
  // 出典: [K-被害R7] p.41 表2.2（南海トラフ巨大 5弱〜6弱）、[内閣府2012]・[内閣府2025] PDF p.3（最大7m）
  '5-': {
    scenarioId: 'example-warning',
    note:
      '「津波警報」（3m）の説明用の例です。南海トラフ巨大地震では藤沢市の震度は5弱〜6弱（県の令和7年被害想定）ですが、内閣府の想定では藤沢市で最大7mの津波とされています。揺れが中程度でも大きな津波が来ることがあります。',
  },
  '5+': {
    scenarioId: 'example-major5',
    note:
      '「大津波警報」（5m）の説明用の例です。公的な震度推計のない慶長型・明応型地震（藤沢海岸で7.5〜8.6m、最大の波は約50分後）も、本サイトでは震度5強に仮置きしています。',
  },
  '6-': {
    scenarioId: 'nankai',
    note:
      '南海トラフ巨大地震（内閣府の最大クラス想定）。藤沢市の最大震度は6弱と推計されています（内閣府。県の令和7年被害想定では5弱〜6弱）。震源は遠くても、藤沢市の海岸で最大7m（市内で最も高い地点の値）の津波が想定されています。',
  },
  // 出典: [K-被害R7] p.21, p.41 表2.2、[K-予測図] 大正 17/24（藤沢海岸 9分）
  '6+': {
    scenarioId: 'taisho',
    note:
      '大正関東地震タイプ（1923年の大正関東地震＝関東大震災の再現）。県の令和7年被害想定で藤沢市は震度6強〜7（元禄関東地震タイプも6強〜7）。県の予測図では藤沢海岸に最大の波が来るのは地震の9分後で、相模湾の地震では津波がすぐに来ます。',
  },
  // 出典: [F-概要]（全県域で震度7）、[K-被害R7] p.40 表2.2（都心南部直下 藤沢市5強〜7）、p.69 表2.6（藤沢市の記載なし）
  '7': {
    scenarioId: 'sagami-west',
    note:
      '相模トラフ沿いの最大クラスの地震（西側モデル）。藤沢市の資料では「神奈川県全県域で震度7」とされています。なお、都心南部直下地震でも藤沢市で最大震度7と推計されていますが、県の被害想定の浸水面積（30cm以上）の表に藤沢市は載っていません。震度が同じでも、津波の大きさは地震の起こり方で大きく違います。',
  },
};

// ---------------------------------------------------------------------------
// 関数
// ---------------------------------------------------------------------------

export function getScenario(id: string): ScenarioInfo | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/**
 * 計算時間 [分] の既定値: 到達時間 + 周期の3倍 を含む最小の選択肢（60 分以上、最大 120 分）。
 */
export function defaultDurationMin(scenario: Pick<QuakeScenario, 'arrivalMin' | 'periodMin'>): number {
  const arrival = Number.isFinite(scenario.arrivalMin) ? Math.max(0, scenario.arrivalMin) : 0;
  const period = Number.isFinite(scenario.periodMin) ? Math.max(0, scenario.periodMin) : 0;
  const need = arrival + 3 * period;
  for (const m of DURATION_OPTIONS_MIN) {
    if (m >= 60 && m >= need) return m;
  }
  return DURATION_OPTIONS_MIN[DURATION_OPTIONS_MIN.length - 1];
}

/**
 * シナリオの既定の実行パラメータ。
 * - 初期潮位: 神奈川県の想定の朔望平均満潮位 T.P.+0.85m（[K-解説] p.10）。
 *   内閣府の南海トラフ想定（潮位条件は年間最高潮位を参考にした満潮位: [内閣府2012] 津波断層モデル編 PDF p.16）と
 *   説明用の例も、比較しやすいよう同じ値にする（本サイトの設定。例の最大津波高もこの潮位に上乗せして作っている）。
 * - 陸域の粗度係数: 住宅地（中密度）0.06（[手引き] p.32 表-3）。
 */
export function defaultParams(scenario: QuakeScenario): SimParams {
  return {
    scenario: { ...scenario },
    tideTP: OFFICIAL_TIDE_TP,
    durationMin: defaultDurationMin(scenario),
    resolution: 'standard',
    landManning: DEFAULT_LAND_MANNING,
  };
}
