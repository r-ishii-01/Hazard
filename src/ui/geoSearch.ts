/**
 * 地名・住所の検索と、人物の場所の住所の目安（国土地理院の地名検索 API・逆ジオコーダー）。
 * 応答の検査・並べ替え・表示用の文字列づくりと通信だけを持ち、DOM には依存しない（単体テストできる）。
 *
 * - 地名検索 API: https://msearch.gsi.go.jp/address-search/AddressSearch?q=<文字列>
 *   応答は GeoJSON の Feature の配列（FeatureCollection ではない）。
 *   properties: { title: 名称, addressCode: 市区町村コード（5桁。住所の結果は空文字）, dataSource?: 種別 }。
 *   dataSource が無いものは住所（東京大学 CSIS「シンプルジオコーディング実験」による。title に都道府県・市区町村を含む）、
 *   "5" は居住地名（町・丁目）、それ以外（"1" 駅・"3" 施設・"4" 自然地名など）は居住地名以外（地理院地図の絞り込みの区分）。
 * - 逆ジオコーダー: https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=..&lon=..
 *   応答は { results: { muniCd: 市区町村コード, lv01Nm: 町字名 } }。海の上などでは {}。
 * - どちらも CORS に対応（Access-Control-Allow-Origin: *。2026年9月に確認）。
 * - 地理院地図のための「サーバ側動的機能」で、国土地理院は「主に地理院地図からの利用を想定しているため、
 *   必ずしも常にまた長期的に提供できるとは限らない」「仕様や利用方法は予告なく変更する場合がある」としている
 *   （https://github.com/gsi-cyberjapan/gsimaps の README）。失敗しても本体の機能は使えるようにする。
 * - 駅・施設などの位置は地図の注記（文字）の位置のことがあり、実物から数百m離れる場合がある
 *   （例: 片瀬江ノ島駅・湘南海岸公園駅は約400〜450m西。data/poi.ts の確認結果）。このサイトで位置を確かめた地点
 *   （data/poi.ts）と同じ名称の結果は、その位置に置き換える（snapToKnownPlaces）。
 * - 出典: 地理院地図の検索結果の表示にならい「国土地理院 地名検索API（協力：東大CSIS）」と表示する。
 *   逆ジオコーダーの結果は「国土地理院 逆ジオコーダー」と表示する。
 */
import { DOMAIN_BOUNDS, distanceMeters, lonLatToCell, type GridSpec, type LonLatBounds } from '../core/geo';
import { CELL_SEA } from '../core/types';
import { POIS } from '../data/poi';
import { isInMapView } from '../map2d/geo2d';

export const GSI_SEARCH_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch';
export const GSI_REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
/** 地名検索の出典表示 */
export const GSI_SEARCH_CREDIT = '国土地理院 地名検索API';
export const GSI_REVERSE_CREDIT = '国土地理院 逆ジオコーダー';
/** 地理院地図の API の説明・注意書き（gsimaps の README） */
export const GSI_MAPS_API_NOTE_URL = 'https://github.com/gsi-cyberjapan/gsimaps';
/** 地名検索の協力: 東京大学空間情報科学研究センター「シンプルジオコーディング実験」 */
export const CSIS_CREDIT = '東大CSIS';
export const CSIS_URL = 'https://geocode.csis.u-tokyo.ac.jp/home/simple-geocoding/';
/** 国土地理院コンテンツ利用規約 */
export const GSI_TERMS_URL = 'https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html';
/** 検索・逆ジオコーダーの提供についての注意（画面表示用） */
export const GSI_API_NOTICE = '地理院地図のための機能を利用しています。提供の継続や仕様は保証されていません。';

/** 自動で検索を始める最小の文字数（Enter なら 1 文字でも検索する） */
export const MIN_QUERY_LENGTH = 2;
/** 入力欄の最大文字数 */
export const MAX_QUERY_LENGTH = 64;
/** 一覧に出す件数の上限 */
export const MAX_RESULTS = 30;
/** 応答から読む件数の上限（「駅」などは 1 万件を超える） */
const MAX_PARSE = 20000;
/** 表示する名称の最大文字数 */
const MAX_TITLE_LENGTH = 80;

