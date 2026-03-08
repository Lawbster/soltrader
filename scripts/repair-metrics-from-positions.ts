import fs from 'fs';
import path from 'path';
import { calculateTrackedPnlUsdc, summarizeTrackedExits } from '../src/execution/position-accounting';
import type { Position } from '../src/execution/types';

type TradeMetric = {
  id: string;
  mint: string;
  entryTime: number;
  exitTime: number;
  holdTimeMinutes: number;
  entryUsdc: number;
  exitUsdc: number;
  pnlUsdc: number;
  pnlPct: number;
  exitType: string;
  isPaper: boolean;
};

type MetricsFile = {
  savedAt?: string;
  startedAt?: number;
  executionAttempts?: number;
  executionFailures?: number;
  executionSkips?: number;
  skipReasonDistribution?: Record<string, number>;
  trades?: TradeMetric[];
  aggregate?: unknown;
};

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const METRICS_PATH = path.join(DATA_DIR, 'metrics.json');
const DRY_RUN = process.argv.includes('--dry-run');
const ADD_MISSING = process.argv.includes('--add-missing');

function loadLatestClosedPositions(): Map<string, Position> {
  const files = fs.readdirSync(DATA_DIR)
    .filter(name => /^positions-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();

  const latestById = new Map<string, Position>();
  for (const file of files) {
    const fullPath = path.join(DATA_DIR, file);
    const json = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as { closed?: Position[] };
    for (const position of json.closed ?? []) {
      latestById.set(position.id, position);
    }
  }
  return latestById;
}

function rebuildTradeMetric(metric: TradeMetric, position: Position): TradeMetric {
  const exitSummary = summarizeTrackedExits(position);
  const pnlUsdc = calculateTrackedPnlUsdc(position);
  const pnlPct = position.initialSizeUsdc > 0
    ? (pnlUsdc / position.initialSizeUsdc) * 100
    : 0;
  const lastExit = position.exits[position.exits.length - 1];
  const exitTime = lastExit?.timestamp ?? metric.exitTime;

  return {
    ...metric,
    mint: position.mint,
    entryTime: position.entryTime,
    exitTime,
    holdTimeMinutes: (exitTime - position.entryTime) / 60_000,
    entryUsdc: position.initialSizeUsdc,
    exitUsdc: exitSummary.trackedUsdcOut,
    pnlUsdc,
    pnlPct,
    exitType: position.closeReason || lastExit?.type || metric.exitType,
  };
}

function buildTradeMetricFromPosition(position: Position, isPaper: boolean): TradeMetric {
  const exitSummary = summarizeTrackedExits(position);
  const pnlUsdc = calculateTrackedPnlUsdc(position);
  const pnlPct = position.initialSizeUsdc > 0
    ? (pnlUsdc / position.initialSizeUsdc) * 100
    : 0;
  const lastExit = position.exits[position.exits.length - 1];
  const exitTime = lastExit?.timestamp ?? position.entryTime;

  return {
    id: position.id,
    mint: position.mint,
    entryTime: position.entryTime,
    exitTime,
    holdTimeMinutes: (exitTime - position.entryTime) / 60_000,
    entryUsdc: position.initialSizeUsdc,
    exitUsdc: exitSummary.trackedUsdcOut,
    pnlUsdc,
    pnlPct,
    exitType: position.closeReason || lastExit?.type || 'unknown',
    isPaper,
  };
}

function differs(a: TradeMetric, b: TradeMetric): boolean {
  return (
    Math.abs(a.exitUsdc - b.exitUsdc) > 1e-9 ||
    Math.abs(a.pnlUsdc - b.pnlUsdc) > 1e-9 ||
    Math.abs(a.pnlPct - b.pnlPct) > 1e-9 ||
    Math.abs(a.holdTimeMinutes - b.holdTimeMinutes) > 1e-9 ||
    a.exitType !== b.exitType
  );
}

function computeAggregate(metrics: MetricsFile, trades: TradeMetric[]) {
  const totalTrades = trades.length;
  const startedAt = metrics.startedAt ?? Date.now();
  const executionAttempts = metrics.executionAttempts ?? 0;
  const executionFailures = metrics.executionFailures ?? 0;
  const executionSkips = metrics.executionSkips ?? 0;
  const skipReasonDistribution = metrics.skipReasonDistribution ?? {};

  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      avgWinLossRatio: 0,
      profitFactor: 0,
      totalPnlUsdc: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      avgHoldTimeMinutes: 0,
      executionFailures,
      executionAttempts,
      executionFailureRate: 0,
      executionSkips,
      skipReasonDistribution,
      uptimeHours: (Date.now() - startedAt) / 3_600_000,
      startedAt,
      exitTypeDistribution: {},
    };
  }

  const wins = trades.filter(t => t.pnlUsdc > 0);
  const losses = trades.filter(t => t.pnlUsdc <= 0);
  const winRate = (wins.length / totalTrades) * 100;
  const avgWinPct = wins.length > 0
    ? wins.reduce((sum, t) => sum + t.pnlPct, 0) / wins.length
    : 0;
  const avgLossPct = losses.length > 0
    ? losses.reduce((sum, t) => sum + t.pnlPct, 0) / losses.length
    : 0;
  const avgWinLossRatio = avgLossPct !== 0
    ? Math.abs(avgWinPct / avgLossPct)
    : avgWinPct > 0 ? Infinity : 0;

  const totalWinUsdc = wins.reduce((sum, t) => sum + t.pnlUsdc, 0);
  const totalLossUsdc = Math.abs(losses.reduce((sum, t) => sum + t.pnlUsdc, 0));
  const profitFactor = totalLossUsdc > 0 ? totalWinUsdc / totalLossUsdc : totalWinUsdc > 0 ? Infinity : 0;
  const totalPnlUsdc = trades.reduce((sum, t) => sum + t.pnlUsdc, 0);

  let peak = 0;
  let maxDrawdownPct = 0;
  let cumulativePnl = 0;
  for (const trade of trades) {
    cumulativePnl += trade.pnlUsdc;
    if (cumulativePnl > peak) peak = cumulativePnl;
    const drawdown = peak > 0 ? ((peak - cumulativePnl) / peak) * 100 : 0;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
  }

  const returns = trades.map(t => t.pnlPct / 100);
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + Math.pow(value - meanReturn, 2), 0) / returns.length;
  const stdReturn = Math.sqrt(variance);
  const tradesPerDay = totalTrades / Math.max((Date.now() - startedAt) / 86_400_000, 1);
  const sharpeRatio = stdReturn > 0
    ? (meanReturn / stdReturn) * Math.sqrt(tradesPerDay * 252)
    : 0;
  const avgHoldTimeMinutes = trades.reduce((sum, t) => sum + t.holdTimeMinutes, 0) / totalTrades;
  const executionFailureRate = executionAttempts > 0
    ? (executionFailures / executionAttempts) * 100
    : 0;

  const exitTypeDistribution: Record<string, number> = {};
  for (const trade of trades) {
    exitTypeDistribution[trade.exitType] = (exitTypeDistribution[trade.exitType] || 0) + 1;
  }

  return {
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWinPct,
    avgLossPct,
    avgWinLossRatio,
    profitFactor,
    totalPnlUsdc,
    maxDrawdownPct,
    sharpeRatio,
    avgHoldTimeMinutes,
    executionFailures,
    executionAttempts,
    executionFailureRate,
    executionSkips,
    skipReasonDistribution,
    uptimeHours: (Date.now() - startedAt) / 3_600_000,
    startedAt,
    exitTypeDistribution,
  };
}

