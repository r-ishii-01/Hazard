/**
 * メインスレッド側の計算結果（ワーカーから逐次届くフレームを保持し、時刻で線形補間して参照する）。
 */
import type { GridSpec } from '../core/geo';
import type { SimOutput } from '../core/types';
import type { CalibrationInfo, EnginePerf, EngineStartInfo } from './engine';

/** etaAt で水があるとみなす最小の全水深 [m]（フレームは cm 単位なので 0.5 cm） */
const WET_DEPTH = 0.005;

export class SimRunOutput implements SimOutput {
  readonly spec: GridSpec;
  readonly frameInterval: number;
  readonly durationSec: number;
  /** 陸域セル（初期に乾燥）の最大浸水深 [m]。完了前は途中までの最大値（配列は同じものを更新する） */
  readonly maxDepth: Float32Array;
  /** 最大水位 [m, T.P.]。一度も濡れていないセルは NaN */
  readonly maxEta: Float32Array;
  /** 初期乾燥セルが最初に浸水（深さ ≥ 0.01 m）した時刻 [秒]。未浸水・海域は +Infinity */
  readonly arrival: Float32Array;
  readonly gauge: { t: Float32Array; eta: Float32Array; lon: number; lat: number; count(): number };
  calibration: { targetCoastHeight: number; boundaryAmplitude: number };
  /** 校正の詳細（試算の記録・入力開始時刻）。校正が済むまでは null */
  calibrationDetail: CalibrationInfo | null = null;
  /** 利用者向けの注記（日本語。到達時間の補正・振幅の制限など） */
  notes: string[] = [];
  /** 潮位 [m, T.P.] */
  readonly tide: number;
  /** 計算が最後まで終わったら true */
  complete = false;
  /** 性能の記録（完了後） */
  perf: EnginePerf | null = null;
  /**
   * 内容が更新されるたびに増える番号（フレーム・最大値・校正）。
   * maxDepth などの配列は同じオブジェクトを書き換えるので、再描画の判定に使う。
   */
  revision = 0;

  private readonly frames: Uint16Array[] = [];
  private readonly z: ArrayLike<number>;
  private readonly n: number;
  private achieved: number;
  private gaugeCount = 0;

  constructor(spec: GridSpec, z: ArrayLike<number>, info: EngineStartInfo, targetCoastHeight: number) {
    this.spec = spec;
    this.z = z;
    this.n = spec.nx * spec.ny;
    this.frameInterval = info.frameInterval;
    this.durationSec = info.durationSec;
    this.tide = info.tide;
    this.achieved = info.tide;
    this.maxDepth = new Float32Array(this.n);
    this.maxEta = new Float32Array(this.n).fill(NaN);
    this.arrival = new Float32Array(this.n).fill(Infinity);
    const cap = Math.max(1, info.gauge.capacity);
    const count = () => this.gaugeCount;
    this.gauge = { t: new Float32Array(cap), eta: new Float32Array(cap), lon: info.gauge.lon, lat: info.gauge.lat, count };
    this.calibration = { targetCoastHeight, boundaryAmplitude: NaN };
  }

  // ---- ワーカーからの受信 ----

  /** フレームを追加（番号は 0 から連続）。data が null ならフレーム 0 と同じ */
  addFrame(index: number, data: Uint16Array | null): void {
    if (index !== this.frames.length) throw new Error(`フレームの順序が不正です（${index}）`);
    if (data === null) {
      if (this.frames.length === 0) throw new Error('最初のフレームがありません');
      this.frames.push(this.frames[0]);
    } else {
      if (data.length !== this.n) throw new Error('フレームの大きさが格子と一致しません');
      this.frames.push(data);
      if (index === 0) {
        // 最大水位の初期値（最初から水のあるセル）
        for (let k = 0; k < this.n; k++) if (data[k] > 0) this.maxEta[k] = this.z[k] + data[k] * 0.01;
      }
    }
    this.revision++;
  }

  addGauge(t: ArrayLike<number>, eta: ArrayLike<number>): void {
    const cap = this.gauge.t.length;
    for (let i = 0; i < t.length && this.gaugeCount < cap; i++) {
      this.gauge.t[this.gaugeCount] = t[i];
      this.gauge.eta[this.gaugeCount] = eta[i];
      this.gaugeCount++;
    }
  }

  setStats(maxDepth: Float32Array, maxEta: Float32Array, arrival: Float32Array, achievedCoastMax: number): void {
    if (maxDepth.length === this.n) this.maxDepth.set(maxDepth);
    if (maxEta.length === this.n) this.maxEta.set(maxEta);
    if (arrival.length === this.n) this.arrival.set(arrival);
    if (Number.isFinite(achievedCoastMax)) this.achieved = achievedCoastMax;
    this.revision++;
  }

  setCalibration(info: CalibrationInfo): void {
    this.calibrationDetail = info;
    this.calibration = { targetCoastHeight: info.targetCoastHeight, boundaryAmplitude: info.boundaryAmplitude };
    this.notes = [...info.notes];
    this.revision++;
  }

  markComplete(perf: EnginePerf | null): void {
    this.complete = true;
    this.perf = perf;
    this.revision++;
  }

  // ---- SimOutput ----

  framesReady(): number {
    return this.frames.length;
  }

  timeReady(): number {
    return this.frames.length > 0 ? (this.frames.length - 1) * this.frameInterval : 0;
  }

  depthAt(t: number, k: number): number {
    const nf = this.frames.length;
    if (nf === 0 || !(k >= 0 && k < this.n)) return 0;
    let f = t / this.frameInterval;
    if (!(f > 0)) f = 0;
    const last = nf - 1;
    if (f >= last) return this.frames[last][k] * 0.01;
    const i0 = Math.floor(f);
    const a = f - i0;
    const v0 = this.frames[i0][k];
    return (v0 + (this.frames[i0 + 1][k] - v0) * a) * 0.01;
  }

  etaAt(t: number, k: number): number {
    const d = this.depthAt(t, k);
    return d >= WET_DEPTH ? this.z[k] + d : NaN;
  }

  fillDepth(t: number, out: Float32Array): void {
    const nf = this.frames.length;
    const n = Math.min(this.n, out.length);
    if (nf === 0) {
      out.fill(0, 0, n);
      return;
    }
    let f = t / this.frameInterval;
    if (!(f > 0)) f = 0;
    const last = nf - 1;
    const i0 = f >= last ? last : Math.floor(f);
    const a = f >= last ? 0 : f - i0;
    const F0 = this.frames[i0];
    if (a === 0 || F0 === this.frames[i0 + 1]) {
      for (let k = 0; k < n; k++) out[k] = F0[k] * 0.01;
      return;
    }
    const F1 = this.frames[i0 + 1];
    const b = 1 - a;
    for (let k = 0; k < n; k++) out[k] = (F0[k] * b + F1[k] * a) * 0.01;
  }

  achievedCoastMax(): number {
    return this.achieved;
  }
}
