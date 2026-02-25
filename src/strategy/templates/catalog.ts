/**
 * Shared template catalog — single source of truth for strategy signal logic.
 *
 * Used by:
 *  - src/backtest/sweep.ts  (via StrategyContext→LiveTemplateContext adapter)
 *  - src/strategy/rules.ts  (live entry evaluation, PR4)
 *  - src/execution/position-manager.ts (live exit evaluation, PR5)
 */

import type { Signal } from '../../backtest/types';
import type { TemplateId, LiveTemplateContext, TemplateMetadata } from './types';

// ── Evaluators ────────────────────────────────────────────────────────

type Evaluator = (p: Record<string, number>, ctx: LiveTemplateContext) => Signal;

const evaluators: Record<TemplateId, Evaluator> = {
  'rsi': (p, ctx) => {
    const { rsi } = ctx.indicators;
    if (rsi === undefined) return 'hold';
    if (ctx.hasPosition && rsi > p.exit) return 'sell';
    if (rsi < p.entry) return 'buy';
    return 'hold';
  },

  'crsi': (p, ctx) => {
    const { connorsRsi } = ctx.indicators;
    if (connorsRsi === undefined) return 'hold';
    if (ctx.hasPosition && connorsRsi > p.exit) return 'sell';
    if (connorsRsi < p.entry) return 'buy';
    return 'hold';
  },

  'bb-rsi': (p, ctx) => {
    const { bollingerBands, rsi } = ctx.indicators;
    if (!bollingerBands || rsi === undefined) return 'hold';
    if (ctx.hasPosition && (rsi > p.rsiExit || ctx.close >= bollingerBands.upper)) return 'sell';
    if (ctx.close <= bollingerBands.lower && rsi < p.rsiEntry) return 'buy';
    return 'hold';
  },

  'rsi-crsi-confluence': (p, ctx) => {
    const { rsi, connorsRsi } = ctx.indicators;
    if (rsi === undefined || connorsRsi === undefined) return 'hold';
    if (ctx.hasPosition && (rsi > p.exitRsi || connorsRsi > p.exitCrsi)) return 'sell';
    if (rsi < p.entryRsi && connorsRsi < p.entryCrsi) return 'buy';
    return 'hold';
  },

  'crsi-dip-recover': (p, ctx) => {
    const { connorsRsi } = ctx.indicators;
    const prev = ctx.prevIndicators;
    if (connorsRsi === undefined || prev?.connorsRsi === undefined) return 'hold';
    if (ctx.hasPosition && connorsRsi > p.exit) return 'sell';
    if (prev.connorsRsi < p.dip && connorsRsi >= p.recover) return 'buy';
    return 'hold';
  },

  'trend-pullback-rsi': (p, ctx) => {
    const { rsi, sma } = ctx.indicators;
    if (rsi === undefined || !sma) return 'hold';
    const sma50 = sma[50];
    if (sma50 === undefined || isNaN(sma50)) return 'hold';
    if (ctx.hasPosition && (rsi > p.exit || ctx.close < sma50)) return 'sell';
    if (ctx.close > sma50 && rsi < p.entry) return 'buy';
    return 'hold';
  },

  'vwap-rsi-reclaim': (p, ctx) => {
    const { rsi, vwapProxy } = ctx.indicators;
    const prevVwap = ctx.prevIndicators?.vwapProxy;
    const prevClose = ctx.prevClose;
    if (rsi === undefined || vwapProxy === undefined || prevVwap === undefined || prevClose === undefined) return 'hold';
    if (ctx.hasPosition && (rsi > p.exitRsi || ctx.close < vwapProxy)) return 'sell';
    if (prevClose < prevVwap && ctx.close >= vwapProxy && rsi < p.rsiMax) return 'buy';
    return 'hold';
  },

  'bb-rsi-crsi-reversal': (p, ctx) => {
    const { bollingerBands, rsi, connorsRsi } = ctx.indicators;
    if (!bollingerBands || rsi === undefined || connorsRsi === undefined) return 'hold';
    if (ctx.hasPosition && (ctx.close >= bollingerBands.middle || rsi > p.rsiExit)) return 'sell';
    if (ctx.close <= bollingerBands.lower && rsi < p.rsiEntry && connorsRsi < p.crsiEntry) return 'buy';
    return 'hold';
  },

  'rsi-crsi-midpoint-exit': (p, ctx) => {
    const { rsi, connorsRsi } = ctx.indicators;
    if (rsi === undefined || connorsRsi === undefined) return 'hold';
    if (ctx.hasPosition && rsi > 50) return 'sell';
    if (rsi < p.entryRsi && connorsRsi < p.entryCrsi) return 'buy';
    return 'hold';
  },

  'adx-range-rsi-bb': (p, ctx) => {
    const { adx, rsi, bollingerBands } = ctx.indicators;
    if (adx === undefined || rsi === undefined || !bollingerBands) return 'hold';
    if (ctx.hasPosition && (rsi > p.rsiExit || ctx.close >= bollingerBands.middle)) return 'sell';
    if (adx < p.adxMax && ctx.close <= bollingerBands.lower && rsi < p.rsiEntry) return 'buy';
    return 'hold';
  },

  'adx-trend-rsi-pullback': (p, ctx) => {
    const { adx, rsi, ema, sma } = ctx.indicators;
    if (adx === undefined || rsi === undefined || !ema || !sma) return 'hold';
    const ema12 = ema[12], ema26 = ema[26], sma50 = sma[50];
    if (ema12 === undefined || ema26 === undefined || sma50 === undefined) return 'hold';
    if (isNaN(ema12) || isNaN(ema26) || isNaN(sma50)) return 'hold';
    if (ctx.hasPosition && (ema12 < ema26 || rsi > p.rsiExit)) return 'sell';
    if (adx > p.adxMin && ema12 > ema26 && ctx.close > sma50 && rsi < p.rsiEntry) return 'buy';
    return 'hold';
  },

  'macd-zero-rsi-confirm': (p, ctx) => {
    const { macd, rsi } = ctx.indicators;
    const prev = ctx.prevIndicators;
    if (!macd || rsi === undefined || !prev?.macd) return 'hold';
    if (ctx.hasPosition && (macd.histogram < 0 || rsi > p.rsiExit)) return 'sell';
    if (prev.macd.histogram < 0 && macd.histogram > 0 && rsi < p.rsiMax) return 'buy';
    return 'hold';
  },

  'macd-signal-obv-confirm': (p, ctx) => {
    void p;
    const { macd, obvProxy } = ctx.indicators;
    const prev = ctx.prevIndicators;
    if (!macd || obvProxy === undefined || !prev?.macd || prev.obvProxy === undefined) return 'hold';
    if (ctx.hasPosition && (macd.macd < macd.signal || obvProxy < prev.obvProxy)) return 'sell';
    if (prev.macd.macd < prev.macd.signal && macd.macd > macd.signal && obvProxy > prev.obvProxy) return 'buy';
    return 'hold';
  },

  'bb-squeeze-breakout': (p, ctx) => {
    const { bollingerBands } = ctx.indicators;
    const prev = ctx.prevIndicators;
    if (!bollingerBands || !prev?.bollingerBands) return 'hold';
    if (ctx.hasPosition && ctx.close < bollingerBands.middle) return 'sell';
    if (
      prev.bollingerBands.width < p.widthThreshold &&
      bollingerBands.width > prev.bollingerBands.width &&
      ctx.close > bollingerBands.upper
    ) return 'buy';
    return 'hold';
  },

  'vwap-trend-pullback': (p, ctx) => {
    const { rsi, vwapProxy } = ctx.indicators;
    if (rsi === undefined || vwapProxy === undefined) return 'hold';
    if (ctx.hasPosition && (ctx.close < vwapProxy || rsi > p.rsiExit)) return 'sell';
    if (ctx.close > vwapProxy && rsi < p.rsiEntry) return 'buy';
    return 'hold';
  },

  'vwap-rsi-range-revert': (p, ctx) => {
    const { adx, rsi, vwapProxy } = ctx.indicators;
    if (adx === undefined || rsi === undefined || vwapProxy === undefined) return 'hold';
    if (ctx.hasPosition && ctx.close >= vwapProxy) return 'sell';
    if (adx < p.adxMax && ctx.close < vwapProxy && rsi < p.rsiEntry) return 'buy';
    return 'hold';
  },

  'connors-sma50-pullback': (p, ctx) => {
    const { connorsRsi, sma } = ctx.indicators;
    if (connorsRsi === undefined || !sma) return 'hold';
    const sma50 = sma[50];
    if (sma50 === undefined || isNaN(sma50)) return 'hold';
    if (ctx.hasPosition && (connorsRsi > p.exit || ctx.close < sma50)) return 'sell';
    if (ctx.close > sma50 && connorsRsi < p.entry) return 'buy';
    return 'hold';
  },

  'rsi2-micro-range': (p, ctx) => {
    const { rsiShort, adx } = ctx.indicators;
    if (rsiShort === undefined || adx === undefined) return 'hold';
    if (ctx.hasPosition && rsiShort > p.rsi2Exit) return 'sell';
    if (adx < p.adxMax && rsiShort < p.rsi2Entry) return 'buy';
    return 'hold';
  },

  'atr-breakout-follow': (p, ctx) => {
    const { atr, adx } = ctx.indicators;
    const prevAtr = ctx.prevIndicators?.atr;
    const prevHigh = ctx.prevHigh;
    if (atr === undefined || adx === undefined || prevAtr === undefined || prevHigh === undefined) return 'hold';
    if (ctx.hasPosition && (adx < p.adxMin || ctx.close < prevHigh)) return 'sell';
    if (ctx.close > prevHigh && atr > prevAtr && adx > p.adxMin) return 'buy';
    return 'hold';
  },

  'rsi-session-gate': (p, ctx) => {
    const { rsi } = ctx.indicators;
    if (rsi === undefined) return 'hold';
    const inSession = ctx.hourUtc >= p.session && ctx.hourUtc < p.session + 8;
    if (ctx.hasPosition && rsi > p.exit) return 'sell';
    if (inSession && rsi < p.entry) return 'buy';
    return 'hold';
  },

  'crsi-session-gate': (p, ctx) => {
    const { connorsRsi } = ctx.indicators;
    if (connorsRsi === undefined) return 'hold';
    const inSession = ctx.hourUtc >= p.session && ctx.hourUtc < p.session + 8;
    if (ctx.hasPosition && connorsRsi > p.exit) return 'sell';
    if (inSession && connorsRsi < p.entry) return 'buy';
    return 'hold';
  },
};

