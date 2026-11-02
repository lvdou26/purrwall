/*
 * Formula cells — the data FACADE between ChartCell and Hyperliquid.
 *
 * ChartCell's four data entry points (backfill, heal/resume gap fetch,
 * loadOlder pagination, the candle subscription) call these two functions
 * with the exact signatures of info.fetchCandles / hlSocket.subscribeCandle.
 * A plain coin passes straight through — byte-for-byte the same call, zero
 * overhead. A formula coin ('=AAA/BBB', see formula.ts) fans out to its legs
 * under their REAL ids and composes the answer with compose.ts.
 *
 * THE ONE RULE (Invariant 11): a coin starting with '=' NEVER reaches info.ts
 * or hlSocket on any path. A composite id is an HTTP 500 on REST (retried
 * twice by info.ts — a silent weight leak) and, worse, an unknown coin on
 * the WS candle channel makes HL CLOSE THE SHARED SOCKET, which ws.ts then
 * re-dials and re-subscribes until its quarantine gives up on the id — the
 * Invariant 2 storm class, from one cell. formulaFeed.test.ts pins this
 * across every entry point.
 *
 * Legs share HL work with plain cells for free: info.ts dedupes REST by
 * `coin|interval|floor(start/60s)` and ws.ts dedupes candle subscriptions by
 * (coin, interval), so a ratio's denominator that is also on the wall costs
 * nothing extra.
 *
 * Module state, all keyed `${coin}|${interval}` and session-scoped like
 * candleCache:
 *   lastSeen  — per LEG, its latest known bar (updated MONOTONICALLY — only
 *               at t ≥ the stored t — by every leg fetch's last bar and every
 *               leg push). It seeds merges and live composers for a leg that
 *               returns [] over a window (no trades since — HL omits trailing
 *               buckets) and feeds legAges().
 *   decimals  — per FORMULA, the axis precision. The facade cannot tell a
 *               600-bar backfill from a 2-bar heal by signature, so precision
 *               is computed on a live-edge window of ≥ SEED_WINDOW_BARS
 *               merged bars (or when absent) and REUSED for every shorter gap
 *               fetch and every live emission — a heal must never re-format
 *               the axis mid-session (ChartCell's ratchet only ever raises).
 *   lives     — per FORMULA, the open LiveComposers, so a fetch can raise
 *               their floor and hand them the freshest leg state.
 *   edges     — per FORMULA, the newest bucket a live-edge fetch composed:
 *               the anchor that tells a loadOlder chunk from a backfill /
 *               heal without consulting the clock (see composeWindow).
 */
import { fetchCandles as fetchLegCandles } from './info';
import { hlSocket } from './ws';
import { INTERVAL_MS, type Candle, type Interval } from './types';
import { compile, isFormulaId, parseCanonical } from './formula';
import { LiveComposer, mergeLegs, precisionFor, toCandle, type Bar, type Fn } from './compose';

/** A window at least this many bars wide that reaches the present is a
 *  backfill (or a long heal): the only windows that spend a 1d seed fetch on
 *  an empty leg, recompute the axis precision, and reject when nothing
 *  composes. ChartCell's BACKFILL_BARS is 600; the shortest heal that
 *  qualifies is 200 bars stale. */
const SEED_WINDOW_BARS = 200;
/** The 1d seed window for a leg with no bars in a backfill (thin spot):
 *  ≈21 weight, spent only on that leg. */
const SEED_LOOKBACK_MS = 30 * 86_400_000;
/** Precision is taken over the newest bars of the window (ChartCell's own
 *  recipe: history.slice(-50)). */
const PRECISION_BARS = 50;

interface Program {
  legs: string[];
  f: Fn;
}

interface Live {
  composer: LiveComposer;
  /** Per leg, the newest bucket the SOCKET has pushed — the socket is the
   *  fresher source for any bucket it has delivered, so a fetch landing
   *  later never overwrites it in the composer. */
  pushedT: number[];
}

const programs = new Map<string, Program | null>();
const lastSeen = new Map<string, Bar>();
const decimalsByKey = new Map<string, number>();
const lives = new Map<string, Set<Live>>();
const edges = new Map<string, number>();

const isFormula = (coin: string): boolean => coin.startsWith('=');
const keyOf = (coin: string, interval: string): string => `${coin}|${interval}`;

const abortError = (): DOMException => new DOMException('stale request discarded', 'AbortError');

