import fs from 'fs';
import path from 'path';

type Severity = 'high' | 'medium';
type Status = 'PASS' | 'WARN' | 'FAIL';

interface WatchlistEntry {
  mint: string;
  label?: string;
}

interface NumericSummary {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

interface Issue {
  severity: Severity;
  message: string;
}

interface PriceMintStats {
  mint: string;
  label: string;
  rows: number;
  parseErrors: number;
  invalidRows: number;
  nonPositivePrices: number;
  outOfOrder: number;
  firstTs: number | null;
  lastTs: number | null;
  gaps: NumericSummary;
  gapsOver45s: number;
  gapsOver60s: number;
  coverageSpan: number | null;
  dayCoverage: number;
  latency: NumericSummary;
  sourceCounts: Record<string, number>;
}

interface CandleMintStats {
  mint: string;
  label: string;
  rows: number;
  parseErrors: number;
  invalidRows: number;
  ohlcViolations: number;
  nonPositiveOhlc: number;
  outOfOrder: number;
  firstTs: number | null;
  lastTs: number | null;
  inferredIntervalSec: number | null;
  gaps: NumericSummary;
  coverageSpan: number | null;
  dayCoverage: number;
  pricePointsZeroOrNegative: number;
}

interface PriceDaySummary {
  presentMints: string[];
  missingMints: string[];
  extraMints: string[];
  mintStats: PriceMintStats[];
  totalRows: number;
  totalParseErrors: number;
  totalInvalidRows: number;
  totalNonPositivePrices: number;
  totalOutOfOrder: number;
  sourceCounts: Record<string, number>;
  coverageMedian: number | null;
  worstCoverageMint: string | null;
  worstCoverage: number | null;
  maxGapMs: number | null;
}

interface CandleDaySummary {
  presentMints: string[];
  missingMints: string[];
  extraMints: string[];
  mintStats: CandleMintStats[];
  totalRows: number;
  totalParseErrors: number;
  totalInvalidRows: number;
  totalOhlcViolations: number;
  totalNonPositiveOhlc: number;
  totalOutOfOrder: number;
  totalPricePointsZeroOrNegative: number;
  intervalMix: Record<string, number>;
  coverageMedian: number | null;
  worstCoverageMint: string | null;
  worstCoverage: number | null;
  maxGapMs: number | null;
}

interface SignalSummary {
  exists: boolean;
  rows: number;
  parseErrors: number;
  invalidRows: number;
  entryTrue: number;
  entryFalse: number;
  entryUnknown: number;
  missingRejectReason: number;
  rejectReasons: Record<string, number>;
}

interface ExecutionSummary {
  exists: boolean;
  rows: number;
  parseErrors: number;
  invalidRows: number;
  success: number;
  fail: number;
  unknown: number;
  failRate: number | null;
  latencies: NumericSummary;
  quotedImpact: NumericSummary;
  bySide: Record<string, number>;
  failReasons: Record<string, number>;
}

interface TradeSummary {
  exists: boolean;
  rows: number;
  parseErrors: number;
  invalidRows: number;
  success: number;
  fail: number;
  successRate: number | null;
  txLatencies: NumericSummary;
  actualSlippagePct: NumericSummary;
  actualSlippageCostUsdc: NumericSummary;
  fillSourceCounts: Record<string, number>;
  measuredFillRate: number | null;
}

interface DayReport {
  date: string;
  status: Status;
  issues: Issue[];
  prices: PriceDaySummary;
  candles: CandleDaySummary;
  signals: SignalSummary;
  executions: ExecutionSummary;
  trades: TradeSummary;
}

interface CliArgs {
  date?: string;
  from?: string;
  to?: string;
  minDate: string;
  dataRoot: string;
  watchlistPath: string;
  out?: string;
  jsonOut?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE_EXPECTED_INTERVAL_MS = 30_000;
const DEFAULT_MIN_DATE = '2026-02-18';
const DEFAULT_LOOKBACK_DAYS = 2;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    minDate: DEFAULT_MIN_DATE,
    dataRoot: path.resolve(__dirname, '../data/data'),
    watchlistPath: path.resolve(__dirname, '../config/watchlist.json'),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--date') {
      args.date = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--from') {
      args.from = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--to') {
      args.to = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--min-date') {
      args.minDate = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--data-root') {
      args.dataRoot = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--watchlist') {
      args.watchlistPath = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--out') {
      args.out = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--json-out') {
      args.jsonOut = path.resolve(requireValue(arg, next));
      i++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.date && (args.from || args.to)) {
    throw new Error('Use either --date or --from/--to, not both.');
  }

