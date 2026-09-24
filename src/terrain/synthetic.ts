/**
 * 合成（近似）地形（純粋関数・決定的）。国土地理院の標高タイルを取得できないときの代用。
 *
 * 実在の海岸線・江の島・河川・高台の位置（geography.ts）に、典型的な高さを与えた「概略」の地形。
 * 個々の建物・道路・盛土・細かな起伏（旧砂丘列など）は表現しない。
 *
 * 高さの与え方（汀線からの距離 d の関数 + 高台）:
 * - 砂浜: 汀線 約1 m → 汀線から 40 m で約3 m（鵠沼海岸の砂浜は幅 約100〜150 m：
 *   鵠沼海岸 - Wikipedia https://ja.wikipedia.org/wiki/鵠沼海岸 。地図上の海岸線は砂浜の中ほどにあたる）。
 * - 海岸砂丘: 汀線から約 75 m に頂部（標高 約6 m）。国道134号の両側には平均幅 約80 m の砂防林がある
 *   （神奈川県 藤沢土木事務所「砂防林」 https://www.pref.kanagawa.jp/docs/ex5/saborin/index.html ）。
 * - 背後の低地と内陸への緩やかな上昇: 引地川より西（辻堂）で 約5 m → 汀線から 2.6 km で 約13 m、
 *   東（鵠沼・片瀬）で 約3 m → 約10 m。
 * これらの係数は、国土地理院の標高タイル（DEM5A）から求めた「汀線からの距離別の平均標高」に合わせて決めた概略値
 * （例: 汀線から 50〜100 m で約 5.6 m、200〜350 m で約 4 m、1 km で約 7 m、2 km で約 10 m）。
 * 参考: 鵠沼海岸の各丁目 約2〜5 m、鵠沼神明 約9 m、片瀬山 約31〜56 m
 * （「神奈川県藤沢市の海抜を調べてみた」 https://kichizu.com/asl-kng-fujisawa/ ）。
 */
import { lonLatToGridXY, type GridSpec } from '../core/geo';
import { distanceTransform } from './distance';
import {
  ENOSHIMA_LOWLAND_M,
  ENOSHIMA_RING,
  HILLS,
  MAINLAND_COAST,
  MAINLAND_NORTH_CLOSURE,
  RIVERS,
  type HillDef,
  type LonLatTuple,
  type RiverDef,
} from './geography';

/** 合成地形のパラメータ（すべて概略値） */
export const SYNTH = {
  /** 汀線（地図上の海岸線）の標高 [m] と、汀線から berm 距離 [m] での標高 [m] */
  shoreM: 1.0,
  bermM: 3.0,
  bermDistM: 40,
  /** 海岸砂丘: 頂部の汀線からの距離 [m]、海側・陸側の幅 [m] */
  duneDistM: 75,
  duneSeaWidthM: 35,
  duneLandWidthM: 70,
  /** 砂丘の比高 [m]（西 / 東 / 片瀬付近） */
  duneReliefWestM: 3.0,
  duneReliefEastM: 2.4,
  duneReliefKataseM: 1.0,
  /** 砂丘が低くなる区間の経度（片瀬は市街地が海岸に近く砂丘が低い） */
  kataseLon0: 139.476,
  kataseLon1: 139.4835,
  /** 西（辻堂）と東（鵠沼・片瀬）の切り替え区間の経度（引地川付近） */
  westEastLon0: 139.458,
  westEastLon1: 139.466,
  /** 背後の低地の標高 [m]（汀線から plainStartM）と、内陸への上昇量 [m]・距離スケール [m] */
  plainStartM: 250,
  plainNearWestM: 4.8,
  plainNearEastM: 3.1,
  plainRiseWestM: 14,
  plainRiseEastM: 11,
  plainScaleM: 2500,
  /** 河川沿いの低地（氾濫原）のくぼみ [m] と幅 [m] */
  valleyDepthM: 1.0,
  valleyWidthM: 120,
  /** 内陸の緩やかな起伏の振幅 [m] */
  undulationM: 1.0,
  /** 高台の輪郭の外側で周囲の低地へ下りる幅 [m] */
  hillSkirtM: 80,
  /** 江の島の海岸から低地の高さに達する幅 [m] */
  islandShoreRampM: 40,
  /** 距離場の平滑化の幅 σ [m]（砂浜・砂丘用 / 内陸の上昇用 / 高台の縁用） */
  nearSmoothM: 30,
  farSmoothM: 250,
  hillSmoothM: 40,
} as const;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * 分離型の箱形フィルタを3回かける平滑化（ほぼガウス型、σ ≒ sigmaCells）。格子端は端の値を延長する。
 * 距離場の「折れ目」（海岸線の角から内陸へ伸びる稜線）をならし、陰影に筋が出ないようにする。
 */
