/**
 * 「人物」タブ: 人物の配置、一覧（状態をおよそ 4 Hz で更新）、選択中の人物の詳細と浸水深グラフ。
 */
import type { AppState, EvacMode, EvacPlan, Person, PersonKind, PersonState, PersonStatus, ShelterKind, SimOutput, TerrainGrid } from '../../core/types';
import { CELL_SEA } from '../../core/types';
import { lonLatToCell } from '../../core/geo';
import { PERSON_PROFILES, personStateAt } from '../../people';
import { safeCall, timelineDuration, type UIContext } from '../context';
import { Scope, extLink, h, s as svg, setAttr, setHidden, setText, throttle } from '../dom';
import { selectField, sliderField } from '../fields';
import { formatDepth, formatDistance, formatElapsed, isSafeColor, readableTextColor } from '../format';
import { icon } from '../icons';
import { niceTicks, timeTickStep } from '../series';
import { sheltersInfoLine } from '../shelterInfo';
import { STATUS_ORDER, statusDescription, statusMeta, statusSeverity, thresholdInfos, type ThresholdInfo } from '../status';

const EVAC_LABEL: Record<EvacMode, string> = {
  stay: 'その場にとどまる',
  shelter: '最寄りの避難場所へ',
  highground: '最寄りの高台へ',
};

const SHELTER_KIND_LABEL: Record<ShelterKind, string> = {
  'evac-site': '指定緊急避難場所',
  'tsunami-building': '津波避難ビル等',
  highground: '高台',
};

const KINDS = Object.keys(PERSON_PROFILES) as PersonKind[];

function profileColor(kind: PersonKind): string {
  const c = PERSON_PROFILES[kind]?.color;
  return isSafeColor(c) ? c : '#2563eb';
}

/** personStateAt を安全に呼ぶ（他モジュールの例外で UI を壊さない） */
function stateAt(p: Person, s: AppState, t: number): PersonState | null {
  try {
    return personStateAt(p, s.plans[p.id], s.terrain.grid, s.sim.output, t);
  } catch (e) {
    console.warn('[ui] personStateAt failed', e);
    return null;
  }
}

function statusChip(): HTMLElement {
  return h('span', { class: 'status-chip' }, h('span', { class: 'status-icon' }), h('span', { class: 'status-text' }));
}

/** チップごとの最後の表示内容（変化がなければ DOM を触らない） */
const lastChipKey = new WeakMap<HTMLElement, string>();
function updateChip(chip: HTMLElement, st: PersonState | null): void {
  const status: PersonStatus = st?.status ?? 'waiting';
  const depth = st?.depth ?? 0;
  const text = statusMeta(status).label + (statusSeverity(status) > 0 && depth >= 0.01 ? ` ${formatDepth(depth)}` : '');
  const key = `${status}|${text}`;
  if (lastChipKey.get(chip) === key) return;
  lastChipKey.set(chip, key);
  const meta = statusMeta(status);
  chip.style.setProperty('--chip', meta.color);
  chip.style.setProperty('--chip-fg', readableTextColor(meta.color));
  chip.dataset.status = status;
  chip.title = st?.message || statusDescription(status);
  const iconBox = chip.firstElementChild as HTMLElement;
  iconBox.replaceChildren(icon(meta.icon, 14));
  setText(chip.lastElementChild!, text);
}

