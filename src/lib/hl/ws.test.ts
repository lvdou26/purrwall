import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The unknown-coin quarantine (ws.ts header) driven end to end over a fake
 * WebSocket: the real HLSocket class, real reconnect ladder (fake timers), a
 * scripted "HL" that behaves as the live API does (docs/architecture.md →
 * Ids and unknown ids) — acks subscribes in send order, and on the first
 * candle sub for an id outside the universe closes the socket 1006 without
 * a word, processing nothing behind it.
 *
 * ws.ts wires window/document/navigator listeners in its constructor and
 * instantiates the app singleton at module load, so every global it touches
 * is stubbed BEFORE the dynamic import below (markets.test.ts's vi.mock
 * recipe, one level lower). Timers forward to globalThis at call time so
 * vi.useFakeTimers() catches them.
 */

interface Frame {
  method: string;
  subscription?: { type: string; coin?: string; interval?: string; dex?: string; user?: string };
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeWebSocket[] = [];
  /** A radio that is gone: close() parks the socket in CLOSING and the close
   *  event never comes on its own (Chrome fires it 18–30s later, Safari ~5s —
   *  the test delivers it with drop() when it wants to). */
  static hangClose = false;
  /** A black hole: the peer answers nothing (no pong), the shape of a dead
   *  upstream with the interface still up. Default: pings are answered
   *  within a tick, like a live HL. */
  static mute = false;
  readyState = FakeWebSocket.CONNECTING;
  sent: Frame[] = [];
  /** How many of `sent` the scripted server has looked at. */
  served = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.all.push(this);
  }
  send(raw: string): void {
    const f = JSON.parse(raw) as Frame;
    this.sent.push(f);
    if (f.method === 'ping' && !FakeWebSocket.mute) {
      globalThis.setTimeout(() => {
        if (this.readyState === FakeWebSocket.OPEN) this.push({ channel: 'pong' });
      }, 0);
    }
  }
  pings(): number {
    return this.sent.filter((f) => f.method === 'ping').length;
  }
  /** Client-side close: CLOSING now, the close event a tick later (like a browser). */
  close(): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSING;
    if (FakeWebSocket.hangClose) return;
    globalThis.setTimeout(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code: 1005 });
    }, 0);
  }
  // ---- the server side ----
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  push(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
  subs(): string[] {
    return this.sent
      .filter((f) => f.method === 'subscribe')
      .map((f) => `${f.subscription?.type}:${f.subscription?.coin ?? f.subscription?.user ?? f.subscription?.dex ?? ''}`);
  }
}

/**
 * Plays HL over the frames the client has sent since the last call: acks
 * each subscribe in order; the first candle sub for a coin in `bad` closes
 * the socket unacked and nothing behind it is processed. `ignore` coins get
 * HL's malformed-request `error` frame and are skipped (socket lives on).
 */
function serve(ws: FakeWebSocket, bad: string[] = [], ignore: string[] = []): void {
  while (ws.served < ws.sent.length) {
    const f = ws.sent[ws.served++];
    if (f.method === 'ping') continue; // answered by the socket itself (see FakeWebSocket.send)
    if (f.method !== 'subscribe' || !f.subscription) continue;
    const s = f.subscription;
    if (s.type === 'candle' && bad.includes(s.coin ?? '')) {
      ws.drop();
      return;
    }
    if (s.type === 'candle' && ignore.includes(s.coin ?? '')) {
      ws.push({
        channel: 'error',
        data: `Error parsing JSON into valid websocket request: ${JSON.stringify(f)}`,
      });
      continue;
    }
    ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: s } });
  }
}

const forward =
  <A extends unknown[]>(fn: (...a: A) => unknown) =>
  (...a: A) =>
    fn(...a);
/** The window/document listeners ws.ts registers in its constructor, so a
 *  test can play the OS: `fire(winListeners, 'offline')`. Cleared per test —
 *  every test constructs its own HLSocket and the previous ones must not hear
 *  the events. */
type Listener = (ev: unknown) => void;
const winListeners = new Map<string, Listener[]>();
const docListeners = new Map<string, Listener[]>();
const listen = (map: Map<string, Listener[]>) => (type: string, fn: Listener) => {
  const list = map.get(type) ?? [];
  list.push(fn);
  map.set(type, list);
};
function fire(map: Map<string, Listener[]>, type: string, ev: unknown = {}): void {
  for (const fn of map.get(type) ?? []) fn(ev);
}
vi.stubGlobal('window', {
  addEventListener: listen(winListeners),
  setTimeout: forward((...a: Parameters<typeof setTimeout>) => globalThis.setTimeout(...a)),
  clearTimeout: forward((...a: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...a)),
  setInterval: forward((...a: Parameters<typeof setInterval>) => globalThis.setInterval(...a)),
  clearInterval: forward((...a: Parameters<typeof clearInterval>) => globalThis.clearInterval(...a)),
});
const fakeDocument = { visibilityState: 'visible', hidden: false, addEventListener: listen(docListeners) };
vi.stubGlobal('document', fakeDocument);
/** Chromium's Network Information API, present only when a test installs it. */
const connListeners = new Map<string, Listener[]>();
const fakeNavigator: {
  onLine?: boolean;
  connection?: { addEventListener: (type: string, fn: Listener) => void };
} = { onLine: true };
vi.stubGlobal('navigator', fakeNavigator);
vi.stubGlobal('WebSocket', FakeWebSocket);
const { HLSocket } = await import('./ws');

