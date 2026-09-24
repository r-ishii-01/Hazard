/**
 * 地点の目印: 現在地（ブラウザの位置情報）と、視点移動（地名検索など）の目的地。
 *
 * - 現在地: 地形（浸水中はその水面）に沿わせた精度の円（半透明の塗りと、画面上で一定の太さの縁）、
 *   中心の青い点、広がって消える輪（脈動。「動きを減らす」設定では止めた薄い輪）。
 *   中心の点は建物などに隠れないよう常に手前に描く。
 * - 目的地: 地名のラベル付きのピン（focus.label があるときだけ）。次の視点移動か、要求が取り消される（focus = null）まで表示する。
 * 位置の y は鉛直強調をかけた値（このグループ自体は強調しない）。
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  LinearFilter,
  Mesh,
  SRGBColorSpace,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Camera,
} from 'three';
import type { MapFocus, UserLocation } from '../core/types';
import { roundRect, spriteScaleForPx } from './labels';
import type { HeightSampler } from './sampler';

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, "IPAGothic", sans-serif';
const DPR = 2;
const USER_BLUE = '#1a73e8';
/** 精度の円の半径の範囲 [m]（極端に大きい値は地形に沿わせる計算が重くなり、表示の意味も薄いので制限する） */
const MIN_ACCURACY_M = 3;
const MAX_ACCURACY_M = 3000;
/** 中心の点の大きさ [CSS px] */
const DOT_PX = 22;
const PULSE_PX = 60;
const PULSE_PERIOD_MS = 2000;

