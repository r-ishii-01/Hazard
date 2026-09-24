/**
 * コントローラー（src/core/controller.ts）の状態遷移: 計算の中止・失敗の後の再生、地形の読み込み直し、
 * 条件の変更と表示中の結果の条件。
 * 地形の読み込み・計算ワーカーは偽物に差し替え、requestAnimationFrame は手で進める。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGridSpec, type Resolution } from '../src/core/geo';
import { CELL_LAND, type SimOutput, type SimParams, type TerrainGrid } from '../src/core/types';

// ---- 偽の地形の読み込み ----------------------------------------------------------
interface PendingTerrain {
  resolution: Resolution;
  resolve(grid: TerrainGrid): void;
  reject(e: unknown): void;
}
const terrainRequests: PendingTerrain[] = [];
vi.mock('../src/terrain', () => ({
  loadTerrain: (resolution: Resolution) =>
    new Promise<TerrainGrid>((resolve, reject) => {
      terrainRequests.push({ resolution, resolve, reject });
    }),
}));

vi.mock('../src/data/shelters', () => ({
  loadSheltersDetailed: () => Promise.resolve({ shelters: [], origin: 'builtin', message: '' }),
}));

// ---- 偽の公式の津波浸水想定（ネットワークに接続しない） --------------------------------------
const officialLoads: { resolve(d: unknown): void; reject(e: unknown): void }[] = [];
const displayChecks: { resolve(ok: boolean): void }[] = [];
vi.mock('../src/data/officialHazardLoad', () => ({
  loadOfficialInundation: () =>
    new Promise((resolve, reject) => {
      officialLoads.push({ resolve, reject });
    }),
  officialLoadMessage: (d: { failed?: number }) => (d.failed ? `一部（${d.failed}枚）を読み込めませんでした` : undefined),
  checkOfficialHazardDisplay: () =>
    new Promise<boolean>((resolve) => {
      displayChecks.push({ resolve });
    }),
}));

// ---- 偽の計算 --------------------------------------------------------------------
interface Handlers {
  onProgress(p: number, m: string): void;
  onOutput(o: SimOutput): void;
  onDone(): void;
  onError(m: string): void;
}
interface RunCall {
  grid: TerrainGrid;
  params: SimParams;
  handlers: Handlers;
  cancelled: boolean;
}
const runs: RunCall[] = [];
vi.mock('../src/sim', () => ({
  SimRunner: class {
    private current: RunCall | null = null;
    run(grid: TerrainGrid, params: SimParams, handlers: Handlers) {
      this.cancel();
      this.current = { grid, params, handlers, cancelled: false };
      runs.push(this.current);
    }
    cancel() {
      if (this.current) this.current.cancelled = true;
      this.current = null;
    }
  },
}));

const { createController, createInitialState } = await import('../src/core/controller');
const { Store } = await import('../src/core/store');
const { isResultStale, playbackEnd, resultCoverage, resultParams, usableOutput } = await import('../src/core/results');

// ---- 手で進める requestAnimationFrame ------------------------------------------------
let now = 0;
let rafQueue: ((t: number) => void)[] = [];
function frames(count: number, dtMs = 100): void {
  for (let i = 0; i < count; i++) {
    now += dtMs;
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb(now);
  }
}

beforeEach(() => {
  now = 0;
  rafQueue = [];
  terrainRequests.length = 0;
  runs.length = 0;
  officialLoads.length = 0;
  displayChecks.length = 0;
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- 部品 ------------------------------------------------------------------------
function makeGrid(resolution: Resolution = 'coarse', source: TerrainGrid['source'] = 'cache'): TerrainGrid {
  const spec = { ...createGridSpec(resolution), nx: 4, ny: 3 };
  const n = spec.nx * spec.ny;
  return {
    spec,
    z: new Float32Array(n).fill(2),
    kind: new Uint8Array(n).fill(CELL_LAND),
    manning: new Float32Array(n).fill(0.025),
    source,
    sourceLabel: source,
    isApproximate: source === 'synthetic',
    notes: [],
  };
}

/** フレームを足していける偽の計算結果（フレーム間隔 20 秒） */
function makeOutput(grid: TerrainGrid, durationSec: number) {
  const n = grid.spec.nx * grid.spec.ny;
  const frameList: Float32Array[] = [new Float32Array(n)];
  const out = {
    spec: grid.spec,
    frameInterval: 20,
    durationSec,
    complete: false,
    revision: 0,
    framesReady: () => frameList.length,
    timeReady: () => (frameList.length - 1) * 20,
    depthAt: (t: number, k: number) => frameList[Math.min(frameList.length - 1, Math.max(0, Math.round(t / 20)))][k],
    etaAt: () => NaN,
    fillDepth: (t: number, dst: Float32Array) => dst.set(frameList[Math.min(frameList.length - 1, Math.max(0, Math.round(t / 20)))]),
    maxDepth: new Float32Array(n),
    maxEta: new Float32Array(n).fill(NaN),
    arrival: new Float32Array(n).fill(Infinity),
    gauge: { t: new Float32Array(1), eta: new Float32Array(1), lon: 0, lat: 0, count: () => 0 },
    achievedCoastMax: () => 1,
    calibration: { targetCoastHeight: 5, boundaryAmplitude: 1 },
    addFrame(depthAtCell1 = 0) {
      const f = new Float32Array(n);
      f[1] = depthAtCell1;
      frameList.push(f);
      out.revision++;
    },
  };
  return out;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** 地形の読み込みを終えた状態のコントローラー */
async function setup() {
  const store = new Store(createInitialState());
  store.set({ params: { ...store.get().params, resolution: 'coarse', durationMin: 30 } });
  const actions = createController(store);
  const grid = makeGrid('coarse');
  terrainRequests.shift()!.resolve(grid);
  await flush();
  return { store, actions, grid };
}

// ---------------------------------------------------------------------------

describe('中止・失敗の後の再生', () => {
  it('中止すると、計算済みの時刻で再生が止まり（playing=false）、再生すると最初から', async () => {
    const { store, actions, grid } = await setup();
    actions.runSimulation();
    const run = runs[0];
    expect(run.grid).toBe(grid);
    const out = makeOutput(grid, 1800);
    for (let i = 0; i < 30; i++) out.addFrame(); // 0〜600 秒
    run.handlers.onOutput(out);
    expect(store.get().time.playing).toBe(true);
    actions.setSpeed(240);
    actions.cancelSimulation();
    expect(run.cancelled).toBe(true);
    expect(store.get().sim.status).toBe('idle');
    expect(store.get().sim.output).toBe(out);
    expect(playbackEnd(store.get())).toBe(600);

    frames(40); // 240 倍 × 0.1 秒 × 40 = 960 秒ぶん
    expect(store.get().time).toMatchObject({ t: 600, playing: false });
    // 止まった後は requestAnimationFrame を回し続けない（毎フレームの更新をしない）
    expect(rafQueue.length).toBe(0);
    const updates = vi.fn();
    const unsub = store.subscribe(updates);
    frames(10);
    expect(updates).not.toHaveBeenCalled();
    unsub();

    // 計算済みの終わりから再生すると最初に戻る
    actions.play();
    expect(store.get().time).toMatchObject({ t: 0, playing: true });
  });

  it('失敗しても同じ（途中までの結果として残し、集計を受信済みのフレームまでそろえる）', async () => {
    const { store, actions, grid } = await setup();
    actions.runSimulation();
    const out = makeOutput(grid, 1800);
    for (let i = 0; i < 9; i++) out.addFrame(); // 0〜180 秒
    out.addFrame(0.5); // 200 秒: セル 1 が浸水（集計はまだ届いていない）
    runs[0].handlers.onOutput(out);
    runs[0].handlers.onError('テストの失敗');
    const s = store.get();
    expect(s.sim.status).toBe('error');
    expect(s.sim.output).toBe(out);
    expect(Number.isFinite(out.arrival[1])).toBe(true);
    expect(out.maxDepth[1]).toBeCloseTo(0.5, 6);
    expect(resultCoverage(s)).toMatchObject({ state: 'error', complete: false, until: 200 });
    frames(200);
    expect(store.get().time).toMatchObject({ t: 200, playing: false });
  });

  it('時刻の移動は計算済みの範囲まで', async () => {
    const { store, actions, grid } = await setup();
    actions.runSimulation();
    const out = makeOutput(grid, 1800);
    for (let i = 0; i < 20; i++) out.addFrame(); // 0〜400 秒
    runs[0].handlers.onOutput(out);
    actions.cancelSimulation();
    actions.seek(900);
    expect(store.get().time.t).toBe(400);
    actions.seek(-5);
    expect(store.get().time.t).toBe(0);
  });

  it('計算が完了した結果は最後まで再生して止まり、終わりから再生すると最初に戻る', async () => {
    const { store, actions, grid } = await setup();
    actions.runSimulation();
    const out = makeOutput(grid, 200);
    for (let i = 0; i < 10; i++) out.addFrame();
    out.complete = true;
    runs[0].handlers.onOutput(out);
    runs[0].handlers.onDone();
    actions.setSpeed(240);
    frames(20);
    expect(store.get().time).toMatchObject({ t: 200, playing: false });
    actions.play();
    expect(store.get().time.t).toBe(0);
  });
});

describe('地形の読み込み直し（結果は計算に使った地形の格子に結びつく）', () => {
  it('計算中に解像度を変えると、計算を中止して前の結果を消し、新しい地形で計算し直す', async () => {
    const { store, actions, grid } = await setup();
    actions.runSimulation();
    const out = makeOutput(grid, 1800);
    for (let i = 0; i < 10; i++) out.addFrame();
    runs[0].handlers.onOutput(out);

    actions.updateParams({ resolution: 'standard' });
    expect(runs[0].cancelled).toBe(true);
    let s = store.get();
    expect(s.sim.status).toBe('idle');
    expect(s.sim.output).toBeNull();
    expect(s.sim.queued).toBe(true);
    expect(s.time.playing).toBe(false);
    expect(terrainRequests.at(-1)!.resolution).toBe('standard');

    // 古い計算の遅れて届いた完了は無視される
    runs[0].handlers.onDone();
    expect(store.get().sim.status).toBe('idle');

    const std = makeGrid('standard');
    terrainRequests.shift()!.resolve(std);
    await flush();
    s = store.get();
    expect(runs).toHaveLength(2);
    expect(runs[1].grid).toBe(std);
    expect(runs[1].params.resolution).toBe('standard');
    expect(s.sim.status).toBe('running');
    expect(s.sim.run?.grid).toBe(std);
    expect(s.sim.queued).toBe(false);
  });

  it('計算を終えた後に地形を読み込み直す（簡易地形 → 標高データ）と、前の地形の結果を今の結果として使わない', async () => {
    const store = new Store(createInitialState());
    const actions = createController(store);
    const synthetic = makeGrid('standard', 'synthetic');
    terrainRequests.shift()!.resolve(synthetic);
    await flush();
    actions.runSimulation();
    const out = makeOutput(synthetic, 200);
    for (let i = 0; i < 10; i++) out.addFrame();
    out.complete = true;
    runs[0].handlers.onOutput(out);
    runs[0].handlers.onDone();
    expect(usableOutput(store.get())).toBe(out);

    actions.reloadTerrain();
    expect(store.get().sim.output).toBeNull();
    expect(usableOutput(store.get())).toBeNull();
    // 同じ形の格子（実際の地形）が届いても、前の結果は戻らない。計算は予約していないので自動では始めない
    const real = { ...makeGrid('standard', 'cache'), spec: synthetic.spec };
    terrainRequests.shift()!.resolve(real);
    await flush();
    expect(store.get().terrain.grid).toBe(real);
    expect(store.get().sim.output).toBeNull();
    expect(store.get().sim.message).toContain('前の計算結果を消去しました');
    expect(runs).toHaveLength(1);
  });

  it('地形の読み込みに失敗したら、読み込み後の計算の予約を取り消す', async () => {
    const store = new Store(createInitialState());
    const actions = createController(store);
    actions.runSimulation(); // 地形の読み込み中: 予約
    expect(store.get().sim.queued).toBe(true);
    terrainRequests.shift()!.reject(new Error('network'));
    await flush();
    expect(store.get().terrain.status).toBe('error');
    expect(store.get().sim.queued).toBe(false);
  });
});

describe('条件の変更と表示中の結果', () => {
  it('震度を選び直しても、表示中の結果の条件は計算した時のまま（再計算で新しい条件になる）', async () => {
    const { store, actions, grid } = await setup();
    const before = store.get().params;
    actions.runSimulation();
    const out = makeOutput(grid, 200);
    for (let i = 0; i < 10; i++) out.addFrame();
    out.complete = true;
    runs[0].handlers.onOutput(out);
    runs[0].handlers.onDone();

    actions.selectShindo('3');
    let s = store.get();
    expect(s.params.scenario.id).not.toBe(before.scenario.id);
    expect(isResultStale(s)).toBe(true);
    expect(resultParams(s)).toBe(before);
    expect(s.sim.run?.shindo).toBe('7');

    // 「この条件で計算し直す」: 計算中でも今の条件で計算し直す
    actions.runSimulation();
    s = store.get();
    expect(runs).toHaveLength(2);
    expect(runs[1].params).toBe(s.params);
    expect(s.sim.run?.params).toBe(s.params);
    expect(s.sim.run?.shindo).toBe('3');
    expect(isResultStale(s)).toBe(false);
  });

  it('計算中に条件を変えても計算は続き、「この条件で計算し直す」で中止して計算し直せる', async () => {
    const { store, actions } = await setup();
    actions.runSimulation();
    actions.selectShindo('3');
    expect(store.get().sim.status).toBe('running');
    expect(isResultStale(store.get())).toBe(true);
    actions.runSimulation();
    expect(runs[0].cancelled).toBe(true);
    expect(runs[1].params.scenario.id).toBe(store.get().params.scenario.id);
  });
});

describe('公式の津波浸水想定（人物の評価用のデータと、地図に重ねるタイルの取得可否）', () => {
  const fakeData = (failed = 0) => ({
    zoom: 15,
    originPx: 0,
    originPy: 0,
    width: 1,
    height: 1,
    codes: new Uint8Array(1),
    tiles: 48,
    fromMirror: 17,
    fromRemote: 0,
    missing: 31 - failed,
    failed,
  });

  it('起動時に読み込み、読み込めたら ready、読めなければ error（再試行で読み込み直す）', async () => {
    const { store, actions } = await setup();
    expect(officialLoads).toHaveLength(1);
    expect(store.get().officialInundation.status).toBe('loading');
    officialLoads[0].reject(new Error('公式の津波浸水想定を読み込めませんでした'));
    await flush();
    expect(store.get().officialInundation).toMatchObject({ status: 'error', data: null });
    expect(store.get().officialInundation.message).toContain('読み込めませんでした');

    actions.retryOfficialHazard();
    expect(officialLoads).toHaveLength(2);
    expect(store.get().officialInundation.status).toBe('loading');
    const data = fakeData(2);
    officialLoads[1].resolve(data);
    await flush();
    expect(store.get().officialInundation).toMatchObject({ status: 'ready', data });
    // 一部を読めなかったことは説明に残る。再試行すると読み込み直す
    expect(store.get().officialInundation.message).toContain('2枚');
    actions.retryOfficialHazard();
    expect(officialLoads).toHaveLength(3);
  });

  it('読み込み後に人物の避難計画を作り直す（最寄りの高台から公式の浸水想定区域を除くため）', async () => {
    const { store, actions } = await setup();
    const wait = () => new Promise((r) => setTimeout(r, 60));
    const person = actions.addPerson('adult', 139.47, 35.32);
    await wait();
    const before = store.get().plans;
    expect(before[person.id]).toBeDefined();
    officialLoads[0].resolve(fakeData());
    await flush();
    await wait();
    expect(store.get().plans).not.toBe(before);
    expect(store.get().plans[person.id]).toBeDefined();
  });

  it('公式ハザードマップを表示すると配信元に接続できるかを確かめ、できなければ error（画面に示す）', async () => {
    const { store, actions } = await setup();
    expect(displayChecks).toHaveLength(0);
    expect(store.get().officialInundation.display).toBe('unknown');
    actions.setLayer('officialHazard', true);
    expect(displayChecks).toHaveLength(1);
    expect(store.get().officialInundation.display).toBe('checking');
    displayChecks[0].resolve(false);
    await flush();
    expect(store.get().officialInundation.display).toBe('error');

    // 表示し直す・再試行で確かめ直す
    actions.setLayer('officialHazard', false);
    actions.setLayer('officialHazard', true);
    expect(displayChecks).toHaveLength(2);
    displayChecks[1].resolve(true);
    await flush();
    expect(store.get().officialInundation.display).toBe('ok');
    // 接続できたら、表示し直しても確かめない
    actions.setLayer('officialHazard', false);
    actions.setLayer('officialHazard', true);
    expect(displayChecks).toHaveLength(2);

    // ビュー（2D・3D）からの知らせ
    actions.reportOfficialHazardDisplay(false);
    expect(store.get().officialInundation.display).toBe('error');
    actions.retryOfficialHazard();
    expect(displayChecks).toHaveLength(3);
    // 古い確認の結果は、後から知らせた状態を上書きしない
    actions.reportOfficialHazardDisplay(true);
    displayChecks[2].resolve(false);
    await flush();
    expect(store.get().officialInundation.display).toBe('ok');
  });
});
