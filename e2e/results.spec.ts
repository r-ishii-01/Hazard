/**
 * 表示中の計算結果が「どこまで・どの条件・どの地形」のものかを正しく示すこと。
 *
 * - 計算を中止した途中の結果を、完了した結果のように見せない（「浸水しない」と示さない）。
 *   再生は計算済みの時刻で止まり、再生し直すと最初から。
 * - 震度・シナリオを変えても、再計算するまでは表示中の結果の条件で警報・目印を示し、条件が変わったことを知らせる。
 * - 計算中に解像度を変えると、前の地形の計算を中止して新しい地形で計算し直す。
 * - 再生中にタイムラインを終わりまで動かして離しても、最初に戻らない。
 * 計算を短くするため、解像度「粗い」・計算時間 30 分で実行する。
 */
import type { Page } from '@playwright/test';
import { describeProblems, expect, openReadyApp, test, waitForSimDone, waitForTerrain } from './fixtures';

/** 解像度「粗い」・計算時間 30 分（震度・シナリオを選ぶと計算時間は既定値に戻るので、選んだ後に呼ぶ） */
async function coarse30(page: Page): Promise<void> {
  await page.evaluate(() => window.__app.actions.updateParams({ resolution: 'coarse', durationMin: 30 }));
  await waitForTerrain(page, 8);
}

async function runUntil(page: Page, minReady: number): Promise<void> {
  await page.evaluate(() => window.__app.actions.runSimulation());
  await page.waitForFunction((t) => (window.__app.store.get().sim.output?.timeReady() ?? 0) >= t, minReady, { timeout: 180_000, polling: 100 });
}

