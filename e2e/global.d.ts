/**
 * E2E テストでページ内の状態を読むための型（src/main.ts が公開する window.__app など）。
 * page.evaluate / waitForFunction の中でのみ使う。
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { AppActions } from '../src/core/controller';
import type { AppStore } from '../src/core/store';

declare global {
  interface Window {
    /** src/main.ts: E2E テスト・デバッグ用フック */
    __app: { store: AppStore; actions: AppActions };
    /** src/map2d/index.ts: 開発サーバーでのみ公開 */
    __map2d?: { map: MapLibreMap };
  }
  interface HTMLElement {
    /** src/view3d/index.ts: 3D ビューの本体（#view-3d に付く） */
    __view3d?: { debugInfo(): Record<string, unknown> };
  }
}

export {};
