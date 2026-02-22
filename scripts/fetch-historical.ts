/**
 * fetch-historical.ts
 *
 * One-time (or weekly refresh) script to pull daily OHLCV candles from Birdeye
 * and write monthly aggregates to data/historical/{mint}.csv
 *
 * Usage:
 *   tsx scripts/fetch-historical.ts              # full fetch all watchlist tokens
 *   tsx scripts/fetch-historical.ts --append     # only fetch missing rows since last CSV date
 *   tsx scripts/fetch-historical.ts --mint <addr> # single token only
 *
 * Requires: BIRDEYE_API_KEY in .env
 */

import fs from 'fs';
import path from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv();

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
if (!BIRDEYE_API_KEY) {
  console.error('Missing BIRDEYE_API_KEY in .env');
  process.exit(1);
}

const WATCHLIST_PATH = path.resolve(__dirname, '../config/watchlist.json');
const HISTORICAL_DIR = path.resolve(__dirname, '../data/historical');

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const DAILY_TYPE = '1D';
const DELAY_MS = 1100; // Birdeye free tier: 1 RPS limit

interface WatchlistEntry {
  mint: string;
  label: string;
}

interface OhlcvCandle {
  unixTime: number; // seconds
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

interface MonthlyCandle {
  month: string; // YYYY-MM
  open: number;
  high: number;
  low: number;
  close: number;
  avgDailyVolume: number;
  days: number;
}

const CSV_HEADER = 'month,open,high,low,close,avgDailyVolume,days';

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchDailyCandles(mint: string, fromUnix: number, toUnix: number): Promise<OhlcvCandle[]> {
  const url = `${BIRDEYE_BASE}/defi/ohlcv?address=${mint}&type=${DAILY_TYPE}&time_from=${fromUnix}&time_to=${toUnix}`;
  const res = await fetch(url, {
    headers: {
      'X-API-KEY': BIRDEYE_API_KEY!,
      'x-chain': 'solana',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Birdeye HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as {
    success: boolean;
    data?: { items?: OhlcvCandle[] };
  };

  if (!json.success || !json.data?.items) {
    return [];
  }

  return json.data.items;
}

function aggregateToMonthly(dailyCandles: OhlcvCandle[]): MonthlyCandle[] {
  // Group by YYYY-MM
  const byMonth = new Map<string, OhlcvCandle[]>();
  for (const c of dailyCandles) {
    const d = new Date(c.unixTime * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(c);
  }

  const months: MonthlyCandle[] = [];
  for (const [month, candles] of byMonth.entries()) {
    candles.sort((a, b) => a.unixTime - b.unixTime);
    const open = candles[0].o;
    const close = candles[candles.length - 1].c;
    const high = Math.max(...candles.map(c => c.h));
    const low = Math.min(...candles.map(c => c.l));
    const avgDailyVolume = candles.reduce((s, c) => s + c.v, 0) / candles.length;
    months.push({ month, open, high, low, close, avgDailyVolume, days: candles.length });
  }

  return months.sort((a, b) => a.month.localeCompare(b.month));
}

function loadExistingMonths(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const months = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const month = lines[i].split(',')[0]?.trim();
    if (month && month.match(/^\d{4}-\d{2}$/)) months.add(month);
  }
  return months;
}

function getLastMonthInCsv(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 1; i--) {
    const month = lines[i].split(',')[0]?.trim();
    if (month?.match(/^\d{4}-\d{2}$/)) return month;
  }
  return null;
}

function writeOrAppendCsv(filePath: string, newMonths: MonthlyCandle[], appendMode: boolean) {
  const existingMonths = loadExistingMonths(filePath);

  // Only write months not already present
  const toWrite = newMonths.filter(m => !existingMonths.has(m.month));
  if (toWrite.length === 0) {
    console.log('  No new months to write.');
    return;
  }

  const rows = toWrite.map(m =>
    `${m.month},${m.open},${m.high},${m.low},${m.close},${Math.round(m.avgDailyVolume)},${m.days}`
  );

  if (!fs.existsSync(filePath) || !appendMode) {
    // Write fresh file with header
    const allMonths = appendMode
      ? [...loadAllFromCsv(filePath), ...toWrite].sort((a, b) => a.month.localeCompare(b.month))
      : toWrite;
    const allRows = allMonths.map(m =>
      `${m.month},${m.open},${m.high},${m.low},${m.close},${Math.round(m.avgDailyVolume)},${m.days}`
    );
    fs.writeFileSync(filePath, CSV_HEADER + '\n' + allRows.join('\n') + '\n');
  } else {
    // Append new rows only
    fs.appendFileSync(filePath, rows.join('\n') + '\n');
  }

  console.log(`  Wrote ${toWrite.length} new month(s).`);
}

function loadAllFromCsv(filePath: string): MonthlyCandle[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const result: MonthlyCandle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(',');
    if (parts.length < 7) continue;
    result.push({
      month: parts[0],
      open: parseFloat(parts[1]),
      high: parseFloat(parts[2]),
      low: parseFloat(parts[3]),
      close: parseFloat(parts[4]),
      avgDailyVolume: parseFloat(parts[5]),
      days: parseInt(parts[6]),
    });
  }
  return result;
}

async function fetchToken(entry: WatchlistEntry, appendMode: boolean) {
  const filePath = path.join(HISTORICAL_DIR, `${entry.mint}.csv`);

  // Determine time range
  let fromUnix: number;
  const toUnix = Math.floor(Date.now() / 1000);

  if (appendMode) {
    const lastMonth = getLastMonthInCsv(filePath);
    if (lastMonth) {
      // Start from the 1st of the last recorded month (re-fetch it to fill partial month)
      const [y, m] = lastMonth.split('-').map(Number);
      fromUnix = Math.floor(new Date(Date.UTC(y, m - 1, 1)).getTime() / 1000);
      console.log(`  Appending from ${lastMonth}...`);
    } else {
      fromUnix = 0; // no data yet, full fetch
      console.log(`  No existing data, doing full fetch...`);
    }
  } else {
    fromUnix = 0; // max history
    console.log(`  Full fetch from inception...`);
  }

  // Birdeye max window per request is ~365 days for 1D candles
  // Paginate in 1-year chunks from fromUnix to now
  const ONE_YEAR = 365 * 24 * 3600;
  let allCandles: OhlcvCandle[] = [];
  let cursor = fromUnix === 0 ? toUnix - (5 * 365 * 24 * 3600) : fromUnix; // max 5 years back if no start

  while (cursor < toUnix) {
    const chunkEnd = Math.min(cursor + ONE_YEAR, toUnix);
    const candles = await fetchDailyCandles(entry.mint, cursor, chunkEnd);
    if (candles.length > 0) {
      allCandles = allCandles.concat(candles);
      console.log(`  Fetched ${candles.length} daily candles (${new Date(cursor * 1000).toISOString().slice(0, 10)} → ${new Date(chunkEnd * 1000).toISOString().slice(0, 10)})`);
    }
    cursor = chunkEnd + 1;
    if (cursor < toUnix) await sleep(DELAY_MS);
  }

  if (allCandles.length === 0) {
    console.log(`  No candle data returned from Birdeye.`);
    return;
  }

  const monthly = aggregateToMonthly(allCandles);

  // Don't write the current (incomplete) month
  const nowYM = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const complete = monthly.filter(m => m.month < nowYM);

  writeOrAppendCsv(filePath, complete, appendMode);
  console.log(`  Total: ${complete.length} complete months of data.`);
}

async function main() {
  const args = process.argv.slice(2);
  const appendMode = args.includes('--append');
  const mintArg = args.includes('--mint') ? args[args.indexOf('--mint') + 1] : null;

  if (!fs.existsSync(HISTORICAL_DIR)) {
    fs.mkdirSync(HISTORICAL_DIR, { recursive: true });
  }

  const watchlist: WatchlistEntry[] = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf-8'));
  const targets = mintArg
    ? watchlist.filter(e => e.mint === mintArg)
    : watchlist;

  if (targets.length === 0) {
    console.error(mintArg ? `Mint ${mintArg} not found in watchlist.` : 'Watchlist is empty.');
    process.exit(1);
  }

  console.log(`Mode: ${appendMode ? 'append' : 'full fetch'} | Tokens: ${targets.length}`);
  console.log('---');

  for (const entry of targets) {
    console.log(`\n[${entry.label}] ${entry.mint}`);
    try {
      await fetchToken(entry, appendMode);
    } catch (err) {
      console.error(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(DELAY_MS);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