// ---------------------------------------------------------------------------
// 文字列
// ---------------------------------------------------------------------------

/** 制御文字・書字方向の制御文字を除き、空白をまとめ、長さを制限する（外部の文字列を画面に出す前に） */
export function cleanText(v: unknown, maxLength = MAX_TITLE_LENGTH): string {
  if (typeof v !== 'string') return '';
  const s = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/[\s　]+/g, ' ')
    .trim();
  return s.length > maxLength ? `${s.slice(0, maxLength - 1)}…` : s;
}

/** 検索語を整える（前後の空白・連続する空白・制御文字、長すぎる入力） */
export function normalizeQuery(q: string): string {
  return cleanText(q, MAX_QUERY_LENGTH + 1).slice(0, MAX_QUERY_LENGTH).trim();
}

// ---------------------------------------------------------------------------
// 市区町村コード
// ---------------------------------------------------------------------------

/** 都道府県コード（JIS X 0401）→ 名称 */
export const PREFECTURES: readonly string[] = [
  '',
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

/**
 * 神奈川県の市区町村コード（全国地方公共団体コードの上5桁）→ 名称。
 * 地理院地図の市区町村の一覧（https://maps.gsi.go.jp/js/muni.js）と照合（2026年9月）。
 * 計算範囲は藤沢市・鎌倉市（腰越）にまたがり、検索結果の多くは周辺の市町なので、神奈川県だけ市区町村名まで出す。
 */
export const KANAGAWA_MUNICIPALITIES: Readonly<Record<string, string>> = {
  '14100': '横浜市', '14101': '横浜市鶴見区', '14102': '横浜市神奈川区', '14103': '横浜市西区', '14104': '横浜市中区',
  '14105': '横浜市南区', '14106': '横浜市保土ケ谷区', '14107': '横浜市磯子区', '14108': '横浜市金沢区', '14109': '横浜市港北区',
  '14110': '横浜市戸塚区', '14111': '横浜市港南区', '14112': '横浜市旭区', '14113': '横浜市緑区', '14114': '横浜市瀬谷区',
  '14115': '横浜市栄区', '14116': '横浜市泉区', '14117': '横浜市青葉区', '14118': '横浜市都筑区',
  '14130': '川崎市', '14131': '川崎市川崎区', '14132': '川崎市幸区', '14133': '川崎市中原区', '14134': '川崎市高津区',
  '14135': '川崎市多摩区', '14136': '川崎市宮前区', '14137': '川崎市麻生区',
  '14150': '相模原市', '14151': '相模原市緑区', '14152': '相模原市中央区', '14153': '相模原市南区',
  '14201': '横須賀市', '14203': '平塚市', '14204': '鎌倉市', '14205': '藤沢市', '14206': '小田原市', '14207': '茅ヶ崎市',
  '14208': '逗子市', '14210': '三浦市', '14211': '秦野市', '14212': '厚木市', '14213': '大和市', '14214': '伊勢原市',
  '14215': '海老名市', '14216': '座間市', '14217': '南足柄市', '14218': '綾瀬市',
  '14301': '葉山町', '14321': '寒川町', '14341': '大磯町', '14342': '二宮町', '14361': '中井町', '14362': '大井町',
  '14363': '松田町', '14364': '山北町', '14366': '開成町', '14382': '箱根町', '14383': '真鶴町', '14384': '湯河原町',
  '14401': '愛川町', '14402': '清川村',
};

/** 市区町村コードを 5 桁の文字列に（北海道は先頭の 0 が落ちて 4 桁で届くことがある）。不正なら null */
export function normalizeMuniCode(code: unknown): string | null {
  const s = typeof code === 'number' ? String(Math.trunc(code)) : typeof code === 'string' ? code.trim() : '';
  if (!/^\d{4,5}$/.test(s)) return null;
  const c = s.padStart(5, '0');
  const pref = Number(c.slice(0, 2));
  return pref >= 1 && pref <= 47 ? c : null;
}

/** 市区町村コード → { 都道府県, 市区町村（神奈川県のみ） }。不明なら null */
export function municipalityOf(code: unknown): { prefecture: string; municipality: string | null } | null {
  const c = normalizeMuniCode(code);
  if (!c) return null;
  return { prefecture: PREFECTURES[Number(c.slice(0, 2))], municipality: KANAGAWA_MUNICIPALITIES[c] ?? null };
}

/** 市区町村コード → 「神奈川県藤沢市」「北海道」（不明なら ''） */
export function areaLabel(code: unknown): string {
  const m = municipalityOf(code);
  if (!m) return '';
  return `${m.prefecture}${m.municipality ?? ''}`;
}

// ---------------------------------------------------------------------------
// 位置
// ---------------------------------------------------------------------------

export function isInsideBounds(lon: number, lat: number, b: LonLatBounds = DOMAIN_BOUNDS): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

/** 計算範囲（の長方形）までの距離 [m]。内側は 0 */
export function distanceToDomain(lon: number, lat: number, b: LonLatBounds = DOMAIN_BOUNDS): number {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return Infinity;
  if (isInsideBounds(lon, lat, b)) return 0;
  const cl = Math.min(b.east, Math.max(b.west, lon));
  const ct = Math.min(b.north, Math.max(b.south, lat));
  return distanceMeters({ lon, lat }, { lon: cl, lat: ct });
}

/**
 * その地点に人物を置けるか。置けなければ理由（'outside': 計算格子の外、'sea': 海・川のセル）。
 * kind は地形のセル種別（地形の読み込み前は null。そのときは範囲だけを確かめる）。
 */
export function placementProblem(spec: GridSpec, kind: Uint8Array | null, lon: number, lat: number): 'outside' | 'sea' | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return 'outside';
  const cell = lonLatToCell(spec, lon, lat);
  if (!cell) return 'outside';
  if (kind && kind.length === spec.nx * spec.ny && kind[cell.k] === CELL_SEA) return 'sea';
  return null;
}

