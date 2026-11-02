import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import type { Market } from '../lib/hl/types';
import { TRADFI_CATEGORIES, type OutcomeQuestion } from '../lib/hl/markets';
import { compactUsd, fmtFunding, hip3DexKey, type MarketStats } from '../lib/hl/stats';
import { searchRows } from '../lib/marketSearch';
import type { Fn } from '../lib/hl/compose';
import { hlSocket } from '../lib/hl/ws';
import { toggleFavorite, useFavorites } from '../lib/favorites';
import { fmt, useLang, useT, type StrKey } from '../lib/i18n';
import { IS_COARSE, useMediaQuery } from '../lib/media';
import { scheduleRender } from '../lib/renderQueue';
import { getSparklines, type SparkMap } from '../lib/hl/sparklines';
import {
  caretToken,
  compactText,
  compile,
  deleteToken,
  isFormulaTrigger,
  parseFormula,
  replaceToken,
  type NameIndex,
} from '../lib/hl/formula';
import {
  EXAMPLES,
  OP_KEYS,
  fmtValue,
  nextAction,
  opGlyph,
  pendingOperand,
  previewValue,
  slotText,
} from '../lib/formulaBar';

/** Below this the table's full-dollar / abs+pct columns no longer fit. */
const NARROW_MQ = '(max-width: 772px)';

/*
 * The market table core, shared by two surfaces:
 * - mode 'picker': the modal market selector — an intentional clone of
 *   Hyperliquid's (app.hyperliquid.xyz): its tabs, column ORDER, formats and
 *   naming. Keep it aligned (docs/architecture.md → UI rules).
 * - mode 'list': the first-class list view — same table, scan-optimized:
 *   fewer tabs, a scan column order with a trend glyph (Volume ahead of
 *   OI/Funding), rows open a fullscreen chart card instead of filling a cell.
 * Strict is HL's own curated allowlist of spot BASE tokens, synced from its
 * bundle (hl/spotSelector.json — passesStrict). One deliberate deviation:
 * when Strict hides EVERY match of a typed query, the tab's matches show
 * anyway under a one-line hint (lib/marketSearch.ts) — HL dead-ends there,
 * so a thin new listing that is not on the allowlist reads as "missing".
 * Known picker simplifications, on purpose:
 * - Crypto sub-tabs (AI/Defi/Meme…) are omitted — HL hardcodes those lists in
 *   its bundle; there is no public API for them.
 * - Outcome rows have no OI column; their Volume is the sum over the
 *   question's outcome tokens.
 *
 * FORMULA MODE (picker only — hl/formula.ts): the search box is also the
 * formula bar. It is an EXPLICIT switch: on only through the ƒx button
 * inside the search box (every pointer type) or when a formula cell is
 * being edited, off through the same button. Typed operators never flip it
 * — outside the mode Enter always selects the exact market, and a typed
 * formula that matches no row shows a one-line ƒx nudge instead of the
 * clone's dead end. Everything the mode changes (preview strip, operator
 * keys, caret-token row filter, row-tap-inserts, Enter completing instead
 * of selecting, Strict/All and Outcome hidden, input attributes) renders
 * only while it is on — with it off the table is the clone plus that one
 * button. Requires a `nameIndex`; without one there is no ƒx button at all.
 */

export type TableMode = 'picker' | 'list';

type TabKey =
  | 'favorites'
  | 'all'
  | 'perps'
  | 'spot'
  | 'outcome'
  | 'crypto'
  | 'tradfi'
  | 'hip3'
  | 'trending'
  | 'prelaunch';

const TABS: Record<TableMode, Array<{ key: TabKey; labelKey: StrKey }>> = {
  picker: [
    { key: 'favorites', labelKey: 'tab_favorites' },
    { key: 'all', labelKey: 'tab_all' },
    { key: 'perps', labelKey: 'tab_perps' },
    { key: 'spot', labelKey: 'tab_spot' },
    { key: 'outcome', labelKey: 'tab_outcome' },
    { key: 'crypto', labelKey: 'tab_crypto' },
    { key: 'tradfi', labelKey: 'tab_tradfi' },
    { key: 'hip3', labelKey: 'tab_hip3' },
    { key: 'trending', labelKey: 'tab_trending' },
    { key: 'prelaunch', labelKey: 'tab_prelaunch' },
  ],
  // A glance surface, not a catalog: five tabs that cover every market class
  // (Tradfi keeps its subtab row so indices/commodities/FX stay reachable).
  // The picker keeps the full ten.
  list: [
    { key: 'favorites', labelKey: 'tab_favorites' },
    { key: 'perps', labelKey: 'tab_perps' },
    { key: 'spot', labelKey: 'tab_spot' },
    { key: 'tradfi', labelKey: 'tab_tradfi' },
    { key: 'outcome', labelKey: 'tab_outcome' },
  ],
};

const TRADFI_SUBTABS: Array<{ key: string; labelKey: StrKey }> = [
  { key: 'all', labelKey: 'sub_all' },
  { key: 'stocks', labelKey: 'sub_stocks' },
  { key: 'indices', labelKey: 'sub_indices' },
  { key: 'commodities', labelKey: 'sub_commodities' },
  { key: 'fx', labelKey: 'sub_fx' },
  { key: 'preipo', labelKey: 'sub_preipo' },
];
// HL's spot quote sub-tabs (series chunk `nt`: all / USDC / USDT); a pair
// shows under one when its quote OR its base is that token, as on HL.
const SPOT_QUOTES = ['USDC', 'USDT'];
// HL's own Outcomes grouping since the HIP-4 template rollout (bundle
// series chunk `Le`: all / crypto / economics / tradfi / sports; rows with
// no bucket show under All only). HL has no separate "Crypto (1d)" bucket:
// recurring dailies sit under Crypto beside the template price markets.
// Labels reuse the picker's tab strings.
const OUTCOME_SUBTABS: Array<{ key: string; labelKey: StrKey }> = [
  { key: 'all', labelKey: 'sub_all' },
  { key: 'crypto', labelKey: 'tab_crypto' },
  { key: 'economics', labelKey: 'sub_economics' },
  { key: 'tradfi', labelKey: 'tab_tradfi' },
  { key: 'sports', labelKey: 'sub_sports' },
];

type SortKey = 'market' | 'last' | 'change' | 'funding' | 'volume' | 'oi' | 'mcap';
const SORT_KEYS: readonly string[] = ['market', 'last', 'change', 'funding', 'volume', 'oi', 'mcap'];
interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

