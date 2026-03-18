import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

type CostMode = 'fixed' | 'empirical';
type ExitParityMode = 'indicator' | 'price' | 'both';
type RankExitParityMode = 'indicator' | 'price' | 'both';
type Bucket = 'core' | 'probe';
type TrendRegime = 'uptrend' | 'sideways' | 'downtrend' | 'unknown';
type CandidatePreset = 'profit-first' | 'legacy';

interface CliArgs {
  from: string;
  to: string;
  rebuildRunDir?: string;
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
  preset: CandidatePreset;
  minWinRate: number;
  minPnl: number;
  minExpectancy: number;
  sweepDir: string;
  outDir: string;
  requireTimeframes: boolean;
  timeframeSupportMin: number;
  includeWindowCandidates: boolean;
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

interface RawWindowRow {
  windowId: string;
  windowDays: number;
  from: string;
  to: string;
  startDow: string;
  endDow: string;
  token: string;
  trendRegime: TrendRegime;
  template: string;
  timeframe: number;
  executionTimeframe: number;
  exitParity: 'indicator' | 'price' | 'unknown';
  params: string;
  trades: number;
  winRatePct: number;
  pnlPct: number;
  profitFactor: number | null;
  avgHoldMinutes: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  entrySignalCount: number | null;
  entryCoverageHours: number | null;
}

// Slim aggregation types — only the fields needed for stability stats (no window metadata bloat)
interface ExactAggEntry {
  pnlPct: number;
  trades: number;
  winRatePct: number;
  avgHoldMinutes: number;
  expectancyPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
}

interface FamilyBestEntry {
  pnlPct: number;
  trades: number;
  winRatePct: number;
  avgHoldMinutes: number;
  expectancyPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  params: string;
}

interface WeekdayEntry {
  windowId: string;
  pnlPct: number;
  expectancyPct: number;
}

interface ExactStabilityRow {
  token: string;
  trendRegime: TrendRegime;
  template: string;
  timeframe: number;
  executionTimeframe: number;
  exitParity: 'indicator' | 'price' | 'unknown';
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
  windows12PctPlus: number;
  pct12PlusWindowsRatePct: number;
  meanTrades: number;
  meanWinRatePct: number;
  meanHoldMinutes: number;
  meanExpectancyPct: number;
  meanProfitFactor: number | null;
  meanMaxDrawdownPct: number;
  consistencyScore: number;
}

interface FamilyStabilityRow {
  token: string;
  trendRegime: TrendRegime;
  template: string;
  timeframe: number;
  executionTimeframe: number;
  exitParity: 'indicator' | 'price' | 'unknown';
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
  windows12PctPlus: number;
  pct12PlusWindowsRatePct: number;
  meanTrades: number;
  meanWinRatePct: number;
  meanHoldMinutes: number;
  meanExpectancyPct: number;
  meanProfitFactor: number | null;
  meanMaxDrawdownPct: number;
  consistencyScore: number;
  representativeParams: string;
  representativeWindows: number;
  uniqueParamVariants: number;
}

function printHelp(): void {
  const lines = [
    'Usage:',
    '  npm run sweep-robustness -- --from YYYY-MM-DD [options]',
    '  npm run sweep-robustness -- --rebuild-run-dir PATH [options]',
    '',
    'Examples:',
    '  npm run sweep-robustness -- --from 2026-02-18 --window-days 1,2 --step-days 1',
    '  npm run sweep-robustness -- --from 2026-02-18 --to 2026-03-03 --timeframes 1,5,15',
    '  npm run sweep-robustness -- rsi PUMP --from 2026-02-18 --window-days 2',
    '',
    'Options:',
    '  --from YYYY-MM-DD              Start date (required)',
    '  --to YYYY-MM-DD                End date (default: today UTC)',
    '  --rebuild-run-dir PATH         Rebuild aggregate outputs from an existing run-* folder',
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
    '  --preset NAME                  Candidate preset: profit-first (default) | legacy',
    '  --min-win-rate N               Pass-through to sweep-candidates (default: 0 profit-first / 65 legacy)',
    '  --min-pnl N                    Pass-through to sweep-candidates (default: 0)',
    '  --min-expectancy N             Pass-through to sweep-candidates (default: 0 profit-first)',
    '  --sweep-dir PATH               Sweep output dir (default: data/sweep-results)',
    '  --out-dir PATH                 Robustness output dir (default: data/sweep-results/window-robustness)',
    '  --include-window-candidates    Also run sweep-candidates inside each window (default: off)',
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
  let preset: CandidatePreset = 'profit-first';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--preset') {
      preset = parseEnum(argv[i], argv[i + 1], ['profit-first', 'legacy']);
      i++;
    }
  }

