import type { Candle } from './types';

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const PING_INTERVAL_MS = 30_000;
/** No server message (incl. pong) for this long → the socket is half-open, kill it.
 *  A backstop: the silence probe below writes a dead socket off long before
 *  this. */
const STALE_SOCKET_MS = 90_000;
/** No server frame for this long → probe (ping + PROBE_TIMEOUT_MS of grace).
 *  Re-armed from every `message` event and never from inside a timer
 *  callback, so Chrome's intensive throttling (timers chained ≥5 deep in a
 *  tab hidden >5 min fire once a MINUTE) cannot stretch it — that throttling
 *  stretches the 30 s interval ping to 60 s on a quiet wall, the edge of
 *  HL's rule (the server closes a socket it has not SENT to for 60 s;
 *  pongs count, so a ping every ~25 s of silence keeps a quiet socket
 *  alive by itself). Without the probe, detecting a dead socket takes the
 *  90 s watchdog + one 30/60 s tick + Chromium's 60 s close handshake
 *  (2.5–3.5 min of live-coloured frozen prices); with it, ~30 s. */
const SILENCE_PROBE_MS = 25_000;
const MAX_RECONNECT_DELAY_MS = 15_000;
/** Wake probe: ping now, and this much silence afterwards means the socket died
 *  under us (radio handoff, sleep) — don't wait out the 90s stale window. */
const PROBE_TIMEOUT_MS = 5_000;
/** A dial that hasn't opened by now is likely black-holed (network flipped
 *  mid-connect) — give up and let the normal onclose/backoff path retry. */
const CONNECT_TIMEOUT_MS = 10_000;
/** After the OS says `offline`, how long the close() we send may sit in
 *  CLOSING before the socket is written off. A live peer acks a close frame
 *  within an RTT; with the radio gone the browser keeps the socket CLOSING
 *  until its own handshake timeout — on a real WiFi drop Chrome takes
 *  18–30 s and iOS Safari ~5 s (under CDP offline emulation it never
 *  closes) — and every status cue hangs off onclose, so without this the
 *  wall would sit live-coloured with frozen prices for exactly that long.
 *  See onOffline. */
const OFFLINE_ABANDON_MS = 1_000;
/** Wake-driven dials + ladder resets fire only after this much wake-event
 *  SILENCE. connection.change chatters in Chromium (downlink/rtt estimate
 *  shifts caused by our own traffic fire it too), and an undebounced
 *  reset-and-dial would bypass the `stabilized` guard during an
 *  accept-then-drop outage — re-creating the 1s reconnect/heal storm the
 *  backoff ladder exists to prevent. A genuine unlock arrives after minutes
 *  of silence, so the debounce never delays it; OPEN-socket probes stay
 *  undebounced (single-flight, one ping each). */
const WAKE_DIAL_DEBOUNCE_MS = 30_000;
/**
 * Unknown-coin quarantine (docs/architecture.md → Ids and unknown ids): a
 * candle subscription for an id OUTSIDE HL's universe (a typo, a removed id,
 * a foreign `=…` formula id) makes HL close the WHOLE socket with 1006
 * ~170–520ms later — no error message, no ack. Everything sent before it on
 * that socket is acked first (in-order processing, TCP keeps the order),
 * everything after it is never processed. Left alone, one bad id in
 * subPayloads is an infinite close → backoff → replay → close loop that
 * fires the wall-wide reconnect heal on every reopen (the storm class of
 * Invariant 2). So every subscribe is logged per socket, acks
 * (`subscriptionResponse`) tick entries off, and when a socket that ACKED
 * something closes within this window of a still-unacked subscribe, the
 * EARLIEST such entry is the culprit (the ids behind it are innocent — they
 * were never processed). Two consecutive strikes quarantine the id: it
 * leaves subPayloads for good, its cells get told, and only the cell's
 * manual Retry lifts it. Two strikes, not one, so a genuine drop that
 * happens to land ~1s after a fresh subscribe costs nothing (a bad id
 * strikes deterministically on every replay; a coincidence does not
 * repeat); the ~4× headroom over the measured close latency keeps a slow
 * server-side close inside the window. The ack gate is what keeps outages
 * out of it: a server that accepts and drops in silence, or one whose
 * gateway answers pings while its subscription backend is down, acks
 * nothing — so nothing is ever blamed and the backoff ladder handles it like
 * any outage. A bad id that sits FIRST in line kills the socket before
 * anything is acked — the same silent shape as an outage — so such a close
 * pushes that key to the back of the next replay (`replayLast`): the others
 * get acked first and the verdict follows on the next close. The one shape
 * that stays on the ladder is a wall whose ONLY subscription is the bad
 * id (nothing else there to be acked).
 */