/** Parsed + compiled once per id; null for an id that fails isFormulaId. */
function program(id: string): Program | null {
  let p = programs.get(id);
  if (p === undefined) {
    const parsed = isFormulaId(id) ? parseCanonical(id) : null;
    p = parsed ? { legs: parsed.legs, f: compile(parsed.ast, parsed.legs) } : null;
    programs.set(id, p);
  }
  return p;
}

const toBar = (c: Candle): Bar => ({
  t: c.t,
  o: Number(c.o),
  h: Number(c.h),
  l: Number(c.l),
  c: Number(c.c),
});

/** A bar with no wick — what a leg contributes at buckets it has no bar of
 *  its own (compose's flat fill), and the only honest shape for a seed taken
 *  at ANOTHER interval. */
const flat = (t: number, c: number): Bar => ({ t, o: c, h: c, l: c, c });

function noteSeen(leg: string, interval: string, bar: Bar): void {
  const k = keyOf(leg, interval);
  const prev = lastSeen.get(k);
  if (!prev || bar.t >= prev.t) lastSeen.set(k, bar);
}

/**
 * ChartCell's fetchCandles. Formula ids: every leg is fetched through
 * info.fetchCandles under its real id with the caller's window and signal —
 * all issued in the same synchronous call, so a pre-aborted (StrictMode-dead)
 * signal rejects before any of them is registered. The first leg to reject
 * rejects the whole fetch with ITS error (an AbortError stays an AbortError —
 * ChartCell reads it as "stale, discard" — and a final-attempt timeout stays
 * a plain Error); sibling legs are never aborted here, info.ts's shared-work
 * semantics already keep a leg alive for the plain cell that may share it.
 */
export function fetchCandles(
  coin: string,
  interval: string,
  startTime: number,
  endTime: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  if (!isFormula(coin)) return fetchLegCandles(coin, interval, startTime, endTime, signal);
  if (signal?.aborted) return Promise.reject(abortError());
  const prog = program(coin);
  if (!prog) return Promise.reject(new Error(`not a formula id: ${coin}`));
  const ms: number | undefined = INTERVAL_MS[interval as Interval];
  if (!ms) return Promise.reject(new Error(`unknown interval: ${interval}`));
  return composeWindow(coin, prog, interval, ms, startTime, endTime, signal);
}

