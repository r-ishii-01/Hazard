/**
 * 小さな状態ストア。
 *
 * - `store.get()` で現在の状態（読み取り専用として扱う）
 * - `store.set(partial)` または `store.update(fn)` で浅いマージ更新
 * - `store.select(selector, listener)` は選択値が変わった時だけ呼ばれる（=== 比較）
 *
 * 大きな配列（地形・計算結果）は参照のまま保持する。更新時は新しいオブジェクトを入れること
 * （ミューテーションしても購読者には通知されない）。
 */
import type { AppState } from './types';

export type Listener<T> = (value: T, prev: T) => void;

export class Store<S extends object> {
  private state: S;
  private listeners = new Set<(s: S, prev: S) => void>();

  constructor(initial: S) {
    this.state = initial;
  }

  get(): S {
    return this.state;
  }

  set(partial: Partial<S>): void {
    const prev = this.state;
    this.state = { ...prev, ...partial };
    this.emit(prev);
  }

  update(fn: (s: S) => Partial<S>): void {
    this.set(fn(this.state));
  }

  /** 状態全体の変更を購読。戻り値で解除 */
  subscribe(fn: (s: S, prev: S) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 選択値の変更を購読。immediate=true なら登録時に一度呼ぶ */
  select<T>(selector: (s: S) => T, listener: Listener<T>, immediate = false): () => void {
    let current = selector(this.state);
    if (immediate) listener(current, current);
    return this.subscribe((s) => {
      const next = selector(s);
      if (next !== current) {
        const prev = current;
        current = next;
        listener(next, prev);
      }
    });
  }

  private emit(prev: S): void {
    for (const l of [...this.listeners]) {
      try {
        l(this.state, prev);
      } catch (e) {
        console.error('[store] listener error', e);
      }
    }
  }
}

export type AppStore = Store<AppState>;