const UNACKED_CLOSE_WINDOW_MS = 2_000;
const QUARANTINE_STRIKES = 2;
/** A lone strike older than this is forgotten — "consecutive" means within
 *  one reconnect ladder, not once an hour by chance. */
const STRIKE_TTL_MS = 60_000;

interface CandleSub {
  type: 'candle';
  coin: string;
  interval: string;
}

interface AllMidsSub {
  type: 'allMids';
  dex?: string;
}

/** Address-keyed account-state channels (the watch feature). All push a full
 *  snapshot immediately on subscribe and re-push complete state every ~5s —
 *  self-healing, no reconcile logic needed.
 *  Positions/orders are PER-DEX: the default feed ('') carries the main
 *  clearinghouse (incl. spot orders); each HIP-3 dex needs its own sub.
 *  spotState (balances) is chain-global — subscribe it with dex ''. */
type UserChannel = 'clearinghouseState' | 'openOrders' | 'spotState';

interface UserSub {
  type: UserChannel;
  user: string;
  dex?: string;
}

type Subscription = CandleSub | AllMidsSub | UserSub;

/** One subscribe frame on one socket, ticked off by its `subscriptionResponse`
 *  (or by the `error` frame HL answers a malformed one with — processed either way). */
interface SentSub {
  key: string;
  at: number;
  acked: boolean;
}

type CandleListener = (candle: Candle) => void;
/** The subscription was quarantined (HL closes the socket on this id) —
 *  the listener will never fire again and the id is not replayed. */
type RejectListener = () => void;
/** A snapshot of mids keyed by coin id — idempotent, last write wins. */
type MidsListener = (mids: Record<string, string>) => void;
/** Raw channel payload (`data` of the WS message) — the watch store parses it. */
type UserStateListener = (data: unknown) => void;

/** Connection status surfaced to the UI: 'live' is healthy (or optimistically connecting), 'reconnecting' is unhealthy. */
export type WsStatus = 'live' | 'reconnecting';

function candleKey(coin: string, interval: string): string {
  return `candle:${coin}:${interval}`;
}

/**
 * The listener-map key of any subscription object — ours or HL's echo of it
 * (a `subscriptionResponse` returns the subscription verbatim, except that
 * user-state echoes spell the main dex as `dex: ''` while allMids omits the
 * field; `?? ''` folds both onto the keys the subscribe paths build).
 */
function subKey(sub: Subscription): string {
  if (sub.type === 'candle') return candleKey(sub.coin, sub.interval);
  if (sub.type === 'allMids') return `mids:${sub.dex ?? ''}`;
  return `user:${sub.type}:${sub.dex ?? ''}:${sub.user.toLowerCase()}`;
}

/**
 * One shared WebSocket for the whole app. Hyperliquid allows 10 connections
 * and 1000 subscriptions per IP — a single connection carries every chart on
 * the wall with plenty of headroom. Reconnects with backoff, re-subscribes on
 * reconnect, and detects half-open sockets via message-liveness (a ping goes
 * out every 30s, so a healthy socket always has traffic).
 *
 * The candle channel only pushes the current in-progress bar — it never
 * replays closed bars — so consumers must re-backfill after a reconnect;
 * subscribe via onReconnect for that signal.
 *
 * Exported for the vitest harness (ws.test.ts drives fresh instances over a
 * fake WebSocket); the app only ever uses the `hlSocket` singleton below.
 */
