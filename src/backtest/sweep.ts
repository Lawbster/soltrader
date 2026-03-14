/**
 * Parameter sweep engine — grid search over strategy parameters.
 *
 * Usage:
 *   tsx src/backtest/sweep.ts                    # all templates x all tokens x 1-min
 *   tsx src/backtest/sweep.ts crsi               # one template
 *   tsx src/backtest/sweep.ts crsi POPCAT        # one template x one token
 *   tsx src/backtest/sweep.ts crsi POPCAT 5      # one template x one token x 5-min bars
 *   tsx src/backtest/sweep.ts --timeframe 15     # all templates x all tokens x 15-min bars
 */

import fs from 'fs';
import path from 'path';
import { BacktestStrategy, Signal, BacktestMetrics, Candle, BacktestProtectionConfig, type BacktestTrendRegime } from './types';
import { loadCandles, loadTokenList, aggregateCandles, closeSeries, highSeries, lowSeries, volumeSeries } from './data-loader';
import { runBacktest } from './engine';
import { computeMetrics } from './report';
import { fixedCost, loadEmpiricalCost } from './cost-loader';
import { computeAtr } from './indicators';
import { evaluateSignal } from '../strategy/templates/catalog';
import type { TemplateId } from '../strategy/templates/types';
import type { StrategyContext } from './types';
import { buildRegimeSeriesFromCandles } from '../strategy/regime-core';

/** Adapter: maps StrategyContext to LiveTemplateContext for catalog evaluators */
function toTemplateCtx(ctx: StrategyContext) {
  return {
    close: ctx.candle.close,
    high: ctx.candle.high,
    low: ctx.candle.low,
    open: ctx.candle.open,
    prevClose: ctx.history[ctx.index - 1]?.close,
    prevHigh: ctx.history[ctx.index - 1]?.high,
    indicators: ctx.indicators,
    prevIndicators: ctx.prevIndicators,
    hourUtc: ctx.hour,
    hasPosition: ctx.positions.length > 0,
  };
}

/** Build a thin-wrapper evaluate function that delegates to the catalog */
function catalogEvaluate(id: TemplateId, p: Record<string, number>) {
  return (ctx: StrategyContext): Signal => evaluateSignal(id, p, toTemplateCtx(ctx));
}

const SWEEP_OUT_DIR = path.resolve(__dirname, '../../data/sweep-results');

// ── Sweep result type ────────────────────────────────────────────────

interface SweepResult {
  templateName: string;
  params: Record<string, number>;
  token: string;
  timeframe: number;
  executionTimeframe: number;
  maxPositions: number;
  exitParity: 'indicator' | 'price';
  metrics: BacktestMetrics;
  trend: TrendMetrics;
  entryRegime: EntryRegimeMetrics;
}

interface TrendMetrics {
  tokenRet24hPct: number | null;
  tokenRet48hPct: number | null;
  tokenRet72hPct: number | null;
  tokenRet168hPct: number | null;
  tokenRetWindowPct: number | null;
  tokenVol24hPct: number | null;
  trendScore: number | null;
  trendRegime: 'uptrend' | 'sideways' | 'downtrend' | 'unknown';
  relRet24hVsSolPct: number | null;
  trendCoverageDays: number;
  // Context columns (Phase 1)
  windowEndHourUtc: number;      // UTC hour of last candle (0-23) — for time-of-day analysis
  windowEndDayOfWeek: number;    // UTC day-of-week of last candle (0=Sun…6=Sat)
  atrPercentile: number | null;  // ATR at last candle as percentile [0-100] of window ATR distribution
  volumeZScore: number | null;   // Z-score of last 24h pricePoints vs full-window mean
}

