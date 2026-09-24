/**
 * 計算結果の「どの条件で・どの地形の上で・どこまで」計算したものかの判定。
 *
 * 画面のすべての部品（結果の要約・人物の判定・HUD・タイムライン・2D/3D の描画）が同じ判断をするよう、
 * 判定はここに集める。とくに次の 3 点は、計算の状態（sim.status）ではなく結果そのものと
 * 計算開始時の記録（sim.run）から判断する。
 *
 * 1. 完了か（outputComplete / resultCoverage）: 中止・失敗の後も途中までの結果が残る。
 *    途中の結果を完了した結果のように見せない（「浸水しない」と誤って示さない）。
 * 2. 今の地形の上の結果か（usableOutput / isOutputCurrent）: 結果は計算に使った地形の格子（オブジェクト）に
 *    結びついている。解像度の変更や、簡易地形から実際の地形への読み込み直しの後は、前の結果を今の地形の結果として描かない。
 * 3. どの条件の結果か（resultParams / resultShindo / isResultStale）: 震度・シナリオ・条件を変えても、
 *    表示中の結果（浸水・水位）は前の条件のまま。警報・揺れ・目印などは表示中の結果の条件で示し、
 *    条件が変わったことは別に知らせる。
 */
import { formatSpan } from './format';
import type { AppState, QuakeScenario, ShindoLevel, SimOutput, SimParams } from './types';

/** 浸水ありとみなす深さ [m]（計算の到達判定と同じ 1 cm） */
export const ARRIVAL_DEPTH_M = 0.01;

type SimView = Pick<AppState, 'sim' | 'terrain'>;

function safeNumber(fn: () => number, fallback: number): number {
  try {
    const v = fn();
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 1. 完了か・どこまで計算したか
// ---------------------------------------------------------------------------

/**
 * 計算が最後まで終わった結果か。
 * sim の実装（SimRunOutput）は complete（最後の集計まで受け取ったら true）を持つので、それを優先する。
 * 持たない場合は、受信済みの時刻が計算終了時刻に達しているかで判断する。
 */
export function outputComplete(out: SimOutput | null | undefined): boolean {
  if (!out) return false;
  const flag = (out as { complete?: unknown }).complete;
  if (typeof flag === 'boolean') return flag;
  const frames = safeNumber(() => out.framesReady(), 0);
  return frames > 0 && safeNumber(() => out.timeReady(), 0) >= out.durationSec - 1e-6;
}

/** 受信済みの最終時刻 [秒]（0〜durationSec） */
export function outputTimeReady(out: SimOutput): number {
  const t = safeNumber(() => out.timeReady(), 0);
  return Math.max(0, Math.min(out.durationSec, t));
}

/**
 * 結果の状態。
 * - complete: 最後まで計算した
 * - running: 計算中（途中まで）
 * - cancelled: 中止した（途中まで）
 * - error: 途中で失敗した（途中まで）
 */
export type ResultState = 'complete' | 'running' | 'cancelled' | 'error';

export interface ResultCoverage {
  state: ResultState;
  complete: boolean;
  /** 計算済みの最終時刻 [秒]（結果はこの時刻まで。完了なら durationSec） */
  until: number;
  /** 計算するはずだった時間 [秒] */
  durationSec: number;
}

/** 表示中の結果がどこまで計算されたものか（表示できる結果が無ければ null） */
export function resultCoverage(s: SimView): ResultCoverage | null {
  const out = usableOutput(s);
  if (!out) return null;
  return coverageOf(out, s.sim.status);
}

/** 結果と計算の状態から、どこまで計算されたものかを求める */
export function coverageOf(out: SimOutput, status: AppState['sim']['status']): ResultCoverage {
  const complete = outputComplete(out);
  const durationSec = out.durationSec;
  const until = complete ? durationSec : outputTimeReady(out);
  const state: ResultState = complete ? 'complete' : status === 'running' ? 'running' : status === 'error' ? 'error' : 'cancelled';
  return { state, complete, until, durationSec };
}

/**
 * 途中までの結果の範囲の短い表記（完了なら空文字）。
 * 例: 「0〜9分20秒のみ計算（中止）」「0〜12分まで計算済み（計算中）」「0〜5分のみ計算（エラーで停止）」
 */
export function partialRangeLabel(cov: ResultCoverage | null): string {
  if (!cov || cov.complete) return '';
  const span = formatSpan(cov.until);
  switch (cov.state) {
    case 'running':
      return `0〜${span}まで計算済み（計算中）`;
    case 'error':
      return `0〜${span}のみ計算（エラーで停止）`;
    default:
      return `0〜${span}のみ計算（中止）`;
  }
}

/**
 * 途中までの結果であることの説明文（完了なら空文字）。「浸水しない」という意味ではないことを添える。
 */
export function partialExplanation(cov: ResultCoverage | null): string {
  if (!cov || cov.complete) return '';
  const span = formatSpan(cov.until);
  if (cov.state === 'running') return `計算中です。表示中の結果は地震発生から${span}までです。`;
  const why = cov.state === 'error' ? '計算が途中で止まった' : '計算を中止した';
  return `${why}ため、結果は地震発生から${span}までです。それより後の浸水は計算していません（浸水しないという意味ではありません）。`;
}

// ---------------------------------------------------------------------------
// 2. 今の地形の上の結果か
// ---------------------------------------------------------------------------

/**
 * 計算結果が今の地形の格子の上で計算されたものか。
 * 格子の形（GridSpec）が同じでも、読み込み直した地形（例: 簡易地形 → 国土地理院の標高データ）は別のオブジェクトなので、
 * 前の地形の結果は「今の結果」とはみなさない。
 */
export function isOutputCurrent(s: SimView): boolean {
  const out = s.sim.output;
  const grid = s.terrain.grid;
  if (!out || !grid) return false;
  return !!s.sim.run && s.sim.run.grid === grid;
}

/**
 * 表示に使える計算結果（今の地形の上の結果だけ。それ以外は null）。
 * 2D/3D の描画・人物の判定・結果の要約は、sim.output を直接使わずにこれを使うこと。
 */
export function usableOutput(s: SimView): SimOutput | null {
  return isOutputCurrent(s) ? s.sim.output : null;
}

// ---------------------------------------------------------------------------
// 3. どの条件の結果か
// ---------------------------------------------------------------------------

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  return false;
}

function scenariosEqual(a: QuakeScenario, b: QuakeScenario): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof QuakeScenario>;
  for (const k of keys) if (!valuesEqual(a[k], b[k])) return false;
  return true;
}

