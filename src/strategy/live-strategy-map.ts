import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils';
import type { TemplateId } from './templates/types';
import { validateParams } from './templates/catalog';

const log = createLogger('live-strategy-map');

export type TrendRegime = 'uptrend' | 'sideways' | 'downtrend';
export type ExitMode = 'indicator' | 'price';

export interface TokenIndicator {
  kind: 'rsi' | 'crsi';
  rsiPeriod: number;
  streakRsiPeriod?: number;
  percentRankPeriod?: number;
}

/** Old-format params (flat entry/exit/sl/tp) — kept for backward compat */
export interface TokenStrategyParams {
  entry: number;
  exit: number;
  sl: number;
  tp: number;
}

/** Normalized token strategy returned to all callers. */
export interface TokenStrategy {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc: number;
  enabled: boolean;
  /** Present for RSI/CRSI templates; absent for other template families. */
  indicator?: TokenIndicator;
  /** Always set after normalization — for RSI/CRSI tokens equals indicator.kind. */
  templateId: TemplateId;
  /** Template-specific params. For RSI/CRSI: includes entry/exit/sl/tp. */
  params: Record<string, number>;
  /** Stop-loss % — direct access for position-manager and rules. */
  sl: number;
  /** Take-profit % — direct access for position-manager and rules. */
  tp: number;
  exitMode: ExitMode;
}

export interface RegimeConfig {
  enabled: boolean;
  params: TokenStrategyParams;
}

// ── Internal JSON shapes ──────────────────────────────────────────────

/** New regime format: template-driven with explicit templateId/params/sl/tp/exitMode */
interface RegimeConfigNew {
  enabled: boolean;
  templateId: TemplateId;
  params: Record<string, number>;
  sl: number;
  tp: number;
  exitMode?: ExitMode;
}

type AnyRegimeConfig = RegimeConfig | RegimeConfigNew;

interface TokenStrategyV2 {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc: number;
  enabled: boolean;
  indicator?: TokenIndicator;
  regimes: {
    uptrend: AnyRegimeConfig;
    sideways: AnyRegimeConfig;
    downtrend: AnyRegimeConfig;
  };
}

interface LiveStrategyMapV2 {
  version: string;
  tokens: Record<string, TokenStrategyV2>;
}

interface TokenStrategyV1 {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc: number;
  enabled: boolean;
  indicator: TokenIndicator;
  params: TokenStrategyParams;
}

// ── Config loading ────────────────────────────────────────────────────

const CONFIG_PATH = path.resolve(__dirname, '../../config/live-strategy-map.v1.json');

let cached: LiveStrategyMapV2 | null = null;
let cachedMtime = 0;
let v1WarnEmitted = false;

function isNewRegimeFormat(r: AnyRegimeConfig): r is RegimeConfigNew {
  return 'templateId' in r && typeof (r as RegimeConfigNew).templateId === 'string';
}

function loadLiveStrategyMap(): LiveStrategyMapV2 {
  const stat = fs.statSync(CONFIG_PATH);
  if (cached && stat.mtimeMs === cachedMtime) return cached;

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as {
    version: string;
    tokens: Record<string, TokenStrategyV1 | TokenStrategyV2>;
  };

  const tokens: Record<string, TokenStrategyV2> = {};

  for (const [mint, entry] of Object.entries(raw.tokens)) {
    if ('regimes' in entry && entry.regimes) {
      const regimes = entry.regimes as Partial<TokenStrategyV2['regimes']>;
      const sideways = regimes.sideways ?? regimes.uptrend ?? regimes.downtrend;
      if (!sideways) {
        log.warn('Token has regimes block but all regimes missing', { label: (entry as TokenStrategyV2).label });
        continue;
      }

      // Validate new-format regime params at load time
      for (const [regimeName, rc] of Object.entries(regimes)) {
        if (!rc || !isNewRegimeFormat(rc)) continue;
        const err = validateParams(rc.templateId, rc.params);
        if (err) {
          log.warn('Invalid template params in live-strategy-map', {
            label: (entry as TokenStrategyV2).label,
            regime: regimeName,
            error: err,
          });
        }
      }

      // Warn about enabled old-format regimes — they force exitMode='price' and ignore indicator exits
      for (const [regimeName, rc] of Object.entries(regimes)) {
        if (!rc || isNewRegimeFormat(rc)) continue;
        if (rc.enabled) {
          log.warn('Enabled regime uses legacy params format — exitMode forced to price. Migrate to new format with templateId/exitMode.', {
            label: (entry as TokenStrategyV2).label,
            regime: regimeName,
          });
        }
      }

      tokens[mint] = {
        ...(entry as TokenStrategyV2),
        regimes: {
          uptrend:   (regimes.uptrend   ?? { ...sideways }) as AnyRegimeConfig,
          sideways:  (regimes.sideways  ?? { ...sideways }) as AnyRegimeConfig,
          downtrend: (regimes.downtrend ?? { ...sideways }) as AnyRegimeConfig,
        },
      };
    } else {
      // v1 format — promote flat params to all regimes
      if (!v1WarnEmitted) {
        log.warn('live-strategy-map.v1.json contains v1-format tokens (flat params). Promoting to v2 in memory.');
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

// ── Normalization ─────────────────────────────────────────────────────

function normalizeRegime(
  entry: TokenStrategyV2,
  regimeConfig: AnyRegimeConfig,
): Omit<TokenStrategy, 'label' | 'tier' | 'maxPositionUsdc' | 'enabled'> {
  if (isNewRegimeFormat(regimeConfig)) {
    return {
      indicator: entry.indicator,
      templateId: regimeConfig.templateId,
      params: regimeConfig.params,
      sl: regimeConfig.sl,
      tp: regimeConfig.tp,
      exitMode: regimeConfig.exitMode ?? 'price',
    };
  }

  // Old format: derive templateId from indicator.kind
  const oldParams = regimeConfig.params;
  const templateId = (entry.indicator?.kind ?? 'rsi') as TemplateId;
  return {
    indicator: entry.indicator,
    templateId,
    params: { entry: oldParams.entry, exit: oldParams.exit, sl: oldParams.sl, tp: oldParams.tp },
    sl: oldParams.sl,
    tp: oldParams.tp,
    exitMode: 'price',
  };
}

// ── Public API ────────────────────────────────────────────────────────

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

  const normalized = normalizeRegime(entry, regimeConfig);

  return {
    label: entry.label,
    tier: entry.tier,
    maxPositionUsdc: entry.maxPositionUsdc,
    enabled: true,
    ...normalized,
  };
}