test('中止した途中の結果は「途中まで」と示し、再生は計算済みの時刻で止まる', async ({ page, consoleProblems }) => {
  await openReadyApp(page);
  await page.evaluate(() => window.__app.actions.selectShindo('7'));
  await coarse30(page);

  await runUntil(page, 240);
  await page.evaluate(() => {
    window.__app.actions.setSpeed(240);
    window.__app.actions.cancelSimulation();
  });
  const until = await page.evaluate(() => window.__app.store.get().sim.output!.timeReady());
  expect(until).toBeLessThan(30 * 60);
  const span = await page.evaluate((t) => {
    const s = Math.floor(t);
    return s % 60 === 0 ? `${s / 60}分` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
  }, until);

  // 再生は計算済みの時刻で止まる（再生中のまま止まらない）
  await expect.poll(() => page.evaluate(() => window.__app.store.get().time), { timeout: 60_000 }).toEqual({ t: until, playing: false, speed: 240 });
  await expect(page.locator('#timeline .tl-play')).toHaveAttribute('aria-label', '再生');
  // 止まった後はストアを更新し続けない
  const updates = await page.evaluate(async () => {
    let n = 0;
    const unsub = window.__app.store.subscribe(() => n++);
    await new Promise((r) => setTimeout(r, 1000));
    unsub();
    return n;
  });
  expect(updates).toBe(0);
  // 計算済みより先へは移動しない。終わりから再生すると最初から
  await page.evaluate(() => window.__app.actions.seek(29 * 60));
  expect(await page.evaluate(() => window.__app.store.get().time.t)).toBe(until);
  const replayFrom = await page.evaluate(() => {
    const { actions, store } = window.__app;
    actions.play();
    const t = store.get().time.t;
    actions.pause();
    return t;
  });
  expect(replayFrom).toBe(0);

  // 結果の要約・実行ボタンの上・HUD・タイムラインで、途中までの結果であることと範囲を示す
  const label = `0〜${span}のみ計算（中止）`;
  const results = page.locator('#panel-quake .results');
  await expect(results.locator('.section-title .tag-running')).toHaveText(label);
  await expect(results).toContainText('浸水しないという意味ではありません');
  await expect(results).not.toContainText('浸水なし');
  await expect(page.locator('#panel-quake .run-notice')).toContainText(`地震発生から${span}までの途中の結果`);
  await expect(page.locator('#hud .hud-result')).toContainText(`計算を中止しました（結果は地震発生から${span}まで）`);
  await expect(page.locator('#timeline .tl-partial')).toHaveText(label);

  // 途中の結果で浸水していない陸の地点に「その場にとどまる」人を置く: 「浸水しない」とは言わない
  const cell = await page.evaluate(() => {
    const s = window.__app.store.get();
    const g = s.terrain.grid!;
    const out = s.sim.output!;
    const { nx, ny } = g.spec;
    for (let j = Math.floor(ny * 0.3); j < ny; j++) {
      for (let i = Math.floor(nx * 0.3); i < nx * 0.7; i++) {
        const k = j * nx + i;
        if (g.kind[k] === 0 && g.z[k] > 3 && g.z[k] < 20 && out.arrival[k] === Infinity && out.maxDepth[k] === 0) return { i, j };
      }
    }
    return null;
  });
  expect(cell).not.toBeNull();
  const personId = await page.evaluate(({ i, j }) => {
    const g = window.__app.store.get().terrain.grid!;
    const { originPx, originPy, cellPx } = g.spec;
    const px = originPx + (i + 0.5) * cellPx;
    const py = originPy + (j + 0.5) * cellPx;
    const ws = 256 * 2 ** 15;
    const lon = (px / ws) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / ws))) * 180) / Math.PI;
    const p = window.__app.actions.addPerson('elderly', lon, lat);
    window.__app.actions.updatePerson(p.id, { evacMode: 'stay' });
    return p.id;
  }, cell!);
  await page.getByRole('tab', { name: '人物' }).click();
  await page.evaluate((id) => window.__app.actions.selectPerson(id), personId);
  const detail = page.locator('#panel-people .person-detail');
  await expect(detail.locator('.plan-dl')).toContainText(`まだ浸水していません（${span}まで計算。それより後は未計算）`);
  await expect(detail.locator('.plan-dl')).not.toContainText('浸水しない');
  await expect(detail.locator('.plan-dl')).toContainText(`なし（${span}までの計算の範囲）`);
  await expect(detail.locator('.plan-verdict')).toContainText('安全かどうかは分かりません');
  // 「その場にとどまる」人は「避難開始前」ではない
  await expect(detail.locator('.detail-status .status-text')).toHaveText('とどまっている');
  await expect(page.locator('#panel-people .person-row .status-text')).toHaveText('とどまっている');

  // レイヤー: 最大浸水深・到達時間の範囲
  await page.getByRole('tab', { name: 'レイヤー' }).click();
  await expect(page.locator('#panel-layers .layers-partial')).toContainText(`地震発生から${span}までの結果です`);

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});

