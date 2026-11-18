import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/shared/errors.js';
import {
  validateHandle,
  validatePasscode,
  validatePost,
  validateSearchQuery,
  zBoardsStore,
  zScoresStore,
  zUsersStore,
} from '../../src/shared/validation.js';
import { seedBoardsData } from '../../src/boards/seeds.js';

describe('validation', () => {
  it('store schemas accept valid fixtures', () => {
    expect(() => zBoardsStore.parse(seedBoardsData())).not.toThrow();
    expect(() => zUsersStore.parse({ users: [] })).not.toThrow();
    expect(() => zScoresStore.parse({ entries: [] })).not.toThrow();
    expect(() =>
      zUsersStore.parse({
        users: [
          {
            id: 'u1',
            handle: 'Alice',
            passwordHash: 'ab'.repeat(32),
            salt: 'cd'.repeat(16),
            createdAt: '2026-11-19T00:00:00.000Z',
            lastLoginAt: '2026-11-19T00:00:00.000Z',
            readMarkers: {},
            gameCharacter: null,
          },
        ],
      }),
    ).not.toThrow();
  });

  it('store schemas reject corrupt fixtures', () => {
    expect(() => zBoardsStore.parse({ boards: [], threads: [{ nope: 1 }] })).toThrow();
    expect(() => zUsersStore.parse({ users: [{ handle: 'x' }] })).toThrow();
    expect(() => zScoresStore.parse({ entries: [{ handle: 'x' }] })).toThrow();
    expect(() => zBoardsStore.parse(null)).toThrow();
  });

  it('validateHandle enforces the handle rules', () => {
    expect(validateHandle('  Alice  ')).toBe('Alice');
    expect(() => validateHandle('a')).toThrow(ValidationError);
    expect(() => validateHandle('a'.repeat(21))).toThrow(ValidationError);
    expect(() => validateHandle('two words')).toThrow(ValidationError);
    expect(() => validateHandle('tab\tname')).toThrow(ValidationError);
    expect(validateHandle('\x1b[1mBob\x1b[0m')).toBe('Bob');
  });

  it('validatePasscode enforces length and control rules', () => {
    expect(() => validatePasscode('abcd')).not.toThrow();
    expect(() => validatePasscode('abc')).toThrow(ValidationError);
    expect(() => validatePasscode('a'.repeat(129))).toThrow(ValidationError);
    expect(() => validatePasscode('ab\x01cd')).toThrow(ValidationError);
  });

  it('validatePost cleans and caps without truncating', () => {
    const clean = validatePost('  Hi  ', '  Body text  ');
    expect(clean).toEqual({ subject: 'Hi', body: 'Body text' });
    expect(() => validatePost('', 'body')).toThrow(ValidationError);
    expect(() => validatePost('subject', '')).toThrow(ValidationError);
    expect(() => validatePost('x'.repeat(73), 'body')).toThrow(ValidationError);
    expect(() => validatePost('subject', 'x'.repeat(4097))).toThrow(ValidationError);
  });

  it('validateSearchQuery trims and caps', () => {
    expect(validateSearchQuery('  modem  ')).toBe('modem');
    expect(() => validateSearchQuery('   ')).toThrow(ValidationError);
    expect(() => validateSearchQuery('x'.repeat(101))).toThrow(ValidationError);
  });
});
