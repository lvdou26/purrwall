import { describe, expect, it } from 'vitest';
import {
  ADDR_RE,
  availOf,
  OVERLAY_BUDGET_COARSE,
  overlayLevels,
  parseAccount,
  parseBalances,
  parseOrders,
  parsePositions,
  positionsWallCoins,
  type WatchOrder,
  type WatchPosition,
} from './userState';

// Payload fixtures mirror live pushes: all numerics are strings,
// liquidationPx may be null, HIP-3 coins arrive pre-prefixed, spot order
// coins ride the main-dex feed in spotMeta's own pair-name form.

const positionPush = {
  dex: '',
  user: '0xabc',
  clearinghouseState: {
    assetPositions: [
      {
        type: 'oneWay',
        position: {
          coin: 'BTC',
          szi: '0.47454',
          leverage: { type: 'cross', value: 20 },
          entryPx: '78558.5',
          positionValue: '37323.99462',
          unrealizedPnl: '44.837128',
          liquidationPx: null,
          marginUsed: '1866.19',
          maxLeverage: 50,
        },
      },
      {
        type: 'oneWay',
        position: {
          coin: 'xyz:TSLA',
          szi: '-24.582',
          leverage: { type: 'isolated', value: 5 },
          entryPx: '346.974',
          positionValue: '8511.5175',
          unrealizedPnl: '-17.805196',
          liquidationPx: '412.11',
        },
      },
    ],
  },
};

describe('parsePositions', () => {
  it('parses string numerics, signed size, null liquidation, ROE/margin/funding', () => {
    const out = parsePositions(positionPush);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ coin: 'BTC', szi: 0.47454, entryPx: 78558.5, liqPx: null, leverage: 20 });
    expect(out[0].uPnl).toBeCloseTo(44.837128);
    expect(out[0].marginUsed).toBeCloseTo(1866.19);
    expect(out[1]).toMatchObject({ coin: 'xyz:TSLA', szi: -24.582, liqPx: 412.11, leverage: 5 });
  });

  it('carries returnOnEquity and cumFunding.sinceOpen when present', () => {
    const out = parsePositions({
      clearinghouseState: {
        assetPositions: [
          {
            position: {
              coin: 'ETH',
              szi: '1',
              entryPx: '2500',
              returnOnEquity: '0.0241',
              cumFunding: { sinceOpen: '46.35' },
            },
          },
        ],
      },
    });
    expect(out[0].roe).toBeCloseTo(0.0241);
    expect(out[0].fundingSinceOpen).toBeCloseTo(46.35);
  });

  it('skips flat, malformed, and zero-entry positions instead of throwing', () => {
    const out = parsePositions({
      clearinghouseState: {
        assetPositions: [
          { position: { coin: 'A', szi: '0', entryPx: '1' } }, // flat
          { position: { coin: 'B', szi: 'x', entryPx: '1' } }, // NaN size
          { position: { coin: 'C', szi: '1' } }, // no entry
          { nope: true },
          null,
          { position: { coin: 'D', szi: '2', entryPx: '3.5' } },
        ],
      },
    });
    expect(out.map((p) => p.coin)).toEqual(['D']);
  });

  it('returns [] on garbage payloads', () => {
    expect(parsePositions(null)).toEqual([]);
    expect(parsePositions({})).toEqual([]);
    expect(parsePositions({ clearinghouseState: { assetPositions: 'x' } })).toEqual([]);
  });
});

describe('parseAccount', () => {
  it('reads the margin summary + withdrawable and zeroes garbage', () => {
    expect(
      parseAccount({
        clearinghouseState: {
          marginSummary: { accountValue: '46083948.34', totalMarginUsed: '477.86' },
          withdrawable: '46083470.47',
        },
      }),
    ).toEqual({ value: 46083948.34, marginUsed: 477.86, withdrawable: 46083470.47 });
    expect(parseAccount({})).toEqual({ value: 0, marginUsed: 0, withdrawable: 0 });
    expect(
      parseAccount({ clearinghouseState: { marginSummary: { accountValue: 'x' } } }),
    ).toEqual({ value: 0, marginUsed: 0, withdrawable: 0 });
  });
});

