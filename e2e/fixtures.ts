/**
 * E2E テストの共通部品。
 *
 * - 外部サーバーへの通信をすべて横取りし、小さな代替データ（単色の PNG タイル・避難場所の GeoJSON など）を返す
 *   （テストはインターネットに接続せずに動く）。標高タイルはリポジトリ内のミラー public/tiles から読まれる。
 * - コンソールのエラーと未処理の例外を集める。
 * - 「ご利用にあたって」を確認済みにしておく（地図をクリックするテストのため。オプションで無効化できる）。
 */
import { test as base, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { BUILTIN_TSUNAMI_SHELTERS } from '../src/data/shelters';
import { DOMAIN_BOUNDS } from '../src/core/geo';

/** 「ご利用にあたって」の確認済みフラグ（src/ui/disclaimer.ts の DISCLAIMER_KEY と同じ値） */
export const DISCLAIMER_KEY = 'kugenuma-disclaimer-v1';

// ---------------------------------------------------------------------------
// 代替データ
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * 格子模様の入った単色の RGBA PNG（256×256）。地図タイルの代わりに使う。
 * 模様があると、失敗時のスクリーンショットで「タイルが表示されている」ことが分かる。
 */
export function tilePng(rgba: [number, number, number, number], line: [number, number, number, number] = rgba): Buffer {
  const size = 256;
  const raw = new Uint8Array(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0; // フィルタなし
    for (let x = 0; x < size; x++) {
      const c = x % 64 === 0 || y % 64 === 0 ? line : rgba;
      raw.set(c, row + 1 + x * 4);
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 6; // RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  return Buffer.concat(parts);
}

const PNG = {
  /** 淡色地図の代わり */
  pale: tilePng([242, 240, 235, 255], [225, 222, 214, 255]),
  /** 標準地図の代わり */
  std: tilePng([236, 238, 230, 255], [214, 218, 205, 255]),
  /** 写真の代わり */
  photo: tilePng([96, 112, 92, 255], [82, 96, 80, 255]),
  /** 色別標高図の代わり（半透明） */
  relief: tilePng([120, 190, 120, 110]),
  /** 公式ハザードマップ（津波浸水想定）の代わり（半透明） */
  hazard: tilePng([80, 160, 230, 120]),
};

/** 指定緊急避難場所（津波）のタイルの代わり: 内蔵の写しを国土地理院の GeoJSON と同じ形にしたもの */
const SHELTER_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: BUILTIN_TSUNAMI_SHELTERS.map((s) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: { name: s.name, ...(s.address ? { address: s.address } : {}) },
  })),
});

/** OpenFreeMap の TileJSON の代わり（建物のベクトルタイルは空） */
const OPENFREEMAP_TILEJSON = JSON.stringify({
  tilejson: '3.0.0',
  tiles: ['https://tiles.openfreemap.org/planet/e2e-fixture/{z}/{x}/{y}.pbf'],
  minzoom: 0,
  maxzoom: 14,
});

/**
 * 国土地理院 地名検索API の応答の代わり（GeoJSON の Feature の配列。実際の API と同じ形）。
 * 検索語を名称に含むものを返す。並べ替えを確かめるため、計算範囲の外のものを先に並べている。
 * 最後の 1 件は、名称に HTML を含む（画面に文字として出ること＝HTML として解釈されないことを確かめる）。
 */
const searchFeature = (lon: number, lat: number, title: string, addressCode: string, dataSource?: string) => ({
  geometry: { coordinates: [lon, lat], type: 'Point' },
  type: 'Feature',
  properties: { addressCode, title, ...(dataSource ? { dataSource } : {}) },
});
export const SEARCH_FIXTURE = [
  searchFeature(140.035019, 42.670551, '鵠沼海岸（遠方のテスト用地名）', ''),
  searchFeature(139.5505, 35.319, '鵠沼海岸テスト（鎌倉市・計算範囲外）', '14204', '3'),
  searchFeature(139.473022, 35.315491, '神奈川県藤沢市鵠沼海岸', ''),
  searchFeature(139.471350527778, 35.3208555555556, '鵠沼海岸駅', '14205', '1'),
  searchFeature(139.469331549775, 35.3181188396594, '鵠沼海岸二丁目', '14205', '5'),
  searchFeature(139.4712, 35.3222, '<img src=x onerror="window.__xss=1">鵠沼海岸テスト施設', '14205', '3'),
];
/** 検索語「エラー」には 503 を返す（通信エラーの表示を確かめる） */
export const SEARCH_ERROR_QUERY = 'エラー';
/** 逆ジオコーダーの応答の代わり（計算範囲の中はすべて同じ町字） */
export const REVERSE_FIXTURE = { results: { muniCd: '14205', lv01Nm: '鵠沼海岸二丁目' } };

