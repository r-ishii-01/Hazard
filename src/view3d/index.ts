/** 3D ビュー（three.js）。［スタブ: view3d 担当が実装］ */
import type { AppStore } from '../core/store';
import type { AppActions } from '../core/controller';

export class View3D {
  constructor(_container: HTMLElement, _store: AppStore, _actions: AppActions) {}
  setActive(_active: boolean): void {}
  destroy(): void {}
}
