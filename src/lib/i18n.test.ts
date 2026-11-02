import { describe, expect, it } from 'vitest';
import { dict, fmt, type StrKey } from './i18n';

const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('formula-bar strings', () => {
  const fxKeys = (Object.keys(dict.en) as StrKey[]).filter((k) => /^(fx|cell_fx)_/.test(k));
  it('exist in both languages with the same {slot} names', () => {
    expect(fxKeys.length).toBeGreaterThan(0);
    for (const k of fxKeys) {
      expect(dict.zh[k], k).toBeTypeOf('string');
      expect(slots(dict.zh[k]), k).toEqual(slots(dict.en[k]));
    }
  });
  it('fmt fills slots in either position and leaves unknown ones verbatim', () => {
    expect(fmt('Pick a market for {word}', { word: 'XYZ' })).toBe('Pick a market for XYZ');
    expect(fmt('为 {word} 选择一个市场', { word: 'XYZ' })).toBe('为 XYZ 选择一个市场');
    expect(fmt('Up to {n} markets', { n: 4 })).toBe('Up to 4 markets');
    expect(fmt('{missing} stays', {})).toBe('{missing} stays');
  });
});