export class HLSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<CandleListener>>();
  private subPayloads = new Map<string, CandleSub>();
  private rejectListeners = new Map<string, Set<RejectListener>>();
  /** Candle keys HL closes the socket on — never replayed, never re-sent. */
  private quarantined = new Set<string>();
  /** Consecutive unacked-close strikes per candle key (see the constants). */
  private strikes = new Map<string, { count: number; at: number }>();
  /** Candle keys replayed AFTER the rest: each was first in line on a socket
   *  that closed without acking anything. Cleared by an ack. A set rather
   *  than Map order because the reconnect heal re-subscribes every cell in
   *  wall order on each reopen, which would put the suspect back in front. */
  private replayLast = new Set<string>();
  /** The CURRENT socket's subscribe log; swapped with the socket in ensureConnected. */
  private sendLog: SentSub[] = [];
  // allMids (live table prices): one sub covers native perps + spot + HIP-4;
  // HIP-3 needs one sub per dex. ~5s server push cadence, a few KB each.
  private midsListeners = new Map<string, Set<MidsListener>>();
  private midsPayloads = new Map<string, AllMidsSub>();
  // Account-state channels for the watch feature (idempotent snapshots, ~5s).
  private userListeners = new Map<string, Set<UserStateListener>>();
  private userPayloads = new Map<string, UserSub>();
  private reconnectDelay = 1_000;
  private reconnectTimer: number | undefined;
  private teardownTimer: number | undefined;
  private reconnectListeners = new Set<() => void>();
  private everOpened = false;
  private status: WsStatus = 'live';
  private statusListeners = new Set<(s: WsStatus) => void>();
  private firstSubscribeAt = 0;
  private coldBlockTimer: number | undefined;
  /** Liveness probe bound to the CURRENT socket (set in ensureConnected). */
  private probeSocket: (() => void) | null = null;
  private dialStartedAt = 0;
  private lastWakeEventAt = 0;
  private offlineTimer: number | undefined;

  constructor() {
    // The OS knows before our 90s watchdog does — see onOffline.
    window.addEventListener('offline', () => this.onOffline());
    // Wake/network-transition triggers. WiFi↔cellular handoffs and phone
    // unlocks fire NEITHER offline nor online — without these, a dead-but-open
    // socket shows frozen prices undimmed until the 90s stale watchdog
    // (which is throttled while hidden on top of that). The watchdog stays as
    // the backstop for transitions no event covers.
    window.addEventListener('online', () => this.onWake(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.onWake();
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) this.onWake(); // bfcache restore: the frozen page's socket is long dead
    });
    // Page Lifecycle: Chrome ≥133 FREEZES a hidden tab under Battery Saver
    // (hidden >5 min, >5% CPU) — every task stops, the socket dies unseen
    // and the tab strip keeps whatever was last written. Close deliberately
    // before the freeze so the cue is honest (pageTitle.ts blanks the price
    // on the same event) and re-dial the instant the page resumes.
    document.addEventListener('freeze', () => this.onFreeze());
    document.addEventListener('resume', () => this.onWake(true));
    // Network Information API (Chromium): the one signal that fires on a
    // radio handoff while the page stays visible. Absent elsewhere (iOS
    // Safari) — there, unlock → visibilitychange covers the common case.
    (navigator as Navigator & { connection?: EventTarget }).connection?.addEventListener(
      'change',
      () => this.onWake(),
    );
  }

  /**
   * The network under us may have changed: verify the socket is really alive
   * instead of trusting readyState. OPEN → probe (ping + short silence
   * deadline); parked in reconnect backoff → dial now (debounced against
   * wake chatter); CONNECTING past its deadline (throttled timers fire
   * late) → kill so onclose retries fresh.
   * Never double-fires the heal path: everything funnels into the existing
   * onclose → reconnect → onopen chain, which is where onReconnect semantics
   * (everOpened, teardown grace) already live.
   *
   * `edge` is the `online` event: not a hint but the mirror of the `offline`
   * that may have parked us with NO ladder (onOffline), so it dials even in
   * a hidden tab (a hidden tab keeps its socket — the ladder never cared
   * about visibility either) and is never debounced: Chromium fires
   * connection.change at the offline moment, which would otherwise swallow
   * every `online` inside the 30s window and leave a short WiFi blip parked
   * for good.
   */
  private onWake(edge = false): void {
    if (!this.hasSubs()) return;
    // Hidden: dials wait for the visible return (or the `online`/`resume`
    // edge), but the OPEN-socket probe is one ping, and a hidden tab is
    // where a dead socket hurts most — the tab title is read there.
    if (!edge && document.visibilityState === 'hidden' && this.ws?.readyState !== WebSocket.OPEN) return;
    const prevWakeAt = this.lastWakeEventAt;
    this.lastWakeEventAt = Date.now();
    if (!this.ws) {
      // Parked in reconnect backoff (or offline, ladder-less). After real
      // wake-silence (unlock, bfcache return) dial NOW on a fresh ladder;
      // wake CHATTER keeps the ladder's pace — see WAKE_DIAL_DEBOUNCE_MS.
      // The reset lives INSIDE the debounce so a storm can't pin the ladder
      // at 1s.
      if (!edge && Date.now() - prevWakeAt < WAKE_DIAL_DEBOUNCE_MS) return;
      this.reconnectDelay = 1_000;
      window.clearTimeout(this.reconnectTimer);
      this.ensureConnected();
    } else if (this.ws.readyState === WebSocket.OPEN) {
      this.probeSocket?.();
    } else if (
      this.ws.readyState === WebSocket.CONNECTING &&
      Date.now() - this.dialStartedAt > CONNECT_TIMEOUT_MS
    ) {
      this.ws.close();
    }
  }

  /**
   * The OS says the network is gone. Close the socket so the status cue is
   * honest — but the close EVENT is the peer's to give, and with the radio
   * gone the browser keeps the socket CLOSING until its own handshake
   * timeout (OFFLINE_ABANDON_MS has the numbers). So: one grace period; a
   * close that completes inside it (a live peer answers within an RTT — the
   * "offline" was spurious, or the socket was still CONNECTING) takes the
   * ordinary onclose ladder. One that hangs is written off here: the socket
   * is detached (its eventual onclose finds `this.ws !== ws` and is ignored;
   * its per-socket timers die with that event), the cue flips, and NOTHING
   * dials — an interface that is not there fails a dial on the spot, and
   * the `online` edge re-enters through onWake(true). If the edge already
   * passed inside the grace, dial now. A socket that was ALREADY down when
   * `offline` fired stays on its ladder: that state has no hung-close
   * evidence, and browsers that report `onLine: false` with a working
   * network do exist — the ladder is what reconnects them, so it is never
   * gated on navigator.onLine.
   */
  private onOffline(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.close();
    window.clearTimeout(this.offlineTimer);
    this.offlineTimer = window.setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.CLOSING) return;
      this.ws = null;
      window.clearTimeout(this.reconnectTimer);
      if (!this.hasSubs()) {
        this.setStatus('live'); // idle wall in its teardown grace: not broken
        return;
      }
      this.setStatus('reconnecting');
      if (navigator.onLine !== false) this.ensureConnected();
    }, OFFLINE_ABANDON_MS);
  }

  /**
   * A socket WE gave up on (probe unanswered, watchdog, freeze): detach it
   * NOW instead of waiting for its close event — with a black-holed peer
   * Chromium keeps a closing socket CLOSING for its own 60 s handshake
   * timeout, and every cue hangs off onclose. Its eventual onclose finds
   * `this.ws !== ws` and is ignored (the per-socket timers die there);
   * quarantine evidence is not inspected — silence is an outage, never a
   * verdict. `redial` follows the ordinary ladder; a freeze dials nothing
   * (nothing runs in a frozen page — the `resume` edge re-enters).
   */
  private writeOff(ws: WebSocket, redial: boolean): void {
    if (this.ws !== ws) return;
    this.ws = null;
    ws.close();
    window.clearTimeout(this.reconnectTimer);
    if (!this.hasSubs()) {
      this.setStatus('live'); // idle wall in its teardown grace: not broken
      return;
    }
    this.setStatus('reconnecting');
    if (!redial) return;
    this.reconnectTimer = window.setTimeout(() => this.ensureConnected(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private onFreeze(): void {
    const ws = this.ws;
    if (ws) this.writeOff(ws, false);
    else window.clearTimeout(this.reconnectTimer); // resume dials on its own
  }

  /** Any consumer at all — candle charts, allMids tables, or a watched address — keeps the socket alive. */
  private hasSubs(): boolean {
    return this.listeners.size > 0 || this.midsListeners.size > 0 || this.userListeners.size > 0;
  }

  /** First subscription ever: arm a cold-block cue so a slow/blocked first
   *  connect doesn't sit there looking falsely 'live'. */
  private armColdBlock(): void {
    if (this.hasSubs() || this.everOpened) return;
    this.firstSubscribeAt = Date.now();
    window.clearTimeout(this.coldBlockTimer);
    this.coldBlockTimer = window.setTimeout(() => {
      if (!this.everOpened && this.hasSubs()) this.setStatus('reconnecting');
    }, 10_000);
  }

  /**
   * `onRejected` fires (at most once, asynchronously) if this id gets
   * quarantined — or straight away if it already is — and the subscription
   * is dead from then on: no candles, no replay. A quarantined id never
   * touches the socket again until clearCandleQuarantine.
   */
  subscribeCandle(
    coin: string,
    interval: string,
    listener: CandleListener,
    onRejected?: RejectListener,
  ): () => void {
    const key = candleKey(coin, interval);
    if (this.quarantined.has(key)) {
      // Async so the caller's effect finishes wiring up before it hears back.
      const timer = window.setTimeout(() => onRejected?.(), 0);
      return () => window.clearTimeout(timer);
    }
    let set = this.listeners.get(key);
    if (!set) {
      this.armColdBlock();
      set = new Set();
      this.listeners.set(key, set);
      const payload: CandleSub = { type: 'candle', coin, interval };
      this.subPayloads.set(key, payload);
      this.sendSubscribe(payload);
    }
    set.add(listener);
    if (onRejected) {
      let rejects = this.rejectListeners.get(key);
      if (!rejects) {
        rejects = new Set();
        this.rejectListeners.set(key, rejects);
      }
      rejects.add(onRejected);
    }
    this.ensureConnected();

    return () => {
      if (onRejected) {
        const rejects = this.rejectListeners.get(key);
        rejects?.delete(onRejected);
        if (rejects?.size === 0) this.rejectListeners.delete(key);
      }
      const listeners = this.listeners.get(key);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(key);
        const payload = this.subPayloads.get(key);
        this.subPayloads.delete(key);
        if (payload) this.send({ method: 'unsubscribe', subscription: payload });
      }
      if (!this.hasSubs()) {
        this.scheduleTeardown();
        this.setStatus('live'); // empty wall isn't broken — don't leave a stuck reconnecting cue
      }
    };
  }

  isCandleQuarantined(coin: string, interval: string): boolean {
    return this.quarantined.has(candleKey(coin, interval));
  }

  /**
   * Re-send a LIVE candle subscription on the wire — unsubscribe then
   * subscribe — regardless of listener count. The per-cell freshness check
   * (ChartCell) found this feed dead while the socket lives; a cell's
   * ordinary effect re-run only decrements and increments the refcount,
   * which sends nothing when the key is shared (a duplicate cell, a formula
   * leg beside a plain cell). The subscribe goes through sendSubscribe, so
   * the ack/quarantine bookkeeping sees it. Unknown or quarantined keys and
   * a socket that is not open: no-op (the next open replays every key).
   */
  resubscribeCandle(coin: string, interval: string): void {
    const key = candleKey(coin, interval);
    if (this.quarantined.has(key)) return;
    const payload = this.subPayloads.get(key);
    if (!payload || !this.listeners.has(key)) return;
    this.send({ method: 'unsubscribe', subscription: payload });
    this.sendSubscribe(payload);
  }

  /** The cell's manual Retry: one more real attempt at the id (a bad one
   *  re-quarantines after two closes; a false positive comes back live). */
  clearCandleQuarantine(coin: string, interval: string): void {
    const key = candleKey(coin, interval);
    this.quarantined.delete(key);
    this.strikes.delete(key);
  }

  /**
   * Live mid prices for the market tables. dex '' = the default feed (native
   * perps + spot @idx + HIP-4 #); each HIP-3 dex has its own feed with keys
   * already dex-prefixed ('xyz:TSLA'). Coin ids are globally unique across
   * feeds, so every message is fanned to every listener — consumers merge by
   * key. Unlike candles these are idempotent snapshots: missing one while a
   * tab is hidden costs nothing, the next push carries the full state.
   */
  subscribeAllMids(dex: string, listener: MidsListener): () => void {
    const key = `mids:${dex}`;
    let set = this.midsListeners.get(key);
    if (!set) {
      this.armColdBlock();
      set = new Set();
      this.midsListeners.set(key, set);
      const payload: AllMidsSub = dex ? { type: 'allMids', dex } : { type: 'allMids' };
      this.midsPayloads.set(key, payload);
      this.sendSubscribe(payload);
    }
    set.add(listener);
    this.ensureConnected();

    return () => {
      const listeners = this.midsListeners.get(key);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.midsListeners.delete(key);
        const payload = this.midsPayloads.get(key);
        this.midsPayloads.delete(key);
        if (payload) this.send({ method: 'unsubscribe', subscription: payload });
      }
      if (!this.hasSubs()) {
        this.scheduleTeardown();
        this.setStatus('live');
      }
    };
  }

  /**
   * Account-state feed for one (channel, address, dex) triple — the watch
   * feature. Pushes the raw message `data` (already snapshot-complete);
   * parsing lives in the consumer. Same lifecycle contract as the other
   * channels: replayed automatically on reconnect, socket torn down (after
   * the 5s grace) when the last subscription of any kind goes.
   */
  subscribeUserState(
    channel: UserChannel,
    user: string,
    dex: string,
    listener: UserStateListener,
  ): () => void {
    const addr = user.toLowerCase();
    const key = `user:${channel}:${dex}:${addr}`;
    let set = this.userListeners.get(key);
    if (!set) {
      this.armColdBlock();
      set = new Set();
      this.userListeners.set(key, set);
      const payload: UserSub = dex ? { type: channel, user: addr, dex } : { type: channel, user: addr };
      this.userPayloads.set(key, payload);
      this.sendSubscribe(payload);
    }
    set.add(listener);
    this.ensureConnected();

    return () => {
      const listeners = this.userListeners.get(key);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.userListeners.delete(key);
        const payload = this.userPayloads.get(key);
        this.userPayloads.delete(key);
        if (payload) this.send({ method: 'unsubscribe', subscription: payload });
      }
      if (!this.hasSubs()) {
        this.scheduleTeardown();
        this.setStatus('live');
      }
    };
  }

  /** Fires on every re-open after the first successful connect. */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  private setStatus(s: WsStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  /** Invokes cb synchronously with the current status, then again on every change. */
  onStatus(cb: (s: WsStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /**
   * Close only if the wall stays empty. React commits run ALL effect cleanups
   * before ALL re-creates, so a refresh of every cell (reconnect heal,
   * StrictMode, HMR) passes through a transient zero-listener state — closing
   * immediately would open a fresh socket whose onopen fires onReconnect,
   * refreshing every cell again: an infinite reconnect/refetch loop.
   */
  private scheduleTeardown(): void {
    window.clearTimeout(this.teardownTimer);
    this.teardownTimer = window.setTimeout(() => {
      if (!this.hasSubs()) this.teardown();
    }, 5_000);
  }

  private teardown(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private ensureConnected(): void {
    if (!this.hasSubs()) return;
    window.clearTimeout(this.teardownTimer);
    if (this.ws && this.ws.readyState !== WebSocket.CLOSING && this.ws.readyState !== WebSocket.CLOSED) {
      return;
    }
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    this.dialStartedAt = Date.now();
    // Per-socket state: a late event from a dying socket must never touch its successor.
    let pingTimer: number | undefined;
    let lastMsgAt = Date.now();
    let stabilized = false;
    let probeTimer: number | undefined;
    // The silence probe (SILENCE_PROBE_MS): re-armed from open and from every
    // message — an event-scheduled timer, nesting depth 0 every time, which
    // is what keeps it out of Chrome's intensive throttling.
    let silenceTimer: number | undefined;
    const armSilence = () => {
      window.clearTimeout(silenceTimer);
      silenceTimer = window.setTimeout(() => {
        silenceTimer = undefined;
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        this.probeSocket?.();
      }, SILENCE_PROBE_MS);
    };
    /** Every subscribe frame this socket carried, in send order (quarantine evidence). */
    const sendLog: SentSub[] = [];
    this.sendLog = sendLog;
    /** A subscription ack arrived on this socket — the server was processing
     *  our frames in order, so an unacked one it closed on is a real verdict. */
    let gotAck = false;

    const connectTimer = window.setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) ws.close();
    }, CONNECT_TIMEOUT_MS);

    // Ping immediately; silence for PROBE_TIMEOUT_MS after that = half-open
    // socket, close it (→ onclose → reconnect). A healthy socket answers with
    // a pong (or any traffic) well inside the window. One probe in flight max.
    this.probeSocket = () => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (probeTimer !== undefined) return;
      const sentAt = Date.now();
      ws.send(JSON.stringify({ method: 'ping' }));
      probeTimer = window.setTimeout(() => {
        probeTimer = undefined;
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (lastMsgAt < sentAt) this.writeOff(ws, true); // unanswered: dead, don't wait for onclose
      }, PROBE_TIMEOUT_MS);
    };

    ws.onopen = () => {
      window.clearTimeout(connectTimer);
      if (this.ws !== ws) return;
      this.setStatus('live');
      window.clearTimeout(this.coldBlockTimer);
      // Candles LAST: allMids and user-state subs are acked whatever their
      // dex/address, so replaying them first puts an ack on the socket before
      // any candle can kill it — the evidence the quarantine needs even when
      // the bad id is the wall's only chart (list view's mids, a watched
      // address). Order otherwise carries no meaning to consumers.
      for (const payload of this.midsPayloads.values()) this.sendSubscribe(payload);
      for (const payload of this.userPayloads.values()) this.sendSubscribe(payload);
      const candles = [...this.subPayloads.entries()];
      for (const [key, payload] of candles) if (!this.replayLast.has(key)) this.sendSubscribe(payload);
      for (const [key, payload] of candles) if (this.replayLast.has(key)) this.sendSubscribe(payload);
      pingTimer = window.setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastMsgAt > STALE_SOCKET_MS) {
          this.writeOff(ws, true); // half-open backstop (the silence probe normally gets here first)
          return;
        }
        ws.send(JSON.stringify({ method: 'ping' }));
      }, PING_INTERVAL_MS);
      // A first open delayed >30s past the first subscription means the wall
      // sat through a cold-start WS block long enough that any bars which
      // closed during it are gone for good (the candle channel never replays
      // closed bars) — that's exactly the reconnect-heal case, so fire
      // onReconnect here too. Normal startups open in <1s, so this branch
      // never fires for them and Invariant 2 (no startup refresh loop) holds.
      const delayedFirstOpen =
        !this.everOpened && this.firstSubscribeAt > 0 && Date.now() - this.firstSubscribeAt > 30_000;
      if (this.everOpened || delayedFirstOpen) {
        for (const fn of this.reconnectListeners) fn();
      }
      this.everOpened = true;
      armSilence(); // HL acks every subscribe, so a healthy socket talks well inside the window
    };

    ws.onmessage = (ev) => {
      lastMsgAt = Date.now();
      armSilence();
      if (!stabilized) {
        // Reset backoff only once the server actually talks to us, not on
        // bare open — otherwise an accept-then-drop server causes a 1s storm.
        stabilized = true;
        if (this.ws === ws) this.reconnectDelay = 1_000;
      }
      if (this.route(ev.data as string, sendLog) === 'subscriptionResponse') gotAck = true;
    };

    ws.onclose = () => {
      window.clearInterval(pingTimer);
      window.clearTimeout(connectTimer);
      window.clearTimeout(probeTimer);
      window.clearTimeout(silenceTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      // Before the reconnect decision: a quarantine may take the last
      // subscription with it, and that socket must not be re-dialed.
      if (gotAck) this.inspectClose(sendLog, Date.now());
      else this.noteSilentClose(sendLog, Date.now());
      if (this.hasSubs()) {
        this.setStatus('reconnecting');
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = window.setTimeout(() => this.ensureConnected(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      } else {
        // Zero listeners: the intentional teardown path (or its tail) — an
        // empty wall is not a broken one, so no dead red dot.
        this.setStatus('live');
      }
    };

    ws.onerror = () => ws.close();
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // Not open yet: onopen replays every entry in subPayloads, so nothing is lost.
  }

  /** A subscribe frame, logged on the current socket so its ack (or the
   *  lack of one at close) can be attributed. Not-open = replayed on open. */
  private sendSubscribe(sub: Subscription): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const log = this.sendLog;
    const now = Date.now();
    if (log.length > 256) {
      // A day of interval flips on one socket is thousands of frames; only
      // the last window's worth can ever be blamed. In place — the socket's
      // handlers hold this same array.
      let stale = 0;
      while (stale < log.length && now - log[stale].at > UNACKED_CLOSE_WINDOW_MS) stale++;
      log.splice(0, stale);
    }
    log.push({ key: subKey(sub), at: now, acked: false });
    this.ws.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
  }

  /**
   * A socket that talked to us closed: was it a bad id? Entries are in send
   * order and HL processes them in order, so the first unacked one sent
   * inside the window is where the server stopped — the culprit; the ones
   * behind it were never looked at. Unacked entries OLDER than the window
   * were ignored rather than fatal (a frame the server neither acked nor
   * error-replied, on a socket that went on living) and must not mask a
   * real culprit behind them. Non-candle culprits are only reported: every
   * bad address / dex probed is acked, so there is nothing to quarantine
   * there yet.
   */
  private inspectClose(log: SentSub[], now: number): void {
    for (const e of log) {
      if (e.acked || now - e.at > UNACKED_CLOSE_WINDOW_MS) continue;
      if (!e.key.startsWith('candle:')) {
        console.warn('[purrwall] WS closed right after an unacked subscribe', e.key);
        return;
      }
      const prev = this.strikes.get(e.key);
      const count = prev && now - prev.at <= STRIKE_TTL_MS ? prev.count + 1 : 1;
      if (count >= QUARANTINE_STRIKES) this.quarantine(e.key);
      else this.strikes.set(e.key, { count, at: now });
      return;
    }
  }

  /**
   * A socket closed without acking anything: an outage, or a bad id that
   * was first in line (HL never got to the rest). Only the FIRST candle
   * subscribe can be the latter, and only if the close came right after
   * it — send it last next time so the others produce the ack that lets
   * inspectClose rule. During an outage this merely permutes the replay.
   */
  private noteSilentClose(log: SentSub[], now: number): void {
    const first = log.find((e) => e.key.startsWith('candle:'));
    if (first && now - first.at <= UNACKED_CLOSE_WINDOW_MS) this.replayLast.add(first.key);
  }

  /** Drop a candle key for good (this session): no replay, no re-send, cells told. */
  private quarantine(key: string): void {
    console.warn(
      '[purrwall] WS quarantined',
      key,
      '— HL closes the socket on this id (unknown coin); not resubscribing',
    );
    this.quarantined.add(key);
    this.strikes.delete(key);
    this.replayLast.delete(key);
    this.subPayloads.delete(key);
    this.listeners.delete(key);
    const rejects = this.rejectListeners.get(key);
    this.rejectListeners.delete(key);
    if (rejects) for (const fn of rejects) fn();
    // The caller (onclose) decides reconnect vs. idle from hasSubs() next;
    // an idle socket is torn down through the ordinary grace path.
    if (!this.hasSubs()) this.scheduleTeardown();
  }

  /** Dispatches one server frame; returns its channel (null if unparseable). */
  private route(raw: string, log: SentSub[]): string | null {
    let msg: { channel?: string; data?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    const channel = msg.channel ?? null;
    if (!msg.data) return channel;
    if (channel === 'subscriptionResponse') {
      const d = msg.data as { method?: string; subscription?: Subscription };
      if (d.method !== 'subscribe' || !d.subscription?.type) return channel;
      const key = subKey(d.subscription);
      const entry = log.find((e) => e.key === key && !e.acked);
      if (entry) entry.acked = true;
      this.strikes.delete(key); // acked = a real id; a past coincidence is forgiven
      this.replayLast.delete(key);
      return channel;
    }
    if (channel === 'error') {
      // "Error parsing JSON into valid websocket request: {…our frame…}" —
      // HL rejected that frame and kept the socket. Mark it processed so a
      // replayed one never sits in front of a real culprit (the culprit is
      // the first UNPROCESSED entry, and this one was looked at).
      const text = String(msg.data);
      const brace = text.indexOf('{');
      if (brace < 0) return channel;
      try {
        const frame = JSON.parse(text.slice(brace)) as { subscription?: Subscription };
        if (frame.subscription?.type) {
          const key = subKey(frame.subscription);
          const entry = log.find((e) => e.key === key && !e.acked);
          if (entry) entry.acked = true;
        }
      } catch {
        /* not one of ours — nothing to attribute */
      }
      return channel;
    }
    if (channel === 'allMids') {
      const mids = (msg.data as { mids?: Record<string, string> }).mids;
      if (!mids) return channel;
      for (const set of this.midsListeners.values()) {
        for (const listener of set) listener(mids);
      }
      return channel;
    }
    if (channel === 'clearinghouseState' || channel === 'openOrders' || channel === 'spotState') {
      // Payload names its own (dex, user) — main dex arrives as dex: ''.
      const d = msg.data as { dex?: string; user?: string };
      const key = `user:${channel}:${d.dex ?? ''}:${(d.user ?? '').toLowerCase()}`;
      const set = this.userListeners.get(key);
      if (set) for (const listener of set) listener(msg.data);
      return channel;
    }
    if (channel !== 'candle') return channel;
    const candle = msg.data as Candle;
    const set = this.listeners.get(candleKey(candle.s, candle.i));
    if (set) for (const listener of set) listener(candle);
    return channel;
  }
}

export const hlSocket = new HLSocket();
