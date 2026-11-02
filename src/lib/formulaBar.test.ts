import { describe, expect, it } from 'vitest';
import { buildNameIndex, caretToken, parseFormula } from './hl/formula';
import type { Market } from './hl/types';
import { dict, type StrKey } from './i18n';
import {
  fmtValue,
  nextAction,
  pendingOperand,
  previewValue,
  reasonText,
  slotText,
} from './formulaBar';

// Invented catalog — never real tickers, so the fixture cannot drift with HL.
const MARKETS: Market[] = [
  { coin: 'AAA', display: 'AAA-USDC', kind: 'perp' },
  { coin: 'BBB', display: 'BBB-USDC', kind: 'perp' },
  { coin: 'DDD', display: 'DDD-USDC', kind: 'perp' },
  { coin: 'EEE', display: 'EEE-USDC', kind: 'perp' },
  { coin: 'FFF', display: 'FFF-USDC', kind: 'perp' },
  { coin: 'zz:CCC', display: 'CCC-USDC', kind: 'hip3', dex: 'zz' },
  { coin: '@901', display: 'AAA/USDC', kind: 'spot' },
];
const idx = buildNameIndex(MARKETS);
const tr = (k: StrKey) => dict.en[k];
const parse = (s: string) => parseFormula(s, idx);
const endTok = (s: string) => caretToken(s, s.length, idx);

describe('pendingOperand — mid-formula, not wrong', () => {
  it('is true right after an operator or an opening paren', () => {
    expect(pendingOperand(parse('AAA/'))).toBe(true);
    expect(pendingOperand(parse('AAA/('))).toBe(true);
    expect(pendingOperand(parse('(AAA+'))).toBe(true);
  });
  it('is false for a placeable, an empty, or a genuinely broken formula', () => {
    expect(pendingOperand(parse('AAA/BBB'))).toBe(false);
    expect(pendingOperand(null)).toBe(false);
    expect(pendingOperand(parse('AAA/)'))).toBe(false);
    expect(pendingOperand(parse('XXX/AAA'))).toBe(false);
  });
});

describe('nextAction — what Enter / Go does', () => {
  it('leaves a placeable formula alone on plain Enter and places it only with Ctrl/⌘', () => {
    expect(nextAction(parse('AAA/BBB'), true, endTok('AAA/BBB'))).toBe('noop');
    expect(nextAction(parse('AAA/BBB'), false, endTok('AAA/BBB'))).toBe('noop');
    expect(nextAction(parse('AAA'), true, endTok('AAA'))).toBe('noop');
    expect(nextAction(parse('AAA/BBB'), true, endTok('AAA/BBB'), true)).toBe('place');
    expect(nextAction(parse('AAA'), false, endTok('AAA'), true)).toBe('place');
  });
  it('completes the empty slot after an operator with the highlighted row', () => {
    expect(nextAction(parse('AAA/'), true, endTok('AAA/'))).toBe('complete');
    expect(nextAction(null, true, endTok(''))).toBe('complete');
  });
  it('completes an unresolved caret token with the highlighted row', () => {
    const s = 'XXX/AAA';
    expect(nextAction(parse(s), true, caretToken(s, 2, idx))).toBe('complete');
  });
  it('otherwise moves the caret to the problem', () => {
    expect(nextAction(parse('AAA/'), false, endTok('AAA/'))).toBe('focus-problem');
    const s = 'AAA/(BBB';
    expect(nextAction(parse(s), true, caretToken(s, s.length, idx))).toBe('focus-problem');
  });
});

describe('reasonText / slotText — the value slot in words', () => {
  it('names the unknown word', () => {
    const p = parse('XXX/AAA');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(reasonText(p, 'XXX/AAA', tr)).toBe('Pick a market for XXX');
  });
  it('caps the leg count with the real limit', () => {
    const p = parse('AAA+BBB+DDD+EEE+FFF');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(reasonText(p, 'AAA+BBB+DDD+EEE+FFF', tr)).toBe('Up to 4 markets');
  });
  it('shows the operator glyph in the missing-operand line', () => {
    const p = parse('AAA/');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(reasonText(p, 'AAA/', tr)).toBe('Missing a market after ÷');
  });
  it('slotText: examples hint when empty, next-market prompt mid-formula, nothing when placeable', () => {
    expect(slotText(null, '', tr)).toBe(tr('fx_examples'));
    expect(slotText(null, '', tr, false)).toBe(tr('fx_examples_type'));
    expect(slotText(parse('AAA/'), 'AAA/', tr)).toBe(tr('fx_next'));
    expect(slotText(parse('AAA/BBB'), 'AAA/BBB', tr)).toBe('');
  });
});

describe('previewValue / fmtValue', () => {
  const div = (v: number[]) => v[0]! / v[1]!;
  it('evaluates over the mids and hides while a leg has no price', () => {
    const mids = new Map([
      ['AAA', 40],
      ['BBB', 4000],
    ]);
    expect(previewValue(div, ['AAA', 'BBB'], (c) => mids.get(c))).toBe(0.01);
    expect(previewValue(div, ['AAA', 'DDD'], (c) => mids.get(c))).toBeNull();
    expect(previewValue(div, ['AAA', 'BBB'], (c) => (c === 'BBB' ? 0 : mids.get(c)))).toBeNull();
  });
  it('formats at five significant figures per decade with grouping', () => {
    expect(fmtValue(0.033957)).toBe('0.033957');
    expect(fmtValue(1291.14)).toBe('1,291.1');
    expect(fmtValue(-12.3456)).toBe('-12.346');
  });
});
