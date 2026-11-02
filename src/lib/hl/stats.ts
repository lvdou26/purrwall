import { info } from './info';
import type { Market } from './types';

/** Per-market stats for the picker table, mirroring Hyperliquid's columns. */
export interface MarketStats {
  last: number | null;
  prevDayPx: number | null;
  /**
   * Funding as a decimal, per HOUR — the raw `ctx.funding`, unscaled.
   *
   * Hyperliquid charges funding every hour, on every perp market including
   * every HIP-3 builder dex (`fundingHistory` returns 24 samples/day at 59-60
   * min spacing, with byte-identical timestamps on BTC and xyz:NVDA, and
   * `predictedFundings` reports `HlPerp fundingIntervalHours: 1` on every
   * coin). The docs' formula is written in 8h units and then divided by 8 to
   * charge — which is why HL's own market SELECTOR shows `8h Funding` =
   * `8 * funding * 100`.
   *
   * We show the hourly rate instead because our surfaces sit next to a chart,
   * and the HL surface that sits next to a chart — the trade-page header — is
   * the hourly one. Formatting matches it byte for byte (`*100`, 4 decimals),
   * so a user cross-checking a Purrwall cell against app.hyperliquid.xyz sees
   * the SAME string rather than an unexplained 8x. The period is in the label
   * (`1h Funding`), not just a tooltip, because phones have no hover.
   */
  funding1h: number | null;
  volumeUsd: number | null;
  openInterestUsd: number | null;
  /** Spot only: circulating supply × mark price. */
  marketCapUsd: number | null;
  maxLeverage: number | null;
  /** Formula cells only (synthesized by App.statsFor, never by the poll):
   *  each leg's display label and its own 24h change — the stats bar shows
   *  them in place of F/OI/V so the reader can see WHICH leg moved. */
  legs?: Array<{ label: string; chgPct: number | null }>;
}

interface PerpAssetMeta {
  name: string;
  maxLeverage?: number;
  isDelisted?: boolean;
}

interface PerpCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  markPx: string;
  midPx: string | null;
}

interface SpotCtx {
  coin: string;
  prevDayPx: string;
  dayNtlVlm: string;
  markPx: string;
  midPx: string | null;
  circulatingSupply: string;
}

const num = (s: string | null | undefined): number | null => {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function perpStats(asset: PerpAssetMeta, ctx: PerpCtx): MarketStats {
  const mark = num(ctx.markPx);
  const oi = num(ctx.openInterest);
  return {
    last: num(ctx.midPx) ?? mark,
    prevDayPx: num(ctx.prevDayPx),
    funding1h: num(ctx.funding),
    volumeUsd: num(ctx.dayNtlVlm),
    openInterestUsd: oi !== null && mark !== null ? oi * mark : null,
    marketCapUsd: null,
    maxLeverage: asset.maxLeverage ?? null,
  };
}

async function loadPerpDexStats(dex: string, out: Map<string, MarketStats>, listing: PollListing): Promise<void> {
  const [meta, ctxs] = await info<[{ universe: PerpAssetMeta[] }, PerpCtx[]]>({
    type: 'metaAndAssetCtxs',
    ...(dex ? { dex } : {}),
  });
  listing.perps.set(
    dex,
    meta.universe.filter((a) => !a.isDelisted).map((a) => a.name),
  );
  meta.universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (asset.isDelisted || !ctx) return;
    out.set(asset.name, perpStats(asset, ctx));
  });
}

/**
 * The one compact-dollar formatter: $2.32B / $76.2M / $431k. Lives here beside
 * fmtFunding for the same reason that one does — two surfaces need it (the
 * per-cell stats bar and the tables' narrow columns), and two copies of a
 * display rule drift. Both callers render through this.
 * Compact is not a preference: a truncated number reads as untrustworthy, so
 * the narrow surfaces must shorten deliberately rather than clip.
 */
