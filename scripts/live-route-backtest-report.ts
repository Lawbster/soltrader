/// <reference types="node" />
import fs from 'fs';
import path from 'path';

type TrendRegime = 'uptrend' | 'sideways' | 'downtrend';

type RouteConfig = {
  enabled: boolean;
  routeId?: string;
  timeframeMinutes: number;
  priority?: number;
  templateId: string;
  params: Record<string, number>;
  sl?: number;
  tp?: number;
  slAtr?: number;
  tpAtr?: number;
  exitMode?: 'indicator' | 'price';
};

type TokenConfig = {
  label: string;
  enabled: boolean;
  regimes: Record<TrendRegime, { enabled: boolean; routes?: RouteConfig[] }>;
};

type LiveMap = {
  version: string;
  tokens: Record<string, TokenConfig>;
};

type SweepRow = Record<string, string>;
type CandidateRow = Record<string, string | number | undefined>;

type LiveRoute = {
  mint: string;
  token: string;
  regime: TrendRegime;
  routeId: string;
  timeframeMinutes: number;
  templateId: string;
  priority: number;
  exitMode: 'indicator' | 'price';
  paramsObject: Record<string, number>;
};

type RankedCandidateRow = CandidateRow & { __bucket: 'core' | 'probe'; __rank: number };
type DisplayRow = SweepRow | RankedCandidateRow;
type RouteActivity = {
  acceptedSignals: number;
  openedPositions: number;
  closedPositions: number;
};

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SWEEP_RESULTS_DIR = path.join(DATA_DIR, 'sweep-results');
const CANDIDATES_DIR = path.join(SWEEP_RESULTS_DIR, 'candidates');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const CONFIG_PATH = path.join(ROOT, 'config', 'live-strategy-map.v1.json');
const SIGNALS_DIR = path.join(DATA_DIR, 'signals');

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function utcDateToday(): string {
  return new Date().toISOString().split('T')[0]!;
}

function parseUtcDateBounds(date: string): { fromMs: number; toMs: number } {
  return {
    fromMs: Date.parse(`${date}T00:00:00.000Z`),
    toMs: Date.parse(`${date}T23:59:59.999Z`),
  };
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

function dateRangeUtc(fromMs: number, toMs: number): string[] {
  const dates: string[] = [];
  let current = Date.parse(`${utcDateString(fromMs)}T00:00:00.000Z`);
  const end = Date.parse(`${utcDateString(toMs)}T00:00:00.000Z`);
  while (current <= end) {
    dates.push(new Date(current).toISOString().slice(0, 10));
    current += 86_400_000;
  }
  return dates;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function parseCsv(filePath: string): Record<string, string>[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

function parseParamString(input: string): Record<string, number> {
  const result: Record<string, number> = {};
  const normalized = input.trim().replace(/^"+|"+$/g, '');
  for (const piece of normalized.split(/\s+/).filter(Boolean)) {
    const [key, raw] = piece.split('=');
    if (!key || raw === undefined) continue;
    const cleanKey = key.replace(/^"+|"+$/g, '');
    const cleanRaw = raw.replace(/^"+|"+$/g, '');
    const value = Number(cleanRaw);
    if (!Number.isFinite(value)) continue;
    result[cleanKey] = value;
  }
  return result;
}

function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i]!;
    if (key !== bKeys[i]) return false;
    if (Math.abs((a[key] ?? 0) - (b[key] ?? 0)) > 1e-9) return false;
  }
  return true;
}

function routeParamsObject(route: RouteConfig): Record<string, number> {
  const params = { ...(route.params ?? {}) };
  if (Number.isFinite(route.sl)) params.sl = route.sl as number;
  if (Number.isFinite(route.tp)) params.tp = route.tp as number;
  if (Number.isFinite(route.slAtr)) params.slAtr = route.slAtr as number;
  if (Number.isFinite(route.tpAtr)) params.tpAtr = route.tpAtr as number;
  return params;
}

function flattenLiveRoutes(map: LiveMap): LiveRoute[] {
  const routes: LiveRoute[] = [];
  for (const [mint, token] of Object.entries(map.tokens)) {
    if (!token.enabled) continue;
    for (const regime of ['uptrend', 'sideways', 'downtrend'] as TrendRegime[]) {
      const regimeConfig = token.regimes?.[regime];
      if (!regimeConfig?.enabled) continue;
      for (const route of regimeConfig.routes ?? []) {
        if (!route.enabled) continue;
        routes.push({
          mint,
          token: token.label,
          regime,
          routeId: route.routeId ?? `${token.label}-${regime}-${route.templateId}-${route.timeframeMinutes}m`,
          timeframeMinutes: route.timeframeMinutes,
          templateId: route.templateId,
          priority: route.priority ?? 0,
          exitMode: route.exitMode ?? 'price',
          paramsObject: routeParamsObject(route),
        });
      }
    }
  }
  return routes.sort((a, b) => a.token.localeCompare(b.token) || a.priority - b.priority);
}

