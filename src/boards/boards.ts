/**
 * src/boards/boards.ts — Board operations (builder-written, per design §2.7).
 *
 * All functions are async and built on AtomicStore. Thread lists are sorted
 * newest-first by most recent post. Read markers advance only forward.
 *
 * PRO-DEV amendment: the read boundary filters tombstoned posts. Every
 * public read (listThreads, getThread, findPost, readData,
 * getUnreadCounts) returns the display view — tombstoned posts never
 * appear, and threads with no visible posts never appear in lists.
 * getThread may return a thread whose posts array is empty (every post
 * deleted) so a session sitting in the thread can still leave cleanly.
 * Raw data is only ever touched inside write callbacks and the explicit
 * findPostRaw marker lookup, so delete-wins and LWW checks always see
 * the full picture. Edits mutate the stored post in place and record an
 * overlay entry in postMeta (see src/shared/validation.ts); search, the
 * API, and unread counts automatically see edited content.
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

/** The display view of stored data: tombstoned posts removed. */
function visibleThreads(data: BoardsData): Thread[] {
  return data.threads.map((t) => ({
    ...t,
    posts: t.posts.filter((p) => data.tombstones[p.id] === undefined),
  }));
}

/** Outcome of applying an edit operation (local or federated). */
export type EditApplyStatus =
  | 'applied'
  | 'superseded'
  | 'tombstoned'
  | 'unknown-post'
  | 'forbidden';

/** Outcome of applying a tombstone operation (local or federated). */
export type TombstoneApplyStatus = 'applied' | 'already' | 'unknown-post' | 'forbidden';

export interface EditOperation {
  postId: string;
  threadId: string;
  boardId: string;
  authorHandle: string;
  subject: string;
  body: string;
  /** Entry timestamp (ISO 8601): the LWW key, with entryId as tie-break. */
  at: string;
  entryId: string;
}

export interface TombstoneOperation {
  postId: string;
  threadId: string;
  boardId: string;
  authorHandle: string;
  at: string;
  entryId: string;
}

export class BoardStore {
  private readonly store: AtomicStore<BoardsData>;

  public constructor(store: AtomicStore<BoardsData>) {
    this.store = store;
  }

  /**
   * The display view: threads with tombstoned posts removed (threads left
   * empty are dropped), plus the postMeta/tombstones overlays for marker
   * rendering. Consumers that need raw data (sync apply, marker
   * resolution) use write callbacks or findPostRaw instead.
   */
  public async readData(): Promise<BoardsData> {
    const data = await this.store.read();
    return {
      ...data,
      threads: visibleThreads(data).filter((t) => t.posts.length > 0),
    };
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
    return visibleThreads(data)
      .filter((t) => t.boardId === boardId && t.posts.length > 0)
      .sort((a, b) => {
        const la = lastPostOf(a);
        const lb = lastPostOf(b);
        if (la === null && lb === null) return 0;
        if (la === null) return 1;
        if (lb === null) return -1;
        return comparePosts(lb, la);
      });
  }

  /** A thread with tombstoned posts removed; may have an empty posts array. */
  public async getThread(threadId: string): Promise<Thread> {
    const data = await this.store.read();
    const thread = data.threads.find((t) => t.id === threadId);
    if (thread === undefined) {
      throw new ValidationError('Thread not found.');
    }
    return {
      ...thread,
      posts: thread.posts.filter((p) => data.tombstones[p.id] === undefined),
    };
  }

  /** A visible post, or null when absent or tombstoned. */
  public async findPost(postId: string): Promise<Post | null> {
    const data = await this.store.read();
    if (data.tombstones[postId] !== undefined) return null;
    for (const thread of data.threads) {
      const post = thread.posts.find((p) => p.id === postId);
      if (post !== undefined) return post;
    }
    return null;
  }

  /**
   * A post regardless of tombstone state, or null when truly absent. Used
   * ONLY for read-marker resolution: a marker pointing at a deleted post
   * must still order correctly, or deleting an old post would mark a whole
   * board unread. Never used to display content.
   */
  public async findPostRaw(postId: string): Promise<Post | null> {
    const data = await this.store.read();
    for (const thread of data.threads) {
      const post = thread.posts.find((p) => p.id === postId);
      if (post !== undefined) return post;
    }
    return null;
  }

