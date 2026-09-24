/**
 * 計算格子上の代表地点の選定（校正用の海岸線区間・潮位計の地点）と、伝播時間・格子の間引き。
 * いずれも純粋な関数（DOM / Worker に依存しない）。
 */
import { CELL_INLAND_WATER, CELL_LAND, CELL_SEA } from '../core/types';
import { cellCenter, lonLatToGridXY, type GridSpec } from '../core/geo';
import { GRAVITY } from './solver';

/**
 * 鵠沼海岸の校正区間: 経度 139.455〜139.485 度、北緯 35.305 度より北（江の島を除く）で、
 * 陸に4近傍で接する海セル。さらに河川（境川・引地川など、幅の狭い水路）の岸を除くため、
 * 開いた海（幅 約120 m 以上の水域）に接するセルに限る。
 */
export const KUGENUMA_SEGMENT = { west: 139.455, east: 139.485, minLat: 35.305 } as const;

/** 潮位計（波形グラフ）の目標地点: 鵠沼海岸の沖（東経 139.4705 度の汀線から沖へ約 220 m） */
export const GAUGE_TARGET = { lon: 139.4705, offshoreM: 220 } as const;

export interface GridLike {
  spec: GridSpec;
  z: ArrayLike<number>;
  kind: ArrayLike<number>;
}

/** 開いた海（河川など幅の狭い水域を除いた、潮位以下の海）のマスク。モルフォロジーのオープニング */
export function openSeaMask(g: GridLike, tide: number, radiusCells?: number): Uint8Array {
  const { nx, ny, dx } = g.spec;
  const r = Math.max(1, radiusCells ?? Math.round(60 / dx));
  const n = nx * ny;
  const sea = new Uint8Array(n);
  for (let k = 0; k < n; k++) sea[k] = g.kind[k] === CELL_SEA && g.z[k] < tide ? 1 : 0;
  // 侵食 → 膨張（正方形 (2r+1)²、格子外は海とみなす）
  const eroded = minFilter(sea, nx, ny, r, 1);
  return maxFilter(eroded, nx, ny, r);
}

/** 校正区間（鵠沼海岸の汀線の海セル）の添字 */
export function coastSegment(g: GridLike, tide: number, open?: Uint8Array): { cells: Int32Array; rule: 'kugenuma' | 'all-coast' | 'none' } {
  const { spec, kind } = g;
  const { nx, ny } = spec;
  const mask = open ?? openSeaMask(g, tide);
  const isCoast = (i: number, j: number): boolean => {
    const k = j * nx + i;
    if (kind[k] !== CELL_SEA) return false;
    const land =
      (i > 0 && kind[k - 1] !== CELL_SEA) ||
      (i < nx - 1 && kind[k + 1] !== CELL_SEA) ||
      (j > 0 && kind[k - nx] !== CELL_SEA) ||
      (j < ny - 1 && kind[k + nx] !== CELL_SEA);
    if (!land) return false;
    return (
      mask[k] === 1 ||
      (i > 0 && mask[k - 1] === 1) ||
      (i < nx - 1 && mask[k + 1] === 1) ||
      (j > 0 && mask[k - nx] === 1) ||
      (j < ny - 1 && mask[k + nx] === 1)
    );
  };
  const inWindow: number[] = [];
  const all: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!isCoast(i, j)) continue;
      const k = j * nx + i;
      all.push(k);
      const c = cellCenter(spec, i, j);
      if (c.lon >= KUGENUMA_SEGMENT.west && c.lon <= KUGENUMA_SEGMENT.east && c.lat > KUGENUMA_SEGMENT.minLat) inWindow.push(k);
    }
  }
  if (inWindow.length > 0) return { cells: Int32Array.from(inWindow), rule: 'kugenuma' };
  if (all.length > 0) return { cells: Int32Array.from(all), rule: 'all-coast' };
  return { cells: new Int32Array(0), rule: 'none' };
}

export interface GaugeSite {
  k: number;
  i: number;
  j: number;
  lon: number;
  lat: number;
}

