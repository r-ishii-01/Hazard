import { defineConfig } from 'vite';

// base: './' so the built site works from any sub-path (GitHub Pages etc.)
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: true },
});
