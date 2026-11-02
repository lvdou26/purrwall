import { INTERVALS, type Interval } from './hl/types';

/** The rows×cols grid picker allows up to 6 columns × 4 rows. */
export const MAX_COLS = 6;
export const MAX_ROWS = 4;
export const MAX_CELLS = MAX_COLS * MAX_ROWS;

export interface SharedCell {
  coin: string | null;
  interval: Interval;
}

export interface SharedLayout {
  count: number;
  cols: number;
  cells: SharedCell[];
  /** User-given wall name (v3 hashes only) — travels so the receiving
   *  device's "save current as…" can pre-fill it. */
  name: string | null;
}

/** The square-ish column count implied by v1 hashes and by saved layouts
 *  that carry no `cols`. */
export function defaultColsFor(count: number): number {
  return Math.min(Math.ceil(Math.sqrt(Math.max(count, 1))), MAX_COLS);
}

export function clampCols(cols: number, count: number): number {
  const c = Math.round(Number(cols));
  if (!Number.isFinite(c) || c < 1 || c > MAX_COLS) return defaultColsFor(count);
  return c;
}

/**
 * Layout ⇄ URL hash. v3: `w=3;<cols>x<rows>;n=<enc(name)>;<cell>;…` (name
 * segment only when the wall has a user-given name — nameless walls keep
 * emitting v2); v2: `w=2;<cols>x<rows>;<cell>;…`; v1 (`w=1;<count>;…`)
 * still decodes, deriving a square-ish column count. A cell is
 * `<encodeURIComponent(coin)>~<interval>` or empty; coins are percent-encoded
 * (they can contain `:` `/` `@` `#` `&`), so `;` and `~` stay unambiguous.
 */
export function encodeLayoutHash(
  count: number,
  cols: number,
  cells: SharedCell[],
  name?: string | null,
): string {
  const c = clampCols(cols, count);
  const rows = Math.max(1, Math.ceil(count / c));
  const parts = cells
    .slice(0, count)
    .map((cell) => (cell.coin ? `${encodeURIComponent(cell.coin)}~${cell.interval}` : ''));
  // a malformed name (e.g. a lone surrogate from a foreign truncation) makes
  // encodeURIComponent throw — degrade to the nameless v2 form, never crash
  let nameSeg = '';
  if (name) {
    try {
      nameSeg = `n=${encodeURIComponent(name)};`;
    } catch {
      nameSeg = '';
    }
  }
  return nameSeg
    ? `w=3;${c}x${rows};${nameSeg}${parts.join(';')}`
    : `w=2;${c}x${rows};${parts.join(';')}`;
}

export function decodeLayoutHash(hash: string): SharedLayout | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const v3 = raw.startsWith('w=3;');
  const v2 = raw.startsWith('w=2;');
  if (!v3 && !v2 && !raw.startsWith('w=1;')) return null;
  const parts = raw.slice(4).split(';');

  let count: number;
  let cols: number;
  let cellsAt = 1;
  let name: string | null = null;
  if (v3 || v2) {
    const m = /^(\d+)x(\d+)$/.exec(parts[0] ?? '');
    if (!m) return null;
    cols = Math.min(Math.max(Number(m[1]), 1), MAX_COLS);
    if (v3 && parts[1]?.startsWith('n=')) {
      cellsAt = 2;
      try {
        // truncate by CODE POINTS — a .slice on UTF-16 units can cut a
        // surrogate pair in half, and the lone surrogate would make the
        // re-encode throw later
        name = [...decodeURIComponent(parts[1].slice(2))].slice(0, 64).join('') || null;
      } catch {
        name = null;
      }
    }
    // The encoder emits exactly `count` cell segments; CxR only validates the
    // FORMAT and carries cols. Deriving count from the token breaks two ways
    // (either round-trip boot-classifies the user's own wall as a foreign
    // share — persistence off, Save hidden — and the first edit persists the
    // damage): cols×rows INFLATES non-rectangular walls (13 cells @ 4 cols
    // → 16), and capping at cols×MAX_ROWS TRUNCATES tall phone walls (24
    // cells @ 3 cols → 12 — phone count chips make count > cols×4
    // reachable, so the only sound ceiling is MAX_CELLS). Every v2/v3 hash
    // carries exactly `count` segments (trailing empty cells encode as '' and
    // split(';') preserves them), so counting segments decodes old and new
    // links alike.
    count = Math.min(Math.max(parts.length - cellsAt, 1), MAX_CELLS);
  } else {
    count = Math.min(Math.max(Math.round(Number(parts[0])) || 0, 1), MAX_CELLS);
    if (!count) return null;
    cols = defaultColsFor(count);
  }

  const cells: SharedCell[] = Array.from({ length: MAX_CELLS }, (_, i) => {
    const part = parts[cellsAt + i];
    if (!part || i >= count) return { coin: null, interval: '1h' as Interval };
    const sep = part.lastIndexOf('~');
    const coinEnc = sep === -1 ? part : part.slice(0, sep);
    const iv = sep === -1 ? '1h' : part.slice(sep + 1);
    let coin: string | null = null;
    try {
      coin = decodeURIComponent(coinEnc) || null;
    } catch {
      coin = null;
    }
    return {
      coin,
      interval: (INTERVALS as readonly string[]).includes(iv) ? (iv as Interval) : ('1h' as Interval),
    };
  });
  return { count, cols, cells, name };
}
