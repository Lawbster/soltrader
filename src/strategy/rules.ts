import { createLogger } from '../utils';
import { TokenData, TradeWindow, FilterResult, ScoreResult } from '../analysis/types';
import { filterToken } from '../analysis/token-filter';
import { scoreToken } from './scoring';
import { loadStrategyConfig } from './strategy-config';

const log = createLogger('rules');

export interface EntrySignal {
  mint: string;
  passed: boolean;
  filterResult: FilterResult;
  scoreResult: ScoreResult | null;
  positionSizeUsdc: number;
  stopLossPct: number;
  reason?: string;
}

export interface ExitSignal {
  type: 'hard_stop' | 'tp1' | 'tp2' | 'runner_stop' | 'time_stop' | 'emergency';
  sellPct: number;
  reason: string;
}

export interface PortfolioState {
  equityUsdc: number;
  openPositions: number;
  openExposureUsdc: number;
  dailyPnlPct: number;
  consecutiveLosses: number;
  lastLossTime: number;
  stoppedOutTokens: Map<string, number>; // mint → stop-out timestamp
}

// --- Entry Logic ---

export function evaluateEntry(
  token: TokenData,
  window: TradeWindow,
  portfolio: PortfolioState,
  lpChange10mPct?: number,
  indicators?: { rsi?: number; connorsRsi?: number },
  isWatchlist = false,
  totalTrades = 0
): EntrySignal {
  const cfg = loadStrategyConfig();

  // Portfolio-level checks first
  const portfolioCheck = checkPortfolioLimits(portfolio, cfg);
  if (!portfolioCheck.passed) {
    return {
      mint: token.mint,
      passed: false,
      filterResult: portfolioCheck,
      scoreResult: null,
      positionSizeUsdc: 0,
      stopLossPct: 0,
      reason: portfolioCheck.reason,
    };
  }

  // Re-entry lockout check
  const lockoutTime = portfolio.stoppedOutTokens.get(token.mint);
  if (lockoutTime) {
    const hoursSinceLockout = (Date.now() - lockoutTime) / 3_600_000;
    if (hoursSinceLockout < cfg.portfolio.reEntryLockoutHours) {
      return {
        mint: token.mint,
        passed: false,
        filterResult: { passed: false, reason: `Re-entry lockout: ${Math.round(hoursSinceLockout)}h < ${cfg.portfolio.reEntryLockoutHours}h` },
        scoreResult: null,
        positionSizeUsdc: 0,
        stopLossPct: 0,
      };
    }
  }

  // Hard filters (universe + entry + LP stability)
  const filterResult = filterToken(token, window, lpChange10mPct, indicators, isWatchlist);
  if (!filterResult.passed) {
    return {
      mint: token.mint,
      passed: false,
      filterResult,
      scoreResult: null,
      positionSizeUsdc: 0,
      stopLossPct: 0,
    };
  }

  // Scoring
  const scoreResult = scoreToken(token, window);
  if (!scoreResult.passed) {
    return {
      mint: token.mint,
      passed: false,
      filterResult,
      scoreResult,
      positionSizeUsdc: 0,
      stopLossPct: 0,
      reason: `Score ${Math.round(scoreResult.total)} < ${cfg.entry.minScoreToTrade}`,
    };
  }

  // Position sizing — with liquidity cap + sample size gate (all USDC)
  const positionSizeUsdc = calculatePositionSize(
    portfolio.equityUsdc, cfg, token.liquidityUsd, totalTrades
  );
  const stopLossPct = cfg.position.initialStopPct;

  log.info('ENTRY SIGNAL', {
    mint: token.mint,
    score: Math.round(scoreResult.total),
    sizeUsdc: positionSizeUsdc.toFixed(2),
    stopPct: stopLossPct,
    liquidityUsd: Math.round(token.liquidityUsd),
    totalTrades,
  });

  return {
    mint: token.mint,
    passed: true,
    filterResult,
    scoreResult,
    positionSizeUsdc,
    stopLossPct,
  };
}

// --- Exit Logic ---

