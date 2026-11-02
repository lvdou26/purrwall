import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHip4,
  loadMarkets,
  parseKvBag,
  parseQuestionInfo,
  type OutcomeMeta,
  type OutcomeTemplate,
  type OutcomeTemplateMap,
  type QuestionParseContext,
} from './markets';
import { info } from './info';
import liveTemplates from './fixtures/outcomeTemplates.2026-09-08.json';
import liveMeta from './fixtures/outcomeMeta.2026-09-08.json';

// The REST client is replaced for the whole file so the loadMarkets() case at
// the bottom can drive the real loadCatalog path with no network; every other
// test here is pure and never reaches it.
vi.mock('./info', () => ({ info: vi.fn() }));

// The recurring-name spec (docs/architecture.md → HIP-4 outcome markets):
// names are synthesized EXACTLY as "{underlying} above {targetPrice} on
// {localDate}?" / "{underlying} price range on {localDate}?" with template
// numbers verbatim, buckets "Below {a}" / "{a} to {b}" / "Above {b}". The
// date part is local-timezone formatted ("Jul 3 at 2:00 PM", HL-style), so
// assertions pin the exact FORMAT (month abbrev / 'at' / 12-hour clock)
// while leaving the timezone-dependent values free.
const HL_DATE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} at \d{1,2}:[0-5]\d [AP]M/;

describe('curated questions (metadata= trailer)', () => {
  it('extracts the category and keeps the display name', () => {
    const p = parseQuestionInfo(
      'Will X win the cup?',
      'Resolves YES if… metadata=category:sports|subCategory:football',
    );
    expect(p.category).toBe('sports');
    expect(p.display).toBe('Will X win the cup?');
    expect(p.invalidTemplate).toBeUndefined();
  });

  it('lowercases the category', () => {
    expect(parseQuestionInfo('Q', 'metadata=category:Economics').category).toBe('economics');
  });
});

describe('recurring priceBinary templates', () => {
  const desc =
    'class:priceBinary|underlying:BTC|expiry:20260703-0600|targetPrice:59285|period:1d';

  it('synthesizes "{underlying} above {target} on {date}?" with the number verbatim', () => {
    const p = parseQuestionInfo('Recurring', desc);
    expect(p.display).toMatch(new RegExp(`^BTC above 59285 on ${HL_DATE.source}\\?$`));
    expect(p.display).not.toContain('$'); // template numbers carry no formatting
    // HL's Outcomes grouping: recurring → crypto (HL has no separate
    // "Crypto (1d)" bucket)
    expect(p.category).toBe('crypto');
    expect(p.prefix).toBe('');
    expect(p.outcomeLabels).toBeUndefined();
    expect(p.invalidTemplate).toBeUndefined();
  });

  it('parses by description prefix even when the name is not "Recurring"', () => {
    expect(parseQuestionInfo('Whatever', desc).display).toMatch(/^BTC above 59285 on /);
  });

  it('falls back to the raw expiry string when it does not parse as a date', () => {
    const p = parseQuestionInfo(
      'Recurring',
      'class:priceBinary|underlying:BTC|expiry:garbage|targetPrice:1|period:1d',
    );
    expect(p.display).toBe('BTC above 1 on garbage?');
  });
});

describe('recurring priceBucket templates', () => {
  it('synthesizes the range question and Below/to/Above bucket labels', () => {
    const p = parseQuestionInfo(
      'Recurring',
      'class:priceBucket|underlying:ETH|expiry:20260703-0600|priceThresholds:2000,2500,3000|period:1d',
    );
    expect(p.display).toMatch(new RegExp(`^ETH price range on ${HL_DATE.source}\\?$`));
    expect(p.category).toBe('crypto');
    expect(p.prefix).toBe('ETH ');
    expect(p.outcomeLabels).toEqual(['Below 2000', '2000 to 2500', '2500 to 3000', 'Above 3000']);
  });

  it('a single threshold still yields Below/Above', () => {
    const p = parseQuestionInfo(
      'Recurring',
      'class:priceBucket|underlying:BTC|expiry:20260703-0600|priceThresholds:60000|period:1d',
    );
    expect(p.outcomeLabels).toEqual(['Below 60000', 'Above 60000']);
  });
});