// ── Metadata ──────────────────────────────────────────────────────────

const metadataMap: Record<TemplateId, TemplateMetadata> = {
  'rsi':                     { id: 'rsi',                     requiredHistory: 15,  requiredIndicators: ['rsi'],                                  liveCompatible: true },
  'crsi':                    { id: 'crsi',                    requiredHistory: 102, requiredIndicators: ['connorsRsi'],                            liveCompatible: true },
  'bb-rsi':                  { id: 'bb-rsi',                  requiredHistory: 21,  requiredIndicators: ['bollingerBands', 'rsi'],                 liveCompatible: true },
  'rsi-crsi-confluence':     { id: 'rsi-crsi-confluence',     requiredHistory: 102, requiredIndicators: ['rsi', 'connorsRsi'],                     liveCompatible: true },
  'crsi-dip-recover':        { id: 'crsi-dip-recover',        requiredHistory: 102, requiredIndicators: ['connorsRsi'],                            liveCompatible: true },
  'trend-pullback-rsi':      { id: 'trend-pullback-rsi',      requiredHistory: 51,  requiredIndicators: ['rsi', 'sma'],                           liveCompatible: true },
  'vwap-rsi-reclaim':        { id: 'vwap-rsi-reclaim',        requiredHistory: 15,  requiredIndicators: ['rsi', 'vwapProxy'],                     liveCompatible: true },
  'bb-rsi-crsi-reversal':    { id: 'bb-rsi-crsi-reversal',    requiredHistory: 102, requiredIndicators: ['bollingerBands', 'rsi', 'connorsRsi'],   liveCompatible: true },
  'rsi-crsi-midpoint-exit':  { id: 'rsi-crsi-midpoint-exit',  requiredHistory: 102, requiredIndicators: ['rsi', 'connorsRsi'],                     liveCompatible: true },
  'adx-range-rsi-bb':        { id: 'adx-range-rsi-bb',        requiredHistory: 21,  requiredIndicators: ['adx', 'rsi', 'bollingerBands'],          liveCompatible: true },
  'adx-trend-rsi-pullback':  { id: 'adx-trend-rsi-pullback',  requiredHistory: 51,  requiredIndicators: ['adx', 'rsi', 'ema', 'sma'],             liveCompatible: true },
  'macd-zero-rsi-confirm':   { id: 'macd-zero-rsi-confirm',   requiredHistory: 35,  requiredIndicators: ['macd', 'rsi'],                          liveCompatible: true },
  'macd-signal-obv-confirm': { id: 'macd-signal-obv-confirm', requiredHistory: 35,  requiredIndicators: ['macd', 'obvProxy'],                      liveCompatible: true },
  'bb-squeeze-breakout':     { id: 'bb-squeeze-breakout',     requiredHistory: 21,  requiredIndicators: ['bollingerBands'],                        liveCompatible: true },
  'vwap-trend-pullback':     { id: 'vwap-trend-pullback',     requiredHistory: 15,  requiredIndicators: ['rsi', 'vwapProxy'],                     liveCompatible: true },
  'vwap-rsi-range-revert':   { id: 'vwap-rsi-range-revert',   requiredHistory: 15,  requiredIndicators: ['adx', 'rsi', 'vwapProxy'],              liveCompatible: true },
  'connors-sma50-pullback':  { id: 'connors-sma50-pullback',  requiredHistory: 102, requiredIndicators: ['connorsRsi', 'sma'],                    liveCompatible: true },
  'rsi2-micro-range':        { id: 'rsi2-micro-range',        requiredHistory: 15,  requiredIndicators: ['rsiShort', 'adx'],                      liveCompatible: true },
  'atr-breakout-follow':     { id: 'atr-breakout-follow',     requiredHistory: 15,  requiredIndicators: ['atr', 'adx'],                           liveCompatible: true },
  'rsi-session-gate':        { id: 'rsi-session-gate',        requiredHistory: 15,  requiredIndicators: ['rsi'],                                  liveCompatible: true },
  'crsi-session-gate':       { id: 'crsi-session-gate',       requiredHistory: 102, requiredIndicators: ['connorsRsi'],                            liveCompatible: true },
};

