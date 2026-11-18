import { describe, expect, it } from 'vitest';
import { LineReader } from '../../src/session/input.js';
import { chatHelpScreen, mainMenu, renderLiveNotice } from '../../src/session/screens.js';
import {
  buildLiveFrame,
  LiveHub,
  trailingPrompt,
  type LiveEvent,
} from '../../src/server/live.js';
import { validateChatMessage, CHAT_MAX } from '../../src/shared/validation.js';
import { stripAnsi } from '../../src/telnet/ansi.js';

const postEvent: LiveEvent = {
  kind: 'post',
  fromId: 'a',
  handle: 'Alice',
  boardName: 'General Discussion',
  subject: 'Hello board',
  isReply: false,
};

describe('LiveHub', () => {
  it('publishes to all subscribers except the originator', () => {
    const hub = new LiveHub();
    const seen: LiveEvent[][] = [[], []];
    hub.subscribe('a', (e) => seen[0].push(e));
    hub.subscribe('b', (e) => seen[1].push(e));
    hub.publish(postEvent);
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([postEvent]);
    expect(hub.subscriberCount()).toBe(2);
  });

  it('sendTo delivers to one target and reports a raced disconnect', () => {
    const hub = new LiveHub();
    const seen: LiveEvent[] = [];
    hub.subscribe('b', (e) => seen.push(e));
    const chat: LiveEvent = { kind: 'chat', fromId: 'a', handle: 'Alice', message: 'hi' };
    expect(hub.sendTo('b', chat)).toBe(true);
    expect(seen).toEqual([chat]);
    expect(hub.sendTo('gone', chat)).toBe(false);
  });

  it('a throwing subscriber does not break delivery to others', () => {
    const logs: string[] = [];
    const hub = new LiveHub((m) => logs.push(m));
    const seen: LiveEvent[] = [];
    hub.subscribe('bad', () => {
      throw new Error('boom');
    });
    hub.subscribe('good', (e) => seen.push(e));
    hub.publish({ ...postEvent, fromId: 'someone-else' });
    expect(seen).toHaveLength(1);
    expect(logs.join(' ')).toContain('Live delivery');
  });

  it('unsubscribe stops delivery', () => {
    const hub = new LiveHub();
    const seen: LiveEvent[] = [];
    hub.subscribe('b', (e) => seen.push(e));
    hub.unsubscribe('b');
    hub.publish({ ...postEvent, fromId: 'a' });
    expect(seen).toEqual([]);
    expect(hub.subscriberCount()).toBe(0);
  });
});

describe('trailingPrompt and buildLiveFrame', () => {
  it('extracts the prompt segment after the last newline', () => {
    expect(trailingPrompt('screen\nChoice: ')).toBe('Choice: ');
    expect(trailingPrompt('Choice: ')).toBe('Choice: ');
    expect(trailingPrompt('screen\n')).toBe('');
    expect(trailingPrompt('')).toBe('');
    expect(trailingPrompt('a\nb\nPasscode: ')).toBe('Passcode: ');
  });

  it('frames a notice with erase-line, prompt, and partial input', () => {
    const frame = buildLiveFrame('NOTICE', 'Choice: ', '1', false);
    expect(frame).toBe('\r\x1b[2KNOTICE\nChoice: 1');
  });

  it('masks partial input in passcode phases', () => {
    const frame = buildLiveFrame('NOTICE', 'Passcode: ', 'secret', true);
    expect(frame).toBe('\r\x1b[2KNOTICE\nPasscode: ******');
    expect(frame).not.toContain('secret');
  });

  it('frames with an empty prompt and no partial input', () => {
    expect(buildLiveFrame('NOTICE', '', '', false)).toBe('\r\x1b[2KNOTICE\n');
  });
});

