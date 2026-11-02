import { describe, expect, it } from 'vitest';
import {
  crossed,
  fmtAlertPrice,
  MAX_ALERTS,
  pctTarget,
  sanitizeAlerts,
} from './alerts';

describe('crossed', () => {
  it('fires up when the price rises through the threshold', () => {
    expect(crossed(99, 101, 100)).toBe('up');
  });

  it('fires down when the price falls through the threshold', () => {
    expect(crossed(101, 99, 100)).toBe('down');
  });

  it('never fires without a predecessor (first sample only sets the baseline)', () => {
    expect(crossed(null, 101, 100)).toBeNull();
    expect(crossed(null, 99, 100)).toBeNull();
  });

  it('stays silent while the price remains on one side', () => {
    expect(crossed(99, 99.5, 100)).toBeNull();
    expect(crossed(101, 105, 100)).toBeNull();
  });

  it('touching the level from below counts as an upward cross', () => {
    // the threshold itself is "at or above" — the level traded
    expect(crossed(99, 100, 100)).toBe('up');
  });

  it('leaving the exact level downward counts as a downward cross', () => {
    expect(crossed(100, 99, 100)).toBe('down');
  });

  it('sitting exactly on the level twice does not re-fire', () => {
    expect(crossed(100, 100, 100)).toBeNull();
  });

  it('fires on every crossing — oscillation alternates up/down', () => {
    expect(crossed(99, 101, 100)).toBe('up');
    expect(crossed(101, 99, 100)).toBe('down');
    expect(crossed(99, 101, 100)).toBe('up');
  });

  it('ignores non-finite samples', () => {
    expect(crossed(NaN, 101, 100)).toBeNull();
    expect(crossed(99, NaN, 100)).toBeNull();
  });
});

describe('pctTarget', () => {
  it('applies signed percentages to the base', () => {
    expect(pctTarget(100, 5)).toBeCloseTo(105);
    expect(pctTarget(100, -5)).toBeCloseTo(95);
    expect(pctTarget(0.034, 10)).toBeCloseTo(0.0374);
  });
});

describe('fmtAlertPrice', () => {
  it('groups thousands and keeps the entered precision', () => {
    expect(fmtAlertPrice(65000)).toBe('65,000');
    expect(fmtAlertPrice(65000.5)).toBe('65,000.5');
  });

  it('keeps sub-cent precision instead of rounding it away', () => {
    expect(fmtAlertPrice(0.00001234)).toBe('0.00001234');
  });
});

describe('sanitizeAlerts', () => {
  const good = {
    id: 'a1',
    coin: 'BTC',
    label: 'BTC-USDC',
    price: 65000,
    mode: 'price',
    createdAt: 1754300000000,
  };

  it('passes well-formed alerts through', () => {
    expect(sanitizeAlerts([good])).toEqual([good]);
  });

  it('keeps pct metadata only when numeric', () => {
    const pct = { ...good, mode: 'pct', pct: 5, base: 61904.76 };
    expect(sanitizeAlerts([pct])[0]).toMatchObject({ pct: 5, base: 61904.76 });
    const bad = { ...good, mode: 'pct', pct: 'five', base: NaN };
    const out = sanitizeAlerts([bad])[0];
    expect(out.pct).toBeUndefined();
    expect(out.base).toBeUndefined();
  });

  it('drops malformed entries instead of failing the whole list', () => {
    expect(
      sanitizeAlerts([
        null,
        42,
        { ...good, price: -1 },
        { ...good, price: NaN },
        { ...good, price: Infinity },
        { ...good, coin: '' },
        { ...good, id: '' },
        { ...good, mode: 'weekly' },
        good,
      ]),
    ).toEqual([good]);
  });

  it('falls back to the coin when the label is missing', () => {
    const { label: _label, ...noLabel } = good;
    expect(sanitizeAlerts([noLabel])[0].label).toBe('BTC');
  });

  it('rejects non-arrays and caps the list', () => {
    expect(sanitizeAlerts('nope')).toEqual([]);
    expect(sanitizeAlerts({})).toEqual([]);
    const many = Array.from({ length: MAX_ALERTS + 20 }, (_, i) => ({ ...good, id: `a${i}` }));
    expect(sanitizeAlerts(many)).toHaveLength(MAX_ALERTS);
  });
});
