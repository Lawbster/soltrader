import { TradeEvent, IndicatorSnapshot } from './types';
import type { IndicatorValues } from '../backtest/types';
import { getTradesForMint } from './trade-tracker';
import { buildCloseSeriesFromPrices, getPriceHistory } from './price-feed';
import { createLogger } from '../utils';
import {
  computeSma,
  computeEma,
  computeMacd,
  computeBollingerBands,
  computeAtr,
  computeAdx,
  computeVwapProxy,
  computeObvProxy,
} from '../backtest/indicators';

const log = createLogger('indicators');

export interface IndicatorOptions {
  intervalMinutes: number;
  lookbackMinutes: number;
  rsiPeriod: number;
  connorsRsiPeriod: number;
  connorsStreakRsiPeriod: number;
  connorsPercentRankPeriod: number;
}

// ── OHLC types ────────────────────────────────────────────────────────

type OhlcSource = 'trades' | 'price-feed' | null;

interface OhlcCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // trade count as volume proxy
}

// ── Close series builder ──────────────────────────────────────────────

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

/**
 * Build OHLC candle series from available data sources.
 * Priority 1: trade events (real H/L per interval).
 * Priority 2: price-feed polls (H/L approximated from poll range per bucket).
 * Returns { candles: [], source: null } when neither has sufficient coverage.
 */
function buildOhlcSeries(
  mint: string,
  intervalMs: number,
  lookbackMs: number,
  minCandles: number,
): { candles: OhlcCandle[]; source: OhlcSource } {
  const now = Date.now();
  const start = now - lookbackMs;
  const bucketCount = Math.ceil(lookbackMs / intervalMs);

  // Priority 1: trade-derived OHLC (real high/low from individual trade prices)
  const trades = getTradesForMint(mint);
  if (trades.length > 0) {
    type Bucket = { open?: number; high: number; low: number; close?: number; count: number };
    const buckets: Bucket[] = Array.from({ length: bucketCount }, () => ({ high: -Infinity, low: Infinity, count: 0 }));

    for (const trade of trades) {
      if (trade.timestamp < start || trade.timestamp > now) continue;
      if (trade.pricePerToken <= 0) continue;
      const idx = Math.floor((trade.timestamp - start) / intervalMs);
      if (idx < 0 || idx >= bucketCount) continue;
      const b = buckets[idx];
      if (b.open === undefined) b.open = trade.pricePerToken;
      b.close = trade.pricePerToken;
      if (trade.pricePerToken > b.high) b.high = trade.pricePerToken;
      if (trade.pricePerToken < b.low) b.low = trade.pricePerToken;
      b.count++;
    }

    const candles: OhlcCandle[] = [];
    let lastClose: number | undefined;
    for (const b of buckets) {
      if (b.open !== undefined && b.close !== undefined && b.count > 0) {
        lastClose = b.close;
        candles.push({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.count });
      } else if (lastClose !== undefined) {
        candles.push({ open: lastClose, high: lastClose, low: lastClose, close: lastClose, volume: 0 });
      }
    }

    if (candles.length >= minCandles) return { candles, source: 'trades' };
  }

  // Priority 2: price-feed OHLC (H/L from poll point range per interval)
  const allHistory = getPriceHistory();
  const history = allHistory.get(mint);
  if (history && history.length > 0) {
    type Bucket = { open?: number; high: number; low: number; close?: number; count: number };
    const buckets: Bucket[] = Array.from({ length: bucketCount }, () => ({ high: -Infinity, low: Infinity, count: 0 }));

    for (const point of history) {
      if (point.timestamp < start || point.timestamp > now) continue;
      const idx = Math.floor((point.timestamp - start) / intervalMs);
      if (idx < 0 || idx >= bucketCount) continue;
      const b = buckets[idx];
      if (b.open === undefined) b.open = point.price;
      b.close = point.price;
      if (point.price > b.high) b.high = point.price;
      if (point.price < b.low) b.low = point.price;
      b.count++;
    }

    const candles: OhlcCandle[] = [];
    let lastClose: number | undefined;
    for (const b of buckets) {
      if (b.open !== undefined && b.close !== undefined && b.count > 0) {
        lastClose = b.close;
        candles.push({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.count });
      } else if (lastClose !== undefined) {
        candles.push({ open: lastClose, high: lastClose, low: lastClose, close: lastClose, volume: 0 });
      }
    }

    if (candles.length >= minCandles) return { candles, source: 'price-feed' };
  }

  return { candles: [], source: null };
}

