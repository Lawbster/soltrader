import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('c:/Users/emile/dev/Venzen/venzen-finance/sol-trader/data/positions-2026-03-10.json', 'utf8'));
const closed = data.closed;

const pippin = closed.filter(p => p.mint && p.mint.startsWith('Dfh5'));
console.log('Total closed:', closed.length);
console.log('PIPPIN closed:', pippin.length);

// By routeId
const byRoute = {};
pippin.forEach(p => {
  const route = p.strategyPlan?.routeId || 'unknown';
  const pnl = p.exits.reduce((s, e) => s + (e.usdcReceived || 0), 0) - p.initialSizeUsdc;
  if (byRoute[route] === undefined) byRoute[route] = { count: 0, pnl: 0, wins: 0 };
  byRoute[route].count++;
  byRoute[route].pnl += pnl;
  if (pnl > 0) byRoute[route].wins++;
});

console.log('\nPIPPIN by route:');
for (const r of Object.keys(byRoute)) {
  const v = byRoute[r];
  console.log(`  ${r}: ${v.count} trades, wins=${v.wins}, wr=${(v.wins/v.count*100).toFixed(0)}%, pnl=${v.pnl.toFixed(2)}`);
}

// By closeReason
const byReason = {};
pippin.forEach(p => {
  const reason = p.closeReason || 'unknown';
  const pnl = p.exits.reduce((s, e) => s + (e.usdcReceived || 0), 0) - p.initialSizeUsdc;
  if (byReason[reason] === undefined) byReason[reason] = { count: 0, pnl: 0 };
  byReason[reason].count++;
  byReason[reason].pnl += pnl;
});

console.log('\nPIPPIN by closeReason:');
for (const r of Object.keys(byReason)) {
  const v = byReason[r];
  console.log(`  ${r}: ${v.count} trades, pnl=${v.pnl.toFixed(2)}`);
}

// Time range
const times = pippin.map(p => p.entryTime).sort((a, b) => a - b);
console.log('\nEntry range:', new Date(times[0]).toISOString(), '->', new Date(times[times.length - 1]).toISOString());

// Sample of exits
console.log('\nFirst 5 PIPPIN exits:');
pippin.slice(0, 5).forEach(p => {
  const pnl = p.exits.reduce((s, e) => s + (e.usdcReceived || 0), 0) - p.initialSizeUsdc;
  const holdMs = p.exits[p.exits.length - 1]?.timestamp - p.entryTime;
  console.log(JSON.stringify({
    route: p.strategyPlan?.routeId,
    pnlUsd: pnl.toFixed(3),
    closeReason: p.closeReason,
    holdSec: holdMs ? (holdMs / 1000).toFixed(0) : '?',
    exitTypes: p.exits.map(e => e.type),
    tp1Hit: p.tp1Hit,
    stopMoved: p.stopMovedToBreakeven,
    entryPrice: p.entryPrice,
    exitPrice: p.exits[p.exits.length - 1]?.price,
  }));
});

// Check for very short holds (possible rapid fire)
const shortHolds = pippin.filter(p => {
  const holdMs = (p.exits[p.exits.length - 1]?.timestamp || 0) - p.entryTime;
  return holdMs < 60000; // < 1 minute
});
console.log('\nHolds < 1 min:', shortHolds.length);

const medHolds = pippin.filter(p => {
  const holdMs = (p.exits[p.exits.length - 1]?.timestamp || 0) - p.entryTime;
  return holdMs >= 60000 && holdMs < 300000;
});
console.log('Holds 1-5 min:', medHolds.length);
