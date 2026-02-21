/**
 * Cost model loader for backtest engine.
 *
 * Two modes:
 *   fixed    — legacy (0.3% commission + 0.1% slippage) × 2 = 0.8% round-trip
 *   empirical — median(quotedImpactPct) from live execution logs + fixed commission
 *
 * Empirical guard: requires ≥30 successful executions. If not met, throws with
 * a clear message so the caller can fall back to fixed mode explicitly.
 */

import fs from 'fs';
import path from 'path';
import { CostConfig } from './types';

const DATA_ROOT = path.resolve(__dirname, '../../data/data');
const EXECUTIONS_DIR = path.join(DATA_ROOT, 'executions');
const MIN_EMPIRICAL_TRADES = 30;
const COMMISSION_PER_SIDE_PCT = 0.25; // Jupiter protocol fee (actual base fee for liquid pools)

export function fixedCost(commissionPct = 0.3, slippagePct = 0.1): CostConfig {
  return {
    model: 'fixed',
    roundTripPct: (commissionPct + slippagePct) * 2,
  };
}

export function loadEmpiricalCost(fromDate?: string, toDate?: string): CostConfig {
  if (!fs.existsSync(EXECUTIONS_DIR)) {
    throw new Error(
      `Executions directory not found: ${EXECUTIONS_DIR}. Cannot use empirical cost model.`
    );
  }

  const files = fs.readdirSync(EXECUTIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .filter(f => {
      const date = f.replace('.jsonl', '');
      if (fromDate && date < fromDate) return false;
      if (toDate && date > toDate) return false;
      return true;
    })
    .sort();

  if (files.length === 0) {
    throw new Error(
      `No execution log files found${fromDate || toDate ? ' for the specified date range' : ''}. ` +
      `Cannot use empirical cost model.`
    );
  }

  const impacts: number[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(EXECUTIONS_DIR, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.result !== 'success') continue;
        const impact = Number(row.quotedImpactPct);
        if (Number.isFinite(impact) && impact >= 0) impacts.push(impact);
      } catch { /* skip malformed lines */ }
    }
  }

  if (impacts.length < MIN_EMPIRICAL_TRADES) {
    throw new Error(
      `Empirical cost model requires ≥${MIN_EMPIRICAL_TRADES} successful executions. ` +
      `Found: ${impacts.length}. Use --cost fixed or run the live bot longer to collect more data.`
    );
  }

  const sorted = [...impacts].sort((a, b) => a - b);
  const medianImpact = sorted[Math.floor(sorted.length / 2)];

  const roundTripPct = (COMMISSION_PER_SIDE_PCT + medianImpact) * 2;

  return { model: 'empirical', roundTripPct, sampleSize: impacts.length };
}
