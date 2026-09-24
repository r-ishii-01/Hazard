import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/main.css';
import { Store } from './core/store';
import { createController, createInitialState } from './core/controller';
import type { AppState } from './core/types';
import { MapView2D } from './map2d';
import { View3D } from './view3d';
import { mountUI } from './ui';

const store = new Store<AppState>(createInitialState());
const actions = createController(store);

const root = document.getElementById('app')!;
mountUI(root, store, actions);

const view2d = new MapView2D(document.getElementById('view-2d')!, store, actions);
let view3d: View3D | null = null;

store.select(
  (s) => s.view,
  (view) => {
    document.body.dataset.view = view;
    view2d.setActive(view === '2d');
    if (view === '3d' && !view3d) view3d = new View3D(document.getElementById('view-3d')!, store, actions);
    view3d?.setActive(view === '3d');
  },
  true,
);

// E2E テスト・デバッグ用フック
(window as unknown as { __app: unknown }).__app = { store, actions };
