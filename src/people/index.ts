/**
 * 人物（避難者）のモデル。
 *
 * 契約:
 * - PERSON_PROFILES: 種別ごとの表示名・既定の歩行速度・既定の避難開始時間（出典は profiles.ts）
 * - planEvacuation(person, grid, shelters, output, params, official): 避難経路と到着時刻
 *   （official は AppState.officialInundation。最寄りの高台から公式の津波浸水想定の区域と周囲 OFFICIAL_ZONE_BUFFER_M を除く。
 *    読み込めていなければ除けないので、高台の名前に「公式の浸水想定区域の外かは未確認」と示す）
 * - personStateAt(person, plan, grid, output, t): 時刻 t の位置・浸水深・状態
 *   （地盤高が不明なとき ground は NaN。浸水深は計算結果がなければ 0）
 * - DEPTH_THRESHOLDS: 状態判定に使う浸水深の区分（説明文・出典 URL つき）
 * - personStatusLabel(person, status): 状態の表示名（「その場にとどまる」人は「避難開始前」でなく STAY_STATUS_LABEL）
 * - personTimeline(person, plan, grid, output, stepSec): グラフ用の時系列
 *
 * いずれもモデルによる概算であり、公的な避難計画や被害予測ではない。
 */
export {
  PERSON_PROFILES,
  DEFAULT_START_DELAY_MIN,
  START_DELAY_PRESETS,
  DEPTH_THRESHOLDS,
  DEPTH_CAUTION_M,
  DEPTH_DANGER_M,
  DEPTH_CRITICAL_M,
  PERSON_STATUS_INFO,
  STAY_STATUS_LABEL,
  STAY_STATUS_DESCRIPTION,
  personStatusLabel,
  classifyDepth,
  FDMA_GUIDELINE_URL,
  FDMA_GUIDELINE_LABEL,
  CAO_NANKAI_METHOD_URL,
  CAO_NANKAI_METHOD_LABEL,
  CAO_NANKAI_2019_URL,
  MLIT_DEPTH_WALKING_URL,
  BARRIER_FREE_SLOPE_URL,
} from './profiles';
export type { PersonProfile, MobilityClass, DepthThreshold, DepthStatus } from './profiles';
export { planEvacuation, personSpeed, departureSec, simCoversMainWave, FALLBACK_SEARCH_M } from './plan';
export {
  personStateAt,
  personTimeline,
  positionAt,
  depthAtPosition,
  criticalEncounter,
  formatElapsed,
  formatDepth,
} from './state';
export type { TimelinePoint, PositionInfo, CriticalHit } from './state';
export { MAX_WATER_CROSSING_M, SAFE_BUFFER_M, OFFICIAL_ZONE_BUFFER_M, HIGHGROUND_MARGIN_M, MIN_START_LAND_AREA_M2 } from './gridctx';
export { WALK_COST, WHEELCHAIR_COST, WATER_CROSS_FACTOR } from './pathfind';