describe('unparsable templates (HL drops these orphans)', () => {
  it.each([
    ['missing underlying', 'class:priceBinary|expiry:20260703-0600|targetPrice:1|period:1d'],
    ['missing targetPrice', 'class:priceBinary|underlying:BTC|expiry:20260703-0600|period:1d'],
    ['empty thresholds', 'class:priceBucket|underlying:BTC|expiry:20260703-0600|priceThresholds:|period:1d'],
    ['unknown class', 'class:mystery|underlying:BTC'],
    ['no template at all', 'just words'],
  ])('flags invalidTemplate: %s', (_label, desc) => {
    const p = parseQuestionInfo('Recurring', desc);
    expect(p.invalidTemplate).toBe(true);
    expect(p.display).toBe('Recurring');
  });
});

describe('uncategorized fallbacks', () => {
  it('names containing cpi/fed read as economics (HL heuristic)', () => {
    expect(parseQuestionInfo('June CPI print above 3%?', 'desc').category).toBe('economics');
    expect(parseQuestionInfo('Fed cuts in July?', 'desc').category).toBe('economics');
  });

  it('anything else stays uncategorized with the name as display', () => {
    const p = parseQuestionInfo('Will it rain?', 'desc');
    expect(p.category).toBeUndefined();
    expect(p.display).toBe('Will it rain?');
  });
});

describe('parseKvBag (HL `wg`)', () => {
  it('splits "k:v|k:v" and keeps ":" inside values (HIP-3 coin names)', () => {
    const kv = parseKvBag('perp:xyz:CL|threshold:83.196');
    expect([...kv]).toEqual([
      ['perp', 'xyz:CL'],
      ['threshold', '83.196'],
    ]);
  });

  it('"" is an empty bag; a segment without ":" voids the WHOLE bag', () => {
    expect(parseKvBag('').size).toBe(0);
    expect(parseKvBag('participant:Arsenal|junk').size).toBe(0);
  });
});

/* ── HIP-4 template markets ─────────────────────────────────────────────
 * Every fixture below is VERBATIM from the live API on 2026-09-08: the
 * templates from {"type":"outcomeTemplates"}, the instances from
 * {"type":"outcomeMeta"}. Expected strings follow HL's own rendering engine
 * (the anchors are documented above parseQuestionInfo in markets.ts).
 */
const templates: OutcomeTemplateMap = new Map(
  (liveTemplates as OutcomeTemplate[]).map((t) => [t.id, t]),
);
// {"type":"perpCategories"} entries (HL's `ak` map, the Outcomes page's
// source — NOT perpConciseAnnotations) for the HIP-3 perps the live price
// templates reference, plus two probes: flx:BTC is a live crypto row (dead
// dex, but the list is a static catalog) and xyz:FXPAIR is SYNTHETIC — the
// list mixes "FX" and "fx", so it pins the `bre` lowercasing. hyna:XRP is
// deliberately absent: it stands for a HIP-3 coin in neither HL list, which
// HL buckets nowhere.
const perpCategory = (coin: string) =>
  ({
    'xyz:CL': 'commodities',
    'xyz:XYZ100': 'indices',
    'xyz:SP500': 'indices',
    'flx:BTC': 'crypto',
    'xyz:FXPAIR': 'FX',
  })[coin];
const ctx = { templates, perpCategory };

