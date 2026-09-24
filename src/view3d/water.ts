/**
 * 水面メッシュ（地形と同じ解像度・同じ三角形分割）。
 *
 * 頂点属性 aW = (水位 η [m, T.P.], 全水深 D [m], 表示 α, 水深の上昇速度 [m/s])。
 * - 濡れたセル（D ≥ 0.01 m）は η に置く
 * - 乾いたセルでも、隣に濡れたセルがあり地盤が隣の水位より高ければ、水面を平らに延長する
 *   （地形と交わる線がちょうど水際になり、海岸線がくっきり正しく出る）
 * - それ以外の乾いたセルは地面より下に沈めて α=0（見えない）
 * シミュレーション前は、海のセルに潮位の静かな海を張る。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { CELL_INLAND_WATER, CELL_LAND, CELL_SEA, type SimOutput, type TerrainGrid } from '../core/types';
import { LIGHT_UNIFORMS, WATER_COMMON } from './environment';

const WET = 0.01;
/** 上昇速度を求める時間差 [秒]（シミュレーション時間） */
const RISE_DT = 12;

const WATER_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aW;
attribute float aLand;
uniform float uTime;
varying float vDepth;
varying float vAlpha;
varying float vRise;
varying float vLand;
varying vec3 vWorld;
varying vec2 vXZ;
void main() {
  vec3 p = vec3(position.x, aW.x, position.z);
  // 沖の静かなうねり（数十 cm、鉛直強調前）
  float deep = smoothstep(2.0, 12.0, aW.y) * (1.0 - aLand) * step(0.5, aW.z);
  float sw = sin(p.x * 0.011 + p.z * 0.019 - uTime * 0.8) * 0.16 + sin(-p.x * 0.017 + p.z * 0.029 - uTime * 1.15) * 0.09;
  p.y += sw * deep;
  vDepth = aW.y;
  vAlpha = aW.z;
  vRise = aW.w;
  vLand = aLand;
  vXZ = p.xz;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const WATER_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uMudShallow;
uniform vec3 uMudDeep;
uniform vec3 uFoam;
uniform float uFoamGain;
uniform float uRipple;
varying float vDepth;
varying float vAlpha;
varying float vRise;
varying float vLand;
varying vec3 vWorld;
varying vec2 vXZ;

${WATER_COMMON}
void main() {
  float a0 = smoothstep(0.02, 0.6, vAlpha);
  if (a0 < 0.01) discard;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float land = smoothstep(0.2, 0.8, vLand);
  // 画素より細かい波は弱める（ちらつき・モアレ防止）
  float fw = length(fwidth(vXZ));
  vec2 g = ripple(vXZ, uTime, fw) * uRipple * mix(1.0, 0.55, land) * smoothstep(0.03, 0.35, V.y);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  // 水の色: 海は浅い青緑 → 深い藍色、陸の浸水は濁った青茶色
  float d = max(vDepth, 0.0);
  vec3 sea = mix(uShallow, uDeep, smoothstep(0.3, 14.0, d));
  vec3 mud = mix(uMudShallow, uMudDeep, smoothstep(0.1, 3.0, d));
  // 濁流の模様（流れているように見せる）
  float turb = vnoise(vXZ * 0.045 + vec2(uTime * 0.12, uTime * 0.05)) * 0.6 + vnoise(vXZ * 0.13 - vec2(uTime * 0.2, 0.0)) * 0.4;
  mud *= 0.82 + 0.36 * turb;
  vec3 base = mix(sea, mud, land);
  float fres;
  vec3 col = shadeWater(base, n, V, uSunDir, uSunColor, uHorizon, uZenith, 0.8, fres);
  // 白波: 浅く急に水位が上がっているところ・浸水の先端・波打ち際
  float nz = vnoise(vXZ * 0.09 + vec2(uTime * 0.35, -uTime * 0.2)) * 0.6 + vnoise(vXZ * 0.31 - uTime * 0.5) * 0.4;
  float rise = max(vRise, 0.0);
  float foamAmt = clamp(rise * uFoamGain, 0.0, 1.0) * (1.0 - smoothstep(1.0, 7.0, d));
  foamAmt += land * (1.0 - smoothstep(0.03, 0.45, d)) * smoothstep(0.0005, 0.01, rise) * 0.9;
  foamAmt += (1.0 - land) * (1.0 - smoothstep(0.05, 1.1, d)) * (0.45 + 0.25 * sin(uTime * 1.3 + vXZ.y * 0.12 + vXZ.x * 0.01));
  float foam = smoothstep(0.35, 0.8, foamAmt * (0.45 + 0.75 * nz));
  col = mix(col, uFoam, foam);
  // 透明度: 浅い海は海底が透ける。濁った浸水はほぼ不透明
  float alpha = mix(mix(0.45, 1.0, smoothstep(0.2, 10.0, d)), mix(0.84, 0.96, smoothstep(0.05, 1.0, d)), land);
  alpha = mix(alpha, 1.0, fres * 0.5);
  alpha = max(alpha, foam * 0.95);
  gl_FragColor = vec4(col, alpha * a0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class WaterLayer {
  readonly material: ShaderMaterial;
  mesh: Mesh | null = null;
  private grid: TerrainGrid | null = null;
  private wAttr: BufferAttribute | null = null;
  private depth = new Float32Array(0);
  private prev = new Float32Array(0);
  private surf = new Float32Array(0);
  private wet = new Uint8Array(0);
  /** 計算範囲の境界（海側）の平均水位 [m, T.P.]（範囲外の海の高さに使う） */
  edgeEta = 0;
  /** 最後に描いた状態（同じなら再計算しない） */
  private lastKey = '';

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uShallow: { value: new Color('#3b8f8f') },
          uDeep: { value: new Color('#123f5e') },
          uMudShallow: { value: new Color('#7a6949') },
          uMudDeep: { value: new Color('#34403f') },
          uFoam: { value: new Color('#f4f7f6') },
          uFoamGain: { value: 18 },
          uRipple: { value: 0.2 },
        },
      ]),
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    Object.assign(this.material.uniforms, {
      uSunDir: LIGHT_UNIFORMS.uSunDir,
      uSunColor: LIGHT_UNIFORMS.uSunColor,
      uHorizon: LIGHT_UNIFORMS.uHorizon,
      uZenith: LIGHT_UNIFORMS.uZenith,
      uTime: LIGHT_UNIFORMS.uTime,
    });
  }

  /** 地形が変わったら作り直す。index は地形メッシュと共有 */
  setGrid(grid: TerrainGrid | null, index: BufferAttribute | null): void {
    this.clear();
    this.grid = grid;
    if (!grid || !index) return;
    const { nx, ny, dx } = grid.spec;
    const n = nx * ny;
    const pos = new Float32Array(n * 3);
    const land = new Float32Array(n);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[k * 3] = (i + 0.5 - nx / 2) * dx;
        pos[k * 3 + 2] = (j + 0.5 - ny / 2) * dx;
        land[k] = grid.kind[k] === CELL_LAND ? 1 : 0;
      }
    }
    this.depth = new Float32Array(n);
    this.prev = new Float32Array(n);
    this.surf = new Float32Array(n);
    this.wet = new Uint8Array(n);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    this.wAttr = new BufferAttribute(new Float32Array(n * 4), 4);
    this.wAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aW', this.wAttr);
    geo.setAttribute('aLand', new BufferAttribute(land, 1));
    geo.setIndex(index);
    this.mesh = new Mesh(geo, this.material);
    this.mesh.name = 'water';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.lastKey = '';
  }

  /**
   * 水面を更新。output が null なら潮位 tide の静かな海。
   * 戻り値: 実際に更新したら true
   */
  update(output: SimOutput | null, t: number, tide: number, runKey: string): boolean {
    const grid = this.grid;
    if (!grid || !this.wAttr) return false;
    const key = output ? `${runKey}|${t.toFixed(3)}|${output.framesReady()}` : `still|${tide}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    const { nx, ny } = grid.spec;
    const n = nx * ny;
    const z = grid.z;
    const kind = grid.kind;
    const D = this.depth;
    const P = this.prev;
    let dt = 0;
    if (output) {
      const tr = Math.min(t, output.timeReady());
      output.fillDepth(tr, D);
      const t0 = Math.max(0, tr - RISE_DT);
      dt = tr - t0;
      if (dt > 0) output.fillDepth(t0, P);
    } else {
      for (let k = 0; k < n; k++) D[k] = kind[k] === CELL_SEA ? Math.max(0, tide - z[k]) : 0;
    }
    const surf = this.surf;
    const wet = this.wet;
    for (let k = 0; k < n; k++) {
      const d = D[k];
      if (d >= WET && Number.isFinite(d)) {
        wet[k] = 1;
        surf[k] = z[k] + d;
      } else {
        wet[k] = 0;
      }
    }
    const a = this.wAttr.array as Float32Array;
    let edgeSum = 0;
    let edgeCnt = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const o = k * 4;
        if (wet[k]) {
          a[o] = surf[k];
          a[o + 1] = D[k];
          a[o + 2] = 1;
          a[o + 3] = dt > 0 ? (D[k] - P[k]) / dt : 0;
          if ((j === ny - 1 || i === 0 || i === nx - 1) && kind[k] === CELL_SEA) {
            edgeSum += surf[k];
            edgeCnt += 1;
          }
          continue;
        }
        // 乾いたセル: 隣接する濡れたセルの水位を調べる（8近傍）
        let sum = 0;
        let cnt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if ((di === 0 && dj === 0) || ii < 0 || ii >= nx) continue;
            const kk = jj * nx + ii;
            if (wet[kk]) {
              sum += surf[kk];
              cnt += 1;
            }
          }
        }
        const zk = z[k];
        if (kind[k] === CELL_INLAND_WATER) {
          // 池などの内水面（計算上は陸）: 静かな水面を表示
          a[o] = zk + 0.05;
          a[o + 1] = 0.8;
          a[o + 2] = 1;
          a[o + 3] = 0;
        } else if (cnt > 0 && zk >= sum / cnt) {
          // 水面を平らに延長（地形の下に隠れ、交線が水際になる）
          a[o] = sum / cnt;
          a[o + 1] = 0;
          a[o + 2] = 1;
          a[o + 3] = 0;
        } else {
          a[o] = zk - (cnt > 0 ? 0.05 : 0.6);
          a[o + 1] = 0;
          a[o + 2] = 0;
          a[o + 3] = 0;
        }
      }
    }
    this.edgeEta = edgeCnt > 0 ? edgeSum / edgeCnt : tide;
    this.wAttr.needsUpdate = true;
    return true;
  }

  /** 強制的に次回更新させる */
  invalidate(): void {
    this.lastKey = '';
  }

  private clear(): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      // index は地形と共有しているので、ジオメトリの破棄で一緒に解放されても地形側は再転送される
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.wAttr = null;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
