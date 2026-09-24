/**
 * 「地震・津波」タブ: 地形の状態、震度・シナリオの選択、条件の調整、実行と結果の要約。
 */
import { SHINDO_LABEL, SHINDO_LEVELS, type AppState, type ShindoLevel, type TerrainGrid } from '../../core/types';
import { createGridSpec, type Resolution } from '../../core/geo';
import { SCENARIOS, SCENARIO_NOTES, SHINDO_PRESETS, defaultParams, getScenario, type ScenarioInfo } from '../../data/scenarios';
import { INTENSITY_INFO } from '../../data/intensity';
import { WARNING_INFO } from '../../data/warnings';
import { DEM_CREDIT, DEM_CREDIT_HTML } from '../../data/sources';
import type { UIContext } from '../context';
import { extLink, h, linkifyText, safeAttributionHTML, setHidden, setText } from '../dom';
import { radioField, selectField, sliderField } from '../fields';
import { formatDepth, formatElapsed, formatMinutes, formatPercent, formatTP, formatArea, isSafeColor, readableTextColor } from '../format';
import { icon } from '../icons';
import { JMA_SHINDO_TABLE_URL } from '../links';


export function createQuakePanel(ctx: UIContext): HTMLElement {
  return h(
    'div',
    { class: 'panel-body panel-quake' },
    terrainStatus(ctx),
    shindoSection(ctx),
    scenarioSection(ctx),
    paramsSection(ctx),
    resultsSection(ctx),
    runBar(ctx),
  );
}

// ---------------------------------------------------------------------------
// 地形データの状態
// ---------------------------------------------------------------------------

function terrainStatus(ctx: UIContext): HTMLElement {
  const box = h('section', { class: 'terrain-status', 'aria-label': '地形データの状態' });
  let lastKey = '';
  let bar: HTMLElement | null = null;
  let msg: HTMLElement | null = null;

  const render = (tr: AppState['terrain']) => {
    const key = `${tr.status}|${tr.grid ? 'g' : ''}`;
    if (key === lastKey && tr.status === 'loading' && bar && msg) {
      bar.style.width = formatPercent(tr.progress);
      setText(msg, tr.message ?? '');
      return;
    }
    lastKey = key;
    bar = msg = null;
    box.replaceChildren();
    box.dataset.status = tr.status;
    if (tr.status === 'loading') {
      bar = h('span', { class: 'progress-fill', style: { width: formatPercent(tr.progress) } });
      msg = h('span', { class: 'terrain-msg' }, tr.message ?? '');
      box.append(
        h('div', { class: 'status-line' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('strong', null, '地形データを読み込み中'), msg),
        h('div', { class: 'progress', role: 'progressbar', 'aria-label': '地形データの読み込み' }, bar),
      );
    } else if (tr.status === 'error') {
      const retry = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => ctx.actions.reloadTerrain() }, icon('retry', 16), '再試行');
      box.append(
        h(
          'div',
          { class: 'callout callout-danger', role: 'alert' },
          h('div', { class: 'callout-title' }, icon('alert', 18), '地形データを読み込めませんでした'),
          h('p', null, 'シミュレーションの実行には標高・水深のデータが必要です。通信環境を確認して、もう一度お試しください。'),
          tr.message ? h('p', { class: 'mono-detail' }, `詳細: ${tr.message}`) : null,
          h('div', { class: 'callout-actions' }, retry),
        ),
      );
    } else if (tr.status === 'ready' && tr.grid) {
      const g = tr.grid;
      const notes = (g.notes ?? []).filter((n) => typeof n === 'string' && n.trim());
      const spec = g.spec;
      const gridInfo = spec ? `${spec.nx}×${spec.ny}セル（1セル 約${Math.round(spec.dx)} m）` : '';
      const notesEl = notes.length
        ? h(
            'details',
            { class: 'notes terrain-notes' },
            h('summary', null, `地形データについての注記（${notes.length}件）`),
            h('ul', null, notes.map((n) => h('li', null, linkifyText(n)))),
          )
        : null;
      if (g.isApproximate) {
        box.append(
          h(
            'div',
            { class: 'callout callout-warning', role: 'status' },
            h('div', { class: 'callout-title' }, icon('alert', 18), '簡易地形モデルで表示中'),
            h('p', null, '国土地理院の標高データを取得できなかったため、簡易地形モデルで表示しています。実際の地形とは異なります。'),
            g.sourceLabel ? h('p', { class: 'small terrain-label' }, g.sourceLabel) : null,
            notesEl,
            h('div', { class: 'callout-actions' }, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => ctx.actions.reloadTerrain() }, icon('retry', 16), '標高データを再取得')),
          ),
        );
      } else {
        box.append(
          h(
            'div',
            { class: 'terrain-ok' },
            h('div', { class: 'terrain-credit' }, icon('map', 16), h('span', { class: 'terrain-label' }, h('span', { class: 'terrain-credit-head' }, '地形: '), terrainCredit(g))),
            h('div', { class: 'small muted terrain-meta' }, [gridInfo, originLabel(g)].filter(Boolean).join('・')),
            notesEl,
          ),
        );
      }
    }
    setHidden(box, box.childElementCount === 0);
  };
  ctx.scope.add(ctx.store.select((s) => s.terrain, render, true));
  return box;
}