async function composeWindow(
  id: string,
  prog: Program,
  interval: string,
  ms: number,
  startTime: number,
  endTime: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const { legs, f } = prog;
  const k = keyOf(id, interval);
  /*
   * Two window shapes reach here, and telling them apart cannot rest on the
   * clock: ChartCell's loadOlder chunk ends at its oldest bar − 1, which
   * sits within one bucket of now whenever the formula's youngest leg listed
   * in the CURRENT bucket (this week at 1w, today at 1d, this hour at 1h) —
   * and ChartCell auto-fires loadOlder on exactly that one-bar chart. Two
   * ChartCell contracts are relied on instead; a window is HISTORICAL only
   * when both hold:
   *   (1) loadOlder's end is `oldestT − 1`: bucket-aligned minus one (HL
   *       buckets are epoch-modulo and composed bars sit on leg buckets).
   *       Backfill and heal/resume end at Date.now().
   *   (2) a cell has bars to page from only after a live-edge fetch of this
   *       formula composed them this session (candleCache is session-scoped
   *       and banks the facade's own output), so its oldest bar is ≤ the
   *       newest bucket a live-edge fetch has composed (`edge`) and the
   *       chunk's end is strictly below it; a live-edge window ends at
   *       Date.now() ≥ edge.
   * Either alone has a hole — (1) a Date.now() landing on a bucket edge,
   * (2) a client clock behind HL's at a bucket boundary — and a live-edge
   * window misread as historical would heal nothing.
   *
   * A LIVE-EDGE window is seeded from lastSeen, because a leg with no bar in
   * it is a leg that has not traded since — its latest close IS its price. A
   * HISTORICAL window gets NO seeds: a leg absent from an older chunk did not
   * exist yet, and lastSeen — today's price — would paint it flat across
   * history it never had. compose skips buckets until every leg has a bar,
   * so the formula's paged history begins where its youngest leg's begins,
   * and a chunk with no composable bar ends pagination (ChartCell's
   * noMoreHistory) instead of rejecting into loadOlder's catch, where every
   * pan would re-fire the leg fetches.
   */
  const edge = edges.get(k);
  const historical = edge !== undefined && endTime < edge && (endTime + 1) % ms === 0;
  const liveEdge = !historical;
  const backfillSized = liveEdge && (endTime - startTime) / ms >= SEED_WINDOW_BARS;

  // The pre-window state per leg, read BEFORE this fetch's own bars advance
  // lastSeen (a leg's newest bar can never seed the buckets before it).
  const before = legs.map((leg) => (liveEdge ? (lastSeen.get(keyOf(leg, interval)) ?? null) : null));

  const legCandles = await Promise.all(
    legs.map((leg) => fetchLegCandles(leg, interval, startTime, endTime, signal)),
  );
  const legBars = legCandles.map((cs) => cs.map(toBar));
  legs.forEach((leg, i) => {
    const bars = legBars[i];
    if (bars.length > 0) noteSeen(leg, interval, bars[bars.length - 1]);
  });

  if (backfillSized) {
    // A leg with no bar in a whole backfill window (thin spot): one 1d fetch
    // over the last 30 days gives its last TRADED price — what that leg's own
    // chart would show — with a bucket stamp for legAges. Flattened, because
    // a daily range is not a wick at this interval. Nothing there either →
    // reject: ChartCell's error overlay + paced self-heal, never a chart
    // built on a fabricated price.
    const empty = legs.filter((_, i) => legBars[i].length === 0);
    if (empty.length > 0) {
      const now = Date.now();
      const daily = await Promise.all(
        empty.map((leg) => fetchLegCandles(leg, '1d', now - SEED_LOOKBACK_MS, now, signal)),
      );
      empty.forEach((leg, k) => {
        const cs = daily[k];
        if (cs.length > 0) {
          const last = toBar(cs[cs.length - 1]);
          noteSeen(leg, interval, flat(last.t, last.c));
        }
      });
      for (const leg of empty) {
        if (!lastSeen.has(keyOf(leg, interval))) throw new Error(`no data for ${leg}`);
      }
    }
  }

  /*
   * A seed may only ever come from a leg's PAST. A leg that RETURNED bars
   * keeps its pre-fetch lastSeen only when that bar is OLDER than its first
   * fetched bar (a heal under a thin leg whose first gap bar lands after
   * lastT: the walk still starts at lastT); at or past it the seed is
   * dropped — lastSeen holds the leg's NEWEST bar (this fetch's own, another
   * cell's, a push), and merging a young leg from that paints the other
   * leg's whole 600-bar history divided by a listing's price TODAY. Dropping
   * costs nothing: the leg's own bars carry the walk from its first bucket,
   * and buckets before it are skipped (no leg, no bar). A leg that returned
   * [] takes its freshest known bar (the 1d seed just fetched, or a push that
   * landed mid-flight), never one stamped past the window's end.
   *
   * A seed NEWER than the window start does not skip the window start:
   * mergeLegs lets a leg's own bar at any bucket replace its seed, so the
   * first composed bar is always the earliest bucket any leg returned — for
   * a heal that is lastT itself whenever a leg has a bar there (ChartCell's
   * in-place replacement contract), and never below it (seeds are never
   * emitted as buckets). The residual imprecision: a leg that returned []
   * contributes its NEWER seed close to buckets before that seed's own
   * bucket — one bucket of future price on a leg with no trades, recomposed
   * exactly by the next heal. Documented, not fixed.
   */
  const seeds = legs.map((leg, i) => {
    if (!liveEdge) return null;
    const bars = legBars[i];
    if (bars.length > 0) {
      const s = before[i];
      return s && s.t < bars[0].t ? s : null;
    }
    const s = lastSeen.get(keyOf(leg, interval)) ?? null;
    return s && s.t <= endTime ? s : null;
  });
  const merged = mergeLegs(f, legBars, seeds);
  if (backfillSized && merged.length === 0) throw new Error(`no composable bars for ${id}`);

  if (liveEdge && merged.length > 0) {
    const newest = merged[merged.length - 1].t;
    if (edge === undefined || newest > edge) edges.set(k, newest);
  }

  let decimals = decimalsByKey.get(k);
  if (merged.length > 0 && (decimals === undefined || (liveEdge && merged.length >= SEED_WINDOW_BARS))) {
    decimals = precisionFor(merged.slice(-PRECISION_BARS).map((b) => b.c));
    decimalsByKey.set(k, decimals);
  }

  if (liveEdge) {
    const set = lives.get(k);
    if (set) {
      for (const live of set) {
        // Never let a live emission land below the bar this fetch just
        // delivered (Invariant 6 at ChartCell's series.update), and hand the
        // composer the freshest leg state so a single leg's next push can
        // emit — on a first load the composer was born before any leg had
        // been seen, and a thin leg may not push for hours.
        if (merged.length > 0) live.composer.setFloor(merged[merged.length - 1].t);
        legs.forEach((leg, i) => {
          const seen = lastSeen.get(keyOf(leg, interval));
          if (seen && seen.t > live.pushedT[i]) live.composer.push(i, seen); // emission discarded
        });
      }
    }
  }

  const d = decimals ?? 8;
  return merged.map((b) => toCandle(b, d, id, interval, ms));
}

