/*
 * Formula cells — the PURE grammar half. Everything here is DOM-free and
 * imports nothing from ws/info, so vitest loads it without the vi.mock recipe
 * and the picker can call it on every keystroke.
 *
 * Pipeline: normalizeInput → tokenize (RUN-then-longest-prefix against a
 * NameIndex) → recursive-descent parser with positioned errors → Ast → three
 * printers (canonical id / compact header text / typeable edit text) →
 * compile to a closure tree for the bar math in ./compose.ts.
 *
 * Grammar (EBNF):
 *   formula = expr EOF ;
 *   expr    = term { ("+" | "-") term } ;          left-assoc
 *   term    = unary { ("*" | "/") unary } ;        left-assoc; no ^, no functions,
 *                                                  no implicit multiplication
 *   unary   = "-" unary | primary ;                "--A" folds to A (two unary
 *                                                  signs cancel); "A--B" is
 *                                                  A - (-B) per the grammar
 *   primary = number | symbol | "(" expr ")" ;
 *   number  = digits [ "." digits ] | "." digits ; no sign, no exponent ('1e3'
 *                                                  is rejected: HL names carry
 *                                                  E+digits)
 *   symbol  = "[" id "]" | run-resolved ;          see tokenize()
 *
 * Why RUN-then-longest-prefix and not plain longest-match: '/' and '-' are both
 * operators AND legal inside HL display names ('HYPE/USDC', 'PUMP-26/USDC',
 * 'TSLA-USDC'), so a run of name characters is read whole and the LONGEST
 * prefix that is an index key wins ('HYPE/USDC' → the spot pair, 'HYPE/ETH' →
 * HYPE ÷ ETH). An unresolved word then surfaces as ONE chip the row list can
 * filter by, instead of a spray of one-letter errors.
 *
 * Keywords (perpConciseAnnotations aliases) NEVER enter the NameIndex: a
 * keyword can name a different market entirely (HL has mapped 'ETH' →
 * xyz:BMNR and 'purr' → xyz:PURRDAT) and would silently hijack real names.
 * They stay useful as the ROW FILTER for an unresolved chip (MarketTable
 * already matches them).
 */
import type { Market } from './types';

export const MAX_LEGS = 4;
/** Canonical-id cap. The sync worker clamps a cell's coin to exactly this
 *  (worker/index.js sanitizeSyncDoc): a 4-leg formula with parens and
 *  constants over 14-char HIP-3 ids measures 69–71 chars, and a shorter
 *  clamp would null such cells on the paired device with no error. */
export const MAX_ID_LEN = 96;
/** Raw-input guard so a pasted novel cannot recurse the parser; a legitimate
 *  formula is under 96 chars canonical and cannot be longer than this even
 *  with whitespace and redundant parentheses. */
const MAX_INPUT_LEN = 512;

/** Parser-shaped tree: `num` holds a non-negative constant (a leading '-' is a
 *  `neg`), and every printer folds a double `neg`, so a hand-built tree prints
 *  exactly like the parser's. */
export type Ast =
  | { t: 'num'; v: number }
  | { t: 'sym'; coin: string }
  | { t: 'neg'; a: Ast }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; a: Ast; b: Ast };

export interface NameIndex {
  /** Alias → coin, or the dex-qualified candidates when a bare HIP-3 base
   *  lives on several dexs, or null. Case-insensitive. */
  resolve(alias: string): { coin: string } | { ambiguous: string[] } | null;
  /** Shortest unambiguous TYPEABLE alias: bare base, dex:base when ambiguous,
   *  BASE/QUOTE for spot. Unknown coins come back verbatim. */
  aliasFor(coin: string): string;
  /** Header form: perp base 'HYPE', spot pair 'HYPE/USDC', HIP-3 base or
   *  dex:base when the base is ambiguous. Unknown coins come back verbatim. */
  displayOf(coin: string): string;
  /** The PUMP-26 case: a hyphenated spot display BASE typed without its quote
   *  ('exact'), or a BASE-<digits> run still being typed toward one
   *  ('prefix'). Such a run must never parse as BASE − digits. */
  spotBaseRun(run: string): 'exact' | 'prefix' | null;
}

export type FormulaReason =
  | 'unknown'
  | 'ambiguous'
  | 'too_many_legs'
  | 'missing_operand'
  | 'unbalanced'
  | 'hip4'
  | 'unexpected'
  | 'too_long'
  | 'div_zero'
  | 'no_market';