/** 距離の目安（「約 850 m」「約 12 km」「約 830 km」） */
export function formatApproxDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `約 ${Math.max(10, Math.round(m / 10) * 10)} m`;
  if (m < 10_000) return `約 ${(m / 1000).toFixed(1)} km`;
  return `約 ${Math.round(m / 1000).toLocaleString('ja-JP')} km`;
}

// ---------------------------------------------------------------------------
// 地名検索の応答
// ---------------------------------------------------------------------------

/** 検索結果の種別: 住所（CSIS） / 町・丁目（居住地名） / それ以外の地名（駅・施設・自然地名など） */
export type PlaceKind = 'address' | 'town' | 'place';

export interface PlaceResult {
  /** 一覧の中で一意な ID（DOM の id に使える文字だけ） */
  id: string;
  /** 名称（制御文字を除いたもの。画面には textContent で出す） */
  title: string;
  lon: number;
  lat: number;
  /** 市区町村コード（住所の結果など、無ければ null） */
  muniCode: string | null;
  /** 「神奈川県藤沢市」など（分からなければ ''） */
  area: string;
  kind: PlaceKind;
  /** 計算範囲の内側か */
  inside: boolean;
  /** 計算範囲までの距離 [m]（内側は 0） */
  distanceM: number;
  /** 2D 地図の表示範囲に入るか */
  viewable: boolean;
  /** このサイトで確かめた位置（data/poi.ts）に置き換えたとき、元の位置からの距離 [m] */
  adjustedM?: number;
}

function kindOf(dataSource: unknown): PlaceKind {
  if (dataSource === undefined || dataSource === null || dataSource === '') return 'address';
  return String(dataSource) === '5' ? 'town' : 'place';
}

/**
 * 地名検索 API の応答を検査して PlaceResult の配列にする（並べ替えはしない）。
 * 形の合わない要素・座標が数でないもの・名称の無いものは捨てる。同じ名称でほぼ同じ位置（約 10 m 以内）のものは 1 つにまとめる。
 */
