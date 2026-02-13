import { PublicKey, Logs } from '@solana/web3.js';
import { getConnection, createLogger } from '../utils';
import { TradeEvent, TradeWindow } from './types';

const log = createLogger('trade-tracker');

// Rolling trade history per token
const tradeHistory = new Map<string, TradeEvent[]>();
// Track subscription IDs per token
const subscriptions = new Map<string, number>();
const swapLogCounts = new Map<string, number>();
const enrichMissCounts = new Map<string, number>();
// Dedup: signatures we've already enriched — two-generation bounded set
let currentSigs = new Set<string>();
let previousSigs = new Set<string>();
const MAX_SIGS_PER_GENERATION = 2500;

const MAX_TRADE_AGE_MS = 120 * 60_000; // Keep 2 hours of trades

// Concurrency gate for trade enrichment — limits parallel getParsedTransaction calls
let activeEnrichments = 0;
const MAX_CONCURRENT_ENRICHMENTS = 3;
const enrichmentQueue: (() => void)[] = [];

function acquireEnrichmentSlot(): Promise<void> {
  if (activeEnrichments < MAX_CONCURRENT_ENRICHMENTS) {
    activeEnrichments++;
    return Promise.resolve();
  }
  return new Promise(resolve => enrichmentQueue.push(resolve));
}

function releaseEnrichmentSlot() {
  const next = enrichmentQueue.shift();
  if (next) {
    next(); // hand the slot to the next waiter
  } else {
    activeEnrichments--;
  }
}

export function recordTrade(trade: TradeEvent) {
  let trades = tradeHistory.get(trade.mint);
  if (!trades) {
    trades = [];
    tradeHistory.set(trade.mint, trades);
  }
  trades.push(trade);

  // Prune old trades
  const cutoff = Date.now() - MAX_TRADE_AGE_MS;
  const pruneIdx = trades.findIndex(t => t.timestamp >= cutoff);
  if (pruneIdx > 0) {
    trades.splice(0, pruneIdx);
  }
}

export function getTradeWindow(mint: string, windowMs: number): TradeWindow {
  const trades = tradeHistory.get(mint) || [];
  const cutoff = Date.now() - windowMs;
  const windowTrades = trades.filter(t => t.timestamp >= cutoff);

  const buys = windowTrades.filter(t => t.side === 'buy');
  const sells = windowTrades.filter(t => t.side === 'sell');

  const buyVolumeSol = buys.reduce((sum, t) => sum + t.amountSol, 0);
  const sellVolumeSol = sells.reduce((sum, t) => sum + t.amountSol, 0);
  const buySellRatio = sellVolumeSol > 0 ? buyVolumeSol / sellVolumeSol : buyVolumeSol > 0 ? 999 : 0;

  // Only count wallets that are non-empty (enriched trades)
  const uniqueBuyers = new Set(buys.map(t => t.wallet).filter(w => w !== '')).size;
  const uniqueSellers = new Set(sells.map(t => t.wallet).filter(w => w !== '')).size;

  // Max single wallet buy contribution (only from enriched trades)
  const buyByWallet = new Map<string, number>();
  for (const buy of buys) {
    if (buy.wallet === '') continue;
    buyByWallet.set(buy.wallet, (buyByWallet.get(buy.wallet) || 0) + buy.amountSol);
  }
  const maxWalletBuy = buyByWallet.size > 0 ? Math.max(...Array.from(buyByWallet.values())) : 0;
  const maxSingleWalletBuyPct = buyVolumeSol > 0 ? (maxWalletBuy / buyVolumeSol) * 100 : 0;

  // VWAP — only from trades with valid price
  const pricedTrades = windowTrades.filter(t => t.pricePerToken > 0 && t.amountSol > 0);
  const totalPricedVolume = pricedTrades.reduce((sum, t) => sum + t.amountSol, 0);
  const vwap = totalPricedVolume > 0
    ? pricedTrades.reduce((sum, t) => sum + t.pricePerToken * t.amountSol, 0) / totalPricedVolume
    : 0;

  // 5-minute return from priced trades
  let return5mPct = 0;
  if (pricedTrades.length >= 2) {
    const firstPrice = pricedTrades[0].pricePerToken;
    const lastPrice = pricedTrades[pricedTrades.length - 1].pricePerToken;
    if (firstPrice > 0) {
      return5mPct = ((lastPrice - firstPrice) / firstPrice) * 100;
    }
  }

  return {
    mint,
    windowMs,
    trades: windowTrades,
    buyVolumeSol,
    sellVolumeSol,
    buySellRatio,
    uniqueBuyers,
    uniqueSellers,
    maxSingleWalletBuyPct,
    vwap,
    return5mPct,
  };
}

