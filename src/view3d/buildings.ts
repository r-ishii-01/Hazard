/**
 * 3D 建物（OpenFreeMap のベクタータイル z14、OpenMapTiles スキーマの building レイヤー）。
 *
 * - TileJSON からタイル URL を得て、計算範囲を覆う z14 タイルを取得（取得したタイルは保持して、地形が変わったら作り直しに使う）
 * - デコードと角柱の三角形分割は Web Worker で行う（buildingsWorker.ts / buildingMesh.ts）。
 *   数万棟を画面の処理の中で作ると 100 ms を超える処理が続き、操作が止まるため。
 *   Worker を使えない環境では、画面の処理の中で 8 ms ごとに区切って作る
 * - 高さ = render_height（無ければ 6 m）、下端 = render_min_height。足元は地形の標高（外周の最小値）
 * - タイル1枚ごとに1つのメッシュ（読み込みながら順に表示）
 * - 頂点データは GPU に送った後に手放す（JavaScript 側に数十 MB を残さない）。GPU のリセット後は rebuild で作り直す
 * - 最大浸水深・到達時間・公式の浸水想定を地形に重ねるときは、建物にも足元の色を付ける
 *   （斜めから見ると地面の多くが建物に隠れ、色分けが読み取れないため）
 * 取得できないときは静かに諦める（console.info を1回だけ）。
 */
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshLambertMaterial,
  RGBAFormat,
  Sphere,
  Vector2,
  Vector3,
  type Texture,
} from 'three';
import { gridTileRange } from '../core/geo';
import { OPENFREEMAP } from '../data/sources';
import { BUILDING_ZOOM, buildTileSteps, type BuiltTile } from './buildingMesh';
import type { HeightSampler } from './sampler';

const ZOOM = BUILDING_ZOOM;
const MAX_CONCURRENT = 4;
/** Worker を使えないときに、画面の処理の中で続けて作る時間の上限 [ms] */
const SLICE_MS = 8;

export type BuildingStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** GPU に送った後に頂点データを手放す（BufferAttribute.onUpload から呼ばれる） */
function releaseArray(this: BufferAttribute): void {
  (this as unknown as { array: unknown }).array = null;
}

/** 頂点データからメッシュ用のジオメトリを作る */
export function geometryFromTile(t: BuiltTile, releaseAfterUpload: boolean): BufferGeometry {
  const geo = new BufferGeometry();
  const attrs: [string, BufferAttribute][] = [
    ['position', new BufferAttribute(t.position, 3)],
    // 法線・色は 1 頂点 4 バイト（buildingMesh.ts）。シェーダの法線は vec3 なので第 4 成分は使われない。
    // 色は 4 成分だと three.js が不透明度も使う（255 = 不透明）
    ['normal', new BufferAttribute(t.normal, 4, true)],
    ['color', new BufferAttribute(t.color, 4, true)],
  ];
  for (const [name, a] of attrs) {
    if (releaseAfterUpload) a.onUpload(releaseArray);
    geo.setAttribute(name, a);
  }
  const index = new BufferAttribute(t.index, 1);
  if (releaseAfterUpload) index.onUpload(releaseArray);
  geo.setIndex(index);
  const [x, y, z, r] = t.sphere;
  geo.boundingSphere = new Sphere(new Vector3(x, y, z), r);
  return geo;
}

interface Pending {
  resolve: (r: BuiltTile | null) => void;
  reject: (e: Error) => void;
}

