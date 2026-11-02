// Syncs the spot lists Hyperliquid hardcodes in its frontend bundle — no API
// exposes any of them — into two checked-in files:
//
//   src/lib/hl/spotOverrides.json  the spot DISPLAY-NAME map (UBTC→BTC,
//     USDT0→USDT, UANSEM→ANSEM …): [tokenIndex, l1Name, displayName] rows,
//     HL's `Mainnet:[<fn>(197,`UBTC`,`BTC`),…]` (config-*.js today).
//   src/lib/hl/spotSelector.json   the picker's SELECTOR lists:
//     `strict` — the Strict toggle's allowlist of BASE-token tokenIds
//       (spotMeta.tokens[].tokenId; HL's selector row field `spotId` is the
//       pair's base token id, so every pair on a listed base passes), HL's
//       `<v>=<o>.chain===`Mainnet`?`0x….0x…`.split(`.`):[…testnet…]`
//       (series-*.js today), written as [tokenId, l1NameAtSync] in HL's order;
//     `hiddenBases` / `hiddenQuotes` — tokens HL hides from every selector
//       surface, `L=[`XMR1`,`FXMR`];function f(e){return L.includes(e.toUpperCase())}`
//       and its USDH twin (config-*.js today).
//
// DISCOVERY. app.hyperliquid.xyz is a Vite build (since 2026-08, replacing a
// CRA build whose `/static/js/main.*.js` bundle is gone). Every /assets/*.js
// the HTML references — the module entry plus the ~46 modulepreload links,
// quoted or not — is fetched (level 0: ~47 chunks / ~5.7 MB). Only when an
// anchor is missing there are the chunks those chunks import followed one
// level deeper (a list moving into a lazily imported chunk; a forced follow
// scans ~280 files / ~9 MB). Capped at MAX_FILES (1000) / MAX_BYTES (60 MB);
// a scan the caps cut short fails the run as "discovery INCOMPLETE" — never
// transient, raise the cap. No regex keys on a chunk name, a minified
// identifier or a quote style: all of them change between HL builds (the
// map helper was `s`, then `ng`, now `Ah`).
//
// VALIDATION — against live spotMeta, which is what tells Mainnet data from
// Testnet data (never key order, gate direction or identifier names):
//   rename map  exactly one distinct `Mainnet:[…]` block that uses ONE helper
//               identifier, has >= MIN_MAP_ENTRIES (20) rows, every index
//               holds its claimed l1 name, every display name matches
//               DISPLAY_RE, no index twice.
//   strict      exactly one distinct list of 0x<32 hex> ids (split-string or
//               array-literal form) with >= MIN_STRICT_IDS (40) ids of which
//               >= 90% are live mainnet tokenIds; if several qualify, the one
//               in a chain===Mainnet true branch of the chunk that filters on
//               `.spotId` wins, else fail. No duplicate ids. Against the
//               committed list (a SET guard, not a count guard): keep >= 80%
//               of the committed ids and add at most max(10, 50% of them),
//               else it was replaced/grew wholesale and a human looks first.
//               Ids not (yet) live are kept with a null name — HL can
//               hardcode a listing ahead of time; an unmatched id costs
//               nothing.
//   hidden      the quotes list is the one whose every entry is a live token
//               that quotes some pair; the bases list is the other. If that
//               is not decisive (a third matching list, both/neither
//               quote-shaped) membership decides: USDH → quotes, XMR1 →
//               bases. Each must be non-empty and display-name shaped
//               (DISPLAY_RE — HL compares against DISPLAYED names such as
//               ANSEM-19); every hidden quote must be a live spot token
//               name. Then, per list: the anchors never cross (no XMR1 among
//               quotes, no USDH among bases); a CHANGED list must keep its
//               anchor or share an entry with the committed one (no
//               wholesale replacement); no hidden base may be on the Strict
//               allowlist.
// The pure extractors/validators live in scripts/lib/hlBundleLists.mjs
// (vitest-pinned by hlBundleLists.test.mjs); this file does the I/O.
//
// WRITES. A file is rewritten only when its CONTENT changed — the rename
// rows as a set, the Strict id set, either hidden set — never for syncedAt,
// source or order alone: the canary commits a rewrite, and every commit to
// main is a production deploy. A list that fails keeps its committed value;
// the lists that validated are still written (partial update).
//
// Exit codes (consumed by .github/workflows/canary.yml, which decides
// "updated" from `git diff`, not from the exit code):
//   0 = every list extracted and validated (whether or not a file changed)
//   2 = at least one list failed — one human-readable line per failure on
//       stderr (the workflow files them as the issue body); validated lists
//       were still written. Prod keeps the last-known lists; the runtime
//       degrades to raw names / no Strict change for anything new.
//
// Usage: node scripts/sync-spot-overrides.mjs [--local DIR] [--spotmeta FILE]
//   --local DIR      read DIR/index.html and DIR/<chunk>.js instead of HL's CDN
//   --spotmeta FILE  validate against a saved spotMeta response
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractAll, failures, loadBundle, MAX_BYTES, MAX_FILES, planWrites } from './lib/hlBundleLists.mjs';

