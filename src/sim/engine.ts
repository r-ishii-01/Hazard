/**
 * 津波浸水計算の実行手順（校正の試算 → 本計算 → フレームの逐次出力）。
 * DOM・Worker に依存しない純粋な TypeScript なので、テスト（Node）からも直接呼べる。
 *
 * 手順:
 * 1. 初期状態（潮位で静止した海、乾燥した陸）をフレーム 0 として出力。
 * 2. 校正（モデル上の調整）: 沖側境界から入れる波の振幅 A を、鵠沼海岸の区間の最大水位
 *    （各セルの最大水位の 90 パーセンタイル）が目標 coastHeight になるよう試算で決める。
 *    約 62 m の粗い格子で1回試算して増幅率の見当をつけ、約 31 m の格子で1〜2回試算して補正する
 *    （比例補正 → べき乗則 a = k·A^p の当てはめ）。
 *    第1波の山が海岸に届くまでの時間も最後の試算から測り、到達時間 arrivalMin に山が届くよう
 *    境界での入力開始時刻をずらす（海底地形からの伝播時間 ∫ds/√(gh) は試算時間の見積もりと予備に使う）。
 * 3. 本計算: 指定解像度の格子で計算し、frameInterval 秒ごとに全水深（cm, Uint16）を出力。
 *    初期状態では、海と、潮位より低く海とつながる土地（潮間帯）を潮位で静止した水域とし、それ以外の陸は乾燥とする。
 *    波が境界に入る前の海は厳密に静止しているので、その間は計算せずフレーム 0 と同じとする。
 *
 * 注意: 境界から入れる波は正弦波列による単純化したモデルで、公式の津波浸水想定の再現・予測ではない。
 */
import type { GridSpec } from '../core/geo';
import { CELL_SEA, type SimParams } from '../core/types';
import { ShallowWaterSolver, initialWaterMask, maxStillDepth, sideBoundaryProfile, stableTimeStep, type SideProfile, type SolverGrid } from './solver';
import { partitionRows, rowWorkWeights, type BandSpec, type WetMap } from './band';
import { firstCrestOffset, makeIncidentWave, type IncidentWaveSpec } from './wave';
import { coastSegment, decimateGrid, findGaugeCell, openSeaMask, percentile, travelTimeToSegment } from './site';
import { UNSTABLE_MESSAGE, progressMessage } from './common';
export { UNSTABLE_MESSAGE, progressMessage } from './common';

export interface EngineInput {
  spec: GridSpec;
  z: Float32Array;
  kind: Uint8Array;
  manning: Float32Array;
  params: SimParams;
}

export interface EngineStartInfo {
  frameInterval: number;
  durationSec: number;
  /** 最後のフレームの番号（フレームは 0..lastFrame） */
  lastFrame: number;
  tide: number;
  gauge: { lon: number; lat: number; cell: number; interval: number; capacity: number };
  /** 校正区間のセル数と選び方 */
  segment: { cells: number; rule: string };
}

export interface CalibrationInfo {
  targetCoastHeight: number;
  boundaryAmplitude: number;
  /** 境界で波の入力を始める時刻 [秒] */
  boundaryStartSec: number;
  /** 第1波の山が海岸に届く見込みの時刻 [秒] */
  expectedCrestSec: number;
  /** 試算の記録（振幅 [m]、得られた海岸の最大水位 [m, T.P.]、試算に使った格子のセル辺長 [m]） */
  trials: { amplitude: number; achieved: number; cellM: number }[];
  /** 利用者向けの注記（日本語） */
  notes: string[];
}

export interface StatsSnapshot {
  maxDepth: Float32Array;
  maxEta: Float32Array;
  arrival: Float32Array;
  achievedCoastMax: number;
  final: boolean;
}

