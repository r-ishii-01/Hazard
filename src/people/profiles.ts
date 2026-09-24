/**
 * 人物（避難者）の種別ごとの既定値と、浸水深による危険度の区分。
 *
 * 数値はいずれも公的資料の「目安」や被害想定の「仮定」であり、個人の実際の行動や
 * 生死を予測するものではない。出典 URL を各定数のコメントに記す。
 */
import type { PersonKind, PersonStatus } from '../core/types';

// ---------------------------------------------------------------------------
// 出典
// ---------------------------------------------------------------------------

/**
 * 消防庁「市町村における津波避難計画策定指針」（津波避難対策推進マニュアル検討会報告書 第2章）。
 * 「歩行速度は1.0m/秒（老人自由歩行速度、群集歩行速度、地理不案内者歩行速度等）を目安とする。
 *  ただし、歩行困難者、身体障がい者、乳幼児、重病人等についてはさらに歩行速度が低下する（0.5m/秒）
 *  ことを考慮する必要がある」
 * （指針は高齢者一般を 0.5m/秒 とはしていない。1.0m/秒 は「老人自由歩行速度」も踏まえた値）
 * また避難困難地域の検討では「歩行速度1m/秒、地震発生から避難開始まで2分、避難可能距離500m」を目安とする。
 * - 平成25年3月版: https://www.fdma.go.jp/neuter/about/shingi_kento/h24/tsunami_hinan/houkokusho/p02.pdf
 * - 令和7年3月改訂版: https://www.fdma.go.jp/laws/tutatsu/items/tuchi2503/pdf/250311_sai_1-2.pdf
 */
export const FDMA_GUIDELINE_URL = 'https://www.fdma.go.jp/laws/tutatsu/items/tuchi2503/pdf/250311_sai_1-2.pdf';
export const FDMA_GUIDELINE_LABEL = '消防庁「市町村における津波避難計画策定指針」';

/**
 * 内閣府「南海トラフの巨大地震 建物被害・人的被害の被害想定項目及び手法の概要」（平成24年8月）。
 * - 避難開始: 直接避難者は発災5分後、用事後避難者は15分後、切迫避難者は津波到達後（昼間）。
 *   夜間はさらに5分準備に時間がかかり、避難速度は昼間の80%とする。
 * - 避難速度: 東日本大震災の実績から平均 2.65 km/h（約0.74 m/s）。夜間は北海道南西沖地震の実績から昼間の80%。
 *   （令和元年6月の再計算資料にも同じ記載: CAO_NANKAI_2019_URL）
 * - 津波に巻き込まれた場合の死者率: 越村ほか（2009）の浸水深別死者率を参考に、
 *   浸水深30cm以上で死者が発生し始め、浸水深1mでは巻き込まれた人全員が死亡すると仮定。
 * https://www.bousai.go.jp/jishin/nankai/taisaku/pdf/2_2.pdf
 * （同手法を用いた自治体資料の例: https://www.pref.osaka.lg.jp/documents/2473/5_shiryou_3.pdf ）
 */
export const CAO_NANKAI_METHOD_URL = 'https://www.bousai.go.jp/jishin/nankai/taisaku/pdf/2_2.pdf';
/** 内閣府「南海トラフ巨大地震の被害想定について（建物被害・人的被害）」令和元年6月（避難速度 2.65km/h の記載） */
export const CAO_NANKAI_2019_URL = 'https://www.bousai.go.jp/jishin/nankai/taisaku_wg/pdf/1_sanko2.pdf';
export const CAO_NANKAI_METHOD_LABEL = '内閣府「南海トラフの巨大地震 建物被害・人的被害の被害想定項目及び手法の概要」';

/**
 * 国土交通省「川の防災情報」浸水深と避難行動について（河川の氾濫を想定した解説）。
 * 「流速が速い場合は、20cm程度でも歩行が困難になる」「浸水深が50cmを上回る場合の避難行動は危険」。
 * https://city.river.go.jp/kawabou/reference/index05.html
 */
export const MLIT_DEPTH_WALKING_URL = 'https://city.river.go.jp/kawabou/reference/index05.html';

/**
 * バリアフリー法の建築物移動等円滑化基準（傾斜路の勾配は1/12以下）。車いすの経路探索で
 * 「急な坂」とみなす勾配の目安に使う（道路の勾配基準そのものではない。モデル上の仮定）。
 * https://www.mlit.go.jp/jutakukentiku/build/barrier-free.files/07-00enkatuka.pdf
 */
export const BARRIER_FREE_SLOPE_URL = 'https://www.mlit.go.jp/jutakukentiku/build/barrier-free.files/07-00enkatuka.pdf';

