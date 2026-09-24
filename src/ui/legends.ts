/** 凡例（浸水深・到達時間）。レイヤータブと情報タブで共用。 */
import { ARRIVAL_CLASSES, DEPTH_CLASSES } from '../data/sources';
import { h } from './dom';
import { isSafeColor } from './format';

function swatchList(items: { label: string; color: string }[], cls: string): HTMLElement {
  return h(
    'ul',
    { class: `legend ${cls}` },
    items.map((it) =>
      h('li', null, h('span', { class: 'swatch', style: { background: isSafeColor(it.color) ? it.color : 'transparent' }, 'aria-hidden': 'true' }), h('span', null, it.label)),
    ),
  );
}

export function depthLegend(caption = '浸水深'): HTMLElement {
  return h(
    'figure',
    { class: 'legend-block' },
    h('figcaption', null, caption),
    swatchList(DEPTH_CLASSES.map((c) => ({ label: c.label, color: c.color })), 'legend-depth'),
  );
}

export function arrivalLegend(): HTMLElement {
  return h(
    'figure',
    { class: 'legend-block' },
    h('figcaption', null, '津波到達時間（地震発生から浸水が始まるまで）'),
    swatchList(ARRIVAL_CLASSES.map((c) => ({ label: c.label, color: c.color })), 'legend-arrival'),
  );
}
