/**
 * 「人物」タブ: 人物の配置（地図のクリック・地名検索・現在地）、一覧（状態をおよそ 4 Hz で更新）、
 * 選択中の人物の詳細（住所の目安を含む）と浸水深グラフ。
 */
import type { AppState, EvacMode, EvacPlan, OfficialInundationState, Person, PersonKind, PersonState, PersonStatus, ShelterKind, SimOutput, TerrainGrid } from '../../core/types';
import { CELL_SEA } from '../../core/types';
import { lonLatToCell } from '../../core/geo';
import { formatSpan } from '../../core/format';
import { cellArrival, resultCoverage, usableOutput, type ResultCoverage } from '../../core/results';
import { PERSON_PROFILES, STAY_STATUS_DESCRIPTION, criticalEncounter, personStateAt } from '../../people';
import { safeCall, timelineDuration, type UIContext } from '../context';
import { Scope, extLink, h, s as svg, setAttr, setHidden, setText, throttle } from '../dom';
import { selectField, sliderField } from '../fields';
import { formatDepth, formatDistance, formatElapsed, isSafeColor, readableTextColor } from '../format';
import { icon } from '../icons';
import { chooseLabelSide, estimateTextWidth, niceTicks, timeTickStep } from '../series';
import { isCoarsePointer, tapVerb, watchPointer } from '../pointer';
import { shelterUsageNotice, sheltersInfoLine } from '../shelterInfo';
import { OFFICIAL_ZONE_CREDIT, officialPointInfo, type OfficialPointInfo } from '../../data/officialHazard';
import { FUJISAWA_TSUNAMI_HAZARDMAP_URL } from '../links';
import { STATUS_ORDER, personStatusMeta, statusDescription, statusMeta, statusSeverity, thresholdInfos, type ThresholdInfo } from '../status';
import { GSI_MAPS_API_NOTE_URL, GSI_REVERSE_CREDIT } from '../geoSearch';
import { GEO_PRIVACY_TEXT, GEO_TILE_NOTE_SHORT } from '../geolocate';
import type { AddressState } from '../personAddress';

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

/** personStateAt を安全に呼ぶ（他モジュールの例外で UI を壊さない）。計算結果は今の地形の上の結果だけを使う */
function stateAt(p: Person, s: AppState, t: number): PersonState | null {
  try {
    return personStateAt(p, s.plans[p.id], s.terrain.grid, usableOutput(s), t);
  } catch (e) {
    console.warn('[ui] personStateAt failed', e);
    return null;
  }
}

/** 人物の場所の住所の目安の表示（無ければ null） */
function addressText(st: AddressState | undefined): { text: string; src: boolean } | null {
  if (!st) return null;
  switch (st.status) {
    case 'ok':
      return { text: `${st.label}付近`, src: true };
    case 'pending':
      return { text: '住所の目安を調べています…', src: false };
    case 'private':
      return { text: '現在地から置いた人物（住所は調べていません）', src: false };
    default:
      return null;
  }
}

function statusChip(): HTMLElement {
  return h('span', { class: 'status-chip' }, h('span', { class: 'status-icon' }), h('span', { class: 'status-text' }));
}