export function smoothField(src: Float32Array, nx: number, ny: number, sigmaCells: number): Float32Array {
  const r = Math.max(0, Math.round((Math.sqrt(4 * sigmaCells * sigmaCells + 1) - 1) / 2));
  const a = Float32Array.from(src);
  if (r === 0) return a;
  const b = new Float32Array(a.length);
  const line = new Float64Array(Math.max(nx, ny) + 2 * r);
  const norm = 1 / (2 * r + 1);
  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    const len = horizontal ? nx : ny;
    const count = horizontal ? ny : nx;
    for (let c = 0; c < count; c++) {
      for (let t = -r; t < len + r; t++) {
        const q = t < 0 ? 0 : t >= len ? len - 1 : t;
        line[t + r] = horizontal ? from[c * nx + q] : from[q * nx + c];
      }
      let acc = 0;
      for (let t = 0; t < 2 * r + 1; t++) acc += line[t];
      for (let t = 0; t < len; t++) {
        const v = acc * norm;
        if (horizontal) to[c * nx + t] = v;
        else to[t * nx + c] = v;
        acc += line[t + 2 * r + 1] - line[t];
      }
    }
  };
  for (let it = 0; it < 3; it++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  return a;
}

/** 多角形（格子座標）をセル中心で塗りつぶす（偶奇規則のスキャンライン） */
export function rasterizePolygon(ring: readonly { gx: number; gy: number }[], nx: number, ny: number, out?: Uint8Array): Uint8Array {
  const mask = out ?? new Uint8Array(nx * ny);
  const m = ring.length;
  const xs: number[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.gy < minY) minY = p.gy;
    if (p.gy > maxY) maxY = p.gy;
  }
  const j0 = Math.max(0, Math.floor(minY));
  const j1 = Math.min(ny - 1, Math.ceil(maxY));
  for (let j = j0; j <= j1; j++) {
    const yc = j + 0.5;
    xs.length = 0;
    for (let a = 0; a < m; a++) {
      const p = ring[a];
      const q = ring[(a + 1) % m];
      if (p.gy <= yc !== q.gy <= yc) xs.push(p.gx + ((yc - p.gy) / (q.gy - p.gy)) * (q.gx - p.gx));
    }
    xs.sort((u, v) => u - v);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil(xs[s] - 0.5));
      const i1 = Math.min(nx - 1, Math.floor(xs[s + 1] - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * nx + i] = 1;
    }
  }
  return mask;
}

/** 符号付き距離 [m]（mask 内 +、外 −。セル境界からの距離） */
function signedDistanceM(mask: Uint8Array, nx: number, ny: number, dx: number): Float32Array {
  const n = nx * ny;
  const inv = new Uint8Array(n);
  for (let k = 0; k < n; k++) inv[k] = mask[k] ? 0 : 1;
  const dIn = distanceTransform(inv, nx, ny);
  const dOut = distanceTransform(mask, nx, ny);
  const out = new Float32Array(n);
  const far = (nx + ny) * dx;
  for (let k = 0; k < n; k++) {
    const v = mask[k] ? (dIn[k] - 0.5) * dx : -(dOut[k] - 0.5) * dx;
    out[k] = Number.isFinite(v) ? v : mask[k] ? far : -far;
  }
  return out;
}