  /** The winning edit overlay for a post, or null when never edited. */
  public async getPostMeta(postId: string): Promise<{ editedAt: string; editEntryId: string } | null> {
    const data = await this.store.read();
    return data.postMeta[postId] ?? null;
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
   * Unread counts per board for a user: VISIBLE posts newer than the
   * user's read marker for that board. The marker resolves against raw
   * data (see findPostRaw), so a deleted marker post still orders
   * correctly. No marker means everything visible is unread.
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
          if (data.tombstones[post.id] !== undefined) continue;
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

  /**
   * Federation import: store a thread received from a peer, verbatim ids.
   * Returns false when a thread with this id already exists (idempotent:
   * receiving the same entry twice never duplicates). Posts already under
   * a tombstone are filtered out (delete-wins survives even a lost
   * seen-set); when nothing visible remains, the thread is not stored.
   * The caller owns validation and sanitization (see sync/engine.ts).
   * Throws ValidationError for an unknown board.
   */
  public async importThread(thread: Thread): Promise<boolean> {
    await this.getBoard(thread.boardId);
    let inserted = false;
    await this.store.write((data) => {
      if (data.threads.some((t) => t.id === thread.id)) return data;
      const visible = thread.posts.filter((p) => data.tombstones[p.id] === undefined);
      if (visible.length === 0) return data;
      inserted = true;
      return { ...data, threads: [...data.threads, { ...thread, posts: visible }] };
    });
    return inserted;
  }

  /**
   * Federation import: store a reply received from a peer, verbatim id,
   * inserted in chronological order (comparePosts) so late or out-of-order
   * arrivals still display in the right place. Returns 'duplicate' when a
   * post with this id already exists, 'suppressed' when the post is under
   * a tombstone (delete-wins: the add is recorded by the caller but never
   * displayed), and 'unknown-thread' when the thread has not arrived yet
   * (the caller queues it as pending).
   */
  public async importReply(
    post: Post,
  ): Promise<'imported' | 'duplicate' | 'suppressed' | 'unknown-thread'> {
    let status: 'imported' | 'duplicate' | 'suppressed' | 'unknown-thread' = 'unknown-thread';
    await this.store.write((data) => {
      if (data.tombstones[post.id] !== undefined) {
        status = 'suppressed';
        return data;
      }
      if (data.threads.some((t) => t.posts.some((p) => p.id === post.id))) {
        status = 'duplicate';
        return data;
      }
      if (!data.threads.some((t) => t.id === post.threadId)) {
        status = 'unknown-thread';
        return data;
      }
      status = 'imported';
      return {
        ...data,
        threads: data.threads.map((t) =>
          t.id === post.threadId
            ? { ...t, posts: [...t.posts, post].sort(comparePosts) }
            : t,
        ),
      };
    });
    return status;
  }

  /**
   * Apply an edit operation (local or federated — one code path, one set
   * of rules). Checks run in order: existence, archive, authorship,
   * tombstone (delete-wins), then LWW over (at, entryId). Idempotent:
   * re-applying the winning edit returns 'superseded' (equal key).
   * Editing a thread's first post also updates the thread subject.
   */
  public async applyEdit(op: EditOperation): Promise<EditApplyStatus> {
    let status: EditApplyStatus = 'unknown-post';
    await this.store.write((data) => {
      const thread = data.threads.find((t) => t.id === op.threadId);
      const post = thread?.posts.find((p) => p.id === op.postId);
      if (thread === undefined || post === undefined) {
        status = 'unknown-post';
        return data;
      }
      if (post.isArchive) {
        status = 'forbidden';
        return data;
      }
      if (post.authorHandle.toLowerCase() !== op.authorHandle.toLowerCase()) {
        status = 'forbidden';
        return data;
      }
      if (data.tombstones[op.postId] !== undefined) {
        status = 'tombstoned';
        return data;
      }
      const existing = data.postMeta[op.postId];
      if (
        existing !== undefined &&
        (existing.editedAt > op.at ||
          (existing.editedAt === op.at && existing.editEntryId >= op.entryId))
      ) {
        status = 'superseded';
        return data;
      }
      status = 'applied';
      const sorted = [...thread.posts].sort(comparePosts);
      const isFirstPost = sorted[0]?.id === op.postId;
      return {
        ...data,
        threads: data.threads.map((t) =>
          t.id === op.threadId
            ? {
                ...t,
                subject: isFirstPost ? op.subject : t.subject,
                posts: t.posts.map((p) =>
                  p.id === op.postId ? { ...p, subject: op.subject, body: op.body } : p,
                ),
              }
            : t,
        ),
        postMeta: {
          ...data.postMeta,
          [op.postId]: { editedAt: op.at, editEntryId: op.entryId },
        },
      };
    });
    return status;
  }

  /**
   * Apply a tombstone operation (local or federated — one code path).
   * Checks run in order: existence, archive, authorship, then
   * idempotence. Once tombstoned, a post never displays again, whatever
   * arrives later (see importThread/importReply/applyEdit).
   */
  public async applyTombstone(op: TombstoneOperation): Promise<TombstoneApplyStatus> {
    let status: TombstoneApplyStatus = 'unknown-post';
    await this.store.write((data) => {
      const thread = data.threads.find((t) => t.id === op.threadId);
      const post = thread?.posts.find((p) => p.id === op.postId);
      if (thread === undefined || post === undefined) {
        status = 'unknown-post';
        return data;
      }
      if (post.isArchive) {
        status = 'forbidden';
        return data;
      }
      if (post.authorHandle.toLowerCase() !== op.authorHandle.toLowerCase()) {
        status = 'forbidden';
        return data;
      }
      if (data.tombstones[op.postId] !== undefined) {
        status = 'already';
        return data;
      }
      status = 'applied';
      return {
        ...data,
        tombstones: {
          ...data.tombstones,
          [op.postId]: { deletedAt: op.at, entryId: op.entryId },
        },
      };
    });
    return status;
  }
}
