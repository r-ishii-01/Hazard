/**
 * 計算結果の「完了か・どの地形の上か・どの条件か・どこまでか」の判定（src/core/results.ts）と、
 * 途中で止まった結果の表示に関わる書式・文言。
 */
import { describe, expect, it } from 'vitest';
import { createGridSpec, type GridSpec } from '../src/core/geo';
import { formatElapsed, formatSpan } from '../src/core/format';
import {
  cellArrival,
  coverageOf,
  extendStatsToFrames,
  isOutputCurrent,
  isResultStale,
  outputComplete,
  paramsEqual,
  partialExplanation,
  partialRangeLabel,
  playbackEnd,
  resultCoverage,
  resultParams,
  resultShindo,
  runConditionsLabel,
  seekLimit,
  usableOutput,
} from '../src/core/results';
import { CELL_LAND, SHINDO_LABEL, type AppState, type SimOutput, type SimParams, type TerrainGrid } from '../src/core/types';
import { defaultParams, getScenario } from '../src/data/scenarios';
import { WARNING_INFO } from '../src/data/warnings';
import { formatElapsed as peopleFormatElapsed, personStatusLabel, STAY_STATUS_LABEL } from '../src/people';
import { getGridContext, simSafeMask } from '../src/people/gridctx';
import { formatElapsed as uiFormatElapsed } from '../src/ui/format';
import { warningCardText } from '../src/ui/hud';

// ---------------------------------------------------------------------------
// テスト用の地形・計算結果
// ---------------------------------------------------------------------------

function tinySpec(nx = 4, ny = 3): GridSpec {
  return { ...createGridSpec('coarse'), nx, ny };
}

function makeGrid(spec: GridSpec): TerrainGrid {
  const n = spec.nx * spec.ny;
  return {
    spec,
    z: new Float32Array(n).fill(2),
    kind: new Uint8Array(n).fill(CELL_LAND),
    manning: new Float32Array(n).fill(0.025),
    source: 'synthetic',
    sourceLabel: 'test',
    isApproximate: true,
    notes: [],
  };
}

interface FakeOut extends SimOutput {
  complete?: boolean;
  revision: number;
  /** 受信済みのフレーム（cm でなく m の Float32Array） */
  frames: Float32Array[];
}

/** フレーム（浸水深の分布）を与えた計算結果。maxDepth / arrival は集計が遅れている状態を再現できるよう別に与える */
function fakeOutput(spec: GridSpec, frames: Float32Array[], o: { durationSec?: number; frameInterval?: number; complete?: boolean } = {}): FakeOut {
  const n = spec.nx * spec.ny;
  const fi = o.frameInterval ?? 20;
  const out: FakeOut = {
    spec,
    frameInterval: fi,
    durationSec: o.durationSec ?? 600,
    frames,
    revision: 0,
    framesReady: () => out.frames.length,
    timeReady: () => (out.frames.length > 0 ? (out.frames.length - 1) * fi : 0),
    depthAt: (t, k) => {
      const f = Math.max(0, t / fi);
      const last = out.frames.length - 1;
      if (f >= last) return out.frames[last][k];
      const i0 = Math.floor(f);
      const a = f - i0;
      return out.frames[i0][k] * (1 - a) + out.frames[i0 + 1][k] * a;
    },
    etaAt: () => NaN,
    fillDepth: (t, dst) => {
      for (let k = 0; k < n; k++) dst[k] = out.depthAt(t, k);
    },
    maxDepth: new Float32Array(n),
    maxEta: new Float32Array(n).fill(NaN),
    arrival: new Float32Array(n).fill(Infinity),
    gauge: { t: new Float32Array(1), eta: new Float32Array(1), lon: 0, lat: 0, count: () => 0 },
    achievedCoastMax: () => 1,
    calibration: { targetCoastHeight: 5, boundaryAmplitude: 1 },
  };
  if (o.complete !== undefined) out.complete = o.complete;
  return out;
}

const scenario = getScenario('sagami-west')!;
const PARAMS: SimParams = { ...defaultParams(scenario), resolution: 'coarse' };

type SimView = Pick<AppState, 'sim' | 'terrain' | 'params' | 'shindo'>;

function stateWith(o: { output: SimOutput | null; runGrid: TerrainGrid | null; grid: TerrainGrid | null; status?: AppState['sim']['status']; params?: SimParams; runParams?: SimParams }): SimView {
  const runParams = o.runParams ?? PARAMS;
  return {
    params: o.params ?? runParams,
    shindo: '7',
    terrain: { status: o.grid ? 'ready' : 'loading', progress: 1, grid: o.grid },
    sim: {
      status: o.status ?? 'done',
      progress: 1,
      output: o.output,
      runId: 1,
      run: o.runGrid ? { params: runParams, shindo: '7', scenarioId: scenario.id, grid: o.runGrid } : null,
      queued: false,
    },
  };
}

