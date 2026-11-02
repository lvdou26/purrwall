// Pins the HL bundle-list extractor (scripts/lib/hlBundleLists.mjs) against
// SMALL synthetic chunks shaped like HL's Vite build, plus the
// mutations a future minifier / HL refactor could plausibly produce. The
// multi-MB real bundle is never committed; a synthetic spotMeta stands in for
// the live one.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractAll,
  failures,
  findIdLists,
  formatOverrides,
  formatSelector,
  htmlChunkRefs,
  loadBundle,
  missingAnchors,
  planWrites,
} from './hlBundleLists.mjs';

// ---- synthetic HL universe ----------------------------------------------------
const tid = (i) => `0x${(0x5eed0000 + i * 7919).toString(16).padStart(32, '0')}`;
const NAMED = ['USDC', 'USDH', 'USDT0', 'XMR1', 'FXMR', 'PURR', 'HYPE'];
const tokens = Array.from({ length: 120 }, (_, i) => ({ index: i, name: NAMED[i] ?? `TK${i}`, tokenId: tid(i) }));
// every token >= 3 trades against USDC; one pair each quoted in USDH / USDT0
const universe = [
  ...tokens.slice(3).map((t) => ({ name: `@${t.index}`, tokens: [t.index, 0] })),
  { name: '@500', tokens: [6, 1] },
  { name: '@501', tokens: [6, 2] },
];
const spotMeta = { tokens, universe };

// 22 rename rows over indexes 10..31 (+ the USDT0 display rename)
const MAP = [[2, 'USDT0', 'USDT'], ...Array.from({ length: 21 }, (_, k) => [10 + k, `TK${10 + k}`, `D${10 + k}`])];
// 50 Strict ids over tokens 5..54; 7 testnet ids unknown to mainnet
const STRICT = Array.from({ length: 50 }, (_, k) => tid(5 + k));
const TESTNET = Array.from({ length: 7 }, (_, k) => tid(9000 + k));

const quoteAll = (xs, q) => xs.map((x) => `${q}${x}${q}`).join(',');

function configChunk({
  q = '`',
  helper = 'Ah',
  key = 'Mainnet',
  map = MAP,
  bases = ['XMR1', 'FXMR'],
  quotes = ['USDH'],
  hidden = null, // override the whole hidden-list source
} = {}) {
  const rows = map.map(([i, l, d]) => `${helper}(${i},${q}${l}${q},${q}${d}${q})`).join(',');
  const hiddenSrc =
    hidden ??
    `cg=1e4,dg=[${quoteAll(bases, q)}];function fg(e){return dg.includes(e.toUpperCase())}` +
      `var pg=[${quoteAll(quotes, q)}];function mg(e){return pg.includes(e.toUpperCase())}`;
  return (
    `function ${helper}(e,t,n){return{index:jn(e),l1Name:t,displayName:n}}` +
    `var jh={Testnet:[${helper}(1129,${q}UNIT${q},${q}BTC${q})],${key}:[${rows}],Local:[],Sandbox:[]};` +
    // noise the extractors must ignore: an EVM address list, a name list
    `var ev=[\`0x6b9e773128f453f5c2c60935ee2de2cbc5390a24\`,\`0x0000000000000000000000000000000000000000\`],` +
    `nm=\`REI.SLAY.SOLV\`.split(\`.\`),` +
    hiddenSrc
  );
}

function strictList(ids, { form = 'split', sep = '.', q = '`' } = {}) {
  return form === 'split' ? `${q}${ids.join(sep)}${q}.split(${q}${sep}${q})` : `[${quoteAll(ids, q)}]`;
}

function seriesChunk({ ids = STRICT, form, sep, q, inverted = false, v = 'pt', o = 'o', extra = '' } = {}) {
  const main = strictList(ids, { form, sep, q });
  const test = `[${quoteAll(TESTNET, '`')}]`;
  const tern = inverted ? `${o}.chain!==\`Mainnet\`?${test}:${main}` : `${o}.chain===\`Mainnet\`?${main}:${test}`;
  return `var ft=[],${v}=${tern};function Tt(e){return i&&!${v}.includes(e.spotId??\`\`)}${extra}`;
}

const bundle = (config = configChunk(), series = seriesChunk()) =>
  new Map([
    ['/assets/config-X.js', config],
    ['/assets/series-Y.js', series],
  ]);

