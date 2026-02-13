import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { getConnection, getKeypair, createLogger, config } from '../utils';
import { loadStrategyConfig } from '../strategy/strategy-config';
import { evaluateExit, PortfolioState } from '../strategy/rules';
import { fetchTokenData, fetchPoolLiquidity } from '../analysis/token-data';
import { buyToken, sellToken } from './jupiter-swap';
import { paperBuyToken, paperSellToken } from './paper-executor';
import { Position, PositionExit, SwapResult } from './types';
import { checkKillSwitch } from './guards';
import { recordExecutionAttempt, recordClosedPosition } from '../strategy/metrics';
import { logExecution } from '../data';

// Route buy/sell through paper executor when in paper mode
async function executeBuy(mint: string, sizeSol: number, slippageBps: number): Promise<SwapResult> {
  if (config.trading.paperTrading) {
    return paperBuyToken(mint, sizeSol, slippageBps);
  }
  return buyToken(mint, sizeSol, slippageBps, true);
}

async function executeSell(mint: string, tokenAmountRaw: string, slippageBps: number): Promise<SwapResult> {
  if (config.trading.paperTrading) {
    return paperSellToken(mint, tokenAmountRaw, slippageBps);
  }
  return sellToken(mint, tokenAmountRaw, slippageBps, true);
}

const log = createLogger('positions');
const DATA_DIR = path.resolve(__dirname, '../../data');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Track last quoted impact for dashboard visibility
let lastQuotedImpact: { mint: string; impact: number; timestamp: number } | null = null;
export function getLastQuotedImpact() { return lastQuotedImpact; }

