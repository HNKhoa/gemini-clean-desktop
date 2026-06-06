import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React + MUI frontend. The watermark engine lives in public/engine and is
// loaded at runtime as raw ES modules (NOT bundled by Vite) so the validated
// extension engine is reused unchanged. /api is proxied to the FastAPI backend
// in dev; in production FastAPI serves the built app + /engine itself.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
