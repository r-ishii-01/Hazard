/**
 * 3D の水面（view3d/water.ts）: キーフレーム方式の結果が、以前の「毎フレーム全セルを計算する」方式と一致すること、
 * 再生中はテクスチャを出力フレームの境目でだけ転送すること、計算結果への参照を手放せること。
 */
import { BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { CELL_INLAND_WATER, CELL_LAND, CELL_SEA, type SimOutput, type TerrainGrid } from '../src/core/types';
import type { GridSpec } from '../src/core/geo';
import { WaterLayer } from '../src/view3d/water';
import { sameExtent } from '../src/view3d/tileCanvas';

const NX = 12;
const NY = 10;
const DX = 10;
const FI = 20;
const TIDE = 0.85;
const WET = 0.01;

function makeGrid(): TerrainGrid {
  const n = NX * NY;
  const z = new Float32Array(n);
  const kind = new Uint8Array(n);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      if (j >= 6) {
        kind[k] = CELL_SEA;
        z[k] = -1 - (j - 6) * 2 - i * 0.05;
      } else {
        kind[k] = CELL_LAND;
        z[k] = 0.4 + (5 - j) * 0.9 + i * 0.03;
      }
    }
  }
  // 池（計算上は陸）
  kind[2 * NX + 9] = CELL_INLAND_WATER;
  z[2 * NX + 9] = 3.1;
  const spec: GridSpec = { zoom: 15, originPx: 1000, originPy: 2000, cellPx: 4, nx: NX, ny: NY, dx: DX };
  return { spec, z, kind, manning: new Float32Array(n).fill(0.025), source: 'synthetic', sourceLabel: 'test', isApproximate: true, notes: [] };
}

/** 押し波で陸へ浸水し、引いていくフレーム列（全水深） */
function makeFrames(grid: TerrainGrid): Float32Array[] {
  const n = NX * NY;
  const { z, kind } = grid;
  const surf = [TIDE, TIDE + 1.2, TIDE + 2.6, TIDE + 1.4, TIDE - 1.8];
  return surf.map((eta, f) => {
    const d = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      if (kind[k] === CELL_SEA) d[k] = Math.max(0, eta - z[k]);
      else if (kind[k] === CELL_LAND) {
        // 陸は波の高さに応じて海側から浸水（少しずつ違う深さ）
        const v = eta - z[k] - 0.1 * ((k * 7 + f) % 3);
        d[k] = v > 0 ? v : 0;
      }
    }
    return d;
  });
}

function fakeOutput(grid: TerrainGrid, frames: Float32Array[]): SimOutput {
  const n = NX * NY;
  const arrival = new Float32Array(n).fill(Infinity);
  frames.forEach((d, f) => {
    for (let k = 0; k < n; k++) if (grid.kind[k] === CELL_LAND && d[k] >= WET && !Number.isFinite(arrival[k])) arrival[k] = f * FI;
  });
  const fill = (t: number, out: Float32Array) => {
    const ft = Math.max(0, Math.min(frames.length - 1, t / FI));
    const i0 = Math.floor(ft);
    const i1 = Math.min(frames.length - 1, i0 + 1);
    const w = ft - i0;
    for (let k = 0; k < n; k++) out[k] = frames[i0][k] * (1 - w) + frames[i1][k] * w;
  };
  return {
    spec: grid.spec,
    frameInterval: FI,
    durationSec: (frames.length - 1) * FI,
    framesReady: () => frames.length,
    timeReady: () => (frames.length - 1) * FI,
    depthAt: (t, k) => {
      const tmp = new Float32Array(n);
      fill(t, tmp);
      return tmp[k];
    },
    etaAt: () => NaN,
    fillDepth: fill,
    maxDepth: new Float32Array(n),
    maxEta: new Float32Array(n),
    arrival,
    gauge: { t: new Float32Array(0), eta: new Float32Array(0), lon: 0, lat: 0, count: () => 0 },
    achievedCoastMax: () => 0,
    calibration: { targetCoastHeight: 0, boundaryAmplitude: 0 },
  };
}

/**
 * 以前の実装（毎フレーム全セル）と同じ規則で、フレーム i の頂点の値 (η, D, α, 上昇速度) を求める。
 * 上昇速度は前後のフレームとの中心差分（端は片側差分）。
 */