const DISC_VERT = /* glsl */ `
attribute float aR;
varying float vR;
void main() {
  vR = aR;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DISC_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vR;
void main() {
  // 縁: 画面上で約 2px の線（距離によらず同じ太さ）
  float px = (1.0 - vR) / max(fwidth(vR), 1e-5);
  float rim = 1.0 - smoothstep(1.2, 2.6, px);
  float a = mix(0.14, 0.85, rim);
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w * DPR;
  c.height = h * DPR;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  draw(ctx);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}

function spriteMaterial(map: CanvasTexture): SpriteMaterial {
  return new SpriteMaterial({ map, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
}

export class MarkerLayer {
  readonly group = new Group();
  private readonly discMat: ShaderMaterial;
  private disc: Mesh | null = null;
  /** 精度の円の頂点（ローカル座標 xz と、中心からの割合） */
  private discXZ = new Float32Array(0);
  private readonly dotTex: CanvasTexture;
  private readonly dotMat: SpriteMaterial;
  private readonly dot: Sprite;
  private readonly pulseTex: CanvasTexture;
  private readonly pulseMat: SpriteMaterial;
  private readonly pulse: Sprite;
  private pinTex: CanvasTexture | null = null;
  private pinMat: SpriteMaterial | null = null;
  private pin: Sprite | null = null;
  private pinW = 0;
  private pinH = 0;
  private user: { loc: UserLocation; x: number; z: number } | null = null;
  private target: { x: number; z: number } | null = null;

  constructor() {
    this.group.name = 'markers';
    this.discMat = new ShaderMaterial({
      uniforms: { uColor: { value: new Color(USER_BLUE) } },
      vertexShader: DISC_VERT,
      fragmentShader: DISC_FRAG,
      transparent: true,
      depthWrite: false,
      // 地形・水面と同じ高さでちらつかないよう手前に寄せる
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -6,
    });
    this.dotTex = canvasTexture(DOT_PX, DOT_PX, (ctx) => {
      const c = DOT_PX / 2;
      ctx.shadowColor = 'rgba(15,23,42,0.45)';
      ctx.shadowBlur = 3;
      ctx.beginPath();
      ctx.arc(c, c, 8.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.beginPath();
      ctx.arc(c, c, 6, 0, Math.PI * 2);
      ctx.fillStyle = USER_BLUE;
      ctx.fill();
    });
    this.dotMat = spriteMaterial(this.dotTex);
    this.dot = new Sprite(this.dotMat);
    this.dot.renderOrder = 18;
    this.pulseTex = canvasTexture(PULSE_PX, PULSE_PX, (ctx) => {
      const c = PULSE_PX / 2;
      ctx.beginPath();
      ctx.arc(c, c, c - 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(26,115,232,0.18)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(26,115,232,0.9)';
      ctx.stroke();
    });
    this.pulseMat = spriteMaterial(this.pulseTex);
    this.pulse = new Sprite(this.pulseMat);
    this.pulse.renderOrder = 17;
    this.dot.visible = false;
    this.pulse.visible = false;
    this.group.add(this.pulse, this.dot);
  }

  /** 現在地を設定（null で消す）。精度の円のメッシュを作り直す */
  setUserLocation(loc: UserLocation | null, sampler: HeightSampler | null): void {
    this.disposeDisc();
    if (!loc || !sampler) {
      this.user = null;
      this.dot.visible = false;
      this.pulse.visible = false;
      return;
    }
    const q = sampler.toLocal(loc.lon, loc.lat);
    this.user = { loc, x: q.x, z: q.z };
    this.dot.visible = true;
    this.pulse.visible = true;
    const r = Math.min(MAX_ACCURACY_M, Math.max(MIN_ACCURACY_M, Number.isFinite(loc.accuracyM) ? loc.accuracyM : MIN_ACCURACY_M));
    // 地形のセルより細かく分割して、起伏に沿わせる
    const rings = Math.min(48, Math.max(3, Math.ceil(r / (sampler.dx * 0.75))));
    const segs = r > 400 ? 96 : 64;
    const nv = 1 + rings * segs;
    const xz = new Float32Array(nv * 2);
    const rr = new Float32Array(nv);
    xz[0] = q.x;
    xz[1] = q.z;
    rr[0] = 0;
    for (let a = 1; a <= rings; a++) {
      const f = a / rings;
      for (let s = 0; s < segs; s++) {
        const v = 1 + (a - 1) * segs + s;
        const th = (s / segs) * Math.PI * 2;
        xz[v * 2] = q.x + Math.cos(th) * r * f;
        xz[v * 2 + 1] = q.z + Math.sin(th) * r * f;
        rr[v] = f;
      }
    }
    const idx: number[] = [];
    for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
    for (let a = 1; a < rings; a++) {
      const b0 = 1 + (a - 1) * segs;
      const b1 = 1 + a * segs;
      for (let s = 0; s < segs; s++) {
        const s1 = (s + 1) % segs;
        idx.push(b0 + s, b0 + s1, b1 + s, b1 + s, b0 + s1, b1 + s1);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(nv * 3), 3));
    geo.setAttribute('aR', new BufferAttribute(rr, 1));
    geo.setIndex(idx);
    this.discXZ = xz;
    this.disc = new Mesh(geo, this.discMat);
    this.disc.name = 'user-accuracy';
    this.disc.frustumCulled = false;
    this.disc.renderOrder = 2;
    this.group.add(this.disc);
  }

  /** 視点移動の目的地（ラベルがあればピンを出す）。null で消す */
  setFocus(focus: MapFocus | null, sampler: HeightSampler | null): void {
    this.disposePin();
    this.target = null;
    const label = focus?.label?.trim();
    if (!focus || !label || !sampler) return;
    const q = sampler.toLocal(focus.lon, focus.lat);
    // 現在地と同じ地点なら、現在地の目印だけにする
    if (this.user && Math.hypot(this.user.x - q.x, this.user.z - q.z) < 5) return;
    this.target = { x: q.x, z: q.z };
    const text = label.length > 24 ? `${label.slice(0, 23)}…` : label;
    const font = `700 12.5px ${FONT}`;
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = font;
    const tw = Math.ceil(probe.measureText(text).width);
    const boxW = tw + 34;
    const boxH = 26;
    const tail = 7;
    this.pinW = boxW + 4;
    this.pinH = boxH + tail + 4;
    this.pinTex = canvasTexture(this.pinW, this.pinH, (ctx) => {
      const x = 2;
      const y = 2;
      ctx.shadowColor = 'rgba(15,23,42,0.35)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
      ctx.beginPath();
      roundRect(ctx, x, y, boxW, boxH, 7);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.beginPath();
      ctx.moveTo(this.pinW / 2 - 6, y + boxH);
      ctx.lineTo(this.pinW / 2, y + boxH + tail);
      ctx.lineTo(this.pinW / 2 + 6, y + boxH);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      // 地図のピンの図柄
      const cx = x + 13;
      const cy = y + boxH / 2 - 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 5.2, Math.PI * 0.85, Math.PI * 0.15);
      ctx.lineTo(cx, cy + 9);
      ctx.closePath();
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 24, y + boxH / 2 + 0.5);
    });
    this.pinMat = spriteMaterial(this.pinTex);
    this.pin = new Sprite(this.pinMat);
    this.pin.center.set(0.5, 0);
    this.pin.renderOrder = 19;
    this.pin.name = 'focus-pin';
    this.group.add(this.pin);
  }

  get hasPin(): boolean {
    return !!this.pin;
  }

  get hasContent(): boolean {
    return !!this.user || !!this.pin;
  }

  /** 地形・水面の高さに合わせて置き直す（地形・鉛直強調・時刻・現在地が変わったとき） */
  place(sampler: HeightSampler | null, exag: number, surfaceAt: (x: number, z: number) => number | null): void {
    const top = (x: number, z: number): number => {
      if (!sampler || !sampler.inside(x, z)) return 0;
      const g = sampler.heightMesh(x, z);
      const w = surfaceAt(x, z);
      return Math.max(g, w ?? -Infinity);
    };
    if (this.user) {
      const y = top(this.user.x, this.user.z) * exag;
      this.dot.position.set(this.user.x, y + 0.5, this.user.z);
      this.pulse.position.copy(this.dot.position);
      if (this.disc) {
        const pos = this.disc.geometry.getAttribute('position') as BufferAttribute;
        const arr = pos.array as Float32Array;
        const xz = this.discXZ;
        const n = xz.length / 2;
        for (let v = 0; v < n; v++) {
          const x = xz[v * 2];
          const z = xz[v * 2 + 1];
          arr[v * 3] = x;
          arr[v * 3 + 1] = top(x, z) * exag + 0.4;
          arr[v * 3 + 2] = z;
        }
        pos.needsUpdate = true;
      }
    }
    if (this.pin && this.target) this.pin.position.set(this.target.x, top(this.target.x, this.target.z) * exag + 0.5, this.target.z);
  }

  /**
   * 画面上の大きさ・脈動を更新（描画のたびに呼ぶ）。animate が false（「動きを減らす」設定）なら脈動させない
   */
  update(now: number, viewportH: number, p11: number, animate: boolean): void {
    if (this.user) {
      const k = spriteScaleForPx(DOT_PX, viewportH, p11);
      this.dot.scale.set(k, k, 1);
      if (animate) {
        const f = (now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
        const s = spriteScaleForPx(PULSE_PX * (0.3 + 0.9 * f), viewportH, p11);
        this.pulse.scale.set(s, s, 1);
        this.pulseMat.opacity = 0.85 * (1 - f) * (1 - f);
        this.pulse.visible = true;
      } else {
        // 動きを減らす設定などでは、薄い輪を止めて表示
        const s = spriteScaleForPx(PULSE_PX * 0.75, viewportH, p11);
        this.pulse.scale.set(s, s, 1);
        this.pulseMat.opacity = 0.35;
        this.pulse.visible = true;
      }
    }
    if (this.pin) {
      const k = spriteScaleForPx(1, viewportH, p11);
      this.pin.scale.set(this.pinW * k, this.pinH * k, 1);
    }
  }

  /** 画面上のラベル・点の範囲 [x0, y0, x1, y1]（避難場所のアイコンを薄くする判定に使う） */
  screenRects(camera: Camera, w: number, h: number): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    const v = new Vector3();
    const proj = (p: Vector3): { x: number; y: number } | null => {
      v.copy(p).project(camera);
      if (v.z > 1) return null;
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
    };
    if (this.user) {
      const p = proj(this.dot.position);
      if (p) out.push([p.x - DOT_PX / 2, p.y - DOT_PX / 2, p.x + DOT_PX / 2, p.y + DOT_PX / 2]);
    }
    if (this.pin) {
      const p = proj(this.pin.position);
      if (p) out.push([p.x - this.pinW / 2, p.y - this.pinH, p.x + this.pinW / 2, p.y]);
    }
    return out;
  }

  /** 画面座標が現在地の点の上か */
  pickUser(px: number, py: number, camera: Camera, w: number, h: number): UserLocation | null {
    if (!this.user) return null;
    const v = this.dot.position.clone().project(camera);
    if (v.z > 1) return null;
    const sx = (v.x * 0.5 + 0.5) * w;
    const sy = (-v.y * 0.5 + 0.5) * h;
    return Math.hypot(px - sx, py - sy) <= DOT_PX * 0.7 ? this.user.loc : null;
  }

  private disposeDisc(): void {
    if (!this.disc) return;
    this.group.remove(this.disc);
    this.disc.geometry.dispose();
    this.disc = null;
    this.discXZ = new Float32Array(0);
  }

  private disposePin(): void {
    if (!this.pin) return;
    this.group.remove(this.pin);
    this.pinMat?.dispose();
    this.pinTex?.dispose();
    this.pin = null;
    this.pinMat = null;
    this.pinTex = null;
  }

  dispose(): void {
    this.disposeDisc();
    this.disposePin();
    this.discMat.dispose();
    this.dotMat.dispose();
    this.dotTex.dispose();
    this.pulseMat.dispose();
    this.pulseTex.dispose();
  }
}
