import { createLogger } from '../utils';

const log = createLogger('price-feed');

interface PricePoint {
  timestamp: number;
  price: number;
}

// Per-mint rolling price history from Jupiter polls
const priceHistory = new Map<string, PricePoint[]>();

const MAX_HISTORY_MS = 150 * 60_000; // Keep 150 minutes (enough for 120min CRSI lookback)

export function recordPrice(mint: string, price: number) {
  if (price <= 0) return;

  let history = priceHistory.get(mint);
  if (!history) {
    history = [];
    priceHistory.set(mint, history);
  }

  history.push({ timestamp: Date.now(), price });

  // Prune old entries
  const cutoff = Date.now() - MAX_HISTORY_MS;
  const pruneIdx = history.findIndex(p => p.timestamp >= cutoff);
  if (pruneIdx > 0) {
    history.splice(0, pruneIdx);
  }

  if (history.length % 20 === 0) {
    log.debug('Price history', { mint, points: history.length, latestPrice: price });
  }
}

/**
 * Build a close-price series from stored price polls.
 * Buckets prices into fixed intervals and forward-fills gaps.
 */
export function buildCloseSeriesFromPrices(
  mint: string,
  intervalMs: number,
  lookbackMs: number
): number[] {
  const history = priceHistory.get(mint);
  if (!history || history.length === 0) return [];

  const now = Date.now();
  const start = now - lookbackMs;
  const bucketCount = Math.ceil(lookbackMs / intervalMs);
  const closes: Array<number | undefined> = new Array(bucketCount).fill(undefined);

  for (const point of history) {
    if (point.timestamp < start || point.timestamp > now) continue;
    const idx = Math.floor((point.timestamp - start) / intervalMs);
    if (idx >= 0 && idx < bucketCount) {
      closes[idx] = point.price; // Last price in each bucket wins
    }
  }

  // Forward-fill gaps
  const series: number[] = [];
  let last: number | undefined;
  for (const close of closes) {
    if (close !== undefined) last = close;
    if (last !== undefined) series.push(last);
  }

  return series;
}

export function getPriceHistoryCount(mint: string): number {
  return priceHistory.get(mint)?.length ?? 0;
}

export function clearPriceHistory(mint: string) {
  priceHistory.delete(mint);
}