describe('template questions', () => {
  it('policyRateDecision → "{institution} {decisionLabel} rate decision", economics', () => {
    const p = parseQuestionInfo(
      'template:policyRateDecision',
      "decisionDeadline:20261028-2359|decisionLabel:September 2026|institution:Federal Reserve's Open Market Committee|officialSource:Federal Reserve's Open Market Committee|policyMeasure:the upper bound target range for the federal funds rate|scheduledDecision:20260916-1800",
      ctx,
    );
    expect(p.display).toBe("Federal Reserve's Open Market Committee September 2026 rate decision");
    expect(p.category).toBe('economics');
    expect(p.template).toEqual({ id: 'policyRateDecision', fallback: false });
    expect(p.sideNames).toBeUndefined();
  });

  it('sportsTournamentWinner → "{season} {competition} winner", sports', () => {
    const p = parseQuestionInfo(
      'template:sportsTournamentWinner',
      'competition:English Premier League|officialSource:English Premier League|resolutionDeadline:20270605-1200|season:2026/2027|sport:football/soccer',
      ctx,
    );
    expect(p.display).toBe('2026/2027 English Premier League winner');
    expect(p.category).toBe('sports');
  });

  it('sportsContestResult → "{competition} {stage}: {participantA} v {participantB}", sports', () => {
    const p = parseQuestionInfo(
      'template:sportsContestResult',
      'competition:UEFA Champions League|contestType:Match|countedPlay:regulation time, 90 minutes plus stoppage time|officialSource:Union of European Football Associations|participantA:Fenerbahce|participantB:AS Roma|resolutionDeadline:20260911-1645|scheduledStart:20260910-1645|season:2026/27|sport:Football|stage:Matchday 1',
      ctx,
    );
    expect(p.display).toBe('UEFA Champions League Matchday 1: Fenerbahce v AS Roma');
    expect(p.category).toBe('sports');
    // description: dateTime values print in UTC with the suffix, the
    // template's "{scheduledStart} UTC" collapses to one "UTC", and the
    // metadata trailer is stripped
    expect(p.description).toContain('scheduled for Sep 10 at 4:45 PM UTC');
    expect(p.description).not.toContain('metadata=');
    expect(p.description).not.toContain('{');
  });
});

describe('template question outcomes', () => {
  it.each([
    ['template:policyRateNoChange', '', 'No change'],
    ['template:policyRateDecrease', '', 'Decrease'],
    ['template:policyRateIncrease', '', 'Increase'],
    ['template:sportsTournamentParticipant', 'participant:Arsenal', 'Arsenal'],
    ['template:sportsContestParticipant2', 'participant:FK Bodo/Glimt', 'FK Bodo/Glimt'],
    ['template:sportsContestDraw2', '', 'Draw'],
  ])('%s %j → %j', (name, desc, expected) => {
    const p = parseQuestionInfo(name, desc, ctx);
    expect(p.display).toBe(expected);
    expect(p.template?.fallback).toBe(false);
    expect(p.sideNames).toBeUndefined(); // question outcomes trade plain Yes/No
    expect(p.category).toBeUndefined(); // the parent question carries the bucket
  });

  it('renders the outcome resolution text for the tooltip', () => {
    expect(parseQuestionInfo('template:sportsContestParticipant2', 'participant:AS Roma', ctx).description).toBe(
      "This outcome resolves to Yes if AS Roma is the sole winner of the Contest under the parent question's rules, and otherwise resolves to No.",
    );
  });
});

