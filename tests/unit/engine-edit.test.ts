/**
 * tests/unit/engine-edit.test.ts — Edit/delete UX + federated score seam
 * (PRO-DEV): the full flows through the real session engine, with a real
 * sync log and live hub attached. No mocks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SessionDriver, createTestEnv, type TestEnv } from '../helpers.js';
import { attachSync, type AttachedSync } from '../sync-helpers.js';
import type { LiveEvent } from '../../src/server/live.js';
import type { Thread } from '../../src/shared/types.js';
import { newCharacter } from '../../src/game/catacomb.js';
import { todayLocal } from '../../src/session/engine.js';

let env: TestEnv;

afterEach(async () => {
  await env?.cleanup();
});

async function setup(handle = 'Alice'): Promise<{ d: SessionDriver; sync: AttachedSync; events: LiveEvent[] }> {
  env = await createTestEnv();
  const sync = await attachSync(env, 'node-edit');
  const events: LiveEvent[] = [];
  sync.hub.subscribe('collector', (e) => events.push(e));
  const d = new SessionDriver(env.deps);
  await d.register(handle, 'pass1234');
  return { d, sync, events };
}

/** Post a thread in General Discussion; returns the thread id. */
async function postThread(d: SessionDriver, subject: string, body: string): Promise<string> {
  await d.send('1');
  await d.send('1');
  await d.send('N');
  await d.send(subject);
  await d.send(body);
  await d.send('.');
  const threads = await env.deps.boards.listThreads('general');
  return threads[0].id;
}

async function threadById(id: string): Promise<Thread> {
  const data = await env.deps.boards.readData();
  const thread = data.threads.find((t) => t.id === id);
  if (thread === undefined) throw new Error(`thread ${id} not found in test data`);
  return thread;
}

async function openThread(d: SessionDriver, n: number): Promise<string> {
  await d.send('1');
  await d.send('1');
  return d.sendText(String(n));
}

