/**
 * tests/unit/crdt.test.ts — Operation semantics of the sync log
 * (PRO-DEV amendment §2.2): the same set of operations, delivered in any
 * order, with any duplication, across any number of rounds, converges to
 * the same visible state. No mocks: real stores, real SyncEngine.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Post, Thread } from '../../src/shared/types.js';
import { zSyncEntry, type SyncEntry } from '../../src/sync/entries.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { attachSync, type AttachedSync } from '../sync-helpers.js';

const envs: TestEnv[] = [];

afterEach(async () => {
  while (envs.length > 0) {
    const env = envs.pop();
    await env?.cleanup();
  }
});

async function freshNode(nodeId: string): Promise<{ env: TestEnv; sync: AttachedSync }> {
  const env = await createTestEnv();
  envs.push(env);
  const sync = await attachSync(env, nodeId);
  return { env, sync };
}

function makeThread(): Thread {
  const post: Post = {
    id: 'post-1',
    threadId: 'thread-1',
    boardId: 'general',
    authorHandle: 'Alice',
    subject: 'Original Subject',
    body: 'original body',
    createdAt: '2026-11-19T10:00:00.000Z',
    isArchive: false,
  };
  return {
    id: 'thread-1',
    boardId: 'general',
    subject: 'Original Subject',
    authorHandle: 'Alice',
    createdAt: '2026-11-19T10:00:00.000Z',
    posts: [post],
  };
}

function makeReply(): Post {
  return {
    id: 'post-2',
    threadId: 'thread-1',
    boardId: 'general',
    authorHandle: 'Bob',
    subject: 'Original Subject',
    body: 'reply body',
    createdAt: '2026-11-19T10:05:00.000Z',
    isArchive: false,
  };
}

const T0 = '2026-11-19T10:00:00.000Z';
const T1 = '2026-11-19T10:10:00.000Z';
const T2 = '2026-11-19T10:20:00.000Z';
const T3 = '2026-11-19T10:30:00.000Z';

function threadOp(): SyncEntry {
  return { id: 'node-a:op-thread', origin: 'node-a', seq: 1, kind: 'thread', at: T0, thread: makeThread() };
}

function replyOp(id = 'node-a:op-reply'): SyncEntry {
  return { id, origin: 'node-a', seq: 2, kind: 'reply', at: T1, post: makeReply() };
}

function editOp(id: string, at: string, subject: string, body: string): SyncEntry {
  return {
    id,
    origin: 'node-a',
    seq: 3,
    kind: 'edit',
    at,
    edit: {
      postId: 'post-1',
      threadId: 'thread-1',
      boardId: 'general',
      authorHandle: 'Alice',
      subject,
      body,
    },
  };
}

function tombstoneOp(id: string, at: string, postId = 'post-2', author = 'Bob'): SyncEntry {
  return {
    id,
    origin: 'node-a',
    seq: 4,
    kind: 'tombstone',
    at,
    tombstone: { postId, threadId: 'thread-1', boardId: 'general', authorHandle: author },
  };
}

function scoreOp(id: string, at: string): SyncEntry {
  return {
    id,
    origin: 'node-a',
    seq: 5,
    kind: 'score',
    at,
    score: { handle: 'Alice', level: 12 },
  };
}

/** Canonical visible state: what a caller (and the API) can see. */
async function visibleState(env: TestEnv): Promise<unknown> {
  const data = await env.deps.boards.readData();
  const posts = data.threads
    .flatMap((t) => t.posts)
    .filter((p) => p.threadId === 'thread-1')
    .map((p) => ({ id: p.id, subject: p.subject, body: p.body, author: p.authorHandle }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const meta = Object.entries(data.postMeta)
    .map(([postId, m]) => ({ postId, editedAt: m.editedAt, editEntryId: m.editEntryId }))
    .sort((a, b) => (a.postId < b.postId ? -1 : 1));
  const network = await env.deps.scores.getNetworkScores();
  return { posts, meta, network };
}

describe('CRDT convergence (PRO-DEV)', () => {
  it('converges over permutations: order does not matter', async () => {
    const ops = [
      threadOp(),
      replyOp(),
      editOp('node-a:op-edit-1', T1, 'Edited Once', 'body once'),
      editOp('node-a:op-edit-2', T2, 'Edited Twice', 'body twice'),
      tombstoneOp('node-a:op-tomb', T3),
      scoreOp('node-a:op-score', T3),
    ];
    const orders: SyncEntry[][] = [
      ops,
      [...ops].reverse(),
      [ops[5], ops[2], ops[0], ops[4], ops[1], ops[3]],
      [ops[4], ops[3], ops[1], ops[5], ops[0], ops[2]],
    ];
    const snapshots: unknown[] = [];
    for (let i = 0; i < orders.length; i += 1) {
      const { env, sync } = await freshNode(`node-order-${i}`);
      const result = await sync.engine.applyRemote(orders[i]);
      expect(result.pending).toBe(0);
      snapshots.push(await visibleState(env));
    }
    for (const snapshot of snapshots.slice(1)) {
      expect(snapshot).toEqual(snapshots[0]);
    }
    // The converged state itself: post-1 carries the LWW-winning edit,
    // post-2 is gone, one network score is recorded.
    const first = snapshots[0] as {
      posts: Array<{ id: string; subject: string; body: string }>;
      network: Array<{ handle: string; level: number }>;
    };
    expect(first.posts).toEqual([
      { id: 'post-1', subject: 'Edited Twice', body: 'body twice', author: 'Alice' },
    ]);
    expect(first.network).toEqual([
      { handle: 'Alice', level: 12, timestamp: T3, originNode: 'node-a', entryId: 'node-a:op-score' },
    ]);
  });

  it('converges over duplication: re-delivery is a no-op', async () => {
    const ops = [threadOp(), replyOp(), editOp('node-a:op-edit-1', T2, 'Edited', 'edited body'), scoreOp('node-a:op-score', T3)];
    const { env, sync } = await freshNode('node-dup');
    const first = await sync.engine.applyRemote(ops);
    expect(first.applied).toBe(4);
    const second = await sync.engine.applyRemote([...ops, ...ops]);
    expect(second.applied).toBe(0);
    expect(second.duplicates).toBe(8);
    const snapshot = await visibleState(env);
    const { env: env2, sync: sync2 } = await freshNode('node-dup-2');
    await sync2.engine.applyRemote(ops);
    expect(snapshot).toEqual(await visibleState(env2));
    // No duplicate posts or scores anywhere in the store.
    const data = await env.deps.boards.readData();
    expect(data.threads.find((t) => t.id === 'thread-1')?.posts).toHaveLength(2);
    expect(await env.deps.scores.getNetworkScores()).toHaveLength(1);
  });

  it('converges over delayed delivery across rounds (persistent pending)', async () => {
    const { env, sync } = await freshNode('node-delay');
    const round1 = await sync.engine.applyRemote([
      tombstoneOp('node-a:op-tomb', T3),
      editOp('node-a:op-edit-2', T2, 'Edited Twice', 'body twice'),
    ]);
    expect(round1.pending).toBe(2);
    const round2 = await sync.engine.applyRemote([
      threadOp(),
      replyOp(),
      editOp('node-a:op-edit-1', T1, 'Edited Once', 'body once'),
      scoreOp('node-a:op-score', T3),
    ]);
    expect(round2.pending).toBe(0);
    const { env: env2, sync: sync2 } = await freshNode('node-delay-2');
    await sync2.engine.applyRemote([
      threadOp(),
      replyOp(),
      editOp('node-a:op-edit-1', T1, 'Edited Once', 'body once'),
      editOp('node-a:op-edit-2', T2, 'Edited Twice', 'body twice'),
      tombstoneOp('node-a:op-tomb', T3),
      scoreOp('node-a:op-score', T3),
    ]);
    expect(await visibleState(env)).toEqual(await visibleState(env2));
  });

  it('breaks equal-timestamp edit ties by entry id, deterministically', async () => {
    const editA = editOp('node-a:aaa', T2, 'Edit A', 'body A');
    const editB = editOp('node-b:bbb', T2, 'Edit B', 'body B');
    const states: unknown[] = [];
    for (const order of [[editA, editB], [editB, editA]]) {
      const { env, sync } = await freshNode(`node-tie-${states.length}`);
      await sync.engine.applyRemote([threadOp(), ...order]);
      states.push(await visibleState(env));
    }
    expect(states[0]).toEqual(states[1]);
    const posts = (states[0] as { posts: Array<{ subject: string }> }).posts;
    expect(posts).toEqual([{ id: 'post-1', subject: 'Edit B', body: 'body B', author: 'Alice' }]);
  });

  it('delete wins over a late add: the post never appears', async () => {
    const { env, sync } = await freshNode('node-late-add');
    await sync.engine.applyRemote([threadOp(), replyOp()]);
    await sync.engine.applyRemote([tombstoneOp('node-a:op-tomb', T3)]);
    expect((await env.deps.boards.getThread('thread-1')).posts.map((p) => p.id)).toEqual(['post-1']);
    // The same post re-issued under a fresh entry id (seen-set loss, or a
    // re-broadcast): recorded in the log, never displayed.
    const result = await sync.engine.applyRemote([replyOp('node-a:op-reply-reissue')]);
    expect(result.duplicates).toBe(1);
    expect(result.applied).toBe(0);
    const thread = await env.deps.boards.getThread('thread-1');
    expect(thread.posts.map((p) => p.id)).toEqual(['post-1']);
    const log = await sync.syncLog.read();
    expect(log.entries.map((e) => e.id)).toContain('node-a:op-reply-reissue');
  });

  it('delete wins over edits in both orders, even a later edit', async () => {
    for (const order of [
      [threadOp(), tombstoneOp('node-a:op-tomb-1', T1, 'post-1', 'Alice'), editOp('node-a:op-edit-late', T3, 'Too Late', 'too late')],
      [threadOp(), editOp('node-a:op-edit-late', T3, 'Too Late', 'too late'), tombstoneOp('node-a:op-tomb-1', T1, 'post-1', 'Alice')],
    ]) {
      const { env, sync } = await freshNode(`node-delwin-${Math.random()}`);
      await sync.engine.applyRemote(order);
      const thread = await env.deps.boards.getThread('thread-1');
      expect(thread.posts).toHaveLength(0);
      expect(await env.deps.boards.findPost('post-1')).toBeNull();
    }
  });

  it('scores form a grow-only set keyed by entry id', async () => {
    const { env, sync } = await freshNode('node-scores');
    await sync.engine.applyRemote([
      scoreOp('node-a:score-1', T1),
      scoreOp('node-a:score-1', T1),
      scoreOp('node-a:score-2', T2),
    ]);
    const network = await env.deps.scores.getNetworkScores();
    expect(network.map((s) => s.entryId).sort()).toEqual(['node-a:score-1', 'node-a:score-2']);
  });
});

describe('sync apply authorization (PRO-DEV)', () => {
  it('rejects edits and tombstones from non-authors', async () => {
    const { env, sync } = await freshNode('node-authz');
    await sync.engine.applyRemote([threadOp(), replyOp()]);
    const forgedEdit: SyncEntry = {
      id: 'node-evil:edit-1',
      origin: 'node-evil',
      seq: 1,
      kind: 'edit',
      at: T3,
      edit: {
        postId: 'post-1',
        threadId: 'thread-1',
        boardId: 'general',
        authorHandle: 'Mallory',
        subject: 'Hijacked',
        body: 'hijacked body',
      },
    };
    const forgedTomb: SyncEntry = {
      id: 'node-evil:tomb-1',
      origin: 'node-evil',
      seq: 2,
      kind: 'tombstone',
      at: T3,
      tombstone: { postId: 'post-2', threadId: 'thread-1', boardId: 'general', authorHandle: 'Mallory' },
    };
    const result = await sync.engine.applyRemote([forgedEdit, forgedTomb]);
    expect(result.skipped).toBe(2);
    expect(result.applied).toBe(0);
    const thread = await env.deps.boards.getThread('thread-1');
    expect(thread.posts[0].subject).toBe('Original Subject');
    expect(thread.posts).toHaveLength(2);
    // Forbidden entries never enter the log.
    const log = await sync.syncLog.read();
    expect(log.entries.map((e) => e.id)).not.toContain('node-evil:edit-1');
    expect(log.entries.map((e) => e.id)).not.toContain('node-evil:tomb-1');
  });

  it('rejects edits and tombstones on archive posts', async () => {
    const { env, sync } = await freshNode('node-archive');
    const data = await env.deps.boards.readData();
    const archivePost = data.threads.flatMap((t) => t.posts).find((p) => p.isArchive);
    expect(archivePost).toBeDefined();
    if (archivePost === undefined) return;
    const edit: SyncEntry = {
      id: 'node-a:edit-archive',
      origin: 'node-a',
      seq: 1,
      kind: 'edit',
      at: T3,
      edit: {
        postId: archivePost.id,
        threadId: archivePost.threadId,
        boardId: archivePost.boardId,
        authorHandle: archivePost.authorHandle,
        subject: 'Changed History',
        body: 'changed',
      },
    };
    const tomb: SyncEntry = {
      id: 'node-a:tomb-archive',
      origin: 'node-a',
      seq: 2,
      kind: 'tombstone',
      at: T3,
      tombstone: {
        postId: archivePost.id,
        threadId: archivePost.threadId,
        boardId: archivePost.boardId,
        authorHandle: archivePost.authorHandle,
      },
    };
    const result = await sync.engine.applyRemote([edit, tomb]);
    expect(result.skipped).toBe(2);
    expect(await env.deps.boards.findPost(archivePost.id)).not.toBeNull();
  });

  it('skips malformed edit/tombstone/score payloads without failing the round', async () => {
    const { env, sync } = await freshNode('node-malformed');
    const result = await sync.engine.applyRemote([
      threadOp(),
      { id: 'x:1', origin: 'x', seq: 1, kind: 'edit', at: T1 },
      { id: 'x:2', origin: 'x', seq: 2, kind: 'tombstone', at: T1 },
      { id: 'x:3', origin: 'x', seq: 3, kind: 'score', at: T1 },
      {
        id: 'x:4',
        origin: 'x',
        seq: 4,
        kind: 'score',
        at: T1,
        score: { handle: 'Alice', level: 0 },
      },
      {
        id: 'x:5',
        origin: 'x',
        seq: 5,
        kind: 'edit',
        at: 'not-a-date',
        edit: {
          postId: 'post-1',
          threadId: 'thread-1',
          boardId: 'general',
          authorHandle: 'Alice',
          subject: 'Bad Date',
          body: 'bad date',
        },
      },
    ]);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(5);
    expect(result.pending).toBe(0);
  });
});

describe('zSyncEntry new kinds (PRO-DEV)', () => {
  it('accepts well-formed edit, tombstone, and score entries', () => {
    expect(zSyncEntry.safeParse(editOp('n:e1', T1, 'S', 'B')).success).toBe(true);
    expect(zSyncEntry.safeParse(tombstoneOp('n:t1', T1)).success).toBe(true);
    expect(zSyncEntry.safeParse(scoreOp('n:s1', T1)).success).toBe(true);
  });

  it('rejects new-kind entries with the wrong payload', () => {
    expect(zSyncEntry.safeParse({ ...editOp('n:e1', T1, 'S', 'B'), edit: undefined }).success).toBe(false);
    expect(zSyncEntry.safeParse({ ...tombstoneOp('n:t1', T1), tombstone: undefined }).success).toBe(false);
    expect(zSyncEntry.safeParse({ ...scoreOp('n:s1', T1), score: undefined }).success).toBe(false);
    expect(zSyncEntry.safeParse({ ...scoreOp('n:s1', T1), score: { handle: 'A', level: 100 } }).success).toBe(false);
  });
});