/** 地形の出典表記。国土地理院の標高タイルを加工したものはリンク付きの定型文（DEM_CREDIT_HTML）で示す */
function terrainCredit(g: TerrainGrid): DocumentFragment {
  const frag = document.createDocumentFragment();
  const label = (g.sourceLabel ?? '').trim();
  if (g.source === 'synthetic') {
    frag.append(label || '簡易地形モデル');
    return frag;
  }
  frag.append(safeAttributionHTML(DEM_CREDIT_HTML));
  // sourceLabel が定型文で始まる場合は残り（例:「（国土地理院 DEM5A）」）だけを続ける
  const rest = label.startsWith(DEM_CREDIT) ? label.slice(DEM_CREDIT.length).trim() : label;
  if (rest) frag.append(rest.startsWith('（') ? rest : `（${rest}）`);
  return frag;
}

function originLabel(g: TerrainGrid): string {
  if (g.source === 'cache') return 'このサイトに保存した標高タイルの複製から読み込み';
  if (g.source === 'gsi') return '国土地理院のサーバーから取得';
  return '';
}

// ---------------------------------------------------------------------------
// 震度
// ---------------------------------------------------------------------------

function shindoParts(level: ShindoLevel): [string, string] {
  const label = SHINDO_LABEL[level];
  return [label.charAt(0), label.slice(1)];
}

function intensityColor(level: ShindoLevel): string {
  const c = INTENSITY_INFO[level]?.color;
  return isSafeColor(c) ? c : '#e5e7eb';
}

