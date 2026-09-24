/**
 * 入射波の波形（src/sim/wave.ts）と、各波の相対振幅（QuakeScenario.waveAmplitudes）を与えた場合の校正の検証。
 * - 相対振幅は最大を 1 に正規化し、足りない波は最後の値を繰り返す
 * - 第 i 波の山の値は A × 相対振幅、波の境目は 0（連続）
 * - 校正は、海岸の最大水位（全体の最大）を coastHeight に、最大の波の山を arrivalMin に合わせる
 */
import { describe, expect, it } from 'vitest';
import type { QuakeScenario, SimParams, TerrainGrid } from '../src/core/types';
import { coastMax, crestTimeNear, maxCrestWindow, prepareRun, type CalibrationInfo, type EngineSink } from '../src/sim/engine';
import { makeKugenumaLikeGrid } from '../src/sim/synthetic';
import {
  DECAY_PER_WAVE,
  firstCrestFactor,
  firstCrestOffset,
  makeIncidentWave,
  maxCrestOffset,
  maxWaveIndex,
  relativeAmplitudes,
} from '../src/sim/wave';

describe('relativeAmplitudes', () => {
  it('最大を 1 に正規化し、波の数に合わせて最後の値を繰り返す／切り詰める', () => {
    expect(relativeAmplitudes([2, 1, 0.5], 3)).toEqual([1, 0.5, 0.25]);
    expect(relativeAmplitudes([1, 0.5], 4)).toEqual([1, 0.5, 0.5, 0.5]);
    expect(relativeAmplitudes([0.5, 1, 0.25], 1)).toEqual([1]); // 先頭の 1 波だけ → それが最大
    expect(relativeAmplitudes([0.3, 0.6], 2)).toEqual([0.5, 1]);
  });

  it('無効な指定は null（既定の減衰する波形を使う）', () => {
    expect(relativeAmplitudes(undefined, 3)).toBeNull();
    expect(relativeAmplitudes([], 3)).toBeNull();
    expect(relativeAmplitudes([0, -1, NaN], 3)).toBeNull();
    // 負・非数の波は 0 とみなす
    expect(relativeAmplitudes([1, NaN, 0.5], 3)).toEqual([1, 0, 0.5]);
  });
});

describe('makeIncidentWave（相対振幅を与えた場合）', () => {
  const T = 600;
  const A = 3;
  const t0 = 100;
  const amps = [0.5, 1, 0.4];

  it('第 i 波の山は A × 相対振幅、波の境目と入力の前後は 0', () => {
    const f = makeIncidentWave({ amplitude: A, periodSec: T, waves: 3, firstMotion: 'rise', startSec: t0, amplitudes: amps });
    for (let i = 0; i < 3; i++) expect(f(t0 + (i + 0.25) * T)).toBeCloseTo(A * amps[i], 9);
    for (let i = 0; i <= 3; i++) {
      expect(Math.abs(f(t0 + i * T - 1e-6))).toBeLessThan(1e-6);
      expect(Math.abs(f(t0 + i * T + 1e-6))).toBeLessThan(1e-6);
    }
    expect(f(t0 - 10)).toBe(0);
    expect(f(t0 + 3 * T + 10)).toBe(0);
    // 波形は連続（細かく刻んだ隣り合う値の差が小さい）
    let prev = f(0);
    for (let t = 0; t <= t0 + 3.2 * T; t += 1) {
      const v = f(t);
      expect(Math.abs(v - prev)).toBeLessThan((2 * Math.PI * A) / T + 1e-9);
      prev = v;
    }
  });

  it("引き波から（'fall'）は符号が逆で、最大の波の山は 3/4 周期", () => {
    const f = makeIncidentWave({ amplitude: A, periodSec: T, waves: 3, firstMotion: 'fall', startSec: 0, amplitudes: amps });
    expect(f(0.25 * T)).toBeCloseTo(-A * 0.5, 9);
    expect(f(1.75 * T)).toBeCloseTo(A, 9);
    expect(maxCrestOffset({ periodSec: T, firstMotion: 'fall', waves: 3, amplitudes: amps })).toBeCloseTo(1.75 * T, 9);
  });

  it('最大の波の番号と山の時刻', () => {
    expect(maxWaveIndex({ waves: 3, amplitudes: amps })).toBe(1);
    expect(maxWaveIndex({ waves: 3, amplitudes: [1, 1, 0.5] })).toBe(0); // 同じ大きさなら先の波
    expect(maxWaveIndex({ waves: 3 })).toBe(0);
    expect(maxCrestOffset({ periodSec: T, firstMotion: 'rise', waves: 3, amplitudes: amps })).toBeCloseTo(1.25 * T, 9);
    expect(firstCrestFactor({ periodSec: T, firstMotion: 'rise', waves: 3, amplitudes: amps })).toBeCloseTo(0.5, 9);
  });

  it('相対振幅を与えない場合は従来どおり 1 波ごとに 0.75 倍へ連続的に減衰し、最大は第1波', () => {
    const f = makeIncidentWave({ amplitude: A, periodSec: T, waves: 3, firstMotion: 'rise', startSec: 0 });
    for (const tau of [37, 150, 777, 1234, 1700]) {
      expect(f(tau)).toBeCloseTo(A * Math.sin((2 * Math.PI * tau) / T) * Math.pow(DECAY_PER_WAVE, tau / T), 9);
    }
    const off = firstCrestOffset({ periodSec: T, firstMotion: 'rise' });
    expect(maxCrestOffset({ periodSec: T, firstMotion: 'rise', waves: 3 })).toBe(off);
    // 最初の山は包絡線の極大（前後より高い）
    expect(f(off)).toBeGreaterThan(f(off - 1));
    expect(f(off)).toBeGreaterThan(f(off + 1));
  });
});