const OVERRIDES = new URL('../src/lib/hl/spotOverrides.json', import.meta.url);
const SELECTOR = new URL('../src/lib/hl/spotSelector.json', import.meta.url);
const APP = 'https://app.hyperliquid.xyz';
const INFO = 'https://api.hyperliquid.xyz/info';
const UA = { 'user-agent': 'purrwall-canary (+https://purrwall.xyz)' };

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i === -1 ? undefined : args[i + 1];
};
const LOCAL = opt('--local');
const SPOTMETA_FILE = opt('--spotmeta');

const log = (...a) => console.log(...a);

/** fetch with a deadline and one retry on network errors / 5xx; null on a
 *  non-OK answer (a missing chunk is data for the caller, not a crash) */
async function fetchOk(url, init = {}) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
      if (res.status < 500) return null;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`${url}: ${last?.message ?? last}`);
}

async function getText(path) {
  if (LOCAL) {
    const f = path === '/' ? join(LOCAL, 'index.html') : join(LOCAL, path.replace(/^\/assets\//, ''));
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  }
  const res = await fetchOk(`${APP}${path}`, { headers: UA });
  return res ? res.text() : null;
}

async function getSpotMeta() {
  if (SPOTMETA_FILE) return JSON.parse(readFileSync(SPOTMETA_FILE, 'utf8'));
  const res = await fetchOk(INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'spotMeta' }),
  });
  if (!res) throw new Error('spotMeta request rejected');
  return res.json();
}

const readJson = (url) => {
  try {
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return null;
  }
};

const problems = [];
try {
  const [bundle, spotMeta] = await Promise.all([loadBundle(getText), getSpotMeta()]);
  log(
    `discovery: ${bundle.level0.length} /assets/*.js refs in index.html; scanned ${bundle.chunks.size} chunks, ` +
      `${(bundle.bytes / 1e6).toFixed(2)} MB` +
      (bundle.depth ? ` (followed imports one level deeper: ${bundle.missingAtLevel0.join(', ')} missing at level 0)` : ''),
  );
  const committed = { overrides: readJson(OVERRIDES), selector: readJson(SELECTOR) };
  const result = extractAll({ chunks: bundle.chunks, spotMeta, committed });
  const labels = { map: 'map', strict: 'strict', hiddenBases: 'hidden bases', hiddenQuotes: 'hidden quotes' };
  for (const [k, r] of Object.entries(result)) {
    for (const n of r.notes ?? []) log(`${labels[k]}: ${n}`);
    if (r.ok) {
      const v = k === 'strict' || k === 'map' ? `${r.value.length} entries` : JSON.stringify(r.value);
      log(`${labels[k]}: ok, ${v} from ${r.source}`);
    } else log(`${labels[k]}: FAILED`);
  }

  const plan = planWrites({ result, committed });
  for (const [file, url, p] of [
    ['spotOverrides.json', OVERRIDES, plan.overrides],
    ['spotSelector.json', SELECTOR, plan.selector],
  ]) {
    if (p.text === null) {
      log(`${file}: unchanged`);
      continue;
    }
    writeFileSync(url, p.text);
    for (const c of p.changes) log(`${file}: WRITTEN — ${c}`);
  }

  problems.push(...failures(result));
  // An incomplete scan is a failure on its own — even if every list validated,
  // an unscanned chunk could hold the conflicting list the ambiguity checks
  // exist for — and it is never transient: the next run hits the same cap.
  if (bundle.capped) {
    const { level, wanted, unscanned } = bundle.capped;
    problems.push(
      `discovery INCOMPLETE: ${unscanned} of ${wanted} level-${level} chunks not scanned (caps: MAX_FILES=${MAX_FILES} files, MAX_BYTES=${MAX_BYTES / 1e6} MB; scanned ${bundle.chunks.size} files / ${(bundle.bytes / 1e6).toFixed(2)} MB) — raise the cap in scripts/lib/hlBundleLists.mjs; not transient`,
    );
  }
  if (problems.length > 0 && bundle.failed.length > 0) {
    problems.push(
      `discovery: ${bundle.failed.length} chunk fetch(es) failed (${bundle.failed.slice(0, 5).join(', ')}${bundle.failed.length > 5 ? ', …' : ''}) — a failure above may be transient rather than a bundle change`,
    );
  }
} catch (err) {
  problems.push(`sync-spot-overrides: ${err?.message ?? err} — nothing was validated or written this run`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(2);
}
log('sync ok');
