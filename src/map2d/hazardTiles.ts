/**
 * 公式の津波浸水想定タイル（ハザードマップポータルサイト）の読み込み。
 *
 * 浸水想定の無い場所（海だけのタイルなど）はサーバーが 404 を返し、ブラウザのコンソールに
 * 「Failed to load resource」が並ぶ。計算範囲の中で海・川のセルだけからなるタイル（浸水想定は陸にしか色が無い）は
 * 要求せずに透明な画像を返し、それ以外で 404 だったタイルも透明な画像として扱う。
 * MapLibre の addProtocol で独自のスキーム（kgz-hazard://z/x/y）を登録して実現する。
 */
import { addProtocol } from 'maplibre-gl';
import { TILE_SIZE } from '../core/geo';
import { CELL_SEA, type TerrainGrid } from '../core/types';
import { HAZARD_TSUNAMI_TILES } from '../data/sources';

export const HAZARD_PROTOCOL = 'kgz-hazard';
export const HAZARD_PROTOCOL_URL = `${HAZARD_PROTOCOL}://{z}/{x}/{y}`;

/** 1×1 の透明な PNG */
const EMPTY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
let emptyPng: Uint8Array | null = null;
function emptyTile(): ArrayBuffer {
  if (!emptyPng) emptyPng = Uint8Array.from(atob(EMPTY_PNG_B64), (c) => c.charCodeAt(0));
  return emptyPng.slice().buffer;
}

let maskGrid: TerrainGrid | null = null;

/** 海のタイルの判定に使う地形（読み込み済みのものを渡す） */
export function setHazardMaskGrid(grid: TerrainGrid | null): void {
  maskGrid = grid;
}

/**
 * タイル (z, x, y) が計算範囲の内側にあり、周囲1セルを含めてすべて海・川のセルなら true。
 * 範囲の外にかかるタイルは分からないので false（普通に要求する）。
 */
export function isSeaOnlyTile(grid: TerrainGrid | null, z: number, x: number, y: number): boolean {
  if (!grid) return false;
  const spec = grid.spec;
  const scale = Math.pow(2, spec.zoom - z);
  const px0 = x * TILE_SIZE * scale - spec.originPx;
  const py0 = y * TILE_SIZE * scale - spec.originPy;
  const px1 = px0 + TILE_SIZE * scale;
  const py1 = py0 + TILE_SIZE * scale;
  const i0 = Math.floor(px0 / spec.cellPx) - 1;
  const j0 = Math.floor(py0 / spec.cellPx) - 1;
  const i1 = Math.ceil(px1 / spec.cellPx);
  const j1 = Math.ceil(py1 / spec.cellPx);
  if (i0 < 0 || j0 < 0 || i1 >= spec.nx || j1 >= spec.ny) return false;
  for (let j = j0; j <= j1; j++) {
    const row = j * spec.nx;
    for (let i = i0; i <= i1; i++) if (grid.kind[row + i] !== CELL_SEA) return false;
  }
  return true;
}

let registered = false;

/** 独自スキームを登録する（何度呼んでもよい） */
export function registerHazardProtocol(): void {
  if (registered) return;
  registered = true;
  addProtocol(HAZARD_PROTOCOL, async (params, abortController) => {
    const m = /^kgz-hazard:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error(`不正なタイルの URL: ${params.url}`);
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (isSeaOnlyTile(maskGrid, z, x, y)) return { data: emptyTile() };
    const url = HAZARD_TSUNAMI_TILES.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const res = await fetch(url, { signal: abortController.signal });
    // 浸水想定の無いタイルは 404（通常の応答）
    if (res.status === 404) return { data: emptyTile() };
    if (!res.ok) throw new Error(`タイルを取得できませんでした（HTTP ${res.status}）`);
    return { data: await res.arrayBuffer() };
  });
}
