/**
 * シミュレーション結果を 1セル = 1ピクセルの RGBA 画像に塗る処理。
 *
 * - 浸水（現在時刻）: 陸は浸水深（DEPTH_CLASSES）、海は水位偏差 η−潮位 を青系の発散配色で表現し、
 *   引き波で海底が露出したセル（初期に水があり、いまは D < 0.01 m）は濡れた砂の色で塗る。
 * - 最大浸水深: output.maxDepth を DEPTH_CLASSES で塗る。
 * - 到達時間: output.arrival（秒）を分に直して ARRIVAL_CLASSES で塗る。
 *
 * 画素は Uint32Array ビューに直接書き込み（ルックアップテーブル使用）、キャンバスへ putImageData する。
 * キャンバスは MapLibre の ImageSource.updateImage({ image: canvas }) でテクスチャに転送される。
 */
import { CELL_SEA, type SimOutput, type TerrainGrid } from '../core/types';
import type { GridSpec } from '../core/geo';
import { ARRIVAL_CLASSES, depthToRgba } from '../data/sources';

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

/** RGBA（0〜255）を Uint32Array に書き込める1語へ詰める */
export function packRgba(r: number, g: number, b: number, a: number): number {
  r = clampByte(r);
  g = clampByte(g);
  b = clampByte(b);
  a = clampByte(a);
  return LITTLE_ENDIAN ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------------------
// ルックアップテーブル
// ---------------------------------------------------------------------------

/** 浸水深 LUT の刻み [m] と上限 */
const DEPTH_STEP = 0.01;
const DEPTH_LUT_N = 4000; // 0〜40 m

let depthLut: Uint32Array | null = null;
let depthLutKey = '';

/** DEPTH_CLASSES は他モジュールで調整されうるので、配色関数の出力からテーブルを作る */
function getDepthLut(): Uint32Array {
  // 代表値で配色の変化を検出（クラス定義が差し替わったら作り直す）
  const probe: number[] = [];
  const tmp = [0, 0, 0, 0];
  for (const d of [0.2, 0.4, 0.8, 2, 4, 8, 15, 30]) {
    depthToRgba(d, tmp, 0);
    probe.push(tmp[0], tmp[1], tmp[2], tmp[3]);
  }
  const key = probe.join(',');
  if (depthLut && key === depthLutKey) return depthLut;
  const lut = new Uint32Array(DEPTH_LUT_N + 1);
  for (let i = 0; i <= DEPTH_LUT_N; i++) {
    // 刻みの中央ではなく下端で評価（0.30 m ちょうどは 0.3〜0.5 m の階級）
    depthToRgba(i * DEPTH_STEP + 1e-6, tmp, 0);
    lut[i] = packRgba(tmp[0], tmp[1], tmp[2], tmp[3]);
  }
  depthLut = lut;
  depthLutKey = key;
  return lut;
}

function depthColor(lut: Uint32Array, d: number): number {
  if (!(d >= 0.01)) return 0;
  const i = Math.floor(d / DEPTH_STEP);
  return i < DEPTH_LUT_N ? lut[i] : lut[DEPTH_LUT_N];
}

/** 海の水位偏差 [m] の配色（押し波: 水色→白い泡、引き波: 濃い紺） */
const ANOM_MIN = -6;
const ANOM_MAX = 8;
const ANOM_STEP = 0.01;
const ANOM_N = Math.round((ANOM_MAX - ANOM_MIN) / ANOM_STEP);

type Stop = [value: number, r: number, g: number, b: number, a: number];

const ANOMALY_STOPS: Stop[] = [
  // 引き波（水位が下がる）: 濃い紺
  [-6, 8, 20, 48, 215],
  [-3, 12, 30, 72, 200],
  [-1.5, 20, 45, 110, 175],
  [-0.6, 30, 64, 175, 125],
  [-0.15, 37, 99, 235, 55],
  [-0.03, 59, 130, 246, 0],
  // 平常（±3 cm）は透明
  [0.03, 34, 211, 238, 0],
  // 押し波（水位が上がる）: 水色 → 明るいシアン → 高い波頭は白い泡
  [0.12, 34, 211, 238, 60],
  [0.5, 6, 182, 212, 120],
  [1.2, 34, 211, 238, 160],
  [2.5, 103, 232, 249, 190],
  [4.5, 186, 244, 252, 215],
  [7, 240, 253, 255, 232],
  [8, 255, 255, 255, 242],
];

let anomalyLut: Uint32Array | null = null;

function interpStops(stops: Stop[], v: number): [number, number, number, number] {
  if (v <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3], stops[0][4]];
  for (let s = 1; s < stops.length; s++) {
    const b = stops[s];
    if (v <= b[0]) {
      const a = stops[s - 1];
      const f = (v - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f];
    }
  }
  const l = stops[stops.length - 1];
  return [l[1], l[2], l[3], l[4]];
}

