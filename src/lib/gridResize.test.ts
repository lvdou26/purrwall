import { describe, expect, it } from 'vitest';
import { resizeGrid } from './gridResize';
import { MAX_CELLS, type SharedCell } from './shareUrl';

// Pins the four rules in resizeGrid's header. The wall must never reshuffle
// under the user: a chart at (row,col) stays at (row,col). These are spatial
// rules, so every fixture is written as a grid and read back as one.

const c = (coin: string | null): SharedCell => ({ coin, interval: '1h' });
const cells = (...coins: (string | null)[]): SharedCell[] => coins.map(c);
/** Visible coins, in reading order, for the first `count` slots. */
const view = (out: SharedCell[], count: number) => out.slice(0, count).map((x) => x.coin);
/** Anything parked beyond the visible count (the stash). */
const stash = (out: SharedCell[], count: number) =>
  out.slice(count).map((x) => x.coin).filter((x) => x !== null);

describe('resizeGrid — rule 1: shared positions keep their exact content', () => {
  it('keeps every chart at its (row,col) when growing 2x2 → 3x3', () => {
    // A B      A B .
    // C D  →   C D .
    //          . . .
    const out = resizeGrid(cells('A', 'B', 'C', 'D'), 4, 2, 3, 3);
    expect(view(out, 9)).toEqual(['A', 'B', null, 'C', 'D', null, null, null, null]);
  });

  it('preserves a deliberate empty inside the shared region', () => {
    // A _ | C D  → widening must not slide C into the hole
    const out = resizeGrid(cells('A', null, 'C', 'D'), 4, 2, 3, 2);
    expect(view(out, 6)).toEqual(['A', null, null, 'C', 'D', null]);
  });
});

describe('resizeGrid — rule 2: shrink compacts displaced charts in reading order', () => {
  it('fills empty visible slots with charts whose position vanished', () => {
    // 3x2 → 2x2 cuts column 3, displacing C and F.
    // Rule 2 BEATS rule 1's "deliberate empties are part of the arrangement"
    // when the two collide: a shrink is a request to compact, so the hole at
    // position 1 takes the first displaced chart rather than being preserved
    // while C waits in the stash. (Rule 1 still owns the no-displacement
    // case — see the growing test above, where the hole survives.)
    const out = resizeGrid(cells('A', null, 'C', 'D', 'E', 'F'), 6, 3, 2, 2);
    expect(view(out, 4)).toEqual(['A', 'C', 'D', 'E']);
    // and nothing silently disappeared
    expect(stash(out, 4)).toEqual(['F']);
  });

  it('never drops a chart: everything that had a coin is still somewhere', () => {
    const before = cells('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I');
    const out = resizeGrid(before, 9, 3, 2, 2);
    const survivors = out.map((x) => x.coin).filter(Boolean).sort();
    expect(survivors).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  });
});

describe('resizeGrid — rule 3: new positions stay empty, but the stash comes back', () => {
  it('leaves brand-new slots empty when there is nothing owed', () => {
    const out = resizeGrid(cells('A', 'B'), 2, 2, 4, 1);
    expect(view(out, 4)).toEqual(['A', 'B', null, null]);
  });

  it('is lossless across a shrink → grow round trip', () => {
    const before = cells('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I');
    const shrunk = resizeGrid(before, 9, 3, 2, 2);
    const grown = resizeGrid(shrunk, 4, 2, 3, 3);
    expect(view(grown, 9)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  });

  it('returns stashed charts oldest-first', () => {
    // stash order is array order beyond `count`
    const withStash = [...cells('A'), ...cells('X', 'Y', 'Z')];
    const out = resizeGrid(withStash, 1, 1, 2, 2);
    expect(view(out, 4)).toEqual(['A', 'X', 'Y', 'Z']);
  });
});

describe('resizeGrid — rule 4 and hard limits', () => {
  it('parks leftovers beyond the new count instead of dropping them', () => {
    const out = resizeGrid(cells('A', 'B', 'C', 'D'), 4, 4, 1, 1);
    expect(view(out, 1)).toEqual(['A']);
    expect(stash(out, 1).sort()).toEqual(['B', 'C', 'D']);
  });

  it('always returns exactly MAX_CELLS entries, every one well-formed', () => {
    const out = resizeGrid(cells('A', 'B', 'C'), 3, 3, 6, 4);
    expect(out).toHaveLength(MAX_CELLS);
    for (const cell of out) {
      expect(cell).toHaveProperty('coin');
      expect(typeof cell.interval).toBe('string');
    }
  });

  it('cannot exceed MAX_CELLS even when asked for a bigger grid', () => {
    const out = resizeGrid(cells('A'), 1, 1, 10, 10);
    expect(out).toHaveLength(MAX_CELLS);
  });

  it('inherits the first cell’s interval for the empties it creates', () => {
    const out = resizeGrid([{ coin: 'A', interval: '15m' }], 1, 1, 2, 1);
    expect(out[1]).toEqual({ coin: null, interval: '15m' });
  });
});
