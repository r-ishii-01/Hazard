/**
 * グリッド上の最短経路探索（8近傍の A*／ダイクストラ法、型付き配列の二分ヒープ）と経路の平滑化。
 *
 * コストは「距離 [m] × 係数」。係数は勾配（上り坂を少し嫌い、急坂を強く嫌う）と
 * 細い水域の横断（橋までの迂回を見込んだペナルティ）で決まる。係数の値はモデル上の仮定。
 */
import { PASS_BLOCKED, PASS_LAND, PASS_WATER_CROSS, type GridContext } from './gridctx';
import type { MobilityClass } from './profiles';

export interface CostModel {
  /** 上り勾配 1 あたりの係数の増分 */
  uphill: number;
  /** 下り勾配 1 あたりの係数の増分 */
  downhill: number;
  /** これを超える勾配（上り・下りとも）を「急坂」とする */
  steep: number;
  /** 急坂を超えた勾配 1 あたりの係数の増分 */
  steepWeight: number;
  /** 係数の上限 */
  maxFactor: number;
}

/**
 * 徒歩: 上り坂は緩やかに嫌う（勾配10%で1.15倍）。勾配25%を超える急斜面（崖・段差）は強く避ける。
 * 値はモデル上の仮定（公的な基準ではない）。
 */
export const WALK_COST: CostModel = { uphill: 1.5, downhill: 0, steep: 0.25, steepWeight: 8, maxFactor: 30 };

/**
 * 車いす: バリアフリー法の傾斜路の基準（勾配1/12以下、BARRIER_FREE_SLOPE_URL）を超える坂を強く避け、
 * 下り坂も少し嫌う。値はモデル上の仮定。
 */
export const WHEELCHAIR_COST: CostModel = { uphill: 6, downhill: 2, steep: 1 / 12, steepWeight: 40, maxFactor: 60 };

export function costModelFor(mobility: MobilityClass): CostModel {
  return mobility === 'wheelchair' ? WHEELCHAIR_COST : WALK_COST;
}

/** 細い水域（橋があるとみなす）を渡るときの距離の係数（橋までの迂回を見込んだ仮定） */
export const WATER_CROSS_FACTOR = 3;

/** 勾配 g（上りが正）→ コスト係数。標高が欠損（NaN）の場合は平地扱い（1） */
export function slopeFactor(model: CostModel, g: number): number {
  if (g !== g) return 1;
  const a = g < 0 ? -g : g;
  let f = 1 + (g > 0 ? model.uphill * g : -model.downhill * g);
  if (a > model.steep) f += model.steepWeight * (a - model.steep);
  return f < model.maxFactor ? f : model.maxFactor;
}

/** 8近傍の移動方向（0〜3 が直交、4〜7 が斜め） */
const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];
/** 移動方向の表（stepCost の d。テスト・検証用） */
export const NEIGHBOR_DI: readonly number[] = DI;
export const NEIGHBOR_DJ: readonly number[] = DJ;

/**
 * セル c から方向 d（DI/DJ の添字）の隣へ1歩進むコスト [m]。通れない場合は Infinity。
 * 経路探索（searchPath）と連結成分の判定はこの規則に従う。
 *
 * - 通れないセル（広い水域）には入らない。
 * - 斜め移動で、両側の直交セルがどちらも通れない場合はすり抜けない（角の点を通る隙間は通路ではない）。
 * - 斜め移動で、両側の直交セルがどちらも水域（細い川を含む）の場合は、川を斜めに「またぐ」ことになるので
 *   水域の横断（WATER_CROSS_FACTOR）として扱う。これがないと、幅1セルの斜めの川を無償で渡れてしまう。
 * - 細い水域（橋があるとみなす）に出入りする移動も WATER_CROSS_FACTOR。
 * - それ以外は 距離 × 勾配の係数（slopeFactor）。
 */