/** The newest socket the client dialed. */
const latest = () => FakeWebSocket.all[FakeWebSocket.all.length - 1];
/** Runs the clock just until the reconnect ladder dials again (whatever rung
 *  it is on), and opens that socket — never past the 10s connect deadline. */
function dial(): FakeWebSocket {
  const before = FakeWebSocket.all.length;
  for (let i = 0; i < 400 && FakeWebSocket.all.length === before; i++) vi.advanceTimersByTime(50);
  expect(FakeWebSocket.all.length).toBe(before + 1);
  const ws = latest();
  ws.open();
  return ws;
}
const noop = () => {};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
  FakeWebSocket.hangClose = false;
  FakeWebSocket.mute = false;
  winListeners.clear();
  docListeners.clear();
  connListeners.clear();
  delete fakeNavigator.connection;
  fakeNavigator.onLine = true;
  fakeDocument.visibilityState = 'visible';
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

describe('unknown-coin quarantine', () => {

  it('one bad id costs its cell, never the wall: quarantined after two closes, ids behind it untouched', () => {
    const sock = new HLSocket();
    const rejected = { BTC: vi.fn(), NOPE: vi.fn(), SOL: vi.fn() };
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeCandle('BTC', '1m', noop, rejected.BTC);
    sock.subscribeCandle('NOPE', '1m', noop, rejected.NOPE);
    sock.subscribeCandle('SOL', '1m', noop, rejected.SOL);

    const ws1 = latest();
    ws1.open();
    expect(ws1.subs()).toEqual(['candle:BTC', 'candle:NOPE', 'candle:SOL']);
    serve(ws1, ['NOPE']); // BTC acked, NOPE closes the socket, SOL never processed
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);
    expect(rejected.NOPE).not.toHaveBeenCalled(); // strike one — a coincidence is still possible

    const ws2 = dial(); // reconnect ladder, first rung
    expect(ws2).not.toBe(ws1);
    expect(ws2.subs()).toEqual(['candle:BTC', 'candle:NOPE', 'candle:SOL']); // still replayed
    serve(ws2, ['NOPE']);
    expect(rejected.NOPE).toHaveBeenCalledTimes(1); // strike two — verdict
    expect(rejected.BTC).not.toHaveBeenCalled();
    expect(rejected.SOL).not.toHaveBeenCalled(); // behind the culprit, never blamed
    expect(sock.isCandleQuarantined('NOPE', '1m')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quarantined'), 'candle:NOPE:1m', expect.any(String));

    const ws3 = dial();
    expect(ws3.subs()).toEqual(['candle:BTC', 'candle:SOL']); // the bad id is gone for good
    serve(ws3, ['NOPE']);
    expect(ws3.readyState).toBe(FakeWebSocket.OPEN);
    expect(statuses[statuses.length - 1]).toBe('live');

    // Nothing ever re-dials while the wall is healthy.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all.length).toBe(3);
  });

  it('a bad id FIRST in line (cell 0 of the wall) gets its verdict via the deferred replay', () => {
    // Nothing on socket 1 is ever acked (HL dies on the first frame): that is
    // indistinguishable from an outage, so no strike — but the key goes to
    // the back of the next replay, the rest get acked first, and the verdict
    // follows. Cell order is re-asserted by the reconnect heal on every
    // reopen (unsubscribe + subscribe per cell), which must not undo it.
    const sock = new HLSocket();
    const rejected = { NOPE: vi.fn(), BTC: vi.fn() };
    const subs = new Map<string, () => void>();
    const subscribe = (coin: string) =>
      subs.set(coin, sock.subscribeCandle(coin, '1m', noop, rejected[coin as 'NOPE' | 'BTC']));
    subscribe('NOPE');
    subscribe('BTC');
    const healChurn = () => {
      for (const coin of ['NOPE', 'BTC']) subs.get(coin)!();
      for (const coin of ['NOPE', 'BTC']) subscribe(coin);
    };
    sock.onReconnect(healChurn);

    const ws1 = latest();
    ws1.open();
    expect(ws1.subs()).toEqual(['candle:NOPE', 'candle:BTC']);
    serve(ws1, ['NOPE']); // dies on frame one, nothing acked
    expect(rejected.NOPE).not.toHaveBeenCalled();

    const ws2 = dial(); // NOPE deferred: BTC first, then NOPE, then the heal churn's live frames
    expect(ws2.subs().slice(0, 2)).toEqual(['candle:BTC', 'candle:NOPE']);
    serve(ws2, ['NOPE']); // BTC acked → evidence → strike one
    expect(rejected.NOPE).not.toHaveBeenCalled();

    const ws3 = dial();
    expect(ws3.subs().slice(0, 2)).toEqual(['candle:BTC', 'candle:NOPE']); // still deferred
    serve(ws3, ['NOPE']); // strike two → quarantined
    expect(rejected.NOPE).toHaveBeenCalledTimes(1);
    expect(rejected.BTC).not.toHaveBeenCalled();

    const ws4 = dial();
    expect(ws4.subs().filter((k) => k.startsWith('candle:'))).not.toContain('candle:NOPE');
    serve(ws4, ['NOPE']);
    expect(ws4.readyState).toBe(FakeWebSocket.OPEN);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all.length).toBe(4);
  });

  it('a subscribe for a quarantined id never touches the socket and is rejected on the next tick', () => {
    const sock = new HLSocket();
    sock.subscribeCandle('BTC', '1m', noop);
    sock.subscribeCandle('NOPE', '1m', noop);
    for (let cycle = 0; cycle < 2; cycle++) {
      latest().open();
      serve(latest(), ['NOPE']);
      vi.advanceTimersByTime(1_000);
    }
    const ws = latest();
    ws.open();
    serve(ws);
    const sentBefore = ws.sent.length;

    const rejected = vi.fn();
    const unsub = sock.subscribeCandle('NOPE', '1m', noop, rejected);
    expect(ws.sent.length).toBe(sentBefore);
    expect(rejected).not.toHaveBeenCalled(); // async: the caller's effect finishes wiring first
    vi.advanceTimersByTime(0);
    expect(rejected).toHaveBeenCalledTimes(1);
    unsub(); // inert: no unsubscribe frame for a subscription that never existed
    expect(ws.sent.length).toBe(sentBefore);

    // Cleanup before the tick means no callback at all.
    const late = vi.fn();
    sock.subscribeCandle('NOPE', '1m', noop, late)();
    vi.advanceTimersByTime(0);
    expect(late).not.toHaveBeenCalled();
  });

  it('a silent accept-then-drop outage never strikes: no ack, no verdict, the ordinary ladder', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    sock.subscribeCandle('BTC', '1m', noop, rejected);
    sock.subscribeCandle('ETH', '1m', noop, rejected);
    const delays = [1_000, 2_000, 4_000, 8_000];
    for (const d of delays) {
      const ws = latest();
      ws.open();
      ws.drop(); // nothing said, socket gone within the window
      vi.advanceTimersByTime(d);
    }
    expect(rejected).not.toHaveBeenCalled();
    expect(FakeWebSocket.all.length).toBe(delays.length + 1);
    const ws = latest();
    ws.open();
    // the deferred-replay bookkeeping only permutes the order during an outage
    expect([...ws.subs()].sort()).toEqual(['candle:BTC', 'candle:ETH']);
    serve(ws);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('a gateway that acks nothing but closes after a fresh subscribe is an outage, not a verdict', () => {
    // Only a subscription ack is evidence: any other traffic (a pong from the
    // wake probe, say) says nothing about whether subscribes are processed.
    const sock = new HLSocket();
    const rejected = vi.fn();
    sock.subscribeCandle('BTC', '1m', noop, rejected);
    let ws = latest();
    ws.open();
    for (let cycle = 0; cycle < 3; cycle++) {
      ws.push({ channel: 'pong' });
      ws.drop();
      ws = dial();
    }
    expect(rejected).not.toHaveBeenCalled();
    expect(ws.subs()).toEqual(['candle:BTC']);
  });

  it('a strike is forgiven by an ack: two coincidences an ack apart never add up', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    sock.subscribeCandle('BTC', '1m', noop, rejected);
    sock.subscribeCandle('ETH', '1m', noop);
    // 1: ETH acked (evidence), BTC unacked → strike. Simulated by an ack for
    // ETH only, then a drop inside the window.
    const strikeOnce = (ws: FakeWebSocket) => {
      const eth = ws.sent.find((f) => f.subscription?.coin === 'ETH')!.subscription;
      ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: eth } });
      ws.drop();
    };
    let ws = latest();
    ws.open();
    strikeOnce(ws);
    // 2: a clean cycle acks BTC — the strike is gone.
    ws = dial();
    serve(ws);
    vi.advanceTimersByTime(30_000);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN); // still ours: the answered probe wrote nothing off
    ws.drop(); // a genuine drop long after the acks: no unacked entries, nothing to blame
    // 3: one more coincidence is again only strike ONE.
    ws = dial();
    strikeOnce(ws);
    expect(rejected).not.toHaveBeenCalled();
    ws = dial();
    expect(ws.subs()).toContain('candle:BTC');
    // 4: …and a second consecutive one is the verdict.
    strikeOnce(ws);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('a lone strike expires: "consecutive" means within one reconnect ladder', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    sock.subscribeCandle('BTC', '1m', noop, rejected);
    sock.subscribeCandle('ETH', '1m', noop);
    const ackEthThenDrop = (ws: FakeWebSocket) => {
      const eth = ws.sent.find((f) => f.subscription?.coin === 'ETH')!.subscription;
      ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: eth } });
      ws.drop();
    };
    let ws = latest();
    ws.open();
    ackEthThenDrop(ws); // strike one at t=0
    ws = dial(); // the replay goes unanswered for a long time — ignored frames, not fatal ones
    vi.advanceTimersByTime(70_000);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN); // pongs answered: no write-off preceded this drop
    ws.drop(); // BTC's entry is far older than the window: not blamed
    ws = dial();
    ackEthThenDrop(ws); // a fresh coincidence >60s after the first: strike ONE again, not two
    expect(rejected).not.toHaveBeenCalled();
    ws = dial();
    expect(ws.subs()).toEqual(['candle:BTC', 'candle:ETH']);
  });

  it('a frame HL error-replies to is processed, so on replay it cannot shield the culprit behind it', () => {
    const sock = new HLSocket();
    const rejected = { BAD7: vi.fn(), NOPE: vi.fn() };
    sock.subscribeCandle('BAD7', '7m', noop, rejected.BAD7); // HL: error frame, socket lives
    sock.subscribeCandle('ETH', '1m', noop);
    sock.subscribeCandle('NOPE', '1m', noop, rejected.NOPE);
    let ws = latest();
    ws.open();
    serve(ws, ['NOPE'], ['BAD7']);
    ws = dial();
    serve(ws, ['NOPE'], ['BAD7']);
    expect(rejected.NOPE).toHaveBeenCalledTimes(1);
    expect(rejected.BAD7).not.toHaveBeenCalled();
    ws = dial();
    expect(ws.subs()).toEqual(['candle:BAD7', 'candle:ETH']);
  });

  it('a non-candle culprit is reported, not quarantined, and no candle behind it is blamed', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    sock.subscribeAllMids('', noop);
    const ws1 = latest();
    ws1.open();
    serve(ws1); // mids acked: evidence on this socket
    // Live sends go out in call order: a user sub, then a candle behind it.
    sock.subscribeUserState('openOrders', '0xABC', '', noop);
    sock.subscribeCandle('BTC', '1m', noop, rejected);
    ws1.drop(); // neither acked, socket gone inside the window
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unacked subscribe'), 'user:openOrders::0xabc');
    expect(rejected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    const ws2 = latest();
    ws2.open();
    // replay: always-valid channels first, candles last
    expect(ws2.subs()).toEqual(['allMids:', 'openOrders:0xabc', 'candle:BTC']);
    serve(ws2);
    expect(ws2.readyState).toBe(FakeWebSocket.OPEN);
    expect(sock.isCandleQuarantined('BTC', '1m')).toBe(false);
  });

  it('acks are matched on the key the subscribe paths build, echo quirks included', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    sock.subscribeAllMids('', noop);
    sock.subscribeAllMids('xyz', noop);
    sock.subscribeUserState('clearinghouseState', '0xAbC', '', noop);
    sock.subscribeCandle('NOPE', '1m', noop, rejected);
    for (let cycle = 0; cycle < 2; cycle++) {
      const ws = latest();
      ws.open();
      // HL's echoes: allMids main dex omits `dex`, user-state spells it '' and lowercases the address
      ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'allMids' } } });
      ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'allMids', dex: 'xyz' } } });
      ws.push({
        channel: 'subscriptionResponse',
        data: { method: 'subscribe', subscription: { type: 'clearinghouseState', dex: '', user: '0xabc' } },
      });
      ws.drop();
      vi.advanceTimersByTime(1_000);
    }
    // Every non-candle entry was recognised as acked, so NOPE was the first unacked one.
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('quarantining the last subscription parks the socket instead of re-dialing', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeAllMids('', noop); // the list view: the only thing HL ever acks here
    const unsubMids = sock.subscribeCandle('NOPE', '1m', noop, rejected);
    void unsubMids;
    for (let cycle = 0; cycle < 2; cycle++) {
      const ws = latest();
      ws.open();
      // mids acked, then the candle closes the socket
      serve(ws, ['NOPE']);
      vi.advanceTimersByTime(1_000);
    }
    expect(rejected).toHaveBeenCalledTimes(1);
    const dials = FakeWebSocket.all.length;
    // mids still alive → the socket comes back without NOPE
    const ws = latest();
    ws.open();
    expect(ws.subs()).toEqual(['allMids:']);
    serve(ws);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.all.length).toBe(dials);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all.length).toBe(dials);
    expect(statuses[statuses.length - 1]).toBe('live');
  });

  it('the manual clear grants one more real attempt, and a bad id re-quarantines', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    sock.subscribeCandle('BTC', '1m', noop);
    sock.subscribeCandle('NOPE', '1m', noop, rejected);
    for (let cycle = 0; cycle < 2; cycle++) {
      latest().open();
      serve(latest(), ['NOPE']);
      vi.advanceTimersByTime(1_000);
    }
    expect(rejected).toHaveBeenCalledTimes(1);
    let ws = latest();
    ws.open();
    serve(ws);

    sock.clearCandleQuarantine('NOPE', '1m');
    expect(sock.isCandleQuarantined('NOPE', '1m')).toBe(false);
    const again = vi.fn();
    sock.subscribeCandle('NOPE', '1m', noop, again);
    expect(ws.subs()).toEqual(['candle:BTC', 'candle:NOPE']); // sent live on the open socket
    serve(ws, ['NOPE']); // strike one (a fresh count — the clear forgave the past)
    expect(again).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    ws = latest();
    ws.open();
    serve(ws, ['NOPE']); // strike two
    expect(again).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    ws = latest();
    ws.open();
    expect(ws.subs()).toEqual(['candle:BTC']);
  });

  it('the per-socket subscribe log stays bounded on a long-lived socket', () => {
    const sock = new HLSocket();
    sock.subscribeAllMids('', noop);
    const ws = latest();
    ws.open();
    serve(ws);
    for (let i = 0; i < 600; i++) {
      const unsub = sock.subscribeCandle(`C${i}`, '1m', noop);
      serve(ws);
      unsub();
      vi.advanceTimersByTime(100);
    }
    const log = (sock as unknown as { sendLog: unknown[] }).sendLog;
    expect(log.length).toBeLessThan(300);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('a genuine drop long after every ack blames nothing and heals like any reconnect', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    const reconnects = vi.fn();
    sock.onReconnect(reconnects);
    sock.subscribeCandle('BTC', '1m', noop, rejected);
    sock.subscribeCandle('ETH', '1m', noop, rejected);
    const ws1 = latest();
    ws1.open();
    serve(ws1);
    vi.advanceTimersByTime(45_000);
    expect(FakeWebSocket.all.length).toBe(1); // the reconnect below is the drop's, not a write-off's
    ws1.drop();
    vi.advanceTimersByTime(1_000);
    const ws2 = latest();
    ws2.open();
    expect(ws2.subs()).toEqual(['candle:BTC', 'candle:ETH']);
    expect(reconnects).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
  });
});

