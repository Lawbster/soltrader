import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { getConnection, getKeypair, createLogger, config } from '../utils';
import { loadStrategyConfig } from '../strategy/strategy-config';
import { evaluateExit, PortfolioState } from '../strategy/rules';
import { fetchTokenData, fetchPoolLiquidity } from '../analysis/token-data';
import { getIndicatorSnapshot, getTokenPriceCached, snapshotToIndicatorValues } from '../analysis';
import type { IndicatorSnapshot } from '../analysis/types';
import { evaluateSignal, getTemplateMetadata } from '../strategy/templates/catalog';
import type { LiveTemplateContext } from '../strategy/templates/types';
import { buyToken, sellToken, USDC_MINT, SOL_MINT } from './jupiter-swap';
import { jupiterGet } from './jupiter-client';
import { paperBuyToken, paperSellToken } from './paper-executor';
import { Position, PositionExit, SwapResult, StrategyPlan } from './types';
import { checkKillSwitch } from './guards';
import { recordExecutionAttempt, recordClosedPosition, recordSkip } from '../strategy/metrics';
import { logExecution } from '../data';
import { rawToBigInt, rawToHumanAmount } from './amounts';
import { calculateTrackedPnlUsdc, summarizeTrackedExits } from './position-accounting';

function resolveExecutionMode(strategyPlan?: StrategyPlan): 'live' | 'paper' {
  if (strategyPlan?.executionMode) return strategyPlan.executionMode;
  return config.trading.paperTrading ? 'paper' : 'live';
}

function isPaperStrategyPlan(strategyPlan?: StrategyPlan): boolean {
  return resolveExecutionMode(strategyPlan) === 'paper';
}

function isPaperPosition(position: Position): boolean {
  return isPaperStrategyPlan(position.strategyPlan);
}

function calculateOpenPnlUsdc(positions: Iterable<Position>): number {
  let total = 0;
  for (const position of positions) {
    const currentValue = position.remainingTokens * position.currentPrice;
    const costBasis = (position.remainingTokens / position.initialTokens) * position.initialSizeUsdc;
    total += currentValue - costBasis;
  }
  return total;
}

function calculateOpenExposureUsdc(positions: Iterable<Position>): number {
  let total = 0;
  for (const position of positions) {
    total += position.remainingTokens * position.currentPrice;
  }
  return total;
}

// Route buy/sell through paper executor when in paper mode or when a route explicitly asks for paper execution.
async function executeBuy(
  mint: string,
  sizeUsdc: number,
  slippageBps: number,
  strategyPlan?: StrategyPlan,
): Promise<SwapResult> {
  if (resolveExecutionMode(strategyPlan) === 'paper') {
    return paperBuyToken(mint, sizeUsdc, slippageBps);
  }
  return buyToken(mint, sizeUsdc, slippageBps, true, {
    decisionId: strategyPlan?.decisionId,
    strategyPlan,
  });
}

async function executeSell(
  mint: string,
  tokenAmountRaw: string,
  slippageBps: number,
  strategyPlan?: StrategyPlan,
  positionId?: string,
  closeReason?: string,
): Promise<SwapResult> {
  if (resolveExecutionMode(strategyPlan) === 'paper') {
    return paperSellToken(mint, tokenAmountRaw, slippageBps);
  }
  return sellToken(mint, tokenAmountRaw, slippageBps, true, {
    decisionId: strategyPlan?.decisionId,
    positionId,
    strategyPlan,
    closeReason,
  });
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
    const res = await jupiterGet(`https://lite-api.jup.ag/swap/v1/quote?${params}`, 2, controller.signal);
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
let dailyPaperPnlUsdc = 0;
let consecutiveLosses = 0;
let lastLossTime = 0;
let dailyStatsDateUtc = new Date().toISOString().split('T')[0];
const stoppedOutTokens = new Map<string, number>();

// Per-route consecutive loss circuit breaker
const routeLossCounts = new Map<string, number>(); // routeId → consecutive losses
const routeCooldowns = new Map<string, number>();   // routeId → cooldownUntil ms timestamp
const ROUTE_LOSS_LIMIT = 3;
const ROUTE_COOLDOWN_MS = 12 * 60 * 60_000; // 12 hours

// LP tracking for emergency exits
const lpHistory = new Map<string, { timestamp: number; liquidityUsd: number }[]>();

// Token decimals cache for raw amount conversions
const decimalsCache = new Map<string, number>();
const mintOperationLocks = new Map<string, Promise<void>>();

// Capital reservation: USDC committed to in-flight buys
let reservedUsdc = 0;

// In-flight entry lock: prevents race-condition duplicate entries for the same mint
const inFlightEntriesByMint = new Set<string>();

// Transient impact-check failure tracking
let consecutiveImpactTransientFails = 0;
const IMPACT_TRANSIENT_FAIL_WARN_THRESHOLD = 3;

function getPositionExitTime(position: Position): number {
  const lastExit = position.exits[position.exits.length - 1];
  return lastExit?.timestamp ?? position.entryTime;
}

function getUtcDateForTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0];
}

