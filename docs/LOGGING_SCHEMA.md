# Data Logging Implementation Order

This is the execution checklist for Claude. Keep it minimal, deterministic, and production-safe.

## Goal
Collect a clean 1-week dataset for CRSI strategy analysis with daily and weekly exports.

## Guiding Rules
- Raw price points are the source of truth.
- Do not fake full OHLCV from sparse polls.
- Keep writes append-only and daily-partitioned.
- Persist and reload price history so CRSI survives restarts.

## Phase 1: Raw Price Points (Must Have First)
1. Write JSONL price points per token:
   - Path: `data/prices/<mint>/YYYY-MM-DD.jsonl`
   - Fields: `ts`, `mint`, `priceUsd`, `priceSol`, `source`, `pollLatencyMs`
2. Hook into existing 30s price poll loop.
3. Ensure file rotation by UTC date.

Acceptance:
- Files are created for active watchlist tokens.
- File size grows every 30s per token.

## Phase 2: Signal Decision Snapshots
1. Write JSONL on every strategy evaluation:
   - Path: `data/signals/YYYY-MM-DD.jsonl`
   - Fields: `ts`, `mint`, `crsi`, `rsi`, `source`, `candleCount`, `entryDecision`, `rejectReason`, `quotedImpactPct`, `liquidityUsd`, `effectiveMaxSol`
2. Log both pass and reject decisions.

Acceptance:
- Every analysis cycle produces one line per evaluated token.

## Phase 3: Execution Events
1. Write JSONL for buy/sell attempts and outcomes:
   - Path: `data/executions/YYYY-MM-DD.jsonl`
   - Fields: `ts`, `mint`, `side`, `sizeSol`, `slippageBps`, `quotedImpactPct`, `result`, `error`, `latencyMs`
2. Include both success and failure.

Acceptance:
- Every open/close attempt is recorded once.

## Phase 4: Derived Candles (Honest Version)
1. Build 1-minute candles from raw price points:
   - Path: `data/candles/<mint>/YYYY-MM-DD.csv`
   - Columns: `timestamp,open,high,low,close,pricePoints`
2. Do not include `volume` until a real volume source is added.

Acceptance:
- Candle rows match minute boundaries and derive only from stored price points.

## Phase 5: Persistence Across Restart
1. Persist in-memory price history at interval and on shutdown.
2. Reload recent history on startup (last 150 min window).

Acceptance:
- CRSI readiness does not reset to zero after restart.

## Phase 6: Exports
1. Daily pull (VPS -> local) for `prices`, `signals`, `executions`, `candles`.
2. Weekly archive on VPS:
   - `tar -czf data/archive-YYYY-WW.tar.gz prices signals executions candles summaries`
3. Pull weekly archive to local.

Acceptance:
- Daily files sync cleanly.
- Weekly archive is reproducible and complete.

## Rollout Plan
1. Start with 3 tokens: `POPCAT`, `BONK`, `TRUMP`.
2. Run 48 hours and verify data integrity.
3. Expand to full 9-token watchlist.

## Out of Scope (for now)
- True traded volume in candles.
- External data providers for OHLCV.
- Backtest engine changes.
