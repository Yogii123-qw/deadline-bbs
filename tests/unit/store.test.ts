import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AtomicStore } from '../../src/boards/store.js';
import { StoreError } from '../../src/shared/errors.js';

const zCounter = z.object({ count: z.number().int(), items: z.array(z.string()) });
type Counter = z.infer<typeof zCounter>;

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'deadline-store-'));
}

describe('AtomicStore', () => {
  it('writes and reads back', async () => {
    const dir = await tmpDir();
    try {
      const store = new AtomicStore<Counter>(path.join(dir, 'c.json'), zCounter, {
        count: 0,
        items: [],
      });
      await store.write((c) => ({ count: 1, items: [...c.items, 'a'] }));
      expect(await store.read()).toEqual({ count: 1, items: ['a'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('seeds silently when the file is missing', async () => {
    const dir = await tmpDir();
    const warnings: string[] = [];
    try {
      const store = new AtomicStore<Counter>(
        path.join(dir, 'missing.json'),
        zCounter,
        { count: 7, items: [] },
        (m) => warnings.push(m),
      );
      expect(await store.read()).toEqual({ count: 7, items: [] });
      expect(warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to seed with a warning on corrupt JSON', async () => {
    const dir = await tmpDir();
    const warnings: string[] = [];
    try {
      const file = path.join(dir, 'bad.json');
      await writeFile(file, '{not json', 'utf8');
      const store = new AtomicStore<Counter>(file, zCounter, { count: 3, items: [] }, (m) =>
        warnings.push(m),
      );
      expect(await store.read()).toEqual({ count: 3, items: [] });
      expect(warnings).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to seed with a warning on schema failure', async () => {
    const dir = await tmpDir();
    const warnings: string[] = [];
    try {
      const file = path.join(dir, 'wrong.json');
      await writeFile(file, JSON.stringify({ count: 'lots' }), 'utf8');
      const store = new AtomicStore<Counter>(file, zCounter, { count: 3, items: [] }, (m) =>
        warnings.push(m),
      );
      expect(await store.read()).toEqual({ count: 3, items: [] });
      expect(warnings).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes: none lost', async () => {
    const dir = await tmpDir();
    try {
      const store = new AtomicStore<Counter>(path.join(dir, 'c.json'), zCounter, {
        count: 0,
        items: [],
      });
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.write((c) => ({ count: c.count + 1, items: [...c.items, `i${i}`] })),
        ),
      );
      const data = await store.read();
      expect(data.count).toBe(20);
      expect(data.items).toHaveLength(20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to persist invalid data and leaves the file unchanged', async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, 'c.json');
      const store = new AtomicStore<Counter>(file, zCounter, { count: 0, items: [] });
      await store.write((c) => ({ ...c, count: 5 }));
      await expect(
        store.write(() => ({ count: 'boom', items: [] }) as unknown as Counter),
      ).rejects.toBeInstanceOf(StoreError);
      expect(await store.read()).toEqual({ count: 5, items: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves no temp files behind', async () => {
    const dir = await tmpDir();
    try {
      const store = new AtomicStore<Counter>(path.join(dir, 'c.json'), zCounter, {
        count: 0,
        items: [],
      });
      await store.write((c) => ({ ...c, count: 1 }));
      const names = await readdir(dir);
      expect(names).toEqual(['c.json']);
      const raw = await readFile(path.join(dir, 'c.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual({ count: 1, items: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws StoreError on non-ENOENT read failures', async () => {
    const dir = await tmpDir();
    try {
      const store = new AtomicStore<Counter>(dir, zCounter, { count: 0, items: [] });
      await expect(store.read()).rejects.toBeInstanceOf(StoreError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the queue alive after a failed write', async () => {
    const dir = await tmpDir();
    try {
      const store = new AtomicStore<Counter>(path.join(dir, 'c.json'), zCounter, {
        count: 0,
        items: [],
      });
      await expect(
        store.write(() => {
          throw new Error('updater blew up');
        }),
      ).rejects.toThrow('updater blew up');
      await store.write((c) => ({ ...c, count: 9 }));
      expect((await store.read()).count).toBe(9);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
