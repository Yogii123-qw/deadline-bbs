/**
 * src/game/scores.ts — Hall of Fame persistence (builder-written, per design §2.11).
 */

import type { HallOfFameEntry } from '../shared/types.js';
import type { ScoresData } from '../shared/validation.js';
import type { AtomicStore } from '../boards/store.js';

export class ScoreStore {
  private readonly store: AtomicStore<ScoresData>;

  public constructor(store: AtomicStore<ScoresData>) {
    this.store = store;
  }

  public async recordVictory(handle: string, level: number, now: Date): Promise<void> {
    const entry: HallOfFameEntry = {
      handle,
      level,
      timestamp: now.toISOString(),
    };
    await this.store.write((data) => ({
      entries: [...data.entries, entry],
    }));
  }

  /** Victories sorted by level descending, then timestamp ascending (R6.6). */
  public async getHallOfFame(): Promise<HallOfFameEntry[]> {
    const data = await this.store.read();
    return [...data.entries].sort((a, b) => {
      if (a.level !== b.level) return b.level - a.level;
      if (a.timestamp === b.timestamp) return 0;
      return a.timestamp < b.timestamp ? -1 : 1;
    });
  }
}
