/**
 * 地名・住所の検索（国土地理院 地名検索API）・住所の目安（逆ジオコーダー）・現在地の純粋な処理。
 */
import { describe, expect, it, vi } from 'vitest';
import { DOMAIN_BOUNDS, createGridSpec, lonLatToCell } from '../src/core/geo';
import { CELL_LAND, CELL_SEA } from '../src/core/types';
import {
  GSI_REQUEST_TIMEOUT_MS,
  LruCache,
  areaLabel,
  cleanText,
  describeResult,
  distanceToDomain,
  formatApproxDistance,
  isInsideBounds,
  isTimeoutError,
  municipalityOf,
  normalizeMuniCode,
  normalizeQuery,
  outsideBadge,
  parseReverseResponse,
  parseSearchResponse,
  placementProblem,
  positionNote,
  snapToKnownPlaces,
  reverseCacheKey,
  reverseGeocode,
  reverseUrl,
  searchPlaces,
  searchUrl,
  sortResults,
  withTimeout,
  type FetchLike,
} from '../src/ui/geoSearch';
import { GEO_OPTIONS, GeoError, describeAccuracy, geoErrorKind, geoErrorMessage, isLowAccuracy, requestPosition, toUserLocation } from '../src/ui/geolocate';
import { MAP_VIEW_BOUNDS, circleRing, domainZoomForWidth, isInMapView } from '../src/map2d/geo2d';
import { distanceMeters, INITIAL_ZOOM } from '../src/core/geo';

/** 地名検索 API の実際の応答（2026年9月、q=鵠沼海岸 の一部）と同じ形 */
const feature = (lon: number, lat: number, title: string, addressCode = '14205', dataSource?: string) => ({
  geometry: { coordinates: [lon, lat], type: 'Point' },
  type: 'Feature',
  properties: { addressCode, title, ...(dataSource ? { dataSource } : {}) },
});

const SAMPLE = [
  feature(140.035019, 42.670551, '北海道島牧村江ノ島', ''),
  feature(139.5505, 35.319, '鎌倉駅', '14204', '1'),
  feature(139.473022, 35.315491, '神奈川県藤沢市鵠沼海岸', ''),
  feature(139.467984495702, 35.3204696880482, '鵠沼海岸三丁目', '14205', '5'),
  feature(139.471350527778, 35.3208555555556, '鵠沼海岸駅', '14205', '1'),
  // 同じ名称・ほぼ同じ位置（まとめられる）
  feature(139.4713506, 35.3208556, '鵠沼海岸駅', '14205', '1'),
  // 形の合わないもの
  { geometry: { coordinates: ['x', 35] }, properties: { title: 'bad' } },
  { geometry: { coordinates: [139.47, 35.31] }, properties: { title: '' } },
  null,
  'text',
];

