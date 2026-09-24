import { describe, expect, it } from 'vitest';
import { DOMAIN_BOUNDS, lonLatToPixel } from '../src/core/geo';
import {
  ARRIVAL_CLASSES,
  BASEMAPS,
  DEM_CREDIT,
  DEM_TILES,
  DEPTH_CLASSES,
  HAZARD_PORTAL_NOTICE,
  HAZARD_TSUNAMI_KANAGAWA_URL,
  HAZARD_TSUNAMI_TILES,
  KANAGAWA_TSUNAMI_KEIKAI_URL,
  LANDSAT_CREDIT,
  MIN_FLOOD_DEPTH,
  OPENFREEMAP,
  RELIEF_EXTRA_CREDIT,
  RELIEF_TILES,
  SIM_VS_OFFICIAL_NOTE,
  depthClassFromRgb,
  depthClassOf,
  depthToRgba,
  type RasterTileSource,
} from '../src/data/sources';
import { POIS, type Poi } from '../src/data/poi';

const rasters: RasterTileSource[] = [...Object.values(BASEMAPS), RELIEF_TILES, HAZARD_TSUNAMI_TILES];

function rgba(depth: number): number[] {
  return Array.from(depthToRgba(depth, [0, 0, 0, 0], 0));
}

describe('tile sources', () => {
  it('URL templates are https and contain {z}/{x}/{y}', () => {
    const urls = [...rasters.map((r) => r.url), ...DEM_TILES.map((d) => d.url), HAZARD_TSUNAMI_KANAGAWA_URL];
    for (const url of urls) {
      expect(url.startsWith('https://')).toBe(true);
      expect(url).toContain('{z}/{x}/{y}');
    }
  });

  it('zoom ranges match the verified values', () => {
    for (const r of rasters) {
      expect(r.minzoom).toBeLessThanOrEqual(r.maxzoom);
      expect(r.tileSize).toBe(256);
      expect(r.attribution.length).toBeGreaterThan(0);
    }
    expect(BASEMAPS.pale.maxzoom).toBe(18);
    expect(BASEMAPS.std.maxzoom).toBe(18);
    expect(BASEMAPS.photo.maxzoom).toBe(18);
    expect(RELIEF_TILES.maxzoom).toBe(15);
    expect(HAZARD_TSUNAMI_TILES.maxzoom).toBe(17);
    expect(DEM_TILES.find((d) => d.id === 'dem5a_png')?.maxzoom).toBe(15);
    expect(DEM_TILES.find((d) => d.id === 'dem_png')?.maxzoom).toBe(14);
  });

  it('attributions link to the official pages and carry the required extra credits', () => {
    for (const b of Object.values(BASEMAPS)) expect(b.attribution).toContain('https://maps.gsi.go.jp/development/ichiran.html');
    expect(RELIEF_TILES.attribution).toContain('海域部は海上保安庁海洋情報部の資料を使用して作成');
    expect(BASEMAPS.photo.attribution).toContain('Landsat8');
    expect(HAZARD_TSUNAMI_TILES.attribution).toContain('ハザードマップポータルサイト');
    expect(HAZARD_TSUNAMI_TILES.attribution).toContain('神奈川県');
    expect(DEM_CREDIT).toBe('地理院タイル（標高タイル（基盤地図情報数値標高モデル））を加工して作成');
    expect(OPENFREEMAP.attribution).toContain('OpenMapTiles');
    expect(OPENFREEMAP.attribution).toContain('https://www.openstreetmap.org/copyright');
    expect(OPENFREEMAP.heightField).toBe('render_height');
    expect(OPENFREEMAP.minHeightField).toBe('render_min_height');
    expect(OPENFREEMAP.buildingLayer).toBe('building');
  });
});

