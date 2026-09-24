/**
 * 2D 地図まわりの純粋な計算（maplibre-gl に依存しない。UI からも使い、単体テストできる）。
 */
import { EARTH_RADIUS_M, INITIAL_ZOOM } from '../core/geo';

/** 2D 地図で表示できる範囲（計算範囲の周囲をゆったり）。[[西, 南], [東, 北]] */
export const MAP_VIEW_BOUNDS: [[number, number], [number, number]] = [
  [139.25, 35.17],
  [139.7, 35.47],
];

/** 経緯度が 2D 地図の表示範囲に入るか */
export function isInMapView(lon: number, lat: number): boolean {
  const [[w, s], [e, n]] = MAP_VIEW_BOUNDS;
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= w && lon <= e && lat >= s && lat <= n;
}

/**
 * 計算範囲全体が入るズーム。幅の狭い画面（スマートフォン）では、幅 800px 相当の範囲が入るよう少し引く
 * （初期表示と同じ考え方）。
 */
export function domainZoomForWidth(width: number): number {
  if (!(width > 0) || width >= 800) return INITIAL_ZOOM;
  return Math.max(12.5, INITIAL_ZOOM - Math.log2(800 / width));
}

/**
 * 中心と半径 [m] から円（多角形）の座標を作る（位置の精度を示す円用）。
 * 半径が大きくても形が崩れないよう、測地線上の点（球面の順解）で求める。最後の点は最初の点と同じ（閉じた輪）。
 */
export function circleRing(lon: number, lat: number, radiusM: number, segments = 64): [number, number][] {
  const n = Math.max(8, Math.floor(segments));
  const r = Math.max(0, radiusM) / EARTH_RADIUS_M;
  const DEG = Math.PI / 180;
  const lat1 = lat * DEG;
  const lon1 = lon * DEG;
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const brg = ((i % n) / n) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(r) + Math.cos(lat1) * Math.sin(r) * Math.cos(brg));
    const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(r) * Math.cos(lat1), Math.cos(r) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([lon2 / DEG, lat2 / DEG]);
  }
  return ring;
}
