/**
 * キーボード操作:
 * - Space: 再生／一時停止（入力欄やボタンにフォーカスがある時は、その要素の操作を優先）
 * - ← / →: 10 秒戻る／進む（Shift で 60 秒）
 * - Esc: 人物の配置モードを終了
 */
import type { UIContext } from './context';
import { isEditableTarget } from './dom';

/** 矢印キーを独自に使う要素（タブ、ラジオ、スライダー、地図） */
const ARROW_OWNERS = '[role="tab"], [role="tablist"], [role="radiogroup"], input, select, textarea, [role="slider"], .view, .maplibregl-canvas, canvas';
const SPACE_OWNERS = 'button, a[href], summary, input, select, textarea, [role="tab"], [role="button"], [contenteditable="true"]';

export function mountKeys(ctx: UIContext): void {
  const { store, actions } = ctx;
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.querySelector('dialog[open]')) return;
    const target = e.target instanceof Element ? e.target : null;

    if (e.key === 'Escape') {
      if (store.get().placing) {
        actions.startPlacing(null);
        e.preventDefault();
      }
      return;
    }
    if (isEditableTarget(target)) return;

    if (e.key === ' ' || e.code === 'Space') {
      if (target?.closest(SPACE_OWNERS)) return;
      e.preventDefault();
      actions.togglePlay();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (target?.closest(ARROW_OWNERS)) return;
      e.preventDefault();
      const step = (e.shiftKey ? 60 : 10) * (e.key === 'ArrowLeft' ? -1 : 1);
      const s = store.get();
      const out = s.sim.output;
      const limit = out ? Math.max(0, ctx.watcher.snap.timeReady) : Infinity;
      actions.seek(Math.min(limit, s.time.t + step));
    }
  };
  document.addEventListener('keydown', onKey);
  ctx.scope.add(() => document.removeEventListener('keydown', onKey));
}
