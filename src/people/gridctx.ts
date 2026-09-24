/**
 * 経路探索用にグリッドから前計算する情報（通行可否・勾配・連結成分・安全なセル）をまとめてキャッシュする。
 *
 * 【モデル上の近似】道路網・建物・塀・橋の位置は考慮していない。陸のセルはどこでも歩けるものとし、
 * 水域（海・河川・池）は原則通れないが、幅が MAX_WATER_CROSSING_M 以下の細い水域（川など）だけは
 * 「どこかに橋がある」とみなしてペナルティ付きで渡れるものとする。
 */
import { CELL_LAND, CELL_SEA, type Shelter, type SimOutput, type TerrainGrid } from '../core/types';
import { lonLatToCell } from '../core/geo';

/** 通行可否: 陸（歩ける） */
export const PASS_LAND = 0;
/** 通行可否: 細い水域（橋があるとみなして渡れる。ペナルティあり） */
export const PASS_WATER_CROSS = 1;
/** 通行可否: 通れない（広い水域） */
export const PASS_BLOCKED = 2;

/**
 * 渡れるとみなす水域の最大幅 [m]（モデル上の仮定）。
 * 標準解像度（約15.6m）で3セル。引地川・境川の下流部の川幅程度を想定。
 */
export const MAX_WATER_CROSSING_M = 50;

/** シミュレーション結果から「安全」とするセルが、海・浸水したセルから離れているべき距離 [m]（仮定） */
export const SAFE_BUFFER_M = 30;

/** シミュレーション結果がない場合、高台とみなす標高の余裕 [m]（海岸での津波高 + この値以上。仮定） */
export const HIGHGROUND_MARGIN_M = 1;

/** 浸水ありとみなす深さ [m]（シミュレーションの到達判定と同じ） */
const WET_DEPTH_M = 0.01;

/**
 * 海の上に置かれた人を陸へ寄せるとき、寄せ先の陸地（連結成分）に求める最小の面積 [m²]（仮定: 1ha）。
 * 岩・防波堤の先端など、標高データ上で孤立した小さな陸に寄せて「どこにも行けない」ことを防ぐ。
 */
export const MIN_START_LAND_AREA_M2 = 10000;

export interface ShelterTargets {
  /** 目標セルのマスク（1=いずれかの避難場所） */
  mask: Uint8Array;
  /** セル → 避難場所 */
  byCell: Map<number, Shelter>;
  /** グリッド内の避難場所の数 */
  count: number;
}

export interface GridContext {
  grid: TerrainGrid;
  nx: number;
  ny: number;
  n: number;
  /** セル辺長 [m] */
  dx: number;
  /** 通行可否（PASS_*） */
  pass: Uint8Array;
  /** 勾配の大きさ |∇z|（無次元、陸のみ。水域は 0） */
  slope: Float32Array;
  /** 通行できるセルの連結成分番号（通れないセルは -1） */
  comp: Int32Array;
  /** 連結成分の数 */
  compCount: number;
  /** 連結成分ごとのセル数 */
  compSize: Int32Array;
  heightSafe: Map<number, Uint8Array>;
  simSafe: WeakMap<SimOutput, { frames: number; mask: Uint8Array; combined: Map<number, Uint8Array> }>;
  shelterTargets: WeakMap<Shelter[], ShelterTargets>;
  nearestLandCache: Map<string, number>;
}

const contexts = new WeakMap<TerrainGrid, GridContext>();

export function getGridContext(grid: TerrainGrid): GridContext {
  let ctx = contexts.get(grid);
  if (!ctx) {
    const { nx, ny, dx } = grid.spec;
    const pass = computePassability(grid);
    const { comp, count: compCount, size: compSize } = computeComponents(grid, pass);
    ctx = {
      grid,
      nx,
      ny,
      n: nx * ny,
      dx,
      pass,
      slope: computeSlope(grid),
      comp,
      compCount,
      compSize,
      heightSafe: new Map(),
      simSafe: new WeakMap(),
      shelterTargets: new WeakMap(),
      nearestLandCache: new Map(),
    };
    contexts.set(grid, ctx);
  }
  return ctx;
}

