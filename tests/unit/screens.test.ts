import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/telnet/ansi.js';
import {
  catacombScreen,
  combatScreen,
  filePager,
  formatElapsed,
  hallOfFameScreen,
  mainMenu,
  splashScreen,
  threadListScreen,
  threadViewScreen,
  whoOnlineScreen,
  wrapText,
} from '../../src/session/screens.js';
import { newCharacter } from '../../src/game/catacomb.js';
import { seedBoardsData } from '../../src/boards/seeds.js';

describe('screens', () => {
  it('splash banner rows are equal width (aligned logo)', () => {
    const plain = stripAnsi(splashScreen(80));
    const lines = plain.split('\n');
    const banner = lines.filter((l) => l.includes('█'));
    expect(banner.length).toBeGreaterThanOrEqual(5);
    const logoRows = banner.slice(0, 5);
    // Untrimmed: every glyph row is exactly 47 columns, centered with the
    // same left pad, so all five rows share one total width.
    const widths = new Set(logoRows.map((r) => r.length));
    expect(widths.size).toBe(1);
    expect(plain).toContain('REFUSES TO DIE');
    expect(plain).toContain('Est. 1994');
  });

  it('tombstone rows share one width (no skew)', () => {
    const plain = stripAnsi(splashScreen(80));
    const lines = plain.split('\n');
    const stoneTop = lines.findIndex((l) => l.includes('____________'));
    expect(stoneTop).toBeGreaterThanOrEqual(0);
    const stone = lines.slice(stoneTop, stoneTop + 5);
    expect(new Set(stone.map((r) => r.length)).size).toBe(1);
    expect(plain).toContain('R.I.P.');
    expect(plain).toContain('1978-1995');
  });

  it('narrow splash is compact: no 47-column logo, everything fits', () => {
    const plain = stripAnsi(splashScreen(44));
    expect(plain).not.toContain('█');
    expect(plain).toContain('DEADLINE BBS');
    expect(plain).toContain('THE BOARD THAT REFUSES TO DIE');
    for (const line of plain.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(44);
    }
  });

  it('full splash lines fit 80 columns', () => {
    const plain = stripAnsi(splashScreen(80));
    for (const line of plain.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('main menu shows handle and elapsed time', () => {
    const plain = stripAnsi(mainMenu('Alice', '0:04:12'));
    expect(plain).toContain('Alice');
    expect(plain).toContain('0:04:12');
    expect(plain).toContain('Message Boards');
    expect(plain).toContain('CATACOMB');
    expect(plain).toContain('Goodbye');
  });

  it('narrow main menu never wraps the timer mid-number', () => {
    const plain = stripAnsi(mainMenu('A'.repeat(20), '0:00:04', 44));
    for (const line of plain.split('\n')) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(44);
    }
    expect(plain).toContain('0:00:04');
  });

  it('thread list paginates and marks unread', () => {
    const data = seedBoardsData();
    const board = data.boards[0];
    const threads = data.threads.filter((t) => t.boardId === 'general');
    const unread = new Set([threads[0].posts[0].id]);
    const plain = stripAnsi(threadListScreen(board, threads, unread, 0));
    expect(plain).toContain('Page 1/1');
    expect(plain).toContain('*');
    expect(plain).toContain('Welcome to DeadLine!');
  });

  it('thread view labels archive posts and paginates', () => {
    const thread = seedBoardsData().threads[0];
    const plain = stripAnsi(threadViewScreen(thread, 0));
    expect(plain).toContain('[ARCHIVE - 1994]');
    expect(plain).toContain('SYSOP');
    expect(plain).toContain('Page 1/1');
  });

  it('file pager slices lines per page', () => {
    const content = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n');
    const p1 = stripAnsi(filePager('X.TXT', content, 0));
    const p3 = stripAnsi(filePager('X.TXT', content, 2));
    expect(p1).toContain('line 1');
    expect(p1).toContain('line 20');
    expect(p1).not.toContain('line 21');
    expect(p3).toContain('line 45');
    expect(p3).toContain('Page 3/3');
  });

  it('catacomb and combat screens show stats', () => {
    const ch = newCharacter('u1', '2026-11-19');
    const plain = stripAnsi(catacombScreen(ch, 17, 'A cold draft.', 80));
    expect(plain).toContain('Level 1');
    expect(plain).toContain('20/20');
    expect(plain).toContain('Turns left today: 17');
    expect(plain).toContain('A cold draft.');
    const monster = {
      name: 'Rat',
      hp: 9,
      attack: 4,
      defense: 1,
      xpReward: 8,
      goldReward: 4,
      isFinalBoss: false,
    };
    const combat = stripAnsi(combatScreen(ch, monster, null, 80));
    expect(combat).toContain('Rat');
    expect(combat).toContain('HP 9');
  });

  it('hall of fame handles empty and filled states', () => {
    expect(stripAnsi(hallOfFameScreen([]))).toContain('empty');
    const filled = stripAnsi(
      hallOfFameScreen([{ handle: 'Alice', level: 6, timestamp: '2026-11-19T00:00:00.000Z' }]),
    );
    expect(filled).toContain('Alice');
    expect(filled).toContain('level 6');
  });

  it('who online distinguishes solo from group', () => {
    const solo = stripAnsi(
      whoOnlineScreen(
        [{ id: '1', handle: 'Alice', transport: 'telnet', connectedAt: new Date('2026-11-19T12:00:00.000Z') }],
        new Date('2026-11-19T12:05:00.000Z'),
      ),
    );
    expect(solo).toContain('only caller');
    const group = stripAnsi(
      whoOnlineScreen(
        [
          { id: '1', handle: 'Alice', transport: 'telnet', connectedAt: new Date('2026-11-19T12:00:00.000Z') },
          { id: '2', handle: 'Bob', transport: 'websocket', connectedAt: new Date('2026-11-19T12:01:00.000Z') },
        ],
        new Date('2026-11-19T12:05:00.000Z'),
      ),
    );
    expect(group).toContain('2 callers online');
  });

  it('wrapText wraps words and splits long words', () => {
    expect(wrapText('one two three four', 7)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });

  it('formatElapsed renders H:MM:SS', () => {
    expect(formatElapsed('2026-11-19T12:00:00.000Z', new Date('2026-11-19T13:02:03.000Z'))).toBe(
      '1:02:03',
    );
    expect(formatElapsed('2026-11-19T12:00:00.000Z', new Date('2026-11-19T12:00:09.000Z'))).toBe(
      '0:00:09',
    );
  });
});