  const args: CliArgs = {
    from: '',
    to: formatDateUTC(new Date()),
    rebuildRunDir: undefined,
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
    preset,
    minWinRate: preset === 'legacy' ? 65 : 0,
    minPnl: 0,
    minExpectancy: preset === 'legacy' ? Number.NEGATIVE_INFINITY : 0,
    sweepDir: 'data/sweep-results',
    outDir: 'data/sweep-results/window-robustness',
    requireTimeframes: false,
    timeframeSupportMin: 1,
    includeWindowCandidates: false,
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
    if (arg === '--rebuild-run-dir') { args.rebuildRunDir = path.resolve(requireValue(arg, next)); i++; continue; }
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
    if (arg === '--preset') {
      args.preset = parseEnum(arg, next, ['profit-first', 'legacy']);
      if (args.preset === 'legacy') {
        args.minWinRate = 65;
        args.minExpectancy = Number.NEGATIVE_INFINITY;
      } else {
        args.minWinRate = 0;
        args.minExpectancy = 0;
      }
      i++;
      continue;
    }
    if (arg === '--min-win-rate') { args.minWinRate = parseNumber(arg, next); i++; continue; }
    if (arg === '--min-pnl') { args.minPnl = parseNumber(arg, next); i++; continue; }
    if (arg === '--min-expectancy') { args.minExpectancy = parseNumber(arg, next); i++; continue; }
    if (arg === '--sweep-dir') { args.sweepDir = requireValue(arg, next); i++; continue; }
    if (arg === '--out-dir') { args.outDir = requireValue(arg, next); i++; continue; }
    if (arg === '--include-window-candidates') { args.includeWindowCandidates = true; continue; }
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

  if (!args.rebuildRunDir) {
    if (!args.from) throw new Error('--from is required');
    const from = parseDateStrict(args.from);
    const to = parseDateStrict(args.to);
    if (from > to) throw new Error(`--from ${args.from} must be <= --to ${args.to}`);
  }

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

function readWindowIndex(filePath: string): WindowRunSummary[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const required = ['windowId', 'windowDays', 'from', 'to', 'startDow', 'endDow', 'status', 'costModeUsed', 'coreRows', 'probeRows', 'sweepFiles'];
  for (const col of required) {
    if (idx[col] === undefined) throw new Error(`Missing required column "${col}" in ${filePath}`);
  }

  const rows: WindowRunSummary[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length !== header.length) continue;
    rows.push({
      windowId: parts[idx.windowId],
      windowDays: Number(parts[idx.windowDays]),
      from: parts[idx.from],
      to: parts[idx.to],
      startDow: parts[idx.startDow],
      endDow: parts[idx.endDow],
      coreRows: Number(parts[idx.coreRows]) || 0,
      probeRows: Number(parts[idx.probeRows]) || 0,
      status: (parts[idx.status] as WindowRunSummary['status']) ?? 'failed',
      costModeUsed: (parts[idx.costModeUsed] as CostMode) ?? 'fixed',
      error: parts[idx.error] || undefined,
      sweepFiles: parts[idx.sweepFiles] || '',
      coreFile: parts[idx.coreFile] || undefined,
      probeFile: parts[idx.probeFile] || undefined,
    });
  }
  return rows;
}

function readRawSweepCsv(
  filePath: string,
  window: WindowSpec,
): RawWindowRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const required = [
    'template', 'token', 'timeframe', 'executionTimeframe', 'exitParity', 'params',
    'trades', 'winRate', 'pnlPct', 'profitFactor', 'sharpeRatio', 'maxDrawdownPct',
    'avgWinPct', 'avgLossPct', 'avgHoldMinutes',
  ];
  for (const col of required) {
    if (idx[col] === undefined) {
      throw new Error(`Missing required column "${col}" in ${filePath}`);
    }
  }

