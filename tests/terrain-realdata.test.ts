/**
 * 同梱の標高タイル（public/tiles/。scripts/prefetch-dem.mjs で取得した国土地理院 DEM5A の複製）を
 * loadTerrain の実際の処理（ミラー → デコード → モザイク → セル → 分類）に通して、実在の地形と照合する。
 * ネットワークは使わない。ミラーが無い場合（削除した場合）はスキップする。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cellCenter, lonLatToCell, type Resolution } from '../src/core/geo';
import { CELL_LAND, CELL_SEA, type TerrainGrid } from '../src/core/types';
import { clearTerrainCache, loadTerrain, sampleGround } from '../src/terrain';
import { isKnownMissingTile, listRequiredDemTiles } from '../src/terrain/tiles';

interface NodeFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
// 型定義（@types/node）を使わずに Node の fs を読む
const fsName = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
const ROOT = decodeURIComponent(new URL('../public/', import.meta.url).pathname);
const hasMirror = fs.existsSync(`${ROOT}tiles/manifest.json`) && fs.existsSync(`${ROOT}tiles/dem5a_png`);

/** 最小限の PNG デコーダ（8bit・非インターレースの RGB / RGBA。国土地理院の標高タイルは RGB） */
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

/**
 * 照合に使う地点（出典）
 * - 江の島: 北緯35度17分59秒 東経139度28分49秒（Wikipedia「Enoshima」 https://en.wikipedia.org/wiki/Enoshima ）
 * - 鵠沼海岸駅: 北緯35度19分14.85秒 東経139度28分16.06秒（Wikipedia「Kugenuma-Kaigan Station」
 *   https://en.wikipedia.org/wiki/Kugenuma-Kaigan_Station ）
 * - 引地川河口: 北緯35度19分0.2秒 東経139度28分2.9秒（Wikidata「Hikiji River」 河口の座標 https://www.wikidata.org/wiki/Q11487144 ）
 */
const ENOSHIMA = { lon: 139 + 28 / 60 + 49 / 3600, lat: 35 + 17 / 60 + 59 / 3600 };
const KUGENUMA_KAIGAN_STA = { lon: 139 + 28 / 60 + 16.06 / 3600, lat: 35 + 19 / 60 + 14.85 / 3600 };
const HIKIJI_MOUTH = { lon: 139 + 28 / 60 + 2.878 / 3600, lat: 35 + 19 / 60 + 0.203 / 3600 };

/** 経度 lon0〜lon1 の範囲で、緯度 lat の行に海セル（川）があるか */
function riverAt(g: TerrainGrid, lat: number, lon0: number, lon1: number): boolean {
  const a = lonLatToCell(g.spec, lon0, lat)!;
  const b = lonLatToCell(g.spec, lon1, lat)!;
  for (let i = a.i; i <= b.i; i++) if (g.kind[a.j * g.spec.nx + i] === CELL_SEA) return true;
  return false;
}

