/*
 * THE LIVE CATALOG. A wall left open — the product's whole point — must learn
 * about a new listing without a reload. The 60 s stats poll already downloads
 * every listing the catalog was built from (metaAndAssetCtxs[0] ≡ meta,
 * spotMetaAndAssetCtxs[0] ≡ spotMeta, byte-identical), so detecting drift
 * costs nothing; only acting on it spends weight:
 *
 * - perps / live HIP-3 dexs / spot changed → the full load (~17 requests,
 *   ~340 weight) — rare, a few times a week;
 * - only HIP-4 outcomes changed → loadOutcomes (3 requests) — HIP-4 churns
 *   ~200 outcomes a day, a 15-minute rolling BTC binary among them;
 * - every 30 min regardless → the full load, for what the poll cannot see
 *   (a NEW HIP-3 dex, annotation display names, outcome templates).
 *
 * Refreshes ride the poll, so a hidden tab never spends anything and a
 * returning one catches up on its first tick. Every result is applied through
 * mergeCatalog (identity-preserving, never-degrading) — see markets.ts.
 */
import { mergeCatalog, patchOutcomes, type MarketCatalog, type loadOutcomes } from './markets';
import type { PollListing } from './stats';

/** Drift ids are '+class:id' (listed, unknown) / '-class:id' (known, gone). */
export interface CatalogDrift {
  /** perps, HIP-3 (per polled dex) and spot — needs the full load */
  full: string[];
  /** HIP-4 outcome sides — loadOutcomes suffices */
  outcomes: string[];
}

function diffInto(out: string[], tag: string, listed: readonly string[], known: ReadonlySet<string>): void {
  const listedSet = new Set(listed);
  for (const id of listedSet) if (!known.has(id)) out.push(`+${tag}:${id}`);
  for (const id of known) if (!listedSet.has(id)) out.push(`-${tag}:${id}`);
}

/**
 * Zero false positives by construction: on the live payloads a naive "any id
 * the poll mentions" test fires ~240 ids EVERY minute (delisted perps, ~90
 * orphan spot ctxs, hidden pairs, fallback outcome sides). So perps compare
 * NON-delisted universe names against the catalog's own markets of that dex,
 * spot compares universe pair names (never ctx coins or allMids keys) against
 * spotSeen, and HIP-4 compares '#' ctx coins against outcomeSeen — the two
 * baselines include what the loaders deliberately drop.
 */
export function catalogDrift(catalog: MarketCatalog, listing: PollListing): CatalogDrift {
  const full: string[] = [];
  for (const [dex, names] of listing.perps) {
    const known = new Set(
      catalog.markets
        .filter((m) => (dex === '' ? m.kind === 'perp' : m.kind === 'hip3' && m.dex === dex))
        .map((m) => m.coin),
    );
    diffInto(full, dex === '' ? 'perp' : `hip3/${dex}`, names, known);
  }
  if (listing.spot) diffInto(full, 'spot', listing.spot, catalog.spotSeen);
  const outcomes: string[] = [];
  if (listing.outcomes) diffInto(outcomes, 'hip4', listing.outcomes, catalog.outcomeSeen);
  return { full, outcomes };
}

/** No two refreshes of one kind closer than this (leading edge). */
export const REFRESH_MIN_GAP_MS = 5 * 60_000;
/** A full load at least this often, drift or not. */
export const REFRESH_BACKSTOP_MS = 30 * 60_000;

export interface CatalogRefresherDeps {
  now(): number;
  /** When the committed catalog was loaded (default: now) — a tab booted in
   *  the background creates its refresher at boot, so its first visible poll
   *  hours later finds the backstop due at once. */
  loadedAt?: number;
  /** The catalog as last committed (App's ref) — null before the first load. */
  current(): MarketCatalog | null;
  /** Commit a new catalog; receives the latest state, like a setState updater. */
  apply(update: (prev: MarketCatalog) => MarketCatalog): void;
  loadFull(): Promise<MarketCatalog>;
  loadOutcomes: typeof loadOutcomes;
}

export interface CatalogRefresher {
  /** Feed one stats-poll result. Resolves once any refresh it started is applied. */
  onPoll(listing: PollListing): Promise<void>;
}

export function createCatalogRefresher(deps: CatalogRefresherDeps): CatalogRefresher {
  // The boot load is a full load: nothing is due for one gap / backstop.
  let lastFull = deps.loadedAt ?? deps.now();
  let lastOutcomes = lastFull;
  let busy = false;
  // An id still drifting after a refresh of its kind gets a strike; two
  // strikes and it is ignored until the next backstop. One strike covers a
  // plain race (the poll saw a listing a moment before the meta endpoint
  // did); a second means the drift rule and the loaders disagree about it —
  // a future HL payload shape — and without this it would re-fire a 340-
  // weight load every 5 minutes, forever, in every open tab.
  let strikes = new Map<string, number>();

  const live = (ids: string[]) => ids.filter((id) => (strikes.get(id) ?? 0) < 2);
  const strike = (ids: string[]) => {
    for (const id of ids) strikes.set(id, (strikes.get(id) ?? 0) + 1);
  };

  return {
    async onPoll(listing) {
      const catalog = deps.current();
      if (!catalog || busy) return;
      const t = deps.now();
      const drift = catalogDrift(catalog, listing);
      const backstop = t - lastFull >= REFRESH_BACKSTOP_MS;
      const full = backstop || (live(drift.full).length > 0 && t - lastFull >= REFRESH_MIN_GAP_MS);
      const outcomes = !full && live(drift.outcomes).length > 0 && t - lastOutcomes >= REFRESH_MIN_GAP_MS;
      if (!full && !outcomes) return;

      busy = true;
      try {
        if (full) {
          lastFull = lastOutcomes = t;
          if (backstop) strikes = new Map();
          const next = await deps.loadFull();
          deps.apply((prev) => mergeCatalog(prev, next));
          // strike against what was COMMITTED: a slice mergeCatalog refused
          // (failed to load) keeps its drift, and that drift must count too
          const base = deps.current() ?? catalog;
          const after = catalogDrift(mergeCatalog(base, next), listing);
          strike([...after.full, ...after.outcomes]);
        } else {
          lastOutcomes = t;
          const o = await deps.loadOutcomes();
          deps.apply((prev) => mergeCatalog(prev, patchOutcomes(prev, o)));
          const base = deps.current() ?? catalog;
          strike(catalogDrift(mergeCatalog(base, patchOutcomes(base, o)), listing).outcomes);
        }
      } catch (err) {
        // Silent by design: a background refresh never raises the banner,
        // never touches marketError, and the catalog stays what it was.
        console.warn('[purrwall] live catalog refresh failed:', err);
      } finally {
        busy = false;
      }
    },
  };
}
