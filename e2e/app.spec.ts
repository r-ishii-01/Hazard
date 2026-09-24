/**
 * 基本の動作: 初回表示・地形の読み込み・震度とシナリオの選択。
 */
import { DISCLAIMER_KEY, describeProblems, expect, openApp, openReadyApp, stopAutoRun, test, waitForTerrain } from './fixtures';

test.describe('初回表示', () => {
  test.use({ acknowledgeDisclaimer: false });

  test('コンソールエラーなしで読み込まれ、「ご利用にあたって」が表示される', async ({ page, consoleProblems }) => {
    await openApp(page);
    await expect(page).toHaveTitle('鵠沼海岸 津波シミュレーター');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('鵠沼海岸 津波シミュレーター');

    const dialog = page.getByRole('dialog', { name: 'ご利用にあたって' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('強い揺れや長い揺れを感じたら、ただちに高い所へ避難してください。');
    await expect(dialog).toContainText('学習・啓発用の簡易シミュレーション');
    await expect(dialog).toContainText('公的な予測や想定ではありません');
    await expect(dialog.getByRole('link', { name: '藤沢市の津波ハザードマップ', exact: true })).toHaveAttribute('href', /city\.fujisawa\.kanagawa\.jp/);

    await dialog.getByRole('button', { name: '内容を確認しました' }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), DISCLAIMER_KEY)).toBe('1');

    // 地形の読み込みまで含めてエラーが出ないこと
    await waitForTerrain(page);
    expect(await page.evaluate(() => window.__app.store.get().terrain.status)).toBe('ready');
    // 初回の自動計算（UI が対応している場合）: 確認後、地形の準備ができると既定のシナリオの計算が始まる
    const autoRunSupported = await page.evaluate(() => typeof (window.__app.actions as { armAutoRun?: unknown }).armAutoRun === 'function');
    if (autoRunSupported) {
      // ダイアログの close イベントは非同期に届くので、少し待つ
      await expect
        .poll(() =>
          page.evaluate(() => {
            const sim = window.__app.store.get().sim as { status: string; auto?: boolean };
            return sim.auto ? sim.status : 'not-started';
          }),
        )
        .toMatch(/^(running|done)$/);
      await stopAutoRun(page);
    }

    // 確認済みなら再読み込みしても表示しない
    await page.reload();
    await page.waitForFunction(() => !!window.__app?.store);
    await expect(page.getByRole('dialog', { name: 'ご利用にあたって' })).toBeHidden();
    // ヘッダーのボタンからいつでも開ける
    await page.getByRole('button', { name: 'ご利用にあたって（注意事項）' }).click();
    await expect(page.getByRole('dialog', { name: 'ご利用にあたって' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'ご利用にあたって' })).toBeHidden();

    await waitForTerrain(page);
    await stopAutoRun(page);
    expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
  });
});

test('地形は保存済みの国土地理院 標高タイル（ローカルミラー）から読み込まれる', async ({ page, externalRequests, consoleProblems }) => {
  const mirrorRequests: string[] = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/tiles/')) mirrorRequests.push(path);
  });

  await openReadyApp(page);

  const info = await page.evaluate(() => {
    const t = window.__app.store.get().terrain;
    const g = t.grid!;
    let land = 0;
    let sea = 0;
    let maxZ = -Infinity;
    let minZ = Infinity;
    for (let k = 0; k < g.kind.length; k++) {
      if (g.kind[k] === 0) land++;
      else if (g.kind[k] === 1) sea++;
      maxZ = Math.max(maxZ, g.z[k]);
      minZ = Math.min(minZ, g.z[k]);
    }
    return {
      status: t.status,
      source: g.source,
      isApproximate: g.isApproximate,
      sourceLabel: g.sourceLabel,
      cellPx: g.spec.cellPx,
      cells: g.kind.length,
      landFrac: land / g.kind.length,
      seaFrac: sea / g.kind.length,
      maxZ,
      minZ,
    };
  });

  expect(info.status).toBe('ready');
  // 'cache' = すべてのタイルをサイト内のミラーから取得（国土地理院のサーバーには接続していない）
  expect(info.source).toBe('cache');
  expect(info.isApproximate).toBe(false);
  expect(info.sourceLabel).toContain('地理院タイル（標高タイル（基盤地図情報数値標高モデル））を加工して作成');
  expect(info.cellPx).toBe(4); // 既定の解像度は「標準」（約16 m）
  // 計算範囲には陸（辻堂〜片瀬）と相模湾の両方が含まれる
  expect(info.landFrac).toBeGreaterThan(0.3);
  expect(info.seaFrac).toBeGreaterThan(0.2);
  expect(info.maxZ).toBeGreaterThan(30); // 江の島・片瀬山など
  expect(info.minZ).toBeLessThan(-10); // 推定した沖合の水深

  expect(mirrorRequests).toContain('/tiles/manifest.json');
  expect(mirrorRequests.some((p) => p.startsWith('/tiles/dem5a_png/15/'))).toBe(true);
  expect(externalRequests.filter((r) => /\/dem[0-9a-z]*_png\//.test(r.url))).toEqual([]);

  // 画面の表示: 出典を示し、簡易地形モデルの注意は出さない
  const status = page.locator('#panel-quake .terrain-status');
  await expect(status).toHaveAttribute('data-status', 'ready');
  await expect(status).toContainText('国土地理院');
  await expect(page.locator('#hud .hud-approx')).toBeHidden();

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});

