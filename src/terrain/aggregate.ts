/**
 * z15 画素の標高を計算セル（cellPx × cellPx 画素）へ集計する（純粋関数）。
 *
 * - セルの標高 = セル内の有効画素の平均
 * - セル内の無効値（水面など）の画素が、値の分かっている画素の半分以上なら水域（NaN）とする
 * - 取得失敗で値が不明な画素（unknownPx）は水面と区別し、集計から除く。
 *   すべての画素が不明なセルは unknown に記録し、あとで周囲のセルから補う（fillUnknownCells）
 * - 海とつながった水面の画素（seaPx。connect.ts の seaConnectedPixels）の割合も数えておく。
 *   セルより細い川の連続性を保つ処理（connectSeaWater）と、池の判定に使う
 */

export interface RawCells {
  nx: number;
  ny: number;
  /** セルの標高 [m, T.P.]。NaN = 水域（海・河川・池などの水面）または値が不明 */
  elev: Float32Array;
  /** 値の分かっている画素に占める、無効値（水面など）の画素の割合 0〜1 */
  waterFrac: Float32Array;
  /** セル内の全画素に占める、海とつながった水面の画素の割合 0〜1（seaPx を渡さなければ null） */
  seaFrac: Float32Array | null;
  /** セル内の全画素に占める、値が不明な画素の割合 0〜1（不明な画素が無ければ null） */
  unknownFrac: Float32Array | null;
  /** すべての画素の値が不明なセルの数 */
  unknownCells: number;
}

export interface AggregateOptions {
  /** 水域とみなす無効画素の割合（既定 WATER_FRACTION_THRESHOLD） */
  waterThreshold?: number;
  /** 画素ごとの「海とつながった水面」フラグ（1 = そう） */
  seaPx?: Uint8Array | null;
  /** 画素ごとの「値が不明」フラグ（1 = 取得失敗で不明） */
  unknownPx?: Uint8Array | null;
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
  opts: AggregateOptions = {},
): RawCells {
  if (heights.length < width * height) throw new Error('heights is smaller than width*height');
  if (nx * cellPx > width || ny * cellPx > height) throw new Error('grid exceeds the pixel mosaic');
  const waterThreshold = opts.waterThreshold ?? WATER_FRACTION_THRESHOLD;
  const seaPx = opts.seaPx ?? null;
  const unkPx = opts.unknownPx ?? null;
  const n = nx * ny;
  const sum = new Float64Array(nx);
  const cnt = new Int32Array(nx);
  const sea = new Int32Array(nx);
  const unk = new Int32Array(nx);
  const elev = new Float32Array(n);
  const waterFrac = new Float32Array(n);
  const seaFrac = seaPx ? new Float32Array(n) : null;
  const unknownFrac = unkPx ? new Float32Array(n) : null;
  let unknownCells = 0;
  const total = cellPx * cellPx;
  for (let j = 0; j < ny; j++) {
    sum.fill(0);
    cnt.fill(0);
    if (seaPx) sea.fill(0);
    if (unkPx) unk.fill(0);
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
        if (seaPx) {
          let q = 0;
          for (let dx = 0; dx < cellPx; dx++) q += seaPx[base + dx];
          sea[i] += q;
        }
        if (unkPx) {
          let q = 0;
          for (let dx = 0; dx < cellPx; dx++) q += unkPx[base + dx];
          unk[i] += q;
        }
      }
    }
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const u = unkPx ? unk[i] : 0;
      const known = total - u;
      const na = known - cnt[i];
      if (seaFrac) seaFrac[k] = sea[i] / total;
      if (unknownFrac) unknownFrac[k] = u / total;
      if (known === 0) {
        waterFrac[k] = 0;
        elev[k] = Number.NaN;
        unknownCells++;
        continue;
      }
      waterFrac[k] = na / known;
      elev[k] = cnt[i] === 0 || na >= waterThreshold * known ? Number.NaN : sum[i] / cnt[i];
    }
  }
  return { nx, ny, elev, waterFrac, seaFrac, unknownFrac, unknownCells };
}
