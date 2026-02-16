/**
 * Parameter sweep engine — grid search over strategy parameters.
 *
 * Usage:
 *   tsx src/backtest/sweep.ts                    # all templates x all tokens x 1-min
 *   tsx src/backtest/sweep.ts crsi               # one template
 *   tsx src/backtest/sweep.ts crsi POPCAT        # one template x one token
 *   tsx src/backtest/sweep.ts crsi POPCAT 5      # one template x one token x 5-min bars
 */

import { BacktestStrategy, Signal, BacktestTrade, BacktestMetrics } from './types';
import { loadCandles, loadTokenList, aggregateCandles } from './data-loader';
import { runBacktest } from './engine';
import { computeMetrics } from './report';

// ── Sweep result type ────────────────────────────────────────────────

interface SweepResult {
  templateName: string;
  params: Record<string, number>;
  token: string;
  timeframe: number;
  metrics: BacktestMetrics;
}

// ── Strategy templates ───────────────────────────────────────────────
// Each template is a function that takes params and returns a BacktestStrategy.
// The sweep defines which params to grid-search over.

interface SweepTemplate {
  name: string;
  paramGrid: Record<string, number[]>;
  build(params: Record<string, number>): BacktestStrategy;
}

const templates: SweepTemplate[] = [
  // ── CRSI threshold sweep ──
  {
    name: 'crsi',
    paramGrid: {
      entry: [5, 10, 15, 20, 25, 30, 35],
      exit: [60, 65, 70, 75, 80, 85, 90],
      sl: [-1, -1.5, -2, -3, -5],
      tp: [1, 2, 3, 4, 6],
    },
    build(p) {
      return {
        name: `crsi-${p.entry}-${p.exit}-sl${p.sl}-tp${p.tp}`,
        description: `CRSI sweep entry<${p.entry} exit>${p.exit}`,
        requiredHistory: 102,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate(ctx): Signal {
          const { connorsRsi } = ctx.indicators;
          if (connorsRsi === undefined) return 'hold';
          if (!ctx.position && connorsRsi < p.entry) return 'buy';
          if (ctx.position && connorsRsi > p.exit) return 'sell';
          return 'hold';
        },
      };
    },
  },

  // ── BB + RSI mean reversion sweep ──
  {
    name: 'bb-rsi',
    paramGrid: {
      rsiEntry: [20, 25, 30, 35],
      rsiExit: [50, 55, 60, 65, 70],
      sl: [-1.5, -2, -2.5, -3],
    },
    build(p) {
      return {
        name: `bb-rsi-${p.rsiEntry}-${p.rsiExit}-sl${p.sl}`,
        description: `BB+RSI sweep`,
        requiredHistory: 21,
        stopLossPct: p.sl,
        evaluate(ctx): Signal {
          const { bollingerBands, rsi } = ctx.indicators;
          if (!bollingerBands || rsi === undefined) return 'hold';
          if (!ctx.position && ctx.candle.close <= bollingerBands.lower && rsi < p.rsiEntry) return 'buy';
          if (ctx.position && (rsi > p.rsiExit || ctx.candle.close >= bollingerBands.upper)) return 'sell';
          return 'hold';
        },
      };
    },
  },

  // ── MACD + OBV momentum with SL/TP sweep ──
  {
    name: 'macd-obv',
    paramGrid: {
      sl: [-1, -1.5, -2, -3],
      tp: [1, 2, 3, 4, 6],
    },
    build(p) {
      return {
        name: `macd-obv-sl${p.sl}-tp${p.tp}`,
        description: `MACD+OBV sweep`,
        requiredHistory: 30,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate(ctx): Signal {
          const { macd, obvProxy } = ctx.indicators;
          const prev = ctx.prevIndicators;
          if (!macd || !prev?.macd || obvProxy === undefined || prev.obvProxy === undefined) return 'hold';
          if (!ctx.position && macd.histogram > 0 && obvProxy > prev.obvProxy) return 'buy';
          if (ctx.position && macd.histogram < 0 && obvProxy < prev.obvProxy) return 'sell';
          return 'hold';
        },
      };
    },
  },

  // ── RSI(2) scalp sweep ──
  {
    name: 'rsi2',
    paramGrid: {
      entry: [5, 10, 15, 20],
      exit: [40, 50, 60, 70],
      sl: [-1, -1.5, -2, -3],
    },
    build(p) {
      return {
        name: `rsi2-${p.entry}-${p.exit}-sl${p.sl}`,
        description: `RSI(2) sweep`,
        requiredHistory: 5,
        stopLossPct: p.sl,
        evaluate(ctx): Signal {
          const { rsiShort } = ctx.indicators;
          if (rsiShort === undefined) return 'hold';
          if (!ctx.position && rsiShort < p.entry) return 'buy';
          if (ctx.position && rsiShort > p.exit) return 'sell';
          return 'hold';
        },
      };
    },
  },

  // ── EMA trend + ADX + RSI gate sweep ──
  {
    name: 'ema-adx',
    paramGrid: {
      adxMin: [15, 20, 25],
      rsiLow: [35, 40, 45],
      rsiHigh: [60, 65, 70],
      sl: [-1.5, -2, -3],
    },
    build(p) {
      return {
        name: `ema-adx-${p.adxMin}-rsi${p.rsiLow}-${p.rsiHigh}-sl${p.sl}`,
        description: `EMA+ADX+RSI sweep`,
        requiredHistory: 30,
        stopLossPct: p.sl,
        evaluate(ctx): Signal {
          const { ema, rsi, adx, atr } = ctx.indicators;
          if (!ema || rsi === undefined || adx === undefined || atr === undefined) return 'hold';
          const ema12 = ema[12], ema26 = ema[26];
          if (ema12 === undefined || ema26 === undefined || isNaN(ema12) || isNaN(ema26)) return 'hold';

          if (!ctx.position) {
            if (ema12 > ema26 && rsi >= p.rsiLow && rsi <= p.rsiHigh && adx > p.adxMin) return 'buy';
          }
          if (ctx.position) {
            if (ema12 < ema26) return 'sell';
            if (ctx.candle.close < ctx.position.entryPrice - 1.5 * atr) return 'sell';
          }
          return 'hold';
        },
      };
    },
  },

  // ── Multi-confirm score sweep ──
  {
    name: 'multi',
    paramGrid: {
      minScore: [2, 3, 4],
      sl: [-1.5, -2, -3],
      tp: [2, 3, 4, 6],
    },
    build(p) {
      return {
        name: `multi-${p.minScore}-sl${p.sl}-tp${p.tp}`,
        description: `Multi-confirm sweep`,
        requiredHistory: 102,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate(ctx): Signal {
          const { rsi, connorsRsi, macd, sma, obvProxy } = ctx.indicators;
          const prev = ctx.prevIndicators;
          if (!macd || rsi === undefined || connorsRsi === undefined || !sma || obvProxy === undefined) return 'hold';

          let bull = 0, bear = 0;
          if (rsi < 40) bull++; else if (rsi > 60) bear++;
          if (connorsRsi < 40) bull++; else if (connorsRsi > 60) bear++;
          if (macd.histogram > 0) bull++; else bear++;
          const sma20 = sma[20];
          if (sma20 && ctx.candle.close > sma20) bull++; else bear++;
          if (prev?.obvProxy !== undefined && obvProxy > prev.obvProxy) bull++; else bear++;

          if (!ctx.position && bull >= p.minScore) return 'buy';
          if (ctx.position && bear >= p.minScore) return 'sell';
          return 'hold';
        },
      };
    },
  },
];

