/**
 * 地名・住所の検索（国土地理院 地名検索API の代替データ）: 候補の並び・キーボード操作・地図の移動・人物の配置・
 * 住所の目安（逆ジオコーダーの代替データ）・該当なし／通信エラー・外部の文字列を HTML として扱わないこと。
 * スマートフォン幅では、検索パネルが画面に収まることと、地図の上の表示（HUD）がコンパクトなことを確かめる。
 */
import type { Page } from '@playwright/test';
import { SEARCH_ERROR_QUERY, describeProblems, expect, openReadyApp, test } from './fixtures';

/** 2D 地図のスタイルの読み込みを待つ */
async function waitForMap(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__map2d?.map?.isStyleLoaded(), null, { timeout: 60_000 });
}

/**
 * 地図の移動が終わったあと、指定地点が地図の見えている部分（検索パネルに隠れていない所）にあるか。
 * パネルが開いているときは、目的地がパネルに隠れないよう中心から少しずらして表示する。
 */
async function targetShown(page: Page, lon: number, lat: number): Promise<boolean> {
  return page.evaluate(
    ([x, y]) => {
      const map = window.__map2d!.map;
      if (map.isMoving()) return false;
      const p = map.project([x, y]);
      const rect = map.getCanvas().getBoundingClientRect();
      const px = rect.left + p.x;
      const py = rect.top + p.y;
      const panelEl = document.getElementById('place-panel')!;
      const pr = panelEl.getBoundingClientRect();
      const underPanel = !panelEl.hidden && px >= pr.left && px <= pr.right && py >= pr.top && py <= pr.bottom;
      return px > rect.left + 40 && px < rect.right - 40 && py > rect.top + 60 && py < rect.bottom - 40 && !underPanel;
    },
    [lon, lat] as const,
  );
}

const STATION = { title: '鵠沼海岸駅', lon: 139.471350527778, lat: 35.3208555555556 };

