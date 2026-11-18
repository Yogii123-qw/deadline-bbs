/**
 * src/sync/engine.ts — Federation sync engine (builder-written, FEDERATION amendment).
 *
 * Anti-entropy over HTTP: each round, a node POSTs its whole log to a peer
 * and receives the peer's whole log back; both sides apply what they lack.
 * Exchange is idempotent (seen-set + idempotent board imports) and
 * loop-free (discrete rounds over immutable, globally unique entries:
 * an entry that circles a ring arrives back at its origin as a no-op).
 *
 * Store-and-forward falls out of the design: entries a peer lacks stay in
 * the log, and the next successful round delivers them — after an offline
 * peer returns, its startup sync pulls everything it missed.
 *
 * Trust: peers are untrusted input. Every entry is validated (Zod +
 * semantic checks) and re-sanitized before it touches the board store;
 * one bad entry is skipped and logged, never fails a round.
 */

import { comparePosts, type BoardStore } from '../boards/boards.js';
import { REMOTE_SENDER_ID, type LiveHub } from '../server/live.js';
import type { Post, Thread } from '../shared/types.js';
import { validateHandle, validatePost } from '../shared/validation.js';
import { zSyncEntry, zSyncExchangeRequest, type SyncLogData } from './entries.js';
import type { SyncLogStore } from './store.js';

export const SYNC_TIMEOUT_MS = 5000;

export interface ApplyResult {
  applied: number;
  duplicates: number;
  skipped: number;
  /** Pending entries outstanding after this round. */
  pending: number;
}

export interface SyncEngineOptions {
  boards: BoardStore;
  syncLog: SyncLogStore;
  nodeId: string;
  /** Validated base URLs (no trailing slash). Empty = standalone node. */
  peers: readonly string[];
  secret?: string;
  intervalMs: number;
  hub?: LiveHub;
  onLog: (message: string) => void;
}

function isParsableDate(value: string): boolean {
  return value !== '' && !Number.isNaN(Date.parse(value));
}

export class SyncEngine {
  private readonly boards: BoardStore;
  private readonly syncLog: SyncLogStore;
  private readonly nodeId: string;
  private readonly peers: readonly string[];
  private readonly secret: string | undefined;
  private readonly intervalMs: number;
  private readonly hub: LiveHub | undefined;
  private readonly onLog: (message: string) => void;
  private applyChain: Promise<void> = Promise.resolve();
  private syncChain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  public constructor(options: SyncEngineOptions) {
    this.boards = options.boards;
    this.syncLog = options.syncLog;
    this.nodeId = options.nodeId;
    this.peers = options.peers;
    this.secret = options.secret;
    this.intervalMs = options.intervalMs;
    this.hub = options.hub;
    this.onLog = options.onLog;
  }

