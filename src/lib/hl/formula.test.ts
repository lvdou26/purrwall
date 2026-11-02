import { describe, expect, it } from 'vitest';
import {
  MAX_ID_LEN,
  MAX_LEGS,
  buildNameIndex,
  canonical,
  caretToken,
  compactText,
  compile,
  deleteToken,
  editText,
  isFormulaId,
  isFormulaTrigger,
  normalizeInput,
  parseCanonical,
  parseFormula,
  replaceToken,
  tokenize,
  type Ast,
  type ParseErr,
  type ParseOk,
} from './formula';
import type { Market } from './types';

// INVENTED catalog shaped like HL's live one (never real tickers, so the
// fixture cannot drift with HL's live catalog):
//  - a perp base shared with a HIP-3 dex (SSS ↔ yy:SSS, the STX case)
//  - a HIP-3 base on two dexs (zz:AMB / yy:AMB, the AVGO case)
//  - HIP-3 display overrides carrying '&' and '.' (S&P5, B.D)
//  - a shadowed spot display: raw PPP shows 'PPP-26/USDC' while UPPP took
//    'PPP/USDC' (the PUMP-26 case); 'uppp' survives only as a keyword
//  - digit-leading names ('2Q' perp, 'zz:10Q')
//  - the one named spot id ('NNN/USDC'), a lowercase id ('kAAA'), a non-USDC
//    quote, a spot-only base ('QQQ'), and a HIP-4 outcome that must not index
const perp = (coin: string): Market => ({ coin, display: `${coin}-USDC`, kind: 'perp' });
const hip3 = (coin: string, base?: string): Market => ({
  coin,
  display: `${base ?? coin.slice(coin.indexOf(':') + 1)}-USDC`,
  kind: 'hip3',
  dex: coin.slice(0, coin.indexOf(':')),
});
const spot = (coin: string, display: string, extra: Partial<Market> = {}): Market => ({
  coin,
  display,
  kind: 'spot',
  ...extra,
});

const CATALOG: Market[] = [
  perp('AAA'),
  perp('BBB'),
  perp('CCC'),
  perp('DDD'),
  perp('EEE'),
  perp('PPP'),
  perp('SSS'),
  perp('kAAA'),
  perp('2Q'),
  hip3('zz:AAA1'),
  hip3('zz:AMB'),
  hip3('yy:AMB'),
  hip3('zz:SP5', 'S&P5'),
  hip3('zz:BD', 'B.D'),
  hip3('zz:10Q'),
  hip3('yy:SSS'),
  spot('@901', 'AAA/USDC'),
  spot('@902', 'PPP/USDC', { spotBase: 'UPPP', keywords: ['uppp'] }),
  spot('@903', 'PPP-26/USDC', { spotBase: 'PPP' }),
  spot('NNN/USDC', 'NNN/USDC'),
  spot('@904', 'BBB/USDT'),
  spot('@905', 'QQQ/USDC'),
  { coin: '#10', display: 'Will it rain? · Yes', kind: 'hip4' },
];
const INDEX = buildNameIndex(CATALOG);