describe('standalone (orphan) template outcomes', () => {
  it('binaryPrice: "{perp} above {threshold} at {time}?" — "at" becomes "on", digits grouped, local date', () => {
    const p = parseQuestionInfo(
      'template:binaryPrice',
      'perp:BTC|priceDescription:BTC-USDC mark|seconds:1|threshold:100000|time:20261001-0000',
      ctx,
    );
    expect(p.display).toMatch(new RegExp(`^BTC above 100,000 on ${HL_DATE.source}\\?$`));
    expect(p.category).toBe('crypto'); // main-dex perp
    expect(p.sideNames).toEqual(['Yes', 'No']); // the template's side names, prefix gone
    expect(p.description).toBe(
      'The market resolves to Yes if the BTC price is above 100,000 on Oct 1 at 12:00 AM UTC, and otherwise resolves to No. Settlement is according to the 1-second TWAP of BTC-USDC mark price ending on Oct 1 at 12:00 AM UTC. If BTC is delisted before this market settles, settlement is instead according to the BTC settlement price at delisting.',
    );
  });

  it('binaryPrice on a HIP-3 perp keeps the dex-prefixed coin, fraction verbatim, tradfi by annotation', () => {
    const p = parseQuestionInfo(
      'template:binaryPrice',
      'perp:xyz:CL|priceDescription:xyz:CL|seconds:1|threshold:83.196|time:20260929-2100',
      ctx,
    );
    expect(p.display).toMatch(new RegExp(`^xyz:CL above 83.196 on ${HL_DATE.source}\\?$`));
    expect(p.category).toBe('tradfi');
  });

  it('binaryPrice on an index perp: 28875 → 28,875, indices → tradfi; HIP-3 coins bucket by perpCategories only', () => {
    const desc = 'perp:xyz:XYZ100|priceDescription:the Pyth US100 index price|seconds:90|threshold:28875|time:20260909-2000';
    const on = (coin: string, c: QuestionParseContext = ctx) => parseQuestionInfo('template:binaryPrice', desc.replace('xyz:XYZ100', coin), c).category;
    expect(parseQuestionInfo('template:binaryPrice', desc, ctx).display).toMatch(/^xyz:XYZ100 above 28,875 on /);
    expect(on('xyz:XYZ100')).toBe('tradfi');
    expect(on('xyz:XYZ100', { templates })).toBeUndefined(); // no list at all
    // HL's real behaviour for a HIP-3 coin absent from perpCategories (hyna:XRP
    // here): `bre` returns undefined → null bucket, the row is in "All" only.
    // A dex prefix alone never implies crypto.
    expect(on('hyna:XRP')).toBeUndefined();
    expect(on('flx:BTC')).toBe('crypto');
    expect(on('xyz:FXPAIR')).toBe('tradfi'); // "FX" lowercased like `bre`
  });

  it('uInt / uDecimal drop leading zeros before grouping (HL routes the integer part through BigInt)', () => {
    const p = parseQuestionInfo(
      'template:binaryPrice',
      'perp:BTC|priceDescription:BTC-USDC mark|seconds:0090|threshold:0500|time:20261001-0000',
      ctx,
    );
    expect(p.display).toMatch(/^BTC above 500 on /);
    expect(p.description).toContain('the 90-second TWAP');
    expect(p.description).toContain('is above 500 on');
    const dec = parseQuestionInfo(
      'template:binaryPrice',
      'perp:BTC|priceDescription:BTC-USDC mark|seconds:1|threshold:0001234.50|time:20261001-0000',
      ctx,
    );
    expect(dec.display).toMatch(/^BTC above 1,234.50 on /); // fraction verbatim, integer part normalised
    expect(parseQuestionInfo('template:binaryPrice', 'perp:BTC|priceDescription:x|seconds:0|threshold:0|time:20261001-0000', ctx).display).toMatch(
      /^BTC above 0 on /,
    ); // a lone zero survives
  });

  it('priceTouch: "{perp} touches {target} by {time}" keeps "by", trailing space in a value survives', () => {
    const p = parseQuestionInfo(
      'template:priceTouch',
      'perp:HYPE|priceDescription:HYPE-USDC perp mark |seconds:1|target:100|time:20261001-0000',
      ctx,
    );
    expect(p.display).toMatch(new RegExp(`^HYPE touches 100 by ${HL_DATE.source}$`));
    expect(p.category).toBe('crypto');
    expect(p.description).toContain('touches 100 at or before Oct 1 at 12:00 AM UTC');
    expect(p.description).toContain('TWAP of HYPE-USDC perp mark  price'); // the value's trailing space, verbatim like HL
  });

  it('sportsContestWinner: match title from the bag, sides from the template\'s "{shortNameA}"/"{shortNameB}"', () => {
    const p = parseQuestionInfo(
      'template:sportsContestWinner',
      'competition:NFL|contestType:game|countedPlay:regulation time and any overtime|officialSource:ESPN|participantA:New England Patriots|participantB:Seattle Seahawks|resolutionDeadline:20260910-0620|scheduledStart:20260910-0020|season:2026|shortNameA:Patriots|shortNameB:Seahawks|sport:football|stage:Regular Season',
      ctx,
    );
    expect(p.display).toBe('NFL Regular Season: New England Patriots v Seattle Seahawks');
    expect(p.sideNames).toEqual(['Patriots', 'Seahawks']);
    expect(p.category).toBe('sports');
  });
});