export function createPeoplePanel(ctx: UIContext): HTMLElement {
  const { store, actions } = ctx;

  // ---- 配置ボタン -------------------------------------------------------------
  const placeButtons = KINDS.map((kind) => {
    const pr = PERSON_PROFILES[kind];
    return h(
      'button',
      {
        type: 'button',
        class: 'place-btn',
        'aria-pressed': 'false',
        dataset: { kind },
        title: pr.description || `${pr.label}を地図上に置く`,
        style: { '--kind': profileColor(kind) },
        onclick: () => {
          const next = store.get().placing === kind ? null : kind;
          actions.startPlacing(next);
          if (next) ctx.collapseSheet();
        },
      },
      h('span', { class: 'kind-dot', 'aria-hidden': 'true' }, icon('user', 16)),
      h('span', { class: 'place-label' }, pr.label),
      h('span', { class: 'place-speed' }, `${pr.speedMps.toFixed(1)} m/s`),
    );
  });
  const hint = h(
    'div',
    { class: 'placing-hint', role: 'status' },
    icon('pin', 16),
    h('span', null, '地図をクリックして配置', h('span', { style: { whiteSpace: 'nowrap' } }, '（Escで終了）')),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => actions.startPlacing(null) }, '終了'),
  );
  ctx.scope.add(
    store.select((s) => s.placing, (placing) => {
      for (const b of placeButtons) b.setAttribute('aria-pressed', String(b.dataset.kind === placing));
      setHidden(hint, !placing);
    }, true),
  );

  // ---- 一覧 -----------------------------------------------------------------
  const list = h('ul', { class: 'people-list', 'aria-label': '配置した人物' });
  const empty = h('p', { class: 'empty-state' }, 'まだ人物がいません。上のボタンを押してから、地図上をクリックして配置してください。');
  const rows = new Map<string, { li: HTMLElement; btn: HTMLButtonElement; name: HTMLElement; sub: HTMLElement; chip: HTMLElement; dot: HTMLElement }>();
  const count = h('span', { class: 'count-badge' }, '0');

  let clearArmed = 0;
  const clearLabel = h('span', null, '全員削除');
  const clearBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost btn-sm btn-danger-text',
      onclick: () => {
        if (clearArmed) {
          window.clearTimeout(clearArmed);
          clearArmed = 0;
          setText(clearLabel, '全員削除');
          actions.clearPeople();
          ctx.announce('全員を削除しました');
          return;
        }
        setText(clearLabel, 'もう一度押すと全員削除');
        clearArmed = window.setTimeout(() => {
          clearArmed = 0;
          setText(clearLabel, '全員削除');
        }, 3000);
      },
    },
    icon('trash', 14),
    clearLabel,
  );
  ctx.scope.add(() => window.clearTimeout(clearArmed));

  const renderList = (people: Person[]) => {
    const seen = new Set<string>();
    people.forEach((p, idx) => {
      seen.add(p.id);
      let row = rows.get(p.id);
      if (!row) {
        const dot = h('span', { class: 'kind-dot small', 'aria-hidden': 'true' }, icon('user', 14));
        const name = h('span', { class: 'person-name' });
        const sub = h('span', { class: 'person-sub' });
        const btn = h('button', { type: 'button', class: 'person-select', 'aria-pressed': 'false', onclick: () => actions.selectPerson(store.get().selectedPersonId === p.id ? null : p.id) }, dot, h('span', { class: 'person-text' }, name, sub));
        const chip = statusChip();
        const li = h('li', { class: 'person-row', dataset: { id: p.id } }, btn, chip);
        row = { li, btn, name, sub, chip, dot };
        rows.set(p.id, row);
      }
      row.dot.style.setProperty('--kind', profileColor(p.kind));
      setText(row.name, p.name);
      setText(row.sub, `${PERSON_PROFILES[p.kind]?.label ?? p.kind}・${EVAC_LABEL[p.evacMode]}`);
      if (list.children[idx] !== row.li) list.insertBefore(row.li, list.children[idx] ?? null);
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.li.remove();
        rows.delete(id);
      }
    }
    setText(count, String(people.length));
    setHidden(empty, people.length > 0);
    setHidden(clearBtn, people.length === 0);
    updateStatuses();
  };

  const renderSelection = (id: string | null) => {
    for (const [rid, row] of rows) {
      row.btn.setAttribute('aria-pressed', String(rid === id));
      row.li.classList.toggle('is-selected', rid === id);
    }
  };

  // ---- 状態の更新（およそ 4 Hz） ---------------------------------------------
  const detail = createDetail(ctx);
  const updateStatuses = () => {
    if (!ctx.panelVisible('people')) return;
    const s = store.get();
    for (const p of s.people) {
      const row = rows.get(p.id);
      if (row) updateChip(row.chip, stateAt(p, s, s.time.t));
    }
    detail.tick();
  };
  const throttled = throttle(updateStatuses, 250);
  ctx.scope.add(() => throttled.cancel());
  ctx.scope.add(store.select((s) => s.time.t, () => throttled()));
  ctx.scope.add(store.select((s) => s.plans, () => throttled()));
  ctx.scope.add(store.select((s) => s.sim.output, () => throttled()));
  ctx.scope.add(store.select((s) => s.people, renderList, true));
  ctx.scope.add(store.select((s) => s.selectedPersonId, (id) => renderSelection(id), true));
  ctx.onPanelShow('people', updateStatuses);

  // ---- 凡例 -----------------------------------------------------------------
  const legend = h('ul', { class: 'status-legend' });
  const renderLegend = () =>
    legend.replaceChildren(
      ...STATUS_ORDER.map((st) => {
        const chip = statusChip();
        updateChip(chip, { status: st, depth: 0, lon: 0, lat: 0, ground: 0, message: statusDescription(st) });
        return h('li', null, chip, h('span', { class: 'legend-desc' }, statusDescription(st)));
      }),
    );
  renderLegend();

  return h(
    'div',
    { class: 'panel-body panel-people' },
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('pin', 18), '人物を配置する'),
      h('p', { class: 'section-lead' }, '種類を選んで地図上をクリックすると、地震発生時にその場所にいた人を置けます。避難の様子と、その場所の浸水の深さを確かめられます。'),
      h('div', { class: 'place-grid', role: 'group', 'aria-label': '配置する人物の種類' }, placeButtons),
      hint,
      sheltersInfoLine(ctx, '避難先の避難場所'),
    ),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, icon('users', 18), '配置した人物', count), clearBtn),
      empty,
      list,
    ),
    detail.el,
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('info', 18), '状態の見方'),
      legend,
      thresholdSources(),
      h('p', { class: 'field-hint' }, '状態は、このサイトの簡易計算による浸水深と、設定した歩行速度・避難開始時間から求めた目安です。実際の避難の可否を示すものではありません。'),
    ),
  );
}

