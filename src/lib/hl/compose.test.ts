import { describe, expect, it } from 'vitest';
import {
  LiveComposer,
  barRule,
  composeStats,
  mergeLegs,
  precisionFor,
  toCandle,
  type Bar,
  type Fn,
} from './compose';

// Invented ids only — the fixture must never drift with HL's real catalog.
const MINUTE = 60_000;
const ratio: Fn = (v) => v[0] / v[1];
const spread: Fn = (v) => v[0] - v[1];
const avg3: Fn = (v) => (v[0] + v[1] + v[2]) / 3;

const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });
/** A bar whose four prices are all `p` (what a flat fill looks like). */
const flat = (t: number, p: number): Bar => bar(t, p, p, p, p);
/** Minute bars at 0, 1, 2, … with the prices given per bucket. */
const series = (prices: Array<[number, number, number, number]>): Bar[] =>
  prices.map(([o, h, l, c], k) => bar(k * MINUTE, o, h, l, c));

describe('barRule (the measured rule)', () => {
  it('re-orders an inverted ratio wick: h ≥ max(o,c) ≥ min(o,c) ≥ l', () => {
    // A 101/99 around 100, B 110/90 around 100: element-wise A.h/B.h = 0.918
    // sits BELOW A.l/B.l = 1.1 — a wick with h < l.
    const a = bar(0, 100, 101, 99, 100);
    const b = bar(0, 100, 110, 90, 100);
    expect(a.h / b.h).toBeLessThan(a.l / b.l);
    const out = barRule(ratio, [a, b])!;
    expect(out).not.toBeNull();
    expect(out.o).toBe(1);
    expect(out.c).toBe(1);
    expect(out.h).toBe(99 / 90);
    expect(out.l).toBe(101 / 110);
    expect(out.h).toBeGreaterThanOrEqual(Math.max(out.o, out.c));
    expect(Math.max(out.o, out.c)).toBeGreaterThanOrEqual(Math.min(out.o, out.c));
    expect(Math.min(out.o, out.c)).toBeGreaterThanOrEqual(out.l);
  });

  it('takes t from the newest leg', () => {
    expect(barRule(spread, [flat(5, 2), flat(9, 1)])!.t).toBe(9);
  });

  it('returns null on ÷0 and on a NaN input, never a fabricated bar', () => {
    expect(barRule(ratio, [flat(0, 1), flat(0, 0)])).toBeNull();
    expect(barRule(ratio, [bar(0, 1, 1, 1, NaN), flat(0, 2)])).toBeNull();
    expect(barRule(ratio, [flat(0, 1), flat(0, Infinity)])).toBeNull();
    expect(barRule(ratio, [])).toBeNull();
  });
});

