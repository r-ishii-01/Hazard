/**
 * 水域の連続性（つながり）の処理（純粋関数）。
 *
 * 細い川（幅 20〜40 m 程度）は、z15 の画素（約 3.9 m）では海までつながっていても、
 * 15〜31 m のセルに平均すると「水面が半分未満」のセルが所々にでき、上流側が海から切り離されてしまう
 * （特に川が斜めに流れる区間では、水域セルが角でしか接しなくなる）。
 * 計算は4近傍（上下左右）の流れで行うので、そのままでは津波が川をさかのぼれない。
 *
 * そこで、まず画素の段階で「海とつながった水面」を求め（seaConnectedPixels）、
 * セルの段階でそのつながりを保つのに必要な最小限のセルだけを水域にする（connectSeaWater）。
 * 実際に画素でつながっている水域だけをつなぐので、堤防や道路で隔てられた池を誤って海につなぐことはない。
 */

/**
 * 海とつながった水面の画素（1）のマスク。
 * 範囲の南端（沖）の行にある無効値（NA）の画素から、4近傍でたどれる NA の画素。
 * 取得失敗で値が不明な画素（unknownPx = 1）は水面として扱わない。
 */
export function seaConnectedPixels(heights: Float32Array, width: number, height: number, unknownPx?: Uint8Array | null): Uint8Array {
  const n = width * height;
  const mask = new Uint8Array(n);
  const queue = new Int32Array(n);
  const isWater = (k: number) => heights[k] !== heights[k] && !(unknownPx && unknownPx[k]);
  let tail = 0;
  const south = (height - 1) * width;
  for (let x = 0; x < width; x++) {
    const k = south + x;
    if (isWater(k)) {
      mask[k] = 1;
      queue[tail++] = k;
    }
  }
  for (let head = 0; head < tail; head++) {
    const k = queue[head];
    const x = k % width;
    if (x > 0 && !mask[k - 1] && isWater(k - 1)) {
      mask[k - 1] = 1;
      queue[tail++] = k - 1;
    }
    if (x < width - 1 && !mask[k + 1] && isWater(k + 1)) {
      mask[k + 1] = 1;
      queue[tail++] = k + 1;
    }
    if (k >= width && !mask[k - width] && isWater(k - width)) {
      mask[k - width] = 1;
      queue[tail++] = k - width;
    }
    if (k + width < n && !mask[k + width] && isWater(k + width)) {
      mask[k + width] = 1;
      queue[tail++] = k + width;
    }
  }
  return mask;
}

/**
 * 値が不明なセル（unknown[k] が真。タイルの取得失敗による）を、周囲の分かっているセルから補う（elev をその場で書き換え）。
 * 分かっているセルから近い順に、隣接する（補済みを含む）セルの多数決で陸・水域を決め、陸なら陸セルの標高の平均を与える。
 * 取得に失敗したタイルが水域（海）として扱われ、内陸に「海」ができるのを防ぐ。補ったセル数を返す。
 */
export function fillUnknownCells(elev: Float32Array, unknown: ArrayLike<number | boolean>, nx: number, ny: number): number {
  const n = nx * ny;
  const assigned = new Uint8Array(n);
  let pending = 0;
  for (let k = 0; k < n; k++) {
    if (unknown[k]) pending++;
    else assigned[k] = 1;
  }
  if (pending === 0 || pending === n) return 0;
  let filled = 0;
  let frontier: number[] = [];
  const inFrontier = new Uint8Array(n);
  const pushNeighbours = (k: number, out: number[]) => {
    const i = k % nx;
    const j = (k - i) / nx;
    const cand = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
    for (const kk of cand) {
      if (kk >= 0 && !assigned[kk] && !inFrontier[kk]) {
        inFrontier[kk] = 1;
        out.push(kk);
      }
    }
  };
  for (let k = 0; k < n; k++) if (assigned[k]) pushNeighbours(k, frontier);
  while (frontier.length > 0) {
    // 同じ距離のセルは、ひとつ前までに決まったセルだけを見て決める（処理順に依存しない）
    const values: number[] = [];
    for (const k of frontier) {
      const i = k % nx;
      const j = (k - i) / nx;
      let land = 0;
      let water = 0;
      let s = 0;
      for (const kk of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1]) {
        if (kk < 0 || !assigned[kk]) continue;
        const v = elev[kk];
        if (v === v) {
          land++;
          s += v;
        } else water++;
      }
      values.push(land > 0 && land >= water ? s / land : Number.NaN);
    }
    const next: number[] = [];
    frontier.forEach((k, q) => {
      elev[k] = values[q];
      assigned[k] = 1;
      filled++;
    });
    for (const k of frontier) pushNeighbours(k, next);
    frontier = next;
  }
  return filled;
}

