/**
 * src/game/catacomb.ts
 *
 * Pure functional game logic for CATACOMB, DeadLine BBS's door game.
 *
 * PURITY RULES:
 *   - No file I/O, no network, no timers, no Date calls.
 *   - All randomness is provided by the caller via an injected `rng: () => number`.
 *   - No input object is ever mutated; every function returns new objects.
 *   - Math.random is never called inside this module.
 */

import type { GameCharacter, Monster } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Re-export the imported types so callers that import from catacomb.ts can
// get them too, without duplicating the definitions.
// ---------------------------------------------------------------------------
export type { GameCharacter, Monster };

// ---------------------------------------------------------------------------
// Local types (exported as required by the spec)
// ---------------------------------------------------------------------------

/** The action a player can take on their turn. */
export type PlayerAction = 'explore' | 'descend' | 'rest';

/** Returned by startSession. */
export interface StartResult {
  character: GameCharacter;
  turnsRemaining: number;
  canPlay: boolean;
  message: string;
}

/** Returned by takeTurn. */
export interface TurnResult {
  character: GameCharacter;
  monster: Monster | null;
  message: string;
  enteredCombat: boolean;
  turnsRemaining: number;
}

/** Returned by runCombatRound. */
export interface CombatRoundResult {
  character: GameCharacter;
  monster: Monster;
  playerDamageDealt: number;
  monsterDamageDealt: number;
  monsterDefeated: boolean;
  playerDefeated: boolean;
  xpAwarded: number;
  goldAwarded: number;
  leveledUp: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Constants (exported)
// ---------------------------------------------------------------------------

/** Maximum turns a character may take in a single calendar day. */
export const DAILY_TURNS = 20;

/** The deepest dungeon level; defeating the boss here wins the game. */
export const MAX_DEPTH = 5;

// ---------------------------------------------------------------------------
// Monster rosters per depth
// ---------------------------------------------------------------------------

const DEPTH_ROSTERS: Record<number, string[]> = {
  1: ['Rat', 'Cave Bat', 'Skeleton'],
  2: ['Ghoul', 'Zombie'],
  3: ['Wraith', 'Vampire'],
  4: ['Demon', 'Lich'],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a brand-new character for the given user with default starting stats.
 *
 * @param userId  - The owning user's ID.
 * @param today   - The current calendar date in YYYY-MM-DD format.
 * @returns A fresh GameCharacter.
 */
export function newCharacter(userId: string, today: string): GameCharacter {
  return {
    userId,
    hp: 20,
    maxHp: 20,
    attack: 5,
    defense: 3,
    level: 1,
    xp: 0,
    xpToNextLevel: 20,
    gold: 0,
    dungeonDepth: 1,
    turnsUsedToday: 0,
    turnsResetDate: today,
    isVictorious: false,
  };
}

/**
 * Begin (or resume) a game session for a character.
 *
 * If `character.turnsResetDate` does not equal `today`, the daily turn counter
 * is reset to zero and `turnsResetDate` is updated to `today` before the
 * remaining-turn calculation is performed (midnight rollover).
 *
 * @param character - The character entering the session.
 * @param today     - The current calendar date in YYYY-MM-DD format.
 * @returns A StartResult describing whether the session may proceed.
 */
export function startSession(character: GameCharacter, today: string): StartResult {
  let ch: GameCharacter = character;

  if (ch.turnsResetDate !== today) {
    ch = { ...ch, turnsUsedToday: 0, turnsResetDate: today };
  }

  const turnsRemaining = DAILY_TURNS - ch.turnsUsedToday;
  const canPlay = turnsRemaining > 0;

  const message = canPlay
    ? `Welcome back, adventurer. You have ${turnsRemaining} turn${turnsRemaining === 1 ? '' : 's'} remaining today.`
    : 'Your body needs rest. Daily turns are exhausted — return tomorrow.';

  return { character: ch, turnsRemaining, canPlay, message };
}

/**
 * Process one player turn, consuming exactly 1 turn when turns are available.
 *
 * Actions:
 *   - 'explore': 60% chance of encountering a monster; otherwise find gold.
 *   - 'descend': move deeper (up to MAX_DEPTH) with 50% encounter chance.
 *   - 'rest':    heal floor(maxHp / 3) HP, capped at maxHp; no encounter.
 *
 * If no turns remain, the character is returned unchanged.
 *
 * @param character - Current character state.
 * @param action    - The action chosen by the player.
 * @param rng       - Injected RNG function returning [0, 1).
 * @returns A TurnResult with the updated character and any generated monster.
 */
export function takeTurn(
  character: GameCharacter,
  action: PlayerAction,
  rng: () => number,
): TurnResult {
  const turnsRemaining = DAILY_TURNS - character.turnsUsedToday;

  if (turnsRemaining <= 0) {
    return {
      character,
      monster: null,
      message: 'You have no turns remaining today. Rest and return tomorrow.',
      enteredCombat: false,
      turnsRemaining: 0,
    };
  }

  // Consume one turn.
  let ch: GameCharacter = { ...character, turnsUsedToday: character.turnsUsedToday + 1 };
  const newTurnsRemaining = DAILY_TURNS - ch.turnsUsedToday;

  switch (action) {
    case 'explore': {
      if (rng() < 0.6) {
        // Monster encounter.
        const monster = generateMonster(ch.dungeonDepth, rng);
        return {
          character: ch,
          monster,
          message: `You venture deeper and encounter a ${monster.name}!`,
          enteredCombat: true,
          turnsRemaining: newTurnsRemaining,
        };
      } else {
        // Find gold.
        const goldFound = 5 + Math.floor(rng() * 10);
        ch = { ...ch, gold: ch.gold + goldFound };
        return {
          character: ch,
          monster: null,
          message: `You search the shadows and find ${goldFound} gold coins.`,
          enteredCombat: false,
          turnsRemaining: newTurnsRemaining,
        };
      }
    }

    case 'descend': {
      if (ch.dungeonDepth >= MAX_DEPTH) {
        return {
          character: ch,
          monster: null,
          message: `You are already at the deepest level of the dungeon (depth ${MAX_DEPTH}).`,
          enteredCombat: false,
          turnsRemaining: newTurnsRemaining,
        };
      }

      ch = { ...ch, dungeonDepth: ch.dungeonDepth + 1 };

      if (rng() < 0.5) {
        const monster = generateMonster(ch.dungeonDepth, rng);
        return {
          character: ch,
          monster,
          message: `You descend to depth ${ch.dungeonDepth} and disturb a ${monster.name}!`,
          enteredCombat: true,
          turnsRemaining: newTurnsRemaining,
        };
      } else {
        return {
          character: ch,
          monster: null,
          message: `You descend to depth ${ch.dungeonDepth}. The air grows colder.`,
          enteredCombat: false,
          turnsRemaining: newTurnsRemaining,
        };
      }
    }

    case 'rest': {
      const heal = Math.floor(ch.maxHp / 3);
      const newHp = Math.min(ch.hp + heal, ch.maxHp);
      ch = { ...ch, hp: newHp };
      return {
        character: ch,
        monster: null,
        message: `You rest in a shadowy alcove, recovering ${newHp - character.hp} HP. (${ch.hp}/${ch.maxHp} HP)`,
        enteredCombat: false,
        turnsRemaining: newTurnsRemaining,
      };
    }
  }
}

/**
 * Resolve one round of combat between the player and a monster.
 *
 * Order of events:
 *   1. Player attacks the monster.
 *   2. If the monster survives, it attacks the player.
 *   3. If the monster is defeated, award XP and gold, then apply any
 *      level-ups (possibly multiple in one round).
 *   4. If the player is defeated (HP ≤ 0), clamp HP to 0; no rewards.
 *
 * Damage formula:
 *   playerDamage  = max(1, attacker.attack  - defender.defense + floor(rng() * 3))
 *   monsterDamage = max(1, monster.attack   - char.defense     + floor(rng() * 3))
 *
 * @param character - Current character state.
 * @param monster   - The monster being fought.
 * @param rng       - Injected RNG function returning [0, 1).
 * @returns A CombatRoundResult describing everything that happened this round.
 */
export function runCombatRound(
  character: GameCharacter,
  monster: Monster,
  rng: () => number,
): CombatRoundResult {
  // --- Player attacks ---
  const playerDamageDealt = Math.max(
    1,
    character.attack - monster.defense + Math.floor(rng() * 3),
  );
  let updatedMonster: Monster = { ...monster, hp: monster.hp - playerDamageDealt };
  const monsterDefeated = updatedMonster.hp <= 0;

  // --- Monster counter-attacks (only if still alive) ---
  let monsterDamageDealt = 0;
  let updatedCharacter: GameCharacter = character;
  let playerDefeated = false;

  if (!monsterDefeated) {
    monsterDamageDealt = Math.max(
      1,
      monster.attack - character.defense + Math.floor(rng() * 3),
    );
    const newHp = character.hp - monsterDamageDealt;
    playerDefeated = newHp <= 0;
    updatedCharacter = { ...character, hp: playerDefeated ? 0 : newHp };
  }

  // --- Outcome handling ---
  let xpAwarded = 0;
  let goldAwarded = 0;
  let leveledUp = false;
  let message: string;

  if (monsterDefeated) {
    xpAwarded = monster.xpReward;
    goldAwarded = monster.goldReward;

    const beforeLevel = updatedCharacter.level;
    updatedCharacter = applyLevelUp({
      ...updatedCharacter,
      xp: updatedCharacter.xp + xpAwarded,
      gold: updatedCharacter.gold + goldAwarded,
    });
    leveledUp = updatedCharacter.level > beforeLevel;

    message = `You defeat the ${monster.name}! Gained ${xpAwarded} XP and ${goldAwarded} gold.`;
    if (leveledUp) {
      message += ` You reached level ${updatedCharacter.level}!`;
    }
  } else if (playerDefeated) {
    message = `The ${monster.name} deals ${monsterDamageDealt} damage — you have fallen. Your adventure ends here.`;
  } else {
    message =
      `You hit the ${monster.name} for ${playerDamageDealt} damage. ` +
      `The ${monster.name} strikes back for ${monsterDamageDealt} damage. ` +
      `(Your HP: ${updatedCharacter.hp}/${updatedCharacter.maxHp}, Monster HP: ${updatedMonster.hp})`;
  }

  return {
    character: updatedCharacter,
    monster: updatedMonster,
    playerDamageDealt,
    monsterDamageDealt,
    monsterDefeated,
    playerDefeated,
    xpAwarded,
    goldAwarded,
    leveledUp,
    message,
  };
}

/**
 * Generate a monster appropriate for the given dungeon depth.
 *
 * At depth 5 the Crypt Lord (final boss) is always returned.
 * At other depths a name is chosen from the depth's roster and stats are
 * derived from depth-scaled formulas.
 *
 * Depth is clamped to [1, MAX_DEPTH] before use.
 *
 * @param dungeonDepth - The current dungeon level (1–5).
 * @param rng          - Injected RNG function returning [0, 1).
 * @returns A Monster ready to fight.
 */
export function generateMonster(dungeonDepth: number, rng: () => number): Monster {
  const depth = Math.max(1, Math.min(dungeonDepth, MAX_DEPTH));

  if (depth === MAX_DEPTH) {
    return {
      name: 'Crypt Lord',
      hp: 40,
      attack: 10,
      defense: 5,
      xpReward: 50,
      goldReward: 100,
      isFinalBoss: true,
    };
  }

  const roster = DEPTH_ROSTERS[depth];
  const name = roster[Math.floor(rng() * roster.length)];

  return {
    name,
    hp: 8 + depth * 4 + Math.floor(rng() * 4),
    attack: 3 + depth,
    defense: 1 + Math.floor(depth / 2),
    xpReward: 5 + depth * 3,
    goldReward: 2 + depth * 2 + Math.floor(rng() * 5),
    isFinalBoss: false,
  };
}

/**
 * Apply any pending level-ups to a character.
 *
 * While `xp >= xpToNextLevel`:
 *   - level increases by 1
 *   - xp is reduced by the threshold
 *   - xpToNextLevel becomes level * 20 (using the NEW level)
 *   - maxHp increases by 5
 *   - hp is set to the new maxHp (full heal on level-up)
 *   - attack increases by 2
 *   - defense increases by 1
 *
 * @param character - Character whose XP may warrant a level gain.
 * @returns Updated character (possibly multiple levels higher).
 */
export function applyLevelUp(character: GameCharacter): GameCharacter {
  let ch = { ...character };

  while (ch.xp >= ch.xpToNextLevel) {
    ch = {
      ...ch,
      xp: ch.xp - ch.xpToNextLevel,
      level: ch.level + 1,
      // xpToNextLevel uses the NEW level value
      xpToNextLevel: (ch.level + 1) * 20,
      maxHp: ch.maxHp + 5,
      hp: ch.maxHp + 5, // full heal
      attack: ch.attack + 2,
      defense: ch.defense + 1,
    };
  }

  return ch;
}

/**
 * Determine whether defeating this monster satisfies the win condition.
 *
 * @param monster - The monster that was just defeated.
 * @returns `true` only if the monster is the Crypt Lord (final boss).
 */
export function checkWinCondition(monster: Monster): boolean {
  return monster.isFinalBoss;
}

/**
 * Reset a character to starting stats after death.
 *
 * The `userId`, `turnsUsedToday`, and `turnsResetDate` fields are preserved
 * so that dying does not refund the turns already spent this day.
 * `isVictorious` is set to `false`.
 *
 * @param character - The character that just died.
 * @returns A fresh character sharing the same user identity and turn state.
 */
export function resetCharacter(character: GameCharacter): GameCharacter {
  return {
    userId: character.userId,
    hp: 20,
    maxHp: 20,
    attack: 5,
    defense: 3,
    level: 1,
    xp: 0,
    xpToNextLevel: 20,
    gold: 0,
    dungeonDepth: 1,
    turnsUsedToday: character.turnsUsedToday,
    turnsResetDate: character.turnsResetDate,
    isVictorious: false,
  };
}