const committedSelector = (over = {}) => ({
  comment: 'c',
  source: { strict: 'app.hyperliquid.xyz/assets/series-OLD.js', hidden: 'app.hyperliquid.xyz/assets/config-OLD.js' },
  syncedAt: '2026-01-01T00:00:00.000Z',
  strict: STRICT.map((id) => [id, tokens.find((t) => t.tokenId === id).name]),
  hiddenBases: ['XMR1', 'FXMR'],
  hiddenQuotes: ['USDH'],
  ...over,
});
const committedOverrides = () => ({ comment: 'c', source: 'app.hyperliquid.xyz/static/js/main.x.js', syncedAt: 'x', entries: MAP });

const run = (chunks, committed = {}) => extractAll({ chunks, spotMeta, committed });

function expectClean(r) {
  expect(failures(r)).toEqual([]);
  expect(r.map.value).toEqual(MAP);
  expect(r.strict.value.map(([id]) => id)).toEqual(STRICT);
  expect(r.hiddenBases.value).toEqual(['XMR1', 'FXMR']);
  expect(r.hiddenQuotes.value).toEqual(['USDH']);
}

// ---- tolerated shapes -----------------------------------------------------------
describe('extracts all three lists from tolerated bundle shapes', () => {
  it('baseline: sources are the chunk paths', () => {
    const r = run(bundle());
    expectClean(r);
    expect(r.map.source).toBe('app.hyperliquid.xyz/assets/config-X.js');
    expect(r.strict.source).toBe('app.hyperliquid.xyz/assets/series-Y.js');
    expect(r.hiddenBases.source).toBe('app.hyperliquid.xyz/assets/config-X.js');
    expect(r.strict.value[0]).toEqual([tid(5), 'PURR']);
  });

  it.each([
    ['double quotes everywhere', bundle(configChunk({ q: '"' }), seriesChunk({ q: '"' }))],
    ["single quotes everywhere", bundle(configChunk({ q: "'" }), seriesChunk({ q: "'" }))],
    ['allowlist as an array literal', bundle(configChunk(), seriesChunk({ form: 'array' }))],
    ['allowlist joined by commas', bundle(configChunk(), seriesChunk({ sep: ',' }))],
    ['allowlist joined by pipes', bundle(configChunk(), seriesChunk({ sep: '|' }))],
    ['inverted gate (!==Mainnet ? testnet : mainnet)', bundle(configChunk(), seriesChunk({ inverted: true }))],
    [
      'renamed helper, quoted key, renamed list/fn/param idents',
      bundle(
        configChunk({
          helper: 'Qz$',
          key: '"Mainnet"',
          hidden: `Zk=[\`XMR1\`,\`FXMR\`];function Yq(t){return Zk.includes(t.toUpperCase())}var W$=[\`USDH\`];function b_(n){return W$.includes(n.toUpperCase())}`,
        }),
        seriesChunk({ v: 'Kq', o: 'Zr' }),
      ),
    ],
    [
      'hidden predicates as arrow functions',
      bundle(
        configChunk({
          hidden: `dg=[\`XMR1\`,\`FXMR\`],fg=e=>dg.includes(e.toUpperCase());const pg=[\`USDH\`];const mg=(e)=>pg.includes(e.toUpperCase())`,
        }),
      ),
    ],
    [
      'hidden lists declared quotes-first',
      bundle(
        configChunk({
          hidden: `pg=[\`USDH\`];function mg(e){return pg.includes(e.toUpperCase())}var dg=[\`XMR1\`,\`FXMR\`];function fg(e){return dg.includes(e.toUpperCase())}`,
        }),
      ),
    ],
    [
      'identical duplicate allowlist',
      bundle(configChunk(), seriesChunk({ extra: `;var zz=o.chain===\`Mainnet\`?${strictList(STRICT)}:[]` })),
    ],
    [
      'lists split across more chunks',
      new Map([
        ['/assets/a.js', configChunk({ hidden: '' })],
        ['/assets/b.js', seriesChunk()],
        ['/assets/c.js', `dg=[\`XMR1\`,\`FXMR\`];function fg(e){return dg.includes(e.toUpperCase())}`],
        ['/assets/d.js', `pg=[\`USDH\`];function mg(e){return pg.includes(e.toUpperCase())}`],
      ]),
    ],
  ])('%s', (_label, chunks) => {
    expectClean(run(chunks));
  });

  it('a second qualifying list outside the gated .spotId chunk is tie-broken away', () => {
    const chunks = bundle();
    chunks.set('/assets/other.js', `var feat=${strictList(STRICT.slice(0, 45))};`);
    const r = run(chunks);
    expectClean(r);
    expect(r.strict.notes.join('\n')).toMatch(/tie-broken/);
  });

  it('ids not (yet) live within the 10% margin are kept with a null name', () => {
    const ids = [...STRICT.slice(0, 46), ...TESTNET.slice(0, 4)]; // 46/50 = 92% live
    const r = run(bundle(configChunk(), seriesChunk({ ids })));
    expect(r.strict.ok).toBe(true);
    expect(r.strict.value.filter(([, n]) => n === null).map(([id]) => id)).toEqual(TESTNET.slice(0, 4));
  });

  it('a hidden quote may be a DISPLAY name (USDT0 shows as USDT)', () => {
    const r = run(bundle(configChunk({ quotes: ['USDH', 'USDT'] })));
    expect(r.hiddenQuotes).toMatchObject({ ok: true, value: ['USDH', 'USDT'] });
  });

  it('a hidden base may be a hyphenated DISPLAY name (ANSEM-19, PUMP-26)', () => {
    const r = run(bundle(configChunk({ bases: ['XMR1', 'FXMR', 'ANSEM-19'] })), { selector: committedSelector() });
    expect(r.hiddenBases).toMatchObject({ ok: true, value: ['XMR1', 'FXMR', 'ANSEM-19'] });
  });

  it('a third matching list falls back to membership (USDH → quotes, XMR1 → bases)', () => {
    const chunks = bundle();
    chunks.set('/assets/z.js', `hp=[\`BTC\`,\`ETH\`];function hq(e){return hp.includes(e.toUpperCase())}`);
    const r = run(chunks);
    expectClean(r);
    expect(r.hiddenQuotes.notes.join('\n')).toMatch(/fell back to membership/);
  });

  it('never reads an id out of a 40-hex address or a mixed-separator string', () => {
    const mixed = `\`${STRICT.slice(0, 20).join('.')},${STRICT.slice(20).join('.')}\`.split(\`.\`)`;
    const lists = findIdLists(new Map([['/assets/q.js', `var a=${mixed};var b=[\`0x6b9e773128f453f5c2c60935ee2de2cbc5390a24\`,\`0x6b9e773128f453f5c2c60935ee2de2cbc5390a25\`]`]]));
    expect(lists.every((l) => l.ids.every((id) => /^0x[0-9a-f]{32}$/.test(id)))).toBe(true);
    expect(lists.some((l) => l.ids.length >= 40)).toBe(false);
  });
});

