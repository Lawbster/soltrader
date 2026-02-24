import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils';

const log = createLogger('live-strategy-map');

export type TrendRegime = 'uptrend' | 'sideways' | 'downtrend';

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

// Returned to callers — unchanged contract
export interface TokenStrategy {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc: number;
  enabled: boolean;
  indicator: TokenIndicator;
  params: TokenStrategyParams;
}

// Internal v2 JSON shapes
export interface RegimeConfig {
  enabled: boolean;
  params: TokenStrategyParams;
}

interface TokenStrategyV2 {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc: number;
  enabled: boolean;
  indicator: TokenIndicator;
  // v2: per-regime configs
  regimes: {
    uptrend: RegimeConfig;
    sideways: RegimeConfig;
    downtrend: RegimeConfig;
  };
}

interface LiveStrategyMapV2 {
  version: string;
  tokens: Record<string, TokenStrategyV2>;
}

// v1 shape (flat params — kept for backward compat detection)
interface TokenStrategyV1 {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc: number;
  enabled: boolean;
  indicator: TokenIndicator;
  params: TokenStrategyParams;
}

const CONFIG_PATH = path.resolve(__dirname, '../../config/live-strategy-map.v1.json');

let cached: LiveStrategyMapV2 | null = null;
let cachedMtime = 0;
let v1WarnEmitted = false;

function loadLiveStrategyMap(): LiveStrategyMapV2 {
  const stat = fs.statSync(CONFIG_PATH);
  if (cached && stat.mtimeMs === cachedMtime) return cached;

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as { version: string; tokens: Record<string, TokenStrategyV1 | TokenStrategyV2> };

  // Normalize: v1 tokens (flat params, no regimes) → v2
  const tokens: Record<string, TokenStrategyV2> = {};
  for (const [mint, entry] of Object.entries(raw.tokens)) {
    if ('regimes' in entry && entry.regimes) {
      // v2 format — fill in any missing regime keys with sideways fallback
      const regimes = entry.regimes as Partial<TokenStrategyV2['regimes']>;
      const sideways = regimes.sideways ?? regimes.uptrend ?? regimes.downtrend;
      if (!sideways) {
        log.warn('Token has regimes block but all regimes missing', { mint: entry.label });
        continue;
      }
      tokens[mint] = {
        ...(entry as TokenStrategyV2),
        regimes: {
          uptrend:   regimes.uptrend   ?? { ...sideways },
          sideways:  regimes.sideways  ?? { ...sideways },
          downtrend: regimes.downtrend ?? { ...sideways },
        },
      };
    } else {
      // v1 format — promote flat params to all regimes
      if (!v1WarnEmitted) {
        log.warn('live-strategy-map.v1.json contains v1-format tokens (flat params). Promoting to v2 in memory. Update config to suppress this warning.');
        v1WarnEmitted = true;
      }
      const v1 = entry as TokenStrategyV1;
      const regimeConfig: RegimeConfig = { enabled: v1.enabled, params: v1.params };
      tokens[mint] = {
        label: v1.label,
        tier: v1.tier,
        maxPositionUsdc: v1.maxPositionUsdc,
        enabled: v1.enabled,
        indicator: v1.indicator,
        regimes: {
          uptrend:   { ...regimeConfig },
          sideways:  { ...regimeConfig },
          downtrend: { ...regimeConfig },
        },
      };
    }
  }

  cached = { version: raw.version, tokens };
  cachedMtime = stat.mtimeMs;
  return cached;
}

export function isTokenMasterEnabled(mint: string): boolean {
  const map = loadLiveStrategyMap();
  return !!map.tokens[mint]?.enabled;
}

export function getLiveTokenStrategy(mint: string, regime: TrendRegime = 'sideways'): TokenStrategy | null {
  const map = loadLiveStrategyMap();
  const entry = map.tokens[mint];
  if (!entry || !entry.enabled) return null;

  const regimeConfig = entry.regimes[regime];
  if (!regimeConfig || !regimeConfig.enabled) return null;

  return {
    label: entry.label,
    tier: entry.tier,
    maxPositionUsdc: entry.maxPositionUsdc,
    enabled: true,
    indicator: entry.indicator,
    params: regimeConfig.params,
  };
}
