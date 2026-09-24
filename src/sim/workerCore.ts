/**
 * 計算ワーカーの中身（メッセージの処理）。worker.ts はこれを Worker のグローバルにつなぐだけ。
 * Worker に依存しないので、テストでは同じスレッド内の偽の Worker からそのまま呼べる。
 * メッセージ形式は protocol.ts を参照。フレームや最大値の配列は転送（コピーなし）で返す。
 */
import { BandRunner, sliceRows } from './band';
import { UNSTABLE_MESSAGE } from './common';
import { prepareRun, runSerialMain, type EnginePerf, type EngineSink, type MainPlan, type PreparedRun } from './engine';
import type { HaloMessage, WorkerMessage, WorkerRequest } from './protocol';

export type PostFn = (message: WorkerMessage, transfer: Transferable[]) => void;

export interface WorkerCore {
  /** メインスレッドから届いた要求を処理する */
  handle(req: WorkerRequest): void;
  /**
   * 後始末（隣の帯とつなぐポートを閉じ、帯の計算を止める）。
   * 実際のワーカーでは terminate() ですべて消えるので呼ばなくてよい（テスト用）。
   */
  dispose(): void;
}

/** 日本語を含まないエラーは日本語の説明で包む */
function errorMessage(e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  return /[ぁ-んァ-ン一-龥]/.test(detail) ? detail : `シミュレーションの計算に失敗しました（${detail}）`;
}

