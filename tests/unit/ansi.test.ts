import { describe, expect, it } from 'vitest';
import {
  bold,
  clearLine,
  clearScreen,
  color,
  esc,
  hideCursor,
  moveCursor,
  reset,
  reverseVideo,
  sanitizeUserText,
  showCursor,
  stripAnsi,
  stripControls,
} from '../../src/telnet/ansi.js';

describe('ANSI helpers', () => {
  it('builds exact escape sequences', () => {
    expect(esc('1m')).toBe('\x1b[1m');
    expect(moveCursor(3, 5)).toBe('\x1b[3;5H');
    expect(clearScreen()).toBe('\x1b[2J\x1b[H');
    expect(clearLine()).toBe('\x1b[2K');
    expect(color(36)).toBe('\x1b[36m');
    expect(color(37, 40)).toBe('\x1b[37;40m');
    expect(bold()).toBe('\x1b[1m');
    expect(reset()).toBe('\x1b[0m');
    expect(hideCursor()).toBe('\x1b[?25l');
    expect(showCursor()).toBe('\x1b[?25h');
    expect(reverseVideo()).toBe('\x1b[7m');
  });

  it('strips CSI sequences', () => {
    expect(stripAnsi('\x1b[1;36mhello\x1b[0m')).toBe('hello');
    expect(stripAnsi('a\x1b[2Jb')).toBe('ab');
    expect(stripAnsi('\x1b[?25l\x1b[3;5Htext')).toBe('text');
  });

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07after')).toBe('after');
    expect(stripAnsi('\x1b]8;;http://evil\x1b\\link')).toBe('link');
  });

  it('strips charset and lone escape sequences', () => {
    expect(stripAnsi('\x1b(Bplain')).toBe('plain');
    expect(stripAnsi('a\x1bMb')).toBe('ab');
    expect(stripAnsi('a\x1bb')).toBe('ab');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('hello world 123')).toBe('hello world 123');
    expect(stripAnsi('')).toBe('');
  });

  it('strips control characters but keeps tab, LF, CR', () => {
    expect(stripControls('a\x00b\x07c\x7fd')).toBe('abcd');
    expect(stripControls('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('sanitizeUserText removes both ANSI and controls', () => {
    expect(sanitizeUserText('\x1b[31mEvil\x1b[0m\x00\x07')).toBe('Evil');
  });
});
