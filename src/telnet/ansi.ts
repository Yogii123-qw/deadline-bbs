/**
 * src/telnet/ansi.ts — Pure ANSI escape helpers (builder-written, per design §2.5).
 *
 * Standard ANSI/VT100 sequences only, compatible with xterm.js and standard
 * telnet clients. No state, no I/O.
 */

/** Build a CSI sequence: ESC [ <code>. */
export function esc(code: string): string {
  return `\x1b[${code}`;
}

/** Move the cursor to 1-based row/col. */
export function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/** Clear the whole screen and home the cursor. */
export function clearScreen(): string {
  return '\x1b[2J\x1b[H';
}

/** Clear the current line. */
export function clearLine(): string {
  return '\x1b[2K';
}

/** Set foreground color (30-37 / 90-97), optionally background (40-47 / 100-107). */
export function color(fg: number, bg?: number): string {
  return bg === undefined ? `\x1b[${fg}m` : `\x1b[${fg};${bg}m`;
}

/** Bold / bright. */
export function bold(): string {
  return '\x1b[1m';
}

/** Reset all attributes. */
export function reset(): string {
  return '\x1b[0m';
}

/** Hide the cursor. */
export function hideCursor(): string {
  return '\x1b[?25l';
}

/** Show the cursor. */
export function showCursor(): string {
  return '\x1b[?25h';
}

/** Reverse video. */
export function reverseVideo(): string {
  return '\x1b[7m';
}

const ANSI_PATTERN =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[@-Z\\-_]|\x1b/g;

/**
 * Remove every ANSI escape sequence from a string. Used on all user-supplied
 * text before storing or rendering it, so a user can never inject terminal
 * control sequences into another user's screen (R4.4, R3.3).
 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g;

/**
 * Remove C0/C1 control characters except tab, LF, and CR. Applied together
 * with stripAnsi at every trust boundary.
 */
export function stripControls(s: string): string {
  return s.replace(CONTROL_PATTERN, '');
}

/** Strip ANSI sequences and control characters. The boundary sanitizer. */
export function sanitizeUserText(s: string): string {
  return stripControls(stripAnsi(s));
}
