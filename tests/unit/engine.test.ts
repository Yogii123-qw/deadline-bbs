import { afterEach, describe, expect, it } from 'vitest';
import { todayLocal } from '../../src/session/engine.js';
import { newCharacter } from '../../src/game/catacomb.js';
import { createTestEnv, SessionDriver, type TestEnv } from '../helpers.js';

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

const FILES = {
  'GUIDE.TXT': 'Welcome to the file area.\nSecond line here.\n',
  'NOTES.TXT': 'Just some notes.\n',
};

describe('engine: auth flows', () => {
  it('shows the splash and handle prompt on first input', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    const out = await d.sendText('');
    expect(out).toContain('REFUSES TO DIE');
    expect(out).toContain('Handle:');
    expect(d.state.phase).toBe('HANDLE_PROMPT');
  });

  it('registers a new handle end to end', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    const menu = await d.register('Alice', 'pass1234');
    expect(d.state.phase).toBe('MAIN_MENU');
    expect(menu).toContain('MAIN MENU');
    expect(menu).toContain('Alice');
    expect(env.deps.activeSessions.size).toBe(1);
    const stored = await env.deps.users.findUser('Alice');
    expect(stored).not.toBeNull();
  });

  it('logs in a returning user', async () => {
    env = await createTestEnv();
    await env.deps.users.createUser('Bob', 'hunter22', new Date());
    const d = new SessionDriver(env.deps);
    const menu = await d.login('bob', 'hunter22');
    expect(d.state.phase).toBe('MAIN_MENU');
    expect(menu).toContain('Bob');
  });

  it('rejects a wrong passcode and returns to the handle prompt', async () => {
    env = await createTestEnv();
    await env.deps.users.createUser('Bob', 'hunter22', new Date());
    const d = new SessionDriver(env.deps);
    await d.send('');
    await d.send('Bob');
    const out = await d.sendText('wrongpass');
    expect(out).toContain('Invalid handle or passcode');
    expect(d.state.phase).toBe('HANDLE_PROMPT');
    expect(d.state.handle).toBeNull();
  });

  it('restarts registration on passcode mismatch', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.send('');
    await d.send('Carol');
    await d.send('firstpass');
    const out = await d.sendText('secondpass');
    expect(out).toContain('did not match');
    expect(d.state.phase).toBe('HANDLE_PROMPT');
    expect(await env.deps.users.findUser('Carol')).toBeNull();
  });

  it('recovers from an invalid handle with an error, staying at the prompt', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.send('');
    const out = await d.sendText('x');
    expect(out).toContain('Handle must be');
    expect(d.state.phase).toBe('HANDLE_PROMPT');
  });

  it('rejects a too-short passcode and stays in registration', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.send('');
    await d.send('Dave');
    const out = await d.sendText('abc');
    expect(out).toContain('Passcode must be');
    expect(d.state.phase).toBe('PASSCODE_PROMPT');
  });
});

