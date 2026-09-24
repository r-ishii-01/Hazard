/**
 * 画面の使いやすさ・アクセシビリティ・表記の正確さ:
 * - タブレット縦（820px）・1280px でタイムラインが縮まず、目印のチップが隠れない。スパークラインの文字が重ならない
 * - スマートフォン: 操作部品が指で押しやすい大きさ。目印のチップを名前つきで出す。地図の上の時刻は 1 時間を過ぎても幅が変わらない。
 *   ボトムシートのつまみを上下に動かして広げる・縮める・閉じる。「タップ」と書き、Esc の案内は出さない
 * - デスクトップ: 警報カードはたたむ・開ける（しばらくすると 1 行にたたむ）。3D 表示中に見えない 2D 地図の部品へ
 *   Tab キーで移動しない。状態の見方のチップが説明に重ならない。グラフのラベルが線の上に描かれる。
 *   計算結果の要約はライブリージョンではなく、完了時に 1 文で読み上げる。到達時間の「想定」「設定」の書き分け
 * - 地名検索・逆ジオコーダーが応答しないまま止まっても、打ち切って再試行でき、住所の問い合わせの順番待ちも止まらない
 */
import type { Page } from '@playwright/test';
import { describeProblems, expect, openReadyApp, test, waitForSimDone, waitForTerrain } from './fixtures';

/** 自動計算の途中の結果を消して「結果なし」の状態にする（計算済みの範囲より先へ移動できるように） */
async function clearResult(page: Page): Promise<void> {
  await page.evaluate(() => window.__app.actions.reloadTerrain());
  await waitForTerrain(page);
  expect(await page.evaluate(() => window.__app.store.get().sim.output)).toBeNull();
}

/** 解像度「粗い」・計算時間 30 分で計算する（完了まで待つ） */
async function runCoarse30(page: Page): Promise<void> {
  await page.evaluate(() => window.__app.actions.updateParams({ resolution: 'coarse', durationMin: 30 }));
  await waitForTerrain(page, 8);
  await page.evaluate(() => window.__app.actions.runSimulation());
  await waitForSimDone(page);
  expect(await page.evaluate(() => window.__app.store.get().sim.status)).toBe('done');
}

type Box = { x: number; y: number; width: number; height: number };
const right = (b: Box) => b.x + b.width;

test.describe('タブレット縦（820×1180・タッチ）', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });

  test('タイムラインは 2 行になり、スクラバーが十分に広く、目印のチップがすべて見える', async ({ page, consoleProblems }) => {
    await openReadyApp(page);
    await runCoarse30(page);
    await page.evaluate(() => {
      window.__app.actions.pause();
      window.__app.actions.seek(600);
    });
    const main = (await page.locator('#timeline .tl-main').boundingBox())!;
    // 以前は 1 行に再生・速度・時刻と並び、スクラバーが約 150px しかなかった
    expect(main.width).toBeGreaterThan(380);
    const timeline = (await page.locator('#timeline').boundingBox())!;
    const chips = page.locator('#timeline .tl-chip');
    await expect(chips).toHaveCount(4);
    for (const chip of await chips.all()) {
      await expect(chip).toBeVisible();
      const b = (await chip.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(main.x - 0.5);
      expect(right(b)).toBeLessThanOrEqual(right(main) + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(timeline.y + timeline.height + 0.5);
    }
    // 時刻の順（最初の浸水が先頭）
    await expect(chips.first()).toContainText('最初の浸水（計算）');
    // スパークラインの見出しと最大値が重ならない（狭いときは見出しを省く）
    const label = page.locator('#timeline .spark-label');
    const max = (await page.locator('#timeline .spark-max').boundingBox())!;
    if (await label.isVisible()) {
      const lb = (await label.boundingBox())!;
      expect(right(lb)).toBeLessThanOrEqual(max.x);
    }
    // タッチ操作: スクラバー・再生ボタン・速度が押しやすい大きさ
    expect((await page.locator('#timeline .tl-range').boundingBox())!.height).toBeGreaterThanOrEqual(32);
    expect((await page.locator('#timeline .tl-play').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.locator('#timeline .tl-speed-select').boundingBox())!.height).toBeGreaterThanOrEqual(40);
    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});

test.describe('1280×720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('目印のチップが途中で切れない（入りきらなければ折り返す）', async ({ page, consoleProblems }) => {
    await openReadyApp(page);
    await clearResult(page);
    const chips = page.locator('#timeline .tl-chips');
    const main = (await page.locator('#timeline .tl-main').boundingBox())!;
    const overflow = await chips.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const chip of await chips.locator('.tl-chip').all()) {
      expect(right((await chip.boundingBox())!)).toBeLessThanOrEqual(right(main) + 0.5);
    }
    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});