function reference(grid: TerrainGrid, frames: Float32Array[], i: number): Float32Array {
  const n = NX * NY;
  const { z, kind } = grid;
  const D = frames[i];
  const ip = Math.max(0, i - 1);
  const inx = Math.min(frames.length - 1, i + 1);
  const span = inx > ip ? (inx - ip) * FI : Infinity;
  const R = new Float32Array(n);
  for (let k = 0; k < n; k++) R[k] = span === Infinity ? 0 : (frames[inx][k] - frames[ip][k]) / span;
  const wet = (k: number) => D[k] >= WET && D[k] < 1e4;
  const a = new Float32Array(n * 4);
  for (let j = 0; j < NY; j++) {
    for (let ii = 0; ii < NX; ii++) {
      const k = j * NX + ii;
      const o = k * 4;
      if (wet(k)) {
        a.set([z[k] + D[k], D[k], 1, R[k]], o);
        continue;
      }
      let cnt = 0;
      let sum = 0;
      let rsum = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const jj = j + dj;
          const i2 = ii + di;
          if ((dj === 0 && di === 0) || jj < 0 || jj >= NY || i2 < 0 || i2 >= NX) continue;
          const kk = jj * NX + i2;
          if (wet(kk)) {
            cnt++;
            sum += z[kk] + D[kk];
            rsum += R[kk];
          }
        }
      }
      if (kind[k] === CELL_INLAND_WATER) a.set([z[k] + 0.05, 0.8, 1, 0], o);
      else if (cnt > 0 && z[k] * cnt >= sum) a.set([sum / cnt, 0, 1, rsum / cnt], o);
      else a.set([z[k] - (cnt > 0 ? 0.05 : 0.6), 0, 0, 0], o);
    }
  }
  return a;
}

function newLayer(grid: TerrainGrid): WaterLayer {
  const w = new WaterLayer();
  w.setGrid(grid, new BufferAttribute(new Uint32Array(6), 1));
  return w;
}

function shownCells(w: WaterLayer): Float32Array {
  const n = NX * NY;
  const out = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) out.set(w.debugCell(k)!, k * 4);
  return out;
}

