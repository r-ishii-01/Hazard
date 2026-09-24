/**
 * 現在地（Geolocation API）: 計算範囲の中・外、許可されていない場合。
 * 現在地はこの端末の中だけで使い、外部へ送らない（逆ジオコーダーにも渡さない）ことも確かめる。
 */
import type { Page } from '@playwright/test';
import { INITIAL_CENTER } from '../src/core/geo';
import { describeProblems, expect, openReadyApp, test, type ExternalRequest } from './fixtures';

const PRIVACY = '現在地はこの端末内でのみ使用し、外部には送信しません。';

async function waitForMap(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__map2d?.map?.isStyleLoaded(), null, { timeout: 60_000 });
}

/** 外部への要求に現在地の座標（小数 3 桁まで）が含まれていないか */
function leaked(requests: ExternalRequest[], lon: number, lat: number): string[] {
  const keys = [lon.toFixed(3), lat.toFixed(3)];
  return requests.map((r) => decodeURIComponent(r.url)).filter((u) => keys.some((k) => u.includes(k)));
}

test.describe('計算範囲の中', () => {
  const HERE = { latitude: 35.3187, longitude: 139.4702, accuracy: 25 };
  test.use({ geolocation: HERE, permissions: ['geolocation'] });

  test('現在地を表示し、「現在地の人」を置ける（座標は外部に送らない）', async ({ page, consoleProblems, externalRequests }) => {
    await openReadyApp(page);
    await waitForMap(page);
    // 位置情報はボタンを押すまで取得しない
    expect(await page.evaluate(() => window.__app.store.get().userLocation)).toBeNull();

    const btn = page.getByRole('button', { name: '現在地', exact: true });
    await btn.click();
    await expect
      .poll(() => page.evaluate(() => window.__app.store.get().userLocation))
      .toMatchObject({ lon: HERE.longitude, lat: HERE.latitude, accuracyM: HERE.accuracy, insideDomain: true });
    const panel = page.locator('#place-panel');
    await expect(panel).toContainText('現在地は計算範囲の中です');
    await expect(panel).toContainText('誤差 約 25 m');
    await expect(panel).toContainText(PRIVACY);

    // 地図: 現在地へ移動し、点と精度の円を出す
    await expect.poll(() => page.evaluate(() => window.__app.store.get().focus)).toMatchObject({ lon: HERE.longitude, lat: HERE.latitude, zoom: 16 });
    await expect(page.locator('#view-2d .m2d-userloc')).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const src = window.__map2d!.map.getSource('m2d-userloc') as unknown as { getData(): Promise<{ features: { geometry: { type: string } }[] }> };
          const data = await src.getData();
          return data.features.map((f) => f.geometry.type);
        }),
      )
      .toEqual(['Polygon']);

    // 「ここに人物を置く」→ 名前は「現在地の人」
    await panel.locator('.kind-chip[data-kind="adult"]').click();
    await expect.poll(() => page.evaluate(() => window.__app.store.get().people.length)).toBe(1);
    const person = await page.evaluate(() => window.__app.store.get().people[0]);
    expect(person.name).toBe('現在地の人');
    expect(person.lon).toBeCloseTo(HERE.longitude, 9);
    expect(person.lat).toBeCloseTo(HERE.latitude, 9);
    await expect(panel.locator('.place-placed')).toContainText('「現在地の人」を置きました');
    await expect(page.locator('#panel-people .person-address')).toContainText('現在地から置いた人物（住所は調べていません）');

    // 2 人目は番号付き
    await panel.locator('.kind-chip[data-kind="child"]').click();
    await expect.poll(() => page.evaluate(() => window.__app.store.get().people.map((p) => p.name))).toEqual(['現在地の人', '現在地の人 2']);

    // 住所の問い合わせ（逆ジオコーダー）をしない・どの要求にも座標が入らない
    await page.waitForTimeout(1200);
    expect(externalRequests.filter((r) => r.url.includes('mreversegeocoder'))).toEqual([]);
    expect(leaked(externalRequests, HERE.longitude, HERE.latitude)).toEqual([]);

    // 表示を消す
    await panel.getByRole('button', { name: '現在地の表示を消す' }).click();
    await expect.poll(() => page.evaluate(() => window.__app.store.get().userLocation)).toBeNull();
    await expect(page.locator('#view-2d .m2d-userloc')).toHaveCount(0);
    await expect(panel).toBeHidden();

    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});

test.describe('計算範囲の外', () => {
  // 東京駅付近
  const TOKYO = { latitude: 35.681, longitude: 139.767, accuracy: 30 };
  test.use({ geolocation: TOKYO, permissions: ['geolocation'] });

  test('計算範囲の外であることを説明し、計算範囲を表示する', async ({ page, consoleProblems, externalRequests }) => {
    await openReadyApp(page);
    await waitForMap(page);

    await page.getByRole('button', { name: '現在地', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__app.store.get().userLocation?.insideDomain)).toBe(false);
    const panel = page.locator('#place-panel');
    await expect(panel).toContainText('現在地は計算範囲の外です');
    await expect(panel).toContainText('計算範囲に戻しました');
    await expect(panel).toContainText(PRIVACY);
    await expect(panel.locator('.kind-chip')).toHaveCount(0);

    // 地図は計算範囲（初期表示の中心）へ
    const focus = await page.evaluate(() => window.__app.store.get().focus);
    expect(focus?.lon).toBeCloseTo(INITIAL_CENTER.lon, 6);
    expect(focus?.lat).toBeCloseTo(INITIAL_CENTER.lat, 6);
    expect(focus?.label).toBeUndefined();

    // 「地名・住所で探す」へ切り替えられる
    await panel.getByRole('button', { name: '地名・住所で探す' }).click();
    await expect(page.getByRole('combobox', { name: '地名・住所・駅名などで検索' })).toBeFocused();

    expect(leaked(externalRequests, TOKYO.longitude, TOKYO.latitude)).toEqual([]);
    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});

test.describe('位置情報が許可されていない', () => {
  test('許可されていないことを日本語で説明する', async ({ page, context, consoleProblems }) => {
    await context.clearPermissions();
    await openReadyApp(page);

    await page.getByRole('button', { name: '現在地', exact: true }).click();
    const panel = page.locator('#place-panel');
    await expect(panel.locator('.loc-status')).toContainText('位置情報の利用が許可されていません', { timeout: 20_000 });
    await expect(panel.locator('.loc-status')).toContainText('ブラウザや端末の設定');
    await expect(panel.getByRole('button', { name: 'もう一度試す' })).toBeVisible();
    await expect(panel).toContainText(PRIVACY);
    expect(await page.evaluate(() => window.__app.store.get().userLocation)).toBeNull();

    // 人物タブからも同じ説明になる
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await page.getByRole('tab', { name: '人物' }).click();
    await expect(page.locator('#panel-people')).toContainText(PRIVACY);
    await page.getByRole('button', { name: '現在地に置く' }).click();
    await expect(panel.locator('.loc-status')).toContainText('位置情報の利用が許可されていません', { timeout: 20_000 });

    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});