export interface Token {
  kind: 'sym' | 'num' | 'op' | 'lparen' | 'rparen' | 'unresolved' | 'ambiguous';
  /** normalized source text; for '[id]' the id without its brackets */
  text: string;
  /** [start, end) in the input — normalizeInput is length-preserving, so these
   *  index the raw string the user typed as well */
  start: number;
  end: number;
  coin?: string;
  candidates?: string[];
}

export interface ParseOk {
  ok: true;
  ast: Ast;
  /** distinct coin ids, first-appearance order, ≤ MAX_LEGS */
  legs: string[];
  /** '=…' or, for a single bare symbol, the plain coin id */
  canonical: string;
  single: boolean;
  tokens: Token[];
}

export interface ParseErr {
  ok: false;
  reason: FormulaReason;
  start: number;
  end: number;
  word?: string;
  candidates?: string[];
  tokens: Token[];
}

/* ─── normalization ─── */

/**
 * Pre-lex character map. LENGTH-PRESERVING by construction (one UTF-16 unit
 * in, one out) so token positions and caret anchors index the raw input.
 * × ÷ and every Unicode dash fold to ASCII operators; an em dash is ONE minus
 * (iOS Smart Punctuation rewrites '--' into one — two consecutive minus signs
 * are only reachable as '- -' or via the operator keys); fullwidth
 * punctuation/digits/letters (Pinyin IME in fullwidth mode) fold to ASCII;
 * NBSP and the ideographic space become a plain space.
 */
export function normalizeInput(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out += s[i];
      continue;
    }
    if (c === 0x00d7) out += '*';
    else if (c === 0x00f7) out += '/';
    else if (c === 0x2212 || (c >= 0x2010 && c <= 0x2015) || c === 0xfe63 || c === 0xff0d) out += '-';
    else if (c === 0x00a0 || c === 0x3000) out += ' ';
    else if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0); // fullwidth ASCII block
    else out += s[i];
  }
  return out;
}

/* ─── name index ─── */

const RUN_START = /[A-Za-z0-9:@&.]/;
const RUN_CHAR = /[A-Za-z0-9:@&./-]/;
const NUM_RE = /^(\d+(\.\d+)?|\.\d+)$/;
/** The alphabet of HL's perp, spot and HIP-3 coin ids (coinKindOf in
 *  types.ts). A leg outside it could never be read back from a canonical id,
 *  so the parser refuses it and parseCanonical's brackets admit nothing
 *  else — a hand-edited hash cannot smuggle '#10' or arbitrary bytes into
 *  legs. */
const ID_CHARS_RE = /^[A-Za-z0-9:@/]+$/;
/** An alias the tokenizer can actually read back as one run. */
const TYPEABLE_RE = /^[A-Za-z0-9:@&.][A-Za-z0-9:@&./-]*$/;

interface IndexEntry {
  coins: string[];
  /** 0 = owns the key outright (perp bare/display, every coin id, spot);
   *  1 = HIP-3 derived names, which yield to a perp and go ambiguous among
   *  themselves. HL's own convention: the bare STX is the perp and its HIP-3
   *  twin is only ever written dex-qualified. */
  rank: number;
}

interface Known {
  kind: 'perp' | 'spot' | 'hip3';
  display: string;
  dex: string;
  /** display base for HIP-3 ('S&P500'), bare coin base otherwise */
  base: string;
}

/**
 * One index per catalog. Keys (lowercased): perp → coin ('HYPE') + display
 * ('HYPE-USDC'); spot → coin ('@142', 'PURR/USDC') + display ('BTC/USDC',
 * 'PUMP-26/USDC') — spot is ALWAYS written BASE/QUOTE, so a bare name never
 * means spot; HIP-3 → coin ('dex:TSLA'), coin base and display base
 * ('TSLA', 'S&P500'), display ('TSLA-USDC') and dex:displayBase. A shared key
 * goes to the perp; two HIP-3 dexs sharing a base make it ambiguous. HIP-4
 * (and any other kind) never enters.
 */