// ── RSI / CRSI (self-contained — no circular backtest dependency) ─────

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

// ── All-indicators helper ─────────────────────────────────────────────

type PartialIndicators = IndicatorSnapshot['prevIndicators'];

/**
 * Compute all indicator values from a close series + optional OHLC candles.
 * All fields are optional/undefined when insufficient data exists.
 */
function computeIndicatorsFromSeries(
  closes: number[],
  ohlcCandles: OhlcCandle[],
  options: IndicatorOptions,
): PartialIndicators {
  if (closes.length < 2) return undefined;

  const lastIdx = closes.length - 1;

  // Close-only indicators
  const rsiVal     = computeRsi(closes, options.rsiPeriod);
  const rsiShortVal = computeRsi(closes, 2);
  const connorsVal = computeConnorsRsi(
    closes,
    options.connorsRsiPeriod,
    options.connorsStreakRsiPeriod,
    options.connorsPercentRankPeriod,
  );

  const sma10 = computeSma(closes, 10);
  const sma20 = computeSma(closes, 20);
  const sma50 = computeSma(closes, 50);

  const ema9  = computeEma(closes, 9);
  const ema12 = computeEma(closes, 12);
  const ema26 = computeEma(closes, 26);

  const bbRaw  = computeBollingerBands(closes);
  const bbLast = Number.isFinite(bbRaw.middle[lastIdx])
    ? { upper: bbRaw.upper[lastIdx], middle: bbRaw.middle[lastIdx], lower: bbRaw.lower[lastIdx], width: bbRaw.width[lastIdx] }
    : undefined;

  const macdRaw  = computeMacd(closes);
  const macdLast = Number.isFinite(macdRaw.macd[lastIdx]) && Number.isFinite(macdRaw.signal[lastIdx])
    ? { macd: macdRaw.macd[lastIdx], signal: macdRaw.signal[lastIdx], histogram: macdRaw.histogram[lastIdx] }
    : undefined;

  // OBV proxy — use ohlc volumes when available, fall back to uniform weight
  const volumes = ohlcCandles.length >= closes.length
    ? ohlcCandles.slice(-closes.length).map(c => c.volume)
    : new Array(closes.length).fill(1) as number[];
  const obvRaw  = computeObvProxy(closes, volumes);
  const obvLast = obvRaw[obvRaw.length - 1];

  // OHLC-derived indicators
  let adxVal: number | undefined;
  let atrVal: number | undefined;
  let vwapVal: number | undefined;

  if (ohlcCandles.length >= 2) {
    const highs      = ohlcCandles.map(c => c.high);
    const lows       = ohlcCandles.map(c => c.low);
    const ohlcCloses = ohlcCandles.map(c => c.close);
    const ohlcLast   = ohlcCandles.length - 1;

    const adxRaw = computeAdx(highs, lows, ohlcCloses);
    const atrRaw = computeAtr(highs, lows, ohlcCloses);
    if (Number.isFinite(adxRaw[ohlcLast])) adxVal = adxRaw[ohlcLast];
    if (Number.isFinite(atrRaw[ohlcLast])) atrVal = atrRaw[ohlcLast];

    const vwapRaw = computeVwapProxy(
      ohlcCandles.map(c => ({ close: c.close, high: c.high, low: c.low, pricePoints: c.volume }))
    );
    const vwapLast = vwapRaw[vwapRaw.length - 1];
    if (Number.isFinite(vwapLast) && vwapLast > 0) vwapVal = vwapLast;
  }

  return {
    rsi:           rsiVal ?? undefined,
    rsiShort:      rsiShortVal ?? undefined,
    connorsRsi:    connorsVal ?? undefined,
    sma: {
      10: Number.isFinite(sma10[lastIdx]) ? sma10[lastIdx] : NaN,
      20: Number.isFinite(sma20[lastIdx]) ? sma20[lastIdx] : NaN,
      50: Number.isFinite(sma50[lastIdx]) ? sma50[lastIdx] : NaN,
    },
    ema: {
      9:  Number.isFinite(ema9[lastIdx])  ? ema9[lastIdx]  : NaN,
      12: Number.isFinite(ema12[lastIdx]) ? ema12[lastIdx] : NaN,
      26: Number.isFinite(ema26[lastIdx]) ? ema26[lastIdx] : NaN,
    },
    bollingerBands: bbLast,
    macd:          macdLast,
    obvProxy:      Number.isFinite(obvLast) ? obvLast : undefined,
    vwapProxy:     vwapVal,
    adx:           adxVal,
    atr:           atrVal,
  };
}

