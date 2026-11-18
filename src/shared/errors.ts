/**
 * src/shared/errors.ts — Typed error classes (builder-written, per design §2.3).
 *
 * No error is ever swallowed silently: every catch either re-throws a typed
 * error or converts it to a user-visible message in the session engine.
 */

export class BbsError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BbsError';
  }
}

/** Login / registration failures. Messages are safe to show to the user. */
export class AuthError extends BbsError {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthError';
  }
}

/** Zod or input validation failures. Messages are safe to show to the user. */
export class ValidationError extends BbsError {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ValidationError';
  }
}

/** Persistence failures. Messages may contain paths; never show raw to users. */
export class StoreError extends BbsError {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
  }
}

/** Path traversal, file not found, non-text file. Safe to show to the user. */
export class FileAreaError extends BbsError {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FileAreaError';
  }
}

/** Invalid game state transitions. Safe to show to the user. */
export class GameError extends BbsError {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GameError';
  }
}
