import http from 'http';
import fs from 'fs';
import path from 'path';
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
import { getTemplateMetadata } from '../strategy/templates/catalog';
import { getJupiterMetrics } from '../execution/jupiter-client';
import { getDashboardHtml } from './page';

const log = createLogger('dashboard');

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3847');
const DATA_DIR = path.resolve(__dirname, '../../data');
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');

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

  if (url.startsWith('/api/signal-stats')) {
    handleSignalStats(res, url);
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
      const timeframeMinutes = tokenStrategy?.timeframeMinutes ?? indicatorsCfg.candleIntervalMinutes;
      const candlesNeeded = tokenStrategy?.templateId
        ? getTemplateMetadata(tokenStrategy.templateId).requiredHistory
        : (connorsPercentRankPeriod + 1);
      const lookbackMinutes = Math.max(
        indicatorsCfg.candleLookbackMinutes,
        timeframeMinutes * (candlesNeeded + 10)
      );

      let crsi: number | undefined;
      let rsi: number | undefined;
      let candleCount = 0;
      let source = 'none';

      if (indicatorsCfg?.enabled) {
        const snap = getIndicatorSnapshot(mint, {
          intervalMinutes: timeframeMinutes,
          lookbackMinutes,
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
        timeframeMinutes,
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

type SignalLogRow = {
  ts?: number;
  mint?: string;
  source?: string;
  entryDecision?: boolean;
  rejectReason?: string;
};

function findLatestSignalFileName(): string | null {
  if (!fs.existsSync(SIGNALS_DIR)) return null;
  const files = fs.readdirSync(SIGNALS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  return files.length > 0 ? files[files.length - 1] : null;
}

function normalizeRejectReason(reason: string): string {
  const r = (reason || '').trim();
  if (!r) return 'unknown';

  if (r.startsWith('route-window:')) {
    if (r.includes('warmup')) return 'route-window:warmup';
    if (r.includes('waiting candle close')) return 'route-window:candle-boundary';
    return 'route-window:other';
  }

  const template = r.match(/template:([a-z0-9-]+)\s+signal=([a-z]+)/i);
  if (template) return `template:${template[1]} signal=${template[2]}`;

  if (r.startsWith('Score ')) return 'score-gate';
  if (r.includes('Re-entry lockout')) return 're-entry-lockout';
  if (r.includes('max positions')) return 'max-positions';
  if (r.includes('exceed max exposure')) return 'max-exposure';

  return r.length > 96 ? `${r.slice(0, 96)}...` : r;
}

function mapToSortedRows(
  counts: Map<string, number>,
  total: number,
  keyName: string,
): Array<Record<string, string | number>> {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({
      [keyName]: key,
      count,
      pct: total > 0 ? (count / total) * 100 : 0,
    }));
}

function parseSignalStats(filePath: string) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(line => line.trim().length > 0);

  const reasonCounts = new Map<string, number>();
  const reasonGroupCounts = new Map<string, number>();
  const routeRejectCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const byMint = new Map<string, { total: number; accepted: number; rejected: number }>();

  let totalSignals = 0;
  let acceptedSignals = 0;
  let rejectedSignals = 0;

  for (const line of lines) {
    let row: SignalLogRow;
    try {
      row = JSON.parse(line) as SignalLogRow;
    } catch {
      continue;
    }

    totalSignals += 1;
    const mint = row.mint || 'unknown';
    const source = row.source || 'unknown';
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);

    const mintStat = byMint.get(mint) || { total: 0, accepted: 0, rejected: 0 };
    mintStat.total += 1;

    if (row.entryDecision === true) {
      acceptedSignals += 1;
      mintStat.accepted += 1;
    } else {
      rejectedSignals += 1;
      mintStat.rejected += 1;

      const reasonRaw = (row.rejectReason || 'unknown').trim() || 'unknown';
      reasonCounts.set(reasonRaw, (reasonCounts.get(reasonRaw) || 0) + 1);

      const group = normalizeRejectReason(reasonRaw);
      reasonGroupCounts.set(group, (reasonGroupCounts.get(group) || 0) + 1);

      const routeMatch = reasonRaw.match(/route:([^\s]+)/);
      if (routeMatch) {
        const routeKey = routeMatch[1];
        routeRejectCounts.set(routeKey, (routeRejectCounts.get(routeKey) || 0) + 1);
      }
    }

    byMint.set(mint, mintStat);
  }

  const byMintRows = Array.from(byMint.entries())
    .map(([mint, stats]) => ({
      mint,
      total: stats.total,
      accepted: stats.accepted,
      rejected: stats.rejected,
      acceptanceRatePct: stats.total > 0 ? (stats.accepted / stats.total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    totalSignals,
    acceptedSignals,
    rejectedSignals,
    acceptanceRatePct: totalSignals > 0 ? (acceptedSignals / totalSignals) * 100 : 0,
    uniqueMints: byMint.size,
    uniqueRejectReasons: reasonCounts.size,
    sourceStats: mapToSortedRows(sourceCounts, totalSignals, 'source'),
    rejectReasonStats: mapToSortedRows(reasonCounts, rejectedSignals, 'reason'),
    rejectGroupStats: mapToSortedRows(reasonGroupCounts, rejectedSignals, 'group'),
    routeRejectStats: mapToSortedRows(routeRejectCounts, rejectedSignals, 'route'),
    byMintStats: byMintRows,
  };
}

function handleSignalStats(res: http.ServerResponse, url: string) {
  try {
    const params = new URL(url, 'http://localhost').searchParams;
    const requestedDate = params.get('date');
    const fileName = requestedDate ? `${requestedDate}.jsonl` : findLatestSignalFileName();

    if (!fileName) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        file: null,
        date: null,
        totalSignals: 0,
        acceptedSignals: 0,
        rejectedSignals: 0,
        acceptanceRatePct: 0,
        uniqueMints: 0,
        uniqueRejectReasons: 0,
        sourceStats: [],
        rejectReasonStats: [],
        rejectGroupStats: [],
        routeRejectStats: [],
        byMintStats: [],
      }));
      return;
    }

    const filePath = path.join(SIGNALS_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Signal file not found', file: fileName }));
      return;
    }

    const parsed = parseSignalStats(filePath);
    const stat = fs.statSync(filePath);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      file: fileName,
      date: fileName.replace('.jsonl', ''),
      updatedAt: stat.mtimeMs,
      ...parsed,
    }));
  } catch (err) {
    log.error('Failed to parse signal stats', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to parse signal stats' }));
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