  const rows: RawWindowRow[] = [];
  let skippedZeroTrade = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length !== header.length) continue;

    const timeframe = Number(parts[idx.timeframe]);
    const executionTimeframe = Number(parts[idx.executionTimeframe]);
    const trades = Number(parts[idx.trades]);
    const winRatePct = Number(parts[idx.winRate]);
    const pnlPct = Number(parts[idx.pnlPct]);
    const avgWinPct = Number(parts[idx.avgWinPct]);
    const avgLossPct = Number(parts[idx.avgLossPct]);
    const avgHoldMinutes = Number(parts[idx.avgHoldMinutes]);
    const maxDrawdownPct = Number(parts[idx.maxDrawdownPct]);
    const sharpeRatio = Number(parts[idx.sharpeRatio]);

    if (
      !Number.isFinite(timeframe) ||
      !Number.isFinite(executionTimeframe) ||
      !Number.isFinite(trades) ||
      !Number.isFinite(winRatePct) ||
      !Number.isFinite(pnlPct) ||
      !Number.isFinite(avgWinPct) ||
      !Number.isFinite(avgLossPct) ||
      !Number.isFinite(avgHoldMinutes)
    ) {
      continue;
    }

    // Skip zero-trade rows: they pad windowsSeen with non-events and dominate memory.
    // windowsSeen now means "windows where this combo actually fired" — more meaningful.
    if (trades <= 0) { skippedZeroTrade++; continue; }

    const expectancyPct = ((winRatePct / 100) * avgWinPct) + ((1 - winRatePct / 100) * avgLossPct);
    const rawRegime = idx.entryTrendRegime !== undefined
      ? parseTrendRegime(parts[idx.entryTrendRegime])
      : parseTrendRegime(parts[idx.trendRegime]);
    const exitParityRaw = idx.exitParity !== undefined ? parts[idx.exitParity] : 'unknown';
    const exitParity = exitParityRaw === 'indicator' || exitParityRaw === 'price'
      ? exitParityRaw
      : 'unknown';

    rows.push({
      windowId: window.id,
      windowDays: window.windowDays,
      from: window.from,
      to: window.to,
      startDow: window.startDow,
      endDow: window.endDow,
      token: parts[idx.token],
      trendRegime: rawRegime,
      template: parts[idx.template],
      timeframe,
      executionTimeframe,
      exitParity,
      params: parts[idx.params],
      trades,
      winRatePct,
      pnlPct,
      profitFactor: parseOptionalNumber(parts[idx.profitFactor]),
      avgHoldMinutes,
      avgWinPct,
      avgLossPct,
      expectancyPct,
      maxDrawdownPct: Number.isFinite(maxDrawdownPct) ? maxDrawdownPct : 0,
      sharpeRatio: Number.isFinite(sharpeRatio) ? sharpeRatio : 0,
      entrySignalCount: idx.entrySignalCount !== undefined ? parseOptionalNumber(parts[idx.entrySignalCount]) : null,
      entryCoverageHours: idx.entryCoverageHours !== undefined ? parseOptionalNumber(parts[idx.entryCoverageHours]) : null,
    });
  }

  if (skippedZeroTrade > 0) {
    console.log(`  readRawSweepCsv: kept ${rows.length}, skipped ${skippedZeroTrade} zero-trade rows (${path.basename(filePath)})`);
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

function writeCsvFile(filePath: string, records: Array<Record<string, string | number | null | undefined>>): void {
  if (records.length === 0) {
    fs.writeFileSync(filePath, '', 'utf8');
    return;
  }

  const headers = Object.keys(records[0]);
  const fd = fs.openSync(filePath, 'w');
  const chunk: string[] = [];
  let chunkSize = 0;

  const flush = () => {
    if (chunk.length === 0) return;
    fs.writeSync(fd, chunk.join(''));
    chunk.length = 0;
    chunkSize = 0;
  };

  try {
    fs.writeSync(fd, headers.join(',') + '\n');
    for (const rec of records) {
      const row = headers.map(h => csvEscape(rec[h])).join(',') + '\n';
      if (chunkSize + row.length > 1_000_000) flush();
      chunk.push(row);
      chunkSize += row.length;
    }
    flush();
  } finally {
    fs.closeSync(fd);
  }
}

function formatExactStabilityRows(rows: ExactStabilityRow[]): Array<Record<string, string | number | null>> {
  return rows.map(r => ({
    token: r.token,
    trendRegime: r.trendRegime,
    template: r.template,
    timeframe: r.timeframe,
    executionTimeframe: r.executionTimeframe,
    exitParity: r.exitParity,
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
    windows12PctPlus: r.windows12PctPlus,
    pct12PlusWindowsRatePct: r.pct12PlusWindowsRatePct.toFixed(2),
    meanTrades: r.meanTrades.toFixed(2),
    meanWinRatePct: r.meanWinRatePct.toFixed(2),
    meanHoldMinutes: r.meanHoldMinutes.toFixed(2),
    meanExpectancyPct: r.meanExpectancyPct.toFixed(4),
    meanProfitFactor: r.meanProfitFactor === null ? '' : r.meanProfitFactor.toFixed(4),
    meanMaxDrawdownPct: r.meanMaxDrawdownPct.toFixed(4),
    consistencyScore: r.consistencyScore.toFixed(6),
  }));
}

function formatFamilyStabilityRows(rows: FamilyStabilityRow[]): Array<Record<string, string | number | null>> {
  return rows.map(r => ({
    token: r.token,
    trendRegime: r.trendRegime,
    template: r.template,
    timeframe: r.timeframe,
    executionTimeframe: r.executionTimeframe,
    exitParity: r.exitParity,
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
    windows12PctPlus: r.windows12PctPlus,
    pct12PlusWindowsRatePct: r.pct12PlusWindowsRatePct.toFixed(2),
    meanTrades: r.meanTrades.toFixed(2),
    meanWinRatePct: r.meanWinRatePct.toFixed(2),
    meanHoldMinutes: r.meanHoldMinutes.toFixed(2),
    meanExpectancyPct: r.meanExpectancyPct.toFixed(4),
    meanProfitFactor: r.meanProfitFactor === null ? '' : r.meanProfitFactor.toFixed(4),
    meanMaxDrawdownPct: r.meanMaxDrawdownPct.toFixed(4),
    consistencyScore: r.consistencyScore.toFixed(6),
    representativeParams: r.representativeParams,
    representativeWindows: r.representativeWindows,
    uniqueParamVariants: r.uniqueParamVariants,
  }));
}

function computeConsistencyScore(meanPnlPct: number, medianPnlPct: number, worstPnlPct: number, positiveRatePct: number, stdPnlPct: number): number {
  return (
    (meanPnlPct * 0.5 + medianPnlPct * 0.3 + worstPnlPct * 0.2) *
    (0.5 + (positiveRatePct / 200))
  ) - (stdPnlPct * 0.25);
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

const RAW_CSV_HEADERS = [
  'windowId', 'windowDays', 'from', 'to', 'startDow', 'endDow',
  'token', 'trendRegime', 'template', 'timeframe', 'executionTimeframe',
  'exitParity', 'params', 'trades', 'winRatePct', 'pnlPct',
  'profitFactor', 'avgHoldMinutes', 'avgWinPct', 'avgLossPct',
  'expectancyPct', 'maxDrawdownPct', 'sharpeRatio',
  'entrySignalCount', 'entryCoverageHours',
];

// Streaming sweep CSV processor: parses a single sweep file and directly populates
// the slim aggregation maps + writes rows to rawFd. Avoids accumulating RawWindowRow[].
function processRawSweepCsv(
  filePath: string,
  window: WindowSpec,
  rawFd: number | null,
  exactMap: Map<string, ExactAggEntry[]>,
  familyMap: Map<string, FamilyBestEntry>,
  weekdayMap: Map<string, WeekdayEntry[]>,
): void {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return;

  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const required = [
    'template', 'token', 'timeframe', 'executionTimeframe', 'exitParity', 'params',
    'trades', 'winRate', 'pnlPct', 'profitFactor', 'sharpeRatio', 'maxDrawdownPct',
    'avgWinPct', 'avgLossPct', 'avgHoldMinutes',
  ];
  for (const col of required) {
    if (idx[col] === undefined) throw new Error(`Missing required column "${col}" in ${filePath}`);
  }

  let skippedZeroTrade = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length !== header.length) continue;

    const timeframe = Number(parts[idx.timeframe]);
    const executionTimeframe = Number(parts[idx.executionTimeframe]);
    const trades = Number(parts[idx.trades]);
    const winRatePct = Number(parts[idx.winRate]);
    const pnlPct = Number(parts[idx.pnlPct]);
    const avgWinPct = Number(parts[idx.avgWinPct]);
    const avgLossPct = Number(parts[idx.avgLossPct]);
    const avgHoldMinutes = Number(parts[idx.avgHoldMinutes]);
    const maxDrawdownPctRaw = Number(parts[idx.maxDrawdownPct]);
    const sharpeRatioRaw = Number(parts[idx.sharpeRatio]);

    if (
      !Number.isFinite(timeframe) ||
      !Number.isFinite(executionTimeframe) ||
      !Number.isFinite(trades) ||
      !Number.isFinite(winRatePct) ||
      !Number.isFinite(pnlPct) ||
      !Number.isFinite(avgWinPct) ||
      !Number.isFinite(avgLossPct) ||
      !Number.isFinite(avgHoldMinutes)
    ) continue;

    if (trades <= 0) { skippedZeroTrade++; continue; }

    const expectancyPct = ((winRatePct / 100) * avgWinPct) + ((1 - winRatePct / 100) * avgLossPct);
    const rawRegime = idx.entryTrendRegime !== undefined
      ? parseTrendRegime(parts[idx.entryTrendRegime])
      : parseTrendRegime(parts[idx.trendRegime]);
    const exitParityRaw = idx.exitParity !== undefined ? parts[idx.exitParity] : 'unknown';
    const exitParity = exitParityRaw === 'indicator' || exitParityRaw === 'price' ? exitParityRaw : 'unknown';
    const profitFactor = parseOptionalNumber(parts[idx.profitFactor]);
    const entrySignalCount = idx.entrySignalCount !== undefined ? parseOptionalNumber(parts[idx.entrySignalCount]) : null;
    const entryCoverageHours = idx.entryCoverageHours !== undefined ? parseOptionalNumber(parts[idx.entryCoverageHours]) : null;
    const token = parts[idx.token];
    const template = parts[idx.template];
    const params = parts[idx.params];
    const maxDrawdownPct = Number.isFinite(maxDrawdownPctRaw) ? maxDrawdownPctRaw : 0;
    const sharpeRatio = Number.isFinite(sharpeRatioRaw) ? sharpeRatioRaw : 0;

    // Stream row to window-raw.csv
    if (rawFd !== null) {
      const vals: Array<string | number | null | undefined> = [
        window.id, window.windowDays, window.from, window.to, window.startDow, window.endDow,
        token, rawRegime, template, timeframe, executionTimeframe,
        exitParity, params, trades, winRatePct, pnlPct,
        profitFactor ?? '', avgHoldMinutes, avgWinPct, avgLossPct,
        expectancyPct, maxDrawdownPct, sharpeRatio,
        entrySignalCount ?? '', entryCoverageHours ?? '',
      ];
      fs.writeSync(rawFd, vals.map(csvEscape).join(',') + '\n');
    }

    // Populate exactMap (key = token|regime|template|tf|etf|exitParity|params)
    const exactKey = [token, rawRegime, template, timeframe, executionTimeframe, exitParity, params].join('|');
    const exactArr = exactMap.get(exactKey);
    if (exactArr) {
      exactArr.push({ pnlPct, trades, winRatePct, avgHoldMinutes, expectancyPct, profitFactor, maxDrawdownPct });
    } else {
      exactMap.set(exactKey, [{ pnlPct, trades, winRatePct, avgHoldMinutes, expectancyPct, profitFactor, maxDrawdownPct }]);
    }

    // Update familyMap: best-per-window (key = windowId|token|regime|template|tf|etf|exitParity)
    const familyKey = [window.id, token, rawRegime, template, timeframe, executionTimeframe, exitParity].join('|');
    const current = familyMap.get(familyKey);
    const rowPf = profitFactor ?? Number.NEGATIVE_INFINITY;
    if (
      !current ||
      pnlPct > current.pnlPct ||
      (Math.abs(pnlPct - current.pnlPct) < 1e-9 && trades > current.trades) ||
      (Math.abs(pnlPct - current.pnlPct) < 1e-9 && trades === current.trades && rowPf > (current.profitFactor ?? Number.NEGATIVE_INFINITY))
    ) {
      familyMap.set(familyKey, { pnlPct, trades, winRatePct, avgHoldMinutes, expectancyPct, profitFactor, maxDrawdownPct, params });
    }

    // Populate weekdayMap (key = windowDays|startDow->endDow)
    const weekdayKey = `${window.windowDays}|${window.startDow}->${window.endDow}`;
    const weekdayArr = weekdayMap.get(weekdayKey);
    if (weekdayArr) {
      weekdayArr.push({ windowId: window.id, pnlPct, expectancyPct });
    } else {
      weekdayMap.set(weekdayKey, [{ windowId: window.id, pnlPct, expectancyPct }]);
    }
  }

  if (skippedZeroTrade > 0) {
    console.log(`  processRawSweepCsv: skipped ${skippedZeroTrade} zero-trade rows (${path.basename(filePath)})`);
  }
}

