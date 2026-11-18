import { afterEach, describe, expect, it } from 'vitest';
import { newCharacter } from '../../src/game/catacomb.js';
import { todayLocal } from '../../src/session/engine.js';
import type { LiveEvent } from '../../src/server/live.js';
import { createTestEnv, SessionDriver, type TestEnv } from '../helpers.js';
import { attachSync, type AttachedSync } from '../sync-helpers.js';

let env: TestEnv;

afterEach(async () => {
  await env?.cleanup();
});

async function setup(nodeId = 'node-test'): Promise<{ sync: AttachedSync; seen: LiveEvent[] }> {
  env = await createTestEnv();
  const sync = await attachSync(env, nodeId);
  const seen: LiveEvent[] = [];
  sync.hub.subscribe('collector', (e) => seen.push(e));
  return { sync, seen };
}

/** Post a thread as a logged-in driver; returns when the thread is posted. */
async function postThread(d: SessionDriver, subject: string, body: string): Promise<void> {
  await d.send('1');
  await d.send('1');
  await d.send('N');
  await d.send(subject);
  await d.send(body);
  const out = await d.sendText('.');
  expect(out).toContain('Thread posted.');
}

describe('engine: live events', () => {
  it('publishes join events on registration and login', async () => {
    const { seen } = await setup();
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'join', handle: 'Alice', transport: 'telnet' });
    const b = new SessionDriver(env.deps, 'websocket');
    await b.register('Bob', 'pass1234');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ kind: 'join', handle: 'Bob', transport: 'websocket' });
    // A second login for an existing user also joins.
    const c = new SessionDriver(env.deps);
    await c.login('Alice', 'pass1234');
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ kind: 'join', handle: 'Alice' });
  });

  it('publishes post events for threads and replies', async () => {
    const { seen } = await setup();
    const board = await env.deps.boards.getBoard('general');
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    const b = new SessionDriver(env.deps);
    await b.register('Bob', 'pass1234');
    seen.length = 0;
    await postThread(a, 'Live Subject', 'live body');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'post',
      handle: 'Alice',
      boardName: board.name,
      subject: 'Live Subject',
      isReply: false,
    });
    expect((seen[0] as { originNode?: string }).originNode).toBeUndefined();
    // Bob replies to Alice's thread.
    await b.send('1');
    await b.send('1');
    await b.send('1');
    await b.send('R');
    await b.send('reply body here');
    const out = await b.sendText('.');
    expect(out).toContain('Reply posted.');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      kind: 'post',
      handle: 'Bob',
      subject: 'Live Subject',
      isReply: true,
    });
  });

  it('publishes a victory event when the Crypt Lord falls', async () => {
    const { seen } = await setup();
    env.setRng(() => 0.5);
    const user = await env.deps.users.createUser('Alice', 'pass1234', new Date());
    const strong = {
      ...newCharacter(user.id, todayLocal(env.deps.now())),
      hp: 100,
      maxHp: 100,
      attack: 30,
      defense: 10,
      level: 5,
      dungeonDepth: 5,
    };
    await env.deps.users.saveCharacter(user.id, strong);
    const d = new SessionDriver(env.deps);
    await d.login('Alice', 'pass1234');
    seen.length = 0;
    await d.send('3');
    await d.send('E');
    await d.send('A');
    const victory = await d.sendText('A');
    expect(victory).toContain('VICTORY');
    expect(seen).toHaveLength(1);
    // The event carries the same level the Hall of Fame records (the
    // character may level up from the killing blow).
    const fame = await env.deps.scores.getHallOfFame();
    expect(fame).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'victory', handle: 'Alice', level: fame[0].level });
  });

  it('records local posts in the sync log with ids and sequence numbers', async () => {
    const { sync } = await setup('node-xyz');
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    await postThread(a, 'Logged Subject', 'logged body');
    const log = await sync.syncLog.read();
    expect(log.nodeId).toBe('node-xyz');
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].kind).toBe('thread');
    expect(log.entries[0].origin).toBe('node-xyz');
    expect(log.entries[0].seq).toBe(1);
    expect(log.entries[0].id.startsWith('node-xyz:')).toBe(true);
    expect(log.entries[0].thread?.subject).toBe('Logged Subject');
    expect(log.nextSeq).toBe(2);
    // A reply appends a second entry with the next sequence number.
    await a.send('1');
    await a.send('1');
    await a.send('1');
    await a.send('R');
    await a.send('second body');
    await a.send('.');
    const log2 = await sync.syncLog.read();
    expect(log2.entries).toHaveLength(2);
    expect(log2.entries[1].kind).toBe('reply');
    expect(log2.entries[1].seq).toBe(2);
    expect(log2.entries[1].post?.body).toBe('second body');
  });

  it('behaves exactly as before with no hub and no sync log', async () => {
    env = await createTestEnv();
    expect(env.deps.live).toBeUndefined();
    expect(env.deps.syncLog).toBeUndefined();
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    await postThread(a, 'Plain Subject', 'plain body');
    const threads = await env.deps.boards.listThreads('general');
    expect(threads.some((t) => t.subject === 'Plain Subject')).toBe(true);
  });
});

