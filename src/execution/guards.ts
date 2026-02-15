import { createLogger } from '../utils';
import { loadStrategyConfig } from '../strategy/strategy-config';
import { SwapQuote } from './types';

const log = createLogger('guards');

export interface GuardResult {
  passed: boolean;
  reason?: string;
}

// Validate a Jupiter quote before execution
export function validateQuote(quote: SwapQuote): GuardResult {
  const cfg = loadStrategyConfig();

  // Route impact check
  if (quote.priceImpactPct > cfg.execution.maxRouteImpactPct) {
    return {
      passed: false,
      reason: `Route impact ${quote.priceImpactPct.toFixed(2)}% > max ${cfg.execution.maxRouteImpactPct}%`,
    };
  }

  // Slippage sanity check — the quote carries whatever BPS we requested,
  // so validate against a reasonable upper bound (not the entry filter threshold).
  // Sells use 300 BPS, entries use ~15 BPS — accept both.
  const DEFAULT_MAX_SLIPPAGE_BPS = 300;
  if (quote.slippageBps > DEFAULT_MAX_SLIPPAGE_BPS) {
    return {
      passed: false,
      reason: `Slippage ${quote.slippageBps}bps > max ${DEFAULT_MAX_SLIPPAGE_BPS}bps`,
    };
  }

  // Output amount sanity — must be non-zero
  if (!quote.outAmount || BigInt(quote.outAmount) <= 0n) {
    return {
      passed: false,
      reason: 'Quote returned zero output amount',
    };
  }

  log.debug('Quote passed guards', {
    impact: quote.priceImpactPct.toFixed(2),
    slippageBps: quote.slippageBps,
  });

  return { passed: true };
}

// Validate transaction simulation result
export function validateSimulation(
  simulationResult: { err: unknown } | null
): GuardResult {
  if (!simulationResult) {
    return { passed: false, reason: 'Simulation returned null' };
  }

  if (simulationResult.err) {
    return {
      passed: false,
      reason: `Simulation failed: ${JSON.stringify(simulationResult.err)}`,
    };
  }

  return { passed: true };
}

// Kill switch: check if we should halt all trading
export function checkKillSwitch(
  dailyPnlPct: number,
  consecutiveLosses: number
): GuardResult {
  const cfg = loadStrategyConfig();

  if (dailyPnlPct <= cfg.portfolio.dailyLossLimitPct) {
    return {
      passed: false,
      reason: `Daily loss limit hit: ${dailyPnlPct.toFixed(1)}% <= ${cfg.portfolio.dailyLossLimitPct}%`,
    };
  }

  if (consecutiveLosses >= cfg.portfolio.consecutiveLossLimit) {
    return {
      passed: false,
      reason: `Consecutive loss limit: ${consecutiveLosses} >= ${cfg.portfolio.consecutiveLossLimit}`,
    };
  }

  return { passed: true };
}
