/**
 * 人物（3D の人形）・状態リング・ラベル・避難経路。
 *
 * - 人形は実寸（大人 約1.7 m）のモデルを「見やすさ倍率」S 倍に拡大して置く（S はカメラ距離で決まる）
 * - 浸水中は、水深 / 身長 の割合だけ体が水面下に入るよう沈める（拡大しても割合は正しい）
 * - 経路は地面に沿った帯。通過済みは実線、これから進む部分は破線
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  ShaderMaterial,
  Color,
  Vector3,
  type Camera,
} from 'three';
import { CELL_SEA, type EvacPlan, type Person, type PersonKind, type PersonState, type PersonStatus, type SimOutput, type TerrainGrid } from '../core/types';
import { PERSON_PROFILES, PERSON_STATUS_INFO, personStateAt } from '../people';
import { createFigureGeometry } from './figures';
import { LabelSprite } from './labels';
import type { HeightSampler } from './sampler';

/** 状態の表示名と色（people モジュールの定義に合わせる） */
export const STATUS_COLORS: Record<PersonStatus, string> = {
  waiting: PERSON_STATUS_INFO.waiting?.color ?? '#64748b',
  evacuating: PERSON_STATUS_INFO.evacuating?.color ?? '#2563eb',
  safe: PERSON_STATUS_INFO.safe?.color ?? '#16a34a',
  caution: PERSON_STATUS_INFO.caution?.color ?? '#ca8a04',
  danger: PERSON_STATUS_INFO.danger?.color ?? '#ea580c',
  critical: PERSON_STATUS_INFO.critical?.color ?? '#b91c1c',
};

export const STATUS_LABELS: Record<PersonStatus, string> = {
  waiting: PERSON_STATUS_INFO.waiting?.label ?? '避難開始前',
  evacuating: PERSON_STATUS_INFO.evacuating?.label ?? '避難中',
  safe: PERSON_STATUS_INFO.safe?.label ?? '避難完了',
  caution: PERSON_STATUS_INFO.caution?.label ?? '浸水（注意）',
  danger: PERSON_STATUS_INFO.danger?.label ?? '歩行困難（危険）',
  critical: PERSON_STATUS_INFO.critical?.label ?? '生命の危険',
};

