/**
 * 2D 地図のスタイル（外部の style.json・グリフ・スプライトに依存しない）。
 * レイヤーの重なり順（下から）:
 *   背景 → 背景地図 → 色別標高 → 公式ハザードマップ → 到達時間 → 最大浸水深 → 浸水（現在）
 *   → 計算範囲の枠 → 現在地の精度の円 → 避難経路 → 避難先
 */
import type { MapOptions } from 'maplibre-gl';
import type { Basemap, LayerState } from '../core/types';
import { BASEMAPS, HAZARD_TSUNAMI_TILES, RELIEF_TILES, type RasterTileSource } from '../data/sources';
import { HAZARD_PROTOCOL_URL } from './hazardTiles';

export type StyleSpec = Exclude<MapOptions['style'], string | undefined>;
export type LayerSpec = StyleSpec['layers'][number];
export type SourceSpec = StyleSpec['sources'][string];
type Coords = [[number, number], [number, number], [number, number], [number, number]];

export const IDS = {
  background: 'm2d-bg',
  relief: 'm2d-relief',
  hazard: 'm2d-hazard',
  arrival: 'm2d-arrival',
  maxDepth: 'm2d-maxdepth',
  flood: 'm2d-flood',
  domainSource: 'm2d-domain',
  domainCasing: 'm2d-domain-casing',
  domainLine: 'm2d-domain-line',
  routeSource: 'm2d-routes',
  routeCasing: 'm2d-route-casing',
  routeAhead: 'm2d-route-ahead',
  routeDone: 'm2d-route-done',
  targetSource: 'm2d-targets',
  targetLayer: 'm2d-target',
  userLocSource: 'm2d-userloc',
  userLocFill: 'm2d-userloc-fill',
  userLocLine: 'm2d-userloc-line',
} as const;

export const basemapLayerId = (b: Basemap) => `m2d-base-${b}`;

/** 範囲（おおよそ）の外のタイルは要求しない */
const TILE_BOUNDS: [number, number, number, number] = [139.2, 35.1, 139.75, 35.55];

export function rasterSource(src: RasterTileSource): SourceSpec {
  return {
    type: 'raster',
    tiles: [src.url],
    tileSize: src.tileSize,
    minzoom: src.minzoom,
    maxzoom: src.maxzoom,
    attribution: src.attribution,
    bounds: TILE_BOUNDS,
  };
}

export function basemapLayer(b: Basemap): LayerSpec {
  return {
    id: basemapLayerId(b),
    type: 'raster',
    source: basemapLayerId(b),
    paint: { 'raster-fade-duration': 120 },
  };
}

/** シミュレーション結果の各レイヤーの基本の不透明度 */
export const SIM_OPACITY = { flood: 0.92, maxDepth: 0.85, arrival: 0.72 } as const;

/** 最小限の GeoJSON 型（@types/geojson をグローバルに読み込んでいないため） */
export type GeoGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] };
export interface GeoFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: GeoGeometry;
}
export interface GeoFeatureCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

export const emptyFC = (): GeoFeatureCollection => ({ type: 'FeatureCollection', features: [] });

