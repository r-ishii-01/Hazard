/**
 * 3D 建物（OpenFreeMap のベクタータイル z14、OpenMapTiles スキーマの building レイヤー）。
 *
 * - TileJSON からタイル URL を得て、計算範囲を覆う z14 タイルを取得・デコード
 * - 高さ = render_height（無ければ 6 m）、下端 = render_min_height
 * - 各ポリゴンはタイル境界で切り取り（隣のタイルとの重複を防ぐ）、角柱に押し出す
 * - 足元は地形の標高（外周の最小値）に合わせる。鉛直強調はワールドグループが掛ける
 * - タイル1枚ごとに1つのメッシュ（読み込みながら順に表示）
 * 取得できないときは静かに諦める（console.info を1回だけ）。
 */
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  ShapeUtils,
  Vector2,
} from 'three';
import { TILE_SIZE, gridTileRange } from '../core/geo';
import { CELL_SEA } from '../core/types';
import { OPENFREEMAP } from '../data/sources';
import type { HeightSampler } from './sampler';

const ZOOM = 14;
const MAX_CONCURRENT = 4;
const DEFAULT_HEIGHT = 6;

export type BuildingStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** 伸長可能な型付き配列 */
class Buf<T extends Float32Array | Uint32Array> {
  len = 0;
  constructor(public arr: T, private readonly make: (n: number) => T) {}
  push3(a: number, b: number, c: number): void {
    if (this.len + 3 > this.arr.length) this.grow(this.len + 3);
    const x = this.arr;
    x[this.len++] = a;
    x[this.len++] = b;
    x[this.len++] = c;
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
function clipRing(ring: P[], ext: number): P[] {
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

export class BuildingLayer {
  readonly group = new Group();
  status: BuildingStatus = 'idle';
  count = 0;
  private readonly material = new MeshLambertMaterial({ vertexColors: true });
  private readonly cache = new Map<string, ArrayBuffer | null>();
  private tilesUrl: string | null = null;
  private sampler: HeightSampler | null = null;
  private ac: AbortController | null = null;
  private generation = 0;
  private enabled = false;
  private warned = false;
  private built = false;

  constructor(private readonly onUpdate: () => void) {
    this.group.name = 'buildings';
  }

  setGrid(sampler: HeightSampler | null): void {
    this.sampler = sampler;
    this.clearMeshes();
    this.built = false;
    if (this.enabled) this.start();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    if (on && !this.built) this.start();
  }

  private start(): void {
    const sampler = this.sampler;
    if (!sampler || this.status === 'failed') return;
    this.ac?.abort();
    const ac = new AbortController();
    this.ac = ac;
    const gen = ++this.generation;
    this.built = true;
    this.status = 'loading';
    this.load(sampler, gen, ac.signal).then(
      () => {
        if (gen !== this.generation) return;
        this.status = this.count > 0 || this.cache.size > 0 ? 'ready' : 'failed';
        this.onUpdate();
      },
      (e: unknown) => {
        if (gen !== this.generation || ac.signal.aborted) return;
        this.status = 'failed';
        if (!this.warned) {
          this.warned = true;
          console.info('[view3d] 3D 建物（OpenFreeMap）を取得できませんでした:', (e as Error)?.message ?? e);
        }
        this.onUpdate();
      },
    );
  }

  private async load(sampler: HeightSampler, gen: number, signal: AbortSignal): Promise<void> {
    if (!this.tilesUrl) {
      const res = await fetch(OPENFREEMAP.tilejson, { signal, mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`TileJSON HTTP ${res.status}`);
      const tj = (await res.json()) as { tiles?: string[] };
      if (!tj.tiles || !tj.tiles[0]) throw new Error('TileJSON に tiles がありません');
      this.tilesUrl = tj.tiles[0];
    }
    const url = this.tilesUrl;
    const r = gridTileRange(sampler.spec, ZOOM);
    const list: { x: number; y: number }[] = [];
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) list.push({ x, y });
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    list.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    let ok = 0;
    let failed = 0;
    let firstError: unknown = null;
    const worker = async () => {
      while (list.length > 0) {
        if (gen !== this.generation || signal.aborted) return;
        const t = list.shift()!;
        const key = `${ZOOM}/${t.x}/${t.y}`;
        let buf = this.cache.get(key);
        if (buf === undefined) {
          try {
            const res = await fetch(url.replace('{z}', String(ZOOM)).replace('{x}', String(t.x)).replace('{y}', String(t.y)), {
              signal,
              mode: 'cors',
              credentials: 'omit',
            });
            if (res.status === 404 || res.status === 204) buf = null;
            else if (!res.ok) throw new Error(`HTTP ${res.status}`);
            else buf = await res.arrayBuffer();
            this.cache.set(key, buf);
          } catch (e) {
            if (signal.aborted) return;
            failed += 1;
            firstError ??= e;
            continue;
          }
        }
        ok += 1;
        if (!buf || gen !== this.generation) continue;
        // 重い処理の合間に描画の機会を与える
        await new Promise((res) => setTimeout(res, 0));
        if (gen !== this.generation) return;
        const geo = buildTile(buf, t.x, t.y, sampler);
        if (!geo) continue;
        if (gen !== this.generation) {
          geo.geometry.dispose();
          return;
        }
        const mesh = new Mesh(geo.geometry, this.material);
        mesh.name = `buildings-${key}`;
        this.group.add(mesh);
        this.count += geo.count;
        this.onUpdate();
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
    if (ok === 0 && failed > 0) throw firstError ?? new Error('建物タイルを取得できませんでした');
  }

  private clearMeshes(): void {
    this.generation += 1;
    this.ac?.abort();
    this.ac = null;
    for (const m of [...this.group.children]) {
      this.group.remove(m);
      (m as Mesh).geometry?.dispose();
    }
    this.count = 0;
    if (this.status !== 'failed') this.status = 'idle';
  }

  dispose(): void {
    this.clearMeshes();
    this.material.dispose();
    this.cache.clear();
  }
}

/** 1タイル分の建物を1つのジオメトリにする */
function buildTile(buf: ArrayBuffer, tx: number, ty: number, sampler: HeightSampler): { geometry: BufferGeometry; count: number } | null {
  let tile: VectorTile;
  try {
    tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
  } catch (e) {
    console.info('[view3d] 建物タイルのデコードに失敗', e);
    return null;
  }
  const layer = tile.layers.building;
  if (!layer || layer.length === 0) return null;
  const ext = layer.extent || 4096;
  const spec = sampler.spec;
  // タイル座標 → ローカル座標 [m]（メルカトルは線形なので一次式）
  const s15 = Math.pow(2, spec.zoom - ZOOM);
  const k = (TILE_SIZE * s15) / ext / spec.cellPx * spec.dx;
  const ax = ((tx * TILE_SIZE * s15 - spec.originPx) / spec.cellPx - spec.nx / 2) * spec.dx;
  const az = ((ty * TILE_SIZE * s15 - spec.originPy) / spec.cellPx - spec.ny / 2) * spec.dx;
  const pos = new Buf(new Float32Array(1 << 16), (n) => new Float32Array(n));
  const nor = new Buf(new Float32Array(1 << 16), (n) => new Float32Array(n));
  const col = new Buf(new Float32Array(1 << 16), (n) => new Float32Array(n));
  const idx = new Buf(new Uint32Array(1 << 16), (n) => new Uint32Array(n));
  let count = 0;
  const contour: Vector2[] = [];
  for (let f = 0; f < layer.length; f++) {
    const feat = layer.feature(f);
    if (feat.type !== 3) continue;
    const props = feat.properties;
    if (props.hide_3d === true || props.hide_3d === 'true') continue;
    let h = Number(props.render_height);
    if (!Number.isFinite(h) || h <= 0) h = DEFAULT_HEIGHT;
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
      if (kc >= 0 && sampler.grid.kind[kc] === CELL_SEA && sampler.grid.z[kc] < 0) continue;
      let gmin = Infinity;
      for (const p of outer) gmin = Math.min(gmin, sampler.height(p.x, p.z));
      if (!Number.isFinite(gmin)) continue;
      const base = gmin - 0.3 + hMin;
      const top = gmin + h;
      const id = count + tx * 7919 + ty * 104729;
      const tint = 0.9 + 0.12 * hash(id);
      const tall = h >= 18 ? 1 : 0;
      const r0 = (tall ? 0.8 : 0.86) * tint;
      const g0 = (tall ? 0.83 : 0.84) * tint;
      const b0 = (tall ? 0.88 : 0.8) * tint;
      // 壁
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
          for (let q = 0; q < 4; q++) nor.push3(nxv, 0, nzv);
          // 下ほど暗く（簡易な環境遮蔽）
          const lo = 0.62;
          col.push3(r0 * lo, g0 * lo, b0 * lo);
          col.push3(r0 * lo, g0 * lo, b0 * lo);
          col.push3(r0, g0, b0);
          col.push3(r0, g0, b0);
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
      const rr = Math.min(1, r0 * 1.06);
      const rg = Math.min(1, g0 * 1.06);
      const rb = Math.min(1, b0 * 1.06);
      for (const p of all) {
        pos.push3(p.x, top, p.y);
        nor.push3(0, 1, 0);
        col.push3(rr, rg, rb);
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
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos.view(), 3));
  geo.setAttribute('normal', new BufferAttribute(nor.view(), 3));
  geo.setAttribute('color', new BufferAttribute(col.view(), 3));
  geo.setIndex(new BufferAttribute(idx.view(), 1));
  geo.computeBoundingSphere();
  return { geometry: geo, count };
}
