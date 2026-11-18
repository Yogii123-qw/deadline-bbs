/**
 * src/sync/engine.ts — Federation sync engine (builder-written, FEDERATION
 * amendment; extended by the PRO-DEV amendment).
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
 * Operation semantics (PRO-DEV amendment §2.2, CRDT-style): add, edit,
 * tombstone, and score operations are commutative and idempotent, so any
 * set of delivered operations converges to the same visible state
 * regardless of order, duplication, or delay. Edits resolve by
 * last-writer-wins over (at, entryId); tombstones always win over adds
 * and edits. Operations whose target has not arrived yet wait in the
 * persistent pending queue and resolve automatically when it does.
 *
 * Trust: peers are untrusted input. Every entry is validated (Zod +
 * semantic checks) and re-sanitized before it touches the board store;
 * one bad entry is skipped and logged, never fails a round.
 */

import {
  comparePosts,
  type BoardStore,
  type EditOperation,
  type TombstoneOperation,
} from '../boards/boards.js';
import type { ScoreStore } from '../game/scores.js';
import { REMOTE_SENDER_ID, type LiveHub } from '../server/live.js';
import type { Post, Thread } from '../shared/types.js';
import { validateHandle, validatePost } from '../shared/validation.js';
import {
  zSyncEntry,
  zSyncExchangeRequest,
  type EditPayload,
  type ScorePayload,
  type SyncEntry,
  type SyncLogData,
  type TombstonePayload,
} from './entries.js';
import type { SyncLogStore } from './store.js';

export const SYNC_TIMEOUT_MS = 5000;

export interface ApplyResult {
  applied: number;
  duplicates: number;
  skipped: number;
  /** Pending entries outstanding after this round. */
  pending: number;
}

/** Last-round outcome for one peer (in-memory; resets on restart). */
export interface PeerRoundStats {
  /** ISO 8601 time of the last attempted round, or null when never. */
  lastRoundAt: string | null;
  applied: number;
  duplicates: number;
  skipped: number;
  /** Failure description for the last round, or null when it succeeded. */
  lastError: string | null;
}

/** Everything the in-BBS NODE STATUS screen shows. No peer URLs: peers
 *  are identified by position only, as in /api/status. */
export interface NodeStatusData {
  nodeId: string;
  peerCount: number;
  entryCount: number;
  pendingCount: number;
  /** Most recent round across all peers, or null when no round ran yet. */
  lastRoundAt: string | null;
  secretSet: boolean;
  peers: PeerRoundStats[];
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
  /** Absent = score entries are skipped (no store to record them in). */
  scores?: ScoreStore;
  onLog: (message: string) => void;
}

function isParsableDate(value: string): boolean {
  return value !== '' && !Number.isNaN(Date.parse(value));
}

function emptyPeerStats(): PeerRoundStats {
  return { lastRoundAt: null, applied: 0, duplicates: 0, skipped: 0, lastError: null };
}

