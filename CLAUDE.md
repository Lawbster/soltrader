# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the bot (live)
npm start

# Run in paper trading mode (no real swaps)
npm run paper

# Type-check only (no build artefacts)
npx tsc --noEmit

# Run tests
npm test

# Run a single test file
npx vitest run test/safety.test.ts

# Backtest a specific template + token + timeframe
npm run sweep -- crsi POPCAT 5
npm run sweep -- --timeframe 15 --cost empirical --from 2026-02-18

# Rank sweep results into candidates
npm run sweep-candidates -- --file data/sweep-results/2026-02-28-1min.csv --top 300 --top-per-token 75

# Multi-timeframe sweep (1m + 5m + 15m combined)
npm run sweep-mtf -- --cost empirical --from 2026-02-18

# Build live strategy map from ranked candidates
npm run build-live-map -- --file data/sweep-results/candidates/2026-02-28-1min.core-ranked.csv --preferred-exit-mode indicator

# Emergency close all positions (stop bot first)
npx tsx scripts/close-all-positions.ts --confirm

# Sync data from VPS (run from sol-trader/)
rsync -av deploy@46.225.80.0:/opt/sol-trader/data/ ./data/
```

## Architecture

### Live bot flow

`src/index.ts` is the main loop. It:
1. Monitors new token launches via Helius WebSocket + Pump.fun / Raydium program subscriptions
2. Maintains a watchlist of 8 fixed tokens (`config/watchlist.json`) that are always tracked
3. Every ~60s, calls `evaluateEntry()` per token per route
4. Routes that pass all gates call `openPosition()` → Jupiter swap
5. Every 15s, `updatePositions()` evaluates exits for open positions

### Multi-route / multi-timeframe entry

Each token in `config/live-strategy-map.v1.json` can have multiple routes per regime (uptrend/sideways/downtrend). Each route has a `timeframeMinutes` field. `shouldEvaluateRouteNow()` in `index.ts` ensures each route only fires once per candle boundary (e.g. a 5m route fires at 10:00, 10:05, 10:10…). When multiple routes pass, they are sorted by `priority` and the winner executes.

### Strategy template system

`src/strategy/templates/catalog.ts` is the single source of truth for all signal logic. Templates return `'buy' | 'sell' | 'hold'`. The same catalog is used by:
- **Live engine**: `src/strategy/rules.ts` → `evaluateEntry()`
- **Backtest sweep**: `src/backtest/sweep.ts` via a `StrategyContext → LiveTemplateContext` adapter

Adding a new template requires: adding the evaluator, metadata (`requiredHistory`, `requiredIndicators`), and required params to the catalog — nowhere else.

### Regime-aware routing

`src/strategy/regime-detector.ts` classifies each token as `uptrend | sideways | downtrend` using weighted 24/48/72h returns from on-disk candle CSVs. Background refresh every 10 min, 2-cycle hysteresis to confirm flips. Zero RPCs — disk reads only. Regime is stamped at entry time into `StrategyPlan`; open positions are not affected by regime changes.

### Exit modes

`exitMode: 'indicator' | 'price'` on each route controls whether exits use template sell signals or pure SL/TP from `StrategyPlan`. Positions with a `strategyPlan` always do 100% exit on SL/TP hit. Legacy positions (no `strategyPlan`) fall through to `evaluateExit()` (multi-lot).

### Config hot-reload

`config/strategy.v1.json` is hot-reloaded on every read — no restart needed for parameter changes. `config/live-strategy-map.v1.json` uses mtime-based hot-reload (checked every analysis cycle).

### Data paths

| Location | Path |
|---|---|
| VPS positions | `/opt/sol-trader/data/positions-YYYY-MM-DD.json` |
| VPS candles | `/opt/sol-trader/data/candles/{mint}/{YYYY-MM-DD}.csv` |
| Local (flat, matches VPS) | `sol-trader/data/` |
| Sweep results | `data/sweep-results/` |

`DATA_ROOT` in `src/backtest/data-loader.ts` resolves to `../../data` (not `../../data/data`).

### Key env vars

| Var | Default | Notes |
|---|---|---|
| `PAPER_TRADING` | `'true'` | Must be `false` for live swaps |
| `HELIUS_API_KEY` | required | RPC + WebSocket |
| `WALLET_PRIVATE_KEY` | required (live only) | Base58 keypair |
| `SHADOW_TEMPLATE` | unset | Set to `'1'` to log but suppress all entries |

### Sweep → live map workflow

1. `npm run sweep -- --cost empirical --from DATE` → writes CSV to `data/sweep-results/`
2. `npm run sweep-candidates -- --file ... --top 300 --top-per-token 75` → ranked CSVs
3. `npm run build-live-map -- --file ...core-ranked.csv --preferred-exit-mode indicator` → patches `config/live-strategy-map.v1.json`

### VPS deployment

```bash
git pull && sudo systemctl restart sol-trader
```

`tsx` is **not** globally installed on VPS — use `npx tsx` for any script invocations.