function isPositionClosedOnUtcDate(position: Position, utcDate: string): boolean {
  return getUtcDateForTimestamp(getPositionExitTime(position)) === utcDate;
}

function recomputeRouteCooldowns(positions: Position[]) {
  routeLossCounts.clear();
  routeCooldowns.clear();

  const byRoute = new Map<string, Position[]>();
  for (const p of positions) {
    const rid = p.strategyPlan?.routeId;
    if (!rid) continue;
    if (!byRoute.has(rid)) byRoute.set(rid, []);
    byRoute.get(rid)!.push(p);
  }

  for (const [rid, routePositions] of byRoute) {
    const sorted = routePositions.slice().sort((a, b) => getPositionExitTime(a) - getPositionExitTime(b));
    let streak = 0;
    let lastLossTs = 0;
    for (const p of sorted) {
      const pnl = calculateTrackedPnlUsdc(p);
      if (pnl < 0) {
        streak++;
        lastLossTs = getPositionExitTime(p);
      } else {
        streak = 0;
      }
    }
    routeLossCounts.set(rid, streak);
    if (streak >= ROUTE_LOSS_LIMIT && lastLossTs > 0) {
      const until = lastLossTs + ROUTE_COOLDOWN_MS;
      if (until > Date.now()) {
        routeCooldowns.set(rid, until);
        log.info('Route cooldown restored from history', {
          routeId: rid,
          streak,
          cooldownUntilIso: new Date(until).toISOString(),
        });
      }
    }
  }
}

export function recomputeSavedStatsForDate(positions: Position[], statsDateUtc: string) {
  const sorted = positions.slice().sort((a, b) => getPositionExitTime(a) - getPositionExitTime(b));
  const totalTrades = sorted.length;
  const wins = sorted.filter(position => calculateTrackedPnlUsdc(position) > 0).length;
  const livePositions = sorted.filter(position => !isPaperPosition(position));
  const paperPositions = sorted.filter(position => isPaperPosition(position));
  const dailyLivePositions = livePositions.filter(position => isPositionClosedOnUtcDate(position, statsDateUtc));
  const dailyPaperPositions = paperPositions.filter(position => isPositionClosedOnUtcDate(position, statsDateUtc));
  const realizedDailyPnlUsdc = dailyLivePositions.reduce((sum, position) => sum + calculateTrackedPnlUsdc(position), 0);
  const realizedDailyPaperPnlUsdc = dailyPaperPositions.reduce((sum, position) => sum + calculateTrackedPnlUsdc(position), 0);

  let recomputedConsecutiveLosses = 0;
  let recomputedLastLossTime = 0;
  for (const position of dailyLivePositions) {
    const pnl = calculateTrackedPnlUsdc(position);
    const exitTime = getPositionExitTime(position);
    if (pnl < 0) {
      recomputedConsecutiveLosses += 1;
      recomputedLastLossTime = exitTime;
    } else {
      recomputedConsecutiveLosses = 0;
    }
  }

  return {
    totalTrades,
    wins,
    dailyPnlUsdc: realizedDailyPnlUsdc,
    dailyPaperPnlUsdc: realizedDailyPaperPnlUsdc,
    consecutiveLosses: recomputedConsecutiveLosses,
    lastLossTime: recomputedLastLossTime,
  };
}

function recomputeSavedStats(positions: Position[], statsDateUtc: string = currentUtcDate()) {
  return recomputeSavedStatsForDate(positions, statsDateUtc);
}

async function withMintOperationLock<T>(
  mint: string,
  operation: 'entry' | 'exit',
  fn: () => Promise<T>,
): Promise<T> {
  const previous = mintOperationLocks.get(mint) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => current);
  mintOperationLocks.set(mint, chain);

  const waitStartedAt = Date.now();
  await previous.catch(() => undefined);
  const waitedMs = Date.now() - waitStartedAt;
  if (waitedMs > 0) {
    log.debug('Mint operation lock waited', { mint, operation, waitedMs });
  }

  try {
    return await fn();
  } finally {
    release();
    queueMicrotask(() => {
      if (mintOperationLocks.get(mint) === chain) {
        mintOperationLocks.delete(mint);
      }
    });
  }
}

