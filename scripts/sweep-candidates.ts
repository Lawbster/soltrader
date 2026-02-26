import fs from 'fs';
import path from 'path';

type TrendRegime = 'uptrend' | 'sideways' | 'downtrend' | 'unknown';

const TREND_WEIGHTS = {
  ret24h: 0.5,
  ret48h: 0.3,
  ret72h: 0.2,
};

const DATA_ROOT = path.resolve(__dirname, '../data/data');
const CANDLES_ROOT = path.join(DATA_ROOT, 'candles');
const WATCHLIST_PATH = path.resolve(__dirname, '../config/watchlist.json');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface CandlePoint {
  timestamp: number;
  close: number;
}

interface WatchlistEntry {
  mint: string;
  label: string;
}

interface TrendFallback {
  tokenRet24hPct: number | null;
  tokenRet48hPct: number | null;
  tokenRet72hPct: number | null;
  tokenRet168hPct: number | null;
  tokenRetWindowPct: number | null;
  trendScore: number | null;
  trendRegime: TrendRegime;
  trendCoverageDays: number | null;
}

let watchlistByLabelCache: Map<string, string> | null = null;
const mintCandlesCache = new Map<string, CandlePoint[]>();
const trendFallbackCache = new Map<string, TrendFallback | null>();

interface CliArgs {
  file?: string;
  dir: string;
  minWinRate: number;
  probeMinTrades: number;
  probeMaxTrades: number;
  coreMinTrades: number;
  coreMinProfitFactor: number;
  coreMinPnlPct: number;
  priorWins: number;
  priorLosses: number;
  top: number;
  topPerToken: number;
  outDir?: string;
  writeCsv: boolean;
  rankExitParity: 'indicator' | 'price' | 'both';
}

interface SweepRow {
  template: string;
  token: string;
  timeframe: number;
  maxPositions: number;
  params: string;
  trades: number;
  winRate: number;
  pnlPct: number;
  profitFactor: number | null;
  sharpeRatio: number;
  maxDrawdownPct: number;
  avgWinLossRatio: number | null;
  avgWinPct: number;
  avgLossPct: number;
  avgHoldMinutes: number;
  tradesPerDay: number;
  tokenRet24hPct: number | null;
  tokenRet48hPct: number | null;
  tokenRet72hPct: number | null;
  tokenRet168hPct: number | null;
  tokenRetWindowPct: number | null;
  tokenVol24hPct: number | null;
  trendScore: number | null;
  trendRegime: TrendRegime;
  relRet24hVsSolPct: number | null;
  trendCoverageDays: number | null;
  exitParity: 'indicator' | 'price' | null; // null if column absent (pre-parity CSVs)
}

interface CandidateRow extends SweepRow {
  wins: number;
  losses: number;
  adjustedWinRate: number;
  expectancyPct: number;
  scoreProbe: number;
  scoreCore: number;
  combinedStat: number;
  alpha24hPct: number | null;
  alpha48hPct: number | null;
  alpha72hPct: number | null;
  alphaWindowPct: number | null;
  alphaBlendPct: number | null;
  trendAdjustedScore: number;
  parityDelta: number | null; // price.pnlPct - indicator.pnlPct; null if not paired
}

interface PatternRow {
  template: string;
  params: string;
  rows: number;
  tokens: number;
  avgTrades: number;
  avgWinRate: number;
  avgAdjustedWinRate: number;
  avgPnlPct: number;
  avgProfitFactor: number | null;
  avgHoldMinutes: number;
  avgExpectancyPct: number;
  avgTrendAdjustedScore: number;
  avgAlphaWindowPct: number | null;
  avgAlphaBlendPct: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dir: path.resolve(__dirname, '../data/data/sweep-results'),
    minWinRate: 65,
    probeMinTrades: 4,
    probeMaxTrades: 11,
    coreMinTrades: 12,
    coreMinProfitFactor: 1.2,
    coreMinPnlPct: 0,
    priorWins: 3,
    priorLosses: 3,
    top: 25,
    topPerToken: 5,
    writeCsv: true,
    rankExitParity: 'indicator',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (!arg.startsWith('--') && !args.file) {
      args.file = path.resolve(arg);
      continue;
    }
    if (arg === '--file') {
      args.file = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--dir') {
      args.dir = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--min-win-rate') {
      args.minWinRate = parseNumber(arg, next);
      i++;
      continue;
    }
    if (arg === '--probe-min-trades') {
      args.probeMinTrades = parseInt(requireValue(arg, next), 10);
      i++;
      continue;
    }
    if (arg === '--probe-max-trades') {
      args.probeMaxTrades = parseInt(requireValue(arg, next), 10);
      i++;
      continue;
    }
    if (arg === '--core-min-trades') {
      args.coreMinTrades = parseInt(requireValue(arg, next), 10);
      i++;
      continue;
    }
    if (arg === '--core-min-pf') {
      args.coreMinProfitFactor = parseNumber(arg, next);
      i++;
      continue;
    }
    if (arg === '--core-min-pnl') {
      args.coreMinPnlPct = parseNumber(arg, next);
      i++;
      continue;
    }
    if (arg === '--prior-wins') {
      args.priorWins = parseNumber(arg, next);
      i++;
      continue;
    }
    if (arg === '--prior-losses') {
      args.priorLosses = parseNumber(arg, next);
      i++;
      continue;
    }
    if (arg === '--top') {
      args.top = parseInt(requireValue(arg, next), 10);
      i++;
      continue;
    }
    if (arg === '--top-per-token') {
      args.topPerToken = parseInt(requireValue(arg, next), 10);
      i++;
      continue;
    }
    if (arg === '--out-dir') {
      args.outDir = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--no-csv') {
      args.writeCsv = false;
      continue;
    }
    if (arg === '--rank-exit-parity') {
      const v = requireValue(arg, next);
      if (v !== 'indicator' && v !== 'price' && v !== 'both') {
        throw new Error(`--rank-exit-parity must be indicator|price|both, got: ${v}`);
      }
      args.rankExitParity = v;
      i++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.probeMaxTrades < args.probeMinTrades) {
    throw new Error('--probe-max-trades must be >= --probe-min-trades');
  }
  if (args.coreMinTrades <= args.probeMaxTrades) {
    throw new Error('--core-min-trades should be > --probe-max-trades for clear buckets');
  }
  if (args.top <= 0) {
    throw new Error('--top must be > 0');
  }
  if (args.topPerToken <= 0) {
    throw new Error('--top-per-token must be > 0');
  }

