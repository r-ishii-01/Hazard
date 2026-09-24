/**
 * 2D / 3D の切り替え: 3D（three.js）の WebGL キャンバスが作られて描画され、2D に戻せる。
 */
import { describeProblems, expect, openReadyApp, test } from './fixtures';

test('3D 表示に切り替えると WebGL のキャンバスが描画され、2D に戻せる', async ({ page, consoleProblems }) => {
  await openReadyApp(page);

  const btn3d = page.getByRole('button', { name: '3D で表示' });
  const btn2d = page.getByRole('button', { name: '2D 地図で表示' });
  await expect(btn2d).toHaveAttribute('aria-pressed', 'true');

  await btn3d.click();
  await expect(btn3d).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__app.store.get().view)).toBe('3d');
  await expect(page.locator('body')).toHaveAttribute('data-view', '3d');

  const canvas = page.locator('#view-3d canvas').first();
  await expect(canvas).toBeVisible();
  await expect(page.locator('#view-2d')).toBeHidden();

  // WebGL が使え、実際に描画が行われている（地形のメッシュが描かれる）
  type Info = { active: boolean; webgl: boolean; calls: number; triangles: number; viewport: [number, number] };
  // three.js は 3D に初めて切り替えたときに読み込まれる（読み込み前は null）
  const info = () => page.evaluate(() => (document.getElementById('view-3d')?.__view3d?.debugInfo() ?? null) as Info | null);
  await expect.poll(async () => (await info())?.webgl ?? null, { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await info())?.calls ?? 0, { timeout: 90_000 }).toBeGreaterThan(0);
  const drawn = (await info())!;
  expect(drawn.active).toBe(true);
  expect(drawn.triangles).toBeGreaterThan(1000);
  expect(drawn.viewport[0]).toBeGreaterThan(100);
  expect(drawn.viewport[1]).toBeGreaterThan(100);
  const size = await canvas.boundingBox();
  expect(size!.width).toBeGreaterThan(100);
  expect(size!.height).toBeGreaterThan(100);

  // 2D に戻す
  await btn2d.click();
  expect(await page.evaluate(() => window.__app.store.get().view)).toBe('2d');
  await expect(page.locator('#view-2d')).toBeVisible();
  await expect(page.locator('#view-3d')).toBeHidden();
  expect((await info())?.active).toBe(false);
  await expect(page.locator('#view-2d canvas.maplibregl-canvas')).toBeVisible();

  // もう一度 3D に（同じキャンバスを再利用する）
  await btn3d.click();
  await expect(canvas).toBeVisible();
  expect((await info())?.active).toBe(true);
  expect(await page.locator('#view-3d canvas').count()).toBe(1);
  await btn2d.click();

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});
