/**
 * 背景（空・範囲外の海と陸・光源・霧）。
 *
 * - 空: カメラを包む球に高さ方向のグラデーションを描く（常に最背面）
 * - 範囲外: 計算範囲の外側を大きな平面で覆い、海岸線より南は海、北は陸として淡く描く。
 *   計算範囲内は discard して地形メッシュに任せる。
 *   海の高さ・色は、最も近い計算範囲の境界のセルの水位・水深（WaterLayer.edgeProfile）から続ける
 *   （境界で継ぎ目が出ないように）。高さは遠方で潮位へ戻し、水深は沖（南）へ離れるほど深くする。
 *   平面の頂点は計算範囲の近くほど細かく並べる（境界付近の高さの補間を細かくするため）。
 */
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  FloatType,
  Fog,
  HemisphereLight,
  Mesh,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  SphereGeometry,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Camera,
} from 'three';
import { SHONAN_PROFILE } from '../terrain/bathymetry';

/** 範囲外の海の水深の推定に使う断面（計算範囲内の海底地形の推定と同じ） */
const P = SHONAN_PROFILE;
/** 数値を GLSL の浮動小数点リテラルにする */
const glsl = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** 太陽の方向（南南東・高度 42°）。x=東, y=上, z=南 */
export const SUN_DIR = (() => {
  const az = (155 * Math.PI) / 180;
  const el = (42 * Math.PI) / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
})();

/** 共通の色（リニア） */
export const PALETTE = {
  zenith: new Color('#3f78b8'),
  horizon: new Color('#d9e6ee'),
  sun: new Color('#fff4e0'),
  hemiSky: new Color('#cfe0f0'),
  hemiGround: new Color('#8a8069'),
  deepSea: new Color('#113d5c'),
  /** 浅い海（砂地の海底が透ける青緑） */
  shallowSea: new Color('#3d9790'),
  /** 波の山（平常の潮位より高い海面）に混ぜる色 */
  crest: new Color('#86b4c2'),
  outerLand: new Color('#a3ad8e'),
  sand: new Color('#d9cba3'),
};

/** カスタムシェーダ共通のライティング用 uniform（全マテリアルで同じオブジェクトを共有） */
export const LIGHT_UNIFORMS = {
  uSunDir: { value: SUN_DIR.clone() },
  uSunColor: { value: PALETTE.sun.clone().multiplyScalar(1.05) },
  uSkyColor: { value: PALETTE.hemiSky.clone().multiplyScalar(0.62) },
  uGroundColor: { value: PALETTE.hemiGround.clone().multiplyScalar(0.35) },
  uHorizon: { value: PALETTE.horizon.clone() },
  uZenith: { value: PALETTE.zenith.clone() },
  uTime: { value: 0 },
};