/** チップごとの最後の表示内容（変化がなければ DOM を触らない） */
const lastChipKey = new WeakMap<HTMLElement, string>();
/** person を渡すと、「その場にとどまる」人の浸水していない間は「とどまっている」と示す */
function updateChip(chip: HTMLElement, st: PersonState | null, person?: Pick<Person, 'evacMode'> | null): void {
  const status: PersonStatus = st?.status ?? 'waiting';
  const depth = st?.depth ?? 0;
  const meta = personStatusMeta(status, person);
  const text = meta.label + (statusSeverity(status) > 0 && depth >= 0.01 ? ` ${formatDepth(depth)}` : '');
  const key = `${status}|${text}|${meta.icon}`;
  if (lastChipKey.get(chip) === key) return;
  lastChipKey.set(chip, key);
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
  // 「クリック」「タップ」・Esc キーの案内は入力の種類に合わせる（タッチ操作の端末では「タップ」、Esc は出さない）
  const hintVerb = h('span');
  const hintEsc = h('span', { style: { whiteSpace: 'nowrap' } }, '（Escで終了）');
  const hint = h(
    'div',
    { class: 'placing-hint', role: 'status' },
    icon('pin', 16),
    h('span', null, hintVerb, hintEsc),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => actions.startPlacing(null) }, '終了'),
  );
  ctx.scope.add(
    store.select((s) => s.placing, (placing) => {
      for (const b of placeButtons) b.setAttribute('aria-pressed', String(b.dataset.kind === placing));
      setHidden(hint, !placing);
    }, true),
  );

  // ---- 地名・住所の検索、現在地から置く ------------------------------------------------
  const entry = h(
    'div',
    { class: 'place-entry' },
    h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => ctx.places.openSearch() }, icon('search', 16), '地名・住所で探して置く'),
    h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => ctx.places.locate() }, icon('locate', 16), '現在地に置く'),
  );
  const entryNote = h('p', { class: 'place-entry-note' }, icon('lock', 14), h('span', null, `${GEO_PRIVACY_TEXT}${GEO_TILE_NOTE_SHORT}`));

  // ---- 一覧 -----------------------------------------------------------------
  const list = h('ul', { class: 'people-list', 'aria-label': '配置した人物' });
  const empty = h('p', { class: 'empty-state' });
  const lead = h('p', { class: 'section-lead' });
  const renderPointerTexts = (coarse: boolean) => {
    const verb = tapVerb(coarse);
    setText(hintVerb, `地図を${verb}して配置`);
    setText(hintEsc, coarse ? '' : '（Escで終了）');
    setHidden(hintEsc, coarse);
    setText(empty, `まだ人物がいません。上のボタンを押してから、地図上を${verb}して配置してください。`);
    setText(lead, `種類を選んで地図上を${verb}すると、地震発生時にその場所にいた人を置けます。避難の様子と、その場所の浸水の深さを確かめられます。`);
  };
  renderPointerTexts(isCoarsePointer());
  ctx.scope.add(watchPointer(renderPointerTexts));
  const rows = new Map<string, { li: HTMLElement; btn: HTMLButtonElement; name: HTMLElement; sub: HTMLElement; addr: HTMLElement; chip: HTMLElement; dot: HTMLElement }>();
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
        const addr = h('span', { class: 'person-sub-addr' });
        const btn = h('button', { type: 'button', class: 'person-select', 'aria-pressed': 'false', onclick: () => actions.selectPerson(store.get().selectedPersonId === p.id ? null : p.id) }, dot, h('span', { class: 'person-text' }, name, sub, addr));
        const chip = statusChip();
        const li = h('li', { class: 'person-row', dataset: { id: p.id } }, btn, chip);
        row = { li, btn, name, sub, addr, chip, dot };
        rows.set(p.id, row);
      }
      row.dot.style.setProperty('--kind', profileColor(p.kind));
      setText(row.name, p.name);
      setText(row.sub, `${PERSON_PROFILES[p.kind]?.label ?? p.kind}・${EVAC_LABEL[p.evacMode]}`);
      const at = addressText(ctx.places.addresses.get(p.id));
      setText(row.addr, at?.src ? at.text : '');
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
      if (row) updateChip(row.chip, stateAt(p, s, s.time.t), p);
    }
    detail.tick();
  };
  const throttled = throttle(updateStatuses, 250);
  ctx.scope.add(() => throttled.cancel());
  ctx.scope.add(store.select((s) => s.time.t, () => throttled()));
  ctx.scope.add(store.select((s) => s.plans, () => throttled()));
  ctx.scope.add(store.select((s) => s.sim.output, () => throttled()));
  ctx.scope.add(store.select((s) => s.terrain.grid, () => throttled()));
  ctx.scope.add(store.select((s) => s.people, renderList, true));
  ctx.scope.add(ctx.places.addresses.subscribe(() => renderList(store.get().people)));
  ctx.scope.add(store.select((s) => s.selectedPersonId, (id) => renderSelection(id), true));
  ctx.onPanelShow('people', updateStatuses);

  // ---- 凡例 -----------------------------------------------------------------
  const legend = h('ul', { class: 'status-legend' });
  const renderLegend = () => {
    const blank = { depth: 0, lon: 0, lat: 0, ground: 0 };
    const items = STATUS_ORDER.map((st) => {
      const chip = statusChip();
      updateChip(chip, { ...blank, status: st, message: statusDescription(st) });
      return h('li', null, chip, h('span', { class: 'legend-desc' }, statusDescription(st)));
    });
    // 「その場にとどまる」人（状態は「避難開始前」と同じだが、避難を始める前ではないので別に示す）
    const stayChip = statusChip();
    updateChip(stayChip, { ...blank, status: 'waiting', message: STAY_STATUS_DESCRIPTION }, { evacMode: 'stay' });
    items.splice(1, 0, h('li', null, stayChip, h('span', { class: 'legend-desc' }, STAY_STATUS_DESCRIPTION)));
    legend.replaceChildren(...items);
  };
  renderLegend();

  return h(
    'div',
    { class: 'panel-body panel-people' },
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('pin', 18), '人物を配置する'),
      lead,
      h('div', { class: 'place-grid', role: 'group', 'aria-label': '配置する人物の種類' }, placeButtons),
      hint,
      entry,
      entryNote,
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
      h(
        'p',
        { class: 'field-hint' },
        '状態は、このサイトの簡易計算による浸水深と、設定した歩行速度・避難開始時間から求めた目安です。実際の避難の可否を示すものではありません。',
        'このサイトの計算は、公式の津波浸水想定（神奈川県）より浸水が狭く、浅めに出ます。「計算で浸水しない」は「安全」という意味ではありません。避難には',
        extLink(FUJISAWA_TSUNAMI_HAZARDMAP_URL, '藤沢市の津波ハザードマップ'),
        'を使ってください。',
      ),
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
    // 公式の想定との関係・避難場所データの注意（常に表示。避難場所の注意は「最寄りの避難場所へ」のときだけ）
    const shelterNote = h('p', { class: 'plan-note plan-note-shelter', hidden: true }, icon('info', 14), h('span', null, shelterUsageNotice()));
    const planNotes = h(
      'div',
      { class: 'plan-notes' },
      h(
        'p',
        { class: 'plan-note' },
        icon('alert', 14),
        h(
          'span',
          null,
          'このサイトの計算は、公式の津波浸水想定（神奈川県）より浸水が狭く、浅めに出ます（同じ地震の県の想定と比べても、浸水域が1〜2割狭い）。避難先・避難経路は',
          extLink(FUJISAWA_TSUNAMI_HAZARDMAP_URL, '藤沢市の津波ハザードマップ'),
          'で確認してください。',
        ),
      ),
      shelterNote,
      h('p', { class: 'plan-note plan-note-source' }, `公式の想定の出典：${OFFICIAL_ZONE_CREDIT}`),
    );

    // グラフ
    const chart = createDepthChart();

    const header = h(
      'div',
      { class: 'detail-head' },
      dot,
      nameInput,
      close,
    );
    // 住所の目安（国土地理院 逆ジオコーダー。現在地から置いた人物は調べない）
    const addrText = h('span');
    const addrSrc = h('span', { class: 'person-address-src' }, '（住所の目安: ', extLink(GSI_MAPS_API_NOTE_URL, GSI_REVERSE_CREDIT), '）');
    const addrLine = h('p', { class: 'person-address', hidden: true }, icon('pin', 14), h('span', null, addrText, addrSrc));
    const renderAddress = () => {
      const at = addressText(ctx.places.addresses.get(person.id));
      setHidden(addrLine, !at);
      setText(addrText, at?.text ?? '');
      setHidden(addrSrc, !at?.src);
    };
    child.add(ctx.places.addresses.subscribe(renderAddress));
    renderAddress();
    el.append(
      header,
      addrLine,
      h('div', { class: 'detail-status' }, chip, h('span', { class: 'detail-msg small muted' })),
      fields,
      h('h3', { class: 'group-title' }, '避難の見通し（計算上）'),
      planDl,
      verdict,
      planNotes,
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
      const out = usableOutput(s);
      const series = sampleSeries(p, s, ctx.watcher.snap.timeReady);
      chart.setData(series, timelineDuration(s), thresholdInfos().filter((th) => th.status !== 'caution'), p);
      // 完了かどうかは計算の状態ではなく結果そのもので判断する（中止・失敗の後も途中までの結果が残る）
      renderPlan(planDl, verdict, p, plan, s.terrain.grid, out, series, resultCoverage(s), s.officialInundation);
      setHidden(shelterNote, p.evacMode !== 'shelter');
      chart.setCursor(s.time.t);
      // グラフの値が変わったので、現在時刻の読み取り・状態も今のデータで表示し直す（避難のしかたを変えた直後など）
      tickFn();
    };
    const recomputeThrottled = throttle(recompute, 1000);
    child.add(() => recomputeThrottled.cancel());
    child.add(store.select(getP, () => recompute()));
    child.add(store.select((s) => s.plans, () => recompute()));
    child.add(store.select((s) => s.terrain.grid, () => recompute()));
    child.add(store.select((s) => s.params.durationMin, () => recompute()));
    child.add(store.select((s) => s.sim.status, () => recompute()));
    child.add(store.select((s) => s.officialInundation, () => recompute()));
    child.add(ctx.watcher.subscribe(() => recomputeThrottled(), false));
    recompute();

    // 現在時刻のカーソル（毎フレーム・属性 1 つだけ）
    child.add(store.select((s) => s.time.t, (t) => chart.setCursor(t)));

    tickFn = () => {
      const s = store.get();
      const p = getP(s);
      if (!p) return;
      const st = stateAt(p, s, s.time.t);
      updateChip(chip, st, p);
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
  const out = usableOutput(s);
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

/** 公式の想定の説明（例外で UI を壊さない） */
function officialAt(official: OfficialInundationState | null | undefined, lon: number, lat: number): OfficialPointInfo {
  return safeCall(() => officialPointInfo(official, lon, lat), { kind: 'loading', cls: null, text: '公式の津波浸水想定を確認できません' } as OfficialPointInfo);
}

function isShelterTarget(kind: ShelterKind | undefined): boolean {
  return kind === 'evac-site' || kind === 'tsunami-building';
}

/**
 * このサイトの計算では浸水に遭わない場合の判定文と色。公式の津波浸水想定（神奈川県）で出発地点・避難先が浸水する区域なら、
 * 計算の結果だけで「安全」と読める緑の表示にはしない（計算は公式の想定より浸水が狭く浅めに出る。docs/MODEL.md 4.13.5）。
 */
function simSafeVerdict(
  base: string,
  p: Person,
  plan: EvacPlan | undefined,
  offStart: OfficialPointInfo,
  offTarget: OfficialPointInfo | null,
): { text: string; tone: 'ok' | 'warn' | '' } {
  const stay = p.evacMode === 'stay' || !plan?.target;
  const parts: string[] = [];
  if (offStart.kind === 'zone' && offStart.cls) {
    parts.push(`ただし、公式の津波浸水想定（神奈川県）では、${stay ? 'この地点' : '出発地点'}は浸水深${offStart.cls.label}の区域です。`);
  }
  if (!stay && offTarget?.kind === 'zone' && offTarget.cls) {
    parts.push(
      isShelterTarget(plan?.target?.kind)
        ? `避難先の避難場所も、公式の想定では浸水深${offTarget.cls.label}の区域にあります（建物の上階など高い所へ避難する想定です）。`
        : `避難先も、公式の想定では浸水深${offTarget.cls.label}の区域です。`,
    );
  }
  if (parts.length > 0) {
    return { text: `${base}${parts.join('')}このサイトの計算は公式の想定より浸水が狭く浅めに出るので、避難には公式のハザードマップを使ってください。`, tone: 'warn' };
  }
  const checked = [offStart, ...(stay ? [] : [offTarget])];
  if (checked.every((o) => o?.kind === 'outside')) {
    return {
      text: `${base}公式の津波浸水想定（神奈川県）でも、${stay ? 'この地点は' : '出発地点・避難先とも'}浸水想定区域の外です。`,
      tone: 'ok',
    };
  }
  // 公式の想定を確かめられない（読み込み中・失敗・範囲外）: 緑にはしない
  return { text: `${base}公式の津波浸水想定とは照合できていません。藤沢市の津波ハザードマップでも確認してください。`, tone: '' };
}

function renderPlan(
  dl: HTMLElement,
  verdict: HTMLElement,
  p: Person,
  plan: EvacPlan | undefined,
  grid: TerrainGrid | null,
  out: SimOutput | null,
  series: Series,
  cov: ResultCoverage | null,
  official: OfficialInundationState | null,
): void {
  const complete = !!cov && cov.complete;
  const running = cov?.state === 'running';
  /** 途中までの結果の範囲（例:「9分20秒」）。完了なら空 */
  const until = cov && !complete ? formatSpan(cov.until) : '';
  const usePlan = plan && plan.personId === p.id ? plan : undefined;
  // 公式の津波浸水想定（神奈川県）で、出発地点・避難先が何mの区域か
  const offStart = officialAt(official, p.lon, p.lat);
  const offTarget = usePlan?.target ? officialAt(official, usePlan.target.lon, usePlan.target.lat) : null;
  const rows: [string, string][] = [];
  if (p.evacMode === 'stay') {
    rows.push(['行動', 'その場にとどまる']);
  } else if (!usePlan) {
    rows.push(['避難先', grid ? '計算中…' : '地形データの読み込み後に計算します']);
  } else if (!usePlan.target) {
    rows.push(['避難先', '到達できる避難先が見つかりません']);
  } else {
    // 高台の名前には根拠（「最寄りの高台（…）」「近くで最も高い地点（…）」）が入っているので種類は添えない
    const kindLabel = usePlan.target.kind === 'highground' ? '' : `（${SHELTER_KIND_LABEL[usePlan.target.kind] ?? usePlan.target.kind}）`;
    rows.push(['避難先', `${usePlan.target.name}${kindLabel}`]);
    rows.push(['経路の長さ', formatDistance(usePlan.distanceM)]);
    rows.push(['到着', usePlan.arriveAt !== null && Number.isFinite(usePlan.arriveAt) ? `地震発生から ${formatElapsed(usePlan.arriveAt)}` : '到着できません']);
  }

  // 出発地点への津波の到達（初期に陸だったセルの浸水開始時刻）
  let arrival: number | null = null;
  let arrivalText = 'シミュレーション実行後に表示';
  if (out) {
    const cell = safeCall(() => lonLatToCell(out.spec, p.lon, p.lat), null);
    if (!cell) arrivalText = '計算範囲外';
    else {
      const isSea = grid && grid.spec.nx === out.spec.nx && grid.spec.ny === out.spec.ny && grid.kind[cell.k] === CELL_SEA;
      // 途中までの結果では、集計（arrival）が受信済みのフレームより遅れていることがあるのでフレームからも調べる
      const a = safeCall(() => cellArrival(out, cell.k), Infinity);
      if (isSea) arrivalText = '海域（浸水の判定対象外）';
      else if (Number.isFinite(a)) {
        arrival = a;
        arrivalText = `地震発生から ${formatElapsed(a)}`;
      } else if (complete) {
        // 「浸水しない」と言い切らない（計算は公式の想定より浸水が狭く浅めに出る）
        arrivalText = offStart.kind === 'zone' ? 'この計算では浸水せず（計算時間内）。公式の想定では浸水する区域です' : 'この計算では浸水せず（計算時間内）';
      }
      // 途中まで: 「浸水しない」とは言わない
      else arrivalText = `まだ浸水していません（${until}まで計算${running ? '・計算中' : '。それより後は未計算'}）`;
    }
  }
  rows.push([p.evacMode === 'stay' ? 'この地点の浸水' : '出発地点の浸水', arrivalText]);
  // 公式の想定（計算の結果によらず表示する）
  rows.push([p.evacMode === 'stay' ? 'この地点（公式）' : '出発地点（公式）', offStart.text]);
  if (p.evacMode !== 'stay' && offTarget) rows.push(['避難先（公式）', offTarget.text]);

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
  if (series.count > 0) {
    // 「その場にとどまる」人は避難しないので「避難完了まで」ではなく計算した時間の範囲
    const scope = complete ? (p.evacMode === 'stay' ? '計算時間内' : '避難完了まで') : `${until}までの計算の範囲`;
    rows.push(['遭遇する浸水', maxDepth >= 0.01 ? `最大 ${formatDepth(maxDepth)}（${scope}）` : `この計算ではなし（${scope}）`]);
  }

  dl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));

  let text = '';
  let tone: 'ok' | 'warn' | 'danger' | '' = '';
  if (series.count > 0) {
    if (statusSeverity(worst) >= 2) {
      // 「生命の危険」は、状態の説明（人物の状態のメッセージ）と同じ時刻を示す（グラフの 20 秒ごとの値より正確）
      if (worst === 'critical' && out) {
        const hit = safeCall(() => criticalEncounter(p, usePlan, out, Infinity), null);
        if (hit && Number.isFinite(hit.t)) worstAt = hit.t;
      }
      text = `地震発生から ${formatElapsed(worstAt)} ごろ「${statusMeta(worst).label}」の状態になります（計算上）。避難開始を早める、より近い高い場所を選ぶなどを確かめてください。`;
      tone = 'danger';
    } else if (statusSeverity(worst) === 1) {
      text = `途中で浅い浸水に遭います（計算上）。避難開始を早めると安全側になります。`;
      tone = 'warn';
    } else if (usePlan?.arriveAt != null && arrival !== null && usePlan.arriveAt < arrival) {
      const base = `この計算では、出発地点が浸水しはじめる約${Math.max(1, Math.round((arrival - usePlan.arriveAt) / 60))}分前に避難先に着きます。`;
      ({ text, tone } = simSafeVerdict(base, p, usePlan, offStart, offTarget));
    } else if (complete) {
      const base = p.evacMode === 'stay' ? 'この計算では、計算した時間内にこの人物の位置は浸水しませんでした。' : 'この計算では、計算した時間内にこの人物が浸水に遭うことはありませんでした。';
      ({ text, tone } = simSafeVerdict(base, p, usePlan, offStart, offTarget));
    } else if (cov && !running) {
      // 中止・失敗で途中まで: 安全とは言えないことをはっきり示す
      text = `計算は地震発生から${until}までで止まっています。その間はこの人物の位置は浸水していませんが、それより後は計算していないため、安全かどうかは分かりません。`;
      tone = 'warn';
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
  // しきい値のラベルは線・面の上に描く（線の下にあると、浸水深の線が文字を横切って読めない）
  const thLabels = svg('g', { class: 'chart-th-labels' });
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
    thLabels,
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
  /** 状態の表示名に使う人物（「その場にとどまる」人は「とどまっている」） */
  let who: Pick<Person, 'evacMode'> | null = null;
  let duration = 3600;
  let yMax = 1;
  let hoverIdx = -1;

  const X = (t: number) => M.l + (t / (duration || 1)) * PW;
  const Y = (d: number) => M.t + PH - (Math.min(d, yMax) / yMax) * PH;

  const describe = (i: number) => {
    if (!data || i < 0 || i >= data.count) return '';
    const st = data.status[i];
    return `${formatElapsed(data.t[i])}：浸水深 ${formatDepth(data.depth[i])}・${personStatusMeta(st, who).label}`;
  };

  const setData = (series: Series, dur: number, thInfos: ThresholdInfo[], person?: Pick<Person, 'evacMode'> | null) => {
    const ths = thInfos.map((th) => th.minDepth);
    data = series;
    who = person ?? null;
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

    // 線と面（画面座標）
    const px = new Float64Array(series.count);
    const py = new Float64Array(series.count);
    let d = '';
    for (let i = 0; i < series.count; i++) {
      px[i] = X(series.t[i]);
      py[i] = Y(series.depth[i]);
      d += `${i ? 'L' : 'M'}${px[i].toFixed(1)} ${py[i].toFixed(1)}`;
    }

    // 危険度の閾値（線は面の下、ラベルは線の上。ラベルは浸水深の線と重ならない側（右端か左端）に置く）
    thresholds.replaceChildren();
    thLabels.replaceChildren();
    thInfos.forEach((th) => {
      const v = th.minDepth;
      if (v > yMax) return;
      const y = Y(v);
      const st: PersonStatus = th.status;
      const text = `${formatDepth(v)}〜 ${statusMeta(st).label}`;
      const width = estimateTextWidth(text, 9.5) + 4;
      const side = chooseLabelSide(px, py, series.count, { left: M.l, right: M.l + PW, top: y - 14, bottom: y - 1, width });
      thresholds.append(svg('line', { x1: M.l, x2: M.l + PW, y1: y, y2: y, style: `stroke:${statusMeta(st).color}` }));
      thLabels.append(
        svg(
          'text',
          side === 'end' ? { x: M.l + PW - 2, y: y - 3, 'text-anchor': 'end', class: 'th-label' } : { x: M.l + 3, y: y - 3, 'text-anchor': 'start', class: 'th-label' },
          text,
        ),
      );
    });

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
