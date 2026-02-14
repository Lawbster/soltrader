import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getConnection, getKeypair, createLogger } from '../utils';
import { loadStrategyConfig } from '../strategy/strategy-config';
import { SwapQuote, SwapResult, TradeLog } from './types';
import { validateQuote, validateSimulation } from './guards';
import { sendWithJito } from './jito-bundle';

const log = createLogger('jupiter');

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

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

export async function executeSwap(quote: SwapQuote, useJito: boolean = false): Promise<SwapResult> {
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

      try {
        const parsedTx = await conn.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        if (parsedTx?.meta) {
          // SOL fee from lamport balance changes
          const signerIdx = parsedTx.transaction.message.accountKeys.findIndex(k => k.signer);
          if (signerIdx >= 0) {
            actualFee = parsedTx.meta.fee / 1e9;
          }

          const walletAddr = keypair.publicKey.toBase58();
          const pre = parsedTx.meta.preTokenBalances || [];
          const post = parsedTx.meta.postTokenBalances || [];

          // USDC delta from SPL token balance changes
          for (const postBal of post) {
            if (postBal.mint === USDC_MINT && postBal.owner === walletAddr) {
              const preBal = pre.find(p => p.mint === USDC_MINT && p.owner === walletAddr);
              const preAmt = preBal?.uiTokenAmount.uiAmount || 0;
              const postAmt = postBal.uiTokenAmount.uiAmount || 0;
              const delta = Math.abs(postAmt - preAmt);
              if (delta > 0) actualUsdcAmount = delta;
              break;
            }
          }

          // Token delta from SPL token balance changes
          for (const postBal of post) {
            if (postBal.mint === tokenMint && postBal.owner === walletAddr) {
              const preBal = pre.find(p => p.mint === tokenMint && p.owner === walletAddr);
              const preAmt = preBal?.uiTokenAmount.uiAmount || 0;
              const postAmt = postBal.uiTokenAmount.uiAmount || 0;
              const delta = Math.abs(postAmt - preAmt);
              if (delta > 0) {
                actualTokenAmount = delta;
                const rawPre = BigInt(preBal?.uiTokenAmount.amount || '0');
                const rawPost = BigInt(postBal.uiTokenAmount.amount);
                const rawDelta = rawPost > rawPre ? rawPost - rawPre : rawPre - rawPost;
                actualTokenRaw = rawDelta.toString();
              }
              break;
            }
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
      };

      logTrade(quote, result);

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

function logTrade(quote: SwapQuote, result: SwapResult) {
  const isBuy = quote.inputMint === USDC_MINT;
  const tokenMint = isBuy ? quote.outputMint : quote.inputMint;
  const inHuman = rawToHuman(quote.inAmount, quote.inputDecimals);
  const outHuman = rawToHuman(quote.outAmount, quote.outputDecimals);

  const entry: TradeLog = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mint: tokenMint,
    side: result.side,
    timestamp: Date.now(),
    quotePrice: isBuy ? inHuman / outHuman : outHuman / inHuman,
    expectedSlippage: quote.slippageBps / 100,
    actualFill: result.tokenAmount,
    txLatencyMs: result.latencyMs,
    fees: result.fee,
    signature: result.signature || '',
    success: result.success,
    error: result.error,
  };
  tradeLogs.push(entry);
}

export function getTradeLogs(): TradeLog[] {
  return tradeLogs;
}
