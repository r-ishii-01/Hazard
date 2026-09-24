/**
 * 避難場所の読み込み。
 *
 * 国土地理院「指定緊急避難場所データ」の津波版（地理院タイル skhb05、GeoJSON タイル）を
 * ブラウザから取得し、計算範囲（DOMAIN_BOUNDS）内の点を Shelter に変換する。
 *
 * - 出典・説明: https://www.gsi.go.jp/bousaichiri/hinanbasho.html
 * - タイル一覧（cyberjapandata.gsi.go.jp/xyz/skhb0N/…）: https://maps.gsi.go.jp/development/ichiran.html
 * - 地理院地図のレイヤー定義（skhb05「指定緊急避難場所（津波）」,
 *   url=https://maps.gsi.go.jp/xyz/skhb05/{z}/{x}/{y}.geojson, maxNativeZoom=10 … データはズーム10のタイルでのみ提供）:
 *   https://github.com/gsi-cyberjapan/gsimaps/blob/gh-pages/layers_txt/layers5.txt
 *   （skhb01=洪水, 02=崖崩れ・土石流・地滑り, 03=高潮, 04=地震, 05=津波, 06=大規模な火事, 07=内水氾濫, 08=火山現象）
 * - タイルの属性名: name / address / remarks / disaster1〜8（災害種別の指定。1=指定）。国土地理院の公式な仕様書は
 *   見つけられなかったため、タイルを実際に読んでいる公開コードで確認した
 *   （例: https://github.com/kenzkenz/open-hinata/blob/master/src/js/popup.js の hinanzyo05 ）。
 *   全国データ（下記）の日本語の属性名も受け付ける。
 *
 * 取得できない場合（オフライン・CORS・仕様変更など）は、同じ国土地理院データから抜き出した
 * 内蔵の写し（BUILTIN_TSUNAMI_SHELTERS）を返す。座標を推測で補うことはしない。
 *
 * 注意: 藤沢市が独自に指定している「津波避難ビル」の多く（市の一覧:
 * https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/bosai/tunamihinanbiruichiran.html ）は
 * このデータに含まれていない。実際の避難先は必ず市のハザードマップ等で確認すること。
 */
import { DOMAIN_BOUNDS, TILE_SIZE, lonLatToPixel } from '../core/geo';
import type { Shelter, ShelterKind } from '../core/types';

export const SHELTER_SOURCE_LABEL = '国土地理院 指定緊急避難場所データ（津波）';
export const SHELTER_SOURCE_URL = 'https://www.gsi.go.jp/bousaichiri/hinanbasho.html';
export const SHELTER_BUILTIN_SOURCE_LABEL = '国土地理院 指定緊急避難場所データ（津波）※内蔵の写し（2026年8月時点）';

/**
 * 藤沢市「津波避難ビル」（市が独自に指定している津波避難ビルの一覧。2025年12月18日更新の PDF で市全体 141 件）。
 * ページの題名「津波避難ビル｜藤沢市」を 2026-09-24 に確認。
 */
export const FUJISAWA_TSUNAMI_BUILDING_URL = 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/bosai/tunamihinanbiruichiran.html';
export const FUJISAWA_TSUNAMI_BUILDING_LABEL = '藤沢市「津波避難ビル」一覧';

/**
 * 指定緊急避難場所データの「ご利用上の注意」（地理院タイル一覧 https://maps.gsi.go.jp/development/ichiran.html の
 * 指定緊急避難場所の備考。原文は docs/DATA_SOURCES.md 5 章）の要点。
 * 注意 4.「本データを用いた情報を第三者に提供する場合は、上記1．～3．の注意事項が正確に伝わるよう、十分にご留意ください。」
 * に従い、避難場所を表示する画面（出典の欄・人物の避難先）で伝える:
 *   1. 市町村が指定・登録した情報で、最新でない場合や未掲載の場合がある → 最新の情報は市町村（藤沢市）で確認
 *   2. 「指定緊急避難場所」と「指定避難所」は違う。指定緊急避難場所は災害の種類ごとに指定されている
 *   3. 随時更新される（画面の避難場所は取得した時点のもの）
 */
export const SHELTER_USAGE_NOTICE =
  '表示しているのは、市町村が指定して国土地理院に登録した「指定緊急避難場所」のうち津波に対応するもので、避難生活のための「指定避難所」とは別のものです。' +
  'データは随時更新され、最新でない場合や掲載されていない場合があります。最新の情報は藤沢市で確認してください。';

