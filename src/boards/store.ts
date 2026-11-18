/**
 * src/boards/store.ts — Generic atomic JSON store (builder-written, per design §2.6).
 *
 * Guarantees (R5):
 * - Every write is atomic: temp file in the same directory, then rename.
 * - Writes to the same file are serialized through a promise queue, so
 *   concurrent sessions can never interleave or lose each other's writes.
 * - Reads validate with Zod; a missing file seeds silently, a corrupt file
 *   warns and seeds. Other I/O failures throw StoreError (fail loudly rather
 *   than risk overwriting good data with a seed).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { StoreError } from '../shared/errors.js';

/** Minimal structural schema interface: anything with a validating parse. */
export interface StoreSchema<T> {
  parse: (data: unknown) => T;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

export class AtomicStore<T> {
  private readonly filePath: string;
  private readonly schema: StoreSchema<T>;
  private readonly seed: T;
  private readonly onWarning: (message: string) => void;
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    filePath: string,
    schema: StoreSchema<T>,
    seed: T,
    onWarning: (message: string) => void = (message) => console.warn(message),
  ) {
    this.filePath = filePath;
    this.schema = schema;
    this.seed = seed;
    this.onWarning = onWarning;
  }

  public async read(): Promise<T> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (isEnoent(err)) {
        return cloneJson(this.seed);
      }
      throw new StoreError(`Failed to read ${this.filePath}`, { cause: err });
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return this.schema.parse(parsed);
    } catch (err) {
      this.onWarning(
        `WARNING: ${this.filePath} failed validation (${err instanceof Error ? err.message : 'unknown error'}); starting from seeded state.`,
      );
      return cloneJson(this.seed);
    }
  }

  public async write(updater: (current: T) => T): Promise<void> {
    const task = this.queue.then(async () => {
      const current = await this.read();
      const next = updater(current);
      let validated: T;
      try {
        validated = this.schema.parse(next);
      } catch (err) {
        throw new StoreError(`Refusing to persist invalid data to ${this.filePath}`, {
          cause: err,
        });
      }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      try {
        await fs.writeFile(tmpPath, JSON.stringify(validated, null, 2), 'utf8');
        await fs.rename(tmpPath, this.filePath);
      } catch (err) {
        await fs.rm(tmpPath, { force: true }).catch(() => undefined);
        throw new StoreError(`Failed to write ${this.filePath}`, { cause: err });
      }
    });
    // Keep the chain alive after a failure; the caller still sees the error.
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
  }
}
