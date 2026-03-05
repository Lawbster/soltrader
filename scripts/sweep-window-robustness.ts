import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

type CostMode = 'fixed' | 'empirical';
type ExitParityMode = 'indicator' | 'price' | 'both';
type RankExitParityMode = 'indicator' | 'price' | 'both';
type Bucket = 'core' | 'probe';
type TrendRegime = 'uptrend' | 'sideways' | 'downtrend' | 'unknown';

interface CliArgs {
  from: string;
  to: string;
  windowDays: number[];
  stepDays: number;
  minWindows: number;
  timeframes: number[];
  cost: CostMode;
  exitParity: ExitParityMode;
  rankExitParity: RankExitParityMode;
  empiricalFallback: 'fixed' | 'none';
  maxPositions?: number;
  top: number;
  topPerToken: number;
  minWinRate: number;
  minPnl: number;
  sweepDir: string;
  outDir: string;
  requireTimeframes: boolean;
  timeframeSupportMin: number;
  template?: string;
  token?: string;
  dryRun: boolean;
}

interface WindowSpec {
  id: string;
  windowDays: number;
  from: string;
  to: string;
  startDow: string;
  endDow: string;
}

interface WindowRunSummary {
  windowId: string;
  windowDays: number;
  from: string;
  to: string;
  startDow: string;
  endDow: string;
  coreRows: number;
  probeRows: number;
  status: 'ok' | 'dry-run' | 'failed';
  costModeUsed: CostMode;
  error?: string;
  sweepFiles: string;
  coreFile?: string;
  probeFile?: string;
}

interface CandidateRow {
  token: string;
  template: string;
  timeframe: number;
  params: string;
  trendRegime: TrendRegime;
  trades: number;
  winRatePct: number;
  adjustedWinRatePct: number;
  pnlPct: number;
  profitFactor: number | null;
  avgHoldMinutes: number;
  mtfScore: number;
}

interface WindowCandidateRow extends CandidateRow {
  windowId: string;
  windowDays: number;
  from: string;
  to: string;
  startDow: string;
  endDow: string;
  bucket: Bucket;
}

interface StabilityRow {
  bucket: Bucket;
  token: string;
  trendRegime: TrendRegime;
  template: string;
  timeframe: number;
  params: string;
  windowsSeen: number;
  positiveWindows: number;
  nonNegativeWindows: number;
  negativeWindows: number;
  positiveRatePct: number;
  nonNegativeRatePct: number;
  meanPnlPct: number;
  medianPnlPct: number;
  stdPnlPct: number;
  worstPnlPct: number;
  bestPnlPct: number;
  meanTrades: number;
  meanWinRatePct: number;
  meanAdjustedWinRatePct: number;
  meanHoldMinutes: number;
  meanMtfScore: number;
  meanProfitFactor: number | null;
  consistencyScore: number;
}

interface WeekdayPatternRow {
  bucket: Bucket;
  windowDays: number;
  pair: string;
  windows: number;
  rows: number;
  positiveRatePct: number;
  meanPnlPct: number;
  medianPnlPct: number;
  meanMtfScore: number;
}

