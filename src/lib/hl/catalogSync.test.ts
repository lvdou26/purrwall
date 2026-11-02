import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSpot,
  loadMarkets,
  mergeCatalog,
  passesStrict,
  patchOutcomes,
  sameMarket,
  type MarketCatalog,
} from './markets';
import {
  catalogDrift,
  createCatalogRefresher,
  REFRESH_BACKSTOP_MS,
  REFRESH_MIN_GAP_MS,
  type CatalogRefresherDeps,
} from './catalogSync';
import type { PollListing } from './stats';
import type { Market } from './types';
import spotSelector from './spotSelector.json';
import { info } from './info';

// markets.ts imports the REST client; nothing here may reach it.
vi.mock('./info', () => ({ info: vi.fn() }));

const LISTED_ID = (spotSelector.strict as Array<[string, string | null]>)[0][0];
const UNLISTED_ID = `0x${'f'.repeat(32)}`;

/* ─── spot building + HL's Strict allowlist ─── */

describe('buildSpot', () => {
  const meta = {
    tokens: [
      { name: 'USDC', index: 0, tokenId: `0x${'0'.repeat(32)}` },
      { name: 'AAA', index: 1, tokenId: LISTED_ID },
      { name: 'SYNX', index: 2, tokenId: UNLISTED_ID },
      { name: 'XMR1', index: 3, tokenId: `0x${'3'.repeat(32)}` },
      { name: 'USDH', index: 4, tokenId: `0x${'4'.repeat(32)}` },
    ],
    universe: [
      { name: 'AAA/USDC', tokens: [1, 0] as [number, number], index: 0, isCanonical: true },
      { name: '@720', tokens: [2, 0] as [number, number], index: 720, isCanonical: false },
      { name: '@260', tokens: [3, 0] as [number, number], index: 260, isCanonical: false },
      { name: '@232', tokens: [1, 4] as [number, number], index: 232, isCanonical: false },
    ],
  };
  const { markets, seen } = buildSpot(meta);

  it('keys Strict on the BASE token id (HL selector `spotId`)', () => {
    const syn = markets.find((m) => m.coin === '@720')!;
    expect(syn.display).toBe('SYNX/USDC');
    expect(syn.spotTokenId).toBe(UNLISTED_ID);
    expect(markets.find((m) => m.coin === 'AAA/USDC')!.spotTokenId).toBe(LISTED_ID);
  });

  it("drops HL's hidden bases and quotes but still counts them as SEEN", () => {
    expect(markets.map((m) => m.coin)).toEqual(['AAA/USDC', '@720']);
    // the drift baseline must include what the loader hides, or a hidden
    // pair would read as a new listing on every poll
    expect(seen).toEqual(['AAA/USDC', '@720', '@260', '@232']);
  });
});

describe('passesStrict', () => {
  const spot = (spotTokenId?: string): Market => ({ coin: '@1', display: 'X/USDC', kind: 'spot', spotTokenId });
  it('passes an allowlisted base, rejects an unlisted one and a spot row without an id', () => {
    expect(passesStrict(spot(LISTED_ID))).toBe(true);
    expect(passesStrict(spot(UNLISTED_ID))).toBe(false);
    expect(passesStrict(spot(undefined))).toBe(false);
  });
  it('never filters anything but spot', () => {
    expect(passesStrict({ coin: 'BTC', display: 'BTC-USDC', kind: 'perp' })).toBe(true);
    expect(passesStrict({ coin: 'xyz:TSLA', display: 'TSLA-USDC', kind: 'hip3', dex: 'xyz' })).toBe(true);
  });
  it('the synced allowlist is well-formed', () => {
    const ids = (spotSelector.strict as Array<[string, string | null]>).map(([id]) => id);
    expect(ids.length).toBeGreaterThanOrEqual(40);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^0x[0-9a-f]{32}$/);
  });
});

/* ─── mergeCatalog: identity + never-degrade ─── */

const perp = (coin: string, extra: Partial<Market> = {}): Market => ({ coin, display: `${coin}-USDC`, kind: 'perp', maxLeverage: 20, ...extra });
const spotM = (coin: string, display: string): Market => ({ coin, display, kind: 'spot', spotBase: display.split('/')[0], spotTokenId: UNLISTED_ID });
const hip3 = (dex: string, name: string): Market => ({ coin: `${dex}:${name}`, display: `${name}-USDC`, kind: 'hip3', dex });
const hip4 = (coin: string): Market => ({ coin, display: `Q · ${coin}`, kind: 'hip4', description: 'd' });

