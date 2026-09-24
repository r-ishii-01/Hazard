/**
 * UI 部品が共有する文脈（ストア・アクション・派生値・パネルの表示状態）。
 */
import type { AppStore } from '../core/store';
import type { AppActions } from '../core/controller';
import type { AppState, SimOutput } from '../core/types';
import type { Scope } from './dom';
import type { AddressBook } from './personAddress';
import { summarizeArrays, type OutputSummary } from './series';

export type TabId = 'quake' | 'people' | 'layers' | 'info';

export interface UIContext {
  store: AppStore;
  actions: AppActions;
  /** mountUI 全体の後始末 */
  scope: Scope;
  /** 計算結果の集計（間引いて更新） */
  watcher: OutputWatcher;
  openDisclaimer(): void;
  /** そのタブのパネルが画面に見えているか（見えない時は重い更新を省く） */
  panelVisible(id: TabId): boolean;
  /** パネルが見えるようになった時に呼ぶ */
  onPanelShow(id: TabId, fn: () => void): void;
  /** スクリーンリーダー向けの通知（aria-live） */
  announce(message: string): void;
  /** モバイル幅（< 820px）か */
  isMobile(): boolean;
  /** モバイルのボトムシートを閉じる（地図を操作させたい時） */
  collapseSheet(): void;
  /** タブを表示する（モバイルではボトムシートを開く） */
  showPanel(id: TabId): void;
  /** 地名・住所の検索、現在地、人物の住所の目安 */
  places: PlaceServices;
}

/** 場所に関する機能（地図の上の「場所を探す」ボタンと、人物タブから使う） */
export interface PlaceServices {
  /** 地名・住所の検索を開き、入力欄にフォーカスする */
  openSearch(): void;
  /** 現在地を取得する（利用者の操作からだけ呼ぶこと） */
  locate(): void;
  /** 人物の場所の住所の目安（国土地理院 逆ジオコーダー。現在地から置いた人物は調べない） */
  addresses: AddressBook;
}

/** 表示中のタイムラインの長さ [秒] */
export function timelineDuration(s: AppState): number {
  const out = s.sim.output;
  const d = out ? safeCall(() => out.durationSec, NaN) : NaN;
  return Number.isFinite(d) && d > 0 ? d : s.params.durationMin * 60;
}

/** 他モジュールの関数呼び出しを安全に（例外・非数は既定値に） */
export function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    if (typeof v === 'number' && Number.isNaN(v) && typeof fallback === 'number') return fallback;
    return v;
  } catch {
    return fallback;
  }
}

export interface OutputSnapshot {
  output: SimOutput | null;
  /** 計算済みの最終時刻 [秒] */
  timeReady: number;
  gaugeCount: number;
  summary: (OutputSummary & { coastMax: number; areaM2: number }) | null;
  /** 変化のたびに増える */
  version: number;
  /** 集計したときの計算結果の更新番号（sim の実装が revision を持つ場合。無ければ null） */
  revision: number | null;
}

/** 計算結果の更新番号（sim の実装が revision を持つ場合のみ） */
export function outputRevision(out: SimOutput | null): number | null {
  const r = (out as (SimOutput & { revision?: unknown }) | null)?.revision;
  return typeof r === 'number' && Number.isFinite(r) ? r : null;
}

/**
 * 計算結果は計算中にも内部で増えていく（ストアには通知されない）ため、
 * 実行中は一定間隔で問い合わせて、集計値（最初の浸水・最大浸水深など）を更新する。
 */
export class OutputWatcher {
  snap: OutputSnapshot = { output: null, timeReady: 0, gaugeCount: 0, summary: null, version: 0, revision: null };
  private listeners = new Set<(s: OutputSnapshot) => void>();
  private timer = 0;

  constructor(
    private store: AppStore,
    scope: Scope,
    private intervalMs = 500,
  ) {
    scope.add(store.select((s) => s.sim.output, () => this.poll(true)));
    scope.add(
      store.select((s) => s.sim.status, () => {
        this.poll(true);
        this.updateTimer();
      }),
    );
    scope.add(() => {
      this.stopTimer();
      this.listeners.clear();
    });
    this.poll(true);
    this.updateTimer();
  }

  subscribe(fn: (s: OutputSnapshot) => void, immediate = true): () => void {
    this.listeners.add(fn);
    if (immediate) fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** 最新の状態を問い合わせる（変化があれば通知） */
  poll(force = false): void {
    const out = this.store.get().sim.output;
    if (!out) {
      if (this.snap.output !== null || force) this.emit({ output: null, timeReady: 0, gaugeCount: 0, summary: null, version: this.snap.version + 1, revision: null });
      return;
    }
    const timeReady = safeCall(() => out.timeReady(), 0);
    const gaugeCount = safeCall(() => out.gauge.count(), 0);
    const revision = outputRevision(out);
    // 更新番号があれば、それが変わっていない限り集計し直さない（最大値の配列は同じものが書き換わる）
    const same =
      out === this.snap.output &&
      timeReady === this.snap.timeReady &&
      gaugeCount === this.snap.gaugeCount &&
      (revision === null || revision === this.snap.revision);
    if (!force && same) return;
    let summary: OutputSnapshot['summary'] = null;
    try {
      const base = summarizeArrays(out.arrival, out.maxDepth);
      const dx = out.spec?.dx ?? 0;
      summary = { ...base, coastMax: safeCall(() => out.achievedCoastMax(), NaN), areaM2: base.floodedCells * dx * dx };
    } catch (e) {
      console.warn('[ui] 計算結果の集計に失敗しました', e);
    }
    this.emit({ output: out, timeReady, gaugeCount, summary, version: this.snap.version + 1, revision });
  }

  private emit(next: OutputSnapshot): void {
    this.snap = next;
    for (const l of [...this.listeners]) {
      try {
        l(next);
      } catch (e) {
        console.error('[ui] listener error', e);
      }
    }
  }

  private updateTimer(): void {
    const running = this.store.get().sim.status === 'running';
    if (running && !this.timer) this.timer = window.setInterval(() => this.poll(), this.intervalMs);
    else if (!running) this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }
}
