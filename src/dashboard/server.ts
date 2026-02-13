import http from 'http';
import { createLogger } from '../utils';
import { getAggregateMetrics, getTradeMetrics, loadStrategyConfig } from '../strategy';
import { getPortfolioState, getOpenPositions, getClosedPositions } from '../execution';
import {
  getActiveSubscriptionCount, getIndicatorSnapshot, getPriceHistoryCount,
  buildCloseSeriesFromPrices, fetchTokenPrice,
} from '../analysis';
import { loadWatchlist } from '../monitor';
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
    const portfolio = getPortfolioState();
    const openPositions = Array.from(getOpenPositions().values()).map(p => ({
      id: p.id,
      mint: p.mint,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      pnlPct: p.currentPnlPct,
      remainingPct: p.remainingPct,
      holdTimeMins: Math.round((Date.now() - p.entryTime) / 60_000),
      tp1Hit: p.tp1Hit,
      tp2Hit: p.tp2Hit,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      portfolio,
      openPositions,
      closedCount: getClosedPositions().length,
      tradeSubscriptions: getActiveSubscriptionCount(),
      pendingCandidates: pendingTokenCount,
      timestamp: Date.now(),
    }));
    return;
  }

  if (url === '/api/equity-curve') {
    const trades = getTradeMetrics();
    let cumPnl = 0;
    const curve = trades.map(t => {
      cumPnl += t.pnlSol;
      return { time: t.exitTime, pnl: cumPnl, tradeId: t.id };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(curve));
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

async function handleSignals(res: http.ServerResponse) {
  try {
    const cfg = loadStrategyConfig();
    const indicatorsCfg = cfg.entry.indicators;
    const watchlist = loadWatchlist();
    const candlesNeeded = (indicatorsCfg?.connors?.percentRankPeriod || 100) + 1;

    const signals = await Promise.all(watchlist.map(async (entry) => {
      const mint = entry.mint;
      const pricePoints = getPriceHistoryCount(mint);

      let crsi: number | undefined;
      let rsi: number | undefined;
      let candleCount = 0;
      let source = 'none';

      if (indicatorsCfg?.enabled) {
        const snap = getIndicatorSnapshot(mint, {
          intervalMinutes: indicatorsCfg.candleIntervalMinutes,
          lookbackMinutes: indicatorsCfg.candleLookbackMinutes,
          rsiPeriod: indicatorsCfg.rsi.period,
          connorsRsiPeriod: indicatorsCfg.connors.rsiPeriod,
          connorsStreakRsiPeriod: indicatorsCfg.connors.streakRsiPeriod,
          connorsPercentRankPeriod: indicatorsCfg.connors.percentRankPeriod,
        });
        crsi = snap.connorsRsi;
        rsi = snap.rsi;
        candleCount = snap.candleCount;
        source = candleCount > 0 ? 'price-feed' : 'none';
      }

      // Get current price
      let priceUsd = 0;
      try {
        const p = await fetchTokenPrice(mint);
        priceUsd = p.priceUsd;
      } catch { /* ignore */ }

      return {
        mint,
        crsi,
        rsi,
        priceUsd,
        candleCount,
        candlesNeeded,
        pricePoints,
        source,
        ready: candleCount >= candlesNeeded,
        oversoldThreshold: indicatorsCfg?.connors?.oversold || 20,
      };
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(signals));
  } catch (err) {
    log.error('Failed to get signals', { error: err });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get signals' }));
  }
}

function handlePriceChart(res: http.ServerResponse, mint: string | null) {
  const watchlist = loadWatchlist();
  const targetMint = mint || watchlist[0]?.mint;

  if (!targetMint) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
    return;
  }

  const intervalMs = 60_000; // 1-minute candles
  const lookbackMs = 120 * 60_000; // 2 hours
  const closes = buildCloseSeriesFromPrices(targetMint, intervalMs, lookbackMs);

  // Build time series — each entry is 1 minute apart from now backwards
  const now = Date.now();
  const startTime = now - lookbackMs;
  const points = closes.map((price, i) => ({
    time: startTime + i * intervalMs,
    price,
  }));

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
