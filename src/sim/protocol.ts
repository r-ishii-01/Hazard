/**
 * メインスレッド ⇔ 計算ワーカー間のメッセージ形式。
 */
import type { GridSpec } from '../core/geo';
import type { SimParams } from '../core/types';
import type { CalibrationInfo, EnginePerf, EngineStartInfo } from './engine';

/** メイン → ワーカー */
export interface RunRequest {
  type: 'run';
  spec: GridSpec;
  z: Float32Array;
  kind: Uint8Array;
  manning: Float32Array;
  params: SimParams;
}

/** ワーカー → メイン */
export type WorkerMessage =
  | { type: 'start'; info: EngineStartInfo }
  /** data が null ならフレーム 0 と同じ（静止状態） */
  | { type: 'frame'; index: number; data: Uint16Array | null; gaugeT: number[]; gaugeEta: number[] }
  | { type: 'calibrated'; info: CalibrationInfo }
  | {
      type: 'stats';
      maxDepth: Float32Array;
      maxEta: Float32Array;
      arrival: Float32Array;
      achievedCoastMax: number;
      final: boolean;
    }
  | { type: 'progress'; progress: number; message: string }
  | { type: 'done'; perf: EnginePerf }
  | { type: 'error'; message: string };