interface EntryRegimeMetrics {
  regime: BacktestTrendRegime;
  signalCount: number;
  coverageHours: number | null;
  ret24hPct: number | null;
  ret48hPct: number | null;
  ret72hPct: number | null;
  trendScore: number | null;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function lookbackBars(hours: number, timeframeMinutes: number): number {
  return Math.max(1, Math.round((hours * 60) / timeframeMinutes));
}

function computeReturnPct(candles: Candle[], barsBack: number): number | null {
  if (candles.length <= barsBack) return null;
  const now = candles[candles.length - 1].close;
  const then = candles[candles.length - 1 - barsBack].close;
  if (!Number.isFinite(now) || !Number.isFinite(then) || then <= 0) return null;
  return ((now / then) - 1) * 100;
}

function computeWindowReturnPct(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  return ((last / first) - 1) * 100;
}

function computeVol24hPct(candles: Candle[], timeframeMinutes: number): number | null {
  const bars = lookbackBars(24, timeframeMinutes);
  if (candles.length <= bars) return null;
  const start = candles.length - bars;
  const returns: number[] = [];
  for (let i = Math.max(1, start); i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) continue;
    returns.push(((curr / prev) - 1) * 100);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  return Math.sqrt(variance);
}

function computeAtrPercentile(candles: Candle[], timeframeMinutes: number): number | null {
  void timeframeMinutes; // unused in this function; kept for API symmetry
  if (candles.length < 15) return null;
  const highs = highSeries(candles);
  const lows = lowSeries(candles);
  const closes = closeSeries(candles);
  const atrs = computeAtr(highs, lows, closes, 14);
  const validAtrs = atrs.filter(v => Number.isFinite(v) && v > 0);
  if (validAtrs.length < 2) return null;
  const lastAtr = atrs[atrs.length - 1];
  if (!Number.isFinite(lastAtr) || lastAtr <= 0) return null;
  const sorted = [...validAtrs].sort((a, b) => a - b);
  const rank = sorted.filter(v => v <= lastAtr).length;
  return (rank / sorted.length) * 100;
}

function computeVolumeZScore(candles: Candle[], timeframeMinutes: number): number | null {
  const vols = volumeSeries(candles); // pricePoints = volume proxy
  if (vols.length < 2) return null;
  const windowMean = vols.reduce((s, v) => s + v, 0) / vols.length;
  const windowVariance = vols.reduce((s, v) => s + Math.pow(v - windowMean, 2), 0) / vols.length;
  const windowStd = Math.sqrt(windowVariance);
  if (windowStd === 0) return null;
  const bars24 = lookbackBars(24, timeframeMinutes);
  const last24 = vols.slice(-bars24);
  if (last24.length === 0) return null;
  const last24Mean = last24.reduce((s, v) => s + v, 0) / last24.length;
  return (last24Mean - windowMean) / windowStd;
}

function weightedTrendScore(ret24: number | null, ret48: number | null, ret72: number | null): number | null {
  const parts: Array<{ v: number; w: number }> = [];
  if (ret24 !== null) parts.push({ v: ret24, w: 0.5 });
  if (ret48 !== null) parts.push({ v: ret48, w: 0.3 });
  if (ret72 !== null) parts.push({ v: ret72, w: 0.2 });
  if (parts.length === 0) return null;
  const wSum = parts.reduce((s, p) => s + p.w, 0);
  if (wSum <= 0) return null;
  return parts.reduce((s, p) => s + p.v * p.w, 0) / wSum;
}

function classifyRegime(trendScore: number | null, ret24: number | null): TrendMetrics['trendRegime'] {
  if (trendScore === null) return 'unknown';
  const gate24 = ret24 ?? trendScore;
  if (trendScore >= 8 && gate24 >= 3) return 'uptrend';
  if (trendScore <= -6 && gate24 <= -2) return 'downtrend';
  return 'sideways';
}

function computeTrendMetrics(
  candles: Candle[],
  timeframeMinutes: number,
  solRet24hPct: number | null
): TrendMetrics {
  const ret24 = computeReturnPct(candles, lookbackBars(24, timeframeMinutes));
  const ret48 = computeReturnPct(candles, lookbackBars(48, timeframeMinutes));
  const ret72 = computeReturnPct(candles, lookbackBars(72, timeframeMinutes));
  const ret168 = computeReturnPct(candles, lookbackBars(168, timeframeMinutes));
  const retWindow = computeWindowReturnPct(candles);
  const vol24 = computeVol24hPct(candles, timeframeMinutes);
  const score = weightedTrendScore(ret24, ret48, ret72);
  const regime = classifyRegime(score, ret24);
  const relRet24 = ret24 !== null && solRet24hPct !== null ? ret24 - solRet24hPct : null;
  const coverageDays = candles.length >= 2
    ? (candles[candles.length - 1].timestamp - candles[0].timestamp) / 86_400_000
    : 0;

  const lastTimestamp = candles.length > 0 ? candles[candles.length - 1].timestamp : Date.now();
  const windowEndDate = new Date(lastTimestamp);
  const windowEndHourUtc = windowEndDate.getUTCHours();
  const windowEndDayOfWeek = windowEndDate.getUTCDay();
  const atrPercentile = computeAtrPercentile(candles, timeframeMinutes);
  const volumeZScore = computeVolumeZScore(candles, timeframeMinutes);

  return {
    tokenRet24hPct: ret24,
    tokenRet48hPct: ret48,
    tokenRet72hPct: ret72,
    tokenRet168hPct: ret168,
    tokenRetWindowPct: retWindow,
    tokenVol24hPct: vol24,
    trendScore: score,
    trendRegime: regime,
    relRet24hVsSolPct: relRet24,
    trendCoverageDays: coverageDays,
    windowEndHourUtc,
    windowEndDayOfWeek,
    atrPercentile,
    volumeZScore,
  };
}

interface SignalRegimePoint {
  regime: BacktestTrendRegime;
  trendScore: number | null;
  ret24h: number | null;
  ret48h: number | null;
  ret72h: number | null;
  coverageHours: number;
}

function averageNullable(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function buildSignalRegimeSeries(
  executionCandles: Candle[],
  signalCandles: Candle[],
  signalTimeframeMinutes: number,
): SignalRegimePoint[] {
  const regimeSeries = buildRegimeSeriesFromCandles(executionCandles, 60_000);
  if (signalCandles.length === 0 || regimeSeries.length === 0) return [];

  const out: SignalRegimePoint[] = [];
  const signalTfMs = signalTimeframeMinutes * 60_000;
  let regimeIdx = 0;

  for (const signalCandle of signalCandles) {
    const signalCloseMs = signalCandle.timestamp + signalTfMs;
    while (regimeIdx + 1 < regimeSeries.length && regimeSeries[regimeIdx + 1].asOfMs <= signalCloseMs) {
      regimeIdx++;
    }
    const point = regimeSeries[regimeIdx];
    out.push({
      regime: point.confirmed,
      trendScore: point.trendScore,
      ret24h: point.ret24h,
      ret48h: point.ret48h,
      ret72h: point.ret72h,
      coverageHours: point.coverageHours,
    });
  }

  return out;
}

function computeEntryRegimeMetrics(
  signalRegimes: SignalRegimePoint[],
  regime: BacktestTrendRegime,
): EntryRegimeMetrics | null {
  const matching = signalRegimes.filter(point => point.regime === regime);
  if (matching.length === 0) return null;
  return {
    regime,
    signalCount: matching.length,
    coverageHours: averageNullable(matching.map(point => point.coverageHours)),
    ret24hPct: averageNullable(matching.map(point => point.ret24h)),
    ret48hPct: averageNullable(matching.map(point => point.ret48h)),
    ret72hPct: averageNullable(matching.map(point => point.ret72h)),
    trendScore: averageNullable(matching.map(point => point.trendScore)),
  };
}

function fmtNullable(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return '';
  return value.toFixed(digits);
}

// ── Strategy templates ───────────────────────────────────────────────
// Each template is a function that takes params and returns a BacktestStrategy.
// The sweep defines which params to grid-search over.

interface SweepTemplate {
  name: string;
  paramGrid: Record<string, number[]>;
  build(params: Record<string, number>): BacktestStrategy;
}

const DEFAULT_LIVE_PROTECTION: BacktestProtectionConfig = {
  profitLockArmPct: 1,
  profitLockPct: 0.15,
  trailArmPct: 2,
  trailGapPct: 1,
  staleMaxHoldMinutes: 240,
  staleMinPnlPct: 0,
};

const SESSION_LIVE_PROTECTION: BacktestProtectionConfig = {
  profitLockArmPct: 0.8,
  profitLockPct: 0.1,
  staleMaxHoldMinutes: 180,
  staleMinPnlPct: 0,
};

function withProtection(protection: BacktestProtectionConfig): BacktestProtectionConfig {
  return { ...protection };
}

const templates: SweepTemplate[] = [
  // ── RSI(14) threshold sweep — the winning baseline ──
  {
    name: 'rsi',
    paramGrid: {
      entry: [20, 25, 30, 35],
      exit: [70, 75, 85],
      sl: [-3, -5],
      tp: [1, 3, 4, 6, 8, 10],
    },
    build(p) {
      return {
        name: `rsi-${p.entry}-${p.exit}-sl${p.sl}-tp${p.tp}`,
        description: `RSI(14) sweep entry<${p.entry} exit>${p.exit}`,
        requiredHistory: 15,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('rsi', p),
      };
    },
  },

  // Simple RSI entry with ATR-scaled exits and live-style protection.
  {
    name: 'rsi-atr-protect',
    paramGrid: {
      entry: [20, 25, 30],
      exit: [70, 75, 85],
      slAtr: [1.25, 1.5, 2],
      tpAtr: [1.5, 2, 3, 4],
    },
    build(p) {
      return {
        name: `rsi-atr-${p.entry}-${p.exit}-sl${p.slAtr}a-tp${p.tpAtr}a`,
        description: `RSI(14) entry<${p.entry} exit>${p.exit} with ATR exits`,
        requiredHistory: 15,
        stopLossAtrMult: p.slAtr,
        takeProfitAtrMult: p.tpAtr,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('rsi-atr-protect', p),
      };
    },
  },

  // ── CRSI threshold sweep ──
  {
    name: 'crsi',
    paramGrid: {
      entry: [10, 15, 20],
      exit: [90, 95],
      sl: [-3, -5],
      tp: [3, 4, 6, 8, 10],
    },
    build(p) {
      return {
        name: `crsi-${p.entry}-${p.exit}-sl${p.sl}-tp${p.tp}`,
        description: `CRSI sweep entry<${p.entry} exit>${p.exit}`,
        requiredHistory: 102,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('crsi', p),
      };
    },
  },

  // ── BB + RSI mean reversion sweep ──
  {
    name: 'bb-rsi',
    paramGrid: {
      rsiEntry: [15, 20, 25, 30, 35, 40],
      rsiExit: [50, 55, 60, 65, 70, 75, 80],
      sl: [-1, -1.5, -2, -2.5, -3],
      tp: [2, 3, 4, 6, 8],
    },
    build(p) {
      return {
        name: `bb-rsi-${p.rsiEntry}-${p.rsiExit}-sl${p.sl}-tp${p.tp}`,
        description: `BB+RSI sweep`,
        requiredHistory: 21,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('bb-rsi', p),
      };
    },
  },

  // ── RSI + CRSI confluence — both oversold required ──
  {
    name: 'rsi-crsi-confluence',
    paramGrid: {
      entryRsi:  [20, 25, 30],
      entryCrsi: [10, 15, 20],
      exitRsi:   [65, 70, 75],
      exitCrsi:  [70, 80, 90],
      sl: [-2, -3, -5],
      tp: [2, 3, 4, 6],
    },
    build(p) {
      return {
        name: `rsi-crsi-conf-r${p.entryRsi}-c${p.entryCrsi}-er${p.exitRsi}-ec${p.exitCrsi}-sl${p.sl}-tp${p.tp}`,
        description: `RSI+CRSI confluence entry<${p.entryRsi}/${p.entryCrsi} exit>${p.exitRsi}/${p.exitCrsi}`,
        requiredHistory: 102,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('rsi-crsi-confluence', p),
      };
    },
  },

  // ── CRSI dip + recover — enter on bounce, not during fall ──
  {
    name: 'crsi-dip-recover',
    paramGrid: {
      dip:     [5, 10, 15],
      recover: [20, 25, 30],
      exit:    [70, 80, 90],
      sl:      [-2, -3, -5],
      tp:      [3, 4, 6],
    },
    build(p) {
      return {
        name: `crsi-dip-rec-d${p.dip}-r${p.recover}-e${p.exit}-sl${p.sl}-tp${p.tp}`,
        description: `CRSI dip<${p.dip} recover>=${p.recover} exit>${p.exit}`,
        requiredHistory: 102,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('crsi-dip-recover', p),
      };
    },
  },

  // CRSI recovery entry with ATR-scaled exits to avoid static % stops across vol regimes.
  {
    name: 'crsi-dip-recover-atr',
    paramGrid: {
      dip:     [5, 10, 15],
      recover: [20, 25, 30],
      exit:    [70, 80, 90],
      slAtr:   [1.5, 2, 2.5],
      tpAtr:   [2, 3, 4],
    },
    build(p) {
      return {
        name: `crsi-dip-rec-atr-d${p.dip}-r${p.recover}-e${p.exit}-sl${p.slAtr}a-tp${p.tpAtr}a`,
        description: `CRSI dip<${p.dip} recover>=${p.recover} with ATR exits`,
        requiredHistory: 102,
        stopLossAtrMult: p.slAtr,
        takeProfitAtrMult: p.tpAtr,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('crsi-dip-recover-atr', p),
      };
    },
  },

  // ── Trend pullback RSI — mean-revert only above SMA50 ──
  {
    name: 'trend-pullback-rsi',
    paramGrid: {
      entry: [30, 35, 40],
      exit:  [60, 65, 70],
      sl:    [-2, -3, -5],
      tp:    [3, 4, 6, 8],
    },
    build(p) {
      return {
        name: `trend-pb-rsi-${p.entry}-${p.exit}-sl${p.sl}-tp${p.tp}`,
        description: `SMA50 trend pullback RSI entry<${p.entry} exit>${p.exit}`,
        requiredHistory: 51,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('trend-pullback-rsi', p),
      };
    },
  },

  // ── VWAP proxy reclaim + RSI gate — prevClose via ctx.history[ctx.index - 1] ──
  {
    name: 'vwap-rsi-reclaim',
    paramGrid: {
      rsiMax:  [40, 45, 50],
      exitRsi: [60, 65, 70],
      sl:      [-1.5, -2, -3],
      tp:      [2, 3, 4],
    },
    build(p) {
      return {
        name: `vwap-reclaim-rsi${p.rsiMax}-e${p.exitRsi}-sl${p.sl}-tp${p.tp}`,
        description: `VWAP proxy reclaim rsiMax<${p.rsiMax} exit>${p.exitRsi}`,
        requiredHistory: 15,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('vwap-rsi-reclaim', p),
      };
    },
  },

  // ── BB lower + RSI + CRSI triple confluence reversal ──
  {
    name: 'bb-rsi-crsi-reversal',
    paramGrid: {
      rsiEntry:  [20, 25, 30],
      crsiEntry: [10, 15, 20],
      rsiExit:   [55, 60, 65],
      sl:        [-2, -3, -5],
      tp:        [2, 3, 4],
    },
    build(p) {
      return {
        name: `bb-rsi-crsi-r${p.rsiEntry}-c${p.crsiEntry}-e${p.rsiExit}-sl${p.sl}-tp${p.tp}`,
        description: `BB lower + RSI<${p.rsiEntry} + CRSI<${p.crsiEntry} reversal exit>${p.rsiExit}`,
        requiredHistory: 102,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('bb-rsi-crsi-reversal', p),
      };
    },
  },

  // ── RSI+CRSI entry, exit at RSI midpoint (>50) — tests early-exit hypothesis ──
  {
    name: 'rsi-crsi-midpoint-exit',
    paramGrid: {
      entryRsi:  [20, 25, 30],
      entryCrsi: [10, 15, 20],
      sl:        [-2, -3, -5],
    },
    build(p) {
      return {
        name: `rsi-crsi-mid-r${p.entryRsi}-c${p.entryCrsi}-sl${p.sl}`,
        description: `RSI+CRSI entry<${p.entryRsi}/${p.entryCrsi} exit at RSI>50 midpoint`,
        requiredHistory: 102,
        stopLossPct: p.sl,
        evaluate: catalogEvaluate('rsi-crsi-midpoint-exit', p),
      };
    },
  },

  // ── Low-ADX ranging + BB lower touch + RSI oversold ──
  {
    name: 'adx-range-rsi-bb',
    paramGrid: {
      adxMax:   [20, 25],
      rsiEntry: [25, 30, 35],
      rsiExit:  [50, 60],
      sl:       [-2, -3, -5],
      tp:       [3, 4, 6],
    },
    build(p) {
      return {
        name: `adx-rng-bb-adx${p.adxMax}-r${p.rsiEntry}-e${p.rsiExit}-sl${p.sl}-tp${p.tp}`,
        description: `ADX<${p.adxMax} range + BB lower + RSI<${p.rsiEntry} exit>${p.rsiExit}`,
        requiredHistory: 21,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('adx-range-rsi-bb', p),
      };
    },
  },

  // ── ADX trend filter + EMA cross + SMA50 structure + RSI pullback entry ──
  {
    name: 'adx-trend-rsi-pullback',
    paramGrid: {
      adxMin:   [15, 20, 25],
      rsiEntry: [30, 35, 40],
      rsiExit:  [60, 65, 70],
      sl:       [-2, -3, -5],
      tp:       [3, 4, 6],
    },
    build(p) {
      return {
        name: `adx-trend-pb-adx${p.adxMin}-r${p.rsiEntry}-e${p.rsiExit}-sl${p.sl}-tp${p.tp}`,
        description: `ADX>${p.adxMin} + EMA12>26 + SMA50 + RSI pullback<${p.rsiEntry}`,
        requiredHistory: 51,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('adx-trend-rsi-pullback', p),
      };
    },
  },

  // ── MACD histogram zero-cross up + RSI momentum confirmation ──
  {
    name: 'macd-zero-rsi-confirm',
    paramGrid: {
      rsiMax:  [45, 50, 55],
      rsiExit: [60, 65, 70],
      sl:      [-2, -3, -5],
      tp:      [2, 3, 4, 6],
    },
    build(p) {
      return {
        name: `macd-zero-rsi-r${p.rsiMax}-e${p.rsiExit}-sl${p.sl}-tp${p.tp}`,
        description: `MACD histogram cross>0 + RSI<${p.rsiMax} exit>${p.rsiExit}`,
        requiredHistory: 35,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('macd-zero-rsi-confirm', p),
      };
    },
  },

  // ── MACD signal-line cross up with OBV confirmation ──
  {
    name: 'macd-signal-obv-confirm',
    paramGrid: {
      sl: [-2, -3, -5],
      tp: [2, 3, 4, 6],
    },
    build(p) {
      return {
        name: `macd-sig-obv-sl${p.sl}-tp${p.tp}`,
        description: `MACD signal cross up + OBV rising exit on reverse`,
        requiredHistory: 35,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('macd-signal-obv-confirm', p),
      };
    },
  },

  // ── BB squeeze + expansion breakout ──
  {
    name: 'bb-squeeze-breakout',
    paramGrid: {
      widthThreshold: [0.05, 0.08, 0.10],
      sl:             [-1.5, -2, -3],
      tp:             [2, 3, 4, 6],
    },
    build(p) {
      return {
        name: `bb-squeeze-w${p.widthThreshold}-sl${p.sl}-tp${p.tp}`,
        description: `BB squeeze width<${p.widthThreshold} then expansion breakout above upper`,
        requiredHistory: 21,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('bb-squeeze-breakout', p),
      };
    },
  },

  // ── VWAP trend: price above VWAP + RSI pullback entry ──
  {
    name: 'vwap-trend-pullback',
    paramGrid: {
      rsiEntry: [30, 35, 40],
      rsiExit:  [60, 65, 70],
      sl:       [-2, -3, -5],
      tp:       [3, 4, 6],
    },
    build(p) {
      return {
        name: `vwap-trend-pb-r${p.rsiEntry}-e${p.rsiExit}-sl${p.sl}-tp${p.tp}`,
        description: `Price>VWAP + RSI pullback<${p.rsiEntry} exit on VWAP loss or RSI>${p.rsiExit}`,
        requiredHistory: 15,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('vwap-trend-pullback', p),
      };
    },
  },

  // ── Low-ADX range: below-VWAP deviation + RSI oversold, revert to VWAP ──
  {
    name: 'vwap-rsi-range-revert',
    paramGrid: {
      adxMax:   [20, 25],
      rsiEntry: [25, 30, 35],
      sl:       [-2, -3, -5],
      tp:       [2, 3, 4],
    },
    build(p) {
      return {
        name: `vwap-rng-rev-adx${p.adxMax}-r${p.rsiEntry}-sl${p.sl}-tp${p.tp}`,
        description: `ADX<${p.adxMax} + below VWAP + RSI<${p.rsiEntry} mean-revert to VWAP`,
        requiredHistory: 15,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('vwap-rsi-range-revert', p),
      };
    },
  },

  // Same low-ADX VWAP reversion entry, but risk is scaled by entry ATR.
  {
    name: 'vwap-rsi-range-revert-atr',
    paramGrid: {
      adxMax:   [20, 25],
      rsiEntry: [25, 30, 35],
      slAtr:    [1.25, 1.5, 2],
      tpAtr:    [1.5, 2, 3],
    },
    build(p) {
      return {
        name: `vwap-rng-rev-atr-adx${p.adxMax}-r${p.rsiEntry}-sl${p.slAtr}a-tp${p.tpAtr}a`,
        description: `ADX<${p.adxMax} + below VWAP + RSI<${p.rsiEntry} with ATR exits`,
        requiredHistory: 15,
        stopLossAtrMult: p.slAtr,
        takeProfitAtrMult: p.tpAtr,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('vwap-rsi-range-revert-atr', p),
      };
    },
  },

  // ── CRSI oversold pullback gated by SMA50 uptrend structure ──
  {
    name: 'connors-sma50-pullback',
    paramGrid: {
      entry: [10, 15, 20],
      exit:  [70, 80, 90],
      sl:    [-2, -3, -5],
      tp:    [3, 4, 6],
    },
    build(p) {
      return {
        name: `crsi-sma50-pb-${p.entry}-${p.exit}-sl${p.sl}-tp${p.tp}`,
        description: `Close>SMA50 + CRSI<${p.entry} pullback exit on CRSI>${p.exit} or SMA break`,
        requiredHistory: 102,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('connors-sma50-pullback', p),
      };
    },
  },

  // ── RSI(2) extremes in low-ADX chop regime ──
  {
    name: 'rsi2-micro-range',
    paramGrid: {
      rsi2Entry: [5, 10, 15],
      rsi2Exit:  [85, 90, 95],
      adxMax:    [20, 25],
      sl:        [-1, -1.5, -2],
      tp:        [1, 2, 3],
    },
    build(p) {
      return {
        name: `rsi2-micro-e${p.rsi2Entry}-x${p.rsi2Exit}-adx${p.adxMax}-sl${p.sl}-tp${p.tp}`,
        description: `RSI2<${p.rsi2Entry} extreme in ADX<${p.adxMax} range exit>${p.rsi2Exit}`,
        requiredHistory: 15,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('rsi2-micro-range', p),
      };
    },
  },

  // ── ATR expansion breakout above prev high with ADX trend confirmation ──
  {
    name: 'atr-breakout-follow',
    paramGrid: {
      adxMin: [20, 25, 30],
      sl:     [-2, -3, -5],
      tp:     [3, 4, 6, 8],
    },
    build(p) {
      return {
        name: `atr-bkout-adx${p.adxMin}-sl${p.sl}-tp${p.tp}`,
        description: `Close>prevHigh breakout + ATR expanding + ADX>${p.adxMin} trend`,
        requiredHistory: 15,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate: catalogEvaluate('atr-breakout-follow', p),
      };
    },
  },
  // ── RSI oversold entry gated to a specific UTC trading session ──
  {
    name: 'rsi-session-gate',
    paramGrid: {
      entry:   [20, 25, 30],
      exit:    [70, 75, 85],
      sl:      [-3, -5],
      tp:      [1, 3, 4, 6],
      session: [0, 8, 16],   // session start hour: 0=Asia(0-8), 8=Europe(8-16), 16=US(16-24)
    },
    build(p) {
      return {
        name: `rsi-sess-s${p.session}-${p.entry}-${p.exit}-sl${p.sl}-tp${p.tp}`,
        description: `RSI(14) oversold<${p.entry} exit>${p.exit} — entry only in session UTC ${p.session}-${p.session + 8}`,
        requiredHistory: 15,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(SESSION_LIVE_PROTECTION),
        evaluate: catalogEvaluate('rsi-session-gate', p),
      };
    },
  },

  // ── CRSI oversold entry gated to a specific UTC trading session ──
  {
    name: 'crsi-session-gate',
    paramGrid: {
      entry:   [10, 15, 20],
      exit:    [90, 95],
      sl:      [-3, -5],
      tp:      [3, 4, 6],
      session: [0, 8, 16],
    },
    build(p) {
      return {
        name: `crsi-sess-s${p.session}-${p.entry}-${p.exit}-sl${p.sl}-tp${p.tp}`,
        description: `CRSI oversold<${p.entry} exit>${p.exit} — entry only in session UTC ${p.session}-${p.session + 8}`,
        requiredHistory: 102,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(SESSION_LIVE_PROTECTION),
        evaluate: catalogEvaluate('crsi-session-gate', p),
      };
    },
  },
  {
    name: 'volume-spike-reversal',
    paramGrid: {
      volZScore: [1.5, 2.0, 2.5],
      rsiEntry:  [25, 30, 35, 40],
      rsiExit:   [55, 60, 65],
      wickMin:   [0.5, 0.6, 0.7],
      sl:        [-2, -3, -5],
      tp:        [3, 4, 6],
    },
    build(p) {
      return {
        name: `vol-spike-vz${p.volZScore}-r${p.rsiEntry}-e${p.rsiExit}-w${p.wickMin}-sl${p.sl}-tp${p.tp}`,
        description: `Volume spike z>${p.volZScore} + RSI oversold<${p.rsiEntry} + bullish wick>${p.wickMin * 100}% exit RSI>${p.rsiExit}`,
        requiredHistory: 21,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('volume-spike-reversal', p),
      };
    },
  },

  // ── ADX + VWAP trend continuation — buy pullbacks inside a confirmed trend ──
  // Entry: ADX trending + close above VWAP + RSI pulled back into range.
  // Exit: close drops below VWAP or RSI extends.
  {
    name: 'adx-vwap-trend-continue',
    paramGrid: {
      adxMin:      [18, 20, 25, 30],
      rsiEntryMax: [45, 50, 55],
      rsiExit:     [60, 65, 70],
      sl:          [-2, -3, -5],
      tp:          [3, 4, 6],
    },
    build(p) {
      return {
        name: `adx-vwap-tc-adx${p.adxMin}-re${p.rsiEntryMax}-rx${p.rsiExit}-sl${p.sl}-tp${p.tp}`,
        description: `ADX>${p.adxMin} + close>VWAP + RSI<${p.rsiEntryMax}, exit VWAP break or RSI>${p.rsiExit}`,
        requiredHistory: 28,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('adx-vwap-trend-continue', p),
      };
    },
  },

  // ── BB squeeze + volume confirmation breakout ──
  // Upgrades bb-squeeze-breakout by requiring volume participation on the breakout.
  // Entry: squeeze (prev width below threshold) + expansion + close above upper + volumeZScore high.
  // Exit: close retreats below middle band.
  {
    name: 'bb-squeeze-volume-breakout',
    paramGrid: {
      widthThreshold: [0.04, 0.05, 0.06, 0.08],
      volZScoreMin:   [1.0, 1.5, 2.0],
      sl:             [-1.5, -2, -3],
      tp:             [3, 4, 6],
    },
    build(p) {
      return {
        name: `bb-sqz-vol-w${p.widthThreshold}-vz${p.volZScoreMin}-sl${p.sl}-tp${p.tp}`,
        description: `BB squeeze+vol breakout: width<${p.widthThreshold} then expand+upper+volZ>${p.volZScoreMin}`,
        requiredHistory: 21,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('bb-squeeze-volume-breakout', p),
      };
    },
  },

  // ── ATR low-vol mean reversion — mean reversion gated by range + low volatility ──
  // Distinct from atr-percentile-entry: adds ADX range gate (no entry during trending markets).
  // Entry: ATR compressed + ADX below max (range env) + RSI oversold.
  // Exit: RSI recovers or ATR re-expands.
  {
    name: 'atr-lowvol-meanrevert',
    paramGrid: {
      atrPctMax:  [20, 30],
      atrPctExit: [50, 60],
      rsiEntry:   [25, 30, 35],
      rsiExit:    [55, 65],
      adxMax:     [20, 25],
      sl:         [-2, -3, -5],
      tp:         [2, 3, 4],
    },
    build(p) {
      return {
        name: `atr-lv-mr-ap${p.atrPctMax}-ax${p.atrPctExit}-r${p.rsiEntry}-re${p.rsiExit}-adx${p.adxMax}-sl${p.sl}-tp${p.tp}`,
        description: `ATR pct<${p.atrPctMax} + ADX<${p.adxMax} (range) + RSI<${p.rsiEntry}, exit RSI>${p.rsiExit} or ATR>${p.atrPctExit}`,
        requiredHistory: 70,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('atr-lowvol-meanrevert', p),
      };
    },
  },

  // ── ATR percentile compression entry — buy the dip during low-volatility phase ──
  // Entry: ATR at low percentile (compressed) + mild RSI oversold.
  // Exit: ATR re-expands (percentile rises) or RSI recovers.
  // Codex note: restrict to uptrend/sideways — meme token compressions resolve down more often in downtrend.
  {
    name: 'atr-percentile-entry',
    paramGrid: {
      atrPctEntry: [15, 20, 25],       // compressed: ATR below this percentile
      atrPctExit:  [50, 60, 70],       // expanded: ATR above this percentile → exit
      rsiEntry:    [35, 40, 45],       // mild oversold
      rsiExit:     [55, 60, 65],       // recovered
      sl:          [-2, -3, -5],
      tp:          [3, 4, 6],
    },
    build(p) {
      return {
        name: `atr-pct-e${p.atrPctEntry}-x${p.atrPctExit}-r${p.rsiEntry}-re${p.rsiExit}-sl${p.sl}-tp${p.tp}`,
        description: `ATR pctRank<${p.atrPctEntry} compressed + RSI<${p.rsiEntry}, exit ATR>${p.atrPctExit} or RSI>${p.rsiExit}`,
        requiredHistory: 70,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        protection: withProtection(DEFAULT_LIVE_PROTECTION),
        evaluate: catalogEvaluate('atr-percentile-entry', p),
      };
    },
  },
];

const TEMPLATE_SETS: Record<string, string[]> = {
  core: [
    'rsi',
    'crsi',
    'bb-rsi',
    'rsi-crsi-confluence',
    'crsi-dip-recover',
    'vwap-rsi-range-revert',
    'rsi-session-gate',
    'crsi-session-gate',
  ],
  extended: [
    'rsi',
    'rsi-atr-protect',
    'crsi',
    'bb-rsi',
    'rsi-crsi-confluence',
    'crsi-dip-recover',
    'crsi-dip-recover-atr',
    'vwap-rsi-range-revert',
    'vwap-rsi-range-revert-atr',
    'rsi-session-gate',
    'crsi-session-gate',
    'bb-rsi-crsi-reversal',
    'adx-range-rsi-bb',
    'vwap-rsi-reclaim',
    'rsi2-micro-range',
    'bb-squeeze-breakout',
    'volume-spike-reversal',
    'atr-percentile-entry',
    'bb-squeeze-volume-breakout',
    'atr-lowvol-meanrevert',
  ],
  trend: [
    'trend-pullback-rsi',
    'adx-trend-rsi-pullback',
    'macd-zero-rsi-confirm',
    'macd-signal-obv-confirm',
    'vwap-trend-pullback',
    'connors-sma50-pullback',
    'atr-breakout-follow',
    'adx-vwap-trend-continue',
  ],
};

// ── Disabled templates (zero positive rows 2026-02-24) ────────────────────────────
// To re-enable: move the desired template object into the `templates` array above.
const _disabledTemplates: SweepTemplate[] = [
  // ── MACD + OBV momentum with SL/TP sweep ──
  {
    name: 'macd-obv',
    paramGrid: {
      sl: [-0.5, -1, -1.5, -2, -3, -5],
      tp: [1, 2, 3, 4, 6, 8, 10],
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
          if (ctx.positions.length > 0 && macd.histogram < 0 && obvProxy < prev.obvProxy) return 'sell';
          if (macd.histogram > 0 && obvProxy > prev.obvProxy) return 'buy';
          return 'hold';
        },
      };
    },
  },