// ---------------------------------------------------------------------------
// 外部通信の横取り
// ---------------------------------------------------------------------------

/** テスト対象（開発サーバー）以外への要求 */
export const EXTERNAL_URL = /^https?:\/\/(?!(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/)/;

export interface ExternalRequest {
  url: string;
  /** fixture: 代替データを返した / missing: 404（データなしとして扱われる）/ unexpected: 想定外の宛先（404） */
  handling: 'fixture' | 'missing' | 'unexpected';
}

type Reply = { status?: number; contentType?: string; body: string | Buffer };

function replyFor(url: URL): { reply: Reply; handling: ExternalRequest['handling'] } {
  const png = (body: Buffer) => ({ reply: { contentType: 'image/png', body }, handling: 'fixture' as const });
  const host = url.hostname;
  const path = url.pathname;
  if (host === 'cyberjapandata.gsi.go.jp' || host === 'maps.gsi.go.jp') {
    if (/^\/xyz\/skhb0\d\//.test(path)) return { reply: { contentType: 'application/json', body: SHELTER_GEOJSON }, handling: 'fixture' };
    // 標高タイルはローカルミラーにあるはず。要求された場合は「データなし」とする
    if (/^\/xyz\/dem[0-9a-z]*_png\//.test(path)) return { reply: { status: 404, body: '' }, handling: 'missing' };
    if (path.startsWith('/xyz/pale/')) return png(PNG.pale);
    if (path.startsWith('/xyz/std/')) return png(PNG.std);
    if (path.startsWith('/xyz/seamlessphoto/')) return png(PNG.photo);
    if (path.startsWith('/xyz/relief/')) return png(PNG.relief);
  }
  if (host === 'disaportaldata.gsi.go.jp' && path.startsWith('/raster/')) return png(PNG.hazard);
  // 国土地理院 地名検索API・逆ジオコーダー
  if (host === 'msearch.gsi.go.jp' && path === '/address-search/AddressSearch') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (q === SEARCH_ERROR_QUERY) return { reply: { status: 503, contentType: 'text/plain', body: 'unavailable (e2e fixture)' }, handling: 'fixture' };
    const hits = q ? SEARCH_FIXTURE.filter((f) => f.properties.title.includes(q)) : [];
    return { reply: { contentType: 'application/json', body: JSON.stringify(hits) }, handling: 'fixture' };
  }
  if (host === 'mreversegeocoder.gsi.go.jp' && path === '/reverse-geocoder/LonLatToAddress') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const b = DOMAIN_BOUNDS;
    const inside = lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
    return { reply: { contentType: 'application/json', body: JSON.stringify(inside ? REVERSE_FIXTURE : {}) }, handling: 'fixture' };
  }
  if (host === 'tiles.openfreemap.org') {
    if (path.endsWith('.pbf')) return { reply: { contentType: 'application/x-protobuf', body: Buffer.alloc(0) }, handling: 'fixture' };
    return { reply: { contentType: 'application/json', body: OPENFREEMAP_TILEJSON }, handling: 'fixture' };
  }
  return { reply: { status: 404, contentType: 'text/plain', body: 'blocked by e2e (hermetic test)' }, handling: 'unexpected' };
}

/** 外部への要求をすべて代替データか 404 で応答する（context 単位。Web Worker からの要求も含む） */
export async function routeExternal(context: BrowserContext, log: ExternalRequest[]): Promise<void> {
  await context.route(EXTERNAL_URL, async (route: Route) => {
    const url = new URL(route.request().url());
    const { reply, handling } = replyFor(url);
    log.push({ url: url.href, handling });
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: reply.contentType,
      // 地図タイル・GeoJSON は CORS（mode: 'cors'）で要求される
      headers: { 'access-control-allow-origin': '*' },
      body: reply.body,
    });
  });
}

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

