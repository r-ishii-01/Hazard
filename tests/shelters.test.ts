import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMAIN_BOUNDS, createGridSpec, lonLatToCell } from '../src/core/geo';
import { CELL_LAND, CELL_SEA, type SimParams, type TerrainGrid } from '../src/core/types';
import {
  BUILTIN_TSUNAMI_SHELTERS,
  SHELTER_SOURCE_LABEL,
  SHELTER_TILE_URLS,
  isTsunamiEvacBuilding,
  loadShelters,
  loadSheltersDetailed,
  parseShelterGeoJSON,
  shelterTilesForBounds,
} from '../src/data/shelters';
import { planEvacuation } from '../src/people';

/**
 * 国土地理院の指定緊急避難場所データ（全国版 GeoJSON: mergeFromCity_2.geojson）と同じ属性名のフィクスチャ。
 * 値は実データ（藤沢市）から抜粋し、判定用に範囲外・津波指定なし・図形不正の例を加えている。
 */
const GSI_STYLE_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.462205, 35.318504] },
      properties: {
        NO: 37,
        共通ID: 'E1420500037201',
        都道府県名及び市町村名: '神奈川県藤沢市',
        '施設・場所名': '市営鵠沼住宅',
        住所: '神奈川県藤沢市鵠沼海岸4-12',
        洪水: '',
        '崖崩れ、土石流及び地滑り': '',
        高潮: '',
        地震: '',
        津波: '1',
        大規模な火事: '',
        内水氾濫: '',
        火山現象: '',
        指定避難所との住所同一: '',
        備考: '',
      },
    },
    {
      // 津波の指定がない（地震のみ）→ 除外
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.463815, 35.318554] },
      properties: {
        共通ID: 'E1420500036201',
        '施設・場所名': '鵠南小学校',
        住所: '神奈川県藤沢市鵠沼海岸4-7-34',
        地震: '1',
        津波: '',
        備考: '',
      },
    },
    {
      // 範囲外（横浜）→ 除外
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.6, 35.45] },
      properties: { 共通ID: 'X1', '施設・場所名': '範囲外', 住所: '横浜市', 津波: '1' },
    },
    {
      // 備考で津波避難ビルと明示 → tsunami-building
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.47, 35.315] },
      properties: { 共通ID: 'T1', '施設・場所名': 'テストマンション', 住所: '藤沢市鵠沼海岸', 津波: '1', 備考: '津波避難ビル（3階以上）' },
    },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { 津波: '1' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: ['x', 35.3] }, properties: { 津波: '1' } },
    null,
  ],
};

/** 地理院タイルで属性名が英語などの別名だった場合の形式（津波フラグなし＝skhb05 は全点が津波指定） */
const ALT_KEY_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.487623, 35.319606] },
      properties: { name: '片瀬小学校', address: '神奈川県藤沢市片瀬2-14-29' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.490255, 35.313292] },
      properties: { 名称: '片瀬山公園', 所在地: '神奈川県藤沢市片瀬3-12' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.458851, 35.319184] },
      properties: { 都道府県名及び市町村名: '神奈川県藤沢市', 避難場所の名称: '湘洋中学校', 所在地住所: '神奈川県藤沢市辻堂東海岸4-17-1' },
    },
  ],
};

describe('parseShelterGeoJSON', () => {
  it('parses the GSI property names and filters by tsunami flag, bounds and geometry', () => {
    const list = parseShelterGeoJSON(GSI_STYLE_FIXTURE);
    expect(list.map((s) => s.name)).toEqual(['市営鵠沼住宅', 'テストマンション']);
    const s = list[0];
    expect(s).toMatchObject({
      id: 'gsi-E1420500037201',
      name: '市営鵠沼住宅',
      address: '神奈川県藤沢市鵠沼海岸4-12',
      lon: 139.462205,
      lat: 35.318504,
      kind: 'evac-site',
      source: SHELTER_SOURCE_LABEL,
    });
    expect(list[1].kind).toBe('tsunami-building');
  });

  it('accepts alternative property names', () => {
    const list = parseShelterGeoJSON(ALT_KEY_FIXTURE);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ name: '片瀬小学校', address: '神奈川県藤沢市片瀬2-14-29', kind: 'evac-site' });
    expect(list[1]).toMatchObject({ name: '片瀬山公園', address: '神奈川県藤沢市片瀬3-12' });
    // 未知の属性名でも「名称」「住所」を含む属性から拾う（都道府県名及び市町村名は名前にしない）
    expect(list[2]).toMatchObject({ name: '湘洋中学校', address: '神奈川県藤沢市辻堂東海岸4-17-1' });
    expect(list[0].id).not.toBe(list[1].id);
  });

  it('parses the skhb tile property names (name / address / remarks / disaster1..8)', () => {
    // 地理院タイル skhb0N の属性名（公開コード open-hinata の popup.js 等で確認した形式）
    const tile = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.487623, 35.319606] },
          properties: { name: '片瀬小学校', address: '神奈川県藤沢市片瀬2-14-29', remarks: '', disaster1: 1, disaster4: 1, disaster5: 1 },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.48, 35.32] },
          properties: { name: '津波避難ビル（例）', address: '藤沢市', remarks: '津波避難ビル', disaster5: '1' },
        },
        {
          // 津波の指定がない点（他の災害種別のタイルが混ざった場合など）→ 除外
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.463815, 35.318554] },
          properties: { name: '鵠南小学校', address: '神奈川県藤沢市鵠沼海岸4-7-34', disaster4: 1, disaster5: '' },
        },
      ],
    };
    const list = parseShelterGeoJSON(tile);
    expect(list.map((x) => x.name)).toEqual(['片瀬小学校', '津波避難ビル（例）']);
    expect(list[0]).toMatchObject({ address: '神奈川県藤沢市片瀬2-14-29', kind: 'evac-site' });
    expect(list[1].kind).toBe('tsunami-building');
  });

  it('returns [] for invalid input', () => {
    expect(parseShelterGeoJSON(null)).toEqual([]);
    expect(parseShelterGeoJSON('x')).toEqual([]);
    expect(parseShelterGeoJSON({ type: 'FeatureCollection' })).toEqual([]);
  });

  it('detects explicit tsunami evacuation buildings only', () => {
    expect(isTsunamiEvacBuilding({ name: '○○ビル', remarks: '津波避難ビル' })).toBe(true);
    expect(isTsunamiEvacBuilding({ name: '片瀬海岸津波避難タワー' })).toBe(true);
    expect(isTsunamiEvacBuilding({ name: '湘洋中学校' })).toBe(false);
  });
});