describe('parseBalances', () => {
  it('parses WS spotState pushes AND raw REST bodies, dropping zero totals', () => {
    const balances = [
      { coin: 'USDC', token: 0, total: '288642.02', hold: '151435.83', entryNtl: '0.0' },
      { coin: 'PURR', token: 1, total: '509220.377', hold: '0.0', entryNtl: '62405.72' },
      { coin: 'USDE', token: 235, total: '0.0', hold: '0.0', entryNtl: '0.0' }, // emptied — dropped
      { coin: 7, total: '1' }, // garbage — dropped
    ];
    const fromWs = parseBalances({ user: '0xabc', spotState: { balances } });
    const fromRest = parseBalances({ balances });
    expect(fromWs).toEqual(fromRest);
    expect(fromWs).toHaveLength(2);
    expect(fromWs[0]).toMatchObject({ coin: 'USDC', total: 288642.02, hold: 151435.83, entryNtl: 0 });
    expect(fromWs[1]).toMatchObject({ coin: 'PURR', entryNtl: 62405.72 });
    expect(parseBalances(null)).toEqual([]);
  });
});

describe('parseOrders', () => {
  it('uses limitPx for resting orders and triggerPx for trigger orders', () => {
    const out = parseOrders({
      orders: [
        { coin: 'SOL', side: 'B', limitPx: '100.34', sz: '7.4', isTrigger: false, triggerPx: '0.0', reduceOnly: false, orderType: 'Limit' },
        { coin: 'SOL', side: 'A', limitPx: '0.0', sz: '7.4', isTrigger: true, triggerPx: '150.5', reduceOnly: true, orderType: 'Stop Market' },
        { coin: '@699', side: 'B', limitPx: '0.5', sz: '10', isTrigger: false, triggerPx: '0.0', reduceOnly: false, orderType: 'Limit' },
      ],
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ coin: 'SOL', side: 'B', px: 100.34, isTrigger: false });
    expect(out[1]).toMatchObject({ side: 'A', px: 150.5, isTrigger: true, reduceOnly: true });
    expect(out[2].coin).toBe('@699'); // spot pair-name form passes through verbatim
  });

  it('drops orders with no drawable level and garbage rows', () => {
    const out = parseOrders({
      orders: [
        { coin: 'A', side: 'B', limitPx: '0', isTrigger: false },
        { coin: 'A', side: 'X', limitPx: '1' },
        { coin: 7, side: 'B', limitPx: '1' },
        null,
      ],
    });
    expect(out).toEqual([]);
    expect(parseOrders(null)).toEqual([]);
  });
});

describe('positionsWallCoins', () => {
  const pos = (coin: string, value: number) => ({
    coin,
    szi: 1,
    entryPx: 1,
    liqPx: null,
    uPnl: 0,
    roe: 0,
    value,
    leverage: 1,
    marginUsed: 0,
    fundingSinceOpen: 0,
  });
  const ord = (coin: string, n: number): [string, WatchOrder[]] => [
    coin,
    Array.from({ length: n }, () => ({
      coin,
      side: 'B' as const,
      px: 1,
      sz: 1,
      origSz: 1,
      t: 0,
      type: 'Limit',
      isTrigger: false,
      reduceOnly: false,
      cond: '',
    })),
  ];

  it('positions by |notional| desc, then order-only coins by order count', () => {
    const coins = positionsWallCoins(
      [pos('SMALL', 100), pos('BIG', 9000), pos('MID', 500)],
      new Map([ord('BIG', 3), ord('ORDERS2', 2), ord('ORDERS5', 5)]),
    );
    expect(coins).toEqual(['BIG', 'MID', 'SMALL', 'ORDERS5', 'ORDERS2']);
  });

  it('empty account → empty wall', () => {
    expect(positionsWallCoins([], new Map())).toEqual([]);
  });
});

describe('availOf', () => {
  it('renders total − hold at ledger precision, never IEEE-754 tails', () => {
    expect(availOf(288642.02683013, 151435.838738)).toBe('137206.18809213');
    expect(availOf(0.3, 0.1)).toBe('0.2');
    expect(availOf(509220.37728, 0)).toBe('509220.37728');
    expect(availOf(100, 0)).toBe('100');
  });
});

describe('ADDR_RE', () => {
  it('admits exactly 0x + 40 hex, any case', () => {
    expect(ADDR_RE.test(`0x${'a1B2'.repeat(10)}`)).toBe(true);
    expect(ADDR_RE.test(`0x${'a'.repeat(39)}`)).toBe(false);
    expect(ADDR_RE.test(`0x${'a'.repeat(41)}`)).toBe(false);
    expect(ADDR_RE.test(`0x${'g'.repeat(40)}`)).toBe(false);
    expect(ADDR_RE.test(`${'a'.repeat(42)}`)).toBe(false);
  });
});

