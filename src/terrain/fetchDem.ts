/**
 * 標高タイルの取得とデコード（ブラウザ側の処理）。
 *
 * 取得先の順序:
 *   (1) ローカルミラー `${BASE_URL}tiles/<layer>/<z>/<x>/<y>.png`（scripts/prefetch-dem.mjs で作成）。
 *       まず `tiles/manifest.json` を読み、無ければミラーは使わない（開発サーバーは存在しないパスに index.html を返すため、
 *       画像を直接試すより確実）。manifest で「国土地理院側にも無い（404）」と記録されたタイルは要求しない。
 *   (2) 国土地理院のタイル配信（https://cyberjapandata.gsi.go.jp/xyz/...）。CORS に対応している。
 * 404 は「そのタイルにはデータが無い」（海など）であり、エラーではない。
 *
 * 同時接続数・タイムアウト・中断（AbortSignal）・進捗通知に対応し、接続できない場合は早めに諦めて
 * TerrainFetchError を投げる（呼び出し側で合成地形に切り替える）。
 */
import {
  DEM10_LAYER,
  DEM10_ZOOM,
  DEM5_LAYERS,
  DEM_TILE_SIZE,
  decodeDemTile,
  demLayer,
  gsiTileUrl,
  mirrorTilePath,
  tileKey,
  type DemLayerId,
} from './gsiDem';
import { buildMosaic, type DemMosaic, type TileSlot } from './mosaic';
import { demTileRanges, isKnownMissingTile, pixelDomain, tileOverlap } from './tiles';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/** 画像（PNG）→ RGBA 画素配列（256×256×4） */
export type DecodeImage = (blob: Blob) => Promise<ArrayLike<number>>;

export interface DemFetchOptions {
  signal?: AbortSignal;
  /** 0〜1 の進捗と日本語メッセージ */
  onProgress?: (fraction: number, message: string) => void;
  /** テスト用の差し替え（既定: globalThis.fetch） */
  fetchImpl?: FetchLike;
  /** テスト用の差し替え（既定: createImageBitmap + OffscreenCanvas / canvas） */
  decodeImpl?: DecodeImage;
  /** ミラーの基準 URL（既定: import.meta.env.BASE_URL） */
  baseUrl?: string;
  /** 同時リクエスト数（既定 6） */
  concurrency?: number;
  /** 1タイルのタイムアウト [ms]（既定 10000） */
  timeoutMs?: number;
  /** ローカルミラーを使うか（既定 true） */
  useMirror?: boolean;
  /** 国土地理院から取得するか（既定 true） */
  useRemote?: boolean;
  /** 国土地理院に無いことを確認済みのタイルを要求しない（既定 true） */
  skipKnownMissing?: boolean;
}

export interface DemFetchResult {
  mosaic: DemMosaic;
  /** ミラーから得たタイル数 */
  fromMirror: number;
  /** 国土地理院から得たタイル数 */
  fromRemote: number;
  /** データが無かった（404）タイル数 */
  missing: number;
  /** 最終的に取得できなかったタイル数 */
  failed: number;
}

/** 標高タイルを十分に取得できなかったときのエラー（message は利用者向けの日本語） */
export class TerrainFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerrainFetchError';
  }
}

export function abortError(): DOMException {
  return new DOMException('地形の読み込みを中止しました', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';
}

// ---------------------------------------------------------------------------
// ミラーの manifest
// ---------------------------------------------------------------------------

export interface MirrorManifest {
  version: 1;
  /** tileKey → 1: 保存済み, 0: 国土地理院にも無い（404） */
  tiles: Record<string, 0 | 1>;
}

export function parseManifest(text: string): MirrorManifest | null {
  try {
    const data = JSON.parse(text) as Partial<MirrorManifest>;
    if (!data || data.version !== 1 || typeof data.tiles !== 'object' || data.tiles === null) return null;
    return { version: 1, tiles: data.tiles as Record<string, 0 | 1> };
  } catch {
    return null;
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

// ---------------------------------------------------------------------------
// 画像のデコード（ブラウザ）
// ---------------------------------------------------------------------------

let sharedCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let sharedCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

function canvasContext(w: number, h: number): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  if (!sharedCtx || !sharedCanvas || sharedCanvas.width !== w || sharedCanvas.height !== h) {
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx) sharedCanvas = c;
    }
    if (!ctx && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx) sharedCanvas = c;
    }
    if (!ctx) throw new Error('canvas 2D is not available');
    sharedCtx = ctx;
  }
  return sharedCtx;
}

