import { describe, expect, test } from 'vitest';
import { buildNumericRecordKey, buildProtectionKey } from '../src/strategy/route-fingerprint';

describe('route fingerprint helpers', () => {
  test('buildNumericRecordKey sorts keys and normalizes numeric values', () => {
    const key = buildNumericRecordKey({
      zeta: 2,
      alpha: 1.23456789,
      beta: NaN,
      gamma: 3.5,
    });

    expect(key).toBe('alpha=1.234568 gamma=3.5 zeta=2');
  });

  test('buildProtectionKey omits undefined and non-finite values', () => {
    const key = buildProtectionKey({
      trailGapPct: 1.25,
      trailArmPct: 2.5,
      staleMaxHoldMinutes: Number.POSITIVE_INFINITY,
      staleMinPnlPct: 0,
    });

    expect(key).toBe('staleMinPnlPct=0 trailArmPct=2.5 trailGapPct=1.25');
  });
});
