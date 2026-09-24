/**
 * テスト・性能測定・動作確認用の合成（架空）地形。実在の地形ではない。
 * src/terrain に依存せず、ソルバ単体を検証するために使う。
 */
import { CELL_LAND, CELL_SEA, type TerrainGrid } from '../core/types';
import { cellCenter, createGridSpec, DOMAIN_BOUNDS, type GridSpec, type Resolution } from '../core/geo';

export interface SimpleGridOptions {
  nx: number;
  ny: number;
  /** セル辺長 [m] */
  dx: number;
  /** 地盤高 [m, T.P.] */
  z: (i: number, j: number) => number;
  /** セル種別（省略時: z < 0 なら海） */
  kind?: (i: number, j: number, z: number) => number;
  manning?: number;
  spec?: GridSpec;
}

/** 経緯度と無関係な単純な格子（spec は形式上のもの） */
export function makeSimpleGrid(o: SimpleGridOptions): TerrainGrid {
  const n = o.nx * o.ny;
  const z = new Float32Array(n);
  const kind = new Uint8Array(n);
  const manning = new Float32Array(n).fill(o.manning ?? 0.025);
  for (let j = 0; j < o.ny; j++) {
    for (let i = 0; i < o.nx; i++) {
      const k = j * o.nx + i;
      const zz = o.z(i, j);
      z[k] = zz;
      kind[k] = o.kind ? o.kind(i, j, zz) : zz < 0 ? CELL_SEA : CELL_LAND;
    }
  }
  const spec: GridSpec = o.spec ?? { zoom: 15, originPx: 7443968, originPy: 3313664, cellPx: 4, nx: o.nx, ny: o.ny, dx: o.dx };
  return {
    spec,
    z,
    kind,
    manning,
    source: 'synthetic',
    sourceLabel: '合成地形（テスト用）',
    isApproximate: true,
    notes: ['テスト用の架空の地形です'],
  };
}

export interface KugenumaLikeOptions {
  resolution?: Resolution;
  bounds?: { west: number; east: number; south: number; north: number };
  /** 汀線の緯度 */
  shoreLat?: number;
  /** 沖方向の海底勾配（1/x の x） */
  seaSlope?: number;
  /** 最大水深 [m] */
  maxDepth?: number;
  /** 一定水深の棚にする場合の水深 [m]（指定時は seaSlope を無視し、汀線付近だけ勾配） */
  shelfDepth?: number;
  /** 砂丘（堤）の高さ [m, T.P.]（0 なら無し） */
  duneHeight?: number;
  /** 背後地の地盤高 [m, T.P.] */
  plainHeight?: number;
  /** 江の島に見立てた島を置く */
  island?: boolean;
  /** 川（引地川・境川に見立てた水路）を置く */
  rivers?: boolean;
}

/**
 * 鵠沼海岸に似せた合成地形（実在の位置の格子上に、単純な海底勾配・砂浜・砂丘・平地・島・川を置く）。
 */
export function makeKugenumaLikeGrid(o: KugenumaLikeOptions = {}): TerrainGrid {
  // createGridSpec の引数型は DOMAIN_BOUNDS のリテラル型なので、同じ形のオブジェクトとして渡す
  const spec = createGridSpec(o.resolution ?? 'standard', (o.bounds ?? DOMAIN_BOUNDS) as typeof DOMAIN_BOUNDS);
  const shoreLat = o.shoreLat ?? 35.3125;
  const mPerDegLat = 110950;
  const mPerDegLon = 90800;
  const slope = o.seaSlope ?? 80;
  const maxDepth = o.maxDepth ?? 32;
  const dune = o.duneHeight ?? 5;
  const plain = o.plainHeight ?? 3;
  const rivers = o.rivers ?? true;
  const island = o.island ?? true;
  const riverHalfWidth = Math.max(spec.dx * 1.5, 22);
  const n = spec.nx * spec.ny;
  const z = new Float32Array(n);
  const kind = new Uint8Array(n);
  const manning = new Float32Array(n).fill(0.025);
  for (let j = 0; j < spec.ny; j++) {
    for (let i = 0; i < spec.nx; i++) {
      const k = j * spec.nx + i;
      const c = cellCenter(spec, i, j);
      // 汀線をゆるく曲げる
      const sLat = shoreLat + 0.0006 * Math.sin((c.lon - 139.44) * 150);
      const s = (sLat - c.lat) * mPerDegLat; // 汀線から沖への距離 [m]（陸では負）
      let zz: number;
      let sea: boolean;
      if (s > 0) {
        sea = true;
        zz = o.shelfDepth !== undefined ? -Math.min(o.shelfDepth, 0.5 + s / 20) : -Math.min(maxDepth, 0.5 + s / slope);
      } else {
        sea = false;
        const x = -s; // 内陸への距離
        if (x < 50) zz = 0.3 + (x / 50) * 1.7;
        else if (dune > 0 && x < 110) zz = Math.max(2, dune - Math.abs(x - 80) * 0.05);
        else zz = plain + 0.0015 * (x - 110);
      }
      if (island) {
        const ex = ((c.lon - 139.4795) * mPerDegLon) / 450;
        const ey = ((c.lat - 35.2995) * mPerDegLat) / 250;
        const r2 = ex * ex + ey * ey;
        if (r2 < 1) {
          sea = false;
          zz = Math.max(zz, 2 + 55 * (1 - r2));
        }
      }
      if (rivers && s <= 0) {
        for (const lon of [139.4595, 139.483]) {
          if (Math.abs(c.lon - lon) * mPerDegLon < riverHalfWidth) {
            sea = true;
            zz = -1.5;
          }
        }
      }
      z[k] = zz;
      kind[k] = sea ? CELL_SEA : CELL_LAND;
    }
  }
  return {
    spec,
    z,
    kind,
    manning,
    source: 'synthetic',
    sourceLabel: '合成地形（鵠沼海岸に似せた架空の地形・テスト用）',
    isApproximate: true,
    notes: ['テスト用の架空の地形です'],
  };
}
