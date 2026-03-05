import fs from 'fs';
import path from 'path';

interface CliArgs {
  runDir?: string;
  rootDir: string;
  top: number;
}

interface CsvRow {
  [key: string]: string;
}

interface RankedRow {
  token: string;
  trendRegime: string;
  template: string;
  timeframe: number;
  params: string;
  windowsSeen: number;
  meanPnlPct: number;
  worstPnlPct: number;
  meanTrades: number;
  consistencyScore: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    rootDir: path.resolve(__dirname, '../data/sweep-results/window-robustness'),
    top: 20,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--run-dir') {
      args.runDir = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--root-dir') {
      args.rootDir = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--top') {
      args.top = Math.max(1, Math.round(parseNumber(arg, next)));
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
    '  npm run robustness-report',
    '  npm run robustness-report -- --top 30',
    '  npm run robustness-report -- --run-dir data/sweep-results/window-robustness/run-YYYY-MM-DDTHH-mm-ss-sssZ',
    '',
    'Options:',
    '  --run-dir PATH   Specific robustness run folder (default: latest run-* under root-dir)',
    '  --root-dir PATH  Robustness root directory (default: data/sweep-results/window-robustness)',
    '  --top N          Top rows to include in summary tables (default: 20)',
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

function readCsv(filePath: string): CsvRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length !== header.length) continue;
    const row: CsvRow = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = parts[j];
    }
    rows.push(row);
  }
  return rows;
}

function asNum(row: CsvRow, key: string, fallback = 0): number {
  const n = Number(row[key]);
  return Number.isFinite(n) ? n : fallback;
}

function pickLatestRun(rootDir: string): string {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Robustness root directory not found: ${rootDir}`);
  }
  const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('run-'))
    .map(d => path.join(rootDir, d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (dirs.length === 0) {
    throw new Error(`No run-* folders found in ${rootDir}`);
  }
  return dirs[0];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return (part / total) * 100;
}

function mapCount(rows: CsvRow[], key: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const row of rows) {
    const k = row[key] ?? '';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function formatMapCounts(m: Map<string, number>): string {
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k || '(empty)'}=${v}`)
    .join(', ');
}

function rankRows(rows: CsvRow[]): RankedRow[] {
  return rows.map(r => ({
    token: r.token,
    trendRegime: r.trendRegime,
    template: r.template,
    timeframe: asNum(r, 'timeframe'),
    params: r.params,
    windowsSeen: asNum(r, 'windowsSeen'),
    meanPnlPct: asNum(r, 'meanPnlPct'),
    worstPnlPct: asNum(r, 'worstPnlPct'),
    meanTrades: asNum(r, 'meanTrades'),
    consistencyScore: asNum(r, 'consistencyScore'),
  })).sort((a, b) => b.consistencyScore - a.consistencyScore);
}

function confidenceFromWindows(windowsSeen: number): 'strong' | 'moderate' | 'fragile' {
  if (windowsSeen >= 6) return 'strong';
  if (windowsSeen >= 4) return 'moderate';
  return 'fragile';
}

function actionFromRow(r: RankedRow): 'keep' | 'watch' | 'avoid' {
  if (r.windowsSeen >= 6 && r.worstPnlPct > 0 && r.meanTrades >= 10) return 'keep';
  if (r.windowsSeen >= 4 && r.meanPnlPct > 0 && r.meanTrades >= 8) return 'watch';
  if (r.meanPnlPct > 0) return 'watch';
  return 'avoid';
}

function toDecisionCsv(rows: RankedRow[], top: number): string {
  const header = [
    'action',
    'confidence',
    'token',
    'trendRegime',
    'template',
    'timeframe',
    'params',
    'windowsSeen',
    'meanPnlPct',
    'worstPnlPct',
    'meanTrades',
    'consistencyScore',
  ];
  const body = rows.slice(0, top).map(r => {
    const cols = [
      actionFromRow(r),
      confidenceFromWindows(r.windowsSeen),
      r.token,
      r.trendRegime,
      r.template,
      String(r.timeframe),
      r.params,
      String(r.windowsSeen),
      r.meanPnlPct.toFixed(4),
      r.worstPnlPct.toFixed(4),
      r.meanTrades.toFixed(2),
      r.consistencyScore.toFixed(6),
    ];
    return cols.map(csvEscape).join(',');
  });
  return [header.join(','), ...body].join('\n') + '\n';
}

