/**
 * build-live-map.ts
 *
 * Reads a ranked candidate CSV (output from sweep-candidates core-ranked.csv) and emits
 * a live-strategy-map patch proposal. The patch is printed to stdout as JSON and requires
 * human review before being applied to config/live-strategy-map.v1.json.
 *
 * Usage:
 *   npm run build-live-map -- --file data/data/sweep-results/candidates/2026-02-25-1min.core-ranked.csv
 *   npm run build-live-map -- --file <path> [--min-trades 12] [--min-awr 65] [--min-pf 1.2]
 *                                            [--min-parity-delta -10] [--max-hold 600]
 *
 * Output:
 *   - Console: promotion table + rejection log
 *   - Stdout: JSON patch for live-strategy-map.v1.json (all entries start with enabled: false)
 *
 * Design notes:
 * - Standalone script — no imports from src/ to avoid pulling in the live bot dependency chain.
 * - SUPPORTED_TEMPLATES is a hardcoded set. Last synced: PR5 (2026-02-25).
 *   When adding a new template to catalog.ts, also add it here.
 * - All patch entries use exitMode: 'price'. Rows with parityDelta < 0 are flagged in the
 *   console. Review manually before considering indicator mode.
 * - Input CSV is assumed to be pre-sorted by rank descending (sweep-candidates output order).
 *   The first row per token/regime that passes all filters is promoted.
 * - null parityDelta = parity filter not applied (not a rejection).
 */

import fs from 'fs';
import path from 'path';

// ── Supported template IDs ────────────────────────────────────────────────────
// Hardcoded to avoid importing src/. Update when catalog.ts gains new templates.
// Last synced: PR5 (2026-02-25)
const SUPPORTED_TEMPLATES = new Set([
  'rsi', 'crsi',
  'bb-rsi', 'rsi-crsi-confluence', 'crsi-dip-recover',
  'trend-pullback-rsi', 'vwap-rsi-reclaim',
  'bb-rsi-crsi-reversal', 'rsi-crsi-midpoint-exit',
  'adx-range-rsi-bb', 'adx-trend-rsi-pullback',
  'macd-zero-rsi-confirm', 'macd-signal-obv-confirm',
  'bb-squeeze-breakout', 'vwap-trend-pullback', 'vwap-rsi-range-revert',
  'connors-sma50-pullback', 'rsi2-micro-range', 'atr-breakout-follow',
  'rsi-session-gate', 'crsi-session-gate',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

type TrendRegime = 'uptrend' | 'sideways' | 'downtrend' | 'unknown';

interface RankedRow {
  token: string;
  template: string;
  params: string;
  trendRegime: TrendRegime;
  trades: number;
  adjustedWinRatePct: number;
  profitFactor: number | null;
  parityDelta: number | null;
  avgHoldMinutes: number;
  pnlPct: number;
  winRatePct: number;
}

interface WatchlistEntry {
  mint: string;
  label: string;
}

interface ParsedParams {
  sl: number | null;
  tp: number | null;
  templateParams: Record<string, number>;
}

interface CliArgs {
  file: string;
  minTrades: number;
  minAwr: number;
  minPf: number;
  minParityDelta: number;
  maxHold: number;
  preferredExitMode: 'price' | 'indicator';
}

// ── Patch output types ────────────────────────────────────────────────────────

interface RegimePatch {
  enabled: false;
  templateId: string;
  params: Record<string, number>;
  sl: number;
  tp: number;
  exitMode: 'price' | 'indicator';
}

interface RegimePatchAudit {
  promotionReason: string;
  parityNote: string;
}

interface TokenPatch {
  _label: string;
  _audit: Partial<Record<TrendRegime, RegimePatchAudit>>;
  uptrend?: RegimePatch;
  sideways?: RegimePatch;
  downtrend?: RegimePatch;
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliArgs {
  let file: string | undefined;
  let minTrades = 12;
  let minAwr = 65;
  let minPf = 1.2;
  let minParityDelta = -10;
  let maxHold = 600;
  let preferredExitMode: 'price' | 'indicator' = 'price';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run build-live-map -- --file <ranked-csv>',
        '  --file PATH               Core-ranked CSV from sweep-candidates (required)',
        '  --min-trades N            Min trades (default: 12)',
        '  --min-awr N               Min adjusted win rate % (default: 65)',
        '  --min-pf N                Min profit factor (default: 1.2)',
        '  --min-parity-delta N      Min parityDelta pp (default: -10, null = skip filter)',
        '  --max-hold N              Max avgHoldMinutes (default: 600)',
        '  --preferred-exit-mode     price (default)|indicator — exitMode written into patch entries',
        '                            price: SL/TP only exits (safe default, always works live)',
        '                            indicator: template sell signal + SL/TP fallback',
        '                            Note: use indicator only when ranked CSV used --rank-exit-parity indicator',
      ].join('\n'));
      process.exit(0);
    }
    if (arg === '--file') { file = path.resolve(next); i++; continue; }
    if (arg === '--min-trades') { minTrades = parseInt(next, 10); i++; continue; }
    if (arg === '--min-awr') { minAwr = parseFloat(next); i++; continue; }
    if (arg === '--min-pf') { minPf = parseFloat(next); i++; continue; }
    if (arg === '--min-parity-delta') { minParityDelta = parseFloat(next); i++; continue; }
    if (arg === '--max-hold') { maxHold = parseFloat(next); i++; continue; }
    if (arg === '--preferred-exit-mode') {
      const v = next;
      if (v !== 'price' && v !== 'indicator') throw new Error(`--preferred-exit-mode must be price|indicator, got: ${v}`);
      preferredExitMode = v;
      i++;
      continue;
    }
    if (!arg.startsWith('--') && !file) { file = path.resolve(arg); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!file) throw new Error('--file is required');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);

  return { file, minTrades, minAwr, minPf, minParityDelta, maxHold, preferredExitMode };
}

