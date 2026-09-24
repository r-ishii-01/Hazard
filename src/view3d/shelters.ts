/**
 * 避難場所のピン（細い柱＋頭のアイコン）。柱の高さは「見やすさ倍率」に比例。
 */
import {
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Camera,
  type CanvasTexture,
} from 'three';
import type { Shelter, ShelterKind } from '../core/types';
import { SHELTER_LABELS, createShelterIcon, spriteScaleForPx } from './labels';
import type { HeightSampler } from './sampler';

const ICON_PX = 26;

export class ShelterLayer {
  readonly group = new Group();
  private readonly poleGeo = new CylinderGeometry(1, 1, 1, 8, 1).translate(0, 0.5, 0);
  private readonly poleMat = new MeshLambertMaterial({ color: '#f8fafc' });
  private poles: InstancedMesh | null = null;
  private readonly icons = new Map<ShelterKind, { tex: CanvasTexture; mat: SpriteMaterial }>();
  private sprites: Sprite[] = [];
  private shelters: Shelter[] = [];
  private local: { x: number; z: number; g: number }[] = [];
  private readonly m = new Matrix4();

  constructor() {
    this.group.name = 'shelters';
  }

  private iconFor(kind: ShelterKind): SpriteMaterial {
    let ic = this.icons.get(kind);
    if (!ic) {
      const tex = createShelterIcon(kind);
      const mat = new SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });
      ic = { tex, mat };
      this.icons.set(kind, ic);
    }
    return ic.mat;
  }

  set(shelters: Shelter[], sampler: HeightSampler | null): void {
    this.clear();
    if (!sampler) return;
    this.shelters = shelters.filter((s) => {
      const q = sampler.toLocal(s.lon, s.lat);
      return sampler.inside(q.x, q.z);
    });
    if (this.shelters.length === 0) return;
    this.local = this.shelters.map((s) => {
      const q = sampler.toLocal(s.lon, s.lat);
      return { x: q.x, z: q.z, g: sampler.height(q.x, q.z) };
    });
    this.poles = new InstancedMesh(this.poleGeo, this.poleMat, this.shelters.length);
    this.poles.frustumCulled = false;
    this.group.add(this.poles);
    for (const s of this.shelters) {
      const sp = new Sprite(this.iconFor(s.kind));
      sp.center.set(0.5, 0);
      sp.renderOrder = 15;
      this.sprites.push(sp);
      this.group.add(sp);
    }
  }

  update(exag: number, scale: number, viewportH: number, p11: number): void {
    if (!this.poles) return;
    const h = 2.3 * scale;
    const r = Math.max(0.3, 0.045 * scale);
    const k = spriteScaleForPx(ICON_PX, viewportH, p11);
    for (let i = 0; i < this.local.length; i++) {
      const L = this.local[i];
      const base = L.g * exag;
      // 避難可能な高さ（T.P.）が分かる場合は柱をその高さまで伸ばす
      const safe = this.shelters[i].safeHeightTP;
      const top = Math.max(base + h, safe != null ? safe * exag : -Infinity);
      this.m.makeScale(r, top - base, r).setPosition(L.x, base, L.z);
      this.poles.setMatrixAt(i, this.m);
      const sp = this.sprites[i];
      sp.position.set(L.x, top, L.z);
      sp.scale.set(k, k, 1);
    }
    this.poles.instanceMatrix.needsUpdate = true;
  }

  /** 画面座標に近い避難場所 */
  pick(px: number, py: number, camera: Camera, w: number, h: number): Shelter | null {
    const v = new Vector3();
    let best: Shelter | null = null;
    let bestD = 16;
    for (let i = 0; i < this.sprites.length; i++) {
      v.copy(this.sprites[i].position).project(camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h - ICON_PX / 2;
      const d = Math.hypot(px - sx, py - sy);
      if (d < bestD) {
        bestD = d;
        best = this.shelters[i];
      }
    }
    return best;
  }

  static describe(s: Shelter): string {
    const lines = [`${s.name}（${SHELTER_LABELS[s.kind] ?? s.kind}）`];
    if (s.safeHeightTP != null) lines.push(`避難可能な高さ: T.P. ${s.safeHeightTP.toFixed(1)} m`);
    if (s.address) lines.push(s.address);
    lines.push(`出典: ${s.source}`);
    return lines.join('\n');
  }

  private clear(): void {
    if (this.poles) {
      this.group.remove(this.poles);
      this.poles.dispose();
      this.poles = null;
    }
    for (const sp of this.sprites) this.group.remove(sp);
    this.sprites = [];
    this.shelters = [];
    this.local = [];
  }

  dispose(): void {
    this.clear();
    this.poleGeo.dispose();
    this.poleMat.dispose();
    for (const ic of this.icons.values()) {
      ic.tex.dispose();
      ic.mat.dispose();
    }
    this.icons.clear();
  }
}
