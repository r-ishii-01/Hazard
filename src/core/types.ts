/**
 * アプリ全体で共有する型（モジュール間の契約）。
 * ここを変更する場合は、利用している全モジュールを合わせて更新すること。
 */
import type { GridSpec, Resolution } from './geo';

// ---------------------------------------------------------------------------
// 地形
// ---------------------------------------------------------------------------

/** セル種別 */
export const CELL_LAND = 0;
/** 海・河川など、海とつながった水域（津波の計算で水深を持つ） */
export const CELL_SEA = 1;
/** 海とつながっていない内水面（池など）。計算上は陸として扱う */
export const CELL_INLAND_WATER = 2;

export type TerrainSource = 'gsi' | 'cache' | 'synthetic';

export interface TerrainGrid {
  spec: GridSpec;
  /**
   * 地盤高 [m, T.P.（東京湾平均海面）基準]。
   * 陸は標高（正）、海・河川は水深を負の値で持つ（例: 水深 12 m → -12）。
   */
  z: Float32Array;
  /** セル種別（CELL_LAND / CELL_SEA / CELL_INLAND_WATER） */
  kind: Uint8Array;
  /** マニングの粗度係数 n [s/m^(1/3)] */
  manning: Float32Array;
  /** 標高データの出所 */
  source: TerrainSource;
  /** 画面表示用の出典ラベル（例: 「国土地理院 標高タイル（DEM5A/DEM10B）を加工して作成」） */
  sourceLabel: string;
  /** 合成（近似）地形のとき true。UI は注意バナーを出す */
  isApproximate: boolean;
  /** 水深は実測でなく推定であることの説明など */
  notes: string[];
}

// ---------------------------------------------------------------------------
// 地震・津波シナリオ
// ---------------------------------------------------------------------------

/** 気象庁震度階級 */
export type ShindoLevel = '0' | '1' | '2' | '3' | '4' | '5-' | '5+' | '6-' | '6+' | '7';