  for (const key of [args.date, args.from, args.to, args.minDate]) {
    if (key && !isDateKey(key)) {
      throw new Error(`Invalid date format "${key}". Expected YYYY-MM-DD.`);
    }
  }

  return args;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp(): void {
  console.log([
    'Usage:',
    '  npm run daily-qa-report',
    '  npm run daily-qa-report -- --date 2026-02-19',
    '  npm run daily-qa-report -- --from 2026-02-18 --to 2026-02-19',
    '  npm run daily-qa-report -- --out data/data/qa/qa-2026-02-19.md --json-out data/data/qa/qa-2026-02-19.json',
    '',
    'Flags:',
    '  --date YYYY-MM-DD       Analyze one date',
    '  --from YYYY-MM-DD       Start date (inclusive)',
    '  --to YYYY-MM-DD         End date (inclusive)',
    '  --min-date YYYY-MM-DD   Ignore anything older (default: 2026-02-18)',
    '  --data-root PATH        Data root (default: sol-trader/data/data)',
    '  --watchlist PATH        Watchlist path (default: sol-trader/config/watchlist.json)',
    '  --out PATH              Optional markdown output path',
    '  --json-out PATH         Optional JSON output path',
  ].join('\n'));
}

function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateKeyToUtcMs(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function rangeDateKeys(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = dateKeyToUtcMs(from);
  const end = dateKeyToUtcMs(to);
  while (cur <= end) {
    out.push(utcMsToDateKey(cur));
    cur += DAY_MS;
  }
  return out;
}

function pathExists(p: string): boolean {
  return fs.existsSync(p);
}

function listDirs(p: string): string[] {
  if (!pathExists(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function collectAvailableDates(dataRoot: string): string[] {
  const dates = new Set<string>();

  collectDatesFromFlatDir(path.join(dataRoot, 'signals'), /\.jsonl$/, dates);
  collectDatesFromFlatDir(path.join(dataRoot, 'executions'), /\.jsonl$/, dates);
  collectDatesFromFlatDir(path.join(dataRoot, 'data', 'trades'), /\.jsonl$/, dates);
  collectDatesFromNestedDirs(path.join(dataRoot, 'prices'), /\.jsonl$/, dates);
  collectDatesFromNestedDirs(path.join(dataRoot, 'candles'), /\.csv$/, dates);

  return [...dates].sort();
}

function collectDatesFromFlatDir(dir: string, extRe: RegExp, out: Set<string>): void {
  if (!pathExists(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^(\d{4}-\d{2}-\d{2})(\..+)$/);
    if (!match) continue;
    if (!extRe.test(match[2])) continue;
    out.add(match[1]);
  }
}

function collectDatesFromNestedDirs(rootDir: string, extRe: RegExp, out: Set<string>): void {
  for (const mintDir of listDirs(rootDir)) {
    const full = path.join(rootDir, mintDir);
    for (const name of fs.readdirSync(full)) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})(\..+)$/);
      if (!match) continue;
      if (!extRe.test(match[2])) continue;
      out.add(match[1]);
    }
  }
}

function readWatchlist(watchlistPath: string): WatchlistEntry[] {
  if (!pathExists(watchlistPath)) return [];
  const raw = fs.readFileSync(watchlistPath, 'utf8');
  const json = JSON.parse(raw) as WatchlistEntry[];
  return Array.isArray(json) ? json.filter(Boolean) : [];
}

function pickDates(args: CliArgs, availableDates: string[]): string[] {
  const minDate = args.minDate;
  const filteredAvailable = availableDates.filter(d => d >= minDate);

  if (args.date) {
    if (args.date < minDate) {
      throw new Error(`--date ${args.date} is older than --min-date ${minDate}`);
    }
    return [args.date];
  }

  if (args.from || args.to) {
    const from = args.from ?? minDate;
    const to = args.to ?? utcMsToDateKey(Date.now());
    if (from < minDate) {
      throw new Error(`--from ${from} is older than --min-date ${minDate}`);
    }
    if (dateKeyToUtcMs(from) > dateKeyToUtcMs(to)) {
      throw new Error(`--from ${from} must be <= --to ${to}`);
    }
    return rangeDateKeys(from, to);
  }

  return filteredAvailable.slice(-DEFAULT_LOOKBACK_DAYS);
}

function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function summarize(values: number[]): NumericSummary {
  if (values.length === 0) {
    return { p50: null, p95: null, max: null };
  }
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function parseJsonLines(filePath: string): { parseErrors: number; objects: unknown[] } {
  const objects: unknown[] = [];
  let parseErrors = 0;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);

  for (const line of lines) {
    try {
      objects.push(JSON.parse(line));
    } catch {
      parseErrors++;
    }
  }

  return { parseErrors, objects };
}

function analyzePriceFile(filePath: string, mint: string, label: string): PriceMintStats {
  const { parseErrors, objects } = parseJsonLines(filePath);
  let rows = 0;
  let invalidRows = 0;
  let nonPositivePrices = 0;
  let outOfOrder = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let prevTs: number | null = null;
  const gaps: number[] = [];
  const latencies: number[] = [];
  const sourceCounts: Record<string, number> = {};

  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') {
      invalidRows++;
      continue;
    }

