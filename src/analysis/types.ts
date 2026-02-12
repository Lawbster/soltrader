export interface TokenData {
  mint: string;
  // Metadata
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  totalSupply: number;
  decimals: number;
  // Market data
  priceSol: number;
  priceUsd: number;
  mcapUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  // Holder data
  top10HolderPct: number;
  holderCount: number;
  // Timing
  tokenAgeMins: number;
  fetchedAt: number;
}

export interface TradeEvent {
  mint: string;
  signature: string;
  timestamp: number;
  side: 'buy' | 'sell';
  wallet: string;
  amountToken: number;
  amountSol: number;
  pricePerToken: number;
}

export interface TradeWindow {
  mint: string;
  windowMs: number;
  trades: TradeEvent[];
  buyVolumeSol: number;
  sellVolumeSol: number;
  buySellRatio: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  maxSingleWalletBuyPct: number;
  vwap: number;
  return5mPct: number;
}

export interface IndicatorSnapshot {
  mint: string;
  candleIntervalMinutes: number;
  candleCount: number;
  rsi?: number;
  connorsRsi?: number;
}

export interface FilterResult {
  passed: boolean;
  reason?: string;
}

export interface ScoreResult {
  total: number;
  components: {
    momentumStrength: number;
    buySellPressure: number;
    holderDistribution: number;
    liquidityDepth: number;
    walletConcentrationRisk: number;
  };
  passed: boolean;
}
