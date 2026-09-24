/**
 * 気象庁の津波警報・注意報・予報の区分。
 *
 * 文言の出典: 気象庁「津波警報・注意報、津波情報、津波予報について」
 *   https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html
 *   - 表「津波警報・注意報の種類」: 発表基準、発表される津波の高さ（数値・巨大地震の場合）、想定される被害と取るべき行動
 *   - 表「津波予報の発表条件」: 0.2ｍ未満の海面変動が予想されたとき 等
 *   - 「津波が予想されないときは、津波の心配なしの旨を地震情報に含めて発表します。」
 *   - 「津波警報・注意報と避難のポイント」
 *   文言は同ページの記載をそのまま使う（全角数字・記号は読みやすさのため半角に統一）。
 * 「若干の海面変動」「津波の心配なし」という呼び方の出典: 気象庁「地震情報について」
 *   https://www.jma.go.jp/jma/kishou/know/jishin/joho/seisinfo.html
 *   （地震情報に「津波の心配がない」または「若干の海面変動があるかもしれないが被害の心配はない」旨を付加して発表）
 *
 * 「津波の高さ」の定義: 気象庁の津波の高さは平常潮位（津波が無かった場合のその時刻の潮位）からの高さ。
 *   神奈川県の「最大津波高さ」（T.P. 基準・潮位を含む）とは基準が異なる。
 *   出典: 神奈川県「津波浸水想定について（解説）」p.4 https://www.pref.kanagawa.jp/uploaded/attachment/774580.pdf
 *   気象庁「地震・火山月報（防災編）」令和7年7月 p.79 図3-1（最大の高さは平常潮位から測る）
 *   https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/202507/202507monthly.pdf
 *
 * 色の出典: 気象庁「気象庁ホームページにおける気象情報の配色に関する設定指針」（平成24年5月）p.5 表1
 *   https://www.jma.go.jp/jma/kishou/info/colorguide/120524_hpcolorguide.pdf
 *   表1「津波警報・注意報」の行: 津波警報（大津波）(200,0,255)＝紫 / 津波警報（津波）(255,40,0)＝赤 / 津波注意報 (250,245,0)＝黄
 *   none の (200,200,203) は表1の「発表なし」列の色（津波の行には記載が無く、気象警報注意報などの「発表なし」の色を流用）。
 *   津波予報（若干の海面変動）は指針に定めが無いため本サイトの設定（同指針 表2－1 の淡い青 (160,210,255) を流用）。
 *   文字色は、背景とのコントラスト比（WCAG の相対輝度で計算）が高い方として黒を本サイトで選んだ（5色とも黒の方が高い）。
 */
import type { WarningLevel } from '../core/types';

export interface WarningInfo {
  level: WarningLevel;
  /** 例: 「大津波警報」 */
  label: string;
  /** 予想される津波の高さの区分（発表基準） */
  heightRange: string;
  /** 発表される数値（例: 「10m超, 10m, 5m」） */
  announced: string;
  /** 想定される被害 */
  damage: string;
  /** とるべき行動 */
  action: string;
  color: string;
  textColor: string;
}

export const JMA_TSUNAMI_INFO_URL = 'https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html';

/**
 * 気象庁が津波警報・注意報の発表の目標としている時間 [秒]（地震発生から約3分）。
 * 出典: JMA_TSUNAMI_INFO_URL「地震が発生してから約３分（一部の地震※１については約２分）を目標に、
 *   大津波警報、津波警報または津波注意報を、津波予報区単位で発表します。」
 *   ※１ 日本近海で発生し、緊急地震速報の技術によって精度の良い震源位置やマグニチュードが迅速に求められる地震
 * 注意: 目標であり、遠地地震では異なる（例: 2025年7月30日のロシア、カムチャツカ半島東方沖の地震では
 *   地震の13分後に津波注意報、76分後に津波警報へ切替: 気象庁「地震・火山月報（防災編）」令和7年7月 p.71）。
 */
export const JMA_ISSUE_TARGET_SEC = 180;

/** JMA_ISSUE_TARGET_SEC の説明文（画面表示用。気象庁の記載の要約） */
export const JMA_ISSUE_TARGET_NOTE =
  '気象庁は地震発生から約3分（一部の地震は約2分）を目標に津波警報・注意報を発表します。遠くで起きた地震では発表までにもっと時間がかかることがあります。';

const ACTION_EVACUATE = '沿岸部や川沿いにいる人は、ただちに高台や避難ビルなど安全な場所へ避難してください。';

