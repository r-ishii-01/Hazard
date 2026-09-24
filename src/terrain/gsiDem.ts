/**
 * 国土地理院「標高タイル（PNG形式）」の仕様とデコード（純粋関数。DOM に依存しない）。
 *
 * 仕様の出典: 国土地理院「標高タイルの詳細仕様」 https://maps.gsi.go.jp/development/demtile.html
 *            地理院タイル一覧（標高タイル） https://maps.gsi.go.jp/development/ichiran.html#dem
 *
 * - 256×256 px の PNG。各画素の RGB に標高を符号化する。
 *     x = 2^16·R + 2^8·G + B
 *     x <  2^23 → h = x·u
 *     x =  2^23 → 無効値（NA。RGB = 128, 0, 0）
 *     x >  2^23 → h = (x − 2^24)·u        （u = 0.01 m）
 * - 海・湖沼・河川などの水面は、航空レーザ測量の DEM5A では原則として NA（無効値）になる。
 * - 標高の基準は東京湾平均海面（T.P.）。
 */

/** 標高の分解能 u [m] */
export const DEM_UNIT_M = 0.01;
/** 無効値（NA）を表す x = 2^23（RGB = 128, 0, 0） */
export const DEM_NA_VALUE = 0x800000;
export const DEM_TILE_SIZE = 256;

export type DemLayerId = 'dem5a_png' | 'dem5b_png' | 'dem5c_png' | 'dem_png';

export interface DemLayer {
  id: DemLayerId;
  /** 表示名（例: DEM5A） */
  label: string;
  /** このアプリで使うズームレベル */
  zoom: number;
  /** 説明（日本語） */
  description: string;
}

/**
 * 使用する標高タイル（優先順）。
 * DEM5A/5B/5C は z15（1px ≒ 3.9 m @ 北緯35.3°）、DEM10B は z14 以下で提供される。
 * 出典: https://maps.gsi.go.jp/development/ichiran.html#dem
 */
export const DEM_LAYERS: readonly DemLayer[] = [
  { id: 'dem5a_png', label: 'DEM5A', zoom: 15, description: '基盤地図情報 数値標高モデル 5mメッシュ（航空レーザ測量）' },
  { id: 'dem5b_png', label: 'DEM5B', zoom: 15, description: '基盤地図情報 数値標高モデル 5mメッシュ（写真測量）' },
  { id: 'dem5c_png', label: 'DEM5C', zoom: 15, description: '基盤地図情報 数値標高モデル 5mメッシュ（写真測量・補間）' },
  { id: 'dem_png', label: 'DEM10B', zoom: 14, description: '基盤地図情報 数値標高モデル 10mメッシュ（等高線からの補間）' },
];

/** 5m メッシュ系（z15）のレイヤー */
export const DEM5_LAYERS: readonly DemLayerId[] = ['dem5a_png', 'dem5b_png', 'dem5c_png'];
/** 10m メッシュ（z14） */
export const DEM10_LAYER: DemLayerId = 'dem_png';
export const DEM10_ZOOM = 14;

export function demLayer(id: DemLayerId): DemLayer {
  const layer = DEM_LAYERS.find((l) => l.id === id);
  if (!layer) throw new Error(`unknown DEM layer: ${id}`);
  return layer;
}

/** 国土地理院のタイル配信 URL のベース */
export const GSI_XYZ_BASE = 'https://cyberjapandata.gsi.go.jp/xyz';

export function gsiTileUrl(layer: DemLayerId, z: number, x: number, y: number): string {
  return `${GSI_XYZ_BASE}/${layer}/${z}/${x}/${y}.png`;
}

/** ローカルミラー（scripts/prefetch-dem.mjs が作る public/tiles/ 以下）の相対パス */
export function mirrorTilePath(layer: DemLayerId, z: number, x: number, y: number): string {
  return `tiles/${layer}/${z}/${x}/${y}.png`;
}

/** タイルを識別するキー（ミラーの manifest.json と共通の書式） */
export function tileKey(layer: DemLayerId, z: number, x: number, y: number): string {
  return `${layer}/${z}/${x}/${y}`;
}

/** 1画素の RGB → 標高 [m]。無効値は NaN */
export function decodeDemRgb(r: number, g: number, b: number): number {
  const x = r * 65536 + g * 256 + b;
  if (x < DEM_NA_VALUE) return x * DEM_UNIT_M;
  if (x === DEM_NA_VALUE) return Number.NaN;
  return (x - 16777216) * DEM_UNIT_M;
}

/** 標高 [m] → RGB（テスト用・逆変換）。NaN は無効値 (128,0,0) */
export function encodeDemRgb(h: number): [number, number, number] {
  if (!Number.isFinite(h)) return [128, 0, 0];
  let x = Math.round(h / DEM_UNIT_M);
  if (x < 0) x += 16777216;
  return [(x >> 16) & 255, (x >> 8) & 255, x & 255];
}

/**
 * RGBA 配列（ImageData.data と同じ並び）→ 標高配列 [m]（NaN = 無効値）。
 * 完全に透明な画素（alpha = 0）も無効値として扱う。
 */
export function decodeDemTile(rgba: ArrayLike<number>, out?: Float32Array): Float32Array {
  const n = rgba.length >> 2;
  const res = out && out.length >= n ? out : new Float32Array(n);
  for (let p = 0, q = 0; p < n; p++, q += 4) {
    if (rgba[q + 3] === 0) {
      res[p] = Number.NaN;
      continue;
    }
    res[p] = decodeDemRgb(rgba[q], rgba[q + 1], rgba[q + 2]);
  }
  return res;
}
