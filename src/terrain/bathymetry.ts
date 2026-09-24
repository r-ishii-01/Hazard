/**
 * 海底地形（水深）の推定（純粋関数）。
 *
 * 標高タイルには海の水深が含まれないため、海セルの水深を「最寄りの陸（汀線）からの距離」の関数として与える。
 * これは実測（海図・深浅測量）ではなく、文献に基づく【推定】の断面形である。
 *
 * 断面形（沖向き距離 x [m] → 水深 h [m]）:
 *   h(x) = h_min + A·x^(2/3)                （x ≤ x_c：波で地形が変化する範囲。Dean の平衡海浜断面）
 *   h(x) = h_c + s·(x − x_c)                （x > x_c：その沖は一定勾配 s で深くなると仮定）
 *   ただし h_c は地形変化の限界水深、x_c は h(x_c) = h_c となる距離。
 *
 * 根拠:
 * - 平衡海浜断面 h = A·x^(2/3): Dean, R.G. (1991) "Equilibrium Beach Profiles: Characteristics and Applications",
 *   Journal of Coastal Research 7(1), 53–84. https://journals.flvc.org/jcr/article/view/78405
 *   A は底質で決まり、中央粒径 0.2 mm 程度の細砂で A ≒ 0.1 m^(1/3)（A = 0.067·w^0.44, w: 沈降速度 [cm/s]）。
 *   解説: https://www.coastalwiki.org/wiki/Shoreface_profile
 *   湘南海岸の砂は細砂が主体（粒径は場所により異なる）ため A = 0.1 を仮定した。
 * - 限界水深: 隣接する茅ヶ崎海岸で「波による地形変化の限界水深はほぼ 9 m」と報告されている
 *   （土木学会論文集B2（海岸工学）Vol.65, No.1, pp.556–560, 2009 https://www.jstage.jst.go.jp/article/kaigan/65/1/65_1_556/_pdf ）。
 * - 沖合の勾配: 相模湾は西部ほど急深で、大磯海脚の東側でも水深 100 m は沖合約 2〜3 km にある
 *   （平塚市博物館「相模湾の海底地形」 https://www.hirahaku.jp/web_yomimono/geomado/sagamibay.html ）。
 *   鵠沼〜江の島沖はそれより緩やかとみて、限界水深以深は 1/80 と仮定した（推定値）。
 *
 * 目安（この仮定での値）: 汀線から 100 m → 約 3.2 m、250 m → 約 5.0 m、500 m → 約 7.3 m、約 720 m → 9 m（限界水深）、
 * 1 km → 約 12.6 m、2 km → 約 25 m、3 km → 約 38 m。
 * 汀線近く（〜250 m）の平均勾配は約 1/60、250〜720 m は約 1/115 に相当する。
 */
import { CELL_SEA } from '../core/types';
import { distanceTransform } from './distance';

export interface OffshoreProfile {
  /** 汀線直近の最小水深 [m]（河川・遡上帯を「濡れた」状態に保つため） */
  minDepth: number;
  /** Dean の平衡断面の係数 A [m^(1/3)] */
  deanA: number;
  /** 地形変化の限界水深 [m] */
  closureDepth: number;
  /** 限界水深以深の海底勾配（水深増加 / 水平距離） */
  outerSlope: number;
}

export const SHONAN_PROFILE: OffshoreProfile = {
  minDepth: 1.0,
  deanA: 0.1,
  closureDepth: 9,
  outerSlope: 1 / 80,
};

/** 汀線からの沖向き距離 [m] → 推定水深 [m]（単調増加、x ≤ 0 は minDepth） */
export function offshoreDepth(distanceM: number, p: OffshoreProfile = SHONAN_PROFILE): number {
  const x = Math.max(0, distanceM);
  const xc = Math.pow(Math.max(0, p.closureDepth - p.minDepth) / p.deanA, 1.5);
  if (x <= xc) return p.minDepth + p.deanA * Math.pow(x, 2 / 3);
  return p.closureDepth + p.outerSlope * (x - xc);
}

export interface BathymetryResult {
  /** 海セルの汀線からの距離 [m]（海以外は 0） */
  distanceM: Float32Array;
  maxDepth: number;
}

/**
 * 海セル（kind = CELL_SEA）の z を −水深 に設定する（z をその場で書き換える）。
 * 距離は「最寄りの陸・内水面セルの中心」までのユークリッド距離から半セル分を引いた、汀線（セル境界）からの距離。
 */
export function applyBathymetry(
  z: Float32Array,
  kind: Uint8Array,
  nx: number,
  ny: number,
  dx: number,
  profile: OffshoreProfile = SHONAN_PROFILE,
): BathymetryResult {
  const n = nx * ny;
  const land = new Uint8Array(n);
  for (let k = 0; k < n; k++) land[k] = kind[k] === CELL_SEA ? 0 : 1;
  const dist = distanceTransform(land, nx, ny);
  const distanceM = new Float32Array(n);
  let maxDepth = 0;
  // 陸が1つも無い場合（全面が海）は十分沖とみなす
  const far = 20000;
  for (let k = 0; k < n; k++) {
    if (kind[k] !== CELL_SEA) continue;
    const dc = dist[k];
    const dm = Number.isFinite(dc) ? Math.max(0, (dc - 0.5) * dx) : far;
    distanceM[k] = dm;
    const h = offshoreDepth(dm, profile);
    z[k] = -h;
    if (h > maxDepth) maxDepth = h;
  }
  return { distanceM, maxDepth };
}
