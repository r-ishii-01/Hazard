/**
 * 公式の津波浸水想定（神奈川県の津波浸水想定（平成27年）。ハザードマップポータルサイトの配信タイル
 * 04_tsunami_newlegend_data）を、画素・計算セルごとの「浸水深の階級」として扱う（純粋関数）。
 * 読み込みは officialHazardLoad.ts。地図への重ね表示は map2d / view3d が配信元のタイルを直接使う。
 *
 * 使いみち（人物の評価）:
 * - 最寄りの高台の候補から、公式の浸水想定区域（とその周囲）のセルを除く（people/gridctx.ts）。
 *   このサイトの計算は公式の想定より浸水が狭く浅めに出る（docs/MODEL.md 4.13.5: 同じ相模トラフ西側モデルの
 *   県の予測図と比べても、予測図の浸水域の約83%しか覆わず、両方で浸水したセルの約41%で浅い階級）ので、
 *   計算だけで「浸水しない高台」と示すと、公式の想定では浸水する場所を安全な場所として示してしまう。
 * - 人物の出発地点・避難先が、公式の想定で何mの区域かを示す（ui/panels/people.ts）。
 *
 * タイルの画素の色は、凡例（DEPTH_CLASSES）の8色のいずれかと完全に一致する
 * （計算範囲を覆う z15 の実タイル 17 枚の不透明な画素 345,236 個がすべて一致することを 2026-09-24 に確認。sources.ts の注記も参照）。
 * 一致しない色は「不明」とし、推測で階級を当てはめない。
 *
 * 出典: 「ハザードマップポータルサイト」（津波浸水想定：神奈川県）。オープンデータ（公共データ利用規約 第1.0版）。
 * 色を読み替えて判定に使うので、画面では HAZARD_PROCESSED_CREDIT（「…を加工して作成」）を併記する。
 */
import { BASE_ZOOM, TILE_SIZE, createGridSpec, gridTileRange, lonLatToPixel, type GridSpec } from '../core/geo';
import type { OfficialInundationData } from '../core/types';
import { DEPTH_CLASSES, HAZARD_TSUNAMI_TILES, depthClassFromRgb, type DepthClass } from './sources';

/** 浸水想定区域の外（タイルに色が無い） */
export const OFFICIAL_NONE = 0;
/** 不明（タイルを取得できなかった・色が凡例と合わない） */
export const OFFICIAL_UNKNOWN = 255;

/** 判定に使うタイルのズーム（計算格子の基準ズームと同じ。1画素 ≒ 3.9 m） */
export const OFFICIAL_HAZARD_ZOOM = BASE_ZOOM;

/** サイト内のミラーのレイヤー名（public/tiles/hazard-tsunami/15/x/y.png。scripts/prefetch-dem.mjs が作る） */
export const OFFICIAL_MIRROR_LAYER = 'hazard-tsunami';

/**
 * 出典（画面表示用）。色を読み替えて判定に使っているので、ハザードマップポータルサイト利用規約の
 * 「コンテンツを編集・加工等して利用する場合の記載例」（sources.ts の HAZARD_PROCESSED_CREDIT）に、
 * データの作成者（神奈川県）を併記した形。
 */
export const OFFICIAL_ZONE_CREDIT = '「ハザードマップポータルサイト」（津波浸水想定：神奈川県）を加工して作成';

export interface OfficialTile {
  z: number;
  x: number;
  y: number;
}

/** 計算範囲を覆う z15 のタイル（解像度によらず同じ。scripts/prefetch-dem.mjs の listHazardTiles と同じ） */
export function officialHazardTiles(spec: GridSpec = createGridSpec('fine')): OfficialTile[] {
  const r = gridTileRange(spec, OFFICIAL_HAZARD_ZOOM);
  const out: OfficialTile[] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push({ z: OFFICIAL_HAZARD_ZOOM, x, y });
  return out;
}

/** ミラーの manifest.json のキー */
export function officialTileKey(t: OfficialTile): string {
  return `${OFFICIAL_MIRROR_LAYER}/${t.z}/${t.x}/${t.y}`;
}

/** ミラーのタイルの相対パス */
export function officialMirrorPath(t: OfficialTile): string {
  return `tiles/${officialTileKey(t)}.png`;
}

/** 配信元のタイルの URL */
export function officialRemoteUrl(t: OfficialTile): string {
  return HAZARD_TSUNAMI_TILES.url.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
}

/** 画素の色 → 階級コード（透明 = OFFICIAL_NONE、凡例の色 = 1〜8、それ以外 = OFFICIAL_UNKNOWN） */
export function officialCodeFromRgba(r: number, g: number, b: number, a: number): number {
  if (a === 0) return OFFICIAL_NONE;
  const cls = depthClassFromRgb(r, g, b);
  return cls ? DEPTH_CLASSES.indexOf(cls) + 1 : OFFICIAL_UNKNOWN;
}

/** タイル（RGBA、256×256）→ 階級コード（256×256） */
export function decodeOfficialTile(rgba: ArrayLike<number>): Uint8Array {
  const n = TILE_SIZE * TILE_SIZE;
  if (rgba.length !== n * 4) throw new Error('タイルの大きさが 256×256 ではありません');
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = officialCodeFromRgba(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]);
  return out;
}

/** 階級コード → 凡例の階級（区域外・不明は null） */
export function officialClassOf(code: number): DepthClass | null {
  return code >= 1 && code <= DEPTH_CLASSES.length ? DEPTH_CLASSES[code - 1] : null;
}

