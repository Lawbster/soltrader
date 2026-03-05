import fs from 'fs';
import path from 'path';

interface CliArgs {
  files?: string[];
  dir: string;
  outDir: string;
  top: number;
  coreMinTrades: number;
  coreMinProfitFactor: number;
  exitParity: 'indicator' | 'price' | 'both';
}

interface SweepRow {
  template: string;
  token: string;
  timeframe: number;
  exitParity: 'indicator' | 'price' | null;
  trades: number;
  pnlPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  avgHoldMinutes: number;
}

interface TemplateSummary {
  template: string;
  rows: number;
  positiveRows: number;
  nonNegativeRows: number;
  coreLikeRows: number;
  coreYieldPct: number;
  tokens: number;
  timeframes: string;
  meanPnlPct: number;
  medianPnlPct: number;
  bestPnlPct: number;
  worstPnlPct: number;
  meanProfitFactor: number | null;
  meanTrades: number;
  meanDrawdownPct: number;
  meanHoldMinutes: number;
  positiveRatePct: number;
  recommendation: 'keep' | 'watch' | 'trim' | 'disable';
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dir: path.resolve(__dirname, '../data/sweep-results'),
    outDir: path.resolve(__dirname, '../data/sweep-results/template-health'),
    top: 30,
    coreMinTrades: 12,
    coreMinProfitFactor: 1.2,
    exitParity: 'indicator',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--files') {
      args.files = requireValue(arg, next)
        .split(',')
        .map(v => path.resolve(v.trim()))
        .filter(Boolean);
      i++;
      continue;
    }
    if (arg === '--dir') {
      args.dir = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--out-dir') {
      args.outDir = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--top') {
      args.top = Math.max(1, Math.round(parseNumber(arg, next)));
      i++;
      continue;
    }
    if (arg === '--core-min-trades') {
      args.coreMinTrades = Math.max(1, Math.round(parseNumber(arg, next)));
      i++;
      continue;
    }
    if (arg === '--core-min-pf') {
      args.coreMinProfitFactor = parseNumber(arg, next);
      i++;
      continue;
    }
    if (arg === '--exit-parity') {
      const value = requireValue(arg, next);
      if (value !== 'indicator' && value !== 'price' && value !== 'both') {
        throw new Error(`--exit-parity must be indicator|price|both, got: ${value}`);
      }
      args.exitParity = value;
      i++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp(): void {
  const lines = [
    'Usage:',
    '  npm run template-health',
    '  npm run template-health -- --files data/sweep-results/2026-03-05-1min.csv,data/sweep-results/2026-03-05-5min.csv,data/sweep-results/2026-03-05-15min.csv',
    '',
    'Options:',
    '  --files CSV            Explicit sweep CSV files (default: latest 1m/5m/15m in --dir)',
    '  --dir PATH             Sweep results directory (default: data/sweep-results)',
    '  --out-dir PATH         Report output directory (default: data/sweep-results/template-health)',
    '  --top N                Top rows to print/write in markdown (default: 30)',
    '  --core-min-trades N    Core-like trade threshold (default: 12)',
    '  --core-min-pf N        Core-like PF threshold (default: 1.2)',
    '  --exit-parity MODE     indicator|price|both (default: indicator)',
  ];
  console.log(lines.join('\n'));
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

function findLatestSweepFiles(dir: string): string[] {
  const files = [1, 5, 15].map(tf => {
    const suffix = `-${tf}min.csv`;
    const matches = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith(suffix))
      .map(d => path.join(dir, d.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (matches.length === 0) {
      throw new Error(`No sweep CSV found for ${tf}m in ${dir}`);
    }
    return matches[0];
  });
  return Array.from(new Set(files));
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(v => v.trim());
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readSweepRows(filePath: string): SweepRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const required = ['template', 'token', 'timeframe', 'trades', 'pnlPct', 'profitFactor', 'maxDrawdownPct', 'avgHoldMinutes'];
  for (const col of required) {
    if (idx[col] === undefined) {
      throw new Error(`Missing required column "${col}" in ${filePath}`);
    }
  }

  const rows: SweepRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length !== header.length) continue;
    const row: SweepRow = {
      template: parts[idx.template],
      token: parts[idx.token],
      timeframe: Number(parts[idx.timeframe]),
      exitParity: idx.exitParity !== undefined
        ? (parts[idx.exitParity] === 'price' ? 'price' : parts[idx.exitParity] === 'indicator' ? 'indicator' : null)
        : null,
      trades: Number(parts[idx.trades]),
      pnlPct: Number(parts[idx.pnlPct]),
      profitFactor: parseOptionalNumber(parts[idx.profitFactor]),
      maxDrawdownPct: Number(parts[idx.maxDrawdownPct]),
      avgHoldMinutes: Number(parts[idx.avgHoldMinutes]),
    };
    if (!Number.isFinite(row.trades) || !Number.isFinite(row.pnlPct)) continue;
    rows.push(row);
  }

  return rows;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function classifyRecommendation(summary: TemplateSummary): TemplateSummary['recommendation'] {
  if (summary.coreLikeRows >= 20 || summary.coreYieldPct >= 3) {
    return 'keep';
  }
  if (summary.coreLikeRows >= 5 || summary.coreYieldPct >= 1 || summary.bestPnlPct >= 10) {
    return 'watch';
  }
  if (summary.positiveRows > 0 || summary.bestPnlPct > 3) {
    return 'trim';
  }
  return 'disable';
}

function buildSummaries(rows: SweepRow[], coreMinTrades: number, coreMinProfitFactor: number): TemplateSummary[] {
  const grouped = new Map<string, SweepRow[]>();
  for (const row of rows) {
    const arr = grouped.get(row.template) ?? [];
    arr.push(row);
    grouped.set(row.template, arr);
  }

  const summaries: TemplateSummary[] = [];
  for (const [template, group] of grouped.entries()) {
    const pnls = group.map(row => row.pnlPct);
    const profitFactors = group.map(row => row.profitFactor).filter((value): value is number => value !== null);
    const positiveRows = group.filter(row => row.pnlPct > 0).length;
    const nonNegativeRows = group.filter(row => row.pnlPct >= 0).length;
    const coreLikeRows = group.filter(row =>
      row.trades >= coreMinTrades &&
      row.pnlPct > 0 &&
      (row.profitFactor ?? 0) >= coreMinProfitFactor
    ).length;

    const summary: TemplateSummary = {
      template,
      rows: group.length,
      positiveRows,
      nonNegativeRows,
      coreLikeRows,
      coreYieldPct: group.length > 0 ? (coreLikeRows / group.length) * 100 : 0,
      tokens: new Set(group.map(row => row.token)).size,
      timeframes: Array.from(new Set(group.map(row => row.timeframe))).sort((a, b) => a - b).join('|'),
      meanPnlPct: average(pnls) ?? 0,
      medianPnlPct: median(pnls),
      bestPnlPct: Math.max(...pnls),
      worstPnlPct: Math.min(...pnls),
      meanProfitFactor: average(profitFactors),
      meanTrades: average(group.map(row => row.trades)) ?? 0,
      meanDrawdownPct: average(group.map(row => row.maxDrawdownPct)) ?? 0,
      meanHoldMinutes: average(group.map(row => row.avgHoldMinutes)) ?? 0,
      positiveRatePct: group.length > 0 ? (positiveRows / group.length) * 100 : 0,
      recommendation: 'watch',
    };
    summary.recommendation = classifyRecommendation(summary);
    summaries.push(summary);
  }

  return summaries.sort((a, b) => {
    if (b.coreLikeRows !== a.coreLikeRows) return b.coreLikeRows - a.coreLikeRows;
    if (Math.abs(b.positiveRatePct - a.positiveRatePct) > 1e-9) return b.positiveRatePct - a.positiveRatePct;
    if (Math.abs(b.meanPnlPct - a.meanPnlPct) > 1e-9) return b.meanPnlPct - a.meanPnlPct;
    return b.rows - a.rows;
  });
}

function csvEscape(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function writeCsv(filePath: string, rows: TemplateSummary[]): void {
  const header = [
    'template',
    'recommendation',
    'rows',
    'positiveRows',
    'nonNegativeRows',
    'coreLikeRows',
    'tokens',
    'timeframes',
    'positiveRatePct',
    'coreYieldPct',
    'meanPnlPct',
    'medianPnlPct',
    'bestPnlPct',
    'worstPnlPct',
    'meanProfitFactor',
    'meanTrades',
    'meanDrawdownPct',
    'meanHoldMinutes',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.template,
      row.recommendation,
      row.rows,
      row.positiveRows,
      row.nonNegativeRows,
      row.coreLikeRows,
      row.tokens,
      row.timeframes,
      row.positiveRatePct.toFixed(2),
      row.coreYieldPct.toFixed(2),
      row.meanPnlPct.toFixed(4),
      row.medianPnlPct.toFixed(4),
      row.bestPnlPct.toFixed(4),
      row.worstPnlPct.toFixed(4),
      row.meanProfitFactor === null ? '' : row.meanProfitFactor.toFixed(4),
      row.meanTrades.toFixed(2),
      row.meanDrawdownPct.toFixed(2),
      row.meanHoldMinutes.toFixed(2),
    ].map(csvEscape).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function writeMarkdown(filePath: string, summaries: TemplateSummary[], files: string[], top: number): void {
  const lines: string[] = [];
  lines.push('# Template Health');
  lines.push('');
  lines.push(`Generated: \`${new Date().toISOString()}\``);
  lines.push('');
  lines.push('## Inputs');
  for (const file of files) {
    lines.push(`- \`${file}\``);
  }
  lines.push('');
  lines.push('## Top Templates');
  for (const row of summaries.slice(0, top)) {
    lines.push(`- ${row.template}: ${row.recommendation} | coreLike=${row.coreLikeRows} (${row.coreYieldPct.toFixed(2)}%) | positive=${row.positiveRatePct.toFixed(1)}% | meanPnL=${row.meanPnlPct.toFixed(2)}% | best=${row.bestPnlPct.toFixed(2)}% | worst=${row.worstPnlPct.toFixed(2)}% | tf=${row.timeframes}`);
  }
  lines.push('');
  lines.push('## Disable Candidates');
  const disableRows = summaries.filter(row => row.recommendation === 'disable');
  if (disableRows.length === 0) {
    lines.push('- none');
  } else {
    for (const row of disableRows) {
      lines.push(`- ${row.template}: rows=${row.rows} positive=${row.positiveRows} meanPnL=${row.meanPnlPct.toFixed(2)}% best=${row.bestPnlPct.toFixed(2)}%`);
    }
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const files = args.files && args.files.length > 0 ? args.files : findLatestSweepFiles(args.dir);
  const missing = files.filter(file => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Sweep file(s) not found: ${missing.join(', ')}`);
  }

  const rows = files.flatMap(readSweepRows).filter(row => {
    if (args.exitParity === 'both') return true;
    if (row.exitParity === null) return true;
    return row.exitParity === args.exitParity;
  });

  if (rows.length === 0) {
    throw new Error('No sweep rows available after exit-parity filtering.');
  }

  const summaries = buildSummaries(rows, args.coreMinTrades, args.coreMinProfitFactor);

  fs.mkdirSync(args.outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const csvPath = path.join(args.outDir, `${stamp}.template-health.csv`);
  const mdPath = path.join(args.outDir, `${stamp}.template-health.md`);
  writeCsv(csvPath, summaries);
  writeMarkdown(mdPath, summaries, files, args.top);

  console.log(`Input files (${files.length}):`);
  for (const file of files) {
    console.log(`  - ${file}`);
  }
  console.log(`Rows parsed: ${rows.length}`);
  console.log(`CSV: ${csvPath}`);
  console.log(`MD: ${mdPath}`);
  console.log('\nTop template health rows:');
  console.table(
    summaries.slice(0, args.top).map(row => ({
      template: row.template,
      rec: row.recommendation,
      coreLike: row.coreLikeRows,
      positiveRatePct: row.positiveRatePct.toFixed(1),
      coreYieldPct: row.coreYieldPct.toFixed(2),
      meanPnlPct: row.meanPnlPct.toFixed(2),
      bestPnlPct: row.bestPnlPct.toFixed(2),
      worstPnlPct: row.worstPnlPct.toFixed(2),
      meanPF: row.meanProfitFactor === null ? 'n/a' : row.meanProfitFactor.toFixed(2),
      timeframes: row.timeframes,
    }))
  );
}

try {
  main();
} catch (err) {
  console.error(`template-health failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
