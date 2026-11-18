import { afterEach, describe, expect, it } from 'vitest';
import { startTelnetServer, type RunningServer } from '../../src/server/telnet.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { RawTelnetClient } from './client.js';

let env: TestEnv;
let server: RunningServer;
const clients: RawTelnetClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await server?.close();
  await env?.cleanup();
});

async function postFlow(port: number, handle: string, subject: string): Promise<void> {
  const client = await RawTelnetClient.connect(port);
  clients.push(client);
  await client.waitFor('Handle:');
  client.send(`${handle}\r\n`);
  await client.waitFor('passcode');
  client.send('pass1234\r\n');
  await client.waitFor('Re-enter');
  client.send('pass1234\r\n');
  await client.waitForPlain('MAIN MENU');
  client.send('1\r\n');
  await client.waitForPlain('MESSAGE BOARDS');
  client.send('1\r\n');
  await client.waitForPlain('BOARD:');
  client.send('N\r\n');
  await client.waitFor('Subject:');
  client.send(`${subject}\r\n`);
  await client.waitFor('Message');
  client.send('Concurrent body.\r\n');
  client.send('.\r\n');
  await client.waitForPlain('Thread posted.');
}

describe('concurrent writes', () => {
  it('two sessions posting at once both persist', async () => {
    env = await createTestEnv();
    server = await startTelnetServer({ port: 0, deps: env.deps });
    await Promise.all([
      postFlow(server.port, 'Alice', 'First concurrent post'),
      postFlow(server.port, 'Bob', 'Second concurrent post'),
    ]);
    const threads = await env.deps.boards.listThreads('general');
    const subjects = threads.map((t) => t.subject);
    expect(subjects).toContain('First concurrent post');
    expect(subjects).toContain('Second concurrent post');
    const users = [await env.deps.users.findUser('Alice'), await env.deps.users.findUser('Bob')];
    expect(users.every((u) => u !== null)).toBe(true);
  });
});
