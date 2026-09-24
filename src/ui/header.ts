/** ヘッダー: タイトル、2D/3D 切り替え、「ご利用にあたって」ボタン。 */
import type { ViewMode } from '../core/types';
import type { UIContext } from './context';
import { h } from './dom';
import { icon } from './icons';

export function mountHeader(el: HTMLElement, ctx: UIContext): void {
  const { store, actions } = ctx;
  const views: { v: ViewMode; label: string; name: 'map' | 'cube' }[] = [
    { v: '2d', label: '2D', name: 'map' },
    { v: '3d', label: '3D', name: 'cube' },
  ];
  const buttons = views.map(({ v, label, name }) =>
    h(
      'button',
      { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', dataset: { view: v }, 'aria-label': v === '2d' ? '2D 地図で表示' : '3D で表示', onclick: () => actions.setView(v) },
      icon(name, 16),
      h('span', null, label),
    ),
  );
  ctx.scope.add(
    store.select((s) => s.view, (view) => {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    }, true),
  );

  el.replaceChildren(
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('wave', 22)),
      h(
        'div',
        { class: 'brand-text' },
        h('h1', { class: 'brand-title' }, '鵠沼海岸 津波シミュレーター'),
        h('p', { class: 'brand-sub' }, '神奈川県藤沢市・鵠沼海岸周辺'),
      ),
      h('span', { class: 'brand-pill' }, '学習用の簡易計算'),
    ),
    h(
      'div',
      { class: 'header-actions' },
      h('div', { class: 'seg', role: 'group', 'aria-label': '表示の切り替え' }, buttons),
      h(
        'button',
        { type: 'button', class: 'header-btn', 'aria-label': 'ご利用にあたって（注意事項）', title: 'ご利用にあたって', onclick: () => ctx.openDisclaimer() },
        icon('help', 18),
        h('span', { class: 'header-btn-label' }, 'ご利用にあたって'),
      ),
    ),
  );
}
