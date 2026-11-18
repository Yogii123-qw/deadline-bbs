/**
 * tests/helpers.ts — Shared test environment (real stores, real files, no mocks).
 *
 * Every test gets a fresh temp directory with real AtomicStores on disk, a
 * mutable clock, and a configurable RNG. Nothing is stubbed: the engine,
 * stores, and transports under test are the production modules.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AtomicStore } from '../src/boards/store.js';
import { BoardStore } from '../src/boards/boards.js';
import { seedBoardsData } from '../src/boards/seeds.js';
import { UserStore } from '../src/users/users.js';
import { ScoreStore } from '../src/game/scores.js';
import {
  zBoardsStore,
  zScoresStore,
  zUsersStore,
  type BoardsData,
  type ScoresData,
  type UsersData,
} from '../src/shared/validation.js';
import type { ActiveSession, SessionState } from '../src/shared/types.js';
import {
  newSession,
  processInput,
  type EngineDeps,
} from '../src/session/engine.js';
import { stripAnsi } from '../src/telnet/ansi.js';

export interface TestEnv {
  deps: EngineDeps;
  root: string;
  dataDir: string;
  filesDir: string;
  warnings: string[];
  logs: string[];
  setNow: (date: Date) => void;
  setRng: (fn: () => number) => void;
  cleanup: () => Promise<void>;
}

export async function createTestEnv(
  files?: Record<string, string>,
  reuse?: { root: string; dataDir: string; filesDir: string },
): Promise<TestEnv> {
  const root = reuse?.root ?? (await mkdtemp(path.join(tmpdir(), 'deadline-test-')));
  const dataDir = reuse?.dataDir ?? path.join(root, 'data');
  const filesDir = reuse?.filesDir ?? path.join(root, 'files');
  await mkdir(dataDir, { recursive: true });
  await mkdir(filesDir, { recursive: true });
  for (const [name, content] of Object.entries(files ?? {})) {
    const target = path.join(filesDir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  const warnings: string[] = [];
  const logs: string[] = [];
  let current = new Date('2026-11-19T12:00:00.000Z');
  let rngFn: () => number = () => 0.5;

  const deps: EngineDeps = {
    users: new UserStore(
      new AtomicStore<UsersData>(
        path.join(dataDir, 'users.json'),
        zUsersStore,
        { users: [] },
        (m) => warnings.push(m),
      ),
    ),
    boards: new BoardStore(
      new AtomicStore<BoardsData>(
        path.join(dataDir, 'boards.json'),
        zBoardsStore,
        seedBoardsData(),
        (m) => warnings.push(m),
      ),
    ),
    scores: new ScoreStore(
      new AtomicStore<ScoresData>(
        path.join(dataDir, 'scores.json'),
        zScoresStore,
        { entries: [], network: [] },
        (m) => warnings.push(m),
      ),
    ),
    filesDir,
    httpPort: 18080,
    activeSessions: new Map<string, ActiveSession>(),
    now: () => new Date(current),
    rng: () => rngFn(),
    onLog: (m) => logs.push(m),
  };

  return {
    deps,
    root,
    dataDir,
    filesDir,
    warnings,
    logs,
    setNow: (date: Date) => {
      current = date;
    },
    setRng: (fn: () => number) => {
      rngFn = fn;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Drives the engine like a connected client: send lines, get output. */
export class SessionDriver {
  public state: SessionState;
  private readonly deps: EngineDeps;

  public constructor(deps: EngineDeps, transport: 'telnet' | 'websocket' = 'telnet') {
    this.deps = deps;
    this.state = newSession(transport, deps.now());
  }

  /** Send one line; returns raw output (with ANSI). */
  public async send(input: string): Promise<string> {
    const out = await processInput({ state: this.state, input, deps: this.deps });
    this.state = out.state;
    return out.output;
  }

  /** Send one line; returns output with ANSI stripped (for assertions). */
  public async sendText(input: string): Promise<string> {
    return stripAnsi(await this.send(input));
  }

  /** Register a fresh handle and land on the main menu. */
  public async register(handle: string, passcode: string): Promise<string> {
    await this.send('');
    await this.send(handle);
    await this.send(passcode);
    return this.sendText(passcode);
  }

  /** Log in as an existing user and land on the main menu. */
  public async login(handle: string, passcode: string): Promise<string> {
    await this.send('');
    await this.send(handle);
    return this.sendText(passcode);
  }
}
