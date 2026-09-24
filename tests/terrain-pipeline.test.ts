import { describe, expect, it } from 'vitest';
import { createGridSpec, TILE_SIZE } from '../src/core/geo';
import { CELL_INLAND_WATER, CELL_LAND, CELL_SEA } from '../src/core/types';
import { aggregateToCells } from '../src/terrain/aggregate';
import { applyBathymetry, offshoreDepth, SHONAN_PROFILE } from '../src/terrain/bathymetry';
import { buildTerrainGrid, MANNING } from '../src/terrain/build';
import { bridgeWaterGaps, classifyWater } from '../src/terrain/classify';
import { distanceTransform } from '../src/terrain/distance';
import { buildMosaic, type TileSlot } from '../src/terrain/mosaic';
import { demTileRanges, listRequiredDemTiles, pixelDomain } from '../src/terrain/tiles';

const NaN_ = Number.NaN;

describe('aggregateToCells', () => {
  it('averages valid pixels and marks cells with >= 50% NA as water', () => {
    // 4x2 画素 → 2x1 セル（cellPx = 2）
    const px = new Float32Array([
      1, 3, NaN_, 10, //
      5, NaN_, NaN_, NaN_,
    ]);
    const r = aggregateToCells(px, 4, 2, 2, 2, 1);
    expect(r.elev[0]).toBeCloseTo(3, 6); // (1+3+5)/3, NA 1/4
    expect(Number.isNaN(r.elev[1])).toBe(true); // NA 3/4
  });
  it('exactly half NA counts as water', () => {
    const px = new Float32Array([1, NaN_, 2, NaN_]);
    const r = aggregateToCells(px, 2, 2, 2, 1, 1);
    expect(Number.isNaN(r.elev[0])).toBe(true);
  });
  it('rejects grids larger than the mosaic', () => {
    expect(() => aggregateToCells(new Float32Array(4), 2, 2, 2, 2, 2)).toThrow();
  });
});

/** 文字列の地図から標高配列を作る: '~' = 水面(NaN)、数字 = 標高 */
function fromMap(rows: string[]): { elev: Float32Array; nx: number; ny: number } {
  const ny = rows.length;
  const nx = rows[0].length;
  const elev = new Float32Array(nx * ny);
  rows.forEach((row, j) => {
    for (let i = 0; i < nx; i++) elev[j * nx + i] = row[i] === '~' ? NaN_ : Number(row[i]);
  });
  return { elev, nx, ny };
}

describe('classifyWater', () => {
  it('separates sea (touching S/E/W edges, incl. connected rivers) from inland water; islands stay land', () => {
    const { elev, nx, ny } = fromMap([
      '5555~5555', // 0: 川の上流端（北端に接するだけでは海にならない。川は下で海につながる）
      '5555~5555',
      '5~55~5555', // 2: 池（i=1）と川（i=4）
      '5433~3345',
      '3322~2233',
      '~~~~~~~~~', // 5: 海
      '~~~33~~~~', // 6: 島
      '~~~~~~~~~',
    ]);
    const r = classifyWater(elev, nx, ny);
    const at = (i: number, j: number) => r.kind[j * nx + i];
    expect(at(4, 0)).toBe(CELL_SEA); // 海につながる川
    expect(at(4, 3)).toBe(CELL_SEA);
    expect(at(0, 5)).toBe(CELL_SEA);
    expect(at(1, 2)).toBe(CELL_INLAND_WATER); // 池
    expect(r.z[2 * nx + 1]).toBe(4); // 周囲の陸の最低標高
    expect(at(3, 6)).toBe(CELL_LAND); // 島
    expect(at(4, 6)).toBe(CELL_LAND);
    expect(at(0, 0)).toBe(CELL_LAND);
    expect(Number.isNaN(r.z[5 * nx])).toBe(true); // 海は後で水深を与える
    expect(r.inlandComponents).toBe(1);
  });

  it('water touching only the north edge is inland', () => {
    const { elev, nx, ny } = fromMap(['5~5', '5~5', '555', '~~~']);
    const r = classifyWater(elev, nx, ny);
    expect(r.kind[1]).toBe(CELL_INLAND_WATER);
    expect(r.kind[1 * nx + 1]).toBe(CELL_INLAND_WATER);
    expect(r.kind[3 * nx]).toBe(CELL_SEA);
  });

  it('uses the lowest neighbouring land as the pond level', () => {
    const { elev, nx, ny } = fromMap(['9999', '9~~9', '97~9', '9999']);
    const r = classifyWater(elev, nx, ny);
    expect(r.kind[1 * nx + 1]).toBe(CELL_INLAND_WATER);
    expect(r.z[1 * nx + 1]).toBe(7);
    expect(r.z[2 * nx + 2]).toBe(7);
  });
});

