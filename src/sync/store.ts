/**
 * src/sync/store.ts — Persisted append-only sync log (builder-written,
 * FEDERATION amendment).
 *
 * The log lives in <DATA_DIR>/sync.json, beside boards.json, on the same
 * AtomicStore (temp-file + rename, serialized writes). Boards.json stays
 * the local read model; this log is the federation record. If sync.json
 * is lost or corrupt, the store re-seeds and the node simply re-learns
 * entries from its peers — board-level import idempotency means no post
 * is ever duplicated by re-learning.
 *
 * Node identity: DEADLINE_NODE_ID wins when set; otherwise the id stored
 * in sync.json; otherwise a generated UUID persisted on first init.
 * Changing the node id for an existing data directory is not supported:
 * the node's entries would be re-issued under a new origin.
 */

import { randomUUID } from 'node:crypto';
import type { Post, Thread } from '../shared/types.js';
import type { AtomicStore } from '../boards/store.js';
import type {
  EditPayload,
  ScorePayload,
  SyncEntry,
  SyncLogData,
  TombstonePayload,
} from './entries.js';

/** Payload by entry kind for local appends. */
export type LocalEntryPayload =
  | { kind: 'thread'; payload: Thread }
  | { kind: 'reply'; payload: Post }
  | { kind: 'edit'; payload: EditPayload }
  | { kind: 'tombstone'; payload: TombstonePayload }
  | { kind: 'score'; payload: ScorePayload };

export const EMPTY_SYNC_LOG: SyncLogData = {
  nodeId: '',
  nextSeq: 1,
  entries: [],
  pending: [],
};

export class SyncLogStore {
  private readonly store: AtomicStore<SyncLogData>;
  private readonly onLog: (message: string) => void;
  private resolvedNodeId: string | null = null;

  /** Fired (fire-and-forget) after a local post is appended to the log. */
  public onLocalAppend: ((entry: SyncEntry) => void) | null = null;

  public constructor(
    store: AtomicStore<SyncLogData>,
    onLog: (message: string) => void = () => undefined,
  ) {
    this.store = store;
    this.onLog = onLog;
  }

  /**
   * Resolve and persist this node's id. Must be awaited before any other
   * method; nodeId() throws until init has run.
   */
  public async init(nodeIdOverride?: string): Promise<string> {
    const current = await this.store.read();
    let nodeId: string;
    if (nodeIdOverride !== undefined && nodeIdOverride !== '') {
      nodeId = nodeIdOverride;
      if (current.nodeId !== '' && current.nodeId !== nodeId) {
        this.onLog(
          `Sync node id overridden by DEADLINE_NODE_ID (${current.nodeId} -> ${nodeId}); entries issued under the old id stay under it.`,
        );
      }
    } else if (current.nodeId !== '') {
      nodeId = current.nodeId;
    } else {
      nodeId = randomUUID();
    }
    this.resolvedNodeId = nodeId;
    await this.store.write((data) => ({ ...data, nodeId }));
    return nodeId;
  }

  public nodeId(): string {
    if (this.resolvedNodeId === null) {
      throw new Error('SyncLogStore used before init().');
    }
    return this.resolvedNodeId;
  }

  public async read(): Promise<SyncLogData> {
    return this.store.read();
  }

  /** Atomic read-modify-write over the log (merge inside the updater: the
   *  updater sees the data as of write time, so concurrent local appends
   *  are never lost). */
  public async write(updater: (current: SyncLogData) => SyncLogData): Promise<void> {
    await this.store.write(updater);
  }

  /**
   * Mint an entry id without appending. Local edit/delete flows generate
   * the id first, apply the operation to the board store with it (so a
   * failed apply leaves nothing in the log), then append with the same
   * id. Uniqueness comes from origin + UUID, as always.
   */
  public createEntryId(): string {
    return `${this.nodeId()}:${randomUUID()}`;
  }

  /**
   * Append a locally created operation to the log. Returns the entry, or
   * null when the append failed (disk error): the local change still
   * stands — local availability beats federation — and the failure is
   * logged. Never throws. `idOverride` reuses an id minted by
   * createEntryId (edit/delete flows); otherwise a fresh id is minted.
   */
  public async appendLocal(
    kind: LocalEntryPayload['kind'],
    payload: Thread | Post | EditPayload | TombstonePayload | ScorePayload,
    at: string,
    idOverride?: string,
  ): Promise<SyncEntry | null> {
    const origin = this.nodeId();
    const id = idOverride ?? `${origin}:${randomUUID()}`;
    let entry: SyncEntry | null = null;
    try {
      await this.store.write((data) => {
        const base = { id, origin, seq: data.nextSeq, kind, at };
        entry =
          kind === 'thread'
            ? { ...base, thread: payload as Thread }
            : kind === 'reply'
              ? { ...base, post: payload as Post }
              : kind === 'edit'
                ? { ...base, edit: payload as EditPayload }
                : kind === 'tombstone'
                  ? { ...base, tombstone: payload as TombstonePayload }
                  : { ...base, score: payload as ScorePayload };
        return {
          ...data,
          nextSeq: data.nextSeq + 1,
          entries: [...data.entries, entry],
        };
      });
    } catch (err) {
      this.onLog(
        `Sync log append failed (local change still stands): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (entry !== null) {
      const appended = entry;
      try {
        this.onLocalAppend?.(appended);
      } catch (err) {
        this.onLog(
          `Sync onLocalAppend hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return entry;
  }
}
