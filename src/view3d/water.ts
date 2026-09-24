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
import { triInterp } from './sampler';

const WET = 0.01;

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
  // 白波: 水深に比べて急に水位が上がっている所（砕波の目安）・浸水の先端・波打ち際
  // 遠くでは細かい模様を平均値に近づける（ざらつき防止）
  float nFine = mix(vnoise(vXZ * 0.16 - uTime * 0.45), 0.5, smoothstep(1.0, 3.0, fw));
  float nCoarse = mix(vnoise(vXZ * 0.05 + vec2(uTime * 0.3, -uTime * 0.18)), 0.5, smoothstep(8.0, 24.0, fw));
  float nz = nCoarse * 0.55 + nFine * 0.45;
  float rise = max(vRise, 0.0);
  // 水位が上がっている所はやや明るく、下がっている所はやや暗く（波の山・谷の動きが見えるように）
  col += vec3(0.035, 0.06, 0.055) * clamp(rise * 30.0, 0.0, 1.0) * (1.0 - land);
  col *= 1.0 - 0.14 * clamp(-vRise * 30.0, 0.0, 1.0);
  float relRise = rise / (d + 0.4);
  float foamAmt = smoothstep(0.004, 0.03, relRise) * (1.0 - smoothstep(3.0, 9.0, d));
  foamAmt += land * (1.0 - smoothstep(0.03, 0.45, d)) * smoothstep(0.0005, 0.01, rise) * 0.8;
  foamAmt += (1.0 - land) * (1.0 - smoothstep(0.05, 1.1, d)) * (0.45 + 0.25 * sin(uTime * 1.3 + vXZ.y * 0.12 + vXZ.x * 0.01));
  float foam = smoothstep(0.3, 0.95, foamAmt * (0.35 + 0.9 * nz));
  col = mix(col, uFoam, foam * 0.85);
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
  /** 時刻をはさむ2フレームの全水深 */
  private fa = new Float32Array(0);
  private fb = new Float32Array(0);
  private bracket = '';
  private bracketOutput: SimOutput | null = null;
  private wetW = new Float32Array(0);
  private wetS = new Float32Array(0);
  /** 処理対象のセル（0: 対象外, 1: 周辺, 2: 水に関わる） */
  private mask = new Uint8Array(0);
  private maskFor: SimOutput | 'still' | null = null;
  private maskBracket = '';
  private active = new Int32Array(0);
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
    this.fa = new Float32Array(n);
    this.fb = new Float32Array(n);
    this.wetW = new Float32Array(n);
    this.wetS = new Float32Array(n);
    this.mask = new Uint8Array(n);
    this.maskFor = null;
    this.maskBracket = '';
    this.active = new Int32Array(0);
    this.bracket = '';
    this.bracketOutput = null;
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
   *
   * 計算結果はフレーム間の線形補間（SimOutput の契約）なので、時刻をはさむ2フレームだけを
   * fillDepth で取り出して保持し、毎フレームの補間と上昇速度はここで計算する。
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
    const R = this.prev; // 上昇速度 [m/s]
    if (output) {
      const fi = output.frameInterval > 0 ? output.frameInterval : 1;
      const ready = Math.max(1, output.framesReady());
      const tr = Math.max(0, Math.min(t, output.timeReady()));
      let i0 = Math.floor(tr / fi + 1e-9);
      let i1 = i0 + 1;
      if (i1 > ready - 1) {
        i1 = ready - 1;
        i0 = Math.max(0, i1 - 1);
      }
      const bk = `${runKey}|${i0}|${i1}`;
      if (bk !== this.bracket || output !== this.bracketOutput) {
        output.fillDepth(i0 * fi, this.fa);
        if (i1 !== i0) output.fillDepth(i1 * fi, this.fb);
        else this.fb.set(this.fa);
        this.bracket = bk;
        this.bracketOutput = output;
      }
      const f = i1 > i0 ? Math.min(1, Math.max(0, (tr - i0 * fi) / fi)) : 0;
      const inv = i1 > i0 ? 1 / fi : 0;
      const A = this.fa;
      const B = this.fb;
      for (let k = 0; k < n; k++) {
        const a = A[k];
        const d = B[k] - a;
        D[k] = a + d * f;
        R[k] = d * inv;
      }
    } else {
      for (let k = 0; k < n; k++) {
        D[k] = kind[k] === CELL_SEA ? Math.max(0, tide - z[k]) : 0;
        R[k] = 0;
      }
    }
    // 水に関わりうるセル（海・内水面・これまでに濡れたセルとその周り）だけを処理する
    const list = this.activeCells(output, D);
    const W = this.wetW;
    const S = this.wetS;
    const m = list.length;
    for (let q = 0; q < m; q++) {
      const k = list[q];
      const d = D[k];
      if (d >= WET && d < 1e4) {
        W[k] = 1;
        S[k] = z[k] + d;
      } else {
        W[k] = 0;
        S[k] = 0;
      }
    }
    const a = this.wAttr.array as Float32Array;
    let edgeSum = 0;
    let edgeCnt = 0;
    for (let q = 0; q < m; q++) {
      const k = list[q];
      const o = k * 4;
      const j = (k / nx) | 0;
      const i = k - j * nx;
      if (W[k] > 0) {
        const sk = S[k];
        a[o] = sk;
        a[o + 1] = D[k];
        a[o + 2] = 1;
        a[o + 3] = R[k];
        if ((j === ny - 1 || i === 0 || i === nx - 1) && kind[k] === CELL_SEA) {
          edgeSum += sk;
          edgeCnt += 1;
        }
        continue;
      }
      // 乾いたセル: 8近傍の濡れたセルの平均水位
      let cnt = 0;
      let sum = 0;
      const i0 = i > 0 ? -1 : 0;
      const i1 = i < nx - 1 ? 1 : 0;
      for (let dj = j > 0 ? -1 : 0; dj <= (j < ny - 1 ? 1 : 0); dj++) {
        const rr = k + dj * nx;
        for (let di = i0; di <= i1; di++) {
          const kk = rr + di;
          if (W[kk] > 0) {
            cnt += 1;
            sum += S[kk];
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
      } else if (cnt > 0 && zk * cnt >= sum) {
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
    this.edgeEta = edgeCnt > 0 ? edgeSum / edgeCnt : tide;
    this.wAttr.needsUpdate = true;
    return true;
  }

  /**
   * 処理するセルの一覧。計算結果が変わったら作り直し、同じ計算結果の間は
   * 「今の2フレームで濡れているセル」とその周りを追加していく（一覧は増える一方）。
   * 一覧に入っていないセルは常に乾いていて周りも乾いている（非表示のまま）。
   */
  private activeCells(output: SimOutput | null, D: Float32Array): Int32Array {
    const grid = this.grid!;
    const { nx, ny } = grid.spec;
    const n = nx * ny;
    const key = output ? output : 'still';
    let changed = false;
    if (key !== this.maskFor) {
      this.maskFor = key;
      this.mask.fill(0);
      this.wetW.fill(0);
      this.wetS.fill(0);
      this.maskBracket = '';
      // いったん全セルを非表示に
      const a = this.wAttr!.array as Float32Array;
      const z = grid.z;
      for (let k = 0; k < n; k++) {
        const o = k * 4;
        a[o] = z[k] - 0.6;
        a[o + 1] = 0;
        a[o + 2] = 0;
        a[o + 3] = 0;
      }
      const kind = grid.kind;
      for (let k = 0; k < n; k++) if (kind[k] !== CELL_LAND) this.markAround(k, nx, ny);
      changed = true;
    }
    const mb = output ? this.bracket : 'still';
    if (mb !== this.maskBracket) {
      this.maskBracket = mb;
      const mask = this.mask;
      if (output) {
        const A = this.fa;
        const B = this.fb;
        const arr = output.arrival;
        for (let k = 0; k < n; k++) {
          if (mask[k] === 2) continue;
          if (A[k] >= WET || B[k] >= WET || (arr && Number.isFinite(arr[k]))) {
            this.markAround(k, nx, ny);
            changed = true;
          }
        }
      } else {
        for (let k = 0; k < n; k++) {
          if (mask[k] !== 2 && D[k] >= WET) {
            this.markAround(k, nx, ny);
            changed = true;
          }
        }
      }
    }
    if (changed) {
      let c = 0;
      const mask = this.mask;
      for (let k = 0; k < n; k++) if (mask[k]) c++;
      const list = new Int32Array(c);
      c = 0;
      for (let k = 0; k < n; k++) if (mask[k]) list[c++] = k;
      this.active = list;
    }
    return this.active;
  }

  /** セル k を「中心」(2)、周り8セルを「周辺」(1 以上) として登録 */
  private markAround(k: number, nx: number, ny: number): void {
    const mask = this.mask;
    mask[k] = 2;
    const j = (k / nx) | 0;
    const i = k - j * nx;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= ny) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nx) continue;
        const kk = jj * nx + ii;
        if (mask[kk] === 0) mask[kk] = 1;
      }
    }
  }

  /**
   * 描画している水面の高さ [m, T.P.]（メッシュと同じ補間）。水面が見えていない所は null。
   * 人形を水面に合わせて沈めるのに使う。
   */
  surfaceAt(x: number, zm: number): number | null {
    const grid = this.grid;
    if (!grid || !this.wAttr) return null;
    const { nx, ny, dx } = grid.spec;
    const fx = x / dx + nx / 2 - 0.5;
    const fy = zm / dx + ny / 2 - 0.5;
    const a = this.wAttr.array as Float32Array;
    const alpha = triInterp(a, nx, ny, fx, fy, 4, 2);
    if (alpha < 0.5) return null;
    return triInterp(a, nx, ny, fx, fy, 4, 0);
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
    this.bracketOutput = null;
    this.maskFor = null;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
