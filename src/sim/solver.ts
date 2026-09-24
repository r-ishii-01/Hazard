/**
 * 非線形長波（浅水）方程式の差分ソルバ（TUNAMI-N2 方式に準拠した実装）。
 *
 * 参考:
 * - Imamura, F., Yalciner, A. C., Ozyurt, G. (2006) "Tsunami Modelling Manual (TUNAMI model)"
 *   https://www.tsunami.irides.tohoku.ac.jp/media/files/_u/project/manual-ver-3_1.pdf
 * - Goto, C., Ogawa, Y., Shuto, N., Imamura, F. (1997) "Numerical method of tsunami simulation with the
 *   leap-frog scheme", IOC Manuals and Guides No.35, UNESCO
 *   http://www.jodc.go.jp/info/ioc_doc/Manual/122367eb.pdf
 * - 国土交通省「津波浸水想定の設定の手引き Ver.2.11」（2023年4月。非線形長波理論、海域の粗度係数 0.025 など）
 *   https://www.mlit.go.jp/sogoseisaku/point/content/001621078.pdf
 * - 境界条件: Flather, R. A. (1976) の放射条件（外部から与える水位・流量との差を √(gh) で外へ逃がす）。
 *
 * 支配方程式（x: 東向き、y: j 増加方向 = 南向き）:
 *   ∂η/∂t + ∂M/∂x + ∂N/∂y = 0
 *   ∂M/∂t + ∂(M²/D)/∂x + ∂(MN/D)/∂y + gD ∂η/∂x + g n² M √(M²+N²) / D^(7/3) = 0
 *   ∂N/∂t + ∂(MN/D)/∂x + ∂(N²/D)/∂y + gD ∂η/∂y + g n² N √(M²+N²) / D^(7/3) = 0
 *   η: 水位 [m, T.P.]、z: 地盤高 [m, T.P.]、D = η − z: 全水深、M, N: 線流量 [m²/s]
 *
 * 格子と符号:
 * - η はセル中心（k = j*nx + i、j=0 が北端）。
 * - M は各行 nx+1 個の縦の面（面 i はセル i−1 と i の境、添字 j*(nx+1)+i）。東向きが正。
 * - N は各列 ny+1 個の横の面（面 j はセル (i,j−1) と (i,j) の境、添字 j*nx+i）。
 *   **j 増加方向（南向き）が正**（北向きの流れは N < 0）。セル k の北の面は N[k]、南の面は N[k+nx]。
 *
 * 差分:
 * - リープフロッグ（η と M,N を半ステップずらして交互に更新）。
 * - 移流項は1次風上差分（TUNAMI-N2 と同じく、M·N の交差項は面の周囲4点平均の N̄/M̄ を用いる）。
 * - 底面摩擦（マニング則）は半陰的: M^{n+1}(1 + Δt g n² |Q^n| / D^{7/3}) = M^n − Δt(圧力項 + 移流項)。
 * - 遡上（移動境界）: 面の全水深を D_face = max(η_L, η_R) − max(z_L, z_R) とし、D_face ≤ DRY_DEPTH の面は流量 0。
 *   乾燥セルでは η = z（+ごく薄い水膜）なので、湿潤側の水位が乾燥側の地盤より高いときだけ流れる
 *   （TUNAMI の先端条件と同じ）。静水時の水位勾配は厳密に 0 になる（静水保存性）。
 * - 質量保存: 各セルから1ステップに流出する量が保有水量を超えないよう、流出側の流量を縮小する
 *   （流量は面ごとに一意なので、この操作で質量は変わらない）。負の水深は作らない。
 * - 安定化: 流速を |u| ≤ velocityCap に制限。
 * - 時間刻み: CFL 条件。c = √(g(h_max + 波高)) と流速上限に対してクーラン数 COURANT（2次元リープフロッグの
 *   線形安定限界 1/√2 ≈ 0.71 に余裕を持たせた値）。
 * - 計算範囲: 一度でも濡れたセルを含む 8 セル幅のブロックの近傍だけを行ごとの区間として計算する
 *   （乾いた陸は計算しない。範囲は単調に広がるだけなので、範囲外の面の流量は常に 0）。
 *
 * 境界条件（外周の面）:
 * - 陸（または浅すぎる海）に接する面は壁（流量 0）。
 * - 海に接する面は Flather 型の放射条件: 外向き流量 q = c (η' − a·η_inc(t − τ))、c = √(g h)、η' = η − 潮位。
 *   南端: a = 2（入射波 η_inc の流量 −c·η_inc を含む）、東西端: 南端からの伝播遅れ τ と Green 則で補正した入射波、
 *   北端: a = 0（純粋な放射）。反射波は外へ抜ける。
 */
import { CELL_SEA } from '../core/types';
import type { WaveFn } from './wave';

export const GRAVITY = 9.81;
/** 乾湿判定の水深 [m] */
export const DRY_DEPTH = 1e-3;
/** 移流項を評価する最小水深 [m]（これより浅い面は線形の式。TUNAMI と同様の先端付近の安定化） */
export const ADVECTION_MIN_DEPTH = 1e-2;
/** 流速の上限 [m/s]（先端付近の安定化） */
export const VELOCITY_CAP = 20;
/** 到達（浸水開始）とみなす水深 [m] */
export const ARRIVAL_DEPTH = 0.01;
/** クーラン数 */
export const COURANT = 0.6;
/** 開境界にする最小の静水深 [m] */
export const OPEN_BOUNDARY_MIN_DEPTH = 0.1;
/** 海域の粗度が与えられないときの既定値（外洋・沿岸の標準的な値 0.025） */
export const DEFAULT_SEA_MANNING = 0.025;

export interface SolverGrid {
  nx: number;
  ny: number;
  /** セル辺長 [m] */
  dx: number;
  /** 地盤高 [m, T.P.] */
  z: ArrayLike<number>;
  /** セル種別（CELL_SEA 以外は陸として扱う） */
  kind: ArrayLike<number>;
  /** 海域のマニング粗度 */
  manning: ArrayLike<number>;
}

