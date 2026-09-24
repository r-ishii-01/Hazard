import { describe, expect, it, vi } from 'vitest';
import { createGridSpec, DOMAIN_BOUNDS } from '../src/core/geo';
import { gsiTileUrl } from '../src/terrain/gsiDem';
import { listRequiredDemTiles } from '../src/terrain/tiles';
import { officialHazardTiles, officialRemoteUrl, officialTileKey } from '../src/data/officialHazard';

interface Tile {
  layer: string;
  z: number;
  x: number;
  y: number;
}
interface PrefetchModule {
  readDomainBounds(): typeof DOMAIN_BOUNDS;
  listTiles(bounds?: typeof DOMAIN_BOUNDS): Tile[];
  listHazardTiles(bounds?: typeof DOMAIN_BOUNDS): Tile[];
  listAllTiles(bounds?: typeof DOMAIN_BOUNDS, only?: 'dem' | 'hazard'): Tile[];
  tileUrl(t: Tile): string;
  tileKey(t: Tile): string;
  main(argv: string[]): Promise<number>;
}

// Node 用スクリプト（.mjs、型定義なし）を動的に読み込む。直接実行時のみ main が走る
const scriptUrl = new URL('../scripts/prefetch-dem.mjs', import.meta.url).href;
const load = async () => (await import(/* @vite-ignore */ scriptUrl)) as PrefetchModule;

describe('scripts/prefetch-dem.mjs', () => {
  it('reads DOMAIN_BOUNDS from src/core/geo.ts', async () => {
    const mod = await load();
    expect(mod.readDomainBounds()).toEqual({ ...DOMAIN_BOUNDS });
  });

  it('lists exactly the tiles loadTerrain may need', async () => {
    const mod = await load();
    const urls = mod.listTiles().map((t) => mod.tileUrl(t));
    expect(urls).toEqual(listRequiredDemTiles().map((t) => gsiTileUrl(t.layer, t.z, t.x, t.y)));
  });

  it('computes the same tile set as the loader for other bounds too (duplicated Web-Mercator math)', async () => {
    const mod = await load();
    for (const b of [
      { west: 139.3, east: 139.61, south: 35.2, north: 35.41 },
      { west: 139.4401, east: 139.4999, south: 35.2901, north: 35.3449 },
      { west: 140.0, east: 140.01, south: 35.0, north: 35.01 },
    ]) {
      const spec = createGridSpec('fine', b as unknown as typeof DOMAIN_BOUNDS);
      const want = listRequiredDemTiles(spec).map((t) => gsiTileUrl(t.layer, t.z, t.x, t.y));
      expect(mod.listTiles(b as typeof DOMAIN_BOUNDS).map((t) => mod.tileUrl(t))).toEqual(want);
    }
  });

  it('lists the official tsunami inundation tiles (z15) that src/data/officialHazard.ts reads from the mirror', async () => {
    const mod = await load();
    const tiles = mod.listHazardTiles();
    const want = officialHazardTiles();
    expect(tiles.length).toBe(want.length);
    expect(tiles.map((t) => mod.tileKey(t))).toEqual(want.map((t) => officialTileKey(t)));
    expect(tiles.map((t) => mod.tileUrl(t))).toEqual(want.map((t) => officialRemoteUrl(t)));
    expect(mod.listAllTiles(undefined, 'dem').length).toBe(listRequiredDemTiles().length);
    expect(mod.listAllTiles(undefined, 'hazard').length).toBe(want.length);
  });

  it('--dry-run prints the URL list without downloading', async () => {
    const mod = await load();
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dem = listRequiredDemTiles().length;
    const hazard = officialHazardTiles().length;
    try {
      expect(await mod.main(['--dry-run'])).toBe(0);
      expect(lines.length).toBe(dem + hazard);
      expect(lines.filter((l) => l.startsWith('https://cyberjapandata.gsi.go.jp/xyz/')).length).toBe(dem);
      expect(lines.filter((l) => l.startsWith('https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/15/')).length).toBe(hazard);
      lines.length = 0;
      expect(await mod.main(['--dry-run', '--only', 'dem'])).toBe(0);
      expect(lines.length).toBe(dem);
      lines.length = 0;
      expect(await mod.main(['--dry-run', '--only', 'hazard'])).toBe(0);
      expect(lines.length).toBe(hazard);
      lines.length = 0;
      expect(await mod.main(['--dry-run', '--json'])).toBe(0);
      const json = JSON.parse(lines.join('\n')) as { tiles: Tile[] };
      expect(json.tiles.length).toBe(dem + hazard);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      err.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('rejects unknown options', async () => {
    const mod = await load();
    await expect(mod.main(['--no-such-option'])).rejects.toThrow('不明なオプション');
    await expect(mod.main(['--only', 'relief'])).rejects.toThrow('--only');
  });
});