describe("HL's `fj` tail: a template outside price/economics/sports still buckets as economics when its RENDERED name reads like a macro print", () => {
  // SYNTHETIC templates — no question or standalone template in the live
  // fixture lacks a category. The cpi/fed match runs over the interpolated
  // local-tz name (`Ore(e.name)`), so a keyword VALUE is enough to trip it
  // even though the template text itself carries neither word.
  const synthetic: OutcomeTemplateMap = new Map([
    ...templates,
    [
      'macroPrint',
      {
        id: 'macroPrint',
        role: 'question',
        name: '{institution} {label} print',
        description: 'Resolves per the official release.',
        keywords: [
          ['institution', 'string'],
          ['label', 'string'],
        ],
      } as OutcomeTemplate,
    ],
    [
      'oddCategory',
      {
        id: 'oddCategory',
        role: 'question',
        name: '{label} decision',
        description: 'Resolves. metadata=category:governance|subCategory:N/A',
        keywords: [['label', 'string']],
      } as OutcomeTemplate,
    ],
  ]);
  const sctx = { templates: synthetic, perpCategory };

  it('a value containing "Fed" / "CPI" → economics; the same template without one → no bucket', () => {
    const fed = parseQuestionInfo('template:macroPrint', 'institution:Fed|label:June 2026', sctx);
    expect(fed.display).toBe('Fed June 2026 print');
    expect(fed.category).toBe('economics');
    expect(parseQuestionInfo('template:macroPrint', 'institution:BLS|label:June 2026 CPI', sctx).category).toBe('economics');
    expect(parseQuestionInfo('template:macroPrint', 'institution:BLS|label:June 2026 payrolls', sctx).category).toBeUndefined();
    // an unknown metadata category takes the same tail, not the raw word
    expect(parseQuestionInfo('template:oddCategory', 'label:Fed', sctx).category).toBe('economics');
    expect(parseQuestionInfo('template:oddCategory', 'label:Board', sctx).category).toBeUndefined();
    // "Federal" does not match: the regex is word-bounded, like HL's `Ere`
    expect(parseQuestionInfo('template:macroPrint', 'institution:Federal Reserve|label:June', sctx).category).toBeUndefined();
  });

  it('a PRICE template never takes the tail — `jre` routes it to the perp rule only', () => {
    const p = parseQuestionInfo(
      'template:binaryPrice',
      'perp:FED|priceDescription:x|seconds:1|threshold:1|time:20261001-0000',
      sctx,
    );
    expect(p.display).toMatch(/^FED above 1 on /);
    expect(p.category).toBe('crypto'); // main-dex perp, name notwithstanding
  });
});