test.describe('スマートフォン（390×844・タッチ）', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('操作部品が指で押しやすく、目印に名前があり、時刻の幅が 1 時間で変わらず、シートをつまみで動かせる', async ({ page, consoleProblems }) => {
    await openReadyApp(page);
    await clearResult(page);

    // ---- 押しやすい大きさ（40px 以上。MapLibre・3D の部品は別に確かめている） ----
    const minSize = async (selector: string) => {
      const boxes = await page.locator(selector).evaluateAll((els) =>
        els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => {
          const r = e.getBoundingClientRect();
          return { w: r.width, h: r.height, name: e.getAttribute('aria-label') || e.textContent?.trim() || e.className };
        }),
      );
      expect(boxes.length, selector).toBeGreaterThan(0);
      return boxes;
    };
    for (const sel of ['#app-header .seg-btn', '#app-header .header-btn', '#timeline .tl-play', '#hud .maptool-btn']) {
      for (const b of await minSize(sel)) {
        expect(b.w, `${sel} ${b.name}`).toBeGreaterThanOrEqual(40);
        expect(b.h, `${sel} ${b.name}`).toBeGreaterThanOrEqual(40);
      }
    }
    expect((await page.locator('#timeline .tl-speed-select').boundingBox())!.height).toBeGreaterThanOrEqual(40);
    expect((await page.locator('#timeline .tl-range').boundingBox())!.height).toBeGreaterThanOrEqual(36);

    // ---- 目印のチップ（色の線だけでなく名前と時刻）を 1 行で出す ----
    const chips = page.locator('#timeline .tl-chips');
    await expect(chips).toBeVisible();
    await expect(chips.locator('.tl-chip').first()).toContainText('揺れ終了');
    await expect(chips.locator('.tl-chip', { hasText: '最大波の想定時刻' })).toContainText('8:00');
    const chipH = (await chips.locator('.tl-chip').first().boundingBox())!.height;
    expect(chipH).toBeGreaterThanOrEqual(30);
    // チップを押すとその時刻へ
    await chips.locator('.tl-chip', { hasText: '揺れ終了' }).tap();
    await expect.poll(() => page.evaluate(() => window.__app.store.get().time.t)).toBe(120);

    // ---- 地図の上の時刻: 1 時間を過ぎても「80分30秒」（「1時間20分30秒」にして帯が伸びない） ----
    const time = page.locator('#hud .hud-time-value');
    await page.evaluate(() => window.__app.actions.seek(3599));
    await expect(time).toHaveText('59分59秒');
    const w1 = (await page.locator('#hud .hud-status').boundingBox())!.width;
    await page.evaluate(() => window.__app.actions.seek(80 * 60 + 30));
    await expect(time).toHaveText('80分30秒');
    const w2 = (await page.locator('#hud .hud-status').boundingBox())!.width;
    expect(Math.abs(w2 - w1)).toBeLessThan(4);

    // ---- 人物の配置: 「タップ」と書き、Esc の案内は出さない（3D の配置のチップも） ----
    await page.getByRole('tab', { name: '人物' }).tap();
    const people = page.locator('#panel-people');
    await expect(people.locator('.section-lead').first()).toContainText('地図上をタップすると');
    await expect(people.locator('.empty-state')).toContainText('地図上をタップして配置');
    await page.evaluate(() => {
      window.__app.actions.setView('3d');
      window.__app.actions.startPlacing('runner');
    });
    const placing = page.locator('#hud .hud-placing');
    await expect(placing).toContainText('地図をタップして「走って避難」を配置');
    await expect(placing.getByRole('button')).toHaveText('終了');
    await expect(people.locator('.placing-hint')).toContainText('地図をタップして配置');
    await expect(people.locator('.placing-hint')).not.toContainText('Esc');
    await page.evaluate(() => {
      window.__app.actions.startPlacing(null);
      window.__app.actions.setView('2d');
    });

    // ---- ボトムシート: つまみを上へ動かすと広げる、下へ動かすと縮める・閉じる ----
    const sidebar = page.locator('#sidebar');
    await page.getByRole('tab', { name: '地震・津波' }).tap();
    await expect(sidebar).toHaveAttribute('data-sheet', 'open');
    const grip = (await page.locator('#sidebar .sheet-handle .grip').boundingBox())!;
    const gx = grip.x + grip.width / 2;
    const gy = grip.y + grip.height / 2 + 6;
    const cdp = await page.context().newCDPSession(page);
    const touchDrag = async (dy: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gx, y: gy }] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gx, y: gy + (dy * i) / 8 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await touchDrag(-140);
    await expect(sidebar).toHaveClass(/is-expanded/);
    await expect(page.getByRole('button', { name: 'パネルを縮める' })).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(400); // 高さの変化（アニメーション）を待つ
    // 広げたシートのつまみを少し下へ: 元の高さに
    const grip2 = (await page.locator('#sidebar .sheet-handle .grip').boundingBox())!;
    const g2y = grip2.y + grip2.height / 2 + 6;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gx, y: g2y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gx, y: g2y + (90 * i) / 8 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(sidebar).not.toHaveClass(/is-expanded/);
    await expect(sidebar).toHaveAttribute('data-sheet', 'open');
    await page.waitForTimeout(400);
    // 少しだけ動かしたら何もしない
    const grip3 = (await page.locator('#sidebar .sheet-handle .grip').boundingBox())!;
    const g3y = grip3.y + grip3.height / 2 + 6;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gx, y: g3y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gx, y: g3y + 10 }] });
    await page.waitForTimeout(200);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(sidebar).toHaveAttribute('data-sheet', 'open');
    // 下へ大きく動かすと閉じる
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gx, y: g3y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gx, y: g3y + (160 * i) / 8 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(sidebar).toHaveAttribute('data-sheet', 'closed');
    // 開閉のボタンは 40px 以上
    await page.getByRole('tab', { name: '地震・津波' }).tap();
    for (const name of ['パネルを広げる', 'パネルを閉じる']) {
      const b = (await page.getByRole('button', { name }).boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(40);
      expect(b.height).toBeGreaterThanOrEqual(40);
    }

    const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    expect(o.doc).toBeLessThanOrEqual(o.width);
    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});

