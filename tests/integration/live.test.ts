import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newCharacter } from '../../src/game/catacomb.js';
import { todayLocal } from '../../src/session/engine.js';
import { startHttpServer } from '../../src/server/http.js';
import { startTelnetServer, type RunningServer } from '../../src/server/telnet.js';
import { createWsBridge } from '../../src/server/ws-bridge.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { attachSync } from '../sync-helpers.js';
import { RawTelnetClient, WsClient } from './client.js';

let env: TestEnv;
let telnetServer: RunningServer;
let httpServer: RunningServer;
let webRoot: string;
const telnetClients: RawTelnetClient[] = [];
const wsClients: WsClient[] = [];

async function boot(): Promise<{ telnetPort: number; httpPort: number }> {
  env = await createTestEnv();
  await attachSync(env, 'node-live');
  webRoot = await mkdtemp(path.join(tmpdir(), 'deadline-web-'));
  const publicDir = path.join(webRoot, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<html>deadline</html>', 'utf8');
  const wss = createWsBridge(env.deps);
  httpServer = await startHttpServer({
    port: 0,
    publicDir,
    filesDir: env.filesDir,
    onUpgrade: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
  });
  telnetServer = await startTelnetServer({ port: 0, deps: env.deps });
  return { telnetPort: telnetServer.port, httpPort: httpServer.port };
}

afterEach(async () => {
  for (const c of telnetClients.splice(0)) c.destroy();
  for (const c of wsClients.splice(0)) c.close();
  await telnetServer?.close();
  await httpServer?.close();
  await env?.cleanup();
  await rm(webRoot, { recursive: true, force: true });
});

async function registerTelnet(port: number, handle: string): Promise<RawTelnetClient> {
  const c = await RawTelnetClient.connect(port);
  telnetClients.push(c);
  await c.waitFor('Handle:');
  c.send(`${handle}\n`);
  await c.waitFor('passcode');
  c.send('pass1234\n');
  await c.waitFor('Re-enter');
  c.send('pass1234\n');
  await c.waitForPlain('MAIN MENU');
  return c;
}

async function loginTelnet(port: number, handle: string): Promise<RawTelnetClient> {
  const c = await RawTelnetClient.connect(port);
  telnetClients.push(c);
  await c.waitFor('Handle:');
  c.send(`${handle}\n`);
  await c.waitFor('Passcode:');
  c.send('pass1234\n');
  await c.waitForPlain('MAIN MENU');
  return c;
}

async function registerWs(port: number, handle: string): Promise<WsClient> {
  const c = await WsClient.connect(port);
  wsClients.push(c);
  await c.waitFor('Handle:');
  c.send(`${handle}\n`);
  await c.waitFor('passcode');
  c.send('pass1234\n');
  await c.waitFor('Re-enter');
  c.send('pass1234\n');
  await c.waitForPlain('MAIN MENU');
  return c;
}

async function postThread(
  c: RawTelnetClient | WsClient,
  subject: string,
  body: string,
): Promise<void> {
  c.send('1\n');
  await c.waitForPlain('MESSAGE BOARDS');
  c.send('1\n');
  await c.waitForPlain('BOARD:');
  c.send('N\n');
  await c.waitFor('Subject:');
  c.send(`${subject}\n`);
  await c.waitFor('Message (end with .):');
  c.send(`${body}\n`);
  c.send('.\n');
  await c.waitForPlain('Thread posted.');
}

describe('live board over real sockets', () => {
  it('two telnet callers: post broadcast, presence join/leave, no self-notice', async () => {
    const { telnetPort } = await boot();
    const a = await registerTelnet(telnetPort, 'Alice');
    const b = await registerTelnet(telnetPort, 'Bob');
    await a.waitForPlain('Bob just called in');
    expect(b.plain).not.toContain('just called in');
    await postThread(a, 'Socket Subject', 'socket body');
    await b.waitForPlain('Alice');
    await b.waitForPlain('posted "Socket Subject"');
    expect(b.plain).toContain('» LIVE:');
    await new Promise((r) => setTimeout(r, 200));
    expect(a.plain).not.toContain('posted "Socket Subject"');
    b.destroy();
    await a.waitForPlain('Bob hung up.');
  });

  it('two WebSocket callers: post broadcast', async () => {
    const { httpPort } = await boot();
    const a = await registerWs(httpPort, 'Alice');
    const b = await registerWs(httpPort, 'Bob');
    await a.waitForPlain('Bob just called in');
    await postThread(a, 'WS Subject', 'ws body');
    await b.waitForPlain('posted "WS Subject"');
    expect(b.plain).toContain('» LIVE:');
  });

  it('chat crosses transports in both directions', async () => {
    const { telnetPort, httpPort } = await boot();
    const a = await registerTelnet(telnetPort, 'Alice');
    const b = await registerWs(httpPort, 'Bob');
    a.send('6 Bob hello from telnet\n');
    await a.waitForPlain('Message sent to Bob.');
    await b.waitForPlain('CHAT from Alice');
    expect(b.plain).toContain('hello from telnet');
    b.send('6 Alice hello from web\n');
    await b.waitForPlain('Message sent to Alice.');
    await a.waitForPlain('CHAT from Bob');
    expect(a.plain).toContain('hello from web');
  });

  it('pre-login sessions receive no live notices', async () => {
    const { telnetPort } = await boot();
    const watcher = await RawTelnetClient.connect(telnetPort);
    telnetClients.push(watcher);
    await watcher.waitFor('Handle:');
    const a = await registerTelnet(telnetPort, 'Alice');
    await postThread(a, 'Unseen Subject', 'unseen body');
    await new Promise((r) => setTimeout(r, 600));
    expect(watcher.plain).not.toContain('LIVE:');
    expect(watcher.plain).not.toContain('Unseen Subject');
  });

  it('reply broadcast reaches the other caller', async () => {
    const { telnetPort } = await boot();
    const a = await registerTelnet(telnetPort, 'Alice');
    const b = await registerTelnet(telnetPort, 'Bob');
    await postThread(a, 'Reply Subject', 'original body');
    b.send('1\n');
    await b.waitForPlain('MESSAGE BOARDS');
    b.send('1\n');
    await b.waitForPlain('BOARD:');
    b.send('1\n');
    await b.waitForPlain('THREAD:');
    b.send('R\n');
    await b.waitFor('Message (end with .):');
    b.send('a reply from Bob\n');
    b.send('.\n');
    await b.waitForPlain('Reply posted.');
    await a.waitForPlain('replied to "Reply Subject"');
    expect(a.plain).toContain('Bob');
  });

  it('victory broadcast reaches the other caller', async () => {
    const { telnetPort } = await boot();
    env.setRng(() => 0.5);
    const user = await env.deps.users.createUser('Alice', 'pass1234', new Date());
    const strong = {
      ...newCharacter(user.id, todayLocal(env.deps.now())),
      hp: 100,
      maxHp: 100,
      attack: 30,
      defense: 10,
      level: 5,
      dungeonDepth: 5,
    };
    await env.deps.users.saveCharacter(user.id, strong);
    const b = await registerTelnet(telnetPort, 'Bob');
    const a = await loginTelnet(telnetPort, 'Alice');
    a.send('3\n');
    await a.waitForPlain('CATACOMB');
    a.send('E\n');
    await a.waitForPlain('Crypt Lord');
    a.send('A\n');
    a.send('A\n');
    await a.waitForPlain('VICTORY');
    await b.waitForPlain('slew the Crypt Lord');
    expect(b.plain).toContain('Alice');
  });

  it('a partial menu choice survives a live notice byte-for-byte', async () => {
    const { telnetPort } = await boot();
    const a = await registerTelnet(telnetPort, 'Alice');
    const b = await registerTelnet(telnetPort, 'Bob');
    await b.waitFor('Choice: ');
    b.send('1');
    await b.waitFor('Choice: 1');
    await postThread(a, 'Interrupt Subject', 'interrupt body');
    await b.waitForPlain('posted "Interrupt Subject"');
    // The frame used erase-line, and the prompt + partial input were redrawn.
    expect(b.bytes.includes(Buffer.from('\x1b[2K', 'latin1'))).toBe(true);
    const occurrences = b.text.split('Choice: 1').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    b.send('\n');
    await b.waitForPlain('MESSAGE BOARDS');
  });

  it('a partial chat command survives a live notice and delivers whole', async () => {
    const { telnetPort } = await boot();
    const a = await registerTelnet(telnetPort, 'Alice');
    const b = await registerTelnet(telnetPort, 'Bob');
    await b.waitFor('Choice: ');
    b.send('6 Alice hel');
    await b.waitFor('Choice: 6 Alice hel');
    await postThread(a, 'Chat Interrupt', 'chat interrupt body');
    await b.waitForPlain('posted "Chat Interrupt"');
    b.send('lo there\n');
    await b.waitForPlain('Message sent to Alice.');
    await a.waitForPlain('CHAT from Bob');
    expect(a.plain).toContain('hello there');
  });
});
