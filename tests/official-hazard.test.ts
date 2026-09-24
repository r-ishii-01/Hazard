/**
 * 公式の津波浸水想定（神奈川県。ハザードマップポータルサイトの 04_tsunami_newlegend_data）の読み込み・判定と、
 * 人物の「最寄りの高台」から公式の浸水想定区域を除く処理。
 *
 * - 画素の色 → 階級、タイル → 画素・セルの階級（最も深い階級。不明の扱い）
 * - 読み込みの順序（ミラー → 配信元）、404 は「浸水想定なし」、取得できないタイルは「不明」、1枚も読めなければエラー
 * - 同梱のミラー（public/tiles/hazard-tsunami）の実データ: 鵠沼海岸駅は公式の想定で浸水する区域
 * - 最寄りの高台: 計算では浸水しない場所でも、公式の浸水想定区域（と周囲 30 m）には導かない。
 *   公式の想定を読み込めていなければ、その旨を避難先の名前に示す
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TILE_SIZE, cellCenter, createGridSpec, lonLatToCell, lonLatToGridXY, lonLatToPixel, type GridSpec } from '../src/core/geo';
import {
  CELL_LAND,
  CELL_SEA,
  type OfficialInundationData,
  type OfficialInundationState,
  type Person,
  type QuakeScenario,
  type SimOutput,
  type SimParams,
  type TerrainGrid,
} from '../src/core/types';
import { DEPTH_CLASSES } from '../src/data/sources';
import {
  OFFICIAL_NONE,
  OFFICIAL_UNKNOWN,
  decodeOfficialTile,
  emptyOfficialData,
  officialCellCodes,
  officialClassOf,
  officialCodeAt,
  officialCodeFromRgba,
  officialHazardTiles,
  officialMirrorPath,
  officialPointInfo,
  officialRemoteUrl,
  officialTileKey,
  putOfficialTile,
} from '../src/data/officialHazard';
import { OfficialHazardLoadError, checkOfficialHazardDisplay, loadOfficialInundation, officialLoadMessage } from '../src/data/officialHazardLoad';
import { planEvacuation } from '../src/people';
import { OFFICIAL_ZONE_BUFFER_M, excludeOfficialZone, getGridContext, officialZoneNear } from '../src/people/gridctx';
import { clearTerrainCache, loadTerrain } from '../src/terrain';
import { PUBLIC_ROOT, decodeBlob, fs, mirrorFetch } from './helpers/png';

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** 1色で塗ったタイル（RGBA） */
function solidTile(rgba: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) out.set(rgba, i * 4);
  return out;
}

/** 偽の PNG（中身は decodeImpl が見る目印の色）。fetch の応答として返す */
const tileResponse = (color: string, status = 200) =>
  new Response(new Blob([color]), { status, headers: { 'content-type': status === 200 ? 'image/png' : 'text/plain' } });
const decodeMarker = async (blob: Blob): Promise<Uint8Array> => {
  const text = await blob.text();
  if (text === 'broken') return new Uint8Array(10);
  if (text === 'transparent') return solidTile([0, 0, 0, 0]);
  return solidTile([...hex(text), 255]);
};

// ---------------------------------------------------------------------------

describe('公式の津波浸水想定: 色 → 階級', () => {
  it('凡例の8色だけを階級にし、透明は区域外、それ以外の色は不明（推測で当てはめない）', () => {
    DEPTH_CLASSES.forEach((cls, i) => {
      const [r, g, b] = hex(cls.color);
      expect(officialCodeFromRgba(r, g, b, 255)).toBe(i + 1);
      expect(officialClassOf(i + 1)).toBe(cls);
    });
    expect(officialCodeFromRgba(255, 216, 192, 0)).toBe(OFFICIAL_NONE);
    expect(officialCodeFromRgba(80, 160, 230, 120)).toBe(OFFICIAL_UNKNOWN);
    expect(officialCodeFromRgba(255, 216, 191, 255)).toBe(OFFICIAL_UNKNOWN);
    expect(officialClassOf(OFFICIAL_NONE)).toBeNull();
    expect(officialClassOf(OFFICIAL_UNKNOWN)).toBeNull();
  });

  it('タイル全体をデコードする（大きさが違えばエラー）', () => {
    const codes = decodeOfficialTile(solidTile([...hex(DEPTH_CLASSES[3].color), 255]));
    expect(codes.length).toBe(TILE_SIZE * TILE_SIZE);
    expect(codes.every((c) => c === 4)).toBe(true);
    expect(() => decodeOfficialTile(new Uint8Array(16))).toThrow();
  });
});

