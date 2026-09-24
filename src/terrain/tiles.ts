/**
 * 対象範囲を覆う標高タイルの一覧（純粋関数）。
 * すべての解像度は同じ原点・範囲を共有する（core/geo.ts）ので、タイルの集合は解像度によらない。
 */
import { BASE_ZOOM, createGridSpec, gridTileRange, TILE_SIZE, type GridSpec } from '../core/geo';
import { DEM10_LAYER, DEM10_ZOOM, DEM5_LAYERS, demLayer, type DemLayerId } from './gsiDem';

export interface TileRange {
  zoom: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TileRef {
  layer: DemLayerId;
  z: number;
  x: number;
  y: number;
}

/** 計算範囲（基準ズーム z15 の画素単位） */
export interface PixelDomain {
  /** 西端の全球ピクセル x（z15） */
  originPx: number;
  /** 北端の全球ピクセル y（z15） */
  originPy: number;
  /** 幅・高さ [px] */
  width: number;
  height: number;
}

export function pixelDomain(spec: GridSpec = createGridSpec('fine')): PixelDomain {
  if (spec.zoom !== BASE_ZOOM) throw new Error('grid zoom must be BASE_ZOOM');
  return {
    originPx: spec.originPx,
    originPy: spec.originPy,
    width: spec.nx * spec.cellPx,
    height: spec.ny * spec.cellPx,
  };
}

/** 範囲を覆う z15 と z14 のタイル範囲 */
export function demTileRanges(spec: GridSpec = createGridSpec('fine')): { z15: TileRange; z14: TileRange } {
  const r15 = gridTileRange(spec, BASE_ZOOM);
  const r14 = gridTileRange(spec, DEM10_ZOOM);
  return {
    z15: { zoom: BASE_ZOOM, x0: r15.x0, y0: r15.y0, x1: r15.x1, y1: r15.y1 },
    z14: { zoom: DEM10_ZOOM, x0: r14.x0, y0: r14.y0, x1: r14.x1, y1: r14.y1 },
  };
}

export function tilesInRange(layer: DemLayerId, r: TileRange): TileRef[] {
  const out: TileRef[] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push({ layer, z: r.zoom, x, y });
  return out;
}

/**
 * 読み込みで使う可能性のあるすべての標高タイル（DEM5A/5B/5C の z15 と DEM10B の z14）。
 * scripts/prefetch-dem.mjs はこれと同じ一覧をダウンロードする（テストで一致を確認）。
 */
export function listRequiredDemTiles(spec: GridSpec = createGridSpec('fine')): TileRef[] {
  const { z15, z14 } = demTileRanges(spec);
  return [...DEM5_LAYERS.flatMap((l) => tilesInRange(l, z15)), ...tilesInRange(DEM10_LAYER, z14)];
}

/** z15 タイル (tx, ty) と計算範囲の重なり（範囲内の画素座標、半開区間） */
export function tileOverlap(dom: PixelDomain, tx: number, ty: number): { px0: number; py0: number; px1: number; py1: number } | null {
  const gx0 = tx * TILE_SIZE;
  const gy0 = ty * TILE_SIZE;
  const px0 = Math.max(0, gx0 - dom.originPx);
  const py0 = Math.max(0, gy0 - dom.originPy);
  const px1 = Math.min(dom.width, gx0 + TILE_SIZE - dom.originPx);
  const py1 = Math.min(dom.height, gy0 + TILE_SIZE - dom.originPy);
  if (px1 <= px0 || py1 <= py0) return null;
  return { px0, py0, px1, py1 };
}

/**
 * 国土地理院の配信に存在しない（HTTP 404 を返す）ことを確認済みのタイル（2026年9月に scripts/prefetch-dem.mjs で確認）。
 * 海だけの範囲の DEM5A、この地域では DEM5A で全域が整備されているため提供されていない DEM5B/5C など。
 * 要求しないことで、無駄な通信とブラウザのコンソールに出る 404 を減らす（範囲外・未確認のタイルは通常どおり要求する）。
 * 書式: "x/y" または "x0-x1/y0-y1"（両端含む）を空白区切り。
 */
const KNOWN_MISSING_SPEC: Record<DemLayerId, string> = {
  dem5a_png: '29076/12944-12947 29077/12945-12947 29078/12945-12947 29079-29080/12947 29081/12946-12947',
  dem5b_png: '29076-29081/12940-12947',
  dem5c_png: '29076-29081/12940-12947',
  dem_png: '14538/6473',
};

const parseRange = (t: string): [number, number] => {
  const [a, b] = t.split('-').map(Number);
  return [a, b ?? a];
};

const KNOWN_MISSING: Record<DemLayerId, { x: [number, number]; y: [number, number] }[]> = Object.fromEntries(
  (Object.keys(KNOWN_MISSING_SPEC) as DemLayerId[]).map((id) => [
    id,
    KNOWN_MISSING_SPEC[id]
      .split(/\s+/)
      .filter(Boolean)
      .map((e) => {
        const [xs, ys] = e.split('/');
        return { x: parseRange(xs), y: parseRange(ys) };
      }),
  ]),
) as Record<DemLayerId, { x: [number, number]; y: [number, number] }[]>;

/** 国土地理院に無いことを確認済みのタイルか */
export function isKnownMissingTile(layer: DemLayerId, z: number, x: number, y: number): boolean {
  if (demLayer(layer).zoom !== z) return false;
  return KNOWN_MISSING[layer].some((r) => x >= r.x[0] && x <= r.x[1] && y >= r.y[0] && y <= r.y[1]);
}