/**
 * 通行可否を求める。水域セル（海・河川・池）について、東西・南北・2方向の斜めの4方向で
 * 「両端を陸に挟まれた連続する水域の長さ」を測り、最短の長さが MAX_WATER_CROSSING_M 以下なら
 * 渡れる（PASS_WATER_CROSS）とする。グリッドの端に達する水域（外海）は渡れない。
 */
export function computePassability(grid: TerrainGrid): Uint8Array {
  const { nx, ny, dx } = grid.spec;
  const n = nx * ny;
  const kind = grid.kind;
  const pass = new Uint8Array(n);
  let anyWater = false;
  for (let k = 0; k < n; k++) {
    if (kind[k] === CELL_LAND) pass[k] = PASS_LAND;
    else {
      pass[k] = PASS_BLOCKED;
      anyWater = true;
    }
  }
  if (!anyWater) return pass;
  // 各水域セルが属する「挟まれた連続水域」の長さ [m] の最小値
  const minRun = new Float32Array(n).fill(Infinity);
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (let d = 0; d < 4; d++) {
    const di = dirs[d][0];
    const dj = dirs[d][1];
    const stepM = di !== 0 && dj !== 0 ? dx * Math.SQRT2 : dx;
    const maxLen = Math.floor((MAX_WATER_CROSSING_M + 1e-6) / stepM);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (kind[k] === CELL_LAND) continue;
        const pi = i - di;
        const pj = j - dj;
        const prevInside = pi >= 0 && pj >= 0 && pi < nx && pj < ny;
        // 連続する水域の始点だけから走査する（手前が陸でなければ途中なので飛ばす）
        if (prevInside && kind[pj * nx + pi] !== CELL_LAND) continue;
        let len = 0;
        let ci = i;
        let cj = j;
        if (!prevInside) continue; // グリッド端から始まる水域（外海）
        // 渡れる長さを超えたら打ち切る（残りのセルは「途中」なので上の判定で飛ばされる）
        while (len <= maxLen && ci >= 0 && cj >= 0 && ci < nx && cj < ny && kind[cj * nx + ci] !== CELL_LAND) {
          len++;
          ci += di;
          cj += dj;
        }
        if (len > maxLen) continue;
        if (!(ci >= 0 && cj >= 0 && ci < nx && cj < ny)) continue; // グリッド端（外海）
        const runM = len * stepM;
        for (let s = 0; s < len; s++) {
          const kk = (j + s * dj) * nx + (i + s * di);
          if (runM < minRun[kk]) minRun[kk] = runM;
        }
      }
    }
  }
  for (let k = 0; k < n; k++) {
    if (pass[k] === PASS_BLOCKED && minRun[k] <= MAX_WATER_CROSSING_M + 1e-6) pass[k] = PASS_WATER_CROSS;
  }
  return pass;
}

