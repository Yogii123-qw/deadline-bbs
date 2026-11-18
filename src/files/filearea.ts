/**
 * src/files/filearea.ts — File area operations (builder-written, per design §2.12).
 *
 * Path-traversal guard (R7.4): every user-supplied name is resolved against
 * the files/ base directory and rejected if it escapes — including through
 * symlinks. Nothing outside files/ is ever served.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileEntry } from '../shared/types.js';
import { FileAreaError } from '../shared/errors.js';

export const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.nfo', '.ans', '.asc', '.diz']);
export const MAX_INLINE_BYTES = 64 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.nfo': 'text/plain; charset=utf-8',
  '.ans': 'text/plain; charset=utf-8',
  '.asc': 'text/plain; charset=utf-8',
  '.diz': 'text/plain; charset=utf-8',
};

export function isTextFile(filename: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function mimeTypeFor(filename: string): string {
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function guardInside(baseDir: string, resolved: string): void {
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new FileAreaError('Path traversal rejected.');
  }
}

/**
 * Resolve a user-supplied filename against the file area. Throws
 * FileAreaError on traversal, symlink escape, or missing file.
 */
export async function resolveFilePath(filesDir: string, filename: string): Promise<string> {
  if (filename.length === 0 || filename.includes('\0')) {
    throw new FileAreaError('Invalid filename.');
  }
  if (path.isAbsolute(filename)) {
    throw new FileAreaError('Path traversal rejected.');
  }
  const resolved = path.resolve(filesDir, filename);
  guardInside(filesDir, resolved);
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch {
    throw new FileAreaError('File not found.');
  }
  if (stat.isSymbolicLink()) {
    const real = await fs.realpath(resolved);
    guardInside(filesDir, real);
    return real;
  }
  if (!stat.isFile()) {
    throw new FileAreaError('File not found.');
  }
  return resolved;
}

async function readDescriptions(filesDir: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(filesDir, 'descriptions.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * List servable files in the file area. Entries that fail the traversal
 * guard (e.g. symlinks escaping files/) are silently excluded: they are
 * not servable, so they are not advertised either.
 */
export async function listFiles(filesDir: string): Promise<FileEntry[]> {
  const descriptions = await readDescriptions(filesDir);
  let names: string[];
  try {
    names = await fs.readdir(filesDir);
  } catch {
    throw new FileAreaError('File area is unavailable.');
  }
  const entries: FileEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name === 'descriptions.json' || name.startsWith('.')) continue;
    let resolved: string;
    try {
      resolved = await resolveFilePath(filesDir, name);
    } catch {
      continue;
    }
    const stat = await fs.stat(resolved);
    entries.push({
      name,
      sizeBytes: stat.size,
      description: descriptions[name] ?? '',
    });
  }
  return entries;
}

/** Read a text file for inline paged display. Binary files are refused. */
export async function readFileInline(filesDir: string, filename: string): Promise<string> {
  const resolved = await resolveFilePath(filesDir, filename);
  if (!isTextFile(filename)) {
    throw new FileAreaError('That file cannot be displayed as text. Download it instead.');
  }
  const stat = await fs.stat(resolved);
  if (stat.size > MAX_INLINE_BYTES) {
    throw new FileAreaError('That file is too large to display inline. Download it instead.');
  }
  return fs.readFile(resolved, 'utf8');
}

export interface DownloadInfo {
  filePath: string;
  sizeBytes: number;
  mimeType: string;
}

/** Resolve a file for HTTP download (any file type; same traversal guard). */
export async function getDownloadInfo(
  filesDir: string,
  filename: string,
): Promise<DownloadInfo> {
  const resolved = await resolveFilePath(filesDir, filename);
  const stat = await fs.stat(resolved);
  return { filePath: resolved, sizeBytes: stat.size, mimeType: mimeTypeFor(filename) };
}
