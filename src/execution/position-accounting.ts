import type { Position } from './types';

export interface TrackedExitSummary {
  trackedTokensSold: number;
  trackedUsdcOut: number;
  orphanedTokensSold: number;
  orphanedUsdcOut: number;
}

function finiteOrZero(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

export function summarizeTrackedExits(position: Position): TrackedExitSummary {
  let trackedTokensRemaining = Math.max(0, finiteOrZero(position.initialTokens));
  let trackedTokensSold = 0;
  let trackedUsdcOut = 0;
  let orphanedTokensSold = 0;
  let orphanedUsdcOut = 0;

  for (const exit of position.exits ?? []) {
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
    trackedTokensSold += trackedTokens;
    trackedUsdcOut += trackedUsdc;
    orphanedTokensSold += orphanedTokens;
    orphanedUsdcOut += orphanedUsdc;
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
