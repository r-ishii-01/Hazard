/**
 * README 用のスクリーンショット（e2e/screenshots.config.ts で実行: `npm run screenshots`）。
 * 実際の地理院タイルなどを読み込み、相模トラフ西側モデル（震度7）を「標準」解像度・30 分で計算して撮影する。
 * 保存先: docs/screenshots/*.jpg（JPEG 品質 80 前後。1 枚あたり 400 KB 程度以下に収める）
 *   2d-inundation.jpg（2D の浸水）・hazard-overlay.jpg（公式ハザードマップ）・person-panel.jpg（人物の評価）・
 *   3d-view.jpg（3D）・mobile-map.jpg / mobile-sheet.jpg（スマートフォン）
 */
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const OUT_DIR = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
const MAX_BYTES = 400 * 1024;

/** 計算時間 [分]（相模トラフ西側モデルは 8 分に最大の波が来る） */
const DURATION_MIN = 30;

/** 人物を置く位置の目安（ここから北へ進んで最初の陸のセルに置く） */
const PEOPLE: { kind: 'elderly' | 'adult' | 'wheelchair'; lon: number; lat: number; name: string; startDelayMin?: number }[] = [
  { kind: 'elderly', lon: 139.4735, lat: 35.3115, name: '海岸近くの高齢者', startDelayMin: 10 },
  { kind: 'adult', lon: 139.4665, lat: 35.3135, name: '鵠沼海岸の大人' },
  { kind: 'wheelchair', lon: 139.4555, lat: 35.3145, name: '車いすの人' },
];

async function openApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('kugenuma-disclaimer-v1', '1');
    } catch {
      /* 無視 */
    }
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__app?.store);
  await page.waitForFunction(() => window.__app.store.get().terrain.status === 'ready', null, { timeout: 180_000, polling: 500 });
  const src = await page.evaluate(() => window.__app.store.get().terrain.grid!.source);
  expect(src, '実際の標高データ（国土地理院）で撮影する').not.toBe('synthetic');
}

/** 計算を実行して完了を待ち、陸の浸水セルが最も多い時刻 [秒] を返す */
async function runSimulation(page: Page): Promise<number> {
  await page.evaluate((duration) => {
    const { actions } = window.__app;
    actions.selectShindo('7');
    actions.updateParams({ durationMin: duration });
  }, DURATION_MIN);
  await page.waitForFunction(() => window.__app.store.get().terrain.status === 'ready', null, { timeout: 180_000 });
  await page.evaluate(() => window.__app.actions.runSimulation());
  await page.waitForFunction(() => ['done', 'error'].includes(window.__app.store.get().sim.status), null, { timeout: 600_000, polling: 1000 });
  expect(await page.evaluate(() => window.__app.store.get().sim.status)).toBe('done');
  return page.evaluate(() => {
    const s = window.__app.store.get();
    const out = s.sim.output!;
    const g = s.terrain.grid!;
    const depth = new Float32Array(g.kind.length);
    let best = 0;
    let bestT = 0;
    for (let t = 0; t <= out.durationSec; t += 30) {
      out.fillDepth(t, depth);
      let n = 0;
      for (let k = 0; k < depth.length; k++) if (g.kind[k] === 0 && depth[k] >= 0.05) n++;
      if (n > best) {
        best = n;
        bestT = t;
      }
    }
    return bestT;
  });
}

/** 指定位置から北へ進み、最初の陸のセル（標高 1 m 以上）に人物を置く */
async function placePeople(page: Page): Promise<string[]> {
  return page.evaluate((list) => {
    const s = window.__app.store.get();
    const g = s.terrain.grid!;
    const spec = g.spec;
    const cellAt = (lon: number, lat: number) => {
      const ws = 256 * 2 ** spec.zoom;
      const sn = Math.sin((lat * Math.PI) / 180);
      const px = ((lon + 180) / 360) * ws;
      const py = (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * ws;
      const i = Math.floor((px - spec.originPx) / spec.cellPx);
      const j = Math.floor((py - spec.originPy) / spec.cellPx);
      return i < 0 || j < 0 || i >= spec.nx || j >= spec.ny ? -1 : j * spec.nx + i;
    };
    const ids: string[] = [];
    for (const p of list) {
      let lat = p.lat;
      for (let n = 0; n < 200; n++, lat += 0.0002) {
        const k = cellAt(p.lon, lat);
        if (k >= 0 && g.kind[k] === 0 && g.z[k] >= 1) break;
      }
      const person = window.__app.actions.addPerson(p.kind, p.lon, lat);
      window.__app.actions.updatePerson(person.id, { name: p.name, ...(p.startDelayMin != null ? { startDelayMin: p.startDelayMin } : {}) });
      ids.push(person.id);
    }
    window.__app.actions.startPlacing(null);
    return ids;
  }, PEOPLE);
}

/** 2D 地図のタイル読み込みと描画の完了を待つ */
async function waitForMapIdle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = window.__map2d?.map;
        if (!map) return resolve();
        const done = () => resolve();
        const timer = setTimeout(done, 60_000);
        map.once('idle', () => {
          clearTimeout(timer);
          done();
        });
        map.triggerRepaint();
      }),
  );
  await page.waitForTimeout(1500);
}

