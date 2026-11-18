/**
 * tests/game/catacomb.test.ts
 *
 * Deterministic unit tests for src/game/catacomb.ts.
 * All RNG calls use injected functions — no Math.random().
 */

import { describe, it, expect } from 'vitest';
import {
  DAILY_TURNS,
  MAX_DEPTH,
  newCharacter,
  startSession,
  takeTurn,
  runCombatRound,
  generateMonster,
  applyLevelUp,
  checkWinCondition,
  resetCharacter,
} from '../../src/game/catacomb.js';
import type { GameCharacter, Monster } from '../../src/game/catacomb.js';

// ---------------------------------------------------------------------------
// Deterministic RNG helpers
// ---------------------------------------------------------------------------

/** Always returns 0 — lowest possible roll. */
const rng0 = () => 0;

/** Always returns 0.5 — midpoint roll. */
const rng05 = () => 0.5;

/** Always returns just under 1 — highest possible roll (exclusive). */
const rng099 = () => 0.999;

/** Returns a fixed sequence of values, cycling after exhaustion. */
function rngSeq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TODAY = '2026-11-18';
const TOMORROW = '2026-11-19';

function freshChar(overrides: Partial<GameCharacter> = {}): GameCharacter {
  return { ...newCharacter('user-1', TODAY), ...overrides };
}

function cloneChar(ch: GameCharacter): GameCharacter {
  return JSON.parse(JSON.stringify(ch)) as GameCharacter;
}

function cloneMonster(m: Monster): Monster {
  return JSON.parse(JSON.stringify(m)) as Monster;
}

// ---------------------------------------------------------------------------
// 1. newCharacter defaults
// ---------------------------------------------------------------------------

describe('newCharacter', () => {
  it('returns correct default stats', () => {
    const ch = newCharacter('user-42', TODAY);
    expect(ch.userId).toBe('user-42');
    expect(ch.hp).toBe(20);
    expect(ch.maxHp).toBe(20);
    expect(ch.attack).toBe(5);
    expect(ch.defense).toBe(3);
    expect(ch.level).toBe(1);
    expect(ch.xp).toBe(0);
    expect(ch.xpToNextLevel).toBe(20);
    expect(ch.gold).toBe(0);
    expect(ch.dungeonDepth).toBe(1);
    expect(ch.turnsUsedToday).toBe(0);
    expect(ch.turnsResetDate).toBe(TODAY);
    expect(ch.isVictorious).toBe(false);
  });

  it('sets turnsResetDate to today', () => {
    const ch = newCharacter('u', TOMORROW);
    expect(ch.turnsResetDate).toBe(TOMORROW);
  });
});

// ---------------------------------------------------------------------------
// 2. startSession — midnight reset and zero-turns block
// ---------------------------------------------------------------------------

