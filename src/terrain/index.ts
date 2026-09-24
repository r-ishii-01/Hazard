/**
 * 地形（標高・水深）グリッドの読み込み。
 *
 * 契約:
 * - loadTerrain(resolution, opts) は TerrainGrid を返す。
 *   優先順: (1) ローカルミラー ./tiles/...（scripts/prefetch-dem.mjs で作成）
 *           (2) 国土地理院 標高タイル（ブラウザから直接取得）
 *           (3) 取得できない場合は合成（近似）地形（isApproximate=true）
 * - sampleGround(grid, lon, lat) は双線形補間した地盤高 [m, T.P.]（範囲外は null）。
 *
 * 処理の流れ（国土地理院のデータを使う場合）:
 *   標高タイル（DEM5A → 5B → 5C → DEM10B）を z15 画素のモザイクに → セルへ平均（無効値が半分以上なら水域）
 *   → 水域を海（海につながる河川を含む）と内水面に分類 → 海の水深を推定 → 粗度係数
 * 取得したモザイクはページ内でキャッシュするので、解像度を切り替えても再取得しない。
 *
 * デバッグ用: URL に `?terrain=synthetic` を付けると常に合成地形を使う。
 */
import { createGridSpec, type GridSpec, type Resolution } from '../core/geo';
import type { TerrainGrid } from '../core/types';
import { aggregateToCells } from './aggregate';
import { buildTerrainGrid, type BuildMeta } from './build';
import { bridgeWaterGaps } from './classify';
import {
  abortError,
  fetchDemMosaic,
  isAbortError,
  TerrainFetchError,
  type DecodeImage,
  type DemFetchResult,
  type FetchLike,
} from './fetchDem';
import { DEM_LAYERS } from './gsiDem';
import { sampleGroundAt } from './sample';
import { SYNTHETIC_NOTES, SYNTHETIC_SOURCE_LABEL, syntheticElevation } from './synthetic';

export { SHONAN_PROFILE, offshoreDepth } from './bathymetry';
export { MANNING } from './build';
export { SYNTHETIC_SOURCE_LABEL } from './synthetic';

export interface LoadTerrainOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
  /** 'auto'（既定）: 国土地理院 → 合成地形。'synthetic': 常に合成地形 */
  source?: 'auto' | 'synthetic';
  /** 以下はテスト・特殊用途向け（通常は指定しない） */
  fetchImpl?: FetchLike;
  decodeImpl?: DecodeImage;
  baseUrl?: string;
  timeoutMs?: number;
  concurrency?: number;
  /** モザイクのキャッシュを使わない */
  noCache?: boolean;
  /** 国土地理院に無いことを確認済みのタイルも要求する（テスト用） */
  requestKnownMissing?: boolean;
}

/** 取得したモザイクのキャッシュ（成功時のみ） */
let mosaicCache: DemFetchResult | null = null;

/** キャッシュを消す（テスト用） */
export function clearTerrainCache(): void {
  mosaicCache = null;
}

/** 有効画素がこれ未満なら「ほとんど取得できなかった」とみなす（範囲の約半分は陸） */
const MIN_VALID_FRACTION = 0.15;
/** 取得失敗で値が不明な画素がこれを超えたら使わない */
const MAX_UNKNOWN_FRACTION = 0.02;

