/**
 * route-breakdown.ts
 *
 * Reads closed positions from data/positions-*.json and prints a breakdown
 * by routeId: trade count, win rate, total PnL, avg PnL%, avg hold time.
 *
 * Positions files are cumulative snapshots, so filtering is always done by
 * the actual exit timestamp — not by which file the position appears in.
 *
 * Usage:
 *   npx tsx scripts/route-breakdown.ts              # all dates
 *   npx tsx scripts/route-breakdown.ts --date 2026-03-11   # exited on this date
 *   npx tsx scripts/route-breakdown.ts --since 2026-03-11  # exited on or after
 *   npx tsx scripts/route-breakdown.ts --days 2            # exited in last N calendar days
 *   npx tsx scripts/route-breakdown.ts --max-pct 20        # exclude trades with |pnlPct| > 20 (outliers/errors)
 */

import fs from 'fs';
import path from 'path';
import type { Position } from '../src/execution/types';

const DATA_DIR = path.resolve(__dirname, '../data');

const args = process.argv.slice(2);
function argVal(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const dateArg  = argVal('--date');
const sinceArg = argVal('--since');
const daysArg  = argVal('--days');
const maxPct   = argVal('--max-pct') ? parseFloat(argVal('--max-pct')!) : null;

function pad(s: string | number, w: number, right = false): string {
  const str = String(s);
  return right ? str.padEnd(w) : str.padStart(w);
}

/**
 * Loads all positions files (sorted), deduplicates by position id (last file
 * wins — latest snapshot is authoritative), then filters by exit timestamp.
 */
function loadPositions(): Position[] {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^positions-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // ascending → last file is most recent

  // Dedup: iterate all files; later files overwrite earlier for the same id.
  const byId = new Map<string, Position>();
  for (const file of files) {
    const full = path.join(DATA_DIR, file);
    try {
      const json = JSON.parse(fs.readFileSync(full, 'utf8')) as { closed?: Position[] };
      for (const pos of json.closed ?? []) {
        byId.set(pos.id, pos);
      }
    } catch {
      console.warn(`Failed to parse ${file}`);
    }
  }

  let positions = Array.from(byId.values());

  // Timestamp-based filtering using last exit timestamp
  if (dateArg || sinceArg || daysArg) {
    let fromMs: number | null = null;
    let toMs: number | null = null;

    if (dateArg) {
      fromMs = new Date(dateArg + 'T00:00:00Z').getTime();
      toMs   = new Date(dateArg + 'T23:59:59.999Z').getTime();
    } else if (sinceArg) {
      fromMs = new Date(sinceArg + 'T00:00:00Z').getTime();
    } else if (daysArg) {
      const n = parseInt(daysArg, 10);
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      fromMs = today.getTime() - (n - 1) * 86_400_000;
    }

    positions = positions.filter(pos => {
      const lastExit = pos.exits[pos.exits.length - 1];
      if (!lastExit) return false;
      const ts = lastExit.timestamp;
      if (fromMs !== null && ts < fromMs) return false;
      if (toMs   !== null && ts > toMs)   return false;
      return true;
    });
  }

  return positions;
}

function computePnl(pos: Position): { pnlUsdc: number; pnlPct: number; holdMins: number } {
  const received = pos.exits.reduce((sum, e) => sum + e.usdcReceived, 0);
  const pnlUsdc = received - pos.initialSizeUsdc;
  const pnlPct = pos.initialSizeUsdc > 0 ? (pnlUsdc / pos.initialSizeUsdc) * 100 : 0;
  const lastExit = pos.exits[pos.exits.length - 1];
  const holdMins = lastExit
    ? Math.round((lastExit.timestamp - pos.entryTime) / 60_000)
    : 0;
  return { pnlUsdc, pnlPct, holdMins };
}

interface RouteStats {
  routeId: string;
  token: string;
  tf: string;
  trades: number;
  wins: number;
  pnlUsdc: number;
  pnlPcts: number[];
  holdMins: number[];
}

function printTable(stats: RouteStats[], title: string) {
  console.log(`\n${'─'.repeat(110)}`);
  console.log(title);
  console.log('─'.repeat(110));
  console.log(
    pad('Route', 46, true) +
    pad('Token', 8, true) +
    pad('TF', 4, true) +
    pad('N', 5) +
    pad('WR%', 7) +
    pad('PnL USDC', 10) +
    pad('Avg%', 8) +
    pad('AvgHold', 9)
  );
  console.log('─'.repeat(110));

  for (const r of stats) {
    const wr = r.trades > 0 ? (r.wins / r.trades) * 100 : 0;
    const avgPct = r.pnlPcts.length > 0
      ? r.pnlPcts.reduce((a, b) => a + b, 0) / r.pnlPcts.length
      : 0;
    const avgHold = r.holdMins.length > 0
      ? Math.round(r.holdMins.reduce((a, b) => a + b, 0) / r.holdMins.length)
      : 0;

    const wrColor = wr >= 50 ? '\x1b[32m' : wr >= 40 ? '\x1b[33m' : '\x1b[31m';
    const pnlColor = r.pnlUsdc >= 0 ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    console.log(
      pad(r.routeId.slice(0, 45), 46, true) +
      pad(r.token.slice(0, 7), 8, true) +
      pad(r.tf, 4, true) +
      pad(r.trades, 5) +
      wrColor + pad(wr.toFixed(1), 7) + reset +
      pnlColor + pad(r.pnlUsdc.toFixed(3), 10) + reset +
      pad(avgPct.toFixed(2) + '%', 8) +
      pad(avgHold + 'm', 9)
    );
  }
  console.log('─'.repeat(110));
}

function run() {
  const positions = loadPositions();

  if (positions.length === 0) {
    console.log('No closed positions found.');
    return;
  }

  const byRoute = new Map<string, RouteStats>();
  const byToken = new Map<string, RouteStats>();
  const overall: RouteStats = {
    routeId: 'TOTAL', token: '--', tf: '--', trades: 0, wins: 0,
    pnlUsdc: 0, pnlPcts: [], holdMins: [],
  };

  let excluded = 0;
  for (const pos of positions) {
    const routeId = pos.strategyPlan?.routeId ?? 'unknown';
    const token = pos.mint.slice(0, 6);
    const tf = pos.strategyPlan?.timeframeMinutes ? pos.strategyPlan.timeframeMinutes + 'm' : '--';
    const { pnlUsdc, pnlPct, holdMins } = computePnl(pos);

    if (maxPct !== null && Math.abs(pnlPct) > maxPct) { excluded++; continue; }

    const isWin = pnlUsdc > 0;

    // By route
    if (!byRoute.has(routeId)) {
      byRoute.set(routeId, { routeId, token, tf, trades: 0, wins: 0, pnlUsdc: 0, pnlPcts: [], holdMins: [] });
    }
    const r = byRoute.get(routeId)!;
    r.trades++;
    if (isWin) r.wins++;
    r.pnlUsdc += pnlUsdc;
    r.pnlPcts.push(pnlPct);
    r.holdMins.push(holdMins);

    // By token
    const mintKey = pos.mint;
    if (!byToken.has(mintKey)) {
      byToken.set(mintKey, { routeId: pos.mint, token, tf: 'all', trades: 0, wins: 0, pnlUsdc: 0, pnlPcts: [], holdMins: [] });
    }
    const t = byToken.get(mintKey)!;
    t.trades++;
    if (isWin) t.wins++;
    t.pnlUsdc += pnlUsdc;
    t.pnlPcts.push(pnlPct);
    t.holdMins.push(holdMins);

    // Overall
    overall.trades++;
    if (isWin) overall.wins++;
    overall.pnlUsdc += pnlUsdc;
    overall.pnlPcts.push(pnlPct);
    overall.holdMins.push(holdMins);
  }

  const routeStats = Array.from(byRoute.values()).sort((a, b) => b.pnlUsdc - a.pnlUsdc);
  const tokenStats = Array.from(byToken.values()).sort((a, b) => b.pnlUsdc - a.pnlUsdc);

  const label = dateArg ? `date=${dateArg}` : sinceArg ? `since=${sinceArg}` : daysArg ? `last ${daysArg} days` : 'all dates';
  const excludedNote = excluded > 0 ? ` (${excluded} excluded >|${maxPct}%|)` : '';
  console.log(`\nRoute breakdown — ${label} — ${positions.length - excluded} closed positions${excludedNote}`);

  printTable(routeStats, 'BY ROUTE (sorted by PnL)');
  printTable(tokenStats, 'BY TOKEN');

  // Summary line
  const wr = overall.trades > 0 ? (overall.wins / overall.trades) * 100 : 0;
  const avgPct = overall.pnlPcts.length > 0
    ? overall.pnlPcts.reduce((a, b) => a + b, 0) / overall.pnlPcts.length
    : 0;
  const avgHold = overall.holdMins.length > 0
    ? Math.round(overall.holdMins.reduce((a, b) => a + b, 0) / overall.holdMins.length)
    : 0;
  console.log(`\nTOTAL  ${overall.trades} trades  WR ${wr.toFixed(1)}%  PnL ${overall.pnlUsdc.toFixed(3)} USDC  Avg ${avgPct.toFixed(2)}%  AvgHold ${avgHold}m`);
}

run();
