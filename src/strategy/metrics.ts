import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils';
import { Position } from '../execution/types';

const log = createLogger('metrics');
const DATA_DIR = path.resolve(__dirname, '../../data');

export interface TradeMetric {
  id: string;
  mint: string;
  entryTime: number;
  exitTime: number;
  holdTimeMinutes: number;
  entrySol: number;
  exitSol: number;
  pnlSol: number;
  pnlPct: number;
  exitType: string;
  isPaper: boolean;
}

export interface AggregateMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  avgWinLossRatio: number;
  profitFactor: number;
  totalPnlSol: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgHoldTimeMinutes: number;
  executionFailures: number;
  executionAttempts: number;
  executionFailureRate: number;
  uptimeHours: number;
  startedAt: number;
  exitTypeDistribution: Record<string, number>;
}

// Running state
const tradeMetrics: TradeMetric[] = [];
let executionAttempts = 0;
let executionFailures = 0;
let startedAt = 0;

export function initMetrics() {
  startedAt = Date.now();
  // Try to load existing metrics from disk
  const filePath = path.join(DATA_DIR, 'metrics.json');
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(raw.trades)) {
        tradeMetrics.push(...raw.trades);
      }
      executionAttempts = raw.executionAttempts || 0;
      executionFailures = raw.executionFailures || 0;
      startedAt = raw.startedAt || startedAt;
      log.info('Loaded existing metrics', { trades: tradeMetrics.length });
    }
  } catch {
    log.debug('No existing metrics file, starting fresh');
  }
}

export function recordExecutionAttempt(success: boolean) {
  executionAttempts++;
  if (!success) executionFailures++;
}

export function recordClosedPosition(position: Position, isPaper: boolean) {
  const totalSolOut = position.exits.reduce((sum, e) => sum + e.solReceived, 0);
  const pnlSol = totalSolOut - position.initialSizeSol;
  const pnlPct = position.initialSizeSol > 0
    ? (pnlSol / position.initialSizeSol) * 100
    : 0;

  const lastExit = position.exits[position.exits.length - 1];
  const exitTime = lastExit?.timestamp || Date.now();
  const holdTimeMinutes = (exitTime - position.entryTime) / 60_000;

  const exitType = position.closeReason || lastExit?.type || 'unknown';

  const metric: TradeMetric = {
    id: position.id,
    mint: position.mint,
    entryTime: position.entryTime,
    exitTime,
    holdTimeMinutes,
    entrySol: position.initialSizeSol,
    exitSol: totalSolOut,
    pnlSol,
    pnlPct,
    exitType,
    isPaper,
  };

  tradeMetrics.push(metric);

  log.info('Trade metric recorded', {
    id: position.id,
    mint: position.mint,
    pnlPct: pnlPct.toFixed(1),
    pnlSol: pnlSol.toFixed(4),
    exitType,
    holdMins: Math.round(holdTimeMinutes),
    totalTrades: tradeMetrics.length,
  });
}

export function getAggregateMetrics(): AggregateMetrics {
  const trades = tradeMetrics;
  const totalTrades = trades.length;

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
      totalPnlSol: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      avgHoldTimeMinutes: 0,
      executionFailures,
      executionAttempts,
      executionFailureRate: 0,
      uptimeHours: (Date.now() - startedAt) / 3_600_000,
      startedAt,
      exitTypeDistribution: {},
    };
  }

  const wins = trades.filter(t => t.pnlSol > 0);
  const losses = trades.filter(t => t.pnlSol <= 0);

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

  const totalWinSol = wins.reduce((sum, t) => sum + t.pnlSol, 0);
  const totalLossSol = Math.abs(losses.reduce((sum, t) => sum + t.pnlSol, 0));
  const profitFactor = totalLossSol > 0 ? totalWinSol / totalLossSol : totalWinSol > 0 ? Infinity : 0;

  const totalPnlSol = trades.reduce((sum, t) => sum + t.pnlSol, 0);

  // Max drawdown: track cumulative PnL curve
  let peak = 0;
  let maxDrawdown = 0;
  let cumPnl = 0;
  for (const t of trades) {
    cumPnl += t.pnlSol;
    if (cumPnl > peak) peak = cumPnl;
    const drawdown = peak > 0 ? ((peak - cumPnl) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Sharpe ratio (annualized, assuming ~252 trading days)
  // Using per-trade returns
  const returns = trades.map(t => t.pnlPct / 100);
  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
  const stdReturn = Math.sqrt(variance);
  const tradesPerDay = totalTrades / Math.max((Date.now() - startedAt) / 86_400_000, 1);
  const sharpeRatio = stdReturn > 0
    ? (meanReturn / stdReturn) * Math.sqrt(tradesPerDay * 252)
    : 0;

  const avgHoldTimeMinutes = trades.reduce((sum, t) => sum + t.holdTimeMinutes, 0) / totalTrades;

  // Exit type distribution
  const exitTypeDistribution: Record<string, number> = {};
  for (const t of trades) {
    exitTypeDistribution[t.exitType] = (exitTypeDistribution[t.exitType] || 0) + 1;
  }

  const executionFailureRate = executionAttempts > 0
    ? (executionFailures / executionAttempts) * 100
    : 0;

  return {
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWinPct,
    avgLossPct,
    avgWinLossRatio,
    profitFactor,
    totalPnlSol,
    maxDrawdownPct: maxDrawdown,
    sharpeRatio,
    avgHoldTimeMinutes,
    executionFailures,
    executionAttempts,
    executionFailureRate,
    uptimeHours: (Date.now() - startedAt) / 3_600_000,
    startedAt,
    exitTypeDistribution,
  };
}

export function saveMetrics() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const data = {
    savedAt: new Date().toISOString(),
    startedAt,
    executionAttempts,
    executionFailures,
    trades: tradeMetrics,
    aggregate: getAggregateMetrics(),
  };

  const filePath = path.join(DATA_DIR, 'metrics.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function printMetricsSummary() {
  const m = getAggregateMetrics();
  if (m.totalTrades === 0) {
    log.info('No trades recorded yet');
    return;
  }

  log.info('=== METRICS SUMMARY ===', {
    totalTrades: m.totalTrades,
    winRate: `${m.winRate.toFixed(1)}%`,
    profitFactor: m.profitFactor === Infinity ? 'Inf' : m.profitFactor.toFixed(2),
    avgWinLoss: m.avgWinLossRatio === Infinity ? 'Inf' : m.avgWinLossRatio.toFixed(2),
    totalPnlSol: m.totalPnlSol.toFixed(4),
    maxDrawdown: `${m.maxDrawdownPct.toFixed(1)}%`,
    sharpe: m.sharpeRatio.toFixed(2),
    avgHoldMins: Math.round(m.avgHoldTimeMinutes),
    execFailRate: `${m.executionFailureRate.toFixed(1)}%`,
    uptimeHours: m.uptimeHours.toFixed(1),
    exitTypes: m.exitTypeDistribution,
  });
}

export function getTradeMetrics(): TradeMetric[] {
  return tradeMetrics;
}