describe('edit flow (PRO-DEV)', () => {
  it('edits your own post: content, marker, log entry, live event', async () => {
    const { d, sync, events } = await setup();
    const threadId = await postThread(d, 'Original Subject', 'original body');
    await openThread(d, 1);
    const prompt = await d.sendText('E1');
    expect(prompt).toContain('New subject (Enter keeps the current one)');
    await d.send('Edited Subject');
    await d.send('edited body');
    const out = await d.sendText('.');
    expect(out).toContain('Post edited.');
    expect(out).toContain('Edited Subject');
    expect(out).toContain('edited body');
    expect(out).toContain('[edited');
    expect(out).toContain('#1');
    expect(d.state.phase).toBe('READING_THREAD');
    // Store: content replaced in place, overlay recorded.
    const data = await env.deps.boards.readData();
    const post = (await threadById(threadId)).posts[0];
    expect(post.subject).toBe('Edited Subject');
    expect(post.body).toBe('edited body');
    expect(data.postMeta[post.id]).toBeDefined();
    // The thread subject followed the first post's edit.
    expect((await env.deps.boards.listThreads('general'))[0].subject).toBe('Edited Subject');
    // Sync log: one edit entry with the new content.
    const log = await sync.syncLog.read();
    const editEntry = log.entries.find((e) => e.kind === 'edit');
    expect(editEntry?.edit?.subject).toBe('Edited Subject');
    expect(editEntry?.edit?.body).toBe('edited body');
    // Live event: other callers were told.
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'edit', action: 'edited', handle: 'Alice', subject: 'Edited Subject' }),
    );
    // No draft left behind.
    expect(env.deps.sessionDrafts?.size ?? 0).toBe(0);
  });

  it('keeps the current subject on an empty subject line', async () => {
    const { d } = await setup();
    const threadId = await postThread(d, 'Keep Me', 'original body');
    await openThread(d, 1);
    await d.send('E1');
    await d.send('');
    await d.send('new body only');
    const out = await d.sendText('.');
    expect(out).toContain('Post edited.');
    const thread = await threadById(threadId);
    expect(thread.posts[0].subject).toBe('Keep Me');
    expect(thread.posts[0].body).toBe('new body only');
  });

  it('edits a reply by its number, leaving the first post alone', async () => {
    const { d } = await setup();
    const threadId = await postThread(d, 'Thread Subject', 'first body');
    await openThread(d, 1);
    await d.send('R');
    await d.send('reply body');
    await d.send('.');
    const view = await d.sendText('');
    expect(view).toContain('#1');
    expect(view).toContain('#2');
    await d.send('E2');
    await d.send('');
    await d.send('reply body, revised');
    await d.send('.');
    const data = await env.deps.boards.readData();
    const posts = (await threadById(threadId)).posts;
    expect(posts[0].body).toBe('first body');
    expect(posts[1].body).toBe('reply body, revised');
    expect(data.postMeta[posts[0].id]).toBeUndefined();
    expect(data.postMeta[posts[1].id]).toBeDefined();
  });

  it('aborts an edit and returns to the thread unchanged', async () => {
    const { d } = await setup();
    const threadId = await postThread(d, 'Subject', 'body');
    await openThread(d, 1);
    await d.send('E1');
    await d.send('Discarded Subject');
    const out = await d.sendText('ABORT');
    expect(d.state.phase).toBe('READING_THREAD');
    expect(out).toContain('Subject');
    const thread = await threadById(threadId);
    expect(thread.posts[0].subject).toBe('Subject');
    const data = await env.deps.boards.readData();
    expect(data.postMeta).toEqual({});
    expect(env.deps.sessionDrafts?.size ?? 0).toBe(0);
  });

  it('refuses edits to other callers\u2019 posts, archive posts, and bad numbers', async () => {
    const { d } = await setup('Alice');
    await postThread(d, 'Alice Thread', 'alice body');
    // Bob cannot edit Alice's post.
    const bob = new SessionDriver(env.deps);
    await bob.register('Bob', 'pass1234');
    await bob.send('1');
    await bob.send('1');
    await bob.send('1');
    const refused = await bob.sendText('E1');
    expect(refused).toContain('You can only edit your own posts.');
    expect(bob.state.phase).toBe('READING_THREAD');
    // Out of range.
    const bad = await bob.sendText('E99');
    expect(bad).toContain('No post #99');
    // Archive posts cannot be edited, by anyone.
    const threads = await env.deps.boards.listThreads('general');
    const archiveIdx = threads.findIndex((t) => t.posts.some((p) => p.isArchive));
    expect(archiveIdx).toBeGreaterThanOrEqual(0);
    await bob.send('Q');
    await bob.sendText(String(archiveIdx + 1));
    const archiveRefused = await bob.sendText('E1');
    expect(archiveRefused).toContain('Archive posts from 1994 cannot be edited.');
  });

  it('ignores a stale draft in the wrong context', async () => {
    const { d } = await setup();
    env.deps.sessionDrafts = new Map([
      [
        d.state.id,
        { kind: 'edit', postId: 'p', threadId: 'some-other-thread', boardId: 'general', originalSubject: 'X' },
      ],
    ]);
    await d.send('1');
    await d.send('1');
    await d.send('N');
    await d.send('Brand New');
    await d.send('fresh body');
    const out = await d.sendText('.');
    expect(out).toContain('Thread posted.');
    expect((await env.deps.boards.listThreads('general'))[0].subject).toBe('Brand New');
  });
});

