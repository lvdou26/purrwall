/**
 * The wall link (topbar ⌖): one registry syncs BOTH the crosshair and the
 * visible time window across every chart.
 *
 * Crosshair: hovering one chart marks the same moment on every other —
 * solid vertical at the bar containing that moment, dashed horizontal at
 * THAT chart's own price, own-bar OHLC in each cell's legend. Different
 * intervals map by containment: sweeping four 1h bars holds the 4h chart's
 * cursor on one bar, then steps it — a bar is one indivisible observation,
 * so the cursor never pretends sub-bar resolution.
 *
 * Zoom/pan: the hovered chart broadcasts its visible window in TIME (bar
 * indices don't compare across intervals; time does, including whitespace
 * extrapolated at the edges), every other chart maps it back to its own
 * logical range. Notifications from setVisibleLogicalRange arrive on the
 * NEXT frame, so a target under the pointer can't tell its own echo from
 * a user pan by timing — appliedRanges lets it recognize the window it
 * was just given (see isEchoRange).
 *
 * Module-level imperative registry, same pattern as hlSocket/renderQueue:
 * cells register on mount and events never touch React.
 */
import type {
  CandlestickData,
  IChartApi,
  ISeriesApi,
  MouseEventParams,
  Time,
} from 'lightweight-charts';
import { scheduleRender } from './renderQueue';

interface Entry {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  /** The chart container — :hover tells apply() whose cursor is native. */
  el: HTMLElement;
  /** Imperative top-left OHLC legend writer — DOM only, never React. */
  setLegend: (bar: CandlestickData<Time> | null) => void;
  /** Live interval length in seconds (a ref read — cells retime in place). */
  getIntervalSec: () => number;
  /** Visibility gating: true = offscreen/occluded, skip broadcast paints; the
   *  cell re-syncs itself on re-entry (reapplyRange + reapplyCursor). */
  isHidden?: () => boolean;
}

const cells = new Map<string, Entry>();
let cursor: { sourceKey: string; time: number } | null = null;
/**
 * Touch source: :hover can't identify the gesturing cell on coarse pointers
 * (iOS leaves stale emulated hover on previously-tapped cells), so the last
 * chart-body touch claims sourceship — and KEEPS it through kinetic-scroll
 * momentum after the finger lifts, until another cell is touched.
 */
let touchSourceKey: string | null = null;
export function setTouchSource(key: string): void {
  touchSourceKey = key;
}
export function isTouchSource(key: string): boolean {
  return touchSourceKey === key;
}
/** Whitespace bars kept right of the newest candle — the "where we are"
 *  breathing room. Shared by the timeScale rightOffset, the default recent
 *  window, and every realtime re-anchor, so all paths land identically. */
export const RIGHT_WHITESPACE_BARS = 5;

// rtOffsetBars is SEMANTIC, not a coordinate: non-null means the source's
// right edge was at/past its newest candle by that many whitespace bars, so
// receivers re-anchor to their OWN newest candle (+ the same whitespace) at
// apply time — even much later (reapplyRange after a cell reloads).
// Coordinates alone would freeze walls: a stale window would pin reloaded
// cells to wherever the wall was when someone last zoomed.
/** Wall-wide visible window, shifted-epoch seconds (fractional at edges). */
let rangeWindow: {
  sourceKey: string;
  from: number;
  to: number;
  /** null = window is back in history; >=0 = whitespace bars right of the
   *  source's newest candle (its own bar units) */
  rtOffsetBars: number | null;
} | null = null;
/** Last window this module pushed to each cell, in ITS logical coords. */
const appliedRanges = new Map<string, { from: number; to: number; at: number }>();
let enabled = true;
const RQ_KEY = 'crosshair-sync';
const RQ_RANGE = 'range-sync';

export function registerCrosshair(key: string, entry: Entry): () => void {
  cells.set(key, entry);
  return () => {
    cells.delete(key);
    appliedRanges.delete(key);
    if (touchSourceKey === key) touchSourceKey = null;
    if (rangeWindow?.sourceKey === key) rangeWindow = null;
    if (cursor?.sourceKey === key) {
      cursor = null;
      scheduleRender(RQ_KEY, apply);
    }
  };
}

/** The topbar ⌖ toggle; off clears every synced cursor and mutes broadcasts. */
export function setCrosshairSyncEnabled(on: boolean): void {
  enabled = on;
  if (!on) {
    cursor = null;
    rangeWindow = null;
  }
  scheduleRender(RQ_KEY, apply);
}

