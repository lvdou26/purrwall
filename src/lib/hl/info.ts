import type { Candle } from './types';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const MAX_RETRIES = 2;
/** Per-attempt deadline base: a black-holed request (radio handoff, sleep)
 *  fails into the normal retry/backoff instead of hanging a concurrency slot.
 *  Escalates ×(attempt+1) — 10s/20s/30s — so a slow-but-alive link (a
 *  2000-bar pagination chunk on congested cellular) converges on a later
 *  attempt instead of failing all three identically. */
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Hyperliquid allows 1200 REST weight/min/IP; a 300-bar candleSnapshot costs
 * ~25 weight. Capping concurrency keeps a 16-chart cold start (or a rapid
 * interval-flipping user) from stampeding the budget, and 429s retry with
 * backoff instead of surfacing as dead cells.
 */
const MAX_CONCURRENT_CANDLE_FETCHES = 6;

const backoff = (attempt: number) =>
  new Promise((r) => setTimeout(r, 1_000 * (attempt + 1) + Math.random() * 500));

export async function info<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // Checked at loop top: covers queue-admission (a stale caller aborted
    // while parked behind the concurrency cap) and each retry resume. The
    // caller's signal here is fetchCandles' INTERNAL controller, which only
    // aborts once EVERY consumer has left — so composing it into the fetch
    // below never kills work a dedupe joiner still wants.
    if (signal?.aborted) throw new DOMException('stale request discarded', 'AbortError');
    // Deadline composed BY HAND (AbortController + setTimeout), deliberately
    // not AbortSignal.timeout/any: AbortSignal.any is Safari 17.4+, above the
    // browser floor in vite.config.ts, so on an older Safari the missing
    // global would throw on every call and permanently kill all chart data on
    // a mobile-first app.
    // The controller also governs body streaming below, so a response that
    // stalls after headers still fails inside the same deadline. A DEADLINE
    // failure on the final attempt must surface as a plain Error, never
    // AbortError — callers read AbortError as "stale, discard silently".
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, REQUEST_TIMEOUT_MS * (attempt + 1));
    const onCallerAbort = () => ctl.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timeoutError = () => new Error(`HL info "${String(body.type)}" timed out`);
    try {
      let res: Response;
      try {
        res = await fetch(INFO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
      } catch (err) {
        // Network-level failure or per-attempt timeout — retry like a 5xx.
        if (signal?.aborted) throw new DOMException('stale request discarded', 'AbortError');
        if (attempt >= MAX_RETRIES) throw timedOut ? timeoutError() : err;
        await backoff(attempt);
        continue;
      }
      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch (err) {
          // Body severed or stalled past the deadline — same treatment as a
          // network-level failure.
          if (signal?.aborted) throw new DOMException('stale request discarded', 'AbortError');
          if (attempt >= MAX_RETRIES) throw timedOut ? timeoutError() : err;
          await backoff(attempt);
          continue;
        }
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        throw new Error(`HL info "${String(body.type)}" failed: HTTP ${res.status}`);
      }
      await backoff(attempt);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

let activeFetches = 0;
const waiters: Array<() => void> = [];
type InflightEntry = {
  promise: Promise<Candle[]>;
  /** Register a live consumer; false = this entry is already doomed (every
   *  consumer aborted) and must never be handed out again. */
  join: (signal?: AbortSignal) => boolean;
};
const inflight = new Map<string, InflightEntry>();

export function fetchCandles(
  coin: string,
  interval: string,
  startTime: number,
  endTime: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  // A caller whose signal is ALREADY dead (StrictMode mount-1 after its own
  // teardown) must neither register nor join shared work.
  if (signal?.aborted) {
    return Promise.reject(new DOMException('stale request discarded', 'AbortError'));
  }
  // Identical requests within the same minute share one promise (StrictMode
  // double-mount, reconnect bursts, visibility-return refetches).
  const key = `${coin}|${interval}|${Math.floor(startTime / 60_000)}`;
  const existing = inflight.get(key);
  if (existing?.join(signal)) return existing.promise;

  // Shared work is owned by an INTERNAL controller that aborts only when
  // EVERY consumer's signal has aborted — a live joiner keeps the fetch
  // alive, and a joiner never inherits a dead creator's fate (otherwise a
  // doomed join: the creator flips away, the promise is bound to its
  // aborted signal, and a flip-back consumer with a live signal rejects
  // with AbortError having spent zero budget).
  const internal = new AbortController();
  let liveConsumers = 0;
  const join = (s?: AbortSignal): boolean => {
    if (internal.signal.aborted) return false;
    liveConsumers++;
    // no signal = an owner that never cancels — pins the work live forever
    s?.addEventListener(
      'abort',
      () => {
        liveConsumers--;
        if (liveConsumers <= 0) internal.abort();
      },
      { once: true },
    );
    return true;
  };
  // assigned synchronously below, before any await in the IIFE can resume
  let entry: InflightEntry | undefined;
  const promise = (async () => {
    if (activeFetches >= MAX_CONCURRENT_CANDLE_FETCHES) {
      await new Promise<void>((r) => waiters.push(r));
    }
    activeFetches++;
    try {
      return await info<Candle[]>(
        {
          type: 'candleSnapshot',
          req: { coin, interval, startTime, endTime },
        },
        internal.signal,
      );
    } finally {
      activeFetches--;
      // a doomed entry may have been superseded by a fresh one under the
      // same key — only remove the mapping if it is still ours
      if (inflight.get(key) === entry) inflight.delete(key);
      waiters.shift()?.();
    }
  })();
  entry = { promise, join };
  join(signal);
  inflight.set(key, entry);
  return promise;
}
