/**
 * SimRunner（メインスレッド側）とワーカーのメッセージのやり取り。
 * Node には Worker が無いので、ワーカーの中身（workerCore.ts）を同じスレッドで動かす偽の Worker を使う。
 * メッセージは structuredClone（転送リスト付き）で渡すので、転送した配列を使い回すような誤りは結果の不一致として表れる。
 * 終了（terminate）後も、それまでに送られたメッセージは配達する（実際のブラウザでも起こりうる最悪の場合）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuakeScenario, SimOutput, SimParams, TerrainGrid } from '../src/core/types';
import { SimRunner, SimRunOutput, type SimHandlers } from '../src/sim';
import type { WorkerRequest } from '../src/sim/protocol';
import { makeKugenumaLikeGrid } from '../src/sim/synthetic';
import { createWorkerCore, type WorkerCore } from '../src/sim/workerCore';

class FakeWorker {
  static all: FakeWorker[] = [];
  /** true にすると、2つ目以降の Worker の生成に失敗する（並列計算を始められない環境の再現） */
  static failAfterFirst = false;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  terminated = false;
  /** 終了後に届いた（無視されるべき）メッセージの数 */
  lateMessages = 0;
  private readonly core: WorkerCore;

  constructor() {
    if (FakeWorker.failAfterFirst && FakeWorker.all.length > 0) throw new Error('worker limit');
    FakeWorker.all.push(this);
    this.core = createWorkerCore((message, transfer) => {
      const data = structuredClone(message, { transfer });
      // 送信時点のハンドラに配達する（終了の直前に送られ、配達待ちだったメッセージの再現）
      const handler = this.onmessage;
      setTimeout(() => {
        if (this.terminated) this.lateMessages++;
        handler?.({ data } as MessageEvent);
      }, 0);
    });
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    const data = structuredClone(message, { transfer }) as WorkerRequest;
    setTimeout(() => {
      if (!this.terminated) this.core.handle(data);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
    this.core.dispose();
  }
}

const released = (w: FakeWorker) => w.terminated && w.onmessage === null && w.onerror === null;

const scenario: QuakeScenario = {
  id: 'runner',
  name: 'メッセージの検証用',
  shortName: '検証',
  magnitude: null,
  shindo: '6+',
  coastHeight: 5,
  arrivalMin: 7,
  periodMin: 5,
  firstMotion: 'rise',
  waves: 2,
  shakingSec: 60,
  warning: 'major',
  description: '',
  isOfficial: false,
};

const params = (p: Partial<SimParams> = {}): SimParams => ({
  scenario,
  tideTP: 0,
  durationMin: 12,
  resolution: 'coarse',
  landManning: 0.06,
  ...p,
});

/** 小さな合成地形（約 31 m 格子、146×90 程度） */
const small = (): TerrainGrid =>
  makeKugenumaLikeGrid({
    resolution: 'coarse',
    bounds: { west: 139.445, east: 139.495, south: 35.297, north: 35.322 },
    shelfDepth: 12,
    duneHeight: 0,
    plainHeight: 3,
    island: false,
    rivers: false,
  });

interface Recorder {
  handlers: SimHandlers;
  outputs: SimOutput[];
  done: number;
  errors: string[];
  progress: number[];
  calls: number;
  finished: Promise<void>;
}

function recorder(): Recorder {
  let resolve!: () => void;
  const finished = new Promise<void>((r) => (resolve = r));
  const rec: Recorder = {
    outputs: [],
    done: 0,
    errors: [],
    progress: [],
    calls: 0,
    finished,
    handlers: {
      onProgress: (p) => {
        rec.calls++;
        rec.progress.push(p);
      },
      onOutput: (o) => {
        rec.calls++;
        rec.outputs.push(o);
      },
      onDone: () => {
        rec.calls++;
        rec.done++;
        resolve();
      },
      onError: (m) => {
        rec.calls++;
        rec.errors.push(m);
        resolve();
      },
    },
  };
  return rec;
}

/** イベントループを回して、届いているメッセージをすべて処理させる */
const drain = async (ms = 50) => {
  await new Promise((r) => setTimeout(r, ms));
};

function framesOf(out: SimOutput): Float32Array[] {
  const n = out.spec.nx * out.spec.ny;
  const res: Float32Array[] = [];
  for (let f = 0; f < out.framesReady(); f++) {
    const buf = new Float32Array(n);
    out.fillDepth(f * out.frameInterval, buf);
    res.push(buf);
  }
  return res;
}

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.failAfterFirst = false;
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
});