// ── Exit mode resolution ──────────────────────────────────────────────────────

function resolveExitMode(
  parityDelta: number | null,
  preferred: 'price' | 'indicator',
): 'price' | 'indicator' {
  if (preferred === 'indicator') return 'indicator';
  // 'price' (default): always price, but warn in the caller if parityDelta < 0
  return 'price';
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out.map(v => v.trim());
}

function parseOptional(s: string): number | null {
  if (!s || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseTrendRegime(v: string): TrendRegime {
  if (v === 'uptrend' || v === 'sideways' || v === 'downtrend') return v;
  return 'unknown';
}

function readRankedCsv(filePath: string): RankedRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number | undefined>;

  const required = ['token', 'template', 'params', 'trendRegime', 'trades',
    'adjustedWinRatePct', 'pnlPct', 'avgHoldMinutes'];
  for (const col of required) {
    if (idx[col] === undefined) throw new Error(`Missing required column: ${col}`);
  }

  const rows: RankedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length !== header.length) continue;

    const trades = Number(parts[idx.trades!]);
    const adjustedWinRatePct = Number(parts[idx.adjustedWinRatePct!]);
    const pnlPct = Number(parts[idx.pnlPct!]);
    const avgHoldMinutes = Number(parts[idx.avgHoldMinutes!]);

    if (!Number.isFinite(trades) || !Number.isFinite(adjustedWinRatePct)) continue;

    rows.push({
      token: parts[idx.token!],
      template: parts[idx.template!],
      params: parts[idx.params!],
      trendRegime: parseTrendRegime(parts[idx.trendRegime!] ?? ''),
      trades,
      adjustedWinRatePct,
      winRatePct: parseOptional(parts[idx.winRatePct!] ?? '') ?? adjustedWinRatePct,
      profitFactor: parseOptional(parts[idx.profitFactor!] ?? ''),
      parityDelta: parseOptional(parts[idx.parityDelta!] ?? ''),
      avgHoldMinutes: Number.isFinite(avgHoldMinutes) ? avgHoldMinutes : 9999,
      pnlPct,
    });
  }
  return rows;
}

// ── Params parsing ────────────────────────────────────────────────────────────

