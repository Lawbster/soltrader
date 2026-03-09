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
  snapshots: IndicatorValues[];
}

interface IndicatorPrecomputeConfig {
  rsiPeriod: number;
  connorsRsiPeriod: number;
  connorsStreakRsiPeriod: number;
  connorsPercentRankPeriod: number;
}

interface BacktestOpenPosition extends BacktestPosition {
  entryRegime?: BacktestConfig['entryRegimeFilter'];
}

const precomputedCache = new WeakMap<Candle[], Map<string, PrecomputedIndicators>>();

function normalizeIndicatorConfig(config?: BacktestConfig['indicatorConfig']): IndicatorPrecomputeConfig {
  return {
    rsiPeriod: Number.isFinite(config?.rsiPeriod) ? Math.max(2, Math.round(config!.rsiPeriod!)) : 14,
    connorsRsiPeriod: Number.isFinite(config?.connorsRsiPeriod) ? Math.max(2, Math.round(config!.connorsRsiPeriod!)) : 3,
    connorsStreakRsiPeriod: Number.isFinite(config?.connorsStreakRsiPeriod) ? Math.max(2, Math.round(config!.connorsStreakRsiPeriod!)) : 2,
    connorsPercentRankPeriod: Number.isFinite(config?.connorsPercentRankPeriod) ? Math.max(2, Math.round(config!.connorsPercentRankPeriod!)) : 100,
  };
}

function indicatorConfigKey(config: IndicatorPrecomputeConfig): string {
  return [
    config.rsiPeriod,
    config.connorsRsiPeriod,
    config.connorsStreakRsiPeriod,
    config.connorsPercentRankPeriod,
  ].join('|');
}

function precompute(candles: Candle[], rawConfig?: BacktestConfig['indicatorConfig']): PrecomputedIndicators {
  const config = normalizeIndicatorConfig(rawConfig);
  const cacheKey = indicatorConfigKey(config);
  const cachedByConfig = precomputedCache.get(candles);
  const cached = cachedByConfig?.get(cacheKey);
  if (cached) {
    return cached;
  }

  const closes = closeSeries(candles);
  const highs = highSeries(candles);
  const lows = lowSeries(candles);
  const volumes = volumeSeries(candles);

  const pre: PrecomputedIndicators = {
    rsi: computeRsiSeries(closes, config.rsiPeriod),
    rsiShort: computeRsiSeries(closes, 2),
    connorsRsi: computeConnorsRsiSeries(
      closes,
      config.connorsRsiPeriod,
      config.connorsStreakRsiPeriod,
      config.connorsPercentRankPeriod,
    ),
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
    snapshots: [],
  };

  pre.snapshots = candles.map((_, index) => snapshotAt(pre, index));
  const next = cachedByConfig ?? new Map<string, PrecomputedIndicators>();
  next.set(cacheKey, pre);
  precomputedCache.set(candles, next);
  return pre;
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

function inferTimeframeMs(candles: Candle[]): number {
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].timestamp - candles[i - 1].timestamp;
    if (delta > 0) return delta;
  }
  return 60_000;
}

function pnlPctAtPrice(entryPrice: number, exitPrice: number): number {
  return ((exitPrice - entryPrice) / entryPrice) * 100;
}

function stopLossHit(strategy: BacktestConfig['strategy'], position: BacktestPosition, price: number): boolean {
  if (strategy.stopLossPct !== undefined) {
    const stopPrice = position.entryPrice * (1 + strategy.stopLossPct / 100);
    return price <= stopPrice;
  }
  if (strategy.stopLossAtrMult !== undefined && position.entryAtr !== undefined && position.entryAtr > 0) {
    const stopPrice = position.entryPrice - (strategy.stopLossAtrMult * position.entryAtr);
    return price <= stopPrice;
  }
  return false;
}

function takeProfitHit(strategy: BacktestConfig['strategy'], position: BacktestPosition, price: number): boolean {
  if (strategy.takeProfitPct !== undefined) {
    const takeProfitPrice = position.entryPrice * (1 + strategy.takeProfitPct / 100);
    return price >= takeProfitPrice;
  }
  if (strategy.takeProfitAtrMult !== undefined && position.entryAtr !== undefined && position.entryAtr > 0) {
    const takeProfitPrice = position.entryPrice + (strategy.takeProfitAtrMult * position.entryAtr);
    return price >= takeProfitPrice;
  }
  return false;
}