describe('mergeLegs (union walk)', () => {
  const A = series([
    [10, 11, 9, 10],
    [10, 12, 10, 12],
    [12, 12, 8, 8],
  ]);
  const B = series([
    [5, 5, 5, 5],
    [5, 6, 4, 4],
    [4, 4, 2, 2],
  ]);

  it('aligned legs compose bucket by bucket and equal barRule per bucket (cross-check)', () => {
    const out = mergeLegs(ratio, [A, B], []);
    expect(out).toHaveLength(3);
    expect(out).toEqual(A.map((a, k) => barRule(ratio, [a, B[k]])));
  });

  it('a younger leg truncates history: nothing before its first bar', () => {
    const young = B.slice(1); // starts at t = 1m
    const out = mergeLegs(ratio, [A, young], []);
    expect(out.map((b) => b.t)).toEqual([MINUTE, 2 * MINUTE]);
    expect(out[0]).toEqual(barRule(ratio, [A[1], young[0]]));
  });

  it('a seed lets a leg with [] bars take part (flat at the seed close)', () => {
    const out = mergeLegs(ratio, [A, []], [null, flat(-7 * MINUTE, 4)]);
    expect(out.map((b) => b.t)).toEqual([0, MINUTE, 2 * MINUTE]);
    expect(out[0]).toEqual(barRule(ratio, [A[0], flat(0, 4)]));
    expect(out[2]).toEqual(barRule(ratio, [A[2], flat(2 * MINUTE, 4)]));
  });

  it('a leg missing an interior bucket is flat at its previous close', () => {
    const gappy = [B[0], B[2]]; // no bar at t = 1m
    const out = mergeLegs(ratio, [A, gappy], []);
    expect(out.map((b) => b.t)).toEqual([0, MINUTE, 2 * MINUTE]);
    expect(out[1]).toEqual(barRule(ratio, [A[1], flat(MINUTE, B[0].c)]));
    expect(out[2]).toEqual(barRule(ratio, [A[2], B[2]]));
  });

  it('trailing buckets of a thin leg are flat-filled at its last close', () => {
    const thin = B.slice(0, 1);
    const out = mergeLegs(spread, [A, thin], []);
    expect(out.map((b) => b.t)).toEqual([0, MINUTE, 2 * MINUTE]);
    expect(out[2]).toEqual(barRule(spread, [A[2], flat(2 * MINUTE, 5)]));
    // the leg's OWN bucket keeps its full OHLC, the filled ones are flat
    expect(out[0]).toEqual(barRule(spread, [A[0], B[0]]));
  });

  it('a seed newer than a leg bar yields to the bar at its own bucket', () => {
    const out = mergeLegs(spread, [A, B], [null, flat(50 * MINUTE, 99)]);
    expect(out[0]).toEqual(barRule(spread, [A[0], B[0]]));
  });

  it('nothing to walk → [] (both [] with seeds, both [] without)', () => {
    expect(mergeLegs(ratio, [[], []], [flat(0, 1), flat(0, 2)])).toEqual([]);
    expect(mergeLegs(ratio, [[], []], [])).toEqual([]);
    expect(mergeLegs(ratio, [[], []], [null, null])).toEqual([]);
  });

  it('a seedless leg with [] bars means no output at all (never fabricated)', () => {
    expect(mergeLegs(ratio, [A, []], [])).toEqual([]);
  });

  it('output t is strictly increasing even over duplicate-t input bars', () => {
    const dup = [B[0], bar(0, 5, 7, 5, 6), B[1], B[2]]; // two bars at t = 0
    const out = mergeLegs(ratio, [A, dup], []);
    for (let k = 1; k < out.length; k++) expect(out[k].t).toBeGreaterThan(out[k - 1].t);
    expect(out).toHaveLength(3);
    // the later duplicate wins the bucket
    expect(out[0]).toEqual(barRule(ratio, [A[0], dup[1]]));
  });

  it('omits non-finite buckets (÷0 leg) and keeps walking', () => {
    const zeroed = [B[0], flat(MINUTE, 0), B[2]];
    const out = mergeLegs(ratio, [A, zeroed], []);
    expect(out.map((b) => b.t)).toEqual([0, 2 * MINUTE]);
  });

  it('three-leg average over legs starting at different times', () => {
    const C = series([
      [1, 1, 1, 1],
      [1, 3, 1, 3],
      [3, 3, 3, 3],
    ]).slice(2); // only t = 2m
    const out = mergeLegs(avg3, [A, B, C], []);
    expect(out.map((b) => b.t)).toEqual([2 * MINUTE]);
    expect(out[0].c).toBeCloseTo((8 + 2 + 3) / 3, 12);
    expect(out[0].o).toBeCloseTo((12 + 4 + 3) / 3, 12);
  });
});

