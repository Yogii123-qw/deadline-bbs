import { afterEach, describe, expect, it } from 'vitest';
import { SessionDriver } from '../helpers.js';
import { bootNode, type BootedNode } from '../sync-helpers.js';
import { RawTelnetClient, WsClient } from './client.js';

async function waitForAsync(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const nodes: BootedNode[] = [];
const telnetClients: RawTelnetClient[] = [];
const wsClients: WsClient[] = [];

afterEach(async () => {
  for (const c of telnetClients.splice(0)) c.destroy();
  for (const c of wsClients.splice(0)) c.close();
  for (const n of nodes.splice(0)) {
    await n.stop();
  }
});

async function boot(opts: Parameters<typeof bootNode>[0]): Promise<BootedNode> {
  const node = await bootNode(opts);
  nodes.push(node);
  return node;
}

async function registerTelnet(node: BootedNode, handle: string): Promise<RawTelnetClient> {
  const c = await RawTelnetClient.connect(node.telnetPort);
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

async function postThreadViaTelnet(
  c: RawTelnetClient,
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

async function postThreadViaDriver(
  node: BootedNode,
  handle: string,
  subject: string,
  body: string,
): Promise<void> {
  const d = new SessionDriver(node.env.deps);
  await d.register(handle, 'pass1234');
  await d.send('1');
  await d.send('1');
  await d.send('N');
  await d.send(subject);
  await d.send(body);
  const out = await d.sendText('.');
  expect(out).toContain('Thread posted.');
}

function userThreads(node: BootedNode, boardId = 'general') {
  return node.env.deps.boards
    .listThreads(boardId)
    .then((threads) => threads.filter((t) => !t.id.startsWith('seed-thread-')));
}

describe('federation between real nodes', () => {
  it('(a) a post on A appears on B, and B callers see it live with its origin node', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    const observer = await registerTelnet(b, 'Observer');
    const poster = await registerTelnet(a, 'Alice');
    await postThreadViaTelnet(poster, 'Federated Hello', 'hello from node A');
    await a.engine.syncWith(b.baseUrl);
    const threads = await userThreads(b);
    expect(threads.map((t) => t.subject)).toContain('Federated Hello');
    const thread = threads.find((t) => t.subject === 'Federated Hello');
    expect(thread?.posts[0].body).toBe('hello from node A');
    await observer.waitForPlain('posted "Federated Hello"');
    expect(observer.plain).toContain('(via node node-a)');
  }, 30000);

  it('(b) a post on B appears on A', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    const poster = await registerTelnet(b, 'Bob');
    await postThreadViaTelnet(poster, 'Hello From B', 'hello from node B');
    await b.engine.syncWith(a.baseUrl);
    const threads = await userThreads(a);
    expect(threads.map((t) => t.subject)).toContain('Hello From B');
    expect(threads.find((t) => t.subject === 'Hello From B')?.posts[0].body).toBe(
      'hello from node B',
    );
  }, 30000);

  it('(c) B offline, post on A, B restarts: the queued post arrives exactly once', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const bDown = await bootNode({ nodeId: 'node-b' });
    const reuse = { root: bDown.env.root, dataDir: bDown.env.dataDir, filesDir: bDown.env.filesDir };
    await bDown.stopServers();
    // B is down. A posts while nobody can reach B.
    const poster = await registerTelnet(a, 'Alice');
    await postThreadViaTelnet(poster, 'Queued While Down', 'posted while B was offline');
    // B comes back with the same data dir and node id: startup sync pulls it.
    const bUp = await boot({
      nodeId: 'node-b',
      peers: [a.baseUrl],
      autoStart: true,
      reuse,
    });
    await waitForAsync(
      async () => (await userThreads(bUp)).some((t) => t.subject === 'Queued While Down'),
      8000,
      'queued post to arrive on restarted B',
    );
    const threads = await userThreads(bUp);
    expect(threads.filter((t) => t.subject === 'Queued While Down')).toHaveLength(1);
    // Another full round changes nothing.
    await bUp.engine.syncAll();
    expect((await userThreads(bUp)).filter((t) => t.subject === 'Queued While Down')).toHaveLength(1);
    expect((await bUp.syncLog.read()).entries).toHaveLength(1);
  }, 15000);

  it('(d) running the same sync twice never duplicates', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    await postThreadViaDriver(a, 'Alice', 'Twice Synced', 'synced twice body');
    await a.engine.syncWith(b.baseUrl);
    await a.engine.syncWith(b.baseUrl);
    const threads = await userThreads(b);
    expect(threads.filter((t) => t.subject === 'Twice Synced')).toHaveLength(1);
    expect((await b.syncLog.read()).entries).toHaveLength(1);
    // Direct re-apply of the same entries is all duplicates.
    const log = await a.syncLog.read();
    const result = await b.engine.applyRemote(log.entries);
    expect(result).toMatchObject({ applied: 0, duplicates: 1 });
    expect((await userThreads(b)).filter((t) => t.subject === 'Twice Synced')).toHaveLength(1);
  }, 30000);

  it('(e) a 3-node ring converges, stays stable, and terminates', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    const c = await boot({ nodeId: 'node-c' });
    await postThreadViaDriver(a, 'Alice', 'Ring Post A', 'from A');
    await postThreadViaDriver(c, 'Carol', 'Ring Post C', 'from C');

    const ringRound = async (): Promise<void> => {
      await a.engine.syncWith(b.baseUrl);
      await b.engine.syncWith(c.baseUrl);
      await c.engine.syncWith(a.baseUrl);
    };
    const snapshot = async (): Promise<number[][]> => {
      const out: number[][] = [];
      for (const node of [a, b, c]) {
        const threads = await userThreads(node);
        const log = await node.syncLog.read();
        out.push([threads.length, log.entries.length, log.pending.length]);
      }
      return out;
    };

    await ringRound();
    await ringRound();
    const converged = await snapshot();
    for (const [threads, entries, pending] of converged) {
      expect(threads).toBe(2);
      expect(entries).toBe(2);
      expect(pending).toBe(0);
    }
    for (const node of [a, b, c]) {
      const subjects = (await userThreads(node)).map((t) => t.subject).sort();
      expect(subjects).toEqual(['Ring Post A', 'Ring Post C']);
    }
    // More rounds: nothing grows, nothing loops. Rounds terminate (each
    // awaited syncWith returns) and the state is a fixed point.
    await ringRound();
    await ringRound();
    expect(await snapshot()).toEqual(converged);
  }, 15000);
});
