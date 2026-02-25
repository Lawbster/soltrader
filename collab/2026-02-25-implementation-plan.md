# Sol-Trader Implementation Plan (2026-02-25)

## Scope
Expand strategy coverage, improve backtest/live parity, and preserve regime-aware routing while controlling operational risk.

## Non-Negotiable Ops Rule (Emil-Owned Sweep Runs)

- `npm run sweep` is **user-owned only** (Emil runs all sweeps).
- Agents must **not** run `npm run sweep` due runtime/cost/time constraints.
- Agents are allowed to run `npm run sweep-candidates` and all read-only analysis over produced CSV outputs.
- If a new sweep is needed, agent must pause and request:

```bash
npm run sweep -- --cost empirical --from 2026-02-18
```

Then continue only after Emil confirms completion and provides/keeps the output in:
`data/data/sweep-results/YYYY-MM-DD-1min.csv`.

## Current Verified State

- Active templates in `src/backtest/sweep.ts`:
  `rsi`, `crsi`, `bb-rsi`, `rsi-crsi-confluence`, `crsi-dip-recover`, `trend-pullback-rsi`, `vwap-rsi-reclaim`, `bb-rsi-crsi-reversal`.
- Live per-token exits in `src/execution/position-manager.ts` are SL/TP-based only.
- Entry gate in `src/strategy/rules.ts` currently uses RSI/CRSI thresholds; no ADX gate in live path.
- `strategyPlan.exit` is currently reference-only metadata.

## Phase 1 - Expand Strategy Templates (Do Not Reduce)

Add the following templates to `src/backtest/sweep.ts`:

1. `rsi-crsi-midpoint-exit`
- Entry: `rsi < entryRsi && connorsRsi < entryCrsi`
- Exit: `rsi > 50`
- Grid: `entryRsi[20,25,30] entryCrsi[10,15,20] sl[-2,-3,-5]`

2. `adx-range-rsi-bb`
- Entry: low ADX + lower-band touch + RSI oversold
- Exit: RSI mean-revert or BB middle reclaim

3. `adx-trend-rsi-pullback`
- Entry: `adx` trend filter + `ema12 > ema26` + `close > sma50` + RSI pullback
- Exit: trend break or RSI exit

4. `macd-zero-rsi-confirm`
- Entry: MACD histogram crosses above 0 + RSI confirmation
- Exit: reverse MACD momentum or RSI weakness

5. `macd-signal-obv-confirm`
- Entry: MACD signal cross up with OBV rising
- Exit: MACD cross down or OBV deterioration

6. `bb-squeeze-breakout`
- Entry: low BB width followed by expansion breakout
- Exit: loss of follow-through / mid-band loss

7. `vwap-trend-pullback`
- Entry: VWAP reclaim with RSI pullback
- Exit: VWAP loss or RSI exit

8. `vwap-rsi-range-revert`
- Entry: low-ADX range, below-VWAP deviation, RSI oversold
- Exit: mean reversion to VWAP

9. `connors-sma50-pullback`
- Entry: `close > sma50 && connorsRsi < entry`
- Exit: CRSI reset or structure break

10. `rsi2-micro-range`
- Entry: RSI2 extremes in low-ADX chop
- Exit: RSI2 normalization

11. `atr-breakout-follow`
- Entry: breakout + ATR expansion + ADX trend confirmation
- Exit: trend decay

## Phase 2 - Backtest/Live Exit Parity Mode (High Priority)

Problem: sweep templates can exit on indicator conditions, live per-token exits currently use SL/TP only.

Implement in `src/backtest/sweep.ts`:
- New flag: `--exit-parity indicator|price|both`
- Add CSV column: `exitParity`
- `price` mode: suppress strategy sell signals while position open; keep SL/TP active
- `both` mode: run both variants for each param set

Purpose:
- Quantify bias from indicator exits
- Prevent over-promoting templates that only look strong under indicator-exit assumptions

## Phase 3 - ADX Gate Path (Test-First)

1. Backtest first:
- Add ADX-gated variants to RSI/CRSI families
- Validate improvement across at least 2 tokens with meaningful trade count

2. Only then live:
- Extend live indicator snapshot to include ADX
- Add optional `entry.adxGate` config
- Apply in `evaluateEntry()` as a hard skip when `adx > adxGate`

## Phase 4 - Candidate Ranking Hardening

In `scripts/sweep-candidates.ts`:
- Keep `coreMinProfitFactor = 1.2`
- Add stricter promotion profile (recommended defaults):
  - Core: `trades >= 12`, `PF >= 1.2`, `pnlPct > 0`, positive alpha blend
  - Probe: `trades 4-11`
- Fix help text mismatch for `--core-min-pf` (currently says 1.1 while code uses 1.2)

## Phase 5 - Operating Workflow (User + Agent Handoff)

1. Emil runs sweep (user-owned):
```bash
npm run sweep -- --cost empirical --from 2026-02-18
```

2. Agent runs candidate extraction and analysis:
```bash
npm run sweep-candidates -- --file data/data/sweep-results/YYYY-MM-DD-1min.csv --top 300 --top-per-token 75
```

3. Agent returns:
- core/probe picks per regime
- rejected sets and reasons
- map update recommendations for `config/live-strategy-map.v1.json`

## Acceptance Criteria

- Strategy breadth increased by 8-11 new templates.
- Candidate set is less single-token concentrated than baseline.
- Exit parity report produced (indicator vs price-only) for top templates.
- Live-map updates are regime-specific and only for statistically defensible rows.
