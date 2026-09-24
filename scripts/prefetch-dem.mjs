#!/usr/bin/env node
/**
 * 国土地理院の標高タイルと、公式の津波浸水想定タイルを public/tiles/ にダウンロードする
 * （サイトに同梱するローカルミラーを作る）。
 *
 * 対象: 計算範囲（src/core/geo.ts の DOMAIN_BOUNDS。辻堂〜鵠沼〜片瀬・江の島）を覆う
 *   - DEM5A / DEM5B / DEM5C（dem5a_png / dem5b_png / dem5c_png, z15）
 *   - DEM10B（dem_png, z14）
 *     これは src/terrain（loadTerrain）が使う可能性のあるタイルの一覧と同じ（tests/terrain-prefetch.test.ts で確認）。
 *   - 津波浸水想定（hazard-tsunami, z15）: ハザードマップポータルサイトのオープンデータ
 *     （04_tsunami_newlegend_data。神奈川県の津波浸水想定）。src/data/officialHazard.ts が人物の評価
 *     （公式の浸水想定区域の判定）に使う。浸水想定の無いタイルは配信元も 404（manifest に 0 と記録）。
 * 保存先: public/tiles/<layer>/<z>/<x>/<y>.png と public/tiles/manifest.json（取得結果の一覧。404 も記録）。
 * ブラウザ側は manifest.json があればミラーを優先し、無いタイルだけ配信元から取得する。
 *
 * 使い方（Node.js 20 以上）:
 *   node scripts/prefetch-dem.mjs              # ダウンロード（保存済みのタイルはスキップ）
 *   node scripts/prefetch-dem.mjs --dry-run    # ダウンロードせず URL の一覧を表示
 *   node scripts/prefetch-dem.mjs --dry-run --json   # 一覧を JSON で表示
 *   node scripts/prefetch-dem.mjs --force      # 保存済みのタイルも取り直す
 *   node scripts/prefetch-dem.mjs --only dem   # 標高タイルだけ（--only hazard で津波浸水想定だけ）
 *   node scripts/prefetch-dem.mjs --out <dir>  # 保存先（既定: public/tiles）
 *
 * HTTPS プロキシの内側で実行する場合: Node.js の fetch は既定では HTTPS_PROXY 等の環境変数を使わない。
 * 環境変数 NODE_USE_ENV_PROXY=1 を付けて実行する（Node.js 22.21 / 24.5 以降で対応）:
 *   NODE_USE_ENV_PROXY=1 node scripts/prefetch-dem.mjs
 *
 * 配信元への配慮: 同時接続 4 以下、各リクエストの後に待ち時間を入れる。404（データの無いタイル、海など）は正常。
 * 出典表示: 国土地理院「地理院タイル（標高タイル）」 https://maps.gsi.go.jp/development/ichiran.html#dem
 *   （国土地理院コンテンツ利用規約 https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html ）
 *   津波浸水想定: 出典「ハザードマップポータルサイト」（津波浸水想定：神奈川県）。オープンデータとして配信され、
 *   公共データ利用規約（第1.0版）により出典の記載で複製・加工して利用できる
 *   （https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html 、
 *    https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/copyright.html ）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const GSI_XYZ_BASE = 'https://cyberjapandata.gsi.go.jp/xyz';
export const DEM5_LAYERS = ['dem5a_png', 'dem5b_png', 'dem5c_png'];
export const DEM10_LAYER = 'dem_png';
/** 津波浸水想定（ハザードマップポータルサイト）のミラーのレイヤー名（src/data/officialHazard.ts と同じ） */
export const HAZARD_LAYER = 'hazard-tsunami';
/** 津波浸水想定のタイルの配信元（src/data/sources.ts の HAZARD_TSUNAMI_TILES.url と同じ） */
export const HAZARD_URL_TEMPLATE = 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png';
const HAZARD_ZOOM = 15;
const BASE_ZOOM = 15;
const DEM10_ZOOM = 14;
const TILE_SIZE = 256;
const SNAP = 8;

/** src/core/geo.ts と同じ既定値（ファイルを読めない場合に使う） */
const FALLBACK_BOUNDS = { west: 139.44, east: 139.5, south: 35.29, north: 35.345 };

/** src/core/geo.ts の DOMAIN_BOUNDS を読む（範囲を変えたときにスクリプトも追従するように） */
export function readDomainBounds(geoPath = join(ROOT, 'src/core/geo.ts')) {
  try {
    const src = readFileSync(geoPath, 'utf8');
    const m = /DOMAIN_BOUNDS\s*=\s*\{([^}]*)\}/.exec(src);
    if (!m) return { ...FALLBACK_BOUNDS };
    const out = {};
    for (const key of ['west', 'east', 'south', 'north']) {
      const v = new RegExp(`${key}\\s*:\\s*(-?[0-9.]+)`).exec(m[1]);
      if (!v) return { ...FALLBACK_BOUNDS };
      out[key] = Number(v[1]);
    }
    return out;
  } catch {
    return { ...FALLBACK_BOUNDS };
  }
}