// ---- failures -------------------------------------------------------------------------
describe('fails loudly (and per list) on shapes that need a human', () => {
  const only = (r, key) => {
    for (const k of ['map', 'strict', 'hiddenBases', 'hiddenQuotes']) expect(r[k].ok, k).toBe(k !== key);
    return r[key].error;
  };

  it('allowlist truncated below MIN_STRICT_IDS', () => {
    expect(only(run(bundle(configChunk(), seriesChunk({ ids: STRICT.slice(0, 20) }))), 'strict')).toMatch(/no qualifying list/);
  });

  it('allowlist gone (only the 7-id testnet array remains)', () => {
    const series = `var pt=o.chain===\`Mainnet\`?[]:[${quoteAll(TESTNET, '`')}]`;
    expect(only(run(bundle(configChunk(), series)), 'strict')).toMatch(/largest candidate: 7 ids/);
  });

  it('allowlist mostly unknown ids (below the 90% resolve ratio)', () => {
    const ids = [...STRICT.slice(0, 44), ...Array.from({ length: 6 }, (_, k) => tid(7000 + k))]; // 88%
    expect(only(run(bundle(configChunk(), seriesChunk({ ids }))), 'strict')).toMatch(/no qualifying list/);
  });

  it('two different qualifying allowlists, both gated in the .spotId chunk', () => {
    const extra = `;var zz=o.chain===\`Mainnet\`?${strictList(STRICT.slice(0, 45))}:[]`;
    expect(only(run(bundle(configChunk(), seriesChunk({ extra }))), 'strict')).toMatch(/2 different qualifying lists/);
  });

  it('duplicate ids', () => {
    const ids = [...STRICT, STRICT[3]];
    expect(only(run(bundle(configChunk(), seriesChunk({ ids }))), 'strict')).toMatch(/duplicate id/);
  });

  it('continuity guard: keeps fewer than 80% of the committed ids', () => {
    const committed = { selector: committedSelector({ strict: [...STRICT, ...tokens.slice(60, 70).map((t) => t.tokenId)].map((id) => [id, null]) }) };
    // 41 of 60 committed = 68% — passes MIN_STRICT_IDS, fails the guard
    const r = run(bundle(configChunk(), seriesChunk({ ids: STRICT.slice(0, 41) })), committed);
    expect(only(r, 'strict')).toMatch(/replaced\/grew wholesale — keeps 41 of 60 committed ids/);
    // 48 of 60 = 80% is allowed
    expect(run(bundle(configChunk(), seriesChunk({ ids: STRICT.slice(0, 48) })), committed).strict.ok).toBe(true);
  });

  it('continuity guard: a DIFFERENT list of the same size never replaces the allowlist', () => {
    const other = tokens.slice(60, 110).map((t) => t.tokenId); // 50 live ids, none committed
    const r = run(bundle(configChunk(), seriesChunk({ ids: other })), { selector: committedSelector() });
    expect(only(r, 'strict')).toMatch(/keeps 0 of 50 committed ids .* adds 50 \(max 25\)/);
    // with nothing committed there is nothing to be continuous with
    expect(run(bundle(configChunk(), seriesChunk({ ids: other }))).strict.ok).toBe(true);
  });

  it('continuity guard: adds at most max(10, 50% of the committed ids)', () => {
    const committed = { selector: committedSelector() }; // 50 ids → at most 25 new
    const grow = (n) => [...STRICT, ...tokens.slice(55, 55 + n).map((t) => t.tokenId)];
    expect(only(run(bundle(configChunk(), seriesChunk({ ids: grow(26) })), committed), 'strict')).toMatch(/adds 26 \(max 25\)/);
    expect(run(bundle(configChunk(), seriesChunk({ ids: grow(25) })), committed).strict.ok).toBe(true);
    // small committed lists get the floor of 10
    const small = { selector: committedSelector({ strict: STRICT.slice(0, 12).map((id) => [id, null]) }) };
    const next = [...STRICT.slice(0, 12), ...tokens.slice(55, 65).map((t) => t.tokenId), ...STRICT.slice(12, 40)];
    expect(only(run(bundle(configChunk(), seriesChunk({ ids: next })), small), 'strict')).toMatch(/adds 38 \(max 10\)/);
  });

  it('map index drift', () => {
    const map = MAP.map((e, k) => (k === 3 ? [e[0] + 1, e[1], e[2]] : e));
    expect(only(run(bundle(configChunk({ map }))), 'map')).toMatch(/index drift against live spotMeta: 13:TK12→TK13/);
  });

  it('map below MIN_MAP_ENTRIES', () => {
    expect(only(run(bundle(configChunk({ map: MAP.slice(0, 12) }))), 'map')).toMatch(/only 12 entries/);
  });

  it('map using two helper identifiers', () => {
    const cfg = configChunk().replace('Ah(10,', 'Bh(10,');
    expect(only(run(bundle(cfg)), 'map')).toMatch(/2 helper identifiers/);
  });

  it('map with a suspicious display name', () => {
    const map = MAP.map((e, k) => (k === 5 ? [e[0], e[1], 'x:y'] : e));
    expect(only(run(bundle(configChunk({ map }))), 'map')).toMatch(/suspicious display name/);
  });

  it('map gone', () => {
    expect(only(run(bundle(configChunk({ key: 'Mainnetz' }))), 'map')).toMatch(/no `Mainnet:\[/);
  });

  it('hidden lists gone → both hidden sections fail', () => {
    const r = run(bundle(configChunk({ hidden: 'dg=1' })));
    expect(r.map.ok && r.strict.ok).toBe(true);
    expect(r.hiddenBases.error).toMatch(/^hidden bases: no `L=/);
    expect(r.hiddenQuotes.error).toMatch(/^hidden quotes: no `L=/);
  });

  it('quotes list gone → quotes fail, bases still validate', () => {
    const r = run(bundle(configChunk({ hidden: `dg=[\`XMR1\`,\`FXMR\`];function fg(e){return dg.includes(e.toUpperCase())}` })));
    expect(only(r, 'hiddenQuotes')).toMatch(/cannot identify/);
    expect(r.hiddenBases.value).toEqual(['XMR1', 'FXMR']);
  });

  it('a hidden quote that is not a live token', () => {
    expect(only(run(bundle(configChunk({ quotes: ['USDH', 'NOPE'] }))), 'hiddenQuotes')).toMatch(/not live spot token names: NOPE/);
  });

  it('an empty hidden list', () => {
    expect(only(run(bundle(configChunk({ bases: [] }))), 'hiddenBases')).toMatch(/empty/);
  });

  it('a hidden entry that is not display-name shaped', () => {
    expect(only(run(bundle(configChunk({ bases: ['XMR1', 'F:XMR'] }))), 'hiddenBases')).toMatch(/not display-name shaped \["F:XMR"\]/);
  });

  it('(a) a quote-shaped list carrying XMR1 fails quotes only', () => {
    // make XMR1 a quote token so the pick is data-decisive and still wrong
    const meta = { tokens, universe: [...universe, { name: '@502', tokens: [7, 3] }] };
    const chunks = bundle(configChunk({ bases: ['FXMR'], quotes: ['USDH', 'XMR1'] }));
    const r = extractAll({ chunks, spotMeta: meta, committed: { selector: committedSelector() } });
    expect(only(r, 'hiddenQuotes')).toMatch(/carries XMR1, a hidden BASE anchor/);
    expect(r.hiddenBases.value).toEqual(['FXMR']);
  });

  it('(a) a bases list carrying USDH fails bases only', () => {
    const r = run(bundle(configChunk({ bases: ['XMR1', 'FXMR', 'USDH'] })), { selector: committedSelector() });
    expect(only(r, 'hiddenBases')).toMatch(/carries USDH, a hidden QUOTE anchor/);
  });

  it('(b) a list replaced wholesale fails; one sharing an entry with the committed list passes', () => {
    const committed = { selector: committedSelector() };
    expect(only(run(bundle(configChunk({ bases: ['TK99'] })), committed), 'hiddenBases')).toMatch(
      /replaced wholesale — \[TK99\] .* shares nothing with the committed \[XMR1,FXMR\] and lacks XMR1/,
    );
    expect(only(run(bundle(configChunk({ quotes: ['USDT'] })), committed), 'hiddenQuotes')).toMatch(/replaced wholesale — \[USDT\]/);
    // dropping the anchor is fine while an entry carries over
    expect(run(bundle(configChunk({ bases: ['FXMR', 'TK99'] })), committed).hiddenBases).toMatchObject({ ok: true, value: ['FXMR', 'TK99'] });
    // with nothing committed the guard stands aside
    expect(run(bundle(configChunk({ bases: ['TK99'] }))).hiddenBases.ok).toBe(true);
  });

  it('(c) a Strict-allowlisted token is never a hidden base (the `dg=[HYPE]` attack)', () => {
    expect(only(run(bundle(configChunk({ bases: ['XMR1', 'FXMR', 'HYPE'] })), { selector: committedSelector() }), 'hiddenBases')).toMatch(
      /HYPE is on the Strict allowlist/,
    );
    // an unrelated one-entry list in the same idiom fails even with nothing committed
    expect(only(run(bundle(configChunk({ bases: ['HYPE'] }))), 'hiddenBases')).toMatch(/HYPE is on the Strict allowlist/);
    // … and on continuity first when something is committed
    expect(only(run(bundle(configChunk({ bases: ['HYPE'] })), { selector: committedSelector() }), 'hiddenBases')).toMatch(/replaced wholesale/);
  });

  it('two conflicting bases lists with no anchor to decide between them', () => {
    const chunks = bundle(configChunk({ bases: ['FXMR'] }));
    chunks.set('/assets/z.js', `hp=[\`PURR\`];function hq(e){return hp.includes(e.toUpperCase())}`);
    expect(only(run(chunks), 'hiddenBases')).toMatch(/cannot identify/);
  });

  it('an implausible spotMeta fails every list', () => {
    const r = extractAll({ chunks: bundle(), spotMeta: { tokens: tokens.slice(0, 10), universe }, committed: {} });
    expect(failures(r)).toHaveLength(4);
  });
});

