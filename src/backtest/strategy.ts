import { BacktestStrategy, Signal } from './types';

// ── Helpers ────────────────────────────────────────────────────────

export function crossedAbove(prev: number, curr: number, level: number): boolean {
  return prev < level && curr >= level;
}

export function crossedBelow(prev: number, curr: number, level: number): boolean {
  return prev > level && curr <= level;
}

// ── Original 4 strategies (kept for comparison) ────────────────────

export const rsiMeanReversion: BacktestStrategy = {
  name: 'rsi-mean-reversion',
  description: 'Buy when RSI(14) < 30, sell when RSI > 70',
  requiredHistory: 15,
  evaluate(ctx): Signal {
    const { rsi } = ctx.indicators;
    if (rsi === undefined) return 'hold';
    if (!ctx.position && rsi < 30) return 'buy';
    if (ctx.position && rsi > 70) return 'sell';
    return 'hold';
  },
};

export const bollingerBounce: BacktestStrategy = {
  name: 'bollinger-bounce',
  description: 'Buy at lower BB, sell at upper BB or trailing stop from peak',
  requiredHistory: 21,
  evaluate(ctx): Signal {
    const bb = ctx.indicators.bollingerBands;
    if (!bb) return 'hold';
    const price = ctx.candle.close;
    if (!ctx.position && price <= bb.lower) return 'buy';
    if (ctx.position && price >= bb.upper) return 'sell';
    if (ctx.position && ctx.position.peakPnlPct > 1) {
      const currentPnlPct = ((price - ctx.position.entryPrice) / ctx.position.entryPrice) * 100;
      if (ctx.position.peakPnlPct - currentPnlPct > 1.5) return 'sell';
    }
    return 'hold';
  },
};

export const macdRsiCombo: BacktestStrategy = {
  name: 'macd-rsi-combo',
  description: 'Buy on MACD bullish histogram when RSI < 50, sell on bearish or RSI > 75',
  requiredHistory: 30,
  evaluate(ctx): Signal {
    const { macd, rsi } = ctx.indicators;
    if (!macd || rsi === undefined) return 'hold';
    if (!ctx.position && macd.histogram > 0 && rsi < 50) return 'buy';
    if (ctx.position && (macd.histogram < 0 || rsi > 75)) return 'sell';
    return 'hold';
  },
};

// ── Live strategy replica + variants ───────────────────────────────

export const liveCrsi: BacktestStrategy = {
  name: 'live-crsi',
  description: 'CRSI(3,2,100) < 35 entry, -0.45% SL, +0.59% TP — live bot replica',
  requiredHistory: 102,
  stopLossPct: -0.45,
  takeProfitPct: 0.59,
  evaluate(ctx): Signal {
    const { connorsRsi } = ctx.indicators;
    if (connorsRsi === undefined) return 'hold';
    if (!ctx.position && connorsRsi < 35) return 'buy';
    return 'hold';
  },
};

export const crsiWider: BacktestStrategy = {
  name: 'crsi-wider',
  description: 'CRSI < 35 entry, -2% SL, +3% TP — wider targets',
  requiredHistory: 102,
  stopLossPct: -2,
  takeProfitPct: 3,
  evaluate(ctx): Signal {
    const { connorsRsi } = ctx.indicators;
    if (connorsRsi === undefined) return 'hold';
    if (!ctx.position && connorsRsi < 35) return 'buy';
    return 'hold';
  },
};

// ── Research-based CRSI strategies ─────────────────────────────────
// Sources: LuxAlgo CRSI guide, ForexTrainingGroup CRSI guide

/** CRSI + Bollinger Bands + ADX — the "textbook" combo setup.
 *  Entry: CRSI < 10 (deep oversold), ADX < 25 (ranging), close > BB middle.
 *  Exit: CRSI > 75 or price >= BB upper.
 *  Stop: -3% (ATR-based would be better but needs more data). */
