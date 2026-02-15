import { BacktestResult, BacktestTrade, BacktestMetrics } from './types';

export function computeMetrics(trades: BacktestTrade[], dateRangeMs: number): BacktestMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      avgWinPct: 0, avgLossPct: 0, avgWinLossRatio: 0,
      profitFactor: 0, totalPnlPct: 0, maxDrawdownPct: 0,
      sharpeRatio: 0, avgHoldBars: 0, avgHoldMinutes: 0, tradesPerDay: 0,
    };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);

  const winRate = (wins.length / trades.length) * 100;
  const avgWinPct = wins.length > 0
    ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0
    ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const avgWinLossRatio = avgLossPct !== 0
    ? Math.abs(avgWinPct / avgLossPct) : avgWinPct > 0 ? Infinity : 0;

  const totalWin = wins.reduce((s, t) => s + t.pnlPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 0;

  const totalPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);

  let peak = 0, maxDD = 0, cum = 0;
  for (const t of trades) {
    cum += t.pnlPct;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  const returns = trades.map(t => t.pnlPct / 100);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  const days = dateRangeMs / 86_400_000;
  const tradesPerDay = days > 0 ? trades.length / days : trades.length;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(tradesPerDay * 365) : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWinPct,
    avgLossPct,
    avgWinLossRatio,
    profitFactor,
    totalPnlPct,
    maxDrawdownPct: maxDD,
    sharpeRatio: sharpe,
    avgHoldBars: trades.reduce((s, t) => s + t.holdBars, 0) / trades.length,
    avgHoldMinutes: trades.reduce((s, t) => s + t.holdTimeMinutes, 0) / trades.length,
    tradesPerDay,
  };
}

export function printReport(result: BacktestResult): void {
  const dateRange = result.dateRange.end - result.dateRange.start;
  const metrics = computeMetrics(result.trades, dateRange);

  const startDate = new Date(result.dateRange.start).toISOString().split('T')[0];
  const endDate = new Date(result.dateRange.end).toISOString().split('T')[0];

  console.log('\n' + '='.repeat(60));
  console.log(`Strategy: ${result.strategyName}`);
  console.log(`Token:    ${result.label} (${result.mint.slice(0, 8)}...)`);
  console.log(`Period:   ${startDate} to ${endDate} (${result.totalCandles} candles)`);
  console.log('='.repeat(60));
  console.log(`Trades:        ${metrics.totalTrades} (${metrics.wins}W / ${metrics.losses}L)`);
  console.log(`Win rate:      ${metrics.winRate.toFixed(1)}%`);
  console.log(`Avg win:       +${metrics.avgWinPct.toFixed(2)}%`);
  console.log(`Avg loss:      ${metrics.avgLossPct.toFixed(2)}%`);
  console.log(`W/L ratio:     ${metrics.avgWinLossRatio === Infinity ? 'Inf' : metrics.avgWinLossRatio.toFixed(2)}`);
  console.log(`Profit factor: ${metrics.profitFactor === Infinity ? 'Inf' : metrics.profitFactor.toFixed(2)}`);
  console.log(`Total PnL:     ${metrics.totalPnlPct >= 0 ? '+' : ''}${metrics.totalPnlPct.toFixed(2)}%`);
  console.log(`Max drawdown:  ${metrics.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Sharpe:        ${metrics.sharpeRatio.toFixed(2)}`);
  console.log(`Avg hold:      ${metrics.avgHoldBars.toFixed(0)} bars (${metrics.avgHoldMinutes.toFixed(0)} min)`);
  console.log(`Trades/day:    ${metrics.tradesPerDay.toFixed(1)}`);
  console.log('='.repeat(60));

  if (result.trades.length > 0 && result.trades.length <= 50) {
    console.log('\nTrade log:');
    for (const t of result.trades) {
      const time = new Date(t.entryTime).toISOString().slice(11, 16);
      const sign = t.pnlPct >= 0 ? '+' : '';
      console.log(`  ${time} | ${sign}${t.pnlPct.toFixed(2)}% | ${t.holdBars} bars | ${t.exitReason}`);
    }
  }
}
