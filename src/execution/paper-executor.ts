import { PublicKey } from '@solana/web3.js';
import { getConnection, createLogger } from '../utils';
import { loadStrategyConfig } from '../strategy/strategy-config';
import { SwapResult } from './types';

const log = createLogger('paper');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Cache token decimals
const decimalsCache = new Map<string, number>();

async function getTokenDecimals(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;

  try {
    const conn = getConnection();
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const data = info.value?.data;
    if (data && 'parsed' in data) {
      const d = data.parsed.info.decimals as number;
      decimalsCache.set(mint, d);
      return d;
    }
  } catch { /* default */ }
  return 9;
}

// Get real Jupiter quote for price discovery (no execution)
async function getQuoteEstimate(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number
): Promise<{ outAmount: string; priceImpactPct: number } | null> {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountRaw,
      slippageBps: slippageBps.toString(),
    });
    const res = await fetch(`https://quote-api.jup.ag/v6/quote?${params}`);
    const json = await res.json() as Record<string, unknown>;
    if (json.error || !json.outAmount) return null;
    return {
      outAmount: json.outAmount as string,
      priceImpactPct: parseFloat(json.priceImpactPct as string || '0'),
    };
  } catch {
    return null;
  }
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Simulate buy — uses real Jupiter quotes with realistic degradation
export async function paperBuyToken(
  mint: string,
  solAmount: number,
  slippageBps: number
): Promise<SwapResult> {
  const cfg = loadStrategyConfig();
  const paperCfg = cfg.paperTrading;
  const startTime = Date.now();

  const failResult = (error: string): SwapResult => ({
    success: false,
    solAmount,
    tokenAmount: 0,
    tokenAmountRaw: '0',
    side: 'buy',
    priceImpactPct: 0,
    fee: 0,
    latencyMs: Date.now() - startTime,
    error,
  });

  // Simulate latency
  const latency = randomInRange(paperCfg.latencyRangeMs[0], paperCfg.latencyRangeMs[1]);
  await new Promise(r => setTimeout(r, latency));

  // Simulate random tx failure
  if (Math.random() < paperCfg.txFailureProbability) {
    log.info('PAPER: simulated tx failure (buy)', { mint });
    return failResult('Simulated transaction failure');
  }

  // Get real quote for price discovery
  const lamports = Math.floor(solAmount * 1e9).toString();
  const quote = await getQuoteEstimate(SOL_MINT, mint, lamports, slippageBps);
  if (!quote) {
    return failResult('Failed to get quote for paper trade');
  }

  const decimals = await getTokenDecimals(mint);
  let tokenAmountRaw = BigInt(quote.outAmount);

  // Apply simulated slippage on top of quote (real market would slip more)
  if (paperCfg.slippageSimulation) {
    const slipFactor = 1 - randomInRange(0.001, 0.01); // 0.1-1% additional slippage
    tokenAmountRaw = BigInt(Math.floor(Number(tokenAmountRaw) * slipFactor));
  }

  const tokenAmount = Number(tokenAmountRaw) / Math.pow(10, decimals);

  // Simulated priority fee deduction
  let fee = 0;
  if (paperCfg.priorityFeeSimulation) {
    fee = randomInRange(0.000005, 0.0001); // 5000-100000 lamports
  }

  const actualSol = solAmount + fee; // Total cost including fee

  const result: SwapResult = {
    success: true,
    signature: `paper-buy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    solAmount: actualSol,
    tokenAmount,
    tokenAmountRaw: tokenAmountRaw.toString(),
    side: 'buy',
    priceImpactPct: quote.priceImpactPct,
    fee,
    latencyMs: Date.now() - startTime,
  };

  log.info('PAPER BUY', {
    mint,
    solSpent: actualSol.toFixed(4),
    tokensReceived: tokenAmount,
    impact: quote.priceImpactPct.toFixed(2),
    simulatedLatency: Math.round(latency),
    fee: fee.toFixed(6),
  });

  return result;
}

// Simulate sell — uses real Jupiter quotes with realistic degradation
export async function paperSellToken(
  mint: string,
  tokenAmountRaw: string,
  slippageBps: number
): Promise<SwapResult> {
  const cfg = loadStrategyConfig();
  const paperCfg = cfg.paperTrading;
  const startTime = Date.now();

  const decimals = await getTokenDecimals(mint);
  const tokenAmount = parseInt(tokenAmountRaw) / Math.pow(10, decimals);

  const failResult = (error: string): SwapResult => ({
    success: false,
    solAmount: 0,
    tokenAmount,
    tokenAmountRaw,
    side: 'sell',
    priceImpactPct: 0,
    fee: 0,
    latencyMs: Date.now() - startTime,
    error,
  });

  // Simulate latency
  const latency = randomInRange(paperCfg.latencyRangeMs[0], paperCfg.latencyRangeMs[1]);
  await new Promise(r => setTimeout(r, latency));

  // Simulate random tx failure
  if (Math.random() < paperCfg.txFailureProbability) {
    log.info('PAPER: simulated tx failure (sell)', { mint });
    return failResult('Simulated transaction failure');
  }

  // Get real quote for price discovery
  const quote = await getQuoteEstimate(mint, SOL_MINT, tokenAmountRaw, slippageBps);
  if (!quote) {
    return failResult('Failed to get quote for paper trade');
  }

  let solOutLamports = BigInt(quote.outAmount);

  // Apply simulated slippage
  if (paperCfg.slippageSimulation) {
    const slipFactor = 1 - randomInRange(0.001, 0.01);
    solOutLamports = BigInt(Math.floor(Number(solOutLamports) * slipFactor));
  }

  let solAmount = Number(solOutLamports) / 1e9;

  // Simulated priority fee deduction
  let fee = 0;
  if (paperCfg.priorityFeeSimulation) {
    fee = randomInRange(0.000005, 0.0001);
    solAmount -= fee;
  }

  const result: SwapResult = {
    success: true,
    signature: `paper-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    solAmount,
    tokenAmount,
    tokenAmountRaw,
    side: 'sell',
    priceImpactPct: quote.priceImpactPct,
    fee,
    latencyMs: Date.now() - startTime,
  };

  log.info('PAPER SELL', {
    mint,
    solReceived: solAmount.toFixed(4),
    tokensSold: tokenAmount,
    impact: quote.priceImpactPct.toFixed(2),
    simulatedLatency: Math.round(latency),
    fee: fee.toFixed(6),
  });

  return result;
}
