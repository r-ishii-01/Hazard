/**
 * ラスタータイル（地理院タイル等）を計算範囲ぴったりのキャンバスに貼り合わせ、
 * three.js のテクスチャとして使う。タイルが届くたびに（間引きして）テクスチャを更新する。
 *
 * - キャンバスの左上 = グリッド北西角、右下 = グリッド南東角（UV の v は北→南、flipY=false）
 * - 取得できなかった部分は透明のまま（シェーダ側で代替色に切り替える）
 * - 範囲が同じなら（解像度だけ変えたとき）キャンバスは作り直さず、足りないタイルだけ addTiles で追加する
 * - 1 枚の取得には時間の上限を設ける（応答が無いまま待ち続けると onDone が呼ばれず、取得できないことを示せないため）
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import { TILE_SIZE, type GridSpec } from '../core/geo';
import type { RasterTileSource } from '../data/sources';
import { withTimeout } from '../ui/geoSearch';

export type TileCanvasStatus = 'loading' | 'ready' | 'partial' | 'failed';

export interface TileCanvasOptions {
  spec: GridSpec;
  source: RasterTileSource;
  /** キャンバスの一辺の上限 [px] */
  maxSize: number;
  /** 使用する最大ズーム（省略時はソースの maxzoom まで） */
  maxZoom?: number;
  anisotropy: number;
  /** タイル (x, y, z) を取得するか（海だけのタイルを省く等） */
  filter?: (x: number, y: number, z: number) => boolean;
  /** 取得の直前に、タイルが存在しうるかを非同期に確かめる（false なら要求せず「無い」扱い。404 を減らす） */
  exists?: (x: number, y: number, z: number) => Promise<boolean>;
  /** テクスチャが更新された（再描画が必要） */
  onUpdate: () => void;
  /** 最初のタイルを描いた（出典表示の更新用） */
  onFirstContent?: () => void;
  /** 全タイルの処理が終わった */
  onDone?: (status: TileCanvasStatus, loaded: number, failed: number) => void;
  /** タイルを 1 枚取得できなかった（全部の処理が終わるのを待たずに知らせたいとき。failed はここまでの数） */
  onTileError?: (failed: number) => void;
  /** 1 枚の取得の時間の上限 [ms]（既定 TILE_TIMEOUT_MS） */
  timeoutMs?: number;
}

const MAX_CONCURRENT = 6;
const UPDATE_INTERVAL_MS = 1000;
/** タイル 1 枚の取得の時間の上限 [ms] */
export const TILE_TIMEOUT_MS = 20_000;

/**
 * 2つの格子が同じ範囲を覆うか（解像度だけが違う）。同じならタイルのキャンバスの大きさ・位置も同じなので使い回せる
 * （キャンバスは spec.nx·cellPx × spec.ny·cellPx の範囲を、左上 = originPx/originPy に合わせて作る）。
 */
export function sameExtent(a: GridSpec, b: GridSpec): boolean {
  return a.zoom === b.zoom && a.originPx === b.originPx && a.originPy === b.originPy && a.nx * a.cellPx === b.nx * b.cellPx && a.ny * a.cellPx === b.ny * b.cellPx;
}

