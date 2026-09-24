/**
 * Playwright（E2E テスト）の設定。
 *
 *   npm run e2e            … 開発サーバー（ポート 5190）を起動して e2e/*.spec.ts を実行
 *   npx playwright test --ui  … 対話的に実行
 *
 * - テストはインターネットに接続しない（外部タイル等は e2e/fixtures.ts で代替データに差し替える）。
 * - WebGL（MapLibre・three.js）は GPU の無い環境でも動くよう SwiftShader（ソフトウェア描画）を使う。
 *   ソフトウェア描画と津波の計算は CPU を多く使うため、テストは 1 本ずつ順に実行し、時間制限は長めにしている。
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT) || 5190;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** GPU の無い環境で WebGL を使うための Chromium の起動オプション */
export const WEBGL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: WEBGL_ARGS },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions: { args: WEBGL_ARGS } },
    },
  ],
  webServer: {
    command: 'npx vite --config e2e/vite.config.ts',
    url: BASE_URL,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
