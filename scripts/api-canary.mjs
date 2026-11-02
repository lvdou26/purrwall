// API canary (Invariant 10; .github/workflows/canary.yml runs it twice a
// day): verifies the Hyperliquid API surface still matches the structural
// assumptions the frontend is built on, and snapshots the market universe.
// Benign growth (new listings, settled outcomes) stays in the run-to-run
// snapshot (Actions-cached; committed only alongside a spot-list sync, never
// on its own — a push is a prod deploy); only ALERT-worthy changes
// (display-map index drift, Strict allowlist tokens gone from spotMeta, new
// HIP-3 dexs, new question categories, schema breaks) file GitHub issues —
// routine noise trains humans to ignore the one alert that matters.
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://api.hyperliquid.xyz/info';

async function info(body) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${body.type}: HTTP ${res.status}`);
  return res.json();
}

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// The previous run's snapshot is read up front: a section whose endpoint is
// unavailable this run (outcomeTemplates below) carries its baseline forward
// instead of writing an empty set that the next healthy run would then
// "alert" against.
const snapshotUrl = new URL('./api-snapshot.json', import.meta.url);
let prev = null;
try {
  prev = JSON.parse(readFileSync(snapshotUrl, 'utf8'));
} catch {
  /* first run */
}

/** HIP-3 dex names, perpDexs[0] being the null main dex. */
const snapshotDexNames = (list) =>
  list
    .slice(1)
    .map((d) => d?.name)
    .filter(Boolean)
    .sort();

const meta = await info({ type: 'meta' });
check(Array.isArray(meta.universe) && meta.universe.length > 0, 'meta.universe missing/empty');
check(typeof meta.universe[0]?.name === 'string', 'perp asset .name missing');

const dexs = await info({ type: 'perpDexs' });
check(
  Array.isArray(dexs) && dexs[0] === null,
  'perpDexs[0] is no longer null — dex enumeration assumption broke',
);

const spot = await info({ type: 'spotMeta' });
check(Array.isArray(spot.tokens) && Array.isArray(spot.universe), 'spotMeta shape changed');
check(
  spot.universe.every((p) => Array.isArray(p.tokens) && p.tokens.length === 2),
  'spot pair .tokens shape changed',
);

// Spot display-override map: src/lib/hl/spotOverrides.json is the single
// source of truth, auto-synced from HL's bundle by sync-spot-overrides.mjs
// (runs in the same workflow). Here we only verify index integrity — a
// mismatch means HL reshuffled token indexes, which the runtime survives
// (l1-check falls back to raw names) but the map needs a re-sync NOW.
// Tokens absent from HL's map need no tracking: HL's own UI shows them raw.
const SPOT_OVERRIDES = JSON.parse(
  readFileSync(new URL('../src/lib/hl/spotOverrides.json', import.meta.url), 'utf8'),
).entries;
const tokByIdx = new Map(spot.tokens.map((t) => [t.index, t.name]));
const mapMismatches = SPOT_OVERRIDES.filter(([idx, l1]) => tokByIdx.get(idx) !== l1).map(
  ([idx, l1]) => `${idx}:${l1}→${tokByIdx.get(idx) ?? 'gone'}`,
);

// Spot SELECTOR lists: src/lib/hl/spotSelector.json, synced from HL's bundle
// by the same script. The picker's Strict allowlist keys on the BASE token's
// tokenId (HL's selector field `spotId`), matched as an exact string — so the
// id shape is a structural invariant (a FAILURE: a reformatted id would
// silently empty Strict). An allowlisted id that RESOLVED when it was synced
// (non-null name) and is now gone from spotMeta is token drift — tokenIds are
// not expected to disappear, and HL's own list still carries the id, so a
// re-sync cannot clear it: an ALERT for a human to check against HL's
// picker. Ids HL hardcodes AHEAD of a listing (null name, kept on purpose by
// the sync) are recorded in the snapshot as `pending` and never alert.
const TOKEN_ID_RE = /^0x[0-9a-f]{32}$/;
const badTokenIds = spot.tokens.filter((t) => typeof t?.tokenId !== 'string' || !TOKEN_ID_RE.test(t.tokenId));
check(
  badTokenIds.length === 0,
  `spot token .tokenId no longer 0x + 32 lowercase hex (${badTokenIds.length} tokens, e.g. ${badTokenIds
    .slice(0, 3)
    .map((t) => `${t?.name}=${JSON.stringify(t?.tokenId)}`)
    .join(', ')}) — the Strict allowlist (spotSelector.json) matches on it`,
);
const SPOT_STRICT = JSON.parse(
  readFileSync(new URL('../src/lib/hl/spotSelector.json', import.meta.url), 'utf8'),
).strict;
const liveTokenIds = new Set(spot.tokens.map((t) => t.tokenId));
const strictGone = SPOT_STRICT.filter(([id, name]) => name !== null && !liveTokenIds.has(id)).map(
  ([id, name]) => `${id} (${name})`,
);
const strictPending = SPOT_STRICT.filter(([id, name]) => name === null && !liveTokenIds.has(id)).map(([id]) => id);

const om = await info({ type: 'outcomeMeta' });
check(Array.isArray(om.outcomes) && Array.isArray(om.questions), 'outcomeMeta shape changed');
const covered = new Set();
for (const q of om.questions) {
  check(Array.isArray(q.namedOutcomes), `question ${q.question} lacks namedOutcomes`);
  (q.namedOutcomes ?? []).forEach((id) => covered.add(id));
  covered.add(q.fallbackOutcome);
  (q.settledNamedOutcomes ?? []).forEach((id) => covered.add(id));
}

// HIP-4 TEMPLATE MARKETS (an HL format since Sep 2026). Deployer markets are
// named "template:<id>" with a "k:v|k:v" keyword bag for a description; the
// display text lives in {"type":"outcomeTemplates"} and the frontend
// interpolates it exactly as HL's bundle does (src/lib/hl/markets.ts,
// buildHip4 — the scrape is documented above parseQuestionInfo). That
// rendering is exact only while (a) every id on outcomeMeta is in the
// template list, (b) every bag on a template WITH keywords parses (a
// zero-keyword template never reads its bag — HL's tA and markets.ts both
// render it exactly whatever the description says), and (c) every template
// keyword is present in its instance. Anything else degrades to a legible
// DERIVED label — never the raw id — so these are ALERTS (a human re-derives
// the format), not canary failures (nothing is blank). Two further checks
// are template-LEVEL drift where rendering still matches HL but the
// formatter/parser may want a case: (d) a keyword hint the formatter does
// not know (both print the raw value) and (e) a "{slot}" in a template's
// name/side names that is not a declared keyword (both leave it literal).
// An UNAVAILABLE list is the same class, not a failure: every template row
// sits on the derived fallback until the next catalog load, the frontend
// banners HIP-4 with a Retry, nothing is blank — ONE alert, and the
// per-template / per-row checks and the drift comparisons are skipped (an
// empty list would otherwise read as "every template vanished"). Only a
// non-empty list with structurally wrong entries is a hard failure. The
// known-template and category sets go in the snapshot and alert on change
// like HIP-3 dexs do: a new template is a new market shape someone should
// eyeball against app.hyperliquid.xyz once; an unavailable list leaves the
// previous run's sets in place so the baseline is not poisoned.
let templates = [];
let templatesOk = true;
try {
  const list = await info({ type: 'outcomeTemplates' });
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(Array.isArray(list) ? 'empty list' : `not an array: ${JSON.stringify(list).slice(0, 80)}`);
  }
  templates = list;
} catch (err) {
  templatesOk = false;
  console.warn(`outcomeTemplates unavailable: ${err?.message ?? err}`);
}
const templatesShapeOk = templates.every(
  (t) =>
    typeof t?.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    Array.isArray(t.keywords),
);
check(templatesShapeOk, 'outcomeTemplates shape changed');
const templatesUsable = templatesOk && templatesShapeOk;
const KNOWN_HINTS = new Set(['dateTime', 'date', 'string', 'shortString', 'hlPerp', 'uInt', 'uDecimal']);
const SLOT_RE = /\{([^{}]+)\}/g;
const templateById = new Map(templatesUsable ? templates.map((t) => [t.id, t]) : []);
// twin of parseKvBag in markets.ts (HL's `wg`): a segment without ":" voids the bag
const parseKvBag = (desc) => {
  const out = new Map();
  if (desc === '') return out;
  for (const part of desc.split('|')) {
    const i = part.indexOf(':');
    if (i === -1) return null;
    out.set(part.slice(0, i), part.slice(i + 1));
  }
  return out;
};
// per-INSTANCE problems: that row renders via the derived fallback
const templateFallbacks = [];
// TEMPLATE-level drift: rendering still matches HL; the formatter/parser may want a case
const templateDrift = [];
const templated = [
  ...om.questions.map((q) => ({ what: `question ${q.question}`, name: q.name, description: q.description, sideSpecs: [] })),
  ...om.outcomes.map((o) => ({ what: `outcome ${o.outcome}`, name: o.name, description: o.description, sideSpecs: o.sideSpecs ?? [] })),
].filter((s) => typeof s.name === 'string' && s.name.startsWith('template:'));
if (templatesUsable) {
  for (const t of templates) {
    const declared = new Set(t.keywords.map(([k]) => k));
    for (const [k, hint] of t.keywords) {
      if (!KNOWN_HINTS.has(hint)) templateDrift.push(`template ${t.id}: keyword "${k}" has unknown hint "${hint}"`);
    }
    const sideNames = t.role?.standaloneOutcome?.sideNames ?? [];
    for (const text of [t.name, ...sideNames]) {
      for (const [, slot] of text.matchAll(SLOT_RE)) {
        if (!declared.has(slot)) templateDrift.push(`template ${t.id}: "{${slot}}" in "${text}" is not a declared keyword`);
      }
    }
  }
  for (const s of templated) {
    const id = s.name.slice('template:'.length);
    const tpl = templateById.get(id);
    if (!tpl) {
      templateFallbacks.push(`${s.what}: template id "${id}" is not in outcomeTemplates`);
      continue;
    }
    const kv = parseKvBag(s.description ?? '');
    // a voided bag only matters when the template has keywords to fill (HL's tA)
    if (kv === null && tpl.keywords.length > 0) {
      templateFallbacks.push(`${s.what} (${id}): description is not a key:value|… bag: ${JSON.stringify(s.description)}`);
      continue;
    }
    const missing = tpl.keywords.map(([k]) => k).filter((k) => !kv?.has(k));
    if (missing.length > 0) templateFallbacks.push(`${s.what} (${id}): bag lacks keyword(s) ${missing.join(', ')}`);
    const prefixedSides = s.sideSpecs.filter((side) => String(side?.name ?? '').startsWith('template:'));
    if (prefixedSides.length > 0 && !tpl.role?.standaloneOutcome) {
      templateDrift.push(
        `${s.what} (${id}): "template:" side names on a non-standalone template (HL keeps them raw; markets.ts strips the prefix, the row itself renders exactly)`,
      );
    }
  }
}
// twin of templateCategory in markets.ts: no "metadata=" trailer → no category
// (the questionOutcome templates carry none; without the -1 check, slicing
// from -1 + 9 would parse an arbitrary tail of the description as a bag)
const templateMetaCategory = (t) => {
  const i = t.description.indexOf('metadata=');
  return i === -1 ? undefined : parseKvBag(t.description.slice(i + 9).trim())?.get('category');
};
const templateIds = templatesUsable ? [...templateById.keys()].sort() : (prev?.outcomes?.templates ?? []);
const templateCategories = templatesUsable
  ? [...new Set(templates.map(templateMetaCategory).filter(Boolean))].sort()
  : (prev?.outcomes?.templateCategories ?? []);

// The World Cup wall (worldCupCoins in App.tsx) orders matches by the
// free-text "… scheduled for July 4, 2026 …" phrase in match descriptions —
// the only place HL exposes kickoff dates. Reworded descriptions don't break
// the wall (undated matches merely sort last), so this is snapshot DRIFT
// (snapshot + drift issue), not a hard canary failure.
const sportsMatches = om.outcomes.filter(
  (o) =>
    /category:sports/.test(o.description ?? '') &&
    o.sideSpecs?.length === 2 &&
    o.sideSpecs[0]?.name !== 'Yes',
);
const undatedMatches = sportsMatches.filter((o) => {
  const m = (o.description ?? '').match(/scheduled for (\w+ \d{1,2}, \d{4})/);
  return !m || Number.isNaN(Date.parse(m[1]));
});

const anns = await info({ type: 'perpConciseAnnotations' });
check(
  Array.isArray(anns) && Array.isArray(anns[0]) && typeof anns[0][0] === 'string',
  'perpConciseAnnotations shape changed',
);

// FORMULA CELLS rest on the id alphabet. A canonical formula id is coin ids
// joined by + - * / ( ) [ ] and decimal constants, and parseCanonical
// (src/lib/hl/formula.ts) splits it WITHOUT a catalog by reading symbols as
// maximal [A-Za-z0-9:@/] runs (an id carrying '/', such as PURR/USDC, is
// bracketed). An id that grew an operator char would parse as two legs; '#'
// is the HIP-4 marker (excluded from formulas). Likewise the picker reads
// operator chars in a query as formula syntax (formula mode's lexer, and
// isFormulaTrigger's ƒx nudge on an empty plain search), so a displayName or
// search keyword that grew one would be misread there (HL's displayName
// validator admits every printable ASCII char, so nothing upstream forbids
// it). Drift, not breakage (nothing blank) — alerts, like the display-map
// check.
// HIP-3 names come from deployers and are enumerated per dex exactly as
// markets.ts does (one meta call per builder dex; a dex that fails to
// answer is skipped this run, not alerted — the catalog banner covers it).
// Spot TOKEN names ride the alphabet check too: they are the BASE of the
// resolver's 'BASE/QUOTE' aliases (with spotOverrides), so a token name
// that grew an operator char is an untypeable alias even though the pair
// id it maps to ('@NNN') stays clean. The 96-char formula-id cap was sized
// from the longest live id, 14 chars (a 4-leg formula over 14-char ids
// measures ~70), so an id that outgrows 14 is the other drift worth a line.
const ID_MAX_LEN = 14;
const ID_RE = /^[A-Za-z0-9#/:@]+$/;
const DISPLAY_RE = /^[A-Za-z0-9&.:/-]+$/;
const OPERATOR_CHAR = /[+*()[\]=]/; // the display-name set; keywords also forbid '/'
const KEYWORD_OPERATOR_CHAR = /[+*/()[\]=]/;
const hip3Metas = await Promise.allSettled(
  dexs
    .slice(1)
    .filter((d) => d?.name)
    .map((d) => info({ type: 'meta', dex: d.name })),
);
const hip3Ids = hip3Metas.flatMap((r) =>
  r.status === 'fulfilled' && Array.isArray(r.value?.universe) ? r.value.universe.map((a) => a?.name) : [],
);
const allIds = [
  ...meta.universe.map((a) => a?.name),
  ...hip3Ids,
  ...spot.universe.map((p) => p?.name),
].filter((n) => typeof n === 'string');
const spotTokenNames = spot.tokens.map((t) => t?.name).filter((n) => typeof n === 'string');
const idAlphabetDrift = [...allIds, ...spotTokenNames].filter((n) => !ID_RE.test(n));
const idLengthDrift = allIds.filter((n) => n.length > ID_MAX_LEN);
const displayNameDrift = [];
const keywordDrift = [];
for (const [coin, a] of Array.isArray(anns) ? anns : []) {
  const dn = a?.displayName;
  if (typeof dn === 'string' && (!DISPLAY_RE.test(dn) || OPERATOR_CHAR.test(dn))) {
    displayNameDrift.push(`${coin} ${JSON.stringify(dn)}`);
  }
  for (const kw of Array.isArray(a?.keywords) ? a.keywords : []) {
    if (typeof kw === 'string' && KEYWORD_OPERATOR_CHAR.test(kw)) keywordDrift.push(`${coin} ${JSON.stringify(kw)}`);
  }
}

// Two category lists, one meaning. HL's Outcomes page buckets HIP-4 PRICE
// templates by {"type":"perpCategories"} ([coin, category][], config `ak` →
// `bre`, lowercased at lookup); its market selector's Tradfi tab reads
// perpConciseAnnotations. markets.ts consumes each where HL does (loadHip4
// vs loadHip3). A divergence breaks nothing, but it would put a perp in the
// Tradfi tab while its price markets bucket elsewhere (or vice versa), and a
// human should know the day the two surfaces start disagreeing.
const perpCats = await info({ type: 'perpCategories' });
check(
  Array.isArray(perpCats) &&
    perpCats.length > 0 &&
    perpCats.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string'),
  'perpCategories shape changed',
);
const lc = (s) => (typeof s === 'string' ? s.toLowerCase() : undefined);
const catByCoin = new Map(Array.isArray(perpCats) ? perpCats.filter((e) => Array.isArray(e)) : []);
const annCatByCoin = new Map((Array.isArray(anns) ? anns : []).map(([coin, a]) => [coin, a?.category]));
const categoryDisagreements = [];
for (const coin of new Set([...catByCoin.keys(), ...annCatByCoin.keys()])) {
  const a = lc(catByCoin.get(coin));
  const b = lc(annCatByCoin.get(coin));
  if (a !== b) categoryDisagreements.push(`${coin} ${a ?? '∅'}≠${b ?? '∅'}`);
}

const [, perpCtxs] = await info({ type: 'metaAndAssetCtxs' });
check(
  Array.isArray(perpCtxs) &&
    ['markPx', 'dayNtlVlm', 'funding', 'openInterest', 'prevDayPx'].every((k) => k in perpCtxs[0]),
  'perp asset ctx fields changed',
);

const [, spotCtxs] = await info({ type: 'spotMetaAndAssetCtxs' });
check(
  Array.isArray(spotCtxs) && spotCtxs.some((c) => String(c.coin ?? '').startsWith('#')),
  'spot ctxs no longer include HIP-4 outcome tokens — stats source broke',
);

const now = Date.now();
const candles = await info({
  type: 'candleSnapshot',
  req: { coin: 'BTC', interval: '1h', startTime: now - 72 * 3600e3, endTime: now },
});
check(
  Array.isArray(candles) &&
    candles.length > 0 &&
    ['t', 'o', 'c', 'h', 'l', 'v'].every((k) => k in candles[0]),
  'candleSnapshot fields changed',
);

// The 1w horizon rests on two undocumented properties of HL's bucketing, and
// both fail SILENTLY if they ever change (Invariant 10).
//
// 1. `i` must echo back byte-identical. ws.ts dispatches candles on
//    `candleKey(candle.s, candle.i)` — the SERVER's echo, not what we
//    subscribed with — so a normalisation to '1W' would leave every weekly
//    cell painting its backfill and then never ticking again: no error, no
//    overlay, status stuck on 'live'.
// 2. Bars must stay a fixed 7 days on the epoch grid (`t % 604800000 === 0`,
//    i.e. opening Thursday 00:00 UTC). INTERVAL_MS['1w'] is plain division at
//    every call site, and the docs modal makes the Thursday anchor a promise
//    to the user. HL's own `1M` is the cautionary case — a 30-day bucket that
//    drifts through the calendar, which is why it is not a Purrwall horizon.
const weekly = await info({
  type: 'candleSnapshot',
  req: { coin: 'BTC', interval: '1w', startTime: now - 12 * 7 * 86400e3, endTime: now },
});
check(
  Array.isArray(weekly) && weekly.length > 0 && weekly.every((c) => c.i === '1w'),
  'candleSnapshot 1w missing or its interval echo is no longer byte-exact',
);
check(
  Array.isArray(weekly) && weekly.every((c) => c.t % 604_800_000 === 0),
  '1w candles are no longer 7-day epoch-aligned buckets (Thursday 00:00 UTC)',
);

// COIN-ID GRAMMAR. App.tsx's fallbackMarket charts a saved coin through a
// partial catalog failure only if the string can be an HL id at all
// (types.ts coinKindOf — perp alnum, spot `@n` / `A/B`, HIP-3 `dex:TICKER`,
// HIP-4 `#n`, the shapes every live id takes). An id shape outside that
// grammar would make those cells read "select market" during such a failure
// instead of charting — nothing blank, nothing wrong when the catalog is
// healthy — so a new shape is an ALERT to widen the grammar.
// Keep this regex the twin of coinKindOf.
const COIN_ID_RE = /^(?:#\d+|@\d+|[A-Za-z0-9]+\/[A-Za-z0-9]+|[a-z0-9]+:[A-Za-z0-9]+|[A-Za-z0-9]+)$/;
const liveIds = [...meta.universe.map((a) => a.name), ...spot.universe.map((p) => p.name)];
for (const d of snapshotDexNames(dexs)) {
  const dm = await info({ type: 'meta', dex: d });
  for (const a of dm.universe ?? []) liveIds.push(a.name);
}
const foreignIds = liveIds.filter((id) => !COIN_ID_RE.test(id));

// WS UNKNOWN-COIN QUARANTINE (hl/ws.ts; docs/architecture.md → Ids and
// unknown ids). The quarantine's evidence is the `subscriptionResponse` ack
// HL sends per subscribe, in order; a sub for an id outside the universe gets
// no ack and HL closes the whole socket (1006) a few hundred ms later. If HL
// ever stopped acking valid subs, every close within ws.ts's window of a
// fresh subscribe would look like a bad id — a hard FAILURE. If unknown ids
// stop closing the socket, the quarantine is merely inert (and that docs
// entry stale) — an alert. One socket each, bounded by a deadline, never a
// canary hang.
async function wsProbe(subscription, { waitMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const out = { acked: false, closed: false, code: 0, error: null };
    const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    const done = () => {
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      resolve(out);
    };
    const timer = setTimeout(done, waitMs);
    ws.onopen = () => ws.send(JSON.stringify({ method: 'subscribe', subscription }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.channel === 'subscriptionResponse' && m.data?.method === 'subscribe') {
        out.acked = true;
        done();
      } else if (m.channel === 'error') out.error = String(m.data);
    };
    ws.onclose = (e) => {
      out.closed = true;
      out.code = e.code;
      done();
    };
    ws.onerror = () => {};
  });
}
const wsValid = await wsProbe({ type: 'candle', coin: 'BTC', interval: '1m' });
check(
  wsValid.acked,
  `WS: no subscriptionResponse ack for a valid candle sub (closed=${wsValid.closed} code=${wsValid.code} error=${wsValid.error}) — ws.ts's quarantine evidence gate is blind`,
);
const wsUnknown = await wsProbe({ type: 'candle', coin: 'PURRWALLCANARYNOPE', interval: '1m' });
const unknownStillCloses = !wsUnknown.acked && wsUnknown.closed;

