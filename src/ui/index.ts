/**
 * 操作パネル・タイムライン・HUD（地図キャンバス以外の UI 全体）。
 *
 * mountUI(root, store, actions) は index.html の #app-header / #sidebar / #hud / #timeline を埋める。
 * 戻り値の関数でアンマウント（購読・イベントの解除）できる。
 */
import type { AppStore } from '../core/store';
import type { AppActions } from '../core/controller';
import { MOBILE_QUERY, OutputWatcher, type PlaceServices, type TabId, type UIContext } from './context';
import { createDisclaimer } from './disclaimer';
import { Scope, h } from './dom';
import { mountHeader } from './header';
import { mountHud } from './hud';
import { mountKeys } from './keys';
import { mountMapTools } from './mapTools';
import { createAddressBook } from './personAddress';
import { mountShake } from './shake';
import { mountSidebar, type TabBridge } from './sidebar';
import { mountTimeline } from './timeline';

export { MOBILE_QUERY };

/** 無ければ作る（index.html の構造が変わっても落ちないように） */
function ensure(root: HTMLElement, selector: string, create: () => HTMLElement, parent: HTMLElement = root): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found) return found;
  const el = create();
  parent.appendChild(el);
  return el;
}

export function mountUI(root: HTMLElement, store: AppStore, actions: AppActions): () => void {
  const scope = new Scope();
  const header = ensure(root, '#app-header', () => h('header', { id: 'app-header' }));
  const sidebar = ensure(root, '#sidebar', () => h('aside', { id: 'sidebar' }));
  const stage = ensure(root, '#stage', () => h('main', { id: 'stage' }));
  const hud = ensure(root, '#hud', () => h('div', { id: 'hud' }), stage);
  const timeline = ensure(root, '#timeline', () => h('footer', { id: 'timeline' }));

  // スクリーンリーダー向けの通知
  const live = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  root.appendChild(live);
  let announceTimer = 0;
  const announce = (message: string) => {
    live.textContent = '';
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => (live.textContent = message), 60);
  };
  scope.add(() => {
    window.clearTimeout(announceTimer);
    live.remove();
  });

  const mobile = window.matchMedia(MOBILE_QUERY);
  const disclaimer = createDisclaimer();
  scope.add(disclaimer.dispose);
  // 「ご利用にあたって」を確認したら、初回の自動計算を許可する（地形の準備ができ次第、既定のシナリオを再生）
  let mounted = true;
  scope.add(() => (mounted = false));
  disclaimer.whenAcknowledged(() => {
    if (mounted) actions.armAutoRun();
  });
  const watcher = new OutputWatcher(store, scope);

  const bridge: TabBridge = {
    isVisible: () => true,
    onShow: () => {},
    collapse: () => {},
    show: () => {},
  };
  // 地図の上の「場所を探す」ボタン（HUD の後に作る）が中身を差し込む
  const places: PlaceServices = {
    openSearch: () => {},
    locate: () => {},
    addresses: createAddressBook(store, scope),
  };
  const ctx: UIContext = {
    store,
    actions,
    scope,
    watcher,
    openDisclaimer: () => disclaimer.open(),
    panelVisible: (id: TabId) => bridge.isVisible(id),
    onPanelShow: (id: TabId, fn: () => void) => bridge.onShow(id, fn),
    announce,
    isMobile: () => mobile.matches,
    collapseSheet: () => bridge.collapse(),
    showPanel: (id: TabId) => bridge.show(id),
    places,
  };

  root.classList.add('ui-ready');
  hud.setAttribute('aria-label', '現在の状況');
  mountHeader(header, ctx);
  mountSidebar(sidebar, ctx, mobile, bridge);
  mountHud(hud, ctx);
  const tools = mountMapTools(hud, ctx);
  places.openSearch = tools.openSearch;
  places.locate = tools.locate;
  mountTimeline(timeline, ctx);
  mountShake(ctx, stage);
  mountKeys(ctx);

  return () => {
    scope.dispose();
    for (const el of [header, sidebar, hud, timeline]) el.replaceChildren();
    root.classList.remove('ui-ready');
  };
}