test.describe('デスクトップ（1440×900）', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('警報カードはたたむ・開ける。3D 表示中は見えない 2D 地図の部品へ Tab で移動しない。表記・読み上げ', async ({ page, consoleProblems }) => {
    await openReadyApp(page);
    await clearResult(page);

    // ---- 到達時間の「想定」「設定」と根拠の見出し ----
    const quake = page.locator('#panel-quake');
    await expect(quake.locator('.scenario-card[data-id="sagami-west"] .scenario-facts')).toContainText('最大波の到達（想定） 約8分');
    // 南海トラフの 34 分は内閣府の「+3m」の到達時間を代わりに使った設定値
    await expect(quake.locator('.scenario-card[data-id="nankai"] .scenario-facts')).toContainText('最大波の到達（設定） 約34分');
    await expect(quake.locator('.scenario-card[data-id="sagami-west"] .scenario-basis')).toContainText('最大波の到達時間の根拠');
    await expect(page.locator('#timeline .tl-chip', { hasText: '最大波の想定時刻' })).toContainText('8:00');
    await page.evaluate(() => window.__app.actions.updateScenario({ arrivalMin: 12 }));
    await expect(page.locator('#timeline .tl-chip', { hasText: '最大波の設定時刻' })).toContainText('12:00');
    await page.evaluate(() => window.__app.actions.selectShindo('7'));
    await expect(page.locator('#timeline .tl-chip', { hasText: '最大波の想定時刻' })).toContainText('8:00');

    // ---- 警報カード: 最初はとるべき行動まで見せ、しばらくすると 1 行にたたむ。押すと詳細・もう一度押すとたたむ ----
    await page.evaluate(() => window.__app.actions.seek(600));
    const warn = page.locator('#hud .hud-warn');
    await expect(warn).toBeVisible();
    await expect(warn).toHaveAttribute('data-state', 'summary');
    await expect(warn.locator('.hud-warn-action')).toBeVisible();
    const tall = (await warn.boundingBox())!.height;
    await expect(warn).toHaveAttribute('data-state', 'compact', { timeout: 20_000 });
    await expect(warn.locator('.hud-warn-action')).toBeHidden();
    const short = (await warn.boundingBox())!.height;
    expect(short).toBeLessThan(tall - 20);
    expect(short).toBeLessThan(50);
    await warn.click();
    await expect(warn).toHaveAttribute('aria-expanded', 'true');
    await expect(warn.locator('.hud-warn-action')).toBeVisible();
    await expect(warn.locator('.hud-warn-note')).toContainText('発表基準');
    await warn.click();
    await expect(warn).toHaveAttribute('aria-expanded', 'false');
    await expect(warn).toHaveAttribute('data-state', 'compact');

    // ---- 3D 表示中: 2D 地図の出典（開いていても）へ Tab キーで移動しない ----
    await page.waitForFunction(() => !!window.__map2d?.map?.isStyleLoaded(), null, { timeout: 60_000 });
    // 出典を開いた状態（MapLibre は .maplibregl-compact-show に visibility: visible を指定する）にしておく
    await page.evaluate(() => document.querySelector('#view-2d .maplibregl-ctrl-attrib')?.classList.add('maplibregl-compact', 'maplibregl-compact-show'));
    expect(await page.locator('#view-2d .maplibregl-ctrl-attrib a').count()).toBeGreaterThan(0);
    await page.getByRole('button', { name: '3D で表示' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-view', '3d');
    const visible2d = await page.locator('#view-2d').evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>('a, button, summary, input, select, [tabindex]')].filter((el) => getComputedStyle(el).visibility !== 'hidden').map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(visible2d).toEqual([]);
    // サイドバーの最後の部品（実行ボタン）から Tab キーで地図の上の部品・タイムラインへ
    await page.getByRole('tab', { name: '地震・津波' }).click();
    await page.locator('#panel-quake .run-bar .btn-primary').focus();
    const stops: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el && el.closest('#view-2d') ? `${el.tagName} ${el.textContent?.trim().slice(0, 20)}` : '';
      });
      if (inside) stops.push(inside);
    }
    expect(stops).toEqual([]);
    await page.getByRole('button', { name: '2D 地図で表示' }).click();

    // ---- 状態の見方: チップが説明に重ならない ----
    await page.getByRole('tab', { name: '人物' }).click();
    const overlaps = await page.locator('#panel-people .status-legend li').evaluateAll((lis) =>
      lis.map((li) => li.querySelector('.status-chip')!.getBoundingClientRect().right - li.querySelector('.legend-desc')!.getBoundingClientRect().left),
    );
    expect(overlaps.length).toBeGreaterThanOrEqual(6);
    for (const d of overlaps) expect(d).toBeLessThanOrEqual(0);
    // デスクトップ（マウス）では「クリック」・Esc の案内
    await expect(page.locator('#panel-people .section-lead').first()).toContainText('地図上をクリックすると');

    // ---- 計算: 要約はライブリージョンではなく、完了時に 1 文で読み上げる ----
    const results = page.locator('#panel-quake .results');
    await expect(results).not.toHaveAttribute('aria-live', /.+/);
    await runCoarse30(page);
    const live = page.locator('.visually-hidden[role="status"][aria-live="polite"]').last();
    await expect(live).toContainText('計算が完了しました。陸域で最初に浸水したのは地震発生から');
    await expect(live).toContainText('最大浸水深は');
    await expect(results).not.toHaveAttribute('aria-live', /.+/);

    // ---- 人物のグラフ: しきい値のラベルは線の上に（白い縁取りで）描く ----
    await page.evaluate(() => {
      const p = window.__app.actions.addPerson('elderly', 139.47, 35.317);
      window.__app.actions.selectPerson(p.id);
      window.__app.actions.seek(900);
    });
    await page.getByRole('tab', { name: '人物' }).click();
    const chart = page.locator('#panel-people .depth-chart');
    await expect(chart).toBeVisible();
    await expect(chart.locator('.chart-th-labels text').first()).toBeVisible();
    const order = await chart.evaluate((svg) => {
      const kids = [...svg.children];
      return { line: kids.indexOf(svg.querySelector('.chart-line')!), labels: kids.indexOf(svg.querySelector('.chart-th-labels')!), paint: getComputedStyle(svg.querySelector('.chart-th-labels text')!).paintOrder };
    });
    expect(order.labels).toBeGreaterThan(order.line);
    expect(order.paint).toContain('stroke');

    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});