/** 藤沢市の津波避難ビルがこのデータにほとんど含まれないこと（docs/DATA_SOURCES.md 5 章: 計算範囲の 7 か所と重なるのは 5 件だけ） */
export const SHELTER_BUILDING_NOTE =
  '藤沢市が独自に指定している津波避難ビルの多くは、このデータに含まれていません。人物の「最寄りの避難場所へ」の経路は、近くに津波避難ビルがあっても、このデータの避難場所へ向かいます。';

/** GeoJSON タイルの URL テンプレート（先頭から順に試す） */
export const SHELTER_TILE_URLS = [
  'https://cyberjapandata.gsi.go.jp/xyz/skhb05/{z}/{x}/{y}.geojson',
  'https://maps.gsi.go.jp/xyz/skhb05/{z}/{x}/{y}.geojson',
] as const;

/** データが提供されているズーム（地理院地図の maxNativeZoom） */
export const SHELTER_TILE_ZOOM = 10;

/** 1回の取得のタイムアウト [ms] */
const FETCH_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// 内蔵の写し
// ---------------------------------------------------------------------------

/**
 * 通信できない場合に使う、計算範囲内の指定緊急避難場所（津波）。
 * 国土地理院が公開している全国データ（指定緊急避難場所データ GeoJSON:
 * https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/geoJSON/mergeFromCity_2.geojson ）のうち、
 * 「津波」が指定（"1"）されている点を抜き出したもの（2026年8月24日更新版の写し。
 * GitHub 上のミラー https://github.com/iwstkhr/shelter-map の public/assets から取得して確認）。
 * 名称・住所・座標はデータのまま。指定状況は変わることがあるため、最新の情報は国土地理院・藤沢市で確認すること。
 */
export const BUILTIN_TSUNAMI_SHELTERS: readonly Shelter[] = [
  {
    id: 'gsi-E1420500028202',
    name: '江の島サムエル・コッキング苑（亀ヶ岡広場含む）',
    address: '神奈川県藤沢市江の島2-3-28',
    lon: 139.479297,
    lat: 35.299693,
    kind: 'evac-site',
    source: SHELTER_BUILTIN_SOURCE_LABEL,
  },
  {
    id: 'gsi-E1420500037201',
    name: '市営鵠沼住宅',
    address: '神奈川県藤沢市鵠沼海岸4-12',
    lon: 139.462205,
    lat: 35.318504,
    kind: 'evac-site',
    source: SHELTER_BUILTIN_SOURCE_LABEL,
  },
  {
    id: 'gsi-E1420500045201',
    name: '湘南学園中学校・高等学校',
    address: '神奈川県藤沢市鵠沼松が岡4-1-32',
    lon: 139.477723,
    lat: 35.323617,
    kind: 'evac-site',
    source: SHELTER_BUILTIN_SOURCE_LABEL,
  },
  {
    id: 'gsi-E1420500099201',
    name: '高砂小学校',
    address: '神奈川県藤沢市辻堂西海岸1-3-1',
    lon: 139.448686,
    lat: 35.325847,
    kind: 'evac-site',
    source: SHELTER_BUILTIN_SOURCE_LABEL,
  },
  {
    id: 'gsi-E1420500105201',
    name: '湘洋中学校',
    address: '神奈川県藤沢市辻堂東海岸4-17-1',
    lon: 139.458851,
    lat: 35.319184,
    kind: 'evac-site',
    source: SHELTER_BUILTIN_SOURCE_LABEL,
  },
  {
    id: 'gsi-E1420500109201',
    name: '片瀬小学校',
    address: '神奈川県藤沢市片瀬2-14-29',
    lon: 139.487623,
    lat: 35.319606,
    kind: 'evac-site',
    source: SHELTER_BUILTIN_SOURCE_LABEL,
  },
  {
    id: 'gsi-E1420500110201',
    name: '片瀬山公園',
    address: '神奈川県藤沢市片瀬3-12',
    lon: 139.490255,
    lat: 35.313292,
    kind: 'evac-site',
    source: SHELTER_BUILTIN_SOURCE_LABEL,
  },
];

// ---------------------------------------------------------------------------
// GeoJSON の解析
// ---------------------------------------------------------------------------

