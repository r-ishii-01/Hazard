/**
 * 地図の上に重ねる表示（HUD）。
 * 時刻は毎フレーム変わるため、必要なノードの textContent / style だけを書き換える。
 */
import { SHINDO_LABEL, type AppState, type QuakeScenario, type ShindoLevel } from '../core/types';
import { INTENSITY_INFO } from '../data/intensity';
import { JMA_ISSUE_TARGET_NOTE, JMA_ISSUE_TARGET_SEC, WARNING_INFO } from '../data/warnings';
import { ARRIVAL_CLASSES, DEPTH_CLASSES, HAZARD_PORTAL_NOTICE, HAZARD_TSUNAMI_TILES } from '../data/sources';
import { PERSON_PROFILES } from '../people';
import { safeCall, type UIContext } from './context';
import { h, setHidden, setText } from './dom';
import { formatDepth, formatElapsed, formatPercent, formatTP, isSafeColor, readableTextColor } from './format';
import { icon } from './icons';
import { interpolateSeries } from './series';

/**
 * 遠地津波の例か（揺れを感じない遠くの地震）。
 * 気象庁の「約3分を目標に発表」は近くの地震の話で、遠地地震では発表までにもっと時間がかかる
 * （参考にした 2025年7月30日の地震では13分後に津波注意報、76分後に津波警報へ切替: data/scenarios.ts の説明文）。
 */
export function isFarField(sc: Pick<QuakeScenario, 'id' | 'shindo'>): boolean {
  return sc.id === 'example-farfield' || sc.shindo === '0';
}

/** 気象庁の発表目標の表示（例:「約3分」） */
export const JMA_ISSUE_TARGET_LABEL = `約${Math.round(JMA_ISSUE_TARGET_SEC / 60)}分`;

/**
 * 津波警報等が表示される時刻 [秒]。近くの地震は気象庁の発表目標（約3分）、
 * 遠地津波の例は発表時刻を示さない（null）。
 */
export function warningShowSec(sc: Pick<QuakeScenario, 'id' | 'shindo' | 'warning'>): number | null {
  if (sc.warning === 'none') return null;
  return isFarField(sc) ? null : JMA_ISSUE_TARGET_SEC;
}

/** HUD の凡例を折りたたんでいるか（閲覧者ごとの見た目の好みだけを保存） */
const LEGEND_KEY = 'kugenuma-hud-legend-collapsed';
function readLegendCollapsed(fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(LEGEND_KEY);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writeLegendCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(LEGEND_KEY, v ? '1' : '0');
  } catch {
    /* 保存できなくても表示には影響しない */
  }
}

/** 震度4以上を「強い揺れ」と表示する */
const STRONG_LEVELS: ShindoLevel[] = ['4', '5-', '5+', '6-', '6+', '7'];

