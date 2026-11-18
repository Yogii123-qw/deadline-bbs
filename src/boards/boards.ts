/**
 * src/boards/boards.ts — Board operations (builder-written, per design §2.7).
 *
 * All functions are async and built on AtomicStore. Thread lists are sorted
 * newest-first by most recent post. Read markers advance only forward.
 */

import { randomUUID } from 'node:crypto';
import type { Board, Post, Thread } from '../shared/types.js';
import type { BoardsData } from '../shared/validation.js';
import { validatePost } from '../shared/validation.js';
import { ValidationError } from '../shared/errors.js';
import type { AtomicStore } from './store.js';

/** Order posts chronologically; ties break by id for determinism. */
export function comparePosts(a: Post, b: Post): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function lastPostOf(thread: Thread): Post | null {
  if (thread.posts.length === 0) return null;
  return [...thread.posts].sort(comparePosts).at(-1) ?? null;
}

export class BoardStore {
  private readonly store: AtomicStore<BoardsData>;

  public constructor(store: AtomicStore<BoardsData>) {
    this.store = store;
  }

  public async readData(): Promise<BoardsData> {
    return this.store.read();
  }

  public async listBoards(): Promise<Board[]> {
    const data = await this.store.read();
    return data.boards;
  }

  public async getBoard(boardId: string): Promise<Board> {
    const data = await this.store.read();
    const board = data.boards.find((b) => b.id === boardId);
    if (board === undefined) {
      throw new ValidationError('Unknown board.');
    }
    return board;
  }

  public async listThreads(boardId: string): Promise<Thread[]> {
    await this.getBoard(boardId);
    const data = await this.store.read();
    return data.threads
      .filter((t) => t.boardId === boardId)
      .sort((a, b) => {
        const la = lastPostOf(a);
        const lb = lastPostOf(b);
        if (la === null && lb === null) return 0;
        if (la === null) return 1;
        if (lb === null) return -1;
        return comparePosts(lb, la);
      });
  }

  public async getThread(threadId: string): Promise<Thread> {
    const data = await this.store.read();
    const thread = data.threads.find((t) => t.id === threadId);
    if (thread === undefined) {
      throw new ValidationError('Thread not found.');
    }
    return thread;
  }

  public async findPost(postId: string): Promise<Post | null> {
    const data = await this.store.read();
    for (const thread of data.threads) {
      const post = thread.posts.find((p) => p.id === postId);
      if (post !== undefined) return post;
    }
    return null;
  }

  public async createThread(
    boardId: string,
    authorHandle: string,
    subject: string,
    body: string,
    now: Date,
  ): Promise<Thread> {
    await this.getBoard(boardId);
    const clean = validatePost(subject, body);
    const nowIso = now.toISOString();
    const threadId = randomUUID();
    const post: Post = {
      id: randomUUID(),
      threadId,
      boardId,
      authorHandle,
      subject: clean.subject,
      body: clean.body,
      createdAt: nowIso,
      isArchive: false,
    };
    const thread: Thread = {
      id: threadId,
      boardId,
      subject: clean.subject,
      authorHandle,
      createdAt: nowIso,
      posts: [post],
    };
    await this.store.write((data) => ({
      ...data,
      threads: [...data.threads, thread],
    }));
    return thread;
  }

  public async replyToThread(
    threadId: string,
    authorHandle: string,
    body: string,
    now: Date,
  ): Promise<Post> {
    const thread = await this.getThread(threadId);
    const clean = validatePost(thread.subject, body);
    const post: Post = {
      id: randomUUID(),
      threadId,
      boardId: thread.boardId,
      authorHandle,
      subject: thread.subject,
      body: clean.body,
      createdAt: now.toISOString(),
      isArchive: false,
    };
    await this.store.write((data) => ({
      ...data,
      threads: data.threads.map((t) =>
        t.id === threadId ? { ...t, posts: [...t.posts, post] } : t,
      ),
    }));
    return post;
  }

  /**
   * Unread counts per board for a user: posts newer than the user's read
   * marker for that board. No marker means everything is unread.
   */
  public async getUnreadCounts(
    readMarkers: Record<string, string>,
  ): Promise<Record<string, number>> {
    const data = await this.store.read();
    const counts: Record<string, number> = {};
    for (const board of data.boards) {
      const markerId = readMarkers[board.id];
      const markerPost =
        markerId === undefined
          ? null
          : data.threads
              .flatMap((t) => t.posts)
              .find((p) => p.id === markerId) ?? null;
      let unread = 0;
      for (const thread of data.threads) {
        if (thread.boardId !== board.id) continue;
        for (const post of thread.posts) {
          if (markerPost === null || comparePosts(post, markerPost) > 0) {
            unread += 1;
          }
        }
      }
      counts[board.id] = unread;
    }
    return counts;
  }

  /** The newest post of a thread (for advancing read markers). */
  public newestPostId(thread: Thread): string | null {
    return lastPostOf(thread)?.id ?? null;
  }
}
