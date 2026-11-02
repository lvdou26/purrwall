import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCandles as legFetch } from './info';
import { hlSocket } from './ws';
import { fetchCandles, legAges, legsOf, subscribeCandle, clearCandleQuarantine, isCandleQuarantined } from './formulaFeed';
import type { Candle } from './types';

// Both HL clients are replaced for the whole file: ws.ts must never be really
// imported under node (it dials a socket at module load), and every REST call
// the facade makes is what these tests assert on.
vi.mock('./info', () => ({ fetchCandles: vi.fn() }));
vi.mock('./ws', () => ({
  hlSocket: {
    subscribeCandle: vi.fn(),
    isCandleQuarantined: vi.fn(() => false),
    clearCandleQuarantine: vi.fn(),
  },
}));

const legFetchMock = vi.mocked(legFetch);
const subscribeMock = vi.mocked(hlSocket.subscribeCandle);

// Invented ids only — never real tickers, so the fixture cannot drift with HL.
// Module state (lastSeen / decimals) is a session singleton, exactly as in
// the app, so every test mints its own legs.
const MINUTE = 60_000;
const DAY = 86_400_000;
const BACKFILL_BARS = 600;
let seq = 0;
const mint = () => {
  seq++;
  const a = `AAA${seq}`;
  const b = `BBB${seq}`;
  return { a, b, id: `=${a}/${b}` };
};

/** The current 1m bucket — bars are stamped relative to it. */
const bucketNow = () => Math.floor(Date.now() / MINUTE) * MINUTE;

const candle = (
  s: string,
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  i = '1m',
): Candle => ({
  t,
  T: t + MINUTE - 1,
  s,
  i,
  o: String(o),
  h: String(h),
  l: String(l),
  c: String(c),
  v: '1',
  n: 1,
});

/** `count` flat 1m bars ending at `lastT`, price `p(k)` for the k-th bar. */
const flatSeries = (s: string, count: number, p: (k: number) => number, lastT = bucketNow()): Candle[] =>
  Array.from({ length: count }, (_, k) => {
    const v = p(k);
    return candle(s, lastT - (count - 1 - k) * MINUTE, v, v, v, v);
  });

type Reply = Candle[] | Error | ((start: number, end: number) => Candle[] | Error);
/** Route each leg fetch by `coin|interval` (then by coin); unlisted → []. */
const answer = (table: Record<string, Reply>) => {
  legFetchMock.mockImplementation((coin, interval, start, end) => {
    const r = table[`${coin}|${interval}`] ?? table[coin] ?? [];
    const v = typeof r === 'function' ? r(start, end) : r;
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  });
};

const backfillWindow = () => {
  const end = Date.now();
  return { start: end - MINUTE * BACKFILL_BARS, end };
};

const forwarded = () => [
  ...legFetchMock.mock.calls.map((c) => c[0]),
  ...subscribeMock.mock.calls.map((c) => c[0]),
];

beforeEach(() => {
  legFetchMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockImplementation(() => vi.fn());
});
afterEach(() => vi.restoreAllMocks());

describe('plain coins pass straight through', () => {
  it('fetchCandles forwards identical args and returns info.ts’s own promise', () => {
    const p = Promise.resolve<Candle[]>([]);
    legFetchMock.mockReturnValue(p);
    const ac = new AbortController();
    const out = fetchCandles('AAA', '1m', 1, 2, ac.signal);
    expect(out).toBe(p);
    expect(legFetchMock).toHaveBeenCalledTimes(1);
    expect(legFetchMock).toHaveBeenCalledWith('AAA', '1m', 1, 2, ac.signal);
  });

  it('subscribeCandle forwards identical args and returns hlSocket’s own unsubscribe', () => {
    const off = vi.fn();
    subscribeMock.mockReturnValue(off);
    const listener = () => {};
    expect(subscribeCandle('zz:AAA1', '5m', listener)).toBe(off);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith('zz:AAA1', '5m', listener, undefined);
  });

  it('legsOf is null and legAges is [] for a plain coin', () => {
    expect(legsOf('@901')).toBeNull();
    expect(legAges('@901', '1m')).toEqual([]);
  });
});

