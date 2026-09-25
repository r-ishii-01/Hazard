/**
 * 時刻 t における人物の位置・浸水深・状態。
 *
 * 「生命の危険（critical）」は一度でも経験したらその時点・その場所で固定する（sticky）。
 * 判定のため、人物×計画×計算結果ごとに浸水深の時系列を一度だけサンプリングしてキャッシュし、
 * 計算結果のフレームが増えたら増えた分だけ追加で調べる（毎フレームの計算は二分探索と数回の参照のみ）。
 * 計画が作り直されると（別のオブジェクトになるので）キャッシュも作り直される。
 * キャッシュは計算結果をキーにしているので、古い計画を持ち続けても古い計算結果はメモリに残らない。
 *
 * 状態・浸水深はいずれもモデルによる計算上の値で、個人の実際の被害を予測するものではない。
 */
import { formatDepth, formatElapsed } from '../core/format';
import { lonLatToCell } from '../core/geo';
import { CELL_LAND, type EvacPlan, type Person, type PersonState, type PersonStatus, type SimOutput, type TerrainGrid } from '../core/types';
import { getGridContext, nearestLand } from './gridctx';
import { departureSec, personSpeed } from './plan';
import { DEPTH_CAUTION_M, DEPTH_CRITICAL_M, classifyDepth } from './profiles';

// ---------------------------------------------------------------------------
// 表示用の書式（経過時間・浸水深は画面の他の表示と同じ書式: core/format.ts）
// ---------------------------------------------------------------------------

export { formatDepth, formatElapsed };

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}

// ---------------------------------------------------------------------------
// 位置
// ---------------------------------------------------------------------------

export interface PositionInfo {
  lon: number;
  lat: number;
  /** 経路上の移動距離 [m] */
  traveled: number;
  phase: 'before' | 'moving' | 'arrived' | 'static';
}

/** 経路上の累積距離（計画ごとにキャッシュ） */
const cumDistCache = new WeakMap<EvacPlan, Float64Array>();

function cumulativeDistance(plan: EvacPlan): Float64Array {
  let cum = cumDistCache.get(plan);
  if (!cum) {
    const p = plan.path;
    cum = new Float64Array(p.length);
    // 時刻の差から距離を逆算すると速度が必要になるので、ここでは時刻比で distanceM を按分する
    const t0 = p[0]?.t ?? 0;
    const t1 = p[p.length - 1]?.t ?? 0;
    for (let i = 0; i < p.length; i++) cum[i] = t1 > t0 ? ((p[i].t - t0) / (t1 - t0)) * plan.distanceM : 0;
    cumDistCache.set(plan, cum);
  }
  return cum;
}

/** 計画が動きを伴うか（とどまる・目標なしは false） */
function isMoving(plan: EvacPlan | undefined): plan is EvacPlan {
  return !!plan && plan.target !== null && plan.arriveAt !== null && plan.path.length >= 2;
}

/** 時刻 t の位置 */
export function positionAt(person: Person, plan: EvacPlan | undefined, t: number): PositionInfo {
  if (!isMoving(plan)) {
    return { lon: person.lon, lat: person.lat, traveled: 0, phase: 'static' };
  }
  const p = plan.path;
  if (t <= p[0].t) return { lon: person.lon, lat: person.lat, traveled: 0, phase: 'before' };
  const last = p[p.length - 1];
  if (t >= last.t) return { lon: last.lon, lat: last.lat, traveled: plan.distanceM, phase: 'arrived' };
  // 二分探索で区間を探す
  let lo = 0;
  let hi = p.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = p[lo];
  const b = p[hi];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  const cum = cumulativeDistance(plan);
  return {
    lon: a.lon + (b.lon - a.lon) * f,
    lat: a.lat + (b.lat - a.lat) * f,
    traveled: cum[lo] + (cum[hi] - cum[lo]) * f,
    phase: 'moving',
  };
}

// ---------------------------------------------------------------------------
// 地盤高・浸水深の参照
// ---------------------------------------------------------------------------

