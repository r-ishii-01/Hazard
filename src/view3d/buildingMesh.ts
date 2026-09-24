/**
 * 建物タイル（OpenFreeMap のベクタータイル z14、OpenMapTiles スキーマの building レイヤー）から
 * 角柱の頂点データを作る純粋な処理（DOM・WebGL に依存しない。Web Worker でも動く）。
 *
 * - 高さ = render_height（無ければ 6 m）、下端 = render_min_height
 * - 各ポリゴンはタイル境界で切り取り（隣のタイルとの重複を防ぐ）、角柱に押し出す
 * - 足元は地形の標高（外周の最小値）に合わせる。鉛直強調はワールドグループが掛ける
 * - 範囲外・海（河川）の上の建物は省く（地形データとの食い違いで海底に沈むのを防ぐ）
 *
 * 頂点データは小さな型で持つ（法線は符号付き 8 bit、色は 8 bit。どちらも正規化して使う）。
 * 建物は数万棟あり、32 bit 浮動小数点で持つと 3D 表示のメモリの大半を占めるため。
 * 8 bit の属性は 4 成分（1 頂点 4 バイト）にそろえる。3 成分（3 バイト）は多くの GPU・WebGL の実装が
 * 頂点の形式として直接扱えず、転送時に変換が入って描画が大きく遅れるため（法線の第 4 成分は 0、色の不透明度は 255）。
 */
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { ShapeUtils, Vector2 } from 'three';
import { TILE_SIZE, type GridSpec } from '../core/geo';
import { CELL_SEA, type TerrainGrid } from '../core/types';
import { HeightSampler } from './sampler';

/** 建物タイルのズーム */
export const BUILDING_ZOOM = 14;
/** 高さの無い建物の高さ [m]（OSM に高さが無い建物は一律。実際の高さではない） */
export const DEFAULT_BUILDING_HEIGHT = 6;

/** 建物の頂点データに必要な地形の情報（Web Worker へ送る） */
export interface BuildingGrid {
  spec: GridSpec;
  /** 地盤高 [m, T.P.] */
  z: Float32Array;
  /** セル種別 */
  kind: Uint8Array;
}

/** 1タイル分の建物の頂点データ */
export interface BuiltTile {
  /** 位置（ローカル座標 [m]、鉛直強調なし） */
  position: Float32Array;
  /** 法線（×127 した符号付き 8 bit、1 頂点 4 成分で第 4 成分は 0。正規化して使う） */
  normal: Int8Array;
  /** 頂点色（×255 した 8 bit、1 頂点 4 成分で不透明度は 255。正規化して使う。リニア） */
  color: Uint8Array;
  index: Uint16Array | Uint32Array;
  /** 建物の数 */
  count: number;
  /** 包む球（中心 x, y, z と半径）。視野外の判定に使う */
  sphere: [number, number, number, number];
}

/** 伸長可能な型付き配列 */
type Typed = Float32Array | Int8Array | Uint8Array | Uint32Array;
class Buf<T extends Typed> {
  len = 0;
  constructor(
    public arr: T,
    private readonly make: (n: number) => T,
  ) {}
  push3(a: number, b: number, c: number): void {
    if (this.len + 3 > this.arr.length) this.grow(this.len + 3);
    const x = this.arr;
    x[this.len++] = a;
    x[this.len++] = b;
    x[this.len++] = c;
  }
  push4(a: number, b: number, c: number, d: number): void {
    if (this.len + 4 > this.arr.length) this.grow(this.len + 4);
    const x = this.arr;
    x[this.len++] = a;
    x[this.len++] = b;
    x[this.len++] = c;
    x[this.len++] = d;
  }
  private grow(min: number): void {
    const next = this.make(Math.max(min, this.arr.length * 2));
    next.set(this.arr.subarray(0, this.len) as never);
    this.arr = next;
  }
  view(): T {
    return this.arr.slice(0, this.len) as T;
  }
}

interface P {
  x: number;
  y: number;
}

/** Sutherland–Hodgman でリングを [0, ext]² に切り取る */
export function clipRing(ring: P[], ext: number): P[] {
  let pts = ring;
  // 閉じた重複点を除く
  if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts = pts.slice(0, -1);
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= ext, (a, b) => ({ x: ext, y: a.y + ((b.y - a.y) * (ext - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => p.y <= ext, (a, b) => ({ x: a.x + ((b.x - a.x) * (ext - a.y)) / (b.y - a.y), y: ext })],
  ];
  for (const [inside, cut] of edges) {
    if (pts.length === 0) break;
    const out: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(cut(prev, cur));
      }
    }
    pts = out;
  }
  return pts;
}

