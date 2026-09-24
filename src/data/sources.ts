/**
 * 地図タイル・データの取得先と出典表記、浸水深の配色。［スタブ: 調査結果に基づき data 担当が確定］
 */
import type { Basemap } from '../core/types';

export interface RasterTileSource {
  id: string;
  label: string;
  /** {z}/{x}/{y} を含む URL テンプレート */
  url: string;
  minzoom: number;
  maxzoom: number;
  tileSize: number;
  /** HTML の出典表記 */
  attribution: string;
}

export const GSI_ATTRIBUTION = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';

export const BASEMAPS: Record<Basemap, RasterTileSource> = {
  pale: { id: 'gsi-pale', label: '淡色地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', minzoom: 5, maxzoom: 18, tileSize: 256, attribution: GSI_ATTRIBUTION },
  std: { id: 'gsi-std', label: '標準地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', minzoom: 5, maxzoom: 18, tileSize: 256, attribution: GSI_ATTRIBUTION },
  photo: { id: 'gsi-photo', label: '航空写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', minzoom: 2, maxzoom: 18, tileSize: 256, attribution: GSI_ATTRIBUTION },
};

/** 色別標高図 */
export const RELIEF_TILES: RasterTileSource = { id: 'gsi-relief', label: '色別標高図', url: 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png', minzoom: 5, maxzoom: 15, tileSize: 256, attribution: GSI_ATTRIBUTION };

/** 重ねるハザードマップ 津波浸水想定 */
export const HAZARD_TSUNAMI_TILES: RasterTileSource = {
  id: 'hazard-tsunami',
  label: '津波浸水想定（ハザードマップポータルサイト）',
  url: 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png',
  minzoom: 2,
  maxzoom: 17,
  tileSize: 256,
  attribution: '<a href="https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html" target="_blank" rel="noopener">ハザードマップポータルサイト</a>',
};

export interface DepthClass {
  /** 下限 [m]（この値以上） */
  min: number;
  /** 上限 [m]（この値未満、最上位は Infinity） */
  max: number;
  label: string;
  /** '#rrggbb' */
  color: string;
}

/** 浸水深の凡例（公式の新凡例に合わせる） */
export const DEPTH_CLASSES: DepthClass[] = [
  { min: 0.01, max: 0.3, label: '0.3m未満', color: '#ffffb3' },
  { min: 0.3, max: 0.5, label: '0.3〜0.5m', color: '#f7f5a9' },
  { min: 0.5, max: 1, label: '0.5〜1m', color: '#f8e1a6' },
  { min: 1, max: 3, label: '1〜3m', color: '#ffd8c0' },
  { min: 3, max: 5, label: '3〜5m', color: '#ffb7b7' },
  { min: 5, max: 10, label: '5〜10m', color: '#ff9191' },
  { min: 10, max: 20, label: '10〜20m', color: '#f285c9' },
  { min: 20, max: Infinity, label: '20m以上', color: '#dc7adc' },
];

/** 浸水深 [m] → RGBA（0〜255）。0.01m 未満は透明 */
export function depthToRgba(depth: number, out: Uint8ClampedArray | number[] = [0, 0, 0, 0], offset = 0): Uint8ClampedArray | number[] {
  if (!(depth >= 0.01)) {
    out[offset] = out[offset + 1] = out[offset + 2] = out[offset + 3] = 0;
    return out;
  }
  let c = DEPTH_CLASSES[DEPTH_CLASSES.length - 1];
  for (const cls of DEPTH_CLASSES) {
    if (depth < cls.max) {
      c = cls;
      break;
    }
  }
  const n = parseInt(c.color.slice(1), 16);
  out[offset] = (n >> 16) & 255;
  out[offset + 1] = (n >> 8) & 255;
  out[offset + 2] = n & 255;
  out[offset + 3] = 220;
  return out;
}

/** 津波到達時間の配色（分） */
export const ARRIVAL_CLASSES: { maxMin: number; label: string; color: string }[] = [
  { maxMin: 10, label: '10分以内', color: '#7f1d1d' },
  { maxMin: 15, label: '10〜15分', color: '#b91c1c' },
  { maxMin: 20, label: '15〜20分', color: '#ea580c' },
  { maxMin: 30, label: '20〜30分', color: '#f59e0b' },
  { maxMin: 45, label: '30〜45分', color: '#facc15' },
  { maxMin: Infinity, label: '45分以降', color: '#fde68a' },
];

/** OpenFreeMap（OpenStreetMap 由来のベクタータイル。3D 建物に使用） */
export const OPENFREEMAP = {
  tilejson: 'https://tiles.openfreemap.org/planet',
  attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
};