describe('公式の津波浸水想定: 画素・セルの階級', () => {
  it('計算範囲を覆う z15 のタイルと、ミラー・配信元のパス', () => {
    const tiles = officialHazardTiles();
    expect(tiles.length).toBe(48);
    expect(tiles[0]).toEqual({ z: 15, x: 29076, y: 12940 });
    expect(officialTileKey(tiles[0])).toBe('hazard-tsunami/15/29076/12940');
    expect(officialMirrorPath(tiles[0])).toBe('tiles/hazard-tsunami/15/29076/12940.png');
    expect(officialRemoteUrl(tiles[0])).toBe('https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/15/29076/12940.png');
  });

  it('セルの階級は、セルの中で最も深い階級。1画素でも区域なら区域。不明な画素だけが残れば不明', () => {
    const spec = createGridSpec('coarse');
    const data = emptyOfficialData(createGridSpec('fine'));
    expect(data.codes.every((c) => c === OFFICIAL_UNKNOWN)).toBe(true);
    for (const t of officialHazardTiles()) putOfficialTile(data, t, null);
    expect(data.codes.every((c) => c === OFFICIAL_NONE)).toBe(true);
    // セル (10, 20) の 8×8 画素のうち 1 画素を 1〜3m、1 画素を 0.3m未満に
    const px0 = spec.originPx + 10 * spec.cellPx - data.originPx;
    const py0 = spec.originPy + 20 * spec.cellPx - data.originPy;
    data.codes[(py0 + 3) * data.width + px0 + 5] = 4;
    data.codes[(py0 + 1) * data.width + px0 + 1] = 1;
    // セル (11, 20) は 1 画素だけ不明
    data.codes[py0 * data.width + px0 + spec.cellPx] = OFFICIAL_UNKNOWN;
    // セル (12, 20) は不明と区域が混在 → 区域の階級
    data.codes[py0 * data.width + px0 + 2 * spec.cellPx] = OFFICIAL_UNKNOWN;
    data.codes[(py0 + 7) * data.width + px0 + 2 * spec.cellPx + 7] = 2;
    const cells = officialCellCodes(data, spec);
    expect(cells.length).toBe(spec.nx * spec.ny);
    expect(cells[20 * spec.nx + 10]).toBe(4);
    expect(cells[20 * spec.nx + 11]).toBe(OFFICIAL_UNKNOWN);
    expect(cells[20 * spec.nx + 12]).toBe(2);
    expect(cells[20 * spec.nx + 13]).toBe(OFFICIAL_NONE);
    // キャッシュ（同じデータ・同じ格子なら同じ配列）
    expect(officialCellCodes(data, spec)).toBe(cells);
    // 地点の階級（画素）と説明
    const c = cellCenter(spec, 10, 20);
    const at = lonLatToPixel(c.lon, c.lat, 15);
    data.codes[Math.floor(at.y - data.originPy) * data.width + Math.floor(at.x - data.originPx)] = 3;
    expect(officialCodeAt(data, c.lon, c.lat)).toBe(3);
    const state = { status: 'ready', data };
    expect(officialPointInfo(state, c.lon, c.lat)).toMatchObject({ kind: 'zone', cls: DEPTH_CLASSES[2] });
    expect(officialPointInfo(state, c.lon, c.lat).text).toBe('公式の津波浸水想定（神奈川県）では浸水深0.5〜1mの区域');
    const out = cellCenter(spec, 40, 40);
    expect(officialPointInfo(state, out.lon, out.lat)).toMatchObject({ kind: 'outside', text: '公式の津波浸水想定（神奈川県）では浸水想定区域の外' });
    expect(officialPointInfo(state, 150, 40).kind).toBe('out-of-range');
    expect(officialPointInfo({ status: 'loading', data: null }, c.lon, c.lat).kind).toBe('loading');
    expect(officialPointInfo({ status: 'error', data: null }, c.lon, c.lat)).toMatchObject({ kind: 'error' });
  });
});

