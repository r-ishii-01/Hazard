/**
 * 本計算を行の帯に分けて複数のワーカーで並列に計算するための部品。
 *
 * 方式（領域分割）:
 * - 格子を南北方向に K 個の行の帯に分ける。各帯は自分の行（担当行）に加えて、上下に HALO_ROWS 行の
 *   「のりしろ」を持つ。
 * - 1ステップの計算で、ある行の新しい状態が依存するのは前の状態の上下3行以内（連続式・面の全水深・
 *   移流項の風上差分・流出制限）。そこで毎ステップ後に、担当行の端の HALO_ROWS 行を隣の帯へ送り、
 *   隣から受け取った行でのりしろを上書きする。のりしろの外側（局所格子の端）の値は正しくないが、
 *   担当行には影響しない。
 * - 担当行は、分割しない計算とビット単位で同じ結果になる（同じ入力から同じ順序で計算するため）。
 *   tests/sim.band.test.ts で確認している。
 */
import type { GridSpec } from '../core/geo';
import { CELL_SEA } from '../core/types';
import type { MainPlan } from './engine';
import { ShallowWaterSolver, type SideProfile, type SolverGrid } from './solver';
import { makeIncidentWave } from './wave';

/** のりしろの行数（依存範囲 3 行に余裕を持たせる） */
export const HALO_ROWS = 5;
/** 1つの帯の最小の行数 */
export const MIN_BAND_ROWS = 40;

export interface BandSpec {
  index: number;
  /** 担当行 [ownStart, ownEnd)（全体の格子の行番号） */
  ownStart: number;
  ownEnd: number;
  /** のりしろを含む局所格子の行 [localStart, localEnd) */
  localStart: number;
  localEnd: number;
}

/** 校正の試算（粗い格子）で一度でも濡れたセル */
export interface WetMap {
  mask: Uint8Array;
  nx: number;
  ny: number;
  /** 試算の格子のセルが、全体の格子の何セル分か（1辺） */
  factor: number;
}

/**
 * 行ごとの計算量の目安。計算は濡れたセルの近くだけで行うので、濡れるセルの数に比例する。
 * 校正の試算で濡れたセル（wet）があればそれを使い、なければ「初めから水のある海」1 と
 * 「浸水しそうな低い陸（潮位 + 目標の上昇量の半分より低い）」0.5 で見積もる。
 */
export function rowWorkWeights(
  grid: Pick<SolverGrid, 'nx' | 'ny' | 'z' | 'kind'>,
  tide: number,
  coastHeight: number,
  wet: WetMap | null,
): Float64Array {
  const { nx, ny } = grid;
  const w = new Float64Array(ny);
  const lowLand = tide + 0.5 * Math.max(0, coastHeight - tide);
  for (let j = 0; j < ny; j++) {
    let c = 0.02 * nx; // 行ごとの固定の手間
    const J = wet ? Math.floor(j / wet.factor) : 0;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const z = grid.z[k];
      const sea = grid.kind[k] === CELL_SEA && z < tide;
      if (wet && J < wet.ny) {
        const I = Math.min(wet.nx - 1, Math.floor(i / wet.factor));
        if (sea || wet.mask[J * wet.nx + I] === 1) c += 1;
      } else if (sea) c += 1;
      else if (grid.kind[k] === CELL_SEA || z < lowLand) c += 0.5;
    }
    w[j] = c;
  }
  return w;
}

/**
 * 行の帯への分割。計算量の目安（行ごとの重み）が等しくなるように、上（北）から順に区切る。
 * 行数が足りなければ帯を減らす（1つなら分割なし）。
 */
export function partitionRows(ny: number, weights: ArrayLike<number>, bands: number): BandSpec[] {
  const K = Math.max(1, Math.min(Math.floor(bands), Math.floor(ny / MIN_BAND_ROWS)));
  const whole = (): BandSpec[] => [{ index: 0, ownStart: 0, ownEnd: ny, localStart: 0, localEnd: ny }];
  if (K <= 1) return whole();
  let total = 0;
  for (let j = 0; j < ny; j++) total += weights[j];
  const cuts: number[] = [0];
  let acc = 0;
  let next = 1;
  for (let j = 0; j < ny && next < K; j++) {
    acc += weights[j];
    if (acc >= (total * next) / K) {
      const lo = cuts[cuts.length - 1] + MIN_BAND_ROWS;
      const hi = ny - (K - next) * MIN_BAND_ROWS;
      cuts.push(Math.min(hi, Math.max(lo, j + 1)));
      next++;
    }
  }
  while (cuts.length < K) cuts.push(Math.min(ny - (K - cuts.length) * MIN_BAND_ROWS, cuts[cuts.length - 1] + MIN_BAND_ROWS));
  cuts.push(ny);
  const out: BandSpec[] = [];
  for (let b = 0; b < K; b++) {
    const ownStart = cuts[b];
    const ownEnd = cuts[b + 1];
    if (ownEnd - ownStart < HALO_ROWS * 2) return whole();
    out.push({
      index: b,
      ownStart,
      ownEnd,
      localStart: Math.max(0, ownStart - HALO_ROWS),
      localEnd: Math.min(ny, ownEnd + HALO_ROWS),
    });
  }
  return out;
}

export interface LocalGrid {
  z: Float32Array;
  kind: Uint8Array;
  manning: Float32Array;
}