/** 陸セルの勾配の大きさ（中心差分。隣が水域・範囲外なら自セルの値で代用） */
function computeSlope(grid: TerrainGrid): Float32Array {
  const { nx, ny, dx } = grid.spec;
  const { z, kind } = grid;
  const n = nx * ny;
  // 水域・欠損は NaN にして、差分で自セル値に置き換える
  const zl = new Float32Array(n);
  for (let k = 0; k < n; k++) zl[k] = kind[k] === CELL_LAND && Number.isFinite(z[k]) ? z[k] : NaN;
  const out = new Float32Array(n);
  const inv = 1 / (2 * dx);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const zc = zl[k];
      if (zc !== zc) continue;
      let e = i + 1 < nx ? zl[k + 1] : zc;
      let w = i > 0 ? zl[k - 1] : zc;
      let s = j + 1 < ny ? zl[k + nx] : zc;
      let nn = j > 0 ? zl[k - nx] : zc;
      if (e !== e) e = zc;
      if (w !== w) w = zc;
      if (s !== s) s = zc;
      if (nn !== nn) nn = zc;
      const gx = (e - w) * inv;
      const gy = (s - nn) * inv;
      out[k] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/**
 * 通行できるセル（陸・細い水域）の連結成分（8近傍。斜めは経路探索と同じく、
 * 両側が通れないすき間は通らない）。目標に到達できるかを探索前に判定するために使う。
 */
function computeComponents(grid: TerrainGrid, pass: Uint8Array): { comp: Int32Array; count: number; size: Int32Array } {
  const { nx, ny } = grid.spec;
  const n = nx * ny;
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let label = 0;
  const sizes: number[] = [];
  for (let s = 0; s < n; s++) {
    if (pass[s] === PASS_BLOCKED || comp[s] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    comp[s] = label;
    while (head < tail) {
      const c = queue[head++];
      const ci = c % nx;
      const cj = (c - ci) / nx;
      for (let dj = -1; dj <= 1; dj++) {
        const nj = cj + dj;
        if (nj < 0 || nj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = ci + di;
          if (ni < 0 || ni >= nx) continue;
          const nk = nj * nx + ni;
          if (pass[nk] === PASS_BLOCKED || comp[nk] >= 0) continue;
          if (di !== 0 && dj !== 0 && pass[cj * nx + ni] === PASS_BLOCKED && pass[nj * nx + ci] === PASS_BLOCKED) continue;
          comp[nk] = label;
          queue[tail++] = nk;
        }
      }
    }
    sizes.push(tail);
    label++;
  }
  return { comp, count: label, size: Int32Array.from(sizes) };
}

/**
 * セル k から最も近い歩ける陸セル（PASS_LAND）。見つからなければ -1。
 * maxR はチェビシェフ距離でのセル数の上限。minCompCells を与えると、その数以上のセルからなる
 * 連結成分に属する陸セルだけを候補にする（孤立した小さな陸を避ける）。
 */
export function nearestLand(ctx: GridContext, k: number, maxR = 400, minCompCells = 1): number {
  const ok = (kk: number) => ctx.pass[kk] === PASS_LAND && (minCompCells <= 1 || ctx.compSize[ctx.comp[kk]] >= minCompCells);
  if (ok(k)) return k;
  const cacheKey = `${k}|${maxR}|${minCompCells}`;
  const cached = ctx.nearestLandCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { nx, ny } = ctx;
  const i0 = k % nx;
  const j0 = (k - i0) / nx;
  let best = -1;
  let bestD2 = Infinity;
  for (let r = 1; r <= maxR; r++) {
    if (r * r > bestD2) break;
    for (let dj = -r; dj <= r; dj++) {
      const j = j0 + dj;
      if (j < 0 || j >= ny) continue;
      const step = dj === -r || dj === r ? 1 : 2 * r;
      for (let di = -r; di <= r; di += step) {
        const i = i0 + di;
        if (i < 0 || i >= nx) continue;
        const kk = j * nx + i;
        if (!ok(kk)) continue;
        const d2 = di * di + dj * dj;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = kk;
        }
      }
    }
  }
  if (ctx.nearestLandCache.size > 5000) ctx.nearestLandCache.clear();
  ctx.nearestLandCache.set(cacheKey, best);
  return best;
}

/**
 * シミュレーション結果がない場合の「高台」: 歩ける陸で、標高 ≥ threshold [m, T.P.] のセル。
 */
export function heightSafeMask(ctx: GridContext, threshold: number): Uint8Array {
  const key = Math.round(threshold * 100) / 100;
  let mask = ctx.heightSafe.get(key);
  if (!mask) {
    mask = new Uint8Array(ctx.n);
    const { z } = ctx.grid;
    const pass = ctx.pass;
    for (let k = 0; k < ctx.n; k++) mask[k] = pass[k] === PASS_LAND && z[k] >= key ? 1 : 0;
    if (ctx.heightSafe.size > 16) ctx.heightSafe.clear();
    ctx.heightSafe.set(key, mask);
  }
  return mask;
}

/** 出力のグリッドが地形グリッドと同じ形か */
export function outputMatchesGrid(ctx: GridContext, output: SimOutput): boolean {
  const a = output.spec;
  const b = ctx.grid.spec;
  return a.nx === b.nx && a.ny === b.ny && a.originPx === b.originPx && a.originPy === b.originPy && a.cellPx === b.cellPx;
}

/** 計算が最後まで終わっているか */
export function outputComplete(output: SimOutput): boolean {
  return output.framesReady() > 0 && output.timeReady() >= output.durationSec - 1e-6;
}

function simEntry(ctx: GridContext, output: SimOutput) {
  const frames = output.framesReady();
  const cached = ctx.simSafe.get(output);
  if (cached && cached.frames === frames) return cached;
  const { nx, ny, n } = ctx;
  const kind = ctx.grid.kind;
  const { maxDepth, arrival } = output;
  const wet = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    // NaN は安全側（浸水あり）に倒す
    wet[k] = kind[k] === CELL_SEA || !(arrival[k] === Infinity) || !(maxDepth[k] < WET_DEPTH_M) ? 1 : 0;
  }
  const r = Math.max(1, Math.ceil(SAFE_BUFFER_M / ctx.dx));
  const near = dilate(wet, nx, ny, r);
  const mask = new Uint8Array(n);
  const z = ctx.grid.z;
  // 標高が欠損（NaN）のセルは目標にしない（表示する標高が分からないため）
  for (let k = 0; k < n; k++) mask[k] = ctx.pass[k] === PASS_LAND && !near[k] && Number.isFinite(z[k]) ? 1 : 0;
  const entry = { frames, mask, combined: new Map<number, Uint8Array>() };
  ctx.simSafe.set(output, entry);
  return entry;
}

