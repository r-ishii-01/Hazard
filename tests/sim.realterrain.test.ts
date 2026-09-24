/**
 * 実地形（同梱の標高タイル public/tiles/ = 国土地理院 DEM5A の複製）での計算の検証。ミラーが無い場合はスキップする。
 * 相模トラフ西側モデル（既定の周期・波形）を粗い格子で計算し、次を確かめる。
 * - 陸（初期に乾いていたセル）の浸水は、沖側境界で波の入力が始まってから十分後に始まる
 *   （潮間帯・河口の砂州などの低い土地が、波が来る前の t≈0 に「浸水」と記録されない）
 * - 最初に浸水するのは江の島周辺など沖側境界に近い低い土地で、鵠沼海岸の陸の浸水は最大の波（8分）の前後
 * - 校正区間の平均水位の最大の山が到達時間（8分）の ±1 分、海岸の最大水位が目標の ±10%
 * また慶長型（最大の波が第2波）で、小さな第1波の後に最大の山が到達時間（50分）の ±1 分に届くこと
 * （周期を2分に縮めた場合も最大の波の山を取り違えないこと）を確かめる。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cellCenter } from '../src/core/geo';
import { CELL_SEA, type SimParams, type TerrainGrid } from '../src/core/types';
import { defaultParams, getScenario } from '../src/data/scenarios';
import { coastMax, crestTimeNear, prepareRun, type CalibrationInfo, type EngineSink } from '../src/sim/engine';
import { clearTerrainCache, loadTerrain } from '../src/terrain';

interface NodeFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
const fsName = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
const ROOT = decodeURIComponent(new URL('../public/', import.meta.url).pathname);
const hasMirror = fs.existsSync(`${ROOT}tiles/manifest.json`) && fs.existsSync(`${ROOT}tiles/dem5a_png`);

/** 最小限の PNG デコーダ（8bit・非インターレースの RGB / RGBA。tests/terrain-realdata.test.ts と同じ） */
async function decodePng(buf: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  let w = 0;
  let h = 0;
  let ch = 0;
  const idat: Uint8Array[] = [];
  while (p < buf.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = dv.getUint32(p + 8);
      h = dv.getUint32(p + 12);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
      ch = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (!ch) throw new Error(`unsupported color type ${data[9]}`);
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of idat) {
    joined.set(a, o);
    o += a.length;
  }
  const raw = new Uint8Array(await new Response(new Blob([joined]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      out.set(cur.subarray(x * ch, x * ch + 3), (y * w + x) * 4);
      out[(y * w + x) * 4 + 3] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev = cur;
  }
  return out;
}

const fetchImpl = async (url: string): Promise<Response> => {
  const path = `${ROOT}${url.replace(/^\//, '')}`;
  if (url.startsWith('https:') || !fs.existsSync(path)) return new Response('', { status: 404 });
  return new Response(fs.readFileSync(path) as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'image/png' },
  });
};
const decodeImpl = async (blob: Blob) => decodePng(new Uint8Array(await blob.arrayBuffer()));

