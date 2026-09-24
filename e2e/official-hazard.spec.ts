/**
 * 公式の津波浸水想定（神奈川県）と人物の評価・公式ハザードマップの表示・避難場所データの注意。
 *
 * - 鵠沼海岸駅の人の「最寄りの高台」は、計算では浸水しなくても、公式の浸水想定区域（と周囲 30 m）には導かない。
 *   出発地点・避難先が公式の想定で何mの区域かを示し、公式の区域から出発する人を緑（安全）の判定にしない。
 * - 公式の浸水想定・公式ハザードマップのタイルを読み込めないときは、はっきり示す（高台の名前に「未確認」、
 *   レイヤーのタブと凡例に「読み込めません」）。読み込めるようになれば再試行で戻る。
 * - 指定緊急避難場所データの利用上の注意と、藤沢市の津波避難ビルが含まれないこと（市の一覧へのリンク）を示す。
 *
 * 公式の浸水想定はサイト内のミラー（public/tiles/hazard-tsunami）から読む（ネットワークに接続しない）。
 * 計算を短くするため、解像度「粗い」・計算時間 30 分（最大波の到達 8 分 + 周期 20 分を含む）で実行する。
 */
import type { Page } from '@playwright/test';
import { describeProblems, expect, openReadyApp, test, waitForSimDone, waitForTerrain } from './fixtures';

/** 鵠沼海岸駅（レビューで「計算だけの高台」が公式の浸水想定区域の中になった地点） */
const STATION = { lon: 139.47127, lat: 35.32071 };

/** ページ内: 地点の公式の階級コード（0 = 区域外、1〜8 = 階級、255 = 不明、null = 範囲外 / 未読み込み） */
async function officialCodeAt(page: Page, lon: number, lat: number): Promise<number | null> {
  return page.evaluate(
    ([lon, lat]) => {
      const d = window.__app.store.get().officialInundation.data;
      if (!d) return null;
      const ws = 256 * 2 ** d.zoom;
      const s = Math.sin((lat * Math.PI) / 180);
      const px = Math.floor(((lon + 180) / 360) * ws - d.originPx);
      const py = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws - d.originPy);
      if (px < 0 || py < 0 || px >= d.width || py >= d.height) return null;
      return d.codes[py * d.width + px];
    },
    [lon, lat] as const,
  );
}

/** ページ内: 地点のまわり radiusM の画素に公式の浸水想定区域（または不明）があるか */
async function officialZoneWithin(page: Page, lon: number, lat: number, radiusM: number): Promise<boolean> {
  return page.evaluate(
    ([lon, lat, radiusM]) => {
      const d = window.__app.store.get().officialInundation.data!;
      const ws = 256 * 2 ** d.zoom;
      const s = Math.sin((lat * Math.PI) / 180);
      const px = Math.floor(((lon + 180) / 360) * ws - d.originPx);
      const py = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws - d.originPy);
      const mpp = (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / ws;
      const r = Math.ceil(radiusM / mpp);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= d.width || y >= d.height) continue;
          if (d.codes[y * d.width + x] !== 0) return true;
        }
      }
      return false;
    },
    [lon, lat, radiusM] as const,
  );
}

/** 人物の詳細の行（dt → dd のテキスト） */
async function planRows(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const dts = document.querySelectorAll('#panel-people .plan-dl dt');
    dts.forEach((dt) => {
      out[dt.textContent ?? ''] = (dt.nextElementSibling?.textContent ?? '').trim();
    });
    return out;
  });
}

async function addStationPerson(page: Page, evacMode: 'highground' | 'stay' | 'shelter'): Promise<string> {
  const id = await page.evaluate(
    ([lon, lat, mode]) => {
      const { actions } = window.__app;
      const p = actions.addPerson('adult', lon, lat);
      actions.updatePerson(p.id, { evacMode: mode });
      return p.id;
    },
    [STATION.lon, STATION.lat, evacMode] as const,
  );
  await page.waitForFunction(
    ([pid, mode]) => {
      const s = window.__app.store.get();
      const plan = s.plans[pid];
      return !!plan && (mode === 'stay' ? plan.target === null : plan.target !== null);
    },
    [id, evacMode] as const,
    { timeout: 30_000 },
  );
  return id;
}