function wantsSyntheticFromUrl(): boolean {
  try {
    const search = (globalThis as { location?: { search?: string } }).location?.search ?? '';
    return new URLSearchParams(search).get('terrain') === 'synthetic';
  } catch {
    return false;
  }
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** モザイクが使える品質か */
export function assessMosaic(r: DemFetchResult): { ok: true } | { ok: false; reason: string } {
  const total = r.mosaic.domain.width * r.mosaic.domain.height;
  if (r.fromMirror + r.fromRemote === 0 || r.mosaic.valid === 0) {
    return { ok: false, reason: '標高タイルを1枚も取得できませんでした。' };
  }
  if (r.mosaic.unknown > total * MAX_UNKNOWN_FRACTION) {
    return { ok: false, reason: `標高タイルの一部（${r.failed}枚）を取得できず、地形が欠けてしまうため使用しませんでした。` };
  }
  if (r.mosaic.valid < total * MIN_VALID_FRACTION) {
    return { ok: false, reason: '標高データがほとんど得られませんでした。' };
  }
  return { ok: true };
}

function gsiMeta(r: DemFetchResult, spec: GridSpec): BuildMeta {
  const layers = DEM_LAYERS.filter((l) => r.mosaic.used[l.id] > 0).map((l) => l.label);
  const layerText = layers.length > 0 ? layers.join('・') : 'DEM5A';
  const source = r.fromRemote === 0 && r.fromMirror > 0 ? 'cache' : 'gsi';
  const notes = [
    `陸域の標高は国土地理院の標高タイル（${layerText}）を約${spec.dx.toFixed(1)} m 四方のセルに平均したものです。建物や樹木の高さは含みません。`,
    '海・河川・池などの水面は標高データが無効値のため水域として扱い、海とつながる水域（引地川・境川など）は海として計算します。',
    '出典: 国土地理院「地理院タイル（標高タイル）」 https://maps.gsi.go.jp/development/ichiran.html#dem （国土地理院コンテンツ利用規約に基づき加工して利用）',
  ];
  if (source === 'cache') notes.push('このサイトに保存した標高タイルの複製を使用しています。');
  if (r.failed > 0) notes.push(`一部のタイル（${r.failed}枚）を取得できなかったため、その範囲は周囲の値や水域として補っています。`);
  return {
    source,
    sourceLabel: `国土地理院 標高タイル（${layerText}）を加工して作成`,
    isApproximate: false,
    notes,
  };
}

export async function loadTerrain(resolution: Resolution, opts: LoadTerrainOptions = {}): Promise<TerrainGrid> {
  const { signal } = opts;
  const report = (p: number, msg: string) => {
    if (!signal?.aborted) opts.onProgress?.(Math.max(0, Math.min(1, p)), msg);
  };
  throwIfAborted(signal);
  const spec = createGridSpec(resolution);
  report(0, '標高データを準備しています…');

  let fetched: DemFetchResult | null = null;
  let reason: string | null = null;
  const forceSynthetic = opts.source === 'synthetic' || wantsSyntheticFromUrl();

  if (forceSynthetic) {
    reason = '合成地形が指定されました。';
  } else if (mosaicCache && !opts.noCache) {
    fetched = mosaicCache;
  } else {
    try {
      const r = await fetchDemMosaic({
        signal,
        onProgress: (f, m) => report(0.02 + 0.8 * f, m),
        fetchImpl: opts.fetchImpl,
        decodeImpl: opts.decodeImpl,
        baseUrl: opts.baseUrl,
        timeoutMs: opts.timeoutMs,
        concurrency: opts.concurrency,
        skipKnownMissing: !opts.requestKnownMissing,
      });
      const q = assessMosaic(r);
      if (q.ok) {
        fetched = r;
        if (!opts.noCache) mosaicCache = r;
      } else {
        reason = q.reason;
      }
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw abortError();
      reason = e instanceof TerrainFetchError ? e.message : '標高タイルの読み込み中に問題が発生しました。';
      if (!(e instanceof TerrainFetchError)) console.warn('[terrain] DEM fetch failed', e);
    }
  }
  throwIfAborted(signal);

  if (fetched) {
    report(0.84, '標高データをセルに集計中…');
    await yieldToBrowser();
    throwIfAborted(signal);
    const { mosaic } = fetched;
    const raw = aggregateToCells(mosaic.heights, mosaic.domain.width, mosaic.domain.height, spec.cellPx, spec.nx, spec.ny);
    // 格子より細い川が途切れないように補う
    const bridged = bridgeWaterGaps(raw.elev, raw.waterFrac, spec.nx, spec.ny);
    report(0.9, '水域（海・河川）を判定し、海底地形を推定中…');
    await yieldToBrowser();
    throwIfAborted(signal);
    const meta = gsiMeta(fetched, spec);
    if (bridged > 0) {
      meta.notes.push(`セルより細い川が途中で途切れないよう、水面を一部含むセル ${bridged} 個を水域として扱いました。`);
    }
    const { grid } = buildTerrainGrid(spec, raw.elev, meta);
    report(1, grid.sourceLabel);
    return grid;
  }

  // 合成（近似）地形
  report(0.85, '国土地理院の標高データを使えないため、簡易地形モデルを作成中…');
  await yieldToBrowser();
  throwIfAborted(signal);
  const elev = syntheticElevation(spec);
  const notes = [...SYNTHETIC_NOTES];
  if (reason) notes.unshift(`理由: ${reason}`);
  const { grid } = buildTerrainGrid(spec, elev, {
    source: 'synthetic',
    sourceLabel: SYNTHETIC_SOURCE_LABEL,
    isApproximate: true,
    notes,
  });
  if (!forceSynthetic) console.info(`[terrain] 合成地形を使用します: ${reason ?? ''}`);
  report(1, SYNTHETIC_SOURCE_LABEL);
  return grid;
}

export function sampleGround(grid: TerrainGrid, lon: number, lat: number): number | null {
  return sampleGroundAt(grid, lon, lat);
}
