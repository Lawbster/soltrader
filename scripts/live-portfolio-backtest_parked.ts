/// <reference types="node" />
import fs from 'fs';
import path from 'path';
import { loadCandles, aggregateCandles } from '../src/backtest/data-loader';
import { runBacktest } from '../src/backtest/engine';
import { computeMetrics } from '../src/backtest/report';
import type {
  BacktestProtectionConfig,
  BacktestStrategy,
  BacktestTrade,
  BacktestTrendRegime,
  Candle,
  StrategyContext,
  Signal,
} from '../src/backtest/types';
import { fixedCost, loadEmpiricalCost } from '../src/backtest/cost-loader';
import { buildRegimeSeriesFromCandles } from '../src/strategy/regime-core';
import { evaluateSignal, getTemplateMetadata } from '../src/strategy/templates/catalog';
import type { TemplateId } from '../src/strategy/templates/types';
import { loadStrategyConfig } from '../src/strategy/strategy-config';

type LiveMap = {
  version: string;
  tokens: Record<string, TokenEntry>;
};

type TrendRegime = 'uptrend' | 'sideways' | 'downtrend';
type ExitMode = 'indicator' | 'price';

type RouteProtectionConfig = {
  profitLockArmPct?: number;
  profitLockPct?: number;
  trailArmPct?: number;
  trailGapPct?: number;
  staleMaxHoldMinutes?: number;
  staleMinPnlPct?: number;
};

type TokenIndicator = {
  kind: 'rsi' | 'crsi';
  rsiPeriod: number;
  streakRsiPeriod?: number;
  percentRankPeriod?: number;
};

type TokenStrategyParams = {
  entry: number;
  exit: number;
  sl: number;
  tp: number;
};

type RegimeConfigLegacy = {
  enabled: boolean;
  params: TokenStrategyParams;
};

type RegimeConfigSingle = {
  enabled: boolean;
  templateId: TemplateId;
  params: Record<string, number>;
  sl?: number;
  tp?: number;
  slAtr?: number;
  tpAtr?: number;
  exitMode?: ExitMode;
  routeId?: string;
  timeframeMinutes?: number;
  priority?: number;
  protection?: RouteProtectionConfig;
  indicator?: TokenIndicator;
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
};

type RegimeRouteConfig = {
  routeId?: string;
  enabled: boolean;
  timeframeMinutes: number;
  priority?: number;
  protection?: RouteProtectionConfig;
  indicator?: TokenIndicator;
  templateId: TemplateId;
  params: Record<string, number>;
  sl?: number;
  tp?: number;
  slAtr?: number;
  tpAtr?: number;
  exitMode?: ExitMode;
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
};

type RegimeConfigRoutes = {
  enabled: boolean;
  routes: RegimeRouteConfig[];
};

type AnyRegimeConfig = RegimeConfigLegacy | RegimeConfigSingle | RegimeConfigRoutes;

type TokenEntry = {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
  enabled: boolean;
  indicator?: TokenIndicator;
  regimes: Record<TrendRegime, AnyRegimeConfig>;
};

type TokenStrategy = {
  label: string;
  tier: 'core' | 'probe';
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
  enabled: boolean;
  indicator?: TokenIndicator;
  templateId: TemplateId;
  params: Record<string, number>;
  sl?: number;
  tp?: number;
  slAtr?: number;
  tpAtr?: number;
  exitMode: ExitMode;
  routeId?: string;
  timeframeMinutes?: number;
  priority?: number;
  protection?: RouteProtectionConfig;
};

type LiveRoute = {
  mint: string;
  token: string;
  regime: TrendRegime;
  strategy: TokenStrategy;
};

type SignalRegimePoint = {
  regime: BacktestTrendRegime;
  trendScore: number | null;
  ret24h: number | null;
  ret48h: number | null;
  ret72h: number | null;
  coverageHours: number;
};

type RouteProposal = {
  route: LiveRoute;
  trade: BacktestTrade;
};

type SimPosition = {
  route: LiveRoute;
  proposal: RouteProposal;
  entryTime: number;
  exitTime: number;
  sizeUsdc: number;
  pnlPct: number;
  exitReason: string;
};