function shindoSection(ctx: UIContext): HTMLElement {
  const { store, actions } = ctx;
  const buttons = SHINDO_LEVELS.map((level) => {
    const bg = intensityColor(level);
    const [num, suffix] = shindoParts(level);
    return h(
      'button',
      {
        type: 'button',
        class: 'shindo-btn',
        style: { '--sh-bg': bg, '--sh-fg': readableTextColor(bg) },
        'aria-pressed': 'false',
        'aria-label': `震度${SHINDO_LABEL[level]}`,
        dataset: { level },
        onclick: () => actions.selectShindo(level),
      },
      h('span', { class: 'shindo-num' }, num),
      suffix ? h('span', { class: 'shindo-suffix' }, suffix) : null,
    );
  });

  const badge = h('span', { class: 'intensity-badge' });
  const dl = h('dl', { class: 'intensity-dl' });
  const card = h(
    'div',
    { class: 'intensity-card' },
    h('div', { class: 'intensity-head' }, badge, h('span', { class: 'muted small' }, 'の揺れと被害のめやす')),
    dl,
    h('p', { class: 'source-note' }, '出典: ', extLink(JMA_SHINDO_TABLE_URL, '気象庁「気象庁震度階級関連解説表」')),
  );

  const presetName = h('strong');
  const presetNote = h('p');
  const preset = h(
    'div',
    { class: 'callout callout-info' },
    h('div', { class: 'callout-title' }, icon('info', 18), h('span', null, 'この震度で使うシナリオ：'), presetName),
    presetNote,
    h(
      'p',
      { class: 'small' },
      '津波の大きさは震度だけでは決まりません。震源の位置・深さ、地震の規模（マグニチュード）や断層の動き方によって大きく変わり、揺れが小さくても大きな津波が来ることがあります。',
    ),
  );

  ctx.scope.add(
    store.select(
      (s) => s.shindo,
      (level) => {
        for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.level === level));
        const info = INTENSITY_INFO[level];
        const bg = intensityColor(level);
        badge.textContent = info?.label || `震度${SHINDO_LABEL[level]}`;
        badge.style.background = bg;
        badge.style.color = readableTextColor(bg);
        const rows: [string, string | undefined][] = [
          ['人の体感・行動', info?.person],
          ['屋内の状況', info?.indoor],
          ['屋外の状況', info?.outdoor],
        ];
        dl.replaceChildren(...rows.filter(([, v]) => v && v.trim()).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v!)]));
        setHidden(card, dl.childElementCount === 0);

        const p = SHINDO_PRESETS[level];
        const sc = p ? getScenario(p.scenarioId) : undefined;
        presetName.textContent = sc?.name ?? '（未設定）';
        presetNote.textContent = p?.note ?? '';
        setHidden(presetNote, !p?.note);
      },
      true,
    ),
  );

  return h(
    'section',
    { class: 'section' },
    h('h2', { class: 'section-title' }, icon('quake', 18), '震度を選ぶ'),
    h('p', { class: 'section-lead' }, '藤沢市付近で想定する揺れの強さを選ぶと、対応するシナリオが選ばれます。'),
    h('div', { class: 'shindo-grid', role: 'group', 'aria-label': '震度' }, buttons),
    card,
    preset,
  );
}

// ---------------------------------------------------------------------------
// シナリオ
// ---------------------------------------------------------------------------

/** 「最大波の到達（想定） 約8分」のような表記。説明用の例は「設定」とする */
export function arrivalFactLabel(sc: Pick<ScenarioInfo, 'arrivalMin' | 'isOfficial'>): string {
  return `最大波の到達（${sc.isOfficial ? '想定' : '設定'}） 約${formatMinutes(sc.arrivalMin)}`;
}