test('条件を変えても表示中の結果の条件で示して再計算を促し、計算中の解像度の変更は新しい地形で計算し直す', async ({ page, consoleProblems }) => {
  await openReadyApp(page);
  await page.evaluate(() => window.__app.actions.selectShindo('7'));
  await coarse30(page);
  await page.evaluate(() => window.__app.actions.runSimulation());
  await waitForSimDone(page);
  expect(await page.evaluate(() => window.__app.store.get().sim.status)).toBe('done');
  await page.evaluate(() => {
    window.__app.actions.pause();
    window.__app.actions.seek(15 * 60);
  });
  const warn = page.locator('#hud .hud-warn .hud-warn-label');
  const arrivalChip = page.locator('#timeline .tl-chip', { hasText: '最大波の想定時刻' });
  await expect(warn).toHaveText('大津波警報（想定）');
  await expect(arrivalChip).toContainText('8:00');
  await expect(page.locator('#hud .hud-result')).toBeHidden();
  // 完了した結果は「浸水なし」「計算した時間内」などを示せる（途中の表示は出ない）
  await expect(page.locator('#panel-quake .results .section-title .tag-running')).toBeHidden();

  // 震度3（津波注意報級の例）を選ぶ: 地図の浸水は震度7の結果のまま → 警報・目印も震度7の結果のまま、条件の変更を知らせる
  await page.getByRole('button', { name: '震度3', exact: true }).click();
  await expect(warn).toHaveText('大津波警報（想定）');
  await expect(arrivalChip).toContainText('8:00');
  const chip = page.locator('#hud .hud-result');
  await expect(chip).toContainText('表示中の結果は前の条件（相模トラフ西側・震度7）です');
  const runStale = page.locator('#panel-quake .run-stale');
  await expect(runStale).toBeVisible();
  await expect(runStale).toContainText('変更前の条件（相模トラフ西側・震度7）');
  await expect(page.locator('#panel-quake .results .tag-stale')).toBeVisible();

  // HUD の「再計算」で今の条件（震度3）で計算: 警報・目印は新しい条件になり、知らせは消える
  await chip.getByRole('button', { name: '再計算' }).click();
  await expect.poll(() => page.evaluate(() => window.__app.store.get().sim.run?.params.scenario.id)).toBe('example-advisory');
  await expect(chip).toBeHidden();
  await page.waitForFunction(() => (window.__app.store.get().sim.output?.timeReady() ?? 0) >= 60, null, { timeout: 180_000 });
  await page.evaluate(() => {
    window.__app.actions.pause();
    window.__app.actions.seek(Math.min(240, window.__app.store.get().sim.output!.timeReady()));
  });
  // 説明用の例の到達時間は公的な値ではないので「設定時刻」（公的な想定の「想定時刻」と書き分ける）
  await expect(page.locator('#timeline .tl-chip', { hasText: '最大波の設定時刻' })).toContainText('20:00');
  await expect(page.locator('#timeline .tl-chip', { hasText: '最大波の想定時刻' })).toHaveCount(0);

  // 計算中に条件を変える: 計算は続き、「この条件で計算し直す」で中止して計算し直せる
  await page.evaluate(() => window.__app.actions.selectShindo('7'));
  await page.evaluate(() => window.__app.actions.updateParams({ durationMin: 30 }));
  const rerun = runStale.getByRole('button', { name: 'この条件で計算し直す' });
  await expect(rerun).toBeVisible();
  expect(await page.evaluate(() => window.__app.store.get().sim.status)).toBe('running');
  await rerun.click();
  await expect.poll(() => page.evaluate(() => window.__app.store.get().sim.run?.params.scenario.id)).toBe('sagami-west');
  await expect(runStale).toBeHidden();

  // 計算中に解像度を変える: 前の地形の計算を中止して結果を消し、新しい地形で計算し直す
  await page.waitForFunction(() => (window.__app.store.get().sim.output?.timeReady() ?? 0) >= 60, null, { timeout: 180_000 });
  const before = await page.evaluate(() => {
    const { actions, store } = window.__app;
    actions.updateParams({ resolution: 'standard' });
    const s = store.get();
    return { output: s.sim.output === null, terrain: s.terrain.status };
  });
  expect(before).toEqual({ output: true, terrain: 'loading' });
  await waitForTerrain(page, 4);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__app.store.get();
        return { status: s.sim.status, resolution: s.sim.run?.params.resolution, sameGrid: s.sim.run?.grid === s.terrain.grid };
      }),
    )
    .toEqual({ status: 'running', resolution: 'standard', sameGrid: true });

  // 粗い解像度に戻す（計算中なので、読み込み後に計算し直す）→ 完了まで待ち、再生中に終わりまで動かして離す
  await page.evaluate(() => window.__app.actions.updateParams({ resolution: 'coarse' }));
  await waitForTerrain(page, 8);
  await expect.poll(() => page.evaluate(() => window.__app.store.get().sim.run?.params.resolution)).toBe('coarse');
  await waitForSimDone(page);
  await page.evaluate(() => {
    const { actions } = window.__app;
    actions.pause();
    actions.seek(300);
    actions.setSpeed(10);
    actions.play();
  });
  const range = page.locator('#timeline .tl-range');
  const box = (await range.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__app.store.get().time)).toMatchObject({ t: 30 * 60, playing: false });

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});
