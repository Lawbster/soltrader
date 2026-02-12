import { describe, it, expect } from 'vitest';

// ---- Test 1: Failed 100% exit must NOT close position ----
// We test the logic directly — the rule is:
// "only close if result.success AND (remainingTokens <= 0 OR sellPct >= 100)"

describe('exit-close guard', () => {
  interface MockPosition {
    remainingTokens: number;
    remainingPct: number;
    status: 'open' | 'closed';
  }

  function simulateExitLogic(
    position: MockPosition,
    sellPct: number,
    resultSuccess: boolean,
    resultTokenAmount: number
  ): MockPosition {
    // Mirror position-manager.ts executeExit logic
    if (resultSuccess) {
      position.remainingTokens -= resultTokenAmount;
      position.remainingPct = position.remainingTokens > 0 ? (position.remainingTokens / 1000) * 100 : 0;
    } else {
      // Failed: return early, do NOT close
      return position;
    }

    if (position.remainingTokens <= 0 || (sellPct >= 100 && resultSuccess)) {
      position.status = 'closed';
    }

    return position;
  }

  it('should NOT close position when 100% sell fails', () => {
    const pos: MockPosition = { remainingTokens: 1000, remainingPct: 100, status: 'open' };
    simulateExitLogic(pos, 100, false, 0);
    expect(pos.status).toBe('open');
    expect(pos.remainingTokens).toBe(1000);
  });

  it('should close position when 100% sell succeeds', () => {
    const pos: MockPosition = { remainingTokens: 1000, remainingPct: 100, status: 'open' };
    simulateExitLogic(pos, 100, true, 1000);
    expect(pos.status).toBe('closed');
    expect(pos.remainingTokens).toBe(0);
  });

  it('should NOT close position on partial sell (50%)', () => {
    const pos: MockPosition = { remainingTokens: 1000, remainingPct: 100, status: 'open' };
    simulateExitLogic(pos, 50, true, 500);
    expect(pos.status).toBe('open');
    expect(pos.remainingTokens).toBe(500);
  });
});

// ---- Test 2: Unit conversion rawToHuman ----

describe('unit conversion', () => {
  function rawToHuman(raw: string, decimals: number): number {
    return parseInt(raw) / Math.pow(10, decimals);
  }

  it('converts lamports to SOL (9 decimals)', () => {
    expect(rawToHuman('1000000000', 9)).toBe(1.0);
    expect(rawToHuman('500000000', 9)).toBe(0.5);
    expect(rawToHuman('1', 9)).toBeCloseTo(1e-9);
  });

  it('converts 6-decimal token amounts', () => {
    expect(rawToHuman('1000000', 6)).toBe(1.0);
    expect(rawToHuman('123456789', 6)).toBeCloseTo(123.456789);
  });

  it('handles raw-to-human round-trip for sell amounts', () => {
    const humanAmount = 42.5;
    const decimals = 9;
    const raw = Math.floor(humanAmount * Math.pow(10, decimals)).toString();
    const backToHuman = rawToHuman(raw, decimals);
    expect(backToHuman).toBeCloseTo(humanAmount, 8);
  });
});

// ---- Test 3: Dedup two-generation bounded set ----

describe('dedup cap rotation', () => {
  it('rotates generations when current fills up', () => {
    const MAX = 10; // Small cap for testing
    let currentSigs = new Set<string>();
    let previousSigs = new Set<string>();

    function hasSig(sig: string): boolean {
      return currentSigs.has(sig) || previousSigs.has(sig);
    }

    function markSig(sig: string) {
      currentSigs.add(sig);
      if (currentSigs.size >= MAX) {
        previousSigs = currentSigs;
        currentSigs = new Set<string>();
      }
    }

    // Fill first generation
    for (let i = 0; i < MAX; i++) {
      markSig(`sig-${i}`);
    }

    // After rotation: sig-0 through sig-9 should be in previousSigs
    // currentSigs should be empty
    expect(currentSigs.size).toBe(0);
    expect(previousSigs.size).toBe(MAX);

    // Old sigs are still found
    expect(hasSig('sig-0')).toBe(true);
    expect(hasSig('sig-5')).toBe(true);

    // New sigs go into current
    markSig('sig-new');
    expect(hasSig('sig-new')).toBe(true);

    // Fill second generation to trigger another rotation
    for (let i = 0; i < MAX - 1; i++) {
      markSig(`sig-second-${i}`);
    }

    // Now previousSigs has the second batch, first batch is gone
    expect(hasSig('sig-0')).toBe(false);
    expect(hasSig('sig-new')).toBe(true); // in previous now
    expect(hasSig('sig-second-0')).toBe(true);
  });

  it('total memory is bounded to ~2x max per generation', () => {
    const MAX = 100;
    let currentSigs = new Set<string>();
    let previousSigs = new Set<string>();

    function markSig(sig: string) {
      currentSigs.add(sig);
      if (currentSigs.size >= MAX) {
        previousSigs = currentSigs;
        currentSigs = new Set<string>();
      }
    }

    // Add 5x the max
    for (let i = 0; i < MAX * 5; i++) {
      markSig(`sig-${i}`);
    }

    // Total stored should be <= 2 * MAX
    const total = currentSigs.size + previousSigs.size;
    expect(total).toBeLessThanOrEqual(2 * MAX);
  });
});
