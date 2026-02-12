import { createLogger } from '../utils';
import { TokenData, TradeWindow, ScoreResult } from '../analysis/types';
import { loadStrategyConfig } from './strategy-config';

const log = createLogger('scoring');

// Normalize a value to 0-100 range using min/max bounds
function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

function scoreMomentum(token: TokenData, window: TradeWindow): number {
  // 5m return: 6% (min threshold) → 0, 30%+ → 100
  const returnScore = normalize(window.return5mPct, 6, 30);

  // Price above VWAP ratio: 1.0 (at VWAP) → 0, 1.1+ → 100
  const vwapRatio = window.vwap > 0 ? token.priceSol / window.vwap : 1;
  const vwapScore = normalize(vwapRatio, 1.0, 1.1);

  return (returnScore * 0.6 + vwapScore * 0.4);
}

function scoreBuySellPressure(window: TradeWindow): number {
  // Buy/sell ratio: 1.4 (min threshold) → 0, 3.0+ → 100
  const ratioScore = normalize(window.buySellRatio, 1.4, 3.0);

  // Unique buyer count: 25 (min) → 0, 80+ → 100
  const buyerScore = normalize(window.uniqueBuyers, 25, 80);

  return (ratioScore * 0.6 + buyerScore * 0.4);
}

function scoreHolderDistribution(token: TokenData): number {
  // Lower top10 holder % = better. Invert: 35% (worst allowed) → 0, 10% → 100
  const holderScore = normalize(35 - token.top10HolderPct, 0, 25);

  // More holders = better. holderCount is limited by getTokenLargestAccounts (top 20)
  // 5 → 0, 20 → 100
  const countScore = normalize(token.holderCount, 5, 20);

  return (holderScore * 0.7 + countScore * 0.3);
}

function scoreLiquidityDepth(token: TokenData): number {
  // Liquidity: $15k (min threshold) → 0, $100k+ → 100
  const liqScore = normalize(token.liquidityUsd, 15000, 100000);
  return liqScore;
}

function scoreWalletConcentrationRisk(window: TradeWindow): number {
  // This is a PENALTY component — high concentration = low score
  // maxSingleWalletBuyPct: 12% (worst allowed) → 0, 2% or less → 100
  return normalize(12 - window.maxSingleWalletBuyPct, 0, 10);
}

export function scoreToken(token: TokenData, window: TradeWindow): ScoreResult {
  const cfg = loadStrategyConfig();
  const weights = cfg.scoring.weights;

  const components = {
    momentumStrength: scoreMomentum(token, window),
    buySellPressure: scoreBuySellPressure(window),
    holderDistribution: scoreHolderDistribution(token),
    liquidityDepth: scoreLiquidityDepth(token),
    walletConcentrationRisk: scoreWalletConcentrationRisk(window),
  };

  const total =
    components.momentumStrength * weights.momentumStrength +
    components.buySellPressure * weights.buySellPressure +
    components.holderDistribution * weights.holderDistribution +
    components.liquidityDepth * weights.liquidityDepth +
    components.walletConcentrationRisk * weights.walletConcentrationRisk;

  const passed = total >= cfg.entry.minScoreToTrade;

  log.debug('Token scored', {
    mint: token.mint,
    total: Math.round(total),
    passed,
    components: Object.fromEntries(
      Object.entries(components).map(([k, v]) => [k, Math.round(v)])
    ),
  });

  return { total, components, passed };
}
