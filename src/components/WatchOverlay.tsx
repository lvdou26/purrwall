import { useEffect, useSyncExternalStore } from 'react';
import { LineStyle, MismatchDirection, type ISeriesApi } from 'lightweight-charts';
import {
  getOverlayOrders,
  getOverlayPositions,
  getWatchCounts,
  getWatchVersion,
  subscribeWatch,
  watchLabel,
} from '../lib/watch';
import { OVERLAY_BUDGET_COARSE, OVERLAY_BUDGET_FINE, overlayLevels } from '../lib/hl/userState';
import { compactUsd } from '../lib/hl/stats';
import { useT } from '../lib/i18n';
import { IS_COARSE } from '../lib/media';

/**
 * The chart overlay: the UNION of every wallet the user chose to show
 * (per-entry `show` flags + the overlay master switch) on this cell's
 * market — entry price (solid, side-colored), liquidation (amber dotted,
 * absent when null), resting orders (dashed; trigger/TPSL dotted), deduped
 * per distinct level across wallets. Same contract as AlertLines: rendered
 * only while the cell is `live`, owns its price lines from one effect, no
 * text over the candles — exact levels live in the axis labels, words in
 * the chip.
 *
 * AXIS LABELS ARE PER-CLASS (hl/userState.ts overlayLevels, vitest-pinned):
 * every line is drawn, but only entry, liquidation, the trigger levels
 * within budget and the limit ladder's edges (the next order to fill on
 * each side + the far end; a small ladder entirely) carry a label —
 * otherwise a wallet with ~18 orders on a coin turns the axis into a solid
 * stacked column hiding every tick number. lightweight-charts spreads
 * the survivors itself (priceScale.alignLabels stacks overlapping labels
 * one label height apart, whole groups shifted back inside the pane), so
 * no pixel math lives here and zoom/autoscale need no subscription. Order
 * labels take a darker tone than position labels so a stack reads
 * position-vs-order without words. The library STRIPS the alpha from label
 * backgrounds (a 0.5-alpha line color paints an opaque label) — opacity is
 * never a way to dim a label; visibility and hue are the only levers. NOTE
 * for a future "upgrade" to a series primitive: primitive axis views carry
 * 2/12·fontSize of extra padding per side that price-line labels do not, so
 * the library's stacking overdraws them by ~4px — a primitive must place
 * its labels itself (fixedCoordinate).
 */

const COLOR_LONG = 'rgba(31, 191, 117, 0.9)';
const COLOR_SHORT = 'rgba(246, 70, 93, 0.9)';
const COLOR_LIQ = 'rgba(240, 136, 62, 0.8)';
const COLOR_BUY = 'rgba(31, 191, 117, 0.5)';
const COLOR_SELL = 'rgba(246, 70, 93, 0.5)';
/** Order-label fills: the side hue at ~half brightness (the library picks
 *  white text on both) so an entry label pops against its own ladder. */
const LABEL_BUY = 'rgb(24, 122, 78)';
const LABEL_SELL = 'rgb(150, 46, 62)';

const useWatchVersion = () => useSyncExternalStore(subscribeWatch, getWatchVersion);

interface LineSpec {
  price: number;
  color: string;
  style: LineStyle;
  label: boolean;
  labelColor?: string;
}

/** One line spec per DISTINCT level across every shown wallet — many orders
 *  at one price draw one line, keeping market-maker accounts legible. */
function lineSpecs(coin: string, lastPx: () => number | null): LineSpec[] {
  const positions = getOverlayPositions(coin).map((h) => h.pos);
  const levels = overlayLevels(
    positions,
    getOverlayOrders(coin),
    lastPx,
    IS_COARSE ? OVERLAY_BUDGET_COARSE : OVERLAY_BUDGET_FINE,
  );
  return levels.map((l) => {
    if (l.kind === 'entry') {
      return {
        price: l.price,
        color: l.side === 'B' ? COLOR_LONG : COLOR_SHORT,
        style: LineStyle.Solid,
        label: l.label,
      };
    }
    if (l.kind === 'liq') {
      return { price: l.price, color: COLOR_LIQ, style: LineStyle.Dotted, label: l.label };
    }
    return {
      price: l.price,
      color: l.side === 'B' ? COLOR_BUY : COLOR_SELL,
      style: l.trigger ? LineStyle.Dotted : LineStyle.Dashed,
      label: l.label,
      labelColor: l.side === 'B' ? LABEL_BUY : LABEL_SELL,
    };
  });
}