    const row = obj as Record<string, unknown>;
    const ts = Number(row.ts);
    const priceUsd = Number(row.priceUsd);
    if (!Number.isFinite(ts) || !Number.isFinite(priceUsd)) {
      invalidRows++;
      continue;
    }

    rows++;
    if (priceUsd <= 0) nonPositivePrices++;

    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;

    if (prevTs !== null) {
      const delta = ts - prevTs;
      if (delta <= 0) {
        outOfOrder++;
      } else {
        gaps.push(delta);
      }
    }
    prevTs = ts;

    if (typeof row.source === 'string' && row.source.trim()) {
      sourceCounts[row.source] = (sourceCounts[row.source] ?? 0) + 1;
    } else {
      sourceCounts.unknown = (sourceCounts.unknown ?? 0) + 1;
    }

    const latency = Number(row.pollLatencyMs);
    if (Number.isFinite(latency) && latency >= 0) latencies.push(latency);
  }

  const dayCoverage = rows / (DAY_MS / PRICE_EXPECTED_INTERVAL_MS);
  let coverageSpan: number | null = null;
  if (rows > 0 && firstTs !== null && lastTs !== null) {
    const expectedRows = Math.floor((lastTs - firstTs) / PRICE_EXPECTED_INTERVAL_MS) + 1;
    coverageSpan = expectedRows > 0 ? rows / expectedRows : null;
  }

  const gapStats = summarize(gaps);
  const latencyStats = summarize(latencies);

  return {
    mint,
    label,
    rows,
    parseErrors,
    invalidRows,
    nonPositivePrices,
    outOfOrder,
    firstTs,
    lastTs,
    gaps: gapStats,
    gapsOver45s: gaps.filter(g => g > 45_000).length,
    gapsOver60s: gaps.filter(g => g > 60_000).length,
    coverageSpan,
    dayCoverage,
    latency: latencyStats,
    sourceCounts,
  };
}

function parseCsvRows(filePath: string): { parseErrors: number; rows: string[][] } {
  const rows: string[][] = [];
  let parseErrors = 0;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return { parseErrors, rows };

  const startIndex = lines[0].toLowerCase().startsWith('timestamp,') ? 1 : 0;
  for (let i = startIndex; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim());
    if (parts.length < 6) {
      parseErrors++;
      continue;
    }
    rows.push(parts.slice(0, 6));
  }

  return { parseErrors, rows };
}

function analyzeCandleFile(filePath: string, mint: string, label: string): CandleMintStats {
  const { parseErrors, rows: csvRows } = parseCsvRows(filePath);
  let rows = 0;
  let invalidRows = 0;
  let ohlcViolations = 0;
  let nonPositiveOhlc = 0;
  let outOfOrder = 0;
  let pricePointsZeroOrNegative = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let prevTs: number | null = null;
  const gaps: number[] = [];

  for (const parts of csvRows) {
    const ts = Number(parts[0]);
    const open = Number(parts[1]);
    const high = Number(parts[2]);
    const low = Number(parts[3]);
    const close = Number(parts[4]);
    const pricePoints = Number(parts[5]);

    if (
      !Number.isFinite(ts) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(pricePoints)
    ) {
      invalidRows++;
      continue;
    }

    rows++;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) nonPositiveOhlc++;
    if (pricePoints <= 0) pricePointsZeroOrNegative++;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      ohlcViolations++;
    }

    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;

    if (prevTs !== null) {
      const delta = ts - prevTs;
      if (delta <= 0) {
        outOfOrder++;
      } else {
        gaps.push(delta);
      }
    }
    prevTs = ts;
  }

  const inferredIntervalMs = median(gaps.map(g => Math.round(g)));
  const intervalMs = inferredIntervalMs && inferredIntervalMs > 0 ? inferredIntervalMs : 60_000;
  const dayCoverage = rows / (DAY_MS / intervalMs);

  let coverageSpan: number | null = null;
  if (rows > 0 && firstTs !== null && lastTs !== null) {
    const expectedRows = Math.floor((lastTs - firstTs) / intervalMs) + 1;
    coverageSpan = expectedRows > 0 ? rows / expectedRows : null;
  }

  return {
    mint,
    label,
    rows,
    parseErrors,
    invalidRows,
    ohlcViolations,
    nonPositiveOhlc,
    outOfOrder,
    firstTs,
    lastTs,
    inferredIntervalSec: intervalMs > 0 ? Math.round(intervalMs / 1000) : null,
    gaps: summarize(gaps),
    coverageSpan,
    dayCoverage,
    pricePointsZeroOrNegative,
  };
}

