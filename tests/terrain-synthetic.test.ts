import { describe, expect, it } from 'vitest';
import { cellCenter, createGridSpec, lonLatToCell, type Resolution } from '../src/core/geo';
import { CELL_LAND, CELL_SEA, type TerrainGrid } from '../src/core/types';
import { buildTerrainGrid } from '../src/terrain/build';
import { RIVERS } from '../src/terrain/geography';
import { sampleGround } from '../src/terrain';
import { SYNTHETIC_NOTES, SYNTHETIC_SOURCE_LABEL, syntheticElevation } from '../src/terrain/synthetic';

const RESOLUTIONS: Resolution[] = ['coarse', 'standard', 'fine'];

function synthGrid(res: Resolution): TerrainGrid {
  const spec = createGridSpec(res);
  return buildTerrainGrid(spec, syntheticElevation(spec), {
    source: 'synthetic',
    sourceLabel: SYNTHETIC_SOURCE_LABEL,
    isApproximate: true,
    notes: [...SYNTHETIC_NOTES],
  }).grid;
}

const grids = new Map<Resolution, TerrainGrid>(RESOLUTIONS.map((r) => [r, synthGrid(r)]));

function kindAt(g: TerrainGrid, lon: number, lat: number): number {
  const c = lonLatToCell(g.spec, lon, lat);
  if (!c) throw new Error('outside');
  return g.kind[c.k];
}

describe.each(RESOLUTIONS)('synthetic terrain (%s)', { timeout: 30000 }, (res) => {
  const g = grids.get(res)!;
  const { nx, ny } = g.spec;

  it('has sea in the south and land in the north', () => {
    let seaBottom = 0;
    let landTop = 0;
    for (let i = 0; i < nx; i++) {
      if (g.kind[(ny - 1) * nx + i] === CELL_SEA) seaBottom++;
      if (g.kind[i] === CELL_LAND) landTop++;
    }
    expect(seaBottom).toBe(nx);
    expect(landTop / nx).toBeGreaterThan(0.9);
  });

  it('puts the coastline at the right latitude (辻堂・鵠沼・片瀬)', () => {
    // 海岸線の緯度（e-Stat 境界より）: 139.45 → 約35.3185, 139.47 → 約35.3146, 139.479 → 約35.309
    const cases: [number, number][] = [
      [139.45, 35.3185],
      [139.47, 35.3146],
      [139.479, 35.3091],
    ];
    for (const [lon, lat] of cases) {
      expect(kindAt(g, lon, lat + 0.0012)).toBe(CELL_LAND);
      expect(kindAt(g, lon, lat - 0.0012)).toBe(CELL_SEA);
    }
  });

  it('keeps 江の島 as land surrounded by sea', () => {
    expect(kindAt(g, 139.4795, 35.2995)).toBe(CELL_LAND);
    // 島の周り（約 300〜500 m 離れた点）は海
    for (const [lon, lat] of [
      [139.4795, 35.2945],
      [139.4795, 35.3043],
      [139.4705, 35.2995],
      [139.4905, 35.2995],
    ]) {
      expect(kindAt(g, lon, lat)).toBe(CELL_SEA);
    }
    const summit = sampleGround(g, 139.4795, 35.2995)!;
    expect(summit).toBeGreaterThan(45);
    expect(summit).toBeLessThan(65);
  });

  it('connects 引地川・境川・柏尾川 to the sea (river cells are CELL_SEA)', () => {
    for (const r of RIVERS) {
      // 中心線の途中の点（河口の沖は除く）
      const pts = r.line.slice(2, -2);
      let sea = 0;
      for (const [lon, lat] of pts) if (kindAt(g, lon, lat) === CELL_SEA) sea++;
      expect(sea / pts.length).toBeGreaterThan(0.95);
    }
    // 川の水深は最小水深程度（浅い）
    const c = lonLatToCell(g.spec, 139.46412, 35.32854)!;
    expect(g.kind[c.k]).toBe(CELL_SEA);
    expect(-g.z[c.k]).toBeLessThan(3);
  });

  it('has plausible elevations', () => {
    let minLand = Infinity;
    let maxLand = -Infinity;
    let minSea = Infinity;
    let maxSea = -Infinity;
    for (let k = 0; k < g.z.length; k++) {
      const v = g.z[k];
      if (g.kind[k] === CELL_SEA) {
        if (v < minSea) minSea = v;
        if (v > maxSea) maxSea = v;
      } else {
        if (v < minLand) minLand = v;
        if (v > maxLand) maxLand = v;
      }
    }
    expect(maxSea).toBeLessThanOrEqual(-1 + 1e-6);
    expect(minSea).toBeGreaterThan(-60);
    expect(minLand).toBeGreaterThanOrEqual(0.3);
    expect(maxLand).toBeLessThan(70);
    expect(maxLand).toBeGreaterThan(50);
    const near = (lon: number, lat: number) => sampleGround(g, lon, lat)!;
    // 鵠沼海岸の住宅地（2〜7 m）、片瀬江ノ島駅付近（2〜6 m）
    expect(near(139.4686, 35.3214)).toBeGreaterThan(2);
    expect(near(139.4686, 35.3214)).toBeLessThan(7);
    expect(near(139.483487, 35.308772)).toBeGreaterThan(2);
    expect(near(139.483487, 35.308772)).toBeLessThan(6);
    // 藤沢駅・辻堂駅付近（8〜16 m）
    expect(near(139.4875, 35.3389)).toBeGreaterThan(8);
    expect(near(139.4875, 35.3389)).toBeLessThan(16);
    expect(near(139.4475, 35.3364)).toBeGreaterThan(8);
    expect(near(139.4475, 35.3364)).toBeLessThan(16);
    // 片瀬山（30 m 以上）
    expect(near(139.4935, 35.323)).toBeGreaterThan(30);
    // 砂浜は低く、砂丘は少し高い
    expect(near(139.455, 35.3179)).toBeLessThan(3.5);
  });

  it('is marked approximate', () => {
    expect(g.isApproximate).toBe(true);
    expect(g.source).toBe('synthetic');
    expect(g.sourceLabel).toBe('簡易地形モデル（国土地理院の標高データを取得できなかったため、概略の地形で代用）');
    expect(g.notes.some((s) => s.includes('推定'))).toBe(true);
  });
});

