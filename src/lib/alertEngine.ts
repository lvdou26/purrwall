import { hlSocket } from './hl/ws';
import {
  crossed,
  fmtAlertPrice,
  getAlertPrefs,
  getAlerts,
  subscribeAlerts,
  type PriceAlert,
} from './alerts';
import { dict, initialLang } from './i18n';
import { setTitleBadge } from './pageTitle';

/**
 * The alert trigger loop. Watches the alert store, keeps exactly the WS
 * allMids subscriptions the alerted coins need (default feed + one per
 * HIP-3 dex — a Market.coin IS its allMids key, see hl/ws.ts), and fires on
 * every threshold crossing.
 *
 * Runs on allMids (mid prices, pushed every few seconds) rather than the
 * cells' candle streams, deliberately: alerts keep firing for markets that
 * are not on any wall, the wall's hidden-cell paint gating never delays a
 * trigger (ws.ts delivers to listeners synchronously even in hidden tabs),
 * and the whole engine costs at most a handful of WS subscriptions. A mid
 * can differ from the last trade by a fraction of a tick — the same source
 * HL's own UI headlines — which is well inside alert tolerance.
 *
 * Outputs on fire, per the user's prefs (see alerts.ts AlertPrefs):
 *   - the fire bus (App renders the toast stack, cells flash) — always
 *   - a short WebAudio chirp — no asset, but needs a user gesture once per
 *     page load to unlock the AudioContext (primeAudio below)
 *   - a system Notification — only when the page is hidden or unfocused
 *     (the toast already covers the looking-right-at-it case), and never
 *     requested here: permission is asked only when the user flips the
 *     toggle in the alert popover
 *   - a title + favicon badge while the tab is hidden, cleared the moment
 *     the user returns
 *
 * Honest limitation, stated in the popover UI: this is a client-side loop —
 * alerts live only while a Purrwall tab is open. Mini popouts do not start
 * the engine (App gates startAlertEngine on !isMini) so a wall plus its
 * popouts never double-fire; two full tabs can, which the Notification
 * `tag` dedupes for the system layer.
 */

export interface AlertFire {
  alert: PriceAlert;
  price: number;
  dir: 'up' | 'down';
}

const fireSubs = new Set<(f: AlertFire) => void>();

/** Subscribe to alert fires. Returns the unsubscribe. */
export function onAlertFire(fn: (f: AlertFire) => void): () => void {
  fireSubs.add(fn);
  return () => fireSubs.delete(fn);
}

// --- trigger loop ----------------------------------------------------------

/**
 * Each alert's own last-seen price, keyed per alert id — deliberately NOT a
 * per-coin baseline. A per-coin price is up to one push (or one reconnect
 * backoff) old, so an alert created on a coin that already had one would
 * evaluate its first sample against a price from BEFORE it existed and
 * could fire instantly for a pre-creation crossing. Per-alert, every
 * alert's own first sample only arms it — crossed() in alerts.ts (the
 * tested spec) returns null for prev=null.
 */
const armedPrice = new Map<string, number>();
const midsUnsubs = new Map<string, () => void>();

function onMids(mids: Record<string, string>): void {
  // Note: ws.ts fans EVERY allMids message to every mids listener, so with
  // the default feed plus a HIP-3 dex subscribed this runs more than once
  // per message — harmless, the repeat run sees prev === next.
  for (const a of getAlerts()) {
    const s = mids[a.coin];
    if (s === undefined) continue; // this message is another dex's feed
    const p = Number(s);
    if (!Number.isFinite(p) || p <= 0) continue;
    const dir = crossed(armedPrice.get(a.id) ?? null, p, a.price);
    armedPrice.set(a.id, p);
    if (dir) fire(a, p, dir);
  }
}

function reconcile(): void {
  const list = getAlerts();
  const needed = new Set<string>();
  for (const a of list) {
    // formula cells have no mid (the bell is hidden there); their id would
    // read as a dex named '=xyz' below
    if (a.coin.startsWith('=')) continue;
    const i = a.coin.indexOf(':');
    needed.add(i === -1 ? '' : a.coin.slice(0, i)); // '' = default feed (perp/spot/HIP-4)
  }
  for (const [dex, un] of midsUnsubs) {
    if (!needed.has(dex)) {
      un();
      midsUnsubs.delete(dex);
    }
  }
  for (const dex of needed) {
    if (!midsUnsubs.has(dex)) midsUnsubs.set(dex, hlSocket.subscribeAllMids(dex, onMids));
  }
  // Deleted alerts drop their arming state; a later alert never inherits it
  // (ids are never reused — see mintId in alerts.ts).
  const ids = new Set(list.map((a) => a.id));
  for (const id of armedPrice.keys()) {
    if (!ids.has(id)) armedPrice.delete(id);
  }
}