describe('renderLiveNotice', () => {
  it('renders a local post notice', () => {
    const plain = stripAnsi(renderLiveNotice(postEvent));
    expect(plain).toContain('» LIVE:');
    expect(plain).toContain('Alice');
    expect(plain).toContain('posted "Hello board"');
    expect(plain).toContain('General Discussion');
    expect(plain).not.toContain('via node');
  });

  it('renders a reply and a federated post with its origin node', () => {
    const reply = stripAnsi(renderLiveNotice({ ...postEvent, isReply: true }));
    expect(reply).toContain('replied to "Hello board"');
    const remote = stripAnsi(
      renderLiveNotice({ ...postEvent, fromId: '__deadline_remote__', originNode: 'node-b' }),
    );
    expect(remote).toContain('(via node node-b)');
  });

  it('renders victory, join, and leave notices', () => {
    expect(stripAnsi(renderLiveNotice({ kind: 'victory', fromId: 'a', handle: 'Alice', level: 5 }))).toContain(
      'slew the Crypt Lord (level 5)',
    );
    expect(
      stripAnsi(renderLiveNotice({ kind: 'join', fromId: 'a', handle: 'Bob', transport: 'telnet' })),
    ).toContain('Bob just called in (telnet)');
    expect(stripAnsi(renderLiveNotice({ kind: 'leave', fromId: 'a', handle: 'Bob' }))).toContain(
      'Bob hung up.',
    );
  });

  it('renders chat with a reply hint', () => {
    const plain = stripAnsi(
      renderLiveNotice({ kind: 'chat', fromId: 'a', handle: 'Alice', message: 'hello there' }),
    );
    expect(plain).toContain('» CHAT from Alice:');
    expect(plain).toContain('hello there');
    expect(plain).toContain('Reply with: 6 Alice <message>');
  });

  it('never lets user text inject ANSI codes or extra lines', () => {
    const evil: LiveEvent = {
      kind: 'post',
      fromId: 'a',
      handle: 'Eve\x1b[31mRED',
      boardName: 'General\nFAKE BOARD',
      subject: 'hi\x1b[2J\nFAKE LINE',
      isReply: false,
    };
    const rendered = renderLiveNotice(evil);
    // No injected red, no injected clear-screen, exactly one line.
    expect(rendered).not.toContain('\x1b[31m');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered.split('\n')).toHaveLength(1);
    const plain = stripAnsi(rendered);
    expect(plain).toContain('EveRED');
    expect(plain).toContain('General FAKE BOARD');
    expect(plain).toContain('hi FAKE LINE');
  });

  it('collapses newlines in chat messages to one line plus the hint', () => {
    const rendered = renderLiveNotice({
      kind: 'chat',
      fromId: 'a',
      handle: 'Alice',
      message: 'line1\nline2\rline3',
    });
    expect(rendered.split('\n')).toHaveLength(2);
    expect(stripAnsi(rendered)).toContain('line1 line2 line3');
  });
});

describe('chat help screen and menu', () => {
  it('main menu lists the chat option', () => {
    const plain = stripAnsi(mainMenu('Alice', '0:01:00'));
    expect(plain).toContain("6  Chat with a caller online");
  });

  it('chat help shows usage and online callers', () => {
    const plain = stripAnsi(
      chatHelpScreen([
        { id: '1', handle: 'Alice', transport: 'telnet', connectedAt: new Date() },
        { id: '2', handle: 'Bob', transport: 'websocket', connectedAt: new Date() },
      ]),
    );
    expect(plain).toContain('6 <handle> <message>');
    expect(plain).toContain('Alice');
    expect(plain).toContain('Bob');
  });

  it('chat help says so when only the caller is online', () => {
    const plain = stripAnsi(
      chatHelpScreen([{ id: '1', handle: 'Alice', transport: 'telnet', connectedAt: new Date() }]),
    );
    expect(plain).toContain('only caller online');
  });
});

describe('LineReader.pendingInput', () => {
  it('reports partial input and clears it when the line completes', () => {
    const reader = new LineReader();
    expect(reader.pendingInput()).toBe('');
    reader.feed('6 Al', 'echo');
    expect(reader.pendingInput()).toBe('6 Al');
    const result = reader.feed('ice\n', 'echo');
    expect(result.lines).toEqual(['6 Alice']);
    expect(reader.pendingInput()).toBe('');
  });

  it('tracks backspace and Ctrl-C', () => {
    const reader = new LineReader();
    reader.feed('abc', 'echo');
    reader.feed('\x7f', 'echo');
    expect(reader.pendingInput()).toBe('ab');
    reader.feed('\x03', 'echo');
    expect(reader.pendingInput()).toBe('');
  });
});

describe('validateChatMessage', () => {
  it('accepts a normal message and trims it', () => {
    expect(validateChatMessage('  hello World  ')).toBe('hello World');
  });

  it('rejects empty and oversized messages', () => {
    expect(() => validateChatMessage('   ')).toThrow('must not be empty');
    expect(() => validateChatMessage('x'.repeat(CHAT_MAX + 1))).toThrow(
      `at most ${CHAT_MAX} characters`,
    );
    expect(validateChatMessage('x'.repeat(CHAT_MAX))).toHaveLength(CHAT_MAX);
  });

  it('strips ANSI sequences', () => {
    expect(validateChatMessage('hi\x1b[31mred')).toBe('hired');
  });
});