export function buildNameIndex(markets: Market[]): NameIndex {
  const map = new Map<string, IndexEntry>();
  const known = new Map<string, Known>();
  const hyphenBases = new Set<string>();

  const insert = (key: string, coin: string, rank: number) => {
    const k = key.toLowerCase();
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { coins: [coin], rank });
      return;
    }
    if (cur.coins.includes(coin) || cur.rank < rank) return;
    if (cur.rank > rank) {
      map.set(k, { coins: [coin], rank });
      return;
    }
    cur.coins.push(coin);
  };

  for (const m of markets) {
    if (m.kind === 'perp') {
      insert(m.coin, m.coin, 0);
      insert(m.display, m.coin, 0);
      known.set(m.coin, { kind: 'perp', display: m.display, dex: '', base: m.coin });
    } else if (m.kind === 'spot') {
      insert(m.coin, m.coin, 0);
      insert(m.display, m.coin, 0);
      const base = m.display.split('/')[0];
      if (base.includes('-')) hyphenBases.add(base.toLowerCase());
      known.set(m.coin, { kind: 'spot', display: m.display, dex: '', base });
    } else if (m.kind === 'hip3') {
      const colon = m.coin.indexOf(':');
      const dex = m.dex ?? (colon > 0 ? m.coin.slice(0, colon) : '');
      const coinBase = m.coin.slice(colon + 1);
      const dispBase = m.display.endsWith('-USDC') ? m.display.slice(0, -5) : m.display;
      insert(m.coin, m.coin, 0);
      insert(coinBase, m.coin, 1);
      insert(`${coinBase}-USDC`, m.coin, 1);
      insert(dispBase, m.coin, 1);
      insert(m.display, m.coin, 1);
      if (dex) insert(`${dex}:${dispBase}`, m.coin, 1);
      known.set(m.coin, { kind: 'hip3', display: m.display, dex, base: dispBase });
    }
  }

  const resolve: NameIndex['resolve'] = (alias) => {
    const e = map.get(alias.toLowerCase());
    if (!e) return null;
    return e.coins.length === 1 ? { coin: e.coins[0] } : { ambiguous: e.coins.slice() };
  };
  const owns = (alias: string, coin: string) => {
    const r = resolve(alias);
    return r !== null && 'coin' in r && r.coin === coin;
  };

  return {
    resolve,
    aliasFor(coin) {
      const k = known.get(coin);
      if (!k) return coin;
      if (k.kind === 'perp') return coin;
      if (k.kind === 'spot') return owns(k.display, coin) ? k.display : coin;
      if (TYPEABLE_RE.test(k.base) && owns(k.base, coin)) return k.base;
      const coinBase = coin.slice(coin.indexOf(':') + 1);
      if (owns(coinBase, coin)) return coinBase;
      return coin;
    },
    displayOf(coin) {
      const k = known.get(coin);
      if (!k) return coin;
      if (k.kind === 'perp') return coin;
      if (k.kind === 'spot') return k.display;
      return owns(k.base, coin) ? k.base : `${k.dex}:${k.base}`;
    },
    spotBaseRun(run) {
      if (hyphenBases.size === 0) return null;
      const lower = run.toLowerCase();
      if (hyphenBases.has(lower)) return 'exact';
      if (!/-\d*$/.test(lower)) return null;
      for (const hb of hyphenBases) if (hb.length > lower.length && hb.startsWith(lower)) return 'prefix';
      return null;
    },
  };
}

/** Catalog-less index: nothing resolves. Lets isFormulaTrigger degrade
 *  gracefully before the catalog has loaded. */
const EMPTY_INDEX: NameIndex = {
  resolve: () => null,
  aliasFor: (c) => c,
  displayOf: (c) => c,
  spotBaseRun: () => null,
};

/* ─── lexer ─── */

interface LexErr {
  reason: FormulaReason;
  start: number;
  end: number;
}

