/*
 * Formula bar — the pure decision logic behind the picker's formula mode
 * (MarketTable, mode 'picker' with a NameIndex).
 * DOM-free so vitest pins it; the component only wires events to these.
 *
 * Vocabulary: `parsed` is parseFormula's result for the current query (null
 * for an empty query in formula mode — the ƒx-tap empty state); `tok` is the
 * caret token (formula.ts caretToken) the row list filters by.
 */
import { MAX_LEGS, normalizeInput, type ParseErr, type ParseOk, type Token } from './hl/formula';
import { precisionFor, type Fn } from './hl/compose';
import { fmt, type StrKey } from './i18n';

export type Parsed = ParseOk | ParseErr;
export type BarAction = 'place' | 'complete' | 'focus-problem' | 'noop';
export type Tr = (k: StrKey) => string;

/** Preview glyphs for the ASCII operators the grammar stores. */
export function opGlyph(op: string): string {
  return op === '/' ? '÷' : op === '*' ? '×' : op === '-' ? '−' : op;
}

/** The six coarse-pointer keys: [inserted ASCII, shown glyph]. */
export const OP_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['+', '+'],
  ['-', '−'],
  ['*', '×'],
  ['/', '÷'],
  ['(', '('],
  [')', ')'],
];

/** Empty-state example chips (literal strings, never resolved). */
export const EXAMPLES: readonly string[] = ['HYPE ÷ ETH', 'BTC − ETH', '(HYPE + ETH) ÷ 2'];

/**
 * 'AAA/' — the query ends in an operator or '(' that is the token the
 * parser blamed: the user is mid-formula, not wrong. The preview shows an
 * empty slot chip and 'Pick the next market' instead of a red operator.
 */
export function pendingOperand(parsed: Parsed | null): boolean {
  if (!parsed || parsed.ok) return false;
  if (parsed.reason !== 'missing_operand' && parsed.reason !== 'unbalanced') return false;
  const last = parsed.tokens[parsed.tokens.length - 1];
  return !!last && (last.kind === 'op' || last.kind === 'lparen') && parsed.start === last.start;
}

/**
 * Enter / the keyboard's Go key inside formula mode. The mode is where the
 * user STAYS to type and adjust, so plain Enter never places: with `mod`
 * (Ctrl/⌘) held a placeable formula places, otherwise a placeable formula
 * is left alone ('noop' — ✓ is the way out). A highlighted row completes
 * the caret token when that token is a word the catalog did not resolve
 * (unresolved / ambiguous), or when the caret sits in the empty slot after
 * an operator ('AAA/' + ↓ETH + Enter); an empty query with a row behaves
 * the same (the ƒx-tap empty state). Otherwise the caret goes to the first
 * problem token.
 */
export function nextAction(
  parsed: Parsed | null,
  hasRow: boolean,
  tok: { start: number; end: number; text: string },
  mod = false,
): BarAction {
  if (parsed?.ok) return mod ? 'place' : 'noop';
  if (!hasRow) return 'focus-problem';
  if (!parsed) return 'complete';
  if (tok.text === '') return pendingOperand(parsed) ? 'complete' : 'focus-problem';
  const t = tokenAt(parsed.tokens, tok.start, tok.end);
  return t && (t.kind === 'unresolved' || t.kind === 'ambiguous') ? 'complete' : 'focus-problem';
}

function tokenAt(tokens: Token[], start: number, end: number): Token | undefined {
  return tokens.find((t) => t.start === start && t.end === end);
}

/** The reason line for a formula that is not placeable. */
export function reasonText(err: ParseErr, query: string, tr: Tr): string {
  const src = normalizeInput(query);
  const span = src.slice(err.start, err.end);
  switch (err.reason) {
    case 'unknown':
      return fmt(tr('fx_unknown'), { word: err.word ?? span });
    case 'ambiguous':
      return fmt(tr('fx_ambiguous'), { word: err.word ?? span });
    case 'too_many_legs':
      return fmt(tr('fx_too_many_legs'), { n: MAX_LEGS });
    case 'missing_operand': {
      const t = err.tokens.find((x) => x.start === err.start);
      const op = t && (t.kind === 'op' || t.kind === 'lparen') ? opGlyph(t.text) : span;
      return op ? fmt(tr('fx_missing_operand'), { op }) : tr('fx_no_market');
    }
    case 'unbalanced':
      return tr('fx_unbalanced');
    case 'hip4':
      return tr('fx_hip4');
    case 'unexpected':
      return fmt(tr('fx_unexpected'), { char: span || '?' });
    case 'too_long':
      return tr('fx_too_long');
    case 'div_zero':
      return tr('fx_div_zero');
    case 'no_market':
      return tr('fx_no_market');
  }
}

/** The value slot's TEXT when there is no value to show: the empty-state
 *  hint, the mid-formula prompt, or the reason. '' when placeable. */
export function slotText(parsed: Parsed | null, query: string, tr: Tr, coarse = true): string {
  // the empty bar's first words: phones tap rows and the operand keys,
  // a mouse types (the keys render only on coarse pointers)
  if (parsed === null) return tr(coarse ? 'fx_examples' : 'fx_examples_type');
  if (parsed.ok) return '';
  if (pendingOperand(parsed)) return tr('fx_next');
  return reasonText(parsed, query, tr);
}

/** The live preview: the compiled formula over the current mids; null while
 *  any leg has no price yet or the result is not finite (÷0). */
export function previewValue(
  fn: Fn,
  legs: string[],
  mid: (coin: string) => number | null | undefined,
): number | null {
  const vec: number[] = [];
  for (const c of legs) {
    const v = mid(c);
    if (v == null || !Number.isFinite(v)) return null;
    vec.push(v);
  }
  const r = fn(vec);
  return Number.isFinite(r) ? r : null;
}

// One formatter per decimals tier (Intl construction is the hidden cost of
// toLocaleString; the value repaints on every mids push).
const valueFmts = new Map<number, Intl.NumberFormat>();

/** A composed value at the facade's precision rule (compose.precisionFor):
 *  5 significant figures at its own magnitude, grouped, hyphen-minus. */
export function fmtValue(v: number): string {
  const d = precisionFor([v]);
  let f = valueFmts.get(d);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    valueFmts.set(d, f);
  }
  return f.format(v);
}
