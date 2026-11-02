import { MAX_CELLS, type SharedCell } from './shareUrl';

/**
 * Spatially-stable grid resize: a chart at (row,col) STAYS at (row,col) when
 * the grid changes — the wall must never reshuffle under the user (keeping
 * array order instead would reflow every chart into new positions on
 * 3×3→4×5).
 *
 * Rules, in priority order:
 * 1. Positions that exist in both grids keep their exact content — including
 *    deliberate empties (they're part of the arrangement).
 * 2. Charts whose position vanished (shrink) fill empty VISIBLE slots in
 *    reading order — compacting is what a shrink asks for; nothing silently
 *    vanishes while there is room.
 * 3. Brand-new positions stay EMPTY (growing the canvas is an invitation,
 *    not a guess) — except charts owed from earlier shrinks (the stash
 *    rides beyond `count` in the cells array), which return oldest-first: a
 *    shrink→grow round trip is lossless.
 * 4. Whatever still has no home stays stashed after the new count.
 */
export function resizeGrid(
  cells: SharedCell[],
  oldCount: number,
  oldCols: number,
  newCols: number,
  newRows: number,
): SharedCell[] {
  const newCount = Math.min(newCols * newRows, MAX_CELLS);
  const defaultIv = cells[0]?.interval ?? '1h';
  const empty = (): SharedCell => ({ coin: null, interval: defaultIv });

  // 1. same (row,col) survives; displaced charts queue up
  const next: (SharedCell | null)[] = Array.from({ length: MAX_CELLS }, () => null);
  const displaced: SharedCell[] = [];
  for (let i = 0; i < oldCount; i++) {
    const cell = cells[i] ?? empty();
    const r = Math.floor(i / oldCols);
    const c = i % oldCols;
    if (r < newRows && c < newCols) {
      next[r * newCols + c] = cell;
    } else if (cell.coin) {
      displaced.push(cell);
    }
  }
  // positions that are NEW (didn't exist in the old grid) are still null;
  // positions preserved from the old grid hold a cell (possibly empty)
  const isNewPosition = (i: number) => next[i] === null;

  // 2. displaced charts compact into any empty visible slot, reading order
  for (let i = 0; i < newCount && displaced.length > 0; i++) {
    if (next[i] === null || next[i]!.coin === null) {
      if (!isNewPosition(i)) next[i] = displaced.shift()!;
    }
  }
  // ...then into new positions if the preserved region had no room
  for (let i = 0; i < newCount && displaced.length > 0; i++) {
    if (next[i] === null) next[i] = displaced.shift()!;
  }

  // 3. stash owed from earlier shrinks returns into remaining NEW positions
  const stash = cells.slice(oldCount).filter((cell) => cell?.coin);
  for (let i = 0; i < newCount && stash.length > 0; i++) {
    if (next[i] === null) next[i] = stash.shift()!;
  }

  // 4. leftovers stay stashed beyond the visible count
  const out: SharedCell[] = [];
  for (let i = 0; i < newCount; i++) out.push(next[i] ?? empty());
  for (const cell of [...displaced, ...stash]) {
    if (out.length >= MAX_CELLS) break;
    out.push(cell);
  }
  while (out.length < MAX_CELLS) out.push(empty());
  return out;
}
