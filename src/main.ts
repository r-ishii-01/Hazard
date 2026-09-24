import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/main.css';
import { Store } from './core/store';
import { createController, createInitialState } from './core/controller';
import type { AppState } from './core/types';
import { MapView2D } from './map2d';
import type { View3D } from './view3d';
import { mountUI } from './ui';

const store = new Store<AppState>(createInitialState());
const actions = createController(store);

const root = document.getElementById('app')!;
mountUI(root, store, actions);

const view2d = new MapView2D(document.getElementById('view-2d')!, store, actions);

// ---------------------------------------------------------------------------
// 3D ビュー: three.js は大きいので、初めて 3D に切り替えた時に読み込む（コード分割）
// ---------------------------------------------------------------------------
const view3dEl = document.getElementById('view-3d')!;
let view3d: View3D | null = null;
let loading3d: Promise<void> | null = null;

/** 3D の読み込み中・失敗の表示（#view-3d の中に重ねる） */
const status3d = document.createElement('div');
status3d.className = 'view-status';
status3d.setAttribute('role', 'status');
status3d.hidden = true;
view3dEl.appendChild(status3d);

function showStatus3d(kind: 'loading' | 'error' | null, detail?: string): void {
  status3d.hidden = kind === null;
  status3d.dataset.kind = kind ?? '';
  status3d.replaceChildren();
  if (kind === 'loading') {
    const spin = document.createElement('span');
    spin.className = 'spinner';
    spin.setAttribute('aria-hidden', 'true');
    status3d.append(spin, '3D表示を準備しています…');
  } else if (kind === 'error') {
    const msg = document.createElement('p');
    msg.textContent = '3D表示を読み込めませんでした。通信状態を確認して、もう一度お試しください。';
    const small = document.createElement('p');
    small.className = 'view-status-detail';
    small.textContent = detail ?? '';
    small.hidden = !detail;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-primary btn-sm';
    retry.textContent = '再試行';
    retry.addEventListener('click', () => ensure3d());
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-secondary btn-sm';
    back.textContent = '2D 地図に戻る';
    back.addEventListener('click', () => actions.setView('2d'));
    const row = document.createElement('div');
    row.className = 'view-status-actions';
    row.append(retry, back);
    status3d.append(msg, small, row);
  }
}

function loadView3dModule(): Promise<typeof import('./view3d')> {
  return import('./view3d');
}

function ensure3d(): void {
  if (view3d || loading3d) return;
  showStatus3d('loading');
  loading3d = loadView3dModule()
    .then((m) => {
      view3d = new m.View3D(view3dEl, store, actions);
      showStatus3d(null);
      view3d.setActive(store.get().view === '3d');
    })
    .catch((e: unknown) => {
      console.error('[main] 3D 表示の読み込みに失敗しました', e);
      showStatus3d('error', e instanceof Error ? e.message : String(e));
    })
    .finally(() => {
      loading3d = null;
    });
}

store.select(
  (s) => s.view,
  (view) => {
    document.body.dataset.view = view;
    view2d.setActive(view === '2d');
    if (view === '3d') ensure3d();
    view3d?.setActive(view === '3d');
  },
  true,
);

// 3D ボタンにポインターやフォーカスが来たら、先に読み込みを始めておく（切り替えを速く）
const prefetch3d = () => {
  loadView3dModule().catch(() => {
    /* 失敗は切り替え時に表示する */
  });
};
const btn3d = document.querySelector<HTMLElement>('#app-header [data-view="3d"]');
btn3d?.addEventListener('pointerenter', prefetch3d, { once: true });
btn3d?.addEventListener('focus', prefetch3d, { once: true });

// E2E テスト・デバッグ用フック
(window as unknown as { __app: unknown }).__app = { store, actions };
