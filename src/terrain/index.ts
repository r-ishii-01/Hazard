/**
 * 地形（標高・水深）グリッドの読み込み。
 *
 * 契約:
 * - loadTerrain(resolution, opts) は TerrainGrid を返す。
 *   優先順: (1) ローカルミラー ./tiles/...（scripts/prefetch-dem.mjs で作成）
 *           (2) 国土地理院 標高タイル（ブラウザから直接取得）
 *           (3) 取得できない場合は合成（近似）地形（isApproximate=true）
 *   中断（AbortSignal）されたときだけ AbortError で reject し、それ以外は必ず何らかの地形を返す。
 * - sampleGround(grid, lon, lat) は双線形補間した地盤高 [m, T.P.]（範囲外は null）。
 *
 * 処理の流れ（国土地理院のデータを使う場合）:
 *   標高タイル（DEM5A → 5B → 5C → DEM10B）を z15 画素のモザイクに → 画素の段階で「海とつながった水面」を求める
 *   → セルへ平均（無効値が半分以上なら水域）→ 取得失敗の範囲を周囲から補う → セルより細い川のつながりを保つ
 *   → 水域を海（海につながる河川を含む）と内水面に分類 → 海の水深を推定 → 粗度係数
 * 取得したモザイクはページ内でキャッシュするので、解像度を切り替えても再取得しない。
 *
 * デバッグ用: URL に `?terrain=synthetic` を付けると常に合成地形を使う。
 */
import { createGridSpec, type GridSpec, type Resolution } from '../core/geo';
import type { TerrainGrid } from '../core/types';
import { aggregateToCells } from './aggregate';
import { buildTerrainGrid, type BuildMeta } from './build';
import { connectSeaWater, fillUnknownCells, seaConnectedPixels } from './connect';
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
  /** 取得全体の制限時間 [ms]（既定 60000） */
  deadlineMs?: number;
  concurrency?: number;
  /** モザイクのキャッシュ（と接続失敗の記憶）を使わない */
  noCache?: boolean;
  /** 国土地理院に無いことを確認済みのタイルも要求する（テスト用） */
  requestKnownMissing?: boolean;
}

/** 取得したモザイクと、画素の段階の「海とつながった水面」（成功時のみ保持） */
interface MosaicEntry {
  fetched: DemFetchResult;
  seaPx: Uint8Array;
}
let mosaicCache: MosaicEntry | null = null;

/**
 * 直前に国土地理院へ接続できなかった時刻と理由。解像度を切り替えるたびに接続確認で待たせないよう、
 * この時間内は再接続を試みずに合成地形を使う（ページを再読み込みすれば再試行する）。
 */
let unreachableSince: { at: number; reason: string } | null = null;
const UNREACHABLE_RETRY_MS = 60_000;

/** キャッシュを消す（テスト用） */
export function clearTerrainCache(): void {
  mosaicCache = null;
  unreachableSince = null;
}

/** 有効画素がこれ未満なら「ほとんど取得できなかった」とみなす（範囲の約半分は陸） */
const MIN_VALID_FRACTION = 0.15;
/** 取得失敗で値が不明な画素がこれを超えたら使わない（少なければ周囲の値で補う） */
const MAX_UNKNOWN_FRACTION = 0.02;

/**
 * 国土地理院コンテンツ利用規約の「編集・加工等して利用する場合の記載例」に沿った出典表記
 * （https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html ）。使用したレイヤー名を括弧で補う。
 */
export function gsiSourceLabel(layers: readonly string[]): string {
  return `地理院タイル（標高タイル（基盤地図情報数値標高モデル））を加工して作成（国土地理院 ${layers.join('・') || 'DEM5A'}）`;
}

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
    return {
      ok: false,
      reason: r.timedOut
        ? `標高タイルの取得に時間がかかりすぎたため打ち切り、地形が欠けてしまうため使用しませんでした（未取得 ${r.failed}枚）。`
        : `標高タイルの一部（${r.failed}枚）を取得できず、地形が欠けてしまうため使用しませんでした。`,
    };
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
    '出典: 国土地理院「地理院タイル（標高タイル）」 https://maps.gsi.go.jp/development/ichiran.html#dem （国土地理院コンテンツ利用規約に基づき加工して利用。このサイトの計算結果は国土地理院が作成したものではありません）',
  ];
  if (source === 'cache') notes.push('このサイトに保存した標高タイルの複製を使用しています。');
  return { source, sourceLabel: gsiSourceLabel(layers), isApproximate: false, notes };
}

