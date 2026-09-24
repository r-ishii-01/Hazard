/**
 * 水域セルの分類（純粋関数）。
 *
 * - 水域（標高が NaN のセル）の4近傍連結成分を求める。
 * - 格子の南端（沖。範囲の南端は全体が海）に接する成分は海（CELL_SEA）。海につながった河川（引地川・境川など）も
 *   同じ成分になるので海扱い。東・西・北端に接するだけの水域（範囲の外でつながっているかもしれない川や池）は
 *   海とはみなさない（範囲内で海とつながっていれば、南端からたどれるので海になる）。
 * - それ以外（池・調整池、上流で途切れた河川片など）は内水面（CELL_INLAND_WATER）。
 *   計算上は陸なので、標高は成分の周囲の陸セルの最低標高（あふれ出す高さ）とする。
 * - isolated が与えられた場合、isolated[k] が真の水域セル（海とつながった水面の画素を含まない＝池の水面だけのセル）は
 *   海の成分に含めない。セルの大きさより狭い堤で川と隔てられた池が、セルに平均しただけで川とつながるのを防ぐ。
 * - 陸は標高データのとおり（江の島のように海に囲まれた陸もそのまま陸）。
 */
import { CELL_INLAND_WATER, CELL_LAND, CELL_SEA } from '../core/types';

export interface ClassifyResult {
  /** セル種別 */
  kind: Uint8Array;
  /** 地盤高 [m]。陸はそのまま、内水面は周囲の陸の最低標高、海は NaN（後で水深を与える） */
  z: Float32Array;
  seaCells: number;
  inlandCells: number;
  inlandComponents: number;
}

export interface ClassifyOptions {
  /** 海とみなす格子端（既定: 南のみ） */
  seaEdges?: { north?: boolean; south?: boolean; east?: boolean; west?: boolean };
  /** isolated[k] が真の水域セルは海の成分に含めない（池の水面だけを含むセル）。長さ nx*ny */
  isolated?: ArrayLike<number | boolean> | null;
}

export function classifyWater(elev: Float32Array, nx: number, ny: number, opts: ClassifyOptions = {}): ClassifyResult {
  const edges = { north: false, south: true, east: false, west: false, ...opts.seaEdges };
  const isolated = opts.isolated ?? null;
  const iso = (k: number) => (isolated && isolated[k] ? 1 : 0);
  const n = nx * ny;
  const kind = new Uint8Array(n);
  const z = new Float32Array(n);
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let seaCells = 0;
  let inlandCells = 0;
  let inlandComponents = 0;
  let compId = 0;

  for (let k = 0; k < n; k++) {
    const v = elev[k];
    if (v === v) {
      kind[k] = CELL_LAND;
      z[k] = v;
    }
  }

  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1 || elev[start] === elev[start]) continue;
    // 幅優先探索で成分を集める
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    comp[start] = compId;
    const group = iso(start);
    let touchesSea = false;
    let spill = Number.POSITIVE_INFINITY;
    while (head < tail) {
      const k = queue[head++];
      const i = k % nx;
      const j = (k - i) / nx;
      if (!group && ((edges.west && i === 0) || (edges.east && i === nx - 1) || (edges.south && j === ny - 1) || (edges.north && j === 0))) {
        touchesSea = true;
      }
      // 4近傍
      for (let d = 0; d < 4; d++) {
        let kk: number;
        if (d === 0) {
          if (i === 0) continue;
          kk = k - 1;
        } else if (d === 1) {
          if (i === nx - 1) continue;
          kk = k + 1;
        } else if (d === 2) {
          if (j === 0) continue;
          kk = k - nx;
        } else {
          if (j === ny - 1) continue;
          kk = k + nx;
        }
        const ev = elev[kk];
        if (ev === ev) {
          if (ev < spill) spill = ev;
        } else if (comp[kk] === -1 && iso(kk) === group) {
          comp[kk] = compId;
          queue[tail++] = kk;
        }
      }
    }
    if (touchesSea) {
      for (let q = 0; q < tail; q++) {
        const k = queue[q];
        kind[k] = CELL_SEA;
        z[k] = Number.NaN;
      }
      seaCells += tail;
    } else {
      const level = Number.isFinite(spill) ? spill : 0;
      for (let q = 0; q < tail; q++) {
        const k = queue[q];
        kind[k] = CELL_INLAND_WATER;
        z[k] = level;
      }
      inlandCells += tail;
      inlandComponents++;
    }
    compId++;
  }
  return { kind, z, seaCells, inlandCells, inlandComponents };
}