export function parseSearchResponse(data: unknown, bounds: LonLatBounds = DOMAIN_BOUNDS): PlaceResult[] {
  if (!Array.isArray(data)) return [];
  const out: PlaceResult[] = [];
  const seen = new Set<string>();
  const n = Math.min(data.length, MAX_PARSE);
  for (let i = 0; i < n; i++) {
    const f = data[i] as { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> } | null;
    if (!f || typeof f !== 'object') continue;
    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    const props = f.properties ?? {};
    const title = cleanText(props.title);
    if (!title) continue;
    const key = `${title}|${lon.toFixed(4)}|${lat.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const muniCode = normalizeMuniCode(props.addressCode);
    const distanceM = distanceToDomain(lon, lat, bounds);
    out.push({
      id: `place-${out.length}`,
      title,
      lon,
      lat,
      muniCode,
      area: areaLabel(muniCode),
      kind: kindOf(props.dataSource),
      inside: distanceM === 0,
      distanceM,
      viewable: isInMapView(lon, lat),
    });
  }
  return out;
}

/** 位置を確かめた地点（名称と位置） */
export interface KnownPlace {
  name: string;
  lon: number;
  lat: number;
}

/** このサイトで位置を確かめた地点（data/poi.ts の駅・施設・公園） */
export const KNOWN_PLACES: readonly KnownPlace[] = POIS.filter((p) => p.kind !== 'river');

/**
 * 地名検索の結果のうち、位置を確かめた地点と同じ名称で近い（50 m〜maxM）ものは、その位置に置き換える
 * （地名検索の駅の位置は地図の注記の位置で、実物から数百m離れることがあるため）。
 */
export function snapToKnownPlaces(results: PlaceResult[], known: readonly KnownPlace[] = KNOWN_PLACES, maxM = 2000, bounds: LonLatBounds = DOMAIN_BOUNDS): PlaceResult[] {
  return results.map((r) => {
    const k = known.find((p) => p.name === r.title);
    if (!k) return r;
    const d = distanceMeters(r, k);
    // 別の場所の同名の地点（maxM より遠い）と、差が小さい（50 m 未満）ものはそのまま
    if (!(d <= maxM) || d < 50) return r;
    const distanceM = distanceToDomain(k.lon, k.lat, bounds);
    return { ...r, lon: k.lon, lat: k.lat, distanceM, inside: distanceM === 0, viewable: isInMapView(k.lon, k.lat), adjustedM: d };
  });
}

/**
 * 表示順: 計算範囲の内側を先に（その中は、検索語と名称が一致するものを先に、あとは API の順）、
 * 外側は計算範囲に近い順。上限件数で切り、ID を振り直す。
 */
export function sortResults(results: PlaceResult[], limit = MAX_RESULTS, query = ''): PlaceResult[] {
  const q = normalizeQuery(query);
  const indexed = results.map((r, i) => ({ r, i, exact: !!q && r.title === q }));
  indexed.sort((a, b) => {
    if (a.r.inside !== b.r.inside) return a.r.inside ? -1 : 1;
    if (a.r.inside && a.exact !== b.exact) return a.exact ? -1 : 1;
    if (!a.r.inside && a.r.distanceM !== b.r.distanceM) return a.r.distanceM - b.r.distanceM;
    return a.i - b.i;
  });
  return indexed.slice(0, Math.max(0, limit)).map(({ r }, i) => ({ ...r, id: `place-${i}` }));
}

/** 検索結果の 2 行目（「神奈川県藤沢市」「住所」など） */
export function describeResult(r: PlaceResult): string {
  if (r.kind === 'address') return '住所';
  return r.area;
}

/** 位置についての注意（画面表示用。無ければ null） */
export function positionNote(r: Pick<PlaceResult, 'kind' | 'adjustedM'>): string | null {
  if (r.adjustedM !== undefined) {
    return `位置は、このサイトで確かめた位置に合わせました（地名検索の位置は地図の文字の位置で、${formatApproxDistance(r.adjustedM)}ずれています）。`;
  }
  if (r.kind === 'place') return '駅・施設などの位置は地図の文字（注記）の位置のことがあり、実際の場所から数百m離れる場合があります。';
  return null;
}

/** 計算範囲との関係のバッジ（内側は null） */
export function outsideBadge(r: Pick<PlaceResult, 'inside' | 'distanceM'>): string | null {
  if (r.inside) return null;
  return `計算範囲外・${formatApproxDistance(r.distanceM)}`;
}

// ---------------------------------------------------------------------------
// 逆ジオコーダーの応答
// ---------------------------------------------------------------------------

export interface ReverseResult {
  muniCode: string | null;
  /** 「藤沢市」（神奈川県外は都道府県名、不明なら null） */
  municipality: string | null;
  /** 町字名（例:「鵠沼海岸二丁目」。無ければ null） */
  town: string | null;
  /** 表示用（例:「藤沢市鵠沼海岸二丁目」） */
  label: string;
}

/** 逆ジオコーダーの応答を検査する。住所が得られない（海の上など）・形が合わない場合は null */
export function parseReverseResponse(data: unknown): ReverseResult | null {
  const res = (data as { results?: unknown } | null)?.results;
  if (!res || typeof res !== 'object') return null;
  const r = res as Record<string, unknown>;
  const muniCode = normalizeMuniCode(r.muniCd);
  const m = municipalityOf(muniCode);
  const municipality = m ? m.municipality ?? m.prefecture : null;
  let town: string | null = cleanText(r.lv01Nm, 40);
  // 町字が無い場所は「－」などが返る
  if (!town || /^[-－ー—‐]+$/.test(town)) town = null;
  const label = `${municipality ?? ''}${town ?? ''}`;
  if (!label) return null;
  return { muniCode, municipality, town, label };
}

// ---------------------------------------------------------------------------
// 通信
// ---------------------------------------------------------------------------

/** fetch の最小限の形（テストで差し替える） */
export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; credentials?: RequestCredentials; mode?: RequestMode; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** 検索の URL（検索語は URL エンコード） */
export function searchUrl(query: string): string {
  return `${GSI_SEARCH_URL}?q=${encodeURIComponent(query)}`;
}

/** 逆ジオコーダーの URL（座標は小数 5 桁 ≒ 1 m に丸める） */
export function reverseUrl(lon: number, lat: number): string {
  return `${GSI_REVERSE_URL}?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
}

/** 地名・住所を検索する（失敗時は例外。中止は AbortError） */
export async function searchPlaces(query: string, opts: { signal?: AbortSignal; fetchFn?: FetchLike } = {}): Promise<PlaceResult[]> {
  const q = normalizeQuery(query);
  if (!q) return [];
  const res = await (opts.fetchFn ?? defaultFetch)(searchUrl(q), { signal: opts.signal, credentials: 'omit', mode: 'cors' });
  if (!res.ok) throw new HttpError(res.status);
  return sortResults(snapToKnownPlaces(parseSearchResponse(await res.json())), MAX_RESULTS, q);
}

/** 住所の目安を調べる（得られなければ null。通信の失敗は例外） */
export async function reverseGeocode(lon: number, lat: number, opts: { signal?: AbortSignal; fetchFn?: FetchLike } = {}): Promise<ReverseResult | null> {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const res = await (opts.fetchFn ?? defaultFetch)(reverseUrl(lon, lat), { signal: opts.signal, credentials: 'omit', mode: 'cors' });
  if (!res.ok) throw new HttpError(res.status);
  return parseReverseResponse(await res.json());
}

/** 大きさを限った入れ物（古いものから捨てる） */
export class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** 逆ジオコーダーのキャッシュのキー（約 10 m 単位） */
export function reverseCacheKey(lon: number, lat: number): string {
  return `${lon.toFixed(4)},${lat.toFixed(4)}`;
}
