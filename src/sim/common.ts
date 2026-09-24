/**
 * メインスレッドとワーカーの両方で使う小さな関数（ソルバ本体に依存しない）。
 */

/** 数値が発散したときのメッセージ */
export const UNSTABLE_MESSAGE = '計算が不安定になりました（数値が発散しました）。解像度や条件を変えて再実行してください。';

/** 本計算中の進捗メッセージ */
export function progressMessage(tSec: number, bands: number): string {
  const minute = Math.floor(tSec / 60);
  return bands > 1 ? `計算中… 地震発生から ${minute}分（${bands}並列）` : `計算中… 地震発生から ${minute}分`;
}

/** 有限値の p パーセンタイル（0〜100）。値がなければ NaN */
export function percentile(values: ArrayLike<number>, p: number): number {
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) v.push(values[i]);
  if (v.length === 0) return NaN;
  v.sort((a, b) => a - b);
  const x = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1);
  const i0 = Math.floor(x);
  const i1 = Math.min(v.length - 1, i0 + 1);
  return v[i0] + (v[i1] - v[i0]) * (x - i0);
}

/** 校正区間の到達最大水位: 各セルの最大水位（NaN は除く）の 90 パーセンタイル。求まらなければ潮位 */
export function coastMaxFrom(maxEta: ArrayLike<number>, cells: ArrayLike<number>, tide: number): number {
  if (cells.length === 0) return tide;
  const v = new Float64Array(cells.length);
  for (let i = 0; i < cells.length; i++) v[i] = maxEta[cells[i]];
  const p = percentile(v, 90);
  return Number.isFinite(p) ? p : tide;
}
