export interface PricePoint {
  ts: number;
  mint: string;
  priceUsd: number;
  priceSol: number;
  source: string;
  pollLatencyMs: number;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  pricePoints: number;
  /** Real USD trade volume from Birdeye. Absent on older candles. */
  volume?: number;
}

export interface TokenDataset {
  mint: string;
  label: string;
  candles: Candle[];
  prices: PricePoint[];
}

export interface IndicatorValues {
  rsi?: number;          // RSI(14)
  rsiShort?: number;     // RSI(2) — fast scalping RSI
  connorsRsi?: number;   // CRSI(3,2,100)
  sma?: Record<number, number>;
  ema?: Record<number, number>;
  macd?: { macd: number; signal: number; histogram: number };
  bollingerBands?: { upper: number; middle: number; lower: number; width: number };
  atr?: number;
  adx?: number;          // ADX(14) — trend strength
  vwapProxy?: number;
  obvProxy?: number;
  volumeZScore?: number; // rolling 20-bar z-score of candle pricePoints (volume proxy)
  atrPctRank?: number;   // rolling 50-bar percentile rank of ATR(14), 0-100
}

export type BacktestTrendRegime = 'uptrend' | 'sideways' | 'downtrend';

export type Signal = 'buy' | 'sell' | 'hold';

export interface BacktestProtectionConfig {
  profitLockArmPct?: number;
  profitLockPct?: number;
  trailArmPct?: number;
  trailGapPct?: number;
  staleMaxHoldMinutes?: number;
  staleMinPnlPct?: number;
}

export interface StrategyContext {
  candle: Candle;
  index: number;
  indicators: IndicatorValues;
  prevIndicators?: IndicatorValues;
  positions: BacktestPosition[]; // all currently open positions (0..maxPositions)
  history: Candle[];
  hour: number; // UTC hour 0-23
}

export interface BacktestStrategy {
  name: string;
  description: string;
  requiredHistory: number;
  stopLossPct?: number;   // static pct stop below entry
  takeProfitPct?: number; // static pct target above entry
  stopLossAtrMult?: number;   // ATR multiple below entry price
  takeProfitAtrMult?: number; // ATR multiple above entry price
  protection?: BacktestProtectionConfig;
  evaluate(ctx: StrategyContext): Signal;
}

export interface BacktestPosition {
  entryIndex: number;
  entryPrice: number;
  entryTime: number;
  peakPrice: number;
  peakPnlPct: number;
  entryAtr?: number;
}

export interface BacktestTrade {
  mint: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  holdBars: number;
  holdTimeMinutes: number;
  exitReason: string;
  entryRegime?: BacktestTrendRegime;
}

export interface CostConfig {
  model: 'fixed' | 'empirical';
  roundTripPct: number;
  sampleSize?: number; // empirical only: number of executions used
}

export interface BacktestConfig {
  mint: string;
  label: string;
  strategy: BacktestStrategy;
  commissionPct?: number;     // legacy fallback
  slippagePct?: number;       // legacy fallback
  roundTripCostPct?: number;  // overrides commissionPct+slippagePct when set
  maxPositions?: number;      // max concurrent positions per token (default 1)
  exitParityMode?: 'indicator' | 'price'; // 'price' suppresses indicator sell signals so only SL/TP closes positions
  executionCandles?: Candle[];
  signalTimeframeMinutes?: number;
  executionTimeframeMinutes?: number;
  indicatorConfig?: {
    rsiPeriod?: number;
    connorsRsiPeriod?: number;
    connorsStreakRsiPeriod?: number;
    connorsPercentRankPeriod?: number;
  };
  signalRegimes?: BacktestTrendRegime[];
  entryRegimeFilter?: BacktestTrendRegime;
}

export interface BacktestResult {
  strategyName: string;
  mint: string;
  label: string;
  trades: BacktestTrade[];
  totalCandles: number;
  dateRange: { start: number; end: number };
  signalTimeframeMinutes: number;
  executionTimeframeMinutes: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  avgWinLossRatio: number;
  profitFactor: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgHoldBars: number;
  avgHoldMinutes: number;
  tradesPerDay: number;
}