/*
 * The offline park (ws.ts onOffline). On a real WiFi drop `offline` fires
 * within ~0.3s (Safari ~2s), our close() puts the socket in CLOSING, and the
 * close EVENT — the only thing every status cue hangs off — arrives 18–30s
 * later in Chrome, ~5s in Safari (never, under CDP offline emulation).
 * Without the park, every cell would show frozen prices in live colours
 * until then. The park writes a hung close off after 1s.
 */
describe('offline park', () => {
  /** A wall of two, opened and acked, quietly live for a while. */
  function liveWall(sock: InstanceType<typeof HLSocket>): FakeWebSocket {
    sock.subscribeCandle('BTC', '1m', noop);
    sock.subscribeCandle('ETH', '1m', noop);
    const ws = latest();
    ws.open();
    serve(ws);
    vi.advanceTimersByTime(45_000);
    return ws;
  }
  /** The radio goes: the OS event, and a close handshake nobody answers. */
  function radioOff(): void {
    FakeWebSocket.hangClose = true;
    fakeNavigator.onLine = false;
    fire(winListeners, 'offline');
  }
  function radioOn(): void {
    FakeWebSocket.hangClose = false;
    fakeNavigator.onLine = true;
    fire(winListeners, 'online');
  }

  it('a close that hangs after offline is written off in 1s: cue flips, nothing dials, online dials at once', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    const reconnects = vi.fn();
    sock.onReconnect(reconnects);
    const ws1 = liveWall(sock);

    radioOff();
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSING);
    expect(statuses[statuses.length - 1]).toBe('live'); // the grace: a peer that answers takes the ordinary path
    vi.advanceTimersByTime(999);
    expect(statuses[statuses.length - 1]).toBe('live');
    vi.advanceTimersByTime(1);
    expect(statuses[statuses.length - 1]).toBe('reconnecting');

    // Parked: no ladder spins against an interface that is not there.
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.all.length).toBe(1);
    expect(statuses[statuses.length - 1]).toBe('reconnecting');

    // The abandoned socket's real close (Chrome: 18–30s later) is old news:
    // no strike, no ladder, no second cue.
    ws1.drop();
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.all.length).toBe(1);
    expect(statuses.filter((s) => s === 'reconnecting')).toHaveLength(1);

    radioOn();
    expect(FakeWebSocket.all.length).toBe(2); // synchronously, no rung to wait out
    const ws2 = latest();
    ws2.open();
    serve(ws2);
    expect(statuses[statuses.length - 1]).toBe('live');
    expect(reconnects).toHaveBeenCalledTimes(1); // the reopen heals every cell, as any reconnect does
    expect(ws2.subs()).toEqual(['candle:BTC', 'candle:ETH']);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all.length).toBe(2); // and the ladder has nothing left to do
  });

  it('online is never debounced or visibility-gated: chatter at the offline moment must not strand a short blip', () => {
    // Chromium fires connection.change right before `offline` (two of
    // them); the wake debounce would swallow an `online` inside 30s, and
    // a parked socket has no ladder to fall back on. The tab is hidden when
    // the network returns, as a backgrounded wall usually is.
    const sock = new HLSocket();
    liveWall(sock);
    fire(docListeners, 'visibilitychange'); // any wake event: sets the debounce clock
    radioOff();
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(9_000); // a 10s blip, well inside WAKE_DIAL_DEBOUNCE_MS
    fakeDocument.visibilityState = 'hidden';
    radioOn();
    expect(FakeWebSocket.all.length).toBe(2);
    expect(latest().readyState).toBe(FakeWebSocket.CONNECTING);
  });

  it('an online edge inside the grace dials the moment the hung socket is written off', () => {
    const sock = new HLSocket();
    const ws1 = liveWall(sock);
    radioOff();
    vi.advanceTimersByTime(500);
    radioOn(); // the socket is still ours and CLOSING: nothing to do yet
    expect(FakeWebSocket.all.length).toBe(1);
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSING);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.all.length).toBe(2); // written off → the edge already passed → dial now
  });

  it('a close that completes inside the grace takes the ordinary ladder, and the grace timer never touches the successor', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    liveWall(sock);
    fakeNavigator.onLine = false;
    fire(winListeners, 'offline'); // hangClose is off: the close event lands on the next tick
    vi.advanceTimersByTime(0);
    expect(statuses[statuses.length - 1]).toBe('reconnecting');
    vi.advanceTimersByTime(1_000); // ladder rung one — the ladder is deliberately not gated on navigator.onLine
    expect(FakeWebSocket.all.length).toBe(2);
    const ws2 = latest();
    vi.advanceTimersByTime(5_000); // the grace timer fires into a different socket: no-op
    expect(ws2.readyState).toBe(FakeWebSocket.CONNECTING);
    expect(FakeWebSocket.all.length).toBe(2);
    ws2.open();
    serve(ws2);
    expect(statuses[statuses.length - 1]).toBe('live');
  });

  it('an idle wall in its teardown grace is not broken: the park leaves the cue live', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    const unsub = sock.subscribeCandle('BTC', '1m', noop);
    const ws = latest();
    ws.open();
    serve(ws);
    unsub(); // zero listeners → 5s teardown grace, socket still up
    radioOff();
    vi.advanceTimersByTime(1_000);
    expect(statuses[statuses.length - 1]).toBe('live');
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.all.length).toBe(1);
    radioOn();
    expect(FakeWebSocket.all.length).toBe(1); // nothing to serve, nothing dialed
  });
});

