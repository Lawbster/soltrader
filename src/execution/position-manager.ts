import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { getConnection, getKeypair, createLogger, config } from '../utils';
import { loadStrategyConfig } from '../strategy/strategy-config';
import { evaluateExit, PortfolioState } from '../strategy/rules';
import { fetchTokenData, fetchPoolLiquidity } from '../analysis/token-data';
import { buyToken, sellToken, USDC_MINT, SOL_MINT } from './jupiter-swap';
import { paperBuyToken, paperSellToken } from './paper-executor';
import { Position, PositionExit, SwapResult, StrategyPlan } from './types';
import { checkKillSwitch } from './guards';
import { recordExecutionAttempt, recordClosedPosition, recordSkip } from '../strategy/metrics';
import { logExecution } from '../data';

// Route buy/sell through paper executor when in paper mode
async function executeBuy(mint: string, sizeUsdc: number, slippageBps: number): Promise<SwapResult> {
  if (config.trading.paperTrading) {
    return paperBuyToken(mint, sizeUsdc, slippageBps);
  }
  return buyToken(mint, sizeUsdc, slippageBps, true);
}

async function executeSell(mint: string, tokenAmountRaw: string, slippageBps: number): Promise<SwapResult> {
  if (config.trading.paperTrading) {
    return paperSellToken(mint, tokenAmountRaw, slippageBps);
  }
  return sellToken(mint, tokenAmountRaw, slippageBps, true);
}

const log = createLogger('positions');
const DATA_DIR = path.resolve(__dirname, '../../data');

// Track last quoted impact for dashboard visibility
let lastQuotedImpact: { mint: string; impact: number; timestamp: number } | null = null;
export function getLastQuotedImpact() { return lastQuotedImpact; }

type ImpactCheckResult =
  | { status: 'ok'; impact: number }
  | { status: 'transient-fail' }
  | { status: 'hard-fail'; reason: string };

// Pre-flight slippage check via Jupiter quote (USDC input)
async function checkEntryImpact(mint: string, sizeUsdc: number): Promise<ImpactCheckResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const rawUsdc = Math.floor(sizeUsdc * 1e6).toString();
    const params = new URLSearchParams({
      inputMint: USDC_MINT,
      outputMint: mint,
      amount: rawUsdc,
      slippageBps: '100',
    });
    const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { signal: controller.signal });
    if (!res.ok) {
      return { status: 'hard-fail', reason: `HTTP ${res.status}` };
    }
    const json = await res.json() as { priceImpactPct?: string; error?: string };
    if (json.error) {
      return { status: 'hard-fail', reason: json.error };
    }
    const impact = parseFloat(json.priceImpactPct || '0');
    lastQuotedImpact = { mint, impact, timestamp: Date.now() };
    consecutiveImpactTransientFails = 0;
    return { status: 'ok', impact };
  } catch {
    consecutiveImpactTransientFails++;
    if (consecutiveImpactTransientFails >= IMPACT_TRANSIENT_FAIL_WARN_THRESHOLD) {
      log.warn('Impact check repeatedly failing, Jupiter API may be degraded', {
        consecutiveFails: consecutiveImpactTransientFails,
        mint,
      });
    }
    return { status: 'transient-fail' };
  } finally {
    clearTimeout(timeoutId);
  }
}

const openPositions = new Map<string, Position>();
const closedPositions: Position[] = [];

// Portfolio tracking (USDC denominated)
let dailyStartEquity = 0;
let dailyPnlUsdc = 0;
let consecutiveLosses = 0;
let lastLossTime = 0;
const stoppedOutTokens = new Map<string, number>();

// LP tracking for emergency exits
const lpHistory = new Map<string, { timestamp: number; liquidityUsd: number }[]>();

// Token decimals cache for raw amount conversions
const decimalsCache = new Map<string, number>();

// Capital reservation: USDC committed to in-flight buys
let reservedUsdc = 0;

// In-flight entry lock: prevents race-condition duplicate entries for the same mint
const inFlightEntriesByMint = new Set<string>();

// Transient impact-check failure tracking
let consecutiveImpactTransientFails = 0;
const IMPACT_TRANSIENT_FAIL_WARN_THRESHOLD = 3;

