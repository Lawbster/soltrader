import fs from 'fs';
import path from 'path';
import { getConnection, createLogger } from '../utils';
import { TokenLaunch, TokenSnapshot } from './types';

const log = createLogger('snapshots');
const DATA_DIR = path.resolve(__dirname, '../../data');

// In-memory tracking of tokens we're watching
const watchedTokens = new Map<string, { launch: TokenLaunch; snapshots: TokenSnapshot[] }>();

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
  const conn = getConnection();
  const now = Date.now();

  try {
    const snapshot: TokenSnapshot = {
      mint,
      timestamp: now,
    };

    // Get token supply
    const mintPubkey = await import('@solana/web3.js').then(m => new m.PublicKey(mint));
    const supplyInfo = await conn.getTokenSupply(mintPubkey);

    // Get largest token accounts (top holders)
    const largestAccounts = await conn.getTokenLargestAccounts(mintPubkey);
    if (largestAccounts.value.length > 0 && supplyInfo.value.uiAmount) {
      const topHolder = largestAccounts.value[0];
      const topHolderAmount = topHolder.uiAmount || 0;
      snapshot.topHolderPct = (topHolderAmount / supplyInfo.value.uiAmount) * 100;
      snapshot.holders = largestAccounts.value.length; // Approximation from top 20
    }

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
  log.info(`Taking snapshots for ${mints.length} tracked tokens`);

  for (const mint of mints) {
    await takeSnapshot(mint);
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }
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
    },
  };
}
