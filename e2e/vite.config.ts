/**
 * E2E テスト用の Vite 設定（playwright.config.ts の webServer から使う）。
 *
 * - 通常の vite.config.ts を土台に、ポート 5190 に固定する。
 * - HMR は無効（他の作業でファイルが変わっても、テスト中のページが再読み込みされないように）。
 * - 依存関係の事前バンドルのキャッシュは専用のディレクトリに置く（開発サーバーを同時に動かしても競合しない）。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';

export const E2E_PORT = Number(process.env.E2E_PORT) || 5190;

const root = fileURLToPath(new URL('..', import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    root,
    cacheDir: fileURLToPath(new URL('../node_modules/.vite-e2e', import.meta.url)),
    clearScreen: false,
    server: { host: '127.0.0.1', port: E2E_PORT, strictPort: true, hmr: false },
    preview: { host: '127.0.0.1', port: E2E_PORT, strictPort: true },
  }),
);
