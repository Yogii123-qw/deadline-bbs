/**
 * tests/unit/node-status.test.ts — NODE STATUS screen data (PRO-DEV):
 * the values shown come from the sync engine's real state, never from
 * static text, and peer URLs never leak onto the screen.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SessionDriver, createTestEnv, type TestEnv } from '../helpers.js';
import { attachSync, type AttachedSync } from '../sync-helpers.js';
import { nodeStatusScreen } from '../../src/session/screens.js';
import type { NodeStatusData } from '../../src/sync/engine.js';
import { stripAnsi } from '../../src/telnet/ansi.js';

let env: TestEnv;

afterEach(async () => {
  await env?.cleanup();
});

function stats(overrides: Partial<NodeStatusData> = {}): NodeStatusData {
  return {
    nodeId: 'node-a',
    peerCount: 2,
    entryCount: 7,
    pendingCount: 1,
    lastRoundAt: '2026-11-19T10:30:00.000Z',
    secretSet: true,
    peers: [
      { lastRoundAt: '2026-11-19T10:30:00.000Z', applied: 3, duplicates: 1, skipped: 0, lastError: null },
      { lastRoundAt: null, applied: 0, duplicates: 0, skipped: 0, lastError: null },
    ],
    ...overrides,
  };
}

describe('SyncEngine.getStats', () => {
  it('reports the log counts, node id, and secret state', async () => {
    env = await createTestEnv();
    const sync: AttachedSync = await attachSync(env, 'node-status-1', { secret: 'hunter2' });
    const before = await sync.engine.getStats();
    expect(before).toMatchObject({
      nodeId: 'node-status-1',
      peerCount: 0,
      entryCount: 0,
      pendingCount: 0,
      lastRoundAt: null,
      secretSet: true,
    });
    await sync.syncLog.appendLocal('thread', {
      id: 't1',
      boardId: 'general',
      subject: 'S',
      authorHandle: 'Alice',
      createdAt: '2026-11-19T10:00:00.000Z',
      posts: [],
    }, '2026-11-19T10:00:00.000Z');
    const after = await sync.engine.getStats();
    expect(after.entryCount).toBe(1);
  });

  it('reports OPEN when no secret is configured', async () => {
    env = await createTestEnv();
    const sync = await attachSync(env, 'node-status-2');
    expect((await sync.engine.getStats()).secretSet).toBe(false);
  });

  it('counts pending entries from the log', async () => {
    env = await createTestEnv();
    const sync = await attachSync(env, 'node-status-3');
    await sync.engine.applyRemote([
      {
        id: 'node-x:edit-1',
        origin: 'node-x',
        seq: 1,
        kind: 'edit',
        at: '2026-11-19T10:00:00.000Z',
        edit: {
          postId: 'missing-post',
          threadId: 'missing-thread',
          boardId: 'general',
          authorHandle: 'Alice',
          subject: 'Nope',
          body: 'nope',
        },
      },
    ]);
    expect((await sync.engine.getStats()).pendingCount).toBe(1);
  });

  it('records failed rounds per peer with the error kept', async () => {
    env = await createTestEnv();
    const sync = await attachSync(env, 'node-status-4', { peers: ['http://127.0.0.1:1'] });
    await sync.engine.syncWith('http://127.0.0.1:1');
    const data = await sync.engine.getStats();
    expect(data.lastRoundAt).not.toBeNull();
    expect(data.peers).toHaveLength(1);
    expect(data.peers[0].lastRoundAt).not.toBeNull();
    expect(data.peers[0].lastError).toBeTruthy();
    // The peer URL itself is not part of the stats shape.
    expect(JSON.stringify(data)).not.toContain('127.0.0.1');
  });
});

describe('nodeStatusScreen', () => {
  it('shows every stat value from the engine', () => {
    const plain = stripAnsi(nodeStatusScreen(stats()));
    expect(plain).toContain('Node: node-a');
    expect(plain).toContain('Peers: 2');
    expect(plain).toContain('Sync log: 7 entries · 1 pending');
    expect(plain).toContain('Last sync round: 2026-11-19 10:30:00');
    expect(plain).toContain('Sync secret: SET');
    expect(plain).toContain('Peer 1: last round 2026-11-19 10:30:00 · applied 3 · duplicates 1 · skipped 0');
    expect(plain).toContain('Peer 2: never contacted');
  });

  it('warns when the secret is OPEN and shows failures', () => {
    const plain = stripAnsi(
      nodeStatusScreen(
        stats({
          secretSet: false,
          peers: [
            { lastRoundAt: '2026-11-19T10:30:00.000Z', applied: 0, duplicates: 0, skipped: 0, lastError: 'HTTP 401' },
          ],
          peerCount: 1,
        }),
      ),
    );
    expect(plain).toContain('Sync secret: OPEN');
    expect(plain).toContain('Peer 1: last round 2026-11-19 10:30:00 · FAILED: HTTP 401');
  });

  it('handles a standalone node with no rounds yet', () => {
    const plain = stripAnsi(
      nodeStatusScreen(stats({ peerCount: 0, entryCount: 0, pendingCount: 0, lastRoundAt: null, peers: [] })),
    );
    expect(plain).toContain('Last sync round: never');
    expect(plain).toContain('No peers configured. This node stands alone.');
  });

  it('never contains a peer URL', () => {
    const plain = stripAnsi(nodeStatusScreen(stats()));
    expect(plain).not.toMatch(/https?:\/\//);
  });
});

describe('NODE STATUS menu command', () => {
  it('shows live stats from the engine, then the menu', async () => {
    env = await createTestEnv();
    await attachSync(env, 'node-menu-1');
    const driver = new SessionDriver(env.deps);
    await driver.register('Deadknight', 'pass1234');
    const out = await driver.sendText('7');
    expect(out).toContain('NODE STATUS');
    expect(out).toContain('Node: node-menu-1');
    expect(out).toContain('MAIN MENU');
    expect(driver.state.phase).toBe('MAIN_MENU');
  });

  it('errors cleanly when federation is not wired', async () => {
    env = await createTestEnv();
    const driver = new SessionDriver(env.deps);
    await driver.register('Deadknight', 'pass1234');
    const out = await driver.sendText('7');
    expect(out).toContain('Node status is not available right now.');
    expect(out).toContain('MAIN MENU');
  });
});