describe('depth legend (水害ハザードマップ作成の手引き 詳細版)', () => {
  it('has the official 8 classes, contiguous and ending at Infinity', () => {
    expect(DEPTH_CLASSES.map((c) => c.color)).toEqual([
      '#ffffb3',
      '#f7f5a9',
      '#f8e1a6',
      '#ffd8c0',
      '#ffb7b7',
      '#ff9191',
      '#f285c9',
      '#dc7adc',
    ]);
    expect(DEPTH_CLASSES[0].min).toBe(MIN_FLOOD_DEPTH);
    for (let i = 1; i < DEPTH_CLASSES.length; i++) expect(DEPTH_CLASSES[i].min).toBe(DEPTH_CLASSES[i - 1].max);
    expect(DEPTH_CLASSES.map((c) => c.max)).toEqual([0.3, 0.5, 1, 3, 5, 10, 20, Infinity]);
  });

  it('depthToRgba: below 0.01 m (and NaN) is transparent', () => {
    expect(rgba(0)).toEqual([0, 0, 0, 0]);
    expect(rgba(0.009)).toEqual([0, 0, 0, 0]);
    expect(rgba(-1)).toEqual([0, 0, 0, 0]);
    expect(rgba(Number.NaN)).toEqual([0, 0, 0, 0]);
  });

  it('depthToRgba: class boundaries map to the official RGB values', () => {
    const cases: [number, [number, number, number]][] = [
      [0.01, [255, 255, 179]],
      [0.29, [255, 255, 179]],
      [0.3, [247, 245, 169]],
      [0.49, [247, 245, 169]],
      [0.5, [248, 225, 166]],
      [0.99, [248, 225, 166]],
      [1, [255, 216, 192]],
      [2.99, [255, 216, 192]],
      [3, [255, 183, 183]],
      [5, [255, 145, 145]],
      [9.99, [255, 145, 145]],
      [10, [242, 133, 201]],
      [19.99, [242, 133, 201]],
      [20, [220, 122, 220]],
      [35, [220, 122, 220]],
      [Infinity, [220, 122, 220]],
    ];
    for (const [d, rgb] of cases) {
      const out = rgba(d);
      expect(out.slice(0, 3), `depth ${d}`).toEqual(rgb);
      expect(out[3]).toBeGreaterThan(0);
    }
  });

  it('writes at the given offset of a Uint8ClampedArray', () => {
    const buf = new Uint8ClampedArray(8);
    depthToRgba(4, buf, 4);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 255, 183, 183, buf[7]]);
    expect(buf[7]).toBeGreaterThan(0);
  });

  it('depthClassOf / depthClassFromRgb round-trip', () => {
    expect(depthClassOf(0.005)).toBeNull();
    expect(depthClassOf(2)?.label).toBe('1〜3m');
    for (const c of DEPTH_CLASSES) {
      const n = parseInt(c.color.slice(1), 16);
      expect(depthClassFromRgb((n >> 16) & 255, (n >> 8) & 255, n & 255)).toBe(c);
    }
    expect(depthClassFromRgb(0, 0, 0)).toBeNull();
  });
});

describe('arrival legend', () => {
  it('is ascending, ends at Infinity and uses distinct colours', () => {
    for (let i = 1; i < ARRIVAL_CLASSES.length; i++) expect(ARRIVAL_CLASSES[i].maxMin).toBeGreaterThan(ARRIVAL_CLASSES[i - 1].maxMin);
    expect(ARRIVAL_CLASSES[ARRIVAL_CLASSES.length - 1].maxMin).toBe(Infinity);
    expect(new Set(ARRIVAL_CLASSES.map((c) => c.color)).size).toBe(ARRIVAL_CLASSES.length);
    for (const c of ARRIVAL_CLASSES) expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
    // 10〜20分の到達を区別できること
    expect(ARRIVAL_CLASSES.filter((c) => c.maxMin > 10 && c.maxMin <= 20).length).toBeGreaterThanOrEqual(2);
  });

  it('gets darker (lower luminance) for earlier arrival', () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    for (let i = 1; i < ARRIVAL_CLASSES.length; i++) expect(lum(ARRIVAL_CLASSES[i].color)).toBeGreaterThan(lum(ARRIVAL_CLASSES[i - 1].color));
  });
});

describe('POIs', () => {
  it('are inside the simulation domain and have unique ids', () => {
    expect(POIS.length).toBeGreaterThanOrEqual(14);
    expect(new Set(POIS.map((p) => p.id)).size).toBe(POIS.length);
    for (const p of POIS) {
      expect(p.lon, p.name).toBeGreaterThan(DOMAIN_BOUNDS.west);
      expect(p.lon, p.name).toBeLessThan(DOMAIN_BOUNDS.east);
      expect(p.lat, p.name).toBeGreaterThan(DOMAIN_BOUNDS.south);
      expect(p.lat, p.name).toBeLessThan(DOMAIN_BOUNDS.north);
      expect(p.source, p.name).toBeTruthy();
      if (p.elevationTP !== undefined) {
        expect(p.elevationTP).toBeGreaterThan(-1);
        expect(p.elevationTP).toBeLessThan(70);
      }
    }
  });

  it('places 鵠沼海岸駅 in the known coastal z15 tile row and 江の島 south of the coast stations', () => {
    const st = POIS.find((p) => p.id === 'st-kugenuma-kaigan')!;
    const px = lonLatToPixel(st.lon, st.lat, 15);
    expect(Math.floor(px.x / 256)).toBe(29078);
    const shrine = POIS.find((p) => p.id === 'lm-hetsunomiya')!;
    for (const p of POIS.filter((q) => q.kind === 'station')) expect(shrine.lat).toBeLessThan(p.lat);
  });
});

