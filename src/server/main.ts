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
import { startTelnetServer } from './telnet.js';
import { startHttpServer } from './http.js';
import { createWsBridge } from './ws-bridge.js';

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`Invalid ${name}: ${value}. Must be a port number 1-65535.`);
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  const httpPort = parsePort(process.env['HTTP_PORT'], 8080, 'HTTP_PORT');
  const telnetPort = parsePort(process.env['TELNET_PORT'], 2323, 'TELNET_PORT');
  const dataDir = path.resolve(process.env['DATA_DIR'] ?? 'data');
  const filesDir = path.resolve(process.env['FILES_DIR'] ?? 'files');
  const publicDir = path.resolve(process.env['PUBLIC_DIR'] ?? 'dist/public');

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
    new AtomicStore<ScoresData>(path.join(dataDir, 'scores.json'), zScoresStore, { entries: [] }, onWarning),
  );

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
  };

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
  });
  const telnetServer = await startTelnetServer({ port: telnetPort, deps, onLog });

  console.log('');
  console.log('DeadLine BBS is answering.');
  console.log(`  Web terminal: http://localhost:${httpServer.port}/`);
  console.log(`  Telnet:       telnet localhost ${telnetServer.port}`);
  console.log(`  Data:         ${dataDir}`);
  console.log(`  Files:        ${filesDir}`);
  console.log('');

  process.on('unhandledRejection', (reason: unknown) => {
    onLog(`Unhandled rejection (server keeps running): ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
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
