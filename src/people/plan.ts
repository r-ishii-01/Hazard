/**
 * 避難計画（経路と到着時刻）の作成。
 *
 * - 'stay'      : 移動しない。
 * - 'shelter'   : 経路コストが最小の避難場所へ（避難場所がない・到達できない場合は高台へ）。
 * - 'highground': 最寄りの「安全なセル」へ。
 *     シミュレーション結果がある場合 … 一度も浸水せず、海・浸水域から SAFE_BUFFER_M 以上離れた陸。
 *     （計算途中の結果しかない場合は、下記の標高条件も同時に満たすセルに限る＝安全側）
 *     結果がない場合 … 標高 ≥ 海岸での津波高 + 潮位（正の場合）+ HIGHGROUND_MARGIN_M の陸。
 *   安全なセルに到達できない場合は、近く（経路コスト FALLBACK_SEARCH_M 以内）で最も高い地点を目指す。
 *
 * 【モデル上の近似】道路網・建物・信号・混雑は考慮せず、陸はどこでも一定速度で歩けるとする。
 * 経路は地形グリッド上の最短経路で、実際の避難路とは異なる。公的な避難計画ではない。
 */
import { gridXYToLonLat, lonLatToGridXY } from '../core/geo';
import type { EvacPlan, Person, PathPoint, Shelter, ShelterKind, SimOutput, SimParams, TerrainGrid } from '../core/types';
import {
  HIGHGROUND_MARGIN_M,
  MIN_START_LAND_AREA_M2,
  PASS_LAND,
  PASS_WATER_CROSS,
  getGridContext,
  hasReachableTarget,
  heightSafeMask,
  nearestLand,
  outputComplete,
  outputMatchesGrid,
  shelterTargets,
  simAndHeightSafeMask,
  simSafeMask,
  targetDistanceField,
  type GridContext,
} from './gridctx';
import { costModelFor, reconstruct, searchPath, smoothPath, type CostModel, type GridPoint } from './pathfind';
import { PERSON_PROFILES } from './profiles';

/**
 * 安全な場所に到達できない場合に「近くで最も高い地点」を探す範囲（経路コスト [m]）。
 * 1.0m/s で約25分の距離。モデル上の仮定。
 */
export const FALLBACK_SEARCH_M = 1500;

/** 歩行速度の下限 [m/s]（0 やマイナスの入力に備える） */
const MIN_SPEED = 0.05;

/** 人物の歩行速度 [m/s]（未指定・不正値は種別の既定値。極端に小さい正の値は MIN_SPEED に切り上げ） */
export function personSpeed(person: Person): number {
  const profile = PERSON_PROFILES[person.kind] ?? PERSON_PROFILES.adult;
  const v = person.speedMps;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.max(MIN_SPEED, v);
  return Math.max(MIN_SPEED, profile.speedMps);
}

/** 避難開始時刻 [秒]（地震発生から） */
export function departureSec(person: Person): number {
  const m = person.startDelayMin;
  return Number.isFinite(m) && m > 0 ? m * 60 : 0;
}

function stayPlan(person: Person): EvacPlan {
  return { personId: person.id, path: [{ lon: person.lon, lat: person.lat, t: 0 }], target: null, arriveAt: null, distanceM: 0 };
}

interface GoalInfo {
  name: string;
  kind: ShelterKind;
  /** 避難場所の正確な位置（避難場所のときのみ） */
  lon?: number;
  lat?: number;
  /** 「安全」とした根拠の短い説明（高台のときのみ。現在地がすでに安全な場合の表示に使う） */
  basis?: string;
}

interface Goal {
  mask: Uint8Array;
  /** 目標セル → 名前・種別・正確な位置 */
  describe: (k: number) => GoalInfo;
}

/**
 * 計算時間が、シナリオの最大波（押し波の第1波。arrivalMin に最大となる設定）の到達後さらに1周期分を含むか。
 * 含まない（例: 到達60分のシナリオを30分だけ計算）場合、「計算で浸水しなかった」ことは安全の根拠にならない。
 * 判定の目安（到達 + 1周期）はモデル上の仮定。
 */
export function simCoversMainWave(output: SimOutput, params: SimParams): boolean {
  const sc = params.scenario;
  const arrival = Number.isFinite(sc.arrivalMin) ? Math.max(0, sc.arrivalMin) : 0;
  const period = Number.isFinite(sc.periodMin) ? Math.max(0, sc.periodMin) : 0;
  return output.durationSec >= (arrival + period) * 60 - 1e-6;
}