// Read actual on-chain SPL token balance (raw lamport amount) for a given mint
async function getOnChainTokenBalanceRaw(mint: string): Promise<string | null> {
  try {
    const conn = getConnection();
    const wallet = getKeypair().publicKey;
    const mintPubkey = new PublicKey(mint);
    const accounts = await conn.getTokenAccountsByOwner(wallet, { mint: mintPubkey });
    if (accounts.value.length === 0) return '0';
    const parsed = await conn.getParsedAccountInfo(accounts.value[0].pubkey);
    if (parsed.value?.data && 'parsed' in parsed.value.data) {
      return parsed.value.data.parsed.info.tokenAmount.amount as string;
    }
    return null;
  } catch (err) {
    log.warn('Failed to read on-chain token balance', { mint, error: err });
    return null;
  }
}

async function getDecimals(mint: string): Promise<number> {
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
  } catch { /* use default */ }
  return 9;
}

export function getPortfolioState(): PortfolioState {
  // Include unrealized PnL from open positions in equity
  const openPnlUsdc = Array.from(openPositions.values()).reduce((sum, p) => {
    const currentValue = p.remainingTokens * p.currentPrice;
    const costBasis = (p.remainingTokens / p.initialTokens) * p.initialSizeUsdc;
    return sum + (currentValue - costBasis);
  }, 0);

  const equityUsdc = dailyStartEquity + dailyPnlUsdc + openPnlUsdc;
  const openExposureUsdc = Array.from(openPositions.values())
    .reduce((sum, p) => sum + p.remainingTokens * p.currentPrice, 0);

  return {
    equityUsdc,
    openPositions: openPositions.size,
    openExposureUsdc,
    dailyPnlPct: dailyStartEquity > 0 ? ((dailyPnlUsdc + openPnlUsdc) / dailyStartEquity) * 100 : 0,
    consecutiveLosses,
    lastLossTime,
    stoppedOutTokens,
  };
}

// Read USDC SPL token balance for the wallet
async function getUsdcBalance(): Promise<number> {
  try {
    const conn = getConnection();
    const wallet = getKeypair().publicKey;
    const usdcMint = new PublicKey(USDC_MINT);
    const accounts = await conn.getTokenAccountsByOwner(wallet, { mint: usdcMint });
    if (accounts.value.length === 0) return 0;
    const data = accounts.value[0].account.data;
    const parsed = await conn.getParsedAccountInfo(accounts.value[0].pubkey);
    if (parsed.value?.data && 'parsed' in parsed.value.data) {
      return parsed.value.data.parsed.info.tokenAmount.uiAmount || 0;
    }
    return 0;
  } catch (err) {
    log.warn('Failed to read USDC balance', { error: err });
    return 0;
  }
}

// Cached wallet balances (TTL: 60s) — avoids hammering RPC on 30s dashboard polls
let walletBalancesCache: { usdc: number; sol: number; cachedAt: number } | null = null;
const WALLET_BALANCE_TTL_MS = 60_000;

export async function getWalletBalances(): Promise<{ usdc: number; sol: number }> {
  if (walletBalancesCache && Date.now() - walletBalancesCache.cachedAt < WALLET_BALANCE_TTL_MS) {
    return { usdc: walletBalancesCache.usdc, sol: walletBalancesCache.sol };
  }
  const [usdc, sol] = await Promise.all([
    getUsdcBalance(),
    (async () => {
      try {
        return await getConnection().getBalance(getKeypair().publicKey) / 1e9;
      } catch {
        return walletBalancesCache?.sol ?? 0;
      }
    })(),
  ]);
  walletBalancesCache = { usdc, sol, cachedAt: Date.now() };
  return { usdc, sol };
}

export async function initPortfolio() {
  const usdcBalance = await getUsdcBalance();
  dailyStartEquity = usdcBalance;
  log.info('Portfolio initialized', { equityUsdc: dailyStartEquity.toFixed(2) });
}

export function resetDailyStats() {
  dailyPnlUsdc = 0;
  consecutiveLosses = 0;
  log.info('Daily stats reset');
}