export class BuildingLayer {
  readonly group = new Group();
  status: BuildingStatus = 'idle';
  count = 0;
  private readonly material = new MeshLambertMaterial({ vertexColors: true });
  /** 足元の色分け（グリッドに合わせたテクスチャ。u=東向き, v=南向き） */
  private readonly empty = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
  private readonly tint = {
    uMap: { value: this.empty as Texture },
    uMapOn: { value: 0 },
    uOv: { value: this.empty as Texture },
    uOvOn: { value: 0 },
    uHz: { value: this.empty as Texture },
    uHzOn: { value: 0 },
    uOvScale: { value: new Vector2(0, 0) },
  };
  private readonly cache = new Map<string, ArrayBuffer | null>();
  private tilesUrl: string | null = null;
  private sampler: HeightSampler | null = null;
  private ac: AbortController | null = null;
  private generation = 0;
  private enabled = false;
  private warned = false;
  private built = false;
  /** 頂点データを作る Worker（undefined = まだ作っていない、null = 使えない） */
  private worker: Worker | null | undefined = undefined;
  /** Worker に送った地形の世代 */
  private workerGridGen = -1;
  private workerSeq = 0;
  private readonly pending = new Map<number, Pending>();
  /** 頂点データを GPU に送った後に手放すか（テスト・デバッグ用に切り替えられる） */
  releaseAfterUpload = true;
  /** 最後の読み込みで Worker を使ったか（テスト・デバッグ用） */
  usedWorker = false;

