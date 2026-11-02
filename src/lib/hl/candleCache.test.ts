import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictCandles, storeCandles, takeCandles } from './candleCache';
import type { Candle } from './types';

// SCOPE NOTE: of the three candleCache rules, this suite fully pins "copies
// both ways" and the pure-cache half of eviction/staleness. The CALL-SITE
// halves — "only clean snapshots stored" (the snapshotClean gate) and "a
// failed gap fetch calls evictCandles" — live in ChartCell's effects and
// remain covered only by the manual browser pass; do not read this file as
// regression safety for those.

const MINUTE = 60_000;

const bar = (t: number): Candle => ({
  t,
  T: t + MINUTE - 1,
  s: 'TEST',
  i: '1m',
  o: '1',
  c: '2',
  h: '3',
  l: '0.5',
  v: '10',
  n: 1,
});

/** Bars ending `barsAgo` intervals before now (fresh enough to heal by default). */
const bars = (n: number, barsAgo = 0): Candle[] => {
  const last = Date.now() - barsAgo * MINUTE;
  return Array.from({ length: n }, (_, i) => bar(last - (n - 1 - i) * MINUTE));
};

// Every test uses its own coin so the module-level cache never bleeds between
// tests (the cache is deliberately a singleton — same as in the app).
let seq = 0;
const coin = () => `TEST${seq++}`;

afterEach(() => vi.restoreAllMocks());

describe('copy semantics: copies both ways', () => {
  it('mutating the stored array after storeCandles never reaches the cache', () => {
    const c = coin();
    const mine = bars(5);
    const stamps = mine.map((b) => b.t);
    storeCandles(c, '1m', mine, 600);
    mine.push(bar(Date.now() + MINUTE));
    const out = takeCandles(c, '1m', 3, MINUTE)!;
    expect(out).toHaveLength(5);
    // note: bar OBJECTS are shared (slice is shallow) — the rule guards the
    // ARRAY identity, which is what live cells push closed bars into
    expect(out.map((b) => b.t)).toEqual(stamps);
  });

  it('mutating a takeCandles result never corrupts the next reader', () => {
    const c = coin();
    storeCandles(c, '1m', bars(5), 600);
    const first = takeCandles(c, '1m', 3, MINUTE)!;
    first.length = 0;
    const second = takeCandles(c, '1m', 3, MINUTE)!;
    expect(second).toHaveLength(5);
  });
});

describe('gap staleness', () => {
  it('returns bars when the gap is within maxGapBars', () => {
    const c = coin();
    storeCandles(c, '1m', bars(5, 2), 600);
    expect(takeCandles(c, '1m', 3, MINUTE)).toHaveLength(5);
  });

  it('drops and returns null when the gap exceeds maxGapBars (full backfill costs the same)', () => {
    const c = coin();
    storeCandles(c, '1m', bars(5, 10), 600);
    expect(takeCandles(c, '1m', 3, MINUTE)).toBeNull();
    // the entry is GONE, not just skipped — a later cheap-heal must not resurrect it
    expect(takeCandles(c, '1m', 1000, MINUTE)).toBeNull();
  });
});

describe('eviction: a failed gap fetch evicts its entry', () => {
  it('evictCandles removes the entry so the next attempt lands on the full-backfill path', () => {
    const c = coin();
    storeCandles(c, '1m', bars(5), 600);
    evictCandles(c, '1m');
    expect(takeCandles(c, '1m', 1000, MINUTE)).toBeNull();
  });

  it('eviction is per (coin, interval) — the sibling interval survives', () => {
    const c = coin();
    storeCandles(c, '1m', bars(5), 600);
    storeCandles(c, '5m', bars(5), 600);
    evictCandles(c, '1m');
    expect(takeCandles(c, '5m', 1000, 5 * MINUTE)).toHaveLength(5);
  });
});

describe('trimming and LRU', () => {
  it('trims stored bars to keepBars, keeping the newest', () => {
    const c = coin();
    const all = bars(10);
    storeCandles(c, '1m', all, 4);
    const out = takeCandles(c, '1m', 3, MINUTE)!;
    expect(out).toHaveLength(4);
    expect(out[0].t).toBe(all[6].t);
    expect(out[3].t).toBe(all[9].t);
  });

  it('ignores empty snapshots (nothing to bank)', () => {
    const c = coin();
    storeCandles(c, '1m', [], 600);
    expect(takeCandles(c, '1m', 1000, MINUTE)).toBeNull();
  });

  it('caps entries at 60, evicting the least recently used', () => {
    // flood with 60 entries so leftovers from earlier tests are deterministically gone
    for (let i = 0; i < 60; i++) storeCandles(coin(), '1m', bars(1), 600);
    const first = coin();
    storeCandles(first, '1m', bars(1), 600);
    const touched = coin();
    storeCandles(touched, '1m', bars(1), 600);
    // touch `first` so `touched` is older than it despite being stored later
    expect(takeCandles(first, '1m', 1000, MINUTE)).not.toBeNull();
    for (let i = 0; i < 59; i++) storeCandles(coin(), '1m', bars(1), 600);
    expect(takeCandles(touched, '1m', 1000, MINUTE)).toBeNull(); // evicted
    expect(takeCandles(first, '1m', 1000, MINUTE)).not.toBeNull(); // survived via touch
  });
});