function toGrid(spec: GridSpec, pts: readonly LonLatTuple[]): { gx: number; gy: number }[] {
  return pts.map(([lon, lat]) => lonLatToGridXY(spec, lon, lat));
}

/**
 * 決定的な緩やかな起伏（おおむね -1〜1）。x, y は格子原点からの距離 [m]。
 * 向きの異なる正弦波を重ねて、特定の方向に筋が出ないようにしている。
 */
const WAVES: readonly { dir: number; len: number; amp: number; phase: number }[] = [
  { dir: 0.35, len: 900, amp: 0.3, phase: 1.3 },
  { dir: 1.4, len: 700, amp: 0.25, phase: 0.4 },
  { dir: 2.45, len: 560, amp: 0.2, phase: 2.1 },
  { dir: 0.9, len: 430, amp: 0.15, phase: 4.2 },
  { dir: 1.95, len: 340, amp: 0.12, phase: 5.0 },
  { dir: 2.95, len: 270, amp: 0.1, phase: 3.3 },
];

export function undulation(x: number, y: number, scale = 1): number {
  let v = 0;
  for (const w of WAVES) {
    const k = (Math.PI * 2) / (w.len * scale);
    v += w.amp * Math.sin(k * (Math.cos(w.dir) * x + Math.sin(w.dir) * y) + w.phase);
  }
  return v / 1.12;
}

/** 河川を水路として刻む。river にマスク、valley に川岸からの距離 [m]（近傍のみ）を書き込む */
function carveRivers(spec: GridSpec, rivers: readonly RiverDef[], river: Uint8Array, valley: Float32Array): void {
  const { nx, ny, dx } = spec;
  const minHalf = 0.75 * dx; // 4近傍で途切れないための最小半幅（セル対角の半分より少し大きい）
  const reach = SYNTH.valleyWidthM * 2.5;
  for (const r of rivers) {
    const g = toGrid(spec, r.line);
    const cum = [0];
    for (let s = 1; s < g.length; s++) cum.push(cum[s - 1] + Math.hypot(g[s].gx - g[s - 1].gx, g[s].gy - g[s - 1].gy) * dx);
    const total = cum[cum.length - 1] || 1;
    for (let s = 0; s + 1 < g.length; s++) {
      const ax = g[s].gx * dx;
      const ay = g[s].gy * dx;
      const vx = g[s + 1].gx * dx - ax;
      const vy = g[s + 1].gy * dx - ay;
      const len2 = vx * vx + vy * vy || 1e-9;
      const pad = (Math.max(r.widthMouthM, r.widthUpstreamM) / 2 + reach) / dx + 1;
      const i0 = Math.max(0, Math.floor(Math.min(g[s].gx, g[s + 1].gx) - pad));
      const i1 = Math.min(nx - 1, Math.ceil(Math.max(g[s].gx, g[s + 1].gx) + pad));
      const j0 = Math.max(0, Math.floor(Math.min(g[s].gy, g[s + 1].gy) - pad));
      const j1 = Math.min(ny - 1, Math.ceil(Math.max(g[s].gy, g[s + 1].gy) + pad));
      for (let j = j0; j <= j1; j++) {
        const py = (j + 0.5) * dx;
        for (let i = i0; i <= i1; i++) {
          const px = (i + 0.5) * dx;
          const t = clamp01(((px - ax) * vx + (py - ay) * vy) / len2);
          const d = Math.hypot(ax + t * vx - px, ay + t * vy - py);
          const along = (cum[s] + t * (cum[s + 1] - cum[s])) / total;
          const half = Math.max(minHalf, (r.widthMouthM + (r.widthUpstreamM - r.widthMouthM) * along) / 2);
          const k = j * nx + i;
          if (d <= half) river[k] = 1;
          const edge = Math.max(0, d - half);
          if (edge < valley[k]) valley[k] = edge;
        }
      }
    }
  }
}

