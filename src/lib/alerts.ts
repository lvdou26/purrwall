import { useSyncExternalStore } from 'react';

/**
 * Price alerts — the store and the pure logic. The WS-driven trigger loop
 * lives in alertEngine.ts; everything here is importable under plain node
 * (vitest has no DOM), so browser globals are only touched behind guards.
 *
 * Semantics: an alert is a LEVEL, not a one-shot — it fires on EVERY
 * crossing, in either direction, with no cooldown. A user who finds a
 * choppy market noisy deletes the alert or moves the threshold; we do not
 * second-guess them with rate limiting. Percentage alerts resolve to an
 * absolute threshold at creation time (base × (1 + pct/100)) and behave
 * identically afterwards — pct/base are kept only so the UI can say where
 * the number came from.
 */

export type AlertMode = 'price' | 'pct';

export interface PriceAlert {
  id: string;
  /** Market.coin — byte-identical to the allMids key (see hl/ws.ts). */
  coin: string;
  /** Display name captured at creation. Resolving a coin id needs the loaded
   *  catalog; snapshotting the label keeps toasts/notifications readable for
   *  alerts on markets not currently on any wall. A later HL rename only
   *  staleness-es the label, never the trigger. */
  label: string;
  /** Absolute threshold. The only field the trigger loop reads. */
  price: number;
  mode: AlertMode;
  /** pct mode only: the signed percent the user typed. */
  pct?: number;
  /** pct mode only: the price the percent was applied to. */
  base?: number;
  createdAt: number;
}

export interface AlertPrefs {
  sound: boolean;
  notify: boolean;
}

const ALERTS_KEY = 'purrwall.alerts.v1';
const PREFS_KEY = 'purrwall.alertPrefs.v1';
/** localStorage safety valve; the UI refuses new alerts past it. */
export const MAX_ALERTS = 100;

// ---------------------------------------------------------------------------
// Pure logic (pinned in alerts.test.ts)

/**
 * Crossing detection: which side of the threshold is a price on, did the side
 * change between two consecutive samples, and in which direction. Touching
 * the level exactly counts as being at-or-above it, so a tick that lands ON
 * the threshold from below fires 'up' (the level traded). The first sample
 * for a coin has no predecessor and never fires — callers pass prev=null.
 */
export function crossed(
  prev: number | null,
  next: number,
  threshold: number,
): 'up' | 'down' | null {
  if (prev === null || !Number.isFinite(prev) || !Number.isFinite(next)) return null;
  const prevAbove = prev >= threshold;
  const nextAbove = next >= threshold;
  if (prevAbove === nextAbove) return null;
  return nextAbove ? 'up' : 'down';
}

/** pct-mode threshold: +5 on 100 → 105, -5 → 95. */
export function pctTarget(base: number, pct: number): number {
  return base * (1 + pct / 100);
}

/**
 * One price formatter for every alert surface (toast, notification, popover
 * rows, title badge) — same one-formatter rule as fmtFunding/compactUsd in
 * hl/stats.ts. Echoes the user's own precision (up to HL's 8 decimals)
 * rather than a magnitude tier: an alert at 65000.5 must never read 65,001.
 */
const alertFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });
export function fmtAlertPrice(p: number): string {
  return alertFmt.format(p);
}

/** Storage-shape validation: anything that isn't a well-formed alert is
 *  dropped, the rest is capped. Exported for the test suite. */
export function sanitizeAlerts(raw: unknown): PriceAlert[] {
  if (!Array.isArray(raw)) return [];
  const out: PriceAlert[] = [];
  for (const it of raw) {
    if (out.length >= MAX_ALERTS) break;
    if (typeof it !== 'object' || it === null) continue;
    const a = it as Record<string, unknown>;
    if (typeof a.id !== 'string' || a.id.length === 0 || a.id.length > 40) continue;
    if (typeof a.coin !== 'string' || a.coin.length === 0 || a.coin.length > 64) continue;
    if (typeof a.price !== 'number' || !Number.isFinite(a.price) || a.price <= 0) continue;
    if (a.mode !== 'price' && a.mode !== 'pct') continue;
    const label =
      typeof a.label === 'string' && a.label.length > 0 ? a.label.slice(0, 64) : a.coin;
    const alert: PriceAlert = {
      id: a.id,
      coin: a.coin,
      label,
      price: a.price,
      mode: a.mode,
      createdAt: typeof a.createdAt === 'number' && Number.isFinite(a.createdAt) ? a.createdAt : 0,
    };
    if (typeof a.pct === 'number' && Number.isFinite(a.pct)) alert.pct = a.pct;
    if (typeof a.base === 'number' && Number.isFinite(a.base) && a.base > 0) alert.base = a.base;
    out.push(alert);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store — same shape as favorites.ts: module singleton, read-merge-write on
// mutation, storage listener for cross-tab convergence, useSyncExternalStore
// hooks for React surfaces, plain subscribe for the engine.

/** null = storage unreadable (blocked/corrupt) — callers fall back to the
 *  in-memory copy so blocked storage degrades to session-local alerts. */
function loadAlerts(): PriceAlert[] | null {
  try {
    const raw = localStorage.getItem(ALERTS_KEY);
    return sanitizeAlerts(raw ? JSON.parse(raw) : []);
  } catch {
    return null;
  }
}

function loadPrefs(): AlertPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const p = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return { sound: p.sound === true, notify: p.notify === true };
  } catch {
    return { sound: false, notify: false };
  }
}

let alerts: PriceAlert[] = [];
let prefs: AlertPrefs = { sound: false, notify: false };
if (typeof localStorage !== 'undefined') {
  alerts = loadAlerts() ?? [];
  prefs = loadPrefs();
}

const subs = new Set<() => void>();
function emit(): void {
  for (const fn of subs) fn();
}

// storage events fire only in OTHER tabs — the cross-tab half.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === ALERTS_KEY) {
      alerts = loadAlerts() ?? alerts;
      emit();
    } else if (e.key === PREFS_KEY) {
      prefs = loadPrefs();
      emit();
    }
  });
}

function persistAlerts(next: PriceAlert[]): void {
  alerts = next;
  try {
    localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — alerts stay session-local */
  }
  emit();
}

let idSeq = 0;
function mintId(): string {
  // The id only needs to be unique within one device's alert list: time +
  // per-load sequence + random suffix is enough, no crypto.randomUUID.
  return `a${Date.now().toString(36)}-${(idSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Returns the created alert, or null when the cap is reached. */
export function addAlert(
  a: Omit<PriceAlert, 'id' | 'createdAt'>,
): PriceAlert | null {
  // Re-read before writing: another tab may have edited since our snapshot.
  const cur = loadAlerts() ?? alerts;
  if (cur.length >= MAX_ALERTS) return null;
  const alert: PriceAlert = { ...a, id: mintId(), createdAt: Date.now() };
  persistAlerts([...cur, alert]);
  return alert;
}

export function removeAlert(id: string): void {
  const cur = loadAlerts() ?? alerts;
  persistAlerts(cur.filter((a) => a.id !== id));
}

export function getAlerts(): PriceAlert[] {
  return alerts;
}

export function subscribeAlerts(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function useAlerts(): PriceAlert[] {
  return useSyncExternalStore(subscribeAlerts, getAlerts);
}

export function getAlertPrefs(): AlertPrefs {
  return prefs;
}

export function setAlertPrefs(patch: Partial<AlertPrefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage blocked — prefs stay session-local */
  }
  emit();
}

export function useAlertPrefs(): AlertPrefs {
  return useSyncExternalStore(subscribeAlerts, getAlertPrefs);
}