function scenarioCard(ctx: UIContext, sc: ScenarioInfo): HTMLElement {
  const warn = WARNING_INFO[sc.warning];
  const facts = [
    sc.magnitude !== null && Number.isFinite(sc.magnitude) ? `M${sc.magnitude.toFixed(1)}` : null,
    `最大津波高 ${formatTP(sc.coastHeight)}`,
    arrivalFactLabel(sc),
  ].filter(Boolean) as string[];
  const shBg = intensityColor(sc.shindo);
  const basis = (sc.arrivalBasis ?? '').trim();
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'scenario-main',
      'aria-pressed': 'false',
      title: basis ? `到達時間の根拠: ${basis}` : undefined,
      onclick: () => ctx.actions.selectScenario(sc.id),
    },
    h(
      'span',
      { class: 'scenario-top' },
      h('span', { class: 'scenario-name' }, sc.name),
      h('span', { class: `tag ${sc.isOfficial ? 'tag-official' : 'tag-example'}` }, sc.isOfficial ? '公的想定' : '説明用の例'),
    ),
    h(
      'span',
      { class: 'scenario-facts' },
      h('span', { class: 'mini-shindo', style: { background: shBg, color: readableTextColor(shBg) } }, `震度${SHINDO_LABEL[sc.shindo]}`),
      facts.map((f) => h('span', { class: 'fact' }, f)),
      warn ? h('span', { class: 'mini-warn', style: { background: isSafeColor(warn.color) ? warn.color : '#e5e7eb', color: isSafeColor(warn.textColor) ? warn.textColor : '#111827' } }, warn.label) : null,
    ),
  );
  // 以下は選択中のカードだけに表示する（CSS の .scenario-more）
  const desc = sc.description ? h('p', { class: 'scenario-desc' }, sc.description) : null;
  const basisEl = basis ? h('p', { class: 'scenario-basis' }, h('strong', null, '到達時間の根拠: '), basis) : null;
  const assumptions = (sc.assumptions ?? []).filter((a) => typeof a === 'string' && a.trim());
  const assumeEl = assumptions.length
    ? h('details', { class: 'notes scenario-assume' }, h('summary', null, `前提・仮定（${assumptions.length}件）`), h('ul', null, assumptions.map((a) => h('li', null, a))))
    : null;
  const refs = (sc.refs ?? []).filter((r) => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url) && r.url !== sc.sourceUrl);
  const source =
    sc.sourceUrl || sc.source || refs.length
      ? h(
          'div',
          { class: 'source-note scenario-sources' },
          sc.sourceUrl || sc.source ? h('p', null, '出典: ', sc.sourceUrl ? extLink(sc.sourceUrl, sc.source || sc.sourceUrl) : sc.source ?? '') : null,
          refs.length ? h('p', null, 'あわせて参照:') : null,
          refs.length ? h('ul', { class: 'scenario-refs' }, refs.map((r) => h('li', null, extLink(r.url, r.label || r.url)))) : null,
        )
      : null;
  const more = h('div', { class: 'scenario-more' }, desc, basisEl, assumeEl, source);
  return h('li', { class: 'scenario-card', dataset: { id: sc.id } }, btn, more);
}

function scenarioSection(ctx: UIContext): HTMLElement {
  const cards = SCENARIOS.map((sc) => scenarioCard(ctx, sc));
  ctx.scope.add(
    ctx.store.select(
      (s) => s.scenarioId,
      (id) => {
        for (const c of cards) {
          const on = c.dataset.id === id;
          c.classList.toggle('is-selected', on);
          c.querySelector('.scenario-main')?.setAttribute('aria-pressed', String(on));
        }
      },
      true,
    ),
  );
  const notes = SCENARIO_NOTES.filter((n) => typeof n === 'string' && n.trim());
  const notesEl = notes.length
    ? h(
        'details',
        { class: 'callout callout-info scenario-notes' },
        h('summary', { class: 'callout-title' }, icon('info', 18), `シナリオの値についての注意（${notes.length}件）`),
        h('ul', null, notes.map((n) => h('li', null, n))),
      )
    : null;
  return h(
    'section',
    { class: 'section' },
    h('h2', { class: 'section-title' }, icon('wave', 18), '地震・津波のシナリオ'),
    notesEl,
    h('ul', { class: 'scenario-list' }, cards),
    h('p', { class: 'field-hint' }, '「公的想定」は国や県などが公表した想定にもとづく値、「説明用の例」は仕組みを理解するための代表例です。高さは T.P.（東京湾平均海面）基準です。'),
  );
}

// ---------------------------------------------------------------------------
// 条件の調整
// ---------------------------------------------------------------------------

const RESOLUTION_OPTIONS: { value: Resolution; label: string; note: string }[] = [
  { value: 'coarse', label: '粗い（約31 m）', note: '計算が速く、メモリも少なめ' },
  { value: 'standard', label: '標準（約16 m）', note: '通常はこちら' },
  { value: 'fine', label: '細かい（約8 m）', note: '計算時間は標準の約8倍（セル数約4倍×時間刻み約1/2）。端末によってはメモリ不足になることがあります' },
];

