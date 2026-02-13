# Trade Capture Debug Summary (POPCAT watchlist)

## Goal
Get CRSI scalper working on a single POPCAT pair by ensuring trade capture works and CRSI has data.

## Current Symptoms
- Dashboard metrics stay empty (no trades, no entries).
- `tradeSubscriptions` sometimes goes to `0` and `pendingCandidates` goes to `0`.
- Swap logs are detected, but **no trades are enriched/recorded**.

## Environment
- VPS: Hetzner (NBG1)
- Bot mode: `UNIVERSE_MODE=watchlist`
- Watchlist:
  - Mint: `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr` (POPCAT)
  - Pool: `HBS7a3br8GMMWuqVa7VB3SMFa7xVi1tSFdoF5w4ZZ3kS` (Raydium)
- Paper mode: `PAPER_TRADING=true`
- Exits: hard stop `-0.25%`, TP `+0.5%`, 100% sell, TP2 disabled.

## What We Fixed / Changed
1) **Jupiter endpoint errors (401)**  
   - `api.jup.ag` requires API key now.  
   - Switched to `https://lite-api.jup.ag` and Price V3 + Swap V1 endpoints.  
   - Curl tests to `lite-api.jup.ag` work.

2) **Watchlist token was aging out**  
   - Watchlist tokens were pruned by token age.  
   - Fixed: watchlist tokens skip age checks and pruning.

3) **Trade subscription on pool address**  
   - Old logic subscribed to mint address, which doesn’t emit swap logs.  
   - Updated to allow watchlist entries with `{ mint, pool }` and subscribe to the pool address.

4) **Debugging trade enrichment**  
   - Added logs for swap detection, enrichment start, and null reasons.
   - Made “Enriched trade recorded” log at INFO level.

## Evidence From Logs
- Swap logs are detected:
  - `Swap log detected` for POPCAT pool signature.
- But no trade is recorded:
  - No `Enriched trade recorded` messages in the last 5–10 minutes.
- Earlier logs showed:
  - `Token delta is zero for signer` (old logic).

## What This Means