export function compactUsd(n: number | null): string {
  if (n === null) return '--';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

/**
 * The one funding formatter — both the tables and the per-cell badge render
 * through this so the two can never drift apart on decimals. 4 decimals is
 * what Hyperliquid's own trade-page header uses on the same number; keeping
 * it identical is the whole point of showing the hourly rate.
 */
export function fmtFunding(n: number | null): string {
  if (n === null) return '--';
  return `${(n * 100).toFixed(4)}%`;
}

/**
 * The hourly rate extrapolated to a year, HL's own hover figure
 * (`100*n*365*24` in its bundle). Many perps sit exactly on their dex's
 * interest-rate floor, so the same hourly value repeats across that dex and
 * annualizes identically too; the hover is HL's secondary figure, not a
 * tie-breaker. It is an extrapolation of a rate that is recomputed every
 * hour, never a realized return.
 */
export function fundingApr(n: number | null): string {
  if (n === null) return '--';
  return `${(n * 24 * 365 * 100).toFixed(2)}%`;
}

const EMPTY: MarketStats = {
  last: null,
  prevDayPx: null,
  funding1h: null,
  volumeUsd: null,
  openInterestUsd: null,
  marketCapUsd: null,
  maxLeverage: null,
};

/**
 * What the poll saw LISTED, for the live-catalog drift check
 * (hl/catalogSync.ts). The poll's metaAndAssetCtxs[0] / spotMetaAndAssetCtxs[0]
 * are byte-identical to the meta / spotMeta the catalog was built from, so a
 * new listing shows up here within one poll at zero extra weight. A part whose
 * request failed is absent (null / no map entry) — absence is never read as
 * "everything was delisted".
 */
export interface PollListing {
  /** dex ('' = main) → names of its live (non-delisted) assets */
  perps: Map<string, string[]>;
  /** every spot universe pair name (hidden pairs included) */
  spot: string[] | null;
  /** every HIP-4 outcome side coin ('#…') that carries a spot ctx */
  outcomes: string[] | null;
}

export interface StatsPoll {
  stats: Map<string, MarketStats>;
  listing: PollListing;
}

/**
 * Fetch table stats for every market: native perps + each live HIP-3 dex via
 * metaAndAssetCtxs, spot via spotMetaAndAssetCtxs, HIP-4 last prices via
 * allMids — 3 + (live HIP-3 dex count) requests (~120 weight with 4 dexs),
 * polled every 60 s while the tab is visible, cached for 30 s.
 */
async function fetchAll(hip3Dexs: readonly string[]): Promise<StatsPoll> {
  const out = new Map<string, MarketStats>();
  const listing: PollListing = { perps: new Map(), spot: null, outcomes: null };

  const tasks: Promise<void>[] = [
    loadPerpDexStats('', out, listing),
    ...hip3Dexs.map((d) => loadPerpDexStats(d, out, listing)),
    info<[{ universe: { name: string }[] }, SpotCtx[]]>({ type: 'spotMetaAndAssetCtxs' }).then(([meta, ctxs]) => {
      listing.spot = meta.universe.map((p) => p.name);
      listing.outcomes = ctxs.filter((c) => c.coin.startsWith('#')).map((c) => c.coin);
      for (const ctx of ctxs) {
        const mark = num(ctx.markPx);
        const supply = num(ctx.circulatingSupply);
        out.set(ctx.coin, {
          ...EMPTY,
          last: num(ctx.midPx) ?? mark,
          prevDayPx: num(ctx.prevDayPx),
          volumeUsd: num(ctx.dayNtlVlm),
          marketCapUsd: mark !== null && supply !== null ? mark * supply : null,
        });
      }
    }),
    // HIP-4 outcome ctxs ride along in spotMetaAndAssetCtxs (coin "#…"), so
    // the spot task above usually covers them; allMids only fills gaps and
    // must never clobber the richer entry (tasks race in parallel).
    info<Record<string, string>>({ type: 'allMids' }).then((mids) => {
      for (const [coin, mid] of Object.entries(mids)) {
        if (coin.startsWith('#') && !out.has(coin)) out.set(coin, { ...EMPTY, last: num(mid) });
      }
    }),
  ];

  const results = await Promise.allSettled(tasks);
  let failures = 0;
  for (const r of results) {
    if (r.status === 'rejected') {
      failures++;
      console.warn('[purrwall] stats fetch failed:', r.reason);
    }
  }
  // Everything failed (offline / rate-limited): reject so the result is not
  // cached as an empty map for the whole TTL.
  if (out.size === 0 && failures > 0) {
    throw new Error('all market stats requests failed');
  }
  return { stats: out, listing };
}

const TTL_MS = 30_000;
let cache: { at: number; key: string; promise: Promise<StatsPoll> } | null = null;

/** Every live HIP-3 dex in a catalog, sorted — the poll's request set and its
 *  cache key. A string, so callers can key effects on it by value. */
export function hip3DexKey(markets: readonly Market[]): string {
  return [...new Set(markets.filter((m) => m.kind === 'hip3').map((m) => m.dex!))].sort().join(',');
}

export function loadMarketStats(dexKey: string): Promise<StatsPoll> {
  // fetchAll derives its request set from the HIP-3 dex list — key on it so a
  // catalog with new coverage is a cache miss, not a stale hit.
  if (cache && cache.key === dexKey && Date.now() - cache.at < TTL_MS) return cache.promise;
  const promise = fetchAll(dexKey ? dexKey.split(',') : []);
  cache = { at: Date.now(), key: dexKey, promise };
  promise.catch(() => {
    if (cache?.promise === promise) cache = null;
  });
  return promise;
}
