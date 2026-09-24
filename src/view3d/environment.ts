/**
 * 背景（空・範囲外の海と陸・光源・霧）。
 *
 * - 空: カメラを包む球に高さ方向のグラデーションを描く（常に最背面）
 * - 範囲外: 計算範囲の外側を大きな平面で覆い、海岸線より南は海、北は陸として淡く描く。
 *   計算範囲内は discard して地形メッシュに任せる。海の高さは境界付近の水位に合わせ、遠方で潮位へ戻す。
 */
import {
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Camera,
} from 'three';

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
  deepSea: new Color('#123f5e'),
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
  g += d1 * cos(dot(d1, p) * 6.2831 / l1 - t * 1.6) * 0.22 * rippleFade(l1, fw);
  g += d5 * cos(dot(d5, p) * 6.2831 / l5 - t * 1.2) * 0.2 * rippleFade(l5, fw);
  // 不規則な細かい波（値ノイズの勾配、2オクターブ）
  g += noiseGrad(p / 11.0 + vec2(t * 0.21, -t * 0.17)) * 0.2 * rippleFade(11.0, fw);
  g += noiseGrad(p / 4.5 + vec2(-t * 0.37, t * 0.29)) * 0.12 * rippleFade(4.5, fw);
  return g;
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
  float eta = mix(uEdgeEta, uSeaLevel, smoothstep(0.0, 4000.0, dOut));
  p.y = mix(-0.6, eta, sea);
  vSea = sea;
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
uniform vec3 uLand;
uniform vec3 uSand;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform float uTime;
uniform float uRipple;
varying vec3 vLocal;
varying vec3 vWorld;
varying float vSea;
${WATER_COMMON}
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
  float fres;
  vec3 sea = shadeWater(uDeep, n, V, uSunDir, uSunColor, uHorizon, uZenith, 0.8, fres);
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
          uLand: { value: PALETTE.outerLand.clone() },
          uSand: { value: PALETTE.sand.clone() },
          uRipple: { value: 0.2 },
        },
      ]),
      vertexShader: OUTER_VERT,
      fragmentShader: OUTER_FRAG,
      fog: true,
    });
    // UniformsUtils.merge は値を複製するので、共有したいものは後から差し替える
    Object.assign(this.outerMat.uniforms, {
      uSunDir: LIGHT_UNIFORMS.uSunDir,
      uSunColor: LIGHT_UNIFORMS.uSunColor,
      uHorizon: LIGHT_UNIFORMS.uHorizon,
      uZenith: LIGHT_UNIFORMS.uZenith,
      uTime: LIGHT_UNIFORMS.uTime,
    });
    const plane = new PlaneGeometry(160000, 160000, 200, 200);
    plane.rotateX(-Math.PI / 2);
    this.outer = new Mesh(plane, this.outerMat);
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

  setSeaLevel(tide: number, edgeEta: number): void {
    this.outerMat.uniforms.uSeaLevel.value = tide;
    this.outerMat.uniforms.uEdgeEta.value = edgeEta;
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
    this.hemi.dispose();
    this.sun.dispose();
  }
}
