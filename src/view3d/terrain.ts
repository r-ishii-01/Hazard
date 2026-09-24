/**
 * 地形メッシュ（セル中心に1頂点、海底の負の標高も含む）。
 *
 * - 位置は鉛直強調なし [m]。鉛直強調はワールドグループの scale.y で掛ける
 * - 色: 地図タイル（地理院タイル）を陸に貼る。タイルが無い部分は段彩（標高別の色）＋陰影で代替
 *   海・河川のセルは常に海底の色（砂→暗色）。引き波で海底が露出したとき正しく見えるように
 * - 重ね表示: 色別標高図・公式ハザードマップ（タイル）、最大浸水深・到達時間（頂点色）
 * - 外周には「断面」の側壁（スカート）を付けて、データ範囲の端を明示する
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshLambertMaterial,
  RGBAFormat,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  type Texture,
} from 'three';
import { CELL_INLAND_WATER, CELL_SEA, type TerrainGrid } from '../core/types';
import { LIGHT_UNIFORMS } from './environment';

const TERRAIN_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aColor;   // rgb = 段彩（リニア）, a = 陸なら 1
attribute vec4 aOverlay; // 最大浸水深・到達時間などの頂点色（sRGB, a=不透明度）
uniform vec2 uSize;
uniform float uExag;
varying vec3 vColor;
varying float vLand;
varying vec4 vOverlay;
varying vec2 vUv;
varying vec3 vN;
void main() {
  vUv = position.xz / uSize + 0.5;
  vColor = aColor.rgb;
  vLand = aColor.a;
  vOverlay = aOverlay;
  // scale(1, e, 1) の逆転置で法線を変換
  vN = normalize(vec3(normal.x, normal.y / uExag, normal.z));
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const TERRAIN_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uMap;
uniform float uMapOn;
uniform sampler2D uRelief;
uniform float uReliefOn;
uniform sampler2D uHazard;
uniform float uHazardOn;
uniform float uOverlayOn;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
varying vec3 vColor;
varying float vLand;
varying vec4 vOverlay;
varying vec2 vUv;
varying vec3 vN;
void main() {
  vec3 base = vColor;
  float land = smoothstep(0.35, 0.65, vLand);
  if (uMapOn > 0.0) {
    vec4 t = texture2D(uMap, vUv);
    base = mix(base, t.rgb, uMapOn * t.a * land);
  }
  if (uReliefOn > 0.0) {
    vec4 r = texture2D(uRelief, vUv);
    base = mix(base, r.rgb, uReliefOn * r.a * land);
  }
  if (uOverlayOn > 0.0) {
    base = mix(base, pow(vOverlay.rgb, vec3(2.2)), vOverlay.a * uOverlayOn);
  }
  if (uHazardOn > 0.0) {
    vec4 h = texture2D(uHazard, vUv);
    base = mix(base, h.rgb, uHazardOn * h.a);
  }
  vec3 n = normalize(vN);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 hemi = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 col = base * (hemi + uSunColor * ndl * 0.78);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** 段彩（陸: 標高 [m] → 色） */
const LAND_RAMP: [number, string][] = [
  [-2, '#9dbb86'],
  [0, '#b7d29a'],
  [3, '#a8ca86'],
  [6, '#94bd70'],
  [10, '#80ad5e'],
  [18, '#7b9e56'],
  [30, '#94985d'],
  [45, '#a48c62'],
  [70, '#a9906f'],
  [120, '#b8a894'],
];
/** 海底（水深 [m] → 色）: 浅い砂地 → 深い暗色 */
const SEA_RAMP: [number, string][] = [
  [0, '#c9bd98'],
  [2, '#b3a57f'],
  [6, '#978a68'],
  [12, '#786f57'],
  [25, '#585346'],
  [50, '#3d3a33'],
];
const SAND = new Color('#e3d4ab');
const POND = new Color('#5b8aa6');

function buildRamp(stops: [number, string][]): { v: number[]; c: Color[] } {
  return { v: stops.map((s) => s[0]), c: stops.map((s) => new Color(s[1])) };
}
const LAND = buildRamp(LAND_RAMP);
const SEA = buildRamp(SEA_RAMP);

function rampColor(r: { v: number[]; c: Color[] }, x: number, out: Color): Color {
  const v = r.v;
  if (x <= v[0]) return out.copy(r.c[0]);
  for (let i = 1; i < v.length; i++) {
    if (x <= v[i]) return out.copy(r.c[i - 1]).lerp(r.c[i], (x - v[i - 1]) / (v[i] - v[i - 1]));
  }
  return out.copy(r.c[r.c.length - 1]);
}

function emptyTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

export class TerrainLayer {
  readonly group = new Group();
  readonly material: ShaderMaterial;
  private readonly skirtMaterial: MeshLambertMaterial;
  private readonly empty = emptyTexture();
  private mesh: Mesh | null = null;
  private skirt: Mesh | null = null;
  /** 三角形の並び（水面メッシュと共有して、海岸線を正確に一致させる） */
  index: BufferAttribute | null = null;
  private overlayAttr: BufferAttribute | null = null;

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uMap: { value: null },
          uMapOn: { value: 0 },
          uRelief: { value: null },
          uReliefOn: { value: 0 },
          uHazard: { value: null },
          uHazardOn: { value: 0 },
          uOverlayOn: { value: 0 },
          uSize: { value: new Vector2(1, 1) },
          uExag: { value: 2 },
        },
      ]),
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      fog: true,
      // 水面と同じ高さのときに水面が勝つよう、地形を少し奥へ
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 2,
    });
    const u = this.material.uniforms;
    u.uMap.value = this.empty;
    u.uRelief.value = this.empty;
    u.uHazard.value = this.empty;
    Object.assign(u, {
      uSunDir: LIGHT_UNIFORMS.uSunDir,
      uSunColor: LIGHT_UNIFORMS.uSunColor,
      uSkyColor: LIGHT_UNIFORMS.uSkyColor,
      uGroundColor: LIGHT_UNIFORMS.uGroundColor,
    });
    this.skirtMaterial = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  }

  setGrid(grid: TerrainGrid | null): void {
    this.clear();
    if (!grid) return;
    const { nx, ny, dx } = grid.spec;
    const n = nx * ny;
    const z = grid.z;
    const kind = grid.kind;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const col = new Float32Array(n * 4);
    const ov = new Uint8Array(n * 4);

    // 海からの距離（セル数、上限 4）: 砂浜の表現用
    const seaDist = new Uint8Array(n).fill(255);
    for (let k = 0; k < n; k++) if (kind[k] === CELL_SEA) seaDist[k] = 0;
    for (let pass = 0; pass < 4; pass++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          if (seaDist[k] <= pass) continue;
          if (
            (i > 0 && seaDist[k - 1] === pass) ||
            (i < nx - 1 && seaDist[k + 1] === pass) ||
            (j > 0 && seaDist[k - nx] === pass) ||
            (j < ny - 1 && seaDist[k + nx] === pass)
          )
            seaDist[k] = pass + 1;
        }
      }
    }

    const c = new Color();
    // 陰影（北西からの光・強めの鉛直強調）で段彩に立体感を足す
    const lx = -0.5;
    const ly = 0.7071;
    const lz = -0.5;
    for (let j = 0; j < ny; j++) {
      const zz = (j + 0.5 - ny / 2) * dx;
      const jm = Math.max(0, j - 1);
      const jp = Math.min(ny - 1, j + 1);
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const im = Math.max(0, i - 1);
        const ip = Math.min(nx - 1, i + 1);
        pos[k * 3] = (i + 0.5 - nx / 2) * dx;
        pos[k * 3 + 1] = z[k];
        pos[k * 3 + 2] = zz;
        const dzdx = (z[j * nx + ip] - z[j * nx + im]) / ((ip - im) * dx);
        const dzdz = (z[jp * nx + i] - z[jm * nx + i]) / ((jp - jm) * dx);
        let ax = -dzdx;
        let az = -dzdz;
        let len = Math.hypot(ax, 1, az);
        nor[k * 3] = ax / len;
        nor[k * 3 + 1] = 1 / len;
        nor[k * 3 + 2] = az / len;

        const kd = kind[k];
        let land = 1;
        if (kd === CELL_SEA) {
          rampColor(SEA, -z[k], c);
          land = 0;
        } else if (kd === CELL_INLAND_WATER) {
          c.copy(POND);
        } else {
          rampColor(LAND, z[k], c);
          const sd = seaDist[k];
          if (sd <= 4 && z[k] < 7) c.lerp(SAND, (1 - (sd - 1) / 4) * 0.85 * (1 - Math.max(0, z[k] - 4) / 3));
        }
        // 陰影（鉛直 6 倍相当）
        ax = -dzdx * 6;
        az = -dzdz * 6;
        len = Math.hypot(ax, 1, az);
        const hs = (ax * lx + ly + az * lz) / len;
        const f = Math.min(1.18, Math.max(0.55, 0.62 + 0.55 * hs));
        col[k * 4] = c.r * f;
        col[k * 4 + 1] = c.g * f;
        col[k * 4 + 2] = c.b * f;
        col[k * 4 + 3] = land;
      }
    }

    // 三角形（対角線の向きをそろえる。水面メッシュと共有）
    const quads = (nx - 1) * (ny - 1);
    const idx = n > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    let p = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const d = a + nx;
        const e = d + 1;
        // 上から見て反時計回り（法線 +y）
        idx[p++] = a;
        idx[p++] = d;
        idx[p++] = b;
        idx[p++] = b;
        idx[p++] = d;
        idx[p++] = e;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('normal', new BufferAttribute(nor, 3));
    geo.setAttribute('aColor', new BufferAttribute(col, 4));
    this.overlayAttr = new BufferAttribute(ov, 4, true);
    geo.setAttribute('aOverlay', this.overlayAttr);
    this.index = new BufferAttribute(idx, 1);
    geo.setIndex(this.index);
    geo.computeBoundingSphere();
    this.mesh = new Mesh(geo, this.material);
    this.mesh.name = 'terrain';
    this.material.uniforms.uSize.value.set(nx * dx, ny * dx);
    this.group.add(this.mesh);

    this.skirt = this.buildSkirt(grid);
    this.group.add(this.skirt);
  }

  /** 外周の側壁（データ範囲の断面） */
  private buildSkirt(grid: TerrainGrid): Mesh {
    const { nx, ny, dx } = grid.spec;
    const z = grid.z;
    let zmin = 0;
    for (let k = 0; k < z.length; k++) if (z[k] < zmin) zmin = z[k];
    const base = zmin - 25;
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const top = new Color('#8a6f4f');
    const bottom = new Color('#3f3326');
    const edge = (pts: [number, number][], nxv: number, nzv: number) => {
      const start = positions.length / 3;
      for (const [i, j] of pts) {
        const x = (i + 0.5 - nx / 2) * dx;
        const zz = (j + 0.5 - ny / 2) * dx;
        const h = z[j * nx + i];
        positions.push(x, h, zz, x, base, zz);
        normals.push(nxv, 0, nzv, nxv, 0, nzv);
        colors.push(top.r, top.g, top.b, bottom.r, bottom.g, bottom.b);
      }
      for (let q = 0; q < pts.length - 1; q++) {
        const a = start + q * 2;
        indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    };
    const north: [number, number][] = [];
    const south: [number, number][] = [];
    for (let i = 0; i < nx; i++) {
      north.push([i, 0]);
      south.push([i, ny - 1]);
    }
    const west: [number, number][] = [];
    const east: [number, number][] = [];
    for (let j = 0; j < ny; j++) {
      west.push([0, j]);
      east.push([nx - 1, j]);
    }
    edge(north, 0, -1);
    edge(south, 0, 1);
    edge(west, -1, 0);
    edge(east, 1, 0);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    const m = new Mesh(geo, this.skirtMaterial);
    m.name = 'terrain-skirt';
    return m;
  }

  setExaggeration(e: number): void {
    this.material.uniforms.uExag.value = e;
  }

  setMap(tex: Texture | null): void {
    const u = this.material.uniforms;
    u.uMap.value = tex ?? this.empty;
    u.uMapOn.value = tex ? 1 : 0;
  }

  setRelief(tex: Texture | null, opacity: number): void {
    const u = this.material.uniforms;
    u.uRelief.value = tex ?? this.empty;
    u.uReliefOn.value = tex ? opacity : 0;
  }

  setHazard(tex: Texture | null, opacity: number): void {
    const u = this.material.uniforms;
    u.uHazard.value = tex ?? this.empty;
    u.uHazardOn.value = tex ? opacity : 0;
  }

  /** 頂点ごとの重ね色（sRGB, RGBA 0〜255, 長さ nx*ny*4）。null で非表示 */
  setOverlay(rgba: Uint8Array | Uint8ClampedArray | null): void {
    const u = this.material.uniforms;
    if (!rgba || !this.overlayAttr) {
      u.uOverlayOn.value = 0;
      return;
    }
    (this.overlayAttr.array as Uint8Array).set(rgba);
    this.overlayAttr.needsUpdate = true;
    u.uOverlayOn.value = 0.85;
  }

  private clear(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this.skirt) {
      this.group.remove(this.skirt);
      this.skirt.geometry.dispose();
      this.skirt = null;
    }
    this.index = null;
    this.overlayAttr = null;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
    this.skirtMaterial.dispose();
    this.empty.dispose();
  }
}
