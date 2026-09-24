/**
 * 3D 表示: 視点移動の要求（store.focus）で注視点が移ること、現在地（store.userLocation）の目印、
 * 人物の見やすさ倍率の上限（×25）と注記。
 */
import type { Page } from '@playwright/test';
import { lonLatToLocalMeters, type GridSpec } from '../src/core/geo';
import { describeProblems, expect, openReadyApp, test } from './fixtures';

interface Info {
  webgl: boolean;
  active: boolean;
  calls: number;
  scale: number;
  animating: boolean;
  focusSeq: number | null;
  markers: boolean;
  camera: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number } | null;
}

const info = (page: Page) => page.evaluate(() => (document.getElementById('view-3d')?.__view3d?.debugInfo() ?? null) as Info | null);

/** 注視点と目標地点の水平距離 [m]（アニメーション中は null） */
async function targetOffset(page: Page, spec: GridSpec, lon: number, lat: number): Promise<number | null> {
  const i = await info(page);
  if (!i?.target || i.animating) return null;
  const q = lonLatToLocalMeters(spec, lon, lat);
  return Math.hypot(i.target.x - q.x, i.target.z - q.z);
}

test('3D: 視点移動の要求で注視点が移り、現在地の目印を出せる', async ({ page, consoleProblems }) => {
  await openReadyApp(page);
  const spec = await page.evaluate(() => window.__app.store.get().terrain.grid!.spec);

  // 2D 表示中に要求された視点移動は、3D を開いたときに反映する
  const station = { lon: 139.4745, lat: 35.3175 };
  await page.evaluate((p) => window.__app.actions.focusOn(p.lon, p.lat, { zoom: 16, label: '鵠沼海岸駅' }), station);
  await page.getByRole('button', { name: '3D で表示' }).click();
  await expect.poll(async () => (await info(page))?.calls ?? 0, { timeout: 90_000 }).toBeGreaterThan(0);
  await expect.poll(() => targetOffset(page, spec, station.lon, station.lat), { timeout: 30_000 }).toBeLessThan(1);
  let i = (await info(page))!;
  expect(i.focusSeq).toBe(await page.evaluate(() => window.__app.store.get().focus!.seq));
  // ズーム 16 に相当する距離（数百 m〜数 km）まで近づく
  const dist = Math.hypot(i.camera.x - i.target!.x, i.camera.y - i.target!.y, i.camera.z - i.target!.z);
  expect(dist).toBeGreaterThan(300);
  expect(dist).toBeLessThan(3000);

  // 3D 表示中の視点移動（ズームの指定なし → 距離はそのまま）
  const enoshima = { lon: 139.4805, lat: 35.2995 };
  await page.evaluate((p) => window.__app.actions.focusOn(p.lon, p.lat, { label: '江の島' }), enoshima);
  await expect.poll(() => targetOffset(page, spec, enoshima.lon, enoshima.lat), { timeout: 30_000 }).toBeLessThan(1);
  i = (await info(page))!;
  expect(Math.hypot(i.camera.x - i.target!.x, i.camera.y - i.target!.y, i.camera.z - i.target!.z)).toBeCloseTo(dist, -1);
  expect(i.markers).toBe(true);

  // 現在地の目印
  await page.evaluate(() => window.__app.actions.setUserLocation({ lon: 139.4702, lat: 35.3187, accuracyM: 40, timestamp: Date.now(), insideDomain: true }));
  await expect.poll(async () => (await info(page))?.markers).toBe(true);
  // 現在地と目的地のピンを消すと、目印は無くなる
  await page.evaluate(() => {
    window.__app.actions.setUserLocation(null);
    window.__app.actions.clearFocus();
  });
  await expect.poll(async () => (await info(page))?.markers).toBe(false);

  // 最初の視点では、人物の見やすさ倍率は上限（×25）までで、注記にその倍率を示す
  await page.locator('#view-3d .v3d-tools button', { hasText: '視点をリセット' }).click();
  await expect.poll(async () => (await info(page))?.animating, { timeout: 10_000 }).toBe(false);
  i = (await info(page))!;
  expect(i.scale).toBeGreaterThan(1);
  expect(i.scale).toBeLessThanOrEqual(25);
  const note = (await page.locator('#view-3d .v3d-note').textContent()) ?? '';
  const m = note.match(/人物 ×(\d+) 拡大/);
  expect(m, note).not.toBeNull();
  expect(Number(m![1])).toBeLessThanOrEqual(25);

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});
