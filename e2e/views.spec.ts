/**
 * 2D 地図・3D ビューの表示の正確さ:
 * - 広い画面: 左上の HUD の分だけ地図に余白をとり、移動先が HUD に隠れない（HUD の大きさが変わっても地図は動かさない）
 * - 避難場所の説明（2D のポップアップ・3D の札）に、指定緊急避難場所データの利用上の注意と、藤沢市の津波避難ビルの
 *   一覧へのリンクを出す
 * - 地図の上の避難先の札は短い形（全文は title）。「その場にとどまる」人は「避難開始前」でなく「とどまっている」
 * - 公式ハザードマップのタイル（表示するズーム）を取得できないと、地図が気づいて HUD の凡例・レイヤーのタブに示し、
 *   再試行で戻る（配信元への接続の確認〔ズーム13〕は通る場合も）
 * - スマートフォン: 2D の出典の開閉ボタンと 3D の「出典」ボタンは 40×40 以上
 */
import type { Page } from '@playwright/test';
import { describeProblems, expect, openReadyApp, test } from './fixtures';
import { shortTargetName } from '../src/map2d/targetName';

/** 鵠沼海岸駅 */
const STATION = { lon: 139.47127, lat: 35.32071 };
/** 表示するズーム（14 以上）の公式ハザードマップのタイル */
const HAZARD_DISPLAY_TILES = /^https:\/\/disaportaldata\.gsi\.go\.jp\/raster\/[^/]+\/(1[4-9])\//;

async function waitForMap(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__map2d?.map?.isStyleLoaded(), null, { timeout: 60_000 });
}

async function waitMapIdle(page: Page): Promise<void> {
  await page.waitForFunction(() => !window.__map2d!.map.isMoving(), null, { timeout: 20_000 });
}

