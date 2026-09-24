/**
 * 地図の上の「場所を探す」ボタン（右上）と、そのパネル。
 *
 * - 地名・住所の検索（国土地理院 地名検索API）: 入力の間引き・読み込み中／該当なし／エラーの表示・キーボード操作
 *   （↑↓ で候補を選び Enter で決定、Esc で閉じる）。計算範囲の中の候補を先に、外は「計算範囲外」と示す。
 *   選ぶと地図をその場所へ移し（2D は一時的な目印を出す）、計算範囲の中なら「ここに人物を置く」を出す。
 * - 現在地（Geolocation API）: ボタンを押したときだけ 1 回取得する。座標はこの端末の中だけで使い、外部に送らない
 *   （住所も調べない）。計算範囲の中なら地図を現在地へ移して「ここに人物を置く」、外ならその旨を説明して計算範囲を表示する。
 *   地図を移すとその周辺の地図画像を配信元から読み込むので、おおよその場所は配信元に伝わる（画面にもそう書く: GEO_TILE_NOTE）。
 * - 狭い画面で人物を置いたら、パネルを閉じて地図の人物を見せ、下に短い知らせ（人物タブを開くボタン付き）を出す。
 *
 * 外部から来た文字列（検索結果の名称など）は、すべて textContent（h() の子の文字列）で入れる。innerHTML は使わない。
 */
import { INITIAL_CENTER, createGridSpec } from '../core/geo';
import type { PersonKind, UserLocation } from '../core/types';
import { domainZoomForWidth } from '../map2d/geo2d';
import { PERSON_PROFILES } from '../people';
import type { UIContext } from './context';
import { extLink, h, setAttr, setHidden, setText } from './dom';
import { isSafeColor } from './format';
import {
  CSIS_CREDIT,
  CSIS_URL,
  GSI_API_NOTICE,
  GSI_MAPS_API_NOTE_URL,
  GSI_SEARCH_CREDIT,
  LruCache,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  describeResult,
  formatApproxDistance,
  isTimeoutError,
  normalizeQuery,
  outsideBadge,
  placementProblem,
  positionNote,
  searchPlaces,
  type PlaceResult,
} from './geoSearch';
import { GEO_PRIVACY_TEXT, GEO_TILE_NOTE, GeoError, describeAccuracy, geoErrorMessage, isLowAccuracy, locationDistanceToDomain, requestPosition } from './geolocate';
import { icon } from './icons';
import { isCoarsePointer, tapVerb } from './pointer';

export interface MapTools {
  openSearch(): void;
  locate(): void;
  close(): void;
}

/** 入力が止まってから検索するまで [ms] */
const DEBOUNCE_MS = 350;
/** 検索結果を選んだときの 2D 地図のズーム */
export const FOCUS_ZOOM = 16;
/** 現在地から置いた人物の名前 */
export const GEO_PERSON_NAME = '現在地の人';
/** 狭い画面で人物を置いたときの知らせを出しておく時間 [ms] */
const PLACED_TOAST_MS = 8000;

const KINDS = Object.keys(PERSON_PROFILES) as PersonKind[];

type Mode = 'search' | 'location';
type SearchStatus = 'idle' | 'short' | 'loading' | 'done' | 'empty' | 'error';

