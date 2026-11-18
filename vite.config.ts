import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/files': 'http://localhost:8080',
    },
  },
  // Vitest must run from the repo root, not the web/ root above.
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
  },
});