function csvEscape(v: string): string {
  if (!/[",\n\r]/.test(v)) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.runDir ? path.resolve(args.runDir) : pickLatestRun(args.rootDir);

  const indexFile = path.join(runDir, 'window-index.csv');
  const detailsFile = path.join(runDir, 'window-candidates.csv');
  const coreFile = path.join(runDir, 'stability-core.csv');
  const probeFile = path.join(runDir, 'stability-probe.csv');
  const weekdayFile = path.join(runDir, 'weekday-patterns.csv');

  for (const file of [indexFile, detailsFile, coreFile, probeFile, weekdayFile]) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing file in run folder: ${file}`);
    }
  }

  const indexRows = readCsv(indexFile);
  const detailRows = readCsv(detailsFile);
  const coreRows = readCsv(coreFile);
  const probeRows = readCsv(probeFile);
  const weekdayRows = readCsv(weekdayFile);

  const statusCounts = mapCount(indexRows, 'status');
  const costCounts = mapCount(indexRows, 'costModeUsed');

  const corePerWindow = indexRows.map(r => asNum(r, 'coreRows'));
  const probePerWindow = indexRows.map(r => asNum(r, 'probeRows'));

  const pnlValues = detailRows.map(r => asNum(r, 'pnlPct'));
  const negativeCount = pnlValues.filter(v => v < 0).length;
  const zeroCount = pnlValues.filter(v => v === 0).length;
  const minPnl = pnlValues.length > 0 ? Math.min(...pnlValues) : 0;

  const unknownRegimeRows = detailRows.filter(r => (r.trendRegime ?? 'unknown') === 'unknown').length;
  const unknownRegimePct = pct(unknownRegimeRows, detailRows.length);

  const rankedCore = rankRows(coreRows);
  const rankedProbe = rankRows(probeRows);

  const topCore = rankedCore.slice(0, args.top);
  const topProbe = rankedProbe.slice(0, args.top);
  const topWeekday = weekdayRows
    .slice()
    .sort((a, b) => asNum(b, 'meanPnlPct') - asNum(a, 'meanPnlPct'))
    .slice(0, 10);

  const decisionCsv = toDecisionCsv(rankedCore, args.top);
  const decisionPath = path.join(runDir, 'decision-matrix.csv');
  fs.writeFileSync(decisionPath, decisionCsv, 'utf8');

  const summaryMdPath = path.join(runDir, 'robustness-summary.md');
  const lines: string[] = [];
  lines.push(`# Robustness Summary`);
  lines.push('');
  lines.push(`Run: \`${path.basename(runDir)}\``);
  lines.push(`Generated: \`${new Date().toISOString()}\``);
  lines.push('');
  lines.push('## Run Health');
  lines.push(`- Windows: ${indexRows.length}`);
  lines.push(`- Status: ${formatMapCounts(statusCounts)}`);
  lines.push(`- Cost mode used: ${formatMapCounts(costCounts)}`);
  lines.push(`- Core rows/window: min ${Math.min(...corePerWindow)}, median ${median(corePerWindow).toFixed(1)}, mean ${mean(corePerWindow).toFixed(1)}, max ${Math.max(...corePerWindow)}`);
  lines.push(`- Probe rows/window: min ${Math.min(...probePerWindow)}, median ${median(probePerWindow).toFixed(1)}, mean ${mean(probePerWindow).toFixed(1)}, max ${Math.max(...probePerWindow)}`);
  lines.push('');
  lines.push('## Data Quality Flags');
  lines.push(`- Candidate rows: ${detailRows.length}`);
  lines.push(`- Min pnl in candidate rows: ${minPnl.toFixed(4)}% (negative rows: ${negativeCount}, zero rows: ${zeroCount})`);
  if (negativeCount === 0) {
    lines.push(`- Warning: all candidate rows are non-negative. Positive-rate metrics are inflated by filtering, not pure robustness.`);
  }
  lines.push(`- Unknown regime rows: ${unknownRegimeRows}/${detailRows.length} (${unknownRegimePct.toFixed(1)}%)`);
  if (unknownRegimePct >= 30) {
    lines.push(`- Warning: high unknown-regime share; short windows likely cannot classify trend reliably.`);
  }
  const coreFragile = rankedCore.filter(r => r.windowsSeen <= 3).length;
  lines.push(`- Core rows with fragile window support (<=3 windows): ${coreFragile}/${rankedCore.length}`);
  lines.push('');
  lines.push('## Top Core Rows');
  if (topCore.length === 0) {
    lines.push('- No core stability rows met the minimum window threshold in this robustness run.');
  } else {
    for (const r of topCore) {
      lines.push(`- ${actionFromRow(r).toUpperCase()} (${confidenceFromWindows(r.windowsSeen)}): ${r.token} ${r.trendRegime} ${r.template} ${r.timeframe}m | windows=${r.windowsSeen} mean=${r.meanPnlPct.toFixed(2)}% worst=${r.worstPnlPct.toFixed(2)}% trades=${r.meanTrades.toFixed(1)} score=${r.consistencyScore.toFixed(3)} | \`${r.params}\``);
    }
  }
  lines.push('');
  lines.push('## Top Probe Rows');
  if (topProbe.length === 0) {
    lines.push('- No probe stability rows met the minimum window threshold in this robustness run.');
  } else {
    for (const r of topProbe) {
      lines.push(`- ${r.token} ${r.trendRegime} ${r.template} ${r.timeframe}m | windows=${r.windowsSeen} mean=${r.meanPnlPct.toFixed(2)}% worst=${r.worstPnlPct.toFixed(2)}% trades=${r.meanTrades.toFixed(1)} score=${r.consistencyScore.toFixed(3)} | \`${r.params}\``);
    }
  }
  lines.push('');
  lines.push('## Weekday Buckets (Top by Mean PnL)');
  for (const r of topWeekday) {
    lines.push(`- ${r.bucket} ${r.windowDays}d ${r.pair}: mean=${asNum(r, 'meanPnlPct').toFixed(2)}% median=${asNum(r, 'medianPnlPct').toFixed(2)}% positiveRate=${asNum(r, 'positiveRatePct').toFixed(1)}% rows=${asNum(r, 'rows')}`);
  }
  lines.push('');
  lines.push('## Files');
  lines.push(`- Summary: \`${summaryMdPath}\``);
  lines.push(`- Decision matrix: \`${decisionPath}\``);

  fs.writeFileSync(summaryMdPath, lines.join('\n') + '\n', 'utf8');

  console.log(`Run: ${runDir}`);
  console.log(`Summary: ${summaryMdPath}`);
  console.log(`Decision matrix: ${decisionPath}`);
}

main();
