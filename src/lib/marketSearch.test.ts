import { describe, expect, it, vi } from 'vitest';
import { matchesQuery, searchRows, type SearchInput } from './marketSearch';
import { passesStrict } from './hl/markets';
import type { Market } from './hl/types';
import spotSelector from './hl/spotSelector.json';

vi.mock('./hl/info', () => ({ info: vi.fn() }));

// Invented tickers; only the Strict ids are real (the synced allowlist is
// what passesStrict reads).
const LISTED = (spotSelector.strict as Array<[string, string | null]>)[0][0];
const UNLISTED = `0x${'e'.repeat(32)}`;
const spot = (coin: string, display: string, listed: boolean): Market => ({
  coin,
  display,
  kind: 'spot',
  spotTokenId: listed ? LISTED : UNLISTED,
});

const AAA_PERP: Market = { coin: 'AAA', display: 'AAA-USDC', kind: 'perp' };
const AAA_SPOT = spot('@1', 'AAA/USDC', true);
const SYNX_USDC = spot('@720', 'SYNX/USDC', false);
const SYNX_USDT = spot('@721', 'SYNX/USDT', false);
const PUMPY = spot('@2', 'PUMPY/USDC', true);
const PUMPY26 = spot('@3', 'PUMPY-26/USDC', false);
const OUTCOME: Market = { coin: '#10', display: 'SYNX above 1? · Yes', kind: 'hip4' };
const CATALOG = [AAA_PERP, AAA_SPOT, SYNX_USDC, SYNX_USDT, PUMPY, PUMPY26, OUTCOME];
const SPOT_TAB = CATALOG.filter((m) => m.kind === 'spot');
const PERP_TAB = CATALOG.filter((m) => m.kind === 'perp');

const run = (over: Partial<SearchInput>) =>
  searchRows({ tabRows: SPOT_TAB, q: '', strict: true, catalog: null, resolveFull: null, ...over });
const coins = (r: { rows: Market[] }) => r.rows.map((m) => m.coin);

describe('searchRows', () => {
  it('no query under Strict: only allowlisted spot, never relaxed — even when that is empty', () => {
    expect(run({})).toEqual({ rows: [AAA_SPOT, PUMPY], crossTab: false, strictRelaxed: false });
    expect(run({ tabRows: [SYNX_USDC] })).toEqual({ rows: [], crossTab: false, strictRelaxed: false });
  });

  it('Strict hides EVERY match → the tab\'s matches show, flagged, toggle untouched', () => {
    expect(run({ q: 'synx' })).toEqual({ rows: [SYNX_USDC, SYNX_USDT], crossTab: false, strictRelaxed: true });
  });

  it('a PARTIAL hide stays hidden (relax only when every match is hidden)', () => {
    expect(run({ q: 'pumpy' })).toEqual({ rows: [PUMPY], crossTab: false, strictRelaxed: false });
  });

  it('Strict off: plain matches, no flag', () => {
    expect(run({ q: 'synx', strict: false })).toEqual({
      rows: [SYNX_USDC, SYNX_USDT],
      crossTab: false,
      strictRelaxed: false,
    });
  });

  it('list mode: the same-tab relax wins over the cross-tab fallback', () => {
    expect(run({ q: 'synx', catalog: CATALOG })).toMatchObject({ crossTab: false, strictRelaxed: true });
  });

  it('list mode on a tab Strict does not gate: cross-tab, never an outcome', () => {
    const r = run({ tabRows: PERP_TAB, strict: false, q: 'synx', catalog: CATALOG });
    expect(coins(r)).toEqual(['@720', '@721']);
    expect(r).toMatchObject({ crossTab: true, strictRelaxed: false });
  });

  it('picker full-name resolve flags a Strict-hidden pair, but not on a tab Strict does not gate', () => {
    const resolveFull = (q: string) => (q === 'synx/usdc' ? SYNX_USDC : undefined);
    expect(run({ q: 'synx/usdc', resolveFull })).toEqual({
      rows: [SYNX_USDC],
      crossTab: false,
      strictRelaxed: true,
    });
    expect(run({ tabRows: PERP_TAB, strict: false, q: 'synx/usdc', resolveFull })).toEqual({
      rows: [SYNX_USDC],
      crossTab: false,
      strictRelaxed: false,
    });
    expect(run({ q: 'zz', resolveFull: () => OUTCOME }).rows).toEqual([]);
  });

  it('a full-name hit from OUTSIDE the tab is never flagged as Strict\'s doing (Trending, a quote sub-tab)', () => {
    const resolveFull = (q: string) => (q === 'synx/usdc' ? SYNX_USDC : undefined);
    expect(run({ tabRows: [AAA_SPOT], q: 'synx/usdc', resolveFull })).toEqual({
      rows: [SYNX_USDC],
      crossTab: false,
      strictRelaxed: false,
    });
  });

  it('invariant: relaxed rows all fail Strict; unflagged gated rows all pass it', () => {
    for (const q of ['', 'a', 'synx', 'pumpy', 'usdc', 'zzz', 'aaa']) {
      const r = run({ q });
      if (r.strictRelaxed) expect(r.rows.every((m) => !passesStrict(m))).toBe(true);
      else if (!r.crossTab) expect(r.rows.every(passesStrict)).toBe(true);
    }
  });
});

describe('matchesQuery', () => {
  it('matches the base segment and keyword aliases, never the quote', () => {
    expect(matchesQuery(SYNX_USDC, 'syn')).toBe(true);
    expect(matchesQuery(SYNX_USDC, 'usdc')).toBe(false);
    expect(matchesQuery({ ...AAA_SPOT, keywords: ['ubtc'] }, 'ubt')).toBe(true);
    expect(matchesQuery(PUMPY26, 'pumpy')).toBe(true);
  });
});