const snapshot = {
  perps: {
    listed: meta.universe.length,
    active: meta.universe.filter((a) => !a.isDelisted).length,
  },
  hip3Dexs: snapshotDexNames(dexs),
  spot: { tokens: spot.tokens.length, pairs: spot.universe.length },
  outcomes: {
    total: om.outcomes.length,
    questions: om.questions.length,
    orphans: om.outcomes.filter((o) => o.name !== 'Fallback' && !covered.has(o.outcome)).length,
    sportsMatches: sportsMatches.length,
    undatedSportsMatches: undatedMatches.map((o) => o.outcome),
    templated: templated.length,
    templates: templateIds,
    templateCategories,
  },
  categories: [...new Set(anns.map(([, a]) => a?.category?.toLowerCase()).filter(Boolean))].sort(),
  spotDisplayMap: { mismatches: mapMismatches },
  spotSelector: { strictIds: SPOT_STRICT.length, gone: strictGone, pending: strictPending },
};

// Alerts = changes a human must look at. Everything else in the snapshot
// (listing counts, settled outcomes, reworded descriptions) is normal market
// life and advances the cached snapshot without an issue.
const alerts = [];
if (foreignIds.length > 0) {
  alerts.push(
    `coin ids outside coinKindOf's grammar (types.ts; fallbackMarket refuses them during a partial catalog failure): ${foreignIds.join(', ')}`,
  );
}
if (!unknownStillCloses) {
  alerts.push(
    `WS: a candle sub for an unknown id no longer closes the socket unacked (acked=${wsUnknown.acked} closed=${wsUnknown.closed} code=${wsUnknown.code} error=${wsUnknown.error}) — ws.ts's quarantine is inert and docs/architecture.md → Ids and unknown ids is stale`,
  );
}
if (mapMismatches.length > 0) {
  alerts.push(`spot display-map index drift: ${mapMismatches.join(', ')} — re-run sync-spot-overrides`);
}
if (strictGone.length > 0) {
  alerts.push(
    `spot Strict allowlist token drift: ${strictGone.join(', ')} resolved when spotSelector.json was synced and ${strictGone.length > 1 ? 'are' : 'is'} gone from live spotMeta — a human checks HL's picker`,
  );
}
if (prev && JSON.stringify(prev.hip3Dexs) !== JSON.stringify(snapshot.hip3Dexs)) {
  alerts.push(`HIP-3 dex set changed: ${JSON.stringify(prev.hip3Dexs)} → ${JSON.stringify(snapshot.hip3Dexs)}`);
}
if (prev && JSON.stringify(prev.categories) !== JSON.stringify(snapshot.categories)) {
  alerts.push(`question categories changed: ${JSON.stringify(prev.categories)} → ${JSON.stringify(snapshot.categories)}`);
}
if (categoryDisagreements.length > 0) {
  alerts.push(
    `perp category lists disagree (perpCategories buckets HIP-4 price templates, perpConciseAnnotations drives the Tradfi tab): ${categoryDisagreements.join(', ')}`,
  );
}
if (idAlphabetDrift.length > 0) {
  alerts.push(
    `coin id alphabet drift (formula ids parse symbols as [A-Za-z0-9:@/] runs, src/lib/hl/formula.ts parseCanonical): ${idAlphabetDrift.join(', ')}`,
  );
}
if (idLengthDrift.length > 0) {
  alerts.push(
    `coin id longer than ${ID_MAX_LEN} chars (the 96-char formula-id cap, src/lib/hl/formula.ts MAX_ID_LEN, was sized from the longest live id, ${ID_MAX_LEN} chars): ${idLengthDrift.join(', ')}`,
  );
}
if (displayNameDrift.length > 0) {
  alerts.push(
    `perpConciseAnnotations displayName outside [A-Za-z0-9&.:/-] or carrying an operator char (the picker's formula trigger reads the query for + * ( ) [ ] =): ${displayNameDrift.join(', ')}`,
  );
}
if (keywordDrift.length > 0) {
  alerts.push(
    `perpConciseAnnotations keyword carrying an operator char (the picker would read it as formula syntax): ${keywordDrift.join(', ')}`,
  );
}
if (!templatesOk) {
  alerts.push(
    'HIP-4 outcomeTemplates unavailable — every template row is on the derived fallback until the next catalog load (frontend banners HIP-4 with Retry, nothing blank); template checks and drift comparisons skipped this run',
  );
}
for (const p of templateFallbacks) alerts.push(`HIP-4 template drift (row renders via the derived fallback): ${p}`);
for (const p of templateDrift) alerts.push(`HIP-4 template drift (rendering still matches HL; formatter/parser may need a case): ${p}`);
const prevTemplates = prev?.outcomes?.templates;
if (templatesUsable && prevTemplates && JSON.stringify(prevTemplates) !== JSON.stringify(snapshot.outcomes.templates)) {
  alerts.push(`HIP-4 template set changed: ${JSON.stringify(prevTemplates)} → ${JSON.stringify(snapshot.outcomes.templates)} — eyeball the new shape against HL's Outcomes page`);
}
const prevTemplateCats = prev?.outcomes?.templateCategories;
if (templatesUsable && prevTemplateCats && JSON.stringify(prevTemplateCats) !== JSON.stringify(templateCategories)) {
  alerts.push(`HIP-4 template categories changed: ${JSON.stringify(prevTemplateCats)} → ${JSON.stringify(templateCategories)} — the Outcome sub-tabs (MarketTable OUTCOME_SUBTABS) may need a bucket`);
}

writeFileSync(snapshotUrl, JSON.stringify(snapshot, null, 2) + '\n');
// consumed by canary.yml: non-empty file → drift issue; benign diff → cached snapshot only
writeFileSync('canary-alerts.txt', alerts.length ? alerts.join('\n') + '\n' : '');

if (problems.length > 0) {
  console.error('CANARY FAILURES:\n- ' + problems.join('\n- '));
  process.exit(1);
}
if (alerts.length > 0) console.log('CANARY ALERTS:\n- ' + alerts.join('\n- '));
console.log('canary ok:', JSON.stringify(snapshot));