function analyzeSignals(filePath: string): SignalSummary {
  if (!pathExists(filePath)) {
    return {
      exists: false,
      rows: 0,
      parseErrors: 0,
      invalidRows: 0,
      entryTrue: 0,
      entryFalse: 0,
      entryUnknown: 0,
      missingRejectReason: 0,
      rejectReasons: {},
    };
  }

  const { parseErrors, objects } = parseJsonLines(filePath);
  let rows = 0;
  let invalidRows = 0;
  let entryTrue = 0;
  let entryFalse = 0;
  let entryUnknown = 0;
  let missingRejectReason = 0;
  const rejectReasons: Record<string, number> = {};

  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') {
      invalidRows++;
      continue;
    }
    const row = obj as Record<string, unknown>;
    const ts = Number(row.ts);
    if (!Number.isFinite(ts) || typeof row.mint !== 'string') {
      invalidRows++;
      continue;
    }

    rows++;
    if (row.entryDecision === true) {
      entryTrue++;
    } else if (row.entryDecision === false) {
      entryFalse++;
      if (typeof row.rejectReason === 'string' && row.rejectReason.trim()) {
        rejectReasons[row.rejectReason] = (rejectReasons[row.rejectReason] ?? 0) + 1;
      } else {
        missingRejectReason++;
      }
    } else {
      entryUnknown++;
    }
  }

  return {
    exists: true,
    rows,
    parseErrors,
    invalidRows,
    entryTrue,
    entryFalse,
    entryUnknown,
    missingRejectReason,
    rejectReasons,
  };
}

function analyzeExecutions(filePath: string): ExecutionSummary {
  if (!pathExists(filePath)) {
    return {
      exists: false,
      rows: 0,
      parseErrors: 0,
      invalidRows: 0,
      success: 0,
      fail: 0,
      unknown: 0,
      failRate: null,
      latencies: { p50: null, p95: null, max: null },
      quotedImpact: { p50: null, p95: null, max: null },
      bySide: {},
      failReasons: {},
    };
  }

  const { parseErrors, objects } = parseJsonLines(filePath);
  let rows = 0;
  let invalidRows = 0;
  let success = 0;
  let fail = 0;
  let unknown = 0;
  const latencies: number[] = [];
  const quotedImpact: number[] = [];
  const bySide: Record<string, number> = {};
  const failReasons: Record<string, number> = {};

  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') {
      invalidRows++;
      continue;
    }
    const row = obj as Record<string, unknown>;
    const ts = Number(row.ts);
    if (!Number.isFinite(ts) || typeof row.mint !== 'string') {
      invalidRows++;
      continue;
    }

    rows++;

    const result = typeof row.result === 'string' ? row.result.toLowerCase() : 'unknown';
    if (result === 'success') {
      success++;
    } else if (result === 'fail') {
      fail++;
      const reason = typeof row.error === 'string' && row.error.trim() ? row.error : 'unknown error';
      failReasons[reason] = (failReasons[reason] ?? 0) + 1;
    } else {
      unknown++;
    }

    const latencyMs = Number(row.latencyMs);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) latencies.push(latencyMs);

    const impact = Number(row.quotedImpactPct);
    if (Number.isFinite(impact)) quotedImpact.push(impact);

    const side = typeof row.side === 'string' && row.side.trim() ? row.side.toLowerCase() : 'unknown';
    bySide[side] = (bySide[side] ?? 0) + 1;
  }

  return {
    exists: true,
    rows,
    parseErrors,
    invalidRows,
    success,
    fail,
    unknown,
    failRate: rows > 0 ? fail / rows : null,
    latencies: summarize(latencies),
    quotedImpact: summarize(quotedImpact),
    bySide,
    failReasons,
  };
}