/** 計算の条件が同じか（値で比べる。同じシナリオを選び直しただけなら同じ） */
export function paramsEqual(a: SimParams, b: SimParams): boolean {
  if (a === b) return true;
  return (
    valuesEqual(a.tideTP, b.tideTP) &&
    valuesEqual(a.durationMin, b.durationMin) &&
    a.resolution === b.resolution &&
    valuesEqual(a.landManning, b.landManning) &&
    scenariosEqual(a.scenario, b.scenario)
  );
}

/** 表示中（または計算中）の結果があるか: そのときの警報・揺れ・目印は計算開始時の条件で示す */
function showsRun(s: Pick<AppState, 'sim' | 'terrain'>): boolean {
  return !!s.sim.run && (s.sim.status === 'running' || usableOutput(s) !== null);
}

/**
 * 表示中の結果の条件（結果が無ければ、いま選ばれている条件）。
 * HUD の警報・揺れ、タイムラインの目印、人物の避難計画は、地図の浸水と同じ条件で示すためにこれを使う。
 */
export function resultParams(s: Pick<AppState, 'sim' | 'terrain' | 'params'>): SimParams {
  return showsRun(s) ? s.sim.run!.params : s.params;
}

/**
 * 表示中の結果について示す震度。条件（シナリオ・値）が同じなら、いま選ばれている震度
 * （例: 震度3 と 4 は同じシナリオを使う）。条件が変わっていれば、計算開始時の震度。
 */
export function resultShindo(s: Pick<AppState, 'sim' | 'terrain' | 'params' | 'shindo'>): ShindoLevel {
  return isResultStale(s) ? s.sim.run!.shindo : s.shindo;
}

/**
 * 表示中（または計算中）の結果が、いま選ばれている条件と違う条件のものか。
 * true のときは「表示中の結果は前の条件」と知らせ、再計算を促す。
 */
export function isResultStale(s: Pick<AppState, 'sim' | 'terrain' | 'params'>): boolean {
  return showsRun(s) && !paramsEqual(s.sim.run!.params, s.params);
}

/** 表示中の結果の条件の短い名前（例: 「相模トラフ西側・震度7」） */
export function runConditionsLabel(s: Pick<AppState, 'sim'>, shindoLabel: (lv: ShindoLevel) => string): string {
  const run = s.sim.run;
  if (!run) return '';
  const name = run.params.scenario.shortName || run.params.scenario.name;
  return `${name}・震度${shindoLabel(run.shindo)}`;
}

// ---------------------------------------------------------------------------
// 再生できる範囲
// ---------------------------------------------------------------------------

/**
 * 再生の終わりの時刻 [秒]。計算中は計算終了時刻（結果が増えていくので、届いた所まで進みながら待つ）、
 * 中止・失敗の後は受信済みの最終時刻（それより先の結果は来ない）、結果が無ければ設定の計算時間。
 */
