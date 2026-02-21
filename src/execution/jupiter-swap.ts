import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getConnection, getKeypair, createLogger } from '../utils';
import { loadStrategyConfig } from '../strategy/strategy-config';
import { FillSource, SwapQuote, SwapResult, TradeLog } from './types';
import { validateQuote, validateSimulation } from './guards';
import { sendWithJito } from './jito-bundle';
import fs from 'fs';
import path from 'path';

const log = createLogger('jupiter');

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

const tradeLogs: TradeLog[] = [];

// Cache token decimals to avoid repeated lookups
const decimalsCache = new Map<string, number>();

async function getTokenDecimals(mint: string): Promise<number> {
  if (mint === SOL_MINT) return SOL_DECIMALS;
  if (mint === USDC_MINT) return USDC_DECIMALS;
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;

  try {
    const conn = getConnection();
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const data = info.value?.data;
    if (data && 'parsed' in data) {
      const decimals = data.parsed.info.decimals as number;
      decimalsCache.set(mint, decimals);
      return decimals;
    }
  } catch (err) {
    log.warn('Failed to fetch decimals, defaulting to 9', { mint });
  }
  return 9;
}

function rawToHuman(raw: string, decimals: number): number {
  return parseInt(raw) / Math.pow(10, decimals);
}

interface ParsedTokenBalance {
  accountIndex?: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
  };
}

function rawTokenAmount(balance: ParsedTokenBalance | undefined): bigint {
  const amount = balance?.uiTokenAmount?.amount;
  if (!amount) return 0n;
  try {
    return BigInt(amount);
  } catch {
    return 0n;
  }
}