export function stepCost(ctx: GridContext, model: CostModel, c: number, d: number): number {
  const { nx, ny, pass, dx } = ctx;
  const ci = c % nx;
  const cj = (c - ci) / nx;
  const ni = ci + DI[d];
  const nj = cj + DJ[d];
  if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) return Infinity;
  const nk = nj * nx + ni;
  const pn = pass[nk];
  const pc = pass[c];
  if (pn === PASS_BLOCKED || pc === PASS_BLOCKED) return Infinity;
  let len = dx;
  let straddle = false;
  if (d >= 4) {
    const pa = pass[cj * nx + ni];
    const pb = pass[nj * nx + ci];
    if (pa === PASS_BLOCKED && pb === PASS_BLOCKED) return Infinity;
    straddle = pa !== PASS_LAND && pb !== PASS_LAND;
    len = dx * Math.SQRT2;
  }
  if (straddle || pn === PASS_WATER_CROSS || pc === PASS_WATER_CROSS) return len * WATER_CROSS_FACTOR;
  const z = ctx.grid.z;
  return len * slopeFactor(model, (z[nk] - z[c]) / len);
}

// ---------------------------------------------------------------------------
// A*（目標が複数ならダイクストラ + 最寄り目標までの距離をヒューリスティックに使う）
// ---------------------------------------------------------------------------

interface Scratch {
  n: number;
  /** 始点からのコスト g */
  dist: Float64Array;
  /** 優先度 f = g + h */
  key: Float64Array;
  parent: Int32Array;
  heap: Int32Array;
  /** ヒープ内の位置。-1=未訪問, -2=確定済み */
  pos: Int32Array;
}

let scratch: Scratch | null = null;

function getScratch(n: number): Scratch {
  if (!scratch || scratch.n !== n) {
    scratch = {
      n,
      dist: new Float64Array(n),
      key: new Float64Array(n),
      parent: new Int32Array(n),
      heap: new Int32Array(n),
      pos: new Int32Array(n),
    };
  }
  return scratch;
}

export type SearchGoal =
  /** マスクのいずれかのセル。h は最寄り目標までの距離 [セル]（targetDistanceField） */
  | { mask: Uint8Array; h: Float32Array }
  /** 1つのセル */
  | { cell: number }
  /** コスト budget [m] 以内で到達できる最も高い陸セル（見つかった中で標高最大、同じなら近い方） */
  | { highestWithin: number };

export interface SearchResult {
  /** 到達した目標セル（見つからなければ -1） */
  target: number;
  /** 経路の親（次の探索で上書きされるので、必要ならすぐ使うこと） */
  parent: Int32Array;
  /** 確定したセル数（性能確認用） */
  expanded: number;
}

/**
 * start から goal までの最小コスト経路を A* で探す。ヒューリスティックは障害物を無視した8近傍距離 × セル辺長で、
 * 移動コスト（距離 × 係数 ≥ 1）以下なので最適解が得られる。
 * 'highestWithin' はコストの小さい順に全方向へ広げる必要があるので、ヒューリスティック 0（ダイクストラ法）で探す。
 * 移動コストの規則は stepCost と同じ（速度のため同じ計算をここに展開している）。
 */
