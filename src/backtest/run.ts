import { loadCandles, loadTokenList, aggregateCandles } from './data-loader';
import { STRATEGIES } from './strategy';
import { runBacktest } from './engine';
import { printReport, computeMetrics } from './report';
import { fixedCost, loadEmpiricalCost } from './cost-loader';

function main() {
  const rawArgs = process.argv.slice(2);

  // Extract named flags, leave positional args intact
  let costMode: 'fixed' | 'empirical' = 'fixed';
  let fromDate: string | undefined;
  let toDate: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--cost' && rawArgs[i + 1]) { costMode = rawArgs[++i] as 'fixed' | 'empirical'; }
    else if (rawArgs[i] === '--from' && rawArgs[i + 1]) { fromDate = rawArgs[++i]; }
    else if (rawArgs[i] === '--to' && rawArgs[i + 1]) { toDate = rawArgs[++i]; }
    else { positional.push(rawArgs[i]); }
  }

  const strategyFilter = positional[0] || null;
  const tokenFilter = positional[1] || null;
  const timeframe = parseInt(positional[2] || '1', 10);

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

  // Resolve cost config
  let costCfg = fixedCost();
  if (costMode === 'empirical') {
    try {
      costCfg = loadEmpiricalCost(fromDate, toDate);
    } catch (err) {
      console.error(`[WARN] ${err instanceof Error ? err.message : String(err)}`);
      console.error('[WARN] Falling back to fixed cost model.');
    }
  }
  console.log(`Cost model: ${costCfg.model} (round-trip ${costCfg.roundTripPct.toFixed(3)}%${costCfg.sampleSize ? `, n=${costCfg.sampleSize}` : ''})`);
  if (fromDate || toDate) {
    console.log(`Date range: ${fromDate ?? 'all'} → ${toDate ?? 'all'}`);
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
    let candles = loadCandles(token.mint, fromDate, toDate);
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
        roundTripCostPct: costCfg.roundTripPct,
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