// SOL auto-replenish: keep enough SOL for tx fees
export async function checkSolReplenish() {
  try {
    const conn = getConnection();
    const solBalance = await conn.getBalance(getKeypair().publicKey) / 1e9;
    if (solBalance < 0.1) {
      log.info('SOL balance low, auto-replenishing', { solBalance: solBalance.toFixed(4) });
      // Buy ~0.5 SOL worth via Jupiter (USDC → SOL)
      const { fetchTokenPrice } = await import('../analysis/token-data');
      const { priceUsd: solPriceUsd } = await fetchTokenPrice(SOL_MINT);
      const usdcNeeded = 0.5 * solPriceUsd;

      const rawUsdc = Math.floor(usdcNeeded * 1e6).toString();
      const { getQuote, executeSwap } = await import('./jupiter-swap');
      const quote = await getQuote(USDC_MINT, SOL_MINT, rawUsdc, 300);
      if (quote) {
        if (config.trading.paperTrading) {
          log.info('PAPER: SOL replenish simulated', { usdcSpent: usdcNeeded.toFixed(2) });
        } else {
          const result = await executeSwap(quote, false, 'replenish');
          log.info('SOL replenished', {
            usdcSpent: usdcNeeded.toFixed(2),
            success: result.success,
          });
        }
      }
    }
  } catch (err) {
    log.warn('SOL replenish check failed', { error: err });
  }
}

export async function openPosition(
  mint: string,
  sizeUsdc: number,
  slippageBps: number,
  strategyPlan?: StrategyPlan
): Promise<Position | null> {
  const cfg = loadStrategyConfig();
  const portfolio = getPortfolioState();

  const killCheck = checkKillSwitch(portfolio.dailyPnlPct, consecutiveLosses);
  if (!killCheck.passed) {
    log.warn('Kill switch active, not opening position', { reason: killCheck.reason });
    recordSkip('kill_switch');
    return null;
  }

  if (openPositions.size >= cfg.portfolio.maxConcurrentPositions) {
    log.warn('Max concurrent positions reached', { current: openPositions.size });
    recordSkip('max_positions');
    return null;
  }

  const exposurePct = portfolio.equityUsdc > 0
    ? ((portfolio.openExposureUsdc + sizeUsdc) / portfolio.equityUsdc) * 100
    : 100;
  if (exposurePct > cfg.portfolio.maxOpenExposurePct) {
    log.warn('Would exceed max exposure', { exposurePct: exposurePct.toFixed(1) });
    recordSkip('max_exposure');
    return null;
  }

  // Capital gate: ensure sufficient USDC available after reservations
  {
    const balances = await getWalletBalances();
    const spendable = balances.usdc - reservedUsdc;
    if (spendable < sizeUsdc) {
      log.warn('Entry skipped: insufficient USDC', {
        mint,
        required: sizeUsdc.toFixed(2),
        walletUsdc: balances.usdc.toFixed(2),
        reservedUsdc: reservedUsdc.toFixed(2),
        spendable: spendable.toFixed(2),
      });
      recordSkip('capital_insufficient');
      return null;
    }
  }

  // Slippage guard: pre-flight Jupiter quote to check price impact
  const maxImpact = cfg.position.maxEntryImpactPct;
  if (maxImpact > 0) {
    const impactResult = await checkEntryImpact(mint, sizeUsdc);
    if (impactResult.status === 'transient-fail') {
      log.warn('Entry skipped: impact check transient failure', { mint });
      recordSkip('impact_transient_fail');
      return null;
    }
    if (impactResult.status === 'hard-fail') {
      log.warn('Entry skipped: impact check failed', { mint, reason: impactResult.reason });
      recordSkip('impact_hard_fail');
      return null;
    }
    if (impactResult.impact > maxImpact) {
      log.warn('Entry rejected: slippage too high', {
        mint,
        sizeUsdc: sizeUsdc.toFixed(2),
        quotedImpact: impactResult.impact.toFixed(4),
        maxImpact,
      });
      recordSkip('impact_too_high');
      return null;
    }
  }

  // In-flight lock: prevent race-condition duplicate entries for same mint
  if (inFlightEntriesByMint.has(mint)) {
    log.warn('Entry already in flight for mint, skipping', { mint });
    recordSkip('entry_in_flight');
    return null;
  }

  log.info('Opening position', { mint, sizeUsdc: sizeUsdc.toFixed(2) });

  inFlightEntriesByMint.add(mint);
  reservedUsdc += sizeUsdc;
  const buyStart = Date.now();
  let result!: SwapResult;
  try {
    result = await executeBuy(mint, sizeUsdc, slippageBps);
  } finally {
    inFlightEntriesByMint.delete(mint);
    reservedUsdc = Math.max(0, reservedUsdc - sizeUsdc);
  }

  recordExecutionAttempt(result.success);
  logExecution({
    mint,
    side: 'buy',
    sizeUsdc: result.usdcAmount || sizeUsdc,
    slippageBps,
    quotedImpactPct: result.priceImpactPct || 0,
    result: result.success ? 'success' : 'fail',
    error: result.error || '',
    latencyMs: Date.now() - buyStart,
  });
  if (!result.success) {
    log.error('Buy failed', { mint, error: result.error });
    return null;
  }

  // Invalidate balance cache so next check reflects the spend
  walletBalancesCache = null;

  // entryPrice = USDC spent / tokens received (USDC per token)
  const entryPrice = result.tokenAmount > 0 ? result.usdcAmount / result.tokenAmount : 0;

  const position: Position = {
    id: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mint,
    entrySignature: result.signature || '',
    entryPrice,
    entryTime: Date.now(),
    initialSizeUsdc: result.usdcAmount,
    initialTokens: result.tokenAmount,
    remainingUsdc: result.usdcAmount,
    remainingTokens: result.tokenAmount,
    remainingPct: 100,
    currentPrice: entryPrice,
    currentPnlPct: 0,
    peakPnlPct: 0,
    tp1Hit: false,
    tp2Hit: false,
    stopMovedToBreakeven: false,
    exits: [],
    status: 'open',
    strategyPlan,
  };

  openPositions.set(mint, position);
  log.info('Position opened', {
    id: position.id,
    mint,
    usdcSpent: result.usdcAmount.toFixed(2),
    tokensReceived: result.tokenAmount,
    entryPrice: entryPrice.toExponential(4),
    fee: result.fee.toFixed(6),
    latencyMs: result.latencyMs,
  });

  return position;
}