describe('engine: boards', () => {
  it('navigates boards, reads a thread, and advances the read marker', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    const list = await d.sendText('1');
    expect(list).toContain('General Discussion');
    expect(list).toContain('[4 new]');
    const threads = await d.sendText('1');
    expect(threads).toContain('Is a 14.4 modem worth it?');
    const view = await d.sendText('1');
    expect(view).toContain('[ARCHIVE - 1994]');
    expect(view).toContain('ModemMary');
    expect(d.state.phase).toBe('READING_THREAD');
    const user = await env.deps.users.findUser('Alice');
    const counts = await env.deps.boards.getUnreadCounts(user?.readMarkers ?? {});
    expect(counts['general']).toBe(0);
    const back = await d.sendText('Q');
    expect(back).toContain('BOARD:');
    const boards = await d.sendText('Q');
    expect(boards).not.toContain('[4 new]');
  });

  it('posts a new thread and it persists', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('1');
    await d.send('1');
    await d.send('N');
    await d.send('Hello from 2026');
    await d.send('First line of the message.');
    await d.send('Second line.');
    const out = await d.sendText('.');
    expect(out).toContain('Thread posted.');
    expect(out).toContain('Hello from 2026');
    const threads = await env.deps.boards.listThreads('general');
    expect(threads[0].subject).toBe('Hello from 2026');
    expect(threads[0].posts[0].body).toBe('First line of the message.\nSecond line.');
  });

  it('replies to a thread', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('1');
    await d.send('1');
    await d.send('1');
    await d.send('R');
    await d.send('Great point, agreed.');
    const out = await d.sendText('.');
    expect(out).toContain('Reply posted.');
    expect(out).toContain('Great point, agreed.');
  });

  it('cancels composition with ABORT and with an empty subject', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('1');
    await d.send('1');
    const before = (await env.deps.boards.listThreads('general')).length;
    await d.send('N');
    await d.send('Never mind');
    await d.send('some body');
    const aborted = await d.sendText('ABORT');
    expect(aborted).toContain('BOARD:');
    await d.send('N');
    const cancelled = await d.sendText('');
    expect(cancelled).toContain('BOARD:');
    expect((await env.deps.boards.listThreads('general')).length).toBe(before);
  });

  it('rejects an overlong subject and stays in compose', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('1');
    await d.send('1');
    await d.send('N');
    const out = await d.sendText('x'.repeat(73));
    expect(out).toContain('at most 72 characters');
    expect(d.state.phase).toBe('COMPOSING_POST');
  });

  it('searches all boards and opens a result', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('1');
    await d.send('/');
    const results = await d.sendText('FidoNet');
    expect(results).toContain('FidoNet echomail setup notes');
    const view = await d.sendText('1');
    expect(view).toContain('nodelist');
    const back = await d.sendText('Q');
    expect(back).toContain('BOARD:');
  });

  it('reports no search results clearly', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('1');
    await d.send('/');
    const results = await d.sendText('zzzznothing');
    expect(results).toContain('No results');
  });

  it('recovers from bad menu choices with errors, staying in place', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    const badMenu = await d.sendText('9');
    expect(badMenu).toContain('Unknown choice');
    expect(d.state.phase).toBe('MAIN_MENU');
    await d.send('1');
    const badBoard = await d.sendText('99');
    expect(badBoard).toContain('Pick a board number');
    expect(d.state.phase).toBe('BOARD_LIST');
  });
});

describe('engine: files', () => {
  it('lists, reads, and pages files', async () => {
    env = await createTestEnv(FILES);
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    const list = await d.sendText('2');
    expect(list).toContain('GUIDE.TXT');
    expect(list).toContain('NOTES.TXT');
    const view = await d.sendText('1');
    expect(view).toContain('Welcome to the file area.');
    expect(d.state.phase).toBe('READING_FILE');
    const back = await d.sendText('Q');
    expect(back).toContain('FILE AREA');
  });

  it('gives a download link on the web, guidance on telnet', async () => {
    env = await createTestEnv(FILES);
    const web = new SessionDriver(env.deps, 'websocket');
    await web.register('Alice', 'pass1234');
    await web.send('2');
    const link = await web.sendText('D1');
    expect(link).toContain('/files/GUIDE.TXT');

    const telnet = new SessionDriver(env.deps, 'telnet');
    await telnet.register('Bob', 'pass1234');
    await telnet.send('2');
    const guidance = await telnet.sendText('D1');
    expect(guidance).toContain('web interface');
    expect(guidance).not.toContain('/files/GUIDE.TXT');
  });

  it('rejects bad file numbers', async () => {
    env = await createTestEnv(FILES);
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('2');
    const out = await d.sendText('99');
    expect(out).toContain('Pick a file number');
    expect(d.state.phase).toBe('FILE_LIST');
  });
});