describe('bridgeWaterGaps', () => {
  /** '~' 水面、'p' 水面を 30% 含む陸、'q' 水面を 10% 含む陸、数字 = 陸 */
  function mapWithFrac(rows: string[]) {
    const { nx, ny } = { nx: rows[0].length, ny: rows.length };
    const elev = new Float32Array(nx * ny);
    const frac = new Float32Array(nx * ny);
    rows.forEach((row, j) => {
      for (let i = 0; i < nx; i++) {
        const ch = row[i];
        const k = j * nx + i;
        elev[k] = ch === '~' ? NaN_ : ch === 'p' || ch === 'q' ? 4 : Number(ch);
        frac[k] = ch === '~' ? 1 : ch === 'p' ? 0.3 : ch === 'q' ? 0.1 : 0;
      }
    });
    return { elev, frac, nx, ny };
  }

  it('reconnects a river interrupted by partially wet cells, but not across dry land or long gaps', () => {
    const m = mapWithFrac([
      '555~5555~55', // 0: 川A（上流）      川B
      '555p5555q55', // 1: 30% → 橋渡し    10% → しない
      '555~5555~55', // 2
      '555p5555~55', // 3: もう1か所途切れ（繰り返しでつながる）
      '555~5555555', // 4: 川B は乾いた陸で途切れる
      '55p~ppp5~55', // 5: 海岸の 30% セル（経路でなければ水域にしない）
      '~~~~~~~~~~~', // 6: 海
    ]);
    const n = bridgeWaterGaps(m.elev, m.frac, m.nx, m.ny);
    const r = classifyWater(m.elev, m.nx, m.ny);
    const at = (i: number, j: number) => r.kind[j * m.nx + i];
    expect(at(3, 0)).toBe(CELL_SEA); // 川A は海につながった
    expect(at(3, 1)).toBe(CELL_SEA);
    expect(at(3, 3)).toBe(CELL_SEA);
    expect(at(8, 0)).toBe(CELL_INLAND_WATER); // 川B は切れたまま
    expect(at(8, 3)).toBe(CELL_INLAND_WATER);
    expect(at(2, 5)).toBe(CELL_LAND); // 海岸線は動かさない
    expect(at(5, 5)).toBe(CELL_LAND);
    expect(n).toBe(2);
  });

  it('does not bridge gaps longer than maxGap', () => {
    const m = mapWithFrac(['5~5', '5p5', '5p5', '5p5', '~~~']);
    expect(bridgeWaterGaps(m.elev, m.frac, m.nx, m.ny, { maxGap: 2 })).toBe(0);
    expect(bridgeWaterGaps(m.elev, m.frac, m.nx, m.ny, { maxGap: 3 })).toBe(3);
  });
});

describe('distanceTransform', () => {
  it('matches brute-force Euclidean distance', () => {
    const nx = 23;
    const ny = 17;
    const feat = new Uint8Array(nx * ny);
    const pts = [
      [3, 4],
      [20, 2],
      [11, 15],
      [0, 16],
    ];
    for (const [i, j] of pts) feat[j * nx + i] = 1;
    const d = distanceTransform(feat, nx, ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const bf = Math.min(...pts.map(([a, b]) => Math.hypot(a - i, b - j)));
        expect(d[j * nx + i]).toBeCloseTo(bf, 4);
      }
    }
  });
  it('returns Infinity when there is no feature', () => {
    const d = distanceTransform(new Uint8Array(6), 3, 2);
    expect(d.every((v) => v === Infinity)).toBe(true);
  });
});