describe('templates the live list cannot explain (legible floor, never the raw id)', () => {
  it('unknown id: humanized id + the identifying values, category from the id', () => {
    const p = parseQuestionInfo(
      'template:sportsContestResultV2',
      'competition:UEFA Champions League|participantA:Fenerbahce|participantB:AS Roma|stage:Matchday 1',
      ctx,
    );
    expect(p.display).toBe('Sports contest result v2: Fenerbahce v AS Roma');
    expect(p.category).toBe('sports');
    expect(p.template).toEqual({ id: 'sportsContestResultV2', fallback: true });
    expect(p.description).toBe(
      'competition: UEFA Champions League · participantA: Fenerbahce · participantB: AS Roma · stage: Matchday 1',
    );
  });

  it('unknown price-like id names the perp and its level', () => {
    const p = parseQuestionInfo('template:priceRange', 'perp:ETH|target:3000|time:20261001-0000', ctx);
    expect(p.display).toBe('Price range: ETH 3000');
    expect(p.category).toBe('crypto');
  });

  it('known id but a keyword missing from the bag → the same floor (HL would print the raw id)', () => {
    const p = parseQuestionInfo('template:binaryPrice', 'perp:BTC|threshold:1', ctx);
    expect(p.display).toBe('Binary price: BTC 1');
    expect(p.template?.fallback).toBe(true);
  });

  it('malformed bag → id alone; no template list at all → every id takes the floor', () => {
    expect(parseQuestionInfo('template:policyRateDecision', 'not a bag', ctx).display).toBe('Policy rate decision');
    const p = parseQuestionInfo('template:sportsTournamentParticipant', 'participant:Arsenal');
    expect(p.display).toBe('Sports tournament participant: Arsenal');
    expect(p.template?.fallback).toBe(true);
  });

  it('never surfaces the raw "template:" prefix', () => {
    for (const name of ['template:x', 'template:sportsContestResult', 'template:binaryPrice']) {
      expect(parseQuestionInfo(name, '', ctx).display).not.toContain('template:');
      expect(parseQuestionInfo(name, '', {}).display).not.toContain('template:');
    }
  });
});

describe('buildHip4 over the live outcomeMeta fixture', () => {
  const meta = liveMeta as OutcomeMeta;
  const { questions, markets } = buildHip4(meta, templates, perpCategory);
  const byId = new Map(questions.map((q) => [q.id, q]));

  it('lists every question plus one synthesized row per orphan (22 + 51), and two markets per tradable outcome', () => {
    expect(questions).toHaveLength(73);
    // 160 outcomes − 21 "template fallback" − 1 "Recurring Fallback" = 138 × 2 sides
    expect(markets).toHaveLength(276);
  });

  it('shows no raw template id or prefixed side anywhere', () => {
    for (const q of questions) {
      expect(q.name).not.toContain('template');
      for (const o of q.outcomes) {
        expect(o.name).not.toContain('template');
        for (const s of o.sides) expect(s.name).not.toContain('template');
      }
    }
    for (const m of markets) {
      expect(m.display).not.toContain('template');
      expect(m.description ?? '').not.toContain('{');
    }
  });

  it("buckets rows the way HL's Outcomes page does", () => {
    const count = (cat: string | undefined) => questions.filter((q) => q.category === cat).length;
    expect(count('sports')).toBe(40); // 5 tournaments + 15 UCL matches + 20 standalone games
    expect(count('economics')).toBe(1);
    expect(count('crypto')).toBe(19); // 1 recurring bucket + 4 recurring binaries + 9 priceTouch + 5 BTC binaryPrice
    expect(count('tradfi')).toBe(13); // xyz:CL / xyz:XYZ100 / xyz:SP500 binaryPrice
    expect(count(undefined)).toBe(0);
  });

  it('a template question keeps its three named outcomes with Yes/No sides', () => {
    const ucl = byId.get(211)!;
    expect(ucl.name).toBe('UEFA Champions League Matchday 1: Fenerbahce v AS Roma');
    expect(ucl.outcomes.map((o) => o.name)).toEqual(['Fenerbahce', 'Draw', 'AS Roma']);
    expect(ucl.outcomes[1].sides.map((s) => s.name)).toEqual(['Yes', 'No']);
    expect(ucl.outcomes[0].yesCoin).toBe('#17560');
  });

  it('a standalone game becomes a single-outcome question with team-named sides', () => {
    const game = byId.get(1_000_000 + 1846)!;
    expect(game.name).toBe('NFL Regular Season: New England Patriots v Seattle Seahawks');
    expect(game.outcomes[0].sides).toEqual([
      { name: 'Patriots', coin: '#18460' },
      { name: 'Seahawks', coin: '#18461' },
    ]);
    expect(markets.find((m) => m.coin === '#18461')!.display).toBe(
      'NFL Regular Season: New England Patriots v Seattle Seahawks · Seahawks',
    );
  });

  it('standalone price markets read as binary Yes/No rows', () => {
    const m = markets.find((mk) => mk.coin === '#12100')!;
    expect(m.display).toMatch(new RegExp(`^BTC above 100,000 on ${HL_DATE.source}\\? · Yes$`));
    expect(byId.get(1_000_000 + 1210)!.outcomes[0].sides.map((s) => s.name)).toEqual(['Yes', 'No']);
  });

  it('recurring buckets keep their synthesized question and bucket labels', () => {
    const q = byId.get(227)!;
    expect(q.name).toMatch(new RegExp(`^BTC price range on ${HL_DATE.source}\\?$`));
    expect(q.outcomes.map((o) => o.name)).toEqual(['Below 76964', '76964 to 80105', 'Above 80105']);
    expect(markets.find((m) => m.coin === '#19980')!.display).toBe('BTC Below 76964 · Yes');
  });

  it('fallback outcomes never become markets', () => {
    expect(markets.some((m) => m.coin === '#12260' || m.coin === '#19970')).toBe(false);
  });
});