export interface EnginePerf {
  steps: number;
  dt: number;
  activeCells: number;
  mainMs: number;
  calibrationMs: number;
  stepsPerSec: number;
  /** 本計算を分けた帯（ワーカー）の数 */
  bands: number;
  /** 並列計算で隣の帯を待った時間 [ms]（帯ごと。逐次計算では省略） */
  waitMs?: number;
  /** 帯ごとの記録（並列計算のみ） */
  perBand?: { activeCells: number; mainMs: number; waitMs: number }[];
}

export interface EngineSink {
  start(info: EngineStartInfo): void;
  /** data が null のときはフレーム 0 と同じ（静止状態） */
  frame(index: number, data: Uint16Array | null, gaugeT: number[], gaugeEta: number[]): void;
  calibrated(info: CalibrationInfo): void;
  stats(s: StatsSnapshot): void;
  progress(p: number, message: string): void;
}

export interface EngineOptions {
  /** 何フレームごとに最大値などのスナップショットを送るか */
  statsEveryFrames?: number;
  now?: () => number;
  /** 校正の試算の最大回数 */
  maxTrials?: number;
  /** 本計算を分ける行の帯の数（並列計算。prepareRun のみ） */
  bands?: number;
}

/** 校正の試算に使う格子の目安のセル辺長 [m] */
const CALIBRATION_CELL_M = 31;
/** 潮位計の記録間隔の目安 [秒] */
const GAUGE_INTERVAL_TARGET = 10;
/** 目標との差がこの割合以内なら校正を打ち切る */
const CALIBRATION_TOLERANCE = 0.04;

export function frameIntervalFor(resolution: SimParams['resolution']): number {
  return resolution === 'fine' ? 30 : 20;
}

/** 本計算の条件（校正の結果を含む）。並列計算では各帯のワーカーへそのまま渡す */
export interface MainPlan {
  frameInterval: number;
  durationSec: number;
  lastFrame: number;
  gaugeDiv: number;
  gaugeInterval: number;
  stepsPerFrame: number;
  dt: number;
  /** ここまでのフレームは静止（フレーム 0 と同じ）。本計算はこの次のフレームから */
  startFrame: number;
  tide: number;
  landManning: number;
  incident: IncidentWaveSpec | null;
  gaugeCell: number;
  /** 校正区間のセル（海岸の最大水位の評価に使う） */
  segmentCells: Int32Array;
  statsEveryFrames: number;
  /** 東西端の入射条件（全体の格子の行ごと） */
  sides: { west: SideProfile; east: SideProfile };
  /** 初期に水のあるセル（全体の格子） */
  initialWater: Uint8Array;
  /** 行の帯（並列計算）。1つなら逐次計算 */
  bands: BandSpec[];
  calibrationMs: number;
}

export interface PreparedRun {
  plan: MainPlan;
  /** 全体の格子の初期状態のソルバ（逐次計算ではそのまま本計算に使う） */
  solver: ShallowWaterSolver;
}

/**
 * 準備: 開始情報・フレーム 0・校正・静止区間のフレーム・最大値の初期値を sink に出し、本計算の条件を返す。
 * opts.bands（>1）を指定すると、本計算を行の帯に分ける分割も求める。
 */
