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
    // One PBKDF2-HMAC-SHA256 hash (600,000 iterations, OWASP minimum)
    // costs ~2.9s on this VM, and a single test can hash several times
    // (register + login + migration). The 5s default therefore fails
    // slow machines with false-positive timeouts, not logic errors:
    // audit 19 Nov 2026: npm test 288/351, --testTimeout=20000 349/351.
    // 30s gives the slowest real-socket test (~18s alone) headroom.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Bound the worker count: the default spawns one worker per test
    // file (29 here), and 29 PBKDF2-heavy workers on a 1.5-CPU machine
    // starve each other so badly that even a 30s timeout fails
    // (audit 19 Nov 2026: npm test default 348/351, the federated
    // Hall of Fame test alone took 30.5s). Two workers keep the suite
    // green on slow machines; fast machines can pass --maxWorkers.
    maxWorkers: 2,
  },
});
