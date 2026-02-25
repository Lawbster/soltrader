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
}

export type Signal = 'buy' | 'sell' | 'hold';

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
  stopLossPct?: number;   // e.g. -0.45 → exit at -0.45% from entry
  takeProfitPct?: number; // e.g. 0.59 → exit at +0.59% from entry
  evaluate(ctx: StrategyContext): Signal;
}

export interface BacktestPosition {
  entryIndex: number;
  entryPrice: number;
  entryTime: number;
  peakPrice: number;
  peakPnlPct: number;
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
}

export interface BacktestResult {
  strategyName: string;
  mint: string;
  label: string;
  trades: BacktestTrade[];
  totalCandles: number;
  dateRange: { start: number; end: number };
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
