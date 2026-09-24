/**
 * 津波浸水シミュレーション（Web Worker で非線形長波方程式を解く）。［スタブ: sim 担当が実装］
 *
 * 契約:
 * - SimRunner.run(grid, params, handlers) で計算開始（実行中の計算はキャンセルされる）。
 * - 最初のフレームが届いた時点で handlers.onOutput(output) を1回呼ぶ。
 *   output は以後も内部でフレームが追加されていく（framesReady()/timeReady() が増える）。
 * - handlers.onProgress(0..1, message) を適宜、完了時 onDone()、失敗時 onError(message)。
 */
import type { SimOutput, SimParams, TerrainGrid } from '../core/types';

export interface SimHandlers {
  onProgress(progress: number, message: string): void;
  onOutput(output: SimOutput): void;
  onDone(): void;
  onError(message: string): void;
}

export class SimRunner {
  run(_grid: TerrainGrid, _params: SimParams, handlers: SimHandlers): void {
    handlers.onError('SimRunner: not implemented');
  }
  cancel(): void {}
}
