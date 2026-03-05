# Strategy Reference (Live + Research)

This file is the strategy source-of-truth for agent handoff and reviews.
It describes what is running live now, how signals are routed, and how to promote updates.

## Scope

- Live execution architecture and active routes
- Exit behavior (including dynamic protection)
- Research and promotion workflow (`sweep`, `candidates`, robustness)
- Operational guardrails for changes

## Canonical Files

- Live map: `config/live-strategy-map.v1.json`
- Route loader/parser: `src/strategy/live-strategy-map.ts`
- Entry routing/arbitration: `src/index.ts`
- Entry gates/scoring: `src/strategy/rules.ts`
- Exit engine: `src/execution/position-manager.ts`
- Backtest sweep engine: `src/backtest/sweep.ts`
- Candidate ranking: `scripts/sweep-candidates.ts`
- Robustness windows: `scripts/sweep-window-robustness.ts`

## Live Architecture

1. Regime selection
- Regime detector classifies each token into `uptrend`, `sideways`, or `downtrend`.
- Live map provides route config per regime.

2. Route selection
- Each enabled route has:
  - `templateId`
  - `params`
  - `timeframeMinutes`
  - `priority`
  - `sl`, `tp`, `exitMode`
  - optional `protection`
- Per cycle, candidate routes are evaluated.
- Arbitration chooses winner by:
  1) `priority` (higher wins)
  2) signal score (higher wins)
  3) shorter timeframe
  4) larger size

3. Position sizing
- Token cap supports:
  - `maxPositionUsdc` (absolute cap)
  - `maxPositionEquityPct` (equity-based cap)
- Portfolio gates also apply:
  - max concurrent positions
  - max open exposure
  - kill switch rules

4. Exit stack (strategy-routed positions)
- Priority order in runtime:
  1) Emergency LP drop exit
  2) Route `protection` exit (if configured)
  3) Template indicator exit (if `exitMode=indicator`)
  4) SL/TP fallback

## Dynamic Protection Model

Configured per route under `protection`.

Fields:
- `profitLockArmPct`: arm lock when peak PnL reaches this value
- `profitLockPct`: if armed and current PnL drops to this value or lower, exit
- `trailArmPct`: arm trailing when peak PnL reaches this value
- `trailGapPct`: trailing stop at `peakPnlPct - trailGapPct`
- `staleMaxHoldMinutes`: if hold time exceeds this threshold, evaluate stale stop
- `staleMinPnlPct`: stale stop threshold (exit if `currentPnlPct <= staleMinPnlPct`)

Notes:
- Protection is optional and route-local.
- If not set, behavior is unchanged.
- Protection is evaluated before template exit and SL/TP.

## Active Live Routes (Current Map)

Only these regime routes are enabled:

| Token | Regime | Route ID | Template | TF | SL / TP | Exit Mode | Size Cap |
|---|---|---|---|---:|---|---|---|
| PIPPIN | sideways | `pippin-5m-crsi-dip-recover-core` | `crsi-dip-recover` | 5m | -5 / +3 | indicator | 25% equity |
| PUMP | uptrend | `pump-5m-rsi-session-uptrend-core` | `rsi-session-gate` | 5m | -5 / +1 | indicator | 15% equity |
| PUMP | sideways | `pump-1m-rsi-sideways-core` | `rsi` | 1m | -5 / +3 | indicator | 15% equity |
| HNT | sideways | `hnt-15m-rsi-crsi-confluence-core` | `rsi-crsi-confluence` | 15m | -2 / +4 | indicator | 20% equity |
| cbBTC | sideways | `cbbtc-15m-rsi-crsi-confluence-core` | `rsi-crsi-confluence` | 15m | -5 / +6 | indicator | 1.5% equity |
| BONK | sideways | `bonk-15m-rsi-core` | `rsi` | 15m | -3 / +4 | indicator | 1.5% equity |
| TRUMP | sideways | `trump-1m-vwap-rsi-range-revert-core` | `vwap-rsi-range-revert` | 1m | -5 / +4 | indicator | 1% equity |
| POPCAT | sideways | `popcat-5m-rsi-probe-primary` | `rsi` | 5m | -3 / +10 | indicator | 20% equity |

