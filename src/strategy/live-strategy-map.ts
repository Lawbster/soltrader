import fs from 'fs';
import path from 'path';

export interface TokenIndicator {
  kind: 'rsi' | 'crsi';
  rsiPeriod: number;
  streakRsiPeriod?: number;
  percentRankPeriod?: number;
}

export interface TokenStrategyParams {
  entry: number;  // oversold threshold — enter when indicator < entry
  exit: number;   // overbought threshold — stored for reference (sweep source); live exit driven by sl/tp
  sl: number;     // stop loss pct (negative, e.g. -5 = exit at -5%)
  tp: number;     // take profit pct (positive, e.g. 1 = exit at +1%)
}

export interface TokenStrategy {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc: number;
  enabled: boolean;
  indicator: TokenIndicator;
  params: TokenStrategyParams;
}

export interface LiveStrategyMap {
  version: string;
  tokens: Record<string, TokenStrategy>;
}

let cached: LiveStrategyMap | null = null;

export function loadLiveStrategyMap(): LiveStrategyMap {
  if (cached) return cached;
  const p = path.resolve(__dirname, '../../config/live-strategy-map.v1.json');
  cached = JSON.parse(fs.readFileSync(p, 'utf-8')) as LiveStrategyMap;
  return cached;
}

export function getLiveTokenStrategy(mint: string): TokenStrategy | null {
  return loadLiveStrategyMap().tokens[mint] ?? null;
}
