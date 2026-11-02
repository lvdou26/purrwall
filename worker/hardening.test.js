import { describe, expect, it } from 'vitest';
import { hitRateLimit, originAllowed } from './index.js';

describe('originAllowed', () => {
  it('passes our own pages and absent origins', () => {
    expect(originAllowed(null)).toBe(true); // non-browser client
    expect(originAllowed('')).toBe(true);
    expect(originAllowed('https://purrwall.xyz')).toBe(true);
    expect(originAllowed('https://www.purrwall.xyz')).toBe(true);
    expect(originAllowed('http://localhost:5173')).toBe(true);
    expect(originAllowed('http://127.0.0.1:8787')).toBe(true);
  });

  it('rejects foreign and lookalike origins', () => {
    expect(originAllowed('https://evil.example')).toBe(false);
    expect(originAllowed('https://purrwall.xyz.evil.example')).toBe(false);
    expect(originAllowed('https://notpurrwall.xyz')).toBe(false);
    expect(originAllowed('http://purrwall.xyz')).toBe(false); // http downgrade
    expect(originAllowed('https://localhost:5173')).toBe(false); // only http localhost is dev
    expect(originAllowed('null')).toBe(false); // sandboxed-iframe serialization
  });
});

describe('hitRateLimit', () => {
  // module-level state persists across tests in this file — every test uses
  // its own key so windows never bleed between tests
  let seq = 0;
  const key = () => `test:${seq++}`;

  it('admits up to the limit inside a window, then rejects', () => {
    const k = key();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(hitRateLimit(k, 5, t0 + i)).toBe(false);
    expect(hitRateLimit(k, 5, t0 + 5)).toBe(true);
    expect(hitRateLimit(k, 5, t0 + 6)).toBe(true); // stays rejected in-window
  });

  it('resets the budget when the window rolls over', () => {
    const k = key();
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) hitRateLimit(k, 5, t0);
    expect(hitRateLimit(k, 5, t0 + 60_000)).toBe(false); // fresh window
  });

  it('honors a custom (daily) window: no reset at the minute boundary', () => {
    // the second budget on scarce ops (sync creates: 30/day) — a per-minute
    // window alone would readmit a polite flood every 60s
    const k = key();
    const DAY = 24 * 3600_000;
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) expect(hitRateLimit(k, 30, t0 + i, DAY)).toBe(false);
    expect(hitRateLimit(k, 30, t0 + 3_600_000, DAY)).toBe(true); // an hour later: still spent
    expect(hitRateLimit(k, 30, t0 + DAY, DAY)).toBe(false); // next day: fresh
  });

  it('buckets are independent per key', () => {
    const a = key();
    const b = key();
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) hitRateLimit(a, 5, t0);
    expect(hitRateLimit(a, 5, t0)).toBe(true);
    expect(hitRateLimit(b, 5, t0)).toBe(false);
  });

  it('caps tracked keys so a spoofed-IP flood cannot exhaust isolate memory', () => {
    const t0 = 2_000_000;
    // fill way past the 10k cap with distinct keys; the map must not grow past it
    for (let i = 0; i < 10_200; i++) hitRateLimit(`flood:${seq}:${i}`, 5, t0);
    // the limiter still functions for a fresh key after the flood
    const k = key();
    for (let i = 0; i < 5; i++) expect(hitRateLimit(k, 5, t0)).toBe(false);
    expect(hitRateLimit(k, 5, t0)).toBe(true);
  });
});
