/**
 * Parameter sweep engine — grid search over strategy parameters.
 *
 * Usage:
 *   tsx src/backtest/sweep.ts                    # all templates x all tokens x 1-min
 *   tsx src/backtest/sweep.ts crsi               # one template
 *   tsx src/backtest/sweep.ts crsi POPCAT        # one template x one token
 *   tsx src/backtest/sweep.ts crsi POPCAT 5      # one template x one token x 5-min bars
 */

import fs from 'fs';
import path from 'path';
import { BacktestStrategy, Signal, BacktestMetrics, Candle } from './types';
import { loadCandles, loadTokenList, aggregateCandles } from './data-loader';
import { runBacktest } from './engine';
import { computeMetrics } from './report';
import { fixedCost, loadEmpiricalCost } from './cost-loader';

const SWEEP_OUT_DIR = path.resolve(__dirname, '../../data/data/sweep-results');

// ── Sweep result type ────────────────────────────────────────────────

interface SweepResult {
  templateName: string;
  params: Record<string, number>;
  token: string;
  timeframe: number;
  maxPositions: number;
  exitParity: 'indicator' | 'price';
  metrics: BacktestMetrics;
  trend: TrendMetrics;
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
        evaluate(ctx): Signal {
          const { rsi } = ctx.indicators;
          if (rsi === undefined) return 'hold';
          if (ctx.positions.length > 0 && rsi > p.exit) return 'sell';
          if (rsi < p.entry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { connorsRsi } = ctx.indicators;
          if (connorsRsi === undefined) return 'hold';
          if (ctx.positions.length > 0 && connorsRsi > p.exit) return 'sell';
          if (connorsRsi < p.entry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { bollingerBands, rsi } = ctx.indicators;
          if (!bollingerBands || rsi === undefined) return 'hold';
          if (ctx.positions.length > 0 && (rsi > p.rsiExit || ctx.candle.close >= bollingerBands.upper)) return 'sell';
          if (ctx.candle.close <= bollingerBands.lower && rsi < p.rsiEntry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { rsi, connorsRsi } = ctx.indicators;
          if (rsi === undefined || connorsRsi === undefined) return 'hold';
          if (ctx.positions.length > 0 && (rsi > p.exitRsi || connorsRsi > p.exitCrsi)) return 'sell';
          if (rsi < p.entryRsi && connorsRsi < p.entryCrsi) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { connorsRsi } = ctx.indicators;
          const prev = ctx.prevIndicators;
          if (connorsRsi === undefined || prev?.connorsRsi === undefined) return 'hold';
          if (ctx.positions.length > 0 && connorsRsi > p.exit) return 'sell';
          if (prev.connorsRsi < p.dip && connorsRsi >= p.recover) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { rsi, sma } = ctx.indicators;
          if (rsi === undefined || !sma) return 'hold';
          const sma50 = sma[50];
          if (sma50 === undefined || isNaN(sma50)) return 'hold';
          if (ctx.positions.length > 0 && (rsi > p.exit || ctx.candle.close < sma50)) return 'sell';
          if (ctx.candle.close > sma50 && rsi < p.entry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { rsi, vwapProxy } = ctx.indicators;
          const prevVwap = ctx.prevIndicators?.vwapProxy;
          const prevClose = ctx.history[ctx.index - 1]?.close;
          if (rsi === undefined || vwapProxy === undefined || prevVwap === undefined || prevClose === undefined) return 'hold';
          if (ctx.positions.length > 0 && (rsi > p.exitRsi || ctx.candle.close < vwapProxy)) return 'sell';
          if (prevClose < prevVwap && ctx.candle.close >= vwapProxy && rsi < p.rsiMax) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { bollingerBands, rsi, connorsRsi } = ctx.indicators;
          if (!bollingerBands || rsi === undefined || connorsRsi === undefined) return 'hold';
          if (ctx.positions.length > 0 && (ctx.candle.close >= bollingerBands.middle || rsi > p.rsiExit)) return 'sell';
          if (ctx.candle.close <= bollingerBands.lower && rsi < p.rsiEntry && connorsRsi < p.crsiEntry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { rsi, connorsRsi } = ctx.indicators;
          if (rsi === undefined || connorsRsi === undefined) return 'hold';
          if (ctx.positions.length > 0 && rsi > 50) return 'sell';
          if (rsi < p.entryRsi && connorsRsi < p.entryCrsi) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { adx, rsi, bollingerBands } = ctx.indicators;
          if (adx === undefined || rsi === undefined || !bollingerBands) return 'hold';
          if (ctx.positions.length > 0 && (rsi > p.rsiExit || ctx.candle.close >= bollingerBands.middle)) return 'sell';
          if (adx < p.adxMax && ctx.candle.close <= bollingerBands.lower && rsi < p.rsiEntry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { adx, rsi, ema, sma } = ctx.indicators;
          if (adx === undefined || rsi === undefined || !ema || !sma) return 'hold';
          const ema12 = ema[12], ema26 = ema[26], sma50 = sma[50];
          if (ema12 === undefined || ema26 === undefined || sma50 === undefined) return 'hold';
          if (isNaN(ema12) || isNaN(ema26) || isNaN(sma50)) return 'hold';
          if (ctx.positions.length > 0 && (ema12 < ema26 || rsi > p.rsiExit)) return 'sell';
          if (adx > p.adxMin && ema12 > ema26 && ctx.candle.close > sma50 && rsi < p.rsiEntry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { macd, rsi } = ctx.indicators;
          const prev = ctx.prevIndicators;
          if (!macd || rsi === undefined || !prev?.macd) return 'hold';
          if (ctx.positions.length > 0 && (macd.histogram < 0 || rsi > p.rsiExit)) return 'sell';
          if (prev.macd.histogram < 0 && macd.histogram > 0 && rsi < p.rsiMax) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { macd, obvProxy } = ctx.indicators;
          const prev = ctx.prevIndicators;
          if (!macd || obvProxy === undefined || !prev?.macd || prev.obvProxy === undefined) return 'hold';
          if (ctx.positions.length > 0 && (macd.macd < macd.signal || obvProxy < prev.obvProxy)) return 'sell';
          if (prev.macd.macd < prev.macd.signal && macd.macd > macd.signal && obvProxy > prev.obvProxy) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { bollingerBands } = ctx.indicators;
          const prev = ctx.prevIndicators;
          if (!bollingerBands || !prev?.bollingerBands) return 'hold';
          if (ctx.positions.length > 0 && ctx.candle.close < bollingerBands.middle) return 'sell';
          if (
            prev.bollingerBands.width < p.widthThreshold &&
            bollingerBands.width > prev.bollingerBands.width &&
            ctx.candle.close > bollingerBands.upper
          ) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { rsi, vwapProxy } = ctx.indicators;
          if (rsi === undefined || vwapProxy === undefined) return 'hold';
          if (ctx.positions.length > 0 && (ctx.candle.close < vwapProxy || rsi > p.rsiExit)) return 'sell';
          if (ctx.candle.close > vwapProxy && rsi < p.rsiEntry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { adx, rsi, vwapProxy } = ctx.indicators;
          if (adx === undefined || rsi === undefined || vwapProxy === undefined) return 'hold';
          if (ctx.positions.length > 0 && ctx.candle.close >= vwapProxy) return 'sell';
          if (adx < p.adxMax && ctx.candle.close < vwapProxy && rsi < p.rsiEntry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { connorsRsi, sma } = ctx.indicators;
          if (connorsRsi === undefined || !sma) return 'hold';
          const sma50 = sma[50];
          if (sma50 === undefined || isNaN(sma50)) return 'hold';
          if (ctx.positions.length > 0 && (connorsRsi > p.exit || ctx.candle.close < sma50)) return 'sell';
          if (ctx.candle.close > sma50 && connorsRsi < p.entry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { rsiShort, adx } = ctx.indicators;
          if (rsiShort === undefined || adx === undefined) return 'hold';
          if (ctx.positions.length > 0 && rsiShort > p.rsi2Exit) return 'sell';
          if (adx < p.adxMax && rsiShort < p.rsi2Entry) return 'buy';
          return 'hold';
        },
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
        evaluate(ctx): Signal {
          const { atr, adx } = ctx.indicators;
          const prevAtr = ctx.prevIndicators?.atr;
          const prevHigh = ctx.history[ctx.index - 1]?.high;
          if (atr === undefined || adx === undefined || prevAtr === undefined || prevHigh === undefined) return 'hold';
          if (ctx.positions.length > 0 && (adx < p.adxMin || ctx.candle.close < prevHigh)) return 'sell';
          if (ctx.candle.close > prevHigh && atr > prevAtr && adx > p.adxMin) return 'buy';
          return 'hold';
        },
      };
    },
  },
];

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
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--cost' && rawArgs[i + 1]) { costMode = rawArgs[++i] as 'fixed' | 'empirical'; }
    else if (rawArgs[i] === '--from' && rawArgs[i + 1]) { fromDate = rawArgs[++i]; }
    else if (rawArgs[i] === '--to' && rawArgs[i + 1]) { toDate = rawArgs[++i]; }
    else if (rawArgs[i] === '--max-positions' && rawArgs[i + 1]) { maxPositions = parseInt(rawArgs[++i], 10); }
    else if (rawArgs[i] === '--exit-parity' && rawArgs[i + 1]) { exitParity = rawArgs[++i] as 'indicator' | 'price' | 'both'; }
    else { positional.push(rawArgs[i]); }
  }

  const templateFilter = positional[0] || null;
  const tokenFilter = positional[1] || null;
  const timeframe = parseInt(positional[2] || '1', 10);

  const selectedTemplates = templateFilter
    ? templates.filter(t => t.name === templateFilter)
    : templates;

  if (selectedTemplates.length === 0) {
    console.error(`Unknown template: ${templateFilter}`);
    console.error(`Available: ${templates.map(t => t.name).join(', ')}`);
    process.exit(1);
  }

  // Resolve cost config
  let costCfg = fixedCost();
  if (costMode === 'empirical') {
    try {
      costCfg = loadEmpiricalCost(fromDate, toDate);
    } catch (err) {
      console.error(`[WARN] ${err instanceof Error ? err.message : String(err)}`);
      console.error('[WARN] Falling back to fixed cost model.');
    }
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
  const totalRuns = totalCombos * parityModes.length;
  console.log(`Sweep: ${selectedTemplates.length} template(s) x ${tokens.length} token(s) x ${timeframe}-min bars`);
  console.log(`Cost model: ${costCfg.model} (round-trip ${costCfg.roundTripPct.toFixed(3)}%${costCfg.sampleSize ? `, n=${costCfg.sampleSize}` : ''})`);
  console.log(`Max positions per token: ${maxPositions}`);
  console.log(`Exit parity: ${exitParity}${parityModes.length > 1 ? ' (both modes run per combo)' : ''}`);
  if (fromDate || toDate) console.log(`Date range: ${fromDate ?? 'all'} → ${toDate ?? 'all'}`);
  console.log(`Total parameter combos per token: ${totalCombos}${parityModes.length > 1 ? ` (${totalRuns} runs with both parity modes)` : ''}\n`);

  const allResults: SweepResult[] = [];

  for (const token of tokens) {
    let candles = loadCandles(token.mint, fromDate, toDate);
    if (candles.length === 0) {
      console.warn(`No data for ${token.label}, skipping`);
      continue;
    }
    if (timeframe > 1) {
      candles = aggregateCandles(candles, timeframe);
    }
    const trend = computeTrendMetrics(candles, timeframe, solRet24hPct);
    console.log(
      `${token.label}: ${candles.length} candles (${timeframe}-min) ` +
      `| regime=${trend.trendRegime}` +
      ` score=${fmtNullable(trend.trendScore, 2) || 'n/a'}` +
      ` ret24=${fmtNullable(trend.tokenRet24hPct, 2) || 'n/a'}%`
    );

    let run = 0;
    for (const tmpl of selectedTemplates) {
      const grid = expandGrid(tmpl.paramGrid);
      for (const params of grid) {
        for (const parityMode of parityModes) {
          run++;
          const strategy = tmpl.build(params);
          const result = runBacktest(candles, {
            mint: token.mint,
            label: token.label,
            strategy,
            roundTripCostPct: costCfg.roundTripPct,
            maxPositions,
            exitParityMode: parityMode,
          });
          const dateRange = result.dateRange.end - result.dateRange.start;
          const metrics = computeMetrics(result.trades, dateRange);

          allResults.push({
            templateName: tmpl.name,
            params,
            token: token.label,
            timeframe,
            maxPositions,
            exitParity: parityMode,
            metrics,
            trend,
          });
        }
      }
    }
    process.stdout.write(`  ${run} runs tested\n`);
  }

  // Filter to results with at least 3 trades
  const meaningful = allResults.filter(r => r.metrics.totalTrades >= 3);

  if (meaningful.length === 0) {
    console.log('\nNo parameter combos produced 3+ trades. Need more data.');
    return;
  }

  const regimeCounts = meaningful.reduce<Record<string, number>>((acc, r) => {
    acc[r.trend.trendRegime] = (acc[r.trend.trendRegime] ?? 0) + 1;
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

  // Write all results to CSV
  fs.mkdirSync(SWEEP_OUT_DIR, { recursive: true });
  const dateStr = new Date().toISOString().split('T')[0];
  const outPath = path.join(SWEEP_OUT_DIR, `${dateStr}-${timeframe}min.csv`);

  const csvHeader = [
    'template', 'token', 'timeframe', 'maxPositions', 'exitParity', 'params',
    'trades', 'winRate', 'pnlPct', 'profitFactor', 'sharpeRatio',
    'maxDrawdownPct', 'avgWinLossRatio', 'avgWinPct', 'avgLossPct',
    'avgHoldMinutes', 'tradesPerDay',
    'tokenRet24hPct', 'tokenRet48hPct', 'tokenRet72hPct', 'tokenRet168hPct',
    'tokenRetWindowPct', 'tokenVol24hPct', 'trendScore', 'trendRegime',
    'relRet24hVsSolPct', 'trendCoverageDays',
  ].join(',');
  const csvRows = meaningful.map(r => {
    const m = r.metrics;
    const t = r.trend;
    const paramStr = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ');
    const pf = m.profitFactor === Infinity ? '' : m.profitFactor.toFixed(4);
    const wl = m.avgWinLossRatio === Infinity ? '' : m.avgWinLossRatio.toFixed(4);
    return [
      r.templateName,
      r.token,
      r.timeframe,
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
    ].join(',');
  });

  fs.writeFileSync(outPath, [csvHeader, ...csvRows].join('\n'), 'utf8');
  console.log(`\nFull results (${meaningful.length} rows) saved to: ${outPath}`);
}

main();
