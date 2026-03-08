import type { Position } from './types';

export interface TrackedExitSummary {
  trackedTokensSold: number;
  trackedUsdcOut: number;
  orphanedTokensSold: number;
  orphanedUsdcOut: number;
}

export interface ExitAllocation {
  exitIndex: number;
  trackedTokens: number;
  trackedUsdc: number;
  orphanedTokens: number;
  orphanedUsdc: number;
}

function finiteOrZero(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

export function allocateTrackedExitSlices(position: Position): ExitAllocation[] {
  let trackedTokensRemaining = Math.max(0, finiteOrZero(position.initialTokens));
  const allocations: ExitAllocation[] = [];

  for (let i = 0; i < (position.exits ?? []).length; i++) {
    const exit = position.exits[i]!;
    const exitTokens = Math.max(0, finiteOrZero(exit.tokensSold));
    const exitUsdc = finiteOrZero(exit.usdcReceived);
    if (exitTokens <= 0 && exitUsdc <= 0) continue;

    const trackedTokens = Math.min(exitTokens, trackedTokensRemaining);
    const trackedUsdc = exitTokens > 0
      ? exitUsdc * (trackedTokens / exitTokens)
      : 0;

    const orphanedTokens = Math.max(0, exitTokens - trackedTokens);
    const orphanedUsdc = Math.max(0, exitUsdc - trackedUsdc);

    trackedTokensRemaining = Math.max(0, trackedTokensRemaining - trackedTokens);
    allocations.push({
      exitIndex: i,
      trackedTokens,
      trackedUsdc,
      orphanedTokens,
      orphanedUsdc,
    });
  }

  return allocations;
}

export function summarizeTrackedExits(position: Position): TrackedExitSummary {
  let trackedTokensSold = 0;
  let trackedUsdcOut = 0;
  let orphanedTokensSold = 0;
  let orphanedUsdcOut = 0;

  for (const allocation of allocateTrackedExitSlices(position)) {
    trackedTokensSold += allocation.trackedTokens;
    trackedUsdcOut += allocation.trackedUsdc;
    orphanedTokensSold += allocation.orphanedTokens;
    orphanedUsdcOut += allocation.orphanedUsdc;
  }

  return {
    trackedTokensSold,
    trackedUsdcOut,
    orphanedTokensSold,
    orphanedUsdcOut,
  };
}

export function calculateTrackedPnlUsdc(position: Position): number {
  return summarizeTrackedExits(position).trackedUsdcOut - finiteOrZero(position.initialSizeUsdc);
}
