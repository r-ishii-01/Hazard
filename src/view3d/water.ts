/**
 * 水面メッシュ（地形と同じ解像度・同じ三角形分割）。
 *
 * 頂点ごとの値
 * - uW0 / uW1（テクスチャ、nx × ny、RGBA 浮動小数点）= 時刻をはさむ2つの出力フレーム（キーフレーム）での
 *   (水位 η [m, T.P.], 全水深 D [m], 表示 α, 水位の上昇速度 [m/s])。頂点シェーダが uF（0〜1）で線形補間する。
 *   頂点番号（gl_VertexID = セル番号）で読み、上下左右のセルとの差から水面の勾配も求める
 *   （勾配は陰影と、段波・砕波の白波に使う。CPU で計算するより軽い）
 * - aBed = 地盤高 [m, T.P.]（静的）。η − aBed が画素ごとの水の厚さで、地形と交わる線（水際）でちょうど 0 になる
 *
 * 表示のしかた（キーフレームごとに CPU で求める）
 * - 濡れたセル（D ≥ 0.01 m）は η に置く
 * - 乾いたセルでも、隣に濡れたセルがあり地盤が隣の水位より高ければ、水面を平らに延長する
 *   （地形と交わる線がちょうど水際になり、海岸線・浸水の先端が正しい位置に出る）
 * - それ以外の乾いたセルは地面より下に沈めて α=0（見えない）
 * シミュレーション前は、海のセルに潮位の静かな海を張る。
 *
 * 再生中の負荷: キーフレームは出力フレーム（20 秒ごと）の境目を越えたときだけ1枚求めて転送し、
 * 毎フレームは補間の重み uF を変えるだけ（CPU の全セル処理とテクスチャの全面転送を毎フレーム行わない）。
 * 濡れたセルでは、補間した値は全水深・上昇速度をフレーム間で線形補間した値（SimOutput の契約）と一致する。
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
uniform highp sampler2D uW0;
uniform highp sampler2D uW1;
uniform float uF;
uniform ivec2 uGrid;
uniform float uDx;
uniform float uTime;
uniform float uTide;
varying vec4 vA;    // 水の厚さ h, 全水深 D, 表示 α, 上昇速度
varying vec2 vB;    // 陸か, 平常の潮位からの高さ
varying vec2 vGrad;
varying vec3 vWorld;
varying vec2 vXZ;
// 時刻をはさむ2つのキーフレームの値を補間
vec4 fetchW(ivec2 ij) {
  return mix(texelFetch(uW0, ij, 0), texelFetch(uW1, ij, 0), uF);
}
// 表示している隣のセルとの差分で求めた水面の勾配（片側しか見えていなければ片側差分）
vec2 surfaceGradient(ivec2 ij, vec4 w) {
  vec4 l = fetchW(ivec2(max(ij.x - 1, 0), ij.y));
  vec4 r = fetchW(ivec2(min(ij.x + 1, uGrid.x - 1), ij.y));
  vec4 u = fetchW(ivec2(ij.x, max(ij.y - 1, 0)));
  vec4 d = fetchW(ivec2(ij.x, min(ij.y + 1, uGrid.y - 1)));
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
  vec4 aW = fetchW(ij);
  vec3 p = vec3(position.x, aW.x, position.z);
  // 沖の静かなうねり（数十 cm、鉛直強調前）。計算範囲の端では 0 にして、範囲外の海と高さをそろえる
  int edgeCells = min(min(ij.x, uGrid.x - 1 - ij.x), min(ij.y, uGrid.y - 1 - ij.y));
  float deep = smoothstep(2.0, 12.0, aW.y) * (1.0 - aLand) * step(0.5, aW.z) * smoothstep(0.0, 4.0, float(edgeCells));
  float sw = sin(p.x * 0.011 + p.z * 0.019 - uTime * 0.8) * 0.16 + sin(-p.x * 0.017 + p.z * 0.029 - uTime * 1.15) * 0.09;
  p.y += sw * deep;
  vA = vec4(aW.x - aBed, aW.y, aW.z, aW.w);
  vB = vec2(aLand, aW.x - uTide);
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
varying vec2 vB;
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
  float an = vB.y / (abs(vB.y) + 1.5);
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

/** 1つの出力フレーム（または計算前の静かな海）での頂点の値 */
interface KeyFrame {
  /** 作るたびに増える番号（表示中のものと同じか判定する） */
  id: number;
  /** 'still|潮位' または 'フレーム番号|前のフレーム|次のフレーム'（上昇速度の差分に使ったフレーム） */
  key: string;
  /** 出力フレームの番号（静かな海は -1） */
  index: number;
  /** セルごとの (η, D, α, 上昇速度)。テクスチャの中身 */
  data: Float32Array;
  /** 境界のセルの (D, η, 0, 0)（edgeProfile と同じ並び） */
  edge: Float32Array;
  edgeEta: number;
  /** 処理対象外のセルに「見えない」値を書いたときの mask の世代（同じなら書き直さなくてよい） */
  maskGen: number;
}

