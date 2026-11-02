/*
 * The market table's search + Strict decision, DOM-free so vitest can pin it
 * (MarketTable.tsx renders the result). One rule this module exists for:
 * a typed name must never dead-end on "No markets match" while the market it
 * names is listed. HL's own picker applies Strict BEFORE the query, so a thin
 * new listing that is not on HL's allowlist is unfindable there until the
 * user thinks of flipping to All; here, when Strict hides EVERY match of
 * the query, the tab's unfiltered matches show under a one-line hint and
 * the toggle itself stays on Strict.
 */
import { passesStrict } from './hl/markets';
import type { Market } from './hl/types';

/** "BTC-USDC" → "btc", "HYPE/USDC" → "hype" — what a query matches against. */
export function baseSegment(display: string): string {
  return display.split(/[-/]/)[0].toLowerCase();
}

/** Base-segment substring plus keyword aliases, like HL ("claude" → ANTHROPIC). */
export function matchesQuery(m: Market, q: string): boolean {
  return baseSegment(m.display).includes(q) || (m.keywords?.some((k) => k.includes(q)) ?? false);
}

export interface SearchInput {
  /** The active tab's rows (sub-tab applied), Strict NOT applied. */
  tabRows: readonly Market[];
  /** Trimmed, lower-cased query; '' = no query. */
  q: string;
  /** Strict is on AND applies to this tab (the caller owns the gate). */
  strict: boolean;
  /** Cross-tab fallback source (list mode / formula mode), null = none. */
  catalog: readonly Market[] | null;
  /** Picker full-name resolve ('hype/usdc', 'xyz:tsla'), null = none. */
  resolveFull: ((q: string) => Market | undefined) | null;
}

export interface SearchResult {
  rows: Market[];
  /** Rows came from the whole catalog (the active tab had no match). */
  crossTab: boolean;
  /** Rows came from outside Strict (Strict hid every match in this tab). */
  strictRelaxed: boolean;
}

/**
 * Order: Strict rows matching the query → the same tab's rows without Strict
 * (strictRelaxed) → the whole catalog (crossTab; list/formula mode only) →
 * the picker's exact full-name resolve. A PARTIAL hide stays hidden — the
 * fallback fires only when Strict left the query nothing — and outcome
 * markets never come out of the fallbacks (question rows are not markets).
 */
export function searchRows({ tabRows, q, strict, catalog, resolveFull }: SearchInput): SearchResult {
  const base = strict ? tabRows.filter(passesStrict) : [...tabRows];
  if (!q) return { rows: base, crossTab: false, strictRelaxed: false };
  const match = (m: Market) => matchesQuery(m, q);

  const rows = base.filter(match);
  if (rows.length > 0) return { rows, crossTab: false, strictRelaxed: false };
  if (strict) {
    const relaxed = tabRows.filter(match);
    if (relaxed.length > 0) return { rows: relaxed, crossTab: false, strictRelaxed: true };
  }
  if (catalog) {
    const cross = catalog.filter((m) => m.kind !== 'hip4' && match(m));
    if (cross.length > 0) return { rows: cross, crossTab: true, strictRelaxed: false };
  }
  const exact = resolveFull?.(q);
  if (exact && exact.kind !== 'hip4') {
    // flagged only when Strict is what hid it IN THIS TAB — a pair resolved
    // from outside the tab (Trending, a quote sub-tab) was never Strict's doing
    const hidden = strict && !passesStrict(exact) && tabRows.some((m) => m.coin === exact.coin);
    return { rows: [exact], crossTab: false, strictRelaxed: hidden };
  }
  return { rows: [], crossTab: false, strictRelaxed: false };
}
