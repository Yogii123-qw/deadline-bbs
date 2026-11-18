import { describe, expect, it } from 'vitest';
import {
  DO,
  DONT,
  IAC,
  OPT_ECHO,
  OPT_NAWS,
  OPT_SGA,
  SB,
  SE,
  WILL,
  WONT,
  TelnetNegotiator,
} from '../../src/telnet/negotiation.js';

describe('TelnetNegotiator', () => {
  it('sends the initial WILL/DO bundle', () => {
    const n = new TelnetNegotiator();
    expect([...n.initialSequence()]).toEqual([
      IAC, WILL, OPT_ECHO,
      IAC, WILL, OPT_SGA,
      IAC, DO, OPT_SGA,
      IAC, DO, OPT_NAWS,
    ]);
  });

  it('passes plain data through untouched', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from('hello\r\n', 'latin1'));
    expect(out.data.toString('latin1')).toBe('hello\r\n');
    expect(out.responses.length).toBe(0);
    expect(out.naws).toBeNull();
  });

  it('answers WILL SGA with DO, WILL ECHO with DONT', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([IAC, WILL, OPT_SGA, IAC, WILL, OPT_ECHO]));
    expect([...out.responses]).toEqual([IAC, DO, OPT_SGA, IAC, DONT, OPT_ECHO]);
    expect(out.data.length).toBe(0);
  });

  it('answers WILL NAWS with DO', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([IAC, WILL, OPT_NAWS]));
    expect([...out.responses]).toEqual([IAC, DO, OPT_NAWS]);
  });

  it('answers DO for unknown options with WONT', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([IAC, DO, 24]));
    expect([...out.responses]).toEqual([IAC, WONT, 24]);
  });

  it('does not re-answer DO ECHO (already offered)', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([IAC, DO, OPT_ECHO]));
    expect(out.responses.length).toBe(0);
  });

  it('stays silent on WONT and DONT', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([IAC, WONT, OPT_SGA, IAC, DONT, OPT_ECHO]));
    expect(out.responses.length).toBe(0);
  });

  it('never loops: repeated WILL SGA gets one DO', () => {
    const n = new TelnetNegotiator();
    const first = n.feed(Buffer.from([IAC, WILL, OPT_SGA]));
    const second = n.feed(Buffer.from([IAC, WILL, OPT_SGA]));
    expect([...first.responses]).toEqual([IAC, DO, OPT_SGA]);
    expect(second.responses.length).toBe(0);
  });

  it('tolerates a split IAC sequence across chunks', () => {
    const n = new TelnetNegotiator();
    const a = n.feed(Buffer.from([IAC]));
    expect(a.data.length).toBe(0);
    expect(a.responses.length).toBe(0);
    const b = n.feed(Buffer.from([WILL, OPT_SGA]));
    expect([...b.responses]).toEqual([IAC, DO, OPT_SGA]);
  });

  it('tolerates an IAC split byte-by-byte', () => {
    const n = new TelnetNegotiator();
    n.feed(Buffer.from([IAC]));
    n.feed(Buffer.from([DO]));
    const out = n.feed(Buffer.from([24]));
    expect([...out.responses]).toEqual([IAC, WONT, 24]);
  });

  it('parses interleaved commands and data', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(
      Buffer.from([0x61, IAC, WILL, OPT_SGA, 0x62, 0x63, IAC, DO, 24, 0x64]),
    );
    expect(out.data.toString('latin1')).toBe('abcd');
    expect([...out.responses]).toEqual([IAC, DO, OPT_SGA, IAC, WONT, 24]);
  });

  it('turns IAC IAC into a literal 255 data byte', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([0x61, IAC, IAC, 0x62]));
    expect([...out.data]).toEqual([0x61, 255, 0x62]);
  });

  it('parses NAWS sub-negotiation', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]));
    expect(out.naws).toEqual({ width: 80, height: 24 });
    expect(out.data.length).toBe(0);
  });

  it('parses NAWS split across chunks', () => {
    const n = new TelnetNegotiator();
    n.feed(Buffer.from([IAC, SB, OPT_NAWS, 0]));
    const out = n.feed(Buffer.from([120, 0, 40, IAC, SE]));
    expect(out.naws).toEqual({ width: 120, height: 40 });
  });

  it('ignores sub-negotiation for other options', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([IAC, SB, 24, 1, 2, 3, IAC, SE, 0x61]));
    expect(out.naws).toBeNull();
    expect(out.data.toString('latin1')).toBe('a');
  });

  it('handles IAC IAC inside sub-negotiation', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(
      Buffer.from([IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, IAC, IAC, SE]),
    );
    // Extra escaped 255 lands in sbData after the 4 NAWS bytes; dims still parse.
    expect(out.naws).toEqual({ width: 80, height: 24 });
  });

  it('rejects absurd NAWS dimensions', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([IAC, SB, OPT_NAWS, 0xff, 0xff, 0, 24, IAC, SE]));
    expect(out.naws).toBeNull();
  });

  it('ignores bare SE and NOP commands', () => {
    const n = new TelnetNegotiator();
    const out = n.feed(Buffer.from([IAC, SE, IAC, 241, 0x61]));
    expect(out.data.toString('latin1')).toBe('a');
    expect(out.responses.length).toBe(0);
  });
});
