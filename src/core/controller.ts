/**
 * アプリのコントローラ（状態遷移と非同期処理のまとめ役）。
 * UI・2D/3D ビューは store を読み、変更はすべてここの actions 経由で行う。
 */
import { Store } from './store';
import type { Resolution } from './geo';
import type {
  AppState,
  Basemap,
  CursorInfo,
  LayerState,
  Person,
  PersonKind,
  QuakeScenario,
  ShindoLevel,
  SimParams,
  UserLocation,
  ViewMode,
} from './types';
import { extendStatsToFrames, playbackEnd, resultParams, seekLimit, usableOutput } from './results';
import { loadTerrain } from '../terrain';
import { SimRunner } from '../sim';
import { loadSheltersDetailed } from '../data/shelters';
import { checkOfficialHazardDisplay, loadOfficialInundation, officialLoadMessage } from '../data/officialHazardLoad';
import { SCENARIOS, SHINDO_PRESETS, defaultParams, getScenario } from '../data/scenarios';
import { PERSON_PROFILES, planEvacuation } from '../people';

export interface AppActions {
  setView(v: ViewMode): void;
  setBasemap(b: Basemap): void;
  setLayer<K extends keyof LayerState>(key: K, value: LayerState[K]): void;
  /** 震度を選ぶと、その震度の代表シナリオが選択される */
  selectShindo(s: ShindoLevel): void;
  selectScenario(id: string): void;
  /** 実行パラメータ（潮位・計算時間・解像度・粗度）を変更 */
  updateParams(patch: Partial<Omit<SimParams, 'scenario'>>): void;
  /** 現在のシナリオの値（津波高・到達時間など）を上書き */
  updateScenario(patch: Partial<QuakeScenario>): void;
  /** 今の条件で計算する（計算中なら中止して計算し直す）。地形の準備ができていなければ、読み込み後に計算する */
  runSimulation(): void;
  /** 計算を中止する（受信済みの途中までの結果は残り、途中までの結果として示される） */
  cancelSimulation(): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  /** 時刻 [秒] へ移動 */
  seek(t: number): void;
  /** 再生速度（実時間1秒あたりのシミュレーション秒） */
  setSpeed(speed: number): void;
  startPlacing(kind: PersonKind | null): void;
  addPerson(kind: PersonKind, lon: number, lat: number): Person;
  updatePerson(id: string, patch: Partial<Omit<Person, 'id'>>): void;
  removePerson(id: string): void;
  clearPeople(): void;
  selectPerson(id: string | null): void;
  setCursor(c: CursorInfo | null): void;
  setExaggeration(x: number): void;
  /** 2D 地図・3D ビューの視点を指定地点へ移す */
  focusOn(lon: number, lat: number, opts?: { zoom?: number; label?: string }): void;
  /** 視点を移す要求を取り消す（focus を null に。2D 地図の検索地点の目印も消える。視点はそのまま） */
  clearFocus(): void;
  /** 現在地を設定（null で消去） */
  setUserLocation(loc: UserLocation | null): void;
  /**
   * 公式の津波浸水想定を読み込み直す（読み込めなかった場合の再試行）。
   * 地図に重ねる公式ハザードマップを表示中なら、配信元に接続できるかも確かめ直す。
   */
  retryOfficialHazard(): void;
  /**
   * 地図に重ねた公式ハザードマップのタイルを取得できたか（2D・3D ビューから知らせる）。
   * false なら画面に「読み込めない。色が無くても浸水しないという意味ではない」と示す。
   */
  reportOfficialHazardDisplay(ok: boolean): void;
  /**
   * 地形を読み込み直す。前の地形で計算した結果は今の地形の結果として使えないので消す
   * （計算中なら中止し、読み込みが終わったら新しい地形で計算し直す）。
   */
  reloadTerrain(resolution?: Resolution): void;
  /**
   * 初回の自動実行を許可する（「ご利用にあたって」を閉じた後に UI から呼ぶ）。
   * 地形の準備ができていて、利用者がまだ条件の変更や実行をしていなければ、既定のシナリオを1回だけ自動で計算・再生する。
   */
  armAutoRun(): void;
}

export const SPEED_OPTIONS = [10, 30, 60, 120, 240] as const;

