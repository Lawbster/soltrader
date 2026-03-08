# Sol-Trader System Reference

This file is the current source of truth for how the live bot, data model, and research loop work.
Canonical config and code always win over this document when they differ.

## Canonical Files

- Live routes: `config/live-strategy-map.v1.json`
- Global config: `config/strategy.v1.json`
- Main runtime: `src/index.ts`
- Entry rules: `src/strategy/rules.ts`
- Live route normalization: `src/strategy/live-strategy-map.ts`
- Regime logic: `src/strategy/regime-core.ts`, `src/strategy/regime-detector.ts`
- Execution engine: `src/execution/position-manager.ts`
- Template catalog: `src/strategy/templates/catalog.ts`
- Backtest sweep engine: `src/backtest/sweep.ts`
- Candidate ranking: `scripts/sweep-candidates.ts`
- Robustness engine: `scripts/sweep-window-robustness.ts`

## Runtime Model

### Universe

The bot can monitor both launch candidates and a fixed watchlist, but the current production setup is watchlist-led.
Watchlist tokens are loaded from `config/watchlist.json` and continuously tracked.

### Data Inputs

The runtime uses three live data layers:

1. `price-feed`
- Rolling price polls cached in memory.
- Persisted to `data/prices/{mint}/{YYYY-MM-DD}.jsonl`.
- Exported to 1 minute candles in `data/candles/{mint}/{YYYY-MM-DD}.csv`.

2. `trade-tracker`
- Optional log-based trade enrichment from chain events.
- Used for short-window flow metrics and as the preferred OHLC source when available.
- Quote notionals are normalized to USD before they are used in filters or scoring.

3. `regime candles`
- Regime detection reads persisted candle CSVs from disk.
- No RPC dependency once candles exist locally.

### Regime Routing

Every token is assigned a live regime:
- `uptrend`
- `sideways`
- `downtrend`

The detector:
- reads candle CSVs from disk
- computes trailing 24h / 48h / 72h returns
- combines them with weighted scoring
- applies 2-cycle hysteresis before confirming a flip
- refreshes every 10 minutes

Date handling is UTC-based so candle-file lookup and regime refresh use the same calendar as stored data.

### Route Selection

Each token can define one or more routes per regime.
Each route carries:
- `templateId`
- `params`
- `timeframeMinutes`
- `priority`
- `exitMode`
- either `%` stops or `ATR` stops
- optional `protection`
- token-specific size caps

At runtime:
1. only routes for the token's confirmed regime are considered
2. each route is evaluated only once per closed candle boundary for its timeframe
3. passing routes are arbitrated by:
- higher `priority`
- higher score
- shorter timeframe
- larger size

### Position Model

The bot now supports multiple open positions per mint.
The restriction is:
- at most one open position per `routeId` on a mint at a time

This means:
- a `1m` and `15m` route on the same token can coexist
- the exact same route cannot stack duplicate entries every candle

### Exit Stack

For route-driven positions, the live exit order is:

1. emergency LP exit
2. route protection exit
3. template indicator exit when `exitMode=indicator`
4. hard stop / take profit

Protection supports:
- profit lock
- trailing protection
- stale-time exits

ATR exits are supported live and use ATR captured at entry.
They do not drift after the trade is opened.

## Live / Backtest Parity

The project now aligns live and backtest materially better than the original build.

### What is aligned

- shared template catalog for signal logic
- dynamic regime-aware routing
- protection exits, including profit lock
- ATR stop / take-profit exits
- closed-candle signal evaluation
- backtest entries on next 1 minute execution bar after the signal candle closes
- higher-timeframe strategies using 1 minute execution bars underneath

### What is still approximate

- live uses real polling cadence and real execution failures
- backtest uses bar-based execution, not mempool-level fills
- quote failures, RPC outages, and other live infra issues are not fully modeled

Backtest is now useful for strategy selection.
It is still not a perfect simulator of live microstructure.

## Current Live Routes

<!-- LIVE_ROUTES:START -->
Generated from `config/live-strategy-map.v1.json` by `npm run refresh-live-routes-doc`.

| Token | Regime | Route | Template | TF | Exit | Stops | Max Size |
|---|---|---|---|---:|---|---|---|
| PIPPIN | uptrend | `pippin-5m-connors-up-core` | `connors-sma50-pullback` | 5m | price | `SL -5 / TP 4` | 25% equity |
| PIPPIN | sideways | `pippin-1m-vwap-rsi-side-core` | `vwap-rsi-range-revert` | 1m | price | `SL -2 / TP 2` | 25% equity |
| PIPPIN | downtrend | `pippin-15m-rsi2-down-core` | `rsi2-micro-range` | 15m | price | `SL -2 / TP 3` | 25% equity |
| POPCAT | downtrend | `popcat-15m-rsi-atr-down-probe` | `rsi-atr-protect` | 15m | indicator | `SL 1.25 ATR / TP 3 ATR` | 8% equity |
| PUMP | downtrend | `pump-5m-rsi-session-down-core` | `rsi-session-gate` | 5m | indicator | `SL -3 / TP 1` | 15% equity |

Disabled at the moment:
- BONK
- cbBTC
- HNT
- SOL
- TRUMP
- all non-listed regimes
<!-- LIVE_ROUTES:END -->

## Data Layout

The runtime data root is `data/`.

Important paths:
- price history snapshot: `data/price-history-snapshot.json`
- candles: `data/candles/{mint}/{YYYY-MM-DD}.csv`
- prices: `data/prices/{mint}/{YYYY-MM-DD}.jsonl`
- signals: `data/signals/{YYYY-MM-DD}.jsonl`
- executions: `data/executions/{YYYY-MM-DD}.jsonl`
- swap trade logs: `data/data/trades/{YYYY-MM-DD}.jsonl`
- metrics: `data/metrics.json`
- position history: `data/positions-{YYYY-MM-DD}.json`
- sweep output: `data/sweep-results/`

The historical `data/data/...` trade-log path is still used for compatibility.
The rest of the runtime uses the flat `data/` root.

## Research Workflow

1. run raw sweeps for 1m / 5m / 15m
2. rank candidates from explicit files
3. run robustness on rolling windows
4. use raw sweep + robustness together to promote routes
5. patch `config/live-strategy-map.v1.json`
6. deploy, observe, and rerun after new data accumulates

Use profit-first evaluation.
Win rate is secondary to:
- net pnl
- expectancy
- drawdown behavior
- robustness across windows
- live expressibility

## Validation Standard

Before promoting code or route changes:

1. `npx tsc --noEmit`
2. `npm test`
3. review current live map and route diff
4. if changing strategy logic, rerun fresh sweep / candidates / robustness

## Current Known Constraints

- backtest is still bar-based, not tick-based
- trade enrichment depends on parsed transaction availability
- some quote mints may not have immediate cached USD price during enrichment, in which case the trade is skipped from trade-window metrics
- the swap trade-log path is legacy and can be cleaned later if you want a full migration
