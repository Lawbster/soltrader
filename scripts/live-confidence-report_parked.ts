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
  exitMode?: string;
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

type CandidateRow = {
  token: string;
  template: string;
  timeframe: string;
  trendRegime: string;
  params: string;
  trades: string;
  pnlPct: string;
  winRatePct: string;
  profitFactor: string;
  scoreCore: string;
  combinedStat: string;
  __bucket?: 'core' | 'probe';
  [key: string]: string | undefined;
};

type SignalRow = {
  ts: number;
  mint: string;
  routeId?: string;
  templateId?: string;
  timeframeMinutes?: number;
  regime?: string;
  entryDecision?: boolean;
  rejectReason?: string;
  acceptReason?: string;
};

type ExecutionRow = {
  ts: number;
  mint: string;
  side: 'buy' | 'sell';
  sizeUsdc?: number;
  slippageBps?: number;
  quotedImpactPct?: number;
  result: string;
  latencyMs?: number;
};

type Position = {
  id: string;
  mint: string;
  currentPnlPct?: number;
  strategyPlan?: {
    routeId?: string;
    templateId?: string;
    timeframeMinutes?: number;
  };
  exits?: Array<{ timestamp?: number }>;
};

type PositionsFile = {
  open?: Position[];
  closed?: Position[];
};

type LiveRoute = {
  mint: string;
  token: string;
  regime: TrendRegime;
  routeId: string;
  timeframeMinutes: number;
  templateId: string;
  priority: number;
  exitMode: string;
  paramsObject: Record<string, number>;
};

type RouteSignalStats = {
  evaluated: number;
  accepted: number;
  topRejectReason: string;
  topRejectCount: number;
  acceptedReasons: Map<string, number>;
  acceptedSignals: SignalRow[];
};

type RouteExecutionStats = {
  matchedBuyExecs: number;
  avgBuyImpactPct: number | null;
  avgBuyLatencyMs: number | null;
};

type RoutePositionStats = {
  openPositions: number;
  closedPositions: number;
  realizedPnlPct: number;
};