function analyzeTrades(filePath: string): TradeSummary {
  if (!pathExists(filePath)) {
    return {
      exists: false,
      rows: 0,
      parseErrors: 0,
      invalidRows: 0,
      success: 0,
      fail: 0,
      successRate: null,
      txLatencies: { p50: null, p95: null, max: null },
      actualSlippagePct: { p50: null, p95: null, max: null },
      actualSlippageCostUsdc: { p50: null, p95: null, max: null },
      fillSourceCounts: {},
      measuredFillRate: null,
    };
  }

  const { parseErrors, objects } = parseJsonLines(filePath);
  let rows = 0;
  let invalidRows = 0;
  let success = 0;
  let fail = 0;
  const txLatencies: number[] = [];
  const slippagePct: number[] = [];
  const slippageCostUsdc: number[] = [];
  const fillSourceCounts: Record<string, number> = {};
  let measuredFillCount = 0;

  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') {
      invalidRows++;
      continue;
    }
    const row = obj as Record<string, unknown>;
    const timestamp = Number(row.timestamp);
    if (!Number.isFinite(timestamp) || typeof row.mint !== 'string') {
      invalidRows++;
      continue;
    }

    rows++;
    if (row.success === true) success++;
    else fail++;

    const latency = Number(row.txLatencyMs);
    if (Number.isFinite(latency) && latency >= 0) txLatencies.push(latency);

    const slippage = Number(row.actualSlippagePct);
    if (Number.isFinite(slippage)) slippagePct.push(Math.abs(slippage));

    const slippageCost = Number(row.actualSlippageCostUsdc);
    if (Number.isFinite(slippageCost)) slippageCostUsdc.push(Math.abs(slippageCost));

    const fillSource = typeof row.fillSource === 'string' && row.fillSource.trim()
      ? row.fillSource
      : 'unknown';
    fillSourceCounts[fillSource] = (fillSourceCounts[fillSource] ?? 0) + 1;
    if (fillSource === 'onchain') measuredFillCount++;
  }

  return {
    exists: true,
    rows,
    parseErrors,
    invalidRows,
    success,
    fail,
    successRate: rows > 0 ? success / rows : null,
    txLatencies: summarize(txLatencies),
    actualSlippagePct: summarize(slippagePct),
    actualSlippageCostUsdc: summarize(slippageCostUsdc),
    fillSourceCounts,
    measuredFillRate: rows > 0 ? measuredFillCount / rows : null,
  };
}