export interface OpenEdges {
  north: boolean;
  south: boolean;
  east: boolean;
  west: boolean;
}

/**
 * 東西端の開境界に与える入射波の条件（行ごと）。
 * delay: 南端から各行のセル中心までの長波の伝播時間 [秒]、a: 入射波に掛ける係数（Green 則の増幅率。0 は入射なし）。
 */
export interface SideProfile {
  delay: Float64Array;
  a: Float64Array;
}

/**
 * 東西端の列に沿って、南端から北へ伝播時間と Green 則の増幅率 (h_南端 / h)^(1/4) を積算する。
 * 途中に陸（または浅すぎる海）があれば、それより北は入射なし（純粋な放射条件）とする。
 */
export function sideBoundaryProfile(grid: SolverGrid, tide: number, isEast: boolean, southOpen = true): SideProfile {
  const { nx, ny, dx } = grid;
  const ic = isEast ? nx - 1 : 0;
  const delay = new Float64Array(ny);
  const a = new Float64Array(ny);
  const stillDepth = (k: number) => (grid.kind[k] === CELL_SEA ? tide - Number(grid.z[k]) : -1);
  let tau = 0;
  let cPrev = 0;
  let connected = southOpen;
  const hSouth = Math.max(0.5, stillDepth((ny - 1) * nx + ic));
  for (let j = ny - 1; j >= 0; j--) {
    const h = stillDepth(j * nx + ic);
    if (h < OPEN_BOUNDARY_MIN_DEPTH) {
      connected = false;
      continue;
    }
    const c = Math.sqrt(GRAVITY * Math.max(0.5, h));
    tau += j === ny - 1 ? (0.5 * dx) / c : (0.5 * dx) / cPrev + (0.5 * dx) / c;
    cPrev = c;
    delay[j] = tau;
    a[j] = connected ? Math.min(2.5, Math.max(0.5, Math.pow(hSouth / Math.max(0.5, h), 0.25))) : 0;
  }
  return { delay, a };
}

/**
 * 初期状態（t = 0）で水のあるセル。潮位より低い海セルに加えて、潮位より低い陸のうち
 * 潮位より低いセルだけを通って海とつながっているもの（干潟・岩礁・河口の砂州などの潮間帯）も
 * その潮位では水面下にあるので水域として扱う。海とつながらない低地（堤防の内側など）は乾いたまま。
 * 並列計算では全体の格子で求めたものを各帯に渡す（つながりが帯の外を通る場合があるため）。
 */
export function initialWaterMask(grid: Pick<SolverGrid, 'nx' | 'ny' | 'z' | 'kind'>, tide: number): Uint8Array {
  const { nx, ny } = grid;
  const n = nx * ny;
  const wet = new Uint8Array(n);
  const stack: number[] = [];
  for (let k = 0; k < n; k++) {
    if (grid.kind[k] === CELL_SEA && grid.z[k] < tide) {
      wet[k] = 1;
      stack.push(k);
    }
  }
  const visit = (kk: number) => {
    if (wet[kk] === 0 && grid.kind[kk] !== CELL_SEA && grid.z[kk] < tide) {
      wet[kk] = 1;
      stack.push(kk);
    }
  };
  while (stack.length > 0) {
    const k = stack.pop()!;
    const j = (k / nx) | 0;
    const i = k - j * nx;
    if (i > 0) visit(k - 1);
    if (i < nx - 1) visit(k + 1);
    if (j > 0) visit(k - nx);
    if (j < ny - 1) visit(k + nx);
  }
  return wet;
}

export interface SolverOptions {
  /** 潮位 [m, T.P.]（初期の静水面） */
  tide: number;
  /** 陸域のマニング粗度 */
  landManning: number;
  /** 時間刻み [秒] */
  dt: number;
  /** 開始時刻 [秒]（既定 0） */
  t0?: number;
  /** 入射波（潮位偏差 [m]） */
  incident?: WaveFn | null;
  /** 開境界にする辺（既定: すべて。海セルに接する面だけが開境界になる） */
  open?: Partial<OpenEdges>;
  velocityCap?: number;
  /**
   * 東西端の入射条件（この格子の行ごと）。省略時はこの格子から sideBoundaryProfile で求める。
   * 領域を行の帯に分けて並列計算するときは、全体の格子で求めた値の該当行を渡す。
   */
  sides?: { west: SideProfile; east: SideProfile };
  /** 初期に水のあるセル（省略時はこの格子から initialWaterMask で求める） */
  initialWater?: Uint8Array;
}

/** CFL 条件から安定な時間刻みを求める（クーラン数 COURANT） */
export function stableTimeStep(dx: number, maxStillDepth: number, waveHeight: number, velocityCap = VELOCITY_CAP): number {
  const c = Math.sqrt(GRAVITY * Math.max(0.5, maxStillDepth + Math.max(0, waveHeight)));
  return (COURANT * dx) / Math.max(c, velocityCap);
}

/** 静水深の最大値 [m]（海セルのみ） */
export function maxStillDepth(grid: Pick<SolverGrid, 'z' | 'kind'>, tide: number): number {
  let h = 0;
  const { z, kind } = grid;
  for (let k = 0; k < z.length; k++) {
    if (kind[k] === CELL_SEA) {
      const d = tide - z[k];
      if (d > h) h = d;
    }
  }
  return h;
}

