/**
 * 「地震・津波」タブ: 地形の状態、震度・シナリオの選択、条件の調整、実行と結果の要約。
 */
import { SHINDO_LABEL, SHINDO_LEVELS, type AppState, type ShindoLevel, type TerrainGrid } from '../../core/types';
import { isResultStale, partialExplanation, partialRangeLabel, resultCoverage, runConditionsLabel } from '../../core/results';
import { createGridSpec, type Resolution } from '../../core/geo';
import { SCENARIOS, SCENARIO_NOTES, SHINDO_PRESETS, defaultParams, getScenario, type ScenarioInfo } from '../../data/scenarios';
import { INTENSITY_INFO } from '../../data/intensity';
import { WARNING_INFO } from '../../data/warnings';
import { DEM_CREDIT, DEM_CREDIT_HTML } from '../../data/sources';
import type { UIContext } from '../context';
import { extLink, h, linkifyText, safeAttributionHTML, setHidden, setText } from '../dom';
import { radioField, selectField, sliderField } from '../fields';
import { formatDepth, formatElapsed, formatMinutes, formatPercent, formatSpan, formatTP, formatArea, isSafeColor, readableTextColor } from '../format';
import { icon } from '../icons';
import { JMA_SHINDO_TABLE_URL } from '../links';
import { ARRIVAL_BASIS_LABEL, arrivalFactLabel } from '../scenarioText';

export { arrivalFactLabel } from '../scenarioText';


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
      title: basis ? `${ARRIVAL_BASIS_LABEL}: ${basis}` : undefined,
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
  const basisEl = basis ? h('p', { class: 'scenario-basis' }, h('strong', null, `${ARRIVAL_BASIS_LABEL}: `), basis) : null;
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
      hint: '地震発生から、海岸で最大の波が来るまでの時間。神奈川県の想定のシナリオでは、県の予測図の「最大津波到達時間」の値です（南海トラフは、内閣府が最大波の時刻を公表していないため「津波高+3m」の到達時間を使った設定値、説明用の例は設定値。値を変えると公的な値ではなくなります）。このモデルでは、最も大きい波がこの時刻に海岸へ届くよう波を入れます（シナリオによっては、その前に小さな波が来る設定です。実際の津波でも、最大波より前に小さな波が来ることがあります）。レイヤーの「津波到達時間」（各地点が最初に浸水した時刻）とは別の時刻です。',
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
      hint: '解像度を変えると、地形データを読み込み直します（表示中の計算結果は消えます。計算中なら、読み込み後に新しい解像度で計算し直します）。',
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

/** 表示中の結果の条件（例: 「相模トラフ西側・震度7」） */
function conditionsLabel(s: AppState): string {
  return runConditionsLabel(s, (lv) => SHINDO_LABEL[lv]);
}

/**
 * 表示中の結果が前の条件のものであることの案内（ボタンで今の条件で計算し直せる）。
 * パネル下部に固定した実行ボタンの上（震度・シナリオを選んだときに常に見える位置）に出す。
 */
function staleNotice(ctx: UIContext, extraClass = ''): HTMLElement {
  const { store, actions } = ctx;
  const text = h('span');
  const btnLabel = h('span');
  const btn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => actions.runSimulation() }, icon('retry', 14), btnLabel);
  const el = h(
    'div',
    { class: `callout callout-warning compact stale-notice ${extraClass}`.trim(), role: 'status', hidden: true },
    icon('alert', 16),
    h('div', { class: 'notice-body' }, text, h('div', { class: 'notice-actions' }, btn)),
  );
  const render = () => {
    const s = store.get();
    const stale = isResultStale(s);
    setHidden(el, !stale);
    if (!stale) return;
    const running = s.sim.status === 'running';
    setText(
      text,
      running
        ? `条件が変更されています。計算中の結果は変更前の条件（${conditionsLabel(s)}）によるものです。`
        : `条件が変更されています。表示中の結果は変更前の条件（${conditionsLabel(s)}）によるものです。下の「この条件で再計算」で計算し直せます。`,
    );
    // 計算中は実行ボタンが隠れるので、ここに「この条件で計算し直す」（中止して今の条件で計算）を出す
    setText(btnLabel, 'この条件で計算し直す');
    setHidden(btn, !running);
  };
  ctx.scope.add(store.select((s) => s.params, render, true));
  ctx.scope.add(store.select((s) => s.sim, render));
  ctx.scope.add(store.select((s) => s.terrain.grid, render));
  return el;
}

