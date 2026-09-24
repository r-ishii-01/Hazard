/**
 * 津波浸水シミュレーション（Web Worker で非線形長波方程式を解く）。
 *
 * 契約:
 * - SimRunner.run(grid, params, handlers) で計算開始（実行中の計算はキャンセルされる）。
 * - 最初のフレームが届いた時点で handlers.onOutput(output) を1回呼ぶ。
 *   output は以後も内部でフレームが追加されていく（framesReady()/timeReady() が増える）。
 * - handlers.onProgress(0..1, message) を適宜、完了時 onDone()、失敗時 onError(message)。
 *
 * 計算の中身は solver.ts（差分スキーム）・engine.ts（校正・出力の手順）・band.ts（並列計算）、
 * ワーカー側のメッセージ処理は workerCore.ts（worker.ts はそれを Worker につなぐだけ）を参照。
 * 計算の終了・中止・再実行ではワーカーを終了してハンドラも外すので、古い計算の結果が残り続けることはない。
 * 大きな格子では、本計算を行の帯に分けて複数のワーカーで並列に計算する（結果は逐次計算とビット単位で同じ）。
 * output は SimOutput に加えて calibrationDetail・notes・revision・complete・perf を持つ（SimRunOutput）。
 */
import type { SimOutput, SimParams, TerrainGrid } from '../core/types';
import { coastMaxFrom, progressMessage } from './common';
import type { EnginePerf, EngineStartInfo, MainPlan } from './engine';
import { SimRunOutput } from './output';
import type { WorkerMessage, WorkerRequest } from './protocol';

export { SimRunOutput } from './output';
export type { CalibrationInfo, EnginePerf } from './engine';

export interface SimHandlers {
  onProgress(progress: number, message: string): void;
  onOutput(output: SimOutput): void;
  onDone(): void;
  onError(message: string): void;
}

export interface SimRunnerOptions {
  /** 本計算に使うワーカー数の上限（既定: 論理コア数 − 1、最大 4〜6。1 なら逐次） */
  maxWorkers?: number;
  /** 並列計算を使う最小のセル数（既定 PARALLEL_MIN_CELLS） */
  parallelMinCells?: number;
}

/** 並列計算を使う最小のセル数（これより小さい格子では通信の手間が見合わない） */
export const PARALLEL_MIN_CELLS = 60_000;

function createWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'tsunami-sim' });
}

/** 本計算を分ける帯の数 */
export function chooseBandCount(cells: number, cores: number, maxWorkers?: number, minCells = PARALLEL_MIN_CELLS): number {
  if (cells < minCells) return 1;
  const cap = cells > 300_000 ? 6 : 4;
  const limit = Math.min(cap, maxWorkers ?? cap);
  // 画面の描画のために1コア残す
  return Math.max(1, Math.min(limit, (cores > 0 ? cores : 2) - 1));
}

export class SimRunner {
  private workers: Worker[] = [];
  private seq = 0;
  private readonly opts: SimRunnerOptions;

  constructor(opts: SimRunnerOptions = {}) {
    this.opts = opts;
  }

