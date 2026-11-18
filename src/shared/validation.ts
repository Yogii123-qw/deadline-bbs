/**
 * src/shared/validation.ts — Zod schemas at every trust boundary
 * (builder-written, per design §2.2).
 *
 * Schemas mirror the types in src/shared/types.ts (Kiro-authored). Keep the
 * two files in sync: a schema that drifts from its type is a bug.
 */

import { z } from 'zod';
import { sanitizeUserText } from '../telnet/ansi.js';
import { ValidationError } from './errors.js';

/** Input caps from the spec (R3.3, R4.4, conventions §2). */
export const HANDLE_MIN = 2;
export const HANDLE_MAX = 20;
export const PASSCODE_MIN = 4;
export const PASSCODE_MAX = 128;
export const SUBJECT_MAX = 72;
export const BODY_MAX = 4096;
export const MAX_LINE = 1024;
export const SEARCH_MAX = 100;
export const CHAT_MAX = 500;

/* ------------------------------------------------------------------ */
/* Persisted store schemas                                             */
/* ------------------------------------------------------------------ */

export const zGameCharacter = z.object({
  userId: z.string(),
  hp: z.number().int(),
  maxHp: z.number().int(),
  attack: z.number().int(),
  defense: z.number().int(),
  level: z.number().int(),
  xp: z.number().int(),
  xpToNextLevel: z.number().int(),
  gold: z.number().int(),
  dungeonDepth: z.number().int(),
  turnsUsedToday: z.number().int(),
  turnsResetDate: z.string(),
  isVictorious: z.boolean(),
});

export const zMonster = z.object({
  name: z.string(),
  hp: z.number().int(),
  attack: z.number().int(),
  defense: z.number().int(),
  xpReward: z.number().int(),
  goldReward: z.number().int(),
  isFinalBoss: z.boolean(),
});

export const zUserRecord = z.object({
  id: z.string(),
  handle: z.string(),
  passwordHash: z.string(),
  salt: z.string(),
  createdAt: z.string(),
  lastLoginAt: z.string(),
  readMarkers: z.record(z.string(), z.string()),
  gameCharacter: zGameCharacter.nullable(),
});

export const zUsersStore = z.object({
  users: z.array(zUserRecord),
});
export type UsersData = z.infer<typeof zUsersStore>;

export const zBoard = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

export const zPost = z.object({
  id: z.string(),
  threadId: z.string(),
  boardId: z.string(),
  authorHandle: z.string(),
  subject: z.string(),
  body: z.string(),
  createdAt: z.string(),
  isArchive: z.boolean(),
});

export const zThread = z.object({
  id: z.string(),
  boardId: z.string(),
  subject: z.string(),
  authorHandle: z.string(),
  createdAt: z.string(),
  posts: z.array(zPost),
});

/**
 * Edit overlay (PRO-DEV amendment): the winning edit per post. Stored
 * separately from Post because Post lives in the Kiro-authored types file
 * and must not change. `editEntryId` is the LWW tie-break key.
 */
export const zPostMeta = z.object({
  editedAt: z.string(),
  editEntryId: z.string(),
});

/** Delete-wins tombstone per post (PRO-DEV amendment). */
export const zTombstone = z.object({
  deletedAt: z.string(),
  entryId: z.string(),
});

export const zBoardsStore = z.object({
  boards: z.array(zBoard),
  threads: z.array(zThread),
  /** Absent in pre-PRO-DEV files: defaults to empty (no edits, no deletes). */
  postMeta: z.record(z.string(), zPostMeta).default({}),
  tombstones: z.record(z.string(), zTombstone).default({}),
});
export type BoardsData = z.infer<typeof zBoardsStore>;

export const zHallOfFameEntry = z.object({
  handle: z.string(),
  level: z.number().int(),
  timestamp: z.string(),
});

/**
 * A federated Hall of Fame score (PRO-DEV amendment): a local entry plus
 * its origin node and the log entry id that carried it (dedupe key).
 * Kept apart from HallOfFameEntry, which lives in the Kiro-authored
 * types file and must not change.
 */
