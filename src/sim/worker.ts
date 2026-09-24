/**
 * 津波浸水計算のワーカー。処理の中身は workerCore.ts（計算本体は engine.ts / band.ts）。
 * メッセージ形式は protocol.ts を参照。
 */
import type { WorkerRequest } from './protocol';
import { createWorkerCore } from './workerCore';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const core = createWorkerCore((message, transfer) => ctx.postMessage(message, transfer));
ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => core.handle(ev.data);
