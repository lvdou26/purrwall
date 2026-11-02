import { hlSocket } from './hl/ws';
import {
  ADDR_RE,
  parseAccount,
  parseBalances,
  parseOrders,
  parsePositions,
  positionsWallCoins,
  type WatchAccount,
  type WatchBalance,
  type WatchOrder,
  type WatchPosition,
} from './hl/userState';

/**
 * Watch store: an ADDRESS BOOK (≤20 HL addresses, each with an optional
 * name) with TWO independent selections — the ACTIVE address (drives the
 * Positions page) and the per-entry `show` flags plus an `overlayOn` master
 * switch (drive the chart overlay: entry/liq/order lines + PnL chips can
 * show the UNION of any chosen wallets).
 * Read-only throughout: the HL user-state surface is unauthenticated.
 *
 * Data path: per subscribed address, WS clearinghouseState + openOrders per
 * dex ('' + live HIP-3 dexs via setWatchDexs) and spotState (balances,
 * active address only — the page is its only consumer). Snapshot on
 * subscribe, full re-push every ~5s: self-healing, no reconcile. Subscribed
 * set = {active} ∪ (overlayOn ? shown : ∅), diffed on every change.
 *
 * Sync: {addr, at, book:[{addr,name}]} as one LWW unit (merge in sync.ts).
 * `show`/`overlayOn` are PER-DEVICE viewing preferences (mobileCols
 * precedent) — persisted locally, never in the sync doc; applyWatchRemote
 * preserves local show flags by address.
 */

export { ADDR_RE, positionsWallCoins, type WatchBalance, type WatchOrder, type WatchPosition };

export interface WatchEntry {
  addr: string;
  /** user-given label, '' = unnamed; ≤32 chars */
  name: string;
  /** overlay this wallet on the charts (per-device, not synced) */
  show: boolean;
}

const STORAGE_KEY = 'purrwall.watch.v1';
export const WATCH_BOOK_CAP = 20;
export const WATCH_NAME_MAX = 32;

/** The sync unit — shape-compatible with sync.ts's SyncedWatch. */
export interface WatchStamp {
  addr: string | null;
  at: number;
  book: Array<{ addr: string; name: string }>;
}

let book: WatchEntry[] = [];
let addr: string | null = null; // ACTIVE address (the Positions page)
let addrAt = 0;
let overlayOn = true; // master switch for the chart overlay

// slice-then-trim so the result is IDEMPOTENT (trim-then-slice can end in
// whitespace, and a re-cleaned remote book must be byte-stable or the
// same-stamp compare in sync's dirty gate chases its own tail)
const cleanName = (n: unknown): string =>
  typeof n === 'string' ? n.trim().slice(0, WATCH_NAME_MAX).trim() : '';

function parseStored(raw: string | null): {
  a: string | null;
  at: number;
  b: WatchEntry[];
  ov: boolean;
} {
  const out = { a: null as string | null, at: 0, b: [] as WatchEntry[], ov: true };
  if (!raw) return out;
  const p = JSON.parse(raw) as { a?: unknown; at?: unknown; b?: unknown; ov?: unknown };
  if (typeof p.a === 'string' && ADDR_RE.test(p.a)) out.a = p.a.toLowerCase();
  if (typeof p.at === 'number' && Number.isFinite(p.at)) out.at = Math.max(0, p.at);
  if (p.ov === false) out.ov = false;
  const hadBook = Array.isArray(p.b);
  if (hadBook) {
    for (const e of p.b as Array<{ addr?: unknown; name?: unknown; show?: unknown }>) {
      if (typeof e?.addr === 'string' && ADDR_RE.test(e.addr) && out.b.length < WATCH_BOOK_CAP) {
        const a = e.addr.toLowerCase();
        if (!out.b.some((x) => x.addr === a)) {
          // entries without a `show` field predate per-entry overlay flags:
          // overlay only the active one, exactly what such a store drew
          out.b.push({ addr: a, name: cleanName(e.name), show: e.show === undefined ? a === out.a : e.show === true });
        }
      }
    }
  }
  // migration from the pre-book shape — and self-healing for any state where
  // the active address fell out of the book
  if (out.a && !out.b.some((x) => x.addr === out.a)) {
    out.b.unshift({ addr: out.a, name: '', show: true });
    // TRUE pre-book migration: back-date the synthesized unit by 1ms so it
    // LOSES sync ties against a device that actually built a book under the
    // same original stamp (unit LWW keeps local on ties).
    if (!hadBook) out.at = Math.max(0, out.at - 1);
  }
  return out;
}

