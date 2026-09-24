/**
 * 2D 地図ビュー（MapLibre GL JS v6）。
 *
 * - 背景地図（地理院タイル）・色別標高・公式の津波浸水想定（ハザードマップポータルサイト）をラスターで重ねる。
 * - シミュレーション結果（現在の浸水・海面の偏差・引き波で露出した海底／最大浸水深／到達時間）は
 *   1セル = 1ピクセルのキャンバスを ImageSource に転送して表示する（グリッド四隅に正確に合わせる）。
 * - 避難場所・人物・避難経路・計算範囲を重ねる。人物は配置モードで地図クリックにより追加、ドラッグで移動。
 *
 * 描画は requestAnimationFrame にまとめ、時刻・レイヤー・データが変わったときだけ更新する。
 * 浸水画像の更新は最大 30 回/秒。
 */
import {
  AttributionControl,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type ImageSource,
  type MapMouseEvent,
  type GeoJSONSource,
} from 'maplibre-gl';
import type { AppStore } from '../core/store';
import type { AppActions } from '../core/controller';
import { CELL_SEA, type AppState, type Basemap, type SimOutput, type TerrainGrid } from '../core/types';
import { INITIAL_CENTER, INITIAL_ZOOM, createGridSpec, gridCornerCoordinates, lonLatToCell, type GridSpec } from '../core/geo';
import { BASEMAPS } from '../data/sources';
import { POIS, POI_ATTRIBUTION } from '../data/poi';
import { PERSON_PROFILES } from '../people';
import { sampleGround } from '../terrain';
import { injectMap2dStyles } from './css';
import { CellCanvas, buildFloodReference, paintArrival, paintFlood, paintMaxDepth, specsMatch, type FloodReference } from './rasters';
import { IDS, SIM_OPACITY, basemapLayer, basemapLayerId, buildStyle, domainGeoJSON, rasterSource } from './style';
import { PeopleLayer, type PeopleContext } from './people';
import { PoiLayer, ShelterLayer, createDomainLabel } from './shelters';
// MapLibre v6 のワーカーは別ファイル。Vite の事前バンドル／本番ビルドでは既定の相対 URL が解決できないので、
// Vite にワーカーとしてバンドルさせ、その URL を明示する。
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(maplibreWorkerUrl);

type Coords = [[number, number], [number, number], [number, number], [number, number]];

/** 表示できる範囲（計算範囲の周囲をゆったり） */
const MAX_BOUNDS: [[number, number], [number, number]] = [
  [139.25, 35.17],
  [139.7, 35.47],
];

/** 浸水画像の最短更新間隔 [ms]（≦30 回/秒） */
const FLOOD_INTERVAL_MS = 33;
/** 計算中の最大浸水深・到達時間の更新間隔 [ms] */
const GROWING_INTERVAL_MS = 700;
/** 経路の更新間隔 [ms] */
const ROUTE_INTERVAL_MS = 66;
/** カーソル情報の更新間隔 [ms] */
const CURSOR_INTERVAL_MS = 60;

const JA_LOCALE = {
  'AttributionControl.ToggleAttribution': '出典の表示を切り替え',
  'AttributionControl.MapFeedback': '地図のフィードバック',
  'Map.Title': '地図',
  'Marker.Title': 'マーカー',
  'NavigationControl.ResetBearing': '北を上にする',
  'NavigationControl.ZoomIn': '拡大',
  'NavigationControl.ZoomOut': '縮小',
  'Popup.Close': '閉じる',
  'ScaleControl.Meters': 'm',
  'ScaleControl.Kilometers': 'km',
  'CooperativeGesturesHandler.MobileHelpText': '2本指で地図を動かします',
};

/** シミュレーション結果の表示用ラスター（1枚） */
interface SimRaster {
  id: string;
  canvas: CellCanvas;
  /** いま画像に描かれているもの（再描画の判定用） */
  key: string;
  /** 画像ソースに転送済みのサイズ・座標 */
  spec: GridSpec | null;
  /** 画像を描いたときの出力（別の出力の古い絵を出さないため） */
  output: SimOutput | null;
}

interface Dirty {
  basemap: boolean;
  layers: boolean;
  domain: boolean;
  flood: boolean;
  growing: boolean;
  people: boolean;
  routes: boolean;
  shelters: boolean;
  placing: boolean;
  cursor: boolean;
  attribution: boolean;
}

