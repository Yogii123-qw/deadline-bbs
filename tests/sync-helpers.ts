/**
 * tests/sync-helpers.ts — Shared live + federation test setup (real stores,
 * real servers, nothing stubbed). Attaches a LiveHub and SyncLogStore to a
 * TestEnv, and boots whole nodes (telnet + HTTP/WS + sync API) on port 0.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AtomicStore } from '../src/boards/store.js';
import { LiveHub } from '../src/server/live.js';
import { startHttpServer } from '../src/server/http.js';
import { startTelnetServer, type RunningServer } from '../src/server/telnet.js';
import { createWsBridge } from '../src/server/ws-bridge.js';
import { createApiHandler } from '../src/sync/api.js';
import { createArchiveHandler } from '../src/server/archive.js';
import { SyncEngine } from '../src/sync/engine.js';
import { zSyncLogData, type SyncLogData } from '../src/sync/entries.js';
import { EMPTY_SYNC_LOG, SyncLogStore } from '../src/sync/store.js';
import { createTestEnv, type TestEnv } from './helpers.js';

export interface AttachedSync {
  hub: LiveHub;
  syncLog: SyncLogStore;
  engine: SyncEngine;
  nodeId: string;
}

export async function attachSync(
  env: TestEnv,
  nodeId: string,
  opts?: { peers?: string[]; secret?: string; intervalMs?: number },
): Promise<AttachedSync> {
  const hub = new LiveHub((m) => env.logs.push(m));
  const syncLog = new SyncLogStore(
    new AtomicStore<SyncLogData>(
      path.join(env.dataDir, 'sync.json'),
      zSyncLogData,
      EMPTY_SYNC_LOG,
      (m) => env.warnings.push(m),
    ),
    (m) => env.logs.push(m),
  );
  const resolved = await syncLog.init(nodeId);
  const engine = new SyncEngine({
    boards: env.deps.boards,
    syncLog,
    nodeId: resolved,
    peers: opts?.peers ?? [],
    secret: opts?.secret,
    intervalMs: opts?.intervalMs ?? 0,
    hub,
    scores: env.deps.scores,
    onLog: (m) => env.logs.push(m),
  });
  syncLog.onLocalAppend = () => {
    void engine.syncAll();
  };
  env.deps.live = hub;
  env.deps.syncLog = syncLog;
  env.deps.syncStats = () => engine.getStats();
  return { hub, syncLog, engine, nodeId: resolved };
}

export interface BootedNode extends AttachedSync {
  env: TestEnv;
  telnet: RunningServer;
  http: RunningServer;
  baseUrl: string;
  telnetPort: number;
  httpPort: number;
  /** Stop servers + engine only (data dir survives for restart tests). */
  stopServers: () => Promise<void>;
  /** Stop everything and delete the temp dirs. */
  stop: () => Promise<void>;
}

export async function bootNode(opts: {
  nodeId: string;
  peers?: string[];
  secret?: string;
  intervalMs?: number;
  autoStart?: boolean;
  reuse?: { root: string; dataDir: string; filesDir: string };
}): Promise<BootedNode> {
  const env = await createTestEnv(undefined, opts.reuse);
  const attached = await attachSync(env, opts.nodeId, {
    peers: opts.peers,
    secret: opts.secret,
    intervalMs: opts.intervalMs,
  });
  const webRoot = await mkdtemp(path.join(tmpdir(), 'deadline-web-'));
  const publicDir = path.join(webRoot, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<html>deadline</html>', 'utf8');

  const wss = createWsBridge(env.deps);
  const apiHandler = createApiHandler({
    boards: env.deps.boards,
    syncLog: attached.syncLog,
    syncEngine: attached.engine,
    hub: attached.hub,
    nodeId: attached.nodeId,
    secret: opts.secret,
    peerCount: (opts.peers ?? []).length,
    onLog: (m) => env.logs.push(m),
  });
  const http = await startHttpServer({
    port: 0,
    publicDir,
    filesDir: env.filesDir,
    onUpgrade: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
    onApi: apiHandler,
    onArchive: createArchiveHandler({ boards: env.deps.boards, nodeId: attached.nodeId }),
  });
  const telnet = await startTelnetServer({ port: 0, deps: env.deps });
  if (opts.autoStart === true) attached.engine.start();

  const stopServers = async (): Promise<void> => {
    attached.engine.stop();
    await telnet.close();
    await http.close();
  };
  const stop = async (): Promise<void> => {
    await stopServers();
    await env.cleanup();
    await rm(webRoot, { recursive: true, force: true });
  };
  return {
    ...attached,
    env,
    telnet,
    http,
    baseUrl: `http://127.0.0.1:${http.port}`,
    telnetPort: telnet.port,
    httpPort: http.port,
    stopServers,
    stop,
  };
}
