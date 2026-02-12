export interface TokenLaunch {
  mint: string;
  source: 'pumpfun' | 'raydium' | 'watchlist';
  signature: string;
  detectedAt: number; // unix ms
  poolAddress?: string;
  creatorWallet?: string;
}

export interface TokenSnapshot {
  mint: string;
  timestamp: number;
  priceUsd?: number;
  priceSol?: number;
  marketCapUsd?: number;
  volume24h?: number;
  holders?: number;
  liquidityUsd?: number;
  topHolderPct?: number; // % held by top wallet (excluding LP)
}

export type TokenEventHandler = (launch: TokenLaunch) => void;
