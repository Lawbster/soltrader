import { config, createLogger, getPublicKey } from './utils';
import { TokenMonitor, trackToken, snapshotAll, saveSnapshots, getStats, pruneOldTokens, TokenLaunch, loadWatchlist, WatchlistEntry } from './monitor';
import {
  fetchTokenData, fetchTokenPricesBatch, fetchPoolLiquidity, getTokenPriceCached, getIndicatorSnapshot,
  subscribeToTokenTrades, unsubscribeFromToken,
  getTradeWindow, getActiveSubscriptionCount,
  recordPrice, getPriceHistoryCount, getPriceHistory, loadPriceHistoryFrom,
} from './analysis';
import {
  loadStrategyConfig, evaluateEntry,
  initMetrics, saveMetrics, printMetricsSummary, getAggregateMetrics,
} from './strategy';
import { getLiveTokenStrategies, type TokenStrategy } from './strategy/live-strategy-map';
import { startRegimeRefresh, getTokenRegimeCached } from './strategy/regime-detector';
import { getTemplateMetadata } from './strategy/templates/catalog';
import { StrategyPlan } from './execution/types';
import type { IndicatorSnapshot } from './analysis/types';
import { logPricePoint, logSignal, exportCandles, savePriceHistory, loadPriceHistorySnapshot, loadPriceHistoryFromCandles } from './data';
import {
  initPortfolio,
  loadPositionHistory,
  getPortfolioState,
  openPosition,
  updatePositions,
  hasOpenPosition,
  savePositionHistory,
  checkSolReplenish,
} from './execution';
import { startDashboard, stopDashboard, updateDashboardState } from './dashboard';

const log = createLogger('main');

const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const SAVE_INTERVAL_MS = 5 * 60_000;
const ANALYSIS_INTERVAL_MS = 60_000;
const POSITION_UPDATE_INTERVAL_MS = 15_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const TEN_MINUTES_MS = 10 * 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const MAX_PENDING_TOKENS = 500;

// Tokens waiting for their age window before analysis
const pendingTokens = new Map<string, TokenLaunch>();

// Track LP snapshots per token for LP change calculation at entry
const lpSnapshots = new Map<string, { timestamp: number; liquidityUsd: number }[]>();

function getLpChange10m(mint: string, currentLiq: number): number | undefined {
  const snapshots = lpSnapshots.get(mint);
  if (!snapshots || snapshots.length === 0) return undefined;

  // Find snapshot ~10 minutes ago
  const target = Date.now() - TEN_MINUTES_MS;
  const old = snapshots.find(s => s.timestamp <= target);
  if (!old || old.liquidityUsd <= 0) return undefined;

  return ((currentLiq - old.liquidityUsd) / old.liquidityUsd) * 100;
}

function recordLpSnapshot(mint: string, liquidityUsd: number) {
  let snapshots = lpSnapshots.get(mint);
  if (!snapshots) {
    snapshots = [];
    lpSnapshots.set(mint, snapshots);
  }
  snapshots.push({ timestamp: Date.now(), liquidityUsd });

  // Keep last 15 minutes only
  const cutoff = Date.now() - 15 * 60_000;
  const pruneIdx = snapshots.findIndex(s => s.timestamp >= cutoff);
  if (pruneIdx > 0) snapshots.splice(0, pruneIdx);
}

async function cleanupToken(mint: string) {
  pendingTokens.delete(mint);
  lpSnapshots.delete(mint);
  updateDashboardState(pendingTokens.size);
  await unsubscribeFromToken(mint);
}

async function prunePendingTokens(maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [mint, launch] of pendingTokens) {
    if (launch.source === 'watchlist') continue;
    if (launch.detectedAt < cutoff) {
      await cleanupToken(mint);
      pruned++;
    }
  }
  return pruned;
}

// Route-eval de-dup: ensures each timeframe route evaluates once per candle boundary.
const lastRouteEvalByCandle = new Map<string, number>();

function resolveRouteTimeframeMinutes(route: TokenStrategy, defaultMinutes: number): number {
  if (Number.isFinite(route.timeframeMinutes) && (route.timeframeMinutes as number) > 0) {
    return Math.max(1, Math.round(route.timeframeMinutes as number));
  }
  return Math.max(1, Math.round(defaultMinutes));
}

