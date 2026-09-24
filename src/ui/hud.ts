/**
 * 地図の上に重ねる表示（HUD）。
 * 時刻は毎フレーム変わるため、必要なノードの textContent / style だけを書き換える。
 */
import { SHINDO_LABEL, type AppState, type QuakeScenario, type ShindoLevel, type WarningLevel } from '../core/types';
import { formatElapsedMinutes, formatSpan } from '../core/format';
import { isResultStale, resultCoverage, resultParams, resultShindo, runConditionsLabel, usableOutput } from '../core/results';
import { INTENSITY_INFO } from '../data/intensity';
import { JMA_ISSUE_TARGET_NOTE, JMA_ISSUE_TARGET_SEC, WARNING_INFO, type WarningInfo } from '../data/warnings';
import { ARRIVAL_CLASSES, DEPTH_CLASSES, HAZARD_PORTAL_NOTICE, HAZARD_TSUNAMI_TILES } from '../data/sources';
import { PERSON_PROFILES } from '../people';
import { MOBILE_QUERY, safeCall, type UIContext } from './context';
import { h, setHidden, setText } from './dom';
import { formatDepth, formatElapsed, formatPercent, formatTP, isSafeColor, readableTextColor } from './format';
import { icon } from './icons';
import { interpolateSeries } from './series';
import { isCoarsePointer, placingDoneLabel, placingPrompt, watchPointer } from './pointer';

/**
 * 警報カードの表示のしかた。
 * - summary: 見出し・とるべき行動（2 行まで）・発表の目安（広い画面で最初に出たとき）
 * - compact: 見出しだけの 1 行（狭い画面では常にこの形。広い画面でも、出てからしばらくするとこの形にたたむ）
 * - expanded: 発表基準などの詳細まで
 * カードを押すと、詳細を開く（expanded）・たたむ（compact）を切り替える。
 */
export type WarnCardState = 'summary' | 'compact' | 'expanded';

/** 広い画面で、警報カードが出てから 1 行にたたむまで [ms]（地図の西側の海岸を覆い続けないように） */
export const WARN_AUTO_COMPACT_MS = 10_000;

/** カードを押したときの次の状態 */
export function nextWarnState(state: WarnCardState): WarnCardState {
  return state === 'expanded' ? 'compact' : 'expanded';
}

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

/**
 * 警報カードの本文（とるべき行動）と、詳細に添える参考。
 *
 * 津波予報（若干の海面変動）は、気象庁の「津波予報の発表条件」の表の 2 つの場合のうち、
 * 「0.2m未満の海面変動が予想されたとき」（被害の心配はなく、特段の防災対応の必要がない）がこの例にあたる。
 * もう一方の「津波注意報解除後も海面変動が継続するとき」の文言は、注意報が出ていないこの例には当てはまらないので、
 * 本文には出さず、参考として分けて示す。
 */
