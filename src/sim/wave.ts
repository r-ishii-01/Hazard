/**
 * 沖側境界から入射させる津波の波形（潮位からの偏差 η_inc(t) [m]）。
 *
 * モデル化の仮定（近似）:
 * - 周期 T の正弦波列。第1波の初動は 'rise'（押し波）なら +、'fall'（引き波）なら −。
 * - 各波の大きさは次のどちらか。
 *   (a) amplitudes（各波の相対的な大きさ）を与えた場合: 第 i 波（τ = t − 開始時刻 が [iT, (i+1)T) の1周期）の振幅を
 *       A × amplitudes[i] / max(amplitudes) とする（最大の波の振幅が A）。波の境目は sin の零点なので波形は連続。
 *       波の数が amplitudes の長さより多い場合、足りない波は最後の値を繰り返す。
 *   (b) 与えない場合: 後続波を1周期ごとに decay（既定 DECAY_PER_WAVE）倍へ連続的（指数関数的）に減衰させる
 *       （包絡線に段差を作らない）。最大は第1波。
 * - 波の数 waves 周期分だけ入力し、その後は 0。開始・終了とも sin の零点なので波形は連続。
 * 実際の津波波形（断層モデルによる）とは異なる、説明用の単純化であることに注意。
 */

/** 後続波の1波ごとの減衰率（amplitudes を与えない場合のモデル上の仮定） */
export const DECAY_PER_WAVE = 0.75;

export interface IncidentWaveSpec {
  /** 振幅係数 A [m]（最大の波の包絡線の基準値。減衰させる場合の実際の第1波の山はこれよりわずかに小さい） */
  amplitude: number;
  /** 周期 [秒] */
  periodSec: number;
  /** 波の数（周期の数） */
  waves: number;
  /** 第1波の初動 */
  firstMotion: 'rise' | 'fall';
  /** 境界で波の入力を始める時刻 [秒]（地震発生から） */
  startSec: number;
  /** 1波ごとの減衰率（省略時 DECAY_PER_WAVE。amplitudes を与えた場合は使わない） */
  decay?: number;
  /** 各波の相対的な大きさ（最大を 1 とみなして正規化する）。省略時は decay で減衰 */
  amplitudes?: readonly number[];
}

export type WaveFn = (t: number) => number;

/**
 * 実際に使う各波の相対振幅（最大 = 1）。amplitudes が無効（空・正の有限値が無い）なら null。
 * 波の数が amplitudes より多い場合は最後の値を繰り返し、少ない場合は先頭から waves 個を使う。
 */
export function relativeAmplitudes(amplitudes: readonly number[] | undefined, waves: number): number[] | null {
  if (!amplitudes || amplitudes.length === 0) return null;
  const W = Math.max(1, Math.round(Number.isFinite(waves) ? waves : 1));
  const src = amplitudes.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const out: number[] = [];
  for (let i = 0; i < W; i++) out.push(src[Math.min(i, src.length - 1)]);
  const max = Math.max(...out);
  if (!(max > 0)) return null;
  return out.map((v) => v / max);
}

/** 入射波の関数を作る。戻り値 f(t) は地震発生から t 秒の境界での潮位偏差 [m] */
export function makeIncidentWave(spec: IncidentWaveSpec): WaveFn {
  const A = spec.amplitude;
  const T = spec.periodSec;
  const W = Math.max(1, Math.round(spec.waves));
  const t0 = spec.startSec;
  const sign = spec.firstMotion === 'fall' ? -1 : 1;
  const omega = (2 * Math.PI) / T;
  const end = W * T;
  if (!(Math.abs(A) > 0) || !(T > 0) || !Number.isFinite(t0)) return () => 0;
  const rel = relativeAmplitudes(spec.amplitudes, W);
  if (rel) {
    return (t: number) => {
      const tau = t - t0;
      if (tau <= 0 || tau >= end) return 0;
      const i = Math.min(W - 1, Math.floor(tau / T));
      return sign * A * rel[i] * Math.sin(omega * tau);
    };
  }
  const lnr = Math.log(clampDecay(spec.decay));
  return (t: number) => {
    const tau = t - t0;
    if (tau <= 0 || tau >= end) return 0;
    return sign * A * Math.sin(omega * tau) * Math.exp((lnr * tau) / T);
  };
}

/** 最大の波の番号（0 始まり。同じ大きさなら先の波）。減衰させる場合は 0 */
export function maxWaveIndex(spec: Pick<IncidentWaveSpec, 'waves' | 'amplitudes'>): number {
  const rel = relativeAmplitudes(spec.amplitudes, spec.waves);
  if (!rel) return 0;
  let best = 0;
  for (let i = 1; i < rel.length; i++) if (rel[i] > rel[best]) best = i;
  return best;
}

/**
 * 入力開始から最初の「山」（押し波の極大）が境界を通過するまでの時間 [秒]（減衰させる場合）。
 * sin(ωτ)·r^(τ/T) の極大は tan(ωτ) = −2π/ln r を満たす。amplitudes を与えた場合は各波の中で sin の極大（1/4 周期）。
 */
export function firstCrestOffset(
  spec: Pick<IncidentWaveSpec, 'periodSec' | 'firstMotion' | 'decay' | 'amplitudes'> & { waves?: number },
): number {
  // 相対振幅が有効なら（makeIncidentWave と同じ判定）各波は減衰しない正弦波
  const useAmps = relativeAmplitudes(spec.amplitudes, spec.waves ?? spec.amplitudes?.length ?? 1) !== null;
  const lnr = useAmps ? 0 : Math.log(clampDecay(spec.decay));
  const phase = lnr < 0 ? Math.atan((-2 * Math.PI) / lnr) : Math.PI / 2; // (0, π/2]
  const base = spec.firstMotion === 'fall' ? Math.PI + phase : phase;
  return (base / (2 * Math.PI)) * spec.periodSec;
}

/**
 * 入力開始から「最大の波」の山が境界を通過するまでの時間 [秒]。
 * 減衰させる場合（amplitudes なし）は第1波の山（firstCrestOffset と同じ）。
 */
export function maxCrestOffset(spec: Pick<IncidentWaveSpec, 'periodSec' | 'firstMotion' | 'decay' | 'amplitudes' | 'waves'>): number {
  const i = maxWaveIndex(spec);
  return firstCrestOffset(spec) + i * spec.periodSec;
}

/** 最初の山での包絡線の値（A に対する比） */
export function firstCrestFactor(
  spec: Pick<IncidentWaveSpec, 'periodSec' | 'firstMotion' | 'decay' | 'amplitudes'> & { waves?: number },
): number {
  const rel = relativeAmplitudes(spec.amplitudes, spec.waves ?? spec.amplitudes?.length ?? 1);
  if (rel) return rel[0];
  const tau = firstCrestOffset(spec);
  const lnr = Math.log(clampDecay(spec.decay));
  return Math.abs(Math.sin((2 * Math.PI * tau) / spec.periodSec)) * Math.exp((lnr * tau) / spec.periodSec);
}

function clampDecay(d: number | undefined): number {
  const v = d ?? DECAY_PER_WAVE;
  return v > 0.05 && v <= 1 ? v : DECAY_PER_WAVE;
}
