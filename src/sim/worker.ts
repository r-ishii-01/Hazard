/**
 * 津波浸水計算のワーカー（計算本体は engine.ts）。
 * メッセージ形式は protocol.ts を参照。フレームや最大値の配列は転送（コピーなし）で返す。
 */
import { runEngine } from './engine';
import type { RunRequest, WorkerMessage } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerMessage, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

ctx.onmessage = (ev: MessageEvent<RunRequest>) => {
  const req = ev.data;
  if (!req || req.type !== 'run') return;
  try {
    const perf = runEngine(req, {
      start: (info) => post({ type: 'start', info }),
      frame: (index, data, gaugeT, gaugeEta) => post({ type: 'frame', index, data, gaugeT, gaugeEta }, data ? [data.buffer] : []),
      calibrated: (info) => post({ type: 'calibrated', info }),
      stats: (s) =>
        post(
          {
            type: 'stats',
            maxDepth: s.maxDepth,
            maxEta: s.maxEta,
            arrival: s.arrival,
            achievedCoastMax: s.achievedCoastMax,
            final: s.final,
          },
          [s.maxDepth.buffer, s.maxEta.buffer, s.arrival.buffer],
        ),
      progress: (progress, message) => post({ type: 'progress', progress, message }),
    });
    post({ type: 'done', perf });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const message = /[ぁ-んァ-ン一-龥]/.test(detail) ? detail : `シミュレーションの計算に失敗しました（${detail}）`;
    post({ type: 'error', message });
  }
};