function catalog(markets: Market[], over: Partial<MarketCatalog> = {}): MarketCatalog {
  return {
    markets,
    failed: [],
    failedDexs: [],
    outcomeQuestions: [{ id: 1, name: 'Q', category: undefined, outcomes: [] }],
    spotSeen: new Set(markets.filter((m) => m.kind === 'spot').map((m) => m.coin)),
    outcomeSeen: new Set(markets.filter((m) => m.kind === 'hip4').map((m) => m.coin)),
    ...over,
  };
}
// a structurally identical copy: new objects everywhere, as a fresh load returns
const reload = (c: MarketCatalog, over: Partial<MarketCatalog> = {}): MarketCatalog => ({
  ...(JSON.parse(JSON.stringify({ ...c, spotSeen: [...c.spotSeen], outcomeSeen: [...c.outcomeSeen] })) as MarketCatalog),
  spotSeen: new Set(c.spotSeen),
  outcomeSeen: new Set(c.outcomeSeen),
  ...over,
});

const BASE = [perp('BTC'), perp('ETH'), spotM('@1', 'AAA/USDC'), hip3('xyz', 'TSLA'), hip3('para', 'FOO'), hip4('#10'), hip4('#11')];

describe('mergeCatalog', () => {
  it('an unchanged reload returns `prev` itself (React skips the render)', () => {
    const prev = catalog(BASE);
    expect(mergeCatalog(prev, reload(prev))).toBe(prev);
  });

  it('a new listing: one new object, every other Market is the OLD object', () => {
    const prev = catalog(BASE);
    const next = reload(prev);
    next.markets = [...next.markets.slice(0, 3), spotM('@720', 'SYN/USDC'), ...next.markets.slice(3)];
    next.spotSeen = new Set([...prev.spotSeen, '@720']);
    const merged = mergeCatalog(prev, next);
    expect(merged).not.toBe(prev);
    expect(merged.markets).toHaveLength(BASE.length + 1);
    for (const m of prev.markets) expect(merged.markets.find((x) => x.coin === m.coin)).toBe(m);
    expect(merged.markets.find((m) => m.coin === '@720')!.display).toBe('SYN/USDC');
    expect(merged.outcomeQuestions).toBe(prev.outcomeQuestions);
    expect(merged.spotSeen.has('@720')).toBe(true);
  });

  it('a changed field replaces only that Market', () => {
    const prev = catalog(BASE);
    const next = reload(prev);
    next.markets = next.markets.map((m) => (m.coin === 'BTC' ? { ...m, maxLeverage: 40 } : m));
    const merged = mergeCatalog(prev, next);
    expect(merged.markets.find((m) => m.coin === 'BTC')).not.toBe(prev.markets[0]);
    expect(merged.markets.find((m) => m.coin === 'ETH')).toBe(prev.markets[1]);
  });

  it('a delisting drops the market (the wall keeps it through sticky resolve, not here)', () => {
    const prev = catalog(BASE);
    const next = reload(prev, { markets: reload(prev).markets.filter((m) => m.coin !== 'ETH') });
    expect(mergeCatalog(prev, next).markets.some((m) => m.coin === 'ETH')).toBe(false);
  });

  it('never degrades: a slice that failed to reload keeps the previous slice', () => {
    const prev = catalog(BASE);
    const next = reload(prev, {
      markets: reload(prev).markets.filter((m) => m.kind !== 'spot' && m.kind !== 'perp'),
      failed: ['Perps', 'Spot'],
      spotSeen: new Set(),
    });
    const merged = mergeCatalog(prev, next);
    expect(merged).toBe(prev); // same content → literally the old catalog
    expect(merged.failed).toEqual([]);
  });

  it('a partially failed HIP-3 reload keeps the missing dex from prev', () => {
    const prev = catalog(BASE);
    const next = reload(prev, {
      markets: reload(prev).markets.filter((m) => m.dex !== 'para'),
      failed: ['HIP-3'],
      failedDexs: ['para'],
    });
    const merged = mergeCatalog(prev, next);
    expect(merged.markets.find((m) => m.coin === 'para:FOO')).toBe(prev.markets[4]);
    expect(merged.failed).toEqual([]); // never grows
  });

  it('`failed` shrinks when a reload heals a boot-time failure', () => {
    const prev = catalog(BASE.filter((m) => m.kind !== 'spot'), { failed: ['Spot'], spotSeen: new Set() });
    const next = catalog(BASE);
    const merged = mergeCatalog(prev, next);
    expect(merged.failed).toEqual([]);
    expect(merged.markets.some((m) => m.coin === '@1')).toBe(true);
    expect(merged.spotSeen.has('@1')).toBe(true);
  });

  it('HIP-4 derived-labels-only never replaces a clean slice', () => {
    const prev = catalog(BASE);
    const degraded = patchOutcomes(prev, {
      markets: [{ ...hip4('#10'), display: 'derived label' }],
      questions: [],
      seen: ['#10', '#11'],
      templatesFailed: true,
    });
    expect(mergeCatalog(prev, degraded)).toBe(prev);
  });

  it('patchOutcomes swaps only the Outcome slice', () => {
    const prev = catalog(BASE);
    const merged = mergeCatalog(
      prev,
      patchOutcomes(prev, { markets: [hip4('#10'), hip4('#20')], questions: prev.outcomeQuestions, seen: ['#10', '#11', '#20', '#21'], templatesFailed: false }),
    );
    expect(merged.markets.filter((m) => m.kind === 'hip4').map((m) => m.coin)).toEqual(['#10', '#20']);
    expect(merged.markets.find((m) => m.coin === '#10')).toBe(prev.markets[5]);
    expect(merged.markets.find((m) => m.coin === 'BTC')).toBe(prev.markets[0]);
    expect(merged.outcomeSeen.has('#21')).toBe(true);
  });
  it('HIP-3 failure is judged per DEX: two loads that each lost a different dex hold every dex', () => {
    const prev = catalog(BASE.filter((m) => m.dex !== 'xyz'), { failed: ['HIP-3'], failedDexs: ['xyz'] });
    const next = catalog(BASE.filter((m) => m.dex !== 'para'), { failed: ['HIP-3'], failedDexs: ['para'] });
    const merged = mergeCatalog(prev, next);
    expect(merged.markets.map((m) => m.coin)).toEqual(expect.arrayContaining(['xyz:TSLA', 'para:FOO']));
    expect(merged.failed).toEqual([]);
    expect(merged.failedDexs).toEqual([]);
  });

  it('a partial HIP-3 failure followed by an outright one still names the missing dex', () => {
    const prev = catalog(BASE.filter((m) => m.dex !== 'xyz'), { failed: ['HIP-3'], failedDexs: ['xyz'] });
    const next = catalog(BASE.filter((m) => m.kind !== 'hip3'), { failed: ['HIP-3'] });
    const merged = mergeCatalog(prev, next);
    expect(merged.failed).toEqual(['HIP-3']);
    expect(merged.failedDexs).toEqual(['xyz']);
    expect(merged.markets.some((m) => m.coin === 'para:FOO')).toBe(true);
  });
});