// ---------------------------------------------------------------------------
// 人物の種別
// ---------------------------------------------------------------------------

/** 経路探索での移動特性（坂の避け方） */
export type MobilityClass = 'walk' | 'wheelchair';

export interface PersonProfile {
  kind: PersonKind;
  label: string;
  /** 既定の歩行速度 [m/s] */
  speedMps: number;
  /** 既定の避難開始時間 [分] */
  defaultStartDelayMin: number;
  /** 表示色 */
  color: string;
  description: string;
  /** 経路探索での坂の扱い */
  mobility: MobilityClass;
  /** 歩行速度の根拠（短い表記） */
  speedBasis: string;
  /** 速度が公的資料の目安ではなく、このアプリの仮定である場合 true */
  speedIsAssumption: boolean;
}

/**
 * 既定の避難開始時間 [分]。内閣府の被害想定で「直接避難」（すぐに避難する人）の
 * 避難開始時間とされる「発災5分後（昼間）」を採用（CAO_NANKAI_METHOD_URL）。
 */
export const DEFAULT_START_DELAY_MIN = 5;

export const PERSON_PROFILES: Record<PersonKind, PersonProfile> = {
  adult: {
    kind: 'adult',
    label: '大人',
    speedMps: 1.0,
    defaultStartDelayMin: DEFAULT_START_DELAY_MIN,
    color: '#2563eb',
    description:
      '歩いて避難する大人。歩行速度は1.0m/s（消防庁の津波避難計画策定指針で目安とされる値）。' +
      'なお、内閣府の被害想定では、東日本大震災の実績から平均約0.74m/s（2.65km/h）が用いられています。',
    mobility: 'walk',
    speedBasis: '消防庁指針の目安 1.0m/s',
    speedIsAssumption: false,
  },
  child: {
    kind: 'child',
    label: '子ども',
    speedMps: 1.0,
    defaultStartDelayMin: DEFAULT_START_DELAY_MIN,
    color: '#16a34a',
    description:
      '自分で歩いて避難する子ども（小学生程度）を想定し、大人と同じ1.0m/sとしています（モデル上の仮定）。' +
      '乳幼児については、消防庁の指針でさらに遅い0.5m/sを考慮する必要があるとされています。必要に応じて速度を変更してください。',
    mobility: 'walk',
    speedBasis: '大人と同じ 1.0m/s（仮定）',
    speedIsAssumption: true,
  },
  elderly: {
    kind: 'elderly',
    label: '高齢者',
    speedMps: 0.5,
    defaultStartDelayMin: DEFAULT_START_DELAY_MIN,
    color: '#9333ea',
    description:
      '歩行に時間がかかる高齢者を想定し、消防庁の指針で歩行困難者・身体障がい者・乳幼児・重病人等について考慮するとされる0.5m/sを当てはめています（当てはめ方はモデル上の仮定）。' +
      '指針の目安1.0m/sは高齢者の自由歩行速度なども踏まえた値なので、元気な方は1.0m/sに変更して比べてみてください。',
    mobility: 'walk',
    speedBasis: '歩行困難者等の目安 0.5m/s を適用（仮定）',
    speedIsAssumption: true,
  },
  wheelchair: {
    kind: 'wheelchair',
    label: '車いす',
    speedMps: 0.5,
    defaultStartDelayMin: DEFAULT_START_DELAY_MIN,
    color: '#ea580c',
    description:
      '車いすを利用する人。速度は消防庁の指針で身体障がい者等の目安とされる0.5m/s。' +
      '経路探索では急な坂（勾配1/12を超える所）を強く避けます（坂の扱いはモデル上の仮定）。',
    mobility: 'wheelchair',
    speedBasis: '消防庁指針の身体障がい者等の目安 0.5m/s',
    speedIsAssumption: false,
  },
  runner: {
    kind: 'runner',
    label: '走って避難',
    speedMps: 2.0,
    defaultStartDelayMin: DEFAULT_START_DELAY_MIN,
    color: '#0891b2',
    description:
      '走って避難する人。2.0m/s（ジョギング程度）はこのアプリの仮定で、公的な目安ではありません。' +
      '実際には長い距離を走り続けられるとは限りません。',
    mobility: 'walk',
    speedBasis: 'ジョギング程度 2.0m/s（仮定）',
    speedIsAssumption: true,
  },
};