async function loadAsImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * PNG → RGBA。色空間変換・乗算済みアルファを無効にして、符号化された RGB 値をそのまま読む。
 * （drawImage と getImageData は同期的に続けて呼ぶので、共有キャンバスでも並行デコードで競合しない）
 */
export async function decodePngInBrowser(blob: Blob): Promise<Uint8ClampedArray> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    try {
      const ctx = canvasContext(bmp.width, bmp.height);
      ctx.clearRect(0, 0, bmp.width, bmp.height);
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    } finally {
      bmp.close();
    }
  }
  const img = await loadAsImage(blob);
  const ctx = canvasContext(img.naturalWidth, img.naturalHeight);
  ctx.clearRect(0, 0, img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data;
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

type FetchOutcome = { slot: TileSlot; network: boolean };

/** 1枚のタイルを取得（タイムアウト・中断つき）。例外は投げず、中断時のみ AbortError を投げる */
async function fetchOne(url: string, fetchImpl: FetchLike, decode: DecodeImage, timeoutMs: number, signal: AbortSignal): Promise<FetchOutcome> {
  if (signal.aborted) throw abortError();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: ac.signal, mode: 'cors', credentials: 'omit' });
    } catch {
      if (signal.aborted) throw abortError();
      return { slot: 'error', network: true };
    }
    if (res.status === 404) return { slot: 'missing', network: false };
    if (!res.ok) return { slot: 'error', network: false };
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) return { slot: 'error', network: false };
    let blob: Blob;
    try {
      blob = await res.blob();
    } catch {
      if (signal.aborted) throw abortError();
      return { slot: 'error', network: true };
    }
    try {
      const rgba = await decode(blob);
      if (rgba.length !== DEM_TILE_SIZE * DEM_TILE_SIZE * 4) return { slot: 'error', network: false };
      return { slot: decodeDemTile(rgba), network: false };
    } catch {
      if (signal.aborted) throw abortError();
      return { slot: 'error', network: false };
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 同時実行数を制限して順に処理する */
async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>, signal: AbortSignal): Promise<void> {
  let next = 0;
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (next < items.length) {
      if (signal.aborted) throw abortError();
      const item = items[next++];
      await fn(item);
    }
  };
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
}

interface TileTask {
  layer: DemLayerId;
  z: number;
  x: number;
  y: number;
}

function hasNaNInOverlap(t: Float32Array, ov: { px0: number; py0: number; px1: number; py1: number }, dom: ReturnType<typeof pixelDomain>, tx: number, ty: number): boolean {
  for (let py = ov.py0; py < ov.py1; py++) {
    const ly = dom.originPy + py - ty * DEM_TILE_SIZE;
    for (let px = ov.px0; px < ov.px1; px++) {
      const lx = dom.originPx + px - tx * DEM_TILE_SIZE;
      const v = t[ly * DEM_TILE_SIZE + lx];
      if (v !== v) return true;
    }
  }
  return false;
}

/**
 * 計算範囲の標高モザイク（z15 画素）を取得して作る。
 * 取得できない場合は TerrainFetchError、中断時は AbortError を投げる。
 */