describe.skipIf(!hasMirror)('実地形（粗い格子）での計算（相模トラフ西側モデル・慶長型）', { timeout: 240_000 }, () => {
  let grid: TerrainGrid;
  beforeAll(async () => {
    clearTerrainCache();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    grid = await loadTerrain('coarse', { fetchImpl, decodeImpl, baseUrl: '/' });
    clearTerrainCache();
  });

  it('陸の浸水は波の入力開始の1分以上後に始まり、最大の山は8分±1分、海岸の最大水位は目標の±10%', () => {
    expect(grid.isApproximate).toBe(false);
    const west = getScenario('sagami-west')!;
    const params = { ...defaultParams(west), resolution: 'coarse' as const, durationMin: 12 };
    let cal: CalibrationInfo | null = null;
    const sink: EngineSink = { start() {}, frame() {}, calibrated: (c) => (cal = c), stats() {}, progress() {} };
    const { plan, solver } = prepareRun({ spec: grid.spec, z: grid.z, kind: grid.kind, manning: grid.manning, params }, sink);
    const c = cal as unknown as CalibrationInfo;
    const seg = plan.segmentCells;
    const ts: number[] = [];
    const ms: number[] = [];
    solver.t = plan.startFrame * plan.frameInterval;
    while (solver.t < plan.durationSec - 1e-6) {
      solver.step();
      let s = 0;
      for (let i = 0; i < seg.length; i++) s += solver.eta[seg[i]];
      ts.push(solver.t);
      ms.push(s / seg.length);
    }
    // 最大の山の時刻（区間平均の水位）
    let iMax = 0;
    ms.forEach((v, i) => {
      if (v > ms[iMax]) iMax = i;
    });
    expect(Math.abs(ts[iMax] - west.arrivalMin * 60)).toBeLessThan(60);
    expect(Math.abs(coastMax(solver, seg, plan.tide) - west.coastHeight) / west.coastHeight).toBeLessThan(0.1);

    const n = solver.n;
    const arrival = new Float32Array(n);
    const maxDepth = new Float32Array(n);
    solver.copyArrival(arrival);
    solver.copyMaxDepth(maxDepth);
    let first = Infinity;
    let firstK = -1;
    let kugenumaFirst = Infinity;
    let flooded = 0;
    for (let k = 0; k < n; k++) {
      if (grid.kind[k] === CELL_SEA || !(maxDepth[k] >= 0.01)) continue;
      flooded++;
      if (arrival[k] < first) {
        first = arrival[k];
        firstK = k;
      }
      const i = k % grid.spec.nx;
      const p = cellCenter(grid.spec, i, (k - i) / grid.spec.nx);
      if (p.lon >= 139.455 && p.lon <= 139.485 && p.lat > 35.305) kugenumaFirst = Math.min(kugenumaFirst, arrival[k]);
    }
    expect(flooded).toBeGreaterThan(500);
    // 波が来る前（入力開始から1分以内）に浸水したことになる陸は無い
    expect(first).toBeGreaterThan(c.boundaryStartSec + 60);
    // 最初に浸水するのは沖側境界に近い江の島周辺の低い土地（潮位＋0.5m 未満）
    const i0 = firstK % grid.spec.nx;
    const p0 = cellCenter(grid.spec, i0, (firstK - i0) / grid.spec.nx);
    expect(p0.lat).toBeLessThan(35.305);
    expect(grid.z[firstK]).toBeLessThan(plan.tide + 0.5);
    // 鵠沼海岸の陸の浸水は最大の山（8分）の数分前から
    expect(kugenumaFirst).toBeGreaterThan(2 * 60);
    expect(kugenumaFirst).toBeLessThan(west.arrivalMin * 60);
  });

  /** 校正して本計算を durationMin まで進め、校正区間の平均水位（潮位からの上昇量）の時系列を返す */
  function runSeries(params: SimParams) {
    let cal: CalibrationInfo | null = null;
    const sink: EngineSink = { start() {}, frame() {}, calibrated: (c) => (cal = c), stats() {}, progress() {} };
    const { plan, solver } = prepareRun({ spec: grid.spec, z: grid.z, kind: grid.kind, manning: grid.manning, params }, sink);
    const seg = plan.segmentCells;
    const ts: number[] = [];
    const ms: number[] = [];
    solver.t = plan.startFrame * plan.frameInterval;
    while (solver.t < plan.durationSec - 1e-6) {
      solver.step();
      let s = 0;
      for (let i = 0; i < seg.length; i++) s += solver.eta[seg[i]];
      ts.push(solver.t);
      ms.push(s / seg.length - plan.tide);
    }
    let iMax = 0;
    ms.forEach((v, i) => {
      if (v > ms[iMax]) iMax = i;
    });
    return { cal: cal as unknown as CalibrationInfo, plan, solver, ts, ms, iMax };
  }

  it('慶長型（最大の波が第2波）: 約20分前に小さな第1波、最大の山は50分±1分、海岸の最大水位は目標の±10%', () => {
    const keicho = getScenario('keicho')!;
    const params = { ...defaultParams(keicho), resolution: 'coarse' as const, durationMin: 60 };
    const { cal, plan, solver, ts, ms, iMax } = runSeries(params);
    expect(cal.notes.join('')).not.toContain('到達は約');
    expect(Math.abs(ts[iMax] - keicho.arrivalMin * 60)).toBeLessThan(60);
    expect(Math.abs(coastMax(solver, plan.segmentCells, plan.tide) - keicho.coastHeight) / keicho.coastHeight).toBeLessThan(0.1);
    // 第1波の山（最大の山の 1 周期前の前後）は最大の山の半分未満
    const first = crestTimeNear(ts, ms, ts[iMax] - keicho.periodMin * 60, 0.3 * keicho.periodMin * 60);
    expect(Number.isFinite(first)).toBe(true);
    expect(ms[ts.indexOf(first)]).toBeGreaterThan(0.1 * ms[iMax]);
    expect(ms[ts.indexOf(first)]).toBeLessThan(0.5 * ms[iMax]);
  });

  it('周期を短くしても（2分）最大の波（第2波）の山を取り違えず、到達時間の±1分に届く（慶長型）', () => {
    // 伝播時間の見込み ∫ds/√(gh) は大きな山の実際の遅れより長いので、見込みの前後半周期だけを探すと
    // 周期が短いときに本当の山が範囲の外に出る（修正前は約1.3分早く届いていた）
    const keicho = { ...getScenario('keicho')!, periodMin: 2 };
    const params = { ...defaultParams(keicho), resolution: 'coarse' as const, durationMin: 60 };
    const { ts, iMax } = runSeries(params);
    expect(Math.abs(ts[iMax] - keicho.arrivalMin * 60)).toBeLessThan(60);
  });
});
