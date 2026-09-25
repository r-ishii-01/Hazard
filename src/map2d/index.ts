/**
 * 2D 地図ビュー（MapLibre GL JS v6）。
 *
 * - 背景地図（地理院タイル）・色別標高・公式の津波浸水想定（ハザードマップポータルサイト）をラスターで重ねる。
 * - シミュレーション結果（現在の浸水・海面の偏差・引き波で露出した海底／最大浸水深／到達時間）は
 *   1セル = 1ピクセルのキャンバスを ImageSource に転送して表示する（グリッド四隅に正確に合わせる）。
 * - 避難場所・人物・避難経路・計算範囲を重ねる。人物は配置モードで地図クリックにより追加、ドラッグで移動。
 * - 地名検索・現在地（store.focus の seq が増えたら、その地点へ移動。非表示中の要求は表示したときに反映）。
 *   検索地点の一時的なピンと、現在地の点・精度の円を出す（locate.ts）。
 *
 * 描画は requestAnimationFrame にまとめ、時刻・レイヤー・データが変わったときだけ更新する。
 * 浸水画像の更新は最大 30 回/秒。
 *
 * 計算結果は core/results.ts の usableOutput（今の地形の格子の上で計算した結果）だけを描く。
 * 計算結果が変わったら、非表示のレイヤーが持っている前の結果への参照も手放す（全フレームをメモリに残さない）。
 * 背景地図・色別標高・公式ハザードマップのタイルを取得できないときは、地図の上に理由を表示する。
 * 公式ハザードマップのタイルを取得できた・できなかったことはコントローラにも知らせる（HUD の凡例・レイヤーのタブが示す）。
 *
 * 広い画面では、地図の左上に重なる HUD（UI 担当、#hud .hud-tl。経過時間・警報・水位）の幅だけ地図の左に余白
 * （MapLibre の padding）をとる。初期表示・地名検索などの移動先・「計算範囲を表示」は、HUD に隠れない所の中央に来る。
 * HUD の大きさが変わっても、地図の見た目は動かさない（余白だけを変える）。
 */
import {
  AttributionControl,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type ImageSource,
  type RasterTileSource,
  type MapMouseEvent,
  type GeoJSONSource,
} from 'maplibre-gl';
import type { AppStore } from '../core/store';
import type { AppActions } from '../core/controller';
import { resultParams, usableOutput } from '../core/results';
import { CELL_SEA, type AppState, type Basemap, type CursorInfo, type MapFocus, type SimOutput, type TerrainGrid } from '../core/types';
import { INITIAL_CENTER, INITIAL_ZOOM, createGridSpec, gridCornerCoordinates, lonLatToCell, type GridSpec } from '../core/geo';
import { BASEMAPS, DEM_CREDIT_HTML } from '../data/sources';
import { POIS, POI_ATTRIBUTION } from '../data/poi';
import { PERSON_PROFILES } from '../people';
import { sampleGround } from '../terrain';
import { injectMap2dStyles } from './css';
import { CellCanvas, buildFloodReference, paintArrival, paintFlood, paintMaxDepth, specsMatch, type FloodReference } from './rasters';
import { IDS, SIM_OPACITY, basemapLayer, basemapLayerId, buildStyle, domainGeoJSON, rasterSource } from './style';
import { PeopleLayer, type PeopleContext } from './people';
import { PoiLayer, ShelterLayer, createDomainLabel } from './shelters';
import { registerHazardProtocol } from './hazardTiles';
import { MAP_VIEW_BOUNDS, domainZoomForWidth } from './geo2d';
import { LocationLayer } from './locate';
// MapLibre v6 のワーカーは別ファイル。Vite の事前バンドル／本番ビルドでは既定の相対 URL が解決できないので、
// Vite にワーカーとしてバンドルさせ、その URL を明示する。
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(maplibreWorkerUrl);
registerHazardProtocol();

type Coords = [[number, number], [number, number], [number, number], [number, number]];

/** 表示できる範囲（計算範囲の周囲をゆったり） */
const MAX_BOUNDS = MAP_VIEW_BOUNDS;

