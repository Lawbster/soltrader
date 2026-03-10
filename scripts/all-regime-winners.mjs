/**
 * all-regime-winners.mjs
 * Finds templates that perform well across ALL regime conditions (uptrend + sideways + downtrend).
 * Uses the raw sweep CSV (not the regime-bucketed candidates).
 *
 * Usage: node scripts/all-regime-winners.mjs --file data/sweep-results/2026-03-10-1min.csv [--min-trades 8] [--min-wr 0.55] [--top 20]
 */

import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};

const file = getArg('--file', null);
if (!file) { console.error('--file required'); process.exit(1); }

const minTrades = Number(getArg('--min-trades', 8));
const minWr = Number(getArg('--min-wr', 0.55));
const minPnl = Number(getArg('--min-pnl', 5));
const top = Number(getArg('--top', 30));

// Parse CSV
const raw = readFileSync(file, 'utf8').trim().split('\n');
const header = raw[0].split(',');
const col = name => header.indexOf(name);

const rows = raw.slice(1).map(line => {
  // Handle quoted fields
  const cols = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur);
  return cols;
});

const get = (row, name) => row[col(name)] ?? '';
const getN = (row, name) => parseFloat(get(row, name)) || 0;

// Group by token + template + params (ignore timeframe variant)
// Key: token|template|params
const groups = new Map();

for (const row of rows) {
  const template = get(row, 'template');
  const token = get(row, 'token');
  const params = get(row, 'params');
  const trades = getN(row, 'trades');
  const wr = getN(row, 'winRate') / 100;
  const pnl = getN(row, 'pnlPct');
  const pf = getN(row, 'profitFactor');
  const avgHold = getN(row, 'avgHoldMinutes');
  const regime = get(row, 'entryTrendRegime') || get(row, 'trendRegime') || 'unknown';

  if (trades < minTrades) continue;
  if (wr < minWr) continue;
  if (pnl < minPnl) continue;

  const key = `${token}|${template}|${params}`;
  if (!groups.has(key)) groups.set(key, { token, template, params, regimes: {} });
  const g = groups.get(key);

  if (!g.regimes[regime]) g.regimes[regime] = { trades: 0, pnl: 0, wr: 0, pf: 0, hold: 0, count: 0 };
  const r = g.regimes[regime];
  r.trades += trades;
  r.pnl += pnl;
  r.wr += wr;
  r.pf += pf;
  r.hold += avgHold;
  r.count++;
}

// Compute per-group averages
const results = [];
for (const [key, g] of groups.entries()) {
  const regimeKeys = Object.keys(g.regimes);
  const regimeCount = regimeKeys.length; // how many distinct regimes this combo works in

  // Aggregate across all regimes
  let totalTrades = 0, totalPnl = 0, totalWr = 0, totalPf = 0, totalHold = 0, rowCount = 0;
  for (const r of Object.values(g.regimes)) {
    totalTrades += r.trades;
    totalPnl += r.pnl;
    totalWr += r.wr;
    totalPf += r.pf;
    totalHold += r.hold;
    rowCount += r.count;
  }

  const avgWr = totalWr / rowCount;
  const avgPnl = totalPnl / rowCount;
  const avgPf = totalPf / rowCount;
  const avgHold = totalHold / rowCount;

  results.push({
    token: g.token,
    template: g.template,
    params: g.params,
    regimeCount,
    regimes: regimeKeys.join('+'),
    totalTrades,
    avgWr: avgWr * 100,
    avgPnl,
    avgPf,
    avgHold,
    // Score: reward templates that work in multiple regimes
    allRegimeScore: avgPnl * regimeCount * Math.min(avgPf, 5),
  });
}

// Sort by allRegimeScore descending
results.sort((a, b) => b.allRegimeScore - a.allRegimeScore);

// Print
console.log(`\n=== ALL-REGIME WINNERS (min ${minTrades} trades, WR>=${(minWr*100).toFixed(0)}%, PnL>=${minPnl}% per regime) ===`);
console.log(`File: ${file}\n`);

// Separate: works in all 3 vs 2 vs 1
const all3 = results.filter(r => r.regimeCount >= 3).slice(0, top);
const any2 = results.filter(r => r.regimeCount === 2).slice(0, top);

console.log(`\n--- Works in ALL 3 regimes (${all3.length} found) ---`);
if (all3.length === 0) {
  console.log('  (none meet criteria across all 3 regimes)');
} else {
  console.log('Token         Template                      Params                               Regimes            Trades  WR%    PnL%   PF    Hold');
  for (const r of all3) {
    console.log(
      r.token.padEnd(14) +
      r.template.padEnd(30) +
      r.params.substring(0, 36).padEnd(37) +
      r.regimes.padEnd(20) +
      String(r.totalTrades).padEnd(8) +
      r.avgWr.toFixed(0).padStart(4) + '%  ' +
      r.avgPnl.toFixed(1).padStart(6) + '  ' +
      r.avgPf.toFixed(2).padStart(5) + '  ' +
      r.avgHold.toFixed(0) + 'm'
    );
  }
}

console.log(`\n--- Works in 2 regimes (top ${Math.min(any2.length, 20)}) ---`);
if (any2.length === 0) {
  console.log('  (none meet criteria across 2 regimes)');
} else {
  console.log('Token         Template                      Params                               Regimes            Trades  WR%    PnL%   PF    Hold');
  for (const r of any2.slice(0, 20)) {
    console.log(
      r.token.padEnd(14) +
      r.template.padEnd(30) +
      r.params.substring(0, 36).padEnd(37) +
      r.regimes.padEnd(20) +
      String(r.totalTrades).padEnd(8) +
      r.avgWr.toFixed(0).padStart(4) + '%  ' +
      r.avgPnl.toFixed(1).padStart(6) + '  ' +
      r.avgPf.toFixed(2).padStart(5) + '  ' +
      r.avgHold.toFixed(0) + 'm'
    );
  }
}