/** 潮位計の地点: 鵠沼海岸（139.4705E）の汀線から沖へ約 220 m の、水深 1 m 以上の海セル */
export function findGaugeCell(g: GridLike, tide: number, open?: Uint8Array): GaugeSite {
  const { spec, z, kind } = g;
  const { nx, ny, dx } = spec;
  const mask = open ?? openSeaMask(g, tide);
  const good = (k: number) => kind[k] === CELL_SEA && tide - z[k] >= 1;
  const site = (i: number, j: number): GaugeSite => {
    const c = cellCenter(spec, i, j);
    return { k: j * nx + i, i, j, lon: c.lon, lat: c.lat };
  };
  let ti = Math.floor(lonLatToGridXY(spec, GAUGE_TARGET.lon, 35.3).gx);
  let tj = -1;
  if (ti >= 0 && ti < nx) {
    // 南端から北へ、開いた海が続く最後のセル = 汀線
    let js = -1;
    for (let j = ny - 1; j >= 0; j--) {
      if (mask[j * nx + ti] !== 1) break;
      js = j;
    }
    if (js >= 0) tj = Math.min(ny - 1, js + Math.round(GAUGE_TARGET.offshoreM / dx));
  }
  if (tj < 0) {
    ti = Math.min(nx - 1, Math.max(0, ti));
    tj = Math.floor(ny / 2);
  }
  // 目標点に最も近い、条件を満たすセル（開いた海を優先）
  let best = -1;
  let bestD = Infinity;
  for (const pass of [0, 1, 2]) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const ok = pass === 0 ? good(k) && mask[k] === 1 : pass === 1 ? good(k) : kind[k] === CELL_SEA && z[k] < tide;
        if (!ok) continue;
        const d = (i - ti) * (i - ti) + (j - tj) * (j - tj);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
    }
    if (best >= 0) break;
  }
  if (best < 0) return site(ti, tj);
  const j = Math.floor(best / nx);
  return site(best - j * nx, j);
}

/**
 * 南端（沖側境界）から校正区間の各セルまで、同じ列に沿った長波の伝播時間 ∫ds/√(gh) の中央値 [秒]。
 * 経路上に陸（江の島など）がある列は除く。求まらなければ NaN。
 */
export function travelTimeToSegment(g: GridLike, tide: number, cells: ArrayLike<number>): number {
  const { spec, z, kind } = g;
  const { nx, ny, dx } = spec;
  const times: number[] = [];
  for (let s = 0; s < cells.length; s++) {
    const k0 = cells[s];
    const j0 = Math.floor(k0 / nx);
    const i = k0 - j0 * nx;
    let t = 0;
    let ok = true;
    for (let j = ny - 1; j >= j0; j--) {
      const k = j * nx + i;
      if (kind[k] !== CELL_SEA) {
        ok = false;
        break;
      }
      const c = Math.sqrt(GRAVITY * Math.max(0.5, tide - z[k]));
      // 南端の面から目的セルの中心まで（目的セル内は 1/2 セル分）
      t += ((j === j0 ? 0.5 : 1) * dx) / c;
    }
    if (ok) times.push(t);
  }
  if (times.length === 0) return NaN;
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/** 有限値の p パーセンタイル（0〜100）。値がなければ NaN */
export function percentile(values: ArrayLike<number>, p: number): number {
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) v.push(values[i]);
  if (v.length === 0) return NaN;
  v.sort((a, b) => a - b);
  const x = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1);
  const i0 = Math.floor(x);
  const i1 = Math.min(v.length - 1, i0 + 1);
  return v[i0] + (v[i1] - v[i0]) * (x - i0);
}

export interface DecimatedGrid {
  spec: GridSpec;
  z: Float32Array;
  kind: Uint8Array;
  manning: Float32Array;
}

/**
 * 格子を f×f セルごとにまとめた粗い格子（校正の試算用）。
 * 半分以上が海なら海（地盤高は海セルの平均）、それ以外は陸（陸セルの平均）。
 */
