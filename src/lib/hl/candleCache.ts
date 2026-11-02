import type { Candle } from './types';

/**
 * Session-scoped candle cache: bars go in when a cell tears down (the
 * moment they stop being mutated) and come back out when any cell revisits
 * that (coin, interval) — the revisit repaints instantly from memory and
 * heals only the gap since the last cached bar (~20 weight) instead of
 * paying a full backfill (~30 weight). An interval tour's return legs
 * become near-free, which is what keeps exploratory retiming inside the
 * 1200 weight/min/IP budget.
 *
 * Entries are trimmed to the standard backfill depth (deep loadOlder
 * history is re-paged on demand) and handed out as COPIES — two cells
 * showing the same market must never share a mutable bars array, or both
 * would push the same closed bars into one buffer.
 */

const MAX_ENTRIES = 60; // 24 cells × a few intervals; ~2MB worst case

const cache = new Map<string, Candle[]>();

export function storeCandles(
  coin: string,
  interval: string,
  bars: Candle[],
  keepBars: number,
): void {
  if (bars.length === 0) return;
  const key = `${coin}|${interval}`;
  cache.delete(key); // re-insert = move to the young end of the Map order
  cache.set(key, bars.length > keepBars ? bars.slice(-keepBars) : bars.slice());
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Drop an entry whose gap fetch just failed: the next attempt must land on
 *  the FULL backfill path (which can reach the error overlay and the paced
 *  self-heal) instead of resuming the same stale bars in a tight loop. */
export function evictCandles(coin: string, interval: string): void {
  cache.delete(`${coin}|${interval}`);
}

/** A copy of the cached bars, or null when absent / too stale to heal
 *  cheaply (gap beyond maxGapBars — a full backfill costs the same then). */
export function takeCandles(
  coin: string,
  interval: string,
  maxGapBars: number,
  intervalMs: number,
): Candle[] | null {
  const key = `${coin}|${interval}`;
  const entry = cache.get(key);
  if (!entry || entry.length === 0) return null;
  const gapBars = Math.floor((Date.now() - entry[entry.length - 1].t) / intervalMs);
  if (gapBars > maxGapBars) {
    cache.delete(key);
    return null;
  }
  // touch: revisited pairs are the likeliest to be revisited again
  cache.delete(key);
  cache.set(key, entry);
  return entry.slice();
}
