/**
 * 到達時間と海岸の最大水位の定義の検証（本計算の格子で実際に測る）。
 * - 第1波の山（校正区間の平均水位の最初の極大）が、地震発生から arrivalMin に海岸へ届く（±1 分）
 * - achievedCoastMax は校正区間（経度 139.455〜139.485、北緯 35.305 度より北の汀線の海セル）の
 *   各セルの最大水位の 90 パーセンタイル
 * 本計算は standard（約 15.6 m）格子、校正の試算は約 31 m（と 62 m）格子なので、格子の違いも含めて確かめる。
 */
import { describe, expect, it } from 'vitest';
import { cellCenter } from '../src/core/geo';
import { CELL_SEA, type QuakeScenario, type SimParams, type TerrainGrid } from '../src/core/types';
import { coastMax, prepareRun, type CalibrationInfo, type EngineSink } from '../src/sim/engine';
import { KUGENUMA_SEGMENT } from '../src/sim/site';
import { makeKugenumaLikeGrid } from '../src/sim/synthetic';

const scenario = (p: Partial<QuakeScenario>): QuakeScenario => ({
  id: 'timing',
  name: '到達時間の検証用',
  shortName: '検証',
  magnitude: null,
  shindo: '6+',
  coastHeight: 6,
  arrivalMin: 10,
  periodMin: 8,
  firstMotion: 'rise',
  waves: 2,
  shakingSec: 60,
  warning: 'major',
  description: '',
  isOfficial: false,
  ...p,
});

/** 鵠沼海岸付近の小さな範囲の合成地形（standard 格子、約 290×180） */
const grid: TerrainGrid = makeKugenumaLikeGrid({
  resolution: 'standard',
  bounds: { west: 139.445, east: 139.495, south: 35.297, north: 35.322 },
  seaSlope: 60,
  maxDepth: 25,
  duneHeight: 5,
  plainHeight: 3,
  island: false,
  rivers: true,
});

/** 独立に実装した 90 パーセンタイル（線形補間） */
function p90(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  const x = 0.9 * (v.length - 1);
  const i = Math.floor(x);
  return v[i] + ((v[Math.min(i + 1, v.length - 1)] ?? v[i]) - v[i]) * (x - i);
}

function measure(sc: QuakeScenario, tide: number) {
  const params: SimParams = { scenario: sc, tideTP: tide, durationMin: 30, resolution: 'standard', landManning: 0.06 };
  let cal: CalibrationInfo | null = null;
  const sink: EngineSink = { start() {}, frame() {}, calibrated: (c) => (cal = c), stats() {}, progress() {} };
  const { plan, solver } = prepareRun({ spec: grid.spec, z: grid.z, kind: grid.kind, manning: grid.manning, params }, sink);
  const seg = plan.segmentCells;
  const until = sc.arrivalMin * 60 + 0.6 * sc.periodMin * 60;
  const ts: number[] = [];
  const ms: number[] = [];
  while (solver.t < until) {
    solver.step();
    let s = 0;
    for (let i = 0; i < seg.length; i++) s += solver.eta[seg[i]];
    ts.push(solver.t);
    ms.push(s / seg.length - tide);
  }
  // 第1波の山: 最大上昇量の半分を初めて超えた後の最初の極大
  const top = Math.max(...ms);
  let i = ms.findIndex((v) => v >= 0.5 * top);
  while (i + 1 < ms.length && ms[i + 1] >= ms[i]) i++;
  return { plan, solver, cal: cal! as CalibrationInfo, crestSec: ts[i], ms };
}

describe('到達時間（第1波の山が海岸に届く時刻）', () => {
  for (const [label, sc, tide] of [
    ['押し波から', scenario({ arrivalMin: 10, firstMotion: 'rise' }), 0],
    ['引き波から・満潮', scenario({ arrivalMin: 12, firstMotion: 'fall', coastHeight: 5 }), 0.85],
  ] as const) {
    it(`${label}: 本計算の格子で測った山の時刻が arrivalMin の ±1 分`, () => {
      const r = measure(sc, tide);
      expect(r.cal.boundaryStartSec).toBeGreaterThan(0); // 到達時間に合わせて入力開始を遅らせた
      expect(r.cal.expectedCrestSec).toBeCloseTo(sc.arrivalMin * 60, 6);
      expect(Math.abs(r.crestSec - sc.arrivalMin * 60)).toBeLessThan(60);
      if (sc.firstMotion === 'fall') {
        // 引き波から: 山より前に海岸の水位が下がる
        const iCrest = r.ms.findIndex((_, k) => k > 0 && r.ms[k] === Math.max(...r.ms));
        expect(Math.min(...r.ms.slice(0, iCrest))).toBeLessThan(-0.2 * (sc.coastHeight - tide));
      }
    }, 120_000);
  }
});

describe('海岸の最大水位（achievedCoastMax）と校正', () => {
  it('校正区間は仕様どおりの範囲の汀線の海セルで、値は各セルの最大水位の 90 パーセンタイル', () => {
    const sc = scenario({ coastHeight: 6, arrivalMin: 10 });
    const r = measure(sc, 0);
    const { nx, ny } = grid.spec;
    const seg = Array.from(r.plan.segmentCells);
    expect(seg.length).toBeGreaterThan(50);
    for (const k of seg) {
      const j = Math.floor(k / nx);
      const i = k - j * nx;
      const c = cellCenter(grid.spec, i, j);
      expect(grid.kind[k]).toBe(CELL_SEA);
      expect(c.lon).toBeGreaterThanOrEqual(KUGENUMA_SEGMENT.west);
      expect(c.lon).toBeLessThanOrEqual(KUGENUMA_SEGMENT.east);
      expect(c.lat).toBeGreaterThan(KUGENUMA_SEGMENT.minLat);
      const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
      expect(nb.some((q) => q >= 0 && grid.kind[q] !== CELL_SEA)).toBe(true); // 陸に接する
    }
    // 川（水路）の岸は含まない。海岸線沿いの汀線セルはほぼすべて含む
    const riverLons = [139.4595, 139.483];
    for (const k of seg) {
      const j = Math.floor(k / nx);
      const c = cellCenter(grid.spec, k - j * nx, j);
      if (c.lat > 35.3145) for (const lon of riverLons) expect(Math.abs(c.lon - lon) * 90800).toBeGreaterThan(30);
    }
    const achieved = coastMax(r.solver, r.plan.segmentCells, 0);
    const maxEta = seg.map((k) => (r.solver.maxEta[k] === -Infinity ? NaN : r.solver.maxEta[k]));
    expect(achieved).toBeCloseTo(p90(maxEta), 5);
    // 本計算（15.6 m 格子）で得られた値が目標の ±10%（校正は 31 m 格子で ±4%）
    expect(Math.abs(achieved - sc.coastHeight) / sc.coastHeight).toBeLessThan(0.1);
    const last = r.cal.trials[r.cal.trials.length - 1];
    expect(Math.abs(last.achieved - sc.coastHeight) / sc.coastHeight).toBeLessThan(0.04);
    expect(last.cellM).toBeGreaterThan(25);
  }, 120_000);
});
