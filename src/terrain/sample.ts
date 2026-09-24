/**
 * 地盤高の標本化（純粋関数）。
 */
import { lonLatToGridXY } from '../core/geo';
import type { TerrainGrid } from '../core/types';

/**
 * 経緯度の地盤高 [m, T.P.] をセル中心の値から双線形補間する（海は海底の高さ = −水深）。
 * 格子の外側なら null。外周の半セル分は端のセルの値で補う。
 */
export function sampleGroundAt(grid: TerrainGrid, lon: number, lat: number): number | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const { spec, z } = grid;
  const { nx, ny } = spec;
  const { gx, gy } = lonLatToGridXY(spec, lon, lat);
  if (!(gx >= 0 && gy >= 0 && gx <= nx && gy <= ny)) return null;
  const fx = Math.min(Math.max(gx - 0.5, 0), nx - 1);
  const fy = Math.min(Math.max(gy - 0.5, 0), ny - 1);
  const i0 = Math.min(Math.floor(fx), nx - 1);
  const j0 = Math.min(Math.floor(fy), ny - 1);
  const i1 = Math.min(i0 + 1, nx - 1);
  const j1 = Math.min(j0 + 1, ny - 1);
  const tx = fx - i0;
  const ty = fy - j0;
  const a = z[j0 * nx + i0];
  const b = z[j0 * nx + i1];
  const c = z[j1 * nx + i0];
  const d = z[j1 * nx + i1];
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  const v = top + (bottom - top) * ty;
  return Number.isFinite(v) ? v : null;
}