type ColumnMode = 'perp' | 'spot';
// 'trend' is the one non-sortable column: a shape glyph has no meaningful
// order, and Volume stays the default sort even where the glyph visually
// replaces it (≤700px).
type Column = { key: SortKey | 'trend'; labelKey: StrKey };
// Per-surface column ORDER: the picker mirrors HL's selector exactly; the
// list uses a scan order, and its narrow-viewport cut keeps the first four
// columns.
const COLUMNS: Record<TableMode, Record<ColumnMode, Column[]>> = {
  picker: {
    perp: [
      { key: 'market', labelKey: 'col_market' },
      { key: 'last', labelKey: 'col_last' },
      { key: 'change', labelKey: 'col_change' },
      { key: 'funding', labelKey: 'col_funding' },
      { key: 'volume', labelKey: 'col_volume' },
      { key: 'oi', labelKey: 'col_oi' },
    ],
    spot: [
      { key: 'market', labelKey: 'col_market' },
      { key: 'last', labelKey: 'col_last' },
      { key: 'change', labelKey: 'col_change' },
      { key: 'volume', labelKey: 'col_volume' },
      { key: 'mcap', labelKey: 'col_mcap' },
    ],
  },
  list: {
    // Trend sits between 24h% and Volume: wide shows all; ≤700px the glyph
    // REPLACES the dollar columns; ≤360 drops it again — see the .lt-grid-*
    // ladder in App.css.
    perp: [
      { key: 'market', labelKey: 'col_market' },
      { key: 'last', labelKey: 'col_last' },
      { key: 'change', labelKey: 'col_change' },
      { key: 'trend', labelKey: 'col_trend' },
      { key: 'volume', labelKey: 'col_volume' },
      { key: 'oi', labelKey: 'col_oi' },
      { key: 'funding', labelKey: 'col_funding' },
    ],
    spot: [
      { key: 'market', labelKey: 'col_market' },
      { key: 'last', labelKey: 'col_last' },
      { key: 'change', labelKey: 'col_change' },
      { key: 'trend', labelKey: 'col_trend' },
      { key: 'volume', labelKey: 'col_volume' },
      { key: 'mcap', labelKey: 'col_mcap' },
    ],
  },
};
const OUTCOME_COLUMNS: Column[] = [
  { key: 'market', labelKey: 'col_market' },
  { key: 'change', labelKey: 'col_chance' },
  { key: 'volume', labelKey: 'col_volume' },
];

// tab/sort persist per surface (your list ranking shouldn't decide where the
// picker opens next time you fill a cell); strict is shared — same
// data-quality intent everywhere. Favorites are shared via lib/favorites.
const PERSIST = {
  picker: { tab: 'purrwall.picker.tab', sort: 'purrwall.picker.sort', defaultTab: 'all' as TabKey },
  list: { tab: 'purrwall.list.tab', sort: 'purrwall.list.sort', defaultTab: 'perps' as TabKey },
};
const STRICT_KEY = 'purrwall.picker.strict';
const TRENDING_MIN_VOLUME = 30_000_000;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked — non-fatal */
  }
}

/* ─── formatting (HL-style) ─── */

// Intl.NumberFormat construction is the hidden cost of toLocaleString (a few
// µs per call, and a full re-render formats thousands of cells) — cache one
// formatter per decimals tier.
const priceFmts = new Map<number, Intl.NumberFormat>();
function fmtPrice(n: number | null): string {
  if (n === null) return '--';
  const abs = Math.abs(n);
  const decimals = abs >= 10_000 ? 1 : abs >= 1_000 ? 1 : abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 6;
  let f = priceFmts.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
    priceFmts.set(decimals, f);
  }
  return f.format(n);
}

function fmtChange(
  last: number | null,
  prev: number | null,
  compact = false,
): { text: string; dir: 1 | -1 | 0 } {
  if (last === null || prev === null || prev === 0) return { text: '--', dir: 0 };
  const delta = last - prev;
  const pct = (delta / prev) * 100;
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const dir: 1 | -1 | 0 = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  // narrow viewports keep only the percentage — it never truncates
  if (compact) return { text: `${sign}${Math.abs(pct).toFixed(2)}%`, dir };
  const absText = fmtPrice(Math.abs(delta));
  return { text: `${sign}${absText} / ${sign}${Math.abs(pct).toFixed(2)}%`, dir };
}

const usdFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function fmtUsd(n: number | null, compact = false): string {
  if (n === null) return '--';
  // HL shows full dollars, but on narrow viewports the column would
  // truncate — and data must never truncate. Same rule, same helper, as the
  // per-cell stats bar.
  if (compact) return compactUsd(n);
  return `$${usdFmt.format(Math.round(n))}`;
}

/** "BTC-USDC" → base "BTC" + suffix "-USDC" (suffix rendered muted, like HL). */
function splitName(display: string): [string, string] {
  const m = display.match(/^(.+?)([-/].+)$/);
  return m ? [m[1], m[2]] : [display, ''];
}

/* ─── memoized market row ─── */

/** 24h shape glyph: ONE svg polyline per row (a hard rule — never a chart
 *  instance), colored by its own first→last direction. Data-driven fade-in
 *  via the CSS animation on .lt-spark-svg. */
