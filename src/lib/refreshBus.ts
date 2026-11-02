/**
 * Manual wall-wide refresh broadcast (pull-to-refresh). Cells subscribe
 * with the exact handler shape they already use for hlSocket.onReconnect:
 * the pull asks every mounted cell for a gap-HEAL (never a wipe), so a pull
 * is cheap (~20 weight/cell), keeps the viewport, and dims prices under the
 * same honesty contract as a reconnect. A module store (favorites.ts
 * pattern) rather than a React prop keeps ChartCell's subscription effect
 * mount-once.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function onManualRefresh(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitManualRefresh(): void {
  // snapshot: a listener re-rendering mid-emit must not mutate the iteration
  for (const fn of [...listeners]) fn();
}
