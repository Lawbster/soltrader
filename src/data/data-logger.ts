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
  result: 'success' | 'fail' | 'skipped';
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

  // Bucket into 1-minute candles from current in-memory data
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

  const header = 'timestamp,open,high,low,close,pricePoints';
  const dir = path.join(DATA_DIR, `candles/${mint}`);
  ensureDir(dir);
  const filePath = path.join(dir, `${date}.csv`);

  // Load existing candles from disk so we don't lose older data
  const existing = new Map<number, string>();
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const ts = parseInt(line.split(',')[0], 10);
      if (!isNaN(ts)) existing.set(ts, line);
    }
  }

  // Build new candle rows from in-memory data (these are fresher, so they win)
  for (const ts of buckets.keys()) {
    const points = buckets.get(ts)!;
    const prices = points.map(p => p.price);
    const open = prices[0];
    const close = prices[prices.length - 1];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    existing.set(ts, `${ts},${open},${high},${low},${close},${points.length}`);
  }

  // Write merged candles sorted by timestamp
  const sortedRows = Array.from(existing.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row);
  fs.writeFileSync(filePath, header + '\n' + sortedRows.join('\n') + '\n');
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