export function prepareRun(input: EngineInput, sink: EngineSink, opts: EngineOptions = {}): PreparedRun {
  const now = opts.now ?? (() => performance.now());
  const { spec, params } = input;
  const { nx, ny } = spec;
  const n = nx * ny;
  if (input.z.length !== n || input.kind.length !== n || input.manning.length !== n) {
    throw new Error('地形データの大きさが計算格子と一致しません');
  }
  const sc = params.scenario;
  const tide = Number.isFinite(params.tideTP) ? params.tideTP : 0;
  const frameInterval = frameIntervalFor(params.resolution);
  const wantedSec = Math.max(60, (Number.isFinite(params.durationMin) ? params.durationMin : 60) * 60);
  const lastFrame = Math.ceil(wantedSec / frameInterval - 1e-9);
  // 計算終了時刻は最後のフレームの時刻（指定がフレーム間隔の倍数でなければ切り上げる）
  const durationSec = lastFrame * frameInterval;
  const gaugeDiv = Math.max(1, Math.round(frameInterval / GAUGE_INTERVAL_TARGET));
  const gaugeInterval = frameInterval / gaugeDiv;
  const landManning = params.landManning > 0 ? params.landManning : 0.025;

  const grid: SolverGrid & { spec: GridSpec } = { spec, nx, ny, dx: spec.dx, z: input.z, kind: input.kind, manning: input.manning };
  const open = openSeaMask(grid, tide);
  const segment = coastSegment(grid, tide, open);
  const gauge = findGaugeCell(grid, tide, open);

  sink.start({
    frameInterval,
    durationSec,
    lastFrame,
    tide,
    gauge: { lon: gauge.lon, lat: gauge.lat, cell: gauge.k, interval: gaugeInterval, capacity: lastFrame * gaugeDiv + 1 },
    segment: { cells: segment.cells.length, rule: segment.rule },
  });

  // ---- フレーム 0（初期状態）----
  const initialWater = initialWaterMask(grid, tide);
  const frame0 = new Uint16Array(n);
  for (let k = 0; k < n; k++) {
    const d = initialWater[k] === 1 ? tide - input.z[k] : 0;
    frame0[k] = d > 0.005 ? Math.min(65535, Math.round(d * 100)) : 0;
  }
  const eta0 = gaugeEta0(input, gauge.k, tide);
  sink.frame(0, frame0, [0], [eta0]);
  sink.progress(0.01, '計算の準備をしています…');

  // ---- 校正 ----
  const t0 = now();
  const target = sc.coastHeight - tide;
  const noWave = !(target > 0.05);
  const periodSec = Math.max(60, (sc.periodMin > 0 ? sc.periodMin : 10) * 60);
  const waves = Math.max(1, Math.round(sc.waves > 0 ? sc.waves : 1));
  const arrivalSec = Math.max(0, (Number.isFinite(sc.arrivalMin) ? sc.arrivalMin : 0) * 60);
  let cal: CalibrationInfo;
  let wet: WetMap | null = null;
  if (noWave) {
    cal = {
      targetCoastHeight: sc.coastHeight,
      boundaryAmplitude: 0,
      boundaryStartSec: 0,
      expectedCrestSec: NaN,
      trials: [],
      notes: ['想定する津波の高さが潮位とほぼ同じか低いため、津波は入力していません（潮位のみの静かな海）。'],
    };
  } else {
    ({ info: cal, wet } = calibrate(input, tide, landManning, periodSec, waves, arrivalSec, opts.maxTrials ?? 3, (p, msg) =>
      sink.progress(0.01 + 0.19 * p, msg),
    ));
  }
  const calibrationMs = now() - t0;
  if (!noWave && cal.expectedCrestSec > durationSec) {
    cal.notes.push('計算時間内に第1波は海岸に届きません。計算時間を長くしてください。');
  }
  sink.calibrated(cal);

  // ---- 本計算の条件 ----
  const hMax = maxStillDepth(grid, tide);
  const dtCfl = stableTimeStep(spec.dx, hMax, noWave ? 0 : Math.max(2 * cal.boundaryAmplitude, 0.5));
  const stepsPerFrame = Math.ceil(frameInterval / dtCfl / gaugeDiv) * gaugeDiv;
  const dt = frameInterval / stepsPerFrame;
  const incident: IncidentWaveSpec | null = noWave
    ? null
    : { amplitude: cal.boundaryAmplitude, periodSec, waves, firstMotion: sc.firstMotion, startSec: cal.boundaryStartSec };
  const sides = { west: sideBoundaryProfile(grid, tide, false), east: sideBoundaryProfile(grid, tide, true) };
  const solver = new ShallowWaterSolver(grid, {
    tide,
    landManning,
    dt,
    incident: incident ? makeIncidentWave(incident) : null,
    sides,
    initialWater,
  });

  // 波が入る前の静止状態は計算しない（静水は厳密に保たれるため結果は同じ）
  let startFrame = 0;
  if (solver.isAtRest()) {
    startFrame = noWave ? lastFrame : Math.min(lastFrame, Math.floor(cal.boundaryStartSec / frameInterval));
  }
  for (let f = 1; f <= startFrame; f++) {
    const gt: number[] = [];
    const ge: number[] = [];
    for (let g = 1; g <= gaugeDiv; g++) {
      gt.push((f - 1) * frameInterval + g * gaugeInterval);
      ge.push(eta0);
    }
    sink.frame(f, null, gt, ge);
  }
  solver.t = startFrame * frameInterval;
  const statsEveryFrames = Math.max(1, opts.statsEveryFrames ?? 10);
  sink.stats(snapshotStats(solver, segment.cells, tide, startFrame >= lastFrame));

  const plan: MainPlan = {
    frameInterval,
    durationSec,
    lastFrame,
    gaugeDiv,
    gaugeInterval,
    stepsPerFrame,
    dt,
    startFrame,
    tide,
    landManning,
    incident,
    gaugeCell: gauge.k,
    segmentCells: segment.cells,
    statsEveryFrames,
    sides,
    initialWater,
    bands: [],
    calibrationMs,
  };
  const wanted = startFrame >= lastFrame ? 1 : Math.max(1, Math.floor(opts.bands ?? 1));
  plan.bands = partitionRows(ny, rowWorkWeights(grid, tide, Math.max(sc.coastHeight, tide), wet), wanted);
  return { plan, solver };
}

