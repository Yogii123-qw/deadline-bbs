/**
 * src/users/users.ts — User store operations (builder-written, per design §2.9).
 *
 * Passcodes are stored as salted SHA-256 hashes; plaintext is never logged
 * or persisted. Handle lookup is case-insensitive; the original casing is
 * kept for display.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { GameCharacter, UserRecord } from '../shared/types.js';
import type { UsersData } from '../shared/validation.js';
import { validateHandle, validatePasscode } from '../shared/validation.js';
import { AuthError } from '../shared/errors.js';
import type { AtomicStore } from '../boards/store.js';

export function hashPasscode(salt: string, passcode: string): string {
  return createHash('sha256').update(salt + passcode).digest('hex');
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
    const salt = randomBytes(16).toString('hex');
    const record: UserRecord = {
      id: randomUUID(),
      handle: cleanHandle,
      passwordHash: hashPasscode(salt, passcode),
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
   * discloses whether the handle or the passcode was wrong (R3.2).
   */
  public async authenticate(
    handle: string,
    passcode: string,
    now: Date,
  ): Promise<UserRecord> {
    const user = await this.findUser(handle);
    if (user === null) {
      throw new AuthError('Invalid handle or passcode.');
    }
    const attempt = hashPasscode(user.salt, passcode);
    const match = timingSafeEqual(
      Buffer.from(attempt, 'utf8'),
      Buffer.from(user.passwordHash, 'utf8'),
    );
    if (!match) {
      throw new AuthError('Invalid handle or passcode.');
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