function SparkSvg({ pts }: { pts: number[] }) {
  const w = 64;
  const h = 20;
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  const span = max - min || 1;
  const n = pts.length - 1;
  const d = pts
    .map(
      (p, i) =>
        `${((i / n) * w).toFixed(1)},${(h - 2 - ((p - min) / span) * (h - 4)).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      className={`lt-spark-svg${pts[n] >= pts[0] ? ' up' : ' down'}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface MarketRowProps {
  market: Market;
  columns: Column[];
  gridClass: string;
  index: number;
  last: number | null;
  prevDayPx: number | null;
  funding1h: number | null;
  oiUsd: number | null;
  volumeUsd: number | null;
  mcapUsd: number | null;
  /** 24h closes for the trend glyph; stable identity per blob (memo-safe). */
  spark: number[] | undefined;
  faved: boolean;
  highlighted: boolean;
  compact: boolean;
  spotPill: string;
  /** Formula mode: a tap must not blur the search input (the keyboard would
   *  drop and the caret would be lost) — cancel the focus-moving default. */
  keepFocus: boolean;
  onSelect: (m: Market) => void;
  onHover: (i: number) => void;
}

const preventDefault = (e: SyntheticEvent) => e.preventDefault();

// One row = one memo unit: a highlight move re-renders exactly two rows and
// the 60s stats poll re-renders only rows whose values actually changed —
// the full table is up to ~950 rows, far too many to reconcile per mousemove.
const MarketRow = memo(function MarketRow({
  market,
  columns,
  gridClass,
  index,
  last,
  prevDayPx,
  funding1h,
  oiUsd,
  volumeUsd,
  mcapUsd,
  spark,
  faved,
  highlighted,
  compact,
  spotPill,
  keepFocus,
  onSelect,
  onHover,
}: MarketRowProps) {
  const [base, suffix] = splitName(market.display);
  const chg = fmtChange(last, prevDayPx, compact);
  const cell = (c: Column) => {
    switch (c.key) {
      case 'last':
        return (
          <span key={c.key} className="pk-cell" data-live={market.coin}>
            {fmtPrice(last)}
          </span>
        );
      case 'change':
        return (
          <span
            key={c.key}
            className={`pk-cell${chg.dir === 1 ? ' up' : chg.dir === -1 ? ' down' : ''}`}
            data-live-chg={market.coin}
          >
            {chg.text}
          </span>
        );
      case 'funding':
        return (
          <span key={c.key} className="pk-cell">
            {fmtFunding(funding1h)}
          </span>
        );
      case 'volume':
        return (
          <span key={c.key} className="pk-cell">
            {fmtUsd(volumeUsd, compact)}
          </span>
        );
      case 'oi':
        return (
          <span key={c.key} className="pk-cell">
            {fmtUsd(oiUsd, compact)}
          </span>
        );
      case 'mcap':
        return (
          <span key={c.key} className="pk-cell">
            {fmtUsd(mcapUsd, compact)}
          </span>
        );
      case 'trend':
        // empty cell (not '--') while the blob loads or the coin is absent
        // (brand-new/thin market): a missing glyph is the honest render,
        // and the table never waits on it — progressive enhancement.
        return (
          <span key={c.key} className="pk-cell lt-spark">
            {spark && spark.length >= 2 && <SparkSvg pts={spark} />}
          </span>
        );
      default:
        return null;
    }
  };
  return (
    <button
      className={`pk-row ${gridClass}${highlighted ? ' hl' : ''}`}
      onClick={() => onSelect(market)}
      onMouseMove={() => onHover(index)}
      onPointerDown={keepFocus ? preventDefault : undefined}
      onMouseDown={keepFocus ? preventDefault : undefined}
    >
      <span className="pk-cell pk-market">
        {/* The whole row IS a <button>; ARIA prunes interactive descendants of
            a button (Children Presentational) AND folds their aria-label into
            the row's accessible name — so a role=button here would leave the
            star non-operable for AT yet prefix every row's name with
            "Favorite". It stays a pointer/touch affordance: aria-hidden so it
            never pollutes the row name; there is no keyboard/SR favorite
            path yet. */}
        <span
          className={`pk-star${faved ? ' faved' : ''}`}
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(market.coin);
          }}
        >
          {faved ? '★' : '☆'}
        </span>
        <span className="pk-name">
          {base}
          <span className="pk-name-suffix">{suffix}</span>
        </span>
        {market.kind === 'spot' ? (
          <span className="pk-pill">{spotPill}</span>
        ) : (
          market.maxLeverage != null && <span className="pk-pill">{market.maxLeverage}x</span>
        )}
        {market.dex && <span className="pk-pill">{market.dex}</span>}
      </span>
      {columns.slice(1).map(cell)}
    </button>
  );
});

/* ─── component ─── */

interface Props {
  mode: TableMode;
  markets: Market[];
  outcomeQuestions: OutcomeQuestion[];
  stats: Map<string, MarketStats> | null;
  onSelect: (market: Market) => void;
  /** WS reconnecting: dim the rows so frozen prices never read as live. */
  stale?: boolean;
  /** rendered at the right edge of the search row (e.g. the modal's ×) */
  topRight?: ReactNode;
  footer?: ReactNode;
  autoFocusSearch?: boolean;
  /** Current sorted+filtered MARKET row order, pushed on every change: lets
   *  the list card page prev/next through exactly what the table shows.
   *  Outcome tab pushes [] (question rows, not markets → no paging). */
  onVisibleRowsChange?: (rows: Market[]) => void;
  /** Formula mode (picker only): the catalog's name index. null/absent keeps
   *  the table exactly as it is without the feature. */
  nameIndex?: NameIndex | null;
  /** Pre-filled search text — editing an existing formula cell. */
  initialQuery?: string;
  /** Open already in formula mode (with initialQuery = its edit text). */
  initialFormula?: boolean;
}

