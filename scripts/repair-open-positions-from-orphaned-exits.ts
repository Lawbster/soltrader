import fs from 'fs';
import path from 'path';
import type { Position, PositionExit } from '../src/execution/types';
import { allocateTrackedExitSlices } from '../src/execution/position-accounting';
import { calculateTrackedPnlUsdc } from '../src/execution/position-accounting';

type PositionFile = {
  savedAt?: string;
  open?: Position[];
  closed?: Position[];
  stats?: {
    totalTrades?: number;
    wins?: number;
    dailyPnlUsdc?: number;
    consecutiveLosses?: number;
    lastLossTime?: number;
  };
};

type OrphanedSlice = {
  sourcePositionId: string;
  mint: string;
  exit: PositionExit;
  orphanedTokens: number;
  orphanedUsdc: number;
};

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DRY_RUN = process.argv.includes('--dry-run');

function loadPositionFiles() {
  return fs.readdirSync(DATA_DIR)
    .filter(name => /^positions-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .map((name) => {
      const fullPath = path.join(DATA_DIR, name);
      const json = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as PositionFile;
      return { name, fullPath, json };
    });
}

function clonePosition<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function positionDateFromEntry(position: Position): string {
  return new Date(position.entryTime).toISOString().split('T')[0];
}

function toLatestPositionMaps(files: ReturnType<typeof loadPositionFiles>) {
  const latestOpen = new Map<string, Position>();
  const latestClosed = new Map<string, Position>();

  for (const file of files) {
    for (const position of file.json.open ?? []) {
      latestOpen.set(position.id, clonePosition(position));
    }
    for (const position of file.json.closed ?? []) {
      latestClosed.set(position.id, clonePosition(position));
    }
  }

  return { latestOpen, latestClosed };
}

function buildOrphanedSlices(positions: Iterable<Position>): OrphanedSlice[] {
  const slices: OrphanedSlice[] = [];
  for (const position of positions) {
    const allocations = allocateTrackedExitSlices(position);
    for (const allocation of allocations) {
      if (allocation.orphanedTokens <= 0 || allocation.orphanedUsdc <= 0) continue;
      const sourceExit = position.exits[allocation.exitIndex];
      if (!sourceExit || sourceExit.tokensSold <= 0 || sourceExit.usdcReceived <= 0) continue;
      slices.push({
        sourcePositionId: position.id,
        mint: position.mint,
        exit: sourceExit,
        orphanedTokens: allocation.orphanedTokens,
        orphanedUsdc: allocation.orphanedUsdc,
      });
    }
  }
  return slices.sort((a, b) => a.exit.timestamp - b.exit.timestamp);
}

function almostEqual(a: number, b: number): boolean {
  const tolerance = Math.max(1e-6, Math.max(Math.abs(a), Math.abs(b)) * 1e-6);
  return Math.abs(a - b) <= tolerance;
}

function buildRecoveredPosition(position: Position, match: OrphanedSlice): Position {
  const recoveredExit: PositionExit = {
    type: match.exit.type,
    sellPct: 100,
    tokensSold: match.orphanedTokens,
    usdcReceived: match.orphanedUsdc,
    price: match.exit.price,
    signature: match.exit.signature,
    timestamp: match.exit.timestamp,
  };
  const pnlPct = position.initialSizeUsdc > 0
    ? ((match.orphanedUsdc - position.initialSizeUsdc) / position.initialSizeUsdc) * 100
    : 0;

  return {
    ...clonePosition(position),
    remainingTokens: 0,
    remainingUsdc: 0,
    remainingPct: 0,
    currentPrice: recoveredExit.price,
    currentPnlPct: pnlPct,
    exits: [recoveredExit],
    status: 'closed',
    closeReason: `Recovered orphaned sell: ${match.exit.type}`,
  };
}

function getPositionExitTime(position: Position): number {
  const lastExit = position.exits[position.exits.length - 1];
  return lastExit?.timestamp ?? position.entryTime;
}

function recomputeFileStats(file: PositionFile) {
  const closed = (file.closed ?? []).slice().sort((a, b) => getPositionExitTime(a) - getPositionExitTime(b));
  const totalTrades = closed.length;
  const wins = closed.filter(position => calculateTrackedPnlUsdc(position) > 0).length;
  const dailyPnlUsdc = closed.reduce((sum, position) => sum + calculateTrackedPnlUsdc(position), 0);

  let consecutiveLosses = 0;
  let lastLossTime = 0;
  for (const position of closed) {
    const pnl = calculateTrackedPnlUsdc(position);
    const exitTime = getPositionExitTime(position);
    if (pnl < 0) {
      consecutiveLosses += 1;
      lastLossTime = exitTime;
    } else {
      consecutiveLosses = 0;
    }
  }

  file.stats = {
    totalTrades,
    wins,
    dailyPnlUsdc,
    consecutiveLosses,
    lastLossTime,
  };
}

function main() {
  const files = loadPositionFiles();
  const { latestOpen, latestClosed } = toLatestPositionMaps(files);
  const orphanedSlices = buildOrphanedSlices(latestClosed.values());
  const usedSliceKeys = new Set<string>();

  let repairedOpenPositions = 0;
  let updatedFiles = 0;

  for (const openPosition of latestOpen.values()) {
    const successfulExits = (openPosition.exits ?? []).filter(exit => exit.tokensSold > 0 || exit.usdcReceived > 0);
    const hasOnlyFailedExits = (openPosition.exits?.length ?? 0) > 0 && successfulExits.length === 0;
    if ((openPosition.status ?? 'open') !== 'open') continue;
    if (!hasOnlyFailedExits) continue;
    if ((openPosition.remainingTokens ?? 0) <= 0) continue;

    const match = orphanedSlices.find((slice) => {
      if (slice.mint !== openPosition.mint) return false;
      if (slice.exit.timestamp < openPosition.entryTime) return false;
      if (!almostEqual(slice.orphanedTokens, openPosition.initialTokens)) return false;
      const key = `${slice.sourcePositionId}:${slice.exit.timestamp}:${slice.orphanedTokens}:${slice.orphanedUsdc}`;
      return !usedSliceKeys.has(key);
    });

    if (!match) continue;

    const repairedPosition = buildRecoveredPosition(openPosition, match);
    const matchKey = `${match.sourcePositionId}:${match.exit.timestamp}:${match.orphanedTokens}:${match.orphanedUsdc}`;
    usedSliceKeys.add(matchKey);
    repairedOpenPositions++;

    const entryDate = positionDateFromEntry(openPosition);
    for (const file of files) {
      const hadOpen = (file.json.open ?? []).some(position => position.id === openPosition.id);
      const fileDate = file.name.replace(/^positions-/, '').replace(/\.json$/, '');
      if (!hadOpen && fileDate < entryDate) continue;

      const nextOpen = (file.json.open ?? []).filter(position => position.id !== openPosition.id);
      const nextClosed = (file.json.closed ?? []).filter(position => position.id !== openPosition.id);

      if (hadOpen || fileDate >= entryDate) {
        nextClosed.push(clonePosition(repairedPosition));
      }

      const changed = hadOpen || (file.json.closed ?? []).some(position => position.id === openPosition.id) || fileDate >= entryDate;
      if (!changed) continue;

      file.json.open = nextOpen;
      file.json.closed = nextClosed;
      updatedFiles++;
    }
  }

  if (!DRY_RUN) {
    for (const file of files) {
      recomputeFileStats(file.json);
      fs.writeFileSync(file.fullPath, JSON.stringify(file.json, null, 2));
    }
  }

  console.log(JSON.stringify({
    dryRun: DRY_RUN,
    filesScanned: files.length,
    repairedOpenPositions,
    updatedFiles,
  }, null, 2));
}

main();