  return args;
}

function printHelp(): void {
  const help = [
    'Usage:',
    '  npm run sweep-candidates',
    '  npm run sweep-candidates -- rsi2026-02-22-1min.csv',
    '  npm run sweep-candidates -- --file data/data/sweep-results/rsi2026-02-22-1min.csv',
    '',
    'Optional flags:',
    '  --dir PATH                Sweep directory (default: data/data/sweep-results)',
    '  --min-win-rate N          Minimum raw win rate filter (default: 65)',
    '  --probe-min-trades N      Probe bucket min trades (default: 4)',
    '  --probe-max-trades N      Probe bucket max trades (default: 11)',
    '  --core-min-trades N       Core bucket min trades (default: 12)',
    '  --core-min-pf N           Core min profit factor (default: 1.2)',
    '  --core-min-pnl N          Core min pnl % (default: 0)',
    '  --prior-wins N            Bayesian prior wins for adjusted WR (default: 3)',
    '  --prior-losses N          Bayesian prior losses for adjusted WR (default: 3)',
    '  --top N                   Max total rows per bucket in console/CSV (default: 25)',
    '  --top-per-token N         Max rows per token per bucket (default: 5)',
    '  --out-dir PATH            Output directory for ranked CSVs (default: <source-dir>/candidates)',
    '  --no-csv                  Do not write output CSVs',
    '  --rank-exit-parity MODE   indicator (default)|price|both — which exitParity rows to rank',
    '                            indicator: rank only indicator rows (default when parity data present)',
    '                            price: rank only price rows (use when deploying exitMode=price)',
    '                            both: rank all rows (note: same strategy may appear twice)',
  ];
  console.log(help.join('\n'));
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseNumber(flag: string, value: string | undefined): number {
  const parsed = Number(requireValue(flag, value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${flag}: ${value}`);
  }
  return parsed;
}

function parseOptionalNumber(parts: string[], idx: number | undefined): number | null {
  if (idx === undefined) return null;
  const raw = parts[idx];
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTrendRegime(value: string | undefined): TrendRegime {
  if (value === 'uptrend' || value === 'sideways' || value === 'downtrend' || value === 'unknown') {
    return value;
  }
  return 'unknown';
}

function classifyRegimeFromReturns(
  ret24h: number | null,
  ret48h: number | null,
  ret72h: number | null,
  trendScoreFromRow: number | null,
): TrendRegime {
  let trendScore = trendScoreFromRow;
  if (trendScore === null) {
    const weighted = weightedAverageReturns(ret24h, ret48h, ret72h);
    trendScore = weighted;
  }
  if (trendScore === null) return 'unknown';
  const gate24 = ret24h ?? trendScore;
  if (trendScore >= 8 && gate24 >= 3) return 'uptrend';
  if (trendScore <= -6 && gate24 <= -2) return 'downtrend';
  return 'sideways';
}

function weightedAverageReturns(
  ret24h: number | null,
  ret48h: number | null,
  ret72h: number | null,
): number | null {
  const parts: Array<{ v: number; w: number }> = [];
  if (ret24h !== null) parts.push({ v: ret24h, w: TREND_WEIGHTS.ret24h });
  if (ret48h !== null) parts.push({ v: ret48h, w: TREND_WEIGHTS.ret48h });
  if (ret72h !== null) parts.push({ v: ret72h, w: TREND_WEIGHTS.ret72h });
  if (parts.length === 0) return null;
  const wSum = parts.reduce((s, p) => s + p.w, 0);
  if (wSum <= 0) return null;
  return parts.reduce((s, p) => s + p.v * p.w, 0) / wSum;
}

function resolveInputFile(args: CliArgs): string {
  if (args.file) {
    if (!fs.existsSync(args.file)) {
      throw new Error(`Sweep file not found: ${args.file}`);
    }
    return args.file;
  }

  if (!fs.existsSync(args.dir)) {
    throw new Error(`Sweep directory not found: ${args.dir}`);
  }

  const files = fs.readdirSync(args.dir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.csv'))
    .map(d => path.join(args.dir, d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (files.length === 0) {
    throw new Error(`No CSV files found in ${args.dir}`);
  }

  return files[0];
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map(v => v.trim());
}

function parseSweepCsv(filePath: string): SweepRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  const required = [
    'template', 'token', 'timeframe', 'params', 'trades', 'winRate', 'pnlPct',
    'profitFactor', 'sharpeRatio', 'maxDrawdownPct', 'avgWinLossRatio',
    'avgWinPct', 'avgLossPct', 'avgHoldMinutes', 'tradesPerDay',
  ];

  for (const col of required) {
    if (!header.includes(col)) {
      throw new Error(`Missing required column "${col}" in ${filePath}`);
    }
  }

  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const rows: SweepRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length !== header.length) continue;

    const profitFactorRaw = parts[idx.profitFactor];
    const avgWinLossRaw = parts[idx.avgWinLossRatio];

    const row: SweepRow = {
      template: parts[idx.template],
      token: parts[idx.token],
      timeframe: Number(parts[idx.timeframe]),
      maxPositions: idx.maxPositions !== undefined ? Number(parts[idx.maxPositions]) : 1,
      params: parts[idx.params],
      trades: Number(parts[idx.trades]),
      winRate: Number(parts[idx.winRate]),
      pnlPct: Number(parts[idx.pnlPct]),
      profitFactor: profitFactorRaw === '' ? null : Number(profitFactorRaw),
      sharpeRatio: Number(parts[idx.sharpeRatio]),
      maxDrawdownPct: Number(parts[idx.maxDrawdownPct]),
      avgWinLossRatio: avgWinLossRaw === '' ? null : Number(avgWinLossRaw),
      avgWinPct: Number(parts[idx.avgWinPct]),
      avgLossPct: Number(parts[idx.avgLossPct]),
      avgHoldMinutes: Number(parts[idx.avgHoldMinutes]),
      tradesPerDay: Number(parts[idx.tradesPerDay]),
      tokenRet24hPct: parseOptionalNumber(parts, idx.tokenRet24hPct),
      tokenRet48hPct: parseOptionalNumber(parts, idx.tokenRet48hPct),
      tokenRet72hPct: parseOptionalNumber(parts, idx.tokenRet72hPct),
      tokenRet168hPct: parseOptionalNumber(parts, idx.tokenRet168hPct),
      tokenRetWindowPct: parseOptionalNumber(parts, idx.tokenRetWindowPct),
      tokenVol24hPct: parseOptionalNumber(parts, idx.tokenVol24hPct),
      trendScore: parseOptionalNumber(parts, idx.trendScore),
      trendRegime: 'unknown',
      relRet24hVsSolPct: parseOptionalNumber(parts, idx.relRet24hVsSolPct),
      trendCoverageDays: parseOptionalNumber(parts, idx.trendCoverageDays),
      exitParity: idx.exitParity !== undefined
        ? (parts[idx.exitParity] === 'price' ? 'price' : parts[idx.exitParity] === 'indicator' ? 'indicator' : null)
        : null,
    };

    row.trendRegime = idx.trendRegime !== undefined
      ? parseTrendRegime(parts[idx.trendRegime])
      : classifyRegimeFromReturns(
        row.tokenRet24hPct,
        row.tokenRet48hPct,
        row.tokenRet72hPct,
        row.trendScore,
      );
    if (row.trendRegime === 'unknown') {
      row.trendRegime = classifyRegimeFromReturns(
        row.tokenRet24hPct,
        row.tokenRet48hPct,
        row.tokenRet72hPct,
        row.trendScore,
      );
    }

    if (!Number.isFinite(row.trades) || row.trades <= 0) continue;
    if (!Number.isFinite(row.winRate)) continue;
    if (!Number.isFinite(row.pnlPct)) continue;
    rows.push(row);
  }

  return rows;
}

function buildParityDeltaMap(rows: SweepRow[]): Map<string, number | null> {
  const indicatorMap = new Map<string, number>();
  const priceMap = new Map<string, number>();
  for (const row of rows) {
    if (row.exitParity === null) continue;
    const key = `${row.template}||${row.token}||${row.params}`;
    if (row.exitParity === 'indicator') indicatorMap.set(key, row.pnlPct);
    else if (row.exitParity === 'price') priceMap.set(key, row.pnlPct);
  }
  const result = new Map<string, number | null>();
  const allKeys = new Set([...indicatorMap.keys(), ...priceMap.keys()]);
  for (const key of allKeys) {
    const indPnl = indicatorMap.get(key);
    const pricePnl = priceMap.get(key);
    result.set(key, indPnl !== undefined && pricePnl !== undefined ? pricePnl - indPnl : null);
  }
  return result;
}

function computeCombinedStat(
  pnlPct: number,
  trades: number,
  avgHoldMinutes: number,
  profitFactor: number | null,
  maxDrawdownPct: number,
): number {
  if (pnlPct <= 0) return 0; // unprofitable strategies score 0

  // Capital efficiency: log hold adjustment (mild ±30% modifier on pnlPct)
  // neutral at 60min, bonus for shorter holds, penalty for longer
  const holdAdj = Math.log(60 / Math.max(avgHoldMinutes, 5));
  const adjustedReturn = pnlPct * (1 + holdAdj * 0.3);

  // Sample confidence: normalized [0→1], saturates at 50 trades
  const tradeWeight = Math.log(Math.max(trades, 1) + 1) / Math.log(51);

  // Drawdown penalty: quadratic — barely affects small DD, punishes large DD hard
  const ddPenalty = Math.max(1 - Math.pow(maxDrawdownPct / 25, 2), 0);

  // PF bonus: soft additive, max +20% at PF >= 3
  const pfBonus = profitFactor !== null ? Math.min((profitFactor - 1.0) / 2, 1.0) : 0;

  return adjustedReturn * tradeWeight * ddPenalty * (1 + pfBonus * 0.2);
}

function alphaFromReturn(pnlPct: number, baselineRetPct: number | null): number | null {
  if (baselineRetPct === null) return null;
  return pnlPct - baselineRetPct;
}

function computeTrendAdjustedScore(
  combinedStat: number,
  alphaWindowPct: number | null,
  alphaBlendPct: number | null,
  parityDelta: number | null = null,
): number {
  const alphaWindow = clamp(alphaWindowPct ?? 0, -50, 50);
  const alphaBlend = clamp(alphaBlendPct ?? 0, -50, 50);
  // parityAdj: penalizes strategies that rely on indicator exits not available live.
  // Max -2 at delta <= -20pp, max +2 at delta >= +20pp.
  const parityAdj = parityDelta !== null ? clamp(parityDelta * 0.10, -2, 2) : 0;
  return combinedStat + (0.20 * alphaWindow) + (0.10 * alphaBlend) + parityAdj;
}

function toCandidate(row: SweepRow, priorWins: number, priorLosses: number, parityDelta: number | null = null): CandidateRow {
  const wins = (row.winRate / 100) * row.trades;
  const losses = Math.max(row.trades - wins, 0);
  const adjustedWinRate = (wins + priorWins) / (row.trades + priorWins + priorLosses);
  const expectancyPct = ((row.winRate / 100) * row.avgWinPct) + ((1 - row.winRate / 100) * row.avgLossPct);

  const pnlBoost = 1 + clamp(row.pnlPct, -25, 25) / 100;
  const pfBoost = 1 + clamp((row.profitFactor ?? 0) - 1, -0.5, 2) / 5;
  const depthBoost = 1 + clamp((row.trades - 3) / 50, 0, 1);

  const scoreProbe = adjustedWinRate * Math.log(row.trades + 1) * pnlBoost;
  const scoreCore = adjustedWinRate * Math.log(row.trades + 1) * pfBoost * depthBoost;
  const combinedStat = computeCombinedStat(
    row.pnlPct,
    row.trades,
    row.avgHoldMinutes,
    row.profitFactor,
    row.maxDrawdownPct,
  );
  const weightedRetBaseline = weightedAverageReturns(
    row.tokenRet24hPct,
    row.tokenRet48hPct,
    row.tokenRet72hPct,
  );
  const alpha24hPct = alphaFromReturn(row.pnlPct, row.tokenRet24hPct);
  const alpha48hPct = alphaFromReturn(row.pnlPct, row.tokenRet48hPct);
  const alpha72hPct = alphaFromReturn(row.pnlPct, row.tokenRet72hPct);
  const alphaWindowPct = alphaFromReturn(row.pnlPct, row.tokenRetWindowPct);
  const alphaBlendPct = alphaFromReturn(row.pnlPct, weightedRetBaseline);
  const trendAdjustedScore = computeTrendAdjustedScore(combinedStat, alphaWindowPct, alphaBlendPct, parityDelta);

  return {
    ...row,
    wins,
    losses,
    adjustedWinRate,
    expectancyPct,
    scoreProbe,
    scoreCore,
    combinedStat,
    alpha24hPct,
    alpha48hPct,
    alpha72hPct,
    alphaWindowPct,
    alphaBlendPct,
    trendAdjustedScore,
    parityDelta,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function capPerToken<T extends { token: string }>(rows: T[], maxPerToken: number): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const row of rows) {
    const count = counts.get(row.token) ?? 0;
    if (count < maxPerToken) {
      out.push(row);
      counts.set(row.token, count + 1);
    }
  }
  return out;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function formatPct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatNum(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function formatOptionalNum(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '';
  return value.toFixed(digits);
}

function printCandidateTable(title: string, rows: CandidateRow[], top: number, topPerToken: number): void {
  if (rows.length === 0) {
    console.log(`\n${title} (top 0):`);
    console.log('  none');
    return;
  }

  // Count qualifying entries per token before capping
  const tokenCounts = new Map<string, number>();
  for (const r of rows) tokenCounts.set(r.token, (tokenCounts.get(r.token) ?? 0) + 1);

  const ranked = capPerToken(
    rows.slice().sort((a, b) => {
      const diff = b.trendAdjustedScore - a.trendAdjustedScore;
      if (Math.abs(diff) > 1e-9) return diff;
      const combinedDiff = b.combinedStat - a.combinedStat;
      if (Math.abs(combinedDiff) > 1e-9) return combinedDiff;
      return b.pnlPct - a.pnlPct;
    }),
    topPerToken
  ).slice(0, top);

  console.log(`\n${title} (top ${ranked.length}):`);
  for (const [token, count] of [...tokenCounts.entries()].sort()) {
    const shown = ranked.filter(r => r.token === token).length;
    console.log(`  ${token}: ${count} qualifying (showing ${shown})`);
  }
  if (ranked.length === 0) {
    console.log('  none');
    return;
  }

  const table = ranked.map((r, i) => ({
    rank: i + 1,
    token: r.token,
    template: r.template,
    trades: r.trades,
    winRate: `${r.winRate.toFixed(2)}%`,
    adjWR: `${(r.adjustedWinRate * 100).toFixed(2)}%`,
    pnlPct: `${r.pnlPct.toFixed(4)}%`,
    pf: r.profitFactor === null ? 'n/a' : r.profitFactor.toFixed(3),
    holdMin: r.avgHoldMinutes.toFixed(1),
    regime: r.trendRegime,
    alphaW: r.alphaWindowPct === null ? 'n/a' : `${r.alphaWindowPct.toFixed(2)}%`,
    score: r.trendAdjustedScore.toFixed(4),
    params: r.params,
  }));

  console.table(table);
}

function printRegimeBreakdown(label: string, rows: CandidateRow[]): void {
  if (rows.length === 0) return;
  const counts = new Map<TrendRegime, number>();
  for (const row of rows) {
    counts.set(row.trendRegime, (counts.get(row.trendRegime) ?? 0) + 1);
  }
  const text = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  if (text) {
    console.log(`${label} regimes: ${text}`);
  }
}

function buildPatterns(rows: CandidateRow[]): PatternRow[] {
  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const key = `${row.template}||${row.params}`;
    const arr = groups.get(key);
    if (arr) arr.push(row);
    else groups.set(key, [row]);
  }

  const out: PatternRow[] = [];
  for (const [key, group] of groups) {
    const [template, params] = key.split('||');
    const tokens = new Set(group.map(g => g.token)).size;
    const avgProfitFactor = average(group.map(g => g.profitFactor).filter((v): v is number => v !== null));

    out.push({
      template,
      params,
      rows: group.length,
      tokens,
      avgTrades: average(group.map(g => g.trades)) ?? 0,
      avgWinRate: average(group.map(g => g.winRate)) ?? 0,
      avgAdjustedWinRate: average(group.map(g => g.adjustedWinRate)) ?? 0,
      avgPnlPct: average(group.map(g => g.pnlPct)) ?? 0,
      avgProfitFactor,
      avgHoldMinutes: average(group.map(g => g.avgHoldMinutes)) ?? 0,
      avgExpectancyPct: average(group.map(g => g.expectancyPct)) ?? 0,
      avgTrendAdjustedScore: average(group.map(g => g.trendAdjustedScore)) ?? 0,
      avgAlphaWindowPct: average(group.map(g => g.alphaWindowPct).filter((v): v is number => v !== null)),
      avgAlphaBlendPct: average(group.map(g => g.alphaBlendPct).filter((v): v is number => v !== null)),
    });
  }
  return out;
}

function printPatternTable(title: string, patterns: PatternRow[], top: number): void {
  console.log(`\n${title} (top ${Math.min(top, patterns.length)}):`);
  if (patterns.length === 0) {
    console.log('  none');
    return;
  }

  const ranked = patterns
    .slice()
    .sort((a, b) => {
      if (Math.abs(b.avgTrendAdjustedScore - a.avgTrendAdjustedScore) > 1e-9) {
        return b.avgTrendAdjustedScore - a.avgTrendAdjustedScore;
      }
      if (b.tokens !== a.tokens) return b.tokens - a.tokens;
      if (b.rows !== a.rows) return b.rows - a.rows;
      return b.avgAdjustedWinRate - a.avgAdjustedWinRate;
    })
    .slice(0, top)
    .map((p, i) => ({
      rank: i + 1,
      template: p.template,
      tokens: p.tokens,
      rows: p.rows,
      avgAdjWR: `${(p.avgAdjustedWinRate * 100).toFixed(2)}%`,
      avgWin: `${p.avgWinRate.toFixed(2)}%`,
      avgPnl: `${p.avgPnlPct.toFixed(4)}%`,
      avgAlphaW: p.avgAlphaWindowPct === null ? 'n/a' : `${p.avgAlphaWindowPct.toFixed(2)}%`,
      avgPF: p.avgProfitFactor === null ? 'n/a' : p.avgProfitFactor.toFixed(3),
      avgTrades: p.avgTrades.toFixed(1),
      avgHold: p.avgHoldMinutes.toFixed(1),
      trendScore: p.avgTrendAdjustedScore.toFixed(3),
      params: p.params,
    }));

  console.table(ranked);
}

function writeCsv<T extends Record<string, unknown>>(filePath: string, rows: T[]): void {
  if (rows.length === 0) {
    fs.writeFileSync(filePath, '', 'utf8');
    return;
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];

  for (const row of rows) {
    const cells = headers.map(h => escapeCsvCell(row[h]));
    lines.push(cells.join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const inputFile = resolveInputFile(args);
  const rows = parseSweepCsv(inputFile);

  if (rows.length === 0) {
    throw new Error(`No valid rows parsed from ${inputFile}`);
  }

  const parityDeltaMap = buildParityDeltaMap(rows);
  const hasParityColumn = rows.some(r => r.exitParity !== null);

  let rankingRows: SweepRow[];
  if (!hasParityColumn) {
    rankingRows = rows;
  } else if (args.rankExitParity === 'price') {
    rankingRows = rows.filter(r => r.exitParity === 'price');
  } else if (args.rankExitParity === 'both') {
    rankingRows = rows;
    console.log('NOTE: --rank-exit-parity=both includes both indicator and price rows. The same strategy may appear twice in candidate tables with different pnl/stats.');
  } else {
    // 'indicator' (default): only rank indicator rows; price rows used only for parityDelta
    rankingRows = rows.filter(r => r.exitParity !== 'price');
  }

  if (hasParityColumn && rankingRows.length === 0) {
    throw new Error(`No rows match --rank-exit-parity=${args.rankExitParity}. Check that the sweep CSV contains the expected exitParity values.`);
  }

  const filtered = rankingRows
    .filter(r => r.winRate >= args.minWinRate)
    .map(r => {
      const key = `${r.template}||${r.token}||${r.params}`;
      return toCandidate(r, args.priorWins, args.priorLosses, parityDeltaMap.get(key) ?? null);
    });

  const probe = filtered.filter(r => r.trades >= args.probeMinTrades && r.trades <= args.probeMaxTrades);
  const core = filtered.filter(
    r =>
      r.trades >= args.coreMinTrades &&
      r.pnlPct >= args.coreMinPnlPct &&
      (r.profitFactor ?? 0) >= args.coreMinProfitFactor,
  );

  const probePatterns = buildPatterns(probe);
  const corePatterns = buildPatterns(core);

  console.log(`Input: ${inputFile}`);
  console.log(`Rows parsed: ${rows.length}`);
  console.log(`Rows after winRate >= ${args.minWinRate}%: ${filtered.length}`);
  console.log(`Probe bucket (${args.probeMinTrades}-${args.probeMaxTrades} trades): ${probe.length}`);
  console.log(`Core bucket (trades >= ${args.coreMinTrades}, pnl >= ${args.coreMinPnlPct}%, PF >= ${args.coreMinProfitFactor}): ${core.length}`);

  const avgProbeAdj = average(probe.map(r => r.adjustedWinRate));
  const avgCoreAdj = average(core.map(r => r.adjustedWinRate));
  if (avgProbeAdj !== null) {
    console.log(`Avg probe adjusted WR: ${formatPct(avgProbeAdj)}`);
  }
  if (avgCoreAdj !== null) {
    console.log(`Avg core adjusted WR: ${formatPct(avgCoreAdj)}`);
  }
  const avgProbeAlphaW = average(probe.map(r => r.alphaWindowPct).filter((v): v is number => v !== null));
  const avgCoreAlphaW = average(core.map(r => r.alphaWindowPct).filter((v): v is number => v !== null));
  if (avgProbeAlphaW !== null) {
    console.log(`Avg probe alpha(window): ${avgProbeAlphaW.toFixed(2)}%`);
  }
  if (avgCoreAlphaW !== null) {
    console.log(`Avg core alpha(window): ${avgCoreAlphaW.toFixed(2)}%`);
  }
  printRegimeBreakdown('Probe', probe);
  printRegimeBreakdown('Core', core);

  // Parity delta report (only when --exit-parity both was used)
  const deltaRows = [...probe, ...core].filter(r => r.parityDelta !== null);
  if (deltaRows.length > 0) {
    const sorted = deltaRows.slice().sort((a, b) => (b.parityDelta ?? 0) - (a.parityDelta ?? 0));
    const topDelta = [...sorted.slice(0, 5), ...sorted.slice(-5)].filter((v, i, a) => a.indexOf(v) === i);
    console.log('\n=== Parity Delta Report (price.pnlPct - indicator.pnlPct) ===');
    console.log('(Negative = strategy relies on indicator exits unavailable live; prefer small negatives or positives)');
    console.table(topDelta.map(r => ({
      token: r.token,
      template: r.template,
      params: r.params.substring(0, 30),
      indicatorPnl: `${r.pnlPct.toFixed(2)}%`,
      parityDelta: `${(r.parityDelta! >= 0 ? '+' : '')}${r.parityDelta!.toFixed(2)}%`,
      trendAdjScore: r.trendAdjustedScore.toFixed(3),
    })));
  }

  printCandidateTable('Probe Candidates', probe, args.top, args.topPerToken);
  printPatternTable('Probe Shared Patterns', probePatterns, args.top);
  printCandidateTable('Core Candidates', core, args.top, args.topPerToken);
  printPatternTable('Core Shared Patterns', corePatterns, args.top);

  if (!args.writeCsv) return;

  const srcBase = path.basename(inputFile, '.csv');
  const outDir = args.outDir ?? path.join(path.dirname(inputFile), 'candidates');
  fs.mkdirSync(outDir, { recursive: true });

  const probeOut = path.join(outDir, `${srcBase}.probe-ranked.csv`);
  const coreOut = path.join(outDir, `${srcBase}.core-ranked.csv`);
  const patternOut = path.join(outDir, `${srcBase}.patterns.csv`);
  const coreUpOut = path.join(outDir, `${srcBase}.core-up.csv`);
  const coreSidewaysOut = path.join(outDir, `${srcBase}.core-sideways.csv`);
  const coreDownOut = path.join(outDir, `${srcBase}.core-down.csv`);
  const probeUpOut = path.join(outDir, `${srcBase}.probe-up.csv`);
  const probeSidewaysOut = path.join(outDir, `${srcBase}.probe-sideways.csv`);
  const probeDownOut = path.join(outDir, `${srcBase}.probe-down.csv`);

  const rankByTrendScore = (rows: CandidateRow[]): CandidateRow[] => rows
    .slice()
    .sort((a, b) => {
      const diff = b.trendAdjustedScore - a.trendAdjustedScore;
      if (Math.abs(diff) > 1e-9) return diff;
      const combinedDiff = b.combinedStat - a.combinedStat;
      if (Math.abs(combinedDiff) > 1e-9) return combinedDiff;
      return b.pnlPct - a.pnlPct;
    });

  const probeRows = capPerToken(
    rankByTrendScore(probe),
    args.topPerToken
  ).map(r => ({
      token: r.token,
      template: r.template,
      params: r.params,
      trendRegime: r.trendRegime,
      trendScore: formatOptionalNum(r.trendScore, 4),
      trades: r.trades,
      winRatePct: formatNum(r.winRate, 2),
      adjustedWinRatePct: formatNum(r.adjustedWinRate * 100, 2),
      pnlPct: formatNum(r.pnlPct, 4),
      alpha24hPct: formatOptionalNum(r.alpha24hPct, 4),
      alpha48hPct: formatOptionalNum(r.alpha48hPct, 4),
      alpha72hPct: formatOptionalNum(r.alpha72hPct, 4),
      alphaWindowPct: formatOptionalNum(r.alphaWindowPct, 4),
      alphaBlendPct: formatOptionalNum(r.alphaBlendPct, 4),
      tokenRet24hPct: formatOptionalNum(r.tokenRet24hPct, 4),
      tokenRet48hPct: formatOptionalNum(r.tokenRet48hPct, 4),
      tokenRet72hPct: formatOptionalNum(r.tokenRet72hPct, 4),
      tokenRetWindowPct: formatOptionalNum(r.tokenRetWindowPct, 4),
      relRet24hVsSolPct: formatOptionalNum(r.relRet24hVsSolPct, 4),
      profitFactor: r.profitFactor === null ? '' : formatNum(r.profitFactor, 4),
      avgHoldMinutes: formatNum(r.avgHoldMinutes, 1),
      expectancyPct: formatNum(r.expectancyPct, 4),
      scoreProbe: formatNum(r.scoreProbe, 6),
      combinedStat: formatNum(r.combinedStat, 6),
      trendAdjustedScore: formatNum(r.trendAdjustedScore, 6),
      parityDelta: formatOptionalNum(r.parityDelta, 4),
    }));

  const coreRows = capPerToken(
    rankByTrendScore(core),
    args.topPerToken
  ).map(r => ({
      token: r.token,
      template: r.template,
      params: r.params,
      trendRegime: r.trendRegime,
      trendScore: formatOptionalNum(r.trendScore, 4),
      trades: r.trades,
      winRatePct: formatNum(r.winRate, 2),
      adjustedWinRatePct: formatNum(r.adjustedWinRate * 100, 2),
      pnlPct: formatNum(r.pnlPct, 4),
      alpha24hPct: formatOptionalNum(r.alpha24hPct, 4),
      alpha48hPct: formatOptionalNum(r.alpha48hPct, 4),
      alpha72hPct: formatOptionalNum(r.alpha72hPct, 4),
      alphaWindowPct: formatOptionalNum(r.alphaWindowPct, 4),
      alphaBlendPct: formatOptionalNum(r.alphaBlendPct, 4),
      tokenRet24hPct: formatOptionalNum(r.tokenRet24hPct, 4),
      tokenRet48hPct: formatOptionalNum(r.tokenRet48hPct, 4),
      tokenRet72hPct: formatOptionalNum(r.tokenRet72hPct, 4),
      tokenRetWindowPct: formatOptionalNum(r.tokenRetWindowPct, 4),
      relRet24hVsSolPct: formatOptionalNum(r.relRet24hVsSolPct, 4),
      profitFactor: r.profitFactor === null ? '' : formatNum(r.profitFactor, 4),
      avgHoldMinutes: formatNum(r.avgHoldMinutes, 1),
      expectancyPct: formatNum(r.expectancyPct, 4),
      scoreCore: formatNum(r.scoreCore, 6),
      combinedStat: formatNum(r.combinedStat, 6),
      trendAdjustedScore: formatNum(r.trendAdjustedScore, 6),
      parityDelta: formatOptionalNum(r.parityDelta, 4),
    }));

  const patternRows = [...probePatterns, ...corePatterns]
    .sort((a, b) => {
      if (Math.abs(b.avgTrendAdjustedScore - a.avgTrendAdjustedScore) > 1e-9) {
        return b.avgTrendAdjustedScore - a.avgTrendAdjustedScore;
      }
      if (b.tokens !== a.tokens) return b.tokens - a.tokens;
      if (b.rows !== a.rows) return b.rows - a.rows;
      return b.avgAdjustedWinRate - a.avgAdjustedWinRate;
    })
    .map(p => ({
      template: p.template,
      params: p.params,
      rows: p.rows,
      tokens: p.tokens,
      avgTrades: formatNum(p.avgTrades, 2),
      avgWinRatePct: formatNum(p.avgWinRate, 2),
      avgAdjustedWinRatePct: formatNum(p.avgAdjustedWinRate * 100, 2),
      avgPnlPct: formatNum(p.avgPnlPct, 4),
      avgProfitFactor: p.avgProfitFactor === null ? '' : formatNum(p.avgProfitFactor, 4),
      avgHoldMinutes: formatNum(p.avgHoldMinutes, 1),
      avgExpectancyPct: formatNum(p.avgExpectancyPct, 4),
      avgAlphaWindowPct: formatOptionalNum(p.avgAlphaWindowPct, 4),
      avgAlphaBlendPct: formatOptionalNum(p.avgAlphaBlendPct, 4),
      avgTrendAdjustedScore: formatNum(p.avgTrendAdjustedScore, 6),
      bucket: probePatterns.includes(p) ? 'probe' : 'core',
    }));

  writeCsv(probeOut, probeRows);
  writeCsv(coreOut, coreRows);
  writeCsv(patternOut, patternRows);
  writeCsv(coreUpOut, coreRows.filter(r => r.trendRegime === 'uptrend'));
  writeCsv(coreSidewaysOut, coreRows.filter(r => r.trendRegime === 'sideways'));
  writeCsv(coreDownOut, coreRows.filter(r => r.trendRegime === 'downtrend'));
  writeCsv(probeUpOut, probeRows.filter(r => r.trendRegime === 'uptrend'));
  writeCsv(probeSidewaysOut, probeRows.filter(r => r.trendRegime === 'sideways'));
  writeCsv(probeDownOut, probeRows.filter(r => r.trendRegime === 'downtrend'));

  console.log('\nSaved ranked CSVs:');
  console.log(`  ${probeOut}`);
  console.log(`  ${coreOut}`);
  console.log(`  ${patternOut}`);
  console.log(`  ${coreUpOut}`);
  console.log(`  ${coreSidewaysOut}`);
  console.log(`  ${coreDownOut}`);
  console.log(`  ${probeUpOut}`);
  console.log(`  ${probeSidewaysOut}`);
  console.log(`  ${probeDownOut}`);
}

try {
  main();
} catch (err) {
  console.error(`sweep-candidates failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
