import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils';

const log = createLogger('data-logger');
const DATA_DIR = path.resolve(__dirname, '../../data');

function getDateStr(): string {
  return new Date().toISOString().split('T')[0];
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function appendJsonl(subdir: string, filename: string, obj: Record<string, unknown>) {
  const dir = path.join(DATA_DIR, subdir);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function appendCsv(subdir: string, filename: string, header: string, row: string) {
  const dir = path.join(DATA_DIR, subdir);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, header + '\n');
  }
  fs.appendFileSync(filePath, row + '\n');
}

// --- Phase 1: Raw Price Points ---

export function logPricePoint(
  mint: string,
  priceUsd: number,
  priceSol: number,
  source: string,
  pollLatencyMs: number
) {
  const date = getDateStr();
  appendJsonl(`prices/${mint}`, `${date}.jsonl`, {
    ts: Date.now(),
    mint,
    priceUsd,
    priceSol,
    source,
    pollLatencyMs,
  });
}

// --- Phase 2: Signal Decision Snapshots ---

export interface SignalLogEntry {
  mint: string;
  crsi?: number;
  rsi?: number;
  source: string;
  candleCount: number;
  entryDecision: boolean;
  rejectReason: string;
  quotedImpactPct?: number;
  liquidityUsd: number;
  effectiveMaxUsdc: number;
}

export function logSignal(data: SignalLogEntry) {
  const date = getDateStr();
  appendJsonl('signals', `${date}.jsonl`, { ts: Date.now(), ...data });
}

// --- Phase 3: Execution Events ---

export interface ExecutionLogEntry {
  mint: string;
  side: 'buy' | 'sell';
  sizeUsdc: number;
  slippageBps: number;
  quotedImpactPct: number;
  result: 'success' | 'fail';
  error: string;
  latencyMs: number;
}

export function logExecution(data: ExecutionLogEntry) {
  const date = getDateStr();
  appendJsonl('executions', `${date}.jsonl`, { ts: Date.now(), ...data });
}

// --- Phase 4: Derived Candles ---

interface PricePoint {
  timestamp: number;
  price: number;
}

export function exportCandles(mint: string, priceHistory: PricePoint[]) {
  if (priceHistory.length === 0) return;

  const date = getDateStr();
  const intervalMs = 60_000; // 1-minute candles

  // Find the range for today (UTC)
  const dayStart = new Date(date + 'T00:00:00Z').getTime();
  const dayEnd = dayStart + 86_400_000;
  const todayPoints = priceHistory.filter(p => p.timestamp >= dayStart && p.timestamp < dayEnd);
  if (todayPoints.length === 0) return;

  // Bucket into 1-minute candles
  const buckets = new Map<number, PricePoint[]>();
  for (const p of todayPoints) {
    const bucketTs = Math.floor(p.timestamp / intervalMs) * intervalMs;
    let bucket = buckets.get(bucketTs);
    if (!bucket) {
      bucket = [];
      buckets.set(bucketTs, bucket);
    }
    bucket.push(p);
  }

  // Build CSV rows
  const header = 'timestamp,open,high,low,close,pricePoints';
  const rows: string[] = [];
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const ts of sortedKeys) {
    const points = buckets.get(ts)!;
    const prices = points.map(p => p.price);
    const open = prices[0];
    const close = prices[prices.length - 1];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    rows.push(`${ts},${open},${high},${low},${close},${points.length}`);
  }

  // Overwrite today's candle file (rebuilt from in-memory data)
  const dir = path.join(DATA_DIR, `candles/${mint}`);
  ensureDir(dir);
  const filePath = path.join(dir, `${date}.csv`);
  fs.writeFileSync(filePath, header + '\n' + rows.join('\n') + '\n');
}

// --- Phase 5: Persistence ---

const SNAPSHOT_PATH = path.join(DATA_DIR, 'price-history-snapshot.json');

export function savePriceHistory(history: Map<string, PricePoint[]>) {
  ensureDir(DATA_DIR);
  const obj: Record<string, PricePoint[]> = {};
  for (const [mint, points] of history) {
    obj[mint] = points;
  }
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(obj));
  log.debug('Price history snapshot saved', { mints: history.size });
}

export function loadPriceHistorySnapshot(): Map<string, PricePoint[]> {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    log.info('No price history snapshot found');
    return new Map();
  }

  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, PricePoint[]>;
    const history = new Map<string, PricePoint[]>();
    const cutoff = Date.now() - 150 * 60_000; // Keep last 150 minutes

    for (const [mint, points] of Object.entries(obj)) {
      const recent = points.filter(p => p.timestamp >= cutoff);
      if (recent.length > 0) {
        history.set(mint, recent);
      }
    }

    log.info('Price history snapshot loaded', {
      mints: history.size,
      totalPoints: Array.from(history.values()).reduce((sum, arr) => sum + arr.length, 0),
    });
    return history;
  } catch (err) {
    log.warn('Failed to load price history snapshot', { error: err });
    return new Map();
  }
}