export function decimateGrid(g: GridLike & { manning: ArrayLike<number> }, f: number): DecimatedGrid {
  const { spec } = g;
  const nx = Math.floor(spec.nx / f);
  const ny = Math.floor(spec.ny / f);
  const out: DecimatedGrid = {
    spec: { ...spec, cellPx: spec.cellPx * f, nx, ny, dx: spec.dx * f },
    z: new Float32Array(nx * ny),
    kind: new Uint8Array(nx * ny),
    manning: new Float32Array(nx * ny),
  };
  const half = (f * f) / 2;
  for (let J = 0; J < ny; J++) {
    for (let I = 0; I < nx; I++) {
      let nSea = 0;
      let zSea = 0;
      let mSea = 0;
      let nLand = 0;
      let zLand = 0;
      let nPond = 0;
      for (let dj = 0; dj < f; dj++) {
        for (let di = 0; di < f; di++) {
          const k = (J * f + dj) * spec.nx + I * f + di;
          if (g.kind[k] === CELL_SEA) {
            nSea++;
            zSea += g.z[k];
            mSea += g.manning[k];
          } else {
            nLand++;
            zLand += g.z[k];
            if (g.kind[k] === CELL_INLAND_WATER) nPond++;
          }
        }
      }
      const K = J * nx + I;
      if (nSea >= half) {
        out.kind[K] = CELL_SEA;
        out.z[K] = zSea / nSea;
        out.manning[K] = mSea / nSea;
      } else {
        out.kind[K] = nPond * 2 > nLand ? CELL_INLAND_WATER : CELL_LAND;
        out.z[K] = zLand / nLand;
        out.manning[K] = nSea > 0 ? mSea / nSea : 0.025;
      }
    }
  }
  return out;
}

// ---- 形態学フィルタ（正方形窓、分離可能） ----

/** 窓内がすべて 1 のとき 1（外側は outside とみなす） */
function minFilter(src: Uint8Array, nx: number, ny: number, r: number, outside: 0 | 1): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const zerosRow = new Int32Array(Math.max(nx, ny) + 1);
  // 行方向
  for (let j = 0; j < ny; j++) {
    zerosRow[0] = 0;
    for (let i = 0; i < nx; i++) zerosRow[i + 1] = zerosRow[i] + (src[j * nx + i] ? 0 : 1);
    for (let i = 0; i < nx; i++) {
      const a = i - r;
      const b = i + r;
      if (outside === 0 && (a < 0 || b >= nx)) continue;
      const z = zerosRow[Math.min(nx, b + 1)] - zerosRow[Math.max(0, a)];
      tmp[j * nx + i] = z === 0 ? 1 : 0;
    }
  }
  // 列方向
  for (let i = 0; i < nx; i++) {
    zerosRow[0] = 0;
    for (let j = 0; j < ny; j++) zerosRow[j + 1] = zerosRow[j] + (tmp[j * nx + i] ? 0 : 1);
    for (let j = 0; j < ny; j++) {
      const a = j - r;
      const b = j + r;
      if (outside === 0 && (a < 0 || b >= ny)) continue;
      const z = zerosRow[Math.min(ny, b + 1)] - zerosRow[Math.max(0, a)];
      out[j * nx + i] = z === 0 ? 1 : 0;
    }
  }
  return out;
}

/** 窓内に 1 があれば 1 */
function maxFilter(src: Uint8Array, nx: number, ny: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const ones = new Int32Array(Math.max(nx, ny) + 1);
  for (let j = 0; j < ny; j++) {
    ones[0] = 0;
    for (let i = 0; i < nx; i++) ones[i + 1] = ones[i] + src[j * nx + i];
    for (let i = 0; i < nx; i++) tmp[j * nx + i] = ones[Math.min(nx, i + r + 1)] - ones[Math.max(0, i - r)] > 0 ? 1 : 0;
  }
  for (let i = 0; i < nx; i++) {
    ones[0] = 0;
    for (let j = 0; j < ny; j++) ones[j + 1] = ones[j] + tmp[j * nx + i];
    for (let j = 0; j < ny; j++) out[j * nx + i] = ones[Math.min(ny, j + r + 1)] - ones[Math.max(0, j - r)] > 0 ? 1 : 0;
  }
  return out;
}