// ---------------------------------------------------------------------------

describe('完了か・どこまで計算したか（結果そのもので判断する）', () => {
  const spec = tinySpec();
  const n = spec.nx * spec.ny;
  const zeros = () => new Float32Array(n);

  it('complete フラグを持つ結果はそれを優先し、持たなければ受信済みの時刻で判断する', () => {
    const frames = Array.from({ length: 31 }, zeros); // 0〜600 秒
    expect(outputComplete(fakeOutput(spec, frames))).toBe(true);
    // 全フレームを受信していても、最後の集計を受け取るまでは完了ではない（SimRunOutput の complete=false）
    expect(outputComplete(fakeOutput(spec, frames, { complete: false }))).toBe(false);
    expect(outputComplete(fakeOutput(spec, frames.slice(0, 10)))).toBe(false);
    expect(outputComplete(null)).toBe(false);
  });

  it('中止・失敗・計算中の途中の結果は、その範囲と状態を示す', () => {
    const out = fakeOutput(spec, Array.from({ length: 29 }, zeros), { durationSec: 1800 }); // 0〜560 秒
    expect(coverageOf(out, 'idle')).toEqual({ state: 'cancelled', complete: false, until: 560, durationSec: 1800 });
    expect(coverageOf(out, 'error').state).toBe('error');
    expect(coverageOf(out, 'running').state).toBe('running');
    // 状態が「完了」でも、結果が途中までなら完了とはしない
    expect(coverageOf(out, 'done').complete).toBe(false);

    expect(partialRangeLabel(coverageOf(out, 'idle'))).toBe('0〜9分20秒のみ計算（中止）');
    expect(partialRangeLabel(coverageOf(out, 'error'))).toBe('0〜9分20秒のみ計算（エラーで停止）');
    expect(partialRangeLabel(coverageOf(out, 'running'))).toBe('0〜9分20秒まで計算済み（計算中）');
    expect(partialExplanation(coverageOf(out, 'idle'))).toContain('浸水しないという意味ではありません');

    const done = fakeOutput(spec, Array.from({ length: 91 }, zeros), { durationSec: 1800 });
    expect(coverageOf(done, 'done')).toEqual({ state: 'complete', complete: true, until: 1800, durationSec: 1800 });
    expect(partialRangeLabel(coverageOf(done, 'done'))).toBe('');
    expect(partialExplanation(coverageOf(done, 'done'))).toBe('');
  });

  it('再生・移動は、中止の後は計算済みの時刻まで（計算中は計算終了時刻まで待ちながら進む）', () => {
    const grid = makeGrid(spec);
    const out = fakeOutput(spec, Array.from({ length: 29 }, zeros), { durationSec: 1800 });
    const s = stateWith({ output: out, runGrid: grid, grid, status: 'idle' });
    expect(playbackEnd(s)).toBe(560);
    expect(seekLimit(s)).toBe(560);
    expect(playbackEnd({ ...s, sim: { ...s.sim, status: 'running' } })).toBe(1800);
    expect(seekLimit({ ...s, sim: { ...s.sim, status: 'running' } })).toBe(560);
    // 結果が無ければ設定の計算時間
    expect(playbackEnd(stateWith({ output: null, runGrid: null, grid, status: 'idle' }))).toBe(PARAMS.durationMin * 60);
  });
});

describe('今の地形の上の結果か（結果は計算に使った地形の格子オブジェクトに結びつく）', () => {
  const spec = tinySpec();
  const n = spec.nx * spec.ny;
  const out = fakeOutput(spec, [new Float32Array(n)]);

  it('計算に使った格子と同じオブジェクトの上でだけ使える', () => {
    const grid = makeGrid(spec);
    expect(usableOutput(stateWith({ output: out, runGrid: grid, grid }))).toBe(out);
    expect(isOutputCurrent(stateWith({ output: out, runGrid: grid, grid }))).toBe(true);
  });

  it('形（GridSpec）が同じでも、読み込み直した地形（簡易地形 → 標高データ）の上では使わない', () => {
    const synthetic = makeGrid(spec);
    const real: TerrainGrid = { ...makeGrid(spec), source: 'cache', isApproximate: false };
    const s = stateWith({ output: out, runGrid: synthetic, grid: real });
    expect(isOutputCurrent(s)).toBe(false);
    expect(usableOutput(s)).toBeNull();
    expect(resultCoverage(s)).toBeNull();
  });

  it('地形の読み込み中（格子なし）・計算の記録が無い結果は使わない', () => {
    const grid = makeGrid(spec);
    expect(usableOutput(stateWith({ output: out, runGrid: grid, grid: null }))).toBeNull();
    expect(usableOutput(stateWith({ output: out, runGrid: null, grid }))).toBeNull();
  });
});