describe.skipIf(!hasMirror)('real GSI DEM5A tiles bundled in public/tiles', { timeout: 120000 }, () => {
  const grids = new Map<Resolution, TerrainGrid>();
  beforeAll(async () => {
    clearTerrainCache();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    for (const res of ['coarse', 'standard', 'fine'] as Resolution[]) {
      grids.set(res, await loadTerrain(res, { fetchImpl, decodeImpl, baseUrl: '/' }));
    }
    clearTerrainCache();
  });

  it('the embedded list of tiles missing at GSI matches the 404s recorded by the prefetch script', () => {
    const manifest = JSON.parse(new TextDecoder().decode(fs.readFileSync(`${ROOT}tiles/manifest.json`))) as { tiles: Record<string, 0 | 1> };
    for (const t of listRequiredDemTiles()) {
      const rec = manifest.tiles[`${t.layer}/${t.z}/${t.x}/${t.y}`];
      if (rec === undefined) continue; // 取得に失敗して記録の無いタイル
      expect(isKnownMissingTile(t.layer, t.z, t.x, t.y), `${t.layer}/${t.z}/${t.x}/${t.y}`).toBe(rec === 0);
    }
  });

  for (const res of ['coarse', 'standard', 'fine'] as Resolution[]) {
    it(`${res}: uses the mirror and places land, sea, 江の島 and stations correctly`, () => {
      const g = grids.get(res)!;
      expect(g.source).toBe('cache');
      expect(g.isApproximate).toBe(false);
      const kindAt = (p: { lon: number; lat: number }) => g.kind[lonLatToCell(g.spec, p.lon, p.lat)!.k];
      expect(kindAt(ENOSHIMA)).toBe(CELL_LAND);
      expect(sampleGround(g, ENOSHIMA.lon, ENOSHIMA.lat)!).toBeGreaterThan(45); // 最高標高 60.4 m の台地
      expect(kindAt(KUGENUMA_KAIGAN_STA)).toBe(CELL_LAND);
      const sta = sampleGround(g, KUGENUMA_KAIGAN_STA.lon, KUGENUMA_KAIGAN_STA.lat)!;
      expect(sta).toBeGreaterThan(2);
      expect(sta).toBeLessThan(7);
      expect(kindAt(HIKIJI_MOUTH)).toBe(CELL_SEA);
      expect(kindAt({ lon: 139.47, lat: 35.295 })).toBe(CELL_SEA); // 沖
      // 江の島は周囲を海に囲まれた陸（本土と陸続きの陸セルにはならない）
      const e = lonLatToCell(g.spec, ENOSHIMA.lon, ENOSHIMA.lat)!;
      let reachesNorth = false;
      const seen = new Uint8Array(g.kind.length);
      const stack = [e.k];
      seen[e.k] = 1;
      while (stack.length) {
        const k = stack.pop()!;
        const i = k % g.spec.nx;
        const j = (k - i) / g.spec.nx;
        if (j === 0) reachesNorth = true;
        for (const kk of [i > 0 ? k - 1 : -1, i < g.spec.nx - 1 ? k + 1 : -1, j > 0 ? k - g.spec.nx : -1, j < g.spec.ny - 1 ? k + g.spec.nx : -1]) {
          if (kk >= 0 && !seen[kk] && g.kind[kk] !== CELL_SEA) {
            seen[kk] = 1;
            stack.push(kk);
          }
        }
      }
      expect(reachesNorth).toBe(false);
    });

    it(`${res}: 引地川 and 境川 stay connected to the sea up to the northern part of the domain`, () => {
      const g = grids.get(res)!;
      // 北端から約 60 m（coarse では2セル）の行まで。画素の段階では北端まで海とつながっている
      const northLat = cellCenter(g.spec, 0, Math.ceil(60 / g.spec.dx)).lat;
      for (const lat of [35.322, 35.33, 35.334, 35.338, 35.342, northLat]) {
        expect(riverAt(g, lat, 139.4605, 139.4715), `引地川 @${lat}`).toBe(true);
      }
      // 境川は藤沢駅付近（北緯 35.343 度より北）で川幅が狭くなり、coarse（約 31 m）ではセルの半分未満になるので 35.342 度まで
      for (const lat of [35.312, 35.322, 35.33, 35.338, 35.342]) {
        expect(riverAt(g, lat, 139.4795, 139.496), `境川 @${lat}`).toBe(true);
      }
    });

    it(`${res}: land keeps DEM heights (no invented negative land) and the sea floor deepens offshore`, () => {
      const g = grids.get(res)!;
      let minLand = Infinity;
      for (let k = 0; k < g.z.length; k++) if (g.kind[k] !== CELL_SEA) minLand = Math.min(minLand, g.z[k]);
      expect(minLand).toBeGreaterThan(-1.5); // DEM5A の最低値は約 -1.1 m（汀線付近）
      // 辻堂沖で、汀線から沖へ単調に深くなる（推定水深。南端付近は江の島からの距離で決まる）
      let prev = 0;
      for (const lat of [35.316, 35.31, 35.303, 35.296, 35.2905]) {
        const h = sampleGround(g, 139.445, lat)!;
        expect(h).toBeLessThan(prev);
        prev = h;
      }
      expect(prev).toBeLessThan(-25);
      expect(prev).toBeGreaterThan(-45);
    });
  }
});
