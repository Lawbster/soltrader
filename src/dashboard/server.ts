import http from 'http';
import { createLogger } from '../utils';
import { getAggregateMetrics, getTradeMetrics, loadStrategyConfig } from '../strategy';
import { getPortfolioState, getOpenPositions, getClosedPositions } from '../execution';
import { getActiveSubscriptionCount } from '../analysis';
import { getDashboardHtml } from './page';

const log = createLogger('dashboard');

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3847');

let server: http.Server | null = null;
let pendingTokenCount = 0;

export function updateDashboardState(pending: number) {
  pendingTokenCount = pending;
}

function getGatesStatus() {
  const m = getAggregateMetrics();
  const cfg = loadStrategyConfig();

  return {
    minTrades: { required: 120, current: m.totalTrades, passed: m.totalTrades >= 120 },
    profitFactor: { required: 1.25, current: m.profitFactor, passed: m.profitFactor >= 1.25 },
    winRate: { required: 50, current: m.winRate, passed: m.winRate >= 50 },
    avgWinLoss: { required: 1.35, current: m.avgWinLossRatio, passed: m.avgWinLossRatio >= 1.35 },
    maxDrawdown: { required: 10, current: m.maxDrawdownPct, passed: m.maxDrawdownPct <= 10 },
    execFailRate: { required: 3, current: m.executionFailureRate, passed: m.executionFailureRate <= 3 },
  };
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

  if (url === '/api/gates') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getGatesStatus()));
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

  // Serve dashboard HTML
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
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