describe('loadMarkets: a silent side-list failure never strips a clean catalog', () => {
  afterEach(() => vi.restoreAllMocks());
  // One HIP-3 dex with an annotated market; everything else minimal.
  const answer = (body: Record<string, unknown>, sideListsFail: boolean): unknown => {
    switch (body.type) {
      case 'meta':
        return { universe: body.dex ? [{ name: 'xyz:OAI' }] : [{ name: 'BTC' }] };
      case 'spotMeta':
        return { tokens: [], universe: [] };
      case 'perpDexs':
        return [null, { name: 'xyz' }];
      case 'perpConciseAnnotations':
        if (sideListsFail) throw new Error('HTTP 429');
        return [['xyz:OAI', { category: 'preipo', displayName: 'OPENAI', keywords: ['openai'] }]];
      case 'perpCategories':
        if (sideListsFail) throw new Error('HTTP 429');
        return [['xyz:OAI', 'preipo']];
      case 'outcomeMeta':
        return { outcomes: [], questions: [] };
      case 'outcomeTemplates':
        if (sideListsFail) throw new Error('HTTP 429');
        return [];
      default:
        throw new Error(`unexpected ${String(body.type)}`);
    }
  };

  it('falls back to the last good annotations / categories / templates', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(info).mockImplementation(async (body: Record<string, unknown>) => answer(body, false));
    const prev = await loadMarkets();
    expect(prev.markets.find((m) => m.coin === 'xyz:OAI')).toMatchObject({ display: 'OPENAI-USDC', category: 'preipo' });
    vi.mocked(info).mockImplementation(async (body: Record<string, unknown>) => answer(body, true));
    const next = await loadMarkets();
    expect(next.failed).toEqual([]);
    expect(mergeCatalog(prev, next)).toBe(prev);
  });
});