/*
 * Never silently stale: a socket that stops talking is probed after
 * SILENCE_PROBE_MS and written off PROBE_TIMEOUT_MS later — status flips
 * and the ladder dials without waiting for the peer's close
 * (Chromium holds a black-holed close for its own 60 s handshake timeout);
 * the page-freeze pair closes deliberately and re-dials on resume; a hidden
 * tab still probes an OPEN socket on a wake event.
 */
describe('silence probe and page freeze', () => {
  it('a socket that goes silent is probed at 25 s and written off 5 s later; the ladder dials', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeCandle('BTC', '1m', noop);
    const ws1 = latest();
    ws1.open();
    serve(ws1); // the ack is the last thing the server ever says
    FakeWebSocket.mute = true;
    vi.advanceTimersByTime(24_900);
    expect(ws1.pings()).toBe(0);
    vi.advanceTimersByTime(200);
    expect(ws1.pings()).toBe(1); // the probe
    expect(statuses.at(-1)).toBe('live');
    vi.advanceTimersByTime(5_000);
    expect(statuses.at(-1)).toBe('reconnecting'); // ~30 s after the last frame, not 90 + 60
    expect(FakeWebSocket.all.length).toBe(1);
    const ws2 = dial(); // the ordinary ladder, first rung
    expect(ws2).not.toBe(ws1);
    expect(ws2.subs()).toEqual(['candle:BTC']);
  });

  it('a pong inside the deadline keeps a quiet socket live for as long as it answers', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeCandle('PURR/USDC', '1h', noop); // a market that never trades
    const ws = latest();
    ws.open();
    serve(ws);
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeWebSocket.all.length).toBe(1);
    expect(statuses).toEqual(['live']);
    // a ping went out well inside HL's 60 s server-silence rule, every time
    expect(ws.pings()).toBeGreaterThanOrEqual(20);
  });

  it('a black-holed close never delays the cue: written off while still CLOSING, and re-dialed', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeCandle('BTC', '1m', noop);
    const ws1 = latest();
    ws1.open();
    serve(ws1);
    FakeWebSocket.mute = true;
    FakeWebSocket.hangClose = true;
    vi.advanceTimersByTime(30_100);
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSING); // the peer never answers the close
    const ws2 = dial();
    expect(ws2).not.toBe(ws1);
    // the zombie's eventual close event touches nothing
    ws1.drop();
    expect(statuses.at(-1)).toBe('live'); // ws2 opened → live
    expect(FakeWebSocket.all.length).toBe(2);
  });

  it('a hidden tab still probes an OPEN socket on a wake event; an unanswered probe there rides the ladder', () => {
    fakeNavigator.connection = { addEventListener: listen(connListeners) };
    const sock = new HLSocket();
    sock.subscribeCandle('BTC', '1m', noop);
    const ws = latest();
    ws.open();
    serve(ws);
    fakeDocument.visibilityState = 'hidden';
    fire(connListeners, 'change');
    expect(ws.pings()).toBe(1); // the probe went out despite the hidden tab
    vi.advanceTimersByTime(100); // the pong lands
    // the socket then dies under the hidden tab: silence probe → write-off →
    // the ladder dials on its own (it never cared about visibility). The
    // hidden gate on a PARKED socket is pinned in the describe below.
    FakeWebSocket.mute = true;
    vi.advanceTimersByTime(60_000);
    const dials = FakeWebSocket.all.length;
    expect(dials).toBeGreaterThanOrEqual(2);
  });

  it('freeze closes the socket and flips the cue without dialing; resume dials at once', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeCandle('BTC', '1m', noop);
    const ws1 = latest();
    ws1.open();
    serve(ws1);
    fire(docListeners, 'freeze');
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(ws1.readyState).toBeGreaterThanOrEqual(FakeWebSocket.CLOSING);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all.length).toBe(1); // nothing dials in a frozen page
    fire(docListeners, 'resume');
    expect(FakeWebSocket.all.length).toBe(2); // the edge dials synchronously
    const ws2 = latest();
    ws2.open();
    serve(ws2);
    expect(ws2.subs()).toEqual(['candle:BTC']);
    expect(statuses.at(-1)).toBe('live');
  });
});