afterEach(() => {
  for (const w of FakeWorker.all) w.terminate();
  vi.unstubAllGlobals();
});

describe('SimRunner とワーカーのやり取り', () => {
  const grid = small();

  it('onOutput は1回だけ、最後まで計算すると onDone、ワーカーは終了される', async () => {
    const runner = new SimRunner({ maxWorkers: 1 });
    const rec = recorder();
    runner.run(grid, params(), rec.handlers);
    await rec.finished;
    expect(rec.errors).toEqual([]);
    expect(rec.outputs.length).toBe(1);
    expect(rec.done).toBe(1);
    const out = rec.outputs[0] as SimRunOutput;
    expect(out).toBeInstanceOf(SimRunOutput);
    expect(out.complete).toBe(true);
    expect(out.durationSec).toBe(12 * 60);
    expect(out.framesReady()).toBe(out.durationSec / out.frameInterval + 1);
    expect(out.timeReady()).toBe(out.durationSec);
    expect(out.gauge.count()).toBe(out.durationSec / 10 + 1);
    expect(out.calibration.boundaryAmplitude).toBeGreaterThan(0);
    expect(Number.isFinite(out.achievedCoastMax())).toBe(true);
    for (let i = 1; i < rec.progress.length; i++) expect(rec.progress[i]).toBeGreaterThanOrEqual(rec.progress[i - 1] - 1e-9);
    expect(FakeWorker.all.length).toBe(1);
    expect(FakeWorker.all.every(released)).toBe(true);
    // 完了後に何も届かない
    const calls = rec.calls;
    await drain();
    expect(rec.calls).toBe(calls);
  }, 120_000);

  it('実行中に run し直すと、前の計算のハンドラは二度と呼ばれず、前のワーカーは終了される', async () => {
    const runner = new SimRunner({ maxWorkers: 1 });
    const first = recorder();
    const second = recorder();
    let callsAtRestart = -1;
    // 最初の出力（フレーム 0）を受け取った時点で（残りのメッセージは配達待ち）、もう一度 run する
    const onOutput = first.handlers.onOutput;
    first.handlers.onOutput = (o) => {
      onOutput(o);
      callsAtRestart = first.calls;
      runner.run(grid, params({ durationMin: 10 }), second.handlers);
      expect(FakeWorker.all[0].terminated).toBe(true);
    };
    runner.run(grid, params({ durationMin: 10 }), first.handlers);
    await second.finished;
    await drain();
    expect(first.calls).toBe(callsAtRestart);
    expect(first.done).toBe(0);
    expect(first.errors).toEqual([]);
    expect(FakeWorker.all[0].lateMessages).toBeGreaterThan(0); // 終了後に届いたメッセージは無視された
    expect(second.outputs.length).toBe(1);
    expect(second.done).toBe(1);
    expect(second.errors).toEqual([]);
    expect(FakeWorker.all.every(released)).toBe(true);
  }, 120_000);

  it('run を続けて呼ぶと、最後の計算だけが結果を返す', async () => {
    const runner = new SimRunner({ maxWorkers: 1 });
    const a = recorder();
    const b = recorder();
    runner.run(grid, params({ durationMin: 5 }), a.handlers);
    runner.run(grid, params({ durationMin: 5 }), b.handlers);
    await b.finished;
    await drain();
    expect(a.calls).toBe(0);
    expect(b.outputs.length).toBe(1);
    expect(b.done).toBe(1);
  }, 120_000);

  it('cancel の後はハンドラが呼ばれず、ワーカーは終了される', async () => {
    const runner = new SimRunner({ maxWorkers: 1 });
    const rec = recorder();
    let calls = -1;
    // 途中（フレームを数枚受け取った時点。残りのメッセージは配達待ち）で中止する
    const onProgress = rec.handlers.onProgress;
    rec.handlers.onProgress = (p, m) => {
      onProgress(p, m);
      if (calls < 0 && rec.outputs.length > 0 && rec.outputs[0].framesReady() >= 3) {
        runner.cancel();
        calls = rec.calls;
      }
    };
    runner.run(grid, params({ durationMin: 10 }), rec.handlers);
    while (calls < 0) await drain(5);
    expect(FakeWorker.all.every(released)).toBe(true);
    await drain(200);
    expect(rec.calls).toBe(calls);
    expect(rec.done).toBe(0);
    expect(FakeWorker.all[0].lateMessages).toBeGreaterThan(0);
    // 受信済みの結果はそのまま使える
    expect(rec.outputs[0].framesReady()).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('地形データが壊れていれば日本語の onError（onOutput は呼ばれない）', async () => {
    const runner = new SimRunner({ maxWorkers: 1 });
    const rec = recorder();
    runner.run({ ...grid, z: new Float32Array(10) }, params(), rec.handlers);
    await rec.finished;
    await drain();
    expect(rec.outputs.length).toBe(0);
    expect(rec.done).toBe(0);
    expect(rec.errors.length).toBe(1);
    expect(rec.errors[0]).toMatch(/地形データ/);
    expect(FakeWorker.all.every(released)).toBe(true);
  }, 60_000);
});

describe('SimRunner の並列計算（行の帯）', () => {
  // 帯は最低 40 行必要なので、南北に長めの範囲にする
  const grid = makeKugenumaLikeGrid({
    resolution: 'coarse',
    bounds: { west: 139.452, east: 139.49, south: 35.294, north: 35.334 },
    shelfDepth: 12,
    duneHeight: 4,
    plainHeight: 2.5,
    island: false,
    rivers: true,
  });
  const p = params({ durationMin: 11 });
  let serial: { out: SimRunOutput; frames: Float32Array[] } | null = null;

  const runWith = async (opts: ConstructorParameters<typeof SimRunner>[0]) => {
    const runner = new SimRunner(opts);
    const rec = recorder();
    runner.run(grid, p, rec.handlers);
    await rec.finished;
    await drain();
    expect(rec.errors).toEqual([]);
    expect(rec.outputs.length).toBe(1);
    expect(rec.done).toBe(1);
    const out = rec.outputs[0] as SimRunOutput;
    return { out, frames: framesOf(out) };
  };

  const expectSame = (a: { out: SimRunOutput; frames: Float32Array[] }, b: { out: SimRunOutput; frames: Float32Array[] }) => {
    expect(b.frames.length).toBe(a.frames.length);
    for (let f = 0; f < a.frames.length; f++) expect(b.frames[f]).toEqual(a.frames[f]);
    expect(b.out.maxDepth).toEqual(a.out.maxDepth);
    expect(b.out.maxEta).toEqual(a.out.maxEta);
    expect(b.out.arrival).toEqual(a.out.arrival);
    expect(b.out.gauge.count()).toBe(a.out.gauge.count());
    expect(b.out.gauge.eta.slice(0, a.out.gauge.count())).toEqual(a.out.gauge.eta.slice(0, a.out.gauge.count()));
    expect(b.out.achievedCoastMax()).toBe(a.out.achievedCoastMax());
  };

  it('逐次計算（基準）', async () => {
    expect(grid.spec.ny).toBeGreaterThanOrEqual(120);
    serial = await runWith({ maxWorkers: 1 });
    expect(serial.out.perf?.bands).toBe(1);
    let flooded = 0;
    for (let k = 0; k < serial.out.maxDepth.length; k++) if (serial.out.maxDepth[k] > 0.01) flooded++;
    expect(flooded).toBeGreaterThan(100);
  }, 120_000);

  it('3つの帯に分けても、フレーム・最大値・潮位計が逐次計算とビット単位で一致する', async () => {
    const par = await runWith({ maxWorkers: 3, parallelMinCells: 1 });
    expect(par.out.perf?.bands).toBe(3);
    expect(FakeWorker.all.length).toBe(3);
    expect(FakeWorker.all.every(released)).toBe(true);
    expectSame(serial!, par);
  }, 180_000);

  it('追加のワーカーを起動できなければ逐次計算に切り替えて最後まで計算する', async () => {
    FakeWorker.failAfterFirst = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fb = await runWith({ maxWorkers: 3, parallelMinCells: 1 });
    expect(warn).toHaveBeenCalled();
    expect(FakeWorker.all.length).toBe(1);
    expect(fb.out.perf?.bands).toBe(1);
    expectSame(serial!, fb);
  }, 180_000);
});