// --- outputs ---------------------------------------------------------------

function fire(alert: PriceAlert, price: number, dir: 'up' | 'down'): void {
  const f: AlertFire = { alert, price, dir };
  for (const fn of fireSubs) fn(f);
  const prefs = getAlertPrefs();
  if (prefs.sound) playPing();
  if (prefs.notify) notify(f);
  if (document.hidden) badgeTitle(f);
}

let audioCtx: AudioContext | null = null;

/** Create/resume the AudioContext. MUST be called from a user gesture —
 *  the popover calls it on every add/toggle, and the engine re-arms a
 *  first-gesture listener for the page-reload case. */
export function primeAudio(): void {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    /* no WebAudio — sound silently unavailable */
  }
}

/** Toggle-on preview: unlock audio (we are inside the click) and chirp once
 *  so the user hears what a fire will sound like — and learns immediately
 *  if their device is muted. */
export function previewPing(): void {
  primeAudio();
  const ctx = audioCtx;
  if (!ctx) return;
  if (ctx.state === 'running') playPing();
  else
    void ctx
      .resume()
      .then(() => playPing())
      .catch(() => {});
}

function playPing(): void {
  const ctx = audioCtx;
  if (!ctx || ctx.state !== 'running') return; // never primed → stay silent
  const t0 = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.12, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, t0); // A5 → E6, a light two-note chirp
  osc.frequency.setValueAtTime(1318.5, t0 + 0.09);
  osc.connect(gain);
  osc.start(t0);
  osc.stop(t0 + 0.4);
}

function notify(f: AlertFire): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden && document.hasFocus()) return; // toast covers the foreground case
  const lang = initialLang();
  const dirText = dict[lang][f.dir === 'up' ? 'alert_above' : 'alert_below'];
  try {
    const n = new Notification(f.alert.label, {
      body: `${dirText} ${fmtAlertPrice(f.alert.price)} · ${fmtAlertPrice(f.price)}`,
      icon: '/icon-192.png',
      // one live notification per alert: a choppy market updates it in
      // place instead of stacking dozens
      tag: `pw-alert-${f.alert.id}`,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* Android Chrome requires ServiceWorker-backed notifications — the
       page-level constructor throws. Sound/toast still cover the fire. */
  }
}

/** Ask for Notification permission (UI toggle path only — never automatic). */
export async function requestNotifyPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported'; // iOS Safari page context
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

let unseen = 0;
let origIcon: string | null = null;

// The title badge is a LAYER in lib/pageTitle.ts, not a stash of
// document.title: the live price ticker underneath keeps moving while the
// tab is hidden, and restoring a stashed string would paint a stale price
// over it on return.
function badgeTitle(f: AlertFire): void {
  unseen++;
  const arrow = f.dir === 'up' ? '↑' : '↓';
  setTitleBadge(
    `${unseen > 1 ? `(${unseen}) ` : ''}🔔 ${f.alert.label} ${arrow} ${fmtAlertPrice(f.alert.price)} | Purrwall`,
  );
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) {
    if (origIcon === null) origIcon = link.getAttribute('href');
    link.href = '/favicon-alert.svg';
  }
}

function clearBadge(): void {
  if (unseen === 0) return;
  unseen = 0;
  setTitleBadge(null);
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link && origIcon !== null) link.setAttribute('href', origIcon);
}

// --- lifecycle -------------------------------------------------------------

let started = false;

/** Idempotent; App calls it once per page (never in mini popouts). */
export function startAlertEngine(): void {
  if (started) return;
  started = true;
  reconcile();
  subscribeAlerts(reconcile);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clearBadge();
  });
  window.addEventListener('focus', clearBadge);
  // Reload with sound already enabled: unlock audio on the first gesture.
  // Not {once}: the first gesture may land while sound is still off — keep
  // listening until a gesture actually primes (then stop; toggling sound on
  // later is itself a gesture and primes directly in the click handler).
  const primeOnGesture = () => {
    if (!getAlertPrefs().sound) return;
    primeAudio();
    window.removeEventListener('pointerdown', primeOnGesture, true);
    window.removeEventListener('keydown', primeOnGesture, true);
  };
  window.addEventListener('pointerdown', primeOnGesture, true);
  window.addEventListener('keydown', primeOnGesture, true);
}