export function MarketTable({
  mode,
  markets,
  outcomeQuestions,
  stats,
  onSelect,
  stale,
  topRight,
  footer,
  autoFocusSearch,
  onVisibleRowsChange,
  nameIndex,
  initialQuery,
  initialFormula,
}: Props) {
  const tr = useT();
  const lang = useLang();
  const persist = PERSIST[mode];
  const tabs = TABS[mode];
  // Compact numeric formatting when the table itself is squeezed.
  // (Both surfaces share the threshold: the modal maxes out near the
  // viewport width, so the full-page list is never narrower at same width.)
  const narrow = useMediaQuery(NARROW_MQ);
  // Persisted values are validated shape-by-shape: localStorage can hold
  // values from older builds, and an invalid tab/sort key would crash render.
  // Formula mode is gated at the component boundary: the list surface can
  // never enter it, and the picker cannot without a name index.
  const index: NameIndex | null = mode === 'picker' && nameIndex ? nameIndex : null;
  const fxEnabled = index !== null;
  const [query, setQuery] = useState(initialQuery ?? '');
  const [fxMode, setFxMode] = useState(!!initialFormula);
  const fx = fxEnabled && fxMode;
  const [tab, setTab] = useState<TabKey>(() => {
    const t = loadJson<unknown>(persist.tab, persist.defaultTab);
    const t0 = tabs.some((x) => x.key === t) ? (t as TabKey) : persist.defaultTab;
    // question rows are not operands: a formula never opens on Outcome
    return initialFormula && t0 === 'outcome' ? 'all' : t0;
  });
  const [subTab, setSubTab] = useState('all');
  const [strict, setStrict] = useState<boolean>(() => loadJson<unknown>(STRICT_KEY, true) !== false);
  const [sort, setSort] = useState<SortState>(() => {
    const s = loadJson<Partial<SortState> | null>(persist.sort, null);
    return s && SORT_KEYS.includes(s.key as SortKey) && (s.dir === 'asc' || s.dir === 'desc')
      ? { key: s.key as SortKey, dir: s.dir }
      : { key: 'volume', dir: 'desc' };
  });
  const favs = useFavorites();
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocusSearch) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const marketByCoin = useMemo(() => new Map(markets.map((m) => [m.coin, m])), [markets]);

  const setTabAndReset = (t: TabKey) => {
    setTab(t);
    setSubTab('all');
    setHighlight(0);
    saveJson(persist.tab, t);
  };

  const toggleStrict = (v: boolean) => {
    setStrict(v);
    saveJson(STRICT_KEY, v);
  };

  // Trending has a fixed order (1 loser + 3 gainers) and Outcome rows aren't
  // column-sorted — header clicks there would silently mutate the global sort.
  const sortable = tab !== 'outcome' && tab !== 'trending';

  // Trend glyphs (list mode only): one pre-aggregated blob paints every
  // row's sparkline in the same frame — see src/lib/hl/sparklines.ts.
  const [sparks, setSparks] = useState<SparkMap | null>(null);
  useEffect(() => {
    if (mode !== 'list') return;
    let dead = false;
    getSparklines().then((m) => {
      if (!dead && m) setSparks(m);
    });
    return () => {
      dead = true;
    };
  }, [mode]);

  const clickSort = (key: SortKey) => {
    if (!sortable) return;
    setSort((prev) => {
      const next: SortState =
        prev.key === key
          ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
          : { key, dir: key === 'market' ? 'asc' : 'desc' };
      saveJson(persist.sort, next);
      return next;
    });
  };

  const columnMode: ColumnMode = tab === 'spot' ? 'spot' : 'perp';
  const columns = COLUMNS[mode][columnMode];
  // The list view is a glance surface — the strict toggle only matters where
  // it has an effect (spot); the picker keeps HL's placement.
  const showStrictToggle =
    mode === 'list' ? tab === 'spot' : tab === 'all' || tab === 'perps' || tab === 'spot' || tab === 'hip3';

  // Keyed by value: a live-catalog refresh hands a new `markets` array, and
  // only a changed dex SET may resubscribe the allMids feeds below.
  const hip3Key = useMemo(() => hip3DexKey(markets), [markets]);
  const hip3Dexs = useMemo(() => (hip3Key ? hip3Key.split(',') : []), [hip3Key]);

  const subTabs: Array<{ key: string; label: string }> | null = useMemo(() => {
    if (tab === 'spot')
      return [
        { key: 'all', label: tr('sub_all') },
        ...SPOT_QUOTES.map((q) => ({ key: q.toLowerCase(), label: q })),
      ];
    if (tab === 'tradfi') return TRADFI_SUBTABS.map((s) => ({ key: s.key, label: tr(s.labelKey) }));
    if (tab === 'hip3')
      return [{ key: 'all', label: tr('sub_all') }, ...hip3Dexs.map((d) => ({ key: d, label: d }))];
    if (tab === 'outcome')
      return OUTCOME_SUBTABS.map((s) => ({ key: s.key, label: tr(s.labelKey) }));
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, hip3Dexs, lang]);

  /* ── formula mode (see the header comment) ── */

  // The caret anchor is STATE, not a ref: the row filter follows the caret
  // token, and the caret moves without a keystroke (a click inside the
  // text, a chip tap) — a ref would leave the rows filtering a stale token.
  const [anchor, setAnchor] = useState(() => {
    const n = initialQuery?.length ?? 0;
    return { start: n, end: n };
  });
  const moveAnchor = (start: number, end: number) =>
    setAnchor((a) => (a.start === start && a.end === end ? a : { start, end }));
  // A controlled input parks the caret at the END after a programmatic
  // value change — restore it where the insert left off (focused input
  // only: on a phone the keyboard is deliberately down).
  const pendingCaretRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const c = pendingCaretRef.current;
    if (c === null) return;
    pendingCaretRef.current = null;
    const el = inputRef.current;
    if (el && document.activeElement === el) el.setSelectionRange(c, c);
  }, [query]);
  const [selectedChip, setSelectedChip] = useState<{ start: number; end: number } | null>(null);

  const parsed = useMemo(
    () => (fx && index && query.trim() ? parseFormula(query, index) : null),
    [fx, index, query],
  );
  const tok = fx && index ? caretToken(query, anchor.end, index) : null;
  // Rows filter by the caret token's BASE ('hype' for 'hype/usdc' or
  // 'xyz:hype'), so a resolved alias keeps its sibling rows on offer and a
  // mis-tap is one tap away from its fix.
  const tokBase = tok ? (tok.text.replace(/^[a-z0-9]+:/i, '').split(/[/-]/)[0] ?? '') : '';
  const fxFn = useMemo(() => (parsed?.ok ? compile(parsed.ast, parsed.legs) : null), [parsed]);

  const setFormula = (next: { q: string; caret: number }) => {
    setQuery(next.q);
    moveAnchor(next.caret, next.caret);
    pendingCaretRef.current = next.caret;
    setSelectedChip(null);
  };
  const enterFx = () => {
    if (!fxEnabled) return;
    if (tab === 'outcome') setTabAndReset('all'); // question rows are not operands
    setFxMode(true);
    setSelectedChip(null);
    moveAnchor(query.length, query.length);
    // desktop types its formula, so the switch hands the caret over; phones
    // build by tapping and keep the keyboard down
    if (!IS_COARSE) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(query.length, query.length);
      }
    }
  };
  /** Row tap/click/Enter in formula mode: the market's typeable alias
   *  replaces the caret token (or lands at the caret in an empty slot). */
  const insertMarket = (m: Market) => {
    if (!index || !tok) return;
    setFormula(replaceToken(query, tok.start, tok.end, index.aliasFor(m.coin)));
  };
  const insertOp = (ch: string) => setFormula(replaceToken(query, anchor.end, anchor.end, ch));
  const place = () => {
    if (!parsed?.ok || !index) return;
    if (parsed.single) {
      // a lone symbol is the plain market — a typed spot pair included
      const m = marketByCoin.get(parsed.legs[0]!);
      if (m) onSelect(m);
      return;
    }
    onSelect({
      coin: parsed.canonical,
      display: compactText(parsed.ast, (c) => index.displayOf(c)),
      kind: 'formula',
      legs: parsed.legs,
    });
  };
  const focusProblem = () => {
    if (!parsed || parsed.ok) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(parsed.start, parsed.end);
    moveAnchor(parsed.start, parsed.end);
  };
  const selectChip = (t: { start: number; end: number }) => {
    moveAnchor(t.start, t.end);
    setSelectedChip(t);
    const el = inputRef.current;
    if (el && !IS_COARSE) {
      el.focus();
      el.setSelectionRange(t.start, t.end);
    }
  };
  const removeChip = (t: { start: number; end: number }) => setFormula(deleteToken(query, t.start, t.end));
  const onQueryInput = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    setSelectedChip(null);
    moveAnchor(e.target.selectionStart ?? v.length, e.target.selectionEnd ?? v.length);
  };
  const syncAnchor = (e: SyntheticEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    moveAnchor(el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length);
  };
  // The preview value is computed at render from the mids map and kept
  // fresh between renders by flushLive (the slot carries a ref).
  const fxValueRef = useRef<HTMLSpanElement>(null);
  const fxLiveRef = useRef<{ fn: Fn; legs: string[] } | null>(null);
  fxLiveRef.current = fxFn && parsed?.ok ? { fn: fxFn, legs: parsed.legs } : null;

  /* ── row building ── */

  const q = (fx ? tokBase : query).trim().toLowerCase();

  // Row ORDER is computed from a stats snapshot and deliberately frozen
  // between interaction boundaries (tab/subtab/search/sort/favorites — and
  // once when stats first arrive): the 60s poll updates VALUES in place, but
  // rows must never reorder under a moving finger or pointer.
  const statsRef = useRef(stats);
  statsRef.current = stats;
  const statsReady = stats !== null;
  // The CATALOG freezes the same way: it is live (hl/catalogSync.ts — a new
  // listing, an outcome rolling every 15 min), and an open table adopts it at
  // the next boundary rather than re-sorting under the pointer (a moved row
  // under a kept highlight index would make Enter pick a different market).
  // Typing a name is itself a boundary, so a new listing is found the moment
  // it is searched. `catalogReady` covers the one un-frozen transition: the
  // first catalog arriving under an already-open table.
  const catalogRef = useRef({ markets, marketByCoin, index, outcomeQuestions });
  catalogRef.current = { markets, marketByCoin, index, outcomeQuestions };
  const catalogReady = markets.length > 0;
  const outcomesReady = outcomeQuestions.length > 0;
  // Two more boundaries. An EMPTY result has nothing to reorder, so a catalog
  // change is one for it (a query typed a minute before its listing reached
  // the catalog must not keep saying "No markets match"). And using an
  // Outcome row whose market has since settled (it left the live catalog —
  // selecting the frozen snapshot's id would put a settled id on the shared
  // socket, which HL answers by closing it) re-derives the rows instead of
  // doing nothing.
  // (Latched refs, not `empty ? markets : null` deps: that flips once more
  // when a result turns non-empty, re-sorting it on the next unrelated render.)
  const marketRowsEmptyRef = useRef(false);
  const questionRowsEmptyRef = useRef(false);
  const marketsDepRef = useRef(markets);
  const questionsDepRef = useRef(outcomeQuestions);
  if (marketRowsEmptyRef.current) marketsDepRef.current = markets;
  if (questionRowsEmptyRef.current) questionsDepRef.current = outcomeQuestions;
  const [questionEpoch, bumpQuestionEpoch] = useReducer((n: number) => n + 1, 0);

  // Returns crossTab / strictRelaxed alongside the rows (lib/marketSearch.ts):
  // a search never dead-ends on a market that exists (product principle —
  // "No match" reads as "we don't have it").
  const { rows: marketRows, crossTab, strictRelaxed } = useMemo(() => {
    if (tab === 'outcome') return { rows: [] as Market[], crossTab: false, strictRelaxed: false };
    const snap = statsRef.current;
    const { markets, marketByCoin, index } = catalogRef.current;
    const change = (m: Market) => {
      const s = snap?.get(m.coin);
      return s?.last != null && s.prevDayPx != null && s.prevDayPx !== 0
        ? (s.last - s.prevDayPx) / s.prevDayPx
        : null;
    };

    let list: Market[];
    switch (tab) {
      case 'favorites':
        list = markets.filter((m) => m.kind !== 'hip4' && favs.has(m.coin));
        break;
      case 'all':
        list = markets.filter((m) => m.kind !== 'hip4');
        break;
      case 'perps':
        list = markets.filter((m) => m.kind === 'perp' || m.kind === 'hip3');
        break;
      case 'spot':
        list = markets.filter((m) => m.kind === 'spot');
        if (subTab !== 'all') {
          // Whole display SEGMENTS (a substring test mis-files USDHL/USDC);
          // display names already carry HL's renames (USDT0 → USDT).
          list = list.filter((m) => {
            const [base, quote = ''] = m.display.toLowerCase().split('/');
            return quote === subTab || base === subTab;
          });
        }
        break;
      case 'crypto':
        list = markets.filter((m) => m.kind === 'perp');
        break;
      case 'tradfi':
        list = markets.filter((m) => m.kind === 'hip3' && TRADFI_CATEGORIES.has(m.category ?? ''));
        if (subTab !== 'all') list = list.filter((m) => m.category === subTab);
        break;
      case 'hip3':
        list = markets.filter((m) => m.kind === 'hip3');
        if (subTab !== 'all') list = list.filter((m) => m.dex === subTab);
        break;
      case 'prelaunch':
        list = markets.filter((m) => m.kind === 'perp' && m.preLaunch);
        break;
      case 'trending': {
        // HL's exact recipe: volume > $30M, sort by 24h change ascending,
        // keep the single biggest loser + the 3 biggest gainers.
        const eligible = markets
          .filter((m) => m.kind !== 'hip4' && (snap?.get(m.coin)?.volumeUsd ?? 0) > TRENDING_MIN_VOLUME)
          .sort((a, b) => (change(a) ?? 0) - (change(b) ?? 0));
        list = eligible.length <= 4 ? eligible : [...eligible.slice(0, 1), ...eligible.slice(-3)];
        break;
      }
    }

    // Strict is HL's own allowlist (hl/spotSelector.json via passesStrict),
    // applied where HL applies it: spot rows on All / Spot / Trending.
    // Formula mode ignores it: the thin spot pairs it hides are exactly the
    // legs a formula may want, and the toggle itself is hidden.
    const found = searchRows({
      tabRows: list,
      q,
      strict: strict && !fx && (tab === 'all' || tab === 'spot' || tab === 'trending'),
      // LIST mode (and formula mode) only — the picker otherwise keeps HL's
      // within-tab rule: a query with zero hits in the active tab searches
      // the whole catalog, with a hint line saying where the rows came from.
      catalog: mode === 'list' || fx ? markets : null,
      // The picker's one addition to HL's within-tab rule: a query that IS a
      // market's full name ('hype/usdc', 'btc-usdc', 'xyz:tsla') resolves to
      // that market even though the base-segment match cannot see it — so
      // Enter selects the exact market and the ƒx nudge never mistakes a
      // spot pair for a formula.
      resolveFull:
        mode === 'picker' && !fx && index
          ? (text) => {
              const hit = index.resolve(text);
              return hit && 'coin' in hit ? marketByCoin.get(hit.coin) : undefined;
            }
          : null,
    });
    list = found.rows;

    const dirMul = sort.dir === 'desc' ? -1 : 1;
    const value = (m: Market): number | string | null => {
      const s = snap?.get(m.coin);
      switch (sort.key) {
        case 'market':
          return m.display;
        case 'last':
          return s?.last ?? null;
        case 'change':
          return change(m);
        case 'funding':
          return s?.funding1h ?? null;
        case 'volume':
          return s?.volumeUsd ?? null;
        case 'oi':
          return s?.openInterestUsd ?? null;
        case 'mcap':
          return s?.marketCapUsd ?? null;
      }
    };
    const sorted = tab === 'trending' ? list : [...list].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // nulls always last
      if (vb === null) return -1;
      const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * dirMul;
    });
    // favorites pinned to the top in every tab, like HL
    return {
      rows: [...sorted.filter((m) => favs.has(m.coin)), ...sorted.filter((m) => !favs.has(m.coin))],
      crossTab: found.crossTab,
      strictRelaxed: found.strictRelaxed,
    };
    // statsRef / catalogRef are read as snapshots on purpose — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogReady, mode, tab, subTab, q, strict, fx, sort, favs, statsReady, marketsDepRef.current]);
  marketRowsEmptyRef.current = marketRows.length === 0;

  // Push the current market row order to the parent (list-card paging). Ref
  // the callback so a fresh callback identity never re-fires this — only a
  // genuine order change should. Row memoization is untouched: this reads
  // the already-computed marketRows, it doesn't re-render rows.
  const onRowsRef = useRef(onVisibleRowsChange);
  onRowsRef.current = onVisibleRowsChange;
  useEffect(() => {
    onRowsRef.current?.(marketRows);
  }, [marketRows]);

  // Outcome rows: the STRUCTURE (which segments, their order, the default
  // coin) freezes with the same boundary rules; chance/volume VALUES are read
  // live at render so the 60s poll keeps them honest.
  interface QuestionRow {
    question: OutcomeQuestion;
    binary: boolean;
    binaryCoin: string | null;
    segs: Array<{ id: string | number; name: string; coin: string }> | null;
    defaultCoin: string | null;
  }
  const questionRows = useMemo((): QuestionRow[] => {
    if (tab !== 'outcome') return [];
    const snap = statsRef.current;
    let list = catalogRef.current.outcomeQuestions;
    if (subTab !== 'all') list = list.filter((question) => question.category === subTab);
    if (q) {
      list = list.filter(
        (question) =>
          question.name.toLowerCase().includes(q) ||
          question.outcomes.some((o) => o.name.toLowerCase().includes(q)),
      );
    }
    return list.map((question) => {
      const chances = question.outcomes
        .map((o) => ({ o, chance: snap?.get(o.yesCoin)?.last ?? null }))
        .sort((a, b) => (b.chance ?? -1) - (a.chance ?? -1));
      // HL's rule: a single Yes/No outcome → one binary row with % chance;
      // NAMED sides (match markets: two teams) → a segment PER SIDE, each
      // side its own tradable market/chart
      const single = question.outcomes.length === 1 ? question.outcomes[0] : null;
      const yesNo = !!single && single.sides.length === 2 && single.sides[0]?.name === 'Yes';
      const segs = single
        ? yesNo
          ? null
          : single.sides.map((s) => ({ id: s.coin, name: s.name, coin: s.coin }))
        : chances.slice(0, 3).map(({ o }) => ({ id: o.id, name: o.name, coin: o.yesCoin }));
      return {
        question,
        binary: !!single && yesNo,
        binaryCoin: single && yesNo ? single.yesCoin : null,
        segs,
        // sides[0]?.coin, not sides[0].coin: an outcome with no sideSpecs
        // would throw here, inside a render-phase useMemo with only the root
        // error boundary above this table — the whole app's crash screen
        // instead of a missing row. The yesNo check above already
        // optional-chains the same index; `defaultCoin` is string | null and
        // both consumers truth-check it, so a null leaves the row without a
        // market to select (a click only re-derives the rows), which is the
        // safe direction.
        defaultCoin: single && !yesNo ? (single.sides[0]?.coin ?? null) : (chances[0]?.o.yesCoin ?? null),
      };
    });
    // statsRef / catalogRef are read as snapshots on purpose — see marketRows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, subTab, outcomesReady, q, statsReady, questionEpoch, questionsDepRef.current]);
  questionRowsEmptyRef.current = questionRows.length === 0;

  const rowCount = tab === 'outcome' ? questionRows.length : marketRows.length;

  /* ── keyboard: ↑↓ navigate, Enter select — container-scoped, so a focused
        topbar/page control outside the table can never trigger a row select.
        Escape stays a wrapper concern (modal close vs card close). ── */

  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME composition (Chinese/Japanese input): Enter confirms the
    // candidate word, it must not select a market.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => {
        const next = Math.max(0, Math.min(rowCount - 1, h + (e.key === 'ArrowDown' ? 1 : -1)));
        listRef.current
          ?.querySelectorAll('.pk-row')
          [next]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
    } else if (e.key === 'Enter') {
      // Enter on a focused BUTTON (ƒx, Strict/All, ×, a tab, the nudge) is
      // that button's own activation — never a row select (otherwise
      // Tab → ƒx → Enter would place row 0 and close the picker)
      if ((e.target as HTMLElement).closest('button')) return;
      // The select closes the picker and useModalFocus hands focus back to
      // the opener — the cell's name BUTTON — inside this same keydown. Without
      // this, the key's keypress lands on that button and Chrome activates it:
      // the picker reopens on top of the freshly swapped chart. Cancelling the
      // default here cancels the keypress and the activation with it.
      e.preventDefault();
      if (fx && tok) {
        // Formula mode is where the user STAYS: plain Enter completes an
        // unresolved caret token with the highlighted row or jumps the caret
        // to the first problem, and never places — ✓ (or Ctrl/⌘+Enter) is
        // the way out. (No Tab handling: useModalFocus owns Tab for every
        // dialog.)
        const row = marketRows[highlight];
        const action = nextAction(parsed, row != null, tok, e.metaKey || e.ctrlKey);
        if (action === 'place') place();
        else if (action === 'complete' && row) insertMarket(row);
        else if (action === 'focus-problem') focusProblem();
        return;
      }
      if (tab === 'outcome') {
        const row = questionRows[highlight];
        const target = row?.defaultCoin ? marketByCoin.get(row.defaultCoin) : undefined;
        if (target) onSelect(target);
        else if (row) bumpQuestionEpoch();
      } else {
        const m = marketRows[highlight];
        if (m) onSelect(m);
      }
    }
  };

  useEffect(() => {
    setHighlight(0);
  }, [q, tab, subTab]);

  // The list can also shrink/reorder when stats arrive or a favorite toggles —
  // keep the highlight inside bounds so Enter never targets a missing row.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, rowCount - 1)));
  }, [rowCount]);

  // Stable callbacks so MarketRow's memo holds across parent re-renders.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // formula mode turns a row pick into an insert-at-caret (ref-routed so
  // MarketRow's memo identity never changes)
  const insertRef = useRef<((m: Market) => void) | null>(null);
  insertRef.current = fx ? insertMarket : null;
  const selectMarket = useCallback(
    (m: Market) => (insertRef.current ? insertRef.current(m) : onSelectRef.current(m)),
    [],
  );
  const hoverRow = useCallback((i: number) => setHighlight(i), []);

  /* ── live prices (WS allMids, ~5s server cadence) ──
     React owns structure and order; between renders, price and 24h-change
     cells are updated imperatively (textContent writes, skip-if-unchanged),
     rAF-coalesced through renderQueue. The key is FIXED per table — unlike
     candle bars (Invariant 1: per-bar keys, a sequence where dropped frames
     lose closed bars) a mids message is an idempotent snapshot: coalescing
     to the latest one is exactly right, and a hidden tab just paints the
     newest state on return. Rows also read midsRef at render, so a React
     re-render can never repaint a staler price than the last flush. */
  const midsRef = useRef(new Map<string, number>());
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const uid = useId();

  const flushLive = useCallback(() => {
    const root = listRef.current;
    if (!root) return;
    const mids = midsRef.current;
    const snap = statsRef.current;
    for (const el of root.querySelectorAll<HTMLElement>('[data-live]')) {
      const mid = mids.get(el.dataset.live!);
      if (mid == null) continue;
      const text = fmtPrice(mid);
      if (el.textContent !== text) el.textContent = text;
    }
    for (const el of root.querySelectorAll<HTMLElement>('[data-live-chg]')) {
      const coin = el.dataset.liveChg!;
      const mid = mids.get(coin);
      if (mid == null) continue;
      const chg = fmtChange(mid, snap?.get(coin)?.prevDayPx ?? null, narrowRef.current);
      // text and class compared INDEPENDENTLY: React re-renders write text
      // without knowing about our class writes (and vice versa) — a coupled
      // write could leave color contradicting sign until the next crossing
      if (el.textContent !== chg.text) el.textContent = chg.text;
      const cls = `pk-cell${chg.dir === 1 ? ' up' : chg.dir === -1 ? ' down' : ''}`;
      if (el.className !== cls) el.className = cls;
    }
    // the formula preview's live value rides the same flush
    const fxLive = fxLiveRef.current;
    const vEl = fxValueRef.current;
    if (fxLive && vEl) {
      const v = previewValue(fxLive.fn, fxLive.legs, (c) => mids.get(c));
      const text = v === null ? '' : fmtValue(v);
      if (vEl.textContent !== text) vEl.textContent = text;
    }
  }, []);

  useEffect(() => {
    const unsubs = ['', ...hip3Dexs].map((dex) =>
      hlSocket.subscribeAllMids(dex, (mids) => {
        const map = midsRef.current;
        for (const coin in mids) {
          const v = Number(mids[coin]);
          if (Number.isFinite(v)) map.set(coin, v);
        }
        scheduleRender(`mids:${uid}`, flushLive);
      }),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, [hip3Dexs, uid, flushLive]);

  /** Live mid for a coin, or null — callers fall back to the poll stats. */
  const live = useCallback(
    (coin: string): number | null => midsRef.current.get(coin) ?? null,
    [],
  );

  /* ── render ── */

  const gridClass =
    mode === 'list'
      ? columnMode === 'spot'
        ? 'lt-grid-spot'
        : 'lt-grid-perp'
      : columnMode === 'spot'
        ? 'pk-grid-spot'
        : 'pk-grid-perp';
  const spotPill = tr('badge_spot_pill');

  return (
    // tabIndex −1: clicking anywhere inside (padding, headers) focuses the
    // container so ↑↓/Enter work without requiring focus on a specific row.
    <div
      className={`pk-table${mode === 'list' ? ' lt' : ''}${stale ? ' mt-stale' : ''}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="pk-top">
        <div className={`pk-search-wrap${fxEnabled ? ' has-fx' : ''}`}>
          <span className="pk-search-icon" aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            className="pk-search"
            placeholder={tr('search_ph')}
            value={query}
            onChange={onQueryInput}
            onSelect={syncAnchor}
            onKeyUp={syncAnchor}
            onClick={syncAnchor}
            // formula mode only — the plain picker keeps the browser's default
            // typing behavior
            {...(fx
              ? { autoCorrect: 'off', spellCheck: false, autoCapitalize: 'characters', enterKeyHint: 'go' as const }
              : {})}
          />
          {/* the one always-visible deviation from HL's selector: the switch
              is explicit and lives on every device. pointerdown is cancelled
              so a tap never moves focus: on phones the keyboard stays down
              and the rows stay tappable as operands; on desktop enterFx hands
              the caret to the input itself. */}
          {fxEnabled && (
            <button
              className="pk-fx"
              onClick={() => {
                if (fxMode) {
                  setFxMode(false);
                  setSelectedChip(null);
                } else enterFx();
              }}
              onPointerDown={preventDefault}
              aria-pressed={fxMode}
              aria-label={tr('fx_btn')}
              title={tr('fx_btn')}
            >
              ƒx
            </button>
          )}
        </div>
        {showStrictToggle && !fx && (
          <div className="pk-strict">
            <button
              className={`pk-strict-btn${strict ? ' on-strict' : ''}`}
              onClick={() => toggleStrict(true)}
            >
              {tr('strict')}
            </button>
            <button
              className={`pk-strict-btn${!strict ? ' on-all' : ''}`}
              onClick={() => toggleStrict(false)}
            >
              {tr('all_btn')}
            </button>
          </div>
        )}
        {topRight}
      </div>

      {fx && index && (
        <div className="pk-preview">
          <div className="pk-chips">
            {parsed === null
              ? EXAMPLES.map((ex) => (
                  <span key={ex} className="pk-chip pk-chip-ex">
                    {ex}
                  </span>
                ))
              : parsed.tokens.map((t) => {
                  const sel =
                    selectedChip !== null && selectedChip.start === t.start && selectedChip.end === t.end;
                  const bad = t.kind === 'unresolved' || t.kind === 'ambiguous';
                  const label =
                    t.kind === 'sym' && t.coin
                      ? index.displayOf(t.coin)
                      : t.kind === 'op'
                        ? opGlyph(t.text)
                        : t.text;
                  const m = t.kind === 'sym' && t.coin ? marketByCoin.get(t.coin) : undefined;
                  const pill = m?.kind === 'spot' ? spotPill : m?.kind === 'hip3' ? m.dex : null;
                  return (
                    <span
                      key={`${t.start}-${t.end}`}
                      className={`pk-chip pk-chip-${t.kind}${sel ? ' sel' : ''}`}
                    >
                      <button
                        className="pk-chip-btn"
                        onClick={() => selectChip(t)}
                        onPointerDown={preventDefault}
                      >
                        {label}
                        {bad && <span className="pk-chip-q"> ?</span>}
                        {pill && <span className="pk-pill">{pill}</span>}
                      </button>
                      {sel && (
                        <button
                          className="pk-chip-x"
                          onClick={() => removeChip(t)}
                          onPointerDown={preventDefault}
                          aria-label={fmt(tr('fx_remove'), { word: label })}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  );
                })}
            {pendingOperand(parsed) && <span className="pk-chip pk-chip-slot" aria-hidden="true" />}
          </div>
          <div className="pk-value">
            {parsed?.ok && fxFn ? (
              <>
                <span className="pk-value-num" ref={fxValueRef}>
                  {(() => {
                    const v = previewValue(fxFn, parsed.legs, (c) => midsRef.current.get(c));
                    return v === null ? '' : fmtValue(v);
                  })()}
                </span>
                <button
                  className="pk-place"
                  onClick={place}
                  onPointerDown={preventDefault}
                  aria-label={tr('fx_place')}
                  title={tr('fx_place_t')}
                >
                  ✓
                </button>
              </>
            ) : (
              <span className="pk-reason" aria-live="polite">
                {slotText(parsed, query, tr, IS_COARSE)}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="pk-tabs">
        {tabs
          .filter((tb) => !fx || tb.key !== 'outcome')
          .map((tb) => (
          <button
            key={tb.key}
            className={`pk-tab${tab === tb.key ? ' active' : ''}`}
            onClick={() => setTabAndReset(tb.key)}
          >
            {tr(tb.labelKey)}
          </button>
        ))}
      </div>

      {subTabs && (
        <div className="pk-subtabs">
          {subTabs.map((s) => (
            <button
              key={s.key}
              className={`pk-subtab${subTab === s.key ? ' active' : ''}`}
              onClick={() => setSubTab(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {fx && IS_COARSE ? (
        // the six operand keys replace the column header while a formula is
        // built by touch (iOS keeps + − × ÷ ( ) two taps deep in its 123 layer)
        <div className="pk-ops">
          {OP_KEYS.map(([ch, glyph]) => (
            <button
              key={ch}
              className="pk-op"
              onClick={() => insertOp(ch)}
              onPointerDown={preventDefault}
              aria-label={glyph}
            >
              {glyph}
            </button>
          ))}
        </div>
      ) : (
      <div className={`pk-thead ${gridClass}`}>
        {(tab === 'outcome' ? OUTCOME_COLUMNS : columns).map((c) => (
          <button
            key={c.key}
            className="pk-th"
            // 'trend' is a glyph, not an order — its header sorts nothing
            onClick={() => c.key !== 'trend' && clickSort(c.key)}
          >
            {tr(c.labelKey)}
            {sortable && sort.key === c.key && (
              <span className="pk-sort-arrow">{sort.dir === 'desc' ? '▼' : '▲'}</span>
            )}
          </button>
        ))}
      </div>
      )}

      <div className="pk-list" ref={listRef}>
        {tab !== 'outcome' && (crossTab || strictRelaxed) && (
          <div className="pk-crosstab">{tr(crossTab ? 'search_other_tabs' : 'search_strict_relaxed')}</div>
        )}
        {tab !== 'outcome' &&
          marketRows.map((m, i) => {
            const s = stats?.get(m.coin);
            return (
              <MarketRow
                key={m.coin}
                market={m}
                columns={columns}
                gridClass={gridClass}
                index={i}
                last={live(m.coin) ?? s?.last ?? null}
                prevDayPx={s?.prevDayPx ?? null}
                funding1h={s?.funding1h ?? null}
                oiUsd={s?.openInterestUsd ?? null}
                volumeUsd={s?.volumeUsd ?? null}
                mcapUsd={s?.marketCapUsd ?? null}
                spark={sparks?.get(m.coin)}
                faved={favs.has(m.coin)}
                highlighted={i === highlight}
                compact={narrow}
                spotPill={spotPill}
                keepFocus={fx}
                onSelect={selectMarket}
                onHover={hoverRow}
              />
            );
          })}

        {tab === 'outcome' &&
          questionRows.map(({ question, binary, binaryCoin, segs, defaultCoin }, i) => {
            // per-question volume = Σ outcome-token 24h notional, read live
            let volume: number | null = null;
            for (const o of question.outcomes) {
              const v = stats?.get(o.yesCoin)?.volumeUsd;
              if (v != null) volume = (volume ?? 0) + v;
            }
            const chance = binaryCoin ? (live(binaryCoin) ?? stats?.get(binaryCoin)?.last ?? null) : null;
            return (
              <div
                key={question.id}
                className={`pk-row pk-qrow${i === highlight ? ' hl' : ''}`}
                onMouseMove={() => setHighlight(i)}
              >
                <button
                  className="pk-qmain"
                  onClick={() => {
                    const target = defaultCoin ? marketByCoin.get(defaultCoin) : undefined;
                    if (target) onSelect(target);
                    else bumpQuestionEpoch();
                  }}
                >
                  <span className="pk-name">{question.name}</span>
                  <span className="pk-qchance">
                    {binary && chance != null ? `${Math.round(chance * 100)}%` : '--'}
                    {' · V '}
                    {fmtUsd(volume, narrow)}
                  </span>
                </button>
                {segs && (
                  <div className="pk-qoutcomes">
                    {segs.map((sg) => {
                      const target = marketByCoin.get(sg.coin);
                      const c = live(sg.coin) ?? stats?.get(sg.coin)?.last ?? null;
                      return (
                        <button
                          key={sg.id}
                          className="pk-qseg"
                          onClick={() => (target ? onSelect(target) : bumpQuestionEpoch())}
                        >
                          {sg.name} {c != null ? `${Math.round(c * 100)}%` : '--'}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

        {rowCount === 0 &&
          (mode === 'list' && tab === 'favorites' && !q ? (
            <div className="picker-empty">{tr('fav_empty')}</div>
          ) : fxEnabled && !fx && index && isFormulaTrigger(query, tab, index) ? (
            // a typed formula outside formula mode: the clone's dead end
            // becomes the way in — the mode stays explicit, the text is never
            // re-interpreted behind the user's back
            <button className="picker-empty pk-fx-nudge" onClick={enterFx}>
              <b aria-hidden="true">ƒx</b> {tr('fx_nudge')}
            </button>
          ) : (
            <div className="picker-empty">{tr('no_match')}</div>
          ))}
      </div>

      {footer}
    </div>
  );
}