describe('WaterLayer（キーフレーム）', () => {
  const grid = makeGrid();
  const frames = makeFrames(grid);
  const output = fakeOutput(grid, frames);

  it('出力フレームの時刻では、以前の方式（全セルをその場で計算）と同じ値になる', () => {
    const w = newLayer(grid);
    for (let i = 0; i < frames.length; i++) {
      expect(w.update(output, i * FI, TIDE, 'r1')).toBe(true);
      const got = shownCells(w);
      const want = reference(grid, frames, i);
      for (let q = 0; q < got.length; q++) expect(got[q]).toBeCloseTo(want[q], 4);
    }
  });

  it('フレームの間では、濡れたセルの全水深・水位・上昇速度がフレーム間の線形補間になる', () => {
    const w = newLayer(grid);
    const f = 0.35;
    w.update(output, (1 + f) * FI, TIDE, 'r1');
    const a = reference(grid, frames, 1);
    const b = reference(grid, frames, 2);
    let checked = 0;
    for (let k = 0; k < NX * NY; k++) {
      if (!(frames[1][k] >= WET && frames[2][k] >= WET)) continue;
      const c = w.debugCell(k)!;
      const d = frames[1][k] + (frames[2][k] - frames[1][k]) * f;
      expect(c[1]).toBeCloseTo(d, 5);
      expect(c[0]).toBeCloseTo(grid.z[k] + d, 5);
      expect(c[2]).toBe(1);
      expect(c[3]).toBeCloseTo(a[k * 4 + 3] + (b[k * 4 + 3] - a[k * 4 + 3]) * f, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('再生中は、出力フレームの境目を越えたときだけテクスチャを1枚転送する', () => {
    const w = newLayer(grid);
    const texBytes = NX * NY * 4 * 4;
    w.update(output, FI * 1.0, TIDE, 'r1');
    const first = w.uploadBytes;
    expect(first).toBe(2 * texBytes);
    const builds = w.keyframeBuilds;
    for (let s = 1; s <= 9; s++) expect(w.update(output, FI * (1 + s / 10), TIDE, 'r1')).toBe(true);
    // 同じフレームの間: 転送もキーフレームの計算もしない（補間の重みだけ変わる）
    expect(w.uploadBytes).toBe(first);
    expect(w.keyframeBuilds).toBe(builds);
    // 同じ時刻なら何もしない
    expect(w.update(output, FI * 1.9, TIDE, 'r1')).toBe(false);
    // 次のフレームへ: 前の k1 が k0 になり、新しい k1 だけを転送
    w.update(output, FI * 2.2, TIDE, 'r1');
    expect(w.uploadBytes).toBe(first + texBytes);
    expect(w.keyframeBuilds).toBe(builds + 1);
  });

  it('再生中に次のキーフレームを先に求めておくと、境目を越えたときに計算しない（値は同じ）', () => {
    const w = newLayer(grid);
    w.update(output, FI * 1.5, TIDE, 'r1');
    const builds = w.keyframeBuilds;
    // 少しずつ（呼ぶたびに少しだけ）進める。途中で同じフレーム内の update が入っても続けられる
    let calls = 0;
    while (w.prefetch(0)) {
      calls++;
      w.update(output, FI * (1.5 + calls * 0.01), TIDE, 'r1');
      expect(calls).toBeLessThan(100);
    }
    expect(calls).toBeGreaterThan(2);
    expect(w.keyframeBuilds).toBe(builds + 1);
    // もう求めてあるので何もしない
    expect(w.prefetch(100)).toBe(false);
    w.update(output, FI * 2, TIDE, 'r1');
    expect(w.keyframeBuilds).toBe(builds + 1);
    const got = shownCells(w);
    const want = reference(grid, frames, 2);
    for (let q = 0; q < got.length; q++) expect(got[q]).toBeCloseTo(want[q], 4);
  });

  it('先に求めている途中で別の時刻へ移ったら、取りやめて正しく求め直す', () => {
    const w = newLayer(grid);
    w.update(output, FI * 1.5, TIDE, 'r1');
    expect(w.prefetch(0)).toBe(true);
    expect(w.prefetch(0)).toBe(true);
    // 途中のまま過去へ移動
    w.update(output, 0, TIDE, 'r1');
    let got = shownCells(w);
    let want = reference(grid, frames, 0);
    for (let q = 0; q < got.length; q++) expect(got[q]).toBeCloseTo(want[q], 4);
    // 求めかけていたフレーム（3）へ移動しても正しい
    w.update(output, FI * 3, TIDE, 'r1');
    got = shownCells(w);
    want = reference(grid, frames, 3);
    for (let q = 0; q < got.length; q++) expect(got[q]).toBeCloseTo(want[q], 4);
    // 計算結果を手放したら先に求めるものも無い
    w.releaseOutput();
    expect(w.prefetch(100)).toBe(false);
  });

  it('描いている水面の高さ（surfaceAt）はセル中心で表示中の値と一致する', () => {
    const w = newLayer(grid);
    w.update(output, FI * 2.5, TIDE, 'r1');
    const i = 4;
    const j = 7;
    const k = j * NX + i;
    const x = (i + 0.5 - NX / 2) * DX;
    const zm = (j + 0.5 - NY / 2) * DX;
    expect(w.surfaceAt(x, zm)).toBeCloseTo(w.debugCell(k)![0], 5);
  });

  it('計算結果を表示しなくなったら、前の結果（フレーム）への参照を手放す', () => {
    const w = newLayer(grid);
    w.update(output, FI, TIDE, 'r1');
    expect(w.holdsOutput).toBe(true);
    expect(w.update(null, FI, TIDE, 'r1')).toBe(true);
    expect(w.holdsOutput).toBe(false);
    // 計算前の静かな海: 海は潮位、陸は見えない
    const sea = 8 * NX + 3;
    const land = 1 * NX + 3;
    expect(w.debugCell(sea)![0]).toBeCloseTo(TIDE, 5);
    expect(w.debugCell(land)![2]).toBe(0);
    // 明示的に手放す（3D を表示していない間に新しい計算が始まったとき）
    w.update(output, FI, TIDE, 'r1');
    w.releaseOutput();
    expect(w.holdsOutput).toBe(false);
    expect(w.update(output, FI, TIDE, 'r1')).toBe(true);
  });

  it('別の計算結果に替わったら作り直す（前の結果のフレームを使わない）', () => {
    const w = newLayer(grid);
    w.update(output, FI, TIDE, 'r1');
    const frames2 = frames.map((f) => f.map((v) => v * 0.5));
    const out2 = fakeOutput(grid, frames2);
    w.update(out2, FI, TIDE, 'r2');
    const want = reference(grid, frames2, 1);
    const got = shownCells(w);
    for (let q = 0; q < got.length; q++) expect(got[q]).toBeCloseTo(want[q], 4);
  });
});

describe('sameExtent（解像度を変えてもタイルのキャンバスを使い回せるか）', () => {
  const base: GridSpec = { zoom: 15, originPx: 7443488, originPy: 3312872, cellPx: 4, nx: 352, ny: 394, dx: 15.6 };
  it('範囲が同じ（解像度だけ違う）なら true', () => {
    expect(sameExtent(base, { ...base, cellPx: 8, nx: 176, ny: 197, dx: 31.2 })).toBe(true);
    expect(sameExtent(base, { ...base, cellPx: 2, nx: 704, ny: 788, dx: 7.8 })).toBe(true);
  });
  it('範囲がずれていれば false', () => {
    expect(sameExtent(base, { ...base, originPx: base.originPx + 8 })).toBe(false);
    expect(sameExtent(base, { ...base, nx: 351 })).toBe(false);
  });
});