// D^(1/3) を2段の等間隔表で線形補間する（Math.cbrt / Math.pow は内側のループでは遅いため）。
// 0.0625〜2 m は 1/4096 m 刻み、2〜258 m は 1/16 m 刻みで相対誤差 < 1e-5。それ以外（薄い水膜など、まれ）は Math.cbrt。
const CBRT_A_MIN = 0.0625;
const CBRT_A_MAX = 2;
const CBRT_A_SCALE = 4096;
const CBRT_B_SCALE = 16;
const CBRT_B_MAX = CBRT_A_MAX + 256;
const CBRT_A = new Float64Array(CBRT_A_MAX * CBRT_A_SCALE + 2);
const CBRT_B = new Float64Array((CBRT_B_MAX - CBRT_A_MAX) * CBRT_B_SCALE + 2);
for (let i = 0; i < CBRT_A.length; i++) CBRT_A[i] = Math.cbrt(i / CBRT_A_SCALE);
for (let i = 0; i < CBRT_B.length; i++) CBRT_B[i] = Math.cbrt(CBRT_A_MAX + i / CBRT_B_SCALE);

/** D^(7/3)（D > 0） */
export function pow73(d: number): number {
  let c: number;
  if (d < CBRT_A_MIN) c = Math.cbrt(d);
  else if (d < CBRT_A_MAX) {
    const x = d * CBRT_A_SCALE;
    const j = x | 0;
    const t = CBRT_A[j];
    c = t + (CBRT_A[j + 1] - t) * (x - j);
  } else if (d < CBRT_B_MAX) {
    const x = (d - CBRT_A_MAX) * CBRT_B_SCALE;
    const j = x | 0;
    const t = CBRT_B[j];
    c = t + (CBRT_B[j + 1] - t) * (x - j);
  } else c = Math.cbrt(d);
  return d * d * c;
}

/** 計算範囲を管理するブロックの幅 [セル] */
const BLOCK_SHIFT = 3;
const BLOCK = 1 << BLOCK_SHIFT;

export class ShallowWaterSolver {
  readonly nx: number;
  readonly ny: number;
  readonly n: number;
  readonly dx: number;
  readonly dt: number;
  readonly tide: number;
  /** 現在時刻 [秒] */
  t: number;
  steps = 0;
  incident: WaveFn | null;

  /** 地盤高 [m, T.P.] */
  readonly z: Float64Array;
  /** 水位 [m, T.P.]（乾燥セルでは z とほぼ等しい） */
  readonly eta: Float64Array;
  /** セルのマニング粗度の2乗 */
  readonly nsq: Float64Array;
  /** 陸セル（種別が海以外）なら 1 */
  readonly isLand: Uint8Array;
  /** 初期（t = 0）に乾燥しているセルなら 1（最大浸水深・到達時刻を記録する対象） */
  readonly initiallyDry: Uint8Array;
  /** 最大水位（一度も濡れていないセルは −∞） */
  readonly maxEta: Float32Array;
  /** 最大全水深 [m]（全セル。初期に水のあるセルは出力時に 0 にする） */
  readonly maxDepth: Float32Array;
  /** 浸水開始時刻 [秒]（初期に乾燥したセル: 未浸水 +∞、それ以外: −∞） */
  readonly arrival: Float32Array;

  private m0: Float64Array;
  private m1: Float64Array;
  private n0: Float64Array;
  private n1: Float64Array;
  private readonly uCap: number;

  // ---- 計算範囲（一度でも濡れたブロックの近傍だけを計算する。範囲は単調に広がる） ----
  /** ブロック列数 */
  private readonly nb: number;
  /** 一度でも濡れたセルを含むブロック（行 × ブロック列） */
  private readonly wetBlock: Uint8Array;
  /** 1行あたりの区間数の上限 */
  private readonly maxRuns: number;
  /** 連続式・運動方程式を計算する区間（濡れたブロックを前後1行・左右1セル広げた範囲）[lo, hi] の組 */
  private readonly coreRuns: Int32Array;
  private readonly coreCount: Int32Array;
  /** ラインバッファを計算する区間（前後2行・左右3セル広げた範囲） */
  private readonly wideRuns: Int32Array;
  private readonly wideCount: Int32Array;
  private dirtyLo: number;
  private dirtyHi: number;

  // 運動方程式用の3行分のラインバッファ（面の全水深、M²/D、M·N̄/D、N̄ など）。L1 キャッシュに収まる大きさ
  private readonly bDfM: Float64Array;
  private readonly bFM: Float64Array;
  private readonly bGM: Float64Array;
  private readonly bNbM: Float64Array;
  private readonly bDfN: Float64Array;
  private readonly bFN: Float64Array;
  private readonly bGN: Float64Array;
  private readonly bMbN: Float64Array;

  // 開境界（外周の面）
  private readonly bCount: number;
  private readonly bFace: Int32Array;
  private readonly bCell: Int32Array;
  private readonly bIsM: Uint8Array;
  private readonly bSign: Float64Array;
  private readonly bC: Float64Array;
  private readonly bA: Float64Array;
  private readonly bDelay: Float64Array;
  private readonly bHmin: Float64Array;