/** 高台1つ分の標高場を、範囲を囲む部分格子で計算して z に max で重ねる（陸セルのみ） */
function applyHill(spec: GridSpec, hill: HillDef, z: Float32Array, land: Uint8Array): void {
  const { nx, ny, dx } = spec;
  const ring = toGrid(spec, hill.ring);
  const margin = Math.ceil((SYNTH.hillSkirtM + 3 * SYNTH.hillSmoothM) / dx) + 2;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.gx);
    maxX = Math.max(maxX, p.gx);
    minY = Math.min(minY, p.gy);
    maxY = Math.max(maxY, p.gy);
  }
  const i0 = Math.max(0, Math.floor(minX) - margin);
  const i1 = Math.min(nx - 1, Math.ceil(maxX) + margin);
  const j0 = Math.max(0, Math.floor(minY) - margin);
  const j1 = Math.min(ny - 1, Math.ceil(maxY) + margin);
  if (i1 < i0 || j1 < j0) return;
  const sx = i1 - i0 + 1;
  const sy = j1 - j0 + 1;
  const local = ring.map((p) => ({ gx: p.gx - i0, gy: p.gy - j0 }));
  const mask = rasterizePolygon(local, sx, sy);
  const sd = smoothField(signedDistanceM(mask, sx, sy, dx), sx, sy, SYNTH.hillSmoothM / dx);
  for (let j = 0; j < sy; j++) {
    const y = (j0 + j + 0.5) * dx;
    for (let i = 0; i < sx; i++) {
      const k = (j0 + j) * nx + (i0 + i);
      if (!land[k] || !(z[k] === z[k])) continue;
      const s = sd[j * sx + i];
      if (s < -SYNTH.hillSkirtM) continue;
      let zh: number;
      if (s >= 0) {
        // 谷で刻まれた丘陵らしさを出すため、上昇分を 0.75〜1.0 倍に揺らす
        const x = (i0 + i + 0.5) * dx;
        const dissect = 0.875 + 0.125 * undulation(x + 170, y - 90, 0.45);
        zh = hill.footM + (hill.topM - hill.footM) * smoothstep(0, hill.rampM, s) * dissect;
      } else {
        zh = z[k] + (hill.footM - z[k]) * (1 - smoothstep(0, SYNTH.hillSkirtM, -s));
      }
      if (zh > z[k]) z[k] = zh;
    }
  }
}

export interface SyntheticLayers {
  /** セル標高 [m]（NaN = 水域：海・河川） */
  elev: Float32Array;
  /** 本土・江の島の陸マスク（河川を刻む前） */
  land: Uint8Array;
  island: Uint8Array;
  river: Uint8Array;
}

