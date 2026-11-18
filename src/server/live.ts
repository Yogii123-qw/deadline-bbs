/**
 * src/server/live.ts — In-process live event hub (builder-written, LIVE BOARD + FEDERATION amendment).
 *
 * The hub is the single delivery point for everything that happens "live":
 * a caller posts, slays the Crypt Lord, calls in, hangs up, or sends a
 * direct chat message. The federation layer publishes into the same hub
 * when a remote entry is applied, so local callers see federated posts
 * through the exact same path as local ones. The hub never renders: it
 * hands typed events to per-connection deliver callbacks, which own
 * framing (see buildLiveFrame).
 *
 * Live events are in-process only. They are never forwarded over sync:
 * sync entries carry data, the hub carries moments.
 */

/** A moment worth telling other callers about, while they are connected. */
export type LiveEvent =
  | {
      kind: 'post';
      /** Session id of the originator (never delivered back to it). */
      fromId: string;
      handle: string;
      boardName: string;
      subject: string;
      isReply: boolean;
      /** Set when the post arrived via federation: the origin node's id. */
      originNode?: string;
    }
  | { kind: 'victory'; fromId: string; handle: string; level: number }
  | { kind: 'join'; fromId: string; handle: string; transport: 'telnet' | 'websocket' }
  | { kind: 'leave'; fromId: string; handle: string }
  | { kind: 'chat'; fromId: string; handle: string; message: string };

export type LiveDeliver = (event: LiveEvent) => void;

/**
 * Sender id used for events that did not originate in a local session
 * (federated posts). It matches no subscriber id, so every subscriber
 * receives them.
 */
export const REMOTE_SENDER_ID = '__deadline_remote__';

export class LiveHub {
  private readonly subscribers = new Map<string, LiveDeliver>();
  private readonly onLog: (message: string) => void;

  public constructor(onLog: (message: string) => void = () => undefined) {
    this.onLog = onLog;
  }

  public subscribe(id: string, deliver: LiveDeliver): void {
    this.subscribers.set(id, deliver);
  }

  public unsubscribe(id: string): void {
    this.subscribers.delete(id);
  }

  public subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Deliver to every subscriber except the event's originator. */
  public publish(event: LiveEvent): void {
    for (const [id, deliver] of this.subscribers) {
      if (id === event.fromId) continue;
      this.safeDeliver(id, deliver, event);
    }
  }

  /**
   * Deliver to one subscriber. Returns false when the target is no longer
   * registered (raced disconnect) instead of throwing.
   */
  public sendTo(targetId: string, event: LiveEvent): boolean {
    const deliver = this.subscribers.get(targetId);
    if (deliver === undefined) return false;
    this.safeDeliver(targetId, deliver, event);
    return true;
  }

  private safeDeliver(id: string, deliver: LiveDeliver, event: LiveEvent): void {
    try {
      deliver(event);
    } catch (err) {
      this.onLog(
        `Live delivery to ${id} failed (${event.kind}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * The trailing prompt segment of engine output: everything after the last
 * newline. Screens end with a prompt and no trailing newline, so this is
 * the prompt currently on the caller's screen; output ending in a newline
 * has no pending prompt ('').
 */
export function trailingPrompt(output: string): string {
  const idx = output.lastIndexOf('\n');
  return idx === -1 ? output : output.slice(idx + 1);
}

/**
 * Frame a rendered live notice for delivery over a connection that may be
 * mid-keystroke. The frame clears the current terminal line, prints the
 * notice, then redraws the prompt plus the partial input the caller had
 * already typed — the input buffer itself is never touched, so the caller
 * keeps typing exactly where they were.
 *
 * Honest display limit: only ONE line is cleared. If the partial input
 * wrapped onto several terminal lines, fragments above the last line may
 * remain visible until the next screen render; the buffer stays intact
 * in all cases.
 *
 * `rendered` must not end with a newline. The frame uses "\n" line endings;
 * transports normalize to CRLF on write, as with all engine output.
 */
export function buildLiveFrame(
  rendered: string,
  prompt: string,
  partial: string,
  masked: boolean,
): string {
  const echo = masked ? '*'.repeat(partial.length) : partial;
  return `\r\x1b[2K${rendered}\n${prompt}${echo}`;
}
