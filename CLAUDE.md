# CLAUDE.md

This file is the compact repo handoff for agent work.
For the full runtime and research model, start with `strategy.md`.

## Core Commands

```bash
npm start
npm run paper
npx tsc --noEmit
npm test
```

## Research Commands

```bash
npm run sweep -- --cost empirical --from 2026-02-18 --exit-parity both
npm run sweep -- --timeframe 5 --cost empirical --from 2026-02-18 --exit-parity both
npm run sweep -- --timeframe 15 --cost empirical --from 2026-02-18 --exit-parity both

npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-1min.csv --top 2000 --top-per-token 300
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-5min.csv --top 2000 --top-per-token 300
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-15min.csv --top 2000 --top-per-token 300

npm run sweep-robustness -- --from 2026-02-18 --window-days 1,2 --step-days 1 --timeframes 1,5,15 --cost empirical --exit-parity both --rank-exit-parity indicator --top 2000 --top-per-token 300
npm run robustness-report
```

## Runtime Architecture

- Main loop: `src/index.ts`
- Live routes: `config/live-strategy-map.v1.json`
- Route normalization: `src/strategy/live-strategy-map.ts`
- Entry logic: `src/strategy/rules.ts`
- Exit engine: `src/execution/position-manager.ts`
- Templates: `src/strategy/templates/catalog.ts`
- Regime logic: `src/strategy/regime-core.ts`, `src/strategy/regime-detector.ts`

## Key Runtime Rules

- Live routing is regime-specific.
- Multiple positions per mint are supported.
- Only one open position per `routeId` on a mint is allowed.
- Entry signals are evaluated on fully closed candles.
- Higher-timeframe routes execute using their closed signal candle plus the route arbitration layer.
- Route protection is evaluated before indicator exits and SL/TP.
- ATR exits use ATR captured at entry.

## Current Live Routes

As of this rewrite, active routes are:
- `PIPPIN` uptrend: `5m connors-sma50-pullback`
- `PIPPIN` sideways: `1m vwap-rsi-range-revert`
- `PIPPIN` downtrend: `15m rsi2-micro-range`
- `PUMP` downtrend: `5m rsi-session-gate`
- `POPCAT` downtrend: `15m rsi-atr-protect`

Check `config/live-strategy-map.v1.json` for the exact current state.

## Data Layout

Runtime data root is `data/`.
Important paths:
- candles: `data/candles/{mint}/{YYYY-MM-DD}.csv`
- signals: `data/signals/{YYYY-MM-DD}.jsonl`
- executions: `data/executions/{YYYY-MM-DD}.jsonl`
- swap trade logs: `data/data/trades/{YYYY-MM-DD}.jsonl`
- metrics: `data/metrics.json`
- positions: `data/positions-{YYYY-MM-DD}.json`
- sweep results: `data/sweep-results/`

## Operational Notes

- `tsx` is used locally and on the VPS through `npm` scripts.
- Use `SHADOW_TEMPLATE=1` to suppress entries while keeping signal logs.
- Validate with `npx tsc --noEmit` and `npm test` before shipping.
- Use `strategy.md`, `docs/OPS.md`, and `docs/RESEARCH.md` for deeper detail.
