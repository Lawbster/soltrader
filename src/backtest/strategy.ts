import { BacktestStrategy, StrategyContext, Signal } from './types';

export function crossedAbove(prev: number, curr: number, level: number): boolean {
  return prev < level && curr >= level;
}

export function crossedBelow(prev: number, curr: number, level: number): boolean {
  return prev > level && curr <= level;
}

/** RSI mean-reversion: buy oversold, sell overbought */
export const rsiMeanReversion: BacktestStrategy = {
  name: 'rsi-mean-reversion',
  description: 'Buy when RSI < 30, sell when RSI > 70',
  requiredHistory: 15,
  evaluate(ctx: StrategyContext): Signal {
    const { rsi } = ctx.indicators;
    if (rsi === undefined) return 'hold';

    if (!ctx.position && rsi < 30) return 'buy';
    if (ctx.position && rsi > 70) return 'sell';
    return 'hold';
  },
};

/** SMA crossover: buy when price crosses above SMA20, sell when crosses below */
export const smaCrossover: BacktestStrategy = {
  name: 'sma-crossover',
  description: 'Buy when close crosses above SMA20, sell when crosses below',
  requiredHistory: 21,
  evaluate(ctx: StrategyContext): Signal {
    const sma20 = ctx.indicators.sma?.[20];
    if (sma20 === undefined || isNaN(sma20) || ctx.index < 1) return 'hold';

    const prevClose = ctx.history[ctx.index - 1].close;

    if (!ctx.position && prevClose < sma20 && ctx.candle.close >= sma20) return 'buy';
    if (ctx.position && prevClose > sma20 && ctx.candle.close <= sma20) return 'sell';
    return 'hold';
  },
};

/** Bollinger Band bounce: buy at lower band, sell at upper band + trailing stop */
export const bollingerBounce: BacktestStrategy = {
  name: 'bollinger-bounce',
  description: 'Buy at lower BB, sell at upper BB or trailing stop from peak',
  requiredHistory: 21,
  evaluate(ctx: StrategyContext): Signal {
    const bb = ctx.indicators.bollingerBands;
    if (!bb) return 'hold';

    const price = ctx.candle.close;

    if (!ctx.position && price <= bb.lower) return 'buy';
    if (ctx.position && price >= bb.upper) return 'sell';
    // Trailing stop: if peaked above 1% and dropped 1.5% from peak
    if (ctx.position && ctx.position.peakPnlPct > 1) {
      const currentPnlPct = ((price - ctx.position.entryPrice) / ctx.position.entryPrice) * 100;
      if (ctx.position.peakPnlPct - currentPnlPct > 1.5) return 'sell';
    }
    return 'hold';
  },
};

/** MACD crossover with RSI filter */
export const macdRsiCombo: BacktestStrategy = {
  name: 'macd-rsi-combo',
  description: 'Buy on MACD bullish histogram when RSI < 50, sell on bearish or RSI > 75',
  requiredHistory: 30,
  evaluate(ctx: StrategyContext): Signal {
    const { macd, rsi } = ctx.indicators;
    if (!macd || rsi === undefined) return 'hold';

    if (!ctx.position && macd.histogram > 0 && rsi < 50) return 'buy';
    if (ctx.position && (macd.histogram < 0 || rsi > 75)) return 'sell';
    return 'hold';
  },
};

export const STRATEGIES: Record<string, BacktestStrategy> = {
  'rsi-mean-reversion': rsiMeanReversion,
  'sma-crossover': smaCrossover,
  'bollinger-bounce': bollingerBounce,
  'macd-rsi-combo': macdRsiCombo,
};