function lex(src: string, index: NameIndex): { tokens: Token[]; err: LexErr | null } {
  const tokens: Token[] = [];
  const n = src.length;
  let p = 0;
  while (p < n && isWs(src[p])) p++;
  // a pasted canonical id: one leading '=' is accepted, never shown or inserted
  if (p < n && src[p] === '=') p++;

  while (p < n) {
    const ch = src[p];
    if (isWs(ch)) {
      p++;
      continue;
    }
    if (ch === '[') {
      const close = src.indexOf(']', p + 1);
      if (close === -1) return { tokens, err: { reason: 'unbalanced', start: p, end: p + 1 } };
      const inner = src.slice(p + 1, close);
      if (!inner) return { tokens, err: { reason: 'unexpected', start: p, end: close + 1 } };
      if (inner.includes('#')) return { tokens, err: { reason: 'hip4', start: p, end: close + 1 } };
      tokens.push(symToken(inner, p, close + 1, index.resolve(inner)));
      p = close + 1;
      continue;
    }
    if (ch === '#') {
      // HIP-4 outcome markets cannot be combined
      let q = p + 1;
      while (q < n && /[0-9A-Za-z:@]/.test(src[q])) q++;
      return { tokens, err: { reason: 'hip4', start: p, end: q } };
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', text: ch, start: p, end: p + 1 });
      p++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ kind: ch === '(' ? 'lparen' : 'rparen', text: ch, start: p, end: p + 1 });
      p++;
      continue;
    }
    if (!RUN_START.test(ch)) return { tokens, err: { reason: 'unexpected', start: p, end: p + 1 } };

    // RUN-then-longest-prefix: read the whole run of name characters, then
    // try the run and every prefix ending just before an inner '/' or '-',
    // longest first. The chosen prefix is the token; the remainder lexes on.
    let q = p;
    while (q < n && RUN_CHAR.test(src[q])) q++;
    const run = src.slice(p, q);
    const cuts: number[] = [];
    for (let i = 1; i < run.length; i++) if (run[i] === '/' || run[i] === '-') cuts.push(i);
    cuts.push(run.length);
    let taken = 0;
    for (let ci = cuts.length - 1; ci >= 0 && !taken; ci--) {
      const cand = run.slice(0, cuts[ci]);
      const r = index.resolve(cand);
      if (r) {
        tokens.push(symToken(cand, p, p + cand.length, r));
        taken = cand.length;
      } else if (cand.includes('-') && index.spotBaseRun(cand)) {
        // 'PUMP-26' typed without its quote is the spot base, never PUMP − 26
        tokens.push({ kind: 'unresolved', text: cand, start: p, end: p + cand.length });
        taken = cand.length;
      }
    }
    if (taken) {
      p += taken;
      continue;
    }
    const first = run.slice(0, cuts[0]);
    if (NUM_RE.test(first)) {
      const v = Number(first);
      // ≥1e21 would print in exponent form, which the canonical grammar has no
      // room for; nobody scales a chart by a 22-digit constant
      if (!Number.isFinite(v) || Math.abs(v) >= 1e21) {
        return { tokens, err: { reason: 'unexpected', start: p, end: p + first.length } };
      }
      tokens.push({ kind: 'num', text: first, start: p, end: p + first.length });
      p += first.length;
      continue;
    }
    // number-shaped garbage ('2ZEC', '1e3', '5.') is a syntax error at the
    // position; a word-shaped miss becomes an unresolved chip the row list
    // can filter by (keywords apply there)
    if (/^[0-9.]/.test(first)) {
      return { tokens, err: { reason: 'unexpected', start: p, end: p + first.length } };
    }
    tokens.push({ kind: 'unresolved', text: first, start: p, end: p + first.length });
    p += first.length;
  }
  return { tokens, err: null };
}

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function symToken(
  text: string,
  start: number,
  end: number,
  r: ReturnType<NameIndex['resolve']>,
): Token {
  if (!r) return { kind: 'unresolved', text, start, end };
  if ('coin' in r) return { kind: 'sym', text, start, end, coin: r.coin };
  return { kind: 'ambiguous', text, start, end, candidates: r.ambiguous };
}

/** Tokens only — the parser's view of the input. A lexer error truncates the
 *  list at the offending character; use parseFormula for the reason. */
export function tokenize(input: string, index: NameIndex): Token[] {
  return lex(normalizeInput(input), index).tokens;
}

/* ─── parser ─── */

class ParseFail {
  reason: FormulaReason;
  start: number;
  end: number;
  word?: string;
  candidates?: string[];
  constructor(reason: FormulaReason, start: number, end: number, word?: string, candidates?: string[]) {
    this.reason = reason;
    this.start = start;
    this.end = end;
    this.word = word;
    this.candidates = candidates;
  }
}

type Spanned = { node: Ast; s: number; e: number };

