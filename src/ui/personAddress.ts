/**
 * 人物の場所の住所の目安（国土地理院 逆ジオコーダー）。
 *
 * - 地図のクリック・地名検索などで置いた人物について、その位置の町字（例:「藤沢市鵠沼海岸二丁目」）を調べる。
 * - 現在地（Geolocation）から置いた人物は調べない（現在地を外部に送らないため。あとで動かしても調べない）。
 * - 結果は位置（約 10 m 単位）ごとにキャッシュし、問い合わせは 1 件ずつ順に行う。失敗しても何も表示しないだけ。
 */
import type { AppStore } from '../core/store';
import type { Person } from '../core/types';
import type { Scope } from './dom';
import { LruCache, reverseCacheKey, reverseGeocode, type FetchLike, type ReverseResult } from './geoSearch';

export type AddressState =
  /** 問い合わせ中 */
  | { status: 'pending' }
  /** 住所の目安が得られた */
  | { status: 'ok'; label: string }
  /** 得られなかった（海の上・通信の失敗など） */
  | { status: 'none' }
  /** 現在地から置いた人物（問い合わせない） */
  | { status: 'private' };

export interface AddressBook {
  /** 人物の住所の目安（未登録は undefined） */
  get(personId: string): AddressState | undefined;
  /** 変化の購読（戻り値で解除） */
  subscribe(fn: () => void): () => void;
  /** fn の中で追加された人物は、住所を問い合わせない（現在地から置くとき用） */
  withoutLookup<T>(fn: () => T): T;
  /** 住所を問い合わせない人物か */
  isPrivate(personId: string): boolean;
}

/** 位置が変わってから問い合わせるまでの待ち時間 [ms]（ドラッグ直後の連続した変更をまとめる） */
const DEBOUNCE_MS = 400;
/** 続けて失敗したら、しばらく問い合わせを止める */
const MAX_FAILURES = 3;
const BACKOFF_MS = 60_000;

export function createAddressBook(store: AppStore, scope: Scope, fetchFn?: FetchLike): AddressBook {
  const entries = new Map<string, { key: string; state: AddressState }>();
  const privateIds = new Set<string>();
  const cache = new LruCache<string, ReverseResult | null>(300);
  const listeners = new Set<() => void>();
  let suppress = 0;
  let known = new Set<string>();
  let timer = 0;
  let busy = false;
  let failures = 0;
  let pausedUntil = 0;
  let disposed = false;
  let abort: AbortController | null = null;

  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (e) {
        console.error('[ui] address listener failed', e);
      }
    }
  };

  const stateFor = (r: ReverseResult | null): AddressState => (r ? { status: 'ok', label: r.label } : { status: 'none' });

  /** 人物の一覧と住所の表を突き合わせる（store の通知の直後ではなく、少し後に呼ぶ） */
  const sync = () => {
    timer = 0;
    if (disposed) return;
    const people = store.get().people;
    let changed = false;
    const alive = new Set<string>();
    let needFetch = false;
    for (const p of people) {
      alive.add(p.id);
      if (privateIds.has(p.id)) {
        if (entries.get(p.id)?.state.status !== 'private') {
          entries.set(p.id, { key: '', state: { status: 'private' } });
          changed = true;
        }
        continue;
      }
      if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
      const key = reverseCacheKey(p.lon, p.lat);
      const cur = entries.get(p.id);
      if (cur && cur.key === key) {
        if (cur.state.status === 'pending') needFetch = true;
        continue;
      }
      const cached = cache.has(key) ? stateFor(cache.get(key) ?? null) : null;
      entries.set(p.id, { key, state: cached ?? { status: 'pending' } });
      if (!cached) needFetch = true;
      changed = true;
    }
    for (const id of [...entries.keys()]) {
      if (!alive.has(id)) {
        entries.delete(id);
        changed = true;
      }
    }
    for (const id of [...privateIds]) if (!alive.has(id)) privateIds.delete(id);
    if (changed) emit();
    if (needFetch) void pump();
  };

  /** 待っている問い合わせを 1 件ずつ処理する */
  const pump = async (): Promise<void> => {
    if (busy || disposed) return;
    busy = true;
    try {
      for (;;) {
        if (disposed) return;
        const next = [...entries.entries()].find(([, e]) => e.state.status === 'pending');
        if (!next) return;
        const [id, entry] = next;
        const p = store.get().people.find((q) => q.id === id);
        if (!p || privateIds.has(id)) {
          entries.delete(id);
          continue;
        }
        if (Date.now() < pausedUntil) {
          // 通信できない状態が続いている: 住所は出さずに終える（位置が変わればまた試す）
          markKey(entry.key, { status: 'none' }, false);
          continue;
        }
        const key = entry.key;
        abort = new AbortController();
        let result: ReverseResult | null = null;
        let ok = true;
        try {
          result = await reverseGeocode(p.lon, p.lat, { signal: abort.signal, fetchFn });
          failures = 0;
        } catch (e) {
          if ((e as Error)?.name === 'AbortError' || disposed) return;
          ok = false;
          failures += 1;
          if (failures >= MAX_FAILURES) pausedUntil = Date.now() + BACKOFF_MS;
          console.info('[ui] 住所の目安を取得できませんでした（逆ジオコーダー）', e);
        } finally {
          abort = null;
        }
        // 通信の失敗は一時的なことがあるのでキャッシュしない（「得られなかった」は覚える）
        markKey(key, stateFor(result), ok);
      }
    } finally {
      busy = false;
    }
  };

  /** 同じ位置（キー）で待っている人物をまとめて更新 */
  const markKey = (key: string, state: AddressState, remember: boolean) => {
    if (remember) cache.set(key, state.status === 'ok' ? { muniCode: null, municipality: null, town: null, label: state.label } : null);
    let changed = false;
    for (const e of entries.values()) {
      if (e.key === key && e.state.status === 'pending') {
        e.state = state;
        changed = true;
      }
    }
    if (changed) emit();
  };

  const onPeople = (people: Person[]) => {
    // 現在地から置く処理の中で追加された人物は、問い合わせない側に登録する（store の通知は同期的に届く）
    const next = new Set(people.map((p) => p.id));
    if (suppress > 0) for (const id of next) if (!known.has(id)) privateIds.add(id);
    known = next;
    if (!timer) timer = window.setTimeout(sync, DEBOUNCE_MS);
  };
  scope.add(store.select((s) => s.people, onPeople, true));
  scope.add(() => {
    disposed = true;
    window.clearTimeout(timer);
    abort?.abort();
    listeners.clear();
  });

  return {
    get: (id) => entries.get(id)?.state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    withoutLookup: <T>(fn: () => T): T => {
      suppress += 1;
      try {
        return fn();
      } finally {
        suppress -= 1;
      }
    },
    isPrivate: (id) => privateIds.has(id),
  };
}