describe('synthetic terrain consistency', { timeout: 30000 }, () => {
  it('is deterministic', () => {
    const spec = createGridSpec('coarse');
    const a = syntheticElevation(spec);
    const b = syntheticElevation(spec);
    const ua = new Uint8Array(a.buffer);
    const ub = new Uint8Array(b.buffer);
    let same = ua.length === ub.length;
    for (let k = 0; same && k < ua.length; k++) same = ua[k] === ub[k];
    expect(same).toBe(true);
  });

  it('agrees between resolutions (land/sea and elevation)', () => {
    const coarse = grids.get('coarse')!;
    const others = [grids.get('standard')!, grids.get('fine')!];
    for (const g of others) {
      let agree = 0;
      let n = 0;
      let dz = 0;
      let m = 0;
      for (let j = 0; j < coarse.spec.ny; j++) {
        for (let i = 0; i < coarse.spec.nx; i++) {
          const c = cellCenter(coarse.spec, i, j);
          const cell = lonLatToCell(g.spec, c.lon, c.lat)!;
          const kc = coarse.kind[j * coarse.spec.nx + i];
          n++;
          if ((kc === CELL_SEA) === (g.kind[cell.k] === CELL_SEA)) agree++;
          if (kc === CELL_LAND && g.kind[cell.k] === CELL_LAND) {
            dz += Math.abs(coarse.z[j * coarse.spec.nx + i] - g.z[cell.k]);
            m++;
          }
        }
      }
      expect(agree / n).toBeGreaterThan(0.97);
      expect(dz / m).toBeLessThan(1.5);
    }
  });
});