let positionUpdateRunning = false;

export async function updatePositions() {
  if (positionUpdateRunning) {
    log.debug('Position update already running, skipping cycle');
    return;
  }
  positionUpdateRunning = true;
  try {
    if (openPositions.size === 0) return;
    for (const [mint, position] of openPositions) {
      try {
        await updatePosition(position);
      } catch (err) {
        log.error('Failed to update position', { mint, error: err });
      }
    }
  } finally {
    positionUpdateRunning = false;
  }
}

async function updatePosition(position: Position) {
  const cfg = loadStrategyConfig();

  const tokenData = await fetchTokenData(position.mint, position.entryTime);
  if (!tokenData || tokenData.priceUsd <= 0) return;

  // Use priceUsd as the USDC price (USDC ≈ $1)
  position.currentPrice = tokenData.priceUsd;

  const pnlPct = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
  position.currentPnlPct = pnlPct;
  if (pnlPct > position.peakPnlPct) {
    position.peakPnlPct = pnlPct;
  }

  // Update remaining notional USDC value
  position.remainingUsdc = position.remainingTokens * position.currentPrice;

  // Track LP for emergency exit
  const liq = await fetchPoolLiquidity(position.mint);
  let lpChangePct = 0;
  const lpEntries = lpHistory.get(position.mint) || [];
  lpEntries.push({ timestamp: Date.now(), liquidityUsd: liq });
  lpHistory.set(position.mint, lpEntries);

  const emergencyWindowMs = cfg.exits.emergencyLpDropWindowMinutes * 60_000;
  const oldLpEntry = lpEntries.find(e => Date.now() - e.timestamp >= emergencyWindowMs);
  if (oldLpEntry && oldLpEntry.liquidityUsd > 0) {
    lpChangePct = ((liq - oldLpEntry.liquidityUsd) / oldLpEntry.liquidityUsd) * 100;
  }

  // Prune old LP entries
  const lpCutoff = Date.now() - 15 * 60_000;
  lpHistory.set(position.mint, lpEntries.filter(e => e.timestamp >= lpCutoff));

  const holdTimeMinutes = (Date.now() - position.entryTime) / 60_000;

  let exitSignal: ReturnType<typeof evaluateExit>;

  if (position.strategyPlan) {
    // Per-token strategy: simple SL/TP exit (100% sell, no partial exits)
    const { sl, tp } = position.strategyPlan;
    if (lpChangePct < cfg.exits.emergencyLpDropPct) {
      exitSignal = {
        type: 'emergency',
        sellPct: 100,
        reason: `LP dropped ${lpChangePct.toFixed(1)}% in ${cfg.exits.emergencyLpDropWindowMinutes}m`,
      };
    } else if (pnlPct <= sl) {
      exitSignal = {
        type: 'hard_stop',
        sellPct: 100,
        reason: `SL hit: ${pnlPct.toFixed(1)}% <= ${sl}%`,
      };
    } else if (pnlPct >= tp) {
      exitSignal = {
        type: 'tp1',
        sellPct: 100,
        reason: `TP hit: ${pnlPct.toFixed(1)}% >= ${tp}%`,
      };
    } else {
      exitSignal = null;
    }
  } else {
    exitSignal = evaluateExit(
      pnlPct,
      position.peakPnlPct,
      holdTimeMinutes,
      lpChangePct,
      position.tp1Hit,
      position.tp2Hit
    );
  }

  if (!exitSignal) return;

  log.info('Exit signal', {
    mint: position.mint,
    type: exitSignal.type,
    sellPct: exitSignal.sellPct,
    reason: exitSignal.reason,
    pnl: pnlPct.toFixed(1),
  });

  await executeExit(position, exitSignal.type, exitSignal.sellPct, exitSignal.reason);
}