function lonLatToPixel(lon, lat, zoom) {
  const ws = TILE_SIZE * 2 ** zoom;
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * ws, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws };
}

/** 計算範囲を覆うタイル範囲（src/core/geo.ts の createGridSpec / gridTileRange と同じ計算） */
export function tileRanges(bounds = readDomainBounds()) {
  const nw = lonLatToPixel(bounds.west, bounds.north, BASE_ZOOM);
  const se = lonLatToPixel(bounds.east, bounds.south, BASE_ZOOM);
  const originPx = Math.floor(nw.x / SNAP) * SNAP;
  const originPy = Math.floor(nw.y / SNAP) * SNAP;
  const endPx = Math.ceil(se.x / SNAP) * SNAP;
  const endPy = Math.ceil(se.y / SNAP) * SNAP;
  const range = (zoom) => {
    const scale = 2 ** (zoom - BASE_ZOOM);
    return {
      zoom,
      x0: Math.floor((originPx * scale) / TILE_SIZE),
      y0: Math.floor((originPy * scale) / TILE_SIZE),
      x1: Math.floor((endPx * scale - 1e-9) / TILE_SIZE),
      y1: Math.floor((endPy * scale - 1e-9) / TILE_SIZE),
    };
  };
  return { z15: range(BASE_ZOOM), z14: range(DEM10_ZOOM) };
}

function addRange(out, layer, r) {
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push({ layer, z: r.zoom, x, y });
}

/** 標高タイルの一覧（src/terrain の listRequiredDemTiles と同じ） */
export function listTiles(bounds) {
  const { z15, z14 } = tileRanges(bounds);
  const out = [];
  for (const layer of DEM5_LAYERS) addRange(out, layer, z15);
  addRange(out, DEM10_LAYER, z14);
  return out;
}

/** 津波浸水想定タイルの一覧（z15。src/data/officialHazard.ts の officialHazardTiles と同じ） */
export function listHazardTiles(bounds) {
  const { z15 } = tileRanges(bounds);
  if (z15.zoom !== HAZARD_ZOOM) throw new Error('unexpected zoom');
  const out = [];
  addRange(out, HAZARD_LAYER, z15);
  return out;
}

/** ダウンロード対象（only: 'dem' | 'hazard' | undefined＝両方） */
export function listAllTiles(bounds, only) {
  return [...(only === 'hazard' ? [] : listTiles(bounds)), ...(only === 'dem' ? [] : listHazardTiles(bounds))];
}

export const tileKey = (t) => `${t.layer}/${t.z}/${t.x}/${t.y}`;
export const tileUrl = (t) =>
  t.layer === HAZARD_LAYER
    ? HAZARD_URL_TEMPLATE.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y))
    : `${GSI_XYZ_BASE}/${t.layer}/${t.z}/${t.x}/${t.y}.png`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, force: false, out: join(ROOT, 'public/tiles'), concurrency: 4, delayMs: 250 };
  for (let a = 0; a < argv.length; a++) {
    const v = argv[a];
    if (v === '--dry-run' || v === '-n') opts.dryRun = true;
    else if (v === '--json') opts.json = true;
    else if (v === '--force') opts.force = true;
    else if (v === '--out') opts.out = resolve(argv[++a] ?? opts.out);
    else if (v === '--concurrency') opts.concurrency = Math.min(4, Math.max(1, Number(argv[++a]) || 4));
    else if (v === '--only') {
      const w = argv[++a];
      if (w !== 'dem' && w !== 'hazard') throw new Error(`--only には dem か hazard を指定してください: ${w ?? ''}`);
      opts.only = w;
    }
    else if (v === '--help' || v === '-h') opts.help = true;
    else throw new Error(`不明なオプション: ${v}`);
  }
  return opts;
}

async function isValidPng(path) {
  try {
    const s = await stat(path);
    if (s.size < PNG_SIGNATURE.length) return false;
    const head = (await readFile(path)).subarray(0, PNG_SIGNATURE.length);
    return head.equals(PNG_SIGNATURE);
  } catch {
    return false;
  }
}

/** 1枚を取得。戻り値: 'saved' | 'missing' | 'failed:<理由>' */
async function download(tile, outDir) {
  const url = tileUrl(tile);
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'kugenuma-tsunami-sim/prefetch-dem' } });
      // 浸水想定・標高データの無いタイル（海だけ・内陸など）は配信元も 404
      if (res.status === 404) return 'missing';
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        if (res.status >= 500 || res.status === 429) continue;
        return `failed:${last}`;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'failed:PNG ではない応答';
      const path = join(outDir, tile.layer, String(tile.z), String(tile.x), `${tile.y}.png`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, buf);
      await rename(`${path}.tmp`, path);
      return 'saved';
    } catch (e) {
      last = e?.cause?.code ?? e?.name ?? String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  return `failed:${last}`;
}

