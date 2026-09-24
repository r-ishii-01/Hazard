/**
 * 厳密なユークリッド距離変換（Felzenszwalb & Huttenlocher 2012, "Distance Transforms of Sampled Functions",
 * Theory of Computing 8, 415–428. https://theoryofcomputing.org/articles/v008a019/ ）。
 * 列方向・行方向の1次元変換を順に適用する O(n) のアルゴリズム（純粋関数）。
 */

const INF = 1e20;

/** 1次元の二乗距離変換（f → d）。v, z は作業配列 */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * 各セルから「特徴セル」（feature[k] が真）までの最短ユークリッド距離 [セル数]。
 * 特徴セルが1つも無い場合は Infinity。
 */
export function distanceTransform(feature: ArrayLike<number | boolean>, nx: number, ny: number): Float32Array {
  const n = nx * ny;
  const grid = new Float64Array(n);
  let any = false;
  for (let k = 0; k < n; k++) {
    if (feature[k]) {
      grid[k] = 0;
      any = true;
    } else grid[k] = INF;
  }
  const out = new Float32Array(n);
  if (!any) return out.fill(Number.POSITIVE_INFINITY);
  const m = Math.max(nx, ny);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  // 列方向
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = grid[j * nx + i];
    dt1d(f, ny, d, v, z);
    for (let j = 0; j < ny; j++) grid[j * nx + i] = d[j];
  }
  // 行方向
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) f[i] = grid[row + i];
    dt1d(f, nx, d, v, z);
    for (let i = 0; i < nx; i++) out[row + i] = Math.sqrt(d[i]);
  }
  return out;
}