  constructor(grid: SolverGrid, opts: SolverOptions) {
    const { nx, ny, dx } = grid;
    if (!(nx > 2 && ny > 2 && dx > 0)) throw new Error('計算格子の大きさが不正です');
    const n = nx * ny;
    if (grid.z.length !== n || grid.kind.length !== n) throw new Error('地形データの大きさが格子と一致しません');
    if (!(opts.dt > 0)) throw new Error('時間刻みが不正です');
    this.nx = nx;
    this.ny = ny;
    this.n = n;
    this.dx = dx;
    this.dt = opts.dt;
    this.tide = opts.tide;
    this.t = opts.t0 ?? 0;
    this.incident = opts.incident ?? null;
    this.uCap = opts.velocityCap ?? VELOCITY_CAP;
    const tide = opts.tide;

    this.z = new Float64Array(n);
    this.eta = new Float64Array(n);
    this.nsq = new Float64Array(n);
    this.isLand = new Uint8Array(n);
    this.initiallyDry = new Uint8Array(n);
    const water = opts.initialWater ?? initialWaterMask(grid, tide);
    if (water.length !== n) throw new Error('初期の水域の大きさが格子と一致しません');
    this.maxEta = new Float32Array(n);
    this.maxDepth = new Float32Array(n);
    this.arrival = new Float32Array(n);
    this.nb = Math.ceil(nx / BLOCK);
    this.wetBlock = new Uint8Array(ny * this.nb);
    this.maxRuns = Math.ceil(this.nb / 2) + 1;
    this.coreRuns = new Int32Array(ny * this.maxRuns * 2);
    this.coreCount = new Int32Array(ny);
    this.wideRuns = new Int32Array(ny * this.maxRuns * 2);
    this.wideCount = new Int32Array(ny);
    const landN2 = opts.landManning > 0 ? opts.landManning * opts.landManning : DEFAULT_SEA_MANNING ** 2;

    for (let k = 0; k < n; k++) {
      let zk = Number(grid.z[k]);
      if (!Number.isFinite(zk)) zk = 0;
      this.z[k] = zk;
      const land = grid.kind[k] !== CELL_SEA;
      this.isLand[k] = land ? 1 : 0;
      // 初期状態: 水域（海と、海につながる潮位以下の土地）は潮位で静止、それ以外は乾燥
      // （潮位より高い海セル＝上流の河床など も乾燥として扱い、浸水の記録の対象にする）
      const wet = water[k] === 1 && zk < tide;
      const dry0 = !wet;
      this.initiallyDry[k] = dry0 ? 1 : 0;
      this.eta[k] = wet ? tide : zk;
      const wetDeep = wet && tide - zk > DRY_DEPTH;
      this.maxEta[k] = wetDeep ? tide : -Infinity;
      this.arrival[k] = dry0 ? Infinity : -Infinity;
      if (land) this.nsq[k] = landN2;
      else {
        const m = Number(grid.manning[k]);
        this.nsq[k] = m > 0 && m < 1 ? m * m : DEFAULT_SEA_MANNING ** 2;
      }
      if (wetDeep) {
        const j = (k / nx) | 0;
        this.wetBlock[j * this.nb + ((k - j * nx) >> BLOCK_SHIFT)] = 1;
      }
    }
    this.dirtyLo = 0;
    this.dirtyHi = ny - 1;
    this.rebuildRuns();

    this.m0 = new Float64Array((nx + 1) * ny);
    this.m1 = new Float64Array((nx + 1) * ny);
    this.n0 = new Float64Array(nx * (ny + 1));
    this.n1 = new Float64Array(nx * (ny + 1));
    this.bDfM = new Float64Array(3 * (nx + 1));
    this.bFM = new Float64Array(3 * (nx + 1));
    this.bGM = new Float64Array(3 * (nx + 1));
    this.bNbM = new Float64Array(3 * (nx + 1));
    this.bDfN = new Float64Array(3 * nx);
    this.bFN = new Float64Array(3 * nx);
    this.bGN = new Float64Array(3 * nx);
    this.bMbN = new Float64Array(3 * nx);

    // ---- 開境界 ----
    const open: OpenEdges = { north: true, south: true, east: true, west: true, ...opts.open };
    const faces: { face: number; cell: number; isM: boolean; sign: number; h: number; a: number; delay: number }[] = [];
    const stillDepth = (k: number) => (grid.kind[k] === CELL_SEA ? tide - this.z[k] : -1);
    if (open.south) {
      for (let i = 0; i < nx; i++) {
        const k = (ny - 1) * nx + i;
        const h = stillDepth(k);
        if (h >= OPEN_BOUNDARY_MIN_DEPTH) faces.push({ face: ny * nx + i, cell: k, isM: false, sign: 1, h, a: 2, delay: 0 });
      }
    }
    if (open.north) {
      for (let i = 0; i < nx; i++) {
        const h = stillDepth(i);
        if (h >= OPEN_BOUNDARY_MIN_DEPTH) faces.push({ face: i, cell: i, isM: false, sign: -1, h, a: 0, delay: 0 });
      }
    }
    const side = (isEast: boolean) => {
      const prof = opts.sides ? (isEast ? opts.sides.east : opts.sides.west) : sideBoundaryProfile(grid, tide, isEast, open.south);
      const ic = isEast ? nx - 1 : 0;
      for (let j = ny - 1; j >= 0; j--) {
        const k = j * nx + ic;
        const h = stillDepth(k);
        if (h < OPEN_BOUNDARY_MIN_DEPTH) continue;
        faces.push({
          face: j * (nx + 1) + (isEast ? nx : 0),
          cell: k,
          isM: true,
          sign: isEast ? 1 : -1,
          h,
          a: prof.a[j],
          delay: prof.delay[j],
        });
      }
    };
    if (open.west) side(false);
    if (open.east) side(true);
    const bc = faces.length;
    this.bCount = bc;
    this.bFace = new Int32Array(bc);
    this.bCell = new Int32Array(bc);
    this.bIsM = new Uint8Array(bc);
    this.bSign = new Float64Array(bc);
    this.bC = new Float64Array(bc);
    this.bA = new Float64Array(bc);
    this.bDelay = new Float64Array(bc);
    this.bHmin = new Float64Array(bc);
    faces.forEach((f, b) => {
      this.bFace[b] = f.face;
      this.bCell[b] = f.cell;
      this.bIsM[b] = f.isM ? 1 : 0;
      this.bSign[b] = f.sign;
      this.bC[b] = Math.sqrt(GRAVITY * f.h);
      this.bA[b] = f.a;
      this.bDelay[b] = f.delay;
      this.bHmin[b] = Math.max(DRY_DEPTH, 0.1 * f.h);
    });
  }

  /** 現在の東西方向の線流量（面 j*(nx+1)+i、東向き正） */
  get M(): Float64Array {
    return this.m0;
  }
  /** 現在の南北方向の線流量（面 j*nx+i、南向き正） */
  get N(): Float64Array {
    return this.n0;
  }
  /** 開境界の面の数 */
  get openBoundaryFaces(): number {
    return this.bCount;
  }