export function warningCardText(level: WarningLevel, w: Pick<WarningInfo, 'action' | 'damage'>): { action: string; reference: string } {
  if (level !== 'forecast') return { action: w.action ?? '', reference: '' };
  const damage = (w.damage ?? '').trim();
  const action = damage
    ? damage.endsWith('旨を発表します。')
      ? `${damage.slice(0, -'旨を発表します。'.length)}とされています（気象庁の津波予報）。`
      : damage
    : '';
  const raw = (w.action ?? '').trim();
  const POST_ADVISORY = '（津波注意報解除後も海面変動が継続するとき）';
  const reference = raw.startsWith(POST_ADVISORY) ? `参考: 津波注意報の解除後も海面変動が続くときの津波予報では、${raw.slice(POST_ADVISORY.length)}` : '';
  return { action: action || (reference ? '' : raw), reference };
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
  let warnState: WarnCardState = 'summary';
  const warnCard = h(
    'button',
    { type: 'button', class: 'hud-card hud-warn', hidden: true, 'aria-expanded': 'false' },
    icon('alert', 20),
    h('span', { class: 'hud-warn-text' }, warnLabel, warnAction, warnSub, warnNote),
    warnChev,
  );
  const applyWarnState = () => {
    const expanded = warnState === 'expanded';
    warnCard.classList.toggle('is-expanded', expanded);
    warnCard.classList.toggle('is-compact', warnState === 'compact');
    warnCard.dataset.state = warnState;
    warnCard.setAttribute('aria-expanded', String(expanded));
    warnChev.replaceChildren(icon(expanded ? 'chevronUp' : 'chevronDown', 16));
  };
  const setWarnState = (st: WarnCardState) => {
    if (st === warnState) return;
    warnState = st;
    clearWarnTimer();
    applyWarnState();
  };
  // 利用者が押して選んだ形は、同じ警報の間はそのまま（出し直しても最初の形に戻さない）
  let warnUserSet = false;
  let warnShown = false;
  warnCard.addEventListener('click', () => {
    warnUserSet = true;
    setWarnState(nextWarnState(warnState));
  });
  // 広い画面: 出てからしばらくすると 1 行にたたむ（押すと詳細を開ける。見出しはいつも見える）
  let warnTimer = 0;
  const clearWarnTimer = () => {
    if (warnTimer) window.clearTimeout(warnTimer);
    warnTimer = 0;
  };
  const armWarnTimer = () => {
    if (warnTimer || warnState !== 'summary') return;
    warnTimer = window.setTimeout(() => {
      warnTimer = 0;
      // キーボードで選んでいる間はたたまない
      if (warnState !== 'summary' || document.activeElement === warnCard) return;
      if (!warnCard.hidden) setWarnState('compact');
    }, WARN_AUTO_COMPACT_MS);
  };
  ctx.scope.add(clearWarnTimer);
  applyWarnState();

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

  // 表示中の結果が前の条件のもの・途中までのもの（中止・失敗）であることを常に見える位置で知らせる
  const resultText = h('span', { class: 'hud-chip-text' });
  const resultBtnLabel = h('span');
  const resultBtn = h('button', { type: 'button', class: 'hud-chip-btn', onclick: () => actions.runSimulation() }, icon('retry', 14), resultBtnLabel);
  const resultChip = h('div', { class: 'hud-chip hud-result', hidden: true, role: 'status' }, icon('alert', 16), resultText, resultBtn);

  const placingText = h('span', { class: 'hud-chip-text' });
  const placingDone = h('button', { type: 'button', class: 'hud-chip-btn', onclick: () => actions.startPlacing(null) }, placingDoneLabel(false));
  const placingChip = h('div', { class: 'hud-chip hud-placing', hidden: true, role: 'status' }, icon('pin', 16), placingText, placingDone);

  // ---- 下: カーソル位置の情報 ----------------------------------------------------
  const cursorText = h('span', { class: 'hud-chip-text' });
  const cursorChip = h('div', { class: 'hud-chip hud-cursor', hidden: true }, icon('crosshair', 16), cursorText);

  // ---- 右中央: 表示中の色分けの凡例 ------------------------------------------------
  const legend = createHudLegend(ctx, el);

  // 上中央は 2D 地図側のヒント・通知が使うため、状態チップは下中央にまとめる。
  // 四隅は地図の操作部品（2D）・視点リセット・倍率の注記・出典（3D）が使うので、凡例は右端の中央に置く
  el.replaceChildren(
    h('div', { class: 'hud-stack hud-tl' }, statusBar, shakeCard, warnCard),
    h('div', { class: 'hud-stack hud-bc' }, placingChip, simChip, resultChip, terrainChip, approxChip, cursorChip),
    legend,
  );

  // ---- 時刻に連動する表示 ----------------------------------------------------------
  // 狭い画面では、1 時間を過ぎても分で数える（「80分30秒」。「1時間20分30秒」だと帯が 1 時間を境に大きく伸び、
  // 3D 表示の右上の部品に近づく）。広い画面は「1時間20分30秒」
  const narrow = window.matchMedia(MOBILE_QUERY);
  const updateTime = () => {
    const s = store.get();
    const t = s.time.t;
    setText(timeValue, narrow.matches ? formatElapsedMinutes(t) : formatElapsed(t));

    // 揺れ（表示中の結果の条件で。震度・シナリオを選び直しても、再計算するまでは地図の浸水と同じ条件）
    const sc = resultParams(s).scenario;
    const shindo = resultShindo(s);
    const shaking = (s.time.playing || t > 0) && t < sc.shakingSec && shindo !== '0';
    setHidden(shakeCard, !shaking);
    if (shaking) {
      const strong = STRONG_LEVELS.includes(shindo);
      setText(shakeText, `${strong ? '強い揺れ' : '揺れ'}（震度${SHINDO_LABEL[shindo]}）`);
    }

    // 津波警報等（近くの地震は気象庁の発表目標の約3分から。遠地津波の例は発表時刻を示さず、再生を始めたら表示）
    const warn = WARNING_INFO[sc.warning];
    const showAt = warningShowSec(sc);
    const showWarn = !!warn && (showAt !== null ? t >= showAt : sc.warning !== 'none' && (s.time.playing || t > 0));
    setHidden(warnCard, !showWarn);
    if (showWarn && !warnShown && !warnUserSet && warnState !== 'summary') {
      // 出し直したとき（時刻を戻して再生した等）は、もう一度とるべき行動まで見せる
      warnState = 'summary';
      applyWarnState();
    }
    warnShown = showWarn;
    if (showWarn) armWarnTimer();
    else clearWarnTimer();

    // 水位
    const out = usableOutput(s);
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
  const onNarrow = () => updateTime();
  narrow.addEventListener('change', onNarrow);
  ctx.scope.add(() => narrow.removeEventListener('change', onNarrow));
  ctx.scope.add(store.select((s) => s.time.t, updateTime, true));
  ctx.scope.add(store.select((s) => s.time.playing, updateTime));
  ctx.scope.add(store.select((s) => s.sim.output, updateTime));
  ctx.scope.add(store.select((s) => s.terrain.grid, updateTime));
  ctx.scope.add(store.select(resultShindo, updateTime));
  ctx.scope.add(store.select((s) => resultParams(s).scenario, updateTime));

  // 警報の見た目（表示中の結果のシナリオが変わった時のみ）
  ctx.scope.add(
    store.select((s) => resultParams(s).scenario, (sc) => {
      const level = sc.warning;
      const w = WARNING_INFO[level];
      if (!w) return;
      // 別の区分の警報になったら、もう一度とるべき行動まで見せる（広い画面）
      if (warnCard.dataset.level !== level) {
        clearWarnTimer();
        warnUserSet = false;
        warnState = 'summary';
        applyWarnState();
      }
      const bg = isSafeColor(w.color) ? w.color : '#7e22ce';
      warnCard.style.setProperty('--warn-bg', bg);
      warnCard.style.setProperty('--warn-fg', isSafeColor(w.textColor) ? w.textColor : readableTextColor(bg));
      warnCard.dataset.level = level;
      setText(warnLabel, `${w.label}（想定）`);
      const text = warningCardText(level, w);
      setText(warnAction, text.action);
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
      setText(warnNote, [w.heightRange ? `発表基準: ${w.heightRange}` : '', note, text.reference].filter(Boolean).join('\n'));
      warnCard.title = [w.label, w.heightRange, text.action, note, text.reference].filter(Boolean).join('\n');
    }, true),
  );

  // 揺れ表示の色
  ctx.scope.add(
    store.select(resultShindo, (lv) => {
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

  // ---- 表示中の結果: 前の条件・途中まで ------------------------------------------------
  const renderResult = () => {
    const s = store.get();
    const stale = isResultStale(s);
    const cov = resultCoverage(s);
    const running = s.sim.status === 'running';
    const partial = !!cov && !cov.complete && !running;
    let text = '';
    let btn = '';
    if (stale) {
      const label = runConditionsLabel(s, (lv) => SHINDO_LABEL[lv]);
      if (running) {
        text = `計算中の結果は前の条件（${label}）です`;
        btn = 'この条件で計算し直す';
      } else if (partial) {
        text = `表示中の結果は前の条件（${label}）の、地震発生から${formatSpan(cov.until)}までの途中の結果です`;
        btn = '再計算';
      } else {
        text = `表示中の結果は前の条件（${label}）です`;
        btn = '再計算';
      }
    } else if (partial) {
      text = `${cov.state === 'error' ? '計算が途中で止まりました' : '計算を中止しました'}（結果は地震発生から${formatSpan(cov.until)}まで）`;
      btn = '計算し直す';
    }
    setHidden(resultChip, !text);
    resultChip.dataset.kind = stale ? 'stale' : partial ? 'partial' : '';
    setText(resultText, text);
    setText(resultBtnLabel, btn);
  };
  ctx.scope.add(store.select((s) => s.sim, renderResult, true));
  ctx.scope.add(store.select((s) => s.params, renderResult));
  ctx.scope.add(store.select((s) => s.terrain.grid, renderResult));

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
  // 2D 地図は自前で配置ヒントを出すので、HUD のチップは 3D 表示のときだけ出す。
  // タッチ操作の端末では「タップ」と書き、Esc キーの案内は出さない
  const renderPlacing = () => {
    const { placing: kind, view } = store.get();
    setHidden(placingChip, !kind || view !== '3d');
    const coarse = isCoarsePointer();
    setText(placingDone, placingDoneLabel(coarse));
    if (kind) setText(placingText, placingPrompt(PERSON_PROFILES[kind]?.label ?? kind, coarse));
  };
  ctx.scope.add(store.select((s) => s.placing, renderPlacing, true));
  ctx.scope.add(store.select((s) => s.view, renderPlacing));
  ctx.scope.add(watchPointer(renderPlacing));

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
function createHudLegend(ctx: UIContext, hud: HTMLElement): HTMLElement {
  const { store } = ctx;
  // 狭い画面・地図の幅が狭いとき（タブレットの縦向きなど）は、最初はたたんでおく（開閉は覚える）
  const narrow = ctx.isMobile() || (hud.clientWidth > 0 && hud.clientWidth < 600);
  let collapsed = readLegendCollapsed(narrow);

  const depthTitle = h('span', { class: 'hud-legend-title' });
  const depthSub = h('span', { class: 'hud-legend-sub' });
  const hazardNote = h(
    'p',
    { class: 'hud-legend-note' },
    '神奈川県（平成27年）・最大クラスの5地震の重ね合わせ。このサイトの計算は公式の想定より浸水が狭く浅めに出ます。',
    HAZARD_PORTAL_NOTICE,
  );
  // 公式ハザードマップの配信元に接続できないとき（地図には色が無いだけに見えるので、凡例だけを出さない）
  const hazardWarn = h(
    'p',
    { class: 'hud-legend-warn', role: 'status', hidden: true },
    icon('alert', 12),
    h('span', null, '公式ハザードマップを読み込めません。色が付いていない場所も浸水想定区域の可能性があります（藤沢市の津波ハザードマップで確認してください）。'),
  );
  const depthSwatches = swatchRows(DEPTH_CLASSES.map((c) => ({ label: c.label, color: c.color })));
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
    hazardWarn,
    depthSwatches,
    seaRows,
    hazardNote,
  );
  const arrivalSub = h('span', { class: 'hud-legend-sub' }, '地震発生から浸水が始まるまで');
  const arrivalBlock = h(
    'div',
    { class: 'hud-legend-block' },
    h('div', { class: 'hud-legend-head' }, h('span', { class: 'hud-legend-title' }, '津波到達時間（計算）'), arrivalSub),
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
    const out = !!usableOutput(s);
    // 最大浸水深・到達時間は、途中までの結果ならその範囲を示す（「浸水なし」の場所が本当に浸水しないとは限らない）
    const cov = resultCoverage(s);
    const range = !cov || cov.complete ? '' : cov.state === 'running' ? '計算中（途中まで）' : `0〜${formatSpan(cov.until)}のみ計算`;
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
    // 公式ハザードマップの配信元に接続できない: 表示できていないことを示し、公式だけのときは色の凡例を出さない
    const hazardFailed = hazard && s.officialInundation.display === 'error';
    setHidden(hazardWarn, !hazardFailed);
    setHidden(depthSwatches, hazardFailed && !simDepth);
    // 海の色分けは 2D 地図の「浸水（現在時刻）」レイヤーのもの（3D は水面として描く）
    setHidden(seaRows, !floodColored);
    if (hazard && simDepth) {
      setText(depthTitle, '浸水深');
      setText(depthSub, '公式の津波浸水想定と計算結果は同じ色分け');
    } else if (hazard) {
      setText(depthTitle, '津波浸水想定（公式）');
      setText(depthSub, hazardFailed ? '表示できていません' : '浸水深（基準水位ではありません）');
    } else if (maxColored) {
      setText(depthTitle, floodColored ? '浸水深（計算）' : '最大浸水深（計算）');
      setText(depthSub, floodColored ? `現在時刻・最大とも同じ色分け${range ? `（最大は${range}）` : ''}` : range ? `${range}の間の最大` : '計算した時間内の最大');
    } else {
      setText(depthTitle, '浸水深（計算）');
      setText(depthSub, 'タイムラインの時刻');
    }
    setText(arrivalSub, range ? `地震発生から浸水が始まるまで（${range}）` : '地震発生から浸水が始まるまで');
    el.title = hazard ? `${HAZARD_TSUNAMI_TILES.label}\n${HAZARD_TSUNAMI_TILES.notes ?? ''}` : '';
  };
  ctx.scope.add(store.select((s) => s.layers, render, true));
  ctx.scope.add(store.select((s) => s.officialInundation.display, render));
  ctx.scope.add(store.select((s) => s.sim, render));
  ctx.scope.add(store.select((s) => s.terrain.grid, render));
  ctx.scope.add(store.select((s) => s.view, render));
  return el;
}
