import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, Interval, Market } from '../lib/hl/types';
import { INTERVALS, INTERVAL_MS, KIND_LABEL } from '../lib/hl/types';
// The facade, not info.ts/ws.ts directly: plain coins pass straight through,
// formula coins (`=…`) fan out to their legs and come back as ordinary
// candles — this file never learns what a leg is.
import {
  clearCandleQuarantine,
  fetchCandles,
  isCandleQuarantined,
  legsOf,
  subscribeCandle,
  resubscribeCandle,
} from '../lib/hl/formulaFeed';
import { evictCandles, storeCandles, takeCandles } from '../lib/hl/candleCache';
import { compactUsd, fmtFunding, fundingApr, type MarketStats } from '../lib/hl/stats';
import { hlSocket } from '../lib/hl/ws';
import { scheduleRender } from '../lib/renderQueue';
import {
  barContaining,
  broadcastCrosshair,
  broadcastRange,
  broadcastViewReset,
  isEchoRange,
  isTouchSource,
  logicalToTime,
  reapplyCursor,
  reapplyRange,
  registerCrosshair,
  RIGHT_WHITESPACE_BARS,
  setTouchSource,
} from '../lib/crosshairSync';
import { useT } from '../lib/i18n';
import { IS_COARSE } from '../lib/media';
import { onManualRefresh } from '../lib/refreshBus';
import { useAlerts } from '../lib/alerts';
import { onAlertFire } from '../lib/alertEngine';
import { setTitleSource, type TitleSlot } from '../lib/pageTitle';
import { usePopoverDismiss } from '../lib/usePopoverDismiss';
import { AlertLines } from './AlertLines';
import { WatchChip, WatchOverlay } from './WatchOverlay';
import { AlertPopover } from './AlertPopover';

/**
 * Per-cell freshness: a socket that answers pings while ONE subscription is
 * dead — a subscribe HL never acked, a market halted mid-session, a stalled
 * server feed — has no other detector, and the candle channel pushes only on
 * trades, so silence alone proves nothing. A PLAIN cell that is on screen
 * (or owns the tab title) and has had no tick for FRESHNESS_SILENCE_MS
 * spends ONE ~21-weight snapshot from the newest bar the SOCKET delivered
 * (painted or banked — in a hidden tab rAF paints nothing, so `bars` lags
 * the feed): newer data means the feed is dead → resubscribeCandle on the
 * wire + the ordinary reconnect-heal recipe (dim, gap merge); the same bar
 * means a quiet market — nothing dimmed, nothing rebuilt; a tick during the
 * round trip voids the verdict. Formula cells are not checked (a live leg
 * masks a dead one; a check would cost one snapshot per leg). Worst case
 * (16 quiet plain markets on screen) ≈ 67 weight/min against the 1200/min
 * budget.
 */
const FRESHNESS_SILENCE_MS = 5 * 60_000;
const FRESHNESS_CHECK_MS = 60_000;

/**
 * One legend formatter per decimals tier, shared by every cell.
 * `toLocaleString(opts)` builds a fresh Intl.NumberFormat on every call —
 * ~10µs against ~0.2µs for a cached one — and the legend formats four
 * numbers per cell per frame for as long as a linked crosshair is being
 * dragged, on every cell at once. Same trick, same reason, as fmtPrice's
 * priceFmts map in MarketTable.
 * Keyed on `decimals` because both bounds derive from it; the emitted text is
 * identical to an inline toLocaleString call with the same options.
 */
const legendFmts = new Map<number, Intl.NumberFormat>();
function legendFmt(decimals: number): Intl.NumberFormat {
  let f = legendFmts.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: Math.min(decimals, 2),
      maximumFractionDigits: decimals,
    });
    legendFmts.set(decimals, f);
  }
  return f;
}

/*
 * History strategy, mirroring HL's own chart: load a recent window up front,
 * then lazily fetch older chunks as the user scrolls left, until the API's
 * depth is exhausted (~5000 bars/interval; years on 1d+). A full 5000-bar
 * fetch costs ~104 REST weight — 16 charts at once would blow the
 * 1200/min/IP budget, hence the incremental approach.
 */
const BACKFILL_BARS = 600;
const OLDER_CHUNK_BARS = 2000;

// Default framing adapts to the CELL's width — a fixed bar count reads as
// slivers on a 5×4 grid and as sparse giants fullscreen. ~5.5px per bar is
// the readable sweet spot; clamps keep enough structure (40) and cap the
// span (200). Used by initial load, double-click reset, retimes, and the
// grid-reshape re-frame — every "give me a fresh look" path.
const TARGET_BAR_PX = 5.5;
const MIN_DEFAULT_BARS = 40;
const MAX_DEFAULT_BARS = 200;
const defaultBars = (w: number): number => {
  if (w <= 0) return 160; // width never measured — a fixed fallback
  return Math.max(MIN_DEFAULT_BARS, Math.min(MAX_DEFAULT_BARS, Math.round(w / TARGET_BAR_PX)));
};
/* Linked-wall pagination fan-out fetches smaller chunks: 24 cells × 2000-bar
   chunks ≈ 24×53 REST weight in one wave — past the 1200/min budget
   (Invariant 5). 600 bars ≈ 30 weight each keeps a full-wall wave ~720. */
const SYNC_CHUNK_BARS = 600;
const LOAD_MORE_THRESHOLD_BARS = 120;
const UP = '#1fbf75';
const DOWN = '#f6465d';
const UP_FADED = 'rgba(31, 191, 117, 0.35)';
const DOWN_FADED = 'rgba(246, 70, 93, 0.35)';

/*
 * lightweight-charts has no timezone option; the standard recipe is shifting
 * the epoch so the axis renders the desired wall-clock time. Bars keep raw ms
 * everywhere — the shift happens ONLY here at series mapping.
 */
function toBar(c: Candle, tzOffsetSec: number) {
  return {
    time: (c.t / 1000 + tzOffsetSec) as UTCTimestamp,
    open: Number(c.o),
    high: Number(c.h),
    low: Number(c.l),
    close: Number(c.c),
  };
}

function toVolume(c: Candle, tzOffsetSec: number) {
  return {
    time: (c.t / 1000 + tzOffsetSec) as UTCTimestamp,
    // USD notional (base volume × close): one unit across every market
    value: Number(c.v) * Number(c.c),
    color: Number(c.c) >= Number(c.o) ? UP_FADED : DOWN_FADED,
  };
}

/**
 * A formula name ('HYPE÷ETH', '(HYPE+ETH)÷2') as spans: operator glyphs,
 * parentheses and constants dim, tickers plain, and a <wbr> after every
 * operator and '(' so a long name breaks at operators, never mid-ticker
 * (the never-truncate rule). Nothing invisible goes into the string itself —
 * a U+200B would leak into the tooltip and the picker chips.
 */
function renderFormulaName(name: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /[÷×−+()]/g;
  const piece = (s: string, key: string) =>
    /^\d+(?:\.\d+)?$/.test(s) ? (
      <span key={key} className="fx-op">
        {s}
      </span>
    ) : (
      <span key={key}>{s}</span>
    );
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) {
    if (m.index > last) out.push(piece(name.slice(last, m.index), `t${last}`));
    out.push(
      <span key={`o${m.index}`} className="fx-op">
        {m[0]}
      </span>,
    );
    if (m[0] !== ')') out.push(<wbr key={`w${m.index}`} />);
    last = m.index + 1;
  }
  if (last < name.length) out.push(piece(name.slice(last), `t${last}`));
  return out;
}

/** HL sends exact decimal strings ("61513.0", "0.034") — read precision off them. */
function decimalsOf(price: string): number {
  const dot = price.indexOf('.');
  return dot === -1 ? 0 : Math.min(price.length - dot - 1, 8);
}

type Status = 'empty' | 'loading' | 'live' | 'error';

interface Props {
  market: Market | null;
  interval: Interval;
  /** Polled table stats (funding/OI/volume/prevDayPx) for the badges row. */
  marketStats: MarketStats | null;
  /**
   * True while the catalog is still loading (or retrying) and this cell has
   * a saved coin that can't resolve yet. Shows the loading overlay instead
   * of "Select market" so a saved wall never flashes as wiped.
   */
  catalogPending: boolean;
  /** WS reconnecting: dim the price so a stale last-known value never reads as live. */
  stale: boolean;
  cellIndex: number;
  /** Show TradingView's canvas logo (used when page chrome carries no attribution link). */
  attributionLogo: boolean;
  /** Axis timezone shift in seconds (0 = UTC, local offset = wall-clock time). */
  tzOffsetSec: number;
  onIntervalChange: (interval: Interval) => void;
  onPickMarket: () => void;
  onClear: () => void;
  onPopOut: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Touch reorder: long-pressing the header enters arrange mode (absent in mini windows). */
  onArrange?: () => void;
  /** Touch drag-to-swap: preferred long-press action when set —
   *  hands the press origin AND its pointerId to the App-level drag session
   *  (the session pins itself to that one finger), which follows it and
   *  swaps on drop (hold-still falls back to arrange). Returns false when
   *  the session was REFUSED (another drag is live) so the caller can skip
   *  the vibrate/click-swallow side effects — nothing happened. */
  onLift?: (x: number, y: number, pointerId: number) => boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  /** Fullscreen pager: a horizontal swipe on the header pages the wall's
   *  charts (the ‹ › buttons and chip strip are the primary affordance —
   *  this is the natural-gesture bonus). Wall-expanded only. */
  onPage?: (dir: 1 | -1) => void;
  /** Visibility gating: true while another cell's fullscreen overlay fully
   *  occludes this one — same gating as offscreen (IO can't see occlusion). */
  paused: boolean;
  /** This cell drives the tab title (lib/pageTitle.ts): 'focus' for the one
   *  market on screen (expanded cell, list card), 'wall' for the wall's
   *  first market. Undefined = not this cell. */
  titleSlot?: TitleSlot;
}

