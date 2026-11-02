import { describe, expect, it } from 'vitest';
import {
  BRAND,
  composeTitle,
  createTitleController,
  MIN_WRITE_GAP_MS,
  pickSource,
  type TitleController,
} from './pageTitle';

const STATIC = 'Purrwall — every Hyperliquid market, one wall';

describe('composeTitle', () => {
  it('is price | name | Purrwall once a price exists (HL order, price first)', () => {
    expect(composeTitle(null, { name: 'BTC', price: '75,585' }, STATIC)).toBe(
      `75,585 | BTC | ${BRAND}`,
    );
  });
  it('drops the price segment (not the separator pair) before the first tick', () => {
    expect(composeTitle(null, { name: 'PURR/USDC', price: null }, STATIC)).toBe(
      `PURR/USDC | ${BRAND}`,
    );
  });
  it('falls back to the static <title> with no source or a blank name', () => {
    expect(composeTitle(null, null, STATIC)).toBe(STATIC);
    expect(composeTitle(null, { name: '  ', price: '1' }, STATIC)).toBe(STATIC);
  });
  it('lets the alert badge win over everything, verbatim', () => {
    const badge = '(2) 🔔 BTC ↑ 75,000 | Purrwall';
    expect(composeTitle(badge, { name: 'BTC', price: '75,585' }, STATIC)).toBe(badge);
    expect(composeTitle(badge, null, STATIC)).toBe(badge);
  });
  it('keeps long names whole — a HIP-4 question or a formula never truncates', () => {
    const q = 'Will the Fed cut rates at the October 2026 meeting? · Yes';
    expect(composeTitle(null, { name: q, price: '0.62' }, STATIC)).toBe(`0.62 | ${q} | ${BRAND}`);
    expect(composeTitle(null, { name: 'HYPE÷ETH', price: '0.01234' }, STATIC)).toBe(
      `0.01234 | HYPE÷ETH | ${BRAND}`,
    );
  });
});

describe('pickSource', () => {
  const focus = { name: 'ETH', price: '2,390' };
  const wall = { name: 'BTC', price: '75,585' };
  it('prefers the focus slot (expanded cell / list card) over the wall slot', () => {
    expect(pickSource({ focus, wall })).toBe(focus);
  });
  it('falls through a null or absent focus to the wall', () => {
    expect(pickSource({ focus: null, wall })).toBe(wall);
    expect(pickSource({ wall })).toBe(wall);
  });
  it('is null when neither slot has a market', () => {
    expect(pickSource({})).toBeNull();
    expect(pickSource({ focus: null, wall: null })).toBeNull();
  });
});

// ── the writer: injected clock, timers, scheduler and sink ──────────────────