function getAnomalyLut(): Uint32Array {
  if (anomalyLut) return anomalyLut;
  const lut = new Uint32Array(ANOM_N + 1);
  for (let i = 0; i <= ANOM_N; i++) {
    const [r, g, b, a] = interpStops(ANOMALY_STOPS, ANOM_MIN + i * ANOM_STEP);
    lut[i] = packRgba(r, g, b, a);
  }
  anomalyLut = lut;
  return lut;
}

/** 露出した海底（濡れた砂）の色。露出の深さ（潮位−海底）が大きいほど濃く */
const SAND_N = 64;
const SAND_MAX = 6; // m
let sandLut: Uint32Array | null = null;

function getSandLut(): Uint32Array {
  if (sandLut) return sandLut;
  const lut = new Uint32Array(SAND_N + 1);
  const shallow = [214, 190, 140];
  const deep = [132, 108, 70];
  for (let i = 0; i <= SAND_N; i++) {
    const f = Math.sqrt(i / SAND_N);
    lut[i] = packRgba(
      shallow[0] + (deep[0] - shallow[0]) * f,
      shallow[1] + (deep[1] - shallow[1]) * f,
      shallow[2] + (deep[2] - shallow[2]) * f,
      240,
    );
  }
  sandLut = lut;
  return lut;
}

/** 到達時間の配色（分単位、0.1 分刻み、最大 240 分） */
const ARR_STEP_MIN = 0.1;
const ARR_N = 2400;
let arrivalLut: Uint32Array | null = null;
let arrivalLutKey = '';

function getArrivalLut(): Uint32Array {
  const key = ARRIVAL_CLASSES.map((c) => `${c.maxMin}:${c.color}`).join('|');
  if (arrivalLut && key === arrivalLutKey) return arrivalLut;
  const lut = new Uint32Array(ARR_N + 1);
  const rgb = ARRIVAL_CLASSES.map((c) => hexToRgb(c.color));
  for (let i = 0; i <= ARR_N; i++) {
    const m = i * ARR_STEP_MIN + 1e-6;
    let ci = ARRIVAL_CLASSES.findIndex((c) => m <= c.maxMin);
    if (ci < 0) ci = ARRIVAL_CLASSES.length - 1;
    const [r, g, b] = rgb[ci];
    lut[i] = packRgba(r, g, b, 215);
  }
  arrivalLut = lut;
  arrivalLutKey = key;
  return lut;
}

// ---------------------------------------------------------------------------
// キャンバス
// ---------------------------------------------------------------------------

/** 1セル = 1ピクセルの描画先（再利用する） */
export class CellCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  pixels: Uint32Array = new Uint32Array(0);
  width = 0;
  height = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    // CPU 側のキャンバスにしておくと putImageData → テクスチャ転送が速い
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
  }

  /** サイズを合わせる。変わった場合 true */
  ensure(width: number, height: number): boolean {
    if (this.image && this.width === width && this.height === height) return false;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.image = this.ctx.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    return true;
  }

  clear(): void {
    this.pixels.fill(0);
  }

  commit(): void {
    if (this.image) this.ctx.putImageData(this.image, 0, 0);
  }

  /** メモリを手放す */
  release(): void {
    this.image = null;
    this.pixels = new Uint32Array(0);
    this.width = this.height = 0;
    this.canvas.width = this.canvas.height = 1;
  }
}

// ---------------------------------------------------------------------------
// 出力ごとの前処理
// ---------------------------------------------------------------------------

/** 出力と地形の組み合わせに固有の参照データ（初期に水があったセル、基準潮位） */
export interface FloodReference {
  output: SimOutput;
  grid: TerrainGrid;
  /**
   * t=0 に水があったセル（1）。海・川は通常すべて 1。陸のセルが初期から水をかぶっている場合
   * （潮位より低い土地など）も 1 とし、浸水ではなく水面として扱う。
   */
  wet0: Uint8Array;
  /** 基準の静水位（潮位） [m, T.P.] */
  tide: number;
}