/** 地盤高 [m, T.P.]。海・川のセル（橋の上・砂浜など）では最寄りの陸の値。不明は NaN */
function groundAt(grid: TerrainGrid | null, lon: number, lat: number): number {
  if (!grid) return NaN;
  const c = lonLatToCell(grid.spec, lon, lat);
  if (!c) return NaN;
  let k = c.k;
  if (grid.kind[k] !== CELL_LAND) {
    const ctx = getGridContext(grid);
    const kk = nearestLand(ctx, k, Math.max(2, Math.ceil(60 / ctx.dx)));
    if (kk >= 0) k = kk;
  }
  const z = grid.z[k];
  return Number.isFinite(z) ? z : NaN;
}

/** 計算結果ごとの「初期に水があるセル → 最寄りの初期乾燥セル」の表 */
const outputLandCache = new WeakMap<SimOutput, Int32Array>();

/**
 * 初期（t=0）に水がある（海・川）セルを、最寄りの初期乾燥セルに置き換える表を作る。
 * 乾燥セルからの多始点・幅優先探索（8近傍、チェビシェフ距離で最寄り）で O(セル数)。乾燥セル自身は自分を指す。
 * 乾燥セルが1つもなければ全て -1。
 */
function buildOutputLandIndex(output: SimOutput): Int32Array {
  const { nx, ny } = output.spec;
  const n = nx * ny;
  const idx = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let k = 0; k < n; k++) {
    // NaN は乾燥扱い（浸水深 0 として読む）
    if (!(output.depthAt(0, k) >= DEPTH_CAUTION_M)) {
      idx[k] = k;
      queue[tail++] = k;
    }
  }
  let head = 0;
  while (head < tail) {
    const c = queue[head++];
    const ci = c % nx;
    const cj = (c - ci) / nx;
    const src = idx[c];
    for (let dj = -1; dj <= 1; dj++) {
      const nj = cj + dj;
      if (nj < 0 || nj >= ny) continue;
      for (let di = -1; di <= 1; di++) {
        const ni = ci + di;
        if (ni < 0 || ni >= nx) continue;
        const nk = nj * nx + ni;
        if (idx[nk] !== -1) continue;
        idx[nk] = src;
        queue[tail++] = nk;
      }
    }
  }
  return idx;
}

/**
 * 計算結果のセル k が初期に水がある（海・川）セルなら、最寄りの初期乾燥セルを返す。
 * 海域の「全水深」は海底からの水柱で、人が受ける浸水深ではないため（橋の上・波打ち際・海上の人は、
 * 最寄りの陸地の浸水深で近似する。岸からの距離は問わない）。表は初めて必要になった時に一度だけ作る。
 */
function outputLandCell(output: SimOutput, k: number): number {
  if (!(output.depthAt(0, k) >= DEPTH_CAUTION_M)) return k;
  let idx = outputLandCache.get(output);
  if (!idx || idx.length !== output.spec.nx * output.spec.ny) {
    idx = buildOutputLandIndex(output);
    outputLandCache.set(output, idx);
  }
  const m = idx[k];
  return m >= 0 ? m : k;
}

/** 時刻 t・位置での浸水深 [m]（計算結果なし・範囲外・未計算の時刻は 0） */
export function depthAtPosition(output: SimOutput | null, lon: number, lat: number, t: number): number {
  if (!output || output.framesReady() <= 0) return 0;
  const c = lonLatToCell(output.spec, lon, lat);
  if (!c) return 0;
  const k = outputLandCell(output, c.k);
  const tt = Math.min(Math.max(0, t), output.timeReady());
  const d = output.depthAt(tt, k);
  return d > 0 ? d : 0;
}

// ---------------------------------------------------------------------------
// 生命の危険（critical）の判定キャッシュ
// ---------------------------------------------------------------------------

export interface CriticalHit {
  t: number;
  depth: number;
  lon: number;
  lat: number;
}