// ---- discovery ----------------------------------------------------------------------------
describe('discovery', () => {
  const HTML = `<script type="module" crossorigin src="/assets/index-A.js"></script><link rel="modulepreload" crossorigin href="/assets/config-X.js"><link rel=modulepreload href=/assets/series-Y.js>`;
  const files = { '/': HTML, '/assets/index-A.js': 'import"./x.js"', '/assets/config-X.js': configChunk(), '/assets/series-Y.js': seriesChunk() };
  const fetcher = (map, seen = []) => async (p) => {
    seen.push(p);
    return map[p] ?? null;
  };

  it('reads the entry and every modulepreload, quoted or not', () => {
    expect(htmlChunkRefs(HTML)).toEqual(['/assets/index-A.js', '/assets/config-X.js', '/assets/series-Y.js']);
  });

  it('stays at level 0 when every anchor is there', async () => {
    const seen = [];
    const b = await loadBundle(fetcher(files, seen));
    expect(b.depth).toBe(0);
    expect(seen).not.toContain('/assets/x.js');
    expectClean(run(b.chunks));
  });

  it('follows imports one level deeper when a list moved to a lazy chunk', async () => {
    const html = `<script type="module" src="/assets/index-A.js"></script><link rel="modulepreload" href="/assets/config-X.js">`;
    const map = { ...files, '/': html, '/assets/index-A.js': 'import("./series-Y.js");const d=["assets/config-X.js"]' };
    const b = await loadBundle(fetcher(map));
    expect(b.depth).toBe(1);
    expect(b.missingAtLevel0).toEqual(['Strict allowlist']);
    expectClean(run(b.chunks));
  });

  it('records failed chunk fetches instead of throwing, and honors the file cap', async () => {
    const b = await loadBundle(fetcher({ ...files, '/assets/series-Y.js': undefined }), { maxFiles: 5 });
    expect(b.failed).toContain('/assets/series-Y.js');
    expect(missingAnchors(b.chunks)).toContain('Strict allowlist');
    const capped = await loadBundle(fetcher(files), { maxFiles: 1 });
    expect(capped.capped).toEqual({ level: 0, wanted: 3, unscanned: 2 });
    expect(capped.chunks.size).toBe(1);
    expect(capped.depth).toBe(0); // a capped level 0 never fans out further
    expect((await loadBundle(fetcher(files))).capped).toBeNull();
  });

  it('reports how much of level 1 a cap left unscanned (and the byte cap counts too)', async () => {
    const html = `<script type="module" src="/assets/index-A.js"></script>`;
    const map = { ...files, '/': html, '/assets/index-A.js': 'import("./series-Y.js");import("./config-X.js");import("./z.js")' };
    const b = await loadBundle(fetcher(map), { maxFiles: 2 });
    expect(b.depth).toBe(1);
    expect(b.capped).toEqual({ level: 1, wanted: 3, unscanned: 2 });
    const bytes = await loadBundle(fetcher(map), { maxBytes: map['/assets/index-A.js'].length + 10 });
    expect(bytes.capped).toEqual({ level: 1, wanted: 3, unscanned: 3 });
  });

  it('a failed fetch never costs a later file its slot under the cap', async () => {
    const html = ['a', 'b', 'c', 'd'].map((n) => `<link rel="modulepreload" href="/assets/${n}.js">`).join('');
    const map = { '/': html, '/assets/b.js': 'b', '/assets/c.js': 'c', '/assets/d.js': 'd' };
    const b = await loadBundle(fetcher(map), { maxFiles: 3 });
    expect(b.failed).toEqual(['/assets/a.js']);
    expect([...b.chunks.keys()]).toEqual(['/assets/b.js', '/assets/c.js', '/assets/d.js']);
  });

  it('throws when the app HTML itself is unavailable', async () => {
    await expect(loadBundle(async () => null)).rejects.toThrow(/HTML unavailable/);
  });
});