export function ChartCell({
  market,
  interval,
  marketStats,
  catalogPending,
  stale,
  cellIndex,
  attributionLogo,
  tzOffsetSec,
  onIntervalChange,
  onPickMarket,
  onClear,
  onPopOut,
  onDragStart,
  onDragEnd,
  onArrange,
  onLift,
  expanded,
  onToggleExpand,
  onPage,
  paused,
  titleSlot,
}: Props) {
  const tr = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  /** Bumped whenever the chart's data context changes; stale async work checks it. */
  const epochRef = useRef(0);
  const decimalsRef = useRef(2);
  /** Mount-effect's legend writer, reachable from the data effect (clear on switch). */
  const setLegendRef = useRef<(bar: CandlestickData<Time> | null) => void>(() => {});
  /** Current interval in seconds, for the wall-link registry's time mapping. */
  const intervalSecRef = useRef(INTERVAL_MS[interval] / 1000);
  /**
   * Range notifications land a frame AFTER setVisibleLogicalRange, so
   * programmatic view changes (initial backfill window, pagination re-anchor)
   * can't be flag-guarded — they'd broadcast the whole wall onto this cell if
   * the pointer happens to rest here. A short deadline swallows them; real
   * pans re-fire continuously so losing the first ~300ms changes nothing.
   */
  const suppressBroadcastUntilRef = useRef(0);
  const renderKey = useId();

  // Guard against a transiently-missing prop (e.g. HMR applying this module
  // before the parent re-renders): NaN times would poison every series.
  const tzOff = Number.isFinite(tzOffsetSec) ? tzOffsetSec : 0;

  /** Mount-time attribution snapshot — see the createChart layout comment. */
  const initialAttrLogoRef = useRef(attributionLogo);
  const [status, setStatus] = useState<Status>('empty');
  const [tick, setTick] = useState<{ price: number; dir: 1 | -1 | 0 } | null>(null);
  /** Honest-freshness window: true from a heal TRIGGER (tab return, WS
   *  reconnect) until the gap-fill actually lands — the price dims so a
   *  last-known number can never masquerade as live. */
  const [healing, setHealing] = useState(false);

  // Tab title plumbing (lib/pageTitle.ts): slot/name/market mirror the
  // latest render (assigned in the render body below); the price is the
  // header's exact string, noted from the socket callback and the two REST
  // seeds — NOT from React state, which a hidden tab's suspended rAF never
  // updates; publishTitle composes them.
  const titleSlotRef = useRef<TitleSlot | undefined>(undefined);
  const titleNameRef = useRef('');
  const titleMarketRef = useRef<Market | null>(null);
  /** The header's exact price string; null = nothing honest to show (no
   *  data yet, a cache-resumed number the header dims, or a hidden stale
   *  one). Only a FRESH price — a tick, a landed backfill or heal — sets
   *  it; the `stale` flag clearing never restores a banked value. */
  const titlePriceRef = useRef<string | null>(null);
  const publishTitle = useCallback(() => {
    const slot = titleSlotRef.current;
    if (!slot || !titleMarketRef.current) return;
    setTitleSource(slot, { name: titleNameRef.current, price: titlePriceRef.current });
  }, []);
  const noteTitlePrice = useCallback(
    (text: string | null) => {
      titlePriceRef.current = text;
      publishTitle();
    },
    [publishTitle],
  );
  const [refresh, setRefresh] = useState(0);
  // right edge away from the newest candle → the » back-to-now button shows
  const [offRealtime, setOffRealtime] = useState(false);
  // last (coin, interval) the data effect ran for — detects retimes
  const prevViewRef = useRef<{ coin: string | null; interval: Interval } | null>(null);
  // last REAL (non-zero) container width. The wall is display:none under
  // the list view, where clientWidth reads 0 — a cell reloading there
  // (add-to-wall, heal) must still frame for the width it will get back.
  const widthRef = useRef(0);
  const measuredWidth = () => {
    const w = containerRef.current?.clientWidth ?? 0;
    return w > 0 ? w : widthRef.current;
  };
  /** Change%, Σvolume and relative volume over the VISIBLE bars. */
  const [rangeStats, setRangeStats] = useState<{
    chg: number | null;
    /** last close − first open; the formula cell's Δ when a % is meaningless
     *  (a spread crossing zero, or opening at exactly 0) */
    chgAbs: number;
    volUsd: number;
    rvol: number | null;
  } | null>(null);

  // Price alerts: the 🔔 popover (a disclosure — bell + popover share one
  // wrapper ref for outside-click dismissal) and the fired-alert flash.
  const [alertsOpen, setAlertsOpen] = useState(false);
  const bellWrapRef = useRef<HTMLSpanElement>(null);
  usePopoverDismiss(alertsOpen, bellWrapRef, () => setAlertsOpen(false));
  const alerts = useAlerts();
  const hasAlerts = market != null && alerts.some((a) => a.coin === market.coin);
  const [alertFlash, setAlertFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      // Normal = the crosshair follows the exact pointer position; the
      // default Magnet snaps it to bar centers/close prices, and the dashed
      // lines must track the mouse, not park on candles
      crosshair: { mode: CrosshairMode.Normal },
      // Coarse pointers only: release vertical touch drags back to the page
      // so a finger starting on a chart scrolls the wall instead of getting
      // swallowed by the chart's own pan handler. Horizontal drag + pinch
      // zoom (handleScale, untouched) still work for panning/zooming time.
      ...(IS_COARSE
        ? {
            handleScroll: {
              mouseWheel: true,
              pressedMouseMove: true,
              horzTouchDrag: true,
              vertTouchDrag: false,
            },
          }
        : {}),
      layout: {
        background: { color: 'transparent' },
        textColor: '#8b99aa',
        fontSize: 11,
        // Off on all walls (the topbar carries a TradingView attribution
        // link at every width — ≤900px topbars use the compact
        // attribution-nw variant); on in chromeless mini windows and
        // fullscreen overlays (expanded cell, list card — Invariant 8).
        // Mount-time value via a ref, NOT the prop: the prop is dynamic
        // (expand flips it) and in mount deps it would destroy the chart
        // while the data effect never re-runs — a blank wall. Changes land
        // via the applyOptions effect below.
        attributionLogo: initialAttrLogoRef.current,
      },
      grid: {
        vertLines: { color: 'rgba(125, 138, 153, 0.08)' },
        horzLines: { color: 'rgba(125, 138, 153, 0.08)' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(125, 138, 153, 0.25)',
        // "where we are" breathing room right of the newest candle;
        // scrollToRealTime() (the » button) lands with the same offset
        rightOffset: RIGHT_WHITESPACE_BARS,
      },
      rightPriceScale: { borderColor: 'rgba(125, 138, 153, 0.25)' },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    if (import.meta.env.DEV) {
      (el as HTMLDivElement & { __chart?: IChartApi }).__chart = chart;
    }

    // Top-left OHLC legend: imperative DOM writes on the crosshair path —
    // a React state update per mousemove would re-render the whole cell.
    const setLegend = (bar: CandlestickData<Time> | null) => {
      const legend = legendRef.current;
      if (!legend) return;
      if (!bar) {
        legend.style.display = 'none';
        return;
      }
      const nf = legendFmt(decimalsRef.current);
      const fmt = (n: number) => nf.format(n);
      const [ohl, c, chg] = legend.children as unknown as HTMLSpanElement[];
      ohl.textContent = `O ${fmt(bar.open)} H ${fmt(bar.high)} L ${fmt(bar.low)}`;
      c.textContent = `C ${fmt(bar.close)}`;
      // the candle's own move, open→close
      const pct = bar.open !== 0 ? ((bar.close - bar.open) / bar.open) * 100 : null;
      chg.textContent = pct === null ? '' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      chg.className = `lg-chg${pct === null ? '' : pct > 0 ? ' up' : pct < 0 ? ' down' : ''}`;
      legend.style.display = 'flex';
    };
    setLegendRef.current = setLegend;

    // Touch sourceship: :hover can't identify the gesturing cell on coarse
    // pointers, so the last PRIMARY chart-body touch claims it (and keeps it
    // through kinetic momentum after lift — see crosshairSync). isPrimary:
    // a second finger landing on another cell mid-gesture must not steal
    // sourceship from the finger that is actually panning.
    const onTouchSource = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && e.isPrimary) setTouchSource(renderKey);
    };
    if (IS_COARSE) el.addEventListener('pointerdown', onTouchSource);
    // Tap-anywhere-clears: the library's OnNextTap exit only serves the cell
    // whose OWN tracking session is active — and the pointerdown above just
    // moved sourceship to the tapped cell, so the old source's exit event
    // would be gate-blocked forever: a parked wall cursor could only be
    // cleared by tapping the exact cell that created it. A clean tap
    // (<300ms, <8px, not on a button/select) on ANY chart clears the
    // wall-wide cursor.
    let tapStart: { x: number; y: number; at: number } | null = null;
    const onTapDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      if ((e.target as HTMLElement).closest('button, select')) return;
      tapStart = { x: e.clientX, y: e.clientY, at: performance.now() };
    };
    const onTapUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !tapStart) return;
      const isTap =
        performance.now() - tapStart.at < 300 &&
        Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) < 8;
      tapStart = null;
      if (!isTap) return;
      setLegend(null);
      broadcastCrosshair(renderKey, {} as MouseEventParams);
    };
    if (IS_COARSE) {
      el.addEventListener('pointerdown', onTapDown);
      el.addEventListener('pointerup', onTapUp);
    }
    /**
     * Gesture-source gate — EXCLUSIVE per device class, never an OR. An OR
     * lets TWO cells pass at once: iOS parks emulated :hover on a
     * previously-tapped cell, and on hybrid laptops one stray touch pins
     * sourceship no mouse move can ever clear — either way the crosshair
     * path (which, unlike ranges, has no echo recognition) turns
     * synthetic-crosshair echoes into a sourceship-stealing ping-pong.
     * Coarse devices trust ONLY touch sourceship; fine devices ONLY :hover.
     */
    const isSource = IS_COARSE
      ? () => isTouchSource(renderKey)
      : () => el.matches(':hover');

    // Linked cursors: other cells' setCrosshairPosition echoes fire this
    // subscription too — only the cell actually under the pointer broadcasts;
    // its own legend updates here, synced cells' legends via the registry.
    const onCrosshairMove = (param: MouseEventParams) => {
      if (!isSource()) return;
      const t = typeof param.time === 'number' ? param.time : null;
      // exact bar under the cursor; nearest-left when over right whitespace
      const bar =
        t === null
          ? null
          : ((param.seriesData.get(candleSeries) as CandlestickData<Time> | undefined) ??
            barContaining(candleSeries, t));
      setLegend(bar && 'close' in bar ? bar : null);
      broadcastCrosshair(renderKey, param);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);
    // The leave event reaches crosshairMove with :hover already FALSE, so the
    // guard above swallows it — the wall would keep the last cursor parked
    // forever (and the legend with it). A real DOM mouseleave is unambiguous:
    // clear locally, broadcast the clear (echoes never fire mouseleave).
    // NOT on coarse pointers: iOS fires synthetic mouseleave after taps,
    // which would wipe a deliberately parked tracking crosshair — touch
    // clears via the library's own exit tap (OnNextTap → time=undefined
    // reaches onCrosshairMove while this cell still holds sourceship).
    const onLeave = () => {
      setLegend(null);
      broadcastCrosshair(renderKey, {} as MouseEventParams);
    };
    if (!IS_COARSE) el.addEventListener('mouseleave', onLeave);
    const unregisterCrosshair = registerCrosshair(renderKey, {
      chart,
      series: candleSeries,
      el,
      setLegend,
      getIntervalSec: () => intervalSecRef.current,
      // DELIBERATELY NOT cellHidden(): an EXPANDED cell must still count as
      // hidden here. It paints (that is what cellHidden governs), but it must
      // stay out of the crosshair link — its window is viewport-wide, and
      // letting reapplyRange re-adopt it rewrites the whole wall's window.
      // Paint visibility and link membership are two different questions;
      // keep these two predicates separate.
      isHidden: () => !visibleRef.current || pausedRef.current,
    });

    // Linked zoom/pan: only the cell under the pointer drives the wall, in
    // TIME (bar indices don't compare across intervals). Echo recognition
    // replaces a sync flag — see isEchoRange for why timing can't work.
    const onRangeSync = (lr: { from: number; to: number } | null) => {
      if (!lr) return;
      if (!isSource()) return;
      if (performance.now() < suppressBroadcastUntilRef.current) return;
      if (isEchoRange(renderKey, lr)) return;
      const data = candleSeries.data();
      if (data.length === 0) return;
      const iv = intervalSecRef.current;
      // right edge at/past the newest candle = live; travels as a SEMANTIC
      // (whitespace bar count) so receivers re-anchor to their own newest
      // candle with the same whitespace (crosshairSync)
      const ws = lr.to - (data.length - 1);
      broadcastRange(
        renderKey,
        logicalToTime(data, iv, lr.from),
        logicalToTime(data, iv, lr.to),
        ws >= -0.01 ? Math.max(0, ws) : null,
      );
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeSync);

    // Grid reshapes (3×3 → 5×4) change the readable bar budget: cells
    // sitting at the live edge re-frame to the new width's default view;
    // anything scrolled into history is deliberate positioning — untouched.
    // widthRef doubles as the last REAL width for hidden-wall reloads
    // (display:none reads 0 — never adopt that). The 15% gate skips resize
    // noise; an equal-width fire (mount, return from the list view) is a
    // no-op.
    widthRef.current = el.clientWidth > 0 ? el.clientWidth : widthRef.current;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w <= 0) return; // hidden under the list view — keep the last real width
      const prev = widthRef.current;
      widthRef.current = w;
      if (prev === w) return;
      if (prev > 0 && Math.abs(w - prev) / prev < 0.15) return;
      const data = candleSeries.data();
      const lr = chart.timeScale().getVisibleLogicalRange();
      if (!lr || data.length === 0) return;
      if (lr.to < data.length - 1 - 0.01) return; // off the live edge
      suppressBroadcastUntilRef.current = performance.now() + 300;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, data.length - defaultBars(w)),
        to: data.length - 1 + RIGHT_WHITESPACE_BARS,
      });
    });
    ro.observe(el);

    return () => {
      epochRef.current++;
      ro.disconnect();
      unregisterCrosshair();
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeSync);
      if (IS_COARSE) {
        el.removeEventListener('pointerdown', onTouchSource);
        el.removeEventListener('pointerdown', onTapDown);
        el.removeEventListener('pointerup', onTapUp);
      }
      if (!IS_COARSE) el.removeEventListener('mouseleave', onLeave);
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      chart.remove();
    };
  }, [renderKey]);

  // Runtime attribution toggle (Invariant 8): expanding or collapsing the
  // cell flips the prop → the logo must appear/disappear WITHOUT rebuilding
  // the chart (attributionLogo is an ordinary LayoutOptions member).
  useEffect(() => {
    chartRef.current?.applyOptions({ layout: { attributionLogo } });
  }, [attributionLogo]);

  /*
   * Survives effect re-runs so a reconnect/visibility heal can resume from
   * the last known bar instead of wiping. `bars` ALIASES the data effect's
   * live array (same reference, mutated in place by applyCandle) — it is
   * re-pointed wherever the effect REASSIGNS its `bars` binding (backfill
   * seed, loadOlder prepend) and nulled whenever the series stops matching
   * it (wipe on the full path, so market/interval switches and failed
   * backfills can never seed a heal from bars the series no longer holds).
   */
  const healRef = useRef<{ coin: string; interval: Interval; bars: Candle[] } | null>(null);
  /** Set ONLY by the two heal triggers below; consumed (and cleared) by the data effect. */
  const pendingHealRef = useRef(false);

  /*
   * Visibility gating. A hidden cell (scrolled out of the narrow wall, wall
   * display:none under the list or positions view, or occluded by another
   * cell's fullscreen overlay — the `paused` prop, since IO can't see
   * occlusion) stops painting: WS ticks bank per-bar in the data effect's
   * offscreen buffer, broadcast range/cursor applies skip it (isHidden in
   * the registry), and heal triggers park in staleWhileHiddenRef. On
   * re-entry onShownRef (re-armed by each data-effect run, epoch-safe)
   * flushes the buffer, rejoins the wall's window/cursor, or fires the
   * parked heal. WS stays SUBSCRIBED throughout — the teardown grace of
   * Invariant 2 is about sockets, this is only about paint work.
   */
  const visibleRef = useRef(true);
  const pausedRef = useRef(paused);
  const expandedRef = useRef(expanded);
  const onShownRef = useRef<(() => void) | null>(null);
  /** A heal trigger fired while hidden — run it on re-entry instead. */
  const staleWhileHiddenRef = useRef(false);
  /**
   * PAINT visibility. `visibleRef` alone is wrong for a fullscreen cell:
   * `.cell-slot.expanded` is `position: fixed`, which takes it out of the
   * `.grid` root's containing-block chain, so this cell's own observer reports
   * it with an EMPTY intersection rect (rootBounds 0x0, isIntersecting false;
   * restored on collapse). It is the one chart on screen, and gated on
   * `visibleRef` alone it would bank its ticks instead of painting them — a
   * frozen fullscreen price that silently catches up on collapse.
   *
   * NOTE this deliberately DIVERGES from the crosshair registry's `isHidden`
   * (the registerCrosshair call in the mount effect), which must keep
   * counting an expanded cell as hidden — see the comment there before
   * making the two agree.
   */
  const cellHidden = () => (!visibleRef.current && !expandedRef.current) || pausedRef.current;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        const was = visibleRef.current;
        visibleRef.current = entry.isIntersecting;
        if (!was && entry.isIntersecting && !pausedRef.current) onShownRef.current?.();
      },
      // pre-trigger one cell-height early so flush/heal land before the
      // cell's pixels actually enter the viewport. root MUST be the .grid
      // scroller: with the viewport root, ancestor clipping wins and
      // rootMargin never fires early on the narrow wall — the one surface
      // that scrolls. Outside a .grid (list card) the viewport fallback is
      // fine: nothing scrolls there.
      { root: el.closest('.grid'), rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const was = pausedRef.current;
    pausedRef.current = paused;
    if (was && !paused && visibleRef.current) onShownRef.current?.();
  }, [paused]);
  // Going fullscreen can un-hide a cell the grid had scrolled past — the ‹ ›
  // pager moves the expanded class to any adjacent non-empty cell, offscreen
  // ones included, and that cell has been banking ticks. Collapsing back onto
  // a still-visible cell is the IO's job (it re-fires intersecting), so this
  // only has to cover the transitions the observer cannot see.
  useEffect(() => {
    const wasHidden = cellHidden();
    expandedRef.current = expanded;
    if (wasHidden && !cellHidden()) onShownRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cellHidden reads refs only
  }, [expanded]);

  // Mobile IA: the wall is the GLANCE layer (vertical touches belong to the
  // page), fullscreen is the INTERACT layer. Entering hands vertical drags
  // to the chart AND freezes autoscale — the library's startScrollPrice is a
  // no-op while autoScale is on, and the TradingView convention is exactly
  // this: a focus view pans freely, double-tap resets (resetView re-enables
  // autoscale). Leaving restores glance behavior.
  useEffect(() => {
    if (!IS_COARSE) return;
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: expanded,
      },
    });
    chart.priceScale('right').applyOptions({ autoScale: !expanded });
  }, [expanded]);

  // Heal data gaps: WS candle never replays closed bars, so after a socket
  // reconnect or a long-hidden tab the only fix is a fresh REST fetch. The
  // pending flag asks the data effect for a gap-fill instead of a full wipe;
  // manual retries and market/interval changes never set it.
  // Hidden cells DEFER instead: the heal parks in staleWhileHiddenRef and
  // runs on scroll-into-view — a reconnect on a 24-cell phone wall must not
  // fan out 24 gap fetches for 3 visible cells. healing=true immediately:
  // if the cell edges into view before the parked heal lands, its price is
  // already honestly dimmed.
  const requestHeal = () => {
    // The cell that owns the tab title never parks: its number is read while
    // the wall sits under the list view or off-screen — one ~21-weight
    // fetch keeps that title honest.
    if (cellHidden() && !titleSlotRef.current) {
      staleWhileHiddenRef.current = true;
      setHealing(true);
      return;
    }
    pendingHealRef.current = true;
    setHealing(true);
    setRefresh((r) => r + 1);
  };
  const requestHealRef = useRef(requestHeal);
  requestHealRef.current = requestHeal;
  useEffect(() => hlSocket.onReconnect(() => requestHealRef.current()), []);
  // Pull-to-refresh rides the exact reconnect recipe: request a gap-heal,
  // dim the price until it lands. Error cells degrade to the full path
  // (healRef is null there), so a pull doubles as "retry everything".
  useEffect(() => onManualRefresh(() => requestHealRef.current()), []);
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (hiddenAt && Date.now() - hiddenAt > 30_000) {
        requestHealRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // The effects below key on the market's IDENTITY FIELDS, never on the
  // Market object: the catalog is live (hl/catalogSync.ts), and a refreshed
  // object for the same coin — a new display name, a leverage change, a
  // fallback Market swapped for the real one — must repaint the header, not
  // re-run the data effect (viewport reset, dimmed price, a gap fetch). Their
  // bodies read these two values, never `market` itself (Invariant 12).
  const marketCoin = market?.coin ?? null;
  const marketKind = market?.kind ?? null;

  // Fired-alert flash: a short border pulse on this cell. Gated on
  // !cellHidden() — a flash nobody can see is wasted paint, and the toast
  // stack already carries the news. Null-then-rAF restarts the CSS
  // animation when the same cell fires twice in a row.
  useEffect(() => {
    if (marketCoin === null) return;
    let timer = 0;
    const un = onAlertFire((f) => {
      if (f.alert.coin !== marketCoin || cellHidden()) return;
      setAlertFlash(null);
      requestAnimationFrame(() => setAlertFlash(f.dir));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAlertFlash(null), 1600);
    });
    return () => {
      un();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cellHidden reads refs only
  }, [marketCoin]);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;

    epochRef.current++;
    const epoch = epochRef.current;
    // Composed bars carry no volume (v='0'): hide the histogram on formula
    // cells rather than paint zero-height bars; a swap back restores it.
    volumeSeries.applyOptions({ visible: marketKind !== 'formula' });
    // Any run supersedes a heal parked while hidden: a full (re)load fetches
    // fresh history and a heal run consumes pendingHealRef — leaving the
    // flag set would fire a spurious gap fetch on the next reveal after a
    // market/interval switch.
    staleWhileHiddenRef.current = false;
    intervalSecRef.current = INTERVAL_MS[interval] / 1000;
    suppressBroadcastUntilRef.current = performance.now() + 300;
    // Cancels this run's REST work on teardown: fetches still PARKED behind
    // the concurrency cap are discarded before they ever spend budget, and
    // dead retry loops stop. In-flight responses finish (dedupe-shared).
    const ac = new AbortController();
    let retimeTimer = 0;

    // A retime (same market, new interval) means "show me this timeframe's
    // structure" — it re-frames to the new interval's default view instead
    // of rejoining the wall's old TIME window (which renders 160 hours as a
    // handful of giant daily candles).
    const prevView = prevViewRef.current;
    const intervalRetime =
      prevView !== null && prevView.coin === marketCoin && prevView.interval !== interval;
    prevViewRef.current = { coin: marketCoin, interval };

    /*
     * Heal mode: a reconnect/visibility-return re-run resumes from the bars
     * the series already renders — no wipe flash, no loading overlay, no
     * viewport snap — and only fetches the gap since the last known bar.
     */
    const healSaved = healRef.current;
    const heal =
      pendingHealRef.current &&
      marketCoin !== null &&
      healSaved !== null &&
      healSaved.coin === marketCoin &&
      healSaved.interval === interval &&
      healSaved.bars.length > 0 &&
      // Gaps beyond a full backfill are cheaper to reload outright.
      Math.floor(
        (Date.now() - healSaved.bars[healSaved.bars.length - 1].t) / INTERVAL_MS[interval],
      ) <= BACKFILL_BARS;
    pendingHealRef.current = false;

    // Session-cache resume: a (coin, interval) pair seen earlier this
    // session repaints instantly from its dormant bars and heals only the
    // gap (~20 weight) instead of paying a full backfill (~30) — the
    // return legs of an interval tour become near-free.
    const resumed =
      !heal && marketCoin !== null
        ? takeCandles(marketCoin, interval, BACKFILL_BARS, INTERVAL_MS[interval])
        : null;

    if (!heal) {
      if (resumed && marketCoin !== null) {
        // The series keeps the PREVIOUS market's price format across an
        // in-place swap, and applyCandle's live ratchet only ever RAISES
        // precision — so a cell returning to BTC from a 6-decimal coin
        // would print "78713.000000" until a full reload. Recompute from
        // the resumed bars — same recipe as the backfill path below.
        let cachedDecimals = 0;
        for (const c of resumed.slice(-50)) cachedDecimals = Math.max(cachedDecimals, decimalsOf(c.c));
        decimalsRef.current = cachedDecimals;
        candleSeries.applyOptions({
          priceFormat: { type: 'price', precision: cachedDecimals, minMove: 10 ** -cachedDecimals },
        });
        // instant paint from cache + fresh default framing for the arrival;
        // the heal-style gap fetch below brings it current (healing badge
        // dims the price until then — same honesty contract as reconnects)
        candleSeries.setData(resumed.map((c) => toBar(c, tzOff)));
        volumeSeries.setData(resumed.map((c) => toVolume(c, tzOff)));
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, resumed.length - defaultBars(measuredWidth())),
          to: resumed.length - 1 + RIGHT_WHITESPACE_BARS,
        });
        chart.priceScale('right').applyOptions({ autoScale: true });
        setHealing(true);
        setOffRealtime(false); // seeded at the live edge — a stale » must not linger
      } else {
        candleSeries.setData([]);
        volumeSeries.setData([]);
        // The series was just wiped, so any saved bars no longer describe it.
        // Re-pointed only when this run's backfill lands — a failed or aborted
        // full load leaves the ref null and the next heal request degrades to
        // the full path instead of update()-ing stale bars into a fresh series.
        healRef.current = null;
      }
      // resume keeps a price to DIM (the honesty contract is "dim, don't
      // blank"); a wipe has nothing honest to show until data lands
      setTick(
        resumed && resumed.length > 0
          ? { price: Number(resumed[resumed.length - 1].c), dir: 0 }
          : null,
      );
      // the title cannot dim a resumed number the way the header does —
      // name-only until the heal lands (applyCandle notes the merged close)
      noteTitlePrice(null);
      setRangeStats(null);
      setLegendRef.current(null); // stale OHLC must not survive a market switch
    }

    if (marketCoin === null) {
      setStatus('empty');
      return;
    }
    if (isCandleQuarantined(marketCoin, interval)) {
      // HL closes the shared socket on this id (hl/ws.ts quarantine): land
      // on the error overlay without spending REST or the socket. Only the
      // overlay's Retry lifts it — a click is the one honest signal that the
      // id deserves another attempt; the paced self-heal below stays off.
      healRef.current = null;
      setStatus('error');
      setHealing(false);
      return;
    }
    if (!heal) setStatus(resumed ? 'live' : 'loading');

    const coin = marketCoin;
    // A formula cell pages EVERY leg per chunk — divide so a linked-wall
    // pagination wave of N-leg cells stays near a plain wave's weight (each
    // request carries ~20 fixed weight, so it is ~2× for 4 legs, not parity).
    const legCount = legsOf(coin)?.length || 1;
    const chunkFor = (bars: number) => Math.max(100, Math.floor(bars / legCount));
    const end = Date.now();
    const start = end - INTERVAL_MS[interval] * BACKFILL_BARS;
    // Heal keeps the tick direction continuous: the first merged candle
    // compares against the last known close (exactly what the full path
    // seeds after setData) instead of flashing a bogus neutral/up/down.
    const seedBars = heal && healSaved ? healSaved.bars : resumed;
    let prevClose = seedBars && seedBars.length > 0 ? Number(seedBars[seedBars.length - 1].c) : 0;
    let snapshotDone = false;
    // Cache-worthiness gate: true only after a REAL snapshot settled this
    // run (full backfill, or seed + gap merge). Without it, a failed load's
    // WS-scrap bars (1-2 tick-built candles) would get banked at teardown
    // and the retry would "resume" a two-candle chart as live, skipping the
    // backfill forever.
    let snapshotClean = false;
    /** The socket quarantined this id (hl/ws.ts): the verdict is final for
     *  this run, so the aborted fetch's catch has nothing to add. */
    let wsRejected = false;
    /** Ticks that arrive while the backfill is in flight, latest per bar. */
    const preSnapshot = new Map<number, Candle>();
    /** Ticks that arrive while the cell is HIDDEN, latest per bar — same
     *  per-bar shape as preSnapshot, flushed by onShown. */
    const offscreen = new Map<number, Candle>();
    /**
     * Full loaded history for this (market, interval) epoch, ascending by t.
     * Heal mode seeds it by REFERENCE from healRef: the series already holds
     * exactly these bars, so no setData is needed, and loadOlder/rangeStats
     * keep reading the same array they always did.
     */
    let bars: Candle[] = seedBars ?? [];
    let loadingOlder = false;
    let noMoreHistory = false;
    /** Last proof this cell's feed is alive: a tick, or a REST landing. */
    let lastTickAt = Date.now();
    /** The newest candle this run has SEEN from any path — painted, replayed,
     *  or banked while hidden. The freshness verdict reads against this, not
     *  against `bars`: in a hidden tab rAF never paints, so `bars` stops at
     *  the last painted bar while ticks keep arriving, and the check would
     *  read its own un-painted ticks as a dead feed. */
    let lastSeen: Candle | null = null;
    /** Tick counter: a tick landing during a freshness fetch's round trip
     *  proves the feed alive and predates REST's snapshot — no verdict. */
    let tickSeq = 0;
    const noteSeen = (c: Candle) => {
      lastTickAt = Date.now();
      tickSeq++;
      if (!lastSeen || c.t >= lastSeen.t) lastSeen = c;
    };

    const applyPrecision = (decimals: number) => {
      decimalsRef.current = decimals;
      candleSeriesRef.current?.applyOptions({
        priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals },
      });
    };

    /**
     * `deferStats` for BULK merges (backfill replay, gap heal, offscreen
     * flush). Each of those loops is followed by one updateRangeStats() of its
     * own, so a per-candle call would recompute a whole visible window that
     * the very next line recomputes again — ~14 ms for a 600-bar heal over a
     * 200-bar window. The single live-tick caller keeps the default.
     * The end state is identical either way; only the count of intermediate
     * recomputations (and of the onRangeChange re-entries they provoke)
     * changes.
     */
    const applyCandle = (candle: Candle, deferStats = false) => {
      // Ratchet precision up from live data so an empty backfill (brand-new
      // or illiquid market) can't lock sub-1.0 prices to "0".
      const d = decimalsOf(candle.c);
      if (d > decimalsRef.current) applyPrecision(d);
      const lastBar = bars[bars.length - 1];
      if (lastBar && lastBar.t === candle.t) bars[bars.length - 1] = candle;
      else if (!lastBar || candle.t > lastBar.t) bars.push(candle);
      candleSeriesRef.current?.update(toBar(candle, tzOff));
      volumeSeriesRef.current?.update(toVolume(candle, tzOff));
      const price = Number(candle.c);
      setTick({
        price,
        dir: prevClose === 0 || price === prevClose ? 0 : price > prevClose ? 1 : -1,
      });
      prevClose = price;
      noteSeen(candle); // a REST landing is proof of life too
      // every path that moves the header price — live tick, backfill
      // replay, gap-heal merge, offscreen flush — lands the same string in
      // the tab title (setTitleSource dedupes; the socket callback already
      // noted live ticks for hidden tabs, where this rAF task never runs)
      noteTitlePrice(legendFmt(decimalsRef.current).format(price));
      if (!deferStats) updateRangeStats();
    };

    // Scroll-left pagination: fetch an older chunk and prepend, keeping the
    // visible view anchored, until the API returns nothing older.
    const loadOlder = (chunkBars: number) => {
      if (loadingOlder || noMoreHistory || bars.length === 0) return;
      loadingOlder = true;
      const oldestT = bars[0].t;
      const chunkStart = oldestT - INTERVAL_MS[interval] * chunkBars;
      fetchCandles(coin, interval, chunkStart, oldestT - 1, ac.signal)
        .then((older) => {
          if (epoch !== epochRef.current) return;
          const fresh = older.filter((c) => c.t < oldestT);
          if (fresh.length === 0) {
            noMoreHistory = true;
            return;
          }
          bars = [...fresh, ...bars];
          // `bars` was REASSIGNED — re-point the heal alias at the new array
          // (applyCandle mutates this one from now on).
          healRef.current = { coin, interval, bars };
          // Re-anchor by LOGICAL shift, never by time range: getVisibleRange
          // clamps whitespace to the data edge, so a linked window reaching
          // past this cell's first bar would snap right (and lose its right
          // offset) when restored — indices just shift by the prepend count.
          const savedLogical = chart.timeScale().getVisibleLogicalRange();
          suppressBroadcastUntilRef.current = performance.now() + 300;
          candleSeries.setData(bars.map((c) => toBar(c, tzOff)));
          volumeSeries.setData(bars.map((c) => toVolume(c, tzOff)));
          if (savedLogical) {
            chart.timeScale().setVisibleLogicalRange({
              from: savedLogical.from + fresh.length,
              to: savedLogical.to + fresh.length,
            });
          }
          updateRangeStats();
        })
        .catch((err) => {
          // silent either way: stale epoch is dead, and a live-epoch abort
          // just means the next scroll retries (loadingOlder resets below)
          if (epoch !== epochRef.current || (err as Error)?.name === 'AbortError') return;
          console.warn('[purrwall] older-history fetch failed for', coin, err);
        })
        .finally(() => {
          loadingOlder = false;
        });
    };

    // The hovered cell paginates eagerly with full chunks (the user is
    // pulling on it); linked followers wait for the gesture to settle and
    // fetch small chunks — an instant 24-cell fan-out of full chunks would
    // blow the REST weight budget in one wave (see SYNC_CHUNK_BARS).
    let olderSettleTimer: ReturnType<typeof setTimeout> | undefined;
    const requestOlder = () => {
      // same exclusive source gate as the sync paths: on touch the
      // last-touched cell is "the one being pulled on"
      const pulling = IS_COARSE
        ? isTouchSource(renderKey)
        : containerRef.current?.matches(':hover');
      if (pulling) {
        loadOlder(chunkFor(OLDER_CHUNK_BARS));
        return;
      }
      clearTimeout(olderSettleTimer);
      olderSettleTimer = setTimeout(() => {
        if (epoch === epochRef.current) loadOlder(chunkFor(SYNC_CHUNK_BARS));
      }, 600);
    };

    // Δ%, Σvolume and RVOL over exactly the bars on screen (logical index ≈ bars index)
    const updateRangeStats = () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!range || bars.length === 0) return;
      const from = Math.max(0, Math.ceil(range.from));
      const to = Math.min(bars.length - 1, Math.floor(range.to));
      if (from > to) return;
      let volUsd = 0;
      for (let i = from; i <= to; i++) volUsd += Number(bars[i].v) * Number(bars[i].c);
      // RVOL: avg volume of the visible window vs the same-length window
      // before it — normalized, so 3× means the same thing on every market
      const len = to - from + 1;
      const priorFrom = Math.max(0, from - len);
      const priorLen = from - priorFrom;
      let rvol: number | null = null;
      if (priorLen >= Math.min(10, len)) {
        let priorVol = 0;
        for (let i = priorFrom; i < from; i++) priorVol += Number(bars[i].v) * Number(bars[i].c);
        const avgPrior = priorVol / priorLen;
        if (avgPrior > 0) rvol = volUsd / len / avgPrior;
      }
      const firstOpen = Number(bars[from].o);
      const lastClose = Number(bars[to].c);
      // a % over a sign change (a spread through zero) is not a number
      // anyone can read — the absolute Δ takes over on formula cells
      const sameSign = firstOpen !== 0 && Math.sign(firstOpen) === Math.sign(lastClose);
      setRangeStats({
        chg: sameSign ? ((lastClose - firstOpen) / firstOpen) * 100 : null,
        chgAbs: lastClose - firstOpen,
        volUsd,
        rvol,
      });
    };

    const onRangeChange = (range: { from: number; to: number } | null) => {
      if (!range || !snapshotDone) return;
      const info = candleSeries.barsInLogicalRange(range);
      if (info && info.barsBefore < LOAD_MORE_THRESHOLD_BARS) requestOlder();
      // » affordance: off the live edge = show the way back. State bails
      // out on equal values, so per-frame pan churn costs no re-renders.
      setOffRealtime(range.to < bars.length - 1 - 0.01);
      scheduleRender(`${renderKey}:rangestats`, () => {
        if (epoch === epochRef.current) updateRangeStats();
      });
    };

    // Double-click = escape hatch back to the default view (recent window,
    // autoscaled prices). Axis double-clicks keep the library's own
    // per-scale reset. With the wall linked, one double-click un-zooms the
    // whole wall: the window is broadcast DIRECTLY — pagination may have
    // just re-armed the suppress deadline (which would swallow the
    // notification-driven path), and a chart already at its default emits
    // no notification at all.
    const resetView = () => {
      if (bars.length === 0) return;
      const from = Math.max(0, bars.length - defaultBars(measuredWidth()));
      const to = bars.length - 1 + RIGHT_WHITESPACE_BARS;
      suppressBroadcastUntilRef.current = 0; // a user gesture is never programmatic churn
      chart.timeScale().setVisibleLogicalRange({ from, to });
      chart.priceScale('right').applyOptions({ autoScale: true });
      broadcastViewReset(renderKey);
      const data = candleSeries.data();
      if (data.length > 0) {
        const iv = intervalSecRef.current;
        broadcastRange(
          renderKey,
          logicalToTime(data, iv, from),
          logicalToTime(data, iv, to),
          RIGHT_WHITESPACE_BARS,
        );
      }
    };
    chart.subscribeDblClick(resetView);

    // Re-entry flush: scroll-into-view / un-pause runs the parked heal if
    // one accrued, else replays banked ticks (ordered, t ≥ last bar —
    // Invariant 6) and rejoins the wall's linked window + parked cursor it
    // stopped receiving while hidden. Re-armed per run so `bars`/`epoch`
    // stay current.
    onShownRef.current = () => {
      if (epoch !== epochRef.current) return;
      if (staleWhileHiddenRef.current) {
        staleWhileHiddenRef.current = false;
        // the re-run's gap fetch covers the buffered span too — let the
        // buffer die with this epoch instead of double-applying
        pendingHealRef.current = true;
        setRefresh((r) => r + 1);
        return;
      }
      if (offscreen.size > 0 && snapshotDone) {
        const lastT = bars.length > 0 ? bars[bars.length - 1].t : 0;
        const buffered = [...offscreen.values()]
          .filter((c) => c.t >= lastT)
          .sort((a, b) => a.t - b.t);
        offscreen.clear();
        for (const c of buffered) applyCandle(c, true);
      }
      reapplyRange(renderKey);
      reapplyCursor(renderKey);
      updateRangeStats();
    };

    if (heal || resumed) {
      // ONE alias assignment per run (same shape as the full path below);
      // applyCandle mutates the array in place so it needs no upkeep.
      healRef.current = { coin, interval, bars };
      const lastT = bars[bars.length - 1].t;
      /*
       * Invariant 5: the gap fetch goes through fetchCandles as-is (retry +
       * concurrency cap + in-flight dedupe). Its dedupe key is
       * `coin|interval|floor(start/60s)`, so two heals within the same
       * minute may share one response — ACCEPTED, because the buffered WS
       * ticks replayed below (t ≥ last bar) bring the tail current anyway.
       */
      const runGapFetch = () =>
      fetchCandles(coin, interval, lastT, end, ac.signal)
        .then((gap) => {
          if (epoch !== epochRef.current) return;
          // Merge synchronously through the ordinary update path — never via
          // per-cell rAF keys (Invariant 1). The fetch starts AT the last
          // known bar, so the first merged candle is an in-place replacement
          // and the plain 1-arg series.update never sees an older-than-last
          // bar (Invariant 6) — no historicalUpdate needed.
          for (const c of gap) {
            if (c.t >= lastT) applyCandle(c, true);
          }
          // Replay ticks that raced the gap fetch — same recipe as the full
          // backfill below, filtered against the last bar AFTER the merge.
          snapshotDone = true;
          const lastMergedT = bars.length > 0 ? bars[bars.length - 1].t : 0;
          const buffered = [...preSnapshot.values()]
            .filter((c) => c.t >= lastMergedT)
            .sort((a, b) => a.t - b.t);
          preSnapshot.clear();
          for (const c of buffered) applyCandle(c, true);
          // NO view snap, NO autoScale reset: the user's viewport is sacred.
          // reapplyRange early-returns when the wall has no linked window.
          reapplyRange(renderKey);
          updateRangeStats();
          snapshotClean = true;
          setStatus('live');
          setHealing(false); // gap merged — the numbers are provably fresh again
        })
        .catch((err) => {
          // Epoch FIRST: our own abort always arrives epoch-stale (cleanup
          // bumps the epoch before aborting). An AbortError that reaches a
          // LIVE epoch means shared work died under us — degrade like any
          // other heal failure; returning early would wedge the cell
          // (healing badge stuck, ticks buffered forever).
          if (epoch !== epochRef.current || wsRejected) return;
          // healing stays true: the degraded full-path re-run clears it on settle
          console.warn('[purrwall] heal fetch failed for', coin, err);
          // Degrade once to the full backfill path (with its loading
          // overlay): the retried run has heal=false (ref cleared), so a
          // second failure lands in the ordinary error overlay — no loop.
          // the cached bars just failed to heal — drop them so the retried
          // run genuinely lands on the FULL path (error overlay + paced
          // self-heal) instead of resuming the same stale seed in a loop
          evictCandles(coin, interval);
          healRef.current = null;
          setRefresh((r) => r + 1);
        });
      // A cache-resume that is ALSO a retime shares the debounce: the paint
      // above is already on screen, only the gap fetch waits out rapid flips.
      if (resumed && intervalRetime) retimeTimer = window.setTimeout(runGapFetch, 250);
      else runGapFetch();
    } else {
      // Retime debounce: rapid interval flipping must not stampede the REST
      // budget (without it, 15m→1h→4h→1d costs four full backfills and can
      // 429 the whole IP — catalog included). A retime waits 250ms before
      // fetching; each superseded run's cleanup clears the timer, so its
      // chain never starts, and ac.signal discards anything already parked
      // in the fetch queue. Market swaps and first loads kick off
      // SYNCHRONOUSLY — even a microtask of deferral puts StrictMode
      // mount-1's fetch after its own teardown.
      const runBackfill = () =>
      fetchCandles(coin, interval, start, end, ac.signal)
        .then((history) => {
          if (epoch !== epochRef.current) return;
          let decimals = 0;
          for (const c of history.slice(-50)) decimals = Math.max(decimals, decimalsOf(c.c));
          applyPrecision(decimals);
          bars = [...history];
          // healRef aliases this exact array from here on: applyCandle
          // mutates it in place, so the saved bars track the series with no
          // per-tick bookkeeping (loadOlder reassigns and re-points itself).
          healRef.current = { coin, interval, bars };
          candleSeries.setData(bars.map((c) => toBar(c, tzOff)));
          volumeSeries.setData(bars.map((c) => toVolume(c, tzOff)));
          const last = bars[bars.length - 1];
          if (last) {
            prevClose = Number(last.c);
            setTick({ price: prevClose, dir: 0 });
            noteTitlePrice(legendFmt(decimalsRef.current).format(prevClose));
          }
          // Replay ticks that raced the snapshot — without this, a bar that
          // closed mid-fetch keeps its stale snapshot OHLCV forever.
          snapshotDone = true;
          const lastHistoryT = last ? last.t : 0;
          const buffered = [...preSnapshot.values()]
            .filter((c) => c.t >= lastHistoryT)
            .sort((a, b) => a.t - b.t);
          preSnapshot.clear();
          for (const c of buffered) applyCandle(c, true);
          // Show the recent window (not fitContent over everything): scrolling
          // left pages in more history via onRangeChange.
          if (bars.length > 0) {
            suppressBroadcastUntilRef.current = performance.now() + 300;
            chart.timeScale().setVisibleLogicalRange({
              from: Math.max(0, bars.length - defaultBars(measuredWidth())),
              to: bars.length - 1 + RIGHT_WHITESPACE_BARS,
            });
          }
          // A manual price-axis drag disables autoscale and would otherwise
          // persist across a market switch (SOL drawn on BTC's axis).
          chart.priceScale('right').applyOptions({ autoScale: true });
          // A freshly (re)loaded cell joins the wall's linked window instead
          // of sitting on its own default (suppress is armed — no
          // rebroadcast) — EXCEPT after a retime, which keeps the fresh
          // default view for the new timeframe (see intervalRetime above).
          if (!intervalRetime) reapplyRange(renderKey);
          updateRangeStats();
          snapshotClean = true;
          setStatus('live');
          setHealing(false);
        })
        .catch((err) => {
          if (epoch !== epochRef.current || wsRejected) return;
          // Live ticks still flow (header price stays real); the overlay offers retry.
          snapshotDone = true;
          preSnapshot.clear();
          console.warn('[purrwall] backfill failed for', coin, err);
          setStatus('error');
          setHealing(false); // the error overlay is its own honest signal
        });
      if (intervalRetime) retimeTimer = window.setTimeout(runBackfill, 250);
      else runBackfill();
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    // Freshness check (constants + rationale at FRESHNESS_SILENCE_MS): a
    // plain setInterval — its once-a-minute cadence is exactly what Chrome's
    // intensive throttling degrades to anyway, so a hidden title cell keeps
    // the same guarantee. `lastTickAt` doubles as the once-per-window latch.
    const freshnessTimer = window.setInterval(() => {
      if (epoch !== epochRef.current || !snapshotDone || loadingOlder || bars.length === 0) return;
      // Plain cells only: a formula's live leg masks a dead one, and each
      // check would cost one snapshot PER LEG.
      if (marketKind === 'formula') return;
      if (cellHidden() && !titleSlotRef.current) return;
      if (Date.now() - lastTickAt < FRESHNESS_SILENCE_MS) return;
      lastTickAt = Date.now(); // one check per window
      const painted = bars[bars.length - 1];
      const ref = lastSeen && lastSeen.t >= painted.t ? lastSeen : painted;
      const seqAtFire = tickSeq;
      fetchCandles(coin, interval, ref.t, Date.now(), ac.signal)
        .then((fresh) => {
          if (epoch !== epochRef.current) return;
          if (tickSeq !== seqAtFire) return; // the feed spoke during the round trip
          const newer = fresh.some((c) => c.t > ref.t || (c.t === ref.t && c.c !== ref.c));
          if (!newer) return;
          // Dead: re-send the subscription on the wire (a shared key's effect
          // re-run is a refcount no-op) and heal the gap the usual way.
          resubscribeCandle(coin, interval);
          requestHealRef.current();
        })
        .catch(() => {
          /* a failed check is not a verdict — the next window tries again */
        });
    }, FRESHNESS_CHECK_MS);

    const unsubscribe = subscribeCandle(coin, interval, (candle) => {
      noteSeen(candle); // before every early return: banked ticks count as life
      if (!snapshotDone) {
        preSnapshot.set(candle.t, candle);
        return;
      }
      // Tab title (lib/pageTitle.ts): straight from the socket, BEFORE the
      // hidden bank and the rAF paint — a hidden tab suspends rAF, and the
      // tab strip is the one place this price is read while hidden. Same
      // formatter and the same precision ratchet as the header's paint.
      // (the market guard: between a commit and this effect's cleanup a
      // late tick of the OLD coin must not publish under the NEW name)
      if (epoch === epochRef.current && titleMarketRef.current?.coin === coin) {
        noteTitlePrice(
          legendFmt(Math.max(decimalsRef.current, decimalsOf(candle.c))).format(Number(candle.c)),
        );
      }
      // Hidden cell: bank per-bar instead of painting an invisible canvas —
      // onShown replays in order. WS stays subscribed.
      // cellHidden(), not the predicate spelled out: a fullscreen cell reads
      // as not-intersecting to its own observer and would bank the very ticks
      // the user is watching.
      if (cellHidden()) {
        // a parked heal supersedes banking — its gap fetch covers everything
        if (staleWhileHiddenRef.current) return;
        offscreen.set(candle.t, candle);
        // bound the bank: past ~4h of 1m bars, one ~20-weight gap heal on
        // re-entry beats a hundreds-strong synchronous replay burst — and
        // caps memory for cells hidden across a long session
        if (offscreen.size > 240) {
          offscreen.clear();
          staleWhileHiddenRef.current = true;
          setHealing(true); // price dims the moment it edges back into view
        }
        return;
      }
      // Coalesce per BAR, not per cell: when a hidden tab suspends rAF, each
      // bar keeps its own latest task and all bars flush in order on return —
      // per-cell coalescing would silently drop every bar closed while hidden.
      scheduleRender(`${renderKey}:${candle.t}`, () => {
        if (epoch !== epochRef.current) return;
        applyCandle(candle);
      });
    }, () => {
      // Quarantined (hl/ws.ts): HL closes the shared socket on this id, so
      // this cell will never tick. Its REST side is failing too (an unknown
      // coin is HTTP 500) — abort rather than wait out three escalating
      // timeouts, and a late success must not paint a chart that can't
      // move. The aborted fetch's catch lands on the same overlay.
      if (epoch !== epochRef.current) return;
      wsRejected = true;
      ac.abort();
      snapshotDone = true;
      preSnapshot.clear();
      setStatus('error');
      setHealing(false);
    });

    return () => {
      epochRef.current++;
      onShownRef.current = null; // never flush a dead epoch's buffers
      clearTimeout(olderSettleTimer);
      clearTimeout(retimeTimer); // a superseded retime never fetches
      ac.abort(); // parked/retrying REST work for this run is dead — spend nothing on it
      // bars go dormant now — bank them so a revisit repaints for ~free.
      // Only CLEAN snapshots qualify: a failed run's WS-scrap bars would
      // poison the cache and hijack the retry's full backfill.
      if (marketCoin !== null && snapshotClean && bars.length > 0) {
        storeCandles(marketCoin, interval, bars, BACKFILL_BARS);
      }
      if (chartRef.current === chart) {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
        chart.unsubscribeDblClick(resetView);
      }
      unsubscribe();
      window.clearInterval(freshnessTimer);
    };
  }, [marketCoin, marketKind, interval, refresh, renderKey, tzOffsetSec, noteTitlePrice]);

  // A failed cell self-heals on the budget window's timescale: 429 storms
  // drain within a minute, so a dead end at the manual retry button would
  // be pure friction (the button stays as the fast lane). Jitter keeps nine
  // errored cells from re-storming the budget in lockstep, and the timer
  // arms only while VISIBLE — a hidden wall must not burn budget on
  // full-backfill retries nobody is watching (visibility return re-arms).
  useEffect(() => {
    if (status !== 'error') return;
    // A quarantined id has no self-heal — HL closes the socket on it every
    // time — so only the manual Retry may spend another attempt on it.
    if (marketCoin !== null && isCandleQuarantined(marketCoin, interval)) return;
    let timer = 0;
    const arm = () => {
      if (timer === 0) {
        timer = window.setTimeout(() => setRefresh((r) => r + 1), 15_000 + Math.random() * 10_000);
      }
    };
    const onVis = () => {
      if (!document.hidden) arm();
    };
    if (!document.hidden) arm();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [status, marketCoin, interval]);

  const isFormula = market?.kind === 'formula';
  const rawName = market?.display ?? '';
  // HIP-4 match markets repeat the tournament prefix on every cell — a narrow
  // header must show the teams, not a row of identical prefixes. Full name
  // stays in tooltip + picker. HL's sportsContest* templates (2026-09) emit
  // "{competition} {stage}: {A} v {B}" with a single "v"; the legacy
  // free-text names said "A vs B" — match both.
  const headerName =
    market?.kind === 'hip4' && / vs? /i.test(rawName)
      ? rawName.replace(/^[^:·]*:\s*/, '')
      : rawName;
  // The base/suffix split exists for the structured '-USDC'/'/USDC' tails of
  // perp/spot/hip3 names. HIP-4 questions are free text — splitting them at
  // the first hyphen mangles names like 'T1 vs Gen-G' once the suffix hides.
  // Formula names ('HYPE/USDC÷HYPE') would lose their second leg to the
  // narrow-cell suffix rules — never split them.
  const nameMatch = market?.kind === 'hip4' || isFormula ? null : headerName.match(/^(.+?)([-/].+)$/);
  const marketBase = nameMatch ? nameMatch[1] : headerName;
  const marketSuffix = nameMatch ? nameMatch[2] : '';

  const priceText =
    tick === null
      ? ''
      : tick.price.toLocaleString('en-US', {
          minimumFractionDigits: Math.min(decimalsRef.current, 2),
          maximumFractionDigits: decimalsRef.current,
        });

  // Tab title (lib/pageTitle.ts). The NAME is HL's own tab spelling: the
  // bare coin for perps and HIP-3 ('BTC', 'TSLA' — the '-USDC' tail is
  // header chrome), spot pairs whole ('PURR/USDC', and 'PUMP-26/USDC' keeps
  // its hyphenated base — the suffix split cuts at the first hyphen, which
  // is why this goes by kind), questions and formulas whole.
  const titleName =
    (market?.kind === 'perp' || market?.kind === 'hip3') && headerName.endsWith('-USDC')
      ? headerName.slice(0, -5)
      : headerName;
  // The mirrors are set in a LAYOUT effect: after the commit (a discarded
  // render can never leave them pointing at uncommitted props) and before
  // every passive effect of that commit, so the data effect's seeds and
  // the socket callback always read the committed slot, name and market.
  useLayoutEffect(() => {
    titleSlotRef.current = titleSlot;
    titleNameRef.current = titleName;
    titleMarketRef.current = market;
  });
  // The slot empties only when this cell stops owning it or unmounts; a
  // market change keeps the slot and simply republishes (the data effect
  // seeds name-only first) — pageTitle folds a commit's clear+set into one
  // write either way.
  useEffect(() => {
    publishTitle();
    return () => {
      if (titleSlot) setTitleSource(titleSlot, null);
    };
  }, [titleSlot, publishTitle]);
  useEffect(() => {
    publishTitle();
  }, [market, titleName, publishTitle]);
  // Honesty: a title cannot dim the way `.cell-price` does, so after 2 s of
  // WS-not-live the price segment LEAVES the title (`BTC | Purrwall`) and
  // the banked number is DISCARDED — only the next tick or REST landing
  // brings a price back, never the `live` flag alone (the socket reopens
  // before any tick and the reconnect heal runs after it). Sub-second
  // ladder blips never show.
  useEffect(() => {
    if (!stale) return;
    const t = setTimeout(() => noteTitlePrice(null), 2000);
    return () => clearTimeout(t);
  }, [stale, noteTitlePrice]);
  // Page freeze: pageTitle.ts drops the controller's copy of every price on
  // the same event; drop THIS cell's banked string too (every cell banks one,
  // slot or not), or an expand / card / handover after resume would hand an
  // hours-old number back into the title.
  useEffect(() => {
    const onFreeze = () => noteTitlePrice(null);
    document.addEventListener('freeze', onFreeze);
    return () => document.removeEventListener('freeze', onFreeze);
  }, [noteTitlePrice]);

  const chgPct =
    tick !== null && marketStats?.prevDayPx != null && marketStats.prevDayPx !== 0
      ? ((tick.price - marketStats.prevDayPx) / marketStats.prevDayPx) * 100
      : null;

  // Touch long-press → arrange mode. The browser synthesizes a click at
  // touchend which would land on the freshly-mounted arrange overlay and
  // instantly toggle the pre-selected cell back off — swallow exactly that
  // one click document-wide (capture phase, one-shot: without it the source
  // cell never stays selected). The swallow stays armed while the finger is
  // DOWN (however long the hold) and disarms 300ms after release —
  // anchoring to release means it can neither expire mid-hold nor linger
  // long enough to eat the user's next real tap (aiming at the second chart
  // takes far longer than 300ms).
  const lpTimer = useRef<number | null>(null);
  const lpStart = useRef<{ x: number; y: number; id: number } | null>(null);
  /** Expanded-header pager swipe origin (never set alongside a long-press:
   *  the two gestures live on opposite sides of the `expanded` gate). The
   *  pointerId pins the swipe to ONE finger — a second finger must neither
   *  overwrite the origin nor have its lift read as the swipe's release
   *  (cross-pointer deltas would page spuriously). */
  const swipeStart = useRef<{ x: number; y: number; id: number } | null>(null);
  const swallowCleanupRef = useRef<(() => void) | null>(null);
  const cancelLongPress = () => {
    if (lpTimer.current !== null) {
      clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
    lpStart.current = null;
  };
  const releaseLongPress = () => {
    cancelLongPress();
    const cleanup = swallowCleanupRef.current;
    if (cleanup) window.setTimeout(cleanup, 300);
  };
  const fireArrange = () => {
    lpTimer.current = null;
    // Action FIRST, side effects after: a REFUSED lift (another finger's
    // drag session is live) must neither vibrate nor arm the swallow —
    // nothing happened, and a stray armed swallow eats one real tap.
    // Drag-to-swap lifts when the wall supports it; plain arrange stays for
    // the ⋯-menu entry and the hold-still fallback inside the drag session
    // itself.
    if (onLift && lpStart.current) {
      if (!onLift(lpStart.current.x, lpStart.current.y, lpStart.current.id)) return;
    } else if (onArrange) {
      onArrange();
    } else {
      return;
    }
    const swallow = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    };
    const cleanup = () => {
      document.removeEventListener('click', swallow, true);
      if (swallowCleanupRef.current === cleanup) swallowCleanupRef.current = null;
    };
    swallowCleanupRef.current?.(); // a stale swallow must never stack
    document.addEventListener('click', swallow, true);
    swallowCleanupRef.current = cleanup;
    // double-tick "picked up" haptic — a single blip reads as a stray touch
    navigator.vibrate?.([12, 40, 12]);
  };
  // Unmount mid-press (e.g. a pending wall resolving under the finger):
  // the timer and any armed swallow must die with the cell.
  useEffect(
    () => () => {
      cancelLongPress();
      swallowCleanupRef.current?.();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className={`cell${alertFlash ? ` alert-flash-${alertFlash}` : ''}`}>
      <div
        className="cell-header"
        draggable={!IS_COARSE && !expanded}
        onDragStart={(e) => {
          // Belt-and-braces: prevent drag on touch devices.
          if (IS_COARSE) {
            e.preventDefault();
            return;
          }
          // Header buttons/selects are click targets, not drag grips — a 1px
          // slip on them must not start a native drag. The alert popover
          // (DOM child of the header, fixed-positioned) is a form surface —
          // its inputs/labels must never become drag origins either.
          if ((e.target as HTMLElement).closest('button, select, .alert-pop')) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.setData('text/plain', String(cellIndex));
          e.dataTransfer.effectAllowed = 'move';
          // Restyling the drag source INSIDE the dragstart task corrupts
          // Chromium's drag session (react-dnd#1085) — the session then
          // suppresses mousemove document-wide, freezing every chart's
          // crosshair until the next click. Defer the state change a frame.
          requestAnimationFrame(onDragStart);
        }}
        onDragEnd={onDragEnd}
        // Touch: a blank-header tap never opens the picker — too easy to hit
        // while thumb-scrolling. Only the name button picks; the header's
        // touch gesture is long-press → arrange.
        onPointerDown={
          IS_COARSE
            ? (e) => {
                if (expanded) {
                  // fullscreen: the header's touch gesture is the pager swipe
                  // (the wall's expanded cell and the list card both pass
                  // onPage; a cell with no onPage just no-ops here). Starting
                  // on a button/select is a tap, not a swipe — it must not both
                  // page and click. A SECOND finger aborts the swipe outright
                  // (mirrors the long-press second-finger rule).
                  if (onPage && !(e.target as HTMLElement).closest('button, select, .alert-pop')) {
                    swipeStart.current =
                      swipeStart.current === null
                        ? { x: e.clientX, y: e.clientY, id: e.pointerId }
                        : null;
                  }
                  return;
                }
                if (!onArrange) return;
                // Holding an interval chip/select is a tap-in-progress, not an
                // arrange grip — same exclusion as the swipe path above and the
                // fine-pointer dragstart.
                if ((e.target as HTMLElement).closest('button, select, .alert-pop')) return;
                // a second finger must not orphan the first timer
                cancelLongPress();
                swallowCleanupRef.current?.();
                lpStart.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
                lpTimer.current = window.setTimeout(fireArrange, 450);
              }
            : undefined
        }
        onPointerMove={
          IS_COARSE && onArrange
            ? (e) => {
                if (lpTimer.current === null || !lpStart.current) return;
                // >8px is scroll intent, not a hold
                if (Math.hypot(e.clientX - lpStart.current.x, e.clientY - lpStart.current.y) > 8) {
                  cancelLongPress();
                }
              }
            : undefined
        }
        onPointerUp={
          IS_COARSE
            ? (e) => {
                if (swipeStart.current && swipeStart.current.id === e.pointerId) {
                  const dx = e.clientX - swipeStart.current.x;
                  const dy = e.clientY - swipeStart.current.y;
                  swipeStart.current = null;
                  // decisive horizontal travel only — a sloppy tap stays a tap
                  if (onPage && Math.abs(dx) >= 48 && Math.abs(dx) > 2 * Math.abs(dy)) {
                    onPage(dx < 0 ? 1 : -1);
                  }
                }
                releaseLongPress();
              }
            : undefined
        }
        onPointerCancel={
          IS_COARSE
            ? () => {
                swipeStart.current = null;
                releaseLongPress();
              }
            : undefined
        }
        onContextMenu={IS_COARSE ? (e) => e.preventDefault() : undefined}
        title={IS_COARSE ? tr('t_hold') : tr('t_drag')}
      >
        <button
          className={`cell-market${market?.kind === 'hip4' ? ' long-name' : ''}${isFormula ? ' formula' : ''}`}
          onClick={onPickMarket}
          title={
            market
              ? isFormula
                ? `${market.description ?? market.display} · ${market.coin}`
                : (market.description ?? market.display)
              : tr('t_select')
          }
        >
          {market ? (
            <>
              {isFormula ? renderFormulaName(rawName) : marketBase}
              <span className="cell-market-suffix">{marketSuffix}</span>
              <span className="cell-caret">▾</span>
            </>
          ) : (
            tr('plus_market')
          )}
        </button>
        {market && (
          <span className={`kind-badge kind-${market.kind}`}>
            {market.kind === 'hip3' && market.dex
              ? market.dex
              : market.kind === 'perp'
                ? tr('badge_perp')
                : market.kind === 'spot'
                  ? tr('badge_spot')
                  : KIND_LABEL[market.kind]}
          </span>
        )}
        <span
          className={`cell-price${tick?.dir === 1 ? ' up' : tick?.dir === -1 ? ' down' : ''}${stale || healing ? ' stale' : ''}`}
          title={stale ? tr('reconnecting') : undefined}
        >
          {priceText}
        </span>
        {chgPct !== null && (
          <span
            className={`cell-chg${chgPct > 0 ? ' up' : chgPct < 0 ? ' down' : ''}`}
            title={tr('t_24h')}
          >
            <span className="chg-tag">24h</span>
            {`${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%`}
          </span>
        )}
        <div className="cell-spacer" />
        <div className="cell-intervals">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              className={`iv-btn${iv === interval ? ' active' : ''}`}
              onClick={() => onIntervalChange(iv)}
            >
              {iv}
            </button>
          ))}
        </div>
        {/* compact fallback shown via container query when the cell is narrow */}
        <select
          className="cell-iv-select"
          value={interval}
          onChange={(e) => onIntervalChange(e.target.value as Interval)}
          title={tr('t_interval')}
          aria-label={tr('t_interval')}
        >
          {INTERVALS.map((iv) => (
            <option key={iv} value={iv}>
              {iv}
            </option>
          ))}
        </select>
        {market && !isFormula && (
          <span className="cell-bell-wrap" ref={bellWrapRef}>
            <button
              className={`cell-bell${hasAlerts ? ' has-alerts' : ''}`}
              onClick={() => setAlertsOpen((o) => !o)}
              aria-expanded={alertsOpen}
              title={tr('alert_bell')}
              aria-label={tr('alert_bell')}
            >
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 1.5C5.5 1.5 3.8 3.4 3.8 5.9V9L2.5 11h11L12.2 9V5.9c0-2.5-1.7-4.4-4.2-4.4zM6.6 12.2a1.5 1.5 0 0 0 2.8 0z"
                />
              </svg>
            </button>
            {alertsOpen && (
              <AlertPopover
                market={market}
                currentPrice={tick?.price ?? null}
                anchorRef={bellWrapRef}
                onClose={() => setAlertsOpen(false)}
              />
            )}
          </span>
        )}
        {market && !IS_COARSE && (
          <button className="cell-pop" onClick={onPopOut} title={tr('t_pop')} aria-label={tr('t_pop')}>
            ⧉
          </button>
        )}
        {market && expanded && (
          // a LABELED exit — an icon-only ✕ reads as ambiguous.
          // Not gated on pointer type: the list view opens cards on fine
          // pointers too, and Escape alone is not a visible way out.
          <button className="cell-exit" onClick={onToggleExpand} title={tr('t_collapse')}>
            ✕ {tr('exit_full')}
          </button>
        )}
        {market && IS_COARSE && !expanded && (
          <button
            className="cell-pop"
            onClick={onToggleExpand}
            title={tr('t_expand')}
            aria-label={tr('t_expand')}
          >
            ⛶
          </button>
        )}
        {market && (
          <button className="cell-clear" onClick={onClear} title={tr('t_clear')} aria-label={tr('t_clear')}>
            ×
          </button>
        )}
      </div>
      {/* Alert threshold lines — gated on 'live' rather than mounted always:
          child effects run BEFORE this component's chart-creation effect, so
          on first mount the series ref is still null and a one-shot lookup
          would silently never draw. */}
      {market && !isFormula && status === 'live' && (
        <AlertLines seriesRef={candleSeriesRef} coin={market.coin} />
      )}
      {/* Watched address: entry/liq/order price lines — same 'live' gate. */}
      {market && !isFormula && status === 'live' && (
        <WatchOverlay seriesRef={candleSeriesRef} coin={market.coin} />
      )}
      {market && (marketStats || rangeStats) && (
        <div className="cell-statsbar">
          {market.kind !== 'spot' && market.kind !== 'hip4' && !isFormula && marketStats && (
            <>
              {/* The badge glyph is bare `F` and the value is the HOURLY rate,
                  formatted exactly as app.hyperliquid.xyz's trade-page header
                  formats it — a user cross-checking this cell against HL sees
                  the same string. The period lives in the tooltip AND in the
                  tables' `1h Funding` header; annualized rides along because
                  4 decimals of an hourly rate is a run of leading zeros that
                  roughly half of all perps share. */}
              <span title={`${tr('t_funding')} · ${tr('t_apr')} ${fundingApr(marketStats.funding1h)}`}>
                F {fmtFunding(marketStats.funding1h)}
              </span>
              <span title={tr('t_oi')}>OI {compactUsd(marketStats.openInterestUsd)}</span>
            </>
          )}
          {market.kind === 'spot' && marketStats?.marketCapUsd != null && (
            <span title={tr('t_mc')}>MC {compactUsd(marketStats.marketCapUsd)}</span>
          )}
          {rangeStats && (
            <>
              {rangeStats.chg != null && (
                <span
                  className={rangeStats.chg > 0 ? 'up' : rangeStats.chg < 0 ? 'down' : ''}
                  title={tr('t_delta')}
                >
                  Δ {`${rangeStats.chg >= 0 ? '+' : ''}${rangeStats.chg.toFixed(2)}%`}
                </span>
              )}
              {rangeStats.chg == null && isFormula && (
                <span
                  className={rangeStats.chgAbs > 0 ? 'up' : rangeStats.chgAbs < 0 ? 'down' : ''}
                  title={tr('t_delta')}
                >
                  Δ {`${rangeStats.chgAbs >= 0 ? '+' : ''}${rangeStats.chgAbs.toFixed(decimalsRef.current)}`}
                </span>
              )}
              {/* composed bars carry v='0' — a $0 volume or a null RV would
                  read as a broken cell, so formulas show Δ alone */}
              {!isFormula && <span title={tr('t_vol')}>V {compactUsd(rangeStats.volUsd)}</span>}
              {!isFormula && rangeStats.rvol != null && (
                <span
                  className={rangeStats.rvol >= 2 ? 'rv-hot' : ''}
                  title={tr('t_rv')}
                >
                  RV {rangeStats.rvol.toFixed(1)}×
                </span>
              )}
            </>
          )}
          {/* Formula cells: which leg moved — each leg's own 24h change,
              LAST in the row so a narrow bar sheds them first, whole. */}
          {isFormula &&
            marketStats?.legs?.map((l) => (
              <span
                key={l.label}
                className={`fx-leg${
                  l.chgPct != null && l.chgPct > 0 ? ' up' : l.chgPct != null && l.chgPct < 0 ? ' down' : ''
                }`}
                title={tr('cell_fx_leg24h')}
              >
                {l.label}
                {l.chgPct != null && ` ${l.chgPct >= 0 ? '+' : ''}${l.chgPct.toFixed(1)}%`}
              </span>
            ))}
          {/* Watched address's unrealized PnL on this market (renders only
              when the watched account holds a position here). */}
          {!isFormula && <WatchChip coin={market.coin} />}
        </div>
      )}
      <div
        className={`cell-body${!market ? ' cell-body-empty' : ''}`}
        onClick={market ? undefined : onPickMarket}
      >
        <div ref={containerRef} className="cell-chart" />
        {/* populated imperatively via setLegend — spans stay empty in React's eyes */}
        <div ref={legendRef} className="cell-legend" aria-hidden="true">
          <span className="lg-ohl" />
          <span className="lg-c" />
          <span className="lg-chg" />
        </div>
        {/* back to now, KEEPING the zoom level (double-click = full reset).
            Broadcast DIRECTLY (resetView's pattern): the hover gate can't be
            trusted here — the pointer sits on this button, a SIBLING of
            .cell-chart, so scrollToRealTime's notification frames would be
            swallowed and the wall (and the module's rangeWindow, which heals
            re-apply) would stay pinned to history. */}
        {offRealtime && market && (
          <button
            className="goto-now"
            title={tr('goto_now')}
            aria-label={tr('goto_now')}
            onClick={() => {
              const chart = chartRef.current;
              const data = candleSeriesRef.current?.data() ?? [];
              if (!chart) return;
              suppressBroadcastUntilRef.current = 0; // user gesture, never churn
              const lr = chart.timeScale().getVisibleLogicalRange();
              // autoscale may be off (fullscreen touch mode / manual axis
              // drag) with the price window pinned to a historical band —
              // landing at now with old prices renders a blank-looking pane
              chart.priceScale('right').applyOptions({ autoScale: true });
              chart.timeScale().scrollToRealTime();
              if (lr && data.length > 0) {
                const width = lr.to - lr.from;
                const to = data.length - 1 + RIGHT_WHITESPACE_BARS;
                const iv = intervalSecRef.current;
                broadcastRange(
                  renderKey,
                  logicalToTime(data, iv, to - width),
                  logicalToTime(data, iv, to),
                  RIGHT_WHITESPACE_BARS,
                );
              }
            }}
          >
            »
          </button>
        )}
        {(status === 'loading' || (status === 'empty' && catalogPending)) && (
          <div className="cell-overlay">{tr('loading')}</div>
        )}
        {status === 'error' && (
          <div className="cell-overlay">
            <span className="err-text">{tr('failed_for')} {market?.display}</span>
            <button
              className="retry-btn"
              onClick={() => {
                // the user's word over the quarantine: one more real attempt
                if (market) clearCandleQuarantine(market.coin, interval);
                setRefresh((r) => r + 1);
              }}
            >
              {tr('retry')}
            </button>
          </div>
        )}
        {status === 'empty' && !catalogPending && (
          <div className="cell-overlay">
            <button className="pick-big" onClick={onPickMarket}>
              {tr('select_market')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