describe('cleanText / normalizeQuery', () => {
  it('removes control and bidi characters and collapses spaces', () => {
    expect(cleanText('  鵠沼\u0000海岸‮駅\n ')).toBe('鵠沼 海岸 駅');
    expect(cleanText(42)).toBe('');
    expect(cleanText('あ'.repeat(100), 10)).toBe(`${'あ'.repeat(9)}…`);
  });

  it('keeps markup as plain text (inserted with textContent later)', () => {
    expect(cleanText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('normalizes queries', () => {
    expect(normalizeQuery('　鵠沼海岸　 駅 ')).toBe('鵠沼海岸 駅');
    expect(normalizeQuery('')).toBe('');
    expect(normalizeQuery('a'.repeat(200)).length).toBe(64);
  });
});

describe('municipality codes', () => {
  it('normalizes codes (Hokkaido codes may lose the leading zero)', () => {
    expect(normalizeMuniCode('14205')).toBe('14205');
    expect(normalizeMuniCode('1100')).toBe('01100');
    expect(normalizeMuniCode(14204)).toBe('14204');
    expect(normalizeMuniCode('')).toBeNull();
    expect(normalizeMuniCode('99999')).toBeNull();
    expect(normalizeMuniCode('abc')).toBeNull();
  });

  it('maps codes to names', () => {
    expect(municipalityOf('14205')).toEqual({ prefecture: '神奈川県', municipality: '藤沢市' });
    expect(areaLabel('14204')).toBe('神奈川県鎌倉市');
    expect(areaLabel('14207')).toBe('神奈川県茅ヶ崎市');
    expect(areaLabel('13101')).toBe('東京都');
    expect(areaLabel('1100')).toBe('北海道');
    expect(areaLabel('')).toBe('');
  });
});

describe('domain helpers', () => {
  it('checks the calculation domain', () => {
    expect(isInsideBounds(139.4705, 35.3135)).toBe(true);
    expect(isInsideBounds(139.5505, 35.319)).toBe(false);
    expect(isInsideBounds(NaN, 35.3)).toBe(false);
    expect(distanceToDomain(139.47, 35.31)).toBe(0);
  });

  it('measures the distance to the nearest edge of the domain', () => {
    // 鎌倉駅は計算範囲の東端（139.50）から東へ約 4.7 km
    const d = distanceToDomain(139.5505, 35.319);
    expect(d).toBeGreaterThan(4000);
    expect(d).toBeLessThan(5200);
    expect(distanceToDomain(139.47, DOMAIN_BOUNDS.north + 0.01)).toBeCloseTo(distanceMeters({ lon: 139.47, lat: DOMAIN_BOUNDS.north + 0.01 }, { lon: 139.47, lat: DOMAIN_BOUNDS.north }), 3);
  });

  it('formats approximate distances', () => {
    expect(formatApproxDistance(3)).toBe('約 10 m');
    expect(formatApproxDistance(845)).toBe('約 850 m');
    expect(formatApproxDistance(4700)).toBe('約 4.7 km');
    expect(formatApproxDistance(830_400)).toBe('約 830 km');
  });

  it('checks whether a person can be placed', () => {
    const spec = createGridSpec('coarse');
    const kind = new Uint8Array(spec.nx * spec.ny).fill(CELL_LAND);
    const sea = lonLatToCell(spec, 139.47, 35.3)!;
    kind[sea.k] = CELL_SEA;
    expect(placementProblem(spec, kind, 139.4713, 35.3208)).toBeNull();
    expect(placementProblem(spec, kind, 139.47, 35.3)).toBe('sea');
    expect(placementProblem(spec, null, 139.47, 35.3)).toBeNull();
    expect(placementProblem(spec, kind, 139.5505, 35.319)).toBe('outside');
    expect(placementProblem(spec, kind, NaN, 35.3)).toBe('outside');
  });
});

describe('parseSearchResponse / sortResults', () => {
  it('validates, de-duplicates and classifies results', () => {
    const rs = parseSearchResponse(SAMPLE);
    expect(rs.map((r) => r.title)).toEqual(['北海道島牧村江ノ島', '鎌倉駅', '神奈川県藤沢市鵠沼海岸', '鵠沼海岸三丁目', '鵠沼海岸駅']);
    const byTitle = Object.fromEntries(rs.map((r) => [r.title, r]));
    expect(byTitle['鵠沼海岸駅']).toMatchObject({ inside: true, distanceM: 0, kind: 'place', area: '神奈川県藤沢市', viewable: true, muniCode: '14205' });
    expect(byTitle['鵠沼海岸三丁目'].kind).toBe('town');
    expect(byTitle['神奈川県藤沢市鵠沼海岸']).toMatchObject({ kind: 'address', muniCode: null, area: '' });
    expect(byTitle['鎌倉駅']).toMatchObject({ inside: false, viewable: true, area: '神奈川県鎌倉市' });
    expect(byTitle['北海道島牧村江ノ島']).toMatchObject({ inside: false, viewable: false });
    expect(parseSearchResponse({ type: 'FeatureCollection' })).toEqual([]);
    expect(parseSearchResponse(null)).toEqual([]);
  });

  it('puts results inside the domain first (API order), then outside ones by distance', () => {
    const rs = sortResults(parseSearchResponse(SAMPLE));
    expect(rs.map((r) => r.title)).toEqual(['神奈川県藤沢市鵠沼海岸', '鵠沼海岸三丁目', '鵠沼海岸駅', '鎌倉駅', '北海道島牧村江ノ島']);
    expect(rs.map((r) => r.id)).toEqual(['place-0', 'place-1', 'place-2', 'place-3', 'place-4']);
    expect(sortResults(parseSearchResponse(SAMPLE), 2)).toHaveLength(2);
  });

  it('puts exact matches first among results inside the domain', () => {
    const rs = sortResults(parseSearchResponse(SAMPLE), 30, ' 鵠沼海岸駅 ');
    expect(rs.map((r) => r.title)).toEqual(['鵠沼海岸駅', '神奈川県藤沢市鵠沼海岸', '鵠沼海岸三丁目', '鎌倉駅', '北海道島牧村江ノ島']);
    // 計算範囲の外の完全一致は、内側より前にしない
    expect(sortResults(parseSearchResponse(SAMPLE), 30, '鎌倉駅')[0].title).toBe('神奈川県藤沢市鵠沼海岸');
  });

  it('describes results and marks outside ones', () => {
    const rs = sortResults(parseSearchResponse(SAMPLE));
    expect(describeResult(rs[0])).toBe('住所');
    expect(describeResult(rs[2])).toBe('神奈川県藤沢市');
    expect(outsideBadge(rs[2])).toBeNull();
    expect(outsideBadge(rs[3])).toMatch(/^計算範囲外・約 4\.\d km$/);
  });
});

describe('snapToKnownPlaces', () => {
  it('replaces the label position of a station with the checked position (data/poi.ts)', () => {
    // 地名検索の「片瀬江ノ島駅」は地図の注記の位置（2026年9月の応答）で、駅舎から約400m西
    const rs = snapToKnownPlaces(
      parseSearchResponse([
        feature(139.4790604025, 35.3092351777778, '片瀬江ノ島駅', '14205', '1'),
        feature(139.471350527778, 35.3208555555556, '鵠沼海岸駅', '14205', '1'),
        feature(135.5, 34.7, '片瀬江ノ島駅', '27100', '1'),
      ]),
    );
    expect(rs[0].lon).toBeCloseTo(139.4835, 6);
    expect(rs[0].lat).toBeCloseTo(35.30887, 6);
    expect(rs[0].adjustedM).toBeGreaterThan(350);
    expect(rs[0].adjustedM).toBeLessThan(450);
    expect(rs[0].inside).toBe(true);
    expect(positionNote(rs[0])).toContain('このサイトで確かめた位置');
    // 差が小さいもの・遠く離れた同名の地点はそのまま
    expect(rs[1].adjustedM).toBeUndefined();
    expect(rs[1].lon).toBe(139.471350527778);
    expect(positionNote(rs[1])).toContain('数百m');
    expect(rs[2].lon).toBe(135.5);
    expect(positionNote({ kind: 'town' })).toBeNull();
  });
});

describe('parseReverseResponse', () => {
  it('reads the reverse geocoder response', () => {
    expect(parseReverseResponse({ results: { muniCd: '14205', lv01Nm: '鵠沼海岸二丁目' } })).toEqual({
      muniCode: '14205',
      municipality: '藤沢市',
      town: '鵠沼海岸二丁目',
      label: '藤沢市鵠沼海岸二丁目',
    });
    expect(parseReverseResponse({ results: { muniCd: '14204', lv01Nm: '腰越一丁目' } })?.label).toBe('鎌倉市腰越一丁目');
    expect(parseReverseResponse({ results: { muniCd: '13101', lv01Nm: '－' } })?.label).toBe('東京都');
    expect(parseReverseResponse({})).toBeNull();
    expect(parseReverseResponse({ results: { muniCd: '', lv01Nm: '' } })).toBeNull();
    expect(parseReverseResponse(null)).toBeNull();
  });
});

describe('requests', () => {
  it('builds URLs', () => {
    expect(searchUrl('鵠沼 海岸&x')).toBe('https://msearch.gsi.go.jp/address-search/AddressSearch?q=%E9%B5%A0%E6%B2%BC%20%E6%B5%B7%E5%B2%B8%26x');
    expect(reverseUrl(139.4702123, 35.3187456)).toBe('https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=35.31875&lon=139.47021');
    expect(reverseCacheKey(139.47021, 35.31871)).toBe('139.4702,35.3187');
  });

  it('searches with a fetch function (no cookies) and sorts the results', async () => {
    const calls: { url: string; credentials?: string }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, credentials: init.credentials });
      return { ok: true, status: 200, json: async () => SAMPLE };
    };
    const rs = await searchPlaces(' 鵠沼海岸 ', { fetchFn });
    expect(calls).toEqual([{ url: searchUrl('鵠沼海岸'), credentials: 'omit' }]);
    expect(rs[0].title).toBe('神奈川県藤沢市鵠沼海岸');
    expect(await searchPlaces('   ', { fetchFn })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('throws on HTTP errors', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 503, json: async () => null });
    await expect(searchPlaces('鵠沼', { fetchFn })).rejects.toThrow('HTTP 503');
    await expect(reverseGeocode(139.47, 35.32, { fetchFn })).rejects.toThrow('HTTP 503');
  });

  it('reverse geocodes', async () => {
    const fetchFn: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ results: { muniCd: '14205', lv01Nm: '片瀬海岸一丁目' } }) });
    expect((await reverseGeocode(139.48, 35.31, { fetchFn }))?.label).toBe('藤沢市片瀬海岸一丁目');
    expect(await reverseGeocode(NaN, 35.31, { fetchFn })).toBeNull();
  });
});

