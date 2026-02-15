import {
  Candle, BacktestConfig, BacktestResult, BacktestTrade,
  BacktestPosition, StrategyContext, IndicatorValues, Signal,
} from './types';
import { closeSeries, highSeries, lowSeries, volumeSeries } from './data-loader';
import {
  computeSma, computeEma, computeMacd,
  computeBollingerBands, computeAtr,
  computeVwapProxy, computeObvProxy,
  computeRsiSeries, computeConnorsRsiSeries,
} from './indicators';

interface PrecomputedIndicators {
  rsi: (number | null)[];
  connorsRsi: (number | null)[];
  sma: Record<number, number[]>;
  ema: Record<number, number[]>;
  macd: { macd: number[]; signal: number[]; histogram: number[] };
  bb: { upper: number[]; middle: number[]; lower: number[]; width: number[] };
  atr: number[];
  vwapProxy: number[];
  obvProxy: number[];
}

function precompute(candles: Candle[]): PrecomputedIndicators {
  const closes = closeSeries(candles);
  const highs = highSeries(candles);
  const lows = lowSeries(candles);
  const volumes = volumeSeries(candles);

  return {
    rsi: computeRsiSeries(closes, 14),
    connorsRsi: computeConnorsRsiSeries(closes, 3, 2, 100),
    sma: {
      10: computeSma(closes, 10),
      20: computeSma(closes, 20),
      50: computeSma(closes, 50),
    },
    ema: {
      12: computeEma(closes, 12),
      26: computeEma(closes, 26),
    },
    macd: computeMacd(closes, 12, 26, 9),
    bb: computeBollingerBands(closes, 20, 2),
    atr: computeAtr(highs, lows, closes, 14),
    vwapProxy: computeVwapProxy(candles),
    obvProxy: computeObvProxy(closes, volumes),
  };
}

function snapshotAt(pre: PrecomputedIndicators, index: number): IndicatorValues {
  return {
    rsi: pre.rsi[index] ?? undefined,
    connorsRsi: pre.connorsRsi[index] ?? undefined,
    sma: Object.fromEntries(
      Object.entries(pre.sma).map(([p, arr]) => [Number(p), arr[index]])
    ),
    ema: Object.fromEntries(
      Object.entries(pre.ema).map(([p, arr]) => [Number(p), arr[index]])
    ),
    macd: isNaN(pre.macd.histogram[index]) ? undefined : {
      macd: pre.macd.macd[index],
      signal: pre.macd.signal[index],
      histogram: pre.macd.histogram[index],
    },
    bollingerBands: isNaN(pre.bb.upper[index]) ? undefined : {
      upper: pre.bb.upper[index],
      middle: pre.bb.middle[index],
      lower: pre.bb.lower[index],
      width: pre.bb.width[index],
    },
    atr: isNaN(pre.atr[index]) ? undefined : pre.atr[index],
    vwapProxy: pre.vwapProxy[index],
    obvProxy: pre.obvProxy[index],
  };
}

export function runBacktest(candles: Candle[], config: BacktestConfig): BacktestResult {
  const { strategy, mint, label, commissionPct = 0.3, slippagePct = 0.1 } = config;
  const totalCostPct = commissionPct + slippagePct;

  if (candles.length === 0) {
    return {
      strategyName: strategy.name, mint, label,
      trades: [], totalCandles: 0,
      dateRange: { start: 0, end: 0 },
    };
  }

  const pre = precompute(candles);
  const trades: BacktestTrade[] = [];
  let position: BacktestPosition | null = null;

  for (let i = strategy.requiredHistory; i < candles.length; i++) {
    const candle = candles[i];

    if (position) {
      if (candle.close > position.peakPrice) {
        position.peakPrice = candle.close;
      }
      const pnlPct = ((candle.close - position.entryPrice) / position.entryPrice) * 100;
      if (pnlPct > position.peakPnlPct) {
        position.peakPnlPct = pnlPct;
      }
    }

    const indicators = snapshotAt(pre, i);
    const ctx: StrategyContext = {
      candle,
      index: i,
      indicators,
      position,
      history: candles,
    };

    const signal: Signal = strategy.evaluate(ctx);

    if (signal === 'buy' && !position) {
      position = {
        entryIndex: i,
        entryPrice: candle.close,
        entryTime: candle.timestamp,
        peakPrice: candle.close,
        peakPnlPct: 0,
      };
    } else if (signal === 'sell' && position) {
      const grossPnlPct = ((candle.close - position.entryPrice) / position.entryPrice) * 100;

      trades.push({
        mint,
        entryTime: position.entryTime,
        exitTime: candle.timestamp,
        entryPrice: position.entryPrice,
        exitPrice: candle.close,
        pnlPct: grossPnlPct - totalCostPct,
        holdBars: i - position.entryIndex,
        holdTimeMinutes: (candle.timestamp - position.entryTime) / 60_000,
        exitReason: 'strategy',
      });
      position = null;
    }
  }

  // Force-close any open position at end of data
  if (position) {
    const last = candles[candles.length - 1];
    const grossPnlPct = ((last.close - position.entryPrice) / position.entryPrice) * 100;
    trades.push({
      mint,
      entryTime: position.entryTime,
      exitTime: last.timestamp,
      entryPrice: position.entryPrice,
      exitPrice: last.close,
      pnlPct: grossPnlPct - totalCostPct,
      holdBars: candles.length - 1 - position.entryIndex,
      holdTimeMinutes: (last.timestamp - position.entryTime) / 60_000,
      exitReason: 'end-of-data',
    });
  }

  return {
    strategyName: strategy.name,
    mint,
    label,
    trades,
    totalCandles: candles.length,
    dateRange: {
      start: candles[0].timestamp,
      end: candles[candles.length - 1].timestamp,
    },
  };
}
