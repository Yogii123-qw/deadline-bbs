import { describe, expect, it } from 'vitest';
import { searchBoards } from '../../src/boards/search.js';
import { seedBoardsData } from '../../src/boards/seeds.js';
import type { BoardsData } from '../../src/shared/validation.js';

describe('searchBoards', () => {
  it('matches case-insensitively in subject and body', () => {
    const data = seedBoardsData();
    const bySubject = searchBoards('MODEM', data);
    expect(bySubject.length).toBeGreaterThan(0);
    expect(bySubject.every((r) => /modem/i.test(r.subject) || /modem/i.test(r.excerpt))).toBe(true);
    const byBody = searchBoards('FidoNet', data);
    expect(byBody).toHaveLength(1);
    expect(byBody[0].subject).toBe('FidoNet echomail setup notes');
  });

  it('returns no results for missing terms', () => {
    expect(searchBoards('zzzznothing', seedBoardsData())).toEqual([]);
  });

  it('sorts newest first and carries the archive flag', () => {
    const results = searchBoards('the', seedBoardsData());
    expect(results.length).toBeGreaterThan(1);
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1].createdAt >= results[i].createdAt).toBe(true);
    }
    expect(results.every((r) => r.isArchive)).toBe(true);
    expect(results[0].boardName).toBeTruthy();
  });

  it('cuts excerpts around the match', () => {
    const results = searchBoards('Crypt Lord', seedBoardsData());
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].excerpt.toLowerCase()).toContain('crypt lord');
    expect(results[0].excerpt.length).toBeLessThanOrEqual(152);
  });

  it('caps results at 50', () => {
    const data: BoardsData = { boards: seedBoardsData().boards, threads: [] };
    for (let i = 0; i < 60; i += 1) {
      data.threads.push({
        id: `t${i}`,
        boardId: 'general',
        subject: `Thread ${i} about modems`,
        authorHandle: 'Tester',
        createdAt: `2026-11-19T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
        posts: [
          {
            id: `p${i}`,
            threadId: `t${i}`,
            boardId: 'general',
            authorHandle: 'Tester',
            subject: `Thread ${i} about modems`,
            body: 'modems everywhere',
            createdAt: `2026-11-19T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
            isArchive: false,
          },
        ],
      });
    }
    expect(searchBoards('modems', data)).toHaveLength(50);
  });
});