describe('無効な相対振幅', () => {
  it('正の値が無い相対振幅は無視し、波形も山の時刻も既定の減衰する波形と同じ', () => {
    const base = { amplitude: 2, periodSec: 600, waves: 3, firstMotion: 'rise' as const, startSec: 0 };
    const f0 = makeIncidentWave(base);
    const f1 = makeIncidentWave({ ...base, amplitudes: [0, 0, 0] });
    for (const t of [10, 150, 500, 1234]) expect(f1(t)).toBe(f0(t));
    expect(firstCrestOffset({ periodSec: 600, firstMotion: 'rise', amplitudes: [0, 0, 0], waves: 3 })).toBe(
      firstCrestOffset({ periodSec: 600, firstMotion: 'rise' }),
    );
  });
});

describe('Worker への受け渡し', () => {
  it('相対振幅を含む入射波の指定は構造化複製（postMessage）後も同じ波形になる', () => {
    const spec = { amplitude: 3.7, periodSec: 1200, waves: 6, firstMotion: 'rise' as const, startSec: 1316, amplitudes: [0.3, 1, 0.5, 0.5, 0.5, 0.5] };
    const f0 = makeIncidentWave(spec);
    const f1 = makeIncidentWave(structuredClone(spec));
    for (let t = 0; t < 1316 + 6 * 1200 + 100; t += 37) expect(f1(t)).toBe(f0(t));
    // 第1波の山は 0.3 倍、第2波の山が最大
    expect(f1(1316 + 300)).toBeCloseTo(0.3 * 3.7, 9);
    expect(f1(1316 + 1500)).toBeCloseTo(3.7, 9);
  });
});

describe('maxCrestWindow', () => {
  it('境界の山の時刻 + 伝播時間の見込みの 0.5〜1 倍を、前後半周期の幅で含む', () => {
    const off = 1500;
    const travel = 288;
    for (const T of [120, 1200]) {
      const [c, h] = maxCrestWindow(off, travel, T);
      // 線形の伝播時間どおりの山と、その半分の時間で届く山の両方が範囲に入る
      expect(c - h).toBeCloseTo(off + 0.5 * travel - 0.5 * T, 9);
      expect(c + h).toBeCloseTo(off + travel + 0.5 * T, 9);
    }
    // 伝播時間が求まらない（0）なら従来どおり山の時刻の前後半周期
    expect(maxCrestWindow(off, 0, 1200)).toEqual([off, 600]);
  });
});

describe('crestTimeNear', () => {
  it('指定した時刻の前後で最も高い極大の時刻（無ければ NaN）', () => {
    const t = Array.from({ length: 200 }, (_, i) => i * 10);
    const v = t.map((x) => Math.sin((2 * Math.PI * x) / 500) * (x > 700 ? 2 : 1));
    // 山は 125, 625, 1125, 1625 秒付近（後ろ2つは2倍）
    expect(Math.abs(crestTimeNear(t, v, 1100, 250) - 1125)).toBeLessThanOrEqual(10);
    expect(Math.abs(crestTimeNear(t, v, 600, 100) - 625)).toBeLessThanOrEqual(10);
    // 窓の中に複数の山があれば高い方（1125 秒の山は 625 秒の山の2倍）
    expect(Math.abs(crestTimeNear(t, v, 875, 300) - 1125)).toBeLessThanOrEqual(10);
    expect(crestTimeNear(t, v, 380, 50)).toBeNaN();
  });
});