function loadSweepRows(sweepDate: string): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const tf of [1, 5, 15]) {
    const filePath = path.join(SWEEP_RESULTS_DIR, `${sweepDate}-${tf}min.csv`);
    for (const row of parseCsv(filePath)) {
      rows.push(row);
    }
  }
  return rows;
}

function loadCandidateRows(sweepDate: string): RankedCandidateRow[] {
  const rows: RankedCandidateRow[] = [];
  for (const tf of [1, 5, 15]) {
    for (const bucket of ['core', 'probe'] as const) {
      const filePath = path.join(CANDIDATES_DIR, `${sweepDate}-${tf}min.${bucket}-ranked.csv`);
      parseCsv(filePath).forEach((row, index) => {
        rows.push({
          ...row,
          __bucket: bucket,
          __rank: index + 1,
        });
      });
    }
  }
  return rows;
}

function findSweepRow(route: LiveRoute, rows: SweepRow[]): SweepRow | null {
  return rows.find((row) =>
    row.token === route.token &&
    row.template === route.templateId &&
    row.timeframe === String(route.timeframeMinutes) &&
    row.exitParity === route.exitMode &&
    row.entryTrendRegime === route.regime &&
    sameParams(parseParamString(row.params ?? ''), route.paramsObject)
  ) ?? null;
}

function findCandidateRow(
  route: LiveRoute,
  rows: RankedCandidateRow[],
) {
  return rows.find((row) =>
    row.token === route.token &&
    row.template === route.templateId &&
    row.timeframe === String(route.timeframeMinutes) &&
    row.trendRegime === route.regime &&
    sameParams(parseParamString(String(row.params ?? '')), route.paramsObject)
  ) ?? null;
}

function formatMetric(value: string | number | undefined, digits = 2): string {
  if (value === undefined) return '-';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '-');
  return numeric.toFixed(digits);
}

function buildRouteKey(route: LiveRoute): string {
  return [
    route.mint,
    route.routeId,
    route.regime,
    route.timeframeMinutes,
    route.templateId,
  ].join('|');
}

function emptyActivity(): RouteActivity {
  return { acceptedSignals: 0, openedPositions: 0, closedPositions: 0 };
}

