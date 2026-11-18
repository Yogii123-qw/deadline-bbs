/**
 * src/telnet/negotiation.ts — Stateful RFC 854 IAC parser (builder-written, per design §2.4).
 *
 * Tolerates split packets: a partial IAC sequence at the end of a chunk is
 * held in parser state and completed when the next chunk arrives (R1.3).
 * Responses are emitted only on state changes, so negotiation can never
 * loop (R1.2).
 */

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;

export const OPT_ECHO = 1;
export const OPT_SGA = 3;
export const OPT_NAWS = 31;

export interface NawsSize {
  width: number;
  height: number;
}

export interface NegotiationOutput {
  /** Printable bytes to pass to the session engine. */
  data: Buffer;
  /** Negotiation response bytes to write back to the client. */
  responses: Buffer;
  /** Terminal size from a NAWS sub-negotiation in this chunk, if any. */
  naws: NawsSize | null;
}

type ParserState = 'data' | 'iac' | 'will' | 'wont' | 'do' | 'dont' | 'sb-option' | 'sb' | 'sb-iac';

export class TelnetNegotiator {
  private state: ParserState = 'data';
  private sbOption = 0;
  private sbData: number[] = [];
  /** What the client currently believes the server will do, per option. */
  private readonly serverState = new Map<number, boolean>();
  /** What the server currently believes the client will do, per option. */
  private readonly clientState = new Map<number, boolean>();

  public constructor() {
    // We offer WILL ECHO + WILL SGA in the initial sequence, so record
    // those as already-offered: a client DO for them needs no reply.
    this.serverState.set(OPT_ECHO, true);
    this.serverState.set(OPT_SGA, true);
  }

  /** The initial option bundle sent on every new connection (R1.1). */
  public initialSequence(): Buffer {
    return Buffer.from([
      IAC, WILL, OPT_ECHO,
      IAC, WILL, OPT_SGA,
      IAC, DO, OPT_SGA,
      IAC, DO, OPT_NAWS,
    ]);
  }

  private serverWants(option: number): boolean {
    return option === OPT_ECHO || option === OPT_SGA;
  }

  private clientWants(option: number): boolean {
    return option === OPT_SGA || option === OPT_NAWS;
  }

  public feed(chunk: Buffer): NegotiationOutput {
    const data: number[] = [];
    const responses: number[] = [];
    let naws: NawsSize | null = null;

    const pushResponse = (command: number, option: number): void => {
      responses.push(IAC, command, option);
    };

    const handleWill = (option: number): void => {
      if (this.clientState.get(option) === true) return;
      this.clientState.set(option, true);
      pushResponse(this.clientWants(option) ? DO : DONT, option);
    };
    const handleWont = (option: number): void => {
      if (this.clientState.get(option) === false) return;
      this.clientState.set(option, false);
    };
    const handleDo = (option: number): void => {
      if (this.serverState.get(option) === true) return;
      this.serverState.set(option, true);
      pushResponse(this.serverWants(option) ? WILL : WONT, option);
    };
    const handleDont = (option: number): void => {
      if (this.serverState.get(option) === false) return;
      this.serverState.set(option, false);
    };

    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) {
            this.state = 'iac';
          } else {
            data.push(byte);
          }
          break;
        case 'iac':
          if (byte === IAC) {
            data.push(IAC);
            this.state = 'data';
          } else if (byte === WILL) {
            this.state = 'will';
          } else if (byte === WONT) {
            this.state = 'wont';
          } else if (byte === DO) {
            this.state = 'do';
          } else if (byte === DONT) {
            this.state = 'dont';
          } else if (byte === SB) {
            this.state = 'sb-option';
          } else {
            // SE outside sub-negotiation, NOP, and other bare commands: ignore.
            this.state = 'data';
          }
          break;
        case 'will':
          handleWill(byte);
          this.state = 'data';
          break;
        case 'wont':
          handleWont(byte);
          this.state = 'data';
          break;
        case 'do':
          handleDo(byte);
          this.state = 'data';
          break;
        case 'dont':
          handleDont(byte);
          this.state = 'data';
          break;
        case 'sb-option':
          this.sbOption = byte;
          this.sbData = [];
          this.state = 'sb';
          break;
        case 'sb':
          if (byte === IAC) {
            this.state = 'sb-iac';
          } else {
            this.sbData.push(byte);
          }
          break;
        case 'sb-iac':
          if (byte === SE) {
            if (this.sbOption === OPT_NAWS && this.sbData.length >= 4) {
              const width = this.sbData[0] * 256 + this.sbData[1];
              const height = this.sbData[2] * 256 + this.sbData[3];
              if (width >= 1 && width <= 1000 && height >= 1 && height <= 1000) {
                naws = { width, height };
              }
            }
            this.state = 'data';
          } else if (byte === IAC) {
            this.sbData.push(IAC);
            this.state = 'sb';
          } else {
            // Malformed sequence: treat the byte as sub-negotiation data.
            this.sbData.push(byte);
            this.state = 'sb';
          }
          break;
      }
    }

    return { data: Buffer.from(data), responses: Buffer.from(responses), naws };
  }
}
