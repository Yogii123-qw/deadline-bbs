import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomicStore } from '../../src/boards/store.js';
import type { Post, Thread } from '../../src/shared/types.js';
import { secretsMatch } from '../../src/sync/api.js';
import { zSyncEntry, zSyncLogData, type SyncEntry, type SyncLogData } from '../../src/sync/entries.js';
import { EMPTY_SYNC_LOG, SyncLogStore } from '../../src/sync/store.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { attachSync, type AttachedSync } from '../sync-helpers.js';

let env: TestEnv;

afterEach(async () => {
  await env?.cleanup();
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const post: Post = {
    id: 'post-1',
    threadId: 'thread-1',
    boardId: 'general',
    authorHandle: 'Alice',
    subject: 'Remote Subject',
    body: 'remote body',
    createdAt: '2026-11-19T10:00:00.000Z',
    isArchive: false,
  };
  return {
    id: 'thread-1',
    boardId: 'general',
    subject: 'Remote Subject',
    authorHandle: 'Alice',
    createdAt: '2026-11-19T10:00:00.000Z',
    posts: [post],
    ...overrides,
  };
}

function makeReply(overrides: Partial<Post> = {}): Post {
  return {
    id: 'post-2',
    threadId: 'thread-1',
    boardId: 'general',
    authorHandle: 'Bob',
    subject: 'Remote Subject',
    body: 'reply body',
    createdAt: '2026-11-19T10:05:00.000Z',
    isArchive: false,
    ...overrides,
  };
}

function threadEntry(thread: Thread, id = 'node-a:uuid-1', seq = 1): SyncEntry {
  return { id, origin: 'node-a', seq, kind: 'thread', at: thread.createdAt, thread };
}

function replyEntry(post: Post, id = 'node-a:uuid-2', seq = 2): SyncEntry {
  return { id, origin: 'node-a', seq, kind: 'reply', at: post.createdAt, post };
}

describe('zSyncEntry', () => {
  it('accepts well-formed thread and reply entries', () => {
    expect(zSyncEntry.safeParse(threadEntry(makeThread())).success).toBe(true);
    expect(zSyncEntry.safeParse(replyEntry(makeReply())).success).toBe(true);
  });

  it('rejects entries with the wrong payload, bad kind, or seq 0', () => {
    expect(zSyncEntry.safeParse({ ...threadEntry(makeThread()), thread: undefined }).success).toBe(false);
    expect(zSyncEntry.safeParse({ ...replyEntry(makeReply()), post: undefined }).success).toBe(false);
    expect(zSyncEntry.safeParse({ ...threadEntry(makeThread()), kind: 'edit' }).success).toBe(false);
    expect(zSyncEntry.safeParse({ ...threadEntry(makeThread()), seq: 0 }).success).toBe(false);
    expect(zSyncEntry.safeParse({ ...threadEntry(makeThread()), id: '' }).success).toBe(false);
  });
});

describe('SyncLogStore', () => {
  async function freshStore(): Promise<SyncLogStore> {
    env = await createTestEnv();
    return new SyncLogStore(
      new AtomicStore<SyncLogData>(
        path.join(env.dataDir, 'sync.json'),
        zSyncLogData,
        EMPTY_SYNC_LOG,
        (m) => env.warnings.push(m),
      ),
      (m) => env.logs.push(m),
    );
  }

  it('throws from nodeId() before init', async () => {
    const store = await freshStore();
    expect(() => store.nodeId()).toThrow('before init');
  });

  it('generates and persists a node id across restarts', async () => {
    const store = await freshStore();
    const first = await store.init();
    expect(first).not.toBe('');
    const dataDir = env.dataDir;
    const again = new SyncLogStore(
      new AtomicStore<SyncLogData>(
        path.join(dataDir, 'sync.json'),
        zSyncLogData,
        EMPTY_SYNC_LOG,
        (m) => env.warnings.push(m),
      ),
    );
    expect(await again.init()).toBe(first);
  });

  it('prefers the env override and keeps it stable', async () => {
    const store = await freshStore();
    expect(await store.init('node-fixed')).toBe('node-fixed');
    expect((await store.read()).nodeId).toBe('node-fixed');
    expect(await store.init('node-fixed')).toBe('node-fixed');
  });

  it('appendLocal assigns ids and sequence numbers and fires the hook', async () => {
    const store = await freshStore();
    await store.init('node-hook');
    const hooked: SyncEntry[] = [];
    store.onLocalAppend = (e) => hooked.push(e);
    const thread = makeThread();
    const first = await store.appendLocal('thread', thread, thread.createdAt);
    expect(first).not.toBeNull();
    expect(first?.id.startsWith('node-hook:')).toBe(true);
    expect(first?.seq).toBe(1);
    const second = await store.appendLocal('reply', makeReply(), makeReply().createdAt);
    expect(second?.seq).toBe(2);
    expect(hooked).toHaveLength(2);
    const log = await store.read();
    expect(log.entries).toHaveLength(2);
    expect(log.nextSeq).toBe(3);
  });
});

describe('BoardStore federation imports', () => {
  it('importThread is idempotent and rejects unknown boards', async () => {
    env = await createTestEnv();
    const thread = makeThread();
    expect(await env.deps.boards.importThread(thread)).toBe(true);
    expect(await env.deps.boards.importThread(thread)).toBe(false);
    const threads = await env.deps.boards.listThreads('general');
    expect(threads.filter((t) => t.id === 'thread-1')).toHaveLength(1);
    await expect(
      env.deps.boards.importThread(makeThread({ id: 'thread-x', boardId: 'nope' })),
    ).rejects.toThrow('Unknown board');
  });

  it('importReply inserts chronologically, dedups, and reports unknown threads', async () => {
    env = await createTestEnv();
    await env.deps.boards.importThread(makeThread());
    const newer = makeReply({ id: 'post-new', createdAt: '2026-11-19T11:00:00.000Z' });
    const older = makeReply({ id: 'post-old', createdAt: '2026-11-19T10:30:00.000Z' });
    expect(await env.deps.boards.importReply(newer)).toBe('imported');
    expect(await env.deps.boards.importReply(older)).toBe('imported');
    expect(await env.deps.boards.importReply(older)).toBe('duplicate');
    const thread = await env.deps.boards.getThread('thread-1');
    expect(thread.posts.map((p) => p.id)).toEqual(['post-1', 'post-old', 'post-new']);
    expect(await env.deps.boards.importReply(makeReply({ id: 'post-z', threadId: 'missing' }))).toBe(
      'unknown-thread',
    );
  });
});

describe('SyncEngine.applyRemote', () => {
  async function setup(): Promise<AttachedSync> {
    env = await createTestEnv();
    return attachSync(env, 'node-local');
  }

  it('applies a thread entry and notifies local sessions via the hub', async () => {
    const sync = await setup();
    const seen: Array<{ kind: string; originNode?: string }> = [];
    sync.hub.subscribe('collector', (e) => {
      if (e.kind === 'post') seen.push({ kind: e.kind, originNode: e.originNode });
    });
    const result = await sync.engine.applyRemote([threadEntry(makeThread())]);
    expect(result).toMatchObject({ applied: 1, duplicates: 0, skipped: 0 });
    const thread = await env.deps.boards.getThread('thread-1');
    expect(thread.subject).toBe('Remote Subject');
    expect(seen).toEqual([{ kind: 'post', originNode: 'node-a' }]);
    expect((await sync.syncLog.read()).entries).toHaveLength(1);
  });

  it('is idempotent: the same entry twice never duplicates', async () => {
    const sync = await setup();
    const entry = threadEntry(makeThread());
    expect(await sync.engine.applyRemote([entry])).toMatchObject({ applied: 1 });
    expect(await sync.engine.applyRemote([entry])).toMatchObject({ applied: 0, duplicates: 1 });
    const threads = await env.deps.boards.listThreads('general');
    expect(threads.filter((t) => t.id === 'thread-1')).toHaveLength(1);
    expect((await sync.syncLog.read()).entries).toHaveLength(1);
  });

  it('queues a reply before its thread and resolves it when the thread arrives', async () => {
    const sync = await setup();
    const reply = replyEntry(makeReply());
    const first = await sync.engine.applyRemote([reply]);
    expect(first).toMatchObject({ applied: 0, pending: 1 });
    expect((await sync.syncLog.read()).pending).toHaveLength(1);
    // Re-sending the pending reply does not duplicate the pending entry.
    const second = await sync.engine.applyRemote([reply]);
    expect(second).toMatchObject({ duplicates: 1, pending: 1 });
    // The thread arrives: the pending reply resolves exactly once.
    const third = await sync.engine.applyRemote([threadEntry(makeThread())]);
    expect(third).toMatchObject({ applied: 2, pending: 0 });
    const thread = await env.deps.boards.getThread('thread-1');
    expect(thread.posts.map((p) => p.id)).toEqual(['post-1', 'post-2']);
    expect((await sync.syncLog.read()).pending).toHaveLength(0);
    expect((await sync.syncLog.read()).entries).toHaveLength(2);
  });

  it('keeps an unresolvable reply pending without duplicating it', async () => {
    const sync = await setup();
    await sync.engine.applyRemote([replyEntry(makeReply())]);
    await sync.engine.applyRemote([replyEntry(makeReply())]);
    expect((await sync.syncLog.read()).pending).toHaveLength(1);
  });

  it('skips malformed entries and keeps applying the rest of the round', async () => {
    const sync = await setup();
    const result = await sync.engine.applyRemote([
      { nope: true },
      'not-an-entry',
      threadEntry(makeThread()),
      { ...replyEntry(makeReply()), kind: 'edit' },
    ]);
    expect(result).toMatchObject({ applied: 1, skipped: 3 });
    expect(await env.deps.boards.getThread('thread-1')).toBeDefined();
  });

  it('rejects semantically bad payloads and forces archive flags off', async () => {
    const sync = await setup();
    const badSubject = threadEntry(makeThread({ subject: 'x'.repeat(73) }));
    const badHandle = threadEntry(makeThread({ id: 't2', authorHandle: 'has space' }), 'node-a:u3', 3);
    const badBoard = threadEntry(
      makeThread({ id: 't3', boardId: 'nope', posts: [makeReply({ threadId: 't3', boardId: 'nope' })] }),
      'node-a:u4',
      4,
    );
    const archived = threadEntry(
      makeThread({
        id: 't4',
        posts: [{ ...makeReply({ threadId: 't4' }), isArchive: true }],
      }),
      'node-a:u5',
      5,
    );
    const result = await sync.engine.applyRemote([badSubject, badHandle, badBoard, archived]);
    expect(result).toMatchObject({ applied: 1, skipped: 3 });
    const thread = await env.deps.boards.getThread('t4');
    expect(thread.posts[0].isArchive).toBe(false);
  });

  it('applies without a hub', async () => {
    env = await createTestEnv();
    const sync = await attachSync(env, 'node-local');
    const { SyncEngine } = await import('../../src/sync/engine.js');
    const hubLess = new SyncEngine({
      boards: env.deps.boards,
      syncLog: sync.syncLog,
      nodeId: 'node-local',
      peers: [],
      intervalMs: 0,
      onLog: () => undefined,
    });
    const result = await hubLess.applyRemote([threadEntry(makeThread())]);
    expect(result.applied).toBe(1);
  });
});

describe('secretsMatch', () => {
  it('matches equal secrets and rejects everything else', () => {
    expect(secretsMatch('hunter2', 'hunter2')).toBe(true);
    expect(secretsMatch('hunter3', 'hunter2')).toBe(false);
    expect(secretsMatch(undefined, 'hunter2')).toBe(false);
    expect(secretsMatch('', 'hunter2')).toBe(false);
    expect(secretsMatch('short', 'a-much-longer-secret-value')).toBe(false);
  });
});

describe('SyncEngine.syncWith failure modes', () => {
  it('logs and returns on an unreachable peer, never throws', async () => {
    env = await createTestEnv();
    const sync = await attachSync(env, 'node-local');
    await expect(sync.engine.syncWith('http://127.0.0.1:1')).resolves.toBeUndefined();
    expect(env.logs.join(' ')).toContain('Sync with http://127.0.0.1:1 failed');
  });

  it('logs and returns on a peer that answers garbage', async () => {
    env = await createTestEnv();
    const sync = await attachSync(env, 'node-local');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('this is not json{');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      await expect(sync.engine.syncWith(`http://127.0.0.1:${port}`)).resolves.toBeUndefined();
      expect(env.logs.join(' ')).toContain('not JSON');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('logs and returns on a peer that rejects with 500', async () => {
    env = await createTestEnv();
    const sync = await attachSync(env, 'node-local');
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      await expect(sync.engine.syncWith(`http://127.0.0.1:${port}`)).resolves.toBeUndefined();
      expect(env.logs.join(' ')).toContain('HTTP 500');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
