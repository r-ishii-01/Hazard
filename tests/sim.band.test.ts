import { describe, expect, it } from 'vitest';
import type { QuakeScenario, SimParams } from '../src/core/types';
import { BandRunner, HALO_ROWS, exchangeHalosSync, partitionRows, rowWorkWeights, sliceRows, type BandSpec } from '../src/sim/band';
import { prepareRun, type EngineSink } from '../src/sim/engine';
import { makeKugenumaLikeGrid } from '../src/sim/synthetic';

const scenario: QuakeScenario = {
  id: 'band',
  name: '分割計算の検証用',
  shortName: '検証',
  magnitude: null,
  shindo: '7',
  coastHeight: 9,
  arrivalMin: 9,
  periodMin: 10,
  firstMotion: 'rise',
  waves: 2,
  shakingSec: 60,
  warning: 'major',
  description: '',
  isOfficial: false,
};

const nullSink: EngineSink = { start() {}, frame() {}, calibrated() {}, stats() {}, progress() {} };

function bandsFromCuts(ny: number, cuts: number[]): BandSpec[] {
  const edges = [0, ...cuts, ny];
  return edges.slice(0, -1).map((ownStart, index) => {
    const ownEnd = edges[index + 1];
    return {
      index,
      ownStart,
      ownEnd,
      localStart: Math.max(0, ownStart - HALO_ROWS),
      localEnd: Math.min(ny, ownEnd + HALO_ROWS),
    };
  });
}

describe('行の帯に分けた並列計算', () => {
  const g = makeKugenumaLikeGrid({ resolution: 'coarse' });
  const { nx, ny } = g.spec;
  const params: SimParams = { scenario, tideTP: 0, durationMin: 30, resolution: 'coarse', landManning: 0.06 };

  it('計算量が均等になるよう分割し、各帯は十分な行数を持つ', () => {
    const bands = partitionRows(ny, rowWorkWeights({ nx, ny, z: g.z, kind: g.kind }, 0, 9, null), 4);
    expect(bands.length).toBe(4);
    expect(bands[0].ownStart).toBe(0);
    expect(bands[bands.length - 1].ownEnd).toBe(ny);
    for (let b = 0; b < bands.length; b++) {
      expect(bands[b].ownEnd - bands[b].ownStart).toBeGreaterThanOrEqual(40);
      if (b > 0) expect(bands[b].ownStart).toBe(bands[b - 1].ownEnd);
    }
    // 行数が足りなければ分割しない
    expect(partitionRows(60, new Float64Array(60).fill(1), 4).length).toBe(1);
    // 重みが偏っていても各帯は最小の行数を持つ
    const skew = new Float64Array(ny);
    skew[ny - 1] = 1000;
    for (const b of partitionRows(ny, skew, 3)) expect(b.ownEnd - b.ownStart).toBeGreaterThanOrEqual(40);
  });

  it('分割しない計算とビット単位で同じ結果になる（汀線・川・浸水域をまたぐ境界）', () => {
    const input = { spec: g.spec, z: g.z, kind: g.kind, manning: g.manning, params };
    const { plan, solver: serial } = prepareRun(input, nullSink, { bands: 1 });
    // 浸水する平地・汀線付近・沖を横切る境界にする（各帯は のりしろの2倍以上の行数）
    const shoreRow = (() => {
      const i = Math.floor(nx / 2);
      for (let j = 0; j < ny; j++) if (g.kind[j * nx + i] === 1 && g.kind[(j - 1) * nx + i] !== 1) return j;
      return Math.floor(ny / 2);
    })();
    const bands = bandsFromCuts(ny, [shoreRow - 40, shoreRow - 14, shoreRow - 2, shoreRow + 10, shoreRow + 60]);
    const runners = bands.map((b) => new BandRunner(sliceRows(g, nx, b.localStart, b.localEnd), g.spec, plan, b));
    const frames = 45; // 15 分（第1波が陸に上がり、引き始めるまで）
    let floodedLand = 0;
    for (let f = plan.startFrame + 1; f <= plan.startFrame + frames && f <= plan.lastFrame; f++) {
      for (let s = 0; s < plan.stepsPerFrame; s++) {
        serial.step();
        for (const r of runners) r.step();
        exchangeHalosSync(runners);
      }
      serial.t = f * plan.frameInterval;
      const full = new Uint16Array(nx * ny);
      serial.encodeDepthCm(full);
      for (const r of runners) {
        const part = r.finishFrame(f);
        const b = r.band;
        expect(part.length).toBe((b.ownEnd - b.ownStart) * nx);
        let same = true;
        for (let k = 0; k < part.length; k++) if (part[k] !== full[b.ownStart * nx + k]) same = false;
        expect(same).toBe(true);
      }
    }
    // 状態（水位・線流量）と最大値の記録が担当行で完全に一致する
    for (const r of runners) {
      const b = r.band;
      const off = b.localStart;
      let diff = 0;
      for (let j = b.ownStart; j < b.ownEnd; j++) {
        for (let i = 0; i < nx; i++) {
          const kg = j * nx + i;
          const kl = (j - off) * nx + i;
          if (r.solver.eta[kl] !== serial.eta[kg]) diff++;
          if (r.solver.maxEta[kl] !== serial.maxEta[kg]) diff++;
          if (r.solver.arrival[kl] !== serial.arrival[kg]) diff++;
          if (r.solver.N[kl] !== serial.N[kg]) diff++;
          if (serial.isLand[kg] && serial.maxDepth[kg] > 0.01) floodedLand++;
        }
        for (let i = 0; i <= nx; i++) if (r.solver.M[(j - off) * (nx + 1) + i] !== serial.M[j * (nx + 1) + i]) diff++;
      }
      expect(diff).toBe(0);
    }
    expect(floodedLand).toBeGreaterThan(500);
  }, 120_000);
});