/** 合成地形の各層を作る */
export function syntheticLayers(spec: GridSpec): SyntheticLayers {
  const { nx, ny, dx } = spec;
  const n = nx * ny;

  // 陸（本土 + 江の島）
  const land = rasterizePolygon(toGrid(spec, [...MAINLAND_COAST, ...MAINLAND_NORTH_CLOSURE]), nx, ny);
  const island = rasterizePolygon(toGrid(spec, ENOSHIMA_RING), nx, ny);
  for (let k = 0; k < n; k++) if (island[k]) land[k] = 1;

  // 汀線からの符号付き距離 [m]。近距離用（砂浜・砂丘）と遠距離用（内陸の上昇）に平滑化する
  const sdf = signedDistanceM(land, nx, ny, dx);
  const dNear = smoothField(sdf, nx, ny, SYNTH.nearSmoothM / dx);
  const dFar = smoothField(sdf, nx, ny, SYNTH.farSmoothM / dx);

  // 河川
  const river = new Uint8Array(n);
  const valley = new Float32Array(n).fill(Number.POSITIVE_INFINITY);
  carveRivers(spec, RIVERS, river, valley);

  // 経度による切り替え（格子の x は経度に比例する）
  const xOf = (lon: number) => lonLatToGridXY(spec, lon, 35.31).gx * dx;
  const weX0 = xOf(SYNTH.westEastLon0);
  const weX1 = xOf(SYNTH.westEastLon1);
  const kX0 = xOf(SYNTH.kataseLon0);
  const kX1 = xOf(SYNTH.kataseLon1);

  const elev = new Float32Array(n).fill(Number.NaN);
  for (let j = 0; j < ny; j++) {
    const y = (j + 0.5) * dx;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!land[k]) continue;
      const x = (i + 0.5) * dx;
      let z: number;
      if (island[k]) {
        // 江の島の低地（台地は HILLS で重ねる）
        z = SYNTH.shoreM + (ENOSHIMA_LOWLAND_M - SYNTH.shoreM) * smoothstep(0, SYNTH.islandShoreRampM, Math.max(0, sdf[k]));
      } else {
        const d = Math.max(0, dNear[k]);
        const dPlain = Math.max(0, dFar[k]);
        const east = smoothstep(weX0, weX1, x);
        const katase = smoothstep(kX0, kX1, x);
        // 砂浜 → 背後の低地 → 内陸へ緩やかに上昇
        const beach = SYNTH.shoreM + (SYNTH.bermM - SYNTH.shoreM) * smoothstep(0, SYNTH.bermDistM, d);
        const p0 = SYNTH.plainNearWestM + (SYNTH.plainNearEastM - SYNTH.plainNearWestM) * east;
        const rise = SYNTH.plainRiseWestM + (SYNTH.plainRiseEastM - SYNTH.plainRiseWestM) * east;
        const plain = p0 + rise * (1 - Math.exp(-Math.max(0, dPlain - SYNTH.plainStartM) / SYNTH.plainScaleM));
        const base = beach + (plain - beach) * smoothstep(SYNTH.bermDistM, SYNTH.plainStartM, d);
        // 海岸砂丘（海側は急、陸側は緩やか）
        const relief =
          (SYNTH.duneReliefWestM + (SYNTH.duneReliefEastM - SYNTH.duneReliefWestM) * east) * (1 - katase) +
          SYNTH.duneReliefKataseM * katase;
        const dq = (d - SYNTH.duneDistM) / (d < SYNTH.duneDistM ? SYNTH.duneSeaWidthM : SYNTH.duneLandWidthM);
        const dune = relief * Math.exp(-dq * dq);
        // 内陸の緩やかな起伏と、河川沿いの低地
        const wave = SYNTH.undulationM * undulation(x, y) * smoothstep(300, 900, dPlain);
        const vq = valley[k] / SYNTH.valleyWidthM;
        const vDepth = SYNTH.valleyDepthM * Math.exp(-vq * vq) * smoothstep(150, 400, dPlain);
        z = base + dune + wave - vDepth;
      }
      elev[k] = Math.max(0.3, z);
    }
  }

  // 高台・丘陵（江の島の台地を含む）
  for (const hill of HILLS) applyHill(spec, hill, elev, land);

  // 河川は水域
  for (let k = 0; k < n; k++) if (river[k]) elev[k] = Number.NaN;

  return { elev, land, island, river };
}

/** 合成地形のセル標高（NaN = 水域） */
export function syntheticElevation(spec: GridSpec): Float32Array {
  return syntheticLayers(spec).elev;
}

export const SYNTHETIC_SOURCE_LABEL = '簡易地形モデル（国土地理院の標高データを取得できなかったため、概略の地形で代用）';

export const SYNTHETIC_NOTES: readonly string[] = [
  'この地形は実測データそのものではなく、海岸線・河川・高台の位置に典型的な高さを与えた概略のモデルです。標高は場所により数 m 程度、実際と異なります。',
  '海岸線・江の島の輪郭は「国勢調査（平成27年）小地域（町丁・字等）境界データ」（総務省統計局、政府統計の総合窓口 e-Stat https://www.e-stat.go.jp/ ）を加工して作成し、河川の位置・高台の範囲と高さの目安は地理院タイル（標高タイル（基盤地図情報数値標高モデル））を加工して作成しました（国土地理院 https://maps.gsi.go.jp/development/ichiran.html#dem ）。',
  'インターネットに接続できる環境で再読み込みすると、国土地理院の標高タイルを使った地形に切り替わります。',
];
