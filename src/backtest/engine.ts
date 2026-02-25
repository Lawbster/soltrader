import {
  Candle, BacktestConfig, BacktestResult, BacktestTrade,
  BacktestPosition, StrategyContext, IndicatorValues, Signal,
} from './types';
import { closeSeries, highSeries, lowSeries, volumeSeries } from './data-loader';
import {
  computeSma, computeEma, computeMacd,
  computeBollingerBands, computeAtr, computeAdx,
  computeVwapProxy, computeObvProxy,
  computeRsiSeries, computeConnorsRsiSeries,
} from './indicators';

interface PrecomputedIndicators {
  rsi: (number | null)[];
  rsiShort: (number | null)[];
  connorsRsi: (number | null)[];
  sma: Record<number, number[]>;
  ema: Record<number, number[]>;
  macd: { macd: number[]; signal: number[]; histogram: number[] };
  bb: { upper: number[]; middle: number[]; lower: number[]; width: number[] };
  atr: number[];
  adx: number[];
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
    rsiShort: computeRsiSeries(closes, 2),
    connorsRsi: computeConnorsRsiSeries(closes, 3, 2, 100),
    sma: {
      10: computeSma(closes, 10),
      20: computeSma(closes, 20),
      50: computeSma(closes, 50),
    },
    ema: {
      9: computeEma(closes, 9),
      12: computeEma(closes, 12),
      26: computeEma(closes, 26),
    },
    macd: computeMacd(closes, 12, 26, 9),
    bb: computeBollingerBands(closes, 20, 2),
    atr: computeAtr(highs, lows, closes, 14),
    adx: computeAdx(highs, lows, closes, 14),
    vwapProxy: computeVwapProxy(candles),
    obvProxy: computeObvProxy(closes, volumes),
  };
}

function snapshotAt(pre: PrecomputedIndicators, index: number): IndicatorValues {
  return {
    rsi: pre.rsi[index] ?? undefined,
    rsiShort: pre.rsiShort[index] ?? undefined,
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
    adx: isNaN(pre.adx[index]) ? undefined : pre.adx[index],
    vwapProxy: pre.vwapProxy[index],
    obvProxy: pre.obvProxy[index],
  };
}

