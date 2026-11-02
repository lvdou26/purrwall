import { info } from './info';
import type { Market } from './types';
import spotOverrides from './spotOverrides.json';
import spotSelector from './spotSelector.json';

interface PerpAsset {
  name: string;
  isDelisted?: boolean;
  maxLeverage?: number;
  onlyIsolated?: boolean;
}

interface PerpMeta {
  universe: PerpAsset[];
}

interface SpotToken {
  name: string;
  index: number;
  /** '0x' + 32 lowercase hex — the key of HL's Strict allowlist */
  tokenId: string;
}

interface SpotPair {
  name: string;
  tokens: [number, number];
  index: number;
  isCanonical: boolean;
}

interface SpotMeta {
  tokens: SpotToken[];
  universe: SpotPair[];
}

/** perpDexs returns [null, ...builderDexs] — null is the native dex. */
type PerpDexEntry = { name: string; fullName?: string } | null;

interface OutcomeSpec {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: { name: string }[];
  quoteToken: string;
  /** Deployer venue — present on template (deployer-created) markets only. */
  venue?: string;
}

interface OutcomeQuestionSpec {
  question: number;
  name: string;
  description: string;
  fallbackOutcome: number;
  namedOutcomes: number[];
  settledNamedOutcomes?: number[];
}

export interface OutcomeMeta {
  outcomes: OutcomeSpec[];
  questions: OutcomeQuestionSpec[];
}

/** A HIP-4 question grouping its outcomes — how HL's Outcome tab lists markets. */
export interface OutcomeQuestion {
  id: number;
  name: string;
  /** 'crypto' | 'economics' | 'tradfi' | 'sports' — HL's Outcomes-page
   *  grouping, drives the Outcome sub-tabs; undefined = HL's "Others" */
  category?: string;
  outcomes: Array<{
    id: number;
    name: string;
    yesCoin: string;
    /** Both tradable sides — for match markets these are team names, each its own chart */
    sides: Array<{ name: string; coin: string }>;
  }>;
}

/* ─── HIP-4 outcome naming ────────────────────────────────────────────────
 *
 * Three name formats can appear on `outcomeMeta`:
 *
 * 1. CURATED (HL-deployed, pre-template): free-text names; the description
 *    ends with "metadata=category:sports|subCategory:football".
 * 2. RECURRING price templates: name "Recurring", description
 *    "class:priceBucket|underlying:BTC|expiry:…|priceThresholds:a,b|period:1d";
 *    its outcomes are "Recurring Named Outcome" / "index:N" and get bucket
 *    labels synthesized from the thresholds.
 * 3. TEMPLATE (deployer) markets — HL's validator-voted template system
 *    (docs: for-developers/api/hip-4-deployer-actions): the name is
 *    "template:<id>", the description is the keyword bag "k:v|k:v|…" sorted
 *    by keyword, standalone side names are "template:<sideName>" (question
 *    outcomes keep plain "Yes"/"No"), and the auto-created fallback is named
 *    "template fallback" with description "other". THE DISPLAY TEXT LIVES IN
 *    THE TEMPLATE, served by `{"type":"outcomeTemplates"}`: {id, role, name,
 *    description, keywords:[[kw, hint]]} whose name/description/sideNames
 *    carry "{kw}" slots. Without this parser every such row would read
 *    "template:sportsContestResult" on both table surfaces.
 *
 * HOW HL RENDERS FORMAT 3 — read from app.hyperliquid.xyz's Vite build
 * (/assets/index-<hash>.js + modulepreload chunks; the engine sits in
 * /assets/config-Bpe33jOl.js, and the minified names below are the anchors
 * to re-grep if that chunk changes):
 *   Wk  `e.startsWith("template:") ? e.slice(9) : null`          → template id
 *   wg  "k:v|k:v" → object; ANY segment lacking ":" voids the WHOLE bag ({})
 *   tA  every template keyword must be present in the bag, else null — and
 *       a null makes HL print the raw "template:<id>" (pA → Bk)
 *   Jk/qk/Kk  template-text pre-pass, once PER dateTime KEYWORD:
 *       `text.split("{kw} UTC").join("{kw}")`, then every segment BEFORE a
 *       "{kw}" slot that ends in /(^|[^A-Za-z])(A|a)t $/ gets that "at "
 *       replaced by "on " ("On " after "At "). The formatted date already
 *       reads "Oct 1 at 8:00 AM", so "above X at {time}?" renders as
 *       "above X on Oct 1 at 8:00 AM?" — same shape as the recurring names.
 *   eA  value formatting by hint: dateTime matching /^\d{8}-\d{4}$/ → Dg
 *       (LOCAL "{Mon} {d} at {h}:{mm} {AM|PM}") in the NAME, dne + " UTC" in
 *       the description; uInt → grouped integer; uDecimal → grouped integer
 *       part + locale decimal separator + fraction VERBATIM; every other
 *       hint (string, shortString, hlPerp, date) → raw value.
 *   nA  `text.split("{kw}").join(formatted)` per keyword; text without "{"
 *       is returned untouched.
 *   aA  {name: nA(tpl.name, local), description: nA(tpl.description, utc),
 *        sideSpecs: standalone ? nA(role.standaloneOutcome.sideNames) : raw}
 *   jre/fj/Are  CATEGORY, feeding the Outcomes page filter `Le` in
 *       /assets/series-C_6mbDKw.js (all / crypto / economics / tradfi /
 *       sports; unmatched rows land in "Others"): read from the TEMPLATE
 *       description's own "metadata=category:…" trailer (dj). "price" → Are:
 *       the hlPerp keyword's coin: no dex prefix → crypto, else that perp's
 *       entry in the `{"type":"perpCategories"}` list — NOT
 *       perpConciseAnnotations: the Outcomes page (`Tt` in series-*.js)
 *       takes `perpCategories` from config's `ak` = `new Map(response)` and
 *       threads it to `bre(coin, map)` = `map.get(coin)?.toLowerCase()`
 *       (crypto → crypto; stocks / indices / commodities / fx / preipo (`oj`)
 *       → tradfi; absent or anything else → none, "All" only — a coin in
 *       neither list buckets nowhere on HL). Both lists currently carry the
 *       same coins with identical categories, so the source only matters
 *       the day they diverge; the canary alerts on that. Every other
 *       category → fj: "economics" and "sports" verbatim, else a
 *       RENDERED name matching /\b(cpi|fed)\b/i → economics, recurring →
 *       crypto. (HL has no separate "Crypto (1d)" bucket.)
 *   Number grouping follows the user's locale setting there
 *   (Intl.NumberFormat(Gp)); Purrwall fixes en-US like every other
 *   formatter in the app.
 *
 * Unknown template ids: HL prints the raw id. We never do — a raw id is the
 * bug this parser exists to fix — so `fallbackTemplateLabel` derives a
 * legible line from the bag instead (humanized id + the most identifying
 * values) and flags it. scripts/api-canary.mjs alerts the day an id, a
 * keyword hint, or a malformed bag shows up that the live template list
 * cannot explain, so the fallback is a floor, never the steady state.
 */