/**
 * ChartCell's subscribeCandle. Formula ids: one LiveComposer per
 * subscription (seeded from lastSeen), one hlSocket candle subscription per
 * leg under its real id. Every leg push updates lastSeen, then the composer;
 * a composed bar goes to the listener at the formula's stored precision (a
 * push before any fetch of this formula falls back to the bar's own
 * magnitude). The returned function tears down every leg subscription.
 */
export function subscribeCandle(
  coin: string,
  interval: string,
  listener: (c: Candle) => void,
  onRejected?: () => void,
): () => void {
  if (!isFormula(coin)) return hlSocket.subscribeCandle(coin, interval, listener, onRejected);
  const prog = program(coin);
  const ms: number | undefined = INTERVAL_MS[interval as Interval];
  if (!prog || !ms) return () => {};
  const { legs, f } = prog;
  // One quarantined leg (hl/ws.ts: HL closes the socket on the id) kills
  // the whole formula — the cell hears it once, like a plain cell would.
  let rejected = false;
  const reject = () => {
    if (rejected) return;
    rejected = true;
    onRejected?.();
  };
  const k = keyOf(coin, interval);
  const live: Live = {
    composer: new LiveComposer(
      legs.length,
      f,
      legs.map((leg) => lastSeen.get(keyOf(leg, interval)) ?? null),
    ),
    pushedT: new Array<number>(legs.length).fill(-Infinity),
  };
  let set = lives.get(k);
  if (!set) {
    set = new Set();
    lives.set(k, set);
  }
  set.add(live);
  const unsubs = legs.map((leg, i) =>
    hlSocket.subscribeCandle(
      leg,
      interval,
      (c) => {
        const bar = toBar(c);
        noteSeen(leg, interval, bar);
        if (bar.t > live.pushedT[i]) live.pushedT[i] = bar.t;
        const out = live.composer.push(i, bar);
        if (!out) return;
        listener(toCandle(out, decimalsByKey.get(k) ?? precisionFor([out.c]), coin, interval, ms));
      },
      reject,
    ),
  );
  return () => {
    for (const off of unsubs) off();
    set.delete(live);
    if (set.size === 0) lives.delete(k);
  };
}

/** Re-send a live subscription on the wire (per-cell freshness found the
 *  feed dead while the socket lives); a '=' id fans out to its legs. */
export function resubscribeCandle(coin: string, interval: string): void {
  const legs = isFormula(coin) ? (program(coin)?.legs ?? []) : [coin];
  for (const leg of legs) hlSocket.resubscribeCandle(leg, interval);
}

/** hlSocket.isCandleQuarantined for any id: a formula is quarantined when
 *  any of its legs is. */
export function isCandleQuarantined(coin: string, interval: string): boolean {
  const legs = isFormula(coin) ? (program(coin)?.legs ?? []) : [coin];
  return legs.some((leg) => hlSocket.isCandleQuarantined(leg, interval));
}

/** The cell's manual Retry (hl/ws.ts clearCandleQuarantine), for any id:
 *  every leg of a formula gets its one more attempt. */
export function clearCandleQuarantine(coin: string, interval: string): void {
  const legs = isFormula(coin) ? (program(coin)?.legs ?? []) : [coin];
  for (const leg of legs) hlSocket.clearCandleQuarantine(leg, interval);
}

/** The distinct legs of a formula id in first-appearance order; null for a
 *  plain coin, [] for an id that starts with '=' but fails isFormulaId. */
export function legsOf(coin: string): string[] | null {
  if (!isFormula(coin)) return null;
  return program(coin)?.legs.slice() ?? [];
}

/** Per leg, how long since its newest known bucket opened (fetch or push) —
 *  a "quiet since" figure for a fine-pointer tooltip (no UI reads it yet).
 *  null until the leg has been seen at this interval; [] for anything that
 *  is not a formula id. */
export function legAges(coin: string, interval: string): Array<{ coin: string; ageMs: number | null }> {
  const prog = isFormula(coin) ? program(coin) : null;
  if (!prog) return [];
  const now = Date.now();
  return prog.legs.map((leg) => {
    const seen = lastSeen.get(keyOf(leg, interval));
    return { coin: leg, ageMs: seen ? Math.max(0, now - seen.t) : null };
  });
}
