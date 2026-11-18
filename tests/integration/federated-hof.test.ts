/**
 * tests/integration/federated-hof.test.ts — Federated Hall of Fame over
 * real HTTP (PRO-DEV): victories won on one booted node appear on the
 * other node's Hall of Fame with their origin node, through the same
 * sync log as posts. No mocks anywhere in this file.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SessionDriver } from '../helpers.js';
import { bootNode, type BootedNode } from '../sync-helpers.js';
import { newCharacter } from '../../src/game/catacomb.js';
import { todayLocal } from '../../src/session/engine.js';

const nodes: BootedNode[] = [];

afterEach(async () => {
  for (const n of nodes.splice(0)) {
    await n.stop();
  }
});

async function boot(opts: Parameters<typeof bootNode>[0]): Promise<BootedNode> {
  const node = await bootNode(opts);
  nodes.push(node);
  return node;
}

/** Win CATACOMB on a booted node with a rigged strong character. */
async function winOn(node: BootedNode, handle: string): Promise<number> {
  node.env.setRng(() => 0.5);
  const user = await node.env.deps.users.createUser(handle, 'pass1234', new Date());
  const today = todayLocal(node.env.deps.now());
  const strong = {
    ...newCharacter(user.id, today),
    hp: 100,
    maxHp: 100,
    attack: 30,
    defense: 10,
    level: 5,
    dungeonDepth: 5,
  };
  await node.env.deps.users.saveCharacter(user.id, strong);
  const d = new SessionDriver(node.env.deps);
  await d.login(handle, 'pass1234');
  await d.send('3');
  await d.send('E');
  await d.send('A');
  const victory = await d.sendText('A');
  expect(victory).toContain('VICTORY');
  const fame = await node.env.deps.scores.getHallOfFame();
  expect(fame).toHaveLength(1);
  return fame[0].level;
}

async function hallOfFameText(node: BootedNode, handle: string): Promise<string> {
  const d = new SessionDriver(node.env.deps);
  await d.login(handle, 'pass1234');
  return d.sendText('4');
}

describe('federated Hall of Fame over real HTTP (PRO-DEV)', () => {
  it('shows a victory won on A in B\u2019s network section, with attribution', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    const level = await winOn(a, 'Alice');
    await a.engine.syncWith(b.baseUrl);

    const network = await b.env.deps.scores.getNetworkScores();
    expect(network).toHaveLength(1);
    expect(network[0]).toMatchObject({ handle: 'Alice', level, originNode: 'node-a' });
    // B's own Hall of Fame is still empty: the score is network-only.
    expect(await b.env.deps.scores.getHallOfFame()).toHaveLength(0);

    // A caller on B sees both sections in the terminal.
    await b.env.deps.users.createUser('Bob', 'pass1234', new Date());
    const text = await hallOfFameText(b, 'Bob');
    expect(text).toContain('THE NETWORK');
    expect(text).toContain('Alice');
    expect(text).toContain(`level ${level}`);
    expect(text).toContain('node node-a');
  });

  it('shows both sections when each node has its own victory', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    await winOn(a, 'Alice');
    await winOn(b, 'Bob');
    await a.engine.syncWith(b.baseUrl);
    await b.engine.syncWith(a.baseUrl);

    const textA = await hallOfFameText(a, 'Alice');
    expect(textA).toContain('THIS NODE');
    expect(textA).toContain('Alice');
    expect(textA).toContain('THE NETWORK');
    expect(textA).toContain('Bob');
    expect(textA).toContain('node node-b');

    const textB = await hallOfFameText(b, 'Bob');
    expect(textB).toContain('THIS NODE');
    expect(textB).toContain('Bob');
    expect(textB).toContain('THE NETWORK');
    expect(textB).toContain('Alice');
    expect(textB).toContain('node node-a');
  });

  it('never duplicates a score across repeated rounds', async () => {
    const a = await boot({ nodeId: 'node-a' });
    const b = await boot({ nodeId: 'node-b' });
    await winOn(a, 'Alice');
    await a.engine.syncWith(b.baseUrl);
    await a.engine.syncWith(b.baseUrl);
    await b.engine.syncWith(a.baseUrl);
    expect(await b.env.deps.scores.getNetworkScores()).toHaveLength(1);
    expect(await a.env.deps.scores.getNetworkScores()).toHaveLength(0);
  });
});
