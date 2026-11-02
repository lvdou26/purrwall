import { describe, expect, it } from 'vitest';
import { fmtFunding, fundingApr } from './stats';

// SCOPE NOTE: this pins the funding DISPLAY CONTRACT. The value the tables
// and the cell badge show must stay byte-identical to what
// app.hyperliquid.xyz's trade-page header shows for the same market — that
// equality is the feature, and nothing else in the suite would catch it
// silently regressing (an accidental `* 8` would put an unexplained 8x
// between the two). The fetch/shape half of stats.ts is network code and
// stays browser-verified.

describe('fmtFunding', () => {
  // HL's bundle renders this number as `${(100*n).toFixed(4)}%`. Every case
  // below is a real ctx.funding value, with the string Hyperliquid printed
  // for it at the same instant.
  it('matches what Hyperliquid prints, to the character', () => {
    expect(fmtFunding(0.0000125)).toBe('0.0013%'); // BTC, HYPE, PURR, kPEPE
    expect(fmtFunding(0.0000011877)).toBe('0.0001%'); // ETH
    expect(fmtFunding(-0.000015424)).toBe('-0.0015%'); // SOL
  });

  it('does not rescale — the API field is already per hour', () => {
    // The bug this guards: `* 8` is right for an "8h Funding" column (HL's
    // selector does exactly that) but shows 8x on a chart-adjacent surface,
    // which is where HL itself shows the hourly rate.
    expect(fmtFunding(0.0000125)).not.toBe(fmtFunding(0.0000125 * 8));
    expect(fmtFunding(0.0000125 * 8)).toBe('0.0100%'); // the 8h string
  });

  it('renders a missing rate as the table placeholder, not 0%', () => {
    // Spot and HIP-4 rows have no funding at all; 0.0000% would be a claim.
    expect(fmtFunding(null)).toBe('--');
  });

  it('survives the extremes without losing the sign or the unit', () => {
    // 4%/hour is HL's documented funding cap; -0.036018% is a real extreme
    // HIP-3 rate.
    expect(fmtFunding(0.04)).toBe('4.0000%');
    expect(fmtFunding(-0.00036018)).toBe('-0.0360%');
    expect(fmtFunding(0)).toBe('0.0000%');
  });
});

describe('fundingApr', () => {
  it('annualizes hourly at 24x365, the factor HL uses in its own tooltip', () => {
    // 0.01% per 8h = 0.00125%/h is HL's default interest component, and the
    // docs state it as "11.6% APR"; 8760 hours puts it at 10.95%.
    expect(fundingApr(0.0000125)).toBe('10.95%');
    expect(fundingApr(-0.0000125)).toBe('-10.95%');
  });

  it('separates markets that the 4-decimal hourly view collapses', () => {
    // ~48% of live perps sit pinned on their dex's interest floor, and the
    // main dex (1.0x) and xyz (0.5x multiplier) print DIFFERENT hourly
    // strings but are easiest to tell apart annualized. This is why the
    // tooltip carries it.
    expect(fundingApr(0.0000125)).toBe('10.95%'); // main dex floor
    expect(fundingApr(0.00000625)).toBe('5.48%'); // xyz, 0.5x multiplier
  });

  it('has no opinion about a missing rate', () => {
    expect(fundingApr(null)).toBe('--');
  });
});