/** 'highground' の目標（安全なセル）を作る */
function highgroundGoal(ctx: GridContext, output: SimOutput | null, params: SimParams, prefix = ''): Goal {
  const coast = Number.isFinite(params.scenario.coastHeight) ? params.scenario.coastHeight : 10;
  const tide = Number.isFinite(params.tideTP) ? Math.max(0, params.tideTP) : 0;
  const threshold = coast + tide + HIGHGROUND_MARGIN_M;
  const z = ctx.grid.z;
  const usable = output && output.framesReady() > 0 && outputMatchesGrid(ctx, output) ? output : null;
  if (usable) {
    const complete = outputComplete(usable);
    if (complete && simCoversMainWave(usable, params)) {
      const basis = '計算で浸水しなかった地点';
      return {
        mask: simSafeMask(ctx, usable),
        describe: (k) => ({ name: `${prefix}最寄りの高台（${basis}・標高 ${z[k].toFixed(1)} m）`, kind: 'highground', basis }),
      };
    }
    // 計算途中・計算時間が短い: まだ浸水していないだけの場所を選ばないよう、標高条件と両方を満たすセルに限る
    const basis = complete ? '計算時間が最大波の到達を十分に含まないため標高でも判定' : '計算途中の結果で浸水なし';
    return {
      mask: simAndHeightSafeMask(ctx, usable, threshold),
      describe: (k) => ({ name: `${prefix}最寄りの高台（標高 ${z[k].toFixed(1)} m・${basis}）`, kind: 'highground', basis }),
    };
  }
  const basis = `想定津波高 ${coast.toFixed(1)} m + ${HIGHGROUND_MARGIN_M} m 以上`;
  return {
    mask: heightSafeMask(ctx, threshold),
    describe: (k) => ({ name: `${prefix}最寄りの高台（標高 ${z[k].toFixed(1)} m・${basis}）`, kind: 'highground', basis }),
  };
}

/** 目標マスクのうち経路コストが最小のセルと、そこまでのセル列（到達できなければ null） */
function findNearest(ctx: GridContext, model: CostModel, start: number, mask: Uint8Array): { target: number; cells: number[] } | null {
  if (!hasReachableTarget(ctx, mask, start)) return null;
  const res = searchPath(ctx, model, start, { mask, h: targetDistanceField(ctx, mask) });
  return res.target >= 0 ? { target: res.target, cells: reconstruct(res.parent, res.target) } : null;
}

/**
 * 避難計画を作る。所要時間はおおむね標準解像度（352×394）で数ms〜20ms程度。
 */