describe('buildLiveFrame width-aware clearing (PRO-DEV)', () => {
  it('is byte-identical to the legacy frame when the line fits the width', () => {
    expect(buildLiveFrame('NOTICE', 'Choice: ', '1', false, 80)).toBe(
      '\r\x1b[2KNOTICE\nChoice: 1',
    );
    expect(buildLiveFrame('NOTICE', 'Choice: ', '1', false, 40)).toBe(
      '\r\x1b[2KNOTICE\nChoice: 1',
    );
  });

  it('clears two visual lines when prompt + input wraps once', () => {
    const partial = 'x'.repeat(40);
    const frame = buildLiveFrame('NOTICE', 'Choice: ', partial, false, 40);
    expect(frame).toBe(`\r\x1b[2K\x1b[1A\x1b[2KNOTICE\nChoice: ${partial}`);
  });

  it('clears three visual lines when the input wraps twice', () => {
    const partial = 'x'.repeat(80);
    const frame = buildLiveFrame('NOTICE', 'Choice: ', partial, false, 40);
    expect(frame).toBe(`\r\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2KNOTICE\nChoice: ${partial}`);
  });

  it('treats an exact width multiple as fitting on one line', () => {
    // 8 (prompt) + 32 = 40 = width: cursor sits at the end of line 1.
    expect(buildLiveFrame('NOTICE', 'Choice: ', 'x'.repeat(32), false, 40)).toBe(
      `\r\x1b[2KNOTICE\nChoice: ${'x'.repeat(32)}`,
    );
    // One more character wraps to line 2.
    expect(buildLiveFrame('NOTICE', 'Choice: ', 'x'.repeat(33), false, 40)).toBe(
      `\r\x1b[2K\x1b[1A\x1b[2KNOTICE\nChoice: ${'x'.repeat(33)}`,
    );
  });

  it('measures the prompt without its ANSI codes', () => {
    const prompt = '\x1b[36mChoice: \x1b[0m';
    const frame = buildLiveFrame('NOTICE', prompt, 'x'.repeat(35), false, 40);
    // Visible length is 8 + 35 = 43: two lines, not five.
    expect(frame).toBe(`\r\x1b[2K\x1b[1A\x1b[2KNOTICE\n${prompt}${'x'.repeat(35)}`);
  });

  it('falls back to the legacy frame for pathological widths', () => {
    const frame = buildLiveFrame('NOTICE', 'Choice: ', 'x'.repeat(60), false, 10);
    expect(frame).toBe(`\r\x1b[2KNOTICE\nChoice: ${'x'.repeat(60)}`);
    expect(frame).not.toContain('\x1b[1A');
  });

  it('counts masked echo by length, same as unmasked', () => {
    const frame = buildLiveFrame('NOTICE', 'Passcode: ', 's'.repeat(40), true, 40);
    expect(frame).toBe(`\r\x1b[2K\x1b[1A\x1b[2KNOTICE\nPasscode: ${'*'.repeat(40)}`);
    expect(frame).not.toContain('s'.repeat(40));
  });
});

describe('renderLiveNotice edit events (PRO-DEV)', () => {
  it('renders local edits and deletes', () => {
    const edited: LiveEvent = {
      kind: 'edit',
      fromId: 'a',
      handle: 'Alice',
      boardName: 'General Discussion',
      subject: 'Hello board',
      action: 'edited',
    };
    expect(stripAnsi(renderLiveNotice(edited))).toBe(
      '» LIVE: Alice edited "Hello board" in General Discussion',
    );
    const deleted: LiveEvent = { ...edited, action: 'deleted' };
    expect(stripAnsi(renderLiveNotice(deleted))).toBe(
      '» LIVE: Alice deleted "Hello board" in General Discussion',
    );
  });

  it('renders federated edits with the origin node', () => {
    const remote: LiveEvent = {
      kind: 'edit',
      fromId: '__deadline_remote__',
      handle: 'Bob',
      boardName: 'General Discussion',
      subject: 'Remote post',
      action: 'deleted',
      originNode: 'node-b',
    };
    expect(stripAnsi(renderLiveNotice(remote))).toBe(
      '» LIVE: Bob deleted "Remote post" in General Discussion (via node node-b)',
    );
  });
});
