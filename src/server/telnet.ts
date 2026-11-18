/**
 * src/server/telnet.ts — TCP listener (builder-written, per design §2.16).
 *
 * Wires a raw TCP socket to the session engine through the RFC 854
 * negotiator and the line reader. Input from one connection is processed
 * strictly in order via a per-connection promise chain.
 */

import * as net from 'node:net';
import { TelnetNegotiator } from '../telnet/negotiation.js';
import { LineReader } from '../session/input.js';
import {
  newSession,
  processInput,
  type EngineDeps,
} from '../session/engine.js';
import { formatElapsed } from '../session/screens.js';

/** Engine output uses "\n"; telnet clients need CRLF. */
export function toCRLF(output: string): string {
  return output.replace(/\r?\n/g, '\r\n');
}

export interface TelnetServerOptions {
  port: number;
  deps: EngineDeps;
  onLog?: (message: string) => void;
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

const PASSCODE_PHASES = new Set(['PASSCODE_PROMPT', 'CONFIRM_PASSCODE']);

export function startTelnetServer(options: TelnetServerOptions): Promise<RunningServer> {
  const { deps, port } = options;
  const onLog = options.onLog ?? (() => undefined);
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const negotiator = new TelnetNegotiator();
    const lineReader = new LineReader();
    let state = newSession('telnet', deps.now());
    let chain: Promise<void> = Promise.resolve();

    const cleanup = (): void => {
      sockets.delete(socket);
      const wasOnline = deps.activeSessions.delete(state.id);
      if (state.handle !== null) {
        onLog(
          `Call ended: ${state.handle} (${state.transport}, ${formatElapsed(state.connectedAt, deps.now())}${wasOnline ? '' : ', was not in online list'})`,
        );
      }
    };

    socket.on('error', (err) => {
      onLog(`Telnet socket error: ${err.message}`);
      socket.destroy();
    });
    socket.on('close', cleanup);

    const handleData = async (chunk: Buffer): Promise<void> => {
      const { data, responses, naws } = negotiator.feed(chunk);
      if (responses.length > 0) {
        socket.write(responses);
      }
      if (naws !== null) {
        state = { ...state, terminalWidth: naws.width, terminalHeight: naws.height };
      }
      if (data.length === 0) return;
      const mode = PASSCODE_PHASES.has(state.phase) ? 'mask' : 'echo';
      const { lines, echo, overflow } = lineReader.feed(data.toString('utf8'), mode);
      if (echo !== '') {
        socket.write(echo);
      }
      if (overflow) {
        socket.write('\r\n  !! Line too long. Keep lines under 1024 characters.\r\n');
      }
      for (const line of lines) {
        const out = await processInput({ state, input: line, deps });
        state = out.state;
        if (out.output !== '') {
          socket.write(toCRLF(out.output));
        }
        if (state.phase === 'LOGOFF') {
          socket.end();
          return;
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      chain = chain
        .then(() => handleData(chunk))
        .catch((err: unknown) => {
          onLog(`Telnet handler error: ${err instanceof Error ? err.message : String(err)}`);
        });
    });

    // Send the negotiation bundle, then the splash + handle prompt.
    socket.write(negotiator.initialSequence());
    chain = chain
      .then(async () => {
        const out = await processInput({ state, input: '', deps });
        state = out.state;
        if (out.output !== '') {
          socket.write(toCRLF(out.output));
        }
      })
      .catch((err: unknown) => {
        onLog(`Telnet greeting error: ${err instanceof Error ? err.message : String(err)}`);
        socket.destroy();
      });
  });

  return new Promise<RunningServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}
