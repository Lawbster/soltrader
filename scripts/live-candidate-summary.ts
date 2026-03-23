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

type LiveRoute = {
  token: string;
  regime: TrendRegime;
  routeId: string;
  timeframeMinutes: number;
  priority: number;
  templateId: string;
  exitMode: 'indicator' | 'price';
  paramsObject: Record<string, number>;
};

type CandidateRow = Record<string, string | number | undefined> & {
  __bucket: 'core' | 'probe';
  __source: string;
  __rank?: number;
};

type SweepRow = Record<string, string>;

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
  return new Date().toISOString().slice(0, 10);
}

function resolveDir(argName: string, fallback: string): string {
  const value = getArg(argName);
  return value ? path.resolve(value) : fallback;
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
    if (Number.isFinite(value)) result[cleanKey] = value;
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
  for (const token of Object.values(map.tokens)) {
    if (!token.enabled) continue;
    for (const regime of ['uptrend', 'sideways', 'downtrend'] as TrendRegime[]) {
      const regimeConfig = token.regimes?.[regime];
      if (!regimeConfig?.enabled) continue;
      for (const route of regimeConfig.routes ?? []) {
        if (!route.enabled) continue;
        routes.push({
          token: token.label,
          regime,
          routeId: route.routeId ?? `${token.label}-${regime}-${route.templateId}-${route.timeframeMinutes}m`,
          timeframeMinutes: route.timeframeMinutes,
          priority: route.priority ?? 0,
          templateId: route.templateId,
          exitMode: route.exitMode ?? 'price',
          paramsObject: routeParamsObject(route),
        });
      }
    }
  }
  return routes.sort((a, b) => a.token.localeCompare(b.token) || b.priority - a.priority || a.routeId.localeCompare(b.routeId));
}

function rowKey(row: CandidateRow): string {
  return [
    row.token ?? '',
    row.template ?? '',
    row.timeframe ?? '',
    row.trendRegime ?? '',
    row.params ?? '',
    row.__bucket,
  ].join('|');
}

function loadCandidateRows(sweepDate: string, candidatesDir: string): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const seen = new Set<string>();
  for (const tf of [1, 5, 15]) {
    for (const bucket of ['core', 'probe'] as const) {
      const files = [
        `${sweepDate}-${tf}min.${bucket}-ranked.csv`,
        `${sweepDate}-${tf}min.${bucket}-up.csv`,
        `${sweepDate}-${tf}min.${bucket}-sideways.csv`,
        `${sweepDate}-${tf}min.${bucket}-down.csv`,
      ];
      for (const file of files) {
        parseCsv(path.join(candidatesDir, file)).forEach((row, index) => {
          const enriched: CandidateRow = {
            ...row,
            __bucket: bucket,
            __source: file,
            __rank: file.includes('ranked') ? index + 1 : undefined,
          };
          const key = rowKey(enriched);
          if (seen.has(key)) return;
          seen.add(key);
          rows.push(enriched);
        });
      }
    }
  }
  return rows;
}

function loadSweepRows(sweepDate: string, sweepDir: string): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const tf of [1, 5, 15]) {
    for (const row of parseCsv(path.join(sweepDir, `${sweepDate}-${tf}min.csv`))) {
      rows.push(row);
    }
  }
  return rows;
}

function findCandidateRow(route: LiveRoute, rows: CandidateRow[]): CandidateRow | null {
  return rows.find((row) =>
    row.token === route.token &&
    row.template === route.templateId &&
    row.timeframe === String(route.timeframeMinutes) &&
    row.trendRegime === route.regime &&
    sameParams(parseParamString(String(row.params ?? '')), route.paramsObject)
  ) ?? null;
}

function findSweepRow(route: LiveRoute, rows: SweepRow[]): SweepRow | null {
  return rows.find((row) =>
    row.token === route.token &&
    row.template === route.templateId &&
    row.timeframe === String(route.timeframeMinutes) &&
    row.entryTrendRegime === route.regime &&
    row.exitParity === route.exitMode &&
    sameParams(parseParamString(row.params ?? ''), route.paramsObject)
  ) ?? null;
}

function formatMetric(value: string | number | undefined, digits = 2): string {
  if (value === undefined) return '-';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '-');
  return numeric.toFixed(digits);
}