function parseTokens(toks: Token[], eof: number): { root: Ast; legs: string[] } {
  const legs: string[] = [];
  let i = 0;

  const failAt = (t: Token, reason: FormulaReason) =>
    new ParseFail(reason, t.start, t.end, undefined);

  /** A token where an operand should have been: the reason is the token's own
   *  when it is a word problem, else the structural one. */
  const badToken = (t: Token): ParseFail => {
    if (t.kind === 'unresolved') return new ParseFail('unknown', t.start, t.end, t.text);
    if (t.kind === 'ambiguous') return new ParseFail('ambiguous', t.start, t.end, t.text, t.candidates);
    if (t.kind === 'rparen') return failAt(t, 'unbalanced');
    return failAt(t, 'unexpected');
  };

  /** Operand missing after an operator / '(' (or at the very start): blame the
   *  operator that lacks it — the UI says "Missing a market after ÷". */
  const missing = (): ParseFail => {
    const prev = toks[i - 1];
    if (prev && (prev.kind === 'op' || prev.kind === 'lparen')) return failAt(prev, 'missing_operand');
    const cur = toks[i];
    // a ')' with no operator before it to blame is simply unbalanced
    if (cur?.kind === 'rparen') return failAt(cur, 'unbalanced');
    if (cur) return failAt(cur, 'missing_operand');
    return new ParseFail('missing_operand', eof, eof);
  };

  const primary = (): Spanned => {
    const t = toks[i];
    if (!t) throw missing();
    switch (t.kind) {
      case 'num':
        i++;
        return { node: { t: 'num', v: Number(t.text) }, s: t.start, e: t.end };
      case 'sym': {
        const coin = t.coin!;
        if (!ID_CHARS_RE.test(coin)) throw failAt(t, 'unexpected');
        if (!legs.includes(coin)) {
          if (legs.length >= MAX_LEGS) throw failAt(t, 'too_many_legs');
          legs.push(coin);
        }
        i++;
        return { node: { t: 'sym', coin }, s: t.start, e: t.end };
      }
      case 'lparen': {
        i++;
        const next = toks[i];
        if (!next) throw failAt(t, 'unbalanced');
        if (next.kind === 'rparen') throw failAt(t, 'missing_operand');
        const inner = expr();
        const close = toks[i];
        if (!close) throw failAt(t, 'unbalanced');
        if (close.kind !== 'rparen') throw badToken(close);
        i++;
        return { node: inner.node, s: t.start, e: close.end };
      }
      case 'unresolved':
      case 'ambiguous':
        throw badToken(t);
      default:
        // an operator or ')' where an operand belongs
        throw missing();
    }
  };

  const unary = (): Spanned => {
    const t = toks[i];
    if (t && t.kind === 'op' && t.text === '-') {
      i++;
      const a = unary();
      // "--A" folds: two unary signs cancel
      const node: Ast = a.node.t === 'neg' ? a.node.a : { t: 'neg', a: a.node };
      return { node, s: t.start, e: a.e };
    }
    return primary();
  };

  const term = (): Spanned => {
    let a = unary();
    for (;;) {
      const t = toks[i];
      if (!t || t.kind !== 'op' || (t.text !== '*' && t.text !== '/')) return a;
      i++;
      const b = unary();
      if (t.text === '/' && constValue(b.node) === 0) throw new ParseFail('div_zero', b.s, b.e);
      a = { node: { t: 'bin', op: t.text, a: a.node, b: b.node }, s: a.s, e: b.e };
    }
  };

  const expr = (): Spanned => {
    let a = term();
    for (;;) {
      const t = toks[i];
      if (!t || t.kind !== 'op' || (t.text !== '+' && t.text !== '-')) return a;
      i++;
      const b = term();
      a = { node: { t: 'bin', op: t.text, a: a.node, b: b.node }, s: a.s, e: b.e };
    }
  };

  const root = expr();
  const rest = toks[i];
  if (rest) throw badToken(rest);
  return { root: root.node, legs };
}

/** Value of a constant-only subtree, null when it references a market. */
function constValue(node: Ast): number | null {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'sym':
      return null;
    case 'neg': {
      const a = constValue(node.a);
      return a === null ? null : -a;
    }
    case 'bin': {
      const a = constValue(node.a);
      const b = constValue(node.b);
      if (a === null || b === null) return null;
      return node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : a / b;
    }
  }
}

/** The parser with its failure as a value. */
function tryParse(tokens: Token[], eof: number): { root: Ast; legs: string[] } | ParseFail {
  try {
    return parseTokens(tokens, eof);
  } catch (e) {
    if (e instanceof ParseFail) return e;
    throw e;
  }
}

function toParseErr(f: ParseFail, tokens: Token[]): ParseErr {
  const out: ParseErr = { ok: false, reason: f.reason, start: f.start, end: f.end, tokens };
  if (f.word !== undefined) out.word = f.word;
  if (f.candidates) out.candidates = f.candidates;
  return out;
}

/**
 * Parse user input against the catalog. Errors carry the first problem in
 * reading order with its [start, end) so the UI can mark the chip / move the
 * caret: a lexer error (a stray character, '#') truncates the token list, so
 * the tokens before it are parsed too and a word or structure problem that
 * sits earlier wins — except a missing operand or an open paren at the tail,
 * which the truncation itself may have caused. `tokens` is always the full
 * lex (up to a lexer error) so the preview strip can render every chip even
 * while the formula is not placeable.
 */