function protectionExitReason(
  strategy: BacktestConfig['strategy'],
  position: BacktestPosition,
  currentPnlPct: number,
  holdTimeMinutes: number,
): string | null {
  const protection = strategy.protection;
  if (!protection) return null;

  if (
    Number.isFinite(protection.trailArmPct) &&
    Number.isFinite(protection.trailGapPct) &&
    (protection.trailArmPct as number) > 0 &&
    (protection.trailGapPct as number) > 0 &&
    position.peakPnlPct >= (protection.trailArmPct as number)
  ) {
    const trailStopPct = position.peakPnlPct - (protection.trailGapPct as number);
    if (currentPnlPct <= trailStopPct) {
      return 'protection-trailing';
    }
  }

  if (
    Number.isFinite(protection.profitLockArmPct) &&
    Number.isFinite(protection.profitLockPct) &&
    (protection.profitLockArmPct as number) > 0 &&
    (protection.profitLockPct as number) >= 0 &&
    position.peakPnlPct >= (protection.profitLockArmPct as number) &&
    currentPnlPct <= (protection.profitLockPct as number)
  ) {
    return 'protection-profit-lock';
  }

  if (
    Number.isFinite(protection.staleMaxHoldMinutes) &&
    (protection.staleMaxHoldMinutes as number) > 0 &&
    holdTimeMinutes >= (protection.staleMaxHoldMinutes as number)
  ) {
    const minPnlPct = Number.isFinite(protection.staleMinPnlPct)
      ? (protection.staleMinPnlPct as number)
      : 0;
    if (currentPnlPct <= minPnlPct) {
      return 'protection-stale';
    }
  }

  return null;
}

function closePosition(
  trades: BacktestTrade[],
  mint: string,
  roundTripCost: number,
  position: BacktestOpenPosition,
  exitTime: number,
  exitPrice: number,
  exitReason: string,
  exitIndex: number,
): void {
  trades.push({
    mint,
    entryTime: position.entryTime,
    exitTime,
    entryPrice: position.entryPrice,
    exitPrice,
    pnlPct: pnlPctAtPrice(position.entryPrice, exitPrice) - roundTripCost,
    holdBars: exitIndex - position.entryIndex,
    holdTimeMinutes: (exitTime - position.entryTime) / 60_000,
    exitReason,
    entryRegime: position.entryRegime,
  });
}

function closeAllPositionsAtPrice(
  positions: BacktestOpenPosition[],
  trades: BacktestTrade[],
  mint: string,
  roundTripCost: number,
  exitTime: number,
  exitPrice: number,
  exitReason: string,
  exitIndex: number,
): void {
  for (let i = positions.length - 1; i >= 0; i--) {
    closePosition(trades, mint, roundTripCost, positions[i], exitTime, exitPrice, exitReason, exitIndex);
    positions.splice(i, 1);
  }
}

function updatePeakStats(positions: BacktestOpenPosition[], price: number): void {
  for (const pos of positions) {
    if (price > pos.peakPrice) {
      pos.peakPrice = price;
    }
    const pnlPct = pnlPctAtPrice(pos.entryPrice, price);
    if (pnlPct > pos.peakPnlPct) {
      pos.peakPnlPct = pnlPct;
    }
  }
}

function processPriceExitsAtPrice(
  strategy: BacktestConfig['strategy'],
  positions: BacktestOpenPosition[],
  trades: BacktestTrade[],
  mint: string,
  roundTripCost: number,
  price: number,
  exitTime: number,
  exitIndex: number,
): void {
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    const currentPnlPct = pnlPctAtPrice(pos.entryPrice, price);
    const holdTimeMinutes = (exitTime - pos.entryTime) / 60_000;

    const protectionReason = protectionExitReason(strategy, pos, currentPnlPct, holdTimeMinutes);
    if (protectionReason) {
      closePosition(trades, mint, roundTripCost, pos, exitTime, price, protectionReason, exitIndex);
      positions.splice(i, 1);
      continue;
    }

    if (stopLossHit(strategy, pos, price)) {
      closePosition(trades, mint, roundTripCost, pos, exitTime, price, 'stop-loss', exitIndex);
      positions.splice(i, 1);
      continue;
    }

    if (takeProfitHit(strategy, pos, price)) {
      closePosition(trades, mint, roundTripCost, pos, exitTime, price, 'take-profit', exitIndex);
      positions.splice(i, 1);
    }
  }
}

