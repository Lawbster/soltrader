import fs from 'fs';
import path from 'path';
import { config, createLogger } from '../utils';

const log = createLogger('watchlist');
const DEFAULT_PATH = path.resolve(__dirname, '../../config/watchlist.json');

export interface WatchlistEntry {
  mint: string;
  pool?: string;
  label?: string;
}

function parseMints(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isValidMint(mint: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
}

export function loadWatchlist(filePath = DEFAULT_PATH): WatchlistEntry[] {
  const entries = new Map<string, WatchlistEntry>();

  // From env
  if (config.universe.watchlistMints) {
    for (const mint of parseMints(config.universe.watchlistMints)) {
      if (isValidMint(mint)) {
        entries.set(mint, { mint });
      } else {
        log.warn('Ignoring invalid mint from WATCHLIST_MINTS', { mint });
      }
    }
  }

  // From file
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'string') {
            if (isValidMint(item)) {
              entries.set(item, { mint: item });
            } else {
              log.warn('Ignoring invalid mint from watchlist file', { mint: item });
            }
            continue;
          }

          if (item && typeof item === 'object') {
            const mint = typeof item.mint === 'string' ? item.mint : '';
            const pool = typeof item.pool === 'string' ? item.pool : undefined;
            if (!isValidMint(mint)) {
              log.warn('Ignoring invalid watchlist entry (mint)', { entry: item });
              continue;
            }
            if (pool && !isValidMint(pool)) {
              log.warn('Ignoring invalid watchlist entry (pool)', { entry: item });
              continue;
            }
            const label = typeof item.label === 'string' ? item.label : undefined;
            entries.set(mint, { mint, pool, label });
          }
        }
      } else {
        log.warn('Watchlist file must be a JSON array of mint strings', { path: filePath });
      }
    } catch (err) {
      log.warn('Failed to read watchlist file', { path: filePath, error: err });
    }
  }

  return Array.from(entries.values());
}
