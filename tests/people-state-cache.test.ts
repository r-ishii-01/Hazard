/**
 * 人物の状態判定のキャッシュ（src/people/state.ts の「生命の危険」の判定）:
 * - 計算結果が変われば、同じ計画・同じ人物でも新しい計算結果で判定し直す
 * - 同じ計算結果・同じ時刻なら、調べ済みの時刻を調べ直さない
 * - 古い計画・人物のオブジェクトを持ち続けても、古い計算結果（全フレーム）をメモリに残さない
 */
import { describe, expect, it } from 'vitest';
import { cellCenter, createGridSpec, type GridSpec } from '../src/core/geo';
import { CELL_LAND, type EvacPlan, type Person, type SimOutput, type TerrainGrid } from '../src/core/types';
import { criticalEncounter, personStateAt } from '../src/people';

// node:v8 / node:vm（このプロジェクトは @types/node に依存しないので、使う分だけの型を書く）
interface NodeV8 {
  setFlagsFromString(flags: string): void;
}
interface NodeVm {
  runInNewContext(code: string): unknown;
}
const v8Name = 'node:v8';
const vmName = 'node:vm';
const v8 = (await import(/* @vite-ignore */ v8Name)) as NodeV8;
const vm = (await import(/* @vite-ignore */ vmName)) as NodeVm;

/** ガベージコレクションを明示的に起こす関数（使えない環境では null） */
function exposeGc(): (() => void) | null {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g === 'function') return g;
  try {
    v8.setFlagsFromString('--expose-gc');
    const fn = vm.runInNewContext('gc');
    return typeof fn === 'function' ? (fn as () => void) : null;
  } catch {
    return null;
  }
}

function smallSpec(nx: number, ny: number): GridSpec {
  return { ...createGridSpec('standard'), nx, ny };
}

function flatGrid(spec: GridSpec): TerrainGrid {
  const n = spec.nx * spec.ny;
  return {
    spec,
    z: new Float32Array(n).fill(2),
    kind: new Uint8Array(n).fill(CELL_LAND),
    manning: new Float32Array(n).fill(0.025),
    source: 'synthetic',
    sourceLabel: 'test',
    isApproximate: true,
    notes: [],
  };
}

/** 全セル同じ浸水深 depth(t) の計算結果。frames は計算結果の大きさ（メモリの確認用） */
function uniformOutput(spec: GridSpec, depth: (t: number) => number, calls?: { n: number }, bytes = 0): SimOutput & { frames: Float32Array } {
  const n = spec.nx * spec.ny;
  const durationSec = 1800;
  const frameInterval = 10;
  return {
    spec,
    frameInterval,
    durationSec,
    framesReady: () => durationSec / frameInterval + 1,
    timeReady: () => durationSec,
    depthAt: (t) => {
      if (calls) calls.n += 1;
      return depth(t);
    },
    etaAt: () => NaN,
    fillDepth: () => {},
    maxDepth: new Float32Array(n),
    maxEta: new Float32Array(n),
    arrival: new Float32Array(n).fill(Infinity),
    gauge: { t: new Float32Array(0), eta: new Float32Array(0), lon: 0, lat: 0, count: () => 0 },
    achievedCoastMax: () => 0,
    calibration: { targetCoastHeight: 0, boundaryAmplitude: 0 },
    frames: new Float32Array(bytes / 4),
  };
}

const spec = smallSpec(12, 12);
const grid = flatGrid(spec);
const start = cellCenter(spec, 2, 6);
const end = cellCenter(spec, 9, 6);
const person: Person = { id: 'p-cache', name: '大人 1', kind: 'adult', lon: start.lon, lat: start.lat, evacMode: 'highground', startDelayMin: 5 };
const plan: EvacPlan = {
  personId: person.id,
  path: [
    { lon: start.lon, lat: start.lat, t: 300 },
    { lon: end.lon, lat: end.lat, t: 300 + 7 * spec.dx },
  ],
  target: { lon: end.lon, lat: end.lat, name: '最寄りの高台（標高 12.0 m）', kind: 'highground' },
  arriveAt: 300 + 7 * spec.dx,
  distanceM: 7 * spec.dx,
};

describe('人物の状態判定のキャッシュ', () => {
  it('計算結果が変われば、同じ計画・同じ人物でも新しい計算結果で判定する', () => {
    // A: 600 秒から深さ 2 m（生命の危険）。B: ずっと乾いている
    const a = uniformOutput(spec, (t) => (t >= 600 ? 2 : 0));
    const b = uniformOutput(spec, () => 0);
    expect(personStateAt(person, plan, grid, a, 1200).status).toBe('critical');
    expect(personStateAt(person, plan, grid, b, 1200).status).not.toBe('critical');
    expect(criticalEncounter(person, plan, b, 1200)).toBeNull();
    // A に戻しても、A の判定（600 秒ごろに危険）のまま
    const hit = criticalEncounter(person, plan, a, 1200);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeGreaterThan(590);
    expect(hit!.t).toBeLessThanOrEqual(600);
  });

  it('同じ計算結果・同じ時刻なら、調べ済みの時刻を調べ直さない', () => {
    const calls = { n: 0 };
    const out = uniformOutput(spec, () => 0.05, calls);
    personStateAt(person, plan, grid, out, 1500);
    const first = calls.n;
    expect(first).toBeGreaterThan(50);
    calls.n = 0;
    personStateAt(person, plan, grid, out, 1500);
    // 2 回目は今の位置の浸水深を読む分だけ（時系列はキャッシュ済み）
    expect(calls.n).toBeLessThan(10);
  });

  it('古い計画・人物を持ち続けても、古い計算結果はメモリから解放できる', async () => {
    const gc = exposeGc();
    if (!gc) {
      console.warn('gc を使えないため、このテストは確かめられません');
      return;
    }
    // 計算結果（約 8 MB）を使って判定し、計算結果そのものへの参照は WeakRef だけにする
    const make = (): WeakRef<SimOutput> => {
      const out = uniformOutput(spec, (t) => (t >= 900 ? 0.4 : 0), undefined, 8 * 1024 * 1024);
      personStateAt(person, plan, grid, out, 1200);
      criticalEncounter(person, undefined, out, 1200);
      return new WeakRef(out);
    };
    const ref = make();
    // 計画・人物はこのテストの間ずっと参照したまま（画面の側が古い計画を持ち続ける場合と同じ）
    let released = false;
    for (let i = 0; i < 10 && !released; i++) {
      await new Promise((r) => setTimeout(r, 0));
      gc();
      released = ref.deref() === undefined;
    }
    expect(plan.personId).toBe(person.id);
    expect(released).toBe(true);
  });
});
