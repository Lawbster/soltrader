import { config, createLogger, getPublicKey } from './utils';
import { TokenMonitor, trackToken, snapshotAll, saveSnapshots, getStats, pruneOldTokens, TokenLaunch, loadWatchlist, WatchlistEntry } from './monitor';
import {
  fetchTokenData, fetchPoolLiquidity, getIndicatorSnapshot,
  subscribeToTokenTrades, unsubscribeFromToken,
  getTradeWindow, getActiveSubscriptionCount,
} from './analysis';
import {
  loadStrategyConfig, evaluateEntry,
  initMetrics, saveMetrics, printMetricsSummary, getAggregateMetrics,
} from './strategy';
import {
  initPortfolio,
  getPortfolioState,
  openPosition,
  updatePositions,
  hasOpenPosition,
  savePositionHistory,
} from './execution';
import { startDashboard, stopDashboard, updateDashboardState } from './dashboard';

const log = createLogger('main');

const SNAPSHOT_INTERVAL_MS = 60_000;
const SAVE_INTERVAL_MS = 5 * 60_000;
const ANALYSIS_INTERVAL_MS = 30_000;
const POSITION_UPDATE_INTERVAL_MS = 5_000;
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

async function analyzeCandidate(mint: string, launch: TokenLaunch) {
  const strategyCfg = loadStrategyConfig();
  const portfolio = getPortfolioState();

  if (hasOpenPosition(mint)) return;

  const tokenData = await fetchTokenData(mint, launch.detectedAt);
  if (!tokenData) return;

  // Check age window (skip for watchlist)
  const isWatchlist = launch.source === 'watchlist';
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

  // Indicators (RSI / Connors RSI)
  const indicatorsCfg = strategyCfg.entry.indicators;
  const indicators = indicatorsCfg?.enabled
    ? getIndicatorSnapshot(mint, {
      intervalMinutes: indicatorsCfg.candleIntervalMinutes,
      lookbackMinutes: indicatorsCfg.candleLookbackMinutes,
      rsiPeriod: indicatorsCfg.rsi.period,
      connorsRsiPeriod: indicatorsCfg.connors.rsiPeriod,
      connorsStreakRsiPeriod: indicatorsCfg.connors.streakRsiPeriod,
      connorsPercentRankPeriod: indicatorsCfg.connors.percentRankPeriod,
    })
    : undefined;

  // Compute 5m volume in USD
  const solPrice = tokenData.priceUsd / (tokenData.priceSol || 1);
  tokenData.volume5mUsd = (window.buyVolumeSol + window.sellVolumeSol) * solPrice;

  // Evaluate entry (now with LP change data)
  const signal = evaluateEntry(tokenData, window, portfolio, lpChange10mPct, indicators, isWatchlist);

  if (signal.passed) {
    log.info('ENTRY SIGNAL', {
      mint,
      score: signal.scoreResult ? Math.round(signal.scoreResult.total) : 0,
      sizeSol: signal.positionSizeSol.toFixed(4),
      mcap: Math.round(tokenData.mcapUsd),
      liq: Math.round(tokenData.liquidityUsd),
      lpChange10m: lpChange10mPct?.toFixed(1),
    });

    const slippageBps = strategyCfg.entry.maxSlippagePct * 100;
    await openPosition(mint, signal.positionSizeSol, slippageBps);
  }
}

// Round-robin index so we cycle through all candidates over time
let analysisOffset = 0;
const MAX_CANDIDATES_PER_CYCLE = 3;

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

  await initPortfolio();
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
    subscribeToTokenTrades(launch.mint, launch.poolAddress);
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

  if (useLaunches) {
    await monitor.start();
  } else {
    log.info('Launch monitoring disabled (watchlist-only mode)');
  }

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

  const snapshotTimer = setInterval(async () => {
    try {
      await snapshotAll();
    } catch (err) {
      log.error('Snapshot cycle failed', err);
    }
  }, SNAPSHOT_INTERVAL_MS);

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
      const portfolio = getPortfolioState();
      const stats = getStats();
      const metrics = getAggregateMetrics();
      log.info('Status', {
        ...stats,
        pendingCandidates: pendingTokens.size,
        tradeSubscriptions: getActiveSubscriptionCount(),
        openPositions: portfolio.openPositions,
        equitySol: portfolio.equitySol.toFixed(4),
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
    clearInterval(analysisTimer);
    clearInterval(positionTimer);
    clearInterval(snapshotTimer);
    clearInterval(cleanupTimer);
    clearInterval(saveTimer);
    saveSnapshots();
    savePositionHistory();
    saveMetrics();
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