describe('loadMarkets: a rejected outcomeTemplates fetch is a PARTIAL HIP-4 failure', () => {
  // Without 'HIP-4' in `failed` there is no banner and no Retry while every
  // templated row wears the derived label. Same contract as a HIP-3 dex
  // rejecting: markets load, `failed` names the degraded category. Everything
  // below is mocked — the point is the real loadCatalog wiring, not the API.
  const minimal = (body: Record<string, unknown>): unknown => {
    switch (body.type) {
      case 'meta':
        return { universe: body.dex ? [] : [{ name: 'BTC' }] };
      case 'spotMeta':
        return { tokens: [], universe: [] };
      case 'perpDexs':
        return [null];
      case 'perpConciseAnnotations':
      case 'perpCategories':
        return [];
      case 'outcomeMeta':
        return liveMeta;
      default:
        throw new Error(`unexpected info type ${String(body.type)}`);
    }
  };
  const mockInfo = (templates: () => unknown) =>
    vi.mocked(info).mockImplementation(async (body: Record<string, unknown>) =>
      body.type === 'outcomeTemplates' ? templates() : minimal(body),
    );
  afterEach(() => vi.restoreAllMocks());

  it("lands 'HIP-4' in catalog.failed while every HIP-4 row still loads on the derived label", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockInfo(() => {
      throw new Error('HTTP 503');
    });
    const catalog = await loadMarkets();
    expect(catalog.failed).toEqual(['HIP-4']);
    expect(catalog.failedDexs).toEqual([]);
    expect(catalog.outcomeQuestions).toHaveLength(73); // nothing blanked
    expect(catalog.markets.filter((m) => m.kind === 'hip4')).toHaveLength(276);
    expect(catalog.outcomeQuestions.find((q) => q.id === 211)!.name).toBe(
      'Sports contest result: Fenerbahce v AS Roma', // the floor, not HL's sentence
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outcome templates failed to load'), expect.anything());
  });

  it('a healthy template list leaves `failed` empty and renders HL\'s text', async () => {
    mockInfo(() => liveTemplates);
    const catalog = await loadMarkets();
    expect(catalog.failed).toEqual([]);
    expect(catalog.outcomeQuestions.find((q) => q.id === 211)!.name).toBe(
      'UEFA Champions League Matchday 1: Fenerbahce v AS Roma',
    );
  });
});
