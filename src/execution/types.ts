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
  error?: string;
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
  actualSlippagePct: number; // (actualPrice - quotePrice) / quotePrice * 100 (negative = worse fill)
  expectedSlippage: number;
  actualFill: number;
  usdcAmount: number;       // actual USDC spent/received
  txLatencyMs: number;
  fees: number;
  signature: string;
  success: boolean;
  error?: string;
}