// ── Required params per template (for validation) ────────────────────

const REQUIRED_PARAMS: Record<TemplateId, string[]> = {
  'rsi':                     ['entry', 'exit'],
  'crsi':                    ['entry', 'exit'],
  'bb-rsi':                  ['rsiEntry', 'rsiExit'],
  'rsi-crsi-confluence':     ['entryRsi', 'entryCrsi', 'exitRsi', 'exitCrsi'],
  'crsi-dip-recover':        ['dip', 'recover', 'exit'],
  'trend-pullback-rsi':      ['entry', 'exit'],
  'vwap-rsi-reclaim':        ['rsiMax', 'exitRsi'],
  'bb-rsi-crsi-reversal':    ['rsiEntry', 'crsiEntry', 'rsiExit'],
  'rsi-crsi-midpoint-exit':  ['entryRsi', 'entryCrsi'],
  'adx-range-rsi-bb':        ['adxMax', 'rsiEntry', 'rsiExit'],
  'adx-trend-rsi-pullback':  ['adxMin', 'rsiEntry', 'rsiExit'],
  'macd-zero-rsi-confirm':   ['rsiMax', 'rsiExit'],
  'macd-signal-obv-confirm': [],
  'bb-squeeze-breakout':     ['widthThreshold'],
  'vwap-trend-pullback':     ['rsiEntry', 'rsiExit'],
  'vwap-rsi-range-revert':   ['adxMax', 'rsiEntry'],
  'connors-sma50-pullback':  ['entry', 'exit'],
  'rsi2-micro-range':        ['rsi2Entry', 'rsi2Exit', 'adxMax'],
  'atr-breakout-follow':     ['adxMin'],
  'rsi-session-gate':        ['entry', 'exit', 'session'],
  'crsi-session-gate':       ['entry', 'exit', 'session'],
};