describe('engine: live chat', () => {
  it('delivers a chat message to the target only, preserving case', async () => {
    const { sync } = await setup();
    const aliceSeen: LiveEvent[] = [];
    const bobSeen: LiveEvent[] = [];
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    const b = new SessionDriver(env.deps);
    await b.register('Bob', 'pass1234');
    sync.hub.subscribe(a.state.id, (e) => aliceSeen.push(e));
    sync.hub.subscribe(b.state.id, (e) => bobSeen.push(e));
    const out = await a.sendText('6 Bob Hello There, Bob!');
    expect(out).toContain('Message sent to Bob.');
    expect(bobSeen).toHaveLength(1);
    expect(bobSeen[0]).toMatchObject({
      kind: 'chat',
      handle: 'Alice',
      message: 'Hello There, Bob!',
    });
    expect(aliceSeen).toEqual([]);
  });

  it('matches the target handle case-insensitively', async () => {
    const { sync } = await setup();
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    const b = new SessionDriver(env.deps);
    await b.register('Bob', 'pass1234');
    const bobSeen: LiveEvent[] = [];
    sync.hub.subscribe(b.state.id, (e) => bobSeen.push(e));
    const out = await a.sendText('6 bOB hi');
    expect(out).toContain('Message sent to Bob.');
    expect(bobSeen).toHaveLength(1);
  });

  it('bare 6 shows the chat help screen with online callers', async () => {
    await setup();
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    const b = new SessionDriver(env.deps);
    await b.register('Bob', 'pass1234');
    const out = await a.sendText('6');
    expect(out).toContain('CHAT — LIVE, CALLER TO CALLER');
    expect(out).toContain('6 <handle> <message>');
    expect(out).toContain('Bob');
    expect(out).toContain('MAIN MENU');
    expect(a.state.phase).toBe('MAIN_MENU');
  });

  it('rejects chat to an offline caller, to self, and without a message', async () => {
    await setup();
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    const offline = await a.sendText('6 Mallory hello');
    expect(offline).toContain('Mallory is not online right now.');
    expect(a.state.phase).toBe('MAIN_MENU');
    const self = await a.sendText('6 alice hello me');
    expect(self).toContain('cannot chat with yourself');
    const noMessage = await a.sendText('6 Bob');
    expect(noMessage).toContain('Usage: 6 <handle> <message>');
  });

  it('reports a target that hung up between lookup and delivery', async () => {
    const { sync } = await setup();
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    const b = new SessionDriver(env.deps);
    await b.register('Bob', 'pass1234');
    // Bob is in activeSessions but never subscribed (as with a transport
    // that dropped between the lookup and the send).
    expect(sync.hub.subscriberCount()).toBe(1); // only the collector
    const out = await a.sendText('6 Bob are you there');
    expect(out).toContain('just hung up');
  });

  it('reports chat unavailable when no hub is wired', async () => {
    env = await createTestEnv();
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    const b = new SessionDriver(env.deps);
    await b.register('Bob', 'pass1234');
    const out = await a.sendText('6 Bob hello');
    expect(out).toContain('Live chat is not available right now.');
  });
});
