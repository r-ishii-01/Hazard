import { describe, expect, it } from 'vitest';
import { CELL_LAND, CELL_SEA } from '../src/core/types';
import { GRAVITY, ShallowWaterSolver, maxStillDepth, pow73, stableTimeStep, type SolverOptions } from '../src/sim/solver';
import { makeSimpleGrid, type SimpleGridOptions } from '../src/sim/synthetic';
import { firstCrestOffset, makeIncidentWave } from '../src/sim/wave';

const CLOSED = { north: false, south: false, east: false, west: false };

function solverFor(o: SimpleGridOptions, opts: Partial<SolverOptions> & { waveHeight?: number } = {}) {
  const g = makeSimpleGrid(o);
  const tide = opts.tide ?? 0;
  const dt = opts.dt ?? stableTimeStep(o.dx, maxStillDepth(g, tide), opts.waveHeight ?? 1);
  const solver = new ShallowWaterSolver(
    { nx: o.nx, ny: o.ny, dx: o.dx, z: g.z, kind: g.kind, manning: g.manning },
    { tide, landManning: 0.03, dt, ...opts },
  );
  return { g, solver };
}

function maxAbs(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

describe('pow73（D^(7/3) の表引き）', () => {
  it('Math.pow と相対誤差 1e-4 以内で一致する', () => {
    for (let d = 1e-3; d < 400; d *= 1.07) {
      expect(Math.abs(pow73(d) / Math.pow(d, 7 / 3) - 1)).toBeLessThan(1e-4);
    }
  });
});

describe('静水の保存（well-balanced）', () => {
  it('凹凸のある海底・潮位より高い陸・囲まれた低地があっても静止したまま', () => {
    const tide = 0.4;
    const { g, solver } = solverFor(
      {
        nx: 40,
        ny: 36,
        dx: 20,
        z: (i, j) => {
          if (i > 28) return 2 + 0.1 * (i - 28); // 陸（潮位より高い）
          if (i >= 18 && i <= 22 && j >= 10 && j <= 14) return i === 20 && j === 12 ? -1 : 3; // 堤に囲まれた低地（潮位より低い陸）
          if (i >= 5 && i <= 8 && j >= 20 && j <= 23) return 1.5; // 島
          return -6 + 3 * Math.sin(i * 0.7) * Math.cos(j * 0.5) + 0.1 * i; // 凹凸のある海底（一部は浅瀬）
        },
        kind: (i, j, z) => (i > 28 || (i >= 18 && i <= 22 && j >= 10 && j <= 14) || z > 1 ? CELL_LAND : CELL_SEA),
      },
      { tide, open: { north: true, south: true, east: true, west: true } },
    );
    expect(solver.isAtRest()).toBe(true);
    const eta0 = Float32Array.from(solver.eta);
    for (let s = 0; s < 800; s++) solver.step();
    let maxDiff = 0;
    for (let k = 0; k < eta0.length; k++) maxDiff = Math.max(maxDiff, Math.abs(solver.eta[k] - eta0[k]));
    expect(maxDiff).toBeLessThan(1e-6);
    expect(maxAbs(solver.M)).toBeLessThan(1e-6);
    expect(maxAbs(solver.N)).toBeLessThan(1e-6);
    // 陸はすべて乾いたまま（囲まれた低地も含む）
    for (let k = 0; k < eta0.length; k++) if (g.kind[k] === CELL_LAND) expect(solver.depth(k)).toBe(0);
  });

  it('潮位より低い陸が海に接していれば静止ではないと判定する', () => {
    const { solver } = solverFor({ nx: 10, ny: 10, dx: 10, z: (i) => (i < 5 ? -3 : -0.2), kind: (i) => (i < 5 ? CELL_SEA : CELL_LAND) });
    expect(solver.isAtRest()).toBe(false);
  });
});

describe('質量保存', () => {
  it('閉じた水域で遡上・引きを繰り返しても総水量の相対誤差 < 1e-6', () => {
    const nx = 60;
    const ny = 60;
    const { solver } = solverFor(
      {
        nx,
        ny,
        dx: 10,
        // 南ほど深い斜面（北側は陸）。波が陸に上がって戻る
        z: (_i, j) => -8 + (ny - 1 - j) * 0.25,
      },
      { open: CLOSED, waveHeight: 3 },
    );
    // 初期に水位の山を置く
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const r2 = (i - 30) ** 2 + (j - 50) ** 2;
        if (solver.depth(k) > 0) solver.eta[k] += 1.5 * Math.exp(-r2 / 30);
      }
    }
    const v0 = solver.totalVolume();
    let wetLandMax = 0;
    for (let s = 0; s < 2500; s++) {
      solver.step();
      if (s % 50 === 0) {
        let w = 0;
        for (let k = 0; k < nx * ny; k++) if (solver.isLand[k] && solver.depth(k) > 0.01) w++;
        wetLandMax = Math.max(wetLandMax, w);
      }
    }
    const v1 = solver.totalVolume();
    expect(Math.abs(v1 - v0) / v0).toBeLessThan(1e-6);
    expect(wetLandMax).toBeGreaterThan(0); // 陸に遡上した
    for (let k = 0; k < nx * ny; k++) expect(Number.isFinite(solver.eta[k])).toBe(true);
  });
});

