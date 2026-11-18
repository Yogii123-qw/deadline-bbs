import { afterEach, describe, expect, it } from 'vitest';
import { AuthError, ValidationError } from '../../src/shared/errors.js';
import { hashPasscode } from '../../src/users/users.js';
import { newCharacter } from '../../src/game/catacomb.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

describe('UserStore', () => {
  it('creates a user with a salted hash, never plaintext', async () => {
    env = await createTestEnv();
    const now = new Date('2026-11-19T12:00:00.000Z');
    const user = await env.deps.users.createUser('Deadknight', 's3cr3t!', now);
    expect(user.handle).toBe('Deadknight');
    expect(user.passwordHash).not.toContain('s3cr3t');
    expect(user.passwordHash).toBe(hashPasscode(user.salt, 's3cr3t!'));
    expect(user.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(user.createdAt).toBe(now.toISOString());
    expect(user.gameCharacter).toBeNull();
  });

  it('rejects duplicate handles case-insensitively', async () => {
    env = await createTestEnv();
    const now = new Date();
    await env.deps.users.createUser('Deadknight', 'pass1234', now);
    await expect(env.deps.users.createUser('deadknight', 'otherpass', now)).rejects.toBeInstanceOf(
      AuthError,
    );
    await expect(env.deps.users.createUser('DEADKNIGHT', 'otherpass', now)).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('finds users case-insensitively, preserving display casing', async () => {
    env = await createTestEnv();
    await env.deps.users.createUser('Deadknight', 'pass1234', new Date());
    const found = await env.deps.users.findUser('dEaDkNiGhT');
    expect(found?.handle).toBe('Deadknight');
    expect(await env.deps.users.findUser('nobody')).toBeNull();
  });

  it('authenticates with the right passcode and updates last login', async () => {
    env = await createTestEnv();
    const t0 = new Date('2026-11-19T10:00:00.000Z');
    const t1 = new Date('2026-11-19T12:00:00.000Z');
    await env.deps.users.createUser('Deadknight', 'pass1234', t0);
    const user = await env.deps.users.authenticate('deadknight', 'pass1234', t1);
    expect(user.lastLoginAt).toBe(t1.toISOString());
  });

  it('gives the same generic error for unknown handles and wrong passcodes', async () => {
    env = await createTestEnv();
    await env.deps.users.createUser('Deadknight', 'pass1234', new Date());
    const now = new Date();
    let errUnknown: unknown;
    let errWrong: unknown;
    try {
      await env.deps.users.authenticate('nobody', 'pass1234', now);
    } catch (err) {
      errUnknown = err;
    }
    try {
      await env.deps.users.authenticate('Deadknight', 'wrongpass', now);
    } catch (err) {
      errWrong = err;
    }
    expect(errUnknown).toBeInstanceOf(AuthError);
    expect(errWrong).toBeInstanceOf(AuthError);
    expect((errUnknown as Error).message).toBe((errWrong as Error).message);
  });

  it('rejects invalid handles and passcodes', async () => {
    env = await createTestEnv();
    const now = new Date();
    await expect(env.deps.users.createUser('x', 'pass1234', now)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      env.deps.users.createUser('a'.repeat(21), 'pass1234', now),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(env.deps.users.createUser('two words', 'pass1234', now)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(env.deps.users.createUser('GoodHandle', 'abc', now)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('strips ANSI from handles', async () => {
    env = await createTestEnv();
    const user = await env.deps.users.createUser('\x1b[31mRed\x1b[0m', 'pass1234', new Date());
    expect(user.handle).toBe('Red');
  });

  it('updates read markers and persists characters', async () => {
    env = await createTestEnv();
    const user = await env.deps.users.createUser('Deadknight', 'pass1234', new Date());
    await env.deps.users.updateReadMarker(user.id, 'general', 'post-9');
    const after = await env.deps.users.findById(user.id);
    expect(after?.readMarkers).toEqual({ general: 'post-9' });
    const character = newCharacter(user.id, '2026-11-19');
    await env.deps.users.saveCharacter(user.id, character);
    expect(await env.deps.users.getCharacter(user.id)).toEqual(character);
  });
});