function main() {
  if (!fs.existsSync(METRICS_PATH)) {
    throw new Error(`metrics file not found: ${METRICS_PATH}`);
  }

  const metrics = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8')) as MetricsFile;
  const positionsById = loadLatestClosedPositions();
  const trades = metrics.trades ?? [];

  let matched = 0;
  let updated = 0;
  let orphanedRepairs = 0;
  let addedTrades = 0;

  const metricsStartedAt = metrics.startedAt ?? 0;
  const repairedTrades = trades
    .filter(trade => trade.exitTime >= metricsStartedAt)
    .map((trade) => {
    const position = positionsById.get(trade.id);
    if (!position) return trade;
    matched++;

    const exitSummary = summarizeTrackedExits(position);
    if (exitSummary.orphanedTokensSold > 0 || exitSummary.orphanedUsdcOut > 0) {
      orphanedRepairs++;
    }

    const rebuilt = rebuildTradeMetric(trade, position);
    if (differs(trade, rebuilt)) {
      updated++;
    }
    return rebuilt;
  });

  const knownTradeIds = new Set(repairedTrades.map(trade => trade.id));
  if (ADD_MISSING) {
    for (const position of positionsById.values()) {
      if (knownTradeIds.has(position.id)) continue;
      if ((position.status ?? 'open') !== 'closed') continue;
      const lastExit = position.exits[position.exits.length - 1];
      const exitTime = lastExit?.timestamp ?? position.entryTime;
      if (exitTime < metricsStartedAt) continue;
      repairedTrades.push(buildTradeMetricFromPosition(position, false));
      addedTrades++;
    }
  }

  const out: MetricsFile = {
    ...metrics,
    savedAt: new Date().toISOString(),
    trades: repairedTrades,
    aggregate: computeAggregate(metrics, repairedTrades),
  };

  if (!DRY_RUN) {
    fs.writeFileSync(METRICS_PATH, JSON.stringify(out, null, 2));
  }

  console.log(JSON.stringify({
    metricsPath: METRICS_PATH,
    dryRun: DRY_RUN,
    addMissing: ADD_MISSING,
    totalTrades: trades.length,
    matchedTrades: matched,
    updatedTrades: updated,
    addedTrades,
    orphanedRepairs,
  }, null, 2));
}

main();
