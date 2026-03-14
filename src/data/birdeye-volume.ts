/**
 * Birdeye OHLCV volume fetcher.
 *
 * Fetches real USD trade volume for a Solana token mint from the Birdeye
 * /defi/ohlcv endpoint and returns a timestamp→volume map.
 *
 * Candle open times from Birdeye are UTC-minute-aligned (unixTime seconds).
 * Our candle timestamps are also minute-aligned milliseconds. The map is
 * keyed by unixTime * 1000 to match the candle CSV format.
 *
 * Results are cached per (mint, date) for 60 minutes to stay within the
 * Birdeye free tier (30,000 CU/month @ ~5 CU/call).
 */

import { createLogger } from '../utils';

const log = createLogger('birdeye-volume');
const API_KEY = process.env.BIRDEYE_API_KEY ?? '';
const BASE = 'https://public-api.birdeye.so/defi/ohlcv';

interface BirdeyeCandle {
  unixTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface CacheEntry {
  fetchedAt: number;
  data: Map<number, number>;
}

// Cache key: `${mint}:${dateStr}:${type}`
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60_000; // 60 minutes

export async function fetchBirdeyeVolume(
  mint: string,
  type: '1m' | '5m' | '15m',
  from: number, // unix seconds
  to: number,   // unix seconds
): Promise<Map<number, number>> {
  if (!API_KEY) {
    log.warn('BIRDEYE_API_KEY not set — skipping volume fetch');
    return new Map();
  }

  const dateStr = new Date(from * 1000).toISOString().split('T')[0];
  const cacheKey = `${mint}:${dateStr}:${type}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `${BASE}?address=${mint}&type=${type}&time_from=${from}&time_to=${to}`;
  let items: BirdeyeCandle[] = [];

  try {
    const res = await fetch(url, {
      headers: { 'X-API-KEY': API_KEY },
    });
    if (!res.ok) {
      log.warn('Birdeye OHLCV fetch failed', { mint, status: res.status });
      return cached?.data ?? new Map();
    }
    const json = await res.json() as { success: boolean; data?: { items?: BirdeyeCandle[] } };
    items = json?.data?.items ?? [];
  } catch (err) {
    log.warn('Birdeye OHLCV fetch error', { mint, err: String(err) });
    return cached?.data ?? new Map();
  }

  const volumeMap = new Map<number, number>();
  for (const item of items) {
    // Key by milliseconds to match candle CSV timestamps
    volumeMap.set(item.unixTime * 1000, item.v);
  }

  cache.set(cacheKey, { fetchedAt: Date.now(), data: volumeMap });
  log.debug('Birdeye volume fetched', { mint, type, candles: volumeMap.size });
  return volumeMap;
}