describe('sameMarket', () => {
  it('compares over the union of keys, arrays element-wise, key order irrelevant', () => {
    expect(sameMarket({ coin: 'a', display: 'A', kind: 'spot', keywords: ['x'] }, { kind: 'spot', display: 'A', coin: 'a', keywords: ['x'] })).toBe(true);
    expect(sameMarket({ coin: 'a', display: 'A', kind: 'spot' }, { coin: 'a', display: 'A', kind: 'spot', preLaunch: true })).toBe(false);
    expect(sameMarket({ coin: 'a', display: 'A', kind: 'spot', keywords: ['x'] }, { coin: 'a', display: 'A', kind: 'spot', keywords: ['y'] })).toBe(false);
  });
});

/* ─── drift ─── */

const listingOf = (c: MarketCatalog, over: Partial<PollListing> = {}): PollListing => ({
  perps: new Map([
    ['', c.markets.filter((m) => m.kind === 'perp').map((m) => m.coin)],
    ['xyz', c.markets.filter((m) => m.dex === 'xyz').map((m) => m.coin)],
    ['para', c.markets.filter((m) => m.dex === 'para').map((m) => m.coin)],
  ]),
  spot: [...c.spotSeen],
  outcomes: [...c.outcomeSeen],
  ...over,
});

describe('catalogDrift', () => {
  it('steady state (hidden pairs and fallback outcome sides included) → no drift', () => {
    const c = catalog(BASE, { spotSeen: new Set(['@1', '@260']), outcomeSeen: new Set(['#10', '#11', '#990', '#991']) });
    expect(catalogDrift(c, listingOf(c))).toEqual({ full: [], outcomes: [] });
  });

  it('a new spot pair (SYN) is full drift', () => {
    const c = catalog(BASE);
    expect(catalogDrift(c, listingOf(c, { spot: [...c.spotSeen, '@720'] }))).toEqual({ full: ['+spot:@720'], outcomes: [] });
  });

  it('new / delisted perps and HIP-3 markets, per polled dex', () => {
    const c = catalog(BASE);
    const l = listingOf(c);
    l.perps.set('', ['BTC', 'ETH', 'NEWP']);
    l.perps.set('xyz', []);
    expect(catalogDrift(c, l).full.sort()).toEqual(['+perp:NEWP', '-hip3/xyz:xyz:TSLA'].sort());
  });

  it('outcome churn is its own class', () => {
    const c = catalog(BASE);
    expect(catalogDrift(c, listingOf(c, { outcomes: ['#10', '#11', '#20', '#21'] }))).toEqual({
      full: [],
      outcomes: ['+hip4:#20', '+hip4:#21'],
    });
  });

  it('a part the poll failed to fetch is never read as "everything was delisted"', () => {
    const c = catalog(BASE);
    expect(catalogDrift(c, { perps: new Map(), spot: null, outcomes: null })).toEqual({ full: [], outcomes: [] });
  });
});

/* ─── the refresher ─── */

