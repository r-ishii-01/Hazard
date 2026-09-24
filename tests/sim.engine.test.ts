import { describe, expect, it } from 'vitest';
import type { QuakeScenario, SimParams, TerrainGrid } from '../src/core/types';
import { prepareRun, runEngine, runSerialMain, type CalibrationInfo, type EngineSink, type EngineStartInfo, type StatsSnapshot } from '../src/sim/engine';
import { makeKugenumaLikeGrid } from '../src/sim/synthetic';

function scenario(p: Partial<QuakeScenario>): QuakeScenario {
  return {
    id: 'test',
    name: 'テスト用',
    shortName: 'テスト',
    magnitude: null,
    shindo: '6-',
    coastHeight: 5,
    arrivalMin: 10,
    periodMin: 8,
    firstMotion: 'rise',
    waves: 2,
    shakingSec: 60,
    warning: 'warning',
    description: '',
    isOfficial: false,
    ...p,
  };
}

/** 鵠沼海岸に似せた小さな合成地形（一定水深の棚＋砂浜＋平地、約 31 m 格子） */
function coast(): TerrainGrid {
  return makeKugenumaLikeGrid({
    resolution: 'coarse',
    bounds: { west: 139.445, east: 139.495, south: 35.297, north: 35.322 },
    shelfDepth: 12,
    duneHeight: 0,
    plainHeight: 3,
    island: false,
    rivers: false,
  });
}

function run(grid: TerrainGrid, params: SimParams) {
  let info: EngineStartInfo | null = null;
  let cal: CalibrationInfo | null = null;
  let stats: StatsSnapshot | null = null;
  const frames: (Uint16Array | null)[] = [];
  const gaugeT: number[] = [];
  const gaugeEta: number[] = [];
  const progress: number[] = [];
  const perf = runEngine(
    { spec: grid.spec, z: grid.z, kind: grid.kind, manning: grid.manning, params },
    {
      start: (i) => (info = i),
      frame: (index, data, gt, ge) => {
        expect(index).toBe(frames.length);
        frames.push(data);
        gaugeT.push(...gt);
        gaugeEta.push(...ge);
      },
      calibrated: (c) => (cal = c),
      stats: (s) => (stats = s),
      progress: (p, msg) => {
        expect(typeof msg).toBe('string');
        progress.push(p);
      },
    },
  );
  return { info: info!, cal: cal!, stats: stats! as StatsSnapshot, frames, gaugeT, gaugeEta, progress, perf };
}

const params = (sc: QuakeScenario, p: Partial<SimParams> = {}): SimParams => ({
  scenario: sc,
  tideTP: 0,
  durationMin: 30,
  resolution: 'coarse',
  landManning: 0.06,
  ...p,
});