export const crsiBbAdx: BacktestStrategy = {
  name: 'crsi-bb-adx',
  description: 'CRSI < 10 + ADX < 25 + close > BB mid → textbook mean reversion',
  requiredHistory: 102,
  stopLossPct: -3,
  evaluate(ctx): Signal {
    const { connorsRsi, adx, bollingerBands } = ctx.indicators;
    if (connorsRsi === undefined || adx === undefined || !bollingerBands) return 'hold';

    if (!ctx.position) {
      // Deep oversold + ranging market + price recovering above midline
      if (connorsRsi < 10 && adx < 25 && ctx.candle.close > bollingerBands.middle) {
        return 'buy';
      }
    }

    if (ctx.position) {
      if (connorsRsi > 75 || ctx.candle.close >= bollingerBands.upper) return 'sell';
    }
    return 'hold';
  },
};

/** CRSI dip-and-recover: CRSI was recently < 10, now crossing back above 20.
 *  This is the "confirmed momentum reversal" signal from the research.
 *  Exit: CRSI > 70. Stop: -2.5%. */
export const crsiDipRecover: BacktestStrategy = {
  name: 'crsi-dip-recover',
  description: 'CRSI dips below 10, recovers above 20 → momentum reversal',
  requiredHistory: 102,
  stopLossPct: -2.5,
  evaluate(ctx): Signal {
    const curr = ctx.indicators.connorsRsi;
    const prev = ctx.prevIndicators?.connorsRsi;
    if (curr === undefined || prev === undefined) return 'hold';

    if (!ctx.position) {
      // Previous bar was below 20 (recently deeply oversold), now crossing above 20
      if (prev < 20 && curr >= 20) return 'buy';
    }

    if (ctx.position && curr > 70) return 'sell';
    return 'hold';
  },
};

/** CRSI trend-pullback: only buy pullbacks when the bigger trend is up (price > SMA50).
 *  Entry: CRSI < 15 + price > SMA50. Exit: CRSI > 70 or price < SMA50. */
export const crsiTrendPullback: BacktestStrategy = {
  name: 'crsi-trend-pullback',
  description: 'CRSI < 15 pullback in uptrend (price > SMA50), exit CRSI > 70',
  requiredHistory: 102,
  stopLossPct: -3,
  evaluate(ctx): Signal {
    const { connorsRsi, sma } = ctx.indicators;
    if (connorsRsi === undefined || !sma) return 'hold';
    const sma50 = sma[50];
    if (sma50 === undefined || isNaN(sma50)) return 'hold';

    if (!ctx.position) {
      if (connorsRsi < 15 && ctx.candle.close > sma50) return 'buy';
    }

    if (ctx.position) {
      if (connorsRsi > 70 || ctx.candle.close < sma50) return 'sell';
    }
    return 'hold';
  },
};

// ── Research-based RSI(2) scalping strategies ──────────────────────
// Source: mc2.fi RSI scalping guide, fxopen 1-min strategies

/** RSI(2) + Bollinger + EMA(9) — the 1-min crypto scalp setup.
 *  Entry: RSI(2) drops below 20, crosses back above 20, price > EMA9, price near lower BB.
 *  Exit: RSI(2) > 50 (mean reversion midpoint) or price > BB middle.
 *  Stop: -1.5%. */
export const rsi2BbScalp: BacktestStrategy = {
  name: 'rsi2-bb-scalp',
  description: 'RSI(2) < 20 recover + near lower BB + EMA9 filter → scalp',
  requiredHistory: 21,
  stopLossPct: -1.5,
  evaluate(ctx): Signal {
    const { rsiShort, bollingerBands, ema } = ctx.indicators;
    const prevRsi = ctx.prevIndicators?.rsiShort;
    if (rsiShort === undefined || prevRsi === undefined || !bollingerBands || !ema) return 'hold';
    const ema9 = ema[9];
    if (ema9 === undefined || isNaN(ema9)) return 'hold';

    if (!ctx.position) {
      // RSI(2) was below 20, now crossing back above + price above EMA9 + near lower BB zone
      const nearLowerBB = ctx.candle.close < bollingerBands.middle;
      if (prevRsi < 20 && rsiShort >= 20 && ctx.candle.close > ema9 && nearLowerBB) {
        return 'buy';
      }
    }

    if (ctx.position) {
      // Exit at RSI(2) > 50 or price above BB middle
      if (rsiShort > 50 || ctx.candle.close > bollingerBands.middle) return 'sell';
    }
    return 'hold';
  },
};

