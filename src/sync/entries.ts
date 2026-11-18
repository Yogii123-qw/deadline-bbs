/**
 * src/sync/entries.ts — Append-only sync log entry shapes (builder-written,
 * FEDERATION amendment).
 *
 * One entry = one post (a new thread, or one reply). Entries are immutable
 * and globally unique: id = "<origin node id>:<uuid>". A node that receives
 * an entry it has already seen ignores it; a node that receives an entry
 * twice never duplicates the post. There is no edit/delete in v1.
 *
 * Schemas here validate at the trust boundary (peers are untrusted input).
 * The apply path in engine.ts adds semantic checks (board exists, handle
 * shape, timestamps parse) and re-sanitizes every user-derived field.
 */

import { z } from 'zod';
import { zPost, zThread } from '../shared/validation.js';

/** Hard cap on entries per exchange request (flood protection). */
export const MAX_SYNC_ENTRIES = 5000;
/** Hard cap on an exchange request body (flood protection). */
export const MAX_SYNC_BODY_BYTES = 5 * 1024 * 1024;

export const zSyncEntry = z
  .object({
    id: z.string().min(1).max(200),
    origin: z.string().min(1).max(200),
    seq: z.number().int().min(1),
    kind: z.enum(['thread', 'reply']),
    /** ISO 8601 creation time at the origin node. */
    at: z.string().min(1).max(100),
    thread: zThread.optional(),
    post: zPost.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.kind === 'thread' && entry.thread === undefined) {
      ctx.addIssue({ code: 'custom', message: 'thread entries must carry a thread payload' });
    }
    if (entry.kind === 'reply' && entry.post === undefined) {
      ctx.addIssue({ code: 'custom', message: 'reply entries must carry a post payload' });
    }
  });
export type SyncEntry = z.infer<typeof zSyncEntry>;

/**
 * The persisted sync log. `entries` is the append-only record (and the
 * seen-set); `pending` holds replies whose thread has not arrived yet.
 * `nextSeq` is this node's next per-origin counter; `seq` is informational
 * in v1 (deduplication is by id), so a reset counter can never collide.
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