// ---- writes ----------------------------------------------------------------------------------
describe('planWrites: rewrite only on a content change', () => {
  const committed = () => ({ overrides: committedOverrides(), selector: committedSelector() });

  it('an unchanged extraction writes nothing (new sources/syncedAt do not count)', () => {
    const plan = planWrites({ result: run(bundle(), committed()), committed: committed() });
    expect(plan.overrides.text).toBeNull();
    expect(plan.selector.text).toBeNull();
  });

  it('a reorder alone writes nothing', () => {
    const series = seriesChunk({ ids: [...STRICT].reverse() });
    const cfg = configChunk({ map: [...MAP].reverse(), bases: ['FXMR', 'XMR1'] });
    const plan = planWrites({ result: run(bundle(cfg, series), committed()), committed: committed() });
    expect(plan.overrides.text).toBeNull();
    expect(plan.selector.text).toBeNull();
  });

  it('a new Strict id rewrites spotSelector.json only, in HL order with the new source', () => {
    const ids = [...STRICT, tid(60)];
    const plan = planWrites({ result: run(bundle(configChunk(), seriesChunk({ ids })), committed()), committed: committed(), now: 'NOW' });
    expect(plan.overrides.text).toBeNull();
    const out = JSON.parse(plan.selector.text);
    expect(out.strict.map(([id]) => id)).toEqual(ids);
    expect(out.strict.at(-1)).toEqual([tid(60), 'TK60']);
    expect(out.source).toEqual({ strict: 'app.hyperliquid.xyz/assets/series-Y.js', hidden: 'app.hyperliquid.xyz/assets/config-X.js' });
    expect(out.syncedAt).toBe('NOW');
    expect(out.comment).toBe('c');
    expect(plan.selector.changes.join('\n')).toMatch(/strict allowlist: \+1/);
  });

  it('partial update: a failed Strict list keeps its committed value and source while hidden lists update', () => {
    const cfg = configChunk({ bases: ['XMR1', 'FXMR', 'TK99'] });
    const result = run(bundle(cfg, seriesChunk({ ids: STRICT.slice(0, 10) })), committed());
    expect(result.strict.ok).toBe(false);
    const plan = planWrites({ result, committed: committed() });
    const out = JSON.parse(plan.selector.text);
    expect(out.strict).toEqual(committedSelector().strict);
    expect(out.source.strict).toBe('app.hyperliquid.xyz/assets/series-OLD.js');
    expect(out.hiddenBases).toEqual(['XMR1', 'FXMR', 'TK99']);
  });

  it('partial update: a guarded hidden list keeps its committed value while Strict updates', () => {
    const ids = [...STRICT, tid(60)];
    const result = run(bundle(configChunk({ bases: ['TK99'] }), seriesChunk({ ids })), committed());
    expect(result.hiddenBases.error).toMatch(/replaced wholesale/);
    const out = JSON.parse(planWrites({ result, committed: committed() }).selector.text);
    expect(out.strict.map(([id]) => id)).toEqual(ids);
    expect(out.hiddenBases).toEqual(['XMR1', 'FXMR']);
    expect(out.source.hidden).toBe('app.hyperliquid.xyz/assets/config-X.js');
  });

  it('a rename-map change rewrites spotOverrides.json, keeping its comment', () => {
    const map = [...MAP, [40, 'TK40', 'NEW']];
    const plan = planWrites({ result: run(bundle(configChunk({ map })), committed()), committed: committed(), now: 'NOW' });
    expect(plan.selector.text).toBeNull();
    const out = JSON.parse(plan.overrides.text);
    expect(out).toEqual({ comment: 'c', source: 'app.hyperliquid.xyz/assets/config-X.js', syncedAt: 'NOW', entries: map });
  });

  it('every failed list writes nothing', () => {
    const result = run(new Map([['/assets/empty.js', '']]), committed());
    expect(failures(result)).toHaveLength(4);
    const plan = planWrites({ result, committed: committed() });
    expect(plan.overrides.text).toBeNull();
    expect(plan.selector.text).toBeNull();
  });
});

describe('formatters reproduce the checked-in files byte for byte', () => {
  it.each([
    ['spotOverrides.json', formatOverrides],
    ['spotSelector.json', formatSelector],
  ])('%s', (file, format) => {
    const text = readFileSync(new URL(`../../src/lib/hl/${file}`, import.meta.url), 'utf8');
    expect(format(JSON.parse(text))).toBe(text);
  });
});