test('地名を検索して選ぶと、地図がその場所へ移動し、人物を置ける', async ({ page, consoleProblems, externalRequests }) => {
  await openReadyApp(page);
  await waitForMap(page);

  const searchBtn = page.getByRole('button', { name: '地名・住所で探す', exact: true });
  await searchBtn.click();
  await expect(searchBtn).toHaveAttribute('aria-expanded', 'true');
  const input = page.getByRole('combobox', { name: '地名・住所・駅名などで検索' });
  await expect(input).toBeFocused();
  // 出典の表示
  await expect(page.locator('#place-panel .place-credit')).toContainText('国土地理院 地名検索API');
  await expect(page.locator('#place-panel .place-credit')).toContainText('東大CSIS');

  // 1 文字では自動で検索しない
  await input.fill('鵠');
  await expect(page.locator('#place-panel .place-status')).toContainText('2文字以上');
  expect(externalRequests.filter((r) => r.url.includes('msearch.gsi.go.jp'))).toHaveLength(0);

  // 入力を間引いて検索（代替データ 6 件）
  await input.pressSequentially('沼海岸', { delay: 30 });
  const options = page.locator('#place-results [role="option"]');
  await expect(options).toHaveCount(6);
  await expect(page.locator('#place-panel .place-status')).toContainText('計算範囲内 4件');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  // 入力の途中（「鵠沼」「鵠沼海」など）では要求が増えすぎない
  expect(externalRequests.filter((r) => r.url.includes('msearch.gsi.go.jp')).length).toBeLessThanOrEqual(2);

  // 計算範囲の中の候補が先。外の候補は後ろ（計算範囲に近い順）で「計算範囲外」と示す
  const inside = await options.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.inside));
  expect(inside).toEqual(['true', 'true', 'true', 'true', 'false', 'false']);
  await expect(options.nth(4)).toContainText('鎌倉市・計算範囲外');
  await expect(options.nth(4).locator('.place-badge')).toContainText('計算範囲外');
  await expect(options.nth(5).locator('.place-badge')).toContainText('計算範囲外');
  await expect(options.nth(0).locator('.place-badge')).toHaveCount(0);

  // 外部の文字列は文字として表示する（HTML として解釈しない）
  await expect(options.filter({ hasText: '<img src=x onerror="window.__xss=1">鵠沼海岸テスト施設' })).toHaveCount(1);
  expect(await page.locator('#place-panel img').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();

  // キーボード: ↓ で候補を選び、Enter で決定
  const titles = await options.locator('.place-option-title').allTextContents();
  const idx = titles.indexOf(STATION.title);
  expect(idx).toBeGreaterThanOrEqual(0);
  for (let i = 0; i <= idx; i++) await input.press('ArrowDown');
  await expect(options.nth(idx)).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', (await options.nth(idx).getAttribute('id'))!);
  await input.press('Enter');

  // 地図の移動（ズーム 16）と、検索地点の目印
  await expect.poll(() => page.evaluate(() => window.__app.store.get().focus)).toMatchObject({ label: STATION.title, zoom: 16, lon: STATION.lon, lat: STATION.lat });
  await expect.poll(() => page.evaluate(() => window.__map2d!.map.getZoom()), { timeout: 20_000 }).toBeGreaterThan(15.9);
  await expect.poll(() => targetShown(page, STATION.lon, STATION.lat), { timeout: 20_000 }).toBe(true);
  const pin = page.locator('#view-2d .m2d-search');
  await expect(pin).toHaveCount(1);
  await expect(pin).toContainText(STATION.title);

  // 選んだ場所: 計算範囲の中なので「ここに人物を置く」
  const card = page.locator('#place-panel .place-card');
  await expect(card).toContainText(STATION.title);
  await expect(card).toContainText('計算範囲の中です');
  await card.locator('.kind-chip[data-kind="elderly"]').click();

  await expect.poll(() => page.evaluate(() => window.__app.store.get().people.length)).toBe(1);
  const person = await page.evaluate(() => window.__app.store.get().people[0]);
  expect(person.kind).toBe('elderly');
  expect(person.lon).toBeCloseTo(STATION.lon, 9);
  expect(person.lat).toBeCloseTo(STATION.lat, 9);
  await expect(card.locator('.place-placed')).toContainText(`「${person.name}」を置きました`);
  // 置いた人物のマーカーと重なる目印は消える
  await expect(pin).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.store.get().focus)).toBeNull();

  // 広い画面では人物タブが開き、住所の目安（逆ジオコーダー）が出る
  await expect(page.locator('#panel-people')).toBeVisible();
  const address = page.locator('#panel-people .person-address');
  await expect(address).toContainText('藤沢市鵠沼海岸二丁目付近');
  await expect(address).toContainText('国土地理院 逆ジオコーダー');
  await expect(page.locator('#panel-people .person-row .person-sub-addr')).toHaveText('藤沢市鵠沼海岸二丁目付近');
  const reverse = externalRequests.filter((r) => r.url.includes('mreversegeocoder.gsi.go.jp'));
  expect(reverse.length).toBeGreaterThanOrEqual(1);
  expect(reverse[0].url).toContain(`lat=${STATION.lat.toFixed(5)}`);

  // 計算範囲の外の候補: 地図は移動するが、人物は置けない
  await card.getByRole('button', { name: '検索結果に戻る' }).click();
  await expect(options).toHaveCount(6);
  await options.filter({ hasText: '鎌倉市・計算範囲外' }).click();
  await expect(card).toContainText('計算範囲（破線の枠）の外です');
  await expect(card.locator('.kind-chip')).toHaveCount(0);
  await expect(pin).toContainText('鎌倉市・計算範囲外');
  await expect.poll(() => targetShown(page, 139.5505, 35.319), { timeout: 20_000 }).toBe(true);

  // 地図の表示範囲の外（遠方）の候補: 地図は動かさない
  const seqBefore = await page.evaluate(() => window.__app.store.get().focus?.seq ?? 0);
  await card.getByRole('button', { name: '検索結果に戻る' }).click();
  await options.filter({ hasText: '遠方のテスト用地名' }).click();
  await expect(card).toContainText('地図の表示範囲の外です');
  expect(await page.evaluate(() => window.__app.store.get().focus?.seq ?? 0)).toBe(seqBefore);

  // 目印の × で消せる
  await pin.getByRole('button', { name: '目印を消す' }).click();
  await expect(pin).toHaveCount(0);

  // Esc でパネルを閉じ、ボタンにフォーカスが戻る
  await input.focus();
  await input.press('Escape');
  await expect(page.locator('#place-panel')).toBeHidden();
  await expect(searchBtn).toBeFocused();
  await expect(searchBtn).toHaveAttribute('aria-expanded', 'false');

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});