export function searchPath(ctx: GridContext, model: CostModel, start: number, goal: SearchGoal): SearchResult {
  const { nx, ny, n, pass, dx } = ctx;
  const z = ctx.grid.z;
  const { dist, key, parent, heap, pos } = getScratch(n);
  dist.fill(Infinity);
  pos.fill(-1);
  parent[start] = -1;
  const dxDiag = dx * Math.SQRT2;
  const { uphill, downhill, steep, steepWeight, maxFactor } = model;
  const mask = 'mask' in goal ? goal.mask : null;
  const hField = 'mask' in goal ? goal.h : null;
  const single = 'cell' in goal ? goal.cell : -1;
  const budget = 'highestWithin' in goal ? goal.highestWithin : Infinity;
  let best = -1;
  let bestZ = -Infinity;
  const ti = single >= 0 ? single % nx : 0;
  const tj = single >= 0 ? (single - ti) / nx : 0;
  const SQ2m1 = Math.SQRT2 - 1;
  const heur = (k: number): number => {
    if (hField) return hField[k] * dx;
    // 目標が1点でない（コスト上限内の探索）場合はダイクストラ法。ここで 0 以外を返すと、
    // 展開順が g の小さい順でなくなり「コスト上限を超えたら終了」が早すぎる（探索範囲が偏る）
    if (single < 0) return 0;
    const ki = k % nx;
    const kj = (k - ki) / nx;
    const ai = ki > ti ? ki - ti : ti - ki;
    const aj = kj > tj ? kj - tj : tj - kj;
    return (ai > aj ? ai + SQ2m1 * aj : aj + SQ2m1 * ai) * dx;
  };

  dist[start] = 0;
  key[start] = heur(start);
  heap[0] = start;
  pos[start] = 0;
  let size = 1;
  let expanded = 0;

  while (size > 0) {
    // --- pop ---
    const c = heap[0];
    size--;
    if (size > 0) {
      const last = heap[size];
      const lk = key[last];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= size) break;
        const r = l + 1;
        const ch = r < size && key[heap[r]] < key[heap[l]] ? r : l;
        const chk = heap[ch];
        if (key[chk] >= lk) break;
        heap[i] = chk;
        pos[chk] = i;
        i = ch;
      }
      heap[i] = last;
      pos[last] = i;
    }
    pos[c] = -2;
    expanded++;
    if (c === single || (mask !== null && mask[c] === 1)) return { target: c, parent, expanded };
    if (budget !== Infinity) {
      if (dist[c] > budget) break;
      if (pass[c] === PASS_LAND && z[c] > bestZ) {
        bestZ = z[c];
        best = c;
      }
    }

    const pc = pass[c];
    const zc = z[c];
    const dc = dist[c];
    const ci = c % nx;
    const cj = (c - ci) / nx;
    for (let d = 0; d < 8; d++) {
      const ni = ci + DI[d];
      const nj = cj + DJ[d];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nk = nj * nx + ni;
      const pn = pass[nk];
      if (pn === PASS_BLOCKED) continue;
      const pp = pos[nk];
      if (pp === -2) continue;
      let len = dx;
      let straddle = false;
      if (d >= 4) {
        // 斜め移動: 両側が通れないセルのすき間はすり抜けない。両側とも水域なら川をまたぐ（横断扱い）
        const pa = pass[cj * nx + ni];
        const pb = pass[nj * nx + ci];
        if (pa === PASS_BLOCKED && pb === PASS_BLOCKED) continue;
        straddle = pa !== PASS_LAND && pb !== PASS_LAND;
        len = dxDiag;
      }
      let f: number;
      if (straddle || pn === PASS_WATER_CROSS || pc === PASS_WATER_CROSS) {
        f = WATER_CROSS_FACTOR;
      } else {
        const g = (z[nk] - zc) / len;
        if (g === g) {
          const a = g < 0 ? -g : g;
          f = 1 + (g > 0 ? uphill * g : -downhill * g);
          if (a > steep) f += steepWeight * (a - steep);
          if (f > maxFactor) f = maxFactor;
        } else {
          f = 1; // 標高が欠損（NaN）の場合は平地扱い
        }
      }
      const nd = dc + len * f;
      const old = dist[nk];
      if (nd < old) {
        // h はセルごとに不変なので、ヒープ内のセルは key - g から求め直せる
        const h = pp === -1 ? heur(nk) : key[nk] - old;
        const kk = nd + h;
        dist[nk] = nd;
        parent[nk] = c;
        key[nk] = kk;
        // --- sift up ---
        let i = pp === -1 ? size++ : pp;
        while (i > 0) {
          const p = (i - 1) >> 1;
          const pk = heap[p];
          if (key[pk] <= kk) break;
          heap[i] = pk;
          pos[pk] = i;
          i = p;
        }
        heap[i] = nk;
        pos[nk] = i;
      }
    }
  }
  return { target: best, parent, expanded };
}