export function mountMapTools(hud: HTMLElement, ctx: UIContext): MapTools {
  const { store, actions } = ctx;
  let mode: Mode | null = null;

  // ---- ボタン -------------------------------------------------------------------
  const searchBtn = h(
    'button',
    {
      type: 'button',
      class: 'maptool-btn',
      'aria-label': '地名・住所で探す',
      title: '地名・住所で探す',
      'aria-expanded': 'false',
      'aria-controls': 'place-panel',
      dataset: { tool: 'search' },
      onclick: () => (mode === 'search' ? close() : openSearch()),
    },
    icon('search', 20),
  );
  const locateBtn = h(
    'button',
    {
      type: 'button',
      class: 'maptool-btn',
      'aria-label': '現在地',
      title: '現在地（座標は外部に送信しません）',
      'aria-expanded': 'false',
      'aria-controls': 'place-panel',
      dataset: { tool: 'locate' },
      onclick: () => locate(),
    },
    icon('locate', 20),
  );
  const tools = h('div', { class: 'maptools', role: 'group', 'aria-label': '場所を探す' }, searchBtn, locateBtn);

  // ---- パネル -------------------------------------------------------------------
  const panelTitle = h('h2', { class: 'place-title', id: 'place-panel-title' });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn place-close', 'aria-label': '閉じる', onclick: () => close(true) }, icon('close', 18));
  const searchView = h('div', { class: 'place-view' });
  const locView = h('div', { class: 'place-view place-loc' });
  const panel = h(
    'section',
    { class: 'place-panel', id: 'place-panel', hidden: true, 'aria-labelledby': 'place-panel-title' },
    h('div', { class: 'place-head' }, panelTitle, closeBtn),
    searchView,
    locView,
  );
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      close(true);
    }
  });

  // 狭い画面で人物を置いた後の短い知らせ（HUD の下中央の状態表示の列に入れる。地図の人物を隠さない）
  const toastText = h('span', { class: 'hud-chip-text' });
  const toast = h(
    'div',
    { class: 'hud-chip hud-toast', role: 'status', hidden: true },
    icon('check', 16),
    toastText,
    h(
      'button',
      {
        type: 'button',
        class: 'hud-chip-btn',
        onclick: () => {
          hideToast();
          ctx.showPanel('people');
        },
      },
      '人物タブを開く',
    ),
    h('button', { type: 'button', class: 'hud-chip-btn hud-chip-close', 'aria-label': '知らせを閉じる', onclick: () => hideToast() }, icon('close', 14)),
  );
  let toastTimer = 0;
  const hideToast = () => {
    window.clearTimeout(toastTimer);
    toastTimer = 0;
    setHidden(toast, true);
  };
  const showToast = (text: string) => {
    setText(toastText, text);
    setHidden(toast, false);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, PLACED_TOAST_MS);
  };
  const bottomStack = hud.querySelector<HTMLElement>('.hud-bc');
  if (bottomStack) bottomStack.prepend(toast);
  else hud.append(toast);

  hud.append(tools, panel);
  ctx.scope.add(() => {
    hideToast();
    tools.remove();
    panel.remove();
    toast.remove();
  });

  // ---- 共通 -----------------------------------------------------------------------
  const setMode = (m: Mode | null) => {
    mode = m;
    setHidden(panel, !m);
    setHidden(searchView, m !== 'search');
    setHidden(locView, m !== 'location');
    searchBtn.setAttribute('aria-expanded', String(m === 'search'));
    locateBtn.setAttribute('aria-expanded', String(m === 'location'));
    searchBtn.classList.toggle('is-active', m === 'search');
    locateBtn.classList.toggle('is-active', m === 'location');
    hud.classList.toggle('has-place-panel', !!m);
    setText(panelTitle, m === 'location' ? '現在地' : '地名・住所で探す');
    if (m) ctx.collapseSheet();
  };

  function close(returnFocus = false): void {
    const was = mode;
    search.cancel();
    setMode(null);
    if (returnFocus) (was === 'location' ? locateBtn : searchBtn).focus();
  }

  /** 計算範囲の全体を表示する */
  const focusDomain = () => actions.focusOn(INITIAL_CENTER.lon, INITIAL_CENTER.lat, { zoom: domainZoomForWidth(hud.clientWidth) });

  /** その地点に人物を置けるか（地形の読み込み前は範囲だけ確かめる） */
  const problemAt = (lon: number, lat: number) => {
    const s = store.get();
    const grid = s.terrain.grid;
    return placementProblem(grid?.spec ?? createGridSpec(s.params.resolution), grid?.kind ?? null, lon, lat);
  };

  /** 同じ名前が無いように番号を付ける（「現在地の人」「現在地の人 2」…） */
  const uniqueName = (base: string) => {
    const names = new Set(store.get().people.map((p) => p.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  };

  /**
   * 「ここに人物を置く」の種類ボタン。海・川のセルなら、近くの陸地をクリックして置くモードにする。
   * 置いたら onPlaced（置けなかった理由は onProblem）。
   */
  const kindChips = (label: string, lon: number, lat: number, fromGeolocation: boolean, onPlaced: (name: string) => void, onProblem: (msg: string) => void) => {
    const chips = KINDS.map((kind) => {
      const pr = PERSON_PROFILES[kind];
      const color = isSafeColor(pr.color) ? pr.color : '#2563eb';
      return h(
        'button',
        {
          type: 'button',
          class: 'kind-chip',
          dataset: { kind },
          style: { '--kind': color },
          title: `${pr.label}（歩行速度 ${pr.speedMps.toFixed(1)} m/s）をここに置く`,
          onclick: () => {
            const problem = problemAt(lon, lat);
            if (problem === 'outside') {
              onProblem('計算範囲（破線の枠）の外なので、人物は置けません。');
              return;
            }
            if (problem === 'sea') {
              actions.startPlacing(kind);
              ctx.collapseSheet();
              onProblem(`この地点は計算上は海・川なので、そのままは置けません。近くの陸地を地図上で${tapVerb(isCoarsePointer())}して置いてください。`);
              // 狭い画面ではパネルが地図の上部を覆うので閉じる（地図の上に配置の案内が出る）
              if (ctx.isMobile()) close();
              return;
            }
            const place = () => actions.addPerson(kind, lon, lat);
            const person = fromGeolocation ? ctx.places.addresses.withoutLookup(place) : place();
            let name = person.name;
            if (fromGeolocation) {
              name = uniqueName(GEO_PERSON_NAME);
              actions.updatePerson(person.id, { name });
            }
            actions.startPlacing(null);
            if (ctx.isMobile()) {
              // 狭い画面ではパネルが地図の上半分以上を覆い、置いた人物が隠れる。パネルを閉じて人物を地図の中央に見せ、
              // 下に短い知らせを出す（人物タブはボタンで開ける）
              close();
              actions.focusOn(lon, lat);
              ctx.announce(`${name}を置きました`);
              showToast(`「${name}」を置きました`);
              return;
            }
            onPlaced(name);
          },
        },
        h('span', { class: 'kind-chip-dot', 'aria-hidden': 'true' }, icon('user', 12)),
        pr.label,
      );
    });
    return h('div', { class: 'kind-chips', role: 'group', 'aria-label': label }, h('span', { class: 'kind-chips-label' }, label), h('div', { class: 'kind-chips-row' }, chips));
  };

  /** 人物を置いた後の案内（広い画面。狭い画面ではパネルを閉じて知らせを出す: kindChips） */
  const placedNote = (name: string) => {
    const msg = `「${name}」を置きました。避難の見通しと、その場所の浸水の深さは「人物」タブで確かめられます。`;
    ctx.announce(`${name}を置きました`);
    ctx.showPanel('people');
    return h('div', { class: 'place-placed', role: 'status' }, icon('check', 16), h('span', null, msg));
  };

  // ===========================================================================
  // 地名・住所の検索
  // ===========================================================================
  const search = createSearchView();
  searchView.append(search.el);

  function createSearchView() {
    const cache = new LruCache<string, PlaceResult[]>(30);
    let results: PlaceResult[] = [];
    let active = -1;
    let status: SearchStatus = 'idle';
    let lastQuery = '';
    let timer = 0;
    let ac: AbortController | null = null;
    let reqSeq = 0;

    const input = h('input', {
      type: 'search',
      class: 'place-input',
      id: 'place-input',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': 'place-results',
      'aria-label': '地名・住所・駅名などで検索',
      placeholder: '地名・住所・駅名（例: 鵠沼海岸駅）',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      maxlength: MAX_QUERY_LENGTH,
    });
    const spinner = h('span', { class: 'spinner place-spinner', 'aria-hidden': 'true', hidden: true });
    const statusText = h('span');
    const retry = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', hidden: true, onclick: () => runSearch(normalizeQuery(input.value), true) }, icon('retry', 14), '再試行');
    const statusEl = h('p', { class: 'place-status', role: 'status', 'aria-live': 'polite' }, statusText, retry);
    const list = h('ul', { class: 'place-results', id: 'place-results', role: 'listbox', 'aria-label': '検索結果', hidden: true });
    const card = h('div', { class: 'place-card', hidden: true });
    const credit = h(
      'p',
      { class: 'place-credit' },
      '検索: ',
      extLink(GSI_MAPS_API_NOTE_URL, GSI_SEARCH_CREDIT),
      '（協力: ',
      extLink(CSIS_URL, CSIS_CREDIT),
      '）',
      h('span', { class: 'place-credit-notice' }, `。${GSI_API_NOTICE}`),
    );
    const el = h(
      'div',
      { class: 'place-search' },
      h('div', { class: 'place-field' }, icon('search', 18, 'icon place-field-icon'), input, spinner),
      statusEl,
      list,
      card,
      credit,
    );

    const setStatus = (st: SearchStatus, text = '') => {
      status = st;
      setHidden(spinner, st !== 'loading');
      setText(statusText, text);
      setHidden(retry, st !== 'error');
      setHidden(statusEl, !text);
      statusEl.dataset.state = st;
    };
    setStatus('idle');

    const setListOpen = (open: boolean) => {
      setHidden(list, !open);
      input.setAttribute('aria-expanded', String(open));
      if (!open) setActive(-1);
    };

    const setActive = (i: number) => {
      active = i;
      const items = list.children;
      for (let k = 0; k < items.length; k++) {
        const li = items[k] as HTMLElement;
        const on = k === i;
        setAttr(li, 'aria-selected', String(on));
        li.classList.toggle('is-active', on);
        if (on) li.scrollIntoView?.({ block: 'nearest' });
      }
      setAttr(input, 'aria-activedescendant', i >= 0 && results[i] ? results[i].id : null);
    };

    const renderResults = () => {
      list.replaceChildren(
        ...results.map((r, i) => {
          const badge = outsideBadge(r);
          const sub = describeResult(r);
          return h(
            'li',
            {
              id: r.id,
              role: 'option',
              class: ['place-option', r.inside ? 'is-inside' : 'is-outside'],
              'aria-selected': 'false',
              dataset: { inside: String(r.inside) },
              // 入力欄のフォーカスを保つ
              onmousedown: (e: Event) => e.preventDefault(),
              onclick: () => select(i),
            },
            h('span', { class: 'place-option-main' }, h('span', { class: 'place-option-title' }, r.title), sub ? h('span', { class: 'place-option-sub' }, sub) : null),
            badge ? h('span', { class: 'place-badge' }, badge) : null,
          );
        }),
      );
      setListOpen(results.length > 0);
    };

    const describeCount = (rs: PlaceResult[]) => {
      const inside = rs.filter((r) => r.inside).length;
      if (!rs.length) return '見つかりませんでした。別の言葉（町名・駅名・施設名など）でお試しください。';
      if (!inside) return `${rs.length}件見つかりました（すべて計算範囲外）`;
      return `${rs.length}件見つかりました（計算範囲内 ${inside}件）`;
    };

    const runSearch = (q: string, force = false) => {
      window.clearTimeout(timer);
      timer = 0;
      if (!q) {
        cancel();
        results = [];
        renderResults();
        setStatus('idle');
        lastQuery = '';
        return;
      }
      if (!force && q === lastQuery && status !== 'error') return;
      lastQuery = q;
      hideCard();
      const cached = cache.get(q);
      if (cached) {
        ac?.abort();
        results = cached;
        renderResults();
        setStatus(cached.length ? 'done' : 'empty', describeCount(cached));
        return;
      }
      ac?.abort();
      const my = new AbortController();
      ac = my;
      const seq = ++reqSeq;
      setStatus('loading', '検索しています…');
      searchPlaces(q, { signal: my.signal })
        .then((rs) => {
          if (seq !== reqSeq) return;
          cache.set(q, rs);
          results = rs;
          renderResults();
          setStatus(rs.length ? 'done' : 'empty', describeCount(rs));
        })
        .catch((e: unknown) => {
          if (seq !== reqSeq || (e as Error)?.name === 'AbortError') return;
          console.info('[ui] 地名検索に失敗しました', e);
          results = [];
          renderResults();
          lastQuery = '';
          // 応答が無いまま止まった場合も打ち切って（geoSearch.ts の GSI_REQUEST_TIMEOUT_MS）、再試行できるようにする
          setStatus(
            'error',
            isTimeoutError(e)
              ? '検索できませんでした（地名検索の応答がありません）。時間をおいて、もう一度お試しください。'
              : '検索できませんでした。通信状態を確かめて、もう一度お試しください。',
          );
        })
        .finally(() => {
          if (ac === my) ac = null;
        });
    };

    const schedule = () => {
      window.clearTimeout(timer);
      const q = normalizeQuery(input.value);
      if (!q) {
        runSearch('');
        return;
      }
      if (q.length < MIN_QUERY_LENGTH) {
        ac?.abort();
        reqSeq++;
        results = [];
        renderResults();
        hideCard();
        lastQuery = '';
        setStatus('short', `${MIN_QUERY_LENGTH}文字以上入力してください（Enter で検索）`);
        return;
      }
      timer = window.setTimeout(() => runSearch(q), DEBOUNCE_MS);
    };

    input.addEventListener('input', schedule);
    input.addEventListener('keydown', (e) => {
      const n = results.length;
      const listOpen = !list.hidden;
      if (e.key === 'ArrowDown' && n > 0) {
        e.preventDefault();
        if (!listOpen) {
          hideCard();
          setListOpen(true);
        }
        setActive(active < 0 ? 0 : (active + 1) % n);
      } else if (e.key === 'ArrowUp' && n > 0) {
        e.preventDefault();
        if (!listOpen) {
          hideCard();
          setListOpen(true);
        }
        setActive(active <= 0 ? n - 1 : active - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.isComposing) return;
        const q = normalizeQuery(input.value);
        if (listOpen && active >= 0) select(active);
        else if (q && (q !== lastQuery || timer || status === 'error')) runSearch(q, true);
        else if (n > 0) select(0);
      } else if (e.key === 'Escape' && active >= 0) {
        // 候補の選択だけを解除（もう一度 Esc でパネルを閉じる）
        e.preventDefault();
        setActive(-1);
      }
    });

    // ---- 選んだ場所 ---------------------------------------------------------------
    const hideCard = () => {
      setHidden(card, true);
      card.replaceChildren();
      el.classList.remove('has-card');
    };

    function select(i: number): void {
      const r = results[i];
      if (!r) return;
      setListOpen(false);
      // 先にカードを出してから移動する（2D 地図はパネルの大きさを見て、目的地が隠れないようずらす）
      renderCard(r);
      if (r.viewable) actions.focusOn(r.lon, r.lat, { zoom: FOCUS_ZOOM, label: r.title });
      ctx.announce(r.viewable ? `${r.title}を表示しました` : `${r.title}は地図の表示範囲の外です`);
    }

    const renderCard = (r: PlaceResult) => {
      const sub = describeResult(r);
      const note = h('p', { class: 'place-note' });
      const problemMsg = h('p', { class: 'place-note', dataset: { tone: 'warn' }, hidden: true });
      const back = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-sm',
          onclick: () => {
            hideCard();
            setListOpen(results.length > 0);
            input.focus();
          },
        },
        icon('back', 14),
        '検索結果に戻る',
      );
      const parts: (HTMLElement | null)[] = [
        h('div', { class: 'place-card-head' }, icon('pin', 18), h('span', { class: 'place-card-title' }, r.title)),
        sub || !r.inside ? h('p', { class: 'place-card-sub' }, [sub, outsideBadge(r)].filter(Boolean).join('・')) : null,
        note,
      ];
      const posNote = positionNote(r);
      if (posNote) parts.push(h('p', { class: 'place-pos-note' }, posNote));
      if (r.inside) {
        const problem = problemAt(r.lon, r.lat);
        note.dataset.tone = problem === 'sea' ? 'warn' : 'ok';
        setText(
          note,
          problem === 'sea'
            ? `計算範囲の中ですが、この地点は計算上は海・川です。種類を選ぶと、近くの陸地を${tapVerb(isCoarsePointer())}して置けます。`
            : '計算範囲の中です。地震発生時にここにいた人を置いて、避難の見通しと浸水の深さを確かめられます。',
        );
        const placedBox = h('div', { class: 'place-placed-box' });
        const chips = kindChips(
          problem === 'sea' ? '近くに人物を置く' : 'ここに人物を置く',
          r.lon,
          r.lat,
          false,
          (name) => {
            // 置いた人物のマーカーと重なるので、検索地点の目印は消す
            actions.clearFocus();
            placedBox.replaceChildren(placedNote(name));
            setHidden(problemMsg, true);
          },
          (msg) => {
            setText(problemMsg, msg);
            setHidden(problemMsg, false);
          },
        );
        parts.push(chips, problemMsg, placedBox);
      } else if (r.viewable) {
        note.dataset.tone = 'warn';
        setText(note, `計算範囲（破線の枠）の外です（${formatApproxDistance(r.distanceM)}）。津波の計算はこの枠の中だけで行うため、ここには人物を置けません。`);
      } else {
        note.dataset.tone = 'warn';
        setText(note, `このサイトの地図の表示範囲の外です（計算範囲から${formatApproxDistance(r.distanceM)}）。このサイトは鵠沼海岸周辺（辻堂〜鵠沼〜片瀬・江の島）だけを対象にしています。`);
        parts.push(h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: focusDomain }, icon('map', 14), '計算範囲を表示'));
      }
      parts.push(h('div', { class: 'place-card-actions' }, back));
      card.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
      setHidden(card, false);
      el.classList.add('has-card');
    };

    function cancel(): void {
      window.clearTimeout(timer);
      timer = 0;
      ac?.abort();
      ac = null;
      reqSeq++;
      if (status === 'loading') setStatus('idle');
    }

    return { el, input, cancel };
  }

  function openSearch(): void {
    setMode('search');
    // 表示されてからフォーカス（モバイルでキーボードを出す）
    search.input.focus();
    search.input.select();
  }

  // ===========================================================================
  // 現在地
  // ===========================================================================
  const locStatus = h('div', { class: 'loc-status', role: 'status', 'aria-live': 'polite' });
  const locBody = h('div', { class: 'loc-body' });
  const privacy = h(
    'div',
    { class: 'place-privacy' },
    icon('lock', 16),
    h(
      'div',
      null,
      h('p', { class: 'place-privacy-main' }, GEO_PRIVACY_TEXT),
      h('p', { class: 'place-privacy-sub' }, `住所も調べず、保存もしません。${GEO_TILE_NOTE}`),
    ),
  );
  locView.append(locStatus, locBody, privacy);
  let locSeq = 0;
  let locating = false;

  function locate(): void {
    setMode('location');
    if (locating) return;
    locating = true;
    const seq = ++locSeq;
    locateBtn.classList.add('is-busy');
    locStatus.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, '現在地を取得しています…'));
    locStatus.dataset.state = 'loading';
    locBody.replaceChildren();
    requestPosition()
      .then((loc) => {
        if (seq !== locSeq) return;
        actions.setUserLocation(loc);
        if (loc.insideDomain) actions.focusOn(loc.lon, loc.lat, { zoom: FOCUS_ZOOM });
        else focusDomain();
        renderLocation(loc);
        ctx.announce(loc.insideDomain ? '現在地を表示しました' : '現在地は計算範囲の外です');
      })
      .catch((e: unknown) => {
        if (seq !== locSeq) return;
        const kind = e instanceof GeoError ? e.kind : 'unavailable';
        const msg = geoErrorMessage(kind);
        locStatus.dataset.state = 'error';
        locStatus.replaceChildren(icon('alert', 16), h('span', null, h('strong', null, msg.title), h('span', { class: 'loc-detail' }, msg.detail)));
        locBody.replaceChildren(
          h(
            'div',
            { class: 'place-card-actions' },
            kind === 'insecure' || kind === 'unsupported' ? null : h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => locate() }, icon('retry', 14), 'もう一度試す'),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openSearch() }, icon('search', 14), '地名・住所で探す'),
          ),
        );
      })
      .finally(() => {
        if (seq === locSeq) {
          locating = false;
          locateBtn.classList.remove('is-busy');
        }
      });
  }

  const renderLocation = (loc: UserLocation) => {
    const acc = describeAccuracy(loc.accuracyM);
    const low = isLowAccuracy(loc.accuracyM);
    locStatus.dataset.state = loc.insideDomain ? 'ok' : 'warn';
    const parts: (HTMLElement | null)[] = [];
    const clearBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        onclick: () => {
          actions.setUserLocation(null);
          close(true);
        },
      },
      icon('close', 14),
      '現在地の表示を消す',
    );
    if (loc.insideDomain) {
      locStatus.replaceChildren(icon('check', 16), h('span', null, h('strong', null, '現在地は計算範囲の中です'), h('span', { class: 'loc-detail' }, `（${acc}）`)));
      if (low) parts.push(h('p', { class: 'place-note', dataset: { tone: 'warn' } }, `位置の精度が低いため（${acc}）、実際の場所と大きく異なることがあります。`));
      const problemMsg = h('p', { class: 'place-note', dataset: { tone: 'warn' }, hidden: true });
      const placedBox = h('div', { class: 'place-placed-box' });
      const sea = problemAt(loc.lon, loc.lat) === 'sea';
      parts.push(
        h(
          'p',
          { class: 'place-note', dataset: { tone: sea ? 'warn' : 'ok' } },
          sea ? `この地点は計算上は海・川です。種類を選ぶと、近くの陸地を${tapVerb(isCoarsePointer())}して置けます。` : '「今ここにいたら、津波のときどうなるか」を、人物を置いて確かめられます。',
        ),
        kindChips(
          sea ? '近くに人物を置く' : 'ここに人物を置く',
          loc.lon,
          loc.lat,
          true,
          (name) => {
            placedBox.replaceChildren(placedNote(name));
            setHidden(problemMsg, true);
          },
          (msg) => {
            setText(problemMsg, msg);
            setHidden(problemMsg, false);
          },
        ),
        problemMsg,
        placedBox,
        h(
          'div',
          { class: 'place-card-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => actions.focusOn(loc.lon, loc.lat, { zoom: FOCUS_ZOOM }) }, icon('locate', 14), '現在地へ移動'),
          clearBtn,
        ),
      );
    } else {
      const dist = formatApproxDistance(locationDistanceToDomain(loc));
      locStatus.replaceChildren(icon('alert', 16), h('span', null, h('strong', null, '現在地は計算範囲の外です'), h('span', { class: 'loc-detail' }, `（計算範囲から${dist}・${acc}）`)));
      parts.push(
        h(
          'p',
          { class: 'place-note', dataset: { tone: 'warn' } },
          `このサイトは鵠沼海岸周辺（辻堂〜鵠沼〜片瀬・江の島）の破線の枠の中だけを計算します。地図を計算範囲に戻しました。枠の中の場所は、地名・住所の検索か、地図の${tapVerb(isCoarsePointer())}で選べます。`,
        ),
        h(
          'div',
          { class: 'place-card-actions' },
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => openSearch() }, icon('search', 14), '地名・住所で探す'),
          clearBtn,
        ),
      );
    }
    locBody.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  };

  // 現在地が外から消された（null）ら、パネルの表示も戻す
  ctx.scope.add(
    store.select((s) => s.userLocation, (loc) => {
      if (!loc && mode === 'location' && !locating) {
        locStatus.replaceChildren();
        locBody.replaceChildren();
        setMode(null);
      }
    }),
  );

  return { openSearch, locate, close: () => close(false) };
}
