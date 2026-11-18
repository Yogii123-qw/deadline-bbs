import { describe, expect, it } from 'vitest';
import { LineReader } from '../../src/session/input.js';

describe('LineReader', () => {
  it('completes a line on CR', () => {
    const r = new LineReader();
    const out = r.feed('hello\r', 'echo');
    expect(out.lines).toEqual(['hello']);
    expect(out.echo).toBe('hello\r\n');
  });

  it('completes a line on LF', () => {
    const r = new LineReader();
    expect(r.feed('hi\n', 'echo').lines).toEqual(['hi']);
  });

  it('treats CRLF as one terminator', () => {
    const r = new LineReader();
    expect(r.feed('a\r\nb\r\n', 'echo').lines).toEqual(['a', 'b']);
  });

  it('handles backspace editing', () => {
    const r = new LineReader();
    const out = r.feed('ab\x08c\r', 'echo');
    expect(out.lines).toEqual(['ac']);
    expect(out.echo).toContain('\x08 \x08');
  });

  it('handles DEL as backspace and ignores it on an empty line', () => {
    const r = new LineReader();
    const out = r.feed('\x7f\x7fxy\x7f\r', 'echo');
    expect(out.lines).toEqual(['x']);
  });

  it('masks echo with stars in mask mode', () => {
    const r = new LineReader();
    const out = r.feed('secret\r', 'mask');
    expect(out.lines).toEqual(['secret']);
    expect(out.echo).toBe('******\r\n');
  });

  it('swallows arrow-key escape sequences', () => {
    const r = new LineReader();
    const out = r.feed('a\x1b[A\x1b[Bb\r', 'echo');
    expect(out.lines).toEqual(['ab']);
    expect(out.echo).toBe('ab\r\n');
  });

  it('swallows OSC sequences', () => {
    const r = new LineReader();
    const out = r.feed('x\x1b]0;title\x07y\r', 'echo');
    expect(out.lines).toEqual(['xy']);
  });

  it('cancels the line on Ctrl-C', () => {
    const r = new LineReader();
    const out = r.feed('partial\x03fresh\r', 'echo');
    expect(out.lines).toEqual(['fresh']);
    expect(out.echo).toContain('^C\r\n');
  });

  it('ignores other C0 controls', () => {
    const r = new LineReader();
    const out = r.feed('a\x01\x02\tb\r', 'echo');
    expect(out.lines).toEqual(['ab']);
  });

  it('returns multiple lines from one feed', () => {
    const r = new LineReader();
    expect(r.feed('one\rtwo\rthree\r', 'echo').lines).toEqual(['one', 'two', 'three']);
  });

  it('buffers a partial line across feeds', () => {
    const r = new LineReader();
    expect(r.feed('hel', 'echo').lines).toEqual([]);
    expect(r.feed('lo\r', 'echo').lines).toEqual(['hello']);
  });

  it('drops overlong lines and reports overflow', () => {
    const r = new LineReader();
    const out = r.feed(`${'x'.repeat(1025)}\r`, 'echo');
    expect(out.lines).toEqual([]);
    expect(out.overflow).toBe(true);
    const next = r.feed('ok\r', 'echo');
    expect(next.lines).toEqual(['ok']);
    expect(next.overflow).toBe(false);
  });

  it('accepts a line at exactly the limit', () => {
    const r = new LineReader();
    const out = r.feed(`${'x'.repeat(1024)}\r`, 'echo');
    expect(out.lines).toHaveLength(1);
    expect(out.overflow).toBe(false);
  });
});
