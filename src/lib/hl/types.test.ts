import { describe, expect, it } from 'vitest';
import { coinKindOf } from './types';

// The four live id shapes and the strings that must never reach a candle
// subscription — HL closes the shared socket on any id outside its universe
// (ws.ts), and App.tsx's fallbackMarket refuses these before a cell can try.
describe('coinKindOf', () => {
  it('classifies every live id shape', () => {
    expect(coinKindOf('BTC')).toBe('perp');
    expect(coinKindOf('kPEPE')).toBe('perp');
    expect(coinKindOf('1000SHIB')).toBe('perp');
    expect(coinKindOf('PURR/USDC')).toBe('spot');
    expect(coinKindOf('@142')).toBe('spot');
    expect(coinKindOf('xyz:TSLA')).toBe('hip3');
    expect(coinKindOf('xyz:SP500')).toBe('hip3');
    expect(coinKindOf('hyna:6P')).toBe('hip3');
    expect(coinKindOf('#12090')).toBe('hip4');
  });

  it('refuses strings that cannot be HL ids', () => {
    expect(coinKindOf('=HYPE/ETH')).toBeNull();
    expect(coinKindOf('')).toBeNull();
    expect(coinKindOf('BTC USDC')).toBeNull();
    expect(coinKindOf('xyz:')).toBeNull();
    expect(coinKindOf(':TSLA')).toBeNull();
    expect(coinKindOf('@')).toBeNull();
    expect(coinKindOf('#')).toBeNull();
    expect(coinKindOf('a/b/c')).toBeNull();
    expect(coinKindOf('BTC\n')).toBeNull();
    expect(coinKindOf('<script>')).toBeNull();
  });
});