/** 陸域の粗度係数の目安（小谷ほか(1998)。国土交通省「津波浸水想定の設定の手引き」で用いられている値）
 *  https://www.mlit.go.jp/river/shishin_guideline/kaigan/tsunamishinsui_manual.pdf */
const MANNING_GUIDE: { n: number; label: string }[] = [
  { n: 0.02, label: '田・畑など' },
  { n: 0.03, label: '林地' },
  { n: 0.04, label: '低密度の住宅地' },
  { n: 0.06, label: '中密度の住宅地' },
  { n: 0.08, label: '高密度の市街地' },
];

function describeManning(n: number): string {
  let best = MANNING_GUIDE[0];
  for (const g of MANNING_GUIDE) if (Math.abs(g.n - n) < Math.abs(best.n - n)) best = g;
  const approx = Math.abs(best.n - n) < 0.0051 ? '' : '（に近い）';
  return `目安: ${best.label}${approx}（n=${best.n.toFixed(2)}）。値が大きいほど、陸上で水の流れが遅くなります。`;
}

function isModified(s: AppState): boolean {
  const base = getScenario(s.scenarioId);
  if (!base) return false;
  const cur = s.params.scenario;
  const def = defaultParams(base);
  return (
    cur.coastHeight !== base.coastHeight ||
    cur.arrivalMin !== base.arrivalMin ||
    cur.periodMin !== base.periodMin ||
    cur.firstMotion !== base.firstMotion ||
    cur.waves !== base.waves ||
    s.params.tideTP !== def.tideTP ||
    s.params.durationMin !== def.durationMin
  );
}