describe('engine: CATACOMB', () => {
  it('enters the dungeon with a fresh character', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    const out = await d.sendText('3');
    expect(out).toContain('CATACOMB');
    expect(out).toContain('Turns left today: 20');
    expect(d.state.phase).toBe('CATACOMB');
  });

  it('refuses entry with zero turns and returns to the menu', async () => {
    env = await createTestEnv();
    const user = await env.deps.users.createUser('Alice', 'pass1234', new Date());
    const today = todayLocal(env.deps.now());
    const ch = { ...newCharacter(user.id, today), turnsUsedToday: 20 };
    await env.deps.users.saveCharacter(user.id, ch);
    const d = new SessionDriver(env.deps);
    await d.login('Alice', 'pass1234');
    const out = await d.sendText('3');
    expect(out).toContain('exhausted');
    expect(d.state.phase).toBe('MAIN_MENU');
  });

  it('resets turns at midnight (new local date)', async () => {
    env = await createTestEnv();
    const user = await env.deps.users.createUser('Alice', 'pass1234', new Date());
    const ch = { ...newCharacter(user.id, '2026-11-18'), turnsUsedToday: 20 };
    await env.deps.users.saveCharacter(user.id, ch);
    const d = new SessionDriver(env.deps);
    await d.login('Alice', 'pass1234');
    const out = await d.sendText('3');
    expect(out).toContain('Turns left today: 20');
    expect(d.state.phase).toBe('CATACOMB');
  });

  it('explores into combat, fights, and flees', async () => {
    env = await createTestEnv();
    env.setRng(() => 0.5);
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('3');
    const encounter = await d.sendText('E');
    expect(encounter).toContain('COMBAT');
    expect(d.state.phase).toBe('CATACOMB_COMBAT');
    const round = await d.sendText('A');
    expect(round).toContain('damage');
    const fled = await d.sendText('F');
    expect(fled).toContain('slip away');
    expect(d.state.phase).toBe('CATACOMB');
  });

  it('kills a monster and earns rewards', async () => {
    env = await createTestEnv();
    env.setRng(() => 0.5);
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    await d.send('3');
    await d.send('E');
    // Cave Bat has 14 HP; 5 damage per round at rng 0.5 -> 3 rounds.
    await d.send('A');
    await d.send('A');
    const out = await d.sendText('A');
    expect(out).toContain('defeat');
    expect(out).toContain('Gained');
    expect(d.state.phase).toBe('CATACOMB');
    const user = await env.deps.users.findUser('Alice');
    expect(user?.gameCharacter?.xp).toBeGreaterThan(0);
  });

  it('resets the character on death without refunding turns', async () => {
    env = await createTestEnv();
    env.setRng(() => 0);
    const user = await env.deps.users.createUser('Alice', 'pass1234', new Date());
    const today = todayLocal(env.deps.now());
    const weak = {
      ...newCharacter(user.id, today),
      hp: 1,
      attack: 1,
      defense: 0,
      turnsUsedToday: 3,
    };
    await env.deps.users.saveCharacter(user.id, weak);
    const d = new SessionDriver(env.deps);
    await d.login('Alice', 'pass1234');
    await d.send('3');
    await d.send('E');
    const out = await d.sendText('A');
    expect(out).toContain('starting over');
    const after = await env.deps.users.getCharacter(user.id);
    expect(after?.level).toBe(1);
    expect(after?.hp).toBe(20);
    expect(after?.turnsUsedToday).toBe(4);
    expect(await env.deps.scores.getHallOfFame()).toEqual([]);
  });

  it('records a Hall of Fame entry on defeating the Crypt Lord', async () => {
    env = await createTestEnv();
    env.setRng(() => 0.5);
    const user = await env.deps.users.createUser('Alice', 'pass1234', new Date());
    const today = todayLocal(env.deps.now());
    const strong = {
      ...newCharacter(user.id, today),
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
    await d.send('3');
    const encounter = await d.sendText('E');
    expect(encounter).toContain('Crypt Lord');
    await d.send('A');
    const victory = await d.sendText('A');
    expect(victory).toContain('VICTORY');
    expect(victory).toContain('HALL OF FAME');
    expect(d.state.phase).toBe('HALL_OF_FAME');
    const fame = await env.deps.scores.getHallOfFame();
    expect(fame).toHaveLength(1);
    expect(fame[0].handle).toBe('Alice');
    const after = await env.deps.users.getCharacter(user.id);
    expect(after?.isVictorious).toBe(true);
  });
});

describe('engine: misc', () => {
  it('shows who is online, solo then with two callers', async () => {
    env = await createTestEnv();
    const a = new SessionDriver(env.deps);
    await a.register('Alice', 'pass1234');
    const solo = await a.sendText('5');
    expect(solo).toContain('only caller');
    await a.sendText('');
    const b = new SessionDriver(env.deps, 'websocket');
    await b.register('Bob', 'pass1234');
    const duo = await a.sendText('5');
    expect(duo).toContain('2 callers online');
    expect(duo).toContain('Bob');
  });

  it('shows an empty hall of fame', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    const out = await d.sendText('4');
    expect(out).toContain('empty');
  });

  it('logs off with a goodbye screen', async () => {
    env = await createTestEnv();
    const d = new SessionDriver(env.deps);
    await d.register('Alice', 'pass1234');
    const out = await d.sendText('G');
    expect(out).toContain('Goodbye, Alice');
    expect(d.state.phase).toBe('LOGOFF');
  });
});
