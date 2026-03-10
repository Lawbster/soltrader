import type { BacktestTrendRegime } from '../backtest/types';

export type TrendRegime = BacktestTrendRegime;

export const HYSTERESIS_CYCLES = 2;
export const SCORE_BUFFER = 0.5;
export const LOW_COVERAGE_HOURS = 24;
export const UPTREND_SCORE = 8;
export const UPTREND_GATE24 = 3;
export const DOWNTREND_SCORE = -6;
export const DOWNTREND_GATE24 = -2;
export const WEIGHTS = { ret24h: 0.5, ret48h: 0.3, ret72h: 0.2 };

// Intraday override thresholds (applied on top of long-term score).
// Crypto assets commonly move 7-12% intraday; these values are calibrated
// to catch genuine reversals (-7% 6h slide) vs normal meme-coin noise.
// Strong-down forces downtrend regardless of multi-day score.
// Up-side is cap-only (suppress downtrend → sideways): a +12% 6h rip during
// a confirmed downtrend is often a dead-cat bounce — never force uptrend.
export const INTRADAY_DOWN_CAP = -7;      // ret6h below this: suppress uptrend → sideways
export const INTRADAY_STRONG_DOWN = -12;  // ret6h below this: force downtrend
export const INTRADAY_UP_CAP = 7;         // ret6h above this: suppress downtrend → sideways

export interface RegimeData {
  trendScore: number | null;
  ret6h: number | null;
  ret24h: number | null;
  ret48h: number | null;
  ret72h: number | null;
  coverageHours: number;
}

export interface RegimeSeriesPoint extends RegimeData {
  asOfMs: number;
  raw: TrendRegime;
  confirmed: TrendRegime;
}

export function computeWeightedScore(ret24h: number | null, ret48h: number | null, ret72h: number | null): number | null {
  const parts: Array<{ v: number; w: number }> = [];
  if (ret24h !== null) parts.push({ v: ret24h, w: WEIGHTS.ret24h });
  if (ret48h !== null) parts.push({ v: ret48h, w: WEIGHTS.ret48h });
  if (ret72h !== null) parts.push({ v: ret72h, w: WEIGHTS.ret72h });
  if (parts.length === 0) return null;
  const wSum = parts.reduce((s, p) => s + p.w, 0);
  return parts.reduce((s, p) => s + p.v * p.w, 0) / wSum;
}

export function classifyRegime(data: RegimeData): TrendRegime {
  if (data.coverageHours < LOW_COVERAGE_HOURS) {
    return 'sideways';
  }

  const score = data.trendScore;
  const gate24 = data.ret24h ?? score;
  const ret6h = data.ret6h ?? null;

  // Long-term regime from 24h/48h/72h weighted score
  let longTerm: TrendRegime = 'sideways';
  if (score !== null && gate24 !== null) {
    if (score >= UPTREND_SCORE && gate24 >= UPTREND_GATE24) longTerm = 'uptrend';
    else if (score <= DOWNTREND_SCORE && gate24 <= DOWNTREND_GATE24) longTerm = 'downtrend';
  }

  // Intraday override: catches same-day reversals the multi-day score misses.
  // Two-level on the downside; cap-only on the upside (avoid forcing uptrend
  // into dead-cat bounces during confirmed downtrends).
  if (ret6h !== null) {
    if (ret6h <= INTRADAY_STRONG_DOWN) return 'downtrend';
    if (ret6h <= INTRADAY_DOWN_CAP && longTerm === 'uptrend') return 'sideways';
    if (ret6h >= INTRADAY_UP_CAP && longTerm === 'downtrend') return 'sideways';
  }

  return longTerm;
}

export function isNearThreshold(score: number | null): boolean {
  if (score === null) return false;
  return (
    Math.abs(score - UPTREND_SCORE) <= SCORE_BUFFER ||
    Math.abs(score - DOWNTREND_SCORE) <= SCORE_BUFFER
  );
}

