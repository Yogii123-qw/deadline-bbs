/**
 * web/main.ts — xterm.js web terminal client (builder-written).
 *
 * Connects to the same session engine as telnet over a WebSocket. The
 * status indicator reflects the real socket state; nothing here is faked.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const wrap = document.getElementById('terminal-wrap');
const termEl = document.getElementById('terminal');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const reconnectBtn = document.getElementById('reconnect');
const telnetCmd = document.getElementById('telnet-cmd');

if (wrap === null || termEl === null || statusDot === null || statusText === null || reconnectBtn === null) {
  throw new Error('DeadLine BBS: page shell is missing required elements.');
}

if (telnetCmd !== null) {
  telnetCmd.textContent = `telnet ${window.location.hostname || 'localhost'} 2323`;
}

const term = new Terminal({
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
  fontSize: window.innerWidth < 640 ? 13 : 15,
  lineHeight: 1.15,
  scrollback: 1000,
  theme: {
    background: '#0d0a04',
    foreground: '#ffb000',
    cursor: '#ffb000',
    cursorAccent: '#0d0a04',
    selectionBackground: 'rgba(255, 176, 0, 0.28)',
    selectionForeground: '#fff3d6',
    black: '#1a1206',
    red: '#ff5a4e',
    green: '#8fbf5f',
    yellow: '#ffb000',
    blue: '#6a9fd8',
    magenta: '#d478c2',
    cyan: '#4ec2b8',
    white: '#e8dcc0',
    brightBlack: '#8a7a4d',
    brightRed: '#ff7a6e',
    brightGreen: '#a8d67e',
    brightYellow: '#ffd34d',
    brightBlue: '#8ab8e8',
    brightMagenta: '#e09ad2',
    brightCyan: '#6ed8ce',
    brightWhite: '#fff3d6',
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(termEl);

let socket: WebSocket | null = null;

function setStatus(state: 'connecting' | 'online' | 'offline'): void {
  statusDot?.classList.toggle('on', state === 'online');
  statusDot?.classList.toggle('off', state === 'offline');
  if (statusText !== null) {
    statusText.textContent =
      state === 'online' ? 'ONLINE' : state === 'offline' ? 'OFFLINE' : 'CONNECTING';
  }
  if (reconnectBtn !== null) {
    reconnectBtn.hidden = state !== 'offline';
  }
}

function sendResize(): void {
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function fitAndResize(): void {
  fit.fit();
  sendResize();
}

function connect(): void {
  setStatus('connecting');
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    setStatus('online');
    fitAndResize();
    term.focus();
  });

  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      term.write(event.data);
    } else if (event.data instanceof Blob) {
      void event.data.text().then((text) => term.write(text));
    } else if (event.data instanceof ArrayBuffer) {
      term.write(new TextDecoder().decode(event.data));
    }
  });

  const goOffline = (): void => {
    setStatus('offline');
    term.write('\r\n*** Connection closed. Press Reconnect to call back. ***\r\n');
  };
  socket.addEventListener('close', goOffline);
  socket.addEventListener('error', goOffline);
}

term.onData((data: string) => {
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
});

reconnectBtn.addEventListener('click', () => {
  term.clear();
  connect();
});

wrap.addEventListener('click', () => term.focus());
window.addEventListener('resize', fitAndResize);
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(fitAndResize).observe(wrap);
}

fit.fit();
connect();