export const WARNING_INFO: Record<WarningLevel, WarningInfo> = {
  none: {
    level: 'none',
    label: '津波の心配なし',
    heightRange: '津波が予想されないとき',
    announced: '地震情報の中で「津波の心配なし」と発表',
    damage: '',
    // 気象庁「津波警報・注意報と避難のポイント」より
    action: '震源が陸地に近いと津波警報・注意報が津波の襲来に間に合わないことがあります。強い揺れや弱くても長い揺れを感じたときは、すぐに避難を開始しましょう。',
    color: '#c8c8cb',
    textColor: '#000000',
  },
  forecast: {
    level: 'forecast',
    label: '津波予報（若干の海面変動）',
    heightRange: '0.2m未満の海面変動が予想されたとき',
    announced: '数値の発表なし（「若干の海面変動」）',
    damage: '高いところでも0.2m未満の海面変動のため被害の心配はなく、特段の防災対応の必要がない旨を発表します。',
    // 表「津波予報の発表条件」の「津波注意報解除後も海面変動が継続するとき」の内容（原文どおり）
    action:
      '（津波注意報解除後も海面変動が継続するとき）津波に伴う海面変動が観測されており、今後も継続する可能性が高いため、海に入っての作業や釣り、海水浴などに際しては十分な留意が必要である旨を発表します。',
    color: '#a0d2ff',
    textColor: '#000000',
  },
  advisory: {
    level: 'advisory',
    label: '津波注意報',
    heightRange: '予想される津波の最大波の高さが高いところで0.2m以上、1m以下の場合であって、津波による災害のおそれがある場合',
    // 表「巨大地震の場合の発表」欄は「（表記しない）」
    announced: '1m（巨大地震の場合の発表では高さを表記しない）',
    damage: '海の中では人は速い流れに巻き込まれ、また、養殖いかだが流失し小型船舶が転覆します。',
    action: '海の中にいる人はただちに海から上がって、海岸から離れてください。',
    color: '#faf500',
    textColor: '#000000',
  },
  warning: {
    level: 'warning',
    label: '津波警報',
    heightRange: '予想される津波の最大波の高さが高いところで1mを超え、3m以下の場合',
    announced: '3m（巨大地震の場合は「高い」）',
    damage: '標高の低いところでは津波が襲い、浸水被害が発生します。人は津波による流れに巻き込まれます。',
    action: ACTION_EVACUATE,
    color: '#ff2800',
    textColor: '#000000',
  },
  major: {
    level: 'major',
    label: '大津波警報',
    heightRange: '予想される津波の最大波の高さが高いところで3mを超える場合',
    announced: '10m超、10m、5m（巨大地震の場合は「巨大」）',
    damage: '巨大な津波が襲い、木造家屋が全壊・流失し、人は津波による流れに巻き込まれます。',
    action: ACTION_EVACUATE,
    color: '#c800ff',
    textColor: '#000000',
  },
};

/** 気象庁「津波警報・注意報と避難のポイント」（原文どおり） */
export const EVACUATION_POINTS: string[] = [
  '震源が陸地に近いと津波警報・注意報が津波の襲来に間に合わないことがあります。強い揺れや弱くても長い揺れを感じたときは、すぐに避難を開始しましょう。',
  '津波の高さを「巨大」と予想する大津波警報が発表された場合は、東日本大震災のような巨大な津波が襲うおそれがあります。ただちにできる限りの避難をしましょう。',
  '津波は沿岸の地形等の影響により、局所的に予想より高くなる場合があります。ここなら安心と思わず、より高い場所を目指して避難しましょう。',
  '津波は長い時間くり返し襲ってきます。津波警報・注意報が解除されるまでは、避難を続けましょう。',
  '津波予報区の第一波の到達予想時刻は、津波予報区の中で最も早く津波の第一波が到達する時刻です。同じ予報区の中でも、場所によってはこの時刻よりも数十分、場合によっては1時間以上遅れて津波が襲ってくることがあります。',
];

/** 数値の丸め（浮動小数の誤差で境界値が隣の区分に入らないようにする。1 mm 単位） */
const roundMm = (v: number) => Math.round(v * 1000) / 1000;

/**
 * 予想される津波の高さ [m]（気象庁の定義: 平常潮位からの高さ）から区分を返す。
 * 気象庁の発表基準:
 *   大津波警報  3m < h
 *   津波警報    1m < h ≦ 3m
 *   津波注意報  0.2m ≦ h ≦ 1m（津波による災害のおそれがある場合）
 *   津波予報    h < 0.2m の海面変動が予想されたとき
 *   津波の心配なし  津波が予想されないとき（ここでは h ≦ 0 または数値でない場合）
 */
export function warningForHeight(heightM: number): WarningLevel {
  if (!Number.isFinite(heightM)) return 'none';
  const h = roundMm(heightM);
  if (h > 3) return 'major';
  if (h > 1) return 'warning';
  if (h >= 0.2) return 'advisory';
  if (h > 0) return 'forecast';
  return 'none';
}

/**
 * 気象庁が数値で発表する「予想される津波の高さ」（5段階）。0.2m 未満は null。
 * 区分: 10m超 (10<h) / 10m (5<h≦10) / 5m (3<h≦5) / 3m (1<h≦3) / 1m (0.2≦h≦1)
 */
export function announcedHeight(heightM: number): '10m超' | '10m' | '5m' | '3m' | '1m' | null {
  if (!Number.isFinite(heightM)) return null;
  const h = roundMm(heightM);
  if (h > 10) return '10m超';
  if (h > 5) return '10m';
  if (h > 3) return '5m';
  if (h > 1) return '3m';
  if (h >= 0.2) return '1m';
  return null;
}

/**
 * T.P. 基準の最大水位（本サイトの「最大津波高」）と潮位から、気象庁の定義に近い「津波の高さ」を求める。
 * 注意: 神奈川県の最大津波高さは海岸線から約30m沖の水位で、潮位の扱いも厳密には一致しない。目安の換算。
 */
export function jmaHeightFromTP(coastHeightTP: number, tideTP: number): number {
  return roundMm(coastHeightTP - tideTP);
}