/** 取得したモザイクから格子を作る（純粋な処理。例外は呼び出し側で合成地形に切り替える） */
function gridFromMosaic(entry: MosaicEntry, spec: GridSpec): TerrainGrid {
  const { fetched, seaPx } = entry;
  const { mosaic } = fetched;
  const raw = aggregateToCells(mosaic.heights, mosaic.domain.width, mosaic.domain.height, spec.cellPx, spec.nx, spec.ny, {
    seaPx,
    unknownPx: mosaic.unknownMask,
  });
  const meta = gsiMeta(fetched, spec);
  // 取得できなかったタイルの範囲（値が不明なセル）は、周囲のセルから陸・水域と標高を補う
  let filled = 0;
  if (raw.unknownCells > 0 && raw.unknownFrac) {
    const unknownCell = Uint8Array.from(raw.unknownFrac, (v) => (v >= 1 ? 1 : 0));
    filled = fillUnknownCells(raw.elev, unknownCell, spec.nx, spec.ny);
  }
  if (fetched.failed > 0) {
    meta.notes.push(
      `一部のタイル（${fetched.failed}枚）を取得できなかったため、その範囲（${filled}セル）は周囲のセルの値で補っています。`,
    );
  }
  // セルより細い川が途中で途切れないように、画素の段階でのつながりを保つ
  const converted = raw.seaFrac ? connectSeaWater(raw.elev, raw.seaFrac, spec.nx, spec.ny) : 0;
  if (converted > 0) {
    meta.notes.push(
      `セルより細い川が途中で途切れないよう、実際に海とつながっている水面を含むセル ${converted} 個を水域として扱いました。`,
    );
  }
  // 海とつながった水面を1画素も含まない水域セル（池）は、セルに平均しただけで川とつながらないようにする
  const n = spec.nx * spec.ny;
  const isolated = new Uint8Array(n);
  if (raw.seaFrac) {
    for (let k = 0; k < n; k++) {
      const known = !raw.unknownFrac || raw.unknownFrac[k] === 0;
      if (known && raw.elev[k] !== raw.elev[k] && raw.seaFrac[k] === 0) isolated[k] = 1;
    }
  }
  return buildTerrainGrid(spec, raw.elev, meta, { isolated }).grid;
}

function syntheticGrid(spec: GridSpec, reason: string | null): TerrainGrid {
  const notes = [...SYNTHETIC_NOTES];
  if (reason) notes.unshift(`理由: ${reason}`);
  return buildTerrainGrid(spec, syntheticElevation(spec), {
    source: 'synthetic',
    sourceLabel: SYNTHETIC_SOURCE_LABEL,
    isApproximate: true,
    notes,
  }).grid;
}

export async function loadTerrain(resolution: Resolution, opts: LoadTerrainOptions = {}): Promise<TerrainGrid> {
  const { signal } = opts;
  const report = (p: number, msg: string) => {
    if (!signal?.aborted) opts.onProgress?.(Math.max(0, Math.min(1, p)), msg);
  };
  throwIfAborted(signal);
  const spec = createGridSpec(resolution);
  report(0, '標高データを準備しています…');

  let entry: MosaicEntry | null = null;
  let reason: string | null = null;
  const forceSynthetic = opts.source === 'synthetic' || wantsSyntheticFromUrl();
  const now = Date.now();

  if (forceSynthetic) {
    reason = '合成地形が指定されました。';
  } else if (mosaicCache && !opts.noCache) {
    entry = mosaicCache;
  } else if (!opts.noCache && unreachableSince && now - unreachableSince.at < UNREACHABLE_RETRY_MS) {
    reason = `${unreachableSince.reason}（直前に接続できなかったため、再試行していません）`;
  } else {
    try {
      const r = await fetchDemMosaic({
        signal,
        onProgress: (f, m) => report(0.02 + 0.78 * f, m),
        fetchImpl: opts.fetchImpl,
        decodeImpl: opts.decodeImpl,
        baseUrl: opts.baseUrl,
        timeoutMs: opts.timeoutMs,
        deadlineMs: opts.deadlineMs,
        concurrency: opts.concurrency,
        skipKnownMissing: !opts.requestKnownMissing,
      });
      const q = assessMosaic(r);
      if (q.ok) {
        report(0.81, '水域のつながりを調べています…');
        await yieldToBrowser();
        throwIfAborted(signal);
        const { mosaic } = r;
        entry = { fetched: r, seaPx: seaConnectedPixels(mosaic.heights, mosaic.domain.width, mosaic.domain.height, mosaic.unknownMask) };
        if (!opts.noCache) mosaicCache = entry;
        unreachableSince = null;
      } else {
        reason = q.reason;
      }
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw abortError();
      if (e instanceof TerrainFetchError) {
        reason = e.message;
        if (e.unreachable) unreachableSince = { at: Date.now(), reason: e.message };
      } else {
        reason = '標高タイルの読み込み中に問題が発生しました。';
        console.warn('[terrain] DEM fetch failed', e);
      }
    }
  }
  throwIfAborted(signal);

  if (entry) {
    report(0.84, '標高データをセルに集計し、水域（海・河川）と海底地形を推定中…');
    await yieldToBrowser();
    throwIfAborted(signal);
    try {
      const grid = gridFromMosaic(entry, spec);
      report(1, grid.sourceLabel);
      return grid;
    } catch (e) {
      // 想定外のデータでも地形を返せるように、合成地形に切り替える
      console.warn('[terrain] failed to build the grid from DEM tiles', e);
      reason = '標高タイルから地形を作る処理で問題が発生しました。';
    }
  }

  // 合成（近似）地形
  report(0.85, '国土地理院の標高データを使えないため、簡易地形モデルを作成中…');
  await yieldToBrowser();
  throwIfAborted(signal);
  const grid = syntheticGrid(spec, reason);
  if (!forceSynthetic) console.info(`[terrain] 合成地形を使用します: ${reason ?? ''}`);
  report(1, SYNTHETIC_SOURCE_LABEL);
  return grid;
}

export function sampleGround(grid: TerrainGrid, lon: number, lat: number): number | null {
  return sampleGroundAt(grid, lon, lat);
}