/** 水面シェーダ共通の関数（計算範囲内の水面と範囲外の海で同じ見た目にする） */
export const WATER_COMMON = /* glsl */ `
// sin を使わないハッシュ（座標が大きくても縞模様が出にくい）
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// 小さな波の勾配（向き・波長の異なる正弦波の和）。fw = 1画素あたりの地上距離 [m]。
// 画素より細かい波は弱めて、遠方や斜めから見たときのモアレを防ぐ
float rippleFade(float lambda, float fw) { return 1.0 - smoothstep(0.08 * lambda, 0.22 * lambda, fw); }
vec2 noiseGrad(vec2 p) {
  const float e = 0.35;
  float c = vnoise(p);
  return vec2(vnoise(p + vec2(e, 0.0)) - c, vnoise(p + vec2(0.0, e)) - c) / e;
}
vec2 ripple(vec2 p, float t, float fw) {
  vec2 g = vec2(0.0);
  vec2 d1 = vec2(0.287, -0.958); float l1 = 23.0;
  vec2 d5 = vec2(0.6, 0.8); float l5 = 41.0;
  // 風の当たり方のむら（大きなスケールのノイズで波の強さを変える）
  float windPatch = 0.45 + 0.9 * vnoise(p / 380.0 + vec2(t * 0.01, 0.0));
  g += d1 * cos(dot(d1, p) * 6.2831 / l1 - t * 1.6) * 0.1 * rippleFade(l1, fw);
  g += d5 * cos(dot(d5, p) * 6.2831 / l5 - t * 1.2) * 0.09 * rippleFade(l5, fw);
  // 不規則な細かい波（値ノイズの勾配、3オクターブ）
  g += noiseGrad(p / 27.0 + vec2(t * 0.09, -t * 0.07)) * 0.22 * rippleFade(27.0, fw);
  g += noiseGrad(p / 11.0 + vec2(t * 0.21, -t * 0.17)) * 0.2 * rippleFade(11.0, fw);
  g += noiseGrad(p / 4.5 + vec2(-t * 0.37, t * 0.29)) * 0.12 * rippleFade(4.5, fw);
  return g * windPatch;
}
// 水面の反射・拡散（base: 水の色, 戻り値: 色）
vec3 shadeWater(vec3 base, vec3 n, vec3 V, vec3 sunDir, vec3 sunColor, vec3 horizon, vec3 zenith, float reflectAmt, out float fres) {
  float ndv = max(dot(n, V), 0.0);
  fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  float diff = 0.55 + 0.45 * max(dot(n, sunDir), 0.0);
  vec3 R = reflect(-V, n);
  vec3 sky = mix(horizon, zenith, pow(clamp(R.y, 0.0, 1.0), 0.6));
  vec3 col = mix(base * diff, sky, fres * reflectAmt);
  col += sunColor * pow(max(dot(R, sunDir), 0.0), 220.0) * 1.2;
  return col;
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // 常に最遠
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  // 地平線付近のもや
  col = mix(col, uHorizon * 1.02, exp(-abs(h) * 18.0) * 0.6);
  // 太陽の周りの明るさ
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.12);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * 最も近い計算範囲の境界のセルの (全水深, 水位)。境界のセルは 西端（北→南）・南端（西→東）・東端（南→北）の順に
 * 1列に並べたテクスチャ（uEdgeTex、幅 uEdgeDim.z）で、隣り合う2つを線形補間する。北端（陸）は使わない。
 */
const EDGE_COMMON = /* glsl */ `
uniform sampler2D uEdgeTex;
uniform vec3 uEdgeDim;   // ny, nx, 全長
uniform float uCellDx;
uniform float uHasEdge;
vec2 edgeAt(vec2 p) {
  float ny = uEdgeDim.x;
  float nx = uEdgeDim.y;
  float dw = p.x - uDomain.x;
  float de = uDomain.y - p.x;
  float ds = uDomain.w - p.y;
  float jj = clamp((p.y - uDomain.z) / uCellDx, 0.0, ny - 1.0);
  float u;
  if (dw <= de && dw <= ds) u = jj;
  else if (de <= ds) u = ny + nx + (ny - 1.0 - jj);
  else u = ny + clamp((p.x - uDomain.x) / uCellDx, 0.0, nx - 1.0);
  float i0 = floor(u);
  float f = u - i0;
  vec2 a = texture2D(uEdgeTex, vec2((i0 + 0.5) / uEdgeDim.z, 0.5)).xy;
  vec2 b = texture2D(uEdgeTex, vec2((min(i0 + 1.0, uEdgeDim.z - 1.0) + 0.5) / uEdgeDim.z, 0.5)).xy;
  return mix(a, b, f);
}
`;

const OUTER_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform vec4 uDomain;   // xmin, xmax, zmin, zmax（メッシュ範囲）
uniform vec2 uCoastZ;   // 西端・東端での海岸線の z
uniform float uSeaLevel;
uniform float uEdgeEta;
varying vec3 vLocal;
varying vec3 vWorld;
varying float vSea;
varying float vAnom;
${EDGE_COMMON}
float coastAt(float x) {
  return mix(uCoastZ.x, uCoastZ.y, smoothstep(uDomain.x, uDomain.y, x));
}
void main() {
  vec3 p = position;
  float c = coastAt(p.x);
  float sea = smoothstep(c - 60.0, c + 60.0, p.z);
  // 範囲外への距離
  vec2 q = max(vec2(uDomain.x - p.x, p.z - uDomain.w), vec2(p.x - uDomain.y, uDomain.z - p.z));
  float dOut = max(max(q.x, q.y), 0.0);
  float edgeEta = uHasEdge > 0.5 ? edgeAt(p.xz).y : uEdgeEta;
  float eta = mix(edgeEta, uSeaLevel, smoothstep(0.0, 4000.0, dOut));
  p.y = mix(-0.6, eta, sea);
  vSea = sea;
  vAnom = eta - uSeaLevel;
  vLocal = p;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const OUTER_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec4 uDomain;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uCrest;
uniform vec3 uSeabedShallow;
uniform vec3 uSeabedDeep;
uniform vec3 uLand;
uniform vec3 uSand;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform float uTime;
uniform float uRipple;
varying vec3 vLocal;
varying vec3 vWorld;
varying float vSea;
varying float vAnom;
uniform vec2 uCoastZ;
${WATER_COMMON}
${EDGE_COMMON}
float coastAt(float x) {
  return mix(uCoastZ.x, uCoastZ.y, smoothstep(uDomain.x, uDomain.y, x));
}
// 汀線からの距離 [m] → 推定水深 [m]（src/terrain/bathymetry.ts の offshoreDepth と同じ式・同じ値）
float shoreProfile(float x) {
  const float xc = ${glsl(Math.pow((P.closureDepth - P.minDepth) / P.deanA, 1.5))};
  return x <= xc ? ${glsl(P.minDepth)} + ${glsl(P.deanA)} * pow(x, 2.0 / 3.0) : ${glsl(P.closureDepth)} + (x - xc) * ${glsl(P.outerSlope)};
}
void main() {
  // 計算範囲内は地形・水面メッシュに任せる
  // （境界に隙間ができないよう、少しだけ内側まで重ねる）
  if (vLocal.x > uDomain.x + 12.0 && vLocal.x < uDomain.y - 12.0 && vLocal.z > uDomain.z + 12.0 && vLocal.z < uDomain.w - 12.0) discard;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float fw = length(fwidth(vLocal.xz));
  vec2 g = ripple(vLocal.xz, uTime, fw) * uRipple * smoothstep(0.03, 0.35, V.y);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  // 計算範囲内の水面（water.ts）と同じ色の決め方: 水深で浅い青緑〜藍色、平常の潮位からの高さで明暗。
  // 水深は、境界の近くでは最も近い境界のセルの値（沖＝南へ離れた分は 1/80 の勾配で深くする）、
  // 離れるにつれて海岸線からの距離による一般的な断面（bathymetry.ts と同じ仮定）へ移す
  // （江の島の周りの浅瀬などが、境界からそのまま遠くまで伸びて見えないように）
  float Dp = shoreProfile(max(vLocal.z - coastAt(vLocal.x), 0.0));
  float D = Dp;
  if (uHasEdge > 0.5) {
    vec2 q = max(vec2(uDomain.x - vLocal.x, vLocal.z - uDomain.w), vec2(vLocal.x - uDomain.y, uDomain.z - vLocal.z));
    float dOut = max(max(q.x, q.y), 0.0);
    float De = edgeAt(vLocal.xz).x + max(vLocal.z - uDomain.w, 0.0) / 80.0;
    D = mix(De, Dp, smoothstep(0.0, 1500.0, dOut));
  }
  float an = vAnom / (abs(vAnom) + 1.5);
  vec3 wc = mix(uShallow, uDeep, smoothstep(0.4, 16.0, D));
  wc = mix(wc, uCrest, max(an, 0.0) * 0.24) * (1.0 - 0.25 * max(-an, 0.0));
  float fres;
  vec3 sea = shadeWater(wc, n, V, uSunDir, uSunColor, uHorizon, uZenith, 0.8, fres);
  // 浅い所は海底が透けて見える（範囲内では半透明の水面の下に地形が見えるのと同じ見た目に。
  // 海底の色・明るさ・水の透明度は terrain.ts・water.ts と同じ式）
  vec3 bed = mix(uSeabedShallow, uSeabedDeep, smoothstep(0.0, 25.0, D)) * (uSkyColor + uSunColor * max(uSunDir.y, 0.0) * 0.78);
  float film = smoothstep(0.03, 0.35, D);
  float aSea = mix(mix(0.5, 1.0, smoothstep(0.3, 8.0, D)) * mix(0.3, 1.0, film), 1.0, fres * 0.45);
  sea = mix(bed, sea, aSea);
  // 陸: 淡い単色に弱い模様（計算範囲外であることが分かる程度）
  float nz = vnoise(vLocal.xz * 0.0016) * 0.6 + vnoise(vLocal.xz * 0.006) * 0.4;
  vec3 land = uLand * (0.86 + 0.2 * nz);
  float beach = 1.0 - smoothstep(0.1, 0.5, abs(vSea - 0.5) * 2.0);
  land = mix(land, uSand, beach * 0.8);
  vec3 col = mix(land, sea, smoothstep(0.35, 0.65, vSea));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Environment {
  readonly sky: Mesh;
  /** 計算範囲外の海と陸（ワールドの鉛直強調グループに入れる） */
  readonly outer: Mesh;
  readonly hemi: HemisphereLight;
  readonly sun: DirectionalLight;
  readonly fog: Fog;
  private readonly skyMat: ShaderMaterial;
  private readonly outerMat: ShaderMaterial;
  /** 境界のセルの (全水深, 水位)（WaterLayer.edgeProfile の写し） */
  private edgeTex = floatTexture(1);

  constructor() {
    this.skyMat = new ShaderMaterial({
      uniforms: {
        uZenith: LIGHT_UNIFORMS.uZenith,
        uHorizon: LIGHT_UNIFORMS.uHorizon,
        uSunDir: LIGHT_UNIFORMS.uSunDir,
        uSunColor: LIGHT_UNIFORMS.uSunColor,
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.sky = new Mesh(new SphereGeometry(1000, 32, 16), this.skyMat);
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.sky.name = 'sky';

    this.outerMat = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uDomain: { value: [-3000, 3000, -3000, 3000] },
          uCoastZ: { value: [700, 700] },
          uSeaLevel: { value: 0 },
          uEdgeEta: { value: 0 },
          uDeep: { value: PALETTE.deepSea.clone() },
          uShallow: { value: PALETTE.shallowSea.clone() },
          uCrest: { value: PALETTE.crest.clone() },
          uSeabedShallow: { value: new Color('#c9bd98') },
          uSeabedDeep: { value: new Color('#585346') },
          uEdgeDim: { value: [1, 1, 1] },
          uCellDx: { value: 1 },
          uHasEdge: { value: 0 },
          uLand: { value: PALETTE.outerLand.clone() },
          uSand: { value: PALETTE.sand.clone() },
          uRipple: { value: 0.2 },
        },
      ]),
      vertexShader: OUTER_VERT,
      fragmentShader: OUTER_FRAG,
      fog: true,
      // 計算範囲の端で水面メッシュと少し重ねているので、重なった所では範囲内の水面が勝つよう奥へ寄せる
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 8,
    });
    // UniformsUtils.merge は値を複製するので、共有したいものは後から差し替える
    Object.assign(this.outerMat.uniforms, {
      uSunDir: LIGHT_UNIFORMS.uSunDir,
      uSunColor: LIGHT_UNIFORMS.uSunColor,
      uSkyColor: LIGHT_UNIFORMS.uSkyColor,
      uHorizon: LIGHT_UNIFORMS.uHorizon,
      uZenith: LIGHT_UNIFORMS.uZenith,
      uTime: LIGHT_UNIFORMS.uTime,
      uEdgeTex: { value: this.edgeTex },
    });
    this.outer = new Mesh(outerPlane(), this.outerMat);
    this.outer.frustumCulled = false;
    this.outer.name = 'outer';

    this.hemi = new HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 1.35);
    this.sun = new DirectionalLight(PALETTE.sun, 2.2);
    this.sun.position.copy(SUN_DIR).multiplyScalar(10000);
    this.fog = new Fog(PALETTE.horizon.clone(), 8000, 60000);
  }

  /** 計算範囲（メッシュが覆う範囲）と、東西端での海岸線の位置を設定 */
  setDomain(xmin: number, xmax: number, zmin: number, zmax: number, coastWest: number, coastEast: number): void {
    const u = this.outerMat.uniforms;
    u.uDomain.value = [xmin, xmax, zmin, zmax];
    u.uCoastZ.value = [coastWest, coastEast];
  }

  /**
   * 範囲外の海の高さ・色。profile は境界のセルの (全水深, 水位, -, -)（WaterLayer.edgeProfile。無ければ平均水位 edgeEta だけ使う）
   */
  setSeaLevel(tide: number, edgeEta: number, profile?: { data: Float32Array; nx: number; ny: number; dx: number } | null): void {
    const u = this.outerMat.uniforms;
    u.uSeaLevel.value = tide;
    u.uEdgeEta.value = edgeEta;
    if (!profile || profile.data.length === 0) {
      u.uHasEdge.value = 0;
      return;
    }
    const len = profile.data.length / 4;
    if (this.edgeTex.image.width !== len) {
      this.edgeTex.dispose();
      this.edgeTex = floatTexture(len);
      u.uEdgeTex.value = this.edgeTex;
    }
    (this.edgeTex.image.data as Float32Array).set(profile.data);
    this.edgeTex.needsUpdate = true;
    u.uEdgeDim.value = [profile.ny, profile.nx, len];
    u.uCellDx.value = profile.dx;
    u.uHasEdge.value = 1;
  }

  /** カメラ位置に空を追従させ、霧の距離をカメラ距離に合わせる */
  update(camera: Camera, orbitDistance: number): void {
    this.sky.position.copy(camera.position);
    this.fog.near = Math.max(2500, orbitDistance * 0.9);
    this.fog.far = Math.max(25000, orbitDistance * 10);
  }

  dispose(): void {
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.outer.geometry.dispose();
    this.outerMat.dispose();
    this.edgeTex.dispose();
    this.hemi.dispose();
    this.sun.dispose();
  }
}

/**
 * 範囲外の平面（一辺 160 km）。中央の ±4.5 km は 60 m 間隔、その外は 12% ずつ間隔を広げる
 * （計算範囲の境界付近で高さの補間を細かくしつつ、頂点数を抑える）。
 */
function outerPlane(): BufferGeometry {
  const half = 80000;
  const side: number[] = [];
  let x = 0;
  let step = 60;
  while (x < 4500) {
    x += step;
    side.push(x);
  }
  while (x < half) {
    step *= 1.12;
    x = Math.min(half, x + step);
    side.push(x);
  }
  const axis = [...side.map((v) => -v).reverse(), 0, ...side];
  const n = axis.length;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = axis[i];
      pos[k + 2] = axis[j];
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const d = a + n;
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
  geo.setIndex(new BufferAttribute(idx, 1));
  return geo;
}

/** 1行の浮動小数点テクスチャ（補間はシェーダで行うので最近傍。浮動小数点テクスチャは線形補間できない環境がある） */
function floatTexture(len: number): DataTexture {
  const t = new DataTexture(new Float32Array(len * 4), len, 1, RGBAFormat, FloatType);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