export function playbackEnd(s: Pick<AppState, 'sim' | 'params'>): number {
  const out = s.sim.output;
  if (!out) return s.params.durationMin * 60;
  if (s.sim.status === 'running' || outputComplete(out)) return out.durationSec;
  return outputTimeReady(out);
}

/** 時刻を移動できる上限 [秒]（計算済みの範囲。結果が無ければ設定の計算時間） */
export function seekLimit(s: Pick<AppState, 'sim' | 'params'>): number {
  const out = s.sim.output;
  if (!out) return s.params.durationMin * 60;
  return outputComplete(out) ? out.durationSec : outputTimeReady(out);
}

// ---------------------------------------------------------------------------
// 途中で止まった結果の仕上げ
// ---------------------------------------------------------------------------

/** フレーム間（線形補間。SimOutput の depthAt と同じ）で浸水深が wet に達する時刻 */
function crossingTime(t0: number, d0: number, t1: number, d1: number, wet: number): number {
  if (!(d0 < wet)) return t0;
  if (!(d1 > d0)) return t1;
  const f = (wet - d0) / (d1 - d0);
  return t0 + (t1 - t0) * Math.max(0, Math.min(1, f));
}

/** フレームの浸水深で「浸水あり」とする深さ（フレームは cm 単位。計算側の到達判定と同じ 1 cm） */
const FRAME_WET_M = ARRIVAL_DEPTH_M - 1e-6;

/**
 * 途中で止まった（中止・失敗）結果の最大浸水深・浸水開始時刻を、受信済みの最後のフレームの時刻までそろえる。
 *
 * 計算側の最大値・到達時刻の集計（maxDepth / arrival）は数フレームおきにしか届かないため、止まった時点では
 * 受信済みのフレーム（浸水深の分布）より数分遅れていることがある。そのままでは「0〜9分の結果」と示しながら
 * 最後の数分に浸水し始めた場所を「浸水なし」と扱ってしまうので、受信済みのフレームから補う。
 * 補った部分の到達時刻は、地図の表示（フレーム間の線形補間）で浸水深が 1 cm に達する時刻。
 * 初期に水があるセル（海・川。フレーム 0 で水深あり）は対象外（計算側と同じ）。
 *
 * 配列（maxDepth・arrival）はその場で書き換え、変わったら revision（あれば）を進める。変わったら true。
 */
export function extendStatsToFrames(out: SimOutput): boolean {
  const nf = safeNumber(() => out.framesReady(), 0);
  if (nf < 2) return false;
  const n = out.spec.nx * out.spec.ny;
  const { maxDepth, arrival } = out;
  if (maxDepth.length !== n || arrival.length !== n) return false;
  const initial = new Float32Array(n);
  out.fillDepth(0, initial);
  let prev = Float32Array.from(initial);
  let cur = new Float32Array(n);
  const fi = out.frameInterval;
  let changed = false;
  for (let i = 1; i < nf; i++) {
    const t = i * fi;
    out.fillDepth(t, cur);
    for (let k = 0; k < n; k++) {
      if (initial[k] > 0) continue;
      const d = cur[k];
      if (!(d > 0)) continue;
      if (d > maxDepth[k]) {
        maxDepth[k] = d;
        changed = true;
      }
      if (d >= FRAME_WET_M && !(arrival[k] <= t)) {
        const ta = crossingTime(t - fi, prev[k], t, d, FRAME_WET_M);
        if (!(arrival[k] <= ta)) {
          arrival[k] = ta;
          changed = true;
        }
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  if (changed) {
    const o = out as { revision?: unknown };
    if (typeof o.revision === 'number') o.revision = o.revision + 1;
  }
  return changed;
}

/**
 * セル k の浸水開始時刻 [秒]（初期に乾燥していたセル。未浸水は +Infinity）。
 * 計算中は計算側の集計（arrival）が受信済みのフレームより遅れていることがあるので、フレームからも調べて早い方を返す。
 */
export function cellArrival(out: SimOutput, k: number): number {
  const n = out.spec.nx * out.spec.ny;
  if (!(k >= 0 && k < n)) return Infinity;
  const a = out.arrival[k];
  const fromStats = Number.isFinite(a) ? a : Infinity;
  if (outputComplete(out)) return fromStats;
  if (safeNumber(() => out.depthAt(0, k), 0) > 0) return fromStats;
  const nf = safeNumber(() => out.framesReady(), 0);
  const fi = out.frameInterval;
  let dPrev = 0;
  for (let i = 1; i < nf; i++) {
    const t = i * fi;
    if (t - fi >= fromStats) break;
    const d = safeNumber(() => out.depthAt(t, k), 0);
    if (d >= FRAME_WET_M) return Math.min(fromStats, crossingTime(t - fi, dPrev, t, d, FRAME_WET_M));
    dPrev = d;
  }
  return fromStats;
}