export function getTradesForMint(mint: string): TradeEvent[] {
  return tradeHistory.get(mint) || [];
}

export async function subscribeToTokenTrades(mint: string, addressOverride?: string) {
  if (subscriptions.has(mint)) return;

  const conn = getConnection();
  const mintPubkey = new PublicKey(addressOverride || mint);

  const subId = conn.onLogs(
    mintPubkey,
    (logInfo: Logs) => handleSwapLog(mint, logInfo),
    'confirmed'
  );

  subscriptions.set(mint, subId);
  log.info('Subscribed to trades', { mint, address: mintPubkey.toBase58() });
}

export async function unsubscribeFromToken(mint: string) {
  const subId = subscriptions.get(mint);
  if (subId === undefined) return;

  const conn = getConnection();
  await conn.removeOnLogsListener(subId);
  subscriptions.delete(mint);
  tradeHistory.delete(mint);
  log.debug('Unsubscribed from trades', { mint });
}

function hasProcessedSig(sig: string): boolean {
  return currentSigs.has(sig) || previousSigs.has(sig);
}

function markSigProcessed(sig: string) {
  currentSigs.add(sig);
  // Rotate generations when current fills up
  if (currentSigs.size >= MAX_SIGS_PER_GENERATION) {
    previousSigs = currentSigs;
    currentSigs = new Set<string>();
  }
}

function handleSwapLog(mint: string, logInfo: Logs) {
  if (logInfo.err) return;
  if (hasProcessedSig(logInfo.signature)) return;

  const logs = logInfo.logs;

  // Detect swap patterns
  const isSwap = logs.some(l =>
    l.includes('Instruction: Swap') ||
    l.includes('Instruction: Route') ||
    l.includes('ray_log')
  );

  if (!isSwap) return;

  const count = (swapLogCounts.get(mint) || 0) + 1;
  swapLogCounts.set(mint, count);
  if (count === 1) {
    log.info('Swap log detected', { mint, sig: logInfo.signature });
  }

  markSigProcessed(logInfo.signature);

  // Fire-and-forget enrichment
  enrichAndRecord(mint, logInfo.signature).catch(err => {
    log.debug('Trade enrichment failed, skipping', { mint, sig: logInfo.signature });
  });
}

async function enrichAndRecord(mint: string, signature: string) {
  // Wait for a concurrency slot before hitting RPC
  await acquireEnrichmentSlot();
  try {
    log.info('Enrichment started', { mint, sig: signature });
    // Small delay to let the transaction finalize
    await new Promise(r => setTimeout(r, 1500));

    const trade = await enrichTradeFromTx(mint, signature);
    if (trade) {
      recordTrade(trade);
      log.info('Enriched trade recorded', {
        mint,
        side: trade.side,
        sol: trade.amountSol.toFixed(4),
        wallet: trade.wallet.slice(0, 8) + '...',
        price: trade.pricePerToken.toExponential(3),
      });
    } else {
      const misses = (enrichMissCounts.get(mint) || 0) + 1;
      enrichMissCounts.set(mint, misses);
      if (misses <= 3) {
        log.warn('Trade enrichment returned null', { mint, sig: signature, misses });
      }
    }
  } catch (err) {
    log.error('Enrichment failed', { mint, sig: signature, error: err });
  } finally {
    releaseEnrichmentSlot();
  }
}

