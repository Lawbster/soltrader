# Debug — Trade Capture & CRSI

## Current Symptoms
- Swap logs are detected for the pool, but trades are not being enriched/recorded.
- Metrics stay empty; CRSI can still run from price‑feed fallback.

## Environment
- Watchlist: POPCAT mint + Raydium pool
- `UNIVERSE_MODE=watchlist`
- Paper mode enabled

## Recent Changes (Claude)
- Added `price-feed.ts` to store rolling Jupiter prices.
- `indicators.ts` now falls back to price‑feed if trade candles are insufficient.
- `token-data.ts` exports `fetchTokenPrice()` for price polling.
- `index.ts` polls price every 30s and records history.

## Evidence
- Logs show `Swap log detected`.
- No `Enriched trade recorded`.

## Next Actions
1. Verify enrichment path for Raydium pool logs.
2. If enrichment fails, parse Raydium swaps directly or accept price‑feed‑only signals.