function parseParams(paramsStr: string): ParsedParams {
  const all: Record<string, number> = {};
  for (const part of paramsStr.split(' ')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = Number(part.slice(eqIdx + 1).trim());
    if (k && Number.isFinite(v)) all[k] = v;
  }
  const sl = all.sl ?? null;
  const tp = all.tp ?? null;
  const templateParams = { ...all };
  delete templateParams.sl;
  delete templateParams.tp;
  return { sl, tp, templateParams };
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

function loadWatchlist(): Map<string, string> {
  const p = path.resolve(__dirname, '../config/watchlist.json');
  const entries: WatchlistEntry[] = JSON.parse(fs.readFileSync(p, 'utf8'));
  return new Map(entries.map(e => [e.label.toUpperCase(), e.mint]));
}

// ── Promotion logic ───────────────────────────────────────────────────────────

interface PromotionResult {
  promoted: boolean;
  reason: string;
}

function evaluatePromotion(row: RankedRow, args: CliArgs): PromotionResult {
  if (row.trendRegime === 'unknown') {
    return { promoted: false, reason: 'regime=unknown' };
  }
  if (!SUPPORTED_TEMPLATES.has(row.template)) {
    return { promoted: false, reason: `template '${row.template}' not in SUPPORTED_TEMPLATES` };
  }
  if (row.trades < args.minTrades) {
    return { promoted: false, reason: `trades=${row.trades} < ${args.minTrades}` };
  }
  if (row.adjustedWinRatePct < args.minAwr) {
    return { promoted: false, reason: `adjWR=${row.adjustedWinRatePct.toFixed(1)}% < ${args.minAwr}%` };
  }
  if (row.profitFactor !== null && row.profitFactor < args.minPf) {
    return { promoted: false, reason: `PF=${row.profitFactor.toFixed(2)} < ${args.minPf}` };
  }
  if (row.parityDelta !== null && row.parityDelta < args.minParityDelta) {
    return { promoted: false, reason: `parityDelta=${row.parityDelta.toFixed(1)}pp < ${args.minParityDelta}pp` };
  }
  if (row.avgHoldMinutes > args.maxHold) {
    return { promoted: false, reason: `avgHold=${row.avgHoldMinutes.toFixed(0)}min > ${args.maxHold}min` };
  }

  const parts: string[] = [
    `trades=${row.trades}`,
    `adjWR=${row.adjustedWinRatePct.toFixed(1)}%`,
    row.profitFactor !== null ? `PF=${row.profitFactor.toFixed(2)}` : 'PF=n/a',
    row.parityDelta !== null ? `parityDelta=${row.parityDelta >= 0 ? '+' : ''}${row.parityDelta.toFixed(1)}pp` : 'parityDelta=n/a',
    `hold=${row.avgHoldMinutes.toFixed(0)}min`,
    `pnl=${row.pnlPct.toFixed(2)}%`,
  ];
  return { promoted: true, reason: parts.join(' ') };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rows = readRankedCsv(args.file);
  if (rows.length === 0) throw new Error('No valid rows parsed from input CSV');

  const watchlist = loadWatchlist(); // label.toUpperCase() → mint

  console.log(`\nbuild-live-map`);
  console.log(`  Input:     ${args.file}`);
  console.log(`  Rows:      ${rows.length}`);
  console.log(`  Filters:   trades>=${args.minTrades} adjWR>=${args.minAwr}% PF>=${args.minPf} parityDelta>=${args.minParityDelta}pp hold<=${args.maxHold}min`);
  console.log(`  exitMode:  '${args.preferredExitMode}' — pass --preferred-exit-mode indicator to enable template sell signals`);

  // Track best row per (mint, regime) — CSV is pre-ranked, first passing row wins
  const promotedMap = new Map<string, { row: RankedRow; mint: string; reason: string }>();
  const rejections: string[] = [];
  let unsupportedCount = 0;

  for (const row of rows) {
    const mint = watchlist.get(row.token.toUpperCase());
    if (!mint) {
      rejections.push(`SKIPPED (not in watchlist): ${row.token} | ${row.trendRegime} | ${row.template}`);
      continue;
    }
    if (row.trendRegime === 'unknown') {
      rejections.push(`SKIPPED (unknown regime): ${row.token} | ${row.template} | ${row.params}`);
      continue;
    }
    if (!SUPPORTED_TEMPLATES.has(row.template)) {
      rejections.push(`UNSUPPORTED: ${row.token} | ${row.trendRegime} | ${row.template}`);
      unsupportedCount++;
      continue;
    }

    const key = `${mint}||${row.trendRegime}`;
    if (promotedMap.has(key)) continue; // already have a promoted row for this slot

    const { promoted, reason } = evaluatePromotion(row, args);
    if (promoted) {
      promotedMap.set(key, { row, mint, reason });
    } else {
      rejections.push(`REJECTED: ${row.token} | ${row.trendRegime} | ${row.template} | ${reason}`);
    }
  }

  // Print promotion table
  const promoted = [...promotedMap.entries()].map(([key, v]) => {
    const [mint, regime] = key.split('||');
    const pd = v.row.parityDelta;
    return {
      token: v.row.token,
      regime,
      template: v.row.template,
      sl: parseParams(v.row.params).sl ?? 'n/a',
      tp: parseParams(v.row.params).tp ?? 'n/a',
      parityDelta: pd !== null ? `${pd >= 0 ? '+' : ''}${pd.toFixed(1)}pp${pd < 0 ? ' ⚠' : ''}` : 'n/a',
      promotionReason: v.reason,
      _mint: mint,
    };
  });

  if (promoted.length > 0) {
    console.log(`\n=== Promoted (${promoted.length} token/regime slots) ===`);
    console.table(promoted.map(p => ({
      token: p.token,
      regime: p.regime,
      template: p.template,
      sl: p.sl,
      tp: p.tp,
      parityDelta: p.parityDelta,
      reason: p.promotionReason,
    })));
  } else {
    console.log('\n=== Promoted: none ===');
  }

  if (rejections.length > 0) {
    console.log(`\n=== Rejections / Skips (${rejections.length}) ===`);
    for (const r of rejections) console.log(`  ${r}`);
  }

  if (unsupportedCount > 0) {
    console.log(`\nWARNING: ${unsupportedCount} row(s) reference unsupported templates. Update SUPPORTED_TEMPLATES in this script when new templates are added to catalog.ts.`);
  }

  const hasNegativeParity = promoted.some(p => {
    const pd = promotedMap.get(`${p._mint}||${p.regime}`)?.row.parityDelta;
    return pd !== null && pd !== undefined && pd < 0;
  });
  if (hasNegativeParity && args.preferredExitMode === 'price') {
    console.log('\nNOTE: Some promoted rows have parityDelta < 0 (⚠ above). These strategies benefit from');
    console.log('      indicator exits in backtest. Current patch uses exitMode=price (safe default).');
    console.log('      Re-run with --preferred-exit-mode indicator after canary validation to enable template sell signals.');
  }

  // Build patch JSON — group by mint
  const tokenPatches: Record<string, TokenPatch> = {};

  for (const [key, { row, mint, reason }] of promotedMap) {
    const [, regime] = key.split('||');
    const { sl, tp, templateParams } = parseParams(row.params);

    if (sl === null || tp === null) {
      console.warn(`  WARN: Could not parse sl/tp from params for ${row.token}/${regime}: "${row.params}" — skipping from patch`);
      continue;
    }

    if (!tokenPatches[mint]) {
      tokenPatches[mint] = { _label: row.token, _audit: {} };
    }

    const patch = tokenPatches[mint];
    const exitMode = resolveExitMode(row.parityDelta, args.preferredExitMode);
    const parityNote = row.parityDelta !== null && row.parityDelta < 0
      ? `parityDelta=${row.parityDelta.toFixed(1)}pp — indicator exits better in backtest${exitMode === 'price' ? '; pass --preferred-exit-mode indicator to enable' : ''}`
      : '';

    patch._audit[regime as TrendRegime] = { promotionReason: reason, parityNote };
    patch[regime as TrendRegime] = {
      enabled: false,
      templateId: row.template,
      params: templateParams,
      sl,
      tp,
      exitMode,
    };
  }

  const patchOutput = {
    _REVIEW_REQUIRED: 'Do not apply without manual verification. All entries start with enabled: false.',
    _source_file: path.basename(args.file),
    _generated_at: new Date().toISOString(),
    _filters: {
      minTrades: args.minTrades,
      minAwr: args.minAwr,
      minPf: args.minPf,
      minParityDelta: args.minParityDelta,
      maxHoldMinutes: args.maxHold,
    },
    tokens: tokenPatches,
  };

  console.log('\n=== Live-Map Patch (copy regime blocks into config/live-strategy-map.v1.json) ===\n');
  console.log(JSON.stringify(patchOutput, null, 2));
}

try {
  main();
} catch (err) {
  console.error(`build-live-map failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