function loadRouteActivity(routes: LiveRoute[], fromMs: number, toMs: number): Map<string, RouteActivity> {
  const byKey = new Map<string, RouteActivity>();
  for (const route of routes) {
    byKey.set(buildRouteKey(route), emptyActivity());
  }

  for (const date of dateRangeUtc(fromMs, toMs)) {
    const signalPath = path.join(SIGNALS_DIR, `${date}.jsonl`);
    if (fs.existsSync(signalPath)) {
      const lines = fs.readFileSync(signalPath, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const row = JSON.parse(line) as {
          ts?: number;
          mint?: string;
          routeId?: string;
          regime?: string;
          timeframeMinutes?: number;
          templateId?: string;
          entryDecision?: boolean;
        };
        if (!row.entryDecision) continue;
        if (!Number.isFinite(row.ts) || (row.ts as number) < fromMs || (row.ts as number) > toMs) continue;
        const key = [
          row.mint ?? '',
          row.routeId ?? '',
          row.regime ?? '',
          row.timeframeMinutes ?? '',
          row.templateId ?? '',
        ].join('|');
        const activity = byKey.get(key);
        if (activity) activity.acceptedSignals += 1;
      }
    }

    const positionsPath = path.join(DATA_DIR, `positions-${date}.json`);
    if (!fs.existsSync(positionsPath)) continue;
    const json = JSON.parse(fs.readFileSync(positionsPath, 'utf8')) as {
      open?: Array<{
        mint?: string;
        entryTime?: number;
        strategyPlan?: { routeId?: string; entryRegime?: string; timeframeMinutes?: number; templateId?: string };
      }>;
      closed?: Array<{
        mint?: string;
        entryTime?: number;
        exitTime?: number;
        exits?: Array<{ timestamp?: number }>;
        strategyPlan?: { routeId?: string; entryRegime?: string; timeframeMinutes?: number; templateId?: string };
      }>;
    };

    for (const position of json.closed ?? []) {
      const key = [
        position.mint ?? '',
        position.strategyPlan?.routeId ?? '',
        position.strategyPlan?.entryRegime ?? '',
        position.strategyPlan?.timeframeMinutes ?? '',
        position.strategyPlan?.templateId ?? '',
      ].join('|');
      const activity = byKey.get(key);
      if (!activity) continue;
      if (Number.isFinite(position.entryTime) && (position.entryTime as number) >= fromMs && (position.entryTime as number) <= toMs) {
        activity.openedPositions += 1;
      }
      const closedAt = Number.isFinite(position.exitTime)
        ? position.exitTime
        : (position.exits ?? []).reduce<number | undefined>((latest, exit) => {
            if (!Number.isFinite(exit.timestamp)) return latest;
            if (latest === undefined) return exit.timestamp as number;
            return Math.max(latest, exit.timestamp as number);
          }, undefined);
      if (Number.isFinite(closedAt) && (closedAt as number) >= fromMs && (closedAt as number) <= toMs) {
        activity.closedPositions += 1;
      }
    }

    for (const position of json.open ?? []) {
      const key = [
        position.mint ?? '',
        position.strategyPlan?.routeId ?? '',
        position.strategyPlan?.entryRegime ?? '',
        position.strategyPlan?.timeframeMinutes ?? '',
        position.strategyPlan?.templateId ?? '',
      ].join('|');
      const activity = byKey.get(key);
      if (!activity) continue;
      if (Number.isFinite(position.entryTime) && (position.entryTime as number) >= fromMs && (position.entryTime as number) <= toMs) {
        activity.openedPositions += 1;
      }
    }
  }

  return byKey;
}