type RouteCandidateMatch = {
  bucket: 'core' | 'probe' | 'none';
  row: CandidateRow | null;
};

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SWEEP_RESULTS_DIR = path.join(DATA_DIR, 'sweep-results');
const CANDIDATES_DIR = path.join(SWEEP_RESULTS_DIR, 'candidates');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const CONFIG_PATH = path.join(ROOT, 'config', 'live-strategy-map.v1.json');

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function utcDateToday(): string {
  return new Date().toISOString().split('T')[0]!;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function parseCsv(filePath: string): Record<string, string>[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = lines[0]!.split(',');
  return lines.slice(1).map(line => {
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
  for (const piece of input.split(/\s+/).filter(Boolean)) {
    const [key, raw] = piece.split('=');
    if (!key || raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    result[key] = value;
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

function loadCandidateRows(sweepDate: string): CandidateRow[] {
  const rows: CandidateRow[] = [];
  for (const tf of [1, 5, 15]) {
    for (const bucket of ['core', 'probe'] as const) {
      const filePath = path.join(CANDIDATES_DIR, `${sweepDate}-${tf}min.${bucket}-ranked.csv`);
      for (const row of parseCsv(filePath)) {
        rows.push({
          ...(row as CandidateRow),
          __bucket: bucket,
        });
      }
    }
  }
  return rows;
}

function findRouteCandidateMatch(route: LiveRoute, rows: CandidateRow[]): RouteCandidateMatch {
  const exact = rows.find((row) =>
    row.token === route.token &&
    row.template === route.templateId &&
    row.timeframe === String(route.timeframeMinutes) &&
    row.trendRegime === route.regime &&
    sameParams(parseParamString(row.params), route.paramsObject)
  );
  if (!exact) return { bucket: 'none', row: null };
  return {
    bucket: (exact.__bucket as 'core' | 'probe') ?? 'probe',
    row: exact,
  };
}

function topReason(counts: Map<string, number>): { reason: string; count: number } {
  let bestReason = '';
  let bestCount = 0;
  for (const [reason, count] of counts.entries()) {
    if (count > bestCount) {
      bestReason = reason;
      bestCount = count;
    }
  }
  return { reason: bestReason || '-', count: bestCount };
}

function summarizeSignals(signals: SignalRow[], routes: LiveRoute[]): Map<string, RouteSignalStats> {
  const routeIds = new Set(routes.map(route => route.routeId));
  const stats = new Map<string, RouteSignalStats>();
  for (const route of routes) {
    stats.set(route.routeId, {
      evaluated: 0,
      accepted: 0,
      topRejectReason: '-',
      topRejectCount: 0,
      acceptedReasons: new Map<string, number>(),
      acceptedSignals: [],
    });
  }

  for (const signal of signals) {
    if (!signal.routeId || !routeIds.has(signal.routeId)) continue;
    const entry = stats.get(signal.routeId)!;
    entry.evaluated++;
    if (signal.entryDecision) {
      entry.accepted++;
      entry.acceptedSignals.push(signal);
      const reason = signal.acceptReason ?? 'accepted';
      entry.acceptedReasons.set(reason, (entry.acceptedReasons.get(reason) ?? 0) + 1);
    } else if (signal.rejectReason) {
      const cleaned = signal.rejectReason.replace(/^route:[^ ]+\s*/, '');
      entry.acceptedReasons.set(`reject:${cleaned}`, (entry.acceptedReasons.get(`reject:${cleaned}`) ?? 0) + 1);
    }
  }

  for (const route of routes) {
    const entry = stats.get(route.routeId)!;
    const rejectCounts = new Map<string, number>();
    for (const signal of signals) {
      if (signal.routeId !== route.routeId || signal.entryDecision || !signal.rejectReason) continue;
      const cleaned = signal.rejectReason.replace(/^route:[^ ]+\s*/, '');
      rejectCounts.set(cleaned, (rejectCounts.get(cleaned) ?? 0) + 1);
    }
    const top = topReason(rejectCounts);
    entry.topRejectReason = top.reason;
    entry.topRejectCount = top.count;
  }

  return stats;
}

function summarizeExecutions(executions: ExecutionRow[], signalStats: Map<string, RouteSignalStats>): Map<string, RouteExecutionStats> {
  const result = new Map<string, RouteExecutionStats>();
  for (const [routeId, stats] of signalStats.entries()) {
    const accepted = stats.acceptedSignals.slice().sort((a, b) => a.ts - b.ts);
    const buys = executions
      .filter(exec => exec.side === 'buy' && exec.result === 'success')
      .sort((a, b) => a.ts - b.ts);

    const matched: ExecutionRow[] = [];
    const usedSignalIndexes = new Set<number>();
    for (const exec of buys) {
      let bestIndex = -1;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (let i = 0; i < accepted.length; i++) {
        if (usedSignalIndexes.has(i)) continue;
        const signal = accepted[i]!;
        if (signal.mint !== exec.mint) continue;
        const delta = exec.ts - signal.ts;
        if (delta < 0 || delta > 5 * 60_000) continue;
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIndex = i;
        }
      }
      if (bestIndex >= 0) {
        usedSignalIndexes.add(bestIndex);
        matched.push(exec);
      }
    }

    const avgImpact = matched.length > 0
      ? matched.reduce((sum, exec) => sum + (exec.quotedImpactPct ?? 0), 0) / matched.length
      : null;
    const avgLatency = matched.length > 0
      ? matched.reduce((sum, exec) => sum + (exec.latencyMs ?? 0), 0) / matched.length
      : null;

    result.set(routeId, {
      matchedBuyExecs: matched.length,
      avgBuyImpactPct: avgImpact,
      avgBuyLatencyMs: avgLatency,
    });
  }
  return result;
}

function summarizePositions(file: PositionsFile | null, routes: LiveRoute[]): Map<string, RoutePositionStats> {
  const stats = new Map<string, RoutePositionStats>();
  for (const route of routes) {
    stats.set(route.routeId, { openPositions: 0, closedPositions: 0, realizedPnlPct: 0 });
  }
  if (!file) return stats;

  for (const position of file.open ?? []) {
    const routeId = position.strategyPlan?.routeId;
    if (!routeId || !stats.has(routeId)) continue;
    stats.get(routeId)!.openPositions++;
  }

  for (const position of file.closed ?? []) {
    const routeId = position.strategyPlan?.routeId;
    if (!routeId || !stats.has(routeId)) continue;
    const routeStats = stats.get(routeId)!;
    routeStats.closedPositions++;
    routeStats.realizedPnlPct += position.currentPnlPct ?? 0;
  }

  return stats;
}

function formatNum(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return value.toFixed(decimals);
}

function buildMarkdown(
  date: string,
  sweepDate: string,
  routes: LiveRoute[],
  candidateRows: CandidateRow[],
  signalStats: Map<string, RouteSignalStats>,
  executionStats: Map<string, RouteExecutionStats>,
  positionStats: Map<string, RoutePositionStats>,
): string {
  const matchedRoutes = routes.filter(route => findRouteCandidateMatch(route, candidateRows).row !== null).length;
  const lines: string[] = [];
  lines.push(`# Live Confidence Report`);
  lines.push('');
  lines.push(`- Live date: \`${date}\``);
  lines.push(`- Sweep/candidate date: \`${sweepDate}\``);
  lines.push(`- Active routes checked: \`${routes.length}\``);
  lines.push(`- Exact candidate matches: \`${matchedRoutes}\``);
  lines.push('');
  lines.push(`| Token | Regime | Route | TF | Template | Candidate | Trades | PnL% | WR% | PF | Signals | Accepted | Buys | Closed | Realized PnL% | Top Reject |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);

  for (const route of routes) {
    const match = findRouteCandidateMatch(route, candidateRows);
    const signal = signalStats.get(route.routeId)!;
    const exec = executionStats.get(route.routeId)!;
    const pos = positionStats.get(route.routeId)!;
    const row = match.row;
    lines.push(`| ${route.token} | ${route.regime} | \`${route.routeId}\` | ${route.timeframeMinutes}m | ${route.templateId} | ${match.bucket} | ${row?.trades ?? '-'} | ${row?.pnlPct ?? '-'} | ${row?.winRatePct ?? '-'} | ${row?.profitFactor ?? '-'} | ${signal.evaluated} | ${signal.accepted} | ${exec.matchedBuyExecs} | ${pos.closedPositions} | ${formatNum(pos.realizedPnlPct)} | ${signal.topRejectReason} |`);
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const date = getArg('--date') ?? utcDateToday();
  const sweepDate = getArg('--sweep-date') ?? date;

  const signalsPath = path.join(DATA_DIR, 'signals', `${date}.jsonl`);
  const executionsPath = path.join(DATA_DIR, 'executions', `${date}.jsonl`);
  const positionsPath = path.join(DATA_DIR, `positions-${date}.json`);

  const liveMap = readJson<LiveMap>(CONFIG_PATH);
  if (!liveMap) {
    throw new Error(`Live strategy map not found: ${CONFIG_PATH}`);
  }

  const candidateRows = loadCandidateRows(sweepDate);
  if (candidateRows.length === 0) {
    throw new Error(`No candidate files found for ${sweepDate}. Run today's sweeps and sweep-candidates first.`);
  }

  const routes = flattenLiveRoutes(liveMap);
  const signals = readJsonl<SignalRow>(signalsPath);
  const executions = readJsonl<ExecutionRow>(executionsPath);
  const positions = readJson<PositionsFile>(positionsPath);

  const signalStats = summarizeSignals(signals, routes);
  const executionStats = summarizeExecutions(executions, signalStats);
  const positionStats = summarizePositions(positions, routes);

  ensureDir(REPORTS_DIR);
  const reportPath = path.join(REPORTS_DIR, `${date}.live-confidence.md`);
  const markdown = buildMarkdown(date, sweepDate, routes, candidateRows, signalStats, executionStats, positionStats);
  fs.writeFileSync(reportPath, markdown);

  console.log(`Saved live confidence report: ${reportPath}`);
}

main();
