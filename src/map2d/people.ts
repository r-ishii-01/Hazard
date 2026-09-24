/**
 * 人物マーカー（HTML）と避難経路（ライン）・避難先（円）の表示。
 * 位置は毎フレーム personStateAt で求め、変化があったときだけ DOM を触る。
 * 状態の表示名・色は「人物」タブの凡例と同じ（people の PERSON_STATUS_INFO・personStatusLabel）。
 * 経路と避難先はそれぞれ内容が変わったときだけ地図のソースを更新する（避難先は再生中に変わらない）。
 */
import { Marker, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { AppActions } from '../core/controller';
import type { EvacPlan, Person, PersonState, PersonStatus, SimOutput, TerrainGrid } from '../core/types';
import { formatDepth } from '../core/format';
import { PERSON_PROFILES, personStateAt, personStatusLabel } from '../people';
import { FLAG_SVG, STATUS_STYLE, personIconSvg, statusBadgeSvg } from './icons';
import { IDS, emptyFC, type GeoFeature, type GeoFeatureCollection } from './style';

interface PersonView {
  id: string;
  marker: Marker;
  el: HTMLElement;
  disc: HTMLElement;
  badge: HTMLElement;
  label: HTMLElement;
  nameEl: HTMLElement;
  depthEl: HTMLElement;
  kind: Person['kind'] | '';
  name: string;
  status: PersonStatus | '';
  depthText: string;
  title: string;
  selected: boolean;
  draggable: boolean;
  lon: number;
  lat: number;
}

export interface PeopleContext {
  people: Person[];
  plans: Record<string, EvacPlan>;
  selectedId: string | null;
  grid: TerrainGrid | null;
  output: SimOutput | null;
  t: number;
  playing: boolean;
}

/** ドロップ位置が有効か判定し、無効なら理由を返す */
export type DropValidator = (lon: number, lat: number) => string | null;

export class PeopleLayer {
  private views = new Map<string, PersonView>();
  private draggingId: string | null = null;
  /** ドラッグで位置を変えた直後、再計算前の古い計画（使わない） */
  private stalePlans = new Map<string, EvacPlan | undefined>();
  private lastRouteKey = '';
  private lastTargetKey = '';
  /** 経路・避難先のソースを更新した回数（計測・テスト用） */
  setDataCount = { routes: 0, targets: 0 };
  private targetLabel: Marker | null = null;
  private targetLabelKey = '';
  private lastCtx: PeopleContext | null = null;

  constructor(
    private map: MapLibreMap,
    private actions: AppActions,
    private validateDrop: DropValidator,
    private notify: (msg: string) => void,
  ) {}

  /** 古い計画は使わない（ドラッグ直後など） */
  private planFor(ctx: PeopleContext, id: string): EvacPlan | undefined {
    const plan = ctx.plans[id];
    if (this.stalePlans.has(id)) {
      if (this.stalePlans.get(id) === plan) return undefined;
      this.stalePlans.delete(id);
    }
    return plan;
  }

  private stateOf(ctx: PeopleContext, p: Person): PersonState {
    try {
      return personStateAt(p, this.planFor(ctx, p.id), ctx.grid, ctx.output, ctx.t);
    } catch (e) {
      logOnce('personStateAt', e);
      return { lon: p.lon, lat: p.lat, ground: 0, depth: 0, status: 'waiting', message: '' };
    }
  }

  /** マーカーを更新（毎フレーム呼んでよい） */
  update(ctx: PeopleContext): void {
    this.lastCtx = ctx;
    const seen = new Set<string>();
    for (const p of ctx.people) {
      seen.add(p.id);
      let v = this.views.get(p.id);
      if (!v) {
        v = this.create(p);
        this.views.set(p.id, v);
      }
      const st = this.stateOf(ctx, p);
      this.apply(v, p, st, ctx);
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        v.marker.remove();
        this.views.delete(id);
        this.stalePlans.delete(id);
      }
    }
  }

  private create(p: Person): PersonView {
    const el = document.createElement('div');
    el.className = 'm2d-person';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const disc = document.createElement('div');
    disc.className = 'm2d-person__disc';
    const badge = document.createElement('div');
    badge.className = 'm2d-person__badge';
    const label = document.createElement('div');
    label.className = 'm2d-person__label';
    const nameEl = document.createElement('span');
    const depthEl = document.createElement('span');
    depthEl.className = 'm2d-person__depth';
    depthEl.hidden = true;
    label.append(nameEl, depthEl);
    el.append(disc, badge, label);

    const marker = new Marker({ element: el, anchor: 'center', draggable: false, subpixelPositioning: true })
      .setLngLat([p.lon, p.lat])
      .addTo(this.map);
    const id = p.id;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.actions.selectPerson(id);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this.actions.selectPerson(id);
      }
    });
    marker.on('dragstart', () => {
      this.draggingId = id;
      this.actions.selectPerson(id);
    });
    marker.on('dragend', () => this.onDragEnd(id));

    return {
      id,
      marker,
      el,
      disc,
      badge,
      label,
      nameEl,
      depthEl,
      kind: '',
      name: '',
      status: '',
      depthText: '',
      title: '',
      selected: false,
      draggable: false,
      lon: p.lon,
      lat: p.lat,
    };
  }

  private onDragEnd(id: string): void {
    this.draggingId = null;
    const v = this.views.get(id);
    const ctx = this.lastCtx;
    if (!v || !ctx) return;
    const ll = v.marker.getLngLat();
    const reason = this.validateDrop(ll.lng, ll.lat);
    if (reason) {
      this.notify(reason);
      v.marker.setLngLat([v.lon, v.lat]);
      return;
    }
    this.stalePlans.set(id, ctx.plans[id]);
    v.lon = ll.lng;
    v.lat = ll.lat;
    this.actions.updatePerson(id, { lon: ll.lng, lat: ll.lat });
    if (ctx.t > 0) this.notify('地震発生時にいた位置を変更しました');
  }

  private apply(v: PersonView, p: Person, st: PersonState, ctx: PeopleContext): void {
    const profile = PERSON_PROFILES[p.kind];
    if (v.kind !== p.kind) {
      v.kind = p.kind;
      v.disc.innerHTML = personIconSvg(p.kind);
      v.el.style.setProperty('--m2d-kind', profile?.color ?? '#1e293b');
    }
    if (v.name !== p.name) {
      v.name = p.name;
      v.nameEl.textContent = p.name;
    }
    const status: PersonStatus = STATUS_STYLE[st.status] ? st.status : 'waiting';
    if (v.status !== status) {
      if (v.status) v.el.classList.remove(`m2d-person--${v.status}`);
      v.el.classList.add(`m2d-person--${status}`);
      v.status = status;
      v.el.style.setProperty('--m2d-ring', STATUS_STYLE[status].color);
      // 状態の色の上のバッジ・浸水深の札の文字色（明るい色の上では濃い色）
      v.el.style.setProperty('--m2d-ink', STATUS_STYLE[status].ink);
      v.badge.innerHTML = statusBadgeSvg(status);
    }
    const depthText = st.depth >= 0.01 ? formatDepth(st.depth) : '';
    if (v.depthText !== depthText) {
      v.depthText = depthText;
      v.depthEl.textContent = depthText ? `浸水 ${depthText}` : '';
      v.depthEl.hidden = !depthText;
    }
    const title = `${p.name}（${profile?.label ?? p.kind}）: ${personStatusLabel(p, status)}${depthText ? ` / 浸水深 ${depthText}` : ''}${st.message ? ` — ${st.message}` : ''}`;
    if (v.title !== title) {
      v.title = title;
      v.el.title = title;
      v.el.setAttribute('aria-label', title);
    }
    const selected = ctx.selectedId === p.id;
    if (v.selected !== selected) {
      v.selected = selected;
      v.el.classList.toggle('m2d-person--selected', selected);
      v.el.setAttribute('aria-pressed', String(selected));
    }
    const draggable = !ctx.playing;
    if (v.draggable !== draggable) {
      v.draggable = draggable;
      v.marker.setDraggable(draggable);
      v.el.classList.toggle('m2d-drag', draggable);
    }
    if (this.draggingId === p.id) return;
    const lon = Number.isFinite(st.lon) ? st.lon : p.lon;
    const lat = Number.isFinite(st.lat) ? st.lat : p.lat;
    if (Math.abs(lon - v.lon) > 1e-8 || Math.abs(lat - v.lat) > 1e-8) {
      v.lon = lon;
      v.lat = lat;
      v.marker.setLngLat([lon, lat]);
    }
  }

  /** 経路と避難先の図形を更新（間引いて呼ぶ） */
  updateRoutes(ctx: PeopleContext): void {
    const features: GeoFeature[] = [];
    const targets: GeoFeature[] = [];
    const keyParts: string[] = [];
    // 選択中の人を最後に（上に）描く
    const order = [...ctx.people].sort((a, b) => Number(a.id === ctx.selectedId) - Number(b.id === ctx.selectedId));
    let selTarget: { lon: number; lat: number; name: string; color: string } | null = null;
    for (const p of order) {
      const plan = this.planFor(ctx, p.id);
      const sel = p.id === ctx.selectedId;
      const color = PERSON_PROFILES[p.kind]?.color ?? '#2563eb';
      if (plan?.target) {
        targets.push({
          type: 'Feature',
          properties: { id: p.id, color, sel },
          geometry: { type: 'Point', coordinates: [plan.target.lon, plan.target.lat] },
        });
        if (sel) selTarget = { ...plan.target, color };
      }
      if (!plan || plan.path.length < 2) continue;
      const split = splitPath(plan, ctx.t);
      keyParts.push(`${p.id}:${sel ? 1 : 0}:${color}:${split.index}:${split.point[0].toFixed(6)},${split.point[1].toFixed(6)}:${plan.path.length}`);
      if (split.done.length >= 2) {
        features.push({ type: 'Feature', properties: { id: p.id, part: 'done', color, sel }, geometry: { type: 'LineString', coordinates: split.done } });
      }
      if (split.ahead.length >= 2) {
        features.push({ type: 'Feature', properties: { id: p.id, part: 'ahead', color, sel }, geometry: { type: 'LineString', coordinates: split.ahead } });
      }
    }
    // 経路（通過済みと、これから進む部分の境目が時刻とともに動く）と避難先（再生中は変わらない）は別々に判定する
    const key = keyParts.join('|');
    if (key !== this.lastRouteKey) {
      this.lastRouteKey = key;
      this.setDataCount.routes += 1;
      setData(this.map, IDS.routeSource, { type: 'FeatureCollection', features });
    }
    const targetKey = targets.map((f) => `${(f.properties as { id: string }).id}:${JSON.stringify(f.geometry)}:${(f.properties as { sel: boolean }).sel}:${(f.properties as { color: string }).color}`).join('|');
    if (targetKey !== this.lastTargetKey) {
      this.lastTargetKey = targetKey;
      this.setDataCount.targets += 1;
      setData(this.map, IDS.targetSource, { type: 'FeatureCollection', features: targets });
    }
    this.updateTargetLabel(selTarget);
  }

  /** 選択中の人物の避難先に小さな旗と名前を出す */
  private updateTargetLabel(t: { lon: number; lat: number; name: string; color: string } | null): void {
    const key = t ? `${t.lon},${t.lat},${t.name},${t.color}` : '';
    if (key === this.targetLabelKey) return;
    this.targetLabelKey = key;
    this.targetLabel?.remove();
    this.targetLabel = null;
    if (!t) return;
    const el = document.createElement('div');
    el.className = 'm2d-target-label';
    el.style.cssText =
      'pointer-events:none;display:flex;align-items:center;gap:2px;font-size:11px;font-weight:700;white-space:nowrap;' +
      'color:#0f172a;background:rgba(255,255,255,.94);border-radius:4px;padding:1px 6px 1px 3px;box-shadow:0 0 0 1.5px ' +
      t.color +
      ';';
    const flag = document.createElement('span');
    flag.style.cssText = `display:inline-block;width:14px;height:14px;color:${t.color}`;
    flag.innerHTML = FLAG_SVG;
    const txt = document.createElement('span');
    txt.textContent = `避難先: ${t.name}`;
    el.append(flag, txt);
    // 到着した人物のマーカー（半径 約20px）と重ならないよう上にずらす
    this.targetLabel = new Marker({ element: el, anchor: 'bottom', offset: [0, -24] }).setLngLat([t.lon, t.lat]).addTo(this.map);
  }

  /** 経路を消す（データなし時） */
  clearRoutes(): void {
    this.lastRouteKey = '';
    this.lastTargetKey = '';
    setData(this.map, IDS.routeSource, emptyFC());
    setData(this.map, IDS.targetSource, emptyFC());
    this.updateTargetLabel(null);
  }

  /**
   * 前の計算結果への参照を手放す（新しい計算が始まった・地形を読み込み直したとき）。
   * 直近の状態（ドラッグの終わりの処理用）の計算結果と避難計画も手放す: 計画は、計算結果を参照する
   * 状態判定のキャッシュ（people）のキーなので、古い計画を持ち続けると古い計算結果もメモリに残る。
   * 地図を表示していれば、すぐ次の update で今の状態に置き換わる。
   */
  dropOutput(current: SimOutput | null): void {
    const c = this.lastCtx;
    if (c && c.output !== current) this.lastCtx = { ...c, output: null, plans: {} };
    this.stalePlans.clear();
  }

  destroy(): void {
    for (const v of this.views.values()) v.marker.remove();
    this.views.clear();
    this.targetLabel?.remove();
    this.targetLabel = null;
  }
}