export function specsMatch(a: GridSpec, b: GridSpec): boolean {
  return a.nx === b.nx && a.ny === b.ny && a.originPx === b.originPx && a.originPy === b.originPy && a.cellPx === b.cellPx;
}

/**
 * t=0 の水深から、初期に水があった海セルと基準潮位を求める。
 * 潮位は計算に使ったパラメータがあとで UI で変えられても狂わないよう、出力そのものから推定する。
 */
export function buildFloodReference(grid: TerrainGrid, output: SimOutput, scratch: Float32Array, fallbackTide: number): FloodReference {
  const n = grid.spec.nx * grid.spec.ny;
  const wet0 = new Uint8Array(n);
  const samples: number[] = [];
  const hasFrame = output.framesReady() > 0;
  if (hasFrame) output.fillDepth(0, scratch);
  const { kind, z } = grid;
  const stride = Math.max(1, Math.floor(n / 6000));
  for (let k = 0; k < n; k++) {
    const sea = kind[k] === CELL_SEA;
    const d = hasFrame ? scratch[k] : sea ? Math.max(0, fallbackTide - z[k]) : 0;
    if (d >= 0.01) {
      wet0[k] = 1;
      if (sea && k % stride === 0 && z[k] < -1) samples.push(z[k] + d);
    }
  }
  let tide = fallbackTide;
  if (samples.length >= 16) {
    samples.sort((a, b) => a - b);
    const med = samples[samples.length >> 1];
    if (Number.isFinite(med) && Math.abs(med - fallbackTide) < 3) tide = med;
  }
  return { output, grid, wet0, tide };
}

// ---------------------------------------------------------------------------
// 塗り
// ---------------------------------------------------------------------------

/** 現在時刻の浸水・海面の偏差・露出した海底 */
export function paintFlood(target: CellCanvas, ref: FloodReference, t: number, depth: Float32Array): void {
  const { grid, output, wet0, tide } = ref;
  const n = grid.spec.nx * grid.spec.ny;
  output.fillDepth(t, depth);
  const px = target.pixels;
  const { kind, z } = grid;
  const dLut = getDepthLut();
  const aLut = getAnomalyLut();
  const sLut = getSandLut();
  const aScale = 1 / ANOM_STEP;
  const sScale = SAND_N / SAND_MAX;
  for (let k = 0; k < n; k++) {
    const d = depth[k];
    const w0 = wet0[k];
    if (!w0 && kind[k] !== CELL_SEA) {
      // 陸（内水面を含む）: 浸水深
      px[k] = depthColor(dLut, d);
      continue;
    }
    if (!(d >= 0.01)) {
      // 乾いた海セル: 引き波で露出した海底だけを塗る（初めから乾いていたセルは塗らない）
      if (w0) {
        let si = Math.floor((tide - z[k]) * sScale);
        if (si < 0) si = 0;
        else if (si > SAND_N) si = SAND_N;
        px[k] = sLut[si];
      } else px[k] = 0;
      continue;
    }
    let ai = Math.round((z[k] + d - tide - ANOM_MIN) * aScale);
    if (ai < 0) ai = 0;
    else if (ai > ANOM_N) ai = ANOM_N;
    px[k] = aLut[ai];
  }
  target.commit();
}

/** 最大浸水深（陸域） */
export function paintMaxDepth(target: CellCanvas, grid: TerrainGrid, output: SimOutput): void {
  const n = grid.spec.nx * grid.spec.ny;
  const px = target.pixels;
  const lut = getDepthLut();
  const md = output.maxDepth;
  const { kind } = grid;
  for (let k = 0; k < n; k++) px[k] = kind[k] === CELL_SEA ? 0 : depthColor(lut, md[k]);
  target.commit();
}

/** 津波の到達時間（初期に乾燥していたセルが最初に浸水した時刻） */
export function paintArrival(target: CellCanvas, grid: TerrainGrid, output: SimOutput): void {
  const n = grid.spec.nx * grid.spec.ny;
  const px = target.pixels;
  const lut = getArrivalLut();
  const arr = output.arrival;
  const inv = 1 / (60 * ARR_STEP_MIN);
  for (let k = 0; k < n; k++) {
    const s = arr[k];
    if (!(s >= 0) || s === Infinity) {
      px[k] = 0;
      continue;
    }
    const i = Math.floor(s * inv);
    px[k] = lut[i < ARR_N ? i : ARR_N];
  }
  target.commit();
}