(() => {
  try {
    const s = parseStored(localStorage.getItem(STORAGE_KEY));
    addr = s.a;
    addrAt = s.at;
    book = s.b;
    overlayOn = s.ov;
  } catch {
    /* unreadable storage — no watch */
  }
})();

// ── per-address data (flattened per push; coins are globally unique) ──
interface AddrData {
  positionsByDex: Map<string, WatchPosition[]>;
  ordersByDex: Map<string, WatchOrder[]>;
  accountByDex: Map<string, WatchAccount>;
  balances: WatchBalance[];
  positions: Map<string, WatchPosition>;
  orders: Map<string, WatchOrder[]>;
}
const emptyData = (): AddrData => ({
  positionsByDex: new Map(),
  ordersByDex: new Map(),
  accountByDex: new Map(),
  balances: [],
  positions: new Map(),
  orders: new Map(),
});
const dataByAddr = new Map<string, AddrData>();

let version = 0;
const listeners = new Set<() => void>();
function bump() {
  version++;
  for (const fn of listeners) fn();
}

export function subscribeWatch(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const getWatchVersion = () => version;
export const getWatchAddr = (): string | null => addr;
export const getWatchBook = (): WatchEntry[] => book;
export const getWatchStamp = (): WatchStamp => ({
  addr,
  at: addrAt,
  book: book.map((e) => ({ addr: e.addr, name: e.name })),
});
export const getOverlayOn = (): boolean => overlayOn;
/** Signature of the overlay toggles — a stable App-level snapshot that
 *  moves only on toggles, never on data pushes. */
export const getOverlayFp = (): string =>
  `${overlayOn ? 1 : 0}:${book.map((e) => (e.show ? 1 : 0)).join('')}`;

const activeData = (): AddrData => dataByAddr.get(addr ?? '') ?? EMPTY;
const EMPTY = emptyData();

// ── Positions-page getters (the ACTIVE address) ──
export const getWatchPosition = (coin: string): WatchPosition | undefined =>
  activeData().positions.get(coin);
export const getWatchOrders = (coin: string): WatchOrder[] => activeData().orders.get(coin) ?? [];
export const getWatchCounts = () => {
  const d = activeData();
  return {
    positions: d.positions.size,
    orders: [...d.orders.values()].reduce((a, o) => a + o.length, 0),
  };
};
export const getWatchPositions = (): WatchPosition[] => [...activeData().positions.values()];
export const getWatchOrderMap = (): Map<string, WatchOrder[]> => activeData().orders;
export const getWatchBalances = (): WatchBalance[] => activeData().balances;
export const getWatchAccount = () => {
  const d = activeData();
  let value = 0;
  let marginUsed = 0;
  for (const a of d.accountByDex.values()) {
    value += a.value;
    marginUsed += a.marginUsed;
  }
  let uPnl = 0;
  for (const p of d.positions.values()) uPnl += p.uPnl;
  return { value, marginUsed, uPnl, withdrawable: d.accountByDex.get('')?.withdrawable ?? 0 };
};

// ── chart-overlay getters (the UNION of shown wallets, master-gated) ──
const overlayAddrs = (): string[] =>
  overlayOn ? book.filter((e) => e.show).map((e) => e.addr) : [];
/** Every shown wallet's position on this coin (one entry per wallet). */
export const getOverlayPositions = (coin: string): Array<{ addr: string; pos: WatchPosition }> => {
  const out: Array<{ addr: string; pos: WatchPosition }> = [];
  for (const a of overlayAddrs()) {
    const p = dataByAddr.get(a)?.positions.get(coin);
    if (p) out.push({ addr: a, pos: p });
  }
  return out;
};
/** Every shown wallet's resting orders on this coin, merged. */
export const getOverlayOrders = (coin: string): WatchOrder[] => {
  const out: WatchOrder[] = [];
  for (const a of overlayAddrs()) {
    const list = dataByAddr.get(a)?.orders.get(coin);
    if (list) out.push(...list);
  }
  return out;
};

/** An entry's display label: its name, else a shortened address. */
export const watchLabel = (a: string | null = addr): string => {
  if (!a) return '';
  const e = book.find((x) => x.addr === a);
  return e?.name || `${a.slice(0, 6)}…${a.slice(-4)}`;
};

// ── subscription engine: {active} ∪ (overlayOn ? shown : ∅), diffed ──
let dexs: string[] = ['']; // main clearinghouse; App appends live HIP-3 dexs
const subsByAddr = new Map<string, Array<() => void>>();
// Per-(addr,channel,dex) signature of the last APPLIED push: the server
// re-pushes full state every ~5s whether or not anything changed — skip the
// no-op rebuilds.
const sigByKey = new Map<string, string>();

function flatten(a: string) {
  const d = dataByAddr.get(a);
  if (!d) return;
  const pos = new Map<string, WatchPosition>();
  for (const slice of d.positionsByDex.values()) for (const p of slice) pos.set(p.coin, p);
  const ord = new Map<string, WatchOrder[]>();
  for (const slice of d.ordersByDex.values()) {
    for (const o of slice) {
      const list = ord.get(o.coin);
      if (list) list.push(o);
      else ord.set(o.coin, [o]);
    }
  }
  d.positions = pos;
  d.orders = ord;
}

// Spot balances feed the Positions page only, so their subscription follows
// the ACTIVE address as its own one-slot unit — NOT part of subscribeAddr.
// (Rebuilding the outgoing and incoming wallets' whole sub sets on every
// active switch just to move this one feed would blink every overlay line
// off the wall with the empty-data frame.)
let spotUnsub: (() => void) | null = null;
let spotAddr: string | null = null;
function syncSpotSub() {
  if (spotAddr === addr) return;
  spotUnsub?.();
  spotUnsub = null;
  spotAddr = addr;
  if (!addr) return;
  const a = addr;
  spotUnsub = hlSocket.subscribeUserState('spotState', a, '', (data) => {
    const d = dataByAddr.get(a);
    if (!d) return;
    const parsed = parseBalances(data);
    const sig = JSON.stringify(parsed);
    if (sigByKey.get(`${a}:b`) === sig) return;
    sigByKey.set(`${a}:b`, sig);
    d.balances = parsed;
    bump();
  });
}

function subscribeAddr(a: string) {
  if (subsByAddr.has(a)) return;
  const unsubs: Array<() => void> = [];
  dataByAddr.set(a, emptyData());
  for (const dex of dexs) {
    unsubs.push(
      hlSocket.subscribeUserState('clearinghouseState', a, dex, (data) => {
        const d = dataByAddr.get(a);
        if (!d) return;
        const positions = parsePositions(data);
        const account = parseAccount(data);
        const sig = JSON.stringify([positions, account]);
        if (sigByKey.get(`${a}:p:${dex}`) === sig) return;
        sigByKey.set(`${a}:p:${dex}`, sig);
        d.positionsByDex.set(dex, positions);
        d.accountByDex.set(dex, account);
        flatten(a);
        bump();
      }),
    );
    unsubs.push(
      hlSocket.subscribeUserState('openOrders', a, dex, (data) => {
        const d = dataByAddr.get(a);
        if (!d) return;
        const orders = parseOrders(data);
        const sig = JSON.stringify(orders);
        if (sigByKey.get(`${a}:o:${dex}`) === sig) return;
        sigByKey.set(`${a}:o:${dex}`, sig);
        d.ordersByDex.set(dex, orders);
        flatten(a);
        bump();
      }),
    );
  }
  subsByAddr.set(a, unsubs);
}

function unsubscribeAddr(a: string) {
  const unsubs = subsByAddr.get(a);
  if (!unsubs) return;
  for (const u of unsubs) u();
  subsByAddr.delete(a);
  dataByAddr.delete(a);
  for (const k of [...sigByKey.keys()]) if (k.startsWith(`${a}:`)) sigByKey.delete(k);
}

/** Diff the subscribed set against what active+overlay currently want; a
 *  wallet that stays wanted keeps its subscriptions AND its data — nothing
 *  on screen blinks. The spot feed reconciles separately (syncSpotSub). */
function reconcileSubs() {
  const want = new Set<string>(overlayAddrs());
  if (addr) want.add(addr);
  for (const a of [...subsByAddr.keys()]) if (!want.has(a)) unsubscribeAddr(a);
  for (const a of want) subscribeAddr(a);
  syncSpotSub();
  bump();
}

/** Feed the live HIP-3 dex list once the catalog loads (positions on builder
 *  dexs are invisible to the main-clearinghouse subscription). */
export function setWatchDexs(hip3Dexs: string[]) {
  const next = ['', ...[...new Set(hip3Dexs)].filter(Boolean).sort()];
  if (next.join(',') === dexs.join(',')) return;
  dexs = next;
  // dex set changed — rebuild every subscription against the new fanout
  for (const a of [...subsByAddr.keys()]) unsubscribeAddr(a);
  reconcileSubs();
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ a: addr, at: addrAt, b: book, ov: overlayOn }),
    );
  } catch {
    /* non-fatal — the session still watches */
  }
}

