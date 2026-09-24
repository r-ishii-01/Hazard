/**
 * z15 画素の標高を計算セル（cellPx × cellPx 画素）へ集計する（純粋関数）。
 *
 * - セルの標高 = セル内の有効画素の平均
 * - セル内の無効値（水面など）の画素が半分以上なら水域（NaN）とする
 */

export interface RawCells {
  nx: number;
  ny: number;
  /** セルの標高 [m, T.P.]。NaN = 水域（海・河川・池などの水面） */
  elev: Float32Array;
  /** セル内の無効値（水面など）の画素の割合 0〜1 */
  waterFrac: Float32Array;
}

/** 水域とみなす無効画素の割合（これ以上なら水域） */
export const WATER_FRACTION_THRESHOLD = 0.5;

export function aggregateToCells(
  heights: Float32Array,
  width: number,
  height: number,
  cellPx: number,
  nx: number,
  ny: number,
  waterThreshold = WATER_FRACTION_THRESHOLD,
): RawCells {
  if (heights.length < width * height) throw new Error('heights is smaller than width*height');
  if (nx * cellPx > width || ny * cellPx > height) throw new Error('grid exceeds the pixel mosaic');
  const n = nx * ny;
  const sum = new Float64Array(nx);
  const cnt = new Int32Array(nx);
  const elev = new Float32Array(n);
  const waterFrac = new Float32Array(n);
  const total = cellPx * cellPx;
  for (let j = 0; j < ny; j++) {
    sum.fill(0);
    cnt.fill(0);
    for (let dy = 0; dy < cellPx; dy++) {
      const row = (j * cellPx + dy) * width;
      for (let i = 0; i < nx; i++) {
        let s = 0;
        let c = 0;
        const base = row + i * cellPx;
        for (let dx = 0; dx < cellPx; dx++) {
          const v = heights[base + dx];
          if (v === v) {
            s += v;
            c++;
          }
        }
        sum[i] += s;
        cnt[i] += c;
      }
    }
    for (let i = 0; i < nx; i++) {
      const na = total - cnt[i];
      waterFrac[j * nx + i] = na / total;
      elev[j * nx + i] = cnt[i] === 0 || na >= waterThreshold * total ? Number.NaN : sum[i] / cnt[i];
    }
  }
  return { nx, ny, elev, waterFrac };
}