/** GPU のテクスチャ（2枚。uW0・uW1 に割り当てる） */
interface Slot {
  tex: DataTexture;
  kf: KeyFrame | null;
  /** 転送した時点の kf.id（配列を使い回すので、別のキーフレームになったら転送し直す） */
  uploadedId: number;
}

/** 保持するキーフレームの数（時刻をはさむ2枚と、行き来したときのための1枚） */
const MAX_KEYFRAMES = 3;
/** 保持する出力フレーム（全水深）の数 */
const MAX_DEPTH_FRAMES = 4;

export class WaterLayer {
  readonly material: ShaderMaterial;
  mesh: Mesh | null = null;
  private grid: TerrainGrid | null = null;
  private slots: [Slot, Slot] | null = null;
  /** 格子の外周のセルか（隣のセルを調べるときの範囲の確認を省くため） */
  private border = new Uint8Array(0);
  /** キーフレームを求めるときの作業用（濡れているか・水位） */
  private wetW = new Uint8Array(0);
  private wetS = new Float32Array(0);
  /** 全セル「見えない」の値（キーフレームの初期値） */
  private hidden = new Float32Array(0);
  /** 取り出したフレームの全水深（フレーム番号 → 配列） */
  private readonly frames = new Map<number, Float32Array>();
  private framePool: Float32Array[] = [];
  private framesOutput: SimOutput | null = null;
  private framesRun = '';
  /** 求めたキーフレーム（key → 値）。古いものから捨てる */
  private readonly keyframes = new Map<string, KeyFrame>();
  private kfPool: KeyFrame[] = [];
  private kfSeq = 0;
  /** 処理対象のセル（0: 対象外, 1: 周辺, 2: 水に関わる） */
  private mask = new Uint8Array(0);
  private maskFor: SimOutput | 'still' | null = null;
  private maskGen = 0;
  /** mask に反映済みのフレーム番号 */
  private readonly maskedFrames = new Set<number>();
  private active = new Int32Array(0);
  /** 表示中のキーフレームと補間の重み */
  private shown: { k0: KeyFrame; k1: KeyFrame; f: number } | null = null;
  /** 今の update で使うので捨てないキーフレーム */
  private pinned: KeyFrame | null = null;
  /** 表示中の潮位（先に求めるキーフレームの境界の値に使う） */
  private shownTide = 0;
  /** 先に求めかけているキーフレーム（再生中の prefetch） */
  private job: { key: string; output: SimOutput; steps: Generator<void, KeyFrame, void> } | null = null;
  /** 値を書き込み中のキーフレームの入れ物（取りやめたときに使い回す） */
  private building: KeyFrame | null = null;
  /** 計算範囲の境界（海側）の平均水位 [m, T.P.]（範囲外の海の高さに使う） */
  edgeEta = 0;
  /**
   * 境界のセルの (全水深 [m], 水位 [m, T.P.], 0, 0)。西端（北→南）・南端（西→東）・東端（南→北）の順。
   * 範囲外の海をこれに続けて描き、境界で継ぎ目が出ないようにする（environment.ts）
   */
  edgeProfile = new Float32Array(0);
  /** 最後に描いた状態（同じなら何もしない） */
  private lastKey = '';
  /** 直近の update の CPU 時間 [ms]（デバッグ・計測用） */
  lastUpdateMs = 0;
  /** これまでに求めたキーフレームの数・GPU へ転送した量 [byte]（デバッグ・計測用） */
  keyframeBuilds = 0;
  uploadBytes = 0;

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
          uF: { value: 0 },
        },
      ]),
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    // UniformsUtils.merge は値を複製する（テクスチャ・配列・共有の uniform は複製しないよう後から加える）
    Object.assign(this.material.uniforms, {
      uW0: { value: null },
      uW1: { value: null },
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
    const hidden = new Float32Array(n * 4);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[k * 3] = (i + 0.5 - nx / 2) * dx;
        pos[k * 3 + 2] = (j + 0.5 - ny / 2) * dx;
        land[k] = grid.kind[k] === CELL_LAND ? 1 : 0;
        // 池は水面（z + 0.05）の下に見かけの水深を持たせる
        bed[k] = grid.kind[k] === CELL_INLAND_WATER ? grid.z[k] + 0.05 - POND_DEPTH : grid.z[k];
        hidden[k * 4] = grid.z[k] - 0.6;
      }
    }
    this.hidden = hidden;
    this.border = new Uint8Array(n);
    for (let i = 0; i < nx; i++) this.border[i] = this.border[(ny - 1) * nx + i] = 1;
    for (let j = 0; j < ny; j++) this.border[j * nx] = this.border[j * nx + nx - 1] = 1;
    this.wetW = new Uint8Array(n);
    this.wetS = new Float32Array(n);
    this.mask = new Uint8Array(n);
    this.maskFor = null;
    this.active = new Int32Array(0);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    // 補間はしない（頂点ごとに texelFetch で読む）。浮動小数点テクスチャの線形補間に対応しない環境でも使える
    // 中身はキーフレームの配列を割り当てたときに入れる（それまでは転送しないので、水面は見えない）
    const makeTex = (): DataTexture => {
      const tex = new DataTexture(null, nx, ny, RGBAFormat, FloatType);
      tex.magFilter = NearestFilter;
      tex.minFilter = NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      return tex;
    };
    this.slots = [
      { tex: makeTex(), kf: null, uploadedId: -1 },
      { tex: makeTex(), kf: null, uploadedId: -1 },
    ];
    const u = this.material.uniforms;
    u.uW0.value = this.slots[0].tex;
    u.uW1.value = this.slots[1].tex;
    u.uF.value = 0;
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
   * 戻り値: 表示が変わったら true
   *
   * 全水深はフレーム間の線形補間（SimOutput の契約どおり）。時刻をはさむ2フレームそれぞれの頂点の値
   * （キーフレーム）を求めて GPU に置き、補間はシェーダで行う。上昇速度は各フレームでの中心差分を時刻で線形補間する
   * （フレームの境目で跳ばない）。
   */
  update(output: SimOutput | null, t: number, tide: number, runKey: string): boolean {
    const grid = this.grid;
    if (!grid || !this.slots) return false;
    const t0 = performance.now();
    let k0: KeyFrame;
    let k1: KeyFrame;
    let f = 0;
    if (output) {
      if (output !== this.framesOutput || runKey !== this.framesRun) {
        this.releaseOutput();
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
      f = i1 > i0 ? Math.min(1, Math.max(0, (tr - i0 * fi) / fi)) : 0;
      k0 = this.frameKeyframe(output, i0, ready, fi, tide);
      // k1 を求めるときに k0 の入れ物を使い回さない
      this.pinned = k0;
      k1 = i1 === i0 ? k0 : this.frameKeyframe(output, i1, ready, fi, tide);
      this.pinned = null;
    } else {
      // 計算結果を表示しない: 前の結果（フレーム・キーフレーム）を持ち続けない
      if (this.framesOutput) this.releaseOutput();
      k0 = k1 = this.stillKeyframe(tide);
    }
    const key = `${k0.id}/${k1.id}/${f}|${tide}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    this.material.uniforms.uTide.value = tide;
    this.bind(k0, k1);
    this.material.uniforms.uF.value = f;
    this.shown = { k0, k1, f };
    this.shownTide = tide;
    this.lerpEdge(k0, k1, f);
    this.lastUpdateMs = performance.now() - t0;
    return true;
  }

  /**
   * 計算結果への参照を手放す（フレーム・キーフレーム・処理対象のセル）。次の update で作り直す。
   * 3D を表示していない間に新しい計算が始まったときなど、古い結果をメモリに残さないために呼ぶ。
   */
  releaseOutput(): void {
    this.cancelJob();
    this.resetFrames();
    for (const kf of this.keyframes.values()) this.recycle(kf);
    this.keyframes.clear();
    this.framesOutput = null;
    this.framesRun = '';
    if (this.maskFor !== 'still') this.maskFor = null;
    this.maskedFrames.clear();
    this.shown = null;
    this.lastKey = '';
  }

  /** 2つのキーフレームを uW0・uW1 に割り当てる（テクスチャの転送は、中身が変わったものだけ） */
  private bind(k0: KeyFrame, k1: KeyFrame): void {
    const slots = this.slots!;
    const holds = (s: Slot, kf: KeyFrame) => s.kf === kf && s.uploadedId === kf.id;
    // すでに転送済みのテクスチャはそのまま使う（時刻が進むと、前の k1 が次の k0 になる）
    let s0 = holds(slots[0], k0) ? slots[0] : holds(slots[1], k0) ? slots[1] : null;
    let s1 = holds(slots[1], k1) && slots[1] !== s0 ? slots[1] : holds(slots[0], k1) && slots[0] !== s0 ? slots[0] : null;
    if (k0 === k1) s1 = s0;
    if (!s0) {
      s0 = s1 === slots[0] ? slots[1] : slots[0];
      this.upload(s0, k0);
    }
    if (!s1) {
      s1 = s0 === slots[0] ? slots[1] : slots[0];
      this.upload(s1, k1);
    }
    const u = this.material.uniforms;
    u.uW0.value = s0.tex;
    u.uW1.value = s1.tex;
  }

  private upload(slot: Slot, kf: KeyFrame): void {
    slot.kf = kf;
    slot.uploadedId = kf.id;
    slot.tex.image.data = kf.data;
    slot.tex.needsUpdate = true;
    this.uploadBytes += kf.data.byteLength;
  }

  /** 境界の値（範囲外の海に使う）を2つのキーフレームの間で補間 */
  private lerpEdge(k0: KeyFrame, k1: KeyFrame, f: number): void {
    const e0 = k0.edge;
    const e1 = k1.edge;
    if (this.edgeProfile.length !== e0.length) this.edgeProfile = new Float32Array(e0.length);
    const out = this.edgeProfile;
    if (k0 === k1 || f === 0) out.set(e0);
    else if (f === 1) out.set(e1);
    else for (let q = 0; q < out.length; q++) out[q] = e0[q] + (e1[q] - e0[q]) * f;
    this.edgeEta = k0.edgeEta + (k1.edgeEta - k0.edgeEta) * f;
  }

  /** 計算前（計算結果を表示しない）: 潮位の静かな海 */
  private stillKeyframe(tide: number): KeyFrame {
    const key = `still|${tide}`;
    const have = this.keyframes.get(key);
    if (have) return have;
    this.cancelJob();
    return this.runBuild(this.stillSteps(key, tide));
  }

  private *stillSteps(key: string, tide: number): Generator<void, KeyFrame, void> {
    const grid = this.grid!;
    const z = grid.z;
    const kind = grid.kind;
    const W = this.wetW;
    const S = this.wetS;
    const list = this.activeCellsStill(tide);
    const m = list.length;
    for (let q = 0; q < m; q++) {
      const k = list[q];
      const d = kind[k] === CELL_SEA ? Math.max(0, tide - z[k]) : 0;
      if (d >= WET) {
        W[k] = 1;
        S[k] = z[k] + d;
      } else W[k] = 0;
    }
    return yield* this.buildSteps(key, -1, list, (k) => (kind[k] === CELL_SEA ? Math.max(0, tide - z[k]) : 0), () => 0, tide, new Set());
  }

  /** 出力フレーム i のキーフレームの key（上昇速度の差分に使う前後のフレームを含む） */
  private frameKey(i: number, ready: number): string {
    return `${i}|${Math.max(0, i - 1)}|${Math.min(ready - 1, i + 1)}`;
  }

  /** 出力フレーム i のキーフレーム（上昇速度は前後のフレームとの中心差分。端では片側差分） */
  private frameKeyframe(output: SimOutput, i: number, ready: number, fi: number, tide: number): KeyFrame {
    const key = this.frameKey(i, ready);
    const have = this.keyframes.get(key);
    if (have) return have;
    // 先に求めかけていたものが同じなら、残りをここで仕上げる
    const job = this.job;
    if (job && job.key === key && job.output === output) {
      this.job = null;
      return this.runBuild(job.steps);
    }
    // 別のものを求めかけていたら取りやめる（作業用の配列を共有するため）
    this.cancelJob();
    return this.runBuild(this.frameSteps(output, i, ready, fi, tide, key, new Set(this.pinned ? [this.pinned] : [])));
  }

  /**
   * キーフレームを求める手順（yield のたびに中断できる。再生中に少しずつ先に求めておくため）。
   * wetW・wetS・全水深のフレームを作業用に使うので、同時に進められるのは 1 つだけ。
   */
  private *frameSteps(output: SimOutput, i: number, ready: number, fi: number, tide: number, key: string, protect: ReadonlySet<KeyFrame>): Generator<void, KeyFrame, void> {
    const ip = Math.max(0, i - 1);
    const inx = Math.min(ready - 1, i + 1);
    const D = this.depthFrame(output, i, fi);
    yield;
    const P = this.depthFrame(output, ip, fi);
    yield;
    const N = this.depthFrame(output, inx, fi);
    // 使い終わった全水深のフレームを手放す（キーフレームに必要なのは前後1枚まで）
    this.trimFrames([ip, i, inx]);
    yield;
    const span = inx > ip ? (inx - ip) * fi : Infinity;
    const list = this.activeCellsFrame(output, i, D);
    yield;
    const z = this.grid!.z;
    const W = this.wetW;
    const S = this.wetS;
    const m = list.length;
    for (let q = 0; q < m; q++) {
      const k = list[q];
      const d = D[k];
      if (d >= WET && d < 1e4) {
        W[k] = 1;
        S[k] = z[k] + d;
      } else W[k] = 0;
      if ((q & 0xffff) === 0xffff) yield;
    }
    return yield* this.buildSteps(key, i, list, (k) => D[k], (k) => (N[k] - P[k]) / span, tide, protect);
  }

  /**
   * キーフレームの頂点の値を求める（wetW・wetS は list のセルについて設定済みであること）。
   * 乾いたセルは 8 近傍の濡れたセルの平均水位（と平均の上昇速度）で水面を延長する。
   * 仕上がったら keyframes に入れる（protect のキーフレームは、場所を空けるために捨てない）。
   */
  private *buildSteps(key: string, index: number, list: Int32Array, depthOf: (k: number) => number, rateOf: (k: number) => number, tide: number, protect: ReadonlySet<KeyFrame>): Generator<void, KeyFrame, void> {
    const grid = this.grid!;
    const { nx, ny } = grid.spec;
    const z = grid.z;
    const kind = grid.kind;
    const W = this.wetW;
    const S = this.wetS;
    const kf = this.newKeyframe(key, index, protect);
    this.building = kf;
    const a = kf.data;
    const border = this.border;
    const m = list.length;
    // 8 近傍のセル番号の差
    const nb = Int32Array.of(-nx - 1, -nx, -nx + 1, -1, 1, nx - 1, nx, nx + 1);
    for (let q = 0; q < m; q++) {
      if ((q & 0x1fff) === 0x1fff) yield;
      const k = list[q];
      const o = k * 4;
      if (W[k] > 0) {
        a[o] = S[k];
        a[o + 1] = depthOf(k);
        a[o + 2] = 1;
        a[o + 3] = rateOf(k);
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
            rsum += rateOf(kk);
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
              rsum += rateOf(kk);
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
    this.fillEdgeProfile(kf, nx, ny, tide);
    this.building = null;
    this.keyframes.set(key, kf);
    this.keyframeBuilds += 1;
    return kf;
  }

  /** 手順を最後まで進める */
  private runBuild(steps: Generator<void, KeyFrame, void>): KeyFrame {
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
    }
  }

  /**
   * 再生中、次に使うキーフレーム（時刻をはさむ 2 枚の次のフレーム）を少しずつ先に求めておく。
   * 描画の合間に呼び、budgetMs まで進めて戻る。出力フレームの境目を越えたとき、全セルの計算で
   * 1 フレームの描画が遅れないようにするため（細かい解像度では 1 枚に十数 ms かかる）。
   * 戻り値: まだ続きがあるか
   */
  prefetch(budgetMs: number): boolean {
    const sh = this.shown;
    const output = this.framesOutput;
    if (!sh || !output || !this.grid || sh.k1.index < 0) return false;
    const fi = output.frameInterval > 0 ? output.frameInterval : 1;
    const ready = Math.max(1, output.framesReady());
    const next = Math.max(sh.k0.index, sh.k1.index) + 1;
    if (next > ready - 1) return false;
    const key = this.frameKey(next, ready);
    if (this.keyframes.has(key)) return false;
    if (this.job && (this.job.key !== key || this.job.output !== output)) this.cancelJob();
    if (!this.job) {
      // 表示中の 2 枚は捨てない（場所が無ければ、それ以外の古いものを捨てる）
      const protect = new Set([sh.k0, sh.k1]);
      this.job = { key, output, steps: this.frameSteps(output, next, ready, fi, this.shownTide, key, protect) };
    }
    const t0 = performance.now();
    const job = this.job;
    for (;;) {
      const r = job.steps.next();
      if (r.done) {
        this.job = null;
        return false;
      }
      if (performance.now() - t0 >= budgetMs) return true;
    }
  }

  /** 先に求めかけていたキーフレームを取りやめる（入れ物は使い回す） */
  private cancelJob(): void {
    this.job = null;
    if (this.building) {
      this.recycle(this.building);
      this.building = null;
    }
  }

  /**
   * キーフレームの入れ物を用意する（keyframes にはまだ入れない）。多すぎれば古いものから捨てて使い回す。
   * 処理対象外のセルは「見えない」値にする。
   */
  private newKeyframe(key: string, index: number, protect: ReadonlySet<KeyFrame>): KeyFrame {
    while (this.keyframes.size >= MAX_KEYFRAMES) {
      let victim: string | null = null;
      for (const [k, kf] of this.keyframes) {
        if (protect.has(kf)) continue;
        victim = k;
        break;
      }
      if (victim === null) break;
      this.recycle(this.keyframes.get(victim)!);
      this.keyframes.delete(victim);
    }
    const n4 = this.hidden.length;
    let kf = this.kfPool.pop();
    if (!kf || kf.data.length !== n4) kf = { id: 0, key: '', index: -1, data: new Float32Array(n4), edge: new Float32Array(0), edgeEta: 0, maskGen: -1 };
    // 処理対象のセルの一覧は同じ結果の間は増える一方なので、同じ世代なら対象外のセルは「見えない」値のまま
    if (kf.maskGen !== this.maskGen) {
      kf.data.set(this.hidden);
      kf.maskGen = this.maskGen;
    }
    kf.id = ++this.kfSeq;
    kf.key = key;
    kf.index = index;
    return kf;
  }

  private recycle(kf: KeyFrame): void {
    // 表示中のテクスチャが参照している配列も使い回せる（転送済みの GPU 側の中身は変わらない。
    // 次に割り当てるときは id が変わるので転送し直す）
    if (this.kfPool.length < MAX_KEYFRAMES) this.kfPool.push(kf);
  }

  private fillEdgeProfile(kf: KeyFrame, nx: number, ny: number, tide: number): void {
    const a = kf.data;
    const len = 2 * ny + nx;
    if (kf.edge.length !== len * 4) kf.edge = new Float32Array(len * 4);
    const out = kf.edge;
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
    kf.edgeEta = cnt > 0 ? sum / cnt : tide;
  }

  /** 出力フレーム idx の全水深（番号ごとに取り出して保持） */
  private depthFrame(output: SimOutput, idx: number, fi: number): Float32Array {
    let arr = this.frames.get(idx);
    if (arr) return arr;
    const n = this.hidden.length / 4;
    arr = this.framePool.pop() ?? new Float32Array(n);
    output.fillDepth(idx * fi, arr);
    this.frames.set(idx, arr);
    return arr;
  }

  /** keep 以外の全水深のフレームを、上限を超えた分だけ手放す */
  private trimFrames(keep: number[]): void {
    if (this.frames.size <= MAX_DEPTH_FRAMES) return;
    for (const [idx, arr] of this.frames) {
      if (this.frames.size <= MAX_DEPTH_FRAMES) break;
      if (keep.includes(idx)) continue;
      this.frames.delete(idx);
      this.framePool.push(arr);
    }
  }

  private resetFrames(): void {
    const n = this.hidden.length / 4;
    for (const arr of this.frames.values()) if (arr.length === n) this.framePool.push(arr);
    this.frames.clear();
    this.framePool = this.framePool.filter((a) => a.length === n).slice(0, MAX_DEPTH_FRAMES);
  }

  /** mask を作り直す（計算結果または静かな海が変わったとき） */
  private resetMask(key: SimOutput | 'still'): void {
    // 求めかけのキーフレームは前の一覧（世代）で「見えない」値を書いているので使えない
    this.cancelJob();
    const grid = this.grid!;
    const { nx, ny } = grid.spec;
    const n = nx * ny;
    this.maskFor = key;
    this.maskGen += 1;
    this.mask.fill(0);
    this.maskedFrames.clear();
    const kind = grid.kind;
    for (let k = 0; k < n; k++) if (kind[k] !== CELL_LAND) this.markAround(k, nx, ny);
    this.rebuildActive();
  }

  /**
   * 処理するセルの一覧（出力フレーム i のキーフレーム用）。計算結果が変わったら作り直し、同じ計算結果の間は
   * 「そのフレームで濡れているセル・一度でも浸水したセル」とその周りを追加していく（一覧は増える一方）。
   * 一覧に入っていないセルは、そのフレームで乾いていて周りも乾いている（非表示のまま）。
   */
  private activeCellsFrame(output: SimOutput, i: number, D: Float32Array): Int32Array {
    if (this.maskFor !== output) this.resetMask(output);
    if (this.maskedFrames.has(i)) return this.active;
    this.maskedFrames.add(i);
    const grid = this.grid!;
    const { nx, ny } = grid.spec;
    const n = nx * ny;
    const mask = this.mask;
    const arr = output.arrival;
    let changed = false;
    for (let k = 0; k < n; k++) {
      if (mask[k] === 2) continue;
      if (D[k] >= WET || (arr && Number.isFinite(arr[k]))) {
        this.markAround(k, nx, ny);
        changed = true;
      }
    }
    if (changed) this.rebuildActive();
    return this.active;
  }

  /** 処理するセルの一覧（静かな海） */
  private activeCellsStill(tide: number): Int32Array {
    if (this.maskFor !== 'still') this.resetMask('still');
    const grid = this.grid!;
    const { nx, ny } = grid.spec;
    const n = nx * ny;
    const mask = this.mask;
    const z = grid.z;
    const kind = grid.kind;
    let changed = false;
    for (let k = 0; k < n; k++) {
      if (mask[k] !== 2 && kind[k] === CELL_SEA && tide - z[k] >= WET) {
        this.markAround(k, nx, ny);
        changed = true;
      }
    }
    if (changed) this.rebuildActive();
    return this.active;
  }

  private rebuildActive(): void {
    const mask = this.mask;
    const n = mask.length;
    let c = 0;
    for (let k = 0; k < n; k++) if (mask[k]) c++;
    const list = new Int32Array(c);
    c = 0;
    for (let k = 0; k < n; k++) if (mask[k]) list[c++] = k;
    this.active = list;
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
    const sh = this.shown;
    if (!grid || !sh) return null;
    const { nx, ny, dx } = grid.spec;
    const fx = x / dx + nx / 2 - 0.5;
    const fy = zm / dx + ny / 2 - 0.5;
    const f = sh.f;
    const a0 = sh.k0.data;
    const a1 = sh.k1.data;
    const lerp = (off: number): number => {
      const v0 = triInterp(a0, nx, ny, fx, fy, 4, off);
      return a1 === a0 || f === 0 ? v0 : v0 + (triInterp(a1, nx, ny, fx, fy, 4, off) - v0) * f;
    };
    if (lerp(2) < 0.5) return null;
    return lerp(0);
  }

  /** セル k の表示中の値 (η, D, α, 上昇速度)（テスト・デバッグ用。シェーダと同じ補間） */
  debugCell(k: number): [number, number, number, number] | null {
    const sh = this.shown;
    if (!sh) return null;
    const o = k * 4;
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const v0 = sh.k0.data[o + c];
      out[c] = v0 + (sh.k1.data[o + c] - v0) * sh.f;
    }
    return out;
  }

  /** 計算結果を参照しているか（テスト・デバッグ用） */
  get holdsOutput(): boolean {
    return this.framesOutput !== null || (this.maskFor !== null && this.maskFor !== 'still') || this.frames.size > 0;
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
    if (this.slots) for (const s of this.slots) s.tex.dispose();
    this.slots = null;
    this.material.uniforms.uW0.value = null;
    this.material.uniforms.uW1.value = null;
    this.maskFor = null;
    this.maskedFrames.clear();
    this.frames.clear();
    this.framePool = [];
    this.keyframes.clear();
    this.kfPool = [];
    this.job = null;
    this.building = null;
    this.shown = null;
    this.framesOutput = null;
    this.framesRun = '';
    this.lastKey = '';
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
