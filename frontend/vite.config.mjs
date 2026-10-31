import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4173', ws: true },
      '/live': { target: 'http://127.0.0.1:4173' },
      '/vendor/novnc': { target: 'http://127.0.0.1:4173' },
      '/mcp': { target: 'http://127.0.0.1:4173' },
    },
  },
});
