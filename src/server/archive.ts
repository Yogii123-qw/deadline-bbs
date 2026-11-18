/**
 * src/server/archive.ts — Public read-only web archive (builder-written,
 * PRO-DEV amendment).
 *
 * GET /archive renders the same board/thread/post data the JSON API
 * serves, as a readable page for anyone — no login, no JavaScript, no
 * write path (the HTTP server rejects non-GET/HEAD before this handler
 * runs, and the page contains no forms). The data comes from the
 * BoardStore's filtered read view, so tombstoned posts never appear and
 * edits show as their edited content with an [edited] marker — exactly
 * what a caller sees in the terminal.
 *
 * Design: a BBS printout, not a SaaS page. Monospace, ruled sections,
 * the shell's exact phosphor tokens (zero new colors), semantic HTML.
 * All user-derived content is HTML-escaped.
 */

import type * as http from 'node:http';
import type { BoardStore } from '../boards/boards.js';
import type { BoardsData } from '../shared/validation.js';

export interface ArchiveHandlerDeps {
  boards: BoardStore;
  nodeId: string;
}

export type ArchiveHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<boolean>;

/** Escape every HTML-significant character in user-derived content. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPost(
  post: BoardsData['threads'][number]['posts'][number],
  editedAt: string | undefined,
): string {
  const archive = post.isArchive ? ' <span class="marker archive">[ARCHIVE - 1994]</span>' : '';
  const edited =
    editedAt !== undefined ? ` <span class="marker edited">[edited ${escapeHtml(editedAt.slice(0, 10))}]</span>` : '';
  return [
    '      <div class="post">',
    `        <p class="post-meta">From: <strong>${escapeHtml(post.authorHandle)}</strong> &middot; ${escapeHtml(post.createdAt.slice(0, 10))}${archive}${edited}</p>`,
    `        <div class="post-body">${escapeHtml(post.body)}</div>`,
    '      </div>',
  ].join('\n');
}

function renderThread(
  thread: BoardsData['threads'][number],
  postMeta: BoardsData['postMeta'],
): string {
  const posts = thread.posts
    .map((post) => renderPost(post, postMeta[post.id]?.editedAt))
    .join('\n');
  return [
    `    <article aria-labelledby="thread-${escapeHtml(thread.id)}">`,
    `      <h3 id="thread-${escapeHtml(thread.id)}">${escapeHtml(thread.subject)}</h3>`,
    `      <p class="thread-meta">by ${escapeHtml(thread.authorHandle)} &middot; ${escapeHtml(thread.createdAt.slice(0, 10))} &middot; ${thread.posts.length} ${thread.posts.length === 1 ? 'message' : 'messages'}</p>`,
    posts,
    '    </article>',
  ].join('\n');
}

/**
 * Render the archive page. Pure function: the same data always renders
 * the same page. `generatedAt` is the snapshot time, supplied by the
 * handler (real clock) or the caller (tests).
 */
