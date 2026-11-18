/**
 * src/server/http.ts — HTTP server (builder-written, per design §2.17).
 *
 * Serves the Vite-built web client from the public directory, file
 * downloads at /files/:name (same traversal guard as the file area), and
 * delegates WebSocket upgrades on /ws to the bridge.
 */

import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { getDownloadInfo } from '../files/filearea.js';
import { FileAreaError } from '../shared/errors.js';
import type { ApiHandler } from '../sync/api.js';
import type { RunningServer } from './telnet.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface HttpServerOptions {
  port: number;
  publicDir: string;
  filesDir: string;
  onUpgrade: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void;
  onLog?: (message: string) => void;
  /** Optional handler for /sync/exchange and /api/*. Runs before the
   *  method check: the sync endpoint needs POST. */
  onApi?: ApiHandler;
}

function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

export function startHttpServer(options: HttpServerOptions): Promise<RunningServer> {
  const { publicDir, filesDir, onUpgrade } = options;
  const onLog = options.onLog ?? (() => undefined);

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;

        if (
          options.onApi !== undefined &&
          (pathname === '/sync/exchange' || pathname.startsWith('/api/'))
        ) {
          const handled = await options.onApi(req, res);
          if (handled) return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendText(res, 405, 'Method not allowed.');
          return;
        }

        if (pathname.startsWith('/files/')) {
          const rawName = pathname.slice('/files/'.length);
          let filename: string;
          try {
            filename = decodeURIComponent(rawName);
          } catch {
            sendText(res, 400, 'Bad filename.');
            return;
          }
          try {
            const info = await getDownloadInfo(filesDir, filename);
            const safeName = filename.replace(/["\r\n]/g, '_');
            res.writeHead(200, {
              'content-type': info.mimeType,
              'content-length': info.sizeBytes,
              'content-disposition': `attachment; filename="${safeName}"`,
            });
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            createReadStream(info.filePath).pipe(res);
          } catch (err) {
            if (err instanceof FileAreaError) {
              sendText(res, 404, 'File not found.');
            } else {
              throw err;
            }
          }
          return;
        }

        const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
        const resolved = path.resolve(publicDir, rel);
        const base = path.resolve(publicDir);
        if (resolved !== base && !resolved.startsWith(base + path.sep)) {
          sendText(res, 404, 'Not found.');
          return;
        }
        let stat;
        try {
          stat = await fs.stat(resolved);
        } catch {
          if (pathname === '/') {
            sendText(
              res,
              503,
              'Web client not built. Run: npm run build\n',
            );
            return;
          }
          sendText(res, 404, 'Not found.');
          return;
        }
        if (!stat.isFile()) {
          sendText(res, 404, 'Not found.');
          return;
        }
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
          'content-length': stat.size,
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(resolved).pipe(res);
      } catch (err) {
        onLog(`HTTP handler error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          sendText(res, 500, 'Internal error.');
        } else {
          res.destroy();
        }
      }
    })();
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws') {
      // Node declares the upgrade socket as Duplex; for HTTP upgrades it is
      // always a TCP socket, which is what the WebSocket bridge expects.
      onUpgrade(req, socket as net.Socket, head);
    } else {
      socket.destroy();
    }
  });

  return new Promise<RunningServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, () => {
      const address = server.address();
      const actualPort =
        typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