async function readManifest(outDir) {
  try {
    const data = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    if (data && data.version === 1 && data.tiles && typeof data.tiles === 'object') return data.tiles;
  } catch {
    /* 無ければ新規 */
  }
  return {};
}

/** CLI 本体（テストから呼べるように export。戻り値は終了コード） */
export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n'));
    return 0;
  }
  const bounds = readDomainBounds();
  const tiles = listAllTiles(bounds, opts.only);

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({ bounds, tiles: tiles.map((t) => ({ ...t, url: tileUrl(t) })) }, null, 2));
    } else {
      for (const t of tiles) console.log(tileUrl(t));
      const { z15, z14 } = tileRanges(bounds);
      const layers = (opts.only === 'hazard' ? 0 : DEM5_LAYERS.length) + (opts.only === 'dem' ? 0 : 1);
      console.error(
        `\n計 ${tiles.length} 枚（z15: x ${z15.x0}–${z15.x1}, y ${z15.y0}–${z15.y1} × ${layers} レイヤー` +
          (opts.only === 'hazard' ? '' : `、z14: x ${z14.x0}–${z14.x1}, y ${z14.y0}–${z14.y1}`) +
          '）。--dry-run のためダウンロードしていません。',
      );
    }
    return 0;
  }

  if (typeof fetch !== 'function') throw new Error('Node.js 20 以上が必要です（fetch が使えません）');
  await mkdir(opts.out, { recursive: true });
  const saved = await readManifest(opts.out);
  const previous = opts.force ? {} : saved;
  const manifest = {};
  // --only で対象にしなかったレイヤーの記録は残す
  const listedLayers = new Set(tiles.map((t) => t.layer));
  for (const [key, v] of Object.entries(saved)) {
    if (!listedLayers.has(key.split('/')[0])) manifest[key] = v;
  }
  const counts = { saved: 0, skipped: 0, missing: 0, failed: 0 };
  const failures = [];

  let next = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const t = tiles[next++];
      const key = tileKey(t);
      const path = join(opts.out, t.layer, String(t.z), String(t.x), `${t.y}.png`);
      if (!opts.force && (await isValidPng(path))) {
        manifest[key] = 1;
        counts.skipped++;
        continue;
      }
      if (!opts.force && previous[key] === 0) {
        manifest[key] = 0;
        counts.missing++;
        continue;
      }
      const r = await download(t, opts.out);
      if (r === 'saved') {
        manifest[key] = 1;
        counts.saved++;
      } else if (r === 'missing') {
        manifest[key] = 0;
        counts.missing++;
      } else {
        counts.failed++;
        failures.push(`${tileUrl(t)} (${r.slice(7)})`);
      }
      const done = counts.saved + counts.skipped + counts.missing + counts.failed;
      process.stderr.write(`\r${done}/${tiles.length} 保存 ${counts.saved} / 既存 ${counts.skipped} / データなし ${counts.missing} / 失敗 ${counts.failed}   `);
      await sleep(opts.delayMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, 4) }, worker));
  process.stderr.write('\n');

  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  const body = {
    version: 1,
    generated: new Date().toISOString(),
    source: `${GSI_XYZ_BASE}/`,
    attribution: '国土地理院 地理院タイル（標高タイル） https://maps.gsi.go.jp/development/ichiran.html#dem',
    sources: {
      [HAZARD_LAYER]: {
        source: HAZARD_URL_TEMPLATE,
        attribution:
          '出典：「ハザードマップポータルサイト」（津波浸水想定：神奈川県） https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html',
      },
    },
    bounds,
    tiles: sorted,
  };
  await writeFile(join(opts.out, 'manifest.json'), `${JSON.stringify(body, null, 1)}\n`);

  console.log(
    `完了: 保存 ${counts.saved} 枚、既存 ${counts.skipped} 枚、データなし(404) ${counts.missing} 枚、失敗 ${counts.failed} 枚 → ${opts.out}`,
  );
  if (failures.length > 0) {
    console.error('取得できなかったタイル（ブラウザでは配信元から直接取得を試みます）:');
    for (const f of failures.slice(0, 20)) console.error(`  ${f}`);
    if (failures.length > 20) console.error(`  ほか ${failures.length - 20} 枚`);
    if (counts.saved + counts.skipped === 0) {
      console.error('1枚も取得できませんでした。ネットワーク接続（プロキシの内側なら NODE_USE_ENV_PROXY=1）を確認してください。');
    }
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