  run(grid: TerrainGrid, params: SimParams, handlers: SimHandlers): void {
    this.cancel();
    const seq = ++this.seq;
    const alive = () => seq === this.seq;
    const call = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        console.error('[sim] handler error', e);
      }
    };
    const workers: Worker[] = [];
    this.workers = workers;
    const stopAll = () => {
      for (const w of workers) stopWorker(w);
      workers.length = 0;
      if (this.workers === workers) this.workers = [];
    };
    const fail = (message: string) => {
      if (!alive()) return;
      this.seq++;
      stopAll();
      call(() => handlers.onError(message));
    };

    const { nx, ny } = grid.spec;
    const n = nx * ny;
    let info: EngineStartInfo | null = null;
    let output: SimRunOutput | null = null;

    // ---- 並列計算の組み立て ----
    let plan: MainPlan | null = null;
    let bandCount = 1;
    const parts = new Map<number, { data: Uint16Array; count: number; gaugeT: number[]; gaugeEta: number[] }>();
    const statsCount = new Map<number, number>();
    let bandsDone = 0;
    const bandPerf: EnginePerf[] = [];

    const flushFrames = () => {
      if (!output || !plan) return;
      for (;;) {
        const next = output.framesReady();
        const e = parts.get(next);
        if (!e || e.count < bandCount) break;
        parts.delete(next);
        output.addFrame(next, e.data);
        output.addGauge(e.gaugeT, e.gaugeEta);
        const span = Math.max(1, plan.lastFrame - plan.startFrame);
        const p = 0.2 + (0.8 * (next - plan.startFrame)) / span;
        const msg = progressMessage(next * plan.frameInterval, bandCount);
        call(() => handlers.onProgress(p, msg));
      }
    };
    const finishIfDone = () => {
      if (!output || !plan || bandsDone < bandCount || output.framesReady() <= plan.lastFrame) return;
      const perf: EnginePerf = {
        steps: bandPerf[0]?.steps ?? 0,
        dt: plan.dt,
        activeCells: bandPerf.reduce((a, p) => a + p.activeCells, 0),
        mainMs: Math.max(...bandPerf.map((p) => p.mainMs)),
        calibrationMs: plan.calibrationMs,
        stepsPerSec: Math.min(...bandPerf.map((p) => p.stepsPerSec)),
        bands: bandCount,
        perBand: bandPerf.map((p) => ({ activeCells: p.activeCells, mainMs: Math.round(p.mainMs), waitMs: Math.round(p.waitMs ?? 0) })),
      };
      output.markComplete(perf);
      this.seq++;
      stopAll();
      call(() => handlers.onDone());
    };

    /** ワーカー0 の準備が済んだら残りのワーカーを起動し、帯の計算を始める */
    const startBands = (p: MainPlan) => {
      const w0 = workers[0];
      const K = p.bands.length;
      const helpers: Worker[] = [];
      const messages: { worker: Worker; msg: WorkerRequest; transfer: Transferable[] }[] = [];
      try {
        // 失敗しうる処理（ワーカーの起動など）はワーカー0 に指示を送る前にすべて済ませる
        const channels = p.bands.slice(1).map(() => new MessageChannel());
        for (let b = 1; b < K; b++) helpers.push(createWorker());
        for (let b = 0; b < K; b++) {
          const band = p.bands[b];
          const north = b > 0 ? channels[b - 1].port2 : null;
          const south = b < K - 1 ? channels[b].port1 : null;
          const local =
            b === 0
              ? null
              : {
                  z: grid.z.slice(band.localStart * nx, band.localEnd * nx),
                  kind: grid.kind.slice(band.localStart * nx, band.localEnd * nx),
                  manning: grid.manning.slice(band.localStart * nx, band.localEnd * nx),
                };
          const transfer: Transferable[] = [];
          if (north) transfer.push(north);
          if (south) transfer.push(south);
          if (local) transfer.push(local.z.buffer, local.kind.buffer, local.manning.buffer);
          messages.push({ worker: b === 0 ? w0 : helpers[b - 1], msg: { type: 'band', spec: grid.spec, plan: p, band, local, north, south }, transfer });
        }
        for (const w of helpers) {
          attach(w);
          workers.push(w);
        }
        // ワーカー0 は最後（ここまでに失敗すれば、ワーカー0 は準備済みのまま逐次計算に切り替えられる）
        for (let b = K - 1; b >= 1; b--) messages[b].worker.postMessage(messages[b].msg, messages[b].transfer);
      } catch (e) {
        // 追加のワーカーを起動できない環境: 逐次計算に切り替える
        console.warn('[sim] parallel start failed; falling back to serial', e);
        for (const w of helpers) stopWorker(w);
        workers.length = 1;
        w0.postMessage({ type: 'serial' } satisfies WorkerRequest);
        return;
      }
      plan = p;
      bandCount = K;
      w0.postMessage(messages[0].msg, messages[0].transfer);
    };

    const onMessage = (m: WorkerMessage) => {
      switch (m.type) {
        case 'start':
          info = m.info;
          break;
        case 'frame':
          if (!output) {
            if (!info || m.index !== 0 || !m.data) throw new Error('最初のフレームを受け取れませんでした');
            output = new SimRunOutput(grid.spec, grid.z, info, params.scenario.coastHeight);
            output.addFrame(0, m.data);
            output.addGauge(m.gaugeT, m.gaugeEta);
            const out = output;
            call(() => handlers.onOutput(out));
          } else {
            output.addFrame(m.index, m.data);
            output.addGauge(m.gaugeT, m.gaugeEta);
          }
          break;
        case 'calibrated':
          output?.setCalibration(m.info);
          break;
        case 'stats':
          output?.setStats(m.maxDepth, m.maxEta, m.arrival, m.achievedCoastMax);
          break;
        case 'progress':
          call(() => handlers.onProgress(m.progress, m.message));
          break;
        case 'plan':
          startBands(m.plan);
          break;
        case 'framePart': {
          let e = parts.get(m.index);
          if (!e) {
            e = { data: new Uint16Array(n), count: 0, gaugeT: [], gaugeEta: [] };
            parts.set(m.index, e);
          }
          e.data.set(m.data, m.rowStart * nx);
          e.count++;
          if (m.gaugeT.length > 0) {
            e.gaugeT = m.gaugeT;
            e.gaugeEta = m.gaugeEta;
          }
          flushFrames();
          finishIfDone();
          break;
        }
        case 'statsPart': {
          if (!output || !plan) break;
          output.setStatsRows(m.rowStart, m.maxDepth, m.maxEta, m.arrival);
          const c = (statsCount.get(m.index) ?? 0) + 1;
          if (c >= bandCount) {
            statsCount.delete(m.index);
            output.setAchieved(coastMaxFrom(output.maxEta, plan.segmentCells, plan.tide));
          } else statsCount.set(m.index, c);
          break;
        }
        case 'bandDone':
          bandsDone++;
          bandPerf[m.band] = m.perf;
          finishIfDone();
          break;
        case 'done':
          output?.markComplete(m.perf);
          this.seq++;
          stopAll();
          call(() => handlers.onDone());
          break;
        case 'error':
          fail(m.message);
          break;
      }
    };

    const attach = (w: Worker) => {
      w.onmessage = (ev: MessageEvent<WorkerMessage>) => {
        if (!alive()) return;
        try {
          onMessage(ev.data);
        } catch (e) {
          console.error('[sim] message handling failed', e);
          fail(`計算結果の受け取りに失敗しました（${e instanceof Error ? e.message : String(e)}）`);
        }
      };
      w.onerror = (ev: ErrorEvent) => {
        ev.preventDefault();
        console.error('[sim] worker error', ev.message);
        fail(`計算中にエラーが発生しました（${ev.message || '不明なエラー'}）`);
      };
      w.onmessageerror = () => fail('計算結果を受け取れませんでした（データの受け渡しに失敗）。');
    };

    let w0: Worker;
    try {
      w0 = createWorker();
    } catch (e) {
      console.error('[sim] worker start failed', e);
      this.workers = [];
      call(() => handlers.onError('計算用のワーカーを起動できませんでした。ブラウザが Web Worker に対応しているか確認してください。'));
      return;
    }
    attach(w0);
    workers.push(w0);

    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const req: WorkerRequest = {
      type: 'run',
      spec: grid.spec,
      z: grid.z,
      kind: grid.kind,
      manning: grid.manning,
      params,
      bands: chooseBandCount(n, cores, this.opts.maxWorkers, this.opts.parallelMinCells),
    };
    try {
      w0.postMessage(req);
    } catch (e) {
      console.error('[sim] postMessage failed', e);
      fail('計算を開始できませんでした（地形データを渡せませんでした）。');
    }
  }

  /** 実行中の計算を中止する（受信済みの結果はそのまま使える） */
  cancel(): void {
    this.seq++;
    for (const w of this.workers) stopWorker(w);
    this.workers = [];
  }
}

/** ワーカーを終了し、ハンドラを外す（終了したワーカーへの参照が残っても、計算結果を抱え込まないように） */
function stopWorker(w: Worker): void {
  w.terminate();
  w.onmessage = null;
  w.onerror = null;
  w.onmessageerror = null;
}
