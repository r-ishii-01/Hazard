/**
 * タイムライン: 再生・一時停止、再生速度、時刻スクラバー（計算済み範囲・目印つき）、水位のスパークライン。
 */
import { SPEED_OPTIONS } from '../core/controller';
import type { AppState } from '../core/types';
import { partialRangeLabel, playbackEnd, resultCoverage, resultParams, usableOutput } from '../core/results';
import { WARNING_INFO } from '../data/warnings';
import { getScenario } from '../data/scenarios';
import { safeCall, timelineDuration, type UIContext } from './context';
import { h, s as svg, setAttr, setHidden, setText, uid } from './dom';
import { clamp, formatClock, formatElapsed, formatTP } from './format';
import { icon } from './icons';
import { JMA_ISSUE_TARGET_LABEL, warningShowSec } from './hud';
import { interpolateSeries, linePath, seriesExtent } from './series';
import { ARRIVAL_BASIS_LABEL, arrivalMarkerLabel } from './scenarioText';

const SPARK_W = 1000;
const SPARK_H = 40;

interface Marker {
  id: 'shake' | 'warn' | 'arrival' | 'flood';
  label: string;
  color: string;
  t: number;
  /** ツールチップに添える説明 */
  note?: string;
}

export function mountTimeline(el: HTMLElement, ctx: UIContext): void {
  const { store, actions } = ctx;

  // ---- 再生ボタン・速度 -------------------------------------------------------------
  const playIcon = h('span', { class: 'tl-play-icon' }, icon('play', 22));
  const playBtn = h('button', { type: 'button', class: 'tl-play', 'aria-label': '再生', onclick: () => actions.togglePlay() }, playIcon);
  const speedId = uid('speed');
  const speedSel = h(
    'select',
    { id: speedId, class: 'select select-sm tl-speed-select', title: '再生速度（実時間1秒あたりに進むシミュレーション時間）' },
    SPEED_OPTIONS.map((v) => h('option', { value: String(v) }, `${v}倍`)),
  );
  speedSel.addEventListener('change', () => actions.setSpeed(Number(speedSel.value)));

  // ---- スパークライン -------------------------------------------------------------------
  const sparkZero = svg('line', { class: 'spark-zero', x1: 0, x2: SPARK_W, 'vector-effect': 'non-scaling-stroke' });
  const sparkPath = svg('path', { class: 'spark-line', 'vector-effect': 'non-scaling-stroke' });
  const sparkSvg = svg('svg', { class: 'spark-svg', viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, sparkZero, sparkPath);
  const sparkMax = h('span', { class: 'spark-max' });
  const sparkEmpty = h('span', { class: 'spark-empty' }, 'シミュレーションを実行すると、鵠沼海岸沖の水位の変化がここに表示されます');
  const playhead = h('span', { class: 'tl-playhead', 'aria-hidden': 'true' });
  const hoverLine = h('span', { class: 'tl-hover-line', 'aria-hidden': 'true', hidden: true });
  const tooltip = h('span', { class: 'tl-tooltip', 'aria-hidden': 'true', hidden: true });
  const spark = h('div', { class: 'tl-spark' }, sparkSvg, h('span', { class: 'spark-label' }, '鵠沼海岸沖の水位（計算）'), sparkMax, sparkEmpty);

  // ---- スクラバー -----------------------------------------------------------------------
  const buffer = h('span', { class: 'tl-buffer' });
  const played = h('span', { class: 'tl-played' });
  const markerLayer = h('span', { class: 'tl-marker-layer' });
  const rail = h('span', { class: 'tl-rail', 'aria-hidden': 'true' }, buffer, played, markerLayer);
  const range = h('input', { type: 'range', class: 'tl-range', min: 0, max: 3600, step: 1, value: 0, 'aria-label': '地震発生からの時刻' });
  const track = h('div', { class: 'tl-track' }, rail, range);
  const chips = h('div', { class: 'tl-chips' });
  const main = h('div', { class: 'tl-main' }, spark, track, chips, playhead, hoverLine, tooltip);

  // ---- 時刻表示 -------------------------------------------------------------------------
  const nowEl = h('span', { class: 'tl-now' }, '0:00');
  const durEl = h('span', { class: 'tl-dur' }, '/ 60:00');
  const waitEl = h('span', { class: 'tl-wait', hidden: true, title: '再生が計算に追いついたため、計算の進み具合に合わせて再生しています' }, '計算に合わせて再生中');
  // 中止・失敗で途中までの結果: 計算した範囲（それより先へは進めない）
  const partialEl = h('span', { class: 'tl-partial', hidden: true });

  el.replaceChildren(
    h('div', { class: 'tl-controls' }, playBtn, h('label', { class: 'visually-hidden', for: speedId }, '再生速度'), speedSel),
    main,
    h('div', { class: 'tl-time' }, h('span', { class: 'tl-time-row' }, nowEl, durEl), waitEl, partialEl),
  );
  el.setAttribute('aria-label', 'タイムライン');

  // ---- 状態 ---------------------------------------------------------------------------
  let duration = timelineDuration(store.get());
  let wasPlaying = false;
  let scrubbing = false;

  const limitT = (s: AppState) => {
    const out = usableOutput(s);
    const d = timelineDuration(s);
    return out ? Math.min(d, Math.max(0, ctx.watcher.snap.timeReady || safeCall(() => out.timeReady(), 0))) : d;
  };
  const seek = (t: number) => {
    const s = store.get();
    actions.seek(clamp(t, 0, limitT(s)));
  };

  // 毎フレーム: 位置とラベルだけ更新
  let lastSec = -1;
  const renderTime = () => {
    const s = store.get();
    const t = s.time.t;
    const p = duration > 0 ? clamp(t / duration, 0, 1) : 0;
    played.style.transform = `scaleX(${p})`;
    playhead.style.left = `${p * 100}%`;
    if (!scrubbing) range.value = String(Math.round(t));
    const sec = Math.floor(t);
    if (sec !== lastSec) {
      lastSec = sec;
      setText(nowEl, formatClock(t));
      range.setAttribute('aria-valuetext', `地震発生から${formatElapsed(t)}`);
    }
    const out = usableOutput(s);
    const tr = ctx.watcher.snap.timeReady;
    // 再生が計算済みの時刻に近づくと、コントローラーが計算の速さに合わせて再生する（数フレーム手前を追う）
    const lag = out ? safeCall(() => out.frameInterval, 20) * 2.5 : 0;
    setHidden(waitEl, !(s.time.playing && out && s.sim.status === 'running' && tr < duration && t >= tr - lag));
  };

  const renderDuration = () => {
    const s = store.get();
    duration = timelineDuration(s);
    range.max = String(Math.round(duration));
    setText(durEl, `/ ${formatClock(duration)}`);
    renderBuffer();
    renderMarkers();
    renderSpark();
    lastSec = -1;
    renderTime();
  };

  const renderBuffer = () => {
    const s = store.get();
    const out = usableOutput(s);
    const tr = out ? ctx.watcher.snap.timeReady : 0;
    buffer.style.transform = `scaleX(${duration > 0 ? clamp(tr / duration, 0, 1) : 0})`;
    setHidden(buffer, !out);
    const cov = resultCoverage(s);
    const stopped = !!cov && !cov.complete && cov.state !== 'running';
    setHidden(partialEl, !stopped);
    setText(partialEl, stopped ? partialRangeLabel(cov) : '');
    partialEl.title = stopped ? 'この時刻より後は計算していません（浸水しないという意味ではありません）' : '';
  };

  // ---- 目印 -----------------------------------------------------------------------------
  const renderMarkers = () => {
    const s = store.get();
    // 表示中の結果の条件で（震度・シナリオを選び直しても、再計算するまでは地図の浸水と同じ条件の目印）
    const sc = resultParams(s).scenario;
    const list: Marker[] = [];
    if (sc.shakingSec > 0) list.push({ id: 'shake', label: '揺れ終了', color: '#64748b', t: sc.shakingSec });
    const w = WARNING_INFO[sc.warning];
    // 近くの地震は気象庁の発表目標（約3分）。遠地津波の例は発表時刻を示さない
    const warnAt = warningShowSec(sc);
    if (w && warnAt !== null && sc.warning !== 'forecast') {
      list.push({ id: 'warn', label: `${w.label}の目安`, color: '#7e22ce', t: warnAt, note: `気象庁の発表目標（地震発生から${JMA_ISSUE_TARGET_LABEL}）` });
    }
    // 公的資料の「最大津波到達時間」そのものなら「想定時刻」、南海トラフ（代用の値）・説明用の例・変更した値は「設定時刻」
    const label = arrivalMarkerLabel(sc);
    const base = getScenario(sc.id);
    const basis = base && base.arrivalMin === sc.arrivalMin ? (base.arrivalBasis ?? '').trim() : '';
    list.push({ id: 'arrival', label, color: '#d97706', t: sc.arrivalMin * 60, note: basis ? `${ARRIVAL_BASIS_LABEL}: ${basis}` : undefined });
    const first = ctx.watcher.snap.output ? ctx.watcher.snap.summary?.firstArrival : undefined;
    if (first !== undefined && Number.isFinite(first)) list.push({ id: 'flood', label: '最初の浸水（計算）', color: '#dc2626', t: first });

    // 時刻の順に並べる（狭い画面では目印のチップが 1 行で横にスクロールするので、早い順に見えるように）
    const visible = list.filter((m) => m.t >= 0 && m.t <= duration).sort((a, b) => a.t - b.t);
    markerLayer.replaceChildren(
      ...visible.map((m) =>
        h('span', { class: 'tl-marker', dataset: { id: m.id }, style: { left: `${(m.t / duration) * 100}%`, '--mk': m.color }, title: [`${m.label} ${formatClock(m.t)}`, m.note].filter(Boolean).join('\n') }),
      ),
    );
    chips.replaceChildren(
      ...visible.map((m) =>
        h(
          'button',
          {
            type: 'button',
            class: 'tl-chip',
            style: { '--mk': m.color },
            title: [`${m.label}（地震発生から${formatElapsed(m.t)}）へ移動`, m.note].filter(Boolean).join('\n'),
            onclick: () => seek(m.t),
          },
          h('span', { class: 'tl-chip-dot', 'aria-hidden': 'true' }),
          h('span', null, m.label),
          h('span', { class: 'tl-chip-time' }, formatClock(m.t)),
        ),
      ),
    );
    updateChipsOverflow();
  };

  // 狭い画面では目印のチップを 1 行で横にスクロールする。入りきらない間は右端を薄くして続きがあることを示す
  const updateChipsOverflow = () => {
    const over = chips.scrollWidth > chips.clientWidth + 1;
    chips.classList.toggle('is-overflowing', over);
    chips.classList.toggle('is-scrolled-end', over && chips.scrollLeft + chips.clientWidth >= chips.scrollWidth - 2);
  };
  chips.addEventListener('scroll', updateChipsOverflow, { passive: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => updateChipsOverflow());
    ro.observe(chips);
    ctx.scope.add(() => ro.disconnect());
  }

  // ---- スパークライン --------------------------------------------------------------------
  const renderSpark = () => {
    const s = store.get();
    const out = usableOutput(s);
    const n = out ? safeCall(() => out.gauge.count(), 0) : 0;
    setHidden(sparkEmpty, n > 1);
    setHidden(sparkMax, n < 2);
    if (!out || n < 2) {
      sparkPath.setAttribute('d', '');
      setHidden(sparkZero, true);
      return;
    }
    const g = out.gauge;
    const ext = seriesExtent(g.eta, n);
    const base = resultParams(s).tideTP;
    const lo = Math.min(ext?.min ?? base, base) - 0.3;
    const hi = Math.max(ext?.max ?? base, base) + 0.3;
    sparkPath.setAttribute('d', linePath(g.t, g.eta, n, { t0: 0, t1: duration, yMin: lo, yMax: hi, width: SPARK_W, height: SPARK_H, maxPoints: 800 }));
    const y0 = SPARK_H - ((base - lo) / (hi - lo)) * SPARK_H;
    setAttr(sparkZero, 'y1', y0.toFixed(1));
    setAttr(sparkZero, 'y2', y0.toFixed(1));
    setHidden(sparkZero, false);
    setText(sparkMax, ext ? `最大 ${formatTP(ext.max)}` : '');
  };

  // ---- ホバー（時刻と水位のツールチップ） ------------------------------------------------
  const onHover = (e: PointerEvent) => {
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const p = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const t = p * duration;
    const out = usableOutput(store.get());
    let text = formatClock(t);
    if (out) {
      const n = safeCall(() => out.gauge.count(), 0);
      const eta = interpolateSeries(out.gauge.t, out.gauge.eta, n, t);
      if (Number.isFinite(eta)) text += `　水位 ${formatTP(eta)}`;
      else if (t > ctx.watcher.snap.timeReady) text += '　未計算';
    }
    setText(tooltip, text);
    const mainRect = main.getBoundingClientRect();
    const x = e.clientX - mainRect.left;
    hoverLine.style.left = `${x}px`;
    tooltip.style.left = `${clamp(x, 60, mainRect.width - 60)}px`;
    setHidden(hoverLine, false);
    setHidden(tooltip, false);
  };
  const hideHover = () => {
    setHidden(hoverLine, true);
    setHidden(tooltip, true);
  };
  main.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') onHover(e);
  });
  main.addEventListener('pointerleave', hideHover);
  // スパークライン部分のクリックでもその時刻へ
  spark.addEventListener('click', (e) => {
    const rect = track.getBoundingClientRect();
    if (rect.width > 0) seek(((e.clientX - rect.left) / rect.width) * duration);
  });

  // ---- スクラバー操作 --------------------------------------------------------------------
  range.addEventListener('pointerdown', () => {
    scrubbing = true;
    wasPlaying = store.get().time.playing;
    if (wasPlaying) actions.pause();
  });
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    seek(Number(range.value));
    // 終わりまで動かして離したときは、そこで止めたままにする（再生を再開すると最初に戻ってしまう）
    if (wasPlaying && store.get().time.t < playbackEnd(store.get()) - 0.5) actions.play();
    wasPlaying = false;
  };
  range.addEventListener('input', () => {
    const lim = limitT(store.get());
    if (Number(range.value) > lim) range.value = String(Math.floor(lim));
    seek(Number(range.value));
  });
  range.addEventListener('change', endScrub);
  range.addEventListener('pointerup', endScrub);
  range.addEventListener('pointercancel', endScrub);
  range.addEventListener('keydown', (e) => {
    const t = store.get().time.t;
    const big = e.shiftKey ? 60 : 10;
    let handled = true;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seek(t + big);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seek(t - big);
    else if (e.key === 'PageUp') seek(t + 60);
    else if (e.key === 'PageDown') seek(t - 60);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(duration);
    else if (e.key === ' ') actions.togglePlay();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // ---- 購読 -----------------------------------------------------------------------------
  ctx.scope.add(store.select((s) => s.time.t, renderTime, true));
  ctx.scope.add(
    store.select((s) => s.time.playing, (playing) => {
      playIcon.replaceChildren(icon(playing ? 'pause' : 'play', 22));
      playBtn.setAttribute('aria-label', playing ? '一時停止' : '再生');
      playBtn.classList.toggle('is-playing', playing);
      renderTime();
    }, true),
  );
  ctx.scope.add(store.select((s) => s.time.speed, (v) => (speedSel.value = String(v)), true));
  ctx.scope.add(store.select(timelineDuration, renderDuration, true));
  ctx.scope.add(store.select((s) => resultParams(s).scenario, renderMarkers));
  ctx.scope.add(store.select((s) => resultParams(s).tideTP, renderSpark));
  ctx.scope.add(store.select((s) => s.sim.status, renderBuffer));
  ctx.scope.add(
    ctx.watcher.subscribe(() => {
      renderBuffer();
      renderMarkers();
      renderSpark();
      renderTime();
    }),
  );
}