/** 浸水画像の最短更新間隔 [ms]（≦30 回/秒） */
const FLOOD_INTERVAL_MS = 33;
/** 計算中の最大浸水深・到達時間の更新間隔 [ms] */
const GROWING_INTERVAL_MS = 700;
/** 経路の更新間隔 [ms]（再生中。人物のマーカーは毎フレーム動くので、経路の通過済みの部分は少し遅れてよい） */
const ROUTE_INTERVAL_PLAYING_MS = 150;
/** 経路の更新間隔 [ms]（時刻を動かしている・止まっているとき） */
const ROUTE_INTERVAL_MS = 66;
/** タイルを取得できなかった後、取得できるようになったとみなすまでの時間 [ms] */
const TILE_RECOVER_MS = 3000;
/** 地図の操作ボタンの大きさ（狭い画面・タッチ操作）[px] */
const TOUCH_TARGET_PX = 40;
/** HUD の分の余白をとる地図の幅の下限 [px]（これより狭い画面では HUD は上端の帯になり、余白はとらない） */
const HUD_PAD_MIN_WIDTH = 820;
/** HUD と地図の見える部分の間のすき間 [px] */
const HUD_PAD_GAP = 12;
/** HUD の分の余白の上限（地図の幅に対する割合） */
const HUD_PAD_MAX_FRACTION = 0.4;

/** 取得できないと知らせるタイルのソース（表示中のものだけ） */
type NoticeSource = 'basemap' | 'relief' | 'hazard';
const NOTICE_TEXT: Record<NoticeSource, string> = {
  basemap: '背景地図（地理院タイル）を読み込めません。',
  relief: '色別標高図（地理院タイル）を読み込めません。',
  hazard: '公式ハザードマップ（津波浸水想定）のタイルを読み込めません。表示されない部分も「浸水しない」という意味ではありません。',
};
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
  /** 現在地の精度の円 */
  location: boolean;
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
  location: true,
});

export class MapView2D {
  private readonly root: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  /** タイルを取得できないときの案内（取得できるようになるまで出したまま） */
  private readonly notice: HTMLDivElement;
  private readonly noticeText: HTMLSpanElement;
  /** ソースごとの、タイルを取得できなかった時刻・取得できた時刻 */
  private tileTrouble = new Map<string, { failedAt: number; okAt: number }>();
  private noticeTimer = 0;
  private fitTimer = 0;
  private noticeKey = '';
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
  /** 最大浸水深・到達時間を描いたときの計算結果の更新番号 */
  private growingRevision: number | null = null;
  private lastRoutes = -Infinity;

  // 重ねる要素
  private people: PeopleLayer | null = null;
  private shelters: ShelterLayer | null = null;
  private pois: PoiLayer | null = null;
  private location: LocationLayer | null = null;

  // HUD（左上）の分の地図の余白
  private hudPad = 0;
  private hudRO: ResizeObserver | null = null;
  private hudObserved: Element | null = null;
  private hudPadRaf = 0;
  private hudPadAfterMove = false;

  // 視点の移動要求（地名検索・現在地）
  private lastFocusSeq = 0;
  /** 非表示の間に届いた要求（表示したときに反映） */
  private pendingFocus: MapFocus | null = null;

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
    this.notice = document.createElement('div');
    this.notice.className = 'm2d-notice';
    this.notice.setAttribute('role', 'status');
    this.notice.hidden = true;
    this.noticeText = document.createElement('span');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'm2d-notice__retry';
    retry.textContent = '再読み込み';
    retry.addEventListener('click', () => this.retryTiles());
    this.notice.append(this.noticeText, retry);

    const mk = (id: string): SimRaster => ({ id, canvas: new CellCanvas(), key: '', spec: null, output: null });
    this.rasters = { flood: mk(IDS.flood), maxDepth: mk(IDS.maxDepth), arrival: mk(IDS.arrival) };