test('鵠沼海岸駅の人の「最寄りの高台」は公式の浸水想定区域の外。出発地点の公式の区分を示し、緑の判定にしない', async ({ page, consoleProblems }) => {
  await openReadyApp(page);
  await page.waitForFunction(() => window.__app.store.get().officialInundation.status === 'ready', null, { timeout: 60_000 });
  const official = await page.evaluate(() => {
    const d = window.__app.store.get().officialInundation.data!;
    return { fromMirror: d.fromMirror, fromRemote: d.fromRemote, failed: d.failed, missing: d.missing };
  });
  // ミラーから読む（配信元には接続しない）
  expect(official).toEqual({ fromMirror: 17, fromRemote: 0, failed: 0, missing: 31 });
  // 鵠沼海岸駅は公式の想定で 1〜3m の区域
  expect(await officialCodeAt(page, STATION.lon, STATION.lat)).toBe(4);

  await page.evaluate(() => window.__app.actions.selectShindo('7'));
  await page.evaluate(() => window.__app.actions.updateParams({ resolution: 'coarse', durationMin: 30 }));
  await waitForTerrain(page, 8);
  await page.evaluate(() => window.__app.actions.runSimulation());
  await waitForSimDone(page);
  expect(await page.evaluate(() => window.__app.store.get().sim.status)).toBe('done');

  const id = await addStationPerson(page, 'highground');
  // 計算結果（完了）を使った計画になるまで待つ
  await page.waitForFunction((pid) => /計算でも浸水なし|計算で浸水しなかった|近くで最も高い地点/.test(window.__app.store.get().plans[pid]?.target?.name ?? ''), id);
  const plan = await page.evaluate((pid) => window.__app.store.get().plans[pid], id);
  expect(plan.target!.kind).toBe('highground');
  expect(plan.target!.name).toContain('最寄りの高台（公式の浸水想定区域の外・計算でも浸水なし');
  expect(plan.target!.name).not.toContain('未確認');
  // 避難先は公式の浸水想定区域の外で、区域から 30 m 以内に入らない（セルの中心から、セルの半分の対角 + 30 m）
  expect(await officialCodeAt(page, plan.target!.lon, plan.target!.lat)).toBe(0);
  expect(await officialZoneWithin(page, plan.target!.lon, plan.target!.lat, 30)).toBe(false);

  // 人物の詳細: 出発地点・避難先の公式の区分
  await page.getByRole('tab', { name: '人物' }).click();
  await page.evaluate((pid) => window.__app.actions.selectPerson(pid), id);
  const detail = page.locator('#panel-people .person-detail');
  await expect(detail).toBeVisible();
  await expect.poll(() => planRows(page)).toMatchObject({
    '出発地点（公式）': '公式の津波浸水想定（神奈川県）では浸水深1〜3mの区域',
    '避難先（公式）': '公式の津波浸水想定（神奈川県）では浸水想定区域の外',
  });
  const rows = await planRows(page);
  expect(rows['避難先']).toContain('公式の浸水想定区域の外');
  // 公式の区域から出発する人は、計算で間に合っても緑（ok）の判定にしない
  const verdict = detail.locator('.plan-verdict');
  await expect(verdict).toBeVisible();
  expect(await verdict.getAttribute('data-tone')).not.toBe('ok');
  const verdictText = (await verdict.textContent()) ?? '';
  if ((await verdict.getAttribute('data-tone')) === 'warn' && verdictText.startsWith('この計算では')) {
    expect(verdictText).toContain('ただし、公式の津波浸水想定（神奈川県）では、出発地点は浸水深1〜3mの区域です。');
    expect(verdictText).toContain('避難には公式のハザードマップを使ってください');
  }
  await expect(detail.locator('.plan-notes')).toContainText('このサイトの計算は、公式の津波浸水想定（神奈川県）より浸水が狭く、浅めに出ます');
  await expect(detail.locator('.plan-note-source')).toContainText('「ハザードマップポータルサイト」（津波浸水想定：神奈川県）を加工して作成');

  // その場にとどまる: 計算で浸水しなくても「浸水しない」と言い切らず、公式の区分を示す
  await page.evaluate((pid) => window.__app.actions.updatePerson(pid, { evacMode: 'stay' }), id);
  await expect.poll(async () => (await planRows(page))['この地点（公式）']).toBe('公式の津波浸水想定（神奈川県）では浸水深1〜3mの区域');
  const stayRows = await planRows(page);
  expect(stayRows['この地点の浸水']).not.toMatch(/^浸水しない/);
  expect(await verdict.getAttribute('data-tone')).not.toBe('ok');

  // 最寄りの避難場所へ: 避難場所データの注意（津波避難ビルが含まれないこと・市の一覧へのリンク）
  await page.evaluate((pid) => window.__app.actions.updatePerson(pid, { evacMode: 'shelter' }), id);
  const shelterNote = detail.locator('.plan-note-shelter');
  await expect(shelterNote).toBeVisible();
  await expect(shelterNote).toContainText('藤沢市が独自に指定している津波避難ビルの多くは、このデータに含まれていません');
  await expect(shelterNote.getByRole('link', { name: '藤沢市「津波避難ビル」一覧' })).toHaveAttribute(
    'href',
    'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/bosai/tunamihinanbiruichiran.html',
  );
  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});

