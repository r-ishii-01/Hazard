/**
 * メインスレッド ⇔ 計算ワーカー間のメッセージ形式。
 *
 * 逐次計算: メイン → 'run' → ワーカーが start / frame / calibrated / stats / progress / done を返す。
 * 並列計算（行の帯に分割）:
 *   1. メイン → ワーカー0 に 'run'（bands > 1）。ワーカー0 が準備（フレーム 0・校正・静止区間）を行い 'plan' を返す。
 *   2. メインが残りのワーカーを起動し、隣り合う帯を MessageChannel でつないで、全員に 'band' を送る。
 *   3. 各帯は毎ステップ隣の帯とのりしろを交換しながら計算し、フレームの担当行（'framePart'）と
 *      最大値など（'statsPart'）をメインへ送る。メインが組み立てる。最後に 'bandDone'。
 *   ヘルパーの起動に失敗した場合、メインはワーカー0 に 'serial' を送り、逐次計算に切り替える。
 *   帯どうしをつなぐポートはワーカー側では閉じない（隣が最後ののりしろを受け取る前に閉じると止まるため）。
 *   全部の帯が終わった時点でメインがワーカーを終了させる。
 */
import type { GridSpec } from '../core/geo';
import type { SimParams } from '../core/types';
import type { BandSpec, LocalGrid } from './band';
import type { CalibrationInfo, EnginePerf, EngineStartInfo, MainPlan } from './engine';

/** メイン → ワーカー */
export type WorkerRequest =
  | {
      type: 'run';
      spec: GridSpec;
      z: Float32Array;
      kind: Uint8Array;
      manning: Float32Array;
      params: SimParams;
      /** 本計算を分ける帯の数の希望（1 なら逐次） */
      bands: number;
    }
  | {
      type: 'band';
      spec: GridSpec;
      plan: MainPlan;
      band: BandSpec;
      /** 帯の局所格子（ワーカー0 は省略し、手元の全体の格子から切り出す） */
      local: LocalGrid | null;
      north: MessagePort | null;
      south: MessagePort | null;
    }
  | { type: 'serial' };

/** 帯どうしで交換するのりしろ（配列は転送し、受け取った側が次の送信に使い回す） */
export interface HaloMessage {
  step: number;
  buf: Float64Array;
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
  | { type: 'plan'; plan: MainPlan }
  | { type: 'framePart'; index: number; band: number; rowStart: number; data: Uint16Array; gaugeT: number[]; gaugeEta: number[] }
  | {
      type: 'statsPart';
      index: number;
      band: number;
      rowStart: number;
      maxDepth: Float32Array;
      maxEta: Float32Array;
      arrival: Float32Array;
      final: boolean;
    }
  | { type: 'bandDone'; band: number; perf: EnginePerf }
  | { type: 'done'; perf: EnginePerf }
  | { type: 'error'; message: string };