    const s = store.get();
    const spec = this.currentSpec(s);
    // 広い画面: 左上の HUD に隠れない部分に計算範囲の全体が入るズームにする（余白は地図を作った直後に設定）。
    // 計算が始まると警報のカードが出て HUD が広がる（その後、地図は勝手に動かさない）ので、HUD の最大の幅の分をとっておく
    const pad0 = this.measureHudPad(true);
    try {
      this.map = new MapLibreMap({
        container: this.root,
        style: buildStyle(s.basemap, s.layers, gridCornerCoordinates(spec)),
        center: [INITIAL_CENTER.lon, INITIAL_CENTER.lat],
        zoom: domainZoomForWidth(container.clientWidth - pad0),
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
    // 余白を設定すると、中心（計算範囲の中央）は HUD に隠れない部分の中央に表示される
    if (pad0 > 0) {
      map.setPadding({ top: 0, right: 0, bottom: 0, left: pad0 });
      this.hudPad = pad0;
    }
    this.observeHud();
    this.shownBasemaps.add(s.basemap);
    this.currentBasemap = s.basemap;
    // 注記のある背景地図（淡色・標準）では、駅名が地図にも書かれていて二重になるので駅の地点ラベルを出さない
    this.root.classList.toggle('m2d-basemap-labeled', s.basemap !== 'photo');
    this.root.append(this.hint, this.notice, this.toast);

    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
    map.on('resize', () => {
      this.fitControls();
      this.scheduleHudPadding();
    });
    map.addControl(new ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-left');
    // 各ソースの出典はソースごとに自動表示。主な地点（POI）は OSM 由来の位置を含むので常に表示する
    map.addControl(new AttributionControl({ compact: true, customAttribution: POIS.length ? POI_ATTRIBUTION : undefined }), 'bottom-right');
    this.collapseAttributionOnNarrow();

    // 検索地点のピン・現在地の点（HTML マーカーはスタイルの読み込みを待たずに置ける）
    this.location = new LocationLayer(map, () => actions.clearFocus());
    this.location.setUserLocation(s.userLocation);
    this.location.setFocus(s.focus);
    if (s.focus && s.focus.seq > this.lastFocusSeq) {
      this.lastFocusSeq = s.focus.seq;
      this.pendingFocus = s.focus;
    }

    map.on('error', this.onMapError);
    map.on('sourcedata', this.onSourceData);
    // 'load' は表示範囲のタイルが揃うまで待つので、スタイルの準備ができた時点で重ね合わせを始める
    map.once('style.load', () => {
      if (this.destroyed) return;
      this.ready = true;
      this.fitControls();
      this.people = new PeopleLayer(map, actions, (lon, lat) => this.checkPlacement(lon, lat), (m) => this.showToast(m));
      this.shelters = new ShelterLayer(map);
      this.pois = new PoiLayer(map);
      this.pois.setData(POIS);
      this.location?.resetCircle();
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
      this.placeOverlays();
      // 3D 表示の間に HUD の大きさが変わっていれば、余白を合わせる（移動の要求より先に）
      this.updateHudPadding();
      if (!was) {
        this.dirty = ALL_DIRTY();
        // 3D 表示の間に 3D 側が「取得できた」と知らせていても、この地図の公式ハザードマップに取得できなかった
        // タイルが残っていれば、そのことを示し直して読み込み直す
        if (this.tileTrouble.has(IDS.hazard)) {
          this.reportHazard(false);
          this.retryHazardTiles();
        }
      }
      // 3D 表示の間に届いた移動の要求は、表示したときにアニメーションなしで反映する
      const f = this.pendingFocus;
      this.pendingFocus = null;
      if (f) this.moveToFocus(f, false);
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
    window.clearTimeout(this.noticeTimer);
    window.clearTimeout(this.fitTimer);
    if (this.hudPadRaf) cancelAnimationFrame(this.hudPadRaf);
    this.hudRO?.disconnect();
    this.hudRO = null;
    window.removeEventListener('keydown', this.onKeyDown);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.people?.destroy();
    this.shelters?.destroy();
    this.pois?.destroy();
    this.location?.destroy();
    this.location = null;
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
    if (s.basemap !== p.basemap || s.layers.elevation !== p.layers.elevation || s.layers.officialHazard !== p.layers.officialHazard) this.updateNotice();
    if (s.layers !== p.layers) {
      d.layers = any = true;
      if (s.layers.shelters !== p.layers.shelters) d.shelters = true;
      if (s.layers.simFlood && !p.layers.simFlood) d.flood = true;
      if ((s.layers.maxDepth && !p.layers.maxDepth) || (s.layers.arrival && !p.layers.arrival)) d.growing = true;
    }
    if (s.terrain.grid !== p.terrain.grid || s.params.resolution !== p.params.resolution) {
      d.domain = d.flood = d.growing = d.people = d.routes = d.layers = d.attribution = any = true;
    }
    if (s.sim.output !== p.sim.output || s.terrain.grid !== p.terrain.grid) {
      // 表示しなくなった計算結果への参照を手放す（非表示のレイヤー・浸水の参照データ・人物の直近の状態）。
      // 地図を表示していない間（3D 表示中）も行う
      this.dropStaleOutputs(this.simData(s)?.output ?? null);
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
    if (s.focus !== p.focus) this.onFocus(s.focus);
    // 公式ハザードマップの接続を確かめ直した（「再試行」など）: 取得できなかったタイルを読み込み直す
    if (s.officialInundation.display !== p.officialInundation.display && s.officialInundation.display === 'checking') this.retryHazardTiles();
    if (s.userLocation !== p.userLocation) {
      this.location?.setUserLocation(s.userLocation);
      d.location = any = true;
    }
    if (any) this.schedule();
  }

  // -------------------------------------------------------------------------
  // 視点の移動（地名検索・現在地）
  // -------------------------------------------------------------------------

  private onFocus(f: MapFocus | null): void {
    this.location?.setFocus(f);
    if (!f || f.seq <= this.lastFocusSeq) return;
    this.lastFocusSeq = f.seq;
    if (this.active && this.map) {
      this.pendingFocus = null;
      this.moveToFocus(f, true);
    } else {
      this.pendingFocus = f;
    }
  }

  /** 指定地点へ移動（zoom の指定があればそのズーム、無ければ今のズームのまま） */
  private moveToFocus(f: MapFocus, animate: boolean): void {
    const map = this.map;
    if (!map || !Number.isFinite(f.lon) || !Number.isFinite(f.lat)) return;
    let zoom = Number.isFinite(f.zoom) ? (f.zoom as number) : map.getZoom();
    // 「計算範囲を表示」（計算範囲の中央へ、地図の幅に合わせたズームで移動する要求）: HUD の分の余白を除いた幅に全体が入るように
    if (isDomainFocus(f) && this.hudPad > 0) zoom = Math.min(zoom, domainZoomForWidth(this.root.clientWidth - this.hudPad));
    const center: [number, number] = [f.lon, f.lat];
    const offset = this.focusOffset();
    // 動きを減らす設定（prefers-reduced-motion）ではアニメーションしない。
    // （MapLibre の flyTo はこの設定のとき jumpTo になり offset が効かないので、時間 0 の easeTo を使う）
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      if (animate && !reduce) map.flyTo({ center, zoom, offset, maxDuration: 2500 });
      else map.easeTo({ center, zoom, offset, duration: 0 });
    } catch (e) {
      this.logOnce('focus', e);
    }
  }

  /**
   * 「場所を探す」パネル（UI 担当、#hud .place-panel）が開いているときは、目的地がパネルに隠れないよう、
   * 見えている部分の中央に来るようずらす（狭い画面: パネルは上端いっぱい → 下へ。広い画面: 右上 → 左へ）。
   */
  private focusOffset(): [number, number] {
    try {
      const panel = document.querySelector<HTMLElement>('#hud .place-panel');
      if (!panel || panel.hidden) return [0, 0];
      const root = this.root.getBoundingClientRect();
      const r = panel.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return [0, 0];
      if (root.width < 820) {
        const covered = Math.min(root.height * 0.75, r.bottom - root.top);
        return covered > 0 ? [0, Math.round(covered / 2)] : [0, 0];
      }
      const covered = Math.min(root.width * 0.6, root.right - r.left);
      return covered > 0 ? [-Math.round(covered / 2), 0] : [0, 0];
    } catch {
      return [0, 0];
    }
  }

  private schedule(): void {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  // -------------------------------------------------------------------------
  // HUD（左上）の分の余白
  // -------------------------------------------------------------------------

  /**
   * 左上の HUD（UI 担当、#hud .hud-tl）に隠れる幅 [px]（地図の左端から HUD の右端 + すき間）。
   * 狭い画面（HUD は上端の帯になる）・HUD が見つからない・地図の左半分に重ならないときは 0。
   * reserve: 今の幅ではなく、HUD が広がりうる最大の幅（CSS の max-width）で求める（初期表示用）。
   */
  private measureHudPad(reserve = false): number {
    try {
      const root = this.root.getBoundingClientRect();
      if (root.width < HUD_PAD_MIN_WIDTH || root.height <= 0) return 0;
      const hud = document.querySelector<HTMLElement>('#hud .hud-tl');
      if (!hud) return 0;
      const r = hud.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return 0;
      if (r.left - root.left > root.width / 2 || r.top - root.top > root.height / 2 || r.bottom <= root.top) return 0;
      let right = r.right - root.left;
      if (reserve) right = Math.max(right, r.left - root.left + hudMaxWidth(hud));
      if (right <= 0) return 0;
      return Math.round(Math.min(right + HUD_PAD_GAP, root.width * HUD_PAD_MAX_FRACTION));
    } catch {
      return 0;
    }
  }

  /** HUD の大きさの変化を見張る（HUD が作り直されたら見張る要素も替える） */
  private observeHud(): void {
    if (typeof ResizeObserver === 'undefined') return;
    const el = document.querySelector('#hud .hud-tl');
    if (el === this.hudObserved) return;
    if (!this.hudRO) this.hudRO = new ResizeObserver(() => this.scheduleHudPadding());
    if (this.hudObserved) this.hudRO.unobserve(this.hudObserved);
    this.hudObserved = el;
    if (el) this.hudRO.observe(el);
  }

  private scheduleHudPadding(): void {
    if (this.hudPadRaf || this.destroyed) return;
    this.hudPadRaf = requestAnimationFrame(() => {
      this.hudPadRaf = 0;
      this.updateHudPadding();
    });
  }

  /**
   * 余白を HUD の今の幅に合わせる。地図の見た目は動かさない（新しい余白での中心の位置にいま表示されている地点を中心にする）。
   * 地図の移動中（地名検索の移動など）は、移動が終わってから合わせる。
   */
  private updateHudPadding(): void {
    const map = this.map;
    if (!map || !this.active || this.destroyed) return;
    this.observeHud();
    const pad = this.measureHudPad();
    if (Math.abs(pad - this.hudPad) < 2) return;
    if (map.isMoving()) {
      if (!this.hudPadAfterMove) {
        this.hudPadAfterMove = true;
        map.once('moveend', () => {
          this.hudPadAfterMove = false;
          this.scheduleHudPadding();
        });
      }
      return;
    }
    try {
      const cur = map.getPadding();
      const el = map.getContainer();
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0 || h <= 0) return;
      const x = pad + (w - pad - (cur.right ?? 0)) / 2;
      const y = (cur.top ?? 0) + (h - (cur.top ?? 0) - (cur.bottom ?? 0)) / 2;
      const center = map.unproject([x, y]);
      map.jumpTo({ center, padding: { top: cur.top ?? 0, right: cur.right ?? 0, bottom: cur.bottom ?? 0, left: pad } });
      this.hudPad = pad;
    } catch (e) {
      this.logOnce('hudPadding', e);
    }
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
    if (d.location) {
      d.location = false;
      step('location', () => this.location?.applyCircle());
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
        // 計算中に進み具合だけが変わった（出力の中身は同じ）なら描き直さない
        s.sim.status === 'running' &&
        this.growingRevision !== null &&
        outputRevision(data.output) === this.growingRevision &&
        (!s.layers.maxDepth || this.rasters.maxDepth.output === data.output) &&
        (!s.layers.arrival || this.rasters.arrival.output === data.output)
      )
        d.growing = false;
      else if (
        s.sim.status !== 'running' ||
        now - this.lastGrowingPaint >= GROWING_INTERVAL_MS ||
        (s.layers.maxDepth && this.rasters.maxDepth.output !== data.output) ||
        (s.layers.arrival && this.rasters.arrival.output !== data.output)
      ) {
        d.growing = false;
        this.lastGrowingPaint = now;
        this.growingRevision = outputRevision(data.output);
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
    if (d.routes && people && now - this.lastRoutes >= (s.time.playing ? ROUTE_INTERVAL_PLAYING_MS : ROUTE_INTERVAL_MS)) {
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

  /** 表示に使えるシミュレーション結果（今の地形の格子の上で計算した結果だけ） */
  private simData(s: AppState): { grid: TerrainGrid; output: SimOutput } | null {
    const grid = s.terrain.grid;
    const output = usableOutput(s);
    if (!grid || !output) return null;
    if (!specsMatch(grid.spec, output.spec)) return null;
    return { grid, output };
  }

  /**
   * current 以外の計算結果への参照を手放す。非表示のレイヤー（最大浸水深・到達時間・浸水を切っている間）は
   * 描き直されないので、放っておくと前の計算結果（全フレーム）がメモリに残り続ける。
   * 画像ソースの中身（キャンバス）はそのまま。applyLayers は結果の一致しないレイヤーを表示しない。
   */
  private dropStaleOutputs(current: SimOutput | null): void {
    let changed = false;
    for (const r of Object.values(this.rasters)) {
      if (r.output && r.output !== current) {
        r.output = null;
        r.key = '';
        changed = true;
      }
    }
    if (this.ref && this.ref.output !== current) this.ref = null;
    this.people?.dropOutput(current);
    if (changed) this.dirty.layers = true;
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
    this.root.classList.toggle('m2d-basemap-labeled', b !== 'photo');
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
        : `浸水計算の地形: ${DEM_CREDIT_HTML}`;
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
      // 基準の潮位は出力から推定する（推定できないときは、表示中の結果を計算した条件の潮位）
      this.ref = buildFloodReference(grid, output, this.depthBuf, resultParams(s).tideTP);
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
    // sim の出力が更新番号（revision）を持てばそれで判定する（最大値・到達時間は同じ配列が書き換わるため）
    const key = `${outputRevision(output) ?? output.framesReady()}|${s.sim.status}`;
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
    let kind: CursorInfo['kind'];
    let waterDepth: number | undefined;
    if (grid) {
      try {
        ground = sampleGround(grid, m.lon, m.lat);
      } catch (e) {
        this.logOnce('sampleGround', e);
      }
      const cell = lonLatToCell(grid.spec, m.lon, m.lat);
      if (cell) kind = grid.kind[cell.k] === CELL_SEA ? 'sea' : 'land';
    }
    const data = this.simData(s);
    if (data && data.output.framesReady() > 0) {
      const cell = lonLatToCell(data.output.spec, m.lon, m.lat);
      if (cell) {
        const t = Math.max(0, Math.min(s.time.t, data.output.timeReady()));
        const v = data.output.depthAt(t, cell.k);
        if (data.grid.kind[cell.k] === CELL_SEA) {
          // 海・川のセルの全水深は「浸水深」ではないので、水深として別に渡す
          if (Number.isFinite(v)) waterDepth = Math.max(0, v);
        } else {
          depth = Number.isFinite(v) ? Math.max(0, v) : null;
        }
      }
    }
    this.actions.setCursor({ lon: m.lon, lat: m.lat, ground: ground ?? null, depth, kind, waterDepth });
  }

  /**
   * 狭い画面（幅 640px 未満）では、出典を最初から折りたたむ（ⓘ ボタンで開ける）。
   * MapLibre は compact でも最初は開いた状態で表示し、地図を動かすまで閉じないため、長い出典が地図を覆ってしまう。
   */
  private collapseAttributionOnNarrow(): void {
    const el = this.root.querySelector<HTMLElement>('.maplibregl-ctrl-attrib');
    if (!el || this.root.clientWidth >= 640 || typeof MutationObserver === 'undefined') return;
    const collapse = () => {
      if (!el.classList.contains('maplibregl-compact-show')) return false;
      el.classList.remove('maplibregl-compact-show');
      el.removeAttribute('open');
      return true;
    };
    if (collapse()) return;
    // 出典の中身が届いて開かれた時点で1回だけ閉じる
    const mo = new MutationObserver(() => {
      if (collapse()) mo.disconnect();
    });
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    window.setTimeout(() => mo.disconnect(), 15000);
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
    this.notice.style.top = `${top + hintH}px`;
    const noticeH = this.notice.hidden ? 0 : this.notice.offsetHeight + 6;
    this.toast.style.top = `${top + hintH + noticeH}px`;
    this.fitControls();
  }

  /**
   * 狭い画面・タッチ操作では、ズームのボタンを指で押しやすい大きさ（幅 40px）にする。
   * 高さは、下にある「場所を探す」ボタン（UI 担当、#hud .maptools）と重ならない範囲で最大 40px。
   */
  private fitControls(): void {
    try {
      const group = this.root.querySelector<HTMLElement>('.maplibregl-ctrl-top-right .maplibregl-ctrl-group');
      if (!group) return;
      const touch = typeof matchMedia === 'function' && matchMedia('(max-width: 819.98px), (pointer: coarse)').matches;
      if (!touch) {
        this.root.style.removeProperty('--m2d-zoom-h');
        return;
      }
      // 揺れのアニメーション中は地図が拡大・移動しているので測らない（終わってから測り直す）
      const view = this.root.parentElement;
      if (view && getComputedStyle(view).transform !== 'none') {
        window.clearTimeout(this.fitTimer);
        this.fitTimer = window.setTimeout(() => this.fitControls(), 500);
        return;
      }
      // 「場所を探す」ボタンが見つからない・見えていない（大きさが測れない）間は変えない
      // （HUD の描き直しの途中などで一時的に無いことがある。既定は CSS の 29px）
      const tools = document.querySelector<HTMLElement>('#hud .maptools');
      if (!tools) return;
      const tr = tools.getBoundingClientRect();
      const gr = group.getBoundingClientRect();
      if (tr.height <= 0 || gr.height <= 0) return;
      let h = TOUCH_TARGET_PX;
      if (tr.left < gr.right && tr.right > gr.left) {
        // ボタンは 2 つ（拡大・縮小）と区切り線 1px。下のボタンとの間は 6px 空ける
        const room = tr.top - gr.top - 6 - 1;
        h = Math.max(29, Math.min(TOUCH_TARGET_PX, Math.floor(room / 2)));
      }
      this.root.style.setProperty('--m2d-zoom-h', `${h}px`);
    } catch {
      // 見た目だけの調整なので失敗しても続ける
    }
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
    const err = e.error as { message?: string; status?: number; url?: string; name?: string } | undefined;
    if (e.sourceId || e.tile) {
      // 公式ハザードマップは浸水想定のない区域のタイルが 404 になるのが通常なので記録しない
      if (err?.status === 404 && e.sourceId === IDS.hazard) return;
      // 地図の移動などで要らなくなったタイルの取得を止めただけ（失敗ではない）
      if (err?.name === 'AbortError') return;
      // タイルが存在しない（404 など）のではなく、取得できなかった: 地図の上に知らせる
      if (e.sourceId && this.noticeSource(e.sourceId) && err?.status !== 404 && err?.status !== 204) {
        const t = this.tileTrouble.get(e.sourceId) ?? { failedAt: 0, okAt: 0 };
        t.failedAt = performance.now();
        this.tileTrouble.set(e.sourceId, t);
        this.updateNotice();
        // 公式ハザードマップ: 色が無い所も「浸水しない」という意味ではないことを HUD の凡例・レイヤーのタブにも示す
        if (e.sourceId === IDS.hazard) this.reportHazard(false);
      }
      const key = `tile:${e.sourceId ?? '?'}:${err?.status ?? 'network'}`;
      if (!this.loggedErrors.has(key)) {
        this.loggedErrors.add(key);
        console.warn(`[map2d] タイルを取得できませんでした（${e.sourceId ?? '不明なソース'}）: ${err?.message ?? String(err)}`);
      }
      return;
    }
    this.logOnce(`map:${err?.message ?? String(e.error)}`, e.error);
  };

  /** タイルを取得できたとき: 取得できない状態が続いていなければ案内を消す */
  private onSourceData = (e: { sourceId?: string; tile?: unknown }): void => {
    if (!e.sourceId || !e.tile) return;
    const t = this.tileTrouble.get(e.sourceId);
    if (!t) {
      // 公式ハザードマップのタイルを取得できた（取得できなかったタイルが残っていない）
      if (e.sourceId === IDS.hazard) this.reportHazard(true);
      return;
    }
    t.okAt = performance.now();
    this.updateNotice();
  };

  /**
   * 公式ハザードマップのタイルを取得できたか（ok）・できなかったかをコントローラに知らせる（表示中のときだけ。
   * 同じ知らせは繰り返さない）。取得できなかった後は、取得できるようになってしばらく失敗しなければ（updateNotice）ok を知らせる。
   */
  private reportHazard(ok: boolean): void {
    const s = this.store.get();
    // 3D 表示の間は 3D 側が知らせる（この地図の状態は、表示したときに知らせ直す）
    if (!this.active || !s.layers.officialHazard) return;
    const next = ok ? 'ok' : 'error';
    if (s.officialInundation.display === next) return;
    // 確かめ直している最中（'checking'）に届いた ok は、その結果を待たずに使ってよい（実際にタイルを取得できている）
    this.actions.reportOfficialHazardDisplay(ok);
  }

  /** 公式ハザードマップの取得できなかったタイルを読み込み直す */
  private retryHazardTiles(): void {
    if (!this.tileTrouble.has(IDS.hazard)) return;
    const src = this.map?.getSource(IDS.hazard) as Partial<Pick<RasterTileSource, 'setTiles' | 'tiles'>> | undefined;
    try {
      if (src?.setTiles && src.tiles) src.setTiles([...src.tiles]);
    } catch (e) {
      this.logOnce(`retry:${IDS.hazard}`, e);
    }
  }

  /** 案内の対象のソースか（背景地図・色別標高・公式ハザードマップ） */
  private noticeSource(sourceId: string): NoticeSource | null {
    if (sourceId.startsWith('m2d-base-')) return 'basemap';
    if (sourceId === IDS.relief) return 'relief';
    if (sourceId === IDS.hazard) return 'hazard';
    return null;
  }

  /** タイルを取得できない案内を更新（表示中のソースで、最後に失敗してから取得できていないもの） */
  private updateNotice(): void {
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = 0;
    const s = this.store.get();
    const now = performance.now();
    const shown = new Set<NoticeSource>();
    let pending = false;
    for (const [id, t] of this.tileTrouble) {
      const kind = this.noticeSource(id);
      if (!kind) continue;
      const visible = kind === 'basemap' ? id === basemapLayerId(s.basemap) : kind === 'relief' ? s.layers.elevation : s.layers.officialHazard;
      if (!visible) continue;
      const recovered = t.okAt > t.failedAt;
      if (recovered && now - t.failedAt >= TILE_RECOVER_MS) {
        this.tileTrouble.delete(id);
        // 公式ハザードマップを取得できるようになった
        if (kind === 'hazard') this.reportHazard(true);
        continue;
      }
      if (recovered) pending = true;
      shown.add(kind);
    }
    // 取得できるようになったら、少し待って（続けて失敗しないことを確かめて）消す
    if (pending) this.noticeTimer = window.setTimeout(() => this.updateNotice(), TILE_RECOVER_MS);
    const kinds = (['basemap', 'relief', 'hazard'] as NoticeSource[]).filter((k) => shown.has(k));
    const key = kinds.join(',');
    if (key === this.noticeKey) return;
    this.noticeKey = key;
    if (kinds.length === 0) {
      this.notice.hidden = true;
      this.noticeText.textContent = '';
    } else {
      const tail = kinds.includes('basemap') ? '通信状態を確認してください。浸水の計算と避難場所の表示は続けられます。' : '通信状態を確認してください。';
      this.noticeText.textContent = `${kinds.map((k) => NOTICE_TEXT[k]).join('')}${tail}`;
      this.notice.hidden = false;
    }
    this.placeOverlays();
  }

  /** 取得できなかったタイルを読み込み直す */
  private retryTiles(): void {
    const map = this.map;
    if (!map) return;
    for (const id of this.tileTrouble.keys()) {
      const src = map.getSource(id) as Partial<Pick<RasterTileSource, 'setTiles' | 'tiles'>> | undefined;
      try {
        if (src?.setTiles && src.tiles) src.setTiles([...src.tiles]);
      } catch (e) {
        this.logOnce(`retry:${id}`, e);
      }
    }
  }

  private logOnce(key: string, e: unknown): void {
    if (this.loggedErrors.has(key)) return;
    this.loggedErrors.add(key);
    console.warn(`[map2d] ${key}`, e);
  }
}

/** 計算結果の更新番号（sim の実装が revision を持つ場合のみ） */
function outputRevision(output: SimOutput): number | null {
  const r = (output as SimOutput & { revision?: unknown }).revision;
  return typeof r === 'number' && Number.isFinite(r) ? r : null;
}

/** HUD（左上の列）が広がりうる最大の幅 [px]（CSS の max-width。px で読めなければ 320px） */
function hudMaxWidth(el: HTMLElement): number {
  const FALLBACK = 320;
  try {
    const mw = getComputedStyle(el).maxWidth;
    const px = /^(\d+(?:\.\d+)?)px$/.exec(mw);
    if (px) return Number(px[1]);
    // min(320px, calc(100% - 24px)) などは最初の px の値
    const first = /(\d+(?:\.\d+)?)px/.exec(mw);
    return first ? Math.min(FALLBACK * 1.5, Number(first[1])) : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/**
 * 「計算範囲を表示」の要求か（UI 担当の mapTools.ts は計算範囲の中央 INITIAL_CENTER へ、地図の幅に合わせたズームで
 * 移動を要求する。地名検索・現在地の要求は名前・現在地の位置を持つ）。
 */
function isDomainFocus(f: MapFocus): boolean {
  return !f.label && Math.abs(f.lon - INITIAL_CENTER.lon) < 1e-9 && Math.abs(f.lat - INITIAL_CENTER.lat) < 1e-9;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6;
}