function shouldEvaluateRouteNow(
  mint: string,
  route: TokenStrategy,
  defaultTimeframeMinutes: number,
  nowMs: number,
): { evaluate: boolean; timeframeMinutes: number } {
  const timeframeMinutes = resolveRouteTimeframeMinutes(route, defaultTimeframeMinutes);
  const candleMs = timeframeMinutes * 60_000;
  const candleTs = Math.floor(nowMs / candleMs) * candleMs;
  const routeKey = `${mint}:${route.routeId ?? route.templateId}:${timeframeMinutes}`;
  const prev = lastRouteEvalByCandle.get(routeKey) ?? 0;
  if (candleTs <= prev) {
    return { evaluate: false, timeframeMinutes };
  }
  lastRouteEvalByCandle.set(routeKey, candleTs);
  return { evaluate: true, timeframeMinutes };
}

function compareRouteCandidates(
  a: { route: TokenStrategy; score: number; sizeUsdc: number },
  b: { route: TokenStrategy; score: number; sizeUsdc: number },
): number {
  const pa = a.route.priority ?? 0;
  const pb = b.route.priority ?? 0;
  if (pa !== pb) return pb - pa;
  if (a.score !== b.score) return b.score - a.score;
  const ta = a.route.timeframeMinutes ?? Number.MAX_SAFE_INTEGER;
  const tb = b.route.timeframeMinutes ?? Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  if (a.sizeUsdc !== b.sizeUsdc) return b.sizeUsdc - a.sizeUsdc;
  return (a.route.routeId ?? '').localeCompare(b.route.routeId ?? '');
}