function printHelp(): void {
  const lines = [
    'Usage:',
    '  npm run sweep-robustness -- --from YYYY-MM-DD [options]',
    '',
    'Examples:',
    '  npm run sweep-robustness -- --from 2026-02-18 --window-days 1,2 --step-days 1',
    '  npm run sweep-robustness -- --from 2026-02-18 --to 2026-03-03 --timeframes 1,5,15',
    '  npm run sweep-robustness -- rsi PUMP --from 2026-02-18 --window-days 2',
    '',
    'Options:',
    '  --from YYYY-MM-DD              Start date (required)',
    '  --to YYYY-MM-DD                End date (default: today UTC)',
    '  --window-days CSV              Rolling window sizes in days (default: 1,2)',
    '  --step-days N                  Window step in days (default: 1)',
    '  --min-windows N                Min windows for stability ranking (default: 3)',
    '  --timeframes CSV               Timeframes, e.g. 1,5,15 (default: 1,5,15)',
    '  --cost fixed|empirical         Sweep cost mode (default: empirical)',
    '  --exit-parity MODE             indicator|price|both (default: both)',
    '  --rank-exit-parity MODE        indicator|price|both (default: indicator)',
    '  --empirical-fallback MODE      fixed|none (default: fixed)',
    '                                 fixed: retry failed windows with fixed cost',
    '                                 none: fail window if empirical cost cannot load',
    '  --max-positions N              Pass-through to sweep',
    '  --top N                        Pass-through to sweep-candidates (default: 300)',
    '  --top-per-token N              Pass-through to sweep-candidates (default: 75)',
    '  --min-win-rate N               Pass-through to sweep-candidates (default: 65)',
    '  --min-pnl N                    Pass-through to sweep-candidates (default: 0)',
    '  --sweep-dir PATH               Sweep output dir (default: data/sweep-results)',
    '  --out-dir PATH                 Robustness output dir (default: data/sweep-results/window-robustness)',
    '  --require-timeframes           Require selected TFs in candidate rows (default: disabled)',
    '  --no-require-timeframes        Disable strict TF requirement',
    '  --timeframe-support-min N      Min TF support count in candidates (default: 1)',
    '  --dry-run                      Print commands without running',
    '  -h, --help                     Show help',
    '',
    'Positional args:',
    '  [template] [token]             Optional filters passed through to sweep',
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
  const n = Number(requireValue(flag, value));
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric value for ${flag}: ${value}`);
  return n;
}

function parseEnum<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T {
  const v = requireValue(flag, value) as T;
  if (!allowed.includes(v)) {
    throw new Error(`Invalid ${flag}: ${v}. Allowed: ${allowed.join(', ')}`);
  }
  return v;
}

function parseCsvInts(csv: string, flag: string): number[] {
  const values = csv
    .split(',')
    .map(v => Number(v.trim()))
    .filter(v => Number.isFinite(v) && v >= 1)
    .map(v => Math.round(v));
  const out = Array.from(new Set(values)).sort((a, b) => a - b);
  if (out.length === 0) throw new Error(`Invalid ${flag}: ${csv}`);
  return out;
}

function formatDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDateStrict(s: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || formatDateUTC(d) !== s) {
    throw new Error(`Invalid date: ${s} (expected YYYY-MM-DD)`);
  }
  return d;
}

function addDaysUTC(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function dowName(d: Date): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    from: '',
    to: formatDateUTC(new Date()),
    windowDays: [1, 2],
    stepDays: 1,
    minWindows: 3,
    timeframes: [1, 5, 15],
    cost: 'empirical',
    exitParity: 'both',
    rankExitParity: 'indicator',
    empiricalFallback: 'fixed',
    top: 300,
    topPerToken: 75,
    minWinRate: 65,
    minPnl: 0,
    sweepDir: 'data/sweep-results',
    outDir: 'data/sweep-results/window-robustness',
    requireTimeframes: false,
    timeframeSupportMin: 1,
    dryRun: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    if (arg === '--from') { args.from = requireValue(arg, next); i++; continue; }
    if (arg === '--to') { args.to = requireValue(arg, next); i++; continue; }
    if (arg === '--window-days') { args.windowDays = parseCsvInts(requireValue(arg, next), arg); i++; continue; }
    if (arg === '--step-days') { args.stepDays = Math.max(1, Math.round(parseNumber(arg, next))); i++; continue; }
    if (arg === '--min-windows') { args.minWindows = Math.max(1, Math.round(parseNumber(arg, next))); i++; continue; }
    if (arg === '--timeframes') { args.timeframes = parseCsvInts(requireValue(arg, next), arg); i++; continue; }
    if (arg === '--cost') { args.cost = parseEnum(arg, next, ['fixed', 'empirical']); i++; continue; }
    if (arg === '--exit-parity') { args.exitParity = parseEnum(arg, next, ['indicator', 'price', 'both']); i++; continue; }
    if (arg === '--rank-exit-parity') { args.rankExitParity = parseEnum(arg, next, ['indicator', 'price', 'both']); i++; continue; }
    if (arg === '--empirical-fallback') { args.empiricalFallback = parseEnum(arg, next, ['fixed', 'none']); i++; continue; }
    if (arg === '--max-positions') { args.maxPositions = Math.max(1, Math.round(parseNumber(arg, next))); i++; continue; }
    if (arg === '--top') { args.top = Math.max(1, Math.round(parseNumber(arg, next))); i++; continue; }
    if (arg === '--top-per-token') { args.topPerToken = Math.max(1, Math.round(parseNumber(arg, next))); i++; continue; }
    if (arg === '--min-win-rate') { args.minWinRate = parseNumber(arg, next); i++; continue; }
    if (arg === '--min-pnl') { args.minPnl = parseNumber(arg, next); i++; continue; }
    if (arg === '--sweep-dir') { args.sweepDir = requireValue(arg, next); i++; continue; }
    if (arg === '--out-dir') { args.outDir = requireValue(arg, next); i++; continue; }
    if (arg === '--require-timeframes') { args.requireTimeframes = true; continue; }
    if (arg === '--no-require-timeframes') { args.requireTimeframes = false; continue; }
    if (arg === '--timeframe-support-min') { args.timeframeSupportMin = Math.max(1, Math.round(parseNumber(arg, next))); i++; continue; }
    if (arg === '--dry-run') { args.dryRun = true; continue; }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (positional.length > 2) {
    throw new Error(`Too many positional args: ${positional.join(' ')}. Expected [template] [token].`);
  }
  if (positional.length > 0) args.template = positional[0];
  if (positional.length > 1) args.token = positional[1];

  if (!args.from) throw new Error('--from is required');
  const from = parseDateStrict(args.from);
  const to = parseDateStrict(args.to);
  if (from > to) throw new Error(`--from ${args.from} must be <= --to ${args.to}`);

  return args;
}

function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function quoteForCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"&^|<>]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function runNpm(rootDir: string, cmdArgs: string[], dryRun: boolean): void {
  const display = `npm ${cmdArgs.join(' ')}`;
  console.log(`\n$ ${display}`);
  if (dryRun) return;

  const res = process.platform === 'win32'
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `${npmBin()} ${cmdArgs.map(quoteForCmd).join(' ')}`],
        { cwd: rootDir, stdio: 'inherit', shell: false },
      )
    : spawnSync(npmBin(), cmdArgs, { cwd: rootDir, stdio: 'inherit', shell: false });

  if (res.error) throw new Error(`Command spawn error: ${res.error.message} (${display})`);
  if (res.status !== 0) throw new Error(`Command failed (${res.status ?? 'unknown'}): ${display}`);
}

function findLatestSweepFileForTimeframe(sweepDirAbs: string, timeframe: number): string {
  if (!fs.existsSync(sweepDirAbs)) {
    throw new Error(`Sweep directory not found: ${sweepDirAbs}`);
  }
  const suffix = `-${timeframe}min.csv`;
  const files = fs.readdirSync(sweepDirAbs, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith(suffix))
    .map(d => path.join(sweepDirAbs, d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) {
    throw new Error(`No sweep output found for timeframe ${timeframe}m in ${sweepDirAbs}`);
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
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
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

function parseOptionalNumber(v: string | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTrendRegime(v: string | undefined): TrendRegime {
  if (v === 'uptrend' || v === 'sideways' || v === 'downtrend' || v === 'unknown') return v;
  return 'unknown';
}

function readCandidateCsv(filePath: string): CandidateRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const required = ['token', 'template', 'timeframe', 'params', 'trendRegime', 'trades', 'pnlPct'];
  for (const col of required) {
    if (idx[col] === undefined) throw new Error(`Missing required column "${col}" in ${filePath}`);
  }

  const rows: CandidateRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length !== header.length) continue;

    const timeframe = Number(parts[idx.timeframe]);
    const trades = Number(parts[idx.trades]);
    const pnlPct = Number(parts[idx.pnlPct]);
    if (!Number.isFinite(timeframe) || !Number.isFinite(trades) || !Number.isFinite(pnlPct)) continue;

    rows.push({
      token: parts[idx.token],
      template: parts[idx.template],
      timeframe,
      params: parts[idx.params],
      trendRegime: parseTrendRegime(parts[idx.trendRegime]),
      trades,
      winRatePct: parseOptionalNumber(parts[idx.winRatePct]) ?? 0,
      adjustedWinRatePct: parseOptionalNumber(parts[idx.adjustedWinRatePct]) ?? 0,
      pnlPct,
      profitFactor: parseOptionalNumber(parts[idx.profitFactor]),
      avgHoldMinutes: parseOptionalNumber(parts[idx.avgHoldMinutes]) ?? 0,
      mtfScore: parseOptionalNumber(parts[idx.mtfScore]) ?? 0,
    });
  }
  return rows;
}

function findSingleBySuffix(dir: string, suffix: string): string {
  if (!fs.existsSync(dir)) throw new Error(`Directory not found: ${dir}`);
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith(suffix))
    .map(d => path.join(dir, d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) throw new Error(`No file ending with ${suffix} in ${dir}`);
  return files[0];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const variance = mean(values.map(v => (v - m) ** 2));
  return Math.sqrt(variance);
}

function toCsv(records: Array<Record<string, string | number | null | undefined>>): string {
  if (records.length === 0) return '';
  const headers = Object.keys(records[0]);
  const lines = [headers.join(',')];
  for (const rec of records) {
    const row = headers.map(h => csvEscape(rec[h]));
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function formatStabilityRows(rows: StabilityRow[]): Array<Record<string, string | number | null>> {
  return rows.map(r => ({
    bucket: r.bucket,
    token: r.token,
    trendRegime: r.trendRegime,
    template: r.template,
    timeframe: r.timeframe,
    params: r.params,
    windowsSeen: r.windowsSeen,
    positiveWindows: r.positiveWindows,
    nonNegativeWindows: r.nonNegativeWindows,
    negativeWindows: r.negativeWindows,
    positiveRatePct: r.positiveRatePct.toFixed(2),
    nonNegativeRatePct: r.nonNegativeRatePct.toFixed(2),
    meanPnlPct: r.meanPnlPct.toFixed(4),
    medianPnlPct: r.medianPnlPct.toFixed(4),
    stdPnlPct: r.stdPnlPct.toFixed(4),
    worstPnlPct: r.worstPnlPct.toFixed(4),
    bestPnlPct: r.bestPnlPct.toFixed(4),
    meanTrades: r.meanTrades.toFixed(2),
    meanWinRatePct: r.meanWinRatePct.toFixed(2),
    meanAdjustedWinRatePct: r.meanAdjustedWinRatePct.toFixed(2),
    meanHoldMinutes: r.meanHoldMinutes.toFixed(2),
    meanMtfScore: r.meanMtfScore.toFixed(6),
    meanProfitFactor: r.meanProfitFactor === null ? '' : r.meanProfitFactor.toFixed(4),
    consistencyScore: r.consistencyScore.toFixed(6),
  }));
}

function buildWindows(from: string, to: string, windowDays: number[], stepDays: number): WindowSpec[] {
  const start = parseDateStrict(from);
  const end = parseDateStrict(to);
  const out: WindowSpec[] = [];
  for (const wd of windowDays) {
    for (let cursor = start; cursor <= end; cursor = addDaysUTC(cursor, stepDays)) {
      const windowEnd = addDaysUTC(cursor, wd - 1);
      if (windowEnd > end) break;
      const wFrom = formatDateUTC(cursor);
      const wTo = formatDateUTC(windowEnd);
      out.push({
        id: `w${wd}d-${wFrom}-to-${wTo}`,
        windowDays: wd,
        from: wFrom,
        to: wTo,
        startDow: dowName(cursor),
        endDow: dowName(windowEnd),
      });
    }
  }
  return out;
}

function normalizeOutputDir(outDirAbs: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(outDirAbs, `run-${stamp}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, '..');
  const sweepDirAbs = path.resolve(rootDir, args.sweepDir);
  const outDirAbs = path.resolve(rootDir, args.outDir);
  const runDir = normalizeOutputDir(outDirAbs);

  const windows = buildWindows(args.from, args.to, args.windowDays, args.stepDays);
  if (windows.length === 0) {
    throw new Error('No windows generated. Check --from/--to and --window-days.');
  }

  console.log(`\nWindow robustness run`);
  console.log(`Range: ${args.from} -> ${args.to}`);
  console.log(`Windows: ${windows.length} (${args.windowDays.join(',')}d, step ${args.stepDays}d)`);
  console.log(`Timeframes: ${args.timeframes.join(',')}m`);
  console.log(`Output: ${runDir}`);

  if (!args.dryRun) {
    fs.mkdirSync(runDir, { recursive: true });
  }

  const allRows: WindowCandidateRow[] = [];
  const windowSummaries: WindowRunSummary[] = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    console.log(`\n[${i + 1}/${windows.length}] ${w.id} (${w.startDow}->${w.endDow})`);

    const windowDir = path.join(runDir, `w${w.windowDays}d`, `${w.from}_to_${w.to}`);
    const sweepsCopyDir = path.join(windowDir, 'sweeps');
    const candidatesDir = path.join(windowDir, 'candidates');
    if (!args.dryRun) {
      fs.mkdirSync(sweepsCopyDir, { recursive: true });
      fs.mkdirSync(candidatesDir, { recursive: true });
    }

    const sweepFilesCopied: string[] = [];
    let status: WindowRunSummary['status'] = args.dryRun ? 'dry-run' : 'ok';
    let costModeUsed: CostMode = args.cost;
    let errMsg: string | undefined;
    let coreFile: string | undefined;
    let probeFile: string | undefined;
    let coreRowsCount = 0;
    let probeRowsCount = 0;

    try {
      const runWindowSweeps = (mode: CostMode) => {
        if (!args.dryRun) {
          fs.rmSync(sweepsCopyDir, { recursive: true, force: true });
          fs.mkdirSync(sweepsCopyDir, { recursive: true });
        }
        sweepFilesCopied.length = 0;

        for (const tf of args.timeframes) {
          const sweepCmd: string[] = ['run', 'sweep', '--'];
          if (args.template) sweepCmd.push(args.template);
          if (args.token) sweepCmd.push(args.token);
          sweepCmd.push('--timeframe', String(tf));
          sweepCmd.push('--cost', mode);
          sweepCmd.push('--exit-parity', args.exitParity);
          sweepCmd.push('--from', w.from, '--to', w.to);
          if (args.maxPositions !== undefined) sweepCmd.push('--max-positions', String(args.maxPositions));
          runNpm(rootDir, sweepCmd, args.dryRun);

          if (args.dryRun) continue;
          const latest = findLatestSweepFileForTimeframe(sweepDirAbs, tf);
          const copied = path.join(sweepsCopyDir, `${w.from}-w${w.windowDays}d-${w.to}-${tf}min.csv`);
          fs.copyFileSync(latest, copied);
          sweepFilesCopied.push(copied);
          console.log(`  copied ${tf}m sweep -> ${copied}`);
        }
      };

      try {
        runWindowSweeps(costModeUsed);
      } catch (err) {
        if (args.cost === 'empirical' && args.empiricalFallback === 'fixed') {
          console.warn(`  empirical cost failed for ${w.id}; retrying with fixed cost`);
          costModeUsed = 'fixed';
          runWindowSweeps(costModeUsed);
        } else {
          throw err;
        }
      }

      const filesArg = args.dryRun
        ? args.timeframes.map(tf => path.join(sweepsCopyDir, `${w.from}-w${w.windowDays}d-${w.to}-${tf}min.csv`)).join(',')
        : sweepFilesCopied.join(',');

      const candCmd: string[] = [
        'run', 'sweep-candidates', '--',
        '--files', filesArg,
        '--top', String(args.top),
        '--top-per-token', String(args.topPerToken),
        '--min-win-rate', String(args.minWinRate),
        '--min-pnl', String(args.minPnl),
        '--rank-exit-parity', args.rankExitParity,
        '--timeframe-support-min', String(args.timeframeSupportMin),
        '--out-dir', candidatesDir,
      ];
      if (args.requireTimeframes) {
        candCmd.push('--require-timeframes', args.timeframes.join(','));
      }
      runNpm(rootDir, candCmd, args.dryRun);

      if (!args.dryRun) {
        coreFile = findSingleBySuffix(candidatesDir, '.core-ranked.csv');
        probeFile = findSingleBySuffix(candidatesDir, '.probe-ranked.csv');
        const coreRows = readCandidateCsv(coreFile).map<WindowCandidateRow>(r => ({
          ...r,
          windowId: w.id,
          windowDays: w.windowDays,
          from: w.from,
          to: w.to,
          startDow: w.startDow,
          endDow: w.endDow,
          bucket: 'core',
        }));
        const probeRows = readCandidateCsv(probeFile).map<WindowCandidateRow>(r => ({
          ...r,
          windowId: w.id,
          windowDays: w.windowDays,
          from: w.from,
          to: w.to,
          startDow: w.startDow,
          endDow: w.endDow,
          bucket: 'probe',
        }));
        coreRowsCount = coreRows.length;
        probeRowsCount = probeRows.length;
        allRows.push(...coreRows, ...probeRows);
      }
    } catch (err) {
      status = 'failed';
      errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  failed: ${errMsg}`);
    }

    windowSummaries.push({
      windowId: w.id,
      windowDays: w.windowDays,
      from: w.from,
      to: w.to,
      startDow: w.startDow,
      endDow: w.endDow,
      coreRows: coreRowsCount,
      probeRows: probeRowsCount,
      status,
      costModeUsed,
      error: errMsg,
      sweepFiles: sweepFilesCopied.join(';'),
      coreFile,
      probeFile,
    });
  }

  if (args.dryRun) {
    console.log('\nDry-run complete.');
    return;
  }

  const okWindows = windowSummaries.filter(w => w.status === 'ok').length;
  console.log(`\nCompleted windows: ${okWindows}/${windowSummaries.length}`);

  const windowIndexCsv = toCsv(windowSummaries.map(w => ({
    windowId: w.windowId,
    windowDays: w.windowDays,
    from: w.from,
    to: w.to,
    startDow: w.startDow,
    endDow: w.endDow,
    status: w.status,
    costModeUsed: w.costModeUsed,
    error: w.error ?? '',
    coreRows: w.coreRows,
    probeRows: w.probeRows,
    sweepFiles: w.sweepFiles,
    coreFile: w.coreFile ?? '',
    probeFile: w.probeFile ?? '',
  })));
  fs.writeFileSync(path.join(runDir, 'window-index.csv'), windowIndexCsv, 'utf8');

  const detailCsv = toCsv(allRows.map(r => ({
    windowId: r.windowId,
    windowDays: r.windowDays,
    from: r.from,
    to: r.to,
    startDow: r.startDow,
    endDow: r.endDow,
    bucket: r.bucket,
    token: r.token,
    trendRegime: r.trendRegime,
    template: r.template,
    timeframe: r.timeframe,
    params: r.params,
    trades: r.trades,
    winRatePct: r.winRatePct,
    adjustedWinRatePct: r.adjustedWinRatePct,
    pnlPct: r.pnlPct,
    profitFactor: r.profitFactor ?? '',
    avgHoldMinutes: r.avgHoldMinutes,
    mtfScore: r.mtfScore,
  })));
  fs.writeFileSync(path.join(runDir, 'window-candidates.csv'), detailCsv, 'utf8');

  const groupMap = new Map<string, WindowCandidateRow[]>();
  for (const row of allRows) {
    const key = [
      row.bucket,
      row.token,
      row.trendRegime,
      row.template,
      row.timeframe,
      row.params,
    ].join('|');
    const arr = groupMap.get(key) ?? [];
    arr.push(row);
    groupMap.set(key, arr);
  }

  const stability: StabilityRow[] = [];
  for (const [key, rows] of groupMap.entries()) {
    if (rows.length < args.minWindows) continue;
    const [bucket, token, trendRegime, template, timeframeStr, params] = key.split('|');
    const pnl = rows.map(r => r.pnlPct);
    const trades = rows.map(r => r.trades);
    const win = rows.map(r => r.winRatePct);
    const adj = rows.map(r => r.adjustedWinRatePct);
    const hold = rows.map(r => r.avgHoldMinutes);
    const mtf = rows.map(r => r.mtfScore);
    const pfVals = rows.map(r => r.profitFactor).filter((v): v is number => v !== null);

    const positive = pnl.filter(v => v > 0).length;
    const nonNeg = pnl.filter(v => v >= 0).length;
    const negative = pnl.length - nonNeg;
    const meanPnl = mean(pnl);
    const medPnl = median(pnl);
    const sdPnl = stdDev(pnl);
    const worstPnl = Math.min(...pnl);
    const bestPnl = Math.max(...pnl);
    const positiveRate = (positive / pnl.length) * 100;
    const nonNegRate = (nonNeg / pnl.length) * 100;

    // Reward repeatability + downside control. Penalize volatility.
    const consistencyScore =
      (meanPnl * 0.5 + medPnl * 0.3 + worstPnl * 0.2) * (0.5 + (positiveRate / 200)) -
      (sdPnl * 0.25);

    stability.push({
      bucket: bucket as Bucket,
      token,
      trendRegime: trendRegime as TrendRegime,
      template,
      timeframe: Number(timeframeStr),
      params,
      windowsSeen: rows.length,
      positiveWindows: positive,
      nonNegativeWindows: nonNeg,
      negativeWindows: negative,
      positiveRatePct: positiveRate,
      nonNegativeRatePct: nonNegRate,
      meanPnlPct: meanPnl,
      medianPnlPct: medPnl,
      stdPnlPct: sdPnl,
      worstPnlPct: worstPnl,
      bestPnlPct: bestPnl,
      meanTrades: mean(trades),
      meanWinRatePct: mean(win),
      meanAdjustedWinRatePct: mean(adj),
      meanHoldMinutes: mean(hold),
      meanMtfScore: mean(mtf),
      meanProfitFactor: pfVals.length > 0 ? mean(pfVals) : null,
      consistencyScore,
    });
  }

  stability.sort((a, b) => {
    if (Math.abs(b.consistencyScore - a.consistencyScore) > 1e-9) return b.consistencyScore - a.consistencyScore;
    if (Math.abs(b.meanPnlPct - a.meanPnlPct) > 1e-9) return b.meanPnlPct - a.meanPnlPct;
    if (Math.abs(b.positiveRatePct - a.positiveRatePct) > 1e-9) return b.positiveRatePct - a.positiveRatePct;
    return b.windowsSeen - a.windowsSeen;
  });

  const stabilityCsv = toCsv(formatStabilityRows(stability));
  fs.writeFileSync(path.join(runDir, 'stability-ranked.csv'), stabilityCsv, 'utf8');

  const coreStability = stability.filter(r => r.bucket === 'core');
  const probeStability = stability.filter(r => r.bucket === 'probe');
  fs.writeFileSync(path.join(runDir, 'stability-core.csv'), toCsv(formatStabilityRows(coreStability)), 'utf8');
  fs.writeFileSync(path.join(runDir, 'stability-probe.csv'), toCsv(formatStabilityRows(probeStability)), 'utf8');

  const weekdayMap = new Map<string, WindowCandidateRow[]>();
  for (const row of allRows) {
    const key = `${row.bucket}|${row.windowDays}|${row.startDow}->${row.endDow}`;
    const arr = weekdayMap.get(key) ?? [];
    arr.push(row);
    weekdayMap.set(key, arr);
  }
  const weekdayPatterns: WeekdayPatternRow[] = [];
  for (const [key, rows] of weekdayMap.entries()) {
    const [bucket, daysStr, pair] = key.split('|');
    const pnl = rows.map(r => r.pnlPct);
    const mtf = rows.map(r => r.mtfScore);
    const uniqueWindows = new Set(rows.map(r => r.windowId)).size;
    const positive = pnl.filter(v => v > 0).length;
    weekdayPatterns.push({
      bucket: bucket as Bucket,
      windowDays: Number(daysStr),
      pair,
      windows: uniqueWindows,
      rows: rows.length,
      positiveRatePct: (positive / Math.max(1, rows.length)) * 100,
      meanPnlPct: mean(pnl),
      medianPnlPct: median(pnl),
      meanMtfScore: mean(mtf),
    });
  }
  weekdayPatterns.sort((a, b) => {
    if (Math.abs(b.meanPnlPct - a.meanPnlPct) > 1e-9) return b.meanPnlPct - a.meanPnlPct;
    if (Math.abs(b.positiveRatePct - a.positiveRatePct) > 1e-9) return b.positiveRatePct - a.positiveRatePct;
    return b.windows - a.windows;
  });
  fs.writeFileSync(path.join(runDir, 'weekday-patterns.csv'), toCsv(weekdayPatterns.map(r => ({
    bucket: r.bucket,
    windowDays: r.windowDays,
    pair: r.pair,
    windows: r.windows,
    rows: r.rows,
    positiveRatePct: r.positiveRatePct.toFixed(2),
    meanPnlPct: r.meanPnlPct.toFixed(4),
    medianPnlPct: r.medianPnlPct.toFixed(4),
    meanMtfScore: r.meanMtfScore.toFixed(6),
  }))), 'utf8');

  console.log(`\nOutputs written to: ${runDir}`);

  const printTop = (label: string, rows: StabilityRow[]) => {
    console.log(`\nTop ${Math.min(12, rows.length)} ${label} stability rows:`);
    rows.slice(0, 12).forEach((r, idx) => {
      console.log(
        `${String(idx + 1).padStart(2)}. ${r.token} ${r.trendRegime} ${r.template} ${r.timeframe}m ` +
        `| windows=${r.windowsSeen} pos=${r.positiveRatePct.toFixed(0)}% ` +
        `| mean=${r.meanPnlPct.toFixed(2)}% worst=${r.worstPnlPct.toFixed(2)}% ` +
        `| score=${r.consistencyScore.toFixed(3)}`
      );
    });
  };

  printTop('core', coreStability);
  printTop('probe', probeStability);
}

main();