async function executeExit(
  position: Position,
  exitType: string,
  sellPct: number,
  reason: string
) {
  const cfg = loadStrategyConfig();

  const fractionToSell = sellPct / 100;
  const tokensToSell = position.remainingTokens * fractionToSell;
  if (tokensToSell <= 0) return;

  // Convert human-readable token amount to raw for Jupiter
  const decimals = await getDecimals(position.mint);
  let rawTokensToSell = Math.floor(tokensToSell * Math.pow(10, decimals)).toString();
  const slippageBps = config.trading.defaultSlippageBps;

  // For full exits, reconcile with on-chain balance to handle fee/rounding dust.
  // IMPORTANT: cap at the position's tracked amount — never sell MORE than we own
  // according to the position, which would sell orphaned tokens from prior sessions.
  if (sellPct >= 100) {
    const onChainRaw = await getOnChainTokenBalanceRaw(position.mint);
    if (onChainRaw && onChainRaw !== '0') {
      const onChainBigInt = BigInt(onChainRaw);
      const positionBigInt = BigInt(rawTokensToSell);
      // Use on-chain if LESS (fee dust trimming). Never use if MORE (orphaned tokens).
      const cappedRaw = onChainBigInt < positionBigInt ? onChainRaw : rawTokensToSell;
      log.info('Full exit: on-chain balance check', {
        mint: position.mint,
        positionRaw: rawTokensToSell,
        onChainRaw,
        cappedRaw,
        orphanedRaw: onChainBigInt > positionBigInt
          ? (onChainBigInt - positionBigInt).toString()
          : '0',
        feeAdjustedRaw: onChainBigInt < positionBigInt
          ? (positionBigInt - onChainBigInt).toString()
          : '0',
      });
      rawTokensToSell = cappedRaw;
    }
  }

  // Guard: after floor() conversion, raw amount may be zero for dust positions
  if (BigInt(rawTokensToSell) <= 0n) {
    log.warn('Exit skipped: raw token amount is zero after floor conversion', {
      mint: position.mint,
      tokensToSell,
      rawTokensToSell,
    });
    recordSkip('raw_amount_zero');
    return;
  }

  log.info('Executing exit', {
    mint: position.mint,
    type: exitType,
    sellPct,
    tokensHuman: tokensToSell,
    tokensRaw: rawTokensToSell,
  });

  const sellStart = Date.now();
  const result = await executeSell(position.mint, rawTokensToSell, slippageBps);
  recordExecutionAttempt(result.success);
  logExecution({
    mint: position.mint,
    side: 'sell',
    sizeUsdc: result.usdcAmount || 0,
    slippageBps,
    quotedImpactPct: result.priceImpactPct || 0,
    result: result.success ? 'success' : 'fail',
    error: result.error || '',
    latencyMs: Date.now() - sellStart,
  });

  const exit: PositionExit = {
    type: exitType,
    sellPct,
    tokensSold: result.success ? result.tokenAmount : 0,
    usdcReceived: result.success ? result.usdcAmount : 0,
    price: position.currentPrice,
    signature: result.signature,
    timestamp: Date.now(),
  };

  position.exits.push(exit);

  if (result.success) {
    position.remainingTokens = Math.max(0, position.remainingTokens - result.tokenAmount);
    position.remainingUsdc = position.remainingTokens * position.currentPrice;
    position.remainingPct = position.initialTokens > 0
      ? (position.remainingTokens / position.initialTokens) * 100
      : 0;

    if (exitType === 'tp1') {
      position.tp1Hit = true;
      position.stopMovedToBreakeven = true;
    }
    if (exitType === 'tp2') {
      position.tp2Hit = true;
    }

    log.info('Exit executed', {
      mint: position.mint,
      type: exitType,
      usdcReceived: result.usdcAmount.toFixed(2),
      remainingPct: position.remainingPct.toFixed(0),
    });
  } else {
    log.error('Exit execution failed', {
      mint: position.mint,
      type: exitType,
      sellPct,
      error: result.error,
    });
    // Do NOT close position on failed exit — position stays open for retry
    return;
  }

  if (position.remainingTokens <= 0 || (sellPct >= 100 && result.success)) {
    closePosition(position, reason);
  }
}