/** 浸水深の区分の出典（people モジュールが公開していれば） */
function thresholdSources(): HTMLElement | null {
  const seen = new Set<string>();
  const items = thresholdInfos()
    .filter((th) => th.sourceUrl && !seen.has(th.sourceUrl) && seen.add(th.sourceUrl))
    .map((th) => h('li', null, extLink(th.sourceUrl!, th.source || th.sourceUrl!)));
  return items.length ? h('div', { class: 'source-note' }, '浸水深の区分の出典:', h('ul', { class: 'source-list' }, items)) : null;
}

// ---------------------------------------------------------------------------
// 選択中の人物の詳細
// ---------------------------------------------------------------------------

interface Detail {
  el: HTMLElement;
  /** 状態表示の更新（4 Hz） */
  tick(): void;
}

function createDetail(ctx: UIContext): Detail {
  const { store, actions } = ctx;
  const el = h('section', { class: 'section person-detail', 'aria-label': '選択中の人物' });
  let child: Scope | null = null;
  let tickFn: () => void = () => {};

  const build = (id: string | null) => {
    child?.dispose();
    child = null;
    el.replaceChildren();
    tickFn = () => {};
    const person = id ? store.get().people.find((p) => p.id === id) : undefined;
    setHidden(el, !person);
    if (!person) return;
    child = new Scope();
    const sub: UIContext = { ...ctx, scope: child };
    const getP = (s: AppState) => s.people.find((p) => p.id === id);

    const nameInput = h('input', { type: 'text', class: 'name-input', value: person.name, 'aria-label': '人物の名前', maxlength: 40 });
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v) actions.updatePerson(person.id, { name: v });
      else nameInput.value = getP(store.get())?.name ?? '';
    });
    const del = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger-text', onclick: () => actions.removePerson(person.id) }, icon('trash', 14), '削除');
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '選択を解除', onclick: () => actions.selectPerson(null) }, icon('close', 16));
    const chip = statusChip();
    const dot = h('span', { class: 'kind-dot', 'aria-hidden': 'true' }, icon('user', 16));

    const speedReset = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => actions.updatePerson(person.id, { speedMps: undefined }) }, icon('retry', 14), '種類の既定値に戻す');

    const fields = h(
      'div',
      { class: 'detail-fields' },
      selectField<PersonKind>(sub, {
        label: '種類',
        options: KINDS.map((k) => ({ value: k, label: PERSON_PROFILES[k].label })),
        get: (s) => getP(s)?.kind ?? person.kind,
        commit: (v) => actions.updatePerson(person.id, { kind: v }),
      }),
      selectField<EvacMode>(sub, {
        label: '避難のしかた',
        options: (Object.keys(EVAC_LABEL) as EvacMode[]).map((m) => ({ value: m, label: EVAC_LABEL[m] })),
        get: (s) => getP(s)?.evacMode ?? person.evacMode,
        commit: (v) => actions.updatePerson(person.id, { evacMode: v }),
      }),
      sliderField(sub, {
        label: '避難開始までの時間',
        unit: '分',
        min: 0,
        max: 30,
        step: 1,
        digits: 0,
        get: (s) => getP(s)?.startDelayMin ?? person.startDelayMin,
        commit: (v) => actions.updatePerson(person.id, { startDelayMin: v }),
      }),
      sliderField(sub, {
        label: '歩行速度',
        unit: 'm/s',
        min: 0.2,
        max: 3,
        step: 0.1,
        digits: 1,
        describe: (v) => `時速 約${(v * 3.6).toFixed(1)} km`,
        get: (s) => {
          const p = getP(s);
          return p?.speedMps ?? PERSON_PROFILES[p?.kind ?? person.kind].speedMps;
        },
        commit: (v) => actions.updatePerson(person.id, { speedMps: v }),
      }),
      speedReset,
    );

    // 避難計画の要約
    const planDl = h('dl', { class: 'plan-dl' });
    const verdict = h('p', { class: 'plan-verdict' });

    // グラフ
    const chart = createDepthChart();

    const header = h(
      'div',
      { class: 'detail-head' },
      dot,
      nameInput,
      close,
    );
    el.append(
      header,
      h('div', { class: 'detail-status' }, chip, h('span', { class: 'detail-msg small muted' })),
      fields,
      h('h3', { class: 'group-title' }, '避難の見通し（計算上）'),
      planDl,
      verdict,
      h('h3', { class: 'group-title' }, 'この人物の位置の浸水深'),
      chart.el,
      h('div', { class: 'detail-actions' }, del),
    );
    const msgEl = el.querySelector('.detail-msg') as HTMLElement;

    // 人物の値の変化に追従
    child.add(
      store.select(getP, (p) => {
        if (!p) return;
        dot.style.setProperty('--kind', profileColor(p.kind));
        if (document.activeElement !== nameInput) nameInput.value = p.name;
        setHidden(speedReset, p.speedMps === undefined);
      }, true),
    );

    // グラフと計画の再計算（出力が増えている間は 1 秒ごと）
    const recompute = () => {
      const s = store.get();
      const p = getP(s);
      if (!p) return;
      const plan = s.plans[p.id];
      const out = s.sim.output;
      const series = sampleSeries(p, s, ctx.watcher.snap.timeReady);
      chart.setData(series, timelineDuration(s), thresholdInfos().filter((th) => th.status !== 'caution'));
      renderPlan(planDl, verdict, p, plan, s.terrain.grid, out, series, s.sim.status === 'running');
      chart.setCursor(s.time.t);
    };
    const recomputeThrottled = throttle(recompute, 1000);
    child.add(() => recomputeThrottled.cancel());
    child.add(store.select(getP, () => recompute()));
    child.add(store.select((s) => s.plans, () => recompute()));
    child.add(store.select((s) => s.terrain.grid, () => recompute()));
    child.add(store.select((s) => s.params.durationMin, () => recompute()));
    child.add(ctx.watcher.subscribe(() => recomputeThrottled(), false));
    recompute();

    // 現在時刻のカーソル（毎フレーム・属性 1 つだけ）
    child.add(store.select((s) => s.time.t, (t) => chart.setCursor(t)));

    tickFn = () => {
      const s = store.get();
      const p = getP(s);
      if (!p) return;
      const st = stateAt(p, s, s.time.t);
      updateChip(chip, st);
      setText(msgEl, st?.message ?? '');
      chart.setReadout(s.time.t);
    };
    tickFn();
  };

  ctx.scope.add(store.select((s) => s.selectedPersonId, build, true));
  // 選択中の人物が削除されたら閉じる
  ctx.scope.add(
    store.select((s) => s.people, (people) => {
      const id = store.get().selectedPersonId;
      if (el.childElementCount && id && !people.some((p) => p.id === id)) build(null);
    }),
  );
  ctx.scope.add(() => child?.dispose());
  return { el, tick: () => tickFn() };
}