function harness(armed = true) {
  let now = 100_000;
  const writes: string[] = [];
  const micro: Array<() => void> = [];
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 0;
  const ctl: TitleController = createTitleController(
    {
      write: (t) => writes.push(t),
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = ++nextId;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
      schedule: (fn) => micro.push(fn),
      staticTitle: STATIC,
    },
    armed,
  );
  /** end of the current task: run every queued microtask */
  const flush = () => {
    while (micro.length) micro.shift()!();
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { ctl, writes, flush, advance, timers };
}

const BTC = { name: 'BTC', price: '75,585' };
const ETH = { name: 'ETH', price: '2,390' };

describe('title writer', () => {
  it('folds a slot handover (clear then set in one task) into ONE write — never the fallback', () => {
    const h = harness();
    h.ctl.setSource('wall', BTC);
    h.flush();
    expect(h.writes).toEqual([`75,585 | BTC | ${BRAND}`]);
    // expand cell 0: React runs the cleanup (clear wall) before the effect (set focus)
    h.ctl.setSource('wall', null);
    h.ctl.setSource('focus', BTC);
    h.flush();
    expect(h.writes).toHaveLength(1); // same string, nothing written
    // collapse: the round trip never emits the static title
    h.ctl.setSource('focus', null);
    h.ctl.setSource('wall', BTC);
    h.flush();
    expect(h.writes).toHaveLength(1);
    // open a list card on ETH while the wall keeps BTC: one write, the card's title
    h.ctl.setSource('focus', ETH);
    h.flush();
    expect(h.writes.at(-1)).toBe(`2,390 | ETH | ${BRAND}`);
    h.ctl.setSource('focus', null);
    h.flush();
    expect(h.writes.at(-1)).toBe(`75,585 | BTC | ${BRAND}`);
    expect(h.writes).not.toContain(STATIC);
  });

  it('rate-limits PRICE-ONLY changes to one trailing write carrying the latest value', () => {
    const h = harness();
    h.ctl.setSource('wall', BTC);
    h.flush();
    h.advance(200);
    h.ctl.setSource('wall', { name: 'BTC', price: '75,590' });
    h.flush();
    h.advance(200);
    h.ctl.setSource('wall', { name: 'BTC', price: '75,600' });
    h.flush();
    expect(h.writes).toHaveLength(1); // both inside the window
    h.advance(MIN_WRITE_GAP_MS);
    expect(h.writes).toEqual([`75,585 | BTC | ${BRAND}`, `75,600 | BTC | ${BRAND}`]);
    // a tick after a quiet second writes on the leading edge, no timer
    h.advance(MIN_WRITE_GAP_MS + 1);
    h.ctl.setSource('wall', { name: 'BTC', price: '75,700' });
    h.flush();
    expect(h.writes.at(-1)).toBe(`75,700 | BTC | ${BRAND}`);
    expect(h.timers).toHaveLength(0);
  });

  it('writes a structural change (name, static↔live) at once and cancels a pending trailing write', () => {
    const h = harness();
    h.ctl.setSource('wall', BTC);
    h.flush();
    h.advance(100);
    h.ctl.setSource('wall', { name: 'BTC', price: '75,590' });
    h.flush();
    expect(h.timers).toHaveLength(1);
    h.ctl.setSource('wall', { name: 'ETH', price: '2,390' }); // the cell swapped market
    h.flush();
    expect(h.writes.at(-1)).toBe(`2,390 | ETH | ${BRAND}`);
    expect(h.timers).toHaveLength(0);
    // the price segment leaving (stale hide) is structural too
    h.ctl.setSource('wall', { name: 'ETH', price: null });
    h.flush();
    expect(h.writes.at(-1)).toBe(`ETH | ${BRAND}`);
    // and so is losing the last source
    h.ctl.setSource('wall', null);
    h.flush();
    expect(h.writes.at(-1)).toBe(STATIC);
  });

  it('never rewrites an unchanged string', () => {
    const h = harness();
    h.ctl.setSource('wall', BTC);
    h.flush();
    h.advance(5000);
    h.ctl.setSource('wall', { ...BTC });
    h.ctl.setSource('focus', null);
    h.flush();
    expect(h.writes).toHaveLength(1);
  });

  it('badge: synchronous, bypasses the limiter, and clearing it shows the LATEST tick', () => {
    const h = harness();
    h.ctl.setSource('wall', BTC);
    h.flush();
    h.advance(100);
    h.ctl.setBadge('🔔 BTC ↑ 75,000 | Purrwall');
    expect(h.writes.at(-1)).toBe('🔔 BTC ↑ 75,000 | Purrwall'); // no flush, no timer needed
    h.ctl.setSource('wall', { name: 'BTC', price: '75,900' }); // a tick under the badge
    h.flush();
    expect(h.writes.at(-1)).toBe('🔔 BTC ↑ 75,000 | Purrwall');
    h.ctl.setBadge('(2) 🔔 BTC ↑ 75,000 | Purrwall');
    expect(h.writes.at(-1)).toBe('(2) 🔔 BTC ↑ 75,000 | Purrwall');
    h.ctl.setBadge(null);
    expect(h.writes.at(-1)).toBe(`75,900 | BTC | ${BRAND}`); // not the pre-badge stash
    expect(h.timers).toHaveLength(0);
  });

  it('suspend (page freeze) drops every price synchronously; fresh data brings it back', () => {
    const h = harness();
    h.ctl.setSource('wall', BTC);
    h.ctl.setSource('focus', ETH);
    h.flush();
    h.advance(100);
    h.ctl.setSource('focus', { name: 'ETH', price: '2,391' }); // a trailing write is armed
    h.flush();
    expect(h.timers).toHaveLength(1);
    h.ctl.suspend(); // no flush, no timer: the freeze lands right after
    expect(h.writes.at(-1)).toBe(`ETH | ${BRAND}`);
    expect(h.timers).toHaveLength(0);
    // resume: the wall slot lost its number too — nothing stale can surface
    h.ctl.setSource('focus', null);
    h.flush();
    expect(h.writes.at(-1)).toBe(`BTC | ${BRAND}`);
    h.ctl.setSource('wall', { name: 'BTC', price: '75,700' });
    h.flush();
    expect(h.writes.at(-1)).toBe(`75,700 | BTC | ${BRAND}`);
  });

  it('writes nothing until armed; arming flushes the current state; a badge writes regardless', () => {
    const h = harness(false);
    h.ctl.setSource('wall', BTC);
    h.flush();
    expect(h.writes).toEqual([]);
    expect(h.ctl.current()).toBe(STATIC);
    h.ctl.setBadge('🔔 BTC ↑ 75,000 | Purrwall');
    expect(h.writes).toEqual(['🔔 BTC ↑ 75,000 | Purrwall']);
    h.ctl.setBadge(null);
    expect(h.writes.at(-1)).toBe(STATIC); // still unarmed: back to the static title, not the ticker
    h.ctl.arm();
    h.flush();
    expect(h.writes.at(-1)).toBe(`75,585 | BTC | ${BRAND}`);
  });
});

describe('title writer — suspend against the coalescer and the badge', () => {
  it('suspend beats a tick queued in the same task: the coalesced write cannot resurrect the price', () => {
    const h = harness();
    h.ctl.setSource('wall', BTC);
    h.flush();
    h.advance(2_000);
    h.ctl.setSource('wall', { name: 'BTC', price: '75,700' }); // the socket callback ran…
    h.ctl.suspend(); // …and `freeze` landed in the same task, before the microtask
    expect(h.writes.at(-1)).toBe(`BTC | ${BRAND}`);
    h.flush(); // the queued flush finds nothing newer than what suspend wrote
    expect(h.writes.at(-1)).toBe(`BTC | ${BRAND}`);
    expect(h.writes.filter((w) => w.includes('75,700'))).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
  });

  it('suspend under an alert badge keeps the badge; clearing it later shows the name, never the pre-freeze number', () => {
    const h = harness();
    h.ctl.setSource('wall', BTC);
    h.flush();
    h.ctl.setBadge('🔔 BTC ↑ 75,000 | Purrwall');
    const before = h.writes.length;
    h.ctl.suspend();
    expect(h.writes).toHaveLength(before); // the badge is what the strip shows: nothing to rewrite
    h.ctl.setBadge(null); // the user is back and the badge clears
    expect(h.writes.at(-1)).toBe(`BTC | ${BRAND}`); // not `75,585 | BTC`
  });
});
