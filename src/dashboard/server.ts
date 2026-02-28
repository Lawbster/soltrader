import http from 'http';
import { createLogger, config } from '../utils';
import { getAggregateMetrics, getTradeMetrics, loadStrategyConfig } from '../strategy';
import { getPoolLiquidityCached, getTokenPriceCached } from '../analysis/token-data';
import { getPortfolioState, getOpenPositions, getClosedPositions, getLastQuotedImpact, getWalletBalances, SOL_MINT } from '../execution';
import {
  getActiveSubscriptionCount, getIndicatorSnapshot, getPriceHistoryCount,
} from '../analysis';
import { loadCandles } from '../backtest/data-loader';
import { loadWatchlist } from '../monitor';
import { getLiveTokenStrategy, isTokenMasterEnabled } from '../strategy/live-strategy-map';
import { getTokenRegimeCached } from '../strategy/regime-detector';
import { getJupiterMetrics } from '../execution/jupiter-client';
import { getDashboardHtml } from './page';

const log = createLogger('dashboard');

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3847');

let server: http.Server | null = null;
let pendingTokenCount = 0;

export function updateDashboardState(pending: number) {
  pendingTokenCount = pending;
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url || '/';

  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url === '/api/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAggregateMetrics()));
    return;
  }

  if (url === '/api/trades') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getTradeMetrics()));
    return;
  }

  if (url === '/api/status') {
    handleStatus(res).catch(err => {
      log.error('Status handler error', { error: err instanceof Error ? err.message : String(err) });
      if (!res.writableEnded) { res.writeHead(500); res.end('{"error":"Internal"}'); }
    });
    return;
  }

  // CRSI signal status for each watchlist token
  if (url === '/api/signals') {
    handleSignals(res);
    return;
  }

  // Price chart data for a watchlist token
  if (url.startsWith('/api/price-chart')) {
    const params = new URL(url, 'http://localhost').searchParams;
    const mint = params.get('mint');
    handlePriceChart(res, mint);
    return;
  }

  // Serve dashboard HTML
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

async function handleStatus(res: http.ServerResponse) {
  const portfolio = getPortfolioState();
  const openPositions = Array.from(getOpenPositions().values()).map(p => ({
    id: p.id,
    mint: p.mint,
    entryPrice: p.entryPrice,
    currentPrice: p.currentPrice,
    pnlPct: p.currentPnlPct,
    remainingPct: p.remainingPct,
    initialSizeUsdc: p.initialSizeUsdc,
    holdTimeMins: Math.round((Date.now() - p.entryTime) / 60_000),
    tp1Hit: p.tp1Hit,
    tp2Hit: p.tp2Hit,
  }));

  const walletBalances = await getWalletBalances();
  const solPriceResult = getTokenPriceCached(SOL_MINT);

  const universeMode = config.universe.mode;
  const tradeCapture = universeMode === 'watchlist' ? 'disabled' : 'active';

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    portfolio,
    openPositions,
    walletBalances,
    solPriceUsd: solPriceResult.priceUsd,
    closedCount: getClosedPositions().length,
    tradeSubscriptions: getActiveSubscriptionCount(),
    pendingCandidates: pendingTokenCount,
    tradeCapture,
    universeMode,
    isPaperTrading: config.trading.paperTrading,
    jupiterMetrics: getJupiterMetrics(),
    timestamp: Date.now(),
  }));
}