function extractWalletMintDeltas(
  preBalances: ParsedTokenBalance[],
  postBalances: ParsedTokenBalance[],
  walletAddr: string
): Map<string, bigint> {
  // accountIndex is always present in Solana parsed tx responses — use it as the key.
  const preByIdx = new Map<number, ParsedTokenBalance>();
  const postByIdx = new Map<number, ParsedTokenBalance>();

  for (const b of preBalances) {
    if (typeof b.accountIndex === 'number') preByIdx.set(b.accountIndex, b);
  }
  for (const b of postBalances) {
    if (typeof b.accountIndex === 'number') postByIdx.set(b.accountIndex, b);
  }

  const allIndices = new Set<number>([...preByIdx.keys(), ...postByIdx.keys()]);
  const deltas = new Map<string, bigint>();

  for (const idx of allIndices) {
    const pre = preByIdx.get(idx);
    const post = postByIdx.get(idx);

    const mint = post?.mint ?? pre?.mint;
    if (!mint) continue;

    // owner field is optional in some RPC responses; skip entries where it is
    // absent (cannot confirm ownership without ATA derivation).
    const owner = post?.owner ?? pre?.owner;
    if (owner === undefined || owner !== walletAddr) continue;

    const delta = rawTokenAmount(post) - rawTokenAmount(pre);
    if (delta === 0n) continue;

    deltas.set(mint, (deltas.get(mint) ?? 0n) + delta);
  }

  return deltas;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number
): Promise<SwapQuote | null> {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountRaw,
      slippageBps: slippageBps.toString(),
    });

    const res = await fetch(`${JUPITER_QUOTE_URL}?${params}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error('Jupiter quote HTTP error', { status: res.status, body: body.slice(0, 200) });
      return null;
    }
    const json = await res.json() as Record<string, unknown>;

    if (json.error) {
      log.error('Jupiter quote error', { error: json.error });
      return null;
    }

    const [inputDecimals, outputDecimals] = await Promise.all([
      getTokenDecimals(inputMint),
      getTokenDecimals(outputMint),
    ]);

    const routePlan = (json.routePlan as { swapInfo: { label: string }; percent: number }[] || [])
      .map(r => ({ label: r.swapInfo.label, percent: r.percent }));

    return {
      inputMint,
      outputMint,
      inAmount: json.inAmount as string,
      outAmount: json.outAmount as string,
      inputDecimals,
      outputDecimals,
      priceImpactPct: parseFloat(json.priceImpactPct as string || '0'),
      routePlan,
      slippageBps,
      raw: json,
    };
  } catch (err) {
    log.error('Failed to get Jupiter quote', { inputMint, outputMint, error: err });
    return null;
  }
}

export async function executeSwap(quote: SwapQuote, useJito: boolean = false, tradeType?: 'trade' | 'replenish'): Promise<SwapResult> {
  const cfg = loadStrategyConfig();
  const startTime = Date.now();
  const keypair = getKeypair();
  const conn = getConnection();
  const isBuy = quote.inputMint === USDC_MINT;
  const side: 'buy' | 'sell' = isBuy ? 'buy' : 'sell';

  const failResult = (error: string): SwapResult => ({
    success: false,
    usdcAmount: 0,
    tokenAmount: 0,
    tokenAmountRaw: '0',
    side,
    priceImpactPct: quote.priceImpactPct,
    fee: 0,
    latencyMs: Date.now() - startTime,
    fillSource: 'not_executed',
    error,
  });

  const guardResult = validateQuote(quote);
  if (!guardResult.passed) {
    return failResult(guardResult.reason || 'Guard check failed');
  }

  let lastError = '';
  const maxRetries = cfg.execution.maxRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const swapRes = await fetch(JUPITER_SWAP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote.raw,
          userPublicKey: keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });

      if (!swapRes.ok) {
        const body = await swapRes.text().catch(() => '');
        lastError = `Jupiter swap HTTP ${swapRes.status}: ${body.slice(0, 200)}`;
        log.warn('Jupiter swap HTTP error', { attempt, status: swapRes.status, body: body.slice(0, 200) });
        // Back off on rate limits before retrying
        if (swapRes.status === 429 || body.toLowerCase().includes('rate limit')) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
        continue;
      }

      const swapData = await swapRes.json() as {
        swapTransaction?: string;
        error?: string;
      };

      if (swapData.error || !swapData.swapTransaction) {
        lastError = swapData.error || 'No swap transaction returned';
        log.warn('Jupiter swap API error', { attempt, error: lastError });
        continue;
      }

      const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);

      if (cfg.execution.simulateBeforeSubmit) {
        const simResult = await conn.simulateTransaction(tx, {
          sigVerify: false,
          commitment: 'confirmed',
        });
        const simCheck = validateSimulation(simResult.value);
        if (!simCheck.passed) {
          lastError = simCheck.reason || 'Simulation failed';
          log.warn('Tx simulation failed', { attempt, error: lastError });
          continue;
        }
      }

      tx.sign([keypair]);

      // Send via Jito or standard RPC
      let signature: string;
      if (useJito) {
        const bundleId = await sendWithJito(tx);
        if (!bundleId) {
          log.warn('Jito failed, falling back to standard send', { attempt });
        }
        // Always send via RPC as well — Jito is best-effort acceleration
        signature = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 2,
        });
      } else {
        signature = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 2,
        });
      }

      const confirmation = await conn.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        lastError = `Tx confirmed with error: ${JSON.stringify(confirmation.value.err)}`;
        log.warn('Tx error on chain', { attempt, signature, error: lastError });
        continue;
      }

      // --- Actual fill from on-chain balance deltas ---
      const tokenMint = isBuy ? quote.outputMint : quote.inputMint;
      let actualUsdcAmount = rawToHuman(isBuy ? quote.inAmount : quote.outAmount, USDC_DECIMALS);
      let actualTokenAmount = rawToHuman(isBuy ? quote.outAmount : quote.inAmount, isBuy ? quote.outputDecimals : quote.inputDecimals);
      let actualTokenRaw = isBuy ? quote.outAmount : quote.inAmount;
      let actualFee = 0;
      let fillSource: FillSource = 'quote_fallback';

      try {
        // Retry loop: getParsedTransaction returns null immediately after confirmation
        // because Helius's parsed-tx index lags 1–4 s behind raw confirmation.
        let parsedTx = null;
        for (let r = 0; r < 5; r++) {
          if (r > 0) await new Promise(res => setTimeout(res, 1200));
          parsedTx = await conn.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (parsedTx?.meta) break;
        }

        if (parsedTx?.meta) {
          // Use explicit wallet pubkey lookup — unambiguous regardless of signer ordering.
          const walletAddr = keypair.publicKey.toBase58();
          const walletIdx = parsedTx.transaction.message.accountKeys.findIndex(
            k => k.pubkey.toBase58() === walletAddr
          );
          if (walletIdx >= 0) {
            actualFee = parsedTx.meta.fee / 1e9;
          }

          const pre = (parsedTx.meta.preTokenBalances || []) as ParsedTokenBalance[];
          const post = (parsedTx.meta.postTokenBalances || []) as ParsedTokenBalance[];
          const mintDeltas = extractWalletMintDeltas(pre, post, walletAddr);

          const usdcDeltaRaw = mintDeltas.get(USDC_MINT);
          if (usdcDeltaRaw !== undefined && usdcDeltaRaw !== 0n) {
            const usdcAbsRaw = usdcDeltaRaw < 0n ? -usdcDeltaRaw : usdcDeltaRaw;
            actualUsdcAmount = Number(usdcAbsRaw) / Math.pow(10, USDC_DECIMALS);
          }

          const tokenDeltaRaw = mintDeltas.get(tokenMint);
          if (tokenDeltaRaw !== undefined && tokenDeltaRaw !== 0n) {
            const tokenAbsRaw = tokenDeltaRaw < 0n ? -tokenDeltaRaw : tokenDeltaRaw;
            actualTokenRaw = tokenAbsRaw.toString();
            actualTokenAmount = rawToHuman(
              actualTokenRaw,
              isBuy ? quote.outputDecimals : quote.inputDecimals,
            );
          }

          // Native SOL changes appear in lamport balance arrays, not token balance arrays.
          // Note: meta.fee is only the base fee; priority fees and Jito tips are also
          // deducted from wallet lamports but not reflected in meta.fee — small known bias.
          let solFillDetected = false;
          if (tokenMint === SOL_MINT && walletIdx >= 0 &&
              parsedTx.meta.preBalances && parsedTx.meta.postBalances) {
            const preLamports = parsedTx.meta.preBalances[walletIdx];
            const postLamports = parsedTx.meta.postBalances[walletIdx];
            const txFeeLamports = parsedTx.meta.fee;
            if (preLamports !== undefined && postLamports !== undefined) {
              const lamportDelta = postLamports - preLamports;
              // Buy (USDC→SOL): postLamports = preLamports + solReceived - txFee
              //   → solReceived = lamportDelta + txFee
              // Sell (SOL→USDC): postLamports = preLamports - solSent - txFee
              //   → solSent = -lamportDelta - txFee
              const solAmountLamports = isBuy
                ? lamportDelta + txFeeLamports
                : -lamportDelta - txFeeLamports;
              if (solAmountLamports > 0) {
                actualTokenRaw = solAmountLamports.toString();
                actualTokenAmount = solAmountLamports / 1e9;
                solFillDetected = true;
              }
            }
          }

          if (
            usdcDeltaRaw !== undefined &&
            usdcDeltaRaw !== 0n &&
            (tokenDeltaRaw !== undefined && tokenDeltaRaw !== 0n || solFillDetected)
          ) {
            fillSource = 'onchain';
          }
        }
      } catch (err) {
        log.warn('Could not verify fill on-chain, using quote amounts', { signature });
      }

      const latencyMs = Date.now() - startTime;

      const result: SwapResult = {
        success: true,
        signature,
        usdcAmount: actualUsdcAmount,
        tokenAmount: actualTokenAmount,
        tokenAmountRaw: actualTokenRaw,
        side,
        priceImpactPct: quote.priceImpactPct,
        fee: actualFee,
        latencyMs,
        fillSource,
      };

      if (fillSource !== 'onchain') {
        log.warn('Swap fill parsed via quote fallback; slippage cost may be unavailable', {
          side,
          signature,
        });
      }

      logTrade(quote, result, tradeType);

      log.info('Swap executed', {
        side,
        signature,
        usdcAmount: result.usdcAmount.toFixed(2),
        tokenAmount: result.tokenAmount,
        impact: quote.priceImpactPct.toFixed(2),
        fee: actualFee.toFixed(6),
        latencyMs,
      });

      return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.error('Swap attempt failed', { attempt, error: lastError });
    }
  }

  const result = failResult(`Failed after ${maxRetries + 1} attempts: ${lastError}`);
  logTrade(quote, result);
  return result;
}

// Buy a token with USDC
export async function buyToken(
  mint: string,
  usdcAmount: number,
  slippageBps: number,
  useJito: boolean = false
): Promise<SwapResult> {
  const rawUsdc = Math.floor(usdcAmount * 1e6).toString();
  const quote = await getQuote(USDC_MINT, mint, rawUsdc, slippageBps);
  if (!quote) {
    return {
      success: false,
      usdcAmount,
      tokenAmount: 0,
      tokenAmountRaw: '0',
      side: 'buy',
      priceImpactPct: 0,
      fee: 0,
      latencyMs: 0,
      fillSource: 'not_executed',
      error: 'Failed to get quote',
    };
  }
  return executeSwap(quote, useJito);
}

// Sell tokens for USDC — takes raw token amount (smallest unit)
export async function sellToken(
  mint: string,
  tokenAmountRaw: string,
  slippageBps: number,
  useJito: boolean = false
): Promise<SwapResult> {
  const quote = await getQuote(mint, USDC_MINT, tokenAmountRaw, slippageBps);
  if (!quote) {
    return {
      success: false,
      usdcAmount: 0,
      tokenAmount: 0,
      tokenAmountRaw: '0',
      side: 'sell',
      priceImpactPct: 0,
      fee: 0,
      latencyMs: 0,
      fillSource: 'not_executed',
      error: 'Failed to get quote',
    };
  }
  return executeSwap(quote, useJito);
}

// Get a quote estimate without executing (for paper trading & impact checks)
export async function getQuoteEstimate(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number
): Promise<SwapQuote | null> {
  return getQuote(inputMint, outputMint, amountRaw, slippageBps);
}

function logTrade(quote: SwapQuote, result: SwapResult, tradeType?: 'trade' | 'replenish') {
  const isBuy = quote.inputMint === USDC_MINT;
  const tokenMint = isBuy ? quote.outputMint : quote.inputMint;
  const inHuman = rawToHuman(quote.inAmount, quote.inputDecimals);
  const outHuman = rawToHuman(quote.outAmount, quote.outputDecimals);
  const fillSource: FillSource = result.fillSource || (result.success ? 'quote_fallback' : 'not_executed');

  const quotePrice = isBuy ? inHuman / outHuman : outHuman / inHuman;
  const hasMeasuredFill = (
    result.success &&
    fillSource === 'onchain' &&
    result.tokenAmount > 0 &&
    result.usdcAmount > 0
  );

  // Compute actual execution price from filled amounts when available.
  let actualPrice = quotePrice;
  if (hasMeasuredFill) {
    actualPrice = result.usdcAmount / result.tokenAmount;
  }

  // Legacy metric: positive = better than quote, negative = worse than quote.
  const slippagePctLegacy = hasMeasuredFill
    ? (
      isBuy
        ? ((quotePrice - actualPrice) / quotePrice) * 100
        : ((actualPrice - quotePrice) / quotePrice) * 100
    )
    : 0;

  // Standard metric: positive = worse than quote, negative = better than quote.
  let slippagePctWorse: number | null = null;
  let slippageCostUsdc: number | null = null;
  if (hasMeasuredFill) {
    slippagePctWorse = isBuy
      ? ((actualPrice - quotePrice) / quotePrice) * 100
      : ((quotePrice - actualPrice) / quotePrice) * 100;

    const expectedUsdcAtQuote = result.tokenAmount * quotePrice;
    slippageCostUsdc = isBuy
      ? (result.usdcAmount - expectedUsdcAtQuote)
      : (expectedUsdcAtQuote - result.usdcAmount);
  }

  const entry: TradeLog = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mint: tokenMint,
    side: result.side,
    timestamp: Date.now(),
    quotePrice,
    actualPrice,
    actualSlippagePct: slippagePctLegacy,
    actualSlippagePctWorse: slippagePctWorse,
    actualSlippageCostUsdc: slippageCostUsdc,
    expectedSlippage: quote.slippageBps / 100,
    actualFill: result.tokenAmount,
    usdcAmount: result.usdcAmount,
    fillSource,
    txLatencyMs: result.latencyMs,
    fees: result.fee,
    signature: result.signature || '',
    success: result.success,
    tradeType,
    error: result.error,
  };
  tradeLogs.push(entry);
  persistTradeLog(entry);
}

function persistTradeLog(entry: TradeLog) {
  try {
    const dir = path.resolve(__dirname, '../../data/data/trades');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    log.warn('Failed to persist trade log to disk');
  }
}

export function getTradeLogs(): TradeLog[] {
  return tradeLogs;
}