describe('delete flow (PRO-DEV)', () => {
  it('deletes your own post after DELETE: gone, tombstoned, announced', async () => {
    const { d, sync, events } = await setup();
    await postThread(d, 'Doomed', 'doomed body');
    await openThread(d, 1);
    const ask = await d.sendText('D1');
    expect(ask).toContain('Type DELETE to confirm');
    const out = await d.sendText('DELETE');
    expect(out).toContain('Post deleted.');
    // Gone from every read surface; other posts survive untouched.
    const data = await env.deps.boards.readData();
    expect(data.threads.find((t) => t.subject === 'Doomed')).toBeUndefined();
    expect(await env.deps.boards.findPost('seed-post-1a')).not.toBeNull();
    // Tombstone in the log, live event published.
    const log = await sync.syncLog.read();
    expect(log.entries.some((e) => e.kind === 'tombstone')).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'edit', action: 'deleted', handle: 'Alice', subject: 'Doomed' }),
    );
    expect(env.deps.sessionDrafts?.size ?? 0).toBe(0);
  });

  it('returns to the thread list when the last post is deleted', async () => {
    const { d } = await setup();
    await postThread(d, 'Only Post', 'only body');
    await openThread(d, 1);
    await d.send('D1');
    const out = await d.sendText('DELETE');
    expect(out).toContain('The thread is now empty.');
    expect(d.state.phase).toBe('THREAD_LIST');
  });

  it('cancels on any other input, including Q, and keeps the post', async () => {
    const { d } = await setup();
    const threadId = await postThread(d, 'Survivor', 'survivor body');
    await openThread(d, 1);
    await d.send('D1');
    const cancelled = await d.sendText('nope');
    expect(cancelled).toContain('Delete cancelled.');
    expect(d.state.phase).toBe('READING_THREAD');
    await d.send('D1');
    const cancelledQ = await d.sendText('Q');
    expect(cancelledQ).toContain('Delete cancelled.');
    expect(d.state.phase).toBe('READING_THREAD');
    const thread = await threadById(threadId);
    expect(thread.posts[0].body).toBe('survivor body');
  });

  it('refuses deletes of other callers\u2019 posts and archive posts', async () => {
    await setup('Alice');
    const alice = new SessionDriver(env.deps);
    await alice.login('Alice', 'pass1234');
    await postThread(alice, 'Alice Thread', 'alice body');
    const bob = new SessionDriver(env.deps);
    await bob.register('Bob', 'pass1234');
    await bob.send('1');
    await bob.send('1');
    await bob.send('1');
    expect(await bob.sendText('D1')).toContain('You can only delete your own posts.');
    const threads = await env.deps.boards.listThreads('general');
    const archiveIdx = threads.findIndex((t) => t.posts.some((p) => p.isArchive));
    await bob.send('Q');
    await bob.sendText(String(archiveIdx + 1));
    expect(await bob.sendText('D1')).toContain('Archive posts from 1994 cannot be deleted.');
  });
});

describe('federated score seam (PRO-DEV)', () => {
  it('appends a score entry to the sync log on victory', async () => {
    env = await createTestEnv();
    env.setRng(() => 0.5);
    const sync = await attachSync(env, 'node-victory');
    const user = await env.deps.users.createUser('Alice', 'pass1234', new Date());
    const today = todayLocal(env.deps.now());
    const strong = {
      ...newCharacter(user.id, today),
      hp: 100,
      maxHp: 100,
      attack: 30,
      defense: 10,
      level: 5,
      dungeonDepth: 5,
    };
    await env.deps.users.saveCharacter(user.id, strong);
    const d = new SessionDriver(env.deps);
    await d.login('Alice', 'pass1234');
    await d.send('3');
    await d.send('E');
    await d.send('A');
    const victory = await d.sendText('A');
    expect(victory).toContain('VICTORY');
    const log = await sync.syncLog.read();
    const scoreEntry = log.entries.find((e) => e.kind === 'score');
    expect(scoreEntry).toBeDefined();
    // The federated score matches the victory actually recorded locally.
    const fame = await env.deps.scores.getHallOfFame();
    expect(fame).toHaveLength(1);
    expect(scoreEntry?.score).toEqual({ handle: 'Alice', level: fame[0].level });
    expect(scoreEntry?.origin).toBe('node-victory');
  });
});