function handleSignals(res: http.ServerResponse) {
  try {
    const cfg = loadStrategyConfig();
    const indicatorsCfg = cfg.entry.indicators;
    const watchlist = loadWatchlist();
    const metrics = getAggregateMetrics();
    const portfolio = getPortfolioState();
    const signals = watchlist.map((entry) => {
      const mint = entry.mint;
      const pricePoints = getPriceHistoryCount(mint);

      const regimeState = getTokenRegimeCached(mint);
      const regime = regimeState?.confirmed ?? 'sideways';
      const masterEnabled = isTokenMasterEnabled(mint);
      const tokenStrategy = getLiveTokenStrategy(mint, regime);
      const rsiPeriod = tokenStrategy ? (tokenStrategy.indicator?.rsiPeriod ?? indicatorsCfg.rsi.period) : indicatorsCfg.rsi.period;
      const connorsPercentRankPeriod = tokenStrategy
        ? (tokenStrategy.indicator?.kind === 'rsi'
            ? rsiPeriod + 1
            : (tokenStrategy.indicator?.percentRankPeriod ?? indicatorsCfg.connors.percentRankPeriod))
        : indicatorsCfg.connors.percentRankPeriod;
      const candlesNeeded = connorsPercentRankPeriod + 1;

      let crsi: number | undefined;
      let rsi: number | undefined;
      let candleCount = 0;
      let source = 'none';

      if (indicatorsCfg?.enabled) {
        const snap = getIndicatorSnapshot(mint, {
          intervalMinutes: indicatorsCfg.candleIntervalMinutes,
          lookbackMinutes: indicatorsCfg.candleLookbackMinutes,
          rsiPeriod,
          connorsRsiPeriod: tokenStrategy ? rsiPeriod : indicatorsCfg.connors.rsiPeriod,
          connorsStreakRsiPeriod: tokenStrategy?.indicator?.streakRsiPeriod ?? indicatorsCfg.connors.streakRsiPeriod,
          connorsPercentRankPeriod,
        });
        crsi = snap.connorsRsi;
        rsi = snap.rsi;
        candleCount = snap.candleCount;
        source = candleCount > 0 ? 'price-feed' : 'none';
      }

      // Read from cache only — no live Jupiter API calls from dashboard
      const { priceUsd } = getTokenPriceCached(mint);
      const liquidityUsd = getPoolLiquidityCached(mint);

      // Compute effective max position size (USDC)
      const posCfg = cfg.position;
      const totalTrades = metrics.totalTrades;
      let maxFromLiquidity = Infinity;
      if (liquidityUsd > 0 && posCfg.liquidityCapPct > 0) {
        maxFromLiquidity = liquidityUsd * (posCfg.liquidityCapPct / 100);
      }
      let maxFromSampleGate = Infinity;
      if (totalTrades < posCfg.sampleSizeGateMinTrades) {
        maxFromSampleGate = posCfg.sampleSizeGateMaxUsdc;
      }
      const tokenCapUsdc = resolveTokenMaxPositionUsdc(
        tokenStrategy,
        portfolio.equityUsdc,
        posCfg.maxPositionUsdc
      );
      const effectiveMaxUsdc = Math.min(
        tokenCapUsdc, maxFromLiquidity, maxFromSampleGate
      );
      const effectiveMaxUsdcSafe = Number.isFinite(effectiveMaxUsdc) ? effectiveMaxUsdc : 0;

      const lastImpact = getLastQuotedImpact();
      const quotedImpact = lastImpact?.mint === mint ? lastImpact.impact : undefined;

      return {
        mint,
        label: entry.label,
        crsi,
        rsi,
        priceUsd,
        candleCount,
        candlesNeeded,
        pricePoints,
        source,
        ready: candleCount >= candlesNeeded,
        oversoldThreshold: tokenStrategy?.params.entry ?? indicatorsCfg?.connors?.oversold ?? 20,
        liquidityUsd,
        effectiveMaxUsdc: effectiveMaxUsdcSafe,
        maxEntryImpactPct: posCfg.maxEntryImpactPct,
        quotedImpact,
        totalTrades,
        sampleSizeGateMinTrades: posCfg.sampleSizeGateMinTrades,
        tokenMaxUsdc: tokenStrategy?.maxPositionUsdc ?? null,
        tokenMaxEquityPct: tokenStrategy?.maxPositionEquityPct ?? null,
        sl: tokenStrategy?.sl,
        tp: tokenStrategy?.tp,
        tier: tokenStrategy?.tier,
        indicatorKind: tokenStrategy?.indicator?.kind ?? 'crsi',
        templateId: tokenStrategy?.templateId ?? null,
        routeId: tokenStrategy?.routeId ?? null,
        timeframeMinutes: tokenStrategy?.timeframeMinutes ?? indicatorsCfg.candleIntervalMinutes,
        routePriority: tokenStrategy?.priority ?? null,
        strategyParams: tokenStrategy?.params ?? null,
        exitMode: tokenStrategy?.exitMode ?? null,
        trendRegime: regimeState?.confirmed ?? null,
        trendScore: regimeState?.trendScore ?? null,
        ret24h: regimeState?.ret24h ?? null,
        ret72h: regimeState?.ret72h ?? null,
        coverageHours: regimeState?.coverageHours ?? null,
        masterEnabled,
        regimeActive: tokenStrategy !== null,
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(signals));
  } catch (err) {
    log.error('Failed to get signals', { error: err });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get signals' }));
  }
}

function resolveTokenMaxPositionUsdc(
  tokenStrategy: ReturnType<typeof getLiveTokenStrategy>,
  equityUsdc: number,
  fallbackUsdc: number
): number {
  const fallbackCap = fallbackUsdc > 0 ? fallbackUsdc : Infinity;
  if (!tokenStrategy) return fallbackCap;

  let cap = Infinity;
  if (typeof tokenStrategy.maxPositionEquityPct === 'number' && tokenStrategy.maxPositionEquityPct > 0) {
    cap = Math.min(cap, equityUsdc * (tokenStrategy.maxPositionEquityPct / 100));
  }
  if (typeof tokenStrategy.maxPositionUsdc === 'number' && tokenStrategy.maxPositionUsdc > 0) {
    cap = Math.min(cap, tokenStrategy.maxPositionUsdc);
  }

  return cap === Infinity ? fallbackCap : cap;
}

function handlePriceChart(res: http.ServerResponse, mint: string | null) {
  const watchlist = loadWatchlist();
  const targetMint = mint || watchlist[0]?.mint;

  if (!targetMint) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
    return;
  }

  const now = Date.now();
  const cutoff = now - 24 * 60 * 60_000;

  function toDateStr(ts: number) {
    return new Date(ts).toISOString().split('T')[0];
  }
  const yesterday = toDateStr(cutoff);
  const today = toDateStr(now);

  const candles = loadCandles(targetMint, yesterday, today)
    .filter(c => c.timestamp >= cutoff);

  const points = candles.map(c => ({ time: c.timestamp, price: c.close }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(points));
}

export function startDashboard(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer(handleRequest);
    server.listen(DASHBOARD_PORT, () => {
      log.info(`Dashboard running at http://localhost:${DASHBOARD_PORT}`);
      resolve();
    });
  });
}

export function stopDashboard(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}
