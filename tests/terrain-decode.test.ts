import { describe, expect, it } from 'vitest';
import {
  DEM_LAYERS,
  decodeDemRgb,
  decodeDemTile,
  encodeDemRgb,
  gsiTileUrl,
  mirrorTilePath,
  tileKey,
} from '../src/terrain/gsiDem';

describe('GSI DEM PNG decoding (demtile.html spec)', () => {
  it('decodes positive heights: h = 0.01 * (2^16 R + 2^8 G + B)', () => {
    expect(decodeDemRgb(0, 0, 0)).toBe(0);
    expect(decodeDemRgb(0, 0, 1)).toBeCloseTo(0.01, 10);
    expect(decodeDemRgb(0, 1, 0)).toBeCloseTo(2.56, 10);
    // 3776.24 m（富士山頂付近の値の例）: x = 377624 = 0x05 0xC3 0x18
    expect(decodeDemRgb(0x05, 0xc3, 0x18)).toBeCloseTo(3776.24, 6);
    // 2^23 - 1 は最大の正の値
    expect(decodeDemRgb(127, 255, 255)).toBeCloseTo(83886.07, 4);
  });

  it('treats x = 2^23 (RGB 128,0,0) as NA', () => {
    expect(Number.isNaN(decodeDemRgb(128, 0, 0))).toBe(true);
  });

  it('decodes negative heights: h = 0.01 * (x - 2^24)', () => {
    expect(decodeDemRgb(255, 255, 255)).toBeCloseTo(-0.01, 10);
    expect(decodeDemRgb(255, 255, 156)).toBeCloseTo(-1.0, 10);
    expect(decodeDemRgb(128, 0, 1)).toBeCloseTo(-83886.07, 4);
  });

  it('round-trips through encodeDemRgb', () => {
    for (const h of [0, 0.01, 1.23, 12.34, 60.4, 3776.24, -0.5, -12.34]) {
      const [r, g, b] = encodeDemRgb(h);
      expect(decodeDemRgb(r, g, b)).toBeCloseTo(h, 6);
    }
    expect(encodeDemRgb(Number.NaN)).toEqual([128, 0, 0]);
  });

  it('decodes an RGBA tile, treating NA and transparent pixels as NaN', () => {
    const rgba = new Uint8ClampedArray(4 * 4);
    rgba.set([...encodeDemRgb(5.5), 255], 0);
    rgba.set([128, 0, 0, 255], 4);
    rgba.set([...encodeDemRgb(-2), 255], 8);
    rgba.set([...encodeDemRgb(7), 0], 12); // 透明
    const out = decodeDemTile(rgba);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(5.5, 5);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBeCloseTo(-2, 5);
    expect(Number.isNaN(out[3])).toBe(true);
  });

  it('builds GSI and mirror URLs', () => {
    expect(gsiTileUrl('dem5a_png', 15, 29078, 12944)).toBe('https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/15/29078/12944.png');
    expect(mirrorTilePath('dem_png', 14, 14539, 6472)).toBe('tiles/dem_png/14/14539/6472.png');
    expect(tileKey('dem5b_png', 15, 1, 2)).toBe('dem5b_png/15/1/2');
    expect(DEM_LAYERS.map((l) => l.label)).toEqual(['DEM5A', 'DEM5B', 'DEM5C', 'DEM10B']);
    expect(DEM_LAYERS.map((l) => l.zoom)).toEqual([15, 15, 15, 14]);
  });
});

describe('known-missing tile list', () => {
  it('parses single tiles and ranges', async () => {
    const { isKnownMissingTile, listRequiredDemTiles } = await import('../src/terrain/tiles');
    expect(isKnownMissingTile('dem5a_png', 15, 29076, 12947)).toBe(true);
    expect(isKnownMissingTile('dem5a_png', 15, 29079, 12947)).toBe(true);
    expect(isKnownMissingTile('dem5a_png', 15, 29078, 12944)).toBe(false); // 鵠沼海岸（陸を含む）
    expect(isKnownMissingTile('dem5b_png', 15, 29078, 12944)).toBe(true);
    expect(isKnownMissingTile('dem_png', 14, 14538, 6473)).toBe(true);
    expect(isKnownMissingTile('dem_png', 15, 14538, 6473)).toBe(false); // ズームが違う
    const all = listRequiredDemTiles();
    expect(all.filter((t) => isKnownMissingTile(t.layer, t.z, t.x, t.y)).length).toBe(14 + 48 + 48 + 1);
  });
});
