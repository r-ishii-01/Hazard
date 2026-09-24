/** 2D 地図ビュー（MapLibre GL JS）。［スタブ: map2d 担当が実装］ */
import type { AppStore } from '../core/store';
import type { AppActions } from '../core/controller';

export class MapView2D {
  constructor(_container: HTMLElement, _store: AppStore, _actions: AppActions) {}
  setActive(_active: boolean): void {}
  destroy(): void {}
}