async function analyzeCandidate(mint: string, launch: TokenLaunch) {
  const isWatchlist = launch.source === 'watchlist';

  // Per-token strategy gate: watchlist tokens must have at least one active route.
  const regimeState = getTokenRegimeCached(mint);
  const regime = regimeState?.confirmed ?? 'sideways';
  const tokenStrategies = getLiveTokenStrategies(mint, regime);
  if (isWatchlist && tokenStrategies.length === 0) return;

  const strategyCfg = loadStrategyConfig();
  const portfolio = getPortfolioState();

  if (hasOpenPosition(mint)) return;

  const tokenData = await fetchTokenData(mint, launch.detectedAt);
  if (!tokenData) return;

  // Check age window (skip for watchlist)
  if (!isWatchlist) {
    if (tokenData.tokenAgeMins < strategyCfg.universe.tokenAgeMinMinutes) return;
    if (tokenData.tokenAgeMins > strategyCfg.universe.tokenAgeMaxMinutes) {
      await cleanupToken(mint);
      log.debug('Token aged out, cleaned up', { mint, ageMins: Math.round(tokenData.tokenAgeMins) });
      return;
    }
  }

  // Enrich with liquidity and track LP over time
  tokenData.liquidityUsd = await fetchPoolLiquidity(mint);
  recordLpSnapshot(mint, tokenData.liquidityUsd);
  const lpChange10mPct = getLpChange10m(mint, tokenData.liquidityUsd);

  // Get 5-minute trade window
  const window = getTradeWindow(mint, FIVE_MINUTES_MS);

  const indicatorsCfg = strategyCfg.entry.indicators;

  // Compute 5m volume in USD
  const solPrice = tokenData.priceUsd / (tokenData.priceSol || 1);
  tokenData.volume5mUsd = (window.buyVolumeSol + window.sellVolumeSol) * solPrice;

  const totalTrades = getAggregateMetrics().totalTrades;
  const routeCandidates: Array<{
    route: TokenStrategy;
    signal: ReturnType<typeof evaluateEntry>;
    indicators?: IndicatorSnapshot;
    timeframeMinutes: number;
  }> = [];

  const skippedByBoundary: string[] = [];
  const skippedByWarmup: string[] = [];
  const indicatorCache = new Map<string, IndicatorSnapshot>();
  const defaultTimeframeMinutes = indicatorsCfg?.candleIntervalMinutes ?? 1;
  const nowMs = Date.now();

  for (const route of tokenStrategies) {
    const evalGate = shouldEvaluateRouteNow(mint, route, defaultTimeframeMinutes, nowMs);
    if (!evalGate.evaluate) {
      skippedByBoundary.push(`${route.routeId ?? route.templateId}@${evalGate.timeframeMinutes}m`);
      continue;
    }

    let indicators: IndicatorSnapshot | undefined;
    if (indicatorsCfg?.enabled) {
      const rsiPeriod = route.indicator?.rsiPeriod ?? indicatorsCfg.rsi.period;
      const connorsRsiPeriod = route.indicator?.kind === 'rsi'
        ? rsiPeriod
        : (route.indicator?.rsiPeriod ?? indicatorsCfg.connors.rsiPeriod);
      const connorsStreakRsiPeriod = route.indicator?.streakRsiPeriod ?? indicatorsCfg.connors.streakRsiPeriod;
      const connorsPercentRankPeriod = route.indicator?.kind === 'rsi'
        ? (rsiPeriod + 1)
        : (route.indicator?.percentRankPeriod ?? indicatorsCfg.connors.percentRankPeriod);
      const intervalMinutes = evalGate.timeframeMinutes;
      const requiredHistory = getTemplateMetadata(route.templateId).requiredHistory;
      const lookbackMinutes = Math.max(
        indicatorsCfg.candleLookbackMinutes,
        intervalMinutes * (requiredHistory + 10)
      );
      const cacheKey = [
        intervalMinutes,
        lookbackMinutes,
        rsiPeriod,
        connorsRsiPeriod,
        connorsStreakRsiPeriod,
        connorsPercentRankPeriod,
      ].join('|');

      const cachedIndicators = indicatorCache.get(cacheKey);
      if (cachedIndicators) {
        indicators = cachedIndicators;
      } else {
        indicators = getIndicatorSnapshot(mint, {
          intervalMinutes,
          lookbackMinutes,
          rsiPeriod,
          connorsRsiPeriod,
          connorsStreakRsiPeriod,
          connorsPercentRankPeriod,
        });
        indicatorCache.set(cacheKey, indicators);
      }

      if ((indicators?.candleCount ?? 0) < requiredHistory) {
        skippedByWarmup.push(
          `${route.routeId ?? route.templateId}@${intervalMinutes}m ${indicators?.candleCount ?? 0}/${requiredHistory}`
        );
        continue;
      }
    }

    const signal = evaluateEntry(
      tokenData,
      window,
      portfolio,
      lpChange10mPct,
      indicators,
      isWatchlist,
      totalTrades,
      route,
    );

    routeCandidates.push({
      route,
      signal,
      indicators,
      timeframeMinutes: evalGate.timeframeMinutes,
    });
  }

  if (routeCandidates.length === 0) {
    if (skippedByBoundary.length > 0 || skippedByWarmup.length > 0) {
      const reasons: string[] = [];
      if (skippedByBoundary.length > 0) {
        reasons.push(`waiting candle close (${skippedByBoundary.join(', ')})`);
      }
      if (skippedByWarmup.length > 0) {
        reasons.push(`warmup (${skippedByWarmup.join(', ')})`);
      }
      logSignal({
        mint,
        crsi: undefined,
        rsi: undefined,
        source: 'none',
        candleCount: 0,
        entryDecision: false,
        rejectReason: `route-window: ${reasons.join(' | ')}`,
        liquidityUsd: tokenData.liquidityUsd,
        effectiveMaxUsdc: 0,
      });
    }
    return;
  }

  const passed = routeCandidates
    .filter(c => c.signal.passed)
    .sort((a, b) => compareRouteCandidates(
      { route: a.route, score: a.signal.scoreResult?.total ?? 0, sizeUsdc: a.signal.positionSizeUsdc },
      { route: b.route, score: b.signal.scoreResult?.total ?? 0, sizeUsdc: b.signal.positionSizeUsdc },
    ));

  const topRejected = routeCandidates
    .filter(c => !c.signal.passed)
    .sort((a, b) => compareRouteCandidates(
      { route: a.route, score: a.signal.scoreResult?.total ?? 0, sizeUsdc: a.signal.positionSizeUsdc },
      { route: b.route, score: b.signal.scoreResult?.total ?? 0, sizeUsdc: b.signal.positionSizeUsdc },
    ))[0];

  if (passed.length === 0) {
    const rejectIndicators = topRejected?.indicators;
    const rejectRoute = topRejected?.route;
    const rejectSignal = topRejected?.signal;
    logSignal({
      mint,
      crsi: rejectIndicators?.connorsRsi,
      rsi: rejectIndicators?.rsi,
      source: rejectIndicators?.candleCount ? 'price-feed' : 'none',
      candleCount: rejectIndicators?.candleCount ?? 0,
      entryDecision: false,
      rejectReason: rejectSignal
        ? `route:${rejectRoute?.routeId ?? rejectRoute?.templateId}@${topRejected?.timeframeMinutes}m ${rejectSignal.reason || rejectSignal.filterResult?.reason || ''}`
        : 'no-route-passed',
      liquidityUsd: tokenData.liquidityUsd,
      effectiveMaxUsdc: 0,
    });
    return;
  }

  const winner = passed[0];
  const winnerRoute = winner.route;
  const winnerSignal = winner.signal;
  const winnerIndicators = winner.indicators;

  if (passed.length > 1) {
    log.info('Route arbitration', {
      mint,
      regime,
      winner: `${winnerRoute.routeId ?? winnerRoute.templateId}@${winner.timeframeMinutes}m`,
      candidates: passed.map(c => ({
        route: c.route.routeId ?? c.route.templateId,
        timeframeMinutes: c.timeframeMinutes,
        priority: c.route.priority ?? 0,
        score: Math.round(c.signal.scoreResult?.total ?? 0),
        sizeUsdc: Number(c.signal.positionSizeUsdc.toFixed(2)),
      })),
    });
  }

  logSignal({
    mint,
    crsi: winnerIndicators?.connorsRsi,
    rsi: winnerIndicators?.rsi,
    source: winnerIndicators?.candleCount ? 'price-feed' : 'none',
    candleCount: winnerIndicators?.candleCount ?? 0,
    entryDecision: true,
    rejectReason: '',
    liquidityUsd: tokenData.liquidityUsd,
    effectiveMaxUsdc: winnerSignal.positionSizeUsdc,
  });

  log.info('ENTRY SIGNAL', {
    mint,
    label: winnerRoute.label,
    regime,
    routeId: winnerRoute.routeId ?? winnerRoute.templateId,
    templateId: winnerRoute.templateId,
    timeframeMinutes: winner.timeframeMinutes,
    priority: winnerRoute.priority ?? 0,
    score: winnerSignal.scoreResult ? Math.round(winnerSignal.scoreResult.total) : 0,
    sizeUsdc: winnerSignal.positionSizeUsdc.toFixed(2),
    mcap: Math.round(tokenData.mcapUsd),
    liq: Math.round(tokenData.liquidityUsd),
    lpChange10m: lpChange10mPct?.toFixed(1),
  });

  const slippageBps = strategyCfg.entry.maxSlippagePct * 100;
  const strategyPlan: StrategyPlan = {
    kind: (winnerRoute.indicator?.kind ?? 'rsi') as 'rsi' | 'crsi',
    entry: winnerRoute.params.entry ?? 0,
    exit: winnerRoute.params.exit ?? 100,
    sl: winnerRoute.sl,
    tp: winnerRoute.tp,
    templateId: winnerRoute.templateId,
    templateParams: winnerRoute.params,
    exitMode: winnerRoute.exitMode,
    routeId: winnerRoute.routeId,
    timeframeMinutes: winner.timeframeMinutes,
    priority: winnerRoute.priority,
    indicator: winnerRoute.indicator,
  };

  // SHADOW_TEMPLATE=1: log route winner without executing
  const shadowMode = process.env.SHADOW_TEMPLATE === '1';
  if (shadowMode) {
    log.info('SHADOW_TEMPLATE: entry suppressed', {
      mint,
      label: winnerRoute.label,
      routeId: winnerRoute.routeId ?? winnerRoute.templateId,
      templateId: winnerRoute.templateId,
      timeframeMinutes: winner.timeframeMinutes,
      priority: winnerRoute.priority ?? 0,
      exitMode: winnerRoute.exitMode,
      regime,
      sizeUsdc: winnerSignal.positionSizeUsdc.toFixed(2),
    });
    return;
  }

  const pos = await openPosition(mint, winnerSignal.positionSizeUsdc, slippageBps, strategyPlan);
  if (!pos) {
    log.warn('Position not opened despite entry signal', { mint });
  }
}