interface Series {
  t: Float32Array;
  depth: Float32Array;
  status: PersonStatus[];
  count: number;
}

const SAMPLE_STEP = 20;

/** 人物の位置の浸水深を時刻ごとに求める（計算済みの時刻まで） */
function sampleSeries(p: Person, s: AppState, timeReady: number): Series {
  const out = s.sim.output;
  const duration = timelineDuration(s);
  const until = out ? Math.min(duration, timeReady) : 0;
  const n = out ? Math.floor(until / SAMPLE_STEP) + 1 : 0;
  const t = new Float32Array(n);
  const depth = new Float32Array(n);
  const status: PersonStatus[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ti = Math.min(until, i * SAMPLE_STEP);
    const st = stateAt(p, s, ti);
    t[i] = ti;
    depth[i] = st && Number.isFinite(st.depth) ? Math.max(0, st.depth) : 0;
    status[i] = st?.status ?? 'waiting';
  }
  return { t, depth, status, count: n };
}

function renderPlan(
  dl: HTMLElement,
  verdict: HTMLElement,
  p: Person,
  plan: EvacPlan | undefined,
  grid: TerrainGrid | null,
  out: SimOutput | null,
  series: Series,
  running: boolean,
): void {
  const rows: [string, string][] = [];
  if (p.evacMode === 'stay') {
    rows.push(['行動', 'その場にとどまる']);
  } else if (!plan) {
    rows.push(['避難先', grid ? '計算中…' : '地形データの読み込み後に計算します']);
  } else if (!plan.target) {
    rows.push(['避難先', '到達できる避難先が見つかりません']);
  } else {
    rows.push(['避難先', `${plan.target.name}（${SHELTER_KIND_LABEL[plan.target.kind] ?? plan.target.kind}）`]);
    rows.push(['経路の長さ', formatDistance(plan.distanceM)]);
    rows.push(['到着', plan.arriveAt !== null && Number.isFinite(plan.arriveAt) ? `地震発生から ${formatElapsed(plan.arriveAt)}` : '到着できません']);
  }

  // 出発地点への津波の到達（初期に陸だったセルの浸水開始時刻）
  let arrival: number | null = null;
  let arrivalText = 'シミュレーション実行後に表示';
  if (out) {
    const cell = safeCall(() => lonLatToCell(out.spec, p.lon, p.lat), null);
    if (!cell) arrivalText = '計算範囲外';
    else {
      const isSea = grid && grid.spec.nx === out.spec.nx && grid.spec.ny === out.spec.ny && grid.kind[cell.k] === CELL_SEA;
      const a = out.arrival[cell.k];
      if (isSea) arrivalText = '海域（浸水の判定対象外）';
      else if (Number.isFinite(a)) {
        arrival = a;
        arrivalText = `地震発生から ${formatElapsed(a)}`;
      } else arrivalText = running ? 'まだ浸水していません（計算中）' : '浸水しない（計算時間内）';
    }
  }
  rows.push(['出発地点の浸水', arrivalText]);

  // 経験する最大の浸水
  let worst: PersonStatus = 'waiting';
  let maxDepth = 0;
  let worstAt = NaN;
  for (let i = 0; i < series.count; i++) {
    // 避難完了後（避難ビルの上階・高台など）はその地点の浸水に遭わないものとして除く
    if (series.status[i] !== 'safe' && series.depth[i] > maxDepth) {
      maxDepth = series.depth[i];
    }
    if (statusSeverity(series.status[i]) > statusSeverity(worst)) {
      worst = series.status[i];
      worstAt = series.t[i];
    }
  }
  if (series.count > 0) rows.push(['遭遇する浸水', maxDepth >= 0.01 ? `最大 ${formatDepth(maxDepth)}（避難完了まで）` : 'なし（避難完了まで）']);

  dl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));

  let text = '';
  let tone: 'ok' | 'warn' | 'danger' | '' = '';
  if (series.count > 0) {
    if (statusSeverity(worst) >= 2) {
      text = `地震発生から ${formatElapsed(worstAt)} ごろ「${statusMeta(worst).label}」の状態になります（計算上）。避難開始を早める、より近い高い場所を選ぶなどを確かめてください。`;
      tone = 'danger';
    } else if (statusSeverity(worst) === 1) {
      text = `途中で浅い浸水に遭います（計算上）。避難開始を早めると安全側になります。`;
      tone = 'warn';
    } else if (plan?.arriveAt != null && arrival !== null && plan.arriveAt < arrival) {
      text = `出発地点が浸水しはじめる約${Math.max(1, Math.round((arrival - plan.arriveAt) / 60))}分前に避難先に着きます（計算上）。`;
      tone = 'ok';
    } else if (!running) {
      text = '計算した時間内に、この人物の位置が浸水することはありませんでした（計算上）。';
      tone = 'ok';
    }
  }
  verdict.textContent = text;
  verdict.dataset.tone = tone;
  setHidden(verdict, !text);
}

