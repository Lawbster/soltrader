export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;  // Raw smallest units (lamports / raw token units)
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
  solAmount: number;    // SOL side, always human-readable
  tokenAmount: number;  // Token side, always human-readable (decimal-adjusted)
  tokenAmountRaw: string; // Raw token units for sell calls
  side: 'buy' | 'sell';
  priceImpactPct: number;
  fee: number;
  latencyMs: number;
  error?: string;
}

export interface Position {
  id: string;
  mint: string;
  entrySignature: string;
  entryPrice: number; // price per token in SOL
  entryTime: number;
  initialSizeSol: number;
  initialTokens: number;
  // Current state
  remainingSol: number; // notional value remaining
  remainingTokens: number;
  remainingPct: number; // % of initial position still held
  currentPrice: number;
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
  solReceived: number;
  price: number;
  signature?: string;
  timestamp: number;
}

export interface TradeLog {
  id: string;
  mint: string;
  side: 'buy' | 'sell';
  timestamp: number;
  quotePrice: number;
  expectedSlippage: number;
  actualFill: number;
  txLatencyMs: number;
  fees: number;
  signature: string;
  success: boolean;
  error?: string;
}
