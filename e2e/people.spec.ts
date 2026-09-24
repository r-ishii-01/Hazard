/**
 * 人物の配置: 「人物」タブで種類を選び、2D 地図の陸地をクリック → 避難計画と状態が表示される。
 */
import type { Page } from '@playwright/test';
import { describeProblems, expect, openReadyApp, test } from './fixtures';

/**
 * 地図の中央付近で、人物を置ける陸のセル（計算範囲内・海や川でない・標高 2 m 以上）の画面座標を探す。
 * クリックが地図のキャンバスに届く（マーカーや HUD に隠れていない）ことも確かめる。
 */
async function findLandPoint(page: Page): Promise<{ x: number; y: number; lon: number; lat: number }> {
  const found = await page.evaluate(() => {
    const map = window.__map2d?.map;
    const grid = window.__app.store.get().terrain.grid;
    if (!map || !grid) return null;
    const spec = grid.spec;
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    // geo.ts と同じ Web メルカトルのピクセル座標でセルを求める
    const cellAt = (lon: number, lat: number) => {
      const ws = 256 * 2 ** spec.zoom;
      const s = Math.sin((lat * Math.PI) / 180);
      const px = ((lon + 180) / 360) * ws;
      const py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws;
      const i = Math.floor((px - spec.originPx) / spec.cellPx);
      const j = Math.floor((py - spec.originPy) / spec.cellPx);
      if (i < 0 || j < 0 || i >= spec.nx || j >= spec.ny) return -1;
      return j * spec.nx + i;
    };
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    for (let r = 0; r <= 240; r += 12) {
      for (let a = 0; a < 360; a += r === 0 ? 360 : 30) {
        const x = cx + r * Math.cos((a * Math.PI) / 180);
        const y = cy - r * Math.sin((a * Math.PI) / 180);
        const ll = map.unproject([x, y]);
        const k = cellAt(ll.lng, ll.lat);
        if (k < 0 || grid.kind[k] !== 0 || !(grid.z[k] >= 2)) continue;
        const el = document.elementFromPoint(rect.left + x, rect.top + y);
        if (el !== canvas) continue;
        return { x: rect.left + x, y: rect.top + y, lon: ll.lng, lat: ll.lat };
      }
    }
    return null;
  });
  if (!found) throw new Error('地図上に人物を置ける陸地が見つかりませんでした');
  return found;
}

test('2D 地図で人物を配置すると、避難計画と状態が人物パネルに表示される', async ({ page, consoleProblems }) => {
  await openReadyApp(page);
  // 地図のスタイルと避難場所（内蔵の写しを代替データとして配信）の読み込みを待つ
  await page.waitForFunction(() => !!window.__map2d?.map?.isStyleLoaded(), null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__app.store.get().shelters.length > 0, null, { timeout: 60_000 });

  await page.getByRole('tab', { name: '人物' }).click();
  await expect(page.locator('#panel-people')).toBeVisible();
  await expect(page.locator('#panel-people .empty-state')).toBeVisible();

  // 配置モード
  const adultBtn = page.locator('#panel-people .place-btn[data-kind="adult"]');
  await adultBtn.click();
  await expect(adultBtn).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__app.store.get().placing)).toBe('adult');

  const pt = await findLandPoint(page);
  await page.mouse.click(pt.x, pt.y);

  await expect.poll(() => page.evaluate(() => window.__app.store.get().people.length)).toBe(1);
  const person = await page.evaluate(() => window.__app.store.get().people[0]);
  expect(person.kind).toBe('adult');
  expect(person.evacMode).toBe('shelter');
  expect(person.startDelayMin).toBe(5); // 内閣府の被害想定の「直接避難」（昼）
  expect(Math.abs(person.lon - pt.lon)).toBeLessThan(2e-4);
  expect(Math.abs(person.lat - pt.lat)).toBeLessThan(2e-4);

  // 避難計画（最寄りの避難場所への経路）
  await page.waitForFunction((id) => !!window.__app.store.get().plans[id], person.id, { timeout: 30_000 });
  const plan = await page.evaluate((id) => window.__app.store.get().plans[id], person.id);
  expect(plan.target, '避難先が見つかること').not.toBeNull();
  expect(plan.path.length).toBeGreaterThanOrEqual(2);
  expect(plan.distanceM).toBeGreaterThan(0);
  expect(plan.arriveAt).not.toBeNull();
  // 出発は避難開始時刻（5分後）以降、到着は出発より後
  expect(plan.path[0].t).toBeGreaterThanOrEqual(5 * 60 - 1e-6);
  expect(plan.arriveAt!).toBeGreaterThan(plan.path[0].t);

  // 人物パネル: 一覧の行・状態のチップ・詳細
  const row = page.locator('#panel-people .person-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.person-name')).toHaveText(person.name);
  const chip = row.locator('.status-chip');
  await expect(chip).toHaveAttribute('data-status', /^(waiting|evacuating|safe|caution|danger|critical)$/);
  await expect(chip.locator('.status-text')).not.toHaveText('');
  await expect(page.locator('#tab-people .tab-badge')).toHaveText('1');

  const detail = page.locator('#panel-people .person-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.plan-dl')).toContainText('避難先');
  await expect(detail.locator('.plan-dl')).toContainText(plan.target!.name);
  await expect(detail.locator('.plan-dl')).toContainText('経路の長さ');

  // Esc で配置モードを終了
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__app.store.get().placing)).toBeNull();

  // 海の上には置けない（配置モードで沖をクリックしても人物は増えない）
  await adultBtn.click();
  const sea = await page.evaluate(() => {
    const map = window.__map2d!.map;
    const rect = map.getCanvas().getBoundingClientRect();
    const p = map.project([139.47, 35.296]); // 鵠沼海岸の沖 約1.5 km
    return { x: rect.left + p.x, y: rect.top + p.y, inside: p.x > 0 && p.y > 0 && p.x < rect.width && p.y < rect.height };
  });
  if (sea.inside) {
    await page.mouse.click(sea.x, sea.y);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__app.store.get().people.length)).toBe(1);
  }
  await page.keyboard.press('Escape');

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});
