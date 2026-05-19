import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Emit alongside the package; the root build copies `web/dist/` →
    // `dist/web/` so the installed binary can resolve it relative to
    // `dist/bin/yaao.js`.
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // The dev server proxies /api/* to the local yaao web instance so the
    // React app and the hono backend feel like one origin during development.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
