import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cellCenter, lonLatToCell, pixelToLonLat, TILE_SIZE } from '../src/core/geo';
import { CELL_INLAND_WATER, CELL_LAND, CELL_SEA } from '../src/core/types';
import { clearTerrainCache, loadTerrain, sampleGround } from '../src/terrain';
import { encodeDemRgb } from '../src/terrain/gsiDem';
import { parseManifest } from '../src/terrain/fetchDem';
import { listRequiredDemTiles } from '../src/terrain/tiles';

/**
 * 解析的な「地形」: 北緯 35.312 度より北が陸（標高は北へ緩やかに上昇）、
 * 経度 riverLon 付近に幅 約40 m の川（NA、海につながる）、内陸に池（NA）。
 */
const COAST_LAT = 35.312;
const RIVER_LON = 139.4705;
const POND = { lon: 139.455, lat: 35.33, r: 0.0004 };

function truthAt(lon: number, lat: number): number {
  if (lat <= COAST_LAT) return Number.NaN;
  if (Math.abs(lon - RIVER_LON) < 0.00022) return Number.NaN;
  if (Math.hypot(lon - POND.lon, lat - POND.lat) < POND.r) return Number.NaN;
  return 2 + (lat - COAST_LAT) * 300;
}

/** 「PNG」の代わりに生の RGBA を返す（decodeImpl で読む）。タイルはテスト全体で使い回す */
const tileCache = new Map<string, Uint8Array<ArrayBuffer> | null>();
function tileBytes(layer: string, z: number, x: number, y: number): Uint8Array<ArrayBuffer> | null {
  const key = `${layer}/${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key)!;
  const scale = 2 ** (15 - z);
  const lons = new Float64Array(TILE_SIZE);
  const lats = new Float64Array(TILE_SIZE);
  for (let q = 0; q < TILE_SIZE; q++) {
    lons[q] = pixelToLonLat((x * TILE_SIZE + q + 0.5) * scale, 0, 15).lon;
    lats[q] = pixelToLonLat(0, (y * TILE_SIZE + q + 0.5) * scale, 15).lat;
  }
  const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  let any = false;
  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      let h = truthAt(lons[px], lats[py]);
      // DEM10B は川の水面にも値（等高線からの補間値）を持つことがある
      if (layer === 'dem_png' && Number.isNaN(h) && lats[py] > COAST_LAT) h = 3;
      if (!Number.isNaN(h)) any = true;
      const [r, g, b] = encodeDemRgb(h);
      rgba.set([r, g, b, 255], (py * TILE_SIZE + px) * 4);
    }
  }
  const out = any ? rgba : null;
  tileCache.set(key, out);
  return out;
}

interface FakeOptions {
  /** GSI への接続が失敗する */
  offline?: boolean;
  /** GSI が 500 を返すタイル（key） */
  fail?: (key: string) => boolean;
  /** ミラーの manifest（null = 無し） */
  manifest?: Record<string, 0 | 1> | null;
}

function fakeFetch(opts: FakeOptions = {}) {
  const calls = { gsi: 0, mirror: 0, manifest: 0, gsiKeys: [] as string[] };
  const bytes = (key: string) => {
    const [layer, z, x, y] = key.split('/');
    return layer === 'dem5b_png' || layer === 'dem5c_png' ? null : tileBytes(layer, +z, +x, +y);
  };
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    await Promise.resolve();
    if (url.endsWith('tiles/manifest.json')) {
      calls.manifest++;
      if (!opts.manifest) return new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(JSON.stringify({ version: 1, tiles: opts.manifest }), { status: 200 });
    }
    const m = /(dem5a_png|dem5b_png|dem5c_png|dem_png)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
    if (!m) return new Response('', { status: 404 });
    const key = `${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
    if (url.startsWith('https://cyberjapandata.gsi.go.jp/')) {
      calls.gsi++;
      calls.gsiKeys.push(key);
      if (opts.offline) throw new TypeError('Failed to fetch');
      if (opts.fail?.(key)) return new Response('error', { status: 500 });
    } else {
      calls.mirror++;
    }
    const b = bytes(key);
    if (!b) return new Response('', { status: 404 });
    return new Response(b, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const decodeImpl = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
  return { fetchImpl, decodeImpl, calls };
}

beforeEach(() => {
  clearTerrainCache();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('loadTerrain with GSI tiles', { timeout: 60000 }, () => {
  it('builds the grid from DEM5A, keeps rivers as sea and ponds as inland water', async () => {
    const f = fakeFetch();
    const progress: [number, string][] = [];
    const t0 = performance.now();
    const grid = await loadTerrain('standard', {
      fetchImpl: f.fetchImpl,
      decodeImpl: f.decodeImpl,
      baseUrl: '/',
      noCache: true,
      requestKnownMissing: true,
      onProgress: (p, m) => progress.push([p, m]),
    });
    const elapsed = performance.now() - t0;
    expect(grid.source).toBe('gsi');
    expect(grid.isApproximate).toBe(false);
    expect(grid.sourceLabel).toContain('国土地理院');
    expect(grid.sourceLabel).toContain('DEM5A');
    expect(grid.notes.some((s) => s.includes('推定'))).toBe(true);
    expect(grid.z.every((v) => Number.isFinite(v))).toBe(true);

    const kind = (lon: number, lat: number) => grid.kind[lonLatToCell(grid.spec, lon, lat)!.k];
    expect(kind(139.46, 35.33)).toBe(CELL_LAND);
    expect(kind(139.46, 35.30)).toBe(CELL_SEA);
    expect(kind(RIVER_LON, 35.335)).toBe(CELL_SEA); // 川（DEM10B の値で埋めない）
    expect(kind(POND.lon, POND.lat)).toBe(CELL_INLAND_WATER);

    // 陸の標高は元の値の平均に近い
    const c = lonLatToCell(grid.spec, 139.45, 35.33)!;
    const center = cellCenter(grid.spec, c.i, c.j);
    expect(grid.z[c.k]).toBeCloseTo(2 + (center.lat - COAST_LAT) * 300, 1);
    expect(sampleGround(grid, 139.45, 35.33)).toBeCloseTo(2 + (35.33 - COAST_LAT) * 300, 1);

    // 進捗は 0..1 で単調、日本語のメッセージ
    for (let i = 1; i < progress.length; i++) expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0]);
    expect(progress[progress.length - 1][0]).toBe(1);
    expect(progress.some(([, m]) => m.includes('標高タイル'))).toBe(true);

    // DEM5B/5C は無効値を含むタイルだけ、DEM10B は 5m 系が無いタイルだけ要求する
    const b = f.calls.gsiKeys.filter((k) => k.startsWith('dem5b_png'));
    const a = f.calls.gsiKeys.filter((k) => k.startsWith('dem5a_png'));
    expect(a.length).toBe(48);
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBeLessThan(48);
    expect(elapsed).toBeLessThan(20000); // 目安の確認のみ（性能は terrain-pipeline の測定で確認）
  });

  it('does not request tiles known to be missing at GSI', async () => {
    const f = fakeFetch();
    const grid = await loadTerrain('coarse', { fetchImpl: f.fetchImpl, decodeImpl: f.decodeImpl, baseUrl: '/', noCache: true });
    expect(grid.source).toBe('gsi');
    expect(f.calls.gsiKeys.some((k) => k.startsWith('dem5b_png') || k.startsWith('dem5c_png'))).toBe(false);
    expect(f.calls.gsiKeys).not.toContain('dem5a_png/15/29076/12947');
    expect(f.calls.gsiKeys.filter((k) => k.startsWith('dem5a_png')).length).toBe(48 - 14);
  });

  it('reuses the mosaic for other resolutions (cache)', async () => {
    const f = fakeFetch();
    const g1 = await loadTerrain('coarse', { fetchImpl: f.fetchImpl, decodeImpl: f.decodeImpl, baseUrl: '/' });
    const n = f.calls.gsi;
    const g2 = await loadTerrain('fine', { fetchImpl: f.fetchImpl, decodeImpl: f.decodeImpl, baseUrl: '/' });
    expect(f.calls.gsi).toBe(n);
    expect(g1.spec.cellPx).toBe(8);
    expect(g2.spec.cellPx).toBe(2);
    expect(g2.source).toBe('gsi');
  });

  it('prefers the local mirror listed in tiles/manifest.json', async () => {
    const manifest: Record<string, 0 | 1> = {};
    const probe = fakeFetch();
    for (const t of listRequiredDemTiles()) {
      const res = await probe.fetchImpl(`/tiles/${t.layer}/${t.z}/${t.x}/${t.y}.png`);
      manifest[`${t.layer}/${t.z}/${t.x}/${t.y}`] = res.status === 200 ? 1 : 0;
    }
    const f = fakeFetch({ manifest, offline: true });
    const grid = await loadTerrain('standard', { fetchImpl: f.fetchImpl, decodeImpl: f.decodeImpl, baseUrl: '/', noCache: true });
    expect(f.calls.gsi).toBe(0);
    expect(grid.source).toBe('cache');
    expect(grid.isApproximate).toBe(false);
  });

  it('ignores an invalid manifest (dev server SPA fallback)', () => {
    expect(parseManifest('<!doctype html>')).toBeNull();
    expect(parseManifest('{"version":2,"tiles":{}}')).toBeNull();
    expect(parseManifest('{"version":1,"tiles":{"a":1}}')).not.toBeNull();
  });
});

describe('loadTerrain fallback', { timeout: 60000 }, () => {
  it('falls back to the synthetic terrain quickly when GSI is unreachable', async () => {
    const f = fakeFetch({ offline: true });
    const t0 = performance.now();
    const grid = await loadTerrain('standard', { fetchImpl: f.fetchImpl, decodeImpl: f.decodeImpl, baseUrl: '/', noCache: true });
    expect(performance.now() - t0).toBeLessThan(15000);
    expect(grid.source).toBe('synthetic');
    expect(grid.isApproximate).toBe(true);
    expect(grid.sourceLabel).toBe('簡易地形モデル（国土地理院の標高データを取得できなかったため、概略の地形で代用）');
    expect(grid.notes[0]).toMatch(/^理由: /);
    // 接続確認の1枚だけで諦める
    expect(f.calls.gsi).toBe(1);
  });

  it('falls back when too many tiles fail', async () => {
    const f = fakeFetch({ fail: (key) => !key.endsWith('/12944') && Number(key.split('/')[2]) % 2 === 0 });
    const grid = await loadTerrain('coarse', { fetchImpl: f.fetchImpl, decodeImpl: f.decodeImpl, baseUrl: '/', noCache: true });
    expect(grid.source).toBe('synthetic');
    expect(grid.notes[0]).toContain('取得できず');
  });

  it('uses the synthetic terrain when requested', async () => {
    const f = fakeFetch();
    const grid = await loadTerrain('coarse', { source: 'synthetic', fetchImpl: f.fetchImpl, decodeImpl: f.decodeImpl });
    expect(grid.source).toBe('synthetic');
    expect(f.calls.gsi + f.calls.manifest).toBe(0);
  });

  it('rejects with AbortError when aborted', async () => {
    const f = fakeFetch();
    const ac = new AbortController();
    const p = loadTerrain('standard', {
      fetchImpl: f.fetchImpl,
      decodeImpl: f.decodeImpl,
      baseUrl: '/',
      noCache: true,
      signal: ac.signal,
      onProgress: (x) => {
        if (x > 0.2) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const ac2 = new AbortController();
    ac2.abort();
    await expect(loadTerrain('coarse', { signal: ac2.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