export function WatchOverlay({
  seriesRef,
  coin,
}: {
  seriesRef: { current: ISeriesApi<'Candlestick'> | null };
  coin: string;
}) {
  useWatchVersion();
  // Read lazily and only when trigger levels exceed their budget — the
  // common path never touches chart state during render.
  const lastPx = (): number | null => {
    const bar = seriesRef.current?.dataByIndex(Number.MAX_SAFE_INTEGER, MismatchDirection.NearestLeft);
    return bar && 'close' in bar ? bar.close : null;
  };
  const specs = lineSpecs(coin, lastPx);
  // One string capturing everything the lines depend on — a 5s state re-push
  // with unchanged levels must not tear down and recreate every line.
  const linesKey = specs.map((s) => `${s.price}:${s.color}:${s.style}:${s.label ? 1 : 0}`).join('|');

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || linesKey === '') return;
    const lines = specs.map((s) =>
      series.createPriceLine({
        price: s.price,
        color: s.color,
        lineWidth: 1,
        lineStyle: s.style,
        axisLabelVisible: s.label,
        ...(s.labelColor ? { axisLabelColor: s.labelColor } : {}),
        title: '', // never paint text over the price action
      }),
    );
    return () => {
      // Disposal guard — see AlertLines.tsx: on whole-cell unmount ChartCell
      // nulls the ref before chart.remove(), and removing lines from the
      // disposed series schedules an uncatchable async draw.
      if (seriesRef.current !== series) return;
      for (const l of lines) series.removePriceLine(l);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesRef, coin, linesKey]);

  return null;
}

/** Live position/order counts + the create-wall button for the watch dialog.
 *  Its own component so ONLY the open dialog rides the ~5s data-version
 *  stream — App itself subscribes to primitives that move on user actions. */
export function WatchAccountPanel({ onCreateWall }: { onCreateWall: () => void }) {
  const tr = useT();
  useWatchVersion();
  const counts = getWatchCounts();
  const empty = counts.positions + counts.orders === 0;
  return (
    <>
      <p className="wm-note">
        {empty
          ? tr('watch_none_yet')
          : `${counts.positions} ${tr('watch_pos_n')} · ${counts.orders} ${tr('watch_ord_n')}`}
      </p>
      <button className="share-btn" disabled={empty} onClick={onCreateWall}>
        {tr('watch_poswall')}
      </button>
    </>
  );
}

/** Summed unrealized PnL of every SHOWN wallet's position on this market;
 *  the tooltip breaks it down per wallet. */
export function WatchChip({ coin }: { coin: string }) {
  const tr = useT();
  useWatchVersion();
  const held = getOverlayPositions(coin);
  if (held.length === 0) return null;
  const total = held.reduce((a, h) => a + h.pos.uPnl, 0);
  const sign = total >= 0 ? '+' : '−';
  const a = Math.abs(total);
  const amount = a >= 1000 ? compactUsd(a) : `$${a.toFixed(2)}`;
  // The ladder's size and shape, one hover away: the axis does not label
  // every order (see the header), so the count lives here.
  const orders = getOverlayOrders(coin);
  const buys = orders.filter((o) => o.side === 'B').length;
  const ladder =
    orders.length > 0
      ? ` · ${orders.length} ${tr('watch_ord_n')} (▲${buys} ▼${orders.length - buys})`
      : '';
  const title =
    (held.length === 1
      ? (() => {
          const p = held[0].pos;
          return (
            `${tr('w_pnl')} · ${tr(p.szi > 0 ? 'w_long' : 'w_short')}${p.leverage ? ` ${p.leverage}x` : ''}` +
            ` · ${tr('w_entry')} ${p.entryPx}` +
            (p.liqPx != null ? ` · ${tr('w_liq')} ${p.liqPx}` : '')
          );
        })()
      : `${tr('w_pnl')} · ` +
        held
          .map((h) => `${watchLabel(h.addr)} ${h.pos.uPnl >= 0 ? '+' : '−'}$${Math.abs(h.pos.uPnl).toFixed(0)}`)
          .join(' · ')) + ladder;
  return (
    <span className={total >= 0 ? 'up' : 'down'} title={title}>
      P {sign}
      {amount}
    </span>
  );
}
