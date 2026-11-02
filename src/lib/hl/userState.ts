/**
 * Pure parsing + ordering logic for the watch feature (lib/watch.ts holds the
 * store/engine; this module is DOM-free so `npm test` can pin it).
 *
 * Payload shapes (docs/architecture.md → User state):
 * - WS clearinghouseState push: { dex, user, clearinghouseState:
 *   { assetPositions: [{ type, position: { coin, szi, entryPx,
 *   liquidationPx (string|null — null on cross positions with deep
 *   collateral), unrealizedPnl, positionValue, leverage: { value } } }] } }.
 *   All numerics are strings. HIP-3 coins arrive pre-prefixed ('xyz:TSLA').
 * - WS openOrders push: { dex, user, orders: [...] } in the FRONTEND order
 *   shape (isTrigger/triggerPx/reduceOnly present); spot orders ride the
 *   main-dex feed with coin in spotMeta's own pair-name form ('@699' or
 *   'PURR/USDC') — byte-identical to Market.coin, so cells match exactly.
 */

export interface WatchPosition {
  coin: string;
  /** signed size — positive long, negative short */
  szi: number;
  entryPx: number;
  liqPx: number | null;
  uPnl: number;
  /** return on equity, fractional (0.0241 = +2.41%) — HL's "PnL (ROE %)" */
  roe: number;
  /** |position| notional in USD — the Positions-wall sort key */
  value: number;
  leverage: number;
  marginUsed: number;
  /** cumFunding.sinceOpen: cumulative funding PAID since open (positive =
   *  paid out) — HL's Funding column shows it as the cash flow, i.e. −this */
  fundingSinceOpen: number;
}

export interface WatchOrder {
  coin: string;
  side: 'B' | 'A';
  /** the drawable level: triggerPx for trigger (TP/SL) orders, limitPx otherwise */
  px: number;
  sz: number;
  origSz: number;
  /** order placement time (ms) — HL's Open Orders sort key */
  t: number;
  /** HL's own order-type string verbatim ("Limit", "Stop Market", …) */
  type: string;
  isTrigger: boolean;
  reduceOnly: boolean;
  /** trigger condition text when present ("Price above 1.5"); '' otherwise */
  cond: string;
}

/** One spot holding from spotState/spotClearinghouseState. `coin` is the RAW
 *  token name (UBTC, PURR) — join to a market via Market.spotBase. */
export interface WatchBalance {
  coin: string;
  total: number;
  /** amount locked in resting orders — available = total − hold */
  hold: number;
  /** cost basis in USD (0 for USDC itself) — HL derives spot PnL from it */
  entryNtl: number;
}

export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Per-dex account totals from a clearinghouseState push's marginSummary. */
export interface WatchAccount {
  /** account value in USD (equity incl. unrealized PnL) */
  value: number;
  marginUsed: number;
  /** withdrawable USD (main clearinghouse carries the meaningful one) */
  withdrawable: number;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : NaN;
};

/** Parse one clearinghouseState push (defensively — a malformed payload must
 *  cost lines, never throw into the WS message loop). */
export function parsePositions(data: unknown): WatchPosition[] {
  const chs = (data as { clearinghouseState?: { assetPositions?: unknown[] } })?.clearinghouseState;
  if (!Array.isArray(chs?.assetPositions)) return [];
  const out: WatchPosition[] = [];
  for (const ap of chs.assetPositions) {
    const p = (ap as { position?: Record<string, unknown> })?.position;
    if (!p || typeof p.coin !== 'string') continue;
    const szi = num(p.szi);
    if (!szi) continue; // flat or malformed — nothing to draw
    const entryPx = num(p.entryPx);
    if (!(entryPx > 0)) continue;
    const liq = num(p.liquidationPx); // null → NaN → no liq line
    out.push({
      coin: p.coin,
      szi,
      entryPx,
      liqPx: liq > 0 ? liq : null,
      uPnl: num(p.unrealizedPnl) || 0,
      roe: num(p.returnOnEquity) || 0,
      value: Math.abs(num(p.positionValue)) || 0,
      leverage: num((p.leverage as { value?: unknown } | undefined)?.value) || 0,
      marginUsed: num(p.marginUsed) || 0,
      fundingSinceOpen: num((p.cumFunding as { sinceOpen?: unknown } | undefined)?.sinceOpen) || 0,
    });
  }
  return out;
}

/** Parse the account totals off a clearinghouseState push. */
export function parseAccount(data: unknown): WatchAccount {
  const chs = (data as {
    clearinghouseState?: { marginSummary?: Record<string, unknown>; withdrawable?: unknown };
  })?.clearinghouseState;
  const ms = chs?.marginSummary;
  const value = num(ms?.accountValue);
  const marginUsed = num(ms?.totalMarginUsed);
  const withdrawable = num(chs?.withdrawable);
  return {
    value: value > 0 ? value : 0,
    marginUsed: marginUsed > 0 ? marginUsed : 0,
    withdrawable: withdrawable > 0 ? withdrawable : 0,
  };
}