/** 避難開始時間の選択肢（UI 用）。出典は各 note を参照 */
export const START_DELAY_PRESETS: { min: number; label: string; note: string; sourceUrl: string }[] = [
  {
    min: 2,
    label: '2分後',
    note: '消防庁の指針で、避難困難地域の検討に用いる「地震発生から避難開始まで2分」の目安',
    sourceUrl: FDMA_GUIDELINE_URL,
  },
  {
    min: 5,
    label: '5分後（すぐに避難・昼）',
    note: '内閣府の被害想定で「直接避難」する人の避難開始時間（昼間）',
    sourceUrl: CAO_NANKAI_METHOD_URL,
  },
  {
    min: 10,
    label: '10分後（すぐに避難・夜）',
    note: '同想定では、夜間は準備にさらに5分かかると仮定',
    sourceUrl: CAO_NANKAI_METHOD_URL,
  },
  {
    min: 15,
    label: '15分後（用事を済ませてから・昼）',
    note: '内閣府の被害想定で「用事後避難」する人の避難開始時間（昼間）',
    sourceUrl: CAO_NANKAI_METHOD_URL,
  },
  {
    min: 20,
    label: '20分後（用事を済ませてから・夜）',
    note: '同想定の夜間（昼間より5分遅い）',
    sourceUrl: CAO_NANKAI_METHOD_URL,
  },
];

// ---------------------------------------------------------------------------
// 浸水深による危険度
// ---------------------------------------------------------------------------

export type DepthStatus = Extract<PersonStatus, 'caution' | 'danger' | 'critical'>;

export interface DepthThreshold {
  status: DepthStatus;
  /** この浸水深以上 [m] */
  minDepth: number;
  /** 短い表記 */
  label: string;
  /** 状態の説明（日本語） */
  description: string;
  source: string;
  sourceUrl: string;
}

/** 浸水ありとみなす深さ [m]（シミュレーションの「到達」判定・凡例と同じ 1cm） */
export const DEPTH_CAUTION_M = 0.01;
/** 歩行が困難になり、被害想定で死者が発生し始めるとされる深さ [m] */
export const DEPTH_DANGER_M = 0.3;
/** 被害想定で「巻き込まれた人全員が死亡」と仮定される深さ [m] */
export const DEPTH_CRITICAL_M = 1.0;

/** 危険度の区分（浅い順）。表示・判定の両方でこの表を使う */
export const DEPTH_THRESHOLDS: readonly DepthThreshold[] = [
  {
    status: 'caution',
    minDepth: DEPTH_CAUTION_M,
    label: '浸水（注意）',
    description: '足元が浸水している状態。国土交通省の解説（河川の氾濫）では、流れが速いと20cm程度でも歩行が困難になるとされています。',
    source: '国土交通省「川の防災情報」浸水深と避難行動について',
    sourceUrl: MLIT_DEPTH_WALKING_URL,
  },
  {
    status: 'danger',
    minDepth: DEPTH_DANGER_M,
    label: '歩行困難（危険）',
    description:
      '流れの速い津波の中では歩くのが難しく、流されるおそれがある深さ。内閣府の被害想定では、津波に巻き込まれた場合、浸水深30cm以上で死者が発生し始めるとしています。',
    source: CAO_NANKAI_METHOD_LABEL,
    sourceUrl: CAO_NANKAI_METHOD_URL,
  },
  {
    status: 'critical',
    minDepth: DEPTH_CRITICAL_M,
    label: '生命の危険',
    description:
      '命に関わる深さ。内閣府の被害想定では、浸水深1m以上の津波に巻き込まれた場合、巻き込まれた人全員が死亡すると仮定しています（被害想定のための仮定で、個人の生死を予測するものではありません）。',
    source: CAO_NANKAI_METHOD_LABEL,
    sourceUrl: CAO_NANKAI_METHOD_URL,
  },
];

/** 浸水深 [m] → 危険度（浸水なしは null） */
export function classifyDepth(depth: number): DepthThreshold | null {
  let hit: DepthThreshold | null = null;
  for (const th of DEPTH_THRESHOLDS) {
    if (depth >= th.minDepth) hit = th;
  }
  return hit;
}

/** 状態ごとの表示名と色（地図・一覧・グラフで共通に使える） */
export const PERSON_STATUS_INFO: Record<PersonStatus, { label: string; color: string }> = {
  waiting: { label: '避難開始前', color: '#64748b' },
  evacuating: { label: '避難中', color: '#2563eb' },
  safe: { label: '避難完了', color: '#16a34a' },
  caution: { label: '浸水（注意）', color: '#ca8a04' },
  danger: { label: '歩行困難（危険）', color: '#ea580c' },
  critical: { label: '生命の危険', color: '#b91c1c' },
};
