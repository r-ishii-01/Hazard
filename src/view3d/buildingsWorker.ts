/**
 * 3D 建物の頂点データを作る Web Worker（ベクタータイルのデコードと三角形分割を画面の処理から切り離す）。
 *
 * 受信: { type: 'grid', gen, spec, z, kind } … 足元の高さに使う地形（地形が変わるたびに送る）
 *       { type: 'tile', id, gen, tx, ty, buf } … 建物タイル（PBF）
 * 送信: { type: 'tile', id, result } … 頂点データ（建物が無ければ null）。配列は転送する
 *       { type: 'tile', id, error }
 */
import { buildTileArrays, samplerFor, type BuildingGrid } from './buildingMesh';
import type { HeightSampler } from './sampler';

interface GridMessage extends BuildingGrid {
  type: 'grid';
  gen: number;
}
interface TileMessage {
  type: 'tile';
  id: number;
  gen: number;
  tx: number;
  ty: number;
  buf: ArrayBuffer;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<GridMessage | TileMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let grid: BuildingGrid | null = null;
let sampler: HeightSampler | null = null;
let gridGen = -1;

ctx.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'grid') {
    grid = { spec: m.spec, z: m.z, kind: m.kind };
    sampler = samplerFor(grid);
    gridGen = m.gen;
    return;
  }
  if (m.type === 'tile') {
    if (!grid || !sampler || m.gen !== gridGen) {
      ctx.postMessage({ type: 'tile', id: m.id, stale: true, result: null });
      return;
    }
    try {
      const r = buildTileArrays(m.buf, m.tx, m.ty, grid, sampler);
      if (!r) {
        ctx.postMessage({ type: 'tile', id: m.id, result: null });
        return;
      }
      ctx.postMessage({ type: 'tile', id: m.id, result: r }, [r.position.buffer, r.normal.buffer, r.color.buffer, r.index.buffer]);
    } catch (err) {
      ctx.postMessage({ type: 'tile', id: m.id, error: String((err as Error)?.message ?? err) });
    }
  }
};