function buildMarkdown(sweepDate: string, routes: LiveRoute[], candidateRows: CandidateRow[], sweepRows: SweepRow[]): string {
  const matched = routes.map((route) => ({
    route,
    candidate: findCandidateRow(route, candidateRows),
    sweep: findSweepRow(route, sweepRows),
  }));

  const matchedCandidates = matched.filter((item) => item.candidate);
  const totalTrades = matchedCandidates.reduce((sum, item) => sum + Number(item.candidate?.trades ?? 0), 0);
  const totalPnlPct = matchedCandidates.reduce((sum, item) => sum + Number(item.candidate?.pnlPct ?? 0), 0);
  const avgWinRate = totalTrades > 0
    ? matchedCandidates.reduce((sum, item) => sum + Number(item.candidate?.trades ?? 0) * Number(item.candidate?.winRatePct ?? 0), 0) / totalTrades
    : 0;

  const tokenRegimeTrades = new Map<string, Record<TrendRegime, number>>();
  for (const item of matchedCandidates) {
    const entry = tokenRegimeTrades.get(item.route.token) ?? { uptrend: 0, downtrend: 0, sideways: 0 };
    entry[item.route.regime] += Number(item.candidate?.trades ?? 0);
    tokenRegimeTrades.set(item.route.token, entry);
  }

  const lines: string[] = [];
  lines.push('# Live Candidate Summary');
  lines.push('');
  lines.push(`- Sweep date: \`${sweepDate}\``);
  lines.push(`- Active live routes: \`${routes.length}\``);
  lines.push(`- Exact candidate matches: \`${matchedCandidates.length}\``);
  lines.push(`- Missing candidate matches: \`${matched.length - matchedCandidates.length}\``);
  lines.push(`- Total trades (candidate aggregate): \`${totalTrades}\``);
  lines.push(`- Total PnL % (candidate aggregate): \`${formatMetric(totalPnlPct)}%\``);
  lines.push(`- Avg win rate (trade-weighted): \`${formatMetric(avgWinRate)}%\``);
  lines.push('');
  lines.push('## Trades By Token / Regime');
  lines.push('');
  for (const [token, regimes] of Array.from(tokenRegimeTrades.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- ${token}: ${regimes.uptrend} uptrend, ${regimes.downtrend} downtrend, ${regimes.sideways} sideways`);
  }
  lines.push('');
  lines.push('| Token | Regime | Route | TF | Template | Bucket | Trades | WR% | Adj WR% | PnL% | PF | Avg Hold | Candidate Rank | Source | Params |');
  lines.push('| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');

  for (const item of matched) {
    const row = item.candidate;
    if (!row) continue;
    lines.push(
      `| ${item.route.token} | ${item.route.regime} | \`${item.route.routeId}\` | ${item.route.timeframeMinutes}m | ${item.route.templateId} | ${row.__bucket} | ${row.trades ?? '-'} | ${formatMetric(row.winRatePct)} | ${formatMetric(row.adjustedWinRatePct)} | ${formatMetric(row.pnlPct)} | ${formatMetric(row.profitFactor)} | ${formatMetric(row.avgHoldMinutes, 1)} | ${row.__rank ?? '-'} | \`${row.__source}\` | \`${row.params ?? '-'}\` |`,
    );
  }

  const missing = matched.filter((item) => !item.candidate);
  if (missing.length > 0) {
    lines.push('');
    lines.push('## Missing Exact Candidate Rows');
    lines.push('');
    lines.push('| Token | Regime | Route | TF | Template | Sweep Row? | Sweep Trades | Sweep PnL% | Sweep PF | Params |');
    lines.push('| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |');
    for (const item of missing) {
      const sweep = item.sweep;
      lines.push(
        `| ${item.route.token} | ${item.route.regime} | \`${item.route.routeId}\` | ${item.route.timeframeMinutes}m | ${item.route.templateId} | ${sweep ? 'yes' : 'no'} | ${sweep?.trades ?? '-'} | ${formatMetric(sweep?.pnlPct)} | ${formatMetric(sweep?.profitFactor)} | \`${Object.entries(item.route.paramsObject).map(([k, v]) => `${k}=${v}`).join(' ')}\` |`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildCsv(routes: LiveRoute[], candidateRows: CandidateRow[], sweepRows: SweepRow[]): string {
  const headers = [
    'token',
    'regime',
    'routeId',
    'timeframeMinutes',
    'templateId',
    'bucket',
    'candidateRank',
    'trades',
    'winRatePct',
    'adjustedWinRatePct',
    'pnlPct',
    'profitFactor',
    'avgHoldMinutes',
    'params',
    'candidateSource',
    'sweepFound',
    'sweepTrades',
    'sweepPnlPct',
    'sweepProfitFactor',
  ];
  const lines = [headers.join(',')];

  for (const route of routes) {
    const candidate = findCandidateRow(route, candidateRows);
    const sweep = findSweepRow(route, sweepRows);
    const values = [
      route.token,
      route.regime,
      route.routeId,
      String(route.timeframeMinutes),
      route.templateId,
      candidate?.__bucket ?? '',
      candidate?.__rank !== undefined ? String(candidate.__rank) : '',
      candidate?.trades ?? '',
      candidate?.winRatePct ?? '',
      candidate?.adjustedWinRatePct ?? '',
      candidate?.pnlPct ?? '',
      candidate?.profitFactor ?? '',
      candidate?.avgHoldMinutes ?? '',
      candidate?.params ?? Object.entries(route.paramsObject).map(([k, v]) => `${k}=${v}`).join(' '),
      candidate?.__source ?? '',
      sweep ? 'yes' : 'no',
      sweep?.trades ?? '',
      sweep?.pnlPct ?? '',
      sweep?.profitFactor ?? '',
    ].map((value) => String(value).replace(/,/g, ';'));

    lines.push(values.join(','));
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const sweepDate = getArg('--sweep-date') ?? getArg('--date') ?? utcDateToday();
  const candidateDir = resolveDir('--candidate-dir', CANDIDATES_DIR);
  const sweepDir = resolveDir('--sweep-dir', SWEEP_RESULTS_DIR);
  const outDir = resolveDir('--out-dir', REPORTS_DIR);
  const liveMap = readJson<LiveMap>(CONFIG_PATH);
  const routes = flattenLiveRoutes(liveMap);
  const candidateRows = loadCandidateRows(sweepDate, candidateDir);
  const sweepRows = loadSweepRows(sweepDate, sweepDir);

  if (candidateRows.length === 0) {
    throw new Error(`No candidate files found for ${sweepDate} in ${candidateDir}. Run sweep-candidates for 1m/5m/15m first.`);
  }

  ensureDir(outDir);
  const mdPath = path.join(outDir, `${sweepDate}.live-candidate-summary.md`);
  const csvPath = path.join(outDir, `${sweepDate}.live-candidate-summary.csv`);
  fs.writeFileSync(mdPath, buildMarkdown(sweepDate, routes, candidateRows, sweepRows));
  fs.writeFileSync(csvPath, buildCsv(routes, candidateRows, sweepRows));
  console.log(`Saved live candidate summary: ${mdPath}`);
  console.log(`Saved live candidate CSV: ${csvPath}`);
}

main();