/** `{"type":"outcomeTemplates"}` entry. Hints per the HIP-4 deployer docs. */
export type TemplateKeywordHint =
  | 'dateTime'
  | 'date'
  | 'string'
  | 'shortString'
  | 'hlPerp'
  | 'uInt'
  | 'uDecimal';
export interface OutcomeTemplate {
  id: string;
  role:
    | 'question'
    | { standaloneOutcome: { sideNames: [string, string] } }
    | { questionOutcome: { parent: string } };
  name: string;
  description: string;
  keywords: Array<[string, TemplateKeywordHint]>;
}
export type OutcomeTemplateMap = Map<string, OutcomeTemplate>;

export interface QuestionParseContext {
  /** Live template list; missing/absent ids take the legible fallback. */
  templates?: OutcomeTemplateMap;
  /** `{"type":"perpCategories"}` entry of a HIP-3 coin (HL's `ak` map) — the
   *  crypto-vs-tradfi split for price templates on builder-dex perps.
   *  Lowercased at lookup like HL's `bre`; undefined = not in the list. */
  perpCategory?: (coin: string) => string | undefined;
}

const TEMPLATE_PREFIX = 'template:';
/** HL's tradfi category set (bundle `oj`) — also the picker's Tradfi tab. */
export const TRADFI_CATEGORIES: ReadonlySet<string> = new Set([
  'stocks',
  'indices',
  'commodities',
  'fx',
  'preipo',
]);

/** "k:v|k:v" → Map. Mirrors HL's `wg`: a segment without ":" voids the
 *  whole bag (empty Map), and "" is an empty bag. Exported for the canary's
 *  twin in scripts/api-canary.mjs to stay honest against. */