/** 全体の格子の最大値などのスナップショット */
function snapshotStats(solver: ShallowWaterSolver, segmentCells: ArrayLike<number>, tide: number, final: boolean): StatsSnapshot {
  const n = solver.n;
  const s: StatsSnapshot = {
    maxDepth: new Float32Array(n),
    maxEta: new Float32Array(n),
    arrival: new Float32Array(n),
    achievedCoastMax: coastMax(solver, segmentCells, tide),
    final,
  };
  solver.copyMaxDepth(s.maxDepth);
  solver.copyMaxEta(s.maxEta);
  solver.copyArrival(s.arrival);
  return s;
}

/** 本計算（逐次）。prepareRun の結果を使い、フレームを sink に逐次渡す */
export function runSerialMain(prep: PreparedRun, sink: EngineSink, opts: EngineOptions = {}): EnginePerf {
  const now = opts.now ?? (() => performance.now());
  const { plan, solver } = prep;
  const { frameInterval, lastFrame, startFrame, stepsPerFrame, gaugeDiv, gaugeInterval, statsEveryFrames } = plan;
  const stepsPerGauge = stepsPerFrame / gaugeDiv;
  const n = solver.n;
  const tMain = now();
  const mainSpan = Math.max(1, lastFrame - startFrame);
  for (let f = startFrame + 1; f <= lastFrame; f++) {
    const gt: number[] = [];
    const ge: number[] = [];
    const tFrame0 = (f - 1) * frameInterval;
    for (let s = 1; s <= stepsPerFrame; s++) {
      solver.step();
      if (s % stepsPerGauge === 0) {
        gt.push(tFrame0 + (s / stepsPerGauge) * gaugeInterval);
        ge.push(solver.eta[plan.gaugeCell]);
      }
    }
    solver.t = f * frameInterval; // 丸め誤差の蓄積を防ぐ
    const data = new Uint16Array(n);
    if (!solver.encodeDepthCm(data)) throw new Error(UNSTABLE_MESSAGE);
    sink.frame(f, data, gt, ge);
    if (f % statsEveryFrames === 0 || f === lastFrame) sink.stats(snapshotStats(solver, plan.segmentCells, plan.tide, f === lastFrame));
    sink.progress(0.2 + (0.8 * (f - startFrame)) / mainSpan, progressMessage(f * frameInterval, 1));
  }
  const mainMs = now() - tMain;
  return {
    steps: solver.steps,
    dt: plan.dt,
    activeCells: solver.activeCells(),
    mainMs,
    calibrationMs: plan.calibrationMs,
    stepsPerSec: solver.steps > 0 && mainMs > 0 ? solver.steps / (mainMs / 1000) : 0,
    bands: 1,
  };
}

