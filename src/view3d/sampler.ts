/**
 * 3D ビュー内で使う地形の補間サンプラー（地形モジュールの実装に依存しない、ローカル実装）。
 *
 * ローカル座標 [m]: グリッド中心が原点、x=東、z=南（geo.ts の lonLatToLocalMeters と同じ）。
 * 標高メッシュの頂点はセル中心に置くので、ここでもセル中心を格子点とした双線形補間を行う。
 */
import { lonLatToLocalMeters, localMetersToLonLat, type GridSpec, type LonLat } from '../core/geo';
import type { TerrainGrid } from '../core/types';

export class HeightSampler {
  readonly spec: GridSpec;
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  /** 頂点（セル中心）が張る範囲の半幅 [m] */
  readonly halfW: number;
  readonly halfH: number;
  private readonly z: Float32Array;

  constructor(readonly grid: TerrainGrid) {
    this.spec = grid.spec;
    this.nx = grid.spec.nx;
    this.ny = grid.spec.ny;
    this.dx = grid.spec.dx;
    this.z = grid.z;
    this.halfW = ((this.nx - 1) / 2) * this.dx;
    this.halfH = ((this.ny - 1) / 2) * this.dx;
  }

  /** ローカル座標 → 連続セル中心座標（セル中心が整数） */
  private toCell(x: number, zm: number): { fx: number; fy: number } {
    return { fx: x / this.dx + this.nx / 2 - 0.5, fy: zm / this.dx + this.ny / 2 - 0.5 };
  }

  /** 範囲内か（メッシュが覆う範囲） */
  inside(x: number, zm: number): boolean {
    return Math.abs(x) <= this.halfW && Math.abs(zm) <= this.halfH;
  }

  /** ローカル座標の地盤高 [m, T.P.]（範囲外は端の値でクランプ） */
  height(x: number, zm: number): number {
    const { fx, fy } = this.toCell(x, zm);
    return this.heightAtCell(fx, fy);
  }

  /** 連続セル中心座標での双線形補間 */
  heightAtCell(fx: number, fy: number): number {
    const nx = this.nx;
    const cx = Math.min(Math.max(fx, 0), nx - 1.0001);
    const cy = Math.min(Math.max(fy, 0), this.ny - 1.0001);
    const i = Math.floor(cx);
    const j = Math.floor(cy);
    const tx = cx - i;
    const ty = cy - j;
    const k = j * nx + i;
    const z = this.z;
    const a = z[k] * (1 - tx) + z[k + 1] * tx;
    const b = z[k + nx] * (1 - tx) + z[k + nx + 1] * tx;
    return a * (1 - ty) + b * ty;
  }

  /**
   * 地形メッシュと同じ三角形分割（各四角形を右上—左下の対角線で2分割）で補間した地盤高。
   * 人形の足元など、描画された地面にぴったり合わせたいときに使う。
   */
  heightMesh(x: number, zm: number): number {
    return triInterp(this.z, this.nx, this.ny, x / this.dx + this.nx / 2 - 0.5, zm / this.dx + this.ny / 2 - 0.5, 1, 0);
  }

  /** ローカル座標を含むセル添字（範囲外は -1） */
  cellIndex(x: number, zm: number): number {
    const gx = x / this.dx + this.nx / 2;
    const gy = zm / this.dx + this.ny / 2;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1;
    return j * this.nx + i;
  }

  toLocal(lon: number, lat: number): { x: number; z: number } {
    return lonLatToLocalMeters(this.spec, lon, lat);
  }

  toLonLat(x: number, zm: number): LonLat {
    return localMetersToLonLat(this.spec, x, zm);
  }

  /** 経緯度の地盤高 [m, T.P.] */
  heightAtLonLat(lon: number, lat: number): number {
    const p = this.toLocal(lon, lat);
    return this.height(p.x, p.z);
  }
}

/**
 * 格子点（セル中心）の値を、メッシュと同じ三角形分割で補間する。
 * arr[k * stride + offset] が格子点 k の値。四角形 (a=(i,j), b=(i+1,j), d=(i,j+1), e=(i+1,j+1)) を
 * 対角線 b–d で (a,d,b) と (b,d,e) に分ける（terrain.ts の index と同じ）。
 */
export function triInterp(arr: ArrayLike<number>, nx: number, ny: number, fx: number, fy: number, stride: number, offset: number): number {
  const cx = Math.min(Math.max(fx, 0), nx - 1.0001);
  const cy = Math.min(Math.max(fy, 0), ny - 1.0001);
  const i = Math.floor(cx);
  const j = Math.floor(cy);
  const tx = cx - i;
  const ty = cy - j;
  const ka = j * nx + i;
  const kb = ka + 1;
  const kd = ka + nx;
  const ke = kd + 1;
  const va = arr[ka * stride + offset];
  const vb = arr[kb * stride + offset];
  const vd = arr[kd * stride + offset];
  if (tx + ty <= 1) return va * (1 - tx - ty) + vb * tx + vd * ty;
  const ve = arr[ke * stride + offset];
  return vb * (1 - ty) + vd * (1 - tx) + ve * (tx + ty - 1);
}
