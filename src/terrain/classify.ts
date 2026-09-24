/**
 * 水域セルの分類（純粋関数）。
 *
 * - 水域（標高が NaN のセル）の4近傍連結成分を求める。
 * - 南・東・西の格子端に接する成分は海（CELL_SEA）。海につながった河川（引地川・境川など）も同じ成分になるので海扱い。
 * - それ以外（池・調整池、上流で途切れた河川片など）は内水面（CELL_INLAND_WATER）。
 *   計算上は陸なので、標高は成分の周囲の陸セルの最低標高（あふれ出す高さ）とする。
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
  /** 海とみなす格子端（既定: 南・東・西） */
  seaEdges?: { north?: boolean; south?: boolean; east?: boolean; west?: boolean };
}

export function classifyWater(elev: Float32Array, nx: number, ny: number, opts: ClassifyOptions = {}): ClassifyResult {
  const edges = { north: false, south: true, east: true, west: true, ...opts.seaEdges };
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
    let touchesSea = false;
    let spill = Number.POSITIVE_INFINITY;
    while (head < tail) {
      const k = queue[head++];
      const i = k % nx;
      const j = (k - i) / nx;
      if ((edges.west && i === 0) || (edges.east && i === nx - 1) || (edges.south && j === ny - 1) || (edges.north && j === 0)) {
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
        } else if (comp[kk] === -1) {
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

export interface GapOptions {
  /** 橋渡しに使えるセルの水面画素の割合の下限（既定 0.2） */
  minFrac?: number;
  /** 一度に橋渡しする最大セル数（既定 2） */
  maxGap?: number;
  /** 繰り返しの上限（既定 50） */
  maxIterations?: number;
}

/**
 * 細い河川が粗い格子で途切れるのを補う（elev をその場で書き換え、水域にしたセル数を返す）。
 *
 * 川幅がセルと同程度だと、「無効値が半分以上なら水域」の規則では川が所々で陸になり、上流側が海から切り離される。
 * そこで、海につながった水域から、水面画素を minFrac 以上含むセルだけを通って maxGap セル以内で
 * 内水面（切り離された川の続きなど）に届く場合、その経路のセルを水域にする。これを変化がなくなるまで繰り返す。
 * 海岸線（海と陸の境）そのものは動かさない（内水面に届く経路だけを水域にする）。
 */
export function bridgeWaterGaps(elev: Float32Array, waterFrac: Float32Array, nx: number, ny: number, opts: GapOptions = {}): number {
  const minFrac = opts.minFrac ?? 0.2;
  const maxGap = opts.maxGap ?? 2;
  const maxIter = opts.maxIterations ?? 50;
  const n = nx * ny;
  const comp = new Int32Array(n);
  const dist = new Int32Array(n);
  const parent = new Int32Array(n);
  const queue = new Int32Array(n);
  let converted = 0;

  const neighbours = (k: number, out: number[]) => {
    out.length = 0;
    const i = k % nx;
    const j = (k - i) / nx;
    if (i > 0) out.push(k - 1);
    if (i < nx - 1) out.push(k + 1);
    if (j > 0) out.push(k - nx);
    if (j < ny - 1) out.push(k + nx);
  };
  const nb: number[] = [];

  for (let iter = 0; iter < maxIter; iter++) {
    // 水域の連結成分: 1 = 海につながる、2 以上 = 内水面（成分番号）、0 = 陸
    comp.fill(0);
    let next = 2;
    for (let s = 0; s < n; s++) {
      if (comp[s] !== 0 || elev[s] === elev[s]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = s;
      comp[s] = -1;
      let sea = false;
      while (head < tail) {
        const k = queue[head++];
        const i = k % nx;
        const j = (k - i) / nx;
        if (i === 0 || i === nx - 1 || j === ny - 1) sea = true;
        neighbours(k, nb);
        for (const kk of nb) {
          if (comp[kk] === 0 && elev[kk] !== elev[kk]) {
            comp[kk] = -1;
            queue[tail++] = kk;
          }
        }
      }
      const id = sea ? 1 : next++;
      for (let q = 0; q < tail; q++) comp[queue[q]] = id;
    }
    if (next === 2) break; // 内水面が無い

    // 海から、橋渡し候補セル（陸だが水面を minFrac 以上含む）だけを通る幅優先探索
    dist.fill(-1);
    let head = 0;
    let tail = 0;
    for (let k = 0; k < n; k++) {
      if (comp[k] === 1) {
        dist[k] = 0;
        parent[k] = -1;
        queue[tail++] = k;
      }
    }
    const best = new Map<number, number>(); // 内水面の成分 → 到達した候補セル
    while (head < tail) {
      const k = queue[head++];
      const d = dist[k];
      neighbours(k, nb);
      for (const kk of nb) {
        const c = comp[kk];
        if (c >= 2) {
          if (d > 0 && !best.has(c)) best.set(c, k);
          continue;
        }
        if (d >= maxGap || dist[kk] !== -1 || c !== 0 || waterFrac[kk] < minFrac) continue;
        dist[kk] = d + 1;
        parent[kk] = k;
        queue[tail++] = kk;
      }
    }
    if (best.size === 0) break;
    for (const cell of best.values()) {
      for (let k = cell; k !== -1 && comp[k] !== 1; k = parent[k]) {
        if (elev[k] === elev[k]) {
          elev[k] = Number.NaN;
          converted++;
        }
      }
    }
  }
  return converted;
}
