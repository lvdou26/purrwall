/*
 * Formula cells — the pure bar math under a composed ('=…') chart.
 *
 * DOM-free and network-free by design: this module imports nothing from
 * ws.ts / info.ts so vitest loads it without the vi.mock recipe, and the
 * facade (formulaFeed.ts) is the only place legs are fetched or subscribed.
 *
 * Every function here works on `Bar` (numeric OHLC) and a compiled `Fn` from
 * formula.ts; `vec[i]` is always the value of leg i in the formula's
 * first-appearance leg order.
 */
import type { MarketStats } from './stats';
import type { Candle } from './types';

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** A compiled formula: vec[i] = the value of leg i. */
export type Fn = (vec: number[]) => number;

const finiteBar = (b: Bar): boolean =>
  Number.isFinite(b.t) &&
  Number.isFinite(b.o) &&
  Number.isFinite(b.h) &&
  Number.isFinite(b.l) &&
  Number.isFinite(b.c);

/**
 * The composition rule, validated against reference bars built from minute
 * data: o = f(o⃗), c = f(c⃗), and the wick is the envelope of
 * {o, c, f(h⃗), f(l⃗)} rather than f(h⃗)/f(l⃗) element-wise — a ratio INVERTS
 * the wick (A's high over B's high can sit below A's low over B's low), so
 * element-wise h < l is a real outcome, not an edge case. Returns null when
 * any input or output is non-finite (a ÷0 leg, a NaN bar): a composed bar is
 * omitted, never fabricated.
 *
 * t = the newest leg's t. Callers composing a bucket pass every leg AT that
 * bucket (flat bars for legs behind — see `vectorAt`), so t is the bucket.
 */
export function barRule(f: Fn, legs: Bar[]): Bar | null {
  if (legs.length === 0) return null;
  let t = -Infinity;
  for (const b of legs) {
    if (!finiteBar(b)) return null;
    if (b.t > t) t = b.t;
  }
  const o = f(legs.map((b) => b.o));
  const c = f(legs.map((b) => b.c));
  const fh = f(legs.map((b) => b.h));
  const fl = f(legs.map((b) => b.l));
  if (!Number.isFinite(o) || !Number.isFinite(c) || !Number.isFinite(fh) || !Number.isFinite(fl)) {
    return null;
  }
  return {
    t,
    o,
    h: Math.max(o, c, fh, fl),
    l: Math.min(o, c, fh, fl),
    c,
  };
}

/** Per-leg vector at `time`: a leg's own bar when it has one there, else FLAT at its last close. */
function vectorAt(time: number, cur: Bar[]): Bar[] {
  return cur.map((b) => (b.t === time ? b : { t: time, o: b.c, h: b.c, l: b.c, c: b.c }));
}

/**
 * Union walk over N legs (each ascending in t). At every t any leg has a bar,
 * cur[i] = leg i's latest bar with t ≤ time (seeded from `seeds`); the bucket
 * is SKIPPED while any cur[i] is null — the formula's history begins where its
 * youngest leg begins, nothing is fabricated before a leg exists. A leg with
 * no bar at that exact t contributes a flat bar at cur[i].c (HL server-fills
 * interior gaps, so this covers window-start and trailing absences). A leg
 * may be [] — then only its seed supplies it. Output is strictly increasing
 * in t; non-finite compositions are omitted (barRule).
 */
export function mergeLegs(f: Fn, legBars: Bar[][], seeds: (Bar | null)[]): Bar[] {
  const n = legBars.length;
  const cur: (Bar | null)[] = Array.from({ length: n }, (_, i) => seeds[i] ?? null);
  const idx = new Array<number>(n).fill(0);
  const out: Bar[] = [];
  for (;;) {
    let time = Infinity;
    for (let i = 0; i < n; i++) {
      const head = legBars[i][idx[i]];
      if (head && head.t < time) time = head.t;
    }
    if (time === Infinity) return out;
    let ready = true;
    for (let i = 0; i < n; i++) {
      const leg = legBars[i];
      // `<=` consumes duplicate-t bars too, keeping the output strictly increasing
      while (idx[i] < leg.length && leg[idx[i]].t <= time) cur[i] = leg[idx[i]++];
      if (cur[i] === null) ready = false;
    }
    if (!ready) continue;
    const bar = barRule(f, vectorAt(time, cur as Bar[]));
    if (bar) out.push(bar);
  }
}

