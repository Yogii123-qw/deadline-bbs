import { afterEach, describe, expect, it } from 'vitest';
import { startTelnetServer, type RunningServer } from '../../src/server/telnet.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { RawTelnetClient, waitFor } from './client.js';

let env: TestEnv;
let server: RunningServer;
const clients: RawTelnetClient[] = [];

async function boot(files?: Record<string, string>): Promise<number> {
  env = await createTestEnv(files);
  server = await startTelnetServer({ port: 0, deps: env.deps });
  return server.port;
}

async function connect(port: number): Promise<RawTelnetClient> {
  const client = await RawTelnetClient.connect(port);
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await server?.close();
  await env?.cleanup();
});

const FILES = { 'GUIDE.TXT': 'Welcome to the file area.\n' };

async function register(client: RawTelnetClient, handle: string, pass: string): Promise<void> {
  await client.waitFor('Handle:');
  client.send(`${handle}\r\n`);
  await client.waitFor('passcode');
  client.send(`${pass}\r\n`);
  await client.waitFor('Re-enter');
  client.send(`${pass}\r\n`);
  await client.waitForPlain('MAIN MENU');
}

describe('telnet transport', () => {
  it('sends the RFC 854 negotiation bundle on connect', async () => {
    const port = await boot();
    const client = await connect(port);
    await client.waitFor('Handle:');
    const bytes = client.bytes;
    expect([...bytes.subarray(0, 12)]).toEqual([
      255, 251, 1, 255, 251, 3, 255, 253, 3, 255, 253, 31,
    ]);
  });

  it('registers and logs in over raw TCP', async () => {
    const port = await boot();
    const client = await connect(port);
    await register(client, 'Alice', 'pass1234');
    expect(client.plain).toContain('Account created');
    expect(env.deps.activeSessions.size).toBe(1);
  });

  it('returns to the handle prompt on a wrong passcode', async () => {
    const port = await boot();
    await env.deps.users.createUser('Bob', 'hunter22', new Date());
    const client = await connect(port);
    await client.waitFor('Handle:');
    client.send('Bob\r\n');
    await client.waitFor('Passcode:');
    client.send('nope\r\n');
    await client.waitForPlain('Invalid handle or passcode');
  });

  it('posts a message that persists', async () => {
    const port = await boot();
    const client = await connect(port);
    await register(client, 'Alice', 'pass1234');
    client.send('1\r\n');
    await client.waitForPlain('MESSAGE BOARDS');
    client.send('1\r\n');
    await client.waitForPlain('BOARD:');
    client.send('N\r\n');
    await client.waitFor('Subject:');
    client.send('Socket post\r\n');
    await client.waitFor('Message');
    client.send('Posted over raw TCP.\r\n');
    client.send('.\r\n');
    await client.waitForPlain('Thread posted.');
    const threads = await env.deps.boards.listThreads('general');
    expect(threads[0].subject).toBe('Socket post');
  });

  it('searches and reads files over the socket', async () => {
    const port = await boot(FILES);
    const client = await connect(port);
    await register(client, 'Alice', 'pass1234');
    client.send('1\r\n');
    await client.waitForPlain('MESSAGE BOARDS');
    client.send('/\r\n');
    await client.waitFor('Query:');
    client.send('FidoNet\r\n');
    await client.waitForPlain('FidoNet echomail setup notes');
    client.send('Q\r\n');
    await client.waitForPlain('MESSAGE BOARDS');
    client.send('Q\r\n');
    await client.waitForPlain('MAIN MENU');
    client.send('2\r\n');
    await client.waitForPlain('FILE AREA');
    client.send('1\r\n');
    await client.waitForPlain('Welcome to the file area.');
  });

  it('tracks two callers and cleans up an abrupt disconnect', async () => {
    const port = await boot();
    const a = await connect(port);
    await register(a, 'Alice', 'pass1234');
    const b = await connect(port);
    await register(b, 'Bob', 'pass1234');
    expect(env.deps.activeSessions.size).toBe(2);
    a.send('5\r\n');
    await a.waitForPlain('2 callers online');
    b.destroy();
    await waitFor(() => env.deps.activeSessions.size === 1, 3000, 'session cleanup');
    a.send('\r\n');
    await a.waitForPlain('MAIN MENU');
    a.send('5\r\n');
    await a.waitForPlain('only caller');
  });

  it('answers split-packet IAC negotiation', async () => {
    const port = await boot();
    const client = await connect(port);
    await client.waitFor('Handle:');
    const before = client.bytes.length;
    client.sendBytes([255]);
    await new Promise((r) => setTimeout(r, 50));
    client.sendBytes([251, 3]);
    await waitFor(
      () => client.bytes.subarray(before).includes(Buffer.from([255, 253, 3])),
      3000,
      'DO SGA response',
    );
  });

  it('accepts NAWS and keeps the session working', async () => {
    const port = await boot();
    const client = await connect(port);
    await client.waitFor('Handle:');
    client.sendBytes([255, 250, 31, 0, 100, 0, 30, 255, 240]);
    await register(client, 'Alice', 'pass1234');
    expect(env.deps.activeSessions.size).toBe(1);
  });

  it('repaints a compact greeting on narrow NAWS before any input', async () => {
    const port = await boot();
    const client = await connect(port);
    await client.waitFor('Handle:');
    client.sendBytes([255, 250, 31, 0, 44, 0, 30, 255, 240]);
    await client.waitForPlain('THE BOARD THAT REFUSES TO DIE');
    await register(client, 'Alice', 'pass1234');
  });

  it('closes the connection on logoff', async () => {
    const port = await boot();
    const client = await connect(port);
    await register(client, 'Alice', 'pass1234');
    client.send('G\r\n');
    await client.waitForPlain('Goodbye, Alice');
    await waitFor(() => client.isClosed, 3000, 'socket close after logoff');
  });
});
