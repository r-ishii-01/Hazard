/**
 * ラスタータイル（地理院タイル等）を計算範囲ぴったりのキャンバスに貼り合わせ、
 * three.js のテクスチャとして使う。タイルが届くたびに（間引きして）テクスチャを更新する。
 *
 * - キャンバスの左上 = グリッド北西角、右下 = グリッド南東角（UV の v は北→南、flipY=false）
 * - 取得できなかった部分は透明のまま（シェーダ側で代替色に切り替える）
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import { TILE_SIZE, type GridSpec } from '../core/geo';
import type { RasterTileSource } from '../data/sources';

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
}

const MAX_CONCURRENT = 6;
const UPDATE_INTERVAL_MS = 1000;

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
    const { spec, source, filter } = this.opts;
    const ox = spec.originPx * scale;
    const oy = spec.originPy * scale;
    const x0 = Math.floor(ox / TILE_SIZE);
    const y0 = Math.floor(oy / TILE_SIZE);
    const x1 = Math.floor((ox + this.canvas.width - 1e-6) / TILE_SIZE);
    const y1 = Math.floor((oy + this.canvas.height - 1e-6) / TILE_SIZE);
    const queue: { x: number; y: number }[] = [];
    // 中心に近いタイルから読む（見栄えのため）
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (filter && !filter(x, y, this.zoom)) continue;
        queue.push({ x, y });
      }
    }
    queue.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    const total = queue.length;
    let loaded = 0;
    let failed = 0;
    let missing = 0;
    let active = 0;

    const finish = () => {
      if (this.disposed) return;
      if (loaded > 0) this.status = failed > 0 ? 'partial' : 'ready';
      else this.status = failed > 0 ? 'failed' : 'ready';
      this.flush();
      this.opts.onDone?.(this.status, loaded, failed);
    };

    const next = () => {
      if (this.disposed) return;
      if (queue.length === 0) {
        if (active === 0) finish();
        return;
      }
      const t = queue.shift()!;
      active += 1;
      const url = source.url.replace('{z}', String(this.zoom)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
      const exists = this.opts.exists;
      (exists ? exists(t.x, t.y, this.zoom).catch(() => true) : Promise.resolve(true))
        .then((ok) => (ok && !this.disposed ? this.loadTile(url) : null))
        .then((bmp) => {
          if (this.disposed) {
            bmp?.close();
            return;
          }
          if (bmp) {
            this.ctx.drawImage(bmp, Math.round(t.x * TILE_SIZE - ox), Math.round(t.y * TILE_SIZE - oy), TILE_SIZE, TILE_SIZE);
            bmp.close();
            loaded += 1;
            if (!this.hasContent) {
              this.hasContent = true;
              this.opts.onFirstContent?.();
            }
            this.scheduleUpdate();
          } else {
            missing += 1;
          }
        })
        .catch(() => {
          failed += 1;
        })
        .finally(() => {
          active -= 1;
          next();
        });
    };
    if (total === 0) {
      queueMicrotask(finish);
      return;
    }
    for (let n = 0; n < Math.min(MAX_CONCURRENT, total); n++) next();
    void missing;
  }

  /** 1タイルを取得してデコード。404 等（タイルが存在しない）は null、通信失敗は例外 */
  private async loadTile(url: string): Promise<ImageBitmap | null> {
    const res = await fetch(url, { signal: this.ac.signal, mode: 'cors', credentials: 'omit' });
    if (!res.ok) {
      if (res.status === 404 || res.status === 204) return null;
      throw new Error(`HTTP ${res.status}`);
    }
    const blob = await res.blob();
    if (blob.size === 0) return null;
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