function paramsSection(ctx: UIContext): HTMLElement {
  const { actions, store } = ctx;
  const cellCounts = Object.fromEntries(
    RESOLUTION_OPTIONS.map((r) => {
      const spec = createGridSpec(r.value);
      return [r.value, spec.nx * spec.ny];
    }),
  ) as Record<Resolution, number>;

  const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => actions.selectScenario(store.get().scenarioId) }, icon('retry', 14), 'シナリオの値に戻す');
  const modifiedTag = h('span', { class: 'tag tag-modified' }, '変更あり');
  // 毎フレームの store 更新で比較しないよう、params / シナリオが変わった時だけ判定する
  const renderModified = () => {
    const m = isModified(store.get());
    setHidden(resetBtn, !m);
    setHidden(modifiedTag, !m);
  };
  ctx.scope.add(store.select((s) => s.params, renderModified, true));
  ctx.scope.add(store.select((s) => s.scenarioId, renderModified));

  // 「細かい」を選んだときの注意
  const fineWarning = h(
    'div',
    { class: 'callout callout-warning compact', role: 'note' },
    icon('alert', 16),
    h('span', null, '「細かい」は「標準」の約8倍の計算時間がかかります（標準で1分かかる端末なら約8分）。スマートフォンなどでは計算が終わらなかったり、メモリ不足で止まったりすることがあります。'),
  );
  ctx.scope.add(store.select((s) => s.params.resolution, (r) => setHidden(fineWarning, r !== 'fine'), true));

  const body = h(
    'div',
    { class: 'details-body' },
    h('h3', { class: 'group-title' }, '津波'),
    sliderField(ctx, {
      label: '海岸での最大津波高',
      unit: 'm',
      min: 0,
      max: 20,
      step: 0.1,
      digits: 1,
      hint: '海岸線での最大水位（T.P.）がこの値になるよう、沖合から入る波の大きさを自動で調整します。',
      get: (s) => s.params.scenario.coastHeight,
      commit: (v) => actions.updateScenario({ coastHeight: v }),
    }),
    sliderField(ctx, {
      label: '最大波の到達時間',
      unit: '分',
      min: 1,
      max: 120,
      step: 1,
      digits: 0,
      hint: '地震発生から、海岸で最大の波が来るまでの時間。公的資料の「最大津波到達時間」にあたります。このモデルでは、最も大きい波がこの時刻に海岸へ届くよう波を入れます（シナリオによっては、その前に小さな波が来る設定です。実際の津波でも、最大波より前に小さな波が来ることがあります）。',
      get: (s) => s.params.scenario.arrivalMin,
      commit: (v) => actions.updateScenario({ arrivalMin: v }),
    }),
    sliderField(ctx, {
      label: '周期',
      unit: '分',
      min: 2,
      max: 60,
      step: 1,
      digits: 0,
      hint: '波が1回押し寄せて引くまでの時間。長いほど、水が長く陸に入り込みます。',
      get: (s) => s.params.scenario.periodMin,
      commit: (v) => actions.updateScenario({ periodMin: v }),
    }),
    radioField(ctx, {
      label: '第1波の初動',
      options: [
        { value: 'rise', label: '押し波から' },
        { value: 'fall', label: '引き波から' },
      ],
      hint: '引き波から始まる場合でも、その後に大きな押し波が来ます。',
      get: (s) => s.params.scenario.firstMotion,
      commit: (v) => actions.updateScenario({ firstMotion: v }),
    }),
    sliderField(ctx, {
      label: '波の数',
      unit: '波',
      min: 1,
      max: 8,
      step: 1,
      digits: 0,
      hint: '津波は何度も繰り返し押し寄せます。第1波が最大とは限りません（このモデルの公的想定シナリオでは、最大波のあとも最大波の0.4〜0.5倍程度の波が繰り返す設定です。設定値は仮定です）。',
      get: (s) => s.params.scenario.waves,
      commit: (v) => actions.updateScenario({ waves: v }),
    }),
    h('h3', { class: 'group-title' }, '計算条件'),
    sliderField(ctx, {
      label: '初期潮位（T.P.）',
      unit: 'm',
      min: -1,
      max: 2,
      step: 0.05,
      digits: 2,
      hint: '地震発生時の海面の高さ。満潮に近いほど浸水が広がりやすくなります。',
      get: (s) => s.params.tideTP,
      commit: (v) => actions.updateParams({ tideTP: v }),
    }),
    selectField<number>(ctx, {
      label: '計算時間',
      options: [30, 60, 90, 120].map((m) => ({ value: m, label: `地震発生から${formatMinutes(m)}` })),
      get: (s) => s.params.durationMin,
      commit: (v) => actions.updateParams({ durationMin: v }),
    }),
    radioField<Resolution>(ctx, {
      label: '解像度',
      variant: 'cards',
      options: RESOLUTION_OPTIONS.map((r) => ({ value: r.value, label: r.label, sub: `${cellCounts[r.value].toLocaleString('ja-JP')}セル・${r.note}` })),
      hint: '解像度を変えると、地形データを読み込み直します。',
      get: (s) => s.params.resolution,
      commit: (v) => actions.updateParams({ resolution: v }),
    }),
    fineWarning,
    sliderField(ctx, {
      label: '陸域の粗度係数 n',
      min: 0.02,
      max: 0.1,
      step: 0.005,
      digits: 3,
      describe: describeManning,
      get: (s) => s.params.landManning,
      commit: (v) => actions.updateParams({ landManning: v }),
    }),
    h('p', { class: 'source-note' }, '粗度係数の目安: 小谷ほか（1998）による土地利用別の値（', extLink('https://www.mlit.go.jp/river/shishin_guideline/kaigan/tsunamishinsui_manual.pdf', '国土交通省「津波浸水想定の設定の手引き」'), 'で使用）'),
  );

  const details = h(
    'details',
    { class: 'section section-details', open: true },
    h('summary', { class: 'section-title' }, icon('chevronDown', 18, 'icon chevron'), '条件を調整する', modifiedTag),
    h('div', { class: 'details-actions' }, resetBtn),
    body,
  );
  return details;
}

// ---------------------------------------------------------------------------
// 結果の要約
// ---------------------------------------------------------------------------