const ALL_DIRTY = (): Dirty => ({
  basemap: true,
  layers: true,
  domain: true,
  flood: true,
  growing: true,
  people: true,
  routes: true,
  shelters: true,
  placing: true,
  cursor: false,
  attribution: true,
});

export class MapView2D {
  private readonly root: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  private map: MapLibreMap | null = null;
  private ready = false;
  private active = true;
  private destroyed = false;
  private raf = 0;
  private dirty: Dirty = ALL_DIRTY();
  private unsubscribe: (() => void) | null = null;

  // 表示中の状態
  private shownBasemaps = new Set<Basemap>();
  private currentBasemap: Basemap | null = null;
  private domainSpec: GridSpec | null = null;
  private domainLabel: Marker | null = null;

  // シミュレーション表示
  private rasters: Record<'flood' | 'maxDepth' | 'arrival', SimRaster>;
  private depthBuf = new Float32Array(0);
  private ref: FloodReference | null = null;
  private lastFloodPaint = -Infinity;
  private lastGrowingPaint = -Infinity;
  private lastRoutes = -Infinity;

  // 重ねる要素
  private people: PeopleLayer | null = null;
  private shelters: ShelterLayer | null = null;
  private pois: PoiLayer | null = null;

  // マウス
  private mouse: { lon: number; lat: number } | null = null;
  private lastCursor = -Infinity;
  private cursorTimer = 0;
  private toastTimer = 0;
  private loggedErrors = new Set<string>();

  constructor(
    container: HTMLElement,
    private readonly store: AppStore,
    private readonly actions: AppActions,
  ) {
    injectMap2dStyles();
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    this.root = document.createElement('div');
    this.root.className = 'm2d-root';
    container.appendChild(this.root);
    this.hint = document.createElement('div');
    this.hint.className = 'm2d-hint';
    this.hint.hidden = true;
    this.hint.setAttribute('role', 'status');
    this.toast = document.createElement('div');
    this.toast.className = 'm2d-toast';
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-live', 'polite');

    const mk = (id: string): SimRaster => ({ id, canvas: new CellCanvas(), key: '', spec: null, output: null });
    this.rasters = { flood: mk(IDS.flood), maxDepth: mk(IDS.maxDepth), arrival: mk(IDS.arrival) };

    const s = store.get();
    const spec = this.currentSpec(s);
    try {
      this.map = new MapLibreMap({
        container: this.root,
        style: buildStyle(s.basemap, s.layers, gridCornerCoordinates(spec)),
        center: [INITIAL_CENTER.lon, INITIAL_CENTER.lat],
        zoom: initialZoom(container.clientWidth),
        minZoom: 11,
        maxZoom: 18,
        maxBounds: MAX_BOUNDS,
        maxPitch: 0,
        pitch: 0,
        bearing: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        rollEnabled: false,
        attributionControl: false,
        locale: JA_LOCALE,
        fadeDuration: 0,
        validateStyle: false,
      });
    } catch (e) {
      console.error('[map2d] 地図を初期化できません', e);
      const msg = document.createElement('div');
      msg.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:#334155;background:#f1f5f9;font-size:14px;';
      msg.textContent = 'この環境では地図を表示できません（WebGL に対応したブラウザが必要です）。';
      this.root.appendChild(msg);
      return;
    }
    const map = this.map;
    this.shownBasemaps.add(s.basemap);
    this.currentBasemap = s.basemap;
    this.root.append(this.hint, this.toast);

    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-left');
    // 各ソースの出典はソースごとに自動表示。主な地点（POI）は OSM 由来の位置を含むので常に表示する
    map.addControl(new AttributionControl({ compact: true, customAttribution: POIS.length ? POI_ATTRIBUTION : undefined }), 'bottom-right');

    map.on('error', this.onMapError);
    // 'load' は表示範囲のタイルが揃うまで待つので、スタイルの準備ができた時点で重ね合わせを始める
    map.once('style.load', () => {
      if (this.destroyed) return;
      this.ready = true;
      this.people = new PeopleLayer(map, actions, (lon, lat) => this.checkPlacement(lon, lat), (m) => this.showToast(m));
      this.shelters = new ShelterLayer(map);
      this.pois = new PoiLayer(map);
      this.pois.setData(POIS);
      this.dirty = ALL_DIRTY();
      this.schedule();
    });
    map.on('click', this.onClick);
    map.on('mousemove', this.onMouseMove);
    map.on('mouseout', this.onMouseOut);
    map.on('zoom', this.onZoom);
    this.onZoom();
    window.addEventListener('keydown', this.onKeyDown);

    this.unsubscribe = store.subscribe((next, prev) => this.onState(next, prev));

    // 開発時のデバッグ・E2E 用
    if (import.meta.env?.DEV) (window as unknown as { __map2d?: unknown }).__map2d = { map, view: this };
  }