/** 南北方向の一様な水路（幅 nx セル、東西は壁） */
function channel(opts: { northOpen: boolean; amplitude: number; periodSec: number; ny?: number }) {
  const nx = 4;
  const ny = opts.ny ?? 400;
  const dx = 50;
  const h = 10;
  const incident = makeIncidentWave({ amplitude: opts.amplitude, periodSec: opts.periodSec, waves: 1, firstMotion: 'rise', startSec: 0 });
  const { solver } = solverFor(
    { nx, ny, dx, z: () => -h, manning: 1e-6 },
    { open: { north: opts.northOpen, south: true, east: false, west: false }, incident, waveHeight: 2 * opts.amplitude },
  );
  return { solver, nx, ny, dx, h };
}

describe('長波の伝播', () => {
  it('一様水深の水路で波速が √(gh) と 5% 以内で一致する', () => {
    const { solver, nx, dx, h } = channel({ northOpen: true, amplitude: 0.01, periodSec: 300 });
    const jA = 300;
    const jB = 100;
    let bestA = -Infinity;
    let tA = 0;
    let bestB = -Infinity;
    let tB = 0;
    while (solver.t < 3200) {
      solver.step();
      const a = solver.eta[jA * nx + 1];
      const b = solver.eta[jB * nx + 1];
      if (a > bestA) {
        bestA = a;
        tA = solver.t;
      }
      if (b > bestB) {
        bestB = b;
        tB = solver.t;
      }
    }
    const speed = ((jA - jB) * dx) / (tB - tA);
    const c = Math.sqrt(GRAVITY * h);
    expect(Math.abs(speed / c - 1)).toBeLessThan(0.05);
    // 入射した波の振幅もほぼ保たれる（山の値は包絡線の減衰を含む）
    expect(bestA).toBeGreaterThan(0.008);
    expect(bestA).toBeLessThan(0.0105);
  });

  it('開境界: 北端から抜ける波の反射は小さい（壁の場合と比較）', () => {
    const measure = (northOpen: boolean) => {
      const { solver, nx, ny } = channel({ northOpen, amplitude: 0.05, periodSec: 300 });
      // 入射波が北端を抜けるまで待つ（伝播 ≈ 2020 秒 + 波長分）
      while (solver.t < 2800) solver.step();
      // その後、領域内に残る（反射して戻ってくる）波の大きさ
      let peak = 0;
      while (solver.t < 4400) {
        solver.step();
        for (let j = 20; j < ny - 20; j += 5) peak = Math.max(peak, Math.abs(solver.eta[j * nx + 1]));
      }
      return peak;
    };
    const open = measure(true);
    const wall = measure(false);
    expect(wall).toBeGreaterThan(0.03); // 壁ならほぼ全反射
    expect(open / 0.05).toBeLessThan(0.05); // 開境界の反射率 < 5%
  });
});

describe('遡上（斜面の海岸）', () => {
  it('波が陸に上がって引き、数値は発散しない', () => {
    const nx = 20;
    const ny = 220;
    const dx = 10;
    // 南端から 1/100 勾配: 南端で水深 10 m、j≈120 が汀線、北は陸（+10 m まで）
    const zf = (_i: number, j: number) => -10 + ((ny - 1 - j) * dx) / 100;
    const A = 1;
    const T = 240;
    const incident = makeIncidentWave({ amplitude: A, periodSec: T, waves: 1, firstMotion: 'rise', startSec: 0 });
    const { g, solver } = solverFor(
      { nx, ny, dx, z: zf, kind: (_i, _j, z) => (z < 0 ? CELL_SEA : CELL_LAND) },
      { open: { north: false, south: true, east: false, west: false }, incident, waveHeight: 2 },
    );
    const wetLand = () => {
      let w = 0;
      for (let k = 0; k < nx * ny; k++) if (g.kind[k] === CELL_LAND && solver.depth(k) > 0.01) w++;
      return w;
    };
    let peak = 0;
    let tPeak = 0;
    while (solver.t < 1800) {
      solver.step();
      if (solver.steps % 20 === 0) {
        const w = wetLand();
        if (w > peak) {
          peak = w;
          tPeak = solver.t;
        }
      }
    }
    // 陸に遡上した（遡上高 = 浸水した陸の最高地盤）
    let runup = 0;
    const md = new Float32Array(nx * ny);
    solver.copyMaxDepth(md);
    const arr = new Float32Array(nx * ny);
    solver.copyArrival(arr);
    for (let k = 0; k < nx * ny; k++) {
      if (md[k] > 0.01) {
        runup = Math.max(runup, g.z[k]);
        expect(Number.isFinite(arr[k])).toBe(true);
      }
    }
    expect(peak).toBeGreaterThan(nx * 5);
    expect(runup).toBeGreaterThan(0.8 * A);
    expect(runup).toBeLessThan(4 * A);
    // 波が去った後は水が引いている
    expect(wetLand()).toBeLessThan(peak * 0.5);
    expect(tPeak).toBeGreaterThan(firstCrestOffset({ periodSec: T, firstMotion: 'rise' }));
    for (let k = 0; k < nx * ny; k++) {
      expect(Number.isFinite(solver.eta[k])).toBe(true);
      expect(solver.eta[k]).toBeGreaterThanOrEqual(solver.z[k]);
    }
  });
});