describe('request timeouts (国土地理院の API が応答しないまま止まる場合)', () => {
  /** 応答を返さない fetch（signal にも従わない） */
  const stalled: FetchLike = () => new Promise(() => {});
  /** ヘッダーは返すが本文の読み取りで止まる fetch */
  const stalledBody: FetchLike = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });

  it('waits at most about 10 seconds by default', () => {
    expect(GSI_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(GSI_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it('gives up with a TimeoutError (not an AbortError) when the search API never answers', async () => {
    vi.useFakeTimers();
    try {
      const p = searchPlaces('鵠沼海岸駅', { fetchFn: stalled });
      const done = expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(GSI_REQUEST_TIMEOUT_MS + 1);
      await done;
      const e = await p.catch((err: unknown) => err);
      expect(isTimeoutError(e)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up when the reverse geocoder stalls while reading the body', async () => {
    vi.useFakeTimers();
    try {
      const p = reverseGeocode(139.4702, 35.3187, { fetchFn: stalledBody });
      const done = expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(GSI_REQUEST_TIMEOUT_MS + 1);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the underlying request on timeout and rejects with AbortError when the caller cancels', async () => {
    let seen: AbortSignal | undefined;
    const spy: FetchLike = (_url, init) => {
      seen = init.signal;
      return new Promise(() => {});
    };
    const timedOut = searchPlaces('鵠沼', { fetchFn: spy, timeoutMs: 20 });
    await expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(seen?.aborted).toBe(true);

    const ac = new AbortController();
    const cancelled = reverseGeocode(139.47, 35.32, { fetchFn: spy, signal: ac.signal, timeoutMs: 60_000 });
    ac.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen?.aborted).toBe(true);
    // 呼び出す前に中止済み
    await expect(searchPlaces('鵠沼', { fetchFn: spy, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes results and errors through unchanged and clears the timer', async () => {
    vi.useFakeTimers();
    try {
      await expect(withTimeout(async () => 42, { timeoutMs: 1000 })).resolves.toBe(42);
      await expect(withTimeout(async () => Promise.reject(new Error('boom')), { timeoutMs: 1000 })).rejects.toThrow('boom');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
    expect(c.size).toBe(2);
  });
});

describe('geolocation helpers', () => {
  it('maps error codes to Japanese messages', () => {
    expect(geoErrorKind(1)).toBe('denied');
    expect(geoErrorKind(2)).toBe('unavailable');
    expect(geoErrorKind(3)).toBe('timeout');
    expect(geoErrorMessage('denied').title).toBe('位置情報の利用が許可されていません');
    expect(geoErrorMessage('insecure').detail).toContain('https');
    for (const k of ['denied', 'unavailable', 'timeout', 'insecure', 'unsupported'] as const) {
      expect(geoErrorMessage(k).title.length).toBeGreaterThan(5);
    }
  });

  it('describes accuracy', () => {
    expect(describeAccuracy(12.4)).toBe('誤差 約 12 m');
    expect(describeAccuracy(346)).toBe('誤差 約 350 m');
    expect(describeAccuracy(2400)).toBe('誤差 約 2.4 km');
    expect(describeAccuracy(NaN)).toBe('誤差は不明');
    expect(isLowAccuracy(30)).toBe(false);
    expect(isLowAccuracy(1500)).toBe(true);
  });

  it('builds a user location and checks the domain', () => {
    expect(toUserLocation({ longitude: 139.4705, latitude: 35.3187, accuracy: 25 }, 1000)).toEqual({
      lon: 139.4705,
      lat: 35.3187,
      accuracyM: 25,
      timestamp: 1000,
      insideDomain: true,
    });
    expect(toUserLocation({ longitude: 139.767, latitude: 35.681, accuracy: 25 }, 1).insideDomain).toBe(false);
  });

  it('requests the position once with high accuracy and a timeout', async () => {
    let options: PositionOptions | undefined;
    const geo = {
      getCurrentPosition: (ok: PositionCallback, _err: PositionErrorCallback | null, opts?: PositionOptions) => {
        options = opts;
        ok({ coords: { longitude: 139.47, latitude: 35.32, accuracy: 10 }, timestamp: 0 } as GeolocationPosition);
      },
    } as unknown as Geolocation;
    const loc = await requestPosition({ geolocation: geo, secure: true, now: () => 5 });
    expect(loc).toMatchObject({ lon: 139.47, lat: 35.32, accuracyM: 10, timestamp: 5, insideDomain: true });
    expect(options).toEqual(GEO_OPTIONS);
    expect(GEO_OPTIONS.enableHighAccuracy).toBe(true);
    expect(GEO_OPTIONS.timeout).toBeGreaterThan(0);
  });

  it('rejects with a typed error', async () => {
    const denied = {
      getCurrentPosition: (_ok: PositionCallback, err: PositionErrorCallback) => err({ code: 1 } as GeolocationPositionError),
    } as unknown as Geolocation;
    await expect(requestPosition({ geolocation: denied, secure: true })).rejects.toMatchObject({ kind: 'denied' });
    await expect(requestPosition({ geolocation: denied, secure: false })).rejects.toMatchObject({ kind: 'insecure' });
    await expect(requestPosition({ geolocation: null, secure: true })).rejects.toBeInstanceOf(GeoError);
    await expect(requestPosition({ geolocation: null, secure: true })).rejects.toMatchObject({ kind: 'unsupported' });
  });
});

describe('map helpers', () => {
  it('keeps the view bounds around the domain', () => {
    expect(isInMapView(139.47, 35.31)).toBe(true);
    expect(isInMapView(140.03, 42.67)).toBe(false);
    const [[w, s], [e, n]] = MAP_VIEW_BOUNDS;
    expect(w).toBeLessThan(DOMAIN_BOUNDS.west);
    expect(s).toBeLessThan(DOMAIN_BOUNDS.south);
    expect(e).toBeGreaterThan(DOMAIN_BOUNDS.east);
    expect(n).toBeGreaterThan(DOMAIN_BOUNDS.north);
  });

  it('zooms out on narrow screens', () => {
    expect(domainZoomForWidth(1200)).toBe(INITIAL_ZOOM);
    expect(domainZoomForWidth(400)).toBeCloseTo(INITIAL_ZOOM - 1, 6);
    expect(domainZoomForWidth(0)).toBe(INITIAL_ZOOM);
  });

  it('draws an accuracy circle with the given radius', () => {
    const ring = circleRing(139.47, 35.32, 250, 32);
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[32]);
    for (const [lon, lat] of ring) {
      expect(distanceMeters({ lon: 139.47, lat: 35.32 }, { lon, lat })).toBeCloseTo(250, 0);
    }
  });
});