export function mountHud(el: HTMLElement, ctx: UIContext): void {
  const { store, actions } = ctx;

  // ---- 左上: 経過時間・揺れ・警報・水位 ----------------------------------------
  // 幅の狭い画面（< 820px）では、経過時間と水位を 1 つの帯にまとめ、警報は 1 行のチップ（タップで詳細）にする（hud.css）
  const timeValue = h('span', { class: 'hud-time-value' }, '0秒');
  const timeCard = h('div', { class: 'hud-card hud-time' }, h('span', { class: 'hud-label' }, '地震発生から'), timeValue);

  const shakeText = h('span');
  const shakeCard = h('div', { class: 'hud-card hud-shake', hidden: true }, icon('quake', 18), shakeText);

  const warnLabel = h('strong', { class: 'hud-warn-label' });
  const warnAction = h('span', { class: 'hud-warn-action' });
  const warnSub = h('span', { class: 'hud-warn-sub' });
  const warnNote = h('span', { class: 'hud-warn-note' });
  const warnChev = h('span', { class: 'hud-warn-chev', 'aria-hidden': 'true' });
  let warnExpanded = false;
  const warnCard = h(
    'button',
    { type: 'button', class: 'hud-card hud-warn', hidden: true, 'aria-expanded': 'false' },
    icon('alert', 20),
    h('span', { class: 'hud-warn-text' }, warnLabel, warnAction, warnSub, warnNote),
    warnChev,
  );
  const applyWarnExpanded = () => {
    warnCard.classList.toggle('is-expanded', warnExpanded);
    warnCard.setAttribute('aria-expanded', String(warnExpanded));
    warnChev.replaceChildren(icon(warnExpanded ? 'chevronUp' : 'chevronDown', 16));
  };
  warnCard.addEventListener('click', () => {
    warnExpanded = !warnExpanded;
    applyWarnExpanded();
  });
  applyWarnExpanded();

  const levelValue = h('span', { class: 'hud-level-value' });
  const levelArrow = h('span', { class: 'hud-level-arrow', 'aria-hidden': 'true' });
  const levelWord = h('span', { class: 'hud-level-word' });
  const levelTrend = h('span', { class: 'hud-level-trend' }, levelArrow, levelWord);
  const levelCard = h(
    'div',
    { class: 'hud-card hud-level', hidden: true },
    h('span', { class: 'hud-label' }, h('span', { class: 'hud-label-long' }, '鵠沼海岸沖の水位（計算）'), h('span', { class: 'hud-label-short', 'aria-hidden': 'true' }, '沖の水位（計算）')),
    h('span', { class: 'hud-level-row' }, levelValue, levelTrend),
  );
  /** 経過時間と水位（狭い画面では 1 つの帯） */
  const statusBar = h('div', { class: 'hud-status' }, timeCard, levelCard);

  // ---- 中央上: 計算・地形・配置モード ------------------------------------------
  const simFill = h('span', { class: 'progress-fill' });
  const simText = h('span', { class: 'hud-chip-text' });
  const simChip = h(
    'div',
    { class: 'hud-chip hud-sim', hidden: true, role: 'status' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    simText,
    h('span', { class: 'progress progress-inline', 'aria-hidden': 'true' }, simFill),
  );

  const terrainText = h('span', { class: 'hud-chip-text' });
  const terrainRetry = h('button', { type: 'button', class: 'hud-chip-btn', onclick: () => actions.reloadTerrain() }, icon('retry', 14), '再試行');
  const terrainChip = h('div', { class: 'hud-chip hud-terrain', hidden: true }, icon('alert', 16), terrainText, terrainRetry);

  const approxChip = h(
    'div',
    {
      class: 'hud-chip hud-approx',
      hidden: true,
      title: '国土地理院の標高データを取得できなかったため、簡易地形モデルで表示しています。実際の地形とは異なります。',
    },
    icon('alert', 16),
    h('span', { class: 'hud-chip-text' }, '簡易地形モデルで表示中（実際の地形とは異なります）'),
  );

  const placingText = h('span', { class: 'hud-chip-text' });
  const placingChip = h(
    'div',
    { class: 'hud-chip hud-placing', hidden: true, role: 'status' },
    icon('pin', 16),
    placingText,
    h('button', { type: 'button', class: 'hud-chip-btn', onclick: () => actions.startPlacing(null) }, '終了（Esc）'),
  );

  // ---- 下: カーソル位置の情報 ----------------------------------------------------
  const cursorText = h('span', { class: 'hud-chip-text' });
  const cursorChip = h('div', { class: 'hud-chip hud-cursor', hidden: true }, icon('crosshair', 16), cursorText);

  // ---- 右中央: 表示中の色分けの凡例 ------------------------------------------------
  const legend = createHudLegend(ctx);

  // 上中央は 2D 地図側のヒント・通知が使うため、状態チップは下中央にまとめる。
  // 四隅は地図の操作部品（2D）・視点リセット・倍率の注記・出典（3D）が使うので、凡例は右端の中央に置く
  el.replaceChildren(
    h('div', { class: 'hud-stack hud-tl' }, statusBar, shakeCard, warnCard),
    h('div', { class: 'hud-stack hud-bc' }, placingChip, simChip, terrainChip, approxChip, cursorChip),
    legend,
  );

  // ---- 時刻に連動する表示 ----------------------------------------------------------
  const updateTime = () => {
    const s = store.get();
    const t = s.time.t;
    setText(timeValue, formatElapsed(t));

    // 揺れ
    const sc = s.params.scenario;
    const shaking = (s.time.playing || t > 0) && t < sc.shakingSec && s.shindo !== '0';
    setHidden(shakeCard, !shaking);
    if (shaking) {
      const strong = STRONG_LEVELS.includes(s.shindo);
      setText(shakeText, `${strong ? '強い揺れ' : '揺れ'}（震度${SHINDO_LABEL[s.shindo]}）`);
    }

    // 津波警報等（近くの地震は気象庁の発表目標の約3分から。遠地津波の例は発表時刻を示さず、再生を始めたら表示）
    const warn = WARNING_INFO[sc.warning];
    const showAt = warningShowSec(sc);
    const showWarn = !!warn && (showAt !== null ? t >= showAt : sc.warning !== 'none' && (s.time.playing || t > 0));
    setHidden(warnCard, !showWarn);

    // 水位
    const out = s.sim.output;
    const n = out ? safeCall(() => out.gauge.count(), 0) : 0;
    setHidden(levelCard, !out || n === 0);
    statusBar.classList.toggle('has-level', !!out && n > 0);
    if (out && n > 0) {
      const g = out.gauge;
      const eta = interpolateSeries(g.t, g.eta, n, t);
      if (Number.isFinite(eta)) {
        setText(levelValue, formatTP(eta));
        const before = interpolateSeries(g.t, g.eta, n, Math.max(0, t - 20));
        const d = Number.isFinite(before) ? eta - before : 0;
        setText(levelArrow, d > 0.03 ? '▲' : d < -0.03 ? '▼' : '');
        setText(levelWord, d > 0.03 ? '上昇中' : d < -0.03 ? '下降中' : '');
        levelTrend.dataset.dir = d > 0.03 ? 'up' : d < -0.03 ? 'down' : '';
      } else {
        const last = g.t[n - 1];
        setText(levelValue, '—');
        setText(levelArrow, '');
        setText(levelWord, t > last ? '計算中' : '引き波で海底が露出');
        levelTrend.dataset.dir = '';
      }
    }
  };
  ctx.scope.add(store.select((s) => s.time.t, updateTime, true));
  ctx.scope.add(store.select((s) => s.time.playing, updateTime));
  ctx.scope.add(store.select((s) => s.sim.output, updateTime));
  ctx.scope.add(store.select((s) => s.shindo, updateTime));

  // 警報の見た目（シナリオが変わった時のみ）
  ctx.scope.add(
    store.select((s) => s.params.scenario, (sc) => {
      const level = sc.warning;
      const w = WARNING_INFO[level];
      if (!w) return;
      const bg = isSafeColor(w.color) ? w.color : '#7e22ce';
      warnCard.style.setProperty('--warn-bg', bg);
      warnCard.style.setProperty('--warn-fg', isSafeColor(w.textColor) ? w.textColor : readableTextColor(bg));
      warnCard.dataset.level = level;
      setText(warnLabel, `${w.label}（想定）`);
      setText(warnAction, w.action ?? '');
      const issued = level === 'advisory' || level === 'warning' || level === 'major';
      let sub = '';
      let note = '';
      if (issued && isFarField(sc)) {
        sub = '遠くの地震のため、発表の時刻はこの例では示していません';
        note =
          '遠くで起きた地震では、津波警報・注意報の発表までに時間がかかることがあります。この例で参考にした2025年7月30日の地震では、地震の13分後に津波注意報、76分後に津波警報に切り替えられました（気象庁）。この例は津波の到達を短縮しているため、発表の時刻は示していません。';
      } else if (issued) {
        sub = `気象庁の発表目標: 地震発生から${JMA_ISSUE_TARGET_LABEL}`;
        note = JMA_ISSUE_TARGET_NOTE;
      }
      setText(warnSub, sub);
      // 詳細（タップ・クリックで開く）: 発表基準と、発表の時刻についての注記（気象庁）
      setText(warnNote, [w.heightRange ? `発表基準: ${w.heightRange}` : '', note].filter(Boolean).join('\n'));
      warnCard.title = [w.label, w.heightRange, w.action, note].filter(Boolean).join('\n');
    }, true),
  );

  // 揺れ表示の色
  ctx.scope.add(
    store.select((s) => s.shindo, (lv) => {
      const c = INTENSITY_INFO[lv]?.color;
      const bg = isSafeColor(c) ? c : '#dc2626';
      shakeCard.style.setProperty('--shake-bg', bg);
      shakeCard.style.setProperty('--shake-fg', readableTextColor(bg));
    }, true),
  );

  // ---- 計算の進み具合 -------------------------------------------------------------
  ctx.scope.add(
    store.select((s) => s.sim, (sim) => {
      const running = sim.status === 'running';
      setHidden(simChip, !running);
      if (running) {
        // 計算側のメッセージ（例:「計算中… 地震発生から 12分（3並列）」）をそのまま出す
        const msg = (sim.message ?? '').trim() || '計算中…';
        setText(simText, `${msg} ${formatPercent(sim.progress)}`);
        simFill.style.width = formatPercent(sim.progress);
        simChip.title = sim.auto ? `${msg}\n初めて開いたときの自動計算です。「地震・津波」タブで中止・条件の変更ができます。` : msg;
      }
    }, true),
  );

  // ---- 地形 ---------------------------------------------------------------------
  ctx.scope.add(
    store.select((s) => s.terrain, (tr) => {
      const loading = tr.status === 'loading';
      const error = tr.status === 'error';
      setHidden(terrainChip, !(loading || error));
      setHidden(terrainRetry, !error);
      terrainChip.dataset.state = tr.status;
      if (loading) setText(terrainText, `地形データを読み込み中 ${formatPercent(tr.progress)}`);
      else if (error) setText(terrainText, '地形データを読み込めませんでした');
      setHidden(approxChip, !(tr.status === 'ready' && tr.grid?.isApproximate));
    }, true),
  );

  // ---- 配置モード -------------------------------------------------------------------
  // 2D 地図は自前で配置ヒントを出すので、HUD のチップは 3D 表示のときだけ出す
  const renderPlacing = () => {
    const { placing: kind, view } = store.get();
    setHidden(placingChip, !kind || view !== '3d');
    if (kind) setText(placingText, `地図をクリックして「${PERSON_PROFILES[kind]?.label ?? kind}」を配置`);
  };
  ctx.scope.add(store.select((s) => s.placing, renderPlacing, true));
  ctx.scope.add(store.select((s) => s.view, renderPlacing));

  // ---- カーソル -----------------------------------------------------------------------
  ctx.scope.add(
    store.select((s) => s.cursor, (c) => {
      setHidden(cursorChip, !c);
      if (!c) return;
      setText(cursorText, describeCursor(c, store.get()));
    }, true),
  );
}

/** カーソル位置の説明（陸: 地盤高・浸水深、海・川: 水底の高さ・水深） */
export function describeCursor(c: NonNullable<AppState['cursor']>, s: Pick<AppState, 'params'>): string {
  if (c.ground === null) return '計算範囲外';
  if (c.kind === 'sea') {
    // 海・川の水底の高さは実測ではなく推定（地形データの注記を参照）
    const parts = ['海・川', `水底 ${formatTP(c.ground)}（推定）`];
    if (c.waterDepth !== undefined && Number.isFinite(c.waterDepth)) {
      parts.push(c.waterDepth >= 0.01 ? `水深 ${formatDepth(c.waterDepth)}` : '引き波で水底が露出');
    } else {
      const still = s.params.tideTP - c.ground;
      if (Number.isFinite(still) && still > 0) parts.push(`水深 ${formatDepth(still)}（地震前）`);
    }
    return parts.join('　');
  }
  const parts = [`地盤高 ${formatTP(c.ground)}`];
  if (c.depth !== null) parts.push(c.depth >= 0.01 ? `浸水深 ${formatDepth(c.depth)}` : '浸水なし');
  return parts.join('　');
}

// ---------------------------------------------------------------------------
// 凡例（右中央）
// ---------------------------------------------------------------------------

function swatchRows(items: { label: string; color: string }[]): HTMLElement {
  return h(
    'ul',
    { class: 'hud-legend-list' },
    items.map((it) => h('li', null, h('span', { class: 'hud-swatch', style: { background: isSafeColor(it.color) ? it.color : 'transparent' }, 'aria-hidden': 'true' }), h('span', null, it.label))),
  );
}

/**
 * 表示中の色分けの凡例。公式の津波浸水想定（重ねるハザードマップ）と計算結果の浸水深は同じ配色
 * （data/sources.ts の DEPTH_CLASSES）なので1つにまとめ、どちらを表示中かを見出しで示す。
 */
function createHudLegend(ctx: UIContext): HTMLElement {
  const { store } = ctx;
  const narrow = ctx.isMobile();
  let collapsed = readLegendCollapsed(narrow);

  const depthTitle = h('span', { class: 'hud-legend-title' });
  const depthSub = h('span', { class: 'hud-legend-sub' });
  const hazardNote = h('p', { class: 'hud-legend-note' }, '神奈川県（平成27年）・最大クラスの5地震の重ね合わせ。', HAZARD_PORTAL_NOTICE);
  const seaRows = h(
    'ul',
    { class: 'hud-legend-list hud-legend-sea' },
    h('li', null, h('span', { class: 'hud-swatch', style: { background: 'linear-gradient(90deg, #06b6d4, #e0faff)' }, 'aria-hidden': 'true' }), h('span', null, '海面の上昇')),
    h('li', null, h('span', { class: 'hud-swatch', style: { background: 'linear-gradient(90deg, #4f7fd9, #0c1e48)' }, 'aria-hidden': 'true' }), h('span', null, '海面の低下（引き波）')),
    h('li', null, h('span', { class: 'hud-swatch', style: { background: 'linear-gradient(90deg, #d6be8c, #846c46)' }, 'aria-hidden': 'true' }), h('span', null, '露出した海底')),
  );
  const depthBlock = h(
    'div',
    { class: 'hud-legend-block' },
    h('div', { class: 'hud-legend-head' }, depthTitle, depthSub),
    swatchRows(DEPTH_CLASSES.map((c) => ({ label: c.label, color: c.color }))),
    seaRows,
    hazardNote,
  );
  const arrivalBlock = h(
    'div',
    { class: 'hud-legend-block' },
    h('div', { class: 'hud-legend-head' }, h('span', { class: 'hud-legend-title' }, '津波到達時間（計算）'), h('span', { class: 'hud-legend-sub' }, '地震発生から浸水が始まるまで')),
    swatchRows(ARRIVAL_CLASSES.map((c) => ({ label: c.label, color: c.color }))),
  );
  const body = h('div', { class: 'hud-legend-body', id: 'hud-legend-body' }, arrivalBlock, depthBlock);
  const toggleLabel = h('span', null, '凡例');
  const chevron = h('span', { class: 'hud-legend-chev', 'aria-hidden': 'true' });
  const toggle = h(
    'button',
    { type: 'button', class: 'hud-legend-toggle', 'aria-controls': 'hud-legend-body', 'aria-expanded': 'true' },
    icon('layers', 14),
    toggleLabel,
    chevron,
  );
  const el = h('div', { class: 'hud-legend', role: 'region', 'aria-label': '地図の凡例', hidden: true }, toggle, body);

  const applyCollapsed = () => {
    el.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? '凡例を表示' : '凡例をたたむ';
    chevron.replaceChildren(icon(collapsed ? 'chevronDown' : 'chevronUp', 14));
    setHidden(body, collapsed);
  };
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    writeLegendCollapsed(collapsed);
    applyCollapsed();
  });
  applyCollapsed();

  const render = () => {
    const s = store.get();
    const L = s.layers;
    const out = !!s.sim.output;
    const hazard = L.officialHazard;
    const is2d = s.view === '2d';
    // 3D の「浸水（現在時刻）」は色分けでなく水面として描くので、浸水深の色分けは最大浸水深のときだけ。
    // 3D の地形の色分けは最大浸水深と到達時間のどちらか一方（最大浸水深が優先）
    const floodColored = out && L.simFlood && is2d;
    const maxColored = out && L.maxDepth;
    const simDepth = floodColored || maxColored;
    const arrival = out && L.arrival && (is2d || !L.maxDepth);
    setHidden(el, !(hazard || simDepth || arrival));
    setHidden(arrivalBlock, !arrival);
    setHidden(depthBlock, !(hazard || simDepth));
    setHidden(hazardNote, !hazard);
    // 海の色分けは 2D 地図の「浸水（現在時刻）」レイヤーのもの（3D は水面として描く）
    setHidden(seaRows, !floodColored);
    if (hazard && simDepth) {
      setText(depthTitle, '浸水深');
      setText(depthSub, '公式の津波浸水想定と計算結果は同じ色分け');
    } else if (hazard) {
      setText(depthTitle, '津波浸水想定（公式）');
      setText(depthSub, '浸水深（基準水位ではありません）');
    } else if (maxColored) {
      setText(depthTitle, floodColored ? '浸水深（計算）' : '最大浸水深（計算）');
      setText(depthSub, floodColored ? '現在時刻・最大とも同じ色分け' : '計算した時間内の最大');
    } else {
      setText(depthTitle, '浸水深（計算）');
      setText(depthSub, 'タイムラインの時刻');
    }
    el.title = hazard ? `${HAZARD_TSUNAMI_TILES.label}\n${HAZARD_TSUNAMI_TILES.notes ?? ''}` : '';
  };
  ctx.scope.add(store.select((s) => s.layers, render, true));
  ctx.scope.add(store.select((s) => s.sim.output, render));
  ctx.scope.add(store.select((s) => s.view, render));
  return el;
}
