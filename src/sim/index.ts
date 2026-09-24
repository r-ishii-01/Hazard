/**
 * 津波浸水シミュレーション（Web Worker で非線形長波方程式を解く）。
 *
 * 契約:
 * - SimRunner.run(grid, params, handlers) で計算開始（実行中の計算はキャンセルされる）。
 * - 最初のフレームが届いた時点で handlers.onOutput(output) を1回呼ぶ。
 *   output は以後も内部でフレームが追加されていく（framesReady()/timeReady() が増える）。
 * - handlers.onProgress(0..1, message) を適宜、完了時 onDone()、失敗時 onError(message)。
 *
 * 計算の中身は solver.ts（差分スキーム）と engine.ts（校正・出力の手順）を参照。
 * output は SimOutput に加えて calibrationDetail・notes・revision・complete を持つ（SimRunOutput）。
 */
import type { SimOutput, SimParams, TerrainGrid } from '../core/types';
import type { EngineStartInfo } from './engine';
import { SimRunOutput } from './output';
import type { RunRequest, WorkerMessage } from './protocol';

export { SimRunOutput } from './output';
export type { CalibrationInfo, EnginePerf } from './engine';

export interface SimHandlers {
  onProgress(progress: number, message: string): void;
  onOutput(output: SimOutput): void;
  onDone(): void;
  onError(message: string): void;
}

export class SimRunner {
  private worker: Worker | null = null;
  private seq = 0;

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

    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'tsunami-sim' });
    } catch (e) {
      console.error('[sim] worker start failed', e);
      call(() => handlers.onError('計算用のワーカーを起動できませんでした。ブラウザが Web Worker に対応しているか確認してください。'));
      return;
    }
    this.worker = worker;

    let info: EngineStartInfo | null = null;
    let output: SimRunOutput | null = null;
    const stop = () => {
      if (this.worker === worker) this.worker = null;
      worker.terminate();
    };
    const fail = (message: string) => {
      if (!alive()) return;
      this.seq++;
      stop();
      call(() => handlers.onError(message));
    };

    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      if (!alive()) return;
      const m = ev.data;
      try {
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
          case 'done':
            output?.markComplete(m.perf);
            this.seq++;
            stop();
            call(() => handlers.onDone());
            break;
          case 'error':
            fail(m.message);
            break;
        }
      } catch (e) {
        console.error('[sim] message handling failed', e);
        fail(`計算結果の受け取りに失敗しました（${e instanceof Error ? e.message : String(e)}）`);
      }
    };
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault();
      console.error('[sim] worker error', ev.message);
      fail(`計算中にエラーが発生しました（${ev.message || '不明なエラー'}）`);
    };
    worker.onmessageerror = () => fail('計算結果を受け取れませんでした（データの受け渡しに失敗）。');

    const req: RunRequest = { type: 'run', spec: grid.spec, z: grid.z, kind: grid.kind, manning: grid.manning, params };
    try {
      worker.postMessage(req);
    } catch (e) {
      console.error('[sim] postMessage failed', e);
      fail('計算を開始できませんでした（地形データを渡せませんでした）。');
    }
  }

  /** 実行中の計算を中止する（受信済みの結果はそのまま使える） */
  cancel(): void {
    this.seq++;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
