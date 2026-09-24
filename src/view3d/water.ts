/**
 * 水面メッシュ（地形と同じ解像度・同じ三角形分割）。
 *
 * 頂点ごとの値
 * - uW（テクスチャ、nx × ny、RGBA 浮動小数点）= (水位 η [m, T.P.], 全水深 D [m], 表示 α, 水位の上昇速度 [m/s])。
 *   頂点シェーダが頂点番号（gl_VertexID = セル番号）で読み、上下左右のセルとの差から水面の勾配も求める
 *   （勾配は陰影と、段波・砕波の白波に使う。CPU で計算するより軽い）
 * - aBed = 地盤高 [m, T.P.]（静的）。η − aBed が画素ごとの水の厚さで、地形と交わる線（水際）でちょうど 0 になる
 *
 * 表示のしかた
 * - 濡れたセル（D ≥ 0.01 m）は η に置く
 * - 乾いたセルでも、隣に濡れたセルがあり地盤が隣の水位より高ければ、水面を平らに延長する
 *   （地形と交わる線がちょうど水際になり、海岸線・浸水の先端が正しい位置に出る）
 * - それ以外の乾いたセルは地面より下に沈めて α=0（見えない）
 * シミュレーション前は、海のセルに潮位の静かな海を張る。
 *
 * 色は水深で決め、波の山・谷は平常の潮位からの高さで明暗を付ける（空間・時間とも連続）。
 * 上昇速度は前後のフレームの中心差分を時刻で補間した連続な値で、浸水の先端・砕波の白波（前進しているか）にだけ使う。
 * （以前は上昇速度そのもので海面を明るくしていたが、フレーム間の差分を強く飽和させていたため、
 *   水位が上がっている範囲が境目のくっきりした白っぽい帯として見え、20 秒ごとに跳んでいた）
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
} from 'three';
import { CELL_INLAND_WATER, CELL_LAND, CELL_SEA, type SimOutput, type TerrainGrid } from '../core/types';
import { DEPTH_CLASSES } from '../data/sources';
import { LIGHT_UNIFORMS, PALETTE, WATER_COMMON } from './environment';
import { triInterp } from './sampler';

const WET = 0.01;
/** 池などの内水面の見かけの水深 [m]（計算上は陸なので、色と透明度のためだけの値） */
const POND_DEPTH = 0.8;
/** 浸水の色分け（DEPTH_CLASSES）の階級数（シェーダの配列の大きさ） */
const NCLASS = DEPTH_CLASSES.length;

