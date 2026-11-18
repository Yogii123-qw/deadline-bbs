/**
 * src/session/screens.ts — ANSI screen builders (builder-written, per design §2.14).
 *
 * Pure functions returning strings. All output uses "\n" line endings; the
 * transports normalize to CRLF on write. Screens include their input prompt
 * as the final line (no trailing newline) unless noted.
 */

import type {
  ActiveSession,
  Board,
  GameCharacter,
  HallOfFameEntry,
  Monster,
  Thread,
} from '../shared/types.js';
import type { CombatRoundResult } from '../game/catacomb.js';
import type { FileEntry } from '../shared/types.js';
import type { SearchResult } from '../boards/search.js';
import { bold, clearScreen, color, reset, stripAnsi } from '../telnet/ansi.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export const DEFAULT_WIDTH = 80;
export const THREADS_PER_PAGE = 10;
export const POSTS_PER_PAGE = 5;
export const FILE_LINES_PER_PAGE = 20;

/** Word-wrap text to a width, preserving blank lines. Long words are split. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let rest = paragraph;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ +/, '');
    }
    lines.push(rest);
  }
  return lines;
}

/** "H:MM:SS" elapsed time. */
export function formatElapsed(connectedAtIso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(connectedAtIso).getTime());
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function bar(title: string, width: number): string {
  const rule = '─'.repeat(Math.max(0, width - 2));
  return `${color(36)}┌${rule}┐${reset()}\n${color(36)}│${reset()} ${bold()}${title}${reset()}`;
}

function rule(width: number): string {
  return `${color(36)}${'─'.repeat(width)}${reset()}`;
}

function centerLine(text: string, width: number): string {
  // Measure visible characters only: escape codes must not shift the pad.
  const visible = stripAnsi(text).length;
  const pad = Math.max(0, Math.floor((width - visible) / 2));
  return ' '.repeat(pad) + text;
}

/* ------------------------------------------------------------------ */
/* Splash                                                              */
/* ------------------------------------------------------------------ */

const GLYPHS: Record<string, string[]> = {
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
};

function banner(word: string): string[] {
  const rows = ['', '', '', '', ''];
  for (const letter of word) {
    const glyph = GLYPHS[letter] ?? GLYPHS['I'];
    for (let i = 0; i < 5; i += 1) {
      rows[i] += (rows[i] === '' ? '' : ' ') + glyph[i];
    }
  }
  return rows;
}

/**
 * Tombstone art. Every row is exactly 24 columns and the block is centered
 * with ONE pad, so the shape can never skew (centering each row by its own
 * length leans the stone).
 */
const TOMBSTONE_ROWS = [
  '      ____________      ',
  '     /            \\     ',
  '    |   R.I.P.     |    ',
  '    |  1978-1995   |    ',
  '    |______________|    ',
];

function centerBlock(rows: string[], width: number): string[] {
  const blockWidth = Math.max(...rows.map((r) => r.length));
  const pad = Math.max(0, Math.floor((width - blockWidth) / 2));
  return rows.map((r) => ' '.repeat(pad) + r);
}

