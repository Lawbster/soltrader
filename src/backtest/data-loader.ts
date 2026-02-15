import fs from 'fs';
import path from 'path';
import { Candle, PricePoint, TokenDataset } from './types';

const DATA_ROOT = path.resolve(__dirname, '../../data/data');
const WATCHLIST_PATH = path.resolve(__dirname, '../../config/watchlist.json');

interface WatchlistEntry {
  mint: string;
  pool: string;
  label: string;
}

export function loadTokenList(): WatchlistEntry[] {
  const raw = fs.readFileSync(WATCHLIST_PATH, 'utf-8');
  return JSON.parse(raw) as WatchlistEntry[];
}

export function loadPrices(mint: string): PricePoint[] {
  const dir = path.join(DATA_ROOT, 'prices', mint);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  const points: PricePoint[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      points.push(JSON.parse(line) as PricePoint);
    }
  }

  return points.sort((a, b) => a.ts - b.ts);
}

export function loadCandles(mint: string): Candle[] {
  const dir = path.join(DATA_ROOT, 'candles', mint);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.csv'))
    .sort();

  const candles: Candle[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const lines = content.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const [timestamp, open, high, low, close, pricePoints] = line.split(',');
      candles.push({
        timestamp: Number(timestamp),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        pricePoints: Number(pricePoints),
      });
    }
  }

  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

export function loadTokenDataset(mint: string, label: string): TokenDataset {
  return {
    mint,
    label,
    candles: loadCandles(mint),
    prices: loadPrices(mint),
  };
}

export function loadAllDatasets(): TokenDataset[] {
  const tokens = loadTokenList();
  return tokens.map(t => loadTokenDataset(t.mint, t.label));
}

export function closeSeries(candles: Candle[]): number[] {
  return candles.map(c => c.close);
}

export function highSeries(candles: Candle[]): number[] {
  return candles.map(c => c.high);
}

export function lowSeries(candles: Candle[]): number[] {
  return candles.map(c => c.low);
}

export function volumeSeries(candles: Candle[]): number[] {
  return candles.map(c => c.pricePoints);
}
