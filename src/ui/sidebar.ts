/**
 * サイドバー: 4 つのタブ。モバイル幅ではタブバーを画面下に置き、パネルはボトムシートとして開閉する。
 */
import type { TabId, UIContext } from './context';
import { h, setHidden, setText } from './dom';
import { sheetDragOffset, sheetDragOutcome } from './gestures';
import { icon, type IconName } from './icons';
import { createInfoPanel } from './panels/info';
import { createLayersPanel } from './panels/layers';
import { createPeoplePanel } from './panels/people';
import { createQuakePanel } from './panels/quake';

const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'quake', label: '地震・津波', icon: 'wave' },
  { id: 'people', label: '人物', icon: 'users' },
  { id: 'layers', label: 'レイヤー', icon: 'layers' },
  { id: 'info', label: '情報', icon: 'info' },
];

/** パネルの可視状態を UIContext に渡すための橋渡し（パネル生成前に中身が設定される） */
export interface TabBridge {
  isVisible(id: TabId): boolean;
  onShow(id: TabId, fn: () => void): void;
  collapse(): void;
  /** タブを表示する（モバイルではシートを開く） */
  show(id: TabId): void;
}

export function mountSidebar(el: HTMLElement, ctx: UIContext, mobile: MediaQueryList, bridge: TabBridge): void {
  const { store } = ctx;
  let active: TabId = 'quake';
  let open = false; // モバイルのシートが開いているか
  const showHandlers = new Map<TabId, (() => void)[]>();

  const tabButtons = new Map<TabId, HTMLButtonElement>();
  const panels = new Map<TabId, HTMLElement>();
  const badges = new Map<TabId, HTMLElement>();

  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': '操作パネル' });
  for (const t of TABS) {
    const badge = h('span', { class: 'tab-badge', hidden: true });
    badges.set(t.id, badge);
    const btn = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        id: `tab-${t.id}`,
        class: 'tab',
        'aria-controls': `panel-${t.id}`,
        'aria-selected': 'false',
        tabindex: '-1',
        onclick: () => {
          if (mobile.matches && open && active === t.id) setOpen(false);
          else activate(t.id, true);
        },
      },
      h('span', { class: 'tab-icon' }, icon(t.icon, 18)),
      h('span', { class: 'tab-label' }, t.label),
      badge,
    );
    tabButtons.set(t.id, btn);
    tablist.appendChild(btn);
  }
  tablist.addEventListener('keydown', (e) => {
    const idx = TABS.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    activate(TABS[next].id, true);
    tabButtons.get(TABS[next].id)?.focus();
  });

  const sheetTitle = h('span', { class: 'sheet-title' });
  const expandBtn = h('button', { type: 'button', class: 'icon-btn sheet-expand', 'aria-label': 'パネルを広げる', 'aria-expanded': 'false' }, icon('chevronUp', 18));
  const setExpanded = (expanded: boolean) => {
    el.classList.toggle('is-expanded', expanded);
    expandBtn.setAttribute('aria-label', expanded ? 'パネルを縮める' : 'パネルを広げる');
    expandBtn.setAttribute('aria-expanded', String(expanded));
  };
  expandBtn.addEventListener('click', () => setExpanded(!el.classList.contains('is-expanded')));
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'パネルを閉じる', onclick: () => setOpen(false) }, icon('close', 18));
  const handle = h('div', { class: 'sheet-handle' }, h('span', { class: 'grip', 'aria-hidden': 'true' }), sheetTitle, expandBtn, closeBtn);
  const panelBox = h('div', { class: 'tab-panels' });
  const sheet = h('div', { class: 'sheet' }, handle, panelBox);

  // ---- つまみ（シートの上端）のドラッグ: 上へ動かすと広げる、下へ動かすと縮める・閉じる（gestures.ts） ----------
  // ボタン（広げる・閉じる）はそのまま使える。ドラッグはスマートフォン幅でシートが開いているときだけ
  let drag: { id: number; y0: number; lastY: number; lastT: number; v: number } | null = null;
  handle.addEventListener('pointerdown', (e) => {
    if (!mobile.matches || !open || drag) return;
    if ((e.target as Element | null)?.closest('button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { id: e.pointerId, y0: e.clientY, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* 取り込めなくてもドラッグはできる */
    }
    sheet.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dt = Math.max(1, e.timeStamp - drag.lastT);
    // 速さは直近の動きを重く見る（フリックの判定用）
    drag.v = drag.v * 0.3 + ((e.clientY - drag.lastY) / dt) * 0.7;
    drag.lastY = e.clientY;
    drag.lastT = e.timeStamp;
    sheet.style.transform = `translateY(${sheetDragOffset(e.clientY - drag.y0)}px)`;
  });
  const endDrag = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    const dy = e.clientY - d.y0;
    // 指を止めてから離した場合は、払ったとはみなさない
    const v = e.timeStamp - d.lastT > 120 ? 0 : d.v;
    const outcome = cancelled ? 'none' : sheetDragOutcome(dy, v, el.classList.contains('is-expanded'), sheet.getBoundingClientRect().height);
    sheet.classList.remove('is-dragging');
    sheet.style.transform = '';
    if (outcome === 'expand') setExpanded(true);
    else if (outcome === 'shrink') setExpanded(false);
    else if (outcome === 'close') setOpen(false);
  };
  handle.addEventListener('pointerup', (e) => endDrag(e, false));
  handle.addEventListener('pointercancel', (e) => endDrag(e, true));

  el.replaceChildren(tablist, sheet);

  const isVisible = (id: TabId) => active === id && (!mobile.matches || open);
  bridge.isVisible = isVisible;
  bridge.onShow = (id, fn) => {
    const list = showHandlers.get(id) ?? [];
    list.push(fn);
    showHandlers.set(id, list);
  };
  bridge.collapse = () => {
    if (mobile.matches) setOpen(false);
  };
  bridge.show = (id) => activate(id, true);

  // パネルの中身（タブ切り替え時の再生成はしない）
  const factories: Record<TabId, (c: UIContext) => HTMLElement> = {
    quake: createQuakePanel,
    people: createPeoplePanel,
    layers: createLayersPanel,
    info: createInfoPanel,
  };
  for (const t of TABS) {
    const panel = h('div', { role: 'tabpanel', id: `panel-${t.id}`, class: 'tab-panel', 'aria-labelledby': `tab-${t.id}`, tabindex: '0', hidden: true });
    panels.set(t.id, panel);
    panelBox.appendChild(panel);
  }
  // 可視判定に使うので、パネルの DOM を作ってから中身を入れる
  for (const t of TABS) panels.get(t.id)!.appendChild(factories[t.id](ctx));

  const fireShow = (id: TabId) => {
    if (!isVisible(id)) return;
    for (const fn of showHandlers.get(id) ?? []) {
      try {
        fn();
      } catch (e) {
        console.error('[ui] panel show handler failed', e);
      }
    }
  };

  const render = () => {
    for (const t of TABS) {
      const on = t.id === active;
      const btn = tabButtons.get(t.id)!;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      setHidden(panels.get(t.id)!, !on);
    }
    el.dataset.sheet = open ? 'open' : 'closed';
    setText(sheetTitle, TABS.find((t) => t.id === active)?.label ?? '');
  };

  function setOpen(v: boolean) {
    if (open === v) return;
    open = v;
    if (!v) setExpanded(false);
    render();
    if (v) fireShow(active);
  }

  // タブごとのスクロール位置を覚えておく（パネルは同じスクロール領域を共有するため）
  const scrollPos = new Map<TabId, number>();
  function activate(id: TabId, openSheet = false) {
    const changed = id !== active;
    if (changed) scrollPos.set(active, panelBox.scrollTop);
    active = id;
    if (openSheet) open = true;
    render();
    if (changed) panelBox.scrollTop = scrollPos.get(id) ?? 0;
    if (changed || openSheet) fireShow(id);
  }

  // バッジ: 人物の数、計算中
  ctx.scope.add(
    store.select((s) => s.people.length, (n) => {
      const b = badges.get('people')!;
      b.textContent = String(n);
      setHidden(b, n === 0);
    }, true),
  );
  ctx.scope.add(
    store.select((s) => s.sim.status === 'running', (running) => {
      const b = badges.get('quake')!;
      b.textContent = '';
      b.classList.toggle('is-dot', true);
      setHidden(b, !running);
    }, true),
  );

  const onMedia = () => {
    render();
    fireShow(active);
  };
  mobile.addEventListener('change', onMedia);
  ctx.scope.add(() => mobile.removeEventListener('change', onMedia));

  render();
}