// ── Public API ────────────────────────────────────────────────────────

/**
 * Evaluate a template signal given its params and live context.
 * Returns 'hold' for unknown templateId or missing required indicators.
 */
export function evaluateSignal(
  templateId: TemplateId,
  params: Record<string, number>,
  ctx: LiveTemplateContext,
): Signal {
  const evaluator = evaluators[templateId];
  if (!evaluator) return 'hold';
  return evaluator(params, ctx);
}

export function getTemplateMetadata(templateId: TemplateId): TemplateMetadata {
  return metadataMap[templateId];
}

/**
 * Validate that all required params are present and finite.
 * Returns null if valid, an error string if not.
 */
export function validateParams(templateId: TemplateId, params: Record<string, number>): string | null {
  const required = REQUIRED_PARAMS[templateId];
  if (required === undefined) return `Unknown templateId: ${templateId}`;
  const missing = required.filter(k => !(k in params) || !Number.isFinite(params[k]));
  if (missing.length > 0) return `Missing/invalid params for ${templateId}: ${missing.join(', ')}`;
  return null;
}

/** All templates that are compatible with the live engine (requires PR2 dual-source OHLC for adx/atr) */
export const LIVE_COMPATIBLE_TEMPLATES: TemplateId[] = (Object.values(metadataMap) as TemplateMetadata[])
  .filter(m => m.liveCompatible)
  .map(m => m.id);
