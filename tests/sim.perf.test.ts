/**
 * 計算速度の測定（結果は標準出力に表示）。
 * 共有の CI 環境では速度がばらつくので、判定はごく緩い下限だけにしている。
 * SIM_BENCH=1 のときは standard 格子で 60 分の計算全体（校正を含む）も測る。
 */
import { describe, expect, it } from 'vitest';
import type { QuakeScenario, SimParams } from '../src/core/types';
import { runEngine } from '../src/sim/engine';
import { ShallowWaterSolver, maxStillDepth, stableTimeStep } from '../src/sim/solver';
import { makeKugenumaLikeGrid } from '../src/sim/synthetic';
import { makeIncidentWave } from '../src/sim/wave';

// tsconfig に Node の型を入れていないので、必要な分だけ型を付けて参照する
const nodeProcess = (
  globalThis as unknown as {
    process: { cpuUsage(): { user: number; system: number }; env: Record<string, string | undefined> };
  }
).process;

const cpuMs = () => {
  const u = nodeProcess.cpuUsage();
  return (u.user + u.system) / 1000;
};

const scenario: QuakeScenario = {
  id: 'bench',
  name: '性能測定用',
  shortName: '測定',
  magnitude: null,
  shindo: '7',
  coastHeight: 8,
  arrivalMin: 12,
  periodMin: 15,
  firstMotion: 'rise',
  waves: 3,
  shakingSec: 60,
  warning: 'major',
  description: '',
  isOfficial: false,
};

describe('計算速度', () => {
  it('standard 格子（約 15.6 m、352×394）の1ステップあたりの計算時間', () => {
    const g = makeKugenumaLikeGrid({ resolution: 'standard' });
    const { nx, ny, dx } = g.spec;
    const dt = stableTimeStep(dx, maxStillDepth(g, 0), 8);
    const incident = makeIncidentWave({ amplitude: 4, periodSec: 900, waves: 3, firstMotion: 'rise', startSec: 0 });
    const s = new ShallowWaterSolver({ nx, ny, dx, z: g.z, kind: g.kind, manning: g.manning }, { tide: 0, landManning: 0.06, dt, incident });
    // 波が海岸に届き、陸に上がり始めるところまで進めてから測る
    while (s.t < 600) s.step();
    const steps = 400;
    const w0 = performance.now();
    const c0 = cpuMs();
    for (let i = 0; i < steps; i++) s.step();
    const wall = performance.now() - w0;
    const cpu = cpuMs() - c0;
    const stepsPerSec = steps / (wall / 1000);
    const active = s.activeCells();
    // 60 分の計算（波が境界に入るまでの静止時間 約 5 分を除く）の見込み
    const est = ((55 * 60) / dt / stepsPerSec).toFixed(1);
    console.info(
      `[sim perf] standard ${nx}×${ny}, dt=${dt.toFixed(3)} s, 計算セル ${active}: ` +
        `${stepsPerSec.toFixed(0)} steps/s（${(wall / steps).toFixed(2)} ms/step, CPU ${(cpu / steps).toFixed(2)} ms/step, ` +
        `${((wall * 1e6) / steps / active).toFixed(0)} ns/セル）→ 60 分の本計算 約 ${est} 秒`,
    );
    expect(stepsPerSec).toBeGreaterThan(5);
    for (let k = 0; k < s.n; k += 97) expect(Number.isFinite(s.eta[k])).toBe(true);
  }, 120_000);

  it.skipIf(!nodeProcess.env.SIM_BENCH)(
    'standard 格子で 60 分の計算全体（校正を含む）',
    () => {
      const g = makeKugenumaLikeGrid({ resolution: 'standard' });
      const params: SimParams = { scenario, tideTP: 0, durationMin: 60, resolution: 'standard', landManning: 0.06 };
      const w0 = performance.now();
      let achieved = NaN;
      const perf = runEngine(
        { spec: g.spec, z: g.z, kind: g.kind, manning: g.manning, params },
        { start() {}, frame() {}, calibrated() {}, stats: (s) => (achieved = s.achievedCoastMax), progress() {} },
      );
      const wall = performance.now() - w0;
      console.info(
        `[sim perf] standard 60 分: 合計 ${(wall / 1000).toFixed(1)} 秒（校正 ${(perf.calibrationMs / 1000).toFixed(1)} 秒、` +
          `本計算 ${(perf.mainMs / 1000).toFixed(1)} 秒、${perf.steps} steps、${perf.stepsPerSec.toFixed(0)} steps/s、dt=${perf.dt.toFixed(3)} s）` +
          ` 海岸の最大水位 ${achieved.toFixed(2)} m（目標 ${scenario.coastHeight} m）`,
      );
      expect(Math.abs(achieved - scenario.coastHeight) / scenario.coastHeight).toBeLessThan(0.15);
    },
    600_000,
  );
});