/** RSI(2) extreme bounce with wider targets.
 *  Entry: RSI(2) < 10 (extreme). Exit: RSI(2) > 65. Stop: -2%. */
export const rsi2ExtremeBounce: BacktestStrategy = {
  name: 'rsi2-extreme',
  description: 'RSI(2) < 10 extreme oversold, exit at RSI > 65',
  requiredHistory: 5,
  stopLossPct: -2,
  evaluate(ctx): Signal {
    const { rsiShort } = ctx.indicators;
    if (rsiShort === undefined) return 'hold';

    if (!ctx.position && rsiShort < 10) return 'buy';
    if (ctx.position && rsiShort > 65) return 'sell';
    return 'hold';
  },
};

// ── VWAP + indicator strategies ────────────────────────────────────

/** VWAP bounce + RSI confirmation: buy when price crosses above VWAP from below
 *  with RSI < 45 (room to run), sell when RSI > 65 or price drops below VWAP. */
export const vwapRsiBounce: BacktestStrategy = {
  name: 'vwap-rsi-bounce',
  description: 'Price crosses above VWAP + RSI < 45, exit RSI > 65 or below VWAP',
  requiredHistory: 15,
  stopLossPct: -2,
  evaluate(ctx): Signal {
    const { rsi, vwapProxy } = ctx.indicators;
    const prev = ctx.prevIndicators;
    if (rsi === undefined || vwapProxy === undefined || !prev || prev.vwapProxy === undefined) return 'hold';

    const prevPrice = ctx.history[ctx.index - 1]?.close;
    if (!prevPrice) return 'hold';

    if (!ctx.position) {
      // Price crosses above VWAP from below + RSI has room to run
      if (prevPrice < prev.vwapProxy && ctx.candle.close > vwapProxy && rsi < 45) {
        return 'buy';
      }
    }

    if (ctx.position) {
      if (rsi > 65 || ctx.candle.close < vwapProxy) return 'sell';
    }
    return 'hold';
  },
};

// ── Bollinger + momentum combos ────────────────────────────────────

/** BB squeeze + MACD + OBV: volatility compression breakout with momentum confirmation.
 *  Entry: BB width narrowing, MACD histogram flips positive, OBV rising.
 *  Exit: price hits BB upper or MACD flips negative. Stop: -2%. */
export const bbSqueezeMomentum: BacktestStrategy = {
  name: 'bb-squeeze-momentum',
  description: 'BB squeeze + MACD positive flip + OBV rising → breakout',
  requiredHistory: 30,
  stopLossPct: -2,
  evaluate(ctx): Signal {
    const { bollingerBands, macd, obvProxy } = ctx.indicators;
    const prev = ctx.prevIndicators;
    if (!bollingerBands || !macd || !prev?.bollingerBands || !prev?.macd || obvProxy === undefined || prev.obvProxy === undefined) return 'hold';

    if (!ctx.position) {
      const squeezing = bollingerBands.width < prev.bollingerBands.width;
      const macdFlipBullish = prev.macd.histogram <= 0 && macd.histogram > 0;
      const obvRising = obvProxy > prev.obvProxy;

      if (squeezing && macdFlipBullish && obvRising) return 'buy';
    }

    if (ctx.position) {
      if (ctx.candle.close >= bollingerBands.upper || macd.histogram < 0) return 'sell';
    }
    return 'hold';
  },
};