/** Parse one spotState push (or a REST spotClearinghouseState body). Zero
 *  totals are dropped — HL's Balances table hides emptied rows too. */
export function parseBalances(data: unknown): WatchBalance[] {
  const arr =
    (data as { spotState?: { balances?: unknown[] } })?.spotState?.balances ??
    (data as { balances?: unknown[] })?.balances;
  if (!Array.isArray(arr)) return [];
  const out: WatchBalance[] = [];
  for (const raw of arr) {
    const b = raw as Record<string, unknown>;
    if (typeof b?.coin !== 'string') continue;
    const total = num(b.total);
    if (!(total > 0)) continue;
    out.push({
      coin: b.coin,
      total,
      hold: num(b.hold) || 0,
      entryNtl: num(b.entryNtl) || 0,
    });
  }
  return out;
}

/** Parse one openOrders push. */
export function parseOrders(data: unknown): WatchOrder[] {
  const arr = (data as { orders?: unknown[] })?.orders;
  if (!Array.isArray(arr)) return [];
  const out: WatchOrder[] = [];
  for (const raw of arr) {
    const o = raw as Record<string, unknown>;
    if (typeof o?.coin !== 'string' || (o.side !== 'B' && o.side !== 'A')) continue;
    const isTrigger = o.isTrigger === true;
    const px = isTrigger ? num(o.triggerPx) : num(o.limitPx);
    if (!(px > 0)) continue;
    const cond = typeof o.triggerCondition === 'string' && o.triggerCondition !== 'N/A' ? o.triggerCondition : '';
    out.push({
      coin: o.coin,
      side: o.side,
      px,
      sz: num(o.sz) || 0,
      origSz: num(o.origSz) || num(o.sz) || 0,
      t: num(o.timestamp) || 0,
      type: typeof o.orderType === 'string' ? o.orderType : isTrigger ? 'Trigger' : 'Limit',
      isTrigger,
      reduceOnly: o.reduceOnly === true,
      cond,
    });
  }
  return out;
}

/** Decimal places of a parsed ledger value (its shortest round-trip form). */
export const dpOf = (v: number): number => String(v).split('.')[1]?.length ?? 0;

/**
 * total − hold at the inputs' own decimal precision. The raw float
 * difference prints IEEE-754 tails ("137206.19000000003" from the two
 * clean 2-dp ledger values); no surface ever shows meaningless decimals.
 */
export const availOf = (total: number, hold: number): string =>
  (total - hold).toFixed(Math.max(dpOf(total), dpOf(hold)));

/**
 * The Positions-wall order: positions by |notional| descending, then coins
 * with only resting orders by order count.
 */
export function positionsWallCoins(
  pos: WatchPosition[],
  ord: Map<string, WatchOrder[]>,
): string[] {
  const ranked = [...pos].sort((a, b) => b.value - a.value).map((p) => p.coin);
  const seen = new Set(ranked);
  const orderOnly = [...ord.entries()]
    .filter(([coin, list]) => !seen.has(coin) && list.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([coin]) => coin);
  return [...ranked, ...orderOnly];
}

// ── chart overlay levels + which of them get an axis label ─────────────────
//
// One line per DISTINCT level (many orders at one price draw one line, so a
// market-maker's book stays legible) but an axis LABEL only where a monitor
// needs a number: with a wallet that rests ~18 orders on a coin, one label
// per line would turn the price axis into a solid stacked column that hides
// every tick number and sits nowhere near its line. lightweight-charts
// already spreads overlapping labels 16px apart (priceScale.alignLabels) —
// so the answer is fewer labels, not pixel math: every entry and
// liquidation; trigger (TP/SL) levels up to a budget, else the nearest to
// the last price; and per side of the limit ladder either every level (a
// small DCA ladder stays fully labeled) or its two edges — the NEXT order
// to fill (highest buy / lowest sell: a resting bid sits below the market
// by construction, so no price is needed) and the far end. Everything else
// keeps its line, is read by the crosshair, and is listed exactly in the
// Positions view.

export interface OverlayLevel {
  kind: 'entry' | 'liq' | 'order';
  /** entry: 'B' long / 'A' short; order: HL's side; liq: null */
  side: 'B' | 'A' | null;
  price: number;
  trigger: boolean;
  /** draw this level's axis label */
  label: boolean;
}

