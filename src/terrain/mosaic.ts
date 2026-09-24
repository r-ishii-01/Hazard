/**
 * 複数の標高タイル（DEM5A → DEM5B → DEM5C → DEM10B）から、計算範囲の z15 画素ごとの標高を作る（純粋関数）。
 *
 * 画素ごとの採用ルール:
 * 1. その画素を含む 5m メッシュ系タイル（DEM5A/5B/5C）が1枚でも取得できた場合（=5m メッシュの整備範囲内）:
 *    優先順で最初の有効値を採用し、どれも無効値なら「水面など（NA）」とする。
 *    ※ 河川・池の水面は 5m メッシュでは無効値だが、DEM10B では等高線からの補間値が入っていることがある。
 *      ここで DEM10B に落とすと川が陸になってしまうため、5m メッシュの整備範囲内では DEM10B を使わない。
 * 2. 5m メッシュ系のタイルが1枚も無い（404）場合: DEM10B（z14）の値をその位置で標本化して使う。
 * 3. 取得に失敗したタイルしかなく値が決められない画素は「不明」とし、unknownMask に記録する
 *    （水面の NA と区別するため。多すぎる場合は呼び出し側で合成地形に切り替え、少しなら周囲の値で補う）。
 */
import { TILE_SIZE } from '../core/geo';
import { DEM10_LAYER, DEM10_ZOOM, DEM5_LAYERS, type DemLayerId } from './gsiDem';
import { tileOverlap, type PixelDomain, type TileRange } from './tiles';

/** タイルの取得結果。undefined = 未要求 */
export type TileSlot = Float32Array | 'missing' | 'error' | undefined;

export type TileLookup = (layer: DemLayerId, z: number, x: number, y: number) => TileSlot;

export interface DemMosaic {
  domain: PixelDomain;
  /** 画素ごとの標高 [m, T.P.]（NaN = 無効値：水面・欠測） */
  heights: Float32Array;
  /** 有効な標高が得られた画素数 */
  valid: number;
  /** 取得失敗のため値が不明な画素数（heights は NaN） */
  unknown: number;
  /** 値が不明な画素のマスク（1 = 不明）。不明な画素が無ければ null */
  unknownMask: Uint8Array | null;
  /** レイヤー別の採用画素数 */
  used: Record<DemLayerId, number>;
}

export function emptyUsage(): Record<DemLayerId, number> {
  return { dem5a_png: 0, dem5b_png: 0, dem5c_png: 0, dem_png: 0 };
}

export function buildMosaic(dom: PixelDomain, z15: TileRange, lookup: TileLookup): DemMosaic {
  const heights = new Float32Array(dom.width * dom.height).fill(Number.NaN);
  const used = emptyUsage();
  let valid = 0;
  let unknown = 0;
  let unknownMask: Uint8Array | null = null;

  for (let ty = z15.y0; ty <= z15.y1; ty++) {
    for (let tx = z15.x0; tx <= z15.x1; tx++) {
      const ov = tileOverlap(dom, tx, ty);
      if (!ov) continue;
      const five: Float32Array[] = [];
      const fiveIds: DemLayerId[] = [];
      let fiveError = false;
      for (const id of DEM5_LAYERS) {
        const t = lookup(id, z15.zoom, tx, ty);
        if (t instanceof Float32Array) {
          five.push(t);
          fiveIds.push(id);
        } else if (t !== 'missing') {
          // 'error' または未要求（通常は起きない）は「分からない」
          fiveError = true;
        }
      }
      const tx14 = tx >> (z15.zoom - DEM10_ZOOM);
      const ty14 = ty >> (z15.zoom - DEM10_ZOOM);
      const ten = five.length === 0 ? lookup(DEM10_LAYER, DEM10_ZOOM, tx14, ty14) : undefined;
      const scale = 1 << (z15.zoom - DEM10_ZOOM);

      for (let py = ov.py0; py < ov.py1; py++) {
        const gy = dom.originPy + py;
        const ly = gy - ty * TILE_SIZE;
        const row = py * dom.width;
        for (let px = ov.px0; px < ov.px1; px++) {
          const gx = dom.originPx + px;
          const lx = gx - tx * TILE_SIZE;
          const p = ly * TILE_SIZE + lx;
          const k = row + px;
          if (five.length > 0) {
            for (let s = 0; s < five.length; s++) {
              const v = five[s][p];
              if (v === v) {
                heights[k] = v;
                used[fiveIds[s]]++;
                valid++;
                break;
              }
            }
            continue;
          }
          if (ten instanceof Float32Array) {
            const qx = Math.floor(gx / scale) - tx14 * TILE_SIZE;
            const qy = Math.floor(gy / scale) - ty14 * TILE_SIZE;
            const v = ten[qy * TILE_SIZE + qx];
            if (v === v) {
              heights[k] = v;
              used[DEM10_LAYER]++;
              valid++;
            }
            continue;
          }
          // 5m 系はすべて 404 で DEM10B も 404 → 海（データなし）。いずれかが失敗 → 不明
          if (fiveError || ten !== 'missing') {
            unknown++;
            (unknownMask ??= new Uint8Array(heights.length))[k] = 1;
          }
        }
      }
    }
  }
  return { domain: dom, heights, valid, unknown, unknownMask, used };
}
