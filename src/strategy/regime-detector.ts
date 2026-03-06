import { createLogger } from '../utils';
import { loadCandles } from '../backtest/data-loader';
import type { TrendRegime } from './live-strategy-map';
import {
  HYSTERESIS_CYCLES,
  computeWeightedScore,
  classifyRegime,
  isNearThreshold,
  type RegimeData,
  type RegimeSeriesPoint,
  buildRegimeSeriesFromCandles,
} from './regime-core';

const log = createLogger('regime-detector');

const REFRESH_INTERVAL_MS = 10 * 60_000;
const STAGGER_MS = 5_000;

interface RegimeEntry {
  confirmed: TrendRegime;
  pending: TrendRegime | null;
  pendingCount: number;
  data: RegimeData;
  lastUpdated: number;
}

export interface RegimeState {
  confirmed: TrendRegime;
  trendScore: number | null;
  ret24h: number | null;
  ret48h: number | null;
  ret72h: number | null;
  coverageHours: number;
  lastUpdated: number;
}

export type { RegimeData, RegimeSeriesPoint };
export { buildRegimeSeriesFromCandles };

const cache = new Map<string, RegimeEntry>();
const timers: ReturnType<typeof setInterval>[] = [];

export function startRegimeRefresh(mints: string[]): void {
  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    const timer = setTimeout(() => {
      refreshTokenRegime(mint);
      const interval = setInterval(() => refreshTokenRegime(mint), REFRESH_INTERVAL_MS);
      timers.push(interval);
    }, i * STAGGER_MS);
    timers.push(timer as unknown as ReturnType<typeof setInterval>);
  }
}

export function stopRegimeRefresh(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

export function getTokenRegimeCached(mint: string): RegimeState | null {
  const entry = cache.get(mint);
  if (!entry) return null;
  return {
    confirmed: entry.confirmed,
    trendScore: entry.data.trendScore,
    ret24h: entry.data.ret24h,
    ret48h: entry.data.ret48h,
    ret72h: entry.data.ret72h,
    coverageHours: entry.data.coverageHours,
    lastUpdated: entry.lastUpdated,
  };
}

function refreshTokenRegime(mint: string): void {
  try {
    const data = computeRegimeData(mint);
    const raw = classifyRegime(data);
    applyHysteresis(mint, raw, data);
  } catch (err) {
    log.warn('Regime refresh failed', { mint, error: err instanceof Error ? err.message : String(err) });
  }
}

function computeRegimeData(mint: string): RegimeData {
  const now = Date.now();
  const window72h = 72 * 60 * 60_000;
  const window48h = 48 * 60 * 60_000;
  const window24h = 24 * 60 * 60_000;

  const toDate = toDateStr(now);
  const fromDate = toDateStr(now - 8 * 24 * 60 * 60_000);
  const allCandles = loadCandles(mint, fromDate, toDate);
  const candles = allCandles.filter(c => c.timestamp >= now - window72h);

  if (candles.length === 0) {
    return { trendScore: null, ret24h: null, ret48h: null, ret72h: null, coverageHours: 0 };
  }

  const hourBuckets = new Set(candles.map(c => Math.floor(c.timestamp / (60 * 60_000))));
  const coverageHours = hourBuckets.size;
  const lastPrice = candles[candles.length - 1].close;

  const ret24h = coverageHours >= 24 ? getReturn(candles, lastPrice, now - window24h) : null;
  const ret48h = coverageHours >= 36 ? getReturn(candles, lastPrice, now - window48h) : null;
  const ret72h = coverageHours >= 60 ? getReturn(candles, lastPrice, now - window72h) : null;

  return {
    trendScore: computeWeightedScore(ret24h, ret48h, ret72h),
    ret24h,
    ret48h,
    ret72h,
    coverageHours,
  };
}

function getReturn(candles: { timestamp: number; close: number }[], lastPrice: number, targetTs: number): number | null {
  let best: { timestamp: number; close: number } | null = null;
  for (const candle of candles) {
    if (candle.timestamp <= targetTs) best = candle;
    else break;
  }
  if (!best || best.close === 0) return null;
  return ((lastPrice - best.close) / best.close) * 100;
}

function applyHysteresis(mint: string, raw: TrendRegime, data: RegimeData): void {
  const existing = cache.get(mint);

  if (!existing) {
    cache.set(mint, { confirmed: raw, pending: null, pendingCount: 0, data, lastUpdated: Date.now() });
    log.debug('Regime initialized', { mint, regime: raw, score: data.trendScore?.toFixed(2), coverageHours: data.coverageHours });
    return;
  }

  existing.data = data;
  existing.lastUpdated = Date.now();

  if (raw === existing.confirmed) {
    existing.pending = null;
    existing.pendingCount = 0;
    return;
  }

  if (isNearThreshold(data.trendScore)) {
    existing.pending = null;
    existing.pendingCount = 0;
    return;
  }

  if (raw !== existing.pending) {
    existing.pending = raw;
    existing.pendingCount = 1;
  } else {
    existing.pendingCount++;
    if (existing.pendingCount >= HYSTERESIS_CYCLES) {
      const prev = existing.confirmed;
      existing.confirmed = raw;
      existing.pending = null;
      existing.pendingCount = 0;
      log.info('Regime transition', {
        mint,
        from: prev,
        to: raw,
        score: data.trendScore?.toFixed(2),
        ret24h: data.ret24h?.toFixed(2),
        ret48h: data.ret48h?.toFixed(2),
        ret72h: data.ret72h?.toFixed(2),
        coverageHours: data.coverageHours,
      });
    }
  }
}

function toDateStr(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