const WATER_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float aBed;
attribute float aLand;
uniform highp sampler2D uW;
uniform ivec2 uGrid;
uniform float uDx;
uniform float uTime;
uniform float uTide;
varying vec4 vA;    // 水の厚さ h, 全水深 D, 表示 α, 上昇速度
varying vec3 vB;    // 陸か, (未使用), 平常の潮位からの高さ
varying vec2 vGrad;
varying vec3 vWorld;
varying vec2 vXZ;
// 表示している隣のセルとの差分で求めた水面の勾配（片側しか見えていなければ片側差分）
vec2 surfaceGradient(ivec2 ij, vec4 w) {
  vec4 l = texelFetch(uW, ivec2(max(ij.x - 1, 0), ij.y), 0);
  vec4 r = texelFetch(uW, ivec2(min(ij.x + 1, uGrid.x - 1), ij.y), 0);
  vec4 u = texelFetch(uW, ivec2(ij.x, max(ij.y - 1, 0)), 0);
  vec4 d = texelFetch(uW, ivec2(ij.x, min(ij.y + 1, uGrid.y - 1)), 0);
  float hl = (ij.x > 0 && l.z > 0.0) ? 1.0 : 0.0;
  float hr = (ij.x < uGrid.x - 1 && r.z > 0.0) ? 1.0 : 0.0;
  float hu = (ij.y > 0 && u.z > 0.0) ? 1.0 : 0.0;
  float hd = (ij.y < uGrid.y - 1 && d.z > 0.0) ? 1.0 : 0.0;
  vec2 g = vec2(0.0);
  if (hl + hr > 0.0) g.x = (mix(w.x, r.x, hr) - mix(w.x, l.x, hl)) / (uDx * (hl + hr));
  if (hu + hd > 0.0) g.y = (mix(w.x, d.x, hd) - mix(w.x, u.x, hu)) / (uDx * (hu + hd));
  // 池と周りの水面の段差などで極端な値にならないよう制限
  return clamp(g, vec2(-0.5), vec2(0.5));
}
void main() {
  ivec2 ij = ivec2(gl_VertexID % uGrid.x, gl_VertexID / uGrid.x);
  vec4 aW = texelFetch(uW, ij, 0);
  vec3 p = vec3(position.x, aW.x, position.z);
  // 沖の静かなうねり（数十 cm、鉛直強調前）。計算範囲の端では 0 にして、範囲外の海と高さをそろえる
  int edgeCells = min(min(ij.x, uGrid.x - 1 - ij.x), min(ij.y, uGrid.y - 1 - ij.y));
  float deep = smoothstep(2.0, 12.0, aW.y) * (1.0 - aLand) * step(0.5, aW.z) * smoothstep(0.0, 4.0, float(edgeCells));
  float sw = sin(p.x * 0.011 + p.z * 0.019 - uTime * 0.8) * 0.16 + sin(-p.x * 0.017 + p.z * 0.029 - uTime * 1.15) * 0.09;
  p.y += sw * deep;
  vA = vec4(aW.x - aBed, aW.y, aW.z, aW.w);
  vB = vec3(aLand, 0.0, aW.x - uTide);
  vGrad = aW.z > 0.0 ? surfaceGradient(ij, aW) : vec2(0.0);
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
uniform float uExag;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uCrest;
uniform vec3 uFloodShallow;
uniform vec3 uFloodDeep;
uniform vec3 uSilt;
uniform vec3 uFoam;
uniform float uRipple;
uniform float uClassMode;
uniform float uClassMin[${NCLASS}];
uniform vec3 uClassColor[${NCLASS}];
varying vec4 vA;
varying vec3 vB;
varying vec2 vGrad;
varying vec3 vWorld;
varying vec2 vXZ;

${WATER_COMMON}

// 浸水深の階級の色（2D 地図・凡例の DEPTH_CLASSES と同じ区分）
vec3 classColor(float h) {
  vec3 c = uClassColor[0];
  for (int i = 1; i < ${NCLASS}; i++) {
    if (h >= uClassMin[i]) c = uClassColor[i];
  }
  return c;
}

void main() {
  float a0 = smoothstep(0.02, 0.6, vA.z);
  if (a0 < 0.01) discard;
  float h = max(vA.x, 0.0);
  float D = max(vA.y, 0.0);
  float rise = vA.w;
  float land = smoothstep(0.2, 0.8, vB.x);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  // 画素より細かい波は弱める（ちらつき・モアレ防止）
  float fw = length(fwidth(vXZ));
  vec2 g = ripple(vXZ, uTime, fw) * uRipple * mix(1.0, 0.45, land) * smoothstep(0.03, 0.35, V.y);
  // 水面の実際の傾き（鉛直強調込み）も法線に入れる（段波の前面などが陰影で分かる）
  vec2 sg = clamp(vGrad * uExag, vec2(-1.5), vec2(1.5));
  vec3 n = normalize(vec3(-g.x - sg.x, 1.0, -g.y - sg.y));

  // 海: 水深が浅いと海底の砂が透けた青緑、深いと藍色
  vec3 sea = mix(uShallow, uDeep, smoothstep(0.4, 16.0, D));
  // 平常の潮位からの高さで、波の山はやや白っぽく、谷はやや暗く（なめらかに飽和させ、境目を作らない）
  float an = vB.z / (abs(vB.z) + 1.5);
  sea = mix(sea, uCrest, max(an, 0.0) * 0.24);
  sea *= 1.0 - 0.25 * max(-an, 0.0);

  // 陸の浸水: 海と同じ系統の色の濁った水。浅いほど明るく透け、深いほど暗い
  vec3 fl = mix(uFloodShallow, uFloodDeep, smoothstep(0.05, 3.0, h));
  float steep = length(vGrad);
  // 流れの筋（水面の下り勾配の向きに伸びた模様。勾配がほとんど無い所は向きを持たない）
  vec2 dir = steep > 1e-5 ? -vGrad / steep : vec2(0.0, 1.0);
  float directed = smoothstep(0.0008, 0.006, steep);
  vec2 q = mat2(dir.x, -dir.y, dir.y, dir.x) * vXZ;
  float spd = 0.6 + 6.0 * min(steep, 0.2);
  float streak = vnoise(vec2(q.x * 0.035 - uTime * spd * 0.35, q.y * 0.16)) * directed + vnoise(vXZ * 0.05 + uTime * 0.05) * (1.0 - directed);
  streak = mix(0.5, streak, 1.0 - smoothstep(2.0, 6.0, fw));
  fl *= 0.9 + 0.2 * streak;
  // 浸水の先端付近は土砂を含んでやや茶色い
  fl = mix(fl, uSilt, 0.3 * (1.0 - smoothstep(0.05, 0.8, h)));
  if (uClassMode > 0.5) fl = mix(classColor(h), fl, 0.12);

  vec3 base = mix(sea, fl, land);
  float fres;
  vec3 col = shadeWater(base, n, V, uSunDir, uSunColor, uHorizon, uZenith, mix(0.8, uClassMode > 0.5 ? 0.25 : 0.55, land), fres);

  // 白波（遠くでは細かい模様を平均値に近づけて、ざらつきを防ぐ）
  float nFine = mix(vnoise(vXZ * 0.16 - uTime * 0.45), 0.5, smoothstep(1.0, 3.0, fw));
  float nCoarse = mix(vnoise(vXZ * 0.05 + vec2(uTime * 0.3, -uTime * 0.18)), 0.5, smoothstep(8.0, 24.0, fw));
  float nz = nCoarse * 0.55 + nFine * 0.45;
  float advancing = smoothstep(0.0, 0.012, rise);
  // 引き波で干上がりかけた海底に残る薄い水の膜（数 cm〜数十 cm）。白波を出さず、透かして濡れた海底に見せる
  float film = smoothstep(0.03, 0.35, D);
  // 砕波・段波: 浅い海で水面が急に立ち上がり、水位が上がっている所
  float brk = (1.0 - land) * smoothstep(0.012, 0.06, steep) * (1.0 - smoothstep(3.0, 10.0, D)) * advancing * film;
  // 浸水の先端: 水際（水の厚さが小さい所）で水位が上がっている（前進している）所
  float front = land * (1.0 - smoothstep(0.0, 0.4, h)) * smoothstep(0.001, 0.012, rise);
  // 波打ち際の細い白波
  // （引き波で水が退いている所では出さない。干上がる海底に白い筋が並ぶのを防ぐ）
  float swash = (1.0 - land) * (1.0 - smoothstep(0.0, 0.22, h)) * (0.55 + 0.2 * sin(uTime * 1.3 + vXZ.y * 0.12 + vXZ.x * 0.01)) * (1.0 - smoothstep(0.0, 0.01, -rise)) * film;
  float foamAmt = max(max(brk, front), swash);
  float foam = smoothstep(0.3, 0.9, foamAmt * (0.45 + 0.8 * nz));
  col = mix(col, uFoam, foam * 0.85);

  // 透明度: 浅い海は海底が透ける。浸水は浅いほど透け（地面が見える）、深いほど不透明
  float aSea = mix(0.5, 1.0, smoothstep(0.3, 8.0, D)) * mix(0.3, 1.0, film);
  float aFl = uClassMode > 0.5 ? mix(0.72, 0.9, smoothstep(0.01, 0.5, h)) : mix(0.6, 0.95, smoothstep(0.02, 1.5, h));
  float alpha = mix(aSea, aFl, land);
  alpha = mix(alpha, 1.0, fres * 0.45);
  alpha = max(alpha, foam * 0.95);
  // 水際（厚さ 0）へ向けてごく薄くし、地形との境目をなめらかにする
  alpha *= smoothstep(0.0, 0.025, h);
  gl_FragColor = vec4(col, alpha * a0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** 浸水の色 */
export type FloodColorMode = 'water' | 'classes';

export class WaterLayer {
  readonly material: ShaderMaterial;
  mesh: Mesh | null = null;
  private grid: TerrainGrid | null = null;
  /** 頂点ごとの (η, D, α, 上昇速度)。uW テクスチャの中身で、人形の高さ合わせ（surfaceAt）にも使う */
  private wData = new Float32Array(0);
  private wTex: DataTexture | null = null;
  /** 格子の外周のセルか（隣のセルを調べるときの範囲の確認を省くため） */
  private border = new Uint8Array(0);
  private depth = new Float32Array(0);
  private rate = new Float32Array(0);
  /** 取り出したフレームの全水深（フレーム番号 → 配列）。時刻をはさむ2枚と、その前後1枚ずつを保持 */
  private readonly frames = new Map<number, Float32Array>();
  private framePool: Float32Array[] = [];
  private framesOutput: SimOutput | null = null;
  private framesRun = '';
  private bracket = '';
  private f0: Float32Array | null = null;
  private f1: Float32Array | null = null;
  private fPrev: Float32Array | null = null;
  private fNext: Float32Array | null = null;
  /** 上昇速度の中心差分の分母 [s]（時刻をはさむ2フレームそれぞれ） */
  private span0 = 1;
  private span1 = 1;
  private wetW = new Uint8Array(0);
  private wetS = new Float32Array(0);
  /** 処理対象のセル（0: 対象外, 1: 周辺, 2: 水に関わる） */
  private mask = new Uint8Array(0);
  private maskFor: SimOutput | 'still' | null = null;
  private maskBracket = '';
  private active = new Int32Array(0);
  /** 計算範囲の境界（海側）の平均水位 [m, T.P.]（範囲外の海の高さに使う） */
  edgeEta = 0;
  /**
   * 境界のセルの (全水深 [m], 水位 [m, T.P.], 0, 0)。西端（北→南）・南端（西→東）・東端（南→北）の順。
   * 範囲外の海をこれに続けて描き、境界で継ぎ目が出ないようにする（environment.ts）
   */
  edgeProfile = new Float32Array(0);
  /** 最後に描いた状態（同じなら再計算しない） */
  private lastKey = '';
  /** 直近の update の CPU 時間 [ms]（デバッグ・計測用） */
  lastUpdateMs = 0;

  constructor() {
    const classMin = DEPTH_CLASSES.map((c) => c.min);
    const classColor = DEPTH_CLASSES.map((c) => new Color(c.color));
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uShallow: { value: PALETTE.shallowSea.clone() },
          uDeep: { value: PALETTE.deepSea.clone() },
          uCrest: { value: PALETTE.crest.clone() },
          uFloodShallow: { value: new Color('#5e9f9c') },
          uFloodDeep: { value: new Color('#245f73') },
          uSilt: { value: new Color('#8f8260') },
          uFoam: { value: new Color('#f4f7f6') },
          uRipple: { value: 0.2 },
          uExag: { value: 2 },
          uTide: { value: 0 },
          uGrid: { value: new Vector2(1, 1) },
          uDx: { value: 1 },
          uClassMode: { value: 0 },
          uClassMin: { value: classMin },
          uClassColor: { value: classColor },
        },
      ]),
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    // UniformsUtils.merge は値を複製するので、配列の uniform と共有したいものは後から差し替える
    Object.assign(this.material.uniforms, {
      uW: { value: null },
      uClassMin: { value: classMin },
      uClassColor: { value: classColor },
      uSunDir: LIGHT_UNIFORMS.uSunDir,
      uSunColor: LIGHT_UNIFORMS.uSunColor,
      uHorizon: LIGHT_UNIFORMS.uHorizon,
      uZenith: LIGHT_UNIFORMS.uZenith,
      uTime: LIGHT_UNIFORMS.uTime,
    });
  }

  /** 鉛直強調倍率（水面の傾きの陰影に使う） */
  setExaggeration(e: number): void {
    this.material.uniforms.uExag.value = e;
  }

  /**
   * 陸の浸水の色。'water' = 濁った水の色（既定）、'classes' = 2D 地図・凡例と同じ浸水深の色分け（DEPTH_CLASSES）
   */
  setFloodColorMode(mode: FloodColorMode): void {
    this.material.uniforms.uClassMode.value = mode === 'classes' ? 1 : 0;
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
    const bed = new Float32Array(n);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[k * 3] = (i + 0.5 - nx / 2) * dx;
        pos[k * 3 + 2] = (j + 0.5 - ny / 2) * dx;
        land[k] = grid.kind[k] === CELL_LAND ? 1 : 0;
        // 池は水面（z + 0.05）の下に見かけの水深を持たせる
        bed[k] = grid.kind[k] === CELL_INLAND_WATER ? grid.z[k] + 0.05 - POND_DEPTH : grid.z[k];
      }
    }
    this.depth = new Float32Array(n);
    this.rate = new Float32Array(n);
    this.border = new Uint8Array(n);
    for (let i = 0; i < nx; i++) this.border[i] = this.border[(ny - 1) * nx + i] = 1;
    for (let j = 0; j < ny; j++) this.border[j * nx] = this.border[j * nx + nx - 1] = 1;
    this.wetW = new Uint8Array(n);
    this.wetS = new Float32Array(n);
    this.mask = new Uint8Array(n);
    this.maskFor = null;
    this.maskBracket = '';
    this.active = new Int32Array(0);
    this.resetFrames();
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    this.wData = new Float32Array(n * 4);
    // 補間はしない（頂点ごとに texelFetch で読む）。浮動小数点テクスチャの線形補間に対応しない環境でも使える
    const tex = new DataTexture(this.wData, nx, ny, RGBAFormat, FloatType);
    tex.magFilter = NearestFilter;
    tex.minFilter = NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    this.wTex = tex;
    const u = this.material.uniforms;
    u.uW.value = tex;
    u.uGrid.value.set(nx, ny);
    u.uDx.value = dx;
    geo.setAttribute('aBed', new BufferAttribute(bed, 1));
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
   * 全水深はフレーム間の線形補間（SimOutput の契約どおり）。時刻をはさむ2フレームとその前後1枚を
   * fillDepth で取り出して保持し、上昇速度は各フレームでの中心差分を時刻で線形補間する（フレームの境目で跳ばない）。
   */
  update(output: SimOutput | null, t: number, tide: number, runKey: string): boolean {
    const grid = this.grid;
    const tex = this.wTex;
    if (!grid || !tex) return false;
    const key = output ? `${runKey}|${t.toFixed(3)}|${output.framesReady()}` : `still|${tide}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    const t0 = performance.now();
    this.material.uniforms.uTide.value = tide;
    const { nx, ny } = grid.spec;
    const n = nx * ny;
    const z = grid.z;
    const kind = grid.kind;
    const D = this.depth;
    const R = this.rate;
    const W = this.wetW;
    const S = this.wetS;
    let list: Int32Array;
    // 1) 全水深・上昇速度と、濡れているか（水に関わりうるセルだけ）
    if (output) {
      const f = this.selectFrames(output, t, runKey);
      list = this.activeCells(output, D);
      const A = this.f0!;
      const B = this.f1!;
      const P = this.fPrev!;
      const N = this.fNext!;
      const w0 = (1 - f) / this.span0;
      const w1 = f / this.span1;
      const m = list.length;
      for (let q = 0; q < m; q++) {
        const k = list[q];
        const a = A[k];
        const b = B[k];
        const d = a + (b - a) * f;
        D[k] = d;
        R[k] = (b - P[k]) * w0 + (N[k] - a) * w1;
        if (d >= WET && d < 1e4) {
          W[k] = 1;
          S[k] = z[k] + d;
        } else W[k] = 0;
      }
    } else {
      for (let k = 0; k < n; k++) {
        D[k] = kind[k] === CELL_SEA ? Math.max(0, tide - z[k]) : 0;
        R[k] = 0;
      }
      list = this.activeCells(null, D);
      const m = list.length;
      for (let q = 0; q < m; q++) {
        const k = list[q];
        const d = D[k];
        if (d >= WET) {
          W[k] = 1;
          S[k] = z[k] + d;
        } else W[k] = 0;
      }
    }
    // 2) 頂点の値。乾いたセルは 8 近傍の濡れたセルの平均水位（と平均の上昇速度）
    const a = this.wData;
    const border = this.border;
    const m = list.length;
    // 8 近傍のセル番号の差
    const nb = Int32Array.of(-nx - 1, -nx, -nx + 1, -1, 1, nx - 1, nx, nx + 1);
    for (let q = 0; q < m; q++) {
      const k = list[q];
      const o = k * 4;
      if (W[k] > 0) {
        a[o] = S[k];
        a[o + 1] = D[k];
        a[o + 2] = 1;
        a[o + 3] = R[k];
        continue;
      }
      let cnt = 0;
      let sum = 0;
      let rsum = 0;
      if (border[k] === 0) {
        // 内側のセル（大半）: 範囲の確認なしで 8 近傍を見る
        for (let t = 0; t < 8; t++) {
          const kk = k + nb[t];
          if (W[kk] > 0) {
            cnt++;
            sum += S[kk];
            rsum += R[kk];
          }
        }
      } else {
        const j = (k / nx) | 0;
        const i = k - j * nx;
        for (let dj = j > 0 ? -1 : 0; dj <= (j < ny - 1 ? 1 : 0); dj++) {
          for (let di = i > 0 ? -1 : 0; di <= (i < nx - 1 ? 1 : 0); di++) {
            const kk = k + dj * nx + di;
            if (kk !== k && W[kk] > 0) {
              cnt++;
              sum += S[kk];
              rsum += R[kk];
            }
          }
        }
      }
      const zk = z[k];
      if (kind[k] === CELL_INLAND_WATER) {
        // 池などの内水面（計算上は陸）: 静かな水面を表示
        a[o] = zk + 0.05;
        a[o + 1] = POND_DEPTH;
        a[o + 2] = 1;
        a[o + 3] = 0;
      } else if (cnt > 0 && zk * cnt >= sum) {
        // 水面を平らに延長（地形の下に隠れ、交線が水際になる）。上昇速度も隣から引き継ぎ、先端が前進中か分かるように
        a[o] = sum / cnt;
        a[o + 1] = 0;
        a[o + 2] = 1;
        a[o + 3] = rsum / cnt;
      } else {
        a[o] = zk - (cnt > 0 ? 0.05 : 0.6);
        a[o + 1] = 0;
        a[o + 2] = 0;
        a[o + 3] = 0;
      }
    }
    this.fillEdgeProfile(a, nx, ny, tide);
    tex.needsUpdate = true;
    this.lastUpdateMs = performance.now() - t0;
    return true;
  }

  private fillEdgeProfile(a: Float32Array, nx: number, ny: number, tide: number): void {
    const len = 2 * ny + nx;
    if (this.edgeProfile.length !== len * 4) this.edgeProfile = new Float32Array(len * 4);
    const out = this.edgeProfile;
    const put = (s: number, k: number): void => {
      const o = k * 4;
      const shown = a[o + 2] > 0;
      out[s * 4] = shown ? a[o + 1] : 0;
      out[s * 4 + 1] = shown ? a[o] : tide;
    };
    for (let j = 0; j < ny; j++) put(j, j * nx);
    for (let i = 0; i < nx; i++) put(ny + i, (ny - 1) * nx + i);
    for (let j = ny - 1; j >= 0; j--) put(ny + nx + (ny - 1 - j), j * nx + nx - 1);
    // 海側の境界（水が見えているセル）の平均水位
    let sum = 0;
    let cnt = 0;
    for (let q = 0; q < len; q++) {
      if (out[q * 4] > 0) {
        sum += out[q * 4 + 1];
        cnt += 1;
      }
    }
    this.edgeEta = cnt > 0 ? sum / cnt : tide;
  }

  /**
   * 時刻 t をはさむフレーム (i0, i1) と前後のフレームを用意し、補間の重み f を返す。
   * フレームは番号ごとに取り出して保持するので、時刻が進んでも新しく取り出すのは1枚ずつ。
   */
  private selectFrames(output: SimOutput, t: number, runKey: string): number {
    if (output !== this.framesOutput || runKey !== this.framesRun) {
      this.resetFrames();
      this.framesOutput = output;
      this.framesRun = runKey;
    }
    const fi = output.frameInterval > 0 ? output.frameInterval : 1;
    const ready = Math.max(1, output.framesReady());
    const tr = Math.max(0, Math.min(t, output.timeReady()));
    let i0 = Math.floor(tr / fi + 1e-9);
    let i1 = i0 + 1;
    if (i1 > ready - 1) {
      i1 = ready - 1;
      i0 = Math.max(0, i1 - 1);
    }
    const ip = Math.max(0, i0 - 1);
    const inx = Math.min(ready - 1, i1 + 1);
    const bk = `${i0}|${i1}|${ip}|${inx}`;
    if (bk !== this.bracket) {
      this.bracket = bk;
      const need = new Set([ip, i0, i1, inx]);
      for (const [idx, arr] of this.frames) {
        if (!need.has(idx)) {
          this.frames.delete(idx);
          this.framePool.push(arr);
        }
      }
      this.f0 = this.frame(output, i0, fi);
      this.f1 = this.frame(output, i1, fi);
      this.fPrev = this.frame(output, ip, fi);
      this.fNext = this.frame(output, inx, fi);
      // 中心差分の間隔（端では片側差分。1枚しか無ければ上昇速度 0）
      this.span0 = Math.max(1, i1 - ip) * fi;
      this.span1 = Math.max(1, inx - i0) * fi;
      if (i1 === i0) {
        this.span0 = Infinity;
        this.span1 = Infinity;
      }
    }
    return i1 > i0 ? Math.min(1, Math.max(0, (tr - i0 * fi) / fi)) : 0;
  }

  private frame(output: SimOutput, idx: number, fi: number): Float32Array {
    let arr = this.frames.get(idx);
    if (arr) return arr;
    const n = this.depth.length;
    arr = this.framePool.pop() ?? new Float32Array(n);
    output.fillDepth(idx * fi, arr);
    this.frames.set(idx, arr);
    return arr;
  }

  private resetFrames(): void {
    for (const arr of this.frames.values()) if (arr.length === this.depth.length) this.framePool.push(arr);
    this.frames.clear();
    this.framePool = this.framePool.filter((a) => a.length === this.depth.length).slice(0, 4);
    this.bracket = '';
    this.framesOutput = null;
    this.framesRun = '';
    this.f0 = this.f1 = this.fPrev = this.fNext = null;
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
      this.maskBracket = '';
      // いったん全セルを非表示に
      const a = this.wData;
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
        const A = this.f0!;
        const B = this.f1!;
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
    if (!grid || !this.wTex) return null;
    const { nx, ny, dx } = grid.spec;
    const fx = x / dx + nx / 2 - 0.5;
    const fy = zm / dx + ny / 2 - 0.5;
    const a = this.wData;
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
    this.wTex?.dispose();
    this.wTex = null;
    this.material.uniforms.uW.value = null;
    this.maskFor = null;
    this.frames.clear();
    this.framePool = [];
    this.bracket = '';
    this.framesOutput = null;
    this.f0 = this.f1 = this.fPrev = this.fNext = null;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
