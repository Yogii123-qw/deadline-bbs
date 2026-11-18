/**
 * src/server/main.ts — Server bootstrap (builder-written, per design §2.19).
 *
 * Loads environment, creates the stores, starts the telnet listener and the
 * HTTP + WebSocket server, and logs startup info. Never crashes on a single
 * bad connection: transport errors are contained per connection, and
 * unhandled rejections are logged, not fatal.
 */

import * as path from 'node:path';
import type { ActiveSession } from '../shared/types.js';
import {
  zBoardsStore,
  zScoresStore,
  zUsersStore,
  type BoardsData,
  type ScoresData,
  type UsersData,
} from '../shared/validation.js';
import { AtomicStore } from '../boards/store.js';
import { BoardStore } from '../boards/boards.js';
import { seedBoardsData } from '../boards/seeds.js';
import { UserStore } from '../users/users.js';
import { ScoreStore } from '../game/scores.js';
import type { EngineDeps } from '../session/engine.js';
import { LiveHub } from './live.js';
import { startTelnetServer } from './telnet.js';
import { startHttpServer } from './http.js';
import { createWsBridge } from './ws-bridge.js';
import { zSyncLogData, type SyncLogData } from '../sync/entries.js';
import { EMPTY_SYNC_LOG, SyncLogStore } from '../sync/store.js';
import { SyncEngine } from '../sync/engine.js';
import { createApiHandler } from '../sync/api.js';
import { createArchiveHandler } from './archive.js';

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`Invalid ${name}: ${value}. Must be a port number 1-65535.`);
    process.exit(1);
  }
  return n;
}

function parseIntervalMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`Invalid SYNC_INTERVAL_MS: ${value}. Must be an integer >= 0 (0 disables the timer).`);
    process.exit(1);
  }
  return n;
}

/** Parse DEADLINE_PEERS: comma-separated http(s) base URLs, no trailing slash. */
function parsePeers(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  const peers: string[] = [];
  for (const raw of value.split(',')) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      console.error(`Invalid DEADLINE_PEERS entry: ${trimmed}. Must be an http(s) URL.`);
      process.exit(1);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.error(`Invalid DEADLINE_PEERS entry: ${trimmed}. Must be an http(s) URL.`);
      process.exit(1);
    }
    const normalized = parsed.toString();
    peers.push(normalized.endsWith('/') ? normalized.slice(0, -1) : normalized);
  }
  return peers;
}

async function main(): Promise<void> {
  const httpPort = parsePort(process.env['HTTP_PORT'], 8080, 'HTTP_PORT');
  const telnetPort = parsePort(process.env['TELNET_PORT'], 2323, 'TELNET_PORT');
  const dataDir = path.resolve(process.env['DATA_DIR'] ?? 'data');
  const filesDir = path.resolve(process.env['FILES_DIR'] ?? 'files');
  const publicDir = path.resolve(process.env['PUBLIC_DIR'] ?? 'dist/public');
  const peers = parsePeers(process.env['DEADLINE_PEERS']);
  const syncSecret = process.env['SYNC_SECRET'] === '' ? undefined : process.env['SYNC_SECRET'];
  const syncIntervalMs = parseIntervalMs(process.env['SYNC_INTERVAL_MS'], 60000);

  const onLog = (message: string): void => {
    console.log(`[${new Date().toISOString()}] ${message}`);
  };
  const onWarning = (message: string): void => {
    console.warn(`[${new Date().toISOString()}] ${message}`);
  };

  const users = new UserStore(
    new AtomicStore<UsersData>(path.join(dataDir, 'users.json'), zUsersStore, { users: [] }, onWarning),
  );
  const boards = new BoardStore(
    new AtomicStore<BoardsData>(
      path.join(dataDir, 'boards.json'),
      zBoardsStore,
      seedBoardsData(),
      onWarning,
    ),
  );
  const scores = new ScoreStore(
    new AtomicStore<ScoresData>(path.join(dataDir, 'scores.json'), zScoresStore, { entries: [], network: [] }, onWarning),
  );

  const live = new LiveHub(onLog);
  const syncLog = new SyncLogStore(
    new AtomicStore<SyncLogData>(path.join(dataDir, 'sync.json'), zSyncLogData, EMPTY_SYNC_LOG, onWarning),
    onLog,
  );
  const nodeId = await syncLog.init(process.env['DEADLINE_NODE_ID']);
  const syncEngine = new SyncEngine({
    boards,
    syncLog,
    nodeId,
    peers,
    secret: syncSecret,
    intervalMs: syncIntervalMs,
    hub: live,
    scores,
    onLog,
  });
  // Push on post: a local post triggers a sync round right away instead of
  // waiting for the periodic timer. The log itself is the queue — if a
  // peer is offline, the next successful round delivers everything.
  syncLog.onLocalAppend = () => {
    void syncEngine.syncAll();
  };

  const deps: EngineDeps = {
    users,
    boards,
    scores,
    filesDir,
    httpPort,
    activeSessions: new Map<string, ActiveSession>(),
    now: () => new Date(),
    rng: () => Math.random(),
    onLog,
    live,
    syncLog,
    syncStats: () => syncEngine.getStats(),
  };

  const apiHandler = createApiHandler({
    boards,
    syncLog,
    syncEngine,
    hub: live,
    nodeId,
    secret: syncSecret,
    peerCount: peers.length,
    onLog,
  });

  const wss = createWsBridge(deps);
  const httpServer = await startHttpServer({
    port: httpPort,
    publicDir,
    filesDir,
    onUpgrade: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
    onLog,
    onApi: apiHandler,
    onArchive: createArchiveHandler({ boards, nodeId }),
  });
  const telnetServer = await startTelnetServer({ port: telnetPort, deps, onLog });
  syncEngine.start();

  console.log('');
  console.log('DeadLine BBS is answering.');
  console.log(`  Web terminal: http://localhost:${httpServer.port}/`);
  console.log(`  Telnet:       telnet localhost ${telnetServer.port}`);
  console.log(`  Data:         ${dataDir}`);
  console.log(`  Files:        ${filesDir}`);
  console.log(`  Node id:      ${nodeId}`);
  console.log(`  Peers:        ${peers.length === 0 ? 'none (standalone)' : peers.join(', ')}`);
  if (syncSecret === undefined) {
    console.warn('  WARNING: SYNC_SECRET is not set — the /sync/exchange endpoint is OPEN. Use only on trusted/demo networks.');
  } else {
    console.log('  Sync secret:  set');
  }
  console.log('');

  process.on('unhandledRejection', (reason: unknown) => {
    onLog(`Unhandled rejection (server keeps running): ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      syncEngine.stop();
      await telnetServer.close();
      await httpServer.close();
      wss.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err: unknown) => {
  console.error(`Fatal startup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
