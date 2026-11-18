import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../../src/server/http.js';
import type { RunningServer } from '../../src/server/telnet.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

let env: TestEnv;
let server: RunningServer;
let root: string;
let publicDir: string;

async function boot(): Promise<number> {
  env = await createTestEnv({ 'GUIDE.TXT': 'Welcome to the file area.\n' });
  root = await mkdtemp(path.join(tmpdir(), 'deadline-http-'));
  publicDir = path.join(root, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<html>deadline</html>', 'utf8');
  await writeFile(path.join(publicDir, 'app.js'), 'console.log(1);', 'utf8');
  server = await startHttpServer({
    port: 0,
    publicDir,
    filesDir: env.filesDir,
    onUpgrade: (_req, socket) => socket.destroy(),
  });
  return server.port;
}

afterEach(async () => {
  await server?.close();
  await env?.cleanup();
  await rm(root, { recursive: true, force: true });
});

describe('http server', () => {
  it('serves the web client entry and assets', async () => {
    const port = await boot();
    const home = await fetch(`http://127.0.0.1:${port}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(await home.text()).toContain('deadline');
    const js = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('returns 404 for unknown paths', async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/nope.txt`);
    expect(res.status).toBe(404);
  });

  it('serves file downloads with attachment disposition', async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/files/GUIDE.TXT`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('GUIDE.TXT');
    expect(await res.text()).toBe('Welcome to the file area.\n');
  });

  it('rejects download traversal with 404', async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/files/%2e%2e%2fSECRET.TXT`);
    expect(res.status).toBe(404);
    const missing = await fetch(`http://127.0.0.1:${port}/files/MISSING.TXT`);
    expect(missing.status).toBe(404);
  });

  it('rejects non-GET/HEAD methods', async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('answers HEAD without a body', async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('destroys upgrade requests to unknown paths', async () => {
    const port = await boot();
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write(
          'GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      socket.on('close', () => resolve(true));
      socket.on('error', () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    expect(closed).toBe(true);
  });

  it('reports 503 on / when the client was never built', async () => {
    env = await createTestEnv();
    root = await mkdtemp(path.join(tmpdir(), 'deadline-http-'));
    const emptyPublic = path.join(root, 'empty');
    await mkdir(emptyPublic, { recursive: true });
    server = await startHttpServer({
      port: 0,
      publicDir: emptyPublic,
      filesDir: env.filesDir,
      onUpgrade: (_req, socket) => socket.destroy(),
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('npm run build');
  });
});
