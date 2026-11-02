/**
 * The tab title as a live price ticker — `75,585 | BTC | Purrwall`, the
 * format Hyperliquid's own trade page uses (`75,585 | BTC | Hyperliquid`),
 * price FIRST because a tab strip truncates from the right and the number
 * is what the glance is for.
 *
 * Who drives it: exactly one chart at a time, chosen by PRIORITY, never by
 * a setting — `focus` (the expanded wall cell or the list view's chart
 * card: the one market on screen) beats `wall` (the wall's first cell whose
 * coin resolves, top-left — dragging another chart there is the whole
 * control). ChartCell publishes the price straight from its WebSocket
 * callback (a hidden tab suspends rAF, and the tab strip is the one place a
 * title is read while hidden) and clears its slot when it stops owning it
 * or unmounts.
 *
 * Composition, highest first:
 *   1. the alert BADGE (alertEngine: "(2) 🔔 BTC ↑ 75,000 | Purrwall") —
 *      set while the tab is hidden and an alert fires, cleared on return.
 *      A layer, not a stash-and-restore of document.title: with a ticker
 *      underneath, a restore would re-paint a stale price, while a layer
 *      lets the live title resume on its own.
 *   2. the live source: `price | name | Purrwall`, or `name | Purrwall`
 *      until a price lands (or after the cell hid a stale one).
 *   3. the static <title> from index.html (empty wall, catalog down, not
 *      yet armed).
 *
 * THE WRITER (this module is the only thing that assigns document.title):
 *   - every source change is coalesced into ONE microtask — a React commit
 *     runs every cleanup before every effect, so a slot handover is always
 *     clear-then-set in one task, and one write must come out of it (a
 *     leading-edge write on the clear alone would flash the fallback title
 *     for up to a second);
 *   - a change to anything but the price segment (slot handover, name,
 *     static↔live) writes at once; a PRICE-ONLY change writes at once if
 *     ≥1 s has passed, else arms one trailing timer for the latest value.
 *     The 1 Hz cap is legibility only (a number flickering five times a
 *     second reads as nervous); the leading edge is what keeps a hidden
 *     tab honest, where timers are throttled to 1 s wakeups (1/min under
 *     Chrome's intensive throttling) — lag is bounded by one tick, never
 *     by a timer;
 *   - badge writes are synchronous and bypass everything;
 *   - unchanged strings are never rewritten.
 *
 * ARMING (search engines): Google renders JavaScript and can index a
 * JS-set <title>, and the page should be indexed under the static tagline,
 * not under "BTC | Purrwall". Nothing is written until a human signal — a
 * pointer/key/touch, a window blur, a visibilitychange (switching tabs,
 * i.e. the very act of glancing at a tab strip) — or a boot that is
 * already a background tab (?mini=1 popouts, document.hidden at load). A
 * renderer fires none of those. Residual risk: a crawler that boots
 * hidden. What Chromium then does with the writes (per its source):
 * history records a title only while loading or within 5 s of load (≤10
 * changes), so the root URL's history row keeps the static title unless a
 * gesture lands inside that window; same-document navigations (#list/#pos)
 * stamp their visit with the current live title; bookmarks take it too.
 *
 * `createTitleController` is the whole writer with its clock, timers,
 * scheduler and sink injected, so pageTitle.test.ts pins the coalescing,
 * the limiter, the badge bypass and the arming gate in node.
 */

export const BRAND = 'Purrwall';

export type TitleSlot = 'focus' | 'wall';

export interface TitleSource {
  /** Header display name (the bare coin for perps, the pair for spot,
   *  questions and formulas whole). */
  name: string;
  /** Already formatted at the cell's precision; null before the first
   *  price, or after a stale one was hidden. */
  price: string | null;
}

/** Pure: the title for a given layering. */
export function composeTitle(
  badge: string | null,
  source: TitleSource | null,
  staticTitle: string,
): string {
  if (badge) return badge;
  if (!source) return staticTitle;
  const name = source.name.trim();
  if (!name) return staticTitle;
  return source.price ? `${source.price} | ${name} | ${BRAND}` : `${name} | ${BRAND}`;
}

/** Pure: the slot that wins — `focus` over `wall`, absent slots skipped. */
export function pickSource(slots: Partial<Record<TitleSlot, TitleSource | null>>): TitleSource | null {
  return slots.focus ?? slots.wall ?? null;
}

/** Everything but the price digits — two titles with the same shape differ
 *  only in the number, and only those writes are rate-limited. */
function shapeOf(badge: string | null, source: TitleSource | null, staticTitle: string): string {
  return composeTitle(
    badge,
    source ? { name: source.name, price: source.price ? '#' : null } : null,
    staticTitle,
  );
}

export const MIN_WRITE_GAP_MS = 1000;

export interface TitleDeps {
  write: (title: string) => void;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** End-of-task coalescing; queueMicrotask in the browser (never throttled). */
  schedule: (fn: () => void) => void;
  staticTitle: string;
}