export function runBacktest(candles: Candle[], config: BacktestConfig): BacktestResult {
  const { strategy, mint, label, commissionPct = 0.3, slippagePct = 0.1, roundTripCostPct, maxPositions = 1, exitParityMode = 'indicator' } = config;
  // Round-trip cost: use explicit override if provided, otherwise derive from commission+slippage
  const roundTripCost = roundTripCostPct ?? (commissionPct + slippagePct) * 2;

  if (candles.length === 0) {
    return {
      strategyName: strategy.name, mint, label,
      trades: [], totalCandles: 0,
      dateRange: { start: 0, end: 0 },
    };
  }

  const pre = precompute(candles);
  const trades: BacktestTrade[] = [];
  const positions: BacktestPosition[] = []; // active positions (capped at maxPositions)
  let pendingBuy = false;
  let pendingSell = false;

  // Stop one bar early — signals on bar i execute at bar i+1 open
  for (let i = strategy.requiredHistory; i < candles.length; i++) {
    const candle = candles[i];

    // Execute pending signals at this bar's open (next-bar execution)
    if (pendingBuy && positions.length < maxPositions) {
      positions.push({
        entryIndex: i,
        entryPrice: candle.open,
        entryTime: candle.timestamp,
        peakPrice: candle.open,
        peakPnlPct: 0,
      });
      pendingBuy = false;
    } else if (pendingSell && positions.length > 0) {
      // All-out on sell signal: close every open position at this bar's open
      for (const pos of positions.splice(0)) {
        const grossPnlPct = ((candle.open - pos.entryPrice) / pos.entryPrice) * 100;
        trades.push({
          mint,
          entryTime: pos.entryTime,
          exitTime: candle.timestamp,
          entryPrice: pos.entryPrice,
          exitPrice: candle.open,
          pnlPct: grossPnlPct - roundTripCost,
          holdBars: i - pos.entryIndex,
          holdTimeMinutes: (candle.timestamp - pos.entryTime) / 60_000,
          exitReason: 'strategy',
        });
      }
      pendingSell = false;
    }

    // Intra-bar SL/TP check — evaluated per position, SL priority over TP
    if (positions.length > 0) {
      for (let j = positions.length - 1; j >= 0; j--) {
        const pos = positions[j];
        let closedThisPos = false;

        // Stop loss (priority over TP — conservative)
        if (strategy.stopLossPct !== undefined) {
          const stopPrice = pos.entryPrice * (1 + strategy.stopLossPct / 100);
          if (candle.low <= stopPrice) {
            trades.push({
              mint,
              entryTime: pos.entryTime,
              exitTime: candle.timestamp,
              entryPrice: pos.entryPrice,
              exitPrice: stopPrice,
              pnlPct: strategy.stopLossPct - roundTripCost,
              holdBars: i - pos.entryIndex,
              holdTimeMinutes: (candle.timestamp - pos.entryTime) / 60_000,
              exitReason: 'stop-loss',
            });
            positions.splice(j, 1);
            closedThisPos = true;
            pendingSell = false; // stale after any forced close
          }
        }

        // Take profit
        if (!closedThisPos && strategy.takeProfitPct !== undefined) {
          const tpPrice = pos.entryPrice * (1 + strategy.takeProfitPct / 100);
          if (candle.high >= tpPrice) {
            trades.push({
              mint,
              entryTime: pos.entryTime,
              exitTime: candle.timestamp,
              entryPrice: pos.entryPrice,
              exitPrice: tpPrice,
              pnlPct: strategy.takeProfitPct - roundTripCost,
              holdBars: i - pos.entryIndex,
              holdTimeMinutes: (candle.timestamp - pos.entryTime) / 60_000,
              exitReason: 'take-profit',
            });
            positions.splice(j, 1);
            pendingSell = false; // stale after any forced close
          }
        }
      }
      // If all positions closed by SL/TP, cancel pending re-entry for this signal cycle
      if (positions.length === 0) {
        pendingBuy = false;
      }
    }

    // Track peak for each open position
    for (const pos of positions) {
      if (candle.close > pos.peakPrice) {
        pos.peakPrice = candle.close;
      }
      const pnlPct = ((candle.close - pos.entryPrice) / pos.entryPrice) * 100;
      if (pnlPct > pos.peakPnlPct) {
        pos.peakPnlPct = pnlPct;
      }
    }

    const indicators = snapshotAt(pre, i);
    const prevIndicators = i > 0 ? snapshotAt(pre, i - 1) : undefined;
    const hour = new Date(candle.timestamp).getUTCHours();

    const ctx: StrategyContext = {
      candle,
      index: i,
      indicators,
      prevIndicators,
      positions,
      history: candles,
      hour,
    };

    const signal: Signal = strategy.evaluate(ctx);

    // Queue signal for next-bar execution.
    // In 'price' parity mode: suppress indicator sell signals — positions only close via intra-bar SL/TP.
    if (signal === 'buy' && positions.length < maxPositions) {
      pendingBuy = true;
    } else if (signal === 'sell' && positions.length > 0 && exitParityMode !== 'price') {
      pendingSell = true;
    }
  }

  // Force-close any open positions at end of data
  for (const pos of positions) {
    const last = candles[candles.length - 1];
    const grossPnlPct = ((last.close - pos.entryPrice) / pos.entryPrice) * 100;
    trades.push({
      mint,
      entryTime: pos.entryTime,
      exitTime: last.timestamp,
      entryPrice: pos.entryPrice,
      exitPrice: last.close,
      pnlPct: grossPnlPct - roundTripCost,
      holdBars: candles.length - 1 - pos.entryIndex,
      holdTimeMinutes: (last.timestamp - pos.entryTime) / 60_000,
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