const ROUTE_VERT = /* glsl */ `
attribute vec3 aPerp;
attribute float aDist;
attribute float aSide;
uniform float uHalfWidth;
uniform float uOffset;
uniform float uExag;
uniform float uLift;
varying float vDist;
varying float vSide;
void main() {
  vec3 p = position;
  p.xz += aPerp.xz * uHalfWidth + aPerp.xz * aSide * uOffset;
  p.y = p.y * uExag + uLift;
  vDist = aDist;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const ROUTE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uSplit;
uniform float uDash;
uniform float uOpacity;
varying float vDist;
varying float vSide;
void main() {
  bool ahead = vDist > uSplit;
  if (ahead && fract(vDist / uDash) > 0.58) discard;
  float edge = smoothstep(0.55, 0.7, abs(vSide));
  vec3 c = mix(uColor, vec3(1.0), edge);
  float a = (ahead ? 0.88 : 1.0) * uOpacity;
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface RouteData {
  mesh: Mesh;
  material: ShaderMaterial;
  /** 経路の各点の時刻 [秒] と累積距離 [m] */
  times: Float64Array;
  cum: Float64Array;
}

interface Entry {
  person: Person;
  root: Group;
  body: Mesh;
  ring: Mesh;
  ringMat: MeshBasicMaterial;
  label: LabelSprite;
  height: number;
  plan: EvacPlan | undefined;
  route: RouteData | null;
  lastX: number;
  lastZ: number;
  heading: number;
  /** 経路をずらす番号 */
  lane: number;
  state: PersonState | null;
  /** ピック用: 体の中心（ワールド座標）と頭上 */
  mid: Vector3;
  top: Vector3;
}

export interface PeopleUpdateContext {
  t: number;
  grid: TerrainGrid;
  output: SimOutput | null;
  sampler: HeightSampler;
  exag: number;
  /** 見やすさ倍率 */
  scale: number;
  viewportH: number;
  p11: number;
  now: number;
  selectedId: string | null;
  camera: Camera;
  viewportW: number;
}

export class PeopleLayer {
  /** 人形・リング・ラベル（鉛直強調しない） */
  readonly group = new Group();
  /** 経路 */
  readonly routes = new Group();
  private readonly geos = new Map<PersonKind, { geometry: BufferGeometry; height: number }>();
  private readonly bodyMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 });
  private readonly bodySelMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, emissive: new Color('#fde68a'), emissiveIntensity: 0.35 });
  private readonly ringGeo = new RingGeometry(0.42, 0.66, 40).rotateX(-Math.PI / 2);
  private readonly selGeo = new RingGeometry(0.78, 0.94, 48).rotateX(-Math.PI / 2);
  private readonly selMat = new MeshBasicMaterial({ color: '#facc15', transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
  private readonly selRing: Mesh;
  private readonly entries = new Map<string, Entry>();
  private readonly tmp = new Vector3();
  private laneSeq = 0;

  constructor() {
    this.selRing = new Mesh(this.selGeo, this.selMat);
    this.selRing.renderOrder = 6;
    this.selRing.visible = false;
    this.group.add(this.selRing);
    this.group.name = 'people';
    this.routes.name = 'routes';
  }

  private geometryFor(kind: PersonKind): { geometry: BufferGeometry; height: number } {
    let g = this.geos.get(kind);
    if (!g) {
      g = createFigureGeometry(kind, PERSON_PROFILES[kind]?.color ?? '#2563eb');
      this.geos.set(kind, g);
    }
    return g;
  }

  /** 人物リスト・避難計画の変更を反映 */
  sync(people: Person[], plans: Record<string, EvacPlan>, sampler: HeightSampler | null): void {
    const seen = new Set<string>();
    for (const p of people) {
      seen.add(p.id);
      let e = this.entries.get(p.id);
      if (e && e.person.kind !== p.kind) {
        this.remove(e);
        e = undefined;
      }
      if (!e) e = this.create(p);
      e.person = p;
      const plan = plans[p.id];
      if (plan !== e.plan) {
        e.plan = plan;
        this.disposeRoute(e);
        if (plan && sampler) e.route = this.buildRoute(plan, sampler, p.kind);
        if (e.route) this.routes.add(e.route.mesh);
      }
    }
    for (const [id, e] of this.entries) if (!seen.has(id)) this.remove(e);
  }

  /** 地形が変わったら経路を作り直す */
  rebuildRoutes(sampler: HeightSampler | null): void {
    for (const e of this.entries.values()) {
      this.disposeRoute(e);
      if (e.plan && sampler) {
        e.route = this.buildRoute(e.plan, sampler, e.person.kind);
        if (e.route) this.routes.add(e.route.mesh);
      }
    }
  }

  private create(p: Person): Entry {
    const { geometry, height } = this.geometryFor(p.kind);
    const root = new Group();
    const body = new Mesh(geometry, this.bodyMat);
    body.name = `person-${p.id}`;
    root.add(body);
    const ringMat = new MeshBasicMaterial({ color: STATUS_COLORS.waiting, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    const ring = new Mesh(this.ringGeo, ringMat);
    ring.renderOrder = 5;
    const label = new LabelSprite();
    this.group.add(root, ring, label.sprite);
    const e: Entry = {
      person: p,
      root,
      body,
      ring,
      ringMat,
      label,
      height,
      plan: undefined,
      route: null,
      lastX: NaN,
      lastZ: NaN,
      heading: 0,
      lane: this.laneSeq++,
      state: null,
      mid: new Vector3(),
      top: new Vector3(),
    };
    this.entries.set(p.id, e);
    return e;
  }

  private remove(e: Entry): void {
    this.group.remove(e.root, e.ring, e.label.sprite);
    e.ringMat.dispose();
    e.label.dispose();
    this.disposeRoute(e);
    this.entries.delete(e.person.id);
  }

  private disposeRoute(e: Entry): void {
    if (!e.route) return;
    this.routes.remove(e.route.mesh);
    e.route.mesh.geometry.dispose();
    e.route.material.dispose();
    e.route = null;
  }

  private buildRoute(plan: EvacPlan, sampler: HeightSampler, kind: PersonKind): RouteData | null {
    const path = plan.path;
    if (!path || path.length < 2) return null;
    const step = sampler.dx * 0.75;
    const xs: number[] = [];
    const zs: number[] = [];
    const ds: number[] = [];
    const times = new Float64Array(path.length);
    const cum = new Float64Array(path.length);
    let d = 0;
    let px = 0;
    let pz = 0;
    for (let i = 0; i < path.length; i++) {
      const q = sampler.toLocal(path[i].lon, path[i].lat);
      if (i > 0) {
        const len = Math.hypot(q.x - px, q.z - pz);
        const nseg = Math.max(1, Math.ceil(len / step));
        for (let s = 1; s <= nseg; s++) {
          const f = s / nseg;
          xs.push(px + (q.x - px) * f);
          zs.push(pz + (q.z - pz) * f);
          ds.push(d + len * f);
        }
        d += len;
      } else {
        xs.push(q.x);
        zs.push(q.z);
        ds.push(0);
      }
      times[i] = path[i].t;
      cum[i] = d;
      px = q.x;
      pz = q.z;
    }
    const m = xs.length;
    if (m < 2 || d <= 0) return null;
    const pos = new Float32Array(m * 2 * 3);
    const perp = new Float32Array(m * 2 * 3);
    const dist = new Float32Array(m * 2);
    const side = new Float32Array(m * 2);
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(m - 1, i + 1);
      let tx = xs[b] - xs[a];
      let tz = zs[b] - zs[a];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      let g = sampler.height(xs[i], zs[i]);
      const k = sampler.cellIndex(xs[i], zs[i]);
      // 橋などで川を渡る部分は川底に沈めない
      if (k >= 0 && sampler.grid.kind[k] === CELL_SEA) g = Math.max(g, 1.5);
      for (let sgn = 0; sgn < 2; sgn++) {
        const v = i * 2 + sgn;
        const sd = sgn === 0 ? -1 : 1;
        pos[v * 3] = xs[i];
        pos[v * 3 + 1] = g;
        pos[v * 3 + 2] = zs[i];
        perp[v * 3] = -tz * sd;
        perp[v * 3 + 2] = tx * sd;
        dist[v] = ds[i];
        side[v] = sd;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < m - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aPerp', new BufferAttribute(perp, 3));
    geo.setAttribute('aDist', new BufferAttribute(dist, 1));
    geo.setAttribute('aSide', new BufferAttribute(side, 1));
    geo.setIndex(idx);
    const material = new ShaderMaterial({
      uniforms: {
        uHalfWidth: { value: 3 },
        uOffset: { value: 0 },
        uExag: { value: 2 },
        uLift: { value: 1 },
        uColor: { value: new Color(PERSON_PROFILES[kind]?.color ?? '#2563eb') },
        uSplit: { value: 0 },
        uDash: { value: 20 },
        uOpacity: { value: 1 },
      },
      vertexShader: ROUTE_VERT,
      fragmentShader: ROUTE_FRAG,
      transparent: true,
      depthWrite: false,
      // 斜面で地面に埋もれないよう手前に寄せる
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const mesh = new Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return { mesh, material, times, cum };
  }

  /** 時刻・カメラに合わせて位置・状態・大きさを更新 */
  update(c: PeopleUpdateContext): void {
    const S = c.scale;
    let sel: Entry | null = null;
    for (const e of this.entries.values()) {
      let st: PersonState;
      try {
        st = personStateAt(e.person, e.plan, c.grid, c.output, c.t);
      } catch (err) {
        console.warn('[view3d] personStateAt failed', err);
        st = { lon: e.person.lon, lat: e.person.lat, ground: 0, depth: 0, status: 'waiting', message: '' };
      }
      e.state = st;
      const q = c.sampler.toLocal(st.lon, st.lat);
      let ground = c.sampler.height(q.x, q.z);
      const k = c.sampler.cellIndex(q.x, q.z);
      if (k >= 0 && c.grid.kind[k] === CELL_SEA) ground = Math.max(ground, 1.5);
      const depth = Number.isFinite(st.depth) && st.depth > 0.01 ? st.depth : 0;
      const surfaceY = (ground + depth) * c.exag;
      // 浸水中は 水深/身長 の割合だけ沈める
      const baseY = depth > 0 ? surfaceY - depth * S : ground * c.exag;
      // 向き（進行方向）
      if (Number.isFinite(e.lastX)) {
        const mx = q.x - e.lastX;
        const mz = q.z - e.lastZ;
        if (mx * mx + mz * mz > 0.04) e.heading = Math.atan2(-mx, -mz);
      }
      e.lastX = q.x;
      e.lastZ = q.z;
      e.root.position.set(q.x, baseY, q.z);
      e.root.rotation.y = e.heading;
      e.root.scale.setScalar(S);
      const selected = e.person.id === c.selectedId;
      e.body.material = selected ? this.bodySelMat : this.bodyMat;
      const ringY = Math.max(ground * c.exag, surfaceY) + 0.05 * S;
      e.ring.position.set(q.x, ringY, q.z);
      e.ring.scale.setScalar(S);
      e.ringMat.color.set(STATUS_COLORS[st.status] ?? STATUS_COLORS.waiting);
      const headY = baseY + e.height * S;
      e.mid.set(q.x, baseY + e.height * S * 0.55, q.z);
      e.top.set(q.x, Math.max(headY, ringY) + 0.25 * S, q.z);
      e.label.sprite.position.copy(e.top);
      e.label.fit(c.viewportH, c.p11);
      const depthText = depth > 0 ? `浸水 ${depth < 0.1 ? depth.toFixed(2) : depth.toFixed(1)} m` : '浸水なし';
      const statusText = STATUS_LABELS[st.status] ?? st.status;
      e.label.set({
        title: e.person.name,
        line2: selected ? `${statusText}・${depthText}` : depth > 0 ? depthText : statusText,
        accent: STATUS_COLORS[st.status] ?? STATUS_COLORS.waiting,
        selected,
        compact: !selected,
      });
      if (selected) sel = e;
      // 経路
      if (e.route) {
        const u = e.route.material.uniforms;
        u.uExag.value = c.exag;
        const hw = Math.max(0.7, 0.4 * S);
        u.uHalfWidth.value = hw * (selected ? 1.3 : 0.75);
        // 同じ道を通る経路が重ならないよう、少し横にずらす
        u.uOffset.value = selected ? 0 : (((e.lane % 3) - 1) * hw * 1.1);
        u.uLift.value = Math.max(0.3, 0.12 * S);
        u.uDash.value = Math.max(6, 3.2 * S);
        u.uOpacity.value = c.selectedId && !selected ? 0.6 : 1;
        u.uSplit.value = splitDistance(e.route, c.t);
        e.route.mesh.renderOrder = selected ? 4 : 3;
      }
    }
    this.declutter(c);
    if (sel) {
      this.selRing.visible = true;
      this.selRing.position.copy(sel.ring.position);
      this.selRing.position.y += 0.02 * S;
      this.selRing.scale.setScalar(S * (1 + 0.08 * Math.sin(c.now / 220)));
    } else {
      this.selRing.visible = false;
    }
  }

  /** ラベルの重なりを減らす（選択中・危険度の高い人を優先し、重なる低優先のラベルを隠す） */
  private declutter(c: PeopleUpdateContext): void {
    const order = [...this.entries.values()];
    const sev: Record<string, number> = { critical: 5, danger: 4, caution: 3, evacuating: 2, waiting: 1, safe: 0 };
    order.sort((a, b) => {
      const sa = a.person.id === c.selectedId ? 100 : sev[a.state?.status ?? 'waiting'] ?? 0;
      const sb = b.person.id === c.selectedId ? 100 : sev[b.state?.status ?? 'waiting'] ?? 0;
      return sb - sa;
    });
    const placed: [number, number, number, number][] = [];
    const v = this.tmp;
    for (const e of order) {
      v.copy(e.top).project(c.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) {
        e.label.sprite.visible = false;
        continue;
      }
      const sx = (v.x * 0.5 + 0.5) * c.viewportW;
      const sy = (-v.y * 0.5 + 0.5) * c.viewportH;
      const r: [number, number, number, number] = [sx - e.label.boxW / 2, sy - e.label.boxH, sx + e.label.boxW / 2, sy];
      const hit = placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]);
      const keep = !hit || e.person.id === c.selectedId;
      e.label.sprite.visible = keep;
      if (keep) placed.push(r);
    }
  }

  get count(): number {
    return this.entries.size;
  }

  /** 画面座標 (px) に最も近い人物の ID（体またはラベルの上） */
  pick(px: number, py: number, camera: Camera, w: number, h: number): string | null {
    const v = new Vector3();
    let best: string | null = null;
    let bestD = Infinity;
    for (const e of this.entries.values()) {
      v.copy(e.mid).project(camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      v.copy(e.top).project(camera);
      const tx = (v.x * 0.5 + 0.5) * w;
      const ty = (-v.y * 0.5 + 0.5) * h;
      const dBody = Math.hypot(px - sx, py - sy);
      // ラベル（頭上の吹き出し）
      const inLabel = e.label.sprite.visible && Math.abs(px - tx) < e.label.boxW / 2 && py < ty + 2 && py > ty - e.label.boxH;
      const d = inLabel ? 0 : dBody;
      if (d < 22 && d < bestD) {
        bestD = d;
        best = e.person.id;
      }
    }
    return best;
  }

  /** ツールチップ用の説明 */
  describe(id: string): string | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const st = e.state;
    const label = PERSON_PROFILES[e.person.kind]?.label ?? e.person.kind;
    const lines = [`${e.person.name}（${label}）`];
    if (st) {
      const status = STATUS_LABELS[st.status] ?? st.status;
      const depth = st.depth > 0.01 ? `浸水 ${st.depth.toFixed(2)} m` : '浸水なし';
      lines.push(`${status}・${depth}`);
      if (st.message && st.message !== status) lines.push(st.message);
    }
    if (e.plan?.target) lines.push(`目標: ${e.plan.target.name}`);
    return lines.join('\n');
  }

  dispose(): void {
    for (const e of [...this.entries.values()]) this.remove(e);
    for (const g of this.geos.values()) g.geometry.dispose();
    this.geos.clear();
    this.bodyMat.dispose();
    this.bodySelMat.dispose();
    this.ringGeo.dispose();
    this.selGeo.dispose();
    this.selMat.dispose();
  }
}

/** 時刻 t に経路上のどこまで進んだか [m] */
function splitDistance(r: RouteData, t: number): number {
  const { times, cum } = r;
  const n = times.length;
  if (t <= times[0]) return 0;
  if (t >= times[n - 1]) return cum[n - 1] + 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const f = span > 0 ? (t - times[lo]) / span : 1;
  return cum[lo] + (cum[hi] - cum[lo]) * f;
}