function closePosition(position: Position, reason: string) {
  position.status = 'closed';
  position.closeReason = reason;

  const totalUsdcOut = position.exits.reduce((sum, e) => sum + e.usdcReceived, 0);
  const pnlUsdc = totalUsdcOut - position.initialSizeUsdc;

  dailyPnlUsdc += pnlUsdc;

  if (pnlUsdc < 0) {
    consecutiveLosses++;
    lastLossTime = Date.now();
    stoppedOutTokens.set(position.mint, Date.now());
  } else {
    consecutiveLosses = 0;
  }

  openPositions.delete(position.mint);
  closedPositions.push(position);
  lpHistory.delete(position.mint);

  // Record to metrics tracker
  recordClosedPosition(position, config.trading.paperTrading);

  log.info('Position closed', {
    id: position.id,
    mint: position.mint,
    reason,
    pnlUsdc: pnlUsdc.toFixed(2),
    pnlPct: position.currentPnlPct.toFixed(1),
    holdTime: `${Math.round((Date.now() - position.entryTime) / 60_000)}m`,
    dailyPnl: dailyPnlUsdc.toFixed(2),
    consecutiveLosses,
  });
}

export function getOpenPositions(): Map<string, Position> {
  return openPositions;
}

export function getClosedPositions(): Position[] {
  return closedPositions;
}

export function hasOpenPosition(mint: string): boolean {
  return openPositions.has(mint);
}

export function savePositionHistory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const data = {
    savedAt: new Date().toISOString(),
    open: Array.from(openPositions.values()),
    closed: closedPositions,
    stats: {
      totalTrades: closedPositions.length,
      wins: closedPositions.filter(p => {
        const pnl = p.exits.reduce((s, e) => s + e.usdcReceived, 0) - p.initialSizeUsdc;
        return pnl > 0;
      }).length,
      dailyPnlUsdc,
      consecutiveLosses,
      lastLossTime,
    },
  };

  const filePath = path.join(DATA_DIR, `positions-${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  log.info('Position history saved', { path: filePath });
}

export function loadPositionHistory() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().split('T')[0];

  type PositionFile = {
    open: Position[];
    stats: { dailyPnlUsdc: number; consecutiveLosses: number; lastLossTime: number };
  };

  function tryLoadFile(date: string): PositionFile | null {
    const filePath = path.join(DATA_DIR, `positions-${date}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PositionFile;
    } catch {
      return null;
    }
  }

  // Try today's file first
  const todayData = tryLoadFile(today);
  const isFromToday = todayData !== null;

  if (isFromToday) {
    for (const p of todayData!.open) {
      openPositions.set(p.mint, p);
    }
    if (todayData!.stats) {
      dailyPnlUsdc = todayData!.stats.dailyPnlUsdc ?? 0;
      consecutiveLosses = todayData!.stats.consecutiveLosses ?? 0;
      lastLossTime = todayData!.stats.lastLossTime ?? 0;
    }
    log.info('Position history loaded (today)', {
      openRestored: openPositions.size,
      dailyPnlUsdc: dailyPnlUsdc.toFixed(2),
      consecutiveLosses,
    });
    return;
  }

  // Fall back to yesterday's file — restore open positions only, reset daily stats
  const yesterdayData = tryLoadFile(yesterday);
  if (yesterdayData && (yesterdayData.open?.length ?? 0) > 0) {
    for (const p of yesterdayData.open) {
      openPositions.set(p.mint, p);
    }
    // Do NOT restore yesterday's dailyPnlUsdc/consecutiveLosses — start fresh for today
    dailyPnlUsdc = 0;
    consecutiveLosses = 0;
    lastLossTime = 0;
    log.warn('Position history loaded from yesterday (today file absent/empty)', {
      openRestored: openPositions.size,
      date: yesterday,
    });
  }
}