export interface TitleController {
  setSource(slot: TitleSlot, source: TitleSource | null): void;
  setBadge(text: string | null): void;
  /** The page is about to be frozen (Page Lifecycle `freeze`): drop every
   *  slot's price and write NOW — the string written here is what a frozen
   *  tab's strip shows for hours. Prices return with fresh data on resume. */
  suspend(): void;
  arm(): void;
  /** The string the page currently carries. */
  current(): string;
}

export function createTitleController(deps: TitleDeps, armed = false): TitleController {
  const slots: Partial<Record<TitleSlot, TitleSource | null>> = {};
  let badge: string | null = null;
  let last = deps.staticTitle;
  let lastShape = deps.staticTitle;
  let lastWriteAt = -Infinity;
  let trailing: unknown = null;
  let pending = false;
  let isArmed = armed;

  const cancelTrailing = () => {
    if (trailing !== null) {
      deps.clearTimeout(trailing);
      trailing = null;
    }
  };
  const commit = (next: string, nextShape: string) => {
    last = next;
    lastShape = nextShape;
    lastWriteAt = deps.now();
    deps.write(next);
  };
  const writeLatest = () => {
    const src = pickSource(slots);
    const next = composeTitle(badge, src, deps.staticTitle);
    if (next !== last) commit(next, shapeOf(badge, src, deps.staticTitle));
  };
  const flush = () => {
    pending = false;
    if (!isArmed) return;
    const src = pickSource(slots);
    const next = composeTitle(badge, src, deps.staticTitle);
    if (next === last) return;
    const nextShape = shapeOf(badge, src, deps.staticTitle);
    const wait = MIN_WRITE_GAP_MS - (deps.now() - lastWriteAt);
    if (nextShape !== lastShape || wait <= 0) {
      cancelTrailing();
      commit(next, nextShape);
      return;
    }
    if (trailing === null) {
      trailing = deps.setTimeout(() => {
        trailing = null;
        writeLatest();
      }, wait);
    }
  };
  const request = () => {
    if (pending) return;
    pending = true;
    deps.schedule(flush);
  };

  return {
    setSource(slot, source) {
      const cur = slots[slot];
      if (cur === source || (cur && source && cur.name === source.name && cur.price === source.price))
        return;
      slots[slot] = source;
      request();
    },
    setBadge(text) {
      if (badge === text) return;
      badge = text;
      cancelTrailing();
      // an unarmed page (no human signal yet) shows a badge but never the
      // ticker: clearing it falls back to the static title
      if (!isArmed && text === null) {
        if (last !== deps.staticTitle) commit(deps.staticTitle, deps.staticTitle);
        return;
      }
      writeLatest();
    },
    suspend() {
      for (const slot of ['focus', 'wall'] as const) {
        const cur = slots[slot];
        if (cur?.price) slots[slot] = { name: cur.name, price: null };
      }
      cancelTrailing();
      writeLatest(); // synchronous: the freeze lands right after this handler
    },
    arm() {
      if (isArmed) return;
      isArmed = true;
      request();
    },
    current: () => last,
  };
}

// ── the page's controller ──────────────────────────────────────────────────

const controller: TitleController | null =
  typeof document === 'undefined'
    ? null
    : createTitleController(
        {
          write: (t) => {
            document.title = t;
          },
          now: () => Date.now(),
          setTimeout: (fn, ms) => window.setTimeout(fn, ms),
          clearTimeout: (h) => window.clearTimeout(h as number),
          schedule: (fn) => queueMicrotask(fn),
          // read ONCE at load (dev HMR trap: a re-evaluated module would
          // read the live title as "static" — reload after editing this file)
          staticTitle: document.title,
        },
        new URLSearchParams(window.location.search).has('mini') ||
          document.hidden ||
          // a tab the browser discarded is being reloaded by the click that
          // returned to it — a human signal, and the title it had was live
          (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true,
      );

if (controller) {
  const arm = () => controller.arm();
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(ev, arm, { capture: true, once: true, passive: true });
  }
  window.addEventListener('blur', arm, { once: true });
  document.addEventListener('visibilitychange', arm, { once: true });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) arm(); // bfcache restore: the page was live before
  });
  // Page Lifecycle freeze (Chrome ≥133 Battery Saver, hidden >5 min): the
  // last write before the freeze is what the tab strip shows for hours —
  // make it the name without a number, never a price about to go stale.
  document.addEventListener('freeze', () => controller.suspend());
}

/** Publish (or clear with null) the market a slot shows. */
export function setTitleSource(slot: TitleSlot, source: TitleSource | null): void {
  controller?.setSource(slot, source);
}

/** The alert badge layer (null clears it). Owned by alertEngine. */
export function setTitleBadge(text: string | null): void {
  controller?.setBadge(text);
}
