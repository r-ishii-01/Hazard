/**
 * 座標系ユーティリティ。
 *
 * すべての計算グリッドは Web メルカトル（EPSG:3857）のピクセル座標に揃える。
 * 国土地理院の標高タイル（DEM5A: z15）と 1:1 で対応させるため、基準ズームは 15。
 * メルカトルは正角図法なので、1セルは地上でほぼ正方形（辺長 = 基準ピクセル長 × cellPx）。
 */

export const EARTH_RADIUS_M = 6378137;
export const TILE_SIZE = 256;

/** シミュレーション対象範囲（辻堂〜鵠沼〜片瀬・江の島、沖合約2km〜藤沢駅付近） */
export const DOMAIN_BOUNDS = {
  west: 139.44,
  east: 139.5,
  south: 35.29,
  north: 35.345,
} as const;

/** 初期表示の中心（鵠沼海岸付近） */
export const INITIAL_CENTER = { lon: 139.4705, lat: 35.3135 } as const;
export const INITIAL_ZOOM = 14.3;

/** 標高タイルの基準ズーム（DEM5A は z15 で提供） */
export const BASE_ZOOM = 15;

export type Resolution = 'coarse' | 'standard' | 'fine';

/** 解像度 → 基準ピクセル何個で1セルにするか（z15 の1px ≒ 3.9m @35.3°N） */
export const RESOLUTION_CELL_PX: Record<Resolution, number> = {
  coarse: 8, // ≒ 31 m
  standard: 4, // ≒ 15.6 m
  fine: 2, // ≒ 7.8 m
};

export interface LonLat {
  lon: number;
  lat: number;
}

/** 計算グリッドの定義。セル (i, j) の添字は k = j * nx + i。j=0 が北端、i=0 が西端。 */
export interface GridSpec {
  /** 基準ピクセルのズーム（常に BASE_ZOOM） */
  zoom: number;
  /** 西端（グリッド左端）の全球ピクセル x 座標（zoom での値、整数） */
  originPx: number;
  /** 北端（グリッド上端）の全球ピクセル y 座標（zoom での値、整数） */
  originPy: number;
  /** 1セルあたりの基準ピクセル数 */
  cellPx: number;
  nx: number;
  ny: number;
  /** セルの地上辺長 [m]（範囲中心緯度で評価） */
  dx: number;
}

const DEG = Math.PI / 180;

export function worldSize(zoom: number): number {
  return TILE_SIZE * Math.pow(2, zoom);
}

/** 経緯度 → 全球ピクセル座標（Web メルカトル） */
export function lonLatToPixel(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const ws = worldSize(zoom);
  const x = ((lon + 180) / 360) * ws;
  const s = Math.sin(lat * DEG);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws;
  return { x, y };
}

/** 全球ピクセル座標 → 経緯度 */
export function pixelToLonLat(x: number, y: number, zoom: number): LonLat {
  const ws = worldSize(zoom);
  const lon = (x / ws) * 360 - 180;
  const n = Math.PI * (1 - (2 * y) / ws);
  const lat = Math.atan(Math.sinh(n)) / DEG;
  return { lon, lat };
}

/** 指定緯度・ズームでの1ピクセルの地上長 [m] */
export function metersPerPixel(lat: number, zoom: number): number {
  return (2 * Math.PI * EARTH_RADIUS_M * Math.cos(lat * DEG)) / worldSize(zoom);
}

/** 2点間の大円距離 [m]（ハバーサイン） */
export function distanceMeters(a: LonLat, b: LonLat): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 対象範囲と解像度からグリッドを作る。原点は 8px 単位にスナップ（全解像度で同じ原点になる）。 */
/** 経緯度の範囲（度） */
export interface LonLatBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

export function createGridSpec(resolution: Resolution, bounds: LonLatBounds = DOMAIN_BOUNDS): GridSpec {
  const cellPx = RESOLUTION_CELL_PX[resolution];
  const zoom = BASE_ZOOM;
  const snap = 8;
  const nw = lonLatToPixel(bounds.west, bounds.north, zoom);
  const se = lonLatToPixel(bounds.east, bounds.south, zoom);
  const originPx = Math.floor(nw.x / snap) * snap;
  const originPy = Math.floor(nw.y / snap) * snap;
  const endPx = Math.ceil(se.x / snap) * snap;
  const endPy = Math.ceil(se.y / snap) * snap;
  const nx = Math.round((endPx - originPx) / cellPx);
  const ny = Math.round((endPy - originPy) / cellPx);
  const centerLat = (bounds.north + bounds.south) / 2;
  const dx = metersPerPixel(centerLat, zoom) * cellPx;
  return { zoom, originPx, originPy, cellPx, nx, ny, dx };
}