/** 経路を時刻 t で「通過済み」と「これから」に分ける */
export function splitPath(plan: EvacPlan, t: number): { done: [number, number][]; ahead: [number, number][]; point: [number, number]; index: number } {
  const path = plan.path;
  const n = path.length;
  const c = (i: number): [number, number] => [path[i].lon, path[i].lat];
  if (!(t > path[0].t)) return { done: [], ahead: path.map((_, i) => c(i)), point: c(0), index: -1 };
  if (t >= path[n - 1].t) return { done: path.map((_, i) => c(i)), ahead: [], point: c(n - 1), index: n - 1 };
  // 二分探索で path[i].t <= t < path[i+1].t
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = path[lo];
  const b = path[lo + 1];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  const point: [number, number] = [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f];
  const done: [number, number][] = [];
  for (let i = 0; i <= lo; i++) done.push(c(i));
  done.push(point);
  const ahead: [number, number][] = [point];
  for (let i = lo + 1; i < n; i++) ahead.push(c(i));
  return { done, ahead, point, index: lo };
}

function setData(map: MapLibreMap, id: string, data: GeoFeatureCollection): void {
  const src = map.getSource(id) as GeoJSONSource | undefined;
  if (!src) return;
  src.setData(data).catch((e: unknown) => logOnce(`setData:${id}`, e));
}

const logged = new Set<string>();
function logOnce(key: string, e: unknown): void {
  if (logged.has(key)) return;
  logged.add(key);
  console.warn(`[map2d] ${key}`, e);
}