Route protection currently enabled on:
- PIPPIN sideways
- PUMP uptrend
- PUMP sideways
- TRUMP sideways (stale stop only)

Disabled:
- SOL all regimes
- All non-listed regimes for other tokens

## Research Workflow

## 1) Run sweep (all major timeframes)

User runs sweep jobs (agents should not launch long full sweeps by default):

```bash
npm run sweep -- --cost empirical --exit-parity both --from 2026-02-18 --timeframe 1
npm run sweep -- --cost empirical --exit-parity both --from 2026-02-18 --timeframe 5
npm run sweep -- --cost empirical --exit-parity both --from 2026-02-18 --timeframe 15
```

For routine iteration, use template subsets instead of the full catalog:

```bash
npm run sweep -- --cost empirical --exit-parity both --from 2026-02-18 --timeframe 1 --template-set core
npm run sweep -- --cost empirical --exit-parity both --from 2026-02-18 --timeframe 5 --template-set core
npm run sweep -- --cost empirical --exit-parity both --from 2026-02-18 --timeframe 15 --template-set trend
```

Available template sets:
- `core`: currently productive mean-reversion / session templates
- `extended`: broader research set without the full catalog cost
- `trend`: trend / breakout continuation templates

For validation or smoke runs, write to a scratch file to avoid overwriting the daily canonical sweep artifact:

```bash
npm run sweep -- --template-set trend --timeframe 15 --from 2026-03-04 --to 2026-03-04 --out-file data/sweep-results/smoke/2026-03-04-trend-15min.csv
```

## 2) Build candidates from explicit files

Always pass explicit `--files` to avoid stale path/source confusion:

```bash
npm run sweep-candidates -- --files "data/sweep-results/YYYY-MM-DD-1min.csv,data/sweep-results/YYYY-MM-DD-5min.csv,data/sweep-results/YYYY-MM-DD-15min.csv" --top 2000 --top-per-token 300 --rank-exit-parity indicator --timeframe-support-min 1 --out-dir data/sweep-results/candidates/union
```

Optional strict MTF consistency:

```bash
npm run sweep-mtf -- --cost empirical --exit-parity both --from 2026-02-18 --timeframes 1,5,15 --top 2000 --top-per-token 300 --rank-exit-parity indicator --require-timeframes --out-dir data/sweep-results/candidates/strict
```

## 3) Robustness windows

```bash
npm run sweep-robustness -- --from 2026-02-18 --window-days 1,2 --step-days 1 --timeframes 1,5,15 --cost empirical --exit-parity both --rank-exit-parity indicator --top 2000 --top-per-token 300 --timeframe-support-min 1
```

If empirical sample is too small in some windows, fallback mode should be used (`fixed`) for those windows.

## Template Health

Use the template health report to decide which strategies deserve compute budget:

```bash
npm run template-health
```

Optional explicit files:

```bash
npm run template-health -- --files "data/sweep-results/YYYY-MM-DD-1min.csv,data/sweep-results/YYYY-MM-DD-5min.csv,data/sweep-results/YYYY-MM-DD-15min.csv"
```

Outputs:
- `data/sweep-results/template-health/YYYY-MM-DD.template-health.csv`
- `data/sweep-results/template-health/YYYY-MM-DD.template-health.md`

## Promotion Criteria (Profit-First)

When ranking routes for live:
- Prefer net profitability and drawdown control over raw win rate.
- Minimum suggested gate:
  - `pnlPct > 0`
  - `profitFactor >= 1.2`
  - `trades >= 12` (or stricter for core)
  - acceptable `maxDrawdownPct` for token risk tier
- Validate live expressibility and exit parity before promotion.

## Change Rules for Agents

1. Do not edit live routes without citing candidate artifacts and date.
2. Do not promote using stale candidate files with mismatched sweep sources.
3. Keep route changes regime-specific.
4. For high-vol routes, include explicit `protection` config.
5. After changes:
- run typecheck/build
- restart bot
- monitor exit reason distribution (`SL`, `TP`, `template-indicator-exit`, `Profit lock`, `Trailing protect`, `Stale stop`)

## Known Current Risk

- A high win rate can still lose money if large-size routes carry asymmetric loss (`SL`) versus small gains.
- Route-level protection is now available and should be part of promotion policy for volatile tokens.
