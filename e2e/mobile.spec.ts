/**
 * スマートフォン幅（390×844）: 横スクロールが出ない・ボトムシートが開閉できる。
 */
import type { Page } from '@playwright/test';
import { describeProblems, expect, openReadyApp, test } from './fixtures';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

/** ページ全体に横方向のはみ出しが無いか */
async function horizontalOverflow(page: Page): Promise<{ doc: number; body: number; width: number }> {
  return page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    width: document.documentElement.clientWidth,
  }));
}

test('スマートフォン幅で横スクロールが無く、ボトムシートが開閉できる', async ({ page, consoleProblems }) => {
  await openReadyApp(page);

  let o = await horizontalOverflow(page);
  expect(o.width).toBe(390);
  expect(o.doc).toBeLessThanOrEqual(o.width);
  expect(o.body).toBeLessThanOrEqual(o.width);

  const sidebar = page.locator('#sidebar');
  await expect(sidebar).toHaveAttribute('data-sheet', 'closed');
  await expect(page.locator('#sidebar .sheet')).toBeHidden();

  // タブバーは画面の下端にある
  const tabs = page.getByRole('tablist', { name: '操作パネル' });
  const tabsBox = (await tabs.boundingBox())!;
  expect(tabsBox.y + tabsBox.height).toBeGreaterThan(844 - 120);
  expect(tabsBox.width).toBeLessThanOrEqual(390);

  // 「地震・津波」タブ → シートが開く
  await page.getByRole('tab', { name: '地震・津波' }).tap();
  await expect(sidebar).toHaveAttribute('data-sheet', 'open');
  const sheet = page.locator('#sidebar .sheet');
  await expect(sheet).toBeVisible();
  await expect(page.locator('#panel-quake')).toBeVisible();
  await expect(page.locator('#sidebar .sheet-title')).toHaveText('地震・津波');
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390 + 0.5);
  expect(box.height).toBeGreaterThan(200);

  // シートの中の操作（震度ボタン）が使える
  await page.getByRole('button', { name: '震度6強', exact: true }).tap();
  expect(await page.evaluate(() => window.__app.store.get().scenarioId)).toBe('taisho');

  o = await horizontalOverflow(page);
  expect(o.doc).toBeLessThanOrEqual(o.width);
  expect(o.body).toBeLessThanOrEqual(o.width);

  // 別のタブへ切り替え
  await page.getByRole('tab', { name: '人物' }).tap();
  await expect(page.locator('#sidebar .sheet-title')).toHaveText('人物');
  await expect(page.locator('#panel-people')).toBeVisible();

  // 閉じる
  await page.getByRole('button', { name: 'パネルを閉じる' }).tap();
  await expect(sidebar).toHaveAttribute('data-sheet', 'closed');
  await expect(sheet).toBeHidden();

  // 3D に切り替えても横スクロールは出ない
  await page.getByRole('button', { name: '3D で表示' }).tap();
  await expect(page.locator('#view-3d canvas').first()).toBeVisible();
  o = await horizontalOverflow(page);
  expect(o.doc).toBeLessThanOrEqual(o.width);
  await page.getByRole('button', { name: '2D 地図で表示' }).tap();

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});
