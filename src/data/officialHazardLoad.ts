/**
 * 公式の津波浸水想定タイルの読み込み（ブラウザ側）。人物の評価に使う画素ごとの階級（officialHazard.ts）を作る。
 *
 * 取得先の順序（標高タイルと同じ方針。src/terrain/fetchDem.ts）:
 *   (1) サイト内のミラー `${BASE_URL}tiles/hazard-tsunami/15/<x>/<y>.png`（scripts/prefetch-dem.mjs で作成）。
 *       `tiles/manifest.json` に記録があるタイルだけ読む（0 = 配信元にも無い＝浸水想定の無いタイル）。
 *   (2) ハザードマップポータルサイトの配信（https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/...）。
 *       CORS に対応している。404 は「浸水想定の無いタイル」で、エラーではない。
 * どちらからも取得できなかったタイルの範囲は「不明」（OFFICIAL_UNKNOWN）のまま残す（浸水しないとは扱わない）。
 * 1枚も読めなければ OfficialHazardLoadError を投げる。
 *
 * また、地図に重ねる公式ハザードマップ（2D・3D は配信元のタイルを直接表示する）が取得できるかを
 * checkOfficialHazardDisplay で確かめる（配信元に接続できないと、地図の上では色が無いだけに見えるため）。
 */
import { TILE_SIZE, createGridSpec } from '../core/geo';
import type { OfficialInundationData } from '../core/types';
import { decodePngInBrowser, parseManifest, type MirrorManifest } from '../terrain/fetchDem';
import {
  OFFICIAL_HAZARD_ZOOM,
  decodeOfficialTile,
  emptyOfficialData,
  officialHazardTiles,
  officialMirrorPath,
  officialRemoteUrl,
  officialTileKey,
  putOfficialTile,
  type OfficialTile,
} from './officialHazard';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/** PNG → RGBA 画素配列（256×256×4） */
export type DecodeImage = (blob: Blob) => Promise<ArrayLike<number>>;

export interface OfficialLoadOptions {
  signal?: AbortSignal;
  /** テスト用の差し替え（既定: globalThis.fetch） */
  fetchImpl?: FetchLike;
  /** テスト用の差し替え（既定: createImageBitmap + canvas） */
  decodeImpl?: DecodeImage;
  /** ミラーの基準 URL（既定: import.meta.env.BASE_URL） */
  baseUrl?: string;
  /** 1枚のタイムアウト [ms]（既定 10000） */
  timeoutMs?: number;
  /** 同時リクエスト数（既定 6） */
  concurrency?: number;
  useMirror?: boolean;
  useRemote?: boolean;
}

/** 公式の浸水想定を1枚も読めなかったときのエラー（message は利用者向けの日本語） */
export class OfficialHazardLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficialHazardLoadError';
  }
}

function defaultBaseUrl(): string {
  try {
    return import.meta.env?.BASE_URL ?? '/';
  } catch {
    return '/';
  }
}

function joinUrl(base: string, path: string): string {
  return base.endsWith('/') ? base + path : `${base}/${path}`;
}

function abortError(): DOMException {
  return new DOMException('公式の浸水想定の読み込みを中止しました', 'AbortError');
}

/** p と、タイムアウト・中断の早い方（fetch が signal に応じない実装でも打ち切れる） */
async function withTimeout<T>(make: (signal: AbortSignal) => Promise<T>, timeoutMs: number, outer?: AbortSignal): Promise<T> {
  if (outer?.aborted) throw abortError();
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('timeout'));
      ac.abort();
    }, timeoutMs);
    onAbort = () => {
      reject(abortError());
      ac.abort();
    };
    outer?.addEventListener('abort', onAbort, { once: true });
  });
  stop.catch(() => undefined);
  try {
    return await Promise.race([make(ac.signal), stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort) outer?.removeEventListener('abort', onAbort);
  }
}

type TileResult = { kind: 'codes'; codes: Uint8Array } | { kind: 'missing' } | { kind: 'error' };

async function fetchTile(url: string, fetchImpl: FetchLike, decode: DecodeImage, timeoutMs: number, outer?: AbortSignal): Promise<TileResult> {
  try {
    return await withTimeout(
      async (signal) => {
        const res = await fetchImpl(url, { signal, mode: 'cors', credentials: 'omit' });
        if (res.status === 404) return { kind: 'missing' } as const;
        if (!res.ok) return { kind: 'error' } as const;
        // 開発サーバーは存在しないパスに index.html を返す
        if ((res.headers.get('content-type') ?? '').includes('text/html')) return { kind: 'error' } as const;
        const rgba = await decode(await res.blob());
        if (rgba.length !== TILE_SIZE * TILE_SIZE * 4) return { kind: 'error' } as const;
        return { kind: 'codes', codes: decodeOfficialTile(rgba) } as const;
      },
      timeoutMs,
      outer,
    );
  } catch (e) {
    if (outer?.aborted) throw abortError();
    void e;
    return { kind: 'error' };
  }
}

