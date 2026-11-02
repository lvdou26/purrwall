import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Interval, Market } from './lib/hl/types';
import { INTERVALS, coinKindOf } from './lib/hl/types';
import { loadMarkets, loadOutcomes, mergeCatalog, sameMarket, type MarketCatalog } from './lib/hl/markets';
import { hip3DexKey, loadMarketStats, type MarketStats } from './lib/hl/stats';
import { createCatalogRefresher, type CatalogRefresher } from './lib/hl/catalogSync';
import { hlSocket } from './lib/hl/ws';
import { buildNameIndex, compactText, compile, isFormulaId, parseCanonical } from './lib/hl/formula';
import { composeStats } from './lib/hl/compose';
import {
  MAX_CELLS,
  MAX_COLS,
  MAX_ROWS,
  clampCols,
  decodeLayoutHash,
  defaultColsFor,
  encodeLayoutHash,
} from './lib/shareUrl';
import { LANG_KEY, LangContext, dict, initialLang, type Lang, type StrKey } from './lib/i18n';
import { resizeGrid } from './lib/gridResize';
import {
  createSync,
  getSyncCode,
  getSyncHealth,
  joinSync,
  mergeWalls,
  reconcile,
  storeSyncCode,
  subscribeSyncHealth,
  SYNC_MAX_WALLS,
  type SyncedWall,
  type SyncedWatch,
} from './lib/sync';
import {
  applyWatchRemote,
  getOverlayFp,
  getOverlayOn,
  getWatchAddr,
  getWatchBook,
  getWatchCounts,
  getWatchOrderMap,
  getWatchPositions,
  getWatchStamp,
  positionsWallCoins,
  setActiveWatch,
  setEntryShow,
  setOverlayOn,
  setWatchDexs,
  subscribeWatch,
  upsertWatch,
  watchLabel,
} from './lib/watch';
import { WatchAccountPanel } from './components/WatchOverlay';
import { PositionsView } from './components/PositionsView';
import { clearRangeWindow, setCrosshairSyncEnabled } from './lib/crosshairSync';
import { useMediaQuery, IS_COARSE } from './lib/media';
import { isNewVersionLive, useUpdateCheck } from './lib/updateCheck';
import { fmtAlertPrice } from './lib/alerts';
import { onAlertFire, startAlertEngine } from './lib/alertEngine';
import { usePullToRefresh } from './lib/pullToRefresh';
import { emitManualRefresh } from './lib/refreshBus';
import { CHANGELOG, hasUnseen, markSeen } from './changelog';
import { usePopoverDismiss } from './lib/usePopoverDismiss';
import { useModalFocus } from './lib/useModalFocus';
import { ChartCell } from './components/ChartCell';
import { CellErrorBoundary } from './components/CellErrorBoundary';
import { Clock } from './components/Clock';
import { DocsModal } from './components/DocsModal';
import { FeedbackModal } from './components/FeedbackModal';
import { ListView } from './components/ListView';
import { MarketPicker } from './components/MarketPicker';
import './App.css';

// First-visit showcase: crypto majors + HL native + 24/7 stocks/index/commodities
// in one glance. Deliberately no HIP-4 (those markets expire and settle).
// Ordered so BREADTH shows first: a phone's 2-col first screen (top 4
// cells) reveals crypto + a stock + gold — the differentiator — instead of
// four crypto majors; desktop's 3×3 rows read the same interleave.
const DEFAULT_COINS = [
  'BTC',
  'ETH',
  'xyz:TSLA',
  'xyz:GOLD',
  'SOL',
  'xyz:NVDA',
  'HYPE',
  'xyz:XYZ100',
  'xyz:CL',
];

/**
 * Curated one-click walls. Coins referencing delisted markets degrade
 * gracefully to empty cells (resolveMarket handles it).
 */
const WALL_PRESETS: Array<{ key: string; labelKey: StrKey; coins: string[] }> = [
  // the first-visit wall, reachable again after any edits
  { key: 'default', labelKey: 'preset_default', coins: DEFAULT_COINS },
  { key: 'majors', labelKey: 'preset_majors', coins: ['BTC', 'ETH', 'SOL', 'HYPE'] },
  {
    key: 'tradfi',
    labelKey: 'preset_tradfi',
    coins: [
      'xyz:TSLA',
      'xyz:NVDA',
      'xyz:AAPL',
      'xyz:AMZN',
      'xyz:XYZ100',
      'xyz:GOLD',
      'xyz:CL',
      'xyz:EUR',
      'xyz:COPPER',
    ],
  },
  {
    key: 'meme',
    labelKey: 'preset_meme',
    coins: ['DOGE', 'kPEPE', 'WIF', 'FARTCOIN', 'TRUMP', 'PURR/USDC'],
  },
  // 'top-volume' is dynamic — built from live stats in applyPreset
];
const STORAGE_KEY = 'purrwall.layout.v1';
const CROSSHAIR_KEY = 'purrwall.crosshair.v1';
const MOBILE_COLS_KEY = 'purrwall.mobileCols';
// Phone wall-size quick picks: the desktop shape matrix is misleading on
// phones — only COUNT is real there; cols is a desktop-only view
// preference. All ≤ MAX_CELLS; other counts still arise via list
// add-to-wall and render fine — chips are the fast lane.
const MOBILE_COUNTS = [4, 6, 9, 12, 16, 24] as const;
// Narrow-wall breakpoint: below this, the grid scrolls instead of compressing.
const MOBILE_MQ = '(max-width: 640px)';
// Condensed-topbar breakpoint: below this the wide-bar controls (⌖, walls,
// tz, lang) no longer fit in one row — they fold
// into the "⋯" overflow menu (same menu the narrow/two-row layout uses) so
// the row never wraps/clips. Independent of MOBILE_MQ: the two-row wrap and
// grid/sheet/target behavior stay keyed to MOBILE_MQ; only the topbar
// CONTROL FOLD widens its threshold. 1330 makes room for the wall/list view
// toggle in row 1: at narrower widths the full row, the toggle's ~120px
// included, would push the TradingView attribution into a wrap, and that
// link must stay visible (a license requirement, Invariant 8).
const CONDENSED_MQ = '(max-width: 1330px)';
// Second fold tier, INSIDE the condensed one. The condensed row is
// flex-nowrap and the page is overflow-x:hidden, so once its natural width
// exceeds the viewport the overflow is not scrollable — it is simply gone,
// and what sits at the right edge is the TradingView attribution
// (Invariant 8, a license term, and the reason every wall cell runs
// attributionLogo false). Left in the row, the docs+feedback text buttons
// (with the full attribution block and the wider gap) push its natural
// width far past a 641px viewport, and the link ends up off the right edge
// — silently, with no console noise. Folding those two into "⋯" here (the
// same treatment they already
// get ≤640px) plus the tighter gap in App.css brings the natural width
// under 641. Before adding a topbar control, re-measure .topbar
// scrollWidth at 641px in English (the binding case).
const TIGHT_MQ = '(max-width: 900px)';

interface CellState {
  coin: string | null;
  interval: Interval;
}

interface Layout {
  count: number;
  cols: number;
  cells: CellState[];
  /** Which named wall this is: a preset key, 'saved:Name', or null once the
   *  COMPOSITION diverges (coins/grid — interval tweaks don't count). */
  name?: string | null;
}

/** Per-cell shape guard: a persisted/tampered coin that isn't a string (or a
 *  bad interval) must never reach chart code — resolveMarket→fallbackMarket
 *  does coin.startsWith(), which would throw ABOVE the cell error boundary and
 *  white-screen the app. Every cells[] read path runs through this. */
function sanitizeCells(raw: unknown, count: number): CellState[] {
  const arr = Array.isArray(raw) ? (raw as Array<Partial<CellState>>) : [];
  return Array.from({ length: Math.max(MAX_CELLS, count) }, (_, i): CellState => {
    const c = arr[i];
    return {
      coin: typeof c?.coin === 'string' ? c.coin : null,
      interval: (INTERVALS as readonly string[]).includes(c?.interval ?? '')
        ? (c!.interval as Interval)
        : ('1h' as Interval),
    };
  }).slice(0, MAX_CELLS);
}

function defaultLayout(): Layout {
  return {
    count: 9,
    cols: 3,
    name: 'default',
    cells: Array.from({ length: MAX_CELLS }, (_, i) => ({
      coin: DEFAULT_COINS[i] ?? null,
      interval: '1h' as Interval,
    })),
  };
}

/** Has this browser ever kept a wall? (Blocked storage reads as "no" — there
 *  is nothing to protect there either.) */
function hasPersistedLayout(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultLayout();
    const parsed = JSON.parse(raw) as Partial<Layout>;
    if (typeof parsed.count !== 'number' || !Array.isArray(parsed.cells)) return defaultLayout();
    const count = Math.min(Math.max(Math.round(parsed.count), 1), MAX_CELLS);
    const cells = sanitizeCells(parsed.cells, count);
    // pre-cols layouts derive a square-ish column count
    return {
      count,
      cols: clampCols(parsed.cols ?? NaN, count),
      cells,
      name: typeof parsed.name === 'string' ? parsed.name : null,
    };
  } catch {
    return defaultLayout();
  }
}

/** Curated timezone list, TradingView-style; labels get live UTC offsets. */
const TIMEZONES: Array<{ id: string; city: string }> = [
  { id: 'Pacific/Honolulu', city: 'Honolulu' },
  { id: 'America/Anchorage', city: 'Anchorage' },
  { id: 'America/Los_Angeles', city: 'Los Angeles' },
  { id: 'America/Denver', city: 'Denver' },
  { id: 'America/Chicago', city: 'Chicago' },
  { id: 'America/New_York', city: 'New York' },
  { id: 'America/Sao_Paulo', city: 'São Paulo' },
  { id: 'Europe/London', city: 'London' },
  { id: 'Europe/Paris', city: 'Paris' },
  { id: 'Europe/Moscow', city: 'Moscow' },
  { id: 'Asia/Dubai', city: 'Dubai' },
  { id: 'Asia/Karachi', city: 'Karachi' },
  { id: 'Asia/Kolkata', city: 'Mumbai' },
  { id: 'Asia/Bangkok', city: 'Bangkok' },
  { id: 'Asia/Singapore', city: 'Singapore' },
  { id: 'Asia/Hong_Kong', city: 'Hong Kong' },
  { id: 'Asia/Shanghai', city: 'Shanghai' },
  { id: 'Asia/Taipei', city: 'Taipei' },
  { id: 'Asia/Tokyo', city: 'Tokyo' },
  { id: 'Asia/Seoul', city: 'Seoul' },
  { id: 'Australia/Sydney', city: 'Sydney' },
  { id: 'Pacific/Auckland', city: 'Auckland' },
];

/** Current UTC offset of an IANA zone (or 'local'/'utc'), in seconds. */
function tzToOffsetSec(tz: string): number {
  if (tz === 'local') return -new Date().getTimezoneOffset() * 60;
  if (tz === 'utc') return 0;
  try {
    const now = new Date();
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    // formatToParts is second-granular while now has ms — snap to whole minutes
    return Math.round((asUtc - now.getTime()) / 60_000) * 60;
  } catch {
    return 0;
  }
}

/** "UTC+8", "UTC-4", "UTC+5:30" — for the dropdown labels. */
function utcLabel(offsetSec: number): string {
  const sign = offsetSec < 0 ? '-' : '+';
  const totalMin = Math.round(Math.abs(offsetSec) / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/**
 * A saved coin whose metadata category failed to load can still chart —
 * candleSnapshot and WS only need the coin id. Kind is inferred from the
 * coin's syntax so the badge stays roughly right. A string that cannot be
 * an HL id at all (a hand-edited hash, a `=…` formula id from a newer
 * build) gets null instead: subscribing it would cost the whole wall its
 * socket (hl/ws.ts), and a cell that says "select market" is the honest
 * outcome for an id HL has never heard of.
 */
function fallbackMarket(coin: string): Market | null {
  const kind = coinKindOf(coin);
  return kind ? { coin, display: coin, kind } : null;
}

/** A layout arriving via a shared URL, padded to the full cell array. */
function layoutFromHash(hash: string): Layout | null {
  const shared = decodeLayoutHash(hash);
  if (!shared) return null;
  return {
    count: shared.count,
    cols: shared.cols,
    cells: shared.cells,
    // a v3 hash carries the sender's wall name — while the wall is viewed as a
    // SHARE (a device that already has its own wall) it shows and pre-fills
    // save-as (wallLabel renders 'saved:X' names without requiring the wall
    // to exist locally). On a first-ever boot the wall is adopted outright
    // and the [savedWalls, layout.name] detach effect drops the foreign name
    // in the first commit — no such saved view exists here.
    name: shared.name ? `saved:${shared.name}` : null,
  };
}

/** Same wall content (grid + coins + intervals) — names don't count. */
function sameWall(a: Layout, b: Layout): boolean {
  if (a.count !== b.count || a.cols !== b.cols) return false;
  for (let i = 0; i < a.count; i++) {
    if ((a.cells[i]?.coin ?? null) !== (b.cells[i]?.coin ?? null)) return false;
    if (a.cells[i]?.interval !== b.cells[i]?.interval) return false;
  }
  return true;
}

/** A full wall from an ordered coin list, padded to the cell array. */
function wallOf(coins: string[], keepInterval: Interval, name: string | null = null): Layout {
  const cells = Array.from(
    { length: MAX_CELLS },
    (_, i): CellState => ({ coin: coins[i] ?? null, interval: keepInterval }),
  );
  return { count: coins.length, cols: defaultColsFor(coins.length), cells, name };
}

/** The legacy #wc link: a 2026 World Cup wall. The tournament is over and
 *  the walls menu does not offer it; the route stays only so an old #wc
 *  link still lands somewhere sensible — it resolves whatever World Cup
 *  markets exist, and with none it degrades to the visitor's own wall. */
const WC_HASH = /^#(wc|worldcup)$/i;

/**
 * The live World Cup wall: every open knockout match (favorite side, in
 * kickoff order) plus the top title contenders by % chance. Resolved at
 * open time — settled HIP-4 markets vanish from the API entirely, so a
 * static coin list would rot within days.
 */
function worldCupCoins(catalog: MarketCatalog, stats: Map<string, MarketStats>): string[] {
  // Scope by question NAME, not just category — HL may list other sports
  // (tennis, NBA…) mid-tournament and those must not pollute this wall.
  const sports = catalog.outcomeQuestions.filter(
    (q) => q.category === 'sports' && /world cup/i.test(q.name),
  );
  const price = (coin: string) => stats.get(coin)?.last ?? 0;
  const descByCoin = new Map(
    catalog.markets.filter((m) => m.kind === 'hip4').map((m) => [m.coin, m.description ?? '']),
  );
  // Kickoff dates exist only as free text ("… scheduled for July 4, 2026 …");
  // unparseable ones sort last instead of breaking.
  const kickoff = (coin: string): number => {
    const m = descByCoin.get(coin)?.match(/scheduled for (\w+ \d{1,2}, \d{4})/);
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };
  // Match markets: a single outcome with two team-named (non Yes/No) sides.
  const matches = sports
    .filter(
      (q) =>
        q.outcomes.length === 1 &&
        q.outcomes[0].sides.length === 2 &&
        q.outcomes[0].sides[0].name !== 'Yes',
    )
    .map((q) => {
      const [a, b] = q.outcomes[0].sides;
      const fav = price(b.coin) > price(a.coin) ? b : a; // chart the favorite
      return { coin: fav.coin, at: kickoff(fav.coin) };
    })
    .sort((x, y) => x.at - y.at)
    .map((m) => m.coin);
  // Title futures (Yes/No outcomes, e.g. "2026 World Cup Champion"),
  // strongest contenders first.
  const contenders = sports
    .flatMap((q) => q.outcomes)
    .filter((o) => o.sides[0]?.name === 'Yes')
    .sort((x, y) => price(y.yesCoin) - price(x.yesCoin))
    .map((o) => o.yesCoin);
  // Matches cap at 12 so a fully pre-listed round can't crowd out every
  // title-contender cell; the wall itself caps at a 4×4.
  return [...matches.slice(0, 12), ...contenders].slice(0, 16);
}

/** Named walls the user saved locally. */
interface SavedWall {
  name: string;
  count: number;
  cols?: number;
  cells: CellState[];
  /** last content change — the sync merge tiebreaker */
  updatedAt?: number;
  /** tombstone: deletions must out-merge stale copies on other devices */
  deletedAt?: number;
}

const WORKSPACES_KEY = 'purrwall.workspaces.v1';
// One anonymous draft slot: the UNNAMED wall you last switched away from
// (a scratch/preset-derived wall with no home). Named views keep their own
// per-view working copies instead (VIEW_DRAFTS_KEY).
const DRAFT_KEY = 'purrwall.draft.v1';
// Per-view unsaved working copies, keyed by view name: editing a saved view
// and switching away preserves its experiment HERE (not a separate menu
// entry) — switch back and it's exactly where you left it, dirty, re-saveable.
const VIEW_DRAFTS_KEY = 'purrwall.viewDrafts.v1';

// One-time cleanup: unsaved drafts written under an earlier draft model are
// wiped once per browser, so nobody carries over a stale or confusing draft.
// Saved views and the current wall are untouched. Runs at module load,
// before the state initializers read them.
const DRAFT_MIGRATION_KEY = 'purrwall.draftsReset.v1';
try {
  if (!localStorage.getItem(DRAFT_MIGRATION_KEY)) {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(VIEW_DRAFTS_KEY);
    localStorage.setItem(DRAFT_MIGRATION_KEY, '1');
  }
} catch {
  /* storage blocked — nothing to migrate */
}
// A key an earlier version wrote and nothing reads any more.
try {
  localStorage.removeItem('purrwall.device.v1');
} catch {
  /* storage blocked */
}

type DraftWall = Pick<Layout, 'count' | 'cols' | 'cells'>;

function parseDraftWall(p: Partial<Layout> | undefined): DraftWall | null {
  if (!p || typeof p.count !== 'number' || !Array.isArray(p.cells)) return null;
  const count = Math.min(Math.max(Math.round(p.count), 1), MAX_CELLS);
  return { count, cols: clampCols(p.cols ?? NaN, count), cells: sanitizeCells(p.cells, count) };
}

function loadDraft(): DraftWall | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? parseDraftWall(JSON.parse(raw) as Partial<Layout>) : null;
  } catch {
    return null;
  }
}