/** セル中心の経緯度 */
export function cellCenter(spec: GridSpec, i: number, j: number): LonLat {
  return pixelToLonLat(
    spec.originPx + (i + 0.5) * spec.cellPx,
    spec.originPy + (j + 0.5) * spec.cellPx,
    spec.zoom,
  );
}

/** 経緯度 → 連続セル座標（セル中心が整数 + 0.5 ではなく、セル左上角が整数）。 */
export function lonLatToGridXY(spec: GridSpec, lon: number, lat: number): { gx: number; gy: number } {
  const p = lonLatToPixel(lon, lat, spec.zoom);
  return { gx: (p.x - spec.originPx) / spec.cellPx, gy: (p.y - spec.originPy) / spec.cellPx };
}

/** 連続セル座標 → 経緯度 */
export function gridXYToLonLat(spec: GridSpec, gx: number, gy: number): LonLat {
  return pixelToLonLat(spec.originPx + gx * spec.cellPx, spec.originPy + gy * spec.cellPx, spec.zoom);
}

/** 経緯度を含むセル添字（範囲外なら null） */
export function lonLatToCell(spec: GridSpec, lon: number, lat: number): { i: number; j: number; k: number } | null {
  const { gx, gy } = lonLatToGridXY(spec, lon, lat);
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  if (i < 0 || j < 0 || i >= spec.nx || j >= spec.ny) return null;
  return { i, j, k: j * spec.nx + i };
}

/**
 * グリッド全体の四隅の経緯度。MapLibre の image/canvas ソースの coordinates 形式
 * [左上, 右上, 右下, 左下] で返す。
 */
export function gridCornerCoordinates(spec: GridSpec): [[number, number], [number, number], [number, number], [number, number]] {
  const tl = gridXYToLonLat(spec, 0, 0);
  const tr = gridXYToLonLat(spec, spec.nx, 0);
  const br = gridXYToLonLat(spec, spec.nx, spec.ny);
  const bl = gridXYToLonLat(spec, 0, spec.ny);
  return [
    [tl.lon, tl.lat],
    [tr.lon, tr.lat],
    [br.lon, br.lat],
    [bl.lon, bl.lat],
  ];
}

/** グリッドを覆う基準ズームのタイル範囲（両端含む） */
export function gridTileRange(spec: GridSpec, zoom = spec.zoom): { x0: number; y0: number; x1: number; y1: number; zoom: number } {
  const scale = Math.pow(2, zoom - spec.zoom);
  const x0 = Math.floor((spec.originPx * scale) / TILE_SIZE);
  const y0 = Math.floor((spec.originPy * scale) / TILE_SIZE);
  const x1 = Math.floor(((spec.originPx + spec.nx * spec.cellPx) * scale - 1e-9) / TILE_SIZE);
  const y1 = Math.floor(((spec.originPy + spec.ny * spec.cellPx) * scale - 1e-9) / TILE_SIZE);
  return { x0, y0, x1, y1, zoom };
}

/**
 * 3D ビュー用のローカル平面座標 [m]。グリッド中心を原点、x=東、z=南（three.js の右手系で y=上）。
 * メルカトル座標を dx で線形スケーリングするので、グリッドと完全に整合する。
 */
export function lonLatToLocalMeters(spec: GridSpec, lon: number, lat: number): { x: number; z: number } {
  const { gx, gy } = lonLatToGridXY(spec, lon, lat);
  return { x: (gx - spec.nx / 2) * spec.dx, z: (gy - spec.ny / 2) * spec.dx };
}

export function localMetersToLonLat(spec: GridSpec, x: number, z: number): LonLat {
  return gridXYToLonLat(spec, x / spec.dx + spec.nx / 2, z / spec.dx + spec.ny / 2);
}
