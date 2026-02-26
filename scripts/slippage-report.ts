import fs from 'fs';
import path from 'path';

interface TradeRow {
  id?: string;
  mint?: string;
  side?: 'buy' | 'sell' | string;
  timestamp?: number;
  success?: boolean;
  fillSource?: string;
  usdcAmount?: number;
  actualSlippagePctWorse?: number | null;
  actualSlippageCostUsdc?: number | null;
}

interface Args {
  dataRoot: string;
  date?: string;
  from?: string;
  to?: string;
  last: number;
  top: number;
}

interface Stats {
  count: number;
  measuredCount: number;
  avgCostUsdc: number | null;
  medCostUsdc: number | null;
  p95CostUsdc: number | null;
  avgPctWorse: number | null;
  medPctWorse: number | null;
  p95PctWorse: number | null;
  avgCostPctNotional: number | null;
  netCostUsdc: number | null;
  grossWorseUsdc: number | null;
  grossImprovementUsdc: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dataRoot: path.resolve(__dirname, '../data/data'),
    last: 50,
    top: 8,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--data-root') {
      args.dataRoot = path.resolve(requireValue(arg, next));
      i++;
      continue;
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
    if (arg === '--last') {
      args.last = Number(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--top') {
      args.top = Number(requireValue(arg, next));
      i++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.date && (args.from || args.to)) {
    throw new Error('Use either --date or --from/--to, not both.');
  }
  if ((args.from && !args.to) || (!args.from && args.to)) {
    throw new Error('Use both --from and --to together.');
  }
  if (args.date && !isDateKey(args.date)) {
    throw new Error(`Invalid --date: ${args.date}`);
  }
  if (args.from && !isDateKey(args.from)) {
    throw new Error(`Invalid --from: ${args.from}`);
  }
  if (args.to && !isDateKey(args.to)) {
    throw new Error(`Invalid --to: ${args.to}`);
  }
  if (!Number.isFinite(args.last) || args.last <= 0) {
    throw new Error(`Invalid --last: ${args.last}`);
  }
  if (!Number.isFinite(args.top) || args.top <= 0) {
    throw new Error(`Invalid --top: ${args.top}`);
  }

  return args;
}

function printHelp(): void {
  console.log([
    'Usage:',
    '  npm run slippage-report',
    '  npm run slippage-report -- --last 100',
    '  npm run slippage-report -- --date 2026-02-25',
    '  npm run slippage-report -- --from 2026-02-24 --to 2026-02-25',
    '',
    'Flags:',
    '  --data-root PATH     Data root (default: sol-trader/data/data)',
    '  --date YYYY-MM-DD    Single UTC date',
    '  --from YYYY-MM-DD    UTC start date (inclusive)',
    '  --to YYYY-MM-DD      UTC end date (inclusive)',
    '  --last N             Rolling window size (default: 50)',
    '  --top N              Outliers to print (default: 8)',
  ].join('\n'));
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
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

function findTradesDir(dataRoot: string): string {
  const candidates = [
    path.join(dataRoot, 'data', 'trades'),
    path.join(dataRoot, 'trades'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Could not find trades directory under ${dataRoot}`);
}

function readTrades(tradesDir: string): TradeRow[] {
  const files = fs.readdirSync(tradesDir)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();

  const out: TradeRow[] = [];
  for (const name of files) {
    const full = path.join(tradesDir, name);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as TradeRow;
        if (row && row.success === true && Number.isFinite(row.timestamp)) {
          out.push(row);
        }
      } catch {
        // ignore malformed line
      }
    }
  }

  return out.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function measuredRows(rows: TradeRow[]): TradeRow[] {
  return rows.filter(row =>
    toNumber(row.actualSlippageCostUsdc) !== null &&
    toNumber(row.actualSlippagePctWorse) !== null
  );
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarize(rows: TradeRow[]): Stats {
  const measured = measuredRows(rows);
  const costs = measured.map(r => toNumber(r.actualSlippageCostUsdc) as number);
  const pcts = measured.map(r => toNumber(r.actualSlippagePctWorse) as number);
  const costPctNotional = measured
    .map(r => {
      const cost = toNumber(r.actualSlippageCostUsdc);
      const usdc = toNumber(r.usdcAmount);
      if (cost === null || usdc === null || usdc <= 0) return null;
      return (cost / usdc) * 100;
    })
    .filter((v): v is number => v !== null);

  const grossWorse = costs.filter(c => c > 0);
  const grossBetter = costs.filter(c => c < 0);

  return {
    count: rows.length,
    measuredCount: measured.length,
    avgCostUsdc: avg(costs),
    medCostUsdc: percentile(costs, 0.5),
    p95CostUsdc: percentile(costs, 0.95),
    avgPctWorse: avg(pcts),
    medPctWorse: percentile(pcts, 0.5),
    p95PctWorse: percentile(pcts, 0.95),
    avgCostPctNotional: avg(costPctNotional),
    netCostUsdc: costs.length > 0 ? costs.reduce((s, v) => s + v, 0) : null,
    grossWorseUsdc: grossWorse.length > 0 ? grossWorse.reduce((s, v) => s + v, 0) : 0,
    grossImprovementUsdc: grossBetter.length > 0 ? grossBetter.reduce((s, v) => s + v, 0) : 0,
  };
}

function fmt(v: number | null, digits = 6): string {
  if (v === null || Number.isNaN(v)) return 'n/a';
  return v.toFixed(digits);
}

function printSection(name: string, rows: TradeRow[], topN: number): void {
  const stats = summarize(rows);
  const measured = measuredRows(rows);

  console.log(`\n${name}`);
  console.log(`- success trades: ${stats.count}`);
  console.log(`- measured slippage trades: ${stats.measuredCount}`);
  console.log(`- avg slippage cost (USDC): ${fmt(stats.avgCostUsdc)}`);
  console.log(`- median slippage cost (USDC): ${fmt(stats.medCostUsdc)}`);
  console.log(`- p95 slippage cost (USDC): ${fmt(stats.p95CostUsdc)}`);
  console.log(`- avg slippage pct worse: ${fmt(stats.avgPctWorse, 4)}% (${fmt(stats.avgPctWorse === null ? null : stats.avgPctWorse * 100, 2)} bps)`);
  console.log(`- median slippage pct worse: ${fmt(stats.medPctWorse, 4)}%`);
  console.log(`- p95 slippage pct worse: ${fmt(stats.p95PctWorse, 4)}%`);
  console.log(`- avg slippage cost (% notional): ${fmt(stats.avgCostPctNotional, 4)}%`);
  console.log(`- net slippage cost (USDC): ${fmt(stats.netCostUsdc)}`);
  console.log(`- gross worse (USDC): ${fmt(stats.grossWorseUsdc)}`);
  console.log(`- gross improvement (USDC): ${fmt(stats.grossImprovementUsdc)}`);

  const sideRows = ['buy', 'sell'].map(side => {
    const subset = measured.filter(r => (r.side ?? '').toLowerCase() === side);
    const costs = subset.map(r => toNumber(r.actualSlippageCostUsdc) as number);
    const pcts = subset.map(r => toNumber(r.actualSlippagePctWorse) as number);
    return {
      side,
      n: subset.length,
      avgCost: avg(costs),
      avgPct: avg(pcts),
    };
  });

  console.log('- by side:');
  for (const row of sideRows) {
    console.log(`  - ${row.side}: n=${row.n}, avgCost=${fmt(row.avgCost)}, avgPct=${fmt(row.avgPct, 4)}%`);
  }

  const worstCost = [...measured]
    .sort((a, b) => (toNumber(b.actualSlippageCostUsdc) as number) - (toNumber(a.actualSlippageCostUsdc) as number))
    .slice(0, topN);

  if (worstCost.length > 0) {
    console.log(`- worst ${Math.min(topN, worstCost.length)} by slippage cost:`);
    for (const r of worstCost) {
      const ts = toNumber(r.timestamp);
      const utc = ts === null ? 'n/a' : new Date(ts).toISOString();
      const mint = (r.mint ?? '').slice(0, 8);
      console.log(`  - ${utc} ${String(r.side ?? 'n/a').toLowerCase()} ${mint}: cost=${fmt(toNumber(r.actualSlippageCostUsdc))} usdc, pct=${fmt(toNumber(r.actualSlippagePctWorse), 4)}%`);
    }
  }
}

function filterByDateRange(rows: TradeRow[], from: string, to: string): TradeRow[] {
  const startMs = dateKeyToUtcMs(from);
  const endMs = dateKeyToUtcMs(to) + DAY_MS;
  return rows.filter(r => {
    const ts = toNumber(r.timestamp);
    return ts !== null && ts >= startMs && ts < endMs;
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tradesDir = findTradesDir(args.dataRoot);
  const allRows = readTrades(tradesDir);

  if (allRows.length === 0) {
    console.log(`No successful trades found in ${tradesDir}`);
    return;
  }

  const latestTs = toNumber(allRows[allRows.length - 1].timestamp) as number;
  const latestDate = utcMsToDateKey(latestTs);

  console.log('Slippage Report');
  console.log(`- trades dir: ${tradesDir}`);
  console.log(`- latest trade UTC: ${new Date(latestTs).toISOString()}`);

  if (args.date) {
    const rows = filterByDateRange(allRows, args.date, args.date);
    printSection(`UTC day ${args.date}`, rows, args.top);
    return;
  }

  if (args.from && args.to) {
    const rows = filterByDateRange(allRows, args.from, args.to);
    printSection(`UTC range ${args.from}..${args.to}`, rows, args.top);
    return;
  }

  const latestDayRows = filterByDateRange(allRows, latestDate, latestDate);
  const last24hRows = allRows.filter(r => {
    const ts = toNumber(r.timestamp);
    return ts !== null && ts >= latestTs - DAY_MS;
  });
  const lastNRows = allRows.slice(-args.last);

  printSection(`Latest UTC day (${latestDate})`, latestDayRows, args.top);
  printSection('Last 24h (from latest trade timestamp)', last24hRows, args.top);
  printSection(`Last ${args.last} successful trades`, lastNRows, args.top);
}

try {
  main();
} catch (err) {
  console.error(`Slippage report failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
