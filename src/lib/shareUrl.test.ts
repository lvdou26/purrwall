import { describe, expect, it } from 'vitest';
import {
  MAX_CELLS,
  MAX_COLS,
  clampCols,
  decodeLayoutHash,
  defaultColsFor,
  encodeLayoutHash,
  type SharedCell,
} from './shareUrl';

const cell = (coin: string | null, interval = '1h'): SharedCell =>
  ({ coin, interval }) as SharedCell;

const fill = (count: number, coin = 'BTC'): SharedCell[] =>
  Array.from({ length: count }, (_, i) => cell(`${coin}${i}`));

/** encode → decode must preserve count, cols, and every placed cell. */
function roundTrip(count: number, cols: number, cells: SharedCell[], name?: string | null) {
  const decoded = decodeLayoutHash(encodeLayoutHash(count, cols, cells, name));
  expect(decoded).not.toBeNull();
  return decoded!;
}

describe('encode/decode round-trip', () => {
  it('preserves a full rectangular wall', () => {
    const d = roundTrip(9, 3, fill(9));
    expect(d.count).toBe(9);
    expect(d.cols).toBe(3);
    expect(d.cells.slice(0, 9).map((c) => c.coin)).toEqual(fill(9).map((c) => c.coin));
  });

  it('preserves a tall phone wall where count > cols×4', () => {
    // 24 cells @ 3 cols = 8 rows; capping count at cols×MAX_ROWS would truncate
    // this to 12 and boot-classify the user's own wall as a foreign share.
    const d = roundTrip(24, 3, fill(24));
    expect(d.count).toBe(24);
    expect(d.cols).toBe(3);
    expect(d.cells[23].coin).toBe('BTC23');
  });

  it('preserves non-rectangular counts instead of inflating to cols×rows', () => {
    // 13 cells @ 4 cols → 4 rows; deriving count from CxR would inflate this to 16.
    const d = roundTrip(13, 4, fill(13));
    expect(d.count).toBe(13);
    expect(d.cols).toBe(4);
  });

  it('emits exactly `count` segments from an always-24-length cells array (App passes cells whole)', () => {
    // App.tsx keeps layout.cells at MAX_CELLS length permanently; the encoder's
    // .slice(0, count) is what stops a 9-count wall from emitting 24 segments
    // and decode-inflating (count derives from segment count).
    const cells = [...fill(9), ...Array.from({ length: 15 }, () => cell(null))];
    const d = roundTrip(9, 3, cells);
    expect(d.count).toBe(9);
    expect(d.cells[9].coin).toBeNull();
  });

  it('preserves trailing empty cells in the count', () => {
    const cells = [cell('BTC'), cell(null), cell(null), cell(null), cell(null), cell(null)];
    const d = roundTrip(6, 3, cells);
    expect(d.count).toBe(6);
    expect(d.cells[0].coin).toBe('BTC');
    expect(d.cells[5].coin).toBeNull();
  });

  it('round-trips every coin id format (percent-encoded separators)', () => {
    const coins = ['BTC', 'PURR/USDC', '@107', 'xyz:TSLA', '#1730', 'A&B~C;D'];
    const d = roundTrip(6, 3, coins.map((c) => cell(c)));
    expect(d.cells.slice(0, 6).map((c) => c.coin)).toEqual(coins);
  });

  it('round-trips formula ids unchanged', () => {
    // A canonical formula id is '=' + coin ids joined by + - * / ( ) [ ] and
    // decimal constants. '=' encodes as %3D (so the v3 'n=' check cannot be
    // fooled), ( ) * - . stay raw, and none of them is a codec separator
    // (';' and '~'). The 69-char case is the 4-leg worst case over invented
    // 14-char HIP-3-shaped ids.
    const long = '=(zz:AAAAAAAAAA1+zz:BBBBBBBBBB2)/(zz:CCCCCCCCCC3-zz:DDDDDDDDDD4)*0.25';
    expect(long).toHaveLength(69);
    const coins = ['=HYPE/ETH', '=[PURR/USDC]/HYPE', '=(HYPE+ETH)/2', long];
    const d = roundTrip(4, 2, coins.map((c) => cell(c)));
    expect(d.cells.slice(0, 4).map((c) => c.coin)).toEqual(coins);
  });

  it('round-trips intervals and defaults unknown ones to 1h', () => {
    const d = roundTrip(2, 2, [cell('BTC', '1m'), cell('ETH', '1d')]);
    expect(d.cells[0].interval).toBe('1m');
    expect(d.cells[1].interval).toBe('1d');
    const bad = decodeLayoutHash('w=2;1x1;BTC~99h');
    expect(bad!.cells[0]).toEqual({ coin: 'BTC', interval: '1h' });
  });

  it('carries the interval through case-exactly', () => {
    // HL's interval strings are case-SIGNIFICANT ('1M' is a 30-day bucket,
    // '1m' is one minute) and the codec puts them in a URL that third parties
    // lowercase when auto-linking. Nothing in the app folds case today; this
    // pins that, so a future horizon whose name differs only by case cannot
    // silently degrade a shared wall into the wrong timeframe.
    const d = roundTrip(1, 1, [cell('BTC', '1w')]);
    expect(d.cells[0].interval).toBe('1w');
    const lowered = decodeLayoutHash('w=2;1x1;BTC~1W');
    expect(lowered!.cells[0].interval).toBe('1h'); // not silently read as 1w
  });
});