export function buildRegimeSeriesFromCandles(
  candles: Array<{ timestamp: number; close: number }>,
  candleIntervalMs = 60_000,
): RegimeSeriesPoint[] {
  if (candles.length === 0) return [];

  const window72h = 72 * 60 * 60_000;
  const window48h = 48 * 60 * 60_000;
  const window24h = 24 * 60 * 60_000;

  const window6h = 6 * 60 * 60_000;

  const hourCounts = new Map<number, number>();
  const rawSeries: Array<{ asOfMs: number; data: RegimeData; raw: TrendRegime }> = [];
  let left72 = 0;
  let idx6h = -1;
  let idx24 = -1;
  let idx48 = -1;
  let idx72 = -1;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const asOfMs = candle.timestamp + candleIntervalMs;
    const hourBucket = Math.floor(candle.timestamp / (60 * 60_000));
    hourCounts.set(hourBucket, (hourCounts.get(hourBucket) ?? 0) + 1);

    while (left72 <= i && candles[left72].timestamp < asOfMs - window72h) {
      const oldHourBucket = Math.floor(candles[left72].timestamp / (60 * 60_000));
      const nextCount = (hourCounts.get(oldHourBucket) ?? 0) - 1;
      if (nextCount <= 0) {
        hourCounts.delete(oldHourBucket);
      } else {
        hourCounts.set(oldHourBucket, nextCount);
      }
      left72++;
    }

    while (idx6h + 1 <= i && candles[idx6h + 1].timestamp <= asOfMs - window6h) idx6h++;
    while (idx24 + 1 <= i && candles[idx24 + 1].timestamp <= asOfMs - window24h) idx24++;
    while (idx48 + 1 <= i && candles[idx48 + 1].timestamp <= asOfMs - window48h) idx48++;
    while (idx72 + 1 <= i && candles[idx72 + 1].timestamp <= asOfMs - window72h) idx72++;

    const coverageHours = hourCounts.size;
    const lastPrice = candle.close;
    const ret6h = coverageHours >= 6 && idx6h >= 0 && candles[idx6h].close > 0
      ? ((lastPrice - candles[idx6h].close) / candles[idx6h].close) * 100
      : null;
    const ret24h = coverageHours >= 24 && idx24 >= 0 && candles[idx24].close > 0
      ? ((lastPrice - candles[idx24].close) / candles[idx24].close) * 100
      : null;
    const ret48h = coverageHours >= 36 && idx48 >= 0 && candles[idx48].close > 0
      ? ((lastPrice - candles[idx48].close) / candles[idx48].close) * 100
      : null;
    const ret72h = coverageHours >= 60 && idx72 >= 0 && candles[idx72].close > 0
      ? ((lastPrice - candles[idx72].close) / candles[idx72].close) * 100
      : null;
    const data: RegimeData = {
      trendScore: computeWeightedScore(ret24h, ret48h, ret72h),
      ret6h,
      ret24h,
      ret48h,
      ret72h,
      coverageHours,
    };

    rawSeries.push({
      asOfMs,
      data,
      raw: classifyRegime(data),
    });
  }

  let confirmed: TrendRegime | null = null;
  let pending: TrendRegime | null = null;
  let pendingCount = 0;

  return rawSeries.map(point => {
    if (confirmed === null) {
      confirmed = point.raw;
      pending = null;
      pendingCount = 0;
    } else if (point.raw === confirmed) {
      pending = null;
      pendingCount = 0;
    } else if (isNearThreshold(point.data.trendScore)) {
      pending = null;
      pendingCount = 0;
    } else if (point.raw !== pending) {
      pending = point.raw;
      pendingCount = 1;
    } else {
      pendingCount++;
      if (pendingCount >= HYSTERESIS_CYCLES) {
        confirmed = point.raw;
        pending = null;
        pendingCount = 0;
      }
    }

    return {
      asOfMs: point.asOfMs,
      raw: point.raw,
      confirmed: confirmed ?? 'sideways',
      ...point.data,
    };
  });
}