function stripNoopExits(position: Position): number {
  const before = position.exits?.length ?? 0;
  if (!Array.isArray(position.exits) || before === 0) return 0;
  position.exits = position.exits.filter(exit =>
    (Number.isFinite(exit.tokensSold) && exit.tokensSold > 0) ||
    (Number.isFinite(exit.usdcReceived) && exit.usdcReceived > 0)
  );
  return before - position.exits.length;
}

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
  const allOpenPositions = Array.from(openPositions.values());
  const liveOpenPositions = allOpenPositions.filter(position => !isPaperPosition(position));
  const paperOpenPositions = allOpenPositions.filter(position => isPaperPosition(position));
  const openPnlUsdc = calculateOpenPnlUsdc(liveOpenPositions);
  const paperOpenPnlUsdc = calculateOpenPnlUsdc(paperOpenPositions);
  const equityUsdc = dailyStartEquity + dailyPnlUsdc + openPnlUsdc;
  const openExposureUsdc = calculateOpenExposureUsdc(liveOpenPositions);
  const paperOpenExposureUsdc = calculateOpenExposureUsdc(paperOpenPositions);

  return {
    equityUsdc,
    openPositions: liveOpenPositions.length,
    openExposureUsdc,
    dailyPnlUsdc,
    openPnlUsdc,
    dailyTotalPnlUsdc: dailyPnlUsdc + openPnlUsdc,
    dailyPnlPct: dailyStartEquity > 0 ? ((dailyPnlUsdc + openPnlUsdc) / dailyStartEquity) * 100 : 0,
    paperOpenPositions: paperOpenPositions.length,
    paperOpenExposureUsdc,
    dailyPaperPnlUsdc,
    paperOpenPnlUsdc,
    dailyPaperTotalPnlUsdc: dailyPaperPnlUsdc + paperOpenPnlUsdc,
    consecutiveLosses,
    lastLossTime,
    stoppedOutTokens,
    routeCooldowns: new Map(routeCooldowns),
  };
}

function currentUtcDate(): string {
  return new Date().toISOString().split('T')[0];
}

async function computeCurrentTotalEquityUsdc(): Promise<number> {
  const walletBalances = await getWalletBalances();
  const solPriceUsd = getTokenPriceCached(SOL_MINT).priceUsd;
  const openNotionalUsdc = calculateOpenExposureUsdc(
    Array.from(openPositions.values()).filter(position => !isPaperPosition(position))
  );
  return walletBalances.usdc + (walletBalances.sol * solPriceUsd) + openNotionalUsdc;
}

function getOpenPositionsForMintInternal(mint: string): Position[] {
  return Array.from(openPositions.values()).filter(p => p.mint === mint && p.status === 'open');
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
  if (!(dailyStartEquity > 0)) {
    dailyStartEquity = await computeCurrentTotalEquityUsdc();
  }
  dailyStatsDateUtc = currentUtcDate();
  log.info('Portfolio initialized', { equityUsdc: dailyStartEquity.toFixed(2) });
}

export function resetDailyStats() {
  dailyPnlUsdc = 0;
  dailyPaperPnlUsdc = 0;
  consecutiveLosses = 0;
  lastLossTime = 0;
  dailyStatsDateUtc = currentUtcDate();
  log.info('Daily stats reset');
}