function mergeCountMaps(...maps: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of maps) {
    for (const [k, v] of Object.entries(m)) {
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

function topNEntries(map: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function analyzePriceDay(
  dataRoot: string,
  date: string,
  expectedMints: string[],
  labelByMint: Map<string, string>,
): PriceDaySummary {
  const pricesRoot = path.join(dataRoot, 'prices');
  const allMints = listDirs(pricesRoot);
  const presentMints = allMints.filter(mint => pathExists(path.join(pricesRoot, mint, `${date}.jsonl`)));
  const missingMints = expectedMints.filter(mint => !presentMints.includes(mint));
  const extraMints = presentMints.filter(mint => !expectedMints.includes(mint));

  const mintsToAnalyze = expectedMints.length > 0 ? expectedMints : presentMints;
  const mintStats: PriceMintStats[] = [];
  const sourceMaps: Record<string, number>[] = [];

  for (const mint of mintsToAnalyze) {
    const filePath = path.join(pricesRoot, mint, `${date}.jsonl`);
    if (!pathExists(filePath)) continue;
    const stats = analyzePriceFile(filePath, mint, labelByMint.get(mint) ?? mint);
    mintStats.push(stats);
    sourceMaps.push(stats.sourceCounts);
  }

  const coverages = mintStats.map(s => s.coverageSpan).filter((v): v is number => v !== null);
  const worst = [...mintStats]
    .filter(s => s.coverageSpan !== null)
    .sort((a, b) => (a.coverageSpan ?? 1) - (b.coverageSpan ?? 1))[0];

  return {
    presentMints,
    missingMints,
    extraMints,
    mintStats,
    totalRows: mintStats.reduce((sum, s) => sum + s.rows, 0),
    totalParseErrors: mintStats.reduce((sum, s) => sum + s.parseErrors, 0),
    totalInvalidRows: mintStats.reduce((sum, s) => sum + s.invalidRows, 0),
    totalNonPositivePrices: mintStats.reduce((sum, s) => sum + s.nonPositivePrices, 0),
    totalOutOfOrder: mintStats.reduce((sum, s) => sum + s.outOfOrder, 0),
    sourceCounts: mergeCountMaps(...sourceMaps),
    coverageMedian: median(coverages),
    worstCoverageMint: worst ? `${worst.label}` : null,
    worstCoverage: worst?.coverageSpan ?? null,
    maxGapMs: maxOrNull(mintStats.map(s => s.gaps.max).filter((v): v is number => v !== null)),
  };
}

function analyzeCandleDay(
  dataRoot: string,
  date: string,
  expectedMints: string[],
  labelByMint: Map<string, string>,
): CandleDaySummary {
  const candlesRoot = path.join(dataRoot, 'candles');
  const allMints = listDirs(candlesRoot);
  const presentMints = allMints.filter(mint => pathExists(path.join(candlesRoot, mint, `${date}.csv`)));
  const missingMints = expectedMints.filter(mint => !presentMints.includes(mint));
  const extraMints = presentMints.filter(mint => !expectedMints.includes(mint));

  const mintsToAnalyze = expectedMints.length > 0 ? expectedMints : presentMints;
  const mintStats: CandleMintStats[] = [];
  for (const mint of mintsToAnalyze) {
    const filePath = path.join(candlesRoot, mint, `${date}.csv`);
    if (!pathExists(filePath)) continue;
    const stats = analyzeCandleFile(filePath, mint, labelByMint.get(mint) ?? mint);
    mintStats.push(stats);
  }

  const intervalMix: Record<string, number> = {};
  for (const s of mintStats) {
    const key = s.inferredIntervalSec === null ? 'unknown' : `${s.inferredIntervalSec}s`;
    intervalMix[key] = (intervalMix[key] ?? 0) + 1;
  }

  const coverages = mintStats.map(s => s.coverageSpan).filter((v): v is number => v !== null);
  const worst = [...mintStats]
    .filter(s => s.coverageSpan !== null)
    .sort((a, b) => (a.coverageSpan ?? 1) - (b.coverageSpan ?? 1))[0];

  return {
    presentMints,
    missingMints,
    extraMints,
    mintStats,
    totalRows: mintStats.reduce((sum, s) => sum + s.rows, 0),
    totalParseErrors: mintStats.reduce((sum, s) => sum + s.parseErrors, 0),
    totalInvalidRows: mintStats.reduce((sum, s) => sum + s.invalidRows, 0),
    totalOhlcViolations: mintStats.reduce((sum, s) => sum + s.ohlcViolations, 0),
    totalNonPositiveOhlc: mintStats.reduce((sum, s) => sum + s.nonPositiveOhlc, 0),
    totalOutOfOrder: mintStats.reduce((sum, s) => sum + s.outOfOrder, 0),
    totalPricePointsZeroOrNegative: mintStats.reduce((sum, s) => sum + s.pricePointsZeroOrNegative, 0),
    intervalMix,
    coverageMedian: median(coverages),
    worstCoverageMint: worst ? `${worst.label}` : null,
    worstCoverage: worst?.coverageSpan ?? null,
    maxGapMs: maxOrNull(mintStats.map(s => s.gaps.max).filter((v): v is number => v !== null)),
  };
}

function maxOrNull(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function evaluateDay(report: Omit<DayReport, 'status' | 'issues'>): { status: Status; issues: Issue[] } {
  const issues: Issue[] = [];

  if (report.prices.missingMints.length > 0) {
    issues.push({ severity: 'high', message: `Missing price files for ${report.prices.missingMints.length} expected mint(s)` });
  }
  if (report.candles.missingMints.length > 0) {
    issues.push({ severity: 'high', message: `Missing candle files for ${report.candles.missingMints.length} expected mint(s)` });
  }
  if (report.prices.totalParseErrors > 0 || report.candles.totalParseErrors > 0 || report.signals.parseErrors > 0 || report.executions.parseErrors > 0 || report.trades.parseErrors > 0) {
    issues.push({ severity: 'high', message: 'Found parse errors in one or more datasets' });
  }
  if (report.prices.totalInvalidRows > 0 || report.candles.totalInvalidRows > 0 || report.signals.invalidRows > 0 || report.executions.invalidRows > 0 || report.trades.invalidRows > 0) {
    issues.push({ severity: 'medium', message: 'Found structurally invalid rows' });
  }
  if (report.prices.totalNonPositivePrices > 0 || report.candles.totalNonPositiveOhlc > 0) {
    issues.push({ severity: 'high', message: 'Found non-positive price/OHLC values' });
  }
  if ((report.prices.maxGapMs ?? 0) > 120_000) {
    issues.push({ severity: 'high', message: `Large price gap detected (${fmtMs(report.prices.maxGapMs)})` });
  } else if ((report.prices.maxGapMs ?? 0) > 45_000) {
    issues.push({ severity: 'medium', message: `Price gap warning (${fmtMs(report.prices.maxGapMs)})` });
  }
  if ((report.candles.maxGapMs ?? 0) > 600_000) {
    issues.push({ severity: 'high', message: `Large candle gap detected (${fmtMs(report.candles.maxGapMs)})` });
  } else if ((report.candles.maxGapMs ?? 0) > 120_000) {
    issues.push({ severity: 'medium', message: `Candle gap warning (${fmtMs(report.candles.maxGapMs)})` });
  }
  if ((report.prices.coverageMedian ?? 1) < 0.95) {
    issues.push({ severity: 'high', message: `Low median price span coverage (${fmtPct(report.prices.coverageMedian)})` });
  } else if ((report.prices.coverageMedian ?? 1) < 0.99) {
    issues.push({ severity: 'medium', message: `Price span coverage below target (${fmtPct(report.prices.coverageMedian)})` });
  }
  if ((report.candles.coverageMedian ?? 1) < 0.95) {
    issues.push({ severity: 'high', message: `Low median candle span coverage (${fmtPct(report.candles.coverageMedian)})` });
  } else if ((report.candles.coverageMedian ?? 1) < 0.99) {
    issues.push({ severity: 'medium', message: `Candle span coverage below target (${fmtPct(report.candles.coverageMedian)})` });
  }
  if (report.signals.exists && report.signals.rows === 0) {
    issues.push({ severity: 'high', message: 'Signals file exists but has zero valid rows' });
  }
  if (report.signals.missingRejectReason > 0) {
    issues.push({ severity: 'medium', message: `Missing rejectReason on ${report.signals.missingRejectReason} rejected signal(s)` });
  }
  if (report.executions.exists && (report.executions.failRate ?? 0) > 0.25) {
    issues.push({ severity: 'high', message: `High execution fail rate (${fmtPct(report.executions.failRate)})` });
  } else if (report.executions.exists && (report.executions.failRate ?? 0) > 0.10) {
    issues.push({ severity: 'medium', message: `Execution fail rate warning (${fmtPct(report.executions.failRate)})` });
  }
  if (report.executions.exists && report.trades.exists) {
    const diff = Math.abs(report.executions.rows - report.trades.rows);
    const maxRows = Math.max(report.executions.rows, report.trades.rows);
    if (maxRows > 0 && diff > Math.max(5, Math.floor(maxRows * 0.2))) {
      issues.push({ severity: 'medium', message: `Execution/trade row mismatch (${report.executions.rows} vs ${report.trades.rows})` });
    }
  }
  if (report.trades.exists && (report.trades.measuredFillRate ?? 0) < 0.5) {
    issues.push({ severity: 'medium', message: `Low measured fill coverage for slippage (${fmtPct(report.trades.measuredFillRate)})` });
  }
  if (report.prices.extraMints.length > 0 || report.candles.extraMints.length > 0) {
    issues.push({ severity: 'medium', message: 'Found mint files outside watchlist (check intentional additions)' });
  }

  const hasHigh = issues.some(i => i.severity === 'high');
  const hasMedium = issues.some(i => i.severity === 'medium');
  const status: Status = hasHigh ? 'FAIL' : hasMedium ? 'WARN' : 'PASS';
  return { status, issues };
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  return `${(v * 100).toFixed(2)}%`;
}

function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${v.toFixed(0)}ms`;
}

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  return `$${v.toFixed(4)}`;
}

function makeMarkdown(
  generatedAtIso: string,
  dataRoot: string,
  minDate: string,
  expectedMintCount: number,
  dayReports: DayReport[],
): string {
  const worstStatus = getOverallStatus(dayReports.map(d => d.status));
  const lines: string[] = [];

  lines.push('# Daily Data QA Report');
  lines.push('');
  lines.push(`- Generated UTC: ${generatedAtIso}`);
  lines.push(`- Data root: \`${dataRoot}\``);
  lines.push(`- Min clean date: ${minDate}`);
  lines.push(`- Expected watchlist mints: ${expectedMintCount}`);
  lines.push(`- Overall status: **${worstStatus}**`);
  lines.push('');

  for (const day of dayReports) {
    lines.push(`## ${day.date} (${day.status})`);
    lines.push('');
    lines.push(`- Prices: ${day.prices.presentMints.length}/${expectedMintCount || day.prices.presentMints.length} files, rows ${day.prices.totalRows}, median span coverage ${fmtPct(day.prices.coverageMedian)}, worst ${day.prices.worstCoverageMint ?? 'n/a'} ${fmtPct(day.prices.worstCoverage)}, max gap ${fmtMs(day.prices.maxGapMs)}`);
    lines.push(`- Candles: ${day.candles.presentMints.length}/${expectedMintCount || day.candles.presentMints.length} files, rows ${day.candles.totalRows}, interval mix ${formatMap(day.candles.intervalMix)}, median span coverage ${fmtPct(day.candles.coverageMedian)}, max gap ${fmtMs(day.candles.maxGapMs)}`);
    lines.push(`- Signals: ${day.signals.exists ? 'present' : 'missing'}, rows ${day.signals.rows}, entry true/false/unknown ${day.signals.entryTrue}/${day.signals.entryFalse}/${day.signals.entryUnknown}`);
    lines.push(`- Executions: ${day.executions.exists ? 'present' : 'missing'}, rows ${day.executions.rows}, success/fail/unknown ${day.executions.success}/${day.executions.fail}/${day.executions.unknown}, fail rate ${fmtPct(day.executions.failRate)}, latency p50/p95/max ${fmtMs(day.executions.latencies.p50)}/${fmtMs(day.executions.latencies.p95)}/${fmtMs(day.executions.latencies.max)}`);
    lines.push(`- Trades: ${day.trades.exists ? 'present' : 'missing'}, rows ${day.trades.rows}, success/fail ${day.trades.success}/${day.trades.fail}, success rate ${fmtPct(day.trades.successRate)}, measured fill rate ${fmtPct(day.trades.measuredFillRate)}, tx latency p50/p95/max ${fmtMs(day.trades.txLatencies.p50)}/${fmtMs(day.trades.txLatencies.p95)}/${fmtMs(day.trades.txLatencies.max)}, slippage cost |abs| p50/p95/max ${fmtUsd(day.trades.actualSlippageCostUsdc.p50)}/${fmtUsd(day.trades.actualSlippageCostUsdc.p95)}/${fmtUsd(day.trades.actualSlippageCostUsdc.max)}, fill sources ${formatMap(day.trades.fillSourceCounts)}`);

    const topRejects = topNEntries(day.signals.rejectReasons, 3);
    if (topRejects.length > 0) {
      lines.push(`- Top reject reasons: ${topRejects.map(([k, v]) => `${k} (${v})`).join('; ')}`);
    }

    const topFailReasons = topNEntries(day.executions.failReasons, 3);
    if (topFailReasons.length > 0) {
      lines.push(`- Top execution errors: ${topFailReasons.map(([k, v]) => `${k} (${v})`).join('; ')}`);
    }

    if (day.issues.length === 0) {
      lines.push('- Alerts: none');
    } else {
      lines.push('- Alerts:');
      for (const issue of day.issues) {
        lines.push(`  - [${issue.severity.toUpperCase()}] ${issue.message}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

function formatMap(map: Record<string, number>): string {
  const entries = Object.entries(map);
  if (entries.length === 0) return 'n/a';
  return entries.sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ');
}

function getOverallStatus(statuses: Status[]): Status {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('WARN')) return 'WARN';
  return 'PASS';
}

function writeIfRequested(filePath: string | undefined, content: string): void {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!pathExists(args.dataRoot)) {
    throw new Error(`Data root does not exist: ${args.dataRoot}`);
  }

  const watchlist = readWatchlist(args.watchlistPath);
  const expectedMints = watchlist.map(w => w.mint);
  const labelByMint = new Map<string, string>();
  for (const w of watchlist) {
    labelByMint.set(w.mint, w.label ?? w.mint);
  }

  const availableDates = collectAvailableDates(args.dataRoot);
  const dates = pickDates(args, availableDates);
  if (dates.length === 0) {
    throw new Error(`No dates found at or after ${args.minDate}. Use --date or --from/--to if needed.`);
  }

  const dayReports: DayReport[] = [];
  for (const date of dates) {
    const prices = analyzePriceDay(args.dataRoot, date, expectedMints, labelByMint);
    const candles = analyzeCandleDay(args.dataRoot, date, expectedMints, labelByMint);
    const signals = analyzeSignals(path.join(args.dataRoot, 'signals', `${date}.jsonl`));
    const executions = analyzeExecutions(path.join(args.dataRoot, 'executions', `${date}.jsonl`));
    const trades = analyzeTrades(path.join(args.dataRoot, 'data', 'trades', `${date}.jsonl`));

    const base = { date, prices, candles, signals, executions, trades };
    const scored = evaluateDay(base);
    dayReports.push({ ...base, ...scored });
  }

  const markdown = makeMarkdown(
    new Date().toISOString(),
    args.dataRoot,
    args.minDate,
    expectedMints.length,
    dayReports,
  );

  console.log(markdown);

  writeIfRequested(args.out, markdown);
  if (args.out) {
    console.log(`\nSaved markdown report: ${args.out}`);
  }

  if (args.jsonOut) {
    writeIfRequested(args.jsonOut, JSON.stringify({
      generatedAtUtc: new Date().toISOString(),
      dataRoot: args.dataRoot,
      minDate: args.minDate,
      expectedMints,
      days: dayReports,
      overallStatus: getOverallStatus(dayReports.map(d => d.status)),
    }, null, 2));
    console.log(`Saved JSON report: ${args.jsonOut}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`QA report failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