test.describe('国土地理院の API が応答しない', () => {
  test('地名検索は打ち切って再試行でき、住所の問い合わせの順番待ちも止まらない', async ({ page, consoleProblems }) => {
    test.setTimeout(120_000);
    // 応答を返さない（止まったままの）サーバー
    let reverseCalls = 0;
    await page.route(/^https:\/\/msearch\.gsi\.go\.jp\//, () => {});
    await page.route(/^https:\/\/mreversegeocoder\.gsi\.go\.jp\//, () => {
      reverseCalls++;
    });
    await openReadyApp(page);

    await page.getByRole('button', { name: '地名・住所で探す', exact: true }).click();
    const input = page.getByRole('combobox', { name: '地名・住所・駅名などで検索' });
    const status = page.locator('#place-panel .place-status');
    await input.fill('鵠沼海岸駅');
    await input.press('Enter');
    await expect(status).toContainText('検索しています');
    // 以前は「検索しています…」のまま止まり、再試行もできなかった
    await expect(status).toContainText('検索できませんでした（地名検索の応答がありません）', { timeout: 20_000 });
    await expect(status.getByRole('button', { name: '再試行' })).toBeVisible();
    await page.getByRole('button', { name: '閉じる', exact: true }).click();

    // 1 人目の問い合わせが止まっても、打ち切って 2 人目の問い合わせに進む
    await page.evaluate(() => window.__app.actions.addPerson('adult', 139.4702, 35.3187));
    await expect.poll(() => reverseCalls, { timeout: 10_000 }).toBe(1);
    await page.evaluate(() => window.__app.actions.addPerson('child', 139.4655, 35.3205));
    await expect.poll(() => reverseCalls, { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
    // 住所の目安が得られなかった人物に「調べています…」を出し続けない
    await page.getByRole('tab', { name: '人物' }).click();
    await expect(page.locator('#panel-people')).not.toContainText('住所の目安を調べています', { timeout: 25_000 });

    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});
