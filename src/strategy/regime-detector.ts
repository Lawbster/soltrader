import { createLogger } from '../utils';
import { loadCandles } from '../backtest/data-loader';
import type { TrendRegime } from './live-strategy-map';

const log = createLogger('regime-detector');

const REFRESH_INTERVAL_MS = 30 * 60_000;   // 30 min between refreshes
const STAGGER_MS = 5_000;                  // 5s between token starts
const HYSTERESIS_CYCLES = 2;              // consecutive cycles required to confirm a regime flip
const SCORE_BUFFER = 1;                   // ±1 score buffer around thresholds — resets pendingCount
const LOW_COVERAGE_HOURS = 24;            // below this → force sideways

// Regime classification thresholds (same as sweep-candidates.ts)
const UPTREND_SCORE = 8;
const UPTREND_GATE24 = 3;
const DOWNTREND_SCORE = -6;
const DOWNTREND_GATE24 = -2;

// Weighted return formula
const WEIGHTS = { ret24h: 0.5, ret48h: 0.3, ret72h: 0.2 };

export interface RegimeData {
  trendScore: number | null;
  ret24h: number | null;
  ret48h: number | null;
  ret72h: number | null;
  coverageHours: number;
}

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

const cache = new Map<string, RegimeEntry>();
const timers: ReturnType<typeof setInterval>[] = [];

// ─── Public API ────────────────────────────────────────────────────────────

/** Start background regime refresh for a set of mints. Call once at startup. */
export function startRegimeRefresh(mints: string[]): void {
  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    // Stagger initial compute to avoid disk burst on startup
    const timer = setTimeout(() => {
      refreshTokenRegime(mint);
      const interval = setInterval(() => refreshTokenRegime(mint), REFRESH_INTERVAL_MS);
      timers.push(interval);
    }, i * STAGGER_MS);
    timers.push(timer as unknown as ReturnType<typeof setInterval>);
  }
}

/** Stop all background timers (for clean shutdown). */
export function stopRegimeRefresh(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

/** Pure cache read — no I/O. Returns null if regime not yet computed. */
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

// ─── Internal ──────────────────────────────────────────────────────────────

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

  // Load last 8 days of candles and filter to the 72h window
  const toDate = toDateStr(now);
  const fromDate = toDateStr(now - 8 * 24 * 60 * 60_000);
  const allCandles = loadCandles(mint, fromDate, toDate);
  const candles = allCandles.filter(c => c.timestamp >= now - window72h);

  if (candles.length === 0) {
    return { trendScore: null, ret24h: null, ret48h: null, ret72h: null, coverageHours: 0 };
  }

  // Coverage: count distinct 1-hour buckets
  const hourBuckets = new Set(candles.map(c => Math.floor(c.timestamp / (60 * 60_000))));
  const coverageHours = hourBuckets.size;

  const lastPrice = candles[candles.length - 1].close;

  // Returns: find closest candle to each lookback point
  const ret24h = coverageHours >= 24 ? getReturn(candles, lastPrice, now - window24h) : null;
  const ret48h = coverageHours >= 36 ? getReturn(candles, lastPrice, now - window48h) : null;
  const ret72h = coverageHours >= 60 ? getReturn(candles, lastPrice, now - window72h) : null;

  const trendScore = computeWeightedScore(ret24h, ret48h, ret72h);

  return { trendScore, ret24h, ret48h, ret72h, coverageHours };
}

function getReturn(candles: { timestamp: number; close: number }[], lastPrice: number, targetTs: number): number | null {
  // Find the candle closest to targetTs (before or at)
  let best: { timestamp: number; close: number } | null = null;
  for (const c of candles) {
    if (c.timestamp <= targetTs) best = c;
    else break;
  }
  if (!best || best.close === 0) return null;
  return ((lastPrice - best.close) / best.close) * 100;
}

function computeWeightedScore(ret24h: number | null, ret48h: number | null, ret72h: number | null): number | null {
  const parts: Array<{ v: number; w: number }> = [];
  if (ret24h !== null) parts.push({ v: ret24h, w: WEIGHTS.ret24h });
  if (ret48h !== null) parts.push({ v: ret48h, w: WEIGHTS.ret48h });
  if (ret72h !== null) parts.push({ v: ret72h, w: WEIGHTS.ret72h });
  if (parts.length === 0) return null;
  const wSum = parts.reduce((s, p) => s + p.w, 0);
  return parts.reduce((s, p) => s + p.v * p.w, 0) / wSum;
}

function classifyRegime(data: RegimeData): TrendRegime {
  if (data.coverageHours < LOW_COVERAGE_HOURS) {
    log.debug('Low coverage — defaulting to sideways', { coverageHours: data.coverageHours });
    return 'sideways';
  }

  const score = data.trendScore;
  const gate24 = data.ret24h ?? score;

  if (score !== null && gate24 !== null) {
    if (score >= UPTREND_SCORE && gate24 >= UPTREND_GATE24) return 'uptrend';
    if (score <= DOWNTREND_SCORE && gate24 <= DOWNTREND_GATE24) return 'downtrend';
  }
  return 'sideways';
}

function isNearThreshold(score: number | null): boolean {
  if (score === null) return false;
  return (
    Math.abs(score - UPTREND_SCORE) <= SCORE_BUFFER ||
    Math.abs(score - DOWNTREND_SCORE) <= SCORE_BUFFER
  );
}

function applyHysteresis(mint: string, raw: TrendRegime, data: RegimeData): void {
  const existing = cache.get(mint);

  if (!existing) {
    // First compute — commit immediately
    cache.set(mint, { confirmed: raw, pending: null, pendingCount: 0, data, lastUpdated: Date.now() });
    log.debug('Regime initialized', { mint, regime: raw, score: data.trendScore?.toFixed(2), coverageHours: data.coverageHours });
    return;
  }

  // Update data regardless of regime decision
  existing.data = data;
  existing.lastUpdated = Date.now();

  if (raw === existing.confirmed) {
    // No change — clear any pending flip
    existing.pending = null;
    existing.pendingCount = 0;
    return;
  }

  // Near a threshold boundary — reset pendingCount to prevent churn
  if (isNearThreshold(data.trendScore)) {
    existing.pending = null;
    existing.pendingCount = 0;
    return;
  }

  if (raw !== existing.pending) {
    // New candidate regime
    existing.pending = raw;
    existing.pendingCount = 1;
  } else {
    // Same candidate again
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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
