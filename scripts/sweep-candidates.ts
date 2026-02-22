import fs from 'fs';
import path from 'path';

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
  outDir?: string;
  writeCsv: boolean;
}

interface SweepRow {
  template: string;
  token: string;
  timeframe: number;
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
}

interface CandidateRow extends SweepRow {
  wins: number;
  losses: number;
  adjustedWinRate: number;
  expectancyPct: number;
  scoreProbe: number;
  scoreCore: number;
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
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dir: path.resolve(__dirname, '../data/data/sweep-results'),
    minWinRate: 65,
    probeMinTrades: 3,
    probeMaxTrades: 7,
    coreMinTrades: 20,
    coreMinProfitFactor: 1.1,
    coreMinPnlPct: 0,
    priorWins: 3,
    priorLosses: 3,
    top: 25,
    writeCsv: true,
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
    if (arg === '--out-dir') {
      args.outDir = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--no-csv') {
      args.writeCsv = false;
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
    '  --probe-min-trades N      Probe bucket min trades (default: 3)',
    '  --probe-max-trades N      Probe bucket max trades (default: 7)',
    '  --core-min-trades N       Core bucket min trades (default: 20)',
    '  --core-min-pf N           Core min profit factor (default: 1.1)',
    '  --core-min-pnl N          Core min pnl % (default: 0)',
    '  --prior-wins N            Bayesian prior wins for adjusted WR (default: 3)',
    '  --prior-losses N          Bayesian prior losses for adjusted WR (default: 3)',
    '  --top N                   Rows to print per bucket (default: 25)',
    '  --out-dir PATH            Output directory for ranked CSVs (default: <source-dir>/candidates)',
    '  --no-csv                  Do not write output CSVs',
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
    };

    if (!Number.isFinite(row.trades) || row.trades <= 0) continue;
    if (!Number.isFinite(row.winRate)) continue;
    if (!Number.isFinite(row.pnlPct)) continue;
    rows.push(row);
  }

  return rows;
}

function toCandidate(row: SweepRow, priorWins: number, priorLosses: number): CandidateRow {
  const wins = (row.winRate / 100) * row.trades;
  const losses = Math.max(row.trades - wins, 0);
  const adjustedWinRate = (wins + priorWins) / (row.trades + priorWins + priorLosses);
  const expectancyPct = ((row.winRate / 100) * row.avgWinPct) + ((1 - row.winRate / 100) * row.avgLossPct);

  const pnlBoost = 1 + clamp(row.pnlPct, -25, 25) / 100;
  const pfBoost = 1 + clamp((row.profitFactor ?? 0) - 1, -0.5, 2) / 5;
  const depthBoost = 1 + clamp((row.trades - 3) / 50, 0, 1);

  const scoreProbe = adjustedWinRate * Math.log(row.trades + 1) * pnlBoost;
  const scoreCore = adjustedWinRate * Math.log(row.trades + 1) * pfBoost * depthBoost;

  return {
    ...row,
    wins,
    losses,
    adjustedWinRate,
    expectancyPct,
    scoreProbe,
    scoreCore,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function printCandidateTable(title: string, rows: CandidateRow[], top: number, scoreField: 'scoreProbe' | 'scoreCore'): void {
  console.log(`\n${title} (top ${Math.min(top, rows.length)}):`);
  if (rows.length === 0) {
    console.log('  none');
    return;
  }

  const ranked = rows
    .slice()
    .sort((a, b) => {
      const scoreDiff = b[scoreField] - a[scoreField];
      if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
      const pnlDiff = b.pnlPct - a.pnlPct;
      if (Math.abs(pnlDiff) > 1e-9) return pnlDiff;
      return b.trades - a.trades;
    })
    .slice(0, top);

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
    score: r[scoreField].toFixed(4),
    params: r.params,
  }));

  console.table(table);
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
      avgPF: p.avgProfitFactor === null ? 'n/a' : p.avgProfitFactor.toFixed(3),
      avgTrades: p.avgTrades.toFixed(1),
      avgHold: p.avgHoldMinutes.toFixed(1),
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

  const filtered = rows
    .filter(r => r.winRate >= args.minWinRate)
    .map(r => toCandidate(r, args.priorWins, args.priorLosses));

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

  printCandidateTable('Probe Candidates', probe, args.top, 'scoreProbe');
  printPatternTable('Probe Shared Patterns', probePatterns, args.top);
  printCandidateTable('Core Candidates', core, args.top, 'scoreCore');
  printPatternTable('Core Shared Patterns', corePatterns, args.top);

  if (!args.writeCsv) return;

  const srcBase = path.basename(inputFile, '.csv');
  const outDir = args.outDir ?? path.join(path.dirname(inputFile), 'candidates');
  fs.mkdirSync(outDir, { recursive: true });

  const probeOut = path.join(outDir, `${srcBase}.probe-ranked.csv`);
  const coreOut = path.join(outDir, `${srcBase}.core-ranked.csv`);
  const patternOut = path.join(outDir, `${srcBase}.patterns.csv`);

  const probeRows = probe
    .slice()
    .sort((a, b) => b.scoreProbe - a.scoreProbe)
    .map(r => ({
      token: r.token,
      template: r.template,
      params: r.params,
      trades: r.trades,
      winRatePct: formatNum(r.winRate, 2),
      adjustedWinRatePct: formatNum(r.adjustedWinRate * 100, 2),
      pnlPct: formatNum(r.pnlPct, 4),
      profitFactor: r.profitFactor === null ? '' : formatNum(r.profitFactor, 4),
      avgHoldMinutes: formatNum(r.avgHoldMinutes, 1),
      expectancyPct: formatNum(r.expectancyPct, 4),
      scoreProbe: formatNum(r.scoreProbe, 6),
    }));

  const coreRows = core
    .slice()
    .sort((a, b) => b.scoreCore - a.scoreCore)
    .map(r => ({
      token: r.token,
      template: r.template,
      params: r.params,
      trades: r.trades,
      winRatePct: formatNum(r.winRate, 2),
      adjustedWinRatePct: formatNum(r.adjustedWinRate * 100, 2),
      pnlPct: formatNum(r.pnlPct, 4),
      profitFactor: r.profitFactor === null ? '' : formatNum(r.profitFactor, 4),
      avgHoldMinutes: formatNum(r.avgHoldMinutes, 1),
      expectancyPct: formatNum(r.expectancyPct, 4),
      scoreCore: formatNum(r.scoreCore, 6),
    }));

  const patternRows = [...probePatterns, ...corePatterns]
    .sort((a, b) => {
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
      bucket: probePatterns.includes(p) ? 'probe' : 'core',
    }));

  writeCsv(probeOut, probeRows);
  writeCsv(coreOut, coreRows);
  writeCsv(patternOut, patternRows);

  console.log('\nSaved ranked CSVs:');
  console.log(`  ${probeOut}`);
  console.log(`  ${coreOut}`);
  console.log(`  ${patternOut}`);
}

try {
  main();
} catch (err) {
  console.error(`sweep-candidates failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
