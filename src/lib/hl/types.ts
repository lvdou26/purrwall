/** A candle as returned by both REST candleSnapshot and the WS `candle` channel. */
export interface Candle {
  /** open time, epoch ms */
  t: number;
  /** close time, epoch ms */
  T: number;
  /** coin, e.g. "BTC", "@107", "xyz:TSLA", "#1730" */
  s: string;
  /** interval, e.g. "1m" */
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  /** base-unit volume */
  v: string;
  /** number of trades */
  n: number;
}

/** 'formula' = a client-composed cell (`=HYPE/ETH`, hl/formula.ts) — never
 *  in the catalog, resolved from its id by App.resolveMarket. */
export type MarketKind = 'perp' | 'spot' | 'hip3' | 'hip4' | 'formula';

/**
 * The id grammar of every live HL market — exactly four shapes: perp alnum
 * (`BTC`, `kPEPE`, `1000SHIB`), spot `@<idx>` or `PURR/USDC`, HIP-3
 * `<dex>:<TICKER>` (lowercase dex), HIP-4 `#<n>`. Anything else — a
 * hand-edited hash, a `=…` formula id synced from a newer build — cannot be
 * an HL id, and a candle subscription for such an id makes HL close the
 * shared socket (hl/ws.ts). Returns the kind the syntax implies, or null.
 * scripts/api-canary.mjs checks every id in meta, spotMeta and each perpDexs
 * meta against this grammar on every run and alerts on a shape it does not
 * cover.
 */
export function coinKindOf(coin: string): MarketKind | null {
  if (/^#\d+$/.test(coin)) return 'hip4';
  if (/^@\d+$/.test(coin) || /^[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(coin)) return 'spot';
  if (/^[a-z0-9]+:[A-Za-z0-9]+$/.test(coin)) return 'hip3';
  if (/^[A-Za-z0-9]+$/.test(coin)) return 'perp';
  return null;
}

export interface Market {
  /** API coin identifier — what candleSnapshot / WS subscriptions expect */
  coin: string;
  /** Human-readable name shown in the UI, Hyperliquid-style (BTC-USDC, HYPE/USDC) */
  display: string;
  kind: MarketKind;
  /** HIP-3 builder dex name, when kind === 'hip3' — shown as a pill like HL does */
  dex?: string;
  /** Extra context (HIP-4 outcome resolution text) */
  description?: string;
  /** Max leverage for perp-like markets — shown as the "40x" pill */
  maxLeverage?: number;
  /** Pre-launch market (isolated-only perp for a pre-TGE token) */
  preLaunch?: boolean;
  /** HIP-3 asset class from the perpCategories API: stocks/indices/commodities/fx/preipo/crypto */
  category?: string;
  /** Search aliases from perpConciseAnnotations (e.g. "claude" → vntl:ANTHROPIC) */
  keywords?: string[];
  /** Spot only: the base token's RAW API name (UBTC, not the BTC display) —
   *  what spotClearinghouseState/spotState balances key on. Lets the
   *  Positions view price a balance via this pair's market stats. */
  spotBase?: string;
  /** Spot only: the BASE token's tokenId ('0x' + 32 hex) — the key of HL's
   *  Strict allowlist (its selector's `spotId`; hl/spotSelector.json). */
  spotTokenId?: string;
  /** Formula cells only: the distinct leg coin ids the expression reads, in
   *  first-appearance order (≤ MAX_LEGS). */
  legs?: string[];
}

/*
 * The chart horizons. Hyperliquid's API offers 14 (1m 3m 5m 15m 30m 1h 2h 4h
 * 8h 12h 1d 3d 1w 1M) — these six-plus-one are the ones worth a chip.
 *
 * `1M` IS DELIBERATELY ABSENT and should stay that way. HL buckets every
 * interval as `floor(t / duration)` from the Unix epoch, which is invisible
 * on intervals that divide a day and very visible on the ones that don't:
 * its `1M` is a fixed 30-DAY bucket, not a calendar month, drifting ~5.2 days
 * a year — across BTC's whole `1M` history the starts land on all 31 days of
 * the month. Worse, HL's own chart does not use it either: its TradingView
 * datafeed sets `has_weekly_and_monthly: false`, so the library builds
 * calendar W/M client-side from 1d bars and never requests `1M`. Shipping it
 * would disagree with app.hyperliquid.xyz's own chart and with every other
 * chart, which is the definition of data that reads as untrustworthy.
 *
 * `1w` inherits the same epoch-modulo rule — every bar opens THURSDAY 00:00
 * UTC, because 1970-01-01 was a Thursday — but a 7-day bucket is exact and
 * drift-free, so nothing on screen is ever wrong, only anchored a few days
 * off a Monday-anchored week elsewhere. That is one line in the docs modal,
 * not a reason to withhold years of weekly context. REST and the WS candle
 * channel both serve `1w` on perp, spot, HIP-3 and HIP-4, at the same push
 * cadence as 1m.
 */
export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
export type Interval = (typeof INTERVALS)[number];

/**
 * Exact bucket lengths. Every value here is a true fixed width, which is what
 * lets ChartCell and candleCache do plain division on it (backfill windows,
 * heal-gap counts, pagination chunks, staleness). A calendar-month interval
 * would make this a lie at eight call sites — another reason `1M` is out.
 */
export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

export const KIND_LABEL: Record<MarketKind, string> = {
  perp: 'Perp',
  spot: 'Spot',
  hip3: 'HIP-3',
  hip4: 'HIP-4',
  // a language-neutral glyph, like the '⊞ 9' grid button
  formula: 'ƒx',
};