// Shared aggregation: builds stability CSVs from the slim maps populated by processRawSweepCsv.
function aggregateAndWrite(
  runDir: string,
  exactMap: Map<string, ExactAggEntry[]>,
  familyMap: Map<string, FamilyBestEntry>,
  weekdayMap: Map<string, WeekdayEntry[]>,
  minWindows: number,
): void {
  const exactStability: ExactStabilityRow[] = [];
  for (const [key, entries] of exactMap.entries()) {
    if (entries.length < minWindows) continue;
    const [token, trendRegime, template, timeframeStr, executionTfStr, exitParity, params] = key.split('|');
    const pnl = entries.map(e => e.pnlPct);
    const trades = entries.map(e => e.trades);
    const win = entries.map(e => e.winRatePct);
    const hold = entries.map(e => e.avgHoldMinutes);
    const expectancy = entries.map(e => e.expectancyPct);
    const pfVals = entries.map(e => e.profitFactor).filter((v): v is number => v !== null);
    const drawdowns = entries.map(e => e.maxDrawdownPct);
    const positive = pnl.filter(v => v > 0).length;
    const nonNeg = pnl.filter(v => v >= 0).length;
    const plus12 = pnl.filter(v => v >= 12).length;
    const meanPnl = mean(pnl);
    const medPnl = median(pnl);
    const sdPnl = stdDev(pnl);
    const worstPnl = Math.min(...pnl);
    const bestPnl = Math.max(...pnl);
    const positiveRate = (positive / pnl.length) * 100;
    const nonNegRate = (nonNeg / pnl.length) * 100;
    exactStability.push({
      token,
      trendRegime: trendRegime as TrendRegime,
      template,
      timeframe: Number(timeframeStr),
      executionTimeframe: Number(executionTfStr),
      exitParity: exitParity as 'indicator' | 'price' | 'unknown',
      params,
      windowsSeen: entries.length,
      positiveWindows: positive,
      nonNegativeWindows: nonNeg,
      negativeWindows: pnl.length - nonNeg,
      positiveRatePct: positiveRate,
      nonNegativeRatePct: nonNegRate,
      meanPnlPct: meanPnl,
      medianPnlPct: medPnl,
      stdPnlPct: sdPnl,
      worstPnlPct: worstPnl,
      bestPnlPct: bestPnl,
      windows12PctPlus: plus12,
      pct12PlusWindowsRatePct: (plus12 / pnl.length) * 100,
      meanTrades: mean(trades),
      meanWinRatePct: mean(win),
      meanHoldMinutes: mean(hold),
      meanExpectancyPct: mean(expectancy),
      meanProfitFactor: pfVals.length > 0 ? mean(pfVals) : null,
      meanMaxDrawdownPct: mean(drawdowns),
      consistencyScore: computeConsistencyScore(meanPnl, medPnl, worstPnl, positiveRate, sdPnl),
    });
  }
  exactStability.sort((a, b) => {
    if (Math.abs(b.consistencyScore - a.consistencyScore) > 1e-9) return b.consistencyScore - a.consistencyScore;
    if (Math.abs(b.meanPnlPct - a.meanPnlPct) > 1e-9) return b.meanPnlPct - a.meanPnlPct;
    if (Math.abs(b.positiveRatePct - a.positiveRatePct) > 1e-9) return b.positiveRatePct - a.positiveRatePct;
    return b.windowsSeen - a.windowsSeen;
  });
  const exactRows = formatExactStabilityRows(exactStability);
  writeCsvFile(path.join(runDir, 'stability-exact-ranked.csv'), exactRows);
  writeCsvFile(path.join(runDir, 'stability-ranked.csv'), exactRows);

  // Build familyGroupMap: strip windowId prefix from familyMap keys
  const familyGroupMap = new Map<string, FamilyBestEntry[]>();
  for (const [key, entry] of familyMap.entries()) {
    const familyKey = key.split('|').slice(1).join('|'); // drop windowId
    const arr = familyGroupMap.get(familyKey);
    if (arr) arr.push(entry);
    else familyGroupMap.set(familyKey, [entry]);
  }

  const familyStability: FamilyStabilityRow[] = [];
  for (const [key, entries] of familyGroupMap.entries()) {
    if (entries.length < minWindows) continue;
    const [token, trendRegime, template, timeframeStr, executionTfStr, exitParity] = key.split('|');
    const pnl = entries.map(e => e.pnlPct);
    const trades = entries.map(e => e.trades);
    const win = entries.map(e => e.winRatePct);
    const hold = entries.map(e => e.avgHoldMinutes);
    const expectancy = entries.map(e => e.expectancyPct);
    const pfVals = entries.map(e => e.profitFactor).filter((v): v is number => v !== null);
    const drawdowns = entries.map(e => e.maxDrawdownPct);
    const paramsCounts = new Map<string, number>();
    for (const e of entries) paramsCounts.set(e.params, (paramsCounts.get(e.params) ?? 0) + 1);
    const representative = [...paramsCounts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];
    const positive = pnl.filter(v => v > 0).length;
    const nonNeg = pnl.filter(v => v >= 0).length;
    const plus12 = pnl.filter(v => v >= 12).length;
    const meanPnl = mean(pnl);
    const medPnl = median(pnl);
    const sdPnl = stdDev(pnl);
    const worstPnl = Math.min(...pnl);
    const bestPnl = Math.max(...pnl);
    const positiveRate = (positive / pnl.length) * 100;
    const nonNegRate = (nonNeg / pnl.length) * 100;
    familyStability.push({
      token,
      trendRegime: trendRegime as TrendRegime,
      template,
      timeframe: Number(timeframeStr),
      executionTimeframe: Number(executionTfStr),
      exitParity: exitParity as 'indicator' | 'price' | 'unknown',
      windowsSeen: entries.length,
      positiveWindows: positive,
      nonNegativeWindows: nonNeg,
      negativeWindows: pnl.length - nonNeg,
      positiveRatePct: positiveRate,
      nonNegativeRatePct: nonNegRate,
      meanPnlPct: meanPnl,
      medianPnlPct: medPnl,
      stdPnlPct: sdPnl,
      worstPnlPct: worstPnl,
      bestPnlPct: bestPnl,
      windows12PctPlus: plus12,
      pct12PlusWindowsRatePct: (plus12 / pnl.length) * 100,
      meanTrades: mean(trades),
      meanWinRatePct: mean(win),
      meanHoldMinutes: mean(hold),
      meanExpectancyPct: mean(expectancy),
      meanProfitFactor: pfVals.length > 0 ? mean(pfVals) : null,
      meanMaxDrawdownPct: mean(drawdowns),
      consistencyScore: computeConsistencyScore(meanPnl, medPnl, worstPnl, positiveRate, sdPnl),
      representativeParams: representative?.[0] ?? '',
      representativeWindows: representative?.[1] ?? 0,
      uniqueParamVariants: paramsCounts.size,
    });
  }
  familyStability.sort((a, b) => {
    if (Math.abs(b.consistencyScore - a.consistencyScore) > 1e-9) return b.consistencyScore - a.consistencyScore;
    if (Math.abs(b.meanPnlPct - a.meanPnlPct) > 1e-9) return b.meanPnlPct - a.meanPnlPct;
    if (Math.abs(b.positiveRatePct - a.positiveRatePct) > 1e-9) return b.positiveRatePct - a.positiveRatePct;
    return b.windowsSeen - a.windowsSeen;
  });
  writeCsvFile(path.join(runDir, 'stability-family-ranked.csv'), formatFamilyStabilityRows(familyStability));

  const weekdayPatterns = [];
  for (const [key, entries] of weekdayMap.entries()) {
    const [daysStr, pair] = key.split('|');
    const pnl = entries.map(e => e.pnlPct);
    const expectancy = entries.map(e => e.expectancyPct);
    const uniqueWindows = new Set(entries.map(e => e.windowId)).size;
    const positive = pnl.filter(v => v > 0).length;
    weekdayPatterns.push({
      windowDays: Number(daysStr),
      pair,
      windows: uniqueWindows,
      rows: entries.length,
      positiveRatePct: (positive / Math.max(1, entries.length)) * 100,
      meanPnlPct: mean(pnl),
      medianPnlPct: median(pnl),
      meanExpectancyPct: mean(expectancy),
    });
  }
  weekdayPatterns.sort((a, b) => {
    if (Math.abs(b.meanPnlPct - a.meanPnlPct) > 1e-9) return b.meanPnlPct - a.meanPnlPct;
    if (Math.abs(b.positiveRatePct - a.positiveRatePct) > 1e-9) return b.positiveRatePct - a.positiveRatePct;
    return b.windows - a.windows;
  });
  writeCsvFile(path.join(runDir, 'weekday-patterns.csv'), weekdayPatterns.map(r => ({
    windowDays: r.windowDays,
    pair: r.pair,
    windows: r.windows,
    rows: r.rows,
    positiveRatePct: r.positiveRatePct.toFixed(2),
    meanPnlPct: r.meanPnlPct.toFixed(4),
    medianPnlPct: r.medianPnlPct.toFixed(4),
    meanExpectancyPct: r.meanExpectancyPct.toFixed(4),
  })));

  const printTop = (label: string, rows: Array<ExactStabilityRow | FamilyStabilityRow>) => {
    console.log(`\nTop ${Math.min(12, rows.length)} ${label}:`);
    rows.slice(0, 12).forEach((r, i) => {
      console.log(
        `${String(i + 1).padStart(2)}. ${r.token} ${r.trendRegime} ${r.template} ${r.timeframe}m/${r.executionTimeframe}m ${r.exitParity}` +
        ` | windows=${r.windowsSeen} pos=${r.positiveRatePct.toFixed(0)}%` +
        ` | mean=${r.meanPnlPct.toFixed(2)}% worst=${r.worstPnlPct.toFixed(2)}%` +
        ` | score=${r.consistencyScore.toFixed(3)}`
      );
    });
  };
  printTop('exact robustness rows', exactStability);
  printTop('family robustness rows', familyStability);
}

