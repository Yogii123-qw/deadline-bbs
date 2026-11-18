/**
 * src/boards/search.ts — Full-text search over all boards (builder-written, per design §2.8).
 *
 * Pure function: case-insensitive substring match against subject and body,
 * newest first, capped at 50 results. The excerpt is cut around the match.
 */

import type { BoardsData } from '../shared/validation.js';

export interface SearchResult {
  boardId: string;
  boardName: string;
  threadId: string;
  postId: string;
  subject: string;
  authorHandle: string;
  excerpt: string;
  createdAt: string;
  isArchive: boolean;
}

export const SEARCH_RESULT_LIMIT = 50;
const EXCERPT_LENGTH = 150;
const EXCERPT_CONTEXT = 40;

function excerptAround(field: string, queryLower: string): string {
  const idx = field.toLowerCase().indexOf(queryLower);
  const start = Math.max(0, idx - EXCERPT_CONTEXT);
  let excerpt = field.slice(start, start + EXCERPT_LENGTH);
  if (start > 0) excerpt = `…${excerpt}`;
  if (start + EXCERPT_LENGTH < field.length) excerpt += '…';
  return excerpt.replace(/\s+/g, ' ');
}

export function searchBoards(query: string, data: BoardsData): SearchResult[] {
  const q = query.toLowerCase();
  const boardNames = new Map(data.boards.map((b) => [b.id, b.name]));
  const results: SearchResult[] = [];
  for (const thread of data.threads) {
    for (const post of thread.posts) {
      const bodyHit = post.body.toLowerCase().includes(q);
      const subjectHit = post.subject.toLowerCase().includes(q);
      if (!bodyHit && !subjectHit) continue;
      results.push({
        boardId: post.boardId,
        boardName: boardNames.get(post.boardId) ?? post.boardId,
        threadId: post.threadId,
        postId: post.id,
        subject: post.subject,
        authorHandle: post.authorHandle,
        excerpt: excerptAround(bodyHit ? post.body : post.subject, q),
        createdAt: post.createdAt,
        isArchive: post.isArchive,
      });
    }
  }
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return results.slice(0, SEARCH_RESULT_LIMIT);
}