/** 計算を最後まで逐次で実行する（同期）。進捗・フレームは sink に逐次渡す */
export function runEngine(input: EngineInput, sink: EngineSink, opts: EngineOptions = {}): EnginePerf {
  const prep = prepareRun(input, sink, { ...opts, bands: 1 });
  return runSerialMain(prep, sink, opts);
}

/** 校正区間の到達最大水位（各セルの最大水位の 90 パーセンタイル）[m, T.P.] */
export function coastMax(solver: ShallowWaterSolver, cells: ArrayLike<number>, tide: number): number {
  const v = new Float64Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const m = solver.maxEta[cells[i]];
    v[i] = m === -Infinity ? NaN : m;
  }
  const p = percentile(v, 90);
  return Number.isFinite(p) ? p : tide;
}

function gaugeEta0(input: EngineInput, k: number, tide: number): number {
  return input.kind[k] === CELL_SEA && input.z[k] < tide ? tide : input.z[k];
}

// ---------------------------------------------------------------------------
// 校正
// ---------------------------------------------------------------------------

interface TrialResult {
  /** 試算で一度でも濡れたセル（試算の格子） */
  wet: Uint8Array;
  achieved: number;
  /** 入力開始から第1波の山が海岸に届くまでの時間 [秒]（求まらなければ NaN） */
  crestDelay: number;
}

interface TrialGrid {
  spec: GridSpec;
  grid: SolverGrid;
  seg: Int32Array;
  hMax: number;
  /** 1回の試算の相対的な計算量（セル数 / 時間刻み） */
  cost: number;
}

function trialGrid(input: EngineInput, tide: number, factor: number): TrialGrid | null {
  const src = { spec: input.spec, z: input.z, kind: input.kind, manning: input.manning };
  const g = factor > 1 ? decimateGrid(src, factor) : src;
  if (g.spec.nx < 16 || g.spec.ny < 16) return null;
  const grid: SolverGrid = { nx: g.spec.nx, ny: g.spec.ny, dx: g.spec.dx, z: g.z, kind: g.kind, manning: g.manning };
  const seg = coastSegment(g, tide, openSeaMask(g, tide)).cells;
  const hMax = maxStillDepth(grid, tide);
  return { spec: g.spec, grid, seg, hMax, cost: (grid.nx * grid.ny) / grid.dx };
}