export const zNetworkScore = z.object({
  handle: z.string(),
  level: z.number().int(),
  timestamp: z.string(),
  originNode: z.string(),
  entryId: z.string(),
});
export type NetworkScore = z.infer<typeof zNetworkScore>;

export const zScoresStore = z.object({
  entries: z.array(zHallOfFameEntry),
  /** Absent in pre-PRO-DEV files: defaults to empty (standalone node). */
  network: z.array(zNetworkScore).default([]),
});
export type ScoresData = z.infer<typeof zScoresStore>;

/* ------------------------------------------------------------------ */
/* Transport-boundary schemas                                          */
/* ------------------------------------------------------------------ */

/** A completed input line from either transport. The line reader enforces
 *  this cap first; the engine re-validates as defense in depth. */
export const zTelnetInput = z.string().max(MAX_LINE);

/** WebSocket resize frame sent by the xterm.js client (design §5). */
export const zResizeFrame = z.object({
  type: z.literal('resize'),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});

/* ------------------------------------------------------------------ */
/* Input validation helpers (throw ValidationError with user-safe text) */
/* ------------------------------------------------------------------ */

/**
 * Clean and validate a handle. Returns the display handle (original casing
 * preserved). Handles are single printable-ASCII tokens: no whitespace, no
 * control characters, no ANSI sequences.
 */
export function validateHandle(raw: string): string {
  const handle = sanitizeUserText(raw).trim();
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    throw new ValidationError(
      `Handle must be ${HANDLE_MIN}-${HANDLE_MAX} characters.`,
    );
  }
  if (/\s/.test(handle)) {
    throw new ValidationError('Handle must be a single word with no spaces.');
  }
  if (!/^[\x21-\x7e]+$/.test(handle)) {
    throw new ValidationError('Handle may only contain printable characters.');
  }
  return handle;
}

/** Validate a passcode: length bounds, no control characters. */
export function validatePasscode(passcode: string): void {
  if (passcode.length < PASSCODE_MIN || passcode.length > PASSCODE_MAX) {
    throw new ValidationError(
      `Passcode must be ${PASSCODE_MIN}-${PASSCODE_MAX} characters.`,
    );
  }
  if (sanitizeUserText(passcode) !== passcode) {
    throw new ValidationError('Passcode must not contain control characters.');
  }
}

/**
 * Clean and validate a post subject and body. Returns the sanitized values.
 * Oversized input is rejected, never silently truncated (R4.4).
 */
export function validatePost(
  subject: string,
  body: string,
): { subject: string; body: string } {
  const cleanSubject = sanitizeUserText(subject).trim();
  const cleanBody = sanitizeUserText(body).trim();
  if (cleanSubject.length === 0) {
    throw new ValidationError('Subject must not be empty.');
  }
  if (cleanSubject.length > SUBJECT_MAX) {
    throw new ValidationError(
      `Subject must be at most ${SUBJECT_MAX} characters (yours is ${cleanSubject.length}).`,
    );
  }
  if (cleanBody.length === 0) {
    throw new ValidationError('Message body must not be empty.');
  }
  if (cleanBody.length > BODY_MAX) {
    throw new ValidationError(
      `Message must be at most ${BODY_MAX} characters (yours is ${cleanBody.length}). Shorten it and try again.`,
    );
  }
  return { subject: cleanSubject, body: cleanBody };
}

/** Clean and validate a search query. */
export function validateSearchQuery(raw: string): string {
  const query = sanitizeUserText(raw).trim();
  if (query.length === 0) {
    throw new ValidationError('Enter something to search for.');
  }
  if (query.length > SEARCH_MAX) {
    throw new ValidationError(`Search query must be at most ${SEARCH_MAX} characters.`);
  }
  return query;
}

/**
 * Clean and validate a live chat message. Oversized input is rejected,
 * never silently truncated (same rule as posts).
 */
export function validateChatMessage(raw: string): string {
  const message = sanitizeUserText(raw).trim();
  if (message.length === 0) {
    throw new ValidationError('Chat message must not be empty.');
  }
  if (message.length > CHAT_MAX) {
    throw new ValidationError(
      `Chat message must be at most ${CHAT_MAX} characters (yours is ${message.length}).`,
    );
  }
  return message;
}