/**
 * 属性名の候補。国土地理院の全国データ（上記 mergeFromCity_2.geojson）の属性名
 * （NO, 共通ID, 都道府県名及び市町村名, 施設・場所名, 住所, 洪水, …, 津波, …, 備考）を第一候補とし、
 * 地理院タイルで属性名が異なる場合に備えて一般的な別名も受け付ける。
 */
const NAME_KEYS = ['施設・場所名', '名称', '施設名', '避難場所名', 'name', 'NAME'];
const ADDRESS_KEYS = ['住所', '所在地', 'address', 'ADDRESS'];
const ID_KEYS = ['共通ID', 'ID', 'id'];
const REMARK_KEYS = ['備考', 'remarks', 'note'];
/** 津波の指定フラグ（全国データは「津波」、地理院タイルは disaster5） */
const TSUNAMI_KEYS = ['津波', 'disaster5', 'tsunami'];

function pickString(props: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = props[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** 候補名に一致する属性がない場合、属性名に語を含む文字列属性を探す（形式変更への備え） */
function pickByKeyword(props: Record<string, unknown>, include: RegExp, exclude?: RegExp): string | undefined {
  for (const [key, v] of Object.entries(props)) {
    if (!include.test(key) || (exclude && exclude.test(key))) continue;
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/** 災害種別の指定フラグ（"1"・1・"○" 等）を真偽値に */
function isFlagOn(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['1', '○', '◯', '〇', 'true', 'TRUE'].includes(v.trim());
  return false;
}

/**
 * 津波避難ビル（津波避難タワー等の人工構造物を含む）と明示されているか。
 * 国土地理院の指定緊急避難場所データには施設の種別（建物・高台など）を区別する属性がないため、
 * 名称・備考に「津波避難ビル」「津波避難タワー」「津波避難施設」と書かれている場合に限って true とする。
 */
export function isTsunamiEvacBuilding(info: { name?: string; remarks?: string }): boolean {
  const text = `${info.name ?? ''} ${info.remarks ?? ''}`;
  return /津波避難(ビル|タワー|施設)/.test(text);
}

export interface ParseShelterOptions {
  /** この範囲内の点だけ残す（省略時 DOMAIN_BOUNDS） */
  bounds?: { west: number; east: number; south: number; north: number };
  /** Shelter.source に入れる出典表記 */
  source?: string;
}

/**
 * 指定緊急避難場所（津波）の GeoJSON（FeatureCollection）を Shelter[] に変換する。
 * 点以外の図形・座標が不正なもの・範囲外のもの・「津波」の指定がないと明示されたものは除く。
 */
export function parseShelterGeoJSON(json: unknown, opts: ParseShelterOptions = {}): Shelter[] {
  const bounds = opts.bounds ?? DOMAIN_BOUNDS;
  const source = opts.source ?? SHELTER_SOURCE_LABEL;
  if (!json || typeof json !== 'object') return [];
  const features = (json as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const out: Shelter[] = [];
  for (const f of features) {
    if (!f || typeof f !== 'object') continue;
    const geom = (f as { geometry?: unknown }).geometry as { type?: unknown; coordinates?: unknown } | null | undefined;
    if (!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates)) continue;
    const [lon, lat] = geom.coordinates as unknown[];
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < bounds.west || lon > bounds.east || lat < bounds.south || lat > bounds.north) continue;
    const rawProps = (f as { properties?: unknown }).properties;
    const props = rawProps && typeof rawProps === 'object' ? (rawProps as Record<string, unknown>) : {};
    // 津波の指定フラグがある形式（全国データ）では、指定のない点を除く。skhb05 タイルは津波の指定のみを含む
    const tsunamiKey = TSUNAMI_KEYS.find((k) => k in props);
    if (tsunamiKey && !isFlagOn(props[tsunamiKey])) continue;
    const name =
      pickString(props, NAME_KEYS) ?? pickByKeyword(props, /名称|場所名|施設名/, /都道府県|市町村/) ?? '指定緊急避難場所（名称不明）';
    const address = pickString(props, ADDRESS_KEYS) ?? pickByKeyword(props, /住所|所在/);
    const remarks = pickString(props, REMARK_KEYS);
    const rawId = pickString(props, ID_KEYS);
    const id = rawId ? `gsi-${rawId}` : `gsi-${lon.toFixed(6)},${lat.toFixed(6)}`;
    const kind: ShelterKind = isTsunamiEvacBuilding({ name, remarks }) ? 'tsunami-building' : 'evac-site';
    const shelter: Shelter = { id, name, lon, lat, kind, source };
    if (address) shelter.address = address;
    out.push(shelter);
  }
  return out;
}

/** 同じ ID（または同じ座標・名称）の重複を除く */
function dedupe(list: Shelter[]): Shelter[] {
  const seen = new Set<string>();
  const out: Shelter[] = [];
  for (const s of list) {
    const key = s.id;
    const key2 = `${s.name}@${s.lon.toFixed(6)},${s.lat.toFixed(6)}`;
    if (seen.has(key) || seen.has(key2)) continue;
    seen.add(key);
    seen.add(key2);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

/** 範囲を覆うタイル座標（両端含む） */
export function shelterTilesForBounds(
  bounds: { west: number; east: number; south: number; north: number } = DOMAIN_BOUNDS,
  zoom = SHELTER_TILE_ZOOM,
): { z: number; x: number; y: number }[] {
  const nw = lonLatToPixel(bounds.west, bounds.north, zoom);
  const se = lonLatToPixel(bounds.east, bounds.south, zoom);
  const x0 = Math.floor(nw.x / TILE_SIZE);
  const y0 = Math.floor(nw.y / TILE_SIZE);
  const x1 = Math.floor(se.x / TILE_SIZE);
  const y1 = Math.floor(se.y / TILE_SIZE);
  const tiles: { z: number; x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z: zoom, x, y });
  return tiles;
}

function tileUrl(template: string, t: { z: number; x: number; y: number }): string {
  return template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
}

/** 呼び出し元の signal とタイムアウトを合わせた AbortController */
function linkedAbort(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const onAbort = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function fetchTileJson(t: { z: number; x: number; y: number }, signal?: AbortSignal): Promise<unknown> {
  let lastError: unknown = null;
  for (const template of SHELTER_TILE_URLS) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const link = linkedAbort(signal, FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(tileUrl(template, t), { signal: link.signal, mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e;
    } finally {
      link.dispose();
    }
  }
  throw lastError ?? new Error('fetch failed');
}

export type ShelterLoadOrigin = 'gsi' | 'builtin';

export interface ShelterLoadResult {
  shelters: Shelter[];
  origin: ShelterLoadOrigin;
  /** 画面表示用の説明（日本語） */
  message: string;
}

/** 内蔵の写しのコピー（呼び出し側で変更されても元データが変わらないように） */
function builtinShelters(): Shelter[] {
  return BUILTIN_TSUNAMI_SHELTERS.map((s) => ({ ...s }));
}

/**
 * 避難場所を読み込み、どこから得たかの説明も返す。失敗しても例外は投げず内蔵の写しを返す
 * （呼び出し元の signal で中止された場合のみ AbortError を投げる）。
 */
export async function loadSheltersDetailed(opts: { signal?: AbortSignal } = {}): Promise<ShelterLoadResult> {
  const { signal } = opts;
  const tiles = shelterTilesForBounds();
  try {
    const jsons = await Promise.all(tiles.map((t) => fetchTileJson(t, signal)));
    const list = dedupe(jsons.flatMap((j) => parseShelterGeoJSON(j)));
    if (list.length > 0) {
      return { shelters: list, origin: 'gsi', message: `${SHELTER_SOURCE_LABEL}を取得しました（${list.length}か所）` };
    }
    // 取得できたが範囲内に1件もない → 形式の変更などが疑われるので内蔵の写しを使う
    console.warn('[shelters] 取得したデータに範囲内の避難場所がありません。内蔵データを使います');
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('[shelters] 指定緊急避難場所データを取得できませんでした。内蔵データを使います', e);
  }
  const shelters = builtinShelters();
  return {
    shelters,
    origin: 'builtin',
    message: `国土地理院のサーバーから避難場所データを取得できなかったため、内蔵の写し（2026年8月時点・${shelters.length}か所）を表示しています`,
  };
}

/**
 * 避難場所（津波）を読み込む。失敗時は内蔵の写し（国土地理院データから抜き出した確認済みの点）を返す。
 */
export async function loadShelters(opts: { signal?: AbortSignal } = {}): Promise<Shelter[]> {
  return (await loadSheltersDetailed(opts)).shelters;
}