/*
 * The silence probe in detail. The harness answers pings by default, and
 * every long-idle test above depends on it to model a LIVE wall — with a
 * silent server the probe writes those sockets off at 30 s (they fail with
 * `mute` defaulted on). The cases here pin the probe's own period against
 * the 30 s interval, what counts as life, the ladder after a write-off, a
 * write-off inside the teardown grace, the hidden gate on a PARKED socket,
 * and freeze/resume in a hidden tab.
 */
describe('silence probe — period, ladder, grace, hidden gate', () => {
  /** Wraps one socket so every ping records how long the server had been
   *  silent when it left — the quantity HL's 60 s rule is about. */
  function silenceMeter(ws: FakeWebSocket): number[] {
    const silences: number[] = [];
    let lastServerAt = Date.now();
    const push = ws.push.bind(ws);
    ws.push = (msg) => {
      lastServerAt = Date.now();
      push(msg);
    };
    const send = ws.send.bind(ws);
    ws.send = (raw) => {
      if ((JSON.parse(raw) as Frame).method === 'ping') silences.push(Date.now() - lastServerAt);
      send(raw);
    };
    return silences;
  }

  it('the probe, not the 30 s interval, is the keep-alive: no ping ever leaves with more than SILENCE_PROBE_MS of server silence behind it', () => {
    const sock = new HLSocket();
    sock.subscribeCandle('PURR/USDC', '1h', noop); // a market that never trades
    const ws = latest();
    const silences = silenceMeter(ws);
    ws.open();
    serve(ws);
    vi.advanceTimersByTime(10 * 60_000);
    // Exactly 25 s of silence after the last frame → a probe, every time;
    // the interval's own 30 s cadence lands in between: 40 pings in 10 min.
    // The interval alone would leave 30 s of silence and 20 pings — the
    // shape a removed or lengthened probe collapses to.
    expect(Math.max(...silences)).toBe(25_000);
    expect(silences).toHaveLength(40);
    expect(FakeWebSocket.all.length).toBe(1);
  });

  it('any server frame is life: a busy feed with every pong swallowed is never probed, never written off', () => {
    FakeWebSocket.mute = true; // pongs lost — a broken ping path, not a dead socket
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeCandle('BTC', '1m', noop);
    const ws = latest();
    ws.open();
    serve(ws);
    for (let s = 0; s < 30; s++) {
      vi.advanceTimersByTime(5_000);
      if (s === 12) fire(docListeners, 'visibilitychange'); // a wake probe on top, unanswered too
      vi.advanceTimersByTime(2_000);
      ws.push({ channel: 'candle', data: { s: 'BTC', i: '1m', t: s * 60_000, c: '1' } });
      vi.advanceTimersByTime(3_000);
    }
    // 10 interval pings in 300 s + the wake probe; the silence probe never
    // fired because candles kept re-arming it, and the probe deadline saw
    // a candle, not a pong, as the answer.
    expect(ws.pings()).toBe(11);
    expect(FakeWebSocket.all.length).toBe(1);
    expect(statuses).toEqual(['live']);
  });

  it('an accept-then-silent server: written off 30 s after every open, dial gaps walk the ladder 1→2→4→8→15 s, nothing is blamed', () => {
    FakeWebSocket.mute = true;
    const sock = new HLSocket();
    const rejected = vi.fn();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeCandle('BTC', '1m', noop, rejected);
    sock.subscribeCandle('ETH', '1m', noop, rejected);
    const t0 = Date.now();
    latest().open(); // accepted, and never a frame after it
    const dials: number[] = [];
    let seen = FakeWebSocket.all.length;
    for (let t = 0; t < 200_000; t += 100) {
      vi.advanceTimersByTime(100);
      if (FakeWebSocket.all.length > seen) {
        seen++;
        dials.push(Date.now() - t0);
        latest().open();
      }
    }
    // open + 25 s probe + 5 s deadline = write-off at 30 s; then the rung
    expect(dials).toEqual([31_000, 63_000, 97_000, 135_000, 180_000]);
    expect(statuses.filter((s) => s === 'reconnecting')).toHaveLength(5); // one cue per write-off
    expect(rejected).not.toHaveBeenCalled();
    expect(sock.isCandleQuarantined('BTC', '1m')).toBe(false);
    expect(warn).not.toHaveBeenCalled(); // no strike, no "unacked subscribe" either
    // the server finally talks: the ladder resets, the next write-off dials in 1 s
    FakeWebSocket.mute = false;
    serve(latest()); // acks at 200 s
    FakeWebSocket.mute = true;
    for (let t = 0; t < 40_000 && FakeWebSocket.all.length === seen; t += 100) vi.advanceTimersByTime(100);
    expect(Date.now() - t0).toBe(231_000); // ack 200 → probe 225 → write-off 230 → rung one
  });

  it('a subscribe sent a second before a write-off is never a strike: silence is an outage, not a verdict', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    sock.subscribeCandle('BTC', '1m', noop);
    let ws = latest();
    ws.open();
    serve(ws); // BTC acked — this socket carries the evidence a verdict needs
    let unsubEth = () => {};
    for (let cycle = 0; cycle < 2; cycle++) {
      FakeWebSocket.mute = true; // the peer goes dark right after the ack
      vi.advanceTimersByTime(29_000); // the probe went out at 25 s, unanswered
      unsubEth();
      unsubEth = sock.subscribeCandle('ETH', '1m', noop, rejected); // unacked, inside the 2 s window
      vi.advanceTimersByTime(1_000); // write-off — an inspected close would make ETH the culprit
      ws = dial();
      FakeWebSocket.mute = false;
      ws.push({
        channel: 'subscriptionResponse',
        data: { method: 'subscribe', subscription: { type: 'candle', coin: 'BTC', interval: '1m' } },
      });
    }
    expect(rejected).not.toHaveBeenCalled(); // two would-be strikes, no quarantine
    expect(sock.isCandleQuarantined('ETH', '1m')).toBe(false);
    expect(ws.subs()).toEqual(['candle:BTC', 'candle:ETH']);
  });

  it('a probe that expires inside the teardown grace is written off quietly (cue live, no dial); a subscriber inside the grace gets a fresh socket at once', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    const reconnects = vi.fn();
    sock.onReconnect(reconnects);
    const unsub = sock.subscribeCandle('BTC', '1m', noop);
    const ws1 = latest();
    ws1.open();
    serve(ws1);
    FakeWebSocket.mute = true;
    vi.advanceTimersByTime(25_000);
    expect(ws1.pings()).toBe(1); // the probe is out, unanswered
    vi.advanceTimersByTime(1_000);
    unsub(); // last consumer gone at 26 s: 5 s teardown grace, socket still up
    vi.advanceTimersByTime(4_000); // 30 s: the probe deadline lands inside the grace
    expect(ws1.readyState).toBeGreaterThanOrEqual(FakeWebSocket.CLOSING); // written off…
    expect(statuses).toEqual(['live']); // …without a cue: an idle wall is not broken
    expect(FakeWebSocket.all.length).toBe(1); // and nothing to dial for
    // React's transient zero (Invariant 2): a subscriber returns inside the grace
    FakeWebSocket.mute = false;
    sock.subscribeCandle('BTC', '1m', noop);
    expect(FakeWebSocket.all.length).toBe(2); // synchronously — no ladder rung to wait out
    const ws2 = latest();
    ws2.open();
    serve(ws2);
    expect(reconnects).toHaveBeenCalledTimes(1); // a re-open heals, as any reconnect does
    expect(ws2.subs()).toEqual(['candle:BTC']);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all.length).toBe(2); // no stray teardown, no stray rung
    expect(statuses).toEqual(['live']);
  });

  it('freeze while parked in backoff cancels the rung; resume in the still-hidden tab dials at once', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeCandle('BTC', '1m', noop);
    const ws1 = latest();
    ws1.open();
    serve(ws1);
    fakeDocument.visibilityState = 'hidden'; // a page only ever freezes hidden
    vi.advanceTimersByTime(10_000);
    ws1.drop(); // HL restarts: onclose, rung one (1 s) armed
    expect(statuses.at(-1)).toBe('reconnecting');
    fire(docListeners, 'freeze'); // …and the tab freezes before it fires
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.all.length).toBe(1); // a frozen page dials nothing
    fire(docListeners, 'resume');
    expect(FakeWebSocket.all.length).toBe(2); // the edge dials synchronously, hidden or not
    const ws2 = latest();
    ws2.open();
    serve(ws2);
    expect(ws2.subs()).toEqual(['candle:BTC']);
    expect(statuses.at(-1)).toBe('live');
  });

  it('parked in backoff: a non-edge wake in a hidden tab dials nothing (the ladder keeps its pace); the same wake visible dials now', () => {
    fakeNavigator.connection = { addEventListener: listen(connListeners) };
    const sock = new HLSocket();
    sock.subscribeCandle('BTC', '1m', noop);
    const ws1 = latest();
    ws1.open();
    serve(ws1);
    vi.advanceTimersByTime(45_000);
    ws1.drop(); // a genuine drop: rung one (1 s) armed
    fakeDocument.visibilityState = 'hidden';
    fire(connListeners, 'change'); // the first wake event ever — nothing to debounce against
    expect(FakeWebSocket.all.length).toBe(1); // the hidden gate held it, not the debounce
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.all.length).toBe(2); // the ladder dialed on its own schedule
    const ws2 = latest();
    ws2.open();
    serve(ws2);
    vi.advanceTimersByTime(45_000);
    ws2.drop(); // parked again, rung one
    fakeDocument.visibilityState = 'visible';
    fire(docListeners, 'visibilitychange');
    expect(FakeWebSocket.all.length).toBe(3); // visible: the wake dials synchronously
  });

  it('resume on a live socket is one probe, never a re-dial; resume while parked is an edge — never debounced', () => {
    const sock = new HLSocket();
    const statuses: string[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.subscribeCandle('BTC', '1m', noop);
    const ws1 = latest();
    ws1.open();
    serve(ws1);
    vi.advanceTimersByTime(5_000);
    fire(docListeners, 'resume'); // no freeze preceded it — a lifecycle quirk, not our state
    expect(ws1.pings()).toBe(1);
    vi.advanceTimersByTime(10_000); // the pong landed; the socket lives on
    expect(FakeWebSocket.all.length).toBe(1);
    expect(statuses).toEqual(['live']);
    ws1.drop(); // parked, rung one, 10 s after the last wake event: inside the 30 s debounce
    fire(docListeners, 'resume');
    expect(FakeWebSocket.all.length).toBe(2); // an edge dials regardless
  });
});