describe('エンジン: 校正と出力', () => {
  const grid = coast();

  it('海岸の最大水位が目標 coastHeight の ±15% 以内になり、第1波の山が到達時間に届く', () => {
    const sc = scenario({ coastHeight: 5, arrivalMin: 10 });
    const r = run(grid, params(sc));
    expect(r.info.segment.rule).toBe('kugenuma');
    expect(r.info.segment.cells).toBeGreaterThan(20);
    expect(r.cal.boundaryAmplitude).toBeGreaterThan(0);
    expect(r.cal.trials.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(r.stats.achievedCoastMax - 5) / 5).toBeLessThan(0.15);
    expect(r.stats.final).toBe(true);
    // 入力開始時刻は到達時間から逆算される
    expect(r.cal.boundaryStartSec).toBeGreaterThan(0);
    expect(r.cal.expectedCrestSec).toBeCloseTo(600, 0);
    // 潮位計の最大は到達時間の前後（±3分）
    let iMax = 0;
    r.gaugeEta.forEach((v, i) => {
      if (v > r.gaugeEta[iMax]) iMax = i;
    });
    expect(Math.abs(r.gaugeT[iMax] - 600)).toBeLessThan(180);
    // フレーム: 0..lastFrame、波が来る前はフレーム 0 と同じ（null）
    expect(r.frames.length).toBe(r.info.lastFrame + 1);
    expect(r.info.lastFrame).toBe(90);
    expect(r.frames[0]).not.toBeNull();
    expect(r.frames[1]).toBeNull();
    expect(r.frames[r.frames.length - 1]).not.toBeNull();
    // 潮位計は約10秒ごと
    expect(r.gaugeT.length).toBe(r.info.lastFrame * 2 + 1);
    expect(r.gaugeT[1] - r.gaugeT[0]).toBeCloseTo(10, 6);
    // 陸が浸水し、最大浸水深・到達時刻が記録される
    let flooded = 0;
    for (let k = 0; k < r.stats.maxDepth.length; k++) {
      if (r.stats.maxDepth[k] > 0.01) {
        flooded++;
        expect(Number.isFinite(r.stats.arrival[k])).toBe(true);
        expect(grid.kind[k]).not.toBe(1);
      }
      if (grid.kind[k] === 1) {
        expect(r.stats.maxDepth[k]).toBe(0);
        expect(r.stats.arrival[k]).toBe(Infinity);
      }
    }
    expect(flooded).toBeGreaterThan(50);
    // 進捗は単調増加で 1 に達する
    for (let i = 1; i < r.progress.length; i++) expect(r.progress[i]).toBeGreaterThanOrEqual(r.progress[i - 1] - 1e-9);
    expect(r.progress[r.progress.length - 1]).toBeCloseTo(1, 6);
  }, 120_000);

  it("'fall'（引き波から）では海岸で最初に水位が下がる", () => {
    const sc = scenario({ coastHeight: 4, arrivalMin: 12, firstMotion: 'fall' });
    const r = run(grid, params(sc));
    const thr = 0.1 * 4;
    const first = r.gaugeEta.findIndex((v) => Math.abs(v) > thr);
    expect(first).toBeGreaterThan(0);
    expect(r.gaugeEta[first]).toBeLessThan(0);
    let iMin = 0;
    let iMax = 0;
    r.gaugeEta.forEach((v, i) => {
      if (v < r.gaugeEta[iMin]) iMin = i;
      if (v > r.gaugeEta[iMax]) iMax = i;
    });
    expect(iMin).toBeLessThan(iMax);
    expect(r.gaugeEta[iMin]).toBeLessThan(-0.3 * 4);
    expect(Math.abs(r.stats.achievedCoastMax - 4) / 4).toBeLessThan(0.15);
  }, 120_000);

  it('津波の高さが潮位以下なら波を入れず、静かな海のフレームを出す', () => {
    const sc = scenario({ coastHeight: 0.04 });
    const r = run(grid, params(sc, { tideTP: 0, durationMin: 20 }));
    expect(r.cal.boundaryAmplitude).toBe(0);
    expect(r.cal.notes.length).toBeGreaterThan(0);
    expect(r.frames.length).toBe(61);
    expect(r.frames[0]).not.toBeNull();
    for (let f = 1; f < r.frames.length; f++) expect(r.frames[f]).toBeNull();
    expect(r.stats.achievedCoastMax).toBeCloseTo(0, 5);
    expect(r.stats.maxDepth.every((v) => v === 0)).toBe(true);
    expect(r.stats.arrival.every((v) => v === Infinity)).toBe(true);
    expect(r.gaugeEta.every((v) => Math.abs(v) < 1e-6)).toBe(true);
    expect(r.perf.steps).toBe(0);
  });

  it('満潮で水面下になる砂浜は初期状態から水域として扱い、浸水とは数えない', () => {
    // 合成地形の砂浜の汀線は T.P.+0.3 m。潮位 +0.5 m では砂浜の下部が水面下になる
    const sc = scenario({ coastHeight: 0.5 });
    const r = run(grid, params(sc, { tideTP: 0.5, durationMin: 5 }));
    expect(r.cal.boundaryAmplitude).toBe(0);
    // 静止状態なので計算は不要（フレーム 0 と同じ）
    expect(r.perf.steps).toBe(0);
    for (let f = 1; f < r.frames.length; f++) expect(r.frames[f]).toBeNull();
    // フレーム 0 で、潮位より低い砂浜（陸セル）に水がある
    let wetBeach = 0;
    for (let k = 0; k < grid.z.length; k++) if (grid.kind[k] !== 1 && grid.z[k] < 0.5 && r.frames[0]![k] > 0) wetBeach++;
    expect(wetBeach).toBeGreaterThan(0);
    expect(r.stats.maxDepth.every((v) => v === 0)).toBe(true);
    expect(r.stats.arrival.every((v) => v === Infinity)).toBe(true);
  });

  it('到達時間が伝播時間より短いときは開始を 0 にして注記する', () => {
    const sc = scenario({ coastHeight: 3, arrivalMin: 1, waves: 1 });
    const r = run(grid, params(sc, { durationMin: 15 }));
    expect(r.cal.boundaryStartSec).toBe(0);
    expect(r.cal.expectedCrestSec).toBeGreaterThan(60);
    expect(r.cal.notes.some((s) => s.includes('到達時間'))).toBe(true);
  }, 60_000);

  it('地形データの大きさが合わなければ日本語のエラー', () => {
    const bad = { ...grid, z: new Float32Array(10) };
    expect(() => run(bad, params(scenario({})))).toThrow(/地形データ/);
  });
});