type ExecutedTrade = {
  route: LiveRoute;
  entryTime: number;
  exitTime: number;
  sizeUsdc: number;
  pnlPct: number;
  pnlUsdc: number;
  exitReason: string;
};

type RejectedProposal = {
  proposal: RouteProposal;
  reason: string;
};

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const LIVE_MAP_PATH = path.join(ROOT, 'config', 'live-strategy-map.v1.json');

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function utcDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseUtcDateBounds(date: string): { fromMs: number; toMs: number } {
  const fromMs = Date.parse(`${date}T00:00:00.000Z`);
  const toMs = Date.parse(`${date}T23:59:59.999Z`);
  return { fromMs, toMs };
}

function parseIsoArg(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return parsed;
}

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcDateShift(date: string, deltaDays: number): string {
  const base = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(base + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function formatPct(v: number, digits = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function formatUsdc(v: number, digits = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
}

function toTemplateCtx(ctx: StrategyContext) {
  return {
    close: ctx.candle.close,
    prevClose: ctx.history[ctx.index - 1]?.close,
    prevHigh: ctx.history[ctx.index - 1]?.high,
    indicators: ctx.indicators,
    prevIndicators: ctx.prevIndicators,
    hourUtc: ctx.hour,
    hasPosition: ctx.positions.length > 0,
  };
}

function buildRouteStrategy(route: LiveRoute): BacktestStrategy {
  const templateId = route.strategy.templateId;
  const params = route.strategy.params;
  const meta = getTemplateMetadata(templateId);
  return {
    name: route.strategy.routeId ?? templateId,
    description: `${route.token} ${route.regime} ${route.strategy.timeframeMinutes ?? 1}m ${templateId}`,
    requiredHistory: meta.requiredHistory,
    stopLossPct: route.strategy.sl,
    takeProfitPct: route.strategy.tp,
    stopLossAtrMult: route.strategy.slAtr,
    takeProfitAtrMult: route.strategy.tpAtr,
    protection: route.strategy.protection as BacktestProtectionConfig | undefined,
    evaluate(ctx: StrategyContext): Signal {
      return evaluateSignal(templateId, params, toTemplateCtx(ctx));
    },
  };
}

function buildIndicatorConfig(route: LiveRoute): NonNullable<Parameters<typeof runBacktest>[1]['indicatorConfig']> {
  const cfg = loadStrategyConfig();
  const routeIndicator = route.strategy.indicator;
  const rsiPeriod = routeIndicator?.rsiPeriod ?? cfg.entry.indicators.rsi.period;
  const connorsRsiPeriod = routeIndicator?.kind === 'rsi'
    ? rsiPeriod
    : (routeIndicator?.rsiPeriod ?? cfg.entry.indicators.connors.rsiPeriod);
  const connorsStreakRsiPeriod = routeIndicator?.streakRsiPeriod ?? cfg.entry.indicators.connors.streakRsiPeriod;
  const connorsPercentRankPeriod = routeIndicator?.kind === 'rsi'
    ? (rsiPeriod + 1)
    : (routeIndicator?.percentRankPeriod ?? cfg.entry.indicators.connors.percentRankPeriod);

  return {
    rsiPeriod,
    connorsRsiPeriod,
    connorsStreakRsiPeriod,
    connorsPercentRankPeriod,
  };
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

function compareRouteCandidates(
  a: { route: TokenStrategy; score: number; sizeUsdc: number },
  b: { route: TokenStrategy; score: number; sizeUsdc: number },
): number {
  const pa = a.route.priority ?? 0;
  const pb = b.route.priority ?? 0;
  if (pa !== pb) return pb - pa;
  if (a.score !== b.score) return b.score - a.score;
  const ta = a.route.timeframeMinutes ?? Number.MAX_SAFE_INTEGER;
  const tb = b.route.timeframeMinutes ?? Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  if (a.sizeUsdc !== b.sizeUsdc) return b.sizeUsdc - a.sizeUsdc;
  return (a.route.routeId ?? '').localeCompare(b.route.routeId ?? '');
}

function calculatePositionSize(
  equityUsdc: number,
  liquidityUsd: number,
  totalTrades: number,
): number {
  const cfg = loadStrategyConfig();
  const riskUsdc = equityUsdc * (cfg.position.riskPerTradePct / 100);
  const stopDistance = cfg.position.initialStopPct / 100;
  const sizeFromRisk = riskUsdc / stopDistance;
  const maxFromEquity = equityUsdc * (cfg.position.maxPositionEquityPct / 100);
  const maxAbsolute = cfg.position.maxPositionUsdc > 0 ? cfg.position.maxPositionUsdc : Infinity;
  let maxFromLiquidity = Infinity;
  if (liquidityUsd > 0 && cfg.position.liquidityCapPct > 0) {
    maxFromLiquidity = liquidityUsd * (cfg.position.liquidityCapPct / 100);
  }
  let maxFromSampleGate = Infinity;
  if (totalTrades < cfg.position.sampleSizeGateMinTrades) {
    maxFromSampleGate = cfg.position.sampleSizeGateMaxUsdc;
  }
  return Math.min(sizeFromRisk, maxFromEquity, maxAbsolute, maxFromLiquidity, maxFromSampleGate);
}

function resolveTokenMaxPositionUsdc(tokenStrategy: TokenStrategy, equityUsdc: number): number {
  const cfg = loadStrategyConfig();
  const fallbackCap = cfg.position.maxPositionUsdc > 0 ? cfg.position.maxPositionUsdc : Infinity;
  let cap = Infinity;
  if (typeof tokenStrategy.maxPositionEquityPct === 'number' && tokenStrategy.maxPositionEquityPct > 0) {
    cap = Math.min(cap, equityUsdc * (tokenStrategy.maxPositionEquityPct / 100));
  }
  if (typeof tokenStrategy.maxPositionUsdc === 'number' && tokenStrategy.maxPositionUsdc > 0) {
    cap = Math.min(cap, tokenStrategy.maxPositionUsdc);
  }
  return cap === Infinity ? fallbackCap : cap;
}

function isStopLikeExitReason(reason: string): boolean {
  return reason === 'stop-loss' || reason === 'emergency';
}

function loadLiveRoutes(): LiveRoute[] {
  const map = JSON.parse(fs.readFileSync(LIVE_MAP_PATH, 'utf8')) as LiveMap;
  const routes: LiveRoute[] = [];
  for (const [mint, token] of Object.entries(map.tokens)) {
    if (!token.enabled) continue;
    for (const regime of ['uptrend', 'sideways', 'downtrend'] as TrendRegime[]) {
      for (const strategy of normalizeRegimeStrategies(token, regime)) {
        routes.push({ mint, token: token.label, regime, strategy });
      }
    }
  }
  return routes.sort((a, b) =>
    a.token.localeCompare(b.token)
    || compareRouteCandidates(
      { route: a.strategy, score: 0, sizeUsdc: 0 },
      { route: b.strategy, score: 0, sizeUsdc: 0 },
    )
  );
}

function isRouteRegimeFormat(rc: AnyRegimeConfig): rc is RegimeConfigRoutes {
  return Array.isArray((rc as RegimeConfigRoutes).routes);
}

function isSingleRegimeFormat(rc: AnyRegimeConfig): rc is RegimeConfigSingle {
  return typeof (rc as RegimeConfigSingle).templateId === 'string';
}

function sortStrategies(strategies: TokenStrategy[]): TokenStrategy[] {
  return strategies.sort((a, b) =>
    compareRouteCandidates(
      { route: a, score: 0, sizeUsdc: 0 },
      { route: b, score: 0, sizeUsdc: 0 },
    )
  );
}

function normalizeRegimeStrategies(entry: TokenEntry, regime: TrendRegime): TokenStrategy[] {
  const rc = entry.regimes[regime];
  if (!rc || !rc.enabled) return [];

  if (isRouteRegimeFormat(rc)) {
    return sortStrategies(
      (rc.routes ?? [])
        .filter(route => route?.enabled)
        .map((route, index) => ({
          label: entry.label,
          tier: entry.tier,
          maxPositionUsdc: route.maxPositionUsdc ?? entry.maxPositionUsdc,
          maxPositionEquityPct: route.maxPositionEquityPct ?? entry.maxPositionEquityPct,
          enabled: true,
          indicator: route.indicator ?? entry.indicator,
          templateId: route.templateId,
          params: route.params ?? {},
          sl: route.sl,
          tp: route.tp,
          slAtr: route.slAtr ?? route.params?.slAtr,
          tpAtr: route.tpAtr ?? route.params?.tpAtr,
          exitMode: route.exitMode ?? 'price',
          routeId: route.routeId ?? `${regime}-${index + 1}`,
          timeframeMinutes: route.timeframeMinutes,
          priority: route.priority ?? 100,
          protection: route.protection,
        }))
    );
  }

  if (isSingleRegimeFormat(rc)) {
    return [{
      label: entry.label,
      tier: entry.tier,
      maxPositionUsdc: rc.maxPositionUsdc ?? entry.maxPositionUsdc,
      maxPositionEquityPct: rc.maxPositionEquityPct ?? entry.maxPositionEquityPct,
      enabled: true,
      indicator: rc.indicator ?? entry.indicator,
      templateId: rc.templateId,
      params: rc.params ?? {},
      sl: rc.sl,
      tp: rc.tp,
      slAtr: rc.slAtr ?? rc.params?.slAtr,
      tpAtr: rc.tpAtr ?? rc.params?.tpAtr,
      exitMode: rc.exitMode ?? 'price',
      routeId: rc.routeId ?? `${regime}:${rc.templateId}`,
      timeframeMinutes: rc.timeframeMinutes,
      priority: rc.priority ?? 100,
      protection: rc.protection,
    }];
  }

  return [{
    label: entry.label,
    tier: entry.tier,
    maxPositionUsdc: entry.maxPositionUsdc,
    maxPositionEquityPct: entry.maxPositionEquityPct,
    enabled: true,
    indicator: entry.indicator,
    templateId: entry.indicator?.kind ?? 'rsi',
    params: rc.params,
    sl: rc.params.sl,
    tp: rc.params.tp,
    exitMode: 'price',
    routeId: `${regime}:legacy`,
    priority: 100,
  }];
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function loadRouteProposals(
  routes: LiveRoute[],
  fromMs: number,
  toMs: number,
  historyLookbackDays: number,
  roundTripCostPct: number,
): RouteProposal[] {
  const proposals: RouteProposal[] = [];
  const toDate = utcDateString(toMs);
  const historyFromDate = utcDateShift(utcDateString(fromMs), -historyLookbackDays);

  const routesByMint = new Map<string, LiveRoute[]>();
  for (const route of routes) {
    const arr = routesByMint.get(route.mint) ?? [];
    arr.push(route);
    routesByMint.set(route.mint, arr);
  }

  for (const [mint, mintRoutes] of routesByMint) {
    const execCandles = loadCandles(mint, historyFromDate, toDate)
      .filter(c => c.timestamp < toMs);
    if (execCandles.length === 0) continue;

    const aggregated = new Map<number, Candle[]>();
    aggregated.set(1, execCandles);

    for (const timeframe of unique(mintRoutes.map(r => r.strategy.timeframeMinutes ?? 1))) {
      if (timeframe === 1) continue;
      aggregated.set(timeframe, aggregateCandles(execCandles, timeframe));
    }

    for (const route of mintRoutes) {
      const timeframe = route.strategy.timeframeMinutes ?? 1;
      const signalCandles = aggregated.get(timeframe) ?? execCandles;
      if (signalCandles.length === 0) continue;
      const signalRegimes = buildSignalRegimeSeries(execCandles, signalCandles, timeframe);
      const result = runBacktest(signalCandles, {
        mint,
        label: route.token,
        strategy: buildRouteStrategy(route),
        roundTripCostPct,
        maxPositions: 1,
        exitParityMode: route.strategy.exitMode,
        executionCandles: execCandles,
        signalTimeframeMinutes: timeframe,
        executionTimeframeMinutes: 1,
        indicatorConfig: buildIndicatorConfig(route),
        signalRegimes: signalRegimes.map(point => point.regime),
        entryRegimeFilter: route.regime,
      });

      for (const trade of result.trades) {
        if (trade.entryTime < fromMs || trade.entryTime > toMs) continue;
        proposals.push({ route, trade });
      }
    }
  }

  return proposals.sort((a, b) =>
    a.trade.entryTime - b.trade.entryTime
    || compareRouteCandidates(
      { route: a.route.strategy, score: 0, sizeUsdc: 0 },
      { route: b.route.strategy, score: 0, sizeUsdc: 0 },
    )
  );
}

function buildRejectReason(
  nowMs: number,
  route: LiveRoute,
  openPositions: SimPosition[],
  stoppedOutTokens: Map<string, number>,
  totalTrades: number,
  equityUsdc: number,
  dailyStartEquityUsdc: number,
  dailyPnlUsdc: number,
  consecutiveLosses: number,
  lastLossTime: number,
): { reason: string; sizeUsdc: number } {
  const cfg = loadStrategyConfig();
  const openExposureUsdc = openPositions.reduce((sum, position) => sum + position.sizeUsdc, 0);
  const dailyPnlPct = dailyStartEquityUsdc > 0 ? (dailyPnlUsdc / dailyStartEquityUsdc) * 100 : 0;

  if (openPositions.length >= cfg.portfolio.maxConcurrentPositions) {
    return { reason: `Max positions: ${openPositions.length}/${cfg.portfolio.maxConcurrentPositions}`, sizeUsdc: 0 };
  }

  const exposurePct = equityUsdc > 0 ? (openExposureUsdc / equityUsdc) * 100 : 0;
  if (exposurePct >= cfg.portfolio.maxOpenExposurePct) {
    return { reason: `Max exposure: ${exposurePct.toFixed(1)}% >= ${cfg.portfolio.maxOpenExposurePct}%`, sizeUsdc: 0 };
  }

  if (dailyPnlPct <= cfg.portfolio.dailyLossLimitPct) {
    return { reason: `Daily loss limit: ${dailyPnlPct.toFixed(1)}% <= ${cfg.portfolio.dailyLossLimitPct}%`, sizeUsdc: 0 };
  }

  if (consecutiveLosses >= cfg.portfolio.consecutiveLossLimit) {
    const cooldownMs = cfg.portfolio.consecutiveLossCooldownMinutes * 60_000;
    const timeSinceLoss = nowMs - lastLossTime;
    if (timeSinceLoss < cooldownMs) {
      const minsLeft = Math.round((cooldownMs - timeSinceLoss) / 60_000);
      return { reason: `Consecutive loss cooldown: ${minsLeft}m remaining`, sizeUsdc: 0 };
    }
  }

  const lockoutTime = stoppedOutTokens.get(route.mint);
  if (lockoutTime) {
    const hoursSinceLockout = (nowMs - lockoutTime) / 3_600_000;
    if (hoursSinceLockout < cfg.portfolio.reEntryLockoutHours) {
      return {
        reason: `Re-entry lockout: ${Math.round(hoursSinceLockout)}h < ${cfg.portfolio.reEntryLockoutHours}h`,
        sizeUsdc: 0,
      };
    }
  }

  const routeAlreadyOpen = openPositions.some(position => position.route.strategy.routeId === route.strategy.routeId);
  if (routeAlreadyOpen) {
    return { reason: 'Route already open', sizeUsdc: 0 };
  }

  const sized = Math.min(
    calculatePositionSize(equityUsdc, Infinity, totalTrades),
    resolveTokenMaxPositionUsdc(route.strategy, equityUsdc),
  );
  if (!Number.isFinite(sized) || sized <= 0) {
    return { reason: 'Non-positive position size', sizeUsdc: 0 };
  }

  if (openExposureUsdc + sized > equityUsdc * (cfg.portfolio.maxOpenExposurePct / 100)) {
    return { reason: 'Max exposure after sizing', sizeUsdc: sized };
  }

  return { reason: '', sizeUsdc: sized };
}

function simulatePortfolio(
  proposals: RouteProposal[],
  startEquityUsdc: number,
  fromMs: number,
  toMs: number,
): {
  executed: ExecutedTrade[];
  rejected: RejectedProposal[];
  suppressedByPriority: RejectedProposal[];
  routeAggregateTrades: number;
} {
  const executed: ExecutedTrade[] = [];
  const rejected: RejectedProposal[] = [];
  const suppressedByPriority: RejectedProposal[] = [];
  const openPositions: SimPosition[] = [];
  const stoppedOutTokens = new Map<string, number>();

  let realizedPnlUsdc = 0;
  let totalClosedTrades = 0;
  let currentDayKey = utcDateString(fromMs);
  let dailyStartEquityUsdc = startEquityUsdc;
  let dailyPnlUsdc = 0;
  let consecutiveLosses = 0;
  let lastLossTime = 0;

  function closePositionsUpTo(nowMs: number) {
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const position = openPositions[i];
      if (position.exitTime > nowMs) continue;
      const pnlUsdc = position.sizeUsdc * (position.pnlPct / 100);
      realizedPnlUsdc += pnlUsdc;
      dailyPnlUsdc += pnlUsdc;
      totalClosedTrades += 1;

      if (pnlUsdc < 0) {
        consecutiveLosses += 1;
        lastLossTime = position.exitTime;
        if (isStopLikeExitReason(position.exitReason)) {
          stoppedOutTokens.set(position.route.mint, position.exitTime);
        }
      } else {
        consecutiveLosses = 0;
      }

      executed.push({
        route: position.route,
        entryTime: position.entryTime,
        exitTime: position.exitTime,
        sizeUsdc: position.sizeUsdc,
        pnlPct: position.pnlPct,
        pnlUsdc,
        exitReason: position.exitReason,
      });
      openPositions.splice(i, 1);
    }
  }

  const groupedByTime = new Map<number, RouteProposal[]>();
  for (const proposal of proposals) {
    const arr = groupedByTime.get(proposal.trade.entryTime) ?? [];
    arr.push(proposal);
    groupedByTime.set(proposal.trade.entryTime, arr);
  }

  const timestamps = Array.from(groupedByTime.keys()).sort((a, b) => a - b);
  for (const ts of timestamps) {
    if (ts < fromMs || ts > toMs) continue;

    const dayKey = utcDateString(ts);
    if (dayKey !== currentDayKey) {
      closePositionsUpTo(ts);
      currentDayKey = dayKey;
      dailyStartEquityUsdc = startEquityUsdc + realizedPnlUsdc;
      dailyPnlUsdc = 0;
      consecutiveLosses = 0;
      lastLossTime = 0;
    } else {
      closePositionsUpTo(ts);
    }

    const proposalsAtTime = groupedByTime.get(ts) ?? [];
    const winners = new Map<string, RouteProposal>();
    for (const proposal of proposalsAtTime) {
      const key = proposal.route.mint;
      const current = winners.get(key);
      if (!current) {
        winners.set(key, proposal);
        continue;
      }
      const cmp = compareRouteCandidates(
        { route: proposal.route.strategy, score: 0, sizeUsdc: 0 },
        { route: current.route.strategy, score: 0, sizeUsdc: 0 },
      );
      if (cmp < 0) {
        suppressedByPriority.push({ proposal: current, reason: `Suppressed by ${proposal.route.strategy.routeId}` });
        winners.set(key, proposal);
      } else {
        suppressedByPriority.push({ proposal, reason: `Suppressed by ${current.route.strategy.routeId}` });
      }
    }

    const winnerList = Array.from(winners.values()).sort((a, b) =>
      compareRouteCandidates(
        { route: a.route.strategy, score: 0, sizeUsdc: 0 },
        { route: b.route.strategy, score: 0, sizeUsdc: 0 },
      )
    );

    for (const proposal of winnerList) {
      const currentEquityUsdc = startEquityUsdc + realizedPnlUsdc;
      const evaluation = buildRejectReason(
        ts,
        proposal.route,
        openPositions,
        stoppedOutTokens,
        totalClosedTrades,
        currentEquityUsdc,
        dailyStartEquityUsdc,
        dailyPnlUsdc,
        consecutiveLosses,
        lastLossTime,
      );

      if (evaluation.reason) {
        rejected.push({ proposal, reason: evaluation.reason });
        continue;
      }

      openPositions.push({
        route: proposal.route,
        proposal,
        entryTime: proposal.trade.entryTime,
        exitTime: proposal.trade.exitTime,
        sizeUsdc: evaluation.sizeUsdc,
        pnlPct: proposal.trade.pnlPct,
        exitReason: proposal.trade.exitReason,
      });
    }
  }

  closePositionsUpTo(toMs + 60_000);

  return {
    executed,
    rejected,
    suppressedByPriority,
    routeAggregateTrades: proposals.length,
  };
}

function latestDailyStartEquity(defaultValue: number): number {
  const files = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR)
        .filter(name => /^positions-\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .sort()
    : [];
  const latest = files[files.length - 1];
  if (!latest) return defaultValue;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, latest), 'utf8')) as {
      stats?: { dailyStartEquityUsdc?: number };
    };
    const value = raw.stats?.dailyStartEquityUsdc;
    return Number.isFinite(value) && (value as number) > 0 ? (value as number) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function buildMarkdown(
  fromMs: number,
  toMs: number,
  routes: LiveRoute[],
  proposals: RouteProposal[],
  executed: ExecutedTrade[],
  rejected: RejectedProposal[],
  suppressed: RejectedProposal[],
  startEquityUsdc: number,
): string {
  const windowMs = Math.max(0, toMs - fromMs);
  const routeAggregateMetrics = computeMetrics(proposals.map(p => p.trade), windowMs);
  const executedMetrics = computeMetrics(
    executed.map(trade => ({
      mint: trade.route.mint,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      entryPrice: 0,
      exitPrice: 0,
      pnlPct: trade.pnlPct,
      holdBars: Math.max(1, Math.round((trade.exitTime - trade.entryTime) / 60_000)),
      holdTimeMinutes: (trade.exitTime - trade.entryTime) / 60_000,
      exitReason: trade.exitReason,
      entryRegime: trade.route.regime,
    })),
    windowMs,
  );
  const executedPnlUsdc = executed.reduce((sum, trade) => sum + trade.pnlUsdc, 0);
  const rejectCounts = new Map<string, number>();
  for (const reject of [...rejected, ...suppressed]) {
    rejectCounts.set(reject.reason, (rejectCounts.get(reject.reason) ?? 0) + 1);
  }

  const tokenRegimeExecuted = new Map<string, Record<TrendRegime, number>>();
  for (const trade of executed) {
    const entry = tokenRegimeExecuted.get(trade.route.token) ?? { uptrend: 0, downtrend: 0, sideways: 0 };
    entry[trade.route.regime] += 1;
    tokenRegimeExecuted.set(trade.route.token, entry);
  }

  const routeStats = new Map<string, { route: LiveRoute; trades: number; pnlUsdc: number; pnlPct: number }>();
  for (const trade of executed) {
    const key = trade.route.strategy.routeId ?? trade.route.strategy.templateId;
    const entry = routeStats.get(key) ?? {
      route: trade.route,
      trades: 0,
      pnlUsdc: 0,
      pnlPct: 0,
    };
    entry.trades += 1;
    entry.pnlUsdc += trade.pnlUsdc;
    entry.pnlPct += trade.pnlPct;
    routeStats.set(key, entry);
  }

  const lines: string[] = [];
  lines.push('# Live Portfolio Backtest');
  lines.push('');
  lines.push(`- Window: \`${new Date(fromMs).toISOString()}\` -> \`${new Date(toMs).toISOString()}\``);
  lines.push(`- Active live routes: \`${routes.length}\``);
  lines.push(`- Starting equity assumption: \`${startEquityUsdc.toFixed(2)} USDC\``);
  lines.push(`- Isolated route proposals: \`${proposals.length}\``);
  lines.push(`- Portfolio-executed trades: \`${executed.length}\``);
  lines.push(`- Rejected by portfolio limits: \`${rejected.length}\``);
  lines.push(`- Suppressed by higher-priority route: \`${suppressed.length}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Route aggregate PnL: \`${formatPct(routeAggregateMetrics.totalPnlPct)}\``);
  lines.push(`- Portfolio-sim PnL: \`${formatUsdc(executedPnlUsdc)} USDC\` / \`${formatPct((executedPnlUsdc / startEquityUsdc) * 100)}\``);
  lines.push(`- Portfolio-sim win rate: \`${executedMetrics.winRate.toFixed(2)}%\``);
  lines.push(`- Portfolio-sim profit factor: \`${executedMetrics.profitFactor.toFixed(2)}\``);
  lines.push(`- Portfolio-sim avg hold: \`${executedMetrics.avgHoldMinutes.toFixed(1)}m\``);
  lines.push('');
  lines.push('## Executed Trades By Token / Regime');
  lines.push('');
  for (const [token, regimes] of Array.from(tokenRegimeExecuted.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- ${token}: ${regimes.uptrend} uptrend, ${regimes.downtrend} downtrend, ${regimes.sideways} sideways`);
  }
  lines.push('');
  lines.push('## Route Contribution');
  lines.push('');
  lines.push('| Token | Regime | Route | TF | Template | Trades | PnL USDC | PnL % Sum |');
  lines.push('| --- | --- | --- | --- | --- | ---: | ---: | ---: |');
  for (const stat of Array.from(routeStats.values()).sort((a, b) => b.pnlUsdc - a.pnlUsdc)) {
    lines.push(`| ${stat.route.token} | ${stat.route.regime} | \`${stat.route.strategy.routeId ?? stat.route.strategy.templateId}\` | ${(stat.route.strategy.timeframeMinutes ?? 1)}m | ${stat.route.strategy.templateId} | ${stat.trades} | ${formatUsdc(stat.pnlUsdc)} | ${formatPct(stat.pnlPct)} |`);
  }
  lines.push('');
  lines.push('## Top Reject Reasons');
  lines.push('');
  for (const [reason, count] of Array.from(rejectCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    lines.push(`- ${count} × ${reason}`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- This is a shared-wallet simulation of the current live map, not a sum of isolated route rows.');
  lines.push('- It enforces one winning route per token per timestamp, one open position per route, max concurrent positions, max exposure, daily loss guard, and re-entry lockout.');
  lines.push('- It does not model live Jupiter impact failures, quote failures, or non-candle token filter metadata. It is a tighter approximation of live portfolio behavior, not a byte-for-byte replay.');
  return `${lines.join('\n')}\n`;
}

function main() {
  const date = getArg('--date') ?? utcDateToday();
  const bounds = parseUtcDateBounds(date);
  const fromMs = parseIsoArg(getArg('--from-ts'), bounds.fromMs);
  const toMs = parseIsoArg(getArg('--to-ts'), bounds.toMs);
  const historyLookbackDays = Number(getArg('--history-lookback-days') ?? 4);
  const costMode = (getArg('--cost') ?? 'empirical') as 'empirical' | 'fixed';
  const equityArg = Number(getArg('--equity') ?? '');
  const startEquityUsdc = Number.isFinite(equityArg) && equityArg > 0
    ? equityArg
    : latestDailyStartEquity(300);

  const cost = costMode === 'fixed'
    ? fixedCost()
    : loadEmpiricalCost(utcDateShift(utcDateString(fromMs), -historyLookbackDays), utcDateString(toMs));

  const routes = loadLiveRoutes();
  const proposals = loadRouteProposals(routes, fromMs, toMs, historyLookbackDays, cost.roundTripPct);
  const simulation = simulatePortfolio(proposals, startEquityUsdc, fromMs, toMs);

  ensureDir(REPORTS_DIR);
  const fileStem = getArg('--from-ts') || getArg('--to-ts')
    ? `${utcDateString(fromMs)}.${new Date(fromMs).toISOString().slice(11, 16).replace(':', '')}-${new Date(toMs).toISOString().slice(11, 16).replace(':', '')}`
    : utcDateString(fromMs);
  const reportPath = path.join(REPORTS_DIR, `${fileStem}.live-portfolio-backtest.md`);
  const markdown = buildMarkdown(
    fromMs,
    toMs,
    routes,
    proposals,
    simulation.executed,
    simulation.rejected,
    simulation.suppressedByPriority,
    startEquityUsdc,
  );
  fs.writeFileSync(reportPath, markdown);
  console.log(`Saved live portfolio backtest report: ${reportPath}`);
}

main();