describe('NEVER-FORWARD: no call path hands a "=" coin to info.ts or hlSocket', () => {
  it('backfill, short gap fetch, loadOlder and subscribe all reach HL under leg ids only', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({
      [a]: (start) => flatSeries(a, 3, (k) => 100 + k, start < N - 10 * MINUTE ? N - 700 * MINUTE : N),
      [b]: (start) => flatSeries(b, 3, () => 50, start < N - 10 * MINUTE ? N - 700 * MINUTE : N),
    });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    await fetchCandles(id, '1m', N, Date.now()); // heal: from the last bar
    await fetchCandles(id, '1m', N - 2600 * MINUTE, N - 600 * MINUTE - 1); // loadOlder chunk
    const off = subscribeCandle(id, '1m', () => {});
    off();
    expect(legFetchMock.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    for (const coin of forwarded()) expect(coin.startsWith('=')).toBe(false);
    expect(new Set(forwarded())).toEqual(new Set([a, b]));
  });

  it('a malformed "=" id rejects with a plain Error and never reaches info.ts', async () => {
    for (const bad of ['=AAA+', '=5', '=#10/AAA', '=', '=AAA BBB']) {
      await expect(fetchCandles(bad, '1m', 0, 1)).rejects.toSatisfy(
        (e: Error) => e.name !== 'AbortError' && /not a formula id/.test(e.message),
      );
    }
    expect(legFetchMock).not.toHaveBeenCalled();
  });

  it('a malformed "=" id subscribes nothing and returns a no-op', () => {
    const off = subscribeCandle('=AAA+', '1m', () => {});
    expect(typeof off).toBe('function');
    off();
    expect(subscribeMock).not.toHaveBeenCalled();
    expect(legsOf('=AAA+')).toEqual([]);
  });

  it('an unknown interval on a formula rejects without touching HL', async () => {
    const { id } = mint();
    await expect(fetchCandles(id, '2h', 0, 1)).rejects.toThrow(/unknown interval/);
    expect(legFetchMock).not.toHaveBeenCalled();
  });
});

describe('composition (backfill)', () => {
  it('merges two legs into ratio bars with the measured wick rule and toFixed strings', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({
      // A 101/99 around 100, B 110/90 around 100: an inverted ratio wick
      [a]: [candle(a, N - MINUTE, 100, 101, 99, 100), candle(a, N, 100, 104, 100, 104)],
      [b]: [candle(b, N - MINUTE, 100, 110, 90, 100), candle(b, N, 100, 100, 50, 52)],
    });
    const { start, end } = backfillWindow();
    const out = await fetchCandles(id, '1m', start, end);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      t: N - MINUTE,
      T: N - 1,
      s: id,
      i: '1m',
      o: '1.0000',
      h: (99 / 90).toFixed(4),
      l: (101 / 110).toFixed(4),
      c: '1.0000',
      v: '0',
      n: 0,
    });
    expect(out[1].o).toBe('1.0000');
    expect(out[1].c).toBe('2.0000');
    expect(out[1].h).toBe('2.0000');
    expect(out[1].l).toBe('1.0000');
    // both legs were fetched with the caller's window, in the same tick
    expect(legFetchMock).toHaveBeenCalledTimes(2);
    expect(legFetchMock).toHaveBeenCalledWith(a, '1m', start, end, undefined);
    expect(legFetchMock).toHaveBeenCalledWith(b, '1m', start, end, undefined);
  });

  it('a leg used twice is fetched once (legs are distinct)', async () => {
    seq++;
    const a = `AAA${seq}`;
    const id = `=${a}/${a}`;
    answer({ [a]: flatSeries(a, 2, () => 7) });
    const { start, end } = backfillWindow();
    const out = await fetchCandles(id, '1m', start, end);
    expect(legFetchMock).toHaveBeenCalledTimes(1);
    expect(out.map((c) => c.c)).toEqual(['1.0000', '1.0000']);
    expect(legsOf(id)).toEqual([a]);
  });

  it('a backfill that composes zero bars rejects with a plain Error (never an empty live chart)', async () => {
    const { a, b, id } = mint();
    // both legs empty at 1m but seedable at 1d: no bucket exists to compose
    answer({
      [`${a}|1d`]: [candle(a, Math.floor(Date.now() / DAY) * DAY, 1, 1, 1, 1, '1d')],
      [`${b}|1d`]: [candle(b, Math.floor(Date.now() / DAY) * DAY, 2, 2, 2, 2, '1d')],
    });
    const { start, end } = backfillWindow();
    await expect(fetchCandles(id, '1m', start, end)).rejects.toSatisfy(
      (e: Error) => e.name !== 'AbortError' && /no composable bars/.test(e.message),
    );
  });
});

