/**
 * ボトムシート（スマートフォン幅の操作パネル）のドラッグ操作の判定（純粋関数。DOM に依存しない）。
 *
 * シートの上端のつまみ（.sheet-handle）を指で上下に動かしたときの結果:
 * - 上へ: 広げる（すでに広げていれば何もしない）
 * - 下へ: 広げていれば元の高さに戻す（シートの高さの半分以上動かしたら閉じる）。広げていなければ閉じる
 * 少しだけ動かした場合（しきい値未満で、すばやく払ってもいない）は元に戻す。
 */

/** これ以上動かしたら操作とみなす [px] */
export const SHEET_DRAG_THRESHOLD_PX = 48;
/** これより小さい動きはドラッグではない（タップ） [px] */
export const SHEET_DRAG_SLOP_PX = 8;
/** すばやく払った（フリック）とみなす速さ [px/ms] */
export const SHEET_FLICK_PX_PER_MS = 0.5;

export type SheetDragOutcome = 'expand' | 'shrink' | 'close' | 'none';

/**
 * 指を離したときの結果。
 * @param dy 動かした量 [px]（下向きが正）
 * @param velocity 離す直前の速さ [px/ms]（下向きが正）
 * @param expanded シートを広げているか
 * @param sheetHeight シートの高さ [px]
 */
export function sheetDragOutcome(dy: number, velocity: number, expanded: boolean, sheetHeight: number): SheetDragOutcome {
  if (!Number.isFinite(dy) || Math.abs(dy) < SHEET_DRAG_SLOP_PX) return 'none';
  const v = Number.isFinite(velocity) ? velocity : 0;
  const flick = Math.abs(v) >= SHEET_FLICK_PX_PER_MS && Math.sign(v) === Math.sign(dy);
  if (Math.abs(dy) < SHEET_DRAG_THRESHOLD_PX && !flick) return 'none';
  if (dy < 0) return expanded ? 'none' : 'expand';
  if (!expanded) return 'close';
  return Number.isFinite(sheetHeight) && sheetHeight > 0 && dy >= sheetHeight / 2 ? 'close' : 'shrink';
}

/**
 * ドラッグ中にシートをどれだけ動かして見せるか [px]。
 * 下へは指に合わせて動かし、上へはわずかに（抵抗があるように）動かす。
 */
export function sheetDragOffset(dy: number): number {
  if (!Number.isFinite(dy)) return 0;
  return dy >= 0 ? dy : Math.max(-24, dy * 0.25);
}