export function parseFormula(input: string, index: NameIndex): ParseOk | ParseErr {
  const src = normalizeInput(input);
  if (src.length > MAX_INPUT_LEN) {
    return { ok: false, reason: 'too_long', start: 0, end: src.length, tokens: [] };
  }
  const { tokens, err } = lex(src, index);
  const parsed = tryParse(tokens, src.length);
  if (err) {
    const earlier =
      parsed instanceof ParseFail &&
      parsed.start < err.start &&
      parsed.reason !== 'missing_operand' &&
      parsed.reason !== 'unbalanced';
    return earlier ? toParseErr(parsed, tokens) : { ok: false, ...err, tokens };
  }
  if (parsed instanceof ParseFail) return toParseErr(parsed, tokens);
  const { root, legs } = parsed;
  if (legs.length === 0) {
    return { ok: false, reason: 'no_market', start: 0, end: src.length, tokens };
  }
  const single = root.t === 'sym';
  const canon = root.t === 'sym' ? root.coin : canonical(root);
  if (canon.length > MAX_ID_LEN) {
    return { ok: false, reason: 'too_long', start: 0, end: src.length, tokens };
  }
  return { ok: true, ast: root, legs, canonical: canon, single, tokens };
}

/* ─── canonical ids ─── */

/** Ids that print bare in a canonical id. An all-digit id would read back as
 *  a number, so it takes brackets like an operator-bearing one does. */
const CANON_ID_RE = /^(?!\d+$)[A-Za-z0-9:@]+$/;

/**
 * Catalog-free parse of a canonical id (with or without its leading '=').
 * Symbols are maximal [A-Za-z0-9:@] runs (an all-digit run, optionally with a
 * '.digits' fraction, is a number — '2Z' is a symbol, '2' is not) or a
 * bracketed id over the coin-id alphabet. What makes the id SELF-DELIMITING:
 * a market that never loads can still be named and its legs enumerated.
 */
export function parseCanonical(id: string): { ast: Ast; legs: string[] } | null {
  if (id.length > MAX_INPUT_LEN) return null;
  const src = id.startsWith('=') ? id.slice(1) : id;
  const tokens: Token[] = [];
  const n = src.length;
  let p = 0;
  while (p < n) {
    const ch = src[p];
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', text: ch, start: p, end: p + 1 });
      p++;
    } else if (ch === '(' || ch === ')') {
      tokens.push({ kind: ch === '(' ? 'lparen' : 'rparen', text: ch, start: p, end: p + 1 });
      p++;
    } else if (ch === '[') {
      const close = src.indexOf(']', p + 1);
      if (close <= p + 1) return null;
      const inner = src.slice(p + 1, close);
      if (!ID_CHARS_RE.test(inner)) return null;
      tokens.push({ kind: 'sym', text: inner, start: p, end: close + 1, coin: inner });
      p = close + 1;
    } else if (/[A-Za-z0-9:@]/.test(ch)) {
      let q = p;
      while (q < n && /[A-Za-z0-9:@]/.test(src[q])) q++;
      let text = src.slice(p, q);
      if (/^\d+$/.test(text)) {
        if (src[q] === '.') {
          let r = q + 1;
          while (r < n && /\d/.test(src[r])) r++;
          if (r === q + 1) return null;
          text = src.slice(p, r);
          q = r;
        }
        tokens.push({ kind: 'num', text, start: p, end: q });
      } else {
        tokens.push({ kind: 'sym', text, start: p, end: q, coin: text });
      }
      p = q;
    } else {
      return null;
    }
  }
  const r = tryParse(tokens, n);
  return r instanceof ParseFail ? null : { ast: r.root, legs: r.legs };
}

/** Shape check for a stored/shared/synced id: '=' + canonical grammar, ≤96
 *  chars, 1–4 legs. Shape, not semantics — legs are not checked against the
 *  universe, the same stance taken on plain coin ids. */
export function isFormulaId(s: string): boolean {
  if (typeof s !== 'string' || s.length < 2 || s.length > MAX_ID_LEN || s[0] !== '=') return false;
  const r = parseCanonical(s);
  return r !== null && r.legs.length >= 1 && r.legs.length <= MAX_LEGS;
}

/* ─── printers ─── */

// binding strength: + - < * / < unary minus < leaf
const PREC_ADD = 1;
const PREC_MUL = 2;
const PREC_NEG = 3;
const PREC_LEAF = 4;

function prec(n: Ast): number {
  if (n.t === 'bin') return n.op === '+' || n.op === '-' ? PREC_ADD : PREC_MUL;
  return n.t === 'neg' ? PREC_NEG : PREC_LEAF;
}

/** Plain decimal text, never exponent form: String() flips to '1e-7' below
 *  1e-6, so its shortest round-trip digits are shifted into place by hand.
 *  Exact at every magnitude (toFixed(20) would turn 1e-21 into '0', which
 *  parseCanonical then refuses as a zero divisor); an absurdly small constant
 *  simply prints long and fails MAX_ID_LEN. */