function calibrate(
  input: EngineInput,
  tide: number,
  landManning: number,
  periodSec: number,
  waves: number,
  arrivalSec: number,
  maxTrials: number,
  progress: (p: number, msg: string) => void,
): { info: CalibrationInfo; wet: WetMap | null } {
  const sc = input.params.scenario;
  const target = sc.coastHeight - tide;
  const notes: string[] = [];
  // 試算は約 31 m 格子で行う。最初の1回だけさらに粗い約 62 m 格子で増幅率の見当をつける（計算量は約 1/8）
  const factor = Math.max(1, Math.round(CALIBRATION_CELL_M / input.spec.dx));
  const main = trialGrid(input, tide, factor);
  const quick = maxTrials >= 3 ? trialGrid(input, tide, factor * 2) : null;
  const crestOffset = firstCrestOffset({ periodSec, firstMotion: sc.firstMotion });
  let travel = main ? travelTimeToSegment({ spec: main.spec, z: main.grid.z, kind: main.grid.kind }, tide, main.seg) : NaN;
  if (!Number.isFinite(travel)) travel = travelTimeToSegment(input, tide, coastSegment(input, tide).cells);
  if (!Number.isFinite(travel)) travel = 0;

  // 沖側境界の代表水深（振幅の上限の目安）
  const hSouth: number[] = [];
  const { nx, ny } = input.spec;
  for (let i = 0; i < nx; i++) {
    const k = (ny - 1) * nx + i;
    if (input.kind[k] === CELL_SEA && tide - input.z[k] > 0.1) hSouth.push(tide - input.z[k]);
  }
  const hB = hSouth.length ? percentile(hSouth, 50) : 10;
  const aMax = Math.max(0.1, 0.8 * hB);

  if (!main || main.seg.length === 0 || hSouth.length === 0) {
    notes.push('海岸線または沖側の開境界が見つからないため、振幅の自動調整を行っていません。');
    const A = Math.min(aMax, target);
    const start = Math.max(0, arrivalSec - crestOffset - travel);
    const info: CalibrationInfo = {
      targetCoastHeight: sc.coastHeight,
      boundaryAmplitude: A,
      boundaryStartSec: start,
      expectedCrestSec: start + crestOffset + travel,
      trials: [],
      notes,
    };
    return { info, wet: null };
  }

  // 試算の計算時間: 第1波の山が届くまで + 1.5 周期（第2波の山まで。ただし最大 3 時間）
  const horizon = Math.min(3 * 3600, crestOffset + travel + 1.5 * periodSec);
  const plan: TrialGrid[] = [];
  if (quick && quick.seg.length > 0) plan.push(quick);
  while (plan.length < Math.max(1, maxTrials)) plan.push(main);
  const totalCost = plan.reduce((a, g) => a + g.cost, 0);
  let doneCost = 0;

  const trials: CalibrationInfo['trials'] = [];
  const mainTrials: { amplitude: number; achieved: number }[] = [];
  let A = Math.min(aMax, Math.max(0.05, 0.5 * target));
  let last: TrialResult | null = null;
  let converged = false;
  for (let it = 0; it < plan.length; it++) {
    const tg = plan[it];
    const label = `沖合の波の高さを調整中…（試算 ${it + 1}/${plan.length}）`;
    progress(doneCost / totalCost, label);
    const res = trialRun(tg.grid, tg.seg, tide, landManning, tg.hMax, A, periodSec, waves, sc.firstMotion, horizon, (p) =>
      progress((doneCost + p * tg.cost) / totalCost, label),
    );
    doneCost += tg.cost;
    trials.push({ amplitude: A, achieved: res.achieved, cellM: Math.round(tg.grid.dx * 10) / 10 });
    if (tg !== main) {
      // 粗い試算は比例補正の見当づけにだけ使う
      const a = res.achieved - tide;
      if (a > 0.01) A = Math.min(aMax, Math.max(0.01, A * (target / a)));
      continue;
    }
    last = res;
    mainTrials.push({ amplitude: A, achieved: res.achieved });
    if (Math.abs(res.achieved - tide - target) <= CALIBRATION_TOLERANCE * target) {
      converged = true;
      break;
    }
    // 次の試算（最後の試算の後は採用値）の振幅
    const next = Math.min(aMax, Math.max(0.01, nextAmplitude(mainTrials, tide, target, A)));
    // 上限で頭打ちになり、同じ振幅をもう一度試すだけになる場合は打ち切る
    const same = Math.abs(next - A) <= 1e-6 * A;
    A = next;
    if (same) break;
  }
  progress(1, '沖合の波の高さを決定しました');
  if (!converged) {
    notes.push('入射波の振幅は試算結果から補正した値です。実際に得られた海岸の最大水位は結果に表示されます。');
    if (A >= aMax - 1e-9) {
      notes.push('沖側境界の水深に対して必要な波が大きすぎるため、振幅を制限しました（目標の高さに届かない場合があります）。');
    }
  }

  // 第1波の山が海岸に届くまでの時間は最後の試算（約 31 m 格子）から測る。
  // 振幅の補正による非線形効果（波速の変化）はわずかなので無視する。
  const measured = last && Number.isFinite(last.crestDelay) ? last.crestDelay : NaN;
  const crestDelay = Math.max(0, Number.isFinite(measured) ? measured : crestOffset + travel);
  let start = arrivalSec - crestDelay;
  if (start < 0) {
    notes.push(
      `設定した到達時間（${fmtMin(arrivalSec)}）は、計算領域の沖側境界から海岸までの伝播時間などより短いため、` +
        `第1波の山の到達は約${fmtMin(crestDelay)}になります。`,
    );
    start = 0;
  }
  const info: CalibrationInfo = {
    targetCoastHeight: sc.coastHeight,
    boundaryAmplitude: A,
    boundaryStartSec: start,
    expectedCrestSec: start + crestDelay,
    trials,
    notes,
  };
  return { info, wet: last ? { mask: last.wet, nx: main.grid.nx, ny: main.grid.ny, factor } : null };
}