  // ── RSI(2) scalp sweep ──
  {
    name: 'rsi2',
    paramGrid: {
      entry: [2, 3, 5, 10, 15, 20, 25],
      exit: [30, 40, 50, 60, 70, 80, 90],
      sl: [-0.5, -1, -1.5, -2, -3],
      tp: [1, 2, 3, 4, 6, 8],
    },
    build(p) {
      return {
        name: `rsi2-${p.entry}-${p.exit}-sl${p.sl}-tp${p.tp}`,
        description: `RSI(2) sweep`,
        requiredHistory: 5,
        stopLossPct: p.sl,
        takeProfitPct: p.tp,
        evaluate(ctx): Signal {
          const { rsiShort } = ctx.indicators;
          if (rsiShort === undefined) return 'hold';
          if (ctx.positions.length > 0 && rsiShort > p.exit) return 'sell';
          if (rsiShort < p.entry) return 'buy';
          return 'hold';
        },
      };
    },
  },

  // ── EMA trend + ADX + RSI gate sweep ──
  {
    name: 'ema-adx',
    paramGrid: {
      adxMin: [10, 15, 20, 25, 30],
      rsiLow: [30, 35, 40, 45, 50],
      rsiHigh: [55, 60, 65, 70, 75, 80],
      sl: [-1, -1.5, -2, -3],
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

          if (ctx.positions.length > 0) {
            if (ema12 < ema26) return 'sell';
            const avgEntry = ctx.positions.reduce((s, p) => s + p.entryPrice, 0) / ctx.positions.length;
            if (ctx.candle.close < avgEntry - 1.5 * atr) return 'sell';
          }
          if (ema12 > ema26 && rsi >= p.rsiLow && rsi <= p.rsiHigh && adx > p.adxMin) return 'buy';
          return 'hold';
        },
      };
    },
  },

  // ── Multi-confirm score sweep ──
  {
    name: 'multi',
    paramGrid: {
      minScore: [1, 2, 3, 4],
      sl: [-1, -1.5, -2, -3],
      tp: [1, 2, 3, 4, 6, 8],
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

          if (ctx.positions.length > 0 && bear >= p.minScore) return 'sell';
          if (bull >= p.minScore) return 'buy';
          return 'hold';
        },
      };
    },
  },
];
void _disabledTemplates; // suppress unused-variable warning

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
  const rawArgs = process.argv.slice(2);

  // Extract named flags, leave positional args intact
  let costMode: 'fixed' | 'empirical' = 'fixed';
  let fromDate: string | undefined;
  let toDate: string | undefined;
  let maxPositions = 2; // default: 2 concurrent positions per token
  let exitParity: 'indicator' | 'price' | 'both' = 'indicator';
  let timeframeFlag: number | undefined;
  let templateSet: string | undefined;
  let outFileFlag: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--cost' && rawArgs[i + 1]) { costMode = rawArgs[++i] as 'fixed' | 'empirical'; }
    else if (rawArgs[i] === '--from' && rawArgs[i + 1]) { fromDate = rawArgs[++i]; }
    else if (rawArgs[i] === '--to' && rawArgs[i + 1]) { toDate = rawArgs[++i]; }
    else if (rawArgs[i] === '--max-positions' && rawArgs[i + 1]) { maxPositions = parseInt(rawArgs[++i], 10); }
    else if (rawArgs[i] === '--exit-parity' && rawArgs[i + 1]) { exitParity = rawArgs[++i] as 'indicator' | 'price' | 'both'; }
    else if (rawArgs[i] === '--timeframe' && rawArgs[i + 1]) { timeframeFlag = parseInt(rawArgs[++i], 10); }
    else if (rawArgs[i] === '--template-set' && rawArgs[i + 1]) { templateSet = rawArgs[++i]; }
    else if (rawArgs[i] === '--out-file' && rawArgs[i + 1]) { outFileFlag = rawArgs[++i]; }
    else { positional.push(rawArgs[i]); }
  }

  const templateFilter = positional[0] || null;
  const tokenFilter = positional[1] || null;
  const timeframePositional = positional[2] ? parseInt(positional[2], 10) : undefined;
  if (timeframeFlag !== undefined && timeframePositional !== undefined && timeframeFlag !== timeframePositional) {
    console.warn(`[WARN] Both positional timeframe (${timeframePositional}) and --timeframe (${timeframeFlag}) were provided. Using --timeframe.`);
  }
  const timeframe = timeframeFlag ?? timeframePositional ?? 1;
  if (!Number.isFinite(timeframe) || timeframe < 1) {
    console.error(`Invalid timeframe: ${timeframe}. Use a positive integer (minutes).`);
    process.exit(1);
  }

  if (templateSet && !TEMPLATE_SETS[templateSet]) {
    console.error(`Unknown template set: ${templateSet}`);
    console.error(`Available template sets: ${Object.keys(TEMPLATE_SETS).join(', ')}`);
    process.exit(1);
  }

  if (templateFilter && templateSet) {
    console.warn(`[WARN] Both template filter (${templateFilter}) and --template-set (${templateSet}) were provided. Using the explicit template filter.`);
  }

  const setMembers = templateSet ? new Set(TEMPLATE_SETS[templateSet]) : null;
  const selectedTemplates = templateFilter
    ? templates.filter(t => t.name === templateFilter)
    : setMembers
      ? templates.filter(t => setMembers.has(t.name))
      : templates;

  if (selectedTemplates.length === 0) {
    if (templateFilter) {
      console.error(`Unknown template: ${templateFilter}`);
      console.error(`Available: ${templates.map(t => t.name).join(', ')}`);
    } else {
      console.error(`Template set ${templateSet} resolved to zero templates.`);
    }
    process.exit(1);
  }

  // Resolve cost config.
  // Do not silently downgrade empirical -> fixed.
  // If empirical cannot be loaded, fail fast so results are not mislabeled.
  let costCfg = fixedCost();
  if (costMode === 'empirical') {
    costCfg = loadEmpiricalCost(fromDate, toDate);
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

  // SOL baseline for relative strength metrics
  let solCandles = loadCandles(SOL_MINT, fromDate, toDate);
  if (timeframe > 1 && solCandles.length > 0) {
    solCandles = aggregateCandles(solCandles, timeframe);
  }
  const solRet24hPct = solCandles.length > 0
    ? computeReturnPct(solCandles, lookbackBars(24, timeframe))
    : null;
  if (solCandles.length === 0) {
    console.warn('[WARN] SOL candles not found for relative-return baseline.');
  }

  // Parity modes to run for each combo
  const parityModes: Array<'indicator' | 'price'> =
    exitParity === 'both' ? ['indicator', 'price'] :
    exitParity === 'price' ? ['price'] : ['indicator'];

  // Count total combos for progress
  let totalCombos = 0;
  for (const tmpl of selectedTemplates) {
    totalCombos += expandGrid(tmpl.paramGrid).length;
  }
  const regimeModesPerRun = 3;
  const totalRuns = totalCombos * parityModes.length * regimeModesPerRun;
  console.log(`Sweep: ${selectedTemplates.length} template(s) x ${tokens.length} token(s) x ${timeframe}-min bars`);
  if (templateSet && !templateFilter) {
    console.log(`Template set: ${templateSet} (${selectedTemplates.map(t => t.name).join(', ')})`);
  }
  console.log(`Cost model: ${costCfg.model} (round-trip ${costCfg.roundTripPct.toFixed(3)}%${costCfg.sampleSize ? `, n=${costCfg.sampleSize}` : ''})`);
  console.log(`Max positions per token: ${maxPositions}`);
  console.log(`Exit parity: ${exitParity}${parityModes.length > 1 ? ' (both modes run per combo)' : ''}`);
  if (fromDate || toDate) console.log(`Date range: ${fromDate ?? 'all'} → ${toDate ?? 'all'}`);
  console.log(
    `Total parameter combos per token: ${totalCombos}` +
    ` (${totalRuns} runs with dynamic regime routing${parityModes.length > 1 ? ' and both parity modes' : ''})\n`
  );

  const allResults: SweepResult[] = [];

  for (const token of tokens) {
    const executionCandles = loadCandles(token.mint, fromDate, toDate);
    if (executionCandles.length === 0) {
      console.warn(`No data for ${token.label}, skipping`);
      continue;
    }
    const signalCandles = timeframe > 1
      ? aggregateCandles(executionCandles, timeframe)
      : executionCandles;
    const trend = computeTrendMetrics(signalCandles, timeframe, solRet24hPct);
    const signalRegimes = buildSignalRegimeSeries(executionCandles, signalCandles, timeframe);
    const presentRegimes = Array.from(new Set(signalRegimes.map(point => point.regime)));
    console.log(
      `${token.label}: ${signalCandles.length} candles (${timeframe}-min signal / 1-min exec) ` +
      `| regime=${trend.trendRegime}` +
      ` score=${fmtNullable(trend.trendScore, 2) || 'n/a'}` +
      ` ret24=${fmtNullable(trend.tokenRet24hPct, 2) || 'n/a'}%` +
      ` | dynamic=${presentRegimes.join('/') || 'none'}`
    );

    let run = 0;
    for (const tmpl of selectedTemplates) {
      const grid = expandGrid(tmpl.paramGrid);
      for (const params of grid) {
        for (const parityMode of parityModes) {
          for (const regime of presentRegimes) {
            const entryRegime = computeEntryRegimeMetrics(signalRegimes, regime);
            if (!entryRegime || entryRegime.signalCount === 0) continue;

            run++;
            const strategy = tmpl.build(params);
            const result = runBacktest(signalCandles, {
              mint: token.mint,
              label: token.label,
              strategy,
              roundTripCostPct: costCfg.roundTripPct,
              maxPositions,
              exitParityMode: parityMode,
              executionCandles,
              signalTimeframeMinutes: timeframe,
              executionTimeframeMinutes: 1,
              signalRegimes: signalRegimes.map(point => point.regime),
              entryRegimeFilter: regime,
            });
            const dateRange = result.dateRange.end - result.dateRange.start;
            const metrics = computeMetrics(result.trades, dateRange);

            allResults.push({
              templateName: tmpl.name,
              params,
              token: token.label,
              timeframe,
              executionTimeframe: result.executionTimeframeMinutes,
              maxPositions,
              exitParity: parityMode,
              metrics,
              trend,
              entryRegime,
            });
          }
        }
      }
    }
    process.stdout.write(`  ${run} runs tested\n`);
  }

  // Filter to results with at least 3 trades
  const meaningful = allResults.filter(r => r.metrics.totalTrades >= 3);

  fs.mkdirSync(SWEEP_OUT_DIR, { recursive: true });
  const dateStr = new Date().toISOString().split('T')[0];
  const filterSuffix = [templateFilter, tokenFilter].filter(Boolean).join('-');
  const outPath = outFileFlag
    ? path.resolve(outFileFlag)
    : path.join(SWEEP_OUT_DIR, `${dateStr}-${timeframe}min${filterSuffix ? `-${filterSuffix}` : ''}.csv`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const csvHeader = [
    'template', 'token', 'timeframe', 'executionTimeframe', 'maxPositions', 'exitParity', 'params',
    'trades', 'winRate', 'pnlPct', 'profitFactor', 'sharpeRatio',
    'maxDrawdownPct', 'avgWinLossRatio', 'avgWinPct', 'avgLossPct',
    'avgHoldMinutes', 'tradesPerDay',
    'tokenRet24hPct', 'tokenRet48hPct', 'tokenRet72hPct', 'tokenRet168hPct',
    'tokenRetWindowPct', 'tokenVol24hPct', 'trendScore', 'trendRegime',
    'relRet24hVsSolPct', 'trendCoverageDays',
    'windowEndHourUtc', 'windowEndDayOfWeek', 'atrPercentile', 'volumeZScore',
    'entryTrendRegime', 'entryTrendScore', 'entryRet24hPct', 'entryRet48hPct', 'entryRet72hPct',
    'entryCoverageHours', 'entrySignalCount',
  ].join(',');

  if (meaningful.length === 0) {
    fs.writeFileSync(outPath, `${csvHeader}\n`, 'utf8');
    console.log('\nNo parameter combos produced 3+ trades. Need more data.');
    console.log(`Empty results saved to: ${outPath}`);
    return;
  }

  const regimeCounts = meaningful.reduce<Record<string, number>>((acc, r) => {
    acc[r.entryRegime.regime] = (acc[r.entryRegime.regime] ?? 0) + 1;
    return acc;
  }, {});
  const regimeSummary = Object.entries(regimeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([regime, count]) => `${regime}:${count}`)
    .join(' ');
  if (regimeSummary.length > 0) {
    console.log(`Regime distribution (3+ trade rows): ${regimeSummary}`);
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
    'Regime'.padEnd(11) +
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
      r.entryRegime.regime.padEnd(11) +
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
      `  ${r.templateName.padEnd(10)} ${r.token.padEnd(8)} ${r.entryRegime.regime.padEnd(10)} ${paramStr.padEnd(38)} ` +
      `${m.totalTrades}T ${m.winRate.toFixed(0)}%W ${m.totalPnlPct >= 0 ? '+' : ''}${m.totalPnlPct.toFixed(1)}% Sharpe=${m.sharpeRatio.toFixed(2)}`
    );
  }

  // Write all results to CSV
  const csvRows = meaningful.map(r => {
    const m = r.metrics;
    const t = r.trend;
    const e = r.entryRegime;
    const paramStr = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ');
    const pf = m.profitFactor === Infinity ? '' : m.profitFactor.toFixed(4);
    const wl = m.avgWinLossRatio === Infinity ? '' : m.avgWinLossRatio.toFixed(4);
    return [
      r.templateName,
      r.token,
      r.timeframe,
      r.executionTimeframe,
      r.maxPositions,
      r.exitParity,
      `"${paramStr}"`,
      m.totalTrades,
      m.winRate.toFixed(2),
      m.totalPnlPct.toFixed(4),
      pf,
      m.sharpeRatio.toFixed(4),
      m.maxDrawdownPct.toFixed(4),
      wl,
      m.avgWinPct.toFixed(4),
      m.avgLossPct.toFixed(4),
      m.avgHoldMinutes.toFixed(1),
      m.tradesPerDay.toFixed(2),
      fmtNullable(t.tokenRet24hPct, 4),
      fmtNullable(t.tokenRet48hPct, 4),
      fmtNullable(t.tokenRet72hPct, 4),
      fmtNullable(t.tokenRet168hPct, 4),
      fmtNullable(t.tokenRetWindowPct, 4),
      fmtNullable(t.tokenVol24hPct, 4),
      fmtNullable(t.trendScore, 4),
      t.trendRegime,
      fmtNullable(t.relRet24hVsSolPct, 4),
      t.trendCoverageDays.toFixed(2),
      t.windowEndHourUtc,
      t.windowEndDayOfWeek,
      fmtNullable(t.atrPercentile, 2),
      fmtNullable(t.volumeZScore, 4),
      e.regime,
      fmtNullable(e.trendScore, 4),
      fmtNullable(e.ret24hPct, 4),
      fmtNullable(e.ret48hPct, 4),
      fmtNullable(e.ret72hPct, 4),
      fmtNullable(e.coverageHours, 2),
      e.signalCount,
    ].join(',');
  });

  fs.writeFileSync(outPath, [csvHeader, ...csvRows].join('\n'), 'utf8');
  console.log(`\nFull results (${meaningful.length} rows) saved to: ${outPath}`);
}

main();
