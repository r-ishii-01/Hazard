/**
 * 3D ビュー（three.js）。
 *
 * ローカル座標 [m]: グリッド中心が原点、x=東、z=南、y=上（geo.ts の lonLatToLocalMeters）。
 * 地形・水面・建物・範囲外の海は `world` グループに入れ、scale.y = 鉛直強調倍率 とする。
 * 人物・避難場所ピン・経路は強調しない大きさで、足元の高さだけ強調した値に置く。
 *
 * 描画は setActive(true) の間だけ。状態・カメラ・時刻が変わったとき、または水面のさざ波を
 * 動かしている間だけ再描画する（操作が無い状態が続くとさざ波も止める）。
 */
import {
  ACESFilmicToneMapping,
  DataTexture,
  Group,
  MathUtils,
  NearestFilter,
  PerspectiveCamera,
  RGBAFormat,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AppStore } from '../core/store';
import type { AppActions } from '../core/controller';
import { INITIAL_CENTER, createGridSpec, lonLatToLocalMeters, TILE_SIZE, type GridSpec } from '../core/geo';
import { CELL_LAND, CELL_SEA, type AppState, type Basemap, type SimOutput, type TerrainGrid } from '../core/types';
import {
  ARRIVAL_CLASSES,
  BASEMAPS,
  GSI_ATTRIBUTION,
  HAZARD_TSUNAMI_TILES,
  OPENFREEMAP,
  RELIEF_TILES,
  depthToRgba,
} from '../data/sources';
import * as Sources from '../data/sources';
import { BuildingLayer } from './buildings';
import { Environment } from './environment';
import { LIGHT_UNIFORMS } from './environment';
import { Overlay, escapeHtml } from './overlay';
import { PeopleLayer } from './people';
import { HeightSampler } from './sampler';
import { ShelterLayer } from './shelters';
import { TerrainLayer } from './terrain';
import { TileCanvas } from './tileCanvas';
import { WaterLayer } from './water';
import { hazardTileMayExist } from '../map2d/hazardTiles';

/** 初期視点: 沖合の南南西から、仰角 約45° で鵠沼海岸を見る */
const INITIAL_AZIMUTH_DEG = 202;
const INITIAL_POLAR_DEG = 47;
const INITIAL_DISTANCE = 5800;
/** 見やすさ倍率: 画面上で人形がおよそ一定の大きさになるよう、カメラ距離に比例させる */
const SCALE_PER_METER = 0.0105;
const MAX_SCALE = 80;
/** 操作が無いとき、さざ波のアニメーションを続ける時間 [ms] */
const IDLE_ANIMATION_MS = 30000;
const IDLE_FPS = 24;
/** 地理院タイルなどを貼るキャンバスの上限 [px] */
const MAX_TEXTURE = 4096;

interface Seen {
  grid: TerrainGrid | null;
  exag: number;
  basemap: Basemap | null;
  reliefOn: boolean;
  hazardOn: boolean;
  hazardOpacity: number;
  buildingsOn: boolean;
  sheltersOn: boolean;
  simFlood: boolean;
  output: SimOutput | null;
  t: number;
  tide: number;
  people: AppState['people'] | null;
  plans: AppState['plans'] | null;
  selected: string | null;
  shelters: AppState['shelters'] | null;
  overlayMode: 'none' | 'maxDepth' | 'arrival';
  overlayOutput: SimOutput | null;
  overlayFrames: number;
  placing: boolean;
  terrainStatus: string;
  attribution: string;
}

/** 計算結果の更新番号（sim の実装が revision を持つ場合のみ） */
function outputRevision(output: SimOutput): number | null {
  const r = (output as SimOutput & { revision?: unknown }).revision;
  return typeof r === 'number' && Number.isFinite(r) ? r : null;
}

export class View3D {
  private readonly container: HTMLElement;
  private readonly store: AppStore;
  private readonly actions: AppActions;
  private readonly overlay: Overlay;
  private renderer: WebGLRenderer | null = null;
  private controls: OrbitControls | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(45, 1, 5, 300000);
  /** 鉛直強調をかけるグループ */
  private readonly world = new Group();
  private readonly env = new Environment();
  private readonly terrain = new TerrainLayer();
  private readonly water = new WaterLayer();
  private readonly buildings: BuildingLayer;
  private readonly people = new PeopleLayer();
  private readonly shelters = new ShelterLayer();
  private sampler: HeightSampler | null = null;
  private frameSpec: GridSpec;
  private basemapTiles: TileCanvas | null = null;
  private reliefTiles: TileCanvas | null = null;
  private hazardTiles: TileCanvas | null = null;
  private seen: Seen;
  private active = false;
  private disposed = false;
  private raf = 0;
  private needsRender = true;
  private lastRender = 0;
  private lastFrame = 0;
  private lastActivity = 0;
  private interacting = false;
  private scale = 1;
  private viewportW = 0;
  private viewportH = 0;
  private ro: ResizeObserver | null = null;
  private readonly reducedMotion: boolean;
  private camAnim: { fromPos: Vector3; fromTarget: Vector3; toPos: Vector3; toTarget: Vector3; t0: number; dur: number } | null = null;
  private framed = false;
  private pointer = { x: 0, y: 0, inside: false };
  private hoverPending = false;
  private lastHover = 0;
  private down: { x: number; y: number; t: number; id: number } | null = null;
  private readonly raycaster = new Raycaster();
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  private readonly waterSurfaceAt = (x: number, z: number): number | null => this.water.surfaceAt(x, z);
  private cameraDirty = true;
  private readonly lastCamPos = new Vector3(NaN, NaN, NaN);
  private readonly lastTarget = new Vector3(NaN, NaN, NaN);
  private overlayTime = 0;
  private peopleDirty = true;
  private sheltersDirty = true;
  /** 建物に付ける色分けのテクスチャ（最大浸水深・到達時間） */
  private overlayTex: DataTexture | null = null;

