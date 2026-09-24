import { describe, expect, it, vi } from 'vitest';
import { DOMAIN_BOUNDS } from '../src/core/geo';
import { gsiTileUrl } from '../src/terrain/gsiDem';
import { listRequiredDemTiles } from '../src/terrain/tiles';

interface Tile {
  layer: string;
  z: number;
  x: number;
  y: number;
}
interface PrefetchModule {
  readDomainBounds(): typeof DOMAIN_BOUNDS;
  listTiles(bounds?: typeof DOMAIN_BOUNDS): Tile[];
  tileUrl(t: Tile): string;
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

  it('--dry-run prints the URL list without downloading', async () => {
    const mod = await load();
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await mod.main(['--dry-run'])).toBe(0);
      expect(lines.length).toBe(listRequiredDemTiles().length);
      expect(lines.every((l) => l.startsWith('https://cyberjapandata.gsi.go.jp/xyz/'))).toBe(true);
      lines.length = 0;
      expect(await mod.main(['--dry-run', '--json'])).toBe(0);
      const json = JSON.parse(lines.join('\n')) as { tiles: Tile[] };
      expect(json.tiles.length).toBe(listRequiredDemTiles().length);
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
  });
});
