import { createLogger } from '../utils';

const log = createLogger('price-feed');

interface PricePoint {
  timestamp: number;
  price: number;
}

// Per-mint rolling price history from Jupiter polls
const priceHistory = new Map<string, PricePoint[]>();

export const MAX_HISTORY_MS = 48 * 60 * 60_000; // Keep 48 hours for 1m/5m/15m route warmup

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

export function getPriceHistory(): Map<string, PricePoint[]> {
  return priceHistory;
}

export function loadPriceHistoryFrom(data: Map<string, { timestamp: number; price: number }[]>) {
  const cutoff = Date.now() - MAX_HISTORY_MS;
  for (const [mint, points] of data) {
    const incoming = points
      .filter(p => p.timestamp >= cutoff && p.price > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (incoming.length === 0) continue;

    const existing = priceHistory.get(mint) ?? [];
    const merged = [...existing, ...incoming].sort((a, b) => a.timestamp - b.timestamp);

    const deduped: PricePoint[] = [];
    for (const p of merged) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.timestamp === p.timestamp) {
        deduped[deduped.length - 1] = p;
      } else {
        deduped.push(p);
      }
    }

    const pruned = deduped.filter(p => p.timestamp >= cutoff);
    priceHistory.set(mint, pruned);
    log.info('Restored price history', { mint, points: pruned.length });
  }
}
