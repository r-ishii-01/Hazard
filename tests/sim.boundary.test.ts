/**
 * 開境界（Flather 型の放射条件＋入射波）の検証。
 * - 南端から入れた波が意図した入射波 η_inc(t) になる
 * - 海岸（壁）で反射して戻ってきた波が南端から抜ける
 * - 東西端は、北へ進む平面波をゆがめない（一様な海・北へ浅くなる海）
 * - 四方が開いた海で、中央の水位の山が外へ抜ける
 */
import { describe, expect, it } from 'vitest';
import { GRAVITY, ShallowWaterSolver, maxStillDepth, stableTimeStep, type OpenEdges } from '../src/sim/solver';
import { makeSimpleGrid } from '../src/sim/synthetic';
import { makeIncidentWave, type WaveFn } from '../src/sim/wave';

function basin(o: { nx: number; ny: number; dx: number; z: (i: number, j: number) => number; open: OpenEdges; A: number; T: number }): {
  solver: ShallowWaterSolver;
  inc: WaveFn;
} {
  const g = makeSimpleGrid({ nx: o.nx, ny: o.ny, dx: o.dx, z: o.z, manning: 1e-6 });
  const inc = makeIncidentWave({ amplitude: o.A, periodSec: o.T, waves: 1, firstMotion: 'rise', startSec: 0 });
  const dt = stableTimeStep(o.dx, maxStillDepth(g, 0), 2 * o.A);
  const solver = new ShallowWaterSolver(
    { nx: o.nx, ny: o.ny, dx: o.dx, z: g.z, kind: g.kind, manning: g.manning },
    { tide: 0, landManning: 0.03, dt, incident: inc, open: o.open },
  );
  return { solver, inc };
}

const CHANNEL = { north: true, south: true, east: false, west: false };

describe('南端の開境界', () => {
  it('入射波 η_inc(t) がそのまま入る（振幅・位相の誤差 < 6%）', () => {
    const h = 10;
    const dx = 50;
    const A = 0.05;
    const { solver, inc } = basin({ nx: 4, ny: 300, dx, z: () => -h, open: CHANNEL, A, T: 300 });
    const c = Math.sqrt(GRAVITY * h);
    const j = 299 - 20; // 南端から 20 セル内側
    const lag = (20.5 * dx) / c; // 南端の面からセル中心までの伝播時間
    let err = 0;
    let peak = 0;
    while (solver.t < 1200) {
      solver.step();
      const e = solver.eta[j * 4 + 1];
      err = Math.max(err, Math.abs(e - inc(solver.t - lag)));
      peak = Math.max(peak, e);
    }
    expect(err / A).toBeLessThan(0.06);
    // 山の高さは入射波の最初の山（包絡線の減衰を含む）と一致
    let incPeak = 0;
    for (let t = 0; t < 300; t += 0.5) incPeak = Math.max(incPeak, inc(t));
    expect(Math.abs(peak / incPeak - 1)).toBeLessThan(0.03);
  });

  it('北端の壁で反射した波は南端から抜ける（残る波 < 入射振幅の 6%）', () => {
    const h = 10;
    const dx = 50;
    const A = 0.05;
    const ny = 200;
    const T = 300;
    const { solver } = basin({ nx: 4, ny, dx, z: () => -h, open: { ...CHANNEL, north: false }, A, T });
    const c = Math.sqrt(GRAVITY * h);
    const tOut = (2 * ny * dx) / c + T + 200; // 往復＋1波長＋余裕
    let atWall = 0;
    while (solver.t < tOut) {
      solver.step();
      atWall = Math.max(atWall, solver.eta[1]);
    }
    expect(atWall / A).toBeGreaterThan(1.6); // 壁では入射波と反射波が重なる（≈ 2 倍）
    let residual = 0;
    while (solver.t < tOut + 1500) {
      solver.step();
      for (let j = 0; j < ny; j += 5) residual = Math.max(residual, Math.abs(solver.eta[j * 4 + 1]));
    }
    expect(residual / A).toBeLessThan(0.06);
  });
});

describe('東西端の開境界', () => {
  const rowDeviation = (z: (i: number, j: number) => number, ny: number, until: number) => {
    const nx = 80;
    const A = 0.05;
    const { solver } = basin({ nx, ny, dx: 50, z, open: { north: true, south: true, east: true, west: true }, A, T: 300 });
    let dev = 0;
    let peak = 0;
    while (solver.t < until) {
      solver.step();
      for (const j of [Math.floor(ny * 0.15), Math.floor(ny / 2), Math.floor(ny * 0.85)]) {
        const ref = solver.eta[j * nx + nx / 2];
        peak = Math.max(peak, Math.abs(ref));
        for (let i = 0; i < nx; i++) dev = Math.max(dev, Math.abs(solver.eta[j * nx + i] - ref));
      }
    }
    return { dev, peak };
  };

  it('一様な水深の海で、北へ進む平面波をゆがめない（行内の差 < 波高の 8%）', () => {
    const { dev, peak } = rowDeviation(() => -10, 120, 1500);
    expect(peak).toBeGreaterThan(0.04);
    expect(dev / peak).toBeLessThan(0.08);
  });

  it('北へ浅くなる海（Green 則で増幅）でも平面波をゆがめない（行内の差 < 波高の 8%）', () => {
    const ny = 160;
    const { dev, peak } = rowDeviation((_i, j) => -(4 + (16 * j) / (ny - 1)), ny, 2000);
    expect(peak).toBeGreaterThan(0.05); // 浅い所で増幅している
    expect(dev / peak).toBeLessThan(0.08);
  });
});

describe('四方の開境界', () => {
  it('中央の水位の山は外へ抜け、ほとんど残らない（< 3%）', () => {
    const nx = 100;
    const ny = 100;
    const dx = 50;
    const h = 10;
    const { solver } = basin({ nx, ny, dx, z: () => -h, open: { north: true, south: true, east: true, west: true }, A: 0, T: 300 });
    solver.incident = null;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) solver.eta[j * nx + i] += 0.1 * Math.exp(-((i - 50) ** 2 + (j - 50) ** 2) / 20);
    const c = Math.sqrt(GRAVITY * h);
    const maxAbsEta = () => {
      let m = 0;
      for (let k = 0; k < nx * ny; k++) m = Math.max(m, Math.abs(solver.eta[k]));
      return m;
    };
    while (solver.t < (45 * dx) / c) solver.step(); // 輪が境界に届く直前
    const before = maxAbsEta();
    while (solver.t < (250 * dx) / c) solver.step();
    expect(maxAbsEta() / before).toBeLessThan(0.03);
  });
});
