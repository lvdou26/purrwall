// Pure extraction + validation of the spot lists Hyperliquid hardcodes in
// its frontend bundle. scripts/sync-spot-overrides.mjs owns the story, the
// exit contract and all I/O; this module never touches the network or the
// filesystem (loadBundle takes an injected fetcher, everything else takes
// strings and parsed JSON), so every rule below is pinned by
// hlBundleLists.test.mjs against small synthetic chunks.
//
// The three lists, as minified in HL's Vite build:
//   rename map     config-*.js  var jh={Testnet:[…],Mainnet:[Ah(197,`UBTC`,`BTC`),…],…}
//   Strict ids     series-*.js  pt=o.chain===`Mainnet`?`0x….0x…`.split(`.`):[`0x…`,…]
//   hidden tokens  config-*.js  dg=[`XMR1`,`FXMR`];function fg(e){return dg.includes(e.toUpperCase())}
//                               pg=[`USDH`];function mg(e){return pg.includes(e.toUpperCase())}
// Identifier names, chunk names and quote style are NOT stable across HL
// builds, so no regex below keys on any of them; which list is which is
// decided by validating against live spotMeta, never by position.

export const APP_HOST = 'app.hyperliquid.xyz';

// ---- floors, caps, shapes ----------------------------------------------
export const MIN_MAP_ENTRIES = 20; // ~28 in HL's map; a tiny parse = broken anchor
export const MIN_STRICT_IDS = 40; // ~54 in HL's list
export const STRICT_RESOLVE_RATIO = 0.9; // share of ids that must be live mainnet tokenIds
// Continuity against the COMMITTED allowlist (a set-overlap guard, not a
// count guard: a different list of >= 40 live ids of similar size must never
// replace the allowlist wholesale): keep >= 80% of the committed ids and add
// at most max(10, 50% of the committed count).
export const STRICT_MIN_KEEP = 0.8;
export const STRICT_MAX_ADD = 0.5;
export const STRICT_MAX_ADD_FLOOR = 10;
// Discovery caps. Level 0 is ~47 chunks / ~5.7 MB; a forced level-1 follow
// scans ~280 files / ~9 MB (a 250-file cap would cut it short). The file cap
// only stops a runaway; the byte cap is the real guard.
export const MAX_FILES = 1000;
export const MAX_BYTES = 60e6;
export const DISPLAY_RE = /^[A-Za-z0-9][A-Za-z0-9\-.]{0,15}$/; // HL validates display names similarly (no ':')
// Hidden entries are compared against DISPLAYED names (PUMP-26, ANSEM-19), so
// they share the display-name grammar.
export const HIDDEN_NAME_RE = DISPLAY_RE;
export const TOKEN_ID_RE = /^0x[0-9a-f]{32}$/;
// Membership anchors, used ONLY when the data cannot tell the two hidden
// lists apart (see pickHidden). Both have been on HL's lists since the CRA
// bundle (markets.ts HIDDEN_SPOT_BASES / HIDDEN_SPOT_QUOTES).
export const ANCHOR_HIDDEN_BASE = 'XMR1';
export const ANCHOR_HIDDEN_QUOTE = 'USDH';

const STR = String.raw`(?:\x60[^\x60]*\x60|"[^"]*"|'[^']*')`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const unq = (s) => s.slice(1, -1);
const assetPath = (name) => `/assets/${name}`;
export const sourceOf = (path) => `${APP_HOST}${path}`;

