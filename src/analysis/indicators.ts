import { TradeEvent, IndicatorSnapshot } from './types';
import { getTradesForMint } from './trade-tracker';
import { buildCloseSeriesFromPrices } from './price-feed';
import { createLogger } from '../utils';

const log = createLogger('indicators');

export interface IndicatorOptions {
  intervalMinutes: number;
  lookbackMinutes: number;
  rsiPeriod: number;
  connorsRsiPeriod: number;
  connorsStreakRsiPeriod: number;
  connorsPercentRankPeriod: number;
}

function buildCloseSeries(trades: TradeEvent[], intervalMs: number, lookbackMs: number): number[] {
  const now = Date.now();
  const start = now - lookbackMs;
  const bucketCount = Math.ceil(lookbackMs / intervalMs);
  const closes: Array<number | undefined> = new Array(bucketCount).fill(undefined);

  for (const trade of trades) {
    if (trade.timestamp < start || trade.timestamp > now) continue;
    if (trade.pricePerToken <= 0) continue;
    const idx = Math.floor((trade.timestamp - start) / intervalMs);
    if (idx >= 0 && idx < bucketCount) {
      closes[idx] = trade.pricePerToken;
    }
  }

  const series: number[] = [];
  let last: number | undefined;
  for (const close of closes) {
    if (close !== undefined) last = close;
    if (last !== undefined) series.push(last);
  }

  return series;
}

export function computeRsi(values: number[], period: number): number | null {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeStreaks(values: number[]): number[] {
  const streaks: number[] = [];
  let streak = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) {
      streak = streak >= 0 ? streak + 1 : 1;
    } else if (delta < 0) {
      streak = streak <= 0 ? streak - 1 : -1;
    } else {
      streak = 0;
    }
    streaks.push(streak);
  }
  return streaks;
}

export function computePercentRank(values: number[], period: number): number | null {
  if (values.length < period + 1) return null;

  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    returns.push(values[i] - values[i - 1]);
  }

  if (returns.length < period) return null;
  const window = returns.slice(-period);
  const current = window[window.length - 1];
  const count = window.filter(r => r <= current).length;
  return (count / window.length) * 100;
}

export function computeConnorsRsi(values: number[], rsiPeriod: number, streakRsiPeriod: number, rankPeriod: number): number | null {
  const priceRsi = computeRsi(values, rsiPeriod);
  if (priceRsi === null) return null;

  const streaks = computeStreaks(values);
  const streakRsi = computeRsi(streaks, streakRsiPeriod);
  if (streakRsi === null) return null;

  const rank = computePercentRank(values, rankPeriod);
  if (rank === null) return null;

  return (priceRsi + streakRsi + rank) / 3;
}

export function getIndicatorSnapshot(mint: string, options: IndicatorOptions): IndicatorSnapshot {
  const intervalMs = options.intervalMinutes * 60_000;
  const lookbackMs = options.lookbackMinutes * 60_000;

  // Try trade-based candles first
  const trades = getTradesForMint(mint);
  const tradeCloses = buildCloseSeries(trades, intervalMs, lookbackMs);

  // Use Jupiter price feed if trade-based candles are insufficient
  // (CRSI needs percentRankPeriod + 1 candles minimum)
  const minCandles = options.connorsPercentRankPeriod + 1;
  let closes: number[];
  let source: string;

  if (tradeCloses.length >= minCandles) {
    closes = tradeCloses;
    source = 'trades';
  } else {
    const priceCloses = buildCloseSeriesFromPrices(mint, intervalMs, lookbackMs);
    if (priceCloses.length > tradeCloses.length) {
      closes = priceCloses;
      source = 'price-feed';
    } else {
      closes = tradeCloses;
      source = 'trades';
    }
  }

  log.debug('Indicator candles', { mint, source, candles: closes.length, needed: minCandles });

  const rsi = computeRsi(closes, options.rsiPeriod);
  const connorsRsi = computeConnorsRsi(
    closes,
    options.connorsRsiPeriod,
    options.connorsStreakRsiPeriod,
    options.connorsPercentRankPeriod
  );

  return {
    mint,
    candleIntervalMinutes: options.intervalMinutes,
    candleCount: closes.length,
    rsi: rsi === null ? undefined : rsi,
    connorsRsi: connorsRsi === null ? undefined : connorsRsi,
  };
}