// ---------------------------------------------------------------------------
// 独立の再確認（2026-09-24）で確かめた値・直した記述の回帰テスト
// ---------------------------------------------------------------------------

describe('official wording (re-checked against the primary pages)', () => {
  it('extra credits are the exact strings from the GSI tile list', () => {
    // https://maps.gsi.go.jp/development/ichiran.html 「写真」ZL9〜13 と「色別標高図」の備考
    expect(LANDSAT_CREDIT).toBe(
      'データソース：Landsat8画像（GSI,TSIC,GEO Grid/AIST）, Landsat8画像（courtesy of the U.S. Geological Survey）, 海底地形（GEBCO）',
    );
    expect(RELIEF_EXTRA_CREDIT).toBe('海域部は海上保安庁海洋情報部の資料を使用して作成');
    expect(BASEMAPS.photo.attribution).toContain(LANDSAT_CREDIT);
    expect(RELIEF_TILES.attribution).toContain(RELIEF_EXTRA_CREDIT);
    // ZL8 以下は別の出所表記が要るので読み込まない
    for (const b of Object.values(BASEMAPS)) expect(b.minzoom).toBeGreaterThanOrEqual(9);
  });

  it('hazard-portal notice is quoted verbatim from its terms', () => {
    // https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/copyright.html 利用上の注意・免責 1.
    expect(HAZARD_PORTAL_NOTICE).toBe('最新かつ詳細な情報については各市町村が作成するハザードマップをご確認ください。');
  });

  it('the official layer is described as depth, not the 基準水位 of the 津波災害警戒区域', () => {
    const notes = HAZARD_TSUNAMI_TILES.notes ?? '';
    expect(notes).toContain('浸水深');
    expect(notes).toContain('基準水位」ではありません');
    expect(notes).toContain('平成27年3月');
    expect(notes).toContain('5つの地震');
    expect(notes).toContain('河川内');
    expect(KANAGAWA_TSUNAMI_KEIKAI_URL.startsWith('https://www.pref.kanagawa.jp/')).toBe(true);
  });

  it('the official-layer notes say the simulation floods less and shallower even against the same 西側 quake (docs/MODEL.md 4.13.5)', () => {
    // 5地震の重ね合わせだけが原因のように読めないこと: 西側モデル単独の予測図との比較でも recall 0.831（鵠沼 0.877）・浅い 0.408
    const notes = HAZARD_TSUNAMI_TILES.notes ?? '';
    expect(notes).toContain(SIM_VS_OFFICIAL_NOTE);
    expect(SIM_VS_OFFICIAL_NOTE).toContain('狭く');
    expect(SIM_VS_OFFICIAL_NOTE).toContain('浅め');
    expect(SIM_VS_OFFICIAL_NOTE).toContain('同じ相模トラフ西側モデル');
    expect(SIM_VS_OFFICIAL_NOTE).toContain('1〜2割');
    expect(SIM_VS_OFFICIAL_NOTE).toContain('公式の想定の方が広く深い前提');
    expect(SIM_VS_OFFICIAL_NOTE).not.toMatch(/ふつう|だけが原因/);
  });

  it('DEM tile ids and zoom limits match the GSI tile list', () => {
    expect(DEM_TILES.map((d) => [d.id, d.maxzoom])).toEqual([
      ['dem1a_png', 17],
      ['dem5a_png', 15],
      ['dem5b_png', 15],
      ['dem5c_png', 15],
      ['dem_png', 14],
    ]);
  });

  it('building height note states the OpenMapTiles defaults (5 m, 3.66 m per level)', () => {
    expect(OPENFREEMAP.defaultHeightM).toBe(5);
    expect(OPENFREEMAP.levelHeightM).toBe(3.66);
    expect(OPENFREEMAP.heightNote).toContain('5m');
    expect(OPENFREEMAP.heightNote).toContain('3.66m');
    expect(OPENFREEMAP.heightNote).toContain('実際の高さではありません');
  });

  it('arrival colours are the 7-step viridis samples', () => {
    // matplotlib _viridis_data の 0, 1/6, …, 1 の位置
    expect(ARRIVAL_CLASSES.map((c) => c.color)).toEqual(['#440154', '#443983', '#31688e', '#21918c', '#35b779', '#90d743', '#fde725']);
    expect(ARRIVAL_CLASSES.map((c) => c.maxMin)).toEqual([10, 15, 20, 25, 30, 45, Infinity]);
  });
});