// ---- discovery ------------------------------------------------------------
// Every /assets/*.js the HTML references — the module entry AND the
// modulepreload list, quoted or not (the Vite HTML carries ~46 preloads).
const HTML_REF_RE = /(?:src|href)\s*=\s*["']?(?:https?:\/\/app\.hyperliquid\.xyz)?\.?(\/assets\/[\w.-]+\.js)(?![\w.-])/g;
// Chunk-internal references: `from"./x.js"`, `import("./x.js")` and the
// __vite__mapDeps list ("assets/x.js").
const CHUNK_REF_RE = /["'`](?:\.\/|\/assets\/|assets\/)([\w.-]+\.js)["'`]/g;

export const htmlChunkRefs = (html) => [...new Set([...html.matchAll(HTML_REF_RE)].map((m) => m[1]))];
export const chunkRefs = (src) => [...new Set([...src.matchAll(CHUNK_REF_RE)].map((m) => assetPath(m[1])))];

/** Which anchors the scanned chunks do not yet carry (empty = all present). */
export function missingAnchors(chunks) {
  const missing = [];
  if (findRenameMaps(chunks).length === 0) missing.push('rename map');
  if (!findIdLists(chunks).some((l) => l.ids.length >= MIN_STRICT_IDS)) missing.push('Strict allowlist');
  if (distinctBy(findHiddenLists(chunks), (l) => JSON.stringify(l.entries)).length < 2) missing.push('hidden lists');
  return missing;
}

/**
 * Fetch the app HTML, every chunk it references (level 0), and — only when
 * an anchor is missing there — every chunk those chunks reference (level 1,
 * which covers a list moving into a lazily imported chunk). Capped by file
 * count and bytes. getText(path) resolves to the body or null (404 etc.).
 * When a cap stops the scan, `capped` holds the level it stopped at, how many
 * of that level's refs were wanted and how many were left unscanned — an
 * incomplete scan is a configuration problem, never a transient one.
 */
export async function loadBundle(getText, { maxFiles = MAX_FILES, maxBytes = MAX_BYTES, concurrency = 8 } = {}) {
  const html = await getText('/');
  if (typeof html !== 'string' || html.length === 0) throw new Error(`${APP_HOST} HTML unavailable`);
  const chunks = new Map();
  const failed = [];
  let bytes = 0;
  let capped = null;
  const load = async (paths, level) => {
    const want = paths.filter((p) => !chunks.has(p) && !failed.includes(p));
    let stop = false;
    for (let i = 0; i < want.length && !stop; ) {
      const room = maxFiles - chunks.size;
      if (room <= 0) {
        stop = true;
        break;
      }
      const batch = want.slice(i, i + Math.min(concurrency, room));
      i += batch.length;
      const texts = await Promise.all(batch.map((p) => Promise.resolve().then(() => getText(p)).catch(() => null)));
      for (let k = 0; k < batch.length; k++) {
        const t = texts[k];
        if (typeof t !== 'string') {
          failed.push(batch[k]);
          continue;
        }
        if (bytes + t.length > maxBytes) {
          stop = true;
          break;
        }
        bytes += t.length;
        chunks.set(batch[k], t);
      }
    }
    if (stop) {
      const unscanned = want.filter((p) => !chunks.has(p) && !failed.includes(p)).length;
      capped = { level, wanted: want.length, unscanned };
    }
  };
  const level0 = htmlChunkRefs(html);
  await load(level0, 0);
  let depth = 0;
  const missingAtLevel0 = missingAnchors(chunks);
  if (missingAtLevel0.length > 0 && !capped) {
    const level1 = new Set();
    for (const src of chunks.values()) for (const p of chunkRefs(src)) level1.add(p);
    depth = 1;
    await load([...level1], 1);
  }
  return { level0, chunks, bytes, failed, capped, depth, missingAtLevel0 };
}

// ---- extractors -------------------------------------------------------------
// Rename map: Mainnet:[<helper>(<int>,<str>,<str>),…] (the key may be quoted).
const MAP_BLOCK_RE = new RegExp(
  String.raw`["'\x60]?Mainnet["'\x60]?\s*:\s*\[\s*((?:${IDENT}\(\s*\d+\s*,\s*${STR}\s*,\s*${STR}\s*\)\s*,?\s*)+)\]`,
  'g',
);
const MAP_ENTRY_RE = new RegExp(String.raw`(${IDENT})\(\s*(\d+)\s*,\s*(${STR})\s*,\s*(${STR})\s*\)`, 'g');

export function findRenameMaps(chunks) {
  const found = [];
  for (const [path, src] of chunks) {
    for (const m of src.matchAll(MAP_BLOCK_RE)) {
      const rows = [...m[1].matchAll(MAP_ENTRY_RE)];
      found.push({
        path,
        at: m.index,
        helpers: [...new Set(rows.map((r) => r[1]))],
        entries: rows.map((r) => [Number(r[2]), unq(r[3]), unq(r[4])]),
      });
    }
  }
  return found;
}

// Strict allowlist candidates: a run of 0x<32 hex> token ids written as
//   (a) ONE string joined by a single separator + .split(<that separator>)
//       (rolldown/oxc's form for long string lists — the Mainnet branch), or
//   (b) an array literal of strings (its form for short lists — Testnet).
// The separator is back-referenced, so a mixed-separator string never
// parses into a half-split id. (`\3(?:0x…)`, never `\30x…`: the latter
// reads as backreference 30 and silently matches nothing.)
const ID = '0x[0-9a-f]{32}';
const SPLIT_RE = new RegExp(String.raw`(["'\x60])(${ID}([.,|; ])${ID}(?:\3(?:${ID}))*)\1\s*\.split\(\s*(["'\x60])\3\4\s*\)`, 'g');
const ARRAY_RE = new RegExp(String.raw`\[\s*((?:(["'\x60])${ID}\2\s*,\s*)+(["'\x60])${ID}\3)\s*,?\s*\]`, 'g');
const ID_G = new RegExp(ID, 'g');
// the 60 chars before a list: `<x>.chain===\`Mainnet\`?` marks a ternary's true branch
const GATE_RE = /([A-Za-z_$][\w$]*)\.chain\s*(===|!==|==|!=)\s*(["'`])(Mainnet|Testnet)\3\s*\?\s*$/;
const MIN_CANDIDATE_IDS = 5;

export function findIdLists(chunks) {
  const found = [];
  for (const [path, src] of chunks) {
    const chunkHasSpotId = /\.spotId\b/.test(src);
    const push = (index, form, ids) => {
      if (ids.length < MIN_CANDIDATE_IDS) return;
      const g = src.slice(Math.max(0, index - 60), index).match(GATE_RE);
      let gate = 'none';
      if (g) {
        const eq = g[2].startsWith('=');
        gate = (g[4] === 'Mainnet') === eq ? 'mainnet-branch' : 'other-branch';
      } else if (/:\s*$/.test(src.slice(Math.max(0, index - 3), index))) {
        gate = 'else-branch';
      }
      found.push({ path, at: index, form, ids, gate, chunkHasSpotId });
    };
    for (const m of src.matchAll(SPLIT_RE)) push(m.index, `split(${JSON.stringify(m[3])})`, m[2].split(m[3]));
    for (const m of src.matchAll(ARRAY_RE)) push(m.index, 'array', [...m[1].matchAll(ID_G)].map((x) => x[0]));
  }
  return found;
}

// Hidden tokens: a string array immediately followed by its upper-casing
// membership predicate, as a function declaration or an arrow function:
//   L=[…];function F(P){return L.includes(P.toUpperCase())}
//   L=[…],F=P=>L.includes(P.toUpperCase())
// Group layout is identical in both: 1 list ident, 2 items, 3 fn, 4 param.
const HIDDEN_RES = [
  new RegExp(
    String.raw`(?<![\w$.])(${IDENT})\s*=\s*\[\s*((?:${STR}\s*,?\s*)*)\]\s*[;,]?\s*function\s+(${IDENT})\s*\(\s*(${IDENT})\s*\)\s*\{\s*return\s+\1\s*\.includes\(\s*\4\s*\.toUpperCase\(\s*\)\s*\)\s*;?\s*\}`,
    'g',
  ),
  new RegExp(
    String.raw`(?<![\w$.])(${IDENT})\s*=\s*\[\s*((?:${STR}\s*,?\s*)*)\]\s*[;,]\s*(?:(?:var|let|const)\s+)?(${IDENT})\s*=\s*\(?\s*(${IDENT})\s*\)?\s*=>\s*\1\s*\.includes\(\s*\4\s*\.toUpperCase\(\s*\)\s*\)`,
    'g',
  ),
];
const STR_G = new RegExp(STR, 'g');

export function findHiddenLists(chunks) {
  const found = [];
  for (const [path, src] of chunks) {
    for (const re of HIDDEN_RES) {
      for (const m of src.matchAll(re)) {
        found.push({ path, at: m.index, list: m[1], fn: m[3], entries: [...m[2].matchAll(STR_G)].map((x) => unq(x[0])) });
      }
    }
  }
  return found;
}

// ---- selection + validation -------------------------------------------------
// Each picker returns { ok: true, value, source, notes } or
// { ok: false, error, notes }. `error` is ONE human-readable line (it becomes
// a line of the canary's failure issue); `notes` are stdout-only context.

function distinctBy(xs, key) {
  return [...new Map(xs.map((x) => [key(x), x])).values()];
}
const sortedKey = (xs) => JSON.stringify([...xs].sort());
const fail = (error, notes = []) => ({ ok: false, error, notes });

/** spotMeta sanity: the validation below is only as good as this list. */
export function checkSpotMeta(spotMeta) {
  if (!Array.isArray(spotMeta?.tokens) || !Array.isArray(spotMeta?.universe)) return 'spotMeta: tokens/universe missing';
  if (spotMeta.tokens.length < 100) return `spotMeta: implausibly small (${spotMeta.tokens.length} tokens)`;
  return null;
}

export function pickRenameMap(candidates, spotMeta) {
  const tokByIdx = new Map(spotMeta.tokens.map((t) => [t.index, t.name]));
  const drift = (b) => b.entries.filter(([i, l1]) => tokByIdx.get(i) !== l1).map(([i, l1]) => `${i}:${l1}→${tokByIdx.get(i) ?? 'gone'}`);
  // Only a block whose every entry holds its l1 name in live spotMeta is a
  // MAINNET map (Testnet indexes hold other names): the chain is proven by
  // data, not by key order.
  const valid = candidates.filter((b) => b.helpers.length === 1 && b.entries.length >= MIN_MAP_ENTRIES && drift(b).length === 0);
  const distinct = distinctBy(valid, (b) => JSON.stringify(b.entries));
  if (distinct.length === 0) {
    if (candidates.length === 0) {
      return fail('rename map: no `Mainnet:[<fn>(idx,"l1","display"),…]` block in any scanned chunk — HL restructured its bundle; re-derive MAP_BLOCK_RE in scripts/lib/hlBundleLists.mjs');
    }
    const best = [...candidates].sort((a, b) => b.entries.length - a.entries.length)[0];
    const why = [];
    if (best.helpers.length !== 1) why.push(`${best.helpers.length} helper identifiers (${best.helpers.join(', ')}) — expected one`);
    if (best.entries.length < MIN_MAP_ENTRIES) why.push(`only ${best.entries.length} entries (< ${MIN_MAP_ENTRIES}) — partial match`);
    const d = drift(best);
    if (d.length > 0) why.push(`index drift against live spotMeta: ${d.join(', ')}`);
    return fail(`rename map: no valid Mainnet block (${candidates.length} candidate(s); best has ${best.entries.length} entries in ${best.path}: ${why.join('; ')})`);
  }
  if (distinct.length > 1) {
    return fail(`rename map: ${distinct.length} different valid Mainnet blocks (${distinct.map((b) => `${b.entries.length}@${b.path}`).join(', ')}) — ambiguous, a human decides`);
  }
  const b = distinct[0];
  const badDisplay = b.entries.filter(([, , d]) => !DISPLAY_RE.test(d));
  if (badDisplay.length > 0) return fail(`rename map: suspicious display name(s) ${JSON.stringify(badDisplay)} in ${b.path}`);
  const idx = b.entries.map(([i]) => i);
  const dupIdx = idx.filter((i, k) => idx.indexOf(i) !== k);
  if (dupIdx.length > 0) return fail(`rename map: duplicate token index(es) ${[...new Set(dupIdx)].join(', ')} in ${b.path}`);
  return { ok: true, value: b.entries, source: sourceOf(b.path), notes: [`${b.entries.length} entries, helper ${b.helpers[0]}()`] };
}

export function pickStrict(candidates, spotMeta, committedIds = []) {
  const tokById = new Map(spotMeta.tokens.map((t) => [String(t.tokenId), t]));
  const scored = candidates.map((l) => {
    const resolved = l.ids.filter((id) => tokById.has(id)).length;
    return { ...l, resolved, ratio: resolved / l.ids.length };
  });
  const describe = (l) => `${l.ids.length} ids (${l.form}, gate=${l.gate}) @${l.path} → ${l.resolved} live (${Math.round(l.ratio * 100)}%)`;
  const notes = scored.map((l) => `candidate ${describe(l)}`);
  let q = distinctBy(
    scored.filter((l) => l.ids.length >= MIN_STRICT_IDS && l.ratio >= STRICT_RESOLVE_RATIO),
    (l) => sortedKey(l.ids),
  );
  if (q.length > 1) {
    // tie-break only: the list sitting in a chain===Mainnet true branch of
    // the chunk that filters on .spotId is the one HL's picker reads
    const gated = q.filter((l) => l.gate === 'mainnet-branch' && l.chunkHasSpotId);
    if (gated.length === 1) {
      notes.push(`${q.length} qualifying lists; tie-broken on the chain===Mainnet gate + .spotId usage`);
      q = gated;
    }
  }
  if (q.length !== 1) {
    const rule = `>= ${MIN_STRICT_IDS} ids, >= ${STRICT_RESOLVE_RATIO * 100}% live mainnet tokenIds`;
    if (q.length > 1) return fail(`strict allowlist: ${q.length} different qualifying lists (${q.map(describe).join('; ')}) — ambiguous, a human decides`, notes);
    if (scored.length === 0) return fail(`strict allowlist: no list of 0x-token ids in any scanned chunk (need ${rule}) — HL restructured its bundle; re-derive SPLIT_RE/ARRAY_RE in scripts/lib/hlBundleLists.mjs`, notes);
    const best = [...scored].sort((a, b) => b.ids.length - a.ids.length)[0];
    return fail(`strict allowlist: no qualifying list (need ${rule}); largest candidate: ${describe(best)}`, notes);
  }
  const l = q[0];
  if (new Set(l.ids).size !== l.ids.length) {
    const dups = [...new Set(l.ids.filter((id, k) => l.ids.indexOf(id) !== k))];
    return fail(`strict allowlist: duplicate id(s) ${dups.join(', ')} in ${l.path}`, notes);
  }
  if (committedIds.length > 0) {
    const next = new Set(l.ids);
    const cur = new Set(committedIds);
    const kept = committedIds.filter((id) => next.has(id)).length;
    const added = l.ids.filter((id) => !cur.has(id)).length;
    const minKeep = committedIds.length * STRICT_MIN_KEEP;
    const maxAdd = Math.max(STRICT_MAX_ADD_FLOOR, Math.floor(committedIds.length * STRICT_MAX_ADD));
    if (kept < minKeep || added > maxAdd) {
      return fail(
        `strict allowlist: replaced/grew wholesale — keeps ${kept} of ${committedIds.length} committed ids (need >= ${STRICT_MIN_KEEP * 100}%), adds ${added} (max ${maxAdd}) — refusing, a human checks HL's picker`,
        notes,
      );
    }
  }
  if (l.gate !== 'mainnet-branch') notes.push(`list is not in a chain===Mainnet true branch (gate=${l.gate}) — accepted on data`);
  if (!l.chunkHasSpotId) notes.push('its chunk has no .spotId usage — accepted on data');
  const entries = l.ids.map((id) => [id, tokById.get(id)?.name ?? null]);
  const unresolved = entries.filter(([, n]) => n === null).map(([id]) => id);
  if (unresolved.length > 0) notes.push(`${unresolved.length} id(s) not (yet) in live spotMeta, kept with a null name: ${unresolved.join(', ')}`);
  return { ok: true, value: entries, source: sourceOf(l.path), notes };
}

/**
 * The two hidden lists. Which is which is decided by DATA first: the quotes
 * list is the one whose every entry is a live token that quotes some spot
 * pair (by l1 or display name, upper-cased — HL compares
 * `list.includes(name.toUpperCase())` against the DISPLAYED name), the bases
 * list is the other. Only when that is not decisive (a third matching list,
 * or both/neither looking like quotes) does the membership fallback apply:
 * the one list containing ANCHOR_HIDDEN_QUOTE is quotes, the one containing
 * ANCHOR_HIDDEN_BASE is bases.
 *
 * Because a validated list is auto-committed and deployed, the data-first
 * pick is then held to three guards, each failing only its own section (the
 * committed value stays): (a) the anchors must not cross — a quotes list
 * carrying XMR1 or a bases list carrying USDH is a misclassification or an
 * HL change a human reads first; (b) continuity — a list that differs from
 * the committed one must still contain its anchor or share at least one
 * entry with it (skipped only when nothing is committed), so an unrelated
 * `x=[`HYPE`]` in the same idiom can never replace a list wholesale; (c) no
 * hidden base may be a token on the Strict allowlist (`strictIds`) — HL does
 * not feature and hide the same base. Returns { bases, quotes }.
 */
export function pickHidden(candidates, spotMeta, { renameEntries = [], committed = null, strictIds = [] } = {}) {
  const tokByIdx = new Map(spotMeta.tokens.map((t) => [t.index, t]));
  const displayByIdx = new Map(renameEntries.map(([i, l1, d]) => [i, { l1, d }]));
  const displayedOf = (tok) => {
    const o = displayByIdx.get(tok.index);
    return (o && o.l1 === tok.name ? o.d : tok.name).toUpperCase();
  };
  const namesOf = (tok) => [...new Set([tok.name.toUpperCase(), displayedOf(tok)])];
  const liveNames = new Set(spotMeta.tokens.flatMap(namesOf));
  const quoteNames = new Set(
    spotMeta.universe.flatMap((p) => {
      const tok = tokByIdx.get(p?.tokens?.[1]);
      return tok ? namesOf(tok) : [];
    }),
  );
  const up = (s) => s.toUpperCase();
  const distinct = distinctBy(candidates, (l) => JSON.stringify(l.entries));
  if (distinct.length === 0) {
    const e = 'no `L=[…];function f(e){return L.includes(e.toUpperCase())}` list in any scanned chunk — HL restructured its bundle; re-derive HIDDEN_RES in scripts/lib/hlBundleLists.mjs';
    return { bases: fail(`hidden bases: ${e}`), quotes: fail(`hidden quotes: ${e}`) };
  }
  const quoteShaped = distinct.filter((l) => l.entries.length > 0 && l.entries.every((s) => quoteNames.has(up(s))));
  const others = distinct.filter((l) => !quoteShaped.includes(l));
  let quotes = quoteShaped.length === 1 ? quoteShaped[0] : null;
  let bases = others.length === 1 ? others[0] : null;
  const notes = [];
  if (!quotes || !bases || distinct.length !== 2) {
    const having = (name) => distinct.filter((l) => l.entries.some((s) => up(s) === name));
    const qa = having(ANCHOR_HIDDEN_QUOTE);
    const ba = having(ANCHOR_HIDDEN_BASE);
    quotes = qa.length === 1 ? qa[0] : null;
    bases = ba.length === 1 ? ba[0] : null;
    notes.push(
      `${distinct.length} matching list(s), ${quoteShaped.length} quote-shaped — the data is not decisive; fell back to membership (${ANCHOR_HIDDEN_QUOTE} → quotes, ${ANCHOR_HIDDEN_BASE} → bases)`,
    );
  }
  const seen = distinct.map((l) => `[${l.entries.join(',')}]@${l.path}`).join(', ');
  if (quotes && quotes === bases) {
    const e = `one list carries both anchors (${seen}) — cannot tell bases from quotes`;
    return { bases: fail(`hidden bases: ${e}`, notes), quotes: fail(`hidden quotes: ${e}`, notes) };
  }
  const where = (l) => `${l.list}@${l.path}`;
  const shape = (l, what) => {
    if (l.entries.length === 0) return `${what}: HL's list is empty (${where(l)})`;
    const bad = l.entries.filter((s) => !HIDDEN_NAME_RE.test(s));
    if (bad.length > 0) return `${what}: entries not display-name shaped ${JSON.stringify(bad)} (${where(l)})`;
    return null;
  };
  const has = (l, name) => l.entries.some((s) => up(s) === name);
  // (a) the anchors never cross
  const crossed = (l, what, foreign, role) =>
    has(l, foreign) ? `${what}: [${l.entries.join(',')}] carries ${foreign}, a hidden ${role} anchor (${where(l)}) — misclassified or changed by HL; a human checks HL's picker` : null;
  // (b) continuity with the committed list
  const continuity = (l, what, anchor, committedList) => {
    if (!Array.isArray(committedList) || committedList.length === 0) return null;
    if (has(l, anchor)) return null;
    const cur = new Set(committedList.map(up));
    if (l.entries.some((s) => cur.has(up(s)))) return null;
    return `${what}: replaced wholesale — [${l.entries.join(',')}] (${where(l)}) shares nothing with the committed [${committedList.join(',')}] and lacks ${anchor}; a human checks HL's picker`;
  };
  // (c) a hidden base is never a Strict-allowlisted token (matched on the displayed name, as HL compares)
  const strictSet = new Set(strictIds);
  const idsByDisplayed = new Map();
  for (const t of spotMeta.tokens) {
    const k = displayedOf(t);
    idsByDisplayed.set(k, [...(idsByDisplayed.get(k) ?? []), String(t.tokenId)]);
  }
  const featured = (l, what) => {
    const hits = l.entries.filter((s) => (idsByDisplayed.get(up(s)) ?? []).some((id) => strictSet.has(id)));
    return hits.length > 0
      ? `${what}: ${hits.join(', ')} ${hits.length > 1 ? 'are' : 'is'} on the Strict allowlist — HL does not feature and hide the same base (${where(l)}); a human checks HL's picker`
      : null;
  };
  const first = (...checks) => checks.find((c) => c !== null) ?? null;

  let basesRes;
  if (!bases) basesRes = fail(`hidden bases: cannot identify the list among ${distinct.length} candidate(s): ${seen}`, notes);
  else {
    const what = 'hidden bases';
    const e = first(
      shape(bases, what),
      crossed(bases, what, ANCHOR_HIDDEN_QUOTE, 'QUOTE'),
      continuity(bases, what, ANCHOR_HIDDEN_BASE, committed?.hiddenBases),
      featured(bases, what),
    );
    basesRes = e ? fail(e, notes) : { ok: true, value: bases.entries, source: sourceOf(bases.path), notes: [...notes] };
    const unknown = bases.entries.filter((s) => !liveNames.has(up(s)));
    if (!e && unknown.length > 0) basesRes.notes.push(`hidden bases not (yet) live spot tokens: ${unknown.join(', ')}`);
  }
  let quotesRes;
  if (!quotes) quotesRes = fail(`hidden quotes: cannot identify the list among ${distinct.length} candidate(s): ${seen}`, notes);
  else {
    const what = 'hidden quotes';
    const unknown = quotes.entries.filter((s) => !liveNames.has(up(s)));
    const e = first(
      shape(quotes, what),
      crossed(quotes, what, ANCHOR_HIDDEN_BASE, 'BASE'),
      unknown.length > 0 ? `${what}: not live spot token names: ${unknown.join(', ')} (${where(quotes)})` : null,
      continuity(quotes, what, ANCHOR_HIDDEN_QUOTE, committed?.hiddenQuotes),
    );
    quotesRes = e ? fail(e, notes) : { ok: true, value: quotes.entries, source: sourceOf(quotes.path), notes: [...notes] };
  }
  return { bases: basesRes, quotes: quotesRes };
}

/**
 * Run every extractor + picker over the scanned chunks. `committed` is
 * { overrides, selector } as parsed from the checked-in files (either may be
 * null); it feeds the Strict and hidden-list continuity guards and — when
 * this run's map fails — the display names the hidden-list checks read. The
 * hidden-base plausibility check reads this run's Strict ids when they
 * validated, else the committed ones.
 */
export function extractAll({ chunks, spotMeta, committed = {} }) {
  const bad = checkSpotMeta(spotMeta);
  if (bad) {
    const e = `${bad} — cannot validate anything this run`;
    return { map: fail(`rename map: ${e}`), strict: fail(`strict allowlist: ${e}`), hiddenBases: fail(`hidden bases: ${e}`), hiddenQuotes: fail(`hidden quotes: ${e}`) };
  }
  const map = pickRenameMap(findRenameMaps(chunks), spotMeta);
  const committedIds = (committed.selector?.strict ?? []).map(([id]) => id);
  const strict = pickStrict(findIdLists(chunks), spotMeta, committedIds);
  const renameEntries = map.ok ? map.value : (committed.overrides?.entries ?? []);
  const strictIds = strict.ok ? strict.value.map(([id]) => id) : committedIds;
  const { bases, quotes } = pickHidden(findHiddenLists(chunks), spotMeta, {
    renameEntries,
    committed: committed.selector ?? null,
    strictIds,
  });
  return { map, strict, hiddenBases: bases, hiddenQuotes: quotes };
}

export const failures = (result) => Object.values(result).filter((r) => !r.ok).map((r) => r.error);

// ---- output files -------------------------------------------------------------
const J = JSON.stringify;

export const DEFAULT_OVERRIDES_COMMENT =
  "HL's spot display-name map, extracted verbatim from its production bundle (Mainnet section). DO NOT EDIT BY HAND — scripts/sync-spot-overrides.mjs re-scrapes and rewrites this file (the canary workflow, twice a day). Entries are [tokenIndex, l1Name, displayName]; markets.ts double-checks l1Name at runtime so an index reshuffle degrades to the raw name instead of mislabeling.";
export const DEFAULT_SELECTOR_COMMENT =
  "HL's spot SELECTOR lists, extracted verbatim from its production bundle (Mainnet). `strict`: the picker's Strict allowlist — BASE-token tokenIds (spotMeta.tokens[].tokenId, HL's selector field `spotId`); every pair on a listed base passes Strict. Entries are [tokenId, l1NameAtSync]; the name is documentation only, runtime matches on the exact tokenId. `hiddenBases` / `hiddenQuotes`: tokens HL hides from every selector surface (compared upper-cased against the displayed token name). DO NOT EDIT BY HAND — scripts/sync-spot-overrides.mjs re-scrapes and rewrites this file (canary job).";

/** spotOverrides.json, byte-compatible with the committed layout. */
export function formatOverrides({ comment, source, syncedAt, entries }) {
  const rows = entries.map((e, k) => `    [${e.map((v) => J(v)).join(', ')}]${k < entries.length - 1 ? ',' : ''}`);
  return ['{', `  "comment": ${J(comment)},`, `  "source": ${J(source)},`, `  "syncedAt": ${J(syncedAt)},`, ...(rows.length ? ['  "entries": [', ...rows, '  ]'] : ['  "entries": []']), '}', ''].join('\n');
}

/** spotSelector.json, the layout the runtime and reviewers read. */
export function formatSelector({ comment, source, syncedAt, strict, hiddenBases, hiddenQuotes }) {
  const rows = strict.map(([id, name], k) => `    [${J(id)}, ${J(name ?? null)}]${k < strict.length - 1 ? ',' : ''}`);
  return [
    '{',
    `  "comment": ${J(comment)},`,
    '  "source": {',
    `    "strict": ${J(source.strict)},`,
    `    "hidden": ${J(source.hidden)}`,
    '  },',
    `  "syncedAt": ${J(syncedAt)},`,
    ...(rows.length ? ['  "strict": [', ...rows, '  ],'] : ['  "strict": [],']),
    `  "hiddenBases": [${hiddenBases.map((s) => J(s)).join(', ')}],`,
    `  "hiddenQuotes": [${hiddenQuotes.map((s) => J(s)).join(', ')}]`,
    '}',
    '',
  ].join('\n');
}

const setDiff = (next, cur, key = (x) => J(x)) => {
  const c = new Set(cur.map(key));
  const n = new Set(next.map(key));
  return { added: next.filter((x) => !c.has(key(x))), removed: cur.filter((x) => !n.has(key(x))) };
};
const sameSet = (a, b, key = (x) => J(x)) => a.length === b.length && sortedKey(a.map(key)) === sortedKey(b.map(key));

/**
 * Decide what to write. A file is rewritten only when its CONTENT changed —
 * the rename entries as a set, the Strict id set, or either hidden set —
 * never for a new syncedAt, source or order alone (every rewrite is a
 * commit, and every commit to main is a production deploy). A section that
 * failed keeps its committed value (and source); the sections that validated
 * are still written. Returns { overrides, selector }, each
 * { text: string|null, changes: string[] }.
 */
export function planWrites({ result, committed = {}, now = new Date().toISOString() }) {
  const out = { overrides: { text: null, changes: [] }, selector: { text: null, changes: [] } };

  const curMap = committed.overrides?.entries ?? [];
  if (result.map.ok && !(committed.overrides && sameSet(result.map.value, curMap))) {
    const { added, removed } = setDiff(result.map.value, curMap);
    out.overrides.changes.push(`rename map: +${added.length} ${J(added)} -${removed.length} ${J(removed)}`);
    out.overrides.text = formatOverrides({
      comment: committed.overrides?.comment ?? DEFAULT_OVERRIDES_COMMENT,
      source: result.map.source,
      syncedAt: now,
      entries: result.map.value,
    });
  }

  const cur = committed.selector ?? null;
  const curStrict = cur?.strict ?? [];
  const curBases = cur?.hiddenBases ?? [];
  const curQuotes = cur?.hiddenQuotes ?? [];
  const next = {
    strict: result.strict.ok ? result.strict.value : curStrict,
    hiddenBases: result.hiddenBases.ok ? result.hiddenBases.value : curBases,
    hiddenQuotes: result.hiddenQuotes.ok ? result.hiddenQuotes.value : curQuotes,
  };
  const byId = ([id]) => id;
  const changes = [];
  if (!sameSet(next.strict, curStrict, byId)) {
    const { added, removed } = setDiff(next.strict, curStrict, byId);
    changes.push(`strict allowlist: +${added.length} ${J(added)} -${removed.length} ${J(removed)}`);
  }
  for (const k of ['hiddenBases', 'hiddenQuotes']) {
    const cv = k === 'hiddenBases' ? curBases : curQuotes;
    if (!sameSet(next[k], cv)) {
      const { added, removed } = setDiff(next[k], cv);
      changes.push(`${k}: +${J(added)} -${J(removed)}`);
    }
  }
  if (changes.length > 0 || !cur) {
    const hiddenSources = [result.hiddenBases, result.hiddenQuotes].filter((r) => r.ok).map((r) => r.source);
    out.selector.changes = changes.length ? changes : ['spotSelector.json created'];
    out.selector.text = formatSelector({
      comment: cur?.comment ?? DEFAULT_SELECTOR_COMMENT,
      source: {
        strict: result.strict.ok ? result.strict.source : (cur?.source?.strict ?? ''),
        hidden: hiddenSources.length ? [...new Set(hiddenSources)].join(' + ') : (cur?.source?.hidden ?? ''),
      },
      syncedAt: now,
      ...next,
    });
  }
  return out;
}
