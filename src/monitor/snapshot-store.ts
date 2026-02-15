import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils';
import { TokenLaunch, TokenSnapshot } from './types';

const log = createLogger('snapshots');
const DATA_DIR = path.resolve(__dirname, '../../data');

// In-memory tracking of tokens we're watching
const watchedTokens = new Map<string, { launch: TokenLaunch; snapshots: TokenSnapshot[] }>();

// Round-robin offset for batched snapshotting
let snapshotOffset = 0;
const MAX_SNAPSHOTS_PER_CYCLE = 3;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function trackToken(launch: TokenLaunch) {
  if (!launch.mint) return;
  if (watchedTokens.has(launch.mint)) return;

  watchedTokens.set(launch.mint, { launch, snapshots: [] });
  log.info('Now tracking token', { mint: launch.mint, source: launch.source });
}

export async function takeSnapshot(mint: string): Promise<TokenSnapshot | null> {
  const now = Date.now();

  try {
    const snapshot: TokenSnapshot = {
      mint,
      timestamp: now,
    };

    // Holder data disabled for large-cap watchlist tokens — no RPC needed
    snapshot.holders = 0;
    snapshot.topHolderPct = 0;

    // Store the snapshot
    const entry = watchedTokens.get(mint);
    if (entry) {
      entry.snapshots.push(snapshot);
    }

    log.debug('Snapshot taken', { mint, topHolderPct: snapshot.topHolderPct });
    return snapshot;
  } catch (err) {
    log.error('Failed to take snapshot', { mint, error: err });
    return null;
  }
}

export async function snapshotAll() {
  const mints = Array.from(watchedTokens.keys());
  if (mints.length === 0) return;

  const batch: string[] = [];
  for (let i = 0; i < Math.min(MAX_SNAPSHOTS_PER_CYCLE, mints.length); i++) {
    const idx = (snapshotOffset + i) % mints.length;
    batch.push(mints[idx]);
  }
  snapshotOffset = (snapshotOffset + MAX_SNAPSHOTS_PER_CYCLE) % Math.max(mints.length, 1);

  log.debug(`Snapshotting ${batch.length}/${mints.length} tracked tokens`);

  for (const mint of batch) {
    await takeSnapshot(mint);
    await new Promise(r => setTimeout(r, 1000));
  }
}

/** Remove a token from tracking */
export function untrackToken(mint: string) {
  watchedTokens.delete(mint);
}

/** Remove tokens older than maxAgeMs. Returns number of pruned tokens. */
export function pruneOldTokens(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [mint, data] of watchedTokens) {
    if (data.launch.source === 'watchlist') continue;
    if (data.launch.detectedAt < cutoff) {
      watchedTokens.delete(mint);
      pruned++;
    }
  }
  return pruned;
}

export function saveSnapshots() {
  ensureDataDir();

  const allData: Record<string, { launch: TokenLaunch; snapshots: TokenSnapshot[] }> = {};
  for (const [mint, data] of watchedTokens) {
    allData[mint] = data;
  }

  const filePath = path.join(DATA_DIR, `snapshots-${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(filePath, JSON.stringify(allData, null, 2));
  log.info('Snapshots saved', { path: filePath, tokens: watchedTokens.size });
}

export function loadSnapshots(date?: string): Record<string, { launch: TokenLaunch; snapshots: TokenSnapshot[] }> {
  const d = date || new Date().toISOString().split('T')[0];
  const filePath = path.join(DATA_DIR, `snapshots-${d}.json`);

  if (!fs.existsSync(filePath)) {
    log.warn('No snapshot file found', { path: filePath });
    return {};
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function getTrackedTokens(): Map<string, { launch: TokenLaunch; snapshots: TokenSnapshot[] }> {
  return watchedTokens;
}

export function getStats() {
  return {
    trackedTokens: watchedTokens.size,
    totalSnapshots: Array.from(watchedTokens.values()).reduce((sum, t) => sum + t.snapshots.length, 0),
    sources: {
      pumpfun: Array.from(watchedTokens.values()).filter(t => t.launch.source === 'pumpfun').length,
      raydium: Array.from(watchedTokens.values()).filter(t => t.launch.source === 'raydium').length,
      watchlist: Array.from(watchedTokens.values()).filter(t => t.launch.source === 'watchlist').length,
    },
  };
}
