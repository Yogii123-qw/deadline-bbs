/**
 * src/server/ws-bridge.ts — WebSocket-to-session bridge (builder-written, per design §2.18).
 *
 * Each WebSocket gets its own SessionState driving the same engine as
 * telnet. Resize frames ({type:'resize', cols, rows}) are validated with
 * Zod; every other text frame is raw terminal input.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { LineReader } from '../session/input.js';
import {
  newSession,
  processInput,
  type EngineDeps,
} from '../session/engine.js';
import { formatElapsed } from '../session/screens.js';
import { zResizeFrame } from '../shared/validation.js';
import { toCRLF } from './telnet.js';

const PASSCODE_PHASES = new Set(['PASSCODE_PROMPT', 'CONFIRM_PASSCODE']);

export function createWsBridge(deps: EngineDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => attachConnection(ws, deps));
  return wss;
}

export function attachConnection(ws: WebSocket, deps: EngineDeps): void {
  const onLog = deps.onLog;
  const lineReader = new LineReader();
  let state = newSession('websocket', deps.now());
  let chain: Promise<void> = Promise.resolve();
  let cleanedUp = false;

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    deps.activeSessions.delete(state.id);
    if (state.handle !== null) {
      onLog(
        `Call ended: ${state.handle} (${state.transport}, ${formatElapsed(state.connectedAt, deps.now())})`,
      );
    }
  };

  ws.on('error', (err) => {
    onLog(`WebSocket error: ${err.message}`);
  });
  ws.on('close', cleanup);

  const handleMessage = async (raw: Buffer): Promise<void> => {
    const text = raw.toString('utf8');
    if (text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text);
        const resize = zResizeFrame.safeParse(parsed);
        if (resize.success) {
          state = {
            ...state,
            terminalWidth: resize.data.cols,
            terminalHeight: resize.data.rows,
          };
          return;
        }
      } catch {
        // Not JSON: fall through and treat it as terminal input.
      }
    }
    const mode = PASSCODE_PHASES.has(state.phase) ? 'mask' : 'echo';
    const { lines, echo, overflow } = lineReader.feed(text, mode);
    if (echo !== '') {
      ws.send(echo);
    }
    if (overflow) {
      ws.send('\r\n  !! Line too long. Keep lines under 1024 characters.\r\n');
    }
    for (const line of lines) {
      const out = await processInput({ state, input: line, deps });
      state = out.state;
      if (out.output !== '') {
        ws.send(toCRLF(out.output));
      }
      if (state.phase === 'LOGOFF') {
        ws.close();
        return;
      }
    }
  };

  ws.on('message', (raw: Buffer) => {
    chain = chain
      .then(() => handleMessage(raw))
      .catch((err: unknown) => {
        onLog(`WebSocket handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
  });

  chain = chain
    .then(async () => {
      const out = await processInput({ state, input: '', deps });
      state = out.state;
      if (out.output !== '') {
        ws.send(toCRLF(out.output));
      }
    })
    .catch((err: unknown) => {
      onLog(`WebSocket greeting error: ${err instanceof Error ? err.message : String(err)}`);
      ws.close();
    });
}