/** parent をたどって start → target のセル列を作る */
export function reconstruct(parent: Int32Array, target: number): number[] {
  const cells: number[] = [];
  let k = target;
  let guard = parent.length + 1;
  while (k >= 0 && guard-- > 0) {
    cells.push(k);
    k = parent[k];
  }
  cells.reverse();
  return cells;
}

// ---------------------------------------------------------------------------
// 平滑化（見通しによる糸引き）
// ---------------------------------------------------------------------------

export interface GridPoint {
  /** 連続セル座標（セル左上角が整数） */
  gx: number;
  gy: number;
}

/**
 * 2点を結ぶ線分が通るセルがすべて ok(k) を満たすか。セルの角をちょうど通る場合は両側のセルを調べる。
 */
export function lineClear(ctx: GridContext, a: GridPoint, b: GridPoint, ok: (k: number) => boolean): boolean {
  const { nx, ny } = ctx;
  let i = Math.floor(a.gx);
  let j = Math.floor(a.gy);
  const iEnd = Math.floor(b.gx);
  const jEnd = Math.floor(b.gy);
  const check = (ii: number, jj: number) => ii >= 0 && jj >= 0 && ii < nx && jj < ny && ok(jj * nx + ii);
  if (!check(i, j)) return false;
  const vx = b.gx - a.gx;
  const vy = b.gy - a.gy;
  const stepI = vx > 0 ? 1 : vx < 0 ? -1 : 0;
  const stepJ = vy > 0 ? 1 : vy < 0 ? -1 : 0;
  const tDeltaX = stepI !== 0 ? 1 / Math.abs(vx) : Infinity;
  const tDeltaY = stepJ !== 0 ? 1 / Math.abs(vy) : Infinity;
  let tMaxX = stepI > 0 ? (i + 1 - a.gx) / vx : stepI < 0 ? (a.gx - i) / -vx : Infinity;
  let tMaxY = stepJ > 0 ? (j + 1 - a.gy) / vy : stepJ < 0 ? (a.gy - j) / -vy : Infinity;
  let guard = Math.abs(iEnd - i) + Math.abs(jEnd - j) + 4;
  while ((i !== iEnd || j !== jEnd) && guard-- > 0) {
    if (Math.min(tMaxX, tMaxY) > 1) break;
    if (Math.abs(tMaxX - tMaxY) < 1e-9) {
      if (!check(i + stepI, j) || !check(i, j + stepJ)) return false;
      i += stepI;
      j += stepJ;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    } else if (tMaxX < tMaxY) {
      i += stepI;
      tMaxX += tDeltaX;
    } else {
      j += stepJ;
      tMaxY += tDeltaY;
    }
    if (!check(i, j)) return false;
  }
  return true;
}

/**
 * 経路の点列を、見通しの利く点まで一気につなぐ（貪欲な糸引き）。
 * 近道は「陸セルのみ」を通り、かつ通過セルの勾配が元の経路の最大勾配（または急坂の閾値）を超えない場合に限る。
 * これにより、水域の横断地点や、急坂を避けた迂回は保たれる。
 * 戻り値は残す点の添字（先頭と末尾を含む）。
 */
export function smoothPath(ctx: GridContext, model: CostModel, pts: GridPoint[]): number[] {
  const m = pts.length;
  if (m <= 2) return pts.map((_, i) => i);
  const { nx, ny, pass, slope } = ctx;
  const cellOf = (p: GridPoint) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor(p.gx)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor(p.gy)));
    return j * nx + i;
  };
  const slopes = pts.map((p) => slope[cellOf(p)]);
  const keep = [0];
  let a = 0;
  while (a < m - 1) {
    let b = a + 1;
    let maxS = Math.max(slopes[a], slopes[a + 1]);
    for (let c = a + 2; c < m; c++) {
      maxS = Math.max(maxS, slopes[c]);
      const allow = Math.max(model.steep, maxS) + 1e-6;
      const clear = lineClear(ctx, pts[a], pts[c], (k) => pass[k] === PASS_LAND && slope[k] <= allow);
      if (!clear) break;
      b = c;
    }
    keep.push(b);
    a = b;
  }
  return keep;
}