/**
 * シミュレーション結果から見た「安全」なセル: 歩ける陸で、一度も浸水しておらず
 * （最大浸水深 < 1cm かつ 到達時刻 = ∞）、海・浸水したセルから SAFE_BUFFER_M 以上離れているセル。
 */
export function simSafeMask(ctx: GridContext, output: SimOutput): Uint8Array {
  return simEntry(ctx, output).mask;
}

/** simSafeMask と heightSafeMask(threshold) の両方を満たすセル（計算途中の結果用） */
export function simAndHeightSafeMask(ctx: GridContext, output: SimOutput, threshold: number): Uint8Array {
  const entry = simEntry(ctx, output);
  const key = Math.round(threshold * 100) / 100;
  let mask = entry.combined.get(key);
  if (!mask) {
    const height = heightSafeMask(ctx, key);
    mask = new Uint8Array(ctx.n);
    for (let k = 0; k < ctx.n; k++) mask[k] = entry.mask[k] & height[k];
    entry.combined.set(key, mask);
  }
  return mask;
}

/** 二値画像のチェビシェフ距離 r の膨張（行方向→列方向の分離型、スライディング和で O(n)） */
function dilate(src: Uint8Array, nx: number, ny: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    let count = 0;
    for (let i = 0; i < Math.min(r, nx); i++) count += src[row + i];
    for (let i = 0; i < nx; i++) {
      const add = i + r;
      if (add < nx) count += src[row + add];
      const rem = i - r - 1;
      if (rem >= 0) count -= src[row + rem];
      tmp[row + i] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(src.length);
  for (let i = 0; i < nx; i++) {
    let count = 0;
    for (let j = 0; j < Math.min(r, ny); j++) count += tmp[j * nx + i];
    for (let j = 0; j < ny; j++) {
      const add = j + r;
      if (add < ny) count += tmp[add * nx + i];
      const rem = j - r - 1;
      if (rem >= 0) count -= tmp[rem * nx + i];
      out[j * nx + i] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 目標マスクごとの前計算（A* のヒューリスティック・到達可能性）
// ---------------------------------------------------------------------------

const distanceFields = new WeakMap<Uint8Array, Float32Array>();
const targetComponents = new WeakMap<Uint8Array, Uint8Array>();

/**
 * 最寄りの目標セルまでの8近傍距離（障害物を無視、単位はセル）。A* のヒューリスティックに使う。
 * 2パスのチャンファー変換（直交 1、斜め √2）で、どの移動コストも「距離 × 係数（≥1）」なので許容的かつ単調。
 */
export function targetDistanceField(ctx: GridContext, mask: Uint8Array): Float32Array {
  let d = distanceFields.get(mask);
  if (d) return d;
  const { nx, ny, n } = ctx;
  d = new Float32Array(n);
  const INF = 1e30;
  const D = Math.SQRT2;
  for (let k = 0; k < n; k++) d[k] = mask[k] ? 0 : INF;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let v = d[k];
      if (v === 0) continue;
      if (i > 0 && d[k - 1] + 1 < v) v = d[k - 1] + 1;
      if (j > 0) {
        const u = k - nx;
        if (d[u] + 1 < v) v = d[u] + 1;
        if (i > 0 && d[u - 1] + D < v) v = d[u - 1] + D;
        if (i + 1 < nx && d[u + 1] + D < v) v = d[u + 1] + D;
      }
      d[k] = v;
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      let v = d[k];
      if (v === 0) continue;
      if (i + 1 < nx && d[k + 1] + 1 < v) v = d[k + 1] + 1;
      if (j + 1 < ny) {
        const b = k + nx;
        if (d[b] + 1 < v) v = d[b] + 1;
        if (i + 1 < nx && d[b + 1] + D < v) v = d[b + 1] + D;
        if (i > 0 && d[b - 1] + D < v) v = d[b - 1] + D;
      }
      d[k] = v;
    }
  }
  distanceFields.set(mask, d);
  return d;
}

/** 目標セルを含む連結成分なら 1 */
function componentsWithTarget(ctx: GridContext, mask: Uint8Array): Uint8Array {
  let has = targetComponents.get(mask);
  if (!has) {
    has = new Uint8Array(ctx.compCount);
    const comp = ctx.comp;
    for (let k = 0; k < ctx.n; k++) if (mask[k] && comp[k] >= 0) has[comp[k]] = 1;
    targetComponents.set(mask, has);
  }
  return has;
}

/** start から（水域の横断も含めて）歩いて到達できる目標セルがあるか */
export function hasReachableTarget(ctx: GridContext, mask: Uint8Array, start: number): boolean {
  const c = ctx.comp[start];
  return c >= 0 && componentsWithTarget(ctx, mask)[c] === 1;
}

/** 避難場所を目標セルに割り当てる（水域にある場合は近くの陸へ寄せる。範囲外は除外） */
export function shelterTargets(ctx: GridContext, shelters: Shelter[]): ShelterTargets {
  const cached = ctx.shelterTargets.get(shelters);
  if (cached) return cached;
  const mask = new Uint8Array(ctx.n);
  const byCell = new Map<number, Shelter>();
  let count = 0;
  const snapR = Math.max(2, Math.ceil(60 / ctx.dx));
  for (const s of shelters) {
    if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) continue;
    const c = lonLatToCell(ctx.grid.spec, s.lon, s.lat);
    if (!c) continue;
    const k = nearestLand(ctx, c.k, snapR);
    if (k < 0) continue;
    count++;
    mask[k] = 1;
    if (!byCell.has(k)) byCell.set(k, s);
  }
  const result = { mask, byCell, count };
  ctx.shelterTargets.set(shelters, result);
  return result;
}
