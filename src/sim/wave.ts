/**
 * 沖側境界から入射させる津波の波形（潮位からの偏差 η_inc(t) [m]）。
 *
 * モデル化の仮定（近似）:
 * - 周期 T の正弦波列。第1波の初動は 'rise'（押し波）なら +、'fall'（引き波）なら −。
 * - 後続波は1周期ごとに DECAY_PER_WAVE 倍へ連続的（指数関数的）に減衰させる（包絡線に段差を作らない）。
 * - 波の数 waves 周期分だけ入力し、その後は 0。開始・終了とも sin の零点なので波形は連続。
 * 実際の津波波形（断層モデルによる）とは異なる、説明用の単純化であることに注意。
 */

/** 後続波の1波ごとの減衰率（モデル上の仮定） */
export const DECAY_PER_WAVE = 0.75;

export interface IncidentWaveSpec {
  /** 振幅係数 A [m]（包絡線の基準値。実際の第1波の山はこれよりわずかに小さい） */
  amplitude: number;
  /** 周期 [秒] */
  periodSec: number;
  /** 波の数（周期の数） */
  waves: number;
  /** 第1波の初動 */
  firstMotion: 'rise' | 'fall';
  /** 境界で波の入力を始める時刻 [秒]（地震発生から） */
  startSec: number;
  /** 1波ごとの減衰率（省略時 DECAY_PER_WAVE） */
  decay?: number;
}

export type WaveFn = (t: number) => number;

/** 入射波の関数を作る。戻り値 f(t) は地震発生から t 秒の境界での潮位偏差 [m] */
export function makeIncidentWave(spec: IncidentWaveSpec): WaveFn {
  const A = spec.amplitude;
  const T = spec.periodSec;
  const W = Math.max(1, Math.round(spec.waves));
  const t0 = spec.startSec;
  const sign = spec.firstMotion === 'fall' ? -1 : 1;
  const lnr = Math.log(clampDecay(spec.decay));
  const omega = (2 * Math.PI) / T;
  const end = W * T;
  if (!(Math.abs(A) > 0) || !(T > 0) || !Number.isFinite(t0)) return () => 0;
  return (t: number) => {
    const tau = t - t0;
    if (tau <= 0 || tau >= end) return 0;
    return sign * A * Math.sin(omega * tau) * Math.exp((lnr * tau) / T);
  };
}

/**
 * 入力開始から最初の「山」（押し波の極大）が境界を通過するまでの時間 [秒]。
 * sin(ωτ)·r^(τ/T) の極大は tan(ωτ) = −2π/ln r を満たす。
 */
export function firstCrestOffset(spec: Pick<IncidentWaveSpec, 'periodSec' | 'firstMotion' | 'decay'>): number {
  const lnr = Math.log(clampDecay(spec.decay));
  const phase = lnr < 0 ? Math.atan((-2 * Math.PI) / lnr) : Math.PI / 2; // (0, π/2]
  const base = spec.firstMotion === 'fall' ? Math.PI + phase : phase;
  return (base / (2 * Math.PI)) * spec.periodSec;
}

/** 最初の山での包絡線の値（A に対する比） */
export function firstCrestFactor(spec: Pick<IncidentWaveSpec, 'periodSec' | 'firstMotion' | 'decay'>): number {
  const tau = firstCrestOffset(spec);
  const lnr = Math.log(clampDecay(spec.decay));
  return Math.abs(Math.sin((2 * Math.PI * tau) / spec.periodSec)) * Math.exp((lnr * tau) / spec.periodSec);
}

function clampDecay(d: number | undefined): number {
  const v = d ?? DECAY_PER_WAVE;
  return v > 0.05 && v <= 1 ? v : DECAY_PER_WAVE;
}