/** BB + RSI(14) mean reversion: price at lower band + RSI confirms oversold.
 *  Exit at BB middle. Classic and clean. */
export const bbRsiMeanRevert: BacktestStrategy = {
  name: 'bb-rsi-mean-revert',
  description: 'Price <= lower BB + RSI < 30 → buy, exit at BB middle',
  requiredHistory: 21,
  stopLossPct: -2.5,
  evaluate(ctx): Signal {
    const { bollingerBands, rsi } = ctx.indicators;
    if (!bollingerBands || rsi === undefined) return 'hold';

    if (!ctx.position && ctx.candle.close <= bollingerBands.lower && rsi < 30) {
      return 'buy';
    }

    if (ctx.position && ctx.candle.close >= bollingerBands.middle) return 'sell';
    return 'hold';
  },
};

// ── MACD + volume strategies ───────────────────────────────────────

/** MACD histogram flip + OBV rising — trend momentum confirmation */
export const macdObvMomentum: BacktestStrategy = {
  name: 'macd-obv-momentum',
  description: 'MACD histogram positive + OBV rising, exit on both reversing',
  requiredHistory: 30,
  stopLossPct: -2,
  evaluate(ctx): Signal {
    const { macd, obvProxy } = ctx.indicators;
    const prev = ctx.prevIndicators;
    if (!macd || !prev?.macd || obvProxy === undefined || prev.obvProxy === undefined) return 'hold';

    if (!ctx.position && macd.histogram > 0 && obvProxy > prev.obvProxy) return 'buy';
    if (ctx.position && macd.histogram < 0 && obvProxy < prev.obvProxy) return 'sell';
    return 'hold';
  },
};

/** EMA 12/26 crossover with ATR-based dynamic stop */
export const emaCrossAtr: BacktestStrategy = {
  name: 'ema-cross-atr',
  description: 'EMA12/26 crossover entry, sell on bearish cross or price < entry - 2*ATR',
  requiredHistory: 30,
  evaluate(ctx): Signal {
    const { ema, atr } = ctx.indicators;
    const prev = ctx.prevIndicators;
    if (!ema || !prev?.ema || atr === undefined) return 'hold';

    const ema12 = ema[12], ema26 = ema[26];
    const prevEma12 = prev.ema?.[12], prevEma26 = prev.ema?.[26];
    if ([ema12, ema26, prevEma12, prevEma26].some(v => v === undefined || isNaN(v!))) return 'hold';

    if (!ctx.position && prevEma12! <= prevEma26! && ema12 > ema26) return 'buy';

    if (ctx.position) {
      if (prevEma12! >= prevEma26! && ema12 < ema26) return 'sell';
      if (ctx.candle.close < ctx.position.entryPrice - 2 * atr) return 'sell';
    }
    return 'hold';
  },
};

// ── Multi-indicator scoring ────────────────────────────────────────

/** Score-based: buy when 3+ of RSI/CRSI/MACD/SMA20/OBV align bullish */
export const multiConfirm: BacktestStrategy = {
  name: 'multi-confirm',
  description: 'Buy when 3+ of RSI/CRSI/MACD/SMA20/OBV align bullish, TP/SL exits',
  requiredHistory: 102,
  stopLossPct: -2,
  takeProfitPct: 4,
  evaluate(ctx): Signal {
    const { rsi, connorsRsi, macd, sma, obvProxy } = ctx.indicators;
    const prev = ctx.prevIndicators;
    if (!macd || rsi === undefined || connorsRsi === undefined || !sma || obvProxy === undefined) return 'hold';

    let bullScore = 0;
    let bearScore = 0;

    if (rsi < 40) bullScore++; else if (rsi > 60) bearScore++;
    if (connorsRsi < 40) bullScore++; else if (connorsRsi > 60) bearScore++;
    if (macd.histogram > 0) bullScore++; else bearScore++;
    const sma20 = sma[20];
    if (sma20 && ctx.candle.close > sma20) bullScore++; else bearScore++;
    if (prev?.obvProxy !== undefined && obvProxy > prev.obvProxy) bullScore++; else bearScore++;

    if (!ctx.position && bullScore >= 3) return 'buy';
    if (ctx.position && bearScore >= 3) return 'sell';
    return 'hold';
  },
};

