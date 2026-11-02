/**
 * Coalesces chart updates into one requestAnimationFrame flush. WS ticks can
 * arrive many times per second per market; only the latest update per key is
 * applied, and all charts paint in the same frame.
 */
const pending = new Map<string, () => void>();
let scheduled = false;

export function scheduleRender(key: string, task: () => void): void {
  pending.set(key, task);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const tasks = Array.from(pending.values());
    pending.clear();
    for (const task of tasks) task();
  });
}