export interface ConsoleProblem {
  kind: 'console' | 'pageerror';
  text: string;
  url?: string;
}

interface AppFixtures {
  /** 「ご利用にあたって」を確認済みにしておくか（既定 true） */
  acknowledgeDisclaimer: boolean;
  /** 外部への要求の記録 */
  externalRequests: ExternalRequest[];
  /** コンソールのエラー・未処理の例外（横取りした外部タイルの読み込み失敗は除く） */
  consoleProblems: ConsoleProblem[];
}

export const test = base.extend<AppFixtures>({
  acknowledgeDisclaimer: [true, { option: true }],

  externalRequests: [
    async ({ context }, use) => {
      const log: ExternalRequest[] = [];
      await routeExternal(context, log);
      await use(log);
      // 代替データを用意していない宛先への要求があれば知らせる（テストがインターネットに依存しないように）
      const unexpected = [...new Set(log.filter((r) => r.handling === 'unexpected').map((r) => r.url))];
      expect(unexpected, `代替データの無い外部への要求（e2e/fixtures.ts の replyFor に追加してください）:\n${unexpected.join('\n')}`).toEqual([]);
    },
    { auto: true },
  ],

  consoleProblems: [
    async ({ page, context, acknowledgeDisclaimer }, use) => {
      if (acknowledgeDisclaimer) {
        await context.addInitScript((key) => {
          try {
            window.localStorage.setItem(key, '1');
          } catch {
            /* 保存できなくても続ける */
          }
        }, DISCLAIMER_KEY);
      }
      const problems: ConsoleProblem[] = [];
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const url = msg.location()?.url ?? '';
        // 外部サーバーへの要求は代替データで応答している。404 にした要求（想定外の宛先など）の
        // 「Failed to load resource」はここでは数えず、externalRequests で確認する
        if (/^Failed to load resource/.test(msg.text()) && EXTERNAL_URL.test(url)) return;
        problems.push({ kind: 'console', text: msg.text(), url });
      });
      page.on('pageerror', (err) => problems.push({ kind: 'pageerror', text: `${err.name}: ${err.message}` }));
      await use(problems);
    },
    { auto: true },
  ],
});

export { expect };

// ---------------------------------------------------------------------------
// 操作の補助
// ---------------------------------------------------------------------------

/** ページを開き、アプリ（window.__app）の準備を待つ */
export async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => !!window.__app?.store, null, { timeout: 60_000 });
}

/** 地形の読み込み完了を待つ（cellPx を指定した場合は、その解像度の格子になるまで） */
export async function waitForTerrain(page: Page, cellPx?: number): Promise<void> {
  await page.waitForFunction(
    (px) => {
      const t = window.__app.store.get().terrain;
      return t.status !== 'loading' && t.status !== 'idle' && (px == null || t.grid?.spec.cellPx === px);
    },
    cellPx ?? null,
    { timeout: 120_000, polling: 250 },
  );
}

/**
 * 初回の自動計算（「ご利用にあたって」の確認後、地形の準備ができると既定のシナリオを自動で計算・再生する）が
 * 動いていれば中止する。テストごとに決まった状態から操作を始めるため（CPU も空ける）。
 */
export async function stopAutoRun(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { store, actions } = window.__app;
    const sim = store.get().sim as { status: string; auto?: boolean };
    if (sim.status === 'running' && sim.auto) actions.cancelSimulation();
  });
  await page.waitForFunction(() => {
    const sim = window.__app.store.get().sim as { status: string; auto?: boolean };
    return !(sim.status === 'running' && sim.auto);
  });
}

/** ページを開き、地形の読み込みを待ち、自動計算を止めた状態にする */
export async function openReadyApp(page: Page): Promise<void> {
  await openApp(page);
  await waitForTerrain(page);
  await stopAutoRun(page);
}

/** シミュレーションの完了（または失敗）を待つ */
export async function waitForSimDone(page: Page, timeout = 240_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const st = window.__app.store.get().sim.status;
      return st === 'done' || st === 'error';
    },
    null,
    { timeout, polling: 500 },
  );
}

/** 発生したコンソールのエラーを読みやすい形に */
export function describeProblems(problems: ConsoleProblem[]): string {
  return problems.map((p) => `[${p.kind}] ${p.text}${p.url ? ` (${p.url})` : ''}`).join('\n');
}
