import { describe, expect, it } from 'vitest';
import { createGridSpec, TILE_SIZE } from '../src/core/geo';
import { CELL_INLAND_WATER, CELL_LAND, CELL_SEA } from '../src/core/types';
import { aggregateToCells } from '../src/terrain/aggregate';
import { applyBathymetry, offshoreDepth, SHONAN_PROFILE } from '../src/terrain/bathymetry';
import { buildTerrainGrid, MANNING } from '../src/terrain/build';
import { classifyWater } from '../src/terrain/classify';
import { connectSeaWater, fillUnknownCells, seaConnectedPixels } from '../src/terrain/connect';
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
  it('separates sea (connected to the south edge, incl. rivers) from inland water; islands stay land', () => {
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

  it('water touching only the east/west edge inland is not sea (e.g. a failed tile strip at the corner)', () => {
    const { elev, nx, ny } = fromMap(['~~55', '~555', '5555', '~~~~']);
    const r = classifyWater(elev, nx, ny);
    expect(r.kind[0]).toBe(CELL_INLAND_WATER);
    expect(r.kind[nx]).toBe(CELL_INLAND_WATER);
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

/** 画素の地図: '~' = 水面(NaN)、'?' = 取得失敗で不明(NaN + unknown)、数字 = 標高 */
function pixelMap(rows: string[]) {
  const height = rows.length;
  const width = rows[0].length;
  const heights = new Float32Array(width * height);
  const unknown = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const ch = row[x];
      heights[y * width + x] = ch === '~' || ch === '?' ? NaN_ : Number(ch);
      if (ch === '?') unknown[y * width + x] = 1;
    }
  });
  return { heights, unknown, width, height };
}

describe('seaConnectedPixels', () => {
  it('marks NA pixels 4-connected to the south edge, not ponds, diagonal touches or unknown pixels', () => {
    const m = pixelMap([
      '5~555555', // 0: 川（海につながる）
      '5~55~555', // 1: 池（i=4）
      '5~55~555',
      '5~555~55', // 3: 斜めにしか接しない水面（i=5）→ 海ではない
      '5~55?555', // 4: 不明な画素は水面として扱わない
      '~~~~~~~~', // 5: 海（南端）
    ]);
    const sea = seaConnectedPixels(m.heights, m.width, m.height, m.unknown);
    const at = (x: number, y: number) => sea[y * m.width + x];
    expect(at(1, 0)).toBe(1);
    expect(at(0, 5)).toBe(1);
    expect(at(4, 1)).toBe(0);
    expect(at(5, 3)).toBe(0);
    expect(at(4, 4)).toBe(0);
    expect(at(0, 0)).toBe(0); // 陸
  });
});

describe('connectSeaWater (keeps thin rivers connected after averaging)', () => {
  it('reconnects a diagonal 2-px river that the 50% rule splits, but keeps a pond behind a thin dike separate', () => {
    // 16x16 画素 → 4x4 セル（cellPx = 4）。川は幅2画素で斜めに流れ、セルの段階では角でしか接しない
    const m = pixelMap([
      '~~55555555555555', // 0
      '~~55555555555555',
      '5~~5555555555~~5', // 2: 右上に池（i=13..14）
      '55~~555555555~~5',
      '555~~55555555555', // 4
      '5555~~5555555555',
      '55555~~555555555',
      '555555~~55555555',
      '5555555~~5555555', // 8
      '55555555~~555555',
      '555555555~~55555',
      '5555555555~~5555',
      '55555555555~~~~~', // 12
      '555555555555~~~~',
      '~~~~~~~~~~~~~~~~',
      '~~~~~~~~~~~~~~~~',
    ]);
    const sea = seaConnectedPixels(m.heights, m.width, m.height);
    const raw = aggregateToCells(m.heights, 16, 16, 4, 4, 4, { seaPx: sea });
    const before = classifyWater(Float32Array.from(raw.elev), 4, 4);
    expect(before.kind[0]).not.toBe(CELL_SEA); // 平均しただけでは上流が切れる
    const n = connectSeaWater(raw.elev, raw.seaFrac!, 4, 4);
    expect(n).toBeGreaterThan(0);
    const isolated = Uint8Array.from(raw.elev, (v, k) => (v !== v && raw.seaFrac![k] === 0 ? 1 : 0));
    const after = classifyWater(raw.elev, 4, 4, { isolated });
    // 上流端（左上のセル）から海まで4近傍でつながる
    expect(after.kind[0]).toBe(CELL_SEA);
    // 右上の池のセルは水面が半分未満で陸のまま（海につなげない）
    expect(after.kind[3]).toBe(CELL_LAND);
  });

  it('does not connect water that is not connected at pixel level (weir / embankment)', () => {
    const m = pixelMap([
      '55~~5555',
      '55~~5555',
      '55555555', // 堰（画素の段階でも途切れている）
      '55~~5555',
      '~~~~~~~~',
      '~~~~~~~~',
      '~~~~~~~~',
      '~~~~~~~~',
    ]);
    const sea = seaConnectedPixels(m.heights, m.width, m.height);
    const raw = aggregateToCells(m.heights, 8, 8, 2, 4, 4, { seaPx: sea });
    expect(connectSeaWater(raw.elev, raw.seaFrac!, 4, 4)).toBe(0);
    // セルの段階では堰の下流側のセルと隣り合うが、画素ではつながっていないので海にしない
    expect(classifyWater(Float32Array.from(raw.elev), 4, 4).kind[1]).toBe(CELL_SEA);
    const isolated = Uint8Array.from(raw.elev, (v, k) => (v !== v && raw.seaFrac![k] === 0 ? 1 : 0));
    const r = classifyWater(raw.elev, 4, 4, { isolated });
    expect(r.kind[1]).toBe(CELL_INLAND_WATER);
    expect(r.kind[1 * 4 + 1]).toBe(CELL_SEA);
  });

  it('keeps a pond that only touches a river cell (no sea-connected pixel) as inland water', () => {
    const elev = new Float32Array([5, NaN_, NaN_, 5, 5, NaN_, 5, 5, NaN_, NaN_, NaN_, NaN_]);
    const isolated = new Uint8Array(12);
    isolated[2] = 1; // 川（i=1）に隣接する池のセル
    const r = classifyWater(elev, 4, 3, { isolated });
    expect(r.kind[1]).toBe(CELL_SEA);
    expect(r.kind[2]).toBe(CELL_INLAND_WATER);
    expect(r.z[2]).toBe(5);
  });
});

describe('unknown pixels / cells (failed tiles)', () => {
  it('aggregates unknown pixels separately from water and reports seaFrac', () => {
    const m = pixelMap(['1?~~', '3???', '~~~~', '~~~~']);
    const sea = seaConnectedPixels(m.heights, 4, 4, m.unknown);
    const raw = aggregateToCells(m.heights, 4, 4, 2, 2, 2, { seaPx: sea, unknownPx: m.unknown });
    expect(raw.elev[0]).toBeCloseTo(2, 6); // 既知の 1, 3 の平均（不明は水面として数えない）
    expect(raw.waterFrac[0]).toBe(0);
    expect(raw.unknownFrac![0]).toBeCloseTo(0.5, 6);
    expect(Number.isNaN(raw.elev[1])).toBe(true); // 既知の2画素とも水面
    expect(raw.seaFrac![1]).toBe(0); // 不明な画素を挟むので海とはつながらない
    expect(raw.seaFrac![2]).toBe(1);
    expect(raw.unknownCells).toBe(0);
    const all = aggregateToCells(new Float32Array(4).fill(NaN_), 2, 2, 2, 1, 1, { unknownPx: new Uint8Array(4).fill(1) });
    expect(all.unknownCells).toBe(1);
  });

  it('fills unknown cells from their neighbours (land stays land, sea stays sea)', () => {
    const nx = 6;
    const ny = 5;
    const elev = new Float32Array(nx * ny);
    const unknown = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) elev[j * nx + i] = j < 3 ? 4 + j : NaN_;
    // 北西の角（陸）と南東（海）が取得失敗
    for (const [i, j] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [5, 4],
    ]) {
      unknown[j * nx + i] = 1;
      elev[j * nx + i] = NaN_;
    }
    expect(fillUnknownCells(elev, unknown, nx, ny)).toBe(4);
    expect(elev[0]).toBeGreaterThanOrEqual(4);
    expect(elev[0]).toBeLessThanOrEqual(6);
    expect(Number.isFinite(elev[1])).toBe(true);
    expect(Number.isFinite(elev[nx])).toBe(true);
    expect(Number.isNaN(elev[4 * nx + 5])).toBe(true);
    const r = classifyWater(elev, nx, ny);
    expect(r.kind[0]).toBe(CELL_LAND);
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
    expect(m.unknownMask).not.toBeNull();
    expect(m.unknownMask![(gy + 5 - dom.originPy) * dom.width + (gx + 2 * TILE_SIZE + 5 - dom.originPx)]).toBe(1);
    expect(m.unknownMask![(gy - dom.originPy) * dom.width + (gx - dom.originPx)]).toBe(0); // 水面は不明ではない
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
      const sea = seaConnectedPixels(m.heights, dom.width, dom.height, m.unknownMask);
      const raw = aggregateToCells(m.heights, dom.width, dom.height, spec.cellPx, spec.nx, spec.ny, { seaPx: sea });
      connectSeaWater(raw.elev, raw.seaFrac!, spec.nx, spec.ny);
      const { grid } = buildTerrainGrid(spec, raw.elev, { source: 'gsi', sourceLabel: 't', isApproximate: false, notes: [] });
      const elapsed = performance.now() - a + (t1 - t0);
      expect(grid.kind.length).toBe(spec.nx * spec.ny);
      expect(elapsed).toBeLessThan(limit);
    }
  });
});