export class SyncEngine {
  private readonly boards: BoardStore;
  private readonly syncLog: SyncLogStore;
  private readonly nodeId: string;
  private readonly peers: readonly string[];
  private readonly secret: string | undefined;
  private readonly intervalMs: number;
  private readonly hub: LiveHub | undefined;
  private readonly scores: ScoreStore | undefined;
  private readonly onLog: (message: string) => void;
  private readonly peerStats = new Map<string, PeerRoundStats>();
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
    this.scores = options.scores;
    this.onLog = options.onLog;
  }

  /** Snapshot of engine state for the NODE STATUS screen. */
  public async getStats(): Promise<NodeStatusData> {
    const log = await this.syncLog.read();
    const peers = this.peers.map((peer) => this.peerStats.get(peer) ?? emptyPeerStats());
    // Overall last round: the most recent round the engine ran, including
    // direct syncWith calls outside the configured peer list (in
    // production every round goes through syncAll, so the two agree).
    const lastRoundAt = [...this.peerStats.values()].reduce<string | null>(
      (latest, p) =>
        p.lastRoundAt !== null && (latest === null || p.lastRoundAt > latest)
          ? p.lastRoundAt
          : latest,
      null,
    );
    return {
      nodeId: this.nodeId,
      peerCount: this.peers.length,
      entryCount: log.entries.length,
      pendingCount: log.pending.length,
      lastRoundAt,
      secretSet: this.secret !== undefined,
      peers,
    };
  }

  private recordRound(
    peer: string,
    outcome: { applied: number; duplicates: number; skipped: number } | { error: string },
  ): void {
    if ('error' in outcome) {
      this.peerStats.set(peer, {
        ...emptyPeerStats(),
        lastRoundAt: new Date().toISOString(),
        lastError: outcome.error,
      });
      return;
    }
    this.peerStats.set(peer, {
      lastRoundAt: new Date().toISOString(),
      applied: outcome.applied,
      duplicates: outcome.duplicates,
      skipped: outcome.skipped,
      lastError: null,
    });
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
    const newEntries: SyncEntry[] = [];
    let changed = false;

    type Attempt =
      | { resolution: 'resolved'; counted: 'applied' | 'duplicates' }
      | { resolution: 'waiting' }
      | { resolution: 'rejected' };

    /** Apply one cleaned reply/edit/tombstone. Never called for scores. */
    const attempt = async (entry: SyncEntry): Promise<Attempt> => {
      if (entry.kind === 'reply' && entry.post !== undefined) {
        const cleaned = await this.cleanReply(entry.post);
        if (cleaned === null) return { resolution: 'waiting' };
        const status = await this.boards.importReply(cleaned);
        if (status === 'unknown-thread') return { resolution: 'waiting' };
        if (status === 'imported') {
          await this.publishRemotePost(entry, cleaned, true);
          return { resolution: 'resolved', counted: 'applied' };
        }
        return { resolution: 'resolved', counted: 'duplicates' };
      }
      if (entry.kind === 'edit' && entry.edit !== undefined) {
        const cleaned = await this.cleanEdit(entry.edit, entry.at);
        if (cleaned === null) return { resolution: 'waiting' };
        const op: EditOperation = { ...cleaned, at: entry.at, entryId: entry.id };
        const status = await this.boards.applyEdit(op);
        if (status === 'unknown-post') return { resolution: 'waiting' };
        if (status === 'forbidden') {
          this.onLog(`Sync: rejecting edit entry ${entry.id} (not the post's author, or archive).`);
          return { resolution: 'rejected' };
        }
        if (status === 'applied') {
          await this.publishRemoteEdit(entry, cleaned, cleaned.subject, 'edited');
          return { resolution: 'resolved', counted: 'applied' };
        }
        return { resolution: 'resolved', counted: 'duplicates' };
      }
      if (entry.kind === 'tombstone' && entry.tombstone !== undefined) {
        const cleaned = await this.cleanTombstone(entry.tombstone, entry.at);
        if (cleaned === null) return { resolution: 'waiting' };
        const op: TombstoneOperation = { ...cleaned, at: entry.at, entryId: entry.id };
        const status = await this.boards.applyTombstone(op);
        if (status === 'unknown-post') return { resolution: 'waiting' };
        if (status === 'forbidden') {
          this.onLog(
            `Sync: rejecting tombstone entry ${entry.id} (not the post's author, or archive).`,
          );
          return { resolution: 'rejected' };
        }
        if (status === 'applied') {
          const subject = (await this.boards.findPostRaw(op.postId))?.subject ?? 'a post';
          await this.publishRemoteEdit(entry, cleaned, subject, 'deleted');
          return { resolution: 'resolved', counted: 'applied' };
        }
        return { resolution: 'resolved', counted: 'duplicates' };
      }
      return { resolution: 'waiting' };
    };

    /**
     * Retry every pending entry to a fixed point: an entry whose target
     * arrived resolves, which may unblock the next. Entries that fail
     * cleaning stay pending (never dropped on a transient); entries that
     * fail authorship are dropped (authorship never changes).
     */
    const resolvePending = async (): Promise<void> => {
      let progressed = true;
      while (progressed && pending.length > 0) {
        progressed = false;
        const still: SyncEntry[] = [];
        for (const entry of pending) {
          const outcome = await attempt(entry);
          if (outcome.resolution === 'resolved') {
            newEntries.push(entry);
            changed = true;
            progressed = true;
            if (outcome.counted === 'applied') result.applied += 1;
            else result.duplicates += 1;
          } else if (outcome.resolution === 'waiting') {
            still.push(entry);
          } else {
            changed = true;
            progressed = true;
            result.skipped += 1;
          }
        }
        pending = still;
      }
    };

    // Targets may have arrived in an earlier round (or been created
    // locally) while operations waited: retry those first.
    await resolvePending();

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
          await resolvePending();
        } else {
          result.duplicates += 1;
        }
        continue;
      }
      if (entry.kind === 'score') {
        const cleaned = entry.score === undefined ? null : await this.cleanScore(entry.score, entry.at);
        if (cleaned === null || this.scores === undefined) {
          result.skipped += 1;
          this.onLog(
            `Sync: skipping score entry ${entry.id} (${this.scores === undefined ? 'no score store configured' : 'failed semantic validation'}).`,
          );
          continue;
        }
        const recorded = await this.scores.recordNetworkScore({
          handle: cleaned.handle,
          level: cleaned.level,
          timestamp: entry.at,
          originNode: entry.origin,
          entryId: entry.id,
        });
        newEntries.push(entry);
        changed = true;
        if (recorded) result.applied += 1;
        else result.duplicates += 1;
        continue;
      }
      // reply / edit / tombstone: clean first (a fresh entry that fails
      // cleaning is skipped, never pended); then attempt.
      const preClean =
        entry.kind === 'reply'
          ? entry.post !== undefined && (await this.cleanReply(entry.post)) !== null
          : entry.kind === 'edit'
            ? entry.edit !== undefined && (await this.cleanEdit(entry.edit, entry.at)) !== null
            : entry.tombstone !== undefined &&
              (await this.cleanTombstone(entry.tombstone, entry.at)) !== null;
      if (!preClean) {
        result.skipped += 1;
        this.onLog(`Sync: skipping ${entry.kind} entry ${entry.id} (failed semantic validation).`);
        continue;
      }
      const outcome = await attempt(entry);
      if (outcome.resolution === 'waiting') {
        pending.push(entry);
        changed = true;
        continue;
      }
      if (outcome.resolution === 'rejected') {
        result.skipped += 1;
        continue;
      }
      newEntries.push(entry);
      changed = true;
      if (outcome.counted === 'applied') {
        result.applied += 1;
        await resolvePending();
      } else {
        result.duplicates += 1;
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

  /**
   * Validate + sanitize an edit payload. Shape, board, handle, content,
   * and entry timestamp only — target existence and authorship live in
   * BoardStore.applyEdit, because an edit for a not-yet-arrived post
   * must wait in pending, not be skipped.
   */
  private async cleanEdit(payload: EditPayload, at: string): Promise<EditPayload | null> {
    if (payload.postId === '' || payload.threadId === '' || payload.boardId === '') return null;
    if (!isParsableDate(at)) return null;
    try {
      await this.boards.getBoard(payload.boardId);
    } catch {
      return null;
    }
    try {
      const author = validateHandle(payload.authorHandle);
      const clean = validatePost(payload.subject, payload.body);
      return { ...payload, authorHandle: author, subject: clean.subject, body: clean.body };
    } catch {
      return null;
    }
  }

  /** Validate + sanitize a tombstone payload (see cleanEdit). */
  private async cleanTombstone(
    payload: TombstonePayload,
    at: string,
  ): Promise<TombstonePayload | null> {
    if (payload.postId === '' || payload.threadId === '' || payload.boardId === '') return null;
    if (!isParsableDate(at)) return null;
    try {
      await this.boards.getBoard(payload.boardId);
    } catch {
      return null;
    }
    try {
      return { ...payload, authorHandle: validateHandle(payload.authorHandle) };
    } catch {
      return null;
    }
  }

  /** Validate + sanitize a score payload. Level bounds mirror the schema. */
  private async cleanScore(payload: ScorePayload, at: string): Promise<ScorePayload | null> {
    if (!isParsableDate(at)) return null;
    if (!Number.isInteger(payload.level) || payload.level < 1 || payload.level > 99) return null;
    try {
      return { handle: validateHandle(payload.handle), level: payload.level };
    } catch {
      return null;
    }
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

  private async publishRemoteEdit(
    entry: { origin: string },
    payload: { authorHandle: string; boardId: string },
    subject: string,
    action: 'edited' | 'deleted',
  ): Promise<void> {
    if (this.hub === undefined) return;
    let boardName = 'a board';
    try {
      boardName = (await this.boards.getBoard(payload.boardId)).name;
    } catch {
      // Board vanished between apply and publish; keep the fallback.
    }
    this.hub.publish({
      kind: 'edit',
      fromId: REMOTE_SENDER_ID,
      handle: payload.authorHandle,
      boardName,
      subject,
      action,
      originNode: entry.origin,
    });
  }

  /** One exchange round with one peer. Failures are logged, never thrown. */
  public async syncWith(peer: string): Promise<void> {
    let log: SyncLogData;
    try {
      log = await this.syncLog.read();
    } catch (err) {
      const message = `cannot read sync log (${err instanceof Error ? err.message : String(err)})`;
      this.onLog(`Sync with ${peer} aborted: ${message}.`);
      this.recordRound(peer, { error: message });
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
      const message = err instanceof Error ? err.message : String(err);
      this.onLog(`Sync with ${peer} failed: ${message}.`);
      this.recordRound(peer, { error: message });
      return;
    }
    if (!res.ok) {
      this.onLog(`Sync with ${peer} rejected: HTTP ${res.status}.`);
      this.recordRound(peer, { error: `HTTP ${res.status}` });
      return;
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      this.onLog(`Sync with ${peer}: response was not JSON.`);
      this.recordRound(peer, { error: 'response was not JSON' });
      return;
    }
    // Loose shape check: entries stay unknown so applyRemote can skip bad
    // ones individually instead of failing the whole round.
    const parsed = zSyncExchangeRequest.safeParse(data);
    if (!parsed.success) {
      this.onLog(`Sync with ${peer}: response failed validation.`);
      this.recordRound(peer, { error: 'response failed validation' });
      return;
    }
    const result = await this.applyRemote(parsed.data.entries);
    this.recordRound(peer, {
      applied: result.applied,
      duplicates: result.duplicates,
      skipped: result.skipped,
    });
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