describe('offshore profile (estimated bathymetry)', () => {
  it('is >= minimum depth and strictly increasing offshore', () => {
    expect(offshoreDepth(0)).toBeCloseTo(SHONAN_PROFILE.minDepth, 6);
    expect(offshoreDepth(-10)).toBeCloseTo(SHONAN_PROFILE.minDepth, 6);
    let prev = offshoreDepth(0);
    for (let x = 10; x <= 5000; x += 10) {
      const h = offshoreDepth(x);
      expect(h).toBeGreaterThan(prev);
      prev = h;
    }
  });
  it('is continuous at the closure depth and has plausible values', () => {
    const xc = Math.pow((SHONAN_PROFILE.closureDepth - SHONAN_PROFILE.minDepth) / SHONAN_PROFILE.deanA, 1.5);
    expect(offshoreDepth(xc - 1e-6)).toBeCloseTo(offshoreDepth(xc + 1e-6), 4);
    expect(offshoreDepth(xc)).toBeCloseTo(SHONAN_PROFILE.closureDepth, 4);
    expect(offshoreDepth(250)).toBeGreaterThan(3.5);
    expect(offshoreDepth(250)).toBeLessThan(7);
    expect(offshoreDepth(1000)).toBeGreaterThan(8);
    expect(offshoreDepth(1000)).toBeLessThan(18);
    expect(offshoreDepth(2000)).toBeGreaterThan(15);
    expect(offshoreDepth(2000)).toBeLessThan(40);
  });
  it('applyBathymetry makes depth increase away from the coast', () => {
    // 北半分が陸、南半分が海の単純な格子
    const nx = 20;
    const ny = 60;
    const elev = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) elev[j * nx + i] = j < 10 ? 5 : NaN_;
    const cls = classifyWater(elev, nx, ny);
    const res = applyBathymetry(cls.z, cls.kind, nx, ny, 15.6);
    let prev = 0;
    for (let j = 10; j < ny; j++) {
      const h = -cls.z[j * nx + 10];
      expect(h).toBeGreaterThanOrEqual(SHONAN_PROFILE.minDepth - 1e-6);
      expect(h).toBeGreaterThan(prev);
      prev = h;
    }
    expect(-cls.z[10 * nx + 10]).toBeCloseTo(offshoreDepth(0.5 * 15.6), 4);
    expect(res.maxDepth).toBeCloseTo(-cls.z[(ny - 1) * nx + 10], 4);
    // 陸は変わらない
    expect(cls.z[5 * nx + 5]).toBe(5);
  });
});

describe('buildTerrainGrid', () => {
  it('produces a complete grid with manning, notes and no NaN', () => {
    const spec = { ...createGridSpec('coarse'), nx: 12, ny: 10 };
    const elev = new Float32Array(spec.nx * spec.ny);
    for (let j = 0; j < spec.ny; j++) for (let i = 0; i < spec.nx; i++) elev[j * spec.nx + i] = j < 5 ? 3 + (5 - j) : NaN_;
    elev[1 * spec.nx + 6] = NaN_; // 池
    const { grid, stats } = buildTerrainGrid(spec, elev, { source: 'gsi', sourceLabel: 'test', isApproximate: false, notes: ['a'] });
    expect(grid.z.every((v) => Number.isFinite(v))).toBe(true);
    expect(stats.seaCells).toBe(60);
    expect(stats.inlandCells).toBe(1);
    expect(grid.manning[0]).toBeCloseTo(MANNING.land, 6);
    expect(grid.manning[9 * spec.nx]).toBeCloseTo(MANNING.water, 6);
    expect(grid.manning[1 * spec.nx + 6]).toBeCloseTo(MANNING.water, 6);
    expect(grid.notes[0]).toBe('a');
    expect(grid.notes.some((s) => s.includes('推定'))).toBe(true);
    expect(grid.kind[9 * spec.nx]).toBe(CELL_SEA);
    expect(grid.z[9 * spec.nx]).toBeLessThan(0);
  });
});