export async function fetchDemMosaic(opts: DemFetchOptions = {}): Promise<DemFetchResult> {
  const outer = opts.signal ?? new AbortController().signal;
  if (outer.aborted) throw abortError();
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const decode = opts.decodeImpl ?? decodePngInBrowser;
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const timeoutMs = opts.timeoutMs ?? 10000;
  const useRemote = opts.useRemote ?? true;
  const skipKnownMissing = opts.skipKnownMissing ?? true;
  const report = (f: number, msg: string) => opts.onProgress?.(Math.max(0, Math.min(1, f)), msg);

  // 内部の中断（接続できないと判断したら残りを止める）
  const internal = new AbortController();
  const onOuterAbort = () => internal.abort();
  outer.addEventListener('abort', onOuterAbort, { once: true });
  const signal = internal.signal;

  try {
    const dom = pixelDomain();
    const { z15 } = demTileRanges();
    const slots = new Map<string, TileSlot>();
    const lookup = (layer: DemLayerId, z: number, x: number, y: number) => slots.get(tileKey(layer, z, x, y));

    // (1) ミラーの manifest
    let manifest: MirrorManifest | null = null;
    const base = opts.baseUrl ?? defaultBaseUrl();
    if (opts.useMirror ?? true) {
      report(0.01, 'ローカルに保存した標高タイルを確認中…');
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), Math.min(timeoutMs, 5000));
        const onAbort = () => ac.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          const res = await fetchImpl(joinUrl(base, 'tiles/manifest.json'), { signal: ac.signal, cache: 'no-cache' });
          if (res.ok) manifest = parseManifest(await res.text());
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        }
      } catch {
        manifest = null;
      }
      if (outer.aborted) throw abortError();
    }

    const offline = typeof navigator !== 'undefined' && (navigator as Navigator).onLine === false;
    if (!manifest && (!useRemote || offline)) {
      throw new TerrainFetchError(
        offline ? 'オフラインのため国土地理院の標高タイルを取得できません。' : '標高タイルの取得先がありません。',
      );
    }

    let fromMirror = 0;
    let fromRemote = 0;
    let remoteOk = 0;
    let remoteNetErrors = 0;
    let remoteDisabled = !useRemote;

    /** 要求しなくても「データなし」と分かっているタイル（ミラーの記録、または確認済みの 404） */
    const knownMissing = (t: TileTask): boolean => {
      const m = manifest?.tiles[tileKey(t.layer, t.z, t.x, t.y)];
      return m === 0 || (m === undefined && skipKnownMissing && isKnownMissingTile(t.layer, t.z, t.x, t.y));
    };

    const getTile = async (t: TileTask, timeout = timeoutMs): Promise<TileSlot> => {
      if (knownMissing(t)) return 'missing';
      const m = manifest?.tiles[tileKey(t.layer, t.z, t.x, t.y)];
      if (m === 1) {
        const r = await fetchOne(joinUrl(base, mirrorTilePath(t.layer, t.z, t.x, t.y)), fetchImpl, decode, timeout, signal);
        if (r.slot instanceof Float32Array) {
          fromMirror++;
          return r.slot;
        }
        // ミラーの破損・欠落 → 国土地理院へ
      }
      if (remoteDisabled) return 'error';
      const r = await fetchOne(gsiTileUrl(t.layer, t.z, t.x, t.y), fetchImpl, decode, timeout, signal);
      if (r.network) {
        remoteNetErrors++;
        // 1枚も取得できないまま失敗が続く → 接続できないと判断
        if (remoteOk === 0 && remoteNetErrors >= Math.max(3, concurrency)) remoteDisabled = true;
      } else {
        remoteOk++;
        if (r.slot instanceof Float32Array) fromRemote++;
      }
      return r.slot;
    };

    const runPhase = async (all: TileTask[], p0: number, p1: number, label: string) => {
      let done = 0;
      const tasks: TileTask[] = [];
      for (const t of all) {
        if (knownMissing(t)) slots.set(tileKey(t.layer, t.z, t.x, t.y), 'missing');
        else tasks.push(t);
      }
      if (tasks.length === 0) return;
      report(p0, `標高タイル（${label}）を取得中… 0/${tasks.length}`);
      await runPool(
        tasks,
        concurrency,
        async (t) => {
          slots.set(tileKey(t.layer, t.z, t.x, t.y), await getTile(t));
          done++;
          report(p0 + ((p1 - p0) * done) / tasks.length, `標高タイル（${label}）を取得中… ${done}/${tasks.length}`);
        },
        signal,
      );
    };

    const z15Tiles: { x: number; y: number; ov: NonNullable<ReturnType<typeof tileOverlap>> }[] = [];
    for (let y = z15.y0; y <= z15.y1; y++) {
      for (let x = z15.x0; x <= z15.x1; x++) {
        const ov = tileOverlap(dom, x, y);
        if (ov) z15Tiles.push({ x, y, ov });
      }
    }

    // (2) 接続確認: 範囲中央のタイルを1枚だけ先に取得し、つながらなければすぐ諦める
    // 陸を含む（=存在するはずの）タイルを選ぶ。既知の 404 タイルは接続確認にならない
    const mid = Math.floor(z15Tiles.length / 2);
    const ordered = [...z15Tiles.slice(mid), ...z15Tiles.slice(0, mid)];
    const center = ordered.find((t) => !knownMissing({ layer: 'dem5a_png', z: z15.zoom, x: t.x, y: t.y })) ?? ordered[0];
    const probeTask: TileTask = { layer: 'dem5a_png', z: z15.zoom, x: center.x, y: center.y };
    report(0.03, manifest ? '保存済みの標高タイルを読み込み中…' : '国土地理院の標高タイルに接続中…');
    // 接続できない環境で長く待たせないよう、最初の1枚は短めのタイムアウトにする
    const probe = await getTile(probeTask, Math.min(timeoutMs, 6000));
    slots.set(tileKey(probeTask.layer, probeTask.z, probeTask.x, probeTask.y), probe);
    if (probe === 'error' && fromMirror === 0 && remoteOk === 0) {
      throw new TerrainFetchError('国土地理院の標高タイルに接続できませんでした（ネットワークの制限またはオフラインの可能性があります）。');
    }

    // (3) DEM5A → 無効値を含むタイルだけ DEM5B → DEM5C
    const phases: [DemLayerId, number, number][] = [
      ['dem5a_png', 0.05, 0.55],
      ['dem5b_png', 0.55, 0.72],
      ['dem5c_png', 0.72, 0.85],
    ];
    for (const [layer, p0, p1] of phases) {
      const tasks: TileTask[] = [];
      for (const t of z15Tiles) {
        if (slots.has(tileKey(layer, z15.zoom, t.x, t.y))) continue;
        if (layer !== 'dem5a_png') {
          // 上位のレイヤーで範囲内の全画素が埋まっていれば不要
          const arrays = DEM5_LAYERS.slice(0, DEM5_LAYERS.indexOf(layer))
            .map((l) => slots.get(tileKey(l, z15.zoom, t.x, t.y)))
            .filter((s): s is Float32Array => s instanceof Float32Array);
          if (arrays.length > 0 && !combinedHasNaN(arrays, t.ov, dom, t.x, t.y)) continue;
        }
        tasks.push({ layer, z: z15.zoom, x: t.x, y: t.y });
      }
      await runPhase(tasks, p0, p1, demLayer(layer).label);
      if (remoteDisabled && useRemote && fromMirror === 0 && fromRemote === 0) {
        throw new TerrainFetchError('国土地理院の標高タイルを取得できませんでした（ネットワークの制限またはオフラインの可能性があります）。');
      }
    }

    // (4) 5m メッシュが1枚も無い場所は DEM10B（z14）
    const need10 = new Map<string, TileTask>();
    for (const t of z15Tiles) {
      const any5 = DEM5_LAYERS.some((l) => slots.get(tileKey(l, z15.zoom, t.x, t.y)) instanceof Float32Array);
      if (any5) continue;
      const x14 = t.x >> (z15.zoom - DEM10_ZOOM);
      const y14 = t.y >> (z15.zoom - DEM10_ZOOM);
      need10.set(tileKey(DEM10_LAYER, DEM10_ZOOM, x14, y14), { layer: DEM10_LAYER, z: DEM10_ZOOM, x: x14, y: y14 });
    }
    await runPhase([...need10.values()], 0.85, 0.93, demLayer(DEM10_LAYER).label);

    // (5) 失敗したタイルを1回だけ再試行
    const retry: TileTask[] = [];
    for (const [key, slot] of slots) {
      if (slot !== 'error') continue;
      const [layer, z, x, y] = key.split('/');
      retry.push({ layer: layer as DemLayerId, z: Number(z), x: Number(x), y: Number(y) });
    }
    if (retry.length > 0 && !remoteDisabled) await runPhase(retry, 0.93, 0.96, '再試行');

    report(0.97, '標高タイルをつなぎ合わせています…');
    const mosaic = buildMosaic(dom, z15, lookup);
    let failed = 0;
    let missing = 0;
    for (const s of slots.values()) {
      if (s === 'error') failed++;
      else if (s === 'missing') missing++;
    }
    return { mosaic, fromMirror, fromRemote, missing, failed };
  } finally {
    outer.removeEventListener('abort', onOuterAbort);
  }
}

function combinedHasNaN(arrays: Float32Array[], ov: { px0: number; py0: number; px1: number; py1: number }, dom: ReturnType<typeof pixelDomain>, tx: number, ty: number): boolean {
  if (arrays.length === 1) return hasNaNInOverlap(arrays[0], ov, dom, tx, ty);
  for (let py = ov.py0; py < ov.py1; py++) {
    const ly = dom.originPy + py - ty * DEM_TILE_SIZE;
    for (let px = ov.px0; px < ov.px1; px++) {
      const p = ly * DEM_TILE_SIZE + (dom.originPx + px - tx * DEM_TILE_SIZE);
      let ok = false;
      for (const a of arrays) {
        const v = a[p];
        if (v === v) {
          ok = true;
          break;
        }
      }
      if (!ok) return true;
    }
  }
  return false;
}