export function buildStyle(basemap: Basemap, layers: LayerState, corners: Coords): StyleSpec {
  const vis = (on: boolean) => (on ? 'visible' : 'none') as 'visible' | 'none';
  // 画像がまだ無い url なしの image ソースを表示状態にすると、そのタイルが「読み込み中」のまま残り
  // 地図の load/idle が発火しなくなる。画像を転送してから表示する（applyLayers）。
  const image = (id: string, opacity: number): LayerSpec => ({
    id,
    type: 'raster',
    source: id,
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
  });
  return {
    version: 8,
    name: 'kugenuma-2d',
    sources: {
      [basemapLayerId(basemap)]: rasterSource(BASEMAPS[basemap]),
      [IDS.relief]: rasterSource(RELIEF_TILES),
      // 海だけのタイルを要求しないよう、独自スキーム経由で読む（hazardTiles.ts）
      [IDS.hazard]: { ...rasterSource(HAZARD_TSUNAMI_TILES), tiles: [HAZARD_PROTOCOL_URL] } as SourceSpec,
      [IDS.arrival]: { type: 'image', coordinates: corners },
      [IDS.maxDepth]: { type: 'image', coordinates: corners },
      [IDS.flood]: { type: 'image', coordinates: corners },
      [IDS.domainSource]: { type: 'geojson', data: domainGeoJSON(corners) },
      [IDS.routeSource]: { type: 'geojson', data: emptyFC() },
      [IDS.targetSource]: { type: 'geojson', data: emptyFC() },
      [IDS.userLocSource]: { type: 'geojson', data: emptyFC() },
    },
    layers: [
      { id: IDS.background, type: 'background', paint: { 'background-color': '#e8eef2' } },
      basemapLayer(basemap),
      {
        id: IDS.relief,
        type: 'raster',
        source: IDS.relief,
        layout: { visibility: vis(layers.elevation) },
        paint: { 'raster-opacity': 0.6, 'raster-fade-duration': 120 },
      },
      {
        id: IDS.hazard,
        type: 'raster',
        source: IDS.hazard,
        layout: { visibility: vis(layers.officialHazard) },
        paint: { 'raster-opacity': layers.officialHazardOpacity, 'raster-fade-duration': 120 },
      },
      image(IDS.arrival, SIM_OPACITY.arrival),
      image(IDS.maxDepth, SIM_OPACITY.maxDepth),
      image(IDS.flood, SIM_OPACITY.flood),
      {
        id: IDS.domainCasing,
        type: 'line',
        source: IDS.domainSource,
        paint: { 'line-color': '#ffffff', 'line-width': 3.5, 'line-opacity': 0.7 },
      },
      {
        id: IDS.domainLine,
        type: 'line',
        source: IDS.domainSource,
        paint: { 'line-color': '#1e293b', 'line-width': 1.6, 'line-dasharray': [3, 2.5], 'line-opacity': 0.85 },
      },
      // 現在地の精度（誤差の半径）の円
      {
        id: IDS.userLocFill,
        type: 'fill',
        source: IDS.userLocSource,
        paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.12 },
      },
      {
        id: IDS.userLocLine,
        type: 'line',
        source: IDS.userLocSource,
        paint: { 'line-color': '#2563eb', 'line-width': 1.5, 'line-opacity': 0.55 },
      },
      // 避難経路: 下地（白）→ 通過済み（実線）→ これから（破線）
      {
        id: IDS.routeCasing,
        type: 'line',
        source: IDS.routeSource,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['case', ['get', 'sel'], 8, 5],
          'line-opacity': ['case', ['get', 'sel'], 0.95, 0.7],
        },
      },
      {
        id: IDS.routeDone,
        type: 'line',
        source: IDS.routeSource,
        filter: ['==', ['get', 'part'], 'done'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'sel'], 5, 3],
          'line-opacity': ['case', ['get', 'sel'], 1, 0.75],
        },
      },
      {
        id: IDS.routeAhead,
        type: 'line',
        source: IDS.routeSource,
        filter: ['==', ['get', 'part'], 'ahead'],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'sel'], 4, 2.5],
          'line-opacity': ['case', ['get', 'sel'], 1, 0.7],
          'line-dasharray': [1.6, 1.2],
        },
      },
      {
        id: IDS.targetLayer,
        type: 'circle',
        source: IDS.targetSource,
        paint: {
          'circle-radius': ['case', ['get', 'sel'], 15, 11],
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': ['case', ['get', 'sel'], 3, 2],
          'circle-stroke-opacity': ['case', ['get', 'sel'], 1, 0.7],
        },
      },
    ],
  };
}

/** 計算範囲の枠（閉じた線） */
export function domainGeoJSON(c: Coords): GeoFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [c[0], c[1], c[2], c[3], c[0]] },
      },
    ],
  };
}