/** 3D の地図タイル・建物の読み込みを待つ */
async function waitFor3D(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const info = document.getElementById('view-3d')?.__view3d?.debugInfo() as
            | { calls: number; basemap: { status: string } | null; buildings: { status: string } }
            | undefined;
          if (!info || info.calls === 0) return 'waiting';
          const base = info.basemap?.status ?? 'none';
          const bld = info.buildings.status;
          return base !== 'loading' && bld !== 'loading' && bld !== 'idle' ? 'ready' : 'waiting';
        }),
      { timeout: 300_000, intervals: [2000] },
    )
    .toBe('ready');
  await page.waitForTimeout(8000);
}

async function shoot(page: Page, name: string, quality = 80): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  let q = quality;
  for (;;) {
    const path = `${OUT_DIR}${name}`;
    await page.screenshot({ path, type: 'jpeg', quality: q, animations: 'disabled', caret: 'hide' });
    const size = statSync(path).size;
    if (size <= MAX_BYTES || q <= 50) {
      console.log(`${name}: ${(size / 1024).toFixed(0)} KB (quality ${q})`);
      return;
    }
    q -= 8;
  }
}

test.describe('デスクトップ', () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  test('2D の浸水・人物の評価・3D', async ({ page }) => {
    await openApp(page);
    await page.waitForFunction(() => window.__app.store.get().shelters.length > 0, null, { timeout: 60_000 });
    const ids = await placePeople(page);
    const tBest = await runSimulation(page);

    // (1) 2D の浸水（最も広く浸水している時刻）。辻堂〜江の島が入るよう少し引いて表示し、
    //     結果の要約が見えるよう「条件を調整する」を閉じる
    await page.evaluate((t) => {
      window.__app.actions.pause();
      window.__app.actions.seek(t);
      window.__map2d?.map.jumpTo({ center: [139.462, 35.3125], zoom: 13.45 });
    }, tBest);
    await page.locator('#panel-quake details.section-details > summary').click();
    await page.locator('#panel-quake .results').scrollIntoViewIfNeeded();
    await waitForMapIdle(page);
    await shoot(page, '2d-inundation.jpg');

    // (2) 公式ハザードマップ（神奈川県の津波浸水想定）を重ねた表示（計算の浸水は消す）
    await page.evaluate(() => {
      const { actions } = window.__app;
      actions.setLayer('simFlood', false);
      actions.setLayer('officialHazard', true);
    });
    await page.getByRole('tab', { name: 'レイヤー' }).click();
    await waitForMapIdle(page);
    await shoot(page, 'hazard-overlay.jpg');
    await page.evaluate(() => {
      const { actions } = window.__app;
      actions.setLayer('officialHazard', false);
      actions.setLayer('simFlood', true);
    });

    // (3) 人物の評価（海岸近くの高齢者を選択。避難の見通しと浸水深のグラフ）
    await page.getByRole('tab', { name: '人物' }).click();
    await page.evaluate(
      ({ id, t }) => {
        window.__app.actions.selectPerson(id);
        window.__app.actions.seek(t);
        window.__map2d?.map.jumpTo({ center: [139.4705, 35.3135], zoom: 14.3 });
      },
      { id: ids[0], t: Math.min(tBest, 11 * 60) },
    );
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const title = [...document.querySelectorAll('#panel-people .person-detail .group-title')].find((el) => el.textContent?.includes('避難の見通し'));
      title?.scrollIntoView({ block: 'start' });
    });
    await waitForMapIdle(page);
    await shoot(page, 'person-panel.jpg');

    // (4) 3D（写真の背景地図・建物）
    await page.evaluate((t) => {
      window.__app.actions.selectPerson(null);
      window.__app.actions.seek(t);
      window.__app.actions.setBasemap('photo');
      window.__app.actions.setView('3d');
    }, tBest);
    await page.getByRole('tab', { name: '地震・津波' }).click();
    await waitFor3D(page);
    await shoot(page, '3d-view.jpg');
  });
});

test.describe('スマートフォン', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test('スマートフォン表示', async ({ page }) => {
    await openApp(page);
    const tBest = await runSimulation(page);
    await page.evaluate((t) => {
      window.__app.actions.pause();
      window.__app.actions.seek(t);
      window.__map2d?.map.jumpTo({ center: [139.4685, 35.3135], zoom: 13.7 });
    }, tBest);
    // 出典の表示（MapLibre の折りたたみ式の出典）が地図を大きく覆う場合は閉じる（出典は README に記載）
    await page.evaluate(() => {
      const attrib = document.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show');
      (attrib?.querySelector('.maplibregl-ctrl-attrib-button') as HTMLElement | null)?.click();
    });
    await waitForMapIdle(page);
    await shoot(page, 'mobile-map.jpg', 78);

    // ボトムシート（地震・津波）を開いた状態
    await page.getByRole('tab', { name: '地震・津波' }).tap();
    await expect(page.locator('#sidebar')).toHaveAttribute('data-sheet', 'open');
    await page.waitForTimeout(800);
    await shoot(page, 'mobile-sheet.jpg', 78);
  });
});