export class TileCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly zoom: number;
  status: TileCanvasStatus = 'loading';
  /** 1枚でも描けたか */
  hasContent = false;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ac = new AbortController();
  private updateTimer = 0;
  private lastUpdate = 0;
  private disposed = false;
  /** キャンバス左上の全球ピクセル座標（this.zoom での値） */
  private ox = 0;
  private oy = 0;
  /** 要求済みのタイル（'x/y'）と待ち行列 */
  private readonly requested = new Set<string>();
  private readonly queue: { x: number; y: number }[] = [];
  private inflight = 0;
  private loaded = 0;
  private failed = 0;

  constructor(private readonly opts: TileCanvasOptions) {
    const { spec, source } = opts;
    const extentPx = Math.max(spec.nx, spec.ny) * spec.cellPx; // spec.zoom でのピクセル数
    // キャンバスが maxSize に収まる最大のズームを選ぶ
    let zoom = Math.min(opts.maxZoom ?? source.maxzoom, source.maxzoom);
    while (zoom > source.minzoom && extentPx * Math.pow(2, zoom - spec.zoom) > opts.maxSize) zoom -= 1;
    this.zoom = zoom;
    const scale = Math.pow(2, zoom - spec.zoom);
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, Math.round(spec.nx * spec.cellPx * scale));
    this.canvas.height = Math.max(1, Math.round(spec.ny * spec.cellPx * scale));
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.anisotropy = opts.anisotropy;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = true;
    this.start(scale);
  }

  private start(scale: number): void {
    const { spec } = this.opts;
    this.ox = spec.originPx * scale;
    this.oy = spec.originPy * scale;
    const queued = this.enqueue(this.opts.filter);
    // 判定の関数は地形の格子を参照しているので、使い終わったら手放す（解像度を変えてキャンバスを使い回すとき、前の格子を残さない）
    this.opts.filter = undefined;
    if (queued === 0) {
      queueMicrotask(() => this.finish());
      return;
    }
    this.pump();
  }

  /**
   * まだ取得していないタイルのうち filter を満たすものを追加で取得する。
   * 解像度を変えた（範囲は同じ）ときに、新しい格子で陸を含むようになったタイルを取得するのに使う。
   */
  addTiles(filter?: (x: number, y: number, z: number) => boolean): void {
    if (this.disposed) return;
    if (this.enqueue(filter) > 0) this.pump();
  }

  /** 範囲のタイルのうち、まだ要求していないものを待ち行列に入れる（中心に近い順）。入れた数を返す */
  private enqueue(filter?: (x: number, y: number, z: number) => boolean): number {
    const x0 = Math.floor(this.ox / TILE_SIZE);
    const y0 = Math.floor(this.oy / TILE_SIZE);
    const x1 = Math.floor((this.ox + this.canvas.width - 1e-6) / TILE_SIZE);
    const y1 = Math.floor((this.oy + this.canvas.height - 1e-6) / TILE_SIZE);
    const add: { x: number; y: number }[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${x}/${y}`;
        if (this.requested.has(key)) continue;
        if (filter && !filter(x, y, this.zoom)) continue;
        this.requested.add(key);
        add.push({ x, y });
      }
    }
    // 中心に近いタイルから読む（見栄えのため）
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    add.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    this.queue.push(...add);
    return add.length;
  }

  private pump(): void {
    while (!this.disposed && this.inflight < MAX_CONCURRENT && this.queue.length > 0) this.next();
  }

  private finish(): void {
    if (this.disposed) return;
    if (this.loaded > 0) this.status = this.failed > 0 ? 'partial' : 'ready';
    else this.status = this.failed > 0 ? 'failed' : 'ready';
    this.flush();
    this.opts.onDone?.(this.status, this.loaded, this.failed);
  }

  /** ここまでに取得できなかったタイルの数 */
  get failedTiles(): number {
    return this.failed;
  }

  private next(): void {
    if (this.disposed) return;
    const t = this.queue.shift();
    if (!t) {
      if (this.inflight === 0) this.finish();
      return;
    }
    this.inflight += 1;
    const url = this.opts.source.url.replace('{z}', String(this.zoom)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
    const exists = this.opts.exists;
    (exists ? exists(t.x, t.y, this.zoom).catch(() => true) : Promise.resolve(true))
      .then((ok) => (ok && !this.disposed ? this.loadTile(url) : null))
      .then((bmp) => {
        if (this.disposed) {
          bmp?.close();
          return;
        }
        if (bmp) {
          this.ctx.drawImage(bmp, Math.round(t.x * TILE_SIZE - this.ox), Math.round(t.y * TILE_SIZE - this.oy), TILE_SIZE, TILE_SIZE);
          bmp.close();
          this.loaded += 1;
          if (!this.hasContent) {
            this.hasContent = true;
            this.opts.onFirstContent?.();
          }
          this.scheduleUpdate();
        }
      })
      .catch(() => {
        if (this.disposed) return;
        this.failed += 1;
        this.opts.onTileError?.(this.failed);
      })
      .finally(() => {
        this.inflight -= 1;
        if (this.queue.length > 0) this.next();
        else if (this.inflight === 0) this.finish();
      });
  }

  /** 1タイルを取得してデコード。404 等（タイルが存在しない）は null、通信失敗は例外 */
  private async loadTile(url: string): Promise<ImageBitmap | null> {
    const blob = await withTimeout(
      async (signal) => {
        const res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
        if (!res.ok) {
          if (res.status === 404 || res.status === 204) return null;
          throw new Error(`HTTP ${res.status}`);
        }
        return res.blob();
      },
      { signal: this.ac.signal, timeoutMs: this.opts.timeoutMs ?? TILE_TIMEOUT_MS },
    );
    if (!blob || blob.size === 0) return null;
    return createImageBitmap(blob);
  }

  private scheduleUpdate(): void {
    if (this.updateTimer || this.disposed) return;
    const wait = Math.max(0, UPDATE_INTERVAL_MS - (performance.now() - this.lastUpdate));
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = 0;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.disposed) return;
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = 0;
    }
    this.lastUpdate = performance.now();
    this.texture.needsUpdate = true;
    this.opts.onUpdate();
  }

  dispose(): void {
    this.disposed = true;
    this.ac.abort();
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.texture.dispose();
    // キャンバスのメモリを早めに解放
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}
