/**
 * 標高セル（水域 = NaN）から TerrainGrid を組み立てる（純粋関数）。
 * 国土地理院の標高タイル由来でも、合成（近似）地形でも同じ処理を通す。
 *
 *   水域の分類（海・河川 / 内水面） → 海底地形の推定 → 粗度係数
 */
import type { GridSpec } from '../core/geo';
import { CELL_LAND, CELL_SEA, type TerrainGrid, type TerrainSource } from '../core/types';
import { applyBathymetry, SHONAN_PROFILE, type OffshoreProfile } from './bathymetry';
import { classifyWater } from './classify';

/**
 * マニングの粗度係数 n [s/m^(1/3)]。
 * 出典: 国土交通省 水管理・国土保全局 海岸室・国土技術政策総合研究所「津波浸水想定の設定の手引き Ver.2.11」（2023年4月）
 *   https://www.mlit.go.jp/sogoseisaku/point/content/001621078.pdf
 *   の土地利用別の粗度係数（小谷ほか (1998)「GIS を利用した津波遡上計算と被害推定法」海岸工学論文集 45 に基づく）:
 *   高密度居住区 0.080 / 中密度居住区 0.060 / 低密度居住区 0.040 / 森林域 0.030 / 田畑域 0.020 / 海域・河川域 0.025
 * 土地利用のデータは持たないため、陸域は一律に中密度居住区の 0.060 とする【仮定】
 * （シミュレーション側は陸域を SimParams.landManning で上書きする）。
 */
export const MANNING = {
  /** 海域・河川域 */
  water: 0.025,
  /** 陸域の既定値（中密度居住区） */
  land: 0.06,
} as const;

export interface BuildMeta {
  source: TerrainSource;
  sourceLabel: string;
  isApproximate: boolean;
  notes: string[];
}

export interface BuildStats {
  landCells: number;
  seaCells: number;
  inlandCells: number;
  maxDepth: number;
}

export interface BuildOptions {
  /** 海底地形の推定に使う断面（既定 SHONAN_PROFILE） */
  profile?: OffshoreProfile;
  /** classifyWater に渡す「池の水面だけのセル」のマスク */
  isolated?: ArrayLike<number | boolean> | null;
}

/** elev: セル標高 [m, T.P.]（NaN = 水域）。長さ spec.nx * spec.ny */
export function buildTerrainGrid(
  spec: GridSpec,
  elev: Float32Array,
  meta: BuildMeta,
  opts: BuildOptions = {},
): { grid: TerrainGrid; stats: BuildStats } {
  const { nx, ny } = spec;
  const profile = opts.profile ?? SHONAN_PROFILE;
  if (elev.length !== nx * ny) throw new Error(`elev length ${elev.length} != ${nx}x${ny}`);
  const cls = classifyWater(elev, nx, ny, { isolated: opts.isolated });
  const bathy = applyBathymetry(cls.z, cls.kind, nx, ny, spec.dx, profile);
  const n = nx * ny;
  const manning = new Float32Array(n);
  let landCells = 0;
  for (let k = 0; k < n; k++) {
    const kd = cls.kind[k];
    manning[k] = kd === CELL_LAND ? MANNING.land : MANNING.water;
    if (kd === CELL_LAND) landCells++;
  }
  const notes = [...meta.notes];
  if (cls.seaCells > 0) {
    notes.push(
      `海底の水深は実測値ではなく、汀線からの距離に応じた推定値です（平衡海浜断面と限界水深 約${profile.closureDepth} m などの文献値に基づく仮定。最大 約${Math.round(bathy.maxDepth)} m）。`,
    );
  }
  if (cls.inlandCells > 0) {
    notes.push('海とつながっていない水面（池など）は、周囲の最も低い地盤の高さの陸として扱っています。');
  }
  const grid: TerrainGrid = {
    spec,
    z: cls.z,
    kind: cls.kind,
    manning,
    source: meta.source,
    sourceLabel: meta.sourceLabel,
    isApproximate: meta.isApproximate,
    notes,
  };
  // 念のため NaN が残っていないことを保証する
  for (let k = 0; k < n; k++) {
    if (!(grid.z[k] === grid.z[k])) grid.z[k] = grid.kind[k] === CELL_SEA ? -profile.minDepth : 0;
  }
  return { grid, stats: { landCells, seaCells: cls.seaCells, inlandCells: cls.inlandCells, maxDepth: bathy.maxDepth } };
}
