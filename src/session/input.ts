/**
 * src/session/input.ts — Terminal line reader (builder-written, per design §2.15).
 *
 * Consumes raw keystrokes and produces completed lines. Handles CR/LF/CRLF,
 * backspace line editing, Ctrl-C line cancel, and swallows terminal escape
 * sequences (arrow keys etc.) so they never leak into input. Oversized lines
 * are rejected, never silently truncated.
 */

import { MAX_LINE } from '../shared/validation.js';

export type EchoMode = 'echo' | 'mask';

export interface FeedResult {
  /** Completed lines (without line terminators), in order. */
  lines: string[];
  /** Bytes to echo back to the client. */
  echo: string;
  /** True if a completed line was dropped for exceeding MAX_LINE. */
  overflow: boolean;
}

type EscapeState = 'none' | 'esc' | 'csi' | 'osc' | 'charset';

export class LineReader {
  private buffer = '';
  private escapeState: EscapeState = 'none';
  private swallowNextLf = false;
  private overflowed = false;

  public feed(text: string, mode: EchoMode): FeedResult {
    const lines: string[] = [];
    let echo = '';
    let overflow = false;

    const completeLine = (): void => {
      if (this.overflowed) {
        overflow = true;
      } else {
        lines.push(this.buffer);
      }
      this.buffer = '';
      this.overflowed = false;
      echo += '\r\n';
    };

    for (const ch of text) {
      // Escape-sequence swallower (arrow keys, function keys, mouse reports).
      if (this.escapeState !== 'none') {
        if (this.escapeState === 'esc') {
          if (ch === '[') this.escapeState = 'csi';
          else if (ch === ']') this.escapeState = 'osc';
          else if (ch === '(' || ch === ')') this.escapeState = 'charset';
          else this.escapeState = 'none';
        } else if (this.escapeState === 'csi') {
          const code = ch.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) this.escapeState = 'none';
        } else if (this.escapeState === 'osc') {
          if (ch === '\x07') this.escapeState = 'none';
          else if (ch === '\x1b') this.escapeState = 'esc';
        } else if (this.escapeState === 'charset') {
          this.escapeState = 'none';
        }
        continue;
      }

      if (ch === '\x1b') {
        this.escapeState = 'esc';
        continue;
      }
      if (ch === '\r') {
        this.swallowNextLf = true;
        completeLine();
        continue;
      }
      if (ch === '\n') {
        if (this.swallowNextLf) {
          this.swallowNextLf = false;
          continue;
        }
        completeLine();
        continue;
      }
      this.swallowNextLf = false;

      if (ch === '\x08' || ch === '\x7f') {
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          echo += '\x08 \x08';
        }
        continue;
      }
      if (ch === '\x03') {
        // Ctrl-C: cancel the current line.
        this.buffer = '';
        this.overflowed = false;
        echo += '^C\r\n';
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        // Other C0 controls (including tab): ignore.
        continue;
      }
      if (this.buffer.length >= MAX_LINE) {
        this.overflowed = true;
        continue;
      }
      this.buffer += ch;
      echo += mode === 'mask' ? '*' : ch;
    }

    return { lines, echo, overflow };
  }
}