// Round-robin index so we cycle through all candidates over time
let analysisOffset = 0;
const MAX_CANDIDATES_PER_CYCLE = 8;

async function analysisLoop() {
  const mints = Array.from(pendingTokens.keys());
  if (mints.length === 0) return;

  // Pick a batch starting from where we left off
  const batch: string[] = [];
  for (let i = 0; i < Math.min(MAX_CANDIDATES_PER_CYCLE, mints.length); i++) {
    const idx = (analysisOffset + i) % mints.length;
    batch.push(mints[idx]);
  }
  analysisOffset = (analysisOffset + MAX_CANDIDATES_PER_CYCLE) % Math.max(mints.length, 1);

  log.debug(`Analyzing ${batch.length}/${mints.length} candidates`);

  for (const mint of batch) {
    const launch = pendingTokens.get(mint);
    if (!launch) continue;

    try {
      await analyzeCandidate(mint, launch);
    } catch (err) {
      log.error('Analysis failed for token', { mint, error: err });
    }

    // 500ms pause between candidates to stay under rate limits
    await new Promise(r => setTimeout(r, 500));
  }
}

async function main() {
  const strategyCfg = loadStrategyConfig();
  const universeMode = config.universe.mode;
  const watchlist = loadWatchlist();
  log.info('Sol-Trader starting', {
    strategyVersion: strategyCfg.version,
    paperTrading: config.trading.paperTrading,
    maxPositions: strategyCfg.portfolio.maxConcurrentPositions,
    minScore: strategyCfg.entry.minScoreToTrade,
    universeMode,
    watchlistSize: watchlist.length,
  });

  const pubkey = getPublicKey();
  log.info('Bot wallet', { address: pubkey.toBase58() });

  // Restore price history from last shutdown (Phase 5: persistence)
  const snapshot = loadPriceHistorySnapshot();
  if (snapshot.size > 0) {
    loadPriceHistoryFrom(snapshot);
  }
  if (watchlist.length > 0) {
    const candleBootstrap = loadPriceHistoryFromCandles(watchlist.map(w => w.mint), 48);
    if (candleBootstrap.size > 0) {
      loadPriceHistoryFrom(candleBootstrap);
    }
  }

  await initPortfolio();
  loadPositionHistory();
  initMetrics();
  await startDashboard();

  function addTokenToUniverse(launch: TokenLaunch) {
    if (!launch.mint) return;
    if (pendingTokens.size >= MAX_PENDING_TOKENS) {
      log.warn('Pending token cap reached, skipping', { mint: launch.mint, cap: MAX_PENDING_TOKENS });
      return;
    }
    if (pendingTokens.has(launch.mint)) return;

    log.info('TOKEN TRACK', {
      mint: launch.mint,
      source: launch.source,
      sig: launch.signature,
    });

    trackToken(launch);
    pendingTokens.set(launch.mint, launch);
    updateDashboardState(pendingTokens.size);
    // Skip trade subscriptions for watchlist tokens — CRSI runs from price-feed,
    // all trade-window filters are at floor values, saves WSS + RPC budget
    if (launch.source !== 'watchlist') {
      subscribeToTokenTrades(launch.mint, launch.poolAddress);
    }
  }

  const monitor = new TokenMonitor();

  monitor.onTokenLaunch((launch) => {
    addTokenToUniverse(launch);
  });

  const useLaunches = universeMode === 'launches' || universeMode === 'both';
  const useWatchlist = universeMode === 'watchlist' || universeMode === 'both';

  if (useWatchlist && watchlist.length > 0) {
    for (const entry of watchlist) {
      const mint = entry.mint;
      const pool = entry.pool;
      addTokenToUniverse({
        mint,
        source: 'watchlist',
        signature: 'watchlist',
        detectedAt: Date.now(),
        poolAddress: pool,
      });
    }
  } else if (useWatchlist) {
    log.warn('Watchlist mode enabled but no mints found');
  }

  // Start background regime detection for watchlist tokens
  if (useWatchlist && watchlist.length > 0) {
    startRegimeRefresh(watchlist.map(e => e.mint));
  }

  if (useLaunches) {
    await monitor.start();
  } else {
    log.info('Launch monitoring disabled (watchlist-only mode)');
  }

  // Dedicated price poll for watchlist tokens — feeds CRSI candle builder
  // Runs every 30s so we get ~2 price points per 1-minute candle
  // Uses batch API: 1 Jupiter call for all mints instead of 12 individual calls
  const PRICE_POLL_INTERVAL_MS = 30_000;
  const pricePollTimer = setInterval(async () => {
    if (!useWatchlist || watchlist.length === 0) return;
    try {
      const pollStart = Date.now();
      const mints = watchlist.map(e => e.mint);
      await fetchTokenPricesBatch(mints);
      const pollLatencyMs = Date.now() - pollStart;

      // Read from cache only — never fall back to per-token API calls
      for (const entry of watchlist) {
        const { priceUsd, priceSol } = getTokenPriceCached(entry.mint);
        if (priceUsd > 0) {
          recordPrice(entry.mint, priceUsd);
          logPricePoint(entry.mint, priceUsd, priceSol, 'jupiter-batch', pollLatencyMs);
        }
      }
    } catch (err) {
      log.error('Batch price poll failed', { error: err });
    }
  }, PRICE_POLL_INTERVAL_MS);

  const analysisTimer = setInterval(async () => {
    try {
      await analysisLoop();
    } catch (err) {
      log.error('Analysis loop failed', err);
    }
  }, ANALYSIS_INTERVAL_MS);

  const positionTimer = setInterval(async () => {
    try {
      await updatePositions();
    } catch (err) {
      log.error('Position update failed', err);
    }
  }, POSITION_UPDATE_INTERVAL_MS);

  // SOL auto-replenish check every 5 minutes
  const solReplenishTimer = setInterval(async () => {
    try {
      await checkSolReplenish();
    } catch (err) {
      log.error('SOL replenish check failed', err);
    }
  }, SAVE_INTERVAL_MS);

  // Skip snapshots in watchlist-only mode — holder data disabled, supply is static
  const snapshotTimer = universeMode !== 'watchlist' ? setInterval(async () => {
    try {
      await snapshotAll();
    } catch (err) {
      log.error('Snapshot cycle failed', err);
    }
  }, SNAPSHOT_INTERVAL_MS) : null;

  const cleanupTimer = setInterval(async () => {
    try {
      const maxAgeMs = strategyCfg.universe.tokenAgeMaxMinutes * 60_000;
      const prunedWatched = pruneOldTokens(maxAgeMs);
      const prunedPending = await prunePendingTokens(maxAgeMs);
      if (prunedWatched > 0 || prunedPending > 0) {
        log.info('Token cleanup', { prunedWatched, prunedPending });
      }
    } catch (err) {
      log.error('Cleanup failed', err);
    }
  }, CLEANUP_INTERVAL_MS);

  const saveTimer = setInterval(() => {
    try {
      updateDashboardState(pendingTokens.size);
      saveSnapshots();
      savePositionHistory();
      saveMetrics();
      // Phase 4: export derived candles + Phase 5: persist price history
      const priceHist = getPriceHistory();
      savePriceHistory(priceHist);
      for (const entry of watchlist) {
        const pts = priceHist.get(entry.mint);
        if (pts && pts.length > 0) exportCandles(entry.mint, pts);
      }
      const portfolio = getPortfolioState();
      const stats = getStats();
      const metrics = getAggregateMetrics();
      // Include price history counts for watchlist tokens
      const priceHistoryCounts: Record<string, number> = {};
      for (const entry of watchlist) {
        priceHistoryCounts[entry.mint.slice(0, 8)] = getPriceHistoryCount(entry.mint);
      }
      log.info('Status', {
        ...stats,
        pendingCandidates: pendingTokens.size,
        tradeSubscriptions: getActiveSubscriptionCount(),
        priceHistory: priceHistoryCounts,
        openPositions: portfolio.openPositions,
        equityUsdc: portfolio.equityUsdc.toFixed(2),
        dailyPnl: portfolio.dailyPnlPct.toFixed(2) + '%',
        totalTrades: metrics.totalTrades,
        winRate: metrics.totalTrades > 0 ? metrics.winRate.toFixed(1) + '%' : 'N/A',
        profitFactor: metrics.totalTrades > 0 ? metrics.profitFactor.toFixed(2) : 'N/A',
      });
    } catch (err) {
      log.error('Save failed', err);
    }
  }, SAVE_INTERVAL_MS);

  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(pricePollTimer);
    clearInterval(analysisTimer);
    clearInterval(positionTimer);
    clearInterval(solReplenishTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    clearInterval(cleanupTimer);
    clearInterval(saveTimer);
    saveSnapshots();
    savePositionHistory();
    saveMetrics();
    savePriceHistory(getPriceHistory());
    printMetricsSummary();
    await stopDashboard();
    await monitor.stop();
    log.info('Goodbye');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('Sol-Trader is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  log.error('Fatal error', err);
  process.exit(1);
});