export function splashScreen(width: number = DEFAULT_WIDTH): string {
  if (width < 50) {
    // Narrow terminals (phones): the 47-column logo cannot fit, so render
    // a compact splash that stays readable instead of wrapping mid-letter.
    const lines = [
      clearScreen(),
      ...centerBlock(TOMBSTONE_ROWS, width),
      '',
      centerLine(`${bold()}${color(35)}DEADLINE BBS${reset()}`, width),
      centerLine(`${color(33)}THE BOARD THAT REFUSES TO DIE${reset()}`, width),
      '',
      centerLine('Est. 1994 · Still answering.', width),
      centerLine('Kiroween 2026 — Resurrection', width),
      '',
      rule(width),
    ];
    return lines.join('\n');
  }
  const art = centerBlock(banner('DEADLINE'), width);
  const tombstone = centerBlock(TOMBSTONE_ROWS, width);
  const lines = [
    clearScreen(),
    ...tombstone,
    '',
    ...art.map((row) => `${bold()}${color(35)}${row}${reset()}`),
    centerLine(`${color(33)}THE BULLETIN BOARD SYSTEM THAT REFUSES TO DIE${reset()}`, width),
    '',
    centerLine('Est. 1994 · One node · Still answering.', width),
    centerLine('Kiroween 2026 — Resurrection', width),
    '',
    rule(width),
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Menus and lists                                                     */
/* ------------------------------------------------------------------ */

export function mainMenu(handle: string, elapsed: string, width: number = DEFAULT_WIDTH): string {
  // Narrow terminals: the greeting + timer on one line would wrap mid-number.
  const greeting =
    width < 50
      ? [`  Welcome back, ${bold()}${handle}${reset()}.`, `  Call time: ${elapsed}`]
      : [`  Welcome back, ${bold()}${handle}${reset()}.  Call time: ${elapsed}`];
  return [
    '',
    bar('DEADLINE BBS — MAIN MENU', width),
    `${color(36)}└${'─'.repeat(Math.max(0, width - 2))}┘${reset()}`,
    '',
    ...greeting,
    '',
    `  ${color(33)}1${reset()}  Message Boards`,
    `  ${color(33)}2${reset()}  File Area`,
    `  ${color(33)}3${reset()}  CATACOMB — door game`,
    `  ${color(33)}4${reset()}  Hall of Fame`,
    `  ${color(33)}5${reset()}  Who's Online`,
    `  ${color(33)}G${reset()}  Goodbye (log off)`,
    '',
    'Choice: ',
  ].join('\n');
}

export function boardListScreen(
  boards: Board[],
  unreadCounts: Record<string, number>,
  width: number = DEFAULT_WIDTH,
): string {
  const lines = ['', bar('MESSAGE BOARDS', width), ''];
  boards.forEach((board, i) => {
    const unread = unreadCounts[board.id] ?? 0;
    const badge = unread > 0 ? ` ${color(33)}[${unread} new]${reset()}` : '';
    lines.push(`  ${color(33)}${i + 1}${reset()}  ${bold()}${board.name}${reset()}${badge}`);
    lines.push(`     ${board.description}`);
  });
  lines.push('');
  lines.push('  Number: open board · /: search all boards · Q: main menu');
  lines.push('');
  lines.push('Board: ');
  return lines.join('\n');
}

export function threadListScreen(
  board: Board,
  threads: Thread[],
  unreadPostIds: Set<string>,
  page: number,
  width: number = DEFAULT_WIDTH,
): string {
  const totalPages = Math.max(1, Math.ceil(threads.length / THREADS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = threads.slice(
    safePage * THREADS_PER_PAGE,
    safePage * THREADS_PER_PAGE + THREADS_PER_PAGE,
  );
  const lines = ['', bar(`BOARD: ${board.name.toUpperCase()}`, width), ''];
  if (slice.length === 0) {
    lines.push('  No threads yet. Be the first to post.');
  }
  slice.forEach((thread, i) => {
    const n = safePage * THREADS_PER_PAGE + i + 1;
    const hasUnread = thread.posts.some((p) => unreadPostIds.has(p.id));
    const star = hasUnread ? `${color(33)}*${reset()} ` : '  ';
    const replies = Math.max(0, thread.posts.length - 1);
    const date = thread.createdAt.slice(0, 10);
    lines.push(
      `  ${star}${color(33)}${n}${reset()}  ${thread.subject} (${replies} ${replies === 1 ? 'reply' : 'replies'})`,
    );
    lines.push(`       by ${thread.authorHandle} · ${date}`);
  });
  lines.push('');
  lines.push(`  Page ${safePage + 1}/${totalPages} · Number: read · N: new thread · >/<: page · Q: boards`);
  lines.push('');
  lines.push('Thread: ');
  return lines.join('\n');
}

export function threadViewScreen(
  thread: Thread,
  page: number,
  width: number = DEFAULT_WIDTH,
): string {
  const totalPages = Math.max(1, Math.ceil(thread.posts.length / POSTS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = thread.posts.slice(
    safePage * POSTS_PER_PAGE,
    safePage * POSTS_PER_PAGE + POSTS_PER_PAGE,
  );
  const lines = ['', bar(`THREAD: ${thread.subject}`, width), ''];
  for (const post of slice) {
    const archive = post.isArchive ? ` ${color(35)}[ARCHIVE - 1994]${reset()}` : '';
    lines.push(`${bold()}From:${reset()} ${post.authorHandle}${archive}  ${color(36)}${post.createdAt.slice(0, 10)}${reset()}`);
    lines.push(...wrapText(post.body, width - 2).map((l) => `  ${l}`));
    lines.push('');
  }
  lines.push(`  Page ${safePage + 1}/${totalPages} · Enter: more · R: reply · Q: back to threads`);
  lines.push('');
  lines.push('Command: ');
  return lines.join('\n');
}

export function composeScreen(
  prompt: string,
  width: number = DEFAULT_WIDTH,
): string {
  return [
    '',
    bar('COMPOSE', width),
    '',
    '  Type your message. End with a single dot (.) on its own line.',
    '  Type ABORT on its own line to cancel without posting.',
    '',
    `${prompt} `,
  ].join('\n');
}

export function searchResultsScreen(
  results: SearchResult[],
  query: string,
  width: number = DEFAULT_WIDTH,
): string {
  const lines = ['', bar(`SEARCH: "${query}"`, width), ''];
  if (results.length === 0) {
    lines.push('  No results. Try a different word.');
  }
  results.forEach((r, i) => {
    const archive = r.isArchive ? ` ${color(35)}[ARCHIVE - 1994]${reset()}` : '';
    lines.push(`  ${color(33)}${i + 1}${reset()}  ${r.subject} — ${r.boardName}${archive}`);
    lines.push(`       by ${r.authorHandle} · ${r.excerpt}`);
  });
  lines.push('');
  lines.push('  Number: open thread · Q: back to boards');
  lines.push('');
  lines.push('Result: ');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* File area                                                           */
/* ------------------------------------------------------------------ */

export function fileListScreen(
  files: FileEntry[],
  width: number = DEFAULT_WIDTH,
): string {
  const lines = ['', bar('FILE AREA', width), ''];
  if (files.length === 0) {
    lines.push('  No files yet.');
  }
  files.forEach((file, i) => {
    const desc = file.description === '' ? '' : ` — ${file.description}`;
    lines.push(`  ${color(33)}${i + 1}${reset()}  ${file.name} (${file.sizeBytes} bytes)${desc}`);
  });
  lines.push('');
  lines.push('  Number: read inline · D<number>: download link · Q: main menu');
  lines.push('');
  lines.push('File: ');
  return lines.join('\n');
}

export function filePager(
  filename: string,
  content: string,
  page: number,
  width: number = DEFAULT_WIDTH,
): string {
  const allLines = content.replace(/\n$/, '').split('\n');
  const totalPages = Math.max(1, Math.ceil(allLines.length / FILE_LINES_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = allLines.slice(
    safePage * FILE_LINES_PER_PAGE,
    safePage * FILE_LINES_PER_PAGE + FILE_LINES_PER_PAGE,
  );
  const lines = ['', bar(`FILE: ${filename}`, width), ''];
  lines.push(...slice);
  lines.push('');
  lines.push(`  Page ${safePage + 1}/${totalPages} · Enter: more · Q: back to file list`);
  lines.push('');
  lines.push('Command: ');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Game                                                                */
/* ------------------------------------------------------------------ */

function hpBar(hp: number, maxHp: number): string {
  const cells = 10;
  const filled = Math.max(0, Math.min(cells, Math.round((hp / Math.max(1, maxHp)) * cells)));
  return `[${'█'.repeat(filled)}${'░'.repeat(cells - filled)}] ${hp}/${maxHp}`;
}

export function catacombScreen(
  character: GameCharacter,
  turnsRemaining: number,
  message: string,
  width: number = DEFAULT_WIDTH,
): string {
  const lines = [
    '',
    bar('CATACOMB', width),
    '',
    `  ${bold()}Level ${character.level}${reset()} · HP ${hpBar(character.hp, character.maxHp)} · ATK ${character.attack} · DEF ${character.defense}`,
    `  Gold: ${character.gold} · XP: ${character.xp}/${character.xpToNextLevel} · Depth: ${character.dungeonDepth}/5 · Turns left today: ${turnsRemaining}`,
    '',
  ];
  if (message !== '') {
    lines.push(...wrapText(message, width - 2).map((l) => `  ${l}`));
    lines.push('');
  }
  lines.push('  E: explore · D: descend deeper · R: rest · S: status · Q: leave the dungeon');
  lines.push('');
  lines.push('Action: ');
  return lines.join('\n');
}

export function combatScreen(
  character: GameCharacter,
  monster: Monster,
  lastResult: CombatRoundResult | null,
  width: number = DEFAULT_WIDTH,
): string {
  const lines = [
    '',
    bar(`COMBAT: ${monster.name.toUpperCase()}`, width),
    '',
    `  ${bold()}${monster.name}${reset()} — HP ${monster.hp} · ATK ${monster.attack} · DEF ${monster.defense}${monster.isFinalBoss ? ` ${color(31)}FINAL BOSS${reset()}` : ''}`,
    `  You — HP ${hpBar(character.hp, character.maxHp)} · ATK ${character.attack} · DEF ${character.defense}`,
    '',
  ];
  if (lastResult !== null) {
    lines.push(...wrapText(lastResult.message, width - 2).map((l) => `  ${l}`));
    lines.push('');
  }
  lines.push('  A: attack · F: flee · S: status');
  lines.push('');
  lines.push('Action: ');
  return lines.join('\n');
}

export function hallOfFameScreen(
  entries: HallOfFameEntry[],
  width: number = DEFAULT_WIDTH,
): string {
  const lines = ['', bar('HALL OF FAME — CRYPT LORD SLAYERS', width), ''];
  if (entries.length === 0) {
    lines.push('  The Hall of Fame is empty. No one has slain the Crypt Lord yet.');
    lines.push('  The dungeon waits.');
  }
  entries.forEach((entry, i) => {
    lines.push(
      `  ${color(33)}${i + 1}.${reset()}  ${bold()}${entry.handle}${reset()} — level ${entry.level} · ${entry.timestamp.slice(0, 10)}`,
    );
  });
  lines.push('');
  lines.push('  Press Enter to return to the main menu.');
  lines.push('');
  lines.push('Continue: ');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Who's online, errors, goodbye                                       */
/* ------------------------------------------------------------------ */

export function whoOnlineScreen(
  sessions: ActiveSession[],
  now: Date,
  width: number = DEFAULT_WIDTH,
): string {
  const lines = ['', bar("WHO'S ONLINE", width), ''];
  if (sessions.length === 0) {
    lines.push('  No one is online right now.');
  } else if (sessions.length === 1) {
    lines.push('  You are the only caller online. The line is yours.');
    lines.push('');
    const s = sessions[0];
    lines.push(`  ${bold()}${s.handle}${reset()} — ${s.transport} · connected ${formatElapsed(s.connectedAt.toISOString(), now)} ago`);
  } else {
    lines.push(`  ${sessions.length} callers online:`);
    lines.push('');
    for (const s of sessions) {
      lines.push(
        `  ${bold()}${s.handle}${reset()} — ${s.transport} · connected ${formatElapsed(s.connectedAt.toISOString(), now)} ago`,
      );
    }
  }
  lines.push('');
  lines.push('  Press Enter to return to the main menu.');
  lines.push('');
  lines.push('Continue: ');
  return lines.join('\n');
}

export function errorScreen(message: string): string {
  return `\n  ${color(31)}!! ${message}${reset()}\n`;
}

export function goodbyeScreen(
  handle: string | null,
  elapsed: string,
  width: number = DEFAULT_WIDTH,
): string {
  const name = handle ?? 'caller';
  return [
    '',
    rule(width),
    '',
    centerLine(`Goodbye, ${name}. Thanks for calling DeadLine BBS.`, width),
    centerLine(`This call lasted ${elapsed}.`, width),
    centerLine('The board never sleeps. It only waits for the next ring.', width),
    '',
  ].join('\n');
}
