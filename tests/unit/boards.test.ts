import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/shared/errors.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

describe('BoardStore', () => {
  it('seeds four boards and eight archive threads', async () => {
    env = await createTestEnv();
    const boards = await env.deps.boards.listBoards();
    expect(boards).toHaveLength(4);
    expect(boards.map((b) => b.id)).toEqual(['general', 'tech', 'games', 'crypt']);
    const data = await env.deps.boards.readData();
    expect(data.threads).toHaveLength(8);
    expect(data.threads.every((t) => t.posts.every((p) => p.isArchive))).toBe(true);
    expect(data.threads.every((t) => t.createdAt.startsWith('1994'))).toBe(true);
  });

  it('creates threads and replies, newest-first ordering', async () => {
    env = await createTestEnv();
    const t0 = new Date('2026-11-19T12:00:00.000Z');
    const t1 = new Date('2026-11-19T12:01:00.000Z');
    const first = await env.deps.boards.createThread('general', 'Alice', 'First', 'Body one', t0);
    const second = await env.deps.boards.createThread('general', 'Bob', 'Second', 'Body two', t1);
    await env.deps.boards.replyToThread(first.id, 'Bob', 'Reply to first', new Date('2026-11-19T12:02:00.000Z'));
    const threads = await env.deps.boards.listThreads('general');
    // First thread has the newest post (the reply), so it sorts first.
    expect(threads[0].id).toBe(first.id);
    expect(threads[1].id).toBe(second.id);
    const loaded = await env.deps.boards.getThread(first.id);
    expect(loaded.posts).toHaveLength(2);
    expect(loaded.posts[1].body).toBe('Reply to first');
    expect(loaded.posts[1].isArchive).toBe(false);
  });

  it('enforces subject and body caps without truncating', async () => {
    env = await createTestEnv();
    const now = new Date();
    await expect(
      env.deps.boards.createThread('general', 'Alice', 'x'.repeat(73), 'ok', now),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      env.deps.boards.createThread('general', 'Alice', 'ok', 'y'.repeat(4097), now),
    ).rejects.toBeInstanceOf(ValidationError);
    const ok = await env.deps.boards.createThread(
      'general',
      'Alice',
      'x'.repeat(72),
      'y'.repeat(4096),
      now,
    );
    expect(ok.posts[0].subject).toHaveLength(72);
    expect(ok.posts[0].body).toHaveLength(4096);
  });

  it('strips ANSI from subjects and bodies', async () => {
    env = await createTestEnv();
    const thread = await env.deps.boards.createThread(
      'general',
      'Alice',
      '\x1b[31mRed\x1b[0m',
      'Body \x1b[2J here',
      new Date(),
    );
    expect(thread.subject).toBe('Red');
    expect(thread.posts[0].body).toBe('Body  here');
  });

  it('rejects unknown boards and threads', async () => {
    env = await createTestEnv();
    await expect(env.deps.boards.listThreads('nope')).rejects.toBeInstanceOf(ValidationError);
    await expect(env.deps.boards.getThread('nope')).rejects.toBeInstanceOf(ValidationError);
    await expect(
      env.deps.boards.replyToThread('nope', 'Alice', 'hi', new Date()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('counts unread posts against read markers', async () => {
    env = await createTestEnv();
    const counts0 = await env.deps.boards.getUnreadCounts({});
    // Seed: general has 4 posts, tech 3, games 3, crypt 2.
    expect(counts0).toEqual({ general: 4, tech: 3, games: 3, crypt: 2 });
    const threads = await env.deps.boards.listThreads('general');
    const newestId = env.deps.boards.newestPostId(threads[0]);
    const counts1 = await env.deps.boards.getUnreadCounts({ general: newestId ?? '' });
    expect(counts1['general']).toBe(0);
    expect(counts1['tech']).toBe(3);
  });
});
