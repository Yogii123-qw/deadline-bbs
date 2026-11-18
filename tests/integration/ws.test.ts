import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../../src/server/http.js';
import type { RunningServer } from '../../src/server/telnet.js';
import { createWsBridge } from '../../src/server/ws-bridge.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { WsClient, waitFor } from './client.js';

let env: TestEnv;
let server: RunningServer;
let publicDir: string;
let root: string;
const clients: WsClient[] = [];

async function boot(): Promise<number> {
  env = await createTestEnv({ 'GUIDE.TXT': 'Welcome to the file area.\n' });
  root = await mkdtemp(path.join(tmpdir(), 'deadline-web-'));
  publicDir = path.join(root, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<html>deadline</html>', 'utf8');
  const wss = createWsBridge(env.deps);
  server = await startHttpServer({
    port: 0,
    publicDir,
    filesDir: env.filesDir,
    onUpgrade: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
  });
  return server.port;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  await env?.cleanup();
  await rm(root, { recursive: true, force: true });
});

describe('websocket transport', () => {
  it('registers and navigates boards over WebSocket', async () => {
    const port = await boot();
    const client = await WsClient.connect(port);
    clients.push(client);
    await client.waitFor('Handle:');
    client.send('Alice\n');
    await client.waitFor('passcode');
    client.send('pass1234\n');
    await client.waitFor('Re-enter');
    client.send('pass1234\n');
    await client.waitForPlain('MAIN MENU');
    client.send('1\n');
    await client.waitForPlain('MESSAGE BOARDS');
    expect(env.deps.activeSessions.size).toBe(1);
  });

  it('handles resize frames and keeps the session working', async () => {
    const port = await boot();
    const client = await WsClient.connect(port);
    clients.push(client);
    await client.waitFor('Handle:');
    client.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    client.send('Alice\n');
    await client.waitFor('passcode');
    client.send('pass1234\n');
    await client.waitFor('Re-enter');
    client.send('pass1234\n');
    await client.waitForPlain('MAIN MENU');
    // A malformed resize frame is treated as input, not a crash.
    client.send('{"type":"resize","cols":"wide"}');
    client.send('\n');
    await client.waitForPlain('MAIN MENU');
  });

  it('repaints a compact greeting on a narrow resize before any input', async () => {
    const port = await boot();
    const client = await WsClient.connect(port);
    clients.push(client);
    await client.waitFor('Handle:');
    client.send(JSON.stringify({ type: 'resize', cols: 44, rows: 30 }));
    await client.waitForPlain('THE BOARD THAT REFUSES TO DIE');
    // The session still works after the repaint.
    client.send('Alice\n');
    await client.waitFor('passcode');
  });

  it('does not repaint once the user has typed', async () => {
    const port = await boot();
    const client = await WsClient.connect(port);
    clients.push(client);
    await client.waitFor('Handle:');
    client.send('A');
    await new Promise((r) => setTimeout(r, 100));
    client.send(JSON.stringify({ type: 'resize', cols: 44, rows: 30 }));
    await new Promise((r) => setTimeout(r, 200));
    const count = client.plain.split('THE BOARD THAT REFUSES TO DIE').length - 1;
    expect(count).toBe(0);
  });

  it('cleans up the session on close', async () => {
    const port = await boot();
    const client = await WsClient.connect(port);
    clients.push(client);
    await client.waitFor('Handle:');
    client.send('Alice\n');
    await client.waitFor('passcode');
    client.send('pass1234\n');
    await client.waitFor('Re-enter');
    client.send('pass1234\n');
    await client.waitForPlain('MAIN MENU');
    expect(env.deps.activeSessions.size).toBe(1);
    client.close();
    await waitFor(() => env.deps.activeSessions.size === 0, 3000, 'ws cleanup');
  });
});
