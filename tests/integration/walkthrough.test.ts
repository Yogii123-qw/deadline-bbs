import { afterEach, describe, expect, it } from 'vitest';
import { startTelnetServer, type RunningServer } from '../../src/server/telnet.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { RawTelnetClient, waitFor } from './client.js';

/**
 * Headless walkthrough (design §8.4): one complete session from connect to
 * logoff over a real TCP socket, touching every main feature and asserting
 * each produces non-empty, expected output.
 */
describe('headless walkthrough', () => {
  let env: TestEnv;
  let server: RunningServer;
  let client: RawTelnetClient;

  afterEach(async () => {
    client?.destroy();
    await server?.close();
    await env?.cleanup();
  });

  it('walks the whole board: register, read, post, reply, search, files, game, logoff', async () => {
    env = await createTestEnv({ 'GUIDE.TXT': 'Walkthrough file content.\n' });
    server = await startTelnetServer({ port: 0, deps: env.deps });
    client = await RawTelnetClient.connect(server.port);

    // Connect + register.
    await client.waitForPlain('REFUSES TO DIE');
    await client.waitFor('Handle:');
    client.send('Walker\r\n');
    await client.waitFor('passcode');
    client.send('pass1234\r\n');
    await client.waitFor('Re-enter');
    client.send('pass1234\r\n');
    await client.waitForPlain('MAIN MENU');

    // Boards: read an archive thread.
    client.send('1\r\n');
    await client.waitForPlain('General Discussion');
    client.send('1\r\n');
    await client.waitForPlain('BOARD:');
    client.send('1\r\n');
    await client.waitForPlain('[ARCHIVE - 1994]');
    client.send('Q\r\n');
    await client.waitForPlain('BOARD:');

    // Post a new thread.
    client.send('N\r\n');
    await client.waitFor('Subject:');
    client.send('Walkthrough post\r\n');
    await client.waitFor('Message');
    client.send('Hello from the walkthrough.\r\n');
    client.send('.\r\n');
    await client.waitForPlain('Thread posted.');
    await client.waitForPlain('Walkthrough post');

    // Reply to it.
    client.send('1\r\n');
    await client.waitForPlain('Hello from the walkthrough.');
    client.send('R\r\n');
    await client.waitFor('Message');
    client.send('A reply, also from the walkthrough.\r\n');
    client.send('.\r\n');
    await client.waitForPlain('Reply posted.');
    client.send('Q\r\n');
    await client.waitForPlain('BOARD:');
    client.send('Q\r\n');
    await client.waitForPlain('MESSAGE BOARDS');

    // Search.
    client.send('/\r\n');
    await client.waitFor('Query:');
    client.send('walkthrough\r\n');
    await client.waitForPlain('Walkthrough post');
    client.send('Q\r\n');
    await client.waitForPlain('MESSAGE BOARDS');
    client.send('Q\r\n');
    await client.waitForPlain('MAIN MENU');

    // Files.
    client.send('2\r\n');
    await client.waitForPlain('GUIDE.TXT');
    client.send('1\r\n');
    await client.waitForPlain('Walkthrough file content.');
    client.send('Q\r\n');
    await client.waitForPlain('FILE AREA');
    client.send('Q\r\n');
    await client.waitForPlain('MAIN MENU');

    // CATACOMB: rest once (always safe), then leave.
    client.send('3\r\n');
    await client.waitForPlain('CATACOMB');
    client.send('R\r\n');
    await client.waitForPlain('rest in a shadowy alcove');
    client.send('Q\r\n');
    await client.waitForPlain('MAIN MENU');

    // Hall of Fame (empty) + Who's Online (solo).
    client.send('4\r\n');
    await client.waitForPlain('Hall of Fame is empty');
    client.send('\r\n');
    await client.waitForPlain('MAIN MENU');
    client.send('5\r\n');
    await client.waitForPlain('only caller');
    client.send('\r\n');
    await client.waitForPlain('MAIN MENU');

    // Logoff closes the connection.
    client.send('G\r\n');
    await client.waitForPlain('Goodbye, Walker');
    await waitFor(() => client.isClosed, 3000, 'socket close after logoff');

    // The server is still alive for the next caller.
    const second = await RawTelnetClient.connect(server.port);
    try {
      await second.waitFor('Handle:');
    } finally {
      second.destroy();
    }
  }, 20000);
});