// ── Time-of-day filtered strategies ────────────────────────────────

/** Live CRSI but only enters during US market hours (14-22 UTC) */
export const usHoursCrsi: BacktestStrategy = {
  name: 'us-hours-crsi',
  description: 'CRSI < 35 only 14-22 UTC (US session), -0.45% SL, +0.59% TP',
  requiredHistory: 102,
  stopLossPct: -0.45,
  takeProfitPct: 0.59,
  evaluate(ctx): Signal {
    const { connorsRsi } = ctx.indicators;
    if (connorsRsi === undefined) return 'hold';
    if (!ctx.position && connorsRsi < 35 && ctx.hour >= 14 && ctx.hour < 22) return 'buy';
    return 'hold';
  },
};

/** Live CRSI but only enters during European hours (07-16 UTC) */
export const euroHoursCrsi: BacktestStrategy = {
  name: 'euro-hours-crsi',
  description: 'CRSI < 35 only 07-16 UTC (EU session), -0.45% SL, +0.59% TP',
  requiredHistory: 102,
  stopLossPct: -0.45,
  takeProfitPct: 0.59,
  evaluate(ctx): Signal {
    const { connorsRsi } = ctx.indicators;
    if (connorsRsi === undefined) return 'hold';
    if (!ctx.position && connorsRsi < 35 && ctx.hour >= 7 && ctx.hour < 16) return 'buy';
    return 'hold';
  },
};

// ── Codex research strategies (Reddit algotrading) ───────────────
// Sources: r/algotrading, r/Daytrading — combined-indicator trend strategies

/** SMA + EMA + RSI + ADX trend-following from Reddit algotrading.
 *  Entry: Close > SMA50 (uptrend) + Close > EMA9 (short momentum) + RSI(2) > ADX(14).
 *  Exit: RSI(2) < ADX(14) or Close < SMA50. Stop: -2.5%. */
export const smEmaRsiAdx: BacktestStrategy = {
  name: 'sma-ema-rsi-adx',
  description: 'Close>SMA50 + Close>EMA9 + RSI(2)>ADX → trend entry',
  requiredHistory: 51,
  stopLossPct: -2.5,
  evaluate(ctx): Signal {
    const { sma, ema, rsiShort, adx } = ctx.indicators;
    if (!sma || !ema || rsiShort === undefined || adx === undefined) return 'hold';
    const sma50 = sma[50];
    const ema9 = ema[9];
    if (sma50 === undefined || isNaN(sma50) || ema9 === undefined || isNaN(ema9)) return 'hold';

    if (!ctx.position) {
      if (ctx.candle.close > sma50 && ctx.candle.close > ema9 && rsiShort > adx) {
        return 'buy';
      }
    }

    if (ctx.position) {
      if (rsiShort < adx || ctx.candle.close < sma50) return 'sell';
    }
    return 'hold';
  },
};

/** Bollinger + VWAP + ADX + RSI breakout from Reddit.
 *  Uses non-standard BB(42, 2.5) for wider bands.
 *  Entry: Close breaks above BB upper + Close > VWAP + ADX > 20 (trending) + RSI < 70.
 *  Exit: Close < BB middle or RSI > 80. Stop: -3%. */
