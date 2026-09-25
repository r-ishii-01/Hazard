/**
 * 公式の津波浸水想定タイル（ハザードマップポータルサイト）の読み込み（2D・3D で共用）。
 *
 * 浸水想定の無いタイル（海だけ・内陸の浸水しない場所）はサーバーが 404 を返し、ブラウザのコンソールに
 * 「Failed to load resource」が大量に並ぶ。そこで、ズーム 13 の親タイル（計算範囲なら4枚）を先に読んで
 * 色の付いた画素がある範囲を調べ、子タイル（ズーム14以上）の範囲に色が無ければ要求せずに透明として扱う。
 * 2026-09-24 の確認（計算範囲を覆うタイルを全部取得して比較。親の画素の判定範囲を周囲2画素ずつ広げた場合）:
 *   ズーム14〜17 で色のあるタイル（z14: 8/12枚、z15: 17/48、z16: 49/168、z17: 146/598）の見落としは0。
 *   データの無いタイルを「ありうる」とした数は z15: 0、z16: 1、z17: 9 枚（多くは 200 の透明タイル）。
 *   親をズーム12にすると z17 で1枚見落とすため、ズーム13を使う。
 *
 * 2D 地図では MapLibre の addProtocol で独自のスキーム（kgz-hazard://z/x/y）を登録して使う。
 *
 * 取得には時間の上限を設ける（配信元が応答しないまま待ち続けると、タイルが「読み込み中」のまま止まり、
 * 取得できないことを画面に示せないため）。時間切れは取得の失敗として扱い、親タイルの判定の記録は残さない（次回また試す）。
 */
import { addProtocol } from 'maplibre-gl';
import { HAZARD_TSUNAMI_TILES } from '../data/sources';
import { withTimeout } from '../ui/geoSearch';

/** 親タイル（存在の判定）1 枚の取得の時間の上限 [ms] */
export const PRESENCE_TIMEOUT_MS = 10_000;
/** 表示するタイル 1 枚の取得の時間の上限 [ms] */
export const HAZARD_TILE_TIMEOUT_MS = 15_000;

export const HAZARD_PROTOCOL = 'kgz-hazard';
export const HAZARD_PROTOCOL_URL = `${HAZARD_PROTOCOL}://{z}/{x}/{y}`;

/** 存在の判定に使う親タイルのズーム */
const PRESENCE_ZOOM = 13;
/** 親タイルの画素で判定範囲を広げる量（縮小で細い部分が消える分の余裕） */
const PRESENCE_DILATE_PX = 2;

/** 1×1 の透明な PNG */
const EMPTY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
let emptyPng: Uint8Array | null = null;
function emptyTile(): ArrayBuffer {
  if (!emptyPng) emptyPng = Uint8Array.from(atob(EMPTY_PNG_B64), (c) => c.charCodeAt(0));
  return emptyPng.slice().buffer;
}

export function hazardTileUrl(z: number, x: number, y: number): string {
  return HAZARD_TSUNAMI_TILES.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** 親タイルの不透明画素（null = タイルが無い、undefined = 取得に失敗して分からない） */
type Presence = { alpha: Uint8Array; size: number } | null | undefined;
const presence = new Map<string, Promise<Presence>>();

async function decodeAlpha(blob: Blob): Promise<{ alpha: Uint8Array; size: number }> {
  const bmp = await createImageBitmap(blob);
  const size = bmp.width;
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, bmp.height) : Object.assign(document.createElement('canvas'), { width: size, height: bmp.height });
  const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!g) throw new Error('2D コンテキストを作れません');
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, size, size).data;
  const alpha = new Uint8Array(size * size);
  for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
  return { alpha, size };
}

function loadPresence(x: number, y: number): Promise<Presence> {
  const key = `${x}/${y}`;
  let p = presence.get(key);
  if (!p) {
    p = withTimeout(
      async (signal): Promise<Presence> => {
        const res = await fetch(hazardTileUrl(PRESENCE_ZOOM, x, y), { signal, mode: 'cors', credentials: 'omit' });
        if (res.status === 404) return null;
        if (!res.ok) return undefined;
        return decodeAlpha(await res.blob());
      },
      { timeoutMs: PRESENCE_TIMEOUT_MS },
    )
      .catch((): Presence => {
        // 通信の失敗では判定しない（次回また試せるよう記録を消す）
        presence.delete(key);
        return undefined;
      });
    presence.set(key, p);
  }
  return p;
}

/**
 * タイル (z, x, y) にデータがありうるか。親タイルで色が無いと分かれば false。
 * 判定できない（親以下のズーム・親の取得失敗）ときは true。
 */
export async function hazardTileMayExist(z: number, x: number, y: number): Promise<boolean> {
  if (z <= PRESENCE_ZOOM) return true;
  const f = Math.pow(2, z - PRESENCE_ZOOM);
  const px = Math.floor(x / f);
  const py = Math.floor(y / f);
  const pr = await loadPresence(px, py);
  if (pr === undefined) return true;
  if (pr === null) return false;
  const size = pr.size / f;
  const ox = (x - px * f) * size;
  const oy = (y - py * f) * size;
  const i0 = Math.max(0, Math.floor(ox - PRESENCE_DILATE_PX));
  const j0 = Math.max(0, Math.floor(oy - PRESENCE_DILATE_PX));
  const i1 = Math.min(pr.size, Math.ceil(ox + size + PRESENCE_DILATE_PX));
  const j1 = Math.min(pr.size, Math.ceil(oy + size + PRESENCE_DILATE_PX));
  for (let j = j0; j < j1; j++) {
    const row = j * pr.size;
    for (let i = i0; i < i1; i++) if (pr.alpha[row + i] > 0) return true;
  }
  return false;
}

let registered = false;

/** 2D 地図用の独自スキームを登録する（何度呼んでもよい） */
export function registerHazardProtocol(): void {
  if (registered) return;
  registered = true;
  addProtocol(HAZARD_PROTOCOL, async (params, abortController) => {
    const m = /^kgz-hazard:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error(`不正なタイルの URL: ${params.url}`);
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!(await hazardTileMayExist(z, x, y))) return { data: emptyTile() };
    const data = await withTimeout(
      async (signal) => {
        const res = await fetch(hazardTileUrl(z, x, y), { signal, mode: 'cors', credentials: 'omit' });
        // 浸水想定の無いタイルは 404（通常の応答）
        if (res.status === 404) return emptyTile();
        if (!res.ok) throw new Error(`タイルを取得できませんでした（HTTP ${res.status}）`);
        return res.arrayBuffer();
      },
      { signal: abortController.signal, timeoutMs: HAZARD_TILE_TIMEOUT_MS },
    );
    return { data };
  });
}