/** 空のデータ（すべて不明）。tiles に範囲のタイルを並べる */
export function emptyOfficialData(spec: GridSpec = createGridSpec('fine')): OfficialInundationData {
  const width = spec.nx * spec.cellPx;
  const height = spec.ny * spec.cellPx;
  return {
    zoom: OFFICIAL_HAZARD_ZOOM,
    originPx: spec.originPx,
    originPy: spec.originPy,
    width,
    height,
    codes: new Uint8Array(width * height).fill(OFFICIAL_UNKNOWN),
    tiles: officialHazardTiles(spec).length,
    fromMirror: 0,
    fromRemote: 0,
    missing: 0,
    failed: 0,
  };
}

/** タイルのコード（256×256。null = 浸水想定の無いタイル）をデータの該当範囲に書き込む */
export function putOfficialTile(data: OfficialInundationData, t: OfficialTile, codes: Uint8Array | null): void {
  const gx0 = t.x * TILE_SIZE - data.originPx;
  const gy0 = t.y * TILE_SIZE - data.originPy;
  for (let ty = 0; ty < TILE_SIZE; ty++) {
    const py = gy0 + ty;
    if (py < 0 || py >= data.height) continue;
    for (let tx = 0; tx < TILE_SIZE; tx++) {
      const px = gx0 + tx;
      if (px < 0 || px >= data.width) continue;
      data.codes[py * data.width + px] = codes ? codes[ty * TILE_SIZE + tx] : OFFICIAL_NONE;
    }
  }
}

/** 地点の階級コード（データの範囲外は null） */
export function officialCodeAt(data: OfficialInundationData, lon: number, lat: number): number | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const p = lonLatToPixel(lon, lat, data.zoom);
  const px = Math.floor(p.x - data.originPx);
  const py = Math.floor(p.y - data.originPy);
  if (px < 0 || py < 0 || px >= data.width || py >= data.height) return null;
  return data.codes[py * data.width + px];
}

const cellCache = new WeakMap<OfficialInundationData, Map<string, Uint8Array>>();

/**
 * 計算セルごとの階級コード（セルに含まれる z15 画素のうち最も深い階級。1画素でも浸水想定区域なら区域とする）。
 * セルに不明な画素があり、分かっている画素がすべて区域外なら OFFICIAL_UNKNOWN。
 * データの範囲外のセルも OFFICIAL_UNKNOWN。結果はデータ・格子ごとにキャッシュする。
 */
export function officialCellCodes(data: OfficialInundationData, spec: GridSpec): Uint8Array {
  const key = `${spec.zoom}|${spec.originPx}|${spec.originPy}|${spec.cellPx}|${spec.nx}|${spec.ny}`;
  let bySpec = cellCache.get(data);
  if (!bySpec) {
    bySpec = new Map();
    cellCache.set(data, bySpec);
  }
  const cached = bySpec.get(key);
  if (cached) return cached;
  const { nx, ny, cellPx } = spec;
  const out = new Uint8Array(nx * ny);
  if (spec.zoom !== data.zoom) {
    out.fill(OFFICIAL_UNKNOWN);
  } else {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let best = 0;
        let unknown = false;
        const px0 = spec.originPx + i * cellPx - data.originPx;
        const py0 = spec.originPy + j * cellPx - data.originPy;
        for (let dy = 0; dy < cellPx; dy++) {
          const py = py0 + dy;
          for (let dx = 0; dx < cellPx; dx++) {
            const px = px0 + dx;
            const c = px < 0 || py < 0 || px >= data.width || py >= data.height ? OFFICIAL_UNKNOWN : data.codes[py * data.width + px];
            if (c === OFFICIAL_UNKNOWN) unknown = true;
            else if (c > best) best = c;
          }
        }
        out[j * nx + i] = best > 0 ? best : unknown ? OFFICIAL_UNKNOWN : OFFICIAL_NONE;
      }
    }
  }
  bySpec.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// 画面表示用の説明
// ---------------------------------------------------------------------------

/** 地点の公式の想定の説明の種類 */
export type OfficialPointKind = 'zone' | 'outside' | 'unknown' | 'loading' | 'error' | 'out-of-range';

export interface OfficialPointInfo {
  kind: OfficialPointKind;
  /** 浸水想定区域なら階級 */
  cls: DepthClass | null;
  /** 画面表示用（例: 「公式の津波浸水想定（神奈川県）では浸水深0.5〜1mの区域」） */
  text: string;
}

/**
 * 地点が公式の津波浸水想定（神奈川県）で何mの区域かの説明。
 * state は AppState.officialInundation の status と data（読み込み中・失敗も説明する）。
 */
export function officialPointInfo(
  state: { status: string; data: OfficialInundationData | null } | null | undefined,
  lon: number,
  lat: number,
): OfficialPointInfo {
  if (!state || !state.data) {
    if (state?.status === 'error') return { kind: 'error', cls: null, text: '公式の津波浸水想定を読み込めませんでした（藤沢市の津波ハザードマップで確認してください）' };
    return { kind: 'loading', cls: null, text: '公式の津波浸水想定を読み込み中…' };
  }
  const code = officialCodeAt(state.data, lon, lat);
  if (code === null) return { kind: 'out-of-range', cls: null, text: '計算範囲外' };
  if (code === OFFICIAL_UNKNOWN) {
    return { kind: 'unknown', cls: null, text: '公式の津波浸水想定を確認できない場所です（データを読み込めなかった範囲。藤沢市の津波ハザードマップで確認してください）' };
  }
  const cls = officialClassOf(code);
  if (cls) return { kind: 'zone', cls, text: `公式の津波浸水想定（神奈川県）では浸水深${cls.label}の区域` };
  return { kind: 'outside', cls: null, text: '公式の津波浸水想定（神奈川県）では浸水想定区域の外' };
}