/** 次に試す振幅: 1回目は比例補正、2回目以降は べき乗則 a = k·A^p を当てはめる */
function nextAmplitude(trials: { amplitude: number; achieved: number }[], tide: number, target: number, A: number): number {
  const last = trials[trials.length - 1];
  const a1 = last.achieved - tide;
  if (!(a1 > 0.01)) return A * 2;
  if (trials.length >= 2) {
    const prev = trials[trials.length - 2];
    const a0 = prev.achieved - tide;
    if (a0 > 0.01 && Math.abs(Math.log(last.amplitude / prev.amplitude)) > 1e-3) {
      let p = Math.log(a1 / a0) / Math.log(last.amplitude / prev.amplitude);
      if (!Number.isFinite(p)) p = 1;
      p = Math.min(1.5, Math.max(0.5, p));
      return last.amplitude * Math.pow(target / a1, 1 / p);
    }
  }
  return last.amplitude * (target / a1);
}

function trialRun(
  grid: SolverGrid,
  seg: Int32Array,
  tide: number,
  landManning: number,
  hMax: number,
  A: number,
  periodSec: number,
  waves: number,
  firstMotion: 'rise' | 'fall',
  horizon: number,
  progress: (p: number) => void,
): TrialResult {
  const dt = stableTimeStep(grid.dx, hMax, Math.max(2 * A, 0.5));
  const incident = makeIncidentWave({ amplitude: A, periodSec, waves, firstMotion, startSec: 0 });
  const solver = new ShallowWaterSolver(grid, { tide, landManning, dt, incident });
  const steps = Math.ceil(horizon / dt);
  const sampleEvery = Math.max(1, Math.round(5 / dt));
  const times: number[] = [];
  const means: number[] = [];
  const reportEvery = Math.max(1, Math.floor(steps / 20));
  for (let s = 1; s <= steps; s++) {
    solver.step();
    if (s % sampleEvery === 0) {
      let sum = 0;
      for (let i = 0; i < seg.length; i++) sum += solver.eta[seg[i]];
      if (!Number.isFinite(sum)) throw new Error(UNSTABLE_MESSAGE);
      times.push(solver.t);
      means.push(sum / seg.length - tide);
    }
    if (s % reportEvery === 0) progress(s / steps);
  }
  const wet = new Uint8Array(solver.n);
  for (let k = 0; k < solver.n; k++) wet[k] = solver.maxEta[k] !== -Infinity ? 1 : 0;
  return { wet, achieved: coastMax(solver, seg, tide), crestDelay: firstCrestTime(times, means) };
}

/** 区間平均の水位の時系列から、第1波の山の時刻を求める（最大上昇量の半分を初めて超えた後の極大） */
export function firstCrestTime(times: number[], values: number[]): number {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (!(max > 0)) return NaN;
  let i = values.findIndex((v) => v >= 0.5 * max);
  if (i < 0) return NaN;
  while (i + 1 < values.length && values[i + 1] >= values[i]) i++;
  return times[i];
}

function fmtMin(sec: number): string {
  const m = sec / 60;
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}分`;
}
