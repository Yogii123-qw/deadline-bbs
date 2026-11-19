import { afterEach, describe, expect, it } from 'vitest';
import { SessionDriver } from '../helpers.js';
import { bootNode, type BootedNode } from '../sync-helpers.js';
import { RawTelnetClient, waitFor } from './client.js';

const nodes: BootedNode[] = [];
const telnetClients: RawTelnetClient[] = [];

afterEach(async () => {
  for (const c of telnetClients.splice(0)) c.destroy();
  for (const n of nodes.splice(0)) {
    await n.stop();
  }
});

async function boot(opts: Parameters<typeof bootNode>[0]): Promise<BootedNode> {
  const node = await bootNode(opts);
  nodes.push(node);
  return node;
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

describe('read-only JSON API', () => {
  it('lists boards, threads, and single threads', async () => {
    const node = await boot({ nodeId: 'node-api' });
    const boardsRes = await fetch(`${node.baseUrl}/api/boards`);
    expect(boardsRes.status).toBe(200);
    const boardsBody = (await boardsRes.json()) as { boards: Array<{ id: string; name: string }> };
    expect(boardsBody.boards.map((b) => b.id).sort()).toEqual(['crypt', 'games', 'general', 'tech']);

    const threadsRes = await fetch(`${node.baseUrl}/api/boards/general/threads`);
    expect(threadsRes.status).toBe(200);
    const threadsBody = (await threadsRes.json()) as {
      board: { id: string };
      threads: Array<{ id: string; subject: string; posts: Array<{ body: string }> }>;
    };
    expect(threadsBody.board.id).toBe('general');
    expect(threadsBody.threads.length).toBeGreaterThan(0);
    const first = threadsBody.threads[0];
    expect(first.posts.length).toBeGreaterThan(0);

    const threadRes = await fetch(`${node.baseUrl}/api/threads/${first.id}`);
    expect(threadRes.status).toBe(200);
    const threadBody = (await threadRes.json()) as { thread: { id: string; subject: string } };
    expect(threadBody.thread.id).toBe(first.id);
    expect(threadBody.thread.subject).toBe(first.subject);

    expect((await fetch(`${node.baseUrl}/api/boards/nope/threads`)).status).toBe(404);
    expect((await fetch(`${node.baseUrl}/api/threads/nope`)).status).toBe(404);
    expect((await fetch(`${node.baseUrl}/api/unknown`)).status).toBe(404);
  });

  it('status reports counts and the peer count, never peer URLs', async () => {
    const node = await boot({ nodeId: 'node-api', peers: ['http://127.0.0.1:9999'] });
    const res = await fetch(`${node.baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      nodeId: string;
      boards: number;
      threads: number;
      posts: number;
      peers: number;
    };
    expect(body.nodeId).toBe('node-api');
    expect(body.boards).toBe(4);
    expect(body.threads).toBe(8);
    expect(body.posts).toBeGreaterThanOrEqual(8);
    expect(body.peers).toBe(1);
    expect(text).not.toContain('127.0.0.1:9999');
  });

  it('(f) the API returns exactly what the terminal shows', async () => {
    const node = await boot({ nodeId: 'node-api' });
    const subject = 'API Equality Subject';
    const body = 'the same words in both places';
    await postThreadViaDriver(node, 'Alice', subject, body);

    const threadsRes = await fetch(`${node.baseUrl}/api/boards/general/threads`);
    const threadsBody = (await threadsRes.json()) as {
      threads: Array<{ subject: string; posts: Array<{ body: string; authorHandle: string }> }>;
    };
    const viaApi = threadsBody.threads.find((t) => t.subject === subject);
    expect(viaApi).toBeDefined();
    expect(viaApi?.posts[0].body).toBe(body);
    expect(viaApi?.posts[0].authorHandle).toBe('Alice');

    // The same thread, read through a real terminal session.
    const c = await RawTelnetClient.connect(node.telnetPort);
    telnetClients.push(c);
    await c.waitFor('Handle:');
    c.send('Reader\n');
    await c.waitFor('passcode');
    c.send('pass1234\n');
    await c.waitFor('Re-enter');
    c.send('pass1234\n');
    await c.waitForPlain('MAIN MENU');
    c.send('1\n');
    await c.waitForPlain('MESSAGE BOARDS');
    c.send('1\n');
    await c.waitForPlain('BOARD:');
    c.send('1\n');
    // The subject also appears in the thread list, so wait for the body
    // text, which only the thread view shows.
    await c.waitForPlain(body);
    expect(c.plain).toContain(subject);
    expect(c.plain).toContain('Alice');
  }, 30000);

  it('rejects non-GET methods on read endpoints', async () => {
    const node = await boot({ nodeId: 'node-api' });
    expect((await fetch(`${node.baseUrl}/api/boards`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${node.baseUrl}/sync/exchange`)).status).toBe(405);
  });
});