export function createInitialState(): AppState {
  const scenario = getScenario(SHINDO_PRESETS['7'].scenarioId) ?? SCENARIOS[0];
  return {
    view: '2d',
    basemap: 'pale',
    layers: {
      officialHazard: false,
      officialHazardOpacity: 0.6,
      simFlood: true,
      maxDepth: false,
      arrival: false,
      shelters: true,
      buildings: true,
      elevation: false,
    },
    terrain: { status: 'idle', progress: 0, grid: null },
    shindo: scenario.shindo,
    scenarioId: scenario.id,
    params: defaultParams(scenario),
    sim: { status: 'idle', progress: 0, output: null, runId: 0, run: null, queued: false },
    time: { t: 0, playing: false, speed: 60 },
    people: [],
    plans: {},
    selectedPersonId: null,
    placing: null,
    shelters: [],
    officialInundation: { status: 'idle', data: null, display: 'unknown' },
    cursor: null,
    focus: null,
    userLocation: null,
    exaggeration: 2,
  };
}

export function createController(store: Store<AppState>): AppActions {
  const runner = new SimRunner();
  let terrainAbort: AbortController | null = null;
  let personSeq = 0;
  /** 視点移動の要求の通し番号（clearFocus の後も戻らない） */
  let focusSeq = 0;
  let lastFrame = 0;
  let rafId = 0;
  /** 地形の読み込みが終わったら実行するシミュレーション（状態の sim.queued と同じ値に保つ） */
  let pendingRun = false;
  const setPending = (v: boolean) => {
    pendingRun = v;
    const sim = store.get().sim;
    if (sim.queued !== v) store.set({ sim: { ...sim, queued: v } });
  };
  /** 初回の自動実行: 許可されたか・もう済んだ（または不要になった）か */
  let autoArmed = false;
  let autoSpent = false;
  /** 利用者が条件を変えた・実行したら、以後は自動実行しない */
  const userActed = () => {
    autoSpent = true;
  };
  /** 結果を受け取る計算の runId（中止・地形の読み込み直しで 0 にし、遅れて届いた古い計算の通知を無視する） */
  let liveRunId = 0;
  /** 計算の進み具合 [計算上の秒 / 実時間の秒]（再生を計算に合わせるための推定値） */
  let computeRate = 0;
  let lastReady = { t: 0, at: 0 };

  // ---- 再生ループ -------------------------------------------------------
  const tick = (now: number) => {
    rafId = 0;
    const s = store.get();
    if (!s.time.playing) return;
    // 描画の遅い端末（毎秒数フレーム）でも設定した速さで進むよう、1フレームの上限は 0.25 秒（タブ復帰時の飛びは防ぐ）
    const dtReal = Math.min(0.25, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    const out = s.sim.output;
    // 再生の終わり: 計算中は計算終了時刻、中止・失敗の後は受信済みの最終時刻（それ以上は増えない）
    const end = playbackEnd(s);
    // 計算が追いついていない時刻へは進めない（バッファリング）
    const ready = out ? out.timeReady() : end;
    const limit = out ? Math.min(end, ready) : end;
    let speed = s.time.speed;
    if (out && s.sim.status === 'running' && ready < end) {
      // 計算中は、計算済みの時刻の少し手前を計算の進む速さに合わせて進める。
      // 届いたフレームの間を補間して表示できるので、フレームごとにカクカク止まらず滑らかに動く。
      if (ready !== lastReady.t) {
        if (lastReady.at > 0 && ready > lastReady.t) {
          const r = (ready - lastReady.t) / Math.max(0.05, (now - lastReady.at) / 1000);
          computeRate = computeRate > 0 ? computeRate * 0.7 + r * 0.3 : r;
        }
        lastReady = { t: ready, at: now };
      }
      const lag = out.frameInterval * 1.5;
      const gap = ready - lag - s.time.t;
      // 追いつきそうなら計算の速さまで落とし、遅れていれば少し速める（比例制御）
      speed = Math.max(0, Math.min(s.time.speed, computeRate + gap * 0.5));
    }
    let t = s.time.t + dtReal * speed;
    let playing = true;
    if (t >= end) {
      t = end;
      playing = false;
    } else if (t > limit) {
      t = Math.max(s.time.t, limit);
    }
    store.set({ time: { ...s.time, t, playing } });
    if (playing) rafId = requestAnimationFrame(tick);
  };

  const startLoop = () => {
    if (rafId) return;
    lastFrame = performance.now();
    rafId = requestAnimationFrame(tick);
  };

  // ---- 人物の避難計画を再計算 ---------------------------------------------
  let replanTimer = 0;
  const replan = () => {
    if (replanTimer) return;
    replanTimer = window.setTimeout(() => {
      replanTimer = 0;
      const s = store.get();
      if (!s.terrain.grid) return;
      const plans: AppState['plans'] = {};
      for (const p of s.people) {
        try {
          // 表示中の結果と、その結果を計算した条件で（条件を変えても、再計算するまでは前の結果の条件のまま）
          // 最寄りの高台は、公式の津波浸水想定の区域（とその周囲）を除いて選ぶ（読み込めていなければ、その旨を避難先の名前に示す）
          plans[p.id] = planEvacuation(p, s.terrain.grid, s.shelters, usableOutput(s), resultParams(s), s.officialInundation);
        } catch (e) {
          console.error('[people] planEvacuation failed', e);
        }
      }
      store.set({ plans });
    }, 30);
  };
  store.select((s) => s.people, replan);
  store.select((s) => s.shelters, replan);
  store.select((s) => s.terrain.grid, replan);
  store.select((s) => s.sim.status, replan);
  store.select((s) => s.params, replan);
  store.select((s) => s.officialInundation.data, replan);
  store.select((s) => s.officialInundation.status, replan);

  // ---- 公式の津波浸水想定（人物の評価用のデータと、地図に重ねるタイルの取得可否） ------------------
  let officialAbort: AbortController | null = null;
  const setOfficial = (patch: Partial<AppState['officialInundation']>) =>
    store.set({ officialInundation: { ...store.get().officialInundation, ...patch } });
  const loadOfficial = () => {
    officialAbort?.abort();
    const ac = new AbortController();
    officialAbort = ac;
    setOfficial({ status: 'loading', message: undefined });
    loadOfficialInundation({ signal: ac.signal })
      .then((data) => {
        if (ac.signal.aborted) return;
        setOfficial({ status: 'ready', data, message: officialLoadMessage(data) });
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        console.warn('[official] 公式の津波浸水想定を読み込めませんでした', e);
        setOfficial({ status: 'error', data: null, message: String((e as Error)?.message ?? e) });
      });
  };
  let displaySeq = 0;
  const checkDisplay = () => {
    const seq = ++displaySeq;
    setOfficial({ display: 'checking' });
    checkOfficialHazardDisplay()
      .then((ok) => {
        if (seq !== displaySeq) return;
        setOfficial({ display: ok ? 'ok' : 'error' });
      })
      .catch(() => {
        if (seq === displaySeq) setOfficial({ display: 'error' });
      });
  };
  // 公式ハザードマップを表示したとき、まだ接続を確かめていない（または失敗した）なら確かめる
  store.select(
    (s) => s.layers.officialHazard,
    (on) => {
      const d = store.get().officialInundation.display;
      if (on && d !== 'ok' && d !== 'checking') checkDisplay();
    },
  );

  // ---- 地形・避難場所の読み込み --------------------------------------------
  const reloadTerrain = (resolution?: Resolution) => {
    terrainAbort?.abort();
    const ac = new AbortController();
    terrainAbort = ac;
    const res = resolution ?? store.get().params.resolution;
    // 計算結果は計算に使った地形の格子に結びついている。地形を読み込み直すと（解像度の変更、簡易地形から
    // 国土地理院の標高データへの切り替えなど）前の結果は今の地形の結果ではなくなるので消す。
    // 計算中なら中止し、読み込みが終わったら新しい地形で計算し直す。
    const cur = store.get();
    const wasRunning = cur.sim.status === 'running';
    if (wasRunning) {
      runner.cancel();
      liveRunId = 0;
      pendingRun = true;
    }
    if (wasRunning || cur.sim.output || cur.sim.run) {
      store.set({
        sim: {
          ...cur.sim,
          status: 'idle',
          progress: 0,
          output: null,
          run: null,
          auto: false,
          queued: pendingRun,
          message: wasRunning
            ? '地形データを読み込み直すため、計算を中断しました。読み込みが終わると計算し直します。'
            : cur.sim.output
              ? '地形データを読み込み直したため、前の計算結果を消去しました。'
              : cur.sim.message,
        },
        time: { ...cur.time, t: 0, playing: false },
      });
    }
    store.set({ terrain: { status: 'loading', progress: 0, grid: null, message: '標高データを読み込み中…' } });
    loadTerrain(res, {
      signal: ac.signal,
      onProgress: (progress, message) => {
        if (ac.signal.aborted) return;
        store.set({ terrain: { ...store.get().terrain, progress, message } });
      },
    })
      .then((grid) => {
        if (ac.signal.aborted) return;
        store.set({ terrain: { status: 'ready', progress: 1, grid, message: grid.sourceLabel } });
        if (pendingRun) {
          setPending(false);
          actions.runSimulation();
        } else {
          maybeAutoRun();
        }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        console.error('[terrain] load failed', e);
        // 予約していた計算は取り消す（画面は「実行すると、地形データの読み込みを再試行します」と案内する）
        if (pendingRun) {
          pendingRun = false;
          store.set({ sim: { ...store.get().sim, queued: false, message: '地形データを読み込めなかったため、計算を始められませんでした。' } });
        }
        store.set({ terrain: { status: 'error', progress: 0, grid: null, message: String((e as Error)?.message ?? e) } });
      });
  };

  /** 計算の開始（auto: 初回の自動実行か）。地形が準備できていること */
  function startRun(auto: boolean): void {
    const s = store.get();
    const grid = s.terrain.grid;
    if (!grid) return;
    const runId = s.sim.runId + 1;
    liveRunId = runId;
    computeRate = 0;
    lastReady = { t: 0, at: 0 };
    pendingRun = false;
    store.set({
      sim: {
        status: 'running',
        progress: 0,
        output: null,
        runId,
        message: '計算を開始しています…',
        auto,
        // 結果はこの条件・この地形の格子のもの（条件や地形が変わっても、表示中の結果の条件として残る）
        run: { params: s.params, shindo: s.shindo, scenarioId: s.scenarioId, grid },
        queued: false,
      },
      time: { ...s.time, t: 0, playing: false },
    });
    runner.run(grid, s.params, {
      onProgress: (progress, message) => {
        const cur = store.get().sim;
        if (cur.runId !== runId || liveRunId !== runId) return;
        store.set({ sim: { ...cur, progress, message } });
      },
      onOutput: (output) => {
        const cur = store.get().sim;
        if (cur.runId !== runId || liveRunId !== runId) return;
        store.set({ sim: { ...cur, output } });
        actions.play();
      },
      onDone: () => {
        const cur = store.get().sim;
        if (cur.runId !== runId || liveRunId !== runId) return;
        store.set({ sim: { ...cur, status: 'done', progress: 1, message: '計算完了' } });
      },
      onError: (message) => {
        const cur = store.get().sim;
        if (cur.runId !== runId || liveRunId !== runId) return;
        // 途中までの結果は残す（途中までの結果として示す）。集計を受信済みのフレームの時刻までそろえる
        if (cur.output) finishPartial(cur.output);
        store.set({ sim: { ...cur, status: 'error', message } });
      },
    });
  }

  /** 途中で止まった結果の最大浸水深・到達時刻を、受信済みのフレームの時刻までそろえる */
  function finishPartial(out: NonNullable<AppState['sim']['output']>): void {
    try {
      extendStatsToFrames(out);
    } catch (e) {
      console.warn('[sim] partial result finalize failed', e);
    }
  }

  /** 初回の自動実行（条件がそろった時に1回だけ） */
  const maybeAutoRun = () => {
    if (!autoArmed || autoSpent) return;
    const s = store.get();
    if (s.terrain.status !== 'ready' || !s.terrain.grid) return;
    if (s.sim.runId !== 0 || s.sim.status !== 'idle') {
      autoSpent = true;
      return;
    }
    autoSpent = true;
    startRun(true);
  };

  const actions: AppActions = {
    setView: (view) => store.set({ view }),
    setBasemap: (basemap) => store.set({ basemap }),
    setLayer: (key, value) => store.set({ layers: { ...store.get().layers, [key]: value } }),

    selectShindo: (shindo) => {
      userActed();
      const preset = SHINDO_PRESETS[shindo];
      const scenario = getScenario(preset.scenarioId);
      if (!scenario) {
        store.set({ shindo });
        return;
      }
      const prev = store.get().params;
      store.set({
        shindo,
        scenarioId: scenario.id,
        params: { ...defaultParams(scenario), resolution: prev.resolution, landManning: prev.landManning },
      });
    },

    selectScenario: (id) => {
      userActed();
      const scenario = getScenario(id);
      if (!scenario) return;
      const prev = store.get().params;
      store.set({
        scenarioId: id,
        shindo: scenario.shindo,
        params: { ...defaultParams(scenario), resolution: prev.resolution, landManning: prev.landManning },
      });
    },

    updateParams: (patch) => {
      userActed();
      const prev = store.get().params;
      const next = { ...prev, ...patch };
      store.set({ params: next });
      if (patch.resolution && patch.resolution !== prev.resolution) reloadTerrain(patch.resolution);
    },

    updateScenario: (patch) => {
      userActed();
      const prev = store.get().params;
      store.set({ params: { ...prev, scenario: { ...prev.scenario, ...patch } } });
    },

    runSimulation: () => {
      userActed();
      const s = store.get();
      const grid = s.terrain.grid;
      if (!grid || s.terrain.status !== 'ready') {
        setPending(true);
        if (s.terrain.status !== 'loading') reloadTerrain();
        return;
      }
      // 計算中なら、前の計算は runner.run が中止する（受け取り側は runId で古い計算を無視する）
      startRun(false);
    },

    cancelSimulation: () => {
      userActed();
      setPending(false);
      runner.cancel();
      liveRunId = 0;
      const cur = store.get().sim;
      if (cur.status === 'running') {
        // 途中までの結果は残す（途中までの結果として示す）。集計を受信済みのフレームの時刻までそろえる
        if (cur.output) finishPartial(cur.output);
        store.set({ sim: { ...cur, status: 'idle', message: '計算を中止しました' } });
      }
    },

    play: () => {
      const s = store.get();
      let t = s.time.t;
      // 終わり（中止・失敗の後は計算済みの所まで）にいれば最初から
      const end = playbackEnd(s);
      if (t >= end - 0.5) t = 0;
      store.set({ time: { ...s.time, t, playing: true } });
      startLoop();
    },
    pause: () => {
      const s = store.get();
      store.set({ time: { ...s.time, playing: false } });
    },
    togglePlay: () => (store.get().time.playing ? actions.pause() : actions.play()),
    seek: (t) => {
      const s = store.get();
      // 計算済みの範囲まで（未計算の時刻に、最後に届いた浸水を表示しないように）
      const end = seekLimit(s);
      const v = Number.isFinite(t) ? t : 0;
      store.set({ time: { ...s.time, t: Math.max(0, Math.min(end, v)) } });
    },
    setSpeed: (speed) => store.set({ time: { ...store.get().time, speed } }),

    startPlacing: (placing) => store.set({ placing }),

    addPerson: (kind, lon, lat) => {
      personSeq += 1;
      const profile = PERSON_PROFILES[kind];
      const person: Person = {
        id: `p${Date.now().toString(36)}${personSeq}`,
        name: `${profile.label} ${personSeq}`,
        kind,
        lon,
        lat,
        evacMode: 'shelter',
        startDelayMin: profile.defaultStartDelayMin,
      };
      store.set({ people: [...store.get().people, person], selectedPersonId: person.id });
      return person;
    },
    updatePerson: (id, patch) => {
      store.set({ people: store.get().people.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
    },
    removePerson: (id) => {
      const s = store.get();
      store.set({
        people: s.people.filter((p) => p.id !== id),
        selectedPersonId: s.selectedPersonId === id ? null : s.selectedPersonId,
      });
    },
    clearPeople: () => store.set({ people: [], selectedPersonId: null, plans: {} }),
    selectPerson: (selectedPersonId) => store.set({ selectedPersonId }),
    setCursor: (cursor) => store.set({ cursor }),
    setExaggeration: (exaggeration) => store.set({ exaggeration }),
    focusOn: (lon, lat, opts = {}) => {
      focusSeq = Math.max(focusSeq, store.get().focus?.seq ?? 0) + 1;
      store.set({ focus: { lon, lat, zoom: opts.zoom, label: opts.label, seq: focusSeq } });
    },
    clearFocus: () => {
      if (store.get().focus) store.set({ focus: null });
    },
    setUserLocation: (userLocation) => store.set({ userLocation }),
    retryOfficialHazard: () => {
      const o = store.get().officialInundation;
      if (o.status === 'error' || o.status === 'idle' || (o.status === 'ready' && (o.data?.failed ?? 0) > 0)) loadOfficial();
      if (store.get().layers.officialHazard) checkDisplay();
    },
    reportOfficialHazardDisplay: (ok) => {
      const next = ok ? 'ok' : 'error';
      if (store.get().officialInundation.display === next) return;
      displaySeq++;
      setOfficial({ display: next });
    },
    reloadTerrain,
    armAutoRun: () => {
      if (autoArmed) return;
      autoArmed = true;
      maybeAutoRun();
    },
  };

  // 起動時の読み込み
  reloadTerrain();
  loadOfficial();
  if (store.get().layers.officialHazard) checkDisplay();
  loadSheltersDetailed()
    .then(({ shelters, origin, message }) => store.set({ shelters, sheltersInfo: { origin, message, count: shelters.length } }))
    .catch((e) => console.warn('[shelters] load failed', e));

  return actions;
}