  constructor(container: HTMLElement, store: AppStore, actions: AppActions) {
    this.container = container;
    this.store = store;
    this.actions = actions;
    const s = store.get();
    this.frameSpec = s.terrain.grid?.spec ?? createGridSpec(s.params.resolution);
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.seen = {
      grid: null,
      exag: NaN,
      basemap: null,
      reliefOn: false,
      hazardOn: false,
      hazardOpacity: -1,
      buildingsOn: false,
      sheltersOn: true,
      simFlood: true,
      output: null,
      t: NaN,
      tide: NaN,
      people: null,
      plans: null,
      selected: null,
      shelters: null,
      overlayMode: 'none',
      overlayOutput: null,
      overlayFrames: -1,
      placing: false,
      terrainStatus: '',
      attribution: '',
    };
    this.overlay = new Overlay(container, { onReset: () => this.resetView(true) });
    // E2E テスト・デバッグ用
    (container as HTMLElement & { __view3d?: View3D }).__view3d = this;
    this.buildings = new BuildingLayer(() => {
      this.needsRender = true;
      this.seen.attribution = '';
    });

    try {
      this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false });
    } catch (e) {
      console.warn('[view3d] WebGL を初期化できませんでした', e);
      this.overlay.setMessage('この環境では 3D 表示（WebGL）を利用できません。2D 地図をご利用ください。');
      return;
    }
    const r = this.renderer;
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.setClearColor(0xcfdfea, 1);
    r.domElement.setAttribute('aria-label', '3Dビュー（ドラッグで回転、右ドラッグまたは矢印キーで移動、ホイールで拡大縮小）');
    r.domElement.tabIndex = 0;
    this.overlay.mountCanvas(r.domElement);

    // シーン構成
    this.scene.fog = this.env.fog;
    this.scene.add(this.env.sky, this.env.hemi, this.env.sun);
    this.world.add(this.env.outer, this.terrain.group, this.buildings.group);
    this.world.name = 'world';
    this.scene.add(this.world, this.people.routes, this.shelters.group, this.people.group);

    // 操作
    const c = new OrbitControls(this.camera, r.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.12;
    c.screenSpacePanning = false;
    c.zoomToCursor = true;
    c.minDistance = 12;
    c.maxDistance = 26000;
    c.maxPolarAngle = MathUtils.degToRad(84);
    c.rotateSpeed = 0.6;
    c.zoomSpeed = 1.1;
    c.panSpeed = 1.0;
    c.keyPanSpeed = 25;
    // キーボード（矢印キー）での移動。キャンバスにフォーカスがあるときだけ
    c.listenToKeyEvents(r.domElement);
    c.addEventListener('start', () => {
      this.interacting = true;
      this.camAnim = null;
      this.touch();
    });
    c.addEventListener('end', () => {
      this.interacting = false;
      this.touch();
    });
    this.controls = c;
    this.resetView(false);

    // ポインター（配置・選択・カーソル情報）
    const el = r.domElement;
    this.on(el, 'pointerdown', (ev) => this.onPointerDown(ev as PointerEvent));
    this.on(el, 'pointerup', (ev) => this.onPointerUp(ev as PointerEvent));
    this.on(el, 'pointermove', (ev) => this.onPointerMove(ev as PointerEvent));
    this.on(el, 'pointerleave', () => this.onPointerLeave());
    this.on(el, 'webglcontextlost', (ev) => {
      ev.preventDefault();
      this.overlay.setMessage('3D 表示が一時的に停止しました（GPU のリセット）。');
    });
    this.on(el, 'webglcontextrestored', () => {
      this.overlay.setMessage(null);
      this.needsRender = true;
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  // ---------------------------------------------------------------------------
  // 公開 API
  // ---------------------------------------------------------------------------

  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    if (active) {
      this.needsRender = true;
      this.touch();
      this.resize();
      if (!this.raf && this.renderer) this.raf = requestAnimationFrame(this.frame);
    } else {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.overlay.setTooltip(null);
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.listeners.length = 0;
    this.controls?.dispose();
    this.basemapTiles?.dispose();
    this.reliefTiles?.dispose();
    this.hazardTiles?.dispose();
    this.overlayTex?.dispose();
    this.buildings.dispose();
    this.people.dispose();
    this.shelters.dispose();
    this.water.dispose();
    this.terrain.dispose();
    this.env.dispose();
    this.scene.clear();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.overlay.dispose();
  }

  /** テスト・デバッグ用の内部情報 */
  debugInfo(): Record<string, unknown> {
    const r = this.renderer;
    return {
      active: this.active,
      webgl: !!r,
      memory: r ? { ...r.info.memory } : null,
      programs: r?.info.programs?.length ?? 0,
      calls: r?.info.render.calls ?? 0,
      triangles: r?.info.render.triangles ?? 0,
      scale: this.scale,
      buildings: { status: this.buildings.status, count: this.buildings.count },
      basemap: this.basemapTiles ? { status: this.basemapTiles.status, zoom: this.basemapTiles.zoom, w: this.basemapTiles.canvas.width, h: this.basemapTiles.canvas.height } : null,
      people: this.people.count,
      camera: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, near: this.camera.near },
      viewport: [this.viewportW, this.viewportH],
    };
  }

  // ---------------------------------------------------------------------------
  // ループ
  // ---------------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    this.raf = 0;
    if (!this.active || this.disposed || !this.renderer || !this.controls) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - (this.lastFrame || now)) / 1000));
    this.lastFrame = now;
    if (this.viewportW < 2 || this.viewportH < 2) return;
    const s = this.store.get();

    let camChanged = false;
    if (this.camAnim) camChanged = this.stepCameraAnim(now);
    if (this.controls.update(dt)) camChanged = true;
    // 外部からカメラが動かされた場合も検出する
    if (!this.lastCamPos.equals(this.camera.position) || !this.lastTarget.equals(this.controls.target)) camChanged = true;
    if (camChanged || this.cameraDirty) {
      this.cameraDirty = false;
      this.onCameraChanged();
      camChanged = true;
    }

    this.applyState(s, now);

    const playing = s.time.playing;
    const animate = !this.reducedMotion && this.sampler !== null && (playing || now - this.lastActivity < IDLE_ANIMATION_MS);
    const minInterval = playing || this.interacting || camChanged || this.camAnim ? 0 : 1000 / IDLE_FPS;
    if (this.needsRender || (animate && now - this.lastRender >= minInterval - 2)) this.render(now);

    if (this.hoverPending && now - this.lastHover > 60) this.processHover(now);
  };

  private render(now: number): void {
    const r = this.renderer!;
    LIGHT_UNIFORMS.uTime.value = now / 1000;
    this.camera.updateMatrixWorld();
    if (this.people.count > 0 && this.sampler && this.seen.grid) {
      // 選択リングの脈動などのため毎回更新（数人〜数十人なので軽い）
      this.updatePeople(now);
    }
    r.render(this.scene, this.camera);
    this.needsRender = false;
    this.lastRender = now;
  }

  private touch(): void {
    this.lastActivity = performance.now();
    this.needsRender = true;
  }

  // ---------------------------------------------------------------------------
  // 状態の反映（毎フレーム、変わったものだけ）
  // ---------------------------------------------------------------------------

  private applyState(s: AppState, now: number): void {
    const seen = this.seen;
    const grid = s.terrain.grid;

    if (grid !== seen.grid) {
      seen.grid = grid;
      this.setGrid(grid);
      seen.basemap = null; // タイルの範囲がグリッドに依存
      seen.reliefOn = false;
      seen.hazardOn = false;
      seen.hazardOpacity = -1;
      seen.people = null;
      seen.shelters = null;
      seen.overlayOutput = null;
      seen.overlayFrames = -1;
      seen.t = NaN;
      seen.attribution = '';
      this.touch();
    }

    if (s.exaggeration !== seen.exag) {
      seen.exag = s.exaggeration;
      const e = Math.max(0.1, s.exaggeration || 1);
      this.world.scale.y = e;
      this.world.updateMatrixWorld(true);
      this.terrain.setExaggeration(e);
      this.peopleDirty = true;
      this.sheltersDirty = true;
      this.cameraDirty = true;
      this.touch();
    }

    // 地図タイル
    if (grid && s.basemap !== seen.basemap) {
      seen.basemap = s.basemap;
      this.basemapTiles?.dispose();
      this.basemapTiles = this.createTiles(grid, BASEMAPS[s.basemap], 17);
      this.terrain.setMap(this.basemapTiles.texture);
      seen.attribution = '';
      this.touch();
    }
    const reliefOn = !!grid && s.layers.elevation;
    if (reliefOn !== seen.reliefOn) {
      seen.reliefOn = reliefOn;
      this.reliefTiles?.dispose();
      this.reliefTiles = reliefOn && grid ? this.createTiles(grid, RELIEF_TILES, 15) : null;
      this.terrain.setRelief(this.reliefTiles?.texture ?? null, 0.75);
      seen.attribution = '';
      this.touch();
    }
    const hazardOn = !!grid && s.layers.officialHazard;
    if (hazardOn !== seen.hazardOn) {
      seen.hazardOn = hazardOn;
      this.hazardTiles?.dispose();
      // 公式の浸水想定はズーム15（約4.8 m/画素）で十分（地形のセルは約8〜31 m）。存在しないタイルは要求しない
      this.hazardTiles = hazardOn && grid ? this.createTiles(grid, HAZARD_TSUNAMI_TILES, 15, (x, y, z) => hazardTileMayExist(z, x, y)) : null;
      seen.hazardOpacity = -1;
      seen.attribution = '';
      this.touch();
    }
    if (hazardOn && s.layers.officialHazardOpacity !== seen.hazardOpacity) {
      seen.hazardOpacity = s.layers.officialHazardOpacity;
      const op = Math.max(0, Math.min(1, s.layers.officialHazardOpacity));
      this.terrain.setHazard(this.hazardTiles?.texture ?? null, op);
      this.buildings.setHazard(this.hazardTiles?.texture ?? null, op);
      this.touch();
    } else if (!hazardOn) {
      this.terrain.setHazard(null, 0);
      this.buildings.setHazard(null, 0);
    }

    if (s.layers.buildings !== seen.buildingsOn) {
      seen.buildingsOn = s.layers.buildings;
      this.buildings.setEnabled(s.layers.buildings);
      seen.attribution = '';
      this.touch();
    }
    if (s.layers.shelters !== seen.sheltersOn) {
      seen.sheltersOn = s.layers.shelters;
      this.shelters.group.visible = s.layers.shelters;
      this.touch();
    }

    // 水面
    const output = s.sim.output;
    const simFlood = s.layers.simFlood;
    const tide = s.params.tideTP;
    if (output !== seen.output || s.time.t !== seen.t || tide !== seen.tide || simFlood !== seen.simFlood || (output && s.sim.status === 'running')) {
      const tChanged = s.time.t !== seen.t || output !== seen.output;
      seen.output = output;
      seen.t = s.time.t;
      seen.tide = tide;
      seen.simFlood = simFlood;
      const shown = simFlood ? output : null;
      if (this.water.update(shown, s.time.t, tide, String(s.sim.runId))) {
        this.env.setSeaLevel(tide, this.water.edgeEta);
        this.needsRender = true;
      }
      if (tChanged) {
        this.peopleDirty = true;
        // カーソル位置の浸水深も時刻に合わせて更新
        if (this.pointer.inside) this.hoverPending = true;
      }
    }

    // 最大浸水深・到達時間（頂点色）。sim の出力が更新番号（revision）を持てばそれで変化を判定する
    const mode = s.layers.maxDepth ? 'maxDepth' : s.layers.arrival ? 'arrival' : 'none';
    const frames = output ? outputRevision(output) ?? output.framesReady() : 0;
    if (
      grid &&
      (mode !== seen.overlayMode ||
        output !== seen.overlayOutput ||
        (mode !== 'none' && frames !== seen.overlayFrames && now - this.overlayTime > 1000))
    ) {
      seen.overlayMode = mode;
      seen.overlayOutput = output;
      seen.overlayFrames = frames;
      this.overlayTime = now;
      const colors = mode !== 'none' && output ? this.overlayColors(grid, output, mode) : null;
      this.terrain.setOverlay(colors);
      this.buildings.setOverlay(colors ? this.overlayTexture(grid, colors) : null, 0.85);
      this.needsRender = true;
    }

    // 人物
    if (s.people !== seen.people || s.plans !== seen.plans) {
      seen.people = s.people;
      seen.plans = s.plans;
      this.people.sync(s.people, s.plans, this.sampler);
      this.peopleDirty = true;
      this.touch();
    }
    if (s.selectedPersonId !== seen.selected) {
      seen.selected = s.selectedPersonId;
      this.peopleDirty = true;
      this.touch();
    }
    if (this.peopleDirty) {
      this.peopleDirty = false;
      this.needsRender = true;
    }

    // 避難場所
    if (s.shelters !== seen.shelters) {
      seen.shelters = s.shelters;
      this.shelters.set(s.shelters, this.sampler);
      this.sheltersDirty = true;
    }
    if (this.sheltersDirty) {
      this.sheltersDirty = false;
      this.shelters.update(this.world.scale.y, this.scale, this.viewportH, this.camera.projectionMatrix.elements[5]);
      this.needsRender = true;
    }

    if ((s.placing !== null) !== seen.placing) {
      seen.placing = s.placing !== null;
      this.overlay.setPlacing(seen.placing);
    }

    // 状態メッセージ
    const ts = `${s.terrain.status}|${s.terrain.message ?? ''}`;
    if (ts !== seen.terrainStatus) {
      seen.terrainStatus = ts;
      if (s.terrain.status === 'loading' || (s.terrain.status === 'idle' && !grid)) this.overlay.setMessage('地形データを読み込み中…');
      else if (s.terrain.status === 'error' && !grid) this.overlay.setMessage(`地形データを読み込めませんでした${s.terrain.message ? `\n${s.terrain.message}` : ''}`);
      else this.overlay.setMessage(null);
    }

    if (!seen.attribution) {
      seen.attribution = this.attributionHtml(s);
      this.overlay.setAttribution(seen.attribution);
    }
    // 何か変わったら、しばらくさざ波のアニメーションを続ける
    if (this.needsRender) this.lastActivity = now;
  }

  private createTiles(grid: TerrainGrid, source: (typeof BASEMAPS)['pale'], maxZoom: number, exists?: (x: number, y: number, z: number) => Promise<boolean>): TileCanvas {
    const r = this.renderer!;
    const spec = grid.spec;
    // 陸のセルを含むタイルだけ取得（海だけのタイルは使わない）
    const landTile = (x: number, y: number, z: number): boolean => {
      const scale = Math.pow(2, spec.zoom - z);
      const i0 = Math.max(0, Math.floor((x * TILE_SIZE * scale - spec.originPx) / spec.cellPx));
      const i1 = Math.min(spec.nx - 1, Math.floor(((x + 1) * TILE_SIZE * scale - spec.originPx) / spec.cellPx));
      const j0 = Math.max(0, Math.floor((y * TILE_SIZE * scale - spec.originPy) / spec.cellPx));
      const j1 = Math.min(spec.ny - 1, Math.floor(((y + 1) * TILE_SIZE * scale - spec.originPy) / spec.cellPx));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (grid.kind[j * spec.nx + i] !== CELL_SEA) return true;
      return false;
    };
    return new TileCanvas({
      spec,
      source,
      maxSize: Math.min(MAX_TEXTURE, r.capabilities.maxTextureSize),
      maxZoom,
      anisotropy: Math.min(8, r.capabilities.getMaxAnisotropy()),
      filter: landTile,
      exists,
      onUpdate: () => {
        this.needsRender = true;
      },
      onFirstContent: () => {
        this.seen.attribution = '';
      },
      onDone: (status) => {
        if (status === 'failed') console.info(`[view3d] タイルを取得できませんでした（${source.label}）。代替表示を使います。`);
        this.seen.attribution = '';
        this.needsRender = true;
      },
    });
  }

  private overlayColors(grid: TerrainGrid, output: SimOutput, mode: 'maxDepth' | 'arrival'): Uint8ClampedArray {
    const n = grid.spec.nx * grid.spec.ny;
    const out = new Uint8ClampedArray(n * 4);
    const cls = ARRIVAL_CLASSES.map((c) => {
      const v = parseInt(c.color.slice(1), 16);
      return { maxMin: c.maxMin, r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
    });
    for (let k = 0; k < n; k++) {
      if (grid.kind[k] === CELL_SEA) continue;
      if (mode === 'maxDepth') {
        const d = output.maxDepth[k];
        if (d >= 0.01) {
          depthToRgba(d, out, k * 4);
          out[k * 4 + 3] = 255;
        }
      } else {
        const a = output.arrival[k];
        if (Number.isFinite(a)) {
          const m = a / 60;
          const c = cls.find((q) => m <= q.maxMin) ?? cls[cls.length - 1];
          out[k * 4] = c.r;
          out[k * 4 + 1] = c.g;
          out[k * 4 + 2] = c.b;
          out[k * 4 + 3] = 255;
        }
      }
    }
    return out;
  }

  /** 頂点色と同じ色分けを、建物に付けるためのテクスチャにする（グリッドと同じ大きさ・再利用） */
  private overlayTexture(grid: TerrainGrid, rgba: Uint8ClampedArray): DataTexture {
    const { nx, ny } = grid.spec;
    let tex = this.overlayTex;
    if (!tex || tex.image.width !== nx || tex.image.height !== ny) {
      tex?.dispose();
      tex = new DataTexture(new Uint8Array(nx * ny * 4), nx, ny, RGBAFormat);
      tex.colorSpace = SRGBColorSpace;
      tex.flipY = false;
      tex.magFilter = NearestFilter;
      tex.minFilter = NearestFilter;
      this.overlayTex = tex;
    }
    (tex.image.data as Uint8Array).set(rgba);
    tex.needsUpdate = true;
    return tex;
  }

  private attributionHtml(s: AppState): string {
    const parts: string[] = [];
    const bm = BASEMAPS[s.basemap];
    // 実際にタイルを描けたときだけ出典を出す（取得できずに段彩で代替している間は出さない）
    if (this.basemapTiles?.hasContent) {
      // 写真のズーム14以上は全国最新写真で「地理院タイル」の出典のみ。ズーム9〜13（ランドサット）を使うときだけ追加の出所を併記
      const simple = bm.attribution === GSI_ATTRIBUTION || (s.basemap === 'photo' && this.basemapTiles.zoom >= 14);
      parts.push(simple ? `${GSI_ATTRIBUTION}（${escapeHtml(bm.label)}）` : bm.attribution);
    }
    if (this.reliefTiles?.hasContent) parts.push(RELIEF_TILES.attribution);
    if (this.hazardTiles?.hasContent) parts.push(HAZARD_TSUNAMI_TILES.attribution);
    const grid = s.terrain.grid;
    if (grid) {
      // 標高タイルから作った地形は「加工して作成」の記載（リンク付き）。合成地形はその旨を表示
      const demHtml = (Sources as unknown as Record<string, unknown>).DEM_CREDIT_HTML;
      const derived = typeof demHtml === 'string' ? demHtml : `${GSI_ATTRIBUTION}（標高タイル）を加工して作成`;
      parts.push(grid.source === 'synthetic' ? `地形: ${escapeHtml(grid.sourceLabel || '合成（近似）地形')}` : `地形: ${derived}`);
    }
    if (s.layers.buildings && this.buildings.status !== 'failed') parts.push(`建物: ${OPENFREEMAP.attribution}`);
    return parts.join(' ｜ ');
  }

  // ---------------------------------------------------------------------------
  // 地形
  // ---------------------------------------------------------------------------

  private setGrid(grid: TerrainGrid | null): void {
    this.sampler = grid ? new HeightSampler(grid) : null;
    this.terrain.setGrid(grid);
    this.water.setGrid(grid, this.terrain.index);
    if (this.water.mesh) this.world.add(this.water.mesh);
    this.water.invalidate();
    this.buildings.setGrid(this.sampler);
    this.people.rebuildRoutes(this.sampler);
    // 地形が無い間は人物・避難場所を出さない
    this.people.group.visible = !!grid;
    this.people.routes.visible = !!grid;
    if (grid) {
      this.frameSpec = grid.spec;
      const { nx, ny, dx } = grid.spec;
      const hw = ((nx - 1) / 2) * dx;
      const hh = ((ny - 1) / 2) * dx;
      // 東西端の海岸線: 南端から北へたどり、陸のセルに当たる手前（海・河川が続く北端）の位置
      const coastAt = (i: number): number => {
        let j0 = ny - 1;
        for (let j = ny - 1; j >= 0; j--) {
          if (grid.kind[j * nx + i] === CELL_LAND) break;
          j0 = j;
        }
        return (j0 + 0.5 - ny / 2) * dx - dx / 2;
      };
      this.env.setDomain(-hw, hw, -hh, hh, coastAt(0), coastAt(nx - 1));
      if (!this.framed) {
        this.framed = true;
        this.resetView(false);
      }
    }
    this.cameraDirty = true;
    this.sheltersDirty = true;
    this.peopleDirty = true;
  }

  // ---------------------------------------------------------------------------
  // カメラ
  // ---------------------------------------------------------------------------

  private initialCamera(): { pos: Vector3; target: Vector3 } {
    const t = lonLatToLocalMeters(this.frameSpec, INITIAL_CENTER.lon, INITIAL_CENTER.lat);
    const target = new Vector3(t.x, 0, t.z);
    const az = MathUtils.degToRad(INITIAL_AZIMUTH_DEG);
    const polar = MathUtils.degToRad(INITIAL_POLAR_DEG);
    // 縦長の画面では少し引く
    const aspect = this.viewportW > 0 && this.viewportH > 0 ? this.viewportW / this.viewportH : 1.6;
    const dist = INITIAL_DISTANCE * (aspect < 1.3 ? Math.min(1.9, 1.3 / aspect) : 1);
    const dir = new Vector3(Math.sin(az) * Math.sin(polar), Math.cos(polar), -Math.cos(az) * Math.sin(polar));
    return { pos: target.clone().addScaledVector(dir, dist), target };
  }

  private resetView(animate: boolean): void {
    if (!this.controls) return;
    const { pos, target } = this.initialCamera();
    if (!animate) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.cameraDirty = true;
      this.needsRender = true;
      return;
    }
    this.camAnim = {
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: pos,
      toTarget: target,
      t0: performance.now(),
      dur: 900,
    };
    this.touch();
  }

  private stepCameraAnim(now: number): boolean {
    const a = this.camAnim!;
    const f = Math.min(1, (now - a.t0) / a.dur);
    const e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
    this.camera.position.lerpVectors(a.fromPos, a.toPos, e);
    this.controls!.target.lerpVectors(a.fromTarget, a.toTarget, e);
    if (f >= 1) this.camAnim = null;
    return true;
  }

  /** カメラが動いたとき: 地面より下に行かないように・近接面・霧・見やすさ倍率・方位 */
  private onCameraChanged(): void {
    const cam = this.camera;
    const c = this.controls!;
    const exag = this.world.scale.y;
    // 注視点を計算範囲の近くに制限
    const hw = (this.frameSpec.nx / 2) * this.frameSpec.dx + 1500;
    const hh = (this.frameSpec.ny / 2) * this.frameSpec.dx + 1500;
    const tx = MathUtils.clamp(c.target.x, -hw, hw);
    const tz = MathUtils.clamp(c.target.z, -hh, hh);
    if (tx !== c.target.x || tz !== c.target.z) {
      cam.position.x += tx - c.target.x;
      cam.position.z += tz - c.target.z;
      c.target.x = tx;
      c.target.z = tz;
    }
    // 地面より上に保つ
    let ground = 0;
    if (this.sampler) ground = Math.max(0, this.sampler.height(cam.position.x, cam.position.z)) * exag;
    const minY = ground + 2;
    if (cam.position.y < minY) {
      cam.position.y = minY;
      cam.lookAt(c.target);
    }
    const dist = cam.position.distanceTo(c.target);
    const h = Math.max(1, cam.position.y - ground);
    cam.near = MathUtils.clamp(Math.min(h, dist) * 0.2, 1, 1500);
    cam.far = 300000;
    cam.updateProjectionMatrix();
    this.env.update(cam, dist);
    // 見やすさ倍率（画面の高さ 800px のとき 距離 × 0.0105）
    const vh = Math.max(300, this.viewportH || 800);
    this.scale = MathUtils.clamp((dist * SCALE_PER_METER * 800) / vh, 1, MAX_SCALE);
    this.sheltersDirty = true;
    this.peopleDirty = true;
    // 方位磁針（カメラの向いている方位）
    const dx = c.target.x - cam.position.x;
    const dz = c.target.z - cam.position.z;
    this.overlay.setHeading(Math.atan2(dx, -dz));
    this.updateNote();
    this.lastCamPos.copy(cam.position);
    this.lastTarget.copy(c.target);
    // 止まっているポインターの下にあるものも変わるので、ツールチップ・カーソル情報を更新
    if (this.pointer.inside) this.hoverPending = true;
    this.needsRender = true;
  }

  private updateNote(): void {
    const exag = this.world.scale.y;
    const S = this.scale;
    const sx = S < 10 ? Math.round(S) : Math.round(S / 5) * 5;
    const e = Number.isInteger(exag) ? String(exag) : exag.toFixed(1);
    this.overlay.setNote(
      `高さ ×${e} 強調 ・ 人物 約×${sx} 表示`,
      `地形・水面・建物の高さは実際の ${e} 倍に強調しています。\n人物と避難場所のピンは、見やすさのため実物（大人 約1.7m）の約 ${sx} 倍の大きさで表示しています（拡大はカメラの距離に応じて変わります）。\n浸水時に体が水に隠れる割合は、実際の水深と身長の比のとおりです。`,
    );
  }

  private resize(): void {
    if (!this.renderer) return;
    const w = Math.round(this.container.clientWidth);
    const h = Math.round(this.container.clientHeight);
    if (w === this.viewportW && h === this.viewportH) return;
    this.viewportW = w;
    this.viewportH = h;
    if (w < 2 || h < 2) return;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.overlay.layout();
    if (!this.framed && !this.camAnim) this.resetView(false);
    this.cameraDirty = true;
    this.needsRender = true;
  }

  // ---------------------------------------------------------------------------
  // 人物
  // ---------------------------------------------------------------------------

  private updatePeople(now: number): void {
    const s = this.store.get();
    const grid = s.terrain.grid;
    if (!grid || !this.sampler || grid !== this.sampler.grid) return;
    this.people.update({
      t: s.time.t,
      grid,
      output: s.sim.output,
      sampler: this.sampler,
      exag: this.world.scale.y,
      scale: this.scale,
      viewportH: this.viewportH,
      p11: this.camera.projectionMatrix.elements[5],
      now,
      selectedId: s.selectedPersonId,
      camera: this.camera,
      viewportW: this.viewportW,
      showFlood: s.layers.simFlood && !!s.sim.output,
      waterSurfaceAt: this.waterSurfaceAt,
    });
  }

  // ---------------------------------------------------------------------------
  // ポインター操作
  // ---------------------------------------------------------------------------

  private on(t: EventTarget, type: string, fn: EventListener): void {
    t.addEventListener(type, fn);
    this.listeners.push([t, type, fn]);
  }

  private localXY(ev: PointerEvent): { x: number; y: number } {
    const rect = this.renderer!.domElement.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private onPointerDown(ev: PointerEvent): void {
    const p = this.localXY(ev);
    this.down = { x: p.x, y: p.y, t: performance.now(), id: ev.pointerId };
    this.camAnim = null;
    this.touch();
  }

  private onPointerUp(ev: PointerEvent): void {
    const d = this.down;
    this.down = null;
    if (!d || d.id !== ev.pointerId || ev.button !== 0) return;
    const p = this.localXY(ev);
    if (Math.hypot(p.x - d.x, p.y - d.y) > 6 || performance.now() - d.t > 700) return;
    this.handleClick(p.x, p.y);
  }

  private onPointerMove(ev: PointerEvent): void {
    const p = this.localXY(ev);
    this.pointer = { x: p.x, y: p.y, inside: true };
    this.hoverPending = true;
    this.lastActivity = performance.now();
  }

  private onPointerLeave(): void {
    this.pointer.inside = false;
    this.hoverPending = false;
    this.overlay.setTooltip(null);
    if (this.store.get().cursor) this.actions.setCursor(null);
  }

  private handleClick(x: number, y: number): void {
    const s = this.store.get();
    if (s.placing) {
      const hit = this.pickGround(x, y);
      if (!hit || !this.sampler) {
        this.overlay.toast('計算範囲の中（地形の上）に置いてください');
        return;
      }
      const k = this.sampler.cellIndex(hit.x, hit.z);
      if (k < 0) {
        this.overlay.toast('計算範囲の中（地形の上）に置いてください');
        return;
      }
      if (this.sampler.grid.kind[k] === CELL_SEA) {
        this.overlay.toast('海や川の上には置けません');
        return;
      }
      const ll = this.sampler.toLonLat(hit.x, hit.z);
      this.actions.addPerson(s.placing, ll.lon, ll.lat);
      return;
    }
    const id = this.people.pick(x, y, this.camera, this.viewportW, this.viewportH);
    if (id) this.actions.selectPerson(id);
    else if (s.selectedPersonId) this.actions.selectPerson(null);
  }

  private processHover(now: number): void {
    this.hoverPending = false;
    this.lastHover = now;
    if (!this.pointer.inside || !this.sampler) return;
    const { x, y } = this.pointer;
    const s = this.store.get();
    // ツールチップ（人物 → 避難場所）
    let tip: string | null = null;
    const id = this.people.pick(x, y, this.camera, this.viewportW, this.viewportH);
    if (id) {
      const sx = this.scale < 10 ? Math.round(this.scale) : Math.round(this.scale / 5) * 5;
      tip = `${this.people.describe(id) ?? ''}\n${sx <= 1 ? '※ 人物はほぼ実寸（約1.7m）で表示' : `※ 人物は見やすさのため実物の約 ×${sx} で表示`}`;
    } else if (s.layers.shelters) {
      const sh = this.shelters.pick(x, y, this.camera, this.viewportW, this.viewportH);
      if (sh) tip = ShelterLayer.describe(sh);
    }
    this.overlay.setTooltip(tip, x, y);
    // カーソル位置の情報
    const hit = this.pickGround(x, y);
    if (!hit) {
      if (s.cursor) this.actions.setCursor(null);
      return;
    }
    const ll = this.sampler.toLonLat(hit.x, hit.z);
    const ground = this.sampler.height(hit.x, hit.z);
    let depth: number | null = null;
    let waterDepth: number | undefined;
    const out = s.sim.output;
    const k = this.sampler.cellIndex(hit.x, hit.z);
    const sea = k >= 0 && this.sampler.grid.kind[k] === CELL_SEA;
    if (out && out.framesReady() > 0 && k >= 0 && out.spec.nx === this.sampler.grid.spec.nx && out.spec.ny === this.sampler.grid.spec.ny) {
      const d = out.depthAt(Math.max(0, Math.min(s.time.t, out.timeReady())), k);
      // 海・川のセルの全水深は「浸水深」ではないので、水深として別に渡す（2D 地図と同じ扱い）
      if (sea) waterDepth = Number.isFinite(d) ? Math.max(0, d) : undefined;
      else depth = Number.isFinite(d) ? Math.max(0, d) : null;
    }
    this.actions.setCursor({ lon: ll.lon, lat: ll.lat, ground, depth, kind: k >= 0 ? (sea ? 'sea' : 'land') : undefined, waterDepth });
  }

  /** 画面座標 → 地形との交点（ローカル座標）。高さ場をレイマーチングで調べる */
  private pickGround(px: number, py: number): { x: number; z: number } | null {
    const sm = this.sampler;
    if (!sm || this.viewportW < 2) return null;
    const ndc = new Vector2((px / this.viewportW) * 2 - 1, -(py / this.viewportH) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    const e = this.world.scale.y;
    // xz の範囲との交差（スラブ法）
    let t0 = 0;
    let t1 = 400000;
    const slab = (oc: number, dc: number, lo: number, hi: number): boolean => {
      if (Math.abs(dc) < 1e-12) return oc >= lo && oc <= hi;
      let a = (lo - oc) / dc;
      let b = (hi - oc) / dc;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      return t0 <= t1;
    };
    if (!slab(o.x, d.x, -sm.halfW, sm.halfW) || !slab(o.z, d.z, -sm.halfH, sm.halfH)) return null;
    const horiz = Math.hypot(d.x, d.z);
    const step = horiz > 1e-6 ? (sm.dx * 0.5) / horiz : t1 - t0;
    const f = (t: number) => o.y + d.y * t - sm.height(o.x + d.x * t, o.z + d.z * t) * e;
    let prevT = t0;
    let prevF = f(t0);
    if (prevF <= 0) return { x: o.x + d.x * t0, z: o.z + d.z * t0 };
    const maxSteps = 6000;
    let n = 0;
    for (let t = t0 + step; t <= t1 + step && n < maxSteps; t += step, n++) {
      const tt = Math.min(t, t1);
      const v = f(tt);
      if (v <= 0) {
        let lo = prevT;
        let hi = tt;
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) / 2;
          if (f(mid) > 0) lo = mid;
          else hi = mid;
        }
        return { x: o.x + d.x * hi, z: o.z + d.z * hi };
      }
      prevT = tt;
      prevF = v;
      if (tt >= t1) break;
    }
    void prevF;
    return null;
  }
}