describe('どの条件の結果か', () => {
  const spec = tinySpec();
  const grid = makeGrid(spec);
  const out = fakeOutput(spec, [new Float32Array(spec.nx * spec.ny)]);
  const advisory = getScenario('example-advisory')!;
  const advisoryParams: SimParams = { ...defaultParams(advisory), resolution: 'coarse' };

  it('条件は値で比べる（同じシナリオを選び直しただけなら同じ）', () => {
    expect(paramsEqual(PARAMS, { ...defaultParams(scenario), resolution: 'coarse' })).toBe(true);
    expect(paramsEqual(PARAMS, { ...PARAMS, tideTP: PARAMS.tideTP + 0.1 })).toBe(false);
    expect(paramsEqual(PARAMS, { ...PARAMS, scenario: { ...PARAMS.scenario, coastHeight: 9 } })).toBe(false);
    expect(paramsEqual(PARAMS, { ...PARAMS, resolution: 'standard' })).toBe(false);
    const withAmps = { ...PARAMS, scenario: { ...PARAMS.scenario, waveAmplitudes: [1, 0.5] } };
    expect(paramsEqual(withAmps, { ...withAmps, scenario: { ...withAmps.scenario, waveAmplitudes: [1, 0.5] } })).toBe(true);
    expect(paramsEqual(withAmps, { ...withAmps, scenario: { ...withAmps.scenario, waveAmplitudes: [1, 0.4] } })).toBe(false);
  });

  it('震度・シナリオを選び直しても、表示中の結果の警報・揺れは計算した条件のまま（条件の変更は別に知らせる）', () => {
    const s: SimView = { ...stateWith({ output: out, runGrid: grid, grid, runParams: PARAMS, params: advisoryParams }), shindo: '3' };
    expect(isResultStale(s)).toBe(true);
    expect(resultParams(s)).toBe(PARAMS);
    expect(resultParams(s).scenario.warning).toBe('major');
    expect(resultShindo(s)).toBe('7');
    expect(runConditionsLabel(s, (lv) => SHINDO_LABEL[lv])).toBe(`${scenario.shortName}・震度7`);
  });

  it('計算中は、まだ結果が届いていなくても計算中の条件で示す', () => {
    const s: SimView = { ...stateWith({ output: null, runGrid: grid, grid, runParams: PARAMS, params: advisoryParams, status: 'running' }), shindo: '3' };
    expect(isResultStale(s)).toBe(true);
    expect(resultParams(s)).toBe(PARAMS);
  });

  it('結果が無ければ、いま選ばれている条件', () => {
    const s: SimView = { ...stateWith({ output: null, runGrid: grid, grid, runParams: PARAMS, params: advisoryParams, status: 'idle' }), shindo: '3' };
    expect(isResultStale(s)).toBe(false);
    expect(resultParams(s)).toBe(advisoryParams);
    expect(resultShindo(s)).toBe('3');
  });

  it('同じシナリオを使う震度（3 と 4）に変えただけなら、条件の変更ではなく、いま選ばれている震度で示す', () => {
    const s: SimView = { ...stateWith({ output: out, runGrid: grid, grid, runParams: advisoryParams, params: { ...defaultParams(advisory), resolution: 'coarse' } }), shindo: '4' };
    expect(isResultStale(s)).toBe(false);
    expect(resultShindo(s)).toBe('4');
  });
});

