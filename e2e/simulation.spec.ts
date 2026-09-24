/**
 * 津波の計算: 実行 → フレームの逐次受信 → 再生（時刻・HUD）→ 結果（海岸の最大水位・浸水）。
 * 計算を短くするため、解像度「粗い」（約31 m）・計算時間 30 分で実行する。
 */
import { describeProblems, expect, openReadyApp, test, waitForSimDone, waitForTerrain } from './fixtures';

test('シミュレーションを実行すると、結果が逐次表示され、海岸の最大水位が目標値に近づく', async ({ page, consoleProblems }) => {
  await openReadyApp(page);

  // 震度7（相模トラフ西側モデル: 目標 T.P.+8.8 m）
  await page.getByRole('button', { name: '震度7', exact: true }).click();

  // 画面の操作で条件を設定: 解像度「粗い」・計算時間 30 分
  await page.locator('#panel-quake label.radio-card', { hasText: '粗い' }).click();
  await expect.poll(() => page.evaluate(() => window.__app.store.get().params.resolution)).toBe('coarse');
  await waitForTerrain(page, 8);
  await page.getByLabel('計算時間', { exact: true }).selectOption('30');
  expect(await page.evaluate(() => window.__app.store.get().params.durationMin)).toBe(30);

  const hudTime = page.locator('#hud .hud-time-value');

  // 「シミュレーション実行」（結果が残っている場合は「この条件で再計算」）
  await page.getByRole('button', { name: /シミュレーション実行|この条件で再計算/ }).click();
  await expect.poll(() => page.evaluate(() => window.__app.store.get().sim.status)).toBe('running');
  await expect(page.locator('#panel-quake .run-progress')).toBeVisible();

  // フレームが逐次届き、自動で再生が始まる
  await page.waitForFunction(() => (window.__app.store.get().sim.output?.framesReady() ?? 0) >= 3, null, { timeout: 180_000, polling: 250 });
  const early = await page.evaluate(() => {
    const s = window.__app.store.get();
    return { status: s.sim.status, playing: s.time.playing, frames: s.sim.output!.framesReady() };
  });
  expect(early.playing).toBe(true);

  // 再生中は時刻が進み、HUD の経過時間も更新される
  const t0 = await page.evaluate(() => window.__app.store.get().time.t);
  await expect.poll(() => page.evaluate(() => window.__app.store.get().time.t), { timeout: 60_000 }).toBeGreaterThan(t0 + 5);
  await expect(hudTime).not.toHaveText('0秒');

  // タイムラインのボタンで一時停止・再開できる
  await page.getByRole('button', { name: '一時停止' }).click();
  expect(await page.evaluate(() => window.__app.store.get().time.playing)).toBe(false);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  expect(await page.evaluate(() => window.__app.store.get().time.playing)).toBe(true);

  await waitForSimDone(page);

  const result = await page.evaluate(() => {
    const s = window.__app.store.get();
    const out = s.sim.output!;
    const g = s.terrain.grid!;
    let floodedLand = 0;
    let arrived = 0;
    let maxLandDepth = 0;
    for (let k = 0; k < g.kind.length; k++) {
      if (g.kind[k] !== 0) continue;
      if (out.maxDepth[k] >= 0.01) floodedLand++;
      if (Number.isFinite(out.arrival[k])) arrived++;
      maxLandDepth = Math.max(maxLandDepth, out.maxDepth[k]);
    }
    return {
      status: s.sim.status,
      message: s.sim.message,
      frames: out.framesReady(),
      frameInterval: out.frameInterval,
      durationSec: out.durationSec,
      timeReady: out.timeReady(),
      gaugeCount: out.gauge.count(),
      achieved: out.achievedCoastMax(),
      target: out.calibration.targetCoastHeight,
      amplitude: out.calibration.boundaryAmplitude,
      floodedLand,
      arrived,
      maxLandDepth,
      sameSpec: out.spec.nx === g.spec.nx && out.spec.ny === g.spec.ny,
    };
  });

  expect(result.status, result.message).toBe('done');
  expect(result.sameSpec).toBe(true);
  expect(result.durationSec).toBe(30 * 60);
  expect(result.timeReady).toBe(result.durationSec);
  expect(result.frames).toBe(Math.round(result.durationSec / result.frameInterval) + 1);
  expect(result.gaugeCount).toBeGreaterThan(10);
  // 海岸線での最大水位が目標（T.P.+8.8 m）の ±20% 以内
  expect(result.target).toBe(8.8);
  expect(result.achieved).toBeGreaterThan(result.target * 0.8);
  expect(result.achieved).toBeLessThan(result.target * 1.2);
  expect(result.amplitude).toBeGreaterThan(0);
  // 陸に浸水する
  expect(result.floodedLand).toBeGreaterThan(50);
  expect(result.arrived).toBeGreaterThan(0);
  expect(result.maxLandDepth).toBeGreaterThan(1);

  // 結果の要約
  const results = page.locator('#panel-quake .results');
  await expect(results).toBeVisible();
  await expect(results).toContainText('海岸の最大水位');
  await expect(results).toContainText('目標 T.P.+8.8');
  await expect(page.getByRole('button', { name: 'この条件で再計算' })).toBeVisible();

  // 時刻を指定すると HUD の経過時間が変わる
  await page.evaluate(() => {
    window.__app.actions.pause();
    window.__app.actions.seek(20 * 60);
  });
  await expect(hudTime).toHaveText('20分00秒');
  const flooded20 = await page.evaluate(() => {
    const s = window.__app.store.get();
    const out = s.sim.output!;
    const g = s.terrain.grid!;
    const depth = new Float32Array(g.kind.length);
    out.fillDepth(s.time.t, depth);
    let wetLand = 0;
    for (let k = 0; k < depth.length; k++) if (g.kind[k] === 0 && depth[k] >= 0.01) wetLand++;
    return wetLand;
  });
  expect(flooded20).toBeGreaterThan(0);

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});
