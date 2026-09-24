/**
 * 時系列・配列の集計（純粋関数。DOM に依存しない）。
 */

/**
 * 時系列 (ts, vs) の先頭 count 個を使って時刻 t の値を線形補間する。
 * - t が最初の標本より前なら最初の値
 * - 最後の標本より後（未計算）なら NaN
 * - 片側が NaN（干出など）の場合は近い方の標本の値
 */
export function interpolateSeries(ts: ArrayLike<number>, vs: ArrayLike<number>, count: number, t: number): number {
  const n = Math.min(count, ts.length, vs.length);
  if (n <= 0 || !Number.isFinite(t)) return NaN;
  if (t <= ts[0]) return vs[0];
  const last = ts[n - 1];
  if (t > last) return t - last < 1e-6 ? vs[n - 1] : NaN;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = ts[lo];
  const t1 = ts[hi];
  const a = vs[lo];
  const b = vs[hi];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * f;
  return f < 0.5 ? a : b;
}

/** 先頭 count 個の最小・最大（NaN・無限大は無視）。値が無ければ null */
export function seriesExtent(vs: ArrayLike<number>, count = vs.length): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  const n = Math.min(count, vs.length);
  for (let i = 0; i < n; i++) {
    const v = vs[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? { min, max } : null;
}

export interface PathOptions {
  /** 横軸の範囲（時刻） */
  t0: number;
  t1: number;
  /** 縦軸の範囲（値） */
  yMin: number;
  yMax: number;
  width: number;
  height: number;
  /** 出力する最大の点数（超える場合は区間ごとの最小・最大を残して間引く） */
  maxPoints?: number;
}

/**
 * 折れ線の SVG パス文字列を作る。NaN の区間は線を切る。
 * 間引きは区間ごとの最小・最大を時刻順に残すので、ピーク（最大水位）が消えない。
 */
export function linePath(ts: ArrayLike<number>, vs: ArrayLike<number>, count: number, o: PathOptions): string {
  const n = Math.min(count, ts.length, vs.length);
  if (n === 0) return '';
  const spanT = o.t1 - o.t0 || 1;
  const spanY = o.yMax - o.yMin || 1;
  const X = (t: number) => ((t - o.t0) / spanT) * o.width;
  const Y = (v: number) => o.height - ((v - o.yMin) / spanY) * o.height;
  const maxPoints = Math.max(4, o.maxPoints ?? 600);

  const idx: number[] = [];
  if (n <= maxPoints) {
    for (let i = 0; i < n; i++) idx.push(i);
  } else {
    const buckets = Math.floor(maxPoints / 2);
    for (let b = 0; b < buckets; b++) {
      const s = Math.floor((b * n) / buckets);
      const e = Math.floor(((b + 1) * n) / buckets);
      let iMin = -1;
      let iMax = -1;
      let hasNaN = false;
      for (let i = s; i < e; i++) {
        const v = vs[i];
        if (!Number.isFinite(v)) {
          hasNaN = true;
          continue;
        }
        if (iMin < 0 || v < vs[iMin]) iMin = i;
        if (iMax < 0 || v > vs[iMax]) iMax = i;
      }
      if (iMin < 0) {
        idx.push(s); // 全て NaN の区間（線を切るため1点残す）
        continue;
      }
      if (hasNaN) idx.push(s);
      if (iMin === iMax) idx.push(iMin);
      else if (iMin < iMax) idx.push(iMin, iMax);
      else idx.push(iMax, iMin);
    }
  }

  let d = '';
  let pen = false;
  for (const i of idx) {
    const v = vs[i];
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${X(ts[i]).toFixed(1)} ${Y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** 目盛りの間隔を 1・2・5 × 10^k に丸める */
export function niceStep(range: number, targetTicks = 4): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const raw = range / Math.max(1, targetTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * pow;
}

/** 0 から max を覆う目盛り値（max を超える最初の目盛りまで） */
export function niceTicks(max: number, targetTicks = 4): number[] {
  const step = niceStep(max, targetTicks);
  const out: number[] = [];
  const top = Math.ceil(max / step - 1e-9) * step;
  for (let v = 0; v <= top + step * 1e-6; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** 時間軸の目盛り間隔 [秒]（表示幅に対しておおむね targetTicks 本） */
export function timeTickStep(durationSec: number, targetTicks = 6): number {
  const candidates = [60, 120, 300, 600, 900, 1200, 1800, 3600];
  for (const c of candidates) if (durationSec / c <= targetTicks) return c;
  return 3600;
}

export interface OutputSummary {
  /** 陸域で最初に浸水した時刻 [秒]（無ければ Infinity） */
  firstArrival: number;
  /** 陸域の最大浸水深 [m] */
  maxDepth: number;
  /** 浸水（≥ 0.01 m）したセル数 */
  floodedCells: number;
}

/** 到達時刻・最大浸水深の配列を集計する */
export function summarizeArrays(arrival: ArrayLike<number>, maxDepth: ArrayLike<number>, wetThreshold = 0.01): OutputSummary {
  let firstArrival = Infinity;
  for (let i = 0; i < arrival.length; i++) {
    const a = arrival[i];
    if (a < firstArrival && a >= 0) firstArrival = a;
  }
  let md = 0;
  let wet = 0;
  for (let i = 0; i < maxDepth.length; i++) {
    const d = maxDepth[i];
    if (d >= wetThreshold) {
      wet++;
      if (d > md) md = d;
    }
  }
  return { firstArrival, maxDepth: md, floodedCells: wet };
}

/**
 * people モジュールが公開する浸水深の閾値（形式は未確定）を、昇順の数値配列に正規化する。
 * 受け付ける形: number[] / { key: number } / [{ depth|min|value|threshold: number }]
 */
export function normalizeThresholds(raw: unknown): number[] {
  const out: number[] = [];
  const pick = (v: unknown) => {
    if (typeof v === 'number') {
      if (Number.isFinite(v) && v > 0) out.push(v);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const key of ['depth', 'min', 'value', 'threshold', 'm']) {
        if (typeof o[key] === 'number') {
          pick(o[key]);
          return;
        }
      }
    }
  };
  if (Array.isArray(raw)) raw.forEach(pick);
  else if (raw && typeof raw === 'object') Object.values(raw as Record<string, unknown>).forEach(pick);
  return [...new Set(out)].sort((a, b) => a - b);
}