  // -------------------------------------------------------------------------
  // 公開 API
  // -------------------------------------------------------------------------

  setActive(active: boolean): void {
    if (this.destroyed) return;
    const was = this.active;
    this.active = active;
    if (active && this.map) {
      this.map.resize();
      if (!was) this.dirty = ALL_DIRTY();
      this.schedule();
    } else if (!active) {
      this.clearCursor();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.cursorTimer);
    window.clearTimeout(this.toastTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.people?.destroy();
    this.shelters?.destroy();
    this.pois?.destroy();
    this.domainLabel?.remove();
    this.map?.remove();
    this.map = null;
    for (const r of Object.values(this.rasters)) r.canvas.release();
    this.depthBuf = new Float32Array(0);
    this.ref = null;
    this.root.remove();
    const w = window as unknown as { __map2d?: { view?: unknown } };
    if (w.__map2d?.view === this) delete w.__map2d;
  }

  // -------------------------------------------------------------------------
  // 状態の変化 → 更新フラグ
  // -------------------------------------------------------------------------

  private onState(s: AppState, p: AppState): void {
    const d = this.dirty;
    let any = false;
    if (s.basemap !== p.basemap) d.basemap = any = true;
    if (s.layers !== p.layers) {
      d.layers = any = true;
      if (s.layers.shelters !== p.layers.shelters) d.shelters = true;
      if (s.layers.simFlood && !p.layers.simFlood) d.flood = true;
      if ((s.layers.maxDepth && !p.layers.maxDepth) || (s.layers.arrival && !p.layers.arrival)) d.growing = true;
    }
    if (s.terrain.grid !== p.terrain.grid || s.params.resolution !== p.params.resolution) {
      d.domain = d.flood = d.growing = d.people = d.routes = d.layers = d.attribution = any = true;
    }
    if (s.sim.output !== p.sim.output) {
      d.flood = d.growing = d.people = d.routes = d.layers = any = true;
    } else if (s.sim !== p.sim) {
      // 計算中はフレームが増えていく
      d.flood = d.growing = any = true;
      if (s.sim.status !== p.sim.status) d.people = d.routes = true;
    }
    if (s.time.t !== p.time.t) {
      d.flood = d.people = d.routes = any = true;
      if (this.mouse) d.cursor = true;
    }
    if (s.time.playing !== p.time.playing) d.people = any = true;
    if (s.people !== p.people || s.plans !== p.plans || s.selectedPersonId !== p.selectedPersonId) {
      d.people = d.routes = any = true;
    }
    if (s.placing !== p.placing) d.placing = any = true;
    if (s.shelters !== p.shelters) d.shelters = any = true;
    if (any) this.schedule();
  }

  private schedule(): void {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  // -------------------------------------------------------------------------
  // 毎フレームの処理
  // -------------------------------------------------------------------------

  private frame = (now: number): void => {
    this.raf = 0;
    const map = this.map;
    if (!map || !this.ready || !this.active || this.destroyed) return;
    const s = this.store.get();
    const d = this.dirty;
    // 各処理は独立に保護する（1つが失敗しても他の更新は続ける。フラグは処理前に下ろすので失敗を繰り返さない）
    const step = (name: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        this.logOnce(`frame:${name}`, e);
      }
    };
    if (d.basemap) {
      d.basemap = false;
      step('basemap', () => this.applyBasemap(map, s.basemap));
    }
    if (d.domain) {
      d.domain = false;
      step('domain', () => this.applyDomain(map, this.currentSpec(s)));
    }
    if (d.attribution) {
      d.attribution = false;
      step('attribution', () => this.applyAttribution(map, s.terrain.grid));
    }
    if (d.placing) {
      d.placing = false;
      step('placing', () => this.applyPlacing(s));
    }
    if (d.shelters) {
      d.shelters = false;
      step('shelters', () => {
        this.shelters?.setData(s.shelters);
        this.shelters?.setVisible(s.layers.shelters);
      });
    }

    const data = this.simData(s);
    if (d.flood) {
      if (!s.layers.simFlood || !data) d.flood = false;
      else if (now - this.lastFloodPaint >= FLOOD_INTERVAL_MS) {
        d.flood = false;
        this.lastFloodPaint = now;
        step('flood', () => this.paintFloodLayer(map, data.grid, data.output, s));
      }
    }
    if (d.growing) {
      if ((!s.layers.maxDepth && !s.layers.arrival) || !data) d.growing = false;
      else if (
        s.sim.status !== 'running' ||
        now - this.lastGrowingPaint >= GROWING_INTERVAL_MS ||
        (s.layers.maxDepth && this.rasters.maxDepth.output !== data.output) ||
        (s.layers.arrival && this.rasters.arrival.output !== data.output)
      ) {
        d.growing = false;
        this.lastGrowingPaint = now;
        step('growing', () => this.paintGrowingLayers(map, data.grid, data.output, s));
      }
    }
    if (d.layers) {
      d.layers = false;
      step('layers', () => this.applyLayers(map, s, data ? data.output : null));
    }
    const people = this.people;
    if (d.people && people) {
      d.people = false;
      step('people', () => people.update(this.peopleContext(s)));
    }
    if (d.routes && people && now - this.lastRoutes >= ROUTE_INTERVAL_MS) {
      d.routes = false;
      this.lastRoutes = now;
      step('routes', () => {
        people.updateRoutes(this.peopleContext(s));
        const sel = s.selectedPersonId ? s.plans[s.selectedPersonId] : undefined;
        this.shelters?.setHighlight(sel?.target ?? null);
      });
    }
    if (d.cursor && now - this.lastCursor >= CURSOR_INTERVAL_MS * 2) {
      d.cursor = false;
      step('cursor', () => this.emitCursor());
    }
    // 間引きで持ち越した更新があれば次のフレームで
    if (d.flood || d.growing || d.routes || d.cursor || d.layers) this.schedule();
  };

  private peopleContext(s: AppState): PeopleContext {
    const data = this.simData(s);
    return {
      people: s.people,
      plans: s.plans,
      selectedId: s.selectedPersonId,
      grid: s.terrain.grid,
      output: data ? data.output : null,
      t: s.time.t,
      playing: s.time.playing,
    };
  }

  /** 表示に使えるシミュレーション結果（地形とグリッドが一致しているときだけ） */
  private simData(s: AppState): { grid: TerrainGrid; output: SimOutput } | null {
    const grid = s.terrain.grid;
    const output = s.sim.output;
    if (!grid || !output) return null;
    if (!specsMatch(grid.spec, output.spec)) return null;
    return { grid, output };
  }

  private currentSpec(s: AppState): GridSpec {
    return s.terrain.grid?.spec ?? createGridSpec(s.params.resolution);
  }

  // -------------------------------------------------------------------------
  // レイヤー
  // -------------------------------------------------------------------------

  private applyBasemap(map: MapLibreMap, b: Basemap): void {
    if (this.currentBasemap === b) return;
    const id = basemapLayerId(b);
    if (!this.shownBasemaps.has(b) || !map.getLayer(id)) {
      if (!map.getSource(id)) map.addSource(id, rasterSource(BASEMAPS[b]));
      map.addLayer(basemapLayer(b), IDS.relief);
      this.shownBasemaps.add(b);
    }
    for (const other of this.shownBasemaps) {
      map.setLayoutProperty(basemapLayerId(other), 'visibility', other === b ? 'visible' : 'none');
    }
    this.currentBasemap = b;
  }

  private applyLayers(map: MapLibreMap, s: AppState, output: SimOutput | null): void {
    const L = s.layers;
    const vis = (id: string, on: boolean) => {
      const v = on ? 'visible' : 'none';
      if (map.getLayoutProperty(id, 'visibility') !== v) map.setLayoutProperty(id, 'visibility', v);
    };
    const opacity = (id: string, prop: 'raster-opacity', value: number) => {
      if (map.getPaintProperty(id, prop) !== value) map.setPaintProperty(id, prop, value);
    };
    vis(IDS.relief, L.elevation);
    vis(IDS.hazard, L.officialHazard);
    opacity(IDS.hazard, 'raster-opacity', clamp01(L.officialHazardOpacity));

    const ok = (r: SimRaster) => output !== null && r.output === output;
    const flood = L.simFlood && ok(this.rasters.flood);
    const maxD = L.maxDepth && ok(this.rasters.maxDepth);
    const arr = L.arrival && ok(this.rasters.arrival);
    vis(IDS.flood, flood);
    vis(IDS.maxDepth, maxD);
    vis(IDS.arrival, arr);
    // 重ねたときは下のレイヤーを薄くして、上のレイヤーを読みやすくする
    opacity(IDS.flood, 'raster-opacity', SIM_OPACITY.flood);
    opacity(IDS.maxDepth, 'raster-opacity', flood ? 0.45 : SIM_OPACITY.maxDepth);
    opacity(IDS.arrival, 'raster-opacity', flood || maxD ? 0.4 : SIM_OPACITY.arrival);
  }

  private applyDomain(map: MapLibreMap, spec: GridSpec): void {
    if (this.domainSpec && specsMatch(this.domainSpec, spec) && this.domainLabel) return;
    this.domainSpec = spec;
    const c = gridCornerCoordinates(spec) as Coords;
    (map.getSource(IDS.domainSource) as GeoJSONSource | undefined)?.setData(domainGeoJSON(c)).catch((e: unknown) => this.logOnce('domain', e));
    this.domainLabel?.remove();
    this.domainLabel = createDomainLabel(map, c[0]);
  }

  /** 計算結果レイヤーの出典（地形の出所に合わせる） */
  private applyAttribution(map: MapLibreMap, grid: TerrainGrid | null): void {
    const text =
      grid && grid.source === 'synthetic'
        ? '浸水計算: 近似（合成）地形による試算'
        : '浸水計算: <a href="https://maps.gsi.go.jp/development/ichiran.html#dem" target="_blank" rel="noopener">国土地理院の標高タイルを加工して作成</a>';
    for (const r of Object.values(this.rasters)) {
      const src = map.getSource(r.id) as (ImageSource & { attribution?: string }) | undefined;
      if (src) src.attribution = text;
    }
  }

  private applyPlacing(s: AppState): void {
    const kind = s.placing;
    this.root.classList.toggle('m2d-placing', !!kind);
    if (kind) {
      const label = PERSON_PROFILES[kind]?.label ?? kind;
      const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      this.hint.replaceChildren();
      const b = document.createElement('b');
      b.textContent = `「${label}」`;
      const more = document.createElement('span');
      more.className = 'm2d-hint__more';
      more.textContent = touch ? '（続けて置けます）' : '（続けて置けます・Esc で終了）';
      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'm2d-hint__done';
      done.textContent = '終了';
      done.addEventListener('click', () => this.actions.startPlacing(null));
      this.hint.append(touch ? '地図をタップして' : '地図をクリックして', b, 'を配置', more, done);
      this.hint.hidden = false;
      this.placeOverlays();
    } else {
      this.hint.hidden = true;
      this.hint.replaceChildren();
    }
  }

  // -------------------------------------------------------------------------
  // シミュレーション画像
  // -------------------------------------------------------------------------

  private ensureRef(grid: TerrainGrid, output: SimOutput, s: AppState): FloodReference {
    const n = grid.spec.nx * grid.spec.ny;
    if (this.depthBuf.length !== n) this.depthBuf = new Float32Array(n);
    if (!this.ref || this.ref.output !== output || this.ref.grid !== grid) {
      this.ref = buildFloodReference(grid, output, this.depthBuf, s.params.tideTP);
      this.rasters.flood.key = '';
    }
    return this.ref;
  }

  private paintFloodLayer(map: MapLibreMap, grid: TerrainGrid, output: SimOutput, s: AppState): void {
    if (output.framesReady() < 1) return;
    const r = this.rasters.flood;
    const ref = this.ensureRef(grid, output, s);
    const t = Math.max(0, Math.min(s.time.t, output.durationSec));
    // 計算中は受信済みの時刻が変わると同じ t でも絵が変わりうる
    const key = `${t}|${Math.min(t, output.timeReady())}`;
    const sizeChanged = r.canvas.ensure(grid.spec.nx, grid.spec.ny);
    if (!sizeChanged && r.key === key && r.output === output) return;
    paintFlood(r.canvas, ref, t, this.depthBuf);
    r.key = key;
    this.pushImage(map, r, grid.spec, output);
  }

  private paintGrowingLayers(map: MapLibreMap, grid: TerrainGrid, output: SimOutput, s: AppState): void {
    const key = `${output.framesReady()}|${s.sim.status}`;
    if (s.layers.maxDepth) {
      const r = this.rasters.maxDepth;
      const sizeChanged = r.canvas.ensure(grid.spec.nx, grid.spec.ny);
      if (sizeChanged || r.key !== key || r.output !== output) {
        paintMaxDepth(r.canvas, grid, output);
        r.key = key;
        this.pushImage(map, r, grid.spec, output);
      }
    }
    if (s.layers.arrival) {
      const r = this.rasters.arrival;
      const sizeChanged = r.canvas.ensure(grid.spec.nx, grid.spec.ny);
      if (sizeChanged || r.key !== key || r.output !== output) {
        paintArrival(r.canvas, grid, output);
        r.key = key;
        this.pushImage(map, r, grid.spec, output);
      }
    }
  }

  private pushImage(map: MapLibreMap, r: SimRaster, spec: GridSpec, output: SimOutput): void {
    const src = map.getSource(r.id) as ImageSource | undefined;
    if (!src) return;
    const coordsChanged = !r.spec || !specsMatch(r.spec, spec);
    if (coordsChanged) {
      r.spec = spec;
      src.updateImage({ image: r.canvas.canvas, coordinates: gridCornerCoordinates(spec) });
    } else {
      src.updateImage({ image: r.canvas.canvas });
    }
    if (r.output !== output) {
      r.output = output;
      this.dirty.layers = true;
    }
  }

  // -------------------------------------------------------------------------
  // 操作
  // -------------------------------------------------------------------------

  /** 人物を置ける場所か。置けない場合は理由 */
  private checkPlacement(lon: number, lat: number): string | null {
    const s = this.store.get();
    const spec = this.currentSpec(s);
    const cell = lonLatToCell(spec, lon, lat);
    if (!cell) return '計算範囲（破線の枠）の中に置いてください';
    const grid = s.terrain.grid;
    if (grid && specsMatch(grid.spec, spec) && grid.kind[cell.k] === CELL_SEA) return '海や川の上には置けません';
    return null;
  }

  private onClick = (e: MapMouseEvent): void => {
    const target = e.originalEvent?.target as Element | null;
    if (target && target.closest?.('.maplibregl-marker, .maplibregl-popup')) return;
    const s = this.store.get();
    if (s.placing) {
      const { lng, lat } = e.lngLat;
      const reason = this.checkPlacement(lng, lat);
      if (reason) {
        this.showToast(reason);
        return;
      }
      this.actions.addPerson(s.placing, lng, lat);
      return;
    }
    if (s.selectedPersonId) this.actions.selectPerson(null);
  };

  private onMouseMove = (e: MapMouseEvent): void => {
    this.mouse = { lon: e.lngLat.lng, lat: e.lngLat.lat };
    const now = performance.now();
    if (now - this.lastCursor >= CURSOR_INTERVAL_MS) {
      this.emitCursor();
    } else if (!this.cursorTimer) {
      this.cursorTimer = window.setTimeout(() => {
        this.cursorTimer = 0;
        if (this.mouse) this.emitCursor();
      }, CURSOR_INTERVAL_MS);
    }
  };

  private onMouseOut = (e: MapMouseEvent): void => {
    // マーカーや地図上のボタンへ移っただけなら地図の外に出たとはみなさない
    const to = (e.originalEvent as MouseEvent | undefined)?.relatedTarget as Node | null | undefined;
    if (to && this.root.contains(to)) return;
    this.clearCursor();
  };

  private clearCursor(): void {
    window.clearTimeout(this.cursorTimer);
    this.cursorTimer = 0;
    if (!this.mouse) return;
    this.mouse = null;
    if (this.store.get().cursor) this.actions.setCursor(null);
  }

  private emitCursor(): void {
    const m = this.mouse;
    if (!m || this.destroyed) return;
    this.lastCursor = performance.now();
    const s = this.store.get();
    const grid = s.terrain.grid;
    let ground: number | null = null;
    let depth: number | null = null;
    if (grid) {
      try {
        ground = sampleGround(grid, m.lon, m.lat);
      } catch (e) {
        this.logOnce('sampleGround', e);
      }
    }
    const data = this.simData(s);
    if (data && data.output.framesReady() > 0) {
      const cell = lonLatToCell(data.output.spec, m.lon, m.lat);
      // 海・川のセルの全水深は「浸水深」ではないので出さない（地盤高＝海底の高さだけを示す）
      if (cell && data.grid.kind[cell.k] !== CELL_SEA) {
        const v = data.output.depthAt(Math.max(0, s.time.t), cell.k);
        depth = Number.isFinite(v) ? Math.max(0, v) : null;
      }
    }
    this.actions.setCursor({ lon: m.lon, lat: m.lat, ground: ground ?? null, depth });
  }

  private onZoom = (): void => {
    const z = this.map?.getZoom() ?? INITIAL_ZOOM;
    this.root.classList.toggle('m2d-zlow', z < 13.2);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.active && this.store.get().placing) {
      this.actions.startPlacing(null);
    }
  };