function rebuildRunAggregates(args: CliArgs): void {
  if (!args.rebuildRunDir) throw new Error('--rebuild-run-dir is required for rebuild mode');
  const runDir = path.resolve(args.rebuildRunDir);
  const windowIndexPath = path.join(runDir, 'window-index.csv');
  if (!fs.existsSync(windowIndexPath)) {
    throw new Error(`window-index.csv not found in ${runDir}`);
  }

  const windowSummaries = readWindowIndex(windowIndexPath);
  const allCandidateRows: WindowCandidateRow[] = [];

  const rawFd = fs.openSync(path.join(runDir, 'window-raw.csv'), 'w');
  fs.writeSync(rawFd, RAW_CSV_HEADERS.join(',') + '\n');
  const exactMap = new Map<string, ExactAggEntry[]>();
  const familyMap = new Map<string, FamilyBestEntry>();
  const weekdayMap = new Map<string, WeekdayEntry[]>();

  try {
    for (const summary of windowSummaries) {
      if (summary.status !== 'ok') continue;
      const window: WindowSpec = {
        id: summary.windowId,
        windowDays: summary.windowDays,
        from: summary.from,
        to: summary.to,
        startDow: summary.startDow,
        endDow: summary.endDow,
      };

      const sweepFiles = summary.sweepFiles
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
        .filter(file => fs.existsSync(file));
      for (const sweepFile of sweepFiles) {
        processRawSweepCsv(sweepFile, window, rawFd, exactMap, familyMap, weekdayMap);
      }

      if (args.includeWindowCandidates) {
        const addCandidateBucket = (filePath: string | undefined, bucket: Bucket) => {
          if (!filePath || !fs.existsSync(filePath)) return;
          for (const row of readCandidateCsv(filePath)) {
            allCandidateRows.push({
              ...row,
              windowId: summary.windowId,
              windowDays: summary.windowDays,
              from: summary.from,
              to: summary.to,
              startDow: summary.startDow,
              endDow: summary.endDow,
              bucket,
            });
          }
        };
        addCandidateBucket(summary.coreFile, 'core');
        addCandidateBucket(summary.probeFile, 'probe');
      }
    }
  } finally {
    fs.closeSync(rawFd);
  }

  if (args.includeWindowCandidates) {
    writeCsvFile(path.join(runDir, 'window-candidates.csv'), allCandidateRows.map(r => ({
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
  }

  aggregateAndWrite(runDir, exactMap, familyMap, weekdayMap, args.minWindows);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.rebuildRunDir) {
    rebuildRunAggregates(args);
    return;
  }
  const rootDir = path.resolve(__dirname, '..');
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

  const allCandidateRows: WindowCandidateRow[] = [];
  const windowSummaries: WindowRunSummary[] = [];
  const exactMap = new Map<string, ExactAggEntry[]>();
  const familyMap = new Map<string, FamilyBestEntry>();
  const weekdayMap = new Map<string, WeekdayEntry[]>();
  let rawFd: number | null = null;
  if (!args.dryRun) {
    rawFd = fs.openSync(path.join(runDir, 'window-raw.csv'), 'w');
    fs.writeSync(rawFd, RAW_CSV_HEADERS.join(',') + '\n');
  }

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
          const copied = path.join(sweepsCopyDir, `${w.from}-w${w.windowDays}d-${w.to}-${tf}min.csv`);
          const sweepCmd: string[] = ['run', 'sweep', '--'];
          if (args.template) sweepCmd.push(args.template);
          if (args.token) sweepCmd.push(args.token);
          sweepCmd.push('--timeframe', String(tf));
          sweepCmd.push('--cost', mode);
          sweepCmd.push('--exit-parity', args.exitParity);
          sweepCmd.push('--from', w.from, '--to', w.to);
          if (args.maxPositions !== undefined) sweepCmd.push('--max-positions', String(args.maxPositions));
          sweepCmd.push('--out-file', copied);
          runNpm(rootDir, sweepCmd, args.dryRun);

          if (args.dryRun) continue;
          if (!fs.existsSync(copied)) {
            throw new Error(`Sweep output missing for ${tf}m window ${w.id}: ${copied}`);
          }
          sweepFilesCopied.push(copied);
          console.log(`  wrote ${tf}m sweep -> ${copied}`);
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

      if (!args.dryRun) {
        for (const sweepFile of sweepFilesCopied) {
          processRawSweepCsv(sweepFile, w, rawFd, exactMap, familyMap, weekdayMap);
        }
      }

      if (args.includeWindowCandidates) {
        const filesArg = args.dryRun
          ? args.timeframes.map(tf => path.join(sweepsCopyDir, `${w.from}-w${w.windowDays}d-${w.to}-${tf}min.csv`)).join(',')
          : sweepFilesCopied.join(',');

        const candCmd: string[] = [
          'run', 'sweep-candidates', '--',
          '--files', filesArg,
          '--top', String(args.top),
          '--top-per-token', String(args.topPerToken),
          '--preset', args.preset,
          '--min-win-rate', String(args.minWinRate),
          '--min-pnl', String(args.minPnl),
          '--min-expectancy', String(args.minExpectancy),
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
          allCandidateRows.push(...coreRows, ...probeRows);
        }
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

  if (rawFd !== null) fs.closeSync(rawFd);

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

  // window-raw.csv was already written incrementally via rawFd above.
  if (args.includeWindowCandidates) {
    writeCsvFile(path.join(runDir, 'window-candidates.csv'), allCandidateRows.map(r => ({
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
  }

  console.log(`\nOutputs written to: ${runDir}`);
  aggregateAndWrite(runDir, exactMap, familyMap, weekdayMap, args.minWindows);
}

main();