/** Source cell's crosshairMove handler calls this; null time = pointer left. */
export function broadcastCrosshair(sourceKey: string, param: MouseEventParams): void {
  if (!enabled) return;
  if (!cells.has(sourceKey)) return;
  const t = typeof param.time === 'number' ? param.time : null;
  cursor = t === null ? null : { sourceKey, time: t };
  scheduleRender(RQ_KEY, apply);
}

/** Hovered cell's zoom/pan, as a time window; the wall follows.
 *  rtOffsetBars: null = historical window; >=0 = at the live edge with that
 *  much whitespace right of the source's newest candle. */
export function broadcastRange(
  sourceKey: string,
  from: number,
  to: number,
  rtOffsetBars: number | null,
): void {
  if (!enabled) return;
  if (!cells.has(sourceKey)) return;
  rangeWindow = { sourceKey, from, to, rtOffsetBars };
  scheduleRender(RQ_RANGE, applyRange);
}

/**
 * Does this logical range look like what applyRange just pushed to the cell?
 * setVisibleLogicalRange notifies on the NEXT frame, so a flag cleared
 * synchronously can't shield a hovered target from re-broadcasting its own
 * echo — recognizing the window is the only reliable tell. Two prongs: the
 * exact values, or ANY notification within 150ms of the push — the library
 * clamps extreme windows (min/max bar spacing), so on wildly mixed intervals
 * the adopted range can differ from the pushed one and only timing gives the
 * echo away.
 */
export function isEchoRange(key: string, lr: { from: number; to: number }): boolean {
  const a = appliedRanges.get(key);
  if (a === undefined) return false;
  if (Math.abs(a.from - lr.from) < 0.01 && Math.abs(a.to - lr.to) < 0.01) return true;
  return performance.now() - a.at < 150;
}

/** Full-wall retime: the old time window is meaningless at the new
 *  timeframe (and would re-pin healed cells to it later) — drop it. */
export function clearRangeWindow(): void {
  rangeWindow = null;
}

/** Double-click reset: re-arm price autoscale wall-wide (window follows via broadcastRange). */
export function broadcastViewReset(sourceKey: string): void {
  if (!enabled) return;
  for (const [key, cell] of cells) {
    if (key === sourceKey) continue;
    try {
      cell.chart.priceScale('right').applyOptions({ autoScale: true });
    } catch {
      cells.delete(key);
    }
  }
}

function applyWindowTo(
  key: string,
  cell: Entry,
  w: { from: number; to: number; rtOffsetBars: number | null },
): void {
  const data = cell.series.data();
  if (data.length === 0) return;
  const iv = cell.getIntervalSec();
  // A shared TIME window is meaningless for a cell whose interval renders
  // it as a handful of giant candles (an 80-hour window on a daily chart is
  // ~3 bars) — that cell keeps its own framing instead of joining. Guards
  // the per-cell-retime + heal/retry/tz-reload re-pin class of bugs.
  const MIN_JOIN_BARS = 10;
  if (w.rtOffsetBars !== null) {
    // Live-edge windows re-anchor to THIS cell's newest candle (keeping the
    // source's window duration in this cell's bar units, and mirroring the
    // source's whitespace) instead of mapping the source's coordinates —
    // mapped edges can land a hair short of the receiver's last bar, which
    // silently disengages the library's stick-to-new-candles behavior and
    // freezes the cell.
    const widthBars = (w.to - w.from) / iv;
    if (widthBars < MIN_JOIN_BARS) return;
    const to = data.length - 1 + Math.max(0, w.rtOffsetBars);
    const from = to - widthBars;
    appliedRanges.set(key, { from, to, at: performance.now() });
    cell.chart.timeScale().setVisibleLogicalRange({ from, to });
    return;
  }
  const first = data[0].time as number;
  const last = data[data.length - 1].time as number;
  // window entirely outside this cell's prints (settled market, no
  // shared history): holding its old view beats showing a blank pane
  if (w.to <= first || w.from >= last + iv) return;
  const from = timeToLogical(data, iv, w.from);
  const to = timeToLogical(data, iv, w.to);
  if (!(to > from) || to - from < MIN_JOIN_BARS) return;
  appliedRanges.set(key, { from, to, at: performance.now() });
  cell.chart.timeScale().setVisibleLogicalRange({ from, to });
}

function applyRange(): void {
  if (!rangeWindow) return;
  const w = rangeWindow;
  for (const [key, cell] of cells) {
    if (key === w.sourceKey) continue;
    // visibility gating: hidden cells skip broadcast paints and rejoin the
    // wall's window via reapplyRange when their IntersectionObserver
    // un-hides them
    if (cell.isHidden?.()) continue;
    try {
      applyWindowTo(key, cell, w);
    } catch {
      cells.delete(key);
    }
  }
}

