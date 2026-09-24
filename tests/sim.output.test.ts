import { describe, expect, it } from 'vitest';
import type { GridSpec } from '../src/core/geo';
import type { EngineStartInfo } from '../src/sim/engine';
import { SimRunOutput } from '../src/sim/output';

const spec: GridSpec = { zoom: 15, originPx: 0, originPy: 0, cellPx: 4, nx: 3, ny: 2, dx: 15.6 };
const z = Float32Array.from([-10, -2, 1, 2, 3, 0.5]);
const info: EngineStartInfo = {
  frameInterval: 20,
  durationSec: 60,
  lastFrame: 3,
  tide: 0,
  gauge: { lon: 139.47, lat: 35.31, cell: 0, interval: 10, capacity: 7 },
  segment: { cells: 1, rule: 'kugenuma' },
};

function make() {
  const out = new SimRunOutput(spec, z, info, 8);
  out.addFrame(0, Uint16Array.from([1000, 200, 0, 0, 0, 0]));
  out.addGauge([0], [0]);
  return out;
}

describe('SimRunOutput（フレームの保持と時刻補間）', () => {
  it('基本情報と初期値', () => {
    const out = make();
    expect(out.framesReady()).toBe(1);
    expect(out.timeReady()).toBe(0);
    expect(out.frameInterval).toBe(20);
    expect(out.durationSec).toBe(60);
    expect(out.calibration.targetCoastHeight).toBe(8);
    expect(out.gauge.count()).toBe(1);
    // 最初から水のあるセルの最大水位は潮位、陸は NaN
    expect(out.maxEta[0]).toBeCloseTo(0, 5);
    expect(Number.isNaN(out.maxEta[2])).toBe(true);
    expect(out.arrival[2]).toBe(Infinity);
    expect(out.achievedCoastMax()).toBe(0);
  });

  it('フレーム間を線形補間し、受信済みの最後のフレームで打ち切る', () => {
    const out = make();
    out.addFrame(1, Uint16Array.from([1100, 300, 50, 0, 0, 0]));
    out.addFrame(2, Uint16Array.from([900, 100, 150, 20, 0, 0]));
    expect(out.framesReady()).toBe(3);
    expect(out.timeReady()).toBe(40);
    expect(out.depthAt(0, 0)).toBeCloseTo(10, 6);
    expect(out.depthAt(10, 0)).toBeCloseTo(10.5, 6);
    expect(out.depthAt(30, 2)).toBeCloseTo(1.0, 6);
    expect(out.depthAt(35, 3)).toBeCloseTo(0.15, 6);
    // 範囲外の時刻は端のフレーム
    expect(out.depthAt(-5, 0)).toBeCloseTo(10, 6);
    expect(out.depthAt(NaN, 0)).toBeCloseTo(10, 6);
    expect(out.depthAt(1e6, 2)).toBeCloseTo(1.5, 6);
    // 水位 = 地盤高 + 水深、乾燥セルは NaN
    expect(out.etaAt(10, 0)).toBeCloseTo(0.5, 5);
    expect(out.etaAt(40, 2)).toBeCloseTo(2.5, 5);
    expect(Number.isNaN(out.etaAt(0, 2))).toBe(true);
    expect(Number.isNaN(out.etaAt(40, 4))).toBe(true);
    // 範囲外のセル
    expect(out.depthAt(0, 99)).toBe(0);
  });

  it('fillDepth は depthAt と一致する', () => {
    const out = make();
    out.addFrame(1, Uint16Array.from([1100, 300, 50, 0, 0, 0]));
    const buf = new Float32Array(6);
    for (const t of [0, 5, 20, 27.5, 100]) {
      out.fillDepth(t, buf);
      for (let k = 0; k < 6; k++) expect(buf[k]).toBeCloseTo(out.depthAt(t, k), 5);
    }
  });

  it('null のフレームはフレーム 0 と同じ（静止状態）', () => {
    const out = make();
    out.addFrame(1, null);
    out.addFrame(2, null);
    expect(out.framesReady()).toBe(3);
    expect(out.depthAt(35, 0)).toBeCloseTo(10, 6);
    expect(() => out.addFrame(5, null)).toThrow();
  });

  it('最大値・校正・潮位計の更新', () => {
    const out = make();
    const rev = out.revision;
    const md = Float32Array.from([0, 0, 1.2, 0.3, 0, 0]);
    const me = Float32Array.from([2, 2, 2.2, 2.3, NaN, NaN]);
    const ar = Float32Array.from([Infinity, Infinity, 600, 660, Infinity, Infinity]);
    out.setStats(md, me, ar, 6.5);
    expect(out.revision).toBeGreaterThan(rev);
    expect(out.maxDepth[2]).toBeCloseTo(1.2, 6);
    expect(out.arrival[3]).toBe(660);
    expect(out.achievedCoastMax()).toBe(6.5);
    out.setCalibration({
      targetCoastHeight: 8,
      boundaryAmplitude: 3.2,
      boundaryStartSec: 300,
      expectedCrestSec: 720,
      trials: [],
      notes: ['注記'],
    });
    expect(out.calibration.boundaryAmplitude).toBe(3.2);
    expect(out.notes).toEqual(['注記']);
    out.addGauge([10, 20, 30, 40, 50, 60, 70, 80], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    expect(out.gauge.count()).toBe(7); // 容量で打ち切り
    expect(out.gauge.t[6]).toBe(60);
    expect(out.gauge.eta[1]).toBeCloseTo(0.1, 6);
  });
});
