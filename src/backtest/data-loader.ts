import fs from 'fs';
import path from 'path';
import { Candle, PricePoint, TokenDataset } from './types';

const DATA_ROOT = path.resolve(__dirname, '../../data/data');
const WATCHLIST_PATH = path.resolve(__dirname, '../../config/watchlist.json');

interface WatchlistEntry {
  mint: string;
  pool: string;
  label: string;
  disabled?: boolean;
}

export function loadTokenList(): WatchlistEntry[] {
  const raw = fs.readFileSync(WATCHLIST_PATH, 'utf-8');
  const all = JSON.parse(raw) as WatchlistEntry[];
  return all.filter(t => !t.disabled);
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
      try {
        points.push(JSON.parse(line) as PricePoint);
      } catch {
        // Skip malformed JSONL lines
      }
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
      const parts = line.split(',');
      if (parts.length < 6) continue;
      const [timestamp, open, high, low, close, pricePoints] = parts;
      const ts = Number(timestamp);
      const o = Number(open);
      const h = Number(high);
      const l = Number(low);
      const c = Number(close);
      const pp = Number(pricePoints);
      if (isNaN(ts) || isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
      candles.push({
        timestamp: ts, open: o, high: h, low: l, close: c,
        pricePoints: isNaN(pp) ? 0 : pp,
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
