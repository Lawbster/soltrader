import { readFileSync } from 'fs';

// Load PIPPIN candles from last 4 days
const mint = 'Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump';
const base = `c:/Users/emile/dev/Venzen/venzen-finance/sol-trader/data/candles/${mint}/`;

function loadCsv(date) {
  try {
    const raw = readFileSync(base + date + '.csv', 'utf8');
    const lines = raw.trim().split('\n');
    const header = lines[0].split(',');
    const tsIdx = header.indexOf('timestamp');
    const closeIdx = header.indexOf('close');
    return lines.slice(1).map(l => {
      const cols = l.split(',');
      return { timestamp: Number(cols[tsIdx]), close: Number(cols[closeIdx]) };
    }).filter(c => c.timestamp > 0);
  } catch { return []; }
}

const allCandles = [
  ...loadCsv('2026-03-07'),
  ...loadCsv('2026-03-08'),
  ...loadCsv('2026-03-09'),
  ...loadCsv('2026-03-10'),
];

console.log('Total candles loaded:', allCandles.length);

// Compute regime at start of today (00:00 UTC 2026-03-10)
const todayStart = new Date('2026-03-10T00:00:00Z').getTime();
const window24h = 24 * 60 * 60_000;
const window48h = 48 * 60 * 60_000;
const window72h = 72 * 60 * 60_000;

function getReturn(candles, lastPrice, targetTs) {
  let best = null;
  for (const c of candles) {
    if (c.timestamp <= targetTs) best = c;
    else break;
  }
  if (!best || best.close === 0) return null;
  return ((lastPrice - best.close) / best.close) * 100;
}

// Show price history at key points
const checkPoints = [
  { label: 'now (19:30 UTC)', ts: new Date('2026-03-10T19:30:00Z').getTime() },
  { label: 'noon UTC', ts: new Date('2026-03-10T12:00:00Z').getTime() },
  { label: 'start of today', ts: todayStart },
  { label: '6h UTC', ts: new Date('2026-03-10T06:00:00Z').getTime() },
];

for (const cp of checkPoints) {
  const relevantCandles = allCandles.filter(c => c.timestamp <= cp.ts);
  if (relevantCandles.length === 0) continue;
  const lastCandle = relevantCandles[relevantCandles.length - 1];
  const lastPrice = lastCandle.close;

  const hourBuckets = new Set(allCandles.filter(c => c.timestamp >= cp.ts - window72h && c.timestamp <= cp.ts).map(c => Math.floor(c.timestamp / (60 * 60_000))));

  const ret24h = getReturn(relevantCandles, lastPrice, cp.ts - window24h);
  const ret48h = getReturn(relevantCandles, lastPrice, cp.ts - window48h);
  const ret72h = getReturn(relevantCandles, lastPrice, cp.ts - window72h);

  const weights = { r24: 0.5, r48: 0.3, r72: 0.2 };
  const parts = [];
  if (ret24h !== null) parts.push({ v: ret24h, w: weights.r24 });
  if (ret48h !== null) parts.push({ v: ret48h, w: weights.r48 });
  if (ret72h !== null) parts.push({ v: ret72h, w: weights.r72 });
  const wSum = parts.reduce((s, p) => s + p.w, 0);
  const score = parts.length > 0 ? parts.reduce((s, p) => s + p.v * p.w, 0) / wSum : null;

  const coverageHours = hourBuckets.size;
  let regime = 'sideways';
  if (score !== null && ret24h !== null) {
    if (score >= 8 && ret24h >= 3) regime = 'uptrend';
    else if (score <= -6 && ret24h <= -2) regime = 'downtrend';
  }

  console.log(`\n--- ${cp.label} ---`);
  console.log(`  Price: ${lastPrice.toFixed(5)}, coverage: ${coverageHours}h`);
  console.log(`  ret24h: ${ret24h?.toFixed(2)}%, ret48h: ${ret48h?.toFixed(2)}%, ret72h: ${ret72h?.toFixed(2)}%`);
  console.log(`  score: ${score?.toFixed(2)}, regime: ${regime}`);
}

// Show price at specific times for context
console.log('\n--- PIPPIN price at key times ---');
const keyTimes = [
  '2026-03-07T00:00:00Z', '2026-03-08T00:00:00Z', '2026-03-09T00:00:00Z',
  '2026-03-09T12:00:00Z', '2026-03-10T00:00:00Z', '2026-03-10T08:00:00Z',
  '2026-03-10T12:00:00Z', '2026-03-10T19:00:00Z'
];
for (const t of keyTimes) {
  const ts = new Date(t).getTime();
  const c = allCandles.filter(x => x.timestamp <= ts);
  if (c.length === 0) { console.log(`  ${t}: no data`); continue; }
  const last = c[c.length - 1];
  console.log(`  ${t}: ${last.close.toFixed(5)} (${new Date(last.timestamp).toISOString()})`);
}