export const SHINDO_LEVELS: ShindoLevel[] = ['0', '1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];

/** 震度の日本語表記（例: '5-' → '5弱'） */
export const SHINDO_LABEL: Record<ShindoLevel, string> = {
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5-': '5弱',
  '5+': '5強',
  '6-': '6弱',
  '6+': '6強',
  '7': '7',
};

/** 気象庁の津波警報等の区分 */
export type WarningLevel = 'none' | 'forecast' | 'advisory' | 'warning' | 'major';

export interface QuakeScenario {
  id: string;
  /** 例: 「相模トラフ沿いの海溝型地震（西側モデル）」 */
  name: string;
  /** 短い名前（UI のボタン等） */
  shortName: string;
  magnitude: number | null;
  /** 藤沢市付近の代表的な震度 */
  shindo: ShindoLevel;
  /** 海岸線での最大津波高さの目標値 [m, T.P.] */
  coastHeight: number;
  /** 地震発生から海岸への津波の到達時間 [分]（押し波の第1波がこの時刻に最大となるよう設定） */
  arrivalMin: number;
  /** 卓越周期 [分] */
  periodMin: number;
  /** 第1波の初動: 'rise'=押し波から, 'fall'=引き波から */
  firstMotion: 'rise' | 'fall';
  /** 有意な波の数（後続波は減衰） */
  waves: number;
  /** 強い揺れの継続時間 [秒]（揺れアニメーション用） */
  shakingSec: number;
  /** 想定される気象庁の発表区分 */
  warning: WarningLevel;
  description: string;
  /** 公的な想定に基づく値なら true、説明用の代表例なら false */
  isOfficial: boolean;
  /** 出典表記 */
  source?: string;
  sourceUrl?: string;
}

export interface SimParams {
  /** 実行に使うシナリオ（UI で津波高などを調整したコピー） */
  scenario: QuakeScenario;
  /** 初期潮位 [m, T.P.] */
  tideTP: number;
  /** 計算時間 [分]（地震発生からの経過時間） */
  durationMin: number;
  resolution: Resolution;
  /** 陸域のマニング粗度係数 */
  landManning: number;
}

// ---------------------------------------------------------------------------
// シミュレーション結果
// ---------------------------------------------------------------------------

/** シミュレーション出力（ワーカーから逐次届くフレームを保持し、時刻補間で参照する） */
export interface SimOutput {
  spec: GridSpec;
  /** フレーム間隔 [秒] */
  frameInterval: number;
  /** 計算終了時刻 [秒]（地震発生から） */
  durationSec: number;
  /** 受信済みフレーム数（フレーム i の時刻は i * frameInterval） */
  framesReady(): number;
  /** 受信済みの最終時刻 [秒] */
  timeReady(): number;
  /** 時刻 t [秒] のセル k の全水深 D [m]（海域は海底からの水柱、陸は浸水深）。線形補間 */
  depthAt(t: number, k: number): number;
  /** 時刻 t のセル k の水位 [m, T.P.]。乾燥セルは NaN */
  etaAt(t: number, k: number): number;
  /** 時刻 t の全セルの全水深 [m] を out に書き込む（長さ nx*ny） */
  fillDepth(t: number, out: Float32Array): void;
  /** 陸域セル（初期に乾燥）の最大浸水深 [m]。完了前は途中までの最大値 */
  maxDepth: Float32Array;
  /** 最大水位 [m, T.P.] */
  maxEta: Float32Array;
  /** 初期乾燥セルが最初に浸水（深さ ≥ 0.01 m）した時刻 [秒]。未浸水は +Infinity */
  arrival: Float32Array;
  /** 海岸代表点の水位時系列（潮位計のイメージ） */
  gauge: { t: Float32Array; eta: Float32Array; lon: number; lat: number; count(): number };
  /** 実際に得られた海岸線での最大水位 [m, T.P.]（目標 coastHeight と比較表示） */
  achievedCoastMax(): number;
  /** 境界入射波の振幅の自動調整結果（デバッグ・説明用） */
  calibration: { targetCoastHeight: number; boundaryAmplitude: number };
}

// ---------------------------------------------------------------------------
// 避難場所
// ---------------------------------------------------------------------------

export type ShelterKind = 'evac-site' | 'tsunami-building' | 'highground';

export interface Shelter {
  id: string;
  name: string;
  lon: number;
  lat: number;
  kind: ShelterKind;
  address?: string;
  /** 避難可能な高さ [m, T.P.] が分かる場合 */
  safeHeightTP?: number;
  /** データの出所（例: 「国土地理院 指定緊急避難場所データ（津波）」） */
  source: string;
}

// ---------------------------------------------------------------------------
// 人物
// ---------------------------------------------------------------------------

export type PersonKind = 'adult' | 'child' | 'elderly' | 'wheelchair' | 'runner';

/** 避難行動: 'stay'=その場にとどまる, 'shelter'=最寄りの避難場所へ, 'highground'=最寄りの高台へ */
export type EvacMode = 'stay' | 'shelter' | 'highground';

export interface Person {
  id: string;
  name: string;
  kind: PersonKind;
  /** 地震発生時にいた位置 */
  lon: number;
  lat: number;
  evacMode: EvacMode;
  /** 地震発生から避難を始めるまでの時間 [分] */
  startDelayMin: number;
  /** 歩行速度 [m/s]（未指定なら種別の既定値） */
  speedMps?: number;
}

export interface PathPoint {
  lon: number;
  lat: number;
  /** 地震発生からこの点に到達する時刻 [秒] */
  t: number;
}

export interface EvacPlan {
  personId: string;
  path: PathPoint[];
  target: { lon: number; lat: number; name: string; kind: ShelterKind } | null;
  /** 目標到着時刻 [秒]（到達不能・とどまる場合は null） */
  arriveAt: number | null;
  /** 経路の総延長 [m] */
  distanceM: number;
}

export type PersonStatus =
  | 'waiting' // 避難開始前
  | 'evacuating' // 避難中（浸水なし）
  | 'safe' // 避難完了
  | 'caution' // 浸水 0.01〜閾値1
  | 'danger' // 浸水 閾値1〜閾値2（歩行困難）
  | 'critical'; // 閾値2以上（流される・生命の危険）

export interface PersonState {
  lon: number;
  lat: number;
  /** 地盤高 [m, T.P.] */
  ground: number;
  /** その地点の浸水深 [m] */
  depth: number;
  status: PersonStatus;
  /** 状態の説明（日本語） */
  message: string;
}

// ---------------------------------------------------------------------------
// アプリ状態
// ---------------------------------------------------------------------------

export type ViewMode = '2d' | '3d';
export type Basemap = 'pale' | 'std' | 'photo';

export interface LayerState {
  /** 公式ハザードマップ（重ねるハザードマップ 津波浸水想定） */
  officialHazard: boolean;
  officialHazardOpacity: number;
  /** シミュレーションの浸水（現在時刻） */
  simFlood: boolean;
  /** 最大浸水深 */
  maxDepth: boolean;
  /** 津波到達時間 */
  arrival: boolean;
  /** 避難場所 */
  shelters: boolean;
  /** 3D 建物 */
  buildings: boolean;
  /** 色別標高 */
  elevation: boolean;
}

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SimStatus = 'idle' | 'running' | 'done' | 'error';

export interface CursorInfo {
  lon: number;
  lat: number;
  /** 地盤高 [m, T.P.]（範囲外は null） */
  ground: number | null;
  /** 現在時刻の浸水深 [m]（未計算、または海・河川上では null） */
  depth: number | null;
  /** カーソル位置のセル種別（'sea' は海・河川） */
  kind?: 'land' | 'sea';
  /** 海・河川上での現在時刻の水深 [m]（未計算は undefined） */
  waterDepth?: number;
}

export interface AppState {
  view: ViewMode;
  basemap: Basemap;
  layers: LayerState;
  terrain: { status: LoadStatus; progress: number; grid: TerrainGrid | null; message?: string };
  /** 選択中の震度 */
  shindo: ShindoLevel;
  /** 選択中のシナリオ ID */
  scenarioId: string;
  /** 実行パラメータ（UI で編集） */
  params: SimParams;
  sim: { status: SimStatus; progress: number; output: SimOutput | null; message?: string; runId: number };
  /** 時刻（地震発生からの秒）と再生状態。speed は実時間1秒あたりのシミュレーション秒 */
  time: { t: number; playing: boolean; speed: number };
  people: Person[];
  plans: Record<string, EvacPlan>;
  selectedPersonId: string | null;
  /** 地図クリックで人物を置くモード */
  placing: PersonKind | null;
  shelters: Shelter[];
  cursor: CursorInfo | null;
  /** 3D の鉛直強調倍率 */
  exaggeration: number;
}