describe('startSession', () => {
  it('returns turnsRemaining = DAILY_TURNS for a fresh character', () => {
    const ch = freshChar();
    const result = startSession(ch, TODAY);
    expect(result.turnsRemaining).toBe(DAILY_TURNS);
    expect(result.canPlay).toBe(true);
  });

  it('resets turnsUsedToday when date has changed (midnight rollover)', () => {
    const ch = freshChar({ turnsUsedToday: 15, turnsResetDate: '2026-11-17' });
    const result = startSession(ch, TODAY);
    expect(result.character.turnsUsedToday).toBe(0);
    expect(result.character.turnsResetDate).toBe(TODAY);
    expect(result.turnsRemaining).toBe(DAILY_TURNS);
    expect(result.canPlay).toBe(true);
  });

  it('does NOT reset turns when date is unchanged', () => {
    const ch = freshChar({ turnsUsedToday: 10, turnsResetDate: TODAY });
    const result = startSession(ch, TODAY);
    expect(result.character.turnsUsedToday).toBe(10);
    expect(result.turnsRemaining).toBe(DAILY_TURNS - 10);
  });

  it('blocks play when turnsUsedToday == DAILY_TURNS', () => {
    const ch = freshChar({ turnsUsedToday: DAILY_TURNS });
    const result = startSession(ch, TODAY);
    expect(result.turnsRemaining).toBe(0);
    expect(result.canPlay).toBe(false);
    expect(result.message).toMatch(/exhausted|rest|tomorrow/i);
  });

  it('allows play when one turn remains', () => {
    const ch = freshChar({ turnsUsedToday: DAILY_TURNS - 1 });
    const result = startSession(ch, TODAY);
    expect(result.turnsRemaining).toBe(1);
    expect(result.canPlay).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. takeTurn — turn consumption
// ---------------------------------------------------------------------------

describe('takeTurn — turn consumption', () => {
  it('consumes exactly one turn', () => {
    const ch = freshChar({ turnsUsedToday: 5 });
    const result = takeTurn(ch, 'rest', rng0);
    expect(result.character.turnsUsedToday).toBe(6);
    expect(result.turnsRemaining).toBe(DAILY_TURNS - 6);
  });

  it('returns unchanged character and zero turns when turns are exhausted', () => {
    const ch = freshChar({ turnsUsedToday: DAILY_TURNS });
    const before = cloneChar(ch);
    const result = takeTurn(ch, 'explore', rng0);
    expect(result.character).toEqual(before);
    expect(result.turnsRemaining).toBe(0);
    expect(result.enteredCombat).toBe(false);
    expect(result.monster).toBeNull();
    expect(result.message).toMatch(/no turns/i);
  });
});

// ---------------------------------------------------------------------------
// 4. takeTurn — explore branches
// ---------------------------------------------------------------------------

describe('takeTurn — explore', () => {
  it('triggers combat when rng() < 0.6 (rng returns 0)', () => {
    const ch = freshChar();
    // rng0 = 0, so 0 < 0.6 → encounter
    const result = takeTurn(ch, 'explore', rng0);
    expect(result.enteredCombat).toBe(true);
    expect(result.monster).not.toBeNull();
  });

  it('finds gold when rng() >= 0.6 (rng returns 0.9)', () => {
    const ch = freshChar();
    // First rng call 0.9 >= 0.6 → no encounter; second call used for gold amount
    const result = takeTurn(ch, 'explore', rngSeq(0.9, 0.5));
    expect(result.enteredCombat).toBe(false);
    expect(result.monster).toBeNull();
    // gold = 5 + floor(0.5 * 10) = 5 + 5 = 10
    expect(result.character.gold).toBe(10);
    expect(result.message).toMatch(/gold/i);
  });

  it('calculates found gold correctly with rng = 0 (minimum)', () => {
    // First call 0.9 → no encounter; second call 0 → gold = 5 + floor(0*10) = 5
    const result = takeTurn(freshChar(), 'explore', rngSeq(0.9, 0));
    expect(result.character.gold).toBe(5);
  });

  it('calculates found gold correctly with rng = 0.999 (maximum)', () => {
    // First call 0.9 → no encounter; second call 0.999 → gold = 5 + floor(0.999*10) = 5+9 = 14
    const result = takeTurn(freshChar(), 'explore', rngSeq(0.9, 0.999));
    expect(result.character.gold).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// 5. takeTurn — descend
// ---------------------------------------------------------------------------

describe('takeTurn — descend', () => {
  it('increases depth when below MAX_DEPTH', () => {
    const ch = freshChar({ dungeonDepth: 2 });
    // rng0 < 0.5 → encounter, so pass a value >= 0.5 to avoid it
    const result = takeTurn(ch, 'descend', rngSeq(0.9, 0.9, 0.9));
    expect(result.character.dungeonDepth).toBe(3);
  });

  it('stays at MAX_DEPTH when already at max (turn still consumed)', () => {
    const ch = freshChar({ dungeonDepth: MAX_DEPTH, turnsUsedToday: 3 });
    const result = takeTurn(ch, 'descend', rng0);
    expect(result.character.dungeonDepth).toBe(MAX_DEPTH);
    expect(result.character.turnsUsedToday).toBe(4);
    expect(result.message).toMatch(/deepest|depth 5/i);
    expect(result.enteredCombat).toBe(false);
  });

  it('triggers combat on descend with 50% chance (rng = 0 → 0 < 0.5 → encounter)', () => {
    const ch = freshChar({ dungeonDepth: 1 });
    // After depth increases to 2, rng calls: first for encounter check (0 < 0.5 = true),
    // then generateMonster calls for name and stats
    const result = takeTurn(ch, 'descend', rng0);
    expect(result.enteredCombat).toBe(true);
    expect(result.monster).not.toBeNull();
    expect(result.character.dungeonDepth).toBe(2);
  });

  it('does not trigger combat when rng >= 0.5 on descend', () => {
    const ch = freshChar({ dungeonDepth: 1 });
    const result = takeTurn(ch, 'descend', rng099);
    expect(result.enteredCombat).toBe(false);
    expect(result.monster).toBeNull();
    expect(result.character.dungeonDepth).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. takeTurn — rest healing
// ---------------------------------------------------------------------------

describe('takeTurn — rest', () => {
  it('heals floor(maxHp / 3) HP', () => {
    const ch = freshChar({ hp: 1, maxHp: 20 }); // heal = floor(20/3) = 6
    const result = takeTurn(ch, 'rest', rng0);
    expect(result.character.hp).toBe(7);
    expect(result.enteredCombat).toBe(false);
  });

  it('caps healing at maxHp', () => {
    const ch = freshChar({ hp: 19, maxHp: 20 }); // heal = 6, but capped to 20
    const result = takeTurn(ch, 'rest', rng0);
    expect(result.character.hp).toBe(20);
  });

  it('does not exceed maxHp even when already at full HP', () => {
    const ch = freshChar({ hp: 20, maxHp: 20 });
    const result = takeTurn(ch, 'rest', rng0);
    expect(result.character.hp).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// 7. runCombatRound — damage math
// ---------------------------------------------------------------------------

describe('runCombatRound — damage math', () => {
  // Build a simple monster for controlled tests
  function testMonster(overrides: Partial<Monster> = {}): Monster {
    return {
      name: 'Test Rat',
      hp: 10,
      attack: 4,
      defense: 1,
      xpReward: 5,
      goldReward: 3,
      isFinalBoss: false,
      ...overrides,
    };
  }

  it('calculates player damage correctly with rng = 0', () => {
    // playerDamage = max(1, 5 - 1 + floor(0 * 3)) = max(1, 4) = 4
    const ch = freshChar(); // attack=5, defense=3
    const monster = testMonster(); // attack=4, defense=1
    const result = runCombatRound(ch, monster, rng0);
    expect(result.playerDamageDealt).toBe(4);
  });

  it('calculates player damage correctly with rng = 0.999', () => {
    // playerDamage = max(1, 5 - 1 + floor(0.999 * 3)) = max(1, 4 + 2) = 6
    const ch = freshChar();
    const monster = testMonster();
    // rng called twice: first for player attack, second for monster attack
    const result = runCombatRound(ch, monster, rng099);
    expect(result.playerDamageDealt).toBe(6);
  });

  it('player damage minimum is 1 (even if attack < defense)', () => {
    const ch = freshChar({ attack: 1 });
    const monster = testMonster({ defense: 10, hp: 50 });
    // 1 - 10 + floor(0 * 3) = -9 → max(1, -9) = 1
    const result = runCombatRound(ch, monster, rng0);
    expect(result.playerDamageDealt).toBe(1);
  });

  it('calculates monster damage correctly with rng = 0', () => {
    // Monster does not die (hp=50), so it attacks.
    // monsterDamage = max(1, 4 - 3 + floor(0 * 3)) = max(1, 1) = 1
    const ch = freshChar(); // defense=3
    const monster = testMonster({ hp: 50 }); // attack=4
    const result = runCombatRound(ch, monster, rng0);
    expect(result.monsterDamageDealt).toBe(1);
    expect(result.character.hp).toBe(ch.hp - 1);
  });

  it('monster damage minimum is 1', () => {
    const ch = freshChar({ defense: 20 });
    const monster = testMonster({ attack: 1, hp: 50 });
    // 1 - 20 + floor(0 * 3) = -19 → max(1, -19) = 1
    const result = runCombatRound(ch, monster, rng0);
    expect(result.monsterDamageDealt).toBe(1);
  });

  it('monster does not attack when it is defeated in the same round', () => {
    // rng=0 → playerDamage = max(1, 5-1+0) = 4, monster has hp=4 → dies
    const ch = freshChar();
    const monster = testMonster({ hp: 4 });
    const result = runCombatRound(ch, monster, rng0);
    expect(result.monsterDefeated).toBe(true);
    expect(result.monsterDamageDealt).toBe(0);
    expect(result.character.hp).toBe(ch.hp); // unchanged
  });
});

// ---------------------------------------------------------------------------
// 8. runCombatRound — monster defeat awards XP and gold
// ---------------------------------------------------------------------------

describe('runCombatRound — monster defeat', () => {
  it('awards XP and gold on monster defeat', () => {
    const ch = freshChar({ gold: 0, xp: 0 });
    const monster: Monster = {
      name: 'Ghoul',
      hp: 1,
      attack: 3,
      defense: 0,
      xpReward: 10,
      goldReward: 7,
      isFinalBoss: false,
    };
    const result = runCombatRound(ch, monster, rng0);
    expect(result.monsterDefeated).toBe(true);
    expect(result.xpAwarded).toBe(10);
    expect(result.goldAwarded).toBe(7);
    expect(result.character.gold).toBe(7);
    // xp might be reset by level-up; just verify the awarded amount is correct
  });

  it('marks monster as defeated and sets monsterHp <= 0 in returned monster', () => {
    const ch = freshChar();
    const monster: Monster = { name: 'Zombie', hp: 2, attack: 2, defense: 0, xpReward: 8, goldReward: 4, isFinalBoss: false };
    const result = runCombatRound(ch, monster, rng0);
    expect(result.monsterDefeated).toBe(true);
    expect(result.monster.hp).toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 9. runCombatRound — player defeat
// ---------------------------------------------------------------------------

describe('runCombatRound — player defeat', () => {
  it('clamps player HP to 0 on defeat', () => {
    // Monster with 1 HP so it survives player attack (player attack=5, def=1 → 4 dmg; monster hp=5 → survives)
    // Monster attack is very high so player dies
    const ch = freshChar({ hp: 1, defense: 0 });
    const monster: Monster = { name: 'Demon', hp: 5, attack: 20, defense: 1, xpReward: 20, goldReward: 10, isFinalBoss: false };
    const result = runCombatRound(ch, monster, rng0);
    expect(result.playerDefeated).toBe(true);
    expect(result.character.hp).toBe(0);
  });

  it('awards no XP or gold when player is defeated', () => {
    const ch = freshChar({ hp: 1, defense: 0 });
    const monster: Monster = { name: 'Demon', hp: 50, attack: 20, defense: 1, xpReward: 20, goldReward: 10, isFinalBoss: false };
    const result = runCombatRound(ch, monster, rng0);
    expect(result.playerDefeated).toBe(true);
    expect(result.xpAwarded).toBe(0);
    expect(result.goldAwarded).toBe(0);
    expect(result.character.gold).toBe(ch.gold);
    expect(result.character.xp).toBe(ch.xp);
  });
});

// ---------------------------------------------------------------------------
// 10. applyLevelUp — stat gains and multi-level
// ---------------------------------------------------------------------------

describe('applyLevelUp', () => {
  it('does nothing when XP is below threshold', () => {
    const ch = freshChar({ xp: 10, xpToNextLevel: 20 });
    const result = applyLevelUp(ch);
    expect(result.level).toBe(1);
    expect(result.xp).toBe(10);
  });

  it('levels up once when XP meets threshold', () => {
    // xpToNextLevel = 20, level 1 → 2: new xpToNextLevel = 2 * 20 = 40
    const ch = freshChar({ xp: 20, xpToNextLevel: 20 });
    const result = applyLevelUp(ch);
    expect(result.level).toBe(2);
    expect(result.xp).toBe(0);
    expect(result.xpToNextLevel).toBe(40);
    expect(result.maxHp).toBe(25);
    expect(result.hp).toBe(25); // full heal
    expect(result.attack).toBe(7);
    expect(result.defense).toBe(4);
  });

  it('levels up multiple times when XP is very high', () => {
    // Start at level 1 with enough XP to reach level 3.
    // Level 1→2 costs 20 XP, leaving 60.
    // Level 2→3 costs 40 XP, leaving 20.
    // Level 3→4 costs 60 XP — not enough.
    const ch = freshChar({ xp: 80, xpToNextLevel: 20 });
    const result = applyLevelUp(ch);
    expect(result.level).toBe(3);
    expect(result.xp).toBe(20); // 80 - 20 - 40 = 20
    expect(result.xpToNextLevel).toBe(60); // level 3 * 20
    expect(result.attack).toBe(5 + 2 + 2); // two level-ups
    expect(result.defense).toBe(3 + 1 + 1);
    expect(result.maxHp).toBe(20 + 5 + 5);
    expect(result.hp).toBe(result.maxHp);
  });

  it('handles exact threshold with no remainder', () => {
    const ch = freshChar({ level: 2, xp: 40, xpToNextLevel: 40, maxHp: 25, hp: 25, attack: 7, defense: 4 });
    const result = applyLevelUp(ch);
    expect(result.level).toBe(3);
    expect(result.xp).toBe(0);
    expect(result.xpToNextLevel).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// 11. runCombatRound — level-up triggered by monster defeat
// ---------------------------------------------------------------------------

describe('runCombatRound — level-up on kill', () => {
  it('sets leveledUp=true when enough XP gained', () => {
    // Fresh char has 0 XP, xpToNextLevel 20. Award 20 XP → level up.
    const ch = freshChar({ xp: 0, xpToNextLevel: 20 });
    const monster: Monster = { name: 'Cave Bat', hp: 1, attack: 2, defense: 0, xpReward: 20, goldReward: 5, isFinalBoss: false };
    const result = runCombatRound(ch, monster, rng0);
    expect(result.leveledUp).toBe(true);
    expect(result.character.level).toBe(2);
  });

  it('sets leveledUp=false when not enough XP for a level', () => {
    const ch = freshChar({ xp: 0, xpToNextLevel: 20 });
    const monster: Monster = { name: 'Rat', hp: 1, attack: 2, defense: 0, xpReward: 5, goldReward: 1, isFinalBoss: false };
    const result = runCombatRound(ch, monster, rng0);
    expect(result.leveledUp).toBe(false);
    expect(result.character.level).toBe(1);
    expect(result.character.xp).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 12. generateMonster — roster, scaling, Crypt Lord, clamping
// ---------------------------------------------------------------------------

describe('generateMonster', () => {
  it('always returns Crypt Lord at depth 5', () => {
    const m = generateMonster(5, rng0);
    expect(m.name).toBe('Crypt Lord');
    expect(m.hp).toBe(40);
    expect(m.attack).toBe(10);
    expect(m.defense).toBe(5);
    expect(m.xpReward).toBe(50);
    expect(m.goldReward).toBe(100);
    expect(m.isFinalBoss).toBe(true);
  });

  it('returns a depth-1 roster name', () => {
    const depth1Roster = ['Rat', 'Cave Bat', 'Skeleton'];
    for (const rng of [rng0, rng05, rng099]) {
      const m = generateMonster(1, rng);
      expect(depth1Roster).toContain(m.name);
    }
  });

  it('picks first monster in roster with rng = 0', () => {
    // depth 1 roster: ['Rat', 'Cave Bat', 'Skeleton'] — index floor(0*3)=0 → 'Rat'
    // rng0 is called multiple times; name pick is first call
    const m = generateMonster(1, rng0);
    expect(m.name).toBe('Rat');
  });

  it('picks last monster in roster with rng = 0.999', () => {
    // depth 2 roster: ['Ghoul', 'Zombie'] — floor(0.999 * 2) = 1 → 'Zombie'
    // But subsequent calls also use 0.999; name pick is first call
    const m = generateMonster(2, rng099);
    expect(m.name).toBe('Zombie');
  });

  it('scales stats by depth (depth 1, rng = 0)', () => {
    const m = generateMonster(1, rng0);
    // hp = 8 + 1*4 + floor(0*4) = 12
    expect(m.hp).toBe(12);
    // attack = 3 + 1 = 4
    expect(m.attack).toBe(4);
    // defense = 1 + floor(1/2) = 1
    expect(m.defense).toBe(1);
    // xpReward = 5 + 1*3 = 8
    expect(m.xpReward).toBe(8);
    // goldReward = 2 + 1*2 + floor(0*5) = 4
    expect(m.goldReward).toBe(4);
    expect(m.isFinalBoss).toBe(false);
  });

  it('scales stats by depth (depth 3, rng = 0)', () => {
    const m = generateMonster(3, rng0);
    // hp = 8 + 3*4 + floor(0*4) = 20
    expect(m.hp).toBe(20);
    // attack = 3 + 3 = 6
    expect(m.attack).toBe(6);
    // defense = 1 + floor(3/2) = 1 + 1 = 2
    expect(m.defense).toBe(2);
    // xpReward = 5 + 3*3 = 14
    expect(m.xpReward).toBe(14);
    // goldReward = 2 + 3*2 + floor(0*5) = 8
    expect(m.goldReward).toBe(8);
  });

  it('clamps depth below 1 to 1', () => {
    const m = generateMonster(0, rng0);
    // depth clamped to 1 → same as depth 1
    expect(m.hp).toBe(12);
    expect(m.attack).toBe(4);
  });

  it('clamps depth above MAX_DEPTH to MAX_DEPTH (returns Crypt Lord)', () => {
    const m = generateMonster(10, rng0);
    expect(m.name).toBe('Crypt Lord');
    expect(m.isFinalBoss).toBe(true);
  });

  it('depth 2 roster contains only Ghoul and Zombie', () => {
    const names = new Set<string>();
    for (const rng of [rng0, rng099]) {
      names.add(generateMonster(2, rng).name);
    }
    expect([...names].every(n => ['Ghoul', 'Zombie'].includes(n))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. checkWinCondition
// ---------------------------------------------------------------------------

describe('checkWinCondition', () => {
  it('returns true only for a monster with isFinalBoss = true', () => {
    const boss = generateMonster(5, rng0);
    expect(checkWinCondition(boss)).toBe(true);
  });

  it('returns false for a regular monster', () => {
    const mob = generateMonster(1, rng0);
    expect(checkWinCondition(mob)).toBe(false);
  });

  it('returns false when isFinalBoss is explicitly false', () => {
    const m: Monster = { name: 'Trick Boss', hp: 999, attack: 50, defense: 20, xpReward: 100, goldReward: 200, isFinalBoss: false };
    expect(checkWinCondition(m)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14. resetCharacter — preserves turn fields, resets stats
// ---------------------------------------------------------------------------

describe('resetCharacter', () => {
  it('resets all base stats', () => {
    const ch = freshChar({ hp: 1, maxHp: 35, attack: 11, defense: 6, level: 4, xp: 60, xpToNextLevel: 80, gold: 999, dungeonDepth: 4, isVictorious: true });
    const reset = resetCharacter(ch);
    expect(reset.hp).toBe(20);
    expect(reset.maxHp).toBe(20);
    expect(reset.attack).toBe(5);
    expect(reset.defense).toBe(3);
    expect(reset.level).toBe(1);
    expect(reset.xp).toBe(0);
    expect(reset.xpToNextLevel).toBe(20);
    expect(reset.gold).toBe(0);
    expect(reset.dungeonDepth).toBe(1);
    expect(reset.isVictorious).toBe(false);
  });

  it('preserves userId', () => {
    const ch = freshChar();
    const reset = resetCharacter(ch);
    expect(reset.userId).toBe(ch.userId);
  });

  it('preserves turnsUsedToday (death does not refund turns)', () => {
    const ch = freshChar({ turnsUsedToday: 12 });
    const reset = resetCharacter(ch);
    expect(reset.turnsUsedToday).toBe(12);
  });

  it('preserves turnsResetDate', () => {
    const ch = freshChar({ turnsResetDate: TOMORROW });
    const reset = resetCharacter(ch);
    expect(reset.turnsResetDate).toBe(TOMORROW);
  });
});

// ---------------------------------------------------------------------------
// 15. Purity — input objects are never mutated
// ---------------------------------------------------------------------------

describe('purity — input objects unchanged after calls', () => {
  it('newCharacter does not mutate any existing object', () => {
    // No inputs to mutate; just ensure it returns a fresh object each call
    const a = newCharacter('x', TODAY);
    const b = newCharacter('x', TODAY);
    expect(a).not.toBe(b);
  });

  it('startSession does not mutate the input character', () => {
    const ch = freshChar({ turnsUsedToday: 5, turnsResetDate: '2026-11-01' });
    const snapshot = cloneChar(ch);
    startSession(ch, TODAY);
    expect(ch).toEqual(snapshot);
  });

  it('takeTurn does not mutate the input character', () => {
    const ch = freshChar();
    const snapshot = cloneChar(ch);
    takeTurn(ch, 'explore', rng0);
    expect(ch).toEqual(snapshot);
  });

  it('runCombatRound does not mutate character or monster', () => {
    const ch = freshChar();
    const monster: Monster = { name: 'Zombie', hp: 10, attack: 4, defense: 1, xpReward: 8, goldReward: 3, isFinalBoss: false };
    const chSnap = cloneChar(ch);
    const mSnap = cloneMonster(monster);
    runCombatRound(ch, monster, rng0);
    expect(ch).toEqual(chSnap);
    expect(monster).toEqual(mSnap);
  });

  it('generateMonster does not mutate any argument', () => {
    // generateMonster has no object argument, only depth and rng; just ensure returns new object each call
    const a = generateMonster(1, rng0);
    const b = generateMonster(1, rng0);
    expect(a).not.toBe(b);
  });

  it('applyLevelUp does not mutate the input character', () => {
    const ch = freshChar({ xp: 20 });
    const snapshot = cloneChar(ch);
    applyLevelUp(ch);
    expect(ch).toEqual(snapshot);
  });

  it('resetCharacter does not mutate the input character', () => {
    const ch = freshChar({ level: 5, hp: 1 });
    const snapshot = cloneChar(ch);
    resetCharacter(ch);
    expect(ch).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 16. Edge cases and boundary conditions
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('DAILY_TURNS constant is 20', () => {
    expect(DAILY_TURNS).toBe(20);
  });

  it('MAX_DEPTH constant is 5', () => {
    expect(MAX_DEPTH).toBe(5);
  });

  it('descend from depth 4 reaches MAX_DEPTH exactly', () => {
    const ch = freshChar({ dungeonDepth: 4 });
    // rng099 >= 0.5 → no encounter after descent
    const result = takeTurn(ch, 'descend', rng099);
    expect(result.character.dungeonDepth).toBe(5);
    expect(result.enteredCombat).toBe(false);
  });

  it('rest with hp already at maxHp does not exceed maxHp', () => {
    const ch = freshChar({ hp: 20, maxHp: 20 });
    const result = takeTurn(ch, 'rest', rng0);
    expect(result.character.hp).toBe(20);
  });

  it('explore accumulates gold across multiple no-encounter turns', () => {
    // rng sequence: each turn uses one value for encounter (all >= 0.6), one for gold
    const rng = rngSeq(0.9, 0, 0.9, 0); // turn1: no-enc(0.9), gold(0)=5; turn2: no-enc(0.9), gold(0)=5
    let ch = freshChar();
    const r1 = takeTurn(ch, 'explore', rng);
    ch = r1.character;
    const r2 = takeTurn(ch, 'explore', rng);
    expect(r2.character.gold).toBe(10);
  });

  it('depth 4 monsters have correct roster', () => {
    const names = new Set<string>();
    for (const rng of [rng0, rng099]) {
      names.add(generateMonster(4, rng).name);
    }
    expect([...names].every(n => ['Demon', 'Lich'].includes(n))).toBe(true);
  });
});