/**
 * 画素の段階で海とつながっている水域が、セルの段階でも4近傍で海につながるように、最小限の陸セルを水域にする
 * （elev をその場で書き換え、水域にしたセル数を返す）。
 *
 * seaFrac[k] > 0（セル内に海とつながった水面の画素がある）のセルだけを通る経路のうち、
 * 水域にする陸セルの数が最小の経路を 0-1 BFS で求める。海とつながった水面の画素を含むのに
 * セルの段階で海から切り離されている水域（川の上流など）ごとに、その経路上の陸セルを水域にする。
 * 格子の南端の行を外海とする。
 */
export function connectSeaWater(elev: Float32Array, seaFrac: Float32Array, nx: number, ny: number): number {
  const n = nx * ny;
  const trav = (k: number) => seaFrac[k] > 0;
  const isWater = (k: number) => elev[k] !== elev[k];
  const INF = 0x3fffffff;
  const dist = new Int32Array(n).fill(INF);
  const parent = new Int32Array(n).fill(-1);
  // 0-1 BFS 用の両端キュー（循環バッファ）。各セルは高々2回しか入らない
  const cap = 2 * n + 2;
  const dq = new Int32Array(cap);
  let head = 0;
  let tail = 0;
  const pushFront = (k: number) => {
    head = (head - 1 + cap) % cap;
    dq[head] = k;
  };
  const pushBack = (k: number) => {
    dq[tail] = k;
    tail = (tail + 1) % cap;
  };
  for (let i = 0; i < nx; i++) {
    const k = (ny - 1) * nx + i;
    if (!trav(k)) continue;
    dist[k] = isWater(k) ? 0 : 1;
    if (dist[k] === 0) pushFront(k);
    else pushBack(k);
  }
  while (head !== tail) {
    const k = dq[head];
    head = (head + 1) % cap;
    const d = dist[k];
    const i = k % nx;
    const j = (k - i) / nx;
    for (let e = 0; e < 4; e++) {
      let kk: number;
      if (e === 0) {
        if (i === 0) continue;
        kk = k - 1;
      } else if (e === 1) {
        if (i === nx - 1) continue;
        kk = k + 1;
      } else if (e === 2) {
        if (j === 0) continue;
        kk = k - nx;
      } else {
        if (j === ny - 1) continue;
        kk = k + nx;
      }
      if (!trav(kk)) continue;
      const w = isWater(kk) ? 0 : 1;
      if (d + w < dist[kk]) {
        dist[kk] = d + w;
        parent[kk] = k;
        if (w === 0) pushFront(kk);
        else pushBack(kk);
      }
    }
  }

  // 海とつながった水面を含む水域セルの連結成分ごとに、最も少ない変換で届くセルを選ぶ
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const targets: number[] = [];
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1 || !isWater(s) || !trav(s)) continue;
    let qh = 0;
    let qt = 0;
    queue[qt++] = s;
    comp[s] = id;
    let best = s;
    while (qh < qt) {
      const k = queue[qh++];
      if (dist[k] < dist[best]) best = k;
      const i = k % nx;
      const j = (k - i) / nx;
      const cand = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
      for (const kk of cand) {
        if (kk >= 0 && comp[kk] === -1 && isWater(kk) && trav(kk)) {
          comp[kk] = id;
          queue[qt++] = kk;
        }
      }
    }
    if (dist[best] > 0 && dist[best] < INF) targets.push(best);
    id++;
  }
  let converted = 0;
  for (const t of targets) {
    for (let k = t; k !== -1; k = parent[k]) {
      if (!isWater(k)) {
        elev[k] = Number.NaN;
        converted++;
      }
    }
  }
  return converted;
}