describe('途中で止まった結果の最大浸水深・到達時刻を、受信済みのフレームまでそろえる', () => {
  // セル 0: 初期に水がある（海）。セル 1: 集計の後（フレーム 4 = 80 秒）に浸水。セル 2: 集計済み。セル 3: 浸水しない
  const spec = tinySpec(4, 1);
  const frame = (d: number[]) => Float32Array.from(d);
  const frames = [
    frame([3, 0, 0, 0]),
    frame([3, 0, 0.5, 0]),
    frame([3.2, 0, 1.2, 0]),
    frame([3.1, 0, 0.8, 0]),
    frame([3, 0.04, 0.6, 0]),
    frame([3, 0.9, 0.4, 0]),
  ];

  it('集計の後に浸水し始めた場所も浸水として扱い、revision を進める', () => {
    const out = fakeOutput(spec, frames, { durationSec: 1800, complete: false });
    // 集計は 40 秒（フレーム 2）の時点まで
    out.maxDepth.set([0, 0, 1.2, 0]);
    out.arrival.set([Infinity, Infinity, 12.5, Infinity]);
    expect(cellArrival(out, 1)).toBeCloseTo(65, 2);
    expect(extendStatsToFrames(out)).toBe(true);
    expect(out.revision).toBe(1);
    // セル 1: 60 秒（0 m）と 80 秒（0.04 m）の間で 1 cm に達する（線形補間 = 地図の表示と同じ）
    expect(out.arrival[1]).toBeCloseTo(65, 2);
    expect(out.maxDepth[1]).toBeCloseTo(0.9, 6);
    // 集計済みの値（ステップごとの厳密な値）は変えない
    expect(out.arrival[2]).toBe(12.5);
    expect(out.maxDepth[2]).toBeCloseTo(1.2, 6);
    // 初期に水があるセル・浸水しないセルは対象外
    expect(out.arrival[0]).toBe(Infinity);
    expect(out.maxDepth[0]).toBe(0);
    expect(out.arrival[3]).toBe(Infinity);
    // 2 回目は変化なし
    expect(extendStatsToFrames(out)).toBe(false);
    expect(out.revision).toBe(1);
  });

  it('避難先の「浸水しなかった場所」の判定は、仕上げで書き換わった集計を使う（フレーム数が同じでも作り直す）', () => {
    const wide = tinySpec(40, 1);
    const grid = makeGrid(wide);
    const f0 = new Float32Array(40);
    const out = fakeOutput(wide, [f0, f0, f0], { complete: false });
    const ctx = getGridContext(grid);
    expect(simSafeMask(ctx, out)[20]).toBe(1);
    // 仕上げでセル 20 の浸水が分かった（フレーム数は同じ・revision が進む）
    out.arrival[20] = 30;
    out.maxDepth[20] = 0.5;
    out.revision++;
    expect(simSafeMask(ctx, out)[20]).toBe(0);
  });

  it('完了した結果では集計の値をそのまま使う', () => {
    const out = fakeOutput(spec, frames, { complete: true });
    expect(cellArrival(out, 1)).toBe(Infinity);
    out.arrival[1] = 70;
    expect(cellArrival(out, 1)).toBe(70);
  });
});

describe('表示の書式・文言', () => {
  it('経過時間の書式は画面全体で共通（人物の説明文と一覧で同じ値が違って見えない）', () => {
    for (const t of [1787.604, 1622.9, 4500, 59.99, 0]) {
      expect(peopleFormatElapsed(t)).toBe(uiFormatElapsed(t));
      expect(peopleFormatElapsed(t)).toBe(formatElapsed(t));
    }
    expect(formatElapsed(1787.604)).toBe('29分47秒');
    expect(formatElapsed(4500)).toBe('1時間15分00秒');
  });

  it('計算済みの範囲の短い書式', () => {
    expect(formatSpan(560)).toBe('9分20秒');
    expect(formatSpan(540)).toBe('9分');
    expect(formatSpan(3600)).toBe('1時間');
    expect(formatSpan(3900)).toBe('1時間05分');
    expect(formatSpan(40)).toBe('40秒');
  });

  it('津波予報（若干の海面変動）の警報カードは「被害の心配はない」を本文にし、注意報解除後の文言は参考として分ける', () => {
    const t = warningCardText('forecast', WARNING_INFO.forecast);
    expect(t.action).toContain('被害の心配はなく');
    expect(t.action).not.toContain('津波注意報解除後');
    expect(t.action).not.toContain('旨を発表します');
    if (WARNING_INFO.forecast.action.startsWith('（津波注意報解除後')) {
      expect(t.reference).toMatch(/^参考: 津波注意報の解除後も海面変動が続くときの津波予報では、/);
    }
    // 他の区分は「とるべき行動」をそのまま
    expect(warningCardText('major', WARNING_INFO.major).action).toBe(WARNING_INFO.major.action);
    expect(warningCardText('advisory', WARNING_INFO.advisory).reference).toBe('');
  });

  it('「その場にとどまる」人は、浸水していない間「避難開始前」ではなく「とどまっている」', () => {
    expect(personStatusLabel({ evacMode: 'stay' }, 'waiting')).toBe(STAY_STATUS_LABEL);
    expect(personStatusLabel({ evacMode: 'shelter' }, 'waiting')).toBe('避難開始前');
    expect(personStatusLabel({ evacMode: 'stay' }, 'critical')).toBe('生命の危険');
    expect(personStatusLabel(null, 'waiting')).toBe('避難開始前');
  });
});