  /**
   * Apply entries received from a peer (or from a test). Serialized: only
   * one apply runs at a time, so the log read-modify-write below cannot
   * lose entries to a concurrent round. Never throws for bad entries.
   */
  public async applyRemote(rawEntries: unknown[]): Promise<ApplyResult> {
    const run = this.applyChain.then(() => this.applyRemoteNow(rawEntries));
    this.applyChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyRemoteNow(rawEntries: unknown[]): Promise<ApplyResult> {
    const result: ApplyResult = { applied: 0, duplicates: 0, skipped: 0, pending: 0 };
    const log = await this.syncLog.read();
    const seen = new Set<string>([
      ...log.entries.map((e) => e.id),
      ...log.pending.map((e) => e.id),
    ]);
    let pending = [...log.pending];
    const newEntries: Array<(typeof log.entries)[number]> = [];
    let changed = false;

    const resolvePendingFor = async (threadId: string): Promise<void> => {
      const still: typeof pending = [];
      for (const entry of pending) {
        if (entry.kind !== 'reply' || entry.post === undefined || entry.post.threadId !== threadId) {
          still.push(entry);
          continue;
        }
        const cleaned = await this.cleanReply(entry.post);
        if (cleaned === null) {
          // Never drop a pending entry: keep it for a later round.
          still.push(entry);
          continue;
        }
        const status = await this.boards.importReply(cleaned);
        if (status === 'unknown-thread') {
          still.push(entry);
          continue;
        }
        newEntries.push(entry);
        changed = true;
        if (status === 'imported') {
          result.applied += 1;
          await this.publishRemotePost(entry, cleaned, true);
        } else {
          result.duplicates += 1;
        }
      }
      pending = still;
    };

    // A thread may have arrived in an earlier round (or been created
    // locally) while its replies waited: retry those first.
    const pendingThreadIds = new Set(
      pending
        .filter((e) => e.kind === 'reply' && e.post !== undefined)
        .map((e) => (e.post as Post).threadId),
    );
    for (const threadId of pendingThreadIds) {
      let exists = true;
      try {
        await this.boards.getThread(threadId);
      } catch {
        exists = false;
      }
      if (exists) await resolvePendingFor(threadId);
    }

    for (const raw of rawEntries) {
      const parsed = zSyncEntry.safeParse(raw);
      if (!parsed.success) {
        result.skipped += 1;
        this.onLog(`Sync: skipping malformed entry (${parsed.error.issues[0]?.message ?? 'invalid'}).`);
        continue;
      }
      const entry = parsed.data;
      if (seen.has(entry.id)) {
        result.duplicates += 1;
        continue;
      }
      seen.add(entry.id);
      if (entry.kind === 'thread') {
        const cleaned = entry.thread === undefined ? null : await this.cleanThread(entry.thread);
        if (cleaned === null) {
          result.skipped += 1;
          this.onLog(`Sync: skipping thread entry ${entry.id} (failed semantic validation).`);
          continue;
        }
        const inserted = await this.boards.importThread(cleaned);
        newEntries.push(entry);
        changed = true;
        if (inserted) {
          result.applied += 1;
          await this.publishRemotePost(entry, cleaned, false);
          await resolvePendingFor(cleaned.id);
        } else {
          result.duplicates += 1;
        }
      } else {
        const cleaned = entry.post === undefined ? null : await this.cleanReply(entry.post);
        if (cleaned === null) {
          result.skipped += 1;
          this.onLog(`Sync: skipping reply entry ${entry.id} (failed semantic validation).`);
          continue;
        }
        const status = await this.boards.importReply(cleaned);
        if (status === 'unknown-thread') {
          pending.push(entry);
          changed = true;
          continue;
        }
        newEntries.push(entry);
        changed = true;
        if (status === 'imported') {
          result.applied += 1;
          await this.publishRemotePost(entry, cleaned, true);
        } else {
          result.duplicates += 1;
        }
      }
    }

    result.pending = pending.length;
    if (changed) {
      const entriesToAdd = newEntries;
      const pendingSnapshot = pending;
      await this.syncLog.write((current) => {
        const existing = new Set(current.entries.map((e) => e.id));
        return {
          ...current,
          entries: [
            ...current.entries,
            ...entriesToAdd.filter((e) => !existing.has(e.id)),
          ],
          pending: pendingSnapshot,
        };
      });
    }
    return result;
  }

  /**
   * Validate + sanitize a thread payload from a peer. Returns null when
   * the payload is not one this node will display: unknown board, empty
   * post list, bad timestamps, bad handle shape, oversized content, or
   * inconsistent ids/subjects. Archive flags are forced off: the archive
   * is local lore, never federated.
   */
  private async cleanThread(thread: Thread): Promise<Thread | null> {
    if (thread.id === '' || thread.posts.length === 0) return null;
    if (!isParsableDate(thread.createdAt)) return null;
    try {
      await this.boards.getBoard(thread.boardId);
    } catch {
      return null;
    }
    let author: string;
    try {
      author = validateHandle(thread.authorHandle);
    } catch {
      return null;
    }
    const posts: Post[] = [];
    for (const post of thread.posts) {
      if (post.id === '' || post.threadId !== thread.id || post.boardId !== thread.boardId) {
        return null;
      }
      if (post.subject !== thread.subject) return null;
      if (!isParsableDate(post.createdAt)) return null;
      let postAuthor: string;
      let clean: { subject: string; body: string };
      try {
        postAuthor = validateHandle(post.authorHandle);
        clean = validatePost(thread.subject, post.body);
      } catch {
        return null;
      }
      posts.push({
        ...post,
        authorHandle: postAuthor,
        subject: clean.subject,
        body: clean.body,
        isArchive: false,
      });
    }
    posts.sort(comparePosts);
    return {
      id: thread.id,
      boardId: thread.boardId,
      subject: posts[0].subject,
      authorHandle: author,
      createdAt: thread.createdAt,
      posts,
    };
  }

  /** Validate + sanitize a reply payload from a peer (see cleanThread). */
  private async cleanReply(post: Post): Promise<Post | null> {
    if (post.id === '' || post.threadId === '' || post.boardId === '') return null;
    if (!isParsableDate(post.createdAt)) return null;
    try {
      await this.boards.getBoard(post.boardId);
    } catch {
      return null;
    }
    let author: string;
    let clean: { subject: string; body: string };
    try {
      author = validateHandle(post.authorHandle);
      clean = validatePost(post.subject, post.body);
    } catch {
      return null;
    }
    return {
      ...post,
      authorHandle: author,
      subject: clean.subject,
      body: clean.body,
      isArchive: false,
    };
  }

  private async publishRemotePost(
    entry: { origin: string },
    payload: Thread | Post,
    isReply: boolean,
  ): Promise<void> {
    if (this.hub === undefined) return;
    let boardName = 'a board';
    try {
      boardName = (await this.boards.getBoard(payload.boardId)).name;
    } catch {
      // Board vanished between import and publish; keep the fallback.
    }
    this.hub.publish({
      kind: 'post',
      fromId: REMOTE_SENDER_ID,
      handle: payload.authorHandle,
      boardName,
      subject: payload.subject,
      isReply,
      originNode: entry.origin,
    });
  }

  /** One exchange round with one peer. Failures are logged, never thrown. */
  public async syncWith(peer: string): Promise<void> {
    let log: SyncLogData;
    try {
      log = await this.syncLog.read();
    } catch (err) {
      this.onLog(
        `Sync with ${peer} aborted: cannot read sync log (${err instanceof Error ? err.message : String(err)}).`,
      );
      return;
    }
    const payload = { nodeId: this.nodeId, entries: [...log.entries, ...log.pending] };
    let res: Response;
    try {
      res = await fetch(`${peer}/sync/exchange`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.secret !== undefined ? { 'x-sync-secret': this.secret } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });
    } catch (err) {
      this.onLog(`Sync with ${peer} failed: ${err instanceof Error ? err.message : String(err)}.`);
      return;
    }
    if (!res.ok) {
      this.onLog(`Sync with ${peer} rejected: HTTP ${res.status}.`);
      return;
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      this.onLog(`Sync with ${peer}: response was not JSON.`);
      return;
    }
    // Loose shape check: entries stay unknown so applyRemote can skip bad
    // ones individually instead of failing the whole round.
    const parsed = zSyncExchangeRequest.safeParse(data);
    if (!parsed.success) {
      this.onLog(`Sync with ${peer}: response failed validation.`);
      return;
    }
    const result = await this.applyRemote(parsed.data.entries);
    if (result.applied > 0 || result.skipped > 0) {
      this.onLog(
        `Sync with ${peer}: applied ${result.applied}, duplicates ${result.duplicates}, skipped ${result.skipped}, pending ${result.pending}.`,
      );
    }
  }

  /** Exchange with every peer, in order. Serialized: rounds never overlap. */
  public async syncAll(): Promise<void> {
    const run = this.syncChain.then(async () => {
      for (const peer of this.peers) {
        await this.syncWith(peer);
      }
    });
    this.syncChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Initial sync plus the periodic timer (when intervalMs > 0). */
  public start(): void {
    void this.syncAll();
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.syncAll();
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
