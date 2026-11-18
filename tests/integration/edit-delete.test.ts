/**
 * tests/integration/edit-delete.test.ts — Federated edit/delete over real
 * sockets and real HTTP (PRO-DEV): two booted nodes exchange entries
 * through POST /sync/exchange; callers read the results over telnet.
 * No mocks anywhere in this file.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SessionDriver } from '../helpers.js';
import { bootNode, type BootedNode } from '../sync-helpers.js';
import { RawTelnetClient } from './client.js';

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

async function postThreadViaDriver(
  node: BootedNode,
  handle: string,
  subject: string,
  body: string,
): Promise<{ threadId: string; postId: string }> {
  const d = new SessionDriver(node.env.deps);
  await d.register(handle, 'pass1234');
  await d.send('1');
  await d.send('1');
  await d.send('N');
  await d.send(subject);
  await d.send(body);
  await d.send('.');
  const threads = await node.env.deps.boards.listThreads('general');
  return { threadId: threads[0].id, postId: threads[0].posts[0].id };
}

async function editViaDriver(
  node: BootedNode,
  handle: string,
  subject: string,
  body: string,
): Promise<void> {
  const d = new SessionDriver(node.env.deps);
  await d.login(handle, 'pass1234');
  await d.send('1');
  await d.send('1');
  await d.send('1');
  await d.send('E1');
  await d.send(subject);
  await d.send(body);
  await d.send('.');
}

async function deleteViaDriver(node: BootedNode, handle: string): Promise<void> {
  const d = new SessionDriver(node.env.deps);
  await d.login(handle, 'pass1234');
  await d.send('1');
  await d.send('1');
  await d.send('1');
  await d.send('D1');
  await d.send('DELETE');
}

describe('federated edit/delete over real sockets (PRO-DEV)', () => {
  it('syncs an edit from A to B, visible over telnet on B', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    await postThreadViaDriver(a, 'Alice', 'Original Subject', 'original body');
    await a.engine.syncWith(b.baseUrl);
    await editViaDriver(a, 'Alice', 'Edited Subject', 'edited body');
    await a.engine.syncWith(b.baseUrl);

    // B's store shows the edit.
    const threads = await b.env.deps.boards.listThreads('general');
    expect(threads[0].subject).toBe('Edited Subject');
    expect(threads[0].posts[0].body).toBe('edited body');
    const meta = await b.env.deps.boards.getPostMeta(threads[0].posts[0].id);
    expect(meta).not.toBeNull();

    // A caller on B sees the edited content and the marker over telnet.
    const c = await registerTelnet(b, 'Bob');
    c.send('1\n');
    await c.waitForPlain('MESSAGE BOARDS');
    c.send('1\n');
    await c.waitForPlain('BOARD:');
    c.send('1\n');
    await c.waitForPlain('Edited Subject');
    await c.waitForPlain('[edited');
    await c.waitForPlain('edited body');
  });

  it('syncs a delete from A to B: the post vanishes on B', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    await postThreadViaDriver(a, 'Alice', 'Doomed Thread', 'doomed body');
    await a.engine.syncWith(b.baseUrl);
    expect((await b.env.deps.boards.listThreads('general'))[0].subject).toBe('Doomed Thread');
    await deleteViaDriver(a, 'Alice');
    await a.engine.syncWith(b.baseUrl);
    const threads = await b.env.deps.boards.listThreads('general');
    expect(threads.find((t) => t.subject === 'Doomed Thread')).toBeUndefined();
    // B's API agrees: the thread is gone from the public read model.
    const res = await fetch(`${b.baseUrl}/api/boards/general/threads`);
    const body = (await res.json()) as { threads: Array<{ subject: string }> };
    expect(body.threads.find((t) => t.subject === 'Doomed Thread')).toBeUndefined();
  });

  it('queues an edit that arrives before its post, then resolves it', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    const { threadId, postId } = await postThreadViaDriver(a, 'Alice', 'Early Edit', 'v1 body');
    // Deliver ONLY the edit entry to B over real HTTP, before B has the post.
    const editEntry = {
      id: 'node-a:early-edit-1',
      origin: 'node-a',
      seq: 99,
      kind: 'edit',
      at: '2026-11-19T12:00:00.000Z',
      edit: {
        postId,
        threadId,
        boardId: 'general',
        authorHandle: 'Alice',
        subject: 'Early Edit',
        body: 'v2 body, arrived first',
      },
    };
    const res = await fetch(`${b.baseUrl}/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', entries: [editEntry] }),
    });
    expect(res.status).toBe(200);
    expect((await b.engine.getStats()).pendingCount).toBe(1);
    // Now the original arrives through a normal round: pending resolves.
    await a.engine.syncWith(b.baseUrl);
    expect((await b.engine.getStats()).pendingCount).toBe(0);
    const thread = await b.env.deps.boards.getThread(threadId);
    expect(thread.posts[0].body).toBe('v2 body, arrived first');
  });

  it('re-delivery of edit/delete entries never duplicates or resurrects', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    await postThreadViaDriver(a, 'Alice', 'Stable', 'stable body');
    await editViaDriver(a, 'Alice', 'Stable', 'stable body, edited');
    await a.engine.syncWith(b.baseUrl);
    await a.engine.syncWith(b.baseUrl);
    await a.engine.syncWith(b.baseUrl);
    const threads = await b.env.deps.boards.listThreads('general');
    expect(threads[0].posts).toHaveLength(1);
    expect(threads[0].posts[0].body).toBe('stable body, edited');
    await deleteViaDriver(a, 'Alice');
    await a.engine.syncWith(b.baseUrl);
    await a.engine.syncWith(b.baseUrl);
    expect((await b.env.deps.boards.listThreads('general')).find((t) => t.subject === 'Stable')).toBeUndefined();
  });

  it('delete wins over a re-issued add delivered directly to B', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    const { threadId, postId } = await postThreadViaDriver(a, 'Alice', 'Gone', 'gone body');
    await a.engine.syncWith(b.baseUrl);
    await deleteViaDriver(a, 'Alice');
    await a.engine.syncWith(b.baseUrl);
    expect((await b.env.deps.boards.listThreads('general')).find((t) => t.subject === 'Gone')).toBeUndefined();
    // Re-issue the original thread under a fresh entry id, direct to B.
    const reissue = {
      id: 'node-a:reissue-1',
      origin: 'node-a',
      seq: 100,
      kind: 'thread',
      at: '2026-11-19T10:00:00.000Z',
      thread: {
        id: threadId,
        boardId: 'general',
        subject: 'Gone',
        authorHandle: 'Alice',
        createdAt: '2026-11-19T10:00:00.000Z',
        posts: [
          {
            id: postId,
            threadId,
            boardId: 'general',
            authorHandle: 'Alice',
            subject: 'Gone',
            body: 'gone body',
            createdAt: '2026-11-19T10:00:00.000Z',
            isArchive: false,
          },
        ],
      },
    };
    const res = await fetch(`${b.baseUrl}/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', entries: [reissue] }),
    });
    expect(res.status).toBe(200);
    expect((await b.env.deps.boards.listThreads('general')).find((t) => t.subject === 'Gone')).toBeUndefined();
  });

  it('records real round outcomes in node stats', async () => {
    const b = await boot({ nodeId: 'node-b' });
    const a = await boot({ nodeId: 'node-a', peers: [b.baseUrl] });
    await postThreadViaDriver(a, 'Alice', 'Stats', 'stats body');
    await a.engine.syncAll();
    const stats = await a.engine.getStats();
    expect(stats.entryCount).toBeGreaterThan(0);
    expect(stats.peerCount).toBe(1);
    expect(stats.lastRoundAt).not.toBeNull();
    expect(stats.peers).toHaveLength(1);
    expect(stats.peers[0].lastRoundAt).not.toBeNull();
    expect(stats.peers[0].lastError).toBeNull();
    const bStats = await b.engine.getStats();
    expect(bStats.entryCount).toBeGreaterThan(0);
  });
});