// ---------------------------------------------------------------------------
// 浸水深グラフ（インライン SVG）
// ---------------------------------------------------------------------------

const W = 320;
const H = 150;
const M = { l: 36, r: 10, t: 10, b: 30 };
const PW = W - M.l - M.r;
const PH = H - M.t - M.b;
const STRIP_H = 5;

function createDepthChart() {
  const grid = svg('g', { class: 'chart-grid' });
  const thresholds = svg('g', { class: 'chart-thresholds' });
  const area = svg('path', { class: 'chart-area' });
  const line = svg('path', { class: 'chart-line' });
  const strip = svg('g', { class: 'chart-strip' });
  const cursor = svg('line', { class: 'chart-cursor', y1: M.t, y2: M.t + PH });
  const hoverLine = svg('line', { class: 'chart-hover', y1: M.t, y2: M.t + PH, display: 'none' });
  const hoverDot = svg('circle', { class: 'chart-dot', r: 4, display: 'none' });
  const hit = svg('rect', { class: 'chart-hit', x: M.l, y: M.t, width: PW, height: PH + STRIP_H + 6 });
  const root = svg(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'depth-chart', role: 'img', 'aria-label': 'この人物の位置の浸水深の時間変化' },
    grid,
    thresholds,
    area,
    line,
    strip,
    cursor,
    hoverLine,
    hoverDot,
    hit,
  );
  const readout = h('p', { class: 'chart-readout', 'aria-live': 'off' });
  const emptyMsg = h('p', { class: 'chart-empty' }, 'シミュレーションを実行すると、この人物の位置の浸水深の変化が表示されます。');
  const el = h('div', { class: 'chart-wrap' }, root, readout, emptyMsg);

  let data: Series | null = null;
  let duration = 3600;
  let yMax = 1;
  let hoverIdx = -1;

  const X = (t: number) => M.l + (t / (duration || 1)) * PW;
  const Y = (d: number) => M.t + PH - (Math.min(d, yMax) / yMax) * PH;

  const describe = (i: number) => {
    if (!data || i < 0 || i >= data.count) return '';
    const st = data.status[i];
    return `${formatElapsed(data.t[i])}：浸水深 ${formatDepth(data.depth[i])}・${statusMeta(st).label}`;
  };

  const setData = (series: Series, dur: number, thInfos: ThresholdInfo[]) => {
    const ths = thInfos.map((th) => th.minDepth);
    data = series;
    duration = dur;
    const hasData = series.count > 1;
    setHidden(root, !hasData);
    setHidden(readout, !hasData);
    setHidden(emptyMsg, hasData);
    if (!hasData) return;
    let maxD = 0;
    for (let i = 0; i < series.count; i++) maxD = Math.max(maxD, series.depth[i]);
    const visibleTh = ths.filter((v) => v <= Math.max(maxD * 1.6, ths[0] ?? 0.3) + 1e-9);
    const top = Math.max(0.5, maxD * 1.1, ...visibleTh.map((v) => v * 1.15));
    const ticks = niceTicks(top, 4);
    yMax = ticks[ticks.length - 1] || 1;

    // 目盛り
    grid.replaceChildren();
    ticks.forEach((v, i) => {
      const y = Y(v);
      const label = v === 0 ? '0' : i === ticks.length - 1 ? `${v}m` : `${v}`;
      grid.append(svg('line', { x1: M.l, x2: M.l + PW, y1: y, y2: y, class: v === 0 ? 'axis' : '' }), svg('text', { x: M.l - 6, y: y + 3.5, 'text-anchor': 'end' }, label));
    });
    const step = timeTickStep(duration, 6);
    const lastTick = Math.floor(duration / step + 1e-6) * step;
    for (let t = 0; t <= duration + 1e-6; t += step) {
      const isLast = Math.abs(t - lastTick) < 1e-6;
      grid.append(svg('text', { x: X(t), y: H - 8, 'text-anchor': isLast && t > 0 ? 'end' : 'middle', dx: isLast && t > 0 ? 6 : 0 }, isLast && t > 0 ? `${Math.round(t / 60)}分` : `${Math.round(t / 60)}`));
    }

    // 危険度の閾値
    thresholds.replaceChildren();
    thInfos.forEach((th) => {
      const v = th.minDepth;
      if (v > yMax) return;
      const y = Y(v);
      const st: PersonStatus = th.status;
      thresholds.append(
        svg('line', { x1: M.l, x2: M.l + PW, y1: y, y2: y, style: `stroke:${statusMeta(st).color}` }),
        svg('text', { x: M.l + PW - 2, y: y - 3, 'text-anchor': 'end', class: 'th-label' }, `${formatDepth(v)}〜 ${statusMeta(st).label}`),
      );
    });

    // 線と面
    let d = '';
    for (let i = 0; i < series.count; i++) d += `${i ? 'L' : 'M'}${X(series.t[i]).toFixed(1)} ${Y(series.depth[i]).toFixed(1)}`;
    line.setAttribute('d', d);
    const last = series.count - 1;
    area.setAttribute('d', `${d}L${X(series.t[last]).toFixed(1)} ${Y(0)}L${X(series.t[0]).toFixed(1)} ${Y(0)}Z`);

    // 状態の帯（x 軸の下）
    strip.replaceChildren();
    let runStart = 0;
    for (let i = 1; i <= series.count; i++) {
      if (i === series.count || series.status[i] !== series.status[runStart]) {
        const x0 = X(series.t[runStart]);
        const x1 = i === series.count ? X(series.t[last]) : X(series.t[i]);
        strip.append(svg('rect', { x: x0, y: M.t + PH + 3, width: Math.max(0.8, x1 - x0), height: STRIP_H, style: `fill:${statusMeta(series.status[runStart]).color}` }));
        runStart = i;
      }
    }
    if (hoverIdx >= series.count) hoverIdx = -1;
  };

  const setCursor = (t: number) => {
    if (!data || data.count < 2) return;
    const x = X(Math.min(t, duration)).toFixed(1);
    setAttr(cursor, 'x1', x);
    setAttr(cursor, 'x2', x);
  };

  let lastReadoutT = 0;
  const setReadout = (t: number) => {
    lastReadoutT = t;
    if (!data || data.count < 2 || hoverIdx >= 0) return;
    const i = Math.min(data.count - 1, Math.max(0, Math.round(t / SAMPLE_STEP)));
    const beyond = t > data.t[data.count - 1] + SAMPLE_STEP;
    setText(readout, beyond ? `${formatElapsed(t)}：計算中` : `現在 ${describe(i)}`);
  };

  const showHover = (i: number) => {
    hoverIdx = i;
    if (!data || i < 0) {
      hoverLine.setAttribute('display', 'none');
      hoverDot.setAttribute('display', 'none');
      setReadout(lastReadoutT);
      return;
    }
    const x = X(data.t[i]);
    hoverLine.setAttribute('x1', String(x));
    hoverLine.setAttribute('x2', String(x));
    hoverLine.removeAttribute('display');
    hoverDot.setAttribute('cx', String(x));
    hoverDot.setAttribute('cy', String(Y(data.depth[i])));
    hoverDot.style.fill = statusMeta(data.status[i]).color;
    hoverDot.removeAttribute('display');
    setText(readout, describe(i));
  };

  hit.addEventListener('pointermove', (e) => {
    if (!data || data.count < 2) return;
    const rect = root.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const t = ((vx - M.l) / PW) * duration;
    const i = Math.round(t / SAMPLE_STEP);
    showHover(Math.max(0, Math.min(data.count - 1, i)));
  });
  hit.addEventListener('pointerleave', () => showHover(-1));

  return { el, setData, setCursor, setReadout };
}