describe('POI positions (independently re-checked 2026-09-24)', () => {
  /** 2点間の距離 [m]（正距円筒近似。数百 m の範囲なら十分） */
  function distM(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
    const k = Math.PI / 180;
    const x = (a.lon - b.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k) * 6371000;
    const y = (a.lat - b.lat) * k * 6371000;
    return Math.hypot(x, y);
  }
  const byId = (id: string): Poi => {
    const p = POIS.find((q) => q.id === id);
    if (!p) throw new Error(id);
    return p;
  };

  // 別の手段で確かめた基準点（OSM の駅ノード・施設の外形、国土地理院 地名検索の施設点・自然地名点、
  // 標準地図 z16〜17 の記号）。POI はこれらから 50m 以内でなければならない。
  const refs: [string, number, number, string][] = [
    ['st-kugenuma-kaigan', 139.4712735, 35.3207079, 'OSM node 10108140339'],
    ['st-katase-enoshima', 139.483502, 35.308873, 'OSM node 264240233（小田急の終端）'],
    ['st-enoden-kugenuma', 139.4826015, 35.3214239, 'OSM node 8062865734'],
    ['st-enoden-enoshima', 139.4875422, 35.3110438, 'OSM node 8062865735'],
    ['st-shonan-kaigan-koen', 139.4836473, 35.3149457, 'OSM node 8063967424'],
    ['st-fujisawa', 139.4872148, 35.338819, 'OSM node 4011607028（JR）'],
    ['lm-hetsunomiya', 139.4795407, 35.3004857, 'OSM way 191660159'],
    ['lm-enoshima-ohashi-north', 139.48290, 35.30573, 'OSM way 335334813 の北端'],
    ['lm-enoshima-aquarium', 139.47946, 35.30993, '地名検索（施設）'],
    // スケートパーク（OSM way 1450872533）と駐車場（way 1450872534）を合わせた範囲（東経139.46486〜139.46737、北緯35.31605〜35.31695）の中心
    ['pk-kugenuma-kaihin', 139.46612, 35.3165, 'OSM スケートパーク＋駐車場の範囲の中心'],
    ['pk-tsujido-kaihin', 139.44804, 35.32099, '地名検索（施設）'],
    ['rv-hikichi-mouth', 139.46829, 35.31507, '地名検索（自然地名「引地川」）'],
    ['rv-sakai-mouth', 139.48123, 35.30537, '地名検索（自然地名「境川」）'],
    ['lm-fujisawa-city-hall', 139.49125, 35.33888, '地名検索（施設）'],
  ];

  it('every POI has an independent reference point within 50 m', () => {
    expect(new Set(refs.map((r) => r[0]))).toEqual(new Set(POIS.map((p) => p.id)));
    for (const [id, lon, lat, src] of refs) {
      const d = distM(byId(id), { lon, lat });
      expect(d, `${id} vs ${src}: ${d.toFixed(1)} m`).toBeLessThan(50);
    }
  });

  it('relative geography is right', () => {
    // 鵠沼海浜公園（鵠沼海岸四丁目）は引地川の西、片瀬江ノ島駅（小田急）は江ノ電 江ノ島駅の西
    expect(byId('pk-kugenuma-kaihin').lon).toBeLessThan(byId('rv-hikichi-mouth').lon);
    expect(byId('st-katase-enoshima').lon).toBeLessThan(byId('st-enoden-enoshima').lon);
    // 境川の河口は江の島大橋の北詰より西（片瀬漁港との間）
    expect(byId('rv-sakai-mouth').lon).toBeLessThan(byId('lm-enoshima-ohashi-north').lon);
    // 水面・橋の地点には地面の標高を付けない
    for (const id of ['rv-hikichi-mouth', 'rv-sakai-mouth', 'lm-enoshima-ohashi-north']) expect(byId(id).elevationTP).toBeUndefined();
  });

  it('elevations are the GSI elevation-API values (1m laser DEM) re-read on 2026-09-24', () => {
    const expected: Record<string, number> = {
      'st-kugenuma-kaigan': 4.2,
      'st-katase-enoshima': 4.1,
      'st-enoden-kugenuma': 5.9,
      'st-enoden-enoshima': 4.4,
      'st-shonan-kaigan-koen': 4.0,
      'st-fujisawa': 13.0,
      'lm-hetsunomiya': 46.0,
      'lm-enoshima-aquarium': 6.0,
      'pk-kugenuma-kaihin': 3.8,
      'pk-tsujido-kaihin': 6.7,
      'lm-fujisawa-city-hall': 12.8,
    };
    for (const [id, v] of Object.entries(expected)) expect(byId(id).elevationTP, id).toBe(v);
  });
});
