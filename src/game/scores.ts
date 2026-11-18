/**
 * src/game/scores.ts — Hall of Fame persistence (builder-written, per design §2.11).
 *
 * PRO-DEV amendment: federated scores. Victories won on other nodes arrive
 * through the sync log as `score` entries and are stored in `network`
 * with their origin node and entry id. Recording is idempotent by entry
 * id: a replayed score entry is a no-op. Attribution is display-level,
 * not cryptographic (see the mechanism review in the PRO-DEV amendment).
 */

import type { HallOfFameEntry } from '../shared/types.js';
import type { NetworkScore, ScoresData } from '../shared/validation.js';
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
      network: data.network,
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

  /**
   * Record a federated score. Returns false when a score with this entry
   * id is already stored (replay = no-op). The caller owns validation
   * (see sync/engine.ts cleanScore).
   */
  public async recordNetworkScore(score: NetworkScore): Promise<boolean> {
    let recorded = false;
    await this.store.write((data) => {
      if (data.network.some((s) => s.entryId === score.entryId)) return data;
      recorded = true;
      return { ...data, network: [...data.network, score] };
    });
    return recorded;
  }

  /** Federated scores, sorted like the local Hall of Fame (R6.6). */
  public async getNetworkScores(): Promise<NetworkScore[]> {
    const data = await this.store.read();
    return [...data.network].sort((a, b) => {
      if (a.level !== b.level) return b.level - a.level;
      if (a.timestamp === b.timestamp) return 0;
      return a.timestamp < b.timestamp ? -1 : 1;
    });
  }
}
