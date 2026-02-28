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

// Legacy format kept for backward compatibility
export interface TokenStrategyParams {
  entry: number;
  exit: number;
  sl: number;
  tp: number;
}

export interface TokenStrategy {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
  enabled: boolean;
  indicator?: TokenIndicator;
  templateId: TemplateId;
  params: Record<string, number>;
  sl: number;
  tp: number;
  exitMode: ExitMode;
  routeId?: string;
  timeframeMinutes?: number;
  priority?: number;
}

export interface RegimeConfig {
  enabled: boolean;
  params: TokenStrategyParams;
}

interface RegimeConfigNewSingle {
  enabled: boolean;
  templateId: TemplateId;
  params: Record<string, number>;
  sl: number;
  tp: number;
  exitMode?: ExitMode;
  routeId?: string;
  timeframeMinutes?: number;
  priority?: number;
  indicator?: TokenIndicator;
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
}

interface RegimeRouteConfig {
  routeId?: string;
  enabled: boolean;
  timeframeMinutes: number;
  priority?: number;
  indicator?: TokenIndicator;
  templateId: TemplateId;
  params: Record<string, number>;
  sl: number;
  tp: number;
  exitMode?: ExitMode;
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
}

interface RegimeConfigRoutes {
  enabled: boolean;
  routes: RegimeRouteConfig[];
}

type AnyRegimeConfig = RegimeConfig | RegimeConfigNewSingle | RegimeConfigRoutes;

interface TokenStrategyV2 {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
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
  maxPositionEquityPct?: number;
  enabled: boolean;
  indicator: TokenIndicator;
  params: TokenStrategyParams;
}

const CONFIG_PATH = path.resolve(__dirname, '../../config/live-strategy-map.v1.json');

let cached: LiveStrategyMapV2 | null = null;
let cachedMtime = 0;
let v1WarnEmitted = false;

function isRouteRegimeFormat(r: AnyRegimeConfig): r is RegimeConfigRoutes {
  return typeof (r as RegimeConfigRoutes).routes !== 'undefined';
}

function isNewSingleRegimeFormat(r: AnyRegimeConfig): r is RegimeConfigNewSingle {
  return typeof (r as RegimeConfigNewSingle).templateId === 'string';
}

function cloneRegimeConfig(r: AnyRegimeConfig): AnyRegimeConfig {
  if (isRouteRegimeFormat(r)) {
    return {
      enabled: r.enabled,
      routes: (r.routes ?? []).map(route => ({
        ...route,
        params: { ...(route.params ?? {}) },
        indicator: route.indicator ? { ...route.indicator } : undefined,
      })),
    };
  }
  if (isNewSingleRegimeFormat(r)) {
    return {
      ...r,
      params: { ...(r.params ?? {}) },
      indicator: r.indicator ? { ...r.indicator } : undefined,
    };
  }
  return {
    enabled: r.enabled,
    params: { ...r.params },
  };
}

function validateRegimeConfig(label: string, regimeName: string, rc: AnyRegimeConfig) {
  if (isRouteRegimeFormat(rc)) {
    for (let i = 0; i < rc.routes.length; i++) {
      const route = rc.routes[i];
      if (!route) continue;
      const err = validateParams(route.templateId, route.params);
      if (err) {
        log.warn('Invalid template params in live-strategy-map route', {
          label,
          regime: regimeName,
          routeId: route.routeId ?? `${regimeName}-${i + 1}`,
          error: err,
        });
      }
    }
    return;
  }

  if (isNewSingleRegimeFormat(rc)) {
    const err = validateParams(rc.templateId, rc.params);
    if (err) {
      log.warn('Invalid template params in live-strategy-map', {
        label,
        regime: regimeName,
        error: err,
      });
    }
    return;
  }

  if (rc.enabled) {
    log.warn('Enabled regime uses legacy params format. Migrate to templateId/params or routes[] for full live parity.', {
      label,
      regime: regimeName,
    });
  }
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
      const v2 = entry as TokenStrategyV2;
      const regimes = v2.regimes as Partial<TokenStrategyV2['regimes']>;
      const fallback = regimes.sideways ?? regimes.uptrend ?? regimes.downtrend;
      if (!fallback) {
        log.warn('Token has regimes block but no usable regime found', { label: v2.label });
        continue;
      }

      for (const [regimeName, rc] of Object.entries(regimes)) {
        if (!rc) continue;
        validateRegimeConfig(v2.label, regimeName, rc);
      }

      tokens[mint] = {
        ...v2,
        regimes: {
          uptrend: cloneRegimeConfig(regimes.uptrend ?? fallback),
          sideways: cloneRegimeConfig(regimes.sideways ?? fallback),
          downtrend: cloneRegimeConfig(regimes.downtrend ?? fallback),
        },
      };
      continue;
    }

    if (!v1WarnEmitted) {
      log.warn('live-strategy-map.v1.json contains v1-format tokens. Promoting to v2 in memory.');
      v1WarnEmitted = true;
    }
    const v1 = entry as TokenStrategyV1;
    const legacyRegime: RegimeConfig = { enabled: v1.enabled, params: v1.params };
    tokens[mint] = {
      label: v1.label,
      tier: v1.tier,
      maxPositionUsdc: v1.maxPositionUsdc,
      maxPositionEquityPct: v1.maxPositionEquityPct,
      enabled: v1.enabled,
      indicator: v1.indicator,
      regimes: {
        uptrend: cloneRegimeConfig(legacyRegime),
        sideways: cloneRegimeConfig(legacyRegime),
        downtrend: cloneRegimeConfig(legacyRegime),
      },
    };
  }

  cached = { version: raw.version, tokens };
  cachedMtime = stat.mtimeMs;
  return cached;
}