function loadViewDrafts(): Record<string, DraftWall> {
  try {
    const raw = localStorage.getItem(VIEW_DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Partial<Layout>>) : {};
    const out: Record<string, DraftWall> = {};
    for (const [name, v] of Object.entries(parsed ?? {})) {
      const d = parseDraftWall(v);
      if (d) out[name] = d;
    }
    return out;
  } catch {
    return {};
  }
}

function loadSavedWalls(): SavedWall[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (w): w is SavedWall =>
          typeof (w as SavedWall)?.name === 'string' &&
          typeof (w as SavedWall)?.count === 'number' &&
          Array.isArray((w as SavedWall)?.cells),
      )
      // guard cell shapes on the way in (tombstones keep their empty cells)
      .map((w) => (w.deletedAt ? w : { ...w, cells: sanitizeCells(w.cells, w.count).slice(0, w.count) }));
  } catch {
    return [];
  }
}

export default function App() {
  const [catalog, setCatalog] = useState<MarketCatalog | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketRetry, setMarketRetry] = useState(0);
  // Shared WS connection health, surfaced as the status dot / topbar text /
  // per-cell stale dim. onStatus calls back immediately with the current
  // status, so this is never falsely 'live' on mount.
  const [wsStatus, setWsStatus] = useState<'live' | 'reconnecting'>('live');
  useEffect(() => hlSocket.onStatus(setWsStatus), []);
  // App-like touch: the CSS kills selection, this kills the long-press
  // context menu (Android surfaces "Copy" through contextmenu even on
  // unselectable nodes near selectable ones). Reading surfaces keep theirs.
  useEffect(() => {
    if (!IS_COARSE) return;
    const onCtx = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.('input, textarea, .docs-body, .sync-code')) {
        e.preventDefault();
      }
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);
  const [layout, setLayout] = useState<Layout>(() => {
    const fromHash = layoutFromHash(window.location.hash);
    if (!fromHash) return loadLayout();
    // The address bar always carries the wall hash, so a plain reload
    // re-enters through here — preferring the persisted layout when the
    // content is identical keeps the wall's NAME across reloads (preset
    // names never travel in the hash). A hash that DOES carry a name is
    // the sender's explicit label — it wins even over identical content.
    const persisted = loadLayout();
    return !fromHash.name && sameWall(fromHash, persisted) ? persisted : fromHash;
  });
  // Device-local rendering preference for narrow screens (default 2,
  // user-choosable 1/2/3). NEVER stored in layout — layout.cols is wall state
  // and is encoded into the share URL.
  const [mobileCols, setMobileCols] = useState<1 | 2 | 3>(() => {
    try {
      const v = Number(localStorage.getItem(MOBILE_COLS_KEY));
      return v === 1 || v === 2 || v === 3 ? v : 2;
    } catch {
      return 2;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(MOBILE_COLS_KEY, String(mobileCols));
    } catch {
      /* non-fatal */
    }
  }, [mobileCols]);
  // While viewing someone's shared wall, nothing persists — the viewer's own
  // saved layout survives until their first edit adopts the shared one.
  // (A one-shot skip flag would break under StrictMode's double effects.)
  // A GENUINE shared arrival = hash content differs from what we already have
  // persisted. A plain reload re-enters with our OWN hash (== persisted,
  // including an unsaved working state) and must NOT read as shared — else
  // isDirty is gated false and the Save button vanishes after every reload.
  // A FIRST-EVER boot has no wall to protect: a share link opened on a fresh
  // device becomes that device's wall outright (persisted from the first
  // render, own hash in the bar) instead of a foreign view that never
  // persists — otherwise a newcomer arriving by link could never keep the
  // wall they opened.
  const viewingSharedRef = useRef(
    WC_HASH.test(window.location.hash) ||
      (() => {
        const h = layoutFromHash(window.location.hash);
        return h !== null && hasPersistedLayout() && !sameWall(h, loadLayout());
      })(),
  );
  // #wc arrivals wait here until the market catalog + stats are loaded.
  const [wcPending, setWcPending] = useState(() => WC_HASH.test(window.location.hash));
  // ── wall/list/positions view. Routing rules (Invariant 9; each guards a bug
  // this codebase has already fixed once — change them only deliberately):
  // 1. Boot precedence: ?mini=1 → wall (single-cell popouts must never open
  //    as a list); #wc / #w= → wall (a share link lands on what it points
  //    at); #list → list; #pos → positions; else wall.
  // 2. wall→list/positions is a pushState so the mobile back gesture peels
  //    card → list → wall (positions likewise); switching BETWEEN the pushed
  //    views (list ↔ positions) REPLACES the pushed entry so one back still
  //    returns to the wall; all other bar writes stay replaceState.
  // 3. While viewingSharedRef/wcModeRef is set the bar KEEPS that hash even
  //    in list view — it is the only copy of the wall being viewed; #list
  //    would destroy it on reload. Only own walls get #list written.
  // 4. A layout hash arriving via hashchange forces view back to 'wall';
  //    a hash identical to the current wall (our own entry re-fired by
  //    back/forward) only switches the view — never re-classifies as shared.
  //    Same for a hash that is merely OUR OWN, however stale: the Wall button
  //    pops the list entry with history.back(), and the entry underneath holds
  //    the wall as it was BEFORE the list visit. selfBackRef marks that
  //    traversal so an add-to-wall made from the list is not reverted and the
  //    wall is not flagged shared. Only hashes we did not write ourselves may
  //    be adopted.
  // 5. View switching never routes through editLayout (it would clear the
  //    shared/wc guards and adopt a wall the user was only glancing past).
  const [view, setView] = useState<'wall' | 'list' | 'positions'>(() => {
    if (new URLSearchParams(window.location.search).has('mini')) return 'wall';
    if (window.location.hash === '#pos') return 'positions';
    return window.location.hash === '#list' ? 'list' : 'wall';
  });
  // Whether the current list view sits on a history entry we pushed (toggle
  // navigation can then use history.back() and keep the stack honest).
  const pushedListRef = useRef(false);
  // While in #wc mode (arrived via the legacy #wc link, no edits yet) the
  // address bar keeps the LIVING #wc link instead of a frozen layout hash,
  // so recopying/resharing it never rots as matches settle.
  const wcModeRef = useRef(WC_HASH.test(window.location.hash));
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // UI language: auto-detected from the browser, toggleable, persisted
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = (k: StrKey) => dict[lang][k];
  const toggleLang = () => {
    const next: Lang = lang === 'en' ? 'zh' : 'en';
    setLang(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* non-fatal */
    }
  };
  // <html lang> follows the UI language: screen readers pick their voice and
  // browsers their CJK glyph set from it.
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);
  // rows×cols grid picker
  const [gridOpen, setGridOpen] = useState(false);
  /** ⌖ linked-crosshairs toggle; default on, remembered. */
  const [linkedCursor, setLinkedCursor] = useState(() => {
    try {
      return localStorage.getItem(CROSSHAIR_KEY) !== '0';
    } catch {
      return true;
    }
  });
  // (the enable/persist effect lives below expandedCell's declaration —
  // an expanded cell suspends the link, see the comment there)
  const [gridHover, setGridHover] = useState<{ r: number; c: number } | null>(null);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(gridOpen, gridWrapRef, () => {
    setGridOpen(false);
    setGridHover(null);
  });
  // Share popover (fine pointer only): QR of the current URL — the missing
  // desktop→phone hop. Touch keeps the native share sheet.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareQr, setShareQr] = useState<{ size: number; d: string } | null>(null);
  const shareWrapRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(shareOpen, shareWrapRef, () => setShareOpen(false));
  // Narrow-topbar "⋯" overflow menu (⌖, walls, tz, lang)
  const [moreOpen, setMoreOpen] = useState(false);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  // dialog focus management (a11y): trap + restore for the two App-owned modals
  const wallsMgrRef = useRef<HTMLDivElement | null>(null);
  const pkShellRef = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(moreOpen, moreWrapRef, () => setMoreOpen(false));
  // ⛶ expand (touch): the same cell node goes fullscreen via CSS — the chart
  // autoSizes to it; no remount, no re-backfill (epoch/context unchanged).
  const [expandedCell, setExpandedCell] = useState<number | null>(null);
  useEffect(() => {
    // Linked only while the WALL ITSELF is the visible surface. Two solo
    // focus views suspend the link, for the same reason: their resets/zooms
    // must not rewrite the wall (a viewport-wide chart broadcasts a
    // ~200-bar window that dense cells would adopt as slivers) —
    //  · the list's fullscreen card (the view gate), and
    //  · an EXPANDED wall cell (otherwise paused cells skip its live
    //    broadcasts but adopt the stale fullscreen window via reapplyRange
    //    on collapse — the same sliver bug the list gate prevents).
    //    Disabling also clears the module's rangeWindow/cursor, so collapse
    //    rejoins nothing stale.
    // Touch included — the wall IS the mobile focus: drag one small chart,
    // the wall pans together; hold for the wall-wide crosshair. Sourceship
    // on touch = last-touched cell (crosshairSync.setTouchSource), not
    // :hover.
    setCrosshairSyncEnabled(linkedCursor && view === 'wall' && expandedCell === null);
    try {
      localStorage.setItem(CROSSHAIR_KEY, linkedCursor ? '1' : '0');
    } catch {
      /* storage blocked — non-fatal */
    }
  }, [linkedCursor, view, expandedCell]);
  useEffect(() => {
    if (expandedCell === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedCell(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expandedCell]);
  useEffect(() => {
    if (expandedCell !== null && expandedCell >= layout.count) setExpandedCell(null);
  }, [expandedCell, layout.count]);
  // ‹ › fullscreen pager: paging just moves the .expanded class
  // to an adjacent NON-EMPTY cell — every wall cell stays mounted with a
  // warm WS sub, so a page turn repaints instantly and costs zero REST.
  // Wraps around, so a two-coin wall toggles A/B with a single control.
  const pageTargets = useMemo(
    () =>
      layout.cells
        .slice(0, layout.count)
        .map((c, i) => ({ coin: c.coin, i }))
        .filter((x): x is { coin: string; i: number } => x.coin !== null),
    [layout],
  );
  const pageExpanded = useCallback(
    (dir: 1 | -1) => {
      if (pageTargets.length < 2) return;
      setExpandedCell((cur) => {
        if (cur === null) return cur;
        const at = pageTargets.findIndex((p) => p.i === cur);
        if (at === -1) return pageTargets[0].i; // expanded cell emptied under us
        return pageTargets[(at + dir + pageTargets.length) % pageTargets.length].i;
      });
    },
    [pageTargets],
  );
  useEffect(() => {
    // view gate matters: a forward-nav can restore the LIST view while
    // expandedCell survives (popstate never clears it) — arrows must not
    // silently re-page the invisible wall there.
    if (expandedCell === null || view !== 'wall') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (pickerFor !== null || docsOpen) return; // modal layers own the keyboard
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
      e.preventDefault();
      pageExpanded(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expandedCell, view, pickerFor, docsOpen, pageExpanded]);
  /** Keeps the active chip in view when paging runs off the strip's edge. */
  const chipsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const strip = chipsRef.current;
    if (!strip) return;
    const act = strip.querySelector<HTMLElement>('.pager-chip.active');
    if (!act) return;
    // manual centering — scrollIntoView would also walk the .grid ancestor
    strip.scrollLeft = act.offsetLeft - (strip.clientWidth - act.offsetWidth) / 2;
  }, [expandedCell]);
  // Touch arrange mode: full-cell tap targets, tap two charts to swap.
  // Entered by long-pressing any header (ChartCell) or via the ⋯ menu;
  // HTML5 drag never fires on touch, so phones need an explicit mode.
  const [arrange, setArrange] = useState(false);
  const [arrangeFrom, setArrangeFrom] = useState<number | null>(null);
  const enterArrange = (from: number | null) => {
    setExpandedCell(null); // a fullscreen cell would hide the rest of the wall
    setArrange(true);
    setArrangeFrom(from);
  };
  const exitArrange = () => {
    setArrange(false);
    setArrangeFrom(null);
  };
  const onArrangeTap = (i: number) => {
    if (arrangeFrom === null) {
      setArrangeFrom(i);
    } else if (arrangeFrom === i) {
      setArrangeFrom(null);
    } else {
      swapCells(arrangeFrom, i);
      setArrangeFrom(null);
      navigator.vibrate?.(10);
    }
  };
  useEffect(() => {
    if (!arrange) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') exitArrange();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arrange]);
  // The topbar stays interactive during arrange — loading a smaller wall
  // must not leave arrangeFrom pointing at a no-longer-rendered slot (the
  // next tap would swap with an invisible null cell and blank a chart).
  useEffect(() => {
    if (arrangeFrom !== null && arrangeFrom >= layout.count) setArrangeFrom(null);
  }, [arrangeFrom, layout.count]);
  // First-visit hint: shown until dismissed or until the picker is first opened
  const [showHint, setShowHint] = useState<boolean>(() => {
    try {
      return !localStorage.getItem('purrwall.hint.v1');
    } catch {
      return false;
    }
  });
  const dismissHint = () => {
    setShowHint(false);
    try {
      localStorage.setItem('purrwall.hint.v1', '1');
    } catch {
      /* non-fatal */
    }
  };
  // What's-new: unseen drives the docs-button dot and the one-shot toast.
  // Only viewing the docs marks the release seen; dismissing the toast doesn't.
  const [wnUnseen, setWnUnseen] = useState<boolean>(() => hasUnseen());
  const [wnToastGone, setWnToastGone] = useState(false);
  const openDocs = () => {
    setDocsOpen(true);
    setWnUnseen(false);
    markSeen();
  };
  useEffect(() => {
    if (!wnUnseen || wnToastGone || showHint) return;
    const timer = setTimeout(() => setWnToastGone(true), 6000);
    return () => clearTimeout(timer);
  }, [wnUnseen, wnToastGone, showHint]);
  const [stats, setStats] = useState<Map<string, MarketStats> | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  // A corrupted/aborted native drag can swallow dragend, leaving the source
  // cell dimmed. During a REAL drag the browser sends dragover, never
  // mousemove — so a buttons-up mousemove means the session is over.
  useEffect(() => {
    if (dragFrom === null) return;
    const clear = () => {
      setDragFrom(null);
      setDropTarget(null);
    };
    const onMove = (e: MouseEvent) => {
      if (e.buttons === 0) clear();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
    };
  }, [dragFrom]);
  const [savedWalls, setSavedWalls] = useState<SavedWall[]>(loadSavedWalls);
  // Walls manager popover (rename/delete + sync): an in-app dialog, never
  // window.prompt.
  const [wallsMgr, setWallsMgr] = useState<'manage' | 'sync' | 'watch' | null>(null);
  useEffect(() => {
    if (!wallsMgr) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') setWallsMgr(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wallsMgr]);
  // ?mini=1 → chromeless popup mode for popped-out cells
  const isMini = useMemo(() => new URLSearchParams(window.location.search).has('mini'), []);
  // Price alerts: trigger engine + fired-toast stack (bottom-right corner).
  // Mini popouts never start the engine — they share localStorage with their
  // opener, and the main window firing once covers the device (engine header
  // has the full story). Toasts show the THRESHOLD the user set; the live
  // price at the moment of crossing is a detail the chart itself is showing.
  const [alertToasts, setAlertToasts] = useState<
    { key: number; label: string; dir: 'up' | 'down'; priceText: string }[]
  >([]);
  const alertToastSeq = useRef(0);
  useEffect(() => {
    if (isMini) return;
    startAlertEngine();
    return onAlertFire((f) => {
      const key = ++alertToastSeq.current;
      setAlertToasts((ts) => [
        // cap the stack at 4 — a choppy market must not wallpaper the corner
        ...ts.slice(-3),
        { key, label: f.alert.label, dir: f.dir, priceText: fmtAlertPrice(f.alert.price) },
      ]);
      window.setTimeout(() => setAlertToasts((ts) => ts.filter((x) => x.key !== key)), 8000);
    });
  }, [isMini]);
  // Mini popouts are 520px wide — they must never enter narrow-wall mode.
  const isNarrow = useMediaQuery(MOBILE_MQ) && !isMini;
  // Topbar CONTROL FOLD: the "⋯" overflow menu activates earlier than the
  // narrow-wall/two-row breakpoint so tablets and landscape phones (641–
  // 1330px, CONDENSED_MQ) keep a single un-clipped row with the TradingView
  // attribution visible (license requirement) — see Invariant 8.
  const isCondensed = useMediaQuery(CONDENSED_MQ) && !isMini;
  // Tightest condensed widths: docs + feedback fold into "⋯" so the row's
  // natural width stays inside the viewport and the attribution survives.
  // isNarrow (≤640) is a subset — those widths already folded them.
  const isTight = useMediaQuery(TIGHT_MQ) && !isMini;
  // Topbar clock width gates (English — the binding language — with the
  // widest tz labels):
  //  · condensed rows (≤1330) fit the clock WITH its zone suffix from ~1054px
  //    ("UTC+5:30", info column visible) — gate 1080 for font-fallback margin.
  //    The LIST view's row is lighter still at every width (no grid button,
  //    interval strip, ⌖, walls or tz selects), so list rows use this gate at
  //    ALL widths — the 1331-1419 hole below is a fact about the WALL row only
  //    (otherwise a 1366px laptop in list view loses its clock, and resizing
  //    across 1330→1420 makes it vanish and reappear).
  //  · full-control WALL rows (≥1331) are tuned to ZERO slack at 1331 (that
  //    is what CONDENSED_MQ is), and fit a suffix-LESS clock from ~1390px
  //    ("(UTC-7) Los Angeles" selected) — gate 1420. The suffix is dropped
  //    there because the tz dropdown sits on the same row and already names
  //    the zone. 1331–1419 is a real hole: nothing fits, hide rather than
  //    clip the TradingView attribution (Invariant 8) or truncate the time.
  //  · the transient ✓ save / ↻ update pills spend the SAME slack the gates
  //    budget for the clock, and the clock never yields to the ✓ pill: the
  //    row sheds DECORATION under .has-pill instead (see App.css: market
  //    count, data/charts label words, and the Hyperliquid half of the
  //    attribution — its ≤900px compact form), which fits the ✓ SAVE pill +
  //    clock at EVERY gated width — editing a wall never hides the clock. The
  //    wider ↻ UPDATE pill still collides: with both pills up the wall row
  //    fits the clock only from ~1168px condensed / ~1539px full, hence the
  //    clockRoomUpd* gates (1170 / 1560). Below them, while an update is
  //    pending, the clock steps out rather than clipping the TradingView link
  //    (Invariant 8) — one ↻ click and it is back. List rows are ~520px
  //    lighter and never collide. Known gap: both pills on a 1420–1470 full
  //    row overflow even with the clock gone.
  // Re-measure .topbar at 641px in English, and at the gate you touch,
  // before adding a topbar control.
  const clockRoomCondensed = useMediaQuery('(min-width: 1080px)');
  const clockRoomFull = useMediaQuery('(min-width: 1420px)');
  const clockRoomUpdCondensed = useMediaQuery('(min-width: 1170px)');
  const clockRoomUpdFull = useMediaQuery('(min-width: 1560px)');
  // Chart axis timezone: local wall-clock by default; any curated IANA zone
  // via the dropdown. Global, persisted, inherited by mini windows.
  // Deliberate limitation: the CURRENT offset of the zone is applied
  // uniformly, so history spanning a DST switch is off by 1h there.
  const [tz, setTz] = useState<string>(() => {
    try {
      return localStorage.getItem('purrwall.tz') ?? 'local';
    } catch {
      return 'local';
    }
  });
  // Re-sampled every minute: a DST flip while the wall runs overnight moves
  // the zone's offset, and the Intl-driven topbar clock follows it
  // automatically — the axis shift and the clock's zone suffix must converge
  // within a minute or the clock mislabels its own time ("01:30 UTC-4" for
  // an instant that is 01:30 UTC-5). Identical samples bail out of the
  // re-render, so this is free outside the two flips a year.
  // The limitation above is about HISTORY (one uniform offset over all
  // bars); this keeps "now" honest.
  const [tzOffsetSec, setTzOffsetSec] = useState(() => tzToOffsetSec(tz));
  useEffect(() => {
    setTzOffsetSec(tzToOffsetSec(tz));
    const id = setInterval(() => setTzOffsetSec(tzToOffsetSec(tz)), 60_000);
    return () => clearInterval(id);
  }, [tz]);
  const tzZones = useMemo(
    () =>
      TIMEZONES.map((z) => ({ ...z, off: tzToOffsetSec(z.id) })).sort((a, b) => a.off - b.off),
    [],
  );
  const changeTz = (next: string) => {
    setTz(next);
    try {
      localStorage.setItem('purrwall.tz', next);
    } catch {
      /* non-fatal */
    }
  };

  /** One click retimes the whole wall; per-cell selectors remain for exceptions. */
  const setAllIntervals = (interval: Interval) => {
    // the wall's linked window is a TIME span from the old timeframe —
    // stale after a retime, and heals would re-pin cells to it
    clearRangeWindow();
    editLayout((prev) => ({
      ...prev,
      cells: prev.cells.map((c) => ({ ...c, interval })),
    }));
  };
  const visibleCells = layout.cells.slice(0, layout.count);
  const allOnInterval = (iv: Interval) =>
    visibleCells.length > 0 && visibleCells.every((c) => c.interval === iv);

  useEffect(() => {
    let cancelled = false;
    setMarketError(null);

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    // A transient hiccup shouldn't wipe every saved cell — retry twice
    // quickly, surface the banner on the third failure, then KEEP retrying
    // every 20s: a 429 storm (rapid interval flipping can empty the
    // whole budget) clears within a minute, and the wall should come back
    // by itself instead of dead-ending on a manual retry button.
    async function loadWithRetries() {
      const delaysMs = [0, 2000, 5000];
      for (let attempt = 0; ; attempt++) {
        const wait = attempt < delaysMs.length ? delaysMs[attempt] : 20_000;
        if (wait > 0) await sleep(wait);
        if (cancelled) return;
        try {
          const c = await loadMarkets();
          if (!cancelled) {
            // a Retry's load lands on a live catalog: merged, never assigned
            // raw (identity + never-degrade — see mergeCatalog, Invariant 12)
            setCatalog((prev) => (prev ? mergeCatalog(prev, c) : c));
            setMarketError(null);
          }
          return;
        } catch (err) {
          if (attempt >= delaysMs.length - 1 && !cancelled) {
            setMarketError(err instanceof Error ? err.message : String(err));
          }
        }
      }
    }

    loadWithRetries();
    return () => {
      cancelled = true;
    };
  }, [marketRetry]);

  // The watch engine needs the live HIP-3 dex list: positions on builder dexs
  // are invisible to the main-clearinghouse subscription (a per-dex API fact,
  // docs/architecture.md → User state).
  // Keyed by VALUE: the live catalog refreshes (hl/catalogSync.ts), and only
  // a changed dex set may touch the stats poll or the watch fan-out.
  const hip3Key = useMemo(() => (catalog ? hip3DexKey(catalog.markets) : null), [catalog]);
  useEffect(() => {
    if (hip3Key === null) return;
    setWatchDexs(hip3Key ? hip3Key.split(',') : []);
  }, [hip3Key]);

  useEffect(() => {
    // The address bar always carries the current wall — copying it (or the
    // Share button) reproduces this exact layout. replaceState avoids
    // polluting history and never fires hashchange. Exceptions: in #wc mode
    // the bar keeps the evergreen #wc link until the first real edit,
    // and in LIST view the bar keeps #list (or the shared/#wc hash it is
    // preserving — routing rule 3): layout changes that land while the list
    // is showing (sync merges, #wc resolution) must not rewrite it.
    if (view === 'wall' && !wcModeRef.current) {
      history.replaceState(
        null,
        '',
        `#${encodeLayoutHash(
          layout.count,
          layout.cols,
          layout.cells,
          // only user-given names travel; preset walls are reproducible by key
          layout.name?.startsWith('saved:') ? layout.name.slice(6) : null,
        )}`,
      );
    } else if (
      (view === 'list' || view === 'positions') &&
      !viewingSharedRef.current &&
      !wcModeRef.current &&
      window.location.hash !== (view === 'list' ? '#list' : '#pos')
    ) {
      // An edit from the list (add-to-wall) just ADOPTED a shared/#wc wall —
      // the bar must stop claiming the foreign hash, or a reload re-classifies
      // the user's own adopted wall as a share (minus their addition) and the
      // next edit clobbers it. Keep the entry's {pw} marker: this may be the
      // card entry. Positions view keeps #pos the same way.
      history.replaceState(history.state, '', view === 'list' ? '#list' : '#pos');
    }
    // ?mini=1 popouts are transient single-cell viewers that SHARE this
    // origin's localStorage — they must never write the main wall's layout
    // (editing a popout's interval once would otherwise clobber the wall).
    if (viewingSharedRef.current || isMini) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // storage blocked (private mode / quota) — the wall still works, just unsaved
    }
  }, [layout, view]);

  // Opening the picker proves the user found the core gesture — retire the hint
  useEffect(() => {
    if (pickerFor !== null && showHint) dismissHint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerFor]);

  // The hashchange/popstate listeners are registered once — they read the
  // current layout through a ref, not a stale closure.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /**
   * The address-bar hash at the moment OUR OWN Wall button called
   * history.back(). The entry we land on holds a snapshot of this wall from
   * before the list visit, and it is STALE the moment the user edited from
   * the list: without this marker, add-to-wall → Wall would revert the
   * addition, flip viewingSharedRef on, and then let the next ordinary edit
   * overwrite the good layout for good.
   *
   * A hash and not a boolean, deliberately. When the list entry carries the
   * same hash as the wall entry — the shared/#wc path, where toList pushes the
   * current href verbatim (routing rule 3) — the traversal fires popstate with
   * NO hashchange after it, and a boolean would stay armed and swallow the
   * user's next genuinely-pasted share link. onPop consumes it in exactly that
   * case; onHashChange consumes it in every other.
   */
  const selfBackRef = useRef<string | null>(null);

  // Pasting a shared link into an already-open tab applies it live —
  // and, like the initial-load path, must not clobber the viewer's saved wall.
  useEffect(() => {
    const onHashChange = () => {
      // Routing rule 4, PREVIOUS-entry case. This hash is one we put in the bar
      // ourselves before the list visit, replayed by our own Wall button — not
      // something that arrived from outside. The wall has legitimately moved on
      // since that entry was written, so show it and adopt nothing: no
      // setLayout, no viewingSharedRef, no #wc re-entry (a #wc wall adopted
      // from the list would otherwise snap back into #wc mode). The
      // [layout, view] effect rewrites the bar to the wall actually on screen.
      // Must sit above the WC_HASH branch to cover that last case.
      if (selfBackRef.current !== null) {
        selfBackRef.current = null;
        setView('wall');
        return;
      }
      if (WC_HASH.test(window.location.hash)) {
        viewingSharedRef.current = true;
        wcModeRef.current = true;
        setWcPending(true);
        setView('wall'); // a #wc link lands on the wall it builds
        return;
      }
      const fromHash = layoutFromHash(window.location.hash);
      if (fromHash) {
        // Back/forward across our own entries re-fires our own hash: content
        // identical to the current wall means nothing arrived — show the
        // wall, but never re-classify it as a foreign share (routing rule 4).
        if (sameWall(fromHash, layoutRef.current)) {
          setView('wall');
          return;
        }
        // Backing out of a pasted shared-wall peek re-fires the hash of the
        // user's OWN persisted wall (the screen still shows the peek, so the
        // guard above misses) — restore it as own, names intact, never as a
        // share (mirrors the boot classifier).
        const persisted = loadLayout();
        if (sameWall(fromHash, persisted)) {
          viewingSharedRef.current = false;
          wcModeRef.current = false;
          setWcPending(false);
          setLayout(persisted);
          // a hashchange-driven return to wall leaves no pushed entry under
          // us — clear the flag or the NEXT toList would replaceState over a
          // history entry we never pushed
          pushedListRef.current = false;
          setView('wall');
          return;
        }
        viewingSharedRef.current = true;
        wcModeRef.current = false;
        setWcPending(false); // a pasted layout hash supersedes a pending #wc
        setLayout(fromHash);
        pushedListRef.current = false; // same reasoning as above
        setView('wall'); // a share link lands on the thing it points at
      } else if (window.location.hash === '#list') {
        setView('list'); // forward-nav onto a list entry
      } else if (window.location.hash === '#pos') {
        setView('positions');
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // history.state survives reloads, but our {pw} markers describe RUNTIME
  // state (pushedListRef, a live card) that doesn't — a stale marker left on
  // the boot entry misroutes the first toggle's history.back() (the button
  // reads as dead). Wipe it once at boot; replaceState is idempotent under
  // StrictMode.
  useEffect(() => {
    if ((history.state as { pw?: string } | null)?.pw) {
      history.replaceState(null, '', window.location.href);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // History peeling (card → list → wall): entries we push carry a {pw} state
  // marker; landing on one restores its view. Entries without a marker are
  // wall entries unless their hash is #list (a direct #list boot entry).
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      // Our own back() landing on an entry with an IDENTICAL fragment fires no
      // hashchange, so the marker has to be retired here or it outlives this
      // traversal and eats the next pasted share link. Only that case — when
      // the fragment did change, hashchange is still coming for it.
      if (selfBackRef.current !== null && window.location.hash === selfBackRef.current) {
        selfBackRef.current = null;
      }
      const pw = (e.state as { pw?: string } | null)?.pw;
      pushedListRef.current = pw === 'list' || pw === 'card' || pw === 'pos';
      // A FOREIGN layout hash arriving with this navigation belongs to the
      // paired hashchange event (it always follows popstate): it will adopt
      // the wall and set the view. Touching view here would run the
      // [layout, view] effect first and overwrite the not-yet-consumed hash
      // with the OLD layout — pasting a share link while in list view would
      // silently drop the paste.
      const fromHash = layoutFromHash(window.location.hash);
      if (fromHash && !sameWall(fromHash, layoutRef.current)) return;
      const inPos = pw === 'pos' || window.location.hash === '#pos';
      const inList = pw === 'list' || pw === 'card' || window.location.hash === '#list';
      setView(inPos ? 'positions' : inList ? 'list' : 'wall');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** View switches are user gestures — the only place history entries are
   *  created (StrictMode-safe by construction) and never editLayout. */
  const toPushedView = (target: 'list' | 'positions') => {
    if (view === target) return;
    setExpandedCell(null); // a fullscreen cell would sit over the page
    exitArrange();
    // Routing rule 3: a shared/#wc bar hash is the only copy of that wall —
    // keep it; own walls get the shareable #list / #pos.
    const href =
      viewingSharedRef.current || wcModeRef.current
        ? window.location.href
        : target === 'list'
          ? '#list'
          : '#pos';
    const marker = { pw: target === 'list' ? 'list' : 'pos' };
    if (pushedListRef.current) {
      // already sitting on a pushed view entry (list ↔ positions switch, or a
      // list card) — REPLACE it so one back still returns to the wall
      // (routing rule 2).
      history.replaceState(marker, '', href);
    } else {
      history.pushState(marker, '', href);
    }
    pushedListRef.current = true;
    setView(target);
  };
  const toList = () => toPushedView('list');
  const toPositions = () => toPushedView('positions');
  const toWall = () => {
    if (view === 'wall') return;
    if (pushedListRef.current) {
      // we pushed the list entry — pop it so back doesn't replay the toggle.
      // Arm the self-back marker first: the entry underneath holds a snapshot
      // of this wall from before the list visit (see selfBackRef).
      selfBackRef.current = window.location.hash;
      history.back();
      return;
    }
    // direct #list boot: nothing to pop; the layout effect rewrites the hash
    setView('wall');
  };

  // Resolve a pending #wc once live market data is ready. Deliberately NOT
  // editLayout: viewingSharedRef must stay set so the #wc link behaves
  // like any shared wall (no clobbering the viewer's saved layout).
  useEffect(() => {
    if (!wcPending || !catalog || !stats) return;
    setWcPending(false);
    // Any user edit while data was loading supersedes the #wc link —
    // without this, the late-arriving wall would override their edit AND
    // (viewingSharedRef now false) be persisted over their saved layout.
    if (!viewingSharedRef.current) return;
    const coins = worldCupCoins(catalog, stats);
    if (coins.length === 0) {
      // Tournament over / markets gone: restore the visitor's OWN wall and
      // stop treating this as a #wc view — the bar gets the wall's own
      // hash and persistence resumes. loadLayout(), not the screen: on the
      // hashchange path the screen may still hold a foreign share peek, and
      // blessing it would persist the friend's wall over the viewer's. A
      // fresh object either way, so the [layout, view] effect re-runs and
      // does both.
      viewingSharedRef.current = false;
      wcModeRef.current = false;
      setLayout(loadLayout());
      return;
    }
    setLayout((prev) => wallOf(coins, prev.cells[0]?.interval ?? '1h', 'world-cup'));
  }, [wcPending, catalog, stats]);

  // Badge stats (funding / OI / volume / prevDayPx for 24h change): polled
  // every 60s (~120 REST weight/min with ~4 live HIP-3 dexs, shares the
  // picker's 30s cache). The live side of 24h change comes from the candle
  // stream, so it ticks in realtime. (allDexsAssetCtxs over WS would be free
  // but omits spot and keys ctxs by universe index, not coin — not worth the
  // plumbing.) The same responses carry every listing the catalog was built
  // from, so each tick also feeds the live-catalog refresher
  // (hl/catalogSync.ts) — a new listing reaches the picker within a poll,
  // with no reload. Keyed on the dex SET, never the catalog object: a
  // refresh it triggers must not restart it.
  const statsFailsRef = useRef(0);
  const catalogRef = useRef<MarketCatalog | null>(null);
  const refresherRef = useRef<CatalogRefresher | null>(null);
  useEffect(() => {
    catalogRef.current = catalog;
    // Created when the first catalog COMMITS — hidden or not — so its clocks
    // start at the boot load: a background-opened tab's first visible poll
    // hours later finds the backstop due and catches up at once.
    if (catalog) {
      refresherRef.current ??= createCatalogRefresher({
        now: () => Date.now(),
        current: () => catalogRef.current,
        apply: (update) => setCatalog((prev) => (prev ? update(prev) : prev)),
        loadFull: loadMarkets,
        loadOutcomes,
      });
    }
  }, [catalog]);
  useEffect(() => {
    if (hip3Key === null) return;
    let cancelled = false;
    const tick = () => {
      // Hidden tab: skip the poll nobody is watching; one immediate
      // catch-up tick on return.
      if (document.hidden) return;
      loadMarketStats(hip3Key)
        .then(({ stats: s, listing }) => {
          if (cancelled) return;
          statsFailsRef.current = 0;
          setStats(s);
          void refresherRef.current?.onPoll(listing);
        })
        .catch((err) => {
          if (cancelled) return;
          statsFailsRef.current += 1;
          if (statsFailsRef.current >= 3) setStats(null);
          console.warn('[purrwall] badge stats poll failed:', err);
        });
    };
    tick();
    const timer = window.setInterval(tick, 60_000);
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [hip3Key]);

  const applyPreset = (key: string) => {
    let coins: string[] | null = null;
    if (key === 'top-volume') {
      if (!stats || !markets) return;
      coins = markets
        .filter((m) => m.kind === 'perp' || m.kind === 'hip3')
        .map((m) => ({ coin: m.coin, v: stats.get(m.coin)?.volumeUsd ?? 0 }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 9)
        .map((x) => x.coin);
    } else {
      coins = WALL_PRESETS.find((p) => p.key === key)?.coins ?? null;
    }
    if (!coins || coins.length === 0) return;
    // Presets swap the COINS, not the user's chosen time horizon
    const wall = wallOf(coins, layout.cells[0]?.interval ?? '1h', key);
    editLayout(() => wall);
  };

  const swapCells = (a: number, b: number) => {
    editLayout((prev) => {
      const cells = [...prev.cells];
      [cells[a], cells[b]] = [cells[b], cells[a]];
      return { ...prev, cells };
    });
  };

  /** List-card action: drop a market into the wall. First empty cell wins;
   *  a wall with no empty cell grows by one cell (count + 1, no resizeGrid,
   *  so cell order is kept); a wall already at MAX_CELLS reports 'full'.
   *  Composition-change name semantics match updateCell: presets detach,
   *  saved views stay and go dirty. */
  const addToWall = (coin: string, interval: Interval): 'added' | 'grown' | 'full' => {
    const cur = layoutRef.current;
    const hasEmpty = cur.cells.slice(0, cur.count).some((c) => !c.coin);
    // WALL-SIZE SEMANTICS: count is the wall's one real dimension, so
    // growth is simply count+1 up to MAX_CELLS — the same semantics as the
    // desktop ghost "+" tiles. A cols×MAX_ROWS cap would dead-end phone
    // walls at cols×4 while the count chips one tap away offer 16/24. The
    // capacity check up front still guards the fallback from silently
    // overwriting a chart.
    if (!hasEmpty && cur.count >= MAX_CELLS) return 'full';
    editLayout((prev) => {
      const name = prev.name?.startsWith('saved:') ? prev.name : null;
      const idx = prev.cells.slice(0, prev.count).findIndex((c) => !c.coin);
      if (idx !== -1) {
        return {
          ...prev,
          name,
          cells: prev.cells.map((c, i) => (i === idx ? { coin, interval } : c)),
        };
      }
      if (prev.count >= MAX_CELLS) return prev; // raced to full — never overwrite
      // no resizeGrid: count-only growth keeps cell order; the new chart
      // lands at index prev.count (desktop's partial last row shows ghost
      // "+" tiles for the remaining slots)
      const at = prev.count;
      return {
        ...prev,
        name,
        count: prev.count + 1,
        cells: prev.cells.map((c, i) => (i === at ? { coin, interval } : c)),
      };
    });
    return hasEmpty ? 'added' : 'grown';
  };

  /** Tear a cell out into its own small always-live window. */
  const popOutCell = (cell: CellState) => {
    if (!cell.coin) return;
    const hash = encodeLayoutHash(1, 1, [cell]);
    window.open(
      `${window.location.pathname}?mini=1#${hash}`,
      '_blank',
      // 520 → a ~508px cell, under App.css's first degradation rung
      // (≤510px), so the popup header uses the compact interval dropdown
      'popup=yes,width=520,height=340',
    );
  };

  const persistWalls = (walls: SavedWall[]) => {
    setSavedWalls(walls);
    try {
      localStorage.setItem(WORKSPACES_KEY, JSON.stringify(walls));
    } catch {
      /* storage blocked — non-fatal */
    }
  };

  /** Tombstones stay in storage (sync needs them) but never in the UI. */
  const liveWalls = savedWalls.filter((w) => !w.deletedAt);

  // Per-view unsaved working copies. setViewDraft(name, working) stashes a
  // view's experiment; setViewDraft(name, null) clears it (on save/discard/
  // delete). A view with an entry here shows a • dot and reloads its working
  // copy — not the clean saved version — when reselected.
  const [viewDrafts, setViewDrafts] = useState<Record<string, DraftWall>>(loadViewDrafts);
  const setViewDraft = (name: string, d: DraftWall | null) => {
    setViewDrafts((prev) => {
      if (!d && !(name in prev)) return prev;
      const next = { ...prev };
      if (d) next[name] = d;
      else delete next[name];
      try {
        localStorage.setItem(VIEW_DRAFTS_KEY, JSON.stringify(next));
      } catch {
        /* non-fatal */
      }
      return next;
    });
  };

  // If the saved view we're ON disappears (deleted/renamed on another paired
  // device via sync), detach to an unnamed scratch — same as a local delete
  // (deleteWall). Otherwise the working copy is orphaned: mislabeled dropdown,
  // no Save path, and silently lost on the next switch (stashLeaving skips it).
  useEffect(() => {
    if (viewingSharedRef.current) return; // a shared view's name is display-only
    const n = layout.name;
    if (n?.startsWith('saved:') && !savedWalls.some((w) => w.name === n.slice(6) && !w.deletedAt)) {
      setLayout((prev) => (prev.name === n ? { ...prev, name: null } : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedWalls, layout.name]);

  // Prune per-view drafts to live views only: a draft for a deleted view is
  // invisible dead weight, and (worse) a later view reusing that name would
  // inherit the stale working copy. Runs whenever the library changes.
  useEffect(() => {
    setViewDrafts((prev) => {
      const live = new Set(savedWalls.filter((w) => !w.deletedAt).map((w) => w.name));
      const names = Object.keys(prev);
      if (names.every((n) => live.has(n))) return prev;
      const next: Record<string, DraftWall> = {};
      for (const n of names) if (live.has(n)) next[n] = prev[n];
      try {
        localStorage.setItem(VIEW_DRAFTS_KEY, JSON.stringify(next));
      } catch {
        /* non-fatal */
      }
      return next;
    });
  }, [savedWalls]);

  // Views are DOCUMENTS with explicit save: editing a saved view builds an
  // unsaved working state (the "test state"); Save commits it, leaving
  // without saving reverts to the last saved version — and the working copy
  // is tucked into the draft slot so an experiment is never truly lost. Only
  // saved versions ever sync.
  const savedContentOf = (name: string) => liveWalls.find((w) => w.name === name);
  const dirtyAgainstSaved = (l: Layout): boolean => {
    if (!l.name?.startsWith('saved:')) return false;
    const w = savedContentOf(l.name.slice(6));
    if (!w) return false;
    return !(
      w.count === l.count &&
      (w.cols ?? defaultColsFor(w.count)) === l.cols &&
      JSON.stringify(w.cells) === JSON.stringify(l.cells.slice(0, l.count))
    );
  };
  /** On our own saved view with unsaved edits → save button + dirty dot show. */
  const isDirty = !viewingSharedRef.current && dirtyAgainstSaved(layout);
  const activeSavedName = layout.name?.startsWith('saved:') ? layout.name.slice(6) : null;

  const saveCurrentView = () => {
    if (!activeSavedName) return;
    const entry: SavedWall = {
      name: activeSavedName,
      count: layout.count,
      cols: layout.cols,
      cells: layout.cells.slice(0, layout.count),
      updatedAt: Date.now(),
    };
    persistWalls(savedWalls.map((w) => (w.name === entry.name && !w.deletedAt ? entry : w)));
    setViewDraft(entry.name, null); // committed — no pending working copy
  };
  const discardChanges = () => {
    const w = activeSavedName ? savedContentOf(activeSavedName) : undefined;
    if (!w) return;
    const cells = Array.from(
      { length: MAX_CELLS },
      (_, i): CellState => w.cells[i] ?? { coin: null, interval: '1h' },
    );
    const count = Math.min(Math.max(w.count, 1), MAX_CELLS);
    setViewDraft(w.name, null); // drop the experiment
    // setLayout (not editLayout): reverting isn't an edit, and we're already
    // on our own wall so the shared-adoption guards don't apply
    setLayout({ count, cols: clampCols(w.cols ?? NaN, count), cells, name: layout.name });
  };
  // Ctrl/⌘S saves the dirty view (the browser's "save page" is never what a
  // wall user means). Refs, not deps: the handler must see the current
  // layout without re-binding on every stats tick.
  const saveShortcutRef = useRef<(() => void) | null>(null);
  saveShortcutRef.current = isDirty && view === 'wall' ? saveCurrentView : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return;
      const save = saveShortcutRef.current;
      if (!save) return;
      e.preventDefault();
      save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** First auto-name not already taken (localized "View N"). */
  const nextViewName = (): string => {
    const base = lang === 'zh' ? '视图 ' : 'View ';
    for (let i = liveWalls.length + 1; ; i++) {
      const name = `${base}${i}`;
      if (!liveWalls.some((w) => w.name === name)) return name;
    }
  };

  // ── wall sync (opt-in pairing code; see src/lib/sync.ts) ──
  const [syncCode, setSyncCodeState] = useState<string | null>(getSyncCode);
  // 'rejected' = the server refused our last upload (library over the
  // 100-wall/64KB cap) — edits are NOT propagating; ⚠ in the walls menu +
  // a line in the sync dialog until the library shrinks and a PUT lands.
  const syncHealth = useSyncExternalStore(subscribeSyncHealth, getSyncHealth);
  // one-shot toast when "+ New view" is refused at the library cap
  const [viewsFullToast, setViewsFullToast] = useState(false);
  useEffect(() => {
    if (!viewsFullToast) return;
    const timer = setTimeout(() => setViewsFullToast(false), 5000);
    return () => clearTimeout(timer);
  }, [viewsFullToast]);
  const [syncInput, setSyncInput] = useState('');
  const [syncErr, setSyncErr] = useState<'notfound' | 'network' | 'format' | 'toobig' | null>(
    null,
  );
  // ── watch address (read-only account overlay; store in lib/watch.ts) ──
  // Snapshots are PRIMITIVES (address, stamp, book-emptiness), never the
  // store's data version: the version bumps on every ~5s WS re-push, and an
  // App-wide re-render at that cadence is a standing cost the paint-gating
  // architecture exists to avoid. Live counts/tables render inside
  // WatchAccountPanel / PositionsView, which subscribe on their own.
  const watchAddr = useSyncExternalStore(subscribeWatch, getWatchAddr);
  // the unit stamp: changes on any book/active edit (sync push trigger),
  // never on data pushes
  const watchAt = useSyncExternalStore(subscribeWatch, () => getWatchStamp().at);
  const watchBookNonEmpty = useSyncExternalStore(subscribeWatch, () => getWatchBook().length > 0);
  // moves only on overlay toggles (master + per-entry show), never on pushes
  const overlayFp = useSyncExternalStore(subscribeWatch, getOverlayFp);
  void overlayFp;
  const [watchInput, setWatchInput] = useState('');
  // 'bad' = malformed address, 'full' = book at cap — two different problems,
  // two different messages (a valid address must never read as malformed)
  const [watchErr, setWatchErr] = useState<'bad' | 'full' | null>(null);
  /** Sync pulled a newer watch unit — adopt it wholesale. The store
   *  re-validates every address on the way in (a garbage doc costs the
   *  overlay, nothing else), and the REMOTE stamp keeps LWW consistent. */
  const applyWatchSync = (w: SyncedWatch) => {
    if (w.at > getWatchStamp().at) applyWatchRemote(w);
  };
  /** Server docs pass through the same shape gate as localStorage loads —
   *  a hostile/buggy doc must not smuggle bogus intervals into charts. */
  const applySynced = (incoming: SyncedWall[]) => {
    setSavedWalls((prev) => {
      // Re-merge against the CURRENT library, not the pre-await snapshot the
      // reconcile started from: a local Save/delete/rename that landed during
      // the round-trip must survive (stamp-based LWW). Blind-replacing here
      // would silently revert a just-saved view.
      const merged = mergeWalls(prev as SyncedWall[], incoming);
      const normalized: SavedWall[] = merged.map((w) =>
        w.deletedAt
          ? { name: w.name, count: 0, cells: [], deletedAt: w.deletedAt }
          : {
              name: w.name,
              count: Math.min(Math.max(Math.round(w.count), 1), MAX_CELLS),
              cols: w.cols,
              cells: (w.cells ?? []).slice(0, MAX_CELLS).map((c) => ({
                coin: typeof c.coin === 'string' ? c.coin : null,
                interval: (INTERVALS as readonly string[]).includes(c.interval)
                  ? (c.interval as Interval)
                  : ('1h' as Interval),
              })),
              updatedAt: w.updatedAt,
            },
      );
      if (JSON.stringify(normalized) === JSON.stringify(prev)) return prev;
      try {
        localStorage.setItem(WORKSPACES_KEY, JSON.stringify(normalized));
      } catch {
        /* non-fatal */
      }
      return normalized;
    });
  };
  const syncBusyRef = useRef(false);
  const runReconcile = async () => {
    if (!syncCode || syncBusyRef.current) return;
    syncBusyRef.current = true;
    try {
      const merged = await reconcile(syncCode, savedWalls as SyncedWall[], getWatchStamp());
      if (merged) {
        applySynced(merged.walls);
        applyWatchSync(merged.watch);
      }
    } finally {
      syncBusyRef.current = false;
    }
  };
  // push (read-merge-write) shortly after any library change… (watchAt is a
  // dep of its own: any watch-unit edit — activate, rename, add, remove —
  // must push without a wall edit; it never moves on WS data pushes)
  useEffect(() => {
    if (!syncCode) return;
    const timer = window.setTimeout(runReconcile, 2000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedWalls, syncCode, watchAt]);
  // …and pull when the user comes back to the tab
  useEffect(() => {
    if (!syncCode) return;
    const onVis = () => {
      if (!document.hidden) runReconcile();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncCode, savedWalls]);

  const [draft, setDraft] = useState<DraftWall | null>(loadDraft);
  const persistDraft = (d: DraftWall | null) => {
    setDraft(d);
    try {
      if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* non-fatal */
    }
  };
  /** The wall a menu switch is leaving behind. While viewing a shared link
   *  the wall at risk is the viewer's own PERSISTED one, not the screen. */
  const leavingWall = (): Layout => (viewingSharedRef.current ? loadLayout() : layout);
  /** Preserve on switch what would otherwise revert away: a dirty saved
   *  view's working copy goes to ITS per-view draft; an unnamed scratch goes
   *  to the anonymous slot. Presets and clean saved views need nothing. */
  const stashLeaving = (l: Layout) => {
    const snap: DraftWall = { count: l.count, cols: l.cols, cells: l.cells };
    if (l.name?.startsWith('saved:')) {
      // dirty → keep the experiment; clean → DROP any stale draft (a manual
      // revert-to-clean must not leave an old working copy to resurrect)
      setViewDraft(l.name.slice(6), dirtyAgainstSaved(l) ? snap : null);
    } else if (l.name == null) {
      persistDraft(snap);
    }
  };

  /** One-tap "+ new view": fork the CURRENT wall into a fresh auto-named
   *  saved view and switch to it (clean). The view/scratch you were on keeps
   *  its own unsaved state (stashLeaving). No naming dialog. */
  const createView = () => {
    // Library cap: the sync server rejects docs over SYNC_MAX_WALLS entries.
    // Count LIVE views only — tombstones are compacted away by capTombstones
    // (sync.ts) whenever live walls need the slots, so "delete some views
    // first" genuinely frees capacity. Refuse loudly, never break sync.
    if (liveWalls.length >= SYNC_MAX_WALLS) {
      setViewsFullToast(true);
      return;
    }
    stashLeaving(leavingWall());
    const name = nextViewName();
    const entry: SavedWall = {
      name,
      count: layout.count,
      cols: layout.cols,
      cells: layout.cells.slice(0, layout.count),
      updatedAt: Date.now(),
    };
    persistWalls([...savedWalls.filter((w) => w.name !== name), entry]);
    // setLayout, not editLayout: creating a view from a shared screen must not
    // re-adopt the shared wall over the viewer's persisted one
    viewingSharedRef.current = false;
    wcModeRef.current = false;
    setWcPending(false);
    setViewDraft(name, null);
    setLayout((prev) => ({ ...prev, name: `saved:${name}` }));
  };

  /** Positions walls are PRESET-LIKE, not saved views (a saved view is
   *  fixed; a positions wall is a live snapshot): applied with layout name
   *  `poswall:<addr>`, never written to the library, rebuilt from current
   *  holdings on every application. The walls-menu carries one category
   *  listing one entry per book address. */
  const buildPoswallNow = () => {
    const a = getWatchAddr();
    if (!a) return;
    const known = markets ? new Set(markets.map((m) => m.coin)) : null;
    const coins = positionsWallCoins(getWatchPositions(), getWatchOrderMap()).filter(
      (c) => !known || known.has(c),
    );
    if (coins.length === 0) return;
    stashLeaving(leavingWall());
    const count = Math.min(coins.length, MAX_CELLS);
    const cells = Array.from(
      { length: MAX_CELLS },
      (_, i): CellState => ({ coin: i < count ? coins[i] : null, interval: '1h' as Interval }),
    );
    const cols = clampCols(NaN, count);
    // setLayout + manual ref resets, NOT editLayout: from a shared wall its
    // wasShared rule would strip the name. And NOT toWall() from a pushed
    // view — its async history.back() races the layout commit and routing
    // rule 4 re-adopts the pre-poswall wall as shared; the pushed entry is
    // converted into a plain wall entry in place instead.
    viewingSharedRef.current = false;
    wcModeRef.current = false;
    setWcPending(false);
    setLayout(() => ({ count, cols, cells, name: `poswall:${a}` }));
    setWallsMgr(null);
    if (view !== 'wall') {
      history.replaceState(null, '', window.location.href);
      pushedListRef.current = false;
      setView('wall');
    }
  };
  /** Pending poswall for a just-activated address: wait for the first WS
   *  snapshot, then build. The timeout reaps an empty (or switched-away)
   *  account so a stale pending can never fire minutes later. The build
   *  goes through a per-render ref — the effect's closures are frozen at
   *  arm time, and a stale buildPoswallNow would stash the WRONG leaving
   *  wall when the snapshot lands seconds later; any intervening wall
   *  gesture (editLayout, another menu pick) cancels the pending instead of
   *  being clobbered by it. */
  const [poswallPending, setPoswallPending] = useState<string | null>(null);
  const buildPoswallRef = useRef<() => void>(() => {});
  buildPoswallRef.current = buildPoswallNow;
  useEffect(() => {
    if (!poswallPending) return;
    const tryBuild = () => {
      if (getWatchAddr() !== poswallPending) return;
      const c = getWatchCounts();
      if (c.positions + c.orders === 0) return;
      setPoswallPending(null);
      buildPoswallRef.current();
    };
    tryBuild();
    const unsub = subscribeWatch(tryBuild);
    const timeout = window.setTimeout(() => setPoswallPending(null), 10_000);
    return () => {
      unsub();
      window.clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poswallPending]);
  const applyPositionsWall = (a: string) => {
    setWallsMgr(null);
    if (getWatchAddr() !== a) {
      setActiveWatch(a); // subscriptions switch; the snapshot lands within ~1s
      setPoswallPending(a);
      return;
    }
    if (getWatchCounts().positions + getWatchCounts().orders === 0) {
      setPoswallPending(a); // just activated — data still in flight
      return;
    }
    buildPoswallNow();
  };

  const deleteWall = (name: string) => {
    // tombstone, not removal: paired devices must learn about the deletion
    // (a plain remove would lose the merge to their stale live copy)
    persistWalls(
      savedWalls.map((w) =>
        w.name === name ? { name, count: 0, cells: [], deletedAt: Date.now() } : w,
      ),
    );
    setViewDraft(name, null); // its pending working copy goes with it
    if (layout.name === `saved:${name}`) editLayout((prev) => ({ ...prev, name: null }));
  };

  // Inline rename in the manage dialog.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const renameWall = (oldName: string, raw: string) => {
    const newName = raw.trim();
    setRenaming(null);
    if (!newName || newName === oldName) return;
    if (liveWalls.some((w) => w.name === newName)) return; // name taken — no-op
    const w = savedContentOf(oldName);
    if (!w) return;
    const now = Date.now();
    // sync keys by NAME, so a rename is a delete + create: the old name must
    // tombstone or the other device would re-add it on the next merge.
    persistWalls([
      ...savedWalls.filter((x) => x.name !== oldName && x.name !== newName),
      { ...w, name: newName, updatedAt: now },
      { name: oldName, count: 0, cells: [], deletedAt: now },
    ]);
    // move any pending working copy to the new name
    const pending = viewDrafts[oldName];
    if (pending) {
      setViewDraft(oldName, null);
      setViewDraft(newName, pending);
    }
    if (layout.name === `saved:${oldName}`) setLayout((prev) => ({ ...prev, name: `saved:${newName}` }));
  };

  const onWallsSelect = (value: string) => {
    // any menu action supersedes a still-pending deferred poswall build
    // (selecting a poswall entry re-arms it via applyPositionsWall)
    setPoswallPending(null);
    if (value === '__addview') {
      setMoreOpen(false);
      createView(); // one tap: auto-named, no dialog
    } else if (value === '__discard') {
      setMoreOpen(false);
      discardChanges();
    } else if (value === '__delete') {
      setMoreOpen(false);
      setWallsMgr('manage');
    } else if (value === '__sync') {
      setMoreOpen(false);
      setSyncErr(null);
      setWallsMgr('sync');
    } else if (value === '__watch') {
      setMoreOpen(false);
      setWatchErr(null);
      setWatchInput('');
      setWallsMgr('watch');
    } else if (value.startsWith('poswall:')) {
      setMoreOpen(false);
      applyPositionsWall(value.slice(8));
    } else if (value === '__posview') {
      setMoreOpen(false);
      toPositions();
    } else if (value === '__draft') {
      if (!draft) return;
      const restore = draft;
      const leaving = leavingWall();
      if (leaving.name == null) {
        // swap: the unnamed scratch you're leaving takes the slot
        persistDraft({ count: leaving.count, cols: leaving.cols, cells: leaving.cells });
      } else {
        // a dirty saved view must go to ITS per-view draft (not be lost),
        // then consume the anonymous slot we're restoring
        stashLeaving(leaving);
        persistDraft(null);
      }
      const cells = Array.from(
        { length: MAX_CELLS },
        (_, i): CellState => restore.cells[i] ?? { coin: null, interval: '1h' },
      );
      editLayout(() => ({ count: restore.count, cols: restore.cols, cells, name: null }));
    } else if (value.startsWith('saved:')) {
      const name = value.slice(6);
      const wall = liveWalls.find((w) => w.name === name);
      if (!wall) return;
      // already on this view (own, not a shared arrival) → no-op: a
      // stash-then-read here would revert to a stale draft snapshot. Use
      // Discard to drop unsaved edits.
      if (layout.name === value && !viewingSharedRef.current) return;
      stashLeaving(leavingWall());
      // a pending working copy for this view resumes exactly where you left
      // off (dirty); otherwise load the clean saved version
      const src = viewDrafts[name] ?? wall;
      const cells = Array.from(
        { length: MAX_CELLS },
        (_, i): CellState => src.cells[i] ?? { coin: null, interval: '1h' },
      );
      const count = Math.min(Math.max(src.count, 1), MAX_CELLS);
      editLayout(() => ({ count, cols: clampCols(src.cols ?? NaN, count), cells, name: value }));
    } else {
      stashLeaving(leavingWall());
      applyPreset(value);
    }
  };

  const share = async () => {
    const url = window.location.href;
    if (IS_COARSE && typeof navigator.share === 'function') {
      try {
        await navigator.share({ url });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return; // user cancelled — silent
        // unsupported/failed — fall through to clipboard copy
      }
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard blocked (e.g. permission denied) — classic textarea copy instead.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) return; // double failure (clipboard API + execCommand) — no false-positive flash
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const markets = catalog?.markets ?? null;

  // "New version" pill — the ONLY update path: no silent self-update
  // anywhere; users click the pill themselves. Mini popouts skip the check:
  // they render no topbar to carry a pill, and their parent wall shows it
  // instead. See src/lib/updateCheck.ts for the full contract.
  const updateReady = useUpdateCheck(!isMini);

  // Pull-to-refresh (narrow wall only): the habitual "pull to be sure it's
  // current" gesture. A new deploy is the main thing that habit is for, so
  // a pull first probes /version.json and applies a fresh build via
  // reload — user-initiated, the same gesture class as clicking the ↻ pill.
  // Otherwise it broadcasts a wall-wide gap-heal (same path as a WS
  // reconnect): ~20 weight/cell, viewport kept, no white flash.
  const gridRef = useRef<HTMLElement | null>(null);
  useModalFocus(wallsMgrRef, wallsMgr !== null);
  useModalFocus(pkShellRef, pickerFor !== null && !markets);
  const ptrIndRef = useRef<HTMLDivElement | null>(null);
  // Touch drag-to-swap session. React state carries only what CSS needs
  // (source, moved, hovered target); everything per-move lives in a ref and
  // writes the DOM imperatively — 60Hz re-renders of a 9-chart wall are
  // exactly the jank the renderQueue exists to avoid.
  const slotRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [liftFrom, setLiftFrom] = useState<number | null>(null);
  const [liftTarget, setLiftTarget] = useState<number | null>(null);
  const liftSessRef = useRef<boolean>(false);
  const layoutCountRef = useRef(layout.count);
  layoutCountRef.current = layout.count;
  usePullToRefresh({
    gridRef,
    indicatorRef: ptrIndRef,
    // expanded cell = fixed overlay (its own scroll world); arrange = tap
    // targets over every cell; an active cell drag owns the touch — all
    // three suspend the gesture.
    enabled: isNarrow && view === 'wall' && expandedCell === null && !arrange && liftFrom === null,
    // heals cost ~20 weight × cells — scale the pacing so a 24-cell wall
    // can't sit at the 1200/min IP budget alongside the 60s stats poll
    cooldownMs: Math.max(30_000, layout.count * 2_000),
    // the ↻ pill is already up: pulls apply it regardless of the cooldown
    updatePending: () => updateReady,
    onRefresh: async () => {
      if (updateReady || (await isNewVersionLive())) {
        window.location.reload();
        // the page is unloading — never settle, so the spinner holds
        return new Promise<never>(() => {});
      }
      emitManualRefresh();
    },
  });

  /**
   * Long-press fired on cell `from`: run one drag session on document-level
   * pointer listeners (touch pointer events are implicitly captured to the
   * pressed header, so they keep flowing regardless of what's under the
   * finger). Finger moves >10px → the slot follows via transform (scroll-
   * compensated, since edge auto-scroll moves its layout position) and the
   * hovered sibling highlights; release on it swaps. Release without
   * movement → arrange/selection mode, the same as onArrange.
   */
  const startCellLift = (
    from: number,
    startX: number,
    startY: number,
    pointerId: number,
  ): boolean => {
    const grid = gridRef.current;
    const slot = slotRefs.current[from];
    // refusal tells fireArrange to skip its vibrate/swallow side effects
    if (!grid || !slot || liftSessRef.current) return false;
    liftSessRef.current = true;
    setLiftFrom(from);
    // proximity snap would re-park every programmatic scrollTop write the
    // edge auto-scroll makes (it parks the resting grid at 5px, not 0) —
    // off for the session, restored at release
    const prevSnap = grid.style.scrollSnapType;
    grid.style.scrollSnapType = 'none';
    // The PICKUP must be felt at once (a silent hold reads as "nothing
    // happened"): pop the card immediately — eased inline transition for
    // this one change; the first tracking move switches to transition:none
    // so the follow stays 1:1. pointer-events goes off now so the very first
    // retarget already sees through the card.
    slot.style.transition = 'transform 0.15s ease';
    slot.style.transform = 'scale(0.97)';
    slot.style.pointerEvents = 'none';
    slot.style.zIndex = '60';
    const sess = {
      x: startX,
      y: startY,
      startScrollTop: grid.scrollTop,
      moved: false,
      target: null as number | null,
      raf: 0,
    };

    const applyTransform = () => {
      const dx = sess.x - startX;
      const dy = sess.y - startY + (grid.scrollTop - sess.startScrollTop);
      // scale DOWN: the grid scroller clips its content, so an upscaled
      // full-width (1-col) card would shear at the edges — inset reads as
      // "picked up" without ever truncating
      slot.style.transform = `translate(${dx}px, ${dy}px) scale(0.97)`;
    };

    const retarget = () => {
      // the lifted slot is pointer-events:none, so this hits what's under it
      const hit = document.elementFromPoint(sess.x, sess.y)?.closest?.('[data-slot]');
      const idx = hit instanceof HTMLElement ? Number(hit.dataset.slot) : NaN;
      const t = Number.isInteger(idx) && idx !== from ? idx : null;
      if (t !== sess.target) {
        sess.target = t;
        setLiftTarget(t);
        if (t !== null) navigator.vibrate?.(5);
      }
    };

    // edge auto-scroll keeps long walls draggable; runs on rAF because the
    // finger can rest still inside the edge band while content must move
    const EDGE = 56;
    const tick = () => {
      const r = grid.getBoundingClientRect();
      let step = 0;
      if (sess.y < r.top + EDGE) step = -Math.ceil((r.top + EDGE - sess.y) / 6);
      else if (sess.y > r.bottom - EDGE) step = Math.ceil((sess.y - (r.bottom - EDGE)) / 6);
      if (step !== 0 && sess.moved) {
        grid.scrollTop += step;
        applyTransform();
        retarget();
      }
      sess.raf = requestAnimationFrame(tick);
    };
    sess.raf = requestAnimationFrame(tick);

    const onMove = (e: PointerEvent) => {
      // the session is PINNED to the lifting finger: a second touch must
      // neither warp the card nor commit/kill the drag (the same bug class
      // the pager swipe's pointerId pin guards against)
      if (e.pointerId !== pointerId) return;
      sess.x = e.clientX;
      sess.y = e.clientY;
      // threshold ABOVE the long-press's own 8px drift tolerance, so a held
      // finger's jitter can't misclassify a hold as a drag
      if (!sess.moved && Math.hypot(sess.x - startX, sess.y - startY) > 10) {
        sess.moved = true;
        slot.style.transition = 'none'; // pop is over — tracking must be 1:1
      }
      if (sess.moved) {
        applyTransform();
        retarget();
      }
    };
    const blockScroll = (e: TouchEvent) => e.preventDefault();
    const finish = (commit: boolean) => {
      cancelAnimationFrame(sess.raf);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('touchmove', blockScroll, { capture: true });
      grid.style.scrollSnapType = prevSnap;
      slot.style.transition = '';
      slot.style.transform = '';
      slot.style.pointerEvents = '';
      slot.style.zIndex = '';
      liftSessRef.current = false;
      setLiftFrom(null);
      setLiftTarget(null);
      if (!commit) return;
      const travel = Math.hypot(sess.x - startX, sess.y - startY);
      if (sess.moved && sess.target !== null) {
        // count re-checked live: a sync reconcile can shrink the wall mid-drag
        if (sess.target < layoutCountRef.current && from < layoutCountRef.current) {
          swapCells(from, sess.target);
          navigator.vibrate?.(10);
        }
      } else if (!sess.moved || travel < 24) {
        // held still — or wobbled a few px and released in place: both mean
        // "select this cell", never a silent no-op. A real drag released
        // over empty space / its own cell stays a deliberate cancel.
        enterArrange(from);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      finish(true);
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      finish(false);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    // own the touch for the whole session — without this the first drag
    // movement scrolls the grid instead (armed before any move happens, so
    // iOS's first-cancelable-touchmove rule is satisfied by construction).
    // Deliberately unfiltered: ALL scrolling stays suppressed mid-drag.
    document.addEventListener('touchmove', blockScroll, { passive: false, capture: true });
    return true;
  };

  // Escape closes the picker loading shell (the real MarketPicker owns its
  // own Escape handler once markets land, so this only needs to cover the
  // pre-catalog window).
  useEffect(() => {
    if (pickerFor === null || markets) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerFor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerFor, markets]);

  // Walls button label: the current NAMED wall (preset / saved), or the
  // generic placeholder once the composition diverges into a custom wall.
  const wallLabel = (() => {
    const n = layout.name;
    if (!n) return null;
    if (n.startsWith('saved:')) return n.slice(6);
    if (n.startsWith('poswall:')) return `👁 ${watchLabel(n.slice(8))}`;
    const preset = WALL_PRESETS.find((p) => p.key === n);
    if (preset) return t(preset.labelKey);
    if (n === 'top-volume') return t('preset_topvol');
    return null;
  })();
  /** ✓-prefix the active entry so the open menu shows where you are too. */
  const mark = (key: string, label: string) => (layout.name === key ? `✓ ${label}` : label);
  /** A view carries unsaved edits → its menu row / closed control get a • dot.
   *  The ACTIVE view is judged by isDirty (authoritative — a stale draft may
   *  linger after a manual revert-to-clean until the next switch clears it);
   *  other views by whether they hold a stashed working copy. */
  const viewHasPending = (name: string) =>
    activeSavedName === name ? isDirty : name in viewDrafts;
  const marketByCoin = useMemo(
    () => new Map((markets ?? []).map((m) => [m.coin, m])),
    [markets],
  );
  // ChartCell's data effect keys on the market prop by REFERENCE — handing a
  // fallback-resolved cell a fresh object on every incidental App re-render
  // (drag, modal toggle, resize) would tear down and re-backfill the whole
  // chart, a REST-weight burst on big walls. Cache one Market per coin so
  // repeated resolves return a stable identity.
  // useRef has no lazy-init form: `useRef(new Map())` builds and discards a
  // Map on every App render, and App re-renders on every stats poll tick.
  // ??= narrows to non-null, so the local reads without a `!` assertion.
  const fallbackCacheRef = useRef<Map<string, Market> | null>(null);
  const fallbackCache = (fallbackCacheRef.current ??= new Map<string, Market>());
  const cachedFallback = (coin: string): Market | null => {
    const cached = fallbackCache.get(coin);
    if (cached) return cached;
    const m = fallbackMarket(coin);
    if (m) fallbackCache.set(coin, m);
    return m;
  };
  // Formula cells (`=…` ids, hl/formula.ts) are never in the catalog: the
  // Market is built from the id itself (parseCanonical needs no catalog) and
  // named through the catalog's name index when one exists. Same
  // reference-identity rule as fallbackCache — one object per coin. An entry
  // is re-derived whenever `markets` changes (names refresh when the catalog
  // lands, a newly listed leg revives a cell) but KEEPS its old object when
  // nothing it shows changed: the catalog is live (hl/catalogSync.ts), and a
  // fresh object per refresh would re-run every formula cell's data effect.
  // While the catalog is still loading the cell shows the loading overlay
  // (null) rather than an id-named chart that would be torn down and
  // re-backfilled the moment names arrive.
  const nameIndex = useMemo(() => (markets ? buildNameIndex(markets) : null), [markets]);
  const formulaCacheRef = useRef<Map<string, { m: Market | null; markets: Market[] | null }> | null>(null);
  const formulaCache = (formulaCacheRef.current ??= new Map());
  const resolveFormula = (coin: string): Market | null => {
    const hit = formulaCache.get(coin);
    if (hit && hit.markets === markets) return hit.m;
    if (!nameIndex && !marketError) return null;
    // isFormulaId is the facade's own gate (≤96 chars, ≤4 legs) — an id that
    // passes only parseCanonical would resolve here and then fail every fetch
    // in formulaFeed, a permanently stuck cell. And the same rule as plain
    // coins: with a CLEANLY loaded catalog a leg that is not in it is
    // delisted/typo'd → empty cell, never an unknown id forwarded to HL
    // (Invariant 11); under a partial or total failure keep charting, exactly
    // like cachedFallback.
    const parsed = isFormulaId(coin) ? parseCanonical(coin) : null;
    const legMissing =
      parsed !== null &&
      catalog !== null &&
      catalog.failed.length === 0 &&
      parsed.legs.some((c) => !marketByCoin.has(c));
    let m: Market | null = null;
    if (parsed && !legMissing) {
      const displayOf = (c: string) => nameIndex?.displayOf(c) ?? c;
      m = {
        coin,
        display: compactText(parsed.ast, displayOf),
        kind: 'formula',
        description: parsed.legs.map((c) => marketByCoin.get(c)?.display ?? c).join(' · '),
        legs: parsed.legs,
      };
      if (hit?.m && sameMarket(hit.m, m)) m = hit.m;
    }
    formulaCache.set(coin, { m, markets });
    return m;
  };
  const resolveCatalogMarket = (coin: string): Market | null => {
    if (coin.startsWith('=')) return resolveFormula(coin);
    const found = marketByCoin.get(coin);
    if (found) return found;
    // Only synthesize when metadata is genuinely missing; a fully-loaded
    // catalog that lacks the coin means it was delisted.
    if (catalog && catalog.failed.length > 0) return cachedFallback(coin);
    // Total catalog failure (after retries exhausted): still chart from the
    // saved coin id rather than rendering the cell as wiped — candleSnapshot
    // and WS only need the coin id, not catalog metadata.
    if (!catalog && marketError) return cachedFallback(coin);
    // A manual retry clears marketError before the catalog resolves, so
    // during that window neither branch above holds. Once a coin has
    // charted via fallback, keep serving it through retry windows — a
    // successful catalog load still takes precedence via the marketByCoin
    // branch above — instead of flipping fallback → null → fallback and
    // tearing down the whole wall.
    if (!catalog && fallbackCache.has(coin)) return cachedFallback(coin);
    return null;
  };
  // STICKY: a coin a catalog CONFIRMED this session keeps its last Market
  // even when a later (live-refreshed) catalog no longer lists it — the same
  // per-session behaviour a catalog loaded once would give. A delisting or a
  // HIP-4 settlement mid-session must not blank a chart someone is watching
  // (nor move the tab title, nor strip an expanded touch cell of its exit);
  // a delisted id's snapshot is `200 []` and its WS subscribe is acked, and
  // a settled HIP-4 id rejected on replay is ws.ts's quarantine's job. Only
  // confirmed Markets are pinned: a raw-id fallback, or a formula built
  // while its legs could not be validated, must still empty the cell once a
  // clean catalog lacks it — that id may be one HL rejects.
  const stickyRef = useRef<Map<string, Market> | null>(null);
  const sticky = (stickyRef.current ??= new Map<string, Market>());
  const resolveMarket = (coin: string | null): Market | null => {
    if (!coin) return null;
    const m = resolveCatalogMarket(coin);
    if (m) {
      const confirmed =
        m.kind === 'formula' ? catalog !== null && catalog.failed.length === 0 : marketByCoin.get(coin) === m;
      if (confirmed) sticky.set(coin, m);
      // a coin confirmed earlier keeps its real name through a later
      // failure-time fallback instead of flipping to its raw id
      return confirmed ? m : (sticky.get(coin) ?? m);
    }
    return sticky.get(coin) ?? null;
  };

  // Badge stats for a cell: catalog coins read the poll directly; a formula
  // composes its legs' last/prevDayPx through the same evaluator the chart
  // uses (hl/compose.ts composeStats), everything else null — funding, OI,
  // volume and market cap have no meaning for an expression. ChartCell reads
  // marketStats at render only (never in an effect's deps), so a fresh
  // object per render is fine.
  const formulaFns = useMemo(() => new Map<string, ((vec: number[]) => number) | null>(), []);
  const statsFor = (coin: string | null): MarketStats | null => {
    if (!coin || !stats) return null;
    if (!coin.startsWith('=')) return stats.get(coin) ?? null;
    const legs = resolveMarket(coin)?.legs;
    if (!legs) return null;
    let f = formulaFns.get(coin);
    if (f === undefined) {
      const parsed = parseCanonical(coin);
      f = parsed ? compile(parsed.ast, parsed.legs) : null;
      formulaFns.set(coin, f);
    }
    if (!f) return null;
    const legStats: MarketStats[] = [];
    for (const leg of legs) {
      const s = stats.get(leg);
      if (!s) return null;
      legStats.push(s);
    }
    const composed = composeStats(f, legStats);
    return composed
      ? {
          last: composed.last,
          prevDayPx: composed.prevDayPx,
          funding1h: null,
          volumeUsd: null,
          openInterestUsd: null,
          marketCapUsd: null,
          maxLeverage: null,
          // which leg moved: each leg's own 24h change, labelled as the header does
          legs: legs.map((leg, i) => {
            const s = legStats[i]!;
            const chgPct =
              s.last != null && s.prevDayPx != null && s.prevDayPx !== 0
                ? ((s.last - s.prevDayPx) / s.prevDayPx) * 100
                : null;
            return { label: nameIndex?.displayOf(leg) ?? leg, chgPct };
          }),
        }
      : null;
  };

  const cols = layout.cols;
  /** The wall's first cell whose coin RESOLVES drives the tab title
   *  (top-left in reading order; an empty or unresolvable cell 0 hands it
   *  to the next one instead of blanking the title). */
  const titleCellIdx = layout.cells
    .slice(0, layout.count)
    .findIndex((c) => resolveMarket(c.coin) !== null);
  const rows = Math.max(1, Math.ceil(layout.count / cols));
  const effCols = isNarrow ? Math.min(mobileCols, layout.count) : cols;

  /** All user edits flow through here. */
  const editLayout = (updater: (prev: Layout) => Layout) => {
    const wasShared = viewingSharedRef.current;
    viewingSharedRef.current = false;
    wcModeRef.current = false;
    setWcPending(false); // a real edit cancels any still-pending #wc
    setPoswallPending(null); // …and any still-pending deferred poswall build
    setLayout((prev) => {
      const next = updater(prev);
      // Editing a SHARED wall detaches its embedded name to unnamed scratch —
      // a colliding name must not hijack a local view. Save it as a new view
      // with the one-tap "+".
      if (wasShared && next.name?.startsWith('saved:')) {
        return { ...next, name: null };
      }
      return next;
    });
  };

  const updateCell = (index: number, patch: Partial<CellState>) => {
    editLayout((prev) => ({
      ...prev,
      // coin changes detach PRESET names (the template diverged); a saved
      // view keeps its name and just goes dirty until you Save
      name: 'coin' in patch && !prev.name?.startsWith('saved:') ? null : prev.name,
      cells: prev.cells.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  };

  // Topbar controls that relocate into the ⋯ menu on narrow screens — each
  // defined once and rendered from whichever spot is visible (wide bar or
  // the overflow popover), so there is exactly one source of truth per control.
  const xhToggle = (
    <button
      className={`preset-btn xh-toggle${linkedCursor ? ' active' : ''}`}
      onClick={() => setLinkedCursor((v) => !v)}
      title={t('xh_title')}
      aria-label={t('xh_title')}
      aria-pressed={linkedCursor}
    >
      ⌖
    </button>
  );
  const wallsSelect = (
    <select
      className={`wall-presets${wallLabel ? ' named' : ''}`}
      value=""
      onChange={(e) => {
        if (e.target.value) onWallsSelect(e.target.value);
      }}
      title={t('walls_title')}
      aria-label={t('walls_title')}
    >
      {/* the closed control shows WHERE you are (• = unsaved edits;
          ⚠ = sync uploads bouncing — the passive signal, since the menu
          may stay closed for hours while edits silently fail to sync) */}
      <option value="" disabled>
        {`${syncCode && syncHealth === 'rejected' ? '⚠ ' : ''}${
          wallLabel != null ? `${wallLabel}${isDirty ? ' •' : ''}` : t('walls_ph')
        }`}
      </option>
      <optgroup label={t('grp_presets')}>
        {WALL_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {mark(p.key, t(p.labelKey))}
          </option>
        ))}
        <option value="top-volume" disabled={!stats}>
          {mark('top-volume', t('preset_topvol'))}
        </option>
      </optgroup>
      {/* LIVE positions walls — their own category between presets and saved
          views (a saved view is fixed; these rebuild from current holdings
          on every application). One entry per book address. */}
      {watchBookNonEmpty && (
        <optgroup label={t('grp_positions')}>
          {getWatchBook().map((e) => (
            <option key={e.addr} value={`poswall:${e.addr}`}>
              {mark(`poswall:${e.addr}`, e.name || `${e.addr.slice(0, 6)}…${e.addr.slice(-4)}`)}
            </option>
          ))}
          <option value="__posview">{t('menu_posview')}</option>
        </optgroup>
      )}
      <optgroup label={t('grp_saved')}>
        {/* one-tap create: auto-named 'View N' from the current wall */}
        <option value="__addview">{t('add_view')}</option>
        {draft !== null && <option value="__draft">{t('draft_label')}</option>}
        {liveWalls.map((w) => (
          <option key={w.name} value={`saved:${w.name}`}>
            {`${mark(`saved:${w.name}`, w.name)}${viewHasPending(w.name) ? ' •' : ''}`}
          </option>
        ))}
      </optgroup>
      <optgroup label={t('grp_manage')}>
        {isDirty && <option value="__discard">{t('discard')}</option>}
        {liveWalls.length > 0 && <option value="__delete">{t('manage_saved')}</option>}
        <option value="__sync">
          {syncCode && syncHealth === 'rejected' ? `⚠ ${t('sync_menu')}` : t('sync_menu')}
        </option>
        <option value="__watch">{watchAddr ? `👁 ${t('watch_menu')}` : t('watch_menu')}</option>
      </optgroup>
    </select>
  );
  const tzSelect = (
    <select
      className="tz-select"
      value={tz}
      onChange={(e) => changeTz(e.target.value)}
      title={t('tz_title')}
      aria-label={t('tz_title')}
    >
      <option value="local">({utcLabel(tzToOffsetSec('local'))}) {t('tz_local')}</option>
      <option value="utc">(UTC+0) UTC</option>
      {tzZones.map((z) => (
        <option key={z.id} value={z.id}>
          ({utcLabel(z.off)}) {z.city}
        </option>
      ))}
    </select>
  );
  const langButton = (
    <button className="share-btn" onClick={toggleLang} title="EN / 中文">
      {lang === 'en' ? <span lang="zh">中文</span> : 'EN'}
    </button>
  );

  return (
    <LangContext.Provider value={lang}>
    <div className="app">
      {!isMini && (
      /* has-pill: a transient ✓ save / ↻ update pill is in the row — CSS
         sheds the decorative items (market count, data/charts label words)
         so the pill, the clock and the TradingView attribution coexist (the
         clock steps out only for the ↻ pill, below the clockRoomUpd* gates). */
      <header
        className={`topbar v-${view}${updateReady || (isDirty && view === 'wall') ? ' has-pill' : ''}`}
      >
        <span className="brand">
          PURR<span className="brand-accent">WALL</span>
        </span>
        {/* The realtime badge: "● LIVE" in the top-right corner — the
            broadcast idiom, so it reads as Purrwall's own live-feed signal.
            Absolutely positioned in the topbar's corner padding: ZERO row
            width at the measured-to-zero-slack tiers. Healthy =
            green radar-ping + label; connecting/reconnecting = amber pulse,
            dot only; market data failed = red steady, dot only (the tooltip
            names the state in every case). One badge is the honest signal
            for every surface at once — wall candles, list mids and watch
            state all ride ONE socket. */}
        {(() => {
          const state = marketError
            ? 'err'
            : !markets || wsStatus !== 'live'
              ? 'warn'
              : 'ok';
          const label =
            state === 'err'
              ? t('offline')
              : !markets
                ? t('loading_markets')
                : wsStatus !== 'live'
                  ? t('reconnecting')
                  : t('live_ok');
          return (
            <span
              className={`live-badge${state === 'ok' ? '' : ` ${state}`}`}
              role="img"
              title={label}
              aria-label={label}
            >
              <span className="live-dot" />
              {state === 'ok' && <span className="live-word">{t('live_badge')}</span>}
            </span>
          );
        })()}
        <div className="view-toggle" title={t('view_title')}>
          <button
            className={`preset-btn${view === 'wall' ? ' active' : ''}`}
            onClick={toWall}
          >
            {t('view_wall')}
          </button>
          <button
            className={`preset-btn${view === 'list' ? ' active' : ''}`}
            onClick={toList}
          >
            {t('view_list')}
          </button>
          {/* third tab only once an address book exists — regular users pay
              zero width for it. Width-gated in CSS (pos-tab) where the
              measured topbar tiers demand it; the walls-menu __posview entry
              is the always-available route. */}
          {watchBookNonEmpty && (
            <button
              className={`preset-btn pos-tab${view === 'positions' ? ' active' : ''}`}
              onClick={toPositions}
            >
              {t('view_pos')}
            </button>
          )}
        </div>
        {view === 'wall' && (
        <div className="grid-btn-wrap" ref={gridWrapRef}>
          <button
            className={`share-btn${gridOpen ? ' done' : ''}`}
            onClick={() => setGridOpen((o) => !o)}
            title={t('grid_title')}
            aria-label={t('grid_title')}
            aria-expanded={gridOpen}
          >
            {/* phones say the truth — count, not a desktop shape; the ⊞
                glyph keeps the label narrow in both languages (the full
                words live in the panel + the title tooltip) */}
            {isNarrow ? `⊞ ${layout.count}` : `${cols}×${rows}`} ▾
          </button>
          {gridOpen && !isNarrow && (
            <div className="grid-pop" onMouseLeave={() => setGridHover(null)}>
              <div
                className="grid-pop-matrix"
                style={{ gridTemplateColumns: `repeat(${MAX_COLS}, 18px)` }}
              >
                {Array.from({ length: MAX_ROWS * MAX_COLS }, (_, i) => {
                  const r = Math.floor(i / MAX_COLS) + 1;
                  const c = (i % MAX_COLS) + 1;
                  const active = gridHover
                    ? r <= gridHover.r && c <= gridHover.c
                    : r <= rows && c <= cols;
                  const chooseGrid = () => {
                    // charts keep their (row,col) — see resizeGrid
                    editLayout((prev) => ({
                      ...prev,
                      // resizing a saved view stays ON it (goes dirty)
                      name: prev.name?.startsWith('saved:') ? prev.name : null,
                      cols: c,
                      count: r * c,
                      cells: resizeGrid(prev.cells, prev.count, prev.cols, c, r),
                    }));
                    // reshape = a fresh look; the pre-reshape linked
                    // window would re-pin re-framed cells on the next heal
                    clearRangeWindow();
                    setGridOpen(false);
                    setGridHover(null);
                  };
                  return (
                    <div
                      key={i}
                      className={`grid-pop-cell${active ? ' on' : ''}`}
                      // keyboard-operable: this matrix is the ONLY way to
                      // SHRINK a desktop wall (ghost + only grows), so a
                      // role=button that Tab skipped would lock keyboard users
                      // out of it entirely.
                      role="button"
                      tabIndex={0}
                      aria-label={`${c}×${r}`}
                      onMouseEnter={() => setGridHover({ r, c })}
                      onFocus={() => setGridHover({ r, c })}
                      onClick={chooseGrid}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          chooseGrid();
                        }
                      }}
                    />
                  );
                })}
              </div>
              <div className="grid-pop-label">
                {gridHover ? `${gridHover.c} × ${gridHover.r}` : `${cols} × ${rows}`}
              </div>
            </div>
          )}
          {gridOpen && isNarrow && (
            // Phone panel: count × columns + a live phone-shaped preview —
            // the desktop shape matrix is meaningless on a scroll strip.
            // Chips keep the panel OPEN so fiddling gives instant preview
            // feedback; outside tap closes (existing gridOpen outside-click
            // handler).
            <div className="grid-pop grid-pop-mobile">
              <div className="gpm-controls">
                <span className="grid-pop-cols-label">{t('mob_count')}</span>
                <div className="gpm-chips">
                  {MOBILE_COUNTS.map((n) => (
                    <button
                      key={n}
                      className={`preset-btn${layout.count === n ? ' active' : ''}`}
                      onClick={() => {
                        editLayout((prev) => ({
                          ...prev,
                          name: prev.name?.startsWith('saved:') ? prev.name : null,
                          // count-only: cols stays (desktop keeps its shape),
                          // no resizeGrid (order unchanged), and the linked
                          // window is KEPT — new cells join it via
                          // reapplyRange instead of resetting everyone
                          count: n,
                        }));
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span className="grid-pop-cols-label">{t('mob_cols')}</span>
                <div className="gpm-chips">
                  {([1, 2, 3] as const).map((n) => (
                    <button
                      key={n}
                      className={`preset-btn${mobileCols === n ? ' active' : ''}`}
                      onClick={() => setMobileCols(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div className="gpm-phone">
                <div
                  className="gpm-grid"
                  style={{ gridTemplateColumns: `repeat(${mobileCols}, 1fr)` }}
                >
                  {Array.from({ length: layout.count }, (_, k) => (
                    <div
                      key={k}
                      className="gpm-cell"
                      style={{ height: mobileCols === 1 ? 30 : mobileCols === 2 ? 22 : 16 }}
                    />
                  ))}
                </div>
                <div className="gpm-fade" />
              </div>
              <div className="grid-pop-label gpm-sum">
                {`${layout.count} ${t('u_charts')} · ${mobileCols} ${t('u_cols')} · ${Math.ceil(
                  layout.count / mobileCols,
                )} ${t('u_rows')}`}
              </div>
            </div>
          )}
        </div>
        )}
        {isCondensed && (
          <div className="grid-btn-wrap" ref={moreWrapRef}>
            <button
              className={`share-btn${moreOpen ? ' done' : ''}`}
              onClick={() => setMoreOpen((o) => !o)}
              title={t('more_title')}
              aria-label={t('more_title')}
              aria-expanded={moreOpen}
            >
              ⋯
              {/* tight widths fold docs in here — its unread dot rides along */}
              {isTight && wnUnseen && <span className="unread-dot" />}
            </button>
            {moreOpen && (
              <div className="more-pop">
                {isTight && (
                  <button
                    className="share-btn docs-btn"
                    onClick={() => {
                      setMoreOpen(false);
                      openDocs();
                    }}
                  >
                    {t('docs')}
                    {wnUnseen && <span className="unread-dot" />}
                  </button>
                )}
                <button
                  className="share-btn"
                  onClick={() => {
                    setMoreOpen(false);
                    setFeedbackOpen(true);
                  }}
                >
                  {t('feedback')}
                </button>
                {/* narrow carries ⌖ on topbar row 2 instead — the wall
                    link is a first-class mobile control, not overflow */}
                {view === 'wall' && !isNarrow && xhToggle}
                {view === 'wall' && wallsSelect}
                {view === 'wall' && IS_COARSE && layout.count > 1 && (
                  <button
                    className="share-btn"
                    onClick={() => {
                      setMoreOpen(false);
                      enterArrange(null);
                    }}
                  >
                    {t('arr_menu')}
                  </button>
                )}
                {view === 'wall' && tzSelect}
                {langButton}
              </div>
            )}
          </div>
        )}
        {view === 'wall' && (
        <div className="grid-presets" title={t('iv_title')}>
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              className={`preset-btn${allOnInterval(iv) ? ' active' : ''}`}
              onClick={() => setAllIntervals(iv)}
            >
              {iv}
            </button>
          ))}
        </div>
        )}
        {/* narrow topbar row 2: ⌖ beside the presets (order 3 follows DOM
            order here; attribution-nw's order 4 + auto margin stays right) */}
        {isNarrow && view === 'wall' && xhToggle}
        {!isCondensed && (
          <>
            {view === 'wall' && xhToggle}
            {view === 'wall' && wallsSelect}
            {view === 'wall' && tzSelect}
            {langButton}
          </>
        )}
        {/* appear only with unsaved edits to a saved view: ↺ puts the wall
            back to its saved version, ✓ commits the edits — both one click
            away, not only in the walls menu. The pair shares the ✓ pill's
            slot and its .has-pill decoration shed; below 1650px the word
            "save" yields, and on the 641–900 tier ↺ itself (App.css), so the
            pair never costs more than the width budgeted for one pill. */}
        {isDirty && view === 'wall' && (
          <>
            <button
              className="share-btn discard-view"
              onClick={discardChanges}
              title={t('discard_view_t')}
              aria-label={t('discard_view_t')}
            >
              ↺
            </button>
            <button className="share-btn save-view" onClick={saveCurrentView} title={t('save_view_t')}>
              ✓ <span className="save-word">{t('save_view')}</span>
            </button>
          </>
        )}
        {updateReady && (
          <button
            className="share-btn update-pill"
            onClick={() => window.location.reload()}
            title={t('upd_title')}
          >
            ↻ {t('upd_new')}
          </button>
        )}
        {!isTight && (
          <button className="share-btn docs-btn" onClick={openDocs}>
            {t('docs')}
            {wnUnseen && <span className="unread-dot" />}
          </button>
        )}
        {/* Same visibility rule as docs: a text button on wide topbars, and
            the ⋯ menu carries it once the row gets tight. Feedback is
            occasional, so it earns a topbar slot but not a permanent one on a
            bar that would have to clip the attribution to keep it. */}
        {!isTight && (
          <button
            className="share-btn"
            onClick={() => {
              setFeedbackOpen(true);
            }}
          >
            {t('feedback')}
          </button>
        )}
        <div className="grid-btn-wrap" ref={shareWrapRef}>
          <button
            className={`share-btn${copied ? ' done' : ''}`}
            // fine pointers: this button discloses the share/QR popover; touch
            // uses the native sheet (no popover), so expose expanded only on
            // fine pointers
            aria-expanded={IS_COARSE ? undefined : shareOpen}
            onClick={() => {
              if (IS_COARSE) {
                share(); // phones: native share sheet, no popover
                return;
              }
              // closing the popover via the button is a dismiss gesture —
              // it must not copy the link again
              if (!shareOpen) {
                share();
                // lazy chunk: the QR encoder stays out of the initial bundle
                import('./lib/qr').then(
                  (m) => setShareQr(m.qrSvgPath(window.location.href)),
                  () => setShareQr(null), // chunk failed (offline?) — copy still worked
                );
              }
              setShareOpen(!shareOpen);
            }}
          >
            {copied ? t('copied') : t('share')}
          </button>
          {shareOpen && (
            <div className="share-pop">
              {shareQr && (
                <svg
                  className="share-qr"
                  viewBox={`-4 -4 ${shareQr.size + 8} ${shareQr.size + 8}`}
                  shapeRendering="crispEdges"
                  role="img"
                  aria-label="QR"
                >
                  <rect
                    x={-4}
                    y={-4}
                    width={shareQr.size + 8}
                    height={shareQr.size + 8}
                    fill="#ffffff"
                  />
                  <path d={shareQr.d} fill="#000000" />
                </svg>
              )}
              <p className="pop-note">{t('share_scan')}</p>
            </div>
          )}
        </div>
        <div className="topbar-break" />
        <div className="topbar-spacer" />
        {/* Clock in the chart-axis timezone, for timing macro events against
            the wall. Width gates, the list-row rule and the has-pill shed
            rule are documented at the clockRoom* hooks; the suffix renders
            only where the tz dropdown is NOT on the row to name the zone
            itself (condensed rows and the list view). */}
        {(isCondensed || view !== 'wall' ? clockRoomCondensed : clockRoomFull) &&
          !(
            updateReady &&
            view === 'wall' &&
            (isCondensed ? !clockRoomUpdCondensed : !clockRoomUpdFull)
          ) && (
          <Clock
            tz={tz}
            suffix={
              (isCondensed || view !== 'wall') && tz !== 'local'
                ? tz === 'utc'
                  ? 'UTC'
                  : utcLabel(tzOffsetSec)
                : undefined
            }
            title={t('clock_title')}
          />
        )}
        <span className="topbar-info">
          {markets
            ? wsStatus !== 'live'
              ? t('reconnecting')
              : `${markets.length} ${t('markets_n')}`
            : marketError
              ? t('offline')
              : t('loading_markets')}
        </span>
        {!isTight && (
          <span className="attribution">
            {/* Invariant 8: the TradingView link is a license requirement.
                On TIGHT topbars (≤900px) this block is replaced by the
                compact attribution-nw link below so wall cells can drop the
                per-chart canvas logo — sixteen logos would overwhelm
                phone-sized cells. Canvas logos remain only where NO topbar
                link is visible: ?mini=1 windows and fixed fullscreen
                overlays (expanded cell, list chart card) — see the
                attributionLogo prop at the grid. */}
            {/* attr-hl wraps the non-license half so the has-pill shed
                (App.css) can degrade this block to its ≤900px compact form —
                TradingView-only — while a transient pill squeezes the row.
                Hyperliquid credit also appears in the docs' Data section. */}
            <span className="attr-hl">
              <span className="attr-label">{t('lbl_data')}{' '}</span>
              <a href="https://app.hyperliquid.xyz" target="_blank" rel="noreferrer">
                Hyperliquid
              </a>
              {' · '}
            </span>
            <span className="attr-label">{t('lbl_charts')}{' '}</span>
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
              TradingView
            </a>
          </span>
        )}
        {isTight && (
          // Invariant 8: the ONLY TradingView attribution on tight topbars —
          // rides topbar row 2 on narrow walls, and the right edge of the
          // single row between 641 and 900px (order/margin in App.css), always
          // visible because .grid, not the page, is the scroll container.
          // Removing it re-obligates the per-chart canvas logos.
          <a
            className="attribution attribution-nw"
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noreferrer"
          >
            TradingView
          </a>
        )}
      </header>
      )}

      {marketError && (
        <div className="banner">
          {t('banner_failed')} {marketError}{' '}
          <button className="retry-btn" onClick={() => setMarketRetry((r) => r + 1)}>
            {t('retry')}
          </button>
        </div>
      )}
      {!isMini && showHint && view === 'wall' && (
        <div className="hint-bar">
          {isNarrow ? (
            <span>{t('hint_short')}</span>
          ) : lang === 'zh' ? (
            <span>
              第一次来？点击任意<b>市场名 ▾</b>，即可从 {markets ? markets.length : '700+'} 个
              Hyperliquid 市场中任选——永续 · 现货 · 股票 · 预测市场。拖动标题栏换位，<b>⧉</b>
              弹出独立窗口，<b>{wallLabel ?? t('walls_ph')}</b>菜单一键换预设墙。
            </span>
          ) : (
            <span>
              New here? Click any <b>market name ▾</b> to swap in any of{' '}
              {markets ? markets.length : '700+'} Hyperliquid markets — perps · spot · stocks ·
              prediction markets. Drag a header to rearrange, <b>⧉</b> pops a chart out, the{' '}
              <b>{wallLabel ?? t('walls_ph')}</b> menu has one-click presets.
            </span>
          )}
          <button className="hint-close" onClick={dismissHint} title="×" aria-label={t('k_close')}>
            ×
          </button>
        </div>
      )}

      {catalog && catalog.failed.length > 0 && (
        <div className="banner warn">
          {catalog.failed.join(', ')} {t('meta_failed')}{' '}
          <button className="retry-btn" onClick={() => setMarketRetry((r) => r + 1)}>
            {t('retry')}
          </button>
        </div>
      )}

      {/* The wall stays MOUNTED under the list view (display:none): charts
          quiesce (autoSize collapses to 0×0, no paint) while their WS subs
          stay warm, so list↔wall switches are instant and cost zero REST —
          an unmount would re-backfill every cell (~30 weight each) per
          toggle. */}
      {isNarrow && (
        <div className="ptr-ind" ref={ptrIndRef} aria-hidden="true">
          🐾
        </div>
      )}
      <main
        ref={gridRef}
        className={`grid${view !== 'wall' ? ' view-hidden' : ''}${
          liftFrom !== null ? ' lifting' : ''
        }`}
        style={
          isNarrow
            ? {
                gridTemplateColumns: `repeat(${effCols}, 1fr)`,
                gridAutoRows: 'max(260px, 40dvh)',
              }
            : {
                gridTemplateColumns: `repeat(${effCols}, 1fr)`,
                gridTemplateRows: `repeat(${Math.max(1, Math.ceil(layout.count / effCols))}, 1fr)`,
              }
        }
      >
        {layout.cells.slice(0, layout.count).map((cell, i) => (
          <div
            key={i}
            ref={(el) => {
              slotRefs.current[i] = el;
            }}
            data-slot={i}
            className={`cell-slot${
              (dropTarget === i && dragFrom !== i) ||
              (arrange && arrangeFrom === i) ||
              liftTarget === i
                ? ' drop-target'
                : ''
            }${dragFrom === i ? ' dragging' : ''}${
              liftFrom === i ? ' drag-lift' : ''
            }${expandedCell === i ? ' expanded' : ''}${
              expandedCell === i && pageTargets.length > 1 ? ' pager' : ''
            }`}
            onDragOver={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dragFrom !== i) setDropTarget(i);
            }}
            onDragLeave={() => setDropTarget((t) => (t === i ? null : t))}
            onDrop={(e) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData('text/plain'));
              if (Number.isInteger(from) && from >= 0 && from < layout.count && from !== i) {
                swapCells(from, i);
              }
              setDropTarget(null);
              setDragFrom(null);
            }}
          >
            <CellErrorBoundary>
              <ChartCell
                market={resolveMarket(cell.coin)}
                interval={cell.interval}
                marketStats={statsFor(cell.coin)}
                catalogPending={!catalog && !marketError && cell.coin !== null}
                stale={wsStatus !== 'live'}
                cellIndex={i}
                // Invariant 8: the TradingView canvas logo rides wherever
                // no topbar link is visible — mini (no topbar) and an
                // EXPANDED cell (its fixed overlay occludes the topbar at
                // every width). Plain wall cells never show it: topbars
                // above 900px carry the attribution block, tight ones the
                // compact attribution-nw link (per-cell canvas logos would
                // overwhelm phone-sized cells). Flips land via ChartCell's
                // applyOptions effect.
                attributionLogo={isMini || expandedCell === i}
                // visibility gating: cells under another cell's fullscreen
                // overlay pause paints (IO can't see occlusion); flush on
                // collapse
                paused={expandedCell !== null && expandedCell !== i}
                // tab title: the expanded cell is THE market on screen; otherwise
                // the wall's first market (top-left) — see lib/pageTitle.ts.
                // Kept under the list/positions views too: the cell publishes
                // straight from its WS callback (before the hidden-cell tick
                // bank), so the number stays live while the wall is hidden.
                // (`view === 'wall'` on focus: a forward-navigation into
                // #list/#pos keeps expandedCell set under the hidden wall,
                // and a hidden cell must never outrank the list card)
                titleSlot={
                  view === 'wall' && expandedCell === i
                    ? 'focus'
                    : i === titleCellIdx
                      ? 'wall'
                      : undefined
                }
                tzOffsetSec={tzOffsetSec}
                onIntervalChange={(interval) => updateCell(i, { interval })}
                onPickMarket={() => {
                  setPickerFor(i);
                }}
                onClear={() => {
                  updateCell(i, { coin: null });
                  // Clearing an expanded cell must also collapse the overlay —
                  // otherwise the fullscreen fixed-position node is left
                  // showing an empty cell with no way to see the rest of the wall.
                  setExpandedCell((cur) => (cur === i ? null : cur));
                }}
                onPopOut={() => popOutCell(cell)}
                onDragStart={() => setDragFrom(i)}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDropTarget(null);
                }}
                onArrange={
                  !isMini && layout.count > 1 ? () => enterArrange(i) : undefined
                }
                onLift={
                  !isMini && layout.count > 1
                    ? (x, y, pointerId) => startCellLift(i, x, y, pointerId)
                    : undefined
                }
                expanded={expandedCell === i}
                onToggleExpand={() => setExpandedCell((cur) => (cur === i ? null : i))}
                onPage={expandedCell === i && pageTargets.length > 1 ? pageExpanded : undefined}
              />
            </CellErrorBoundary>
            {arrange && (
              <button
                className="arrange-target"
                aria-label={t('arr_hint')}
                onClick={() => onArrangeTap(i)}
              />
            )}
            {expandedCell === i && pageTargets.length > 1 && (
              <>
                <button
                  className="pager-btn prev"
                  onClick={() => pageExpanded(-1)}
                  title={t('t_prev_chart')}
                  aria-label={t('t_prev_chart')}
                >
                  ‹
                </button>
                <button
                  className="pager-btn next"
                  onClick={() => pageExpanded(1)}
                  title={t('t_next_chart')}
                  aria-label={t('t_next_chart')}
                >
                  ›
                </button>
                <div className="pager-chips" ref={chipsRef}>
                  {pageTargets.map((p) => {
                    const m = resolveMarket(p.coin);
                    // base name only — "BTC", not "BTC-USDC": chips are a
                    // scanning surface, the header carries the full identity.
                    // Strip ONLY the constructed quote (spot is `base/quote`,
                    // perp/hip3 append `-USDC`): a generic first-hyphen split
                    // would mislabel hyphenated bases — spot "ANSEM-19/USDC"
                    // must never read as the different live token "ANSEM".
                    // HIP-4 free text keeps its ellipsis.
                    const label =
                      m === null
                        ? p.coin
                        : m.kind === 'hip4'
                          ? m.display
                          : m.kind === 'spot'
                            ? m.display.split('/')[0]
                            : m.display.replace(/-USDC$/, '');
                    return (
                      <button
                        key={p.i}
                        className={`pager-chip${p.i === i ? ' active' : ''}`}
                        onClick={() => setExpandedCell(p.i)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        ))}
        {/* Non-rectangular counts (phone count chips, list add-to-wall,
            #wc walls) leave empty slots in the desktop grid's last
            row — render them as ghost "+" tiles: one tap grows the wall
            by one and opens the picker for the new cell (if that slot
            held a chart before the count shrank, it simply returns).
            Desktop only: the narrow strip has no fixed slots. */}
        {view === 'wall' && !isNarrow && !isMini && expandedCell === null &&
          layout.count < MAX_CELLS &&
          Array.from({ length: cols * rows - layout.count }, (_, k) => (
            <button
              key={`ghost-${k}`}
              className="cell-ghost"
              title={t('ghost_add')}
              aria-label={t('ghost_add')}
              onClick={(e) => {
                // double-click's 2nd press would land on the just-opened
                // picker's backdrop and instantly dismiss it
                if (e.detail > 1) return;
                const newIndex = layout.count;
                editLayout((prev) => ({
                  ...prev,
                  name: prev.name?.startsWith('saved:') ? prev.name : null,
                  count: Math.min(prev.count + 1, MAX_CELLS),
                }));
                setPickerFor(newIndex);
              }}
            >
              +
            </button>
          ))}
      </main>

      {!isMini && view === 'positions' && (
        <PositionsView
          markets={markets}
          stats={stats}
          tzOffsetSec={tzOffsetSec}
          onCreateWall={() => watchAddr && applyPositionsWall(watchAddr)}
        />
      )}

      {!isMini && view === 'list' && (
        <ListView
          markets={markets}
          outcomeQuestions={catalog?.outcomeQuestions ?? []}
          stats={stats}
          marketError={marketError}
          onRetry={() => setMarketRetry((r) => r + 1)}
          stale={wsStatus !== 'live'}
          tzOffsetSec={tzOffsetSec}
          onAddToWall={addToWall}
          onPopOut={popOutCell}
        />
      )}

      {arrange && (
        <div className="arrange-bar">
          <span>{t('arr_hint')}</span>
          <button className="share-btn" onClick={exitArrange}>
            {t('arr_done')}
          </button>
        </div>
      )}

      {/* mutually exclusive with the views-full toast AND the alert toasts —
          same screen corner (an alert firing outranks release notes) */}
      {!isMini && wnUnseen && !wnToastGone && !showHint && !viewsFullToast &&
        alertToasts.length === 0 && (
        <button className="wn-toast" onClick={openDocs}>
          {t('wn_new')}{CHANGELOG[0][lang].title} →
          {/* aria-hidden: same ARIA constraint as pk-star — a role=button
              inside the toast <button> would be pruned yet fold "Close" into
              the toast's accessible name. The whole toast is dismissible by
              activation; this × is a pointer shortcut. */}
          <span
            className="wn-toast-x"
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              setWnToastGone(true);
            }}
          >
            ×
          </span>
        </button>
      )}

      {viewsFullToast && alertToasts.length === 0 && (
        <button className="wn-toast warn" onClick={() => setViewsFullToast(false)}>
          {t('views_full')}
        </button>
      )}

      {alertToasts.length > 0 && (
        <div className="alert-toasts">
          {alertToasts.map((a) => (
            <button
              key={a.key}
              className={`alert-toast ${a.dir}`}
              onClick={() => setAlertToasts((ts) => ts.filter((x) => x.key !== a.key))}
            >
              <span className="alert-toast-dir" aria-hidden="true">
                {a.dir === 'up' ? '↑' : '↓'}
              </span>
              {a.label} {t(a.dir === 'up' ? 'alert_above' : 'alert_below')} {a.priceText}
            </button>
          ))}
        </div>
      )}

      {wallsMgr && (
        <div
          className="picker-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setWallsMgr(null);
          }}
        >
          <div
            className="walls-mgr"
            ref={wallsMgrRef}
            role="dialog"
            aria-modal="true"
            aria-label={t(
              wallsMgr === 'sync' ? 'sync_title' : wallsMgr === 'watch' ? 'watch_title' : 'wm_manage_title',
            )}
            tabIndex={-1}
          >
            {wallsMgr === 'sync' ? (
              <>
                <div className="wm-title">{t('sync_title')}</div>
                {syncCode ? (
                  <>
                    <div className="sync-code">{syncCode}</div>
                    <p className="wm-note">{t('sync_on_hint')}</p>
                    {syncHealth === 'rejected' && (
                      <p className="wm-note sync-err">{t('sync_bad')}</p>
                    )}
                    <button
                      className="share-btn"
                      onClick={() => {
                        storeSyncCode(null);
                        setSyncCodeState(null);
                      }}
                    >
                      {t('sync_off')}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="wm-note">{t('sync_hint')}</p>
                    <button
                      className="share-btn"
                      onClick={async () => {
                        setSyncErr(null);
                        try {
                          const code = await createSync(savedWalls as SyncedWall[], getWatchStamp());
                          setSyncCodeState(code);
                        } catch (err) {
                          // 'too-large' = the server refused the doc itself;
                          // "try again" would lie — the library must shrink
                          setSyncErr(
                            (err as Error).message === 'too-large' ? 'toobig' : 'network',
                          );
                        }
                      }}
                    >
                      {t('sync_create')}
                    </button>
                    <div className="wm-sep" />
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const code = syncInput.trim().toUpperCase();
                        if (!/^[A-Z2-7]{8}$/.test(code)) {
                          setSyncErr('format');
                          return;
                        }
                        setSyncErr(null);
                        try {
                          const merged = await joinSync(code, savedWalls as SyncedWall[], getWatchStamp());
                          applySynced(merged.walls);
                          applyWatchSync(merged.watch);
                          setSyncCodeState(code);
                          setSyncInput('');
                        } catch (err) {
                          setSyncErr((err as Error).message === 'not-found' ? 'notfound' : 'network');
                        }
                      }}
                    >
                      <input
                        className="wm-input"
                        value={syncInput}
                        onChange={(e) => setSyncInput(e.target.value.toUpperCase())}
                        placeholder={t('sync_join_ph')}
                        maxLength={8}
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                      <button className="share-btn" type="submit">
                        {t('sync_join')}
                      </button>
                    </form>
                    {syncErr && (
                      <p className="wm-note sync-err">
                        {t(
                          syncErr === 'notfound'
                            ? 'sync_err_notfound'
                            : syncErr === 'format'
                              ? 'sync_err_format'
                              : syncErr === 'toobig'
                                ? 'sync_err_big'
                                : 'sync_err_net',
                        )}
                      </p>
                    )}
                  </>
                )}
              </>
            ) : wallsMgr === 'watch' ? (
              <>
                <div className="wm-title">{t('watch_title')}</div>
                {watchAddr ? (
                  <>
                    <div className="watch-addr">{watchAddr}</div>
                    <p className="wm-note">{t('watch_on_hint')}</p>
                    <WatchAccountPanel
                      onCreateWall={() => watchAddr && applyPositionsWall(watchAddr)}
                    />
                    <div className="wm-sep" />
                    {/* the chart overlay: master switch + which wallets to draw */}
                    <label className="wm-check wm-check-master">
                      <input
                        type="checkbox"
                        checked={getOverlayOn()}
                        onChange={(e) => setOverlayOn(e.target.checked)}
                      />
                      {t('ov_master')}
                    </label>
                    {getOverlayOn() &&
                      getWatchBook().map((e) => (
                        <label key={e.addr} className="wm-check">
                          <input
                            type="checkbox"
                            checked={e.show}
                            onChange={(ev) => setEntryShow(e.addr, ev.target.checked)}
                          />
                          {e.name || `${e.addr.slice(0, 6)}…${e.addr.slice(-4)}`}
                        </label>
                      ))}
                    <div className="wm-sep" />
                    <button className="share-btn" onClick={() => setActiveWatch(null)}>
                      {t('watch_off')}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="wm-note">{t('watch_hint')}</p>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const r = upsertWatch(watchInput.trim());
                        if (r !== 'ok') {
                          setWatchErr(r);
                          return;
                        }
                        setWatchErr(null);
                        setWatchInput('');
                      }}
                    >
                      <input
                        className="wm-input"
                        value={watchInput}
                        onChange={(e) => setWatchInput(e.target.value)}
                        placeholder={t('watch_addr_ph')}
                        maxLength={42}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                      <button className="share-btn" type="submit">
                        {t('watch_set')}
                      </button>
                    </form>
                    {watchErr && (
                      <p className="wm-note sync-err">
                        {t(watchErr === 'full' ? 'pv_full' : 'watch_err_format')}
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <div className="wm-title">{t('wm_manage_title')}</div>
                {liveWalls.length === 0 && <div className="wm-none">{t('wm_none')}</div>}
                {liveWalls.map((w) =>
                  renaming === w.name ? (
                    <form
                      key={w.name}
                      className="wm-row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        renameWall(w.name, renameInput);
                      }}
                    >
                      <input
                        className="wm-input"
                        autoFocus={!IS_COARSE}
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        onBlur={() => renameWall(w.name, renameInput)}
                        maxLength={64}
                      />
                      <button className="hint-close" type="submit" title={t('wm_rename')} aria-label={t('wm_rename')}>
                        ✓
                      </button>
                    </form>
                  ) : (
                    <div key={w.name} className="wm-row">
                      <span>{w.name}</span>
                      <button
                        className="hint-close"
                        title={t('wm_rename')}
                        aria-label={t('wm_rename')}
                        onClick={() => {
                          setRenameInput(w.name);
                          setRenaming(w.name);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="hint-close"
                        title={t('wm_delete')}
                        aria-label={t('wm_delete')}
                        onClick={() => deleteWall(w.name)}
                      >
                        ×
                      </button>
                    </div>
                  ),
                )}
              </>
            )}
          </div>
        </div>
      )}

      {docsOpen && <DocsModal onClose={() => setDocsOpen(false)} marketCount={markets?.length ?? null} />}
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}

      {pickerFor !== null && markets && (
        <MarketPicker
          markets={markets}
          outcomeQuestions={catalog?.outcomeQuestions ?? []}
          stats={stats}
          stale={wsStatus !== 'live'}
          nameIndex={nameIndex}
          current={resolveMarket(layout.cells[pickerFor]?.coin ?? null)}
          onClose={() => setPickerFor(null)}
          onSelect={(m) => {
            updateCell(pickerFor, { coin: m.coin });
            setPickerFor(null);
          }}
        />
      )}

      {pickerFor !== null && !markets && (
        <div
          className="picker-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPickerFor(null);
          }}
        >
          <div
            className="picker pk-shell"
            ref={pkShellRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('a_picker')}
            tabIndex={-1}
          >
            {marketError ? (
              <>
                {t('offline')}{' '}
                <button className="retry-btn" onClick={() => setMarketRetry((r) => r + 1)}>
                  {t('retry')}
                </button>
              </>
            ) : (
              t('loading_markets')
            )}
            {/* ≤640px the sheet is full-bleed (no exposed backdrop) and Escape
                is keyboard-only — touch users need a visible way out if the
                catalog stalls. .pk-close is already display:none on wide. */}
            <button
              className="pk-close"
              onClick={() => setPickerFor(null)}
              title={t('k_close')}
              aria-label={t('k_close')}
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
    </LangContext.Provider>
  );
}