test('公式の浸水想定・公式ハザードマップを読み込めないときははっきり示し、再試行で戻る', async ({ page, consoleProblems }) => {
  // ミラーの一覧から津波浸水想定を除き、配信元にも接続できない状態にする
  await page.route('**/tiles/manifest.json', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { tiles: Record<string, number> };
    for (const k of Object.keys(json.tiles)) if (k.startsWith('hazard-tsunami/')) delete json.tiles[k];
    await route.fulfill({ response: res, json });
  });
  await page.route(/^https:\/\/disaportaldata\.gsi\.go\.jp\//, (route) => route.abort('internetdisconnected'));

  await openReadyApp(page);
  await page.waitForFunction(() => window.__app.store.get().officialInundation.status === 'error', null, { timeout: 60_000 });

  // 最寄りの高台: 公式の区域の外か確かめられないことを名前に示す
  const id = await addStationPerson(page, 'highground');
  const name = await page.evaluate((pid) => window.__app.store.get().plans[pid].target!.name, id);
  expect(name).toContain('公式の津波浸水想定を読み込めなかったため、公式の浸水想定区域の外かは未確認');
  await page.getByRole('tab', { name: '人物' }).click();
  await page.evaluate((pid) => window.__app.actions.selectPerson(pid), id);
  await expect.poll(async () => (await planRows(page))['出発地点（公式）']).toContain('公式の津波浸水想定を読み込めませんでした');

  // 公式ハザードマップを表示: 配信元に接続できないことをレイヤーのタブと凡例に示す（色の凡例だけを出さない）
  await page.getByRole('tab', { name: 'レイヤー' }).click();
  await page.evaluate(() => window.__app.actions.setLayer('officialHazard', true));
  await page.waitForFunction(() => window.__app.store.get().officialInundation.display === 'error', null, { timeout: 30_000 });
  const status = page.locator('#panel-layers .hazard-status-display');
  await expect(status).toBeVisible();
  await expect(status).toContainText('公式ハザードマップ（津波浸水想定）を読み込めません。');
  await expect(status).toContainText('色が付いていない場所も浸水想定区域の可能性があります');
  // 色の凡例だけを出さない
  await expect(page.locator('#panel-layers .switch-extra').filter({ has: status }).locator('.legend-block')).toBeHidden();
  const dataStatus = page.locator('#panel-layers .hazard-status-data');
  await expect(dataStatus).toBeVisible();
  await expect(dataStatus).toContainText('人物の評価に使う公式の津波浸水想定を読み込めませんでした');
  const legendWarn = page.locator('.hud-legend .hud-legend-warn');
  await expect(legendWarn).toBeVisible();
  await expect(page.locator('.hud-legend .hud-legend-sub').last()).toHaveText('表示できていません');

  // 接続できるようになったら再試行で戻る
  await page.unroute('**/tiles/manifest.json');
  await page.unroute(/^https:\/\/disaportaldata\.gsi\.go\.jp\//);
  await status.getByRole('button', { name: '再試行' }).click();
  await page.waitForFunction(
    () => {
      const o = window.__app.store.get().officialInundation;
      return o.status === 'ready' && o.display === 'ok';
    },
    null,
    { timeout: 60_000 },
  );
  await expect(status).toBeHidden();
  await expect(dataStatus).toBeHidden();
  await expect(legendWarn).toBeHidden();
  await page.waitForFunction((pid) => !/未確認/.test(window.__app.store.get().plans[pid]?.target?.name ?? '未確認'), id);
  const after = await page.evaluate((pid) => window.__app.store.get().plans[pid].target!, id);
  expect(after.name).toContain('公式の浸水想定区域の外');
  expect(await officialCodeAt(page, after.lon, after.lat)).toBe(0);
  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});

test('避難場所データの利用上の注意と、藤沢市の津波避難ビルが含まれないことを示す。計算が公式より狭く浅いことも示す', async ({ page, consoleProblems }) => {
  await openReadyApp(page);
  const cityUrl = 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/bosai/tunamihinanbiruichiran.html';
  for (const [tab, id] of [
    ['レイヤー', 'layers'],
    ['人物', 'people'],
    ['情報', 'info'],
  ] as const) {
    await page.getByRole('tab', { name: tab }).click();
    const info = page.locator(`#panel-${id} .shelters-info`).first();
    await expect(info).toBeVisible();
    await expect(info).toContainText('避難生活のための「指定避難所」とは別のもの');
    await expect(info).toContainText('最新でない場合や掲載されていない場合があります。最新の情報は藤沢市で確認してください。');
    await expect(info).toContainText('藤沢市が独自に指定している津波避難ビルの多くは、このデータに含まれていません');
    await expect(info.getByRole('link', { name: '藤沢市「津波避難ビル」一覧' })).toHaveAttribute('href', cityUrl);
  }
  // 情報タブ: 公式の想定との違いは重ね合わせだけではない
  const infoPanel = page.locator('#panel-info');
  await expect(infoPanel).toContainText('同じ相模トラフ沿いの海溝型地震（西側モデル）の県の予測図と比べても、このサイトの計算は浸水域が1〜2割狭く、浸水深も浅めです。');
  await expect(infoPanel).not.toContainText('1つのシナリオだけを計算した結果より広く・深くなるのがふつうです');
  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});