interface Track {
  personLon: number;
  personLat: number;
  /** ここまでの時刻は調べ済み */
  until: number;
  /** 次に調べるサンプルの番号（時刻 = 番号 × step。浮動小数の誤差をためないよう整数で数える） */
  next: number;
  /** 直前に調べた（閾値未満だった）時刻。まだ調べていなければ -1 */
  prev: number;
  /** サンプリング間隔 [秒]（フレーム間隔 / div） */
  step: number;
  /** 1フレーム間隔あたりのサンプル数 */
  div: number;
  hit: CriticalHit | null;
}

/**
 * 判定のキャッシュ: 計算結果 → （計画、計画が無ければ人物）→ Track。
 * 外側のキーを計算結果にし、Track からは計算結果を参照しない。こうすると、古い計画や人物のオブジェクトを
 * どこかが持ち続けても、古い計算結果（全フレーム）はメモリに残らない（計算結果が要らなくなれば内側の表ごと消える）。
 */
const tracks = new WeakMap<SimOutput, WeakMap<object, Track>>();

/** サンプリング間隔: フレーム間隔を割り切る値で、移動中に1セルあたり2回以上調べられる細かさ */
function sampleStep(person: Person, output: SimOutput): { step: number; div: number } {
  const fi = output.frameInterval > 0 ? output.frameInterval : 10;
  const dtMove = (0.5 * output.spec.dx) / personSpeed(person);
  const div = Math.max(1, Math.ceil(fi / Math.max(0.25, dtMove)));
  return { step: fi / div, div };
}

function getTrack(person: Person, plan: EvacPlan | undefined, output: SimOutput): Track {
  const key: object = plan ?? person;
  let byKey = tracks.get(output);
  if (!byKey) {
    byKey = new WeakMap();
    tracks.set(output, byKey);
  }
  let tr = byKey.get(key);
  if (!tr || tr.personLon !== person.lon || tr.personLat !== person.lat) {
    const { step, div } = sampleStep(person, output);
    tr = { personLon: person.lon, personLat: person.lat, until: -Infinity, next: 0, prev: -1, step, div, hit: null };
    byKey.set(key, tr);
  }
  return tr;
}

/**
 * 時刻 upTo まで（計算済みの範囲で）調べ、critical に初めて達した時刻を記録する。
 *
 * - 移動中は step ごと（1セルあたり2回以上）に調べる。
 * - 止まっている間（出発前・到着後・とどまる）は、浸水深がフレーム間で線形補間（SimOutput の契約）なので、
 *   区間内の最大はフレーム時刻でとる。フレーム時刻だけ調べれば十分なので、次のフレーム時刻まで飛ばす。
 * - 区間の終わり（upTo がサンプル時刻でない場合）も調べるので、ある時刻に critical と判定されたら、
 *   それより後の時刻でも必ず critical になる（sticky）。
 */
