import { loadCandles, loadTokenList, aggregateCandles } from './data-loader';
import { STRATEGIES } from './strategy';
import { runBacktest } from './engine';
import { printReport, computeMetrics } from './report';

function main() {
  const args = process.argv.slice(2);
  const strategyFilter = args[0] || null;
  const tokenFilter = args[1] || null;
  const timeframe = parseInt(args[2] || '1', 10);

  const strategyNames = strategyFilter
    ? [strategyFilter]
    : Object.keys(STRATEGIES);

  for (const name of strategyNames) {
    if (!STRATEGIES[name]) {
      console.error(`Unknown strategy: ${name}`);
      console.error(`Available: ${Object.keys(STRATEGIES).join(', ')}`);
      process.exit(1);
    }
  }

  const allTokens = loadTokenList();
  const tokens = tokenFilter
    ? allTokens.filter(t =>
        t.label.toLowerCase() === tokenFilter.toLowerCase() ||
        t.mint === tokenFilter
      )
    : allTokens;

  if (tokens.length === 0) {
    console.error(`No tokens matched: ${tokenFilter}`);
    console.error(`Available: ${allTokens.map(t => t.label).join(', ')}`);
    process.exit(1);
  }

  console.log(`Running ${strategyNames.length} strategy(s) x ${tokens.length} token(s) x ${timeframe}-min bars\n`);

  const results: Array<{ strategyName: string; label: string; trades: number; winRate: number; totalPnl: number }> = [];

  for (const token of tokens) {
    let candles = loadCandles(token.mint);
    if (candles.length === 0) {
      console.warn(`No candle data for ${token.label} (${token.mint.slice(0, 8)}...)`);
      continue;
    }
    if (timeframe > 1) {
      candles = aggregateCandles(candles, timeframe);
    }

    for (const name of strategyNames) {
      const result = runBacktest(candles, {
        mint: token.mint,
        label: token.label,
        strategy: STRATEGIES[name],
        commissionPct: 0.3,
        slippagePct: 0.1,
      });

      printReport(result);

      const dateRange = result.dateRange.end - result.dateRange.start;
      const m = computeMetrics(result.trades, dateRange);
      results.push({
        strategyName: result.strategyName,
        label: result.label,
        trades: m.totalTrades,
        winRate: m.winRate,
        totalPnl: m.totalPnlPct,
      });
    }
  }

  if (results.length > 1) {
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(
      'Strategy'.padEnd(25) +
      'Token'.padEnd(8) +
      'Trades'.padStart(7) +
      'WinRate'.padStart(9) +
      'PnL%'.padStart(9)
    );
    console.log('-'.repeat(58));
    for (const r of results) {
      console.log(
        r.strategyName.padEnd(25) +
        r.label.padEnd(8) +
        String(r.trades).padStart(7) +
        `${r.winRate.toFixed(1)}%`.padStart(9) +
        `${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(1)}%`.padStart(9)
      );
    }
    console.log('='.repeat(58));
  }
}

main();