test('震度を選ぶとシナリオと計算条件が切り替わる', async ({ page, consoleProblems }) => {
  await openReadyApp(page);
  const state = () =>
    page.evaluate(() => {
      const s = window.__app.store.get();
      const sc = s.params.scenario;
      return {
        shindo: s.shindo,
        scenarioId: s.scenarioId,
        name: sc.name,
        magnitude: sc.magnitude,
        coastHeight: sc.coastHeight,
        arrivalMin: sc.arrivalMin,
        tideTP: s.params.tideTP,
        durationMin: s.params.durationMin,
      };
    });
  const shindoButton = (label: string) => page.getByRole('button', { name: label, exact: true });
  const selectedCard = page.locator('#panel-quake .scenario-card.is-selected');
  // 「この震度で使うシナリオ：…」の表示
  const presetNote = page.locator('#panel-quake .callout', { hasText: 'この震度で使うシナリオ' });

  // 初期状態は震度7（相模トラフ沿いの海溝型地震 西側モデル）
  expect(await state()).toMatchObject({ shindo: '7', scenarioId: 'sagami-west' });
  await expect(shindoButton('震度7')).toHaveAttribute('aria-pressed', 'true');

  // 震度5弱 → 津波警報級の例（3m）: 海岸の最大水位 = 初期潮位 0.85 m + 3 m
  await shindoButton('震度5弱').click();
  await expect(shindoButton('震度5弱')).toHaveAttribute('aria-pressed', 'true');
  expect(await state()).toMatchObject({ shindo: '5-', scenarioId: 'example-warning', coastHeight: 3.85, tideTP: 0.85, arrivalMin: 20 });
  await expect(selectedCard).toHaveAttribute('data-id', 'example-warning');
  await expect(presetNote).toContainText('津波警報級の例（3m）');

  // 震度6弱 → 南海トラフ巨大地震（内閣府）: 藤沢市の最大 7 m、+3 m 到達 34 分 → 計算時間は 120 分
  await shindoButton('震度6弱').click();
  expect(await state()).toMatchObject({ shindo: '6-', scenarioId: 'nankai', magnitude: 9.1, coastHeight: 7, arrivalMin: 34, durationMin: 120 });
  await expect(selectedCard).toHaveAttribute('data-id', 'nankai');

  // 震度7 → 相模トラフ西側モデル: 藤沢海岸 T.P.+8.8 m・8 分（神奈川県の津波浸水予測図）
  await shindoButton('震度7').click();
  expect(await state()).toMatchObject({
    shindo: '7',
    scenarioId: 'sagami-west',
    name: '相模トラフ沿いの海溝型地震（西側モデル）',
    magnitude: 8.7,
    coastHeight: 8.8,
    arrivalMin: 8,
    tideTP: 0.85,
    durationMin: 60,
  });
  await expect(selectedCard).toHaveAttribute('data-id', 'sagami-west');
  await expect(presetNote).toContainText('相模トラフ沿いの海溝型地震（西側モデル）');
  await expect(page.getByRole('spinbutton', { name: '海岸での最大津波高' })).toHaveValue('8.8');
  await expect(page.getByRole('spinbutton', { name: /到達時間/ })).toHaveValue('8');

  // シナリオを直接選んでも震度が連動する
  await page.locator('#panel-quake .scenario-card[data-id="taisho"] .scenario-main').click();
  expect(await state()).toMatchObject({ shindo: '6+', scenarioId: 'taisho', coastHeight: 6.5, arrivalMin: 9 });
  await expect(shindoButton('震度6強')).toHaveAttribute('aria-pressed', 'true');

  // 条件の変更 → 「変更あり」→ シナリオの値に戻す
  const coast = page.getByRole('spinbutton', { name: '海岸での最大津波高' });
  await coast.fill('5.5');
  await coast.press('Enter');
  expect((await state()).coastHeight).toBe(5.5);
  await expect(page.locator('#panel-quake .tag-modified')).toBeVisible();
  await page.getByRole('button', { name: 'シナリオの値に戻す' }).click();
  expect((await state()).coastHeight).toBe(6.5);
  await expect(page.locator('#panel-quake .tag-modified')).toBeHidden();

  expect(consoleProblems, describeProblems(consoleProblems)).toEqual([]);
});
