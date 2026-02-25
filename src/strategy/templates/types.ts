import type { IndicatorValues } from '../../backtest/types';

export type TemplateId =
  | 'rsi'
  | 'crsi'
  | 'bb-rsi'
  | 'rsi-crsi-confluence'
  | 'crsi-dip-recover'
  | 'trend-pullback-rsi'
  | 'vwap-rsi-reclaim'
  | 'bb-rsi-crsi-reversal'
  | 'rsi-crsi-midpoint-exit'
  | 'adx-range-rsi-bb'
  | 'adx-trend-rsi-pullback'
  | 'macd-zero-rsi-confirm'
  | 'macd-signal-obv-confirm'
  | 'bb-squeeze-breakout'
  | 'vwap-trend-pullback'
  | 'vwap-rsi-range-revert'
  | 'connors-sma50-pullback'
  | 'rsi2-micro-range'
  | 'atr-breakout-follow'
  | 'rsi-session-gate'
  | 'crsi-session-gate';

/**
 * Shared signal context for template evaluators — usable from both sweep (via adapter)
 * and live engine (directly from IndicatorSnapshot + price feed).
 */
export interface LiveTemplateContext {
  /** Current bar close price */
  close: number;
  /** Previous bar close (from history or price-feed series) */
  prevClose?: number;
  /** Previous bar high (from trade-derived or price-feed OHLC) */
  prevHigh?: number;
  /** Current indicator values */
  indicators: IndicatorValues;
  /** Previous bar indicator values (indicators computed on series[0..-2]) */
  prevIndicators?: IndicatorValues;
  /** UTC hour 0–23 */
  hourUtc: number;
  /** True when there is an open position for this token */
  hasPosition: boolean;
}

export interface TemplateMetadata {
  id: TemplateId;
  /** Minimum candle history required before the template can produce a signal */
  requiredHistory: number;
  /** Indicator fields the template reads — used for live context completeness check */
  requiredIndicators: (keyof IndicatorValues)[];
  /**
   * True if the template can operate with close-only or price-feed-derived OHLC.
   * Templates needing H/L (adx, atr) are still marked true because PR2 provides a
   * price-feed OHLC fallback; they return 'hold' gracefully when the indicator is absent.
   */
  liveCompatible: boolean;
}