/** 全体の格子から行 [r0, r1) を切り出す（コピー） */
export function sliceRows(g: LocalGrid, nx: number, r0: number, r1: number): LocalGrid {
  return {
    z: g.z.slice(r0 * nx, r1 * nx),
    kind: g.kind.slice(r0 * nx, r1 * nx),
    manning: g.manning.slice(r0 * nx, r1 * nx),
  };
}

function sliceProfile(p: SideProfile, r0: number, r1: number): SideProfile {
  return { delay: p.delay.slice(r0, r1), a: p.a.slice(r0, r1) };
}

/** 1つの帯の計算（局所格子のソルバとのりしろのやり取り） */
export class BandRunner {
  readonly solver: ShallowWaterSolver;
  readonly band: BandSpec;
  readonly hasNorth: boolean;
  readonly hasSouth: boolean;
  /** のりしろの受け渡しに使う配列の長さ */
  readonly haloLength: number;
  /** 潮位計のセル（この帯の局所格子の添字。担当外なら −1） */
  readonly gaugeLocal: number;
  private readonly plan: MainPlan;
  private readonly nx: number;

  constructor(local: LocalGrid, spec: GridSpec, plan: MainPlan, band: BandSpec) {
    const nx = spec.nx;
    const ny = band.localEnd - band.localStart;
    if (local.z.length !== nx * ny) throw new Error('帯の地形データの大きさが一致しません');
    this.nx = nx;
    this.band = band;
    this.plan = plan;
    this.hasNorth = band.ownStart > 0;
    this.hasSouth = band.ownEnd < spec.ny;
    const grid: SolverGrid = { nx, ny, dx: spec.dx, z: local.z, kind: local.kind, manning: local.manning };
    this.solver = new ShallowWaterSolver(grid, {
      tide: plan.tide,
      landManning: plan.landManning,
      dt: plan.dt,
      t0: plan.startFrame * plan.frameInterval,
      incident: plan.incident ? makeIncidentWave(plan.incident) : null,
      open: { north: band.localStart === 0, south: band.localEnd === spec.ny, east: true, west: true },
      sides: {
        west: sliceProfile(plan.sides.west, band.localStart, band.localEnd),
        east: sliceProfile(plan.sides.east, band.localStart, band.localEnd),
      },
      initialWater: plan.initialWater.slice(band.localStart * nx, band.localEnd * nx),
    });
    this.haloLength = this.solver.haloLength(HALO_ROWS);
    const gRow = Math.floor(plan.gaugeCell / nx);
    this.gaugeLocal = gRow >= band.ownStart && gRow < band.ownEnd ? plan.gaugeCell - band.localStart * nx : -1;
  }

  step(): void {
    this.solver.step();
  }

  /** 北の帯へ送る担当行の上端 HALO_ROWS 行 */
  exportNorth(out: Float64Array): void {
    this.solver.exportRows(this.band.ownStart - this.band.localStart, HALO_ROWS, out);
  }
  /** 南の帯へ送る担当行の下端 HALO_ROWS 行 */
  exportSouth(out: Float64Array): void {
    this.solver.exportRows(this.band.ownEnd - this.band.localStart - HALO_ROWS, HALO_ROWS, out);
  }
  /** 北の帯から受け取った行で北ののりしろを上書き */
  importNorth(data: Float64Array): void {
    this.solver.importRows(this.band.ownStart - this.band.localStart - HALO_ROWS, HALO_ROWS, data);
  }
  /** 南の帯から受け取った行で南ののりしろを上書き */
  importSouth(data: Float64Array): void {
    this.solver.importRows(this.band.ownEnd - this.band.localStart, HALO_ROWS, data);
  }

  /** 潮位計の水位（担当外なら NaN） */
  gaugeEta(): number {
    return this.gaugeLocal >= 0 ? this.solver.eta[this.gaugeLocal] : NaN;
  }

  /** フレーム f の終わり: 時刻を合わせ、担当行の全水深（cm）を返す */
  finishFrame(f: number): Uint16Array {
    this.solver.t = f * this.plan.frameInterval;
    const r0 = this.band.ownStart - this.band.localStart;
    const r1 = this.band.ownEnd - this.band.localStart;
    const out = new Uint16Array((r1 - r0) * this.nx);
    if (!this.solver.encodeRowsCm(r0, r1, out)) throw new Error('UNSTABLE');
    return out;
  }

  /** 担当行の最大浸水深・最大水位・到達時刻 */
  statsPart(): { maxDepth: Float32Array; maxEta: Float32Array; arrival: Float32Array } {
    const r0 = this.band.ownStart - this.band.localStart;
    const r1 = this.band.ownEnd - this.band.localStart;
    const len = (r1 - r0) * this.nx;
    const s = { maxDepth: new Float32Array(len), maxEta: new Float32Array(len), arrival: new Float32Array(len) };
    this.solver.copyMaxDepth(s.maxDepth, r0, r1);
    this.solver.copyMaxEta(s.maxEta, r0, r1);
    this.solver.copyArrival(s.arrival, r0, r1);
    return s;
  }
}

/** 同じスレッド内で隣り合う帯ののりしろを交換する（テスト・検証用） */
export function exchangeHalosSync(runners: BandRunner[]): void {
  for (let b = 0; b + 1 < runners.length; b++) {
    const upper = runners[b];
    const lower = runners[b + 1];
    const down = new Float64Array(upper.haloLength);
    const up = new Float64Array(lower.haloLength);
    upper.exportSouth(down);
    lower.exportNorth(up);
    lower.importNorth(down);
    upper.importSouth(up);
  }
}
