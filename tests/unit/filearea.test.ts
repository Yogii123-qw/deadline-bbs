import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileAreaError } from '../../src/shared/errors.js';
import {
  getDownloadInfo,
  isTextFile,
  listFiles,
  mimeTypeFor,
  readFileInline,
  resolveFilePath,
} from '../../src/files/filearea.js';

async function setup(): Promise<{ dir: string; outside: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'deadline-files-'));
  const dir = path.join(root, 'files');
  const outside = path.join(root, 'outside');
  await mkdir(dir, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(dir, 'HELLO.TXT'), 'hello world\nsecond line\n', 'utf8');
  await writeFile(path.join(dir, 'DATA.BIN'), Buffer.from([0, 1, 2, 3]));
  await writeFile(
    path.join(dir, 'descriptions.json'),
    JSON.stringify({ 'HELLO.TXT': 'A greeting.' }),
    'utf8',
  );
  await writeFile(path.join(outside, 'SECRET.TXT'), 'do not serve', 'utf8');
  return { dir, outside };
}

describe('file area', () => {
  it('resolves plain filenames inside the base', async () => {
    const { dir } = await setup();
    try {
      const resolved = await resolveFilePath(dir, 'HELLO.TXT');
      expect(resolved).toBe(path.resolve(dir, 'HELLO.TXT'));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it('rejects traversal, absolute paths, and missing files', async () => {
    const { dir } = await setup();
    try {
      await expect(resolveFilePath(dir, '../SECRET.TXT')).rejects.toBeInstanceOf(FileAreaError);
      await expect(resolveFilePath(dir, '../../etc/passwd')).rejects.toBeInstanceOf(FileAreaError);
      await expect(resolveFilePath(dir, 'sub/../../SECRET.TXT')).rejects.toBeInstanceOf(
        FileAreaError,
      );
      await expect(resolveFilePath(dir, '/etc/passwd')).rejects.toBeInstanceOf(FileAreaError);
      await expect(resolveFilePath(dir, 'MISSING.TXT')).rejects.toBeInstanceOf(FileAreaError);
      await expect(resolveFilePath(dir, '')).rejects.toBeInstanceOf(FileAreaError);
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it('rejects symlinks escaping the base, allows symlinks inside', async () => {
    const { dir, outside } = await setup();
    try {
      await symlink(path.join(outside, 'SECRET.TXT'), path.join(dir, 'ESCAPE.TXT'));
      await expect(resolveFilePath(dir, 'ESCAPE.TXT')).rejects.toBeInstanceOf(FileAreaError);
      await symlink(path.join(dir, 'HELLO.TXT'), path.join(dir, 'ALIAS.TXT'));
      const resolved = await resolveFilePath(dir, 'ALIAS.TXT');
      expect(resolved).toBe(path.resolve(dir, 'HELLO.TXT'));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it('lists files with descriptions, skipping metadata and escaping links', async () => {
    const { dir, outside } = await setup();
    try {
      await symlink(path.join(outside, 'SECRET.TXT'), path.join(dir, 'ESCAPE.TXT'));
      await writeFile(path.join(dir, '.hidden'), 'x', 'utf8');
      const files = await listFiles(dir);
      expect(files.map((f) => f.name)).toEqual(['DATA.BIN', 'HELLO.TXT']);
      expect(files.find((f) => f.name === 'HELLO.TXT')?.description).toBe('A greeting.');
      expect(files.find((f) => f.name === 'HELLO.TXT')?.sizeBytes).toBeGreaterThan(0);
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it('reads text inline, refuses binary and oversized files', async () => {
    const { dir } = await setup();
    try {
      expect(await readFileInline(dir, 'HELLO.TXT')).toBe('hello world\nsecond line\n');
      await expect(readFileInline(dir, 'DATA.BIN')).rejects.toBeInstanceOf(FileAreaError);
      await writeFile(path.join(dir, 'BIG.TXT'), 'x'.repeat(70 * 1024), 'utf8');
      await expect(readFileInline(dir, 'BIG.TXT')).rejects.toBeInstanceOf(FileAreaError);
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it('classifies text files and MIME types', () => {
    expect(isTextFile('A.TXT')).toBe(true);
    expect(isTextFile('a.nfo')).toBe(true);
    expect(isTextFile('a.ans')).toBe(true);
    expect(isTextFile('a.md')).toBe(true);
    expect(isTextFile('a.bin')).toBe(false);
    expect(isTextFile('a')).toBe(false);
    expect(mimeTypeFor('A.TXT')).toContain('text/plain');
    expect(mimeTypeFor('A.BIN')).toBe('application/octet-stream');
  });

  it('resolves downloads with size and MIME', async () => {
    const { dir } = await setup();
    try {
      const info = await getDownloadInfo(dir, 'DATA.BIN');
      expect(info.sizeBytes).toBe(4);
      expect(info.mimeType).toBe('application/octet-stream');
      await expect(getDownloadInfo(dir, '../SECRET.TXT')).rejects.toBeInstanceOf(FileAreaError);
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });
});