/**
 * The live state machine behind one formula subscription. Legs push their
 * own candle-channel bars; the composer re-emits the composed bar at
 * t = max over legs, with legs behind that bucket flat at their last close.
 *
 * MONOTONICITY IS LOAD-BEARING: ChartCell hands every emission to
 * series.update() with no t filter and lightweight-charts throws on a t below
 * the last bar (Invariant 6), inside renderQueue's rAF loop where one throw
 * drops every other cell's paint that frame. So an emission never carries a
 * t below the last emitted one or below `floor` (the last bar a fetch
 * delivered); equal t re-emits (an in-place replacement on both sides).
 */
export class LiveComposer {
  private readonly f: Fn;
  private readonly cur: (Bar | null)[];
  private floor = -Infinity;
  private lastEmitted = -Infinity;

  constructor(n: number, f: Fn, seeds?: (Bar | null)[]) {
    this.f = f;
    this.cur = Array.from({ length: n }, (_, i) => seeds?.[i] ?? null);
  }

  /** Never emit below `t` (a fetch just delivered bars up to it). Only ever rises. */
  setFloor(t: number): void {
    if (t > this.floor) this.floor = t;
  }

  /**
   * Leg i pushed `bar`. Ignored when older than the leg's current bar (a late
   * push for an older bucket at most refreshes the flat close — the accepted
   * approximation; the next heal recomposes it exactly). Returns the composed
   * bar to paint, or null when nothing may be emitted.
   */
  push(i: number, bar: Bar): Bar | null {
    if (i < 0 || i >= this.cur.length) return null;
    const prev = this.cur[i];
    if (prev && bar.t < prev.t) return null;
    this.cur[i] = bar;
    let t = -Infinity;
    for (const b of this.cur) {
      if (b === null) return null;
      if (b.t > t) t = b.t;
    }
    if (t < this.floor || t < this.lastEmitted) return null;
    const out = barRule(this.f, vectorAt(t, this.cur as Bar[]));
    if (out) this.lastEmitted = t;
    return out;
  }
}

/**
 * The 24h chip's inputs for a formula cell from its legs' own stats. `last`
 * needs every leg; `prevDayPx` is null when the composed previous value is
 * missing, zero, or on the other side of zero from `last` — a spread that
 * crossed zero would otherwise print a −340% chip.
 */
export function composeStats(
  f: Fn,
  legs: Array<Pick<MarketStats, 'last' | 'prevDayPx'>>,
): { last: number; prevDayPx: number | null } | null {
  const lasts: number[] = [];
  for (const leg of legs) {
    if (leg.last === null || !Number.isFinite(leg.last)) return null;
    lasts.push(leg.last);
  }
  const last = f(lasts);
  if (!Number.isFinite(last)) return null;
  const prevs: number[] = [];
  for (const leg of legs) {
    if (leg.prevDayPx === null || !Number.isFinite(leg.prevDayPx)) return { last, prevDayPx: null };
    prevs.push(leg.prevDayPx);
  }
  const prev = f(prevs);
  const usable = Number.isFinite(prev) && prev !== 0 && Math.sign(prev) === Math.sign(last);
  return { last, prevDayPx: usable ? prev : null };
}

/**
 * Axis decimals for a composed series of arbitrary magnitude (a 0.03 ratio,
 * a 12.3 basis, a 4e8 product, negatives): 5 significant figures at the
 * window's typical magnitude, clamp(4 − floor(log10(median |c|)), 0, 8) over
 * the finite non-zero closes. No usable close → 8 (ChartCell's cap).
 */
export function precisionFor(closes: number[]): number {
  const mags = closes.filter((c) => Number.isFinite(c) && c !== 0).map(Math.abs);
  if (mags.length === 0) return 8;
  mags.sort((a, b) => a - b);
  const mid = mags.length >> 1;
  const median = mags.length % 2 ? mags[mid] : (mags[mid - 1] + mags[mid]) / 2;
  const d = 4 - Math.floor(Math.log10(median));
  return d < 0 ? 0 : d > 8 ? 8 : d;
}

/**
 * A composed bar in the wire shape ChartCell consumes. Prices are toFixed
 * STRINGS because ChartCell derives axis precision from the string
 * (decimalsOf); volume is '0' and n is 0 — nothing composable there.
 */
export function toCandle(
  bar: Bar,
  decimals: number,
  id: string,
  interval: string,
  intervalMs: number,
): Candle {
  return {
    t: bar.t,
    T: bar.t + intervalMs - 1,
    s: id,
    i: interval,
    o: bar.o.toFixed(decimals),
    h: bar.h.toFixed(decimals),
    l: bar.l.toFixed(decimals),
    c: bar.c.toFixed(decimals),
    v: '0',
    n: 0,
  };
}