describe('public SSE event stream', () => {
  it('streams live post events but never chat messages', async () => {
    const node = await boot({ nodeId: 'node-sse' });
    const controller = new AbortController();
    const res = await fetch(`${node.baseUrl}/api/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    let buffer = '';
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      try {
        while (reader !== undefined) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
      } catch {
        // Aborted on purpose at the end of the test.
      }
    })();
    try {
      await waitFor(() => buffer.includes(': connected'), 5000, 'SSE connect line');
      // A live post reaches the stream.
      await postThreadViaDriver(node, 'Alice', 'SSE Subject', 'sse body');
      await waitFor(() => buffer.includes('"kind":"post"'), 5000, 'SSE post event');
      expect(buffer).toContain('SSE Subject');
      // A private chat must never reach the public stream.
      const a = new SessionDriver(node.env.deps);
      await a.register('Chatter', 'pass1234');
      const b = new SessionDriver(node.env.deps);
      await b.register('Listener', 'pass1234');
      // Transports subscribe on connect; drivers must subscribe by hand.
      node.hub.subscribe(a.state.id, () => undefined);
      node.hub.subscribe(b.state.id, () => undefined);
      const out = await a.sendText('6 Listener secret dm words');
      expect(out).toContain('Message sent to Listener.');
      await new Promise((r) => setTimeout(r, 500));
      expect(buffer).not.toContain('"kind":"chat"');
      expect(buffer).not.toContain('secret dm words');
    } finally {
      controller.abort();
      await pump;
    }
  }, 30000);
});

describe('sync endpoint authentication', () => {
  it('rejects without the secret and accepts with it', async () => {
    const node = await boot({ nodeId: 'node-secret', secret: 's3cr3t' });
    const payload = JSON.stringify({ nodeId: 'peer-x', entries: [] });
    const noHeader = await fetch(`${node.baseUrl}/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(noHeader.status).toBe(401);
    const wrong = await fetch(`${node.baseUrl}/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-secret': 'wrong' },
      body: payload,
    });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${node.baseUrl}/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-secret': 's3cr3t' },
      body: payload,
    });
    expect(right.status).toBe(200);
    const body = (await right.json()) as { nodeId: string; entries: unknown[] };
    expect(body.nodeId).toBe('node-secret');
    expect(body.entries).toEqual([]);
  });

  it('is open when no secret is configured (disclosed behavior)', async () => {
    const node = await boot({ nodeId: 'node-open' });
    const res = await fetch(`${node.baseUrl}/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'peer-x', entries: [] }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects malformed and oversized exchange bodies', async () => {
    const node = await boot({ nodeId: 'node-open' });
    const badJson = await fetch(`${node.baseUrl}/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    const badShape = await fetch(`${node.baseUrl}/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(badShape.status).toBe(400);
    const huge = await fetch(`${node.baseUrl}/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(5 * 1024 * 1024 + 1),
    });
    expect(huge.status).toBe(413);
  });
});