function buildMarkdown(
  sweepDate: string,
  fromMs: number,
  toMs: number,
  routes: LiveRoute[],
  sweepRows: SweepRow[],
  candidateRows: RankedCandidateRow[],
  routeActivity: Map<string, RouteActivity>,
): string {
  const matched = routes.map((route) => ({
    route,
    sweep: findSweepRow(route, sweepRows),
    candidate: findCandidateRow(route, candidateRows),
  }));

  const exactCandidateMatches = matched.filter(item => item.candidate).length;
  const exactSweepMatches = matched.filter(item => item.sweep).length;
  const displayedRows: DisplayRow[] = matched
    .map(item => item.candidate ?? item.sweep)
    .filter((row): row is DisplayRow => row !== null);

  const totalTrades = displayedRows.reduce((sum, row) => sum + Number(row.trades ?? 0), 0);
  const totalRoutePnlPct = displayedRows.reduce((sum, row) => sum + Number(row.pnlPct ?? 0), 0);
  const totalAcceptedSignals = routes.reduce((sum, route) => sum + (routeActivity.get(buildRouteKey(route))?.acceptedSignals ?? 0), 0);
  const totalOpenedPositions = routes.reduce((sum, route) => sum + (routeActivity.get(buildRouteKey(route))?.openedPositions ?? 0), 0);
  const totalClosedPositions = routes.reduce((sum, route) => sum + (routeActivity.get(buildRouteKey(route))?.closedPositions ?? 0), 0);
  const weightedWinRate = totalTrades > 0
    ? displayedRows.reduce((sum, row) => {
        const trades = Number(row.trades ?? 0);
        const winRate = Number((row as CandidateRow).winRatePct ?? (row as SweepRow).winRate ?? 0);
        return sum + (trades * winRate);
      }, 0) / totalTrades
    : 0;

  const tokenRegimeTrades = new Map<string, Record<TrendRegime, number>>();
  for (const item of matched) {
    const row = item.candidate ?? item.sweep;
    if (!row) continue;
    const trades = Number(row.trades ?? 0);
    const entry = tokenRegimeTrades.get(item.route.token) ?? { uptrend: 0, sideways: 0, downtrend: 0 };
    entry[item.route.regime] += trades;
    tokenRegimeTrades.set(item.route.token, entry);
  }

  const lines: string[] = [];
  lines.push('# Live Route Backtest Report');
  lines.push('');
  lines.push(`- Sweep date: \`${sweepDate}\``);
  lines.push(`- Window: \`${new Date(fromMs).toISOString()}\` -> \`${new Date(toMs).toISOString()}\``);
  lines.push(`- Active live routes: \`${routes.length}\``);
  lines.push(`- Exact candidate matches: \`${exactCandidateMatches}\``);
  lines.push(`- Exact live-parity sweep matches: \`${exactSweepMatches}\``);
  lines.push(`- Total trades (route aggregate): \`${totalTrades}\``);
  lines.push(`- Total PnL % (route aggregate): \`${formatMetric(totalRoutePnlPct)}%\``);
  lines.push(`- Avg win rate (trade-weighted): \`${formatMetric(weightedWinRate)}%\``);
  lines.push(`- Accepted live signals in window: \`${totalAcceptedSignals}\``);
  lines.push(`- Live entries opened in window: \`${totalOpenedPositions}\``);
  lines.push(`- Live positions closed in window: \`${totalClosedPositions}\``);
  lines.push('');
  lines.push('## Trades By Token / Regime');
  lines.push('');
  for (const [token, regimes] of Array.from(tokenRegimeTrades.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- ${token}: ${regimes.uptrend} uptrend, ${regimes.downtrend} downtrend, ${regimes.sideways} sideways`);
  }
  lines.push('');
  lines.push('| Token | Regime | Route | TF | Template | Exit | Live Signals | Live Opens | Live Closes | Candidate | Trades | PnL% | WR% | PF | Avg Hold | Sweep Signals | Candidate Rank | Live-Parity Sweep |');
  lines.push('| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');

  for (const item of matched) {
    const { route, sweep, candidate } = item;
    const activity = routeActivity.get(buildRouteKey(route)) ?? emptyActivity();
    const candidateLabel = candidate ? `${candidate.__bucket}` : 'none';
    const candidateRank = candidate ? `${candidate.__rank}` : '-';
    const display = candidate ?? sweep;
    const liveParityLabel = sweep
      ? `${formatMetric(sweep.pnlPct)}% / PF ${formatMetric(sweep.profitFactor)}`
      : '-';
    lines.push(
      `| ${route.token} | ${route.regime} | \`${route.routeId}\` | ${route.timeframeMinutes}m | ${route.templateId} | ${route.exitMode} | ${activity.acceptedSignals} | ${activity.openedPositions} | ${activity.closedPositions} | ${candidateLabel} | ${display?.trades ?? '-'} | ${formatMetric(display?.pnlPct)} | ${formatMetric(display?.winRatePct ?? display?.winRate)} | ${formatMetric(display?.profitFactor)} | ${formatMetric(display?.avgHoldMinutes, 1)} | ${formatMetric(sweep?.entrySignalCount, 0)} | ${candidateRank} | ${liveParityLabel} |`,
    );
  }

  const missing = matched.filter(item => !item.candidate);
  if (missing.length > 0) {
    lines.push('');
    lines.push('## Missing Exact Candidate Rows');
    lines.push('');
    for (const item of missing) {
      lines.push(`- \`${item.route.routeId}\` (${item.route.token} ${item.route.regime} ${item.route.timeframeMinutes}m ${item.route.templateId})`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const sweepDate = getArg('--sweep-date') ?? utcDateToday();
  const bounds = parseUtcDateBounds(sweepDate);
  const fromMs = parseIsoArg(getArg('--from-ts'), bounds.fromMs);
  const toMs = parseIsoArg(getArg('--to-ts'), bounds.toMs);
  const liveMap = readJson<LiveMap>(CONFIG_PATH);
  const routes = flattenLiveRoutes(liveMap);
  const sweepRows = loadSweepRows(sweepDate);
  const candidateRows = loadCandidateRows(sweepDate);
  const routeActivity = loadRouteActivity(routes, fromMs, toMs);

  if (sweepRows.length === 0) {
    throw new Error(`No sweep files found for ${sweepDate}. Run the 1m/5m/15m sweeps first.`);
  }

  ensureDir(REPORTS_DIR);
  const reportStem = getArg('--from-ts') || getArg('--to-ts')
    ? `${utcDateString(fromMs)}.${new Date(fromMs).toISOString().slice(11, 16).replace(':', '')}-${new Date(toMs).toISOString().slice(11, 16).replace(':', '')}`
    : sweepDate;
  const reportPath = path.join(REPORTS_DIR, `${reportStem}.live-route-backtest.md`);
  const markdown = buildMarkdown(sweepDate, fromMs, toMs, routes, sweepRows, candidateRows, routeActivity);
  fs.writeFileSync(reportPath, markdown);
  console.log(`Saved live route backtest report: ${reportPath}`);
}

main();
