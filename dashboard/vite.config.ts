import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * The gateway serves the built SPA under `/dashboard/` (see the second
 * fastifyStatic registration in `src/main.ts`), so every emitted asset URL is
 * prefixed with `/dashboard/`. The same base is used in dev to keep the dev
 * server and production routing identical.
 *
 * The API is same-origin in production. In dev the SPA talks to the gateway on
 * `localhost:3400` through Vite's proxy (no CORS involved).
 */
export default defineConfig({
  base: '/dashboard/',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/admin': {
        target: 'http://localhost:3400',
        changeOrigin: true,
      },
      '/v1': {
        target: 'http://localhost:3400',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist-dashboard',
    emptyOutDir: true,
  },
});
