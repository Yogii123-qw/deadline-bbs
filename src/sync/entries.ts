/**
 * src/sync/entries.ts — Append-only sync log entry shapes (builder-written,
 * FEDERATION amendment; extended by the PRO-DEV amendment).
 *
 * One entry = one operation. Entries are immutable and globally unique:
 * id = "<origin node id>:<uuid>". A node that receives an entry it has
 * already seen ignores it; a node that receives an entry twice never
 * duplicates its effect. Kinds:
 *
 * - `thread` / `reply`: add operations (a new thread, or one reply).
 * - `edit`: replace a post's subject/body (last-writer-wins, §2.2 of the
 *   PRO-DEV amendment). `tombstone`: delete a post (delete-wins).
 * - `score`: one CATACOMB victory from the origin node (grow-only set).
 *
 * Schemas here validate at the trust boundary (peers are untrusted input).
 * The apply path in engine.ts adds semantic checks (board exists, handle
 * shape, timestamps parse, authorship) and re-sanitizes every
 * user-derived field.
 */

import { z } from 'zod';
import { zPost, zThread } from '../shared/validation.js';

/** Hard cap on entries per exchange request (flood protection). */
export const MAX_SYNC_ENTRIES = 5000;
/** Hard cap on an exchange request body (flood protection). */
export const MAX_SYNC_BODY_BYTES = 5 * 1024 * 1024;

/** Edit payload: the full replacement subject/body for one post. */
export const zEditPayload = z.object({
  postId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  boardId: z.string().min(1).max(200),
  authorHandle: z.string().min(1).max(100),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(10000),
});
export type EditPayload = z.infer<typeof zEditPayload>;

/** Tombstone payload: the identity of the post to delete. */
export const zTombstonePayload = z.object({
  postId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  boardId: z.string().min(1).max(200),
  authorHandle: z.string().min(1).max(100),
});
export type TombstonePayload = z.infer<typeof zTombstonePayload>;

/** Score payload: one victory. The timestamp is the entry's `at`. */
export const zScorePayload = z.object({
  handle: z.string().min(1).max(100),
  level: z.number().int().min(1).max(99),
});
export type ScorePayload = z.infer<typeof zScorePayload>;

export const zSyncEntry = z
  .object({
    id: z.string().min(1).max(200),
    origin: z.string().min(1).max(200),
    seq: z.number().int().min(1),
    kind: z.enum(['thread', 'reply', 'edit', 'tombstone', 'score']),
    /** ISO 8601 creation time at the origin node; the LWW key for edits. */
    at: z.string().min(1).max(100),
    thread: zThread.optional(),
    post: zPost.optional(),
    edit: zEditPayload.optional(),
    tombstone: zTombstonePayload.optional(),
    score: zScorePayload.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.kind === 'thread' && entry.thread === undefined) {
      ctx.addIssue({ code: 'custom', message: 'thread entries must carry a thread payload' });
    }
    if (entry.kind === 'reply' && entry.post === undefined) {
      ctx.addIssue({ code: 'custom', message: 'reply entries must carry a post payload' });
    }
    if (entry.kind === 'edit' && entry.edit === undefined) {
      ctx.addIssue({ code: 'custom', message: 'edit entries must carry an edit payload' });
    }
    if (entry.kind === 'tombstone' && entry.tombstone === undefined) {
      ctx.addIssue({ code: 'custom', message: 'tombstone entries must carry a tombstone payload' });
    }
    if (entry.kind === 'score' && entry.score === undefined) {
      ctx.addIssue({ code: 'custom', message: 'score entries must carry a score payload' });
    }
  });
export type SyncEntry = z.infer<typeof zSyncEntry>;

/**
 * The persisted sync log. `entries` is the append-only record (and the
 * seen-set); `pending` holds entries whose target has not arrived yet
 * (replies, edits, and tombstones). `nextSeq` is this node's next
 * per-origin counter; `seq` is informational in v1 (deduplication is by
 * id), so a reset counter can never collide.
 */
export const zSyncLogData = z.object({
  nodeId: z.string(),
  nextSeq: z.number().int().min(1),
  entries: z.array(zSyncEntry),
  pending: z.array(zSyncEntry),
});
export type SyncLogData = z.infer<typeof zSyncLogData>;

/**
 * Exchange request shape. Entries are `unknown` here on purpose: each
 * entry is validated individually by the apply path, so one malformed
 * entry is skipped and logged instead of failing the whole round.
 */
export const zSyncExchangeRequest = z.object({
  nodeId: z.string().min(1).max(200),
  entries: z.array(z.unknown()).max(MAX_SYNC_ENTRIES),
});