describe('resubscribeCandle (per-cell freshness found a dead feed)', () => {
  it('re-sends unsubscribe + subscribe on the wire even when the key is shared, and the ack bookkeeping sees it', () => {
    const sock = new HLSocket();
    sock.subscribeCandle('BTC', '1m', noop);
    sock.subscribeCandle('BTC', '1m', noop); // a duplicate cell shares the key
    const ws = latest();
    ws.open();
    serve(ws);
    const before = ws.sent.length;
    sock.resubscribeCandle('BTC', '1m');
    const frames = ws.sent.slice(before).map((f) => `${f.method}:${f.subscription?.coin}`);
    expect(frames).toEqual(['unsubscribe:BTC', 'subscribe:BTC']);
    serve(ws); // the fresh subscribe is acked like any other
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(sock.isCandleQuarantined('BTC', '1m')).toBe(false);
  });

  it('is a no-op for an unknown key, a quarantined id, and a socket that is not open', () => {
    const sock = new HLSocket();
    const rejected = vi.fn();
    sock.subscribeCandle('BTC', '1m', noop); // acked first — the evidence a verdict needs
    sock.subscribeCandle('NOPE', '1m', noop, rejected);
    for (let cycle = 0; cycle < 2; cycle++) {
      latest().open();
      serve(latest(), ['NOPE']);
      vi.advanceTimersByTime(1_000);
    }
    expect(rejected).toHaveBeenCalledTimes(1);
    sock.subscribeCandle('ETH', '1m', noop);
    const ws = latest(); // dialed by the ladder, not opened yet
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);
    const before = FakeWebSocket.all.length;
    sock.resubscribeCandle('NOPE', '1m'); // quarantined
    sock.resubscribeCandle('SOL', '1m'); // never subscribed
    sock.resubscribeCandle('ETH', '1m'); // not open yet: the open replays it anyway
    expect(ws.sent).toHaveLength(0);
    expect(FakeWebSocket.all.length).toBe(before);
    ws.open();
    expect(ws.subs()).toEqual(['candle:BTC', 'candle:ETH']); // the replay, NOPE gone
  });
});