export async function enrichTradeFromTx(mint: string, signature: string): Promise<TradeEvent | null> {
  const conn = getConnection();

  try {
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx?.meta) {
      log.warn('Parsed transaction missing meta', { mint, signature });
      return null;
    }

    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];

    // Build per-owner, per-mint delta map — handles any quote (SOL, USDC, USDT, etc.)
    const deltaMap = new Map<string, Map<string, number>>();

    function addDelta(owner: string, tokenMint: string, amount: number) {
      let ownerMap = deltaMap.get(owner);
      if (!ownerMap) {
        ownerMap = new Map();
        deltaMap.set(owner, ownerMap);
      }
      ownerMap.set(tokenMint, (ownerMap.get(tokenMint) || 0) + amount);
    }

    for (const b of pre) {
      if (!b.owner) continue;
      addDelta(b.owner, b.mint, -(b.uiTokenAmount.uiAmount || 0));
    }
    for (const b of post) {
      if (!b.owner) continue;
      addDelta(b.owner, b.mint, (b.uiTokenAmount.uiAmount || 0));
    }

    // Find owner with largest absolute target-mint delta
    let bestOwner = '';
    let bestDelta = 0;
    for (const [owner, mints] of deltaMap) {
      const delta = mints.get(mint) || 0;
      if (Math.abs(delta) > Math.abs(bestDelta)) {
        bestDelta = delta;
        bestOwner = owner;
      }
    }

    if (!bestOwner || bestDelta === 0) {
      log.warn('Token delta is zero for all owners', { mint, signature });
      return null;
    }

    // Find the quote: largest absolute delta in any non-target mint for this owner
    const ownerDeltas = deltaMap.get(bestOwner)!;
    let quoteAmount = 0;
    for (const [m, d] of ownerDeltas) {
      if (m === mint) continue;
      if (Math.abs(d) > Math.abs(quoteAmount)) {
        quoteAmount = d;
      }
    }

    let amountQuote = Math.abs(quoteAmount);

    // Fallback: native SOL balance change (for swaps that don't use wSOL token accounts)
    if (amountQuote === 0) {
      const signer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey.toBase58() || '';
      if (signer) {
        const signerIdx = tx.transaction.message.accountKeys.findIndex(k => k.signer);
        const preSol = (tx.meta.preBalances[signerIdx] || 0) / 1e9;
        const postSol = (tx.meta.postBalances[signerIdx] || 0) / 1e9;
        const fee = tx.meta.fee / 1e9;
        amountQuote = Math.abs((postSol - preSol) + fee);
      }
    }

    if (amountQuote === 0) {
      log.warn('Quote delta is zero', { mint, signature, owner: bestOwner });
      return null;
    }

    const isBuy = bestDelta > 0;
    const amountToken = Math.abs(bestDelta);
    const pricePerToken = amountToken > 0 ? amountQuote / amountToken : 0;

    return {
      mint,
      signature,
      timestamp: (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000,
      side: isBuy ? 'buy' : 'sell',
      wallet: bestOwner,
      amountToken,
      amountSol: amountQuote, // quote amount (SOL, USDC, etc.)
      pricePerToken,
    };
  } catch (err) {
    log.error('Failed to enrich trade', { mint, signature, error: err });
    return null;
  }
}

export function getActiveSubscriptionCount(): number {
  return subscriptions.size;
}

// Exposed for testing
export function _test_dedupState() {
  return { currentSigs, previousSigs, MAX_SIGS_PER_GENERATION };
}

export function _test_resetDedup() {
  currentSigs = new Set();
  previousSigs = new Set();
}
