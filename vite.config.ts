import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `npm run dev` runs the Vite dev server for the UI and proxies /api + /ws to the
 * local Worker (`npm run worker:dev`, port 8787) so the two can be developed
 * together with a single origin.
 *
 * `npm run build` emits `dist/`, which the Worker serves through the ASSETS binding.
 * `VITE_API_BASE` is baked in at build time: leave it empty for the Worker build,
 * point it at the Worker URL for the static GitHub Pages build.
 */
export default defineConfig(({ mode }) => {
  const apiBase = process.env.VITE_API_BASE ?? '';
  return {
    plugins: [react()],
    base: process.env.VITE_BASE ?? '/',
    define: {
      __API_BASE__: JSON.stringify(apiBase),
      __BUILD_MODE__: JSON.stringify(mode),
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      target: 'es2022',
      chunkSizeWarningLimit: 700,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
        '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      },
    },
  };
});
