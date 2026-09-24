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
  ViewMode,
} from './types';
import { loadTerrain } from '../terrain';
import { SimRunner } from '../sim';
import { loadShelters } from '../data/shelters';
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
  runSimulation(): void;
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
  reloadTerrain(resolution?: Resolution): void;
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
    sim: { status: 'idle', progress: 0, output: null, runId: 0 },
    time: { t: 0, playing: false, speed: 60 },
    people: [],
    plans: {},
    selectedPersonId: null,
    placing: null,
    shelters: [],
    cursor: null,
    exaggeration: 2,
  };
}

export function createController(store: Store<AppState>): AppActions {
  const runner = new SimRunner();
  let terrainAbort: AbortController | null = null;
  let personSeq = 0;
  let lastFrame = 0;
  let rafId = 0;
  /** 地形の読み込みが終わったら実行するシミュレーション */
  let pendingRun = false;

  const durationSec = () => store.get().params.durationMin * 60;

  // ---- 再生ループ -------------------------------------------------------
  const tick = (now: number) => {
    rafId = 0;
    const s = store.get();
    if (!s.time.playing) return;
    const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const out = s.sim.output;
    const end = out ? out.durationSec : durationSec();
    // 計算が追いついていない時刻へは進めない（バッファリング）
    const limit = out ? Math.min(end, out.timeReady()) : end;
    let t = s.time.t + dtReal * s.time.speed;
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
          plans[p.id] = planEvacuation(p, s.terrain.grid, s.shelters, s.sim.output, s.params);
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

  // ---- 地形・避難場所の読み込み --------------------------------------------
  const reloadTerrain = (resolution?: Resolution) => {
    terrainAbort?.abort();
    const ac = new AbortController();
    terrainAbort = ac;
    const res = resolution ?? store.get().params.resolution;
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
          pendingRun = false;
          actions.runSimulation();
        }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        console.error('[terrain] load failed', e);
        store.set({ terrain: { status: 'error', progress: 0, grid: null, message: String((e as Error)?.message ?? e) } });
      });
  };

  const actions: AppActions = {
    setView: (view) => store.set({ view }),
    setBasemap: (basemap) => store.set({ basemap }),
    setLayer: (key, value) => store.set({ layers: { ...store.get().layers, [key]: value } }),

    selectShindo: (shindo) => {
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
      const prev = store.get().params;
      const next = { ...prev, ...patch };
      store.set({ params: next });
      if (patch.resolution && patch.resolution !== prev.resolution) reloadTerrain(patch.resolution);
    },

    updateScenario: (patch) => {
      const prev = store.get().params;
      store.set({ params: { ...prev, scenario: { ...prev.scenario, ...patch } } });
    },

    runSimulation: () => {
      const s = store.get();
      const grid = s.terrain.grid;
      if (!grid || s.terrain.status !== 'ready') {
        pendingRun = true;
        if (s.terrain.status !== 'loading') reloadTerrain();
        return;
      }
      const runId = s.sim.runId + 1;
      store.set({
        sim: { status: 'running', progress: 0, output: null, runId, message: '計算を開始しています…' },
        time: { ...s.time, t: 0, playing: false },
      });
      runner.run(grid, s.params, {
        onProgress: (progress, message) => {
          const cur = store.get().sim;
          if (cur.runId !== runId) return;
          store.set({ sim: { ...cur, progress, message } });
        },
        onOutput: (output) => {
          const cur = store.get().sim;
          if (cur.runId !== runId) return;
          store.set({ sim: { ...cur, output } });
          actions.play();
        },
        onDone: () => {
          const cur = store.get().sim;
          if (cur.runId !== runId) return;
          store.set({ sim: { ...cur, status: 'done', progress: 1, message: '計算完了' } });
        },
        onError: (message) => {
          const cur = store.get().sim;
          if (cur.runId !== runId) return;
          store.set({ sim: { ...cur, status: 'error', message } });
        },
      });
    },

    cancelSimulation: () => {
      runner.cancel();
      const cur = store.get().sim;
      if (cur.status === 'running') store.set({ sim: { ...cur, status: 'idle', message: '計算を中止しました' } });
    },

    play: () => {
      const s = store.get();
      let t = s.time.t;
      const end = s.sim.output ? s.sim.output.durationSec : durationSec();
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
      const end = s.sim.output ? s.sim.output.durationSec : durationSec();
      store.set({ time: { ...s.time, t: Math.max(0, Math.min(end, t)) } });
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
    reloadTerrain,
  };

  // 起動時の読み込み
  reloadTerrain();
  loadShelters()
    .then((shelters) => store.set({ shelters }))
    .catch((e) => console.warn('[shelters] load failed', e));

  return actions;
}