function fmtNum(v: number): string {
  const s = String(v);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2] + (m[3] ?? '');
  const point = m[2].length + Number(m[4]); // digits left of the decimal point
  if (point <= 0) return `${m[1]}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return m[1] + digits + '0'.repeat(point - digits.length);
  return `${m[1]}${digits.slice(0, point)}.${digits.slice(point)}`;
}

interface Glyphs {
  add: string;
  sub: string;
  mul: string;
  div: string;
  neg: string;
  sym: (coin: string) => string;
  /** binary minus with a bare number on the right ('A - 2'): the edit form
   *  needs the spaces or 'PUMP-26' would read back as the shadowed spot base */
  spaceNumSub?: boolean;
}

const ASCII: Omit<Glyphs, 'sym'> = { add: '+', sub: '-', mul: '*', div: '/', neg: '-' };
const PRETTY: Omit<Glyphs, 'sym'> = { add: '+', sub: '−', mul: '×', div: '÷', neg: '−' };

/** Two unary signs cancel. The parser never builds the pair; folding here
 *  keeps the paren decisions below exact for hand-built trees too. */
function fold(node: Ast): Ast {
  let n = node;
  while (n.t === 'neg' && n.a.t === 'neg') n = n.a.a;
  return n;
}

/**
 * Minimal parentheses by precedence, exactly preserving the tree: a left
 * operand is wrapped when it binds looser, a right operand when it binds
 * looser OR EQUAL ('A-(B+C)', 'A/(B*2)', 'A-(B-C)' all keep theirs; '(A)/(B)'
 * → 'A/B'). Unary minus prints bare at the start / after '(' and as '(-X)'
 * after an operator.
 */
function print(node: Ast, g: Glyphs): string {
  const n = fold(node);
  switch (n.t) {
    case 'num':
      return fmtNum(n.v);
    case 'sym':
      return g.sym(n.coin);
    case 'neg': {
      const inner = print(n.a, g);
      return g.neg + (prec(n.a) < PREC_NEG ? `(${inner})` : inner);
    }
    case 'bin': {
      const p = prec(n);
      const a = fold(n.a);
      const b = fold(n.b);
      const l = print(a, g);
      const r = print(b, g);
      const left = prec(a) < p ? `(${l})` : l;
      const right = prec(b) <= p || b.t === 'neg' ? `(${r})` : r;
      const op = n.op === '+' ? g.add : n.op === '-' ? g.sub : n.op === '*' ? g.mul : g.div;
      if (n.op === '-' && g.spaceNumSub && b.t === 'num') return `${left} ${op} ${right}`;
      return left + op + right;
    }
  }
}

/** '=' + the tree over coin ids; brackets ONLY around an id carrying a char
 *  outside [A-Za-z0-9:@] — in practice '[PURR/USDC]' — or made of digits
 *  alone (none live). */
export function canonical(ast: Ast): string {
  return '=' + print(ast, { ...ASCII, sym: (c) => (CANON_ID_RE.test(c) ? c : `[${c}]`) });
}

/** Header/tooltip/chip text: ÷ × − + glyphs, no spaces, display bases. */
export function compactText(ast: Ast, displayOf: (coin: string) => string): string {
  return print(ast, { ...PRETTY, sym: displayOf });
}

/** The picker pre-fill: ASCII operators, typeable aliases (HIP-3 legs
 *  dex-qualified when their base is ambiguous). parseFormula(editText(x))
 *  yields x again. */
export function editText(ast: Ast, aliasFor: (coin: string) => string): string {
  return print(ast, { ...ASCII, sym: aliasFor, spaceNumSub: true });
}

/* ─── evaluation ─── */

/**
 * Closure tree — one call per bar vector, no allocation. vec[i] is the value
 * of legs[i]; the bar rule in compose.ts calls it four times per bar.
 */
export function compile(ast: Ast, legs: string[]): (vec: number[]) => number {
  const build = (n: Ast): ((vec: number[]) => number) => {
    switch (n.t) {
      case 'num': {
        const v = n.v;
        return () => v;
      }
      case 'sym': {
        const i = legs.indexOf(n.coin);
        if (i === -1) throw new Error(`formula leg not in legs: ${n.coin}`);
        return (vec) => vec[i];
      }
      case 'neg': {
        const f = build(n.a);
        return (vec) => -f(vec);
      }
      case 'bin': {
        const fa = build(n.a);
        const fb = build(n.b);
        switch (n.op) {
          case '+':
            return (vec) => fa(vec) + fb(vec);
          case '-':
            return (vec) => fa(vec) - fb(vec);
          case '*':
            return (vec) => fa(vec) * fb(vec);
          case '/':
            return (vec) => fa(vec) / fb(vec);
        }
      }
    }
  };
  return build(ast);
}

/* ─── picker helpers ─── */

/**
 * Does this query read as a formula? The picker's EMPTY state offers the ƒx
 * nudge on it; the mode itself is an explicit switch in MarketTable.
 * Tab-aware: never on the Outcome tab (its question rows legitimately
 * contain '/', '(', ')' and '-', and HIP-4 has no legs to offer). On market
 * tabs: the query contains + * / ( ) [ or starts with '=' — every one of
 * those returns zero rows in the plain picker — or a '-' whose LEFT token
 * resolves to a symbol (unique OR ambiguous: 'avgo-' must reach the
 * composer, where the chip and the dex-qualified row tap are the fix) or a
 * number, so 'e-c' keeps its keyword hit and 'PUMP-2…' (a shadowed spot
 * base being typed) stays a search. Without an index only the number case
 * can fire on '-'.
 */
export function isFormulaTrigger(q: string, tab: string, index: NameIndex = EMPTY_INDEX): boolean {
  if (tab === 'outcome') return false;
  const n = normalizeInput(q);
  if (n.trimStart().startsWith('=')) return true;
  if (/[+*/()[]/.test(n)) return true;
  if (!n.includes('-')) return false;
  const toks = lex(n, index).tokens;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];
    if (
      t.kind === 'op' &&
      t.text === '-' &&
      (prev.kind === 'sym' || prev.kind === 'ambiguous' || prev.kind === 'num')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The operand under the caret — what the row list filters by and what a row
 * tap replaces. With an index it is the lexer's token containing the anchor
 * (so 'aaa/usdc' and the shadowed 'ppp-26' stay whole while 'hype/eth' at the
 * end yields 'eth'); operators, parens and whitespace are never a token, so
 * the caret right after '/' gives an EMPTY token (start === end) = "pick the
 * next leg". Without an index: the maximal run of name characters with '/'
 * and '-' read as operators. Positions index the raw input.
 */
export function caretToken(
  q: string,
  anchor: number,
  index?: NameIndex,
): { start: number; end: number; text: string } {
  const n = normalizeInput(q);
  const a = Math.max(0, Math.min(anchor, n.length));
  if (index) {
    let hit: Token | undefined;
    for (const t of lex(n, index).tokens) {
      if (t.kind === 'op' || t.kind === 'lparen' || t.kind === 'rparen') continue;
      if (t.start <= a && a <= t.end && (!hit || t.start === a)) hit = t;
    }
    if (hit) return { start: hit.start, end: hit.end, text: n.slice(hit.start, hit.end) };
    return { start: a, end: a, text: '' };
  }
  let start = a;
  while (start > 0 && RUN_START.test(n[start - 1])) start--;
  let end = a;
  while (end < n.length && RUN_START.test(n[end])) end++;
  return { start, end, text: n.slice(start, end) };
}

/** Replace [start, end) with `text`; the caret lands right after it (before
 *  any separator, so the caret token is the inserted alias and a mis-tap is
 *  fixed by tapping the sibling row). A name butting against a following '-'
 *  gets a space: 'aaa-2' with its left leg replaced by PPP would otherwise
 *  read 'PPP-2', which the shadowed-spot-base rule keeps as one unresolved
 *  run instead of PPP − 2. */
export function replaceToken(
  q: string,
  start: number,
  end: number,
  text: string,
): { q: string; caret: number } {
  const s = Math.max(0, Math.min(start, q.length));
  const e = Math.max(s, Math.min(end, q.length));
  const sep = text !== '' && RUN_START.test(text[text.length - 1]) && q[e] === '-' ? ' ' : '';
  return { q: q.slice(0, s) + text + sep + q.slice(e), caret: s + text.length };
}

/** Remove [start, end). A doubled space left behind collapses to one, and a
 *  query with nothing but whitespace left becomes '' (an empty query does
 *  not leave formula mode). */
export function deleteToken(q: string, start: number, end: number): { q: string; caret: number } {
  const s = Math.max(0, Math.min(start, q.length));
  const e = Math.max(s, Math.min(end, q.length));
  let out = q.slice(0, s) + q.slice(e);
  let caret = s;
  if (s > 0 && out[s - 1] === ' ' && out[s] === ' ') {
    out = out.slice(0, s) + out.slice(s + 1);
  }
  if (out.trim() === '') return { q: '', caret: 0 };
  caret = Math.min(caret, out.length);
  return { q: out, caret };
}