export function parseKvBag(desc: string): Map<string, string> {
  const out = new Map<string, string>();
  if (desc === '') return out;
  for (const part of desc.split('|')) {
    const i = part.indexOf(':');
    if (i === -1) return new Map();
    out.set(part.slice(0, i), part.slice(i + 1));
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "20260703-0600" (UTC) → "Jul 3 at 2:00 PM" in local time (HL's `Dg`) or
 *  "Jul 3 at 6:00 AM" in UTC (HL's `dne`); unparsable input echoes back. */
function fmtHlDate(exp: string, tz: 'local' | 'utc'): string {
  const dt = new Date(
    Date.UTC(
      Number(exp.slice(0, 4)),
      Number(exp.slice(4, 6)) - 1,
      Number(exp.slice(6, 8)),
      Number(exp.slice(9, 11)),
      Number(exp.slice(11, 13)),
    ),
  );
  if (Number.isNaN(dt.getTime())) return exp;
  const [month, day, hours, minutes] =
    tz === 'utc'
      ? [dt.getUTCMonth(), dt.getUTCDate(), dt.getUTCHours(), dt.getUTCMinutes()]
      : [dt.getMonth(), dt.getDate(), dt.getHours(), dt.getMinutes()];
  const h12 = hours % 12 || 12;
  const ampm = hours < 12 ? 'AM' : 'PM';
  return `${MONTHS[month]} ${day} at ${h12}:${String(minutes).padStart(2, '0')} ${ampm}`;
}
/** Template expiry "20260703-0600" (UTC) → local "Jul 3 at 2:00 PM", HL-style. */
const fmtExpiryLocal = (exp: string) => fmtHlDate(exp, 'local');

const HL_DATETIME_RE = /^\d{8}-\d{4}$/;
/** en-US digit grouping without Intl/BigInt.
 *  HL's `Xk` runs the integer part through BigInt before Intl, which drops
 *  leading zeros ("0090" → "90"); the strip mirrors that. */
const groupDigits = (int: string) =>
  int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** HL's `eA`: how a keyword value prints, by the template's hint. */
function fmtTemplateValue(value: string, hint: TemplateKeywordHint, tz: 'local' | 'utc'): string {
  switch (hint) {
    case 'dateTime':
      if (!HL_DATETIME_RE.test(value)) return value;
      return tz === 'local' ? fmtHlDate(value, 'local') : `${fmtHlDate(value, 'utc')} UTC`;
    case 'uInt':
      return /^\d+$/.test(value) ? groupDigits(value) : value;
    case 'uDecimal': {
      const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
      if (!m) return value;
      return m[2] === undefined ? groupDigits(m[1]) : `${groupDigits(m[1])}.${m[2]}`;
    }
    default:
      return value;
  }
}

/** HL's `qk`/`Kk`: drop "{kw} UTC" suffixes and turn a trailing "at " before
 *  the slot into "on " — the formatted date carries its own "at". */
function rewriteDateSlot(text: string, keyword: string): string {
  const slot = `{${keyword}}`;
  const segs = text.split(`${slot} UTC`).join(slot).split(slot);
  return segs
    .map((seg, i) =>
      i === segs.length - 1
        ? seg
        : seg.replace(/(^|[^A-Za-z])([Aa])t $/, (_m, pre: string, a: string) => `${pre}${a === 'A' ? 'On' : 'on'} `),
    )
    .join(slot);
}

type KeywordValue = { keyword: string; value: string; hint: TemplateKeywordHint };

/** HL's `nA`. */
function fillTemplate(text: string, values: KeywordValue[], tz: 'local' | 'utc'): string {
  if (!text.includes('{')) return text;
  let out = text;
  for (const { keyword, value, hint } of values) {
    out = out.split(`{${keyword}}`).join(fmtTemplateValue(value, hint, tz));
  }
  return out;
}

/** HL's `Jk`: the per-dateTime-keyword text pre-pass over a template. */
function prepareTemplate(tpl: OutcomeTemplate): { name: string; description: string; sideNames?: [string, string] } {
  const rewrite = (text: string) =>
    tpl.keywords.reduce((t, [kw, hint]) => (hint === 'dateTime' ? rewriteDateSlot(t, kw) : t), text);
  const standalone = typeof tpl.role === 'object' && 'standaloneOutcome' in tpl.role ? tpl.role.standaloneOutcome : undefined;
  return {
    name: rewrite(tpl.name),
    description: rewrite(tpl.description),
    sideNames: standalone ? [rewrite(standalone.sideNames[0]), rewrite(standalone.sideNames[1])] : undefined,
  };
}

/** HL's `tA`: null unless the bag holds every keyword the template declares. */
function collectKeywordValues(tpl: OutcomeTemplate, kv: Map<string, string>): KeywordValue[] | null {
  const out: KeywordValue[] = [];
  for (const [keyword, hint] of tpl.keywords) {
    const value = kv.get(keyword);
    if (value === undefined) return null;
    out.push({ keyword, value, hint });
  }
  return out;
}

/** HL's `iA`: the coin behind the template's single hlPerp keyword. */
function templatePerp(tpl: OutcomeTemplate, kv: Map<string, string>): string | undefined {
  const perpKeys = tpl.keywords.filter(([, hint]) => hint === 'hlPerp');
  return perpKeys.length === 1 ? kv.get(perpKeys[0][0]) : undefined;
}

/** HL's `Are`: a price template's bucket is decided by the perp it prices —
 *  main-dex → crypto, HIP-3 → its perpCategories entry via `bre` (which
 *  lowercases: the live list carries both "FX" and "fx"). */
function priceCategory(perp: string | undefined, ctx: QuestionParseContext): string | undefined {
  if (perp === undefined) return undefined;
  if (!perp.includes(':')) return 'crypto';
  const cat = ctx.perpCategory?.(perp)?.toLowerCase();
  if (cat === 'crypto') return 'crypto';
  return cat !== undefined && TRADFI_CATEGORIES.has(cat) ? 'tradfi' : undefined;
}

const MACRO_NAME_RE = /\b(?:cpi|fed)\b/i;

/** HL's `jre`: the TEMPLATE description's metadata trailer decides — "price"
 *  → `Are` (the perp rule, and ONLY that); anything else → `fj`, whose tail
 *  still buckets a template with no / an unknown category as economics when
 *  the RENDERED name (`Ore(e.name)`, local-tz) reads like a macro print. */
function templateCategory(
  tpl: OutcomeTemplate,
  perp: string | undefined,
  renderedName: string,
  ctx: QuestionParseContext,
): string | undefined {
  const i = tpl.description.indexOf('metadata=');
  const meta = i === -1 ? new Map<string, string>() : parseKvBag(tpl.description.slice(i + 9).trim());
  const cat = meta.get('category')?.toLowerCase();
  if (cat === 'price') return priceCategory(perp, ctx);
  if (cat === 'economics' || cat === 'sports') return cat;
  return MACRO_NAME_RE.test(renderedName) ? 'economics' : undefined;
}

/** "sportsContestResult" → "Sports contest result". */
function humanizeTemplateId(id: string): string {
  const words = id
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The legibility floor for a template the live list cannot explain: the
 * humanized id plus whichever bag values identify the market (contest
 * participants, a participant, the priced perp and its level, the
 * competition or institution). Deliberately NOT a guess at HL's sentence —
 * the id is shown so a reader knows this is the derived form.
 */
function fallbackTemplateLabel(id: string, kv: Map<string, string>): string {
  const a = kv.get('participantA');
  const b = kv.get('participantB');
  const perp = kv.get('perp');
  const detail =
    (a && b ? `${a} v ${b}` : undefined) ??
    kv.get('participant') ??
    (perp ? [perp, kv.get('threshold') ?? kv.get('target')].filter(Boolean).join(' ') : undefined) ??
    kv.get('competition') ??
    kv.get('institution') ??
    kv.get('event');
  const title = humanizeTemplateId(id);
  return detail ? `${title}: ${detail}` : title;
}

/** Category for an unexplained template, from its id alone (the only signal). */
function fallbackTemplateCategory(id: string, kv: Map<string, string>, ctx: QuestionParseContext): string | undefined {
  if (/sport/i.test(id)) return 'sports';
  if (/policy|rate|econom|cpi|fed|inflation|gdp|payroll/i.test(id)) return 'economics';
  if (/price|touch|scalar/i.test(id)) return priceCategory(kv.get('perp'), ctx);
  return undefined;
}

/** "template:{shortNameA}" → the bag's shortNameA; "template:Yes" → "Yes". */
function resolveRawSideName(raw: string, kv: Map<string, string>): string {
  const s = raw.startsWith(TEMPLATE_PREFIX) ? raw.slice(TEMPLATE_PREFIX.length) : raw;
  return s.replace(/\{([^{}]+)\}/g, (m, k: string) => kv.get(k) ?? m);
}

export interface ParsedQuestionInfo {
  category?: string;
  display: string;
  prefix: string;
  outcomeLabels?: string[];
  invalidTemplate?: boolean;
  /** Rendered resolution text for Market.description (template markets). */
  description?: string;
  /** Standalone template markets fix their side names ("Patriots"/"Seahawks"). */
  sideNames?: [string, string];
  /** Set for "template:<id>" names; `fallback` = the derived floor, not HL's text. */
  template?: { id: string; fallback: boolean };
}

function parseTemplateInfo(name: string, desc: string, ctx: QuestionParseContext): ParsedQuestionInfo {
  const id = name.slice(TEMPLATE_PREFIX.length);
  const kv = parseKvBag(desc);
  const tpl = ctx.templates?.get(id);
  const values = tpl ? collectKeywordValues(tpl, kv) : null;
  if (!tpl || !values) {
    const description = [...kv].map(([k, v]) => `${k}: ${v}`).join(' · ');
    return {
      category: fallbackTemplateCategory(id, kv, ctx),
      display: fallbackTemplateLabel(id, kv),
      prefix: '',
      description: description || undefined,
      template: { id, fallback: true },
    };
  }
  const prepared = prepareTemplate(tpl);
  const description = stripMetadata(fillTemplate(prepared.description, values, 'utc'));
  const display = fillTemplate(prepared.name, values, 'local');
  return {
    category: templateCategory(tpl, templatePerp(tpl, kv), display, ctx),
    display,
    prefix: '',
    description: description || undefined,
    sideNames: prepared.sideNames && [
      fillTemplate(prepared.sideNames[0], values, 'local'),
      fillTemplate(prepared.sideNames[1], values, 'local'),
    ],
    template: { id, fallback: false },
  };
}

/**
 * Recurring names are synthesized to match HL's bundle exactly (`Pk`/`Ek`):
 * priceBinary → "{underlying} above {targetPrice} on {date}?" and priceBucket
 * → "{underlying} price range on {date}?" with buckets "Below {a}" /
 * "{a} to {b}" / "Above {b}" — numbers VERBATIM from the template (no $ or
 * thousands separators). Orphan Recurring outcomes with unparsable templates
 * are dropped entirely, as HL does. Template names take the format-3 path
 * documented above.
 */
// exported for tests — app code goes through loadHip4
export function parseQuestionInfo(
  name: string,
  desc: string,
  ctx: QuestionParseContext = {},
): ParsedQuestionInfo {
  if (name.startsWith(TEMPLATE_PREFIX)) return parseTemplateInfo(name, desc, ctx);
  const metaMatch = desc.match(/metadata=category:([A-Za-z0-9_-]+)/);
  if (metaMatch) return { category: metaMatch[1].toLowerCase(), display: name, prefix: '' };
  if (name === 'Recurring' || desc.startsWith('class:')) {
    const kv = parseKvBag(desc);
    const cls = kv.get('class');
    const underlying = kv.get('underlying');
    const expiry = kv.get('expiry');
    if (cls === 'priceBinary' && underlying && expiry && kv.get('targetPrice')) {
      const target = kv.get('targetPrice')!;
      return {
        category: 'crypto',
        display: `${underlying} above ${target} on ${fmtExpiryLocal(expiry)}?`,
        prefix: '',
      };
    }
    const thresholds = (kv.get('priceThresholds') ?? '').split(',').filter(Boolean);
    if (cls === 'priceBucket' && underlying && expiry && thresholds.length > 0) {
      const outcomeLabels: string[] = [`Below ${thresholds[0]}`];
      for (let i = 0; i < thresholds.length - 1; i++) {
        outcomeLabels.push(`${thresholds[i]} to ${thresholds[i + 1]}`);
      }
      outcomeLabels.push(`Above ${thresholds[thresholds.length - 1]}`);
      return {
        category: 'crypto',
        display: `${underlying} price range on ${fmtExpiryLocal(expiry)}?`,
        prefix: `${underlying} `,
        outcomeLabels,
      };
    }
    return { display: name, prefix: '', invalidTemplate: true };
  }
  // HL fallback (`fj`): uncategorized questions named like macro prints are economics
  if (MACRO_NAME_RE.test(name)) return { category: 'economics', display: name, prefix: '' };
  return { display: name, prefix: '' };
}

/** HL strips the trailing "metadata=…" blob before showing any description. */
function stripMetadata(desc: string): string {
  const i = desc.indexOf('metadata=');
  return i === -1 ? desc : desc.slice(0, i).trimEnd();
}

async function loadPerps(): Promise<Market[]> {
  const meta = await info<PerpMeta>({ type: 'meta' });
  return meta.universe
    .filter((a) => !a.isDelisted)
    .map((a) => ({
      coin: a.name,
      display: `${a.name}-USDC`,
      kind: 'perp' as const,
      maxLeverage: a.maxLeverage,
      preLaunch: a.onlyIsolated === true,
    }));
}

/**
 * HL's UI renames some spot tokens (Unit-bridged assets etc.) via a map
 * hardcoded in its bundle — there is NO API for it. spotOverrides.json is
 * that map extracted verbatim; the twice-daily canary re-scrapes the bundle
 * and rewrites the file (scripts/sync-spot-overrides.mjs), so new listings
 * like UANSEM→ANSEM arrive without code changes. Keyed by token index with
 * the API (l1) name double-checked at runtime, so an index reshuffle degrades
 * to the raw name instead of mislabeling. Tokens ABSENT from HL's map (UDOGE,
 * UMEGA…) are correct as raw names — HL's own UI shows them raw too.
 */
const SPOT_DISPLAY_OVERRIDES = spotOverrides.entries as Array<[number, string, string]>;

/*
 * HL's spot SELECTOR lists, hardcoded in its bundle like the rename map above
 * and synced the same way (spotSelector.json, same script):
 * - `strict`: the picker's Strict allowlist — BASE-token tokenIds (HL's row
 *   field `spotId`), so every pair on a listed base passes Strict. No volume
 *   rule approximates it: "24h volume ≥ $100k" agrees with HL on fewer than
 *   half the pairs and flickers with volume.
 * - `hiddenBases` / `hiddenQuotes`: pairs HL hides from every selector
 *   surface, compared upper-cased against the DISPLAYED token name, as HL's
 *   own check does.
 */
const STRICT_TOKEN_IDS: ReadonlySet<string> = new Set(
  (spotSelector.strict as Array<[string, string | null]>).map(([id]) => id),
);
const HIDDEN_SPOT_BASES: ReadonlySet<string> = new Set(spotSelector.hiddenBases.map((t) => t.toUpperCase()));
const HIDDEN_SPOT_QUOTES: ReadonlySet<string> = new Set(spotSelector.hiddenQuotes.map((t) => t.toUpperCase()));

/**
 * HL's Strict rule for one market. Only spot is ever filtered (HL's Strict
 * on the perp tabs hides delisted HIP-3 assets, which this catalog never
 * holds). Fails OPEN on an empty allowlist: a broken sync degrades Strict to
 * All, never to an empty Spot tab.
 */
export function passesStrict(m: Market): boolean {
  if (m.kind !== 'spot' || STRICT_TOKEN_IDS.size === 0) return true;
  return m.spotTokenId !== undefined && STRICT_TOKEN_IDS.has(m.spotTokenId);
}

/**
 * Pure: spotMeta → spot Markets. Also returns every universe pair name
 * (hidden ones included) — the baseline the live-catalog drift check compares
 * the stats poll against, so a deliberately hidden pair never reads as new.
 * spotMetaAndAssetCtxs[0] is byte-identical to a spotMeta response, so this
 * runs on either.
 */
export function buildSpot(meta: SpotMeta): { markets: Market[]; seen: string[] } {
  const tokenByIndex = new Map(meta.tokens.map((t) => [t.index, t]));
  const overrideByIndex = new Map(
    SPOT_DISPLAY_OVERRIDES.map(([idx, l1, display]) => [idx, { l1, display }]),
  );
  const displayOf = (tok: SpotToken | undefined): string => {
    if (!tok) return '?';
    const o = overrideByIndex.get(tok.index);
    return o && o.l1 === tok.name ? o.display : tok.name;
  };
  const markets: Market[] = [];
  const seen: string[] = [];
  for (const pair of meta.universe) {
    seen.push(pair.name);
    const base = tokenByIndex.get(pair.tokens[0]);
    const quote = tokenByIndex.get(pair.tokens[1]);
    if (base && HIDDEN_SPOT_BASES.has(displayOf(base).toUpperCase())) continue;
    if (quote && HIDDEN_SPOT_QUOTES.has(displayOf(quote).toUpperCase())) continue;
    markets.push({
      coin: pair.name,
      display: `${displayOf(base)}/${displayOf(quote)}`,
      kind: 'spot',
      // keep the raw API name searchable ("ubtc" still finds BTC/USDC)
      keywords: base && displayOf(base) !== base.name ? [base.name.toLowerCase()] : undefined,
      // balances key on the RAW base token name — the watch Balances tab
      // joins through this to price a holding via the pair's stats
      spotBase: base?.name,
      spotTokenId: base?.tokenId,
    });
  }
  return { markets, seen };
}

async function loadSpot(): Promise<{ markets: Market[]; seen: string[] }> {
  return buildSpot(await info<SpotMeta>({ type: 'spotMeta' }));
}

interface ConciseAnnotation {
  category?: string;
  displayName?: string;
  keywords?: string[];
}

/** [coin, {category, displayName?, keywords?}] — categories drive the Tradfi
 *  tab, displayName the HIP-3 label, keywords feed search ("claude" →
 *  vntl:ANTHROPIC). Consumed by loadHip3 only; created in loadCatalog next to
 *  its sibling below. A failure falls back to the last good list (none at
 *  boot). */
type Annotations = [string, ConciseAnnotation][];
/*
 * The three catalog side-lists (annotations, perpCategories, outcome
 * templates) degrade SILENTLY — a failure yields an empty list and, apart from
 * a boot-time templates failure (loadOutcomeTemplates), no entry in `failed`.
 * The catalog refreshes live, so a failed refresh would strip a clean catalog
 * (no Tradfi tab, raw HIP-3 names, dead keyword search) until the next good
 * load, and mergeCatalog cannot tell. So each one falls back to its LAST GOOD
 * response; only a boot-time failure degrades.
 */
let lastAnnotations: Annotations = [];
const loadAnnotations = (): Promise<Annotations> =>
  info<Annotations>({ type: 'perpConciseAnnotations' })
    .then((a) => (Array.isArray(a) ? (lastAnnotations = a) : lastAnnotations))
    .catch(() => lastAnnotations);

/** [coin, category] — the list HL's Outcomes page buckets HIP-4 PRICE
 *  templates by (config `ak` = `new Map(response)`, consumed through `bre`),
 *  distinct from perpConciseAnnotations even though the two currently carry
 *  identical categories (the canary alerts the day they diverge). Consumed by
 *  loadHip4 only; a failure degrades to "no bucket" for HIP-3-perp price
 *  templates — HL's own rendering for a coin absent from the list. */
type PerpCategories = [string, string][];
let lastPerpCategories: PerpCategories = [];
const loadPerpCategories = (): Promise<PerpCategories> =>
  info<PerpCategories>({ type: 'perpCategories' })
    .then((c) => (Array.isArray(c) ? (lastPerpCategories = c) : lastPerpCategories))
    .catch(() => lastPerpCategories);

async function loadHip3(
  annotationsP: Promise<Annotations>,
): Promise<{ markets: Market[]; failedDexs: string[] }> {
  const [dexs, annotations] = await Promise.all([
    info<PerpDexEntry[]>({ type: 'perpDexs' }),
    annotationsP,
  ]);
  const annByCoin = new Map(annotations.map(([coin, ann]) => [coin, ann]));
  const builders = dexs.filter((d): d is NonNullable<PerpDexEntry> => d !== null);
  const metas = await Promise.allSettled(
    builders.map((d) => info<PerpMeta>({ type: 'meta', dex: d.name })),
  );
  const markets: Market[] = [];
  const failedDexs: string[] = [];
  metas.forEach((result, idx) => {
    if (result.status !== 'fulfilled') {
      // A rejected per-dex meta must reach the catalog's `failed` list:
      // `failed` is also what tells resolveMarket a coin is MISSING rather
      // than DELISTED, so without it every saved cell from that dex would
      // render blank with no banner and no retry.
      // A dead dex does NOT take this path — it resolves with an all-delisted
      // universe — so a rejection here is a genuine API failure, which is what
      // makes it honest to surface as a retryable banner rather than
      // permanent chrome.
      failedDexs.push(builders[idx].name);
      console.warn(
        `[purrwall] HIP-3 dex "${builders[idx].name}" metadata failed to load:`,
        result.reason,
      );
      return;
    }
    const dex = builders[idx].name;
    for (const asset of result.value.universe) {
      if (asset.isDelisted) continue;
      // HIP-3 asset names arrive dex-prefixed ("xyz:TSLA"); HL's UI shows the
      // base name with a dex pill, e.g. "TSLA-USDC [xyz]"
      const ann = annByCoin.get(asset.name);
      // HL only accepts sane displayName overrides (same validation as its bundle)
      const validOverride =
        ann?.displayName &&
        /^[a-zA-Z0-9][\x20-\x7E]*$/.test(ann.displayName) &&
        !ann.displayName.includes(':');
      const base = validOverride ? ann.displayName! : asset.name.slice(asset.name.indexOf(':') + 1);
      markets.push({
        coin: asset.name,
        display: `${base}-USDC`,
        kind: 'hip3',
        dex,
        maxLeverage: asset.maxLeverage,
        category: ann?.category?.toLowerCase(),
        keywords: ann?.keywords,
      });
    }
  });
  return { markets, failedDexs };
}

/** The live template list as a map. A failed fetch never blanks HIP-4 (every
 *  template row still renders through the legible fallback), but at boot it
 *  IS a partial catalog failure that has to reach `catalog.failed`: that
 *  raises the banner, and a later refresh (or the banner's Retry) knows the
 *  labels are worth replacing. Same shape as a HIP-3 dex rejecting — the
 *  markets load, `failed` says the category is degraded. */
// last good list — see lastAnnotations (a failure after one good load keeps
// it: rows on a template id it lacks fall back to the derived label, nothing
// else changes, and `failed` stays clean)
let lastTemplates: OutcomeTemplateMap | null = null;
async function loadOutcomeTemplates(): Promise<{ templates: OutcomeTemplateMap; failed: boolean }> {
  try {
    const list = await info<OutcomeTemplate[]>({ type: 'outcomeTemplates' });
    if (!Array.isArray(list)) throw new Error('outcomeTemplates is not an array');
    lastTemplates = new Map(list.filter((t) => typeof t?.id === 'string').map((t) => [t.id, t]));
    return { templates: lastTemplates, failed: false };
  } catch (err) {
    if (lastTemplates) return { templates: lastTemplates, failed: false };
    console.warn('[purrwall] HIP-4 outcome templates failed to load — template rows use derived labels:', err);
    return { templates: new Map(), failed: true };
  }
}

/** One outcome's resolved presentation: the row label, both side names
 *  (template prefixes gone, "{shortNameA}" filled) and the tooltip text. */
interface ResolvedOutcome {
  label: string;
  prefix: string;
  sides: string[];
  description?: string;
}

function resolveOutcome(o: OutcomeSpec, ctx: QuestionParseContext, question?: ParsedQuestionInfo): ResolvedOutcome {
  // Recurring-template outcomes are named "Recurring Named Outcome" with
  // description "index:N" — their real labels (price buckets) live in the
  // question template.
  const idxMatch = o.description.match(/^index:(\d+)$/);
  const bucket = idxMatch ? question?.outcomeLabels?.[Number(idxMatch[1])] : undefined;
  if (bucket !== undefined) {
    return {
      label: bucket,
      prefix: question?.prefix ?? '',
      sides: o.sideSpecs.map((s) => s.name),
      description: stripMetadata(o.description) || undefined,
    };
  }
  const parsed = parseQuestionInfo(o.name, o.description, ctx);
  const kv = parsed.template ? parseKvBag(o.description) : new Map<string, string>();
  return {
    label: parsed.display,
    prefix: question?.prefix ?? '',
    sides: parsed.sideNames ?? o.sideSpecs.map((s) => resolveRawSideName(s.name, kv)),
    description: parsed.description ?? (stripMetadata(o.description) || undefined),
  };
}

/**
 * Pure: outcomeMeta + templates → the Outcome-tab questions and one Market
 * per tradable side. Exported so the vitest suite can pin the whole live
 * surface (fixtures verbatim from the API), not only single names.
 */
export function buildHip4(
  meta: OutcomeMeta,
  templates: OutcomeTemplateMap,
  perpCategory?: (coin: string) => string | undefined,
): { markets: Market[]; questions: OutcomeQuestion[] } {
  const ctx: QuestionParseContext = { templates, perpCategory };
  const outcomeById = new Map(meta.outcomes.map((o) => [o.outcome, o]));

  const resolvedByOutcome = new Map<number, ResolvedOutcome>();
  const questions: OutcomeQuestion[] = meta.questions.map((q) => {
    const parsed = parseQuestionInfo(q.name, q.description, ctx);
    const outcomes = q.namedOutcomes
      .map((id) => outcomeById.get(id))
      .filter((o): o is OutcomeSpec => o !== undefined)
      .map((o) => {
        const resolved = resolveOutcome(o, ctx, parsed);
        resolvedByOutcome.set(o.outcome, resolved);
        return {
          id: o.outcome,
          name: resolved.label,
          yesCoin: `#${o.outcome * 10}`,
          sides: resolved.sides.map((name, i) => ({ name, coin: `#${o.outcome * 10 + i}` })),
        };
      });
    return { id: q.question, name: parsed.display, category: parsed.category, outcomes };
  });

  // Outcomes referenced by NO question also exist on HL: standalone
  // template markets (priceTouch / binaryPrice / sportsContestWinner — the
  // last with team-named sides) and outcome-level recurring price binaries
  // ("BTC above 78535 on …?"). Synthesize a single-outcome question row for
  // each so the Outcome tab is complete.
  const covered = new Set<number>();
  for (const q of meta.questions) {
    q.namedOutcomes.forEach((id) => covered.add(id));
    covered.add(q.fallbackOutcome);
    (q.settledNamedOutcomes ?? []).forEach((id) => covered.add(id));
  }
  const dropped = new Set<number>();
  for (const o of meta.outcomes) {
    if (covered.has(o.outcome) || o.name === 'Fallback') continue;
    const parsed = parseQuestionInfo(o.name, o.description, ctx);
    // HL drops orphan Recurring outcomes whose template fails to parse
    if (parsed.invalidTemplate && o.name === 'Recurring') {
      dropped.add(o.outcome);
      continue;
    }
    const resolved = resolveOutcome(o, ctx);
    resolvedByOutcome.set(o.outcome, resolved);
    questions.push({
      // synthetic id, well clear of real question ids
      id: 1_000_000 + o.outcome,
      name: resolved.label,
      category: parsed.category,
      outcomes: [
        {
          id: o.outcome,
          name: resolved.label,
          yesCoin: `#${o.outcome * 10}`,
          sides: resolved.sides.map((name, i) => ({ name, coin: `#${o.outcome * 10 + i}` })),
        },
      ],
    });
  }

  // Fallback outcomes ("Fallback" / "Recurring Fallback" / "template
  // fallback") exist as tokens but never get rows or trade pages on HL
  const fallbackIds = new Set(meta.questions.map((q) => q.fallbackOutcome));

  const markets: Market[] = [];
  for (const o of meta.outcomes) {
    if (o.name === 'Fallback' || fallbackIds.has(o.outcome) || dropped.has(o.outcome)) continue;
    const resolved = resolvedByOutcome.get(o.outcome);
    const label = resolved ? `${resolved.prefix}${resolved.label}` : o.name;
    o.sideSpecs.forEach((side, sideIdx) => {
      markets.push({
        // HIP-4 coin encoding: #(10 * outcome + side), side 0 = Yes, 1 = No
        coin: `#${o.outcome * 10 + sideIdx}`,
        display: `${label} · ${resolved?.sides[sideIdx] ?? side.name}`,
        kind: 'hip4',
        description: resolved ? resolved.description : stripMetadata(o.description),
      });
    });
  }
  return { markets, questions };
}

/** Every side coin of every outcome in outcomeMeta — fallback and dropped
 *  outcomes INCLUDED. spotMetaAndAssetCtxs carries a ctx for exactly this
 *  set, so it is the drift baseline for the Outcome tab; the catalog's own
 *  hip4 markets omit the fallbacks. */
function outcomeSideCoins(meta: OutcomeMeta): string[] {
  return meta.outcomes.flatMap((o) => o.sideSpecs.map((_, i) => `#${o.outcome * 10 + i}`));
}

interface OutcomesLoad {
  markets: Market[];
  questions: OutcomeQuestion[];
  seen: string[];
  templatesFailed: boolean;
}

async function loadHip4(perpCategoriesP: Promise<PerpCategories>): Promise<OutcomesLoad> {
  const [meta, { templates, failed: templatesFailed }, perpCategories] = await Promise.all([
    info<OutcomeMeta>({ type: 'outcomeMeta' }),
    loadOutcomeTemplates(),
    perpCategoriesP,
  ]);
  // HL's `ak`: the response is `new Map()`-able as is; `bre` lowercases at
  // lookup (priceCategory does the same), so the map keeps raw values
  const categoryByCoin = new Map(perpCategories.filter((e) => Array.isArray(e) && typeof e[0] === 'string'));
  return {
    ...buildHip4(meta, templates, (coin) => categoryByCoin.get(coin)),
    seen: outcomeSideCoins(meta),
    templatesFailed,
  };
}

/**
 * The Outcome tab alone (outcomeMeta + outcomeTemplates + perpCategories, 3
 * requests). HIP-4 churns far faster than every other class — ~200 outcomes a
 * day, a 15-minute rolling BTC binary among them — so the live catalog
 * refreshes it on its own path instead of re-running the full ~17-request
 * load. Rejects when outcomeMeta does; a templates failure resolves with
 * `templatesFailed` (patchOutcomes turns it into 'HIP-4').
 */
export function loadOutcomes(): Promise<OutcomesLoad> {
  return loadHip4(loadPerpCategories());
}

export interface MarketCatalog {
  markets: Market[];
  /** Human-readable names of categories whose metadata failed to load. Drives
   *  BOTH the warning banner and — the load-bearing half — resolveMarket's
   *  decision to synthesize a fallback Market instead of treating a saved coin
   *  as delisted. A partially-failed category belongs in here for that second
   *  reason even when most of its markets did load. */
  failed: string[];
  /** Which HIP-3 builder dexs rejected, when 'HIP-3' is in `failed` because of
   *  a PARTIAL failure. Diagnostic detail — the UI reports the category, not
   *  the dex, so one dead builder cannot spell its name across the wall. */
  failedDexs: string[];
  /** HIP-4 questions for the picker's Outcome tab. */
  outcomeQuestions: OutcomeQuestion[];
  /** Live-catalog drift baselines (hl/catalogSync.ts): every spot universe
   *  pair name spotMeta listed, hidden pairs included … */
  spotSeen: ReadonlySet<string>;
  /** … and every outcome side coin outcomeMeta listed, fallbacks included.
   *  Without them a deliberately excluded id would read as a new listing on
   *  every stats poll. */
  outcomeSeen: ReadonlySet<string>;
}

/** The real work; loadMarkets() below wraps it in the in-flight guard. */
async function loadCatalog(): Promise<MarketCatalog> {
  const annotationsP = loadAnnotations();
  const perpCategoriesP = loadPerpCategories();
  const [hip4Result, hip3Result, perpResult, spotResult] = await Promise.allSettled([
    loadHip4(perpCategoriesP),
    loadHip3(annotationsP),
    loadPerps(),
    loadSpot(),
  ]);
  const markets: Market[] = [];
  const failed: string[] = [];
  const failedDexs: string[] = [];
  let outcomeQuestions: OutcomeQuestion[] = [];
  let spotSeen: string[] = [];
  let outcomeSeen: string[] = [];
  if (perpResult.status === 'fulfilled') {
    markets.push(...perpResult.value);
  } else {
    failed.push('Perps');
    console.warn('[purrwall] Perps metadata failed to load:', perpResult.reason);
  }
  if (spotResult.status === 'fulfilled') {
    markets.push(...spotResult.value.markets);
    spotSeen = spotResult.value.seen;
  } else {
    failed.push('Spot');
    console.warn('[purrwall] Spot metadata failed to load:', spotResult.reason);
  }
  // Two categories can fail PARTLY. HIP-3 fans out one meta per builder dex;
  // HIP-4 pairs outcomeMeta with the outcomeTemplates list, and a rejected
  // list leaves every templated row on the derived label. Either shape has
  // to reach `failed`: for HIP-3 because saved cells from the missing dex
  // would otherwise resolve to null and blank, for HIP-4 so a later refresh
  // (or the banner's Retry) knows the labels are worth replacing.
  if (hip3Result.status === 'fulfilled') {
    markets.push(...hip3Result.value.markets);
    if (hip3Result.value.failedDexs.length > 0) {
      failedDexs.push(...hip3Result.value.failedDexs);
      failed.push('HIP-3');
    }
  } else {
    failed.push('HIP-3');
    console.warn('[purrwall] HIP-3 metadata failed to load:', hip3Result.reason);
  }
  if (hip4Result.status === 'fulfilled') {
    markets.push(...hip4Result.value.markets);
    outcomeQuestions = hip4Result.value.questions;
    outcomeSeen = hip4Result.value.seen;
    if (hip4Result.value.templatesFailed) failed.push('HIP-4');
  } else {
    failed.push('HIP-4');
    console.warn('[purrwall] HIP-4 metadata failed to load:', hip4Result.reason);
  }
  if (markets.length === 0) {
    throw new Error('No market metadata could be loaded from the Hyperliquid API');
  }
  return {
    markets,
    failed,
    failedDexs,
    outcomeQuestions,
    spotSeen: new Set(spotSeen),
    outcomeSeen: new Set(outcomeSeen),
  };
}

let inflightCatalog: Promise<MarketCatalog> | null = null;

/**
 * Enumerate every live Hyperliquid market. Categories load in parallel and
 * fail independently — one broken category never blanks the whole picker,
 * but failures are reported so the UI can say so instead of silently
 * shrinking the universe.
 *
 * Concurrent callers share one load. Without this the partial-failure banner's
 * Retry button — which gives no feedback and never unmounts — would fire a
 * fresh ~17-request fan-out on EVERY click, straight at the 1200 weight/min
 * budget, while the previous attempt is still in flight (App's retry effect
 * cancels its state updates, not its request). Same shape as getSparklines
 * and loadMarketStats. A rejection is shared too, deliberately: the caller's
 * own backoff loop starts the next real attempt once this one has settled and
 * the slot is clear.
 *
 * A second load is never assigned raw — see mergeCatalog.
 */
export function loadMarkets(): Promise<MarketCatalog> {
  if (inflightCatalog) return inflightCatalog;
  inflightCatalog = loadCatalog().finally(() => {
    inflightCatalog = null;
  });
  return inflightCatalog;
}

/** A catalog with its Outcome slice replaced by a fresh loadOutcomes() —
 *  always applied through mergeCatalog, which keeps the old slice when the
 *  new one came back with derived labels only. */
export function patchOutcomes(prev: MarketCatalog, o: OutcomesLoad): MarketCatalog {
  const failed = prev.failed.filter((f) => f !== 'HIP-4');
  if (o.templatesFailed) failed.push('HIP-4');
  return {
    ...prev,
    markets: [...prev.markets.filter((m) => m.kind !== 'hip4'), ...o.markets],
    failed,
    outcomeQuestions: o.questions,
    outcomeSeen: new Set(o.seen),
  };
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b ||
  (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));

/** Field-by-field over the UNION of both objects' keys (never
 *  JSON.stringify: key order differs between code paths), arrays
 *  element-wise — so a Market field added later can never be silently
 *  ignored by the reuse below. */
export function sameMarket(a: Market, b: Market): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Market>;
  for (const k of keys) if (!sameValue(a[k], b[k])) return false;
  return true;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Apply a newer catalog load on top of the current one. EVERY catalog write
 * after the first goes through here (the live refresh and the banner's Retry
 * alike), for two reasons:
 *
 * 1. IDENTITY. Each wall cell's Market is the catalog's own object, and a new
 *    object for an unchanged coin re-runs things keyed on it — without this,
 *    a Retry would re-run every ChartCell's data effect (viewport reset,
 *    dimmed price, a gap fetch per cell and per formula leg: ~1,900 weight on
 *    a 24-cell 4-leg wall), rebuild every formula Market and re-sort an
 *    open picker. So an unchanged Market keeps its OLD object, an unchanged
 *    list keeps its old array, and a load that changed nothing returns `prev`
 *    itself (React skips the render; no [catalog] effect re-runs).
 * 2. NEVER DEGRADE. A slice the new load failed to fetch keeps the previous
 *    slice (a transient 429 on one dex must not blank its cells, raise the
 *    banner, or drop it from the watch fan-out), and `failed` may shrink —
 *    a refresh healing a boot-time partial failure clears the banner by
 *    itself — but never grow.
 */
export function mergeCatalog(prev: MarketCatalog, next: MarketCatalog): MarketCatalog {
  const nextFailed = (slice: string) => next.failed.includes(slice);
  const ofKind = (c: MarketCatalog, kind: Market['kind']) => c.markets.filter((m) => m.kind === kind);

  const perps = nextFailed('Perps') ? ofKind(prev, 'perp') : ofKind(next, 'perp');
  const spotFailed = nextFailed('Spot');
  const spot = spotFailed ? ofKind(prev, 'spot') : ofKind(next, 'spot');
  let hip3: Market[];
  if (nextFailed('HIP-3') && next.failedDexs.length === 0) {
    hip3 = ofKind(prev, 'hip3'); // outright failure: nothing new to take
  } else {
    const missing = new Set(next.failedDexs);
    hip3 = [...ofKind(next, 'hip3'), ...ofKind(prev, 'hip3').filter((m) => m.dex && missing.has(m.dex))];
  }
  // HIP-4 'failed' is either an outright failure (no markets) or derived
  // labels only; neither may replace a slice that loaded cleanly
  const keepPrevHip4 =
    nextFailed('HIP-4') && (!prev.failed.includes('HIP-4') || ofKind(next, 'hip4').length === 0);
  const hip4 = keepPrevHip4 ? ofKind(prev, 'hip4') : ofKind(next, 'hip4');

  const prevByCoin = new Map(prev.markets.map((m) => [m.coin, m]));
  let changed = false;
  const merged = [...perps, ...spot, ...hip3, ...hip4].map((m) => {
    const old = prevByCoin.get(m.coin);
    if (old && sameMarket(old, m)) return old;
    changed = true;
    return m;
  });
  const markets = !changed && merged.length === prev.markets.length ? prev.markets : merged;

  // HIP-3 merges PER DEX above, so its failure is judged on what the merged
  // slice still lacks — two loads that each lost a different dex together
  // hold every dex, and must not keep the banner (and App's fallback mode) up.
  // 'all' = both sides failed outright; null = nothing missing.
  const hip3Out = (c: MarketCatalog) => c.failed.includes('HIP-3') && c.failedDexs.length === 0;
  let hip3Missing: string[] | 'all' | null;
  if (!nextFailed('HIP-3') || !prev.failed.includes('HIP-3')) hip3Missing = null;
  else if (hip3Out(next)) hip3Missing = hip3Out(prev) ? 'all' : prev.failedDexs; // slice kept from prev
  else if (hip3Out(prev)) hip3Missing = next.failedDexs; // prev had nothing to fill next's gaps
  else {
    const both = next.failedDexs.filter((d) => prev.failedDexs.includes(d));
    hip3Missing = both.length > 0 ? both : null;
  }
  const failedRaw = next.failed.filter((f) => prev.failed.includes(f) && (f !== 'HIP-3' || hip3Missing !== null));
  const failed = sameValue(failedRaw, prev.failed) ? prev.failed : failedRaw;
  const dexsRaw = Array.isArray(hip3Missing) ? hip3Missing : [];
  const failedDexs = sameValue(dexsRaw, prev.failedDexs) ? prev.failedDexs : dexsRaw;

  const questions = keepPrevHip4 ? prev.outcomeQuestions : next.outcomeQuestions;
  const outcomeQuestions =
    questions === prev.outcomeQuestions || JSON.stringify(questions) === JSON.stringify(prev.outcomeQuestions)
      ? prev.outcomeQuestions
      : questions;
  const spotSeenRaw = spotFailed ? prev.spotSeen : next.spotSeen;
  const spotSeen = sameSet(spotSeenRaw, prev.spotSeen) ? prev.spotSeen : spotSeenRaw;
  const outcomeSeenRaw = keepPrevHip4 ? prev.outcomeSeen : next.outcomeSeen;
  const outcomeSeen = sameSet(outcomeSeenRaw, prev.outcomeSeen) ? prev.outcomeSeen : outcomeSeenRaw;

  if (
    markets === prev.markets &&
    failed === prev.failed &&
    failedDexs === prev.failedDexs &&
    outcomeQuestions === prev.outcomeQuestions &&
    spotSeen === prev.spotSeen &&
    outcomeSeen === prev.outcomeSeen
  ) {
    return prev;
  }
  return { markets, failed, failedDexs, outcomeQuestions, spotSeen, outcomeSeen };
}