/**
 * 計算範囲の公式の浸水想定を読み込む。一部のタイルを取得できなかった場合は、その範囲を「不明」として返す
 * （data.failed に枚数）。1枚も読めなければ OfficialHazardLoadError。
 */
export async function loadOfficialInundation(opts: OfficialLoadOptions = {}): Promise<OfficialInundationData> {
  const outer = opts.signal;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const decode = opts.decodeImpl ?? decodePngInBrowser;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const base = opts.baseUrl ?? defaultBaseUrl();
  const spec = createGridSpec('fine');
  const tiles = officialHazardTiles(spec);
  const data = emptyOfficialData(spec);

  let manifest: MirrorManifest | null = null;
  if (opts.useMirror ?? true) {
    try {
      manifest = await withTimeout(
        async (signal) => {
          const res = await fetchImpl(joinUrl(base, 'tiles/manifest.json'), { signal, cache: 'no-cache' });
          return res.ok ? parseManifest(await res.text()) : null;
        },
        Math.min(timeoutMs, 5000),
        outer,
      );
    } catch (e) {
      if (outer?.aborted) throw abortError();
      void e;
      manifest = null;
    }
  }

  let remoteDisabled = !(opts.useRemote ?? true);
  let remoteOk = 0;
  let remoteErrors = 0;
  const concurrency = Math.max(1, opts.concurrency ?? 6);

  const one = async (t: OfficialTile): Promise<void> => {
    const m = manifest?.tiles[officialTileKey(t)];
    if (m === 0) {
      putOfficialTile(data, t, null);
      data.missing++;
      return;
    }
    if (m === 1) {
      const r = await fetchTile(joinUrl(base, officialMirrorPath(t)), fetchImpl, decode, timeoutMs, outer);
      if (r.kind === 'codes') {
        putOfficialTile(data, t, r.codes);
        data.fromMirror++;
        return;
      }
      // ミラーの破損・欠落 → 配信元へ
    }
    if (!remoteDisabled) {
      const r = await fetchTile(officialRemoteUrl(t), fetchImpl, decode, timeoutMs, outer);
      if (r.kind === 'codes') {
        putOfficialTile(data, t, r.codes);
        data.fromRemote++;
        remoteOk++;
        return;
      }
      if (r.kind === 'missing') {
        putOfficialTile(data, t, null);
        data.missing++;
        remoteOk++;
        return;
      }
      remoteErrors++;
      // 1枚も取得できないまま失敗が続く → 配信元に接続できないと判断して、残りは要求しない
      if (remoteOk === 0 && remoteErrors >= Math.max(3, concurrency)) remoteDisabled = true;
    }
    data.failed++;
  };

  let next = 0;
  const worker = async () => {
    while (next < tiles.length) {
      if (outer?.aborted) throw abortError();
      await one(tiles[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, worker));
  if (outer?.aborted) throw abortError();

  if (data.failed >= data.tiles) {
    throw new OfficialHazardLoadError(
      '公式の津波浸水想定（ハザードマップポータルサイト）のデータを読み込めませんでした（ネットワークの制限またはオフラインの可能性があります）。',
    );
  }
  return data;
}

/** 読み込み結果の説明（一部のタイルを読めなかった場合など。問題がなければ undefined） */
export function officialLoadMessage(data: OfficialInundationData): string | undefined {
  if (data.failed > 0) {
    return `公式の津波浸水想定の一部（${data.tiles}枚中${data.failed}枚のタイル）を読み込めませんでした。その範囲は公式の浸水想定区域かどうかを確認できません。`;
  }
  return undefined;
}

/**
 * 地図に重ねる公式ハザードマップの配信元に接続できるか（2D 地図が最初に読む z13 のタイルを1枚だけ要求する。
 * 同じ URL なのでブラウザのキャッシュが効く）。200 と 404（データなし）は接続できたとみなす。
 */
export async function checkOfficialHazardDisplay(opts: { fetchImpl?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const spec = createGridSpec('fine');
  // 計算範囲の中央を含むズーム 13 のタイル
  const cx = spec.originPx + (spec.nx * spec.cellPx) / 2;
  const cy = spec.originPy + (spec.ny * spec.cellPx) / 2;
  const f = Math.pow(2, OFFICIAL_HAZARD_ZOOM - 13);
  const t: OfficialTile = { z: 13, x: Math.floor(cx / f / TILE_SIZE), y: Math.floor(cy / f / TILE_SIZE) };
  try {
    return await withTimeout(
      async (signal) => {
        const res = await fetchImpl(officialRemoteUrl(t), { signal, mode: 'cors', credentials: 'omit' });
        return res.ok || res.status === 404;
      },
      opts.timeoutMs ?? 10000,
      opts.signal,
    );
  } catch {
    return false;
  }
}