test.describe('デスクトップ（1440×900）', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('2D 地図: HUD に隠れない余白、避難場所の注意、避難先の短い札、とどまる人の表示', async ({ page, consoleProblems }) => {
    await openReadyApp(page);
    await waitForMap(page);
    await page.waitForFunction(() => window.__app.store.get().shelters.length > 0, null, { timeout: 60_000 });

    // ---- HUD の分の余白 ----
    const hudRight = () =>
      page.evaluate(() => {
        const root = document.querySelector('#view-2d .m2d-root')!.getBoundingClientRect();
        return document.querySelector('#hud .hud-tl')!.getBoundingClientRect().right - root.left;
      });
    const pad = await page.evaluate(() => window.__map2d!.map.getPadding().left);
    expect(pad).toBeGreaterThanOrEqual(await hudRight());
    // 移動先は HUD に隠れない部分の中央
    await page.evaluate(() => window.__app.actions.focusOn(139.46, 35.318, { zoom: 16, label: 'テスト地点' }));
    await page.waitForTimeout(300);
    await waitMapIdle(page);
    const focus = await page.evaluate(() => {
      const map = window.__map2d!.map;
      const p = map.project([139.46, 35.318]);
      const w = map.getContainer().clientWidth;
      const left = map.getPadding().left ?? 0;
      return { x: p.x, center: left + (w - left) / 2 };
    });
    expect(focus.x).toBeGreaterThan(await hudRight());
    expect(Math.abs(focus.x - focus.center)).toBeLessThan(2);

    // ---- 避難場所のポップアップ: 利用上の注意と市の一覧へのリンク ----
    const shelter = await page.evaluate(() => window.__app.store.get().shelters.find((s) => s.name === '市営鵠沼住宅')!);
    await page.evaluate(([lon, lat]) => window.__app.actions.focusOn(lon, lat, { zoom: 16 }), [shelter.lon, shelter.lat] as const);
    await page.waitForTimeout(300);
    await waitMapIdle(page);
    await page.locator(`.m2d-shelter[aria-label$="${shelter.name}"]`).click();
    const note = page.locator('.m2d-popup .m2d-shelter-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('「指定避難所」とは別のもの');
    await expect(note).toContainText('最新の情報は藤沢市で確認してください。');
    await expect(note).toContainText('藤沢市が独自に指定している津波避難ビルの多くは、このデータに含まれていません');
    const link = note.getByRole('link', { name: '藤沢市「津波避難ビル」一覧' });
    await expect(link).toHaveAttribute('href', 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/bosai/tunamihinanbiruichiran.html');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await page.keyboard.press('Escape');

    // ---- 人物: 最寄りの高台（札は短い形・全文は title）と、その場にとどまる人 ----
    const ids = await page.evaluate(([lon, lat]) => {
      const a = window.__app.actions;
      const p1 = a.addPerson('adult', lon, lat);
      a.updatePerson(p1.id, { evacMode: 'highground' });
      const p2 = a.addPerson('elderly', 139.4745, 35.3165);
      a.updatePerson(p2.id, { evacMode: 'stay' });
      a.selectPerson(p1.id);
      return [p1.id, p2.id];
    }, [STATION.lon, STATION.lat] as const);
    await page.waitForFunction((id) => !!window.__app.store.get().plans[id]?.target, ids[0], { timeout: 30_000 });
    const name = await page.evaluate((id) => window.__app.store.get().plans[id].target!.name, ids[0]);
    expect(name.length).toBeGreaterThan(shortTargetName(name).length);
    const label = page.locator('.m2d-target-label');
    await expect(label).toHaveText(`避難先: ${shortTargetName(name)}`);
    await expect(label).toHaveAttribute('title', `避難先: ${name}`);
    expect(shortTargetName(name)).toMatch(/^最寄りの高台（標高 [\d.]+ m/);

    const stay = page.locator('.m2d-person--stay');
    await expect(stay).toHaveCount(1);
    await expect(stay).toHaveAttribute('title', /とどまっている/);
    expect(await stay.getAttribute('title')).not.toContain('避難開始前');
    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });

  test('公式ハザードマップのタイルを取得できないと 2D 地図が知らせ、再試行で戻る', async ({ page, consoleProblems }) => {
    // 配信元への接続の確認（ズーム13）は通るが、表示するタイル（ズーム14以上）は取得できない
    await page.route(HAZARD_DISPLAY_TILES, (route) => route.abort('internetdisconnected'));
    await openReadyApp(page);
    await waitForMap(page);
    await page.evaluate(() => {
      window.__app.actions.focusOn(139.475, 35.316, { zoom: 15 });
      window.__app.actions.setLayer('officialHazard', true);
    });
    await page.waitForFunction(() => window.__app.store.get().officialInundation.display === 'error', null, { timeout: 60_000 });
    await expect(page.locator('.hud-legend .hud-legend-warn')).toBeVisible();
    await expect(page.locator('#view-2d .m2d-notice')).toContainText('公式ハザードマップ（津波浸水想定）のタイルを読み込めません');

    // 接続できるようになったら、レイヤーのタブの「再試行」で戻る
    await page.unroute(HAZARD_DISPLAY_TILES);
    await page.getByRole('tab', { name: 'レイヤー' }).click();
    const status = page.locator('#panel-layers .hazard-status-display');
    await expect(status).toBeVisible();
    await status.getByRole('button', { name: '再試行' }).click();
    await page.waitForFunction(() => window.__app.store.get().officialInundation.display === 'ok', null, { timeout: 60_000 });
    await expect(page.locator('#view-2d .m2d-notice')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('.hud-legend .hud-legend-warn')).toBeHidden();
    // 回復した後に「取得できない」へ戻らない
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.__app.store.get().officialInundation.display)).toBe('ok');
    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});

test.describe('スマートフォン（390×844・タッチ）', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('出典のボタンは 40×40 以上。3D で避難場所をタップすると、注意と市の一覧へのリンクを出す', async ({ page, consoleProblems }) => {
    await openReadyApp(page);
    await waitForMap(page);
    await page.waitForFunction(() => window.__app.store.get().shelters.length > 0, null, { timeout: 60_000 });
    const attrib = (await page.locator('#view-2d .maplibregl-ctrl-attrib-button').boundingBox())!;
    expect(attrib.width).toBeGreaterThanOrEqual(40);
    expect(attrib.height).toBeGreaterThanOrEqual(40);
    // 狭い画面では HUD は上端の帯なので、地図の余白はとらない
    expect(await page.evaluate(() => window.__map2d!.map.getPadding().left)).toBe(0);

    await page.getByRole('button', { name: '3D で表示' }).tap();
    type View = {
      debugInfo(): { webgl: boolean; calls: number };
      shelters: { screenPos(s: unknown, c: unknown, w: number, h: number): { x: number; y: number } | null };
      camera: unknown;
      viewportW: number;
      viewportH: number;
      renderer: { domElement: HTMLCanvasElement };
    };
    await page.waitForFunction(() => ((document.getElementById('view-3d')?.__view3d as unknown as View | undefined)?.debugInfo().calls ?? 0) > 0, null, {
      timeout: 90_000,
    });
    const btn = page.locator('#view-3d .v3d-attrib-btn');
    await expect(btn).toBeVisible();
    const b = (await btn.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(40);
    expect(b.height).toBeGreaterThanOrEqual(40);

    // 避難場所をタップ: 説明の札（利用上の注意・市の一覧へのリンク）
    const shelter = await page.evaluate(() => window.__app.store.get().shelters.find((s) => s.name === '市営鵠沼住宅')!);
    await page.evaluate(([lon, lat]) => window.__app.actions.focusOn(lon, lat, { zoom: 16 }), [shelter.lon, shelter.lat] as const);
    const pos = await page
      .waitForFunction(
        (name) => {
          const v = document.getElementById('view-3d')!.__view3d as unknown as View & { debugInfo(): { animating?: boolean } };
          if ((v.debugInfo() as { animating?: boolean }).animating) return null;
          const s = window.__app.store.get().shelters.find((x) => x.name === name);
          const p = v.shelters.screenPos(s, v.camera, v.viewportW, v.viewportH);
          if (!p) return null;
          const r = v.renderer.domElement.getBoundingClientRect();
          // アイコン（上端 p.y・高さ 26px）の中央
          return { x: r.left + p.x, y: r.top + p.y + 13 };
        },
        shelter.name,
        { timeout: 30_000 },
      )
      .then((h) => h.jsonValue());
    await page.touchscreen.tap(pos!.x, pos!.y);
    const card = page.locator('#view-3d .v3d-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(shelter.name);
    await expect(card).toContainText('最新の情報は藤沢市で確認してください。');
    await expect(card.getByRole('link', { name: '藤沢市「津波避難ビル」一覧' })).toHaveAttribute(
      'href',
      'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/bosai/tunamihinanbiruichiran.html',
    );
    const close = (await card.getByRole('button', { name: '閉じる' }).boundingBox())!;
    expect(close.width).toBeGreaterThanOrEqual(40);
    await card.getByRole('button', { name: '閉じる' }).tap();
    await expect(card).toBeHidden();
    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});