function resultsSection(ctx: UIContext): HTMLElement {
  const { store } = ctx;
  const coast = h('span', { class: 'stat-value' });
  const coastTarget = h('span', { class: 'stat-sub' });
  const first = h('span', { class: 'stat-value' });
  const firstSub = h('span', { class: 'stat-sub' });
  const maxd = h('span', { class: 'stat-value' });
  const area = h('span', { class: 'stat-value' });
  const partial = h('span', { class: 'tag tag-running' }, '計算途中');
  const amp = h('span');
  const stale = h(
    'div',
    { class: 'callout callout-warning compact', role: 'status' },
    icon('alert', 16),
    h('span', null, '条件が変更されています。表示中の結果は変更前の条件によるものです。再実行してください。'),
  );
  const title = h('h2', { class: 'section-title' }, icon('drop', 18), '計算結果', partial);
  // 計算側の注記（到達時間の補正・振幅の制限など。sim の出力が notes を持つ場合）
  const simNotesList = h('ul');
  const simNotes = h('div', { class: 'callout callout-info compact sim-notes', role: 'note' }, icon('info', 16), h('div', null, h('strong', null, '計算についての注記'), simNotesList));
  let lastNotesKey = '';

  const stat = (label: string, value: HTMLElement, sub?: HTMLElement) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), value, sub ?? null);
  const section = h(
    'section',
    { class: 'section results', 'aria-live': 'polite' },
    title,
    stale,
    h(
      'div',
      { class: 'stat-grid' },
      stat('海岸の最大水位', coast, coastTarget),
      stat('陸域で最初に浸水', first, firstSub),
      stat('最大浸水深', maxd),
      stat('浸水した範囲', area),
    ),
    h(
      'p',
      { class: 'field-hint' },
      'いずれもこのサイトの簡易計算による値です。公的な想定や実際の津波とは異なります。',
    ),
    simNotes,
    h('details', { class: 'notes' }, h('summary', null, '計算の調整について'), h('p', { class: 'small' }, amp)),
  );

  // 実行開始時のパラメータを覚えておき、変更されたら「条件変更」を出す
  let runParams: AppState['params'] | null = null;
  ctx.scope.add(
    store.select((s) => s.sim.runId, () => {
      runParams = store.get().params;
    }, true),
  );
  const updateStale = () => {
    const s = store.get();
    setHidden(stale, !(s.sim.output && runParams && s.params !== runParams));
  };
  ctx.scope.add(store.select((s) => s.params, updateStale, true));

  ctx.scope.add(
    ctx.watcher.subscribe((snap) => {
      const out = snap.output;
      setHidden(section, !out);
      if (!out) return;
      const running = store.get().sim.status === 'running';
      setHidden(partial, !running);
      const sm = snap.summary;
      const target = out.calibration?.targetCoastHeight ?? store.get().params.scenario.coastHeight;
      setText(coast, sm ? formatTP(sm.coastMax) : '—');
      setText(coastTarget, `目標 ${formatTP(target)}`);
      if (sm && Number.isFinite(sm.firstArrival)) {
        setText(first, formatElapsed(sm.firstArrival));
        setText(firstSub, '地震発生から');
      } else {
        setText(first, running ? '—' : '浸水なし');
        setText(firstSub, running ? 'まだ浸水していません' : `計算した${formatElapsed(out.durationSec)}の間`);
      }
      const notes = outputNotes(out);
      const notesKey = notes.join('\n');
      if (notesKey !== lastNotesKey) {
        lastNotesKey = notesKey;
        simNotesList.replaceChildren(...notes.map((n) => h('li', null, n)));
      }
      setHidden(simNotes, notes.length === 0);
      setText(maxd, sm ? formatDepth(sm.maxDepth) : '—');
      setText(area, sm ? formatArea(sm.areaM2) : '—');
      const a = out.calibration?.boundaryAmplitude;
      setText(
        amp,
        Number.isFinite(a)
          ? `海岸での最大水位が目標値に近づくよう、沖合の境界から入れる波の振幅を ${a.toFixed(2)} m に自動調整しました。地形の影響で、目標値とずれることがあります。`
          : '海岸での最大水位が目標値に近づくよう、沖合の境界から入れる波の振幅を自動調整しています。',
      );
      updateStale();
    }),
  );
  return section;
}

