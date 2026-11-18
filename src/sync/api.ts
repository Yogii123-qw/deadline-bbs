/**
 * src/sync/api.ts — Sync endpoint, read-only JSON API, public SSE stream
 * (builder-written, FEDERATION amendment).
 *
 * The handler answers for /sync/exchange and /api/* and returns false for
 * anything else, so the HTTP server falls through to static serving.
 *
 * Reads need no authentication: board data is public by design (any caller
 * sees the same data in the terminal). The sync endpoint is protected by
 * SYNC_SECRET when set — and openly unprotected when it is not (the README
 * discloses this; the trust model is "trusted/demo networks" without a
 * secret). Secrets are compared constant-time on SHA-256 hashes, so
 * differing lengths leak nothing.
 *
 * The public SSE stream carries live post/edit/victory/join/leave events
 * only. Chat messages NEVER enter it: a direct message stays between two
 * callers on one node.
 */

import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';
import type { BoardStore } from '../boards/boards.js';
import type { Post, Thread } from '../shared/types.js';
import { ValidationError } from '../shared/errors.js';
import { type LiveEvent, type LiveHub } from '../server/live.js';
import { MAX_SYNC_BODY_BYTES, zSyncExchangeRequest } from './entries.js';
import type { SyncEngine } from './engine.js';
import type { SyncLogStore } from './store.js';

export interface ApiHandlerDeps {
  boards: BoardStore;
  syncLog: SyncLogStore;
  syncEngine: SyncEngine;
  hub?: LiveHub;
  nodeId: string;
  secret?: string;
  peerCount: number;
  onLog: (message: string) => void;
}

export type ApiHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<boolean>;

const SSE_HEARTBEAT_MS = 30000;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Constant-time secret comparison via hashed digests (length-safe). */
export function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Attach `editedAt` to edited posts (a JSON superset of the Post shape —
 * the field is additive, so old clients keep working). Tombstoned posts
 * never reach here: listThreads/getThread already filter them.
 */
async function withEditedMarkers(
  boards: BoardStore,
  threads: Thread[],
): Promise<Array<Thread & { posts: Array<Post & { editedAt?: string }> }>> {
  const data = await boards.readData();
  return threads.map((thread) => ({
    ...thread,
    posts: thread.posts.map((post) => {
      const meta = data.postMeta[post.id];
      return meta === undefined ? post : { ...post, editedAt: meta.editedAt };
    }),
  }));
}

class BodyTooLargeError extends Error {}

async function readBody(req: http.IncomingMessage, capBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > capBytes) {
      throw new BodyTooLargeError(`Request body exceeds ${capBytes} bytes.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function createApiHandler(deps: ApiHandlerDeps): ApiHandler {
  const handleExchange = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }
    if (deps.secret !== undefined) {
      const rawSecret = req.headers['x-sync-secret'];
      // A repeated header is ambiguous: fail closed.
      const provided = typeof rawSecret === 'string' ? rawSecret : undefined;
      if (!secretsMatch(provided, deps.secret)) {
        sendJson(res, 401, { error: 'Unauthorized.' });
        return;
      }
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_SYNC_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: 'Request body too large.' });
        return;
      }
      throw err;
    }
    let data: unknown;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'Request body must be JSON.' });
      return;
    }
    const parsed = zSyncExchangeRequest.safeParse(data);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Invalid exchange request.' });
      return;
    }
    await deps.syncEngine.applyRemote(parsed.data.entries);
    const log = await deps.syncLog.read();
    sendJson(res, 200, {
      nodeId: deps.nodeId,
      entries: [...log.entries, ...log.pending],
    });
  };

  const handleEvents = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const id = `sse:${randomUUID()}`;
    const deliver = (event: LiveEvent): void => {
      // Direct messages never leave the node on a public stream.
      if (event.kind === 'chat') return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    deps.hub?.subscribe(id, deliver);
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      deps.hub?.unsubscribe(id);
    });
  };

  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/sync/exchange') {
      await handleExchange(req, res);
      return true;
    }
    if (!pathname.startsWith('/api/')) {
      return false;
    }
    if (pathname === '/api/events') {
      handleEvents(req, res);
      return true;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }

    if (pathname === '/api/boards') {
      const boards = await deps.boards.listBoards();
      sendJson(res, 200, { boards });
      return true;
    }
    const boardThreads = /^\/api\/boards\/([^/]+)\/threads$/.exec(pathname);
    if (boardThreads !== null) {
      const boardId = decodeURIComponent(boardThreads[1]);
      try {
        const board = await deps.boards.getBoard(boardId);
        const threads = await deps.boards.listThreads(boardId);
        sendJson(res, 200, { board, threads: await withEditedMarkers(deps.boards, threads) });
      } catch (err) {
        if (err instanceof ValidationError) {
          sendJson(res, 404, { error: 'Board not found.' });
        } else {
          throw err;
        }
      }
      return true;
    }
    const threadMatch = /^\/api\/threads\/([^/]+)$/.exec(pathname);
    if (threadMatch !== null) {
      const threadId = decodeURIComponent(threadMatch[1]);
      try {
        const thread = await deps.boards.getThread(threadId);
        const [marked] = await withEditedMarkers(deps.boards, [thread]);
        sendJson(res, 200, { thread: marked });
      } catch (err) {
        if (err instanceof ValidationError) {
          sendJson(res, 404, { error: 'Thread not found.' });
        } else {
          throw err;
        }
      }
      return true;
    }
    if (pathname === '/api/status') {
      const data = await deps.boards.readData();
      const posts = data.threads.reduce((n, t) => n + t.posts.length, 0);
      sendJson(res, 200, {
        nodeId: deps.nodeId,
        boards: data.boards.length,
        threads: data.threads.length,
        posts,
        peers: deps.peerCount,
      });
      return true;
    }
    sendJson(res, 404, { error: 'Not found.' });
    return true;
  };
}