  depth(k: number): number {
    const d = this.eta[k] - this.z[k];
    return d > 0 ? d : 0;
  }

  /** 総水量 [m³] */
  totalVolume(): number {
    let s = 0;
    const { eta, z } = this;
    for (let k = 0; k < this.n; k++) s += eta[k] - z[k];
    return s * this.dx * this.dx;
  }

  /** 計算対象になっているセル数（性能評価用） */
  activeCells(): number {
    let c = 0;
    for (let j = 0; j < this.ny; j++) {
      const base = j * this.maxRuns * 2;
      for (let r = 0; r < this.coreCount[j]; r++) c += this.coreRuns[base + 2 * r + 1] - this.coreRuns[base + 2 * r] + 1;
    }
    return c;
  }

  /**
   * 現在の状態が静止（どの面にも流れが生じない）かどうか。
   * 潮位より低い陸セルが海に接していると、そこへ水が流れ込むので静止ではない。
   */
  isAtRest(): boolean {
    const { nx, ny, eta, z, m0, n0 } = this;
    for (let f = 0; f < m0.length; f++) if (m0[f] !== 0) return false;
    for (let f = 0; f < n0.length; f++) if (n0[f] !== 0) return false;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (i + 1 < nx && !faceQuiet(eta[k], eta[k + 1], z[k], z[k + 1])) return false;
        if (j + 1 < ny && !faceQuiet(eta[k], eta[k + nx], z[k], z[k + nx])) return false;
      }
    }
    return true;
  }

  /** 1ステップ進める */
  step(): void {
    const tNew = this.t + this.dt;
    this.continuity(tNew);
    if (this.dirtyHi >= 0) this.rebuildRuns();
    this.applyBoundaries(tNew);
    this.momentumAndLimit();
    let tmp = this.m0;
    this.m0 = this.m1;
    this.m1 = tmp;
    tmp = this.n0;
    this.n0 = this.n1;
    this.n1 = tmp;
    this.t = tNew;
    this.steps++;
  }

  // ---- 計算範囲の管理 ----

  /** セル (i, j) が初めて濡れたブロックに入ったとき、周囲の行の区間を作り直す */
  private activate(j: number, i: number): void {
    this.wetBlock[j * this.nb + (i >> BLOCK_SHIFT)] = 1;
    if (j - 2 < this.dirtyLo) this.dirtyLo = Math.max(0, j - 2);
    if (j + 2 > this.dirtyHi) this.dirtyHi = Math.min(this.ny - 1, j + 2);
  }

  private rebuildRuns(): void {
    for (let j = this.dirtyLo; j <= this.dirtyHi; j++) {
      this.buildRuns(j, 1, 1, this.coreRuns, this.coreCount);
      this.buildRuns(j, 2, 3, this.wideRuns, this.wideCount);
    }
    this.dirtyLo = this.ny;
    this.dirtyHi = -1;
  }

  /** 行 j の区間: 行 j±rows のいずれかで濡れたブロックを連結し、両端を extra セル広げる（重なれば結合） */
  private buildRuns(j: number, rows: number, extra: number, runs: Int32Array, count: Int32Array): void {
    const { nb, nx, ny, wetBlock } = this;
    const base = j * this.maxRuns * 2;
    let c = 0;
    let open = -1;
    const j0 = Math.max(0, j - rows);
    const j1 = Math.min(ny - 1, j + rows);
    for (let b = 0; b <= nb; b++) {
      let act = false;
      if (b < nb) for (let r = j0; r <= j1 && !act; r++) act = wetBlock[r * nb + b] === 1;
      if (act && open < 0) open = b;
      else if (!act && open >= 0) {
        const lo = Math.max(0, open * BLOCK - extra);
        const hi = Math.min(nx - 1, b * BLOCK - 1 + extra);
        if (c > 0 && lo <= runs[base + 2 * c - 1] + 1) runs[base + 2 * c - 1] = hi;
        else {
          runs[base + 2 * c] = lo;
          runs[base + 2 * c + 1] = hi;
          c++;
        }
        open = -1;
      }
    }
    count[j] = c;
  }

  // ---- 差分計算 ----

  /** 連続式（水位の更新）と最大値・到達時刻の記録（毎ステップ。記録の手間は濡れたセルだけなのでわずか） */
  private continuity(tNew: number): void {
    const { nx, ny, nb, eta, z, m0, n0, coreRuns, coreCount, wetBlock, maxEta, maxDepth, arrival } = this;
    const r = this.dt / this.dx;
    const stride = this.maxRuns * 2;
    for (let j = 0; j < ny; j++) {
      const cnt = coreCount[j];
      const base = j * stride;
      const rowK = j * nx;
      const rowB = j * nb;
      for (let q = 0; q < cnt; q++) {
        const lo = coreRuns[base + 2 * q];
        const hi = coreRuns[base + 2 * q + 1];
        let mw = m0[rowK + lo + j];
        for (let i = lo; i <= hi; i++) {
          const k = rowK + i;
          const me = m0[k + j + 1];
          const zk = z[k];
          let e = eta[k] - r * (me - mw + n0[k + nx] - n0[k]);
          mw = me;
          // 流出制限により負の水深は生じない（丸め誤差程度の負値のみ 0 にする）
          if (e < zk) e = zk;
          eta[k] = e;
          const d = e - zk;
          if (d > DRY_DEPTH) {
            if (wetBlock[rowB + (i >> BLOCK_SHIFT)] === 0) this.activate(j, i);
            if (e > maxEta[k]) maxEta[k] = e;
            if (d > maxDepth[k]) maxDepth[k] = d;
            if (d >= ARRIVAL_DEPTH && arrival[k] > tNew) arrival[k] = tNew;
          }
        }
      }
    }
  }

  /**
   * x・y 両方向の運動方程式（行ごとにまとめ、面の量は3行分のラインバッファで使い回す）と、
   * 1行遅れの流出制限（行 j の N を求めた時点で、行 j−1 のセルの4面の流量が確定している）。
   */
  private momentumAndLimit(): void {
    const ny = this.ny;
    this.bufferM(0);
    this.bufferN(0);
    for (let j = 0; j < ny; j++) {
      if (j + 1 < ny) this.bufferM(j + 1);
      this.bufferN(j + 1);
      this.momentumRowX(j);
      if (j >= 1) {
        this.momentumRowY(j);
        this.limitRow(j - 1);
      }
    }
    this.limitRow(ny - 1);
  }

  /** 行 r の M 面の量をバッファへ */
  private bufferM(r: number): void {
    const cnt = this.wideCount[r];
    if (cnt === 0) return;
    const { nx, eta, z, m0, n0, bDfM, bFM, bGM, bNbM, wideRuns } = this;
    const U = this.uCap;
    const nx1 = nx + 1;
    const slot = (r % 3) * nx1;
    const rowK = r * nx;
    const rowM = r * nx1;
    const base = r * this.maxRuns * 2;
    for (let q = 0; q < cnt; q++) {
      // 区間 [lo, hi] のセルの西の面 lo から東の面 hi+1 まで
      let i0 = wideRuns[base + 2 * q];
      let i1 = wideRuns[base + 2 * q + 1] + 1;
      if (i0 === 0) {
        edgeBuffer(m0[rowM], eta[rowK] - z[rowK], U, slot, bDfM, bFM, bGM, bNbM);
        i0 = 1;
      }
      if (i1 === nx) {
        const k = rowK + nx - 1;
        edgeBuffer(m0[rowM + nx], eta[k] - z[k], U, slot + nx, bDfM, bFM, bGM, bNbM);
        i1 = nx - 1;
      }
      // 左隣のセルの値は前の反復から持ち越す
      let eL = eta[rowK + i0 - 1];
      let zL = z[rowK + i0 - 1];
      let nL = n0[rowK + i0 - 1] + n0[rowK + i0 - 1 + nx];
      for (let i = i0; i <= i1; i++) {
        const kR = rowK + i;
        const eR = eta[kR];
        const zR = z[kR];
        const nR = n0[kR] + n0[kR + nx];
        const df = (eL > eR ? eL : eR) - (zL > zR ? zL : zR);
        const nsum = nL + nR;
        eL = eR;
        zL = zR;
        nL = nR;
        const s = slot + i;
        bDfM[s] = df;
        if (df > DRY_DEPTH) {
          const nb = 0.25 * nsum;
          bNbM[s] = nb;
          const m = m0[rowM + i];
          if (df > ADVECTION_MIN_DEPTH && m !== 0) {
            let u = m / df;
            if (u > U) u = U;
            else if (u < -U) u = -U;
            bFM[s] = m * u;
            bGM[s] = nb * u;
          } else {
            bFM[s] = 0;
            bGM[s] = 0;
          }
        } else {
          bNbM[s] = 0;
          bFM[s] = 0;
          bGM[s] = 0;
        }
      }
    }
  }

  /** 横の面の行 r（セル行 r−1 と r の境）の N 面の量をバッファへ */
  private bufferN(r: number): void {
    const { nx, ny } = this;
    const rr = r < ny ? r : ny - 1;
    const cnt = this.wideCount[rr];
    if (cnt === 0) return;
    const { eta, z, m0, n0, bDfN, bFN, bGN, bMbN, wideRuns } = this;
    const U = this.uCap;
    const slot = (r % 3) * nx;
    const rowN = r * nx;
    const base = rr * this.maxRuns * 2;
    const edge = r === 0 || r === ny;
    const kc = r === 0 ? 0 : (ny - 1) * nx;
    const offU = r - 1;
    for (let q = 0; q < cnt; q++) {
      const lo = wideRuns[base + 2 * q];
      const hi = wideRuns[base + 2 * q + 1];
      if (edge) {
        for (let i = lo; i <= hi; i++) edgeBuffer(n0[rowN + i], eta[kc + i] - z[kc + i], U, slot + i, bDfN, bFN, bGN, bMbN);
        continue;
      }
      // 西側の M 面（上下2セル分）の値は前の反復から持ち越す
      let mW = m0[rowN - nx + lo + offU] + m0[rowN + lo + r];
      for (let i = lo; i <= hi; i++) {
        const kD = rowN + i;
        const kU = kD - nx;
        const eU = eta[kU];
        const eD = eta[kD];
        const zU = z[kU];
        const zD = z[kD];
        const mE = m0[kU + offU + 1] + m0[kD + r + 1];
        const df = (eU > eD ? eU : eD) - (zU > zD ? zU : zD);
        const msum = mW + mE;
        mW = mE;
        const s = slot + i;
        bDfN[s] = df;
        if (df > DRY_DEPTH) {
          const mb = 0.25 * msum;
          bMbN[s] = mb;
          const v0 = n0[kD];
          if (df > ADVECTION_MIN_DEPTH && v0 !== 0) {
            let v = v0 / df;
            if (v > U) v = U;
            else if (v < -U) v = -U;
            bFN[s] = v0 * v;
            bGN[s] = mb * v;
          } else {
            bFN[s] = 0;
            bGN[s] = 0;
          }
        } else {
          bMbN[s] = 0;
          bFN[s] = 0;
          bGN[s] = 0;
        }
      }
    }
  }

  /** 行 j の M（東西方向）の更新 */
  private momentumRowX(j: number): void {
    const cnt = this.coreCount[j];
    if (cnt === 0) return;
    const { nx, ny, eta, nsq, m0, m1, bDfM, bFM, bGM, bNbM, coreRuns } = this;
    const nx1 = nx + 1;
    const dt = this.dt;
    const rdx = dt / this.dx;
    const gdtdx = GRAVITY * rdx;
    const hgdt = 0.5 * GRAVITY * dt;
    const U = this.uCap;
    const sC = (j % 3) * nx1;
    const sU = j > 0 ? ((j + 2) % 3) * nx1 : sC;
    const sD = j < ny - 1 ? ((j + 1) % 3) * nx1 : sC;
    const rowK = j * nx;
    const rowM = j * nx1;
    const base = j * this.maxRuns * 2;
    for (let q = 0; q < cnt; q++) {
      const lo = coreRuns[base + 2 * q];
      const hi = coreRuns[base + 2 * q + 1] + 1;
      const ia = lo < 1 ? 1 : lo;
      const ib = hi > nx - 1 ? nx - 1 : hi;
      let eL = eta[rowK + ia - 1];
      let nL = nsq[rowK + ia - 1];
      for (let i = ia; i <= ib; i++) {
        const s = sC + i;
        const f = rowM + i;
        const df = bDfM[s];
        const kR = rowK + i;
        const eR = eta[kR];
        const nR = nsq[kR];
        const grad = eR - eL;
        const nsum = nL + nR;
        eL = eR;
        nL = nR;
        if (df <= DRY_DEPTH) {
          m1[f] = 0;
          continue;
        }
        const m = m0[f];
        const nb = bNbM[s];
        let adv = 0;
        if (df > ADVECTION_MIN_DEPTH) {
          adv = m >= 0 ? bFM[s] - bFM[s - 1] : bFM[s + 1] - bFM[s];
          adv += nb >= 0 ? bGM[s] - bGM[sU + i] : bGM[sD + i] - bGM[s];
        }
        let v = m - gdtdx * df * grad - rdx * adv;
        const q2 = m * m + nb * nb;
        if (q2 > 0) {
          // 半陰的な摩擦: v / (1 + Δt g n² |Q| / D^(7/3))
          const d73 = pow73(df);
          v = (v * d73) / (d73 + hgdt * nsum * Math.sqrt(q2));
        }
        const cap = U * df;
        m1[f] = v > cap ? cap : v < -cap ? -cap : v;
      }
    }
  }

  /** 横の面の行 j（1..ny−1）の N（南向き正）の更新 */
  private momentumRowY(j: number): void {
    const cnt = this.coreCount[j];
    if (cnt === 0) return;
    const { nx, eta, nsq, n0, n1, bDfN, bFN, bGN, bMbN, coreRuns } = this;
    const dt = this.dt;
    const rdx = dt / this.dx;
    const gdtdx = GRAVITY * rdx;
    const hgdt = 0.5 * GRAVITY * dt;
    const U = this.uCap;
    const last = nx - 1;
    const sC = (j % 3) * nx;
    const sU = ((j + 2) % 3) * nx;
    const sD = ((j + 1) % 3) * nx;
    const rowN = j * nx;
    const base = j * this.maxRuns * 2;
    for (let q = 0; q < cnt; q++) {
      const lo = coreRuns[base + 2 * q];
      const hi = coreRuns[base + 2 * q + 1];
      for (let i = lo; i <= hi; i++) {
        const s = sC + i;
        const f = rowN + i;
        const df = bDfN[s];
        if (df <= DRY_DEPTH) {
          n1[f] = 0;
          continue;
        }
        const v0 = n0[f];
        const mb = bMbN[s];
        let adv = 0;
        if (df > ADVECTION_MIN_DEPTH) {
          adv = v0 >= 0 ? bFN[s] - bFN[sU + i] : bFN[sD + i] - bFN[s];
          if (mb >= 0) {
            if (i > 0) adv += bGN[s] - bGN[s - 1];
          } else if (i < last) adv += bGN[s + 1] - bGN[s];
        }
        let v = v0 - gdtdx * df * (eta[f] - eta[f - nx]) - rdx * adv;
        const q2 = v0 * v0 + mb * mb;
        if (q2 > 0) {
          const d73 = pow73(df);
          v = (v * d73) / (d73 + hgdt * (nsq[f] + nsq[f - nx]) * Math.sqrt(q2));
        }
        const cap = U * df;
        n1[f] = v > cap ? cap : v < -cap ? -cap : v;
      }
    }
  }

  /**
   * 行 j のセルの流出量が保有水量を超える場合、流出側の面の流量を一律に縮小する（質量保存・正値性）。
   * 流量は面ごとに一意なので、この操作で総水量は変わらない。
   */
  private limitRow(j: number): void {
    const cnt = this.coreCount[j];
    if (cnt === 0) return;
    const { nx, eta, z, m1, n1, coreRuns } = this;
    const cap = this.dx / this.dt;
    const rowK = j * nx;
    const base = j * this.maxRuns * 2;
    for (let q = 0; q < cnt; q++) {
      const lo = coreRuns[base + 2 * q];
      const hi = coreRuns[base + 2 * q + 1];
      for (let i = lo; i <= hi; i++) {
        const k = rowK + i;
        const fw = k + j;
        const mw = m1[fw];
        const me = m1[fw + 1];
        const nn = n1[k];
        const ns = n1[k + nx];
        let out = 0;
        if (me > 0) out += me;
        if (mw < 0) out -= mw;
        if (ns > 0) out += ns;
        if (nn < 0) out -= nn;
        if (out > 0) {
          const avail = (eta[k] - z[k]) * cap;
          if (out > avail) {
            // 丸め誤差で保有量を超えないよう、わずかに小さめに縮小する
            const s = avail > 0 ? (avail / out) * (1 - 1e-6) : 0;
            if (me > 0) m1[fw + 1] = me * s;
            if (mw < 0) m1[fw] = mw * s;
            if (ns > 0) n1[k + nx] = ns * s;
            if (nn < 0) n1[k] = nn * s;
          }
        }
      }
    }
  }

  /** 外周の開境界（Flather 型の放射条件＋入射波）。新しい流量の配列の外周の面に書く */
  private applyBoundaries(t: number): void {
    const { eta, z, m1, n1, bFace, bCell, bIsM, bSign, bC, bA, bDelay, bHmin } = this;
    const tide = this.tide;
    const inc = this.incident;
    const U = this.uCap;
    for (let b = 0; b < this.bCount; b++) {
      const k = bCell[b];
      const e = eta[k];
      let ext = 0;
      if (inc !== null && bA[b] !== 0) ext = bA[b] * inc(t - bDelay[b]);
      let q = bC[b] * (e - tide - ext);
      const d = e - z[k];
      const cap = U * (d > bHmin[b] ? d : bHmin[b]);
      if (q > cap) q = cap;
      else if (q < -cap) q = -cap;
      if (bIsM[b]) m1[bFace[b]] = bSign[b] * q;
      else n1[bFace[b]] = bSign[b] * q;
    }
  }

  // ---- 行の帯に分けた並列計算のための入出力 ----

  /** 行 r0..r1−1 の状態（水位・M・その行の北の面の N）を1本の配列に詰めるのに必要な長さ */
  haloLength(rows: number): number {
    return rows * (3 * this.nx + 1);
  }

  /** 行 r0..r0+rows−1 の状態を out に書き出す（隣の帯へ送る） */
  exportRows(r0: number, rows: number, out: Float64Array): void {
    const { nx, eta, m0, n0 } = this;
    let o = 0;
    out.set(eta.subarray(r0 * nx, (r0 + rows) * nx), o);
    o += rows * nx;
    out.set(m0.subarray(r0 * (nx + 1), (r0 + rows) * (nx + 1)), o);
    o += rows * (nx + 1);
    out.set(n0.subarray(r0 * nx, (r0 + rows) * nx), o);
  }

  /**
   * 隣の帯から受け取った行 r0..r0+rows−1 の状態で上書きする（のりしろの行）。
   * 濡れたセルの記録も更新し、計算範囲を作り直す。
   */
  importRows(r0: number, rows: number, data: Float64Array): void {
    const { nx, nb, eta, z, m0, n0, wetBlock } = this;
    let o = 0;
    eta.set(data.subarray(o, o + rows * nx), r0 * nx);
    o += rows * nx;
    m0.set(data.subarray(o, o + rows * (nx + 1)), r0 * (nx + 1));
    o += rows * (nx + 1);
    n0.set(data.subarray(o, o + rows * nx), r0 * nx);
    for (let j = r0; j < r0 + rows; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (eta[k] - z[k] > DRY_DEPTH && wetBlock[j * nb + (i >> BLOCK_SHIFT)] === 0) this.activate(j, i);
      }
    }
    if (this.dirtyHi >= 0) this.rebuildRuns();
  }

  /**
   * 行 r0..r1−1 の全水深を cm 単位の Uint16 に書き出す（フレーム）。
   * @returns 数値が発散（NaN/∞）していたら false
   */
  encodeRowsCm(r0: number, r1: number, out: Uint16Array): boolean {
    const { eta, z } = this;
    const k0 = r0 * this.nx;
    const k1 = r1 * this.nx;
    let ok = true;
    for (let k = k0; k < k1; k++) {
      const d = eta[k] - z[k];
      if (d > 0.005) {
        const v = Math.round(d * 100);
        out[k - k0] = v < 65535 ? v : 65535;
        if (v !== v || v === Infinity) ok = false;
      } else {
        out[k - k0] = 0;
        if (!(d === d)) ok = false;
      }
    }
    return ok;
  }

  /** 全水深を cm 単位の Uint16 に書き出す（フレーム）。数値が発散していたら false */
  encodeDepthCm(out: Uint16Array): boolean {
    return this.encodeRowsCm(0, this.ny, out);
  }

  /** 最大浸水深（初期に乾燥していたセルのみ。それ以外は 0）。行 r0..r1−1 を out の先頭から */
  copyMaxDepth(out: Float32Array, r0 = 0, r1 = this.ny): void {
    const { initiallyDry, maxDepth } = this;
    const k0 = r0 * this.nx;
    for (let k = k0; k < r1 * this.nx; k++) out[k - k0] = initiallyDry[k] ? maxDepth[k] : 0;
  }

  /** 最大水位（一度も濡れていないセルは NaN）。行 r0..r1−1 を out の先頭から */
  copyMaxEta(out: Float32Array, r0 = 0, r1 = this.ny): void {
    const { maxEta } = this;
    const k0 = r0 * this.nx;
    for (let k = k0; k < r1 * this.nx; k++) {
      const v = maxEta[k];
      out[k - k0] = v === -Infinity ? NaN : v;
    }
  }

  /** 浸水開始時刻（初期に乾燥していたセルのみ。未浸水・それ以外は +∞）。行 r0..r1−1 を out の先頭から */
  copyArrival(out: Float32Array, r0 = 0, r1 = this.ny): void {
    const { arrival } = this;
    const k0 = r0 * this.nx;
    for (let k = k0; k < r1 * this.nx; k++) {
      const v = arrival[k];
      out[k - k0] = v === -Infinity ? Infinity : v;
    }
  }
}

/** 静水状態でこの面に流れが生じないか */
function faceQuiet(eL: number, eR: number, zL: number, zR: number): boolean {
  if (eL === eR) return true;
  const df = (eL > eR ? eL : eR) - (zL > zR ? zL : zR);
  return df <= DRY_DEPTH;
}

/** 外周の面のバッファ値（片側のセルの水深を用いる。交差項は使わないので 0） */
function edgeBuffer(
  q: number,
  d: number,
  U: number,
  s: number,
  bDf: Float64Array,
  bF: Float64Array,
  bG: Float64Array,
  bBar: Float64Array,
): void {
  bDf[s] = d;
  bG[s] = 0;
  bBar[s] = 0;
  if (d > ADVECTION_MIN_DEPTH && q !== 0) {
    let u = q / d;
    if (u > U) u = U;
    else if (u < -U) u = -U;
    bF[s] = q * u;
  } else bF[s] = 0;
}