function extendTrack(tr: Track, output: SimOutput, person: Person, plan: EvacPlan | undefined, upTo: number): void {
  if (tr.hit) return;
  const limit = Math.min(upTo, output.timeReady());
  if (!(limit > tr.until)) return;
  const depthOf = (t: number) => {
    const pos = positionAt(person, plan, t);
    return { pos, d: depthAtPosition(output, pos.lon, pos.lat, t) };
  };
  // 直前の（閾値未満の）時刻 lo と、閾値以上になった時刻 hi の間を二分法で詰める
  const record = (lo: number, hi: number, hiPos: PositionInfo, hiD: number) => {
    let hitPos = hiPos;
    let hitD = hiD;
    if (lo >= 0 && lo < hi) {
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        const m = depthOf(mid);
        if (m.d >= DEPTH_CRITICAL_M) {
          hi = mid;
          hitPos = m.pos;
          hitD = m.d;
        } else {
          lo = mid;
        }
      }
    }
    tr.hit = { t: hi, depth: hitD, lon: hitPos.lon, lat: hitPos.lat };
  };
  const moving = isMoving(plan);
  const depart = moving ? plan.path[0].t : Infinity;
  const arrive = moving ? plan.path[plan.path.length - 1].t : Infinity;
  // 避難場所・津波避難ビルに到着した後は（垂直避難を想定して）安全とみなし、判定しない
  const safeFrom = moving && plan.target && isShelterKind(plan.target.kind) ? arrive : Infinity;
  const { step, div } = tr;
  const departIdx = Math.floor(depart / step);
  /** サンプル番号 i の次に調べる番号 */
  const nextIndex = (i: number): number => {
    const t = i * step;
    if (t + step > depart - 1e-9 && t < arrive) return i + 1; // 移動中（または次のサンプルまでに動き出す）
    const frameNext = (Math.floor(i / div) + 1) * div;
    return t < depart ? Math.max(i + 1, Math.min(frameNext, departIdx)) : frameNext;
  };
  // 到着の瞬間からは安全（垂直避難）なので、調べるのはその直前まで
  const end = Math.min(limit, safeFrom - 1e-3);
  for (;;) {
    const t = tr.next * step;
    if (t > end + 1e-9) break;
    const { pos, d } = depthOf(t);
    if (d >= DEPTH_CRITICAL_M) {
      record(tr.prev, t, pos, d);
      return;
    }
    tr.prev = t;
    tr.next = nextIndex(tr.next);
  }
  // 最後に調べた時刻と end の間（end がサンプル時刻でない場合）。next は進めないので、次回もサンプル時刻の格子のまま続く
  if (tr.prev >= 0 && end > tr.prev + 1e-9) {
    const { pos, d } = depthOf(end);
    if (d >= DEPTH_CRITICAL_M) {
      record(tr.prev, end, pos, d);
      return;
    }
  }
  tr.until = limit >= safeFrom ? Infinity : limit;
}

/**
 * 時刻 t までに「生命の危険」（浸水深 ≥ DEPTH_CRITICAL_M）に遭遇していれば、その時刻・位置・深さ。
 * 計算結果のフレームが増えると、増えた範囲だけ追加で調べる。
 */
