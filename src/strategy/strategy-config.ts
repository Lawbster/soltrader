import fs from 'fs';
import path from 'path';

export interface StrategyConfig {
  version: string;
  universe: {
    tokenAgeMinMinutes: number;
    tokenAgeMaxMinutes: number;
    mcapMinUsd: number;
    mcapMaxUsd: number;
    minLiquidityUsd: number;
    minVolume5mUsd: number;
    requireAuthorityRenounced: boolean;
    maxTop10HolderPct: number;
  };
  entry: {
    minReturn5mPct: number;
    minBuySellRatio5m: number;
    minUniqueBuyers5m: number;
    maxSingleWalletBuyPct: number;
    maxLpChange10mPct: number;
    maxSlippagePct: number;
    minScoreToTrade: number;
    indicators: {
      enabled: boolean;
      candleIntervalMinutes: number;
      candleLookbackMinutes: number;
      rsi: {
        enabled: boolean;
        period: number;
        oversold: number;
      };
      connors: {
        enabled: boolean;
        rsiPeriod: number;
        streakRsiPeriod: number;
        percentRankPeriod: number;
        oversold: number;
      };
    };
  };
  scoring: {
    weights: {
      momentumStrength: number;
      buySellPressure: number;
      holderDistribution: number;
      liquidityDepth: number;
      walletConcentrationRisk: number;
    };
  };
  position: {
    riskPerTradePct: number;
    maxPositionSol: number;
    maxPositionEquityPct: number;
    initialStopPct: number;
    liquidityCapPct: number;         // max % of pool liquidity per trade (0.05 = 0.05%)
    maxEntryImpactPct: number;       // reject if Jupiter quote impact exceeds this
    sampleSizeGateMinTrades: number; // min trades before allowing large positions
    sampleSizeGateMaxSol: number;    // position cap until sample size gate clears
  };
  exits: {
    hardStopPct: number;
    tp1: { targetPct: number; sellPct: number };
    tp2: { targetPct: number; sellPct: number };
    runner: { trailingStopPct: number; remainingPct: number };
    timeStopMinutes: number;
    timeStopPnlRangePct: [number, number];
    emergencyLpDropPct: number;
    emergencyLpDropWindowMinutes: number;
  };
  portfolio: {
    maxConcurrentPositions: number;
    maxOpenExposurePct: number;
    dailyLossLimitPct: number;
    consecutiveLossLimit: number;
    consecutiveLossCooldownMinutes: number;
    reEntryLockoutHours: number;
  };
  execution: {
    maxRouteImpactPct: number;
    maxRetries: number;
    simulateBeforeSubmit: boolean;
  };
  paperTrading: {
    latencyRangeMs: [number, number];
    txFailureProbability: number;
    slippageSimulation: boolean;
    priorityFeeSimulation: boolean;
  };
}

let _config: StrategyConfig | null = null;

export function loadStrategyConfig(configPath?: string): StrategyConfig {
  if (_config) return _config;

  const p = configPath || path.resolve(__dirname, '../../config/strategy.v1.json');
  const raw = fs.readFileSync(p, 'utf-8');
  _config = JSON.parse(raw) as StrategyConfig;

  // Validate weights sum to 1.0
  const weights = _config.scoring.weights;
  const sum = weights.momentumStrength + weights.buySellPressure +
    weights.holderDistribution + weights.liquidityDepth + weights.walletConcentrationRisk;
  if (Math.abs(sum - 1.0) > 0.01) {
    throw new Error(`Scoring weights must sum to 1.0, got ${sum}`);
  }

  return _config;
}
