import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4317, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4318', changeOrigin: false }, '/mcp': { target: 'http://127.0.0.1:4318', changeOrigin: false } } },
  build: { outDir: fileURLToPath(new URL('../dist/web', import.meta.url)), emptyOutDir: true, rollupOptions: { output: { manualChunks: { markdown: ['react-markdown', 'remark-gfm'], transfer: ['zod', 'fflate'], react: ['react', 'react-dom', 'react-router-dom'] } } } },
});
