/**
 * 人物の立体モデル（実寸 [m]、足元が原点、前方 = -z）。
 * 部品（カプセル・球・円柱・トーラス）を頂点色付きで1つのジオメトリにまとめる。
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PersonKind } from '../core/types';

const SKIN = '#efc9a3';
const HAIR = '#3b2f2a';
const GREY_HAIR = '#d4d4d4';
const PANTS = '#334155';
const SHOES = '#1f2937';

interface Part {
  geo: BufferGeometry;
  color: string;
  pos: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
}

function bake(parts: Part[]): BufferGeometry {
  const list: BufferGeometry[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  const c = new Color();
  for (const p of parts) {
    const g = p.geo;
    g.deleteAttribute('uv');
    q.setFromEuler(new Euler(...(p.rot ?? [0, 0, 0])));
    m.compose(new Vector3(...p.pos), q, new Vector3(...(p.scale ?? [1, 1, 1])));
    g.applyMatrix4(m);
    c.set(p.color);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    list.push(g);
  }
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  if (!merged) throw new Error('figure merge failed');
  merged.computeBoundingSphere();
  return merged;
}

const cap = (r: number, len: number) => new CapsuleGeometry(r, Math.max(0.001, len - 2 * r), 4, 10, 1);
const sphere = (r: number) => new SphereGeometry(r, 16, 12);

/** 立った人（全身の高さ h） */
function standing(h: number, shirt: string, opts: { lean?: number; stride?: number; hair?: string; headScale?: number } = {}): Part[] {
  const s = h / 1.7;
  const lean = opts.lean ?? 0;
  const stride = opts.stride ?? 0;
  const hs = opts.headScale ?? 1;
  const hip = 0.84 * s;
  const legLen = 0.86 * s;
  const torsoLen = 0.62 * s;
  const headR = 0.115 * s * hs;
  // 胴体の傾き（前傾 = -z 方向へ）: x 軸回りに負の回転
  const torsoC = new Vector3(0, torsoLen / 2, 0).applyEuler(new Euler(-lean, 0, 0)).add(new Vector3(0, hip, 0));
  const neck = new Vector3(0, torsoLen + 0.02 * s, 0).applyEuler(new Euler(-lean, 0, 0)).add(new Vector3(0, hip, 0));
  const headC = neck.clone().add(new Vector3(0, headR * 0.95, 0).applyEuler(new Euler(-lean, 0, 0)));
  const shoulder = new Vector3(0, torsoLen * 0.82, 0).applyEuler(new Euler(-lean, 0, 0)).add(new Vector3(0, hip, 0));
  const armLen = 0.6 * s;
  const parts: Part[] = [];
  // 脚（前後に開く）
  for (const side of [-1, 1]) {
    const a = stride * side;
    const c = new Vector3(0, -legLen / 2, 0).applyEuler(new Euler(a, 0, 0)).add(new Vector3(side * 0.09 * s, hip, 0));
    parts.push({ geo: cap(0.072 * s, legLen), color: PANTS, pos: [c.x, c.y, c.z], rot: [a, 0, 0] });
    const foot = new Vector3(0, -legLen + 0.03 * s, 0).applyEuler(new Euler(a, 0, 0)).add(new Vector3(side * 0.09 * s, hip, 0));
    parts.push({ geo: new BoxGeometry(0.1 * s, 0.06 * s, 0.2 * s), color: SHOES, pos: [foot.x, Math.max(0.03 * s, foot.y), foot.z - 0.04 * s] });
  }
  parts.push({ geo: cap(0.17 * s, torsoLen + 0.1 * s), color: shirt, pos: [torsoC.x, torsoC.y, torsoC.z], rot: [-lean, 0, 0], scale: [1, 1, 0.72] });
  // 腕（走る人は前後に振る）
  for (const side of [-1, 1]) {
    const a = -stride * side * 1.2;
    const c = new Vector3(0, -armLen / 2, 0).applyEuler(new Euler(a - lean * 0.3, 0, side * 0.1)).add(shoulder).add(new Vector3(side * 0.23 * s, 0, 0));
    parts.push({ geo: cap(0.052 * s, armLen), color: shirt, pos: [c.x, c.y, c.z], rot: [a - lean * 0.3, 0, side * 0.1] });
  }
  parts.push({ geo: sphere(headR), color: SKIN, pos: [headC.x, headC.y, headC.z] });
  // 髪（頭の上半分）
  parts.push({
    geo: new SphereGeometry(headR * 1.05, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
    color: opts.hair ?? HAIR,
    pos: [headC.x, headC.y + headR * 0.08, headC.z + headR * 0.05],
    rot: [-lean + 0.25, 0, 0],
  });
  return parts;
}

function wheelchair(shirt: string): Part[] {
  const parts: Part[] = [];
  const seatY = 0.52;
  // 車いす本体
  for (const side of [-1, 1]) {
    parts.push({ geo: new TorusGeometry(0.3, 0.028, 8, 28), color: '#111827', pos: [side * 0.3, 0.31, 0.05], rot: [0, Math.PI / 2, 0] });
    parts.push({ geo: new TorusGeometry(0.075, 0.02, 6, 14), color: '#111827', pos: [side * 0.22, 0.075, -0.36], rot: [0, Math.PI / 2, 0] });
    parts.push({ geo: new CylinderGeometry(0.015, 0.015, 0.5, 6), color: '#94a3b8', pos: [side * 0.24, seatY + 0.25, 0.22] });
  }
  parts.push({ geo: new BoxGeometry(0.46, 0.05, 0.44), color: '#475569', pos: [0, seatY, 0.02] });
  parts.push({ geo: new BoxGeometry(0.46, 0.42, 0.04), color: '#475569', pos: [0, seatY + 0.26, 0.24], rot: [-0.12, 0, 0] });
  parts.push({ geo: new BoxGeometry(0.4, 0.03, 0.14), color: '#64748b', pos: [0, 0.12, -0.4] });
  // 座った人
  for (const side of [-1, 1]) {
    parts.push({ geo: cap(0.07, 0.44), color: PANTS, pos: [side * 0.1, seatY + 0.08, -0.16], rot: [Math.PI / 2, 0, 0] });
    parts.push({ geo: cap(0.062, 0.42), color: PANTS, pos: [side * 0.1, seatY - 0.16, -0.38] });
    parts.push({ geo: cap(0.05, 0.42), color: shirt, pos: [side * 0.22, seatY + 0.36, -0.02], rot: [0.5, 0, side * 0.08] });
  }
  parts.push({ geo: cap(0.17, 0.58), color: shirt, pos: [0, seatY + 0.36, 0.08], scale: [1, 1, 0.72] });
  parts.push({ geo: sphere(0.112), color: SKIN, pos: [0, seatY + 0.77, 0.06] });
  parts.push({ geo: new SphereGeometry(0.118, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), color: HAIR, pos: [0, seatY + 0.78, 0.07], rot: [0.25, 0, 0] });
  return parts;
}

function elderly(shirt: string): Part[] {
  const parts = standing(1.58, shirt, { lean: 0.22, hair: GREY_HAIR });
  // 杖
  parts.push({ geo: new CylinderGeometry(0.014, 0.014, 0.86, 6), color: '#7c4a1e', pos: [0.3, 0.43, -0.22], rot: [0.12, 0, 0.06] });
  parts.push({ geo: new TorusGeometry(0.045, 0.013, 6, 10, Math.PI), color: '#7c4a1e', pos: [0.3, 0.86, -0.24], rot: [0, Math.PI / 2, 0] });
  return parts;
}

/** 種別ごとのジオメトリ（全身の高さも返す） */
export function createFigureGeometry(kind: PersonKind, shirt: string): { geometry: BufferGeometry; height: number } {
  switch (kind) {
    case 'child':
      return { geometry: bake(standing(1.15, shirt, { headScale: 1.25 })), height: 1.15 };
    case 'elderly':
      return { geometry: bake(elderly(shirt)), height: 1.55 };
    case 'wheelchair':
      return { geometry: bake(wheelchair(shirt)), height: 1.4 };
    case 'runner':
      return { geometry: bake(standing(1.7, shirt, { lean: 0.32, stride: 0.45 })), height: 1.68 };
    case 'adult':
    default:
      return { geometry: bake(standing(1.7, shirt)), height: 1.7 };
  }
}
