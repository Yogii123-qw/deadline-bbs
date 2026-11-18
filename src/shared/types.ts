/**
 * src/shared/types.ts
 *
 * Central type definitions shared across all layers. No runtime logic.
 */

// ---------------------------------------------------------------------------
// User record
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string;             // UUID
  handle: string;         // 2–20 chars, ANSI-stripped
  passwordHash: string;   // hex SHA-256(salt + passcode)
  salt: string;           // 16-byte random hex
  createdAt: string;      // ISO 8601
  lastLoginAt: string;    // ISO 8601
  readMarkers: Record<string, string>; // boardId → lastReadPostId
  gameCharacter: GameCharacter | null;
}

// ---------------------------------------------------------------------------
// Message boards
// ---------------------------------------------------------------------------

export interface Board {
  id: string;
  name: string;
  description: string;
}

export interface Post {
  id: string;             // UUID
  threadId: string;
  boardId: string;
  authorHandle: string;
  subject: string;        // max 72 chars
  body: string;           // max 4096 chars
  createdAt: string;      // ISO 8601
  isArchive: boolean;     // true for 1994 seed posts
}

export interface Thread {
  id: string;
  boardId: string;
  subject: string;
  authorHandle: string;
  createdAt: string;
  posts: Post[];
}

// ---------------------------------------------------------------------------
// CATACOMB game state
// ---------------------------------------------------------------------------

export interface GameCharacter {
  userId: string;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  level: number;
  xp: number;
  xpToNextLevel: number;
  gold: number;
  dungeonDepth: number;   // how deep the character has progressed
  turnsUsedToday: number;
  turnsResetDate: string; // ISO date YYYY-MM-DD
  isVictorious: boolean;
}

export interface Monster {
  name: string;
  hp: number;
  attack: number;
  defense: number;
  xpReward: number;
  goldReward: number;
  isFinalBoss: boolean;
}

export interface CombatResult {
  playerDamageDealt: number;
  monsterDamageDealt: number;
  monsterDefeated: boolean;
  playerDefeated: boolean;
  xpAwarded: number;
  goldAwarded: number;
  leveledUp: boolean;
}

export interface HallOfFameEntry {
  handle: string;
  level: number;
  timestamp: string;      // ISO 8601
}

// ---------------------------------------------------------------------------
// File area
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string;
  sizeBytes: number;
  description: string;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionState {
  id: string;             // UUID
  transport: 'telnet' | 'websocket';
  phase: SessionPhase;
  userId: string | null;
  handle: string | null;
  connectedAt: string;    // ISO 8601
  terminalWidth: number;
  terminalHeight: number;
  pendingRegistration: PendingRegistration | null;
  boardContext: BoardContext | null;
  gameContext: GameContext | null;
  fileContext: FileContext | null;
}

export type SessionPhase =
  | 'SPLASH'
  | 'HANDLE_PROMPT'
  | 'PASSCODE_PROMPT'
  | 'CONFIRM_PASSCODE'
  | 'MAIN_MENU'
  | 'BOARDS_MENU'
  | 'BOARD_LIST'
  | 'THREAD_LIST'
  | 'READING_THREAD'
  | 'COMPOSING_POST'
  | 'COMPOSING_REPLY'
  | 'SEARCH_PROMPT'
  | 'SEARCH_RESULTS'
  | 'FILE_LIST'
  | 'READING_FILE'
  | 'CATACOMB'
  | 'CATACOMB_COMBAT'
  | 'HALL_OF_FAME'
  | 'WHO_ONLINE'
  | 'LOGOFF'
  ;

export interface PendingRegistration {
  handle: string;
  firstPasscode: string | null;
}

export interface BoardContext {
  boardId: string | null;
  threadId: string | null;
  page: number;
  composingSubject: string | null;
  composingBody: string | null;
  searchQuery: string | null;
}

export interface GameContext {
  currentMonster: Monster | null;
}

export interface FileContext {
  filename: string | null;
  page: number;
}

// ---------------------------------------------------------------------------
// Active session (who's online registry)
// ---------------------------------------------------------------------------

export interface ActiveSession {
  id: string;
  handle: string;
  transport: 'telnet' | 'websocket';
  connectedAt: Date;
}