export function renderArchivePage(data: BoardsData, nodeId: string, generatedAt: string): string {
  const nav = data.boards
    .map(
      (board, i) =>
        `      <li><a href="#board-${escapeHtml(board.id)}">${i + 1}. ${escapeHtml(board.name)}</a></li>`,
    )
    .join('\n');
  const sections = data.boards
    .map((board, i) => {
      const threads = data.threads.filter((t) => t.boardId === board.id);
      const body =
        threads.length === 0
          ? '    <p class="empty">No threads yet. Be the first to post.</p>'
          : threads.map((t) => renderThread(t, data.postMeta)).join('\n');
      return [
        `  <section id="board-${escapeHtml(board.id)}" aria-labelledby="board-h-${escapeHtml(board.id)}">`,
        `    <h2 id="board-h-${escapeHtml(board.id)}">${i + 1}. ${escapeHtml(board.name)}</h2>`,
        `    <p class="board-desc">${escapeHtml(board.description)}</p>`,
        body,
        '  </section>',
      ].join('\n');
    })
    .join('\n');
  const threadCount = data.threads.length;
  const postCount = data.threads.reduce((n, t) => n + t.posts.length, 0);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeadLine BBS &mdash; Public Archive</title>
  <meta name="description" content="Every public message on this DeadLine BBS node, readable without calling in.">
  <style>
    :root {
      --phosphor: #ffb000;
      --phosphor-dim: #9c7c33;
      --phosphor-faint: #5c4a22;
      --crt-bg: #0d0a04;
      --bezel: #050403;
      --bezel-edge: #2a1f0d;
      --ink: #e8dcc0;
    }
    * { box-sizing: border-box; }
    html { background: var(--bezel); }
    body {
      margin: 0 auto;
      max-width: 76ch;
      padding: 24px 16px 48px;
      background: var(--crt-bg);
      color: var(--ink);
      font-family: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
      font-size: 15px;
      line-height: 1.6;
    }
    a { color: var(--phosphor); }
    a:focus-visible { outline: 2px solid var(--phosphor); outline-offset: 2px; }
    .skip {
      position: absolute;
      left: -9999px;
      top: 0;
      background: var(--phosphor);
      color: var(--bezel);
      padding: 8px 14px;
      z-index: 1;
    }
    .skip:focus { left: 8px; top: 8px; }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--phosphor);
      letter-spacing: 0.14em;
      font-size: 13px;
      font-weight: 700;
    }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.25; color: var(--phosphor); }
    header p { margin: 0 0 8px; }
    .counts { color: var(--phosphor-dim); }
    nav { border-top: 1px solid var(--bezel-edge); border-bottom: 1px solid var(--bezel-edge); margin: 20px 0 0; padding: 10px 0; }
    nav ul { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px 20px; }
    section { margin-top: 28px; }
    h2 { margin: 0 0 4px; font-size: 20px; color: var(--phosphor); }
    .board-desc { margin: 0 0 16px; color: var(--phosphor-dim); }
    article { border-top: 1px solid var(--bezel-edge); padding: 14px 0 4px; }
    h3 { margin: 0 0 2px; font-size: 16px; }
    .thread-meta { margin: 0 0 12px; color: var(--phosphor-dim); font-size: 13px; }
    .post { margin: 0 0 16px; }
    .post-meta { margin: 0 0 4px; font-size: 13px; color: var(--phosphor-dim); }
    .post-meta strong { color: var(--ink); }
    .marker { color: var(--phosphor); }
    .post-body { white-space: pre-wrap; overflow-wrap: break-word; }
    .empty { color: var(--phosphor-dim); }
    footer { border-top: 1px solid var(--bezel-edge); margin-top: 32px; padding-top: 12px; color: var(--phosphor-dim); font-size: 13px; }
  </style>
</head>
<body>
  <a class="skip" href="#boards">Skip to boards</a>
  <header>
    <p class="eyebrow">DEADLINE BBS &middot; PUBLIC ARCHIVE</p>
    <h1>The boards, printed.</h1>
    <p>Every public message on this node, readable without calling in. To post, call the BBS live: <a href="/">open the terminal</a>.</p>
    <p class="counts">${threadCount} ${threadCount === 1 ? 'thread' : 'threads'} &middot; ${postCount} ${postCount === 1 ? 'message' : 'messages'} &middot; snapshot ${escapeHtml(generatedAt)}</p>
  </header>
  <nav aria-label="Boards">
    <ul>
${nav}
    </ul>
  </nav>
  <main id="boards">
${sections}
  </main>
  <footer>
    <p>Node: ${escapeHtml(nodeId)} &middot; Generated from the live board &middot; <a href="/">Call the BBS live</a></p>
  </footer>
</body>
</html>
`;
}

export function createArchiveHandler(deps: ArchiveHandlerDeps): ArchiveHandler {
  return async (req, res): Promise<boolean> => {
    const data = await deps.boards.readData();
    const body = renderArchivePage(
      data,
      deps.nodeId,
      // Second precision: a printout timestamp, no millisecond noise.
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