describe('エンジン: 数値的な頑健性（極端な条件でも発散・NaN なし）', () => {
  const grid = coast();

  /** 本計算まで実行し、ソルバの最終状態も調べる */
  function runChecked(g: TerrainGrid, p: SimParams) {
    let cal: CalibrationInfo | null = null;
    let stats: StatsSnapshot | null = null;
    const gauge: number[] = [];
    let frames = 0;
    const sink: EngineSink = {
      start() {},
      frame: (_i, _d, _gt, ge) => {
        frames++;
        gauge.push(...ge);
      },
      calibrated: (c) => (cal = c),
      stats: (s) => (stats = s),
      progress() {},
    };
    const prep = prepareRun({ spec: g.spec, z: g.z, kind: g.kind, manning: g.manning, params: p }, sink);
    runSerialMain(prep, sink);
    const { solver } = prep;
    for (let k = 0; k < solver.n; k++) {
      expect(Number.isFinite(solver.eta[k])).toBe(true);
      expect(solver.eta[k]).toBeGreaterThanOrEqual(solver.z[k]);
    }
    for (let f = 0; f < solver.M.length; f++) expect(Number.isFinite(solver.M[f])).toBe(true);
    for (let f = 0; f < solver.N.length; f++) expect(Number.isFinite(solver.N[f])).toBe(true);
    const st = stats! as StatsSnapshot;
    for (let k = 0; k < st.maxDepth.length; k++) {
      expect(st.maxDepth[k]).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(st.maxDepth[k])).toBe(true);
      expect(st.arrival[k] >= 0).toBe(true); // 有限の時刻か +∞（NaN なし）
    }
    expect(gauge.every(Number.isFinite)).toBe(true);
    expect(frames).toBe(Math.round((p.durationMin * 60) / 20) + 1);
    return { cal: cal! as CalibrationInfo, stats: st };
  }

  it('海岸で 20 m の巨大な津波: 発散せず、届かない場合は振幅の制限を注記し、同じ試算を繰り返さない', () => {
    const r = runChecked(grid, params(scenario({ coastHeight: 20, arrivalMin: 10, periodMin: 10 }), { durationMin: 25 }));
    const amps = r.cal.trials.filter((t) => t.cellM > 40 === false).map((t) => t.amplitude);
    for (let i = 1; i < amps.length; i++) expect(Math.abs(amps[i] - amps[i - 1])).toBeGreaterThan(1e-6 * amps[i]);
    expect(r.stats.achievedCoastMax).toBeGreaterThan(10);
    if (Math.abs(r.stats.achievedCoastMax - 20) / 20 > 0.1) expect(r.cal.notes.some((n) => n.includes('振幅を制限'))).toBe(true);
    expect(r.stats.maxDepth.some((d) => d > 5)).toBe(true);
  }, 120_000);

  it('0.3 m の小さな津波（潮位 T.P.0）でも目標どおりに校正される', () => {
    const r = runChecked(grid, params(scenario({ coastHeight: 0.3, arrivalMin: 10, periodMin: 8 }), { durationMin: 20 }));
    expect(r.cal.boundaryAmplitude).toBeGreaterThan(0);
    expect(Math.abs(r.stats.achievedCoastMax - 0.3) / 0.3).toBeLessThan(0.1);
  }, 120_000);

  it('潮位 T.P.+1 m では、潮位からの上昇量で校正し、潮位で冠水する土地は浸水に数えない', () => {
    const r = runChecked(grid, params(scenario({ coastHeight: 4, arrivalMin: 10, periodMin: 8 }), { tideTP: 1, durationMin: 20 }));
    expect(Math.abs(r.stats.achievedCoastMax - 4) / 3).toBeLessThan(0.1); // 上昇量 3 m に対して ±10%
    for (let k = 0; k < grid.z.length; k++) {
      if (grid.kind[k] !== 1 && grid.z[k] < 1) {
        // 海とつながる潮位以下の砂浜は初めから水域
        expect(r.stats.arrival[k]).toBe(Infinity);
        expect(r.stats.maxDepth[k]).toBe(0);
      }
    }
  }, 120_000);

  it('地盤高に NaN / ∞ があっても計算でき、伝播時間の見積もりも壊れない', () => {
    const bad: TerrainGrid = { ...grid, z: Float32Array.from(grid.z) };
    const { nx, ny } = grid.spec;
    // 沖・汀線付近・陸に欠測を混ぜる
    for (const [i, j, v] of [
      [Math.floor(nx / 2), ny - 3, NaN],
      [Math.floor(nx / 3), Math.floor(ny * 0.55), NaN],
      [Math.floor(nx / 4), 5, Infinity],
      [Math.floor(nx * 0.7), 10, -Infinity],
    ] as const)
      bad.z[j * nx + i] = v;
    const good = runChecked(grid, params(scenario({ coastHeight: 5, arrivalMin: 10 }), { durationMin: 20 }));
    const r = runChecked(bad, params(scenario({ coastHeight: 5, arrivalMin: 10 }), { durationMin: 20 }));
    // 欠測が数セルだけなら、校正（入力開始時刻と振幅）はほとんど変わらない
    expect(Math.abs(r.cal.boundaryStartSec - good.cal.boundaryStartSec)).toBeLessThan(30);
    expect(Math.abs(r.stats.achievedCoastMax - 5) / 5).toBeLessThan(0.15);
  }, 180_000);

  it('シナリオの値が数値でなければ既定値・静かな海で計算する', () => {
    const r = run(grid, params(scenario({ coastHeight: NaN, periodMin: NaN, waves: NaN, arrivalMin: NaN }), { durationMin: NaN, landManning: NaN }));
    expect(r.cal.boundaryAmplitude).toBe(0);
    expect(r.cal.notes.length).toBeGreaterThan(0);
    expect(r.info.durationSec).toBe(3600);
    expect(r.frames.length).toBe(181);
    expect(r.perf.steps).toBe(0);
  });
});