export interface OverlayLabelBudget {
  /** trigger levels labeled outright; above it, the nearest to the anchor */
  triggerMax: number;
  /** limit levels per side labeled outright; above it, the two edges */
  limitAllMax: number;
  /** hard cap per cell: order labels farthest from the anchor go first,
   *  position labels never (≥3 positioned wallets on one phone coin may
   *  then show no order label at all — accepted) */
  total: number;
}

export const OVERLAY_BUDGET_FINE: OverlayLabelBudget = { triggerMax: 4, limitAllMax: 4, total: 10 };
/** Phone cells are short: ≤6 labels ≈ 96px keeps the stack under half the pane. */
export const OVERLAY_BUDGET_COARSE: OverlayLabelBudget = { triggerMax: 2, limitAllMax: 2, total: 6 };

/**
 * Levels in a STABLE order (positions first, then orders as given) so the
 * caller's dependency key is byte-identical across unchanged pushes.
 * `lastPx` is a thunk read AT MOST ONCE per call and only off the common
 * path (trigger levels over budget, or the total cap hit); the anchor falls
 * back to the first entry price, then to raw price order — never a throw.
 */
export function overlayLevels(
  positions: WatchPosition[],
  orders: WatchOrder[],
  lastPx: () => number | null,
  budget: OverlayLabelBudget = OVERLAY_BUDGET_FINE,
): OverlayLevel[] {
  const out: OverlayLevel[] = [];
  const seen = new Set<string>();
  const positionPx = new Set<number>();
  for (const p of positions) {
    const long = p.szi > 0;
    const ek = `e:${long ? 'l' : 's'}:${p.entryPx}`;
    if (!seen.has(ek)) {
      seen.add(ek);
      positionPx.add(p.entryPx);
      out.push({ kind: 'entry', side: long ? 'B' : 'A', price: p.entryPx, trigger: false, label: true });
    }
    if (p.liqPx != null) {
      const lk = `l:${p.liqPx}`;
      if (!seen.has(lk)) {
        seen.add(lk);
        positionPx.add(p.liqPx);
        out.push({ kind: 'liq', side: null, price: p.liqPx, trigger: false, label: true });
      }
    }
  }
  const orderLevels: OverlayLevel[] = [];
  for (const o of orders) {
    const k = `o:${o.side}:${o.px}:${o.isTrigger ? 1 : 0}`;
    if (seen.has(k)) continue;
    seen.add(k);
    orderLevels.push({ kind: 'order', side: o.side, price: o.px, trigger: o.isTrigger, label: false });
  }

  // The anchor every distance ranks against: the last close, else the
  // first entry, else raw price order ("nearest" = lowest). Memoized so the
  // chart is read at most once, and only when a ranking is actually needed.
  let anchor: number | null | undefined;
  const dist = (px: number): number => {
    if (anchor === undefined) anchor = lastPx() ?? positions[0]?.entryPx ?? null;
    return anchor == null ? px : Math.abs(px - anchor);
  };

  // triggers: all within budget, else the nearest to the anchor
  const triggers = orderLevels.filter((l) => l.trigger);
  if (triggers.length <= budget.triggerMax) {
    for (const l of triggers) l.label = true;
  } else {
    const ranked = [...triggers].sort((a, b) => dist(a.price) - dist(b.price) || a.price - b.price);
    for (const l of ranked.slice(0, budget.triggerMax)) l.label = true;
  }

  // limits: per side, every level within budget, else the two edges
  for (const side of ['B', 'A'] as const) {
    const ladder = orderLevels.filter((l) => !l.trigger && l.side === side);
    if (ladder.length === 0) continue;
    if (ladder.length <= budget.limitAllMax) {
      for (const l of ladder) l.label = true;
      continue;
    }
    let lo = ladder[0];
    let hi = ladder[0];
    for (const l of ladder) {
      if (l.price < lo.price) lo = l;
      if (l.price > hi.price) hi = l;
    }
    lo.label = true;
    hi.label = true;
  }

  // ONE label per PRICE: a position level, or an earlier order level (a
  // limit and a trigger on one side, a buy and a sell at one price — grid
  // and bracket setups), already names it; a second box with the same
  // number stacked under it is the pile-up this rule exists to remove
  const namedPx = new Set<number>(positionPx);
  for (const l of orderLevels) {
    if (!l.label) continue;
    if (namedPx.has(l.price)) l.label = false;
    else namedPx.add(l.price);
  }

  // the hard cap: shed order labels farthest from the anchor first (a
  // ladder's far ends before its next fills), position labels never
  const labeledOrders = orderLevels.filter((l) => l.label);
  const over = out.length + labeledOrders.length - budget.total;
  if (over > 0) {
    labeledOrders.sort((a, b) => dist(b.price) - dist(a.price) || b.price - a.price);
    for (const l of labeledOrders.slice(0, over)) l.label = false;
  }

  return out.concat(orderLevels);
}
