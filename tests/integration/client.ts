/**
 * tests/integration/client.ts — Raw socket test clients (no mocks).
 */

import * as net from 'node:net';
import { WebSocket } from 'ws';
import { stripAnsi } from '../../src/telnet/ansi.js';

// Socket waits default to 20s, not 5s: a PBKDF2 login (~2.9s per hash
// on a slow machine) can push registration past 5s under suite load,
// which failed live.test.ts in the 19 Nov 2026 audit with a waitFor
// timeout even though the server answered correctly.
export async function waitFor(
  check: () => boolean,
  timeoutMs = 20000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Minimal raw TCP client that records everything the server sends. */
export class RawTelnetClient {
  public readonly chunks: Buffer[] = [];
  private socket: net.Socket | null = null;
  private closed = false;

  public get text(): string {
    return Buffer.concat(this.chunks).toString('latin1');
  }

  public get plain(): string {
    return stripAnsi(this.text);
  }

  public get bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public static async connect(port: number): Promise<RawTelnetClient> {
    const client = new RawTelnetClient();
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => resolve());
      socket.once('error', reject);
      socket.on('data', (chunk: Buffer) => client.chunks.push(chunk));
      socket.on('close', () => {
        client.closed = true;
      });
      client.socket = socket;
    });
    return client;
  }

  public send(text: string): void {
    this.socket?.write(text, 'latin1');
  }

  public sendBytes(bytes: number[]): void {
    this.socket?.write(Buffer.from(bytes));
  }

  public async waitFor(needle: string, timeoutMs = 20000): Promise<void> {
    await waitFor(() => this.text.includes(needle), timeoutMs, `telnet output ${JSON.stringify(needle)}`);
  }

  public async waitForPlain(needle: string, timeoutMs = 20000): Promise<void> {
    await waitFor(() => this.plain.includes(needle), timeoutMs, `telnet text ${JSON.stringify(needle)}`);
  }

  public destroy(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  public end(): void {
    this.socket?.end();
  }
}

/** Minimal WebSocket client that records everything the server sends. */
export class WsClient {
  public readonly messages: string[] = [];
  private ws: WebSocket | null = null;
  private closed = false;

  public get text(): string {
    return this.messages.join('');
  }

  public get plain(): string {
    return stripAnsi(this.text);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public static async connect(port: number): Promise<WsClient> {
    const client = new WsClient();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.on('message', (data: Buffer) => client.messages.push(data.toString('utf8')));
      ws.on('close', () => {
        client.closed = true;
      });
      client.ws = ws;
    });
    return client;
  }

  public send(text: string): void {
    this.ws?.send(text);
  }

  public async waitFor(needle: string, timeoutMs = 20000): Promise<void> {
    await waitFor(() => this.text.includes(needle), timeoutMs, `ws output ${JSON.stringify(needle)}`);
  }

  public async waitForPlain(needle: string, timeoutMs = 20000): Promise<void> {
    await waitFor(() => this.plain.includes(needle), timeoutMs, `ws text ${JSON.stringify(needle)}`);
  }

  public close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