describe('createCatalogRefresher', () => {
  afterEach(() => vi.restoreAllMocks());

  function harness(initial: MarketCatalog) {
    let t = 1_000_000;
    let current = initial;
    const deps: CatalogRefresherDeps = {
      now: () => t,
      current: () => current,
      apply: (update) => {
        current = update(current);
      },
      loadFull: vi.fn(async () => current),
      loadOutcomes: vi.fn(async () => ({ markets: [], questions: [], seen: [], templatesFailed: false })),
    };
    const r = createCatalogRefresher(deps);
    return {
      deps,
      r,
      get current() {
        return current;
      },
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  it('no drift → no request, until the 30-minute backstop', async () => {
    const h = harness(catalog(BASE));
    await h.r.onPoll(listingOf(h.current));
    expect(h.deps.loadFull).not.toHaveBeenCalled();
    h.advance(REFRESH_BACKSTOP_MS);
    await h.r.onPoll(listingOf(h.current));
    expect(h.deps.loadFull).toHaveBeenCalledTimes(1);
  });

  it('a new spot listing is applied on the first poll after the gap, through mergeCatalog', async () => {
    const prev = catalog(BASE);
    const h = harness(prev);
    const withSyn = reload(prev);
    withSyn.markets = [...withSyn.markets, spotM('@720', 'SYN/USDC')];
    withSyn.spotSeen = new Set([...prev.spotSeen, '@720']);
    vi.mocked(h.deps.loadFull).mockResolvedValue(withSyn);
    const listing = listingOf(prev, { spot: [...prev.spotSeen, '@720'] });
    await h.r.onPoll(listing); // boot load counts as a full load: still inside the gap
    expect(h.deps.loadFull).not.toHaveBeenCalled();
    h.advance(REFRESH_MIN_GAP_MS);
    await h.r.onPoll(listing);
    expect(h.deps.loadFull).toHaveBeenCalledTimes(1);
    expect(h.current.markets.find((m) => m.coin === '@720')?.display).toBe('SYN/USDC');
    expect(h.current.markets.find((m) => m.coin === 'BTC')).toBe(prev.markets[0]);
    // resolved: the next poll sees no drift and spends nothing
    h.advance(REFRESH_MIN_GAP_MS);
    await h.r.onPoll(listing);
    expect(h.deps.loadFull).toHaveBeenCalledTimes(1);
  });

  it('outcome-only drift takes the 3-request path, never the full load', async () => {
    const prev = catalog(BASE);
    const h = harness(prev);
    vi.mocked(h.deps.loadOutcomes).mockResolvedValue({
      markets: [hip4('#10'), hip4('#11'), hip4('#20')],
      questions: prev.outcomeQuestions,
      seen: ['#10', '#11', '#20', '#21'],
      templatesFailed: false,
    });
    h.advance(REFRESH_MIN_GAP_MS);
    await h.r.onPoll(listingOf(prev, { outcomes: ['#10', '#11', '#20', '#21'] }));
    expect(h.deps.loadFull).not.toHaveBeenCalled();
    expect(h.deps.loadOutcomes).toHaveBeenCalledTimes(1);
    expect(h.current.markets.some((m) => m.coin === '#20')).toBe(true);
  });

  it('drift the load cannot explain is struck out after two refreshes (no 5-minute loop)', async () => {
    const prev = catalog(BASE);
    const h = harness(prev); // loadFull keeps returning a catalog without the phantom
    const listing = listingOf(prev, { spot: [...prev.spotSeen, '@999'] });
    for (let i = 0; i < 5; i++) {
      h.advance(REFRESH_MIN_GAP_MS);
      await h.r.onPoll(listing);
    }
    expect(h.deps.loadFull).toHaveBeenCalledTimes(2);
    h.advance(REFRESH_BACKSTOP_MS); // the backstop clears the strikes
    await h.r.onPoll(listing);
    expect(h.deps.loadFull).toHaveBeenCalledTimes(3);
  });

  it('a failed refresh is silent and keeps the catalog', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prev = catalog(BASE);
    const h = harness(prev);
    vi.mocked(h.deps.loadFull).mockRejectedValue(new Error('HTTP 429'));
    h.advance(REFRESH_MIN_GAP_MS);
    await h.r.onPoll(listingOf(prev, { spot: [...prev.spotSeen, '@720'] }));
    expect(h.current).toBe(prev);
    expect(warn).toHaveBeenCalled();
  });

  it('one refresh at a time: a poll landing mid-refresh is ignored', async () => {
    const prev = catalog(BASE);
    const h = harness(prev);
    let release!: () => void;
    vi.mocked(h.deps.loadFull).mockImplementation(
      () => new Promise<MarketCatalog>((res) => (release = () => res(prev))),
    );
    h.advance(REFRESH_BACKSTOP_MS);
    const first = h.r.onPoll(listingOf(prev));
    h.advance(REFRESH_BACKSTOP_MS);
    await h.r.onPoll(listingOf(prev));
    release();
    await first;
    expect(h.deps.loadFull).toHaveBeenCalledTimes(1);
  });
  it('a refresher seeded with an old load time catches up on its FIRST poll (background-opened tab)', async () => {
    const prev = catalog(BASE);
    const t = 10_000_000;
    const loadFull = vi.fn(async () => prev);
    const r = createCatalogRefresher({
      now: () => t,
      loadedAt: t - REFRESH_BACKSTOP_MS - 1,
      current: () => prev,
      apply: () => {},
      loadFull,
      loadOutcomes: vi.fn(),
    });
    await r.onPoll(listingOf(prev));
    expect(loadFull).toHaveBeenCalledTimes(1);
  });

  it('a slice that keeps failing to reload is struck too (drift kept by never-degrade)', async () => {
    const prev = catalog(BASE);
    const h = harness(prev);
    // every reload loses the main perps; the listing says ETH was delisted
    vi.mocked(h.deps.loadFull).mockImplementation(async () =>
      reload(prev, { markets: reload(prev).markets.filter((m) => m.kind !== 'perp'), failed: ['Perps'] }),
    );
    const listing = listingOf(prev);
    listing.perps.set('', ['BTC']);
    for (let i = 0; i < 5; i++) {
      h.advance(REFRESH_MIN_GAP_MS);
      await h.r.onPoll(listing);
    }
    expect(h.deps.loadFull).toHaveBeenCalledTimes(2);
    expect(h.current.markets.some((m) => m.coin === 'ETH')).toBe(true);
  });
});