// ── overlayLevels: which levels carry an axis label ─────────────────────────

const pos = (o: Partial<WatchPosition> & { entryPx: number; szi: number }): WatchPosition => ({
  coin: 'BTC',
  liqPx: null,
  uPnl: 0,
  roe: 0,
  value: 0,
  leverage: 0,
  marginUsed: 0,
  fundingSinceOpen: 0,
  ...o,
});
const ord = (side: 'B' | 'A', px: number, isTrigger = false): WatchOrder => ({
  coin: 'BTC',
  side,
  px,
  sz: 1,
  origSz: 1,
  t: 0,
  type: isTrigger ? 'Stop Market' : 'Limit',
  isTrigger,
  reduceOnly: false,
  cond: '',
});
const labeled = (levels: ReturnType<typeof overlayLevels>) =>
  levels.filter((l) => l.label).map((l) => `${l.kind}:${l.side ?? '-'}:${l.price}`);

describe('overlayLevels', () => {
  const never = () => {
    throw new Error('lastPx must not be read on this path');
  };

  it('labels a market-maker ladder at its edges only, every line kept', () => {
    const buys = [100, 99.5, 99, 98.5, 98, 97.5, 97, 96.5, 96].map((p) => ord('B', p));
    const sells = [101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5, 105].map((p) => ord('A', p));
    const out = overlayLevels([pos({ szi: 1, entryPx: 99.9, liqPx: 60 })], [...buys, ...sells], never);
    expect(out).toHaveLength(20);
    expect(labeled(out)).toEqual([
      'entry:B:99.9',
      'liq:-:60',
      'order:B:100', // next buy to fill
      'order:B:96', // far end of the buy ladder
      'order:A:101', // next sell to fill
      'order:A:105', // far end of the sell ladder
    ]);
  });

  it('keeps a small retail ladder fully labeled', () => {
    const out = overlayLevels(
      [pos({ szi: 1, entryPx: 100, liqPx: 80 })],
      [ord('A', 110, true), ord('A', 95, true), ord('B', 98), ord('B', 96)],
      never,
    );
    expect(labeled(out)).toEqual(['entry:B:100', 'liq:-:80', 'order:A:110', 'order:A:95', 'order:B:98', 'order:B:96']);
  });

  it('ranks trigger levels by distance to the last price only above the budget', () => {
    let reads = 0;
    const lastPx = () => {
      reads++;
      return 100;
    };
    const six = [90, 95, 99, 101, 110, 120].map((p) => ord('A', p, true));
    const out = overlayLevels([], six, lastPx);
    expect(reads).toBe(1);
    expect(labeled(out).sort()).toEqual(['order:A:101', 'order:A:90', 'order:A:95', 'order:A:99'].sort());
    // (90 and 110 tie at distance 10 — the lower price wins, deterministically)
    // the four lowest when no bar has landed yet
    expect(labeled(overlayLevels([], six, () => null)).sort()).toEqual(
      ['order:A:90', 'order:A:95', 'order:A:99', 'order:A:101'].sort(),
    );
    // within budget: every trigger labeled, the thunk never read
    expect(labeled(overlayLevels([], six.slice(0, 4), never))).toHaveLength(4);
  });

  it('merges two wallets into one ladder with one next fill per side', () => {
    const out = overlayLevels(
      [pos({ szi: 1, entryPx: 100 }), pos({ szi: -2, entryPx: 103 }), pos({ szi: 3, entryPx: 100 })],
      [ord('B', 99), ord('B', 98), ord('B', 97), ord('B', 96), ord('B', 95), ord('A', 104), ord('A', 104)],
      never,
    );
    expect(out.filter((l) => l.kind === 'entry')).toHaveLength(2); // identical long entries dedupe
    expect(out.filter((l) => l.kind === 'order')).toHaveLength(6); // the duplicate sell dedupes
    expect(labeled(out)).toEqual(['entry:B:100', 'entry:A:103', 'order:B:99', 'order:B:95', 'order:A:104']);
  });

  it('never double-labels an order resting exactly on a position level', () => {
    const out = overlayLevels([pos({ szi: 1, entryPx: 100, liqPx: 80 })], [ord('B', 100), ord('B', 80)], never);
    expect(out.map((l) => l.label)).toEqual([true, true, false, false]);
    expect(out).toHaveLength(4); // the lines themselves survive
  });

  it('halves the budget on coarse pointers', () => {
    const buys = [100, 99, 98].map((p) => ord('B', p));
    expect(labeled(overlayLevels([], buys, never))).toHaveLength(3);
    expect(labeled(overlayLevels([], buys, never, OVERLAY_BUDGET_COARSE))).toEqual(['order:B:100', 'order:B:98']);
  });

  it('anchors on the first entry when no bar has landed', () => {
    const six = [90, 95, 99, 101, 110, 120].map((p) => ord('A', p, true));
    const out = overlayLevels([pos({ szi: 1, entryPx: 100 })], six, () => null);
    expect(labeled(out).filter((k) => k.startsWith('order')).sort()).toEqual(
      ['order:A:101', 'order:A:90', 'order:A:95', 'order:A:99'].sort(),
    );
  });

  it('caps the stack: the farthest order labels go first, positions never', () => {
    let reads = 0;
    const lastPx = () => {
      reads++;
      return 100;
    };
    const triggers = [120, 130, 140, 150].map((p) => ord('A', p, true));
    const buys = [99, 98, 97, 96].map((p) => ord('B', p));
    const sells = [101, 102, 103, 104].map((p) => ord('A', p));
    const out = overlayLevels(
      [pos({ szi: 1, entryPx: 100, liqPx: 50 })],
      [...triggers, ...buys, ...sells],
      lastPx,
    );
    const got = labeled(out);
    expect(got).toHaveLength(10); // 14 candidates, the fine cap
    expect(got.slice(0, 2)).toEqual(['entry:B:100', 'liq:-:50']);
    expect(got.filter((k) => /order:A:1[2-5]0$/.test(k))).toEqual([]); // the far triggers shed
    expect(reads).toBe(1);
  });

  it('coarse cap drops the far ends before the next fills', () => {
    const buys = [100, 99.5, 99, 98.5, 98, 97.5, 97, 96.5, 96].map((p) => ord('B', p));
    const sells = [101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5, 105].map((p) => ord('A', p));
    const out = overlayLevels(
      [pos({ szi: 1, entryPx: 99.9, liqPx: 60 })],
      [...buys, ...sells, ord('A', 100.5, true), ord('B', 99.5, true)],
      () => 100,
      OVERLAY_BUDGET_COARSE,
    );
    expect(labeled(out).sort()).toEqual(
      ['entry:B:99.9', 'liq:-:60', 'order:B:100', 'order:A:101', 'order:A:100.5', 'order:B:99.5'].sort(),
    );
  });

  it('coarse budget also halves the TRIGGER allowance (nearest two to the anchor)', () => {
    const three = [90, 99, 101].map((p) => ord('A', p, true));
    expect(labeled(overlayLevels([], three, never))).toHaveLength(3);
    expect(labeled(overlayLevels([], three, () => 100, OVERLAY_BUDGET_COARSE)).sort()).toEqual(
      ['order:A:99', 'order:A:101'].sort(),
    );
  });

  it('labels one box per PRICE across kinds and sides, lines untouched', () => {
    // a limit and a trigger sell at one level, a buy and a sell at another
    const out = overlayLevels(
      [],
      [ord('A', 105), ord('A', 105, true), ord('B', 100), ord('A', 100, true)],
      never,
    );
    expect(out).toHaveLength(4);
    expect(out.map((l) => l.label)).toEqual([true, false, true, false]);
  });

  it('keeps the double-label rule on the over-budget ladder (an edge resting on the entry)', () => {
    const buys = [100, 99, 98, 97, 96].map((p) => ord('B', p));
    const out = overlayLevels([pos({ szi: 1, entryPx: 100 })], buys, never);
    expect(labeled(out)).toEqual(['entry:B:100', 'order:B:96']); // the near edge yields to the entry
  });

  it('is stable across identical pushes and drops the liq level when null', () => {
    const a = overlayLevels([pos({ szi: 1, entryPx: 100 })], [ord('B', 99), ord('A', 101)], never);
    const b = overlayLevels([pos({ szi: 1, entryPx: 100 })], [ord('B', 99), ord('A', 101)], never);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.some((l) => l.kind === 'liq')).toBe(false);
  });
});