function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

const toI8 = (v: number): number => Math.max(-127, Math.min(127, Math.round(v * 127)));
const toU8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/** 地形の情報からサンプラーを作る（HeightSampler は spec と z しか使わない） */
export function samplerFor(grid: BuildingGrid): HeightSampler {
  return new HeightSampler(grid as unknown as TerrainGrid);
}

/**
 * 1タイル分の建物を頂点データにする（建物1棟ごとに yield する。呼び出し側で時間を区切って進められる）。
 * 建物が無ければ null を返す。
 */
export function* buildTileSteps(buf: ArrayBuffer | Uint8Array, tx: number, ty: number, grid: BuildingGrid, sampler: HeightSampler = samplerFor(grid)): Generator<void, BuiltTile | null, void> {
  let tile: VectorTile;
  try {
    tile = new VectorTile(new PbfReader(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
  } catch {
    return null;
  }
  const layer = tile.layers.building;
  if (!layer || layer.length === 0) return null;
  const ext = layer.extent || 4096;
  const spec = grid.spec;
  // タイル座標 → ローカル座標 [m]（メルカトルは線形なので一次式）
  const s15 = Math.pow(2, spec.zoom - BUILDING_ZOOM);
  const k = ((TILE_SIZE * s15) / ext / spec.cellPx) * spec.dx;
  const ax = ((tx * TILE_SIZE * s15 - spec.originPx) / spec.cellPx - spec.nx / 2) * spec.dx;
  const az = ((ty * TILE_SIZE * s15 - spec.originPy) / spec.cellPx - spec.ny / 2) * spec.dx;
  const pos = new Buf(new Float32Array(1 << 15), (n) => new Float32Array(n));
  const nor = new Buf(new Int8Array(1 << 15), (n) => new Int8Array(n));
  const col = new Buf(new Uint8Array(1 << 15), (n) => new Uint8Array(n));
  const idx = new Buf(new Uint32Array(1 << 15), (n) => new Uint32Array(n));
  let count = 0;
  const contour: Vector2[] = [];
  for (let f = 0; f < layer.length; f++) {
    if (f > 0) yield;
    const feat = layer.feature(f);
    if (feat.type !== 3) continue;
    const props = feat.properties;
    if (props.hide_3d === true || props.hide_3d === 'true') continue;
    let h = Number(props.render_height);
    if (!Number.isFinite(h) || h <= 0) h = DEFAULT_BUILDING_HEIGHT;
    let hMin = Number(props.render_min_height);
    if (!Number.isFinite(hMin) || hMin < 0) hMin = 0;
    h = Math.min(h, 400);
    if (h - hMin < 0.5) continue;
    let polys: P[][][];
    try {
      polys = classifyRings(feat.loadGeometry());
    } catch {
      continue;
    }
    for (const poly of polys) {
      if (!poly[0]) continue;
      const outerClip = clipRing(poly[0], ext);
      if (outerClip.length < 3) continue;
      const clipped = [outerClip, ...poly.slice(1).map((r) => clipRing(r, ext)).filter((r) => r.length >= 3)];
      // ローカル座標へ
      const L = clipped.map((r) => r.map((p) => ({ x: ax + p.x * k, z: az + p.y * k, onEdge: p.x <= 0 || p.x >= ext || p.y <= 0 || p.y >= ext, tx: p.x, ty: p.y })));
      const outer = L[0];
      // 範囲外・海（河川）の上の建物は省く（地形データとの食い違いで海底に沈むのを防ぐ）
      const c0 = outer[0];
      if (!sampler.inside(c0.x, c0.z)) continue;
      const kc = sampler.cellIndex(c0.x, c0.z);
      if (kc >= 0 && grid.kind[kc] === CELL_SEA && grid.z[kc] < 0) continue;
      let gmin = Infinity;
      for (const p of outer) gmin = Math.min(gmin, sampler.height(p.x, p.z));
      if (!Number.isFinite(gmin)) continue;
      const base = gmin - 0.3 + hMin;
      const top = gmin + h;
      const id = count + tx * 7919 + ty * 104729;
      const tint = 0.9 + 0.12 * hash(id);
      const tall = h >= 18 ? 1 : 0;
      const r0 = Math.min(1, (tall ? 0.8 : 0.86) * tint);
      const g0 = Math.min(1, (tall ? 0.83 : 0.84) * tint);
      const b0 = Math.min(1, (tall ? 0.88 : 0.8) * tint);
      // 壁（下ほど暗く: 簡易な環境遮蔽）
      const lo = 0.62;
      const wr = toU8(r0);
      const wg = toU8(g0);
      const wb = toU8(b0);
      const lr = toU8(r0 * lo);
      const lg = toU8(g0 * lo);
      const lb = toU8(b0 * lo);
      for (let ri = 0; ri < L.length; ri++) {
        const ring = L[ri];
        let area2 = 0;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          area2 += a.x * b.z - b.x * a.z;
        }
        if (area2 === 0) continue;
        // 建物の外側を向く法線: 外周はリングの外向き、穴は内向き
        const outward = (area2 > 0 ? 1 : -1) * (ri === 0 ? 1 : -1);
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          // タイル境界上の切り口には壁を作らない
          if (a.onEdge && b.onEdge && ((a.tx === b.tx && (a.tx <= 0 || a.tx >= ext)) || (a.ty === b.ty && (a.ty <= 0 || a.ty >= ext)))) continue;
          const ex = b.x - a.x;
          const ez = b.z - a.z;
          const len = Math.hypot(ex, ez);
          if (len < 1e-3) continue;
          const nxv = (outward * ez) / len;
          const nzv = (-outward * ex) / len;
          const v0 = pos.len / 3;
          pos.push3(a.x, base, a.z);
          pos.push3(b.x, base, b.z);
          pos.push3(b.x, top, b.z);
          pos.push3(a.x, top, a.z);
          const qx = toI8(nxv);
          const qz = toI8(nzv);
          for (let q = 0; q < 4; q++) nor.push4(qx, 0, qz, 0);
          col.push4(lr, lg, lb, 255);
          col.push4(lr, lg, lb, 255);
          col.push4(wr, wg, wb, 255);
          col.push4(wr, wg, wb, 255);
          // 三角形 (a0,b0,b1) の法線は (-ez, 0, ex) 方向
          if (nxv * -ez + nzv * ex > 0) {
            idx.push3(v0, v0 + 1, v0 + 2);
            idx.push3(v0, v0 + 2, v0 + 3);
          } else {
            idx.push3(v0, v0 + 2, v0 + 1);
            idx.push3(v0, v0 + 3, v0 + 2);
          }
        }
      }
      // 屋根
      contour.length = 0;
      for (const p of outer) contour.push(new Vector2(p.x, p.z));
      const holes = L.slice(1).map((r) => r.map((p) => new Vector2(p.x, p.z)));
      let tris: number[][];
      try {
        tris = ShapeUtils.triangulateShape(contour, holes);
      } catch {
        continue;
      }
      const all = [...contour, ...holes.flat()];
      const v0 = pos.len / 3;
      const rr = toU8(Math.min(1, r0 * 1.06));
      const rg = toU8(Math.min(1, g0 * 1.06));
      const rb = toU8(Math.min(1, b0 * 1.06));
      for (const p of all) {
        pos.push3(p.x, top, p.y);
        nor.push4(0, 127, 0, 0);
        col.push4(rr, rg, rb, 255);
      }
      for (const t of tris) {
        const a = all[t[0]];
        const b = all[t[1]];
        const c = all[t[2]];
        // 上から見て反時計回り（法線 +y）になるよう並べる
        const ny = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y);
        if (ny >= 0) idx.push3(v0 + t[0], v0 + t[1], v0 + t[2]);
        else idx.push3(v0 + t[0], v0 + t[2], v0 + t[1]);
      }
      count += 1;
    }
  }
  if (count === 0) return null;
  const position = pos.view();
  const nVert = position.length / 3;
  const indexArr = idx.view();
  const index = nVert <= 65535 ? Uint16Array.from(indexArr) : indexArr;
  return { position, normal: nor.view(), color: col.view(), index, count, sphere: boundingSphere(position) };
}

/** 1タイル分の建物を頂点データにする（途中で区切らない。Web Worker 用） */
export function buildTileArrays(buf: ArrayBuffer | Uint8Array, tx: number, ty: number, grid: BuildingGrid, sampler?: HeightSampler): BuiltTile | null {
  const it = buildTileSteps(buf, tx, ty, grid, sampler);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** 位置の配列を包む球（外接直方体の中心から最も遠い点まで） */
export function boundingSphere(position: Float32Array): [number, number, number, number] {
  const n = position.length / 3;
  if (n === 0) return [0, 0, 0, 0];
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = position[i * 3];
    const y = position[i * 3 + 1];
    const z = position[i * 3 + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = position[i * 3] - cx;
    const dy = position[i * 3 + 1] - cy;
    const dz = position[i * 3 + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return [cx, cy, cz, Math.sqrt(r2)];
}