describe('LiveComposer', () => {
  it('needs every leg before the first emission', () => {
    const lc = new LiveComposer(2, ratio);
    expect(lc.push(0, flat(0, 10))).toBeNull();
    const out = lc.push(1, flat(0, 5))!;
    expect(out).not.toBeNull();
    expect(out.t).toBe(0);
    expect(out.c).toBe(2);
  });

  it('seeds stand in for legs that have not pushed yet', () => {
    const lc = new LiveComposer(2, ratio, [null, flat(-MINUTE, 5)]);
    const out = lc.push(0, flat(0, 10))!;
    expect(out).toEqual(barRule(ratio, [flat(0, 10), flat(0, 5)]));
  });

  it('re-emits at equal t (same-bucket pushes replace in place)', () => {
    const lc = new LiveComposer(2, ratio);
    lc.push(0, flat(0, 10));
    expect(lc.push(1, flat(0, 5))!.c).toBe(2);
    const again = lc.push(0, bar(0, 10, 20, 10, 20))!;
    expect(again.t).toBe(0);
    expect(again.c).toBe(4);
  });

  it('ignores a push older than the leg’s current bar, leaving state intact', () => {
    const lc = new LiveComposer(2, ratio);
    lc.push(0, flat(0, 10));
    lc.push(1, flat(0, 5));
    lc.push(0, flat(MINUTE, 20));
    expect(lc.push(0, flat(0, 1))).toBeNull();
    // leg 1 catching up composes against leg 0's 1m bar, not the stale one
    expect(lc.push(1, flat(MINUTE, 5))!.c).toBe(4);
  });

  it('a lagging leg is flat-filled at its last close', () => {
    const lc = new LiveComposer(2, spread);
    lc.push(0, bar(0, 10, 11, 9, 10));
    lc.push(1, bar(0, 5, 6, 4, 4));
    const out = lc.push(0, bar(MINUTE, 10, 13, 10, 12))!;
    expect(out).toEqual(barRule(spread, [bar(MINUTE, 10, 13, 10, 12), flat(MINUTE, 4)]));
  });

  it('setFloor blocks an emission below the last fetched bar', () => {
    const lc = new LiveComposer(2, ratio, [flat(0, 10), flat(0, 5)]);
    lc.setFloor(MINUTE);
    lc.setFloor(0); // the floor never lowers
    expect(lc.push(0, flat(0, 11))).toBeNull();
    expect(lc.push(0, flat(MINUTE, 20))!.t).toBe(MINUTE);
    // a leg still behind the floor re-composes at the floor bucket, never below it
    const behind = lc.push(1, flat(0, 6))!;
    expect(behind.t).toBe(MINUTE);
    expect(behind.c).toBe(20 / 6);
  });

  it('a non-finite composition emits nothing and does not advance the emitted t', () => {
    const lc = new LiveComposer(2, ratio);
    lc.push(0, flat(0, 10));
    expect(lc.push(1, flat(0, 0))).toBeNull();
    expect(lc.push(1, flat(0, 5))!.c).toBe(2);
  });

  it('emitted t never decreases across interleaved, out-of-order pushes', () => {
    const lc = new LiveComposer(3, avg3, [null, flat(0, 1), null]);
    const script: Array<[number, number]> = [
      [0, 0], [2, 2], [0, 1], [2, 1], [1, 3], [0, 5], [2, 0], [1, 5], [0, 4], [2, 6],
      [1, 6], [0, 6], [2, 2], [0, 7], [1, 7], [2, 7], [1, 3], [0, 9], [2, 9], [1, 9],
    ];
    let last = -Infinity;
    let emitted = 0;
    for (const [leg, m] of script) {
      const out = lc.push(leg, flat(m * MINUTE, 1 + m));
      if (!out) continue;
      expect(out.t).toBeGreaterThanOrEqual(last);
      last = out.t;
      emitted++;
    }
    expect(emitted).toBeGreaterThan(5);
    expect(last).toBe(9 * MINUTE);
  });

  it('ignores an out-of-range leg index', () => {
    const lc = new LiveComposer(2, ratio, [flat(0, 10), flat(0, 5)]);
    expect(lc.push(2, flat(0, 1))).toBeNull();
    expect(lc.push(-1, flat(0, 1))).toBeNull();
  });
});