describe('initial 1d seed for a leg with no bars in a backfill', () => {
  it('spends exactly one 1d fetch on the empty leg and merges from its latest close, flattened', async () => {
    const { a, b, id } = mint();
    const dayT = Math.floor(Date.now() / DAY) * DAY;
    const ac = new AbortController();
    answer({
      // A has a bar AT the seed's own bucket: the daily range must not become a wick
      [a]: [candle(a, dayT, 100, 101, 99, 100), candle(a, dayT + MINUTE, 100, 100, 100, 100)],
      [`${b}|1m`]: [],
      [`${b}|1d`]: [candle(b, dayT - DAY, 1, 1, 1, 1, '1d'), candle(b, dayT, 40, 60, 30, 50, '1d')],
    });
    const { start, end } = backfillWindow();
    const before = Date.now();
    const out = await fetchCandles(id, '1m', start, end, ac.signal);
    const dailyCalls = legFetchMock.mock.calls.filter((c) => c[1] === '1d');
    expect(dailyCalls).toHaveLength(1);
    const [coin, , s, e, sig] = dailyCalls[0];
    expect(coin).toBe(b);
    expect(e).toBeGreaterThanOrEqual(before);
    expect(e).toBeLessThanOrEqual(Date.now());
    expect(e - s).toBe(30 * DAY);
    expect(sig).toBe(ac.signal);
    expect(out).toHaveLength(2);
    expect(out[0].t).toBe(dayT);
    expect(out[0].o).toBe('2.0000');
    expect(out[0].c).toBe('2.0000');
    expect(out[0].h).toBe((101 / 50).toFixed(4)); // not 99/30
    expect(out[0].l).toBe((99 / 50).toFixed(4)); // not 101/60
    expect(out[1].c).toBe('2.0000');
    // the seed is what legAges reports for the quiet leg
    const ages = legAges(id, '1m');
    expect(ages.map((x) => x.coin)).toEqual([a, b]);
    expect(ages[1].ageMs).toBeGreaterThanOrEqual(Date.now() - dayT - 1000);
  });

  it('a leg with nothing in 30 days rejects with a plain "no data" Error', async () => {
    const { a, b, id } = mint();
    answer({ [a]: flatSeries(a, 3, () => 1) });
    const { start, end } = backfillWindow();
    await expect(fetchCandles(id, '1m', start, end)).rejects.toSatisfy(
      (e: Error) => e.name !== 'AbortError' && e.message === `no data for ${b}`,
    );
  });

  it('a historical (loadOlder) chunk never seeds: an absent leg yields no bars and no 1d fetch', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    // establish lastSeen for both legs first (the app always backfills before paging)
    answer({ [a]: flatSeries(a, 2, () => 100), [b]: flatSeries(b, 2, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    legFetchMock.mockClear();
    const oldEnd = N - 600 * MINUTE - 1;
    answer({ [a]: flatSeries(a, 300, () => 100, oldEnd - 100 * MINUTE + 1), [b]: [] });
    const out = await fetchCandles(id, '1m', oldEnd - 2000 * MINUTE, oldEnd);
    expect(out).toEqual([]);
    expect(legFetchMock.mock.calls.every((c) => c[1] === '1m')).toBe(true);
  });

  it('a historical chunk begins where the youngest leg begins (no flat fill before a leg exists)', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({ [a]: flatSeries(a, 2, () => 100), [b]: flatSeries(b, 2, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    const oldEnd = N - 600 * MINUTE - 1;
    const lastOld = oldEnd - MINUTE + 1;
    answer({
      [a]: flatSeries(a, 10, () => 100, lastOld),
      [b]: flatSeries(b, 4, () => 50, lastOld), // B lists 6 bars after A
    });
    const out = await fetchCandles(id, '1m', oldEnd - 2000 * MINUTE, oldEnd);
    expect(out).toHaveLength(4);
    expect(out[0].t).toBe(lastOld - 3 * MINUTE);
    expect(out.map((c) => c.c)).toEqual(['2.0000', '2.0000', '2.0000', '2.0000']);
  });
});

describe('a seed comes only from a leg’s PAST (no fabricated pre-listing history)', () => {
  it('a young leg on the first backfill: history begins at its first bucket, not at the window start', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({
      [a]: flatSeries(a, BACKFILL_BARS, (k) => 100 + (k % 5)),
      [b]: flatSeries(b, 10, () => 50), // B listed 10 buckets ago
    });
    const { start, end } = backfillWindow();
    const out = await fetchCandles(id, '1m', start, end);
    expect(out).toHaveLength(10);
    expect(out[0].t).toBe(N - 9 * MINUTE);
    expect(out[9].t).toBe(N);
    expect(legFetchMock.mock.calls.every((c) => c[1] === '1m')).toBe(true); // B has bars: no 1d seed
  });

  it('…and still when lastSeen already holds the young leg’s NEWEST bar (an earlier fetch, a re-backfill)', async () => {
    const { a, b, id } = mint();
    const c = `CCC${seq}`;
    const N = bucketNow();
    const { start, end } = backfillWindow();
    // an earlier backfill of another formula sharing B leaves lastSeen[B] at N
    answer({ [c]: flatSeries(c, BACKFILL_BARS, () => 200), [b]: flatSeries(b, 10, () => 50) });
    expect(await fetchCandles(`=${b}/${c}`, '1m', start, end)).toHaveLength(10);
    answer({ [a]: flatSeries(a, BACKFILL_BARS, () => 100), [b]: flatSeries(b, 10, () => 50) });
    const out = await fetchCandles(id, '1m', start, end);
    expect(out).toHaveLength(10);
    expect(out[0].t).toBe(N - 9 * MINUTE);
    // a second backfill of the SAME formula (catalog Retry rebuild, candleCache
    // eviction) finds lastSeen[B] at t≈now from its own first pass: same answer
    const again = await fetchCandles(id, '1m', start, Date.now());
    expect(again).toHaveLength(10);
    expect(again[0].t).toBe(N - 9 * MINUTE);
  });

  it('…and when another cell’s push has stamped the young leg at the current bucket', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    const listeners = new Map<string, (c: Candle) => void>();
    subscribeMock.mockImplementation((coin, interval, l) => {
      listeners.set(`${coin}|${interval}`, l);
      return vi.fn();
    });
    subscribeCandle(id, '1m', () => {});
    listeners.get(`${b}|1m`)!(candle(b, N, 50, 50, 50, 50));
    answer({ [a]: flatSeries(a, BACKFILL_BARS, () => 100), [b]: flatSeries(b, 10, () => 50) });
    const { start, end } = backfillWindow();
    const out = await fetchCandles(id, '1m', start, end);
    expect(out).toHaveLength(10);
    expect(out[0].t).toBe(N - 9 * MINUTE);
  });

  it('two formulas sharing a young leg, resolved in the same tick, both begin at its first bucket', async () => {
    seq++;
    const a = `AAA${seq}`;
    const b = `BBB${seq}`;
    const c = `CCC${seq}`;
    answer({
      [a]: flatSeries(a, BACKFILL_BARS, () => 100),
      [c]: flatSeries(c, BACKFILL_BARS, () => 200),
      [b]: flatSeries(b, 10, () => 50),
    });
    const { start, end } = backfillWindow();
    const [o1, o2] = await Promise.all([
      fetchCandles(`=${b}/${a}`, '1m', start, end),
      fetchCandles(`=${b}/${c}`, '1m', start, end),
    ]);
    expect(o1).toHaveLength(10);
    expect(o2).toHaveLength(10);
    expect(o1[0].c).toBe('0.50000'); // 4 − floor(log10 0.5) = 5 dp
    expect(o2[0].c).toBe('0.25000');
  });

  it('a seed OLDER than a leg’s first fetched bar stays: a heal under a thin leg still starts at lastT', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    // B is thin: its newest backfill bar is N−1m, so lastSeen[B] = N−1m while the cell's lastT is N
    answer({ [a]: flatSeries(a, 3, () => 100), [b]: flatSeries(b, 3, () => 50, N - MINUTE) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    // heal from lastT = N: A has bars from N, B's first gap bar lands at N+2m
    answer({
      [a]: [
        candle(a, N, 100, 110, 100, 110),
        candle(a, N + MINUTE, 110, 120, 110, 120),
        candle(a, N + 2 * MINUTE, 120, 130, 120, 130),
      ],
      [b]: [candle(b, N + 2 * MINUTE, 50, 50, 25, 25)],
    });
    const out = await fetchCandles(id, '1m', N, Date.now());
    expect(out.map((c) => c.t)).toEqual([N, N + MINUTE, N + 2 * MINUTE]);
    expect(out.map((c) => c.c)).toEqual(['2.2000', '2.4000', '5.2000']);
  });

  it('a leg with no bars never takes a seed stamped past the window’s end', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({ [a]: flatSeries(a, 3, () => 100), [b]: flatSeries(b, 3, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    const listeners = new Map<string, (c: Candle) => void>();
    subscribeMock.mockImplementation((coin, interval, l) => {
      listeners.set(`${coin}|${interval}`, l);
      return vi.fn();
    });
    subscribeCandle(id, '1m', () => {});
    listeners.get(`${b}|1m`)!(candle(b, N + MINUTE, 50, 50, 50, 50)); // a bucket the window's end has not reached
    answer({ [a]: [candle(a, N, 100, 100, 100, 200)], [b]: [] });
    await expect(fetchCandles(id, '1m', N, Date.now())).resolves.toEqual([]);
  });
});

describe('window classification: loadOlder vs live-edge without clock slack', () => {
  it('a loadOlder chunk ending at the current bucket − 1 is historical: no seeds, no 1d fetch, [] ends pagination', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    // B listed in the CURRENT bucket: the backfill composes exactly one bar
    answer({ [a]: flatSeries(a, BACKFILL_BARS, () => 100), [b]: [candle(b, N, 50, 50, 50, 50)] });
    const { start, end } = backfillWindow();
    const hist = await fetchCandles(id, '1m', start, end);
    expect(hist.map((c) => c.t)).toEqual([N]);
    legFetchMock.mockClear();
    // ChartCell.loadOlder on that one-bar chart: [oldestT − 2000 buckets, oldestT − 1], oldestT = N
    answer({
      [a]: (_s, e) => flatSeries(a, 2000, () => 100, Math.floor(e / MINUTE) * MINUTE),
      [b]: [],
      [`${b}|1d`]: [candle(b, Math.floor(Date.now() / DAY) * DAY, 1, 1, 1, 1, '1d')],
    });
    await expect(fetchCandles(id, '1m', N - 2000 * MINUTE, N - 1)).resolves.toEqual([]);
    expect(legFetchMock).toHaveBeenCalledTimes(2);
    expect(legFetchMock.mock.calls.every((c) => c[1] === '1m')).toBe(true);
    // the next heal (ending at Date.now()) is still live-edge: B seeded from lastSeen
    answer({ [a]: [candle(a, N, 100, 100, 100, 200)], [b]: [] });
    const gap = await fetchCandles(id, '1m', N, Date.now());
    expect(gap.map((c) => [c.t, c.c])).toEqual([[N, '4.0000']]);
  });

  it('a window whose end is not bucket-aligned stays live-edge even below the edge (client clock behind HL’s)', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({ [a]: flatSeries(a, 3, () => 100), [b]: flatSeries(b, 3, () => 50, N - MINUTE) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end); // edge = N (A's bar at N, B flat)
    // a heal whose Date.now() end reads below the bucket HL already delivered
    answer({ [a]: [candle(a, N - MINUTE, 100, 100, 100, 300)], [b]: [] });
    const out = await fetchCandles(id, '1m', N - MINUTE, N - 1000);
    expect(out.map((c) => [c.t, c.c])).toEqual([[N - MINUTE, '6.0000']]);
  });
});

describe('short gap fetch (heal / resume) seeds from lastSeen', () => {
  it('a leg returning [] over the gap is filled from lastSeen; the first bar is AT the window start', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({ [a]: flatSeries(a, 3, () => 100), [b]: flatSeries(b, 3, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    legFetchMock.mockClear();
    // heal from lastT = N: A moved, B has not traded since
    answer({
      [a]: [candle(a, N, 100, 112, 100, 110), candle(a, N + MINUTE, 110, 120, 110, 120)],
      [b]: [],
    });
    const out = await fetchCandles(id, '1m', N, Date.now());
    expect(legFetchMock).toHaveBeenCalledTimes(2); // no 1d seed on a short window
    expect(legFetchMock.mock.calls.every((c) => c[1] === '1m')).toBe(true);
    expect(out.map((c) => c.t)).toEqual([N, N + MINUTE]);
    expect(out[0].c).toBe('2.2000');
    expect(out[0].h).toBe((112 / 50).toFixed(4));
    expect(out[1].c).toBe('2.4000');
  });

  it('the first emitted bar is never later than the earliest bucket any leg returned', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({ [a]: flatSeries(a, 3, () => 100), [b]: flatSeries(b, 3, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    answer({ [a]: [], [b]: [candle(b, N + MINUTE, 50, 50, 50, 25)] });
    const out = await fetchCandles(id, '1m', N, Date.now());
    expect(out.map((c) => c.t)).toEqual([N + MINUTE]);
    expect(out[0].c).toBe('4.0000');
  });

  it('a seed NEWER than the window start does not skip the window start', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({ [a]: flatSeries(a, 3, () => 100), [b]: flatSeries(b, 3, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    // a first heal advances A's lastSeen to N+5m
    answer({ [a]: flatSeries(a, 6, () => 100, N + 5 * MINUTE), [b]: [] });
    await fetchCandles(id, '1m', N, Date.now());
    // a second heal from an OLDER lastT (another cell of the same formula
    // resuming from its cache): A's fetched bars at N+3m.. must replace the
    // newer seed, so the walk starts at N+3m, not at N+5m
    answer({
      [a]: [
        candle(a, N + 3 * MINUTE, 100, 100, 100, 150),
        candle(a, N + 4 * MINUTE, 150, 150, 150, 200),
        candle(a, N + 5 * MINUTE, 200, 200, 200, 100),
      ],
      [b]: [],
    });
    const out = await fetchCandles(id, '1m', N + 3 * MINUTE, Date.now());
    expect(out.map((c) => c.t)).toEqual([N + 3 * MINUTE, N + 4 * MINUTE, N + 5 * MINUTE]);
    expect(out.map((c) => c.c)).toEqual(['3.0000', '4.0000', '2.0000']);
  });

  it('a gap fetch where nothing traded on any leg resolves [] (nothing to merge, no error)', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({ [a]: flatSeries(a, 3, () => 100), [b]: flatSeries(b, 3, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    answer({ [a]: [], [b]: [] });
    await expect(fetchCandles(id, '1m', N, Date.now())).resolves.toEqual([]);
  });
});

describe('axis precision persists per (formula, interval)', () => {
  it('a 2-bar gap fetch reuses the decimals of the 600-bar backfill', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({
      [a]: flatSeries(a, BACKFILL_BARS, (k) => 100 + (k % 7)),
      [b]: flatSeries(b, BACKFILL_BARS, () => 50),
    });
    const { start, end } = backfillWindow();
    const hist = await fetchCandles(id, '1m', start, end);
    expect(hist).toHaveLength(BACKFILL_BARS);
    expect(hist[hist.length - 1].c).toMatch(/^\d\.\d{4}$/); // ratio ≈ 2 → 4 dp
    // the ratio collapses to 0.002 — a fresh computation would say 7 dp
    answer({ [a]: [candle(a, N, 0.1, 0.1, 0.1, 0.1), candle(a, N + MINUTE, 0.1, 0.1, 0.1, 0.1)], [b]: [] });
    const gap = await fetchCandles(id, '1m', N, Date.now());
    expect(gap.map((c) => c.c)).toEqual(['0.0020', '0.0020']);
  });

  it('a fresh formula at a small magnitude computes its own decimals, and another interval is independent', async () => {
    const { a, b, id } = mint();
    answer({ [a]: flatSeries(a, 3, () => 0.1), [b]: flatSeries(b, 3, () => 50) });
    const { start, end } = backfillWindow();
    const out = await fetchCandles(id, '1m', start, end);
    expect(out[0].c).toBe('0.0020000'); // clamp(4 − floor(log10 0.002), 0, 8) = 7
    // same legs at 5m: the 5m key has no decimals yet → computed from its own window
    answer({
      [a]: flatSeries(a, 3, () => 100, Math.floor(Date.now() / 300_000) * 300_000),
      [b]: flatSeries(b, 3, () => 50, Math.floor(Date.now() / 300_000) * 300_000),
    });
    const five = await fetchCandles(id, '5m', end - 300_000 * BACKFILL_BARS, end);
    expect(five[0].c).toBe('2.0000');
    expect(five[0].T).toBe(five[0].t + 300_000 - 1);
    expect(five[0].i).toBe('5m');
  });

  it('a paged-in historical chunk never re-formats the axis', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({
      [a]: flatSeries(a, BACKFILL_BARS, () => 100),
      [b]: flatSeries(b, BACKFILL_BARS, () => 50),
    });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    const oldEnd = N - 600 * MINUTE - 1;
    answer({
      [a]: flatSeries(a, 300, () => 0.1, oldEnd - MINUTE + 1),
      [b]: flatSeries(b, 300, () => 50, oldEnd - MINUTE + 1),
    });
    const older = await fetchCandles(id, '1m', oldEnd - 2000 * MINUTE, oldEnd);
    expect(older).toHaveLength(300);
    expect(older[0].c).toBe('0.0020');
  });
});

describe('AbortSignal semantics', () => {
  it('a pre-aborted signal rejects with AbortError before any leg is registered', async () => {
    const { id } = mint();
    const ac = new AbortController();
    ac.abort();
    const { start, end } = backfillWindow();
    await expect(fetchCandles(id, '1m', start, end, ac.signal)).rejects.toSatisfy(
      (e: Error) => e.name === 'AbortError',
    );
    expect(legFetchMock).not.toHaveBeenCalled();
  });

  it('a leg AbortError surfaces as AbortError; a plain leg Error surfaces as that same Error', async () => {
    const { a, b, id } = mint();
    const { start, end } = backfillWindow();
    answer({ [a]: flatSeries(a, 2, () => 1), [b]: new DOMException('stale request discarded', 'AbortError') });
    await expect(fetchCandles(id, '1m', start, end)).rejects.toSatisfy(
      (e: Error) => e.name === 'AbortError',
    );
    const timeout = new Error('HL info "candleSnapshot" timed out');
    answer({ [a]: timeout, [b]: flatSeries(b, 2, () => 1) });
    await expect(fetchCandles(id, '1m', start, end)).rejects.toBe(timeout);
  });

  it('the caller’s signal is handed to every leg fetch', async () => {
    const { a, b, id } = mint();
    const ac = new AbortController();
    answer({ [a]: flatSeries(a, 2, () => 1), [b]: flatSeries(b, 2, () => 1) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end, ac.signal);
    expect(legFetchMock.mock.calls.map((c) => c[4])).toEqual([ac.signal, ac.signal]);
  });
});

describe('live subscription', () => {
  /** Capture each leg's socket listener and its unsubscribe spy. */
  const wire = () => {
    const listeners = new Map<string, (c: Candle) => void>();
    const offs = new Map<string, ReturnType<typeof vi.fn>>();
    subscribeMock.mockImplementation((coin, interval, l) => {
      listeners.set(`${coin}|${interval}`, l);
      const off = vi.fn();
      offs.set(`${coin}|${interval}`, off);
      return off;
    });
    return { push: (key: string, c: Candle) => listeners.get(key)!(c), offs };
  };

  it('fans out to every leg under its real id and the unsubscribe tears all of them down', () => {
    const { a, b, id } = mint();
    const { offs } = wire();
    const off = subscribeCandle(id, '1m', () => {});
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [a, '1m'],
      [b, '1m'],
    ]);
    off();
    expect(offs.get(`${a}|1m`)).toHaveBeenCalledTimes(1);
    expect(offs.get(`${b}|1m`)).toHaveBeenCalledTimes(1);
  });

  it('with no state at all, one leg alone cannot emit; the second leg completes the vector', () => {
    const { a, b, id } = mint();
    const { push } = wire();
    const got: Candle[] = [];
    subscribeCandle(id, '1m', (c) => got.push(c));
    const N = bucketNow();
    push(`${a}|1m`, candle(a, N, 100, 100, 100, 100));
    expect(got).toEqual([]);
    push(`${b}|1m`, candle(b, N, 50, 50, 50, 50));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ t: N, s: id, i: '1m', c: '2.0000', v: '0', n: 0 });
  });

  it('a push before both legs have pushed emits when lastSeen seeds the other leg', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    answer({ [a]: flatSeries(a, 3, () => 100), [b]: flatSeries(b, 3, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    const { push } = wire();
    const got: Candle[] = [];
    subscribeCandle(id, '1m', (c) => got.push(c));
    push(`${a}|1m`, candle(a, N + MINUTE, 100, 210, 100, 200));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ t: N + MINUTE, o: '2.0000', h: '4.2000', l: '2.0000', c: '4.0000' });
  });

  it('a subscription born before the first fetch starts emitting once the fetch lands (thin second leg)', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    const { push } = wire();
    const got: Candle[] = [];
    subscribeCandle(id, '1m', (c) => got.push(c)); // ChartCell subscribes in the same effect as the backfill
    push(`${a}|1m`, candle(a, N, 100, 100, 100, 100));
    expect(got).toEqual([]); // B unknown
    answer({ [a]: flatSeries(a, 3, () => 100), [b]: flatSeries(b, 3, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end);
    push(`${a}|1m`, candle(a, N + MINUTE, 100, 100, 100, 300));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ t: N + MINUTE, c: '6.0000' });
  });

  it('a live emission never lands below the last bar a fetch delivered', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    const { push } = wire();
    const got: Candle[] = [];
    subscribeCandle(id, '1m', (c) => got.push(c));
    push(`${a}|1m`, candle(a, N, 100, 100, 100, 100));
    push(`${b}|1m`, candle(b, N, 50, 50, 50, 50));
    expect(got.map((c) => c.t)).toEqual([N]);
    // the backfill lands with bars up to N+2m
    answer({
      [a]: flatSeries(a, 3, () => 100, N + 2 * MINUTE),
      [b]: flatSeries(b, 3, () => 50, N + 2 * MINUTE),
    });
    const { start } = backfillWindow();
    const hist = await fetchCandles(id, '1m', start, Date.now());
    expect(hist[hist.length - 1].t).toBe(N + 2 * MINUTE);
    // late pushes for older buckets are swallowed …
    push(`${a}|1m`, candle(a, N + MINUTE, 100, 100, 100, 999));
    push(`${b}|1m`, candle(b, N, 50, 50, 50, 1));
    expect(got.map((c) => c.t)).toEqual([N]);
    // … the delivered bucket re-emits in place, and the next one emits
    push(`${a}|1m`, candle(a, N + 2 * MINUTE, 100, 100, 100, 150));
    push(`${b}|1m`, candle(b, N + 3 * MINUTE, 50, 50, 50, 50));
    expect(got.map((c) => c.t)).toEqual([N, N + 2 * MINUTE, N + 3 * MINUTE]);
    expect(got[1].c).toBe('3.0000');
    expect(got[2].c).toBe('3.0000'); // A flat at its latest close
  });

  it('emissions use the formula’s stored precision, with the bar’s own magnitude as the fallback', async () => {
    const { a, b, id } = mint();
    const N = bucketNow();
    const { push } = wire();
    const got: Candle[] = [];
    subscribeCandle(id, '1m', (c) => got.push(c));
    push(`${a}|1m`, candle(a, N, 0.1, 0.1, 0.1, 0.1));
    push(`${b}|1m`, candle(b, N, 50, 50, 50, 50));
    expect(got[0].c).toBe('0.0020000'); // no fetch yet → precisionFor([0.002]) = 7
    answer({ [a]: flatSeries(a, BACKFILL_BARS, () => 100), [b]: flatSeries(b, BACKFILL_BARS, () => 50) });
    const { start, end } = backfillWindow();
    await fetchCandles(id, '1m', start, end); // ratio 2 → 4 dp stored
    push(`${a}|1m`, candle(a, N + MINUTE, 0.1, 0.1, 0.1, 0.1));
    expect(got[1]).toMatchObject({ t: N + MINUTE, c: '0.0020' });
  });

  it('pushes keep legAges current', () => {
    const { a, b, id } = mint();
    const { push } = wire();
    subscribeCandle(id, '1m', () => {});
    expect(legAges(id, '1m')).toEqual([
      { coin: a, ageMs: null },
      { coin: b, ageMs: null },
    ]);
    const N = bucketNow();
    push(`${a}|1m`, candle(a, N, 1, 1, 1, 1));
    const ages = legAges(id, '1m');
    expect(ages[0].ageMs).toBeGreaterThanOrEqual(0);
    expect(ages[0].ageMs).toBeLessThan(MINUTE + 1000);
    expect(ages[1].ageMs).toBeNull();
    // per interval: nothing seen at 5m
    expect(legAges(id, '5m').map((x) => x.ageMs)).toEqual([null, null]);
  });
});

describe('quarantine (hl/ws.ts) through the facade', () => {
  it('isCandleQuarantined / clearCandleQuarantine cover every leg of a formula', () => {
    const q = vi.mocked(hlSocket.isCandleQuarantined);
    q.mockImplementation((coin) => coin === 'BBB');
    expect(isCandleQuarantined('=AAA/BBB', '1m')).toBe(true);
    expect(isCandleQuarantined('=AAA/CCC', '1m')).toBe(false);
    expect(isCandleQuarantined('BBB', '1m')).toBe(true);
    expect(isCandleQuarantined('AAA', '1m')).toBe(false);
    clearCandleQuarantine('=AAA/BBB', '5m');
    const c = vi.mocked(hlSocket.clearCandleQuarantine);
    expect(c).toHaveBeenCalledWith('AAA', '5m');
    expect(c).toHaveBeenCalledWith('BBB', '5m');
    q.mockImplementation(() => false);
  });

  it('a formula subscription reports a rejected leg ONCE to the cell and never forwards the "=" id', () => {
    const rejects: Array<() => void> = [];
    const coins: string[] = [];
    subscribeMock.mockImplementation((coin, _i, _l, onRejected) => {
      coins.push(coin);
      if (onRejected) rejects.push(onRejected);
      return () => {};
    });
    const onRejected = vi.fn();
    const off = subscribeCandle('=AAA/BBB', '1m', () => {}, onRejected);
    expect(coins).toEqual(['AAA', 'BBB']);
    expect(rejects).toHaveLength(2);
    rejects[0]!();
    rejects[1]!();
    expect(onRejected).toHaveBeenCalledTimes(1);
    off();
  });
});