describe('公式の津波浸水想定: 読み込み（ミラー → 配信元）', () => {
  const tiles = officialHazardTiles();
  const deep = DEPTH_CLASSES[3].color; // 1〜3m
  const shallow = DEPTH_CLASSES[0].color;

  it('manifest の 1 はミラー、0 は浸水想定なし、記録の無いタイルは配信元（404 は浸水想定なし）', async () => {
    const manifest: Record<string, 0 | 1> = {};
    manifest[officialTileKey(tiles[0])] = 1;
    manifest[officialTileKey(tiles[1])] = 0;
    manifest[officialTileKey(tiles[2])] = 1; // ミラーが壊れている → 配信元
    const requested: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      requested.push(url);
      if (url === '/tiles/manifest.json') return new Response(JSON.stringify({ version: 1, tiles: manifest }), { status: 200 });
      if (url === `/${officialMirrorPath(tiles[0])}`) return tileResponse(deep);
      if (url === `/${officialMirrorPath(tiles[2])}`) return tileResponse('broken');
      if (url === officialRemoteUrl(tiles[2])) return tileResponse(shallow);
      if (url === officialRemoteUrl(tiles[3])) return tileResponse('transparent');
      if (url.startsWith('https://disaportaldata.gsi.go.jp/')) return new Response('', { status: 404 });
      return new Response('', { status: 404 });
    };
    const data = await loadOfficialInundation({ fetchImpl, decodeImpl: decodeMarker, baseUrl: '/' });
    expect(data).toMatchObject({ tiles: 48, fromMirror: 1, fromRemote: 2, missing: 45, failed: 0 });
    expect(requested).not.toContain(officialRemoteUrl(tiles[0]));
    expect(requested).not.toContain(officialRemoteUrl(tiles[1]));
    expect(requested).not.toContain(`/${officialMirrorPath(tiles[3])}`);
    const pixelOf = (t: (typeof tiles)[number], dx = 128, dy = 128) => {
      const px = t.x * TILE_SIZE + dx - data.originPx;
      const py = t.y * TILE_SIZE + dy - data.originPy;
      return data.codes[py * data.width + px];
    };
    // tiles[0..3] は北端の行（範囲内の画素だけ書き込まれる）
    expect(pixelOf(tiles[0], 200, 250)).toBe(4);
    expect(pixelOf(tiles[1], 128, 250)).toBe(OFFICIAL_NONE);
    expect(pixelOf(tiles[2], 128, 250)).toBe(1);
    expect(pixelOf(tiles[3], 128, 250)).toBe(OFFICIAL_NONE);
    expect(officialLoadMessage(data)).toBeUndefined();
  });

  it('取得できなかったタイルの範囲は「不明」のまま（浸水しないとは扱わない）', async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === '/tiles/manifest.json') return new Response('', { status: 404 });
      if (url === officialRemoteUrl(tiles[20])) return new Response('', { status: 503 });
      if (url === officialRemoteUrl(tiles[21])) throw new TypeError('Failed to fetch');
      return new Response('', { status: 404 });
    };
    const data = await loadOfficialInundation({ fetchImpl, decodeImpl: decodeMarker, baseUrl: '/' });
    expect(data.failed).toBe(2);
    expect(data.missing).toBe(46);
    const t = tiles[20];
    const px = t.x * TILE_SIZE + 128 - data.originPx;
    const py = t.y * TILE_SIZE + 128 - data.originPy;
    expect(data.codes[py * data.width + px]).toBe(OFFICIAL_UNKNOWN);
    expect(officialLoadMessage(data)).toContain('48枚中2枚');
  });

  it('1枚も読めなければエラー（接続できないと分かったら残りは要求しない）', async () => {
    let remote = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.startsWith('https://')) {
        remote++;
        throw new TypeError('Failed to fetch');
      }
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    await expect(loadOfficialInundation({ fetchImpl, decodeImpl: decodeMarker, baseUrl: '/' })).rejects.toBeInstanceOf(OfficialHazardLoadError);
    expect(remote).toBeLessThan(20);
  });

  it('応答しない配信元はタイムアウトで打ち切る', async () => {
    const fetchImpl = (url: string): Promise<Response> =>
      url.endsWith('manifest.json') ? Promise.resolve(new Response('', { status: 404 })) : new Promise<Response>(() => undefined);
    await expect(loadOfficialInundation({ fetchImpl, decodeImpl: decodeMarker, baseUrl: '/', timeoutMs: 30 })).rejects.toBeInstanceOf(OfficialHazardLoadError);
  });

  it('地図に重ねるタイルの配信元に接続できるか（200・404 は接続できた、例外・5xx・タイムアウトは接続できない）', async () => {
    const urls: string[] = [];
    const ok = await checkOfficialHazardDisplay({
      fetchImpl: async (url) => {
        urls.push(url);
        return new Response('', { status: 404 });
      },
    });
    expect(ok).toBe(true);
    // 2D 地図が最初に読む z13 のタイル（計算範囲の中央）
    expect(urls[0]).toMatch(/^https:\/\/disaportaldata\.gsi\.go\.jp\/raster\/04_tsunami_newlegend_data\/13\/\d+\/\d+\.png$/);
    expect(await checkOfficialHazardDisplay({ fetchImpl: async () => new Response('', { status: 200 }) })).toBe(true);
    expect(await checkOfficialHazardDisplay({ fetchImpl: async () => new Response('', { status: 502 }) })).toBe(false);
    expect(
      await checkOfficialHazardDisplay({
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).toBe(false);
    expect(await checkOfficialHazardDisplay({ fetchImpl: () => new Promise<Response>(() => undefined), timeoutMs: 20 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 最寄りの高台から公式の浸水想定区域を除く（小さな格子）
// ---------------------------------------------------------------------------

const SCENARIO: QuakeScenario = {
  id: 'test',
  name: 'テスト',
  shortName: 'テスト',
  magnitude: 8,
  shindo: '7',
  coastHeight: 5,
  arrivalMin: 10,
  periodMin: 15,
  firstMotion: 'rise',
  waves: 3,
  shakingSec: 60,
  warning: 'major',
  description: '',
  isOfficial: false,
};
const PARAMS: SimParams = { scenario: SCENARIO, tideTP: 0.85, durationMin: 60, resolution: 'standard', landManning: 0.06 };

function makeGrid(spec: GridSpec, fn: (i: number, j: number) => { z: number; kind?: number }): TerrainGrid {
  const n = spec.nx * spec.ny;
  const z = new Float32Array(n);
  const kind = new Uint8Array(n);
  for (let j = 0; j < spec.ny; j++) {
    for (let i = 0; i < spec.nx; i++) {
      const c = fn(i, j);
      z[j * spec.nx + i] = c.z;
      kind[j * spec.nx + i] = c.kind ?? CELL_LAND;
    }
  }
  return { spec, z, kind, manning: new Float32Array(n).fill(0.025), source: 'synthetic', sourceLabel: 'test', isApproximate: true, notes: [] };
}

/** 陸がどこも浸水しなかった（計算が最後まで終わった）結果 */
function dryOutput(spec: GridSpec, durationSec = 3600): SimOutput {
  const n = spec.nx * spec.ny;
  return {
    spec,
    frameInterval: 10,
    durationSec,
    framesReady: () => durationSec / 10 + 1,
    timeReady: () => durationSec,
    depthAt: () => 0,
    etaAt: () => NaN,
    fillDepth: () => {},
    maxDepth: new Float32Array(n),
    maxEta: new Float32Array(n),
    arrival: new Float32Array(n).fill(Infinity),
    gauge: { t: new Float32Array(0), eta: new Float32Array(0), lon: 0, lat: 0, count: () => 0 },
    achievedCoastMax: () => 0,
    calibration: { targetCoastHeight: 0, boundaryAmplitude: 0 },
  };
}

/** 格子のセル (i, j) の範囲の画素に階級を書き込んだ公式のデータ（ほかは区域外） */
function officialWithZone(spec: GridSpec, zone: (i: number, j: number) => number): OfficialInundationState {
  const data = emptyOfficialData(createGridSpec('fine'));
  data.codes.fill(OFFICIAL_NONE);
  for (let j = 0; j < spec.ny; j++) {
    for (let i = 0; i < spec.nx; i++) {
      const code = zone(i, j);
      if (!code) continue;
      for (let dy = 0; dy < spec.cellPx; dy++) {
        for (let dx = 0; dx < spec.cellPx; dx++) {
          const px = spec.originPx + i * spec.cellPx + dx - data.originPx;
          const py = spec.originPy + j * spec.cellPx + dy - data.originPy;
          data.codes[py * data.width + px] = code;
        }
      }
    }
  }
  return { status: 'ready', data, display: 'ok' };
}

let seq = 0;
function personAt(spec: GridSpec, i: number, j: number, patch: Partial<Person> = {}): Person {
  const c = cellCenter(spec, i, j);
  seq++;
  return { id: `o${seq}`, name: `人${seq}`, kind: 'adult', lon: c.lon, lat: c.lat, evacMode: 'highground', startDelayMin: 5, ...patch };
}

function cellOf(spec: GridSpec, lon: number, lat: number): { i: number; j: number } {
  const g = lonLatToGridXY(spec, lon, lat);
  return { i: Math.floor(g.gx), j: Math.floor(g.gy) };
}

describe('最寄りの高台から公式の浸水想定区域（と周囲）を除く', () => {
  // 南（j が大きい）が海。陸は北へ向かって少しずつ高い。計算ではどこも浸水しなかった
  const spec = { ...createGridSpec('standard'), nx: 30, ny: 60 };
  const grid = makeGrid(spec, (_i, j) => (j >= 55 ? { z: -3, kind: CELL_SEA } : { z: 2 + 0.1 * (55 - j) }));
  const out = dryOutput(spec);
  // 公式の想定では j >= 30 の陸が浸水（1〜3m）
  const official = officialWithZone(spec, (_i, j) => (j >= 30 && j < 55 ? 4 : 0));

  it('区域と周囲 OFFICIAL_ZONE_BUFFER_M のセルを除き、元のマスクは変えない（結果はキャッシュ）', () => {
    const ctx = getGridContext(grid);
    const codes = officialCellCodes(official.data!, spec);
    const near = officialZoneNear(ctx, codes);
    const r = Math.ceil(OFFICIAL_ZONE_BUFFER_M / ctx.dx);
    expect(r).toBe(2);
    // 区域は j = 30〜54（海 j >= 55 は公式の想定でも色なし）。その 2 セル外側まで
    for (let j = 0; j < spec.ny; j++) expect(near[j * spec.nx + 5], `j=${j}`).toBe(j >= 30 - r && j <= 54 + r ? 1 : 0);
    const all = new Uint8Array(ctx.n).fill(1);
    const ex = excludeOfficialZone(ctx, all, codes);
    expect(ex).not.toBe(all);
    expect(all.every((v) => v === 1)).toBe(true);
    expect(ex[27 * spec.nx + 5]).toBe(1);
    expect(ex[28 * spec.nx + 5]).toBe(0);
    expect(excludeOfficialZone(ctx, all, codes)).toBe(ex);
    // 不明なセルも除く（確かめられない場所を安全な場所として示さない）
    const unknown = new Uint8Array(ctx.n);
    unknown[10 * spec.nx + 10] = OFFICIAL_UNKNOWN;
    expect(excludeOfficialZone(ctx, all, unknown)[10 * spec.nx + 10]).toBe(0);
  });

  it('計算では浸水しない場所でも、公式の浸水想定区域にいる人は区域の外（と周囲 30 m の外）の高台へ向かう', () => {
    const person = personAt(spec, 15, 45);
    // 公式の想定を使わない（読み込めていない）と、計算だけで「高台」: 現在地のまま（公式では 1〜3m の区域）
    const without = planEvacuation(person, grid, [], out, PARAMS, { status: 'error', data: null, display: 'unknown' });
    expect(without.target?.name).toContain('現在地');
    expect(without.target?.name).toContain('公式の浸水想定区域の外かは未確認');
    // 公式の想定を使うと、区域の外の最寄りへ
    const plan = planEvacuation(person, grid, [], out, PARAMS, official);
    const end = cellOf(spec, plan.target!.lon, plan.target!.lat);
    expect(end.j).toBe(27);
    expect(plan.target?.name).toContain('最寄りの高台（公式の浸水想定区域の外・計算でも浸水なし・標高');
    expect(plan.target?.name).not.toContain('未確認');
    expect(officialCodeAt(official.data!, plan.target!.lon, plan.target!.lat)).toBe(OFFICIAL_NONE);
    expect(plan.arriveAt).toBeGreaterThan(300);
  });

  it('公式の想定の読み込み中・読み込めなかったときは、避難先の名前にその旨を示す', () => {
    const person = personAt(spec, 15, 45, { lon: cellCenter(spec, 15, 45).lon + 1e-7 });
    const loading = planEvacuation(person, grid, [], null, PARAMS, { status: 'loading', data: null, display: 'unknown' });
    expect(loading.target?.name).toContain('公式の津波浸水想定を読み込み中のため、公式の浸水想定区域の外かは未確認');
    const failed = planEvacuation(person, grid, [], null, PARAMS, { status: 'error', data: null, display: 'unknown' });
    expect(failed.target?.name).toContain('公式の津波浸水想定を読み込めなかったため、公式の浸水想定区域の外かは未確認');
    // 省略（照合していない）も同じ
    expect(planEvacuation(person, grid, [], null, PARAMS).target?.name).toContain('未確認');
    // 計算結果がないとき（標高の条件）も区域を除く
    const ready = planEvacuation(person, grid, [], null, { ...PARAMS, scenario: { ...SCENARIO, coastHeight: 1 } }, official);
    expect(cellOf(spec, ready.target!.lon, ready.target!.lat).j).toBeLessThanOrEqual(27);
    expect(ready.target?.name).toContain('公式の浸水想定区域の外・標高');
  });

  it('避難場所（指定緊急避難場所）は区域の中でも目的地にする（建物の上階などへの避難を想定）', () => {
    const c = cellCenter(spec, 15, 40);
    const person = personAt(spec, 15, 50, { evacMode: 'shelter' });
    const plan = planEvacuation(person, grid, [{ id: 's', name: '避難場所A', lon: c.lon, lat: c.lat, kind: 'evac-site', source: 'test' }], out, PARAMS, official);
    expect(plan.target?.name).toBe('避難場所A');
    expect(officialCodeAt(official.data!, plan.target!.lon, plan.target!.lat)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 同梱のミラーの実データ
// ---------------------------------------------------------------------------

/** 鵠沼海岸駅（ACC-1 の再現地点。E2E と同じ）と、以前の計算だけの「高台」の地点 */
const KUGENUMA_KAIGAN_STA = { lon: 139.47127, lat: 35.32071 };
const OLD_HIGHGROUND_TARGET = { lon: 139.47135, lat: 35.32318 };
const hasMirror = fs.existsSync(`${PUBLIC_ROOT}tiles/manifest.json`) && fs.existsSync(`${PUBLIC_ROOT}tiles/hazard-tsunami`);

describe.skipIf(!hasMirror)('同梱のミラー（public/tiles/hazard-tsunami）の実データ', { timeout: 120000 }, () => {
  let data: OfficialInundationData;
  let grid: TerrainGrid;
  beforeAll(async () => {
    data = await loadOfficialInundation({ fetchImpl: mirrorFetch, decodeImpl: decodeBlob, baseUrl: '/' });
    clearTerrainCache();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    grid = await loadTerrain('coarse', { fetchImpl: mirrorFetch, decodeImpl: decodeBlob, baseUrl: '/' });
    clearTerrainCache();
  });

  it('48 枚すべてをミラーから読める（ネットワークに接続しない）。色はすべて凡例の階級', () => {
    expect(data).toMatchObject({ tiles: 48, fromRemote: 0, failed: 0 });
    expect(data.fromMirror + data.missing).toBe(48);
    expect(data.fromMirror).toBe(17);
    let unknown = 0;
    let wet = 0;
    for (const c of data.codes) {
      if (c === OFFICIAL_UNKNOWN) unknown++;
      else if (c > 0) wet++;
    }
    expect(unknown).toBe(0);
    // 公式の浸水想定区域（計算範囲内）はおよそ 5 km²（z15 の1画素 ≒ 3.9 m × 3.9 m）
    const area = wet * 3.9 * 3.9;
    expect(area).toBeGreaterThan(4.5e6);
    expect(area).toBeLessThan(6e6);
  });

  it('鵠沼海岸駅は公式の想定で浸水深1〜3mの区域、以前の計算だけの「高台」も浸水想定区域', () => {
    const state = { status: 'ready', data };
    expect(officialPointInfo(state, KUGENUMA_KAIGAN_STA.lon, KUGENUMA_KAIGAN_STA.lat).text).toBe('公式の津波浸水想定（神奈川県）では浸水深1〜3mの区域');
    // z17 のタイルでは 0.5〜1m、z15（1画素 ≒ 3.9 m）では 0.3〜0.5m の画素（どちらも浸水想定区域）
    expect(officialPointInfo(state, OLD_HIGHGROUND_TARGET.lon, OLD_HIGHGROUND_TARGET.lat).kind).toBe('zone');
    // 海（江の島の南の沖）は色が無い
    expect(officialPointInfo(state, 139.475, 35.292).kind).toBe('outside');
  });

  it('計算でどこも浸水しなかったとしても、鵠沼海岸駅の人の「最寄りの高台」は公式の浸水想定区域から 30 m 以上離れた場所', () => {
    const out = dryOutput(grid.spec);
    const person: Person = { id: 'sta', name: '駅', kind: 'adult', ...KUGENUMA_KAIGAN_STA, evacMode: 'highground', startDelayMin: 5 };
    const official: OfficialInundationState = { status: 'ready', data, display: 'ok' };
    const plan = planEvacuation(person, grid, [], out, { ...PARAMS, scenario: { ...SCENARIO, coastHeight: 8.8 } }, official);
    expect(plan.target?.kind).toBe('highground');
    expect(plan.target?.name).toContain('公式の浸水想定区域の外');
    const cell = lonLatToCell(grid.spec, plan.target!.lon, plan.target!.lat)!;
    const codes = officialCellCodes(data, grid.spec);
    const r = Math.ceil(OFFICIAL_ZONE_BUFFER_M / grid.spec.dx);
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) expect(codes[(cell.j + dj) * grid.spec.nx + cell.i + di]).toBe(OFFICIAL_NONE);
    }
    expect(officialCodeAt(data, plan.target!.lon, plan.target!.lat)).toBe(OFFICIAL_NONE);
    // 公式の想定を使わなければ、計算だけで駅のすぐ近く（公式では浸水する区域）を「高台」とする（以前の誤り）
    const without = planEvacuation(person, grid, [], out, { ...PARAMS, scenario: { ...SCENARIO, coastHeight: 8.8 } }, { status: 'error', data: null, display: 'unknown' });
    expect(officialCodeAt(data, without.target!.lon, without.target!.lat)).toBeGreaterThan(0);
    expect(without.target?.name).toContain('未確認');
  });
});