describe('校正: 後の波を最大にした場合', () => {
  /** 鵠沼海岸に似せた小さな合成地形（約 31 m 格子） */
  const grid: TerrainGrid = makeKugenumaLikeGrid({
    resolution: 'coarse',
    bounds: { west: 139.445, east: 139.495, south: 35.297, north: 35.322 },
    shelfDepth: 12,
    duneHeight: 0,
    plainHeight: 3,
    island: false,
    rivers: false,
  });
  const scenario: QuakeScenario = {
    id: 'amps',
    name: '相対振幅の検証用',
    shortName: '検証',
    magnitude: null,
    shindo: '6+',
    coastHeight: 5,
    arrivalMin: 20,
    periodMin: 8,
    firstMotion: 'rise',
    waves: 3,
    waveAmplitudes: [0.4, 1, 0.5],
    shakingSec: 60,
    warning: 'major',
    description: '',
    isOfficial: false,
  };

  it('海岸の最大水位が目標の ±15%、最大の波（第2波）の山が到達時間の ±1 分に届き、第1波は小さい', () => {
    const params: SimParams = { scenario, tideTP: 0, durationMin: 40, resolution: 'coarse', landManning: 0.06 };
    let cal: CalibrationInfo | null = null;
    const sink: EngineSink = { start() {}, frame() {}, calibrated: (c) => (cal = c), stats() {}, progress() {} };
    const prep = prepareRun({ spec: grid.spec, z: grid.z, kind: grid.kind, manning: grid.manning, params }, sink);
    expect(prep.plan.incident?.amplitudes).toEqual([0.4, 1, 0.5]);
    const c = cal as unknown as CalibrationInfo;
    expect(c.expectedCrestSec).toBeCloseTo(20 * 60, 6);
    expect(c.notes.join('')).not.toContain('到達は約');
    // 本計算を進めながら校正区間の平均水位を記録する
    const seg = prep.plan.segmentCells;
    const ts: number[] = [];
    const ms: number[] = [];
    const { solver, plan } = prep;
    solver.t = plan.startFrame * plan.frameInterval;
    while (solver.t < plan.durationSec - 1e-6) {
      solver.step();
      let s = 0;
      for (let i = 0; i < seg.length; i++) s += solver.eta[seg[i]];
      ts.push(solver.t);
      ms.push(s / seg.length);
    }
    let iMax = 0;
    ms.forEach((v, i) => {
      if (v > ms[iMax]) iMax = i;
    });
    expect(Math.abs(ts[iMax] - 20 * 60)).toBeLessThan(60);
    // 第1波（最大の波の約1周期前）の山は最大の波より十分小さい
    const first = crestTimeNear(ts, ms, ts[iMax] - 8 * 60, 4 * 60);
    expect(Number.isFinite(first)).toBe(true);
    expect(ms[ts.indexOf(first)]).toBeLessThan(0.7 * ms[iMax]);
    // 海岸の最大水位（校正区間の各セルの最大水位の 90 パーセンタイル）
    expect(Math.abs(coastMax(solver, seg, 0) - 5) / 5).toBeLessThan(0.15);
  }, 120_000);

  it('後の波も同程度（0.9 倍）なら、試算はその山まで含め、全部の波を通した海岸の最大水位が目標の ±15%', () => {
    // 試算の計算時間が「第1波の山 + 1.5 周期」だけだと、後の波で海岸の水位が目標を超えても校正に反映されない
    const sc = { ...scenario, waves: 3, waveAmplitudes: [1, 0.9, 0.9] };
    const params: SimParams = { scenario: sc, tideTP: 0, durationMin: 50, resolution: 'coarse', landManning: 0.06 };
    let cal: CalibrationInfo | null = null;
    const sink: EngineSink = { start() {}, frame() {}, calibrated: (c) => (cal = c), stats() {}, progress() {} };
    const prep = prepareRun({ spec: grid.spec, z: grid.z, kind: grid.kind, manning: grid.manning, params }, sink);
    const c = cal as unknown as CalibrationInfo;
    // 最大の波は第1波（同じ大きさなら先の波）→ その山を到達時間に合わせる
    expect(c.expectedCrestSec).toBeCloseTo(20 * 60, 6);
    const { solver, plan } = prep;
    solver.t = plan.startFrame * plan.frameInterval;
    while (solver.t < plan.durationSec - 1e-6) solver.step();
    // 本計算は第3波の山（入力開始 + 2.25 周期 + 伝播）より後まで進んでいる
    expect(plan.durationSec).toBeGreaterThan(c.boundaryStartSec + 2.25 * 8 * 60 + 120);
    expect(Math.abs(coastMax(solver, plan.segmentCells, 0) - 5) / 5).toBeLessThan(0.15);
  }, 120_000);
});