/** Active-address change, stamped `at` for sync. Wallets that remain
 *  wanted (still shown, or the new active) keep their subscriptions and
 *  data across the switch — reconcileSubs drops only the genuinely
 *  unwanted and syncSpotSub moves the balances feed. */
function activate(next: string | null, at: number) {
  addrAt = at;
  if (next === addr) {
    persist();
    bump(); // book/overlay may have changed even when the active didn't
    return;
  }
  addr = next;
  persist();
  reconcileSubs();
}

/**
 * Add (or re-activate) an address, optionally naming it, and make it active.
 * A newly added wallet is shown on the charts by default.
 * Returns 'ok' | 'bad' (malformed address) | 'full' (book at cap).
 */
export function upsertWatch(raw: string, name?: string): 'ok' | 'bad' | 'full' {
  if (!ADDR_RE.test(raw)) return 'bad';
  const a = raw.toLowerCase();
  const existing = book.find((e) => e.addr === a);
  if (!existing) {
    if (book.length >= WATCH_BOOK_CAP) return 'full';
    book = [...book, { addr: a, name: cleanName(name), show: true }];
  } else if (name !== undefined) {
    book = book.map((e) => (e.addr === a ? { ...e, name: cleanName(name) } : e));
  }
  activate(a, Date.now());
  return 'ok';
}