/**
 * A cell whose data context just reset (market/interval switch, refresh)
 * re-joins the wall's current window instead of sitting on its own default.
 * Applied even to the stale source key — ownership died with the old data.
 */
export function reapplyRange(key: string): void {
  if (!enabled || !rangeWindow) return;
  const cell = cells.get(key);
  if (!cell) return;
  try {
    applyWindowTo(key, cell, rangeWindow);
  } catch {
    /* chart disposed mid-teardown — the unregister cleanup handles it */
  }
}

/**
 * Re-entry companion to reapplyRange: a cell scrolling back into view joins
 * the wall's CURRENT cursor state — paints the parked cursor if one exists,
 * and CLEARS otherwise (apply() skips hidden cells for clears too, so
 * without clearing here a marker parked before the cell scrolled away
 * would survive tap-clear forever — phantom crosshair + stale legend). A
 * hidden cell can't be mid-gesture, so clearing never wipes native
 * interaction state; the source cell keeps its own.
 */
export function reapplyCursor(key: string): void {
  const cell = cells.get(key);
  if (!cell) return;
  if (cursor && key === cursor.sourceKey) return; // its own native crosshair
  try {
    const bar = enabled && cursor ? barContaining(cell.series, cursor.time) : null;
    if (bar) {
      cell.chart.setCrosshairPosition(bar.close, bar.time, cell.series);
      cell.setLegend(bar);
    } else {
      cell.chart.clearCrosshairPosition();
      cell.setLegend(null);
    }
  } catch {
    /* chart disposed mid-teardown — the unregister cleanup handles it */
  }
}

/**
 * Time ⇄ fractional bar index for one cell's own data. Inside the data the
 * mapping interpolates between neighbouring bars (gaps span linearly);
 * beyond either edge it extrapolates at the cell's interval so whitespace
 * offsets survive the round-trip. Callers guarantee data is non-empty.
 */
export function timeToLogical(
  data: readonly { time: Time }[],
  ivSec: number,
  t: number,
): number {
  const n = data.length;
  const first = data[0].time as number;
  const last = data[n - 1].time as number;
  if (t <= first) return (t - first) / ivSec;
  if (t >= last) return n - 1 + (t - last) / ivSec;
  let lo = 0;
  let hi = n - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((data[mid].time as number) <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const t0 = data[best].time as number;
  const t1 = data[best + 1].time as number; // best < n-1: t < last was checked
  return best + (t - t0) / (t1 - t0);
}

export function logicalToTime(
  data: readonly { time: Time }[],
  ivSec: number,
  l: number,
): number {
  const n = data.length;
  if (l <= 0) return (data[0].time as number) + l * ivSec;
  if (l >= n - 1) return (data[n - 1].time as number) + (l - (n - 1)) * ivSec;
  const i = Math.floor(l);
  const t0 = data[i].time as number;
  const t1 = data[i + 1].time as number;
  return t0 + (l - i) * (t1 - t0);
}

function apply(): void {
  for (const [key, cell] of cells) {
    // source draws its own crosshair and writes its own legend locally
    if (cursor && key === cursor.sourceKey) continue;
    // hidden cells skip cursor paints too — reapplyCursor covers re-entry
    if (cell.isHidden?.()) continue;
    try {
      // no cursor but the pointer is resting here: the native crosshair and
      // the locally-written legend are this cell's own — don't wipe them
      // (hit when the ⌖ toggle flips or the source cell unmounts mid-hover)
      if (!cursor && cell.el.matches(':hover')) continue;
      const bar = cursor ? barContaining(cell.series, cursor.time) : null;
      if (bar) {
        cell.chart.setCrosshairPosition(bar.close, bar.time, cell.series);
      } else {
        cell.chart.clearCrosshairPosition();
      }
      cell.setLegend(bar);
    } catch {
      // chart disposed mid-frame (cell unmounting) — drop it from the registry
      cells.delete(key);
    }
  }
}

/**
 * Nearest-left binary search: the target's own bar that contains (or last
 * precedes) the moment. Positions must use the TARGET bar's time — for a
 * coarser interval the source time falls inside the bar, not on it; for
 * gappy thin markets this is "its most recent print as of that moment".
 * Exported for the source cell's own legend (whitespace hover fallback).
 */
export function barContaining(
  series: ISeriesApi<'Candlestick'>,
  t: number,
): CandlestickData<Time> | null {
  const data = series.data();
  let lo = 0;
  let hi = data.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((data[mid].time as number) <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  const bar = data[best];
  return 'close' in bar ? bar : null;
}