// ── Public API ────────────────────────────────────────────────────────

export function getIndicatorSnapshot(mint: string, options: IndicatorOptions): IndicatorSnapshot {
  const intervalMs = options.intervalMinutes * 60_000;
  const lookbackMs = options.lookbackMinutes * 60_000;

  // ── Close series ──────────────────────────────────────────────────
  const trades      = getTradesForMint(mint);
  const tradeCloses = buildCloseSeries(trades, intervalMs, lookbackMs);

  const minCandles = options.connorsPercentRankPeriod + 1;
  let closes: number[];
  let closeSource: string;

  if (tradeCloses.length >= minCandles) {
    closes = tradeCloses;
    closeSource = 'trades';
  } else {
    const priceCloses = buildCloseSeriesFromPrices(mint, intervalMs, lookbackMs);
    if (priceCloses.length > tradeCloses.length) {
      closes = priceCloses;
      closeSource = 'price-feed';
    } else {
      closes = tradeCloses;
      closeSource = 'trades';
    }
  }

  log.debug('Indicator candles', { mint, source: closeSource, candles: closes.length, needed: minCandles });

  // ── OHLC series for ADX / ATR / VWAP ─────────────────────────────
  const adxMinCandles = 29; // 2 * ADX period (14) + 1
  const { candles: ohlcCandles, source: ohlcSource } = buildOhlcSeries(mint, intervalMs, lookbackMs, adxMinCandles);
  const adxSource: IndicatorSnapshot['adxSource'] = ohlcSource ?? 'unavailable';
  log.debug('OHLC source', { mint, adxSource, ohlcCandles: ohlcCandles.length });

  // ── Current indicators ────────────────────────────────────────────
  const current = computeIndicatorsFromSeries(closes, ohlcCandles, options);

  // ── Previous bar indicators (T-1) ────────────────────────────────
  const prevCloses = closes.length > 1 ? closes.slice(0, -1) : [];
  const prevOhlc   = ohlcCandles.length > 1 ? ohlcCandles.slice(0, -1) : [];
  const prevIndicators = prevCloses.length >= 2
    ? computeIndicatorsFromSeries(prevCloses, prevOhlc, options)
    : undefined;

  // RSI / CRSI use options.rsiPeriod (already computed inside current, but kept explicit for clarity)
  const rsi = computeRsi(closes, options.rsiPeriod);
  const connorsRsi = computeConnorsRsi(
    closes,
    options.connorsRsiPeriod,
    options.connorsStreakRsiPeriod,
    options.connorsPercentRankPeriod,
  );

  return {
    mint,
    candleIntervalMinutes: options.intervalMinutes,
    candleCount: closes.length,
    rsi:          rsi         === null ? undefined : rsi,
    connorsRsi:   connorsRsi  === null ? undefined : connorsRsi,
    rsiShort:     current?.rsiShort,
    sma:          current?.sma,
    ema:          current?.ema,
    bollingerBands: current?.bollingerBands,
    macd:         current?.macd,
    obvProxy:     current?.obvProxy,
    vwapProxy:    current?.vwapProxy,
    adx:          current?.adx,
    atr:          current?.atr,
    adxSource,
    prevIndicators,
  };
}

// ── Snapshot → IndicatorValues adapter ──────────────────────────────────────

/**
 * Accepts either a full IndicatorSnapshot or the prevIndicators sub-object (same field set).
 * IndicatorSnapshot structurally satisfies this type because it contains all the same optional
 * indicator fields (plus metadata fields the function ignores).
 */
type IndicatorValueFields = NonNullable<IndicatorSnapshot['prevIndicators']>;

export function snapshotToIndicatorValues(snapshot: IndicatorValueFields): IndicatorValues {
  return {
    rsi:           snapshot.rsi,
    rsiShort:      snapshot.rsiShort,
    connorsRsi:    snapshot.connorsRsi,
    sma:           snapshot.sma,
    ema:           snapshot.ema,
    macd:          snapshot.macd,
    bollingerBands: snapshot.bollingerBands,
    atr:           snapshot.atr,
    adx:           snapshot.adx,
    vwapProxy:     snapshot.vwapProxy,
    obvProxy:      snapshot.obvProxy,
  };
}