describe('composeStats', () => {
  it('composes last and prevDayPx through the formula', () => {
    const s = composeStats(ratio, [
      { last: 2, prevDayPx: 1 },
      { last: 4, prevDayPx: 4 },
    ]);
    expect(s).toEqual({ last: 0.5, prevDayPx: 0.25 });
  });

  it('null when any leg has no last', () => {
    expect(composeStats(ratio, [{ last: null, prevDayPx: 1 }, { last: 4, prevDayPx: 4 }])).toBeNull();
    expect(composeStats(ratio, [{ last: NaN, prevDayPx: 1 }, { last: 4, prevDayPx: 4 }])).toBeNull();
  });

  it('prevDayPx null when a leg lacks one, when prev is 0, or when the sign flipped', () => {
    expect(composeStats(ratio, [{ last: 2, prevDayPx: null }, { last: 4, prevDayPx: 4 }])).toEqual({
      last: 0.5,
      prevDayPx: null,
    });
    expect(composeStats(spread, [{ last: 2, prevDayPx: 3 }, { last: 1, prevDayPx: 3 }])).toEqual({
      last: 1,
      prevDayPx: null,
    });
    // a spread that crossed zero: +2 now, −2 yesterday
    expect(composeStats(spread, [{ last: 5, prevDayPx: 3 }, { last: 3, prevDayPx: 5 }])).toEqual({
      last: 2,
      prevDayPx: null,
    });
    // both negative is fine (a basis rising from −5 to −4)
    expect(composeStats(spread, [{ last: 1, prevDayPx: 0 }, { last: 5, prevDayPx: 5 }])).toEqual({
      last: -4,
      prevDayPx: -5,
    });
  });

  it('null when the composed last is non-finite', () => {
    expect(composeStats(ratio, [{ last: 1, prevDayPx: 1 }, { last: 0, prevDayPx: 1 }])).toBeNull();
  });
});

describe('precisionFor', () => {
  it('gives five significant figures at the median magnitude, clamped to 0..8', () => {
    expect(precisionFor([0.033957])).toBe(6);
    expect(precisionFor([929.32])).toBe(2);
    expect(precisionFor([0.0010761])).toBe(7);
    expect(precisionFor([4.4e8])).toBe(0);
    expect(precisionFor([1e-6])).toBe(8);
    expect(precisionFor([12.345])).toBe(3);
  });

  it('no usable value → 8', () => {
    expect(precisionFor([])).toBe(8);
    expect(precisionFor([0, NaN, Infinity, -Infinity])).toBe(8);
  });

  it('uses |c| so negatives and zero-crossings keep the window median', () => {
    expect(precisionFor([-929.32, -930.1, -931])).toBe(2);
    expect(precisionFor([-12.3, 0, 12.4, 0.0001])).toBe(3);
  });

  it('takes the median, not the mean (one outlier does not move it)', () => {
    expect(precisionFor([0.03, 0.031, 0.029, 1e9])).toBe(6);
  });
});

describe('toCandle', () => {
  it('emits ChartCell’s wire shape with toFixed strings, T = t + ms − 1, v "0", n 0', () => {
    const c = toCandle(bar(120_000, 0.0339571, 0.0341, 0.0338, 0.033957), 6, '=AAA/BBB', '1m', MINUTE);
    expect(c).toEqual({
      t: 120_000,
      T: 179_999,
      s: '=AAA/BBB',
      i: '1m',
      o: '0.033957',
      h: '0.034100',
      l: '0.033800',
      c: '0.033957',
      v: '0',
      n: 0,
    });
  });

  it('prints negatives and zero decimals as plain toFixed strings', () => {
    const c = toCandle(bar(0, -12.3456, -12, -12.5, -12.3454), 3, '=AAA-BBB', '1h', 3_600_000);
    expect(c.o).toBe('-12.346');
    expect(c.c).toBe('-12.345');
    expect(c.T).toBe(3_599_999);
    expect(toCandle(bar(0, 4.4e8, 4.5e8, 4.3e8, 4.41e8), 0, '=AAA*BBB', '1d', 86_400_000).c).toBe(
      '441000000',
    );
  });
});