// Pre-flight slippage check via Jupiter quote
async function checkEntryImpact(mint: string, sizeSol: number): Promise<number | null> {
  try {
    const lamports = Math.floor(sizeSol * 1e9).toString();
    const params = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: lamports,
      slippageBps: '100',
    });
    const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`);
    const json = await res.json() as { priceImpactPct?: string; error?: string };
    if (json.error) return null;
    const impact = parseFloat(json.priceImpactPct || '0');
    lastQuotedImpact = { mint, impact, timestamp: Date.now() };
    return impact;
  } catch {
    return null; // Don't block on quote failure
  }
}

const openPositions = new Map<string, Position>();
const closedPositions: Position[] = [];

// Portfolio tracking
let dailyStartEquity = 0;
let dailyPnlSol = 0;
let consecutiveLosses = 0;
let lastLossTime = 0;
const stoppedOutTokens = new Map<string, number>();

// LP tracking for emergency exits
const lpHistory = new Map<string, { timestamp: number; liquidityUsd: number }[]>();

// Token decimals cache for raw amount conversions
const decimalsCache = new Map<string, number>();

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
  const openPnlSol = Array.from(openPositions.values()).reduce((sum, p) => {
    const currentValue = p.remainingTokens * p.currentPrice;
    const costBasis = (p.remainingTokens / p.initialTokens) * p.initialSizeSol;
    return sum + (currentValue - costBasis);
  }, 0);

  const equitySol = dailyStartEquity + dailyPnlSol + openPnlSol;
  const openExposureSol = Array.from(openPositions.values())
    .reduce((sum, p) => sum + p.remainingTokens * p.currentPrice, 0);

  return {
    equitySol,
    openPositions: openPositions.size,
    openExposureSol,
    dailyPnlPct: dailyStartEquity > 0 ? ((dailyPnlSol + openPnlSol) / dailyStartEquity) * 100 : 0,
    consecutiveLosses,
    lastLossTime,
    stoppedOutTokens,
  };
}

export async function initPortfolio() {
  const conn = getConnection();
  const balance = await conn.getBalance(getKeypair().publicKey);
  dailyStartEquity = balance / 1e9;
  log.info('Portfolio initialized', { equitySol: dailyStartEquity.toFixed(4) });
}

export function resetDailyStats() {
  dailyPnlSol = 0;
  consecutiveLosses = 0;
  log.info('Daily stats reset');
}

export async function openPosition(
  mint: string,
  sizeSol: number,
  slippageBps: number
): Promise<Position | null> {
  const cfg = loadStrategyConfig();
  const portfolio = getPortfolioState();

  const killCheck = checkKillSwitch(portfolio.dailyPnlPct, consecutiveLosses);
  if (!killCheck.passed) {
    log.warn('Kill switch active, not opening position', { reason: killCheck.reason });
    return null;
  }

  if (openPositions.size >= cfg.portfolio.maxConcurrentPositions) {
    log.warn('Max concurrent positions reached', { current: openPositions.size });
    return null;
  }

  const exposurePct = portfolio.equitySol > 0
    ? ((portfolio.openExposureSol + sizeSol) / portfolio.equitySol) * 100
    : 100;
  if (exposurePct > cfg.portfolio.maxOpenExposurePct) {
    log.warn('Would exceed max exposure', { exposurePct: exposurePct.toFixed(1) });
    return null;
  }

  // Slippage guard: pre-flight Jupiter quote to check price impact
  const maxImpact = cfg.position.maxEntryImpactPct;
  if (maxImpact > 0) {
    const impact = await checkEntryImpact(mint, sizeSol);
    if (impact !== null && impact > maxImpact) {
      log.warn('Entry rejected: slippage too high', {
        mint,
        sizeSol: sizeSol.toFixed(4),
        quotedImpact: impact.toFixed(4),
        maxImpact,
      });
      return null;
    }
  }

  log.info('Opening position', { mint, sizeSol: sizeSol.toFixed(4) });

  const buyStart = Date.now();
  const result = await executeBuy(mint, sizeSol, slippageBps);
  recordExecutionAttempt(result.success);
  logExecution({
    mint,
    side: 'buy',
    sizeSol: result.solAmount || sizeSol,
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

  // entryPrice = SOL spent / tokens received (both human-readable, decimal-adjusted)
  const entryPrice = result.tokenAmount > 0 ? result.solAmount / result.tokenAmount : 0;

  const position: Position = {
    id: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mint,
    entrySignature: result.signature || '',
    entryPrice,
    entryTime: Date.now(),
    initialSizeSol: result.solAmount,
    initialTokens: result.tokenAmount,
    remainingSol: result.solAmount,
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
  };

  openPositions.set(mint, position);
  log.info('Position opened', {
    id: position.id,
    mint,
    solSpent: result.solAmount.toFixed(4),
    tokensReceived: result.tokenAmount,
    entryPrice: entryPrice.toExponential(4),
    fee: result.fee.toFixed(6),
    latencyMs: result.latencyMs,
  });

  return position;
}

export async function updatePositions() {
  if (openPositions.size === 0) return;

  for (const [mint, position] of openPositions) {
    try {
      await updatePosition(position);
    } catch (err) {
      log.error('Failed to update position', { mint, error: err });
    }
  }
}

async function updatePosition(position: Position) {
  const cfg = loadStrategyConfig();

  const tokenData = await fetchTokenData(position.mint, position.entryTime);
  if (!tokenData || tokenData.priceSol <= 0) return;

  position.currentPrice = tokenData.priceSol;

  const pnlPct = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
  position.currentPnlPct = pnlPct;
  if (pnlPct > position.peakPnlPct) {
    position.peakPnlPct = pnlPct;
  }

  // Update remaining notional SOL value
  position.remainingSol = position.remainingTokens * position.currentPrice;

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

  const exitSignal = evaluateExit(
    pnlPct,
    position.peakPnlPct,
    holdTimeMinutes,
    lpChangePct,
    position.tp1Hit,
    position.tp2Hit
  );

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
  const rawTokensToSell = Math.floor(tokensToSell * Math.pow(10, decimals)).toString();
  const slippageBps = cfg.entry.maxSlippagePct * 100;

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
    sizeSol: result.solAmount || 0,
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
    solReceived: result.success ? result.solAmount : 0,
    price: position.currentPrice,
    signature: result.signature,
    timestamp: Date.now(),
  };

  position.exits.push(exit);

  if (result.success) {
    position.remainingTokens -= result.tokenAmount;
    position.remainingSol = position.remainingTokens * position.currentPrice;
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
      solReceived: result.solAmount.toFixed(4),
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

  const totalSolOut = position.exits.reduce((sum, e) => sum + e.solReceived, 0);
  const pnlSol = totalSolOut - position.initialSizeSol;

  dailyPnlSol += pnlSol;

  if (pnlSol < 0) {
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
    pnlSol: pnlSol.toFixed(4),
    pnlPct: position.currentPnlPct.toFixed(1),
    holdTime: `${Math.round((Date.now() - position.entryTime) / 60_000)}m`,
    dailyPnl: dailyPnlSol.toFixed(4),
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
        const pnl = p.exits.reduce((s, e) => s + e.solReceived, 0) - p.initialSizeSol;
        return pnl > 0;
      }).length,
      dailyPnlSol,
      consecutiveLosses,
    },
  };

  const filePath = path.join(DATA_DIR, `positions-${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  log.info('Position history saved', { path: filePath });
}
