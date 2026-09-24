/**
 * README 用のスクリーンショットを撮る設定（通常の E2E テストとは別）。
 *
 *   npm run screenshots
 *
 * 実際の地理院タイル・OpenFreeMap の建物などをインターネットから読み込んで撮影し、
 * docs/screenshots/*.jpg に保存する（E2E テストと違い、外部への通信を差し替えない）。
 *
 * HTTPS プロキシの内側で実行する場合は、環境変数 HTTPS_PROXY を設定する。プロキシが独自の CA 証明書で
 * TLS を中継する場合は、その証明書（PEM）のパスを PROXY_CA_CERT に指定すると、その CA の公開鍵だけを
 * 信頼する（--ignore-certificate-errors-spki-list。TLS の検証を丸ごと無効にはしない）。
 */
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT) || 5190;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** CA 証明書の公開鍵（SPKI）の SHA-256（Base64）。Chromium の --ignore-certificate-errors-spki-list 用 */
function spkiHash(pemPath: string): string {
  const cert = new X509Certificate(readFileSync(pemPath));
  const der = cert.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || '';
/** GPU の無い環境でも WebGL を使う（playwright.config.ts と同じ） */
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
if (proxyServer && process.env.PROXY_CA_CERT) args.push(`--ignore-certificate-errors-spki-list=${spkiHash(process.env.PROXY_CA_CERT)}`);
// Playwright はプロキシ指定時にループバック（127.0.0.1）もプロキシ経由にする。開発サーバーには直接つなぐ
if (proxyServer) process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';

export default defineConfig({
  testDir: './screenshots',
  testMatch: /.*\.shot\.ts$/,
  workers: 1,
  timeout: 900_000,
  expect: { timeout: 120_000 },
  reporter: [['list']],
  outputDir: '../test-results/screenshots',
  use: {
    baseURL: BASE_URL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    // 静止画なので、揺れ・さざ波などの動きを止める
    contextOptions: { reducedMotion: 'reduce' },
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
    launchOptions: {
      args,
      ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    },
  },
  webServer: {
    command: 'npx vite --config e2e/vite.config.ts',
    cwd: '..',
    url: BASE_URL,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
