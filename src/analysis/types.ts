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
  // Extended live indicators (PR2) ─────────────────────────────────────
  rsiShort?: number;                                              // RSI(2)
  sma?: Record<number, number>;                                   // keyed by period [10,20,50]
  ema?: Record<number, number>;                                   // keyed by period [9,12,26]
  bollingerBands?: { upper: number; middle: number; lower: number; width: number };
  macd?: { macd: number; signal: number; histogram: number };
  obvProxy?: number;
  vwapProxy?: number;    // from dual-source OHLC (trades preferred, price-feed fallback)
  adx?: number;          // from dual-source OHLC H/L; undefined when insufficient coverage
  atr?: number;          // from dual-source OHLC H/L; undefined when insufficient coverage
  adxSource?: 'trades' | 'price-feed' | 'unavailable';          // logged for monitoring
  /** T-1 bar indicator values — needed by templates that evaluate prevIndicators */
  prevIndicators?: {
    rsi?: number;
    rsiShort?: number;
    connorsRsi?: number;
    sma?: Record<number, number>;
    ema?: Record<number, number>;
    macd?: { macd: number; signal: number; histogram: number };
    bollingerBands?: { upper: number; middle: number; lower: number; width: number };
    atr?: number;
    adx?: number;
    vwapProxy?: number;
    obvProxy?: number;
  };
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