function resultsSection(ctx: UIContext): HTMLElement {
  const { store } = ctx;
  const coast = h('span', { class: 'stat-value' });
  const coastTarget = h('span', { class: 'stat-sub' });
  const first = h('span', { class: 'stat-value' });
  const firstSub = h('span', { class: 'stat-sub' });
  const maxd = h('span', { class: 'stat-value' });
  const maxdSub = h('span', { class: 'stat-sub' });
  const area = h('span', { class: 'stat-value' });
  const areaSub = h('span', { class: 'stat-sub' });
  const partial = h('span', { class: 'tag tag-running' }, '計算途中');
  const partialText = h('span');
  const partialNote = h('div', { class: 'callout callout-warning compact partial-notice', role: 'status', hidden: true }, icon('alert', 16), partialText);
  const amp = h('span');
  // 条件を変えた後も、再計算するまでは前の条件の結果が表示される
  const staleTag = h('span', { class: 'tag tag-stale', hidden: true, title: '震度・シナリオ・条件を変更した後、まだ計算し直していません' }, '変更前の条件の結果');
  const title = h('h2', { class: 'section-title' }, icon('drop', 18), '計算結果', partial, staleTag);
  // 計算側の注記（到達時間の補正・振幅の制限など。sim の出力が notes を持つ場合）
  const simNotesList = h('ul');
  const simNotes = h('div', { class: 'callout callout-info compact sim-notes', role: 'note' }, icon('info', 16), h('div', null, h('strong', null, '計算についての注記'), simNotesList));
  let lastNotesKey = '';

  const stat = (label: string, value: HTMLElement, sub?: HTMLElement) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), value, sub ?? null);
  const section = h(
    'section',
    // 計算中は数値が 0.5 秒ごとに変わるので、ライブリージョンにはしない（読み上げが数値の羅列になる）。
    // 計算の完了は、下の runBar が要約を 1 文で読み上げる（completionAnnouncement）
    { class: 'section results', 'aria-label': '計算結果の要約' },
    title,
    partialNote,
    h(
      'div',
      { class: 'stat-grid' },
      stat('海岸の最大水位', coast, coastTarget),
      stat('陸域で最初に浸水', first, firstSub),
      stat('最大浸水深', maxd, maxdSub),
      stat('浸水した範囲', area, areaSub),
    ),
    h(
      'p',
      { class: 'field-hint' },
      'いずれもこのサイトの簡易計算による値です。公的な想定や実際の津波とは異なります。公式の津波浸水想定（神奈川県）と比べると、同じ地震の想定でも浸水域が1〜2割狭く、浸水深も浅めに出ます。避難には公式のハザードマップを使ってください。',
    ),
    simNotes,
    h('details', { class: 'notes' }, h('summary', null, '計算の調整について'), h('p', { class: 'small' }, amp)),
  );

  const render = () => {
    const snap = ctx.watcher.snap;
    const out = snap.output;
    setHidden(section, !out);
    if (!out) return;
    const s = store.get();
    // 完了かどうかは計算の状態ではなく結果そのもので判断する（中止・失敗の後も途中までの結果が残る）
    const cov = resultCoverage(s);
    const complete = !cov || cov.complete;
    const running = cov?.state === 'running';
    setHidden(partial, complete);
    setText(partial, complete ? '' : partialRangeLabel(cov));
    partial.dataset.state = cov?.state ?? '';
    // 中止・失敗の途中までの結果は、その範囲と「浸水しない」という意味ではないことを示す
    setHidden(staleTag, !isResultStale(s));
    setHidden(partialNote, complete || running);
    setText(partialText, complete || running ? '' : partialExplanation(cov));
    const rangeSub = complete ? '' : `0〜${formatSpan(cov!.until)}の値`;
    const sm = snap.summary;
    const target = out.calibration?.targetCoastHeight ?? s.params.scenario.coastHeight;
    setText(coast, sm ? formatTP(sm.coastMax) : '—');
    setText(coastTarget, complete ? `目標 ${formatTP(target)}` : `目標 ${formatTP(target)}・${rangeSub}`);
    if (sm && Number.isFinite(sm.firstArrival)) {
      setText(first, formatElapsed(sm.firstArrival));
      setText(firstSub, '地震発生から');
    } else if (complete) {
      setText(first, '浸水なし');
      setText(firstSub, `計算した${formatElapsed(out.durationSec)}の間`);
    } else {
      // 途中まで: 「浸水なし」とは言わない
      setText(first, '—');
      setText(firstSub, `まだ浸水していません（${formatSpan(cov!.until)}まで計算${running ? '・計算中' : ''}）`);
    }
    const notes = outputNotes(out);
    const notesKey = notes.join('\n');
    if (notesKey !== lastNotesKey) {
      lastNotesKey = notesKey;
      simNotesList.replaceChildren(...notes.map((n) => h('li', null, n)));
    }
    setHidden(simNotes, notes.length === 0);
    setText(maxd, sm ? formatDepth(sm.maxDepth) : '—');
    setText(maxdSub, rangeSub);
    setText(area, sm ? formatArea(sm.areaM2) : '—');
    setText(areaSub, rangeSub);
    const a = out.calibration?.boundaryAmplitude;
    setText(
      amp,
      Number.isFinite(a)
        ? `海岸での最大水位が目標値に近づくよう、沖合の境界から入れる波の振幅を ${a.toFixed(2)} m に自動調整しました。地形の影響で、目標値とずれることがあります。`
        : '海岸での最大水位が目標値に近づくよう、沖合の境界から入れる波の振幅を自動調整しています。',
    );
  };
  ctx.scope.add(ctx.watcher.subscribe(render));
  ctx.scope.add(store.select((s) => s.sim.status, render));
  ctx.scope.add(store.select((s) => s.params, render));
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

  const runLabel = h('span', null, 'シミュレーション実行');
  const runBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary btn-lg btn-block',
      onclick: () => {
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
  // 途中で止まった結果・地形の読み込み直しなどの知らせ（実行ボタンの上。常に見える位置）
  const noticeText = h('span');
  const notice = h('div', { class: 'callout callout-warning compact run-notice', role: 'status', hidden: true }, icon('alert', 16), noticeText);

  const render = () => {
    const s = store.get();
    const running = s.sim.status === 'running';
    const cov = resultCoverage(s);
    setHidden(progress, !running);
    setHidden(runBtn, running);
    const pctText = formatPercent(s.sim.progress);
    fill.style.width = pctText;
    progress.querySelector('.progress')?.setAttribute('aria-valuenow', String(Math.round(s.sim.progress * 100)));
    setText(pct, pctText);
    setText(msg, s.sim.message || '計算中…');
    setText(runLabel, cov ? 'この条件で再計算' : 'シミュレーション実行');
    let subText = '';
    if (running && s.sim.auto) {
      subText = `初めて開いたときの自動計算です（${autoRunLabel(s)}）。中止して条件を変えられます。`;
    } else if (!running) {
      if (s.terrain.status === 'loading') subText = s.sim.queued ? '地形データの読み込みが終わると自動で計算を始めます。' : '地形データの読み込み中です。実行すると、読み込み後に計算を始めます。';
      else if (s.terrain.status === 'error') subText = '実行すると、地形データの読み込みを再試行します。';
      else subText = `地震発生から${formatMinutes(s.params.durationMin)}後までを計算します。`;
    }
    setText(sub, subText);
    setHidden(sub, !subText);
    const err = s.sim.status === 'error' ? s.sim.message || '計算中にエラーが発生しました。' : '';
    error.replaceChildren(icon('alert', 16), h('span', null, `計算できませんでした: ${err}`));
    setHidden(error, !err);
    // 知らせ: 中止した途中までの結果（エラーの時は上のエラー表示に範囲を添える）・地形の読み込み直し
    let note = '';
    if (!running && cov && !cov.complete) note = `${cov.state === 'error' ? '' : '計算を中止しました。'}表示中の結果は地震発生から${formatSpan(cov.until)}までの途中の結果です。`;
    else if (!running && !cov && s.sim.status === 'idle' && s.sim.message && s.sim.message !== '計算を中止しました') note = s.sim.message;
    setText(noticeText, note);
    setHidden(notice, !note);
  };
  ctx.scope.add(store.select((s) => s.sim, render, true));
  ctx.scope.add(store.select((s) => s.terrain.status, render));
  ctx.scope.add(store.select((s) => s.terrain.grid, render));
  ctx.scope.add(store.select((s) => s.params.durationMin, render));
  ctx.scope.add(ctx.watcher.subscribe(render, false));

  // 状態の変化を読み上げ
  ctx.scope.add(
    store.select((s) => s.sim.status, (st, prev) => {
      if (st === 'running') ctx.announce('シミュレーションの計算を開始しました');
      else if (st === 'done') {
        const snap = ctx.watcher.snap;
        ctx.announce(completionAnnouncement(snap.output ? snap.summary : null, snap.output?.durationSec ?? store.get().params.durationMin * 60));
      }
      else if (st === 'error') ctx.announce('計算できませんでした');
      else if (prev === 'running') ctx.announce(store.get().sim.message || '計算を中止しました');
    }),
  );

  return h('div', { class: 'run-bar' }, staleNotice(ctx, 'run-stale'), notice, error, runBtn, sub, progress);
}

/**
 * 計算が完了したときの読み上げ（1 文の要約。数値には何の値かを添える）。
 * 浸水が無かった場合も「安全」とは言わない（このサイトの計算は公式の想定より浸水が狭く浅めに出る）。
 */
export function completionAnnouncement(
  summary: { firstArrival: number; maxDepth: number; areaM2: number } | null | undefined,
  durationSec: number,
): string {
  if (!summary) return '計算が完了しました';
  if (!Number.isFinite(summary.firstArrival)) {
    return `計算が完了しました。計算した${formatElapsed(durationSec)}の間に、陸域の浸水はありませんでした（このサイトの簡易計算。安全という意味ではありません）。`;
  }
  return `計算が完了しました。陸域で最初に浸水したのは地震発生から${formatElapsed(summary.firstArrival)}、最大浸水深は${formatDepth(summary.maxDepth)}、浸水した範囲は${formatArea(summary.areaM2)}です（このサイトの簡易計算）。`;
}

/** 自動計算の説明に使う、計算中の条件の名前 */
function autoRunLabel(s: AppState): string {
  return conditionsLabel(s) || `${s.params.scenario.shortName}・震度${SHINDO_LABEL[s.shindo]}`;
}