export const bbVwapAdxBreakout: BacktestStrategy = {
  name: 'bb-vwap-adx-breakout',
  description: 'BB(20,2) upper breakout + VWAP + ADX>20 + RSI<70',
  requiredHistory: 30,
  stopLossPct: -3,
  evaluate(ctx): Signal {
    const { bollingerBands, vwapProxy, adx, rsi } = ctx.indicators;
    if (!bollingerBands || vwapProxy === undefined || adx === undefined || rsi === undefined) return 'hold';

    if (!ctx.position) {
      // Breaking above upper BB from below + trending + not overbought + above VWAP
      const prevClose = ctx.history[ctx.index - 1]?.close;
      if (prevClose && prevClose <= bollingerBands.upper &&
          ctx.candle.close > bollingerBands.upper &&
          ctx.candle.close > vwapProxy &&
          adx > 20 && rsi < 70) {
        return 'buy';
      }
    }

    if (ctx.position) {
      if (ctx.candle.close < bollingerBands.middle || rsi > 80) return 'sell';
    }
    return 'hold';
  },
};

/** EMA trend + RSI gate + ADX gate + ATR dynamic exits from Reddit.
 *  Entry: EMA12 > EMA26 (bullish) + RSI between 40-65 (room to run) + ADX > 20.
 *  Exit: EMA12 < EMA26 or price drops below entry - 1.5*ATR.
 *  No fixed stop — ATR handles it dynamically. */
export const emaTrendAdxAtr: BacktestStrategy = {
  name: 'ema-trend-adx-atr',
  description: 'EMA12>26 + RSI 40-65 + ADX>20 → trend, ATR trailing exit',
  requiredHistory: 30,
  evaluate(ctx): Signal {
    const { ema, rsi, adx, atr } = ctx.indicators;
    if (!ema || rsi === undefined || adx === undefined || atr === undefined) return 'hold';
    const ema12 = ema[12], ema26 = ema[26];
    if (ema12 === undefined || ema26 === undefined || isNaN(ema12) || isNaN(ema26)) return 'hold';

    if (!ctx.position) {
      if (ema12 > ema26 && rsi >= 40 && rsi <= 65 && adx > 20) {
        return 'buy';
      }
    }

    if (ctx.position) {
      // Bearish EMA cross or ATR-based stop
      if (ema12 < ema26) return 'sell';
      if (ctx.candle.close < ctx.position.entryPrice - 1.5 * atr) return 'sell';
    }
    return 'hold';
  },
};

// ── Strategy registry ──────────────────────────────────────────────

export const STRATEGIES: Record<string, BacktestStrategy> = {
  // Original (comparison baselines)
  'rsi-mean-reversion': rsiMeanReversion,
  'bollinger-bounce': bollingerBounce,
  'macd-rsi-combo': macdRsiCombo,
  // Live replica + variant
  'live-crsi': liveCrsi,
  'crsi-wider': crsiWider,
  // Research-based CRSI (LuxAlgo + ForexTraining guides)
  'crsi-bb-adx': crsiBbAdx,
  'crsi-dip-recover': crsiDipRecover,
  'crsi-trend-pullback': crsiTrendPullback,
  // RSI(2) scalping (mc2.fi, fxopen research)
  'rsi2-bb-scalp': rsi2BbScalp,
  'rsi2-extreme': rsi2ExtremeBounce,
  // VWAP
  'vwap-rsi-bounce': vwapRsiBounce,
  // Bollinger combos
  'bb-squeeze-momentum': bbSqueezeMomentum,
  'bb-rsi-mean-revert': bbRsiMeanRevert,
  // MACD + momentum
  'macd-obv-momentum': macdObvMomentum,
  'ema-cross-atr': emaCrossAtr,
  // Multi-indicator
  'multi-confirm': multiConfirm,
  // Time-of-day
  'us-hours-crsi': usHoursCrsi,
  'euro-hours-crsi': euroHoursCrsi,
  // Codex research (Reddit algotrading)
  'sma-ema-rsi-adx': smEmaRsiAdx,
  'bb-vwap-adx-breakout': bbVwapAdxBreakout,
  'ema-trend-adx-atr': emaTrendAdxAtr,
};