export function criticalEncounter(
  person: Person,
  plan: EvacPlan | undefined,
  output: SimOutput | null,
  t: number,
): CriticalHit | null {
  if (!output || output.framesReady() <= 0) return null;
  const tr = getTrack(person, plan, output);
  extendTrack(tr, output, person, plan, t);
  return tr.hit && tr.hit.t <= t ? tr.hit : null;
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

function isShelterKind(kind: string): boolean {
  return kind === 'evac-site' || kind === 'tsunami-building';
}

/**
 * 「生命の危険」に遭遇したときの説明。閾値を超えた時刻と、その閾値（内閣府の被害想定で、巻き込まれた場合の
 * 死者率を100%と仮定する浸水深）を示す。計算上の判定であり、実際の生死を予測するものではない。
 */
function criticalMessage(hit: CriticalHit): string {
  return `生命の危険：地震発生から ${formatElapsed(hit.t)} に、浸水深 ${formatDepth(DEPTH_CRITICAL_M)} 以上の津波に巻き込まれました（計算上）`;
}

function depthMessage(depth: number): { status: PersonStatus; message: string } {
  const th = classifyDepth(depth);
  if (!th) return { status: 'caution', message: '' };
  return { status: th.status, message: `浸水深 ${formatDepth(depth)}：${th.description}` };
}

/**
 * 時刻 t [秒] の人物の状態。grid・output が null でも動作する（地盤高は NaN、浸水深は 0）。
 *
 * - 避難開始前: waiting（その場にとどまる人も waiting）
 * - 移動中で浸水なし: evacuating
 * - 目的地に到着: safe（避難場所・津波避難ビルは上階等への垂直避難を想定し、周囲が浸水しても safe）
 * - 浸水あり: 浸水深により caution / danger / critical（DEPTH_THRESHOLDS）
 * - 一度でも critical になったら、その時刻の位置で critical のまま（sticky）
 */
export function personStateAt(
  person: Person,
  plan: EvacPlan | undefined,
  grid: TerrainGrid | null,
  output: SimOutput | null,
  t: number,
): PersonState {
  const usePlan = plan && plan.personId === person.id ? plan : undefined;
  const hit = criticalEncounter(person, usePlan, output, t);
  if (hit) {
    return {
      lon: hit.lon,
      lat: hit.lat,
      ground: groundAt(grid, hit.lon, hit.lat),
      depth: depthAtPosition(output, hit.lon, hit.lat, t),
      status: 'critical',
      message: criticalMessage(hit),
    };
  }

  const pos = positionAt(person, usePlan, t);
  const ground = groundAt(grid, pos.lon, pos.lat);
  const depth = depthAtPosition(output, pos.lon, pos.lat, t);
  const base = { lon: pos.lon, lat: pos.lat, ground, depth };
  const wet = depth >= DEPTH_CAUTION_M;

  if (pos.phase === 'arrived' && usePlan?.target) {
    const target = usePlan.target;
    const arrived = `避難完了：${target.name}（到着 ${formatElapsed(usePlan.arriveAt ?? t)}）`;
    if (isShelterKind(target.kind)) {
      const note = wet ? `。周囲の浸水深 ${formatDepth(depth)}（建物の上階など高い所へ避難している想定）` : '';
      return { ...base, status: 'safe', message: arrived + note };
    }
    if (!wet) return { ...base, status: 'safe', message: arrived };
    const dm = depthMessage(depth);
    return { ...base, status: dm.status, message: `目的地の高台も浸水：${dm.message}` };
  }

  if (wet) {
    // critical（≥ DEPTH_CRITICAL_M）は上の criticalEncounter が必ず先に捉えるので、ここは caution / danger
    return { ...base, ...depthMessage(depth) };
  }

  if (pos.phase === 'static') {
    if (person.evacMode === 'stay') return { ...base, status: 'waiting', message: 'その場にとどまっています' };
    if (usePlan && usePlan.arriveAt === 0) return { ...base, status: 'safe', message: usePlan.target?.name ?? '安全な場所にいます' };
    return {
      ...base,
      status: 'waiting',
      message: usePlan ? '避難先が見つからないため、その場にとどまっています' : '避難経路を計算しています',
    };
  }
  if (pos.phase === 'before') {
    const dep = usePlan ? usePlan.path[0].t : departureSec(person);
    return { ...base, status: 'waiting', message: `避難開始前（地震発生から ${formatElapsed(dep)} に避難開始の想定）` };
  }
  // 移動中
  const remain = Math.max(0, (usePlan?.distanceM ?? 0) - pos.traveled);
  const eta = usePlan?.arriveAt ?? t;
  return {
    ...base,
    status: 'evacuating',
    message: `避難中：${usePlan?.target?.name ?? '目的地'}まで残り約 ${formatDistance(remain)}（到着予定 ${formatElapsed(eta)}）`,
  };
}

export interface TimelinePoint {
  /** 地震発生からの時刻 [秒] */
  t: number;
  /** 浸水深 [m] */
  depth: number;
  status: PersonStatus;
}

/**
 * グラフ用の時系列。stepSec ごとに personStateAt を評価する。
 * 終了時刻は endSec（省略時: 計算結果があれば計算済みの最終時刻、なければ到着時刻 + 5分）。
 */
export function personTimeline(
  person: Person,
  plan: EvacPlan | undefined,
  grid: TerrainGrid | null,
  output: SimOutput | null,
  stepSec = 20,
  endSec?: number,
): TimelinePoint[] {
  const step = Number.isFinite(stepSec) && stepSec > 0 ? stepSec : 20;
  let end = endSec;
  if (end === undefined || !Number.isFinite(end)) {
    if (output && output.framesReady() > 0) end = Math.min(output.durationSec, output.timeReady());
    else end = Math.max(plan?.arriveAt ?? 0, departureSec(person)) + 300;
  }
  const out: TimelinePoint[] = [];
  const n = Math.floor(end / step + 1e-9);
  for (let i = 0; i <= n; i++) {
    const t = i * step;
    const s = personStateAt(person, plan, grid, output, t);
    out.push({ t, depth: s.depth, status: s.status });
  }
  if (out.length === 0 || out[out.length - 1].t < end - 1e-9) {
    const s = personStateAt(person, plan, grid, output, end);
    out.push({ t: end, depth: s.depth, status: s.status });
  }
  return out;
}