export async function rollDailyStatsIfNeeded(): Promise<boolean> {
  const today = currentUtcDate();
  if (today === dailyStatsDateUtc) return false;

  dailyStartEquity = await computeCurrentTotalEquityUsdc();
  dailyPnlUsdc = 0;
  dailyPaperPnlUsdc = 0;
  consecutiveLosses = 0;
  lastLossTime = 0;
  dailyStatsDateUtc = today;

  log.info('Daily stats rolled over', {
    date: today,
    dailyStartEquity: dailyStartEquity.toFixed(2),
  });
  return true;
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
  await rollDailyStatsIfNeeded();
  const cfg = loadStrategyConfig();
  const portfolio = getPortfolioState();
  const executionMode = resolveExecutionMode(strategyPlan);
  const isPaper = executionMode === 'paper';

  if (!isPaper) {
    const killCheck = checkKillSwitch(portfolio.dailyPnlPct, consecutiveLosses);
    if (!killCheck.passed) {
      log.warn('Kill switch active, not opening position', { reason: killCheck.reason });
      recordSkip('kill_switch');
      return null;
    }

    if (portfolio.openPositions >= cfg.portfolio.maxConcurrentPositions) {
      log.warn('Max concurrent positions reached', { current: portfolio.openPositions });
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

  return withMintOperationLock(mint, 'entry', async () => {
    // In-flight lock: prevent duplicate buy execution for the same mint while inside
    // the mint operation lock. Sequential same-mint entries are still allowed.
    if (inFlightEntriesByMint.has(mint)) {
      log.warn('Entry already in flight for mint, skipping', { mint });
      recordSkip('entry_in_flight');
      return null;
    }

    log.info('Opening position', { mint, sizeUsdc: sizeUsdc.toFixed(2) });

    inFlightEntriesByMint.add(mint);
    if (!isPaper) reservedUsdc += sizeUsdc;
    const buyStart = Date.now();
    let result!: SwapResult;
    try {
      result = await executeBuy(mint, sizeUsdc, slippageBps, strategyPlan);
    } finally {
      inFlightEntriesByMint.delete(mint);
      if (!isPaper) {
        reservedUsdc = Math.max(0, reservedUsdc - sizeUsdc);
      }
    }

    recordExecutionAttempt(result.success);
    if (!result.success) {
      logExecution({
        decisionId: strategyPlan?.decisionId,
        mint,
        side: 'buy',
        routeId: strategyPlan?.routeId,
        templateId: strategyPlan?.templateId,
        timeframeMinutes: strategyPlan?.timeframeMinutes,
        regime: strategyPlan?.entryRegime,
        exitMode: strategyPlan?.exitMode,
        executionMode,
        entryReason: strategyPlan?.entryReason,
        paramsKey: strategyPlan?.paramsKey,
        protectionKey: strategyPlan?.protectionKey,
        sizeUsdc: result.usdcAmount || sizeUsdc,
        slippageBps,
        quotedImpactPct: result.priceImpactPct || 0,
        result: 'fail',
        error: result.error || '',
        latencyMs: Date.now() - buyStart,
      });
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

    logExecution({
      decisionId: strategyPlan?.decisionId,
      positionId: position.id,
      mint,
      side: 'buy',
      routeId: strategyPlan?.routeId,
      templateId: strategyPlan?.templateId,
      timeframeMinutes: strategyPlan?.timeframeMinutes,
      regime: strategyPlan?.entryRegime,
      exitMode: strategyPlan?.exitMode,
      executionMode,
      entryReason: strategyPlan?.entryReason,
      paramsKey: strategyPlan?.paramsKey,
      protectionKey: strategyPlan?.protectionKey,
      sizeUsdc: result.usdcAmount || sizeUsdc,
      slippageBps,
      quotedImpactPct: result.priceImpactPct || 0,
      result: 'success',
      error: result.error || '',
      latencyMs: Date.now() - buyStart,
    });

    openPositions.set(position.id, position);
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
  });
}

let positionUpdateRunning = false;

export async function updatePositions() {
  await rollDailyStatsIfNeeded();
  if (positionUpdateRunning) {
    log.debug('Position update already running, skipping cycle');
    return;
  }
  positionUpdateRunning = true;
  try {
    if (openPositions.size === 0) return;
    for (const position of Array.from(openPositions.values())) {
      try {
        await updatePosition(position);
      } catch (err) {
        log.error('Failed to update position', { mint: position.mint, id: position.id, error: err });
      }
    }
  } finally {
    positionUpdateRunning = false;
  }
}

function evaluateRouteProtectionExit(
  position: Position,
  holdTimeMinutes: number,
): ReturnType<typeof evaluateExit> {
  const protection = position.strategyPlan?.protection;
  if (!protection) return null;

  const currentPnlPct = position.currentPnlPct;
  const peakPnlPct = position.peakPnlPct;

  // Trailing protection: once armed, lock gains by exiting on pullback from peak.
  if (
    Number.isFinite(protection.trailArmPct) &&
    Number.isFinite(protection.trailGapPct) &&
    (protection.trailArmPct as number) > 0 &&
    (protection.trailGapPct as number) > 0 &&
    peakPnlPct >= (protection.trailArmPct as number)
  ) {
    const trailStopPct = peakPnlPct - (protection.trailGapPct as number);
    if (currentPnlPct <= trailStopPct) {
      return {
        type: 'tp1',
        sellPct: 100,
        reason: `Trailing protect: pnl ${currentPnlPct.toFixed(1)}% <= ${trailStopPct.toFixed(1)}% (peak ${peakPnlPct.toFixed(1)}%)`,
      };
    }
  }

  // Profit lock: after arm threshold is reached, do not allow full round-trip.
  if (
    Number.isFinite(protection.profitLockArmPct) &&
    Number.isFinite(protection.profitLockPct) &&
    (protection.profitLockArmPct as number) > 0 &&
    (protection.profitLockPct as number) >= 0 &&
    peakPnlPct >= (protection.profitLockArmPct as number)
  ) {
    if (currentPnlPct <= (protection.profitLockPct as number)) {
      return {
        type: 'tp1',
        sellPct: 100,
        reason: `Profit lock: pnl ${currentPnlPct.toFixed(1)}% <= ${(protection.profitLockPct as number).toFixed(1)}%`,
      };
    }
  }

  // Stale stop: time-based guard for long, low-conviction holds.
  if (
    Number.isFinite(protection.staleMaxHoldMinutes) &&
    (protection.staleMaxHoldMinutes as number) > 0 &&
    holdTimeMinutes >= (protection.staleMaxHoldMinutes as number)
  ) {
    const minPnlPct = Number.isFinite(protection.staleMinPnlPct)
      ? (protection.staleMinPnlPct as number)
      : 0;
    if (currentPnlPct <= minPnlPct) {
      return {
        type: 'hard_stop',
        sellPct: 100,
        reason: `Stale stop: hold ${Math.round(holdTimeMinutes)}m >= ${Math.round(protection.staleMaxHoldMinutes as number)}m, pnl ${currentPnlPct.toFixed(1)}% <= ${minPnlPct.toFixed(1)}%`,
      };
    }
  }

  return null;
}

function pnlPctFromPrices(entryPrice: number, currentPrice: number): number {
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

function resolveStrategyStopLossExit(position: Position): ReturnType<typeof evaluateExit> {
  const plan = position.strategyPlan;
  if (!plan) return null;

  if (
    Number.isFinite(plan.slAtr) &&
    Number.isFinite(plan.entryAtr) &&
    (plan.slAtr as number) > 0 &&
    (plan.entryAtr as number) > 0
  ) {
    const stopPrice = position.entryPrice - ((plan.slAtr as number) * (plan.entryAtr as number));
    if (position.currentPrice <= stopPrice) {
      const stopPct = pnlPctFromPrices(position.entryPrice, stopPrice);
      return {
        type: 'hard_stop',
        sellPct: 100,
        reason: `ATR SL hit: ${position.currentPnlPct.toFixed(1)}% <= ${stopPct.toFixed(1)}% (x${(plan.slAtr as number).toFixed(2)} ATR)`,
      };
    }
  }

  if (Number.isFinite(plan.sl)) {
    if (position.currentPnlPct <= (plan.sl as number)) {
      return {
        type: 'hard_stop',
        sellPct: 100,
        reason: `SL hit: ${position.currentPnlPct.toFixed(1)}% <= ${(plan.sl as number)}%`,
      };
    }
  }

  return null;
}

function resolveStrategyTakeProfitExit(position: Position): ReturnType<typeof evaluateExit> {
  const plan = position.strategyPlan;
  if (!plan) return null;

  if (
    Number.isFinite(plan.tpAtr) &&
    Number.isFinite(plan.entryAtr) &&
    (plan.tpAtr as number) > 0 &&
    (plan.entryAtr as number) > 0
  ) {
    const targetPrice = position.entryPrice + ((plan.tpAtr as number) * (plan.entryAtr as number));
    if (position.currentPrice >= targetPrice) {
      const targetPct = pnlPctFromPrices(position.entryPrice, targetPrice);
      return {
        type: 'tp1',
        sellPct: 100,
        reason: `ATR TP hit: ${position.currentPnlPct.toFixed(1)}% >= ${targetPct.toFixed(1)}% (x${(plan.tpAtr as number).toFixed(2)} ATR)`,
      };
    }
  }

  if (Number.isFinite(plan.tp)) {
    if (position.currentPnlPct >= (plan.tp as number)) {
      return {
        type: 'tp1',
        sellPct: 100,
        reason: `TP hit: ${position.currentPnlPct.toFixed(1)}% >= ${(plan.tp as number)}%`,
      };
    }
  }

  return null;
}

async function updatePosition(position: Position) {
  const cfg = loadStrategyConfig();

  const tokenData = await fetchTokenData(position.mint, position.entryTime);
  if (!tokenData || tokenData.priceUsd <= 0) return;

  // Use priceUsd as the USDC price (USDC ≈ $1)
  position.currentPrice = tokenData.priceUsd;

  const pnlPct = pnlPctFromPrices(position.entryPrice, position.currentPrice);
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
  const stopLossExit = resolveStrategyStopLossExit(position);
  const takeProfitExit = resolveStrategyTakeProfitExit(position);

  if (position.strategyPlan) {
    // Per-token strategy: SL/TP exit with optional template-indicator exit
    const effectiveExitMode = position.strategyPlan.exitMode ?? 'price';

    // Emergency LP drop — always highest priority regardless of exit mode
    if (lpChangePct < cfg.exits.emergencyLpDropPct) {
      exitSignal = {
        type: 'emergency',
        sellPct: 100,
        reason: `LP dropped ${lpChangePct.toFixed(1)}% in ${cfg.exits.emergencyLpDropWindowMinutes}m`,
      };
    } else {
      const protectionExit = evaluateRouteProtectionExit(position, holdTimeMinutes);
      if (protectionExit) {
        exitSignal = protectionExit;
      } else if (
        effectiveExitMode === 'indicator' &&
        position.strategyPlan.templateId &&
        position.strategyPlan.templateParams
      ) {
        // Template indicator exit: evaluate at most once per candle boundary
        const indCfg = cfg.entry.indicators;
        const timeframeMinutes = Math.max(
          1,
          Math.round(position.strategyPlan.timeframeMinutes ?? indCfg?.candleIntervalMinutes ?? 1),
        );
        const candleMs = timeframeMinutes * 60_000;
        const signalBoundaryMs = Math.floor(Date.now() / candleMs) * candleMs;

        let templateSig: 'buy' | 'sell' | 'hold' = 'hold';

        if (signalBoundaryMs > (position.lastTemplateExitEvalMs ?? 0)) {
          position.lastTemplateExitEvalMs = signalBoundaryMs;
          // Evaluate template signal when indicators are available; otherwise templateSig stays 'hold'
          if (indCfg?.enabled) {
            const planIndicator = position.strategyPlan.indicator;
            const rsiPeriod = planIndicator?.rsiPeriod ?? indCfg.rsi.period;
            const connorsRsiPeriod = planIndicator?.kind === 'rsi'
              ? rsiPeriod
              : (planIndicator?.rsiPeriod ?? indCfg.connors.rsiPeriod);
            const connorsStreakRsiPeriod = planIndicator?.streakRsiPeriod ?? indCfg.connors.streakRsiPeriod;
            const connorsPercentRankPeriod = planIndicator?.kind === 'rsi'
              ? (rsiPeriod + 1)
              : (planIndicator?.percentRankPeriod ?? indCfg.connors.percentRankPeriod);
            const requiredHistory = getTemplateMetadata(position.strategyPlan.templateId).requiredHistory;
            const lookbackMinutes = Math.max(
              indCfg.candleLookbackMinutes,
              timeframeMinutes * (requiredHistory + 10),
            );

            const snap = getIndicatorSnapshot(position.mint, {
              intervalMinutes: timeframeMinutes,
              lookbackMinutes,
              rsiPeriod,
              connorsRsiPeriod,
              connorsStreakRsiPeriod,
              connorsPercentRankPeriod,
              asOfMs: signalBoundaryMs,
            });
            if (snap.candleCount >= requiredHistory) {
              const signalClose = snap.lastCandleClose ?? position.currentPrice;
              const signalHourUtc = snap.lastCandleTimestamp !== undefined
                ? new Date(snap.lastCandleTimestamp + (timeframeMinutes * 60_000)).getUTCHours()
                : new Date().getUTCHours();
              const liveCtx: LiveTemplateContext = {
                close: signalClose,
                prevClose: snap.prevCandleClose,
                prevHigh: snap.prevCandleHigh,
                indicators: snapshotToIndicatorValues(snap),
                prevIndicators: snap.prevIndicators
                  ? snapshotToIndicatorValues(snap.prevIndicators)
                  : undefined,
                hourUtc: signalHourUtc,
                hasPosition: true,
              };
              templateSig = evaluateSignal(
                position.strategyPlan.templateId,
                position.strategyPlan.templateParams,
                liveCtx,
              );
            } else {
              log.debug('Template exit warmup', {
                mint: position.mint,
                routeId: position.strategyPlan.routeId,
                templateId: position.strategyPlan.templateId,
                timeframeMinutes,
                candleCount: snap.candleCount,
                requiredHistory,
              });
            }
            log.debug('Template exit eval', {
              mint: position.mint,
              routeId: position.strategyPlan.routeId,
              templateId: position.strategyPlan.templateId,
              timeframeMinutes,
              signal: templateSig,
              pnl: pnlPct.toFixed(1),
            });
          }
        }

        // Template sell wins; otherwise fall through to SL/TP
        if (templateSig === 'sell') {
          exitSignal = {
            type: 'tp1',
            sellPct: 100,
            reason: `template-indicator-exit: ${position.strategyPlan.templateId}`,
          };
        } else if (stopLossExit) {
          exitSignal = stopLossExit;
        } else if (takeProfitExit) {
          exitSignal = takeProfitExit;
        } else {
          exitSignal = null;
        }
      } else {
        // Price-only exit (exitMode='price' or absent)
        if (stopLossExit) {
          exitSignal = stopLossExit;
        } else if (takeProfitExit) {
          exitSignal = takeProfitExit;
        } else {
          exitSignal = null;
        }
      }
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
  return withMintOperationLock(position.mint, 'exit', async () => {
    const cfg = loadStrategyConfig();

    const fractionToSell = sellPct / 100;
    const tokensToSell = position.remainingTokens * fractionToSell;
    if (tokensToSell <= 0) return;

    const decimals = await getDecimals(position.mint);
    const dustToleranceTokens = 1 / Math.pow(10, decimals);
    let rawTokensToSell = Math.floor(tokensToSell * Math.pow(10, decimals)).toString();
    const slippageBps = config.trading.defaultSlippageBps;
    let orphanedRawBeforeSell = 0n;
    const siblingOpenCount = getOpenPositionsForMintInternal(position.mint)
      .filter(p => p.id !== position.id)
      .length;
    const hasSiblingOpenPositions = siblingOpenCount > 0;

    if (sellPct >= 100) {
      if (hasSiblingOpenPositions) {
        log.info('Full exit: skipping on-chain reconciliation due to sibling positions', {
          mint: position.mint,
          id: position.id,
          siblingOpenCount,
          trackedRaw: rawTokensToSell,
        });
      } else {
        const onChainRaw = await getOnChainTokenBalanceRaw(position.mint);
        if (onChainRaw && onChainRaw !== '0') {
          const onChainBigInt = rawToBigInt(onChainRaw);
          const positionBigInt = rawToBigInt(rawTokensToSell);
          orphanedRawBeforeSell = onChainBigInt > positionBigInt
            ? (onChainBigInt - positionBigInt)
            : 0n;
          const cappedRaw = onChainBigInt < positionBigInt ? onChainRaw : rawTokensToSell;
          log.info('Full exit: on-chain balance check', {
            mint: position.mint,
            positionRaw: rawTokensToSell,
            onChainRaw,
            cappedRaw,
            orphanedRaw: orphanedRawBeforeSell.toString(),
            feeAdjustedRaw: onChainBigInt < positionBigInt
              ? (positionBigInt - onChainBigInt).toString()
              : '0',
          });
          rawTokensToSell = cappedRaw;
        }
      }
    }

    if (rawToBigInt(rawTokensToSell) <= 0n) {
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
      siblingOpenCount,
    });

    const sellStart = Date.now();
    const result = await executeSell(
      position.mint,
      rawTokensToSell,
      slippageBps,
      position.strategyPlan,
      position.id,
      reason,
    );
    recordExecutionAttempt(result.success);
    logExecution({
      decisionId: position.strategyPlan?.decisionId,
      positionId: position.id,
      mint: position.mint,
      side: 'sell',
      routeId: position.strategyPlan?.routeId,
      templateId: position.strategyPlan?.templateId,
      timeframeMinutes: position.strategyPlan?.timeframeMinutes,
      regime: position.strategyPlan?.entryRegime,
      exitMode: position.strategyPlan?.exitMode,
      executionMode: resolveExecutionMode(position.strategyPlan),
      entryReason: position.strategyPlan?.entryReason,
      paramsKey: position.strategyPlan?.paramsKey,
      protectionKey: position.strategyPlan?.protectionKey,
      closeReason: reason,
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

    let verifiedFlat = false;

    if (!result.success) {
      log.error('Exit execution failed', {
        mint: position.mint,
        type: exitType,
        sellPct,
        error: result.error,
      });
      return;
    }

    position.exits.push(exit);
    const soldRaw = rawToBigInt(result.tokenAmountRaw);
    const actualSoldTokens = soldRaw > 0n
      ? rawToHumanAmount(soldRaw, decimals)
      : result.tokenAmount;
    position.remainingTokens = Math.max(0, position.remainingTokens - actualSoldTokens);
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
      remainingPct: position.remainingPct.toFixed(4),
      actualSoldTokens,
    });

    if (sellPct >= 100) {
      if (isPaperStrategyPlan(position.strategyPlan)) {
        verifiedFlat = position.remainingTokens <= dustToleranceTokens;
      } else if (hasSiblingOpenPositions) {
        verifiedFlat = position.remainingTokens <= dustToleranceTokens;
        if (verifiedFlat) {
          position.remainingTokens = 0;
          position.remainingUsdc = 0;
          position.remainingPct = 0;
        }
        log.info('Full exit reconciliation skipped for sibling positions', {
          mint: position.mint,
          id: position.id,
          siblingOpenCount,
          remainingTokens: position.remainingTokens,
          verifiedFlat,
        });
      } else {
        const onChainAfterRaw = await getOnChainTokenBalanceRaw(position.mint);
        if (onChainAfterRaw !== null) {
          const onChainAfter = rawToBigInt(onChainAfterRaw);
          const trackedRemainingRaw = onChainAfter > orphanedRawBeforeSell
            ? (onChainAfter - orphanedRawBeforeSell)
            : 0n;
          const orphanedRemainingRaw = onChainAfter > trackedRemainingRaw
            ? (onChainAfter - trackedRemainingRaw)
            : 0n;
          position.remainingTokens = rawToHumanAmount(trackedRemainingRaw, decimals);
          position.remainingUsdc = position.remainingTokens * position.currentPrice;
          position.remainingPct = position.initialTokens > 0
            ? (position.remainingTokens / position.initialTokens) * 100
            : 0;
          verifiedFlat = trackedRemainingRaw === 0n;

          log.info('Full exit reconciliation', {
            mint: position.mint,
            onChainRemainingRaw: onChainAfterRaw,
            trackedRemainingRaw: trackedRemainingRaw.toString(),
            orphanedRemainingRaw: orphanedRemainingRaw.toString(),
            remainingPct: position.remainingPct.toFixed(4),
            verifiedFlat,
          });
          if (orphanedRemainingRaw > 0n) {
            log.warn('Orphaned token balance remains after tracked position exit', {
              mint: position.mint,
              id: position.id,
              orphanedRemainingRaw: orphanedRemainingRaw.toString(),
            });
          }
        } else {
          log.warn('Full exit reconciliation unavailable, keeping position open unless tracked size is zero', {
            mint: position.mint,
            id: position.id,
          });
        }
      }
    }

    if (position.remainingTokens <= 0 || verifiedFlat) {
      closePosition(position, reason);
    }
  });
}

function closePosition(position: Position, reason: string) {
  position.status = 'closed';
  position.closeReason = reason;

  const exitSummary = summarizeTrackedExits(position);
  const pnlUsdc = calculateTrackedPnlUsdc(position);
  const isPaper = isPaperPosition(position);
  const closedAt = getPositionExitTime(position);

  if (isPaper) {
    dailyPaperPnlUsdc += pnlUsdc;
  } else {
    dailyPnlUsdc += pnlUsdc;
  }

  const finalExitType = position.exits[position.exits.length - 1]?.type;

  if (!isPaper && pnlUsdc < 0) {
    consecutiveLosses++;
    lastLossTime = closedAt;
    if (finalExitType === 'hard_stop' || finalExitType === 'emergency') {
      stoppedOutTokens.set(position.mint, closedAt);
    }
  } else if (!isPaper) {
    consecutiveLosses = 0;
  }

  // Per-route circuit breaker: 3 consecutive losses → 12-hour cooldown
  const routeId = position.strategyPlan?.routeId;
  if (!isPaper && routeId) {
    if (pnlUsdc < 0) {
      const newCount = (routeLossCounts.get(routeId) ?? 0) + 1;
      routeLossCounts.set(routeId, newCount);
      if (newCount >= ROUTE_LOSS_LIMIT) {
        const until = closedAt + ROUTE_COOLDOWN_MS;
        routeCooldowns.set(routeId, until);
        log.warn('Route cooldown activated', {
          routeId,
          consecutiveLosses: newCount,
          cooldownUntilIso: new Date(until).toISOString(),
        });
      }
    } else {
      routeLossCounts.set(routeId, 0);
      routeCooldowns.delete(routeId);
    }
  }

  openPositions.delete(position.id);
  closedPositions.push(position);
  lpHistory.delete(position.mint);

  // Record to metrics tracker
  recordClosedPosition(position, isPaper);

  log.info('Position closed', {
    id: position.id,
    mint: position.mint,
    executionMode: isPaper ? 'paper' : 'live',
    reason,
    pnlUsdc: pnlUsdc.toFixed(2),
    pnlPct: position.currentPnlPct.toFixed(1),
    holdTime: `${Math.round((Date.now() - position.entryTime) / 60_000)}m`,
    dailyPnl: dailyPnlUsdc.toFixed(2),
    dailyPaperPnl: dailyPaperPnlUsdc.toFixed(2),
    consecutiveLosses,
    orphanedUsdcIgnored: exitSummary.orphanedUsdcOut.toFixed(4),
  });
  savePositionHistory(); // persist immediately — prevents crash-and-replay on restart
}

export function getOpenPositions(): Map<string, Position> {
  return openPositions;
}

export function getOpenPositionsForMint(mint: string): Position[] {
  return getOpenPositionsForMintInternal(mint);
}

export function getClosedPositions(): Position[] {
  return closedPositions;
}

export function hasOpenPosition(mint: string): boolean {
  return getOpenPositionsForMintInternal(mint).length > 0;
}

export function hasOpenPositionForRoute(mint: string, routeId?: string): boolean {
  if (!routeId) return false;
  return getOpenPositionsForMintInternal(mint)
    .some(position => (position.strategyPlan?.routeId ?? '') === routeId);
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
      ...recomputeSavedStats(closedPositions, currentUtcDate()),
      dailyStartEquityUsdc: dailyStartEquity,
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
    closed?: Position[];
    stats: {
      dailyPnlUsdc: number;
      dailyPaperPnlUsdc?: number;
      dailyStartEquityUsdc?: number;
      consecutiveLosses: number;
      lastLossTime: number;
    };
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
    let strippedNoopExits = 0;
    for (const p of todayData!.open) {
      strippedNoopExits += stripNoopExits(p);
      openPositions.set(p.id, p);
    }
    closedPositions.length = 0;
    for (const p of todayData!.closed ?? []) {
      closedPositions.push(p);
    }
    if (todayData!.stats) {
      dailyStartEquity = todayData!.stats.dailyStartEquityUsdc ?? dailyStartEquity;
    }
    const recomputedStats = recomputeSavedStats(closedPositions, today);
    dailyPnlUsdc = recomputedStats.dailyPnlUsdc;
    dailyPaperPnlUsdc = recomputedStats.dailyPaperPnlUsdc;
    consecutiveLosses = recomputedStats.consecutiveLosses;
    lastLossTime = recomputedStats.lastLossTime;
    recomputeRouteCooldowns(closedPositions.filter(position => !isPaperPosition(position)));
    // Restore re-entry lockouts that are still within the lockout window
    const reEntryCfg = loadStrategyConfig();
    const lockoutMs = reEntryCfg.portfolio.reEntryLockoutHours * 3_600_000;
    for (const p of closedPositions) {
      const lastExit = p.exits[p.exits.length - 1];
      if (!lastExit) continue;
      if (isPaperPosition(p)) continue;
      const pnl = calculateTrackedPnlUsdc(p);
      if (pnl < 0 && (lastExit.type === 'hard_stop' || lastExit.type === 'emergency')) {
        if (lastExit.timestamp + lockoutMs > Date.now()) {
          stoppedOutTokens.set(p.mint, lastExit.timestamp);
        }
      }
    }
    dailyStatsDateUtc = today;
    log.info('Position history loaded (today)', {
      openRestored: openPositions.size,
      closedRestored: closedPositions.length,
      strippedNoopExits,
      dailyStartEquity: dailyStartEquity.toFixed(2),
      dailyPnlUsdc: dailyPnlUsdc.toFixed(2),
      dailyPaperPnlUsdc: dailyPaperPnlUsdc.toFixed(2),
      consecutiveLosses,
    });
    return;
  }

  // Fall back to yesterday's file — restore open positions only, reset daily stats
  const yesterdayData = tryLoadFile(yesterday);
  if (yesterdayData && (yesterdayData.open?.length ?? 0) > 0) {
    let strippedNoopExits = 0;
    for (const p of yesterdayData.open) {
      strippedNoopExits += stripNoopExits(p);
      openPositions.set(p.id, p);
    }
    // Do NOT restore yesterday's dailyPnlUsdc/consecutiveLosses — start fresh for today
    dailyStartEquity = 0;
    dailyPnlUsdc = 0;
    dailyPaperPnlUsdc = 0;
    consecutiveLosses = 0;
    lastLossTime = 0;
    dailyStatsDateUtc = today;
    log.warn('Position history loaded from yesterday (today file absent/empty)', {
      openRestored: openPositions.size,
      strippedNoopExits,
      date: yesterday,
    });
  }
}
