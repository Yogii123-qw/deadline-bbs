/**
 * tests/unit/archive.test.ts — Public read-only archive (PRO-DEV):
 * rendering correctness (escaping, markers, structure) and HTTP behavior
 * (matches the API, no write path, no login) against a real booted node.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { seedBoardsData } from '../../src/boards/seeds.js';
import {
  escapeHtml,
  renderArchivePage,
} from '../../src/server/archive.js';
import type { BoardsData } from '../../src/shared/validation.js';
import { SessionDriver } from '../helpers.js';
import { bootNode, type BootedNode } from '../sync-helpers.js';

/** The shell's exact token set: the archive must introduce zero new colors. */
const ALLOWED_HEX = new Set([
  '#ffb000',
  '#9c7c33',
  '#5c4a22',
  '#0d0a04',
  '#050403',
  '#2a1f0d',
  '#e8dcc0',
  '#ff5a4e',
  '#8fbf5f',
]);

function dataWith(overrides: Partial<BoardsData>): BoardsData {
  return { ...seedBoardsData(), ...overrides };
}

describe('renderArchivePage', () => {
  it('renders boards, threads, and posts with semantic structure', () => {
    const html = renderArchivePage(seedBoardsData(), 'node-a', '2026-11-19T12:00:00.000Z');
    expect(html).toContain('<main id="boards">');
    expect(html).toContain('<nav aria-label="Boards">');
    expect(html).toContain('<article');
    expect(html).toContain('General Discussion');
    expect(html).toContain('Welcome to DeadLine!');
    expect(html).toContain('Node: node-a');
    expect(html).toContain('snapshot 2026-11-19T12:00:00.000Z');
    expect(html).toContain('Skip to boards');
  });

  it('escapes all user-derived content', () => {
    const data = dataWith({
      threads: [
        {
          id: 't-x',
          boardId: 'general',
          subject: '<script>alert("x")</script>',
          authorHandle: 'Evil"Handle',
          createdAt: '2026-11-19T10:00:00.000Z',
          posts: [
            {
              id: 'p-x',
              threadId: 't-x',
              boardId: 'general',
              authorHandle: 'Evil"Handle',
              subject: '<script>alert("x")</script>',
              body: "<img src=x onerror=alert(1)> & 'quotes'",
              createdAt: '2026-11-19T10:00:00.000Z',
              isArchive: false,
            },
          ],
        },
      ],
    });
    const html = renderArchivePage(data, 'node-a', '2026-11-19T12:00:00.000Z');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &#39;quotes&#39;');
    expect(html).toContain('Evil&quot;Handle');
  });

  it('marks archive and edited posts, and hides tombstoned ones', () => {
    const seed = seedBoardsData();
    const thread = seed.threads[0];
    const data = dataWith({
      postMeta: { [thread.posts[0].id]: { editedAt: '2026-11-19T12:00:00.000Z', editEntryId: 'e1' } },
      tombstones: { [thread.posts[1].id]: { deletedAt: '2026-11-19T12:00:00.000Z', entryId: 't1' } },
    });
    // The renderer trusts the filtered read view: mirror it here by
    // removing the tombstoned post, as BoardStore.readData does.
    const filtered: BoardsData = {
      ...data,
      threads: data.threads.map((t) => ({
        ...t,
        posts: t.posts.filter((p) => data.tombstones[p.id] === undefined),
      })),
    };
    const html = renderArchivePage(filtered, 'node-a', '2026-11-19T12:00:00.000Z');
    expect(html).toContain('[ARCHIVE - 1994]');
    expect(html).toContain('[edited 2026-11-19]');
    expect(html).not.toContain(escapeHtml(thread.posts[1].body));
  });

  it('has no forms, no scripts, and zero new colors', () => {
    const html = renderArchivePage(seedBoardsData(), 'node-a', '2026-11-19T12:00:00.000Z');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<input');
    const hexes = [...html.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0].toLowerCase());
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) {
      expect(ALLOWED_HEX.has(hex)).toBe(true);
    }
  });

  it('handles empty boards', () => {
    const html = renderArchivePage(
      dataWith({ threads: [] }),
      'node-a',
      '2026-11-19T12:00:00.000Z',
    );
    expect(html).toContain('No threads yet.');
    expect(html).toContain('0 threads');
  });
});

describe('/archive over HTTP', () => {
  const nodes: BootedNode[] = [];
  afterEach(async () => {
    for (const n of nodes.splice(0)) {
      await n.stop();
    }
  });

  it('matches the JSON API, needs no login, and rejects writes', async () => {
    const node = await bootNode({ nodeId: 'node-archive' });
    nodes.push(node);
    // A post with HTML-significant content, plus an edit, plus a delete.
    const d = new SessionDriver(node.env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('1');
    await d.send('1');
    await d.send('N');
    await d.send('Archive <b>Test</b>');
    await d.send('Body with <script> & markup');
    await d.send('.');
    await d.send('1');
    await d.send('E1');
    await d.send('');
    await d.send('Edited body with <em>markup</em>');
    await d.send('.');

    const apiRes = await fetch(`${node.baseUrl}/api/boards/general/threads`);
    expect(apiRes.status).toBe(200);
    const api = (await apiRes.json()) as {
      threads: Array<{
        subject: string;
        posts: Array<{ body: string; authorHandle: string; editedAt?: string }>;
      }>;
    };
    const edited = api.threads.find((t) => t.subject === 'Archive <b>Test</b>');
    expect(edited).toBeDefined();
    expect(edited?.posts[0].editedAt).toBeDefined();

    const res = await fetch(`${node.baseUrl}/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // Every API thread subject and post body appears, escaped, in the page.
    for (const thread of api.threads) {
      expect(html).toContain(escapeHtml(thread.subject));
      for (const post of thread.posts) {
        expect(html).toContain(escapeHtml(post.body));
        expect(html).toContain(escapeHtml(post.authorHandle));
        if (post.editedAt !== undefined) {
          expect(html).toContain('[edited');
        }
      }
    }
    expect(html).not.toContain('<script> & markup');
    expect(html).toContain('Edited body with &lt;em&gt;markup&lt;/em&gt;');
    expect(html).not.toContain('<form');
    // Snapshot timestamp is second-precise (no millisecond noise).
    expect(html).toMatch(/snapshot \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);

    // No write path: POST is rejected, and nothing changed.
    const postRes = await fetch(`${node.baseUrl}/archive`, { method: 'POST', body: 'x=1' });
    expect(postRes.status).toBe(405);
    const putRes = await fetch(`${node.baseUrl}/archive`, { method: 'PUT' });
    expect(putRes.status).toBe(405);
    // HEAD answers with headers only.
    const headRes = await fetch(`${node.baseUrl}/archive`, { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe('');
  });
});