  /**
   * 狭い画面では、地図に重なる HUD（UI 担当、#hud .hud-tl）の下にヒントと通知を出す。
   * HUD が見つからない・重ならない場合は既定の位置（上中央）のまま。
   */
  private placeOverlays(): void {
    let top = 10;
    try {
      const rootRect = this.root.getBoundingClientRect();
      if (rootRect.width < 820) {
        const hud = document.querySelector('#hud .hud-tl');
        const r = hud?.getBoundingClientRect();
        if (r && r.height > 0 && r.bottom > rootRect.top && r.top < rootRect.top + rootRect.height / 2) {
          top = Math.max(top, Math.round(r.bottom - rootRect.top + 8));
        }
      }
    } catch {
      // 位置合わせは見た目だけの補助なので失敗しても続ける
    }
    this.hint.style.top = `${top}px`;
    const hintH = this.hint.hidden ? 0 : this.hint.offsetHeight + 6;
    this.toast.style.top = `${top + (hintH || 0)}px`;
  }

  private showToast(msg: string): void {
    this.placeOverlays();
    this.toast.textContent = msg;
    this.toast.classList.add('m2d-show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('m2d-show'), 2200);
  }

  // -------------------------------------------------------------------------
  // エラー処理（取得できないタイルでコンソールを埋めない）
  // -------------------------------------------------------------------------

  private onMapError = (e: { error?: unknown; sourceId?: string; tile?: unknown }): void => {
    const err = e.error as { message?: string; status?: number; url?: string } | undefined;
    if (e.sourceId || e.tile) {
      // 公式ハザードマップは浸水想定のない区域のタイルが 404 になるのが通常なので記録しない
      if (err?.status === 404 && e.sourceId === IDS.hazard) return;
      const key = `tile:${e.sourceId ?? '?'}:${err?.status ?? 'network'}`;
      if (!this.loggedErrors.has(key)) {
        this.loggedErrors.add(key);
        console.warn(`[map2d] タイルを取得できませんでした（${e.sourceId ?? '不明なソース'}）: ${err?.message ?? String(err)}`);
      }
      return;
    }
    this.logOnce(`map:${err?.message ?? String(e.error)}`, e.error);
  };

  private logOnce(key: string, e: unknown): void {
    if (this.loggedErrors.has(key)) return;
    this.loggedErrors.add(key);
    console.warn(`[map2d] ${key}`, e);
  }
}

/** 幅の狭い画面（スマートフォン）では、幅 800px 相当の範囲が入るよう少し引いて表示する */
function initialZoom(width: number): number {
  if (!(width > 0) || width >= 800) return INITIAL_ZOOM;
  return Math.max(12.5, INITIAL_ZOOM - Math.log2(800 / width));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6;
}