export function evaluateExit(
  currentPnlPct: number,
  peakPnlPct: number,
  holdTimeMinutes: number,
  liquidityChangePct: number,
  tp1Hit: boolean,
  tp2Hit: boolean
): ExitSignal | null {
  const cfg = loadStrategyConfig().exits;

  // Emergency: liquidity drop
  if (liquidityChangePct < cfg.emergencyLpDropPct) {
    return {
      type: 'emergency',
      sellPct: 100,
      reason: `LP dropped ${liquidityChangePct.toFixed(1)}% in ${cfg.emergencyLpDropWindowMinutes}m`,
    };
  }

  // Hard stop
  if (currentPnlPct <= cfg.hardStopPct) {
    return {
      type: 'hard_stop',
      sellPct: 100,
      reason: `Hard stop hit: ${currentPnlPct.toFixed(1)}% <= ${cfg.hardStopPct}%`,
    };
  }

  // TP1: +12%, sell 50%
  if (!tp1Hit && currentPnlPct >= cfg.tp1.targetPct) {
    return {
      type: 'tp1',
      sellPct: cfg.tp1.sellPct,
      reason: `TP1 hit: ${currentPnlPct.toFixed(1)}% >= ${cfg.tp1.targetPct}%`,
    };
  }

  // TP2: +22%, sell 30%
  if (tp1Hit && !tp2Hit && currentPnlPct >= cfg.tp2.targetPct) {
    return {
      type: 'tp2',
      sellPct: cfg.tp2.sellPct,
      reason: `TP2 hit: ${currentPnlPct.toFixed(1)}% >= ${cfg.tp2.targetPct}%`,
    };
  }

  // Runner trailing stop: after TP2, trail 6% from peak
  if (tp2Hit) {
    const trailDrop = peakPnlPct - currentPnlPct;
    if (trailDrop >= cfg.runner.trailingStopPct) {
      return {
        type: 'runner_stop',
        sellPct: 100, // Sell remaining runner
        reason: `Runner trailing stop: dropped ${trailDrop.toFixed(1)}% from peak ${peakPnlPct.toFixed(1)}%`,
      };
    }
  }

  // After TP1 (stop moved to breakeven): exit if drops back to 0%
  if (tp1Hit && !tp2Hit && currentPnlPct <= 0) {
    return {
      type: 'hard_stop',
      sellPct: 100,
      reason: `Breakeven stop after TP1: PnL ${currentPnlPct.toFixed(1)}%`,
    };
  }

  // Time stop: 20 min with PnL between -3% and +6%
  const [timeStopMin, timeStopMax] = cfg.timeStopPnlRangePct;
  if (holdTimeMinutes >= cfg.timeStopMinutes && currentPnlPct >= timeStopMin && currentPnlPct <= timeStopMax) {
    return {
      type: 'time_stop',
      sellPct: 100,
      reason: `Time stop: ${holdTimeMinutes}m, PnL ${currentPnlPct.toFixed(1)}% in dead zone`,
    };
  }

  return null; // Hold
}

// --- Portfolio Risk Checks ---

function checkPortfolioLimits(
  portfolio: PortfolioState,
  cfg: ReturnType<typeof loadStrategyConfig>
): FilterResult {
  if (portfolio.openPositions >= cfg.portfolio.maxConcurrentPositions) {
    return { passed: false, reason: `Max positions: ${portfolio.openPositions}/${cfg.portfolio.maxConcurrentPositions}` };
  }

  const exposurePct = portfolio.equityUsdc > 0
    ? (portfolio.openExposureUsdc / portfolio.equityUsdc) * 100
    : 0;
  if (exposurePct >= cfg.portfolio.maxOpenExposurePct) {
    return { passed: false, reason: `Max exposure: ${exposurePct.toFixed(1)}% >= ${cfg.portfolio.maxOpenExposurePct}%` };
  }

  if (portfolio.dailyPnlPct <= cfg.portfolio.dailyLossLimitPct) {
    return { passed: false, reason: `Daily loss limit: ${portfolio.dailyPnlPct.toFixed(1)}% <= ${cfg.portfolio.dailyLossLimitPct}%` };
  }

  if (portfolio.consecutiveLosses >= cfg.portfolio.consecutiveLossLimit) {
    const cooldownMs = cfg.portfolio.consecutiveLossCooldownMinutes * 60_000;
    const timeSinceLoss = Date.now() - portfolio.lastLossTime;
    if (timeSinceLoss < cooldownMs) {
      const minsLeft = Math.round((cooldownMs - timeSinceLoss) / 60_000);
      return { passed: false, reason: `Consecutive loss cooldown: ${minsLeft}m remaining` };
    }
  }

  return { passed: true };
}

// --- Position Sizing ---

function calculatePositionSize(
  equityUsdc: number,
  cfg: ReturnType<typeof loadStrategyConfig>,
  liquidityUsd: number,
  totalTrades: number
): number {
  // risk_per_trade / stop_distance (all in USDC)
  const riskUsdc = equityUsdc * (cfg.position.riskPerTradePct / 100);
  const stopDistance = cfg.position.initialStopPct / 100;
  const sizeFromRisk = riskUsdc / stopDistance;

  // Cap at max position size and equity percentage
  const maxFromEquity = equityUsdc * (cfg.position.maxPositionEquityPct / 100);
  const maxAbsolute = cfg.position.maxPositionUsdc;

  // Liquidity cap: trade size ≤ liquidityCapPct% of pool liquidity (already in USD ≈ USDC)
  let maxFromLiquidity = Infinity;
  if (liquidityUsd > 0 && cfg.position.liquidityCapPct > 0) {
    maxFromLiquidity = liquidityUsd * (cfg.position.liquidityCapPct / 100);
  }

  // Sample size gate: cap position until enough trades validate the strategy
  let maxFromSampleGate = Infinity;
  if (totalTrades < cfg.position.sampleSizeGateMinTrades) {
    maxFromSampleGate = cfg.position.sampleSizeGateMaxUsdc;
  }

  const finalSize = Math.min(
    sizeFromRisk, maxFromEquity, maxAbsolute, maxFromLiquidity, maxFromSampleGate
  );

  log.debug('Position size calculated', {
    equityUsdc,
    sizeFromRisk: sizeFromRisk.toFixed(2),
    maxFromEquity: maxFromEquity.toFixed(2),
    maxAbsolute,
    maxFromLiquidity: maxFromLiquidity === Infinity ? 'N/A' : maxFromLiquidity.toFixed(2),
    maxFromSampleGate: maxFromSampleGate === Infinity ? 'N/A' : maxFromSampleGate.toFixed(2),
    totalTrades,
    finalSize: finalSize.toFixed(2),
  });

  return finalSize;
}
