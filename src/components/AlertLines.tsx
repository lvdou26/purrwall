import { useEffect } from 'react';
import { LineStyle, type ISeriesApi } from 'lightweight-charts';
import { useAlerts } from '../lib/alerts';

/**
 * Dashed horizontal lines at this market's alert thresholds. Rendered only
 * while the cell is `live` (so the series ref is guaranteed non-null — child
 * effects run before ChartCell's chart-creation effect on first mount), owns
 * its price lines from an effect, and paints NO text over the candles: the
 * exact level lives in the axis label, the words live in the popover.
 */
export function AlertLines({
  seriesRef,
  coin,
}: {
  seriesRef: { current: ISeriesApi<'Candlestick'> | null };
  coin: string;
}) {
  const alerts = useAlerts();
  // One string capturing everything the lines depend on — an unrelated
  // alert (other coin) changing must not redraw this cell's lines.
  const linesKey = alerts
    .filter((a) => a.coin === coin)
    .map((a) => `${a.id}:${a.price}`)
    .join('|');

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || linesKey === '') return;
    const lines = linesKey.split('|').map((part) => {
      const price = Number(part.slice(part.lastIndexOf(':') + 1));
      return series.createPriceLine({
        price,
        // Warn-yellow, distinct from the up/down candle colors; dimmed — a
        // reference level, not data.
        color: 'rgba(240, 185, 11, 0.65)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '', // never paint text over the price action
      });
    });
    return () => {
      // Whole-cell unmount runs cleanups PARENT-first (React 19 deleted-
      // subtree order): ChartCell has already nulled the ref and called
      // chart.remove(), and removePriceLine on the disposed series schedules
      // an uncatchable async 'Object is disposed' draw. ChartCell nulls the
      // ref BEFORE disposing, so this guard exactly separates that case from
      // an AlertLines-only unmount (alert deleted, status left 'live'),
      // where the series is live and the lines must really be removed.
      if (seriesRef.current !== series) return;
      for (const l of lines) series.removePriceLine(l);
    };
  }, [seriesRef, coin, linesKey]);

  return null;
}