const ok = (input: string): ParseOk => {
  const r = parseFormula(input, INDEX);
  if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(input)}, got ${r.reason} @${r.start}`);
  return r;
};
const err = (input: string): ParseErr => {
  const r = parseFormula(input, INDEX);
  if (r.ok) throw new Error(`expected error for ${JSON.stringify(input)}, got ${r.canonical}`);
  return r;
};
const canon = (input: string) => ok(input).canonical;
/** parse → compile → evaluate over the legs in first-appearance order */
const ev = (input: string, vec: number[]) => {
  const r = ok(input);
  return compile(r.ast, r.legs)(vec);
};

describe('normalizeInput', () => {
  it('folds × ÷ and every dash to ASCII operators, one code unit each', () => {
    expect(normalizeInput('A×B÷C−D–E—F－G')).toBe('A*B/C-D-E-F-G');
    expect(normalizeInput('A‐B‑C‒D―E﹣F')).toBe('A-B-C-D-E-F');
  });
  it('folds the fullwidth ASCII block and both exotic spaces', () => {
    expect(normalizeInput('（ＡＡＡ＋ＢＢＢ）／２．５＊ｋａａａ＝［＠］：＃＆')).toBe('(AAA+BBB)/2.5*kaaa=[@]:#&');
    expect(normalizeInput('A +　B')).toBe('A + B');
  });
  it('is length-preserving so caret anchors index the raw input', () => {
    for (const s of ['×÷−–—－', '（ＡＡＡ）', 'A B　C', 'plain/ascii-2']) {
      expect(normalizeInput(s)).toHaveLength(s.length);
    }
  });
  it('an em dash is ONE minus (iOS Smart Punctuation rewrites "--")', () => {
    // '--AAA' is +AAA, but a typist whose '--' became '—' gets −AAA: documented, not fixed
    expect(canon('—AAA')).toBe('=-AAA');
    expect(canon('- -AAA')).toBe('AAA');
    expect(canon('--AAA')).toBe('AAA');
  });
});

describe('precedence and unary forms (compile)', () => {
  it('2+3*4 = 14, 8/4/2 = 1, 8-4-2 = 2 (left-assoc)', () => {
    expect(ev('2+3*4+0*AAA', [1])).toBe(14);
    expect(ev('8/4/2+0*AAA', [1])).toBe(1);
    expect(ev('8-4-2+0*AAA', [1])).toBe(2);
    expect(ev('(2+3)*4+0*AAA', [1])).toBe(20);
  });
  it('unary minus: -(A), A*-B, --A, A--B, -A+B, 2*-A', () => {
    expect(ev('-(AAA)', [5])).toBe(-5);
    expect(ev('AAA*-BBB', [2, 3])).toBe(-6);
    expect(ev('--AAA', [5])).toBe(5);
    expect(ev('AAA--BBB', [2, 3])).toBe(5);
    expect(ev('-AAA+BBB', [2, 3])).toBe(1);
    expect(ev('2*-AAA', [3])).toBe(-6);
    expect(ev('-(AAA+BBB)', [2, 3])).toBe(-5);
    expect(canon('AAA--BBB')).toBe('=AAA-(-BBB)');
  });
  it('vec[i] is legs[i] in first-appearance order; a non-finite result passes through', () => {
    const r = ok('BBB/AAA');
    expect(r.legs).toEqual(['BBB', 'AAA']);
    const f = compile(r.ast, r.legs);
    const vec = [10, 4];
    expect(f(vec)).toBe(2.5);
    vec[1] = 0;
    expect(f(vec)).toBe(Infinity); // the bar rule in compose.ts omits non-finite bars
  });
  it('compile throws on a leg missing from legs (programming error, not a data error)', () => {
    const r = ok('AAA/BBB');
    expect(() => compile(r.ast, ['AAA'])).toThrow();
  });
});

describe('number forms', () => {
  it('.5 → 0.5, 2.0 → 2, 0.50 → 0.5, 007 → 7', () => {
    expect(canon('.5*AAA')).toBe('=0.5*AAA');
    expect(canon('2.0*AAA')).toBe('=2*AAA');
    expect(canon('0.50*AAA')).toBe('=0.5*AAA');
    expect(canon('007*AAA')).toBe('=7*AAA');
    expect(canon('AAA*0.0000001')).toBe('=AAA*0.0000001'); // never exponent form
  });
  it("rejects '1e3' and '5.' as unexpected at the position", () => {
    expect(err('1e3*AAA')).toMatchObject({ reason: 'unexpected', start: 0, end: 3 });
    expect(err('5.*AAA')).toMatchObject({ reason: 'unexpected', start: 0, end: 2 });
    expect(err('AAA*1e3')).toMatchObject({ reason: 'unexpected', start: 4, end: 7 });
  });
  it('rejects a constant ≥ 1e21 (no room for exponent form in the id)', () => {
    expect(err(`AAA*${'1'.repeat(22)}`)).toMatchObject({ reason: 'unexpected', start: 4 });
  });
  it('a tiny constant prints its exact digits — never "0" or exponent form — and re-parses', () => {
    // toFixed(20) would turn 1e-21 into '0': an ok parse whose canonical id
    // parseCanonical then refuses as a zero divisor
    expect(canon('AAA/0.000000000000000000001')).toBe('=AAA/0.000000000000000000001');
    expect(canon('AAA*0.000000000000000000015')).toBe('=AAA*0.000000000000000000015');
    for (const k of [
      '0.000000000000000000001',
      '0.000000000000000000015',
      '0.00000012345678901234567',
      '0.0000001',
    ]) {
      const c = canon(`AAA*${k}`);
      expect(isFormulaId(c), k).toBe(true);
      expect(canonical(parseCanonical(c)!.ast), k).toBe(c);
      expect(Number(c.slice('=AAA*'.length)), k).toBe(Number(k)); // the double survives exactly
    }
    // an absurd one prints long and fails the id cap instead of lying
    expect(err(`AAA*0.${'0'.repeat(99)}1`)).toMatchObject({ reason: 'too_long' });
  });
});

describe('every reason, with its position', () => {
  it('unknown: the word is the first segment of the run, never the whole run', () => {
    expect(err('AAA/USDX')).toMatchObject({ reason: 'unknown', start: 4, end: 8, word: 'USDX' });
    expect(err('claude')).toMatchObject({ reason: 'unknown', start: 0, end: 6, word: 'claude' });
    expect(err('UPPP/AAA')).toMatchObject({ reason: 'unknown', start: 0, end: 4, word: 'UPPP' }); // keyword ≠ name
    expect(err('QQQ*2')).toMatchObject({ reason: 'unknown', word: 'QQQ' }); // spot-only base is never bare
    expect(err('AAA+BBB+HYPEX')).toMatchObject({ reason: 'unknown', start: 8, end: 13 });
  });
  it('ambiguous: two-dex HIP-3 base → the dex-qualified candidates', () => {
    expect(err('AMB/AAA')).toMatchObject({
      reason: 'ambiguous',
      start: 0,
      end: 3,
      word: 'AMB',
      candidates: ['zz:AMB', 'yy:AMB'],
    });
    expect(err('AAA/amb')).toMatchObject({ reason: 'ambiguous', start: 4, end: 7 });
  });
  it('too_many_legs at the 5th distinct symbol; the same coin twice counts once', () => {
    expect(err('AAA+BBB+CCC+DDD+EEE')).toMatchObject({ reason: 'too_many_legs', start: 16, end: 19 });
    expect(ok('AAA+BBB+CCC+DDD+AAA').legs).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    expect(ok('(AAA+BBB+CCC+DDD)/AAA').legs).toHaveLength(MAX_LEGS);
  });
  it('missing_operand at the operator or paren that lacks its operand', () => {
    expect(err('AAA+')).toMatchObject({ reason: 'missing_operand', start: 3, end: 4 });
    expect(err('AAA*/BBB')).toMatchObject({ reason: 'missing_operand', start: 3, end: 4 });
    expect(err('/AAA')).toMatchObject({ reason: 'missing_operand', start: 0, end: 1 });
    expect(err('*AAA')).toMatchObject({ reason: 'missing_operand', start: 0, end: 1 });
    expect(err('()')).toMatchObject({ reason: 'missing_operand', start: 0, end: 1 });
    expect(err('AAA*-')).toMatchObject({ reason: 'missing_operand', start: 4, end: 5 });
    expect(err('AAA/()')).toMatchObject({ reason: 'missing_operand', start: 4, end: 5 });
    expect(err('')).toMatchObject({ reason: 'missing_operand', start: 0, end: 0 });
    expect(err('   ')).toMatchObject({ reason: 'missing_operand', start: 3, end: 3 });
  });
  it('unbalanced parens / bracket', () => {
    expect(err('(AAA')).toMatchObject({ reason: 'unbalanced', start: 0, end: 1 });
    expect(err('((AAA)')).toMatchObject({ reason: 'unbalanced', start: 0, end: 1 });
    expect(err('AAA)')).toMatchObject({ reason: 'unbalanced', start: 3, end: 4 });
    expect(err('(AAA))')).toMatchObject({ reason: 'unbalanced', start: 5, end: 6 });
    expect(err('[AAA')).toMatchObject({ reason: 'unbalanced', start: 0, end: 1 });
    expect(err(')')).toMatchObject({ reason: 'unbalanced', start: 0, end: 1 });
    expect(err(')*AAA')).toMatchObject({ reason: 'unbalanced', start: 0, end: 1 });
    expect(err('AAA/)')).toMatchObject({ reason: 'missing_operand', start: 3, end: 4 }); // the ÷ is the nearer problem
  });
  it("hip4: '#' anywhere", () => {
    expect(err('#10')).toMatchObject({ reason: 'hip4', start: 0, end: 3 });
    expect(err('AAA+#10')).toMatchObject({ reason: 'hip4', start: 4, end: 7 });
    expect(err('AAA+#10').tokens.map((t) => t.kind)).toEqual(['sym', 'op']);
    expect(err('[#10]')).toMatchObject({ reason: 'hip4', start: 0, end: 5 });
    expect(err('AAA*[#10]')).toMatchObject({ reason: 'hip4', start: 4, end: 9 });
  });
  it('unexpected: ^ %, letters glued to digits, implicit multiplication, stray =', () => {
    expect(err('AAA^2')).toMatchObject({ reason: 'unexpected', start: 3, end: 4 });
    expect(err('AAA%')).toMatchObject({ reason: 'unexpected', start: 3, end: 4 });
    expect(err('2ZEC')).toMatchObject({ reason: 'unexpected', start: 0, end: 4 });
    expect(err('AAA BBB')).toMatchObject({ reason: 'unexpected', start: 4, end: 7 });
    expect(err('2 3')).toMatchObject({ reason: 'unexpected', start: 2, end: 3 });
    expect(err('AAA(BBB)')).toMatchObject({ reason: 'unexpected', start: 3, end: 4 });
    expect(err('==AAA')).toMatchObject({ reason: 'unexpected', start: 1, end: 2 });
    expect(err('[]')).toMatchObject({ reason: 'unexpected', start: 0, end: 2 });
  });
  it(`too_long: canonical over ${MAX_ID_LEN} chars, and a runaway paste`, () => {
    const factor = '*1.0000000001'; // 13 chars, no new leg
    const fits = 'AAA' + factor.repeat(7); // '=' + 3 + 91 = 95
    expect(canon(fits)).toHaveLength(95);
    const over = 'AAA' + factor.repeat(8);
    expect(err(over)).toMatchObject({ reason: 'too_long', start: 0, end: over.length });
    expect(err('AAA+'.repeat(200))).toMatchObject({ reason: 'too_long', tokens: [] });
  });
  it('div_zero at a divisor that folds to a constant 0; a leg difference is runtime', () => {
    expect(err('AAA/0')).toMatchObject({ reason: 'div_zero', start: 4, end: 5 });
    expect(err('AAA/0.0')).toMatchObject({ reason: 'div_zero', start: 4, end: 7 });
    expect(err('AAA/(2-2)')).toMatchObject({ reason: 'div_zero', start: 4, end: 9 });
    expect(err('AAA/-0')).toMatchObject({ reason: 'div_zero', start: 4, end: 6 });
    expect(ok('AAA/(BBB-BBB)').canonical).toBe('=AAA/(BBB-BBB)');
    expect(ok('AAA/(0*BBB)').canonical).toBe('=AAA/(0*BBB)');
  });
  it('no_market: constant-only', () => {
    expect(err('2*3')).toMatchObject({ reason: 'no_market', start: 0, end: 3 });
    expect(err('2')).toMatchObject({ reason: 'no_market' });
    expect(err('-(2+3)/4')).toMatchObject({ reason: 'no_market' });
  });
  it('reports the FIRST problem in reading order and keeps every chip', () => {
    const e = err('AAA/USDX+(BBB');
    expect(e).toMatchObject({ reason: 'unknown', word: 'USDX' });
    expect(e.tokens.map((t) => t.kind)).toEqual(['sym', 'op', 'unresolved', 'op', 'lparen', 'sym']);
  });
  it('a lexer error yields to a word or structure problem before it, never to a tail-side gap', () => {
    expect(err('USDX+AAA^')).toMatchObject({ reason: 'unknown', start: 0, end: 4, word: 'USDX' });
    expect(err('USDX+#10')).toMatchObject({ reason: 'unknown', start: 0, end: 4 });
    expect(err('AMB+AAA^')).toMatchObject({ reason: 'ambiguous', start: 0, end: 3 });
    expect(err('AAA BBB^')).toMatchObject({ reason: 'unexpected', start: 4, end: 7 });
    expect(err('AAA+BBB+CCC+DDD+EEE^')).toMatchObject({ reason: 'too_many_legs', start: 16, end: 19 });
    expect(err('#10+USDX')).toMatchObject({ reason: 'hip4', start: 0, end: 3 });
    expect(err('AAA^+USDX')).toMatchObject({ reason: 'unexpected', start: 3, end: 4 });
    // the truncation itself explains these, so the lexer error stands
    expect(err('AAA+^')).toMatchObject({ reason: 'unexpected', start: 4, end: 5 });
    expect(err('(AAA^')).toMatchObject({ reason: 'unexpected', start: 4, end: 5 });
  });
});

describe('resolution (run-then-longest-prefix)', () => {
  it('a known BASE/QUOTE is the spot pair; an unknown pair is a division', () => {
    expect(ok('AAA/USDC')).toMatchObject({ single: true, canonical: '@901', legs: ['@901'] });
    expect(canon('AAA/BBB')).toBe('=AAA/BBB');
    expect(canon('AAA/USDC/AAA')).toBe('=@901/AAA');
    expect(canon('NNN/USDC/AAA')).toBe('=[NNN/USDC]/AAA');
    expect(canon('BBB/USDT')).toBe('@904');
  });
  it("'A-B' subtracts; 'A-USDC' is the perp display", () => {
    expect(canon('AAA-BBB')).toBe('=AAA-BBB');
    expect(canon('AAA-USDC/BBB')).toBe('=AAA/BBB');
    expect(canon('AAA-USDC')).toBe('AAA');
    expect(canon('AAA-2')).toBe('=AAA-2');
  });
  it('the shadowed spot base: PPP-26/USDC vs PPP/USDC, and PPP-26 alone is never PPP − 26', () => {
    expect(canon('PPP-26/USDC')).toBe('@903');
    expect(canon('PPP/USDC')).toBe('@902');
    expect(canon('PPP')).toBe('PPP');
    expect(err('PPP-26')).toMatchObject({ reason: 'unknown', start: 0, end: 6, word: 'PPP-26' });
    expect(err('ppp-26')).toMatchObject({ reason: 'unknown', word: 'ppp-26' });
    // still being typed toward the pair: same chip, so the row filter can offer it
    expect(err('PPP-2')).toMatchObject({ reason: 'unknown', word: 'PPP-2' });
    expect(err('PPP-')).toMatchObject({ reason: 'unknown', word: 'PPP-' });
    // a real subtraction is one space away, and 'PPP-BBB' never looked like a base
    expect(canon('PPP - 26')).toBe('=PPP-26');
    expect(canon('PPP-BBB')).toBe('=PPP-BBB');
    expect(err('PPP-26/AAA')).toMatchObject({ reason: 'unknown', word: 'PPP-26', start: 0, end: 6 });
    expect(err('AAA/PPP-26').tokens.map((t) => t.kind)).toEqual(['sym', 'op', 'unresolved']);
  });
  it('raw spot token names are keywords, never names (UBTC → chip)', () => {
    expect(err('UPPP')).toMatchObject({ reason: 'unknown', word: 'UPPP' });
    expect(INDEX.resolve('uppp')).toBeNull();
  });
  it('HIP-3: bare base when unique, display override, dex-qualified always', () => {
    expect(canon('AAA1')).toBe('zz:AAA1');
    expect(canon('zz:AAA1')).toBe('zz:AAA1');
    expect(canon('AAA1-USDC')).toBe('zz:AAA1');
    expect(canon('zz:aaa1')).toBe('zz:AAA1'); // lookup folds case, emitted id keeps it
    expect(canon('S&P5')).toBe('zz:SP5');
    expect(canon('SP5')).toBe('zz:SP5');
    expect(canon('zz:S&P5')).toBe('zz:SP5');
    expect(canon('B.D')).toBe('zz:BD');
    expect(canon('S&P5/B.D')).toBe('=zz:SP5/zz:BD');
    expect(canon('S&P5-USDC*2')).toBe('=zz:SP5*2');
  });
  it('a two-dex base is ambiguous bare and explicit with its dex', () => {
    expect(err('AMB')).toMatchObject({ reason: 'ambiguous', candidates: ['zz:AMB', 'yy:AMB'] });
    expect(canon('zz:AMB')).toBe('zz:AMB');
    expect(canon('zz:AMB-yy:AMB')).toBe('=zz:AMB-yy:AMB');
    expect(err('AMB-USDC')).toMatchObject({ reason: 'ambiguous' });
  });
  it('the main-dex perp wins a shared bare name (the STX case: a perp beats its HIP-3 twin)', () => {
    expect(canon('SSS')).toBe('SSS');
    expect(canon('SSS-USDC')).toBe('SSS');
    expect(canon('yy:SSS')).toBe('yy:SSS');
    expect(canon('yy:SSS/SSS')).toBe('=yy:SSS/SSS');
  });
  it('digit-leading names are tried before numbers', () => {
    expect(canon('2Q')).toBe('2Q');
    expect(canon('2Q*AAA')).toBe('=2Q*AAA');
    expect(canon('10Q')).toBe('zz:10Q');
    expect(canon('AAA-2Q')).toBe('=AAA-2Q');
    expect(canon('2*AAA')).toBe('=2*AAA');
    expect(canon('.5*AAA')).toBe('=0.5*AAA');
    expect(err('2ZEC')).toMatchObject({ reason: 'unexpected' });
  });
  it('spot ids, named spot id and the [bracket] escape', () => {
    expect(canon('@901')).toBe('@901');
    expect(canon('@901/AAA')).toBe('=@901/AAA');
    expect(canon('[NNN/USDC]')).toBe('NNN/USDC');
    expect(canon('[nnn/usdc]/aaa')).toBe('=[NNN/USDC]/AAA');
    expect(canon('[AAA-USDC]')).toBe('AAA');
    expect(err('[NOPE]')).toMatchObject({ reason: 'unknown', start: 0, end: 6, word: 'NOPE' });
    expect(ok('[NNN/USDC]').tokens[0]).toMatchObject({ kind: 'sym', text: 'NNN/USDC', start: 0, end: 10 });
  });
  it('case: lowercase ids keep catalog case, lookup is case-insensitive', () => {
    expect(canon('kaaa')).toBe('kAAA');
    expect(canon('KAAA/aaa')).toBe('=kAAA/AAA');
    expect(canon('aaa/bbb')).toBe('=AAA/BBB');
  });
  it("accepts a pasted canonical id (leading '=') and whitespace anywhere", () => {
    expect(canon('=AAA/BBB')).toBe('=AAA/BBB');
    expect(canon(' = AAA  /\tBBB ')).toBe('=AAA/BBB');
    expect(canon('=AAA')).toBe('AAA');
  });
  it('HIP-4 never enters the index', () => {
    expect(INDEX.resolve('#10')).toBeNull();
    expect(INDEX.resolve('Will it rain? · Yes')).toBeNull();
    expect(INDEX.aliasFor('#10')).toBe('#10');
    expect(INDEX.displayOf('#10')).toBe('#10');
  });
  it('tokenize exposes the chips with positions and coins', () => {
    expect(tokenize('aaa/usdc / bbb', INDEX)).toEqual([
      { kind: 'sym', text: 'aaa/usdc', start: 0, end: 8, coin: '@901' },
      { kind: 'op', text: '/', start: 9, end: 10 },
      { kind: 'sym', text: 'bbb', start: 11, end: 14, coin: 'BBB' },
    ]);
    expect(tokenize('AMB', INDEX)[0]).toMatchObject({ kind: 'ambiguous', candidates: ['zz:AMB', 'yy:AMB'] });
  });
});

describe('unicode and fullwidth input', () => {
  it('× ÷ − and fullwidth punctuation parse like ASCII', () => {
    expect(canon('AAA×BBB')).toBe('=AAA*BBB');
    expect(canon('AAA÷BBB')).toBe('=AAA/BBB');
    expect(canon('AAA−BBB')).toBe('=AAA-BBB');
    expect(canon('AAA–BBB')).toBe('=AAA-BBB');
    expect(canon('（ＡＡＡ＋ＢＢＢ）／２')).toBe('=(AAA+BBB)/2');
    expect(canon('ＡＡＡ／ＵＳＤＣ')).toBe('@901');
    expect(canon('AAA +　BBB')).toBe('=AAA+BBB');
  });
  it('error positions index the raw (un-normalized) string', () => {
    expect(err('ＡＡＡ／ＵＳＤＸ')).toMatchObject({ reason: 'unknown', start: 4, end: 8 });
  });
});

describe('canonical printing', () => {
  const cases: Array<[string, string]> = [
    ['(AAA)/(BBB)', '=AAA/BBB'],
    ['AAA/(BBB*2)', '=AAA/(BBB*2)'],
    ['AAA-(BBB+CCC)', '=AAA-(BBB+CCC)'],
    ['AAA-(BBB-CCC)', '=AAA-(BBB-CCC)'],
    ['AAA+(BBB+CCC)', '=AAA+(BBB+CCC)'],
    ['(AAA+BBB)+CCC', '=AAA+BBB+CCC'],
    ['(AAA*BBB)/CCC', '=AAA*BBB/CCC'],
    ['(AAA+BBB)*CCC', '=(AAA+BBB)*CCC'],
    ['AAA+BBB*CCC', '=AAA+BBB*CCC'],
    ['-AAA+BBB', '=-AAA+BBB'],
    ['AAA*(-BBB)', '=AAA*(-BBB)'],
    ['AAA*-BBB', '=AAA*(-BBB)'],
    ['AAA--BBB', '=AAA-(-BBB)'],
    ['-(AAA+BBB)', '=-(AAA+BBB)'],
    ['-(AAA*BBB)', '=-(AAA*BBB)'],
    ['(-AAA)*BBB', '=-AAA*BBB'],
    ['-AAA*BBB', '=-AAA*BBB'],
    ['((AAA))', 'AAA'],
    ['(AAA+BBB)/2', '=(AAA+BBB)/2'],
    ['2*AAA-BBB', '=2*AAA-BBB'],
    ['-2*AAA', '=-2*AAA'],
    ['NNN/USDC/AAA', '=[NNN/USDC]/AAA'],
    ['-(zz:AAA1*1.5+zz:AMB*0.25)/(zz:BD+yy:AMB)', '=-(zz:AAA1*1.5+zz:AMB*0.25)/(zz:BD+yy:AMB)'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(canon(input)).toBe(expected);
  });
  it('is idempotent: parseCanonical(canon(x)) prints canon(x)', () => {
    for (const [input] of cases) {
      const c = canon(input);
      if (!c.startsWith('=')) continue;
      const r = parseCanonical(c);
      expect(r).not.toBeNull();
      expect(canonical(r!.ast)).toBe(c);
    }
  });
  it('brackets only around ids carrying an operator char; : and @ need none', () => {
    expect(canon('[NNN/USDC]*2')).toBe('=[NNN/USDC]*2');
    expect(canon('zz:AAA1/@901')).toBe('=zz:AAA1/@901');
  });
  it('a hand-built double negation folds before the paren decision (idempotent)', () => {
    const num = (v: number): Ast => ({ t: 'num', v });
    const sym = (coin: string): Ast => ({ t: 'sym', coin });
    const neg = (a: Ast): Ast => ({ t: 'neg', a });
    const div: Ast = { t: 'bin', op: '/', a: sym('AAA'), b: neg(neg(num(0.5))) };
    expect(canonical(div)).toBe('=AAA/0.5');
    expect(canonical(neg(neg(neg(sym('AAA')))))).toBe('=-AAA');
    expect(canonical({ t: 'bin', op: '*', a: neg(neg(sym('AAA'))), b: sym('BBB') })).toBe('=AAA*BBB');
    expect(canonical({ t: 'bin', op: '-', a: sym('AAA'), b: neg(neg(neg(sym('BBB')))) })).toBe('=AAA-(-BBB)');
    expect(compactText(div, INDEX.displayOf)).toBe('AAA÷0.5');
    for (const ast of [div, neg(neg(neg(sym('AAA'))))]) {
      const c = canonical(ast);
      expect(canonical(parseCanonical(c)!.ast)).toBe(c);
    }
  });
  it('a single bare symbol canonicalizes to the plain coin id (not a formula)', () => {
    expect(ok('AAA')).toMatchObject({ single: true, canonical: 'AAA', legs: ['AAA'] });
    expect(ok('(AAA)')).toMatchObject({ single: true, canonical: 'AAA' });
    expect(ok('AAA/USDC')).toMatchObject({ single: true, canonical: '@901' });
    expect(ok('-AAA')).toMatchObject({ single: false, canonical: '=-AAA' });
    expect(ok('2*AAA')).toMatchObject({ single: false, canonical: '=2*AAA' });
  });
});

describe('parseCanonical / isFormulaId (catalog-free)', () => {
  it('reads symbols as maximal [A-Za-z0-9:@] runs or [bracketed], numbers as digit runs', () => {
    expect(parseCanonical('=AAA/BBB')).toEqual({
      ast: { t: 'bin', op: '/', a: { t: 'sym', coin: 'AAA' }, b: { t: 'sym', coin: 'BBB' } },
      legs: ['AAA', 'BBB'],
    });
    expect(parseCanonical('=2Q*AAA')?.legs).toEqual(['2Q', 'AAA']);
    expect(parseCanonical('=0.5*zz:AAA1-@901')?.legs).toEqual(['zz:AAA1', '@901']);
    expect(parseCanonical('=[NNN/USDC]/AAA')?.legs).toEqual(['NNN/USDC', 'AAA']);
    expect(parseCanonical('AAA/BBB')?.legs).toEqual(['AAA', 'BBB']); // '=' optional
  });
  it('rejects anything the printer never emits', () => {
    // '1e3' is a shape-legal SYMBOL here (digit-leading ids exist); only
    // parseFormula, which knows the catalog, can call it a bad number
    expect(parseCanonical('=1e3*AAA')?.legs).toEqual(['1e3', 'AAA']);
    for (const bad of [
      '=.5*AAA',
      '=AAA#1',
      '=AAA/',
      '=(AAA',
      '=AAA BBB',
      '=[]',
      '=AAA^2',
      '=2.',
      '=A+(',
      '',
      // brackets admit the coin-id alphabet only — a hand-edited hash cannot
      // smuggle a HIP-4 leg or arbitrary bytes into legs
      '=[<b>]/AAA',
      '=[AAA BBB]/AAA',
      '=[#10]/AAA',
      '=[=]/AAA',
      '=[AAA+BBB]',
      '=[A.B]/AAA',
    ]) {
      expect(parseCanonical(bad), bad).toBeNull();
      expect(isFormulaId(bad), bad).toBe(false);
    }
  });
  it('a resolved leg outside the id alphabet is refused (canonical must always re-parse)', () => {
    const idx = buildNameIndex([perp('A.B'), perp('AAA')]);
    expect(parseFormula('A.B/AAA', idx)).toMatchObject({ ok: false, reason: 'unexpected', start: 0, end: 3 });
    expect(parseFormula('[A.B]/AAA', idx)).toMatchObject({ ok: false, reason: 'unexpected', start: 0, end: 5 });
  });
  it('an all-digit coin id prints bracketed so parseCanonical never reads it as a number', () => {
    const idx = buildNameIndex([perp('888'), perp('AAA')]);
    expect(parseFormula('888*AAA', idx)).toMatchObject({ ok: true, legs: ['888', 'AAA'], canonical: '=[888]*AAA' });
    expect(parseCanonical('=[888]*AAA')?.legs).toEqual(['888', 'AAA']);
    expect(isFormulaId('=[888]*AAA')).toBe(true);
    expect(parseFormula('888', idx)).toMatchObject({ single: true, canonical: '888' });
    expect(parseCanonical('=888*AAA')?.legs).toEqual(['AAA']); // bare digits are a number
  });
  it('isFormulaId: = prefix, ≤96 chars, balanced, 1–4 legs', () => {
    expect(isFormulaId('=AAA/BBB')).toBe(true);
    expect(isFormulaId('=[NNN/USDC]/AAA')).toBe(true);
    expect(isFormulaId('=-(zz:AAA1*1.5+zz:AMB*0.25)/(zz:BD+yy:AMB)')).toBe(true);
    expect(isFormulaId('=AAA')).toBe(true); // shape-valid even if never emitted
    expect(isFormulaId('AAA/BBB')).toBe(false);
    expect(isFormulaId('=')).toBe(false);
    expect(isFormulaId('=2*3')).toBe(false);
    expect(isFormulaId('=(AAA')).toBe(false);
    expect(isFormulaId('=AAA/')).toBe(false);
    expect(isFormulaId('=A+B+C+D+E')).toBe(false);
    expect(isFormulaId('=AAA<BBB')).toBe(false);
    const long = '=' + 'AAA+'.repeat(22) + 'BBB'; // 92 chars, 2 legs
    expect(long).toHaveLength(92);
    expect(isFormulaId(long)).toBe(true);
    expect(isFormulaId('=' + 'AAA+'.repeat(24) + 'B')).toBe(false); // 98
  });
});

describe('compactText / editText / NameIndex aliases', () => {
  it('compactText: ÷ × − + glyphs, display bases, spot keeps its pair', () => {
    const c = (s: string) => compactText(ok(s).ast, INDEX.displayOf);
    expect(c('zz:AAA1/BBB')).toBe('AAA1÷BBB');
    expect(c('AAA/USDC/AAA')).toBe('AAA/USDC÷AAA');
    expect(c('(AAA+BBB)/2')).toBe('(AAA+BBB)÷2');
    expect(c('-AAA+BBB')).toBe('−AAA+BBB');
    expect(c('AAA*-BBB')).toBe('AAA×(−BBB)');
    expect(c('zz:AMB-yy:AMB')).toBe('zz:AMB−yy:AMB');
    expect(c('S&P5-B.D')).toBe('S&P5−B.D');
    expect(c('yy:SSS/SSS')).toBe('yy:SSS÷SSS');
    expect(c('AAA - 26')).toBe('AAA−26');
  });
  it('editText: ASCII, typeable aliases, and parseFormula(editText(x)) is x', () => {
    const e = (s: string) => editText(ok(s).ast, INDEX.aliasFor);
    expect(e('zz:AAA1/BBB')).toBe('AAA1/BBB');
    expect(e('AAA/USDC/AAA')).toBe('AAA/USDC/AAA');
    expect(e('NNN/USDC/AAA')).toBe('NNN/USDC/AAA');
    expect(e('zz:AMB-yy:AMB')).toBe('zz:AMB-yy:AMB');
    expect(e('yy:SSS/SSS')).toBe('yy:SSS/SSS');
    expect(e('S&P5*2')).toBe('S&P5*2');
    expect(e('PPP - 26')).toBe('PPP - 26'); // the space keeps it from reading as the spot base
    expect(e('AAA*-BBB')).toBe('AAA*(-BBB)');
    for (const s of [
      'zz:AAA1/BBB',
      'AAA/USDC/AAA',
      'NNN/USDC/AAA',
      'zz:AMB-yy:AMB',
      'yy:SSS/SSS',
      'S&P5/B.D',
      'PPP - 26',
      'AAA - 2',
      '(AAA+BBB)/2',
      '-(AAA*BBB)+0.5*kAAA',
      '2Q-AAA',
      'AAA-2Q',
    ]) {
      const c = canon(s);
      expect(canon(e(s)), s).toBe(c);
    }
  });
  it('aliasFor: shortest unambiguous typeable alias per kind', () => {
    expect(INDEX.aliasFor('AAA')).toBe('AAA');
    expect(INDEX.aliasFor('@901')).toBe('AAA/USDC');
    expect(INDEX.aliasFor('@903')).toBe('PPP-26/USDC');
    expect(INDEX.aliasFor('NNN/USDC')).toBe('NNN/USDC');
    expect(INDEX.aliasFor('zz:AAA1')).toBe('AAA1');
    expect(INDEX.aliasFor('zz:AMB')).toBe('zz:AMB');
    expect(INDEX.aliasFor('yy:SSS')).toBe('yy:SSS');
    expect(INDEX.aliasFor('zz:SP5')).toBe('S&P5');
    expect(INDEX.aliasFor('zz:BD')).toBe('B.D');
    expect(INDEX.aliasFor('zz:10Q')).toBe('10Q');
    expect(INDEX.aliasFor('nope')).toBe('nope');
  });
  it('displayOf: header form per kind', () => {
    expect(INDEX.displayOf('AAA')).toBe('AAA');
    expect(INDEX.displayOf('@901')).toBe('AAA/USDC');
    expect(INDEX.displayOf('@903')).toBe('PPP-26/USDC');
    expect(INDEX.displayOf('zz:AAA1')).toBe('AAA1');
    expect(INDEX.displayOf('zz:AMB')).toBe('zz:AMB');
    expect(INDEX.displayOf('yy:SSS')).toBe('yy:SSS');
    expect(INDEX.displayOf('zz:SP5')).toBe('S&P5');
    expect(INDEX.displayOf('nope')).toBe('nope');
  });
  it('a HIP-3 display override that is not typeable falls back to the coin id', () => {
    const idx = buildNameIndex([hip3('zz:ODD', 'ODD CO'), hip3('zz:PLUS', 'A+B')]);
    expect(idx.aliasFor('zz:ODD')).toBe('ODD'); // the coin base still resolves
    expect(idx.aliasFor('zz:PLUS')).toBe('PLUS');
    expect(idx.displayOf('zz:ODD')).toBe('ODD CO');
  });
});

const MARKET_TABS = ['favorites', 'all', 'perps', 'spot', 'crypto', 'tradfi', 'hip3', 'trending', 'prelaunch'];

describe('isFormulaTrigger', () => {
  it("dead characters on every market tab: + * / ( ) [ and a leading '='", () => {
    for (const tab of MARKET_TABS) {
      for (const q of ['aaa+', 'aaa*', 'aaa/', '(', ')', '[', '=aaa', ' =', 'aaa×bbb', 'aaa÷', '（']) {
        expect(isFormulaTrigger(q, tab, INDEX), `${q} on ${tab}`).toBe(true);
        expect(isFormulaTrigger(q, tab), `${q} on ${tab}, no index`).toBe(true);
      }
      for (const q of ['', 'aaa', 'hype', 'claude', 'ai servers', 'e-c', 'e-commerce', '-aaa', '−aaa', 'ppp-26', 'ppp-2', 'ppp-']) {
        expect(isFormulaTrigger(q, tab, INDEX), `${q} on ${tab}`).toBe(false);
      }
    }
  });
  it("'-' fires only when its LEFT token resolves to a symbol (unique or ambiguous) or a number", () => {
    // an ambiguous base must reach the composer: the chip + dex-qualified row tap are its fix
    expect(isFormulaTrigger('amb-', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('amb-bbb', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('AMB-USDC-', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('hypex-', 'all', INDEX)).toBe(false);
    expect(isFormulaTrigger('ppp-2', 'all', INDEX)).toBe(false);
    expect(isFormulaTrigger('aaa-', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('aaa-bbb', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('aaa - 26', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('aaa−bbb', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('ppp-bbb', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('aaa/usdc-', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('2-', 'all', INDEX)).toBe(true);
    expect(isFormulaTrigger('hypex-', 'all', INDEX)).toBe(false);
    expect(isFormulaTrigger('e-c', 'all', INDEX)).toBe(false);
    // without an index only the number case can be known
    expect(isFormulaTrigger('aaa-', 'all')).toBe(false);
    expect(isFormulaTrigger('2-', 'all')).toBe(true);
  });
  it('the PUMP-26 case: a shadowed spot base being typed never flips the picker', () => {
    for (const q of ['ppp-', 'ppp-2', 'ppp-26', 'PPP-26']) expect(isFormulaTrigger(q, 'spot', INDEX), q).toBe(false);
    expect(isFormulaTrigger('ppp-26/usdc', 'spot', INDEX)).toBe(true); // '/' is a dead character regardless
  });
  it("never on the Outcome tab (question rows carry '/', '(', ')', '-' legitimately)", () => {
    for (const q of ['2026/2027', '(NFL)', 'Bodo/Glimt', 'Saint-Germain', 'aaa+bbb', '=aaa', '[', '2-']) {
      expect(isFormulaTrigger(q, 'outcome', INDEX), q).toBe(false);
    }
  });
});

describe('caret helpers', () => {
  it('caretToken with an index: the lexer token under the caret; after an operator it is empty', () => {
    const ct = (q: string, a: number) => caretToken(q, a, INDEX);
    expect(ct('aaa/bb', 6)).toEqual({ start: 4, end: 6, text: 'bb' });
    expect(ct('aaa/bb', 5)).toEqual({ start: 4, end: 6, text: 'bb' });
    expect(ct('aaa/bb', 4)).toEqual({ start: 4, end: 6, text: 'bb' });
    expect(ct('aaa/bb', 3)).toEqual({ start: 0, end: 3, text: 'aaa' });
    expect(ct('aaa/bb', 0)).toEqual({ start: 0, end: 3, text: 'aaa' });
    expect(ct('aaa/', 4)).toEqual({ start: 4, end: 4, text: '' });
    expect(ct('aaa/usdc', 8)).toEqual({ start: 0, end: 8, text: 'aaa/usdc' }); // a known pair stays whole
    expect(ct('aaa/usdx', 8)).toEqual({ start: 4, end: 8, text: 'usdx' });
    expect(ct('ppp-26/usdc*2', 5)).toEqual({ start: 0, end: 11, text: 'ppp-26/usdc' });
    expect(ct('ppp-2', 5)).toEqual({ start: 0, end: 5, text: 'ppp-2' }); // the shadowed base being typed
    expect(ct('aaa-2', 5)).toEqual({ start: 4, end: 5, text: '2' });
    expect(ct('(aaa+bbb)', 2)).toEqual({ start: 1, end: 4, text: 'aaa' });
    expect(ct('(aaa+bbb)', 9)).toEqual({ start: 9, end: 9, text: '' });
    expect(ct('aaa bbb', 3)).toEqual({ start: 0, end: 3, text: 'aaa' });
    expect(ct('aaa bbb', 4)).toEqual({ start: 4, end: 7, text: 'bbb' });
    expect(ct('=aaa', 1)).toEqual({ start: 1, end: 4, text: 'aaa' });
    expect(ct('zz:s&p5+b.d', 2)).toEqual({ start: 0, end: 7, text: 'zz:s&p5' });
    expect(ct('@901*aaa', 1)).toEqual({ start: 0, end: 4, text: '@901' });
    expect(ct('', 0)).toEqual({ start: 0, end: 0, text: '' });
    expect(ct('aaa', 99)).toEqual({ start: 0, end: 3, text: 'aaa' });
    expect(ct('ＡＡＡ／ＢＢ', 5)).toEqual({ start: 4, end: 6, text: 'BB' }); // fullwidth → ASCII, same positions
  });
  it("caretToken without an index: the name run with '/' and '-' as operators", () => {
    expect(caretToken('aaa/bb', 6)).toEqual({ start: 4, end: 6, text: 'bb' });
    expect(caretToken('aaa/bb', 3)).toEqual({ start: 0, end: 3, text: 'aaa' });
    expect(caretToken('aaa/', 4)).toEqual({ start: 4, end: 4, text: '' });
    expect(caretToken('aaa-2', 5)).toEqual({ start: 4, end: 5, text: '2' });
    expect(caretToken('zz:s&p5+b.d', 2)).toEqual({ start: 0, end: 7, text: 'zz:s&p5' });
    expect(caretToken('ＡＡＡ／ＢＢ', 5)).toEqual({ start: 4, end: 6, text: 'BB' });
  });
  it('replaceToken returns the new query and a caret right after the insert', () => {
    expect(replaceToken('aaa/bb', 4, 6, 'BBB')).toEqual({ q: 'aaa/BBB', caret: 7 });
    expect(replaceToken('xx/bbb', 0, 2, 'AAA')).toEqual({ q: 'AAA/bbb', caret: 3 });
    expect(replaceToken('aaa/', 4, 4, 'BBB')).toEqual({ q: 'aaa/BBB', caret: 7 });
    expect(replaceToken('', 0, 0, 'AAA')).toEqual({ q: 'AAA', caret: 3 });
    expect(replaceToken('aaa/bbb', 0, 3, 'NNN/USDC')).toEqual({ q: 'NNN/USDC/bbb', caret: 8 });
    expect(replaceToken('aaa', 2, 9, 'X')).toEqual({ q: 'aaX', caret: 3 }); // clamped range
  });
  it("replaceToken separates an inserted name from a following '-' (the PPP-2 hazard)", () => {
    expect(replaceToken('aaa-2', 0, 3, 'PPP')).toEqual({ q: 'PPP -2', caret: 3 });
    expect(canon('PPP -2')).toBe('=PPP-2');
    expect(replaceToken('aaa -2', 0, 3, 'PPP')).toEqual({ q: 'PPP -2', caret: 3 }); // no doubled space
    expect(replaceToken('aaa-bbb', 0, 3, 'PPP')).toEqual({ q: 'PPP -bbb', caret: 3 });
    expect(replaceToken('aaa/2', 0, 3, 'PPP')).toEqual({ q: 'PPP/2', caret: 3 });
    expect(replaceToken('aaa-2', 0, 3, '')).toEqual({ q: '-2', caret: 0 });
    expect(replaceToken('aaa-2', 3, 3, '-')).toEqual({ q: 'aaa--2', caret: 4 }); // an operator key, not a name
    // end to end: the left leg of 'aaa-2' swapped by a row tap stays a subtraction
    const t = caretToken('aaa-2', 1, INDEX);
    const { q } = replaceToken('aaa-2', t.start, t.end, INDEX.aliasFor('PPP'));
    expect(canon(q)).toBe('=PPP-2');
  });
  it('deleteToken removes one token, collapses the doubled space, and empties to ""', () => {
    expect(deleteToken('aaa/bbb', 4, 7)).toEqual({ q: 'aaa/', caret: 4 });
    expect(deleteToken('aaa/bbb', 0, 3)).toEqual({ q: '/bbb', caret: 0 });
    expect(deleteToken('aaa/bbb', 3, 4)).toEqual({ q: 'aaabbb', caret: 3 });
    expect(deleteToken('aaa + bbb', 6, 9)).toEqual({ q: 'aaa + ', caret: 6 });
    expect(deleteToken('aaa + bbb', 4, 5)).toEqual({ q: 'aaa bbb', caret: 4 });
    expect(deleteToken('aaa', 0, 3)).toEqual({ q: '', caret: 0 });
    expect(deleteToken(' aaa ', 1, 4)).toEqual({ q: '', caret: 0 });
    expect(deleteToken('aaa', 1, 99)).toEqual({ q: 'a', caret: 1 });
  });
  it('a row tap on an unresolved chip completes the formula through replaceToken', () => {
    const q = 'aaa/usdx';
    const e = err(q);
    const { q: fixed } = replaceToken(q, e.start, e.end, INDEX.aliasFor('BBB'));
    expect(canon(fixed)).toBe('=AAA/BBB');
  });
});
