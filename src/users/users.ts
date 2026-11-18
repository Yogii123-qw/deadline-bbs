/**
 * src/users/users.ts — User store operations (builder-written, per design §2.9).
 *
 * Passcodes are stored as PBKDF2-HMAC-SHA256 hashes (OWASP minimum: 600,000
 * iterations, 32-byte key, per-account salt); plaintext is never logged or
 * persisted. Accounts created before the PRO-DEV round carry single-round
 * salted SHA-256 hashes; those verify against the legacy format and are
 * migrated to PBKDF2 automatically on the next successful login, so no
 * account is ever locked out by the upgrade. Handle lookup is
 * case-insensitive; the original casing is kept for display.
 */

import { createHash, pbkdf2, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { GameCharacter, UserRecord } from '../shared/types.js';
import type { UsersData } from '../shared/validation.js';
import { validateHandle, validatePasscode } from '../shared/validation.js';
import { AuthError } from '../shared/errors.js';
import type { AtomicStore } from '../boards/store.js';

const pbkdf2Async = promisify(pbkdf2);

/** OWASP Password Storage Cheat Sheet minimum for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;
/** Stored-format sanity cap: a crafted file asking for more fails closed. */
export const PBKDF2_MAX_ITERATIONS = 2_000_000;
export const PBKDF2_KEY_BYTES = 32;
export const PBKDF2_DIGEST = 'sha256';
/** 16 bytes = 128 bits, the NIST SP 800-132 minimum salt size. */
export const PASSCODE_SALT_BYTES = 16;

/**
 * Legacy single-round hash, kept ONLY to verify (and migrate) accounts
 * created before the PRO-DEV round. Never used for new hashes.
 */
export function hashPasscodeLegacy(salt: string, passcode: string): string {
  return createHash('sha256').update(salt + passcode).digest('hex');
}

/**
 * Hash a passcode with PBKDF2. Async on purpose: the derivation is
 * deliberately slow (~100-300ms) and must never block the event loop of
 * a multi-session server. Returns the self-describing stored format:
 * `pbkdf2-sha256$<iterations>$<hex key>`, so the cost that hashed a
 * value travels with it and future cost increases never break old hashes.
 */
export async function hashPasscode(salt: string, passcode: string): Promise<string> {
  const key = await pbkdf2Async(
    passcode,
    Buffer.from(salt, 'hex'),
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_BYTES,
    PBKDF2_DIGEST,
  );
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${key.toString('hex')}`;
}

function isLegacyHash(stored: string): boolean {
  return /^[0-9a-f]{64}$/.test(stored);
}

function parsePbkdf2Hash(
  stored: string,
): { iterations: number; keyHex: string } | null {
  const match = /^pbkdf2-sha256\$(\d+)\$([0-9a-f]+)$/.exec(stored);
  if (match === null) return null;
  const iterations = Number.parseInt(match[1], 10);
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > PBKDF2_MAX_ITERATIONS
  ) {
    return null;
  }
  if (match[2].length !== PBKDF2_KEY_BYTES * 2) return null;
  return { iterations, keyHex: match[2] };
}

/**
 * Verify a passcode against a stored hash of either format. Comparison is
 * timing-safe over equal-length buffers (both sides are decoded from hex
 * first — timingSafeEqual throws on differing lengths). Unknown formats
 * fail closed.
 */
export async function verifyPasscode(
  stored: string,
  salt: string,
  passcode: string,
): Promise<boolean> {
  if (isLegacyHash(stored)) {
    const attempt = hashPasscodeLegacy(salt, passcode);
    return timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(stored, 'hex'));
  }
  const parsed = parsePbkdf2Hash(stored);
  if (parsed === null) return false;
  const derived = await pbkdf2Async(
    passcode,
    Buffer.from(salt, 'hex'),
    parsed.iterations,
    PBKDF2_KEY_BYTES,
    PBKDF2_DIGEST,
  );
  return timingSafeEqual(derived, Buffer.from(parsed.keyHex, 'hex'));
}

export class UserStore {
  private readonly store: AtomicStore<UsersData>;

  public constructor(store: AtomicStore<UsersData>) {
    this.store = store;
  }

  public async findUser(handle: string): Promise<UserRecord | null> {
    const data = await this.store.read();
    const wanted = handle.toLowerCase();
    return data.users.find((u) => u.handle.toLowerCase() === wanted) ?? null;
  }

  public async createUser(
    handle: string,
    passcode: string,
    now: Date,
  ): Promise<UserRecord> {
    const cleanHandle = validateHandle(handle);
    validatePasscode(passcode);
    const existing = await this.findUser(cleanHandle);
    if (existing !== null) {
      throw new AuthError('That handle is already taken. Choose another.');
    }
    const salt = randomBytes(PASSCODE_SALT_BYTES).toString('hex');
    const record: UserRecord = {
      id: randomUUID(),
      handle: cleanHandle,
      passwordHash: await hashPasscode(salt, passcode),
      salt,
      createdAt: now.toISOString(),
      lastLoginAt: now.toISOString(),
      readMarkers: {},
      gameCharacter: null,
    };
    await this.store.write((data) => ({
      users: [...data.users, record],
    }));
    return record;
  }

  /**
   * Authenticate. The failure message is deliberately generic: it never
   * discloses whether the handle or the passcode was wrong (R3.2). An
   * unknown handle still runs one PBKDF2 derivation over a dummy salt, so
   * a failed login takes the same time whether the handle exists or not.
   * A successful login over a legacy SHA-256 hash migrates the account to
   * PBKDF2 (fresh salt) in the same atomic write as the last-login update.
   */
  public async authenticate(
    handle: string,
    passcode: string,
    now: Date,
  ): Promise<UserRecord> {
    const user = await this.findUser(handle);
    if (user === null) {
      await hashPasscode(randomBytes(PASSCODE_SALT_BYTES).toString('hex'), passcode);
      throw new AuthError('Invalid handle or passcode.');
    }
    const match = await verifyPasscode(user.passwordHash, user.salt, passcode);
    if (!match) {
      throw new AuthError('Invalid handle or passcode.');
    }
    if (isLegacyHash(user.passwordHash)) {
      const newSalt = randomBytes(PASSCODE_SALT_BYTES).toString('hex');
      const newHash = await hashPasscode(newSalt, passcode);
      return this.updateUser(user.id, (u) => ({
        ...u,
        passwordHash: newHash,
        salt: newSalt,
        lastLoginAt: now.toISOString(),
      }));
    }
    return this.updateUser(user.id, (u) => ({
      ...u,
      lastLoginAt: now.toISOString(),
    }));
  }

  public async updateUser(
    userId: string,
    updater: (user: UserRecord) => UserRecord,
  ): Promise<UserRecord> {
    await this.store.write((data) => ({
      users: data.users.map((u) => (u.id === userId ? updater(u) : u)),
    }));
    const updated = await this.findById(userId);
    if (updated === null) {
      throw new AuthError('User not found.');
    }
    return updated;
  }

  public async findById(userId: string): Promise<UserRecord | null> {
    const data = await this.store.read();
    return data.users.find((u) => u.id === userId) ?? null;
  }

  public async updateReadMarker(
    userId: string,
    boardId: string,
    lastPostId: string,
  ): Promise<void> {
    await this.updateUser(userId, (u) => ({
      ...u,
      readMarkers: { ...u.readMarkers, [boardId]: lastPostId },
    }));
  }

  public async getCharacter(userId: string): Promise<GameCharacter | null> {
    const user = await this.findById(userId);
    return user?.gameCharacter ?? null;
  }

  public async saveCharacter(
    userId: string,
    character: GameCharacter,
  ): Promise<void> {
    await this.updateUser(userId, (u) => ({ ...u, gameCharacter: character }));
  }
}