test('該当なし・通信エラーを表示し、再試行できる', async ({ page, consoleProblems }) => {
  await openReadyApp(page);
  await page.getByRole('button', { name: '地名・住所で探す', exact: true }).click();
  const input = page.getByRole('combobox', { name: '地名・住所・駅名などで検索' });
  const status = page.locator('#place-panel .place-status');

  await input.fill('該当なしの地名');
  await expect(status).toContainText('見つかりませんでした');
  await expect(page.locator('#place-results')).toBeHidden();

  await input.fill(SEARCH_ERROR_QUERY);
  await input.press('Enter');
  await expect(status).toContainText('検索できませんでした');
  const retry = status.getByRole('button', { name: '再試行' });
  await expect(retry).toBeVisible();
  await input.fill('鵠沼海岸駅');
  await expect(page.locator('#place-results [role="option"]')).toHaveCount(1);
  await expect(retry).toBeHidden();

  // 人物タブの入口からも開ける
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('tab', { name: '人物' }).click();
  await page.getByRole('button', { name: '地名・住所で探して置く' }).click();
  await expect(page.locator('#place-panel')).toBeVisible();
  await expect(input).toBeFocused();

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});

test.describe('スマートフォン幅', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('地図の上の表示（HUD）はコンパクトで、検索パネルが画面に収まる', async ({ page, consoleProblems }) => {
    await openReadyApp(page);
    await waitForMap(page);

    // 警報が出る時刻（気象庁の発表目標の約3分より後）へ
    await page.evaluate(() => window.__app.actions.seek(600));
    const warn = page.locator('#hud .hud-warn');
    await expect(warn).toBeVisible();
    await expect(warn).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#hud .hud-time-value')).toHaveText('10分00秒');

    // 左上の表示（経過時間・警報）の高さが小さい
    const tl = (await page.locator('#hud .hud-tl').boundingBox())!;
    expect(tl.height).toBeLessThan(110);
    const warnBox = (await warn.boundingBox())!;
    expect(warnBox.height).toBeLessThan(44);
    // 右上の地図の操作部品と重ならない
    const tools = (await page.locator('#hud .maptools').boundingBox())!;
    const zoom = (await page.locator('#view-2d .maplibregl-ctrl-top-right').boundingBox())!;
    expect(tl.x + tl.width).toBeLessThanOrEqual(Math.min(tools.x, zoom.x));

    // 警報のチップはタップで詳細（とるべき行動・発表の目安・発表基準）を開く
    await expect(warn.locator('.hud-warn-action')).toBeHidden();
    await warn.tap();
    await expect(warn).toHaveAttribute('aria-expanded', 'true');
    await expect(warn.locator('.hud-warn-action')).toBeVisible();
    await expect(warn.locator('.hud-warn-note')).toContainText('発表基準');
    await warn.tap();
    await expect(warn.locator('.hud-warn-action')).toBeHidden();

    // 人物タブの入口から検索 → シートが閉じ、パネルは画面の幅に収まる
    await page.getByRole('tab', { name: '人物' }).tap();
    await page.getByRole('button', { name: '地名・住所で探して置く' }).tap();
    await expect(page.locator('#sidebar')).toHaveAttribute('data-sheet', 'closed');
    const panel = page.locator('#place-panel');
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);

    await page.getByRole('combobox', { name: '地名・住所・駅名などで検索' }).fill('鵠沼海岸駅');
    await page.locator('#place-results [role="option"]').first().tap();
    const chip = page.locator('#place-panel .kind-chip[data-kind="adult"]');
    await expect(chip).toBeVisible();
    await chip.tap();
    await expect.poll(() => page.evaluate(() => window.__app.store.get().people.length)).toBe(1);
    // スマートフォンではシートを自動で開かず、ボタンで人物タブを開ける
    await expect(page.locator('#sidebar')).toHaveAttribute('data-sheet', 'closed');
    await page.getByRole('button', { name: '人物タブを開く' }).tap();
    await expect(page.locator('#sidebar')).toHaveAttribute('data-sheet', 'open');
    await expect(page.locator('#panel-people')).toBeVisible();

    const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    expect(o.doc).toBeLessThanOrEqual(o.width);

    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});
