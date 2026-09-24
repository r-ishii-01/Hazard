import { describe, expect, it, vi } from 'vitest';
import { createGridSpec, pixelToLonLat, TILE_SIZE } from '../src/core/geo';
import { CELL_SEA } from '../src/core/types';
import { clearTerrainCache, loadTerrain } from '../src/terrain';
import { encodeDemRgb } from '../src/terrain/gsiDem';

const COAST_LAT = 35.312;
function tile(layer: string, z: number, x: number, y: number) {
  if (layer !== 'dem5a_png') return null;
  const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4); let any = false;
  for (let py = 0; py < TILE_SIZE; py++) { const lat = pixelToLonLat(0, (y * TILE_SIZE + py + 0.5), z).lat;
    for (let px = 0; px < TILE_SIZE; px++) { const h = lat > COAST_LAT ? 2 + (lat - COAST_LAT) * 300 : NaN; if (!Number.isNaN(h)) any = true; rgba.set([...encodeDemRgb(h), 255], (py * TILE_SIZE + px) * 4); } }
  return any ? rgba : null;
}
function mk(opts: { status?: (key: string) => number | 'hang' | null }) {
  const calls: string[] = [];
  const fetchImpl = (url: string): Promise<Response> => {
    if (url.endsWith('manifest.json')) return Promise.resolve(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const m = /(dem5a_png|dem5b_png|dem5c_png|dem_png)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url)!;
    const key = `${m[1]}/${m[2]}/${m[3]}/${m[4]}`; calls.push(key);
    const st = opts.status?.(key);
    if (st === 'hang') return new Promise(() => undefined);
    if (typeof st === 'number') return Promise.resolve(new Response('x', { status: st, headers: { 'content-type': 'text/html' } }));
    const b = tile(m[1], +m[2], +m[3], +m[4]);
    return Promise.resolve(b ? new Response(b, { status: 200, headers: { 'content-type': 'image/png' } }) : new Response('', { status: 404 }));
  };
  const decodeImpl = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
  return { fetchImpl, decodeImpl, calls };
}
describe('repro', { timeout: 30000 }, () => {
  it('north-west tile failure', async () => {
    clearTerrainCache(); vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = mk({ status: (k) => (k === 'dem5a_png/15/29076/12940' ? 500 : null) });
    const g = await loadTerrain('standard', { ...f, baseUrl: '/', noCache: true });
    let northSea = 0; const { nx } = g.spec; for (let j = 0; j < 8; j++) for (let i = 0; i < nx; i++) if (g.kind[j * nx + i] === CELL_SEA) northSea++;
    console.log('source', g.source, 'north sea cells', northSea, g.notes.join(' | '));
  });
  it('403 everywhere', async () => {
    clearTerrainCache();
    const f = mk({ status: () => 403 });
    const g = await loadTerrain('coarse', { ...f, baseUrl: '/', noCache: true });
    console.log('source', g.source, 'requests', f.calls.length, g.notes[0]);
  });
  it('hanging fetch that ignores abort', async () => {
    clearTerrainCache();
    const f = mk({ status: () => 'hang' });
    const t0 = performance.now();
    const r = await Promise.race([loadTerrain('coarse', { ...f, baseUrl: '/', noCache: true, timeoutMs: 300 }).then((g) => g.source), new Promise((res) => setTimeout(() => res('HUNG'), 8000))]);
    console.log('result', r, 'ms', (performance.now() - t0).toFixed(0));
  });
});
void createGridSpec;