/** Switch the active address (must be in the book), or null to deactivate
 *  (the entry stays in the book — removal is removeWatch). */
export function setActiveWatch(next: string | null) {
  if (next !== null && !book.some((e) => e.addr === next)) return;
  activate(next, Date.now());
}

/** Rename a book entry. */
export function renameWatch(a: string, name: string) {
  if (!book.some((e) => e.addr === a)) return;
  book = book.map((e) => (e.addr === a ? { ...e, name: cleanName(name) } : e));
  addrAt = Date.now();
  persist();
  bump();
}

/** Remove an entry; deactivates first if it was the active one. */
export function removeWatch(a: string) {
  if (!book.some((e) => e.addr === a)) return;
  book = book.filter((e) => e.addr !== a);
  activate(addr === a ? null : addr, Date.now());
  reconcileSubs(); // its overlay subscriptions drop too
}

/** Per-wallet chart-overlay flag (per-device; not synced, not stamped). */
export function setEntryShow(a: string, show: boolean) {
  if (!book.some((e) => e.addr === a)) return;
  book = book.map((e) => (e.addr === a ? { ...e, show } : e));
  persist();
  reconcileSubs();
}

/** The overlay master switch (per-device; not synced, not stamped). */
export function setOverlayOn(on: boolean) {
  if (on === overlayOn) return;
  overlayOn = on;
  persist();
  reconcileSubs();
}

/** Sync pulled a newer unit — adopt it wholesale (unit LWW; remote stamp).
 *  Local per-device overlay flags survive by address; remote-new entries
 *  arrive hidden (this device hasn't chosen to draw them). */
export function applyWatchRemote(remote: WatchStamp) {
  const showOf = new Map(book.map((e) => [e.addr, e.show]));
  const nextBook: WatchEntry[] = [];
  for (const e of remote.book) {
    if (ADDR_RE.test(e.addr) && nextBook.length < WATCH_BOOK_CAP) {
      const a = e.addr.toLowerCase();
      if (!nextBook.some((x) => x.addr === a)) {
        nextBook.push({ addr: a, name: cleanName(e.name), show: showOf.get(a) ?? false });
      }
    }
  }
  const nextActive = remote.addr && ADDR_RE.test(remote.addr) ? remote.addr.toLowerCase() : null;
  book = nextBook;
  if (nextActive && !book.some((e) => e.addr === nextActive) && book.length < WATCH_BOOK_CAP) {
    book = [...book, { addr: nextActive, name: '', show: showOf.get(nextActive) ?? true }];
  }
  activate(nextActive, remote.at);
  reconcileSubs();
}

// storage events fire only in OTHER tabs — the cross-tab half (alerts.ts /
// favorites.ts convention). Adopt the writing tab's state WITHOUT persisting
// (it already did).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    let s: ReturnType<typeof parseStored>;
    try {
      s = parseStored(e.newValue);
    } catch {
      return; // unreadable write — keep current state
    }
    book = s.b;
    overlayOn = s.ov;
    addrAt = Math.max(addrAt, s.at);
    addr = s.a;
    reconcileSubs();
  });
}

/** Boot: subscribe the stored selections (called from main.tsx module
 *  scope — runs once, immune to StrictMode double-fired effects). */
export function initWatch() {
  if (addr || overlayAddrs().length > 0) reconcileSubs();
}