describe('shelter tiles', () => {
  it('covers the domain with the z10 skhb05 tile(s)', () => {
    expect(shelterTilesForBounds()).toEqual([{ z: 10, x: 908, y: 404 }]);
    expect(SHELTER_TILE_URLS[0]).toBe('https://cyberjapandata.gsi.go.jp/xyz/skhb05/{z}/{x}/{y}.geojson');
  });

  it('built-in copy is inside the domain, unique and tsunami evac sites', () => {
    const ids = new Set(BUILTIN_TSUNAMI_SHELTERS.map((s) => s.id));
    expect(ids.size).toBe(BUILTIN_TSUNAMI_SHELTERS.length);
    expect(BUILTIN_TSUNAMI_SHELTERS.length).toBe(7);
    for (const s of BUILTIN_TSUNAMI_SHELTERS) {
      expect(s.lon).toBeGreaterThanOrEqual(DOMAIN_BOUNDS.west);
      expect(s.lon).toBeLessThanOrEqual(DOMAIN_BOUNDS.east);
      expect(s.lat).toBeGreaterThanOrEqual(DOMAIN_BOUNDS.south);
      expect(s.lat).toBeLessThanOrEqual(DOMAIN_BOUNDS.north);
      expect(s.kind).toBe('evac-site');
      expect(s.source).toContain('国土地理院');
      expect(s.address).toMatch(/^神奈川県藤沢市/);
    }
  });
});

describe('loadShelters (no network: fetch is stubbed)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the GSI tile when it can be fetched', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(GSI_STYLE_FIXTURE), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await loadSheltersDetailed();
    expect(res.origin).toBe('gsi');
    expect(res.shelters.map((s) => s.name)).toEqual(['市営鵠沼住宅', 'テストマンション']);
    expect(res.message).toContain('国土地理院');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://cyberjapandata.gsi.go.jp/xyz/skhb05/10/908/404.geojson');
  });

  it('tries the alternate host, then falls back to the built-in copy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await loadSheltersDetailed();
    expect(fetchMock).toHaveBeenCalledTimes(SHELTER_TILE_URLS.length);
    expect(res.origin).toBe('builtin');
    expect(res.shelters).toHaveLength(BUILTIN_TSUNAMI_SHELTERS.length);
    expect(res.message).toContain('内蔵');
    // 返した配列を変更しても内蔵データは変わらない
    res.shelters[0].name = 'changed';
    expect(BUILTIN_TSUNAMI_SHELTERS[0].name).not.toBe('changed');
  });

  it('falls back when the response is an HTTP error or contains nothing in range', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    expect((await loadSheltersDetailed()).origin).toBe('builtin');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }))));
    const list = await loadShelters();
    expect(list).toHaveLength(BUILTIN_TSUNAMI_SHELTERS.length);
  });

  it('rejects when aborted by the caller', async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const p = loadShelters({ signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeTruthy();
  });
});

describe('planning to the built-in shelters on a standard grid', () => {
  it('reaches a shelter from Kugenuma beach on a synthetic coastal terrain', () => {
    const spec = createGridSpec('standard');
    const n = spec.nx * spec.ny;
    // 近似: 北緯 35.305 付近より南を海とする合成地形（江の島は含めない）
    const coast = lonLatToCell(spec, 139.47, 35.308)!.j;
    const z = new Float32Array(n);
    const kind = new Uint8Array(n);
    for (let j = 0; j < spec.ny; j++) {
      for (let i = 0; i < spec.nx; i++) {
        const k = j * spec.nx + i;
        const sea = j > coast;
        kind[k] = sea ? CELL_SEA : CELL_LAND;
        z[k] = sea ? -5 : 3 + (coast - j) * 0.03;
      }
    }
    const grid: TerrainGrid = { spec, z, kind, manning: new Float32Array(n), source: 'synthetic', sourceLabel: '', isApproximate: true, notes: [] };
    const params = { scenario: { coastHeight: 10 }, tideTP: 0 } as unknown as SimParams;
    const shelters = BUILTIN_TSUNAMI_SHELTERS.map((s) => ({ ...s }));
    const person = { id: 'p', name: 'p', kind: 'adult' as const, lon: 139.4705, lat: 35.3095, evacMode: 'shelter' as const, startDelayMin: 5 };
    const plan = planEvacuation(person, grid, shelters, null, params);
    expect(plan.target).not.toBeNull();
    // 江の島（合成地形では海の中）以外の避難場所を選ぶ
    expect(plan.target!.name).not.toContain('江の島');
    expect(shelters.some((s) => s.name === plan.target!.name)).toBe(true);
    expect(plan.arriveAt!).toBeGreaterThan(300);
  });
});