describe('v3 names', () => {
  it('round-trips a unicode wall name', () => {
    const d = roundTrip(1, 1, [cell('BTC')], '我的墙 🐱');
    expect(d.name).toBe('我的墙 🐱');
    expect(d.count).toBe(1);
    expect(d.cells[0].coin).toBe('BTC');
  });

  it('emits nameless walls as v2', () => {
    expect(encodeLayoutHash(1, 1, [cell('BTC')])).toMatch(/^w=2;/);
    expect(encodeLayoutHash(1, 1, [cell('BTC')], null)).toMatch(/^w=2;/);
  });

  it('degrades a malformed (lone-surrogate) name to nameless v2 instead of throwing', () => {
    const hash = encodeLayoutHash(1, 1, [cell('BTC')], '\ud83d');
    expect(hash).toMatch(/^w=2;/);
    expect(decodeLayoutHash(hash)!.name).toBeNull();
  });

  it('truncates decoded names by code points, never splitting a surrogate pair', () => {
    const name = '🐱'.repeat(70); // 70 code points, 140 UTF-16 units
    const d = roundTrip(1, 1, [cell('BTC')], name);
    expect(d.name).toBe('🐱'.repeat(64));
    // the truncated name must survive a re-encode (no lone surrogate)
    expect(() => encodeURIComponent(d.name!)).not.toThrow();
  });
});

describe('v1 decode', () => {
  it('derives square-ish cols from count', () => {
    const d = decodeLayoutHash('#w=1;9;BTC~1h;ETH~4h')!;
    expect(d.count).toBe(9);
    expect(d.cols).toBe(3);
    expect(d.cells[0].coin).toBe('BTC');
    expect(d.cells[1].interval).toBe('4h');
    expect(d.name).toBeNull();
  });

  it('clamps count into [1, MAX_CELLS]', () => {
    expect(decodeLayoutHash('w=1;999')!.count).toBe(MAX_CELLS);
    expect(decodeLayoutHash('w=1;0')!.count).toBe(1);
  });
});

describe('malformed input', () => {
  it('rejects non-wall hashes', () => {
    expect(decodeLayoutHash('')).toBeNull();
    expect(decodeLayoutHash('#list')).toBeNull();
    expect(decodeLayoutHash('w=4;3x3;BTC~1h')).toBeNull();
    expect(decodeLayoutHash('w=2;nonsense;BTC~1h')).toBeNull();
  });

  it('caps decoded count at MAX_CELLS for oversized cell lists', () => {
    const spam = `w=2;6x4;${Array.from({ length: 100 }, () => 'BTC~1h').join(';')}`;
    expect(decodeLayoutHash(spam)!.count).toBe(MAX_CELLS);
  });

  it('turns an undecodable coin into an empty cell, not a crash', () => {
    const d = decodeLayoutHash('w=2;1x1;%E0%A4%A~1h')!;
    expect(d.cells[0].coin).toBeNull();
  });
});

describe('cols helpers', () => {
  it('defaultColsFor is square-ish and capped', () => {
    expect(defaultColsFor(1)).toBe(1);
    expect(defaultColsFor(9)).toBe(3);
    expect(defaultColsFor(10)).toBe(4);
    expect(defaultColsFor(24)).toBe(5);
    expect(defaultColsFor(36)).toBe(MAX_COLS);
  });

  it('clampCols falls back to the square-ish default when out of range', () => {
    expect(clampCols(3, 9)).toBe(3);
    expect(clampCols(0, 9)).toBe(3);
    expect(clampCols(7, 9)).toBe(3);
    expect(clampCols(Number.NaN, 4)).toBe(2);
  });
});
