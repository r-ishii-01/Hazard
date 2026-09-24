/**
 * 地図の上に重ねる表示（HUD）。
 * 時刻は毎フレーム変わるため、必要なノードの textContent / style だけを書き換える。
 */
import { SHINDO_LABEL, type ShindoLevel } from '../core/types';
import { INTENSITY_INFO } from '../data/intensity';
import { WARNING_INFO } from '../data/warnings';
import { PERSON_PROFILES } from '../people';
import { safeCall, type UIContext } from './context';
import { h, setHidden, setText } from './dom';
import { formatDepth, formatElapsed, formatPercent, formatTP, isSafeColor, readableTextColor } from './format';
import { icon } from './icons';
import { interpolateSeries } from './series';

/**
 * 津波警報等の発表の目安 [秒]。
 * 気象庁は「地震が発生してから約3分を目標に」大津波警報・津波警報・津波注意報を発表する。
 * 気象庁「津波警報・注意報、津波情報、津波予報について」（URL は links.ts の JMA_TSUNAMI_WARNING_URL）
 */
export const WARNING_ISSUE_SEC = 180;

/** 震度4以上を「強い揺れ」と表示する */
const STRONG_LEVELS: ShindoLevel[] = ['4', '5-', '5+', '6-', '6+', '7'];

export function mountHud(el: HTMLElement, ctx: UIContext): void {
  const { store, actions } = ctx;

  // ---- 左上: 経過時間・揺れ・警報・水位 ----------------------------------------
  const timeValue = h('span', { class: 'hud-time-value' }, '0秒');
  const timeCard = h('div', { class: 'hud-card hud-time' }, h('span', { class: 'hud-label' }, '地震発生から'), timeValue);

  const shakeText = h('span');
  const shakeCard = h('div', { class: 'hud-card hud-shake', hidden: true }, icon('quake', 18), shakeText);

  const warnLabel = h('strong', { class: 'hud-warn-label' });
  const warnAction = h('span', { class: 'hud-warn-action' });
  const warnSub = h('span', { class: 'hud-warn-sub' });
  const warnCard = h('div', { class: 'hud-card hud-warn', hidden: true }, icon('alert', 20), h('span', { class: 'hud-warn-text' }, warnLabel, warnAction, warnSub));

  const levelValue = h('span', { class: 'hud-level-value' });
  const levelTrend = h('span', { class: 'hud-level-trend' });
  const levelCard = h(
    'div',
    { class: 'hud-card hud-level', hidden: true },
    h('span', { class: 'hud-label' }, '鵠沼海岸沖の水位（計算）'),
    h('span', { class: 'hud-level-row' }, levelValue, levelTrend),
  );

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

  // 上中央は 2D 地図側のヒント・通知が使うため、状態チップは下中央にまとめる
  el.replaceChildren(
    h('div', { class: 'hud-stack hud-tl' }, timeCard, shakeCard, warnCard, levelCard),
    h('div', { class: 'hud-stack hud-bc' }, placingChip, simChip, terrainChip, approxChip, cursorChip),
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

    // 津波警報等（発表の目安 3 分）
    const warn = WARNING_INFO[sc.warning];
    const showWarn = !!warn && t >= WARNING_ISSUE_SEC;
    setHidden(warnCard, !showWarn);

    // 水位
    const out = s.sim.output;
    const n = out ? safeCall(() => out.gauge.count(), 0) : 0;
    setHidden(levelCard, !out || n === 0);
    if (out && n > 0) {
      const g = out.gauge;
      const eta = interpolateSeries(g.t, g.eta, n, t);
      if (Number.isFinite(eta)) {
        setText(levelValue, formatTP(eta));
        const before = interpolateSeries(g.t, g.eta, n, Math.max(0, t - 20));
        const d = Number.isFinite(before) ? eta - before : 0;
        setText(levelTrend, d > 0.03 ? '▲ 上昇中' : d < -0.03 ? '▼ 下降中' : '');
        levelTrend.dataset.dir = d > 0.03 ? 'up' : d < -0.03 ? 'down' : '';
      } else {
        const last = g.t[n - 1];
        setText(levelValue, '—');
        setText(levelTrend, t > last ? '計算中' : '引き波で海底が露出');
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
    store.select((s) => s.params.scenario.warning, (level) => {
      const w = WARNING_INFO[level];
      if (!w) return;
      const bg = isSafeColor(w.color) ? w.color : '#7e22ce';
      warnCard.style.setProperty('--warn-bg', bg);
      warnCard.style.setProperty('--warn-fg', isSafeColor(w.textColor) ? w.textColor : readableTextColor(bg));
      warnCard.dataset.level = level;
      setText(warnLabel, `${w.label}（想定）`);
      setText(warnAction, w.action ?? '');
      warnCard.title = [w.label, w.heightRange, w.action].filter(Boolean).join('\n');
      const issued = level === 'advisory' || level === 'warning' || level === 'major';
      setText(warnSub, issued ? '発表の目安: 地震発生から約3分' : '');
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
        setText(simText, `計算中 ${formatPercent(sim.progress)}`);
        simFill.style.width = formatPercent(sim.progress);
        simChip.title = sim.message ?? '';
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
      if (c.ground === null) {
        setText(cursorText, '計算範囲外');
        return;
      }
      const parts = [`地盤高 ${formatTP(c.ground)}`];
      if (c.depth !== null) parts.push(c.depth >= 0.01 ? `浸水深 ${formatDepth(c.depth)}` : '浸水なし');
      setText(cursorText, parts.join('　'));
    }, true),
  );
}
