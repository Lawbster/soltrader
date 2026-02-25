import type { TemplateId } from '../strategy/templates/types';
import type { ExitMode } from '../strategy/live-strategy-map';

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;  // Raw smallest units (USDC 1e6 / raw token units)
  outAmount: string; // Raw smallest units
  inputDecimals: number;
  outputDecimals: number;
  priceImpactPct: number;
  routePlan: { label: string; percent: number }[];
  slippageBps: number;
  raw: unknown; // Full Jupiter quote response for swap execution
}

export interface SwapResult {
  success: boolean;
  signature?: string;
  usdcAmount: number;   // USDC side, always human-readable
  tokenAmount: number;  // Token side, always human-readable (decimal-adjusted)
  tokenAmountRaw: string; // Raw token units for sell calls
  side: 'buy' | 'sell';
  priceImpactPct: number;
  fee: number; // tx fee in SOL (Solana network fee)
  latencyMs: number;
  fillSource?: FillSource;
  error?: string;
}

export interface StrategyPlan {
  kind: 'rsi' | 'crsi';
  entry: number;  // oversold threshold used at entry (0 for non-RSI/CRSI templates)
  exit: number;   // overbought threshold (100 for non-RSI/CRSI templates)
  sl: number;     // stop loss pct (negative, e.g. -5)
  tp: number;     // take profit pct (positive, e.g. 1)
  templateId?: TemplateId;                 // always set for template-routed tokens
  templateParams?: Record<string, number>; // template-specific params
  exitMode?: ExitMode;                     // 'price' (default) | 'indicator'
}

export interface Position {
  id: string;
  mint: string;
  entrySignature: string;
  entryPrice: number; // price per token in USDC
  entryTime: number;
  initialSizeUsdc: number;
  initialTokens: number;
  // Current state
  remainingUsdc: number; // notional value remaining
  remainingTokens: number;
  remainingPct: number; // % of initial position still held
  currentPrice: number; // price per token in USDC
  currentPnlPct: number;
  peakPnlPct: number;
  // Exit tracking
  tp1Hit: boolean;
  tp2Hit: boolean;
  stopMovedToBreakeven: boolean;
  // Metadata
  exits: PositionExit[];
  status: 'open' | 'closed';
  closeReason?: string;
  strategyPlan?: StrategyPlan;
  lastTemplateExitEvalMs?: number; // tracks candle boundary for indicator-mode exits
}

export interface PositionExit {
  type: string;
  sellPct: number;
  tokensSold: number;
  usdcReceived: number;
  price: number; // USDC per token at exit
  signature?: string;
  timestamp: number;
}

export interface TradeLog {
  id: string;
  mint: string;
  side: 'buy' | 'sell';
  timestamp: number;
  quotePrice: number;       // USDC per token from quote
  actualPrice: number;      // USDC per token from on-chain fill
  // Legacy sign convention: positive = better than quote, negative = worse.
  actualSlippagePct: number;
  // Standard sign convention: positive = worse than quote, negative = better.
  actualSlippagePctWorse: number | null;
  // Positive = extra USDC cost vs quote, negative = price improvement savings.
  actualSlippageCostUsdc: number | null;
  expectedSlippage: number;
  actualFill: number;
  usdcAmount: number;       // actual USDC spent/received
  fillSource: FillSource;
  txLatencyMs: number;
  fees: number;
  signature: string;
  success: boolean;
  tradeType?: 'trade' | 'replenish';
  error?: string;
}

export type FillSource = 'onchain' | 'quote_fallback' | 'not_executed';