describe('tile ranges and mosaic', () => {
  const dom = pixelDomain();
  const { z15, z14 } = demTileRanges();

  it('covers the domain with 6x8 z15 and 3x4 z14 tiles', () => {
    expect(z15.x1 - z15.x0 + 1).toBe(6);
    expect(z15.y1 - z15.y0 + 1).toBe(8);
    expect(z14.x1 - z14.x0 + 1).toBe(3);
    expect(z14.y1 - z14.y0 + 1).toBe(4);
    expect(listRequiredDemTiles().length).toBe(48 * 3 + 12);
    expect(dom.width).toBe(createGridSpec('standard').nx * 4);
  });

  it('applies the layer priority rules per pixel', () => {
    const tile = (v: number) => new Float32Array(TILE_SIZE * TILE_SIZE).fill(v);
    const a = tile(10); // DEM5A
    a[0] = NaN_; // 水面
    a[1] = NaN_;
    const b = tile(NaN_); // DEM5B
    b[1] = 20; // 5A が NA の画素を 5B が補う
    const slots = new Map<string, TileSlot>();
    const tx = z15.x0 + 2;
    const ty = z15.y0 + 3;
    slots.set(`dem5a_png/15/${tx}/${ty}`, a);
    slots.set(`dem5b_png/15/${tx}/${ty}`, b);
    slots.set(`dem5c_png/15/${tx}/${ty}`, 'missing');
    // 隣のタイルは 5m 系が無く DEM10B のみ
    slots.set(`dem5a_png/15/${tx + 1}/${ty}`, 'missing');
    slots.set(`dem5b_png/15/${tx + 1}/${ty}`, 'missing');
    slots.set(`dem5c_png/15/${tx + 1}/${ty}`, 'missing');
    // さらに隣は取得失敗
    slots.set(`dem5a_png/15/${tx + 2}/${ty}`, 'error');
    slots.set(`dem5b_png/15/${tx + 2}/${ty}`, 'missing');
    slots.set(`dem5c_png/15/${tx + 2}/${ty}`, 'missing');
    // DEM10B（z14）: 5m 系のあるタイルでも値を持つが、そこでは使われないこと
    for (let x = z14.x0; x <= z14.x1; x++) for (let y = z14.y0; y <= z14.y1; y++) slots.set(`dem_png/14/${x}/${y}`, tile(7));
    slots.set(`dem_png/14/${(tx + 2) >> 1}/${ty >> 1}`, 'error');
    // 残りのタイルは全レイヤー 404（海）
    const m = buildMosaic(dom, z15, (l, z, x, y) => slots.get(`${l}/${z}/${x}/${y}`) ?? (l === 'dem_png' ? tile(NaN_) : 'missing'));
    const at = (gx: number, gy: number) => m.heights[(gy - dom.originPy) * dom.width + (gx - dom.originPx)];
    const gx = tx * TILE_SIZE;
    const gy = ty * TILE_SIZE;
    expect(Number.isNaN(at(gx, gy))).toBe(true); // 5A NA・5B NA → 水面（DEM10B の 7 は使わない）
    expect(at(gx + 1, gy)).toBe(20); // 5B で補完
    expect(at(gx + 2, gy)).toBe(10); // 5A
    expect(at(gx + TILE_SIZE + 5, gy + 5)).toBe(7); // 5m 系が無い → DEM10B
    expect(Number.isNaN(at(gx + 2 * TILE_SIZE + 5, gy + 5))).toBe(true); // 失敗 → 不明
    expect(m.unknown).toBeGreaterThan(0);
    expect(m.used.dem5b_png).toBe(1);
    expect(m.used.dem_png).toBeGreaterThan(0);
  });
});

describe('performance (after download)', { timeout: 60000 }, () => {
  it('mosaic + aggregation + classification + bathymetry is fast for standard and fine', () => {
    const dom = pixelDomain();
    const { z15 } = demTileRanges();
    // 北半分が陸（なだらかな斜面）、南が海、所々に水面のある 5A タイルを用意
    const tiles = new Map<string, Float32Array>();
    for (let ty = z15.y0; ty <= z15.y1; ty++) {
      for (let tx = z15.x0; tx <= z15.x1; tx++) {
        const t = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let p = 0; p < t.length; p++) {
          const gy = ty * TILE_SIZE + (p >> 8);
          const gx = tx * TILE_SIZE + (p & 255);
          t[p] = gy - dom.originPy > dom.height * 0.55 || (gx % 97 < 6 && gy % 13 < 9) ? NaN_ : 3 + (dom.height - (gy - dom.originPy)) * 0.01;
        }
        tiles.set(`${tx}/${ty}`, t);
      }
    }
    const t0 = performance.now();
    const m = buildMosaic(dom, z15, (l, _z, x, y) => (l === 'dem5a_png' ? tiles.get(`${x}/${y}`) : 'missing'));
    const t1 = performance.now();
    // 目標は standard < 約2 s、fine < 約5 s（単独実行で約 0.3 s / 0.8 s）。
    // 並列実行で CPU が混み合っても誤って失敗しないよう、桁違いの劣化だけを検出する余裕をとる。
    for (const [res, limit] of [
      ['standard', 6000],
      ['fine', 15000],
    ] as const) {
      const spec = createGridSpec(res);
      const a = performance.now();
      const raw = aggregateToCells(m.heights, dom.width, dom.height, spec.cellPx, spec.nx, spec.ny);
      const { grid } = buildTerrainGrid(spec, raw.elev, { source: 'gsi', sourceLabel: 't', isApproximate: false, notes: [] });
      const elapsed = performance.now() - a + (t1 - t0);
      expect(grid.kind.length).toBe(spec.nx * spec.ny);
      expect(elapsed).toBeLessThan(limit);
    }
  });
});