// ── Grid expansion ───────────────────────────────────────────────────

function expandGrid(paramGrid: Record<string, number[]>): Record<string, number>[] {
  const keys = Object.keys(paramGrid);
  if (keys.length === 0) return [{}];

  const combos: Record<string, number>[] = [];
  const values = keys.map(k => paramGrid[k]);
  const indices = new Array(keys.length).fill(0);

  while (true) {
    const combo: Record<string, number> = {};
    for (let k = 0; k < keys.length; k++) {
      combo[keys[k]] = values[k][indices[k]];
    }
    combos.push(combo);

    let carry = keys.length - 1;
    while (carry >= 0) {
      indices[carry]++;
      if (indices[carry] < values[carry].length) break;
      indices[carry] = 0;
      carry--;
    }
    if (carry < 0) break;
  }

  return combos;
}

// ── Main sweep runner ────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const templateFilter = args[0] || null;
  const tokenFilter = args[1] || null;
  const timeframe = parseInt(args[2] || '1', 10);

  const selectedTemplates = templateFilter
    ? templates.filter(t => t.name === templateFilter)
    : templates;

  if (selectedTemplates.length === 0) {
    console.error(`Unknown template: ${templateFilter}`);
    console.error(`Available: ${templates.map(t => t.name).join(', ')}`);
    process.exit(1);
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
    process.exit(1);
  }

  // Count total combos for progress
  let totalCombos = 0;
  for (const tmpl of selectedTemplates) {
    totalCombos += expandGrid(tmpl.paramGrid).length;
  }
  console.log(`Sweep: ${selectedTemplates.length} template(s) x ${tokens.length} token(s) x ${timeframe}-min bars`);
  console.log(`Total parameter combos per token: ${totalCombos}\n`);

  const allResults: SweepResult[] = [];

  for (const token of tokens) {
    let candles = loadCandles(token.mint);
    if (candles.length === 0) {
      console.warn(`No data for ${token.label}, skipping`);
      continue;
    }
    if (timeframe > 1) {
      candles = aggregateCandles(candles, timeframe);
    }
    console.log(`${token.label}: ${candles.length} candles (${timeframe}-min)`);

    let run = 0;
    for (const tmpl of selectedTemplates) {
      const grid = expandGrid(tmpl.paramGrid);
      for (const params of grid) {
        run++;
        const strategy = tmpl.build(params);
        const result = runBacktest(candles, {
          mint: token.mint,
          label: token.label,
          strategy,
          commissionPct: 0.3,
          slippagePct: 0.1,
        });
        const dateRange = result.dateRange.end - result.dateRange.start;
        const metrics = computeMetrics(result.trades, dateRange);

        allResults.push({
          templateName: tmpl.name,
          params,
          token: token.label,
          timeframe,
          metrics,
        });
      }
    }
    process.stdout.write(`  ${run} combos tested\n`);
  }

  // Filter to results with at least 3 trades
  const meaningful = allResults.filter(r => r.metrics.totalTrades >= 3);

  if (meaningful.length === 0) {
    console.log('\nNo parameter combos produced 3+ trades. Need more data.');
    return;
  }

  // Sort by Sharpe ratio (primary), then profit factor, then total PnL
  meaningful.sort((a, b) => {
    if (Math.abs(b.metrics.sharpeRatio - a.metrics.sharpeRatio) > 0.01) {
      return b.metrics.sharpeRatio - a.metrics.sharpeRatio;
    }
    if (Math.abs(b.metrics.profitFactor - a.metrics.profitFactor) > 0.01) {
      return b.metrics.profitFactor - a.metrics.profitFactor;
    }
    return b.metrics.totalPnlPct - a.metrics.totalPnlPct;
  });

  // Print top 30
  const top = meaningful.slice(0, 30);
  console.log('\n' + '='.repeat(110));
  console.log(`TOP ${top.length} RESULTS (sorted by Sharpe, min 3 trades, ${timeframe}-min bars)`);
  console.log('='.repeat(110));
  console.log(
    '#'.padStart(3) +
    'Template'.padEnd(10) +
    'Token'.padEnd(8) +
    'Params'.padEnd(38) +
    'Trades'.padStart(7) +
    'WinR%'.padStart(7) +
    'PnL%'.padStart(8) +
    'PF'.padStart(6) +
    'Sharpe'.padStart(8) +
    'MaxDD%'.padStart(8) +
    'W/L'.padStart(6)
  );
  console.log('-'.repeat(110));

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const m = r.metrics;
    const paramStr = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ');
    const pf = m.profitFactor === Infinity ? 'Inf' : m.profitFactor.toFixed(1);
    const wl = m.avgWinLossRatio === Infinity ? 'Inf' : m.avgWinLossRatio.toFixed(1);

    console.log(
      String(i + 1).padStart(3) +
      r.templateName.padEnd(10) +
      r.token.padEnd(8) +
      paramStr.padEnd(38) +
      String(m.totalTrades).padStart(7) +
      `${m.winRate.toFixed(0)}%`.padStart(7) +
      `${m.totalPnlPct >= 0 ? '+' : ''}${m.totalPnlPct.toFixed(1)}%`.padStart(8) +
      pf.padStart(6) +
      m.sharpeRatio.toFixed(2).padStart(8) +
      `${m.maxDrawdownPct.toFixed(1)}%`.padStart(8) +
      wl.padStart(6)
    );
  }
  console.log('='.repeat(110));

  // Also print worst 10 to show what to avoid
  const bottom = meaningful.slice(-10).reverse();
  console.log(`\nBOTTOM ${bottom.length} (worst Sharpe):`);
  console.log('-'.repeat(90));
  for (const r of bottom) {
    const m = r.metrics;
    const paramStr = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(
      `  ${r.templateName.padEnd(10)} ${r.token.padEnd(8)} ${paramStr.padEnd(38)} ` +
      `${m.totalTrades}T ${m.winRate.toFixed(0)}%W ${m.totalPnlPct >= 0 ? '+' : ''}${m.totalPnlPct.toFixed(1)}% Sharpe=${m.sharpeRatio.toFixed(2)}`
    );
  }
}

main();
