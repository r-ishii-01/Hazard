/**
 * 地形（標高・水深）グリッドの読み込み。［スタブ: terrain 担当が実装］
 *
 * 契約:
 * - loadTerrain(resolution, opts) は TerrainGrid を返す。
 *   優先順: (1) ローカルミラー ./tiles/...（scripts/prefetch-dem.mjs で作成）
 *           (2) 国土地理院 標高タイル（ブラウザから直接取得）
 *           (3) 取得できない場合は合成（近似）地形（isApproximate=true）
 * - sampleGround(grid, lon, lat) は双線形補間した地盤高 [m, T.P.]（範囲外は null）。
 */
import type { Resolution } from '../core/geo';
import type { TerrainGrid } from '../core/types';

export interface LoadTerrainOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
}

export async function loadTerrain(_resolution: Resolution, _opts: LoadTerrainOptions = {}): Promise<TerrainGrid> {
  throw new Error('loadTerrain: not implemented');
}

export function sampleGround(_grid: TerrainGrid, _lon: number, _lat: number): number | null {
  return null;
}