  constructor(private readonly onUpdate: () => void) {
    this.group.name = 'buildings';
    this.empty.needsUpdate = true;
    // ローカル座標 (x, z) [m] → グリッドのテクスチャ座標。色は拡散色に混ぜる（陰影はそのまま）
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.tint);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec2 uOvScale;\nvarying vec2 vOvUv;\nvarying float vUp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOvUv = position.xz * uOvScale + 0.5;\nvUp = normal.y;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform sampler2D uMap;\nuniform float uMapOn;\nuniform sampler2D uOv;\nuniform float uOvOn;\nuniform sampler2D uHz;\nuniform float uHzOn;\nvarying vec2 vOvUv;\nvarying float vUp;',
        )
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
            // 写真: 屋根はその場所の写真の色、壁は写真の色を少しだけ混ぜる（白い箱ばかりにならないように）
            'if (uMapOn > 0.0) { vec4 m = texture2D(uMap, vOvUv); float roof = smoothstep(0.5, 0.9, vUp); vec3 c = mix(mix(diffuseColor.rgb, m.rgb * 0.9, 0.35), m.rgb * 1.08, roof); diffuseColor.rgb = mix(diffuseColor.rgb, c, uMapOn * m.a); }',
            'if (uOvOn > 0.0) { vec4 ov = texture2D(uOv, vOvUv); diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, ov.a * uOvOn); }',
            'if (uHzOn > 0.0) { vec4 hz = texture2D(uHz, vOvUv); diffuseColor.rgb = mix(diffuseColor.rgb, hz.rgb, hz.a * uHzOn); }',
          ].join('\n'),
        );
    };
  }

  /** 背景地図（写真）のテクスチャ（グリッドの範囲に貼ったもの）。屋根・壁に色を付ける。null で消す */
  setMap(tex: Texture | null, strength: number): void {
    this.tint.uMap.value = tex ?? this.empty;
    this.tint.uMapOn.value = tex ? strength : 0;
  }

  /** 最大浸水深・到達時間の色（グリッドと同じ大きさのテクスチャ、sRGB）。null で消す */
  setOverlay(tex: Texture | null, strength: number): void {
    this.tint.uOv.value = tex ?? this.empty;
    this.tint.uOvOn.value = tex ? strength : 0;
  }

  /** 公式の津波浸水想定（グリッドの範囲に貼ったタイル画像）。null で消す */
  setHazard(tex: Texture | null, opacity: number): void {
    this.tint.uHz.value = tex ?? this.empty;
    this.tint.uHzOn.value = tex ? opacity : 0;
  }

  setGrid(sampler: HeightSampler | null): void {
    this.sampler = sampler;
    if (sampler) this.tint.uOvScale.value.set(1 / (sampler.spec.nx * sampler.spec.dx), 1 / (sampler.spec.ny * sampler.spec.dx));
    this.clearMeshes();
    this.built = false;
    if (this.enabled) this.start();
  }

  /**
   * 作り直す（取得済みのタイルから）。GPU のリセット（WebGL コンテキストの復帰）の後に呼ぶ:
   * 頂点データは GPU に送った後に手放しているため、GPU 側のデータが失われたら作り直す必要がある。
   */
  rebuild(): void {
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
        const built = await this.build(buf, t.x, t.y, sampler, gen);
        if (!built || gen !== this.generation) continue;
        const mesh = new Mesh(geometryFromTile(built, this.releaseAfterUpload), this.material);
        mesh.name = `buildings-${key}`;
        this.group.add(mesh);
        this.count += built.count;
        this.onUpdate();
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
    if (ok === 0 && failed > 0) throw firstError ?? new Error('建物タイルを取得できませんでした');
  }

  /** 1タイル分の頂点データを作る（Worker が使えればそちらで、使えなければ時間を区切って画面の処理の中で） */
  private async build(buf: ArrayBuffer, tx: number, ty: number, sampler: HeightSampler, gen: number): Promise<BuiltTile | null> {
    const w = this.ensureWorker();
    if (w) {
      try {
        const r = await this.buildInWorker(w, buf, tx, ty, sampler, gen);
        this.usedWorker = true;
        return r;
      } catch (e) {
        if (gen !== this.generation) return null;
        // Worker が使えなくなった: 以後は画面の処理の中で作る
        console.info('[view3d] 建物の Worker を使えないため、画面の処理の中で作ります:', (e as Error)?.message ?? e);
        this.stopWorker();
      }
    }
    this.usedWorker = false;
    return this.buildOnMain(buf, tx, ty, sampler, gen);
  }

  private ensureWorker(): Worker | null {
    if (this.worker !== undefined) return this.worker;
    try {
      const w = new Worker(new URL('./buildingsWorker.ts', import.meta.url), { type: 'module', name: 'buildings-3d' });
      w.onmessage = (e: MessageEvent<{ type: string; id: number; result?: BuiltTile | null; error?: string }>) => {
        const m = e.data;
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.result ?? null);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        this.stopWorker(new Error(e.message || 'Worker error'));
      };
      this.worker = w;
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private stopWorker(err: Error = new Error('Worker stopped')): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private buildInWorker(w: Worker, buf: ArrayBuffer, tx: number, ty: number, sampler: HeightSampler, gen: number): Promise<BuiltTile | null> {
    if (this.workerGridGen !== gen) {
      // 足元の高さに使う地形（複製して送る。地形の配列は他でも使うので転送しない）
      const g = sampler.grid;
      w.postMessage({ type: 'grid', gen, spec: g.spec, z: g.z, kind: g.kind });
      this.workerGridGen = gen;
    }
    const id = ++this.workerSeq;
    return new Promise<BuiltTile | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // タイルは保持しているので複製して送る
      w.postMessage({ type: 'tile', id, gen, tx, ty, buf });
    });
  }

  /** 画面の処理の中で作る（SLICE_MS ごとに区切り、描画・操作の機会を与える） */
  private async buildOnMain(buf: ArrayBuffer, tx: number, ty: number, sampler: HeightSampler, gen: number): Promise<BuiltTile | null> {
    await yieldToMain();
    if (gen !== this.generation) return null;
    const g = sampler.grid;
    const it = buildTileSteps(buf, tx, ty, { spec: g.spec, z: g.z, kind: g.kind }, sampler);
    let t0 = performance.now();
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
      if (performance.now() - t0 > SLICE_MS) {
        await yieldToMain();
        if (gen !== this.generation) return null;
        t0 = performance.now();
      }
    }
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
    this.stopWorker();
    this.material.dispose();
    this.empty.dispose();
    this.cache.clear();
  }
}

/** 描画・入力の処理に順番を譲る */
function yieldToMain(): Promise<void> {
  return new Promise((res) => setTimeout(res, 0));
}