function normalizeTimeframeMinutes(tf?: number): number | undefined {
  if (!Number.isFinite(tf)) return undefined;
  const rounded = Math.max(1, Math.round(tf as number));
  if (rounded === 1 || rounded === 5 || rounded === 15) return rounded;
  return rounded;
}

function sortByPriority(strategies: TokenStrategy[]): TokenStrategy[] {
  return strategies.sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    const ta = a.timeframeMinutes ?? Number.MAX_SAFE_INTEGER;
    const tb = b.timeframeMinutes ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return (a.routeId ?? '').localeCompare(b.routeId ?? '');
  });
}

function normalizeLegacyRegime(
  entry: TokenStrategyV2,
  regime: TrendRegime,
  rc: RegimeConfig,
): TokenStrategy[] {
  if (!rc.enabled) return [];
  const templateId = (entry.indicator?.kind ?? 'rsi') as TemplateId;
  return [{
    label: entry.label,
    tier: entry.tier,
    maxPositionUsdc: entry.maxPositionUsdc,
    maxPositionEquityPct: entry.maxPositionEquityPct,
    enabled: true,
    indicator: entry.indicator,
    templateId,
    params: { entry: rc.params.entry, exit: rc.params.exit, sl: rc.params.sl, tp: rc.params.tp },
    sl: rc.params.sl,
    tp: rc.params.tp,
    exitMode: 'price',
    routeId: `${regime}:legacy`,
    priority: 100,
  }];
}

function normalizeSingleRegime(
  entry: TokenStrategyV2,
  regime: TrendRegime,
  rc: RegimeConfigNewSingle,
): TokenStrategy[] {
  if (!rc.enabled) return [];
  return [{
    label: entry.label,
    tier: entry.tier,
    maxPositionUsdc: rc.maxPositionUsdc ?? entry.maxPositionUsdc,
    maxPositionEquityPct: rc.maxPositionEquityPct ?? entry.maxPositionEquityPct,
    enabled: true,
    indicator: rc.indicator ?? entry.indicator,
    templateId: rc.templateId,
    params: rc.params,
    sl: rc.sl,
    tp: rc.tp,
    exitMode: rc.exitMode ?? 'price',
    routeId: rc.routeId ?? `${regime}:${rc.templateId}`,
    timeframeMinutes: normalizeTimeframeMinutes(rc.timeframeMinutes),
    priority: rc.priority ?? 100,
  }];
}

function normalizeRouteRegime(
  entry: TokenStrategyV2,
  regime: TrendRegime,
  rc: RegimeConfigRoutes,
): TokenStrategy[] {
  if (!rc.enabled) return [];
  const out: TokenStrategy[] = [];

  for (let i = 0; i < rc.routes.length; i++) {
    const route = rc.routes[i];
    if (!route || !route.enabled) continue;
    const err = validateParams(route.templateId, route.params);
    if (err) {
      log.warn('Skipping route with invalid params', {
        label: entry.label,
        regime,
        routeId: route.routeId ?? `${regime}-${i + 1}`,
        error: err,
      });
      continue;
    }
    out.push({
      label: entry.label,
      tier: entry.tier,
      maxPositionUsdc: route.maxPositionUsdc ?? entry.maxPositionUsdc,
      maxPositionEquityPct: route.maxPositionEquityPct ?? entry.maxPositionEquityPct,
      enabled: true,
      indicator: route.indicator ?? entry.indicator,
      templateId: route.templateId,
      params: route.params,
      sl: route.sl,
      tp: route.tp,
      exitMode: route.exitMode ?? 'price',
      routeId: route.routeId ?? `${regime}-${i + 1}`,
      timeframeMinutes: normalizeTimeframeMinutes(route.timeframeMinutes),
      priority: route.priority ?? 100,
    });
  }

  return sortByPriority(out);
}

function normalizeRegimeStrategies(
  entry: TokenStrategyV2,
  regime: TrendRegime,
  rc: AnyRegimeConfig,
): TokenStrategy[] {
  if (isRouteRegimeFormat(rc)) return normalizeRouteRegime(entry, regime, rc);
  if (isNewSingleRegimeFormat(rc)) return normalizeSingleRegime(entry, regime, rc);
  return normalizeLegacyRegime(entry, regime, rc);
}

export function isTokenMasterEnabled(mint: string): boolean {
  const map = loadLiveStrategyMap();
  return !!map.tokens[mint]?.enabled;
}

export function getLiveTokenStrategies(
  mint: string,
  regime: TrendRegime = 'sideways',
): TokenStrategy[] {
  const map = loadLiveStrategyMap();
  const entry = map.tokens[mint];
  if (!entry || !entry.enabled) return [];

  const regimeConfig = entry.regimes[regime];
  if (!regimeConfig) return [];

  return sortByPriority(normalizeRegimeStrategies(entry, regime, regimeConfig));
}

export function getLiveTokenStrategy(
  mint: string,
  regime: TrendRegime = 'sideways',
): TokenStrategy | null {
  const routes = getLiveTokenStrategies(mint, regime);
  return routes.length > 0 ? routes[0] : null;
}