export function runBacktest(candles: Candle[], config: BacktestConfig): BacktestResult {
  const {
    strategy,
    mint,
    label,
    commissionPct = 0.3,
    slippagePct = 0.1,
    roundTripCostPct,
    maxPositions = 1,
    exitParityMode = 'indicator',
    executionCandles,
    signalRegimes,
    entryRegimeFilter,
  } = config;
  const roundTripCost = roundTripCostPct ?? (commissionPct + slippagePct) * 2;

  const signalCandles = candles;
  const execCandles = executionCandles ?? candles;
  const signalTimeframeMs = Math.max(60_000, config.signalTimeframeMinutes
    ? config.signalTimeframeMinutes * 60_000
    : inferTimeframeMs(signalCandles));
  const executionTimeframeMs = Math.max(60_000, config.executionTimeframeMinutes
    ? config.executionTimeframeMinutes * 60_000
    : inferTimeframeMs(execCandles));
  const signalTimeframeMinutes = Math.round(signalTimeframeMs / 60_000);
  const executionTimeframeMinutes = Math.round(executionTimeframeMs / 60_000);

  if (signalCandles.length === 0 || execCandles.length === 0) {
    return {
      strategyName: strategy.name,
      mint,
      label,
      trades: [],
      totalCandles: 0,
      dateRange: { start: 0, end: 0 },
      signalTimeframeMinutes,
      executionTimeframeMinutes,
    };
  }

  const pre = precompute(signalCandles, config.indicatorConfig);
  const trades: BacktestTrade[] = [];
  const positions: BacktestOpenPosition[] = [];
  const signalCloseTimes = signalCandles.map(candle => candle.timestamp + signalTimeframeMs);
  let nextSignalIndex = Math.max(strategy.requiredHistory, 0);

  for (let execIndex = 0; execIndex < execCandles.length; execIndex++) {
    const execCandle = execCandles[execIndex];

    if (positions.length > 0) {
      updatePeakStats(positions, execCandle.open);
      processPriceExitsAtPrice(
        strategy,
        positions,
        trades,
        mint,
        roundTripCost,
        execCandle.open,
        execCandle.timestamp,
        execIndex,
      );
    }

    let latestSignalIndex: number | null = null;
    while (nextSignalIndex < signalCandles.length && signalCloseTimes[nextSignalIndex] <= execCandle.timestamp) {
      latestSignalIndex = nextSignalIndex;
      nextSignalIndex++;
    }

    if (latestSignalIndex !== null) {
      const signalCandle = signalCandles[latestSignalIndex];
      const indicators = pre.snapshots[latestSignalIndex];
      const prevIndicators = latestSignalIndex > 0 ? pre.snapshots[latestSignalIndex - 1] : undefined;
      const hour = new Date(signalCloseTimes[latestSignalIndex]).getUTCHours();

      const ctx: StrategyContext = {
        candle: signalCandle,
        index: latestSignalIndex,
        indicators,
        prevIndicators,
        positions,
        history: signalCandles,
        hour,
      };

      const signal: Signal = strategy.evaluate(ctx);

      if (positions.length > 0 && signal === 'sell' && exitParityMode !== 'price') {
        closeAllPositionsAtPrice(
          positions,
          trades,
          mint,
          roundTripCost,
          execCandle.timestamp,
          execCandle.open,
          'strategy',
          execIndex,
        );
      }

      if (signal === 'buy' && positions.length < maxPositions) {
        const signalRegime = signalRegimes?.[latestSignalIndex];
        const regimeAllowsEntry = entryRegimeFilter === undefined
          ? true
          : signalRegime === entryRegimeFilter;
        if (!regimeAllowsEntry) {
          continue;
        }
        positions.push({
          entryIndex: execIndex,
          entryPrice: execCandle.open,
          entryTime: execCandle.timestamp,
          peakPrice: execCandle.open,
          peakPnlPct: 0,
          entryAtr: indicators.atr,
          entryRegime: signalRegime,
        });
      }

      if (positions.length > 0) {
        processPriceExitsAtPrice(
          strategy,
          positions,
          trades,
          mint,
          roundTripCost,
          execCandle.open,
          execCandle.timestamp,
          execIndex,
        );
      }
    }

    if (positions.length > 0) {
      updatePeakStats(positions, execCandle.close);
      processPriceExitsAtPrice(
        strategy,
        positions,
        trades,
        mint,
        roundTripCost,
        execCandle.close,
        execCandle.timestamp + executionTimeframeMs,
        execIndex,
      );
    }
  }

  const lastExecCandle = execCandles[execCandles.length - 1];
  for (const pos of positions) {
    closePosition(
      trades,
      mint,
      roundTripCost,
      pos,
      lastExecCandle.timestamp + executionTimeframeMs,
      lastExecCandle.close,
      'end-of-data',
      execCandles.length - 1,
    );
  }

  return {
    strategyName: strategy.name,
    mint,
    label,
    trades,
    totalCandles: signalCandles.length,
    dateRange: {
      start: Math.min(signalCandles[0].timestamp, execCandles[0].timestamp),
      end: lastExecCandle.timestamp + executionTimeframeMs,
    },
    signalTimeframeMinutes,
    executionTimeframeMinutes,
  };
}