export function planEvacuation(
  person: Person,
  grid: TerrainGrid,
  shelters: Shelter[],
  output: SimOutput | null,
  params: SimParams,
): EvacPlan {
  if (person.evacMode === 'stay' || !grid) return stayPlan(person);
  const ctx = getGridContext(grid);
  const spec = grid.spec;
  const origin = lonLatToGridXY(spec, person.lon, person.lat);
  const oi = Math.floor(origin.gx);
  const oj = Math.floor(origin.gy);
  if (!(oi >= 0 && oj >= 0 && oi < ctx.nx && oj < ctx.ny)) return stayPlan(person); // 計算範囲外
  const originCell = oj * ctx.nx + oi;
  // 水域（海）にいる場合は最寄りの陸から歩き始める（岩・防波堤などの孤立した小さな陸は避ける）。
  // 細い川の上は橋の上とみなしてそのまま
  let startCell = originCell;
  if (ctx.pass[originCell] !== PASS_LAND && ctx.pass[originCell] !== PASS_WATER_CROSS) {
    const minCells = Math.max(1, Math.ceil(MIN_START_LAND_AREA_M2 / (ctx.dx * ctx.dx)));
    startCell = nearestLand(ctx, originCell, 400, minCells);
    if (startCell < 0) startCell = nearestLand(ctx, originCell);
  }
  if (startCell < 0) return stayPlan(person);

  const model = costModelFor((PERSON_PROFILES[person.kind] ?? PERSON_PROFILES.adult).mobility);

  // 目標の決定
  let goal: Goal;
  if (person.evacMode === 'shelter') {
    const targets = shelterTargets(ctx, shelters);
    if (targets.count > 0) {
      goal = {
        mask: targets.mask,
        describe: (k) => {
          const s = targets.byCell.get(k);
          return s ? { name: s.name, kind: s.kind, lon: s.lon, lat: s.lat } : { name: '避難場所', kind: 'evac-site' };
        },
      };
    } else {
      goal = highgroundGoal(ctx, output, params, '避難場所データがないため');
    }
  } else {
    goal = highgroundGoal(ctx, output, params);
  }

  let found = findNearest(ctx, model, startCell, goal.mask);
  if (!found && person.evacMode === 'shelter') {
    // 避難場所に到達できない（川や海で隔てられている等）→ 高台へ
    goal = highgroundGoal(ctx, output, params, '避難場所に到達できないため');
    found = findNearest(ctx, model, startCell, goal.mask);
  }

  let targetCell: number;
  let cells: number[];
  let info: GoalInfo;
  if (found) {
    targetCell = found.target;
    cells = found.cells;
    info = goal.describe(targetCell);
  } else {
    // 安全な場所に到達できない → 近く（経路コスト FALLBACK_SEARCH_M 以内）で最も高い地点
    const res = searchPath(ctx, model, startCell, { highestWithin: FALLBACK_SEARCH_M });
    targetCell = res.target;
    if (targetCell < 0 || targetCell === startCell) return stayPlan(person);
    cells = reconstruct(res.parent, targetCell);
    const why = person.evacMode === 'shelter' ? '避難場所にも安全な高台にも到達できないため' : '安全な高台に到達できないため';
    info = {
      name: `${why}近くで最も高い地点（標高 ${grid.z[targetCell].toFixed(1)} m・安全とは限りません）`,
      kind: 'highground',
    };
  }

  const depart = departureSec(person);
  const speed = personSpeed(person);

  // すでに安全な場所にいる（移動不要）
  if (cells.length <= 1 && startCell === originCell && info.lon === undefined) {
    return {
      personId: person.id,
      path: [{ lon: person.lon, lat: person.lat, t: 0 }],
      target: {
        lon: person.lon,
        lat: person.lat,
        name: `現在地（${info.basis ?? '安全とみなす高台'}・標高 ${grid.z[startCell].toFixed(1)} m）`,
        kind: info.kind,
      },
      arriveAt: 0,
      distanceM: 0,
    };
  }

  // 連続座標の点列: 出発点（本人の位置）→ 経路セルの中心 →（避難場所なら正確な位置）
  const pts: GridPoint[] = [{ gx: origin.gx, gy: origin.gy }];
  for (let s = startCell === originCell ? 1 : 0; s < cells.length; s++) {
    const k = cells[s];
    const i = k % ctx.nx;
    pts.push({ gx: i + 0.5, gy: (k - i) / ctx.nx + 0.5 });
  }
  if (info.lon !== undefined && info.lat !== undefined) {
    const tgt = lonLatToGridXY(spec, info.lon, info.lat);
    // 避難場所の位置が経路の終点セル内にある場合だけ正確な位置まで歩く（水域に寄せた場合は終点セルの中心で止める）
    if (Math.floor(tgt.gx) === targetCell % ctx.nx && Math.floor(tgt.gy) === Math.floor(targetCell / ctx.nx)) {
      if (pts.length > 1) pts[pts.length - 1] = { gx: tgt.gx, gy: tgt.gy };
      else pts.push({ gx: tgt.gx, gy: tgt.gy });
    }
  }
  if (pts.length === 1) pts.push({ ...pts[0] });

  const keep = smoothPath(ctx, model, pts);
  const path: PathPoint[] = [];
  let dist = 0;
  let prev: GridPoint | null = null;
  for (const idx of keep) {
    const p = pts[idx];
    if (prev) dist += Math.hypot(p.gx - prev.gx, p.gy - prev.gy) * ctx.dx;
    const ll = gridXYToLonLat(spec, p.gx, p.gy);
    path.push({ lon: ll.lon, lat: ll.lat, t: depart + dist / speed });
    prev = p;
  }
  // 始点は本人の正確な位置
  path[0] = { lon: person.lon, lat: person.lat, t: depart };
  const last = path[path.length - 1];
  const target = {
    lon: info.lon ?? last.lon,
    lat: info.lat ?? last.lat,
    name: info.name,
    kind: info.kind,
  };
  return { personId: person.id, path, target, arriveAt: last.t, distanceM: dist };
}