export function createWorkerCore(post: PostFn): WorkerCore {
  let disposed = false;
  const ports = new Set<MessagePort>();
  const postError = (e: unknown) => {
    if (!disposed) post({ type: 'error', message: errorMessage(e) }, []);
  };

  const sink: EngineSink = {
    start: (info) => post({ type: 'start', info }, []),
    frame: (index, data, gaugeT, gaugeEta) => post({ type: 'frame', index, data, gaugeT, gaugeEta }, data ? [data.buffer] : []),
    calibrated: (info) => post({ type: 'calibrated', info }, []),
    stats: (s) =>
      post(
        { type: 'stats', maxDepth: s.maxDepth, maxEta: s.maxEta, arrival: s.arrival, achievedCoastMax: s.achievedCoastMax, final: s.final },
        [s.maxDepth.buffer, s.maxEta.buffer, s.arrival.buffer],
      ),
    progress: (progress, message) => post({ type: 'progress', progress, message }, []),
  };

  /** 並列計算の準備が済んだワーカー0 の状態（帯の計算を始めるまで保持） */
  let prepared: { req: Extract<WorkerRequest, { type: 'run' }>; prep: PreparedRun } | null = null;

  /** 1つの帯の本計算。毎ステップ隣の帯とのりしろを交換する */
  async function runBand(runner: BandRunner, plan: MainPlan, north: MessagePort | null, south: MessagePort | null): Promise<EnginePerf | null> {
    const t0 = performance.now();
    const band = runner.band;
    const inN = north ? new HaloInbox(north) : null;
    const inS = south ? new HaloInbox(south) : null;
    let sendN: Float64Array | null = north ? new Float64Array(runner.haloLength) : null;
    let sendS: Float64Array | null = south ? new Float64Array(runner.haloLength) : null;
    const stepsPerGauge = plan.stepsPerFrame / plan.gaugeDiv;
    let step = 0;
    let waitMs = 0;
    for (let f = plan.startFrame + 1; f <= plan.lastFrame; f++) {
      const gaugeT: number[] = [];
      const gaugeEta: number[] = [];
      const tFrame0 = (f - 1) * plan.frameInterval;
      for (let s = 1; s <= plan.stepsPerFrame; s++) {
        runner.step();
        step++;
        if (north && sendN) {
          runner.exportNorth(sendN);
          north.postMessage({ step, buf: sendN } satisfies HaloMessage, [sendN.buffer]);
        }
        if (south && sendS) {
          runner.exportSouth(sendS);
          south.postMessage({ step, buf: sendS } satisfies HaloMessage, [sendS.buffer]);
        }
        if (inN) {
          let got = inN.take(step);
          if (got instanceof Promise) {
            const w = performance.now();
            got = await got;
            waitMs += performance.now() - w;
            if (disposed) return null;
          }
          runner.importNorth(got);
          // 受け取った配列を次の送信に使い回す（送った配列は転送で手元から消えている）
          sendN = got;
        }
        if (inS) {
          let got = inS.take(step);
          if (got instanceof Promise) {
            const w = performance.now();
            got = await got;
            waitMs += performance.now() - w;
            if (disposed) return null;
          }
          runner.importSouth(got);
          sendS = got;
        }
        if (runner.gaugeLocal >= 0 && s % stepsPerGauge === 0) {
          gaugeT.push(tFrame0 + (s / stepsPerGauge) * plan.gaugeInterval);
          gaugeEta.push(runner.gaugeEta());
        }
      }
      if (disposed) return null;
      let data: Uint16Array;
      try {
        data = runner.finishFrame(f);
      } catch {
        throw new Error(UNSTABLE_MESSAGE);
      }
      post({ type: 'framePart', index: f, band: band.index, rowStart: band.ownStart, data, gaugeT, gaugeEta }, [data.buffer]);
      if (f % plan.statsEveryFrames === 0 || f === plan.lastFrame) {
        const st = runner.statsPart();
        post(
          { type: 'statsPart', index: f, band: band.index, rowStart: band.ownStart, ...st, final: f === plan.lastFrame },
          [st.maxDepth.buffer, st.maxEta.buffer, st.arrival.buffer],
        );
      }
    }
    // ポートはここでは閉じない（隣の帯が最後ののりしろをまだ受け取っていない可能性がある）。
    // 計算が終わるとメインスレッドがワーカーを終了させるので、そのときに消える。
    const mainMs = performance.now() - t0;
    return {
      steps: runner.solver.steps,
      dt: plan.dt,
      activeCells: runner.solver.activeCells(),
      mainMs,
      calibrationMs: plan.calibrationMs,
      stepsPerSec: mainMs > 0 ? runner.solver.steps / (mainMs / 1000) : 0,
      bands: plan.bands.length,
      waitMs,
    };
  }

  const handle = (req: WorkerRequest): void => {
    if (disposed) return;
    try {
      if (req.type === 'run') {
        const prep = prepareRun(req, sink, { bands: req.bands });
        if (prep.plan.bands.length > 1) {
          prepared = { req, prep };
          post({ type: 'plan', plan: prep.plan }, []);
          return;
        }
        post({ type: 'done', perf: runSerialMain(prep, sink) }, []);
      } else if (req.type === 'serial') {
        // 並列計算を始められなかった: 準備済みの状態から逐次で計算する
        if (!prepared) throw new Error('計算の準備ができていません');
        const { prep } = prepared;
        prepared = null;
        post({ type: 'done', perf: runSerialMain(prep, sink) }, []);
      } else if (req.type === 'band') {
        let local = req.local;
        if (!local) {
          if (!prepared) throw new Error('計算の準備ができていません');
          local = sliceRows(prepared.req, req.spec.nx, req.band.localStart, req.band.localEnd);
        }
        prepared = null; // 全体の格子のソルバは不要になる
        if (req.north) ports.add(req.north);
        if (req.south) ports.add(req.south);
        const runner = new BandRunner(local, req.spec, req.plan, req.band);
        runBand(runner, req.plan, req.north, req.south).then(
          (perf) => {
            if (perf && !disposed) post({ type: 'bandDone', band: req.band.index, perf }, []);
          },
          (e) => postError(e),
        );
      }
    } catch (e) {
      postError(e);
    }
  };

  return {
    handle,
    dispose() {
      disposed = true;
      prepared = null;
      for (const p of ports) {
        p.onmessage = null;
        p.close();
      }
      ports.clear();
    },
  };
}

/** 隣の帯から届くのりしろの受け箱（ステップ番号で対応づける） */
class HaloInbox {
  private readonly box = new Map<number, Float64Array>();
  private waiting: { step: number; resolve: (buf: Float64Array) => void } | null = null;

  constructor(port: MessagePort) {
    port.onmessage = (ev: MessageEvent<HaloMessage>) => {
      const { step, buf } = ev.data;
      if (this.waiting && this.waiting.step === step) {
        const w = this.waiting;
        this.waiting = null;
        w.resolve(buf);
      } else this.box.set(step, buf);
    };
  }

  take(step: number): Float64Array | Promise<Float64Array> {
    const buf = this.box.get(step);
    if (buf) {
      this.box.delete(step);
      return buf;
    }
    return new Promise((resolve) => (this.waiting = { step, resolve }));
  }
}