/** 計算結果の注記（sim の実装が notes: string[] を持つ場合のみ） */
function outputNotes(out: unknown): string[] {
  const notes = (out as { notes?: unknown } | null)?.notes;
  return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === 'string' && n.trim() !== '') : [];
}

// ---------------------------------------------------------------------------
// 実行ボタン（パネル下部に固定）
// ---------------------------------------------------------------------------

function runBar(ctx: UIContext): HTMLElement {
  const { store, actions } = ctx;
  let queued = false;

  const runLabel = h('span', null, 'シミュレーション実行');
  const runBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary btn-lg btn-block',
      onclick: () => {
        const s = store.get();
        if (s.terrain.status !== 'ready') queued = true;
        actions.runSimulation();
        render();
      },
    },
    icon('play', 18),
    runLabel,
  );
  const sub = h('p', { class: 'run-sub' });
  const fill = h('span', { class: 'progress-fill' });
  const pct = h('span', { class: 'run-pct' });
  const msg = h('span', { class: 'run-msg' });
  const cancel = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => actions.cancelSimulation() }, icon('stop', 14), '中止');
  const progress = h(
    'div',
    { class: 'run-progress' },
    h('div', { class: 'run-progress-head' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), msg, pct, cancel),
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': '計算の進み具合', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill),
  );
  const error = h('div', { class: 'callout callout-danger compact', role: 'alert' });

  const render = () => {
    const s = store.get();
    const running = s.sim.status === 'running';
    if (running || s.terrain.status === 'error') queued = false;
    setHidden(progress, !running);
    setHidden(runBtn, running);
    const pctText = formatPercent(s.sim.progress);
    fill.style.width = pctText;
    progress.querySelector('.progress')?.setAttribute('aria-valuenow', String(Math.round(s.sim.progress * 100)));
    setText(pct, pctText);
    setText(msg, s.sim.message || '計算中…');
    setText(runLabel, s.sim.output ? 'この条件で再計算' : 'シミュレーション実行');
    let subText = '';
    if (running && s.sim.auto) {
      const sc = getScenario(s.scenarioId);
      subText = `初めて開いたときの自動計算です（${sc?.shortName ?? s.params.scenario.shortName}・震度${SHINDO_LABEL[s.shindo]}）。中止して条件を変えられます。`;
    } else if (!running) {
      if (s.terrain.status === 'loading') subText = queued ? '地形データの読み込みが終わると自動で計算を始めます。' : '地形データの読み込み中です。実行すると、読み込み後に計算を始めます。';
      else if (s.terrain.status === 'error') subText = '実行すると、地形データの読み込みを再試行します。';
      else subText = `地震発生から${formatMinutes(s.params.durationMin)}後までを計算します。`;
    }
    setText(sub, subText);
    setHidden(sub, !subText);
    const err = s.sim.status === 'error' ? s.sim.message || '計算中にエラーが発生しました。' : '';
    error.replaceChildren(icon('alert', 16), h('span', null, `計算できませんでした: ${err}`));
    setHidden(error, !err);
  };
  ctx.scope.add(store.select((s) => s.sim, render, true));
  ctx.scope.add(store.select((s) => s.terrain.status, render));
  ctx.scope.add(store.select((s) => s.params.durationMin, render));

  // 状態の変化を読み上げ
  ctx.scope.add(
    store.select((s) => s.sim.status, (st, prev) => {
      if (st === 'running') ctx.announce('シミュレーションの計算を開始しました');
      else if (st === 'done') ctx.announce('計算が完了しました');
      else if (st === 'error') ctx.announce('計算できませんでした');
      else if (prev === 'running') ctx.announce('計算を中止しました');
    }),
  );

  return h('div', { class: 'run-bar' }, error, runBtn, sub, progress);
}
