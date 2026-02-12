import fs from 'fs';
import path from 'path';
import { config, createLogger } from '../utils';

const log = createLogger('watchlist');
const DEFAULT_PATH = path.resolve(__dirname, '../../config/watchlist.json');

function parseMints(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isValidMint(mint: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
}

export function loadWatchlist(filePath = DEFAULT_PATH): string[] {
  const mints = new Set<string>();

  // From env
  if (config.universe.watchlistMints) {
    for (const mint of parseMints(config.universe.watchlistMints)) {
      if (isValidMint(mint)) {
        mints.add(mint);
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
        for (const mint of list) {
          if (typeof mint === 'string' && isValidMint(mint)) {
            mints.add(mint);
          } else if (typeof mint === 'string') {
            log.warn('Ignoring invalid mint from watchlist file', { mint });
          }
        }
      } else {
        log.warn('Watchlist file must be a JSON array of mint strings', { path: filePath });
      }
    } catch (err) {
      log.warn('Failed to read watchlist file', { path: filePath, error: err });
    }
  }

  return Array.from(mints);
}
