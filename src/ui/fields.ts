/**
 * ストアと双方向に結びつく入力部品（スライダー＋数値、セレクト、ラジオ、スイッチ）。
 *
 * 方針:
 * - スライダーはドラッグ中は表示だけ更新し、確定（change）で 1 回だけ反映する
 *   （パラメータ変更のたびに避難計画の再計算などが走るため）。
 * - ストア側の値が変わったら、ユーザーが操作中でない限り表示を同期する。
 */
import type { AppState } from '../core/types';
import type { UIContext } from './context';
import { clamp } from './format';
import { h, uid } from './dom';

interface BaseFieldOptions<T> {
  label: string;
  hint?: string;
  get: (s: AppState) => T;
  commit: (v: T) => void;
}

export interface SliderFieldOptions extends BaseFieldOptions<number> {
  unit?: string;
  min: number;
  max: number;
  step: number;
  /** 数値欄の小数桁 */
  digits: number;
  /** 値に応じた補足（例: 粗度係数の目安） */
  describe?: (v: number) => string;
  /** スライダーのドラッグ中も即時に反映する（軽い処理のみ） */
  live?: boolean;
}

const roundTo = (v: number, step: number, min: number) => {
  const n = Math.round((v - min) / step);
  return Number((min + n * step).toFixed(6));
};

/** スライダー＋数値入力 */
export function sliderField(ctx: UIContext, o: SliderFieldOptions): HTMLElement {
  const id = uid('num');
  const num = h('input', { type: 'number', id, class: 'num-input', min: o.min, max: o.max, step: o.step, inputmode: 'decimal' });
  const range = h('input', { type: 'range', class: 'range', min: o.min, max: o.max, step: o.step, 'aria-label': o.label });
  const desc = o.describe ? h('p', { class: 'field-desc', 'aria-live': 'polite' }) : null;
  let dragging = false;

  const show = (v: number) => {
    num.value = v.toFixed(o.digits);
    range.value = String(v);
    range.style.setProperty('--fill', `${((v - o.min) / (o.max - o.min || 1)) * 100}%`);
    if (desc && o.describe) desc.textContent = o.describe(v);
  };
  const commit = (raw: number) => {
    const current = o.get(ctx.store.get());
    if (!Number.isFinite(raw)) {
      show(current);
      return;
    }
    const v = roundTo(clamp(raw, o.min, o.max), o.step, o.min);
    show(v);
    if (v !== current) o.commit(v);
  };

  range.addEventListener('pointerdown', () => (dragging = true));
  range.addEventListener('input', () => {
    const v = Number(range.value);
    show(v);
    if (o.live) commit(v);
  });
  range.addEventListener('change', () => {
    dragging = false;
    commit(Number(range.value));
  });
  range.addEventListener('pointerup', () => (dragging = false));
  num.addEventListener('change', () => commit(Number(num.value)));
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(Number(num.value));
  });

  ctx.scope.add(
    ctx.store.select(o.get, (v) => {
      if (dragging || document.activeElement === num) return;
      show(v);
    }, true),
  );

  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-row' }, h('label', { for: id, class: 'field-label' }, o.label), h('span', { class: 'field-value' }, num, o.unit ? h('span', { class: 'unit' }, o.unit) : null)),
    range,
    desc,
    o.hint ? h('p', { class: 'field-hint' }, o.hint) : null,
  );
}

export interface ChoiceOption<T extends string | number> {
  value: T;
  label: string;
  /** ラジオカードの補足 */
  sub?: string;
}

/** セレクトボックス */
export function selectField<T extends string | number>(ctx: UIContext, o: BaseFieldOptions<T> & { options: ChoiceOption<T>[] }): HTMLElement {
  const id = uid('sel');
  const sel = h('select', { id, class: 'select' }, o.options.map((op) => h('option', { value: String(op.value) }, op.label)));
  sel.addEventListener('change', () => {
    const op = o.options.find((x) => String(x.value) === sel.value);
    if (op) o.commit(op.value);
  });
  ctx.scope.add(ctx.store.select(o.get, (v) => (sel.value = String(v)), true));
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-row' }, h('label', { for: id, class: 'field-label' }, o.label), sel),
    o.hint ? h('p', { class: 'field-hint' }, o.hint) : null,
  );
}

/** ラジオボタンの横並び（セグメント）またはカード */
export function radioField<T extends string | number>(
  ctx: UIContext,
  o: BaseFieldOptions<T> & { options: ChoiceOption<T>[]; variant?: 'segmented' | 'cards' },
): HTMLElement {
  const name = uid('radio');
  const inputs = o.options.map((op) => {
    const input = h('input', { type: 'radio', name, value: String(op.value), class: 'visually-hidden-input' });
    input.addEventListener('change', () => {
      if (input.checked) o.commit(op.value);
    });
    return { op, input };
  });
  const variant = o.variant ?? 'segmented';
  const group = h(
    'div',
    { class: variant === 'cards' ? 'radio-cards' : 'segmented', role: 'presentation' },
    inputs.map(({ op, input }) =>
      h('label', { class: variant === 'cards' ? 'radio-card' : 'segmented-item' }, input, h('span', { class: 'radio-label' }, op.label), op.sub ? h('span', { class: 'radio-sub' }, op.sub) : null),
    ),
  );
  ctx.scope.add(
    ctx.store.select(o.get, (v) => {
      for (const { op, input } of inputs) input.checked = op.value === v;
    }, true),
  );
  return h('fieldset', { class: 'field fieldset' }, h('legend', { class: 'field-label' }, o.label), group, o.hint ? h('p', { class: 'field-hint' }, o.hint) : null);
}

/** オン／オフのスイッチ */
export function switchField(ctx: UIContext, o: BaseFieldOptions<boolean> & { extra?: HTMLElement }): HTMLElement {
  const id = uid('sw');
  const input = h('input', { type: 'checkbox', id, role: 'switch', class: 'switch-input' });
  input.addEventListener('change', () => o.commit(input.checked));
  ctx.scope.add(ctx.store.select(o.get, (v) => (input.checked = v), true));
  return h(
    'div',
    { class: 'switch-field' },
    h(
      'label',
      { for: id, class: 'switch-row' },
      h('span', { class: 'switch-text' }, h('span', { class: 'switch-label' }, o.label), o.hint ? h('span', { class: 'switch-hint' }, o.hint) : null),
      input,
      h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
    ),
    o.extra ?? null,
  );
}
